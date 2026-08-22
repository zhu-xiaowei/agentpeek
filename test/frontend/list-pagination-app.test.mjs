import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { LIST_PAGE_SIZE } from '../../web/js/list-pagination.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TWO_PAGES = LIST_PAGE_SIZE * 2;

function deferred() {
  var resolve;
  var promise = new Promise(function (done) { resolve = done; });
  return { promise, resolve };
}

function session(id) {
  var item = {
    sessionId: `s${id}`,
    preview: id === TWO_PAGES
      ? '{"action":"send_message","text":"quoted title"}'
      : `Session ${id}`,
    lastActive: new Date(Date.UTC(2026, 7, 10, 0, 0, id)).toISOString(),
    size: id,
    model: 'test-model',
    status: 'completed',
    activeStatus: id === TWO_PAGES ? 'running' : 'completed',
    agentCount: id === TWO_PAGES ? 3 : 0,
    isAgent: id === TWO_PAGES,
  };
  if (id === TWO_PAGES - 1) {
    item.activeStatus = 'needs_input';
    item.agentDetail = 'Child detail must stay hidden';
  }
  if (id === TWO_PAGES - 2) {
    item.status = 'needs_input';
    item.activeStatus = 'needs_input';
    item.agentDetail = 'Approve Main request';
  }
  return item;
}

function project(id) {
  return {
    projectHash: `p${id}`,
    projectName: `Project ${id}`,
    projectPath: `/workspace/p${id}`,
    sessionCount: id,
    runningCount: 0,
    needsInputCount: 0,
    lastActive: new Date(Date.UTC(2026, 7, 10, 0, 0, id)).toISOString(),
  };
}

async function waitFor(predicate) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error('Timed out waiting for list update');
}

