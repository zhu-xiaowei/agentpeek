import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('initial setup and a fast first send share one WS config and connection', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: '__new__', mode: 'new' });
  h.state.WS_URL = '';
  h.state.ws = null;

  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  h.window.WebSocket = FakeWebSocket;
  globalThis.localStorage = h.window.localStorage;
  globalThis.showWsBanner = h.window.showWsBanner = function () {};

  const config = deferred();
  let configRequests = 0;
  h.setApiHandler(async (path) => {
    if (path === '/api/bridge/config') {
      configRequests++;
      return config.promise;
    }
    return { messages: [], hasMore: false };
  });

  h.window.connectWs(null, '-project');
  h.window.wsSendReliable({
    action: 'send_message',
    projectHash: '-project',
    turnId: 'sent-1',
    text: 'hello',
  });

  assert.equal(configRequests, 1);
  assert.equal(sockets.length, 0);

  config.resolve({ wsUrl: 'wss://example.test/ws' });
  await h.tick(20);

  assert.equal(sockets.length, 1);
  h.window.connectWs();
  assert.equal(sockets.length, 1, 'CONNECTING socket must be reused');

  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].onopen();
  assert.deepEqual(
    sockets[0].sent.filter((message) => message.action === 'send_message'),
    [{
      action: 'send_message',
      projectHash: '-project',
      turnId: 'sent-1',
      text: 'hello',
    }],
  );

  h.window.connectWs();
  assert.equal(sockets.length, 1, 'OPEN socket must be reused');

  h.window.disconnectWs();
  h.window.close();
});
