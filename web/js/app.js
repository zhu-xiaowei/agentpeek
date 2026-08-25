// App state, routing, page loading
import { state } from './state.js';
import {
  invalidateListCache,
  migrateLegacyListCache,
  readListCache,
  writeListCache,
} from './list-cache.js';
import { createListPageStore, LIST_PAGE_SIZE } from './list-pagination.js';
import {
  attachEdgeBackGesture,
  markCurrentRoute,
  prepareNavigation,
  savePagePreview,
  takePreviousNavigation,
} from './edge-back.js';
import {
  creatableRuntimes,
  newSessionRuntimePreferenceKey,
  nextNewSessionRuntime,
  preferredNewSessionRuntime,
} from './new-session-runtime.js';

var _navVersion = 0;
var _listPrefetches = {};
var _listPages = createListPageStore(12);
var _activeListKey = null;
var _activeListOptions = null;
var LIST_PRELOAD_PX = 1200;
var _pageWasHidden = document.visibilityState === 'hidden';
var _foregroundRefresh = null;
var _agentThreadsCache = new Map();
var AGENT_THREADS_CACHE_LIMIT = 32;
var _navPointer = null;
var _breadcrumbUpdatePending = false;

// Stubs replaced when loadViewerLibs() resolves — needed on the device-list path.
if (typeof window.disconnectWs !== 'function') window.disconnectWs = function () {};
if (typeof window.updateSpinner !== 'function') window.updateSpinner = function () {};

function osName(os) {
  return { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[os] || os || 'unknown';
}

function timeAgo(iso) {
  var diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function releaseNavPointer(pointer) {
  if (!pointer || _navPointer !== pointer) return;
  _navPointer = null;
  pointer.waiters.forEach(function (resolve) { resolve(); });
  if (_breadcrumbUpdatePending) setTimeout(updateBreadcrumb, 0);
}

document.addEventListener('pointerdown', function (e) {
  var target = e.target.closest && e.target.closest('.list > .item[data-id], #breadcrumb a');
  if (!target || e.isPrimary === false || (e.pointerType === 'mouse' && e.button !== 0)) return;
  _navPointer = { id: e.pointerId, target: target, waiters: _navPointer ? _navPointer.waiters : [] };
}, true);

document.addEventListener('pointerup', function (e) {
  if (!_navPointer || e.pointerId !== _navPointer.id) return;
  var pointer = _navPointer;
  setTimeout(function () { releaseNavPointer(pointer); }, 500);
}, true);

document.addEventListener('pointercancel', function (e) {
  if (_navPointer && e.pointerId === _navPointer.id) releaseNavPointer(_navPointer);
}, true);

document.addEventListener('click', function (e) {
  if (_navPointer && _navPointer.target.contains(e.target)) releaseNavPointer(_navPointer);
}, true);

function waitForListPointer() {
  if (!_navPointer) return Promise.resolve();
  return new Promise(function (resolve) { _navPointer.waiters.push(resolve); });
}

// ---- Batch-delete selection ----
// Checkbox markup prepended to each item in select mode (CSS slides it in from the left).
function selectBox(id) {
  var on = state.selected.has(id);
  return '<span class="sel-box' + (on ? ' on' : '') + '" data-selid="' + esc(id) + '">'
    + (on ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M13 4L6 11l-3-3" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '')
    + '</span>';
}

// Toggle select mode by mutating the live DOM (add/remove the checkbox column) —
// no list re-fetch/re-render, so entering/leaving doesn't flash.
function applySelectModeDom() {
  var list = document.querySelector('.list');
  if (!list) return;
  list.classList.toggle('select-mode', state.selectMode);
  list.querySelectorAll('.item[data-id]').forEach(function (item) {
    var existing = item.querySelector(':scope > .sel-box');
    if (state.selectMode) {
      if (!existing) item.insertAdjacentHTML('afterbegin', selectBox(item.getAttribute('data-id')));
    } else if (existing) {
      existing.remove();
    }
  });
}

function enterSelectMode(type, firstId) {
  state.selectMode = true;
  state.selectType = type;
  state.selected = new Set(firstId ? [firstId] : []);
  applySelectModeDom();
  updateBreadcrumb();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selectType = null;
  state.selected = new Set();
  applySelectModeDom();
  updateBreadcrumb();
}

// Toggle one item's selection by mutating just its checkbox — no list re-fetch/re-render.
function toggleSelected(id) {
  var on = !state.selected.has(id);
  if (on) state.selected.add(id); else state.selected.delete(id);
  var box = document.querySelector('.list.select-mode .item[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .sel-box');
  if (box) {
    box.classList.toggle('on', on);
    box.innerHTML = on ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M13 4L6 11l-3-3" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
  }
  updateBreadcrumb(); // refresh the Delete count only
}

var LONG_PRESS_MS = 800;
var LONG_PRESS_MOVE_PX = 8;

function detachLongPress(container) {
  if (!container || typeof container.__longPressCleanup !== 'function') return;
  container.__longPressCleanup();
}

// Long-press vs text-selection: require a deliberate 800ms hold so a slightly
// slow click cannot become an edit action. Moving, scrolling, dragging, or
// leaving cancels it.
// In select mode a click toggles the item (capture handler beats the baked nav onclick).
function attachLongPress(container, type) {
  detachLongPress(container);
  var timer = null, sx = 0, sy = 0, targetId = null, activePointerId = null;
  var gestureVersion = 0, justLongPressed = false;
  var clear = function () {
    gestureVersion++;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    targetId = null;
    activePointerId = null;
  };
  var clearPointer = function (e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    clear();
  };
  var onPointerDown = function (e) {
    // A replacement/duplicate pointerdown must invalidate the previous timer.
    // Otherwise its remaining delay can be mistaken for a very short new press.
    clear();
    justLongPressed = false; // new gesture: a stale flag must not swallow this tap
    if (state.selectMode || e.isPrimary === false) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, input, textarea, select, [role="button"], [contenteditable="true"]')) return;
    var item = e.target.closest && e.target.closest('.item[data-id]');
    if (!item) return;
    var pressVersion = gestureVersion;
    var pressId = item.getAttribute('data-id');
    var pointerId = e.pointerId;
    sx = e.clientX; sy = e.clientY; targetId = pressId; activePointerId = pointerId;
    timer = setTimeout(function () {
      if (pressVersion !== gestureVersion
          || activePointerId !== pointerId
          || targetId !== pressId
          || state.selectMode) return;
      timer = null;
      justLongPressed = true;
      enterSelectMode(type, pressId);
    }, LONG_PRESS_MS);
  };
  var onPointerMove = function (e) {
    if (timer === null || e.pointerId !== activePointerId) return;
    var dx = e.clientX - sx, dy = e.clientY - sy;
    if ((dx * dx) + (dy * dy) > LONG_PRESS_MOVE_PX * LONG_PRESS_MOVE_PX) clear();
  };
  var onClick = function (e) {
    if (!state.selectMode) return;
    e.preventDefault(); e.stopPropagation(); // beat the item's baked navigation onclick
    // The pointerup after a long-press fires a click; swallow it (selection already made).
    if (justLongPressed) { justLongPressed = false; return; }
    var item = e.target.closest && e.target.closest('.item[data-id]');
    if (item) toggleSelected(item.getAttribute('data-id'));
  };

  container.addEventListener('pointerdown', onPointerDown);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerup', clearPointer);
  container.addEventListener('pointercancel', clearPointer);
  container.addEventListener('pointerleave', clearPointer);
  container.addEventListener('scroll', clear, true);
  container.addEventListener('dragstart', clear);
  container.addEventListener('click', onClick, true);

  var cleanup = function () {
    clear();
    container.removeEventListener('pointerdown', onPointerDown);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerup', clearPointer);
    container.removeEventListener('pointercancel', clearPointer);
    container.removeEventListener('pointerleave', clearPointer);
    container.removeEventListener('scroll', clear, true);
    container.removeEventListener('dragstart', clear);
    container.removeEventListener('click', onClick, true);
    if (container.__longPressCleanup === cleanup) delete container.__longPressCleanup;
  };
  container.__longPressCleanup = cleanup;
}

// Unified 3-state (running / needs_input / completed); legacy idle/stopped/unknown → Done.
function statusLabel(status) {
  if (status === 'running') return 'Running';
  if (status === 'needs_input') return 'Needs input';
  return 'Done';
}

// needs_input reuses the amber .badge.idle style; Done reuses the grey .badge.stopped (quiet terminal state).
function statusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'needs_input') return 'idle';
  return 'stopped';
}

function sessionRuntime(sessionId, runtime) {
  return runtime === 'codex' || String(sessionId || '').indexOf('codex:') === 0 ? 'codex' : 'claude';
}

function nativeSessionId(sessionId, nativeId, runtime) {
  var value = String(nativeId || sessionId || '');
  return sessionRuntime(sessionId, runtime) === 'codex' && value.indexOf('codex:') === 0
    ? value.slice('codex:'.length)
    : value;
}

function shortSessionId(sessionId, nativeId, runtime) {
  var value = nativeSessionId(sessionId, nativeId, runtime);
  return sessionRuntime(sessionId, runtime) === 'codex' ? value.slice(-8) : value.slice(0, 8);
}

function runtimeIcon(sessionId, runtime) {
  var value = sessionRuntime(sessionId, runtime);
  var label = value === 'codex' ? 'Codex' : 'Claude Code';
  return '<span class="runtime-mark" role="img" aria-label="' + label + '" title="' + label + '">'
    + '<img class="runtime-icon" width="16" height="16" decoding="sync" src="./assets/' + (value === 'codex' ? 'codex.svg' : 'claude-code.svg') + '" alt="" aria-hidden="true"></span>';
}

function activeSessionThread() {
  return state.sessionThreads.find(function (thread) {
    return thread.sessionId === state.activeThreadId;
  }) || null;
}

function agentThreadShortId(thread) {
  var value = String(thread.nativeSessionId || thread.sessionId || '');
  var marker = ':subagent:';
  var markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    var childId = value.slice(markerIndex + marker.length).replace(/^agent-/, '');
    return childId.slice(-8) || childId;
  }
  return shortSessionId(
    thread.sessionId,
    thread.nativeSessionId,
    thread.runtime || state.appState.runtime,
  );
}

