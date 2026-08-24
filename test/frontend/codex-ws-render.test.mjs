import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><body>
  <div id="content"><div class="messages"></div></div>
  <div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>
</body>`, { url: 'https://test/', pretendToBeVisual: true });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.WebSocket = function WebSocket() {};
globalThis.WebSocket.CONNECTING = 0;
globalThis.WebSocket.OPEN = 1;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
window.__APEEK_TEST__ = true;
window.Element.prototype.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};

const expose = (name, value) => {
  globalThis[name] = value;
  window[name] = value;
};

expose('renderAssistantText', (text) => `<div>${text}</div>`);
expose('renderThinking', () => '');
expose('renderUserBubble', () => '');
expose('renderSystemEvent', () => '');
expose('renderSummary', () => '');
expose('renderInterrupt', () => '');
expose('renderLocalCommandStdout', () => '');
expose('isToolResultOnly', (message) => Array.isArray(message.content)
  && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result'));
expose('isInterruptMsg', () => false);
expose('isLocalCommandStdout', () => false);
let apiResponse = { messages: [], hasMore: false };
expose('api', async () => apiResponse);
for (const name of [
  'clampOverflow',
  'loadImages',
  'saveNav',
  'showStats',
  'updateBreadcrumb',
  'updateSendBtn',
]) expose(name, () => {});
expose('esc', (value) => String(value));
expose('wsSendReliable', () => {});

await import('../../web/js/components/message.js');
await import('../../web/js/runtime-status.js');
expose('deriveRunning', window.deriveRunning);
await import('../../web/js/components/tool.js');
expose('renderToolNode', window.renderToolNode);
await import('../../web/js/components/permission.js');
for (const name of [
  'dismissPermissionPrompt',
  'hasActivePermissionPrompt',
  'resolvePermissionPrompt',
  'showPermissionPrompt',
]) expose(name, window[name]);
await import('../../web/js/render.js');
expose('renderMessages', window.renderMessages);
expose('renderSingleMessage', window.renderSingleMessage);
const { state } = await import('../../web/js/state.js');
await import('../../web/js/components/typing-status.js');
expose('updateSpinner', window.updateSpinner);
await import('../../web/js/ws.js');

test.afterEach(() => {
  state.wsRunning = false;
  window.updateSpinner();
});

test('Claude and Codex share the same collapsing spinner row', () => {
  for (const runtime of ['claude', 'codex']) {
    reset();
    state.appState.runtime = runtime;
    state.wsRunning = true;
    window.updateSpinner();

    const visible = document.getElementById('cc-spinner');
    assert.equal(visible?.parentElement?.id, 'content');
    assert.equal(visible?.style.display, 'flex');
    assert.equal(visible?.classList.contains('is-collapsed'), false);

    state.wsRunning = false;
    window.updateSpinner();

    const hidden = document.getElementById('cc-spinner');
    assert.equal(hidden, visible);
    assert.equal(hidden?.style.display, 'flex');
    assert.equal(hidden?.classList.contains('is-collapsed'), true);
  }
});

test('spinner appears immediately and only animates while collapsing', () => {
  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const visibleRule = css.match(/\.cc-spinner\s*\{[^}]*\}/)?.[0] || '';
  const collapsedRule = css.match(/\.cc-spinner\.is-collapsed\s*\{[^}]*\}/)?.[0] || '';

  assert.match(visibleRule, /height:\s*32px/);
  assert.match(visibleRule, /transition:\s*none/);
  assert.match(collapsedRule, /height:\s*0/);
  assert.match(collapsedRule, /transition:\s*height 250ms ease-out/);
});

test('short output keeps the spinner visible for at least 500ms', async () => {
  reset();
  state.wsRunning = true;
  window.updateSpinner();

  document.querySelector('.messages').insertAdjacentHTML(
    'beforeend',
    '<div class="assistant-turn stream-preview"><div data-block-id="1">Hi</div></div>',
  );
  window.updateSpinner();
  window.markSpinnerTurnEnd();
  state.wsRunning = false;
  window.updateSpinner();

  const spinner = document.getElementById('cc-spinner');
  assert.equal(spinner?.classList.contains('is-collapsed'), false);
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(spinner?.classList.contains('is-collapsed'), true);
});

function reset() {
  window.dismissPermissionPrompt();
  document.querySelector('.messages').innerHTML = '';
  state.appState = {
    device: 'D',
    project: { hash: '-project' },
    session: 'codex:test',
    sessionPreview: '',
    runtime: 'codex',
  };
  state.wsSessionId = 'codex:test';
  state.wsAllMessages = [];
  state.wsMessageUuids = new Set();
  state.wsRenderedCount = 0;
  state.wsMessageCount = 0;
  state.wsRunning = true;
  state.wsLastTimestamp = '';
  state.pendingSentMessages = [];
  state._wsBuffer = null;
  state.stickBottom = false;
  apiResponse = { messages: [], hasMore: false };
}

test('unrelated tool results do not dismiss the active permission prompt', () => {
  reset();
  state.appState.runtime = 'claude';
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: state.wsSessionId,
    requestId: 'write-approval',
    kind: 'tool',
    toolName: 'Write',
    input: { file_path: 'src/pending.js' },
  });

  assert.equal(window.hasActivePermissionPrompt(), true);
  send([{
    uuid: 'unrelated-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'another-tool',
      content: 'completed',
    }],
    timestamp: '2026-08-21T09:45:00.000Z',
  }]);

  assert.equal(window.hasActivePermissionPrompt(), true);
  assert.ok(document.getElementById('permission-prompt'));

  window.__wsTest.handleWsMessage({
    action: 'permission_resolved',
    sessionId: state.wsSessionId,
    requestId: 'another-approval',
  });
  assert.equal(window.hasActivePermissionPrompt(), true);

  window.__wsTest.handleWsMessage({
    action: 'permission_resolved',
    sessionId: state.wsSessionId,
    requestId: 'write-approval',
  });
  assert.equal(window.hasActivePermissionPrompt(), false);
  assert.equal(document.getElementById('permission-prompt'), null);
});

function send(messages) {
  window.__wsTest.handleWsMessage({
    action: 'messages',
    sessionId: state.wsSessionId,
    messages,
  });
}

const validationErrorMessage = {
  uuid: 'validation-error',
  nativeId: 'codex:turn:turn-validation:error',
  type: 'assistant',
  content: [{
    type: 'text',
    text: "Error: invalid request body: Invalid 'input': value did not match any expected variant",
  }],
  timestamp: '2026-08-23T06:00:00.000Z',
  stopReason: 'end_turn',
};

test('realtime Codex validation errors render as visible assistant text', () => {
  reset();
  send([validationErrorMessage]);

  const rows = document.querySelectorAll('.assistant-text');
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].textContent.trim(),
    "Error: invalid request body: Invalid 'input': value did not match any expected variant",
  );
});

test('historical Codex validation errors render when entering the session', () => {
  reset();
  document.querySelector('.messages').innerHTML = window.renderMessages(
    [validationErrorMessage],
    'codex',
  );

  const rows = document.querySelectorAll('.assistant-text');
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].textContent.trim(),
    "Error: invalid request body: Invalid 'input': value did not match any expected variant",
  );
});

const tool = (uuid, id, command, timestamp) => ({
  uuid,
  type: 'assistant',
  content: [{
    type: 'tool_use',
    id,
    name: 'Bash',
    input: { command, codexCommandKind: 'ran' },
  }],
  timestamp,
});

const result = (uuid, id, content, timestamp, extra = {}) => ({
  uuid,
  type: 'user',
  content: [{
    type: 'tool_result',
    tool_use_id: id,
    content,
    ...extra,
  }],
  timestamp,
});

test('Codex WS keeps parallel Ran nodes in creation order', () => {
  reset();

  send([
    tool('date-use', 'date', 'date; check versions', '2026-08-10T03:00:01.000Z'),
    tool('tail-use', 'tail', 'tail bridge.log', '2026-08-10T03:00:02.000Z'),
    tool('git-use', 'git', 'git diff --stat; git diff --check', '2026-08-10T03:00:03.000Z'),
  ]);
  send([result('tail-end', 'tail', 'bridge ready', '2026-08-10T03:00:04.000Z', {
    codexCommandKind: 'ran',
  })]);
  send([result('git-end', 'git', 'clean', '2026-08-10T03:00:05.000Z', {
    codexCommandKind: 'ran',
  })]);
  send([result('date-end', 'date', 'all online', '2026-08-10T03:00:06.000Z', {
    codexCommandKind: 'ran',
  })]);

  const commandOrder = Array.from(document.querySelectorAll('.tool-desc'))
    .map((node) => node.textContent);
  assert.deepEqual(commandOrder, [
    'date; check versions',
    'tail bridge.log',
    'git diff --stat; git diff --check',
  ]);

  send([
    tool('sleep-use', 'sleep', 'sleep 35; check fleet', '2026-08-10T03:00:07.000Z'),
    result('sleep-running', 'sleep', 'Process running with session ID 300', '2026-08-10T03:00:08.000Z', {
      codexBackground: 'running',
      codexProcessId: '300',
    }),
  ]);
  assert.equal(document.querySelector('[data-tool-id="sleep"]'), null);

  const wait = (suffix, timestamp) => ({
    uuid: `wait-${suffix}`,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: `wait-${suffix}`,
      name: 'WriteStdin',
      input: {
        session_id: 300,
        chars: '',
        codexCommand: 'sleep 35; check fleet',
      },
    }],
    timestamp,
  });
  send([
    wait('one', '2026-08-10T03:00:09.000Z'),
    result('wait-one-result', 'wait-one', 'Process running with session ID 300', '2026-08-10T03:00:09.500Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check fleet',
    }),
  ]);
  send([
    wait('two', '2026-08-10T03:00:10.000Z'),
    result('wait-two-result', 'wait-two', 'Process running with session ID 300', '2026-08-10T03:00:10.500Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check fleet',
    }),
  ]);
  assert.equal(document.querySelectorAll('.codex-terminal-wait').length, 1);

  send([result('sleep-end', 'sleep', 'fleet checked', '2026-08-10T03:00:11.000Z', {
    codexBackground: 'complete',
    codexCommandKind: 'ran',
    codexProcessId: '300',
  })]);

  const finalNodes = Array.from(document.querySelectorAll('.tl-item'));
  const waitIndex = finalNodes.findIndex((node) => node.classList.contains('codex-terminal-wait'));
  const runIndex = finalNodes.findIndex((node) => node.dataset.toolId === 'sleep');
  assert.ok(waitIndex >= 0 && waitIndex < runIndex);
  assert.equal(document.querySelectorAll('[data-tool-id="sleep"]').length, 1);
  assert.equal(document.querySelector('[data-tool-id="sleep"] .tool-name').textContent, 'Ran');
});

test('Codex WS keeps mixed Ran and Explored blocks in creation order', () => {
  reset();

  send([
    tool('version-use', 'version', 'node check-version.mjs', '2026-08-10T04:31:52.683Z'),
    tool('scan-use', 'scan', 'aws dynamodb scan', '2026-08-10T04:31:52.928Z'),
    tool('local-use', 'local', 'printf local-version', '2026-08-10T04:31:53.097Z'),
    {
      uuid: 'search-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'search',
        name: 'Bash',
        input: {
          command: 'rg -n bridge_recovery_complete dist/assets/ws-*.js',
          codexCommandKind: 'explore',
          codexCommandActions: [{
            type: 'search',
            query: 'bridge_recovery_complete',
            path: 'ws-*.js',
          }],
        },
      }],
      timestamp: '2026-08-10T04:31:53.306Z',
    },
  ]);
  send([result('local-result', 'local', 'local version', '2026-08-10T04:31:53.296Z', {
    codexCommandKind: 'ran',
  })]);
  send([result('search-result', 'search', 'match', '2026-08-10T04:31:53.398Z', {
    codexCommandKind: 'explore',
  })]);
  send([result('scan-result', 'scan', 'four devices', '2026-08-10T04:31:54.244Z', {
    codexCommandKind: 'ran',
  })]);
  send([result('version-result', 'version', 'version 12', '2026-08-10T04:31:55.838Z', {
    codexCommandKind: 'ran',
  })]);

  assert.deepEqual(
    Array.from(document.querySelectorAll('.tool-desc')).map((node) => node.textContent),
    [
      'node check-version.mjs',
      'aws dynamodb scan',
      'printf local-version',
      'Search bridge_recovery_complete',
    ],
  );
  assert.deepEqual(
    Array.from(document.querySelectorAll('.tool-name')).map((node) => node.textContent),
    ['Ran', 'Ran', 'Ran', 'Explored'],
  );
});

test('Codex WS keeps historical detail state and expands new realtime tools', () => {
  reset();
  const historicalUse = tool(
    'history-use',
    'history',
    'npm test',
    '2026-08-10T05:40:00.000Z',
  );
  state.wsAllMessages = [historicalUse];
  state.wsMessageUuids = new Set([historicalUse.uuid]);
  state.wsRenderedCount = 1;
  state.wsMessageCount = 1;
  const container = document.querySelector('.messages');
  container.innerHTML = window.renderMessages(state.wsAllMessages, 'codex');
  window.markTurnAdjacency(container);
  assert.equal(
    container.querySelector('[data-tool-id="history"]')
      .classList.contains('tool-details-collapsed'),
    true,
  );

  send([result(
    'history-result',
    'history',
    'tests passed',
    '2026-08-10T05:40:01.000Z',
    { codexCommandKind: 'ran' },
  )]);
  const updated = container.querySelector('[data-tool-id="history"]');
  assert.equal(updated.classList.contains('tool-details-collapsed'), true);
  assert.equal(updated.querySelector('.tool-header').getAttribute('aria-expanded'), 'false');

  send([tool(
    'realtime-use',
    'realtime',
    'npm run build',
    '2026-08-10T05:40:02.000Z',
  )]);
  const realtime = container.querySelector('[data-tool-id="realtime"]');
  assert.equal(realtime.classList.contains('tool-details-collapsed'), false);
  assert.equal(realtime.querySelector('.tool-header').getAttribute('aria-expanded'), 'true');
});

test('Codex WS hydrates a realtime Edit after the timeline insertion', async () => {
  reset();
  window.resetToolDetails();
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  window.loadDiffViewer = async () => {
    window.Diff = { createTwoFilesPatch: () => 'patch' };
    window.Diff2HtmlUI = class {
      constructor(element) {
        this.element = element;
      }
      draw() {
        this.element.innerHTML = '<div class="d2h-file-wrapper">live diff</div>';
      }
      highlightCode() {}
    };
  };

  try {
    send([{
      uuid: 'live-edit-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'live-edit',
        name: 'Edit',
        input: {
          file_path: 'src/live.js',
          old_string: 'old live',
          new_string: 'new live',
        },
      }],
      timestamp: '2026-08-21T01:10:00.000Z',
    }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const node = document.querySelector('[data-tool-id="live-edit"]');
    const diff = node.querySelector('.diff-container');
    assert.equal(node.classList.contains('tool-details-collapsed'), false);
    assert.equal(diff.dataset.diffState, 'ready');
    assert.match(diff.textContent, /live diff/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
  }
});

test('Codex WS preserves a flushed wait when the background Ran completes later', () => {
  reset();

  const processId = '65713';
  const commandId = 'update-loop';
  const waitMessage = (uuid, id, timestamp) => ({
    uuid,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id,
      name: 'WriteStdin',
      input: { session_id: Number(processId), chars: '' },
    }],
    timestamp,
  });

  send([tool('loop-use', commandId, 'target=version; for i in 1 2 3; do check; done',
    '2026-08-10T04:16:55.136Z')]);
  send([result('loop-running', commandId, 'Process running with session ID 65713',
    '2026-08-10T04:17:25.311Z', {
      codexBackground: 'running',
      codexProcessId: processId,
    })]);
  send([waitMessage('wait-one-use', 'wait-one', '2026-08-10T04:17:30.071Z')]);
  send([result('wait-one-end', 'wait-one', 'Process running with session ID 65713',
    '2026-08-10T04:18:00.079Z', {
      codexWait: 'waiting',
      codexProcessId: processId,
      codexCommand: 'target=version; for i in 1 2 3; do check; done',
    })]);
  send([{
    uuid: 'status-text',
    type: 'assistant',
    content: [{ type: 'text', text: 'Bridge updated; waiting for the connection.' }],
    timestamp: '2026-08-10T04:18:05.398Z',
  }]);
  send([waitMessage('wait-two-use', 'wait-two', '2026-08-10T04:18:05.501Z')]);

  assert.equal(document.querySelectorAll('.codex-terminal-wait').length, 2);

  send([
    result('loop-complete', commandId, 'Bridge connected',
      '2026-08-10T04:18:28.706Z', {
        codexBackground: 'complete',
        codexCommandKind: 'ran',
        codexProcessId: processId,
      }),
    result('wait-two-end', 'wait-two', 'Process exited with code 0',
      '2026-08-10T04:18:28.708Z', {
        codexWait: 'completed',
        codexProcessId: processId,
      }),
  ]);

  const waits = document.querySelectorAll('.codex-terminal-wait');
  assert.equal(waits.length, 1);
  assert.match(waits[0].textContent, /target=version/);
  assert.equal(document.querySelectorAll(`[data-tool-id="${commandId}"]`).length, 1);
});

test('Codex startup recovery restores a wait missed during Bridge restart', async () => {
  reset();

  const processId = '65713';
  const commandId = 'update-loop';
  const command = 'target=version; for i in 1 2 3; do check; done';
  const waitUse = {
    uuid: 'wait-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'wait-one',
      name: 'WriteStdin',
      input: { session_id: Number(processId), chars: '' },
    }],
    timestamp: '2026-08-10T04:17:30.071Z',
  };
  const waitingResult = result(
    'wait-result',
    'wait-one',
    'Process running with session ID 65713',
    '2026-08-10T04:18:00.079Z',
    {
      codexWait: 'waiting',
      codexProcessId: processId,
      codexCommand: command,
    },
  );

  send([tool('loop-use', commandId, command, '2026-08-10T04:16:55.136Z')]);
  send([result('loop-running', commandId, 'Process running with session ID 65713',
    '2026-08-10T04:17:25.311Z', {
      codexBackground: 'running',
      codexProcessId: processId,
    })]);
  send([waitUse]);
  send([{
    uuid: 'status-text',
    type: 'assistant',
    content: [{ type: 'text', text: 'Bridge updated; waiting for the connection.' }],
    timestamp: '2026-08-10T04:18:05.398Z',
  }]);
  send([result('loop-complete', commandId, 'Bridge connected',
    '2026-08-10T04:18:28.706Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: processId,
    })]);

  const incompleteWait = document.querySelector('.codex-terminal-wait');
  assert.ok(incompleteWait);
  assert.match(incompleteWait.textContent, /Waiting for background terminal/);
  assert.doesNotMatch(incompleteWait.textContent, /Waited for background terminal/);

  apiResponse = {
    messages: [waitingResult],
    hasMore: false,
  };
  window.__wsTest.handleWsMessage({
    action: 'bridge_recovery_complete',
    deviceName: 'D',
    count: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const waits = document.querySelectorAll('.codex-terminal-wait');
  assert.equal(waits.length, 1);
  assert.match(waits[0].textContent, /Waited for background terminal/);
  assert.match(waits[0].textContent, /target=version/);
  assert.equal(document.querySelectorAll(`[data-tool-id="${commandId}"]`).length, 1);
});

test('Codex WS keeps a foreground Ran before a later Explore completion', () => {
  reset();

  send([
    tool('get-use', 'get', 'aws dynamodb get-item', '2026-08-10T03:52:36.095Z'),
    {
      uuid: 'read-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'read',
        name: 'Bash',
        input: {
          command: "sed -n '1,340p' test/frontend/tool-render.test.mjs",
          codexCommandKind: 'explore',
          codexCommandActions: [{
            type: 'read',
            name: 'tool-render.test.mjs',
            path: 'test/frontend/tool-render.test.mjs',
          }],
        },
      }],
      timestamp: '2026-08-10T03:52:37.680Z',
    },
  ]);
  send([result('get-result', 'get', '{"uuid":"example"}', '2026-08-10T03:52:37.733Z', {
    codexCommandKind: 'ran',
  })]);
  send([result('read-result', 'read', 'test contents', '2026-08-10T03:52:37.769Z', {
    codexCommandKind: 'explore',
  })]);

  const labels = Array.from(document.querySelectorAll('.tool-name'))
    .map((node) => node.textContent);
  const descriptions = Array.from(document.querySelectorAll('.tool-desc'))
    .map((node) => node.textContent);
  assert.deepEqual(labels, ['Ran', 'Explored']);
  assert.deepEqual(descriptions, ['aws dynamodb get-item', 'Read tool-render.test.mjs']);
});

test('Codex WS keeps running through text updates and stops on task_complete', () => {
  reset();
  state.wsRunning = true;

  const commentary = {
    uuid: 'commentary',
    type: 'assistant',
    content: [{ type: 'text', text: 'Still working.' }],
    timestamp: '2026-08-10T05:00:01.000Z',
  };
  const finalText = {
    uuid: 'final-text',
    type: 'assistant',
    content: [{ type: 'text', text: 'Finished.' }],
    timestamp: '2026-08-10T05:00:02.000Z',
  };
  const failedTool = {
    uuid: 'recoverable-tool-failure',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'recoverable-tool',
      content: 'Temporary failure',
      is_error: true,
    }],
    timestamp: '2026-08-10T05:00:02.500Z',
  };
  const taskComplete = {
    uuid: 'task-complete',
    type: 'assistant',
    content: [],
    timestamp: '2026-08-10T05:00:03.000Z',
    stopReason: 'end_turn',
  };

  send([commentary]);
  assert.equal(state.wsRunning, true);
  assert.equal(document.getElementById('cc-spinner')?.style.display, 'flex');
  assert.equal(document.getElementById('cc-spinner')?.classList.contains('is-collapsed'), false);

  send([finalText]);
  assert.equal(state.wsRunning, true);
  assert.equal(document.getElementById('cc-spinner')?.style.display, 'flex');
  assert.equal(document.getElementById('cc-spinner')?.classList.contains('is-collapsed'), false);

  send([failedTool]);
  assert.equal(state.wsRunning, true);
  assert.equal(document.getElementById('cc-spinner')?.style.display, 'flex');
  assert.equal(document.getElementById('cc-spinner')?.classList.contains('is-collapsed'), false);

  send([taskComplete]);
  assert.equal(state.wsRunning, false);
  assert.equal(document.getElementById('cc-spinner')?.style.display, 'flex');
  assert.equal(document.getElementById('cc-spinner')?.classList.contains('is-collapsed'), true);
  assert.equal(document.getElementById('cc-spinner')?.getAttribute('aria-hidden'), 'true');
  assert.equal(document.querySelectorAll('.assistant-text').length, 2);

  const history = [commentary, finalText, failedTool, taskComplete];
  document.querySelector('.messages').innerHTML = window.renderMessages(history, 'codex');
  assert.equal(window.deriveRunning(history.slice(0, -1), 'running', 'codex'), true);
  assert.equal(window.deriveRunning(history, 'running', 'codex'), false);
  assert.equal(document.querySelectorAll('.assistant-text').length, 2);
});

test('Claude still treats a tail error-only tool result as stopped', () => {
  const history = [{
    uuid: 'claude-tool',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'claude-tool',
      name: 'Bash',
      input: { command: 'false' },
    }],
    timestamp: '2026-08-10T05:10:00.000Z',
    stopReason: 'tool_use',
  }, {
    uuid: 'claude-tool-error',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'claude-tool',
      content: 'Command failed',
      is_error: true,
    }],
    timestamp: '2026-08-10T05:10:01.000Z',
  }];

  assert.equal(window.deriveRunning(history, 'running', 'claude'), false);
});

test('Codex grouping does not mutate Claude turns', () => {
  reset();
  state.appState.runtime = 'claude';
  const container = document.querySelector('.messages');
  container.innerHTML = `
    <div class="assistant-turn" id="claude-empty"></div>
    <div class="assistant-turn" id="claude-turn">
      <div class="tl-item tool-node" data-tool-id="claude-tool"></div>
    </div>`;

  window.markTurnAdjacency(container);

  assert.ok(document.getElementById('claude-empty'));
  assert.equal(document.querySelector('[data-tool-id="claude-tool"]').className, 'tl-item tool-node');
});

test('strict no-op Edit input does not render an empty diff body', () => {
  reset();
  const turnId = 'turn-noop-edit';
  const input = {
    file_path: 'src/noop.js',
    old_string: 'const value = 1;',
    new_string: 'const value = 1;\n',
  };
  const toolMessage = {
    uuid: 'noop-edit-message',
    nativeId: 'codex:item:noop-edit',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'noop-edit',
      name: 'Edit',
      input,
    }],
    timestamp: '2026-08-24T08:30:00.000Z',
    stopReason: 'tool_use',
  };
  const resultMessage = {
    uuid: 'noop-edit-result',
    nativeId: 'codex:item:noop-edit:tool-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'noop-edit',
      content: 'Applied changes',
      is_error: false,
    }],
    timestamp: '2026-08-24T08:30:00.000Z',
  };
  const events = [
    { action: 'stream_turn_start', seq: 0 },
    { action: 'stream_block_start', seq: 1, kind: 'tool_use', name: 'Edit' },
    { action: 'stream_tool_input', seq: 2, chunk: JSON.stringify(input) },
    { action: 'stream_block_stop', seq: 3 },
    { action: 'messages', seq: 4, messages: [toolMessage] },
    { action: 'messages', seq: 5, messages: [resultMessage] },
    {
      action: 'stream_end',
      seq: 6,
      messages: [toolMessage, resultMessage],
    },
  ];
  for (const index of [0, 1, 2, 3, 5, 4, 6]) {
    const event = events[index];
    window.__wsTest.handleWsMessage({
      ...event,
      sessionId: state.wsSessionId,
      turnId,
    });
  }

  const edit = document.querySelector('[data-tool-id="noop-edit"]');
  assert.ok(edit);
  assert.equal(edit.querySelector('.diff-container'), null);
  assert.equal(edit.querySelector('.tool-body'), null);
});
