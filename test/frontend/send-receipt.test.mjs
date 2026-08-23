import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('send reliability keeps receipt, retry, and failure states distinct', async () => {
  const h = await makeHarness();
  const failPendingTurns = async () => {
    for (const pending of [...h.state.pendingSentMessages]) {
      h.hooks.handleWsMessage({
        action: 'send_message_result',
        turnId: pending.id,
        ok: false,
        error: 'test cleanup',
      });
    }
    await h.tick(0);
  };

  resetSession(h, { sessionId: 'codex:receipt' });
  const receivedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { receivedSent.push(JSON.parse(payload)); },
  };

  h.window.doSend('received', 'received', []);
  const receivedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_received',
    turnId: receivedPending.id,
  });
  await h.tick(30);

  assert.equal(receivedSent.length, 1);
  assert.equal(receivedPending.delivered, undefined);
  assert.equal(
    h.document.querySelector('.sending-status').textContent,
    'sending...',
  );
  await failPendingTurns();

  resetSession(h, { sessionId: 'codex:retry' });
  const retriedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { retriedSent.push(JSON.parse(payload)); },
  };

  h.window.doSend('retry', 'retry', []);
  await h.tick(30);

  assert.equal(retriedSent.length, 2);
  assert.equal(retriedSent[1].turnId, retriedSent[0].turnId);
  assert.deepEqual(retriedSent[1], retriedSent[0]);
  await failPendingTurns();

  resetSession(h, { sessionId: '__new__', mode: 'new' });
  h.state.wsProjectHash = '-project';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.window.doSend('hello', 'hello', []);
  const failedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    turnId: failedPending.id,
    ok: false,
    error: 'Previous message did not reach the Bridge. Retry.',
    errorCode: 'previous_turn_missing',
  });
  await h.tick(0);

  assert.equal(failedPending.failed, true);
  assert.equal(h.state.wsRunning, false);
  assert.match(
    h.document.querySelector('.sending-status').textContent,
    /Retry/,
  );

  resetSession(h, { sessionId: 'codex:retry-order' });
  const orderedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { orderedSent.push(JSON.parse(payload)); },
  };
  h.window.doSend('still running', 'still running', []);
  const firstPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_received',
    turnId: firstPending.id,
  });
  h.window.doSend('retry me', 'retry me', []);
  const retryPending = h.state.pendingSentMessages[1];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    turnId: retryPending.id,
    ok: false,
    error: 'Previous message did not reach the Bridge. Retry.',
    errorCode: 'previous_turn_missing',
  });
  await h.tick(0);
  await h.window.retryPendingSend(retryPending.id);

  assert.equal(orderedSent.length, 3);
  assert.equal(orderedSent[2].previousTurnId, firstPending.id);
  assert.notEqual(orderedSent[2].turnId, retryPending.id);
  assert.equal(
    h.document.querySelector('.messages').lastElementChild.id,
    orderedSent[2].turnId,
  );
  await failPendingTurns();
  h.window.close();
});
