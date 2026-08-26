export function isCodexPermissionRequest(msg) {
  return !!(msg.approvalType && msg.approvalType.indexOf('codex-') === 0)
    || !!(msg.input && msg.input.codexApproval);
}

export function createCodexPermissionController(options) {
  var renderPrompt = options.renderPrompt;
  var reply = options.reply;
  var dismiss = options.dismiss;
  var buildToolSummary = options.buildToolSummary;
  var request = null;
  var mcpFields = null;
  var mcpIndex = 0;
  var mcpAnswers = [];

  function reset() {
    request = null;
    mcpFields = null;
    mcpIndex = 0;
    mcpAnswers = [];
  }

  function show(msg) {
    reset();
    var input = msg.input || {};
    var approval = input.codexApproval || {};
    request = {
      requestId: msg.requestId,
      approvalType: msg.approvalType || null,
      input: input,
      decisions: Array.isArray(approval.availableDecisions)
        ? approval.availableDecisions
        : [],
    };

    if (request.approvalType === 'codex-permissions') {
      renderPrompt(buildPermissionsPrompt(input));
    } else if (request.approvalType === 'codex-mcp-elicitation') {
      renderMcpPrompt(input.codexMcpElicitation || {});
    } else {
      var summary = buildToolSummary(msg.toolName, input);
      var promptOptions = buildDecisionOptions(approval, request.approvalType, input);
      renderPrompt({
        title: summary.title,
        description: summary.description,
        options: promptOptions.length ? promptOptions : [
          { label: 'Cancel', act: 'codex:cancel', key: '1', tone: 'deny' },
        ],
      });
    }
  }

  function choose(act, label, isTyped) {
    if (!request) return false;

    if (request.approvalType === 'codex-permissions') {
      var permissionAction = act.indexOf('permissions:') === 0 ? act.slice(12) : 'deny';
      finish({
        approvalResponse: { action: permissionAction },
      });
      return true;
    }

    if (request.approvalType === 'codex-mcp-elicitation') {
      if (mcpFields) {
        chooseMcpField(act, label, isTyped);
      } else {
        var mcpAction = act.indexOf('mcp:') === 0 ? act.slice(4) : 'cancel';
        finish({
          approvalResponse: { action: mcpAction },
        });
      }
      return true;
    }

    var index = act.indexOf('codex:') === 0
      ? parseInt(act.slice(6), 10)
      : NaN;
    var decision = request.decisions[index];
    if (decision === undefined) decision = cancelDecision();
    finish({ decision: decision });
    return true;
  }

  function cancel() {
    if (!request) return false;
    if (request.approvalType === 'codex-permissions') {
      finish({
        approvalResponse: { action: 'deny' },
      });
    } else if (request.approvalType === 'codex-mcp-elicitation') {
      finish({
        approvalResponse: { action: 'cancel' },
      });
    } else {
      finish({ decision: cancelDecision() });
    }
    return true;
  }

  function finish(payload) {
    reply(Object.assign({ requestId: request.requestId }, payload));
    dismiss();
  }

  function cancelDecision() {
    if (request.decisions.includes('cancel')) return 'cancel';
    if (request.decisions.includes('decline')) return 'decline';
    return 'cancel';
  }

  function renderMcpPrompt(elicitation) {
    if (elicitation.responseMode === 'form' && Array.isArray(elicitation.fields)
      && elicitation.fields.length) {
      mcpFields = elicitation.fields;
      renderMcpFormStep();
      return;
    }
    var title = elicitation.isToolApproval
      ? 'Run MCP tool?'
      : (elicitation.serverName || 'MCP server') + ' requests input';
    var promptOptions = [];
    if (elicitation.responseMode === 'approval') {
      promptOptions.push({
        label: 'Allow',
        description: elicitation.isToolApproval
          ? 'Run the tool and continue.'
          : 'Allow this request and continue.',
        act: 'mcp:accept',
        key: '1',
      });
      if ((elicitation.persistModes || []).includes('session')) {
        promptOptions.push({
          label: 'Allow for this session',
          description: elicitation.isToolApproval
            ? 'Run the tool and remember this choice for this session.'
            : 'Allow this request and remember this choice for this session.',
          act: 'mcp:acceptForSession',
          key: String(promptOptions.length + 1),
        });
      }
      if ((elicitation.persistModes || []).includes('always')) {
        promptOptions.push({
          label: 'Always allow',
          description: elicitation.isToolApproval
            ? 'Run the tool and remember this choice for future tool calls.'
            : 'Allow this request and remember this choice for future requests.',
          act: 'mcp:acceptAlways',
          key: String(promptOptions.length + 1),
        });
      }
      if (!elicitation.isToolApproval) {
        promptOptions.push({
          label: 'Deny',
          description: 'Decline this request and continue.',
          act: 'mcp:decline',
          key: String(promptOptions.length + 1),
          tone: 'deny',
        });
      }
    } else if (elicitation.responseMode === 'fallback') {
      promptOptions.push(
        {
          label: 'Yes, provide the requested info',
          act: 'mcp:accept',
          key: '1',
        },
        {
          label: 'No, but continue without it',
          act: 'mcp:decline',
          key: '2',
          tone: 'deny',
        },
      );
    }
    promptOptions.push({
      label: 'Cancel',
      description: elicitation.isToolApproval ? 'Cancel this tool call.' : 'Cancel this request.',
      act: 'mcp:cancel',
      key: String(promptOptions.length + 1),
      tone: 'deny',
    });

    var description = elicitation.message || '';
    var displayParams = elicitation.displayParams || [];
    if (displayParams.length) {
      var paramLines = displayParams.map(function (param) {
        var value = param.value;
        if (typeof value !== 'string') {
          try { value = JSON.stringify(value); } catch (e) { value = String(value); }
        }
        if (value.length > 60) value = value.slice(0, 59) + '…';
        return (param.displayName || param.name) + ': ' + value;
      });
      description += (description ? '\n\n' : '') + paramLines.join('\n');
    }
    renderPrompt({
      title: title,
      description: description,
      options: promptOptions,
    });
  }

  function renderMcpFormStep() {
    var field = mcpFields[mcpIndex] || {};
    var elicitation = request.input.codexMcpElicitation || {};
    var prefix = mcpFields.length > 1 ? '[' + (mcpIndex + 1) + '/' + mcpFields.length + '] ' : '';
    var promptOptions = [];
    if (field.input && field.input.type === 'select') {
      promptOptions = (field.input.options || []).map(function (option, index) {
        return {
          label: option.label,
          description: field.input.defaultIndex === index ? 'Default' : '',
          act: 'mcp-field:' + index,
        };
      });
    } else {
      promptOptions.push({
        label: 'Enter value…',
        act: 'mcp-text',
        hasInput: true,
        placeholder: field.prompt || field.label || '',
      });
    }
    if (!field.required) {
      promptOptions.push({ label: 'Skip', act: 'mcp-skip', tone: 'deny' });
    }
    renderPrompt({
      title: prefix + (field.label || field.id || 'MCP input'),
      description: [
        mcpIndex === 0 ? elicitation.message : '',
        field.prompt && field.prompt !== field.label ? field.prompt : '',
      ].filter(Boolean).join('\n\n'),
      options: promptOptions,
    });
  }

  function chooseMcpField(act, label, isTyped) {
    var field = mcpFields[mcpIndex] || {};
    if (act !== 'mcp-skip') {
      var value;
      if (act === 'mcp-text' || isTyped) {
        value = label;
      } else {
        var index = parseInt(act.slice('mcp-field:'.length), 10);
        var option = (field.input && field.input.options || [])[index];
        if (!option) return;
        value = option.value;
      }
      mcpAnswers.push([field.id, value]);
    }
    if (mcpIndex < mcpFields.length - 1) {
      mcpIndex++;
      renderMcpFormStep();
      return;
    }
    finish({
      approvalResponse: {
        action: 'acceptForm',
        content: Object.fromEntries(mcpAnswers),
      },
    });
  }

  return { show: show, choose: choose, cancel: cancel, reset: reset };
}

