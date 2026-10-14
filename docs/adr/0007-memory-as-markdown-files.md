# ADR 0007 — Shared memory is Markdown files with an index, and scope comes from the run

**Status:** accepted

## Decision
- A note is a plain Markdown file under `<data dir>/memory/<folder>/…` with a
  small front-matter block. The files are the source of truth; a SQLite FTS5
  index (trigram tokenizer, so text without word spacing is searchable) is a
  cache that is rebuilt from them. People can read, edit, back up and version
  their memory with ordinary tools, and hand edits are picked up.
- One folder per project plus `global`. A person sees `global` and the folders
  of projects they can access. **An agent run sees its own project's folder and
  `global`, decided from the run's identity on the server** — no tool takes a
  folder path, so a model cannot ask for another project's notes.
- Every agent uses the same tools: CLI agents through the MCP bridge, API
  models through function calling.
- Note content is untrusted. It reaches a model inside delimiters it cannot
  forge, labelled as reference material. Notes that look like they hold a
  credential are refused on write and withheld from models on read. An agent
  may overwrite only notes it wrote.

## Why not a database or an external memory service
Notes are the user's knowledge; they should outlive this program and be
legible without it. A separate service would add a process to run, a protocol
to trust and a second place where access rules could drift from the project
rules.

## Consequences
Renaming a note changes its id (the id is its path). Credential detection is a
heuristic and can refuse a long random identifier.