function agentThreadStatus(threads) {
  var agents = threads.filter(function (thread) {
    return thread.sessionId !== state.rootSessionId;
  });
  if (agents.some(function (thread) { return thread.status === 'needs_input'; })) return 'needs-input';
  if (agents.some(function (thread) { return thread.status === 'running'; })) return 'running';
  return 'completed';
}

function cachedSessionThreads(rootSessionId) {
  var entry = _agentThreadsCache.get(rootSessionId);
  if (!entry) return [];
  _agentThreadsCache.delete(rootSessionId);
  _agentThreadsCache.set(rootSessionId, entry);
  return entry.map(function (thread) { return { ...thread }; });
}

function rememberSessionThreads(rootSessionId, threads) {
  _agentThreadsCache.delete(rootSessionId);
  _agentThreadsCache.set(
    rootSessionId,
    threads.map(function (thread) { return { ...thread }; }),
  );
  while (_agentThreadsCache.size > AGENT_THREADS_CACHE_LIMIT) {
    _agentThreadsCache.delete(_agentThreadsCache.keys().next().value);
  }
}

function sessionRuntimeControl() {
  var mark = runtimeIcon(
    state.rootSessionId || state.appState.session,
    state.appState.runtime,
  );
  if (state.sessionThreads.length <= 1) return mark;
  return '<button class="agent-thread-trigger" type="button"'
    + ' onclick="openAgentThreadsModal()" aria-label="Show agent threads"'
    + ' title="Agent threads">' + mark
    + '<span class="agent-thread-dot ' + agentThreadStatus(state.sessionThreads)
    + '" aria-hidden="true"></span></button>';
}

function runtimeLabel(runtime) {
  return runtime === 'codex' ? 'Codex' : 'Claude Code';
}

function newSessionRuntimeControl() {
  var runtimes = state.newSessionRuntimes;
  var current = state.appState.runtime;
  if (!runtimes.length || !current) return '';
  var mark = runtimeIcon('__new__', current);
  if (runtimes.length === 1) return mark;
  var next = nextNewSessionRuntime(runtimes, current);
  return '<button class="runtime-switch" type="button" onclick="toggleNewSessionRuntime()"'
    + ' aria-label="Switch coding runtime. Current: ' + runtimeLabel(current) + '"'
    + ' title="Switch to ' + runtimeLabel(next) + '">' + mark + '</button>';
}

function showStats() {}  // no-op, stats bar removed

function showWsBanner(status) {
  var existing = document.getElementById('ws-banner');
  if (status === 'connected' || status === '') {
    if (existing) existing.remove();
    return;
  }
  var content = document.getElementById('content');
  if (!content) return;
  if (!existing) {
    content.insertAdjacentHTML('afterbegin', '<div id="ws-banner" class="ws-banner"></div>');
    existing = document.getElementById('ws-banner');
  }
  if (status === 'reconnecting') {
    existing.className = 'ws-banner warn';
    existing.textContent = 'Reconnecting...';
  } else {
    existing.className = 'ws-banner error';
    existing.textContent = 'Disconnected';
  }
}

function navHref(view, params) {
  if (view === 'devices') return '#/';
  if (view === 'projects') return '#/' + encodeURIComponent(params.device);
  if (view === 'sessions') return '#/' + encodeURIComponent(params.device) + '/' + encodeURIComponent(params.projectHash);
  return '#/';
}

function displayDeviceName(deviceName) {
  return state.deviceDisplayNameMap[deviceName]
    || window.__deviceDisplayNames?.[deviceName]
    || deviceName;
}

function updateBreadcrumb() {
  if (_navPointer && _navPointer.target.closest('#breadcrumb')) {
    _breadcrumbUpdatePending = true;
    return;
  }
  _breadcrumbUpdatePending = false;
  var el = document.getElementById('breadcrumb');
  var parts = [];
  if (state.appState.device) {
    parts.push('<a href="' + navHref('projects', {device: state.appState.device}) + '" onclick="loadProjects(\'' + esc(state.appState.device) + '\');return false;">' + esc(displayDeviceName(state.appState.device)) + '</a>');
  }
  if (state.appState.project) {
    parts.push('<a href="' + navHref('sessions', {device: state.appState.device, projectHash: state.appState.project.hash}) + '" onclick="loadSessions(\'' + esc(state.appState.device) + '\',\'' + esc(state.appState.project.hash) + '\',\'' + esc(state.appState.project.name) + '\');return false;">' + esc(state.appState.project.name) + '</a>');
  }
  if (state.appState.session) {
    var label = state.appState.sessionPreview
      || shortSessionId(state.appState.session, '', state.appState.runtime) + '...';
    parts.push('<span>' + esc(label) + '</span>');
  }
  var _addSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var _gearHtml = '<a href="setup.html" class="top-gear" title="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></a>';
  var topRight = document.getElementById('top-right');
  topRight.classList.remove('syncing');
  topRight.classList.toggle('select-actions', state.selectMode);
  if (state.selectMode) {
    var n = state.selected.size;
    topRight.innerHTML = '<button class="text-btn" onclick="exitSelectMode()">Cancel</button>'
      + '<button class="text-btn danger" ' + (n ? '' : 'disabled') + ' onclick="openDeleteModal()">Delete' + (n ? '<span class="sel-count">' + n + '</span>' : '') + '</button>';
  } else if (state.appState.project) {
    var runtimeMark = state.appState.session === '__new__'
      ? newSessionRuntimeControl()
      : (state.appState.session ? sessionRuntimeControl() : '');
    topRight.innerHTML = runtimeMark + '<button class="new-session-btn" onclick="startNewSession(\'' + esc(state.appState.project.hash) + '\')" title="New Session">' + _addSvg + '</button>';
  } else if (state.appState.device && !state.appState.project) {
    topRight.innerHTML = '<button class="new-session-btn" onclick="createNewProject()" title="New Project">' + _addSvg + '</button>';
  } else if (!topRight.querySelector('.top-gear')) {
    topRight.innerHTML = _gearHtml;
  }
  var titleHtml = '';
  if (state.appState.session) {
    parts.pop();
    var titleText = esc(state.rootSessionPreview
      || state.appState.sessionPreview
      || shortSessionId(
        state.rootSessionId || state.appState.session,
        '',
        state.appState.runtime,
      ) + '...');
    var agentMark = state.appState.isAgent ? ' <span class="badge agent">Agent</span>' : '';
    titleHtml = '<span class="breadcrumb-sep">/</span><span class="breadcrumb-title">' + titleText + agentMark + '</span>';
  }
  el.innerHTML = '<div class="breadcrumb-nav" onclick="toggleBreadcrumbExpand(this)">'
    + parts.join('<span class="breadcrumb-sep">/</span>') + titleHtml
    + '</div>';
  el.style.display = parts.length > 0 ? 'flex' : 'none';
}

function toggleBreadcrumbExpand(nav) {
  nav.classList.toggle('expanded');
}

async function refreshSessionThreads() {
  if (!state.rootSessionId || !state.appState.project || !state.appState.device) {
    state.sessionThreads = [];
    return [];
  }
  var rootSessionId = state.rootSessionId;
  var requestVersion = state.threadRequestVersion;
  var data = await api('/api/bridge/session-threads', {
    device: state.appState.device,
    project: state.appState.project.hash,
    session: rootSessionId,
  });
  if (requestVersion !== state.threadRequestVersion
    || rootSessionId !== state.rootSessionId) {
    return state.sessionThreads;
  }
  var threads = Array.isArray(data.threads) ? data.threads : [];
  if (!threads.some(function (thread) {
    return thread.sessionId === state.rootSessionId;
  })) {
    threads.unshift({
      sessionId: state.rootSessionId,
      preview: state.rootSessionPreview,
      status: state.wsRunning ? 'running' : 'completed',
      threadKind: 'main',
      canSend: true,
      runtime: state.appState.runtime,
    });
  }
  state.sessionThreads = threads;
  rememberSessionThreads(rootSessionId, threads);
  var active = activeSessionThread();
  state.activeThreadCanSend = active ? active.canSend !== false : true;
  applyThreadInputState();
  updateBreadcrumb();
  var modal = document.getElementById('agentThreadsModal');
  if (modal && modal.classList.contains('open')) renderAgentThreadsModal();
  updateSendBtn();
  return threads;
}

