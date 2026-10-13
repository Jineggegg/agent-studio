# Development conventions

Read this before changing code. It is short on purpose; the kernel sources it
points to are the authority.

## The one rule that is not about code

This project is an independent implementation. It is written from the
requirement documents in `docs/requirements/` and from public documentation of
the tools it integrates with. **Do not read, copy or port code from CloudCLI UI
(`siteboon/claudecodeui`) or from any private predecessor of this project** —
not source, not CSS, not test fixtures, not assets. If you have seen that code,
describe behaviour, never transcribe structure. See
`docs/clean-room/PROCESS.md`.

## Layout

```
apps/server      Node.js service (Fastify, built-in SQLite)
  src/kernel     Security-critical foundation. Small, heavily tested, rarely changed.
  src/modules    One directory per feature. Each exports a StudioModule.
  src/testing    Helpers for tests (never imported by production code)
  test/integration   Tests that boot a whole server in-process
apps/web         React client (Vite). Touch-first PWA.
packages/protocol    zod schemas + types for everything that crosses the wire
packages/plugin-sdk  What a plugin author imports
tests/acceptance     Black-box tests against a separately started server
tests/e2e            Browser tests (Playwright): phone, tablet, desktop
docs/                Requirements, architecture, ADRs, guides
```

## Server

**A feature is a module.** `modules/<name>/<name>.module.ts` exports a
`StudioModule` (`kernel/module.ts`): its migrations, a `setup` that creates
services and registers routes, optional `start`/`stop`. Add it to
`modules/index.ts`. Modules talk to each other through `context.services`
(typed by declaration merging — see any existing module) and through events on
`context.bus`; they never reach into another module's tables.

**Every route declares who may call it.** Register routes only with
`context.http.route({...})`. `access` is one of `public`, `user`, `owner`,
`self`; there is no default, and the server refuses to start if a route under
`/api/` lacks one. Validate `body`, `query` and `params` with zod schemas —
handlers must never see unvalidated input.

**Anything inside a project goes through the project check.** Call
`context.services.projects.requireAccess(user, projectId, 'read' | 'write')`
first and use the `rootDir` it returns. It answers "not found" for projects the
caller cannot see, so existence does not leak. Rows that belong to one user
(sessions, notes, schedules, notifications, …) must be filtered by that user in
the query itself — fetching by id and checking afterwards is how IDOR bugs are
written. The owner role may see across users; a member may not.

**Use the kernel for anything dangerous.**

| Need | Use | Never |
|---|---|---|
| Run a program | `context.processes.run/spawn` with an argument array | `child_process`, `shell: true`, string commands |
| Environment for a child | `context.processes.env({...})` | `process.env` passed through |
| Run an agent or its tools | wrap with `context.sandbox.wrap(...)` | spawning agents unwrapped |
| Touch a file named by a client | `await confine(rootDir, relativePath)` from `kernel/paths.ts` | `path.join(root, input)` |
| Call a URL that came from config or a user | `guardedRequest` from `kernel/net.ts` | `fetch(userUrl)` |
| Store a credential | `context.secrets.put` (encrypted); return only `describe()` | plaintext columns, returning secrets in responses |
| Report a problem to the client | throw a `StudioError` (`kernel/errors.ts`) | sending stack traces or raw error text |
| Log | `context.log` with structured fields | `console.*`; logging tokens, keys, message bodies |
| Text that may contain secrets (command output, error text) | `redactSecrets` before logging or storing in audit | |
| Record a security-relevant action | `context.services.audit.record` | |

`git`, `gh`, `ssh` and similar always get `--` before positional arguments
that came from a client, and client-supplied refs/branch names are validated
against a strict pattern first: an argument that starts with `-` is an option
injection.

**SQL** always uses bound parameters (`db.run(sql, ...params)`). Table and
column names are never built from input. Migrations are append-only: add a new
numbered migration, never edit an applied one.

**Events.** Publish what happened with `context.bus.publish(topic, type, data)`.
Topics a browser may subscribe to are `<kind>:<key>` with a registered
`TopicSpec` (`kernel/realtime.ts`) that authorises each subscription. Topics
starting with `internal:` are never visible to browsers.

**Ids and time.** `newId()` for identifiers; timestamps are milliseconds since
the epoch (`Date.now()`).

**Tools offered to agents** are registered once with
`context.agentTools.register` and are then available to every agent adapter.

## Protocol package

Everything a client sends or receives has a zod schema in
`packages/protocol/src/<feature>.ts`, re-exported from `index.ts`. The server
validates with it; the client derives its types from it. Relative imports in
`packages/` and `apps/server` end in `.js` (Node ESM).

## Web client

See `apps/web/README.md` for the component library, layout classes and data
hooks. In short: talk to the server only through the `api` client and the
realtime store (they handle the anti-forgery token, sign-out on 401 and
reconnection); render untrusted text through the Markdown component, never as
HTML; every interactive element has a hit area of at least 44×44 CSS px; every
string is in both `en` and `zh-CN`; every screen works at 360 px wide, in dark
and light, with reduced motion.

## Tests

- Unit tests sit next to the source (`*.test.ts`).
- Integration tests use `createTestStudio()` (`apps/server/src/testing/harness.ts`):
  a real server, in-process, with a temporary data directory and ready-made
  clients — `t.owner()`, `t.member()`, `t.anonymous()`.
- For every feature, test the refusals as carefully as the successes:
  anonymous → 401, a member without the project → 404, read-only → 403,
  another user's row → 404, hostile input (path traversal, option injection,
  oversized bodies) → refused.
- Agent CLIs are exercised in automated tests through small fake executables
  that speak the same protocol, and by hand against the real CLIs. A fake is a
  test double, not an implementation: production code never falls back to one.

```
npm run typecheck
npm run lint
npx vitest run --project server            # unit tests
npx vitest run --project server-integration
npx vitest run --project web
```

## Commits

One logical change per commit, imperative subject, a body that says why.
Never commit generated output, local data, or anything that looks like a
credential — CI scans for both.
