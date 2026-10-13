# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-13 (wave 1 integrated; wave 2 started).

## Phases

| Phase | State | Evidence |
|---|---|---|
| 1 Requirements | **Done** | `docs/requirements/01–04` (708 acceptance tests), scanned for code, identifiers and personal data |
| 2 Architecture | **Done** | `docs/architecture/ARCHITECTURE.md`, ADRs 0001–0006 |
| 3 New project | **Done** | Workspace, tooling, CI definitions, licence and lockfile checks |
| 4 Backend foundation, auth, database | **Done** | Kernel + auth (passkeys, tokens, lockout, audit, operator CLI) + projects + preferences; unit, integration and 21 black-box acceptance tests |
| 5 Agent runtime (Claude Code, Codex) | In progress | Runtime core **done** (sessions, runs, event log, queue, permission engine, approvals, MCP bridge; 390 tests). Adapters for the real CLIs in progress |
| 6 Workbench, sessions, tasks | In progress | Server side done with the runtime core; workbench UI in progress |
| 7 Projects, GitHub, terminal, files | Server **done** | Files, Git, worktrees, GitHub (through a stand-in `gh` only — needs one manual check against a real account), terminal with real PTY tests, remote hosts, plugins. UI pending |
| 8 Memory, API models, automation | In progress | Memory server **done** (575 tests). API-model adapter, inbox, notifications and automation in progress |
| 9 Mobile UI, PWA, remote access | In progress | Web foundation **done** (design system, shell, auth and settings screens, launcher, PWA; verified in headless Chromium at phone, tablet and desktop sizes — not yet on a real device). Feature screens pending |
| 10 Hardening, integration tests, docs | In progress | 119 black-box acceptance tests for the security domain; they found and fixed an authentication bypass (URL spelling), non-atomic setup and a parallel-guess race. Independent review still to come |
| 11 Compliance and similarity review | Tooling done | `scripts/similarity-audit.mjs`, `scripts/check-licenses.mjs`; final runs pending |
| 12 GitHub release | Not started | Repository not created yet; the name `Jineggegg/agent-studio` was free when checked |

## Work packages

Wave 1 (server modules and the client foundation, in parallel):

- [x] Agent runtime core — sessions, runs, event log, queue, permission engine, approvals, MCP bridge, scripted test adapter
- [x] Web client foundation — design system, shell, data layer, auth and settings screens, launcher, PWA
- [x] Shared memory — Markdown store, search, scope-isolated agent tools
- [x] Projects (extended), files, Git, GitHub
- [x] Terminal and remote hosts
- [x] Plugin system — sandboxed processes, capability API, panel grants, SDK, example

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

## Verified at the last integration point

`npm run typecheck`, `npm run lint`, 2,031 unit tests, 834 integration tests,
`npm run build`, `node scripts/smoke.mjs`, and 119 acceptance tests against the
built server all pass on Linux with bubblewrap available.

Known gaps carried forward: GitHub module not yet exercised against the real
service; nothing verified on a physical iPhone or iPad; a disabled account's
running agent is not stopped (the event now exists, the runtime does not yet
listen for it); notification channels other than in-app and Web Push are not
planned for the first release.

## Rules that outlive any one session

- The predecessor system and its repository are read-only and are never read
  by anyone writing code here (`docs/clean-room/PROCESS.md`).
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
