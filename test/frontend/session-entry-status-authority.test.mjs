import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function deferred() {
  var resolve;
  var promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function event(sessionId, turnId, seq, action) {
  return { action, sessionId, turnId, seq };
}

test('session entry chooses the newest status authority', async () => {
  const h = await makeHarness();
  var sessionId = 'status-authority';
  resetSession(h, { sessionId: sessionId });
  h.setApiResponse({ messages: [], status: 'running', hasMore: false });

  var result = await h.window.bufferAndFetch(sessionId, '');

  assert.equal(result.liveLifecycleChanged, false);
  assert.equal(
    h.window.resolveSessionRunningAfterFetch(result, [], 'claude'),
    true,
  );

  var turnId = 'turn-live-start';
  var request = deferred();
  h.setApiHandler(() => request.promise);

  var loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  h.hooks.handleWsMessage(
    event(sessionId, turnId, 0, 'stream_turn_start'),
  );
  request.resolve({ messages: [], status: 'completed', hasMore: false });
  result = await loading;

  assert.equal(result.liveLifecycleChanged, true);
  assert.equal(
    h.window.resolveSessionRunningAfterFetch(result, [], 'claude'),
    true,
  );
  h.hooks.handleWsMessage(
    event(sessionId, turnId, 1, 'stream_end'),
  );

  turnId = 'turn-live-end';
  request = deferred();
  h.setApiHandler(() => request.promise);

  loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  h.hooks.handleWsMessage(
    event(sessionId, turnId, 0, 'stream_turn_start'),
  );
  h.hooks.handleWsMessage(
    event(sessionId, turnId, 1, 'stream_end'),
  );
  request.resolve({ messages: [], status: 'running', hasMore: false });
  result = await loading;

  assert.equal(result.liveLifecycleChanged, true);
  assert.equal(
    h.window.resolveSessionRunningAfterFetch(result, [], 'claude'),
    false,
  );

  assert.equal(
    h.window.resolveSessionRunningAfterFetch({
      status: 'running',
      liveLifecycleChanged: false,
    }, [{
      type: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
    }], 'codex'),
    false,
    'terminal REST history overrides a stale running status',
  );
  assert.equal(
    h.window.resolveSessionRunningAfterFetch({
      status: 'running',
      liveLifecycleChanged: false,
    }, [
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'previous answer' }],
        stopReason: 'end_turn',
      },
      {
        type: 'user',
        content: 'new prompt',
      },
    ], 'codex'),
    true,
    'a later user prompt keeps the authoritative running status',
  );

  h.state.pendingSentMessages = [{
    id: 'queued-turn',
    failed: false,
    sessionId,
  }];
  assert.equal(
    h.window.resolveSessionRunningAfterFetch({
      status: 'completed',
      liveLifecycleChanged: false,
    }, [], 'codex'),
    false,
    'completed REST status settles the spinner even with a local queued turn',
  );
});
