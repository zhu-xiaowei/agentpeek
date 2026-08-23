import { state } from './state.js';
import '../css/edge-back.css';

var renderedState = window.__inlineRendered
  ? { device: null, project: null, session: null, sessionPreview: '' }
  : null;
var navigationStack = [];
var restoringNavigation = false;
var PAGE_PREVIEW_KEY = 'baton-page-preview';
var edgeBackLayers = [];
var edgeGuardRefreshers = [];

function activeEdgeBackLayer() {
  for (var i = edgeBackLayers.length - 1; i >= 0; i--) {
    if (edgeBackLayers[i].active) return edgeBackLayers[i];
  }
  return null;
}

function refreshEdgeGuards() {
  var layer = activeEdgeBackLayer();
  edgeGuardRefreshers.forEach(function (refresh) { refresh(layer); });
}

// Full-screen surfaces can reuse the same native edge-back gesture without
// duplicating pointer logic. The most recently activated layer wins.
export function registerEdgeBackLayer(options) {
  options = options || {};
  var layer = {
    active: false,
    navigateBack: options.navigateBack,
    foregroundSelectors: options.foregroundSelectors || [],
    guardZIndex: options.guardZIndex || 1001,
  };
  edgeBackLayers.push(layer);
  return {
    activate: function () {
      layer.active = true;
      var index = edgeBackLayers.indexOf(layer);
      if (index >= 0) {
        edgeBackLayers.splice(index, 1);
        edgeBackLayers.push(layer);
      }
      refreshEdgeGuards();
    },
    deactivate: function () {
      layer.active = false;
      refreshEdgeGuards();
    },
    unregister: function () {
      var index = edgeBackLayers.indexOf(layer);
      if (index >= 0) edgeBackLayers.splice(index, 1);
      refreshEdgeGuards();
    },
  };
}
window.registerEdgeBackLayer = registerEdgeBackLayer;

function routeKey(appState) {
  if (!appState.device) return 'devices';
  if (!appState.project) return 'projects:' + encodeURIComponent(appState.device);
  if (!appState.session) {
    return 'sessions:' + encodeURIComponent(appState.device) + ':' + encodeURIComponent(appState.project.hash);
  }
  return 'session:' + encodeURIComponent(appState.device) + ':'
    + encodeURIComponent(appState.project.hash) + ':' + encodeURIComponent(appState.session);
}

function cloneNavState(appState) {
  return {
    device: appState.device || null,
    project: appState.project
      ? { hash: appState.project.hash, name: appState.project.name }
      : null,
    session: appState.session || null,
    sessionPreview: appState.sessionPreview || '',
    isAgent: !!appState.isAgent
  };
}

function captureCurrentPage() {
  if (!renderedState || renderedState.session) return null;

  var topBar = document.querySelector('body > .top-bar');
  var breadcrumb = document.getElementById('breadcrumb');
  var content = document.getElementById('content');
  if (!topBar || !breadcrumb || !content || !content.firstChild) return null;

  return {
    topBarHtml: topBar.innerHTML,
    breadcrumbHtml: breadcrumb.innerHTML,
    breadcrumbDisplay: breadcrumb.style.display,
    contentHtml: content.innerHTML,
    scrollTop: content.scrollTop
  };
}

export function savePagePreview() {
  var snapshot = captureCurrentPage();
  if (!snapshot) {
    sessionStorage.removeItem(PAGE_PREVIEW_KEY);
    return;
  }
  try {
    sessionStorage.setItem(PAGE_PREVIEW_KEY, JSON.stringify(snapshot));
  } catch (e) {
    sessionStorage.removeItem(PAGE_PREVIEW_KEY);
  }
}

function navigationDepth(appState) {
  if (appState.session) return 3;
  if (appState.project) return 2;
  if (appState.device) return 1;
  return 0;
}

function ancestorStates(appState) {
  var ancestors = [];
  var depth = navigationDepth(appState);
  if (depth > 0) {
    ancestors.push({ device: null, project: null, session: null, sessionPreview: '' });
  }
  if (depth > 1) {
    ancestors.push({ device: appState.device, project: null, session: null, sessionPreview: '' });
  }
  if (depth > 2) {
    ancestors.push({
      device: appState.device,
      project: { hash: appState.project.hash, name: appState.project.name },
      session: null,
      sessionPreview: ''
    });
  }
  return ancestors;
}

function rebuildAncestorStack(targetState) {
  var existing = {};
  for (var i = 0; i < navigationStack.length; i++) {
    existing[navigationStack[i].key] = navigationStack[i];
  }
  navigationStack = ancestorStates(targetState).map(function (ancestor) {
    var key = routeKey(ancestor);
    return existing[key] || { key: key, state: cloneNavState(ancestor), snapshot: null };
  });
}

