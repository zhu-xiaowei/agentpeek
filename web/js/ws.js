// Fit mobile layout to the visual viewport throughout keyboard transitions.
import { state } from './state.js';
import { dedupeCodexUserMessages } from './message-dedup.js';
import {
  StreamCoordinator,
  StreamingDomRenderer,
  TurnEventQueue,
} from './streaming.js';

var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
var _lastMobileViewportHeight = window.visualViewport ? window.visualViewport.height : 0;
var _keyboardOpenFrame = null;
var _followKeyboardOpen = false;
var _mobileKeyboardOpen = false;
var _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
// Gate keyboard adaptation to touch devices: on desktop visualViewport also fires resize (scrollbar/chrome shifts, mermaid render), and the Android branch below would wrongly rewrite body height → input bar jumps.
var _isMobile = /Mobi|Android/i.test(navigator.userAgent) || _isIOS;
var _wsSendQueue = []; // payloads queued while socket not OPEN, flushed in order on connect
var _turnEventQueue = new TurnEventQueue();
var _streamCoordinator = new StreamCoordinator();
var _strictStreamRenderer = null;
var _checkpointResumedTurns = new Set();
var _reconnectingTurns = new Set();
var _queuedTurnIds = new Set();
var _connectionRecovery = null;
var _wsReconnectTimer = null;
var _wsConfigRequest = null;
var _wsConnectionGeneration = 0;
var _controlEventTimers = new Map();
var _gappedEndTimers = new Map();
var _handledControlEvents = new Set();
var _controlRequestState = new Map();
var _preAdoptionTurnEvents = new Map();
var _agentThreadRefreshTimer = null;
var _agentThreadRefreshVersion = 0;
var CONTROL_EVENT_FALLBACK_MS = 120;
var GAPPED_END_GRACE_MS = window.__APEEK_TEST__ ? 30 : 5000;
var _appliedLifecycleVersion = 0;

if (window.visualViewport && _isMobile) {
  var syncMobileViewport = function () {
    var vv = window.visualViewport;
    var previousHeight = _lastMobileViewportHeight;
    var viewportShrinking = vv.height < previousHeight;
    var viewportGrowing = vv.height > previousHeight;
    _lastMobileViewportHeight = vv.height;
    var content = document.getElementById('content');
    var wasAtBottom = state.appState.session && state.appState.session !== '__new__' && content
      && content.scrollHeight - content.scrollTop - content.clientHeight < 100;
    if (viewportShrinking && wasAtBottom) _followKeyboardOpen = true;
    if (viewportGrowing) _followKeyboardOpen = false;

    _vpBaseHeight = Math.max(_vpBaseHeight, vv.height, window.innerHeight);
    var kbUp = vv.height < _vpBaseHeight * 0.75;
    _mobileKeyboardOpen = kbUp;
    var chromeHeight = 0;
    if (_isIOS && kbUp) {
      var topBar = document.querySelector('.top-bar');
      var breadcrumb = document.getElementById('breadcrumb');
      if (topBar) chromeHeight += topBar.offsetHeight;
      if (breadcrumb && getComputedStyle(breadcrumb).display !== 'none') {
        chromeHeight += breadcrumb.offsetHeight;
      }
    }
    document.body.style.bottom = 'auto';
    document.body.style.top = (_isIOS ? vv.offsetTop : 0) + 'px';
    document.body.style.height = (vv.height + chromeHeight) + 'px';
    document.body.style.transform = chromeHeight ? 'translateY(-' + chromeHeight + 'px)' : '';
    if (_isIOS) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.toggle('kb-up', kbUp);
    }
    if (window.positionScrollBtn) window.positionScrollBtn();
    if (_followKeyboardOpen && _keyboardOpenFrame === null) {
      _keyboardOpenFrame = requestAnimationFrame(function () {
        _keyboardOpenFrame = null;
        if (!_followKeyboardOpen) return;
        _followKeyboardOpen = false;
        var currentContent = document.getElementById('content');
        if (currentContent) currentContent.scrollTop = currentContent.scrollHeight;
      });
    }
  };
  window.visualViewport.addEventListener('resize', syncMobileViewport);
  if (_isIOS) window.visualViewport.addEventListener('scroll', syncMobileViewport);
  syncMobileViewport();
}

// Match React Native's keyboardShouldPersistTaps="never": while the message
// keyboard is open, the first tap outside the input bar only dismisses it.
// Consume the whole pointer/click sequence so expandable IN/OUT content does
// not also toggle and disturb streaming bottom-follow.
if (_isMobile) {
  var _dismissKeyboardTap = false;
  var _dismissKeyboardTimer = null;
  var clearDismissKeyboardTap = function () {
    _dismissKeyboardTap = false;
    clearTimeout(_dismissKeyboardTimer);
    _dismissKeyboardTimer = null;
  };
  var consumeDismissKeyboardEvent = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  document.addEventListener('pointerdown', function (event) {
    var input = document.getElementById('msg-input');
    if (!input
      || !_mobileKeyboardOpen
      || document.activeElement !== input
      || event.target.closest?.('#input-bar')) {
      return;
    }
    _dismissKeyboardTap = true;
    input.blur();
    consumeDismissKeyboardEvent(event);
    clearTimeout(_dismissKeyboardTimer);
    _dismissKeyboardTimer = setTimeout(clearDismissKeyboardTap, 500);
  }, true);

  document.addEventListener('pointerup', function (event) {
    if (_dismissKeyboardTap) consumeDismissKeyboardEvent(event);
  }, true);

  document.addEventListener('click', function (event) {
    if (!_dismissKeyboardTap) return;
    consumeDismissKeyboardEvent(event);
    clearDismissKeyboardTap();
  }, true);

  document.addEventListener('pointercancel', clearDismissKeyboardTap, true);
}

// Mirrors CC's SKIP_FIRST_PROMPT_PATTERN — kept in sync with bridge/session.mjs.
var SKIP_FIRST_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

function extractFirstPromptFromMsg(msg) {
  if (msg.type !== 'user') return '';
  var c = msg.content;
  var texts = [];
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) {
    for (var i = 0; i < c.length; i++) {
      if (c[i] && c[i].type === 'text' && c[i].text) texts.push(c[i].text);
    }
  }
  for (var j = 0; j < texts.length; j++) {
    var t = texts[j].replace(/\n/g, ' ').trim();
    if (!t) continue;
    var bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
    if (bash) return '! ' + bash[1].trim();
    if (SKIP_FIRST_PROMPT.test(t)) continue;
    return t.length > 200 ? t.slice(0, 200).trim() + '…' : t;
  }
  return '';
}

function isInheritedAgentContext(message, messages) {
  if (state.appState.runtime !== 'codex'
    || !state.rootSessionId
    || state.activeThreadId === state.rootSessionId
    || message?.type !== 'user') {
    return false;
  }
  for (var candidate of messages || []) {
    if (!extractFirstPromptFromMsg(candidate)) continue;
    return candidate === message;
  }
  return false;
}

function updateTitleFromMessages() {
  var customTitle = '', aiTitle = '', lastPrompt = '', firstUser = '';
  for (var i = 0; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type === 'custom-title' && m.content) customTitle = m.content;
    if (m.type === 'ai-title' && m.content) aiTitle = m.content;
    if (m.type === 'last-prompt' && m.content) lastPrompt = m.content;
    if (!firstUser) {
      var fp = extractFirstPromptFromMsg(m);
      if (fp) firstUser = fp;
    }
  }
  var tier = customTitle ? 4 : aiTitle ? 3 : lastPrompt ? 2 : firstUser ? 1 : 0;
  if (tier === 0) return;
  if (tier < (state._titleTier || 0)) return;
  var title = customTitle || aiTitle || lastPrompt || firstUser;
  if (title === state.appState.sessionPreview) return;
  state.appState.sessionPreview = title;
  if (state.activeThreadId === state.rootSessionId) {
    state.rootSessionPreview = title;
  }
  state._titleTier = tier;
  updateBreadcrumb();
  saveNav();
}

// Skeleton → empty state + stop spinner, when a synced session has no real messages. Never wipe mid-send/stream: a fresh session has 0 DDB rows but a live bubble on screen.
function showEmptyMessages() {
  if (state.pendingSentMessages.length || state.wsRunning) return;
  var content = document.getElementById('content');
  if (content && !state.wsAllMessages.length) {
    var promptActive = typeof hasActivePermissionPrompt === 'function'
      && hasActivePermissionPrompt();
    if (!promptActive) {
      content.innerHTML = '<div class="messages runtime-' + state.appState.runtime
        + '"><div class="empty">No messages</div></div>';
    }
    if (typeof revealDeferredPermissionPrompt === 'function') {
      revealDeferredPermissionPrompt();
    }
  }
  state.wsRunning = false;
  updateSendBtn();
}

