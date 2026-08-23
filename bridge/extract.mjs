import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sharp from 'sharp';
import { post, postRequired } from './http.mjs';
import { VALID_TYPES, MAX_POST_BYTES, DDB_ITEM_LIMIT, BRIDGE_HOME } from './config.mjs';

// Track sync position: sessionId → line number (the watcher's per-session read watermark).
export const synced = new Map();

// Persist `synced` to disk so a restart resumes each session's watermark instead of
// reading from line 0 (which re-pushes whole histories). Runtime keeps the Map hot; we
// only flush on exit + a low-frequency interval (crash fallback), never per-set.
const SYNCED_PATH = path.join(BRIDGE_HOME, 'synced.json');
export function decodeSyncedState(value) {
  const version = value?.version;
  const source = version === 2 && value?.watermarks && typeof value.watermarks === 'object'
    ? value.watermarks
    : value;
  const result = new Map();
  if (!source || typeof source !== 'object') return result;
  for (const [key, raw] of Object.entries(source)) {
    if (typeof raw !== 'number') continue;
    // Replay one legacy Claude line to avoid the old trailing-newline offset.
    const line = version === 2 || key.startsWith('codex:') ? raw : Math.max(0, raw - 1);
    result.set(key, line);
  }
  return result;
}

export function loadSynced() {
  try {
    const restored = decodeSyncedState(JSON.parse(fs.readFileSync(SYNCED_PATH, 'utf-8')));
    for (const [key, line] of restored) synced.set(key, line);
    console.log(`[synced] restored ${synced.size} session watermarks`);
  } catch {} // missing/corrupt → start empty (handleHeadlessSend baselines on demand)
}
export function saveSynced() {
  try {
    fs.writeFileSync(SYNCED_PATH, JSON.stringify({
      version: 2,
      watermarks: Object.fromEntries(synced),
    }));
  } catch {}
}
// jsonl line count matching the watcher's convention (drop a single trailing empty line).
export function countJsonlLines(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

const TRUNC_MARK = '\n…[truncated]';
const MIDDLE_TRUNC_MARK = '\n…[truncated]…\n';
const TOOL_INPUT_MAX_CHARS = 2000;
const TOOL_INPUT_HEAD_CHARS = 1000;
const TOOL_INPUT_TAIL_CHARS = 1000;
const TOOL_OUTPUT_MAX_CHARS = 4000;
const TOOL_OUTPUT_HEAD_CHARS = 1500;
const TOOL_OUTPUT_TAIL_CHARS = 2500;

// Fixed timestamp for uuid/timestamp-less metadata rows — keeps their DDB sk deterministic.
const META_EPOCH_TS = '1970-01-01T00:00:00.000Z';

// Walk a message and collect every string field, with a setter to replace it.
// Used to shrink oversized messages by trimming the longest strings first
// (tool results, large text/diff blocks) while keeping JSON structure intact.
function collectStrings(node, out) {
  if (typeof node !== 'object' || node === null) return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === 'string') {
      out.push({ get: () => node[k], set: (s) => { node[k] = s; } });
    } else if (typeof v === 'object' && v !== null) {
      collectStrings(v, out);
    }
  }
}

function truncateMiddle(text, maxChars, headChars, tailChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return text.slice(0, headChars)
    + MIDDLE_TRUNC_MARK
    + text.slice(-tailChars);
}

function truncateNestedStrings(node, maxChars, headChars, tailChars) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === 'string') {
      node[key] = truncateMiddle(value, maxChars, headChars, tailChars);
    } else if (value && typeof value === 'object') {
      truncateNestedStrings(value, maxChars, headChars, tailChars);
    }
  }
}

