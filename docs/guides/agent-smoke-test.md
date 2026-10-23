# Smoke tests against the real agent CLIs

The automated tests drive each coding agent through a stand-in executable
(`tests/fixtures/bin`) that speaks the same protocol as the real program. A
stand-in is only as good as the captures it was written from, so every adapter
is also checked by hand against the real CLI: when the adapter changes, and
when a new version of the CLI comes out. This guide says how, and records what
was observed each time.

One section per agent. Add a dated entry to "What was observed" whenever you
repeat a check.

## Claude Code

### What you need

- The `claude` program on `PATH`, signed in (`claude auth status` says so). The
  check uses that sign-in and spends its quota: four short turns on the
  smallest model (`haiku`), about 0.05 USD at list prices.
- Nothing else: the check starts its own temporary Studio (in-process, on a
  free port, with a temporary data directory) and works in a throw-away project
  under the system's temporary directory. It never touches a running Studio.
- Run **one** such check at a time, and nothing else heavy next to it: each
  turn is a full `claude` process.

### The check

```bash
STUDIO_CLAUDE_SMOKE=1 npx vitest run --project server-integration \
  apps/server/test/integration/claude-code-real.test.ts
```

Without `STUDIO_CLAUDE_SMOKE=1` the file is skipped, so it is safe in CI.
The other integration tests run with the stand-ins first on `PATH`
(`apps/server/test/setup.ts`); this file takes them off again for itself, and
its first step fails if the `claude` it finds is the stand-in after all.
Two optional variables:

- `STUDIO_CLAUDE_SMOKE_DIR=<folder>` keeps, per step, every line that went to
  and came from the CLI, plus `observations.txt`. The files contain the
  conversation and local paths: read them, do not commit them.
- `STUDIO_CLAUDE_SMOKE_SANDBOX=off` runs the CLI outside the sandbox. By
  default the check uses `auto`, which is bubblewrap where it works — the same
  as a production install.

It runs the real module through the real runtime and bridge, in one session:

| Step                              | What is sent                                                                                                          | What must happen                                                                                                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| status                            | (nothing; `--version`, `--help`, `auth status --json`)                                                                | installed, version read, signed in, no problem text                                                                                                                                                                                                                                                                     |
| (a) plain question                | a question, with a text file and a small red picture attached; the project has a `CLAUDE.md` asking for a marker line | the answer is streamed and stored once; it contains the code word from the file, the colour, `READY`, and the marker from `CLAUDE.md`; the file is read **without** an approval; only the `studio` MCP server is offered to the CLI                                                                                     |
| (b) (c) (d) approve, deny, resume | "write `smoke-note.txt` with the code word you read earlier, then `denied.txt`"                                       | the CLI is started with `--resume`; two approvals for `Write` arrive at the Studio; the first is allowed → the file exists and holds the code word (so the conversation really was resumed), with a diff; the second is denied → no file, the call is recorded as `denied` with the reason, and the turn still finishes |
| (f) steer                         | a long answer, and a second message steered into it while it streams (`whenBusy: "steer"`)                            | the receipt says `steered`; one run; the second message is answered in it                                                                                                                                                                                                                                               |
| (e) stop                          | a very long answer, stopped mid-stream                                                                                | the run ends as `stopped` within seconds, exactly one `run.finished`, the text streamed so far is kept, no `claude` or bridge process is left, the temporary MCP configuration file is gone                                                                                                                             |

The same by hand, in the product: create a project in an empty folder, start a
Claude Code session on the Haiku model, and send those four messages — attach
a text file and a picture to the first, answer the two approvals of the second
with allow and deny, send a second message into the running turn during the
third, and press stop during the fourth. Then look at `ps` for a leftover `claude`.

### The project's instruction file

The adapter starts the CLI with every settings file switched off (see the
table below for why), and with them the CLI stops loading `CLAUDE.md` by
itself. The Studio hands over the one file people expect to apply: `CLAUDE.md`
in the **root of the project folder**, appended to the CLI's system prompt
after the shared-memory conventions, in a block labelled as the project's own
instruction file. Nothing else is read: no `CLAUDE.local.md`, no `CLAUDE.md`
elsewhere, no settings file, nothing from the CLI's configuration directory.
A link that leads out of the project is not followed; a file over 48 KiB is
cut there; in both cases the conversation gets a notice. The project's owner
can switch it off: `PATCH /api/projects/:id` with
`{ "features": { "instructions": false } }`.

