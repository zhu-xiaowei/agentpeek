import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import test from 'node:test';
import { CodexInteraction } from '../../../bridge/codex-interaction.mjs';
import {
  clearLiveMessageRegistry,
  liveMessageRoute,
} from '../../../bridge/live-message-registry.mjs';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.generation = 0;
    this.started = false;
    this.stopCalls = 0;
    this.requests = [];
    this.responses = [];
    this.turnSequence = 0;
    this.skills = [];
    this.hooks = [];
    this.thread = null;
    this.mcpServers = [];
    this.resumeModel = '';
    this.failThreadFeatureLookup = false;
  }

  async start() {
    if (!this.started) {
      this.started = true;
      this.generation++;
      this.emit('ready', { generation: this.generation });
    }
    return this;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-new' } };
    if (method === 'thread/resume') {
      return {
        thread: { id: params.threadId },
        ...(this.resumeModel ? { model: this.resumeModel } : {}),
      };
    }
    if (method === 'turn/start') {
      this.turnSequence++;
      return { turn: { id: `turn-${this.turnSequence}` } };
    }
    if (method === 'skills/list') {
      return {
        data: [{
          cwd: params.cwds[0],
          errors: [],
          skills: this.skills,
        }],
      };
    }
    if (method === 'hooks/list') {
      return {
        data: [{
          cwd: params.cwds[0],
          hooks: this.hooks,
          warnings: [],
          errors: [],
        }],
      };
    }
    if (method === 'experimentalFeature/list') {
      if (params.threadId && this.failThreadFeatureLookup) {
        throw new Error(`thread not found: ${params.threadId}`);
      }
      return { data: [] };
    }
    if (method === 'review/start') {
      this.turnSequence++;
      return {
        reviewThreadId: params.threadId,
        turn: { id: `turn-${this.turnSequence}` },
      };
    }
    if (method === 'thread/read') {
      return {
        thread: this.thread || {
          id: params.threadId,
          cwd: '/workspace/project',
          status: { type: 'idle' },
          modelProvider: 'openai',
        },
      };
    }
    if (method === 'mcpServerStatus/list') {
      return { data: this.mcpServers, nextCursor: null };
    }
    return {};
  }

  async stop() {
    this.stopCalls++;
    this.started = false;
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, code, message) {
    this.responses.push({ id, error: { code, message } });
  }
}

test('new Codex session starts a thread and first turn on the same cwd-scoped client', async () => {
  const client = new FakeClient();
  const contexts = [];
  const interaction = new CodexInteraction({
    clientFactory(context) {
      contexts.push(context);
      return client;
    },
  });
  const cb = callbacks();
  const created = [];

  const result = await interaction.create({
    cwd: '/workspace/project',
    streamId: 'stream-new',
    text: 'start here',
    onCreated(identity) {
      created.push(identity);
      return cb.value;
    },
  });

  assert.deepEqual(contexts, [{ cwd: '/workspace/project' }]);
  assert.deepEqual(created, [{
    nativeSessionId: 'thread-new',
    sessionId: 'codex:thread-new',
  }]);
  assert.deepEqual(result, created[0]);
  assert.deepEqual(client.requests, [
    {
      method: 'thread/start',
      params: { cwd: '/workspace/project' },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-new',
        clientUserMessageId: 'stream-new',
        input: [{ type: 'text', text: 'start here' }],
      },
    },
  ]);
  assert.equal(interaction.owns('thread-new'), true);

  notify(client, 'turn/completed', {
    threadId: 'thread-new',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
});

function callbacks() {
  const frames = [];
  const messages = [];
  const results = [];
  const controls = [];
  const resolvedControls = [];
  const accepted = [];
  return {
    frames,
    messages,
    results,
    controls,
    resolvedControls,
    accepted,
    value: {
      onAccepted: (streamId) => accepted.push(streamId),
      onBlockStart: (_sid, blockId, kind, name) => {
        frames.push({ t: 'start', blockId, kind, name });
      },
      onDelta: (_sid, chunk, blockId) => {
        frames.push({ t: 'delta', blockId, chunk });
      },
      onInputDelta: (_sid, chunk, blockId) => {
        frames.push({ t: 'input', blockId, chunk });
      },
      onBlockStop: (_sid, blockId) => {
        frames.push({ t: 'stop', blockId });
      },
      onMessage: (_sid, message, meta) => messages.push({ message, meta }),
      onResult: (_sid, result) => results.push({ result }),
      onControlRequest: (request) => controls.push(request),
      onControlResolved: (requestId) => resolvedControls.push(requestId),
    },
  };
}

function notify(client, method, params) {
  client.emit('notification', { method, params });
}

test('existing Codex session releases after completion and reuses CC stream frames', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-1',
    nativeSessionId: 'thread-1',
    streamId: 'stream-1',
    text: 'hello',
    callbacks: cb.value,
  });
  assert.deepEqual(cb.accepted, ['stream-1']);

  assert.deepEqual(client.requests.slice(0, 2), [
    {
      method: 'thread/resume',
      params: { threadId: 'thread-1', excludeTurns: true },
    },
    {
      method: 'turn/start',
      params: {
        threadId: 'thread-1',
        clientUserMessageId: 'stream-1',
        input: [{ type: 'text', text: 'hello' }],
      },
    },
  ]);

  notify(client, 'turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress' },
  });
  assert.deepEqual(cb.accepted, ['stream-1']);
  notify(client, 'item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: {
      type: 'userMessage',
      id: 'user-1',
      clientId: 'stream-1',
      content: [{ type: 'text', text: 'hello' }],
    },
  });
  assert.equal(
    liveMessageRoute('codex', 'runtime-turn:turn-1')?.runtimeOwned,
    true,
  );
  notify(client, 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: {
      type: 'userMessage',
      id: 'user-1',
      clientId: 'stream-1',
      content: [{ type: 'text', text: 'hello' }],
    },
  });
  notify(client, 'item/started', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'agent-1', text: '' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'agent-1',
    delta: 'hel',
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'agent-1',
    delta: 'lo',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'agent-1', text: 'hello' },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), [
    'start',
    'delta',
    'delta',
    'stop',
  ]);
  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'hello');
  assert.deepEqual(cb.messages.map(({ message }) => message.type), ['user', 'assistant']);
  assert.equal(cb.messages[0].meta.liveKey, 'runtime-turn:turn-1');
  assert.deepEqual(cb.messages.map(({ message }) => message.nativeId), [
    'codex:user:stream-1',
    'codex:item:agent-1',
  ]);
  assert.equal(cb.messages[1].meta.liveKey, 'runtime-turn:turn-1');
  assert.equal(cb.messages[1].message.content[0].text, 'hello');
  assert.equal(cb.results[0].result.is_error, false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
  assert.equal(interaction.owns('thread-1'), false);

  const second = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-1',
    nativeSessionId: 'thread-1',
    streamId: 'stream-2',
    text: 'again',
    callbacks: second.value,
  });
  assert.equal(client.requests.filter((request) => request.method === 'thread/resume').length, 2);
});

