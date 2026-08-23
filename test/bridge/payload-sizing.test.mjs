import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateToBytes } from '../../bridge/extract.mjs';
import { LiveTurnStream } from '../../bridge/live-turn-stream.mjs';
import { fitWsPayload } from '../../bridge/ws.mjs';

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

test('oversized turn events keep their seq and send compact placeholders', () => {
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
  assert.deepEqual(sent[1].messages, []);
  assert.equal(sent[1].truncated, true);
  assert.equal(sent[1].noCache, true);
  assert.equal(sent[2].messages, undefined);
  assert.equal(sent[2].recoveryRequired, true);
  assert.ok(sent.every((event) =>
    Buffer.byteLength(JSON.stringify(event)) <= 1000));
});
