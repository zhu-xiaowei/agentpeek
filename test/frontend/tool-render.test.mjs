import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;

await import('../../web/js/components/tool.js');
const { state } = await import('../../web/js/state.js');
globalThis.renderToolNode = window.renderToolNode;
globalThis.renderAssistantText = (text) => text;
globalThis.renderThinking = () => '';
globalThis.renderUserBubble = () => '';
globalThis.renderSystemEvent = () => '';
globalThis.renderSummary = () => '';
globalThis.renderInterrupt = () => '';
globalThis.renderLocalCommandStdout = () => '';
globalThis.isToolResultOnly = (message) => Array.isArray(message.content)
  && message.content.length > 0
  && message.content.every((block) => block.type === 'tool_result');
globalThis.isInterruptMsg = () => false;
globalThis.isLocalCommandStdout = () => false;
await import('../../web/js/render.js');

test('Codex WebSearch renders as a completed web search node', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'web-1',
    name: 'WebSearch',
    input: {
      action: 'search',
      query: 'site:example.com filesystem watcher',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'web-1',
    content: 'Searched the web for site:example.com filesystem watcher',
    is_error: false,
  }, 'codex');

  assert.match(html, /Searched the web/);
  assert.match(html, /site:example\.com filesystem watcher/);
  assert.doesNotMatch(html, /Failed/);
});

test('Codex MCP calls render Calling or Called while Claude keeps the tool name', () => {
  const toolUse = {
    type: 'tool_use',
    id: 'mcp-1',
    name: 'js',
    input: {
      code: 'nodeRepl.write("ok")',
      timeout_ms: 30_000,
      codexMcpServer: 'node_repl',
      codexMcpTool: 'js',
    },
  };
  const result = {
    type: 'tool_result',
    tool_use_id: 'mcp-1',
    content: 'ok',
    is_error: false,
    codexMcpServer: 'node_repl',
    codexMcpTool: 'js',
  };

  const calling = window.renderToolNode(toolUse, null, 'codex');
  assert.match(calling, />Calling</);
  assert.match(calling, />node_repl\.js</);
  assert.doesNotMatch(calling, /codexMcpServer/);

  const called = window.renderToolNode(toolUse, result, 'codex');
  assert.match(called, />Called</);
  assert.match(called, />node_repl\.js</);
  assert.match(called, />ok</);

  const claude = window.renderToolNode(toolUse, result, 'claude');
  assert.match(claude, />js</);
  assert.doesNotMatch(claude, />Called</);
  assert.doesNotMatch(claude, />Calling</);
});

test('Update Plan renders aligned status icons for completed, active, and pending steps', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'plan-1',
    name: 'TodoWrite',
    input: {
      explanation: 'Verify each plan state.',
      todos: [
        { content: 'Inspect the current UI', status: 'completed' },
        { content: 'Improve the status markers', status: 'in_progress' },
        { content: 'Validate mobile and desktop', status: 'pending' },
      ],
    },
  }, null, 'codex');

  document.body.innerHTML = html;
  const items = document.querySelectorAll('.plan-item');
  assert.equal(items.length, 3);
  assert.equal(document.querySelectorAll('.plan-status-icon svg').length, 3);
  assert.equal(document.querySelectorAll('.plan-item-completed').length, 1);
  assert.equal(document.querySelectorAll('.plan-item-in_progress').length, 1);
  assert.equal(document.querySelectorAll('.plan-item-pending').length, 1);
  assert.equal(
    document.querySelector('.plan-item-in_progress .plan-status-icon').getAttribute('aria-label'),
    'In progress',
  );
  assert.equal(document.querySelector('.plan-item-in_progress .plan-status-dot') !== null, true);
  assert.doesNotMatch(html, /&#42;|\*<\/span>/);

  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.plan-status-icon \{[\s\S]*height: 18px;/);
  assert.match(css, /html\.native-mobile \.plan-status-icon \{ width: 18px; height: 21px; \}/);
  assert.match(css, /html\.native-mobile \.plan-item-text \{ font-size: 14px; line-height: 21px; \}/);
});

