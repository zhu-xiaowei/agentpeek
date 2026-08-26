import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  '<!doctype html><body>'
  + '<div id="content"><div class="messages"></div></div>'
  + '<div id="input-bar"><textarea id="msg-input"></textarea>'
  + '<div class="input-row"><button id="send-btn"></button></div></div>'
  + '</body>',
  { url: 'https://test/' },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
dom.window.Element.prototype.scrollTo = function () {};
globalThis.requestAnimationFrame = (callback) => callback();

const sent = [];
globalThis.esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('"', '&quot;');
globalThis.wsSendReliable = (message) => sent.push(message);
globalThis.updateSpinner = () => {};

const { state } = await import('../../web/js/state.js');
await import('../../web/js/components/permission.js');

function reset() {
  window.dismissPermissionPrompt();
  sent.length = 0;
  document.querySelector('.messages').innerHTML = '';
  state.wsSessionId = 'codex:thread-1';
  state.appState = { device: 'test-ec2-ap' };
}

function commandPrompt() {
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-1',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: 'git add README.md',
      codexApproval: {
        proposedExecpolicyAmendment: ['git', 'add'],
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ['git', 'add'],
            },
          },
          'cancel',
        ],
      },
    },
  });
}

test('Codex command approval renders the native three decisions in order', () => {
  reset();
  commandPrompt();

  assert.equal(document.querySelector('.messages').classList.contains('has-permission-prompt'), true);
  assert.equal(document.querySelector('.permission-title').textContent, 'Run command?');
  assert.equal(document.querySelector('.permission-desc').textContent, 'git add README.md');
  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    [
      'Yes, proceed',
      "Yes, and don't ask again for commands that start with `git add`",
      'No, and tell Codex what to do differently',
    ],
  );
});

test('Codex command approval does not repeat a full command used as the rule', () => {
  reset();
  const longPrefix = 'curl -I --max-time 5 https://example.com/'
    + 'a'.repeat(180);
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-long',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: longPrefix,
      codexApproval: {
        proposedExecpolicyAmendment: [longPrefix],
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: [longPrefix],
            },
          },
          'cancel',
        ],
      },
    },
  });

  const second = document.querySelectorAll('.permission-btn')[1];
  assert.ok(second.querySelector('.permission-key'));
  assert.ok(second.querySelector('.permission-copy > .permission-label'));
  assert.equal(
    second.querySelector('.permission-label').textContent,
    "Yes, and don't ask again for this command",
  );
  assert.equal(second.querySelector('.permission-copy').textContent.includes(longPrefix), false);
});

test('Codex command approval ignores Windows display escaping when checking repetition', () => {
  reset();
  const powershellScript = "Get-Item -LiteralPath 'C:\\Users\\Administrator\\input.exe'"
    + ' -ErrorAction Stop | Select-Object FullName,Length';
  const rule = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    '-Command',
    powershellScript,
  ];
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-windows',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: '"C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"'
        + ' -Command "'
        + powershellScript.replaceAll('\\', '\\\\')
        + '"',
      codexApproval: {
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: rule,
            },
          },
          'cancel',
        ],
      },
    },
  });

  assert.equal(
    document.querySelectorAll('.permission-label')[1].textContent,
    "Yes, and don't ask again for this command",
  );
});

test('Codex command approval compares quoted command arguments with structured rule tokens', () => {
  reset();
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-quoted',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: 'tool --message "hello world"',
      codexApproval: {
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ['tool', '--message', 'hello world'],
            },
          },
          'cancel',
        ],
      },
    },
  });

  assert.equal(
    document.querySelectorAll('.permission-label')[1].textContent,
    "Yes, and don't ask again for this command",
  );
});

test('Codex command approval parses escaped quotes and whitespace before comparison', () => {
  reset();
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-escaped',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: 'tool --message "say \\"hello\\"" hello\\ world',
      codexApproval: {
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ['tool', '--message', 'say "hello"', 'hello world'],
            },
          },
          'cancel',
        ],
      },
    },
  });

  assert.equal(
    document.querySelectorAll('.permission-label')[1].textContent,
    "Yes, and don't ask again for this command",
  );
});

