import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, VALID_TYPES, NEEDS_POLLING, AGENTS_POLL_INTERVAL_MS } from './config.mjs';
import { post } from './http.mjs';
import { synced, extractForApp, uploadMessages } from './extract.mjs';
import { deliverRealtimeMessages } from './realtime-delivery.mjs';
import { clearLiveMessage } from './live-message-registry.mjs';
import { getSessionMetadata, readableProjectName, statusFromEntry, getSessionStatus, getRunningInfo, getDaemonSessions, getDaemonRunningSessionIds, findSessionFile, getAgentsJson, normalizeProjectHash } from './session.mjs';
import { recentSessions, lastKnownStatus, knownProjects, reconcile } from './sync.mjs';
import {
  headlessRoute,
  pendingInteractionDetail,
  poolOwns,
} from './ws.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { trackAgentSession } from './agent-counts.mjs';
import {
  claudeSubagentParentSessionId,
  claudeSubagentSessionId,
  readClaudeSubagentMeta,
} from './claude-subagent.mjs';

const _metaUuids = new Set(); // track isMeta message UUIDs to skip their replies

export function shouldPersistClaudeJsonlMessage(runtimeOwned, route) {
  return !!runtimeOwned || !!route?.pushed || !!route?.runtimeOwned;
}

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const busy = new Map(); // sessionId → { pending }
  const retries = new Map();

  if (NEEDS_POLLING) {
    // WSL2: inotify doesn't work on /mnt/ (9P filesystem), use polling
    const mtimes = new Map(); // filePath → mtimeMs
    console.log('[watcher] WSL detected, using polling (2s interval)');
    setInterval(() => pollProjects(config, busy, mtimes, retries), 2000);
  } else {
    fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      const parts = String(filename).split(path.sep);
      const subagentIndex = parts.indexOf('subagents');
      const sessionId = subagentIndex >= 2
        ? claudeSubagentSessionId(
          parts[subagentIndex - 1],
          path.basename(filename, '.jsonl'),
        )
        : path.basename(filename, '.jsonl');

      const state = busy.get(sessionId);
      if (state) { state.pending = true; return; }
      busy.set(sessionId, { pending: false });
      processClaudeLoop(config, busy, retries, filename, sessionId);
    });
  }
}

export function preferPendingInteraction(status, detail) {
  return detail === null
    ? { status, detail: null }
    : { status: 'needs_input', detail };
}

async function processClaudeLoop(config, busy, retries, filename, sessionId) {
  const state = busy.get(sessionId);
  try {
    do {
      state.pending = false;
      await readAndSend(config, filename, sessionId);
    } while (state.pending);
    clearTimeout(retries.get(sessionId));
    retries.delete(sessionId);
  } catch (error) {
    console.error(`[watcher] Claude ${sessionId.slice(0, 8)}: ${error.message}`);
    if (!retries.has(sessionId)) {
      const timer = setTimeout(() => {
        retries.delete(sessionId);
        if (busy.has(sessionId)) return;
        busy.set(sessionId, { pending: false });
        processClaudeLoop(config, busy, retries, filename, sessionId);
      }, 1000);
      timer.unref();
      retries.set(sessionId, timer);
    }
  }
  busy.delete(sessionId);
}

function pollProjects(config, busy, mtimes, retries) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  try {
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectDir = path.join(CLAUDE_PROJECTS, project);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }
      for (const file of fs.readdirSync(projectDir)) {
        const entryPath = path.join(projectDir, file);
        let entryStat;
        try { entryStat = fs.statSync(entryPath); } catch { continue; }
        if (entryStat.isDirectory()) {
          const subagentsDir = path.join(entryPath, 'subagents');
          let subagentFiles = [];
          try {
            subagentFiles = fs.readdirSync(subagentsDir)
              .filter((name) => name.endsWith('.jsonl'));
          } catch {}
          for (const subagentFile of subagentFiles) {
            const filePath = path.join(subagentsDir, subagentFile);
            const filename = path.join(project, file, 'subagents', subagentFile);
            const sessionId = claudeSubagentSessionId(
              file,
              path.basename(subagentFile, '.jsonl'),
            );
            queuePolledClaudeFile(
              config,
              busy,
              mtimes,
              retries,
              filePath,
              filename,
              sessionId,
            );
          }
          continue;
        }
        if (!file.endsWith('.jsonl') || file.startsWith('.')) continue;
        const filePath = entryPath;
        try {
          const filename = path.join(project, file);
          const sessionId = path.basename(file, '.jsonl');
          queuePolledClaudeFile(
            config,
            busy,
            mtimes,
            retries,
            filePath,
            filename,
            sessionId,
          );
        } catch {}
      }
    }
  } catch {}
}

function queuePolledClaudeFile(
  config,
  busy,
  mtimes,
  retries,
  filePath,
  filename,
  sessionId,
) {
  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return; }
  const prev = mtimes.get(filePath);
  if (prev === mtime) return;
  mtimes.set(filePath, mtime);
  if (prev === undefined) return;
  const state = busy.get(sessionId);
  if (state) {
    state.pending = true;
    return;
  }
  busy.set(sessionId, { pending: false });
  processClaudeLoop(config, busy, retries, filename, sessionId);
}

