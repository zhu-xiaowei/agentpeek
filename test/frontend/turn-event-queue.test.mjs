import assert from 'node:assert/strict';
import test from 'node:test';

import { TurnEventQueue } from '../../web/js/streaming.js';

function event(seq, action = 'stream_delta', turnId = 'turn-1') {
  return {
    action,
    sessionId: 'session-1',
    turnId,
    seq,
    ...(action === 'stream_delta' ? { chunk: String(seq) } : {}),
  };
}

function permutations(values) {
  if (values.length < 2) return [values.slice()];
  var result = [];
  for (var index = 0; index < values.length; index++) {
    var rest = values.slice(0, index).concat(values.slice(index + 1));
    for (var suffix of permutations(rest)) {
      result.push([values[index]].concat(suffix));
    }
  }
  return result;
}

test('all 720 permutations of a complete turn consume exactly once in seq order', () => {
  const actions = [
    'stream_turn_start',
    'stream_block_start',
    'stream_delta',
    'messages',
    'stream_block_stop',
    'stream_end',
  ];
  for (var order of permutations([0, 1, 2, 3, 4, 5])) {
    var queue = new TurnEventQueue();
    var consumed = [];
    for (var seq of order) {
      consumed.push(...queue.push(event(seq, actions[seq])));
    }
    assert.deepEqual(
      consumed.map((item) => item.seq),
      [0, 1, 2, 3, 4, 5],
      'arrival order ' + order.join(','),
    );
  }
});

test('stop, authority, and end cannot cross a missing delta', () => {
  var queue = new TurnEventQueue();
  var consumed = [];
  consumed.push(...queue.push(event(0, 'stream_turn_start')));
  consumed.push(...queue.push(event(4, 'stream_end')));
  consumed.push(...queue.push(event(3, 'messages')));
  consumed.push(...queue.push(event(2, 'stream_block_stop')));

  assert.deepEqual(consumed.map((item) => item.seq), [0]);

  consumed.push(...queue.push(event(1)));
  assert.deepEqual(consumed.map((item) => item.seq), [0, 1, 2, 3, 4]);
});

test('identical duplicates are idempotent before and after consumption', () => {
  var queue = new TurnEventQueue();
  var delayed = event(1);

  assert.deepEqual(queue.push(delayed), []);
  assert.deepEqual(queue.push({ ...delayed }), []);
  assert.deepEqual(queue.push(event(0)).map((item) => item.seq), [0, 1]);
  assert.deepEqual(queue.push(event(0)), []);
  assert.deepEqual(queue.push(event(1)), []);
});

test('conflicting duplicate seq is a protocol error', () => {
  var queue = new TurnEventQueue();
  queue.push(event(1));

  assert.throws(
    () => queue.push({ ...event(1), chunk: 'different' }),
    /conflicting event/,
  );

  queue.push(event(0));
  assert.throws(
    () => queue.push({ ...event(0), action: 'stream_end' }),
    /conflicting event/,
  );
});

test('random duplicate-heavy delivery never changes the consumed sequence', () => {
  var seed = 0x12345678;
  function random() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
  for (var run = 0; run < 500; run++) {
    var arrivals = [];
    for (var seq = 0; seq < 12; seq++) {
      arrivals.push(event(seq));
      if (random() < 0.5) arrivals.push(event(seq));
    }
    for (var i = arrivals.length - 1; i > 0; i--) {
      var swap = Math.floor(random() * (i + 1));
      [arrivals[i], arrivals[swap]] = [arrivals[swap], arrivals[i]];
    }
    var queue = new TurnEventQueue();
    var consumed = [];
    for (var arrival of arrivals) consumed.push(...queue.push(arrival));
    assert.deepEqual(
      consumed.map((item) => item.seq),
      Array.from({ length: 12 }, (_, index) => index),
    );
  }
});

