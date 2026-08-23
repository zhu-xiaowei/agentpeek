import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  claudeRuntime,
  discoverClaudeSessions,
  removeClaudeSessionHistoryFiles,
} from '../../bridge/claude-runtime.mjs';
import { ClaudePool } from '../../bridge/headless.mjs';
import {
  getSessionStatus,
  resolveAgentMetadata,
  statusFromEntry,
} from '../../bridge/session.mjs';
import { preferPendingInteraction } from '../../bridge/watcher.mjs';

function agent(sessionId, state = 'blocked') {
  return {
    id: sessionId.slice(0, 8),
    sessionId,
    kind: 'background',
    name: 'Background task',
    state,
    waitingFor: 'Old daemon question',
  };
}

function sessionFixture(sessionId, tail = 'completed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-agent-status-'));
  const project = '-tmp-agent-project';
  const projectDir = path.join(root, project);
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  const rows = [{
    type: 'user',
    uuid: `${sessionId}-user`,
    timestamp: '2026-08-10T00:00:00.000Z',
    message: { content: 'Continue' },
  }];
  if (tail === 'completed') {
    rows.push({
      type: 'assistant',
      uuid: `${sessionId}-assistant`,
      timestamp: '2026-08-10T00:00:01.000Z',
      message: {
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      },
    });
  }
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join('\n')}\n`);
  return { root, project, filePath };
}

const noProcesses = () => ({ projects: new Set(), sessions: new Set() });

function writeRows(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join('\n')}\n`);
}

test('roster-active blocked agent uses daemon status and current question', () => {
  const sessionId = '11111111-1111-4111-8111-111111111111';
  assert.deepEqual(resolveAgentMetadata(agent(sessionId), {
    daemonActive: true,
    agentDetail: 'Current daemon question',
  }), {
    isAgent: true,
    agentName: 'Background task',
    agentDetail: 'Current daemon question',
    status: 'needs_input',
  });
});

test('roster-active working agent is running without input detail', () => {
  const sessionId = '22222222-2222-4222-8222-222222222222';
  assert.deepEqual(resolveAgentMetadata(agent(sessionId, 'working'), {
    daemonActive: true,
    agentDetail: 'Must not leak',
  }), {
    isAgent: true,
    agentName: 'Background task',
    agentDetail: '',
    status: 'running',
  });
});

test('roster-active done agent is completed without stale detail', () => {
  const sessionId = '23232323-2323-4232-8232-232323232323';
  assert.deepEqual(resolveAgentMetadata(agent(sessionId, 'done'), {
    daemonActive: true,
    agentDetail: 'Must not leak',
  }), {
    isAgent: true,
    agentName: 'Background task',
    agentDetail: '',
    status: 'completed',
  });
});

