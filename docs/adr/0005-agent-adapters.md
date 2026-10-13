# ADR 0005 — Agents are reached through their official command-line interfaces

**Status:** accepted

## Decision
- **Claude Code** and **Codex** are driven by spawning the CLI the user has
  installed and signed in to, using each tool's documented non-interactive,
  machine-readable mode. The Studio never reads, copies or proxies their
  credentials, and calls no private endpoint.
- **API models** (any OpenAI-compatible endpoint, DeepSeek by default) are
  called directly over HTTPS with a key the owner stores in the encrypted
  secret store. Their tools are implemented by the Studio and go through the
  same permission engine.
- All of them implement one `AgentAdapter` contract and emit one normalised
  event vocabulary, so the transcript, approvals, usage accounting, handoff and
  automation code is written once. A plugin can register another adapter.
- The Studio's own tools (shared memory, plugin tools) are exposed to CLI
  agents through a small MCP server process that authenticates back to the
  Studio with a token scoped to one run.

## Why not the vendor SDKs
The agent SDKs are convenient but are not open-source licensed, and bundling
one would put a proprietary dependency in an MIT project and pin users to the
version we ship. The CLIs are what users already have, keep their own
subscription sign-in, and update independently.

## Consequences
- The adapters depend on the CLIs' output formats; each has a fake CLI used in
  tests and a documented manual smoke test against the real one.
- A CLI that is missing or signed out disables only its own adapter, with a
  clear status.
