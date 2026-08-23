import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTurnEventEnvelope,
  isPromptUserMessage,
  LiveTurnStream,
  OPTIONAL_TURN_EVENT_ACTIONS,
  prepareAuthoritativeMessage,
  shouldCreateFinalInterrupt,
  STREAM_EVENT_ACTIONS,
  userMessageUuidForTurnId,
} from '../../bridge/live-turn-stream.mjs';

function createTurn() {
  const sent = [];
  return {
    sent,
    turn: new LiveTurnStream({
      sessionId: 'session-1',
      turnId: 'turn-1',
      send: (event) => sent.push(event),
    }),
  };
}

test('every shared turn event receives one contiguous seq', () => {
  const { turn, sent } = createTurn();
  turn.sendBlockStart({ blockId: 4, kind: 'text' });
  turn.sendDelta({ blockId: 4, chunk: 'hello' });
  turn.sendBlockStop({ blockId: 4 });
  turn.emit('permission_request', { requestId: 'permission-1' });
  turn.emit('permission_resolved', { requestId: 'permission-1' });
  turn.sendAuthoritative({
    uuid: 'message-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  });
  turn.sendEnd();

  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'stream_block_start',
    'stream_delta',
    'stream_block_stop',
    'permission_request',
    'permission_resolved',
    'messages',
    'stream_end',
  ]);
  assert.deepEqual(sent.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(sent.every((event) =>
    event.sessionId === 'session-1' && event.turnId === 'turn-1'));
});

test('a transient user message is realtime-only and keeps end authority canonical', () => {
  const sent = [];
  const turnId = 'sent-12345678-1234-4234-8234-123456789abc';
  const turn = new LiveTurnStream({
    sessionId: 'session-1',
    turnId,
    send: (event) => sent.push(event),
  });
  turn.sendTransientUser('run the command', '2026-08-18T00:00:00.000Z');
  turn.sendAuthoritative({
    uuid: 'assistant-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  });
  turn.sendEnd();

  assert.deepEqual(sent.map((event) => event.seq), [0, 1, 2, 3]);
  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'messages',
    'messages',
    'stream_end',
  ]);
  assert.equal(sent[1].noCache, true);
  assert.deepEqual(sent.at(-1).messages.map((message) => message.uuid), [
    'assistant-1',
  ]);
  assert.deepEqual(sent[1].messages[0], {
    uuid: '12345678-1234-4234-8234-123456789abc',
    nativeId: `live:user:${turnId}`,
    type: 'user',
    content: 'run the command',
    timestamp: '2026-08-18T00:00:00.000Z',
  });
});

test('user prompt identity is derived only from UUID turn ids', () => {
  assert.equal(
    userMessageUuidForTurnId('sent-12345678-1234-4234-8234-123456789abc'),
    '12345678-1234-4234-8234-123456789abc',
  );
  assert.equal(
    userMessageUuidForTurnId('12345678-1234-4234-8234-123456789abc'),
    '12345678-1234-4234-8234-123456789abc',
  );
  assert.equal(userMessageUuidForTurnId('turn-1'), '');
});

test('an interrupted end closes the block and emits one interrupt before stream_end', () => {
  const { turn, sent } = createTurn();
  turn.sendBlockStart({ blockId: 8, kind: 'text' });
  turn.sendDelta({ blockId: 8, chunk: 'partial' });
  turn.sendEnd({
    error: 'interrupted',
    interrupted: true,
    interruptedAt: '2026-08-18T14:02:00.000Z',
  });

  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'stream_block_start',
    'stream_delta',
    'stream_block_stop',
    'messages',
    'stream_end',
  ]);
  assert.deepEqual(sent.map((event) => event.seq), [0, 1, 2, 3, 4, 5]);
  assert.equal(sent[4].messages[0].content[0].text, '[Request interrupted by user]');
  assert.equal(sent[5].error, 'interrupted');
  assert.deepEqual(sent[5].messages, sent[4].messages);
});

test('an explicit interrupt is emitted once and remains in terminal authority', () => {
  const { turn, sent } = createTurn();
  turn.start();
  assert.equal(
    turn.sendInterrupt('2026-08-22T00:00:00.000Z').action,
    'messages',
  );
  assert.equal(turn.sendInterrupt('2026-08-22T00:00:01.000Z'), false);
  turn.sendEnd({ interrupted: true });

  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'messages',
    'stream_end',
  ]);
  assert.equal(sent.at(-1).messages.length, 1);
  assert.equal(
    sent.at(-1).messages[0].content[0].text,
    '[Request interrupted by user]',
  );
});