test('different turns maintain independent contiguous queues', () => {
  var queue = new TurnEventQueue();
  var consumed = [];

  consumed.push(...queue.push(event(1, 'stream_delta', 'turn-a')));
  consumed.push(...queue.push(event(0, 'stream_turn_start', 'turn-b')));
  consumed.push(...queue.push(event(1, 'stream_end', 'turn-b')));
  consumed.push(...queue.push(event(0, 'stream_turn_start', 'turn-a')));

  assert.deepEqual(
    consumed.map((item) => [item.turnId, item.seq]),
    [
      ['turn-b', 0],
      ['turn-b', 1],
      ['turn-a', 0],
      ['turn-a', 1],
    ],
  );
});

test('restarting one turn abandons its old gap and accepts a new checkpoint', () => {
  var queue = new TurnEventQueue();
  assert.deepEqual(queue.push(event(0, 'stream_turn_start')).map((item) => item.seq), [0]);
  assert.deepEqual(queue.push(event(1)).map((item) => item.seq), [1]);
  assert.deepEqual(queue.push(event(3)).map((item) => item.seq), []);

  assert.equal(queue.restartTurn('turn-1'), true);
  assert.deepEqual(queue.push(event(8)).map((item) => item.seq), []);
  assert.deepEqual(queue.push(event(9, 'stream_block_start')).map((item) => item.seq), []);

  var resumed = queue.resumeAtNextCheckpoint('turn-1');
  assert.deepEqual(
    resumed.events.map((item) => [item.action, item.seq]),
    [
      ['stream_turn_start', 0],
      ['stream_block_start', 9],
    ],
  );
});

test('seq 1 messages synthesize the payload-free turn start and continue streaming', () => {
  var queue = new TurnEventQueue();
  var consumed = queue.push({
    ...event(1, 'messages'),
    messages: [{
      uuid: 'user-1',
      type: 'user',
      content: 'question',
    }],
  });

  assert.deepEqual(
    consumed.map((item) => [item.action, item.seq]),
    [
      ['stream_turn_start', 0],
      ['messages', 1],
    ],
  );
  assert.deepEqual(
    queue.push(event(2, 'stream_block_start')).map((item) => item.seq),
    [2],
  );
  assert.deepEqual(queue.push(event(0, 'stream_turn_start')), []);
});

