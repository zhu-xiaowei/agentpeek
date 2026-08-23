import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClientTurnOrder,
} from '../../bridge/client-turn-order.mjs';

test('reversed delivery is reordered before messages reach the runtime', async () => {
  const order = new ClientTurnOrder();
  const started = [];

  const third = order.run({
    turnId: 'turn-3',
    previousTurnId: 'turn-2',
  }, async () => {
    started.push('turn-3');
  });
  const second = order.run({
    turnId: 'turn-2',
    previousTurnId: 'turn-1',
  }, async () => {
    started.push('turn-2');
  });
  const first = order.run({
    turnId: 'turn-1',
  }, async () => {
    started.push('turn-1');
  });

  await Promise.all([first, second, third]);
  assert.deepEqual(started, ['turn-1', 'turn-2', 'turn-3']);
});

test('a missing predecessor times out and clears its waiter', async () => {
  const order = new ClientTurnOrder({ waitTimeoutMs: 10 });
  let submitted = false;

  await assert.rejects(
    order.run({
      turnId: 'turn-2',
      previousTurnId: 'missing-turn',
    }, async () => {
      submitted = true;
    }),
    (error) => error.code === 'previous_turn_missing'
      && error.previousTurnId === 'missing-turn',
  );

  assert.equal(submitted, false);
  assert.equal(order.waiters.size, 0);
});