To see it by hand, with the stand-in and no quota: put a `CLAUDE.md` into a
project, send `[[scenario:system-prompt]]` in a Claude Code session, and the
stand-in answers with exactly what was appended to its system prompt.

With the real CLI the smoke check covers it since 2026-10-14: its throw-away
project holds a `CLAUDE.md` that asks for a marker line at the end of every
reply, and step (a) expects that marker. **This has not been run for real
yet** — the feature was added after the recorded run and checked only with the
stand-in and unit tests. Also unverified: the CLI's help says that it records
a conversation's system prompt at its first request and reuses it on resume
until the conversation is compacted (`--system-prompt-snapshot`), so an edit
to `CLAUDE.md` may reach a conversation that is already under way only later.

### Checks that cost nothing

A signed-out CLI never reaches a model, so these are free. Use an empty
directory as `HOME`; never point them at your real one.

```bash
probe=$(mktemp -d)
run() { env -i PATH="$PATH" HOME="$probe" LANG=C.UTF-8 "$@"; }

run claude auth status --json            # {"loggedIn": false, …}, exit code 1
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' |
  run claude -p --verbose --input-format stream-json --output-format stream-json
                                         # init, an assistant line with error "authentication_failed", result is_error
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}' |
  run claude -p --verbose --input-format stream-json --output-format stream-json \
      --resume 11111111-2222-4333-8444-555555555555
                                         # result "No conversation found with session ID: …", exit code 1
```

Whether settings files are really switched off can be seen the same way: put
`{"permissions":{"defaultMode":"acceptEdits"}}` into `$probe/.claude/settings.json`
and compare the `permissionMode` of the `init` line with and without
`--setting-sources ""` (`acceptEdits` against `default`).

### What was observed

#### Claude Code 2.1.283 — 2026-10-13 (UTC), Linux (WSL2), sandbox: bubblewrap

All steps passed: status, (a), (b), (c), (d), (e) and (f). Personal billing
observations are omitted from this public report.

- status: version `2.1.283`, signed in, account label present. Every start of
  the CLI on this machine, `auth status` included, takes about five seconds
  before it prints anything.
- (a) answer `PELICAN-7 / red / READY`; the model read both attachments by
  path with `Read` (no approval, thanks to `--add-dir`) and also had the
  picture inline; `mcp_servers` in the `init` line was exactly
  `[{name: "studio", status: "connected"}]`.
- (b) (c) (d) started with `--resume <id>`; approvals `Write smoke-note.txt` and
  `Write denied.txt`, both `kind: tool`, `toolKind: edit`, risk medium; after
  "allow" the file held the code word and the result carried a one-line patch;
  after "deny" the result was `denied` with the note as its text and the turn
  ended with `DONE`.
- (f) receipt `steered`. The answer had no tool call, so the CLI took the
  message after it: a second `init`, the echo of the message, its answer
  (`PINEAPPLE`) and a second `result` — in the same process and the same run.
- (e) the stop answered after 0.7 s. After the interrupt the CLI printed a
  `control_response`, the partial text as an `assistant` line marked
  `aborted: true`, `[Request interrupted by user]` and a `result` with
  `subtype: error_during_execution`, `terminal_reason: aborted_streaming`; it
  exited when its input was closed. No process and no configuration file were
  left.

Two things were changed **after** this run, from what it captured, and have
been tested only against the stand-in and unit tests built on the captured
lines — repeat the check when you next can:

- An `assistant` line marked `aborted: true` is no longer stored as a complete
  block; the streamed text is kept as partial instead. (In the run above the
  71 characters were stored with `partial: false`.)
- `modelUsage` and `total_cost_usd` in a `result` are totals of the whole
  conversation and keep growing across `--resume` (the second turn printed 44
  input tokens: 18 from the first turn and 26 of its own), while `usage` is
  that turn's, main thread only. The adapter now reports the difference to
  the previous result of the same conversation.