test('Codex command approval keeps showing a rule that is only a command prefix', () => {
  reset();
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-prefix',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: 'git add README.md',
      codexApproval: {
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ['git', 'add'],
            },
          },
          'cancel',
        ],
      },
    },
  });

  assert.equal(
    document.querySelectorAll('.permission-label')[1].textContent,
    "Yes, and don't ask again for commands that start with `git add`",
  );
});

test('Codex command approval fails closed when displayed command quoting is incomplete', () => {
  reset();
  window.showPermissionPrompt({
    action: 'permission_request',
    sessionId: 'codex:thread-1',
    requestId: 'approval-unclosed-quote',
    kind: 'tool',
    toolName: 'Bash',
    input: {
      command: 'tool "hello world',
      codexApproval: {
        availableDecisions: [
          'accept',
          {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: ['tool', 'hello world'],
            },
          },
          'cancel',
        ],
      },
    },
  });

  assert.equal(
    document.querySelectorAll('.permission-label')[1].textContent,
    "Yes, and don't ask again for commands that start with `tool hello world`",
  );
});

test('Codex command approval returns the selected structured decision', () => {
  reset();
  commandPrompt();

  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);

  assert.deepEqual(sent, [{
    action: 'permission_reply',
    sessionId: 'codex:thread-1',
    device: 'test-ec2-ap',
    requestId: 'approval-1',
    decision: {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['git', 'add'],
      },
    },
  }]);
  assert.equal(document.getElementById('permission-prompt'), null);
});

test('closing a Codex command approval sends cancel', () => {
  reset();
  commandPrompt();

  window.cancelPermissionPrompt();

  assert.equal(sent[0].decision, 'cancel');
});

test('resolved events only dismiss the matching permission prompt', () => {
  reset();
  commandPrompt();

  assert.equal(window.resolvePermissionPrompt('another-approval'), false);
  assert.ok(document.getElementById('permission-prompt'));
  assert.equal(document.getElementById('msg-input').disabled, true);

  assert.equal(window.resolvePermissionPrompt('approval-1'), true);
  assert.equal(document.getElementById('permission-prompt'), null);
  assert.equal(document.querySelector('.messages').classList.contains('has-permission-prompt'), false);
  assert.equal(document.getElementById('msg-input').disabled, false);
});

test('permission waits for the message container before becoming active', async () => {
  reset();
  document.getElementById('content').innerHTML =
    '<div class="messages skeleton-messages"></div>';

  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'deferred-approval',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd' },
  });

  assert.equal(window.hasActivePermissionPrompt(), false);
  assert.equal(document.getElementById('permission-prompt'), null);
  assert.equal(document.getElementById('msg-input').disabled, false);

  document.getElementById('content').innerHTML = '<div class="messages"></div>';
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(window.hasActivePermissionPrompt(), true);
  assert.ok(document.getElementById('permission-prompt'));
  assert.equal(document.getElementById('msg-input').disabled, true);
});

test('a deferred permission resolved during loading never appears later', async () => {
  reset();
  document.getElementById('content').innerHTML =
    '<div class="messages skeleton-messages"></div>';

  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'resolved-before-render',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd' },
  });
  assert.equal(
    window.resolvePermissionPrompt('resolved-before-render'),
    true,
  );

  document.getElementById('content').innerHTML = '<div class="messages"></div>';
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(window.hasActivePermissionPrompt(), false);
  assert.equal(document.getElementById('permission-prompt'), null);
});

test('Claude tool approvals keep the legacy Yes and No decisions', () => {
  reset();
  const content = document.getElementById('content');
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: 640 });
  content.scrollTop = 0;
  window.showPermissionPrompt({
    sessionId: 'claude-session',
    requestId: 'approval-2',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd' },
  });

  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    ['Yes', 'No'],
  );
  assert.equal(content.scrollTop, 640);
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[0]);
  assert.equal(sent[0].decision, 'allow');
});