test('Bash headers stay muted while IN keeps shell syntax highlighting', () => {
  const command = `brandnew-cli --mode=fast "green value" && next-tool -3 $HOME/a/longer/path/to/file.txt`;
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-highlight',
    name: 'Bash',
    input: { command },
  }, null, 'codex');

  document.body.innerHTML = html;
  const header = document.querySelector('.tool-desc');
  const body = document.querySelector('.tool-value code.shell-command');
  const bodyContainer = document.querySelector('.tool-body-content');
  assert.ok(header);
  assert.ok(body);
  assert.equal(bodyContainer.classList.contains('no-clamp'), false);
  assert.equal(header.textContent, command);
  assert.equal(body.textContent, command);
  assert.equal(header.classList.contains('shell-command'), false);
  assert.equal(header.querySelector('.shell-token'), null);
  assert.equal(body.querySelector('.shell-command-name')?.textContent, 'brandnew-cli');
  assert.equal(body.querySelector('.shell-option')?.textContent, '--mode=fast');
  assert.equal(body.querySelector('.shell-string')?.textContent, '"green value"');
  assert.equal(body.querySelector('.shell-operator')?.textContent, '&&');
  assert.equal(body.querySelector('.shell-variable')?.textContent, '$HOME');

  const claude = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-highlight-cc',
    name: 'Bash',
    input: { command: 'unknown-future-command --new-option' },
  }, null, 'claude');
  document.body.innerHTML = claude;
  assert.equal(document.querySelector('.tool-desc')?.textContent, 'unknown-future-command --new-option');
  assert.equal(document.querySelector('.tool-desc .shell-token'), null);

  const hostile = window.highlightShellCommand(`echo '<img src=x onerror=alert(1)>'`);
  document.body.innerHTML = hostile;
  assert.equal(document.querySelector('img'), null);
  assert.match(document.body.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('Shell highlighting is skipped after 1024 characters', () => {
  const atLimit = `echo ${'x'.repeat(1019)}`;
  const overLimit = `${atLimit}x`;

  document.body.innerHTML = window.highlightShellCommand(atLimit);
  assert.equal(document.body.textContent, atLimit);
  assert.equal(document.querySelector('.shell-command-name')?.textContent, 'echo');

  document.body.innerHTML = window.highlightShellCommand(overLimit);
  assert.equal(document.body.textContent, overLimit);
  assert.equal(document.querySelector('.shell-token'), null);
});

test('Codex Explore summaries stay plain instead of being treated as shell commands', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-explore',
    name: 'Bash',
    input: {
      command: 'rg needle web/js',
      codexCommandActions: [{ type: 'search', query: 'needle', path: 'web/js' }],
    },
  }, null, 'codex');

  document.body.innerHTML = html;
  assert.equal(document.querySelector('.tool-desc')?.textContent, 'Search needle');
  assert.equal(document.querySelector('.tool-desc.shell-command'), null);
});

test('Codex background command completion keeps the original Ran label', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-1',
    name: 'Bash',
    input: {
      command: 'sleep 1; echo done',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'bash-1',
    content: 'done\nProcess exited with code 0',
    is_error: false,
    codexBackground: 'complete',
    codexCommandKind: 'ran',
  }, 'codex');

  assert.match(html, /Ran/);
  document.body.innerHTML = html;
  assert.equal(document.querySelector('.tool-desc')?.textContent, 'sleep 1; echo done');
  assert.doesNotMatch(html, /Waited for background terminal/);
  assert.doesNotMatch(html, /Failed/);
});

test('failed commands keep the error dot without a redundant status label', () => {
  const html = window.renderMessages([
    {
      uuid: 'failed-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'failed',
        name: 'Bash',
        input: { command: 'exit 255' },
      }],
      timestamp: '2026-08-11T00:00:00.000Z',
    },
    {
      uuid: 'failed-result',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'failed',
        content: 'Process exited with code 255',
        is_error: true,
        codexExitCode: 255,
      }],
      timestamp: '2026-08-11T00:00:01.000Z',
    },
  ], 'codex');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  assert.ok(document.querySelector('.tool-node.error'));
  assert.equal(document.querySelector('.tool-status'), null);
  assert.doesNotMatch(html, />Exit 255</);
  assert.doesNotMatch(html, />Failed</);
});

test('Codex ignores the legacy Waited label on Bash results', () => {
  const html = window.renderToolNode({
    type: 'tool_use',
    id: 'bash-legacy',
    name: 'Bash',
    input: {
      command: 'npm test',
      codexCommandKind: 'ran',
    },
  }, {
    type: 'tool_result',
    tool_use_id: 'bash-legacy',
    content: 'tests passed',
    is_error: false,
    codexCommandKind: 'ran',
    codexLabel: 'Waited for background terminal',
  }, 'codex');

  assert.match(html, /Ran/);
  document.body.innerHTML = html;
  assert.equal(document.querySelector('.tool-desc')?.textContent, 'npm test');
  assert.doesNotMatch(html, /Waited for background terminal/);
});

test('Codex keeps a foreground Ran before a later Explore call', () => {
  const messages = [{
    uuid: 'get-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'get',
      name: 'Bash',
      input: {
        command: 'aws dynamodb get-item',
        codexCommandKind: 'ran',
      },
    }],
    timestamp: '2026-08-10T03:52:36.095Z',
  }, {
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
  }, {
    uuid: 'get-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'get',
      content: '{"uuid":"example"}',
      codexCommandKind: 'ran',
    }],
    timestamp: '2026-08-10T03:52:37.733Z',
  }, {
    uuid: 'read-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'read',
      content: 'test contents',
      codexCommandKind: 'explore',
    }],
    timestamp: '2026-08-10T03:52:37.769Z',
  }];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  const labels = Array.from(document.querySelectorAll('.tool-name'))
    .map((node) => node.textContent);
  const descriptions = Array.from(document.querySelectorAll('.tool-desc'))
    .map((node) => node.textContent);

  assert.deepEqual(labels, ['Ran', 'Explored']);
  assert.deepEqual(descriptions, ['aws dynamodb get-item', 'Read tool-render.test.mjs']);
});