function updateAgentThreadsMainButton() {
  var mainButton = document.getElementById('agentThreadsMain');
  if (!mainButton) return;
  var isMain = state.activeThreadId === state.rootSessionId;
  mainButton.dataset.sessionId = state.rootSessionId || '';
  mainButton.textContent = 'Main Session';
  mainButton.setAttribute('aria-current', isMain ? 'true' : 'false');
  mainButton.setAttribute(
    'aria-label',
    isMain ? 'Close agent list; currently viewing main session' : 'Return to main session',
  );
  mainButton.title = isMain ? 'Close agent list' : 'Return to main session';
}

function renderAgentThreadsModal() {
  var list = document.getElementById('agentThreadsList');
  if (!list) return;
  updateAgentThreadsMainButton();
  var byId = new Map(state.sessionThreads.map(function (thread) {
    return [thread.sessionId, thread];
  }));
  var childrenByParent = new Map();
  state.sessionThreads.forEach(function (thread) {
    if (thread.sessionId === state.rootSessionId) return;
    var parentId = byId.has(thread.parentSessionId)
      ? thread.parentSessionId
      : state.rootSessionId;
    var children = childrenByParent.get(parentId) || [];
    children.push(thread);
    childrenByParent.set(parentId, children);
  });

  function connectorHtml(depth, ancestorOpen, isLast, hasChildren) {
    if (!depth && !hasChildren) return '';
    var parts = [];
    ancestorOpen.forEach(function (open, index) {
      if (!open) return;
      var left = -((depth - index - 1) * 24) - 12;
      parts.push('<i class="agent-thread-rail" style="left:' + left + 'px"></i>');
    });
    if (depth) {
      parts.push('<i class="agent-thread-rail current'
        + (isLast ? ' last' : '') + '"></i>');
      parts.push('<i class="agent-thread-elbow"></i>');
    }
    if (hasChildren) parts.push('<i class="agent-thread-child-stem"></i>');
    return '<span class="agent-thread-connectors" aria-hidden="true">'
      + parts.join('') + '</span>';
  }

  function rowHtml(thread, depth, ancestorOpen, isLast, hasChildren) {
    var isMain = thread.sessionId === state.rootSessionId;
    var nickname = String(thread.agentName || '').trim();
    var role = String(thread.agentRole || '').trim();
    var identity = '';
    if (nickname && role) identity = nickname + ' [' + role + ']';
    else if (nickname) identity = nickname;
    else if (role) identity = '[' + role + ']';
    else identity = 'Agent';
    var pathName = String(thread.agentPath || '').split('/').filter(Boolean).pop() || '';
    pathName = pathName.replace(/[_-]+/g, ' ');
    var name = thread.preview || state.rootSessionPreview || 'Main';
    if (!isMain) {
      var inheritedPreview = thread.preview === state.rootSessionPreview;
      name = (!inheritedPreview && thread.preview) || pathName || identity;
    }
    var metaParts = [];
    if (!isMain && identity && identity !== name) metaParts.push(identity);
    if (!isMain) {
      metaParts.push(agentThreadShortId(thread));
    }
    if (Number.isFinite(Number(thread.size))) {
      metaParts.push(formatSize(Number(thread.size)));
    } else if (isMain) {
      metaParts.push(shortSessionId(
        thread.sessionId,
        thread.nativeSessionId,
        thread.runtime || state.appState.runtime,
      ));
    }
    var selected = thread.sessionId === state.activeThreadId;
    var indent = isMain ? 0 : Math.min(4, Math.max(0, depth));
    return '<button class="agent-thread-row' + (selected ? ' selected' : '') + '"'
      + ' type="button" data-session-id="' + esc(thread.sessionId) + '"'
      + ' style="--agent-indent:' + indent + '"'
      + ' onclick="switchAgentThread(this.dataset.sessionId)">'
      + connectorHtml(indent, ancestorOpen.slice(0, indent - 1), isLast, hasChildren)
      + '<span class="agent-thread-copy"><span class="agent-thread-title">'
      + '<strong>' + esc(name) + '</strong>'
      + '<span class="badge ' + statusClass(thread.status) + '">'
      + esc(statusLabel(thread.status)) + '</span></span>'
      + '<span class="agent-thread-meta"><small>' + esc(metaParts.join(' · ')) + '</small>'
      + (thread.lastActive ? '<time>' + esc(timeAgo(thread.lastActive)) + '</time>' : '')
      + '</span>'
      + '</span></button>';
  }

  function childHtml(parentId, ancestorOpen, depth) {
    var children = childrenByParent.get(parentId) || [];
    return children.map(function (thread, index) {
      var isLast = index === children.length - 1;
      var grandchildren = childrenByParent.get(thread.sessionId) || [];
      return rowHtml(thread, depth, ancestorOpen, isLast, grandchildren.length > 0)
        + childHtml(
          thread.sessionId,
          depth === 0 ? [] : ancestorOpen.concat(!isLast),
          depth + 1,
        );
    }).join('');
  }

  var root = byId.get(state.rootSessionId) || state.sessionThreads[0];
  if (!root) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = childHtml(root.sessionId, [], 0);
}

function renderAgentThreadsSkeleton() {
  var list = document.getElementById('agentThreadsList');
  if (!list) return;
  list.innerHTML = Array.from({ length: 3 }, function () {
    return '<div class="agent-thread-row agent-thread-skeleton">'
      + '<span class="agent-thread-copy">'
      + '<span class="agent-thread-title"><i class="skel agent-thread-skel-name"></i>'
      + '<i class="skel agent-thread-skel-status"></i></span>'
      + '<span class="agent-thread-meta"><i class="skel agent-thread-skel-detail"></i>'
      + '<i class="skel agent-thread-skel-time"></i></span></span></div>';
  }).join('');
}

async function openAgentThreadsModal() {
  var modal = document.getElementById('agentThreadsModal');
  if (!modal) return;
  var rootSessionId = state.rootSessionId;
  updateAgentThreadsMainButton();
  modal.style.display = 'flex';
  modal.classList.remove('open');
  void modal.offsetWidth;
  modal.classList.add('open');
  if (state.sessionThreads.length > 1) renderAgentThreadsModal();
  else renderAgentThreadsSkeleton();
  try {
    await refreshSessionThreads();
  } catch (error) {
    if (rootSessionId !== state.rootSessionId) return;
    var list = document.getElementById('agentThreadsList');
    if (list && state.sessionThreads.length <= 1) {
      list.innerHTML = '<div class="agent-thread-empty">Unable to load agents</div>';
    }
    return;
  }
  if (rootSessionId !== state.rootSessionId
    || !modal.classList.contains('open')) return;
  renderAgentThreadsModal();
}

function closeAgentThreadsModal() {
  var modal = document.getElementById('agentThreadsModal');
  if (!modal) return;
  modal.classList.remove('open');
  var box = modal.querySelector('.agent-threads-box');
  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!box || reduceMotion) {
    modal.style.display = 'none';
    return;
  }
  var settled = false;
  var fallbackTimer = 0;
  function finishClose(event) {
    if (settled) return;
    if (event && (event.target !== box || event.propertyName !== 'transform')) return;
    settled = true;
    clearTimeout(fallbackTimer);
    box.removeEventListener('transitionend', finishClose);
    if (!modal.classList.contains('open')) modal.style.display = 'none';
  }
  box.addEventListener('transitionend', finishClose);
  fallbackTimer = setTimeout(finishClose, 320);
}

function switchAgentThread(sessionId) {
  var thread = state.sessionThreads.find(function (candidate) {
    return candidate.sessionId === sessionId;
  });
  if (!thread || sessionId === state.activeThreadId) {
    closeAgentThreadsModal();
    return;
  }
  closeAgentThreadsModal();
  loadMessages(sessionId, thread.preview || thread.agentName || '', {
    rootSessionId: state.rootSessionId,
    rootSessionPreview: state.rootSessionPreview,
    preserveThreads: true,
    canSend: thread.canSend !== false,
  });
}

function showInputBar(visible) {
  var bar = document.getElementById('input-bar');
  bar.style.display = visible ? 'flex' : 'none';
  if (visible) {
    applyThreadInputState();
    if (typeof initVoiceButton === 'function') initVoiceButton();
  }
  if (!visible) {
    if (typeof dismissPermissionPrompt === 'function') dismissPermissionPrompt();
    if (typeof window.closeSlashPopup === 'function') window.closeSlashPopup();
    document.getElementById('scroll-bottom-btn').classList.remove('visible');
    document.body.classList.remove('new-session');
    // Restore input-bar to body if it was moved into #content
    if (bar.parentElement !== document.body) document.body.appendChild(bar);
    state.wsRunning = false;
    updateSpinner();
  }
}

