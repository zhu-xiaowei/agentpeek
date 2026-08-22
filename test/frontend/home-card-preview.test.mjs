import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');

async function waitFor(predicate) {
  for (var i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
  }
  throw new Error('Timed out waiting for inline home render');
}

test('inline home cards preserve quoted session previews for detail navigation', async () => {
  const preview = '{"action":"send_message","text":"quoted title"}';
  const active = {
    sessions: [{
      sessionId: 'codex:test-session',
      preview,
      status: 'running',
      deviceName: 'MacBook-Pro',
      projectHash: '-workspace-baton',
      projectName: 'baton',
      runtime: 'codex',
      isAgent: true,
      agentName: 'Review agent',
      agentCount: 3,
      lastActive: '2026-08-12T00:00:00.000Z',
    }],
    recentSessions: [],
  };
  const devices = {
    devices: [{
      deviceName: 'MacBook-Pro',
      deviceDisplayName: 'Office Mac',
    }],
  };
  const dom = new JSDOM(indexHtml, {
    url: 'http://baton.test/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('_ak', window.btoa('test-key'));
      window.fetch = async function (url) {
        return {
          ok: true,
          json: async function () {
            return String(url).includes('active-sessions') ? active : devices;
          },
        };
      };
    },
  });

  try {
    await waitFor(function () {
      return dom.window.document.querySelector('.active-card[data-nav="active"]');
    });
    assert.equal(
      dom.window.document.querySelector('.active-card[data-nav="active"]').dataset.preview,
      preview,
    );
    assert.equal(
      dom.window.document.querySelector('.active-card[data-nav="active"]').dataset.device,
      'MacBook-Pro',
    );
    assert.equal(dom.window.document.querySelector('.card-device').textContent, 'Office Mac');
    assert.deepEqual(
      Array.from(dom.window.document.querySelector('.card-badges').children, function (element) {
        if (element.classList.contains('agent')) return 'agent';
        if (element.classList.contains('running')) return 'status';
        if (element.classList.contains('runtime-mark')) return 'runtime';
        return 'unknown';
      }),
      ['agent', 'status', 'runtime'],
    );
    assert.deepEqual(
      Array.from(dom.window.document.querySelectorAll('.card-badges .badge.agent'), function (element) {
        return element.textContent;
      }),
      ['3 agents'],
    );
  } finally {
    dom.window.close();
  }
});
