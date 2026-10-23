# Agents and approvals

An agent in Cloud Harness can read your files, change them and run
commands on your server. This guide explains how the Studio decides what an
agent may do by itself, what it has to ask you about, and what it may never
do — for each kind of agent. It also says plainly where those controls stop.

The short version:

- Every tool request of every agent goes to **one permission engine on the
  server**. Hiding a button in the app is never the control.
- A conversation has a **permission mode**: Plan, Ask, Accept edits or Auto.
- A request that needs a person becomes an **approval**. It waits for at most
  30 minutes and is then denied.
- Outside Auto, requests the engine classes as **dangerous** are always asked
  about, even when a rule would allow them. Only the owner may allow them, and
  they are never remembered.
- On Linux with bubblewrap, agents run in a **sandbox** that hides the Studio's
  own data and, unless a project allows it, the account's credentials. It does
  not stop an approved command from changing other files.

## How a request is decided

The engine looks at the request (which tool, which command, which files, which
address), the conversation's mode, your rules and a few facts about the
project. It answers in this order; the first step that applies wins.

1. **The hard-deny list** refuses, in every mode: anything that touches the
   Studio's own data directory, recursively removing the file-system root, a
   system folder or a home directory, writing to a raw disk device, and a fork
   bomb.
2. **A deny rule** that matches refuses. Deny rules always win.
3. **Plan mode** refuses everything that is not reading or searching.
4. **An ask rule** that matches asks.
5. **A dangerous request** asks, even when an allow rule matches — in every mode
   except Auto.
