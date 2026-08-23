// Streaming Mermaid: renderMd/renderStreamMd emit a .mermaid-block placeholder; renderMermaidBlocks fills the SVG async, only when the source changed (tagged via data-mcode), swapping just that block's SVG.
(function () {
  // Single knob: swap version/CDN here (pinned exact so the cache key is stable). Browser/WebView HTTP cache handles disk caching.
  var MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs';

  var _mermaidPromise = null;
  var _renderSeq = 0;                  // unique id per render() — mermaid needs distinct ids
  var _pending = Object.create(null);  // stable key → source currently being rendered (in-flight guard)
  var _svgCache = Object.create(null); // trimmed source → rendered SVG string (survives node swaps)
  var _svgCacheKeys = [];              // FIFO of _svgCache keys for a small LRU-ish cap
  function cacheSvg(code, svg) {
    if (!(code in _svgCache)) { _svgCacheKeys.push(code); if (_svgCacheKeys.length > 40) delete _svgCache[_svgCacheKeys.shift()]; }
    _svgCache[code] = svg;
  }

  var _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  var _maxLiveSvgs = _isMobile ? 6 : 12;
  var _viewportObserver = null;
  var _observedBlocks = new Set();

  function releaseSvg(block) {
    var box = block && block.querySelector('.mermaid-svg');
    var svg = box && box.firstElementChild;
    if (!svg || svg.tagName.toLowerCase() !== 'svg') return;
    var srcEl = block.querySelector('.mermaid-src');
    var code = (srcEl ? srcEl.textContent : '').trim();
    if (code) cacheSvg(code, svg.outerHTML);
    box.innerHTML = '';
    block.classList.remove('rendered');
  }

  function limitLiveSvgs(preferred) {
    var root = document.getElementById('content') || document;
    var live = Array.from(root.querySelectorAll('.mermaid-block.rendered'));
    if (live.length <= _maxLiveSvgs) return;
    var viewport = root === document ? { top: 0, bottom: window.innerHeight } : root.getBoundingClientRect();
    live.sort(function (a, b) {
      function distance(block) {
        var rect = block.getBoundingClientRect();
        if (rect.bottom < viewport.top) return viewport.top - rect.bottom;
        if (rect.top > viewport.bottom) return rect.top - viewport.bottom;
        return 0;
      }
      return distance(b) - distance(a);
    });
    var count = live.length;
    for (var i = 0; i < live.length && count > _maxLiveSvgs; i++) {
      var rect = live[i].getBoundingClientRect();
      var visible = rect.bottom > viewport.top && rect.top < viewport.bottom;
      if (live[i] !== preferred && !visible) {
        releaseSvg(live[i]);
        count--;
      }
    }
  }

  // Offscreen render container (keeps mermaid's temp measuring nodes out of <body>). MUST keep a real width — gantt measures it to size the axis, so a 0-width sandbox renders blank (mermaid #1846); left:-99999px hides it without collapsing width.
  var _sandbox = null;
  function sandbox() {
    if (_sandbox && document.body.contains(_sandbox)) return _sandbox;
    _sandbox = document.createElement('div');
    _sandbox.id = 'mermaid-sandbox';
    _sandbox.style.cssText = 'position:absolute;left:-99999px;top:0;width:900px;overflow:hidden';
    document.body.appendChild(_sandbox);
    return _sandbox;
  }

  function loadMermaid() {
    if (_mermaidPromise) return _mermaidPromise;
    _mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN).then(function (mod) {
      var mermaid = mod.default || mod;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      return mermaid;
    }).catch(function (e) { _mermaidPromise = null; throw e; });
    return _mermaidPromise;
  }

  // Stable per-block key surviving per-frame rebuilds: the streaming block id (sb-<sid>-<bid>), else a one-shot id.
  function stableKey(block) {
    var host = block.closest('[id^="sb-"]');
    return host ? host.id : (block.dataset.mkey || (block.dataset.mkey = 'm' + (++_renderSeq)));
  }

  // mermaid renders a "Syntax error" graph (not a throw) for some parseable sources; detect it to discard and keep the last good diagram.
  function isErrorSvg(svg) {
    return /aria-roledescription="error"|class="error-icon"|>Syntax error/i.test(svg);
  }

  // Gantt streams badly: a half-written task line parses OK but render() throws — so try full source, and on failure drop the last non-empty line and retry a few times.
  function renderResilient(mermaid, id, code) {
    var attempt = code, tries = 0;
    function step() {
      return mermaid.render(id + '-' + tries, attempt, sandbox()).then(function (res) {
        if (res && res.svg && !isErrorSvg(res.svg)) return res;
        throw new Error('error-svg');
      }).catch(function (e) {
        var lines = attempt.split('\n');
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        if (tries >= 3 || lines.length <= 1) throw e;
        lines.pop(); attempt = lines.join('\n'); tries++;
        return step();
      });
    }
    return step();
  }

  // Debounce failure: mid-stream failures are normal (code unfinished), so only act if the SAME source still fails after 600ms; a newer attempt or success cancels it. On failure: switch to code + tag mermaid-failed.
  var _failTimers = Object.create(null);
  function markFailed(block, code) {
    if (block.querySelector('.mermaid-svg > svg')) return; // a good SVG is already showing
    var key = stableKey(block);
    clearTimeout(_failTimers[key]);
    _failTimers[key] = setTimeout(function () {
      var srcEl = block.querySelector('.mermaid-src');
      if (!document.body.contains(block) || !srcEl || srcEl.textContent.trim() !== code) return;
      if (block.querySelector('.mermaid-svg > svg')) return; // rendered in the meantime
      block.classList.add('show-code', 'mermaid-failed');
      var tabs = block.querySelectorAll('.mermaid-tab');
      tabs.forEach(function (t) { t.classList.toggle('active', /code/i.test(t.textContent)); });
    }, 600);
  }

  function pruneObservedBlocks() {
    _observedBlocks.forEach(function (block) {
      if (block.isConnected) return;
      _viewportObserver.unobserve(block);
      _observedBlocks.delete(block);
    });
  }

  function ensureViewportObserver() {
    if (_viewportObserver || !window.IntersectionObserver) return _viewportObserver;
    _viewportObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var block = entry.target;
        if (!block.isConnected) {
          _viewportObserver.unobserve(block);
          _observedBlocks.delete(block);
          return;
        }
        block._mermaidInRange = entry.isIntersecting;
        if (entry.isIntersecting) window.renderMermaidBlocks(block);
        else releaseSvg(block);
      });
    }, {
      root: document.getElementById('content') || null,
      rootMargin: (_isMobile ? 480 : 900) + 'px 0px',
      threshold: 0,
    });
    return _viewportObserver;
  }

  // (Re)render any .mermaid-block under `container` whose source changed since its current SVG.
  window.renderMermaidBlocks = function (container) {
    if (!container) return;
    var blocks = container.matches && container.matches('.mermaid-block')
      ? [container] : Array.from(container.querySelectorAll('.mermaid-block'));
    if (!blocks.length) return;

    var observer = ensureViewportObserver();
    if (observer) {
      pruneObservedBlocks();
      blocks = blocks.filter(function (block) {
        if (!_observedBlocks.has(block)) {
          _observedBlocks.add(block);
          block._mermaidInRange = false;
          observer.observe(block);
        }
        return block._mermaidInRange;
      });
      if (!blocks.length) return;
    }

    var todo = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var srcEl = block.querySelector('.mermaid-src');
      var code = (srcEl ? srcEl.textContent : '').trim();
      if (!code) continue;
      // gantt is a wide horizontal chart — flag it so CSS stretches it to the container width instead of shrinking it small + centered.
      block.classList.toggle('mermaid-wide', /^gantt\b/.test(code));
      var svgBox = block.querySelector('.mermaid-svg');
      var cur = svgBox && svgBox.firstElementChild;         // SVG already in this box (persistent node or prior render)
      if (cur && cur.getAttribute('data-mcode') === code) { // already showing this exact source → no-op
        block.classList.add('rendered');
        limitLiveSvgs(block);
        continue;
      }
      // Rendered this source before (e.g. streaming→authoritative swap): restore cached SVG sync, no flash.
      if ((!cur || cur.getAttribute('data-mcode') !== code) && _svgCache[code] && svgBox) {
        svgBox.innerHTML = _svgCache[code];
        if (svgBox.firstElementChild) svgBox.firstElementChild.setAttribute('data-mcode', code);
        block.classList.add('rendered');
        limitLiveSvgs(block);
        continue;
      }
      var key = stableKey(block);
      if (_pending[key] === code) continue;                 // a render for this source is already in flight
      _pending[key] = code;
      todo.push({ block: block, code: code, key: key });
    }
    if (!todo.length) return;

    loadMermaid().then(function (mermaid) {
      todo.forEach(function (t) {
        var renderId = 'mmd-' + (++_renderSeq);
        // parse() gates render() (mid-stream/invalid → skip); renderResilient handles gantt's half-written trailing line.
        mermaid.parse(t.code, { suppressErrors: true }).then(function (ok) {
          if (!ok) { markFailed(t.block, t.code); return; } // parse failed — if final code, mark failed
          return renderResilient(mermaid, renderId, t.code).then(function (res) {
            cacheSvg(t.code, res.svg); // remember by source so a later node swap restores it sync
            var srcEl = t.block.querySelector('.mermaid-src');
            var box = t.block.querySelector('.mermaid-svg');
            // replace this block's SVG only if it's still attached + still on this source
            if (!box || !srcEl || !document.body.contains(t.block) || srcEl.textContent.trim() !== t.code) return;
            if (_viewportObserver && !t.block._mermaidInRange) return;
            box.innerHTML = res.svg;
            var svg = box.firstElementChild;
            if (svg) svg.setAttribute('data-mcode', t.code); // tag so unchanged frames become a no-op
            clearTimeout(_failTimers[t.key]);                // a good render cancels any pending fail switch
            t.block.classList.remove('mermaid-failed');
            t.block.classList.add('rendered');
            limitLiveSvgs(t.block);
          });
        }).catch(function () { markFailed(t.block, t.code); })
          .then(function () { if (_pending[t.key] === t.code) delete _pending[t.key]; });
      });
    }).catch(function () { /* CDN unavailable → placeholder stays (code tab still works) */ });
  };

  // Toggle a block between diagram and source view (tab buttons in the header).
  window.toggleMermaidView = function (btn, mode) {
    var block = btn.closest('.mermaid-block');
    if (!block) return;
    block.classList.toggle('show-code', mode === 'code');
    block.querySelectorAll('.mermaid-tab').forEach(function (t) { t.classList.remove('active'); });
    btn.classList.add('active');
  };

  // ---- Fullscreen viewer: vector viewBox zoom + rubber-band pan ----
  // CSS transforms can promote the whole SVG to a cached WebKit bitmap. Updating viewBox
  // keeps every frame vector-rendered while still supporting anchored pinch/wheel zoom.
  var _fs = null;
  var _fsEdgeBack = window.registerEdgeBackLayer
    ? window.registerEdgeBackLayer({
        navigateBack: closeMermaidFullscreen,
        foregroundSelectors: ['.mermaid-fs-overlay'],
        guardZIndex: 2002,
      })
    : { activate: function () {}, deactivate: function () {} };
  var FS_MIN_SCALE = 0.5;
  var FS_MAX_SCALE = 8;

  function fsCopyView(view) {
    return { x: view.x, y: view.y, w: view.w, h: view.h };
  }

  function fsReadViewBox(svg) {
    var raw = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (raw.length === 4 && raw.every(isFinite) && raw[2] > 0 && raw[3] > 0) {
      return { x: raw[0], y: raw[1], w: raw[2], h: raw[3] };
    }
    var rect = svg.getBoundingClientRect();
    var width = parseFloat(svg.getAttribute('width')) || rect.width || 800;
    var height = parseFloat(svg.getAttribute('height')) || rect.height || 600;
    return { x: 0, y: 0, w: width, h: height };
  }

  function fsScale(view) {
    return _fs.home.w / view.w;
  }

  function fsBounds(view) {
    var minX = _fs.base.x;
    var maxX = _fs.base.x + _fs.base.w - view.w;
    var minY = _fs.base.y;
    var maxY = _fs.base.y + _fs.base.h - view.h;
    if (maxX < minX) minX = maxX = _fs.base.x + (_fs.base.w - view.w) / 2;
    if (maxY < minY) minY = maxY = _fs.base.y + (_fs.base.h - view.h) / 2;
    return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
  }

  function fsClamp(view) {
    var bounds = fsBounds(view);
    view.x = Math.max(bounds.minX, Math.min(view.x, bounds.maxX));
    view.y = Math.max(bounds.minY, Math.min(view.y, bounds.maxY));
    return view;
  }

  function fsRubberDistance(distance, size) {
    size = Math.max(size, 1);
    return distance * 0.55 * size / (size + distance * 0.55);
  }

  function fsResist(view) {
    var bounds = fsBounds(view);
    if (view.x < bounds.minX) view.x = bounds.minX - fsRubberDistance(bounds.minX - view.x, view.w);
    if (view.x > bounds.maxX) view.x = bounds.maxX + fsRubberDistance(view.x - bounds.maxX, view.w);
    if (view.y < bounds.minY) view.y = bounds.minY - fsRubberDistance(bounds.minY - view.y, view.h);
    if (view.y > bounds.maxY) view.y = bounds.maxY + fsRubberDistance(view.y - bounds.maxY, view.h);
    return view;
  }

  function fsWrite(view) {
    if (!_fs) return;
    _fs.view = fsCopyView(view);
    var values = [view.x, view.y, view.w, view.h].map(function (n) {
      return String(Math.round(n * 10000) / 10000);
    });
    _fs.svg.setAttribute('viewBox', values.join(' '));
  }

  function fsLayout(view) {
    var rect = _fs.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) rect = _fs.stage.getBoundingClientRect();
    var pxPerUnit = Math.min(rect.width / view.w, rect.height / view.h) || 1;
    return {
      rect: rect,
      pxPerUnit: pxPerUnit,
      offsetX: (rect.width - view.w * pxPerUnit) / 2,
      offsetY: (rect.height - view.h * pxPerUnit) / 2,
    };
  }

  function fsClientToUser(clientX, clientY, view) {
    var layout = fsLayout(view);
    return {
      x: view.x + (clientX - layout.rect.left - layout.offsetX) / layout.pxPerUnit,
      y: view.y + (clientY - layout.rect.top - layout.offsetY) / layout.pxPerUnit,
    };
  }

  function fsElasticScale(scale) {
    if (scale < FS_MIN_SCALE) {
      return FS_MIN_SCALE - fsRubberDistance(FS_MIN_SCALE - scale, 0.35);
    }
    if (scale > FS_MAX_SCALE) {
      return FS_MAX_SCALE + fsRubberDistance(scale - FS_MAX_SCALE, 0.75);
    }
    return scale;
  }

  function fsViewAtScale(scale, clientX, clientY, anchor) {
    var next = {
      x: 0,
      y: 0,
      w: _fs.home.w / scale,
      h: _fs.home.h / scale,
    };
    var layout = fsLayout(next);
    next.x = anchor.x - (clientX - layout.rect.left - layout.offsetX) / layout.pxPerUnit;
    next.y = anchor.y - (clientY - layout.rect.top - layout.offsetY) / layout.pxPerUnit;
    return next;
  }

  function fsHomeView() {
    var rect = _fs.stage.getBoundingClientRect();
    var width = rect.width || window.innerWidth || 800;
    var height = rect.height || window.innerHeight || 600;
    var screenRatio = width / height;
    var contentRatio = _fs.base.w / _fs.base.h;
    var home = fsCopyView(_fs.base);
    if (contentRatio > screenRatio) {
      home.h = home.w / screenRatio;
      home.y = _fs.base.y - (home.h - _fs.base.h) / 2;
    } else {
      home.w = home.h * screenRatio;
      home.x = _fs.base.x - (home.w - _fs.base.w) / 2;
    }
    return home;
  }

  function fsResize() {
    if (!_fs) return;
    var scale = fsScale(_fs.view);
    var centerX = _fs.view.x + _fs.view.w / 2;
    var centerY = _fs.view.y + _fs.view.h / 2;
    _fs.home = fsHomeView();
    var next = {
      w: _fs.home.w / scale,
      h: _fs.home.h / scale,
      x: centerX - _fs.home.w / scale / 2,
      y: centerY - _fs.home.h / scale / 2,
    };
    fsWrite(fsClamp(next));
  }

  function fsCancelSpring() {
    if (!_fs || !_fs.raf) return;
    cancelAnimationFrame(_fs.raf);
    _fs.raf = 0;
  }

  function fsSpringTo(target) {
    if (!_fs) return;
    fsCancelSpring();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      fsWrite(target);
      return;
    }
    var current = fsCopyView(_fs.view);
    var velocity = { x: 0, y: 0, w: 0, h: 0 };
    var previous = performance.now();
    var keys = ['x', 'y', 'w', 'h'];
    function frame(now) {
      if (!_fs) return;
      var step = Math.max(0.5, Math.min((now - previous) / 16.667, 2));
      previous = now;
      var settled = true;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        velocity[key] = (velocity[key] + (target[key] - current[key]) * 0.2 * step) * Math.pow(0.72, step);
        current[key] += velocity[key] * step;
        var tolerance = (key === 'w' || key === 'x') ? _fs.home.w * 0.00005 : _fs.home.h * 0.00005;
        if (Math.abs(target[key] - current[key]) > tolerance || Math.abs(velocity[key]) > tolerance) settled = false;
      }
      fsWrite(current);
      if (settled) {
        fsWrite(target);
        _fs.raf = 0;
      } else {
        _fs.raf = requestAnimationFrame(frame);
      }
    }
    _fs.raf = requestAnimationFrame(frame);
  }

  function fsSettle() {
    if (!_fs) return;
    var scale = Math.max(FS_MIN_SCALE, Math.min(fsScale(_fs.view), FS_MAX_SCALE));
    if (_isMobile && scale >= 0.9 && scale <= 1.1) scale = 1;
    var target = {
      w: _fs.home.w / scale,
      h: _fs.home.h / scale,
      x: _fs.view.x + (_fs.view.w - _fs.home.w / scale) / 2,
      y: _fs.view.y + (_fs.view.h - _fs.home.h / scale) / 2,
    };
    fsSpringTo(fsClamp(target));
  }

  function fsBeginPan(clientX, clientY) {
    fsCancelSpring();
    _fs.drag = { x: clientX, y: clientY, view: fsCopyView(_fs.view) };
  }

  function fsMovePan(clientX, clientY) {
    if (!_fs || !_fs.drag) return;
    var start = _fs.drag;
    var layout = fsLayout(start.view);
    var next = fsCopyView(start.view);
    next.x -= (clientX - start.x) / layout.pxPerUnit;
    next.y -= (clientY - start.y) / layout.pxPerUnit;
    fsWrite(fsResist(next));
  }

  function fsBeginPinch(touches) {
    fsCancelSpring();
    var x = (touches[0].clientX + touches[1].clientX) / 2;
    var y = (touches[0].clientY + touches[1].clientY) / 2;
    var dx = touches[0].clientX - touches[1].clientX;
    var dy = touches[0].clientY - touches[1].clientY;
    _fs.pinch = {
      distance: Math.max(Math.hypot(dx, dy), 1),
      scale: fsScale(_fs.view),
      anchor: fsClientToUser(x, y, _fs.view),
    };
    _fs.drag = null;
  }

  function fsGesturePoint(event) {
    var rect = _fs.stage.getBoundingClientRect();
    return {
      x: Number.isFinite(event.clientX) ? event.clientX : rect.left + rect.width / 2,
      y: Number.isFinite(event.clientY) ? event.clientY : rect.top + rect.height / 2,
    };
  }

  function closeMermaidFullscreen() {
    _fsEdgeBack.deactivate();
    if (!_fs) return;
    fsCancelSpring();
    if (_fs.detach) _fs.detach();
    _fs.overlay.remove();
    document.removeEventListener('keydown', _fs.onKey);
    _fs = null;
  }
  window.closeMermaidFullscreen = closeMermaidFullscreen;

  window.openMermaidFullscreen = function (btn) {
    var block = btn.closest('.mermaid-block');
    if (!block) return;
    var svg = block.querySelector('.mermaid-svg > svg');
    var code = (block.querySelector('.mermaid-src') || {}).textContent || '';
    // Prefer the live SVG; fall back to the source-keyed cache (block may show code/failed).
    var svgHtml = svg ? svg.outerHTML : (_svgCache[code.trim()] || '');
    if (!svgHtml) return; // nothing rendered to show

    var overlay = document.createElement('div');
    overlay.className = 'mermaid-fs-overlay';
    overlay.innerHTML =
      '<button class="mermaid-fs-close" aria-label="Close">'
      + '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>'
      + '<div class="mermaid-fs-stage">' + svgHtml + '</div>';
    document.body.appendChild(overlay);
    _fsEdgeBack.activate();

    var stage = overlay.querySelector('.mermaid-fs-stage');
    var fullSvg = stage.querySelector('svg');
    var base = fsReadViewBox(fullSvg);
    fullSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    fullSvg.setAttribute('width', '100%');
    fullSvg.setAttribute('height', '100%');
    fullSvg.removeAttribute('transform');

    _fs = {
      overlay: overlay,
      stage: stage,
      svg: fullSvg,
      base: fsCopyView(base),
      home: fsCopyView(base),
      view: fsCopyView(base),
      drag: null,
      pinch: null,
      gesture: null,
      raf: 0,
    };
    _fs.home = fsHomeView();
    _fs.view = fsCopyView(_fs.home);
    _fs.onKey = function (e) { if (e.key === 'Escape') closeMermaidFullscreen(); };
    document.addEventListener('keydown', _fs.onKey);
    window.addEventListener('resize', _fs.onResize = function () { fsResize(); });

    overlay.querySelector('.mermaid-fs-close').addEventListener('click', closeMermaidFullscreen);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMermaidFullscreen(); });

    // Wheel / trackpad-pinch zoom, anchored at the cursor.
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      fsCancelSpring();
      var anchor = fsClientToUser(e.clientX, e.clientY, _fs.view);
      var factor = Math.exp(-e.deltaY * 0.0015);
      var scale = Math.max(FS_MIN_SCALE, Math.min(fsScale(_fs.view) * factor, FS_MAX_SCALE));
      fsWrite(fsClamp(fsViewAtScale(scale, e.clientX, e.clientY, anchor)));
    }, { passive: false });

    // Drag to pan (mouse + single-touch).
    stage.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      fsBeginPan(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', _fs.mm = function (e) { fsMovePan(e.clientX, e.clientY); });
    window.addEventListener('mouseup', _fs.mu = function () {
      if (!_fs || !_fs.drag) return;
      _fs.drag = null;
      fsSettle();
    });

    // Two-finger pinch zoom + one-finger pan for touch.
    stage.addEventListener('touchstart', function (e) {
      e.preventDefault();
      if (_fs.gesture) return;
      if (e.touches.length === 2) {
        fsBeginPinch(e.touches);
      } else if (e.touches.length === 1) {
        _fs.pinch = null;
        fsBeginPan(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    stage.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (_fs.gesture) return;
      if (e.touches.length === 2) {
        if (!_fs.pinch) fsBeginPinch(e.touches);
        var x = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var y = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        var dy = e.touches[0].clientY - e.touches[1].clientY;
        var scale = fsElasticScale(_fs.pinch.scale * Math.hypot(dx, dy) / _fs.pinch.distance);
        fsWrite(fsResist(fsViewAtScale(scale, x, y, _fs.pinch.anchor)));
      } else if (e.touches.length === 1) {
        if (!_fs.drag) fsBeginPan(e.touches[0].clientX, e.touches[0].clientY);
        fsMovePan(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: false });
    stage.addEventListener('touchend', function (e) {
      if (e.touches.length === 1) {
        var endedPinch = !!_fs.pinch;
        _fs.pinch = null;
        _fs.drag = null;
        if (endedPinch) fsSettle();
        else fsBeginPan(e.touches[0].clientX, e.touches[0].clientY);
      } else if (!e.touches.length) {
        _fs.drag = null;
        _fs.pinch = null;
        _fs.gesture = null;
        fsSettle();
      }
    });
    stage.addEventListener('touchcancel', function () {
      _fs.drag = null;
      _fs.pinch = null;
      _fs.gesture = null;
      fsSettle();
    });

    // WKWebView exposes native gesture events on iOS. Use them when present so pinch
    // scale and gesture-end rebound do not depend on two touchend events arriving together.
    stage.addEventListener('gesturestart', function (e) {
      e.preventDefault();
      fsCancelSpring();
      var point = fsGesturePoint(e);
      _fs.gesture = {
        scale: fsScale(_fs.view),
        anchor: fsClientToUser(point.x, point.y, _fs.view),
      };
      _fs.drag = null;
      _fs.pinch = null;
    }, { passive: false });
    stage.addEventListener('gesturechange', function (e) {
      if (!_fs.gesture) return;
      e.preventDefault();
      var point = fsGesturePoint(e);
      var scale = fsElasticScale(_fs.gesture.scale * (Number(e.scale) || 1));
      fsWrite(fsResist(fsViewAtScale(scale, point.x, point.y, _fs.gesture.anchor)));
    }, { passive: false });
    stage.addEventListener('gestureend', function (e) {
      if (!_fs.gesture) return;
      e.preventDefault();
      _fs.gesture = null;
      fsSettle();
    }, { passive: false });

    _fs.detach = function () {
      window.removeEventListener('mousemove', _fs.mm);
      window.removeEventListener('mouseup', _fs.mu);
      window.removeEventListener('resize', _fs.onResize);
    };
    fsWrite(_fs.home);
  };
})();
