import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pollAgentStates,
  resetAgentPollState,
  shouldPersistClaudeJsonlMessage,
} from '../../bridge/watcher.mjs';

test('runtime-owned Claude JSONL rows are persistence-only', () => {
  assert.equal(shouldPersistClaudeJsonlMessage(true, null), true);
  assert.equal(shouldPersistClaudeJsonlMessage(false, {
    pushed: true,
    runtimeOwned: true,
  }), true);
});

test('external Claude JSONL rows remain realtime', () => {
  assert.equal(shouldPersistClaudeJsonlMessage(false, null), false);
  assert.equal(shouldPersistClaudeJsonlMessage(false, {
    pushed: false,
    runtimeOwned: false,
  }), false);
});

test('failed realtime agent status push is retried on the next poll', async () => {
  resetAgentPollState();
  const agents = new Map([['agent-session-1', {
    agentName: 'worker',
    agentDetail: '',
    status: 'completed',
  }]]);
  let attempts = 0;
  const options = {
    agents,
    findSessionFile: () => '/tmp/agent-session-1.jsonl',
    poolOwns: () => false,
    getSessionMetadata: () => ({ preview: 'worker', model: 'test' }),
    pushAgentMeta: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary server failure');
    },
  };

  await pollAgentStates({ deviceName: 'test' }, options);
  await pollAgentStates({ deviceName: 'test' }, options);
  await pollAgentStates({ deviceName: 'test' }, options);

  assert.equal(attempts, 2);
  resetAgentPollState();
});
