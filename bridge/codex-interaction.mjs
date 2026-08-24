import { execFile } from 'node:child_process';
import { CodexAppServerClient } from './codex-app-server.mjs';
import {
  codexCompletedLiveMessages,
  codexPreviewBlocks,
  isCodexToolItem,
  codexTurnErrorLiveMessage,
  codexTurnLiveKey,
} from './codex-live.mjs';
import {
  codexWriterController,
  isCodexActiveWriterError,
} from './codex-writer.mjs';
import { defineInteractionAdapter } from './interaction-adapter.mjs';
import { registerRuntimeOwnedMessage } from './live-message-registry.mjs';
import { storageSessionId } from './session-identity.mjs';
import { StreamFramer } from './stream-framer.mjs';

function turnStatusError(turn) {
  const status = turn?.status || 'completed';
  return ['failed', 'interrupted'].includes(status) ? status : undefined;
}

function commandApprovalDecisions(params) {
  if (Array.isArray(params.availableDecisions) && params.availableDecisions.length) {
    return params.availableDecisions;
  }

  const decisions = ['accept'];
  if (params.networkApprovalContext) {
    decisions.push('acceptForSession');
    const amendment = (params.proposedNetworkPolicyAmendments || [])
      .find((candidate) => candidate?.action === 'allow');
    if (amendment) {
      decisions.push({
        applyNetworkPolicyAmendment: {
          network_policy_amendment: amendment,
        },
      });
    }
  } else if (!params.additionalPermissions
    && Array.isArray(params.proposedExecpolicyAmendment)
    && params.proposedExecpolicyAmendment.length) {
    decisions.push({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: params.proposedExecpolicyAmendment,
      },
    });
  }
  decisions.push('cancel');
  return decisions;
}

function approvalDecisionKey(decision) {
  try {
    return JSON.stringify(decision, (_key, value) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
        )
        : value
    ));
  } catch {
    return '';
  }
}

function normalizeApprovalDecision(pending, decision) {
  const legacy = decision === 'allow'
    ? 'accept'
    : (decision === 'deny' ? 'decline' : decision);
  const allowed = pending.approvalDecisions || [];
  const key = approvalDecisionKey(legacy);
  if (key && allowed.some((candidate) => approvalDecisionKey(candidate) === key)) {
    return legacy;
  }
  if (allowed.includes('cancel')) return 'cancel';
  if (allowed.includes('decline')) return 'decline';
  return 'cancel';
}

function cloneJson(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function runLocalCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

function encodeCommandPayload(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCommandPayload(value, command) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
  } catch {
    throw new Error(`Usage: /${command}`);
  }
}

function grantedPermissions(permissions) {
  const granted = {};
  if (permissions?.network != null) {
    granted.network = cloneJson(permissions.network, {});
  }
  if (permissions?.fileSystem != null) {
    granted.fileSystem = cloneJson(permissions.fileSystem, {});
  }
  return granted;
}

function permissionApprovalResponse(pending, response) {
  const action = response?.action;
  const grants = [
    'grantForTurn',
    'grantForTurnWithStrictAutoReview',
    'grantForSession',
  ];
  if (!grants.includes(action)) return { permissions: {}, scope: 'turn' };
  return {
    permissions: grantedPermissions(pending.params.permissions),
    scope: action === 'grantForSession' ? 'session' : 'turn',
    ...(action === 'grantForTurnWithStrictAutoReview'
      ? { strictAutoReview: true }
      : {}),
  };
}

function mcpMeta(params) {
  return params?._meta ?? params?.meta ?? null;
}

function mcpPersistModes(meta) {
  const value = meta && typeof meta === 'object' ? meta.persist : null;
  const values = Array.isArray(value) ? value : [value];
  return values.filter((mode) => mode === 'session' || mode === 'always');
}

function isMcpToolApproval(meta) {
  return meta?.codex_approval_kind === 'mcp_tool_call';
}

function mcpApprovalDisplayParams(meta) {
  if (!meta || typeof meta !== 'object') return [];
  if (Array.isArray(meta.tool_params_display)) {
    const display = meta.tool_params_display
      .filter((entry) => (
        entry && typeof entry === 'object' && typeof entry.name === 'string'
      ))
      .slice(0, 3)
      .map((entry) => ({
        name: entry.name,
        displayName: typeof entry.display_name === 'string'
          ? entry.display_name
          : entry.name,
        value: cloneJson(entry.value),
      }));
    if (display.length) return display;
  }
  if (meta.tool_params && typeof meta.tool_params === 'object'
    && !Array.isArray(meta.tool_params)) {
    return Object.entries(meta.tool_params)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 3)
      .map(([name, value]) => ({
        name,
        displayName: name,
        value: cloneJson(value),
      }));
  }
  return [];
}

function mcpFormFields(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
    || schema.type !== 'object' || !schema.properties
    || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    return null;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = [];
  for (const [id, property] of Object.entries(schema.properties)) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) return null;
    const label = property.title || id;
    const prompt = property.description || label;
    if (property.type === 'boolean') {
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: [
            { label: 'True', value: true },
            { label: 'False', value: false },
          ],
          defaultIndex: typeof property.default === 'boolean'
            ? (property.default ? 0 : 1)
            : null,
        },
      });
      continue;
    }

    const legacyEnum = property.type === 'string' && Array.isArray(property.enum)
      ? property.enum
      : null;
    const oneOf = property.type === 'string' && Array.isArray(property.oneOf)
      ? property.oneOf
      : null;
    if (legacyEnum && legacyEnum.every((value) => typeof value === 'string')) {
      const names = Array.isArray(property.enumNames) ? property.enumNames : [];
      const defaultIndex = legacyEnum.indexOf(property.default);
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: legacyEnum.map((value, index) => ({
            label: typeof names[index] === 'string' ? names[index] : value,
            value,
          })),
          defaultIndex: defaultIndex >= 0 ? defaultIndex : null,
        },
      });
      continue;
    }
    if (oneOf && oneOf.length && oneOf.every((entry) => (
      entry && typeof entry.const === 'string' && typeof entry.title === 'string'
    ))) {
      const defaultIndex = oneOf.findIndex((entry) => entry.const === property.default);
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: {
          type: 'select',
          options: oneOf.map((entry) => ({
            label: entry.title,
            value: entry.const,
          })),
          defaultIndex: defaultIndex >= 0 ? defaultIndex : null,
        },
      });
      continue;
    }
    if (property.type === 'string') {
      fields.push({
        id,
        label,
        prompt,
        required: required.has(id),
        input: { type: 'text' },
      });
      continue;
    }
    return null;
  }
  return fields;
}

function mcpElicitationDetails(params) {
  const meta = mcpMeta(params);
  const schema = params.requestedSchema ?? null;
  const fields = mcpFormFields(schema);
  const emptySchema = schema == null
    || (fields && fields.length === 0);
  let responseMode = 'fallback';
  if (params.mode === 'form' && emptySchema) responseMode = 'approval';
  else if (params.mode === 'form' && fields?.length) responseMode = 'form';
  return {
    serverName: params.serverName || 'MCP server',
    mode: params.mode || 'form',
    message: params.message || '',
    responseMode,
    isToolApproval: isMcpToolApproval(meta),
    persistModes: mcpPersistModes(meta),
    displayParams: mcpApprovalDisplayParams(meta),
    fields: responseMode === 'form' ? fields : [],
  };
}

