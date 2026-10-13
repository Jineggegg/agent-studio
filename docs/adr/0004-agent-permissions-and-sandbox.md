# ADR 0004 — Permissions are enforced on the server; agents are sandboxed where the platform allows

**Status:** accepted

## Context
An AI agent can run commands. Hiding a button in the client is not a control.

## Decision
1. **One permission engine on the server** decides every tool request from
   every agent: allow, deny, or ask a human. Its inputs are the session's
   permission mode (`plan`, `ask`, `accept-edits`, `auto`), allow/deny rules at
   account, project and session scope, and a risk classifier. Deny rules always
   win. Requests classified as dangerous (destructive commands, privilege
   escalation, writes outside the project, credential paths, piping downloads
   into a shell, force-pushes) are asked about even when a broad allow rule
   matches, in every mode except `auto`. `auto` must be enabled per project by
   the owner.
2. **Each adapter routes its agent's own permission mechanism into that
   engine** — Claude Code's permission-prompt tool, Codex's approval requests,
   and the built-in tool loop for API models. No adapter decides on its own.
3. **Approvals are durable records** with an expiry. They are shown in the
   session, in the inbox and by push notification, can be answered from any of
   the user's devices, and are denied when they expire or the run stops.
   Unattended runs (schedules) never wait for a human by default: what would
   need approval is denied and reported.
4. **The server's own secrets are out of an agent's reach.**
   - Child processes get an allow-listed environment; nothing named
     `AGENT_STUDIO_*` can be inherited.
   - On Linux with bubblewrap available, agent processes run in a mount and PID
     namespace in which the Studio's data directory is an empty tmpfs (`mask`
     profile). Commands run by the built-in tool loop use a stricter `confine`
     profile: read-only file system except the project directory, credential
     directories hidden, network optional.
   - Without bubblewrap the sandbox reports itself as off in the UI and the
     health information; the permission engine still applies.
5. **File, Git and terminal APIs are confined to the project directory** on the
   server by real-path checks, independent of anything the agent does.

## Consequences
- The `mask` profile is not a jail: an approved command can still write
  anywhere the service account can. It protects the Studio's credentials and
  database, and approvals protect everything else.
- Background processes an agent starts end with its run (PID namespace).
