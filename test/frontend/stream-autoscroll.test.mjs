import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile',
  visualViewport: { height: 844, offsetTop: 0 },
});

test('keyboard opening and closing preserve physical bottom follow', async (t) => {
  await h.tick(10);
  resetSession(h, { sessionId: 'codex:keyboard-stability' });
  const content = h.document.getElementById('content');
  t.after(() => {
    delete content.clientHeight;
    delete content.scrollHeight;
    delete content.scrollTop;
  });
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="msg-user">unchanged</div>';
  const message = container.firstElementChild;

  let clientHeight = 300;
  let scrollHeight = 900;
  let scrollTop = 600;
  let scrollWrites = 0;
  Object.defineProperty(content, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(content, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollWrites += 1;
      scrollTop = Math.min(value, scrollHeight - clientHeight);
    },
  });
  h.state.stickBottom = true;

  h.visualViewport.height = 420;
  h.visualViewport.offsetTop = 40;
  h.visualViewport.dispatch('resize');
  clientHeight = 100;
  await h.tick(20);

  assert.equal(h.document.body.style.height, '420px');
  assert.equal(h.document.querySelector('.messages'), container);
  assert.equal(container.firstElementChild, message);
  assert.equal(content.scrollTop, 800);
  assert.equal(scrollWrites, 1);
  assert.equal(h.state.stickBottom, true);

  clientHeight = 300;
  scrollTop = 600; // Native layout clamp as the keyboard closes.
  scrollWrites = 0;
  h.state.wsRunning = true;
  h.visualViewport.height = 844;
  h.visualViewport.offsetTop = 0;
  h.visualViewport.dispatch('resize');
  scrollHeight = 980; // Streaming output grows while the keyboard is closing.
  await h.tick(20);

  assert.equal(h.document.body.style.height, '844px');
  assert.equal(h.document.querySelector('.messages'), container);
  assert.equal(container.firstElementChild, message);
  assert.equal(content.scrollTop, 680);
  assert.equal(scrollWrites, 1);
  assert.equal(h.state.stickBottom, true);

  scrollTop = 120;
  scrollWrites = 0;
  h.state.stickBottom = false;
  h.visualViewport.height = 420;
  h.visualViewport.offsetTop = 40;
  h.visualViewport.dispatch('resize');
  clientHeight = 100;
  await h.tick(20);

  assert.equal(content.scrollTop, 120);
  assert.equal(scrollWrites, 0);
  assert.equal(h.state.stickBottom, false);
  assert.equal(h.document.querySelector('.messages'), container);
  assert.equal(container.firstElementChild, message);

  clientHeight = 300;
  h.visualViewport.height = 844;
  h.visualViewport.offsetTop = 0;
  h.visualViewport.dispatch('resize');
  await h.tick(20);

  scrollTop = 120;
  scrollWrites = 0;
  h.state.stickBottom = false;
  h.document.getElementById('msg-input').focus();
  h.visualViewport.height = 420;
  h.visualViewport.offsetTop = 40;
  h.visualViewport.dispatch('resize');
  clientHeight = 100;
  await h.tick(20);

  assert.equal(content.scrollTop, 880);
  assert.equal(scrollWrites, 1);
  assert.equal(h.state.stickBottom, true);
  h.document.getElementById('msg-input').blur();
});

test('sending a user message restores bottom following with a smooth scroll', () => {
  resetSession(h, { sessionId: 'codex:send-follow' });
  const content = h.document.getElementById('content');
  let scrollOptions = null;
  content.scrollTo = (options) => {
    scrollOptions = options;
  };
  h.state.stickBottom = false;

  h.window.doSend('hello', 'hello', []);

  assert.equal(h.state.stickBottom, true);
  assert.deepEqual(scrollOptions, { top: 99999, behavior: 'smooth' });
  assert.match(h.document.querySelector('.msg-user[data-pending="1"]').textContent, /hello/);
});

