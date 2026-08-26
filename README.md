# <sub><picture><source media="(prefers-color-scheme: dark)" srcset="web/public/assets/baton-logo.svg"><img src="web/public/assets/baton-logo-dark.svg" width="36" height="36" alt=""></picture></sub>Baton

Pick up your [Claude Code](https://github.com/anthropics/claude-code) and [Codex](https://openai.com/codex) tasks on your phone, right where you left off on your computer.

<p align="center">
  <img src="docs/assets/promo.avif" alt="Baton" width="100%">
</p>

Baton provides non-intrusive, real-time streaming and rendering for Claude Code and Codex sessions across your devices. Your session data stays in your own AWS account.

### Why Baton?

Named after both a relay baton and a conductor's baton, Baton lets you pick up work on another device and direct your agents remotely.

## Quick Start

### 1. Deploy Server

Requires [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) with permissions to create CloudFormation stacks.

```bash
curl -fsSL https://raw.githubusercontent.com/zhu-xiaowei/baton/main/server/install.sh | bash
```

Takes ~6-8 minutes. Prints a **Start URL** and QR code on success. Supports `--region`, `--stack`, `--profile` options (pass after `bash -s --`).


### 2. Install Bridge

Requires [Node.js](https://nodejs.org/) 20.9+.

1. Open the **Start URL** in your browser (this is also the web viewer)
2. Copy the one-line **Install bridge** command from the Setup page
3. Run it on the machine where Claude Code or Codex is running

On native Windows, run the install command in PowerShell using **Run as administrator**.

### 3. Download App

| iOS | Android | macOS | Windows |
|:---:|:---:|:---:|:---:|
| <img src="docs/assets/baton_ios.png" width="120"> | <img src="docs/assets/baton_android.png" width="120"> | <img src="docs/assets/macOS.png" width="120"> | <img src="docs/assets/windows.png" width="120"> |
| [TestFlight](https://testflight.apple.com/join/UekStGCA) | [Baton.apk](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.apk) | [Baton.dmg](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.dmg) | [Baton.exe](https://github.com/zhu-xiaowei/baton/releases/download/v1.0.0/Baton.exe) |

After downloading the app, scan the QR code or input the Start URL to get started.

---

## Features

- **Real-time streaming and rendering** — follow responses, tool activity, diffs, Mermaid diagrams, and LaTeX as they arrive
- **Non-intrusive workflow** — keep using Claude Code and Codex normally while a lightweight local Bridge observes and relays sessions
- **Claude Code and Codex** — browse and control both runtimes through one Device → Project → Session catalog
- **Multi-device session control** — track running, needs input, and done states, then continue work from any connected device
- **Remote interaction** — send follow-ups, interrupt running turns, answer questions, and approve or deny tool calls
- **Multi-agent session aggregation** — keep one main session in the catalog while viewing and switching between its nested Claude Code or Codex subagents
- **Live agent status** — follow running, needs input, and completed subagents through a real-time status indicator and hierarchical thread list
- **Sessions and agents** — create Claude Code, Codex, or Claude background-agent sessions and monitor them after detaching
- **Runtime-aware commands** — `/` autocomplete for Claude Code and Codex, including Codex Skills and saved prompts
- **Image and voice input** — send compressed images and dictate messages from the iOS app
- **QR sign-in** — scan a Start URL directly from the native app
- **Claude usage insights** — view status, settings, rate limits, token history, and model usage charts
- **Execution timeline** — inspect collapsible tool calls and results with runtime-specific states
- **Project and artifact viewer** — browse source with line highlighting and preview HTML, Markdown, images, files, and videos

---

## Multi-agent Sessions

Baton groups a multi-agent task under its main session instead of listing every worker separately. Open a session's runtime icon to inspect its **Subagents**:

- nested agents form a parent-child tree, including multi-level delegation when the runtime exposes parent metadata
- each thread shows its task, identity, size, last activity, and running / needs input / done state
- the status dot is green while any subagent runs, yellow when one needs input, gray once all finish
- updates arrive over a root-session WebSocket subscription, so the list and status refresh without reloading

Claude Code and Codex share this UI. Nesting depth depends on the runtime; Codex, for example, controls recursive delegation with `agents.max_depth`.

---

## Architecture

```
┌────────────────┐               ┌────────────────┐               ┌──────────────────┐
│     Bridge     │ ◀────WS─────▶ │     Server     │ ◀────WS─────▶ │     App/Web      │
│ (local hosts)  │               │  (AWS Lambda)  │               │  (phone/desktop) │
└────────────────┘               └───────┬────────┘               └──────────────────┘
                                         │
                                         ▼
                                 ┌────────────────┐
                                 │ DynamoDB + S3  │
                                 │ (data + media) │
                                 └────────────────┘
```

**Bridge** discovers Claude Code and Codex sessions, normalizes their events, preserves main/subagent relationships, and handles local agent control. **Server** relays real-time messages, stores session and root-thread data in DynamoDB, and serves synced media through S3. **App/Web** loads cached history, subscribes to session and root-agent updates, aggregates nested threads under the main session, and routes user actions back to the correct local runtime.

---

## Uninstall

See the [uninstall guide](scripts/uninstall/README.md).

---

## License

MIT
