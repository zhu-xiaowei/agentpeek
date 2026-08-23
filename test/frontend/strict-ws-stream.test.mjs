import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const sessionId = 'codex:strict-turn';

function event(turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

test('strict WS integration uses one ordered queue for complete turns', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId });
  const turnId = 'turn-1';

  const events = [
    event(turnId, 0, 'stream_turn_start'),
    event(turnId, 1, 'messages', {
      messages: [{
        uuid: 'user-1',
        type: 'user',
        content: 'question',
      }],
    }),
    event(turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(turnId, 3, 'stream_delta', { chunk: 'abcdefghij' }),
    event(turnId, 4, 'stream_block_stop'),
    event(turnId, 5, 'stream_block_start', {
      kind: 'tool_use',
      name: 'Bash',
    }),
    event(turnId, 6, 'stream_tool_input', {
      chunk: '{"command":"pwd"}',
    }),
    event(turnId, 7, 'stream_block_stop'),
    event(turnId, 8, 'messages', {
      messages: [{
        uuid: 'assistant-1',
        type: 'assistant',
        content: [
          { type: 'text', text: 'abcdefghij' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      }],
    }),
    event(turnId, 9, 'stream_end'),
  ];

  // Authority and stop arrive before the missing deltas. Ordinary frames stay
  // ordered; the terminal event arrives only after the transport gap closes.
  for (const index of [0, 1, 2, 8, 7, 6, 5, 4, 3, 9]) {
    h.hooks.handleWsMessage(events[index]);
  }

  assert.ok(h.document.querySelector(
    `.msg-user[data-anchor="${turnId}"]`,
  ));
  const turn = h.document.querySelector(`[data-turn-id="${turnId}"]`);
  const textBlock = turn?.querySelector('[data-block-id="2"]');
  assert.ok(textBlock);
  assert.equal(
    turn.querySelector('[data-block-id="5"]'),
    null,
    'the later tool remains hidden until the text reveal completes',
  );

  await h.tick(50);
  const toolBlock = turn.querySelector('[data-block-id="5"]');
  assert.ok(toolBlock);
  assert.equal(toolBlock.dataset.toolId, 'tool-1');
  assert.equal(textBlock.textContent, 'abcdefghij');
  assert.equal(turn.textContent.split('abcdefghij').length - 1, 1);
  assert.equal(turn.classList.contains('stream-committed'), true);

  const first = [
    event('turn-a', 0, 'stream_turn_start'),
    event('turn-a', 1, 'stream_block_start', { kind: 'text' }),
    event('turn-a', 2, 'stream_delta', { chunk: 'first' }),
    event('turn-a', 3, 'stream_block_stop'),
    event('turn-a', 4, 'stream_end'),
  ];
  const second = [
    event('turn-b', 0, 'stream_turn_start'),
    event('turn-b', 1, 'stream_block_start', { kind: 'text' }),
    event('turn-b', 2, 'stream_delta', { chunk: 'second' }),
    event('turn-b', 3, 'stream_block_stop'),
    event('turn-b', 4, 'stream_end'),
  ];

  for (const item of [
    first[0], second[0], second[2], first[2], second[1],
    first[1], second[3], first[3], second[4], first[4],
  ]) {
    h.hooks.handleWsMessage(item);
  }

  await h.tick(60);
  const turns = [...h.document.querySelectorAll('[data-turn-id]')];
  assert.deepEqual(turns.slice(-2).map((node) => node.dataset.turnId), [
    'turn-a',
    'turn-b',
  ]);
  assert.equal(turns.at(-2).textContent, 'first');
  assert.equal(turns.at(-1).textContent, 'second');
  assert.equal(turns.at(-2).classList.contains('has-next-turn'), true);
  assert.equal(turns.at(-1).classList.contains('follows-turn'), true);
  assert.equal(turns.at(-1).classList.contains('has-next-turn'), false);
  assert.equal(h.state.wsRunning, false);

  const watcherSessionId = sessionId;
  const watcherTurnId = 'turn-unscoped-watcher';
  resetSession(h, { sessionId: watcherSessionId });
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="msg-user"'
    + ` data-anchor="${watcherTurnId}">prompt</div>`;
  const watcherEvent = (seq, action, extra = {}) => ({
    action,
    sessionId: watcherSessionId,
    turnId: watcherTurnId,
    seq,
    ...extra,
  });

  h.hooks.handleWsMessage(watcherEvent(0, 'stream_turn_start'));
  h.hooks.handleWsMessage(watcherEvent(
    1,
    'stream_block_start',
    { kind: 'text' },
  ));
  h.hooks.handleWsMessage(watcherEvent(
    2,
    'stream_delta',
    { chunk: 'answer' },
  ));
  await h.tick(10);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: watcherSessionId,
    messages: [{
      uuid: 'watcher-answer',
      nativeId: 'watcher:answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer complete' }],
      timestamp: '2026-08-22T00:00:00.000Z',
      stopReason: 'end_turn',
    }],
  });
  await h.tick(10);
  assert.equal(container.querySelectorAll('.assistant-turn').length, 1);

  h.hooks.handleWsMessage(watcherEvent(3, 'messages', {
    messages: [{
      uuid: 'strict-answer',
      nativeId: 'strict:answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer complete' }],
      timestamp: '2026-08-22T00:00:00.000Z',
      stopReason: 'end_turn',
    }],
  }));
  h.hooks.handleWsMessage(watcherEvent(4, 'stream_end'));
  await h.tick(80);

  assert.equal(container.querySelectorAll('.assistant-turn').length, 1);
  assert.equal(
    container.textContent.split('answer complete').length - 1,
    1,
  );
  h.window.close();
});