test('a failed turn/start never reports the turn as accepted', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/start') throw new Error('turn start failed');
    return request(method, params);
  };
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await assert.rejects(
    interaction.sendExisting({
      sessionId: 'codex:thread-start-failure',
      nativeSessionId: 'thread-start-failure',
      streamId: 'stream-start-failure',
      text: 'hello',
      callbacks: cb.value,
    }),
    /turn start failed/,
  );

  assert.deepEqual(cb.accepted, []);
});

test('Codex skill mentions are resolved through skills/list and sent as structured input', async () => {
  const client = new FakeClient();
  client.skills = [{
    name: 'reviewer',
    description: 'Review changes',
    path: '/skills/reviewer/SKILL.md',
    scope: 'user',
    enabled: true,
  }];
  const interaction = new CodexInteraction({ client });

  await interaction.sendExisting({
    sessionId: 'codex:thread-skills',
    nativeSessionId: 'thread-skills',
    streamId: 'stream-skills',
    cwd: '/workspace/project',
    text: '$reviewer inspect this change',
    callbacks: callbacks().value,
  });

  assert.deepEqual(
    client.requests.filter((request) => (
      request.method === 'skills/list' || request.method === 'turn/start'
    )),
    [
      {
        method: 'skills/list',
        params: {
          cwds: ['/workspace/project'],
          forceReload: true,
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thread-skills',
          clientUserMessageId: 'stream-skills',
          input: [
            { type: 'text', text: '$reviewer inspect this change' },
            {
              type: 'skill',
              name: 'reviewer',
              path: '/skills/reviewer/SKILL.md',
            },
          ],
        },
      },
    ],
  );
});

test('Codex command context exposes actionable hooks and writes the selected state', async () => {
  const client = new FakeClient();
  client.hooks = [{
    key: 'project.stop.0',
    eventName: 'stop',
    handlerType: 'command',
    command: './scripts/on-stop.sh',
    source: 'project',
    sourcePath: '/workspace/project/.codex/hooks.json',
    enabled: true,
    isManaged: false,
    currentHash: 'hash-1',
    trustStatus: 'trusted',
  }];
  const interaction = new CodexInteraction({
    clientFactory() {
      return client;
    },
  });

  const context = await interaction.listCommandContext({
    cwd: '/workspace/project',
    nativeSessionId: 'thread-hooks',
  });
  assert.equal(context.commandOptions.hooks.length, 1);
  assert.equal(context.commandOptions.hooks[0].label, 'stop · On');

  const result = await interaction.runCommand({
    sessionId: 'codex:thread-hooks',
    nativeSessionId: 'thread-hooks',
    streamId: 'stream-hooks',
    cwd: '/workspace/project',
    name: 'hooks',
    args: context.commandOptions.hooks[0].value,
  });
  assert.match(result.output, /Disabled hook/);
  assert.deepEqual(
    client.requests.find((request) => request.method === 'config/batchWrite'),
    {
      method: 'config/batchWrite',
      params: {
        edits: [{
          keyPath: 'hooks.state',
          value: {
            'project.stop.0': {
              enabled: false,
            },
          },
          mergeStrategy: 'upsert',
        }],
        reloadUserConfig: true,
      },
    },
  );
});

test('Codex command context falls back when the thread feature lookup is stale', async () => {
  const client = new FakeClient();
  client.failThreadFeatureLookup = true;
  const interaction = new CodexInteraction({ client });

  const context = await interaction.listCommandContext({
    cwd: '/workspace/project',
    nativeSessionId: 'thread-stale',
  });

  assert.deepEqual(context.commandOptions.experimental, []);
  assert.deepEqual(
    client.requests
      .filter((request) => request.method === 'experimentalFeature/list')
      .map((request) => request.params),
    [
      { threadId: 'thread-stale' },
      {},
    ],
  );
});

test('Codex native commands map to app-server methods', async () => {
  const client = new FakeClient();
  client.resumeModel = 'openai.gpt-5.6-sol';
  client.mcpServers = [{
    name: 'repo',
    authStatus: 'unsupported',
    tools: {
      search: { name: 'search', inputSchema: {} },
    },
    resources: [],
    resourceTemplates: [],
  }];
  const interaction = new CodexInteraction({ client });
  const reviewCallbacks = callbacks();

  const review = await interaction.runCommand({
    sessionId: 'codex:thread-command',
    nativeSessionId: 'thread-command',
    streamId: 'stream-review',
    cwd: '/workspace/project',
    name: 'review',
    args: 'focus on permissions',
    callbacks: reviewCallbacks.value,
  });
  assert.deepEqual(review, { streaming: true });
  assert.deepEqual(
    client.requests.find((request) => request.method === 'review/start'),
    {
      method: 'review/start',
      params: {
        threadId: 'thread-command',
        target: { type: 'custom', instructions: 'focus on permissions' },
        delivery: 'inline',
      },
    },
  );

  notify(client, 'turn/completed', {
    threadId: 'thread-command',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const rename = await interaction.runCommand({
    sessionId: 'codex:thread-command',
    nativeSessionId: 'thread-command',
    streamId: 'stream-rename',
    cwd: '/workspace/project',
    name: 'rename',
    args: 'Mobile commands',
  });
  assert.match(rename.output, /Mobile commands/);
  assert.deepEqual(
    client.requests.find((request) => request.method === 'thread/name/set'),
    {
      method: 'thread/name/set',
      params: {
        threadId: 'thread-command',
        name: 'Mobile commands',
      },
    },
  );

  const mcp = await interaction.runCommand({
    sessionId: 'codex:thread-command',
    nativeSessionId: 'thread-command',
    streamId: 'stream-mcp',
    cwd: '/workspace/project',
    name: 'mcp',
    args: 'verbose',
  });
  assert.match(mcp.output, /\*\*repo\*\*/);
  assert.match(mcp.output, /`search`/);

  const plan = await interaction.runCommand({
    sessionId: 'codex:thread-command',
    nativeSessionId: 'thread-command',
    streamId: 'stream-plan',
    cwd: '/workspace/project',
    name: 'plan',
    args: '',
  });
  assert.match(plan.output, /Plan mode/);
  assert.deepEqual(
    client.requests.find((request) => (
      request.method === 'thread/settings/update'
      && request.params.collaborationMode
    )),
    {
      method: 'thread/settings/update',
      params: {
        threadId: 'thread-command',
        collaborationMode: {
          mode: 'plan',
          settings: {
            model: 'openai.gpt-5.6-sol',
            reasoning_effort: null,
            developer_instructions: null,
          },
        },
      },
    },
  );
});

test('turn completion reconciles a final agent item when intermediate notifications are missing', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-reconcile',
    nativeSessionId: 'thread-reconcile',
    streamId: 'stream-reconcile',
    text: 'write a long answer',
    callbacks: cb.value,
  });

  notify(client, 'turn/completed', {
    threadId: 'thread-reconcile',
    turn: {
      id: 'turn-1',
      status: 'completed',
      completedAt: 1_786_442_000,
      items: [{
        type: 'agentMessage',
        id: 'agent-reconciled',
        text: 'complete text recovered from the turn',
      }],
    },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'delta', 'stop']);
  assert.equal(cb.frames[1].chunk, 'complete text recovered from the turn');
  assert.equal(cb.messages.length, 1);
  assert.equal(cb.messages[0].message.uuid, 'codex_live_agent_agent-reconciled');
  assert.equal(cb.messages[0].message.content[0].text, 'complete text recovered from the turn');
});

