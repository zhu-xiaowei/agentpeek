import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const ROOT = path.resolve(import.meta.dirname, '../..');

function pointer(window, type, target, x) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerType: { value: 'touch' },
    clientX: { value: x },
    clientY: { value: 10 },
  });
  target.dispatchEvent(event);
}

test('edge swipe suppresses only its own click', async () => {
  const dom = new JSDOM(
    '<!doctype html><body><a id="project">Project</a></body>',
    { url: 'https://baton.test/index.html', pretendToBeVisual: true },
  );
  const window = dom.window;
  Object.assign(globalThis, {
    window,
    document: window.document,
    getComputedStyle: window.getComputedStyle,
    requestAnimationFrame: function (callback) { return setTimeout(callback, 0); },
  });
  window.__BATON_NATIVE_MOBILE__ = true;

  const vite = await createServer({
    root: path.join(ROOT, 'web'),
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true },
  });

  try {
    const edgeBack = await vite.ssrLoadModule('/js/edge-back.js');
    const { state } = await vite.ssrLoadModule('/js/state.js');
    state.appState.device = 'D';
    edgeBack.attachEdgeBackGesture(function () {}, function () { return null; });

    const guard = window.document.querySelector('.edge-back-guard');
    const project = window.document.getElementById('project');
    var projectClicks = 0;
    var guardClicks = 0;
    project.addEventListener('click', function () { projectClicks++; });
    guard.addEventListener('click', function () { guardClicks++; });

    pointer(window, 'pointerdown', guard, 5);
    pointer(window, 'pointermove', guard, 80);
    pointer(window, 'pointerup', guard, 80);

    project.click();
    guard.click();

    assert.equal(projectClicks, 1);
    assert.equal(guardClicks, 0);
  } finally {
    await vite.close();
    dom.window.close();
  }
});
