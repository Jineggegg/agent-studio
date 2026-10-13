# Architecture

Agent Cloud Studio is one server process you run on your own machine and a web
client that works as an installed app on a phone, a tablet or a desktop. The
server owns everything that matters — agent runs, approvals, credentials,
files — and the client is a view onto it that can disappear and come back at
any moment.

```
 iPhone / iPad / desktop browser (PWA)
            │  HTTPS (tunnel, mesh VPN or reverse proxy terminates TLS)
            ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Studio server (Node.js, one process, loopback by default)             │
 │                                                                      │
 │  HTTP kernel ── auth ── access check ── validation ── module routes   │
 │  Realtime hub (one WebSocket per tab, topic subscriptions, replay)    │
 │                                                                      │
 │  Agent runtime: sessions · runs · event log · queue                  │
 │  Permission engine ── approvals (durable, answerable on any device)   │
 │  Projects · files · Git · GitHub · terminal · remote hosts            │
 │  Memory (Markdown + full-text index) · inbox · push · automation      │
 │  Plugins (separate processes, capability API)                        │
 │                                                                      │
 │  SQLite (node:sqlite) · encrypted secret store · data directory 0700  │
 └───────┬───────────────┬──────────────────┬──────────────┬────────────┘
         │ spawn          │ spawn             │ HTTPS         │ spawn
         ▼ (sandboxed)    ▼ (sandboxed)       ▼ (guarded)     ▼ (sandboxed)
   Claude Code CLI    Codex CLI         OpenAI-compatible   plugin processes
   (your sign-in)     (your sign-in)    APIs (your key)
         │                │
         └── MCP bridge ──┘  a tiny stdio process per run that lets the agent
                             call Studio tools with a token scoped to that run
```

Model requests are made by the server, never by the phone. The server is not a
model proxy: there is no endpoint that forwards arbitrary prompts for an
unauthenticated caller.

## Code map

```
packages/protocol     zod schemas and types for every request, response and realtime event
packages/plugin-sdk   what a plugin author imports (zero dependencies)
apps/server
  src/kernel          the security-critical foundation (see below)
  src/modules/<name>  one directory per feature; each exports a StudioModule
  src/bin             small executables the server launches (the MCP bridge)
  src/cli.ts          operator commands (status, reset-password, unlock, …)
apps/web              React client: design system, app shell, one directory per feature
tests/acceptance      black-box tests against a separately started server
tests/e2e             browser tests on phone, tablet and desktop viewports
```

### The kernel

Small, dependency-light, and where every dangerous capability is concentrated
so that feature code cannot get it wrong by accident.

| File | Responsibility |
|---|---|
| `config.ts` | Reads `AGENT_STUDIO_*` only; safe defaults (loopback, production) |
| `http.ts` | Fastify set-up; Host allow-list; session/bearer authentication; **every `/api` route must declare its access level or the server will not start**; Origin and anti-forgery checks; security headers; uniform errors |
| `realtime.ts` | The WebSocket hub: per-topic authorisation, replay, snapshots, heartbeats, back-pressure, immediate disconnect when a credential is revoked |
| `database.ts` | `node:sqlite` wrapper: prepared statements only, transactions, per-module numbered migrations |
| `process.ts` | The only place that spawns processes: argument arrays, allow-listed environment, process-group termination, the bubblewrap sandbox profiles |
| `paths.ts` | Confines client-supplied paths to a root, following symbolic links |
| `net.ts` | Outbound HTTP to configured/user-supplied addresses: post-resolution address checks, no redirects |
| `secrets.ts`, `crypto.ts` | Master key, key derivation, AES-256-GCM secret store, scrypt, tokens |
| `agent-tools.ts` | Registry of tools the Studio offers to every agent |
| `redact.ts` | Last-line removal of credential-shaped text from logs and audit entries |
| `module.ts`, `studio.ts` | The module contract and the composition root |

A lint rule forbids `child_process` outside `process.ts`, and
`dangerouslySetInnerHTML` anywhere in the client.

### Modules

A module declares its migrations, creates its services, registers its routes
and realtime topics in `setup`, and may run code in `start`/`stop`. Modules use
each other through typed services on the context and through events on the
in-process bus; none reads another's tables.

| Module | What it owns |
|---|---|
| `audit` | Append-only security log with masked addresses |
| `auth` | Accounts, roles, sessions, API tokens, passkeys, throttling, first-run setup |
| `system` | Health, version, configuration self-checks |
| `preferences` | Account-level settings synced across devices |
| `projects` | The unit of access control: every project-scoped feature asks it first |
| `agents` | Sessions, runs, the event log, queue, permission engine, approvals, attachments, the MCP bridge endpoints, usage records |
| `claude-code`, `codex` | Adapters that drive the official CLIs |
| `providers` | API-model configuration, encrypted keys, the OpenAI-compatible adapter and its built-in tools |
| `files`, `git`, `github` | Project files, Git operations, GitHub through the host's `gh` sign-in |
| `terminal`, `remotes` | Persistent PTY sessions for the owner; operator-configured SSH hosts |
| `memory` | Markdown notes, full-text search, scope-isolated tools for agents |
| `inbox` | Notifications, Web Push, the task inbox |
| `automation` | Schedules and deferred runs |
| `usage` | Token and cost aggregation |
| `plugins` | Installation, sandboxed plugin processes, capability API, panel grants |

## A request, end to end