function connectWs(_, projectHash) {
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (projectHash) {
    state.wsProjectHash = projectHash;
    state.wsRequestId = crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  if (!state.WS_URL) {
    // First launch + no cached _wsurl: one config request owns the eventual
    // connection. Concurrent callers (page setup + a fast first send) share it.
    var generation = _wsConnectionGeneration;
    if (_wsConfigRequest?.generation === generation) return;
    var request = { generation: generation, promise: null };
    _wsConfigRequest = request;
    request.promise = api('/api/bridge/config').then(function (cfg) {
      if (generation !== _wsConnectionGeneration) return;
      if (cfg.wsUrl) {
        state.WS_URL = cfg.wsUrl;
        localStorage.setItem('_wsurl', cfg.wsUrl);
        connectWs();
      }
    }).catch(function () {}).finally(function () {
      if (_wsConfigRequest === request) _wsConfigRequest = null;
    });
    return;
  }
  if (state.ws
    && (state.ws.readyState === WebSocket.OPEN
      || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.onmessage = null;
    state.ws.close();
    state.ws = null;
  }
  state.ws = new WebSocket(state.WS_URL + '?apiKey=' + state.KEY + '&role=app');

  state.ws.onopen = function () {
    setWsStatus('connected');
    recoverSubscribedSession();
    if (_wsSendQueue.length) {
      var queued = _wsSendQueue;
      _wsSendQueue = [];
      for (var qi = 0; qi < queued.length; qi++) wsSend(queued[qi]);
    }
    if (window.prefetchCommands) window.prefetchCommands();
  };

  state.ws.onmessage = function (e) {
    var message = JSON.parse(e.data);
    handleWsMessage(message);
  };

  state.ws.onclose = function () {
    if (window.resetCommandRequest) window.resetCommandRequest();
    setWsStatus('disconnected');
    if (state.appState.session) {
      beginSessionConnectionRecovery();
      setWsStatus('reconnecting');
      _wsReconnectTimer = setTimeout(function () {
        _wsReconnectTimer = null;
        if (state.appState.session) connectWs();
      }, 3000);
    }
  };

  state.ws.onerror = function () {};
}

function recoverSubscribedSession() {
  if (!state.wsSessionId) return false;
  subscribeSession(state.wsSessionId);
  if (!_connectionRecovery && hasOutstandingTurns()) {
    beginSessionConnectionRecovery();
  }
  if (_connectionRecovery
    && _connectionRecovery.sessionId === state.wsSessionId) {
    startSessionConnectionRecovery(_connectionRecovery);
  } else if (state.wsLastTimestamp) {
    recoverMissing().then(function (result) {
      state.wsRunning = resolveSessionRunningAfterFetch(
        result,
        state.wsAllMessages,
        state.appState.runtime,
      );
      updateSendBtn();
    }).catch(function () {});
  }
  return true;
}

function beginSessionConnectionRecovery() {
  if (!state.wsSessionId || !state.appState.session) return null;
  var turnIds = _streamCoordinator.activeTurnIds().filter(function (turnId) {
    return !_streamCoordinator.getTurn(turnId)?.endReceived;
  });
  for (var pending of state.pendingSentMessages) {
    if (pending.sessionId !== state.wsSessionId || pending.failed) continue;
    if (_streamCoordinator.getTurn(pending.id)?.endReceived) continue;
    if (!turnIds.includes(pending.id)) turnIds.push(pending.id);
  }
  _reconnectingTurns.clear();
  for (var turnId of turnIds) {
    _turnEventQueue.restartTurn(turnId);
    _checkpointResumedTurns.delete(turnId);
    _reconnectingTurns.add(turnId);
  }
  _connectionRecovery = {
    sessionId: state.wsSessionId,
    turnIds: turnIds,
    events: [],
    started: false,
    sessionStatus: '',
  };
  return _connectionRecovery;
}

function startSessionConnectionRecovery(recovery) {
  if (!recovery || recovery.started
    || recovery !== _connectionRecovery
    || recovery.sessionId !== state.wsSessionId) {
    return false;
  }
  recovery.started = true;
  recoverMissing().then(function (result) {
    if (recovery !== _connectionRecovery) return;
    recovery.sessionStatus = result?.status || '';
    if (recovery.sessionStatus === 'running'
      && hasTerminalAssistantTail(state.wsAllMessages)) {
      recovery.sessionStatus = 'completed';
    }
    finishSessionConnectionRecovery(recovery);
  });
  return true;
}

function settleRecoveredTurns(turnIds) {
  var settled = 0;
  for (var turnId of turnIds || []) {
    if (_streamCoordinator.settleTurn(turnId)) settled++;
    _turnEventQueue.closeTurn(turnId);
    _queuedTurnIds.delete(turnId);
    _checkpointResumedTurns.delete(turnId);
    _reconnectingTurns.delete(turnId);
  }
  return settled;
}

function finishSessionConnectionRecovery(recovery) {
  if (!recovery || recovery !== _connectionRecovery
    || recovery.sessionId !== state.wsSessionId) {
    return false;
  }
  _streamCoordinator.prepareTurnsForReconnect(recovery.turnIds);
  drainStrictStreamOperations();

  var bufferedEvents = recovery.events.slice();
  _connectionRecovery = null;
  for (var event of bufferedEvents) routeTurnEvent(event);
  if (recovery.sessionStatus === 'completed') {
    settleRecoveredTurns(recovery.turnIds);
    drainStrictStreamOperations();
  }
  state.wsRunning = recovery.sessionStatus === 'needs_input'
    ? false
    : hasOutstandingTurns();
  updateSendBtn();
  return true;
}

function resumeSessionForeground() {
  if (!state.appState.session || !state.WS_URL) return false;
  beginSessionConnectionRecovery();
  if (state.ws?.readyState === WebSocket.OPEN) {
    recoverSubscribedSession();
    return true;
  }
  if (state.ws?.readyState === WebSocket.CONNECTING) {
    return true;
  }
  connectWs();
  return true;
}

function handleWsMessage(msg) {
    routeTurnEvent(msg);
}

function strictEventKey(message) {
  return message?.turnId && Number.isInteger(message.seq)
    ? message.turnId + ':' + message.seq
    : '';
}

function isControlEvent(message) {
  return message?.action === 'permission_request'
    || message?.action === 'permission_resolved';
}

function dispatchControlEvent(message) {
  var eventKey = strictEventKey(message);
  if (eventKey && _handledControlEvents.has(eventKey)) return false;
  if (eventKey) {
    _handledControlEvents.add(eventKey);
    var timer = _controlEventTimers.get(eventKey);
    if (timer) clearTimeout(timer);
    _controlEventTimers.delete(eventKey);
  }

  var requestId = message.requestId || '';
  var requestState = requestId
    ? (_controlRequestState.get(requestId) || {
      requestSeq: -1,
      resolvedSeq: -1,
    })
    : null;
  var seq = Number.isInteger(message.seq) ? message.seq : Number.MAX_SAFE_INTEGER;

  if (message.action === 'permission_request') {
    if (requestState) {
      requestState.requestSeq = Math.max(requestState.requestSeq, seq);
      _controlRequestState.set(requestId, requestState);
      if (requestState.resolvedSeq >= seq) return true;
    }
    if (message.sessionId === state.wsSessionId) {
      state.wsRunning = false;
      _appliedLifecycleVersion++;
      updateSendBtn();
      if (typeof showPermissionPrompt === 'function') {
        showPermissionPrompt(message);
      }
    }
    return true;
  }

  if (requestState) {
    requestState.resolvedSeq = Math.max(requestState.resolvedSeq, seq);
    _controlRequestState.set(requestId, requestState);
  }
  if (message.sessionId === state.wsSessionId) {
    if (typeof resolvePermissionPrompt === 'function') {
      resolvePermissionPrompt(requestId);
    }
    state.wsRunning = hasOutstandingTurns();
    _appliedLifecycleVersion++;
    updateSendBtn();
  }
  return true;
}

function scheduleControlEventFallback(message) {
  var eventKey = strictEventKey(message);
  if (!eventKey || _handledControlEvents.has(eventKey)
    || _controlEventTimers.has(eventKey)) {
    return;
  }
  var timer = setTimeout(function () {
    _controlEventTimers.delete(eventKey);
    if (message.sessionId === state.wsSessionId) dispatchControlEvent(message);
  }, CONTROL_EVENT_FALLBACK_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _controlEventTimers.set(eventKey, timer);
}

function bufferPreAdoptionTurnEvent(message) {
  if (state.appState.session !== '__new__'
    || state.wsSessionId
    || !message?.sessionId
    || !message.turnId
    || !Number.isInteger(message.seq)
    || !findPending(message.turnId)) {
    return false;
  }
  var events = _preAdoptionTurnEvents.get(message.turnId) || [];
  events.push(message);
  _preAdoptionTurnEvents.set(message.turnId, events);
  return true;
}

function drainPreAdoptionTurnEvents(sessionId, turnId) {
  var events = _preAdoptionTurnEvents.get(turnId) || [];
  _preAdoptionTurnEvents.delete(turnId);
  for (var event of events) {
    if (event.sessionId === sessionId) routeTurnEvent(event);
  }
}

function routeTurnEvent(message) {
  if (bufferPreAdoptionTurnEvent(message)) return;
  if (!isStrictTurnEvent(message)) {
    dispatchWsMessage(message);
    return;
  }
  if (_connectionRecovery
    && _connectionRecovery.sessionId === message.sessionId) {
    _connectionRecovery.events.push(message);
    return;
  }
  var ordered = _turnEventQueue.push(message);
  drainLateJoinUpdates();
  var orderedEnd = ordered.some(function (event) {
    return event.action === 'stream_end';
  });
  if (orderedEnd) clearGappedEndTimer(message.turnId);
  for (var index = 0; index < ordered.length; index++) {
    dispatchWsMessage(ordered[index]);
  }
  if (message.action === 'stream_end' && !orderedEnd) {
    var hasEndAuthority = Array.isArray(message.messages) && message.messages.length;
    if (hasEndAuthority && _turnEventQueue.isLateJoinCandidate(message.turnId)) {
      completeLateJoinTurn(message.turnId);
    } else if (hasEndAuthority
      && _turnEventQueue.isGappedEndCandidate(message.turnId)) {
      completeGappedTurn(message.turnId);
    } else if (_turnEventQueue.isLateJoinCandidate(message.turnId)
      || _turnEventQueue.isGappedEndCandidate(message.turnId)) {
      scheduleGappedEndCompletion(message);
    }
  } else if (_turnEventQueue.isResumeCandidate(message.turnId)) {
    resumeLateJoinAtCheckpoint(message.turnId);
  }
  if (isControlEvent(message)
    && !_handledControlEvents.has(strictEventKey(message))) {
    scheduleControlEventFallback(message);
  }
}

function clearGappedEndTimer(turnId) {
  var timer = _gappedEndTimers.get(turnId);
  if (timer) clearTimeout(timer);
  _gappedEndTimers.delete(turnId);
}

function scheduleGappedEndCompletion(message) {
  if (_gappedEndTimers.has(message.turnId)) return;
  var timer = setTimeout(function () {
    _gappedEndTimers.delete(message.turnId);
    if (message.sessionId !== state.wsSessionId) return;
    if (_turnEventQueue.isLateJoinCandidate(message.turnId)) {
      completeLateJoinTurn(message.turnId);
    } else if (_turnEventQueue.isGappedEndCandidate(message.turnId)) {
      completeGappedTurn(message.turnId);
    }
  }, GAPPED_END_GRACE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _gappedEndTimers.set(message.turnId, timer);
}

function completeLateJoinTurn(turnId) {
  if (!_turnEventQueue.completeLateJoin(turnId)) return false;
  var lateJoins = _turnEventQueue.takeLateJoinCompletions();
  for (var lateIndex = 0; lateIndex < lateJoins.length; lateIndex++) {
    handleLateJoinCompletion(lateJoins[lateIndex]);
  }
  return true;
}

function completeGappedTurn(turnId) {
  if (!_turnEventQueue.completeGappedEnd(turnId)) return false;
  var completions = _turnEventQueue.takeLateJoinCompletions();
  for (var index = 0; index < completions.length; index++) {
    var completion = completions[index];
    if (!completion.gapped) {
      handleLateJoinCompletion(completion);
      continue;
    }
    handleGappedTurnCompletion(completion);
  }
  return true;
}

function handleGappedTurnCompletion(completion) {
  if (!completion || completion.sessionId !== state.wsSessionId) return false;
  clearGappedEndTimer(completion.turnId);
  // A missing block-start means strict authority cannot be mapped onto the
  // partial coordinator state. Discard that preview, then render the complete
  // terminal authority as one anchored historical turn.
  _strictStatusAuthority = true;
  _streamCoordinator.settleTurn(completion.turnId);
  drainStrictStreamOperations();
  _strictStreamRenderer?.discardTurn(completion.turnId);
  _queuedTurnIds.delete(completion.turnId);
  _checkpointResumedTurns.delete(completion.turnId);
  _reconnectingTurns.delete(completion.turnId);
  settlePendingAtTurnEnd(completion.turnId);
  mergeLateJoinAuthority(completion, true, true);
  _appliedLifecycleVersion++;
  updateSendBtn();
  scheduleTurnEndRecovery(completion.sessionId);
  return true;
}

function resumeLateJoinAtCheckpoint(turnId) {
  var recovery = _turnEventQueue.resumeAtNextCheckpoint(turnId);
  if (!recovery) return false;
  _checkpointResumedTurns.add(turnId);
  mergeLateJoinAuthority({
    sessionId: recovery.events[0]?.sessionId || state.wsSessionId,
    turnId: turnId,
    messages: recovery.messages,
  }, false);
  for (var event of recovery.events) dispatchWsMessage(event);
  drainLateJoinUpdates();
  return true;
}

function drainLateJoinUpdates() {
  var updates = _turnEventQueue.takeLateJoinUpdates();
  for (var index = 0; index < updates.length; index++) {
    mergeLateJoinAuthority(updates[index], false);
  }
}

// WS message dispatch — extracted from onmessage for the jsdom test harness.
function dispatchWsMessage(msg) {
    if (msg.action === 'messages' && msg.sessionId === state.wsSessionId) {
      if (msg.messages?.some(function (message) {
        return window.isSubagentNotificationMsg?.(message);
      })) {
        queueAgentThreadRefresh({ delays: [100, 800, 2000] });
      }
      var remainingMessages = handleStrictMessages(msg);
      if (!remainingMessages.length) return;
      msg = Object.assign({}, msg, { messages: remainingMessages });
      if (state._wsBuffer !== null) {
        // Buffering during initial load — collect, don't render yet
        for (var bi = 0; bi < msg.messages.length; bi++) {
          state._wsBuffer.push(msg.messages[bi]);
        }
        return;
      }
      for (var i = 0; i < msg.messages.length; i++) {
        var m = msg.messages[i];
        if (!trackMessageUuid(m)) continue;
        state.wsAllMessages.push(m);
        state.wsMessageCount++;
        if (m.timestamp) state.wsLastTimestamp = m.timestamp;
      }
      updateLastTurn();
      showStats(state.wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'permission_request'
      || msg.action === 'permission_resolved') {
      dispatchControlEvent(msg);
    } else if (msg.action === 'send_message_received') {
      var receivedPending = msg.turnId ? findPending(msg.turnId) : null;
      if (receivedPending) receivedPending.serverReceived = true;
    } else if (msg.action === 'send_message_result') {
      if (msg.deviceName && state.appState.device && msg.deviceName !== state.appState.device) return;
      if (msg.sessionId && state.wsSessionId && msg.sessionId !== state.wsSessionId
        && state.appState.session !== '__new__') return;
      // Acks are identity-only. An unscoped ack cannot safely choose among
      // multiple pending sends, so it never mutates optimistic UI state.
      if (state.pendingSentMessages.length) {
        var pending = msg.turnId ? findPending(msg.turnId) : null;
        if (pending && msg.errorCode === 'bridge_offline') {
          pending.serverReceived = false;
          schedulePendingTransportRetry(pending);
          return;
        }
        if (pending && msg.ok && msg.queued) {
          pending.queued = true;
          state.wsRunning = hasOutstandingTurns();
          updateSendBtn();
          return;
        }
        if (pending && !pending.delivered && handleCodexSendConflict(pending, msg)) return;
        if (pending && !pending.delivered) {
          finishCodexTakeover(pending);
          if (msg.ok && msg.commandOutput != null) {
            completeLocalCommand(pending, msg);
            applyCodexCommandAction(msg.commandAction);
          } else if (msg.ok && msg.commandNoEcho) {
            markPendingTime(pending);
            promoteEchoedBubble(pending, { timestamp: new Date().toISOString() });
          } else {
            resolvePending(pending, msg.ok, msg.error);
          }
        }
      }
      if (!msg.ok && msg.turnId) {
        rememberLatestSend(msg.turnId, true);
      }
      state.wsRunning = hasOutstandingTurns();
      updateSendBtn();
      // New session: adopt only the result that belongs to this tab's pending
      // turn. Current Bridges echo requestId; legacy unscoped results are safe
      // only when their turnId matches this page's optimistic prompt.
      var matchesNewSessionResult = msg.requestId
        ? msg.requestId === state.wsRequestId
        : !!(msg.turnId && (
          pending
          || document.querySelector(
            '.msg-user[data-anchor="' + msg.turnId + '"]',
          )
        ));
      if (msg.sessionId
        && state.appState.session === '__new__'
        && matchesNewSessionResult) {
        state.appState.session = msg.sessionId;
        state.appState.sessionPreview = 'New Session';
        state.rootSessionId = msg.sessionId;
        state.rootSessionPreview = state.appState.sessionPreview;
        state.activeThreadId = msg.sessionId;
        state.activeThreadCanSend = true;
        state.threadRequestVersion++;
        state.sessionThreads = [{
          sessionId: msg.sessionId,
          preview: state.rootSessionPreview,
          status: 'running',
          threadKind: 'main',
          canSend: true,
          runtime: state.appState.runtime,
        }];
        updateBreadcrumb();
        saveNav();
        state.wsRequestId = null;
        adoptNewSession(msg.sessionId);
        drainPreAdoptionTurnEvents(msg.sessionId, msg.turnId);
        // Fold fetched rows in incrementally (updateLastTurn), never innerHTML-rebuild — a rebuild renders only wsAllMessages and wipes other in-flight optimistic bubbles.
        bufferAndFetch(msg.sessionId, '').then(function () {
          var container = document.querySelector('.messages');
          if (!container || !state.wsAllMessages.length) return;
          updateLastTurn();
          loadImages(container);
          clampOverflow(container);
          if (window.renderMermaidBlocks) renderMermaidBlocks(container);
          if (window.renderKatexBlocks) renderKatexBlocks(container);
          container.parentElement.scrollTop = container.parentElement.scrollHeight;
          updateTitleFromMessages();
        }).catch(function () {});
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId !== state.wsSessionId) return;
      // No real messages (not_found / synced 0) → clear skeleton, don't hang.
      if (msg.status === 'not_found' || msg.count === 0) { showEmptyMessages(); return; }
      if (state._syncedOnce === msg.sessionId) return;
      state._syncedOnce = msg.sessionId;
      // Re-fetch + render once. Don't call loadMessages — that resets sessionPreview/_titleTier
      // and re-triggers needSync, causing a render-loop with title flicker.
      bufferAndFetch(msg.sessionId, '').then(function (result) {
        if (state.wsAllMessages.length === 0) { showEmptyMessages(); return; }
        var content = document.getElementById('content');
        var skeleton = content?.querySelector('.skeleton-messages');
        if (skeleton) {
          content.innerHTML = '<div class="messages runtime-' + state.appState.runtime
            + '">' + renderMessages(state.wsAllMessages, state.appState.runtime) + '</div>';
          var container = content.querySelector('.messages');
          state.wsRenderedCount = state.wsAllMessages.length;
          if (window.rebindStrictStreamDom) window.rebindStrictStreamDom();
          markTurnAdjacency(container);
          loadImages(container);
          clampOverflow(container);
          if (window.renderMermaidBlocks) renderMermaidBlocks(container);
          if (window.renderKatexBlocks) renderKatexBlocks(container);
          if (typeof revealDeferredPermissionPrompt === 'function') {
            revealDeferredPermissionPrompt();
          }
          if (typeof updateSpinner === 'function') updateSpinner();
          content.scrollTop = content.scrollHeight;
        } else {
          updateLastTurn(result.messages);
        }
        updateTitleFromMessages();
        updateSendBtn();
      }).catch(function () {});
    } else if (msg.action === 'session_threads_changed') {
      if (msg.deviceName && msg.deviceName !== state.appState.device) return;
      var rootChange = (msg.roots || []).find(function (root) {
        return root.rootSessionId === state.rootSessionId
          && root.projectHash === state.appState.project?.hash;
      });
      if (!rootChange) return;
      queueAgentThreadRefresh({
        expected: rootChange,
        delays: [150, 900, 2200],
      });
    } else if (msg.action === 'bridge_recovery_complete') {
      if (!state.wsSessionId || msg.deviceName !== state.appState.device) return;
      queueAgentThreadRefresh({ delays: [150, 1000] });
      recoverMissing('');
    } else if (msg.action === 'file_ready') {
      if (window.handleFileReady) window.handleFileReady(msg);
    } else if (msg.action === 'file_progress') {
      if (window.handleFileProgress) window.handleFileProgress(msg);
    } else if (msg.action === 'commands_list') {
      if (window.handleCommandsList) window.handleCommandsList(msg);
    } else if (msg.action === 'command_options') {
      if (window.handleCommandOptions) window.handleCommandOptions(msg);
    } else if (msg.action === 'stream_turn_start') {
      if (isStrictTurnEvent(msg)) handleStrictTurnStart(msg);
    } else if (msg.action === 'stream_delta') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'delta');
    } else if (msg.action === 'stream_tool_input') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'input');
    } else if (msg.action === 'stream_block_start') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'start');
    } else if (msg.action === 'stream_block_stop') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'stop');
    } else if (msg.action === 'stream_end') {
      if (isStrictTurnEvent(msg)) handleStrictTurnEnd(msg);
    } else if (msg.action === 'delete_files_result') {
      var r = window._deleteFilesResolvers && window._deleteFilesResolvers[msg.requestId];
      if (r) { delete window._deleteFilesResolvers[msg.requestId]; r(msg); }
    } else if (msg.action === 'create_project_result') {
      if (state._pendingCreatePath && msg.projectPath === state._pendingCreatePath) {
        state._pendingCreatePath = null;
        if (msg.ok) {
          closeNewProjectModal();
          // Empty project isn't in the list yet (no session) — go straight to its
          // new-session input; the first message creates the session + PROJ#/SESS#.
          // Set project so the breadcrumb shows its name (we arrive from device level, not the list).
          // Fallback to the hash's trailing segment (…-test3 → test3) if projectName is absent.
          var pname = msg.projectName || (msg.projectHash || '').split('-').filter(Boolean).pop() || msg.projectHash;
          state.appState.project = { hash: msg.projectHash, name: pname };
          startNewSession(msg.projectHash);
        } else {
          disconnectWs();
          // Show error in modal, reset button
          var err = document.getElementById('newProjectError');
          var input = document.getElementById('newProjectInput');
          var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
          if (err) err.textContent = msg.error || 'Unknown error';
          if (input) input.disabled = false;
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Create'; }
        }
      }
    }
}