test('Codex history keeps mixed Ran and Explored blocks in creation order', () => {
  const use = (uuid, id, command, timestamp, input = {}) => ({
    uuid,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id,
      name: 'Bash',
      input: { command, codexCommandKind: 'ran', ...input },
    }],
    timestamp,
  });
  const result = (uuid, id, timestamp, kind) => ({
    uuid,
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: id,
      content: 'done',
      codexCommandKind: kind,
    }],
    timestamp,
  });
  const messages = [
    use('version-use', 'version', 'node check-version.mjs', '2026-08-10T04:31:52.683Z'),
    use('scan-use', 'scan', 'aws dynamodb scan', '2026-08-10T04:31:52.928Z'),
    use('local-use', 'local', 'printf local-version', '2026-08-10T04:31:53.097Z'),
    use('search-use', 'search', 'rg bridge_recovery_complete', '2026-08-10T04:31:53.306Z', {
      codexCommandKind: 'explore',
      codexCommandActions: [{
        type: 'search',
        query: 'bridge_recovery_complete',
        path: 'ws-*.js',
      }],
    }),
    result('local-result', 'local', '2026-08-10T04:31:53.296Z', 'ran'),
    result('search-result', 'search', '2026-08-10T04:31:53.398Z', 'explore'),
    result('scan-result', 'scan', '2026-08-10T04:31:54.244Z', 'ran'),
    result('version-result', 'version', '2026-08-10T04:31:55.838Z', 'ran'),
  ];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  assert.deepEqual(
    Array.from(document.querySelectorAll('.tool-desc')).map((node) => node.textContent),
    [
      'node check-version.mjs',
      'aws dynamodb scan',
      'printf local-version',
      'Search bridge_recovery_complete',
    ],
  );
});