test('every runtime final interrupted status synthesizes interrupt authority', () => {
  assert.equal(
    shouldCreateFinalInterrupt('codex', { status: 'interrupted' }),
    true,
  );
  assert.equal(
    shouldCreateFinalInterrupt('codex', { subtype: 'interrupted' }),
    true,
  );
  assert.equal(
    shouldCreateFinalInterrupt('claude', { subtype: 'interrupted' }),
    true,
  );
  assert.equal(
    shouldCreateFinalInterrupt('codex', { subtype: 'error_during_execution' }),
    false,
  );
});

test('stream_end closes an unfinished block before terminating the turn', () => {
  const { turn, sent } = createTurn();
  turn.sendBlockStart({ blockId: 9, kind: 'text' });
  turn.sendDelta({ blockId: 9, chunk: 'partial' });
  turn.sendEnd({ error: 'error_during_execution' });

  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'stream_block_start',
    'stream_delta',
    'stream_block_stop',
    'stream_end',
  ]);
  assert.deepEqual(sent.map((event) => event.seq), [0, 1, 2, 3, 4]);
  assert.equal(sent.at(-1).error, 'error_during_execution');
  assert.equal(turn.sendDelta({ blockId: 9, chunk: 'late' }), false);
});

test('prompt user detection excludes tool results', () => {
  assert.equal(isPromptUserMessage({
    type: 'user',
    content: 'hello',
  }), true);
  assert.equal(isPromptUserMessage({
    type: 'user',
    content: [{ type: 'text', text: 'hello' }],
  }), true);
  assert.equal(isPromptUserMessage({
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
  }), false);
  assert.equal(isPromptUserMessage({
    type: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
  }), false);
});

test('wire events omit redundant identity and ordering fields', () => {
  const { turn, sent } = createTurn();
  turn.sendBlockStart({ blockId: 7, kind: 'tool_use', name: 'Bash' });
  turn.sendToolInput({ blockId: 7, chunk: '{"command":"pwd"}' });
  turn.sendBlockStop({ blockId: 7 });
  turn.sendEnd();

  for (const event of sent) {
    for (const field of [
      'streamId',
      'clientId',
      'bridgeEpoch',
      'turnSeq',
      'messageSeq',
      'finalSeq',
      'subscriptionEpoch',
      'blockIds',
    ]) {
      assert.equal(field in event, false, `${event.action} contains ${field}`);
    }
    if (event.action !== 'stream_turn_start') {
      assert.equal('blockId' in event, false);
    }
  }
});

test('payload cannot override the turn event identity or sequence', () => {
  const { turn, sent } = createTurn();
  turn.emit('permission_request', {
    action: 'stream_end',
    sessionId: 'wrong-session',
    turnId: 'wrong-turn',
    seq: 99,
    requestId: 'permission-1',
  });

  assert.deepEqual(sent.map((event) => ({
    action: event.action,
    sessionId: event.sessionId,
    turnId: event.turnId,
    seq: event.seq,
  })), [
    {
      action: 'stream_turn_start',
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 0,
    },
    {
      action: 'permission_request',
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 1,
    },
  ]);
});

test('events for the wrong runtime block are rejected', () => {
  const { turn, sent } = createTurn();
  turn.sendBlockStart({ blockId: 2, kind: 'text' });

  assert.equal(turn.sendDelta({ blockId: 3, chunk: 'wrong' }), false);
  assert.equal(turn.sendBlockStop({ blockId: 3 }), false);
  assert.equal(turn.sendDelta({ blockId: 2, chunk: 'right' }), true);
  assert.deepEqual(sent.filter((event) => event.action === 'stream_delta')
    .map((event) => event.chunk), ['right']);
});

test('stream_end is terminal and carries the complete deduplicated turn authority', () => {
  const { turn, sent } = createTurn();
  turn.start();
  turn.sendAuthoritative({
    uuid: 'message-1',
    nativeId: 'native-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'first' }],
  });
  turn.sendAuthoritative({
    uuid: 'message-1-copy',
    nativeId: 'native-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'first' }],
  });
  turn.sendAuthoritative({
    uuid: 'message-2',
    nativeId: 'native-2',
    type: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  });
  turn.sendEnd();
  const authority = turn.sendAuthoritative({
    uuid: 'message-3',
    type: 'assistant',
    content: [{ type: 'text', text: 'late' }],
  });

  assert.equal(authority, false);
  assert.equal(turn.emit('permission_resolved', { requestId: 'late' }), false);
  assert.deepEqual(sent.map((event) => event.action), [
    'stream_turn_start',
    'messages',
    'messages',
    'messages',
    'stream_end',
  ]);
  assert.deepEqual(
    sent.at(-1).messages.map((message) => message.nativeId),
    ['native-1', 'native-2'],
  );
});

