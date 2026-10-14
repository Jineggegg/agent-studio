# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- The conversation list beside the chat (tablet and wide) can be made wider or
  narrower by dragging its edge — with a mouse, a pen or a finger — or with ←
  and → on the focused handle; a double click returns it to the default. It
  stays between 240 and 480 px and never takes the chat below 380 px; the
  width is remembered on the device. On a phone the list is a sheet and has
  no handle.

## [2.0.0-beta.2] — 2026-10-14

### Added
- A one-line installer for Linux, WSL and macOS
  (`curl -fsSL https://raw.githubusercontent.com/Jineggegg/agent-studio/main/packaging/install.sh | bash`):
  a private Node.js, SHA-256 checks of everything downloaded, an
  `agent-studio` command, a background service for the user (systemd or
  launchd), and — if you agree — bubblewrap and the AppArmor profile it needs
  on recent Ubuntu. No root otherwise.
- Release packages: every published release gets an installable archive built
  from the released commit, tested by installing it, with GitHub build
  provenance. CI installs the package on Ubuntu (x64 and ARM64), Debian,
  Fedora and macOS.

### Fixed
- The file tools of API models open files through checked descriptors, so a
  command racing a tool cannot redirect it outside the project (found by
  CodeQL).
- Attachments uploaded together are listed in upload order; stopping the
  server no longer waits minutes for a stalled upload.
- A terminal whose program ended in the moment between a browser connecting
  and attaching (a remote host refusing the connection at once, say) closed
  that connection without showing why; the attach now still gets the output
  and the exit reason.

## [2.0.0-beta.1] — 2026-10-14

First public version: a complete, independently written implementation. It is
a beta — see [docs/STATUS.md](docs/STATUS.md) for exactly what is finished,
what was verified and how, and what is not built.

### Agents
- Claude Code through its official CLI (stream-json), and Codex through its
  CLI's app-server protocol, each using the user's own sign-in; any
  OpenAI-compatible API (DeepSeek, OpenAI, a self-hosted model server) as a
  full agent with sandboxed project tools.
- Server-owned runs with durable delivery, live streaming, replay after a
  reconnect, queueing, steering, stop, and recovery after a restart.
- One permission engine for every agent: modes, rules, a risk classifier,
  durable approvals answerable from any device, plan approval that continues
  in a chosen mode, unattended runs that deny instead of waiting.
- Handoff between agents with a server-built brief, multi-agent tasks with
  optional Git worktrees and a synthesis, a view of running work, usage
  reports, plan windows from what the CLIs report, and budgets.

### Projects
- Files and an editor with conflict detection, Git (status, diff, commit,
  branches, sync, history, worktrees), GitHub through the host's `gh` sign-in
  (pull requests, checks, guarded merge), a persistent terminal for the owner,
  and terminals on operator-configured SSH hosts.

### Memory, automation, notifications
- Shared Markdown memory with full-text search (Chinese included) and scope
  isolation for every agent; editable in the app.
- Schedules and deferred messages with exactly-once execution; a task inbox;
  Web Push implemented from the RFCs.

### Platform
- A touch-first PWA for phone, tablet and desktop: light and dark, English and
  Simplified Chinese, a customisable launcher, onboarding.
- Accounts with an owner and members, passkeys, API tokens with scopes,
  lockout, audit log, operator recovery commands.
- A plugin system: sandboxed plugin processes with granted capabilities and
  isolated panels.
- Security kernel: route access declared or the server will not start,
  same-origin and anti-forgery checks, Host allow-list, strict CSP, path
  confinement, guarded outbound HTTP, encrypted secrets, allow-listed child
  environments, bubblewrap sandbox profiles.

### Quality
- Unit, integration, black-box acceptance (traced to the requirement
  documents) and browser test suites; CI on GitHub-hosted runners only.
- An AI-assisted security review (no critical, high or medium findings), a
  licence check of every dependency, a secret scan of the whole history, and a
  mechanical similarity audit against the predecessor code base.
