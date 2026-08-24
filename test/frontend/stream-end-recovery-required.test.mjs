import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('compact stream_end stops ordered and gapped turns with REST recovery', async () => {
  const h = await makeHarness();
  var sessionId = 'codex:compact-end';
  var turnId = 'turn-compact-end';
  let requests = 0;
  resetSession(h, { sessionId });
  h.setApiHandler(async () => {
    requests++;
    return {
      messages: [],
      hasMore: false,
      status: 'completed',
    };
  });

  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    turnId,
    seq: 1,
    messages: [],
    truncated: true,
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 2,
    recoveryRequired: true,
  });

  assert.equal(h.state.wsRunning, false);
  await h.tick(250);
  assert.equal(requests, 1);
  assert.equal(h.state.wsRunning, false);

  turnId = 'turn-gapped-compact-end';
  requests = 0;
  resetSession(h, { sessionId });
  h.setApiHandler(async () => {
    requests++;
    return {
      messages: [],
      hasMore: false,
      status: 'completed',
    };
  });

  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 1,
    kind: 'text',
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 3,
    recoveryRequired: true,
  });

  assert.equal(h.state.wsRunning, true);
  await h.tick(20);
  assert.equal(h.state.wsRunning, true);
  await h.tick(60);
  assert.equal(h.state.wsRunning, false);
  await h.tick(180);
  assert.equal(requests, 1);
  assert.equal(h.state.wsRunning, false);

  turnId = 'turn-reordered-compact-end';
  requests = 0;
  resetSession(h, { sessionId });
  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 1,
    kind: 'text',
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 3,
    recoveryRequired: true,
  });
  assert.equal(h.state.wsRunning, true);
  h.hooks.handleWsMessage({
    action: 'stream_block_stop',
    sessionId,
    turnId,
    seq: 2,
  });
  assert.equal(h.state.wsRunning, false);
  await h.tick(200);
  assert.equal(requests, 1);
  h.window.close();
});