function truncateToolIo(message) {
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type === 'tool_use' && block.input && typeof block.input === 'object') {
      truncateNestedStrings(
        block.input,
        TOOL_INPUT_MAX_CHARS,
        TOOL_INPUT_HEAD_CHARS,
        TOOL_INPUT_TAIL_CHARS,
      );
    } else if (block?.type === 'tool_result') {
      if (typeof block.content === 'string') {
        block.content = truncateMiddle(
          block.content,
          TOOL_OUTPUT_MAX_CHARS,
          TOOL_OUTPUT_HEAD_CHARS,
          TOOL_OUTPUT_TAIL_CHARS,
        );
      } else if (block.content && typeof block.content === 'object') {
        truncateNestedStrings(
          block.content,
          TOOL_OUTPUT_MAX_CHARS,
          TOOL_OUTPUT_HEAD_CHARS,
          TOOL_OUTPUT_TAIL_CHARS,
        );
      }
    }
  }
  if (message?.toolUseResult && typeof message.toolUseResult === 'object') {
    truncateNestedStrings(
      message.toolUseResult,
      TOOL_OUTPUT_MAX_CHARS,
      TOOL_OUTPUT_HEAD_CHARS,
      TOOL_OUTPUT_TAIL_CHARS,
    );
  }
}

// Return a structural clone of `msg` whose JSON byte size is <= maxBytes,
// prioritizing readable tool IN/OUT previews before trimming the longest
// remaining strings until the whole message fits.
export function truncateToBytes(msg, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(msg)) <= maxBytes) return msg;
  const clone = JSON.parse(JSON.stringify(msg));
  truncateToolIo(clone);
  if (Buffer.byteLength(JSON.stringify(clone)) <= maxBytes) return clone;
  const fields = [];
  collectStrings(clone, fields);
  // Trim longest-first; loop until it fits or no further reduction is possible.
  // Guard scales with field count: a message with many large strings may need
  // one pass per field to collapse them all.
  const maxIters = fields.length + 16;
  for (let guard = 0; guard < maxIters; guard++) {
    const over = Buffer.byteLength(JSON.stringify(clone)) - maxBytes;
    if (over <= 0) break;
    fields.sort((a, b) => b.get().length - a.get().length);
    const target = fields[0];
    const cur = target.get();
    if (!cur || cur.length <= TRUNC_MARK.length) break; // nothing left to trim
    // `over` is in bytes; convert to a char count using this string's own
    // bytes-per-char density so multibyte (CJK/emoji) text isn't over-trimmed.
    const bpc = Buffer.byteLength(cur) / cur.length;
    const dropChars = Math.ceil(over / bpc) + TRUNC_MARK.length + 16;
    const keep = Math.max(0, cur.length - dropChars);
    target.set(cur.slice(0, keep) + TRUNC_MARK);
  }
  return clone;
}

async function processImage(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const compressed = await sharp(buffer)
    .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const hashInput = Buffer.concat([compressed.subarray(0, 8192), Buffer.from(String(compressed.length))]);
  const hash = crypto.createHash('md5').update(hashInput).digest('hex');
  const key = `${hash}.jpg`;

  await post('/api/bridge/upload-image', { key, data: compressed.toString('base64') });
  return key;
}

// Drop image base64 from a tool_result block's nested content (app renders via S3 key).
function stripToolResultBase64(block) {
  if (!Array.isArray(block.content)) return block;
  const content = block.content.map((c) =>
    c.type === 'image' && c.source?.data ? { ...c, source: { ...c.source, data: '' } } : c);
  return { ...block, content };
}

// Drop the big base64 payload from a toolUseResult (image/file), keep metadata.
function stripToolUseResultBase64(tur) {
  if (tur && tur.file && tur.file.base64) {
    return { ...tur, file: { ...tur.file, base64: '' } };
  }
  return tur;
}