function isStrictTurnEvent(message) {
  return message?.sessionId === state.wsSessionId
    && !!message.turnId
    && Number.isInteger(message.seq);
}

function strictMessageIdentity(envelope, message, index) {
  var turnId = envelope.turnId || '';
  if (!turnId || !Number.isInteger(envelope.seq)) return null;
  return {
    sessionId: envelope.sessionId,
    turnId: turnId,
    messageId: message.nativeId || message.uuid || '',
    seq: envelope.seq,
  };
}

function getStrictStreamRenderer() {
  if (_strictStreamRenderer) return _strictStreamRenderer;
  _strictStreamRenderer = new StreamingDomRenderer({
    document: document,
    getContainer: function () { return document.querySelector('.messages'); },
    findAnchor: function (turnId) {
      return turnId
        ? document.querySelector('[data-anchor="' + turnId + '"]')
        : null;
    },
    renderMarkdown: function (element, text) {
      if (window.renderStreamMd) window.renderStreamMd(element, text);
      else element.textContent = text;
      if (window.renderMermaidBlocks && element.querySelector('.mermaid-block')) {
        window.renderMermaidBlocks(element);
      }
      if (window.renderKatexBlocks) window.renderKatexBlocks(element);
    },
    renderTool: renderStrictToolBlock,
    onBlockRevealComplete: function (turnId, blockId) {
      _streamCoordinator.completeBlockReveal(turnId, blockId);
      drainStrictStreamOperations();
    },
    onMutation: function (element) {
      var container = document.querySelector('.messages');
      if (element?.classList.contains('assistant-turn')
        || element?.classList.contains('tool-node')) {
        markTurnAdjacency(container);
      }
      var content = document.getElementById('content');
      if (state.stickBottom && content) content.scrollTop = content.scrollHeight;
    },
  });
  return _strictStreamRenderer;
}

window.rebindStrictStreamDom = function () {
  _strictStreamRenderer?.rebindRenderedHistory();
};

function renderStrictToolBlock(element, block) {
  var raw = block.inputJson || '';
  var input = {};
  var parsed = false;
  if (raw) {
    try {
      input = JSON.parse(raw);
      parsed = true;
    } catch (error) {}
  }
  if (parsed && window.renderToolNode) {
    var toolUse = {
      type: 'tool_use',
      id: block.toolUseId || '',
      name: block.name || 'Tool',
      input: input,
    };
    window._lastToolState = '';
    element.innerHTML = renderToolNode(toolUse, null, state.appState.runtime, {
      collapsed: false,
    });
    var toolState = window._lastToolState || 'tool-running';
    var exploreClass = isLiveCodexExplore(toolUse.name, input) ? ' codex-explore' : '';
    element.className = 'tl-item tool-node ' + toolState + exploreClass;
    if (block.toolUseId) element.dataset.toolId = block.toolUseId;
    scheduleAgentThreadRefresh(toolUse.name);
    return;
  }
  var label = block.name || 'Tool';
  var description = raw ? previewPartialInput(raw) : '';
  var displayLabel = state.appState.runtime === 'codex' && label === 'Bash'
    ? 'Ran'
    : label;
  element.className = 'tl-item tool-node tool-running';
  element.innerHTML = '<div class="tool-header"><span class="tool-name">'
    + esc(displayLabel) + '</span><span class="tool-desc">'
    + esc(description) + '</span><span class="tool-status">running</span></div>';
}

function scheduleAgentThreadRefresh(toolName) {
  if (toolName !== 'spawn_agent' && toolName !== 'Agent') return;
  queueAgentThreadRefresh({ delays: [500, 1500, 3500] });
}

function agentThreadSummaryMatches(threads, expected) {
  if (!expected) return false;
  var agents = (threads || []).filter(function (thread) {
    return thread.sessionId !== state.rootSessionId;
  });
  var running = agents.filter(function (thread) {
    return thread.status === 'running';
  }).length;
  var needsInput = agents.filter(function (thread) {
    return thread.status === 'needs_input';
  }).length;
  return agents.length === Number(expected.agentCount || 0)
    && running === Number(expected.runningAgentCount || 0)
    && needsInput === Number(expected.needsInputAgentCount || 0);
}

