import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function text(uuid, nativeId, value, timestamp) {
  return {
    uuid,
    nativeId,
    type: 'assistant',
    content: [{ type: 'text', text: value }],
    timestamp,
  };
}

function user(uuid, nativeId, value, timestamp) {
  return {
    uuid,
    nativeId,
    type: 'user',
    content: value,
    timestamp,
  };
}

function toolPair(suffix, output) {
  const toolId = 'tool-' + suffix;
  return [{
    uuid: 'tool-use-' + suffix,
    nativeId: 'native:tool-use-' + suffix,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolId,
      name: 'Bash',
      input: { command: 'echo ' + suffix },
    }],
    timestamp: '2026-08-24T04:00:01.000Z',
    stopReason: 'tool_use',
  }, {
    uuid: 'tool-result-' + suffix,
    nativeId: 'native:tool-result-' + suffix,
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolId,
      content: output,
      is_error: false,
    }],
    timestamp: '2026-08-24T04:00:02.000Z',
  }];
}

test('completed REST recovery replaces the overlapping tail in response order', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:rest-authoritative-order';
  resetSession(h, { sessionId });
  h.state.appState.runtime = 'codex';

  const older = text('older', 'native:older', 'older', '2026-08-24T01:00:00.000Z');
  const overlap = text('overlap', 'native:overlap', 'overlap', '2026-08-24T01:00:01.000Z');
  const final = text('final', 'native:final', 'final', '2026-08-24T01:00:03.000Z');
  const misplaced = text(
    'misplaced',
    'native:misplaced',
    'misplaced',
    '2026-08-24T01:00:02.000Z',
  );
  h.state.wsAllMessages = [older, overlap, final, misplaced];
  h.state.wsMessageUuids = new Set([
    'older', 'native:native:older',
    'overlap', 'native:native:overlap',
    'final', 'native:native:final',
    'misplaced', 'native:native:misplaced',
  ]);
  h.state.wsMessageCount = h.state.wsAllMessages.length;
  h.state.wsRenderedCount = h.state.wsAllMessages.length;
  const container = h.document.querySelector('.messages');
  container.innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    h.state.appState.runtime,
  );
  const olderNode = container.children[0];
  const overlapNode = container.children[1];
  const finalNode = container.children[2];

  const middle = text('middle', 'native:middle', 'middle', '2026-08-24T01:00:02.000Z');
  h.setApiResponse({
    messages: [overlap, middle, final],
    hasMore: false,
    status: 'completed',
  });

  const result = await h.window.recoverMissing('', { authoritative: true });

  assert.equal(result.authoritative, true);
  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['older', 'overlap', 'middle', 'final'],
  );
  const rendered = h.document.querySelector('.messages').textContent;
  assert.ok(rendered.indexOf('older') < rendered.indexOf('overlap'));
  assert.ok(rendered.indexOf('overlap') < rendered.indexOf('middle'));
  assert.ok(rendered.indexOf('middle') < rendered.indexOf('final'));
  assert.equal(rendered.includes('misplaced'), false);
  assert.equal(container.children[0], olderNode);
  assert.equal(container.children[1], overlapNode);
  assert.equal(container.children[3], finalNode);

  const noOverlapSessionId = 'codex:rest-authoritative-no-overlap';
  resetSession(h, { sessionId: noOverlapSessionId });
  h.state.appState.runtime = 'codex';

  const olderOnly = text('older-only', 'native:older-only', 'older only', '2026-08-24T01:00:00.000Z');
  h.state.wsAllMessages = [olderOnly];
  h.state.wsMessageUuids = new Set(['older-only', 'native:native:older-only']);
  h.state.wsMessageCount = 1;
  h.state.wsRenderedCount = 1;
  container.innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    h.state.appState.runtime,
  );
  const olderOnlyNode = container.children[0];

  const newerOnly = text('newer-only', 'native:newer-only', 'newer only', '2026-08-24T02:00:00.000Z');
  h.setApiResponse({
    messages: [newerOnly],
    hasMore: true,
    status: 'completed',
  });

  await h.window.recoverMissing('', { authoritative: true });

  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['older-only', 'newer-only'],
  );
  assert.equal(container.children[0], olderOnlyNode);

  const firstPrompt = user(
    'first-prompt',
    'native:first-prompt',
    'first prompt',
    '2026-08-24T03:00:00.000Z',
  );
  const firstAnswer = text(
    'first-answer',
    'native:first-answer',
    'keep local first answer',
    '2026-08-24T03:00:01.000Z',
  );
  const lastPrompt = user(
    'last-prompt',
    'native:last-prompt',
    'last prompt',
    '2026-08-24T03:00:02.000Z',
  );
  const staleLastAnswer = text(
    'last-answer',
    'native:last-answer',
    'stale last answer',
    '2026-08-24T03:00:03.000Z',
  );
  resetSession(h, { sessionId: 'codex:rest-last-turn-only' });
  h.state.appState.runtime = 'codex';
  h.state.wsAllMessages = [
    firstPrompt,
    firstAnswer,
    lastPrompt,
    staleLastAnswer,
  ];
  h.state.wsMessageUuids = new Set([
    'first-prompt', 'native:native:first-prompt',
    'first-answer', 'native:native:first-answer',
    'last-prompt', 'native:native:last-prompt',
    'last-answer', 'native:native:last-answer',
  ]);
  h.state.wsMessageCount = h.state.wsAllMessages.length;
  h.state.wsRenderedCount = h.state.wsAllMessages.length;
  container.innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    h.state.appState.runtime,
  );
  const firstPromptNode = container.children[0];
  const firstAnswerNode = container.children[1];

  h.setApiResponse({
    messages: [
      firstPrompt,
      {
        ...firstAnswer,
        content: [{ type: 'text', text: 'REST changed older answer' }],
      },
      lastPrompt,
      {
        ...staleLastAnswer,
        content: [{ type: 'text', text: 'final last answer' }],
      },
    ],
    hasMore: false,
    status: 'completed',
  });

  await h.window.recoverMissing('', {
    authoritative: true,
    authoritativeScope: 'last-turn',
  });

  assert.equal(h.state.wsAllMessages[1].content[0].text, 'keep local first answer');
  assert.equal(h.state.wsAllMessages[3].content[0].text, 'final last answer');
  assert.equal(container.children[0], firstPromptNode);
  assert.equal(container.children[1], firstAnswerNode);

  const toolPrompt = user(
    'tool-prompt',
    'native:tool-prompt',
    'run tool',
    '2026-08-24T04:00:00.000Z',
  );
  const [toolUse, oldToolResult] = toolPair('state', 'old output');
  const renderToolHistory = (messages, _runtime, options = {}) => {
    const results = new Map();
    for (const message of messages) {
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block);
      }
    }
    return messages.map((message) => {
      if (message.type === 'user') {
        if (Array.isArray(message.content)
          && message.content.every((block) => block.type === 'tool_result')) {
          return '';
        }
        return '<div class="msg-user" data-ts="' + message.timestamp + '">'
          + message.content + '</div>';
      }
      if (message.type !== 'assistant') return '';
      return (Array.isArray(message.content) ? message.content : []).map((block) => {
        if (block.type !== 'tool_use') return '';
        const result = results.get(block.id);
        const collapsed = options.collapseToolDetails
          ? ' tool-details-collapsed' : '';
        return '<div class="assistant-turn"><div class="tl-item tool-node'
          + collapsed + '" data-tool-id="' + block.id
          + '" data-message-id="' + message.uuid
          + '" data-native-id="' + message.nativeId + '">'
          + '<div class="tool-header tool-details-toggle" aria-expanded="'
          + String(!options.collapseToolDetails) + '">Ran</div>'
          + '<div class="tool-body">IN ' + block.input.command
          + ' OUT ' + (result?.content || '') + '</div></div></div>';
      }).join('');
    }).join('');
  };
  globalThis.renderMessages = h.window.renderMessages = renderToolHistory;
  resetSession(h, { sessionId: 'codex:rest-tool-state' });
  h.state.appState.runtime = 'codex';
  h.state.wsAllMessages = [toolPrompt, toolUse, oldToolResult];
  h.state.wsMessageUuids = new Set([
    toolPrompt.uuid, 'native:' + toolPrompt.nativeId,
    toolUse.uuid, 'native:' + toolUse.nativeId,
    oldToolResult.uuid, 'native:' + oldToolResult.nativeId,
  ]);
  h.state.wsMessageCount = h.state.wsAllMessages.length;
  h.state.wsRenderedCount = h.state.wsAllMessages.length;
  container.innerHTML = h.window.renderMessages(
    h.state.wsAllMessages,
    h.state.appState.runtime,
    { collapseToolDetails: false },
  );
  const expandedTool = container.querySelector('[data-tool-id="tool-state"]');
  assert.equal(expandedTool.classList.contains('tool-details-collapsed'), false);

  const [, newToolResult] = toolPair('state', 'new output');
  h.setApiResponse({
    messages: [toolPrompt, toolUse, newToolResult],
    hasMore: false,
    status: 'completed',
  });
  await h.window.recoverMissing('', {
    authoritative: true,
    authoritativeScope: 'last-turn',
  });

  const recoveredExpandedTool = container.querySelector('[data-tool-id="tool-state"]');
  assert.match(recoveredExpandedTool.textContent, /new output/);
  assert.equal(
    recoveredExpandedTool.classList.contains('tool-details-collapsed'),
    false,
  );

  recoveredExpandedTool.classList.add('tool-details-collapsed');
  recoveredExpandedTool.querySelector('.tool-header')
    .setAttribute('aria-expanded', 'false');
  const [, newestToolResult] = toolPair('state', 'newest output');
  h.setApiResponse({
    messages: [toolPrompt, toolUse, newestToolResult],
    hasMore: false,
    status: 'completed',
  });
  await h.window.recoverMissing('', {
    authoritative: true,
    authoritativeScope: 'last-turn',
  });
  const recoveredCollapsedTool = container.querySelector('[data-tool-id="tool-state"]');
  assert.match(recoveredCollapsedTool.textContent, /newest output/);
  assert.equal(
    recoveredCollapsedTool.classList.contains('tool-details-collapsed'),
    true,
  );
});