Before the adapter was written, six single calls to the CLI were made by hand
(with a throw-away MCP server in place of the bridge, logging what it was
asked) plus one with an unknown model. What they established:

| Question                                      | Observation                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does the permission prompt tool receive? | `tools/call` with arguments `{ tool_name, input, tool_use_id }` (and `_meta["claudecode/toolUseId"]`). The tool itself is hidden from the model.                                                                                                                                                                                                                                                                                          |
| What must it answer?                          | One text block holding JSON: `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`. The denial's message becomes the tool result (`is_error: true`, `tool_result_meta[].non_execution_kind: "permission-rule"`), the call is listed in the result's `permission_denials`, and the turn goes on.                                                                                                                |
| Do settings files bypass it?                  | Yes. With `--settings '{"permissions":{"allow":["Write"]}}'` a file was written and the prompt tool was **not** called. With `--setting-sources ""` and no rule the same request arrived at the prompt tool. With `--setting-sources project` the CLI said it ignored a project's allow rules only because the workspace "has not been trusted" — once trusted, they apply; a project's default mode applied even untrusted.              |
| What does `--setting-sources ""` cost?        | The CLI loads no `CLAUDE.md` (a marker instruction in it was followed with `project`, ignored with `""`), nor user-scope MCP servers, even without `--strict-mcp-config`. Hence the Studio hands the project's `CLAUDE.md` over itself — see "The project's instruction file".                                                                                                                                                            |
| The question tool                             | Prompt for `AskUserQuestion` with `input.questions[]` (`question`, `header`, `options[].label/description`, `multiSelect`). Answer: allow, with `updatedInput.answers = { "<question text>": "<label>" }`; the CLI then tells the model "Your questions have been answered: …".                                                                                                                                                           |
| The plan tool                                 | Prompt for `ExitPlanMode` with `input.plan` (and `planFilePath`). On allow the CLI prints a `system`/`status` line with `permissionMode: "default"` and carries the plan out, asking about each change. In plan mode it wrote its plan file under its own configuration directory without asking. The planning model can differ from the requested model.                                                                                 |
| What does the CLI not ask about?              | `pwd` in a shell (also inside a sub-agent), its tool lookup (`ToolSearch`), its to-do tools, and `Read` of files in an `--add-dir` folder. (Reads inside the project are documented to be treated the same; none was tried.) `mkdir` and `Write` were asked about.                                                                                                                                                                        |
| To-do list                                    | `TaskCreate {subject, description}` → result `task.id`; `TaskUpdate {taskId, status}`. There is no `TodoWrite` in this version.                                                                                                                                                                                                                                                                                                           |
| Sub-agents                                    | The tool is called `Agent`, runs in the background and returns at once (`tool_use_result.isAsync`). The sub-agent's blocks arrive as complete `assistant`/`user` lines with `parent_tool_use_id` (no stream events). The CLI ends the turn (`result`), and when the sub-agent reports (`system`/`task_notification`) starts a turn by itself: a second `init` and a second `result` in the same process, even after its input was closed. |
| A message written during a turn               | Echoed (`isReplay`) and taken at the next step boundary — after a tool result, inside the same turn — or, when the turn has no further step, as the next turn.                                                                                                                                                                                                                                                                            |
| Interrupt                                     | `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` on the input → `control_response` and the interrupted `result` within milliseconds. Sent before the first turn has started it does not cancel the prompt that follows.                                                                                                                                                                                      |
| Failures                                      | Signed out: assistant line with `error: "authentication_failed"`, result `is_error`, exit code 1. Unknown model: `error: "model_not_found"`, `api_error_status: 404`. Unknown conversation: result `errors: ["No conversation found with session ID: …"]`. Unknown option: no JSON at all, `error: unknown option '…'` on the error output.                                                                                               |
| Model names                                   | `default`, `fable`, `opus`, `sonnet`, `haiku` (and `opusplan`, `sonnet[1m]`) are resolved to full ids in the `init` line; anything else is passed on as written.                                                                                                                                                                                                                                                                          |
| Usage limits                                  | A `rate_limit_event` after the first model request of a process: `status`, `rateLimitType`, `resetsAt` (seconds), `unifiedWindows.five_hour` / `.seven_day` with `utilization` (0–1).                                                                                                                                                                                                                                                     |
| Inside the sandbox                            | Two signed-out copies at once under the kernel's `mask` profile both started; the second chose another name for its messaging socket by itself.                                                                                                                                                                                                                                                                                           |

