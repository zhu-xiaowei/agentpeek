import crypto from 'node:crypto';

export const CODEX_LIVE_SOURCE = Symbol('codexLiveSource');

export function codexUserLiveKey(clientId) {
  return clientId ? `user:${clientId}` : '';
}

export function codexTurnUserLiveKey(turnId) {
  return turnId ? `turn:${turnId}:user` : '';
}

export function codexTurnErrorLiveKey(turnId) {
  return turnId ? `turn:${turnId}:error` : '';
}

export function codexTurnLiveKey(turnId) {
  return turnId ? `runtime-turn:${turnId}` : '';
}

export function codexItemLiveKey(itemId) {
  return itemId ? `item:${itemId}` : '';
}

export function codexTurnUserNativeId(turnId) {
  return turnId ? `codex:turn:${turnId}:user` : '';
}

export function codexTurnErrorNativeId(turnId) {
  return turnId ? `codex:turn:${turnId}:error` : '';
}

export function codexUserNativeId(clientId) {
  return clientId ? `codex:user:${clientId}` : '';
}

export function codexItemNativeId(itemId) {
  return itemId ? `codex:item:${itemId}` : '';
}

export function codexToolUseId(sessionId, itemId, occurrence = 1, suffix = '') {
  if (!sessionId || !itemId) return '';
  const digest = crypto.createHash('sha1')
    .update(`${sessionId}|${itemId}|${occurrence}|${suffix}`)
    .digest('hex')
    .slice(0, 20);
  return `codex_tool_${digest}`;
}

export function codexToolMessageNativeId(itemId, phase) {
  return itemId && phase ? `codex:item:${itemId}:${phase}` : '';
}

export function tagCodexLiveSource(message, key) {
  if (!message || !key) return message;
  Object.defineProperty(message, CODEX_LIVE_SOURCE, {
    configurable: true,
    enumerable: false,
    value: key,
  });
  return message;
}

export function codexLiveSource(message) {
  return message?.[CODEX_LIVE_SOURCE] || '';
}

function timestamp(value) {
  if (typeof value === 'string' && value) return value;
  const date = Number.isFinite(value) ? new Date(value) : new Date();
  return date.toISOString();
}

function valueText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (typeof entry?.text === 'string') return entry.text;
      return JSON.stringify(entry);
    }).join('\n');
  }
  if (value == null) return '';
  if (typeof value?.content !== 'undefined') return valueText(value.content);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function commandResult(item) {
  const fallback = [item.stdout, item.stderr].filter(Boolean).join('\n');
  return valueText(
    item.aggregatedOutput
    ?? item.aggregated_output
    ?? item.formattedOutput
    ?? item.formatted_output
    ?? item.output
    ?? (fallback || undefined)
    ?? item.status
    ?? '',
  ).replace(/^(?:\r?\n)+/, '').trimEnd();
}

const CODEX_TOOL_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'webSearch',
]);

export function isCodexToolItem(item) {
  return CODEX_TOOL_ITEM_TYPES.has(item?.type);
}

function completedToolResult(item) {
  if (item.interrupted) {
    const { interrupted, status, ...partial } = item;
    return completedToolResult(partial) || 'Interrupted';
  }
  if (item.type === 'commandExecution') return commandResult(item);
  if (item.type === 'fileChange') {
    return valueText(item.error || item.result)
      || (item.status === 'failed' ? 'File change failed' : 'Applied changes');
  }
  if (item.type === 'mcpToolCall') {
    return valueText(item.error || item.result || item.status);
  }
  if (item.type === 'webSearch') {
    return valueText(item.result)
      || (item.query ? `Searched the web for ${item.query}` : 'Web search completed');
  }
  return valueText(item.result || item.output || item.status);
}

function toolFailed(item) {
  const exitCode = item.exitCode ?? item.exit_code;
  return item.interrupted === true
    || item.status === 'interrupted'
    || item.status === 'cancelled'
    || item.status === 'failed'
    || item.status === 'declined'
    || item.result?.isError === true
    || item.result?.is_error === true
    || (Number.isInteger(exitCode) && exitCode !== 0);
}

function completedToolMessages(item, completedAtMs, context) {
  if (!isCodexToolItem(item)) return [];
  const previews = codexPreviewBlocks(item);
  if (!previews.length) return [];
  const sessionId = context.sessionId || '';
  const uses = previews.map((preview, index) => ({
    type: 'tool_use',
    id: codexToolUseId(
      sessionId,
      item.id,
      1,
      previews.length > 1 ? String(index) : '',
    ),
    name: preview.name || 'Tool',
    input: preview.input || {},
  }));
  if (uses.some((use) => !use.id)) return [];
  const at = timestamp(completedAtMs);
  const liveKey = codexItemLiveKey(item.id);
  const exitCode = item.exitCode ?? item.exit_code;
  return [
    {
      liveKey,
      message: {
        uuid: `codex_live_tool_use_${item.id}`,
        nativeId: codexToolMessageNativeId(item.id, 'tool-use'),
        type: 'assistant',
        content: uses,
        timestamp: at,
        stopReason: 'tool_use',
      },
    },
    {
      liveKey,
      message: {
        uuid: `codex_live_tool_result_${item.id}`,
        nativeId: codexToolMessageNativeId(item.id, 'tool-result'),
        type: 'user',
        content: uses.map((use) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content: completedToolResult(item),
          is_error: toolFailed(item),
          ...(Number.isInteger(exitCode) ? { codexExitCode: exitCode } : {}),
        })),
        timestamp: at,
      },
    },
  ];
}