function validMcpFormContent(schema, value) {
  const fields = mcpFormFields(schema);
  if (!fields?.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const allowed = new Map(fields.map((field) => [field.id, field]));
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const content = [];
  for (const field of fields) {
    if (!Object.hasOwn(value, field.id)) {
      if (field.required) return null;
      continue;
    }
    const answer = value[field.id];
    if (field.input.type === 'text') {
      if (typeof answer !== 'string' || (field.required && !answer)) return null;
    } else if (!field.input.options.some((option) => (
      approvalDecisionKey(option.value) === approvalDecisionKey(answer)
    ))) {
      return null;
    }
    content.push([field.id, answer]);
  }
  return Object.fromEntries(content);
}

function mcpElicitationResponse(pending, response) {
  const params = pending.params || {};
  const details = mcpElicitationDetails(params);
  const action = response?.action;
  if (details.responseMode === 'form' && action === 'acceptForm') {
    const content = validMcpFormContent(
      params.requestedSchema,
      response.content,
    );
    if (content) return { action: 'accept', content, _meta: null };
  }
  if (details.responseMode === 'approval') {
    if (action === 'accept') return { action: 'accept', content: null, _meta: null };
    if (action === 'acceptForSession' && details.persistModes.includes('session')) {
      return {
        action: 'accept',
        content: null,
        _meta: { persist: 'session' },
      };
    }
    if (action === 'acceptAlways' && details.persistModes.includes('always')) {
      return {
        action: 'accept',
        content: null,
        _meta: { persist: 'always' },
      };
    }
    if (action === 'decline' && !details.isToolApproval) {
      return { action: 'decline', content: null, _meta: null };
    }
  }
  if (details.responseMode === 'fallback') {
    if (action === 'accept') return { action: 'accept', content: null, _meta: null };
    if (action === 'decline') return { action: 'decline', content: null, _meta: null };
  }
  return { action: 'cancel', content: null, _meta: null };
}

export class CodexInteraction {
  constructor(options = {}) {
    this.runtime = 'codex';
    this.clientFactory = options.clientFactory
      || (options.client
        ? () => options.client
        : (context = {}) => new CodexAppServerClient({
          ...options.clientOptions,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          ...(context.managedOnly ? { managedOnly: true } : {}),
        }));
    this.writerController = options.writerController || codexWriterController;
    this.sessions = new Map();
    this.turns = new Map();
    this.pendingRequests = new Map();
    this.boundClients = new WeakSet();
  }

  #session(nativeSessionId, storageSessionId = '') {
    let session = this.sessions.get(nativeSessionId);
    if (!session) {
      session = {
        nativeSessionId,
        storageSessionId,
        cwd: '',
        skills: null,
        tokenUsage: null,
        model: '',
        effort: null,
        client: null,
        releasePromise: null,
        releasingClient: null,
        subscribedGeneration: 0,
        active: null,
        queue: [],
        sendLock: Promise.resolve(),
      };
      this.sessions.set(nativeSessionId, session);
    } else if (storageSessionId) {
      session.storageSessionId = storageSessionId;
    }
    return session;
  }

  #client(session, options = {}) {
    if (session.client) return session.client;
    const client = this.clientFactory({
      nativeSessionId: session.nativeSessionId,
      storageSessionId: session.storageSessionId,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(options.managedOnly ? { managedOnly: true } : {}),
    });
    if (!client) throw new Error('Codex interaction client factory returned no client');
    session.client = client;
    this.#bindClient(session, client);
    return client;
  }

  #bindClient(session, client) {
    if (!this.boundClients.has(client)) {
      this.boundClients.add(client);
      client.on('notification', (notification) => {
        this.#onNotification(session, client, notification);
      });
      client.on('serverRequest', (request) => {
        this.#onServerRequest(session, client, request);
      });
      client.on('ready', ({ generation }) => {
        if (session.client === client) session.subscribedGeneration = generation - 1;
      });
      client.on('exit', (error) => this.#onExit(session, client, error));
    }
  }

  #activeWriterError(session, error) {
    if (!isCodexActiveWriterError(error)) return error;
    const writer = this.writerController.describe(session.nativeSessionId);
    error.code = 'CODEX_ACTIVE_WRITER';
    error.writer = writer;
    return error;
  }

  async #resume(session, options = {}) {
    if (session.releasePromise) await session.releasePromise;
    const client = this.#client(session);
    await client.start();
    if (session.subscribedGeneration === client.generation) return;
    const pendingTurn = options.pendingTurn || null;
    let adopted = pendingTurn
      ? this.#prepareTurn(session, {
        streamId: pendingTurn.streamId
          || `codex-resumed-${session.nativeSessionId}-${client.generation}`,
        text: '',
        callbacks: pendingTurn.callbacks,
        external: true,
      })
      : null;
    if (adopted) {
      session.active = adopted;
      if (pendingTurn) session.queue.push(pendingTurn);
    }
    const clearAdoption = () => {
      if (!adopted) return;
      const current = adopted;
      adopted = null;
      if (pendingTurn) {
        const queuedIndex = session.queue.indexOf(pendingTurn);
        if (queuedIndex !== -1) session.queue.splice(queuedIndex, 1);
      }
      if (session.active === current) session.active = null;
      current.framer.cancel();
    };
    const resumeThread = () => client.request('thread/resume', {
      threadId: session.nativeSessionId,
      excludeTurns: true,
    });
    let result;
    try {
      result = await resumeThread();
    } catch (cause) {
      clearAdoption();
      const error = this.#activeWriterError(session, cause);
      if (error.code !== 'CODEX_ACTIVE_WRITER') throw error;
      const writer = error.writer || {};
      const automaticTakeover = !options.takeover
        && writer.canTerminate
        && writer.pid
        && writer.status === 'completed';
      if (!options.takeover && !automaticTakeover) throw error;
      await this.writerController.terminate(
        session.nativeSessionId,
        automaticTakeover ? writer.pid : Number(options.expectedWriterPid),
        automaticTakeover ? { requireIdle: true } : {},
      );
      const deadline = Date.now() + 3000;
      while (true) {
        try {
          result = await resumeThread();
          break;
        } catch (retryCause) {
          if (!isCodexActiveWriterError(retryCause) || Date.now() >= deadline) {
            throw this.#activeWriterError(session, retryCause);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    if (result?.thread?.id !== session.nativeSessionId) {
      clearAdoption();
      throw new Error('Codex resumed an unexpected thread');
    }
    session.model = result.model || session.model;
    session.effort = result.reasoningEffort ?? session.effort;
    session.subscribedGeneration = client.generation;
    if (!adopted) return { active: false };
    if (session.active !== adopted) {
      return { active: true };
    }
    if (result?.thread?.status?.type === 'active') {
      return { active: true };
    }
    clearAdoption();
    return { active: false };
  }

  async #release(session) {
    if (session.active || session.queue.length) return;
    if (session.releasePromise) return session.releasePromise;
    const client = session.client;
    if (!client) return;

    session.subscribedGeneration = 0;
    session.releasingClient = client;
    const release = Promise.resolve(client.stop())
      .catch(() => {})
      .finally(() => {
        if (session.client === client) session.client = null;
        if (session.releasingClient === client) session.releasingClient = null;
        if (session.releasePromise === release) session.releasePromise = null;
      });
    session.releasePromise = release;
    return release;
  }

  async sendExisting(options) {
    const session = this.#session(options.nativeSessionId, options.sessionId);
    if (options.cwd) session.cwd = options.cwd;
    const turn = {
      streamId: options.streamId,
      text: options.text,
      callbacks: options.callbacks || {},
    };
    const operation = session.sendLock.then(async () => {
      try {
        const resumed = await this.#resume(session, {
          ...options,
          pendingTurn: turn,
        });
        if (resumed?.active) return { queued: true };
      } catch (error) {
        await this.#release(session);
        throw error;
      }
      if (session.active) {
        session.queue.push(turn);
        return { queued: true };
      }
      await this.#startTurn(session, turn);
      return { queued: false };
    });
    session.sendLock = operation.catch(() => {});
    return operation;
  }

  async observePermissions(options) {
    const session = this.#session(options.nativeSessionId, options.sessionId);
    const operation = session.sendLock.then(async () => {
      if (session.active) return { active: true, loaded: true };
      let observed = null;
      const clearObservation = () => {
        if (!observed) return;
        if (observed.turnId) {
          this.turns.delete(this.#turnKey(session.nativeSessionId, observed.turnId));
        }
        for (const [requestId, pending] of this.pendingRequests) {
          if (pending.turn === observed) this.pendingRequests.delete(requestId);
        }
        if (session.active === observed) session.active = null;
        observed.framer.cancel();
        observed = null;
      };
      try {
        if (session.releasePromise) await session.releasePromise;
        const client = this.#client(session, { managedOnly: true });
        await client.start();
        const loaded = await client.request('thread/loaded/list');
        if (!(loaded?.data || []).includes(session.nativeSessionId)) {
          await this.#release(session);
          return { active: false, loaded: false };
        }
        observed = this.#prepareTurn(session, {
          streamId: `codex-permission-${session.nativeSessionId}-${client.generation}`,
          text: '',
          callbacks: options.callbacks || {},
          external: true,
          observerOnly: true,
        });
        session.active = observed;
        let result;
        try {
          result = await client.request('thread/resume', {
            threadId: session.nativeSessionId,
            excludeTurns: true,
          });
        } catch (cause) {
          clearObservation();
          throw this.#activeWriterError(session, cause);
        }
        if (result?.thread?.id !== session.nativeSessionId) {
          clearObservation();
          throw new Error('Codex resumed an unexpected thread');
        }
        session.model = result.model || session.model;
        session.effort = result.reasoningEffort ?? session.effort;
        session.subscribedGeneration = client.generation;
        if (result?.thread?.status?.type === 'active') {
          return { active: true, loaded: true };
        }
        clearObservation();
        await this.#release(session);
        return { active: false, loaded: true };
      } catch (error) {
        clearObservation();
        await this.#release(session);
        return { active: false, loaded: false, error };
      }
    });
    session.sendLock = operation.catch(() => {});
    return operation;
  }

  async create(options) {
    const client = this.clientFactory({ cwd: options.cwd });
    if (!client) throw new Error('Codex interaction client factory returned no client');
    let session = null;
    try {
      await client.start();
      const result = await client.request('thread/start', { cwd: options.cwd });
      const nativeSessionId = result?.thread?.id;
      if (!nativeSessionId) throw new Error('Codex did not return a thread id');

      const sessionId = storageSessionId('codex', nativeSessionId);
      session = this.#session(nativeSessionId, sessionId);
      session.cwd = options.cwd || '';
      session.model = result.model || '';
      session.effort = result.reasoningEffort ?? null;
      if (session.client && session.client !== client) {
        throw new Error('Codex created a thread already owned by another client');
      }
      session.client = client;
      session.subscribedGeneration = client.generation;
      this.#bindClient(session, client);

      const callbacks = await options.onCreated?.({
        nativeSessionId,
        sessionId,
      }) || options.callbacks || {};
      await this.#startTurn(session, {
        streamId: options.streamId,
        text: options.text,
        callbacks,
      });
      return { nativeSessionId, sessionId };
    } catch (error) {
      if (!session || session.client !== client) {
        await Promise.resolve(client.stop()).catch(() => {});
      } else if (!session.active) {
        await this.#release(session);
      }
      throw error;
    }
  }

  async #startTurn(session, turn) {
    session.active = turn;
    this.#prepareTurn(session, turn);

    try {
      const input = await this.#turnInput(session, turn.text);
      const result = await session.client.request('turn/start', {
        threadId: session.nativeSessionId,
        clientUserMessageId: turn.streamId,
        input,
      });
      this.#bindTurnId(turn, result?.turn?.id);
      this.#acceptTurn(turn);
    } catch (error) {
      session.active = null;
      turn.framer.cancel();
      this.#failTurn(turn, error);
      this.#drainOrRelease(session);
      throw error;
    }
  }

  async #turnInput(session, text) {
    const input = [{ type: 'text', text }];
    const mentioned = new Set();
    const pattern = /(^|\s)\$([A-Za-z0-9_.:-]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) mentioned.add(match[2]);
    if (!mentioned.size) return input;
    const skills = await this.#loadSkills(session, true);
    for (const skill of skills) {
      if (!skill.enabled || !mentioned.has(skill.name)) continue;
      input.push({
        type: 'skill',
        name: skill.name,
        path: skill.path,
      });
    }
    return input;
  }

  async #loadSkills(session, forceReload = false) {
    if (session.skills && !forceReload) return session.skills;
    const cwd = session.cwd || process.cwd();
    const response = await this.#client(session).request('skills/list', {
      cwds: [cwd],
      forceReload,
    });
    const entry = (response?.data || []).find((candidate) => candidate.cwd === cwd)
      || response?.data?.[0];
    session.skills = (entry?.skills || []).map((skill) => ({
      name: skill.name,
      description: skill.description || skill.shortDescription || '',
      path: skill.path,
      scope: skill.scope,
      enabled: skill.enabled !== false,
    }));
    return session.skills;
  }

  async listSkills(options = {}) {
    const context = await this.listCommandContext(options);
    return context.skills;
  }

  async listCommandContext(options = {}) {
    const client = this.clientFactory({ cwd: options.cwd || process.cwd() });
    if (!client) throw new Error('Codex interaction client factory returned no client');
    try {
      await client.start();
      const cwd = options.cwd || process.cwd();
      const [
        skillsResponse,
        modelsResponse,
        featuresResponse,
        descendantsResponse,
        hooksResponse,
      ] = await Promise.all([
        client.request('skills/list', {
          cwds: [cwd],
          forceReload: options.forceReload !== false,
        }),
        client.request('model/list', {
          includeHidden: false,
          limit: 100,
        }),
        client.request('experimentalFeature/list', options.nativeSessionId
          ? { threadId: options.nativeSessionId }
          : {}).catch(() => client.request('experimentalFeature/list', {})
          .catch(() => ({ data: [] }))),
        options.nativeSessionId
          ? client.request('thread/list', {
            ancestorThreadId: options.nativeSessionId,
            limit: 100,
          }).catch(() => ({ data: [] }))
          : Promise.resolve({ data: [] }),
        client.request('hooks/list', {
          cwds: [cwd],
        }).catch(() => ({ data: [] })),
      ]);
      const entry = skillsResponse?.data?.[0];
      const skills = (entry?.skills || [])
        .filter((skill) => skill.enabled !== false)
        .map((skill) => ({
          name: skill.name,
          description: skill.description || skill.shortDescription || '',
          scope: skill.scope,
          enabled: true,
        }));
      const modelOptions = [];
      for (const model of modelsResponse?.data || []) {
        if (model.hidden) continue;
        const efforts = model.supportedReasoningEfforts?.length
          ? model.supportedReasoningEfforts
          : [{
            reasoningEffort: model.defaultReasoningEffort,
            description: '',
          }];
        for (const effort of efforts) {
          modelOptions.push({
            name: `${model.model}:${effort.reasoningEffort}`,
            label: `${model.displayName} · ${effort.reasoningEffort}`,
            description: effort.description || model.description || '',
            value: `${model.model} ${effort.reasoningEffort}`,
          });
        }
      }
      const experimentalOptions = (featuresResponse?.data || [])
        .filter((feature) => feature.displayName && feature.description)
        .map((feature) => ({
          name: feature.name,
          label: `${feature.displayName} · ${feature.enabled ? 'On' : 'Off'}`,
          description: feature.description,
          value: `${feature.name}=${feature.enabled ? 'off' : 'on'}`,
        }));
      const agentOptions = options.nativeSessionId
        ? [{
          name: options.nativeSessionId,
          label: 'Main thread',
          description: 'Return to the primary thread.',
          value: options.nativeSessionId,
        }]
        : [];
      for (const thread of descendantsResponse?.data || []) {
        const status = typeof thread.status === 'string'
          ? thread.status
          : (thread.status?.type || '');
        agentOptions.push({
          name: thread.id,
          label: thread.agentNickname || thread.agentRole || thread.name
            || thread.preview || thread.id.slice(0, 8),
          description: [
            thread.agentRole,
            status,
          ].filter(Boolean).join(' · '),
          value: thread.id,
        });
      }
      const hooksEntry = (hooksResponse?.data || [])
        .find((candidate) => candidate.cwd === cwd)
        || hooksResponse?.data?.[0];
      const hookOptions = (hooksEntry?.hooks || []).map((hook) => {
        const trustStatus = String(hook.trustStatus || '').toLowerCase();
        const needsTrust = trustStatus === 'untrusted' || trustStatus === 'modified';
        const action = needsTrust ? 'trust' : (hook.enabled ? 'disable' : 'enable');
        return {
          name: hook.key,
          label: `${hook.eventName} · ${needsTrust ? 'Trust' : (hook.enabled ? 'On' : 'Off')}`,
          description: [
            hook.command || hook.handlerType,
            hook.source,
            hook.isManaged ? 'managed' : '',
          ].filter(Boolean).join(' · '),
          value: encodeCommandPayload({
            action,
            key: hook.key,
            currentHash: hook.currentHash,
          }),
          ...(needsTrust
            ? { confirm: `Trust the ${hook.eventName} hook from ${hook.sourcePath}?` }
            : {}),
          ...(hook.isManaged ? { disabled: true } : {}),
        };
      });
      return {
        skills,
        commandOptions: {
          model: modelOptions,
          experimental: experimentalOptions,
          hooks: hookOptions,
          agent: agentOptions,
          subagents: agentOptions,
        },
      };
    } finally {
      await Promise.resolve(client.stop()).catch(() => {});
    }
  }

  async runCommand(options) {
    const session = this.#session(options.nativeSessionId, options.sessionId);
    if (options.cwd) session.cwd = options.cwd;
    const operation = session.sendLock.then(async () => {
      await this.#resume(session, options);
      const name = options.name;
      const args = String(options.args || '').trim();
      if (name === 'review' || name === 'compact' || (name === 'plan' && args)) {
        if (name === 'compact' && args) throw new Error('Usage: /compact');
        if (session.active) {
          throw new Error(`/${name} is disabled while a task is in progress.`);
        }
        const turn = {
          streamId: options.streamId,
          text: name === 'plan' ? args : `/${name}${args ? ` ${args}` : ''}`,
          callbacks: options.callbacks || {},
          command: name,
        };
        try {
          if (name === 'review') {
            session.active = turn;
            this.#prepareTurn(session, turn);
            const target = args
              ? { type: 'custom', instructions: args }
              : { type: 'uncommittedChanges' };
            const response = await session.client.request('review/start', {
              threadId: session.nativeSessionId,
              target,
              delivery: 'inline',
            });
            this.#bindTurnId(turn, response?.turn?.id);
          } else if (name === 'compact') {
            session.active = turn;
            this.#prepareTurn(session, turn);
            await session.client.request('thread/compact/start', {
              threadId: session.nativeSessionId,
            });
          } else {
            await this.#setPlanMode(session);
            await this.#startTurn(session, turn);
          }
          return { streaming: true };
        } catch (error) {
          session.active = null;
          turn.framer?.cancel();
          this.#drainOrRelease(session);
          throw error;
        }
      }

      try {
        switch (name) {
          case 'model':
            return { output: await this.#setModel(session, args) };
          case 'permissions':
            return { output: await this.#setPermissions(session, args) };
          case 'experimental':
            return { output: await this.#setExperimental(session, args) };
          case 'memories':
            return { output: await this.#setMemories(session, args) };
          case 'skills': {
            if (args) throw new Error('Usage: /skills');
            const skills = await this.#loadSkills(session, true);
            return { output: this.#skillsOutput(skills) };
          }
          case 'import':
            return { output: await this.#importExternalConfig(session, args) };
          case 'hooks':
            if (args) return { output: await this.#updateHook(session, args) };
            return { output: await this.#hooksOutput(session) };
          case 'rename':
            if (!args) throw new Error('Usage: /rename <name>');
            await session.client.request('thread/name/set', {
              threadId: session.nativeSessionId,
              name: args,
            });
            return { output: `Renamed thread to **${args}**.` };
          case 'archive':
            if (args) throw new Error('Usage: /archive');
            await session.client.request('thread/archive', {
              threadId: session.nativeSessionId,
            });
            return {
              output: 'Session archived.',
              action: { type: 'leave-session' },
            };
          case 'delete':
            if (args) throw new Error('Usage: /delete');
            await session.client.request('thread/delete', {
              threadId: session.nativeSessionId,
            });
            return {
              output: 'Session deleted.',
              action: { type: 'leave-session' },
            };
          case 'fork':
            return await this.#forkThread(session, args);
          case 'app':
            if (args) throw new Error('Usage: /app');
            await this.#openDesktopThread(session);
            return { output: 'Opened this session in the Codex Desktop app.' };
          case 'plan':
            if (args) throw new Error('Usage: /plan [prompt]');
            await this.#setPlanMode(session);
            return { output: 'Switched to Plan mode.' };
          case 'goal':
            return { output: await this.#goalOutput(session, args) };
          case 'agent':
          case 'subagents':
            if (!args) throw new Error(`Usage: /${name} <thread-id>`);
            return {
              output: `Switched to agent thread \`${args}\`.`,
              action: {
                type: 'open-session',
                sessionId: storageSessionId('codex', args),
                preview: 'Agent thread',
              },
            };
          case 'diff':
            if (args) throw new Error('Usage: /diff');
            return { output: await this.#diffOutput(session) };
          case 'status':
            if (args) throw new Error('Usage: /status');
            return { output: await this.#statusOutput(session) };
          case 'usage':
            return { output: await this.#usageOutput(session, args) };
          case 'mcp':
            if (args && args !== 'verbose') throw new Error('Usage: /mcp [verbose]');
            return { output: await this.#mcpOutput(session, args === 'verbose') };
          case 'logout':
            if (args) throw new Error('Usage: /logout');
            await session.client.request('account/logout');
            return { output: 'Logged out of Codex.' };
          case 'feedback':
            return { output: await this.#sendFeedback(session, args) };
          case 'ps':
            if (args) throw new Error('Usage: /ps');
            return { output: await this.#backgroundTerminalsOutput(session) };
          case 'stop':
            if (args) throw new Error('Usage: /stop');
            await session.client.request('thread/backgroundTerminals/clean', {
              threadId: session.nativeSessionId,
            });
            return { output: 'Stopped all background terminals.' };
          case 'personality':
            return { output: await this.#setPersonality(session, args) };
          default:
            throw new Error(`Unsupported Codex command: /${name}`);
        }
      } finally {
        await this.#release(session);
      }
    });
    session.sendLock = operation.catch(() => {});
    return operation;
  }

  async #setModel(session, args) {
    const [model, effort, extra] = args.split(/\s+/);
    if (!model || !effort || extra) throw new Error('Usage: /model <model> <effort>');
    await session.client.request('thread/settings/update', {
      threadId: session.nativeSessionId,
      model,
      effort,
    });
    session.model = model;
    session.effort = effort;
    return `Using **${model}** with **${effort}** reasoning.`;
  }

  async #setPermissions(session, args) {
    const presets = {
      ask: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
      'auto-review': {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      },
      'full-access': {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    };
    const preset = presets[args];
    if (!preset) throw new Error('Usage: /permissions <ask|auto-review|full-access>');
    await session.client.request('thread/settings/update', {
      threadId: session.nativeSessionId,
      ...preset,
    });
    return `Permissions changed to **${args}**.`;
  }

  async #setExperimental(session, args) {
    const match = /^([A-Za-z0-9_-]+)=(on|off)$/.exec(args);
    if (!match) throw new Error('Usage: /experimental <feature>=<on|off>');
    await session.client.request('experimentalFeature/enablement/set', {
      enablement: {
        [match[1]]: match[2] === 'on',
      },
    });
    return `Experimental feature **${match[1]}** is now **${match[2]}**.`;
  }

  async #setMemories(session, args) {
    if (!['enabled', 'disabled', 'reset'].includes(args)) {
      throw new Error('Usage: /memories <enabled|disabled|reset>');
    }
    if (args === 'reset') {
      await session.client.request('memory/reset');
      return 'Codex memories were reset.';
    }
    await session.client.request('thread/memoryMode/set', {
      threadId: session.nativeSessionId,
      mode: args,
    });
    return `Memories are **${args}** for this thread.`;
  }

  async #hooksOutput(session) {
    const response = await session.client.request('hooks/list', {
      cwds: [session.cwd || process.cwd()],
    });
    const entry = response?.data?.[0];
    const hooks = entry?.hooks || [];
    if (!hooks.length) return 'No lifecycle hooks are configured.';
    return [
      '**Lifecycle hooks**',
      ...hooks.map((hook) => (
        `- **${hook.eventName}** · ${hook.handlerType} · ${hook.enabled ? 'enabled' : 'disabled'}`
        + ` · ${hook.source}`
      )),
    ].join('\n');
  }

  async #updateHook(session, args) {
    const payload = decodeCommandPayload(args, 'hooks');
    if (!payload?.key || !['enable', 'disable', 'trust'].includes(payload.action)) {
      throw new Error('Usage: /hooks');
    }
    const value = payload.action === 'trust'
      ? {
        [payload.key]: {
          trusted_hash: payload.currentHash,
        },
      }
      : {
        [payload.key]: {
          enabled: payload.action === 'enable',
        },
      };
    await session.client.request('config/batchWrite', {
      edits: [{
        keyPath: 'hooks.state',
        value,
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    });
    if (payload.action === 'trust') return `Trusted hook \`${payload.key}\`.`;
    return `${payload.action === 'enable' ? 'Enabled' : 'Disabled'} hook \`${payload.key}\`.`;
  }

  async #importExternalConfig(session, args) {
    if (!['claude-code', 'cursor'].includes(args)) {
      throw new Error('Usage: /import <claude-code|cursor>');
    }
    const detected = await session.client.request('externalAgentConfig/detect', {
      includeHome: true,
      cwds: [session.cwd || process.cwd()],
      migrationSource: args,
    });
    const items = detected?.items || [];
    if (!items.length) return `No compatible ${args} setup was found to import.`;
    await session.client.request('externalAgentConfig/import', {
      migrationItems: items,
      migrationSource: args,
      providerId: args,
      source: 'baton',
    });
    return `Import started for **${items.length}** ${args} item${items.length === 1 ? '' : 's'}.`;
  }

  async #openDesktopThread(session) {
    const url = `codex://threads/${session.nativeSessionId}`;
    if (process.platform === 'darwin') {
      await runLocalCommand('open', [url]);
      return;
    }
    if (process.platform === 'win32') {
      await runLocalCommand('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Start-Process '${url}'`,
      ]);
      return;
    }
    throw new Error('/app is only available when the Bridge runs on macOS or Windows.');
  }

  async #forkThread(session, args) {
    const response = await session.client.request('thread/fork', {
      threadId: session.nativeSessionId,
      excludeTurns: true,
    });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error('Codex did not return a forked thread id.');
    if (args) {
      await session.client.request('thread/name/set', {
        threadId,
        name: args,
      });
    }
    return {
      output: args ? `Forked thread as **${args}**.` : 'Forked the current thread.',
      action: {
        type: 'open-session',
        sessionId: storageSessionId('codex', threadId),
        preview: args || 'Forked session',
      },
    };
  }

  async #setPlanMode(session) {
    const model = session.model;
    if (!model) throw new Error('Codex did not report the current model.');
    await session.client.request('thread/settings/update', {
      threadId: session.nativeSessionId,
      collaborationMode: {
        mode: 'plan',
        settings: {
          model,
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    });
  }

  async #goalOutput(session, args) {
    const lower = args.toLowerCase();
    if (!args) {
      const response = await session.client.request('thread/goal/get', {
        threadId: session.nativeSessionId,
      });
      const goal = response?.goal;
      if (!goal) return 'No goal is set for this thread.';
      return [
        '**Thread goal**',
        `- Objective: ${goal.objective || '(none)'}`,
        `- Status: ${goal.status || 'active'}`,
        ...(Number.isFinite(goal.tokenBudget)
          ? [`- Token budget: ${goal.tokenBudget}`]
          : []),
      ].join('\n');
    }
    if (lower === 'clear') {
      await session.client.request('thread/goal/clear', {
        threadId: session.nativeSessionId,
      });
      return 'Thread goal cleared.';
    }
    if (lower === 'pause' || lower === 'resume') {
      const status = lower === 'pause' ? 'paused' : 'active';
      await session.client.request('thread/goal/set', {
        threadId: session.nativeSessionId,
        status,
      });
      return `Thread goal is now **${status}**.`;
    }
    await session.client.request('thread/goal/set', {
      threadId: session.nativeSessionId,
      objective: args,
      status: 'active',
    });
    return `Thread goal set to: ${args}`;
  }

  async #diffOutput(session) {
    const cwd = session.cwd || process.cwd();
    const [diff, untracked] = await Promise.all([
      session.client.request('command/exec', {
        command: ['git', 'diff', '--no-ext-diff', '--no-color'],
        cwd,
        timeoutMs: 15000,
        outputBytesCap: 512000,
      }),
      session.client.request('command/exec', {
        command: ['git', 'ls-files', '--others', '--exclude-standard'],
        cwd,
        timeoutMs: 15000,
        outputBytesCap: 128000,
      }),
    ]);
    if (diff.exitCode !== 0) {
      return diff.stderr?.trim() || '`/diff` — not inside a git repository.';
    }
    const parts = [];
    if (diff.stdout?.trim()) parts.push(`\`\`\`diff\n${diff.stdout.trim()}\n\`\`\``);
    if (untracked.stdout?.trim()) {
      parts.push([
        '**Untracked files**',
        ...untracked.stdout.trim().split(/\r?\n/).map((file) => `- \`${file}\``),
      ].join('\n'));
    }
    return parts.join('\n\n') || 'Working tree has no changes.';
  }

  async #statusOutput(session) {
    const response = await session.client.request('thread/read', {
      threadId: session.nativeSessionId,
      includeTurns: false,
    });
    const thread = response?.thread || {};
    const status = typeof thread.status === 'string'
      ? thread.status
      : (thread.status?.type || 'unknown');
    const lines = [
      '**Codex status**',
      `- Thread: \`${thread.id || session.nativeSessionId}\``,
      `- Working directory: \`${thread.cwd || session.cwd || 'unknown'}\``,
      `- Status: ${status}`,
    ];
    if (thread.name) lines.splice(2, 0, `- Name: ${thread.name}`);
    if (thread.modelProvider) lines.push(`- Model provider: ${thread.modelProvider}`);
    const usage = session.tokenUsage;
    if (Number.isFinite(usage?.total?.totalTokens)) {
      const context = usage.modelContextWindow;
      const suffix = Number.isFinite(context) && context > 0
        ? ` / ${context} (${Math.round((usage.total.totalTokens / context) * 100)}%)`
        : '';
      lines.push(`- Context tokens: ${usage.total.totalTokens}${suffix}`);
    }
    return lines.join('\n');
  }

  async #mcpOutput(session, verbose) {
    const servers = [];
    let cursor = null;
    do {
      const response = await session.client.request('mcpServerStatus/list', {
        threadId: session.nativeSessionId,
        detail: verbose ? 'full' : 'toolsAndAuthOnly',
        cursor,
        limit: 100,
      });
      servers.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
    } while (cursor);
    if (!servers.length) return 'No MCP servers are configured.';
    const lines = ['**MCP servers**'];
    for (const server of servers) {
      const tools = Object.keys(server.tools || {});
      const summary = `${tools.length} tool${tools.length === 1 ? '' : 's'}, auth: ${server.authStatus}`;
      lines.push(`- **${server.name}**: ${summary}`);
      if (verbose && tools.length) {
        lines.push(`  ${tools.map((tool) => `\`${tool}\``).join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  async #usageOutput(_session, args) {
    if (args && !['daily', 'weekly', 'cumulative'].includes(args)) {
      throw new Error('Usage: /usage [daily|weekly|cumulative]');
    }
    const response = await _session.client.request('account/usage/read');
    const view = args || 'daily';
    const usage = response?.usage || response;
    return [
      `**Codex usage · ${view}**`,
      `\`\`\`json\n${JSON.stringify(usage, null, 2)}\n\`\`\``,
    ].join('\n');
  }

  async #sendFeedback(session, args) {
    const separator = args.indexOf(' ');
    const classification = separator === -1 ? args : args.slice(0, separator);
    const reason = separator === -1 ? '' : args.slice(separator + 1).trim();
    const allowed = ['bug', 'bad_result', 'good_result', 'safety_check', 'other'];
    if (!allowed.includes(classification) || !reason) {
      throw new Error(
        'Usage: /feedback <bug|bad_result|good_result|safety_check|other> <message>',
      );
    }
    const response = await session.client.request('feedback/upload', {
      classification,
      reason,
      includeLogs: false,
      threadId: session.nativeSessionId,
    });
    return `Feedback sent for thread \`${response?.threadId || session.nativeSessionId}\`.`;
  }

  async #backgroundTerminalsOutput(session) {
    const terminals = [];
    let cursor = null;
    do {
      const response = await session.client.request('thread/backgroundTerminals/list', {
        threadId: session.nativeSessionId,
        cursor,
        limit: 100,
      });
      terminals.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
    } while (cursor);
    if (!terminals.length) return 'No background terminals are running.';
    return [
      '**Background terminals**',
      ...terminals.map((terminal) => (
        `- \`${terminal.processId}\` · ${terminal.command}`
        + `${terminal.osPid ? ` · pid ${terminal.osPid}` : ''}`
      )),
    ].join('\n');
  }

  async #setPersonality(session, args) {
    if (!['friendly', 'pragmatic'].includes(args)) {
      throw new Error('Usage: /personality <friendly|pragmatic>');
    }
    await session.client.request('thread/settings/update', {
      threadId: session.nativeSessionId,
      personality: args,
    });
    return `Personality changed to **${args}**.`;
  }

  #skillsOutput(skills) {
    if (!skills.length) return 'No enabled Codex skills were found.';
    return [
      '**Codex skills**',
      ...skills.map((skill) => (
        `- **$${skill.name}**${skill.description ? `: ${skill.description}` : ''}`
      )),
    ].join('\n');
  }

  #prepareTurn(session, turn) {
    turn.session = session;
    turn.turnId = null;
    turn.accepted = false;
    turn.userTurnConfirmed = false;
    turn.nextBlockId = 0;
    turn.items = new Map();
    turn.framer = new StreamFramer((frame) => this.#emitFrame(turn, frame));
    return turn;
  }

  #acceptTurn(turn) {
    if (turn.accepted) return false;
    turn.accepted = true;
    turn.callbacks.onAccepted?.(turn.streamId);
    return true;
  }

  #failTurn(turn, error) {
    if (turn.ended) return;
    turn.ended = true;
    turn.framer?.cancel();
    turn.callbacks.onError?.(
      turn.streamId,
      { code: error.code || -1, detail: error.message },
    );
  }

  #bindTurnId(turn, turnId, replace = false) {
    if (!turnId) return false;
    if (turn.turnId && turn.turnId !== turnId) {
      if (!replace) return false;
      this.turns.delete(this.#turnKey(turn.session.nativeSessionId, turn.turnId));
    }
    turn.turnId = turnId;
    this.turns.set(this.#turnKey(turn.session.nativeSessionId, turnId), turn);
    if (!turn.observerOnly) {
      registerRuntimeOwnedMessage(
        'codex',
        codexTurnLiveKey(turnId),
      );
    }
    return true;
  }

  #turnKey(nativeSessionId, turnId) {
    return `${nativeSessionId}:${turnId}`;
  }

  #turn(session, params) {
    if (params?.threadId && params.threadId !== session.nativeSessionId) return null;
    const existing = params?.turnId
      && this.turns.get(this.#turnKey(session.nativeSessionId, params.turnId));
    if (existing) return existing;
    const turn = session.active;
    if (!turn) return null;
    if (turn.turnId && params?.turnId && turn.turnId !== params.turnId) return null;
    this.#bindTurnId(turn, params?.turnId);
    return turn;
  }

  #startItemBlocks(turn, state, item) {
    if (state.blocks.length) return state;
    const previewItem = {
      ...item,
      type: state.type || item.type,
      phase: state.phase || item.phase,
    };
    const previews = codexPreviewBlocks(previewItem);
    for (const preview of previews) {
      const blockId = turn.nextBlockId++;
      state.blocks.push(blockId);
      turn.framer.start(blockId, preview.kind, preview.name || null);
      if (preview.input) {
        turn.framer.input(blockId, JSON.stringify(preview.input));
        turn.framer.stop(blockId);
      }
    }
    return state;
  }

  #itemState(turn, item, options = {}) {
    let state = turn.items.get(item.id);
    if (state) {
      if (item.type) state.type = item.type;
      if (item.phase) state.phase = item.phase;
      state.item = { ...state.item, ...item };
      if (options.startBlocks !== false) this.#startItemBlocks(turn, state, item);
      return state;
    }
    state = {
      itemId: item.id,
      type: item.type,
      phase: item.phase || null,
      item: { ...item },
      blocks: [],
      text: '',
      completed: false,
      stopped: false,
    };
    turn.items.set(item.id, state);
    if (options.startBlocks !== false) this.#startItemBlocks(turn, state, item);
    return state;
  }

  #completeItem(turn, item, completedAtMs, options = {}) {
    if (!item?.id) return;
    const state = this.#itemState(turn, item, { startBlocks: false });
    const completedItem = options.interrupted
      ? {
          ...state.item,
          ...item,
          interrupted: true,
          status: 'interrupted',
        }
      : { ...state.item, ...item };
    state.item = completedItem;
    if (!state.blocks.length && isCodexToolItem(completedItem)) {
      this.#startItemBlocks(turn, state, completedItem);
    }
    const finalText = completedItem.type === 'agentMessage' || completedItem.type === 'plan'
      ? String(completedItem.text || '')
      : '';

    // turn/completed carries the final item list. Reconcile from it when an
    // intermediate delta notification was missed so the shared CC stream
    // contract always flushes the final buffered frame before completing.
    if (finalText) {
      this.#startItemBlocks(turn, state, completedItem);
      let missing = '';
      if (!state.text) missing = finalText;
      else if (finalText.startsWith(state.text)) missing = finalText.slice(state.text.length);
      if (missing) {
        state.text += missing;
        turn.framer.delta(state.blocks[0], missing);
      }
    }

    if (!state.stopped && state.blocks.length
      && ['agentMessage', 'reasoning', 'plan'].includes(state.type)) {
      turn.framer.stop(state.blocks[0]);
      state.stopped = true;
    }
    if (state.completed) return;
    state.completed = true;
    for (const complete of codexCompletedLiveMessages(
      completedItem,
      completedAtMs,
      state.text,
      {
        turnId: turn.turnId,
        sessionId: turn.session.nativeSessionId,
      },
    )) {
      turn.callbacks.onMessage?.(
        turn.streamId,
        complete.message,
        {
          normalized: true,
          runtime: 'codex',
          liveKey: codexTurnLiveKey(turn.turnId),
        },
      );
    }
  }

  #onNotification(session, client, { method, params }) {
    if (session.client !== client) return;
    if (method === 'skills/changed') {
      session.skills = null;
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      if (!params?.threadId || params.threadId === session.nativeSessionId) {
        session.tokenUsage = cloneJson(params?.tokenUsage);
      }
      return;
    }
    if (method === 'serverRequest/resolved') {
      const requestId = `codex:${session.nativeSessionId}:${params.requestId}`;
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        this.pendingRequests.delete(requestId);
        pending.turn.callbacks.onControlResolved?.(requestId);
      }
      return;
    }
    const active = session.active;
    if (active && this.#matchesCurrentUserItem(active, method, params)) {
      this.#bindTurnId(active, params.turnId, true);
      active.userTurnConfirmed = true;
    }
    const turn = this.#turn(session, params);
    if (method === 'turn/started') {
      if (turn) {
        this.#bindTurnId(turn, params.turn?.id, !turn.userTurnConfirmed);
        this.#acceptTurn(turn);
      }
      return;
    }
    if (!turn) return;

    if (method === 'error') {
      if (!params.willRetry) turn.error = params.error;
      return;
    }

    if (method === 'item/started') {
      const streamedType = ['agentMessage', 'reasoning', 'plan']
        .includes(params.item?.type);
      this.#itemState(turn, params.item, { startBlocks: !streamedType });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'agentMessage',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/reasoning/textDelta'
      || method === 'item/reasoning/summaryTextDelta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'reasoning',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/plan/delta') {
      const state = this.#itemState(turn, {
        id: params.itemId,
        type: 'plan',
      });
      state.text += params.delta || '';
      turn.framer.delta(state.blocks[0], params.delta || '');
      return;
    }

    if (method === 'item/completed') {
      this.#completeItem(turn, params.item, params.completedAtMs);
      return;
    }

    if (method === 'turn/completed') {
      const completedAtMs = Number.isFinite(params.turn?.completedAt)
        ? params.turn.completedAt * 1000
        : undefined;
      const subtype = turnStatusError(params.turn);
      const finalItems = params.turn?.items || [];
      const finalItemIds = new Set(finalItems.map((item) => item?.id).filter(Boolean));
      for (const item of finalItems) {
        const state = turn.items.get(item?.id);
        this.#completeItem(turn, item, completedAtMs, {
          interrupted: subtype === 'interrupted'
            && isCodexToolItem(item)
            && !state?.completed,
        });
      }
      if (subtype === 'interrupted') {
        for (const state of turn.items.values()) {
          if (state.completed || finalItemIds.has(state.itemId)
            || !isCodexToolItem(state.item)) continue;
          this.#completeItem(turn, state.item, completedAtMs, {
            interrupted: true,
          });
        }
      }
      const errorMessage = codexTurnErrorLiveMessage(
        turn.turnId,
        params.turn?.error,
        completedAtMs,
      ) || codexTurnErrorLiveMessage(
        turn.turnId,
        turn.error,
        completedAtMs,
      ) || (subtype === 'failed'
        ? codexTurnErrorLiveMessage(turn.turnId, subtype, completedAtMs)
        : null);
      if (errorMessage) {
        turn.callbacks.onMessage?.(
          turn.streamId,
          errorMessage.message,
          {
            normalized: true,
            runtime: 'codex',
            liveKey: codexTurnLiveKey(turn.turnId),
          },
        );
      }
      turn.framer.finish();
      turn.ended = true;
      turn.callbacks.onResult?.(
        turn.streamId,
        {
          is_error: !!(errorMessage || subtype),
          subtype,
          status: params.turn?.status,
        },
      );
      this.turns.delete(this.#turnKey(
        turn.session.nativeSessionId,
        turn.turnId,
      ));
      turn.session.active = null;
      for (const [requestId, pending] of this.pendingRequests) {
        if (pending.turn === turn) this.pendingRequests.delete(requestId);
      }
      this.#drainOrRelease(turn.session);
    }
  }

  #emitFrame(turn, frame) {
    const cb = turn.callbacks;
    if (frame.t === 'start') {
      cb.onBlockStart?.(
        turn.streamId,
        frame.blockId,
        frame.kind,
        frame.name,
      );
    } else if (frame.t === 'delta') {
      cb.onDelta?.(turn.streamId, frame.chunk, frame.blockId);
    } else if (frame.t === 'input') {
      cb.onInputDelta?.(turn.streamId, frame.chunk, frame.blockId);
    } else if (frame.t === 'stop') {
      cb.onBlockStop?.(turn.streamId, frame.blockId);
    }
  }

  #matchesCurrentUserItem(turn, method, params) {
    if (method !== 'item/started' && method !== 'item/completed') return false;
    return params?.item?.type === 'userMessage'
      && params.item.clientId === turn.streamId
      && !!params.turnId;
  }

  #drainOrRelease(session) {
    if (session.active) return;
    if (session.queue.length) {
      const next = session.queue.shift();
      this.#startTurn(session, next).catch(() => {});
      return;
    }
    this.#release(session).catch(() => {});
  }

  #onServerRequest(session, client, request) {
    if (session.client !== client) return;
    const turn = this.#turn(session, request.params);
    if (!turn) {
      client.respondError(request.id, -32602, 'No active Baton turn');
      return;
    }
    const params = request.params || {};
    let toolName = 'Tool';
    let input = params;
    let requiresInteraction = false;
    let approvalDecisions = null;
    let approvalType = null;
    if (request.method === 'item/commandExecution/requestApproval') {
      toolName = 'Bash';
      approvalType = 'codex-command';
      approvalDecisions = commandApprovalDecisions(params);
      input = {
        command: params.command || '',
        cwd: params.cwd || '',
        reason: params.reason || '',
        codexCommandActions: params.commandActions || [],
        codexApproval: {
          availableDecisions: approvalDecisions,
          networkApprovalContext: params.networkApprovalContext || null,
          additionalPermissions: params.additionalPermissions || null,
          proposedExecpolicyAmendment: params.proposedExecpolicyAmendment || null,
          proposedNetworkPolicyAmendments: params.proposedNetworkPolicyAmendments || null,
        },
      };
    } else if (request.method === 'item/fileChange/requestApproval') {
      toolName = 'Edit';
      approvalType = 'codex-file-change';
      approvalDecisions = ['accept', 'acceptForSession', 'cancel'];
      input = {
        path: params.grantRoot || '',
        reason: params.reason || '',
        codexApproval: {
          availableDecisions: approvalDecisions,
        },
      };
    } else if (request.method === 'item/permissions/requestApproval') {
      toolName = 'Permissions';
      approvalType = 'codex-permissions';
      input = {
        cwd: params.cwd || '',
        reason: params.reason || '',
        codexPermissions: {
          permissions: cloneJson(params.permissions, {}),
        },
      };
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (params.mode !== 'form'
        || mcpMeta(params)?.codex_approval_kind === 'tool_suggestion') {
        client.respond(request.id, {
          action: 'decline',
          content: null,
          _meta: null,
        });
        return;
      }
      toolName = params.serverName || 'MCP server';
      approvalType = 'codex-mcp-elicitation';
      input = {
        codexMcpElicitation: mcpElicitationDetails(params),
      };
    } else if (request.method === 'item/tool/requestUserInput') {
      toolName = 'AskUserQuestion';
      input = { questions: params.questions || [] };
      requiresInteraction = true;
    } else {
      client.respondError(request.id, -32601, 'Unsupported Codex server request');
      return;
    }
    const requestId = `codex:${session.nativeSessionId}:${request.id}`;
    this.pendingRequests.set(requestId, {
      ...request,
      turn,
      client,
      approvalDecisions,
    });
    turn.callbacks.onControlRequest?.({
      request_id: requestId,
      request: {
        tool_name: toolName,
        input,
        requires_user_interaction: requiresInteraction,
        approval_type: approvalType,
      },
    });
  }

  replyControl(nativeSessionId, requestId, reply) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.turn.session.nativeSessionId !== nativeSessionId) return false;
    this.pendingRequests.delete(requestId);
    if (pending.method === 'item/tool/requestUserInput') {
      const answer = reply.answerText || '';
      const answers = Object.fromEntries(
        (pending.params.questions || []).map((question) => [
          question.id,
          { answers: answer ? [answer] : [] },
        ]),
      );
      pending.client.respond(pending.id, { answers });
    } else if (pending.method === 'item/permissions/requestApproval') {
      pending.client.respond(
        pending.id,
        permissionApprovalResponse(pending, reply.approvalResponse),
      );
    } else if (pending.method === 'mcpServer/elicitation/request') {
      pending.client.respond(
        pending.id,
        mcpElicitationResponse(pending, reply.approvalResponse),
      );
    } else {
      pending.client.respond(pending.id, {
        decision: normalizeApprovalDecision(pending, reply.decision),
      });
    }
    return true;
  }

  async interrupt(nativeSessionId) {
    const turn = this.sessions.get(nativeSessionId)?.active;
    if (!turn?.turnId) return false;
    try {
      await turn.session.client.request('turn/interrupt', {
        threadId: nativeSessionId,
        turnId: turn.turnId,
      });
      return true;
    } catch {
      return false;
    }
  }

  owns(nativeSessionId) {
    const session = this.sessions.get(nativeSessionId);
    return !!session?.client
      && session.subscribedGeneration === session.client.generation
      && !session.active?.observerOnly;
  }

  isBusy(nativeSessionId) {
    return !!this.sessions.get(nativeSessionId)?.active;
  }

  async shutdown() {
    const clients = new Set();
    const releases = [];
    for (const session of this.sessions.values()) {
      if (session.client) clients.add(session.client);
      if (session.releasingClient) clients.add(session.releasingClient);
      if (session.releasePromise) releases.push(session.releasePromise);
      session.active = null;
      session.queue = [];
      session.client = null;
      session.releasingClient = null;
      session.subscribedGeneration = 0;
    }
    this.turns.clear();
    this.pendingRequests.clear();
    await Promise.allSettled([
      ...releases,
      ...[...clients].map((client) => client.stop()),
    ]);
  }

  #onExit(session, client, error) {
    if (session.client !== client || session.releasingClient === client) return;
    session.client = null;
    session.subscribedGeneration = 0;
    const turn = session.active;
    if (turn) {
      this.turns.delete(this.#turnKey(session.nativeSessionId, turn.turnId));
      this.#failTurn(turn, error);
    }
    for (const queued of session.queue) {
      queued.callbacks.onError?.(
        queued.streamId,
        { code: -1, detail: error.message },
      );
    }
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.turn.session === session) this.pendingRequests.delete(requestId);
    }
    session.queue = [];
    session.active = null;
  }
}

export const codexInteraction = defineInteractionAdapter(new CodexInteraction());
