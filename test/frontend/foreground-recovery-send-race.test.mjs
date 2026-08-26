import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  var resolve;
  var promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('completed recovery cannot settle a send created after the REST request started', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-new-send-race';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  const request = deferred();
  h.setApiHandler(() => request.promise);
  const recovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(recovery);
  await h.tick(0);

  h.window.doSend('new message after recovery started', 'new message after recovery started', []);
  const pending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId,
    turnId: pending.id,
    ok: true,
  });

  request.resolve({
    messages: [{
      uuid: 'old-answer',
      nativeId: 'codex:old:answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'older completed answer' }],
      timestamp: '2026-08-26T06:00:00.000Z',
      stopReason: 'end_turn',
    }],
    hasMore: false,
    needSync: false,
    status: 'completed',
  });
  await h.tick(40);

  assert.equal(h.state.wsRunning, true);
  assert.equal(h.state.pendingSentMessages.includes(pending), true);
  assert.equal(h.document.getElementById(pending.id)?.isConnected, true);
  assert.equal(
    h.document.querySelector('.messages').lastElementChild.id,
    pending.id,
  );
});