1. **Host check.** The `Host` header must be a loopback name or one of the
   configured public origins. This defeats DNS rebinding against a service
   bound to loopback.
2. **Authentication.** A bearer API token, or the session cookie. Tokens and
   session secrets are stored hashed.
3. **Cross-site defences** for state-changing requests and WebSocket
   handshakes: the `Origin` must be the origin the request was sent to; cookie
   sessions must also present the anti-forgery header.
4. **Access.** The route's declared level (`public`, `user`, `owner`, `self`),
   token scope, "browser session only" and "authenticated recently" flags.
5. **Validation.** Body, query and path parameters are parsed with the zod
   schema from the protocol package before the handler runs.
6. **Authorisation of the object.** Project-scoped handlers call
   `projects.requireAccess`; per-user rows are filtered by user in the query.
7. **The handler** uses kernel primitives for anything dangerous.
8. **Errors** leave as `{ error: { code, message, details? } }`; unexpected
   ones are logged (redacted) and reported as a generic 500.

## Realtime

One WebSocket per tab at `/api/realtime`. The client subscribes to topics such
as `session:<id>`, `project:<id>` and `user:<id>`; each subscription is
authorised on its own. Durable topics carry a sequence number per event. When
a phone reconnects it sends the last number it saw and receives exactly what it
missed, plus a snapshot of in-flight state (a half-streamed answer, pending
approvals, the queue). Token-level deltas are broadcast but not stored; the
completed message is.

Terminals use their own binary WebSocket, with the same authentication and
origin rules.

## Agents

**Sessions, runs, events.** A session is a conversation with one agent in one
project. A run is one execution for one user message. Everything that happens
is appended to the session's event log. Runs belong to the server: they
continue with no client attached, any number of devices can watch one, and a
message is acknowledged durably before any agent work begins so that a retry
after a dropped connection can never start a second run.

**Adapters.** Claude Code, Codex and API models implement one `AgentAdapter`
contract and emit one normalised event vocabulary (text, reasoning, tool
start/output/finish, to-do lists, usage, notices). Transcript, approvals,
usage accounting, handoff and automation are written once against that
vocabulary. CLI adapters spawn the user's own installed, signed-in CLI in its
documented machine-readable mode; the Studio never touches the CLI's
credentials.

**Permissions.** Every tool request from every adapter goes to one engine on
the server, which answers allow, deny or ask from the session's permission
mode, the rules at account/project/session scope and a risk classifier. "Ask"
creates a durable approval that is shown in the session, the inbox and a push
notification and can be answered from any device. Unattended runs never wait
for a human unless told to.

**The bridge.** CLI agents reach Studio tools (shared memory, plugin tools,
the permission prompt) through a small stdio MCP server that the adapter has
the CLI launch. It authenticates back to the Studio over loopback with a token
that is valid for that one run only.

**Isolation.** Agent processes get an allow-listed environment and, where
bubblewrap is available, a mount and PID namespace in which the Studio's data
directory is an empty tmpfs. Commands run by the built-in tool loop for API
models are confined further: read-only file system except the project,
credential directories hidden, network optional.

## Data

Everything lives in the data directory (`~/.agent-studio` by default, mode
`0700`):

```
studio.db        SQLite database (WAL)
master.key       32 random bytes (absent when the key comes from the environment)
memory/          notes as Markdown files — the source of truth for memory
attachments/     files attached to messages, per session
plugins/         installed plugin code      plugin-data/   each plugin's own storage
remote-hosts.json  operator-managed list of SSH hosts (optional)
```

Credentials (model API keys, notification channel secrets, the VAPID private
key) are encrypted with AES-256-GCM under a key derived from the master key
and are never returned by the API — only "configured" and a short hint.

## Trust boundaries

| Boundary | What crosses it | What enforces it |
|---|---|---|
| Internet → server | HTTP/WebSocket | TLS at the proxy; Host allow-list; sessions; origin + anti-forgery checks; rate limits |
| Member → owner-only functions | API calls | Declared route access; project membership |
| Browser script → session | — | `HttpOnly` cookie; strict CSP; no raw HTML rendering |
| Agent → host | Tool calls | Permission engine + approvals; sandbox; confined file APIs |
| Agent → Studio's secrets | — | Scrubbed environment; data directory hidden in the sandbox; run-scoped bridge tokens |
| Plugin → Studio | JSON-RPC capability calls | Separate sandboxed process; granted permissions; brokered network |
| Plugin UI → session | `postMessage` only | `sandbox` iframe without same-origin; panel grants |
| Server → other hosts | Model APIs, push services, links | Guarded HTTP client; allow-lists |
| Note content → models | Text | Framed as reference data; credential-bearing notes withheld |

The honest limits of these boundaries are in `SECURITY.md`.

## Testing

- **Unit** tests sit next to the code; the kernel and the permission engine
  are table-driven.
- **Integration** tests boot a whole server in-process with a temporary data
  directory and drive it through its HTTP and WebSocket surface, with a
  scripted agent adapter and fake CLIs standing in for real agents.
- **Acceptance** tests start the built server as a separate process and use
  only its public surface; each is traced to an identifier in
  `docs/requirements/`.
- **Browser** tests run the real client against the real server at phone,
  tablet and desktop sizes.
- The real Claude Code and Codex CLIs are exercised by a manual smoke test
  (`docs/guides/agent-smoke-test.md`); CI never needs a model account.
