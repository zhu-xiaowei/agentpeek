# Baton — Project Context

## Workflow Rules

- **Plan before code**: All code changes must be preceded by a detailed proposal (which files, what changes, why). Only modify code after explicit user confirmation.
- **Concise comments**: Keep code comments minimal — only what's necessary to understand non-obvious logic. Detailed design/architecture notes belong in CLAUDE.md, not inline.

## What is this

Baton is a cross-platform app + bridge + server that lets you view local agent sessions from
your phone or desktop. Claude Code supports viewing and interaction; Codex supports history,
real-time monitoring, and interaction with existing Sessions. Three components:

1. **bridge/** — Node.js script running on macOS/Linux/Windows (always-on, auto-start), normalizes Claude Code and Codex JSONL
2. **server/** — AWS Lambda (FastAPI) + DynamoDB + WebSocket API GW, relays between bridge and app
3. **web/ + src-tauri/** — Static HTML/CSS/JS frontend, packaged as native app via Tauri v2 (Android/iOS/Desktop)

Brand name "Baton" is only in user-facing places. Internal code uses generic names so renaming is easy.

## Core Design Principle

**DynamoDB is the durable browsing cache; WebSocket is the real-time path:**
- DDB: device/project/session metadata plus normalized message history
- WS: real-time messages, streaming previews, permissions, and control actions
- App localStorage: local auth/nav state cache

## Current Status

### Phase 1: COMPLETE ✅
- bridge.mjs syncs session metadata to DDB via HTTP POST
- bridge.mjs watches .jsonl files, detects new messages in real-time
- Deployed to ap-northeast-1 (Baton), verified 300+ sessions

### Codex Phase 1 + Phase 2: COMPLETE
- Runtime adapters discover Claude Code and Codex into one Device → Project → Session catalog.
- Codex metadata and recent/running history sync on Bridge startup; older empty DDB partitions
  use REST `needSync` → WS `sync_session` → adapter → DDB → `sync_complete`.
- Codex uses `codex:<nativeSessionId>` storage IDs and the existing Claude-compatible project hash.
- Runtime icons and normalized message/tool rendering are complete.
- Codex watcher monitors every configured `CODEX_HOME/sessions` root and pushes append-only
  updates through the same WS ack, HTTP fallback, frame-limit, and watermark semantics as Claude.
- Codex rollout-only status updates support `running`/`completed`; interaction resume recovers
  daemon-owned approval waits even though the startup catalog cannot infer them from JSONL alone.
- Codex Phase 3 interaction prefers the managed app-server Unix WebSocket when present and falls
  back to `codex app-server --stdio`: existing Sessions use `thread/resume` + `turn/start`; new
  Sessions use `thread/start` + `turn/start`. A resumed active turn is adopted so pending approvals
  and later deltas keep streaming; a new user turn waits in the same per-session queue.
- Codex and Claude share `StreamFramer`: first delta is immediate, later deltas use the same 50ms
  batch window, while `LiveTurnStream` assigns the turn-level `seq`. The frontend uses
  `TurnEventQueue → StreamCoordinator → StreamingDomRenderer` for ordered consumption,
  authority reconciliation, and progressive reveal.
- Codex user/assistant live rows are broadcast immediately; the rollout watcher persists matching
  rows without rebroadcast and remains the fallback when no live row was observed.
- Codex command/file/permissions/MCP approval variants are implemented. Automatic pending-request
  recovery immediately after a Bridge restart, before any send resumes the thread, remains Phase 3 work.
- Detailed status and validation: `docs/codex.md`.

### Phase 2A: COMPLETE ✅ — Backend + API Verification
- Server REST read endpoints (devices, projects, sessions, messages)
- WebSocket API Gateway + relay (subscribe, broadcast, heartbeat)
- Bridge WS connection + real-time push
- Web viewer (web/) with dark theme, diff2html, markdown, file badges, Agent stats

### Phase 2B: COMPLETE ✅ — Send Messages + Images + Device Routing
> ⚠️ Originally built on tmux send-keys; **superseded by Phase 2E (headless)** — tmux is deleted. The image/device pieces below still stand.
- Message sending (was tmux send-keys → now headless stream-json pool, see Phase 2E)
- Permission prompt detection + approval UI
- Image upload via S3 + `baton-bridge:` protocol
- Auto-create regular sessions through headless `--session-id`
- Device routing for multi-bridge setups

### Phase 2C: COMPLETE ✅ — Native App (Tauri v2)
- Tauri v2 wraps web/ as native app, zero web code changes
- Android, iOS (TestFlight), macOS builds

### Phase 2D: COMPLETE ✅ — Claude Agents Support
- Bridge discovers agent identity through `claude agents --json --all`; roster.json determines active daemon ownership, while jobs/state.json only supplies the current blocked question
- Agent sessions display [Agent] badge + Working/Needs input/Completed status
- Send messages to agent sessions: was `claude agents` TUI navigation over tmux; **now headless** `claude -p --resume <agentSessionId>` handles agent sessions like any other (works via `_pool.send`)
- Create new agent sessions from the New Session view through detached `claude --bg`
- Bridge respects permissions.defaultMode: bypassPermissions (no false permission prompts)

### Phase 2E: COMPLETE ✅ — tmux removed, headless is the only send path
**tmux is fully deleted.** The entire send/permission/launch stack now goes through
the headless stream-json process pool (`bridge/headless.mjs` `ClaudePool`). Do not
reintroduce tmux; extend the pool for future Claude interaction work.

Done:
- **`bridge/tmux.mjs` deleted entirely** (send-keys, capture-pane, launch, TUI nav, wizard detection, `hasTmux`, stale-session cleanup).
- `projectHashToPath` moved into `session.mjs` (pure path util, not tmux). `getClaudeProcesses` was tmux-only and dropped — `getRunningInfo` in `session.mjs` has its own `ps aux` parser.
- Server bridge-install script (`/api/install`) no longer auto-installs tmux.
- Existing-session send → headless streaming (`handleHeadlessSend` → `_pool.send`), the primary happy path. Works today.
- **Stream ordering** — `stream-framer.mjs` only batches UTF-8-safe incremental chunks and block
  boundaries. `LiveTurnStream` is the single shared-event outlet and assigns one contiguous,
  turn-local `seq` across user authority, blocks, deltas, tool input, permission events, authority
  messages, and terminal `stream_end`. `TurnEventQueue` consumes only contiguous `turnId + seq`;
  `StreamCoordinator` owns turn/block state and authority reconciliation; `StreamingDomRenderer`
  applies operations without rebuilding correct DOM. Late join resumes at `seq=1 messages(user)`,
  the next complete block/permission checkpoint, or terminal authority. See
  `docs/streaming-render-design.md`.
- **Reply placement by turn identity** — Web generates `turnId` before send and stores it directly
  on the optimistic user bubble as `data-anchor`. Bridge and Server preserve the same `turnId` on
  every shared event and `send_message_result`; the renderer locates the exact anchor without
  `clientId/streamId` binding, text matching, timestamp ownership, or nearest-pending heuristics.
  Authority uses UUID/native ID to confirm or patch nodes inside that same turn.
- **Permission bridge DONE** — `onControlRequest` → app `permission_request {kind:tool|ask|plan}`; `handlePermissionReply {requestId, decision, answerText}` → `_pool.replyControl`. Ordinary tools allow/deny; AskUserQuestion/ExitPlanMode answer via **deny + answerText in `message`** (CC's only answer channel on `--permission-prompt-tool stdio`, verified CC 2.1.211 — a structured `control_response` answer is force-converted to deny); cancel = deny + `interrupt:true`. Answer renders in the tool-card OUT (green), cancel shows warning (yellow). A still-pending control_request is re-pushed on (re)subscribe (`reveal_permission`). Frontend `web/js/components/permission.js` fully rewritten (old `arrow:`/`type:`/`escape` protocol + client-side heuristic detection deleted).
- **New Session / new agent / create project DONE** — regular sessions mint a UUID, acknowledge
  it before spawning headless with `--session-id`, and then stream the first turn. Background
  agents launch through `claude --bg`. Creating a project seeds an empty PROJ row and enters the
  new-Session input view.
- **Stall Rescue + `stall.mjs` fully deleted**; `command_output` (tmux capture) path deleted (bridge/server/frontend); `streamMode` flag deleted; `permissions.mjs` + `needsPermission` + per-directory permission reads deleted.

### Phase 3: LATER — Production polish
- Harden the existing persisted `~/.baton-bridge/synced.json` recovery path

## Deployed Environment

**API URL and API key live in `.env.local` (gitignored). When you need them,
read that file** — do not hardcode them in committed code. Variables:
`BATON_API_URL`, `BATON_API_KEY`. See `.env.local.example` for the
template. S3 bucket / ECR repo / AWS account id are derived automatically by
`server/install.sh` from the stack name + `aws sts get-caller-identity`.

- **Region**: ap-northeast-1
- **Stack**: Baton
- **DDB Tables**: `Baton-bridge-sessions`, `Baton-bridge-messages`
- **Deploy**: `cd server && ./install.sh --region ap-northeast-1 --stack Baton`

## Key Technical Decisions

### Bridge
- Watches `~/.claude/projects/<project-hash>/<session-id>.jsonl`
- `readableProjectName()` resolves hash back to real path by walking filesystem
- `preview` uses `ai-title` from .jsonl, falls back to first user message
- Filters: skips empty/no-preview files, subagent sessions
- Session `status`: **three-state** (`running`/`needs_input`/`completed`), one field, no
  parallel `agentState`. Displayed as Running (green) / Needs input (amber) / Done (grey).
  Three sources map into this single enum:
  - **busy pool-owned (headless)**: pool lifecycle events push status via the sync-sessions HTTP
    path — `_pool.send` → `running`; `control_request` → `needs_input`; turn `result` →
    `completed` (or `needs_input` if a control_request is still pending). `ws.mjs` `syncPoolStatus`.
  - **external CC** (terminal/VS Code, not pool-owned): `getSessionStatus()`/`statusFromEntry()`
    read jsonl tail `stop_reason` (`tool_use`/null → running; structured
    `AskUserQuestion`/`ExitPlanMode` → `needs_input`; `end_turn`/interrupt/no-process →
    `completed`) and write the derived state immediately.
  - **daemon agent**: while its worker is present in `roster.json`, `mapAgentState()` maps
    `--json` working/blocked/done → running/needs_input/completed. Inactive historical
    `--all` entries preserve agent identity only; status falls back to process + jsonl.
  - Precedence when a session matches more than one source: **busy pool-owned >
    roster-active daemon agent > external/jsonl**.
    watcher/`checkStopped` skip status writes for busy pool-owned (`poolOwns()`) and daemon-agent sessions.
  - `getRunningInfo()`: `ps aux` + `--resume` arg extraction → exact session ID + project cwd
    (used by external detection). VS Code CC (no `--resume`) → project-level + mtime>5min → completed.
  - Legacy `idle`/`stopped` values in old DDB rows are normalized to `completed`/Done by the
    frontend's `statusLabel`/`statusClass` fallback (no migration script; re-derived on next sync).
- `projectHashToPath()` (in `session.mjs`): reverse hash to real directory path (validates each segment exists)
- Claude Agents support:
  - Agent identity source is **`claude agents --json --all`**. Its working/blocked/done state
    is authoritative only while `roster.json` still contains that worker; stopped or
    headless-taken-over agents remain in `--all` with stale state indefinitely, so they keep
    `isAgent`/name but derive status from process + jsonl. `getAgentsJson()` caches the resolved
    catalog for 3s and returns the last-good cache on CLI failure. Filter to
    `kind === 'background'`; `kind:"interactive"` entries are not agents.
  - `agentDetail` (the blocked question shown on the card) is the ONE field still read from `jobs/<sid[:8]>/state.json`'s `needs` — `--json`'s `waitingFor` is almost always null.
  - `getDaemonRunningSessionIds()`: reads `~/.claude/daemon/roster.json` → active worker sessionIds (still used to detect a done-agent resumed as a normal CC session).
  - Agent status poll (`watcher.pollAgentStates`, every `AGENTS_POLL_INTERVAL_MS`): diffs `getAgentsJson()` vs `_jobsState`, pushes changed agents. Empty `_jobsState` on startup → first poll full-pushes every agent (heals DDB + covers every version-update restart). Replaced the old `fs.watch(state.json)` (missed transitions since state.json lags).
  - Status paths that key off live CC processes (`checkStopped`) skip roster-active daemon
    agents and busy pool-owned sessions. Precedence: busy pool-owned > roster-active daemon >
    external/jsonl.
  - Worktree project-hash normalization: a session that `cd`s into `<proj>/.claude/worktrees/<name>` has its jsonl moved to a new project dir, producing a 2nd DDB row for one sessionId. `normalizeProjectHash()` strips `--claude-worktrees-*` at every POST site (keeps real hash for on-disk reads) → one session, one row, under the parent project. See `docs/claude-code-bridge.md`.
  - Send to agent / new agent / reveal pending input: existing agents resume through headless `claude -p --resume <agentSessionId>`; new agents launch through `claude --bg`; pending `control_request` state is re-pushed on `reveal_permission`.
  - Permissions are enforced by CC itself (bypass mode → no prompt); the bridge no longer reads settings — see the Permission Detection section.
- Slash commands are runtime-aware. Claude's primary catalog comes from the current CLI's
  no-persistence `initialize` control response, including environment-filtered commands, descriptions,
  argument hints and model choices. `commands.mjs` only scans custom commands and Skills as an
  old-version fallback; there is no static Claude built-in list. `/usage`, `/cost`, `/stats`, `/status`,
  and bare `/config` open the local four-tab Settings panel. Codex uses `codex-commands.mjs`: the mobile
  catalog starts from the complete 44-command popup observed in Codex 0.147, then preserves that
  presentation order while filtering only commands without a complete phone equivalent. The
  current macOS Bridge exposes 33 built-ins; Linux exposes 32 because `/app` is host-platform
  specific. IDE/TUI presentation commands, `/approve`, `/side`, and `/plugins` are filtered.
  `$CODEX_HOME/prompts/*.md` legacy prompts are appended in name order.
  Codex Skills come from app-server `skills/list`; selecting one composes `$name`, and
  `turn/start.input` carries the matching structured Skill item. The app preserves Bridge order
  and caches by device + runtime + project. Details: `docs/api.md` + `docs/codex.md`.
- Config: `~/.baton-bridge/config.json`, auto-created from CLI args
- Always-on: launchd (macOS), systemd user service + `loginctl enable-linger` (Linux), Task Scheduler (Windows)
- Deployed bridge runs from `~/.baton-bridge/` (copied), NOT the workspace `bridge/`. Local dev: `cp bridge/*.mjs ~/.baton-bridge/` + restart service.
- Auto-update: every 5min `checkUpdate()` compares local `version.mjs` vs server `/api/version`; on change, resolves the immutable S3 package through `/api/install`, stages and validates it, then restarts. `install.sh` uploads the versioned Bridge package before exposing that version through CloudFormation, so an interrupted deploy cannot advertise a mismatched package. Bridge WS connections report `bridgeVersion` for fleet verification.
- `/api/version` reads `APP_VERSION` env (= semantic + git hash, set per build). Managed by CFN (`AppVersion` param in template, passed by install.sh). Lambda env overrides image ENV, so the CFN param MUST stay wired or the version freezes and auto-update silently stops.
- Initial sync: merge all runtime catalogs, upload full Session metadata, then sync active + recent 24h messages with concurrency 2. `await syncSessions()` then `await reconcile()` (recount aggregates at that definite completion point).
- Periodic check (5min): `checkStopped()` — detects disappeared CC processes via `ps aux` → `completed` (skips roster-active daemon agents + busy pool-owned sessions)
- Watcher: fs.watch detects jsonl changes → sync metadata only on status change, new session, or ai-title
- Status cache: `lastKnownStatus` Map prevents redundant sync POSTs (only sends on change)
- Debounce: busy Map per session dedup fs.watch duplicate events
- Line-number tracking per session (not UUID set), lightweight
- Images: sharp compress 1280px JPEG (quality=90) → upload S3 via Lambda → store key in message
- Batching: by byte size (≤4MB/POST), with 200ms delay between batches
- WS ack: `wsSendWithAck` waits for server `messages_ack` reply (5s timeout), falls back to HTTP POST to DDB if no ack

### Server
- FastAPI in Docker Lambda, API Key auth
- DDB `accountId` = SHA256(apiKey)[:16] — raw key never stored
- `install.sh`: ECR → S3 → CodeBuild (arm64) → CloudFormation
- Bridge install script (`/api/install`): exports `XDG_RUNTIME_DIR` for Ubuntu SSH compatibility (tmux auto-install removed in Phase 2E)

### Message Flow (WS single path + DDB cache)
- Claude watcher normally pushes new messages through WS; startup, fallback, oversized authoritative copies, and on-demand history use HTTP
- Lambda broadcasts ordinary watcher messages and writes their final fields to DDB. Runtime-owned
  `messages{noCache:true}` are broadcast only; the later JSONL watcher copy owns persistence.
- Bridge extracts: uuid, parentUuid, type, content, timestamp, toolUseResult (drops model/usage/cwd/version, ~40-60% smaller)
- Content blocks preserved: text, image (compressed), document, thinking, tool_use, tool_result
- App opens session → REST from DDB (instant, <100ms) + WS subscribe for real-time
- WS subscribe + buffer during REST load → merge/dedup → resolve running state from newer applied
  WS lifecycle or `/messages.status` → render → subsequent WS direct append
- Server broadcasts to ALL app connections subscribed to a sessionId (multi-device)
- See `docs/claude-code-bridge.md` for full protocol and flow diagrams

## DynamoDB Schema

**Single-table design** — `BridgeSessions` holds three entity types keyed by SK prefix:

```
BridgeSessions   PK: accountId (SHA256(apiKey)[:16])
  SK: DEV#<device>                          entityType=device   — one row per device
      → sessionCount, projectCount, os, lastActive, runtimeCapabilities
  SK: PROJ#<device>#<projectHash>           entityType=project  — one row per project
      → sessionCount, projectName, lastActive         (aggregates)
  SK: SESS#<device>#<projectHash>#<sid>     entityType=session  — the real session row
      → status (running/needs_input/completed), preview, model, size, lastActive,
        runtime, nativeSessionId, modelProvider, clientSource, cliVersion,
        isAgent, agentName, agentDetail
  GSI accountId-activeStatus-index (sparse, ProjectionType ALL):
      activeStatus = "running" | "needs_input"      (active sessions)
                   | "done#<lastActive>"            (every completed session)
      → homepage Active Sessions = between("needs_input","running"); c<n<r so
        completed/done# are excluded. Completed Sessions = begins_with("done#") desc limit 20.

BridgeMessages   PK: sessionId    SK: timestamp#uuid
  Attributes: uuid, type, content (JSON), timestamp, optional stopReason/toolUseResult
  TTL: 90 days
```

**Count consistency (aggregates drift; DDB-self-consistent, not disk-truth):**
- Bridge calls reconcile right after `await syncSessions()` (a definite completion point — all
  SESS# writes are awaited-done; no timer guessing) and again when a brand-new project first
  appears in the watcher. NOT periodic.
- The incremental `statusDelta` ADD path still maintains `sessionCount` (+1 on `from:'new'`);
  aggregate status deltas are now unread (reconcile owns those numbers).

## API Summary

### REST
```
POST /api/bridge/sync-sessions              — bridge uploads session metadata
POST /api/bridge/sync-messages              — startup/fallback/on-demand message history
POST /api/bridge/reconcile                  — recount DEV#/PROJ# from SESS# + prune orphan PROJ# (device row == list length)
POST /api/bridge/create-project             — seed an empty project row
POST /api/bridge/delete                     — delete Session/Project metadata and reconcile
GET  /api/bridge/devices                    — device list (projectCount/sessionCount from aggregates; running/needsInput live)
GET  /api/bridge/projects?device=X          — project list
GET  /api/bridge/sessions?device=X&project=Y — session list
GET  /api/bridge/active-sessions            — homepage: active (running+needs_input) + 20 most-recent completed (recentSessions)
GET  /api/bridge/messages?session=X&after=ts&device=D&project=P — messages + current Session status
POST /api/bridge/video-prepare              — video preview: HEAD dedup + presigned PUT URL (bridge streams to S3)
GET  /api/bridge/video-url/{key}            — video preview: presigned GET URL (no-store; browser streams from S3)
GET  /api/install                           — bridge install script (sets up always-on service)
GET  /api/version                           — app and Bridge release versions
```

### WebSocket (real-time)
```
App → Server:           { action: "subscribe", sessionId }
App → Server:           { action: "unsubscribe", sessionId }
App → Server → Bridge:  { action: "send_message", sessionId, text, device }
                        { action: "send_message", projectHash, runtime, text, device }  — new session
App → Server → Bridge:  { action: "permission_reply", sessionId, requestId, decision, answerText?, device }
App → Server → Bridge:  { action: "list_commands", projectHash, runtime, sessionId?, device, requestId }
Bridge → Server → App:  { action: "send_message_result", ok, sessionId? }
Bridge → Server → App:  { action: "commands_list", requestId, runtime, device, projectHash, sessionId?, commands, skills }
Server → App:           { action: "messages", sessionId, messages }
Server → Bridge:        { action: "sync_session", sessionId, runtime, nativeSessionId }
Bridge → Server → App:  { action: "sync_complete", sessionId, status, count }
```

Full protocol: `docs/api.md`

## Send Messages Architecture

Approach: **headless stream-json process pool** (`bridge/headless.mjs` `ClaudePool`). One
persistent `claude -p --input-format stream-json --output-format stream-json` process per
session, fed over a kept-open stdin. Single-writer per session → no jsonl double-write.
Replaced the old tmux send-keys approach (deleted in Phase 2E). Full design: `docs/headless-streaming.md`.

### Message Sending
- Viewer → WS → Server → Bridge → `handleHeadlessSend` → `_pool.send` → CC stdin
- Streaming back: `stream_delta` (typewriter preview) + `stream_end`; full assistant/user
  lines arrive as authoritative `messages` (uuid-deduped against the jsonl copy)
- Optimistic rendering + dedup + timestamp update

### Reliable WS Delivery (app side, `web/js/ws.js`)
- **Sends must survive a dead socket.** User actions (`send_message`/`interrupt`/`create_project`) use `wsSendReliable`, not bare `wsSend` (which drops frames when not OPEN): queues to `_wsSendQueue` (array, ordered) + reconnects, flushed on `onopen` after re-subscribe. iOS suspends the socket in background into a zombie (reads OPEN, frames vanish, no `close`) — `handleForegroundResume` (`visibilitychange`/`pageshow`/`focus`) forces reconnect + `recoverMissing()` when a real session is active. This kills the "agent 2nd message fails / Retry dead until re-enter" bug.
- **Bridge turn frames must survive reconnect too.** `LiveTurnStream` sends through
  `wsSendWhenConnected`, which queues frames while the Bridge socket is not OPEN and flushes them
  in order after reconnect. A frame may not consume a turn `seq` and then disappear.
- **No duplicate/stuck bubbles.** Each optimistic bubble carries a monotonic send `seq`. `reconcileEchoedPending()` (end of `updateLastTurn`) retires a pending when (1) its echo is present (covers echoes that arrived via `bufferAndFetch`, which `tryDedup` skips), or (2) `seq < lastDeliveredSeq` — a later send was already confirmed, so this earlier one was swallowed by a busy-CC send and never reached jsonl (echo never comes). `lastDeliveredSeq` is a persistent watermark bumped in `tryDedup`/`resolvePending(ok)`/echo-match, so orphan detection survives the confirmed pending being removed; reset with `pendingSentMessages` on every session switch. `isImage` bubbles are never auto-orphaned (attachments, no matchable text). Without this an orphan has no `data-ts` and sticks to the bottom forever. New-session banner: `body.new-session #content` is flex-centered, so `.ws-banner` is pinned `position:absolute; top:0` instead of being pulled to the middle.

### Scroll-to-bottom on session open (no flash / no "差一截")
- **Order matters: clamp BEFORE scroll.** `clampOverflow` collapses long messages (adds `.clamped` → max-height 4.5em), shrinking total height. Initial render clamps before scrolling. Live insertions and earlier-tool OUT replacements scroll once only when `state.stickBottom` preserves follow intent; deliberate upward scrolling is not overridden. Streaming never uses smooth scrolling because continuously arriving frames would compete with the animation.
- **diff2html is committed atomically.** `tool.js` renders and highlights each diff inside a detached staging element, then replaces the visible `.diff-container` children in one synchronous commit. The loading placeholder remains stable while the viewer module loads; users never see the zero-height/partially drawn diff, and no estimated height or resize observer is needed. After the commit and clamp, the view scrolls once only when `state.stickBottom` still records follow intent, so a user who scrolled upward during loading is not pulled back.

### Permission Detection + User Interaction (headless, bridge-driven)
- Bridge `onControlRequest` (CC's `control_request`, precise — no client-side heuristic) → app `permission_request {kind, requestId, questions?/plan?/input}`. App replies `permission_reply {requestId, decision:allow|deny|answer, answerText?}`.
- Ordinary tools (Bash/Edit/Write/MCP): allow → `control_response{allow, updatedInput}`; deny → `{deny, message}`. (`defaultMode:bypassPermissions` → CC never asks, no prompt.)
- AskUserQuestion/ExitPlanMode (`requires_user_interaction`): answer via **`{deny, message: answerText}`** — CC's only answer channel on `--permission-prompt-tool stdio` (a structured `control_response` answer is force-converted to deny, verified CC 2.1.211). Multi-question wizard sends `question → answer` per line. Cancel = `{deny, interrupt:true}` → `[Interrupted]`.
- Answer renders in the tool-card OUT (`toolState` treats it as non-error → green; cancel → yellow), not a separate bubble. A still-pending prompt is re-shown on refresh/reconnect (`reveal_permission` → bridge re-push).
- `web/js/components/permission.js` fully rewritten; old `arrow:`/`type:`/`escape` protocol + `checkPendingPrompts` client detection deleted.

### Image Sending
- S3 upload + `![](baton-bridge:key)` protocol
- Bridge downloads → replaces with absolute path → CC Read tool reads it
- Multi-image staging + gallery + paste support

### File / Video Preview (click a file link in a message)
- Click file link → `openFile()` → WS `request_file` → bridge `handleRequestFile` (`ws.mjs`) reads from disk.
- Text/image: bridge base64s + POSTs to Lambda (`/upload-file` → `files/{key}`, `/upload-image` → `images/{key}`), replies `file_ready {key}`; frontend GETs `/api/bridge/file|image/{key}` (served base64-as-text from S3). Binary text files (NUL byte in first 8KB) → `binary file` error.
- **Video** (`.mp4/.m4v/.mov/.webm/.mkv/.avi`, ≤5GB): base64-through-Lambda is impossible (API GW 6MB limit), so the bridge **streams the file straight to S3** via a presigned PUT. `POST /video-prepare {key}` → server HEADs `videos/{key}`: exists → `{exists:true}` (skip upload, dedup by content-hash key so it survives bridge restarts), else returns presigned PUT URL → bridge `fs.createReadStream` piped to `fetch(PUT, {duplex:'half'})` (flat memory regardless of size). Bridge replies `file_ready {video:true, key}`; frontend calls `GET /api/bridge/video-url/{key}` for a short-lived presigned GET URL and plays it in a `<video>` element streaming directly from S3 (Range/seek supported). No CloudFront/IAM change — Lambda already has S3 Get/Put; presigning uses those creds.

### Session Launch (headless)
- Existing session with no live CC process → `_pool.send` spawns a headless `claude -p --resume <id>`; the persistent process becomes the single writer. No tmux, no wait-for-ready, no trust-dialog handling (headless inherits the folder's trust state).
- Idle reap (10min) + LRU cap (16) manage the pool; a reaped session re-spawns with `--resume` on the next message, context intact. (No more `cleanStaleSessions` / `apeek_*` tmux naming — all deleted in Phase 2E.)
- New regular Session: Bridge mints a UUID, sends `send_message_result` first, then starts
  headless with `--session-id <id>` so the app subscribes before stream frames arrive.
- New Codex Session: Bridge calls `thread/start`, returns the storage Session ID, then starts the
  first turn on the same cwd-scoped app-server client.
- New background agent: Bridge launches `claude --bg`, resolves the full Session ID, and lets
  the agent poll/watcher publish metadata and messages.

### Device Routing
- Bridge WS connection includes `device` parameter
- Server stores `deviceName`, filters send_message/permission_reply forwarding by device
- Viewer sends messages with `device: appState.device`

## Web Deployment

### Web Pages (served from FastAPI Lambda)
- `web/landing.html` — API key input, URL `?key=` auto-login, localStorage (`_ak` btoa obfuscated)
- `web/index.html` — Session viewer (auth guard redirects to landing if no key)
- `web/setup.html` — Bridge install command + QR code + connected devices list
- Top bar: Baton logo + Setup gear icon
- Favicon: inline data:image/svg+xml (all pages unified)

### Auth Flow
- Key stored in localStorage (`_ak` = btoa, `_as` = server URL)
- No cookies, no server middleware — static files publicly accessible
- API calls use `x-api-key` header from localStorage
- API Gateway `ApiKeyRequired: false` — auth handled by FastAPI layer

### Deployment
- Dockerfile: `COPY web/ web/` → FastAPI `StaticFiles` mount
- `install.sh`: copies `web/` to Docker build context, deploys via CodeBuild
- Deploy output: single setup URL with embedded token (12h TTL)

### Three-State Session Status
- `running` → **Running** (green): a turn is generating (jsonl `stop_reason: tool_use`/`null`,
  or pool turn in flight, or agent `working`)
- `needs_input` → **Needs input** (amber, reuses `.badge.idle`): the ball is in the user's court
  (pool `control_request`, agent `blocked`, or terminal `AskUserQuestion`/`ExitPlanMode`).
- `completed` → **Done** (grey, reuses `.badge.stopped`): turn finished / no process / stale.
  Also the fallback for legacy `idle`/`stopped`/unknown values.
- Homepage: Active Sessions = running + needs_input (regular + agent); Completed Sessions =
  20 most-recent completed of any type. Device/Project rows show `N running · N needs input`
  (`needsInputCount`). `completed` is not shown on the device rows.

## Native App (Tauri v2)

Tauri v2 wraps web/ static frontend as native app, zero web code changes.

### Architecture
- `src-tauri/` at project root (sibling to web/, bridge/, server/)
- `frontendDist: "../web"` — directly serves static HTML/CSS/JS
- `withGlobalTauri: true` — JS accesses native API via `window.__TAURI__`
- Bundle identifier: `com.batonai.app`
- Built-in dev server (no http-server needed), hot-reload

### Targets
- Android: primary
- iOS: secondary (TestFlight)
- Desktop (macOS/Win/Linux): bonus, same config

### Commands
```
# Dev
npm run dev:android / dev:ios / tauri:dev

# Release (all four platforms have ready-made scripts in scripts/)
npm run build:android       — release APK (aarch64)
npm run release:ios         — build + bump CFBundleVersion + upload TestFlight
npm run build:mac           — signed + notarized universal macOS DMG
npm run build:windows       — cross-compiled Windows NSIS installer (.exe)
```

All release scripts read secrets from `.env.local` (gitignored). See each script's
header comment for required env vars, one-time setup, and output paths.

### Native Features (planned)
- QR scan login: `tauri-plugin-barcode-scanner`
- Local notifications: `tauri-plugin-notification`
- Biometric auth: `tauri-plugin-biometric`

## Live State (headless native — was "tmux capture-pane Live State")

CC has many intermediate states not written to jsonl (thinking animation/content, permission
waiting, tool progress). The old plan was to scrape them with `tmux capture-pane`. **Headless
delivers them natively** as stream events (`content_block_delta` text/thinking, `control_request`
for permissions, `result` for turn end) — no pane scraping needed. All wired: typewriter text +
thinking preview (`stream_delta`, per-tick thinking timer), permission `control_request` → app
prompt, turn-end (`stream_end`).

## Stall Rescue — REMOVED in Phase 2E (headless makes it unnecessary)

The old problem: a multi-question AskUserQuestion (tab-bar wizard `☐ header1  ☐ header2  ✔ Submit`)
held its entire tool_use in CC's memory and never wrote it to jsonl until Submit, so the bridge
saw nothing and the session looked permanently `running`. The tmux workaround (`stall.mjs`
`checkStalledSessions` + capture-pane wizard detection + Escape to force-flush + hiding the
synthetic rejection pair in `watcher.mjs`) is **deleted**.

Under headless this can't happen: CC pushes the full `questions[]` up front via a `control_request`
(`requires_user_interaction`), wired to the app prompt (permission bridge, DONE). `stall.mjs` and
`watcher.mjs`'s synthetic-pair filter / `stallRescued` tagging are **fully deleted**.

## Known Issues / TODO

- **Real-time Edit diff hydration lifecycle**: fixed the intermittent mobile state where an expanded `Edited` card showed only its border until session reload. Diff data now survives DOM replacement under a stable content key, initialization is tracked per element, visible tool nodes hydrate after every timeline mutation, and the registry is cleared at session boundaries. Keep regression coverage for replacement during lazy import, streaming adoption, fallback rendering, and session cleanup.
- **WS oversized messages**: API Gateway WS single-frame cap is **32768B** (not 128KB — exceeding it drops the whole connection with close code 1009 → reconnect storm + hundreds of stale ConnectionsTable entries). Fixed: `watcher.mjs` checks the WS envelope size; oversized messages send a **truncated copy** over WS (`truncateToBytes()` in `extract.mjs`, byte-aware so CJK/emoji keep a real prefix; carries `truncated: true` + `noCache: true`) for real-time display, and the **full copy** over HTTP to DDB. `bridge_ws.py` skips the DDB cache write when `noCache` is set so the truncated WS copy never clobbers the full HTTP copy. `uploadMessages()` also caps every message to `DDB_ITEM_LIMIT` (360KB) so the 400KB DDB item limit can't be exceeded. Limits: `WS_FRAME_LIMIT`/`DDB_ITEM_LIMIT` in `config.mjs`.
- **VS Code CC status precision**: VS Code extension launches CC without `--resume` flag, cannot precisely match session. Uses mtime heuristic (5 min timeout → completed). terminal-launched CC (with `--resume`) unaffected.
- **Unstructured terminal questions**: external terminal turns that end with plain assistant text do not expose a reliable waiting-for-input signal. Structured `AskUserQuestion` and `ExitPlanMode` are detected as `needs_input`.
- **Concurrent regular-session control**: Claude has no daemon-style stop/lock for a normal terminal or VS Code session. Do not start a Web headless turn while the same regular session is actively generating elsewhere; simultaneous writers can fork the JSONL parent chain. Daemon agents are safe because Web takeover stops the roster worker first.
