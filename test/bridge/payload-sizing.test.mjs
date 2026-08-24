import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateToBytes } from '../../bridge/extract.mjs';
import { LiveTurnStream } from '../../bridge/live-turn-stream.mjs';
import { fitWsPayload, prepareWsPayload } from '../../bridge/ws.mjs';

function toolMessage(input, output) {
  return {
    uuid: 'message-1',
    nativeId: 'native-1',
    type: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: input },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: output,
      },
    ],
  };
}

test('messages within the byte budget keep complete tool IN and OUT', () => {
  const input = `start-${'i'.repeat(3000)}-end`;
  const output = `start-${'o'.repeat(6000)}-end`;
  const message = toolMessage(input, output);

  assert.equal(truncateToBytes(message, 360_000), message);
  assert.equal(message.content[0].input.command, input);
  assert.equal(message.content[1].content, output);
});

test('oversized messages compact tool IN and OUT before generic truncation', () => {
  const input = `input-head-${'i'.repeat(8000)}-input-tail`;
  const output = `output-head-${'o'.repeat(12_000)}-output-tail`;
  const compact = truncateToBytes(toolMessage(input, output), 7000);
  const compactInput = compact.content[0].input.command;
  const compactOutput = compact.content[1].content;

  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 7000);
  assert.ok(compactInput.startsWith(input.slice(0, 1000)));
  assert.ok(compactInput.endsWith(input.slice(-1000)));
  assert.match(compactInput, /…\[truncated\]…/);
  assert.ok(compactOutput.startsWith(output.slice(0, 1500)));
  assert.ok(compactOutput.endsWith(output.slice(-2500)));
  assert.match(compactOutput, /…\[truncated\]…/);
});

test('oversized messages events keep compact tool IN and OUT on the wire', () => {
  const input = `input-head-${'i'.repeat(8000)}-input-tail`;
  const output = `output-head-${'o'.repeat(12_000)}-output-tail`;
  const compact = fitWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-1',
    seq: 1,
    messages: [toolMessage(input, output)],
  }, 7000);

  assert.equal(compact.truncated, true);
  assert.equal(compact.messages.length, 1);
  assert.equal(compact.messages[0].uuid, 'message-1');
  assert.equal(compact.messages[0].nativeId, 'native-1');
  assert.match(compact.messages[0].content[0].input.command, /…\[truncated\]…/);
  assert.match(compact.messages[0].content[1].content, /…\[truncated\]…/);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 7000);
});

test('oversized turn events keep their seq and preserve compact messages', () => {
  const sent = [];
  const turn = new LiveTurnStream({
    sessionId: 'session-1',
    turnId: 'turn-1',
    send(event) {
      sent.push(fitWsPayload(event, 1000));
    },
  });
  const fullMessage = {
    uuid: 'message-1',
    nativeId: 'native-1',
    type: 'assistant',
    content: [{ type: 'text', text: 'x'.repeat(4000) }],
  };

  turn.sendAuthoritative(fullMessage, { noCache: true });
  turn.sendEnd();

  assert.deepEqual(sent.map((event) => [event.action, event.seq]), [
    ['stream_turn_start', 0],
    ['messages', 1],
    ['stream_end', 2],
  ]);
  assert.equal(sent[1].messages.length, 1);
  assert.equal(sent[1].messages[0].uuid, fullMessage.uuid);
  assert.equal(sent[1].messages[0].nativeId, fullMessage.nativeId);
  assert.match(sent[1].messages[0].content[0].text, /truncated/);
  assert.equal(sent[1].truncated, true);
  assert.equal(sent[1].noCache, true);
  assert.equal(sent[2].messages, undefined);
  assert.equal(sent[2].recoveryRequired, undefined);
  assert.ok(sent.every((event) =>
    Buffer.byteLength(JSON.stringify(event)) <= 1000));
});

test('messages fall back to an empty placeholder only when structure cannot fit', () => {
  const compact = fitWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-1',
    seq: 1,
    messages: [{
      uuid: 'message-1',
      nativeId: 'native-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, 120);

  assert.deepEqual(compact.messages, []);
  assert.equal(compact.truncated, true);
});

test('only an empty messages placeholder marks its turn for REST recovery', () => {
  const recoveryTurns = new Set();
  const compactMessage = prepareWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-compact',
    seq: 1,
    messages: [{
      uuid: 'message-compact',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, recoveryTurns, 1000);
  assert.equal(compactMessage.messages.length, 1);
  assert.equal(recoveryTurns.has('turn-compact'), false);

  const compactEnd = prepareWsPayload({
    action: 'stream_end',
    sessionId: 'session-1',
    turnId: 'turn-compact',
    seq: 2,
    messages: [{
      uuid: 'message-compact',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, recoveryTurns, 1000);
  assert.equal(compactEnd.messages, undefined);
  assert.equal(compactEnd.recoveryRequired, undefined);

  const emptyMessage = prepareWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-empty',
    seq: 1,
    messages: [{
      uuid: 'message-empty',
      nativeId: 'native-empty',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, recoveryTurns, 120);
  assert.deepEqual(emptyMessage.messages, []);
  assert.equal(recoveryTurns.has('turn-empty'), true);

  const recoveryEnd = prepareWsPayload({
    action: 'stream_end',
    sessionId: 'session-1',
    turnId: 'turn-empty',
    seq: 2,
    messages: [{
      uuid: 'message-empty',
      nativeId: 'native-empty',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, recoveryTurns, 120);
  assert.equal(recoveryEnd.messages, undefined);
  assert.equal(recoveryEnd.recoveryRequired, true);
});