test('headless-taken-over blocked ghost falls back to completed jsonl', () => {
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const fixture = sessionFixture(sessionId);
  try {
    assert.deepEqual(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo: noProcesses(),
      agentDetail: 'Stale question',
    }), {
      isAgent: true,
      agentName: 'Background task',
      agentDetail: '',
      status: 'completed',
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('inactive historical agent resumed by an external process can be running', () => {
  const sessionId = '44444444-4444-4444-8444-444444444444';
  const fixture = sessionFixture(sessionId, 'running');
  try {
    assert.deepEqual(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo: {
        projects: new Set([fixture.project]),
        sessions: new Set([sessionId]),
      },
      agentDetail: 'Stale question',
    }), {
      isAgent: true,
      agentName: 'Background task',
      agentDetail: '',
      status: 'running',
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('inactive agent with unfinished jsonl but no process is completed', () => {
  const sessionId = '45454545-4545-4454-8454-454545454545';
  const fixture = sessionFixture(sessionId, 'running');
  try {
    assert.deepEqual(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo: noProcesses(),
      agentDetail: 'Stale question',
    }), {
      isAgent: true,
      agentName: 'Background task',
      agentDetail: '',
      status: 'completed',
    });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fresh end_turn completes immediately after running content', () => {
  const sessionId = '46464646-4646-4464-8464-464646464646';
  const fixture = sessionFixture(sessionId, 'running');
  const runningInfo = {
    projects: new Set([fixture.project]),
    sessions: new Set([sessionId]),
  };
  try {
    assert.equal(
      getSessionStatus(sessionId, fixture.filePath, runningInfo),
      'running',
    );
    fs.appendFileSync(fixture.filePath, `${JSON.stringify({
      type: 'assistant',
      uuid: `${sessionId}-assistant`,
      timestamp: '2026-08-10T00:00:01.000Z',
      message: {
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      },
    })}\n`);
    assert.equal(
      getSessionStatus(sessionId, fixture.filePath, runningInfo),
      'completed',
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('inactive agent with missing history is completed but keeps identity', () => {
  const sessionId = '55555555-5555-4555-8555-555555555555';
  assert.deepEqual(resolveAgentMetadata(agent(sessionId), {
    daemonActive: false,
    filePath: null,
    runningInfo: noProcesses(),
    agentDetail: 'Stale question',
  }), {
    isAgent: true,
    agentName: 'Background task',
    agentDetail: '',
    status: 'completed',
  });
});

test('startup discovery does not resurrect needs_input after headless takeover', () => {
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const fixture = sessionFixture(sessionId);
  try {
    const effectiveAgent = resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo: noProcesses(),
      agentDetail: 'Stale question',
    });
    const catalog = discoverClaudeSessions({
      claudeProjectsRoot: fixture.root,
      runningInfo: noProcesses(),
      daemonMeta: new Map([[sessionId, effectiveAgent]]),
    });
    assert.equal(catalog.sessions.length, 1);
    assert.equal(catalog.sessions[0].isAgent, true);
    assert.equal(catalog.sessions[0].agentName, 'Background task');
    assert.equal(catalog.sessions[0].agentDetail, '');
    assert.equal(catalog.sessions[0].status, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('deleting standalone Claude history removes only that session file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-delete-single-'));
  const projectDir = path.join(root, '-repo');
  const sessionId = '12121212-1212-4212-8212-121212121212';
  const otherId = '13131313-1313-4313-8313-131313131313';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const otherPath = path.join(projectDir, `${otherId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(filePath, '{}\n');
  fs.writeFileSync(otherPath, '{}\n');
  const watermarks = new Map([[sessionId, 1], [otherId, 1]]);
  try {
    assert.equal(removeClaudeSessionHistoryFiles(filePath, sessionId, {
      projectsRoot: root,
      watermarks,
    }), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(otherPath), true);
    assert.equal(watermarks.has(sessionId), false);
    assert.equal(watermarks.has(otherId), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('deleting Claude root history removes all nested subagent files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-delete-agents-'));
  const projectDir = path.join(root, '-repo');
  const sessionId = '14141414-1414-4414-8414-141414141414';
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  const sessionDir = path.join(projectDir, sessionId);
  const childPath = path.join(sessionDir, 'subagents', 'agent-child.jsonl');
  const nestedPath = path.join(sessionDir, 'subagents', 'nested', 'agent-grandchild.jsonl');
  fs.mkdirSync(path.dirname(nestedPath), { recursive: true });
  fs.writeFileSync(filePath, '{}\n');
  fs.writeFileSync(childPath, '{}\n');
  fs.writeFileSync(nestedPath, '{}\n');
  const childId = `${sessionId}:subagent:agent-child`;
  const grandchildId = `${sessionId}:subagent:agent-grandchild`;
  const watermarks = new Map([
    [sessionId, 1],
    [childId, 1],
    [grandchildId, 1],
    ['unrelated', 1],
  ]);
  try {
    assert.equal(removeClaudeSessionHistoryFiles(filePath, sessionId, {
      projectsRoot: root,
      watermarks,
    }), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(fs.existsSync(sessionDir), false);
    assert.deepEqual([...watermarks.keys()], ['unrelated']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude inline subagents are discovered as child threads', () => {
  const parentId = '65656565-6565-4656-8656-656565656565';
  const fixture = sessionFixture(parentId);
  try {
    const subagentsDir = path.join(
      path.dirname(fixture.filePath),
      parentId,
      'subagents',
    );
    fs.mkdirSync(subagentsDir, { recursive: true });
    const parentAgentFile = path.join(subagentsDir, 'agent-parent.jsonl');
    writeRows(parentAgentFile, [{
      type: 'user',
      uuid: 'parent-agent-user',
      sessionId: parentId,
      timestamp: '2026-08-10T00:00:01.000Z',
      message: { content: 'Coordinate child work' },
    }]);
    fs.writeFileSync(
      parentAgentFile.replace(/\.jsonl$/, '.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Parent agent',
        toolUseId: 'tool-parent',
        spawnDepth: 1,
      }),
    );
    const childFile = path.join(subagentsDir, 'agent-a1b2c3.jsonl');
    writeRows(childFile, [{
      type: 'user',
      uuid: 'child-user',
      sessionId: parentId,
      timestamp: '2026-08-10T00:00:02.000Z',
      message: { content: 'Inspect the tests' },
    }, {
      type: 'assistant',
      uuid: 'child-assistant',
      sessionId: parentId,
      timestamp: '2026-08-10T00:00:03.000Z',
      message: {
        model: 'claude-test',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Inspection complete' }],
      },
    }]);
    fs.writeFileSync(
      childFile.replace(/\.jsonl$/, '.meta.json'),
      JSON.stringify({
        agentType: 'Explore',
        description: 'Inspect test coverage',
        toolUseId: 'tool-1',
        parentAgentId: 'parent',
        spawnDepth: 2,
      }),
    );

    const catalog = discoverClaudeSessions({
      claudeProjectsRoot: fixture.root,
      runningInfo: noProcesses(),
      daemonMeta: new Map(),
      now: Date.parse('2026-08-10T00:01:00.000Z'),
    });
    assert.equal(catalog.sessions.length, 3);
    const parentAgent = catalog.sessions.find(
      (session) => session.agentPath === 'agent-parent',
    );
    const child = catalog.sessions.find(
      (session) => session.agentPath === 'agent-a1b2c3',
    );
    assert.ok(parentAgent);
    assert.ok(child);
    assert.equal(child.threadKind, 'subagent');
    assert.equal(parentAgent.parentSessionId, parentId);
    assert.equal(
      child.parentSessionId,
      `${parentId}:subagent:agent-parent`,
    );
    assert.equal(child.agentName, 'Inspect test coverage');
    assert.equal(child.agentPath, 'agent-a1b2c3');
    assert.equal(child.agentDepth, 2);
    assert.equal(child.canSend, false);
    assert.equal(child.status, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stopped polling settles an inactive historical agent without dropping its identity', () => {
  const sessionId = '67676767-6767-4676-8676-676767676767';
  const fixture = sessionFixture(sessionId, 'running');
  try {
    const result = claudeRuntime.inspectActiveSession({
      sessionId,
      nativeSessionId: sessionId,
      deviceName: 'test-device',
      projectHash: fixture.project,
      preview: 'Historical agent',
      lastActive: '2026-07-17T00:00:00.000Z',
      status: 'running',
    }, {
      daemonMeta: new Map([[sessionId, {
        isAgent: true,
        agentName: 'Historical agent',
        agentDetail: '',
        status: 'completed',
      }]]),
      daemonRunning: new Set(),
      poolOwns: () => false,
      runningInfo: noProcesses(),
      lastKnownStatus: new Map([[sessionId, 'running']]),
      findSessionFile: () => fixture.filePath,
    });

    assert.equal(result.session.status, 'completed');
    assert.equal(result.session.isAgent, true);
    assert.equal(result.session.agentName, 'Historical agent');
    assert.equal(result.session.agentDetail, '');
    assert.equal(result.statusDelta.from, 'running');
    assert.equal(result.statusDelta.to, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pool status writes clear stale detail except for current needs_input', async () => {
  const sessionId = '77777777-7777-4777-8777-777777777777';
  const fixture = sessionFixture(sessionId);
  const daemonMeta = new Map([[sessionId, {
    isAgent: true,
    agentName: 'Background task',
    agentDetail: 'Stale daemon question',
    status: 'needs_input',
  }]]);
  try {
    for (const item of [
      { previous: 'needs_input', next: 'running', detail: undefined, expected: '' },
      { previous: 'running', next: 'completed', detail: undefined, expected: '' },
      { previous: 'running', next: 'needs_input', detail: 'Current control question', expected: 'Current control question' },
      { previous: 'running', next: 'needs_input', detail: '', expected: '' },
    ]) {
      let request;
      await claudeRuntime.updateSessionStatus(
        { deviceName: 'test-device' },
        sessionId,
        fixture.filePath,
        fixture.project,
        item.next,
        item.detail,
        {
          daemonMeta,
          lastKnownStatus: new Map([[sessionId, item.previous]]),
          postFn: async (_url, body) => { request = body; },
        },
      );
      assert.equal(request.sessions[0].isAgent, true);
      assert.equal(request.sessions[0].agentName, 'Background task');
      assert.equal(request.sessions[0].agentDetail, item.expected);
      assert.equal(request.sessions[0].status, item.next);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('regular Claude sessions persist the current interaction detail', async () => {
  const sessionId = '78787878-7878-4787-8787-787878787878';
  const fixture = sessionFixture(sessionId);
  let request;
  try {
    await claudeRuntime.updateSessionStatus(
      { deviceName: 'test-device' },
      sessionId,
      fixture.filePath,
      fixture.project,
      'needs_input',
      'Allow writing the test file?',
      {
        daemonMeta: new Map(),
        lastKnownStatus: new Map([[sessionId, 'running']]),
        postFn: async (_url, body) => { request = body; },
      },
    );
    assert.equal(request.sessions[0].isAgent, undefined);
    assert.equal(request.sessions[0].status, 'needs_input');
    assert.equal(request.sessions[0].agentDetail, 'Allow writing the test file?');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('first interaction status registers a new Claude session', async () => {
  const sessionId = '79707070-7970-4797-8797-797070707070';
  const fixture = sessionFixture(sessionId, 'running');
  let request;
  const statuses = new Map();
  try {
    await claudeRuntime.updateSessionStatus(
      { deviceName: 'test-device' },
      sessionId,
      fixture.filePath,
      fixture.project,
      'running',
      undefined,
      {
        isNew: true,
        daemonMeta: new Map(),
        lastKnownStatus: statuses,
        postFn: async (_url, body) => { request = body; },
      },
    );
    assert.equal(request.sessions[0].status, 'running');
    assert.equal(request.statusDeltas[0].from, 'new');
    assert.equal(request.statusDeltas[0].to, 'running');
    assert.equal(statuses.get(sessionId), 'running');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('pending Hook interaction overrides JSONL running status', () => {
  assert.deepEqual(
    preferPendingInteraction('running', 'printf test > /tmp/test.txt'),
    { status: 'needs_input', detail: 'printf test > /tmp/test.txt' },
  );
  assert.deepEqual(
    preferPendingInteraction('completed', null),
    { status: 'completed', detail: null },
  );
});

test('interaction status refreshes the server even when the local status matches', async () => {
  const sessionId = '79797979-7979-4797-8797-797979797979';
  const fixture = sessionFixture(sessionId);
  let request;
  const statuses = new Map([[sessionId, 'needs_input']]);
  try {
    await claudeRuntime.updateSessionStatus(
      { deviceName: 'test-device' },
      sessionId,
      fixture.filePath,
      fixture.project,
      'needs_input',
      'Current command',
      {
        daemonMeta: new Map(),
        lastKnownStatus: statuses,
        postFn: async (_url, body) => { request = body; },
      },
    );
    assert.equal(request.sessions[0].status, 'needs_input');
    assert.equal(request.sessions[0].agentDetail, 'Current command');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('failed interaction status writes do not advance the local status cache', async () => {
  const sessionId = '80808080-8080-4808-8808-808080808080';
  const fixture = sessionFixture(sessionId);
  const statuses = new Map([[sessionId, 'running']]);
  try {
    await assert.rejects(() => claudeRuntime.updateSessionStatus(
      { deviceName: 'test-device' },
      sessionId,
      fixture.filePath,
      fixture.project,
      'needs_input',
      'Current command',
      {
        daemonMeta: new Map(),
        lastKnownStatus: statuses,
        postFn: async () => { throw new Error('network down'); },
      },
    ));
    assert.equal(statuses.get(sessionId), 'running');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('terminal interaction tools are needs_input while ordinary tools keep running', () => {
  for (const [name, stopReason, expected] of [
    ['AskUserQuestion', 'tool_use', 'needs_input'],
    ['AskUserQuestion', null, 'needs_input'],
    ['ExitPlanMode', 'tool_use', 'needs_input'],
    ['Bash', 'tool_use', 'running'],
  ]) {
    assert.equal(statusFromEntry({
      type: 'assistant',
      message: {
        stop_reason: stopReason,
        content: [{ type: 'tool_use', name, input: {} }],
      },
    }), expected);
  }
});

test('idle pooled process no longer owns session status', () => {
  const sessionId = '88888888-8888-4888-8888-888888888888';
  const pool = new ClaudePool();
  const proc = { busy: true, dead: false, shutdown() {} };
  try {
    pool.procs.set(sessionId, proc);
    assert.equal(pool.owns(sessionId), true);
    assert.equal(pool.isBusy(sessionId), true);
    proc.busy = false;
    assert.equal(pool.owns(sessionId), true);
    assert.equal(pool.isBusy(sessionId), false);
  } finally {
    pool.shutdownAll();
  }
});

test('agent moves from daemon needs_input through web completion to immediate terminal completion', async () => {
  const sessionId = '99999999-9999-4999-8999-999999999999';
  const fixture = sessionFixture(sessionId);
  const daemon = resolveAgentMetadata(agent(sessionId), {
    daemonActive: true,
    agentDetail: 'Daemon question',
  });
  const daemonMeta = new Map([[sessionId, daemon]]);
  try {
    assert.equal(daemon.status, 'needs_input');

    for (const [previous, next] of [
      ['needs_input', 'running'],
      ['running', 'completed'],
    ]) {
      let request;
      await claudeRuntime.updateSessionStatus(
        { deviceName: 'test-device' },
        sessionId,
        fixture.filePath,
        fixture.project,
        next,
        undefined,
        {
          daemonMeta,
          lastKnownStatus: new Map([[sessionId, previous]]),
          postFn: async (_url, body) => { request = body; },
        },
      );
      assert.equal(request.sessions[0].status, next);
      assert.equal(request.sessions[0].agentDetail, '');
    }

    const runningInfo = {
      projects: new Set([fixture.project]),
      sessions: new Set([sessionId]),
    };
    const terminalRows = [{
      type: 'user',
      message: { content: 'Continue in terminal' },
    }];
    writeRows(fixture.filePath, terminalRows);
    assert.equal(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo,
    }).status, 'running');

    terminalRows.push({
      type: 'assistant',
      message: {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Proceed?' }] },
        }],
      },
    });
    writeRows(fixture.filePath, terminalRows);
    const waiting = resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo,
    });
    assert.equal(waiting.status, 'needs_input');
    assert.equal(waiting.agentDetail, '');

    terminalRows.push({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'ask-1',
          content: 'Proceed',
        }],
      },
    });
    writeRows(fixture.filePath, terminalRows);
    assert.equal(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo,
    }).status, 'running');

    terminalRows.push({
      type: 'assistant',
      message: {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Done' }],
      },
    });
    writeRows(fixture.filePath, terminalRows);
    assert.equal(resolveAgentMetadata(agent(sessionId), {
      daemonActive: false,
      filePath: fixture.filePath,
      runningInfo,
    }).status, 'completed');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