test('stream_end preserves distinct tool use and result authority', () => {
  const { turn, sent } = createTurn();
  turn.start();
  turn.sendAuthoritative({
    uuid: 'tool-use-1',
    nativeId: 'native-tool-use-1',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  });
  turn.sendAuthoritative({
    uuid: 'tool-result-1',
    nativeId: 'native-tool-result-1',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: '/workspace',
      is_error: false,
    }],
  });
  turn.sendEnd();

  assert.deepEqual(
    sent.at(-1).messages.map((message) => message.uuid),
    ['tool-use-1', 'tool-result-1'],
  );
  assert.deepEqual(
    sent.map((event) => event.seq),
    [0, 1, 2, 3],
  );
});

test('a complete runtime turn uses one sequence for user, IN, OUT, text, and end', () => {
  const { turn, sent } = createTurn();
  turn.start();
  turn.sendAuthoritative({
    uuid: 'user-1',
    nativeId: 'native-user-1',
    type: 'user',
    content: 'run pwd',
  });
  turn.sendBlockStart({ blockId: 4, kind: 'tool_use', name: 'Bash' });
  turn.sendToolInput({ blockId: 4, chunk: '{"command":"pwd"}' });
  turn.sendBlockStop({ blockId: 4 });
  turn.sendAuthoritative({
    uuid: 'tool-use-1',
    nativeId: 'native-tool-use-1',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  });
  turn.sendAuthoritative({
    uuid: 'tool-result-1',
    nativeId: 'native-tool-result-1',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: '/workspace',
      is_error: false,
    }],
  });
  turn.sendBlockStart({ blockId: 5, kind: 'text' });
  turn.sendDelta({ blockId: 5, chunk: 'done' });
  turn.sendBlockStop({ blockId: 5 });
  turn.sendAuthoritative({
    uuid: 'assistant-1',
    nativeId: 'native-assistant-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  });
  turn.sendEnd();

  assert.deepEqual(
    sent.map((event) => event.seq),
    Array.from({ length: sent.length }, (_, index) => index),
  );
  assert.ok(sent.every((event) =>
    event.sessionId === 'session-1' && event.turnId === 'turn-1'));
  assert.deepEqual(
    sent.at(-1).messages.map((message) => message.uuid),
    ['user-1', 'tool-use-1', 'tool-result-1', 'assistant-1'],
  );
});

test('authoritative normalization is independent of sequence allocation', async () => {
  const message = await prepareAuthoritativeMessage({ raw: true }, {
    normalize: async () => ({
      uuid: 'message-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
    }),
  });
  assert.equal(message.uuid, 'message-1');
  assert.equal(await prepareAuthoritativeMessage({}, {
    normalize: async () => ({ type: 'assistant' }),
  }), null);
});

test('every active turn action requires one valid sequence envelope', () => {
  const actions = [
    ...STREAM_EVENT_ACTIONS,
    ...OPTIONAL_TURN_EVENT_ACTIONS,
  ];
  for (const action of actions) {
    const valid = {
      action,
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 0,
    };
    assert.equal(assertTurnEventEnvelope(valid), valid);
    assert.throws(
      () => assertTurnEventEnvelope({ ...valid, turnId: '' }),
      /turnId/,
    );
    assert.throws(
      () => assertTurnEventEnvelope({ ...valid, seq: undefined }),
      /seq/,
    );
    assert.throws(
      () => assertTurnEventEnvelope({ ...valid, seq: -1 }),
      /seq/,
    );
    assert.throws(
      () => assertTurnEventEnvelope({ ...valid, seq: 1.5 }),
      /seq/,
    );
  }
});

test('connection-only and standalone events do not require turn sequence', () => {
  for (const action of [
    'send_message_result',
    'messages_ack',
    'heartbeat',
    'messages',
    'permission_request',
    'permission_resolved',
  ]) {
    const event = { action, sessionId: 'session-1' };
    assert.equal(assertTurnEventEnvelope(event), event);
  }
});

test('a repeated live permission request remains in the shared turn sequence', () => {
  const events = [];
  const turn = new LiveTurnStream({
    sessionId: 'session-1',
    turnId: 'turn-1',
    send: (event) => events.push(event),
  });

  turn.start();
  turn.emit('permission_request', { requestId: 'approval-1' });
  turn.emit('permission_request', { requestId: 'approval-1' });
  turn.emit('permission_resolved', { requestId: 'approval-1' });

  assert.deepEqual(
    events.map((event) => [event.action, event.seq]),
    [
      ['stream_turn_start', 0],
      ['permission_request', 1],
      ['permission_request', 2],
      ['permission_resolved', 3],
    ],
  );
});