test('terminal Codex errors become visible assistant messages with the API detail', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-error',
    nativeSessionId: 'thread-error',
    streamId: 'stream-error',
    text: 'hello',
    callbacks: cb.value,
  });

  notify(client, 'error', {
    threadId: 'thread-error',
    turnId: 'turn-1',
    error: {
      message: JSON.stringify({
        error: {
          code: 'validation_error',
          message: "invalid request body: Invalid 'input': value did not match any expected variant",
        },
      }),
    },
    willRetry: false,
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-error',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.equal(cb.messages.length, 1);
  assert.equal(cb.messages[0].meta.liveKey, 'runtime-turn:turn-1');
  assert.equal(cb.messages[0].message.nativeId, 'codex:turn:turn-1:error');
  assert.equal(
    cb.messages[0].message.content[0].text,
    "Error: invalid request body: Invalid 'input': value did not match any expected variant",
  );
  assert.equal(cb.messages[0].message.stopReason, 'end_turn');
  assert.deepEqual(cb.results[0].result, {
    is_error: true,
    subtype: undefined,
    status: 'completed',
  });
});

test('retryable Codex errors are not shown when the turn later succeeds', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-retry',
    nativeSessionId: 'thread-retry',
    streamId: 'stream-retry',
    text: 'hello',
    callbacks: cb.value,
  });

  notify(client, 'error', {
    threadId: 'thread-retry',
    turnId: 'turn-1',
    error: { message: 'temporary failure' },
    willRetry: true,
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-retry',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.equal(cb.messages.length, 0);
  assert.equal(cb.results[0].result.is_error, false);
});

test('delta notifications from a different turn are ignored', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-mismatch',
    nativeSessionId: 'thread-mismatch',
    streamId: 'stream-mismatch',
    text: 'write an answer',
    callbacks: cb.value,
  });

  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-mismatch',
    turnId: 'turn-other',
    itemId: 'agent-mismatch',
    delta: 'lost',
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-mismatch',
    turn: {
      id: 'turn-1',
      status: 'completed',
      items: [{
        type: 'agentMessage',
        id: 'agent-recovered',
        text: 'recovered',
      }],
    },
  });

  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'recovered');
});

test('current client user item corrects a stale turn/start response id', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    const result = await request(method, params);
    if (method === 'turn/start') return { turn: { id: 'turn-stale' } };
    return result;
  };
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-rebind',
    nativeSessionId: 'thread-rebind',
    streamId: 'stream-rebind',
    text: 'stream this',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-rebind',
    turnId: 'turn-current',
    item: {
      type: 'userMessage',
      id: 'user-current',
      clientId: 'stream-rebind',
      content: [{ type: 'text', text: 'stream this' }],
    },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-rebind',
    turnId: 'turn-current',
    itemId: 'agent-current',
    delta: 'streamed',
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-rebind',
    turn: {
      id: 'turn-current',
      status: 'completed',
      items: [{
        type: 'agentMessage',
        id: 'agent-current',
        text: 'streamed',
      }],
    },
  });

  assert.equal(cb.frames.filter((frame) => frame.t === 'delta')
    .map((frame) => frame.chunk).join(''), 'streamed');
});

test('Codex commentary streams as visible progress text', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-commentary',
    nativeSessionId: 'thread-commentary',
    streamId: 'stream-commentary',
    text: 'write exactly 300 chars',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'commentary-1',
      text: '',
      phase: 'commentary',
    },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    itemId: 'commentary-1',
    delta: 'checking the draft',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-commentary',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: {
      type: 'agentMessage',
      id: 'commentary-1',
      text: 'checking the draft',
      phase: 'commentary',
    },
  });

  assert.equal(cb.frames[0].kind, 'text');
  assert.equal(cb.frames[1].t, 'delta');
  assert.deepEqual(cb.messages[0].message.content, [{
    type: 'text',
    text: 'checking the draft',
  }]);
});

test('empty Codex reasoning items do not create preview blocks', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-empty-reasoning',
    nativeSessionId: 'thread-empty-reasoning',
    streamId: 'stream-empty-reasoning',
    text: 'summarize this',
    callbacks: cb.value,
  });

  for (const id of ['reasoning-1', 'reasoning-2']) {
    notify(client, 'item/started', {
      threadId: 'thread-empty-reasoning',
      turnId: 'turn-1',
      item: { type: 'reasoning', id },
    });
    notify(client, 'item/completed', {
      threadId: 'thread-empty-reasoning',
      turnId: 'turn-1',
      completedAtMs: Date.now(),
      item: { type: 'reasoning', id, content: [], summary: [] },
    });
  }
  notify(client, 'item/started', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    item: { type: 'agentMessage', id: 'answer-1', text: '' },
  });
  notify(client, 'item/agentMessage/delta', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    itemId: 'answer-1',
    delta: 'summary',
  });
  notify(client, 'item/completed', {
    threadId: 'thread-empty-reasoning',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: 'answer-1', text: 'summary' },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-empty-reasoning',
    turn: { id: 'turn-1', status: 'completed' },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'delta', 'stop']);
  assert.deepEqual(cb.frames.map((frame) => frame.blockId), [0, 0, 0]);
});