test('Codex exploration calls share one visible group label and empty waits stay hidden', () => {
  const tool = (id, name, input) => ({
    uuid: `message-${id}`,
    type: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp: `2026-08-10T02:26:${id.slice(-2)}.000Z`,
  });
  const html = window.renderMessages([
    tool('search-01', 'Bash', {
      command: 'rg -n "tool_use_id" web/js',
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'search', query: 'tool_use_id', path: 'web/js' }],
    }),
    tool('search-02', 'Bash', {
      command: 'rg -n "CommandExecution" bridge',
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'search', query: 'CommandExecution', path: 'bridge' }],
    }),
    tool('read-03', 'Bash', {
      command: "sed -n '1,120p' web/js/render.js",
      codexCommandKind: 'explore',
      codexCommandActions: [{ type: 'read', name: 'render.js', path: 'web/js/render.js' }],
    }),
    tool('wait-04', 'WriteStdin', { session_id: 1234, chars: '' }),
    {
      uuid: 'result-wait-04',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'wait-04',
        content: 'Process exited with code 0',
        codexWait: 'completed',
      }],
      timestamp: '2026-08-10T02:26:05.000Z',
    },
  ], 'codex');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  const container = document.querySelector('.messages');
  window.markCodexExploreGroups(container);

  assert.equal(container.querySelectorAll('.codex-explore').length, 3);
  assert.equal(container.querySelectorAll('.codex-explore-continuation').length, 2);
  assert.equal(container.querySelectorAll('.codex-explore:not(.codex-explore-continuation)').length, 1);
  assert.equal(container.querySelectorAll('.codex-explore-group-start').length, 1);
  assert.equal(container.querySelectorAll('.codex-explore-group-connected').length, 0);
  assert.deepEqual(Array.from(container.querySelectorAll('.tool-desc')).map((node) => node.textContent), [
    'Search tool_use_id',
    'Search CommandExecution',
    'Read render.js',
  ]);
  assert.doesNotMatch(html, /wait-04/);
  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.tool-desc\.shell-command/);
  assert.match(css, /\.assistant-text code \{ background: #161b22; color: var\(--runtime-accent\);/);
  assert.match(css, /\.codex-explore-continuation \.tool-name \{ display: none; \}/);
  assert.match(css, /\.codex-explore-continuation::before \{ display: none; \}/);
  assert.match(css, /\.codex-explore-continuation::after \{ display: none !important; \}/);
  assert.match(css, /\.codex-explore-group-start::after \{[\s\S]*bottom: calc\(100% - 16px\) !important;/);
  assert.match(css, /\.codex-explore-group-start\.codex-explore-group-connected::after \{[\s\S]*bottom: -2px !important;/);
  assert.match(css, /\.codex-explore-continuation\.codex-explore-group-connected::after \{[\s\S]*display: block !important;/);
  assert.match(css, /\.codex-explore-group-start\.tool-details-collapsed \{ padding-bottom: 1px; \}/);
  assert.match(css, /\.codex-explore-continuation\.tool-details-collapsed \{ padding-top: 1px; padding-bottom: 1px; \}/);
  assert.match(css, /\.tool-header \{\s*display: flex; align-items: baseline;/);
  assert.match(css, /\.tool-detail-chevron \{\s*display: inline-block; align-self: center;/);
});

test('tool detail policy collapses Codex history while realtime and Claude stay expanded', () => {
  const message = {
    uuid: 'bash-use',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'bash',
      name: 'Bash',
      input: { command: 'npm test', codexCommandKind: 'ran' },
    }],
    timestamp: '2026-08-10T05:30:00.000Z',
  };

  document.body.innerHTML = `<div class="messages">${window.renderMessages([message], 'codex')}</div>`;
  const historyNode = document.querySelector('.tool-node');
  const historyHeader = historyNode.querySelector('.tool-header');
  assert.equal(historyNode.classList.contains('tool-details-collapsed'), true);
  assert.equal(historyHeader.getAttribute('aria-expanded'), 'false');
  assert.ok(historyHeader.querySelector('.tool-detail-chevron'));

  window.toggleToolDetails(historyHeader);
  assert.equal(historyNode.classList.contains('tool-details-collapsed'), false);
  assert.equal(historyHeader.getAttribute('aria-expanded'), 'true');
  assert.equal(historyNode.querySelector('.tool-body-content').classList.contains('open'), false);

  document.body.innerHTML = `<div class="messages">${
    window.renderSingleMessage(message, [message], 'codex')
  }</div>`;
  const realtimeNode = document.querySelector('.tool-node');
  assert.equal(realtimeNode.classList.contains('tool-details-collapsed'), false);
  assert.equal(realtimeNode.querySelector('.tool-header').getAttribute('aria-expanded'), 'true');

  document.body.innerHTML = `<div class="messages">${window.renderMessages([message], 'claude')}</div>`;
  const claudeNode = document.querySelector('.tool-node');
  assert.equal(claudeNode.classList.contains('tool-details-collapsed'), false);
  assert.equal(claudeNode.querySelector('.tool-detail-chevron'), null);
});

test('Codex Explored title toggles every detail body in the group', () => {
  const explore = (id, command, action) => ({
    uuid: `message-${id}`,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id,
      name: 'Bash',
      input: {
        command,
        codexCommandKind: 'explore',
        codexCommandActions: [action],
      },
    }],
    timestamp: `2026-08-10T05:31:0${id}.000Z`,
  });
  document.body.innerHTML = `<div class="messages">${window.renderMessages([
    explore('1', 'rg -n tool web/js', { type: 'search', query: 'tool', path: 'web/js' }),
    explore('2', "sed -n '1,80p' web/js/render.js", {
      type: 'read',
      name: 'render.js',
      path: 'web/js/render.js',
    }),
  ], 'codex')}</div>`;
  const container = document.querySelector('.messages');
  window.markCodexExploreGroups(container);
  const nodes = Array.from(container.querySelectorAll('.codex-explore'));
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].dataset.toolDetailsGroup, nodes[1].dataset.toolDetailsGroup);
  assert.ok(nodes.every((node) => node.classList.contains('tool-details-collapsed')));

  window.toggleToolDetails(nodes[0].querySelector('.tool-header'));
  assert.ok(nodes.every((node) => !node.classList.contains('tool-details-collapsed')));
  assert.ok(nodes.every((node) =>
    !node.querySelector('.tool-body-content').classList.contains('open')));

  window.toggleToolDetails(nodes[0].querySelector('.tool-header'));
  assert.ok(nodes.every((node) => node.classList.contains('tool-details-collapsed')));
});

