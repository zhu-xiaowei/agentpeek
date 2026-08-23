import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import test from 'node:test';
import {
  codexSessionIdFromPath,
  discoverCodexSessions,
  inspectCodexSession,
  scanCodexRollout,
} from '../../../bridge/codex-session.mjs';
import {
  extractCodexMessages,
  parseApplyPatchInput,
  syncCodexMessages,
} from '../../../bridge/codex-extract.mjs';
import { codexLiveSource } from '../../../bridge/codex-live.mjs';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures/codex',
  `rollout-2026-08-06T00-00-00-${SESSION_ID}.jsonl`,
);

function tempRollout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-codex-'));
  const dir = path.join(root, 'sessions', '2026', '08', '06');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, path.basename(FIXTURE));
  fs.copyFileSync(FIXTURE, target);
  return { root, target };
}

test('rollout filename is the native session identity', () => {
  assert.equal(codexSessionIdFromPath(FIXTURE), SESSION_ID);
  assert.equal(codexSessionIdFromPath('/tmp/not-a-rollout.jsonl'), '');
});

test('metadata scan selects matching session_meta and ignores injected previews', () => {
  const result = scanCodexRollout(FIXTURE, {
    now: Date.parse('2026-08-06T00:01:00.000Z'),
    runningInfo: { projects: new Set(), sessions: new Set() },
  });
  assert.ok(result.session);
  assert.equal(result.session.nativeSessionId, SESSION_ID);
  assert.equal(result.session.project, '-tmp-baton-codex-target');
  assert.equal(result.session.preview, 'Inspect the repository');
  assert.equal(result.session.model, 'gpt-test');
  assert.equal(result.session.modelProvider, 'openai');
  assert.equal(result.session.clientSource, 'codex-tui');
  assert.equal(result.session.cliVersion, '1.2.3');
  assert.equal(result.session.status, 'completed');
  assert.equal(result.malformedLines, 1);
  assert.equal(result.trailingMalformed, true);
});

