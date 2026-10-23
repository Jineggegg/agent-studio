# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [2.0.0-beta.5] — 2026-10-23

### Added

- A bilingual visual product tour with real application screenshots, synthetic
  example content and a phone, tablet and desktop composition. The capture
  scripts create an isolated demo installation without personal accounts.
- An owner-only **Settings → Domain & access** guide with validated domain
  input, copyable Caddy or Cloudflare Tunnel configuration, and instructions for
  DNS, HTTPS, the server's accepted origins and checking the resulting address.
  DNS and service changes remain explicit operator steps.

### Documentation

- Illustrated entry points for multiple models, shared memory, handoff notes,
  multi-agent work, mail, tools and project workflows.
- Corrected older collaboration instructions to include the existing handoff
  and multi-agent task screens.

### Security

- An API token can no longer choose Accept edits or Auto when it creates a
  conversation, sends or schedules a message, creates or changes an
  automation, starts a multi-agent task or hands off; before, only changing a
  conversation's mode was checked. Plan and Ask stay open to tokens.
- Mailbox accounts, messages, attachments and drafts are reachable only from a
  signed-in browser; an API token with read scope could read every connected
  mailbox.
- Requests to configured endpoints no longer reuse pooled connections, so a
  connection opened under a policy that allows private addresses cannot carry
  a later request whose policy does not.
- The installer refuses redirects to plain http, and Codex refuses extra
  environment variables with the `CLOUD_HARNESS_` prefix as it already did
  with `AGENT_STUDIO_`.

## [2.0.0-beta.4] — 2026-10-23

### Added

- Cloud Harness branding, bilingual introduction and a desktop connection wrapper.
- Conversation groups, branches, edit-and-resend, isolated CLI account profiles,
  external transcript imports and file checkpoint preview/restore.
- Image annotation, voice dictation, read-aloud and background task activity.
- Native Anthropic Messages API, user-scoped MCP connections, skills and slash commands.
- Gmail/Outlook mail, encrypted drafts with explicit send confirmation, local-only
  optional summaries, SMTP/Bark notifications and approved reminder proposals.
- Sandboxed static project apps, an optional isolated Chromium browser and a Windows
  companion with browser approval and local confirmation.
- Opt-in monthly usage gates based on reported usage; unknown prices and concurrent
  or in-flight work remain outside an exact spending cap.

### Security

- New integrations start empty. Credentials, personal financial values, deployment
  settings, saved accounts and private history are not part of the distribution.
- Precommit review hardens checkpoint credential exclusions, deleted-account cleanup,
  cancellation of pending MCP calls and immutable app-build confirmations.
- Browser subprocesses use a minimal environment and isolated network namespace.
- Passkey challenges can only be consumed once after successful verification;
  concurrent reuse and challenges that expire during verification are rejected.
- Historical personal API cost observations were removed from the current guide;
  existing public Git history was not rewritten.


## [2.0.0-beta.3] — 2026-10-15

### Added
- The conversation list beside the chat (tablet and wide) can be made wider or
  narrower by dragging its edge — with a mouse, a pen or a finger — or with ←
  and → on the focused handle; a double click returns it to the default. It
  stays between 240 and 480 px and never takes the chat below 380 px; the
  width is remembered on the device. On a phone the list is a sheet and has
  no handle.
- Before an upgrade changes the database's schema, the database is copied to
  `<data>/backups` (readable by you only; the last three are kept).
- The web client's third-party licence notices are shipped with it
  (`/third-party-licenses.md`).

### Security
- An agent changing git's own configuration (`.git/`, `.gitattributes`,
  `.gitmodules`, or a `git config` setting that names a program) now needs the
  owner's approval in every mode but auto; and the Git panel's commits,
  switches, pulls and pushes run in the agents' sandbox, so hooks and filters
  an agent planted cannot reach the Studio's data directory.
- The installer's settings folder (which may hold the master key) and the TLS
  private key are hidden from agent processes.
- An API token can no longer create allow rules, loosen a session's permission
  mode, switch auto mode or hand agents the owner's credentials; it can still
  tighten. These now need a signed-in browser.
- Server logs redact secrets in error stacks, causes and messages whatever the
  call site does, and the redaction covers more formats (Google and GitLab
  keys, passwords in URLs, credential query parameters). Provider, agent and
  plugin error text is redacted before it is shortened.
- Plugin ids that would replace the plugin host's own files are refused, and
  a plugin update whose files changed waits for the owner's approval, as ADR
  0008 says.
- The installer stops when the GitHub CLI cannot verify where the package was
  built (`--skip-provenance` to override), accepts only x.y.z versions, keeps
  the settings file at 0600 and runs nothing if its download is cut short.
- The server refuses to start on a database a newer version has already
  upgraded, instead of running on a schema it does not know.
- Secret scanning ignores made-up credentials in tests only when the value is
  itself recognisably made up; a CI check proves real-looking keys in test
  files are still reported.

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