test('Codex Edit loads and renders the diff only after first expansion', async () => {
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  const originalStickBottom = state.stickBottom;
  let loads = 0;
  let contentHeight = 600;
  window.loadDiffViewer = async () => {
    loads++;
    window.Diff = {
      createTwoFilesPatch: () => 'patch',
    };
    window.Diff2HtmlUI = class {
      constructor(element) {
        this.element = element;
      }
      draw() {
        assert.equal(this.element.isConnected, true);
        contentHeight = 900;
        this.element.innerHTML = '<div class="d2h-file-wrapper">rendered diff</div>';
      }
      highlightCode() {}
    };
  };

  try {
    const message = {
      uuid: 'edit-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'edit',
        name: 'Edit',
        input: {
          file_path: 'src/example.js',
          old_string: 'const value = 1;',
          new_string: 'const value = 2;',
        },
      }],
      timestamp: '2026-08-10T05:32:00.000Z',
    };
    document.body.innerHTML = `<div id="content"><div class="messages">${
      window.renderMessages([message], 'codex')
    }</div></div>`;
    const content = document.getElementById('content');
    Object.defineProperty(content, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(content, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    state.stickBottom = true;
    content.scrollTop = 0;
    const node = document.querySelector('.tool-node');
    const diff = node.querySelector('.diff-container');
    assert.equal(loads, 0);
    assert.equal(diff.textContent, '');

    window.toggleToolDetails(node.querySelector('.tool-header'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 1);
    assert.equal(diff.dataset.diffState, 'ready');
    assert.match(diff.textContent, /rendered diff/);
    assert.equal(content.scrollTop, 900);

    window.toggleToolDetails(node.querySelector('.tool-header'));
    window.toggleToolDetails(node.querySelector('.tool-header'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loads, 1);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
    state.stickBottom = originalStickBottom;
  }
});

test('offscreen Edit keeps a measured height when its target initially reports zero', async () => {
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
        this.element.innerHTML = '<div class="d2h-file-wrapper">offscreen diff</div>';
        this.element.getBoundingClientRect = () => ({
          width: 640,
          height: 184,
          top: 0,
          right: 640,
          bottom: 184,
          left: 0,
        });
      }
      highlightCode() {}
    };
  };

  try {
    document.body.innerHTML = '<div id="content"><div class="messages">'
      + '<div class="tool-node"></div></div></div>';
    const node = document.querySelector('.tool-node');
    node.innerHTML = window.renderToolNode({
      type: 'tool_use',
      id: 'edit-offscreen-height',
      name: 'Edit',
      input: {
        file_path: 'src/offscreen.js',
        old_string: 'before',
        new_string: 'after',
      },
    }, null, 'codex');
    const diff = node.querySelector('.diff-container');
    diff.getBoundingClientRect = () => ({
      width: 0,
      height: 0,
      top: -2000,
      right: 0,
      bottom: -2000,
      left: 0,
    });

    await window.afterToolDomMutation(node);

    assert.equal(diff.dataset.diffState, 'ready');
    assert.ok(parseFloat(diff.style.minHeight) > 10);
    assert.match(diff.textContent, /offscreen diff/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
  }
});

