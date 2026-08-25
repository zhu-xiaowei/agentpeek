// CC-style status — "✢ Coding..." with typing cursor animation while CC is running
import { state } from '../state.js';

(function () {
  var FRAMES = ['·', '✢', '✦', '✶', '✻', '✽', '✻', '✶', '✦', '✢'];
  var GLYPH_MS = 120;
  var TYPING_MS = 800;
  var PAUSE_MS = 1500;
  var CURSOR = '<span class="cc-cursor"></span>';
  var VERBS = [
    'Baking','Brewing','Calculating','Churning','Clauding','Cogitating',
    'Computing','Concocting','Considering','Contemplating','Cooking',
    'Crafting','Creating','Crunching','Deliberating','Doing','Enchanting',
    'Forging','Generating','Hatching','Imagining','Inferring','Manifesting',
    'Marinating','Mulling','Musing','Noodling','Percolating','Pondering',
    'Processing','Puzzling','Ruminating','Scheming','Simmering','Spinning',
    'Synthesizing','Thinking','Tinkering','Vibing','Wandering','Working',
    'Wrangling'
  ];

  var _glyphIv = null, _typingIv = null, _pauseTimer = null;
  var _currentVerb = '';
  var _currentRuntime = '';
  var _outputShownAt = 0, _hideTimer = null, _wasRunning = false, _turnEnded = false;
  var MIN_OUTPUT_VISIBLE_MS = 500;

  function pick() {
    var v;
    do { v = VERBS[Math.floor(Math.random() * VERBS.length)]; } while (v === _currentVerb);
    return v;
  }

  function stopTimers() {
    clearInterval(_glyphIv); clearInterval(_typingIv); clearTimeout(_pauseTimer);
    _glyphIv = _typingIv = _pauseTimer = null;
  }

  function startTyping(verbEl) {
    var fixed = _currentRuntime === 'codex';
    var newVerb = fixed ? 'Working' : pick();
    var newText = newVerb + '...';
    var oldText = !fixed && _currentVerb ? _currentVerb + '...' : '';
    _currentVerb = newVerb;
    var len = newText.length, pos = 0;
    var frameMs = TYPING_MS / len;

    _typingIv = setInterval(function () {
      if (++pos > len) {
        clearInterval(_typingIv); _typingIv = null;
        verbEl.textContent = newText;
        _pauseTimer = setTimeout(function () { _pauseTimer = null; startTyping(verbEl); }, PAUSE_MS);
        return;
      }
      var right = pos < oldText.length ? oldText.slice(pos) : '';
      verbEl.innerHTML = newText.slice(0, pos) + CURSOR + right;
    }, frameMs);
  }

  window.markSpinnerTurnEnd = function () {
    _turnEnded = true;
  };

  window.updateSpinner = function () {
    var el = document.getElementById('cc-spinner');
    if (!state.appState.session) {
      clearTimeout(_hideTimer);
      _hideTimer = null;
      _outputShownAt = 0;
      _wasRunning = false;
      _turnEnded = false;
      if (el) el.remove();
      stopTimers();
      _currentVerb = '';
      _currentRuntime = '';
      return;
    }
    // Hide the spinner while a permission prompt is up — the user is answering, not waiting.
    var promptUp = typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt();
    // Hold the spinner until the skeleton clears — else it shows under the loading placeholder.
    var skeleton = !!document.querySelector('#content .skeleton-messages');
    var shouldShow = state.wsRunning && !promptUp && !skeleton;
    var runtime = state.appState.runtime === 'codex' ? 'codex' : 'claude';

    if (state.wsRunning && !_wasRunning) {
      clearTimeout(_hideTimer);
      _hideTimer = null;
      _outputShownAt = 0;
      _turnEnded = false;
    }
    if (state.wsRunning && !_outputShownAt
      && document.querySelector('.assistant-turn.stream-preview [data-block-id]')) {
      _outputShownAt = Date.now();
    }
    _wasRunning = state.wsRunning;

    if (!shouldShow) {
      var remaining = !state.wsRunning && _turnEnded && _outputShownAt
        ? MIN_OUTPUT_VISIBLE_MS - (Date.now() - _outputShownAt)
        : 0;
      if (el && remaining > 0) {
        if (!_hideTimer) {
          _hideTimer = setTimeout(function () {
            _hideTimer = null;
            window.updateSpinner();
          }, remaining);
        }
        return;
      }
      clearTimeout(_hideTimer);
      _hideTimer = null;
      _turnEnded = false;
      if (el) {
        // Collapse the status row instead of removing it from layout in one
        // frame. This avoids a bottom-scroll jump without leaving an idle gap.
        el.style.display = 'flex';
        el.classList.add('is-collapsed');
        el.setAttribute('aria-hidden', 'true');
      }
      stopTimers();
      _currentVerb = '';
      _currentRuntime = '';
      return;
    }

    var content = document.getElementById('content');
    if (!el) {
      stopTimers();
      el = document.createElement('div');
      el.id = 'cc-spinner';
      el.className = 'cc-spinner';
      if (content) content.appendChild(el);
      else document.body.appendChild(el);
    }
    if (content && el.parentNode === content && el !== content.lastElementChild) {
      content.appendChild(el);
    }
    el.style.display = 'flex';
    el.classList.remove('is-collapsed');
    el.removeAttribute('aria-hidden');

    if (_currentRuntime !== runtime) {
      stopTimers();
      _currentVerb = '';
      _currentRuntime = runtime;
    }

    if (!_glyphIv) {
      var frame = 0;
      el.innerHTML = '<div class="cc-spinner-inner"><span class="cc-spinner-glyph">'
        + FRAMES[0] + '</span><span class="cc-spinner-verb"></span></div>';
      var glyphEl = el.querySelector('.cc-spinner-glyph');
      var verbEl = el.querySelector('.cc-spinner-verb');

      _glyphIv = setInterval(function () {
        frame = (frame + 1) % FRAMES.length;
        glyphEl.textContent = FRAMES[frame];
      }, GLYPH_MS);

      startTyping(verbEl);
    }
  };
})();
