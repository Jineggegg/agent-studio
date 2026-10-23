# Memory, automation and notifications

This guide covers what the Studio keeps and does between conversations: shared
memory, automations and messages sent later, the inbox and notifications on
your devices, working with several agents, and usage figures.

The app includes screens for memory, the inbox, notifications, automations,
usage, conversation handoffs and multi-agent tasks. The
[screenshot tour](showcase.md) introduces the main workflows. This guide also names
HTTP routes for scripted access. Routes
marked "user" accept an API token (**Settings → Account & security → API
tokens**) sent as `Authorization: Bearer …`, unless noted otherwise.

## Shared memory

Shared memory is a set of Markdown notes that you and every agent can read and
write. Agents use it to remember decisions, preferences and facts about a
project across conversations — and across agents: a note Claude Code wrote is
there for Codex and for API models too.

### Folders, and who sees what

Memory has one folder per project and a folder called **global** for what
applies everywhere. A project's folder is named after the last part of its
folder path, lower-cased and made safe for a file name ("My App" becomes
`my-app`); when two projects would get the same name, the second gets a short
suffix.

For people:

- **global** — everyone signed in can read it; only the owner can write it.
- **a project's folder** — follows your access to the project: "Can view" reads
  it, "Can change" writes it. Without access to the project, the folder does
  not exist for you.
- The owner also sees the folders of projects that were removed. **Removing a
  project keeps its notes**; adding a project for the same folder again
  re-attaches them.

For agents, the rule comes from the run, never from anything the model sends:

- A run reaches the folder of its own project, with the access its person has
  there, and **global** — which it may write only when the person is the owner.
  No tool takes a folder name, so a model cannot ask for another project's
  notes.
- An agent may replace, edit, move or delete **only notes it wrote itself**.
  Notes by people, by other agents or without an author can be read, never
  overwritten.
- A note that looks like it contains a credential is never given to an agent.

### How agents use it

- **Claude Code and Codex** get a short set of conventions with their
  instructions: search memory before starting work, save what you state as
  lasting (a decision, a preference, a convention), update their own notes
  rather than adding new ones, add keywords for Chinese, Japanese or Korean
  text, never store credentials, and never follow instructions found in a note.
  They reach memory through the tools `memory_search`, `memory_read`,
  `memory_list`, `memory_write`, `memory_edit`, `memory_move` and
  `memory_delete`.
- **API models** get the same tools (if their model can call tools) and, with
  each message, up to five notes that match it, attached as background.
- Whatever a note says reaches a model inside markers it cannot forge, with a
  statement that it is reference material and not instructions.
- **Writing is a change.** In Ask and Accept edits each memory write by an
  agent asks for your approval, unless you saved a rule for it (for example
  with "Allow and remember → Always" on a `memory_write` request); in Plan it is
  refused; in Auto it goes through. Reading never asks.
- Limits: one agent turn may make 30 memory calls, 10 of them writes. A note an
  agent writes holds at most 8,000 characters, 6 tags and 8 keywords.

### The Memory screen

