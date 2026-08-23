import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import {
  extractClaudeMessages,
  countJsonlLines,
} from './extract.mjs';
import {
  findSessionFile,
  getDaemonSessions,
  getDaemonRunningSessionIds,
  getRunningInfo,
  getSessionMetadata,
  getSessionStatus,
  normalizeProjectHash,
  readableProjectName,
} from './session.mjs';
import { defineRuntimeAdapter } from './runtime-adapter.mjs';
import {
  binaryVersion,
  existingDirectory,
  resolveClaudeBinForCapability,
} from './runtime-capabilities.mjs';
import {
  discoverClaudeSubagents,
  findClaudeSubagentFile,
  parseClaudeSubagentSessionId,
} from './claude-subagent.mjs';
import { trackAgentSession } from './agent-counts.mjs';

function findClaudeSessionFile(nativeSessionId) {
  return findClaudeSubagentFile(nativeSessionId) || findSessionFile(nativeSessionId);
}

export function discoverClaudeSessions(options = {}) {
  const projectsRoot = options.claudeProjectsRoot || CLAUDE_PROJECTS;
  const runningInfo = options.runningInfo || getRunningInfo();
  const sessions = [];
  const errors = [];
  let projects = [];
  let fileCount = 0;

  try {
    projects = fs.existsSync(projectsRoot) ? fs.readdirSync(projectsRoot) : [];
  } catch (error) {
    errors.push({ path: projectsRoot, error: error.message });
  }

  for (const project of projects) {
    const projectDir = path.join(projectsRoot, project);
    let jsonlFiles;
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
      jsonlFiles = fs.readdirSync(projectDir)
        .filter((file) => file.endsWith('.jsonl') && !file.startsWith('.'));
    } catch (error) {
      errors.push({ path: projectDir, error: error.message });
      continue;
    }

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);
      fileCount++;
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (error) {
        errors.push({ path: filePath, error: error.message });
        continue;
      }
      if (stat.size === 0) continue;

      const metadata = getSessionMetadata(filePath);
      if (!metadata.preview) continue;
      const nativeSessionId = file.slice(0, -'.jsonl'.length);
      const projectHash = normalizeProjectHash(project);
      const session = {
        id: nativeSessionId,
        nativeSessionId,
        runtime: 'claude',
        project: projectHash,
        projectName: readableProjectName(projectHash),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview: metadata.preview,
        model: metadata.model,
        status: getSessionStatus(nativeSessionId, filePath, runningInfo),
        _filePath: filePath,
        _lineCount: metadata.lineCount,
      };
      sessions.push(session);
      sessions.push(...discoverClaudeSubagents(projectDir, session, {
        now: options.now,
      }));
    }
  }

  const daemonMeta = options.daemonMeta || getDaemonSessions();
  for (const session of sessions) {
    const daemon = daemonMeta.get(session.nativeSessionId);
    if (!daemon) continue;
    session.isAgent = true;
    session.agentName = daemon.agentName;
    session.agentDetail = daemon.agentDetail;
    session.status = daemon.status;
  }

  return {
    sessions,
    complete: errors.length === 0,
    diagnostics: {
      files: fileCount,
      errors,
      malformedLines: 0,
      skipped: {},
    },
  };
}

async function syncClaudeMessages(session, context, startLine) {
  const extracted = await extractClaudeMessages(
    session._filePath,
    session.nativeSessionId,
    {
      startLine,
      watermarks: context.watermarks,
    },
  );
  if (extracted.messages.length > 0) {
    await context.uploader(context.storageSessionId, extracted.messages);
  }
  context.watermarks.set(context.storageSessionId, extracted.nextLine);
  return extracted;
}