async function readAndSend(config, filename, sessionId) {
  const filePath = path.join(CLAUDE_PROJECTS, filename);
  if (!fs.existsSync(filePath)) return;
  if (String(filename).split(path.sep).includes('subagents')) {
    return readAndSendSubagent(config, filename, filePath, sessionId);
  }

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const lastLine = synced.get(sessionId) ?? 0;
  if (lines.length <= lastLine) return;

  let lastParsedLine = lastLine;
  let gotNewTitle = false;
  let lastStatus = null; // track status from parsed entries directly

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) { lastParsedLine = i + 1; continue; }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;

    // Track status from every parsed entry (statusFromEntry returns null for non-status types).
    const s = statusFromEntry(raw);
    if (s) lastStatus = s;

    if (!VALID_TYPES.has(raw.type)) continue;
    // Skip isMeta user messages (VS Code replay duplicates), but keep their assistant replies
    if (raw.isMeta && raw.type === 'user') { _metaUuids.add(raw.uuid); continue; }
    if (raw.type === 'user' && raw.parentUuid && _metaUuids.has(raw.parentUuid)) { _metaUuids.delete(raw.parentUuid); continue; }
    if (raw.type === 'ai-title' || raw.type === 'custom-title' || raw.type === 'last-prompt') gotNewTitle = true;

    const msg = await extractForApp(raw);
    if (!msg.uuid) continue;

    // A managed headless turn is the sole realtime source. Its JSONL copy only
    // persists; terminal/VS Code rows have no runtime ownership and still broadcast.
    const route = headlessRoute(msg.uuid);
    if (shouldPersistClaudeJsonlMessage(poolOwns(sessionId), route)) {
      await uploadMessages(sessionId, [msg]);
      clearLiveMessage('claude', msg.uuid);
      continue;
    }
    await deliverRealtimeMessages(sessionId, [msg]);
  }

  synced.set(sessionId, lastParsedLine);

  // Sync metadata only when status changed, new session, or ai-title arrived
  if (lastParsedLine > lastLine && (lastStatus || gotNewTitle)) {
    // Pool-owned → status comes from headless lifecycle events (updateSessionStatus carries
    // isAgent), not jsonl/daemon. Title metadata can still pass through while the pool
    // owns status, so list previews stay aligned with the open session title.
    const poolOwned = poolOwns(sessionId);
    if (poolOwned && !gotNewTitle) return;
    // Agent identity is permanent — never downgrade (a false isAgent put-overwrites the DDB flag).
    const dm = getDaemonSessions().get(sessionId);
    // Only roster-active agents trust daemon state; inactive agents use this jsonl update.
    const daemonActive = !poolOwned && dm && getDaemonRunningSessionIds().has(sessionId);
    const resolvedStatus = poolOwned ? 'running'
      : daemonActive ? dm.status
      : (lastStatus || getSessionStatus(sessionId, filePath, getRunningInfo()));
    const effective = preferPendingInteraction(
      resolvedStatus,
      pendingInteractionDetail(sessionId),
    );
    const agentMeta = dm && !daemonActive ? { ...dm, agentDetail: '' } : dm;
    await postSessionMeta(
      config,
      filePath,
      filename,
      sessionId,
      effective.status,
      agentMeta,
      gotNewTitle,
      effective.detail,
    );
  }
}

async function readAndSendSubagent(config, filename, filePath, sessionId) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const lastLine = synced.get(sessionId) ?? 0;
  if (lines.length <= lastLine) return;
  let lastParsedLine = lastLine;
  let lastStatus = null;
  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) {
      lastParsedLine = i + 1;
      continue;
    }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;
    const status = statusFromEntry(raw);
    if (status) lastStatus = status;
    if (!VALID_TYPES.has(raw.type)) continue;
    const message = await extractForApp(raw);
    if (!message.uuid) continue;
    await deliverRealtimeMessages(sessionId, [message]);
  }
  synced.set(sessionId, lastParsedLine);

  const parts = String(filename).split(path.sep);
  const subagentIndex = parts.indexOf('subagents');
  if (subagentIndex < 2) return;
  const projectHash = normalizeProjectHash(parts[0]);
  const rootSessionId = parts[subagentIndex - 1];
  const agentId = path.basename(filename, '.jsonl');
  const meta = readClaudeSubagentMeta(filePath);
  const parentFile = path.join(
    CLAUDE_PROJECTS,
    parts[0],
    `${rootSessionId}.jsonl`,
  );
  const parentMetadata = fs.existsSync(parentFile)
    ? getSessionMetadata(parentFile)
    : {};
  const stat = fs.statSync(filePath);
  const status = lastStatus
    || (Date.now() - stat.mtimeMs < 15_000 ? 'running' : 'completed');
  lastKnownStatus.set(sessionId, status);
  recentSessions.add(sessionId);
  const sessionMeta = {
    id: sessionId,
    nativeSessionId: sessionId,
    runtime: 'claude',
    project: projectHash,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
    size: stat.size,
    preview: meta.description || agentId,
    model: parentMetadata.model || '',
    status,
    isAgent: true,
    threadKind: 'subagent',
    parentSessionId: claudeSubagentParentSessionId(rootSessionId, meta),
    agentName: meta.description || meta.agentType || agentId,
    agentPath: agentId,
    agentDepth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 1,
    canSend: false,
  };
  const agentCountUpdates = trackAgentSession(sessionMeta);
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(agentCountUpdates.length ? { agentCountUpdates } : {}),
  });
}

