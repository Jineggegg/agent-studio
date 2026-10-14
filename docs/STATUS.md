# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-15 (2.0.0-beta.3: security review and fixes).

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
| 9 Mobile UI, PWA, remote access | **Done** | Verified in headless Chromium at phone, tablet and desktop sizes and in WebKit at phone size (in CI); **not on a physical iPhone or iPad** |
| 10 Hardening, integration tests, docs | **Done** | AI-assisted security review: no critical/high/medium findings, two lows fixed; guides in `docs/guides/` |
| 11 Compliance and similarity review | **Done** | `docs/licenses/THIRD_PARTY_LICENSES.md`, `docs/clean-room/SIMILARITY.md` |
| 12 GitHub release | **Done** | Public repository; every CI job green on GitHub-hosted runners at the release commit, plus CodeQL; release `v2.0.0-beta.1` |
| 13 One-line install (part 1 of one-click setup) | **In review** | `packaging/install.sh`, `packaging/bin/agent-studio`, `scripts/package-release.mjs`; CI installs the package on Ubuntu x64/ARM64, Debian, Fedora and macOS (with the service); release workflow attaches the package with build provenance. Next: remote access set-up (Tailscale, then Cloudflare Tunnel, then a VPS with Caddy), then update/backup/rollback |

## Verified at the release commit

Locally, on Linux with bubblewrap available: `npm run typecheck`,
`npm run lint`, 3,172 unit tests, 1,271 integration tests (12 skipped:
real-CLI checks that run only on request), `npm run build`,
`node scripts/smoke.mjs`, 434 black-box acceptance tests against the built
server, 54 browser tests on Chromium (phone, tablet, desktop), `npm audit`
(0 vulnerabilities), the lockfile and licence checks (562 packages, all on
the allow-list), and a gitleaks scan of every commit (no leaks).

In CI on GitHub-hosted runners: the same checks, with unit and integration
tests on Node 22 and 24, and the browser tests also in WebKit at phone size
(74 in all). The first CI run there found what the local runs could not —
an ordering bug in attachment lists, a shutdown that could wait minutes for a
stalled upload, and tests that depended on this machine's set-up — all fixed
before the release. CodeQL's first analysis found a real gap: the file tools
of API models checked a path and then used it, so a command racing a tool
could swap a directory for a link out of the project in between. They now
open through checked descriptors (`openInside` in `apps/server/src/kernel/paths.ts`).
Its other findings in shipped code were hardened (push-service names matched on
domain boundaries, a pattern built from a fully escaped name, the service
worker checking where a message comes from) or recorded as false positives
with the reason (high-entropy tokens hashed with SHA-256; a certificate
pinned by fingerprint; patterns that find secrets in text). Test code is no
longer analysed.

## Security review of 2026-10-14

A second AI-assisted review (sandbox, approvals, git, plugins, logging,
installer, licences, similarity) found no critical issue. Fixed: agent-written
git hooks and filters running outside the sandbox from the Git panel (high);
API tokens able to remove the human approver, the installer settings and TLS
key visible to agents, unredacted error stacks, a provenance failure that did
not stop the installer, migrations without a copy beforehand, and missing
licence notices in the web bundle (medium); and several low ones. Still open,
with reasons, in the pull request that fixed them: host service sockets
(D-Bus, docker) reachable from the `mask` sandbox, a check-then-use race in the
Files API, plugin panels and WebRTC, plugin isolation without bubblewrap, and
non-atomic release switching in the installer. The similarity audit was re-run
against the predecessor and its upstream with the same result as at release.

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

## Rules that outlive any one session

- The predecessor system and its repository are read-only and are never read
  by anyone writing code here (`docs/clean-room/PROCESS.md`).
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
