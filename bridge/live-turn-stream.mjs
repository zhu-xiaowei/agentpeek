export const STREAM_EVENT_ACTIONS = new Set([
  'stream_turn_start',
  'stream_block_start',
  'stream_delta',
  'stream_tool_input',
  'stream_block_stop',
  'stream_end',
]);

export const OPTIONAL_TURN_EVENT_ACTIONS = new Set([
  'messages',
  'permission_request',
  'permission_resolved',
]);

function requiresTurnSequence(event) {
  if (!event?.action) return false;
  return STREAM_EVENT_ACTIONS.has(event.action)
    || (
      OPTIONAL_TURN_EVENT_ACTIONS.has(event.action)
      && Object.prototype.hasOwnProperty.call(event, 'turnId')
    );
}

export function assertTurnEventEnvelope(event) {
  if (!requiresTurnSequence(event)) return event;
  if (!event.sessionId) throw new Error('turn event sessionId is required');
  if (!event.turnId) throw new Error('turn event turnId is required');
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    throw new Error('turn event seq must be a non-negative integer');
  }
  return event;
}

export async function prepareAuthoritativeMessage(raw, options = {}) {
  const message = options.normalized
    ? raw
    : await options.normalize(raw);
  return message?.uuid ? message : null;
}

function createTransientUserMessage(
  turnId,
  text,
  timestamp = new Date().toISOString(),
) {
  const promptUuid = userMessageUuidForTurnId(turnId);
  return {
    uuid: promptUuid || `live_user_${turnId}`,
    nativeId: `live:user:${turnId}`,
    type: 'user',
    content: text,
    timestamp,
  };
}

export function userMessageUuidForTurnId(turnId) {
  const candidate = String(turnId || '').replace(/^sent-/, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(candidate)
    ? candidate
    : '';
}

function createInterruptMessage(
  turnId,
  timestamp = new Date().toISOString(),
) {
  return {
    uuid: `live_interrupt_${turnId}`,
    nativeId: `live:interrupt:${turnId}`,
    type: 'user',
    content: [{
      type: 'text',
      text: '[Request interrupted by user]',
    }],
    timestamp,
  };
}

export function isPromptUserMessage(message) {
  if (message?.type !== 'user') return false;
  if (typeof message.content === 'string') return !!message.content.trim();
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) =>
    block?.type === 'text'
    || block?.type === 'image'
    || block?.type === 'document')
    && !message.content.some((block) => block?.type === 'tool_result');
}

export function shouldCreateFinalInterrupt(runtime, result) {
  return result?.subtype === 'interrupted'
    || result?.status === 'interrupted';
}

export class LiveTurnStream {
  constructor(options) {
    this.sessionId = options.sessionId;
    this.turnId = options.turnId;
    this.replyConnectionId = options.replyConnectionId || '';
    this.send = options.send;
    this.started = false;
    this.ended = false;
    this.nextSeq = 0;
    this.activeSourceBlockId = null;
    this.authoritativeMessages = new Map();
    this.interruptSent = false;
  }

  start() {
    if (this.started || this.ended) return false;
    this.started = true;
    this.emit('stream_turn_start');
    return true;
  }

  sendBlockStart(frame) {
    if (this.ended) return false;
    this.start();
    this.activeSourceBlockId = Number.isInteger(frame?.blockId)
      ? frame.blockId
      : 0;
    this.emit('stream_block_start', {
      kind: frame?.kind || '',
      name: frame?.name || '',
    });
    return true;
  }

  sendDelta(frame) {
    return this.sendCurrentBlockEvent('stream_delta', frame, {
      chunk: frame?.chunk || '',
    });
  }

  sendToolInput(frame) {
    return this.sendCurrentBlockEvent('stream_tool_input', frame, {
      chunk: frame?.chunk || '',
    });
  }

  sendBlockStop(frame) {
    if (!this.sendCurrentBlockEvent('stream_block_stop', frame)) return false;
    this.activeSourceBlockId = null;
    return true;
  }

  sendCurrentBlockEvent(action, frame, payload = {}) {
    if (this.ended) return false;
    this.start();
    if (this.activeSourceBlockId == null) return false;
    if (Number.isInteger(frame?.blockId)
      && frame.blockId !== this.activeSourceBlockId) {
      return false;
    }
    this.emit(action, payload);
    return true;
  }

  createMessagesEvent(messages, options = {}) {
    if (this.ended) return null;
    this.start();
    if (options.includeInEnd !== false) {
      for (const message of messages || []) {
        const key = message?.nativeId
          ? `native:${message.nativeId}`
          : message?.uuid
            ? `uuid:${message.uuid}`
            : JSON.stringify(message);
        this.authoritativeMessages.set(key, structuredClone(message));
      }
    }
    return this.#createEvent('messages', {
      messages,
      ...(options.noCache ? { noCache: true } : {}),
    });
  }

  sendAuthoritative(message, options = {}) {
    const event = this.createMessagesEvent([message], options);
    if (!event) return false;
    this.send(event);
    return event;
  }

  sendTransientUser(text, timestamp) {
    if (typeof text !== 'string' || !text.trim()) return false;
    return this.sendAuthoritative(
      createTransientUserMessage(this.turnId, text, timestamp),
      { noCache: true, includeInEnd: false },
    );
  }

  #sendInterrupt(timestamp) {
    if (this.ended || this.interruptSent) return false;
    this.interruptSent = true;
    return this.sendAuthoritative(
      createInterruptMessage(this.turnId, timestamp),
      { noCache: true },
    );
  }

  sendInterrupt(timestamp) {
    return this.#sendInterrupt(timestamp);
  }

  sendEnd(options = {}) {
    if (this.ended) return false;
    this.start();
    if (this.activeSourceBlockId != null) {
      this.sendBlockStop({ blockId: this.activeSourceBlockId });
    }
    if (options.interrupted) this.#sendInterrupt(options.interruptedAt);
    const messages = Array.from(this.authoritativeMessages.values());
    const event = this.emit('stream_end', {
      ...(options.error ? { error: options.error } : {}),
      ...(messages.length
        ? { messages: structuredClone(messages) }
        : {}),
    });
    this.ended = true;
    return event;
  }

  isEnded() {
    return this.ended;
  }

  envelope() {
    return {
      sessionId: this.sessionId,
      turnId: this.turnId,
      ...(this.replyConnectionId
        ? { replyConnectionId: this.replyConnectionId }
        : {}),
    };
  }

  emit(action, payload = {}) {
    if (action !== 'stream_turn_start') this.start();
    const event = this.#createEvent(action, payload);
    if (!event) return false;
    assertTurnEventEnvelope(event);
    this.send(event);
    return event;
  }

  #createEvent(action, payload = {}) {
    if (this.ended) return null;
    return {
      ...payload,
      action,
      ...this.envelope(),
      seq: this.nextSeq++,
    };
  }

}
