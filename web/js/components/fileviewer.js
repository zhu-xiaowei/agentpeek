// Click-to-sync project file viewer: request_file → file_ready → GET /file/{key} → highlight.
import { state } from '../state.js';
import { registerEdgeBackLayer } from '../edge-back.js';

var HIGHLIGHT_MAX = 256 * 1024;
var FILE_REQ_TIMEOUT = 20000;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var _current = null; // { path, text, truncated, line, snippet }
var _previewToken = 0; // guards against stale preview results overwriting the view
var _edgeBack = registerEdgeBackLayer({
  navigateBack: closeFileViewer,
  foregroundSelectors: ['#fileOverlay'],
  guardZIndex: 1001,
});

// Concurrent async file fetches (used by HTML preview to pull referenced assets).
var _asyncReqs = new Map(); // requestId → { resolve }

function requestFileAsync(absPath) {
  return new Promise(function (resolve) {
    var requestId = 'fa_' + (++state._fileReqSeq);
    var timer = setTimeout(function () {
      if (_asyncReqs.delete(requestId)) resolve(null);
    }, FILE_REQ_TIMEOUT);
    _asyncReqs.set(requestId, function (msg) { clearTimeout(timer); resolve(msg); });
    var project = state.appState.project;
    var projectHash = state.wsProjectHash || (project && project.hash) || '';
    window.wsSend({
      action: 'request_file', path: absPath, sessionId: state.wsSessionId,
      projectHash: projectHash, device: state.appState.device || '', requestId: requestId,
    });
  });
}

function overlay() { return document.getElementById('fileOverlay'); }

function setBody(html) {
  var b = document.getElementById('fileOverlayBody');
  if (b) b.innerHTML = html;
}

function showTabs(show) {
  var t = document.getElementById('fileOverlayTabs');
  if (!t) return;
  t.style.display = show ? '' : 'none';
  if (show) setActiveTab('source');
}