test('Edit hydration does not reclaim scroll after the user leaves the bottom', async () => {
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  const originalStickBottom = state.stickBottom;
  let releaseLoader;
  let contentHeight = 600;
  const loaderReady = new Promise((resolve) => { releaseLoader = resolve; });
  window.loadDiffViewer = async () => {
    await loaderReady;
    window.Diff = { createTwoFilesPatch: () => 'patch' };
    window.Diff2HtmlUI = class {
      constructor(element) {
        this.element = element;
      }
      draw() {
        contentHeight = 900;
        this.element.innerHTML = '<div class="d2h-file-wrapper">rendered diff</div>';
      }
      highlightCode() {}
    };
  };

  try {
    document.body.innerHTML = '<div id="content"><div class="messages">'
      + '<div class="tool-node"></div></div></div>';
    const content = document.getElementById('content');
    Object.defineProperty(content, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    });
    Object.defineProperty(content, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    content.scrollTop = 100;
    state.stickBottom = true;

    const node = document.querySelector('.tool-node');
    node.innerHTML = window.renderToolNode({
      type: 'tool_use',
      id: 'edit-user-scroll',
      name: 'Edit',
      input: {
        file_path: 'src/user-scroll.js',
        old_string: 'before',
        new_string: 'after',
      },
    }, null, 'codex');
    const hydration = window.afterToolDomMutation(node);

    state.stickBottom = false;
    content.scrollTop = 25;
    releaseLoader();
    await hydration;

    assert.equal(content.scrollTop, 25);
    assert.match(node.querySelector('.diff-container').textContent, /rendered diff/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
    state.stickBottom = originalStickBottom;
  }
});

test('Edit replacement during lazy loading hydrates the new element only', async () => {
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  let releaseLoader;
  let draws = 0;
  const loaderReady = new Promise((resolve) => { releaseLoader = resolve; });
  window.loadDiffViewer = async () => {
    await loaderReady;
    window.Diff = { createTwoFilesPatch: () => 'patch' };
    window.Diff2HtmlUI = class {
      constructor(element) {
        this.element = element;
      }
      draw() {
        draws++;
        this.element.innerHTML = '<div class="d2h-file-wrapper">current diff</div>';
      }
      highlightCode() {}
    };
  };

  const toolUse = {
    type: 'tool_use',
    id: 'edit-replaced',
    name: 'Edit',
    input: {
      file_path: 'src/replaced.js',
      old_string: 'const oldValue = 1;',
      new_string: 'const newValue = 2;',
    },
  };

  try {
    document.body.innerHTML = '<div id="content"><div class="messages">'
      + '<div class="tool-node"></div></div></div>';
    const node = document.querySelector('.tool-node');
    node.innerHTML = window.renderToolNode(toolUse, null, 'codex');
    const oldDiff = node.querySelector('.diff-container');
    const oldHydration = window.afterToolDomMutation(node);
    assert.equal(oldDiff.dataset.diffState, 'loading');

    node.innerHTML = window.renderToolNode(toolUse, null, 'codex');
    const newDiff = node.querySelector('.diff-container');
    const newHydration = window.afterToolDomMutation(node);
    assert.notEqual(newDiff, oldDiff);
    assert.equal(newDiff.dataset.diffKey, oldDiff.dataset.diffKey);

    releaseLoader();
    await Promise.all([oldHydration, newHydration]);

    assert.equal(oldDiff.isConnected, false);
    assert.equal(oldDiff.textContent, '');
    assert.equal(newDiff.dataset.diffState, 'ready');
    assert.match(newDiff.textContent, /current diff/);
    assert.equal(draws, 1);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
  }
});

test('concurrent Edit hydration keeps DOM order when the later diff finishes first', async () => {
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  const originalStickBottom = state.stickBottom;
  const releases = [];
  let loadIndex = 0;
  window.resetToolDetails();
  window.loadDiffViewer = async () => {
    const index = loadIndex++;
    await new Promise((resolve) => { releases[index] = resolve; });
    window.Diff = {
      createTwoFilesPatch: (file) => file,
    };
    window.Diff2HtmlUI = class {
      constructor(element, patch) {
        this.element = element;
        this.patch = patch;
      }
      draw() {
        this.element.innerHTML = `<div class="d2h-file-wrapper">${this.patch}</div>`;
      }
      highlightCode() {}
    };
  };

  try {
    state.stickBottom = false;
    document.body.innerHTML = '<div id="content"><div class="messages">'
      + '<div class="tool-node" data-order="first"></div>'
      + '<div class="tool-node" data-order="second"></div>'
      + '</div></div>';
    const nodes = Array.from(document.querySelectorAll('.tool-node'));
    nodes[0].innerHTML = window.renderToolNode({
      type: 'tool_use',
      id: 'edit-first',
      name: 'Edit',
      input: {
        file_path: 'src/first.js',
        old_string: 'before first',
        new_string: 'after first',
      },
    }, null, 'codex');
    nodes[1].innerHTML = window.renderToolNode({
      type: 'tool_use',
      id: 'edit-second',
      name: 'Edit',
      input: {
        file_path: 'src/second.js',
        old_string: 'before second',
        new_string: 'after second',
      },
    }, null, 'codex');

    const hydration = window.afterToolDomMutation(document.querySelector('.messages'));
    assert.equal(loadIndex, 2);

    releases[1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(nodes[0].querySelector('.diff-container').dataset.diffState, 'loading');
    assert.equal(nodes[1].querySelector('.diff-container').dataset.diffState, 'ready');
    assert.deepEqual(
      Array.from(document.querySelectorAll('.tool-node')).map((node) => node.dataset.order),
      ['first', 'second'],
    );

    releases[0]();
    await hydration;
    assert.deepEqual(
      Array.from(document.querySelectorAll('.tool-node')).map((node) => node.dataset.order),
      ['first', 'second'],
    );
    assert.match(nodes[0].textContent, /first\.js/);
    assert.match(nodes[1].textContent, /second\.js/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
    state.stickBottom = originalStickBottom;
  }
});

test('an adopted expanded Edit hydrates without another user toggle', async () => {
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
        this.element.innerHTML = '<div class="d2h-file-wrapper">adopted diff</div>';
      }
      highlightCode() {}
    };
  };

  try {
    const message = {
      uuid: 'edit-adopted',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'edit-adopted',
        name: 'Edit',
        input: {
          file_path: 'src/adopted.js',
          old_string: 'before',
          new_string: 'after',
        },
      }],
      timestamp: '2026-08-21T01:00:00.000Z',
    };
    document.body.innerHTML = `<div class="messages">${
      window.renderMessages([message], 'codex')
    }</div>`;
    const node = document.querySelector('.tool-node');
    const diff = node.querySelector('.diff-container');
    assert.equal(node.classList.contains('tool-details-collapsed'), true);
    assert.equal(diff.dataset.diffState, undefined);

    window.setToolDetailsCollapsed(node, false);
    await window.afterToolDomMutation(node);

    assert.equal(diff.dataset.diffState, 'ready');
    assert.match(diff.textContent, /adopted diff/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
  }
});

