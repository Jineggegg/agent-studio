# ADR 0002 — TypeScript everywhere, few dependencies, no native builds

**Status:** accepted

## Decision
- **One language.** TypeScript for server, client and the shared protocol
  package, in an npm workspace. zod schemas are the single source of truth for
  what crosses the wire.
- **Server:** Node.js ≥ 22.13 and Fastify. Persistence is SQLite through
  Node's built-in `node:sqlite` — no native module to compile, FTS5 included.
  Cryptography (scrypt, AES-256-GCM, HKDF, ECDH for Web Push) is `node:crypto`.
- **Client:** React and Vite, with hand-written CSS on design tokens rather
  than a UI framework, because the touch behaviour is the product.
- **Terminal:** `@lydell/node-pty`, which ships prebuilt binaries, as an
  optional dependency; the terminal feature turns itself off when it is absent.
- **Install scripts are disabled** (`.npmrc: ignore-scripts=true`). Nothing
  this project depends on needs them, and it removes the most common
  supply-chain execution path.

## Why
A self-hosted tool is installed on whatever machine its owner has. Requiring a
C++ toolchain, or a database server, turns a five-minute install into an
afternoon. Fewer dependencies also means a smaller surface to audit: the
security-critical parts (sessions, CSRF, password hashing, secret storage, Web
Push encryption, SSRF checks, path confinement) are a few hundred lines each in
`apps/server/src/kernel`, written against the standard library and tested
directly.

## Consequences
- `node:sqlite` is still marked as a release candidate by Node; the wrapper in
  `kernel/database.ts` is the only code that touches it.
- Synchronous SQLite calls block the event loop for their duration. Queries are
  indexed and small; anything heavy (full-text indexing of large notes) is
  chunked.
