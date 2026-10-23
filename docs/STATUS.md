# Build status

A running record of what is done, what is in flight and what comes next, kept
so that work can resume after an interruption. It is updated at every
integration point; nothing is listed as done unless its tests pass.

Last updated: 2026-10-23 (Cloud Harness 2.0.0-beta.6: product images redesigned).

## Visual tour and domain setup

- The English and Chinese READMEs now link to a screenshot-led product tour.
  Actual application captures show synthetic projects, notes and mail, with
  scripted agent replies. The multi-device artwork uses those captures inside
  illustrated frames; it is not evidence of physical-device testing.
- Owners have a **Settings → Domain & access** entry with strict hostname/port
  validation, Caddy or Cloudflare Tunnel instructions and copyable configuration.
  The page reads the server's accepted origins. DNS, HTTPS setup and service
  changes remain manual, and external reachability is not inferred from that list.
- Local checks pass: typecheck, lint, production build, 40 domain unit/component
  cases, and seven Chromium scenarios covering the domain flow and settings on
  phone, tablet and desktop. Two phone-only touch checks are skipped at larger
  sizes. The screenshot runner uses an isolated temporary installation and a
  closed mail fixture; it does not contact live model providers or mail accounts.
- The source of the artwork and its reproduction instructions are in
  [scripts/showcase](../scripts/showcase/README.md). No private code or assets
  were introduced. GitHub CI remains the authority for the broader regression,
  WebKit and installation checks.

## Cloud Harness expansion

The accepted scope is recorded in `docs/requirements/05-cloud-harness.md`.
Implementation includes conversation groups and branches, account profiles,
external transcript import, file checkpoints, image annotation, voice,
native Anthropic, mail, reminder proposals, optional notifications, a tool
library, static project apps, an isolated browser, a Windows companion and a
desktop wrapper. Each starts without personal accounts or deployment data.

Local verification for this expansion:

- Typecheck, lint, production build and the built-server smoke test pass.
- Full unit regression: 3,272 passed, one skipped. Subsequent targeted tool-schema
  and bridge regressions also pass after the MCP object-union compatibility fix.
  After the CodeQL mail fix, eight parser tests, two plain-text rendering tests
  and four mailbox integration tests pass; typecheck, lint, build and package
  installation were repeated successfully.
- Integration regression: 1,334 passed, 13 skipped (opt-in external/runtime checks).
- Passkey follow-up: 16 integration tests and 12 black-box tests pass, including
  concurrent challenge consumption, failed-signature reuse and expiry during
  verification. Typecheck, lint, build, package installation and artifact scans
  were repeated successfully after the fix.
- Black-box acceptance: 434 passed.
- Chromium browser coverage: 66 application scenarios pass across phone, tablet
  and desktop; six phone-only cases are intentionally skipped at other sizes.
  Nine additional hit-area measurement regressions pass in a separate final run.
  Real phone button sizing defects were corrected; the measurement tests also
  distinguish normal scroll clipping from undersized and covered controls.
- A real sandboxed Chromium smoke test passes, including click/type interaction,
  denied private-network access and restricted inherited environment.
- Linux Electron directory packaging passes. Nine desktop policy and release
  download-security tests pass. The release archive installs, serves the UI and
  terminal on loopback, supports the new command alias, and refuses tampering,
  invalid versions and failed provenance verification.
- Dependency audit reports zero known vulnerabilities. The lockfile check passes
  for 881 registry entries; all 776 dependency licences are on the allow-list.
- Independent AI-assisted security and privacy reviews were completed before
  commit. Fixed findings and residual limits are listed in
  [the publication review](clean-room/RELEASE-REVIEW-2026-10-23.md).
- Secret scans cover the candidate tree, existing public history, desktop archive
  and extracted release material. No leaks were reported. The release contains
  9,336 files including dependencies, with 474 application files and no application
  source maps, compiled tests or runtime databases. Realistic planted-key canaries
  still fail the scanner as expected. Source comparisons are recorded in
  [SIMILARITY.md](clean-room/SIMILARITY.md).