function queueAgentThreadRefresh(options) {
  options = options || {};
  if (!state.rootSessionId) return;
  var rootSessionId = state.rootSessionId;
  var delays = options.delays || [250];
  var expected = options.expected || null;
  var version = ++_agentThreadRefreshVersion;
  clearTimeout(_agentThreadRefreshTimer);

  function schedule(index) {
    if (index >= delays.length) return;
    _agentThreadRefreshTimer = setTimeout(async function () {
      _agentThreadRefreshTimer = null;
      if (version !== _agentThreadRefreshVersion
        || rootSessionId !== state.rootSessionId) return;
      var threads = null;
      try {
        threads = await window.refreshSessionThreads?.();
      } catch (error) {}
      if (version !== _agentThreadRefreshVersion
        || rootSessionId !== state.rootSessionId) return;
      if (expected && agentThreadSummaryMatches(threads, expected)) return;
      schedule(index + 1);
    }, delays[index]);
  }

  schedule(0);
}

function drainStrictStreamOperations() {
  var operations = _streamCoordinator.takeOperations();
  if (!operations.length) return;
  var completedTurn = false;
  getStrictStreamRenderer().applyOperations(operations);
  for (var operation of operations) {
    if (operation.type === 'createTurn') {
      state.wsRunning = true;
    } else if (operation.type === 'completeTurn') {
      completedTurn = true;
      _queuedTurnIds.delete(operation.turnId);
      _checkpointResumedTurns.delete(operation.turnId);
      _reconnectingTurns.delete(operation.turnId);
    }
  }
  state.wsRunning = hasOutstandingTurns();
  if (completedTurn && !state.wsRunning && typeof window.markSpinnerTurnEnd === 'function') {
    window.markSpinnerTurnEnd();
  }
  updateSendBtn();
}

function handleStrictTurnStart(message) {
  _strictStatusAuthority = true;
  _queuedTurnIds.delete(message.turnId);
  _streamCoordinator.startTurn(message);
  drainStrictStreamOperations();
  state.wsRunning = true;
  _appliedLifecycleVersion++;
  updateSendBtn();
}

function handleStrictFrame(message, type) {
  _streamCoordinator.ingestFrame({
    sessionId: message.sessionId,
    turnId: message.turnId,
    seq: message.seq,
    type: type,
    kind: message.kind,
    name: message.name,
    chunk: message.chunk,
  });
  drainStrictStreamOperations();
}

function handleStrictTurnEnd(message) {
  clearGappedEndTimer(message.turnId);
  _strictStatusAuthority = true;
  var endMessages = Array.isArray(message.messages)
    ? message.messages.slice()
    : [];
  var completed = endMessages.length
    ? Object.assign({}, message, { messages: endMessages })
    : message;
  if (_checkpointResumedTurns.has(message.turnId)) {
    mergeLateJoinAuthority(completed, false);
  } else if (endMessages.length) {
    handleStrictMessages({
      action: 'messages',
      sessionId: message.sessionId,
      turnId: message.turnId,
      seq: message.seq,
      messages: endMessages,
    });
  }
  _streamCoordinator.endTurn(message);
  drainStrictStreamOperations();
  _turnEventQueue.closeTurn(message.turnId);
  _queuedTurnIds.delete(message.turnId);
  _checkpointResumedTurns.delete(message.turnId);
  _reconnectingTurns.delete(message.turnId);
  settlePendingAtTurnEnd(message.turnId);
  state.wsRunning = hasOutstandingTurns();
  _appliedLifecycleVersion++;
  updateSendBtn();
  if (message.recoveryRequired) scheduleTurnEndRecovery(message.sessionId);
}

function scheduleTurnEndRecovery(sessionId, attempt) {
  attempt = attempt || 0;
  var delays = [150, 800, 2000];
  setTimeout(function () {
    if (state.wsSessionId !== sessionId) return;
    recoverMissing('').then(function (result) {
      if (state.wsSessionId !== sessionId) return;
      if (attempt + 1 < delays.length
        && (!result || result.status === 'running')) {
        scheduleTurnEndRecovery(sessionId, attempt + 1);
      }
    }).catch(function () {
      if (attempt + 1 < delays.length) {
        scheduleTurnEndRecovery(sessionId, attempt + 1);
      }
    });
  }, delays[attempt]);
}

function handleLateJoinCompletion(completion) {
  clearGappedEndTimer(completion.turnId);
  mergeLateJoinAuthority(completion, true);
  settlePendingAtTurnEnd(completion.turnId);
  state.wsRunning = hasOutstandingTurns();
  _appliedLifecycleVersion++;
  updateSendBtn();
  if (!completion.messages?.length || completion.end?.recoveryRequired) {
    scheduleTurnEndRecovery(completion.sessionId);
  }
}

function mergeLateJoinAuthority(completion, completed, forceRender) {
  if (!completion || completion.sessionId !== state.wsSessionId) return;
  var incoming = [];
  for (var source of completion.messages || []) {
    if (!source) continue;
    incoming.push(Object.assign({}, source, {
      turnId: source.turnId || (completed ? completion.turnId : ''),
    }));
  }
  if (_reconnectingTurns.has(completion.turnId)
    && _streamCoordinator.getTurn(completion.turnId)) {
    if (incoming.length) {
      handleStrictMessages({
        action: 'messages',
        sessionId: completion.sessionId,
        turnId: completion.turnId,
        seq: completion.end?.seq || 0,
        messages: incoming,
      });
    }
    if (completed) {
      _strictStatusAuthority = true;
      _reconnectingTurns.delete(completion.turnId);
    }
    state.wsRunning = hasOutstandingTurns();
    updateSendBtn();
    return;
  }
  if (completed) _strictStatusAuthority = true;
  if (completed) _queuedTurnIds.delete(completion.turnId);
  if (completed) _reconnectingTurns.delete(completion.turnId);
  if (state._wsBuffer !== null) {
    state._wsBuffer.push.apply(state._wsBuffer, incoming);
    // Initial REST can still be in flight when a complete stream_end crosses
    // a missing sequence. The live preview has already been discarded, so
    // terminal authority must render now; the buffered copy will dedupe when
    // the fetch finishes. Non-terminal late-join updates remain buffered.
    if (!forceRender) {
      state.wsRunning = hasOutstandingTurns();
      updateSendBtn();
      return;
    }
  }
  var messages = [];
  for (var message of incoming) {
    if (forceRender) {
      var existing = state.wsAllMessages.find(function (candidate) {
        return (message.nativeId && candidate.nativeId === message.nativeId)
          || (message.uuid && candidate.uuid === message.uuid);
      });
      if (existing) {
        existing.turnId = existing.turnId || completion.turnId;
        existing._strictManaged = false;
        messages.push(existing);
        continue;
      }
    }
    if (!trackMessageUuid(message)) continue;
    if (forceRender) message._strictManaged = false;
    messages.push(message);
    state.wsAllMessages.push(message);
    state.wsMessageCount++;
    if (message.timestamp) state.wsLastTimestamp = message.timestamp;
  }
  if (messages.length) {
    updateLastTurn(messages);
    _strictStreamRenderer?.attachTurnToAnchor(completion.turnId);
    if (completed) {
      _strictStreamRenderer?.applyOperation({
        type: 'completeTurn',
        turnId: completion.turnId,
      });
    }
    showStats(state.wsMessageCount + ' messages (late join)');
  }
  state.wsRunning = hasOutstandingTurns();
  updateSendBtn();
}

function handleStrictMessages(envelope) {
  var remaining = [];
  var added = false;
  var identities = [];
  for (var index = 0; index < envelope.messages.length; index++) {
    var message = envelope.messages[index];
    var identity = strictMessageIdentity(envelope, message, index);
    if (!identity) {
      remaining.push(message);
      continue;
    }
    Object.assign(message, identity, {
      _strictLifecycle: true,
      _strictManaged: message.type === 'assistant' || message.type === 'summary',
    });
    removeHistoricalMessageNodes(
      message.uuid || '',
      message.nativeId || '',
      identity.turnId,
    );
    identities.push(identity);
    if (trackMessageUuid(message)) {
      state.wsAllMessages.push(message);
      state.wsMessageCount++;
      if (message.timestamp) state.wsLastTimestamp = message.timestamp;
      added = true;
    }
    _streamCoordinator.ingestAuthoritative({
      ...identity,
      message: message,
    });
  }
  drainStrictStreamOperations();
  if (added) updateLastTurn();
  if (_strictStreamRenderer) {
    for (var identity of identities) {
      _strictStreamRenderer.attachTurnToAnchor(identity.turnId);
    }
  }
  if (added) {
    showStats(state.wsMessageCount + ' messages (strict live)');
  }
  return remaining;
}

function removeHistoricalMessageNodes(messageId, nativeId, turnId) {
  if (!messageId && !nativeId) return;
  var container = document.querySelector('.messages');
  if (!container) return;
  var nodes = container.querySelectorAll('[data-message-id], [data-native-id]');
  for (var node of nodes) {
    var matchesUuid = !!messageId && node.dataset.messageId === messageId;
    var matchesNative = !!nativeId && node.dataset.nativeId === nativeId;
    if (!matchesUuid && !matchesNative) continue;
    var strictTurn = node.closest('[data-turn-id]');
    if (turnId && strictTurn?.dataset.turnId === turnId) continue;
    var turn = node.parentElement;
    node.remove();
    if (turn?.classList.contains('assistant-turn') && !turn.children.length) {
      turn.remove();
    }
  }
}

function resetStreamSessionState() {
  if (_strictStreamRenderer) _strictStreamRenderer.reset();
  _strictStreamRenderer = null;
  _streamCoordinator.resetSession('');
  _turnEventQueue.reset();
  _checkpointResumedTurns.clear();
  _reconnectingTurns.clear();
  _queuedTurnIds.clear();
  _connectionRecovery = null;
  for (var timer of _controlEventTimers.values()) clearTimeout(timer);
  _controlEventTimers.clear();
  for (var endTimer of _gappedEndTimers.values()) clearTimeout(endTimer);
  _gappedEndTimers.clear();
  _handledControlEvents.clear();
  _controlRequestState.clear();
  _preAdoptionTurnEvents.clear();
  clearTimeout(_agentThreadRefreshTimer);
  _agentThreadRefreshTimer = null;
  _agentThreadRefreshVersion++;
  _appliedLifecycleVersion = 0;
  resetTurnLifecycle();
  _strictStatusAuthority = false;
}

function selectWsSession(sessionId) {
  var rootSessionId = state.rootSessionId || sessionId || '';
  if (state.wsSessionId === sessionId
    && state.wsRootSessionId === rootSessionId) return;
  if (state.wsSessionId) {
    wsSend({
      action: 'unsubscribe',
      sessionId: state.wsSessionId,
      rootSessionId: state.wsRootSessionId || state.wsSessionId,
    });
  }
  window.resetToolDetails?.();
  resetStreamSessionState();
  state.wsSessionId = sessionId;
  state.wsRootSessionId = rootSessionId;
}

function subscribeSession(sessionId) {
  selectWsSession(sessionId);
  wsSend({
    action: 'subscribe',
    sessionId: sessionId,
    rootSessionId: state.wsRootSessionId || sessionId,
  });
  wsSend({
    action: 'reveal_permission',
    sessionId: sessionId,
    device: state.appState.device || '',
  });
}

// The first send creates a native session while its stream is already active.
// Adopt that server id without resetting the buffer and anchor for the same turn.
function adoptNewSession(sessionId) {
  if (state.wsSessionId && state.wsSessionId !== sessionId) {
    wsSend({
      action: 'unsubscribe',
      sessionId: state.wsSessionId,
      rootSessionId: state.wsRootSessionId || state.wsSessionId,
    });
  }
  state.wsSessionId = sessionId;
  state.wsRootSessionId = state.rootSessionId || sessionId;
  wsSend({
    action: 'subscribe',
    sessionId: sessionId,
    rootSessionId: state.wsRootSessionId,
  });
  wsSend({
    action: 'reveal_permission',
    sessionId: sessionId,
    device: state.appState.device || '',
  });
}

function wsSend(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

// Non-OPEN → queue + reconnect (onopen flushes); use for user actions that must not drop.
function wsSendReliable(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
    return;
  }
  _wsSendQueue.push(data);
  if (!state.ws || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED) {
    connectWs();
  }
}