6. **Auto mode** (only where the project's owner allowed it) allows.
7. **Reading and searching inside the project** is allowed. In Accept edits,
   **file edits inside the project** are allowed too.
8. **An allow rule** allows. For a command line, every part of it must be
   covered by a rule, and nothing about it may be unclear.
9. **Everything else asks.** A tool the Studio does not know asks. When the
   engine cannot read a command with confidence, it asks.

A request is **dangerous** when the classifier finds one of these. The app
shows the reason in words on the approval:

| Category              | Shown as                               | Examples                                                                                  |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| destructive           | "Deletes or overwrites work"           | `rm -r`, `git reset --hard`, `git push --force`, `git clean`, disk tools                  |
| privilege             | "Changes who a command runs as"        | `sudo`, `su`, `chown root`, set-user-id bits                                              |
| download-exec         | "Downloads something and runs it"      | `curl … \| sh`                                                                            |
| outside-project       | "Reaches outside the project"          | writing a file outside the project folder, running a command in another folder            |
| credentials           | "Touches credentials"                  | `~/.ssh`, `~/.aws`, `.env` files, private keys, `~/.netrc`, the agents' own sign-in files |
| recursive-permissions | "Changes permissions of whole folders" | `chmod -R`, `chown -R`                                                                    |
| obfuscated            | "Hides what it really does"            | `eval`, running code produced by another command, setting `PATH` or `LD_PRELOAD`          |
| studio-data           | "Touches the Studio's own data"        | anything in the data directory (always refused)                                           |
| catastrophic          | "Could destroy the system"             | wiping `/` or a home directory, overwriting a disk (always refused)                       |

The classifier reads shell commands conservatively and asks when unsure. It is
still a heuristic: see [The limits](#the-limits).

## The permission modes

You choose the mode per conversation with the **Permissions** button in the
title bar ("What the agent may do without asking"). Shift+Tab in the message
field steps through the modes, never onto Auto.

|                                    | Plan                            | Ask              | Accept edits     | Auto    |
| ---------------------------------- | ------------------------------- | ---------------- | ---------------- | ------- |
| Read and search inside the project | yes                             | yes              | yes              | yes     |
| Read outside the project           | asks                            | asks             | asks             | yes     |
| Change files inside the project    | refused                         | asks             | **yes**          | yes     |
| Change files outside the project   | refused                         | asks (dangerous) | asks (dangerous) | yes     |
| Run a command                      | refused                         | asks             | asks             | yes     |
| Use the network                    | refused                         | asks             | asks             | yes     |
| Start a sub-agent (Claude Code)    | refused                         | asks             | asks             | yes     |
| Write to shared memory             | refused                         | asks             | asks             | yes     |
| Dangerous requests                 | refused (a dangerous read asks) | ask, owner only  | ask, owner only  | yes     |
| Hard-deny list, deny rules         | refused                         | refused          | refused          | refused |
| Ask rules                          | ask (reads)                     | ask              | ask              | ask     |

"Asks" means: unless one of your allow rules covers it. A command is never
allowed just because it only reads; in Ask and Accept edits a command needs a
person or a rule, whatever it is.

What each mode is for:

- **Plan** — "Reads and searches only. It proposes a plan and changes nothing
  until you approve it." Use it to have an agent look around first.
- **Ask** — "Reads inside the project freely. Asks before every edit, command
  or network access." The default, and the right mode for most work.
- **Accept edits** — "Edits files in the project without asking. Still asks
  before commands and network access."
- **Auto** — "Runs everything without asking, except what a rule or the
  built-in deny list forbids." That includes requests the classifier calls
  dangerous: they run, and each one is written to the security log. Auto works
  only in a project whose owner has switched **Auto permission mode** on; in
  any other project a conversation set to Auto runs as Ask, and the button
  says so.

Only a signed-in browser can choose Accept edits or Auto. An API token may
choose Plan or Ask — for a new conversation, a message, a scheduled message,
an automation, a multi-agent task or a handoff — and is refused
(`session_required`) for the looser modes: whoever runs a script with a token
should not be able to take the person who answers the questions out of the
loop.

### Claude Code

- The Studio starts the official `claude` CLI for each turn and routes every
  permission prompt of the CLI to the engine (its `--permission-prompt-tool`
  points at the Studio). The CLI itself runs in its plan mode when the
  conversation is in Plan, and in its ordinary asking mode otherwise; the
  Studio never passes an option that makes the CLI skip prompts. Ask, Accept
  edits and Auto differ only in what the engine answers.
- **Your Claude Code settings are switched off** for Studio runs: no
  `~/.claude/settings.json`, no project `.claude/settings.json` or
  `.claude/settings.local.json`, no MCP servers except the Studio's own. Those
  files can hold allow rules, a default mode and hooks that would let the CLI
  act without asking. Settings an administrator manages for the whole machine
  still apply.
- **The project's `CLAUDE.md`** — only the one in the root of the project
  folder — is appended to the CLI's system prompt in a labelled block, after
  the shared-memory conventions. A link that leads out of the project is not
  followed; at most 48 KiB is used; the conversation gets a notice when the
  file was cut or could not be used. The owner can switch this off per project
  (**Project instructions**). It is text for the model: it cannot allow a tool
  or change a mode. An edit to `CLAUDE.md` may reach a conversation already
  under way only later (not verified with the real CLI); a new conversation
  always gets the current file.
- **What the CLI decides by itself.** Seen with Claude Code 2.1.283: reading
  the files attached to a message, a shell command it classes as read-only
  (`pwd`), its tool search and to-do tools, and, in plan mode, writing its own
  plan file in its configuration directory. These never reach the engine.
  Everything else that was tried did.
- **Plans and questions.** When Claude Code finishes a plan, you get a plan
  approval (below). When it asks you a question with options, you get a
  question in place of the message field.
- Tool names, for rules: `Bash`, `Read`, `Edit`, `MultiEdit`, `Write`,
  `NotebookEdit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, and `Task` or
  `Agent` for sub-agents.

### Codex

- The Studio drives `codex app-server` and starts every thread and turn with
  Codex's own approval policy `on-request`, approvals going to the Studio, and
  Codex's **read-only sandbox**, in all four modes. The Studio checks that
  Codex took those settings and refuses to run otherwise.
- **Commands that run inside Codex's read-only sandbox are not put to the
  engine.** Codex runs them without asking anybody. They can change nothing and
  have no network, but they can read. What they can read is decided by the
  Studio's sandbox (next section): not the Studio's data, and not the
  account's credentials unless the project allows agents to use them. This is
  why Codex does not run without the sandbox by default.
- Everything else reaches the engine: every file change (`apply_patch`, with a
  diff), every command that needs to write, use the network or leave the
  sandbox (`shell`), network access (`network_access`), and tool calls of MCP
  servers (`mcp__<server>__<tool>`). The Studio never answers "for the
  session" on Codex's behalf and grants no wider sandbox.
- **Your Codex settings are hidden** when the sandbox is on: `config.toml`,
  `hooks.json`, the `rules/` folder and the personal `AGENTS.md` /
  `AGENTS.override.md` in the Codex home are replaced by empty ones. Saved
  command rules there would otherwise run commands with no approval at all. A
  project's own `AGENTS.md` is read by Codex itself; the Studio's **Project
  instructions** switch does not affect it.
- **Plan mode** refuses every change; Codex is told to describe its plan
  instead. There is no plan approval for Codex: switch the mode yourself when
  you want the work done.

### API models

- An API model gets tools only if its catalogue entry says it can call them
  (`tools: true`): `read_file`, `list_directory`, `find_files`, `search_text`,
  and — when you may change the project — `write_file`, `edit_file` and
  `run_command`. It also gets the shared-memory tools.
- **Every tool call goes through the engine.** The file tools only reach paths
  inside the project (after following links); Git's own files (`.git`) and the
  Studio's data are closed to them whatever the engine says.
- **Commands** run in the sandbox's strictest profile: the file system is
  read-only except the project folder, `/tmp` is private, credential folders
  and the Studio's data are hidden, and there is **no network** unless the
  model asked for it. Network access is a separate request
  (`run_command_network`) that is decided on its own, so you can allow a
  command and refuse it the network.
- **Plan mode** refuses the changing tools; the model is told it is planning.
  There is no plan approval for API models.
- Limits per turn: 30 rounds of tool calls, 80 tool calls, 20 minutes of
  working time (waiting for you does not count); a command stops after 120
  seconds unless the model asks for longer, at most 600.
- Without the sandbox, see [Without bubblewrap](#without-bubblewrap).

### The Studio's own tools

Shared-memory tools (`memory_search`, `memory_read`, `memory_list`,
`memory_write`, `memory_edit`, `memory_move`, `memory_delete`) are the same for
every agent. Reading tools are not put to the engine. The four that change
something are: in Ask and Accept edits each call asks, unless you saved a rule
for it; in Plan they are refused. See
[Shared memory](memory-automation-notifications.md#shared-memory).

## What an approval shows

When the engine asks, a permission request appears at the bottom of the
conversation. It says who wants what — "Claude Code wants to run a
command", "Codex wants to change a file", "… wants to use the network" — and:

- the exact command, the files involved (the first three, then "and 3 more"),
  and a preview of the change for edits;
- a red **Dangerous** banner with the reasons, when the request is dangerous;
- one sentence saying why the Studio is asking, for example "This changes
  something, so it needs your approval.";
- a countdown: "Denied automatically in 29:41".

**Show everything about this request** opens the full view: every file, the
tool's arguments, the rule that "Allow and remember" would save, and a
**Note for the agent** field.

Your choices:

- **Allow** — once. For a dangerous request the button reads **Allow once**.
- **Deny** — the agent is told it was refused, and the tool call is shown as
  "Denied". With a note, the button reads **Deny with this note** and the agent
  is told your note instead.
- **Allow and remember** — allow, and save a rule so the same kind of request
  is not asked again: **For this conversation**, **For this project** or
  **Always**.

Where you see it: in the conversation; as "Needs you" on the conversation in
the list and on the Workbench tile; in the inbox; and as a notification if you
switched those on. You answer in the conversation, from a signed-in browser —
an API token cannot answer approvals, and nothing in the inbox or in a
notification approves anything; they take you to the conversation.

The first answer wins. If another device or the owner answered first, you see
"That request had already been answered." If nobody answers within 30 minutes,
the request is denied ("Nobody answered in time, so it was denied") and the
agent carries on without it. Stopping the run withdraws its open requests.

## "Allow and remember"

Remembering saves an allow rule in your name. You find your rules under
**Settings → Agent permissions**, grouped as Always allow, Always ask and Always
deny, and you can remove them there or add your own (**Add rule**: what the rule
does, the tool, what it acts on, and where it applies — everywhere or in one
project).

What gets saved:

- For a command, the program — with its sub-command for tools such as `git`,
  `npm`, `cargo` or `docker` — followed by ` *`: `Bash(pytest *)`,
  `Bash(npm test *)`, `Bash(git status *)`; for `npm run`, `pnpm run`,
  `docker compose` and similar, the script or second sub-command too:
  `Bash(npm run build *)`. A trailing ` *` also covers the command with no
  arguments. A line with several commands, a redirection or a variable
  assignment is saved exactly as it was.
- For anything else, the whole tool: `Edit`, `Write`, `memory_write`. That
  covers every non-dangerous use of that tool in the scope you chose.
- **For this conversation** applies in this conversation only; **For this
  project** in this project; **Always** in all your projects.

The same tap also answers every other request that is waiting for you and that
the new rule covers.

Its limits:

- **Dangerous requests are never remembered** — allow them once.
- Nothing is remembered when the engine could not read the command with
  confidence, for a plan or a question, or for a request that must be put to a
  person each time (shell lines of API models on a server without a sandbox).
- **Only the person whose run is asking** can remember. When the owner answers
  a member's request, the owner can allow once but not save a rule for the
  member.
- Rules apply to your own runs only. Each person has their own rules; at most 500.
- An allow rule never beats a deny rule, never stops a dangerous request from
  being asked, and covers a command part that writes to a file by redirection
  (`> out.txt`) only in Accept edits.
- The owner can add a rule **for everyone** in a project, but only one that
  denies or asks, and only through the API (`POST /api/permission-rules` with
  `"shared": true`). The rules page lists such rules as "For everyone".

## Dangerous requests, and who may approve them

Who may answer a request: the person whose run is asking, and the owner of the
Studio. Others do not see it.

A dangerous request may be **allowed only by the owner**. When a member's agent
asks for something dangerous, the member sees "Only the owner of this Studio can
allow a dangerous request. It is waiting for them; you can still deny it." The
owners are told as well (the inbox marks it "only an owner can decide"). If no
owner answers within 30 minutes, it is denied.

Every dangerous request that was decided — allowed or denied by a person,
denied by expiry, a deny rule or the hard-deny list, or allowed by Auto — is
written to the security log.

## Plans, and continuing in a chosen mode

Plan approvals come from **Claude Code** only. When it has a plan, you see
"Claude Code has a plan — Nothing changes until you approve it." with:

- **Approve and run** — the conversation leaves Plan and continues in **Ask**.
  (If the conversation was not in Plan — the agent chose to plan by itself —
  it keeps its mode.)
- **Approve and continue in…** — choose the mode it continues in: Ask,
  Accept edits, or Auto where the project allows it.
- **Keep revising** — type what should change ("What should change?"), or
  leave it empty to ask for another pass, then **Send back**.

**Read the whole plan** opens the full plan. The mode changes in the same step
as the approval, so the agent's next request is already judged by the new
mode. A plan nobody answers within 30 minutes counts as not approved: the
agent is told so, and the conversation stays in Plan.

Questions work alike: Claude Code's questions appear one at a time in place of
the message field, with the agent's options (one may be marked
**Recommended**), **Other** for your own answer, and **Skip** / **Skip all**.
If nobody answers within 30 minutes, the options the agent marked as
recommended are taken; with none, the choice is left to the agent.

## Unattended runs

A run that nobody is watching — one started by an **automation** — is
**unattended**. Where an attended run would ask, an unattended run is
**denied**:

- a tool request that would need approval is refused, and the transcript says
  "Nobody is watching this run, so … was denied instead of waiting for
  approval.";
- a plan is not put up for approval;
- a question is left to the agent.

The automation's history then records the run as **Refused**: "The agent
needed approvals nobody was there to give." It never waits and never proceeds
on its own.

An automation's agent run may use Plan or Ask in any project where automations
are on (Ask then means "do what needs no approval, and report what was
denied"). It may use Accept edits or Auto only in a project whose owner has
switched Auto permission mode on. It acts as the person who created it, and is
refused if that person has lost write access or their account is disabled.

Messages you schedule with **send later** are different: they run like a
message typed at that moment and **wait** for approval like one. See
[Memory, automation and notifications](memory-automation-notifications.md#send-later).

## The per-project switches

The owner sets these on the project's page (**Settings and sharing**, under
"What this project allows"). They apply to everyone who uses the project.

| Switch                                    | Default | What it does                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversations with agents                 | on      | Off: no conversation can be started or continued in the project; its files and Git stay reachable.                                                                                                                                                                                                                     |
| Unattended runs                           | off     | On: automations may run here, and messages can be scheduled with send later.                                                                                                                                                                                                                                           |
| Project instructions                      | on      | On: Claude Code gets the project's `CLAUDE.md` at the start of each conversation.                                                                                                                                                                                                                                      |
| Agents may use this machine's credentials | off     | On: agents can read and use the account's SSH and GPG keys, cloud and container sign-ins, the GitHub CLI's token, `.netrc`, `.npmrc` and Git credentials, and the other agent's sign-in. Needed for an agent to `git push` over SSH or to use `gh`. Asks for confirmation. Has an effect only where the sandbox is on. |
| Auto permission mode                      | off     | On: conversations here may really use Auto. Asks for confirmation.                                                                                                                                                                                                                                                     |

Also on that page, **Agents offered here** switches agents on or off for the
project. An agent switched off cannot start a conversation there.

With **Agents may use this machine's credentials** off, a command that needs
those credentials fails inside an agent run even when you approved it. Push
from the Git panel or the terminal instead, which use the account's own
credentials. Turn it on only for projects whose contents you trust: a prompt
hidden in a file or a web page could make an agent send the credentials
elsewhere.

## What the sandbox does

The Studio uses bubblewrap, where it works, to start agent processes in a
mount and process namespace of their own. **Settings → About** shows
"Agent sandbox: On" or "Off" and, when off, the reason.

For **Claude Code and Codex**:

- The Studio's data directory is an empty folder. The database, the key file
  that protects stored credentials, memory files, attachments and everything
  else in it cannot be read or changed. (The files attached to a message are
  let back in, read-only.)
- Unless the project allows agents to use the machine's credentials, these are
  hidden: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`,
  `~/.config/gh`, `~/.config/gcloud`, `~/.netrc`, `~/.npmrc`,
  `~/.git-credentials`, and the other agent's sign-in (`~/.claude`,
  `~/.claude.json` or `~/.codex`). Each agent keeps its own configuration
  directory, which holds its sign-in.
- Processes an agent starts in the background end with its run.
- Everything else is as the service account sees it: an approved command can
  read and write any other file the account can, and use the network.

The agents' sign-in terminals run with the Studio's data hidden in the same
way.

For **API models' commands**, the stricter profile described above: read-only
except the project, credentials hidden, no network unless allowed.

What the sandbox does **not** do:

- It does not stop an approved (or Auto-mode) command from changing files
  outside the project that the account can write. Approvals do that.
- It does not restrict the network of Claude Code or Codex.
- It does not apply to the **terminal**, which is the owner's own unsandboxed
  shell, nor to what you run on **remote machines**, nor to Git commands you
  run from the Git panel (those behave as in a terminal, hooks included).

`AGENT_STUDIO_SANDBOX` controls it: `auto` (the default) uses bubblewrap when it
works; `bwrap` refuses to start the server without it; `off` never uses it.

## Without bubblewrap

On macOS, Windows, Linux without bubblewrap, or Linux where unprivileged user
namespaces are disabled, there is no sandbox. The About page says "Agents run
without a sandbox: a command you approve could read the Studio's own data" and
shows a warning. Then:

- **The permission engine still applies** to every request, as described above.
- **Nothing is hidden.** A command you approve (or that Auto allows) can read
  anything the service account can, including the Studio's key file and every
  credential. The per-project credentials switch has no effect.
- **Claude Code** still asks through the engine.
- **Codex is switched off.** Its read-only commands run without asking, and
  without the sandbox they could read all of the above. Its status says: "Codex
  is switched off here because the Studio's sandbox is not available…". An
  operator who accepts that risk can set `AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on`
  and restart. Then every Codex conversation starts with a notice saying that
  files outside the project, credentials included, are readable; the
  account's own Codex settings apply (approvals, the sandbox mode, MCP servers,
  hooks and project trust are still set by the Studio); and Codex refuses to
  run while its home has saved command rules, because those could not be kept
  out.
