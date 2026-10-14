# ADR 0010 — Agents do not see the machine's credentials unless a project allows it

**Status:** accepted

## Context
Checking the real Codex CLI showed that the commands it runs inside its own
read-only sandbox are never put to an approval, so the permission engine never
sees them: a model could read an SSH key or a cloud credential into the
conversation without anyone being asked. Claude Code's reads do reach the
engine, but an approved or auto-mode command could do the same.

Experiments with both CLIs also showed that a user's own configuration can
make an agent act without asking (a saved allow rule in Codex; an allow rule
or default mode in Claude Code settings).

## Decision
- With the sandbox available, CLI agents run with the usual credential
  locations hidden — SSH and GPG keys, cloud and container credentials, the
  GitHub CLI's token, package-registry tokens, and the other agent's sign-in —
  keeping only the agent's own configuration directory. The owner can allow
  them per project (`agentCredentials`); until then an agent cannot push over
  SSH, and the Git panel or the terminal does that instead.
- Agents run without the user's own agent configuration: Claude Code with no
  settings sources and only the Studio's MCP server; Codex with its config,
  hooks, rules and personal instruction files hidden. A project's `CLAUDE.md`
  is loaded explicitly as a labelled block.
- Without the sandbox nothing can be hidden. Claude Code still asks through
  the engine; Codex refuses to run unless the operator sets
  `AGENT_STUDIO_CODEX_WITHOUT_SANDBOX`, and then says at the start of every
  conversation what is exposed.

## Consequences
The user's custom agent settings (extra MCP servers, hooks, a custom model
provider for Codex) do not apply inside the Studio. That is a real cost,
accepted because each of them is also a way around the approval flow.