function applyThreadInputState() {
  var bar = document.getElementById('input-bar');
  var input = document.getElementById('msg-input');
  if (!bar || !input) return;
  var blocked = !state.activeThreadCanSend;
  bar.toggleAttribute('inert', blocked);
  bar.setAttribute('aria-disabled', String(blocked));
  input.readOnly = blocked;
  input.placeholder = blocked ? 'Subagent is read-only' : 'Send a message...';
  if (blocked) {
    input.value = '';
    input.style.height = 'auto';
  }
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

function resetSessionThreads() {
  closeAgentThreadsModal();
  state.threadRequestVersion++;
  state.rootSessionId = null;
  state.rootSessionPreview = '';
  state.activeThreadId = null;
  state.activeThreadCanSend = true;
  state.sessionThreads = [];
  var list = document.getElementById('agentThreadsList');
  if (list) list.innerHTML = '';
}

function saveNav() {
  sessionStorage.setItem('baton-nav', JSON.stringify(state.appState));
}

function navigateUp() {
  if (state.selectMode) { exitSelectMode(); return true; }

  var active = document.activeElement;
  if (active && typeof active.blur === 'function') active.blur();

  var previous = takePreviousNavigation();
  if (previous) {
    if (previous.session && previous.device && previous.project) {
      state.appState = previous;
      loadMessages(previous.session, previous.sessionPreview);
    } else if (previous.project && previous.device) {
      loadSessions(previous.device, previous.project.hash, previous.project.name);
    } else if (previous.device) {
      loadProjects(previous.device);
    } else {
      loadDevices();
    }
    return true;
  }

  var device = state.appState.device;
  var project = state.appState.project;
  if (state.appState.session && device && project) {
    loadSessions(device, project.hash, project.name);
    return true;
  }
  if (project && device) {
    loadProjects(device);
    return true;
  }
  if (device) {
    loadDevices();
    return true;
  }
  return false;
}

function projectListOptions(device) {
  return {
    key: 'projects:' + device,
    itemsKey: 'projects',
    idKey: 'projectHash',
    skeleton: '<div class="list">' + skeletonItems(4, 'project') + '</div>',
    html: function (data) { return projectsHtml(device, data, false); },
    render: function (data) { renderProjects(device, data); },
    fetchPage: function (cursor) {
      var params = { device: device, limit: LIST_PAGE_SIZE };
      if (cursor) params.cursor = cursor;
      return api('/api/bridge/projects', params);
    }
  };
}

function sessionListOptions(device, projectHash) {
  return {
    key: 'sessions:' + device + ':' + projectHash,
    itemsKey: 'sessions',
    idKey: 'sessionId',
    skeleton: '<div class="list">' + skeletonItems(5, 'session') + '</div>',
    html: function (data) { return sessionsHtml(device, projectHash, data, false); },
    render: function (data) { renderSessions(device, projectHash, data); },
    fetchPage: function (cursor) {
      var params = { device: device, project: projectHash, limit: LIST_PAGE_SIZE };
      if (cursor) params.cursor = cursor;
      return api('/api/bridge/sessions', params);
    }
  };
}

function listData(options, items) {
  var data = {};
  data[options.itemsKey] = items;
  return data;
}

function listTarget(targetState) {
  if (!targetState) {
    if (state.appState.session && state.appState.project) {
      targetState = {
        device: state.appState.device,
        project: state.appState.project,
        session: null
      };
    } else if (state.appState.project) {
      targetState = { device: state.appState.device, project: null, session: null };
    }
  }
  if (!targetState || !targetState.device) return null;
  if (!targetState.project) {
    return Object.assign({ state: targetState }, projectListOptions(targetState.device));
  }
  if (!targetState.session) {
    return Object.assign(
      { state: targetState },
      sessionListOptions(targetState.device, targetState.project.hash)
    );
  }
  return null;
}

function preloadListTarget(target) {
  var memory = target && _listPages.peek(target.key);
  if (!target || (memory && memory.loaded) || readListCache(target.key) || _listPrefetches[target.key]) return;
  _listPrefetches[target.key] = target.fetchPage(null).then(function (data) {
    writeListCache(target.key, data);
    return data;
  }).catch(function () {
    return null;
  });
}

function previewBreadcrumb(targetState) {
  var parts = [];
  if (targetState.device) {
    parts.push('<a>' + esc(targetState.device) + '</a>');
  }
  if (targetState.project) {
    parts.push('<a>' + esc(targetState.project.name) + '</a>');
  }
  return '<div class="breadcrumb-nav">'
    + parts.join('<span class="breadcrumb-sep">/</span>')
    + '</div>';
}

function prepareNavigationPreview(targetState) {
  var target = listTarget(targetState);
  if (!target) return null;

  var memory = _listPages.peek(target.key);
  var cached = memory && memory.loaded
    ? listData(target, memory.items)
    : readListCache(target.key);
  preloadListTarget(target);
  var topBar = document.querySelector('body > .top-bar');
  if (!topBar) return null;

  return {
    topBarHtml: topBar.innerHTML,
    breadcrumbHtml: previewBreadcrumb(target.state),
    breadcrumbDisplay: 'flex',
    contentHtml: cached ? target.html(cached) : target.skeleton,
    scrollTop: memory && memory.loaded ? memory.scrollTop : 0
  };
}

attachEdgeBackGesture(navigateUp, prepareNavigationPreview);
document.addEventListener('click', function (e) {
  if (e.target.closest('a[href="setup.html"]')) savePagePreview();
}, true);

migrateLegacyListCache();

function captureListAnchor(content) {
  var top = content.getBoundingClientRect().top;
  var items = content.querySelectorAll('.list > .item[data-id]');
  for (var i = 0; i < items.length; i++) {
    var rect = items[i].getBoundingClientRect();
    if (rect.bottom >= top) {
      return { id: items[i].getAttribute('data-id'), offset: rect.top - top };
    }
  }
  return null;
}

function restoreListPosition(content, scrollTop, anchor) {
  content.scrollTop = scrollTop || 0;
  if (!anchor) return;
  var items = content.querySelectorAll('.list > .item[data-id]');
  for (var i = 0; i < items.length; i++) {
    if (items[i].getAttribute('data-id') !== anchor.id) continue;
    var top = content.getBoundingClientRect().top;
    content.scrollTop += items[i].getBoundingClientRect().top - top - anchor.offset;
    return;
  }
}

function renderListEntry(options, entry, scrollTop, anchor) {
  var content = document.getElementById('content');
  options.render(listData(options, entry.items));
  restoreListPosition(content, scrollTop, anchor);
  entry.scrollTop = content.scrollTop;
}

function setListLoading(loading) {
  var content = document.getElementById('content');
  content.classList.toggle('list-loading', loading);
  var existing = content.querySelector('.loading-more');
  if (!loading) {
    if (existing) existing.remove();
    return;
  }
  if (!existing && content.querySelector('.list')) {
    content.insertAdjacentHTML('beforeend', '<div class="loading-more"><span class="spinner"></span></div>');
  }
}

function rememberActiveListScroll() {
  if (!_activeListKey) return;
  var content = document.getElementById('content');
  _listPages.rememberScroll(_activeListKey, content.scrollTop);
}

function deactivateList() {
  rememberActiveListScroll();
  detachLongPress(document.getElementById('content'));
  _activeListKey = null;
  _activeListOptions = null;
}

function invalidatePagedList(key) {
  invalidateListCache(key);
  _listPages.invalidate(key);
  delete _listPrefetches[key];
}

function isCurrentList(options, navVersion, requestId) {
  var entry = _listPages.peek(options.key);
  return _navVersion === navVersion
    && _activeListKey === options.key
    && entry
    && entry.requestId === requestId;
}

function isLatestListRequest(options, requestId) {
  var entry = _listPages.peek(options.key);
  return entry && entry.requestId === requestId;
}

async function loadPagedList(options, navVersion) {
  var content = document.getElementById('content');
  var entry = _listPages.get(options.key);
  var hadMemory = entry.loaded;
  var cached = hadMemory ? null : readListCache(options.key);
  var previousOrder = hadMemory
    ? entry.items.slice(0, LIST_PAGE_SIZE).map(function (item) { return item[options.idKey]; })
    : null;
  _activeListKey = options.key;
  _activeListOptions = options;

  if (window.__setTopSync) window.__setTopSync(true);
  if (hadMemory) {
    renderListEntry(options, entry, entry.scrollTop, null);
  } else if (cached) {
    entry = _listPages.applyFirst(options.key, cached, options.itemsKey, options.idKey, false);
    renderListEntry(options, entry, 0, null);
  } else {
    detachLongPress(content);
    content.innerHTML = options.skeleton;
    content.scrollTop = 0;
  }

  var requestId = _listPages.begin(options.key, true);
  var refreshed = false;
  try {
    var prefetched = _listPrefetches[options.key];
    delete _listPrefetches[options.key];
    var fresh = prefetched ? await prefetched : await options.fetchPage(null);
    if (!fresh) fresh = await options.fetchPage(null);
    if (isLatestListRequest(options, requestId)) writeListCache(options.key, fresh);
    if (!isCurrentList(options, navVersion, requestId)) return;
    await waitForListPointer();
    if (!isCurrentList(options, navVersion, requestId)) return;

    var anchor = hadMemory ? captureListAnchor(content) : null;
    var keepScroll = content.scrollTop;
    var preserveLoaded = hadMemory && entry.items.length > LIST_PAGE_SIZE;
    entry = _listPages.applyFirst(
      options.key, fresh, options.itemsKey, options.idKey, preserveLoaded
    );
    var orderChanged = previousOrder && previousOrder.some(function (id, index) {
      return !entry.items[index] || entry.items[index][options.idKey] !== id;
    });
    renderListEntry(options, entry, orderChanged ? 0 : keepScroll, orderChanged ? null : anchor);
    refreshed = true;
  } catch (e) {
    if (_navVersion === navVersion && _activeListKey === options.key && !entry.loaded) {
      content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
    }
  } finally {
    var stillCurrent = isCurrentList(options, navVersion, requestId);
    _listPages.finish(options.key, requestId);
    if (stillCurrent) {
      if (window.__setTopSync) window.__setTopSync(false);
      if (refreshed) maybeLoadNextListPage();
    }
  }
}

async function loadNextListPage() {
  var options = _activeListOptions;
  if (!options) return;
  var entry = _listPages.peek(options.key);
  if (!entry || !entry.loaded || !entry.hasMore || !entry.nextCursor) return;
  var requestId = _listPages.begin(options.key, false);
  if (requestId === null) return;

  var navVersion = _navVersion;
  var cursor = entry.nextCursor;
  var appended = false;
  setListLoading(true);
  try {
    var page = await options.fetchPage(cursor);
    if (!isCurrentList(options, navVersion, requestId)) return;
    await waitForListPointer();
    if (!isCurrentList(options, navVersion, requestId)) return;
    var content = document.getElementById('content');
    var keepScroll = content.scrollTop;
    entry = _listPages.append(options.key, page, options.itemsKey, options.idKey);
    renderListEntry(options, entry, keepScroll, null);
    appended = true;
  } catch (e) {
    // Keep the loaded pages; the next scroll retries this cursor.
  } finally {
    var stillCurrent = isCurrentList(options, navVersion, requestId);
    _listPages.finish(options.key, requestId);
    if (stillCurrent) {
      setListLoading(false);
      if (appended) maybeLoadNextListPage();
    }
  }
}

function maybeLoadNextListPage() {
  if (!_activeListOptions || state.appState.session) return;
  var content = document.getElementById('content');
  var distance = content.scrollHeight - content.scrollTop - content.clientHeight;
  if (distance < LIST_PRELOAD_PX) loadNextListPage();
}

function toggleActiveSessions() {
  var grid = document.getElementById('active-section');
  var title = grid && grid.previousElementSibling;
  if (!grid) return;
  var show = grid.style.display === 'none';
  grid.style.display = show ? '' : 'none';
  if (title) title.classList.toggle('expanded', show);
  sessionStorage.setItem('apeek_activeCollapsed', show ? '0' : '1');
}

function toggleRecentAgents() {
  var grid = document.getElementById('recent-agents-grid');
  var title = grid && grid.previousElementSibling;
  if (!grid) return;
  var show = grid.style.display === 'none';
  grid.style.display = show ? '' : 'none';
  if (title) title.classList.toggle('expanded', show);
  localStorage.setItem('apeek_raCollapsed', show ? '0' : '1');
}

// ---- Active session card click ----
function openActiveSession(el) {
  var d = el.dataset;
  state.appState = {
    device: d.device,
    project: { hash: d.phash, name: d.pname },
    session: null,
    sessionPreview: '',
    isAgent: d.isagent === 'true',
    runtime: sessionRuntime(d.sid, d.runtime)
  };
  loadMessages(d.sid, d.preview);
}

function openSession(el) {
  state.appState.isAgent = el.dataset.isagent === 'true';
  state.appState.runtime = sessionRuntime(el.dataset.sid, el.dataset.runtime);
  loadMessages(el.dataset.sid, el.dataset.preview);
}

function shortModel(m) {
  return (m || 'unknown').replace(/^claude-/, '');
}

// ---- Devices ----
function rememberDevices(data) {
  (data?.devices || []).forEach(function (device) {
    state.deviceOnlineMap[device.deviceName] = device.online;
    state.deviceDisplayNameMap[device.deviceName] = device.deviceDisplayName || device.deviceName;
    state.deviceRuntimeCapabilities[device.deviceName] = device.runtimeCapabilities || {
      claude: { canCreate: true },
    };
  });
  window.__deviceDisplayNames = state.deviceDisplayNameMap;
}

async function loadDevices() {
  resetSessionThreads();
  deactivateList();
  var wasHome = !state.appState.device && !state.appState.project && !state.appState.session;
  prepareNavigation({ device: null, project: null, session: null });
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: null, project: null, session: null, sessionPreview: '' };
  markCurrentRoute(state.appState);
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  if (window.__homeLoadPromise) document.getElementById('top-right').classList.add('syncing');
  saveNav();

  // The inline shell starts the cold-load run before app.js arrives. Reuse it
  // instead of launching a second request/render pipeline.
  if (window.__homeLoadPromise && wasHome) {
    window.__preload = null;
    return window.__homeLoadPromise.then(function (fresh) {
      if (_navVersion !== myNav || !fresh || !fresh[1]) return;
      rememberDevices(fresh[1]);
    });
  }

  var preload = window.__preload;
  if (preload) window.__preload = null;
  var activePromise = (preload && preload.active) || api('/api/bridge/active-sessions');
  var devicesPromise = (preload && preload.devices) || api('/api/bridge/devices');
  return window.__loadHome(activePromise, devicesPromise, {
    resetScroll: true,
    onFresh: function (_activeData, devData) {
      rememberDevices(devData);
      showStats(devData.devices.length + ' device(s)');
    }
  });
}

