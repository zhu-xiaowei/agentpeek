import { state } from '../state.js';

// Tool rendering: Bash, Read, Edit, Write, Grep, Glob, etc.
(function () {
  // On cancel, the bridge denies the ask/plan with interrupt:true; CC overwrites the tool_result with this rejection text.
  var CANCEL_MARK = 'tool use was rejected';
  const CODEX_TOOL_NAMES = {
    Read: 'Explored',
    Grep: 'Explored',
    Glob: 'Explored',
    Edit: 'Edited',
    Write: 'Edited',
    TodoWrite: 'Updated Plan',
    ViewImage: 'Viewed Image',
    ToolSearch: 'Searched Tools',
    WebSearch: 'Searched the web',
    get_goal: 'Checked Goal',
    spawn_agent: 'Spawned Agent',
    send_input: 'Sent Agent Input',
    wait_agent: 'Waited for Agent',
    close_agent: 'Closed Agent',
    request_user_input: 'Requested Input',
    Agent: 'Ran Agent',
    WriteStdin: 'Ran',
  };
  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const SHELL_HIGHLIGHT_CACHE_LIMIT = 256;
  const SHELL_HIGHLIGHT_MAX_CHARS = 1024;
  const shellHighlightCache = new Map();
  const shellKeywords = new Set([
    'case', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function',
    'if', 'in', 'select', 'then', 'time', 'until', 'while',
  ]);

  function shellToken(kind, text) {
    return `<span class="shell-token shell-${kind}">${esc(text)}</span>`;
  }

  function shellOperatorAt(source, index) {
    const three = source.slice(index, index + 3);
    if (three === '<<<' || three === '<<-' || three === ';;&') return three;
    const two = source.slice(index, index + 2);
    if (['&&', '||', '<<', '>>', '|&', ';;', ';&', '>&', '<&', '>|'].includes(two)) return two;
    return '|;&><()'.includes(source[index]) ? source[index] : '';
  }

  function readQuotedShellToken(source, start) {
    const quote = source[start];
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\' && quote === '"' && index + 1 < source.length) {
        index += 2;
        continue;
      }
      if (source[index] === quote) {
        index++;
        break;
      }
      index++;
    }
    return index;
  }

  function readShellVariable(source, start) {
    if (source[start + 1] === '{') {
      const end = source.indexOf('}', start + 2);
      return end === -1 ? source.length : end + 1;
    }
    if (source[start + 1] === '(') return Math.min(start + 2, source.length);
    let index = start + 1;
    while (index < source.length && /[A-Za-z0-9_?!#$*@-]/.test(source[index])) index++;
    return index === start + 1 ? start + 1 : index;
  }

  function heredocEnd(source, start, delimiter) {
    let lineStart = start;
    while (lineStart <= source.length) {
      const newline = source.indexOf('\n', lineStart);
      const lineEnd = newline === -1 ? source.length : newline;
      if (source.slice(lineStart, lineEnd).trim() === delimiter) {
        return { bodyEnd: lineStart, delimiterEnd: lineEnd };
      }
      if (newline === -1) break;
      lineStart = newline + 1;
    }
    return null;
  }

  // Lightweight shell highlighting for compact tool rows. It recognizes syntax
  // positions rather than executable names, so new CLIs work without a command catalog.
  function highlightShellCommand(command) {
    const source = String(command || '');
    if (!source) return '';
    if (shellHighlightCache.has(source)) {
      const cached = shellHighlightCache.get(source);
      shellHighlightCache.delete(source);
      shellHighlightCache.set(source, cached);
      return cached;
    }
    if (source.length > SHELL_HIGHLIGHT_MAX_CHARS) {
      return esc(source);
    }

    let html = '';
    let index = 0;
    let expectsCommand = true;
    let expectsHeredocDelimiter = false;
    let pendingHeredoc = '';
    while (index < source.length) {
      const char = source[index];
      if (char === '\n') {
        html += '\n';
        index++;
        expectsCommand = true;
        if (pendingHeredoc) {
          const end = heredocEnd(source, index, pendingHeredoc);
          if (end) {
            html += shellToken('string', source.slice(index, end.bodyEnd));
            html += shellToken('heredoc', source.slice(end.bodyEnd, end.delimiterEnd));
            index = end.delimiterEnd;
          }
          pendingHeredoc = '';
        }
        continue;
      }
      if (/\s/.test(char)) {
        let end = index + 1;
        while (end < source.length && source[end] !== '\n' && /\s/.test(source[end])) end++;
        html += esc(source.slice(index, end));
        index = end;
        continue;
      }
      if (char === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
        const end = source.indexOf('\n', index);
        const commentEnd = end === -1 ? source.length : end;
        html += shellToken('comment', source.slice(index, commentEnd));
        index = commentEnd;
        continue;
      }
      if (char === '"' || char === "'") {
        const end = readQuotedShellToken(source, index);
        const token = source.slice(index, end);
        html += shellToken(expectsHeredocDelimiter ? 'heredoc' : 'string', token);
        if (expectsHeredocDelimiter) {
          pendingHeredoc = token.slice(1, token.endsWith(char) ? -1 : undefined);
          expectsHeredocDelimiter = false;
        }
        index = end;
        continue;
      }
      if (char === '$') {
        const end = readShellVariable(source, index);
        html += shellToken('variable', source.slice(index, end));
        index = end;
        continue;
      }
      const operator = shellOperatorAt(source, index);
      if (operator) {
        html += shellToken('operator', operator);
        index += operator.length;
        expectsHeredocDelimiter = operator === '<<' || operator === '<<-';
        if (['&&', '||', '|', '|&', ';', '&', '('].includes(operator)) expectsCommand = true;
        continue;
      }

      let end = index + 1;
      while (end < source.length
        && !/\s/.test(source[end])
        && source[end] !== '"'
        && source[end] !== "'"
        && source[end] !== '$'
        && !shellOperatorAt(source, end)) {
        end++;
      }
      const token = source.slice(index, end);
      let kind = '';
      if (expectsHeredocDelimiter) {
        kind = 'heredoc';
        pendingHeredoc = token;
        expectsHeredocDelimiter = false;
      } else if (/^--?[^-]/.test(token) || /^-\d/.test(token)) {
        kind = 'option';
      } else if (shellKeywords.has(token)) {
        kind = 'keyword';
        if (['do', 'else', 'elif', 'then'].includes(token)) expectsCommand = true;
      } else if (expectsCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        kind = 'variable';
      } else if (expectsCommand) {
        kind = 'command-name';
        expectsCommand = false;
      }
      html += kind ? shellToken(kind, token) : esc(token);
      index = end;
    }

    if (shellHighlightCache.size >= SHELL_HIGHLIGHT_CACHE_LIMIT) {
      shellHighlightCache.delete(shellHighlightCache.keys().next().value);
    }
    shellHighlightCache.set(source, html);
    return html;
  }
  window.highlightShellCommand = highlightShellCommand;

  // ANSI escape codes in terminal output → colored HTML (XSS-safe via anser).
  // Fast path: no ESC byte or lib not loaded → plain esc().
  function ansiHtml(str) {
    if (!str) return '';
    str = String(str);
    if (str.indexOf('\x1b') === -1) return esc(str);
    if (!window.Anser) return esc(str);
    // use_classes: emit `ansi-*` class names instead of inline RGB, so our dark
    // theme controls the palette (CC's default colours/dim are invisible on #0d1117).
    return window.Anser.ansiToHtml(window.Anser.escapeForHtml(str), { use_classes: true });
  }
  window.ansiHtml = ansiHtml;

  // Render Bash tool
  function codexCommandSummary(actions) {
    if (!Array.isArray(actions) || !actions.length) return '';
    const kinds = new Set(actions.map((action) => action?.type));
    if (kinds.size !== 1) return '';
    const kind = actions[0]?.type;
    if (kind === 'read') {
      const names = actions.map((action) => action?.name || action?.path).filter(Boolean);
      return names.length ? `Read ${names.join(', ')}` : '';
    }
    if (kind === 'search') {
      const terms = actions.map((action) => action?.query || action?.path).filter(Boolean);
      return terms.length ? `Search ${terms.join(', ')}` : '';
    }
    if (kind === 'list_files') {
      const paths = actions.map((action) => action?.path).filter(Boolean);
      return paths.length ? `List ${paths.join(', ')}` : 'List files';
    }
    return '';
  }

  function renderBash(input, result) {
    const cmd = input.command || input.cmd || JSON.stringify(input);
    const actions = result?.codexCommandActions || input.codexCommandActions;
    const summary = codexCommandSummary(actions) || input.description || '';
    const elevated = input.sandbox_permissions === 'require_escalated';
    const justification = elevated ? String(input.justification || '').trim() : '';
    return {
      name: 'Bash',
      desc: summary || cmd,
      elevated,
      body: (justification
        ? `<div class="tool-note"><span>Request reason</span>${esc(justification)}</div>`
        : '') + grid([
          ['IN', `<code class="shell-command">${highlightShellCommand(cmd)}</code>`],
          result != null ? ['OUT', ansiHtml(resultText(result))] : null,
        ]),
    };
  }

  // Render Read tool
  function renderRead(input, result) {
    const file = shortPath(input.file_path || '');
    let desc = file;
    let line = '';
    if (input.offset || input.limit) {
      const from = (input.offset || 1);
      const to = input.limit ? from + input.limit - 1 : '';
      desc += ` (lines ${from}${to ? '-' + to : ''})`;
      line = to ? `${from}-${to}` : String(from);
    }
    return {
      name: 'Read',
      desc,
      fileLink: input.file_path || '',
      fileLine: line,
      body: readResultBody(result),
    };
  }

  function readResultBody(result) {
    if (!result) return '';
    const c = result.content;
    if (!c) return '';
    let text = '';
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) text = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('');
    text = text.trim();
    if (!text) return '';
    return `<div class="tool-value clamp" onclick="toggleExpand(this)">${ansiHtml(text)}</div>`;
  }

  // File extension → hljs language
  function detectLang(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = { js:'javascript', mjs:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript',
      py:'python', rb:'ruby', css:'css', html:'html', json:'json', sh:'bash', yml:'yaml', yaml:'yaml',
      go:'go', rs:'rust', java:'java', swift:'swift', kt:'kotlin', c:'c', cpp:'cpp', md:'markdown' };
    return map[ext] || null;
  }

  const diffSpecs = new Map();
  let diffInstances = new WeakMap();

  function diffSpecKey(file, oldStr, newStr) {
    const source = `${file}\0${oldStr}\0${newStr}`;
    let first = 2166136261;
    let second = 5381;
    for (let index = 0; index < source.length; index++) {
      const code = source.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second, 33) ^ code;
    }
    return `diff-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}-${source.length.toString(36)}`;
  }

  function fallbackDiff(oldStr, newStr) {
    return '<pre style="color:#e6edf3;padding:8px;font-size:12px">'
      + (oldStr ? oldStr.split('\n').map((line) =>
        '<span style="color:#f85149">- ' + esc(line) + '</span>').join('\n') : '')
      + (oldStr && newStr ? '\n' : '')
      + (newStr ? newStr.split('\n').map((line) =>
        '<span style="color:#3fb950">+ ' + esc(line) + '</span>').join('\n') : '')
      + '</pre>';
  }

  function adoptCurrentDiffInstance(element, host, instance, key) {
    let current = element?.isConnected && element.dataset.diffKey === key
      ? element
      : host?.querySelector(`.diff-container[data-diff-key="${key}"]`);
    if (!current?.isConnected) return null;
    const owner = diffInstances.get(current);
    if (owner && owner !== instance) return null;
    diffInstances.set(current, instance);
    return current;
  }

  async function initializeDiffElement(element) {
    if (!element) return;
    const key = element.dataset.diffKey || '';
    if (!key) return;
    const existing = diffInstances.get(element);
    if (existing?.promise) return existing.promise;
    if (element.dataset.diffState === 'ready'
      || element.dataset.diffState === 'fallback'
      || element.dataset.diffState === 'error') {
      return;
    }

    const spec = diffSpecs.get(key);
    if (!spec) {
      element.innerHTML = '<div class="diff-unavailable">Diff unavailable</div>';
      element.dataset.diffState = 'error';
      return;
    }

    const instance = { promise: null };
    const host = element.closest('.tool-node');
    diffInstances.set(element, instance);
    instance.promise = (async () => {
      const content = document.getElementById('content');
      let staging = null;
      element.dataset.diffState = 'loading';
      try {
        await window.loadDiffViewer?.();
        element = adoptCurrentDiffInstance(element, host, instance, key);
        if (!element) return;
        if (!window.Diff || !window.Diff2HtmlUI) throw new Error('Diff viewer unavailable');
        const a = spec.oldStr.endsWith('\n') ? spec.oldStr : spec.oldStr + '\n';
        const b = spec.newStr.endsWith('\n') ? spec.newStr : spec.newStr + '\n';
        const patch = window.Diff.createTwoFilesPatch(
          spec.file, spec.file, a, b, '', '', { context: 3 },
        );
        staging = document.createElement('div');
        staging.className = 'diff-render-staging';
        const targetWidth = Math.ceil(
          element.getBoundingClientRect().width
          || element.closest('.tool-body')?.getBoundingClientRect().width
          || content?.clientWidth
          || 720,
        );
        staging.style.width = targetWidth + 'px';
        document.body.appendChild(staging);
        const ui = new window.Diff2HtmlUI(staging, patch, {
          drawFileList: false,
          fileListToggle: false,
          fileContentToggle: false,
          stickyFileHeaders: false,
          outputFormat: 'line-by-line',
          matching: 'lines',
          colorScheme: 'dark',
          highlight: true,
        });
        ui.draw();
        staging.querySelectorAll(
          '.d2h-file-wrapper, .d2h-file-diff, .d2h-code-wrapper, .d2h-diff-table, .d2h-diff-tbody',
        ).forEach((node) => {
          node.style.backgroundColor = 'transparent';
        });
        const lang = detectLang(spec.fullPath);
        if (lang) {
          staging.querySelectorAll('.d2h-code-line-ctn').forEach((node) => {
            node.classList.add('language-' + lang, lang);
          });
          staging.querySelectorAll('.d2h-file-wrapper').forEach((node) => {
            node.dataset.lang = lang;
          });
          staging.querySelectorAll('code').forEach((node) => {
            node.classList.add('language-' + lang, lang);
          });
        }
        ui.highlightCode();
        if (lang && window.hljs) {
          staging.querySelectorAll('.d2h-code-line-ctn').forEach((node) => {
            if (!node.textContent.trim() || node.querySelector('[class*="hljs-"]')) return;
            const delIns = node.querySelectorAll('del, ins');
            if (delIns.length) {
              delIns.forEach((tag) => {
                if (!tag.textContent.trim()) return;
                try {
                  tag.innerHTML = window.hljs.highlight(
                    tag.textContent, { language: lang, ignoreIllegals: true },
                  ).value;
                } catch (e) {}
              });
            } else {
              try {
                node.innerHTML = window.hljs.highlight(
                  node.textContent, { language: lang, ignoreIllegals: true },
                ).value;
              } catch (e) {}
            }
          });
        }
        element = adoptCurrentDiffInstance(element, host, instance, key);
        if (!element) return;
        let stagedHeight = Math.ceil(Math.max(
          staging.getBoundingClientRect().height,
          staging.scrollHeight || 0,
        ));
        if (stagedHeight <= 10
          && /jsdom/i.test(window.navigator.userAgent)
          && staging.childElementCount) {
          stagedHeight = 24;
        }
        if (stagedHeight <= 10) throw new Error('Diff layout height collapsed');
        element.style.minHeight = Math.max(24, stagedHeight) + 'px';
        element.replaceChildren(...Array.from(staging.childNodes));
        staging.remove();
        element.dataset.diffState = 'ready';
      } catch (e) {
        element = adoptCurrentDiffInstance(element, host, instance, key);
        if (!element) return;
        element.style.minHeight = '24px';
        element.innerHTML = fallbackDiff(spec.oldStr, spec.newStr);
        element.dataset.diffState = 'fallback';
      } finally {
        staging?.remove();
        element = adoptCurrentDiffInstance(element, host, instance, key);
        if (!element) return;
        window.clampOverflow?.(element.closest('.tool-node'));
        if (state.stickBottom && content
          && content === document.getElementById('content')) {
          content.scrollTop = content.scrollHeight;
        }
      }
    })();
    return instance.promise;
  }

  window.initializeToolDetails = function (node) {
    if (!node) return Promise.resolve();
    return Promise.all(Array.from(node.querySelectorAll('.diff-container[data-diff-key]'))
      .map((element) => initializeDiffElement(element)));
  };

  window.hydrateVisibleToolDetails = function (root) {
    if (!root) return Promise.resolve();
    const nodes = [];
    if (root.matches?.('.tool-node:not(.tool-details-collapsed)')) nodes.push(root);
    root.querySelectorAll?.('.tool-node:not(.tool-details-collapsed)').forEach((node) => {
      nodes.push(node);
    });
    return Promise.all(nodes.map((node) => window.initializeToolDetails(node)));
  };

  window.resetToolDetails = function () {
    diffSpecs.clear();
    diffInstances = new WeakMap();
  };

  window.afterToolDomMutation = function (root) {
    return window.hydrateVisibleToolDetails(root);
  };

  function registerDiffSpec(file, fullPath, oldStr, newStr) {
    const key = diffSpecKey(fullPath || file, oldStr, newStr);
    if (!diffSpecs.has(key)) {
      diffSpecs.set(key, {
        key,
        file,
        fullPath,
        oldStr,
        newStr,
      });
    }
    return key;
  }

  // Render Edit tool with Diff2HtmlUI
  function renderEdit(input, result) {
    const file = shortPath(input.file_path || '');
    const fullPath = input.file_path || file;
    const oldStr = input.old_string || '';
    const newStr = input.new_string || '';

    let diffHtml = '';
    if (oldStr || newStr) {
      const diffKey = registerDiffSpec(file, fullPath, oldStr, newStr);
      diffHtml = `<div class="diff-container" data-diff-key="${diffKey}"></div>`;
    }

    const status = resultText(result);
    const statusLabel = status.includes('successfully') ? 'Modified' : (status.includes('Created') ? 'Created' : '');
    return { name: 'Edit', desc: file, fileLink: fullPath, status: statusLabel, body: diffHtml };
  }

  // Render Write tool
  function renderWrite(input, result) {
    const file = shortPath(input.file_path || '');
    return {
      name: 'Write',
      desc: file,
      fileLink: input.file_path || '',
      body: result != null ? `<div class="tool-value clamp" onclick="toggleExpand(this)">${esc(resultText(result))}</div>` : '',
    };
  }

  function renderViewImage(input) {
    const file = input.path || input.file_path || '';
    return {
      name: 'View Image',
      desc: shortPath(file),
      fileLink: file,
      body: '',
    };
  }

  // Render Grep/Glob tool
  function renderSearch(name, input, result) {
    const pattern = input.pattern || '';
    const path = input.path ? shortPath(input.path) : '';
    const desc = pattern + (path ? ` in ${path}` : '');
    return {
      name,
      desc,
      body: result != null && resultText(result).trim() ? `<div class="tool-value clamp" onclick="toggleExpand(this)">${ansiHtml(resultText(result))}</div>` : '',
    };
  }

  // Render TodoWrite as checklist
  function renderTodo(input, result) {
    const todos = input.todos || [];
    const explanation = String(input.explanation || '').trim();
    if (!todos.length && !explanation) return { name: 'Update Todos', desc: '', body: '' };
    const labels = { completed: 'Completed', in_progress: 'In progress', pending: 'Pending' };
    const icons = {
      completed: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M5.25 8.15 7.15 10l3.7-4.05"/></svg>',
      in_progress: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><circle class="plan-status-dot" cx="8" cy="8" r="2.25"/></svg>',
      pending: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/></svg>',
    };
    const html = todos.map(t => {
      const s = Object.hasOwn(labels, t.status) ? t.status : 'pending';
      const text = String(t.content || t.step || '').trim();
      return `<div class="plan-item plan-item-${s}">
        <span class="plan-status-icon" role="img" aria-label="${labels[s]}">${icons[s]}</span>
        <span class="plan-item-text">${esc(text)}</span>
      </div>`;
    }).join('');
    const note = explanation
      ? `<div class="tool-note plan-explanation"><span>Plan note</span>${esc(explanation)}</div>`
      : '';
    const list = html ? `<div class="plan-list">${html}</div>` : '';
    return { name: 'Update Todos', desc: '', body: note + list };
  }

  // Render Agent tool with stats
  function renderAgent(input, result) {
    const desc = input.description || input.subagent_type || '';
    const meta = result?._agentMeta;
    let statsHtml = '';
    if (meta) {
      const secs = Math.round((meta.totalDurationMs || 0) / 1000);
      const calls = meta.totalToolUseCount || 0;
      // Background agent launches with 0/0 stats (meaningless) — only show real counts.
      if (calls > 0 || secs > 0) {
        statsHtml = `<span class="tool-status">${calls} tool calls, ${secs}s</span>`;
      }
    } else if (!result) {
      // No result yet — show running timer with tool_use id for later update
      const timerId = 'timer-' + Math.random().toString(36).slice(2, 8);
      statsHtml = `<span class="tool-status agent-timer" id="${timerId}">0s</span>`;
      setTimeout(() => {
        const start = Date.now();
        const el = document.getElementById(timerId);
        if (!el) return;
        const iv = setInterval(() => {
          const timer = document.getElementById(timerId);
          if (!timer || timer.dataset.stopped) { clearInterval(iv); return; }
          timer.textContent = Math.round((Date.now() - start) / 1000) + 's';
        }, 1000);
      }, 50);
    }
    const bodyText = result ? resultText(result) : '';
    return {
      name: 'Agent',
      desc,
      _statsHtml: statsHtml,
      body: bodyText ? `<div class="tool-value">${esc(bodyText)}</div>` : '',
      collapsible: bodyText.length > 500,
    };
  }

  // Generic fallback
  function renderGeneric(name, input, result) {
    // Cancelled ask/plan: show a clean [Interrupted] instead of CC's long rejection text.
    var out = result != null ? resultText(result) : null;
    if (out != null && out.indexOf(CANCEL_MARK) !== -1) out = '[Interrupted]';
    return {
      name,
      desc: truncate(JSON.stringify(input), 80),
      body: grid([
        ['IN', esc(truncate(JSON.stringify(input, null, 2), 1500))],
        out != null ? ['OUT', ansiHtml(out)] : null,
      ]),
    };
  }

  function codexMcpInfo(input, result) {
    const server = result?.codexMcpServer || input?.codexMcpServer || '';
    const tool = result?.codexMcpTool || input?.codexMcpTool || '';
    return server && tool ? { server, tool } : null;
  }

  function renderCodexMcp(input, result) {
    const invocation = codexMcpInfo(input, result);
    const visibleInput = Object.fromEntries(
      Object.entries(input || {}).filter(([key]) => !key.startsWith('codexMcp')),
    );
    const out = result != null ? resultText(result) : null;
    return {
      name: result ? 'Called' : 'Calling',
      desc: invocation ? `${invocation.server}.${invocation.tool}` : '',
      body: grid([
        ['IN', esc(truncate(JSON.stringify(visibleInput, null, 2), 1500))],
        out != null ? ['OUT', ansiHtml(out)] : null,
      ]),
    };
  }

  function renderWebSearch(input) {
    return {
      name: 'WebSearch',
      desc: input.query || input.url || '',
      body: '',
    };
  }

  function renderTerminalWait(input, result) {
    const command = result?.codexCommand || input.codexCommand || '';
    return {
      name: 'WriteStdin',
      desc: command || `Terminal ${input.session_id || ''}`.trim(),
      body: '',
      expandDesc: !!command,
    };
  }

  // Build tool grid HTML
  function grid(rows) {
    const valid = rows.filter(Boolean);
    if (!valid.length) return '';
    return `<div class="tool-grid">${valid.map(([label, content]) =>
      `<div class="tool-row"><div class="tool-label">${esc(label)}</div><div class="tool-value">${content}</div></div>`
    ).join('')}</div>`;
  }

  // Extract text from tool_result content
  function resultText(result) {
    if (!result) return '';
    const c = result.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(b => b.text || '').join('');
    return JSON.stringify(c);
  }

  function shortPath(p) {
    // Show last 2-3 segments
    const parts = p.split('/');
    return parts.length > 3 ? '.../' + parts.slice(-3).join('/') : p;
  }

  function truncate(s, max) {
    if (!s) return '';
    return s.length > max ? s.slice(0, max) + '...' : s;
  }

  function isExploreCommand(input, result) {
    return (result?.codexCommandKind || input?.codexCommandKind) === 'explore';
  }

  window.isCodexExploreTool = function (toolUse, result) {
    return toolUse?.name === 'Bash' && isExploreCommand(toolUse.input || {}, result);
  };

  window.isCodexHiddenTool = function (toolUse, result) {
    if (toolUse?.name === 'Bash' && result?.codexBackground === 'running') return true;
    if (toolUse?.name !== 'WriteStdin' || String(toolUse.input?.chars || '').length) return false;
    return !!result && result.codexWait !== 'waiting';
  };

  function codexToolName(name, input, result) {
    if (codexMcpInfo(input, result)) return result ? 'Called' : 'Calling';
    if (name === 'Bash') return isExploreCommand(input, result) ? 'Explored' : 'Ran';
    if (name === 'WriteStdin' && !String(input.chars || '').length) {
      return result ? 'Waited for background terminal' : 'Waiting for background terminal';
    }
    return CODEX_TOOL_NAMES[name] || name;
  }

  function exitCode(result) {
    if (Number.isInteger(result?.codexExitCode)) return result.codexExitCode;
    const match = /Process exited with code\s+(-?\d+)/i.exec(resultText(result));
    return match ? Number(match[1]) : null;
  }

  // Determine error state from result
  function toolState(result, name) {
    if (!result) return '';
    // AskUserQuestion/ExitPlanMode reply via deny carries is_error:true: an answer isn't an error; a cancel is 'warning'.
    if (name === 'AskUserQuestion' || name === 'ExitPlanMode' || name === 'exit_plan_mode') {
      return resultText(result).indexOf(CANCEL_MARK) !== -1 ? 'warning' : '';
    }
    if (result.is_error) return 'error';
    const code = exitCode(result);
    if (code !== null && code !== 0) return 'error';
    // Only check short results (tool stderr/error messages), not long agent outputs
    const t = resultText(result);
    if (t.length < 500) {
      const low = t.toLowerCase();
      if (low.includes('error') || low.includes('failed') || low.includes('permission denied')) return 'error';
    }
    return '';
  }

  // Main: render a tool_use + tool_result pair (wrapping tl-item div is in render.js)
  window.detectLang = detectLang;
  const TOOL_DETAIL_POLICIES = Object.freeze({
    codex: Object.freeze({
      enabled: true,
      historyCollapsed: true,
      realtimeCollapsed: false,
    }),
  });
  const DEFAULT_TOOL_DETAIL_POLICY = Object.freeze({
    enabled: false,
    historyCollapsed: false,
    realtimeCollapsed: false,
  });

  window.getToolDetailPolicy = function (runtime) {
    return TOOL_DETAIL_POLICIES[runtime] || DEFAULT_TOOL_DETAIL_POLICY;
  };

  window.setToolDetailsCollapsed = function (node, collapsed) {
    if (!node) return;
    node.classList.toggle('tool-details-collapsed', collapsed);
    const header = node.querySelector(':scope > .tool-header');
    if (header?.classList.contains('tool-details-toggle')) {
      header.setAttribute('aria-expanded', String(!collapsed));
    }
  };

  window.toggleToolDetails = function (header) {
    const selection = window.getSelection?.();
    if (selection?.toString()) return;
    const node = header?.closest('.tool-node');
    if (!node) return;
    const collapsed = !node.classList.contains('tool-details-collapsed');
    const groupId = node.dataset.toolDetailsGroup;
    const root = node.closest('.messages') || document;
    const members = groupId
      ? Array.from(root.querySelectorAll('[data-tool-details-group]'))
        .filter((candidate) => candidate.dataset.toolDetailsGroup === groupId)
      : [node];
    for (const member of members) {
      window.setToolDetailsCollapsed(member, collapsed);
      if (!collapsed) {
        Promise.resolve(window.initializeToolDetails?.(member))
          .then(() => window.clampOverflow?.(member));
      }
    }
  };

  window.toggleToolDesc = function (header) {
    const expanded = header.classList.toggle('expanded-desc');
    header.setAttribute('aria-expanded', String(expanded));
  };

  window.renderToolNode = function (toolUse, toolResult, runtime, options = {}) {
    const name = toolUse.name || 'Tool';
    const input = toolUse.input || {};
    const codexMcp = runtime === 'codex' && codexMcpInfo(input, toolResult);
    const detailPolicy = window.getToolDetailPolicy(runtime);
    const requestedDetailsCollapsed = detailPolicy.enabled && !!options.collapsed;
    const dispatchers = {
      Bash: () => renderBash(input, toolResult),
      Read: () => renderRead(input, toolResult),
      Edit: () => renderEdit(input, toolResult),
      Write: () => renderWrite(input, toolResult),
      Grep: () => renderSearch('Grep', input, toolResult),
      Glob: () => renderSearch('Glob', input, toolResult),
      ViewImage: () => renderViewImage(input),
      TodoWrite: () => renderTodo(input, toolResult),
      Agent: () => renderAgent(input, toolResult),
      WebSearch: () => renderWebSearch(input),
      WriteStdin: () => !String(input.chars || '').length
        ? renderTerminalWait(input, toolResult)
        : renderGeneric(name, input, toolResult),
    };
    const info = codexMcp
      ? renderCodexMcp(input, toolResult)
      : (dispatchers[name] || (() => renderGeneric(name, input, toolResult)))();
    if (runtime === 'codex') info.name = codexToolName(name, input, toolResult);
    // Store state as data attr for CSS (render.js adds .error/.warning to tl-item)
    window._lastToolState = toolState(toolResult, name);

    const status = info.status || '';
    const statusHtml = info._statsHtml || (status ? `<span class="tool-status">${esc(status)}</span>` : '');
    const elevatedHtml = info.elevated ? '<span class="tool-flag">Elevated request</span>' : '';
    const fileLine = info.fileLine || '';
    const matchId = (!fileLine && info.fileLink && (name === 'Edit' || name === 'Write')) ? (toolUse.id || '') : '';
    const descHtml = info.fileLink
      ? `<span class="tool-desc file-link" onclick="event.stopPropagation();openFile('${esc(info.fileLink).replace(/'/g, "\\'")}','${esc(info.desc).replace(/'/g, "\\'")}','${fileLine}','${matchId}')">${esc(info.desc)}</span>`
      : `<span class="tool-desc">${esc(info.desc)}</span>`;
    const id = 'tool-' + Math.random().toString(36).slice(2, 8);

    const noClamp = name === 'TodoWrite';
    const clampClass = noClamp ? ' no-clamp' : (info.collapsible ? ' collapsible' : '');
    const bodyHtml = info.body
      ? `<div class="tool-body">
          <div class="tool-body-content${clampClass}" id="${id}" ${noClamp ? '' : `onclick="toggleExpand(this)"`}>${info.body}</div>
        </div>`
      : '';
    const detailsEnabled = detailPolicy.enabled && !!info.body;
    const detailsCollapsed = detailsEnabled && requestedDetailsCollapsed;
    window._lastToolHasDetails = detailsEnabled;
    const baseHeaderClass = detailsEnabled
      ? 'tool-header tool-details-toggle'
      : (info.expandDesc ? 'tool-header expandable-desc' : 'tool-header');
    const headerAttrs = detailsEnabled
      ? ` role="button" tabindex="0" aria-expanded="${String(!detailsCollapsed)}"
        onclick="toggleToolDetails(this)"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleToolDetails(this)}"`
      : info.expandDesc
      ? ` role="button" tabindex="0" aria-expanded="false"
        onclick="toggleToolDesc(this)"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleToolDesc(this)}"`
      : '';
    const chevronHtml = detailsEnabled
      ? '<span class="tool-detail-chevron" aria-hidden="true">&#8250;</span>'
      : '';

    return `<div class="${baseHeaderClass}"${headerAttrs}>
        ${chevronHtml}
        <span class="tool-name">${esc(info.name)}</span>
        ${descHtml}
        ${elevatedHtml}
        ${statusHtml}
      </div>
      ${bodyHtml}`;
  };
})();