export function codexErrorMessage(error) {
  let value = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return '';
      try {
        value = JSON.parse(text);
        continue;
      } catch {
        return text;
      }
    }
    if (!value || typeof value !== 'object') {
      return value == null ? '' : String(value);
    }
    if (value.error != null) {
      value = value.error;
      continue;
    }
    if (value.message != null) {
      value = value.message;
      continue;
    }
    if (value.detail != null) {
      value = value.detail;
      continue;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return typeof value === 'string' ? value.trim() : '';
}

export function codexTurnErrorLiveMessage(turnId, error, at, uuid = '') {
  const detail = codexErrorMessage(error);
  const liveKey = codexTurnErrorLiveKey(turnId);
  if (!detail || !liveKey) return null;
  return {
    liveKey,
    message: {
      uuid: uuid || `codex_live_error_${turnId}`,
      nativeId: codexTurnErrorNativeId(turnId),
      type: 'assistant',
      content: [{ type: 'text', text: `Error: ${detail}` }],
      timestamp: timestamp(at),
      stopReason: 'end_turn',
    },
  };
}

export function codexUserItemText(item) {
  return (item?.content || []).map((part) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'localImage') return `![Image](${part.path || ''})`;
    if (part?.type === 'image') return `![Image](${part.url || ''})`;
    return '';
  }).filter(Boolean).join('\n');
}

export function codexCompletedLiveMessages(
  item,
  completedAtMs,
  fallbackText = '',
  context = {},
) {
  if (!item?.id) return [];
  const at = timestamp(completedAtMs);
  const completedTools = completedToolMessages(item, completedAtMs, context);
  if (completedTools.length) return completedTools;
  if (item.type === 'userMessage') {
    const text = codexUserItemText(item);
    const liveKey = codexUserLiveKey(item.clientId)
      || codexTurnUserLiveKey(context.turnId);
    if (!text || !liveKey) return [];
    return [{
      liveKey,
      message: {
        uuid: `codex_live_user_${item.id}`,
        nativeId: codexUserNativeId(item.clientId)
          || codexTurnUserNativeId(context.turnId),
        type: 'user',
        content: text,
        timestamp: at,
      },
    }];
  }
  if (item.type === 'agentMessage') {
    const text = item.text || fallbackText;
    if (!text) return [];
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_agent_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: at,
      },
    }];
  }
  if (item.type === 'reasoning') {
    const thinking = [...(item.content || []), ...(item.summary || [])].join('\n')
      || fallbackText;
    if (!thinking) return [];
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_reasoning_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'thinking', thinking }],
        timestamp: at,
      },
    }];
  }
  if (item.type === 'plan' && item.text) {
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_plan_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'text', text: item.text }],
        timestamp: at,
      },
    }];
  }
  return [];
}

function commandActions(actions) {
  return (actions || []).map((action) => ({
    ...action,
    type: action?.type === 'listFiles' ? 'list_files' : action?.type,
  }));
}

function diffSides(diff) {
  const oldLines = [];
  const newLines = [];
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  return { old_string: oldLines.join('\n'), new_string: newLines.join('\n') };
}

function fileChangeSides(change) {
  const sides = diffSides(change.diff);
  const kind = typeof change.kind === 'string'
    ? change.kind
    : change.kind?.type;
  if (kind === 'add') return { old_string: '', new_string: sides.new_string };
  if (kind === 'delete') return { old_string: sides.old_string, new_string: '' };
  return sides;
}

export function codexPreviewBlocks(item) {
  if (!item?.id) return [];
  if (item.type === 'agentMessage') {
    return [{ kind: 'text' }];
  }
  if (item.type === 'reasoning') return [{ kind: 'thinking' }];
  if (item.type === 'plan') return [{ kind: 'text' }];
  if (item.type === 'commandExecution') {
    return [{
      kind: 'tool_use',
      name: 'Bash',
      input: {
        command: item.command || '',
        cwd: item.cwd || '',
        codexCommandActions: commandActions(item.commandActions),
      },
    }];
  }
  if (item.type === 'fileChange') {
    return (item.changes || []).map((change) => ({
      kind: 'tool_use',
      name: 'Edit',
      input: {
        file_path: change.path || '',
        ...fileChangeSides(change),
      },
    }));
  }
  if (item.type === 'mcpToolCall') {
    return [{
      kind: 'tool_use',
      name: item.tool || 'Tool',
      input: {
        ...(item.arguments && typeof item.arguments === 'object'
          ? item.arguments
          : { input: item.arguments }),
        codexMcpServer: item.server || '',
        codexMcpTool: item.tool || '',
      },
    }];
  }
  if (item.type === 'webSearch') {
    return [{
      kind: 'tool_use',
      name: 'WebSearch',
      input: {
        query: item.query || '',
        ...(item.action ? { action: item.action.type || 'search' } : {}),
      },
    }];
  }
  return [];
}