test('Codex command items use the shared tool preview contract', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-2',
    nativeSessionId: 'thread-2',
    streamId: 'stream-tool',
    text: 'run pwd',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-2',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'command-1',
      command: 'pwd',
      cwd: '/tmp',
      commandActions: [{ type: 'listFiles', command: 'pwd', path: '/tmp' }],
      status: 'inProgress',
    },
  });

  assert.deepEqual(cb.frames.map((frame) => frame.t), ['start', 'input', 'stop']);
  assert.equal(cb.frames[0].kind, 'tool_use');
  assert.equal(cb.frames[0].name, 'Bash');
  assert.deepEqual(JSON.parse(cb.frames[1].chunk), {
    command: 'pwd',
    cwd: '/tmp',
    codexCommandActions: [{ type: 'list_files', command: 'pwd', path: '/tmp' }],
  });
});

test('Codex completed commands publish authoritative IN and OUT before turn end', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-command-authority',
    nativeSessionId: 'thread-command-authority',
    streamId: 'turn-command-authority',
    text: 'run pwd',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-command-authority',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'command-authority-1',
      command: 'pwd',
      cwd: '/workspace',
      status: 'inProgress',
    },
  });
  notify(client, 'item/completed', {
    threadId: 'thread-command-authority',
    turnId: 'turn-1',
    completedAtMs: Date.now(),
    item: {
      type: 'commandExecution',
      id: 'command-authority-1',
      command: 'pwd',
      cwd: '/workspace',
      status: 'completed',
      aggregatedOutput: '/workspace\n',
      exitCode: 0,
    },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-command-authority',
    turn: {
      id: 'turn-1',
      status: 'completed',
      items: [],
    },
  });

  assert.deepEqual(
    cb.messages.map(({ message }) => message.type),
    ['assistant', 'user'],
  );
  const use = cb.messages[0].message.content[0];
  const result = cb.messages[1].message.content[0];
  assert.equal(use.type, 'tool_use');
  assert.equal(use.name, 'Bash');
  assert.equal(use.input.command, 'pwd');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, use.id);
  assert.equal(result.content, '/workspace');
  assert.equal(result.is_error, false);
  assert.equal(cb.results.length, 1);
});

test('Codex interrupted turns complete unfinished tools before reporting the final status', async () => {
  clearLiveMessageRegistry();
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-interrupted-command',
    nativeSessionId: 'thread-interrupted-command',
    streamId: 'turn-interrupted-command',
    text: 'run a slow command',
    callbacks: cb.value,
  });

  notify(client, 'item/started', {
    threadId: 'thread-interrupted-command',
    turnId: 'turn-1',
    item: {
      type: 'commandExecution',
      id: 'command-interrupted-1',
      command: 'sleep 30',
      cwd: '/workspace',
      status: 'inProgress',
    },
  });
  notify(client, 'turn/completed', {
    threadId: 'thread-interrupted-command',
    turn: {
      id: 'turn-1',
      status: 'interrupted',
      items: [],
    },
  });

  assert.deepEqual(
    cb.messages.map(({ message }) => message.type),
    ['assistant', 'user'],
  );
  const use = cb.messages[0].message.content[0];
  const result = cb.messages[1].message.content[0];
  assert.equal(use.type, 'tool_use');
  assert.equal(use.name, 'Bash');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, use.id);
  assert.equal(result.content, 'Interrupted');
  assert.equal(result.is_error, true);
  assert.equal(cb.results.length, 1);
  assert.equal(cb.results[0].result.status, 'interrupted');
  assert.equal(cb.results[0].result.subtype, 'interrupted');
});

test('Codex approval requests preserve native ordered decisions', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-3',
    nativeSessionId: 'thread-3',
    streamId: 'stream-approval',
    text: 'run command',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 42,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-3',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'git add README.md',
      cwd: '/tmp',
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
  });

  assert.equal(cb.controls[0].request.tool_name, 'Bash');
  assert.equal(cb.controls[0].request.approval_type, 'codex-command');
  assert.equal(cb.controls[0].request.input.command, 'git add README.md');
  assert.deepEqual(
    cb.controls[0].request.input.codexApproval.availableDecisions,
    [
      'accept',
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['git', 'add'],
        },
      },
      'cancel',
    ],
  );
  const requestId = cb.controls[0].request_id;
  assert.equal(interaction.replyControl('thread-3', requestId, {
    decision: {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['git', 'add'],
      },
    },
  }), true);
  assert.deepEqual(client.responses[0], {
    id: 42,
    result: {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['git', 'add'],
        },
      },
    },
  });
});

test('Codex keeps multiple approval requests pending in the same turn', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-multi-approval',
    nativeSessionId: 'thread-multi-approval',
    streamId: 'stream-multi-approval',
    text: 'run both commands',
    callbacks: cb.value,
  });

  for (const [id, command] of [[43, 'printf one'], [44, 'printf two']]) {
    client.emit('serverRequest', {
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-multi-approval',
        turnId: 'turn-1',
        itemId: `command-${id}`,
        command,
        availableDecisions: ['accept', 'cancel'],
      },
    });
  }

  assert.equal(cb.controls.length, 2);
  assert.equal(interaction.pendingRequests.size, 2);
  assert.notEqual(cb.controls[0].request_id, cb.controls[1].request_id);

  assert.equal(interaction.replyControl(
    'thread-multi-approval',
    cb.controls[1].request_id,
    { decision: 'cancel' },
  ), true);
  assert.equal(interaction.pendingRequests.size, 1);
  assert.equal(interaction.replyControl(
    'thread-multi-approval',
    cb.controls[0].request_id,
    { decision: 'accept' },
  ), true);
  assert.equal(interaction.pendingRequests.size, 0);
  assert.deepEqual(client.responses, [
    { id: 44, result: { decision: 'cancel' } },
    { id: 43, result: { decision: 'accept' } },
  ]);
});

