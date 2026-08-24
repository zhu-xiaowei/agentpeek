// Message rendering orchestrator
(function () {
  function escapeAttribute(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  window.markCodexExploreGroups = function (container) {
    if (!container) return;
    let exploreRows = [];
    let exploreGroupSequence = 0;
    const flushExploreRun = () => {
      if (!exploreRows.length) return;
      const items = exploreRows.flatMap((row) => Array.from(row.children));
      for (const item of items) {
        item.classList?.remove(
          'codex-explore-continuation',
          'codex-explore-group-start',
          'codex-explore-group-connected',
        );
        if (item.dataset) delete item.dataset.toolDetailsGroup;
      }
      for (let start = 0; start < items.length;) {
        if (!items[start].classList?.contains('codex-explore')) {
          start++;
          continue;
        }
        let end = start + 1;
        while (end < items.length && items[end].classList?.contains('codex-explore')) end++;
        if (end - start > 1) {
          const groupItems = items.slice(start, end);
          const groupId = `codex-explore-${exploreGroupSequence++}`;
          const collapsed = groupItems.every((item) =>
            item.classList.contains('tool-details-collapsed'));
          items[start].classList.add('codex-explore-group-start');
          for (let index = start + 1; index < end; index++) {
            items[index].classList.add('codex-explore-continuation');
          }
          for (const item of groupItems) {
            item.dataset.toolDetailsGroup = groupId;
            window.setToolDetailsCollapsed?.(item, collapsed);
          }
          if (end < items.length) {
            for (let index = start; index < end; index++) {
              items[index].classList.add('codex-explore-group-connected');
            }
          }
        }
        start = end;
      }
      exploreRows = [];
    };
    for (const row of container.children) {
      if (row.classList?.contains('assistant-turn')) exploreRows.push(row);
      else flushExploreRun();
    }
    flushExploreRun();
  };

  window.normalizeCodexTimeline = function (container) {
    if (!container) return;
    let previousWait = null;
    for (const row of Array.from(container.children)) {
      if (!row.classList?.contains('assistant-turn')) {
        previousWait = null;
        continue;
      }
      for (const item of Array.from(row.children)) {
        const processId = item.classList?.contains('codex-terminal-wait')
          ? String(item.dataset?.codexProcess || '')
          : '';
        if (!processId) {
          previousWait = null;
          continue;
        }
        if (previousWait?.dataset?.codexProcess === processId) {
          const previousRow = previousWait.parentElement;
          previousWait.remove();
          if (previousRow?.classList.contains('assistant-turn')
            && !previousRow.children.length) {
            previousRow.remove();
          }
        }
        previousWait = item;
      }
    }
    window.markCodexExploreGroups(container);
  };

  function buildToolMaps(messages) {
    const resultMap = {};
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue;
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          if (b.codexSuperseded) continue;
          // Attach Agent metadata if present on the message
          if (msg.toolUseResult) b._agentMeta = msg.toolUseResult;
          b._timestamp = msg.timestamp || '';
          resultMap[b.tool_use_id] = b;
        }
      }
    }
    return resultMap;
  }

  // Convert one assistant message into an array of tl-item objects
  function extractItems(msg, resultMap, runtime, options = {}) {
    const items = [];
    if (msg._commandPanel?.type === 'claude-usage' && window.renderClaudeUsagePanel) {
      items.push({ type: 'panel', html: renderClaudeUsagePanel(msg._commandPanel) });
      return items;
    }
    if (!Array.isArray(msg.content)) {
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) items.push({ type: 'text', html: renderAssistantText(text) });
      return items;
    }

    let textBuf = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        if (block.text && block.text.trim()) textBuf.push(block.text);
      } else if (block.type === 'thinking') {
        flush();
        items.push({ type: 'thinking', html: renderThinking(block) });
      } else if (block.type === 'tool_use') {
        const result = resultMap[block.id] || null;
        if (runtime === 'codex' && window.isCodexHiddenTool?.(block, result)) continue;
        flush();
        window._lastToolState = '';
        window._lastToolHasDetails = false;
        const html = renderToolNode(block, result, runtime, {
          collapsed: !!options.collapseToolDetails,
        });
        const emptyTerminalWait = runtime === 'codex'
          && block.name === 'WriteStdin'
          && !String(block.input?.chars || '').length;
        items.push({
          type: 'tool',
          state: window._lastToolState || '',
          toolDetails: !!window._lastToolHasDetails,
          html,
          toolId: block.id,
          codexExplore: runtime === 'codex' && !!window.isCodexExploreTool?.(block, result),
          codexWait: emptyTerminalWait,
          codexProcessId: String(result?.codexProcessId || block.input?.session_id || ''),
          codexBackgroundComplete: result?.codexBackground === 'complete',
        });
      } else if (block.type === 'image' && block.key) {
        flush();
        items.push({ type: 'text', html: `<div class="img-placeholder" data-key="${block.key}"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="3"/><circle cx="18" cy="18" r="14" fill="none" stroke="#8b949e" stroke-width="3" stroke-dasharray="80" stroke-dashoffset="60" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>` });
      }
    }
    flush();

    function flush() {
      if (!textBuf.length) return;
      const joined = textBuf.join('\n');
      textBuf = [];
      items.push({ type: 'text', html: renderAssistantText(joined) });
    }
    return items;
  }

  function normalizeCodexItems(items) {
    return items;
  }

  function itemToHtml(item, timestamp, collapseToolDetails = false) {
    let cls = 'tl-item';
    if (item.type === 'tool') {
      cls += ' tool-node';
      if (item.toolDetails && collapseToolDetails) cls += ' tool-details-collapsed';
      if (item.codexExplore) cls += ' codex-explore';
      if (item.codexWait) cls += ' codex-terminal-wait';
      if (item.codexBackgroundComplete) cls += ' codex-background-complete';
      if (item.state) cls += ' ' + item.state;
    }
    if (item.type === 'text') cls += ' assistant-text';
    if (item.type === 'thinking') cls += ' thinking-tl';
    if (item.type === 'interrupt') cls += ' msg-interrupt';
    if (item.type === 'summary') cls += ' summary-tl';
    if (item.type === 'panel') cls += ' command-panel-tl';
    const toolAttr = item.toolId ? ` data-tool-id="${escapeAttribute(item.toolId)}"` : '';
    const messageAttr = item.messageId ? ` data-message-id="${escapeAttribute(item.messageId)}"` : '';
    const nativeAttr = item.nativeId ? ` data-native-id="${escapeAttribute(item.nativeId)}"` : '';
    const processAttr = item.codexProcessId ? ` data-codex-process="${escapeAttribute(item.codexProcessId)}"` : '';
    const tsAttr = timestamp ? ` data-ts="${escapeAttribute(timestamp)}"` : '';
    return `<div class="${cls}"${toolAttr}${messageAttr}${nativeAttr}${processAttr}${tsAttr}>${item.html}</div>`;
  }

  // Main: render all messages, merging consecutive assistant messages into one timeline
  window.renderMessages = function (messages, runtime, options = {}) {
    const resultMap = buildToolMaps(messages);
    const detailPolicy = window.getToolDetailPolicy?.(runtime) || {};
    const collapseToolDetails = options.collapseToolDetails !== undefined
      ? !!options.collapseToolDetails
      : !!detailPolicy.historyCollapsed;
    const html = [];
    let turnItems = []; // accumulate tl-items for current assistant turn

    function flushTurn() {
      if (!turnItems.length) return;
      const items = runtime === 'codex' ? normalizeCodexItems(turnItems) : turnItems;
      html.push(`<div class="assistant-turn">${items.map(i =>
        itemToHtml(i, i.ts, collapseToolDetails)).join('')}</div>`);
      turnItems = [];
    }

    for (const msg of messages) {
      if (isToolResultOnly(msg)) continue;
      if (window.isSubagentNotificationMsg?.(msg)) continue;

      if (isInterruptMsg(msg)) {
        turnItems.push({
          type: 'interrupt',
          html: renderInterrupt(msg),
          messageId: msg.uuid || '',
          nativeId: msg.nativeId || '',
          ts: msg.timestamp,
        });
        continue;
      }

      // Local command stdout (e.g. /compact result) → render as command output
      if (window.isLocalCommandStdout && window.isLocalCommandStdout(msg)) {
        flushTurn();
        html.push(renderLocalCommandStdout(msg));
        continue;
      }

      // User text message → flush current turn, render as bubble
      if (msg.type === 'user') {
        flushTurn();
        html.push(renderUserBubble(
          msg,
          window.isInheritedAgentContext?.(msg, messages) ? 'agent-context' : '',
        ));
        continue;
      }

      // Assistant → extract items into current turn
      if (msg.type === 'assistant') {
        if (msg._strictManaged) continue;
        const items = extractItems(msg, resultMap, runtime, {
          collapseToolDetails,
        });
        turnItems.push(...items.map(i => ({
          ...i,
          messageId: msg.uuid || '',
          nativeId: msg.nativeId || '',
          ts: i.ts || msg.timestamp,
        })));
        continue;
      }

      if (msg.type === 'system_event') {
        flushTurn();
        html.push(renderSystemEvent(msg));
        continue;
      }

      // Summary stays in the timeline and is collapsed by default.
      if (msg.type === 'summary') {
        const summary = renderSummary(msg);
        if (summary) turnItems.push({ type: 'summary', html: summary, ts: msg.timestamp });
        continue;
      }
      // Metadata types: skip rendering (used for title only)
      if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') continue;
    }
    flushTurn();

    return html.filter(Boolean).join('');
  };

  // Render a single message into tl-item HTML fragments (for incremental append)
  window.renderSingleMessage = function (msg, allMessages, runtime) {
    if (isToolResultOnly(msg)) return '';
    if (isInterruptMsg(msg)) {
      return itemToHtml({
        type: 'interrupt',
        html: renderInterrupt(msg),
        messageId: msg.uuid || '',
        nativeId: msg.nativeId || '',
      }, msg.timestamp);
    }
    if (msg.type === 'system_event') return renderSystemEvent(msg);
    if (msg.type === 'summary') {
      return itemToHtml({ type: 'summary', html: renderSummary(msg) }, msg.timestamp);
    }
    if (msg.type !== 'assistant') return '';
    const resultMap = buildToolMaps(allMessages);
    const detailPolicy = window.getToolDetailPolicy?.(runtime) || {};
    const items = extractItems(msg, resultMap, runtime, {
      collapseToolDetails: !!detailPolicy.realtimeCollapsed,
    });
    return items.map(function (i) {
      return itemToHtml({
        ...i,
        messageId: msg.uuid || '',
        nativeId: msg.nativeId || '',
      }, i.ts || msg.timestamp, !!detailPolicy.realtimeCollapsed);
    }).join('');
  };

})();