function setWsStatus(status) {
  state.wsStatusText = status;
  showWsBanner(status);
}

function disconnectWs() {
  _wsConnectionGeneration++;
  if (window.resetCommandRequest) window.resetCommandRequest();
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.wsSessionId = null;
  state.wsRootSessionId = null;
  state.wsRunning = false;
  window.resetToolDetails?.();
  resetStreamSessionState();
  updateSpinner();
  setWsStatus('');
}

function ensureWsAndSend(data) {
  wsSendReliable(data);
}

/**
 * Find insertion point: scan from end, return first element with data-ts > timestamp.
 * Skips elements without data-ts (pending messages). Returns null = insert at end of real messages.
 */
function findInsertBefore(container, timestamp) {
  if (!timestamp) return null;
  var kids = container.children;
  var result = null;
  for (var i = kids.length - 1; i >= 0; i--) {
    var ts = kids[i].dataset.ts;
    if (!ts) continue; // skip pending (no data-ts)
    if (ts > timestamp) {
      result = kids[i];
    } else {
      break; // found ts <= ours, stop
    }
  }
  return result;
}

/** Insert html at correct timestamp position, before any pending messages. */
function insertAtTimestamp(container, html, timestamp) {
  var before = findInsertBefore(container, timestamp);
  if (before) {
    before.insertAdjacentHTML('beforebegin', html);
  } else {
    // Append after all real messages, before pending
    var firstPending = container.querySelector('[data-pending]');
    if (firstPending) firstPending.insertAdjacentHTML('beforebegin', html);
    else container.insertAdjacentHTML('beforeend', html);
  }
}

function insertAssistantItemAtTimestamp(container, html, timestamp) {
  var items = container.querySelectorAll('[data-ts]');
  var target = null;
  for (var i = items.length - 1; i >= 0; i--) {
    if (items[i].dataset.ts > timestamp) target = items[i];
    else break;
  }
  if (target && target.classList.contains('tl-item')) {
    target.insertAdjacentHTML('beforebegin', html);
  } else {
    var row = '<div class="assistant-turn" data-ts="' + (timestamp || '') + '">' + html + '</div>';
    if (target) target.insertAdjacentHTML('beforebegin', row);
    else {
      var firstPending = container.querySelector('[data-pending]');
      if (firstPending) firstPending.insertAdjacentHTML('beforebegin', row);
      else container.insertAdjacentHTML('beforeend', row);
    }
  }
}

function insertAssistantItemForTurn(container, html, turnId) {
  if (!turnId) {
    insertAssistantItemAtTimestamp(container, html, '');
    return;
  }
  var turn = getStrictStreamRenderer().createTurn({ turnId: turnId });
  if (!turn) return;
  turn.insertAdjacentHTML('beforeend', html);
  markTurnAdjacency(container);
  var content = document.getElementById('content');
  if (state.stickBottom && content) content.scrollTop = content.scrollHeight;
}

function compareMessageOrder(left, right) {
  var leftTimestamp = left?.timestamp || '';
  var rightTimestamp = right?.timestamp || '';
  return leftTimestamp < rightTimestamp ? -1 : leftTimestamp > rightTimestamp ? 1 : 0;
}

var _latestTurnId = '';
var _latestTurnOrder = -1;
var _latestSendFailed = false;
var _interruptedTurns = {};
var _lastThinkSecs = 0; // seconds the live preview measured for the latest thinking block
var _strictStatusAuthority = false;
var STRICT_TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
]);

function isTerminalAssistantMessage(message) {
  return message?.type === 'assistant'
    && STRICT_TERMINAL_STOP_REASONS.has(message.stopReason);
}

// One-line preview of a tool's input (best-effort; input may be partial JSON).
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command);                 // Bash
  if (input.file_path || input.path) return String(input.file_path || input.path); // Read/Write/Edit
  if (input.pattern) return String(input.pattern);                 // Grep/Glob
  if (input.url) return String(input.url);                         // WebFetch
  if (input.prompt) return String(input.prompt).slice(0, 200);     // Task/agent
  try { return JSON.stringify(input).slice(0, 200); } catch (e) { return ''; }
}

function isLiveCodexExplore(name, input) {
  if (state.appState.runtime !== 'codex' || name !== 'Bash') return false;
  var actions = Array.isArray(input?.codexCommandActions) ? input.codexCommandActions : [];
  return actions.length > 0 && actions.every(function (action) {
    return ['read', 'list_files', 'search'].includes(action?.type);
  });
}

// Decode \uXXXX / \n etc. from a (possibly incomplete) JSON fragment for readable streaming preview.
function decodeJsonEscapes(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// One-line header desc from partial JSON: decoded fragment, matching the final card's truncated-JSON desc.
function previewPartialInput(partial) {
  return decodeJsonEscapes(partial).slice(0, 200);
}

function resetTurnLifecycle() {
  _latestTurnId = '';
  _latestTurnOrder = -1;
  _latestSendFailed = false;
  _interruptedTurns = {};
}

function rememberLatestSend(turnId, failed, explicitOrder) {
  var pending = findPending(turnId);
  var order = Number.isInteger(explicitOrder)
    ? explicitOrder
    : (Number.isInteger(pending?.seq) ? pending.seq : null);
  if (turnId !== _latestTurnId && order == null) return;
  if (turnId !== _latestTurnId && order < _latestTurnOrder) return;
  if (turnId !== _latestTurnId) {
    _latestTurnId = turnId;
    _latestTurnOrder = order;
    _latestSendFailed = false;
  }
  if (failed) _latestSendFailed = true;
}

function hasOutstandingTurns() {
  if (_streamCoordinator.hasActiveTurns()) return true;
  if (_reconnectingTurns.size) return true;
  if (_queuedTurnIds.size) return true;
  if (state.pendingSentMessages.some(function (pending) {
    return !pending.failed;
  })) return true;
  var pending = _latestTurnId ? findPending(_latestTurnId) : null;
  return !!(_latestTurnId
    && !_latestSendFailed
    && !_interruptedTurns[_latestTurnId]
    && pending
    && !pending.failed);
}

function latestOutstandingTurnId() {
  var latestPending = null;
  for (var pending of state.pendingSentMessages) {
    if (pending.failed || pending.sessionId !== state.wsSessionId) continue;
    if (!latestPending || (pending.seq || 0) > (latestPending.seq || 0)) {
      latestPending = pending;
    }
  }
  if (latestPending) return latestPending.id;
  var queued = Array.from(_queuedTurnIds);
  if (queued.length) return queued[queued.length - 1];
  var active = _streamCoordinator.activeTurnIds();
  if (active.length) return active[active.length - 1];
  var reconnecting = Array.from(_reconnectingTurns);
  return reconnecting.length ? reconnecting[reconnecting.length - 1] : '';
}

function activeTurnForInterrupt() {
  if (_streamCoordinator.activeTurnId
    && !_interruptedTurns[_streamCoordinator.activeTurnId]) {
    return _streamCoordinator.activeTurnId;
  }
  if (_latestTurnId && !_latestSendFailed
    && !_interruptedTurns[_latestTurnId]) {
    return _latestTurnId;
  }
  return '';
}

// Cross-turn connector adjacency via explicit classes — replaces :has(+)/+ which WebKit (Safari) won't re-invalidate on live inserts. Call only when a turn is added/removed, never per frame.
function markTurnAdjacency(container) {
  if (!container) return;
  if (state.appState.runtime === 'codex') {
    window.normalizeCodexTimeline?.(container);
  }
  window.afterToolDomMutation?.(container);
  var kids = container.children;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    if (!el.classList || !el.classList.contains('assistant-turn')) continue;
    var next = el.nextElementSibling;
    el.classList.toggle('has-next-turn', !!(next && next.classList.contains('assistant-turn')));
    var prev = el.previousElementSibling;
    el.classList.toggle('follows-turn', !!(prev && prev.classList.contains('assistant-turn')));
  }
}
window.markTurnAdjacency = markTurnAdjacency;

function buildToolIndexes(messages) {
  var uses = {};
  var results = {};
  for (var i = 0; i < messages.length; i++) {
    var message = messages[i];
    if (!Array.isArray(message.content)) continue;
    for (var j = 0; j < message.content.length; j++) {
      var block = message.content[j];
      if (block.type === 'tool_use' && block.id) {
        uses[block.id] = { block: block, message: message };
      } else if (block.type === 'tool_result' && block.tool_use_id
        && !block.codexSuperseded) {
        results[block.tool_use_id] = {
          block: block,
          timestamp: message.timestamp || '',
        };
      }
    }
  }

  return { uses: uses, results: results };
}

// Authoritative thinking has no duration; use the seconds the live preview measured.
function applyThinkSecs(html) {
  if (!_lastThinkSecs || html.indexOf('thinking-toggle') === -1) return html;
  return html.replace(/(<div class="thinking-toggle"[^>]*>)Thinking( <span)/, '$1Thought for ' + _lastThinkSecs + 's$2');
}