test('Codex approval rejects decisions not offered by the server', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-invalid-approval',
    nativeSessionId: 'thread-invalid-approval',
    streamId: 'stream-invalid-approval',
    text: 'run command',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 142,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-invalid-approval',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'git add README.md',
      availableDecisions: ['accept', 'cancel'],
    },
  });

  assert.equal(interaction.replyControl(
    'thread-invalid-approval',
    cb.controls[0].request_id,
    { decision: 'acceptForSession' },
  ), true);
  assert.deepEqual(client.responses[0], {
    id: 142,
    result: { decision: 'cancel' },
  });
});

test('Codex command approval derives persistence choices for older app servers', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-derived-approval',
    nativeSessionId: 'thread-derived-approval',
    streamId: 'stream-derived-approval',
    text: 'stage file',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 143,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId: 'thread-derived-approval',
      turnId: 'turn-1',
      itemId: 'command-1',
      command: 'git add README.md',
      proposedExecpolicyAmendment: ['git', 'add'],
    },
  });

  assert.deepEqual(
    cb.controls[0].request.input.codexApproval.availableDecisions,
    [
      'accept',
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ['git', 'add'],
        },
      },
      'cancel',
    ],
  );
});

test('Codex file and user-input requests reuse the existing permission replies', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-4',
    nativeSessionId: 'thread-4',
    streamId: 'stream-controls',
    text: 'edit and ask',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 43,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-4',
      turnId: 'turn-1',
      itemId: 'file-1',
      grantRoot: '/tmp/project',
      reason: 'edit file',
    },
  });
  const fileRequest = cb.controls.at(-1);
  assert.equal(fileRequest.request.tool_name, 'Edit');
  assert.equal(fileRequest.request.approval_type, 'codex-file-change');
  assert.equal(interaction.replyControl(
    'thread-4',
    fileRequest.request_id,
    { decision: 'allow' },
  ), true);

  client.emit('serverRequest', {
    id: 44,
    method: 'item/tool/requestUserInput',
    params: {
      threadId: 'thread-4',
      turnId: 'turn-1',
      itemId: 'ask-1',
      questions: [{ id: 'choice', question: 'Choose' }],
    },
  });
  const askRequest = cb.controls.at(-1);
  assert.equal(askRequest.request.requires_user_interaction, true);
  assert.equal(interaction.replyControl(
    'thread-4',
    askRequest.request_id,
    { decision: 'answer', answerText: 'A' },
  ), true);

  assert.deepEqual(client.responses, [
    { id: 43, result: { decision: 'accept' } },
    {
      id: 44,
      result: {
        answers: {
          choice: { answers: ['A'] },
        },
      },
    },
  ]);
});

test('Codex permission approvals construct grants from the original request', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-permissions',
    nativeSessionId: 'thread-permissions',
    streamId: 'stream-permissions',
    text: 'request permissions',
    callbacks: cb.value,
  });

  const permissions = {
    network: { enabled: true },
    fileSystem: {
      read: ['/tmp/input'],
      write: ['/tmp/output'],
      entries: [
        { path: { path: '/tmp/cache' }, access: 'write' },
      ],
    },
  };
  const actions = [
    ['grantForTurn', {
      permissions,
      scope: 'turn',
    }],
    ['grantForTurnWithStrictAutoReview', {
      permissions,
      scope: 'turn',
      strictAutoReview: true,
    }],
    ['grantForSession', {
      permissions,
      scope: 'session',
    }],
    ['unexpected-browser-value', {
      permissions: {},
      scope: 'turn',
    }],
  ];

  for (const [index, [action, expected]] of actions.entries()) {
    client.emit('serverRequest', {
      id: 200 + index,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-permissions',
        turnId: 'turn-1',
        itemId: `permissions-${index}`,
        cwd: '/tmp/project',
        reason: 'Needs access',
        permissions,
      },
    });
    const control = cb.controls.at(-1);
    assert.equal(control.request.approval_type, 'codex-permissions');
    assert.deepEqual(control.request.input.codexPermissions.permissions, permissions);
    assert.equal(interaction.replyControl(
      'thread-permissions',
      control.request_id,
      {
        approvalResponse: {
          action,
          permissions: { network: { enabled: false } },
        },
      },
    ), true);
    assert.deepEqual(client.responses.at(-1), {
      id: 200 + index,
      result: expected,
    });
  }
});

test('Codex MCP approval preserves persistence metadata and tool cancellation rules', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-mcp-approval',
    nativeSessionId: 'thread-mcp-approval',
    streamId: 'stream-mcp-approval',
    text: 'use MCP',
    callbacks: cb.value,
  });

  const params = {
    threadId: 'thread-mcp-approval',
    turnId: 'turn-1',
    serverName: 'cloudlab',
    mode: 'form',
    message: 'Run deploy?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
    },
  };
  client.emit('serverRequest', {
    id: 210,
    method: 'mcpServer/elicitation/request',
    params,
  });
  const approval = cb.controls.at(-1);
  assert.equal(approval.request.approval_type, 'codex-mcp-elicitation');
  assert.deepEqual(approval.request.input.codexMcpElicitation, {
    serverName: 'cloudlab',
    mode: 'form',
    message: 'Run deploy?',
    responseMode: 'approval',
    isToolApproval: true,
    persistModes: ['session', 'always'],
    displayParams: [],
    fields: [],
  });
  interaction.replyControl(
    'thread-mcp-approval',
    approval.request_id,
    { approvalResponse: { action: 'acceptAlways' } },
  );
  assert.deepEqual(client.responses.at(-1), {
    id: 210,
    result: {
      action: 'accept',
      content: null,
      _meta: { persist: 'always' },
    },
  });

  client.emit('serverRequest', {
    id: 211,
    method: 'mcpServer/elicitation/request',
    params,
  });
  const invalidDecline = cb.controls.at(-1);
  interaction.replyControl(
    'thread-mcp-approval',
    invalidDecline.request_id,
    { approvalResponse: { action: 'decline' } },
  );
  assert.deepEqual(client.responses.at(-1), {
    id: 211,
    result: { action: 'cancel', content: null, _meta: null },
  });
});

