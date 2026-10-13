# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-13 (after wave 1 was interrupted and resumed).

## Phases

| Phase | State | Evidence |
|---|---|---|
| 1 Requirements | **Done** | `docs/requirements/01–04` (708 acceptance tests), scanned for code, identifiers and personal data |
| 2 Architecture | **Done** | `docs/architecture/ARCHITECTURE.md`, ADRs 0001–0006 |
| 3 New project | **Done** | Workspace, tooling, CI definitions, licence and lockfile checks |
| 4 Backend foundation, auth, database | **Done** | Kernel + auth (passkeys, tokens, lockout, audit, operator CLI) + projects + preferences; unit, integration and 21 black-box acceptance tests |
| 5 Agent runtime (Claude Code, Codex) | In progress | Runtime core being written; adapters next. Both CLIs verified to run in machine-readable mode from a scrubbed environment |
| 6 Workbench, sessions, tasks | In progress | Server side is part of the runtime core; client follows the web foundation |
| 7 Projects, GitHub, terminal, files | In progress | Server modules being written |
| 8 Memory, API models, automation | In progress | Memory being written; Web Push crypto and the OpenAI-compatible client are done and tested; automation not started |
| 9 Mobile UI, PWA, remote access | In progress | Web foundation being written; remote-access guide done |
| 10 Hardening, integration tests, docs | Not started | |
| 11 Compliance and similarity review | Tooling done | `scripts/similarity-audit.mjs`, `scripts/check-licenses.mjs`; final runs pending |
| 12 GitHub release | Not started | Repository not created yet; the name `Jineggegg/agent-studio` was free when checked |

## Work packages

Wave 1 (server modules and the client foundation, in parallel):

- [ ] Agent runtime core — sessions, runs, event log, queue, permission engine, approvals, MCP bridge, scripted test adapter
- [ ] Web client foundation — design system, shell, data layer, auth and settings screens, launcher, PWA
- [ ] Shared memory — Markdown store, search, scope-isolated agent tools
- [ ] Projects (extended), files, Git, GitHub
- [ ] Terminal and remote hosts
- [ ] Plugin system — sandboxed processes, capability API, panel grants, SDK, example

Wave 2 (needs the runtime core and the web foundation):

- [ ] Claude Code adapter (official CLI, stream-json, permission prompts through the bridge)
- [ ] Codex adapter (official CLI; app-server protocol for approvals)
- [ ] API-model providers: configuration, encrypted keys, OpenAI-compatible adapter, confined built-in tools
- [ ] Inbox, notifications, Web Push delivery, automation and deferred runs
- [ ] Usage aggregation; handoff between models, summaries, multi-agent tasks
- [ ] Workbench UI; project tools UI (files, editor, Git, GitHub, terminal); memory, inbox, automation and usage UI; settings pages; launcher customisation

Wave 3:

- [ ] Acceptance suites for the remaining domains; browser tests at three sizes
- [ ] Independent security review and fixes
- [ ] README, SECURITY, CONTRIBUTING, CHANGELOG, guides
- [ ] Final similarity audit, licence inventory, secret scan of the full history
- [ ] Create the GitHub repository, pass CI, publish, tag the first release

## Rules that outlive any one session

- The predecessor system and its repository are read-only and are never read
  by anyone writing code here (`docs/clean-room/PROCESS.md`).
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