test('subagent metadata keeps the native parent and thread identity', () => {
  const { root, target } = tempRollout();
  try {
    const parentId = '11111111-1111-4111-8111-111111111111';
    const entries = [{
      timestamp: '2026-08-21T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        session_id: parentId,
        parent_thread_id: parentId,
        forked_from_id: parentId,
        cwd: '/tmp/baton-codex-target',
        cli_version: '0.146.1',
        model_provider: 'amazon-bedrock',
        thread_source: 'subagent',
        agent_path: '/root/worker',
        agent_nickname: 'Worker',
        agent_role: 'explorer',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
              depth: 2,
              agent_path: '/root/worker',
              agent_nickname: 'Worker',
              agent_role: 'explorer',
            },
          },
        },
      },
    }, {
      timestamp: '2026-08-21T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Parent request' },
    }, {
      timestamp: '2026-08-21T12:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Delegated work' },
    }];
    fs.writeFileSync(target, `${entries.map(JSON.stringify).join('\n')}\n`);

    const result = scanCodexRollout(target, {
      now: Date.parse('2026-08-21T12:00:02.000Z'),
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(result.session.threadKind, 'subagent');
    assert.equal(result.session.parentSessionId, `codex:${parentId}`);
    assert.equal(result.session.agentName, 'Worker');
    assert.equal(result.session.agentRole, 'explorer');
    assert.equal(result.session.agentPath, '/root/worker');
    assert.equal(result.session.agentDepth, 2);
    assert.equal(result.session.canSend, true);
    assert.equal(result.session.preview, 'Delegated work');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('internal Codex children are not exposed as user-switchable agents', () => {
  const { root, target } = tempRollout();
  try {
    const parentId = '33333333-3333-4333-8333-333333333333';
    const entries = [{
      timestamp: '2026-08-21T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        session_id: parentId,
        parent_thread_id: parentId,
        cwd: '/tmp/baton-codex-target',
        thread_source: 'subagent',
        source: { subagent: { other: 'guardian' } },
      },
    }, {
      timestamp: '2026-08-21T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Review this action' },
    }];
    fs.writeFileSync(target, `${entries.map(JSON.stringify).join('\n')}\n`);

    const result = scanCodexRollout(target, {
      now: Date.parse('2026-08-21T12:00:02.000Z'),
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(result.session.threadKind, 'internal');
    assert.equal(result.session.parentSessionId, `codex:${parentId}`);
    assert.equal(result.session.isAgent, false);
    assert.equal(result.session.canSend, false);
    assert.equal(result.session.agentName, '');
    assert.equal(result.session.agentRole, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared session inspection returns the same status used by runtime and writer checks', () => {
  const session = inspectCodexSession(SESSION_ID, {
    filePath: FIXTURE,
    now: Date.parse('2026-08-06T00:01:00.000Z'),
    runningInfo: { projects: new Set(), sessions: new Set() },
  });
  assert.equal(session?.status, 'completed');
});

test('response-only user messages provide metadata preview without exposing internal context', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      {
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: '/tmp/baton-codex-target',
          originator: 'codex-tui',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/tmp/baton-codex-target</cwd>\n</environment_context>',
          }],
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Why is this session missing?' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<subagent_notification>\n'
              + '{"agent_path":"child-id","status":{"completed":"/tmp/result"}}\n'
              + '</subagent_notification>',
          }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will inspect it.' }],
        },
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: `2026-08-09T12:00:0${index}.000Z`,
    }));
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const scanned = scanCodexRollout(target, {
      now: Date.parse('2026-08-09T12:00:06.000Z'),
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(scanned.session.preview, 'Why is this session missing?');
    assert.equal(scanned.session.status, 'running');

    const extracted = extractCodexMessages(target, SESSION_ID);
    assert.deepEqual(extracted.messages.map((message) => message.type), ['user', 'assistant']);
    assert.equal(extracted.messages[0].content, 'Why is this session missing?');

    entries.splice(4, 0, {
      timestamp: '2026-08-09T12:00:03.500Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Why is this session missing?' },
    });
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const legacyDuplicate = extractCodexMessages(target, SESSION_ID);
    assert.equal(
      legacyDuplicate.messages.filter((message) => message.type === 'user'
        && message.content === 'Why is this session missing?').length,
      1,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incremental extraction waits for the canonical Codex user event', () => {
  const { root, target } = tempRollout();
  try {
    const turnId = 'turn-incremental-user';
    const clientId = 'client-incremental-user';
    const responseItem = {
      timestamp: '2026-08-15T10:34:02.428Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '你是我吗' }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    };
    fs.writeFileSync(target, `${JSON.stringify(responseItem)}\n`);

    const first = extractCodexMessages(target, SESSION_ID);
    assert.equal(first.messages.length, 0);
    assert.equal(first.nextLine, 0);

    const userEvent = {
      timestamp: '2026-08-15T10:34:02.429Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        client_id: clientId,
        message: '你是我吗',
      },
    };
    fs.appendFileSync(target, `${JSON.stringify(userEvent)}\n`);

    const second = extractCodexMessages(target, SESSION_ID, { startLine: first.nextLine });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].content, '你是我吗');
    assert.equal(second.messages[0].nativeId, `codex:user:${clientId}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh open turn is running while stale orphan is completed', () => {
  const { root, target } = tempRollout();
  try {
    const lines = fs.readFileSync(target, 'utf-8').split('\n').slice(0, 7).join('\n');
    fs.writeFileSync(target, lines);
    const fresh = scanCodexRollout(target, {
      now: Date.now(),
      staleMs: 60_000,
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(fresh.session.status, 'running');

    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(target, old, old);
    const stale = scanCodexRollout(target, {
      now: Date.now(),
      staleMs: 60_000,
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(stale.session.status, 'completed');

    const processMatched = scanCodexRollout(target, {
      now: Date.now(),
      staleMs: 60_000,
      runningInfo: { projects: new Set([stale.session.project]), sessions: new Set() },
    });
    assert.equal(processMatched.session.status, 'running');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a later completed turn supersedes an older unterminated desktop turn', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      {
        type: 'session_meta',
        payload: {
          id: SESSION_ID,
          cwd: '/tmp/baton-codex-target',
          originator: 'Codex Desktop',
        },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Start the CloudLab environment' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'orphaned-turn' },
      },
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'latest-turn' },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'latest-turn',
          last_agent_message: 'Environment ready',
        },
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: `2026-08-13T09:35:0${index}.000Z`,
    }));
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const scanned = scanCodexRollout(target, {
      now: Date.parse('2026-08-13T15:35:00.000Z'),
      runningInfo: {
        projects: new Set(['-tmp-baton-codex-target']),
        sessions: new Set(),
      },
    });

    assert.equal(scanned.session.status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recursive discovery returns one catalog row and tolerates a half-written tail', () => {
  const { root } = tempRollout();
  try {
    const result = discoverCodexSessions({
      codexHomes: [root],
      now: Date.parse('2026-08-06T00:01:00.000Z'),
      runningInfo: { projects: new Set(), sessions: new Set() },
    });
    assert.equal(result.complete, true);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].nativeSessionId, SESSION_ID);
    assert.equal(result.diagnostics.trailingMalformedFiles, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex extraction filters duplicates and pairs reused call ids by occurrence', () => {
  const first = extractCodexMessages(FIXTURE, SESSION_ID);
  const second = extractCodexMessages(FIXTURE, SESSION_ID);
  assert.deepEqual(second, first);
  assert.equal(first.nextLine, 19);

  const text = first.messages.map((message) => JSON.stringify(message.content)).join('\n');
  assert.ok(text.includes('Inspect the repository'));
  assert.ok(text.includes('I will inspect it.'));
  assert.ok(text.includes('Final response'));
  assert.ok(!text.includes('internal instruction'));
  assert.ok(!text.includes('environment_context'));
  assert.equal(text.match(/I will inspect it\./g)?.length, 1);

  const toolUses = first.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_use') : []);
  const toolResults = first.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : []);
  assert.deepEqual(toolUses.map((block) => block.name), ['Bash', 'TodoWrite', 'Edit']);
  assert.equal(new Set(toolUses.map((block) => block.id)).size, 3);
  assert.deepEqual(
    new Set(toolResults.map((block) => block.tool_use_id)),
    new Set(toolUses.map((block) => block.id)),
  );
  assert.equal(toolResults.length, 3);

  const todo = toolUses.find((block) => block.name === 'TodoWrite');
  assert.deepEqual(todo.input.todos, [
    { content: 'Inspect', status: 'completed' },
    { content: 'Report', status: 'in_progress' },
  ]);
  const edit = toolUses.find((block) => block.name === 'Edit');
  assert.equal(edit.input.file_path, 'src/example.js');
  assert.equal(edit.input.old_string, 'old');
  assert.equal(edit.input.new_string, 'new');

  const keys = first.messages.map((message) => `${message.timestamp}#${message.uuid}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('Codex extraction emits each completed web search once', () => {
  const { root, target } = tempRollout();
  try {
    const search = {
      type: 'WebSearch',
      id: 'ws-1',
      query: 'site:example.com watcher',
      action: {
        type: 'search',
        query: 'site:example.com watcher',
        queries: ['site:example.com watcher', 'site:example.com fs events'],
      },
    };
    const entries = [
      {
        timestamp: '2026-08-10T01:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', item: search },
      },
      {
        timestamp: '2026-08-10T01:00:00.001Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: search.id,
          status: 'completed',
          action: search.action,
        },
      },
      {
        timestamp: '2026-08-10T01:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: 'ws-fallback',
          status: 'completed',
          action: {
            type: 'open_page',
            url: 'https://example.com/docs',
          },
        },
      },
    ];
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    const uses = extracted.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_use')
        : []);
    const results = extracted.messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === 'tool_result')
        : []);

    assert.equal(uses.length, 2);
    assert.deepEqual(uses.map((use) => use.name), ['WebSearch', 'WebSearch']);
    assert.equal(uses[0].input.query, 'site:example.com watcher');
    assert.equal(uses[1].input.url, 'https://example.com/docs');
    assert.deepEqual(
      new Set(results.map((result) => result.tool_use_id)),
      new Set(uses.map((use) => use.id)),
    );
    assert.deepEqual(
      extracted.messages.map(codexLiveSource),
      ['item:ws-1', 'item:ws-1', 'item:ws-fallback', 'item:ws-fallback'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP namespace supplies identity before completion and supersedes the generic wrapper', () => {
  const { root, target } = tempRollout();
  try {
    const callId = 'call-mcp-js';
    const entries = [
      {
        timestamp: '2026-08-10T01:30:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'js',
          namespace: 'mcp__node_repl',
          call_id: callId,
          arguments: JSON.stringify({
            code: 'nodeRepl.write("ok")',
            timeout_ms: 30_000,
          }),
        },
      },
      {
        timestamp: '2026-08-10T01:30:00.100Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'McpToolCall',
            id: callId,
            server: 'node_repl',
            tool: 'js',
            status: 'completed',
            result: {
              content: [{ type: 'text', text: 'ok' }],
              isError: false,
            },
          },
        },
      },
      {
        timestamp: '2026-08-10T01:30:00.200Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: 'Wall time: 0.1000 seconds\nOutput:\n[{"type":"text","text":"ok"}]',
        },
      },
    ];
    fs.writeFileSync(target, `${JSON.stringify(entries[0])}\n`);
    const started = extractCodexMessages(target, SESSION_ID);
    const startedUse = started.messages[0].content[0];
    assert.equal(startedUse.input.codexMcpServer, 'node_repl');
    assert.equal(startedUse.input.codexMcpTool, 'js');

    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    const blocks = extracted.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []);
    const use = blocks.find((block) => block.type === 'tool_use');
    const results = blocks.filter((block) => block.type === 'tool_result');

    assert.equal(use.name, 'js');
    assert.equal(use.input.codexMcpServer, 'node_repl');
    assert.equal(use.input.codexMcpTool, 'js');
    assert.equal(results.length, 2);
    assert.equal(results[0].tool_use_id, use.id);
    assert.equal(results[0].content, 'ok');
    assert.equal(results[0].codexMcpServer, 'node_repl');
    assert.equal(results[0].codexMcpTool, 'js');
    assert.equal(results[1].tool_use_id, use.id);
    assert.equal(results[1].codexSuperseded, true);

    const incremental = extractCodexMessages(target, SESSION_ID, { startLine: 1 });
    assert.equal(incremental.messages[0].content[0].tool_use_id, use.id);
    assert.equal(incremental.messages[0].content[0].content, 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('completed background commands replace the initial running result', () => {
  const { root, target } = tempRollout();
  try {
    const callId = 'call-background-1';
    const entries = [
      {
        timestamp: '2026-08-10T01:00:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: callId,
          arguments: JSON.stringify({ cmd: 'sleep 1; echo done' }),
        },
      },
      {
        timestamp: '2026-08-10T01:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: callId,
          output: 'Process running with session ID 42',
        },
      },
      {
        timestamp: '2026-08-10T01:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: callId,
            status: 'completed',
            exit_code: 0,
            stdout: 'done\n',
          },
        },
      },
    ];
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    const use = extracted.messages[0].content[0];
    const results = extracted.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .filter((block) => block.type === 'tool_result');

    assert.equal(use.name, 'Bash');
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.tool_use_id === use.id));
    assert.equal(results[1].content, 'done');
    assert.equal(results[1].codexExitCode, 0);
    assert.equal(results[1].codexLabel, undefined);
    assert.equal(results[1].codexBackground, 'complete');
    assert.equal(results[1].codexCommandKind, 'ran');
    assert.equal(results[1].is_error, false);
    assert.ok(extracted.messages.every((message) =>
      codexLiveSource(message) === `item:${callId}`));

    const incremental = extractCodexMessages(target, SESSION_ID, { startLine: 2 });
    assert.equal(incremental.messages.length, 1);
    assert.equal(incremental.messages[0].content[0].tool_use_id, use.id);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CommandExecution metadata separates Ran commands from background wait streaks', () => {
  const { root, target } = tempRollout();
  try {
    const backgroundId = 'call-background';
    const foregroundId = 'call-foreground';
    const exploreId = 'call-explore';
    const userShellId = 'call-user-shell';
    const waitId = 'call-wait';
    const entries = [
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: exploreId,
          arguments: JSON.stringify({ cmd: "sed -n '1,120p' mcp.rs" }),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: exploreId,
            source: 'unified_exec_startup',
            status: 'completed',
            exit_code: 0,
            stdout: 'source\n',
            parsed_cmd: [{
              type: 'read',
              cmd: "sed -n '1,120p' mcp.rs",
              name: 'mcp.rs',
              path: 'mcp.rs',
            }],
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: backgroundId,
          arguments: JSON.stringify({ cmd: 'sleep 75; check fleet' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: backgroundId,
          output: 'Process running with session ID 42',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'write_stdin',
          call_id: waitId,
          arguments: JSON.stringify({ session_id: 42, chars: '' }),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: waitId,
          output: 'Process running with session ID 42',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: foregroundId,
          arguments: JSON.stringify({
            cmd: 'git diff --stat; git diff --check; find test -type f',
          }),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: foregroundId,
            source: 'unified_exec_startup',
            process_id: '43',
            status: 'completed',
            exit_code: 0,
            stdout: 'test/a.test.mjs\n',
            parsed_cmd: [{
              type: 'unknown',
              cmd: 'git diff --stat; git diff --check; find test -type f',
            }],
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: foregroundId,
          output: 'Process running with session ID 43',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: userShellId,
          arguments: JSON.stringify({ cmd: 'cat README.md' }),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: userShellId,
            source: 'user_shell',
            status: 'completed',
            exit_code: 0,
            stdout: '# README\n',
            parsed_cmd: [{ type: 'read', name: 'README.md', path: 'README.md' }],
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Fleet is still updating.' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: backgroundId,
            source: 'unified_exec_startup',
            process_id: '42',
            status: 'completed',
            exit_code: 0,
            stdout: 'fleet checked\n',
            parsed_cmd: [{
              type: 'unknown',
              cmd: 'sleep 75; check fleet',
            }],
          },
        },
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: `2026-08-10T03:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    const blocks = extracted.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []);
    const uses = new Map(blocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => [block.id, block]));
    const results = blocks.filter((block) => block.type === 'tool_result');
    const foregroundUse = [...uses.values()]
      .find((use) => use.input.command?.startsWith('git diff'));
    const backgroundUse = [...uses.values()]
      .find((use) => use.input.command?.startsWith('sleep 75'));
    const userShellUse = [...uses.values()]
      .find((use) => use.input.command === 'cat README.md');
    const exploreUse = [...uses.values()]
      .find((use) => use.input.command === "sed -n '1,120p' mcp.rs");
    const waitUse = [...uses.values()].find((use) => use.name === 'WriteStdin');
    const foregroundResults = results.filter((result) =>
      result.tool_use_id === foregroundUse.id);
    const backgroundResults = results.filter((result) =>
      result.tool_use_id === backgroundUse.id);
    const waitResult = results.find((result) => result.tool_use_id === waitUse.id);

    assert.equal(foregroundUse.input.codexCommandKind, 'ran');
    assert.equal(foregroundResults[0].content, 'test/a.test.mjs');
    assert.equal(foregroundResults[0].codexExitCode, 0);
    assert.equal(foregroundResults[0].codexCommandKind, 'ran');
    assert.equal(foregroundResults[1].codexSuperseded, true);
    assert.equal(foregroundResults.some((result) => result.codexBackground), false);

    assert.equal(exploreUse.input.codexCommandKind, 'explore');
    assert.deepEqual(exploreUse.input.codexCommandActions, [{
      type: 'read',
      cmd: "sed -n '1,120p' mcp.rs",
      name: 'mcp.rs',
      path: 'mcp.rs',
    }]);

    assert.equal(backgroundResults[0].codexBackground, 'running');
    assert.equal(backgroundResults[1].codexBackground, 'complete');
    assert.equal(backgroundResults[1].codexLabel, undefined);
    assert.equal(backgroundResults[1].content, 'fleet checked');

    assert.equal(waitResult.codexWait, 'waiting');
    assert.equal(waitResult.codexCommand, 'sleep 75; check fleet');
    assert.equal(waitResult.codexProcessId, '42');

    assert.equal(userShellUse.input.codexCommandKind, 'ran');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex extraction emits ordered Review and rollback system events', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      { type: 'event_msg', payload: { type: 'entered_review_mode', user_facing_hint: 'Review this change' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Review this change' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Review this change' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'No findings.' }] } },
      { type: 'event_msg', payload: { type: 'exited_review_mode' } },
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      { type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 2 } },
    ].map((entry, index) => ({ ...entry, timestamp: `2026-08-07T00:00:0${index}.000Z` }));
    fs.writeFileSync(target, entries.map((entry) => JSON.stringify(entry)).join('\n'));

    const first = extractCodexMessages(target, SESSION_ID);
    assert.deepEqual(first.messages.map((message) => message.content), [
      'Review started',
      'Review this change',
      [{ type: 'text', text: 'No findings.' }],
      'Review completed',
      'Conversation rolled back by 1 turn',
      'Conversation rolled back by 2 turns',
    ]);
    assert.deepEqual(first.messages.map((message) => message.type), [
      'system_event',
      'user',
      'assistant',
      'system_event',
      'system_event',
      'system_event',
    ]);
    assert.deepEqual(extractCodexMessages(target, SESSION_ID), first);

    const incremental = extractCodexMessages(target, SESSION_ID, { startLine: 2 });
    assert.ok(!incremental.messages.some((message) => message.content === 'Review this change'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex extraction renders modern context compaction without exposing replacement history', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      {
        timestamp: '2026-08-10T04:02:11.074Z',
        type: 'compacted',
        payload: {
          message: '',
          replacement_history: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'private replacement history' }],
          }],
        },
      },
      {
        timestamp: '2026-08-10T04:02:11.086Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'ContextCompaction', id: 'compaction-1' },
        },
      },
    ];
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    assert.deepEqual(extracted.messages.map((message) => ({
      type: message.type,
      content: message.content,
    })), [{
      type: 'system_event',
      content: 'Context compacted',
    }]);
    assert.ok(!JSON.stringify(extracted.messages).includes('private replacement history'));

    const incremental = extractCodexMessages(target, SESSION_ID, { startLine: 1 });
    assert.equal(incremental.messages.length, 1);
    assert.equal(incremental.messages[0].content, 'Context compacted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex assistant text stays running until the explicit task_complete event', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      {
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'Still working.' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Finished.' }],
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'Finished.',
          completed_at: 123,
        },
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: `2026-08-10T05:00:0${index}.000Z`,
    }));
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    assert.deepEqual(extracted.messages.map((message) => message.stopReason), [
      undefined,
      undefined,
      'end_turn',
    ]);
    assert.deepEqual(extracted.messages.slice(0, 2).map((message) => message.content), [
      [{ type: 'text', text: 'Still working.' }],
      [{ type: 'text', text: 'Finished.' }],
    ]);
    assert.deepEqual(extracted.messages.at(-1).content, []);

    const incremental = extractCodexMessages(target, SESSION_ID, { startLine: 3 });
    assert.equal(incremental.messages.length, 1);
    assert.equal(incremental.messages[0].stopReason, 'end_turn');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex task_complete errors are extracted as visible turn errors', () => {
  const { root, target } = tempRollout();
  try {
    const entries = [
      {
        timestamp: '2026-08-12T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-error' },
      },
      {
        timestamp: '2026-08-12T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-error',
          error: {
            message: JSON.stringify({
              error: {
                code: 'validation_error',
                message: "invalid request body: Invalid 'input': value did not match any expected variant",
              },
            }),
            codex_error_info: 'other',
          },
        },
      },
    ];
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    assert.equal(extracted.messages.length, 1);
    const [message] = extracted.messages;
    assert.equal(message.nativeId, 'codex:turn:turn-error:error');
    assert.equal(
      message.content[0].text,
      "Error: invalid request body: Invalid 'input': value did not match any expected variant",
    );
    assert.equal(message.stopReason, 'end_turn');
    assert.equal(codexLiveSource(message), 'runtime-turn:turn-error');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incremental extraction rebuilds pairing state before the watermark', () => {
  const { messages } = extractCodexMessages(FIXTURE, SESSION_ID, { startLine: 10 });
  const first = messages[0];
  assert.equal(first.type, 'user');
  assert.equal(first.content[0].type, 'tool_result');
  assert.ok(first.content[0].tool_use_id);
});

test('Codex watermark advances only after a successful upload', async () => {
  const watermarks = new Map([['codex:test', 0]]);
  await assert.rejects(
    syncCodexMessages(FIXTURE, SESSION_ID, 'codex:test', {
      watermarks,
      uploader: async () => { throw new Error('upload failed'); },
    }),
    /upload failed/,
  );
  assert.equal(watermarks.get('codex:test'), 0);

  let uploaded;
  const result = await syncCodexMessages(FIXTURE, SESSION_ID, 'codex:test', {
    watermarks,
    uploader: async (_sessionId, messages, identity) => {
      uploaded = { messages, identity };
    },
  });
  assert.deepEqual(uploaded.messages, result.messages);
  assert.deepEqual(uploaded.identity, { runtime: 'codex', nativeSessionId: SESSION_ID });
  assert.equal(watermarks.get('codex:test'), result.nextLine);
});

test('late patch metadata overwrites the fallback output instead of duplicating it', () => {
  const { root, target } = tempRollout();
  try {
    const allLines = fs.readFileSync(FIXTURE, 'utf-8').split('\n');
    const patchLine = allLines.findIndex((line) => line.includes('"patch_apply_end"'));
    fs.writeFileSync(target, `${allLines.slice(0, patchLine).join('\n')}\n`);
    const first = extractCodexMessages(target, SESSION_ID);
    const editUse = first.messages
      .flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((block) => block.type === 'tool_use' && block.name === 'Edit');
    const fallback = first.messages.find((message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === editUse.id));
    assert.ok(fallback);

    fs.writeFileSync(target, allLines.join('\n'));
    const second = extractCodexMessages(target, SESSION_ID, { startLine: first.nextLine });
    const enriched = second.messages.find((message) =>
      Array.isArray(message.content)
      && message.content.some((block) => block.type === 'tool_result' && block.tool_use_id === editUse.id));
    assert.ok(enriched);
    assert.equal(`${enriched.timestamp}#${enriched.uuid}`, `${fallback.timestamp}#${fallback.uuid}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex hides apply_patch preflight failures but keeps the corrected FileChange', () => {
  const { root, target } = tempRollout();
  try {
    const callId = 'reused-patch-call';
    const entries = [
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: callId,
          input: [
            '*** Begin Patch',
            '*** Update File: missing.js',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: callId,
          output: 'apply_patch verification failed: Failed to find expected lines in missing.js',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: callId,
          input: [
            '*** Begin Patch',
            '*** Add File: corrected.js',
            '+export const corrected = true;',
            '*** End Patch',
          ].join('\n'),
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'FileChange',
            id: callId,
            status: 'completed',
            changes: {
              'corrected.js': {
                type: 'add',
                content: 'export const corrected = true;\n',
              },
            },
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: callId,
          output: 'Exit code: 0\nOutput:\nSuccess. Updated corrected.js',
        },
      },
    ].map((entry, index) => ({
      ...entry,
      timestamp: `2026-08-10T05:10:0${index}.000Z`,
    }));
    fs.writeFileSync(target, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const extracted = extractCodexMessages(target, SESSION_ID);
    const blocks = extracted.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : []);
    const uses = blocks.filter((block) => block.type === 'tool_use');
    const results = blocks.filter((block) => block.type === 'tool_result');

    assert.equal(uses.length, 1);
    assert.equal(uses[0].name, 'Edit');
    assert.equal(uses[0].input.file_path, 'corrected.js');
    assert.equal(results.length, 1);
    assert.equal(results[0].tool_use_id, uses[0].id);
    assert.doesNotMatch(JSON.stringify(extracted.messages), /verification failed|missing\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply_patch parser supports add, update, and move', () => {
  const changes = parseApplyPatchInput([
    '*** Begin Patch',
    '*** Add File: a.txt',
    '+alpha',
    '*** Update File: b.txt',
    '*** Move to: c.txt',
    '@@',
    '-before',
    '+after',
    '*** End Patch',
  ].join('\n'));
  assert.deepEqual(changes, [
    { file_path: 'a.txt', old_string: '', new_string: 'alpha' },
    { file_path: 'c.txt', old_string: 'before', new_string: 'after' },
  ]);
});