test('Codex MCP forms expose supported TUI fields and validate submitted content', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-mcp-form',
    nativeSessionId: 'thread-mcp-form',
    streamId: 'stream-mcp-form',
    text: 'fill MCP form',
    callbacks: cb.value,
  });

  const requestedSchema = {
    type: 'object',
    required: ['name', 'enabled', 'region'],
    properties: {
      name: {
        type: 'string',
        title: 'Name',
        description: 'Deployment name',
      },
      enabled: {
        type: 'boolean',
        title: 'Enabled',
        default: true,
      },
      region: {
        type: 'string',
        title: 'Region',
        enum: ['ap', 'us'],
        enumNames: ['Asia Pacific', 'United States'],
      },
      tier: {
        type: 'string',
        title: 'Tier',
        oneOf: [
          { const: 'dev', title: 'Development' },
          { const: 'prod', title: 'Production' },
        ],
      },
    },
  };
  const params = {
    threadId: 'thread-mcp-form',
    turnId: 'turn-1',
    serverName: 'cloudlab',
    mode: 'form',
    message: 'Configure deployment',
    requestedSchema,
  };

  client.emit('serverRequest', {
    id: 220,
    method: 'mcpServer/elicitation/request',
    params,
  });
  const form = cb.controls.at(-1);
  const details = form.request.input.codexMcpElicitation;
  assert.equal(details.responseMode, 'form');
  assert.equal(details.fields.length, 4);
  assert.deepEqual(details.fields[1].input.options, [
    { label: 'True', value: true },
    { label: 'False', value: false },
  ]);
  assert.deepEqual(details.fields[2].input.options, [
    { label: 'Asia Pacific', value: 'ap' },
    { label: 'United States', value: 'us' },
  ]);

  interaction.replyControl(
    'thread-mcp-form',
    form.request_id,
    {
      approvalResponse: {
        action: 'acceptForm',
        content: {
          name: 'demo',
          enabled: true,
          region: 'ap',
        },
      },
    },
  );
  assert.deepEqual(client.responses.at(-1), {
    id: 220,
    result: {
      action: 'accept',
      content: {
        name: 'demo',
        enabled: true,
        region: 'ap',
      },
      _meta: null,
    },
  });

  client.emit('serverRequest', {
    id: 221,
    method: 'mcpServer/elicitation/request',
    params,
  });
  const invalid = cb.controls.at(-1);
  interaction.replyControl(
    'thread-mcp-form',
    invalid.request_id,
    {
      approvalResponse: {
        action: 'acceptForm',
        content: {
          name: 'demo',
          enabled: true,
          region: 'invalid',
          injected: true,
        },
      },
    },
  );
  assert.deepEqual(client.responses.at(-1), {
    id: 221,
    result: { action: 'cancel', content: null, _meta: null },
  });
});

test('Codex MCP unsupported forms fall back while non-form modes auto-decline', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-mcp-fallback',
    nativeSessionId: 'thread-mcp-fallback',
    streamId: 'stream-mcp-fallback',
    text: 'unsupported MCP input',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 225,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-mcp-fallback',
      turnId: 'turn-1',
      serverName: 'cloudlab',
      mode: 'form',
      message: 'Pick a number',
      requestedSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', title: 'Count' },
        },
      },
    },
  });
  const fallback = cb.controls.at(-1);
  assert.equal(
    fallback.request.input.codexMcpElicitation.responseMode,
    'fallback',
  );
  interaction.replyControl(
    'thread-mcp-fallback',
    fallback.request_id,
    { approvalResponse: { action: 'accept' } },
  );
  assert.deepEqual(client.responses.at(-1), {
    id: 225,
    result: { action: 'accept', content: null, _meta: null },
  });

  const controlCount = cb.controls.length;
  client.emit('serverRequest', {
    id: 226,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-mcp-fallback',
      turnId: 'turn-1',
      serverName: 'cloudlab',
      mode: 'openai/form',
      message: 'Open app form',
      requestedSchema: {},
    },
  });
  assert.equal(cb.controls.length, controlCount);
  assert.deepEqual(client.responses.at(-1), {
    id: 226,
    result: { action: 'decline', content: null, _meta: null },
  });

  client.emit('serverRequest', {
    id: 227,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'thread-mcp-fallback',
      turnId: 'turn-1',
      serverName: 'cloudlab',
      mode: 'form',
      message: 'Install tool',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'tool_suggestion',
        tool_type: 'connector',
        suggest_type: 'install',
        tool_id: 'calendar',
        tool_name: 'Calendar',
      },
    },
  });
  assert.equal(cb.controls.length, controlCount);
  assert.deepEqual(client.responses.at(-1), {
    id: 227,
    result: { action: 'decline', content: null, _meta: null },
  });
});

test('unsupported Codex server requests fail without opening a generic approval', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();
  await interaction.sendExisting({
    sessionId: 'codex:thread-unsupported-control',
    nativeSessionId: 'thread-unsupported-control',
    streamId: 'stream-unsupported-control',
    text: 'unsupported request',
    callbacks: cb.value,
  });

  client.emit('serverRequest', {
    id: 230,
    method: 'future/requestApproval',
    params: {
      threadId: 'thread-unsupported-control',
      turnId: 'turn-1',
    },
  });

  assert.equal(cb.controls.length, 0);
  assert.deepEqual(client.responses, [{
    id: 230,
    error: {
      code: -32601,
      message: 'Unsupported Codex server request',
    },
  }]);
});

test('Codex interrupt targets the active thread and turn', async () => {
  const client = new FakeClient();
  const interaction = new CodexInteraction({ client });
  await interaction.sendExisting({
    sessionId: 'codex:thread-5',
    nativeSessionId: 'thread-5',
    streamId: 'stream-interrupt',
    text: 'keep working',
    callbacks: callbacks().value,
  });

  assert.equal(await interaction.interrupt('thread-5'), true);
  assert.deepEqual(client.requests.at(-1), {
    method: 'turn/interrupt',
    params: {
      threadId: 'thread-5',
      turnId: 'turn-1',
    },
  });

  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'turn/interrupt') throw new Error('interrupt failed');
    return request(method, params);
  };
  assert.equal(await interaction.interrupt('thread-5'), false);
});

