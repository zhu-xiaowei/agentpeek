import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

async function startIncompleteTurn(h, sessionId, turnId) {
  const events = [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-' + turnId,
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T13:58:40.705Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', {
      kind: 'tool_use',
      name: 'WebSearch',
    }),
    event(sessionId, turnId, 3, 'stream_tool_input', {
      chunk: '{"query":"test"}',
    }),
    event(sessionId, turnId, 4, 'stream_block_stop'),
    event(sessionId, turnId, 5, 'messages', {
      messages: [{
        uuid: 'tool-use-' + turnId,
        nativeId: 'codex:item:' + turnId + ':tool-use',
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-' + turnId,
          name: 'WebSearch',
          input: { query: 'test' },
        }],
        timestamp: '2026-08-18T13:58:44.000Z',
        stopReason: 'tool_use',
      }],
    }),
    event(sessionId, turnId, 6, 'messages', {
      messages: [{
        uuid: 'tool-result-' + turnId,
        nativeId: 'codex:item:' + turnId + ':tool-result',
        type: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-' + turnId,
          content: 'done',
          is_error: false,
        }],
        timestamp: '2026-08-18T13:58:45.000Z',
      }],
    }),
  ];
  for (const item of events) h.hooks.handleWsMessage(item);
  await h.tick(20);
}

test('foreground recovery settles completed turns from message status', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-complete';
  const turnId = 'turn-complete';
  resetSession(h, { sessionId });
  await startIncompleteTurn(h, sessionId, turnId);
  assert.equal(h.state.wsRunning, true);

  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.setApiResponse({
    messages: [
      {
        uuid: 'user-' + turnId,
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T13:58:40.705Z',
      },
      {
        uuid: 'tool-use-' + turnId,
        nativeId: 'codex:item:' + turnId + ':tool-use',
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-' + turnId,
          name: 'WebSearch',
          input: { query: 'test' },
        }],
        timestamp: '2026-08-18T13:58:44.000Z',
        stopReason: 'tool_use',
      },
      {
        uuid: 'tool-result-' + turnId,
        nativeId: 'codex:item:' + turnId + ':tool-result',
        type: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-' + turnId,
          content: 'done',
          is_error: false,
        }],
        timestamp: '2026-08-18T13:58:45.000Z',
      },
      {
        uuid: 'assistant-final',
        nativeId: 'codex:item:final',
        type: 'assistant',
        content: [{ type: 'text', text: 'finished while hidden' }],
        timestamp: '2026-08-18T13:58:46.000Z',
        stopReason: 'end_turn',
      },
    ],
    hasMore: false,
    status: 'completed',
  });

  const completedRecovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(completedRecovery);
  await h.tick(40);

  assert.equal(h.state.wsRunning, false);
  assert.equal(h.document.querySelector('.stream-preview'), null);
  assert.match(h.document.querySelector('.messages').textContent, /finished while hidden/);

  const runningTurnId = 'turn-running';
  await startIncompleteTurn(h, sessionId, runningTurnId);
  h.setApiResponse({ messages: [], hasMore: false, status: 'running' });
  const runningRecovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(runningRecovery);
  await h.tick(20);

  assert.equal(h.state.wsRunning, true);
  assert.equal(
    h.document.querySelector(`[data-turn-id="${runningTurnId}"]`)
      ?.classList.contains('stream-preview'),
    true,
  );
  assert.equal(h.state.wsRunning, true);

  h.setApiResponse({ messages: [], hasMore: false, status: 'needs_input' });
  const inputRecovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(inputRecovery);
  await h.tick(20);

  assert.equal(h.state.wsRunning, false);
  assert.equal(
    h.document.querySelector(`[data-turn-id="${runningTurnId}"]`)
      ?.classList.contains('stream-preview'),
    true,
  );
});
