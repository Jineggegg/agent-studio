# ADR 0008 — Plugins run in their own sandboxed processes and ask for everything

**Status:** accepted

## Context
Plugins are how private or third-party tools attach to the product. A plugin
that runs inside the server, or whose UI runs inside the page, is as trusted
as the product itself — which is the opposite of what a plugin should be.

## Decision
- Installing copies and validates a directory; it never runs code and never
  runs a package manager. A plugin starts disabled. Enabling it is an explicit
  grant of the permissions its manifest requests, bound to a hash of its
  contents: an update that asks for more, or whose contents changed, is
  disabled until re-approved.
- Server-side code runs in one child process per plugin, speaking JSON-RPC over
  stdio, inside a bubblewrap sandbox with an empty root (only system
  libraries, the runtime, its own code and its own data directory) and no
  network, with Node's permission model as a second layer. Limits cover
  start-up, call time, message size, memory, idle CPU and crash loops.
- The process has no ambient authority. Storage, notifications, reading
  project files and https requests to granted hosts are host calls, each
  checked against the grant and bound to the user the current call acts for.
  Network requests are made by the host through the guarded HTTP client.
- Plugin UI is static files served under a short-lived, unguessable grant and
  embedded in `<iframe sandbox="allow-scripts allow-forms">` — never
  `allow-same-origin` — with a content security policy that forbids all
  network access. Its only channel is `postMessage`, which the page relays to
  the plugin as the signed-in user.

## Consequences
- Where bubblewrap is unavailable only Node's permission model applies, which
  does not cover the network; the product says so and treats such a plugin's
  tools as side-effecting. With neither layer, plugins with server code cannot
  be enabled unless the operator opts in.
- A plugin ships what it needs; there is no dependency installation step.