test('burst sends to one Codex thread start one turn and queue the next', async () => {
  const client = new FakeClient();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume') await firstGate;
    return request(method, params);
  };
  const interaction = new CodexInteraction({ client });
  const first = callbacks();
  const second = callbacks();

  const firstSend = interaction.sendExisting({
    sessionId: 'codex:thread-burst',
    nativeSessionId: 'thread-burst',
    streamId: 'stream-burst-1',
    text: 'first',
    callbacks: first.value,
  });
  const secondSend = interaction.sendExisting({
    sessionId: 'codex:thread-burst',
    nativeSessionId: 'thread-burst',
    streamId: 'stream-burst-2',
    text: 'second',
    callbacks: second.value,
  });
  releaseFirst();

  assert.deepEqual(await firstSend, { queued: false });
  assert.deepEqual(await secondSend, { queued: true });
  assert.deepEqual(first.accepted, ['stream-burst-1']);
  assert.deepEqual(second.accepted, []);
  assert.equal(client.requests.filter((entry) => entry.method === 'thread/resume').length, 1);
  assert.equal(client.requests.filter((entry) => entry.method === 'turn/start').length, 1);

  notify(client, 'turn/completed', {
    threadId: 'thread-burst',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(second.accepted, ['stream-burst-2']);
  assert.equal(client.requests.filter((entry) => entry.method === 'turn/start').length, 2);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start')[1]
      .params.clientUserMessageId,
    'stream-burst-2',
  );
  assert.equal(client.stopCalls, 0);

  notify(client, 'turn/completed', {
    threadId: 'thread-burst',
    turn: { id: 'turn-2', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
});

test('managed app-server resume adopts an active approval turn before queued send', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume') {
      client.emit('serverRequest', {
        id: 21,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-managed',
          turnId: 'turn-external',
          command: 'git add README.md',
          cwd: '/workspace/demo',
          availableDecisions: ['accept', 'cancel'],
        },
      });
      return {
        thread: {
          id: params.threadId,
          status: {
            type: 'active',
            activeFlags: ['waitingOnApproval'],
          },
        },
      };
    }
    return request(method, params);
  };
  const interaction = new CodexInteraction({ client });
  const cb = callbacks();

  assert.deepEqual(await interaction.sendExisting({
    sessionId: 'codex:thread-managed',
    nativeSessionId: 'thread-managed',
    streamId: 'stream-queued',
    text: 'continue after approval',
    callbacks: cb.value,
  }), { queued: true });
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    0,
  );
  assert.equal(cb.controls.length, 1);
  assert.equal(cb.controls[0].request.tool_name, 'Bash');

  assert.equal(interaction.replyControl(
    'thread-managed',
    'codex:thread-managed:21',
    { decision: 'cancel' },
  ), true);
  assert.deepEqual(client.responses, [{
    id: 21,
    result: { decision: 'cancel' },
  }]);

  notify(client, 'turn/completed', {
    threadId: 'thread-managed',
    turn: { id: 'turn-external', status: 'interrupted' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const starts = client.requests.filter((entry) => entry.method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.clientUserMessageId, 'stream-queued');

  notify(client, 'turn/completed', {
    threadId: 'thread-managed',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(client.stopCalls, 1);
});

test('different Codex threads use independent ephemeral clients', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-a',
    nativeSessionId: 'thread-a',
    streamId: 'stream-a',
    text: 'a',
    callbacks: callbacks().value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:thread-b',
    nativeSessionId: 'thread-b',
    streamId: 'stream-b',
    text: 'b',
    callbacks: callbacks().value,
  });

  assert.equal(clients.length, 2);
  notify(clients[0], 'turn/completed', {
    threadId: 'thread-a',
    turn: { id: 'turn-1', status: 'completed' },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(clients[0].stopCalls, 1);
  assert.equal(clients[1].stopCalls, 0);
  assert.equal(interaction.owns('thread-a'), false);
  assert.equal(interaction.owns('thread-b'), true);
});

test('permission observation replays a managed TUI approval without starting a turn', async (t) => {
  clearLiveMessageRegistry();
  t.after(clearLiveMessageRegistry);
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/loaded/list') {
      client.requests.push({ method, params });
      return { data: ['thread-observed'] };
    }
    if (method === 'thread/resume') {
      client.requests.push({ method, params });
      client.emit('serverRequest', {
        id: 31,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-observed',
          turnId: 'turn-external',
          command: 'git commit -m test',
          cwd: '/workspace/demo',
          availableDecisions: ['accept', 'cancel'],
        },
      });
      return {
        thread: {
          id: params.threadId,
          status: {
            type: 'active',
            activeFlags: ['waitingOnApproval'],
          },
        },
      };
    }
    return request(method, params);
  };
  const contexts = [];
  const interaction = new CodexInteraction({
    clientFactory(context) {
      contexts.push(context);
      return client;
    },
  });
  const cb = callbacks();

  assert.deepEqual(await interaction.observePermissions({
    sessionId: 'codex:thread-observed',
    nativeSessionId: 'thread-observed',
    callbacks: cb.value,
  }), { active: true, loaded: true });

  assert.deepEqual(contexts, [{
    nativeSessionId: 'thread-observed',
    storageSessionId: 'codex:thread-observed',
    managedOnly: true,
  }]);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    0,
  );
  assert.equal(cb.frames.length, 0);
  assert.equal(cb.messages.length, 0);
  assert.equal(cb.controls.length, 1);
  assert.equal(cb.controls[0].request.input.command, 'git commit -m test');
  assert.equal(interaction.owns('thread-observed'), false);
  assert.equal(liveMessageRoute('codex', 'runtime-turn:turn-external'), null);
});

test('permission observation ignores unloaded Codex threads', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/loaded/list') {
      client.requests.push({ method, params });
      return { data: ['another-thread'] };
    }
    return request(method, params);
  };
  const interaction = new CodexInteraction({ client });

  assert.deepEqual(await interaction.observePermissions({
    sessionId: 'codex:thread-idle',
    nativeSessionId: 'thread-idle',
    callbacks: callbacks().value,
  }), { active: false, loaded: false });
  assert.equal(
    client.requests.filter((entry) => entry.method === 'thread/resume').length,
    0,
  );
  assert.equal(client.stopCalls, 1);
});

test('permission observation never terminates a conflicting Codex writer', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/loaded/list') {
      client.requests.push({ method, params });
      return { data: ['thread-conflict-observed'] };
    }
    if (method === 'thread/resume') {
      client.requests.push({ method, params });
      throw new Error('thread already has an active writer');
    }
    return request(method, params);
  };
  const terminated = [];
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 88,
        canTerminate: true,
        status: 'completed',
      }),
      terminate: async (...args) => terminated.push(args),
    },
  });

  const observed = await interaction.observePermissions({
    sessionId: 'codex:thread-conflict-observed',
    nativeSessionId: 'thread-conflict-observed',
    callbacks: callbacks().value,
  });
  assert.equal(observed.active, false);
  assert.equal(observed.loaded, false);
  assert.equal(observed.error.code, 'CODEX_ACTIVE_WRITER');
  assert.deepEqual(terminated, []);
  assert.equal(client.stopCalls, 1);
});