function updateLastTurn(explicitMessages) {
  var container = document.querySelector('.messages');
  if (!container) return;

  var newMessages = Array.isArray(explicitMessages)
    ? explicitMessages.slice()
    : state.wsAllMessages.slice(state.wsRenderedCount);
  state.wsRenderedCount = state.wsAllMessages.length;
  if (!newMessages.length) return;

  var content = document.getElementById('content');
  if (newMessages.length > 1) {
    newMessages.sort(compareMessageOrder);
  }

  var hasToolResults = newMessages.some(isToolResultOnly);
  var toolIndexes = hasToolResults
    ? buildToolIndexes(state.wsAllMessages)
    : null;
  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];
    if (msg._strictManaged) continue;
    // tool_result → update matching tool_use node
    if (isToolResultOnly(msg)) {
      if (Array.isArray(msg.content)) {
        for (var ri = 0; ri < msg.content.length; ri++) {
          var rb = msg.content[ri];
          if (rb.type !== 'tool_result' || !rb.tool_use_id) continue;
          if (rb.codexSuperseded) continue;
          var node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
          var toolEntry = toolIndexes?.uses[rb.tool_use_id];
          var toolUseBlock = toolEntry?.block;
          var toolUseMessage = toolEntry?.message;
          if (!toolUseBlock) continue;
          if (msg.toolUseResult) rb._agentMeta = msg.toolUseResult;
          var hidden = state.appState.runtime === 'codex'
            && !msg.turnId
            && window.isCodexHiddenTool?.(toolUseBlock, rb);
          if (hidden) {
            if (node) {
              var emptyRow = node.parentElement;
              node.remove();
              if (emptyRow?.classList.contains('assistant-turn') && !emptyRow.children.length) {
                emptyRow.remove();
              }
            }
            continue;
          }
          if (!node && toolUseMessage && !msg.turnId) {
            var restoredHtml = renderSingleMessage(toolUseMessage, state.wsAllMessages, state.appState.runtime);
            if (restoredHtml) insertAssistantItemAtTimestamp(container, restoredHtml, msg.timestamp);
            node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
          }
          if (!node) continue;
          var toolDetailsCollapsed = node.classList.contains('tool-details-collapsed');
          window._lastToolState = '';
          node.innerHTML = renderToolNode(toolUseBlock, rb, state.appState.runtime, {
            collapsed: toolDetailsCollapsed,
          });
          var toolStateClass = window._lastToolState || '';
          var exploreClass = state.appState.runtime === 'codex'
            && window.isCodexExploreTool?.(toolUseBlock, rb) ? ' codex-explore' : '';
          var waitClass = state.appState.runtime === 'codex'
            && toolUseBlock.name === 'WriteStdin'
            && !String(toolUseBlock.input?.chars || '').length ? ' codex-terminal-wait' : '';
          var backgroundClass = rb.codexBackground === 'complete'
            ? ' codex-background-complete' : '';
          node.className = 'tl-item tool-node' + exploreClass + waitClass + backgroundClass
            + (toolStateClass ? ' ' + toolStateClass : '');
          window.setToolDetailsCollapsed?.(node, toolDetailsCollapsed);
          if (rb.codexProcessId) node.dataset.codexProcess = rb.codexProcessId;
        }
      }
      continue;
    }

    // Local command stdout (e.g. /compact result): render as cmd-output.
    if (window.isLocalCommandStdout && window.isLocalCommandStdout(msg)) {
      if (tryDedup(msg)) continue;
      var stdoutHtml = window.renderLocalCommandStdout(msg);
      if (stdoutHtml) insertAtTimestamp(container, stdoutHtml, msg.timestamp);
      continue;
    }

    // Codex injects child completion into the parent as a user-role protocol
    // message. It is internal context, not a user prompt or visible timeline row.
    if (window.isSubagentNotificationMsg?.(msg)) continue;

    // User message
    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      if (tryDedup(msg)) {
        if (msg.turnId) _strictStreamRenderer?.attachTurnToAnchor(msg.turnId);
        updateTitleFromMessages();
        continue;
      }
      var userHtml = renderUserBubble(
        msg,
        isInheritedAgentContext(msg, state.wsAllMessages) ? 'agent-context' : '',
      );
      if (userHtml) {
        insertAtTimestamp(container, userHtml, msg.timestamp);
        if (msg.turnId) _strictStreamRenderer?.attachTurnToAnchor(msg.turnId);
      }
      // Trivial-first-message sessions get no ai-title (last-prompt lands only on shutdown) → fall title back to first user prompt (idempotent; tier won't downgrade).
      updateTitleFromMessages();
      continue;
    }

    // Metadata types: update title only, don't render
    if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') {
      updateTitleFromMessages();
      continue;
    }

    if (msg.type === 'system_event') {
      var eventHtml = renderSystemEvent(msg);
      if (eventHtml) insertAtTimestamp(container, eventHtml, msg.timestamp);
      continue;
    }

    if (isInterruptMsg(msg)) {
      if (msg.turnId) _interruptedTurns[msg.turnId] = true;
      var interruptHtml = renderSingleMessage(
        msg,
        state.wsAllMessages,
        state.appState.runtime,
      );
      if (!interruptHtml) continue;
      if (msg.turnId) {
        insertAssistantItemForTurn(container, interruptHtml, msg.turnId);
      } else {
        insertAssistantItemAtTimestamp(container, interruptHtml, msg.timestamp);
      }
      continue;
    }

    // Assistant message
    if (msg.type !== 'assistant' && msg.type !== 'summary') continue;

    // The watcher/REST copy can arrive without turnId while the strict live
    // turn is still revealing the same assistant response. Keep the row in
    // state for persistence/dedup, but do not render a second historical turn;
    // strict authority (messages/stream_end) patches the existing live turn.
    if (!msg.turnId
      && _strictStatusAuthority
      && _streamCoordinator.hasActiveTurns()
      && _reconnectingTurns.size === 0) {
      msg._strictLifecycle = true;
      msg._strictManaged = true;
      continue;
    }

    var html = renderSingleMessage(msg, state.wsAllMessages, state.appState.runtime);
    if (!html) continue;
    html = applyThinkSecs(html); // carry live-measured thinking seconds into the empty authoritative node

    if (msg.turnId) {
      insertAssistantItemForTurn(container, html, msg.turnId);
    } else {
      insertAssistantItemAtTimestamp(container, html, msg.timestamp);
    }
  }
  markTurnAdjacency(container); // turns may have been added this batch
  var nonStrictMessages = state.wsAllMessages.filter(function (message) {
    return !message._strictLifecycle;
  });
  var derived = deriveRunning(nonStrictMessages, null, state.appState.runtime);
  var nonStrictTurnFrames = newMessages.filter(function (message) {
    return !message._strictLifecycle
      && (message.type === 'assistant'
        || (message.type === 'user'
          && !window.isSubagentNotificationMsg?.(message)));
  });
  var startsExternalTurn = nonStrictTurnFrames.some(function (message) {
    return message.type === 'user'
      && !isInterruptMsg(message)
      && !isToolResultOnly(message);
  });
  if (startsExternalTurn) _strictStatusAuthority = false;
  if (hasOutstandingTurns()) state.wsRunning = true;
  else if (!_strictStatusAuthority && nonStrictTurnFrames.length) {
    state.wsRunning = derived;
  }
  updateSendBtn();

  // Don't dismiss a prompt still awaiting the user's answer (prompts are bridge-driven).
  var promptEl = document.getElementById('permission-prompt');
  if (promptEl && !(typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt())) {
    dismissPermissionPrompt();
  } else if (promptEl && promptEl !== container.lastElementChild) {
    container.appendChild(promptEl); // keep the prompt pinned below the AskUserQuestion card that just landed
  }
  // turnEnded (real frame brought CC to idle) → clean queued msgs that never echoed.
  reconcileEchoedPending();

  // Clamp before scrolling so scrollTop uses the collapsed final height.
  loadImages(container);
  clampOverflow(container);
  if (window.renderMermaidBlocks) renderMermaidBlocks(container);
  if (window.renderKatexBlocks) renderKatexBlocks(container);
  if (state.stickBottom && content) content.scrollTop = content.scrollHeight;
  showStats(state.wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  state._syncedOnce = null;
  if (!state.ws) {
    selectWsSession(sessionId);
    connectWs();
  }
  else subscribeSession(sessionId);
  // Prefetch slash commands. When ws already exists this sends now; on a fresh
  // connect the socket isn't OPEN yet so this no-ops and onopen handles it.
  if (window.prefetchCommands) window.prefetchCommands();
}

function trackMessageUuid(message) {
  if (!message) return true;
  var uuidKey = message.uuid || '';
  var nativeKey = message.nativeId ? 'native:' + message.nativeId : '';
  if ((uuidKey && state.wsMessageUuids.has(uuidKey))
    || (nativeKey && state.wsMessageUuids.has(nativeKey))) return false;
  if (uuidKey) state.wsMessageUuids.add(uuidKey);
  if (nativeKey) state.wsMessageUuids.add(nativeKey);
  return true;
}

/**
 * Buffer WS → fetch DDB → merge + dedup → return merged messages.
 * Used by both initial load (after='') and reconnect recovery (after=wsLastTimestamp).
 */
async function bufferAndFetch(sessionId, after) {
  var lifecycleVersion = _appliedLifecycleVersion;
  state._wsBuffer = [];
  try {
    var params = { session: sessionId };
    if (after) params.after = after;
    if (state.appState.device) params.device = state.appState.device;
    if (state.appState.project?.hash) {
      params.project = state.appState.project.hash;
    }
    var data = await api('/api/bridge/messages', params);
    // User navigated to another session while this was in flight — drop the stale response.
    if (state.wsSessionId !== sessionId) return { added: 0, needSync: false };
    var all = dedupeCodexUserMessages(
      (state._wsBuffer || []).concat(data.messages || []),
    );
    state._wsBuffer = null;
    var added = 0;
    var addedMessages = [];
    for (var i = 0; i < all.length; i++) {
      if (!trackMessageUuid(all[i])) continue;
      state.wsAllMessages.push(all[i]);
      state.wsMessageCount++;
      addedMessages.push(all[i]);
      added++;
    }
    if (added > 0) {
      state.wsAllMessages.sort(compareMessageOrder);
    }
    state.wsLastTimestamp = state.wsAllMessages.length ? state.wsAllMessages[state.wsAllMessages.length - 1].timestamp || '' : '';
    // Save pagination state from initial load
    if (!after && data.hasMore !== undefined) {
      state.wsHasMore = data.hasMore;
      state.wsOldestTimestamp = data.oldestTimestamp || '';
    }
    return {
      added: added,
      messages: addedMessages,
      needSync: data.needSync,
      status: data.status || '',
      liveLifecycleChanged: _appliedLifecycleVersion !== lifecycleVersion,
    };
  } catch (e) { state._wsBuffer = null; throw e; }
}

function resolveSessionRunningAfterFetch(result, messages, runtime) {
  // A lifecycle event applied while REST was in flight is causally newer than
  // the REST snapshot. Preserve the state established by start/end/permission.
  if (result?.status === 'needs_input') return false;
  if (hasOutstandingTurns()) return true;
  if (result?.liveLifecycleChanged) return state.wsRunning;
  if (result?.status) {
    if (result.status === 'running' && hasTerminalAssistantTail(messages)) {
      return false;
    }
    return result.status === 'running';
  }
  return deriveRunning(messages, '', runtime);
}

function hasTerminalAssistantTail(messages) {
  for (var index = (messages || []).length - 1; index >= 0; index--) {
    var message = messages[index];
    if (message?.type === 'assistant' || message?.type === 'summary') {
      return isTerminalAssistantMessage(message);
    }
    if (message?.type === 'user'
      && !isInterruptMsg(message)
      && !(typeof isToolResultOnly === 'function' && isToolResultOnly(message))
      && !window.isSubagentNotificationMsg?.(message)) {
      return false;
    }
  }
  return false;
}

/**
 * Load older messages (triggered by scroll-to-top).
 * Prepends to wsAllMessages and returns the loaded messages for DOM prepend.
 */
async function loadOlderMessages(sessionId) {
  if (state.wsLoadingOlder || !state.wsHasMore || !state.wsOldestTimestamp) return null;
  state.wsLoadingOlder = true;
  try {
    var data = await api('/api/bridge/messages', { session: sessionId, before: state.wsOldestTimestamp });
    var msgs = dedupeCodexUserMessages(data.messages || []);
    state.wsHasMore = data.hasMore;
    state.wsOldestTimestamp = data.oldestTimestamp || '';
    // Dedup and prepend
    var newMsgs = [];
    for (var i = 0; i < msgs.length; i++) {
      if (!trackMessageUuid(msgs[i])) continue;
      newMsgs.push(msgs[i]);
      state.wsMessageCount++;
    }
    if (newMsgs.length) {
      state.wsAllMessages = newMsgs.concat(state.wsAllMessages);
      state.wsRenderedCount += newMsgs.length;
    }
    return newMsgs;
  } finally {
    state.wsLoadingOlder = false;
  }
}

// Reconnect recovery
async function recoverMissing(after) {
  if (!state.wsSessionId) return null;
  if (after === undefined) after = state.wsLastTimestamp;
  if (state._wsBuffer !== null) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        recoverMissing(after).then(resolve);
      }, 100);
    });
  }
  try {
    var result = await bufferAndFetch(state.wsSessionId, after);
    if (!result.added) return result;
    var container = document.querySelector('.messages');
    if (container) {
      updateLastTurn(result.messages);
      loadImages(container);
      clampOverflow(container);
      if (window.renderMermaidBlocks) renderMermaidBlocks(container);
      if (window.renderKatexBlocks) renderKatexBlocks(container);
      container.parentElement.scrollTop = container.parentElement.scrollHeight;
    }
    showStats(state.wsMessageCount + ' messages (' + result.added + ' recovered)');
    return result;
  } catch (e) {
    return null;
  }
}

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var images = state.stagedImages.slice();

  if (!text && !images.length) return;
  if (!state.activeThreadCanSend) return;
  if (!images.length && handleCodexClientCommand(text, input)) return;
  if (!text && images.length) text = 'Please review the attached image';
  // Allow sending without wsSessionId for new sessions (projectHash is used)
  if (!state.wsSessionId && state.appState.session !== '__new__') return;
  // Agent sessions require at least 4 characters for the task description
  var agentCb = document.getElementById('newAsAgent');
  if (state.appState.session === '__new__' && agentCb && agentCb.checked && text.length < 4) return;

  // Images already uploaded — just assemble refs.
  // Keep image markdown refs on the SAME line as text (separated by spaces) — putting `!`
  // at line start triggers Ink's shell-out mode in CC, causing bash syntax errors.
  var readyImages = images.filter(function (img) { return img.uploaded && img.key; });
  if (readyImages.length) {
    var refs = readyImages.map(function (img) { return '![](baton-bridge:' + img.key + ')'; }).join(' ');
    doSend(text + ' ' + refs, text, readyImages);
  } else {
    doSend(text, text, []);
  }

  state.stagedImages = [];
  renderStagedImages();
  input.value = '';
  input.style.height = 'auto';
  if (typeof stopDictation === 'function') stopDictation();  // sending ends dictation too
  if (!/Mobi|Android/i.test(navigator.userAgent)) input.focus();
}

