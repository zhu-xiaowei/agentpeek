import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function turnEvent(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('new-session REST and live user authority promote one optimistic bubble', async () => {
  const h = await makeHarness();
  resetSession(h, {
    sessionId: '__new__',
    mode: 'new',
    firstText: 'same prompt',
  });
  h.state.appState.runtime = 'codex';
  h.state.wsRequestId = 'request-1';
  h.state.wsSessionId = '';
  const request = deferred();
  h.setApiHandler(() => request.promise);

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'wrong-session',
    turnId: 'sent-from-another-tab',
    ok: true,
  });
  await h.tick(0);
  assert.equal(h.state.appState.session, '__new__');

  h.hooks.handleWsMessage(turnEvent('codex:new-thread', 'sent-1', 1, 'messages', {
    messages: [{
      uuid: 'live-user',
      nativeId: 'codex:user:sent-1',
      type: 'user',
      content: 'same prompt',
      timestamp: '2026-08-18T04:41:47.000Z',
    }],
  }));

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:new-thread',
    requestId: 'request-1',
    turnId: 'sent-1',
    ok: true,
  });
  await h.tick(0);

  assert.equal(h.state.rootSessionId, 'codex:new-thread');
  assert.equal(h.state.activeThreadId, 'codex:new-thread');
  assert.equal(h.state.sessionThreads.length, 1);
  assert.equal(h.state.sessionThreads[0].sessionId, 'codex:new-thread');

  request.resolve({
    messages: [{
      uuid: 'rest-user',
      nativeId: 'codex:user:sent-1',
      type: 'user',
      content: 'same prompt',
      timestamp: '2026-08-18T04:41:47.000Z',
    }],
    hasMore: false,
  });
  await h.tick(30);

  const container = h.document.querySelector('.messages');
  assert.equal(
    container.textContent.split('same prompt').length - 1,
    1,
    'the REST echo must promote the optimistic bubble instead of adding one',
  );

  for (const event of [
    turnEvent('codex:new-thread', 'sent-1', 0, 'stream_turn_start'),
    turnEvent('codex:new-thread', 'sent-1', 2, 'stream_block_start', {
      kind: 'text',
    }),
    turnEvent('codex:new-thread', 'sent-1', 3, 'stream_delta', {
      chunk: 'answer',
    }),
    turnEvent('codex:new-thread', 'sent-1', 4, 'stream_block_stop'),
    turnEvent('codex:new-thread', 'sent-1', 5, 'messages', {
      messages: [{
        uuid: 'assistant-1',
        nativeId: 'codex:item:assistant-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        timestamp: '2026-08-18T04:41:48.000Z',
      }],
    }),
    turnEvent('codex:new-thread', 'sent-1', 6, 'stream_end'),
  ]) {
    h.hooks.handleWsMessage(event);
  }

  await h.tick(80);

  assert.equal(
    container.querySelectorAll('[data-anchor="sent-1"]').length,
    1,
  );
  assert.equal(
    container.textContent.split('same prompt').length - 1,
    1,
  );
  assert.equal(
    container.textContent.split('answer').length - 1,
    1,
  );
  assert.equal(h.state.pendingSentMessages.length, 0);
});
