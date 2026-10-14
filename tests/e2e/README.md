# Browser tests

The built web client, driven in a real browser at three sizes, against the
**demo server** — the real server plus scripted demo agents
(`apps/server/src/testing/demo-server.ts`), so no agent CLI, model provider,
GitHub or push service is ever reached.

| Project        | Browser  | Size       | Notes                                                         |
| -------------- | -------- | ---------- | ------------------------------------------------------------- |
| `phone`        | Chromium | 390 × 844  | touch, mobile; also the phone-only specs and the 44 px rule   |
| `tablet`       | Chromium | 820 × 1180 | touch, mobile                                                 |
| `desktop`      | Chromium | 1440 × 900 | mouse and keyboard                                            |
| `phone-webkit` | WebKit   | 390 × 844  | iPhone Safari's engine; only when `E2E_WEBKIT=1` (CI sets it) |

## Running

```bash
npm ci
npx playwright install chromium          # once, and after every @playwright/test upgrade
npm run build                            # the suite serves apps/web/dist; it does not build it
npm run test:e2e                         # phone, tablet and desktop, one test at a time
```

```bash
npm run test:e2e -- --project=phone                 # one size
npm run test:e2e -- workbench.spec.ts               # one file
npm run test:e2e -- -g "stopping"                   # tests whose title matches
npx playwright show-report                          # the HTML report of the last run (playwright-report/)
npx playwright show-trace test-results/<test>/trace.zip   # what a failed test saw, step by step
```

WebKit needs its system libraries, which only root can install:

```bash
npx playwright install --with-deps webkit           # what CI does (with chromium)
E2E_WEBKIT=1 npm run test:e2e -- --project=phone-webkit
```

### Machines without Chromium's system libraries

Headless Chromium needs a few shared libraries (on a bare WSL or container,
`libasound.so.2` is the usual one missing). Without root, unpack the package
into a folder of your own and point the loader at it:

```bash
apt-get download libasound2t64 && dpkg -x libasound2t64_*.deb ~/.cache/agent-studio-tools/pkg
mkdir -p ~/.cache/agent-studio-tools/libs && cp -a ~/.cache/agent-studio-tools/pkg/usr/lib/x86_64-linux-gnu/libasound.so.2* ~/.cache/agent-studio-tools/libs/
LD_LIBRARY_PATH=$HOME/.cache/agent-studio-tools/libs npm run test:e2e
```

### Settings

| Variable      | Default         | What it does                                                                         |
| ------------- | --------------- | ------------------------------------------------------------------------------------ |
| `E2E_PORT`    | `7620`          | The demo server's port. The first-run spec starts a second server on `E2E_PORT + 1`. |
| `E2E_WEB_DIR` | `apps/web/dist` | The client build to serve — e.g. a copy, while someone else rebuilds `dist`.         |
| `E2E_WEBKIT`  | unset           | `1` adds the `phone-webkit` project.                                                 |
| `CI`          | unset           | Set by CI: one retry per failed test, `test.only` forbidden, GitHub annotations.     |

## What a run does

1. `support/launch-server.ts` (Playwright's `webServer`) empties
   `$TMPDIR/agent-studio-e2e-<port>/` and starts
   `node --import tsx apps/server/src/testing/demo-server.ts` (with
   `TSX_TSCONFIG_PATH=apps/server/tsconfig.json`) with a data directory, a
   workspace root and a home directory inside it, the fixed setup token from
   `support/env.ts`, `AGENT_STUDIO_ENV=test`, `AGENT_STUDIO_SANDBOX=off`, short
   demo approval and question time-outs (2 min, 1 min), and `tests/fixtures/bin`
   first on `PATH` — so the stand-in `claude`, `codex` and `gh` are the only ones
   the server can find. When the run ends Playwright sends SIGTERM; the launcher
   stops the server and deletes the folder.
2. `global-setup.ts` creates the owner through the API with the setup token and
   saves the signed-in browser state to `tests/e2e/.auth/owner.json` (ignored by
   git). Tests start signed in as the owner, except those about signing in.
3. The specs run one at a time (`workers: 1`) against that one server. Each test
   makes what it needs — usually a project through the API, with a name and
   folder no other test uses — so tests do not depend on each other's order.

## Specs

| File                   | What it covers                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `first-run.spec.ts`    | First-run setup through the UI, on a fresh server of its own (port + 1)                                                                                                        |
| `auth.spec.ts`         | Wrong password refused in words, sign in, sign out                                                                                                                             |
| `launcher.spec.ts`     | The launcher's date, apps and project tiles; theme dark and back; language Chinese and back                                                                                    |
| `workbench.spec.ts`    | New project through the UI; demo agent conversation; `[[tools]]` rows and an edit's diff; `[[approve]]` allowed and denied; `[[long]]` streamed and stopped; reload mid-stream |
| `phone.spec.ts`        | Phone only: list as a drawer, project tools full screen, the field above the keyboard, no sideways scrolling                                                                   |
| `files-git.spec.ts`    | Open, edit and save a file; see the change in Git and commit it                                                                                                                |
| `terminal.spec.ts`     | Open a terminal, `echo hello`, see `hello` (skipped where the server cannot open a pseudo-terminal)                                                                            |
| `memory-inbox.spec.ts` | Write a note and find it by search; an approval left waiting shows in the inbox                                                                                                |
| `settings.spec.ts`     | Every page the settings list leads to has its heading and no error state                                                                                                       |
| `a11y.spec.ts`         | Key screens: every visible control has an accessible name; on a phone a hit area of 44 × 44 px                                                                                 |

`support/` holds the fixtures (`test.ts`), the server starter, the API helper,
workbench and launcher helpers, the sample git repository and the hit-area scan.

## Rules for new tests

- **Import `test` and `expect` from `./support/test.js`.** Its guard fails a test
  on any console error, uncaught page error or content-security-policy
  violation. A test that provokes one on purpose says so:
  `allowConsoleErrors(/status of 401/)`.
- Find things the way a person does: roles and accessible names
  (`getByRole('button', { name: 'Send' })`), in English (`locale: en-US`).
- Wait for something visible, never for time: `expect(…).toBeVisible()`,
  `expect.poll`, `waitForFunction`. No `waitForTimeout`.
- Make what the test needs, with `unique()` names and `freshFolder()` paths; the
  server is shared by all projects of a run.
- Leave account-wide state (theme, language) as it was — see `launcher.spec.ts`.
- A product defect is a skipped test whose comment starts with `FINDING:` and says
  how to reproduce it; un-skip it when the defect is fixed.
