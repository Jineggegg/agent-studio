# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

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
