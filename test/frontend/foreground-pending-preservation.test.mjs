import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('completed foreground recovery keeps sending and retry bubbles at the bottom', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-local-pending';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';

  const history = {
    uuid: 'history-user',
    nativeId: 'codex:history:user',
    type: 'user',
    content: 'older prompt',
    timestamp: '2026-08-26T06:00:00.000Z',
  };
  h.state.wsAllMessages = [history];
  h.state.wsMessageUuids = new Set([
    history.uuid,
    'native:' + history.nativeId,
  ]);
  h.state.wsMessageCount = 1;
  h.state.wsRenderedCount = 1;
  h.document.querySelector('.messages').innerHTML =
    h.window.renderMessages([history], 'codex');
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  h.window.doSend('keep this retry draft', 'keep this retry draft', []);
  const retryPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId,
    turnId: retryPending.id,
    ok: false,
    error: 'Not delivered',
  });

  h.window.doSend('keep this sending draft', 'keep this sending draft', []);
  const sendingPending = h.state.pendingSentMessages[1];

  h.setApiResponse({
    messages: [
      history,
      {
        uuid: 'history-answer',
        nativeId: 'codex:history:answer',
        type: 'assistant',
        content: [{ type: 'text', text: 'older answer' }],
        timestamp: '2026-08-26T06:00:01.000Z',
        stopReason: 'end_turn',
      },
    ],
    hasMore: false,
    needSync: false,
    status: 'completed',
  });

  const recovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(recovery);
  await h.tick(40);

  assert.equal(h.state.wsRunning, false);
  assert.equal(h.document.getElementById(retryPending.id)?.isConnected, true);
  assert.equal(h.document.getElementById(sendingPending.id)?.isConnected, true);
  assert.match(
    h.document.getElementById(retryPending.id).textContent,
    /keep this retry draft.*Retry/,
  );
  assert.match(
    h.document.getElementById(sendingPending.id).textContent,
    /keep this sending draft.*sending/,
  );
  assert.deepEqual(
    Array.from(h.document.querySelector('.messages').children)
      .slice(-2)
      .map((node) => node.id),
    [retryPending.id, sendingPending.id],
  );
});
