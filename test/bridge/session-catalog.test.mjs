import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildCatalogAggregates,
  isRecentSession,
  knownProjects,
  lastKnownStatus,
  recentSessions,
  syncSessions,
  uploadCatalog,
} from '../../bridge/sync.mjs';
import { synced } from '../../bridge/extract.mjs';
import {
  rebuildAgentCounts,
  trackAgentSession,
} from '../../bridge/agent-counts.mjs';

const CODEX_FIXTURE = fileURLToPath(new URL(
  '../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl',
  import.meta.url,
));

function session(index, runtime = 'claude', project = '-repo') {
  const id = String(index).padStart(4, '0');
  return {
    id,
    nativeSessionId: id,
    runtime,
    project,
    projectName: 'repo',
    lastActive: `2026-08-06T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    status: index % 3 === 0 ? 'running' : 'completed',
    _filePath: `/private/${id}.jsonl`,
    _lineCount: 10,
  };
}

test('mixed runtime catalog aggregates into the same project', () => {
  const capabilities = { claude: { canRead: true }, codex: { canRead: true } };
  const aggregates = buildCatalogAggregates([
    session(1, 'claude'),
    session(2, 'codex'),
    session(3, 'codex', '-other'),
  ], capabilities);
  assert.equal(aggregates.deviceAggregate.sessionCount, 3);
  assert.equal(aggregates.deviceAggregate.projectCount, 2);
  assert.equal(aggregates.deviceAggregate.runningCount, 1);
  assert.equal(aggregates.deviceAggregate.runtimeCapabilities, capabilities);
  assert.equal(aggregates.projectAggregates.find((p) => p.projectHash === '-repo').sessionCount, 2);
});

test('catalog aggregates count root sessions but still upload child threads', async () => {
  const root = session(1, 'codex');
  const child = {
    ...session(2, 'codex'),
    status: 'running',
    parentSessionId: 'codex:0001',
    threadKind: 'subagent',
  };
  rebuildAgentCounts([root, child]);
  const aggregates = buildCatalogAggregates([root, child]);
  assert.equal(aggregates.deviceAggregate.sessionCount, 1);
  assert.equal(aggregates.projectAggregates[0].sessionCount, 1);
  assert.equal(aggregates.deviceAggregate.runningCount, 1);
  assert.equal(aggregates.projectAggregates[0].runningCount, 1);
  assert.equal(root.agentCount, 1);
  assert.equal(root.runningAgentCount, 1);
  assert.equal(root.activeStatus, 'running');
  assert.equal(root.threadRootId, 'codex:0001');
  assert.equal(child.threadRootId, 'codex:0001');

  const requests = [];
  await uploadCatalog(
    { deviceName: 'Mac' },
    [root, child],
    aggregates,
    true,
    async (_url, body) => requests.push(body),
  );
  assert.equal(requests[0].sessions.length, 2);
  assert.equal(requests[0].sessions[0].agentCount, 1);
  assert.equal(requests[0].sessions[0].threadRootId, 'codex:0001');
  assert.equal(requests[0].sessions[1].threadRootId, 'codex:0001');
  assert.equal(requests[0].sessions[1].parentSessionId, 'codex:0001');
});

test('agent count tracking overwrites exact Set size across duplicates and internal migration', () => {
  const root = session(1, 'codex');
  const first = {
    ...session(2, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'subagent',
  };
  const second = {
    ...session(3, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'subagent',
  };
  const guardian = {
    ...session(4, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'internal',
  };
  const grandchild = {
    ...session(5, 'codex'),
    parentSessionId: 'codex:0002',
    threadKind: 'subagent',
  };

  rebuildAgentCounts([root, first, second, guardian, grandchild]);
  assert.equal(root.agentCount, 3);
  assert.equal(root.runningAgentCount, 1);
  assert.equal(root.needsInputAgentCount, 0);
  assert.equal(root.activeStatus, 'running');
  assert.equal(root.threadRootId, 'codex:0001');
  assert.equal(first.threadRootId, 'codex:0001');
  assert.equal(grandchild.threadRootId, 'codex:0001');
  assert.equal(guardian.threadRootId, '');
  assert.deepEqual(trackAgentSession(first), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 1,
    needsInputAgentCount: 0,
    activeStatus: 'running',
  }]);
  assert.deepEqual(trackAgentSession(grandchild), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 1,
    needsInputAgentCount: 0,
    activeStatus: 'running',
  }]);
  assert.deepEqual(trackAgentSession({ ...second, status: 'completed' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 0,
    needsInputAgentCount: 0,
    activeStatus: 'completed',
  }]);
  assert.deepEqual(trackAgentSession({ ...grandchild, status: 'needs_input' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 0,
    needsInputAgentCount: 1,
    activeStatus: 'needs_input',
  }]);
  assert.deepEqual(trackAgentSession({ ...first, threadKind: 'internal' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 1,
    runningAgentCount: 0,
    needsInputAgentCount: 0,
    activeStatus: 'completed',
  }]);
  assert.deepEqual(trackAgentSession(guardian), []);
});

test('catalog batching sends authoritative aggregates only in the first request', async () => {
  const sessions = Array.from({ length: 5001 }, (_, index) => session(index));
  const aggregates = buildCatalogAggregates(sessions);
  const requests = [];
  await uploadCatalog(
    { deviceName: 'Mac', deviceDisplayName: 'Office Mac' },
    sessions,
    aggregates,
    true,
    async (url, body) => requests.push({ url, body }),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.sessions.length, 5000);
  assert.equal(requests[0].body.deviceDisplayName, 'Office Mac');
  assert.equal(requests[0].body.catalogComplete, true);
  assert.ok(requests[0].body.device);
  assert.ok(requests[0].body.projects);
  assert.equal(requests[1].body.sessions.length, 1);
  assert.equal(requests[1].body.catalogComplete, true);
  assert.equal(requests[1].body.device, undefined);
  assert.equal(requests[1].body.projects, undefined);
  assert.equal(requests[0].body.sessions[0]._filePath, undefined);
});

test('incomplete discovery sends candidate aggregates for server-side bootstrap', async () => {
  const requests = [];
  await uploadCatalog(
    { deviceName: 'Mac' },
    [session(1, 'codex')],
    buildCatalogAggregates([session(1, 'codex')]),
    false,
    async (_url, body) => requests.push(body),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].catalogComplete, false);
  assert.equal(requests[0].device.sessionCount, 1);
  assert.equal(requests[0].projects.length, 1);
});

test('24-hour cutoff includes the boundary and future timestamps', () => {
  const now = Date.parse('2026-08-06T12:00:00.000Z');
  assert.equal(isRecentSession('2026-08-05T11:59:59.999Z', now), false);
  assert.equal(isRecentSession('2026-08-05T12:00:00.000Z', now), true);
  assert.equal(isRecentSession('2026-08-06T12:01:00.000Z', now), true);
});

test('startup accepts Claude-only, Codex-only, mixed, and empty catalogs', async () => {
  const cases = [
    { claude: [session(1, 'claude')], codex: [], expected: 1 },
    { claude: [], codex: [session(2, 'codex')], expected: 1 },
    { claude: [session(3, 'claude')], codex: [session(4, 'codex')], expected: 2 },
    { claude: [], codex: [], expected: 0 },
  ];
  for (const item of cases) {
    synced.clear();
    recentSessions.clear();
    lastKnownStatus.clear();
    knownProjects.clear();
    let aggregate;
    let messageUploads = 0;
    const result = await syncSessions({ deviceName: 'test' }, {
      skipMessages: true,
      runtimeCatalogs: {
        claude: { sessions: item.claude, complete: true },
        codex: {
          sessions: item.codex,
          complete: true,
          diagnostics: { files: item.codex.length, errors: [], malformedLines: 0 },
        },
      },
      runtimeCapabilities: { claude: {}, codex: {} },
      postFn: async (_url, body) => { if (body.device) aggregate = body.device; },
      messageUploader: async () => { messageUploads++; },
    });
    assert.equal(result.sessions.length, item.expected);
    assert.equal(aggregate.sessionCount, item.expected);
    assert.equal(messageUploads, 0);
    assert.equal(result.messageCount, 0);
    assert.equal(synced.size, item.expected);
    assert.equal(recentSessions.size, item.expected);
  }
});

test('startup reports messages written during recovery', async () => {
  synced.clear();
  recentSessions.clear();
  lastKnownStatus.clear();
  knownProjects.clear();
  const recovered = {
    ...session(1, 'codex'),
    id: '22222222-2222-4222-8222-222222222222',
    nativeSessionId: '22222222-2222-4222-8222-222222222222',
    lastActive: '2026-08-06T00:00:10.000Z',
    _filePath: CODEX_FIXTURE,
  };
  let uploaded = 0;

  const result = await syncSessions({ deviceName: 'test' }, {
    now: Date.parse('2026-08-06T00:00:20.000Z'),
    runtimeCatalogs: {
      claude: { sessions: [], complete: true },
      codex: {
        sessions: [recovered],
        complete: true,
        diagnostics: { files: 1, errors: [], malformedLines: 0 },
      },
    },
    runtimeCapabilities: { claude: {}, codex: {} },
    postFn: async () => {},
    messageUploader: async (_sessionId, messages) => { uploaded += messages.length; },
  });

  assert.ok(uploaded > 0);
  assert.equal(result.messageCount, uploaded);
});