function setActiveTab(mode) {
  var t = document.getElementById('fileOverlayTabs');
  if (!t) return;
  t.querySelectorAll('.file-tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function isHtml(path) { return /\.html?$/i.test(path || ''); }
function isMarkdown(path) { return /\.(md|markdown)$/i.test(path || ''); }
function isPreviewable(path) { return isHtml(path) || isMarkdown(path); }

function showPreview(html) {
  setBody('<iframe class="file-preview" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>');
  var f = document.querySelector('#fileOverlayBody .file-preview');
  if (f) f.srcdoc = html;
}

function setFileViewMode(mode) {
  if (!_current) return;
  setActiveTab(mode);
  if (mode !== 'preview') {
    _previewToken++;
    return renderSource(_current.path, _current.text, _current.truncated, _current.line, _current.snippet);
  }
  if (isMarkdown(_current.path) && window.renderMd) {
    _previewToken++;
    setBody('<div class="assistant-text md-preview">' + window.renderMd(_current.text) + '</div>');
    var mdDir = _current.path.slice(0, _current.path.lastIndexOf('/') + 1);
    var mdBody = document.querySelector('#fileOverlayBody .md-preview');
    if (mdBody) inlineImages(mdBody, mdDir); // mutates this node; harmless if view later changes
    return;
  }
  var token = ++_previewToken;
  setBody('<div class="file-loading" role="status" aria-label="Loading preview"><div class="spinner"></div></div>');
  buildPreviewHtml(_current.text, _current.path).then(function (html) {
    if (token === _previewToken) showPreview(html);
  });
}

function isRelativeUrl(u) { return u && !/^(https?:|data:|blob:|#|\/\/|mailto:)/i.test(u); }

// Resolve a relative URL against a directory, collapsing ./ and ../ segments.
function resolvePath(dir, u) {
  var parts = (dir + u.replace(/[?#].*$/, '')).split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' && out.length) continue;
    if (parts[i] === '.') continue;
    if (parts[i] === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(parts[i]);
  }
  return out.join('/');
}

// Replace relative <img src> in a live container with synced data URLs.
function inlineImages(container, dir) {
  var jobs = [];
  container.querySelectorAll('img[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (!isRelativeUrl(src)) return;
    jobs.push(requestFileAsync(resolvePath(dir, src)).then(function (m) {
      if (m && !m.error && m.image) return window.apiText('/api/bridge/image/' + m.key).then(function (b64) {
        var ext = (m.key.split('.').pop() || '').toLowerCase();
        var mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
        el.setAttribute('src', 'data:' + mime + ';base64,' + b64);
      });
    }));
  });
  return Promise.all(jobs);
}

// Inline same-directory relative assets (link/script/img) so the iframe renders complete.
// Remote (http/https/protocol-relative/data:) refs are left untouched. Top-level refs only.
function buildPreviewHtml(html, basePath) {
  var doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); }
  catch (e) { return Promise.resolve(html); }
  var dir = basePath.slice(0, basePath.lastIndexOf('/') + 1);
  var resolve = function (u) { return resolvePath(dir, u); };
  var jobs = [inlineImages(doc.body, dir)];

  doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(function (el) {
    var href = el.getAttribute('href');
    if (!isRelativeUrl(href)) return;
    jobs.push(requestFileAsync(resolve(href)).then(function (m) {
      if (m && !m.error && !m.image) return window.apiText('/api/bridge/file/' + m.key).then(function (css) {
        var style = doc.createElement('style'); style.textContent = css; el.replaceWith(style);
      });
    }));
  });
  doc.querySelectorAll('script[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (!isRelativeUrl(src)) return;
    jobs.push(requestFileAsync(resolve(src)).then(function (m) {
      if (m && !m.error && !m.image) return window.apiText('/api/bridge/file/' + m.key).then(function (js) {
        el.removeAttribute('src'); el.textContent = js;
      });
    }));
  });

  return Promise.all(jobs).then(function () { return '<!DOCTYPE html>' + doc.documentElement.outerHTML; });
}

function closeFileViewer() {
  _edgeBack.deactivate();
  var o = overlay();
  if (o) o.style.display = 'none';
  _current = null;
  showTabs(false);
  if (state._pendingFileReq) { clearTimeout(state._pendingFileReq.timer); state._pendingFileReq = null; }
}

function sendFileRequest(absPath, line, snippet, retriesLeft) {
  var requestId = 'file_' + (++state._fileReqSeq);
  if (state._pendingFileReq) clearTimeout(state._pendingFileReq.timer);
  var timer = setTimeout(function () {
    if (!state._pendingFileReq || state._pendingFileReq.requestId !== requestId) return;
    if (retriesLeft > 0) { sendFileRequest(absPath, line, snippet, retriesLeft - 1); return; }
    state._pendingFileReq = null;
    setBody('<div class="file-error">Request timed out — device may be offline.</div>');
  }, FILE_REQ_TIMEOUT);
  state._pendingFileReq = { requestId: requestId, timer: timer, path: absPath, line: line, snippet: snippet };

  var project = state.appState.project;
  var projectHash = state.wsProjectHash || (project && project.hash) || '';
  window.wsSend({
    action: 'request_file', path: absPath, sessionId: state.wsSessionId,
    projectHash: projectHash, device: state.appState.device || '', requestId: requestId,
  });
}

function openFile(absPath, displayName, lineHint, matchId) {
  if (!absPath) return;
  var o = overlay();
  if (!o) return;
  var titleEl = document.getElementById('fileOverlayTitle');
  titleEl.textContent = displayName || absPath;
  titleEl.title = absPath;
  _current = null;
  showTabs(false);
  setBody('<div class="file-loading" role="status" aria-label="Loading file"><div class="spinner"></div></div>');
  o.style.display = 'flex';
  _edgeBack.activate();
  if (window.attachScrollIndicator) window.attachScrollIndicator(document.getElementById('fileOverlayBody'));
  sendFileRequest(absPath, lineHint || '', matchId ? snippetForTool(matchId) : '', 1);
}

// Find the Edit/Write tool_use by id and return the text it wrote (new_string / content).
function snippetForTool(toolId) {
  var msgs = state.wsAllMessages || [];
  for (var i = 0; i < msgs.length; i++) {
    var c = msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (var j = 0; j < c.length; j++) {
      if (c[j].type === 'tool_use' && c[j].id === toolId) {
        var inp = c[j].input || {};
        return inp.new_string || inp.content || '';
      }
    }
  }
  return '';
}

// Resolve which lines to highlight, in priority order:
//   1. content match (snippet's lines located in the latest file, trimmed compare)
//   2. line hint ("226-280" / "312")
//   3. null → caller shows from the top
// Returns {from,to} (1-based) or null.
function resolveRange(fileText, lineHint, snippet) {
  if (snippet) {
    var snip = snippet.replace(/\s+$/, '').split('\n').map(function (l) { return l.trim(); });
    while (snip.length && !snip[snip.length - 1]) snip.pop();
    if (snip.length && snip[0]) {
      var file = fileText.split('\n');
      var first = snip[0], last = file.length - snip.length;
      for (var i = 0; i <= last; i++) {
        if (file[i].trim() !== first) continue;
        var ok = true;
        for (var k = 1; k < snip.length; k++) {
          if (file[i + k].trim() !== snip[k]) { ok = false; break; }
        }
        if (ok) return { from: i + 1, to: i + snip.length };
      }
    }
  }
  var m = String(lineHint || '').match(/(\d+)(?:-(\d+))?/);
  if (m) return { from: +m[1], to: m[2] ? +m[2] : +m[1] };
  return null;
}

function render(absPath, text, truncated, lineHint, snippet) {
  _current = { path: absPath, text: text, truncated: truncated, line: lineHint, snippet: snippet };
  showTabs(isPreviewable(absPath));
  renderSource(absPath, text, truncated, lineHint, snippet);
}

function renderSource(absPath, text, truncated, lineHint, snippet) {
  var lang = window.detectLang ? window.detectLang(absPath) : null;
  var code;
  if (text.length > HIGHLIGHT_MAX || typeof window.hljs === 'undefined') {
    code = esc(text);
  } else if (lang) {
    try { code = window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
    catch (e) { code = esc(text); }
  } else {
    try { code = window.hljs.highlightAuto(text).value; }
    catch (e) { code = esc(text); }
  }
  var n = code.split('\n').length;
  var range = resolveRange(text, lineHint, snippet);
  var nums = Array.from({ length: n }, function (_, i) {
    var ln = i + 1;
    var hit = range && ln >= range.from && ln <= range.to;
    return hit ? '<span class="file-line-hl">' + ln + '</span>' : String(ln);
  }).join('\n');
  var warn = truncated ? '<div class="file-truncated">⚠ Truncated — showing first 5 MB</div>' : '';
  setBody(
    '<div class="file-code"><pre class="file-lineno">' + nums + '</pre>' +
    '<pre class="file-content"><code>' + code + '</code></pre></div>' + warn
  );
  if (range) scrollToLine(range.from, n);
}

function scrollToLine(line, total) {
  var body = document.getElementById('fileOverlayBody');
  var content = body && body.querySelector('.file-content');
  if (!body || !content) return;
  var y = content.offsetTop + (content.scrollHeight / total) * (line - 1);
  body.scrollTop = Math.max(0, y - body.clientHeight / 2);
}

// Presigned GET URLs expire in 1h; cache them ~50min (10min safety margin) so
// re-opening the same video reuses the URL instead of round-tripping the bridge.
var VIDEO_URL_TTL = 50 * 60 * 1000;

function renderVideo(url) {
  setBody('<video class="file-video" controls playsinline preload="metadata" src="' + esc(url) + '"></video>');
}

function showVideo(key) {
  var c = state.videoUrlCache.get(key);
  if (c && c.exp > Date.now()) return renderVideo(c.url);
  return window.api('/api/bridge/video-url/' + key).then(function (r) {
    if (!r || !r.url) return setBody('<div class="file-error">Failed to load video.</div>');
    if (state.videoUrlCache.size > 50) state.videoUrlCache.delete(state.videoUrlCache.keys().next().value);
    state.videoUrlCache.set(key, { url: r.url, exp: Date.now() + VIDEO_URL_TTL });
    renderVideo(r.url);
  }).catch(function () {
    setBody('<div class="file-error">Failed to load video.</div>');
  });
}

function handleFileReady(msg) {
  var async = _asyncReqs.get(msg.requestId);
  if (async) { _asyncReqs.delete(msg.requestId); return async(msg); }

  var p = state._pendingFileReq;
  if (!p || p.requestId !== msg.requestId) return;
  clearTimeout(p.timer);
  state._pendingFileReq = null;

  if (msg.error) {
    var m = { 'binary file': 'Cannot preview a binary file.', 'is a directory': 'That path is a directory.', 'image too large': 'Image is too large to preview (over 10 MB).', 'video too large': 'Video is too large to preview (over 5 GB).' };
    var detail = msg.path || p.path || '';
    return setBody('<div class="file-error">' + esc(m[msg.error] || ('Failed to load file: ' + msg.error))
      + (detail ? '<div class="file-error-path">' + esc(detail) + '</div>' : '') + '</div>');
  }

  if (msg.video) return showVideo(msg.key);

  if (msg.image) {
    var ext = (msg.key.split('.').pop() || '').toLowerCase();
    var mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
    return window.getImageDataUrl(msg.key, mime).then(function (dataUrl) {
      closeFileViewer();
      if (window.viewImage) window.viewImage(dataUrl);
    }).catch(function () {
      setBody('<div class="file-error">Failed to download image.</div>');
    });
  }

  var line = p.line, snippet = p.snippet;
  var cached = state.fileCache.get(msg.key);
  if (cached) return render(cached.path, cached.text, cached.truncated, line, snippet);

  window.apiText('/api/bridge/file/' + msg.key).then(function (text) {
    if (state.fileCache.size > 50) state.fileCache.delete(state.fileCache.keys().next().value);
    state.fileCache.set(msg.key, { text: text, path: msg.path, truncated: msg.truncated });
    render(msg.path, text, msg.truncated, line, snippet);
  }).catch(function () {
    setBody('<div class="file-error">Failed to download file.</div>');
  });
}

// Bridge acks a video request before its (potentially long) S3 upload finishes.
// Clear the request timeout so it neither fires "timed out" nor retries (which would
// re-upload); keep _pendingFileReq alive so the eventual file_ready still matches.
function handleFileProgress(msg) {
  var p = state._pendingFileReq;
  if (!p || p.requestId !== msg.requestId) return;
  clearTimeout(p.timer);
  p.timer = null;
  if (msg.video) setBody('<div class="file-loading" role="status" aria-label="Uploading video"><div class="spinner"></div></div>');
}

document.addEventListener('keydown', function (e) {
  var o = overlay();
  if (o && o.style.display === 'flex' && e.key === 'Escape') closeFileViewer();
});

Object.assign(window, { openFile: openFile, closeFileViewer: closeFileViewer, handleFileReady: handleFileReady, handleFileProgress: handleFileProgress, setFileViewMode: setFileViewMode });
