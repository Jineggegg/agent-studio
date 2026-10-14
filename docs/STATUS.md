# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-14 (all server modules and the workbench UI integrated; project tools UI and acceptance suites in progress).

## Phases

| Phase | State | Evidence |
|---|---|---|
| 1 Requirements | **Done** | `docs/requirements/01–04` (708 acceptance tests), scanned for code, identifiers and personal data |
| 2 Architecture | **Done** | `docs/architecture/ARCHITECTURE.md`, ADRs 0001–0006 |
| 3 New project | **Done** | Workspace, tooling, CI definitions, licence and lockfile checks |
| 4 Backend foundation, auth, database | **Done** | Kernel + auth (passkeys, tokens, lockout, audit, operator CLI) + projects + preferences; unit, integration and 21 black-box acceptance tests |
| 5 Agent runtime (Claude Code, Codex) | **Done** (server) | Runtime core; Claude Code adapter (stream-json; verified against Claude Code 2.1.283: attachments, resume, approved and denied writes, steering, stop); Codex adapter (app-server protocol; verified against codex-cli 0.160.0: status, turn, resume, bridge tool, approved and denied changes, stop). See `docs/guides/agent-smoke-test.md` for what was and was not seen from the real CLIs |
| 6 Workbench, sessions, tasks | **Done** | Runtime; workbench UI (transcript, composer with durable delivery, approvals, queue, recovery) verified in headless Chromium at four widths, not on a physical device; handoff, multi-agent tasks and a running-work view on the server (UI pending) |
| 7 Projects, GitHub, terminal, files | Server **done** | Files, Git, worktrees, GitHub (automated tests use a stand-in `gh`; the read paths — account, repositories, pull-request inbox, repository page, pull-request detail, CI runs — were checked by hand against a real account on 2026-10-14; merge and the other write actions were not), terminal with real PTY tests, remote hosts, plugins. UI pending |
| 8 Memory, API models, automation | Server **done** | Memory; API-model providers with a confined tool loop (never run against a real provider — preset model ids are unverified); inbox, notifications, Web Push (never sent to a real push service), automation with exactly-once scheduling. UI pending |
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

- [x] Claude Code adapter (official CLI, stream-json, permission prompts through the bridge)
- [x] Codex adapter (official CLI; app-server protocol for approvals)
- [x] API-model providers: configuration, encrypted keys, OpenAI-compatible adapter, confined built-in tools
- [x] Inbox, notifications, Web Push delivery, automation and deferred runs
- [x] Usage aggregation; handoff between models, summaries, multi-agent tasks (server)
- [x] Workbench UI
- [ ] Project tools UI (files, editor, Git, GitHub, terminal, project settings)
- [ ] Memory, inbox, automation, models, plugins, usage, handoff and task screens; launcher customisation

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

Since then (each verified by its own suites; a full run is due at the next
integration point): the two CLI adapters, API-model providers, inbox,
notifications and automation.

Operational note: this project is developed on a 6 GB machine that also runs
other services. Heavy commands are serialised machine-wide and at most two
development agents work at a time; running five in parallel exhausted memory
and restarted the machine on 2026-10-14.

Known gaps carried forward: GitHub write actions (merge, update branch) never
run against the real service; nothing verified on a physical iPhone or iPad; a disabled account's
running agent is not stopped (the event now exists, the runtime does not yet
listen for it); notification channels other than in-app and Web Push are not
planned for the first release.

## Rules that outlive any one session

- The predecessor system and its repository are read-only and are never read
  by anyone writing code here (`docs/clean-room/PROCESS.md`).
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