test('a turn that reaches end without seq 0 or 1 completes as late join', () => {
  var queue = new TurnEventQueue();
  queue.push({
    ...event(4, 'messages'),
    messages: [{
      uuid: 'assistant-history',
      nativeId: 'codex:item:answer-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    }],
  });
  queue.push(event(3, 'stream_delta'));
  queue.push({
    ...event(5, 'stream_end'),
    messages: [{
      uuid: 'assistant-live',
      nativeId: 'codex:item:answer-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    }],
  });
  assert.equal(queue.completeLateJoin('turn-1'), true);

  assert.deepEqual(queue.takeLateJoinCompletions(), [{
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: [{
      uuid: 'assistant-history',
      nativeId: 'codex:item:answer-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    }],
    end: {
      ...event(5, 'stream_end'),
      messages: [{
        uuid: 'assistant-live',
        nativeId: 'codex:item:answer-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'complete answer' }],
      }],
    },
  }]);
  assert.deepEqual(queue.push(event(0, 'stream_turn_start')), []);
});

test('a compact stream_end closes a normally started turn across a seq gap', () => {
  var queue = new TurnEventQueue();
  assert.deepEqual(
    queue.push(event(0, 'stream_turn_start')).map((item) => item.seq),
    [0],
  );
  assert.deepEqual(
    queue.push(event(1, 'stream_block_start')).map((item) => item.seq),
    [1],
  );
  assert.deepEqual(queue.push({
    ...event(3, 'stream_end'),
    recoveryRequired: true,
  }), []);
  assert.equal(queue.isGappedEndCandidate('turn-1'), true);
  assert.equal(queue.completeGappedEnd('turn-1'), true);
  assert.deepEqual(queue.takeLateJoinCompletions(), [{
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: [],
    end: {
      ...event(3, 'stream_end'),
      recoveryRequired: true,
    },
    gapped: true,
    missingSeq: 2,
  }]);
  assert.deepEqual(queue.push(event(2, 'stream_delta')), []);
});

test('late join skips an incomplete node and resumes at the next block start', () => {
  var queue = new TurnEventQueue();
  queue.push(event(3, 'stream_delta'));
  queue.push(event(4, 'stream_block_stop'));
  queue.push({
    ...event(5, 'messages'),
    messages: [{
      uuid: 'node-a',
      nativeId: 'codex:item:node-a',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete node A' }],
    }],
  });
  queue.push(event(6, 'stream_block_start'));
  queue.push(event(7, 'stream_delta'));

  assert.equal(queue.isResumeCandidate('turn-1'), true);
  var recovery = queue.resumeAtNextCheckpoint('turn-1');
  assert.deepEqual(
    recovery.events.map((item) => [item.action, item.seq]),
    [
      ['stream_turn_start', 0],
      ['stream_block_start', 6],
      ['stream_delta', 7],
    ],
  );
  assert.deepEqual(
    recovery.messages.map((message) => message.nativeId),
    ['codex:item:node-a'],
  );
});

test('late join resumes at a sequenced permission checkpoint', () => {
  var queue = new TurnEventQueue();
  queue.push({
    ...event(12, 'permission_request'),
    requestId: 'approval-1',
    toolName: 'Bash',
  });

  assert.equal(queue.isResumeCandidate('turn-1'), true);
  var recovery = queue.resumeAtNextCheckpoint('turn-1');
  assert.deepEqual(
    recovery.events.map((item) => [item.action, item.seq]),
    [
      ['stream_turn_start', 0],
      ['permission_request', 12],
    ],
  );

  assert.deepEqual(
    queue.push({
      ...event(13, 'permission_resolved'),
      requestId: 'approval-1',
    }).map((item) => [item.action, item.seq]),
    [['permission_resolved', 13]],
  );
  assert.deepEqual(
    queue.push(event(14, 'stream_block_start'))
      .map((item) => [item.action, item.seq]),
    [['stream_block_start', 14]],
  );
});

test('authority delayed behind a resumed block is still returned for history merge', () => {
  var queue = new TurnEventQueue();
  queue.push(event(8, 'stream_block_start'));
  var recovery = queue.resumeAtNextCheckpoint('turn-1');
  assert.deepEqual(
    recovery.events.map((item) => item.seq),
    [0, 8],
  );

  assert.deepEqual(queue.push({
    ...event(7, 'messages'),
    messages: [{
      uuid: 'node-before-resume',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete earlier node' }],
    }],
  }), []);
  assert.deepEqual(
    queue.takeLateJoinUpdates().flatMap((update) => update.messages)
      .map((message) => message.uuid),
    ['node-before-resume'],
  );
});

test('a normally started turn never skips a transport gap at a later block', () => {
  var queue = new TurnEventQueue();
  queue.push(event(0, 'stream_turn_start'));
  queue.push(event(1, 'stream_block_start'));
  queue.push(event(4, 'stream_block_start'));

  assert.equal(queue.isResumeCandidate('turn-1'), false);
  assert.equal(queue.resumeAtNextCheckpoint('turn-1'), null);
});

test('closing a completed turn releases buffered frames and rejects delayed duplicates', () => {
  var queue = new TurnEventQueue();
  assert.deepEqual(
    queue.push(event(0, 'stream_turn_start')).map((item) => item.seq),
    [0],
  );
  assert.deepEqual(
    queue.push(event(1, 'stream_end')).map((item) => item.seq),
    [1],
  );

  assert.equal(queue.closeTurn('turn-1'), true);
  assert.deepEqual(queue.push(event(0, 'stream_turn_start')), []);
  assert.deepEqual(queue.push(event(1, 'stream_end')), []);
});
