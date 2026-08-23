import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('new Claude session stream_end settles the first optimistic send without a user echo', async () => {
  const h = await makeHarness();
  const sessionId = 'ee82235e-1962-4fa0-b864-ab262636a2de';
  const requestId = 'f55f5544-814e-40f2-9056-422fb2955cde';
  resetSession(h, { sessionId: '', mode: 'new' });
  h.state.appState.runtime = 'claude';
  h.state.wsRequestId = requestId;
  h.state.wsProjectHash = '-home-ubuntu-asset-test1';
  h.state.wsSessionId = '';
  h.state.ws = {
    readyState: h.window.WebSocket.OPEN,
    send() {},
    close() {},
  };

  h.window.doSend('hi', 'hi', []);
  const turnId = h.state.pendingSentMessages[0].id;
  const assistant = {
    uuid: '66517a87-1e90-49b6-8043-e19badbf805f',
    parentUuid: null,
    type: 'assistant',
    content: [{
      type: 'text',
      text: 'Hi! What can I help you with today?',
    }],
    timestamp: '2026-08-20T23:05:10.936Z',
  };

  for (const event of [
    {
      action: 'send_message_result',
      sessionId,
      ok: true,
      requestId,
      turnId,
      deviceName: 'D',
    },
    {
      action: 'sync_complete',
      sessionId,
      status: 'ok',
      count: 0,
    },
    {
      action: 'stream_block_start',
      sessionId,
      turnId,
      seq: 2,
      kind: 'text',
      name: '',
    },
    {
      action: 'stream_delta',
      sessionId,
      turnId,
      seq: 3,
      chunk: 'Hi! What',
    },
    {
      action: 'messages',
      sessionId,
      turnId,
      seq: 5,
      messages: [assistant],
    },
    {
      action: 'stream_delta',
      sessionId,
      turnId,
      seq: 4,
      chunk: ' can I help',
    },
    {
      action: 'stream_delta',
      sessionId,
      turnId,
      seq: 6,
      chunk: ' you with today?',
    },
    {
      action: 'stream_end',
      sessionId,
      turnId,
      seq: 8,
      messages: [assistant],
    },
    {
      action: 'stream_block_stop',
      sessionId,
      turnId,
      seq: 7,
    },
  ]) {
    h.hooks.handleWsMessage(event);
  }
  await h.tick(100);

  const anchor = h.document.querySelector(`[data-anchor="${turnId}"]`);
  assert.equal(h.state.wsRunning, false);
  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(anchor?.hasAttribute('data-pending'), false);
  assert.equal(
    h.document.querySelector(`[data-turn-id="${turnId}"]`)
      ?.classList.contains('stream-committed'),
    true,
  );
  assert.equal(h.document.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(
    h.document.querySelector('.assistant-turn')?.textContent,
    'Hi! What can I help you with today?',
  );
});
