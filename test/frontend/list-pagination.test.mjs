import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(import.meta.dirname, '../..');
const pagination = await import(pathToFileURL(path.join(ROOT, 'web/js/list-pagination.js')));

function item(id, minute) {
  return {
    sessionId: id,
    lastActive: `2026-08-10T00:${String(minute).padStart(2, '0')}:00.000Z`,
    preview: id,
  };
}

test('page store appends, deduplicates, and keeps stable newest-first order', () => {
  const store = pagination.createListPageStore();
  store.applyFirst('sessions:D:P', {
    sessions: [item('s3', 3), item('s2', 2)],
    hasMore: true,
    nextCursor: 'page-2',
  }, 'sessions', 'sessionId', false);
  store.append('sessions:D:P', {
    sessions: [{ ...item('s2', 4), preview: 'updated' }, item('s1', 1)],
    hasMore: false,
    nextCursor: null,
  }, 'sessions', 'sessionId');

  const entry = store.peek('sessions:D:P');
  assert.deepEqual(entry.items.map((row) => row.sessionId), ['s2', 's3', 's1']);
  assert.equal(entry.items[0].preview, 'updated');
  assert.equal(entry.hasMore, false);
});

test('first-page refresh preserves loaded tail and its next cursor', () => {
  const store = pagination.createListPageStore();
  store.applyFirst('sessions:D:P', {
    sessions: [item('s4', 4), item('s3', 3)],
    hasMore: true,
    nextCursor: 'page-2',
  }, 'sessions', 'sessionId', false);
  store.append('sessions:D:P', {
    sessions: [item('s2', 2), item('s1', 1)],
    hasMore: true,
    nextCursor: 'page-3',
  }, 'sessions', 'sessionId');
  store.rememberScroll('sessions:D:P', 720);

  store.applyFirst('sessions:D:P', {
    sessions: [item('s5', 5), { ...item('s4', 4), preview: 'fresh' }],
    hasMore: true,
    nextCursor: 'new-page-2',
  }, 'sessions', 'sessionId', true);

  const entry = store.peek('sessions:D:P');
  assert.deepEqual(entry.items.map((row) => row.sessionId), ['s5', 's4', 's3', 's2', 's1']);
  assert.equal(entry.nextCursor, 'page-3');
  assert.equal(entry.scrollTop, 720);
});

test('a complete first-page refresh drops a stale loaded tail', () => {
  const store = pagination.createListPageStore();
  store.applyFirst('projects:D', {
    projects: [
      { projectHash: 'old', lastActive: '2026-08-09T00:00:00.000Z' },
      { projectHash: 'stale', lastActive: '2026-08-08T00:00:00.000Z' },
    ],
    hasMore: true,
    nextCursor: 'page-2',
  }, 'projects', 'projectHash', false);

  store.applyFirst('projects:D', {
    projects: [{ projectHash: 'old', lastActive: '2026-08-10T00:00:00.000Z' }],
    hasMore: false,
    nextCursor: null,
  }, 'projects', 'projectHash', true);

  assert.deepEqual(store.peek('projects:D').items.map((row) => row.projectHash), ['old']);
});

test('page store blocks duplicate loads and invalidates superseded requests', () => {
  const store = pagination.createListPageStore();
  const first = store.begin('sessions:D:P');
  assert.equal(store.begin('sessions:D:P'), null);
  const replacement = store.begin('sessions:D:P', true);
  assert.ok(replacement > first);
  store.finish('sessions:D:P', first);
  assert.equal(store.peek('sessions:D:P').loading, true);
  store.finish('sessions:D:P', replacement);
  assert.equal(store.peek('sessions:D:P').loading, false);
});

test('invalidating an entry does not reuse an in-flight request token', () => {
  const store = pagination.createListPageStore();
  const stale = store.begin('sessions:D:P');
  store.invalidate('sessions:D:P');
  const current = store.begin('sessions:D:P');

  assert.ok(current > stale);
  store.finish('sessions:D:P', stale);
  assert.equal(store.peek('sessions:D:P').loading, true);
  store.finish('sessions:D:P', current);
  assert.equal(store.peek('sessions:D:P').loading, false);
});

test('list cache v2 ignores and removes the old full-list cache', async () => {
  const dom = new JSDOM('', { url: 'https://baton.test/' });
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('apeek_list_cache_v1:sessions:D:P', '{"sessions":[{"sessionId":"old"}]}');
  localStorage.setItem('apeek_list_cache_v1', '{"version":1,"entries":{}}');

  const cacheUrl = pathToFileURL(path.join(ROOT, 'web/js/list-cache.js'));
  cacheUrl.search = `?test=${Date.now()}`;
  const cache = await import(cacheUrl);
  cache.migrateLegacyListCache();

  assert.equal(localStorage.getItem('apeek_list_cache_v1:sessions:D:P'), null);
  assert.equal(cache.readListCache('sessions:D:P'), null);
  assert.equal(cache.writeListCache('sessions:D:P', {
    sessions: [item('s1', 1)],
    hasMore: true,
    nextCursor: 'page-2',
  }), true);
  assert.equal(cache.readListCache('sessions:D:P').sessions.length, 1);
  assert.ok(localStorage.getItem('apeek_list_cache_v2:sessions:D:P'));
  dom.window.close();
  delete globalThis.localStorage;
});

test('home session card headings are constrained to one line', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');
  ['card-project', 'card-title-text'].forEach((className) => {
    const rule = css.match(new RegExp(`\\.${className}\\s*\\{([^}]*)\\}`));
    assert.ok(rule);
    assert.match(rule[1], /white-space:\s*nowrap/);
    assert.match(rule[1], /text-overflow:\s*ellipsis/);
  });
});

test('home cards and list-style controls use background feedback while pressed', () => {
  const css = fs.readFileSync(path.join(ROOT, 'web/css/style.css'), 'utf8');
  assert.match(css, /\.item:active\s*\{\s*background:\s*#161b22;\s*\}/);
  assert.match(css, /\.active-card:active\s*\{\s*background:\s*#21262d;\s*\}/);
  assert.doesNotMatch(css, /\.active-card:active\s*\{[^}]*(?:transform|box-shadow):/s);
  assert.match(css, /\.agent-thread-row:active\s*\{[^}]*border-color:\s*#484f58;[^}]*background:\s*#21262d;/s);
});
