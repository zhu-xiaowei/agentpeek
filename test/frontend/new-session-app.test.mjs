import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CSS = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');

test('New Session switches available runtimes and remembers the last per-device choice', async () => {
  const dom = new JSDOM(
    '<!doctype html><head><style>' + CSS + '</style></head><body>'
      + '<div class="top-bar"><div class="top-left"></div><div id="top-right"><a class="top-gear"></a></div></div>'
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
    requestAnimationFrame: function (fn) { return setTimeout(fn, 0); },
    cancelAnimationFrame: clearTimeout,
    connectWs: function () {},
    disconnectWs: function () {},
    updateSpinner: function () {},
    updateSendBtn: function () {},
    dismissPermissionPrompt: function () {},
  });
  Object.assign(window, {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    connectWs: globalThis.connectWs,
    disconnectWs: globalThis.disconnectWs,
    updateSpinner: globalThis.updateSpinner,
    updateSendBtn: globalThis.updateSendBtn,
    dismissPermissionPrompt: globalThis.dismissPermissionPrompt,
    loadViewerLibs: async function () {},
    __homeLoadPromise: new Promise(function () {}),
  });

  const vite = await createServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  try {
    await vite.ssrLoadModule('/js/app.js');
    const state = (await vite.ssrLoadModule('/js/state.js')).state;
    state.appState = {
      device: 'Dual',
      project: { hash: 'project', name: 'Project' },
      session: null,
      sessionPreview: '',
    };
    state.deviceRuntimeCapabilities.Dual = {
      claude: { canCreate: true },
      codex: { canCreate: true },
    };

    const content = document.getElementById('content');
    const scrollButton = document.getElementById('scroll-bottom-btn');
    Object.defineProperties(content, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });
    scrollButton.classList.add('visible');

    await window.startNewSession('project');
    assert.equal(state.appState.runtime, 'claude');
    assert.equal(scrollButton.classList.contains('visible'), false);

    // Momentum from the previous session may deliver a late scroll event after
    // the new-session route is already visible.
    content.dispatchEvent(new window.Event('scroll'));
    assert.equal(scrollButton.classList.contains('visible'), false);
    assert.equal(state.stickBottom, true);

    assert.ok(document.querySelector('.runtime-switch'));
    assert.equal(document.querySelector('.runtime-switch img').src.endsWith('/assets/claude-code.svg'), true);
    assert.equal(getComputedStyle(document.querySelector('.runtime-switch')).width, '28px');
    assert.equal(getComputedStyle(document.querySelector('.runtime-switch')).marginLeft, '-4px');
    assert.equal(getComputedStyle(document.querySelector('.runtime-switch')).marginRight, '-4px');
    assert.equal(document.getElementById('newAgentToggle').hidden, false);

    window.toggleNewSessionRuntime();
    assert.equal(state.appState.runtime, 'codex');
    assert.equal(document.querySelector('.runtime-switch img').src.endsWith('/assets/codex.svg'), true);
    assert.equal(document.getElementById('newAgentToggle').hidden, true);
    assert.equal(document.querySelector('.messages').classList.contains('runtime-codex'), true);
    assert.equal(localStorage.getItem('apeek_new_session_runtime:Dual'), 'codex');

    await window.startNewSession('project');
    assert.equal(state.appState.runtime, 'codex');

    state.appState = {
      device: 'CodexOnly',
      project: { hash: 'codex-project', name: 'Codex Project' },
      session: null,
      sessionPreview: '',
    };
    state.deviceRuntimeCapabilities.CodexOnly = {
      claude: { canCreate: false },
      codex: { canCreate: true },
    };
    await window.startNewSession('codex-project');
    assert.equal(state.appState.runtime, 'claude');
    assert.ok(document.querySelector('.runtime-switch'));
    assert.equal(document.querySelector('.runtime-switch img').src.endsWith('/assets/claude-code.svg'), true);
    window.toggleNewSessionRuntime();
    assert.equal(state.appState.runtime, 'codex');
  } finally {
    await vite.close();
    dom.window.close();
  }
});