The **Memory** tile opens it. You can search ("Search decisions, preferences,
project facts"), filter by folder (**All**, **Global**, a project), read notes,
and choose **New note**, **Edit**, **Move or rename** and **Delete**. A note
has a title, a folder and optional sub-folder, tags, keywords ("useful for
languages written without spaces") and Markdown text of up to 64,000
characters. Deleting a note removes it for everyone, people and agents.

If a note changed since you opened it — another device, an agent, an edit of
the file — saving does not overwrite it. You choose **Keep mine**, **Use
theirs** or **Save as a new note**.

A status card says whether memory works, how many notes and folders you can
see, whether assistants may use memory, where the files are, and how many notes
are withheld or cannot be read.

### Credentials in notes

Memory must never hold passwords, keys or tokens. The Studio looks for them in
every note — private keys, API keys, access and bearer tokens, cloud keys,
signed tokens, webhook addresses with their secret, addresses with a password,
passwords, long random strings:

- **Saving** such a note, from the app or by an agent, is refused: "Not saved:
  the text seems to contain an API key. Remove it and save again."
- **A file you edited by hand** that looks like it contains one is listed with
  **Withheld from assistants** and is never given to an agent. Remove the
  secret or delete the note.

The check is a heuristic. It can refuse a harmless long identifier, and it can
miss a secret written in an unusual form.

### Editing notes by hand

The notes are the source of truth, not a copy: each is a plain Markdown file
at `<data directory>/memory/<folder>/…/<name>.md`, which you can read, back up,
put under version control and edit with any editor. The data directory belongs
to the account the Studio runs as, so edit as that account.

```
---
title: Deploy rules
tags: [deploy, ops]
author: claude-code
created: 2026-01-05T09:30:00.000Z
updated: 2026-01-07T16:02:11.000Z
---

Releases go out on Tuesdays…

Keywords: 部署 发布 release
```

- The header between the `---` lines is optional. Only `key: value`, one-line
  lists (`[a, b]`) and `- item` lists are understood; `title`, `tags`,
  `author`, `created` and `updated` are used and other keys are kept as they
  are. If the header contains anything else, the whole file is treated as text.
- A last line `Keywords: …` (or `关键词：…`) gives search keywords.
- A note's id is its path, so renaming or moving the file changes the id.
- Ignored: names starting with a dot, symbolic links, files that do not end in
  `.md`, files directly in `memory/`, and folders more than four levels below a
  top-level folder. A file that is not UTF-8 text or is larger than 1 MB is
  listed with a problem and can only be moved or deleted.
- Your edits show up on the next listing or search when there are up to 500
  notes, and within about two seconds when there are more. Reading a note always
  reads the file. **Rebuild the search index** (owner, on the Memory screen)
  reads every file again; it is only needed when search seems wrong.

### Switching memory off for agents

The owner's switch **Assistants may use memory** (on the Memory screen, "For
the owner") decides whether agents use memory at all. Off: "No assistant will
read or write notes until it is switched on again." Agents are told memory is
off and carry on without it; API models get no background notes. People can
still read and write memory. Changing the switch is recorded in the security
log.

Routes: `GET /api/memory/status`, `/api/memory/notes`, `/api/memory/search`,
`/api/memory/note`; `PUT /api/memory/settings` (owner) for the switch.

## Automations

An automation belongs to a project and to the person who created it. It has a
trigger and one action: **Remind me** (a one-line message to its creator, in the
inbox and as a notification) or **Run an agent** (a prompt sent to an agent in
this project, with nobody watching).

### Switching them on for a project

Automations are **off** for every project until the owner switches them on —
on the project's page (**Unattended runs**) or on its Automations page. While
off, "nothing here starts by itself": automations keep their settings but do
not run, and none can be created or scheduled.

The Automations page is at `/projects/<id>/automations`, reached from the
**Automations** button in a conversation's title bar when the project has them
on. Anyone who can change the project can create automations there, up to 20
per project. An automation can be changed, switched, run and deleted by its
creator (while they can change the project) and by the owner.

### Triggers and time zones

**Repeat**: **Once** (a date and time), **Every hour** (at a minute),
**Every day**, **Weekdays**, **Weekly** (chosen days), **Custom (cron)** — five
fields: minute, hour, day of month, month, day of week; two runs must be at
least 5 minutes apart — or **When a run fails** (a run in this project fails or
is cut short; this one can only remind, not run an agent).

Every time is wall-clock time in the automation's **time zone**, an IANA name
such as `Europe/Berlin`. On the day clocks go forward, a time that does not
exist runs once, an hour later; on the day they go back, a time that occurs
twice runs once, the first time. The form shows the next runs before you save
(`POST /api/automations/preview`).

### What an unattended agent run may do

A run an automation starts is **unattended**:

- It acts as the automation's creator, and is refused if that person's account
  is disabled or they can no longer change the project.
- Its permission mode is chosen on the automation ("Permission mode with nobody
  watching"): **Plan** reads and searches only; **Ask** runs what needs no
  approval and denies what would — "Whatever would need an approval is
  refused, never waited for"; **Accept edits** and **Auto** are offered only in
  a project whose owner has allowed Auto.
- It runs **in a new conversation each time**, or **always the same**
  conversation of yours with that agent — then a run is skipped if that
  conversation is busy.
- Before you save, the form says whom it runs as, in which mode, and whether it
  would be refused right now and why.

Details of what "denied" means are in
[Agents and approvals](agents-and-approvals.md#unattended-runs).

### History

Every execution is recorded — on schedule, by **Run now**, or after a failed
run — with how it went: **Notified**, **Quiet** (the notification was switched
off), **Running**, **Completed**, **Failed**, **Refused** (a guard refused it,
or "The agent needed approvals nobody was there to give"), **Skipped** ("The
previous run was still going" / "Its conversation was busy") or **Missed**
("The server was not running at the time"). The last 100 executions are kept;
the conversation an agent run used can be opened from there.

Scheduling is exactly-once: a due run is claimed before it is carried out, an
automation never runs twice at the same time, and **nothing is retried**.

A one-off automation switches itself off after it ran ("Ran once — edit the
date to schedule it again"). One whose creator can no longer change the project
is switched off too.

### Missed runs

If the server was not running when an automation was due, only the most recent
missed time is made up, and only if it is no more than **6 hours** old. A
server that was down for a week does not run a daily automation seven times.
Everything older is recorded as missed, and the schedule continues from now.

Routes: `/api/projects/:projectId/automations` (list, create),
`…/automations/:automationId` (read, change, delete), `…/run`, `…/runs`
(history), `…/automations/options` (what the form may offer). All "user".

## Send later

In a conversation, **Send later** beside Send schedules the text in the message
field: **In 15 minutes**, **In 1 hour**, **In 8 hours**, **In 24 hours**, or
**At a time of your choosing**. It is sent at that time even when no browser is
open.

- It is sent **as you, into your own conversation, as if you typed it then**,
  with the model, effort and mode that were selected when you scheduled it.
  Unlike an automation's run, it **waits for approvals** like a typed message,
  and you are notified when one is needed.
- If the agent is busy then, the message waits in the conversation's queue.
- Text only: no files, no quotation; at most 100,000 characters; at most a year
  ahead; at most 100 waiting per person.
- It works only in projects where automations are switched on ("Messages can be
  sent later only where automations are switched on for the project"), and is
  checked again when it is due.
- The scheduled messages are listed above the message field, where each can be
  cancelled while it waits. Nothing is sent twice and nothing is retried. If
  it cannot be sent — the conversation is gone, automations were switched off,
  the server was down for more than 6 hours past its time — it is marked "Not
  sent" with the reason, and you are notified.

Routes: `POST /api/deferred-messages`, `GET /api/deferred-messages`,
`POST /api/deferred-messages/:id/cancel` and `/dismiss`.

## The inbox

The **Inbox** tile opens a list of what waits for you across all your
conversations. It has two tabs.

**To do** is built from your runs every time you look, in four groups:

- **Awaiting approval** — "Each waits for a decision in its conversation. Open it
  and decide there — nothing in the inbox can approve anything." The owner also
  sees members' requests that only an owner may allow.
- **Needs handling** — failed or interrupted runs. Opening one shows why it
  stopped and lets you continue it there. **Mark handled** only puts the row
  away; nothing is retried, continued or approved.
- **Results to view** — finished in the last three days and not looked at yet.
  Opening the conversation counts as reading it; **Mark read** and **Mark all
  read** do the same without opening.
- **In progress** — still working.

It lists runs of **your own** conversations; the owner does not get everybody's.

**Notifications** is the stored list of notifications, with unread marks:
**Mark read**, **Mark all read**, **Clear read notifications**, **Clear all
notifications**. At most 200 are kept per person, for 30 days.

## Web Push notifications

A notification tells you, on your devices, that an agent needs you, finished,
or failed — also while the app is closed.

**Not yet verified:** Web Push has been tested against a stand-in push service
only, never sent through a real one, and not tried on a physical phone.

### Switching it on, per device

Notifications are set up per device and browser:

1. Open the Studio at an **https** address (or `localhost`). Browsers allow
   notifications nowhere else.
2. On iPhone or iPad: add the Studio to the Home Screen first (Safari → Share →
   Add to Home Screen), on iOS or iPadOS **16.4 or later**, and open it from
   there. In Safari's tabs it cannot receive notifications.
3. Go to **Settings → Notifications** and choose **Enable notifications**. The
   browser asks for permission; allow it.
4. "This device is set up. A confirmation is on its way." Use **Send test** to
   check: it sends one notification to every device and reports, per device,
   whether its push service accepted it.

What the page may tell you instead, and what to do:

| State                         | Meaning                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add to Home Screen first      | iPhone or iPad outside the installed app.                                                                                                                 |
| Blocked in this browser       | You refused the permission. Allow notifications in the site's settings (on iPhone: Settings → Notifications → Cloud Harness). The page updates by itself. |
| Not set up on this device     | Permission given, but this browser is not registered with your account. **Enable on this device**.                                                        |
| Set up, but switched off      | Sending to devices is switched off for your account. **Switch sending on**.                                                                               |
| Needs a secure address        | The page was opened over plain http.                                                                                                                      |
| Background worker not running | Reload the page. A development build has none.                                                                                                            |
| Not available in this browser | The browser has no Web Push. The inbox still works.                                                                                                       |

An account can have up to 10 devices. They are listed with when they were last
delivered to, and can be removed; removing this browser also gives up its
subscription.

The server sends to the push services of current browsers — Google
(`fcm.googleapis.com`), Mozilla, Microsoft (`notify.windows.com`) and Apple
(`push.apple.com`) — so it needs outbound https to them.

### What a notification may show on a lock screen

**Notify me about** has one switch per kind: **Needs you**, **Reply finished**,
**Background work finished**, **Failed or interrupted**, **Automation
reminders** and **Plugins**. A kind that is switched off is sent nowhere and not
kept. The conversation you have on screen never notifies you. At most 30
notifications a minute reach your devices; the rest are dropped. The same event
for the same conversation is sent once within 20 seconds.

By default a notification on the lock screen says which conversation and what
happened, and nothing from it — for example "Claude finished its reply". It
names the conversation by its title only when you or the agent gave it one; a
title cut from your first message is replaced by the project's name.

**Show details on the lock screen** (under **Lock screen**) adds one line from
the conversation: the command waiting for approval, the start of your request,
or an error message — "which anyone who can see your lock screen can read".
Anything that looks like a password or key is removed first. It is off by
default.

**Keep a list in the inbox** (under **In the app**) decides whether
notifications are also kept in the inbox's Notifications tab.

Tapping a notification opens what it is about, usually the conversation. A
notification has no buttons: approvals are answered in the conversation.

## Several agents

### Handing a conversation to another agent

A conversation keeps the agent it started with. To continue it with another
agent — say, from an API model to Claude Code — the server can **hand it
over**: it creates a new conversation with the other agent in the same
project, links the two, and gives the new agent a **brief** of the earlier
conversation, marked as background and not as instructions. The brief is
either a digest built by rule from the record (no model involved), or, if you
ask, a summary written by an agent you name; if that summary cannot be written,
the digest is used and you are told why. Both conversations get a note in
their transcript. Conversations handed on form a chain; only the newest of a
chain can be handed on again.

After the current reply finishes, open **Conversation actions (⋯) → Continue
with another agent…**. Choose the recipient and brief format, then optionally
add **A note for the new agent**. **I will write first** leaves the note in
the new conversation's draft; **Start now** sends it as the first message.
The handoff record links both conversations and lets you inspect the brief.
Handoffs are initiated by the user; agents do not send each other arbitrary
messages or start an autonomous dialogue through this feature.

Routes ("user"):
`POST /api/sessions/:sessionId/handoff` with `requestId`, `agentId` (must differ
from the current agent), optional `model`, `permissionMode`, `note` (your
words for the new agent), `start` (send the first message at once) and
`summary` (`{ "agentId": … }`); `GET /api/sessions/:sessionId/handoffs` and
`/chain`.

### One task for several agents

A **multi-agent task** gives one prompt to two to six agents at once, each in
a conversation of its own, and follows them as one task:

- **shared** — everyone works in the project's folder, and therefore only in
  Plan mode (reading), so they cannot overwrite each other.
- **worktrees** — each gets a Git worktree and branch of its own (only the owner
  can start this) and may use any permission mode.
- Optionally one more agent compares the answers when everyone has finished
  (in Plan mode). Nothing is ever merged automatically.
- At most three tasks per person run at a time. A task can be stopped as a
  whole.

Choose **Ask several agents…** from the conversation's **Conversation actions
(⋯)** menu, or open a project's multi-agent tasks. Select the participants,
isolation mode and optional comparison agent, then start the task. Its screen
shows each participant's status and answer, the comparison when ready, and
links to the individual conversations. **Running** shows active work across
your conversations and tasks.

Routes ("user"):
`POST /api/projects/:projectId/tasks`, `GET /api/projects/:projectId/tasks`,
`GET /api/tasks`, `GET /api/tasks/:taskId`, `POST /api/tasks/:taskId/stop`,
`DELETE /api/tasks/:taskId`, and `GET /api/work/running` for everything that is
running.

## Usage and plan windows

### What the app shows today

In a conversation, the ring in the title bar shows how full the context window
is after the agent's latest request, when the agent reports it. Tap it for the
details: tokens in the context window and, for the whole conversation, input,
output and cache tokens and the cost — a percentage only when the window size
is known, a cost only when the agent reports one or the Studio can estimate it.
The ring turns to a warning at 80 % and says the window is nearly full at 95 %.

The Usage screen includes reports, plan windows, provider balances and your
own monthly budgets.

### Where the numbers come from

- **Tokens** are what each agent reports for each run and model.
- **Cost** is what the agent reports (Claude Code does; Codex reports tokens
  only), or an estimate from the prices in an API provider's catalogue. Where
  neither exists, cost is **unknown — not zero**; a total that mixes the two
  says it is partial. After a server restart, the first turn of a resumed
  Claude Code conversation reports no cost.
- **Plan windows** — "5-hour" and "weekly" limits of a subscription — are what
  the agent's own CLI said about the limits of the account it is signed in to,
  during one of your runs: Claude Code reports them after its first model
  request in a turn, Codex while it works. The Studio calls no usage endpoint
  of its own.

### Why they may be stale

A plan-window reading cannot be refreshed on demand. It gets newer only when
that agent runs again. The server marks a reading stale when it is more than
15 minutes old ("the account may have been used since") or when the window it
describes was due to reset. Those limits belong to the CLI's account, which
everyone using this Studio shares, and anything else using that account —
you in a terminal, another machine — uses them up too.

For API providers there are no plan windows. There is a balance where the
provider documents a way to read it (DeepSeek does; read by the owner), and an
estimate: an amount you noted on a date minus what the Studio's records say was
spent since. **Budgets** are your own monthly amounts; crossing 80 % and 100 %
is announced once a month in the app.

### Optional limits on new requests

Each budget starts with **Stop new requests at this amount** switched off.
Choose your own positive token or dollar amount; none is prefilled. Switch
the option on to refuse new runs and API model requests once your recorded
usage reaches that amount. A budget can cover all your agents or one agent.
Only its owner can change it, including on a shared instance. The month
resets in the budget's selected IANA time zone. Raising the amount, disabling
the option or removing the budget also permits new requests again.

This is a gate based on observed usage, not an exact monetary cap. Unknown
model prices and costs an agent has not reported are excluded; the screen
shows the number of unpriced runs. Usage from other applications or outside
this instance is not counted. Requests already running are not cancelled,
and concurrent requests may pass the check before either reports its usage.
Both can exceed the amount. CLI agents are checked before starting a run;
their internal model requests cannot be checked or interrupted individually.
API agents are checked before each model request, including tool follow-ups.
No money is refunded or rolled back by this setting.

Routes ("user"): `GET /api/usage/report` (by day, week or month, by agent,
model and project; the owner may ask for everyone's), `GET /api/usage/summary`,
`GET /api/usage/quota`, `GET /api/usage/providers`, `/api/usage/budgets`; and
`GET /api/sessions/:sessionId/usage` for one conversation.