function decisionOption(decision, index, approval, approvalType, input) {
  var act = 'codex:' + index;
  var network = approval.networkApprovalContext;
  var additional = approval.additionalPermissions;
  if (decision === 'accept') {
    return { label: network ? 'Yes, just this once' : 'Yes, proceed', act: act, key: String(index + 1) };
  }
  if (decision === 'acceptForSession') {
    var sessionLabel = approvalType === 'codex-file-change'
      ? "Yes, and don't ask again for these files"
      : (network
      ? 'Yes, and allow this host for this conversation'
      : (additional
        ? 'Yes, and allow these permissions for this session'
        : "Yes, and don't ask again for this command in this session"));
    return { label: sessionLabel, act: act, key: String(index + 1) };
  }
  if (decision === 'decline') {
    return {
      label: 'No, continue without running it',
      act: act,
      key: String(index + 1),
      tone: 'deny',
    };
  }
  if (decision === 'cancel') {
    return {
      label: 'No, and tell Codex what to do differently',
      act: act,
      key: String(index + 1),
      tone: 'deny',
    };
  }
  if (decision && decision.acceptWithExecpolicyAmendment) {
    var amendment = decision.acceptWithExecpolicyAmendment.execpolicy_amendment || [];
    var amendmentText = amendment.join(' ').trim();
    var commandText = String(input && input.command || '').trim();
    return {
      label: commandMatchesExecpolicyAmendment(commandText, amendment)
        ? "Yes, and don't ask again for this command"
        : "Yes, and don't ask again for commands that start with `" + amendmentText + '`',
      act: act,
      key: String(index + 1),
    };
  }
  if (decision && decision.applyNetworkPolicyAmendment) {
    var rule = decision.applyNetworkPolicyAmendment.network_policy_amendment || {};
    var allow = rule.action === 'allow';
    return {
      label: allow
        ? 'Yes, and allow this host in the future'
        : 'No, and block this host in the future',
      act: act,
      key: String(index + 1),
      tone: allow ? 'allow' : 'deny',
    };
  }
  return null;
}