function handleCodexClientCommand(text, input) {
  if (state.appState.runtime !== 'codex') return false;
  var match = /^\/(copy|new|clear|resume|mention|exit)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return false;
  var command = match[1];
  var args = (match[2] || '').trim();
  if (command === 'new' || command === 'clear') {
    var project = state.appState.project;
    if (project && window.startNewSession) window.startNewSession(project.hash);
    input.value = '';
    input.style.height = 'auto';
    updateSendBtn();
    return true;
  }
  if (command === 'resume') {
    if (args && window.loadMessages) {
      window.loadMessages(args.indexOf('codex:') === 0 ? args : 'codex:' + args, args);
    } else if (window.navigateUp) {
      window.navigateUp();
    }
    input.value = '';
    input.style.height = 'auto';
    updateSendBtn();
    return true;
  }
  if (command === 'mention') {
    input.value = '@';
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    input.focus();
    updateSendBtn();
    return true;
  }
  if (command === 'exit') {
    if (window.navigateUp) window.navigateUp();
    input.value = '';
    input.style.height = 'auto';
    updateSendBtn();
    return true;
  }

  var response = '';
  for (var i = state.wsAllMessages.length - 1; i >= 0; i--) {
    var message = state.wsAllMessages[i];
    if (message.type !== 'assistant' || message._localCommand) continue;
    if (Array.isArray(message.content)) {
      response = message.content
        .filter(function (block) { return block && block.type === 'text'; })
        .map(function (block) { return block.text || ''; })
        .join('\n')
        .trim();
    } else if (typeof message.content === 'string') {
      response = message.content.trim();
    }
    if (response) break;
  }
  if (response && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(response).catch(function () {});
  } else if (response) {
    var copyArea = document.createElement('textarea');
    copyArea.value = response;
    copyArea.style.position = 'fixed';
    copyArea.style.opacity = '0';
    document.body.appendChild(copyArea);
    copyArea.select();
    try { document.execCommand('copy'); } catch (e) {}
    copyArea.remove();
  }
  input.value = '';
  input.style.height = 'auto';
  var original = input.placeholder;
  input.placeholder = response ? 'Copied last response' : 'No response to copy';
  setTimeout(function () { input.placeholder = original; }, 1600);
  updateSendBtn();
  return true;
}

// Textarea: Enter sends, Shift+Enter newline, auto-grow, toggle send/stop button
var _stopSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
var _sendSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
function updateSendBtn(options) {
  options = options || {};
  var btn = document.getElementById('send-btn');
  var textLen = document.getElementById('msg-input').value.trim().length;
  var agentCb = document.getElementById('newAsAgent');
  var isNewAgent = state.appState.session === '__new__' && agentCb && agentCb.checked;
  var hasText = textLen >= (isNewAgent ? 4 : 1);
  var cls = !state.activeThreadCanSend
    ? ''
    : (hasText ? 'has-text' : (state.wsRunning ? 'is-stop' : ''));
  var icon = cls === 'is-stop' ? 'stop' : 'send';
  // Only rewrite innerHTML when the icon actually changes. Rewriting it every stream frame
  // detaches the SVG mid-tap, dropping a click that landed on it (had to tap 2-3×).
  if (btn.dataset.icon !== icon) { btn.innerHTML = icon === 'stop' ? _stopSvg : _sendSvg; btn.dataset.icon = icon; }
  if (btn.className !== cls) btn.className = cls;
  btn.disabled = !state.activeThreadCanSend || (!hasText && !state.wsRunning);
  if (!options.skipSpinner && typeof updateSpinner === 'function') updateSpinner();
  if (typeof updateMicButton === 'function') updateMicButton();
}
function onSendBtnClick() {
  var input = document.getElementById('msg-input');
  var isMobile = /Mobi|Android/i.test(navigator.userAgent);
  var kbWasUp = isMobile && window.visualViewport && window.visualViewport.height < _vpBaseHeight * 0.75;
  // New-session first send: dismiss keyboard before the centered→bottom swap
  var isFirstNewSessionSend = document.body.classList.contains('new-session');

  if (input.value.trim()) {
    if (isMobile && kbWasUp && isFirstNewSessionSend) {
      input.blur();
      var doSendAfterKbDown = function () { sendMessage(); updateSendBtn(); };
      if (window.visualViewport) {
        var onResize = function () {
          if (window.visualViewport.height >= _vpBaseHeight * 0.95) {
            window.visualViewport.removeEventListener('resize', onResize);
            doSendAfterKbDown();
          }
        };
        window.visualViewport.addEventListener('resize', onResize);
        setTimeout(function () {
          window.visualViewport.removeEventListener('resize', onResize);
          doSendAfterKbDown();
        }, 350);
      } else {
        setTimeout(doSendAfterKbDown, 250);
      }
      return;
    }

    sendMessage();
    updateSendBtn();
    // Keep keyboard open on mobile after sending
    if (isMobile && kbWasUp) input.focus();
  } else if (state.wsRunning) {
    interruptSession();
  }

  if (isMobile && !kbWasUp) input.blur();
}
function interruptSession() {
  if (!state.wsSessionId) return;
  // A permission prompt owns the interrupt: cancelling it denies+interrupts CC, so don't also send a bare interrupt.
  if (typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt()) {
    cancelPermissionPrompt();
    return;
  }
  var activeTurnId = activeTurnForInterrupt();
  wsSendReliable({
    action: 'interrupt',
    sessionId: state.wsSessionId,
    device: state.appState.device || '',
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
  });
  state.wsRunning = hasOutstandingTurns();
  updateSendBtn();
}
(function () {
  var el = document.getElementById('msg-input');
  var restoreScrollFrame = null;
  function resizeInputPreservingMessages() {
    var content = document.getElementById('content');
    var preserveScroll = content
      && state.appState.session
      && state.appState.session !== '__new__';
    var previousScrollTop = preserveScroll ? content.scrollTop : 0;
    var followBottom = preserveScroll && (
      state.stickBottom
      || content.scrollHeight - content.scrollTop - content.clientHeight < 100
    );

    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';

    if (!preserveScroll) return;
    var restoreScroll = function () {
      content.scrollTop = followBottom ? content.scrollHeight : previousScrollTop;
    };
    restoreScroll();
    if (restoreScrollFrame !== null) cancelAnimationFrame(restoreScrollFrame);
    restoreScrollFrame = requestAnimationFrame(function () {
      restoreScrollFrame = null;
      restoreScroll();
    });
  }

  el.addEventListener('keydown', function (e) {
    // IME composition: Enter confirms the candidate, not a send. Sending here
    // clears the input, then compositionend re-fills it → duplicate send + leftover text.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); updateSendBtn(); }
  });
  el.addEventListener('input', function () {
    resizeInputPreservingMessages();
    // Typing changes only input controls. Runtime state changes update the
    // spinner through the existing no-argument updateSendBtn() calls.
    updateSendBtn({ skipSpinner: true });
  });
})();
// Global Esc → interrupt the running turn, like CC. Bubble phase so overlays
// that own Esc (slash popup handles it in capture phase; file/image viewers
// close first) keep priority — we only act when nothing else claimed the key.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
  // Yield to open overlays/modals that give Esc its own meaning.
  if (document.getElementById('permission-prompt')) return;
  var fileO = document.getElementById('fileOverlay');
  if (fileO && fileO.style.display === 'flex') return;
  var imgO = document.getElementById('imgOverlay');
  if (imgO && imgO.style.display === 'flex') return;
  var newP = document.getElementById('newProjectModal');
  if (newP && newP.style.display === 'flex') return;
  var takeover = document.getElementById('codexTakeoverModal');
  if (takeover && takeover.style.display === 'flex') return;
  if (!state.wsRunning) return;
  e.preventDefault();
  interruptSession();
});

var _sendOrder = 0;

function doSend(fullText, displayText, images) {
  var previousTurnId = latestOutstandingTurnId();
  state.wsRunning = true;
  var device = state.appState.device || '';
  // Unique per-send id, round-tripped through the bridge in send_message_result
  // so the ack maps back to THIS exact bubble (not "the first pending", which
  // mis-pairs when several sends are in flight). Doubles as the DOM element id.
  var seq = _sendOrder++;
  var sentAt = Date.now();
  var msgId = 'sent-' + (crypto.randomUUID
    ? crypto.randomUUID()
    : sentAt + '-' + Math.random().toString(36).slice(2));
  rememberLatestSend(msgId, false, seq);
  _queuedTurnIds.add(msgId);
  updateSendBtn();
  var sendPayload;
  if (state.appState.session === '__new__' && state.wsProjectHash) {
    if (!state.wsRequestId) {
      state.wsRequestId = crypto.randomUUID
        ? crypto.randomUUID()
        : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }
    var asAgent = state.appState.runtime === 'claude'
      && !!(document.getElementById('newAsAgent') && document.getElementById('newAsAgent').checked);
    sendPayload = { action: 'send_message', projectHash: state.wsProjectHash, requestId: state.wsRequestId, turnId: msgId, previousTurnId: previousTurnId, text: fullText, device: device, runtime: state.appState.runtime, asAgent: asAgent };
  } else {
    // projectHash lets the bridge resolve cwd even if the jsonl is gone (deleted session).
    var ph = state.appState.project && state.appState.project.hash;
    sendPayload = { action: 'send_message', sessionId: state.wsSessionId, projectHash: ph, turnId: msgId, previousTurnId: previousTurnId, text: fullText, device: device };
  }
  wsSendReliable(sendPayload);

  // Empty session has no .messages yet; create one or the bubble + preview have nowhere to render.
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();
  var contentEl = document.getElementById('content');
  if (contentEl && !contentEl.querySelector('.messages')) {
    contentEl.insertAdjacentHTML('beforeend', '<div class="messages"></div>');
  }

  // Exit new-session centered layout once the user sends the first message
  if (document.body.classList.contains('new-session')) {
    document.body.classList.remove('new-session');
    var hero = document.querySelector('.new-session-hero');
    if (hero) hero.remove();
    var msgs = document.querySelector('.messages');
    if (msgs) msgs.removeAttribute('hidden');
    // Restore input-bar to body (it was moved into #content for centered layout)
    var bar = document.getElementById('input-bar');
    if (bar && bar.parentElement !== document.body) document.body.appendChild(bar);
  }

  // Keep fullText (with image refs) so a retry re-sends the exact same payload;
  // sessionId pins the message to its session so a timeout that fires after the
  // user navigated away doesn't self-heal against the wrong conversation.
  // echoScanFrom: only user rows arriving AFTER this send count as its echo (else a historical same-text row false-retires the bubble — kills short/repeated sends).
  var pendingSend = { id: msgId, seq: seq, text: displayText, fullText: fullText, images: images, isImage: images.length > 0, sessionId: state.wsSessionId, sentAt: sentAt, echoScanFrom: state.wsAllMessages.length, sendPayload: sendPayload, serverReceived: false, transportRetries: 0 };
  state.pendingSentMessages.push(pendingSend);
  var container = document.querySelector('.messages');
  if (container) {
    var imgHtml = images.map(function (img) {
      return '<div class="img-placeholder loaded"><img src="' + img.dataUrl + '" onclick="viewImage(this.src)" /></div>';
    }).join('');
    var attachHtml = imgHtml ? '<div class="msg-attachments">' + imgHtml + '</div>' : '';
    // data-anchor is the durable placement id: survives echo promotion (unlike data-pending) so the reply lands here.
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '" data-pending="1" data-anchor="' + msgId + '">' + attachHtml
      + '<div class="msg-text" onclick="toggleExpand(this)">' + esc(displayText) + '</div>'
      + '<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>');
    clampOverflow(container);
    state.stickBottom = true; // sending a message = follow the incoming reply
    document.getElementById('content').scrollTo({ top: 99999, behavior: 'smooth' });
  }
  schedulePendingTransportRetry(pendingSend);
  scheduleSendTimeout(msgId);
}

// If neither the send_message_result ack nor the echoed-message dedup clears a
// pending bubble within this window, reconcile against the server: the message
// may well have reached CC and only the ack/echo was lost.
var SEND_TIMEOUT_MS = 12000;
var SERVER_RECEIPT_TIMEOUT_MS = window.__APEEK_TEST__ ? 20 : 2000;