test('Claude AskUserQuestion keeps the answerText reply contract', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'claude-session',
    requestId: 'ask-approval',
    kind: 'ask',
    toolName: 'AskUserQuestion',
    questions: [{
      question: 'Choose a region',
      options: [
        { label: 'AP', description: 'Asia Pacific' },
        { label: 'US', description: 'United States' },
      ],
    }],
    input: {},
  });

  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[0]);
  assert.deepEqual(sent[0], {
    action: 'permission_reply',
    sessionId: 'codex:thread-1',
    device: 'test-ec2-ap',
    requestId: 'ask-approval',
    decision: 'answer',
    answerText: 'Choose a region → AP',
  });
});

test('expanding the typed answer keeps the permission prompt at the bottom', () => {
  reset();
  const content = document.getElementById('content');
  content.scrollTop = 0;
  window.showPermissionPrompt({
    sessionId: 'claude-session',
    requestId: 'ask-typed',
    kind: 'ask',
    toolName: 'AskUserQuestion',
    questions: [{
      question: 'Describe the deployment',
      options: [],
    }],
    input: {},
  });
  content.scrollTop = 0;

  window.handlePermissionOption(document.querySelector('.permission-btn'));

  assert.equal(document.querySelector('.permission-input-wrap').style.display, 'flex');
  assert.equal(content.scrollTop, content.scrollHeight);
});

test('Claude plan and prompt dismissal keep their legacy reply values', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'claude-session',
    requestId: 'plan-approval',
    kind: 'plan',
    toolName: 'ExitPlanMode',
    plan: 'Deploy after tests pass.',
    input: {},
  });
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[0]);
  assert.equal(sent[0].decision, 'answer');
  assert.equal(sent[0].answerText, 'Approved, proceed with the plan.');

  reset();
  window.showPermissionPrompt({
    sessionId: 'claude-session',
    requestId: 'tool-close',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd' },
  });
  window.cancelPermissionPrompt();
  assert.equal(sent[0].decision, 'deny');
  assert.equal(sent[0].approvalResponse, undefined);
});

test('Codex file approval uses file-specific session wording', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'file-approval',
    kind: 'tool',
    toolName: 'Edit',
    approvalType: 'codex-file-change',
    input: {
      path: '/tmp/project',
      codexApproval: {
        availableDecisions: ['accept', 'acceptForSession', 'cancel'],
      },
    },
  });

  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    [
      'Yes, proceed',
      "Yes, and don't ask again for these files",
      'No, and tell Codex what to do differently',
    ],
  );
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);
  assert.equal(sent[0].decision, 'acceptForSession');
});

test('Codex permission approval renders four TUI choices and returns only an action', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'permissions-approval',
    kind: 'tool',
    toolName: 'Permissions',
    approvalType: 'codex-permissions',
    input: {
      cwd: '/tmp/project',
      reason: 'Deploy the service',
      codexPermissions: {
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ['/tmp/input'],
            write: ['/tmp/output'],
          },
        },
      },
    },
  });

  assert.equal(document.querySelector('.permission-title').textContent, 'Grant additional permissions?');
  assert.match(document.querySelector('.permission-desc').textContent, /Network access/);
  assert.match(document.querySelector('.permission-desc').textContent, /Read: \/tmp\/input/);
  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    [
      'Yes, grant these permissions for this turn',
      'Yes, grant for this turn with strict auto review',
      'Yes, grant these permissions for this session',
      'No, continue without permissions',
    ],
  );

  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);
  assert.deepEqual(sent[0], {
    action: 'permission_reply',
    sessionId: 'codex:thread-1',
    device: 'test-ec2-ap',
    requestId: 'permissions-approval',
    approvalResponse: {
      action: 'grantForTurnWithStrictAutoReview',
    },
  });
});

test('closing a Codex permission approval safely denies the extra permissions', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'permissions-close',
    kind: 'tool',
    toolName: 'Permissions',
    approvalType: 'codex-permissions',
    input: { codexPermissions: { permissions: {} } },
  });

  window.cancelPermissionPrompt();
  assert.deepEqual(sent[0].approvalResponse, { action: 'deny' });
});

