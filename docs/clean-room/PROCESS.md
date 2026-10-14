# How this project was kept independent

Agent Cloud Studio 2.0 is a new implementation of the *ideas* in a private,
AGPL-licensed system (itself a modified copy of CloudCLI UI,
`siteboon/claudecodeui`). Functionality is not protected by copyright; source
code is. The process below was designed so that functionality crossed over and
code did not. This document also records, honestly, where that process fell
short of a strict clean room.

## The two groups

**Group A — product analysis.** Read-only access to the existing system. Wrote
requirement documents and black-box acceptance tests
(`docs/requirements/`). Their brief forbade: source code, pseudo-code that
mirrors an implementation, identifiers (function, file, table, route and
variable names), descriptions of internal architecture, verbatim comments or
distinctive UI copy, secrets and real user data. Each analyst re-read their
document against that list before handing it over, and the documents were
scanned mechanically for code fences, path-like strings, route paths,
environment-variable names and personal data before they entered this
repository.

**Group B — development.** Worked only in this repository. Inputs: the
requirement documents, the public documentation and `--help` output of the
tools being integrated (Claude Code CLI, Codex CLI, GitHub CLI, git), the
installed type definitions of this project's own open-source dependencies, and
general engineering knowledge. Their brief forbade opening the existing
system's directory, CloudCLI UI's source (on disk, on GitHub or in npm), and
any shared notes describing the old implementation.

**A third role — audit.** After development, a separate pass compared the two
code bases mechanically (token-level duplicate detection and distinctive-string
search) and reported similarity figures only. See
`docs/clean-room/SIMILARITY.md`.

## What was not strict

This was AI-assisted development, coordinated by one orchestrating AI agent.
The following limitations are real and a reader should weigh them:

1. **Isolation was by instruction, not by the operating system.** Both groups
   were AI sub-agents running as the same OS user on the same machine. The
   development agents were told not to read the old system and had no reason
   to, but nothing technically prevented it. Their behaviour was checked after
   the fact by the similarity audit, not prevented before it.
2. **The orchestrator bridged both groups.** It briefed Group A, read Group A's
   documents, designed the architecture and briefed Group B. It did not read
   the old system's source. It did see: the old repository's licence and notice
   files, one section of its contributor instructions (repository identity
   rules), a handful of file paths that appeared in tool output listing other
   people's uncommitted work, two function names mentioned in the operator's
   notes, and the titles of five recent commits. It also ran the similarity
   tool, which reads both trees but prints only locations in this one.
3. **The requirement documents are detailed.** They were written to be
   buildable, and include observed limits and timings. They describe behaviour,
   not code, but they are far more specific than a marketing description.
4. **Models have priors.** The language models used may have seen CloudCLI UI's
   public source during training. No prompt asked them to recall it, and the
   similarity audit is the check on whether any of it surfaced.
5. **Small departures from the analysts' read-only brief**, all disclosed by
   the analysts themselves and none of which changed the old system: two ran a
   read-only `git status` in the old checkout; one briefly created and deleted
   a scratch file in `/tmp`; helpers of one ran a read-only one-line script to
   print locale files; one made a single read-only search of the owner's notes
   (it returned nothing).
6. **Analysts' raw documents named the owner's private integrations.** Those
   rows were removed mechanically before the documents were published here;
   the raw versions were kept outside this repository and away from the
   development group.
7. **The published history was edited once.** Early drafts of the
   requirement documents described how the still-running predecessor behaves
   where security is concerned. Before this repository was made public, its
   history was rewritten so that every commit carries the documents as
   published (no code changed); the earlier drafts are kept privately by the
   owner.

Because of points 1 and 2 this project does not claim to be a strict
clean-room implementation in the legal sense. It claims that it was written
from requirements by agents instructed not to consult the original, that its
architecture, data model, wire protocol and visual design are its own, and
that a mechanical comparison found no copied code.

## What is deliberately different

The design is not a translation of the old one. Among other things it has its
own: module system and composition root; database schema and migration scheme;
REST surface and realtime protocol (topic subscriptions with sequence-numbered
replay); authentication model (server-side sessions in HttpOnly cookies with
anti-forgery tokens, a one-time setup token, roles, scoped API tokens);
permission engine and sandbox; agent adapter contract; and component library
and visual language.
