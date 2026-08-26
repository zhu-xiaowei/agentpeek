import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const detectorSource = readFileSync(
  new URL('../../web/public/native-mobile.js', import.meta.url),
  'utf8',
);

function detectNativeMobile({
  tauri = false,
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) {
  const classes = new Set();
  const context = {
    navigator: { userAgent, platform, maxTouchPoints },
    document: {
      documentElement: {
        classList: {
          toggle(name, enabled) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
        },
      },
    },
    window: tauri ? { __TAURI_INTERNALS__: {} } : {},
  };

  vm.runInNewContext(detectorSource, context);
  return {
    classApplied: classes.has('native-mobile'),
    flag: context.window.__BATON_NATIVE_MOBILE__,
  };
}

test('native mobile detection requires Tauri and a mobile operating system', () => {
  const cases = [
    {
      name: 'Tauri iPhone',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
      expected: true,
    },
    {
      name: 'Tauri Android',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' },
      expected: true,
    },
    {
      name: 'Tauri iPad using desktop identity',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 },
      expected: true,
    },
    {
      name: 'Tauri macOS',
      input: { tauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel' },
      expected: false,
    },
    {
      name: 'mobile Safari outside Tauri',
      input: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' },
      expected: false,
    },
    {
      name: 'narrow desktop browser',
      input: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel' },
      expected: false,
    },
  ];

  for (const scenario of cases) {
    const result = detectNativeMobile(scenario.input);
    assert.equal(result.classApplied, scenario.expected, scenario.name);
    assert.equal(result.flag, scenario.expected, `${scenario.name} global flag`);
  }
});

test('all entry pages run mobile detection before their first style block', () => {
  for (const filename of ['index.html', 'landing.html', 'setup.html']) {
    const html = readFileSync(new URL(`../../web/${filename}`, import.meta.url), 'utf8');
    const detectorIndex = html.indexOf('<script src="/native-mobile.js"></script>');
    assert.notEqual(detectorIndex, -1, `${filename} includes native mobile detection`);
    assert.ok(detectorIndex < html.indexOf('<style>'), `${filename} detects before styling`);
  }
});

test('mobile readability styles are scoped to the native mobile class', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../../web/setup.html', import.meta.url), 'utf8');

  assert.doesNotMatch(css, /@media\s*\(max-width:\s*767px\)/);
  assert.doesNotMatch(setup, /@media\s*\(max-width:\s*767px\)/);
  assert.match(css, /html\.native-mobile \.assistant-text\s*\{\s*font-size:\s*16px/);
  assert.match(css, /html\.native-mobile \.msg-system-event\s*\{\s*font-size:\s*14px;\s*line-height:\s*21px;/);
  assert.match(css, /html\.native-mobile \.summary-block > summary\s*\{\s*font-size:\s*14px;\s*line-height:\s*21px;/);
  assert.match(css, /html\.native-mobile #top-right\.select-actions\s*\{[^}]*gap:\s*8px;[^}]*padding:\s*0 2px 4px 0;/s);
  assert.match(css, /html\.native-mobile #top-right\.select-actions \.text-btn\s*\{[^}]*height:\s*32px;[^}]*min-height:\s*32px;/s);
  assert.match(setup, /html\.native-mobile \.setup-bar \.title\s*\{\s*font-size:\s*17px/);
  assert.match(
    css,
    /\.breadcrumb-nav a \{[\s\S]*?max-width:\s*240px;/,
  );
  assert.match(
    css,
    /html\.native-mobile \.breadcrumb-nav a \{[^}]*max-width:\s*140px;/s,
  );

  const landing = readFileSync(new URL('../../web/landing.html', import.meta.url), 'utf8');
  assert.match(
    landing,
    /html\.native-mobile \.input-group label\s*\{[^}]*font-size:\s*15px;[^}]*font-weight:\s*500;/s,
  );
});

test('short iOS browse lists reserve horizontal drags for edge-back navigation', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /html\.native-mobile body\.browse-view #content\s*\{[^}]*overflow-y:\s*scroll;[^}]*touch-action:\s*pan-y;/s,
  );
});

test('native landscape hides navigation chrome and applies live content safe areas', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8');
  const main = readFileSync(
    new URL('../../src-tauri/gen/apple/Sources/baton/main.mm', import.meta.url),
    'utf8',
  );

  assert.match(
    css,
    /@media \(orientation: landscape\)\s*\{[\s\S]*html\.native-mobile \.top-bar,\s*html\.native-mobile \.breadcrumb\s*\{\s*display:\s*none !important;/s,
  );
  assert.match(
    css,
    /html\.native-mobile #content,\s*html\.native-mobile \.edge-back-content\s*\{[^}]*--sat[^}]*--sal[^}]*--sar/s,
  );
  assert.match(
    css,
    /html\.native-mobile \.file-modal-body\s*\{[^}]*--sat[^}]*--sal[^}]*--sar[^}]*--sab/s,
  );
  assert.match(
    css,
    /html\.native-mobile \.scroll-bottom-btn\s*\{[^}]*right:\s*calc\(var\(--sar,\s*env\(safe-area-inset-right,\s*0px\)\) \+ 16px\);/s,
  );
  assert.match(app, /function scheduleScrollBtnPosition\(\)/);
  assert.match(app, /addEventListener\('orientationchange', scheduleScrollBtnPosition\)/);
  assert.match(app, /setTimeout\(positionScrollBtn, 420\)/);
  assert.match(main, /UIDeviceOrientationDidChangeNotification/);
  assert.match(main, /baton_schedule_viewport_refresh/);
  assert.match(main, /s\.setProperty\('--sal',a\[2\]\+'px'\)/);
  assert.match(main, /s\.setProperty\('--sar',a\[3\]\+'px'\)/);
});

test('mobile edge-back owns the left edge and accepts drags within 45 degrees', () => {
  const js = readFileSync(new URL('../../web/js/edge-back.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../web/css/edge-back.css', import.meta.url), 'utf8');

  assert.match(js, /if \(!window\.__BATON_NATIVE_MOBILE__\) return;/);
  assert.match(js, /if \(e\.target !== edgeGuard\) return;/);
  assert.match(js, /dx > 10 && dx >= Math\.abs\(dy\)/);
  assert.match(js, /settleSwipe\(dx >= Math\.abs\(dy\)/);
  assert.match(
    css,
    /\.edge-back-guard\s*\{[^}]*width:\s*24px;[^}]*touch-action:\s*none;/s,
  );
});

test('file preview uses one circled close icon across desktop and native mobile', () => {
  const css = readFileSync(new URL('../../web/css/style.css', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');

  assert.match(html, /<button type="button" class="file-modal-close"[^>]*aria-label="Close"/);
  assert.doesNotMatch(html, /file-modal-close-glyph/);
  assert.match(css, /\.file-modal-close-icon\s*\{[^}]*display:\s*block;[^}]*border:\s*1\.5px solid currentColor;[^}]*border-radius:\s*50%;[^}]*rotate\(45deg\)/s);
  assert.match(css, /html\.native-mobile \.file-modal-close-icon\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;/s);
});