function refreshForegroundView() {
  if (document.visibilityState !== 'visible') return Promise.resolve(false);
  if (_foregroundRefresh) return _foregroundRefresh;
  _foregroundRefresh = Promise.resolve().then(function () {
    if (state.appState.session) {
      return typeof window.resumeSessionForeground === 'function'
        ? window.resumeSessionForeground()
        : false;
    }
    if (state.appState.project && state.appState.device) {
      return loadSessions(
        state.appState.device,
        state.appState.project.hash,
        state.appState.project.name,
      );
    }
    if (state.appState.device) return loadProjects(state.appState.device);
    return loadDevices();
  }).finally(function () {
    _foregroundRefresh = null;
  });
  return _foregroundRefresh;
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    _pageWasHidden = true;
    return;
  }
  if (!_pageWasHidden) return;
  _pageWasHidden = false;
  refreshForegroundView();
}

document.addEventListener('visibilitychange', handleVisibilityChange);

// ---- Projects ----
function projectsHtml(device, data, sel) {
  return '<div class="list' + (sel ? ' select-mode' : '') + '">' + data.projects.map(function (p) {
    var rc = p.runningCount || 0, ic = p.needsInputCount || 0;
    var projHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(p.projectHash);
    // Nav onclick always baked; in select mode the capture click handler intercepts + toggles.
    var onclick = 'loadSessions(\'' + esc(device) + '\',\'' + esc(p.projectHash) + '\',\'' + esc(p.projectName) + '\');return false;';
    return '<a class="item project-item" data-id="' + esc(p.projectHash) + '" href="' + projHref + '" onclick="' + onclick + '">'
      + (sel ? selectBox(p.projectHash) : '')
      + '<div class="item-main"><div class="item-top"><span class="title">' + esc(p.projectName) + '</span><span class="item-time">' + timeAgo(p.lastActive) + '</span></div>'
      + '<div class="subtitle">' + esc(p.projectPath) + '</div>'
      + '<div class="item-bottom"><span class="meta-left">' + p.sessionCount + ' sessions</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' needs input</span></div></div>'
      + '</a>';
  }).join('') + '</div>';
}

function renderProjects(device, data) {
  var content = document.getElementById('content');
  var sel = state.selectMode && state.selectType === 'project';
  detachLongPress(content);
  content.innerHTML = projectsHtml(device, data, sel);
  attachLongPress(content, 'project');
  showStats(data.projects.length + ' project(s)');
}

async function loadProjects(device) {
  resetSessionThreads();
  rememberActiveListScroll();
  document.body.classList.add('browse-view');
  var restoreLoadedPages = state.appState.device === device && !!state.appState.project;
  var options = projectListOptions(device);
  if (!restoreLoadedPages) _listPages.invalidate(options.key);
  prepareNavigation({ device: device, project: null, session: null });
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: device, project: null, session: null, sessionPreview: '' };
  markCurrentRoute(state.appState);
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  return loadPagedList(options, myNav);
}