// Post session metadata + counter delta when status changed, is new, or title arrived.
async function postSessionMeta(
  config,
  filePath,
  filename,
  sessionId,
  newStatus,
  dm,
  gotNewTitle,
  interactionDetail = null,
) {
  const oldStatus = lastKnownStatus.get(sessionId);
  const statusChanged = newStatus !== oldStatus;
  const isNew = !recentSessions.has(sessionId);

  // Skip empty-shell sessions (e.g. /clear: metadata only, no preview, not running).
  const metadata = getSessionMetadata(filePath);
  const preview = metadata.preview;
  if (!preview && newStatus !== 'running' && !dm) return;
  if (!(statusChanged || isNew || gotNewTitle)) return;

  const stat = fs.statSync(filePath);
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filename)));
  lastKnownStatus.set(sessionId, newStatus);
  // Counter delta — server uses this to ADD/SUBTRACT counters; 'new' means += 1.
  const statusDelta = (statusChanged || isNew) ? {
    deviceName: config.deviceName,
    projectHash,
    from: isNew && oldStatus === undefined ? 'new' : (oldStatus || 'completed'),
    to: newStatus,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
  } : null;
  const sessionMeta = {
    id: sessionId,
    project: projectHash,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
    size: stat.size,
    preview: preview || 'New session',
    model: metadata.model,
    status: newStatus,
  };
  if (dm) {
    sessionMeta.isAgent = true;
    sessionMeta.agentName = dm.agentName;
    sessionMeta.agentDetail = dm.agentDetail;
  }
  if (newStatus === 'needs_input' && interactionDetail !== null) {
    sessionMeta.agentDetail = interactionDetail;
  }
  trackAgentSession(sessionMeta);
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(statusDelta ? { statusDelta } : {}),
  });
  recentSessions.add(sessionId);
  // First session of a brand-new project → recount totals so projectCount stays accurate.
  if (!knownProjects.has(projectHash)) {
    knownProjects.add(projectHash);
    reconcile(config);
  }
}

const _jobsState = new Map(); // sessionId → { agentName, agentDetail, status }

// state.json is stale (the daemon computes state live but doesn't flush it
// promptly), so fs.watch on it misses transitions. Poll `claude agents --json`
// instead — the daemon-live source — and push any agent whose state changed.
export function startJobsWatcher(config) {
  if (!fs.existsSync(CLAUDE_JOBS)) return;
  // No seed: the first poll pushes every agent once, so DDB gets correct agent
  // flags/state even for sessions the initial full sync didn't cover (it only
  // syncs running/idle + recent 24h, missing older blocked/working agents).
  pollAgentStates(config);
  setInterval(() => pollAgentStates(config), AGENTS_POLL_INTERVAL_MS);
}

async function pollAgentStates(config) {
  let agents;
  try { agents = getAgentsJson(true); } catch { return; }
  for (const [sid, e] of agents) {
    const filePath = findSessionFile(sid);
    if (!filePath) continue;
    // Pool-owned = driven live by headless; skip so the daemon's stale 'done' doesn't override its running.
    if (poolOwns(sid)) continue;
    // Title: --json name first, then the jsonl's first user message. At launch
    // both can be empty for a poll or two (name not inferred yet, jsonl not
    // written), so preview is part of the diff — a title arriving later re-pushes.
    const metadata = getSessionMetadata(filePath);
    const preview = e.agentName || metadata.preview || 'Agent session';
    const old = _jobsState.get(sid);
    if (old && old.agentName === e.agentName && old.agentDetail === e.agentDetail && old.status === e.status && old.preview === preview) continue;
    _jobsState.set(sid, { ...e, preview });
    await pushAgentMeta(config, sid, e, filePath, preview, metadata.model);
  }
}

async function pushAgentMeta(config, sessionId, e, filePath, preview, model) {
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filePath)));
  const stat = fs.statSync(filePath);
  lastKnownStatus.set(sessionId, e.status);
  const sessionMeta = {
    id: sessionId,
    project: projectHash,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
    size: stat.size,
    preview,
    model,
    status: e.status,
    isAgent: true,
    agentName: e.agentName,
    agentDetail: e.agentDetail,
  };
  trackAgentSession(sessionMeta);
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
  });
}

export const claudeWatcherAdapter = defineRuntimeWatcher({
  runtime: 'claude',
  start: startWatcher,
});
