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
Two optional variables:

- `STUDIO_CLAUDE_SMOKE_DIR=<folder>` keeps, per step, every line that went to
  and came from the CLI, plus `observations.txt`. The files contain the
  conversation and local paths: read them, do not commit them.
- `STUDIO_CLAUDE_SMOKE_SANDBOX=off` runs the CLI outside the sandbox. By
  default the check uses `auto`, which is bubblewrap where it works — the same
  as a production install.

It runs the real module through the real runtime and bridge, in one session:

| Step | What is sent | What must happen |
|---|---|---|
| status | (nothing; `--version`, `--help`, `auth status --json`) | installed, version read, signed in, no problem text |
| (a) plain question | a question, with a text file and a small red picture attached | the answer is streamed and stored once; it contains the code word from the file, the colour, and `READY`; the file is read **without** an approval; only the `studio` MCP server is offered to the CLI |
| (b) (c) (d) approve, deny, resume | "write `smoke-note.txt` with the code word you read earlier, then `denied.txt`" | the CLI is started with `--resume`; two approvals for `Write` arrive at the Studio; the first is allowed → the file exists and holds the code word (so the conversation really was resumed), with a diff; the second is denied → no file, the call is recorded as `denied` with the reason, and the turn still finishes |
| (f) steer | a long answer, and a second message steered into it while it streams (`whenBusy: "steer"`) | the receipt says `steered`; one run; the second message is answered in it |
| (e) stop | a very long answer, stopped mid-stream | the run ends as `stopped` within seconds, exactly one `run.finished`, the text streamed so far is kept, no `claude` or bridge process is left, the temporary MCP configuration file is gone |

The same by hand, in the product: create a project in an empty folder, start a
Claude Code session on the Haiku model, and send those four messages — attach
a text file and a picture to the first, answer the two approvals of the second
with allow and deny, send a second message into the running turn during the
third, and press stop during the fourth. Then look at `ps` for a leftover `claude`.

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

All steps passed: status, (a), (b), (c), (d), (e) and (f). The run took 50
seconds; the conversation's own total was 0.042 USD.

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

| Question | Observation |
|---|---|
| What does the permission prompt tool receive? | `tools/call` with arguments `{ tool_name, input, tool_use_id }` (and `_meta["claudecode/toolUseId"]`). The tool itself is hidden from the model. |
| What must it answer? | One text block holding JSON: `{"behavior":"allow","updatedInput":{…}}` or `{"behavior":"deny","message":"…"}`. The denial's message becomes the tool result (`is_error: true`, `tool_result_meta[].non_execution_kind: "permission-rule"`), the call is listed in the result's `permission_denials`, and the turn goes on. |
| Do settings files bypass it? | Yes. With `--settings '{"permissions":{"allow":["Write"]}}'` a file was written and the prompt tool was **not** called. With `--setting-sources ""` and no rule the same request arrived at the prompt tool. With `--setting-sources project` the CLI said it ignored a project's allow rules only because the workspace "has not been trusted" — once trusted, they apply; a project's default mode applied even untrusted. |
| What does `--setting-sources ""` cost? | `CLAUDE.md` is not loaded (a marker instruction in it was followed with `project`, ignored with `""`), nor are user-scope MCP servers, even without `--strict-mcp-config`. |
| The question tool | Prompt for `AskUserQuestion` with `input.questions[]` (`question`, `header`, `options[].label/description`, `multiSelect`). Answer: allow, with `updatedInput.answers = { "<question text>": "<label>" }`; the CLI then tells the model "Your questions have been answered: …". |
| The plan tool | Prompt for `ExitPlanMode` with `input.plan` (and `planFilePath`). On allow the CLI prints a `system`/`status` line with `permissionMode: "default"` and carries the plan out, asking about each change. In plan mode it wrote its plan file under its own configuration directory without asking. With `--model haiku` it planned on a larger model, which made this the most expensive probe (0.17 USD). |
| What does the CLI not ask about? | `pwd` in a shell (also inside a sub-agent), its tool lookup (`ToolSearch`), its to-do tools, and `Read` of files in an `--add-dir` folder. (Reads inside the project are documented to be treated the same; none was tried.) `mkdir` and `Write` were asked about. |
| To-do list | `TaskCreate {subject, description}` → result `task.id`; `TaskUpdate {taskId, status}`. There is no `TodoWrite` in this version. |
| Sub-agents | The tool is called `Agent`, runs in the background and returns at once (`tool_use_result.isAsync`). The sub-agent's blocks arrive as complete `assistant`/`user` lines with `parent_tool_use_id` (no stream events). The CLI ends the turn (`result`), and when the sub-agent reports (`system`/`task_notification`) starts a turn by itself: a second `init` and a second `result` in the same process, even after its input was closed. |
| A message written during a turn | Echoed (`isReplay`) and taken at the next step boundary — after a tool result, inside the same turn — or, when the turn has no further step, as the next turn. |
| Interrupt | `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"}}` on the input → `control_response` and the interrupted `result` within milliseconds. Sent before the first turn has started it does not cancel the prompt that follows. |
| Failures | Signed out: assistant line with `error: "authentication_failed"`, result `is_error`, exit code 1. Unknown model: `error: "model_not_found"`, `api_error_status: 404`. Unknown conversation: result `errors: ["No conversation found with session ID: …"]`. Unknown option: no JSON at all, `error: unknown option '…'` on the error output. |
| Model names | `default`, `fable`, `opus`, `sonnet`, `haiku` (and `opusplan`, `sonnet[1m]`) are resolved to full ids in the `init` line; anything else is passed on as written. |
| Usage limits | A `rate_limit_event` after the first model request of a process: `status`, `rateLimitType`, `resetsAt` (seconds), `unifiedWindows.five_hour` / `.seven_day` with `utilization` (0–1). |
| Inside the sandbox | Two signed-out copies at once under the kernel's `mask` profile both started; the second chose another name for its messaging socket by itself. |

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