export async function extractForApp(msg) {
  if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') {
    const content = msg.aiTitle || msg.customTitle || msg.lastPrompt || '';
    // Content-addressed uuid so re-syncing overwrites one DDB item instead of accumulating (was Date.now()).
    const hash = crypto.createHash('sha1').update(`${msg.type}|${msg.sessionId || ''}|${content}`).digest('hex').slice(0, 16);
    return { uuid: `${msg.type}_${hash}`, type: msg.type, content, timestamp: META_EPOCH_TS };
  }

  let content = msg.message?.content ?? '';
  // Normalize \r → \n defensively (some inputs carry CR line endings)
  if (typeof content === 'string') {
    content = content.replace(/\r\n?/g, '\n');
  }
  if (Array.isArray(content)) {
    const imageJobs = [];
    for (let i = 0; i < content.length; i++) {
      if (content[i].type === 'image') {
        const b64 = content[i].source?.data || content[i].source?.bytes || '';
        if (b64) imageJobs.push({ index: i, promise: processImage(b64) });
      }
    }
    const results = await Promise.allSettled(imageJobs.map(j => j.promise));

    content = content.map((block, i) => {
      if (block.type === 'image') {
        const job = imageJobs.find(j => j.index === i);
        if (job) {
          const result = results[imageJobs.indexOf(job)];
          if (result.status === 'fulfilled') return { type: 'image', key: result.value };
          console.error(`Image upload failed: ${result.reason?.message}`);
        }
        return { type: 'image', placeholder: true };
      }
      // tool_result image base64 is unused by the app (it renders via S3 key) — strip it.
      if (block.type === 'tool_result') return stripToolResultBase64(block);
      // Normalize \r → \n in text blocks
      if (block.type === 'text' && block.text && /\r/.test(block.text)) {
        return { ...block, text: block.text.replace(/\r\n?/g, '\n') };
      }
      return block;
    });
  }
  const extracted = {
    uuid: msg.uuid || msg.leafUuid || '',
    parentUuid: msg.parentUuid || null,
    type: msg.type || '',
    content,
    timestamp: msg.timestamp || '',
  };
  // jsonl uses camelCase toolUseResult; headless stream uses snake_case — accept either.
  const tur = msg.toolUseResult ?? msg.tool_use_result;
  if (tur) extracted.toolUseResult = stripToolUseResultBase64(tur);
  if (msg.message?.stop_reason) extracted.stopReason = msg.message.stop_reason;
  return extracted;
}

export async function extractClaudeMessages(filePath, sessionId, options = {}) {
  const watermarks = options.watermarks || synced;
  const startLine = options.startLine ?? watermarks.get(sessionId) ?? 0;
  if (!fs.existsSync(filePath)) return { messages: [], nextLine: startLine };
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const newMsgs = [];
  const metaUuids = new Set();
  const metaIdx = {}; // type → index in newMsgs (keep only latest per type)

  for (let i = Math.min(startLine, lines.length); i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let msg;
    try { msg = JSON.parse(lines[i]); } catch { continue; }
    if (!VALID_TYPES.has(msg.type)) continue;
    if ((msg.isMeta || msg.isCompactSummary) && msg.type === 'user') { metaUuids.add(msg.uuid); continue; }
    if (msg.type === 'user' && msg.parentUuid && metaUuids.has(msg.parentUuid)) { metaUuids.delete(msg.parentUuid); continue; }
    const extracted = await extractForApp(msg);
    if (!extracted.uuid) continue;
    if (extracted.type === 'ai-title' || extracted.type === 'custom-title' || extracted.type === 'last-prompt') {
      if (metaIdx[extracted.type] !== undefined) newMsgs[metaIdx[extracted.type]] = extracted;
      else { metaIdx[extracted.type] = newMsgs.length; newMsgs.push(extracted); }
      continue;
    }
    newMsgs.push(extracted);
  }

  return { messages: newMsgs, nextLine: lines.length };
}

export async function uploadMessages(sessionId, messages, options = {}) {
  if (messages.length === 0) return;
  let batch = [];
  let batchSize = 0;
  const identity = {
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.nativeSessionId ? { nativeSessionId: options.nativeSessionId } : {}),
  };

  for (const raw of messages) {
    // Cap every message before WS fallback or initial sync reaches DDB.
    const msg = truncateToBytes(raw, DDB_ITEM_LIMIT);
    const msgJson = JSON.stringify(msg);
    const msgBytes = Buffer.byteLength(msgJson);
    if (batchSize + msgBytes > MAX_POST_BYTES && batch.length > 0) {
      await postRequired('/api/bridge/sync-messages', { sessionId, messages: batch, ...identity });
      await new Promise(r => setTimeout(r, 200));
      batch = [];
      batchSize = 0;
    }
    batch.push(msg);
    batchSize += msgBytes;
  }
  if (batch.length > 0) {
    await postRequired('/api/bridge/sync-messages', { sessionId, messages: batch, ...identity });
  }
}