function insideRoot(target, root) {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function removeInsideRoot(target, root) {
  if (!insideRoot(target, root)) return false;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function removeClaudeSessionHistoryFiles(
  filePath,
  nativeSessionId,
  context = {},
) {
  const projectsRoot = context.projectsRoot || CLAUDE_PROJECTS;
  const sessionDir = filePath.endsWith('.jsonl')
    ? filePath.slice(0, -'.jsonl'.length)
    : '';
  const fileDeleted = removeInsideRoot(filePath, projectsRoot);
  const childrenDeleted = !sessionDir
    || removeInsideRoot(sessionDir, projectsRoot);
  if (fileDeleted && childrenDeleted && context.watermarks) {
    const childPrefix = `${nativeSessionId}:subagent:`;
    for (const sessionId of Array.from(context.watermarks.keys())) {
      if (sessionId === nativeSessionId || sessionId.startsWith(childPrefix)) {
        context.watermarks.delete(sessionId);
      }
    }
  }
  return fileDeleted && childrenDeleted;
}

export const claudeRuntime = defineRuntimeAdapter({
  runtime: 'claude',
  displayName: 'Claude',
  features: {
    create: true,
    send: true,
    interrupt: true,
    deleteHistory: true,
    statusPolling: true,
  },

  discover: discoverClaudeSessions,
  detectCapability(options = {}) {
    const binary = options.claudeBin === undefined
      ? resolveClaudeBinForCapability()
      : options.claudeBin;
    const historyAvailable = existingDirectory(options.claudeProjects || CLAUDE_PROJECTS);
    return {
      installed: !!binary,
      historyAvailable,
      canRead: historyAvailable,
      canCreate: !!binary,
      canSend: !!binary,
      version: options.skipVersions ? '' : binaryVersion(binary),
    };
  },
  findSessionFile: findClaudeSessionFile,

  shouldSkipInitial(_session, context) {
    return context.watermarks.has(context.storageSessionId);
  },

  baselineToEnd(session, context) {
    const lineCount = session._lineCount ?? countJsonlLines(session._filePath);
    context.watermarks.set(context.storageSessionId, lineCount);
  },

  syncInitialMessages(session, context) {
    const startLine = context.watermarks.get(context.storageSessionId) ?? 0;
    return syncClaudeMessages(session, context, startLine);
  },

  syncAllMessages(session, context) {
    return syncClaudeMessages(session, context, 0);
  },

  deleteSessionHistory(nativeSessionId, context = {}) {
    if (parseClaudeSubagentSessionId(nativeSessionId)) return false;
    const filePath = findClaudeSessionFile(nativeSessionId);
    if (!filePath) return false;
    return removeClaudeSessionHistoryFiles(filePath, nativeSessionId, context);
  },

  deleteProjectHistory(projectHash) {
    if (!projectHash || projectHash.includes('/') || projectHash.includes('..')) return false;
    return removeInsideRoot(path.join(CLAUDE_PROJECTS, projectHash), CLAUDE_PROJECTS);
  },

  ownsLiveSession(nativeSessionId, context = {}) {
    return !!context.pool?.owns(nativeSessionId);
  },

  createStatusContext(context = {}) {
    return {
      runningInfo: getRunningInfo(),
      daemonMeta: getDaemonSessions(),
      daemonRunning: getDaemonRunningSessionIds(),
      poolOwns: context.poolOwns || (() => false),
      lastKnownStatus: context.lastKnownStatus,
      findSessionFile: context.findSessionFile || findSessionFile,
    };
  },

  inspectActiveSession(active, context) {
    const nativeSessionId = active.nativeSessionId || active.sessionId;
    const filePath = (context.findSessionFile || findClaudeSessionFile)(nativeSessionId);
    const gone = !filePath || !fs.existsSync(filePath);
    const daemon = context.daemonMeta.get(nativeSessionId);
    if (!gone && ((context.daemonRunning || new Set()).has(nativeSessionId) || context.poolOwns(nativeSessionId))) {
      return null;
    }
    const newStatus = gone
      ? 'completed'
      : getSessionStatus(nativeSessionId, filePath, context.runningInfo);
    if (newStatus === active.status) return null;

    const projectHash = normalizeProjectHash(active.projectHash || '');
    const projectName = readableProjectName(projectHash);
    const stat = gone ? null : fs.statSync(filePath);
    const metadata = gone ? null : getSessionMetadata(filePath);
    const lastActive = gone ? active.lastActive : stat.mtime.toISOString();
    context.lastKnownStatus.set(nativeSessionId, newStatus);
    const session = {
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'claude',
      project: projectHash,
      projectName,
      lastActive,
      size: stat?.size || 0,
      preview: metadata?.preview || active.preview || '',
      model: metadata?.model || '',
      status: newStatus,
    };
    if (daemon) {
      session.isAgent = true;
      session.agentName = daemon.agentName;
      session.agentDetail = newStatus === 'needs_input' ? daemon.agentDetail || '' : '';
    }
    return {
      session,
      statusDelta: {
        deviceName: active.deviceName,
        projectHash,
        projectName,
        from: active.status,
        to: newStatus,
        lastActive,
      },
    };
  },

  async updateSessionStatus(config, nativeSessionId, filePath, projectHash, newStatus, detail, context) {
    projectHash = normalizeProjectHash(projectHash);
    const previousStatus = context.lastKnownStatus.get(nativeSessionId);
    let stat;
    try { stat = fs.statSync(filePath); } catch { return; }
    const lastActive = stat.mtime.toISOString();
    const projectName = readableProjectName(projectHash);
    const daemon = (context.daemonMeta || getDaemonSessions()).get(nativeSessionId);
    const metadata = getSessionMetadata(filePath);
    const session = {
      id: nativeSessionId,
      nativeSessionId,
      runtime: 'claude',
      project: projectHash,
      projectName,
      lastActive,
      size: stat.size,
      preview: metadata.preview,
      model: metadata.model,
      status: newStatus,
    };
    if (daemon) {
      session.isAgent = true;
      session.agentName = daemon.agentName;
    }
    session.agentDetail = newStatus === 'needs_input'
      ? (detail !== undefined ? detail : daemon?.agentDetail || '')
      : '';
    trackAgentSession(session);
    await context.postFn('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [session],
      statusDeltas: [{
        deviceName: config.deviceName,
        projectHash,
        projectName,
        from: context.isNew && previousStatus === undefined ? 'new' : previousStatus || 'completed',
        to: newStatus,
        lastActive,
      }],
    });
    context.lastKnownStatus.set(nativeSessionId, newStatus);
  },
});