test('typing preserves message scroll without refreshing the streaming spinner', async (t) => {
  resetSession(h, { sessionId: 'codex:typing-stability' });
  const content = h.document.getElementById('content');
  const input = h.document.getElementById('msg-input');
  const originalSpinner = h.window.updateSpinner;
  let spinnerUpdates = 0;
  globalThis.updateSpinner = h.window.updateSpinner = () => { spinnerUpdates += 1; };

  let clientHeight = 300;
  let scrollHeight = 900;
  let scrollTop = 180;
  Object.defineProperties(content, {
    clientHeight: { configurable: true, get: () => clientHeight },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value) => { scrollTop = Math.min(value, scrollHeight - clientHeight); },
    },
  });
  Object.defineProperty(input, 'scrollHeight', {
    configurable: true,
    get: () => 44,
  });
  t.after(() => {
    globalThis.updateSpinner = h.window.updateSpinner = originalSpinner;
    delete content.clientHeight;
    delete content.scrollHeight;
    delete content.scrollTop;
    delete input.scrollHeight;
  });

  h.state.wsRunning = true;
  h.state.stickBottom = false;
  input.value = 'a';
  input.dispatchEvent(new h.window.Event('input'));
  await h.tick(10);

  assert.equal(input.style.height, '44px');
  assert.equal(content.scrollTop, 180);
  assert.equal(spinnerUpdates, 0);

  scrollTop = 600;
  h.state.stickBottom = true;
  input.value = 'ab';
  input.dispatchEvent(new h.window.Event('input'));
  await h.tick(10);

  assert.equal(content.scrollTop, 600);
  assert.equal(spinnerUpdates, 0);
});

test('first outside tap dismisses the keyboard without activating expandable content', async () => {
  resetSession(h, { sessionId: 'codex:keyboard-tap-guard' });
  const input = h.document.getElementById('msg-input');
  const target = h.document.createElement('div');
  target.className = 'tool-value clamp';
  h.document.getElementById('content').appendChild(target);
  let activations = 0;
  target.addEventListener('click', () => { activations += 1; });
  h.state.stickBottom = true;

  input.focus();
  h.visualViewport.height = 420;
  h.visualViewport.offsetTop = 40;
  h.visualViewport.dispatch('resize');
  await h.tick(10);

  const dispatch = (type) => {
    const event = new h.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(dispatch('pointerdown').defaultPrevented, true);
  assert.equal(dispatch('pointerup').defaultPrevented, true);
  assert.equal(dispatch('click').defaultPrevented, true);

  assert.notEqual(h.document.activeElement, input);
  assert.equal(activations, 0);
  assert.equal(h.state.stickBottom, true);

  dispatch('pointerdown');
  dispatch('pointerup');
  dispatch('click');
  assert.equal(activations, 1);
});

test('an OUT update on an earlier tool still keeps the whole view at the bottom', async () => {
  resetSession(h, { sessionId: 'codex:out-follow' });
  const content = h.document.getElementById('content');
  const container = h.document.querySelector('.messages');
  let height = 700;
  Object.defineProperty(content, 'scrollHeight', {
    configurable: true,
    get: () => height,
  });

  globalThis.isToolResultOnly = h.window.isToolResultOnly = (message) =>
    Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((block) => block.type === 'tool_result');
  globalThis.renderToolNode = h.window.renderToolNode = () => {
    height = 980;
    return '<div class="tool-header">completed output</div>';
  };

  container.innerHTML = [
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node" data-tool-id="tool-1"></div>',
    '</div>',
    '<div class="msg-user">later content</div>',
  ].join('');
  const toolUse = {
    uuid: 'assistant-tool',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  };
  const toolResult = {
    uuid: 'tool-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    }],
  };
  h.state.wsAllMessages = [toolUse, toolResult];
  h.state.wsRenderedCount = 1;
  h.state.stickBottom = true;
  content.scrollTop = 400;

  h.hooks.updateLastTurn([toolResult]);
  assert.equal(
    container.querySelector('[data-tool-id="tool-1"]').textContent,
    'completed output',
  );
  assert.equal(content.scrollTop, 980);

  height = 1040;
  await h.tick(10);
  assert.equal(content.scrollTop, 980);
});