function tokenizeDisplayedCommand(value) {
  var source = String(value || '').trim();
  if (!source) return [];

  var tokens = [];
  var token = '';
  var quote = '';
  var hasToken = false;
  for (var i = 0; i < source.length; i++) {
    var char = source[i];
    if (quote) {
      if (char === quote) {
        quote = '';
        hasToken = true;
      } else if (quote === '"' && char === '\\' && i + 1 < source.length) {
        var quotedNext = source[i + 1];
        if (quotedNext === '"' || quotedNext === '\\'
          || quotedNext === '$' || quotedNext === '`' || quotedNext === '\n') {
          token += quotedNext;
          hasToken = true;
          i++;
        } else {
          token += char;
          hasToken = true;
        }
      } else {
        token += char;
        hasToken = true;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
    } else if (char === '\\' && i + 1 < source.length) {
      var unquotedNext = source[i + 1];
      if (/\s/.test(unquotedNext) || unquotedNext === '"'
        || unquotedNext === "'" || unquotedNext === '\\') {
        token += unquotedNext;
        hasToken = true;
        i++;
      } else {
        token += char;
        hasToken = true;
      }
    } else if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(token);
        token = '';
        hasToken = false;
      }
    } else {
      token += char;
      hasToken = true;
    }
  }

  if (quote) return null;
  if (hasToken) tokens.push(token);
  return tokens;
}

function commandMatchesExecpolicyAmendment(commandText, amendment) {
  if (!commandText || !Array.isArray(amendment) || !amendment.length) return false;

  var amendmentText = amendment.join(' ').trim();
  if (commandText.trim() === amendmentText) return true;

  var commandTokens = tokenizeDisplayedCommand(commandText);
  if (!commandTokens || commandTokens.length !== amendment.length) return false;

  return amendment.every(function (part, index) {
    var ruleToken = String(part);
    var displayToken = commandTokens[index];
    return displayToken === ruleToken
      || displayToken === ruleToken.replace(/\\/g, '\\\\');
  });
}

function buildDecisionOptions(approval, approvalType, input) {
  return (approval.availableDecisions || []).map(function (decision, index) {
    return decisionOption(decision, index, approval, approvalType, input);
  }).filter(Boolean);
}

function permissionPath(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.path === 'string') return value.path;
  if (value && typeof value.special === 'string') return value.special;
  try { return JSON.stringify(value); } catch (e) { return String(value || ''); }
}

function describePermissions(input) {
  var requested = input.codexPermissions && input.codexPermissions.permissions || {};
  var lines = [];
  if (requested.network && requested.network.enabled) lines.push('Network access');
  var fs = requested.fileSystem || {};
  (fs.read || []).forEach(function (path) { lines.push('Read: ' + permissionPath(path)); });
  (fs.write || []).forEach(function (path) { lines.push('Write: ' + permissionPath(path)); });
  (fs.entries || []).forEach(function (entry) {
    var access = entry && entry.access || 'Access';
    lines.push(access.charAt(0).toUpperCase() + access.slice(1) + ': ' + permissionPath(entry && entry.path));
  });
  if (input.reason) lines.unshift(input.reason);
  if (input.cwd) lines.push('Working directory: ' + input.cwd);
  return lines.join('\n') || 'Additional permissions requested.';
}

function buildPermissionsPrompt(input) {
  return {
    title: 'Grant additional permissions?',
    description: describePermissions(input),
    options: [
      {
        label: 'Yes, grant these permissions for this turn',
        act: 'permissions:grantForTurn',
        key: '1',
      },
      {
        label: 'Yes, grant for this turn with strict auto review',
        act: 'permissions:grantForTurnWithStrictAutoReview',
        key: '2',
      },
      {
        label: 'Yes, grant these permissions for this session',
        act: 'permissions:grantForSession',
        key: '3',
      },
      {
        label: 'No, continue without permissions',
        act: 'permissions:deny',
        key: '4',
        tone: 'deny',
      },
    ],
  };
}