test('send waits for an in-progress release before creating the next lease', async () => {
  const clients = [];
  let finishRelease;
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      if (clients.length === 0) {
        client.stop = () => {
          client.stopCalls++;
          client.started = false;
          return new Promise((resolve) => { finishRelease = resolve; });
        };
      }
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-release',
    nativeSessionId: 'thread-release',
    streamId: 'stream-release-1',
    text: 'first',
    callbacks: callbacks().value,
  });
  notify(clients[0], 'turn/completed', {
    threadId: 'thread-release',
    turn: { id: 'turn-1', status: 'completed' },
  });

  const secondSend = interaction.sendExisting({
    sessionId: 'codex:thread-release',
    nativeSessionId: 'thread-release',
    streamId: 'stream-release-2',
    text: 'second',
    callbacks: callbacks().value,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(clients.length, 1);

  finishRelease();
  await secondSend;
  assert.equal(clients.length, 2);
  assert.equal(
    clients[1].requests.filter((entry) => entry.method === 'thread/resume').length,
    1,
  );
});

test('resume failure closes the unused ephemeral client', async () => {
  const client = new FakeClient();
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume') {
      const error = new Error('thread already has an active writer');
      error.code = -32600;
      throw error;
    }
    return request(method, params);
  };
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 88,
        tty: 'ttys008',
        label: 'Codex terminal (ttys008)',
        canTerminate: true,
        status: 'running',
      }),
      terminate: async () => {},
    },
  });

  await assert.rejects(
    interaction.sendExisting({
      sessionId: 'codex:thread-conflict',
      nativeSessionId: 'thread-conflict',
      streamId: 'stream-conflict',
      text: 'hello',
      callbacks: callbacks().value,
    }),
    (error) => error.code === 'CODEX_ACTIVE_WRITER'
      && error.writer.pid === 88,
  );

  assert.equal(client.stopCalls, 1);
  assert.equal(interaction.owns('thread-conflict'), false);
});

test('idle Codex writer is terminated automatically before resume', async () => {
  const client = new FakeClient();
  let locked = true;
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume' && locked) {
      throw new Error('thread already has an active writer');
    }
    return request(method, params);
  };
  const terminated = [];
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 90,
        tty: 'ttys009',
        label: 'Codex terminal (ttys009)',
        canTerminate: true,
        status: 'completed',
      }),
      terminate: async (threadId, expectedPid, options) => {
        terminated.push({ threadId, expectedPid, options });
        locked = false;
      },
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-idle',
    nativeSessionId: 'thread-idle',
    streamId: 'stream-idle',
    text: 'continue',
    callbacks: callbacks().value,
  });

  assert.deepEqual(terminated, [{
    threadId: 'thread-idle',
    expectedPid: 90,
    options: { requireIdle: true },
  }]);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    1,
  );
});

test('confirmed takeover terminates the expected writer and retries resume in one client', async () => {
  const client = new FakeClient();
  let locked = true;
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === 'thread/resume' && locked) {
      throw new Error('thread already has an active writer');
    }
    return request(method, params);
  };
  const terminated = [];
  const interaction = new CodexInteraction({
    client,
    writerController: {
      describe: () => ({
        pid: 91,
        tty: 'ttys009',
        label: 'Codex terminal (ttys009)',
        canTerminate: true,
        status: 'running',
      }),
      terminate: async (threadId, expectedPid) => {
        terminated.push({ threadId, expectedPid });
        locked = false;
      },
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:thread-takeover',
    nativeSessionId: 'thread-takeover',
    streamId: 'stream-takeover',
    text: 'continue',
    takeover: true,
    expectedWriterPid: 91,
    callbacks: callbacks().value,
  });

  assert.deepEqual(terminated, [{
    threadId: 'thread-takeover',
    expectedPid: 91,
  }]);
  assert.equal(
    client.requests.filter((entry) => entry.method === 'thread/resume').length,
    1,
  );
  assert.equal(
    client.requests.filter((entry) => entry.method === 'turn/start').length,
    1,
  );
  assert.equal(client.generation, 1);
});

test('approval request ids are isolated across ephemeral clients', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });
  const first = callbacks();
  const second = callbacks();

  await interaction.sendExisting({
    sessionId: 'codex:thread-control-a',
    nativeSessionId: 'thread-control-a',
    streamId: 'stream-control-a',
    text: 'a',
    callbacks: first.value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:thread-control-b',
    nativeSessionId: 'thread-control-b',
    streamId: 'stream-control-b',
    text: 'b',
    callbacks: second.value,
  });

  for (const [index, client] of clients.entries()) {
    client.emit('serverRequest', {
      id: 42,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: `thread-control-${index === 0 ? 'a' : 'b'}`,
        turnId: 'turn-1',
        itemId: `command-${index}`,
        command: 'pwd',
      },
    });
  }

  assert.notEqual(first.controls[0].request_id, second.controls[0].request_id);
  assert.equal(
    interaction.replyControl(
      'thread-control-a',
      first.controls[0].request_id,
      { decision: 'allow' },
    ),
    true,
  );
  assert.equal(
    interaction.replyControl(
      'thread-control-b',
      second.controls[0].request_id,
      { decision: 'deny' },
    ),
    true,
  );
  assert.deepEqual(clients[0].responses[0], {
    id: 42,
    result: { decision: 'accept' },
  });
  assert.deepEqual(clients[1].responses[0], {
    id: 42,
    result: { decision: 'cancel' },
  });
});

test('shutdown closes every active ephemeral client and drops pending ownership', async () => {
  const clients = [];
  const interaction = new CodexInteraction({
    clientFactory() {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  });

  await interaction.sendExisting({
    sessionId: 'codex:shutdown-a',
    nativeSessionId: 'shutdown-a',
    streamId: 'shutdown-stream-a',
    text: 'a',
    callbacks: callbacks().value,
  });
  await interaction.sendExisting({
    sessionId: 'codex:shutdown-b',
    nativeSessionId: 'shutdown-b',
    streamId: 'shutdown-stream-b',
    text: 'b',
    callbacks: callbacks().value,
  });

  assert.equal(interaction.owns('shutdown-a'), true);
  assert.equal(interaction.owns('shutdown-b'), true);
  await interaction.shutdown();
  assert.deepEqual(clients.map((client) => client.stopCalls), [1, 1]);
  assert.equal(interaction.owns('shutdown-a'), false);
  assert.equal(interaction.owns('shutdown-b'), false);
});
