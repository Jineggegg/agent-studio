# ADR 0001 — An independent implementation, released under MIT

**Status:** accepted

## Context
The product idea comes from a private system derived from CloudCLI UI
(AGPL-3.0-or-later). Releasing that code under a permissive licence is not
possible, and removing its notices would be wrong. The goal is a public,
permissively licensed project.

## Decision
Write a new system from requirement documents, in a new repository with its own
history, following the two-group process in `docs/clean-room/PROCESS.md`.
Licence it under MIT only if a similarity audit against the old code base finds
no copied code and every dependency's licence is compatible. Record the
process's limitations instead of overstating its strictness.

## Consequences
- No code, asset or history is shared with the old system.
- Every architectural choice is made here, for this code base, and recorded in
  these ADRs.
- Private, owner-specific features of the old system are out of scope; a plugin
  interface is the extension point for them.