Not seen with the real CLI, because they cannot be provoked cheaply — the
adapter handles them from the shapes in the public documentation, defensively:
a context compaction (`compact_boundary`), API retries (`api_retry`), a
reached usage limit (`error: "rate_limit"`, `rate_limit_event` with
`status: "rejected"`), a model that shares its reasoning (thinking deltas were
always empty here), the older `TodoWrite` tool, and a sub-agent that runs in
the foreground.

The probes left the CLI's own records behind, as any use of it does: its
transcripts of the throw-away projects and one plan file, in its configuration
directory. The Studio never writes there.

## Codex

The adapter drives `codex app-server`: the CLI's own interface for programs,
line-delimited JSON on its standard input and output. (`codex exec --json`
cannot ask anybody anything, so it cannot route an approval to the Studio.)
The CLI prints the protocol it speaks: `codex app-server generate-json-schema
--out <dir>`, or `generate-ts`.

### What you need

- The `codex` program on `PATH`, signed in (`codex login status` says "Logged
  in …" and exits with 0). The check uses that sign-in and spends its quota:
  six short turns, nine model requests. On the smallest model at low effort
  that is roughly 150,000 input tokens, two thirds of them cached, and a few
  hundred output tokens (an estimate from the 16,259 tokens the first request
  reported: nearly all of it is Codex's own instructions).
- Nothing else: the check starts its own temporary Studio (in-process, on a
  free port, data and project under the system's temporary directory). It
  never touches a running Studio, and it changes nothing in `~/.codex` except
  what the CLI itself keeps there (its record of the conversation).
- Run **one** such check at a time and nothing heavy next to it: every turn is
  a `codex` process (a small Node.js launcher plus the native program) and the
  Studio's MCP bridge.

### The check

```bash
STUDIO_CODEX_SMOKE=1 STUDIO_CODEX_SMOKE_MODEL=<a small model> STUDIO_CODEX_SMOKE_EFFORT=low \
  npx vitest run --project server-integration apps/server/test/integration/codex-real.test.ts
```

Without `STUDIO_CODEX_SMOKE=1` the file is skipped, so it is safe in CI. It
takes the stand-in directory off `PATH` for itself (every other integration
test has it first) and fails if the version it finds is the stand-in's.
Optional variables:

- `STUDIO_CODEX_SMOKE_MODEL`, `STUDIO_CODEX_SMOKE_EFFORT`: what to run the
  turns with. Take the names from `GET /api/agents/codex` (they come from the
  CLI's `model/list`); without them the CLI's default model is used.
- `STUDIO_CODEX_SMOKE_STEPS=b,c,e`: only those steps (`d` needs `a`).
- `STUDIO_CODEX_SMOKE_SANDBOX=off`: run without the Studio's sandbox (the
  check then also sets what `AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on` sets;
  without that Codex refuses to run unsandboxed). The default is `auto` —
  bubblewrap where it works, as in a production install.
- `STUDIO_CODEX_SMOKE_REPORT=<file>`: where to write what was seen (default
  `<tmpdir>/codex-smoke-report.json`). It holds event types, approval titles
  and short pieces of the answers: read it, do not commit it.
- `STUDIO_CODEX_SMOKE_HOME=<dir>`: a Codex home to use instead of the
  account's own — for rehearsing against a mock model, see below.

It runs the real module through the real runtime and bridge, in one session:

| Step               | What is sent                                                                               | What must happen                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| status             | (nothing; `--version`, `login status`, and `account/read` + `model/list` of an app-server) | installed, version read, signed in, an account label, no problem text, a model list                                                    |
| (a) plain question | "Reply with exactly the single word: pong"                                                 | the answer is stored once and says `pong`; usage is reported with the model's name                                                     |
| (d) resume         | "Which single word did you reply with just before?"                                        | a new process reopens the conversation (`thread/resume`); the answer is `pong`; no `resume_unavailable` notice                         |
| (b) approve        | "Create a file named smoke-approved.txt … containing exactly the word hello"               | an approval arrives at the Studio (a file change with a diff, or a command); it is allowed; the file exists                            |
| (c) deny           | "Create a file named smoke-denied.txt … If you are not allowed to, do not try another way" | an approval arrives; it is denied with a note; the tool call is recorded as `denied`; there is no file                                 |
| (f) Studio tool    | "Call the memory_search tool of the studio MCP server …"                                   | a tool call `mcp__studio__memory_search` that finishes `ok` — it went through the bridge                                               |
| (e) stop           | a 600-word story, stopped once 40 characters have streamed                                 | the run ends as `stopped`, exactly one `run.finished`, the text so far is kept as partial, and no process of this Studio's CLI is left |

The same by hand, in the product: create a project in an empty folder, start
a Codex session on a small model with permission mode "ask", and send those
six messages — allow the approval of the third, deny the fourth, press stop
during the last. Then look at `ps` for a leftover `codex app-server`.

The project's `agentCredentials` feature decides what an agent can read of
the account the Studio runs as. It is off unless the owner switches it on
(`PATCH /api/projects/:id { "features": { "agentCredentials": true } }`): the
account's SSH and GPG keys, cloud sign-ins, the GitHub CLI's token, `.netrc`,
`.npmrc`, Git credentials and the other agent's sign-in are then not there for
the CLI or anything it runs — so an approved `git push` over SSH or a `gh` call
fails inside a run — and with it on they are. To see it, put a file into
`~/.ssh` of the account and ask Codex to `cat` it with the feature off and on.
It needs the Studio's sandbox; the check above passes either way.

### Checks that cost nothing

```bash
codex --version                          # codex-cli 0.160.0
codex login status; echo $?              # "Logged in using ChatGPT" on the error stream, 0 — or "Not logged in", 1
codex app-server generate-json-schema --out "$(mktemp -d)"     # the protocol, as JSON Schema
codex debug prompt-input -c 'approval_policy="on-request"' -c 'sandbox_mode="read-only"' hello
                                         # what the model is told about the sandbox and about asking
codex app-server --ignore-user-config    # error: unexpected argument — the app-server has no such flag
```

An app-server answers `initialize`, `config/read`, `account/read`,
`model/list` and `thread/start` without calling a model. With an empty
directory as `CODEX_HOME` (never your real one) that is enough to see how
configuration is layered: write a `config.toml` into it, start `codex
app-server -c …` and read `config/read` with `includeLayers: true`.

The whole check can be rehearsed without an account: put a `config.toml` with
a `[model_providers.<name>]` whose `base_url` is a local server speaking the
public Responses API (streaming) into an empty directory, and run the check
with `STUDIO_CODEX_SMOKE_HOME=<that directory> STUDIO_CODEX_SMOKE_SANDBOX=off`.
The real program then does everything it really does — sandboxing, approval
requests, patches, the MCP bridge — with a scripted model. That is how most of
the table below was established, and how the adapter was run against the real
program before any quota was spent.

### What was observed

#### codex-cli 0.160.0 — 2026-10-13 (UTC), Linux (WSL2), sandbox: bubblewrap

Interface: `codex app-server` on standard input and output. Model:
`gpt-6-luna` at effort `low`. Nine turns in two runs.

First run, all six steps (19 seconds):

- status: version `0.160.0`, signed in, account label present, seven models
  with their reasoning efforts, default `gpt-6.1-sol`.
- (a) passed: `pong`; usage 5,246 input, 11,008 cached input and 5 output
  tokens, context 16,259 of 258,400.
- (d) passed: `pong` again, from a new process — the conversation was resumed.
- (f) passed: `mcp__studio__memory_search`, finished `ok`, inside the sandbox.
- (b) **failed**, and (c) with it: the model made no request at all. It
  answered in words (twice, in (b)), there was no patch and no command, and so
  nothing arrived at the Studio and no file was written. Codex tells its model
  "the sandbox only permits reading files"; the likeliest reading is that this
  model took that as the end of the matter.
- (e) failed for a dull reason: asked to count to 400 the model wrote 47
  characters and was finished before the stop arrived. The step now asks for a
  story.

The adapter was changed: the thread's developer instructions now begin with a
short text saying that the read-only sandbox is on purpose and how to ask
(`PERMISSIONS_GUIDE` in `modules/codex/adapter.ts`). Second run, steps b, c
and e (14 seconds), same model:

- (b) passed: the model said what it would do and sent a patch; the approval
  "Create smoke-approved.txt" (`apply_patch`, kind `edit`, with a diff, risk
  medium) arrived; after "allow" the file held `hello`.
- (c) passed: approval "Create smoke-denied.txt"; after "deny" the tool call
  was recorded as `denied`, the model answered "It was not allowed.", no file.
- (e) passed: stopped after 54 characters, which were kept as partial text;
  one `run.finished`; five processes carried the app-server's command line
  while it ran (bubblewrap's own, the launcher and the program) and none
  afterwards.

Steps (a), (d) and (f) were not repeated after that change. A _command_ that
asks to leave the sandbox was not provoked with the real model (it chose a
patch both times); that path was run with the real program and a scripted
model, see below.

What the real program showed while the adapter was being written (codex-cli
0.160.0, with a scripted model behind a throw-away `CODEX_HOME`, so without an
account; the same messages are what the stand-in in `tests/fixtures/codex` is
built from):

| Question                                                       | Observation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can the app-server be told to ignore the user's configuration? | No. `--ignore-user-config` and `--ignore-rules` exist only for `codex exec`. `-c key=value` overrides are merged into the user's tables (a user's MCP server stays), and are applied in order, each _setting_ its key: `-c mcp_servers={…}` after `-c mcp_servers.studio.command=…` removed the `studio` server.                                                                                                                                                                                                                                                                      |
| Does the user's configuration matter, then?                    | Yes. With `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, an MCP server and a trusted project in `config.toml`, a thread started without parameters had exactly those, and the MCP server was started. Parameters given to `thread/start` (`approvalPolicy`, `approvalsReviewer`, `sandbox`) won over the file.                                                                                                                                                                                                                                                   |
| Do saved command rules bypass an approval?                     | Yes. `prefix_rule(pattern=["touch"], decision="allow")` in `rules/default.rules` made `touch x` run outside the read-only sandbox with no request at all, under `on-request` and under `untrusted`. The same line in a trusted project's `.codex/rules/` did the same.                                                                                                                                                                                                                                                                                                                |
| What makes them go away?                                       | Inside bubblewrap: an empty _regular_ file bound over `config.toml` (the CLI refuses `/dev/null`: "is not a file") and an empty directory over `rules/`. Then `config/read` shows a user layer with no keys, the project layer is "disabled until the project is trusted", the MCP server is not started and `touch x` fails in the sandbox. The sign-in keeps working. Without bubblewrap: `-c projects={"<dir>" = {trust_level = "untrusted"}}` switches the project layer off and `-c mcp_servers={"<name>" = {enabled = false}}` a server; nothing switches the user's rules off. |
| Which instruction files does it load by itself?                | `AGENTS.md` of its home, or `AGENTS.override.md` there when that one has text in it (an empty override falls back to `AGENTS.md`; an empty file is not loaded at all), and the project's `AGENTS.md`. A new thread lists them under `instructionSources`.                                                                                                                                                                                                                                                                                                                             |
| Does Codex's own sandbox work inside the Studio's?             | Yes: under the kernel's `mask` profile plus one more bubblewrap layer, a command in the read-only sandbox still got "Read-only file system", an escalated one ran, and the data directory was empty for both except the one file exposed.                                                                                                                                                                                                                                                                                                                                             |
| When does Codex ask?                                           | `on-request`: a command runs in the sandbox unasked; one sent with `sandbox_permissions: "require_escalated"` produces `item/commandExecution/requestApproval` (`command` is the shell line, `/bin/bash -lc '…'`, `reason` the model's justification). A command the sandbox refused produces no item at all — the model just sees the failure. `untrusted` asks about every command, `ls` included, and what is approved runs outside the sandbox.                                                                                                                                   |
| What can be answered?                                          | `accept`, `decline` (the turn goes on; the model is told "rejected by user" and nothing more), `cancel` (the turn ends as `interrupted`). `decline` works although the request's `availableDecisions` does not list it.                                                                                                                                                                                                                                                                                                                                                               |
| File changes                                                   | An item `fileChange` with `changes[]` (`path` absolute, `kind`, `diff` — the content itself for a new file), then `item/fileChange/requestApproval` naming only the item. Allowed, the patch is applied outside the sandbox; declined, the model is told "patch rejected by user".                                                                                                                                                                                                                                                                                                    |
| MCP                                                            | `-c mcp_servers.<name>.env_vars=[…]` forwards variables from the app-server's environment to the server, so the bridge token never appears in a process list. Codex asks about a tool call with `mcpServer/elicitation/request` marked `_meta.codex_approval_kind: "mcp_tool_call"`; `default_tools_approval_mode="approve"` stops that for one server, `disabled_tools` hides a tool. Tools reach the model in a namespace `mcp__<server>`.                                                                                                                                          |
| Stop and steer                                                 | `turn/interrupt` answers `{}` and the turn completes as `interrupted` within milliseconds, a running command included. `turn/steer` with the turn's id is taken at the next model request; outside a turn it answers "no active turn to steer". Closing the input ends the process with code 0.                                                                                                                                                                                                                                                                                       |
| Resume                                                         | `thread/resume` in a new process continues the conversation and first repeats the previous turn's token usage. The developer instructions are those of the thread's creation; model and effort given with a turn apply. An unknown id answers "no rollout found for thread id …". `thread/inject_items` puts earlier messages into a new thread; `thread/delete` removes a conversation.                                                                                                                                                                                              |
| Images                                                         | A `localImage` in the turn's input reaches the model as an inline picture. Hidden by the sandbox and not exposed, it becomes the text "Codex could not read the local image at …".                                                                                                                                                                                                                                                                                                                                                                                                    |
| Failures                                                       | Signed out: `account/read` says `account: null`; a turn retries for about 15 seconds and fails with `httpConnectionFailed`, status 401. Usage limit: `codexErrorInfo: "usageLimitExceeded"` with a sentence that names the time. Unknown model: the service's JSON as the message (`model_not_found`). A dropped stream: five `error` notifications "Reconnecting… n/5" with `willRetry`, then failure.                                                                                                                                                                               |
| Questions and sub-agents                                       | The `request_user_input` tool answers "unavailable in Default mode". A sub-agent is a thread of its own on the same connection: its items, its approval requests and its `turn/completed` carry its thread id.                                                                                                                                                                                                                                                                                                                                                                        |

Not seen with the real program, because they could not be provoked cheaply —
the adapter handles them from the schema the CLI prints: `turn/plan/updated`,
a web search, `item/permissions/requestApproval` (answered with no
permissions), `item/tool/requestUserInput`, a network approval, a context
compaction, `model/rerouted`, `thread/name/updated`, and a usage limit reached
on a real account.

Worth knowing: every run leaves the CLI's own record of the conversation in
`~/.codex`, as any use of it does.

#### codex-cli 0.160.0 — 2026-10-14, the sandbox reworked (no paid turns)

The hidden level now uses the `hide` list of the kernel's `mask` profile — one
bubblewrap layer instead of two — and hides more: the Codex home's `AGENTS.md`
and `AGENTS.override.md` (the personal instructions of the account the Studio
runs as), and the account's credentials unless the project allows them.
Checked with the real program, a throw-away home and a scripted model, so
without an account:

- With the default (credentials hidden): the user layer of `config/read` had
  no keys although `config.toml` said `approval_policy = "never"`;
  `instructionSources` was empty and the model never saw the text of
  `AGENTS.md`; a command Codex ran **without asking** got "No such file or
  directory" for a key in `~/.ssh`, for the GitHub CLI's `hosts.yml` and for
  the Studio's database, an empty `.netrc`, an empty `rules/`, and "Read-only
  file system" for `touch` although a saved rule allowed `touch`.
- With credentials allowed: the same command read the key, `hosts.yml` and
  `.netrc`; everything else as before.

Without the sandbox Codex no longer runs unless the operator set
`AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on`; then every conversation begins with a
notice that files outside the project, credentials included, are readable.