test('Edit loader failure renders fallback content instead of an empty border', async () => {
  const originalLoader = window.loadDiffViewer;
  const originalDiff = window.Diff;
  const originalUi = window.Diff2HtmlUI;
  window.loadDiffViewer = async () => {
    throw new Error('viewer failed');
  };
  delete window.Diff;
  delete window.Diff2HtmlUI;

  try {
    document.body.innerHTML = '<div class="tool-node"></div>';
    const node = document.querySelector('.tool-node');
    node.innerHTML = window.renderToolNode({
      type: 'tool_use',
      id: 'edit-fallback',
      name: 'Edit',
      input: {
        file_path: 'src/fallback.js',
        old_string: 'old line',
        new_string: 'new line',
      },
    }, null, 'codex');

    await window.afterToolDomMutation(node);
    const diff = node.querySelector('.diff-container');
    assert.equal(diff.dataset.diffState, 'fallback');
    assert.match(diff.textContent, /old line/);
    assert.match(diff.textContent, /new line/);
  } finally {
    window.loadDiffViewer = originalLoader;
    window.Diff = originalDiff;
    window.Diff2HtmlUI = originalUi;
  }
});

test('resetting tool details clears session-scoped diff specifications', async () => {
  document.body.innerHTML = '<div class="tool-node"></div>';
  const node = document.querySelector('.tool-node');
  node.innerHTML = window.renderToolNode({
    type: 'tool_use',
    id: 'edit-reset',
    name: 'Edit',
    input: {
      file_path: 'src/reset.js',
      old_string: 'old',
      new_string: 'new',
    },
  }, null, 'codex');

  window.resetToolDetails();
  await window.afterToolDomMutation(node);

  const diff = node.querySelector('.diff-container');
  assert.equal(diff.dataset.diffState, 'error');
  assert.match(diff.textContent, /Diff unavailable/);
});

test('collapsed tool spacing keeps the original title baseline', () => {
  const css = fs.readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\.tool-node\.tool-details-collapsed \{ padding-top: 6px; padding-bottom: 4px; \}/,
  );
  assert.match(
    css,
    /@media \(max-width: 600px\) \{[\s\S]*\.codex-terminal-wait \.tool-desc \{ flex: 0 0 100%; min-width: 0; \}/,
  );
});

test('Codex Waited command expands from its truncated header', () => {
  const command = "target='0.2.0-codex-p2-20260810-11'; for i in 1 2 3 4 5 6 7; do echo \"$target\"; done";
  const html = window.renderMessages([
    {
      uuid: 'wait-use',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'wait',
        name: 'WriteStdin',
        input: { session_id: 1234, chars: '', codexCommand: command },
      }],
      timestamp: '2026-08-10T04:00:00.000Z',
    },
    {
      uuid: 'wait-result',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'wait',
        content: 'Process running with session ID 1234',
        codexWait: 'waiting',
        codexProcessId: '1234',
        codexCommand: command,
      }],
      timestamp: '2026-08-10T04:00:01.000Z',
    },
  ], 'codex');

  document.body.innerHTML = `<div class="messages">${html}</div>`;
  const header = document.querySelector('.codex-terminal-wait .tool-header');
  assert.ok(header.classList.contains('expandable-desc'));
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  assert.equal(header.querySelector('.tool-desc').textContent, command);

  window.toggleToolDesc(header);
  assert.ok(header.classList.contains('expanded-desc'));
  assert.equal(header.getAttribute('aria-expanded'), 'true');

  window.toggleToolDesc(header);
  assert.equal(header.classList.contains('expanded-desc'), false);
  assert.equal(header.getAttribute('aria-expanded'), 'false');
});

