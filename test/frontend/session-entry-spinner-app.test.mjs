import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('session entry replaces the skeleton with a stable message container', async () => {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"></div></div>'
      + '<div id="breadcrumb"></div><div id="content"></div>'
      + '<div id="input-bar"><textarea id="msg-input"></textarea><button id="send-btn"></button></div>'
      + '<button id="scroll-bottom-btn"></button>'
      + '</body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
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
    requestAnimationFrame: function (callback) { return setTimeout(callback, 0); },
    cancelAnimationFrame: clearTimeout,
  });
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.__homeLoadPromise = new Promise(function () {});
  window.loadViewerLibs = async function () {};

  var spinnerStates = [];
  function updateSpinner() {
    spinnerStates.push({
      running: state.wsRunning,
      skeleton: !!document.querySelector('.skeleton-messages'),
      messages: !!document.querySelector('.messages:not(.skeleton-messages)'),
    });
  }
  function skeletonMessages() {
    return '<div class="messages skeleton-messages"></div>';
  }
  function renderMessages(messages) {
    return messages.map(function (message) {
      return '<div class="msg-user">' + message.content + '</div>';
    }).join('');
  }
  var fetchedMessages = [{
      uuid: 'user-1',
      type: 'user',
      content: 'hello',
      timestamp: '2026-08-19T00:00:00.000Z',
  }];
  async function bufferAndFetch() {
    state.wsAllMessages.push(...fetchedMessages);
    state.wsMessageCount = fetchedMessages.length;
    return {
      added: fetchedMessages.length,
      hasMore: false,
      messages: state.wsAllMessages.slice(),
      needSync: false,
      status: fetchedMessages.length ? 'running' : 'idle',
      liveLifecycleChanged: false,
    };
  }

  Object.assign(globalThis, {
    bufferAndFetch,
    clampOverflow: function () {},
    dismissPermissionPrompt: function () {},
    loadImages: function () {},
    renderMessages,
    resolveSessionRunningAfterFetch: function (result) {
      return result.status === 'running';
    },
    showInputBar: function () {},
    showStats: function () {},
    skeletonMessages,
    startWs: function () {},
    updateSendBtn: function () {},
    updateSpinner,
    updateTitleFromMessages: function () {},
  });
  Object.assign(window, {
    bufferAndFetch,
    dismissPermissionPrompt: globalThis.dismissPermissionPrompt,
    renderMessages,
    resolveSessionRunningAfterFetch: globalThis.resolveSessionRunningAfterFetch,
    skeletonMessages,
    startWs: globalThis.startWs,
    updateSendBtn: globalThis.updateSendBtn,
    updateSpinner,
    updateTitleFromMessages: globalThis.updateTitleFromMessages,
  });

  const vite = await createServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  var state;
  try {
    await vite.ssrLoadModule('/js/app.js');
    state = (await vite.ssrLoadModule('/js/state.js')).state;
    state.appState = {
      device: 'D',
      project: { hash: 'P', name: 'Project' },
      session: null,
      sessionPreview: '',
      runtime: 'claude',
    };

    await window.loadMessages('session-1', 'Session');

    assert.equal(state.wsRunning, true);
    assert.equal(document.querySelector('.skeleton-messages'), null);
    assert.ok(
      document.querySelector('.messages:not(.skeleton-messages)'),
      document.getElementById('content').innerHTML,
    );
    assert.deepEqual(spinnerStates.at(-1), {
      running: true,
      skeleton: false,
      messages: true,
    });
    fetchedMessages = [];
    await window.loadMessages('session-2', 'Empty Session');

    assert.equal(document.querySelector('.skeleton-messages'), null);
    assert.ok(document.querySelector('.messages:not(.skeleton-messages)'));
    assert.equal(document.querySelector('.messages > .empty').textContent, 'No messages');

    await window.loadMessages('agent-session', 'Agent', {
      rootSessionId: 'session-2',
      preserveThreads: true,
      canSend: false,
    });
    const inputBar = document.getElementById('input-bar');
    const input = document.getElementById('msg-input');
    assert.equal(inputBar.hasAttribute('inert'), true);
    assert.equal(inputBar.getAttribute('aria-disabled'), 'true');
    assert.equal(input.readOnly, true);
    assert.equal(input.placeholder, 'Subagent is read-only');

    await window.loadMessages('session-2', 'Main', {
      rootSessionId: 'session-2',
      preserveThreads: true,
      canSend: true,
    });
    assert.equal(inputBar.hasAttribute('inert'), false);
    assert.equal(input.readOnly, false);
    assert.equal(input.placeholder, 'Send a message...');
  } finally {
    await vite.close();
    dom.window.close();
  }
});
