import assert from 'node:assert/strict';
import test from 'node:test';
import {
  creatableRuntimes,
  newSessionRuntimePreferenceKey,
  nextNewSessionRuntime,
  preferredNewSessionRuntime,
} from '../../web/js/new-session-runtime.js';
import { makeHarness } from './harness.mjs';

test('new sessions always expose both supported runtimes', () => {
  const runtimes = creatableRuntimes({
    claude: { canCreate: false },
    codex: { canCreate: true },
  });
  assert.deepEqual(runtimes, ['claude', 'codex']);
  assert.equal(preferredNewSessionRuntime(runtimes, 'claude'), 'claude');
  assert.equal(nextNewSessionRuntime(runtimes, 'codex'), 'claude');
});

test('multiple runtimes prefer the last valid per-device choice and cycle', () => {
  const runtimes = creatableRuntimes({
    claude: { canCreate: true },
    codex: { canCreate: true },
  });
  assert.deepEqual(runtimes, ['claude', 'codex']);
  assert.equal(preferredNewSessionRuntime(runtimes, 'codex'), 'codex');
  assert.equal(preferredNewSessionRuntime(runtimes, 'other'), 'claude');
  assert.equal(nextNewSessionRuntime(runtimes, 'claude'), 'codex');
  assert.equal(nextNewSessionRuntime(runtimes, 'codex'), 'claude');
  assert.equal(
    newSessionRuntimePreferenceKey('MacBook-Pro'),
    'apeek_new_session_runtime:MacBook-Pro',
  );
});

test('new Codex session sends the selected runtime to the Bridge', async () => {
  const harness = await makeHarness();
  const sent = [];
  harness.state.ws = {
    readyState: WebSocket.OPEN,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
  harness.state.appState = {
    device: 'MacBook-Pro',
    project: { hash: '-workspace-project' },
    session: '__new__',
    runtime: 'codex',
  };
  harness.state.wsProjectHash = '-workspace-project';
  harness.state.wsRequestId = null;

  harness.window.doSend('hello', 'hello', []);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'send_message');
  assert.equal(sent[0].runtime, 'codex');
  assert.equal(sent[0].asAgent, false);
  assert.equal(sent[0].projectHash, '-workspace-project');
  assert.equal(typeof sent[0].requestId, 'string');
  assert.ok(sent[0].requestId.length > 0);
  assert.equal(sent[0].requestId, harness.state.wsRequestId);

  harness.window.doSend('first', 'first', []);
  harness.window.doSend('second', 'second', []);

  const messages = sent.filter((message) => (
    message.action === 'send_message'
  ));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].previousTurnId, '');
  assert.equal(messages[1].previousTurnId, messages[0].turnId);
  assert.equal(messages[2].previousTurnId, messages[1].turnId);
  for (const pending of harness.state.pendingSentMessages) {
    clearTimeout(pending.transportTimer);
  }
  harness.window.close();
});