test('Codex background waits and completions preserve block order', () => {
  const tool = (id, name, input, timestamp) => ({
    uuid: `message-${id}`,
    type: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
    timestamp,
  });
  const result = (id, content, timestamp, extra = {}) => ({
    uuid: `result-${id}-${timestamp}`,
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }],
    timestamp,
  });
  const text = (value, timestamp) => ({
    uuid: `text-${timestamp}`,
    type: 'assistant',
    content: [{ type: 'text', text: value }],
    timestamp,
  });
  const messages = [
    text('Before commands', '2026-08-10T03:00:00.000Z'),
    tool('npm', 'Bash', { command: 'npm test', codexCommandKind: 'ran' }, '2026-08-10T03:00:01.000Z'),
    tool('sleep', 'Bash', { command: 'sleep 75; check fleet', codexCommandKind: 'ran' }, '2026-08-10T03:00:02.000Z'),
    result('npm', 'tests passed', '2026-08-10T03:00:05.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '100',
    }),
    tool('wait-npm', 'WriteStdin', { session_id: 100, chars: '' }, '2026-08-10T03:00:03.000Z'),
    result('wait-npm', 'Process exited with code 0', '2026-08-10T03:00:05.100Z', {
      codexWait: 'completed',
      codexProcessId: '100',
    }),
    tool('wait-sleep', 'WriteStdin', {
      session_id: 200,
      chars: '',
      codexCommand: 'sleep 75; check fleet',
    }, '2026-08-10T03:00:06.000Z'),
    result('wait-sleep', 'Process running with session ID 200', '2026-08-10T03:00:06.500Z', {
      codexWait: 'waiting',
      codexProcessId: '200',
      codexCommand: 'sleep 75; check fleet',
    }),
    tool('date', 'Bash', { command: 'date; check versions', codexCommandKind: 'ran' }, '2026-08-10T03:00:06.750Z'),
    tool('tail', 'Bash', { command: 'tail bridge.log', codexCommandKind: 'ran' }, '2026-08-10T03:00:07.000Z'),
    result('tail', 'bridge ready', '2026-08-10T03:00:07.100Z', { codexCommandKind: 'ran' }),
    tool('git', 'Bash', {
      command: 'git diff --stat; git diff --check; find test -type f',
      codexCommandKind: 'ran',
    }, '2026-08-10T03:00:08.000Z'),
    result('git', 'test/a.test.mjs', '2026-08-10T03:00:08.100Z', { codexCommandKind: 'ran' }),
    result('date', 'all online', '2026-08-10T03:00:09.100Z', { codexCommandKind: 'ran' }),
    text('After wait', '2026-08-10T03:00:10.000Z'),
    tool('next', 'Bash', {
      command: 'sleep 35; check versions',
      codexCommandKind: 'ran',
    }, '2026-08-10T03:00:10.100Z'),
    tool('wait-next', 'WriteStdin', {
      session_id: 300,
      chars: '',
      codexCommand: 'sleep 35; check versions',
    }, '2026-08-10T03:00:10.500Z'),
    result('wait-next', 'Process running with session ID 300', '2026-08-10T03:00:11.000Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check versions',
    }),
    result('sleep', 'fleet checked', '2026-08-10T03:00:12.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '200',
    }),
    tool('wait-next-again', 'WriteStdin', {
      session_id: 300,
      chars: '',
      codexCommand: 'sleep 35; check versions',
    }, '2026-08-10T03:00:13.000Z'),
    result('wait-next-again', 'Process running with session ID 300', '2026-08-10T03:00:13.500Z', {
      codexWait: 'waiting',
      codexProcessId: '300',
      codexCommand: 'sleep 35; check versions',
    }),
    result('next', 'versions checked', '2026-08-10T03:00:14.000Z', {
      codexBackground: 'complete',
      codexCommandKind: 'ran',
      codexProcessId: '300',
    }),
  ];

  document.body.innerHTML = `<div class="messages">${window.renderMessages(messages, 'codex')}</div>`;
  const container = document.querySelector('.messages');
  window.normalizeCodexTimeline(container);

  const timeline = Array.from(container.querySelectorAll('.tl-item')).map((node) => ({
    label: node.querySelector('.tool-name')?.textContent || '',
    text: node.textContent,
  }));
  assert.deepEqual(timeline.map((item) => item.label), [
    '',
    'Ran',
    'Ran',
    'Waited for background terminal',
    'Ran',
    'Ran',
    'Ran',
    '',
    'Ran',
    'Waited for background terminal',
  ]);
  assert.match(timeline[2].text, /sleep 75; check fleet/);
  assert.match(timeline[4].text, /date; check versions/);
  assert.match(timeline[5].text, /tail bridge\.log/);
  assert.match(timeline[6].text, /git diff --stat/);
  assert.match(timeline[8].text, /sleep 35; check versions/);
  assert.match(timeline[9].text, /sleep 35; check versions/);
  assert.equal(container.querySelectorAll('.codex-terminal-wait').length, 2);
});

test('Codex non-empty terminal input remains visible', () => {
  const html = window.renderMessages([{
    uuid: 'message-input',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'stdin-input',
      name: 'WriteStdin',
      input: { session_id: 1234, chars: 'yes\n' },
    }],
    timestamp: '2026-08-10T02:27:00.000Z',
  }], 'codex');

  assert.match(html, /stdin-input/);
  assert.match(html, /Ran/);
});

test('Codex exploration grouping spans adjacent realtime assistant turns', () => {
  document.body.innerHTML = `<div class="messages">
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node"></div></div>
    <div class="assistant-turn"><div class="tl-item tool-node codex-explore"></div></div>
  </div>`;
  const container = document.querySelector('.messages');

  window.markCodexExploreGroups(container);

  const explores = container.querySelectorAll('.codex-explore');
  assert.equal(explores[0].classList.contains('codex-explore-continuation'), false);
  assert.equal(explores[0].classList.contains('codex-explore-group-start'), true);
  assert.equal(explores[0].classList.contains('codex-explore-group-connected'), true);
  assert.equal(explores[1].classList.contains('codex-explore-continuation'), true);
  assert.equal(explores[1].classList.contains('codex-explore-group-connected'), true);
  assert.equal(explores[2].classList.contains('codex-explore-continuation'), false);
});
