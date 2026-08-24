function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  var sorted = {};
  Object.keys(value).sort().forEach(function (key) {
    sorted[key] = stableValue(value[key]);
  });
  return sorted;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value == null ? null : value));
}

function turnIdOf(event) {
  return event?.turnId || '';
}

function validInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export class TurnEventQueue {
  constructor() {
    this.turns = new Map();
    this.lateJoinCompletions = [];
    this.lateJoinUpdates = [];
    this.closedTurns = new Set();
  }

  push(event) {
    if (!event?.turnId) throw new Error('turnId is required');
    if (!validInteger(event.seq)) throw new Error('seq is required');
    if (this.closedTurns.has(event.turnId)) return [];
    var turn = this.turns.get(event.turnId);
    if (!turn) {
      turn = {
        nextSeq: 0,
        pending: new Map(),
        applied: new Map(),
        skipped: new Map(),
        releasedAuthoritySeqs: new Set(),
        resumeFloor: null,
      };
      this.turns.set(event.turnId, turn);
    }
    if (event.seq < turn.nextSeq) {
      if (turn.resumeFloor != null && event.seq < turn.resumeFloor) {
        var skipped = turn.skipped.get(event.seq);
        if (skipped && stableJson(skipped) !== stableJson(event)) {
          throw new Error('conflicting event for turn ' + event.turnId
            + ' seq ' + event.seq);
        }
        if (!skipped) {
          turn.skipped.set(event.seq, event);
          this.queueLateJoinUpdate(event);
        }
        return [];
      }
      if (stableJson(turn.applied.get(event.seq)) !== stableJson(event)) {
        throw new Error('conflicting event for turn ' + event.turnId
          + ' seq ' + event.seq);
      }
      return [];
    }
    if (turn.pending.has(event.seq)) {
      if (stableJson(turn.pending.get(event.seq)) !== stableJson(event)) {
        throw new Error('conflicting event for turn ' + event.turnId
          + ' seq ' + event.seq);
      }
      return [];
    }
    turn.pending.set(event.seq, event);
    if (turn.nextSeq === 0 && event.seq > 1
      && event.action === 'messages'
      && !turn.releasedAuthoritySeqs.has(event.seq)) {
      turn.releasedAuthoritySeqs.add(event.seq);
      this.queueLateJoinUpdate(event);
    }
    var ready = [];
    if (turn.nextSeq === 0
      && event.seq === 1
      && event.action === 'messages') {
      var syntheticStart = {
        action: 'stream_turn_start',
        sessionId: event.sessionId,
        turnId: event.turnId,
        seq: 0,
      };
      ready.push(syntheticStart);
      turn.applied.set(0, syntheticStart);
      turn.nextSeq = 1;
    }
    ready.push.apply(ready, this.drainTurn(turn));
    return ready;
  }

  isResumeCandidate(turnId) {
    var turn = this.turns.get(turnId);
    if (!turn || turn.nextSeq !== 0 || turn.pending.has(0)
      || turn.pending.has(1)) {
      return false;
    }
    for (var event of turn.pending.values()) {
      if (this.isResumeCheckpoint(event)) return true;
    }
    return false;
  }

  resumeAtNextCheckpoint(turnId) {
    if (!this.isResumeCandidate(turnId)) return null;
    var turn = this.turns.get(turnId);
    var start = Array.from(turn.pending.values())
      .filter((event) => this.isResumeCheckpoint(event))
      .sort(function (left, right) {
        return left.seq - right.seq;
      })[0];
    if (!start) return null;

    var prefix = Array.from(turn.pending.values())
      .filter(function (event) {
        return event.seq < start.seq;
      })
      .sort(function (left, right) {
        return left.seq - right.seq;
      });
    for (var event of prefix) {
      turn.pending.delete(event.seq);
      turn.skipped.set(event.seq, event);
    }

    var syntheticStart = {
      action: 'stream_turn_start',
      sessionId: start.sessionId,
      turnId: start.turnId,
      seq: 0,
    };
    turn.applied.set(0, syntheticStart);
    turn.resumeFloor = start.seq;
    turn.nextSeq = start.seq;
    return {
      events: [syntheticStart].concat(this.drainTurn(turn)),
      messages: this.messagesFromEvents(prefix),
    };
  }

  isResumeCheckpoint(event) {
    return event?.action === 'stream_block_start'
      || event?.action === 'permission_request';
  }

  isLateJoinCandidate(turnId) {
    var turn = this.turns.get(turnId);
    if (!turn || turn.nextSeq !== 0 || turn.pending.has(0)) return false;
    for (var event of turn.pending.values()) {
      if (event.action === 'stream_end') return true;
    }
    return false;
  }

  isGappedEndCandidate(turnId) {
    var turn = this.turns.get(turnId);
    if (!turn || turn.nextSeq === 0 || turn.pending.has(turn.nextSeq)) {
      return false;
    }
    for (var event of turn.pending.values()) {
      if (event.action === 'stream_end') return true;
    }
    return false;
  }

  completeGappedEnd(turnId) {
    if (!this.isGappedEndCandidate(turnId)) return false;
    var turn = this.turns.get(turnId);
    var events = Array.from(turn.applied.values())
      .concat(Array.from(turn.pending.values()))
      .sort(function (left, right) { return left.seq - right.seq; });
    var end = events.find(function (event) {
      return event.action === 'stream_end';
    }) || null;
    var authorityEvents = events.slice();
    if (Array.isArray(end?.messages)) {
      authorityEvents.push({
        action: 'messages',
        messages: end.messages,
      });
    }
    this.lateJoinCompletions.push({
      sessionId: end?.sessionId || events[0]?.sessionId || '',
      turnId: turnId,
      messages: this.messagesFromEvents(authorityEvents),
      end: end,
      gapped: true,
      missingSeq: turn.nextSeq,
    });
    this.closeTurn(turnId);
    return true;
  }

  completeLateJoin(turnId) {
    if (!this.isLateJoinCandidate(turnId)) return false;
    var turn = this.turns.get(turnId);
    var events = Array.from(turn.pending.values())
      .sort(function (left, right) { return left.seq - right.seq; });
    var end = events.find(function (event) {
      return event.action === 'stream_end';
    }) || null;
    var messages = [];
    for (var event of events) {
      if (event.action === 'messages' && Array.isArray(event.messages)) {
        messages.push.apply(messages, event.messages);
      }
    }
    if (Array.isArray(end?.messages)) {
      messages.push.apply(messages, end.messages);
    }
    var seen = new Set();
    messages = messages.filter(function (message) {
      var key = message?.nativeId
        ? 'native:' + message.nativeId
        : message?.uuid
          ? 'uuid:' + message.uuid
          : stableJson(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.lateJoinCompletions.push({
      sessionId: end?.sessionId || events[0]?.sessionId || '',
      turnId: turnId,
      messages: messages,
      end: end,
      lateJoin: true,
    });
    this.closeTurn(turnId);
    return true;
  }

  takeLateJoinCompletions() {
    var completions = this.lateJoinCompletions;
    this.lateJoinCompletions = [];
    return completions;
  }

  takeLateJoinUpdates() {
    var updates = this.lateJoinUpdates;
    this.lateJoinUpdates = [];
    return updates;
  }

  closeTurn(turnId) {
    if (!turnId) return false;
    var removed = this.turns.delete(turnId);
    this.lateJoinUpdates = this.lateJoinUpdates.filter(function (update) {
      return update.turnId !== turnId;
    });
    this.closedTurns.delete(turnId);
    this.closedTurns.add(turnId);
    return removed;
  }

  restartTurn(turnId) {
    if (!turnId) return false;
    var removed = this.turns.delete(turnId);
    this.lateJoinCompletions = this.lateJoinCompletions.filter(function (item) {
      return item.turnId !== turnId;
    });
    this.lateJoinUpdates = this.lateJoinUpdates.filter(function (item) {
      return item.turnId !== turnId;
    });
    this.closedTurns.delete(turnId);
    return removed;
  }

  reset() {
    this.turns.clear();
    this.lateJoinCompletions = [];
    this.lateJoinUpdates = [];
    this.closedTurns.clear();
  }

  drainTurn(turn) {
    var ready = [];
    while (turn.pending.has(turn.nextSeq)) {
      var next = turn.pending.get(turn.nextSeq);
      ready.push(next);
      turn.applied.set(turn.nextSeq, next);
      turn.pending.delete(turn.nextSeq);
      turn.nextSeq++;
    }
    return ready;
  }

  queueLateJoinUpdate(event) {
    var messages = this.messagesFromEvents([event]);
    if (!messages.length) return;
    this.lateJoinUpdates.push({
      sessionId: event.sessionId || '',
      turnId: event.turnId || '',
      messages: messages,
    });
  }

  messagesFromEvents(events) {
    var messages = [];
    for (var event of events) {
      if (event.action === 'messages' && Array.isArray(event.messages)) {
        messages.push.apply(messages, event.messages);
      }
    }
    var seen = new Set();
    return messages.filter(function (message) {
      var key = message?.nativeId
        ? 'native:' + message.nativeId
        : message?.uuid
          ? 'uuid:' + message.uuid
          : stableJson(message);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

class BlockState {
  constructor(blockId, kind = 'text', name = '') {
    this.blockId = blockId;
    this.kind = kind || 'text';
    this.name = name || '';
    this.text = '';
    this.inputJson = '';
    this.started = false;
    this.stopped = false;
    this.displayStarted = false;
    this.displayComplete = false;
    this.finishInputEmitted = false;
    this.authoritative = false;
    this.authorityAssigned = false;
    this.toolUseId = '';
  }

  start(kind, name) {
    this.started = true;
    if (kind) this.kind = kind;
    if (name) this.name = name;
  }

  appendText(chunk) {
    this.text += chunk || '';
  }

  appendInput(chunk) {
    this.kind = 'tool_use';
    this.inputJson += chunk || '';
  }

  stop() {
    this.stopped = true;
  }

  isTool() {
    return this.kind === 'tool_use';
  }

  isRenderable() {
    return this.isTool() || this.text.length > 0;
  }

  snapshot() {
    return {
      blockId: this.blockId,
      kind: this.kind,
      name: this.name,
      text: this.text,
      inputJson: this.inputJson,
      toolUseId: this.toolUseId,
      stopped: this.stopped,
      authoritative: this.authoritative,
      displayComplete: this.displayComplete,
    };
  }

  matches(authoritative) {
    if (!authoritative || this.kind !== authoritative.kind) return false;
    if (this.kind === 'tool_use') {
      return this.name === (authoritative.name || '')
        && stableJson(this.inputObject()) === stableJson(authoritative.input)
        && (!authoritative.toolUseId || this.toolUseId === authoritative.toolUseId);
    }
    return this.text === (authoritative.text || '');
  }

  inputObject() {
    if (!this.inputJson) return null;
    try {
      return JSON.parse(this.inputJson);
    } catch (_) {
      return this.inputJson;
    }
  }

  applyAuthoritative(authoritative) {
    this.kind = authoritative.kind;
    this.name = authoritative.name || '';
    this.text = authoritative.text || '';
    this.inputJson = authoritative.kind === 'tool_use'
      ? stableJson(authoritative.input || {})
      : '';
    this.toolUseId = authoritative.toolUseId || this.toolUseId;
    this.started = true;
    this.stopped = true;
    this.authoritative = true;
  }
}

class TurnState {
  constructor(identity) {
    this.sessionId = identity.sessionId;
    this.turnId = identity.turnId;
    this.blocks = new Map();
    this.currentBlockId = null;
    this.visibleBlockIndex = 0;
    this.lastAppliedBlockId = null;
    this.turnVisible = false;
    this.endReceived = false;
    this.receivedAuthoritativeIds = new Set();
    this.pendingAuthorityBlocks = new Map();
    this.unassignedAuthorityBlocks = [];
    this.completed = false;
    this.reconnecting = false;
    this.reconnectBlockIds = new Set();
  }

  applyFrame(frame) {
    var block;
    switch (frame.type) {
      case 'start':
        this.currentBlockId = frame.seq;
        block = this.ensureBlock(frame.seq, frame.kind, frame.name);
        block.start(frame.kind, frame.name);
        break;
      case 'delta':
        block = this.inputBlock();
        if (!block) return false;
        block.appendText(frame.chunk);
        break;
      case 'input':
        block = this.inputBlock();
        if (!block) return false;
        block.appendInput(frame.chunk);
        break;
      case 'stop':
        block = this.inputBlock();
        if (!block) return false;
        block.stop();
        this.currentBlockId = null;
        break;
    }
    this.lastAppliedBlockId = block.blockId;
    return true;
  }

  ensureBlock(blockId, kind, name) {
    var id = validInteger(blockId) ? blockId : 0;
    var block = this.blocks.get(id);
    if (!block) {
      block = new BlockState(id, kind, name);
      this.blocks.set(id, block);
    }
    return block;
  }

  orderedBlocks() {
    return Array.from(this.blocks.values()).sort(function (a, b) {
      return a.blockId - b.blockId;
    });
  }

  currentBlock() {
    return this.orderedBlocks()[this.visibleBlockIndex] || null;
  }

  inputBlock() {
    return this.currentBlockId == null
      ? null
      : this.blocks.get(this.currentBlockId) || null;
  }

  receiveEnd() {
    this.endReceived = true;
    var block = this.inputBlock();
    if (block) {
      block.stop();
      this.currentBlockId = null;
    }
    return block;
  }

  receiveAuthoritative(payload) {
    var messageId = payload.message?.nativeId
      || payload.messageId
      || payload.message?.uuid
      || '';
    if (messageId && this.receivedAuthoritativeIds.has(messageId)) return false;
    if (messageId) this.receivedAuthoritativeIds.add(messageId);
    return true;
  }

  displayComplete() {
    return this.orderedBlocks().every(function (block) {
      return block.displayComplete || !block.isRenderable();
    });
  }
}

export class StreamCoordinator {
  constructor(sessionId = '') {
    this.sessionId = sessionId;
    this.turns = new Map();
    this.turnOrder = [];
    this.activeTurnId = '';
    this.operations = [];
  }

  resetSession(sessionId = '') {
    this.sessionId = sessionId;
    this.turns.clear();
    this.turnOrder = [];
    this.activeTurnId = '';
    this.operations = [];
  }

  startTurn(event) {
    this.validateIdentity(event);
    var turnId = turnIdOf(event);
    var existing = this.turns.get(turnId);
    if (existing) return existing;
    var turn = new TurnState(event);
    this.turns.set(turnId, turn);
    this.turnOrder.push(turnId);
    this.activateNextTurn();
    return turn;
  }

  ingestFrame(event) {
    this.validateSession(event);
    var turnId = event.turnId;
    var turn = this.turns.get(turnId);
    if (!turn || !turn.applyFrame(event)) return false;
    this.assignAuthoritativeBlocks(turn);
    this.reconcileReconnectTurn(turn);
    if (turnId === this.activeTurnId) this.consumeVisibleFrame(turn, event);
    return true;
  }

  ingestAuthoritative(payload) {
    this.validateSession(payload);
    var turnId = turnIdOf(payload);
    var turn = this.turns.get(turnId);
    if (!turn) return false;
    if (!turn.receiveAuthoritative(payload)) return false;
    turn.unassignedAuthorityBlocks.push.apply(
      turn.unassignedAuthorityBlocks,
      normalizeAuthoritativeBlocks(payload),
    );
    this.assignAuthoritativeBlocks(turn);
    this.reconcileReconnectTurn(turn);
    this.finishTurnIfReady(turn);
    return true;
  }

  endTurn(event) {
    this.validateSession(event);
    var turnId = event.turnId;
    var turn = this.turns.get(turnId);
    if (!turn) return false;
    var endedBlock = turn.receiveEnd();
    if (turnId === this.activeTurnId && endedBlock) {
      this.showVisibleBlock(turn);
      this.finishVisibleBlockInput(turn, endedBlock);
    }
    this.finishTurnIfReady(turn);
    return true;
  }

  completeBlockReveal(turnId, blockId) {
    var turn = this.turns.get(turnId);
    var visible = turn?.currentBlock();
    if (!turn || turnId !== this.activeTurnId || visible?.blockId !== blockId) {
      return false;
    }
    var block = turn.blocks.get(blockId);
    if (!block || (!block.stopped && !block.authoritative)) return false;
    this.commitVisibleBlock(turn, block);
    return true;
  }

  takeOperations() {
    var operations = this.operations;
    this.operations = [];
    return operations;
  }

  getTurn(turnId) {
    return this.turns.get(turnId) || null;
  }

  hasActiveTurns() {
    for (var turn of this.turns.values()) {
      if (!turn.completed) return true;
    }
    return false;
  }

  activeTurnIds() {
    return Array.from(this.turns.values())
      .filter(function (turn) { return !turn.completed; })
      .map(function (turn) { return turn.turnId; });
  }

  prepareTurnsForReconnect(turnIds) {
    var reconnecting = new Set(turnIds || []);
    var prepared = 0;
    for (var turnId of reconnecting) {
      var turn = this.turns.get(turnId);
      if (!turn || turn.completed) continue;
      turn.reconnecting = true;
      turn.reconnectBlockIds = new Set(
        turn.orderedBlocks()
          .filter(function (block) {
            return !block.displayComplete && block.isRenderable();
          })
          .map(function (block) { return block.blockId; }),
      );
      prepared++;
    }
    return prepared;
  }

  settleTurn(turnId) {
    var turn = this.turns.get(turnId);
    if (!turn || turn.completed) return false;
    turn.receiveEnd();
    for (var block of turn.blocks.values()) {
      if (turn.pendingAuthorityBlocks.has(block.blockId)) {
        this.reconcileBlock(turn, block);
      }
      if (!block.authoritative) {
        this.emit({
          type: 'discardBlock',
          turnId: turn.turnId,
          blockId: block.blockId,
        });
        continue;
      }
      block.stopped = true;
      block.displayComplete = true;
    }
    turn.completed = true;
    this.emit({
      type: 'completeTurn',
      turnId: turn.turnId,
    });
    this.turns.delete(turn.turnId);
    this.turnOrder = this.turnOrder.filter(function (candidate) {
      return candidate !== turn.turnId;
    });
    if (this.activeTurnId === turn.turnId) this.activeTurnId = '';
    this.activateNextTurn();
    return true;
  }

  validateIdentity(event) {
    this.validateSession(event);
    if (!turnIdOf(event)) throw new Error('turnId is required');
  }

  validateSession(event) {
    if (!event?.sessionId) throw new Error('sessionId is required');
    if (this.sessionId && event.sessionId !== this.sessionId) {
      throw new Error('event belongs to another session');
    }
    if (!this.sessionId) this.sessionId = event.sessionId;
  }

  activateNextTurn() {
    if (this.activeTurnId) return;
    var turn = null;
    for (var turnId of this.turnOrder) {
      var candidate = this.turns.get(turnId);
      if (candidate && !candidate.completed) {
        turn = candidate;
        break;
      }
    }
    if (!turn) return;
    this.activeTurnId = turn.turnId;
    this.showVisibleBlock(turn);
  }

  consumeVisibleFrame(turn, frame) {
    var blockId = turn.lastAppliedBlockId;
    if (turn.currentBlock()?.blockId !== blockId) return;
    var block = turn.blocks.get(blockId);
    if (!block) return;
    if (frame.type === 'start') {
      if (block.isTool()) this.showVisibleBlock(turn);
      return;
    }
    if (frame.type === 'delta') {
      var created = this.showVisibleBlock(turn);
      if (!created && block.displayStarted) {
        this.emit({
          type: 'appendText',
          turnId: turn.turnId,
          blockId: block.blockId,
          chunk: frame.chunk || '',
        });
      }
      return;
    }
    if (frame.type === 'input') {
      var inputCreated = this.showVisibleBlock(turn);
      if (!inputCreated && block.displayStarted) {
        this.emit({
          type: 'updateToolInput',
          turnId: turn.turnId,
          blockId: block.blockId,
          inputJson: block.inputJson,
        });
      }
      return;
    }
    if (frame.type === 'stop') this.finishVisibleBlockInput(turn, block);
  }

  showVisibleBlock(turn) {
    if (turn.turnId !== this.activeTurnId) return false;
    var block = turn.currentBlock();
    if (!block || !block.isRenderable() || block.displayStarted) return false;
    if (!turn.turnVisible) {
      turn.turnVisible = true;
      this.emit({
        type: 'createTurn',
        turnId: turn.turnId,
      });
    }
    block.displayStarted = true;
    this.emit({
      type: 'createBlock',
      turnId: turn.turnId,
      blockId: block.blockId,
      block: block.snapshot(),
    });
    if (block.isTool()) {
      if (block.inputJson) {
        this.emit({
          type: 'updateToolInput',
          turnId: turn.turnId,
          blockId: block.blockId,
          inputJson: block.inputJson,
        });
      }
    } else if (block.text) {
      this.emit({
        type: 'appendText',
        turnId: turn.turnId,
        blockId: block.blockId,
        chunk: block.text,
      });
    }
    if (block.stopped) this.finishVisibleBlockInput(turn, block);
    return true;
  }

  finishVisibleBlockInput(turn, block) {
    if (block.displayComplete) return;
    if (block.isTool() || !block.isRenderable()) {
      this.commitVisibleBlock(turn, block);
      return;
    }
    if (!block.finishInputEmitted) {
      block.finishInputEmitted = true;
      this.emit({
        type: 'finishBlockInput',
        turnId: turn.turnId,
        blockId: block.blockId,
      });
    }
  }

  commitVisibleBlock(turn, block) {
    if (block.displayComplete) return;
    block.displayComplete = true;
    this.emit({
      type: 'commitBlock',
      turnId: turn.turnId,
      blockId: block.blockId,
    });
    this.reconcileBlock(turn, block);
    turn.visibleBlockIndex++;
    this.showVisibleBlock(turn);
    this.finishTurnIfReady(turn);
  }

  finishTurnIfReady(turn) {
    if (turn.completed || turn.turnId !== this.activeTurnId) return false;
    if (!turn.endReceived || !turn.displayComplete()) {
      return false;
    }
    turn.completed = true;
    this.emit({
      type: 'completeTurn',
      turnId: turn.turnId,
    });
    this.turns.delete(turn.turnId);
    this.turnOrder = this.turnOrder.filter(function (turnId) {
      return turnId !== turn.turnId;
    });
    this.activeTurnId = '';
    this.activateNextTurn();
    return true;
  }

  assignAuthoritativeBlocks(turn) {
    if (!turn.unassignedAuthorityBlocks.length) return;
    var remaining = [];
    for (var authoritative of turn.unassignedAuthorityBlocks) {
      var block = turn.orderedBlocks().find(function (candidate) {
        if (candidate.authorityAssigned
          || candidate.kind !== authoritative.kind) return false;
        return authoritative.kind !== 'tool_use'
          || !authoritative.name
          || !candidate.name
          || candidate.name === authoritative.name;
      });
      if (!block) {
        remaining.push(authoritative);
        continue;
      }
      block.authorityAssigned = true;
      turn.pendingAuthorityBlocks.set(block.blockId, authoritative);
      if (block.displayComplete) this.reconcileBlock(turn, block);
    }
    turn.unassignedAuthorityBlocks = remaining;
  }

  reconcileBlock(turn, block) {
    var authoritative = turn.pendingAuthorityBlocks.get(block.blockId);
    if (!authoritative) return false;
    var matches = block.matches(authoritative);
    block.applyAuthoritative(authoritative);
    block.displayComplete = true;
    turn.pendingAuthorityBlocks.delete(block.blockId);
    this.emitBlockReconcile(turn, block, matches);
    return true;
  }

  reconcileReconnectTurn(turn) {
    if (!turn.reconnecting || turn.completed) return false;
    var reconciled = false;
    while (true) {
      var block = turn.currentBlock();
      if (!block || block.displayComplete
        || !turn.reconnectBlockIds.has(block.blockId)
        || !turn.pendingAuthorityBlocks.has(block.blockId)) {
        break;
      }
      if (turn.currentBlockId === block.blockId) {
        turn.currentBlockId = null;
      }
      block.stopped = true;
      this.commitVisibleBlock(turn, block);
      turn.reconnectBlockIds.delete(block.blockId);
      if (!turn.reconnectBlockIds.size) turn.reconnecting = false;
      reconciled = true;
    }
    return reconciled;
  }

  emitBlockReconcile(turn, block, matches) {
    this.emit({
      type: matches ? 'confirmBlock' : 'patchBlock',
      turnId: turn.turnId,
      blockId: block.blockId,
      block: block.snapshot(),
    });
  }

  emit(operation) {
    this.operations.push(operation);
  }
}

function normalizeAuthoritativeBlocks(payload) {
  if (payload?.message?.type !== 'assistant') return [];
  var content = Array.isArray(payload?.message?.content)
    ? payload.message.content
    : [];
  var normalized = [];
  for (var index = 0; index < content.length; index++) {
    var source = content[index];
    if (!source) continue;
    if (!['text', 'thinking', 'tool_use'].includes(source.type)) continue;
    if (source.type === 'text') {
      normalized.push({
        kind: 'text',
        name: '',
        text: source.text || '',
      });
    } else if (source.type === 'thinking') {
      normalized.push({
        kind: 'thinking',
        name: '',
        text: source.thinking || '',
      });
    } else if (source.type === 'tool_use') {
      normalized.push({
        kind: 'tool_use',
        name: source.name || '',
        input: source.input || {},
        toolUseId: source.id || '',
      });
    }
  }
  return normalized;
}

function blockViewKey(turnId, blockId) {
  return turnId + ':' + blockId;
}

function classForBlock(kind) {
  if (kind === 'tool_use') return 'tl-item tool-node tool-running';
  if (kind === 'thinking') return 'tl-item thinking-tl';
  return 'tl-item assistant-text';
}

export class StreamingDomRenderer {
  constructor(options = {}) {
    this.document = options.document;
    this.getContainer = options.getContainer;
    this.findAnchor = options.findAnchor || function () { return null; };
    this.renderMarkdown = options.renderMarkdown || function (element, text) {
      element.textContent = text;
    };
    this.renderTool = options.renderTool || function (element, block) {
      element.textContent = block.name || 'Tool';
    };
    this.onBlockRevealComplete = options.onBlockRevealComplete || function () {};
    this.onMutation = options.onMutation || function () {};
    this.scheduleFrame = options.scheduleFrame
      || ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame
      || ((frameId) => cancelAnimationFrame(frameId));
    this.revealMinimum = Math.max(1, options.revealMinimum || 3);
    this.turnElements = new Map();
    this.blockViews = new Map();
    this.frameId = null;
  }

  applyOperations(operations) {
    for (var operation of operations || []) this.applyOperation(operation);
  }

  discardTurn(turnId) {
    var turn = this.turnElements.get(turnId);
    if (turn) {
      turn.remove();
      this.onMutation(turn);
    }
    this.turnElements.delete(turnId);
    for (var key of Array.from(this.blockViews.keys())) {
      if (key.startsWith(turnId + ':')) this.blockViews.delete(key);
    }
    return !!turn;
  }

  applyOperation(operation) {
    if (!operation?.type) return false;
    var method = {
      createTurn: 'createTurn',
      createBlock: 'createBlock',
      appendText: 'appendText',
      updateToolInput: 'updateToolInput',
      finishBlockInput: 'finishBlockInput',
      commitBlock: 'commitBlock',
      confirmBlock: 'confirmBlock',
      patchBlock: 'patchBlock',
      discardBlock: 'discardBlock',
      completeTurn: 'completeTurn',
    }[operation.type];
    if (!method) return false;
    this[method](operation);
    return true;
  }

  createTurn(operation) {
    if (this.turnElements.has(operation.turnId)) {
      return this.turnElements.get(operation.turnId);
    }
    var container = this.getContainer?.();
    if (!container) return null;
    var existing = Array.from(container.children).find(function (element) {
      return element.classList?.contains('assistant-turn')
        && element.dataset?.turnId === operation.turnId;
    });
    if (existing) {
      this.turnElements.set(operation.turnId, existing);
      return existing;
    }
    var turn = this.document.createElement('div');
    turn.className = 'assistant-turn stream-preview';
    turn.dataset.turnId = operation.turnId;
    this.insertTurn(container, turn, operation.turnId);
    this.turnElements.set(operation.turnId, turn);
    this.onMutation(turn);
    return turn;
  }

  insertTurn(container, turn, turnId) {
    var anchor = this.findAnchor(turnId);
    if (!anchor) {
      container.appendChild(turn);
      return;
    }
    var insertionPoint = anchor;
    while (insertionPoint.nextElementSibling?.classList.contains('assistant-turn')
      && insertionPoint.nextElementSibling !== turn) {
      insertionPoint = insertionPoint.nextElementSibling;
    }
    if (insertionPoint.nextElementSibling === turn) return;
    insertionPoint.insertAdjacentElement('afterend', turn);
  }

  attachTurnToAnchor(turnId) {
    var turn = this.turnElements.get(turnId);
    var container = this.getContainer?.();
    var anchor = this.findAnchor(turnId);
    if (!turn || !container || !anchor) return false;
    this.insertTurn(container, turn, turnId);
    this.onMutation(turn);
    return true;
  }

  createBlock(operation) {
    var turn = this.turnElements.get(operation.turnId)
      || this.createTurn(operation);
    if (!turn) return null;
    var key = blockViewKey(operation.turnId, operation.blockId);
    var existing = this.blockViews.get(key);
    if (existing) return existing.element;
    var element = Array.from(turn.children).find(function (child) {
      return child.dataset?.blockId === String(operation.blockId);
    });
    var adopted = !!element;
    if (!element) {
      element = this.document.createElement('div');
      element.className = classForBlock(operation.block.kind);
      element.dataset.blockId = String(operation.blockId);
      turn.appendChild(element);
    } else {
      element.classList.remove('tool-details-collapsed');
    }
    element.dataset.kind = operation.block.kind;
    var view = {
      turnId: operation.turnId,
      blockId: operation.blockId,
      element: element,
      block: { ...operation.block },
      targetText: '',
      shown: 0,
      inputFinished: false,
      revealReported: false,
      committed: adopted,
      adopted: adopted,
    };
    this.blockViews.set(key, view);
    if (!adopted) this.renderBlock(view);
    this.onMutation(element);
    return element;
  }

  appendText(operation) {
    var view = this.blockView(operation);
    if (!view || view.adopted) return;
    view.targetText += operation.chunk || '';
    this.scheduleReveal();
  }

  updateToolInput(operation) {
    var view = this.blockView(operation);
    if (!view || view.adopted) return;
    view.block.inputJson = operation.inputJson || '';
    this.renderTool(view.element, view.block);
    this.onMutation(view.element);
  }

  finishBlockInput(operation) {
    var view = this.blockView(operation);
    if (!view) return;
    view.inputFinished = true;
    if (view.adopted) {
      if (!view.revealReported) {
        view.revealReported = true;
        this.onBlockRevealComplete(view.turnId, view.blockId);
      }
      return;
    }
    this.scheduleReveal();
  }

  commitBlock(operation) {
    var view = this.blockView(operation);
    if (!view) return;
    view.committed = true;
    view.element.classList.add('stream-block-committed');
  }

  confirmBlock(operation) {
    var view = this.blockView(operation);
    if (!view) return;
    view.block = { ...view.block, ...operation.block };
    view.element.classList.add('stream-block-authoritative');
    if (view.block.toolUseId) view.element.dataset.toolId = view.block.toolUseId;
  }

  patchBlock(operation) {
    var view = this.blockView(operation);
    if (!view) {
      this.createBlock(operation);
      view = this.blockView(operation);
      if (!view) return;
    }
    view.block = { ...operation.block };
    this.ensureBlockKind(view);
    if (view.block.kind === 'tool_use') {
      this.renderTool(view.element, view.block);
    } else {
      view.targetText = view.block.text || '';
      if (view.committed || view.block.displayComplete) {
        view.shown = Array.from(view.targetText).length;
        this.renderText(view);
      } else {
        this.scheduleReveal();
      }
    }
    if (view.block.toolUseId) view.element.dataset.toolId = view.block.toolUseId;
    view.element.classList.add('stream-block-authoritative');
    this.onMutation(view.element);
  }

  discardBlock(operation) {
    var key = blockViewKey(operation.turnId, operation.blockId);
    var view = this.blockViews.get(key);
    if (!view) return;
    var turn = view.element.parentElement;
    view.element.remove();
    this.blockViews.delete(key);
    if (turn && !turn.children.length) {
      turn.remove();
      this.turnElements.delete(operation.turnId);
    }
    if (turn) this.onMutation(turn);
  }

  completeTurn(operation) {
    var turn = this.turnElements.get(operation.turnId);
    if (!turn) return;
    if (!turn.children.length) {
      turn.remove();
      this.turnElements.delete(operation.turnId);
      this.onMutation(turn);
      return;
    }
    turn.classList.remove('stream-preview');
    turn.classList.add('stream-committed');
    this.onMutation(turn);
  }

  ensureBlockKind(view) {
    if (view.element.dataset.kind === view.block.kind) return;
    view.element.dataset.kind = view.block.kind;
    view.element.className = classForBlock(view.block.kind);
    view.element.replaceChildren();
    this.renderBlock(view);
  }

  renderBlock(view) {
    if (view.block.kind === 'tool_use') {
      this.renderTool(view.element, view.block);
      return;
    }
    if (view.block.kind === 'thinking') {
      var label = this.document.createElement('div');
      label.className = 'thinking-toggle';
      label.textContent = 'Thinking';
      var body = this.document.createElement('div');
      body.className = 'thinking-body';
      view.element.append(label, body);
      return;
    }
    this.renderMarkdown(view.element, '');
  }

  scheduleReveal() {
    if (this.frameId != null) return;
    this.frameId = this.scheduleFrame(() => {
      this.frameId = null;
      this.revealFrame();
    });
  }

  revealFrame() {
    var pending = false;
    for (var view of this.blockViews.values()) {
      if (view.block.kind === 'tool_use' || view.revealReported) continue;
      var characters = Array.from(view.targetText);
      if (view.shown < characters.length) {
        view.shown += Math.max(
          this.revealMinimum,
          Math.ceil((characters.length - view.shown) / 4),
        );
        view.shown = Math.min(view.shown, characters.length);
        this.renderText(view, characters);
        this.onMutation(view.element);
      }
      if (view.shown < characters.length) pending = true;
      if (view.inputFinished && view.shown >= characters.length) {
        view.revealReported = true;
        this.onBlockRevealComplete(view.turnId, view.blockId);
      }
    }
    if (pending) this.scheduleReveal();
  }

  renderText(view, characters) {
    var text = (characters || Array.from(view.targetText))
      .slice(0, view.shown)
      .join('');
    if (view.block.kind === 'thinking') {
      var body = view.element.querySelector('.thinking-body');
      if (body) body.textContent = text;
      return;
    }
    this.renderMarkdown(view.element, text);
  }

  blockView(operation) {
    return this.blockViews.get(blockViewKey(operation.turnId, operation.blockId)) || null;
  }

  rebindRenderedHistory() {
    var container = this.getContainer?.();
    if (!container) return;
    for (var [turnId, previousTurn] of this.turnElements) {
      if (previousTurn.isConnected) continue;
      this.insertTurn(container, previousTurn, turnId);
      this.onMutation(previousTurn);
    }
  }

  reset(options = {}) {
    if (this.frameId != null) this.cancelFrame(this.frameId);
    this.frameId = null;
    if (options.remove !== false) {
      for (var turn of this.turnElements.values()) turn.remove();
    }
    this.turnElements.clear();
    this.blockViews.clear();
  }

}