- **API models' commands** run unconfined, and the transcript says so: "No
  sandbox is available on this server (…): commands this agent runs are not
  confined to the project and can use the network." A command line that needs
  a shell (pipes, `&&`, redirections) or runs other commands is put to a person
  every time, in every mode, Auto included, and cannot be remembered.
- **Plugins** with server code cannot be enabled unless the operator sets
  `AGENT_STUDIO_PLUGINS_UNSANDBOXED=on`; see
  [Writing plugins](writing-plugins.md).

## The limits

From [SECURITY.md](../../SECURITY.md), and worth repeating:

- **An approved command is a command.** If you allow `rm -rf build`, it runs.
- **Without bubblewrap there is no sandbox**, and an approved command can read
  the Studio's key file.
- **The risk classifier is a heuristic.** A sufficiently obfuscated command
  might be classed as ordinary. In Ask mode it still asks; in Auto it would
  run. Keep Auto for projects you would let an agent loose in anyway.
- **Prompt injection is real.** A web page, a file in a repository or a memory
  note can contain text that tries to steer an agent. Approvals and the sandbox
  limit what a steered agent can do; nothing can stop it from asking.
- **The terminal is your shell**, with everything the account can reach.
- **Members are not isolated from each other at the operating-system level.**
  An agent a member runs executes as the service account.
- The project has had an AI-assisted security review and an adversarial test
  suite, but **no independent professional audit**.

The Studio also never sees what an agent does inside its own CLI when the CLI
does not ask (the cases listed under Claude Code and Codex above), and the
agents' behaviour depends on the versions of their CLIs. The adapters were
checked against Claude Code 2.1.283 and codex-cli 0.160.0; see
[Smoke tests against the real agent CLIs](agent-smoke-test.md) for what was
and was not seen.
