export class ClientTurnOrder {
  constructor(options = {}) {
    this.waiters = new Map();
    this.submitted = new Set();
    this.maxSubmitted = Math.max(100, options.maxSubmitted || 5000);
    this.waitTimeoutMs = Math.max(1, options.waitTimeoutMs || 3000);
  }

  deferred(turnId) {
    var current = this.waiters.get(turnId);
    if (current) return current;
    var resolve;
    var promise = new Promise((done) => { resolve = done; });
    current = { promise, resolve, waiting: 0 };
    this.waiters.set(turnId, current);
    return current;
  }

  async waitFor(turnId) {
    if (!turnId || this.submitted.has(turnId)) return;
    var current = this.deferred(turnId);
    current.waiting++;
    var timer;
    try {
      await Promise.race([
        current.promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            var error = new Error(`Previous turn ${turnId} did not reach the Bridge`);
            error.code = 'previous_turn_missing';
            error.previousTurnId = turnId;
            reject(error);
          }, this.waitTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      current.waiting--;
      if (current.waiting === 0
        && !this.submitted.has(turnId)
        && this.waiters.get(turnId) === current) {
        this.waiters.delete(turnId);
      }
    }
  }

  markSubmitted(turnId) {
    if (!turnId || this.submitted.has(turnId)) return false;
    this.submitted.add(turnId);
    var waiter = this.waiters.get(turnId);
    if (waiter) {
      this.waiters.delete(turnId);
      waiter.resolve();
    }
    while (this.submitted.size > this.maxSubmitted) {
      this.submitted.delete(this.submitted.values().next().value);
    }
    return true;
  }

  async run(message, task) {
    var turnId = message?.turnId || '';
    var previousTurnId = message?.previousTurnId || '';
    if (previousTurnId && previousTurnId !== turnId) {
      await this.waitFor(previousTurnId);
    }
    try {
      // task resolves once the runtime accepts/enqueues the message.
      // Runtime turn completion is intentionally not part of transport ordering.
      return await task();
    } finally {
      this.markSubmitted(turnId);
    }
  }
}