// ---- Sessions ----
function sessionsHtml(device, projectHash, data, sel) {
  if (!data.sessions.length) {
    return '<div class="empty">No sessions yet<br><br>'
      + '<button class="modal-btn cancel" onclick="startNewSession(\'' + esc(projectHash) + '\')">Start a session</button></div>';
  }
  return '<div class="list' + (sel ? ' select-mode' : '') + '">'
    + data.sessions.map(function (s) {
    var sessionHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(projectHash) + '/' + s.sessionId;
    var agentCount = Math.max(0, Number(s.agentCount) || 0);
    var agentBadge = s.isAgent && !agentCount ? '<span class="badge agent">Agent</span>' : '';
    var childAgentsBadge = agentCount
      ? '<span class="badge agent">' + agentCount + ' agent' + (agentCount === 1 ? '' : 's') + '</span>'
      : '';
    var displayStatus = s.activeStatus || s.status;
    var sLabel = statusLabel(displayStatus);
    var sClass = statusClass(displayStatus);
    var statusBadge = '<span class="badge ' + sClass + '">' + sLabel + '</span>';
    var runtime = sessionRuntime(s.sessionId, s.runtime);
    var nativeId = nativeSessionId(s.sessionId, s.nativeSessionId, runtime);
    var shortId = shortSessionId(s.sessionId, s.nativeSessionId, runtime);
    var title = s.isAgent && s.agentName ? s.agentName : (s.preview || 'No preview');
    var metadata = '<span>' + esc(s.model || 'unknown model') + '</span>'
      + '<span class="meta-sid" title="' + esc(nativeId) + '"> &middot; ' + esc(shortId) + '</span>'
      + '<span> &middot; ' + formatSize(s.size) + '</span>';
    var secondary = s.status === 'needs_input' && s.agentDetail
      ? '<span class="session-secondary-toggle" role="button" tabindex="0" aria-label="Show session metadata">'
        + '<span class="session-secondary-view session-detail-view">' + esc(s.agentDetail) + '</span>'
        + '<span class="session-secondary-view session-meta-view">' + metadata + '</span></span>'
      : '<span class="session-secondary-static">' + metadata + '</span>';
    // Nav onclick always baked; in select mode the capture click handler intercepts + toggles.
    var onclick = 'if(window.getSelection().toString())return false;openSession(this);return false;';
    return '<a class="item session-item" data-id="' + esc(s.sessionId) + '" href="' + sessionHref + '" data-sid="' + esc(s.sessionId) + '" data-preview="' + esc(s.preview || '') + '" data-runtime="' + runtime + '" data-isagent="' + (s.isAgent ? 'true' : '') + '" onclick="' + onclick + '">'
      + (sel ? selectBox(s.sessionId) : '')
      + '<div class="item-main"><div class="item-top"><span class="title">' + esc(title) + '</span>'
      + '<span class="session-badges">' + agentBadge + childAgentsBadge + statusBadge + runtimeIcon(s.sessionId, runtime) + '</span></div>'
      + '<div class="item-bottom session-item-bottom"><span class="session-secondary-slot">' + secondary + '</span>'
      + '<span class="item-time">' + timeAgo(s.lastActive) + '</span></div></div>'
      + '</a>';
  }).join('') + '</div>';
}

function attachSessionSecondaryToggles(container) {
  container.querySelectorAll('.session-secondary-toggle').forEach(function (target) {
    function toggle(event) {
      event.preventDefault();
      event.stopPropagation();
      var showingMetadata = target.classList.toggle('show-meta');
      target.setAttribute('aria-label', showingMetadata ? 'Show pending request' : 'Show session metadata');
    }

    target.addEventListener('click', toggle);
    target.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') toggle(event);
    });
  });
}

function renderSessions(device, projectHash, data) {
  var content = document.getElementById('content');
  var sel = state.selectMode && state.selectType === 'session';
  detachLongPress(content);
  content.innerHTML = sessionsHtml(device, projectHash, data, sel);
  if (!data.sessions.length) {
    showStats('0 session(s)');
    return;
  }
  var list = content.querySelector('.list');
  attachSessionSecondaryToggles(list);
  attachLongPress(content, 'session');
  showStats(data.sessions.length + ' session(s)');
}

async function loadSessions(device, projectHash, projectName) {
  resetSessionThreads();
  rememberActiveListScroll();
  document.body.classList.add('browse-view');
  var restoreLoadedPages = state.appState.device === device
    && !!state.appState.session
    && !!state.appState.project
    && state.appState.project.hash === projectHash;
  var options = sessionListOptions(device, projectHash);
  if (!restoreLoadedPages) _listPages.invalidate(options.key);
  prepareNavigation({
    device: device,
    project: { hash: projectHash, name: projectName || projectHash },
    session: null
  });
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: device, project: { hash: projectHash, name: projectName || projectHash }, session: null, sessionPreview: '' };
  markCurrentRoute(state.appState);
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  return loadPagedList(options, myNav);
}

function createNewProject() {
  var modal = document.getElementById('newProjectModal');
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  // Prefill last-used parent prefix so the user only types the new project name (still editable).
  input.value = localStorage.getItem('_np_prefix') || '';
  err.textContent = '';
  modal.style.display = 'flex';
  setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 100);
}

function closeNewProjectModal() {
  if (state._pendingCreatePath) {
    state._pendingCreatePath = null;
    disconnectWs();
  }
  var modal = document.getElementById('newProjectModal');
  modal.style.display = 'none';
  var input = document.getElementById('newProjectInput');
  var btn = modal.querySelector('.modal-btn.confirm');
  if (input) input.disabled = false;
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Create'; }
}

async function submitNewProject() {
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
  var projectPath = input.value.trim();
  if (!projectPath) { err.textContent = 'Path cannot be empty'; return; }
  err.textContent = '';
  // Remember the parent prefix (everything up to the last '/') to prefill next time.
  var slash = projectPath.lastIndexOf('/');
  localStorage.setItem('_np_prefix', slash >= 0 ? projectPath.slice(0, slash + 1) : '');
  state._pendingCreatePath = projectPath;
  // Loading state: disable inputs, show spinner on button
  input.disabled = true;
  btn.disabled = true;
  btn.dataset.origText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Creating';
  await window.loadViewerLibs();
  ensureWsAndSend({ action: 'create_project', projectPath: projectPath, device: state.appState.device || '' });
}

var _deleteCountdownTimer = null;

function openDeleteModal() {
  if (!state.selected.size) return;
  var modal = document.getElementById('deleteModal');
  var n = state.selected.size;
  var isProject = state.selectType === 'project';
  var noun = (isProject ? 'project' : 'session') + (n > 1 ? 's' : '');
  document.getElementById('deleteModalTitle').textContent = 'Delete ' + n + ' ' + noun + '?';
  document.getElementById('deleteModalDesc').textContent = isProject
    ? 'This removes ' + (n > 1 ? 'these projects' : 'this project') + ' and all their session records from the list. Data on the device is kept unless you check below.'
    : 'This removes ' + (n > 1 ? 'these sessions' : 'this session') + ' from the list. Data on the device is kept unless you check below.';
  document.getElementById('deleteFilesCb').checked = false;
  var err = document.getElementById('deleteError'); if (err) err.textContent = '';
  resetDeleteBtn();
  modal.style.display = 'flex';
}

function resetDeleteBtn() {
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  var btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = false; btn.textContent = 'Delete';
}

// Checking "delete original data" arms a 5s countdown before Delete is clickable (guards misfires).
function onDeleteFilesToggle() {
  var btn = document.getElementById('deleteConfirmBtn');
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  if (!document.getElementById('deleteFilesCb').checked) { btn.disabled = false; btn.textContent = 'Delete'; return; }
  var left = 5;
  btn.disabled = true; btn.textContent = 'Delete (' + left + ')';
  _deleteCountdownTimer = setInterval(function () {
    left--;
    if (left <= 0) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; btn.disabled = false; btn.textContent = 'Delete'; }
    else btn.textContent = 'Delete (' + left + ')';
  }, 1000);
}

function closeDeleteModal() {
  resetDeleteBtn();
  document.getElementById('deleteModal').style.display = 'none';
}

// Single delete entry point: ① delete DDB rows (REST, authoritative) then, if opted
// in, ② ask the bridge to delete on-disk jsonl and await its result. Returns the
// combined { ddb, files } outcome so the caller has the final status in one place.
async function performDelete(device, isProject, ids, deleteFiles) {
  var body = { deviceName: device };
  if (isProject) body.projectHashes = ids; else body.sessionIds = ids;
  await apiPost('/api/bridge/delete', body);
  var filesResult = null;
  if (deleteFiles) {
    await window.loadViewerLibs(); // ensure WS is connected before relying on it
    filesResult = await new Promise(function (resolve) {
      var reqId = 'del-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      window._deleteFilesResolvers = window._deleteFilesResolvers || {};
      var done = false;
      var finish = function (r) { if (done) return; done = true; delete window._deleteFilesResolvers[reqId]; resolve(r); };
      window._deleteFilesResolvers[reqId] = finish;
      ensureWsAndSend(Object.assign({ action: 'delete_files', device: device, requestId: reqId }, isProject ? { projectHashes: ids } : { sessionIds: ids }));
      setTimeout(function () { finish({ ok: false, timeout: true }); }, 8000);
    });
  }
  return { ddb: true, files: filesResult };
}

async function submitDelete() {
  var ids = Array.from(state.selected);
  if (!ids.length) return;
  var device = state.appState.device || '';
  var deleteFiles = !!document.getElementById('deleteFilesCb').checked;
  var isProject = state.selectType === 'project';
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  var btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = true; btn.dataset.origText = 'Delete'; btn.innerHTML = '<span class="spinner"></span>Deleting';
  var result;
  try {
    result = await performDelete(device, isProject, ids, deleteFiles);
  } catch (e) {
    var err = document.getElementById('deleteError'); if (err) err.textContent = 'Delete failed: ' + e.message;
    btn.disabled = false; btn.textContent = 'Delete';
    return;
  }
  closeDeleteModal();
  if (isProject) {
    invalidatePagedList('projects:' + device);
    ids.forEach(function (projectHash) {
      invalidatePagedList('sessions:' + device + ':' + projectHash);
    });
    loadProjects(device);
  } else {
    invalidatePagedList('sessions:' + state.appState.device + ':' + state.appState.project.hash);
    loadSessions(state.appState.device, state.appState.project.hash, state.appState.project.name);
  }
  // DDB rows are gone (list already refreshed); warn if the bridge never confirmed the disk delete.
  if (deleteFiles && result.files && result.files.timeout) {
    showStats('Removed from list; device did not confirm file deletion (bridge offline?)');
  }
}

