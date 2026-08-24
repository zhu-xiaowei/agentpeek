import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('reconnect preserves a partial block until authority replaces it in place', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-checkpoint';
  const turnId = 'turn-foreground-checkpoint';
  resetSession(h, { sessionId });

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-1',
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T13:58:40.000Z',
      }],
    }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'draft' }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(20);

  assert.match(h.document.body.textContent, /draft/);
  const partialBlock = h.document.querySelector(
    `[data-turn-id="${turnId}"] [data-block-id="2"]`,
  );
  assert.ok(partialBlock);
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  let resolveRest;
  h.setApiHandler(() => new Promise((resolve) => { resolveRest = resolve; }));
  const recovery = h.hooks.beginSessionConnectionRecovery();
  assert.ok(recovery);
  assert.equal(h.hooks.startSessionConnectionRecovery(recovery), true);

  h.hooks.handleWsMessage(event(sessionId, turnId, 4, 'stream_delta', {
    chunk: ' lost continuation',
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 5, 'messages', {
    messages: [{
      uuid: 'assistant-1',
      nativeId: 'codex:item:assistant-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'final first block' }],
      timestamp: '2026-08-18T13:58:44.000Z',
    }],
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 6, 'stream_block_start', {
    kind: 'text',
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 7, 'stream_delta', {
    chunk: 'second block',
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 8, 'stream_block_stop'));
  h.hooks.handleWsMessage(event(sessionId, turnId, 9, 'messages', {
    messages: [{
      uuid: 'assistant-2',
      nativeId: 'codex:item:assistant-2',
      type: 'assistant',
      content: [{ type: 'text', text: 'second block' }],
      timestamp: '2026-08-18T13:58:45.000Z',
    }],
  }));
  h.hooks.handleWsMessage(event(sessionId, turnId, 10, 'stream_end', {
    messages: [{
      uuid: 'assistant-1',
      nativeId: 'codex:item:assistant-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'final first block' }],
      timestamp: '2026-08-18T13:58:44.000Z',
    }, {
      uuid: 'assistant-2',
      nativeId: 'codex:item:assistant-2',
      type: 'assistant',
      content: [{ type: 'text', text: 'second block' }],
      timestamp: '2026-08-18T13:58:45.000Z',
    }],
  }));
  await h.tick(20);

  // REST is still pending: keep the old DOM and do not release new WS events.
  assert.match(h.document.querySelector('.messages').textContent, /draft/);
  assert.equal(
    h.document.querySelector('.messages').textContent.includes('second block'),
    false,
  );

  resolveRest({
    messages: [
      {
        uuid: 'user-1',
        nativeId: 'codex:user:' + turnId,
        type: 'user',
        content: 'continue',
        timestamp: '2026-08-18T13:58:40.000Z',
      },
      {
        uuid: 'assistant-history-1',
        nativeId: 'codex:item:assistant-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'final first block' }],
        timestamp: '2026-08-18T13:58:44.000Z',
      },
    ],
    hasMore: false,
    status: 'completed',
  });
  await h.tick(50);

  const text = h.document.querySelector('.messages').textContent;
  assert.equal(text.includes('draft'), false);
  assert.equal(text.includes('lost continuation'), false);
  assert.equal((text.match(/final first block/g) || []).length, 1);
  assert.equal((text.match(/second block/g) || []).length, 1);
  assert.equal(h.state.wsRunning, false);
  assert.equal(h.document.querySelector('.stream-preview'), null);
  assert.equal(partialBlock.isConnected, false);
});
