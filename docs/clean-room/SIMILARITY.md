# Code similarity audit

As part of the release checklist, this code base was compared mechanically with
the private predecessor system it was modelled on (which is itself derived from
CloudCLI UI). The tool is `scripts/similarity-audit.mjs`; it reads both trees
and reports figures and locations in **this** tree only — it never prints the
other tree's content, so running it does not carry any of that code across.

What it measures, from coarse to strict:

1. **Identical significant lines** — after whitespace normalisation, ignoring
   imports, lines shorter than 30 characters and punctuation-only lines.
   Isolated identical lines are normal between any two TypeScript projects
   that use the same libraries (`const timer = setTimeout(() => {`).
2. **Shared windows of six consecutive significant lines** — the usual
   signature of copy-and-paste.
3. **Per-file overlap** — for each file here, the share of its three-line
   windows that appear in any single file there.
4. **Distinctive identifiers** — names of at least fourteen characters
   declared here that also occur there.

## Result

Latest run: 2026-10-14, on the release candidate.

| Measure | Result |
|---|---|
| Files compared | 717 here, 1,496 there |
| Significant lines | 83,510 unique here, 143,672 there |
| Identical significant lines | 375 — **0.45 %** of this code base |
| Regions sharing six or more consecutive lines | **0** |
| Files here with any three-line window found in a file there | **0** |
| Files here with ≥ 10 % three-line overlap with one file there | **0** |
| Distinctive identifiers declared here that occur there | 87 of 2,334 |

The identical lines are idioms (timers, standard HTML meta tags, `if
(typeof value === 'string') return value;`). The shared identifiers are names
any implementation of the same standards or libraries would use —
`attestationObject`, `clientDataJSON` and `authenticatorData` (WebAuthn),
`IncomingMessage` (Node.js), `permissionMode`, `retryAfterSeconds`,
`DEFAULT_TIMEOUT_MS` — and were reviewed one by one.

## What this does and does not show

It shows that no code was copied in any recognisable form: not a single
stretch of three consecutive significant lines matches. It does not prove
that no idea, structure or behaviour was derived from the predecessor — the
requirements were derived from its behaviour on purpose, and the limits of the
process that kept implementation details out are described in
[PROCESS.md](PROCESS.md).
