import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('foreground and unexpected reconnects share recovery while navigation starts fresh', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:foreground-ws' });
  h.state.WS_URL = 'wss://example.test/ws';
  h.state.KEY = 'test-key';

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
      this.closeCount = 0;
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(JSON.parse(payload));
    }

    close() {
      this.closeCount++;
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  h.window.WebSocket = FakeWebSocket;
  globalThis.showWsBanner = h.window.showWsBanner = function () {};

  let oldClosed = 0;
  const existingSent = [];
  h.state.ws = {
    readyState: FakeWebSocket.OPEN,
    onclose() {},
    send(payload) { existingSent.push(JSON.parse(payload)); },
    close() { oldClosed++; },
  };

  assert.equal(h.window.resumeSessionForeground(), true);
  assert.equal(oldClosed, 0);
  assert.equal(sockets.length, 0);
  assert.deepEqual(
    existingSent.slice(0, 2).map((message) => message.action),
    ['subscribe', 'reveal_permission'],
  );

  h.window.disconnectWs();
  assert.equal(oldClosed, 1);
  h.state.appState.session = 'codex:foreground-ws';
  h.window.startWs('codex:foreground-ws');
  assert.equal(sockets.length, 1);
  assert.equal(h.state.ws, sockets[0]);

  sockets[0].readyState = FakeWebSocket.OPEN;
  sockets[0].onopen();
  assert.deepEqual(
    sockets[0].sent.slice(0, 2).map((message) => message.action),
    ['subscribe', 'reveal_permission'],
  );

  let scheduledReconnect = null;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (callback, delay, ...args) {
    if (delay === 3000) {
      scheduledReconnect = () => callback(...args);
      return 1;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  sockets[0].readyState = FakeWebSocket.CLOSED;
  sockets[0].onclose();
  globalThis.setTimeout = realSetTimeout;
  assert.ok(scheduledReconnect);
  scheduledReconnect();
  assert.equal(sockets.length, 2);

  sockets[1].readyState = FakeWebSocket.OPEN;
  sockets[1].onopen();
  h.window.disconnectWs();
  assert.equal(sockets[1].closeCount, 1);
  assert.equal(h.state.ws, null);

  h.state.appState.session = 'codex:reentered';
  h.window.startWs('codex:reentered');
  assert.equal(sockets.length, 3);
  assert.equal(h.state.ws, sockets[2]);

  h.window.disconnectWs();
  h.window.close();
});
