# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-14 (release candidate).

## Phases

| Phase | State | Evidence |
|---|---|---|
| 1 Requirements | **Done** | `docs/requirements/01–04` (708 acceptance tests), scanned for code and personal data; security observations about the predecessor restated as requirements before publication |
| 2 Architecture | **Done** | `docs/architecture/ARCHITECTURE.md`, ADRs 0001–0010 |
| 3 New project | **Done** | Workspace, tooling, CI definitions, licence and lockfile checks |
| 4 Backend foundation, auth, database | **Done** | Kernel; accounts with passkeys, API tokens, lockout, audit log, operator commands; projects; preferences |
| 5 Agent runtime (Claude Code, Codex) | **Done** | Runtime; Claude Code adapter verified against Claude Code 2.1.283 and Codex adapter against codex-cli 0.160.0 (`docs/guides/agent-smoke-test.md` says exactly what was seen) |
| 6 Workbench, sessions, tasks | **Done** | Workbench UI; handoff, multi-agent tasks, running work |
| 7 Projects, GitHub, terminal, files | **Done** | GitHub read paths checked against a real account; merge and other write actions never run against the real service |
| 8 Memory, API models, automation | **Done** | API-model providers never run against a real provider; Web Push never sent to a real push service |
| 9 Mobile UI, PWA, remote access | **Done** | Verified in headless Chromium at phone, tablet and desktop sizes; **not on a physical iPhone or iPad**; WebKit runs only in CI |
| 10 Hardening, integration tests, docs | **Done** | AI-assisted security review: no critical/high/medium findings, two lows fixed; guides in `docs/guides/` |
| 11 Compliance and similarity review | **Done** | `docs/licenses/THIRD_PARTY_LICENSES.md`, `docs/clean-room/SIMILARITY.md` |
| 12 GitHub release | In progress | |

## Verified at the release commit

On Linux with bubblewrap available: `npm run typecheck`, `npm run lint`,
3,165 unit tests, 1,270 integration tests (12 skipped: real-CLI checks that
run only on request), `npm run build`, `node scripts/smoke.mjs`, 434
black-box acceptance tests against the built server, 54 browser tests on
Chromium (phone, tablet, desktop), `npm audit` (0 vulnerabilities), the
lockfile and licence checks (562 packages, all on the allow-list), and a
gitleaks scan of every commit (no leaks).

## Known gaps and limits

- **Not verified on physical devices** (iPhone, iPad, Android). Safe areas,
  the soft keyboard and gestures were emulated.
- **Never exercised against the real services**: GitHub merges and other
  GitHub writes; any real model provider (preset model ids are unverified
  defaults); delivery through a real Web Push service.
- **Real CLI checks are manual**: the Claude Code and Codex adapters were
  verified by hand once each (see the smoke-test guide); some event types
  (compaction, usage limits, a few Codex item types) were handled from the
  documented shapes only.
- A preference changed less than about half a second before a full page load
  can be lost.
- Plugin panels log one console message in Chromium for a protective
  content-security-policy directive it does not recognise.
- Not built: AI-built apps with a per-app gateway, an agent-driven browser,
  MCP server and skills management screens, slash commands, voice input and
  read-aloud, discovery of agent sessions started outside the product, image
  markup, notification channels other than Web Push, natural-language
  automation planning, multiple chains per session list group.

## Operational note

This project is developed on a 6 GB machine that also runs other services.
Heavy commands are serialised machine-wide and at most two development agents
work at a time; running five in parallel exhausted memory and restarted the
machine on 2026-10-14.

## Rules that outlive any one session

- The predecessor system and its repository are read-only and are never read
  by anyone writing code here (`docs/clean-room/PROCESS.md`).
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
