import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { StreamingDomRenderer } from '../../web/js/streaming.js';

function createRenderer() {
  const dom = new JSDOM('<div class="messages"></div>');
  const frames = [];
  const revealed = [];
  const renderer = new StreamingDomRenderer({
    document: dom.window.document,
    getContainer: () => dom.window.document.querySelector('.messages'),
    renderMarkdown: (element, text) => { element.textContent = text; },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
    revealMinimum: 1,
    onBlockRevealComplete: (turnId, blockId) => {
      revealed.push([turnId, blockId]);
    },
  });
  return {
    document: dom.window.document,
    frames,
    revealed,
    renderer,
    flushFrames() {
      while (frames.length) frames.shift()();
    },
  };
}

function createText(renderer, turnId = 'turn-1', blockId = 1) {
  renderer.applyOperations([
    { type: 'createTurn', turnId },
    {
      type: 'createBlock',
      turnId,
      blockId,
      block: { blockId, kind: 'text', text: '' },
    },
  ]);
}

test('ordered delta operations append each character exactly once', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperations([
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'A' },
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'B' },
    { type: 'finishBlockInput', turnId: 'turn-1', blockId: 1 },
  ]);
  h.flushFrames();

  assert.equal(h.document.querySelector('[data-block-id="1"]').textContent, 'AB');
  assert.deepEqual(h.revealed, [['turn-1', 1]]);
});

test('live thinking uses the collapsible Thinking component from its first frame', () => {
  const h = createRenderer();
  h.renderer.applyOperations([
    { type: 'createTurn', turnId: 'turn-thinking' },
    {
      type: 'createBlock',
      turnId: 'turn-thinking',
      blockId: 1,
      block: { blockId: 1, kind: 'thinking', text: '' },
    },
    {
      type: 'appendText',
      turnId: 'turn-thinking',
      blockId: 1,
      chunk: 'reasoning',
    },
  ]);
  h.flushFrames();

  const block = h.document.querySelector('.thinking-block');
  const toggle = block.querySelector('.thinking-toggle');
  const body = block.querySelector('.thinking-body');
  assert.ok(block);
  assert.equal(toggle.textContent, 'Thinking ›');
  assert.ok(toggle.querySelector('.thinking-chevron'));
  assert.equal(body.textContent, 'reasoning');

  toggle.click();
  assert.equal(toggle.classList.contains('open'), true);
  assert.equal(body.style.display, 'block');
});

test('authority patches the existing block instead of creating a duplicate', () => {
  const h = createRenderer();
  createText(h.renderer);
  const original = h.document.querySelector('[data-block-id="1"]');
  h.renderer.applyOperations([
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'draft' },
    { type: 'commitBlock', turnId: 'turn-1', blockId: 1 },
    {
      type: 'patchBlock',
      turnId: 'turn-1',
      blockId: 1,
      block: {
        blockId: 1,
        kind: 'text',
        text: 'final',
        displayComplete: true,
      },
    },
  ]);

  assert.equal(h.document.querySelectorAll('[data-block-id="1"]').length, 1);
  assert.equal(h.document.querySelector('[data-block-id="1"]'), original);
  assert.equal(original.textContent, 'final');
});

test('discarding the only incomplete block removes its empty live turn', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperation({
    type: 'discardBlock',
    turnId: 'turn-1',
    blockId: 1,
  });

  assert.equal(h.document.querySelector('[data-block-id="1"]'), null);
  assert.equal(h.document.querySelector('[data-turn-id="turn-1"]'), null);
});

test('rebind restores a detached live turn after history render replacement', () => {
  const h = createRenderer();
  createText(h.renderer);
  const turn = h.document.querySelector('[data-turn-id="turn-1"]');
  h.document.querySelector('.messages').innerHTML = '<div class="msg-user">history</div>';

  h.renderer.rebindRenderedHistory();

  assert.equal(turn.isConnected, true);
  assert.equal(h.document.querySelectorAll('[data-turn-id="turn-1"]').length, 1);
});

test('reset removes provisional live turns and pending reveal work', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperation({
    type: 'appendText',
    turnId: 'turn-1',
    blockId: 1,
    chunk: 'pending',
  });
  h.renderer.reset();

  assert.equal(h.document.querySelector('[data-turn-id="turn-1"]'), null);
  assert.equal(h.renderer.blockViews.size, 0);
});