export function prepareNavigation(targetState) {
  if (restoringNavigation) {
    restoringNavigation = false;
    return;
  }
  if (!renderedState) return;

  var currentKey = routeKey(renderedState);
  var targetKey = routeKey(targetState);
  if (currentKey === targetKey) return;

  if (navigationDepth(targetState) > navigationDepth(renderedState)) {
    var snapshot = captureCurrentPage();
    if (snapshot) {
      navigationStack.push({
        key: currentKey,
        state: cloneNavState(renderedState),
        snapshot: snapshot
      });
    }
    return;
  }

  var targetIndex = -1;
  for (var i = navigationStack.length - 1; i >= 0; i--) {
    if (navigationStack[i].key === targetKey) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex >= 0) navigationStack.length = targetIndex;
  else rebuildAncestorStack(targetState);
}

export function markCurrentRoute(appState) {
  renderedState = cloneNavState(appState);
}

export function takePreviousNavigation() {
  if (!navigationStack.length) return null;
  restoringNavigation = true;
  return cloneNavState(navigationStack.pop().state);
}

export function attachEdgeBackGesture(navigateUp, preparePrevious, options) {
  options = options || {};
  var pageMode = !!options.pageMode;
  if (!window.__BATON_NATIVE_MOBILE__) return;

  var tracking = false;
  var claimed = false;
  var settling = false;
  var selectionOnly = false;
  var hierarchyOnly = false;
  var startX = 0;
  var startY = 0;
  var lastX = 0;
  var lastTime = 0;
  var velocityX = 0;
  var suppressClickUntil = 0;
  var underlay = null;
  var shadow = null;
  var foreground = [];
  var settleTimer = null;
  var edgeGuard = null;
  var gestureLayer = null;

  function hasOpenOverlay() {
    var overlays = document.querySelectorAll('.modal-overlay, .mermaid-fs-overlay, .file-overlay, .img-overlay');
    for (var i = 0; i < overlays.length; i++) {
      if (getComputedStyle(overlays[i]).display !== 'none') return true;
    }
    return false;
  }

  function removeIds(root) {
    root.removeAttribute('id');
    root.querySelectorAll('[id]').forEach(function (el) { el.removeAttribute('id'); });
  }

  function makeUnderlay(snapshot) {
    var layer = document.createElement('div');
    layer.className = 'edge-back-underlay';

    var topBar = document.createElement('div');
    topBar.className = 'top-bar';
    topBar.innerHTML = snapshot.topBarHtml;

    var breadcrumb = document.createElement('div');
    breadcrumb.className = 'breadcrumb';
    breadcrumb.style.display = snapshot.breadcrumbDisplay;
    breadcrumb.innerHTML = snapshot.breadcrumbHtml;

    var content = document.createElement('div');
    content.className = 'edge-back-content';
    content.innerHTML = snapshot.contentHtml;

    removeIds(topBar);
    removeIds(breadcrumb);
    removeIds(content);
    layer.append(topBar, breadcrumb, content);
    document.body.insertBefore(layer, document.body.firstChild);
    content.scrollTop = snapshot.scrollTop;
    return layer;
  }

  function setOffset(px) {
    document.body.style.setProperty('--edge-back-x', px + 'px');
  }

  function beginSwipe(snapshot, dx, selectors) {
    if (snapshot) underlay = makeUnderlay(snapshot);
    selectors = selectors || options.foregroundSelectors || [
      'body > .top-bar',
      '#breadcrumb',
      '#content',
      '#input-bar',
      '#scroll-bottom-btn'
    ];
    var candidates = selectors.map(function (selector) {
      return document.querySelector(selector);
    }).filter(Boolean);
    foreground = candidates.filter(function (el) {
      return !candidates.some(function (parent) { return parent !== el && parent.contains(el); });
    });
    foreground.forEach(function (el) { el.classList.add('edge-back-foreground'); });

    shadow = document.createElement('div');
    shadow.className = 'edge-back-shadow';
    document.body.appendChild(shadow);
    document.body.classList.add('edge-back-active');
    setOffset(dx);
  }

  function cleanupSwipe() {
    clearTimeout(settleTimer);
    settleTimer = null;
    foreground.forEach(function (el) { el.classList.remove('edge-back-foreground'); });
    foreground = [];
    if (underlay) underlay.remove();
    if (shadow) shadow.remove();
    underlay = null;
    shadow = null;
    document.body.classList.remove('edge-back-active', 'edge-back-settling');
    document.body.style.removeProperty('--edge-back-x');
    settling = false;
    gestureLayer = null;
  }

  function settleSwipe(complete) {
    if (settling) return;
    settling = true;
    document.body.classList.add('edge-back-settling');
    setOffset(complete ? window.innerWidth : 0);

    settleTimer = setTimeout(function () {
      if (complete) {
        if (gestureLayer && typeof gestureLayer.navigateBack === 'function') {
          gestureLayer.navigateBack();
        } else {
          navigateUp();
        }
        if (gestureLayer || !pageMode) {
          requestAnimationFrame(function () {
            requestAnimationFrame(cleanupSwipe);
          });
        }
      } else {
        cleanupSwipe();
      }
    }, 230);
  }

  document.addEventListener('pointerdown', function (e) {
    gestureLayer = activeEdgeBackLayer();
    if (settling || e.pointerType === 'mouse' || e.clientX > 24) return;
    if (!gestureLayer && hasOpenOverlay()) return;
    if (e.target !== edgeGuard) return;
    if (!gestureLayer && !pageMode && !state.selectMode && !state.appState.device) return;
    tracking = true;
    claimed = false;
    selectionOnly = !gestureLayer && !pageMode && state.selectMode;
    hierarchyOnly = false;
    startX = e.clientX;
    startY = e.clientY;
    lastX = e.clientX;
    lastTime = e.timeStamp;
    velocityX = 0;
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!tracking) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    if (!claimed && (dx < 0 || (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10))) {
      tracking = false;
      return;
    }
    if (!claimed && dx > 10 && dx >= Math.abs(dy)) {
      if (gestureLayer) {
        claimed = true;
        beginSwipe(null, dx, gestureLayer.foregroundSelectors);
      } else {
        var previous = navigationStack[navigationStack.length - 1];
        var snapshot = !selectionOnly && previous && previous.snapshot;
        if (!selectionOnly && !snapshot) {
          if (typeof preparePrevious === 'function') {
            snapshot = preparePrevious(previous ? cloneNavState(previous.state) : null);
          }
          hierarchyOnly = !snapshot;
        }
        claimed = true;
        if (snapshot) beginSwipe(snapshot, dx);
      }
    }
    if (!claimed) return;

    e.preventDefault();
    var elapsed = e.timeStamp - lastTime;
    if (elapsed > 0) {
      var instantVelocity = (e.clientX - lastX) / elapsed;
      velocityX = velocityX * 0.65 + instantVelocity * 0.35;
    }
    lastX = e.clientX;
    lastTime = e.timeStamp;
    if (!selectionOnly && !hierarchyOnly) {
      setOffset(Math.min(window.innerWidth, Math.max(0, dx)));
    }
  }, { capture: true, passive: false });

  document.addEventListener('pointerup', function (e) {
    if (!tracking) return;
    var dx = e.clientX - startX;
    var dy = e.clientY - startY;
    tracking = false;
    if (!claimed) return;
    e.preventDefault();
    suppressClickUntil = performance.now() + 400;
    if (selectionOnly || hierarchyOnly) {
      if (dx >= 72 && dx >= Math.abs(dy)) navigateUp();
      return;
    }
    if (e.timeStamp - lastTime > 80) velocityX = 0;
    settleSwipe(dx >= Math.abs(dy)
      && (dx > window.innerWidth * 0.32 || (dx > 44 && velocityX > 0.45)));
  }, true);

  document.addEventListener('pointercancel', function () {
    var wasTracking = tracking;
    tracking = false;
    if (wasTracking && claimed && !selectionOnly && !hierarchyOnly) settleSwipe(false);
  }, true);

  document.addEventListener('click', function (e) {
    if (performance.now() >= suppressClickUntil) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  edgeGuard = document.createElement('div');
  edgeGuard.className = 'edge-back-guard';
  document.body.appendChild(edgeGuard);
  var refreshGuard = function (layer) {
    edgeGuard.style.zIndex = layer ? String(layer.guardZIndex) : '';
  };
  edgeGuardRefreshers.push(refreshGuard);
  refreshGuard(activeEdgeBackLayer());
}

export function attachPageEdgeBackGesture(navigateBack, foregroundSelectors) {
  var snapshot = null;
  try {
    snapshot = JSON.parse(sessionStorage.getItem(PAGE_PREVIEW_KEY) || 'null');
  } catch (e) {}
  attachEdgeBackGesture(navigateBack, function () { return snapshot; }, {
    pageMode: true,
    foregroundSelectors: foregroundSelectors
  });
}