GitHub CI additionally runs Node 22/24, WebKit, Windows companion parsing and C#
compilation, CodeQL, and installation across Ubuntu x64/ARM64, Debian, Fedora and
macOS. Its check results are the authority for those environments; local checks
do not claim physical Windows/macOS or mobile-device validation.

## Earlier release phases

| Phase                                           | State         | Evidence                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Requirements                                  | **Done**      | `docs/requirements/01–04` (708 acceptance tests), scanned for code and personal data; security observations about the predecessor restated as requirements before publication                                                                                                                                                                                  |
| 2 Architecture                                  | **Done**      | `docs/architecture/ARCHITECTURE.md`, ADRs 0001–0010                                                                                                                                                                                                                                                                                                            |
| 3 New project                                   | **Done**      | Workspace, tooling, CI definitions, licence and lockfile checks                                                                                                                                                                                                                                                                                                |
| 4 Backend foundation, auth, database            | **Done**      | Kernel; accounts with passkeys, API tokens, lockout, audit log, operator commands; projects; preferences                                                                                                                                                                                                                                                       |
| 5 Agent runtime (Claude Code, Codex)            | **Done**      | Runtime; Claude Code adapter verified against Claude Code 2.1.283 and Codex adapter against codex-cli 0.160.0 (`docs/guides/agent-smoke-test.md` says exactly what was seen)                                                                                                                                                                                   |
| 6 Workbench, sessions, tasks                    | **Done**      | Workbench UI; handoff, multi-agent tasks, running work                                                                                                                                                                                                                                                                                                         |
| 7 Projects, GitHub, terminal, files             | **Done**      | GitHub read paths checked against a real account; merge and other write actions never run against the real service                                                                                                                                                                                                                                             |
| 8 Memory, API models, automation                | **Done**      | API-model providers never run against a real provider; Web Push never sent to a real push service                                                                                                                                                                                                                                                              |
| 9 Mobile UI, PWA, remote access                 | **Done**      | Verified in headless Chromium at phone, tablet and desktop sizes and in WebKit at phone size (in CI); **not on a physical iPhone or iPad**                                                                                                                                                                                                                     |
| 10 Hardening, integration tests, docs           | **Done**      | AI-assisted security review: no critical/high/medium findings, two lows fixed; guides in `docs/guides/`                                                                                                                                                                                                                                                        |
| 11 Compliance and similarity review             | **Done**      | `docs/licenses/THIRD_PARTY_LICENSES.md`, `docs/clean-room/SIMILARITY.md`                                                                                                                                                                                                                                                                                       |
| 12 GitHub release                               | **Done**      | Public repository; every CI job green on GitHub-hosted runners at the release commit, plus CodeQL; release `v2.0.0-beta.1`                                                                                                                                                                                                                                     |
| 13 One-line install (part 1 of one-click setup) | **In review** | `packaging/install.sh`, `packaging/bin/agent-studio`, `scripts/package-release.mjs`; CI installs the package on Ubuntu x64/ARM64, Debian, Fedora and macOS (with the service); release workflow attaches the package with build provenance. Next: remote access set-up (Tailscale, then Cloudflare Tunnel, then a VPS with Caddy), then update/backup/rollback |

## Verified at the earlier release commit

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
- Static app previews do not run arbitrary server backends. Mail uses delegated
  Gmail/Outlook APIs; MCP management supports handshake Streamable HTTP.
  Physical Windows/macOS desktop and companion checks remain manual. The optional
  isolated browser has no hard CPU, memory or temporary-disk quota; usage gates
  cannot precisely limit in-flight or concurrent spending. See the publication
  review for the full scope of these limits.

## Rules that outlive any one session

- Implementation workers use public requirements and this repository only;
  coordinating-audit exceptions are disclosed in `docs/clean-room/PROCESS.md`.
- New code enters through `docs/development/CONVENTIONS.md`.
- The repository goes public only after the security review, the secret scan,
  the licence check and the similarity audit are clean.
