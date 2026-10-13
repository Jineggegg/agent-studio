# Requirements

These four documents are what this implementation was written from. They were
produced by a product-analysis group that studied the behaviour of a private
predecessor system and wrote down **what** it does for a user, an operator and
an attacker — never how it was built. No source code, identifier or internal
structure of that system appears in them. See `docs/clean-room/PROCESS.md` for
the process and its limits.

| Document | Covers | Acceptance tests |
|---|---|---|
| [01 — Agent workbench](01-agent-workbench.md) | Chat, agents and models, sessions, runs, approvals, multi-model work, usage | 163 |
| [02 — Projects and developer tools](02-projects-and-dev-tools.md) | Projects, files, Git, GitHub, terminal, preview, plugins, tool servers | 210 |
| [03 — Sign-in, security, remote access](03-auth-security-remote-access.md) | Accounts, sessions, passkeys, perimeter, secrets, deployment, remote machines, settings | 152 |
| [04 — Memory, automation, mobile](04-memory-automation-mobile.md) | Shared memory, automations, inbox and notifications, launcher, mobile and PWA behaviour | 183 |

Read them as a description of a product, not as a specification of this one.
Numbers in them (limits, timings) are recommended defaults. Owner-specific
private integrations were removed from the published copies, and so was every
statement about how the predecessor behaves where security is concerned: such
passages were restated as requirements for this product before publication.

## Product decisions made here

The architecture, data model, wire protocol and visual design were made for
this project. A few product decisions are worth knowing when reading the
documents, because the scenarios there sometimes assume otherwise:

- **First run** needs a one-time setup token that the server prints and keeps
  in an owner-only file, so a headless server can be set up over SSH.
- **Sessions** are server-side, in an `HttpOnly`, `SameSite=Strict` cookie with
  an anti-forgery header; lifetimes are configurable.
- **People**: an owner and optional members with explicitly shared projects
  (`SECURITY.md` explains what a member's limits do and do not cover).
- **Passwords** need twelve characters; sign-in throttling is per account and
  per client address.
- **Approvals** are durable records with a default expiry of thirty minutes,
  announced by notification and answerable in the conversation from any of
  the user's devices — a phone in a pocket needs longer than a desktop tab.
- **API models are agents**: inside a project they can read, edit and run
  through the same permission engine, with their commands sandboxed.
- **Recurring agent runs** exist; what such an unattended run would have to
  ask about is denied and reported. A message scheduled for later behaves like
  a typed one.
- **Memory notes** can be created and edited in the app, with a version check.
- **Notifications** are in-app and Web Push for the first release; by default a
  push names the conversation and what happened, nothing more.

**Not built in this release** — see `docs/STATUS.md` for the current list;
notably AI-built apps with a per-app gateway, the agent-driven browser,
tool-server (MCP) and skills management screens, the external task-planning
integration, voice input and read-aloud, and discovery of sessions started
outside the product.