function schedulePendingTransportRetry(pending) {
  if (!pending || pending.delivered || pending.transportRetries >= 1) return;
  clearTimeout(pending.transportTimer);
  pending.transportTimer = setTimeout(function () {
    if (pending.delivered || pending.serverReceived
      || pending.transportRetries >= 1) return;
    pending.transportRetries++;
    wsSendReliable(pending.sendPayload);
  }, SERVER_RECEIPT_TIMEOUT_MS);
}

function scheduleSendTimeout(msgId) {
  var timer = setTimeout(function () { reconcilePendingSend(msgId); }, SEND_TIMEOUT_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function findPending(msgId) {
  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    if (state.pendingSentMessages[i].id === msgId) return state.pendingSentMessages[i];
  }
  return null;
}

function removePending(pending) {
  clearTimeout(pending?.transportTimer);
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
}

var _codexTakeover = null;

function pendingStatus(pending, text, color) {
  var el = document.getElementById(pending.id);
  var status = el && el.querySelector('.sending-status');
  if (!status) return;
  status.textContent = text;
  status.style.color = color || '#d29922';
}

function handleCodexSendConflict(pending, msg) {
  var writer = msg.writer || {};
  if (msg.errorCode !== 'codex_active_writer'
    || writer.status !== 'running'
    || !writer.canTerminate
    || !writer.pid) return false;
  pending.awaitingTakeover = true;
  state.wsRunning = false;
  updateSendBtn();
  pendingStatus(pending, 'Waiting for confirmation');

  _codexTakeover = { pending: pending, writer: writer, sending: false };
  var modal = document.getElementById('codexTakeoverModal');
  if (!modal) return true;
  var desc = document.getElementById('codexTakeoverDesc');
  var error = document.getElementById('codexTakeoverError');
  var confirm = document.getElementById('codexTakeoverConfirm');
  var cancel = document.getElementById('codexTakeoverCancel');
  desc.textContent = (writer.label || 'A Codex terminal')
    + ' is running this session. Taking over will close it, send this message, and release the session when the turn finishes.';
  error.textContent = '';
  confirm.style.display = '';
  confirm.disabled = false;
  confirm.textContent = 'Take over and send';
  cancel.disabled = false;
  modal.style.display = 'flex';
  return true;
}

function finishCodexTakeover(pending) {
  if (!_codexTakeover || _codexTakeover.pending !== pending) return;
  pending.awaitingTakeover = false;
  _codexTakeover = null;
  var modal = document.getElementById('codexTakeoverModal');
  if (modal) modal.style.display = 'none';
}

function closeCodexTakeoverModal() {
  if (!_codexTakeover || _codexTakeover.sending) return;
  var pending = _codexTakeover.pending;
  finishCodexTakeover(pending);
  if (!pending.delivered) resolvePending(pending, false, 'Not sent');
}

function confirmCodexTakeover() {
  if (!_codexTakeover || _codexTakeover.sending) return;
  var pending = _codexTakeover.pending;
  var writer = _codexTakeover.writer;
  if (!writer?.canTerminate || !writer.pid || !pending.sendPayload) return;
  _codexTakeover.sending = true;
  pending.awaitingTakeover = false;
  state.wsRunning = true;
  updateSendBtn();
  pendingStatus(pending, 'Taking over Codex...');
  var confirm = document.getElementById('codexTakeoverConfirm');
  var cancel = document.getElementById('codexTakeoverCancel');
  if (confirm) {
    confirm.disabled = true;
    confirm.innerHTML = '<span class="spinner"></span>Taking over';
  }
  if (cancel) cancel.disabled = true;
  wsSendReliable(Object.assign({}, pending.sendPayload, {
    takeover: true,
    expectedWriterPid: writer.pid,
  }));
  scheduleSendTimeout(pending.id);
}

// Single terminal state for an ack. Success: stamp the bubble with a time and
// mark delivered — the bubble stays as the timestamped anchor; when the echoed
// copy arrives, tryDedup finds this delivered pending and drops the duplicate
// (see tryDedup). Failure: red "Not delivered · Retry" and stop the spinner.
function resolvePending(pending, ok, error) {
  clearTimeout(pending.transportTimer);
  pending.queued = false;
  pending.delivered = true;
  pending.failed = !ok;
  if (ok) {
    markPendingTime(pending);
  } else {
    _queuedTurnIds.delete(pending.id);
    rememberLatestSend(pending.id, true);
    markPendingFailed(pending, error);
    state.wsRunning = hasOutstandingTurns();
    updateSendBtn();
  }
}

function completeLocalCommand(pending, result) {
  _queuedTurnIds.delete(pending.id);
  markPendingTime(pending);
  promoteEchoedBubble(pending, { timestamp: new Date().toISOString() });
  var output = String(result.commandOutput || '');
  var message = {
    uuid: 'codex-command:' + pending.id,
    nativeId: 'codex:command:' + pending.id,
    turnId: pending.id,
    type: 'assistant',
    content: [{ type: 'text', text: output }],
    timestamp: new Date().toISOString(),
    _localCommand: true,
    _commandPanel: result.commandPanel
      ? Object.assign({ rawText: output }, result.commandPanel)
      : null,
  };
  if (trackMessageUuid(message)) {
    state.wsAllMessages.push(message);
    state.wsMessageCount++;
    updateLastTurn();
  }
  state.wsRunning = hasOutstandingTurns();
  updateSendBtn();
}

function applyCodexCommandAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'open-session' && action.sessionId && window.loadMessages) {
    window.loadMessages(action.sessionId, action.preview || '');
  } else if (action.type === 'leave-session' && window.navigateUp) {
    window.navigateUp();
  }
}

// A durable echo belongs to a pending bubble only through its exact turn id.
function messageEchoed(pending) {
  // Scan only rows after this send (echoScanFrom); a historical same-text row isn't its echo.
  var from = pending.echoScanFrom || 0;
  for (var i = from; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type !== 'user' || isInterruptMsg(m) || isToolResultOnly(m)) continue;
    if (m.turnId === pending.id || m.nativeId === 'codex:user:' + pending.id) return m;
  }
  return null;
}

// Retire an optimistic bubble only when its own echo arrives. A later send can
// acknowledge first because API Gateway invokes send handlers concurrently, so
// cross-send sequence watermarks cannot prove an earlier send was lost. Messages
// without an echo are reconciled by their own SEND_TIMEOUT_MS timer.
function reconcileEchoedPending() {
  for (var i = state.pendingSentMessages.length - 1; i >= 0; i--) {
    var pending = state.pendingSentMessages[i];
    var echoed = messageEchoed(pending);
    if (!echoed) continue;
    promoteEchoedBubble(pending, echoed);
  }
}

function settlePendingAtTurnEnd(turnId) {
  var pending = findPending(turnId);
  if (!pending || pending.failed) return false;
  promoteEchoedBubble(pending, {});
  return true;
}

function markPendingTime(pending) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var sentAt = new Date(pending.sentAt || Date.now());
  el.dataset.ts = sentAt.toISOString();
  var status = el.querySelector('.sending-status');
  if (status) {
    status.textContent = sentAt.toLocaleTimeString();
    status.style.color = '#6e7681';
  }
}

function markPendingFailed(pending, error) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var status = el.querySelector('.sending-status');
  if (!status) return;
  var label = error ? esc(error) : 'Not delivered';
  status.innerHTML = label + ' · <span class="send-retry" onclick="retryPendingSend(\'' + pending.id + '\')">Retry</span>';
  status.style.color = '#f85149';
}

// Timeout reconciliation: only acts if the bubble is still pending (ack/dedup
// didn't already resolve it). Pulls latest messages from DDB, then either
// self-heals (message arrived, ack/echo was just lost) or flags for retry.
async function reconcilePendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // already resolved
  if (pending.queued) return;                              // accepted into the Bridge's causal queue
  if (pending.awaitingTakeover) return;                    // user has not chosen whether to take over
  if (pending.sessionId !== state.wsSessionId) return;     // user navigated away; leave it
  var remaining = SEND_TIMEOUT_MS - (Date.now() - (pending.sentAt || 0));
  if (remaining > 50) {
    setTimeout(function () { reconcilePendingSend(msgId); }, remaining);
    return;
  }
  try { await bufferAndFetch(state.wsSessionId, state.wsLastTimestamp); } catch (e) {}
  pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // ack/dedup fired during the fetch
  // Message actually landed (ack/echo just lost) → success; else flag for retry.
  resolvePending(pending, messageEchoed(pending), null);
}

// Manual retry: re-check the server first (avoid double-send if it actually
// landed), then re-send the exact original payload as a fresh pending bubble.
async function retryPendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending) return;
  try { await bufferAndFetch(state.wsSessionId, state.wsLastTimestamp); } catch (e) {}
  if (messageEchoed(pending)) { resolvePending(pending, true, null); return; }
  // Remove the failed bubble + its pending record, then re-send from scratch.
  var el = document.getElementById(pending.id);
  if (el) el.remove();
  removePending(pending);
  doSend(pending.fullText, pending.text, pending.images || []);
}

// ---- Message dedup utilities ----

/** Extract plain text from a message's content field */
function extractMsgText(msg) {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    var tb = msg.content.find(function (c) { return c.type === 'text'; });
    return tb ? (tb.text || '') : '';
  }
  return '';
}

/** Match a user echo to its pending bubble and promote in place. Returns true when handled (caller skips insert). */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;

  var exactTurnId = msg.turnId || '';
  if (!exactTurnId && typeof msg.nativeId === 'string'
    && msg.nativeId.indexOf('codex:user:') === 0) {
    exactTurnId = msg.nativeId.slice('codex:user:'.length);
  }
  if (exactTurnId) {
    msg.turnId = exactTurnId;
    var byId = findPending(exactTurnId);
    if (byId) { promoteEchoedBubble(byId, msg); return true; }
    var anchor = document.querySelector('[data-anchor="' + exactTurnId + '"]');
    // The rollout and live Codex user rows can use different native ids
    // (turn id vs client id). Once either has promoted this exact stream's
    // durable anchor, the other is only a duplicate echo.
    if (anchor && !anchor.hasAttribute('data-pending')) return true;
    // A scoped echo belongs to another tab or its ack mapping has not arrived
    // yet. Never text-match it against a different pending send.
    return false;
  }

  // Unscoped echoes are never allowed to claim an optimistic bubble.
  return false;
}

// Promote the optimistic bubble in place (never remove+re-insert): its [data-anchor] must survive so anchorForStream still finds it.
function promoteEchoedBubble(pending, msg) {
  clearTimeout(pending.transportTimer);
  // The authoritative echo can beat the final send ack. Settle the visible
  // optimistic bubble from its original send time before retiring its pending
  // record, so rapid sends never show ack-arrival order as their timestamps.
  markPendingTime(pending);
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
  var el = document.getElementById(pending.id);
  if (el) {
    if (msg.timestamp) {
      el.dataset.serverTs = msg.timestamp;
    }
    el.removeAttribute('data-pending');
  }
}

// Function bridges for inline HTML handlers + IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  updateTitleFromMessages,
  connectWs, subscribeSession, wsSend, wsSendReliable, setWsStatus, disconnectWs, ensureWsAndSend,
  resumeSessionForeground,
  startWs, bufferAndFetch, loadOlderMessages, recoverMissing,
  resolveSessionRunningAfterFetch,
  findInsertBefore, insertAtTimestamp, updateLastTurn,
  sendMessage, updateSendBtn, onSendBtnClick, interruptSession, doSend,
  closeCodexTakeoverModal, confirmCodexTakeover,
  extractMsgText, tryDedup, retryPendingSend, isInheritedAgentContext,
});

// Test-only hook for replaying the real WS dispatcher.
if (typeof window !== 'undefined' && window.__APEEK_TEST__) {
  window.__wsTest = {
    handleWsMessage: handleWsMessage,
    flushLateJoinCompletion: completeLateJoinTurn,
    resumeLateJoinAtCheckpoint: resumeLateJoinAtCheckpoint,
    beginSessionConnectionRecovery: beginSessionConnectionRecovery,
    startSessionConnectionRecovery: startSessionConnectionRecovery,
    updateLastTurn: updateLastTurn,
  };
}