// New-session hero agent checkbox toggled — reflect in breadcrumb + send button.
function onNewAsAgentToggle(checked) {
  state.appState.isAgent = checked;
  updateBreadcrumb();
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

function applyNewSessionRuntime(runtime, remember) {
  if (!runtime || !state.newSessionRuntimes.includes(runtime)) return;
  state.appState.runtime = runtime;
  if (remember) {
    try {
      localStorage.setItem(
        newSessionRuntimePreferenceKey(state.appState.device),
        runtime,
      );
    } catch (e) {}
  }
  var agent = document.getElementById('newAsAgent');
  var agentToggle = document.getElementById('newAgentToggle');
  if (runtime !== 'claude') {
    state.appState.isAgent = false;
    if (agent) agent.checked = false;
  }
  if (agentToggle) agentToggle.hidden = runtime !== 'claude';
  var messages = document.querySelector('.messages');
  if (messages) messages.className = 'messages runtime-' + runtime;
  updateBreadcrumb();
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

function toggleNewSessionRuntime() {
  if (state.appState.session !== '__new__') return;
  applyNewSessionRuntime(
    nextNewSessionRuntime(state.newSessionRuntimes, state.appState.runtime),
    true,
  );
}

async function startNewSession(projectHash) {
  resetSessionThreads();
  deactivateList();
  document.body.classList.remove('browse-view');
  // A touch-scroll from the previous session can keep dispatching after the
  // route changes. Mark the new-session route before the async viewer load so
  // those stale events cannot re-show the session-only scroll indicator.
  state.appState.session = '__new__';
  state.stickBottom = true;
  document.getElementById('scroll-bottom-btn').classList.remove('visible');
  var myNav = ++_navVersion;
  prepareNavigation({
    device: state.appState.device,
    project: state.appState.project,
    session: '__new__'
  });
  await window.loadViewerLibs();
  if (_navVersion !== myNav) return;
  var runtimes = creatableRuntimes();
  state.newSessionRuntimes = runtimes;
  var savedRuntime = '';
  try {
    savedRuntime = localStorage.getItem(
      newSessionRuntimePreferenceKey(state.appState.device),
    ) || '';
  } catch (e) {}
  var runtime = preferredNewSessionRuntime(runtimes, savedRuntime);
  // Clear a prior session's permission prompt so its disabled input doesn't carry over.
  if (typeof dismissPermissionPrompt === 'function') dismissPermissionPrompt();
  state.appState.sessionPreview = 'New Session';
  state.appState.runtime = runtime || 'claude';
  markCurrentRoute(state.appState);
  // Reset tier — else a prior session's ai-title tier (3) blocks this session's first-prompt fallback (tier 1).
  state._titleTier = 0;
  state.appState.isAgent = false;
  updateBreadcrumb();
  saveNav();
  // Reset WS message state for new session
  state.wsAllMessages = [];
  state.wsMessageUuids = new Set();
  state.wsMessageCount = 0;
  state.wsRenderedCount = 0;
  state.wsLastTimestamp = '';
  state.wsHasMore = false;
  state.wsOldestTimestamp = '';
  state.wsLoadingOlder = false;
  disconnectWs();
  state.pendingSentMessages = [];
  var content = document.getElementById('content');
  var bar = document.getElementById('input-bar');
  if (bar && bar.parentElement !== document.body) document.body.appendChild(bar);
  if (!runtime) {
    content.innerHTML = '<div class="empty">Session creation unavailable</div>';
    document.body.classList.remove('new-session');
    showInputBar(false);
    return;
  }
  // Agent mode: always starts unchecked; choice is not persisted across sessions.
  content.innerHTML =
    '<div class="new-session-hero">'
      + '<img class="hero-logo" src="assets/baton-logo.svg" alt="">'
      + '<div class="hero-title">Baton</div>'
      + '<label class="agent-toggle" id="newAgentToggle"' + (runtime === 'claude' ? '' : ' hidden') + '><input type="checkbox" id="newAsAgent" onchange="onNewAsAgentToggle(this.checked)">Claude Agents Run in background</label>'
    + '</div>'
    + '<div class="messages runtime-' + runtime + '" hidden></div>';
  document.body.classList.add('new-session');
  showInputBar(true);
  // Move input-bar into #content so it sits with the hero in centered flex group.
  // Restored to body on first send (see ws.js doSend) or on showInputBar(false).
  if (bar && bar.parentElement !== content) content.appendChild(bar);
  // HTML ships with a stop-icon as #send-btn placeholder; sync to disabled-send for empty input
  if (typeof updateSendBtn === 'function') updateSendBtn();
  connectWs(null, projectHash);
}

// ---- Messages ----
async function loadMessages(sessionId, preview, options) {
  options = options || {};
  var rootSessionId = options.rootSessionId || sessionId;
  var rootSessionPreview = options.rootSessionPreview
    || (rootSessionId === sessionId ? preview : state.rootSessionPreview)
    || '';
  deactivateList();
  document.body.classList.remove('browse-view');
  prepareNavigation({
    device: state.appState.device,
    project: state.appState.project,
    session: rootSessionId
  });
  // Update state + breadcrumb before any await — a fast follow-up nav must not be
  // overwritten when this call resumes.
  document.body.classList.remove('new-session');
  var myNav = ++_navVersion;
  state.rootSessionId = rootSessionId;
  state.rootSessionPreview = rootSessionPreview;
  state.activeThreadId = sessionId;
  state.activeThreadCanSend = options.canSend !== false;
  applyThreadInputState();
  if (!options.preserveThreads) {
    state.threadRequestVersion++;
    state.sessionThreads = cachedSessionThreads(rootSessionId);
    var threadList = document.getElementById('agentThreadsList');
    if (threadList) threadList.innerHTML = '';
    closeAgentThreadsModal();
  }
  state.appState.session = rootSessionId;
  state.appState.sessionPreview = rootSessionPreview;
  state.appState.runtime = sessionRuntime(sessionId, state.appState.runtime);
  markCurrentRoute(state.appState);
  state.stickBottom = true; // open a session pinned to the latest message
  // List preview = bridge's getPreview (custom > ai > lastPrompt > firstUser); treat as ai-title tier floor.
  state._titleTier = preview ? 3 : 0;
  state.wsRunning = false;
  updateBreadcrumb();
  // Skeleton before any await — loadViewerLibs can take a while and the old page would linger.
  var content = document.getElementById('content');
  content.innerHTML = skeletonMessages();
  showInputBar(true);
  await window.loadViewerLibs();
  if (_navVersion !== myNav) return;
  updateSendBtn();

  // 1. Subscribe WS first, then buffer+fetch (shared with reconnect recovery)
  state.wsAllMessages = [];
  state.wsMessageUuids = new Set();
  state.wsMessageCount = 0;
  state.wsLastTimestamp = '';
  state.wsHasMore = false;
  state.wsOldestTimestamp = '';
  state.wsLoadingOlder = false;
  // Switching sessions: drop the prior session's optimistic bubbles + orphan
  // state so they cannot match messages from the newly opened session.
  state.pendingSentMessages = [];
  startWs(sessionId);
  if (!options.preserveThreads) {
    refreshSessionThreads().catch(function () {});
  }

  try {
    var t0 = performance.now();
    var result = await bufferAndFetch(sessionId, '');
    if (_navVersion !== myNav) return;
    var latency = Math.round(performance.now() - t0);
    state.wsRunning = resolveSessionRunningAfterFetch(
      result,
      state.wsAllMessages,
      state.appState.runtime,
    );
    updateSendBtn();

    if (state.wsAllMessages.length === 0) {
      if (result.needSync) {
        var online = state.deviceOnlineMap[state.appState.device] !== false;
        content.innerHTML = online
          ? skeletonMessages()
          : '<div class="empty">Bridge offline — no cached messages</div>';
      } else {
        content.innerHTML = '<div class="messages runtime-' + state.appState.runtime
          + '"><div class="empty">No messages</div></div>';
      }
      showInputBar(true);
      if (typeof revealDeferredPermissionPrompt === 'function') {
        revealDeferredPermissionPrompt();
      }
      saveNav();
      return;
    }

    content.innerHTML = '<div class="messages runtime-' + state.appState.runtime + '"><div class="loading-older' + (state.wsHasMore ? '' : ' exhausted')
      + '">Loading...</div>' + renderMessages(state.wsAllMessages, state.appState.runtime) + '</div>';
    if (window.rebindStrictStreamDom) window.rebindStrictStreamDom();
    if (window.markTurnAdjacency) markTurnAdjacency(content.querySelector('.messages'));
    showInputBar(true);
    if (typeof revealDeferredPermissionPrompt === 'function') {
      revealDeferredPermissionPrompt();
    }
    if (typeof updateSpinner === 'function') updateSpinner();

    updateTitleFromMessages();

    // Clamp before scrolling: clamp shrinks long messages, so scrolling first
    // would leave the viewport above the bottom. rAF re-scroll absorbs any
    // post-clamp reflow before paint (replaces the old visible 500ms jump).
    loadImages(content);
    clampOverflow(content.querySelector('.messages'));
    if (window.renderMermaidBlocks) renderMermaidBlocks(content);
    if (window.renderKatexBlocks) renderKatexBlocks(content);
    content.scrollTop = content.scrollHeight;
    requestAnimationFrame(function () {
      if (_navVersion !== myNav) return;
      content.scrollTop = content.scrollHeight;
    });
    state.wsRenderedCount = state.wsAllMessages.length;
    showStats(state.wsMessageCount + ' messages | ' + latency + 'ms');
  } catch (e) {
    if (_navVersion !== myNav) return;
    state._wsBuffer = null;
    content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
  saveNav();
}

// ---- Scroll-to-bottom ----
function scrollToBottom() {
  var el = document.getElementById('content');
  state.stickBottom = true; // tapping the button re-enables follow-new-content
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

// Keep scroll-to-bottom button 12px above #input-bar regardless of platform/keyboard/safe-area.
function positionScrollBtn() {
  var bar = document.getElementById('input-bar');
  var btn = document.getElementById('scroll-bottom-btn');
  if (!bar || !btn) return;
  if (bar.offsetHeight === 0 || bar.style.display === 'none') { btn.style.bottom = ''; return; }
  btn.style.bottom = (bar.offsetHeight + 12) + 'px';
}
var _scrollBtnPositionTimer = 0;
function scheduleScrollBtnPosition() {
  positionScrollBtn();
  requestAnimationFrame(function () {
    requestAnimationFrame(positionScrollBtn);
  });
  clearTimeout(_scrollBtnPositionTimer);
  _scrollBtnPositionTimer = setTimeout(positionScrollBtn, 420);
}
(function () {
  var bar = document.getElementById('input-bar');
  if (bar && window.ResizeObserver) {
    new ResizeObserver(positionScrollBtn).observe(bar);
  }
  window.addEventListener('resize', scheduleScrollBtnPosition);
  window.addEventListener('orientationchange', scheduleScrollBtnPosition);
  positionScrollBtn();
})();

(function () {
  var btn = document.getElementById('scroll-bottom-btn');
  var content = document.getElementById('content');

  content.addEventListener('scroll', function () {
    if (!state.appState.session) {
      rememberActiveListScroll();
      maybeLoadNextListPage();
      return;
    }
    if (state.appState.session === '__new__') {
      btn.classList.remove('visible');
      state.stickBottom = true;
      return;
    }
    var atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 100;
    btn.classList.toggle('visible', !atBottom);
    // Position drives auto-scroll intent (programmatic scrollTo(bottom) lands here too, atBottom=true, so never clears it).
    state.stickBottom = atBottom;

    if (_scrollingToTop) { settleSoon(120); return; }

    // Load older messages when scrolling near top
    if (content.scrollTop < 1200 && state.wsHasMore && !state.wsLoadingOlder) loadOlderAndPrepend();
  });

  function settleSoon(ms) {
    clearTimeout(_scrollToTopTimer);
    _scrollToTopTimer = setTimeout(function () {
      _scrollingToTop = false;
      if (content.scrollTop < 1200 && state.wsHasMore && !state.wsLoadingOlder) loadOlderAndPrepend();
    }, ms);
  }

  // Tap top bar to scroll to top (skip Setup/Logout links)
  document.querySelector('.top-bar').addEventListener('click', function (e) {
    if (e.target.closest('.top-action')) return;
    if (!state.appState.session) return;
    _scrollingToTop = true;
    settleSoon(400);
    content.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

var _scrollingToTop = false, _scrollToTopTimer = null, _pinRo = null, _pinRoTimer = null;

var _hasScrollAnchoring = window.CSS && CSS.supports && CSS.supports('overflow-anchor', 'auto');

async function loadOlderAndPrepend() {
  if (!state.appState.session || state.appState.session === '__new__') return;
  var content = document.getElementById('content');
  var container = content.querySelector('.messages');
  if (!container) return;

  if (state.wsLoadingOlder) return;
  var msgs = await loadOlderMessages(state.appState.session);

  var loader = container.querySelector(':scope > .loading-older');
  if (loader && !state.wsHasMore) loader.classList.add('exhausted'); // no more history: reclaim its space
  if (!msgs || !msgs.length) return;

  var anchor = loader ? loader.nextElementSibling : container.firstElementChild;
  var prevTop = anchor ? anchor.getBoundingClientRect().top : 0;

  // Prepend after the loader so it stays the first child.
  var html = renderMessages(msgs, state.appState.runtime);
  if (loader) loader.insertAdjacentHTML('afterend', html);
  else container.insertAdjacentHTML('afterbegin', html);
  if (window.markTurnAdjacency) markTurnAdjacency(container); // reconnect the pagination seam
  loadImages(container);
  clampOverflow(container);
  if (window.renderMermaidBlocks) renderMermaidBlocks(container);
  if (window.renderKatexBlocks) renderKatexBlocks(container);

  if (anchor) content.scrollTop += Math.round(anchor.getBoundingClientRect().top - prevTop);

  if (_pinRo) { _pinRo.disconnect(); _pinRo = null; }
  clearTimeout(_pinRoTimer);
  if (anchor && window.ResizeObserver && !_hasScrollAnchoring) {
    var pinTop = anchor.getBoundingClientRect().top;
    var lastSet = content.scrollTop;
    _pinRo = new ResizeObserver(function () {
      if (Math.abs(content.scrollTop - lastSet) > 2) { _pinRo.disconnect(); _pinRo = null; return; }
      var delta = Math.round(anchor.getBoundingClientRect().top - pinTop);
      if (delta) {
        content.scrollTop += delta;
        lastSet = content.scrollTop;
        pinTop = anchor.getBoundingClientRect().top;
      }
    });
    _pinRo.observe(container);
    _pinRoTimer = setTimeout(function () { if (_pinRo) { _pinRo.disconnect(); _pinRo = null; } }, 800);
  }
}

// Auto-connect + restore last session
(function () {
  if (!state.KEY) return; // auth guard in index.html handles redirect
  // Inline shell already painted + replayed navigation — skip to avoid clearing its state.
  if (window.__inlineRendered) return;

  if (window.__preload?.devices) {
    Promise.resolve(window.__preload.devices).then(function (data) {
      if (!data) return;
      rememberDevices(data);
      if (state.appState.device) updateBreadcrumb();
    });
  }

  // Route immediately so skeleton shows without waiting for any network call
  var nav = sessionStorage.getItem('baton-nav');
  var hash = location.hash.replace(/^#\/?/, '');
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    var seg = hash.split('/').map(decodeURIComponent);
    var hashProjectName = seg[1] ? seg[1].split('-').pop() || seg[1] : '';
    if (seg.length >= 3 && seg[2] && seg[2] !== '__new__') {
      state.appState = { device: seg[0], project: { hash: seg[1], name: hashProjectName }, session: null, sessionPreview: '' };
      loadMessages(seg[2], '');
    } else if (seg.length >= 2 && seg[1]) { loadSessions(seg[0], seg[1], hashProjectName); }
    else if (seg.length >= 1 && seg[0]) { loadProjects(seg[0]); }
    else { loadDevices(); }
  } else if (nav) {
    try {
      var s = JSON.parse(nav);
      if (s.session && s.session !== '__new__') {
        state.appState = { device: s.device, project: s.project, session: null, sessionPreview: '' };
        loadMessages(s.session, s.sessionPreview);
      } else if (s.project) {
        loadSessions(s.device, s.project.hash, s.project.name);
      } else if (s.device) {
        loadProjects(s.device);
      } else {
        loadDevices();
      }
    } catch(e) { loadDevices(); }
  } else {
    loadDevices();
  }
})();

// In Tauri (WKWebView/WebView2) target=_blank can't open a tab, so external links
// would navigate the webview itself. Intercept and hand off to the system browser
// via plugin-opener (scoped to http/https in capabilities). Real browsers keep
// target=_blank and open a tab natively.
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a.ext-link');
  if (!a || !a.href) return;
  if (!(window.isTauri || window.__TAURI_INTERNALS__)) return;
  e.preventDefault();
  import('@tauri-apps/plugin-opener').then(function (m) { m.openUrl(a.href); }).catch(function () {});
});

// Function bridges for inline HTML handlers + legacy IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  osName, timeAgo, formatSize, esc,
  showStats, showWsBanner, navHref, updateBreadcrumb, toggleBreadcrumbExpand,
  showInputBar, saveNav, navigateUp, openActiveSession, openSession, shortModel,
  loadDevices, loadProjects, loadSessions,
  refreshForegroundView,
  createNewProject, closeNewProjectModal, submitNewProject,
  exitSelectMode, toggleSelected, openDeleteModal, closeDeleteModal, submitDelete, onDeleteFilesToggle,
  startNewSession, onNewAsAgentToggle, toggleNewSessionRuntime, loadMessages, toggleActiveSessions, toggleRecentAgents,
  refreshSessionThreads, openAgentThreadsModal, closeAgentThreadsModal, switchAgentThread,
  scrollToBottom, positionScrollBtn, loadOlderAndPrepend,
});

if (window.__APEEK_TEST__) {
  window.__listTest = {
    get: function (key) { return _listPages.peek(key); },
    loadNext: loadNextListPage,
    invalidate: invalidatePagedList,
    activeKey: function () { return _activeListKey; },
    pageSize: LIST_PAGE_SIZE,
    select: enterSelectMode,
    refreshForeground: refreshForegroundView,
    agentStatus: agentThreadStatus,
  };
}