test('session and project lists paginate, cache page one, and restore loaded pages on return', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div><div id="content"></div>'
      + '<div id="input-bar"></div><button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true }
  );
  const window = dom.window;
  const content = window.document.getElementById('content');
  Object.defineProperty(content, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get() { return content.querySelectorAll('.list > .item[data-id]').length * 64; },
  });
  window.Element.prototype.scrollTo = function (options) {
    this.scrollTop = typeof options === 'object' ? options.top : arguments[1];
  };

  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame: clearTimeout,
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.__APEEK_TEST__ = true;
  window.__setTopSync = function () {};
  window.loadViewerLibs = function () { return new Promise(function () {}); };

  const calls = [];
  const returnRefresh = deferred();
  const staleSessions = deferred();
  var mainFirstPageCalls = 0;

  async function api(pathname, params) {
    calls.push({ pathname, params: { ...params } });
    if (pathname === '/api/bridge/sessions' && params.project === 'P') {
      if (params.cursor === 'page-2') {
        return {
          sessions: Array.from({ length: LIST_PAGE_SIZE }, function (_, i) {
            return session(LIST_PAGE_SIZE - i);
          }),
          hasMore: false,
          nextCursor: null,
        };
      }
      mainFirstPageCalls += 1;
      if (mainFirstPageCalls === 1) {
        return {
          sessions: Array.from({ length: LIST_PAGE_SIZE }, function (_, i) {
            return session(TWO_PAGES - i);
          }),
          hasMore: true,
          nextCursor: 'page-2',
        };
      }
      return returnRefresh.promise;
    }
    if (pathname === '/api/bridge/sessions' && params.project === 'P2') {
      return staleSessions.promise;
    }
    if (pathname === '/api/bridge/projects') {
      if (params.cursor === 'project-page-2') {
        return {
          projects: Array.from({ length: 10 }, function (_, i) { return project(10 - i); }),
          hasMore: false,
          nextCursor: null,
        };
      }
      return {
        projects: Array.from({ length: LIST_PAGE_SIZE }, function (_, i) {
          return project(LIST_PAGE_SIZE + 10 - i);
        }),
        hasMore: true,
        nextCursor: 'project-page-2',
      };
    }
    throw new Error(`Unexpected request: ${pathname}`);
  }

  Object.assign(globalThis, {
    api,
    disconnectWs: function () {},
    updateSpinner: function () {},
    skeletonItems: function (count) {
      return Array.from({ length: count }, function () { return '<div class="skeleton-item"></div>'; }).join('');
    },
    skeletonMessages: function () { return '<div class="skeleton-messages"></div>'; },
  });
  Object.assign(window, {
    api,
    disconnectWs: globalThis.disconnectWs,
    updateSpinner: globalThis.updateSpinner,
    skeletonItems: globalThis.skeletonItems,
    skeletonMessages: globalThis.skeletonMessages,
  });

  const vite = await createServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const stateModule = await vite.ssrLoadModule('/js/state.js');
    const state = stateModule.state;
    state.rootSessionId = 'root';
    assert.equal(window.__listTest.agentStatus([
      { sessionId: 'root', status: 'running' },
      { sessionId: 'child', status: 'completed' },
    ]), 'completed');
    assert.equal(window.__listTest.agentStatus([
      { sessionId: 'root', status: 'completed' },
      { sessionId: 'child', status: 'running' },
    ]), 'running');
    assert.equal(window.__listTest.agentStatus([
      { sessionId: 'root', status: 'running' },
      { sessionId: 'child-a', status: 'running' },
      { sessionId: 'child-b', status: 'needs_input' },
    ]), 'needs-input');

    await window.loadSessions('D', 'P', 'Project');
    assert.equal(content.querySelectorAll('.item[data-id]').length, LIST_PAGE_SIZE);
    assert.deepEqual(calls[0].params, { device: 'D', project: 'P', limit: LIST_PAGE_SIZE });
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES}"]`).dataset.preview,
      '{"action":"send_message","text":"quoted title"}',
    );
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES}"] .badge.agent`).textContent,
      '3 agents',
    );
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES}"] .badge.running`).textContent,
      'Running',
    );
    assert.deepEqual(
      Array.from(content.querySelector(`[data-id="s${TWO_PAGES}"] .session-badges`).children, function (element) {
        if (element.classList.contains('agent')) return 'agent';
        if (element.classList.contains('running')) return 'status';
        if (element.classList.contains('runtime-mark')) return 'runtime';
        return 'unknown';
      }),
      ['agent', 'status', 'runtime'],
    );
    assert.deepEqual(
      Array.from(content.querySelectorAll(`[data-id="s${TWO_PAGES}"] .badge.agent`), function (element) {
        return element.textContent;
      }),
      ['3 agents'],
    );
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES - 1}"] .badge.idle`).textContent,
      'Needs input',
    );
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES - 1}"] .session-detail-view`),
      null,
    );
    assert.equal(
      content.querySelector(`[data-id="s${TWO_PAGES - 2}"] .session-detail-view`).textContent,
      'Approve Main request',
    );

    content.scrollTop = 1700;
    content.dispatchEvent(new window.Event('scroll'));
    content.dispatchEvent(new window.Event('scroll'));
    await waitFor(function () {
      return content.querySelectorAll('.item[data-id]').length === TWO_PAGES;
    });
    assert.equal(calls.filter(function (call) {
      return call.pathname === '/api/bridge/sessions' && call.params.cursor === 'page-2';
    }).length, 1);
    content.dispatchEvent(new window.Event('scroll'));
    assert.equal(calls.filter(function (call) {
      return call.pathname === '/api/bridge/sessions' && call.params.cursor === 'page-2';
    }).length, 1);

    window.__listTest.select('session', 's25');
    assert.equal(content.querySelectorAll('.sel-box').length, TWO_PAGES);
    assert.equal(window.document.getElementById('top-right').classList.contains('select-actions'), true);
    window.exitSelectMode();
    assert.equal(window.document.getElementById('top-right').classList.contains('select-actions'), false);

    content.scrollTop = 3900;
    content.dispatchEvent(new window.Event('scroll'));
    const selected = content.querySelector('[data-id="s25"]');
    window.openSession(selected);
    window.navigateUp();

    assert.equal(content.querySelectorAll('.item[data-id]').length, TWO_PAGES);
    assert.equal(content.scrollTop, 3900);
    assert.equal(mainFirstPageCalls, 2);

    returnRefresh.resolve({
      sessions: [session(TWO_PAGES + 1)].concat(
        Array.from({ length: LIST_PAGE_SIZE - 1 }, function (_, i) {
          return session(TWO_PAGES - i);
        })
      ),
      hasMore: true,
      nextCursor: 'new-page-2',
    });
    await waitFor(function () {
      return content.querySelector('[data-id="s' + (TWO_PAGES + 1) + '"]');
    });

    assert.equal(content.querySelectorAll('.item[data-id]').length, TWO_PAGES + 1);
    assert.equal(content.scrollTop, 0);
    assert.equal(calls.filter(function (call) {
      return call.pathname === '/api/bridge/sessions' && call.params.cursor === 'page-2';
    }).length, 1);
    const cached = JSON.parse(localStorage.getItem('apeek_list_cache_v2:sessions:D:P'));
    assert.equal(cached.sessions.length, LIST_PAGE_SIZE);

    await window.loadProjects('D');
    assert.equal(content.querySelectorAll('.item[data-id]').length, LIST_PAGE_SIZE);
    const projectCall = calls.find(function (call) {
      return call.pathname === '/api/bridge/projects';
    });
    assert.deepEqual(projectCall.params, { device: 'D', limit: LIST_PAGE_SIZE });
    content.scrollTop = 1700;
    content.dispatchEvent(new window.Event('scroll'));
    await waitFor(function () {
      return content.querySelectorAll('.item[data-id]').length === LIST_PAGE_SIZE + 10;
    });
    assert.equal(calls.filter(function (call) {
      return call.pathname === '/api/bridge/projects' && call.params.cursor === 'project-page-2';
    }).length, 1);

    await window.loadSessions('D', 'P', 'Project');
    assert.equal(content.querySelectorAll('.item[data-id]').length, LIST_PAGE_SIZE);
    assert.equal(content.scrollTop, 0);
    assert.equal(window.__listTest.get('sessions:D:P').items.length, LIST_PAGE_SIZE);

    await window.loadProjects('D');
    assert.equal(content.querySelectorAll('.item[data-id]').length, LIST_PAGE_SIZE + 10);

    window.loadSessions('D', 'P2', 'Other');
    await window.loadProjects('D');
    staleSessions.resolve({
      sessions: [session(999)],
      hasMore: false,
      nextCursor: null,
    });
    await new Promise(function (resolve) { setTimeout(resolve, 10); });

    assert.equal(window.__listTest.activeKey(), 'projects:D');
    assert.equal(state.appState.project, null);
    assert.equal(content.querySelector('[data-id="s999"]'), null);
    assert.ok(content.querySelector('[data-id="p60"]'));
  } finally {
    await vite.close();
    dom.window.close();
  }
});