test('Codex MCP tool approval renders persistence choices from metadata', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'mcp-approval',
    kind: 'tool',
    toolName: 'cloudlab',
    approvalType: 'codex-mcp-elicitation',
    input: {
      codexMcpElicitation: {
        serverName: 'cloudlab',
        message: 'Run deploy?',
        responseMode: 'approval',
        isToolApproval: true,
        persistModes: ['session', 'always'],
        fields: [],
      },
    },
  });

  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    ['Allow', 'Allow for this session', 'Always allow', 'Cancel'],
  );
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);
  assert.deepEqual(sent[0].approvalResponse, { action: 'acceptForSession' });
});

test('Codex generic MCP approval includes both decline and cancel', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'mcp-generic',
    kind: 'tool',
    toolName: 'cloudlab',
    approvalType: 'codex-mcp-elicitation',
    input: {
      codexMcpElicitation: {
        serverName: 'cloudlab',
        message: 'Provide access?',
        responseMode: 'approval',
        isToolApproval: false,
        persistModes: [],
        fields: [],
      },
    },
  });

  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    ['Allow', 'Deny', 'Cancel'],
  );
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);
  assert.deepEqual(sent[0].approvalResponse, { action: 'decline' });
});

test('Codex MCP form collects typed and selected values in schema order', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'mcp-form',
    kind: 'tool',
    toolName: 'cloudlab',
    approvalType: 'codex-mcp-elicitation',
    input: {
      codexMcpElicitation: {
        serverName: 'cloudlab',
        message: 'Configure deployment',
        responseMode: 'form',
        isToolApproval: false,
        persistModes: [],
        fields: [
          {
            id: 'name',
            label: 'Name',
            prompt: 'Deployment name',
            required: true,
            input: { type: 'text' },
          },
          {
            id: 'enabled',
            label: 'Enabled',
            prompt: 'Enable deployment',
            required: true,
            input: {
              type: 'select',
              options: [
                { label: 'True', value: true },
                { label: 'False', value: false },
              ],
              defaultIndex: 0,
            },
          },
          {
            id: 'tier',
            label: 'Tier',
            prompt: 'Deployment tier',
            required: false,
            input: {
              type: 'select',
              options: [
                { label: 'Development', value: 'dev' },
                { label: 'Production', value: 'prod' },
              ],
              defaultIndex: null,
            },
          },
        ],
      },
    },
  });

  assert.equal(document.querySelector('.permission-title').textContent, '[1/3] Name');
  const input = document.querySelector('.permission-input');
  input.value = 'demo';
  window.submitPermissionWithInput(input, 'mcp-text');
  assert.equal(document.querySelector('.permission-title').textContent, '[2/3] Enabled');
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[0]);
  assert.equal(document.querySelector('.permission-title').textContent, '[3/3] Tier');
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);

  assert.deepEqual(sent[0].approvalResponse, {
    action: 'acceptForm',
    content: {
      name: 'demo',
      enabled: true,
      tier: 'prod',
    },
  });
});

test('unsupported MCP form falls back to the native three approval actions', () => {
  reset();
  window.showPermissionPrompt({
    sessionId: 'codex:thread-1',
    requestId: 'mcp-unsupported',
    kind: 'tool',
    toolName: 'cloudlab',
    approvalType: 'codex-mcp-elicitation',
    input: {
      codexMcpElicitation: {
        serverName: 'cloudlab',
        message: 'Open external URL',
        responseMode: 'fallback',
        isToolApproval: false,
        persistModes: [],
        fields: [],
      },
    },
  });

  assert.deepEqual(
    [...document.querySelectorAll('.permission-label')].map((el) => el.textContent),
    [
      'Yes, provide the requested info',
      'No, but continue without it',
      'Cancel',
    ],
  );
  window.handlePermissionOption(document.querySelectorAll('.permission-btn')[1]);
  assert.deepEqual(sent[0].approvalResponse, { action: 'decline' });
});
