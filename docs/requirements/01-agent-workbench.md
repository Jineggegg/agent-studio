# 01 — AI Agent Workbench and Multi-Model Collaboration

> **Provenance.** Written by the product-analysis group from the behaviour of a private predecessor system, as input for an independent implementation (see `docs/clean-room/PROCESS.md`). It describes what the product should do, never how the predecessor was built. Owner-specific private integrations were removed from this published copy. Where the implementation deliberately differs, `docs/requirements/README.md` says so. Statements about the predecessor's security behaviour were removed or restated as requirements before publication.

Product requirements derived by black-box analysis of the existing "Studio" system.
Audience: the development group building the new product. This document describes
WHAT the product does and how a user or an API client observes it. It deliberately
contains no source code, no internal names and no description of how the old system
is built. Short UI labels are quoted in their original language (Simplified Chinese)
where that helps; every label may be re-worded in the new product.

Conventions used below

- "Agent" = a coding agent that runs on the host computer inside a project folder and
  can use tools (read/edit files, run commands, search, browse, spawn sub-agents).
  Two are offered today: **Claude Code** and **Codex**.
- "API model" = a plain chat model reached over an HTTP API with the owner's key
  (today: **DeepSeek**, an OpenAI-compatible service, and the **Claude API**,
  pay-as-you-go). API models hold a conversation; they do not run tools on the host.
- "Session" = one conversation with one agent. "Conversation" (API models) is the
  equivalent for an API model. "Thread" / "chain" = one logical conversation that was
  handed from one provider to another and therefore spans several sessions.
- "Run" (or "turn") = one execution of an agent for one user message, from acceptance
  to its single terminal event.
- "Owner" = the signed-in user. An installation typically has one owner, but all
  data must nonetheless be scoped per user.
- "Observed" = read directly from behaviour descriptions, tests or UI. "Inferred" =
  my conclusion from indirect evidence; marked as such.
- Viewport classes: **phone** (width ≤ 700 px), **tablet** (700–1023 px),
  **desktop** (≥ 1024 px).

---

## 1. Scope summary

The workbench is the heart of the product: a single chat surface, usable with one thumb
on a phone and with a keyboard on a desktop, through which the owner drives coding
agents that run on their own computer and talks to API models, across many projects.
It covers composing and sending messages (text, images, files, quotes, dictated text,
suggested replies, slash commands, file mentions); watching a run live (prose, tool
calls with diffs and command output, reasoning, checklists, sub-agents, background
work); stopping, steering and queueing; durable delivery so a message is never lost or
sent twice; runs that belong to the server and keep going when the browser closes or
the phone locks; catching up after a reconnect and recovering after a server restart;
the human-approval flow for tool use, plan approval and agent questions; choosing agent,
model, reasoning effort and permission mode; session management per project and across
the whole computer (search, rename, automatic naming, pin, group, archive, delete,
drafts, running / needs-attention / finished-unseen marks); sessions started outside
the product (in a terminal or a desktop app) that are discovered, followed live and can
be continued; handing a conversation from one provider to another with an automatic
summary; and usage visibility (context-window ring, plan-quota panel with staleness
handling, API balances, token analysis). Projects/files/git/terminal, sign-in/security,
and home screen/notifications/automation are specified by other analysts and are only
referenced here where the workbench touches them.

---

## 2. Feature inventory

Priority: **Core** = the product is not usable without it; **Important** = expected by
the owner in daily use; **Nice** = Nice-to-have. "Legacy" in a description marks a
capability that sits outside the phone-first workbench flows below; the new product
should decide where it lives (see §9).
Scope column: **Generic** = build it; **Private-excluded** = owner-specific, do not
build.

### A. Shell and navigation

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-001 | Two-scope workbench | One chat surface with a Project scope (one project's history + its tools) and an All scope (every session on the computer); last scope reopened | Core | Generic |
| WB-002 | Responsive shell | Side list as phone sheet / docked column; chat column; optional inspector; arrangement remembered per device | Core | Generic |
| WB-003 | Landing and resume rules | Opens last project and, per project, the conversation last on screen; All scope lands on the running turn | Important | Generic |
| WB-004 | Session links | Stable links to a session/conversation; wrong-project correction; old-style links redirect; provider-native ids resolve to the canonical session | Important | Generic |
| WB-005 | Keyboard shortcuts | Search, new session, toggle side list / inspector, stop, back, permission-mode cycle | Important | Generic |
| WB-006 | Touch navigation gestures | Swipe right over the chat opens the list; edge swipe / Esc / ⌘[ go back; swipe rows for actions | Important | Generic |
| WB-007 | Stage states | Skeletons; empty; "gone" vs "unreachable + Retry" told apart everywhere | Core | Generic |
| WB-008 | Chat crash containment | A rendering failure in the chat leaves list and tools usable and offers reload / new session | Nice | Generic |

### B. Composing and sending

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-010 | Compose and send | Auto-growing field; Enter sends, Shift+Enter newline; IME-safe; double-send guard | Core | Generic |
| WB-011 | Durable delivery | Client request id, server receipt before any agent work, idempotent re-submission | Core | Generic |
| WB-012 | Delivery uncertainty | Unconfirmed sends shown as such; check delivery; retry the original only after a negative check | Core | Generic |
| WB-013 | Attachments | Images/files by picker, paste, drag-drop; 10 files, 10 MB each; paste de-duplication; per-conversation pending attachments | Core | Generic |
| WB-014 | Image viewer and markup | Full-screen zoom/pan/swipe; pen, circle, arrow, rectangle; reply with the marked copy | Important | Generic |
| WB-015 | Quote into next message | Select text in a message → Quote pill → goes out above the next message once | Important | Generic |
| WB-016 | Suggested next message | One suggested reply after each answer; faint in field, chip when typing, Tab to fill | Nice | Generic |
| WB-017 | Browser dictation | Live speech-to-text into the draft where the browser supports it | Nice | Generic |
| WB-018 | Slash commands | Built-in commands, project/user custom commands, skill insertion; keyboard menu | Important | Generic |
| WB-019 | File mentions | "@" opens a project-file picker that inserts a path | Important | Generic |
| WB-020 | Sent-message recall | ↑/↓ in an empty field walks previous messages of this conversation | Nice | Generic |
| WB-021 | Drafts | Unsent text per conversation, synced to the account, "draft" tags in lists | Important | Generic |
| WB-022 | Draft follows project change | A new chat's unsent text/attachments move with it to another project (swap, never overwrite) | Nice | Generic |
| WB-023 | Send-key preference | Option to send only with Ctrl/⌘+Enter (legacy quick setting) | Nice | Generic |
| WB-024 | Server voice (STT/TTS) | Record-and-transcribe input and read-aloud of replies via a configured voice backend (legacy) | Nice | Generic |

### C. Transcript

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-030 | Live transcript | Agent output appears as produced, in order, without duplicates | Core | Generic |
| WB-031 | Rich text rendering | Markdown, highlighted code, tables, math, diagrams, links | Core | Generic |
| WB-032 | Tool-call stacks | Grouped compact rows with verb/target/status; expandable diff, output, arguments | Core | Generic |
| WB-033 | Reasoning display | "Thinking" rows inside stacks and live in the status row | Important | Generic |
| WB-034 | Run status row | Live line with activity, checklist, steps, elapsed time; finished/stopped summary | Core | Generic |
| WB-035 | Agent checklist | The agent's to-do list as one evolving checklist | Important | Generic |
| WB-036 | Sub-agent and workflow panels | Nested timelines, per-agent state, tokens and duration | Important | Generic |
| WB-037 | Notices | Mid-run error rows, background-task reports, compaction dividers | Important | Generic |
| WB-038 | Paging and scrolling | Newest-first paging, lazy rows, follow-unless-scrolled-up, "back to latest" | Core | Generic |
| WB-039 | Copy actions | Copy a message, a code block, a command | Important | Generic |
| WB-040 | File links | File references open the file at a line; folders reveal in the tree | Important | Generic |
| WB-041 | Image policy | Project images via authenticated fetch; web images only after a tap, no referrer | Important | Generic |
| WB-042 | Run shell block | One tap types a shell code block into the project terminal | Important | Generic |
| WB-043 | Answering-model label | Each agent turn names the model that answered | Nice | Generic |
| WB-044 | Transcript export | Download as web page, Markdown or JSON (legacy) | Nice | Generic |
| WB-045 | Conversation full-text search | Search message contents across sessions, jump to the hit (legacy) | Important | Generic |
| WB-046 | Completion cues | Tab-title marker and sounds for finished run / approval needed | Nice | Generic |

### D. Runs

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-050 | Server-owned runs | A run continues with zero viewers; at most one run per session | Core | Generic |
| WB-051 | Multi-client fan-out | Every device watching a session sees the same live stream | Core | Generic |
| WB-052 | Reconnect and replay | Sequence-numbered events; gap-free catch-up; authoritative state first | Core | Generic |
| WB-053 | Stop a run | Stop button, Esc, ⌘.; exactly one terminal event; partial output kept | Core | Generic |
| WB-054 | Steer | Inject a message into a running turn (agents that support it) | Important | Generic |
| WB-055 | Message queue | Server-held ordered queue per session; send-now, edit, remove; drains without a browser | Important | Generic |
| WB-056 | Edit and resend | Replace an earlier message and re-run from there | Important | Generic |
| WB-057 | Background work | Work that outlives its turn; session stays "working"; background-task panel | Important | Generic |
| WB-058 | Stop one background task | Stop a single sub-agent / command / workflow (legacy surface) | Nice | Generic |
| WB-059 | Restart recovery | Interrupted/failed runs become records with View / Continue / Dismiss; never auto re-run | Core | Generic |
| WB-060 | Running-session tracking | Authoritative list of what runs now, including turns driven from a terminal | Core | Generic |
| WB-061 | Scheduled messages | Send a message to a session at a later time (legacy) | Nice | Generic |
| WB-062 | Fork | Branch a session (optionally from a message) into an independent copy (legacy) | Nice | Generic |
| WB-063 | External agent API | Start/continue runs over HTTP with an API key, streaming or not; optional clone/branch/PR | Nice | Generic |
| WB-064 | Task inbox | One list of approvals waiting, runs needing handling, unread results, running tasks (shared with the home/notification domain) | Important | Generic |
| WB-065 | Run notification triggers | Events for finished / failed / interrupted / approval needed, suppressed for the session on screen (delivery owned by another domain) | Important | Generic |

### E. Permissions and approvals

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-070 | Permission modes | Ask / auto-judge / auto-accept edits / plan / bypass, per agent capability | Core | Generic |
| WB-071 | Tool approval prompt | Inline sheet: what, target, command or diff; Allow / Deny / Always allow | Core | Generic |
| WB-072 | Approval lifecycle | Timeout → deny; cancel on stop; resolved everywhere; pending list restored on reconnect | Core | Generic |
| WB-073 | Tool rules | Account-wide allowed and blocked tool patterns; "skip prompts" switch | Core | Generic |
| WB-074 | Plan approval | Plan card with Approve-and-run / Keep revising (with note) | Important | Generic |
| WB-075 | Agent questions | Structured single/multi-choice + free text; skip; optional server default answer after a deadline | Important | Generic |
| WB-076 | Protect background work | Confirm before a send that would terminate running background work | Important | Generic |

### F. Providers and models

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-080 | Coding agents | Claude Code and Codex, run in the project folder on the owner's subscription sign-ins | Core | Generic |
| WB-081 | OpenAI-compatible API chat | Plain chat with an API model (DeepSeek today) per project or in a general space | Important | Generic |
| WB-082 | Pay-as-you-go Claude API chat | Plain chat answered by the Claude API with the owner's key, off until enabled | Nice | Generic |
| WB-083 | One model menu | Single picker listing every provider's models, recent models and quota | Core | Generic |
| WB-084 | Model catalog | Per provider: families, recommended model, extended-context variant, legacy aliases, effort levels | Core | Generic |
| WB-085 | Reasoning effort | Per-model effort levels with clamping and a recommended default | Important | Generic |
| WB-086 | Model/effort persistence | Per session on the server; per device last choice; account default for new sessions | Important | Generic |
| WB-087 | Model visibility and custom models | Hide/restore built-in models; add/edit/delete custom model ids | Nice | Generic |
| WB-088 | Provider sign-in status and login | Installed? signed in? by which method? start the CLI's login from the product | Core | Generic |
| WB-089 | API key management | Save / verify / remove keys for API providers; encrypted, never returned | Important | Generic |
| WB-090 | Capability matrix | Server tells the client what each provider supports (modes, images, edit, fork, usage, approvals) | Important | Generic |
| WB-091 | Retired providers are not offered | A provider that is no longer offered is never listed, offered or used for new runs; old records naming it stay readable | Nice | Generic |
| WB-092 | Note tools for API chat | The API model can search/read/write the shared notes within limits (shared-memory domain) | Nice | Generic |

### G. Sessions

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-100 | Session creation | Stable server-issued id before the first message; never changes | Core | Generic |
| WB-101 | Project history | All agents' sessions and API conversations of a project in one list, by last user message, paged | Core | Generic |
| WB-102 | Title search | Filter the history by title words | Core | Generic |
| WB-103 | Rename | Inline in the list and in the title bar | Core | Generic |
| WB-104 | Automatic naming | From the first message; later from a title line proposed by the agent; never over a manual name | Important | Generic |
| WB-105 | Pin and groups | Pin rows, user-named foldable groups; account-wide | Important | Generic |
| WB-106 | Archive and restore | Soft-hide with Undo; archived list; auto-unarchive on new activity | Important | Generic |
| WB-107 | Delete | Confirmed permanent delete including the agent's own transcript | Core | Generic |
| WB-108 | Attention marks | Running mark; red "needs you"; white "finished, unseen"; survive reload and restart | Core | Generic |
| WB-109 | All-sessions list | Running now, pinned, by day, archived — across projects and agents | Important | Generic |
| WB-110 | Outside sessions discovered | Sessions started in a terminal or desktop app appear automatically with sensible titles | Important | Generic |
| WB-111 | Live follow | An open session written from outside the product refreshes within about a second | Important | Generic |
| WB-112 | Read-only sessions and "continue here" | View sessions the server can read but not drive; continue them in a new session with a summary | Nice | Generic |
| WB-113 | Project activity marks | Per project: running agents, needs-owner, finished-unseen | Important | Generic |
| WB-114 | Presence | The client tells the server which sessions are visibly on screen | Important | Generic |
| WB-115 | Bulk session actions | Multi-select and delete (legacy) | Nice | Generic |
| WB-116 | Copy native session id | Copy the agent's own id for use in a terminal (legacy) | Nice | Generic |

### H. Multi-model collaboration

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-120 | Several agents per project | Any offered agent or API model can be used in the same project; one shared history | Core | Generic |
| WB-121 | Handoff | Continue a conversation with another provider, seeded by an automatic summary | Important | Generic |
| WB-122 | Conversation chains | Handed-over sessions shown and managed as one conversation | Important | Generic |
| WB-123 | Compaction visibility | Automatic/manual context compaction shown with before/after size and summary | Important | Generic |
| WB-124 | Embeddable assistant panel | The workbench can be shown as a side panel of another in-product app, which may hand it text and a screenshot for the next message | Nice | Generic |
| WB-125 | Opt-in extra context | A per-message switch that attaches a read-only status summary from a connected app (API chat) | Nice | Generic |

### I. Usage

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-130 | Context ring | How full the session's context window is; card with details | Important | Generic |
| WB-131 | Token usage data | Live budget during a run and stored usage per session | Important | Generic |
| WB-132 | Plan-usage panel | Subscription windows per provider, remaining/used, reset countdowns | Important | Generic |
| WB-133 | Staleness handling | Stale flag, reason in words, refresh now, last-good reading across outages | Important | Generic |
| WB-134 | Usage display preferences | Remaining vs used; which items are shown | Nice | Generic |
| WB-135 | Reset credits | Show and redeem a provider's usage-reset credits, idempotently | Nice | Generic |
| WB-136 | API balance and spend | Balance read (where the provider offers it) or estimated balance from a noted amount minus tracked spend | Nice | Generic |
| WB-137 | Token analysis app | Day/week/month token and cost breakdown by model and project | Nice | Generic |
| WB-138 | Usage widgets | Home-screen tiles for each provider's usage (home-screen domain) | Nice | Generic |
| WB-139 | Informational commands | Token/cost, status and model-list dialogs | Nice | Generic |

### J. Errors and resilience

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |
| WB-150 | Auto-reconnect | Live channel retries forever; state re-established on reconnect | Core | Generic |
| WB-151 | Expired sign-in to the product | Any "unauthorised" answer returns the user to sign-in with a clear message | Core | Generic |
| WB-152 | Provider failure surfacing | Not installed / not signed in / turn failed shown as readable rows and states | Core | Generic |
| WB-153 | Connection protections | Heartbeat, message-size cap, back-pressure cut-off, handshake rate limits | Important | Generic |
| WB-154 | New-version prompt | Long-lived pages learn of a new client build (other domain) | Nice | Generic |

### K. Private, owner-specific (do not build)

| ID | Feature | Description | Priority | Scope |
| --- | --- | --- | --- | --- |

WB-P01 and WB-P02 are instances of the generic capabilities WB-124 and WB-125, which
are specified instead.

---

## 3. User flows

Each flow is written from the owner's point of view. "Phone" and "Desktop" notes are
given only where the two differ; a tablet behaves like a desktop unless stated.

### F-01 Open the workbench

1. The owner opens the workbench from its home-screen icon (or a direct link).
2. The workbench has two scopes, switched by a two-segment control at the top of the
   side list: **项目 / Project** (one project's history, with that project's files,
   terminal, git and preview tools) and **全部 / All** (every agent session on this
   computer, across projects, plus what is running right now). The scope used last on
   this device is reopened.
3. Project scope with no explicit target: the project used last on this device opens;
   failing that, the first project the owner registered in the product (as opposed
   to a bare folder that merely appears because an agent once ran there); failing
   that, the first project. Inside the project, the conversation that was on screen
   last time in that project is reopened (even if it is older than the first page of
   history); if the last view was a new chat, a new chat opens with the same agent.
4. All scope with no explicit target (e.g. from the home icon): if a turn is running
   on the computer right now, the most recently started running session opens;
   otherwise a new conversation opens. The decision is made once, from the first
   answer about what is running; a turn that starts later never pulls the owner away
   from what they are typing.
5. An explicit link to a session always wins over any remembered view. A link that
   names the wrong project for a session is corrected silently to the right project.
   A remembered session that no longer exists is forgotten (no other conversation is
   invented in its place).
6. Phone: the side list is a sheet sliding in from the left over a dimmed backdrop; the
   chat fills the screen. Desktop/tablet: the side list is a docked column (288 px)
   that can be hidden; a right-hand inspector (files / terminal / git / preview) can
   be opened beside the chat (docked on desktop, floating on tablet, full-screen on
   phone).

### F-02 Start a new conversation and send the first message

1. The owner taps **新会话 / New session** (side list), presses ⌘/Ctrl+N (or ⌘⇧O), or
   uses the "start a new session" button of an empty/missing state. A new chat opens
   **immediately** — no picker first — and the message field takes keyboard focus.
2. The new chat starts with the agent used last on this device (shared between both
   scopes). If the project restricts which agents it offers and the last-used agent
   is not among them, the project's first offered agent is used instead.
3. In All scope a new chat needs a project: a chip in the title bar shows the project
   it will run in (default: the project of the most recently active session on the
   computer, else a project registered in the product, else the first). Tapping the chip lists
   projects (pinned first, then by recent activity) and, where available, a small
   "+" to create a new project; picking one moves the new chat there.
4. The empty chat shows only the provider mark, the project's display name and
   "provider · model" — no hints or tutorials.
5. The owner types and sends (see F-03). On the first send the product (a) uploads any
   attachments, (b) creates the session on the server and receives its stable id and
   an initial title derived from the message, (c) submits the message with a
   client-generated request id.
6. The message appears at once as the newest turn, marked "sending…" under the
   bubble. When the server's receipt arrives the mark disappears, the composer is
   cleared, the address changes to the new session's link **without the chat being
   re-created or flickering**, and the session appears at the top of the history.
7. If session creation, upload or message preparation fails, an error row says why,
   nothing is sent, and the typed text and attachments stay in the composer.

### F-03 Compose and send

1. Text field grows with its content. **Enter sends; Shift+Enter inserts a line
   break; ⌘/Ctrl+Enter also sends.** This holds on hardware and on-screen keyboards
   (the on-screen return key is labelled "send").
2. While an input-method composition is active (Chinese/Japanese/Korean candidates),
   Enter confirms the candidate and never sends — including the browser quirk where
   the composition ends a few milliseconds before the Enter key event.
3. Send is disabled when there is neither text nor an attachment (and no suggestion to
   send, see F-12).
4. Sending while offline: nothing is uploaded and no session is created; the composer
   keeps the draft and a banner says the message was not sent.
5. Two quick taps on send (or a tap during an attachment upload) produce exactly one
   message.
6. After a send the view scrolls to the newest row.

### F-04 Choose agent, model, effort and permission mode

1. The composer toolbar holds, left to right: attach, **permission-mode chip**,
   **model chip** (the one and only model picker), **effort chip** (only when the
   model has effort levels); on the right: microphone (if supported) and the
   send/stop disc.
2. Model chip → the model menu (see screen S-08): a "recently used" row, then one
   section per provider (Claude Code, Codex, Claude API if enabled, DeepSeek), each
   titled with the provider's mark and a quota figure.
3. **Before the first message** picking a model of another provider switches the chat
   to that provider in place; the choice becomes the default agent for every later
   new chat on this device.
4. **After the first message**, picking a model of the *same* provider changes this
   session's model in place (and becomes that provider's default for new chats).
   Picking a model of *another* provider starts a handoff (F-20).
5. Effort chip → a popover with a discrete slider from "faster" to "smarter", one stop
   per level the model supports, the recommended level marked; a reset button returns
   to the recommended level. A level the newly chosen model lacks is clamped to its
   nearest supported level.
6. Permission chip → a menu of the modes the agent supports. **Shift+Tab in the
   message field cycles the modes but never lands on the "bypass everything" mode**;
   that mode can only be chosen deliberately in the menu, where it is drawn as
   dangerous. A screen-reader announcement states the mode a Shift+Tab landed on.
7. The mode chosen applies to the next send; it is remembered per session and per
   provider on this device.

### F-05 Watch a run

1. From the moment a message is accepted the session is "running": the side-list row
   shows the provider's animated running mark instead of a time, and the last row of
   the transcript is a **run status row**.
2. Agent output appears as it is produced: prose paragraphs under a turn label
   (provider mark, provider name, and the model that answered when known); tool calls
   as compact rows grouped into a stack (icon, verb, target, status glyph); reasoning
   as "thinking" rows folded into the same stacks; checklists, plans, questions,
   sub-agent and workflow panels as their own cards.
3. The run status row shows a glyph (composing / tool working / waiting for the
   owner), what the agent is doing in words (e.g. "running <command>", "thinking",
   "waiting for you to allow …"), the checklist progress (done/total), the number of
   steps taken, and the elapsed time (seconds, then "m min ss s").
4. Tapping the row unfolds the live reasoning (the most recent ~1,200 characters,
   scrolling inside the row), the current checklist and the ordered step list of this
   turn (each running / done / error). Esc folds it without stopping the run.
5. If the owner has not scrolled up, the view follows new rows. If they scrolled up,
   nothing moves them, and a round "back to latest" button appears above the composer.
6. When the run ends, the status row says "turn finished" or "stopped" with the time
   taken for about 2.6 s, then disappears. The row reverts to showing a time in the
   side list.
7. If the session is not on screen when the run ends, its side-list row gets a white
   "finished, not yet seen" dot until opened; if it needs the owner (a permission
   prompt, a question, a failed/interrupted run) it gets a red dot instead.

### F-06 Stop a run

1. While a run is in progress and the field is empty, the send disc is a **stop**
   square. Tapping it stops the run. **Esc** (when nothing else consumes it) and
   **⌘.** (for keyboards without Esc) do the same from anywhere in the chat column.
2. Exception: while a tool-permission sheet is showing, Esc answers "deny" for that one
   request and the run carries on; ⌘. still stops the run.
3. Esc inside an open popover, menu, usage card, title rename, status-row details or
   background-task sheet only closes that element and never stops the run.
4. A stopped run keeps whatever it produced; the partial reply remains in the
   transcript. The status row says "stopped".
5. For an API-model chat, stop cancels the pending reply; the column says the reply
   was stopped and the typed message is restored to the field.

### F-07 Send while a run is in progress (steer, queue)

1. The field stays usable during a run. With text typed:
   - If the running agent can take a message mid-turn (Claude Code): the disc becomes
     **引导 / Steer** — the message is injected into the running turn — and a separate
     **排队 / Queue** chip offers to send it as the next turn instead.
   - If it cannot (Codex): the disc becomes **Queue**; there is no separate chip.
2. Steer: the message is shown in the transcript at the point where the turn took it.
   If the turn could no longer take it (it had just ended) the message is queued
   automatically, so it is never lost. If no answer comes within 8 s the owner is told
   the message could not be delivered and the text stays in the field (it is *not*
   auto-queued, to avoid a double send).
3. Queue: queued messages are listed above the field in send order ("queued" or
   "queued 1, 2, …"), each with its attachment count. The server sends them one turn
   at a time after the current turn ends — with no browser attached if need be.
4. Each queued item can be: **sent now** (label depends on state: "steer" into a
   steerable running turn; "interrupt and send" for a non-steerable running turn,
   which stops the turn and sends this message first; "send now" when idle),
   **edited in place** (Enter saves, Esc cancels; attachments stay), or **removed**.
   Editing or removing an item that has already gone out fails with a short notice.
5. The queue follows the server: it is the same on every device and survives reloads.
6. When the server sends a queued message, it appears in the transcript as the owner's
   turn without any action from the browser.

### F-08 Approve or refuse a tool (permission prompt)

1. When the agent wants to use a tool that needs approval, an inline sheet rises above
   the composer (the composer stays visible). It shows: provider mark, "<agent> wants
   to <action>" (run a command / modify / write / read / search / access the network /
   start a sub-task / use <tool>), the target (file name or pattern), the full command
   for shell tools, the agent's own description if any, a preview of the first 8
   changed lines for edits/writes, or a foldable "view arguments" for anything else,
   and "N more" when further requests are waiting.
2. Buttons: **拒绝 / Deny** (neutral colour — refusing is the safe answer),
   **始终允许 / Always allow** (Claude Code only; shows the rule that will be saved,
   e.g. the tool name, or for shell commands the program — and for git the
   sub-command — followed by a wildcard), **允许 / Allow**.
3. Allow / Deny answer this one request. The run continues either way; a denied call
   is shown in the transcript as "denied" (distinct from "error").
4. Always allow saves the rule to the owner's allowed-tools list, and in the same tap
   answers every other pending request that the same rule covers. If the rule was
   already saved the button reads "Allow (remembered)".
5. One sheet at a time; when answered, the next waiting request takes its place.
6. A request answered on another device or tab, cancelled, or timed out disappears
   everywhere. A page refresh mid-run shows only the requests that are still open.
7. If the session is not on screen, its row (and its project in the project switcher,
   and the hidden-list button) gets a red dot, and a push notification is sent (owned
   by the notifications domain).

### F-09 Plan mode and plan approval

1. With the permission mode set to **计划模式 / Plan**, the agent only analyses and
   then submits a plan.
2. The plan appears as a reading card ("execution plan") in the transcript; plans over
   ~1,400 characters start folded with "show full text". While it is being written the
   card says so.
3. While the agent waits, the card carries **批准并执行 / Approve and run** and
   **继续修改 / Keep revising**. "Keep revising" opens a note field ("what should
   change?") and **发回修改 / Send back**; an empty note sends a default "please
   revise" answer.
4. The status row reads "waiting for you to approve the plan". If the plan's row is
   not loaded in the transcript, the same card is shown above the composer instead.
5. Only the newest plan card carries the buttons.

### F-10 Answer a question from the agent

1. When the agent asks the owner a structured question, a question sheet **replaces
   the composer** until it is answered. Questions are shown one at a time with a short
   topic and "i/n" position.
2. Each question lists its options (label + optional description) as radio buttons or
   — for multi-select questions — check boxes, plus **其他 / Other**, which opens a free
   text field.
3. Buttons: **跳过 / Skip** (or "Skip all" when several questions) on the first
   question, **上一题 / Previous** afterwards; **下一题 / Next** or, on the last one,
   **提交 / Submit**. With a single question Submit is disabled until something is
   chosen or typed. Moving on without a choice leaves that question unanswered (the
   agent decides).
4. Skip answers nothing: the agent proceeds on its own judgement.
5. If the server will answer the question by itself after a deadline (see §5.6), the
   sheet states the clock time at which that happens and whether the recommended
   option will be taken or — when no option is marked recommended — the decision is
   left to the agent.
6. A malformed question (no usable text/options) still gets a sheet with Deny / Skip
   so the owner is never stuck without a composer.
7. After answering, the transcript shows each question with the chosen answer
   ("waiting for an answer" until then; "not answered" when skipped).
8. A long question scrolls inside its sheet; the buttons stay on screen.

### F-11 Attach images and files; mark up a picture

1. Ways to attach: the attach button (system photo/file picker), paste, drag-and-drop
   onto the composer (a "release to attach" overlay shows while dragging).
2. Limits: at most **10 attachments** per message, **10 MB** each. An oversized file is
   refused with a per-file error; the rest are kept.
3. Pending attachments appear as fixed-size tiles between the field and the toolbar
   (image thumbnail, or a file chip with its name), each with a remove button. Typing
   never moves or re-renders them.
4. A pasted screenshot is attached exactly once even when the platform delivers the
   same picture twice (same paste or two pastes); a genuinely different picture is a
   second attachment. A paste with both text and an image puts the text in the field
   and attaches the image.
5. Tapping the attach button must not dismiss the on-screen keyboard (the picker opens
   where the finger is).
6. Tapping an image thumbnail (pending or already sent) opens the full-screen image
   viewer: pinch/double-tap zoom (2.5× on double tap, up to 6×), pan, swipe or arrow
   keys between the images of that turn, swipe down or Esc or a close button to leave,
   download.
7. **标记 / Markup**: pen, circle, arrow, rectangle; five colours; undo and clear.
   **Reply with the marked image** flattens picture and marks into a PNG (long side at
   most 2,048 px), attaches it to the composer (replacing the original when it was a
   pending attachment; the stored original is never altered), closes the viewer and
   focuses the field.
8. Pending attachments belong to the conversation they were added in: they survive
   leaving the chat and returning, and never show up in another conversation.
9. Sent messages show their images above the bubble and other files as chips.

### F-12 Suggested next message

1. After a run finishes (nothing pending, nothing streaming), the product may offer one
   suggested next message.
2. With the field empty it is shown faintly inside the field. **Send or Enter sends it
   as is; Tab puts it into the field as editable text with the caret at the end**
   (without sending).
3. As soon as the field has text (typed or dictated) the suggestion moves to a one-line
   chip above the field with two actions: tap the text to replace the draft with it,
   or **发送 / Send** to send the suggestion and leave the draft out. Clearing the field
   brings the faint version back.
4. No suggestion is offered during a run, while editing a sent message, or while a
   quote is waiting. Once used or filled it does not reappear until the next answer.
5. Tab with text in the field, Shift+Tab, or Tab during an input-method composition
   never fills the suggestion. While a composition is in progress over the faint
   suggestion, nothing around the field may change (so the composition is not broken).

### F-13 Quote part of a message

1. The owner selects text inside one message (agent's or their own). A small
   **引用 / Quote** pill appears next to the selection (above it for a mouse; below it
   for a finger, clear of the system selection menu; after the touch selection has
   rested ~0.2 s).
2. Pressing it puts the text as a quote chip at the top of the composer card, releases
   the selection and focuses the field.
3. The next message that has text or an attachment goes out with the quote above the
   typed text (as a block quote), exactly once. An empty send leaves the quote
   waiting; a slash command goes out as typed and leaves the quote for the next
   message. The chip has a remove button; a removed quote is not sent.
4. A selection spanning more than one message, or outside message text, offers nothing.
   A quote belongs to the conversation it was picked in.

### F-14 Dictation

1. Where the browser offers speech recognition, a microphone button sits next to the
   send disc; otherwise it is absent.
2. Tap to start: recognised words appear live after the existing draft and listening
   continues across pauses until tapped again. Sending or clearing the draft ends
   dictation; editing the draft by hand makes the edited text the new base.
3. Permission denied or interruption produces a short notice. Leaving the chat turns
   the microphone off. Using a suggestion stops the microphone first so late words do
   not land in the field.
4. The recognition language is fixed to Simplified Chinese today; a language setting
   is an open question (§9).

### F-15 Slash commands, file mentions, input recall

1. Typing "/" at the start of the text or after whitespace opens a command list above
   the field, filtered as the owner types (prefix match on the name first, then
   substring, then description; debounced ~150 ms), ordered by how often each command
   was used in this project. ↑/↓ move, **Enter runs the highlighted (or first)
   command, Tab only completes its name** so arguments can be typed, Esc closes.
2. A message that starts with "/" and matches a known command is executed as a command
   rather than sent as a message. Built-in commands show their result in a dialog
   (help, model list, token/cost, status) or open settings / a memory file. Custom
   project or user commands expand into a prompt that is then sent; if a custom
   command embeds shell commands the owner is asked to confirm first. "Skill"-type
   entries are only inserted into the text (they are sent to the agent as typed).
3. Typing "@" opens a list of project files matching the text after it (name or path,
   at most 10 shown); Enter/Tab inserts the path; Esc closes.
4. With the field empty, ↑ recalls previously sent messages of this conversation
   (newest first, up to 100 kept per conversation on this device); ↓ walks forward and
   finally restores the draft.
5. The workbench composer has no dedicated slash-command button; typing "/" is the
   way in.

### F-16 Run a shell code block in the project's terminal

1. A fenced code block whose language is a shell (bash, sh, shell, zsh, console,
   shell-session, terminal) — or a fence with no language that contains nothing but
   commands (at most 8 non-blank lines, each a command, a comment or a continuation) —
   shows a **Run** button next to Copy, always visible (no hover needed), with a 44 px
   tap target.
2. One tap opens the terminal panel of the conversation's project, types the block
   into it and presses return. A transcript-style block ("$ command" followed by
   output) sends only the prompt lines without the "$".
3. The button shows "sent" for ~2 s. There is no Run button when the chat has no
   project terminal beside it (e.g. a read-only external session).
4. Other languages, inline code, empty blocks, program output, prose, file trees and
   long listings never get the button.

### F-17 Edit and resend an earlier message

1. Where the agent supports it and the session is idle, each of the owner's messages
   has an "edit and resend" action.
2. It loads the message into the composer; a banner explains that sending will replace
   that message and every reply after it, and that file changes already made are
   **not** undone. Cancel restores a normal composer.
3. On send, the old turn and everything after it leave the transcript on every device
   showing the session; the edited message appears in its place and a new run starts.
4. If background work from an earlier turn is still running, the owner is asked to
   confirm first (naming that work), because rewriting restarts the session and stops
   it.
5. Editing the very first message restarts the conversation from scratch.

### F-18 Find, open and resume sessions

1. Project scope: the history lists the project's sessions (agents and API-model
   conversations together), arranged as: **置顶 / Pinned**, the owner's **groups**,
   then day buckets **今天 / 昨天 / 本周 / 更早** (today; yesterday; the five calendar
   days before yesterday, so that "this week" is never empty on a Monday; earlier —
   all by the device's local calendar) by the time of the *last user message* (agent
   output does not reorder rows). The first 50 sessions load; "show earlier sessions" loads
   50 more.
2. The search field (⌘/Ctrl+K focuses it) filters rows whose title contains every word
   typed (case-insensitive). No match: a "nothing titled …" state with "clear search"
   and, if older pages exist, "load earlier sessions". Esc clears the query.
3. Each row: provider mark, title, a "draft" tag if the conversation holds unsent text,
   and either the time (clock time today/yesterday, weekday this week, date earlier) or
   the animated running mark; a red or white dot on the mark (F-05 step 7).
4. Tapping a row opens that session in place (phone: the sheet closes). The transcript
   opens **at its newest row** and stays there while rows render. Opening needs no
   special "resume" step: typing and sending continues the session with its recorded
   model, effort and working folder.
5. Older messages: the newest page (20 rows) loads first; scrolling to the top loads
   earlier pages; "show N earlier" reveals already-loaded rows outside the render
   window; "load full history" loads everything.
6. A session link whose session cannot be looked up **because the server is
   unreachable** shows "could not open this session" with **重试 / Retry** — it is never
   called "gone". Only a definite "not found" shows "this session no longer exists"
   with a button to start a new one.
7. All scope: see F-21.

### F-19 Organise sessions

1. Row menu ("…") or left-swipe on a row: **置顶 / Pin** (or unpin), **移到分组 / Move to
   group** (existing group, "new group" with a name, or "remove from group"),
   **重命名 / Rename** (inline; Enter or blur saves, Esc cancels; max 200 characters),
   **归档 / Archive**, **删除 / Delete**.
2. A row is in exactly one place: pinning removes it from its group; moving it into a
   group unpins it. Groups fold/unfold, can be renamed and removed (their rows return
   to the day list; nothing is deleted). Limits: 30 pinned rows, 20 groups per project
   (attempting a 21st shows a notice), 200 rows per group, group name 40 characters.
   The arrangement is an account preference: identical on every device.
3. Archive is immediate, shows a toast with **撤销 / Undo** (6 s), and moves the session
   to **已归档 / Archived** (a row at the foot of the history with a count, opening a
   list where each archived session can be restored or deleted). API-model
   conversations cannot be archived (only deleted).
4. Delete asks for confirmation in a sheet stating that the session and its transcript
   are removed permanently and suggesting Archive as the gentler option. Deleting an
   agent session also removes its transcript from the agent's own storage on disk.
5. If the open session is archived or deleted, the chat falls back to a new chat in
   the same project.
6. The session title can also be renamed by tapping it in the chat's title bar. A new
   chat (no session yet) and a stand-alone API-model conversation cannot be renamed.
7. Automatic names: a new session is named from its first message (at most four whole
   words); later the agent may propose a better title (§5.3) which replaces the
   automatic one but never a name the owner typed.

### F-20 Hand a conversation to another provider

1. In a started conversation the model menu still lists the other providers' models,
   with a note that switching service carries a summary along.
2. Picking one asks for confirmation in a sheet that names the target provider and
   model and explains that a summary of the conversation so far will be passed on and
   that the original session is kept. If a reply is still running the owner is told to
   wait; if the first message has not been delivered yet, to try again shortly.
3. On confirm: the chat shows the earlier conversation read-only above a divider
   "will hand over to <provider · model>" with: progress while the summary is built,
   the summary folded behind "view handoff summary" when ready, **取消交接 / Cancel
   handoff**, a retry on failure, and a link to the original session. While waiting,
   picking yet another provider retargets the handoff; picking the original provider
   cancels it.
4. The owner types the next message. It is sent to a **new session of the target
   provider in the same project**, with the summary appended invisibly; the transcript
   shows the owner's words with a fold "carried a handoff summary". If the summary
   could not be built the send is held and the draft kept.
5. The new session is recorded as the next stretch of one conversation. From then on
   the history shows the whole chain as **one row** (the chain's title, the latest
   provider's mark, the newest time; running if any stretch runs), opening it shows
   every earlier stretch above dividers "handed over to <provider · model> at <time>"
   with "open original session", and the chain is renamed, archived and deleted as a
   whole (delete removes every session in it; archive only if every stretch is an
   agent session).
6. Earlier stretches are read-only (no plan approval, no edit, nothing shown as
   running) and load lazily from the handoff point backwards as the owner scrolls up
   (40 rows per request; a failed page offers a retry; a stretch that no longer exists
   says so and earlier ones still load).
7. Only the latest stretch of a chain can be handed on; opening an earlier stretch on
   its own shows a note that it was handed over.
8. If recording the chain fails (after one automatic retry), the new session still
   works; a notice says the two sessions will appear separately in the history.
9. Same-provider model changes never create a handoff.

### F-21 See everything on the computer (All scope) and continue outside work

1. The All list shows, top to bottom: **正在运行 · N / Running** (every agent turn
   running on the computer now, whoever started it — the product, a terminal, a
   desktop app — with project name, title and elapsed time "just started / N min /
   H h M min"); **置顶 / Pinned**; then the newest sessions grouped by calendar day
   (今天, 昨天, "M月D日 weekday"); **已归档 / Archived** (folded, with restore). The
   list refreshes every 5 s while visible and immediately when the page becomes
   visible; a failed refresh keeps the last list and shows the reason with Retry.
2. Search matches every word against title **or** project name, including archived
   items.
3. A session that waits for the owner stays under Running and carries a red dot (not
   shown for the one on screen). A session holding unsent text says "draft".
4. Opening a session the product can drive (it lives where the server runs): it opens
   in the normal chat, indexed on demand if the product had not seen it yet; while it
   is being written from outside (a terminal turn), the chat re-reads it within about
   a second of each burst of writes and shows it as running; the owner can type into
   it like any other session.
5. Opening a session the product can only read (it lives in a location the server can
   read but cannot run agents in — for example, the other operating system of a
   dual-OS machine): a **read-only** view with the same transcript
   rendering, a quiet "runs on the computer, read-only" tag, live following, the run
   status row while it runs, and no composer.
6. **在 Studio 中继续 / Continue here** appears on a read-only session only when its
   working folder is reachable by the server. Tapping it prepares a summary (the
   button waits — "preparing summary…" — and ignores further taps), then opens a new
   conversation in that folder's project with a note naming the session being
   continued, the summary folded, a link to the original and Cancel. The first message
   carries the summary, built for whichever agent is selected at that moment.
7. Row actions (swipe or "…"): pin, archive, and — only for sessions the product
   holds — delete (with confirmation). For sessions it only reads, pin and archive
   are the owner's own marks (account-wide); archiving just hides the row here and
   nothing on the computer is touched. An archived session that runs again reappears
   under Running.
8. The scope switch keeps the conversation on screen when moving between scopes and,
   on a phone, keeps the list sheet open if it was open.

### F-22 Close the browser / lock the phone during a run, then come back

1. The run continues on the server with no viewer.
2. If notifications are configured, the owner is notified when it finishes, fails,
   needs approval or asks a question (unless that session is on screen somewhere).
3. On return (page shown again, network back, or a fresh load): the connection is
   re-established automatically (retry every 3 s, indefinitely); the open session's
   stored transcript tail is refreshed; the live stream resumes from the last event
   seen with nothing duplicated or missing; still-open permission prompts reappear;
   the running state, queue, recovery cards, usage figures and side-list marks are
   re-read.
4. A run that finished while away shows its full result from the stored transcript; no
   live replay is attempted for finished runs.
5. Session rows that finished while the device was away show the white dot (also
   across a server restart) until opened on any device.

### F-23 A message whose delivery is uncertain

1. If no receipt arrives within 20 s of sending, or the connection drops before the
   receipt, a banner above the composer says delivery is unconfirmed. The message
   stays visible as the newest turn marked "waiting for delivery confirmation". Send
   is blocked until this is settled (so one draft can never run twice), but the owner
   may keep typing a new draft.
2. The banner offers "review original message" (read-only text), **Check delivery**
   and **Retry original after review** (both disabled while offline).
3. Check asks the server whether it holds a receipt for that request id. If yes, the
   message is confirmed (as if the receipt had arrived) whatever state the run is in
   by now; nothing is re-sent.
4. Retry first performs the same check; only if the server definitely has no record
   is the **original** request re-submitted with the **same** request id and payload —
   even if the owner has since edited the composer (the new draft is kept).
5. If the check itself cannot be performed (offline, or an older server), nothing is
   re-sent and the banner says delivery could not be verified.
6. After a page reload the unconfirmed state is restored for that browser tab and
   checked automatically; attachments picked after the send are kept.
7. A definite refusal from the server (e.g. session busy) ends the pending state with
   "not sent — your draft and attachments were kept" and the reason.

### F-24 Recover after a server restart or a failed run

1. Runs that were in progress when the server stopped are marked interrupted on
   restart. **Nothing is re-run automatically.**
2. In the affected session a compact card appears above the composer: a warning glyph,
   **任务被中断 / Task interrupted** (or an "unfinished" title for a failed run), one
   line warning that part of the work may already have been carried out (and, when
   that was the cause, that a server restart interrupted it), and **查看 / View**,
   **继续 / Continue**, and a close ×.
3. View unfolds the original request read-only (max height with scrolling) and
   refreshes the transcript so the owner can see what already happened.
4. Continue — one tap, no draft, no keyboard — sends a fixed instruction to the same
   session: continue the interrupted task, check the current state first, do not
   repeat finished steps; followed by the original request. It uses the session's
   *current* model and permission mode; earlier approvals are not replayed. The card
   closes when the server accepts it. Continue is disabled while a run or an
   unconfirmed send is in flight.
5. × marks the record handled without running anything. A failed close keeps the card
   and says so.
6. Only one continuation can claim a record: if another device already continued or
   closed it, the card simply closes (no error).
7. The same records show as a red dot on the session row and in the task inbox.

### F-25 Background work

1. A turn may end while work it launched continues: sub-agents, backgrounded shell
   commands, multi-agent "workflows". The session then remains marked as working, and
   a **后台任务 / Background tasks** button appears at the top-right of the composer
   dock with a badge counting running tasks (or all tasks once none runs).
2. The button opens a sheet (side sheet on wide columns, bottom sheet on narrow ones;
   modal: focus moves in, Tab stays inside, Esc/×/backdrop close it and focus returns):
   a list, newest first, each with kind (sub-agent / background command / workflow),
   title, detail (agent type; "done/total agents" and current agent for a workflow),
   elapsed or total time, token use when known, the last output line for a command,
   and a status badge (running / done / failed / stopped).
3. Opening a task shows it read-only: a sub-agent's or workflow's own timeline of
   tool calls and prose (workflow: phases and agents, each agent openable), or a
   command's output tail (last ~4,000 characters). Esc steps back to the list, then
   closes.
4. For Claude Code, a new message sent while background work runs becomes a new turn
   of the same agent process, so the work keeps going and still reports back (no
   confirmation needed). Where a new turn would replace the process (other agents, or
   an edit-and-resend) the owner is asked first, with the work listed.
5. (Legacy chat surface) each running background task can be stopped individually.
   Whether the new workbench should offer per-task stop is an open question (§9).

### F-26 Check usage

1. **Context ring** (title bar, agent chats): a small ring with a percentage showing
   how full the session's context window is; orange from 80 %, red from 95 %. Hidden
   until a figure exists. Tapping opens a card: percent, "used / window" tokens, a
   meter, provider · model, the latest request's input, output and cache read/write
   tokens, (Codex) cumulative tokens counted separately, and — when nearly full — one
   line explaining that older conversation will be compacted automatically. Outside
   press, Esc or a second tap closes it.
2. **Usage panel** (foot of the project-scope side list): per provider, one line per
   plan window the owner chose to show (e.g. 5-hour, weekly, per-model windows,
   credits): label, thin bar, reset countdown, percentage; a header switch flips every
   figure between **剩余 / remaining** and **已用 / used**; bars turn to a warning
   colour at ≥ 90 % used. The panel folds to its header (remembered per device), which
   then still shows the first figure.
3. If any shown figure is stale a **可能过期 / may be out of date** flag appears; tapping
   it explains why in words and offers **立即刷新 / Refresh now**.
4. A second page (swipe sideways, mouse wheel, or the two dots) holds API balances and
   **重置卡 / reset credits**; it exists only when there is a balance or credit to show.
   "Use" on a reset-credit line asks first (showing the usage that would be reset and
   that it cannot be undone), then reports the outcome.
5. The same figures appear in each provider section of the model menu and in
   home-screen widgets; a chart button opens the usage app (token analysis per agent).

### F-27 Chat with an API model

1. Choosing an API model in the model menu (new chat) switches the column to an
   API-model chat: same title bar, transcript and composer, minus permission mode,
   effort, attachments and tools.
2. The first send creates the conversation in the project's space (creating that
   space automatically if the folder has none yet) and shows the owner's message at
   once, then a "thinking" line with elapsed seconds; the reply arrives **whole** (no
   token streaming).
3. Without a usable key the empty state says a key is missing and where to add it; the
   placeholder says "add a <provider> key first". A send attempted anyway is answered
   by the server with the real reason.
4. Errors show in a dismissible strip above the composer; a turn that got no answer is
   visibly marked as failed (inferred from the client: "not delivered" under the
   owner's bubble) and the text returns to the field so nothing typed is lost.
5. A started conversation's model is fixed (the menu says so). Other providers are
   offered only as a handoff.
6. Message length limit 16,000 characters (8,000 for the first message after a
   handoff, which also carries the summary).

### F-28 Drafts

1. Unsent text is kept per conversation (per session; per project for a not-yet-sent
   agent chat; per project space for a not-yet-sent API chat). It survives leaving the
   chat, reloading, and is synchronised to the owner's other devices.
2. A row whose conversation holds a draft says **草稿 / draft** (except the one on
   screen); the "new session" button says so when an unsent new chat holds text.
3. When a new chat with an unsent message is moved to another project (project
   switcher, or the project chip in All scope), the text — and, between two agent
   chats, the attachments — go along; text already waiting in the destination's new
   chat is swapped back rather than overwritten. Nothing moves when the composer is
   empty or blank, when the project is the same, or while a first message is on its
   way (so it cannot be offered for a second send elsewhere).
4. A message typed in an *open session* stays with that session when another project
   is picked.

### F-29 Sign an agent in / see that it is unavailable

Detailed in §4 (S-25) from the settings analysis; in short: each agent shows whether
it is installed and signed in and by which method; a sign-in flow can be started from
the product; an expired sign-in surfaces as a failed run with a readable reason and in
usage widgets as "not signed in".

### F-30 Keyboard summary (desktop / tablet with keyboard)

| Keys | Action |
| --- | --- |
| Enter / ⌘⏎ (Ctrl+Enter) | Send |
| Shift+Enter | New line |
| Shift+Tab (in the field) | Next permission mode (never "bypass") |
| Tab (empty field with suggestion) | Fill suggestion |
| ↑ / ↓ (empty field) | Recall sent messages |
| Esc | Deny the showing permission request; else stop the run; else go back |
| ⌘. | Stop the run (always) |
| ⌘/Ctrl+K | Focus session search |
| ⌘/Ctrl+N, ⌘⇧O | New session |
| ⌘/Ctrl+\ | Show/hide the side list |
| ⌘/Ctrl+J | Show/hide the inspector |
| ⌘[ | Back |

Inside the terminal panel, Ctrl-chords belong to the shell; only ⌘-chords act on the
workbench. Shortcut hints are shown only on devices with a fine pointer.

---

## 4. Screens and interaction requirements

General rules for every screen in this domain

- Touch targets are at least 44 × 44 pt even when the visible control is smaller.
- No text field renders below 16 px on touch screens (prevents the mobile browser's
  focus zoom).
- Every animated element respects "reduce motion" (fades instead of slides/springs).
- Every transient list state has a skeleton (shape of the content), never a blank area
  and never a bare spinner for primary content.
- Project folders/paths are never shown in lists; projects are shown by name.
- Toast durations: plain note ≈ 3 s; a toast with an action (Undo) ≈ 6 s; an error
  ≈ 7 s.
- Light and dark appearance; all labels reach 4.5:1 contrast on every workbench
  surface in both.

### S-01 Workbench shell

| Region | Phone | Tablet | Desktop |
| --- | --- | --- | --- |
| Side list (history) | Sheet from the left over a dimmed backdrop; modal (focus trapped, Esc closes, focus returns to the opener) | Docked 288 px column, collapsible | Docked 288 px column, collapsible |
| Chat column | Full screen | Remaining width | Remaining width |
| Inspector (files / terminal / git / preview — other domain) | Full-screen layer opened from one title-bar button | Floating panel over the chat | Docked, resizable (320–1100 px, default 440 px) |

- The side list's visibility, the inspector's open state/tab/width are remembered per
  device.
- When the side list is hidden, a "show session list" button appears at the left of the
  title bar. It carries a red dot while any session in the list needs the owner, else a
  white dot while one has an unseen result.
- **Touch:** a finger moving left-to-right over the chat column (starting away from the
  left screen edge, mostly horizontal, ≥ 56 px) opens the side list immediately, before
  the finger lifts. It must not trigger when the gesture starts on something that
  scrolls sideways, in a text field, while an overlay is open, or when the drag selects
  text. The very left screen edge remains the system/back swipe.
- **Back:** the side list's back control, ⌘[, a free Esc and the left-edge swipe return
  to wherever the workbench was opened from (home screen or another app page). Moving
  between sessions/projects *replaces* the history entry, so Back never walks through
  previously viewed sessions.
- The browser tab title is "<session title> · <project name>" while a session is open
  and is restored on leaving.
- If the chat column crashes while rendering, the side list and inspector keep working
  and the column shows an error state that reassures the owner the session itself is
  intact, with **Reload conversation** and **Start new session**.
- iOS on-screen keyboard: the shell follows the visible viewport so the composer always
  sits directly above the keyboard and the title bar stays at the top.

### S-02 Side list — Project scope

Top to bottom:

1. Header: Back (labelled with the page it returns to), scope switch (项目 | 全部), hide /
   close button.
2. Project switcher (other domain) — relevant here for its **activity marks**: each
   project row shows an animated running mark per agent currently working there (in
   that agent's colour/shape), a red dot when something there needs the owner, else a
   white dot when a session there finished unseen. The closed switcher shows only the
   dot (red wins over white) for *other* projects.
3. **新会话 / New session** button (shows the shortcut hint; announces "has an unsent
   draft" when applicable).
4. Search field (placeholder 搜索会话; shows ⌘K hint when empty on pointer devices).
5. History (see F-18/F-19): sections Pinned → groups → day buckets → "show earlier
   sessions" → Archived row. Rows animate in on first load only.
6. Usage panel (S-19).

States: loading (5 skeleton bars); load error with no rows ("…" + Retry); empty
project ("no sessions yet — start with New session"); search without matches; archived
view (loading / empty "no archived sessions" / list with restore + delete).

Row interactions: tap opens; "…" opens the row menu; **swipe left** (touch, mouse
drag, or two-finger trackpad swipe) reveals Pin / Archive / Delete (delete red, at the
far edge); only one row is open at a time; a vertical move is left to list scrolling;
a tap elsewhere, on the open row, or Esc closes it; right-click / menu key opens the
same actions. The active row has a highlight that glides between rows.

### S-03 Side list — All scope

Header as S-02 with 全部 selected; **New session**; search; then sections Running · N,
Pinned, day groups, Archived (folded; forced open while searching). Row: provider
mark (+ red dot), title, second line with pin glyph (if pinned and running), "draft"
tag, a small computer glyph for sessions that are read-only on the host side, and the
project name; trailing either running mark + elapsed or the time. States: skeleton;
error without data (+ Retry); "no title or project contains …" (+ clear search).
Elapsed times and day groups tick every 30 s without a refetch.

### S-04 Chat title bar

Left: side-list button (when hidden) and Back (when the docked list is hidden).
Then the provider mark (accessible name "provider · model"), the **session title**
(tap to rename in place where allowed; "New session" for an unsent chat) over the
**project name**. Right: the context ring (agent chats), then project tools owned by
other domains (the branch's pull-request chip, inspector buttons). In All scope a new
chat shows the **project chip** on the right instead of the project name under the
title. There is no model picker in the title bar.

### S-05 Transcript

Row kinds and their rendering:

| Kind | Rendering |
| --- | --- |
| Owner message | Right-aligned bubble; images above it (tap → viewer), file chips, then actions: edit-and-resend (when possible), copy, time (HH:MM). Pending states under the bubble: "sending…", "waiting for delivery confirmation", or (API chat) "not delivered". A first message that carried a handoff summary shows only the owner's words plus a fold with the summary. Line breaks typed by the owner are preserved. |
| Turn label | Provider mark + provider name + model that answered (when reported). One per agent turn. |
| Agent prose | Left-aligned rich text: headings, lists, tables (horizontally scrollable), block quotes, inline and fenced code with syntax highlighting, language label, Copy and (shell) Run; math (inline and display); diagram blocks (Mermaid syntax) rendered as diagrams; links. Under a finished reply: copy + time. A reply that grows for a long time must stay smooth (the cost of each update must not grow with the length of the reply), and a text selection the owner started must survive the reply finishing. |
| Tool stack | Consecutive tool calls (and the reasoning between them) as one inset list; each row: kind icon, verb, target, +added/−removed line counts for edits, status glyph (running spinner / done / error / denied / unfinished), chevron. Collapsed edit rows preview the first 2 changed lines. Stacks longer than 6 rows show the first 2 and last 3 with "expand N more steps". |
| Tool detail (on expand) | Command: the command line, the agent's description, output (last 12,000 characters, noting how much was omitted; error output tinted), "copy command". Edit/write: file path, diff (first 300 changed lines, then "N more — open the file"), "open file". Search: list of found files (first 60, each opens the file) or raw output. Read: path, line range, "open file". Reasoning: the text. Checklist: the list. Anything else (web, external tool servers): arguments, then result (first 12,000 characters). |
| Plan card | S-13. |
| Answered question | Each question with its answer / "waiting" / "not answered". |
| Sub-agent / workflow panel | Collapsible card: description, type, status, live timeline of the child's tool calls and prose; for workflows the phases and agents with per-agent state, tool count, tokens, duration; each agent's own transcript openable. |
| Notice | Error reported mid-run (red, non-terminal); background-task report (ok / warning); **context compaction** divider: "compacting context…", "compaction failed", or "context compacted · 725K → 41K" with a fold "view summary". |
| Run status row | S-06 (always last). |

Verbs used for tool rows (one vocabulary shared by rows, the status row and the
permission sheet): run (shell command), read, edit, write, search (content), find
files (name pattern), web search, open web page, update checklist, sub-task, submit
plan, ask. Unknown tools show their own name (tools from external tool servers as
"tool · server") and the first meaningful argument.

Loading and paging: skeleton while the first page loads; at the top either "loading
earlier messages", "show N earlier" (already loaded, outside the render window) or
"load full history". A thousand-turn session must scroll as smoothly as a short one,
and the scroll position must never jump as rows above or below load, grow or leave
the screen. Rows that arrive live rise into place; rows loaded from history do not
animate.

File references in prose (e.g. `src/app.ts:130`) open that file at that line in the
project's file viewer; folder references reveal the folder in the file tree. Images
referenced by a project-relative path are fetched through the authenticated project
files capability; **images from the web are not fetched until the reader taps them,
and then without a referrer**; inline data images show at once; a missing file falls
back to its alt text.

### S-06 Run status row

One line: glyph · activity text · checklist "d/t" · "N steps" · elapsed time ·
chevron (when details exist). States: composing (provider's animated mark, shimmering
text), tool working, **waiting for the owner** (raised-hand glyph; text names what is
awaited), finished ("turn finished"/"stopped" + time, check glyph, ~2.6 s). It has no
stop button of its own. Details (thinking tail, checklist, steps) as in F-05.

### S-07 Composer dock (agent chat)

Stacked above the field, in this order when present: "back to latest" button;
background-tasks button; one of {question sheet (replaces the composer), permission
sheet, plan card}; recovery card(s); delivery banner; queued-message list;
"editing a sent message" banner; then the composer card: quote chip, suggestion chip,
text field (placeholder "Message <agent>"), attachment strip, toolbar (attach,
permission-mode chip, model chip, effort chip, spacer, microphone, queue chip, send /
stop / steer / queue disc). Adding or removing any of these elements must keep the
transcript pinned to the bottom when it was at the bottom.

Send disc modes: Send (arrow), Stop (square; tooltip names Esc and ⌘.), Steer, Queue.
Disabled while a previous send is unconfirmed.

### S-08 Model menu

- Opens anchored to the model chip, upward, staying inside the viewport and scrolling
  internally rather than covering the composer; on a phone it is a bottom sheet over a
  dimmed backdrop. Closes on selection, outside press and Esc; arrow keys move.
- **最近使用 / Recently used**: up to 3 chips (provider mark + model) for the models
  used last on this device, excluding the current one.
- One section per provider, in fixed order, titled with mark + name and, at the end of
  the title, the provider's headline quota figure worded as the owner chose (e.g.
  "5 小时剩余 85%" or "余额 ¥…"), tinted as a warning at ≥ 90 % used.
- Each section lists at most the first 3 models plus the one in use; the rest are
  behind **更多模型 / More models**, which unfolds them in place. Row: name with
  version, a one-line description (long descriptions cut to their first clause),
  **推荐 / Recommended** badge on the recommended model, a check on the current one.
- When the current model has an extended-context ("1M") variant, a separate switch row
  toggles it in place; switching family keeps the switch on where the new family also
  has such a variant.
- API models are named in plain words, never raw ids. Models answered by the
  pay-as-you-go Claude API form their own section (hint: "billed per use · chat only").
- Footer notes explain the situation: in a started conversation, that switching to
  another service carries a summary along; in an earlier stretch of a handed-over
  chain, that the stretch was handed over and the latest session is the place to
  switch; in a started API conversation, that its model is fixed. A provider whose
  model list has not loaded offers a single "default model" row.
- Agents that the product has retired (hidden) are never listed anywhere.

### S-09 Effort popover

Title = current level in words, the model name (tapping it opens the model menu), a
reset button (disabled when already at the recommended level), a "?" that reveals a
one-line explanation, and a slider with one stop per supported level, end labels
"更快 / faster" and "更聪明 / smarter", "推荐" under the recommended stop. Drag snaps to
the nearest stop on release; tap picks the nearest stop; arrow / PageUp / PageDown
keys step, Home/End jump. It is exposed to assistive technology as a slider whose
value text is the level. Not shown for models without effort levels.

### S-10 Permission-mode menu

Title "权限（Shift+Tab 切换）". One radio row per mode the agent supports, each with a
label and a one-line hint:

| Mode (concept) | Label | Hint (paraphrased) |
| --- | --- | --- |
| Ask every time (default) | 每次询问 | asks before modifying files and before running commands |
| Auto-judge | 自动判断 | low-risk operations run directly; the rest are asked |
| Auto-accept edits | 自动改文件 | edits files directly; still asks before commands |
| Plan | 计划模式 | read-only analysis first, acts after the plan is approved |
| Bypass everything | 全部放行 | never asks; only for trusted projects — drawn in a danger tone |

The chip shows the current mode with a distinct icon for Plan and for Bypass.

### S-11 Permission sheet — see F-08. S-12 Question sheet — see F-10.

### S-13 Plan card — see F-09.

### S-14 Queued messages — see F-07.

### S-15 Delivery banner — see F-23.

What each state must communicate: *sending* — delivery is being confirmed and the
draft and attachments are safe meanwhile (the owner may already write the next
message); *unknown* — delivery is not confirmed, the owner should look at the
conversation before retrying the original, and anything typed since is safe;
*failed* — the message did not go out and nothing was lost. Two extra explanations
exist: delivery could not be verified, so nothing was re-sent; and the task being
continued was already continued or closed elsewhere.

### S-16 Recovery card — see F-24. At phone width it fills the column, text wraps and
every control is a 44 px target.

### S-17 Background-task sheet — see F-25.

### S-18 Context usage card — see F-26.

### S-19 Usage panel — see F-26. Additional states: loading (three pulsing dots);
a provider with nothing to show gets one line saying why ("not connected" / "no data
yet" for subscription agents; "not configured" / "no balance" for the API provider)
unless the owner switched all of that provider's items off; "no quota items to show".
The pager moves only sideways and snaps; it must never scroll vertically.

### S-20 Image viewer — see F-11. Modal; focus returns to the thumbnail on close.

### S-21 API-model chat column — see F-27.

### S-22 Handoff confirmation, pending divider and earlier stretches — see F-20.

### S-23 Read-only external session — see F-21 step 5. While the first read is
pending: skeleton; a failed read shows an alert line above whatever was last read; "no
messages yet" when empty. The first 300 rows are shown; "load full history" triples the
amount up to 5,000 rows. It follows new rows while the view is within ~80 px of the
bottom. Refresh cadence when live-follow is unavailable: every 3 s while running,
every 12 s otherwise, only while the page is visible.

### S-24 Stage states (centre column without a chat)

| Situation | Content |
| --- | --- |
| Projects still loading / session resolving | Transcript-shaped skeleton |
| No projects | "no projects yet" + how one appears + Back |
| Project list failed | "project list failed to load" + reason + Retry |
| Unknown project | "can't find this project (archived or deleted?)" + "open the most recent project" |
| Session not found | "this session no longer exists" + Start new session |
| Session unreachable | "could not open this session" + reason + Retry |
| External session cannot be opened | reason + Retry (unless definitely gone) + Start new session |

### S-25 Settings that belong to this domain

**Agent accounts** (one tab per offered agent)

- Connection status card: "checking…", "signed in as <account>" (or a generic
  "authenticated"), or "not connected"; badge Connected / Disconnected; an error line
  with the server's reason (e.g. sign-in expired, credentials unreadable).
- Login row (hidden when the agent authenticates with an API key): **Login** when not
  signed in, **Re-login** otherwise. It opens a modal containing a terminal that runs
  the agent CLI's own login command; the owner follows what the CLI prints (URL /
  code). The modal stays open after the command exits; status is re-checked on close.
- Warning box (subscription agents): shown only when a usable subscription sign-in is
  being **bypassed** by an API key configured in the server environment or the agent's
  settings — it names the variable, where it is set, the account being ignored, and
  how to fix it (the owner would otherwise be billed per use without noticing).
- A local agent that is not installed is presented distinctly from "not connected" —
  see §9.
- First-run onboarding offers the same sign-in cards, all optional.

**Tool permissions** (account-wide; saved automatically ~0.5 s after an edit with a
brief "saved" indicator; applied to every later send)

- Claude Code: a switch "skip permission prompts (use with caution)"; **Allowed
  tools** list with free-text add and quick-add chips for common entries (read-only git
  commands, the file read/edit/write/search tools, sub-task, checklist, web fetch/search);
  **Blocked tools** list. Pattern syntax: a tool name allows/blocks that tool; a shell
  entry of the form *tool(prefix:\*)* matches commands that start with that prefix
  (e.g. a specific git sub-command, or a destructive program to block). Duplicates and
  blanks are ignored. Examples are shown on the page.
- Codex: three radio cards — Default (workspace-limited sandbox; approvals cannot be
  granted interactively), Accept edits (commands auto-run inside the workspace),
  Bypass (full disk and network access; warning icon) — with a "technical details"
  disclosure and a note that the mode can be overridden per session in the chat.

**Models** (defaults for new sessions; account-wide, and also applied to this device)

- Per agent: default model (recommended one marked), extended-context switch (only when
  the model has such a variant), thinking effort ("model default" or one of the model's
  levels; "this model has no adjustable effort" otherwise). Changing the model keeps
  the effort only if the new model supports it.
- "Manage model list": rows with name and description/id, badges Recommended / Default;
  built-in rows can be **hidden** (never the last visible one) and restored from a
  "Hidden" section; custom rows can be edited/deleted. "Add model": id (≤ 200 chars, no
  whitespace) and display name (≤ 80 chars). Duplicate ids (including built-in ids,
  aliases and extended-context variants) are refused. Hiding or deleting the default
  clears the default; sessions using a deleted model fall back to the default model.
  If everything is hidden, the full list is shown rather than an empty menu.

**API providers**

- OpenAI-compatible provider: status Configured / Not configured (and "provided by the
  server" when the key comes from server-side configuration); key field + Save;
  **Verify connection** (a free models-list call, never a paid completion); Remove
  (only for a key the user saved). A switch "suggest the next message" (default on,
  account-wide).
- Pay-as-you-go Claude API: status Not enabled / Configured / Not configured. Saving
  or replacing the key requires the **product sign-in password again** (cleared after
  each attempt); Verify; Remove (works even when the feature is switched off on the
  server). When the server has the feature off: an explanatory notice, nothing can be
  saved. When usable: a switch "show in the model menu" (default on), a list of its
  models with hide/restore (the last visible one cannot be hidden), and a **balance**
  section (the provider exposes no balance to a key, so the owner notes the current
  balance in USD; the product subtracts its own tracked spend and shows "estimated
  balance", "spent since noted", "spent this month"; "needs checking" when ≤ 0).

**Usage display** — mode Remaining (default) / Used; one switch per quota item. Always
listed: the two plan-wide windows of the first subscription agent and the API
provider's balance; listed once reported: per-model windows, credits, every window of
the second agent. On by default: plan-wide windows and the balance; off by default:
per-model windows and credits. Each row previews its current figure and "(may be out
of date)". A "status" section lists providers with no figures and why. Stored per
device.

**Quick toggles** (legacy drawer): show raw tool parameters (off), show thinking (on),
send with Ctrl+Enter (off), voice (when configured).

### S-26 Usage app

- Agent picker (each subscription agent, the pay-as-you-go API, the API provider) and a
  "new session / new conversation" button for that agent; agent and period are part of
  the address.
- Quota section: one meter card per shown item (label, percentage remaining/used,
  bar, reset text and clock time; "reset time unknown"); freshness chip (age / "may be
  out of date" / "updated HH:MM"); for a gap, a one-word state, the server's sentence
  and "go to settings" when the owner can fix it.
- Token usage (agents and pay-as-you-go API): Day / Week / Month and Tokens / Cost
  switches; headline for the current bucket; stacked column chart by model (30 days,
  12 weeks, or 12 months; tap a column to select it; legend); six stats (input, output,
  cache write, cache read — each with share —, number of calls, estimated cost at list
  prices); lists "by model" and "by project" (top 8 then "N others"); footnote with the
  data source, "subscriptions are not billed per token; cost is an estimate", the time
  zone used and the last update. States: skeleton; load error + Retry; "analysis tool
  not installed"; "can't read usage right now" (earlier data still shown with a
  "showing previous data" chip); "no usage recorded yet".
- API provider: daily spend columns (14 days), calls and token stats, and a note that
  spend covers every user of the key while token counts cover only calls made through
  the product.

### S-27 Usage widgets (home screen; layout owned by the home-screen domain)

Small / medium / large tiles per provider: rings with "N % remaining|used", label and
reset caption ("near the limit" at ≥ 90 %); the large size adds rows and a footnote.
Header badge: age, "may be out of date", or the data source. States: skeleton; a
one-word gap (not signed in / not configured / key invalid / temporarily unreadable);
"no data"; "hidden in settings". Tap → that provider's page of the usage app, or, for
a gap the owner can fix, the relevant settings page.

### S-28 Task inbox

Status line (offline / checking / "checked at …"); four groups in fixed order with
counts — **待审批 / Waiting for approval** (question, plan, tool approval),
**需处理 / Needs handling** (failed, interrupted, interrupted by restart; button "mark
handled"), **查看结果 / Results** (unread finished runs of the last three days, one per
session; "mark read", "mark all read"), **进行中 / Running**. Row: icon, title, detail,
project · agent, relative time. A tap opens the session; Back returns to the inbox.
Marking only acknowledges — it never approves, runs or continues anything; it is
refused for running tasks and live approvals, and disabled while offline or stale.
Refresh every 15 s while visible plus on focus/online; on failure the previous list
stays with a "may be out of date" callout and Retry. Empty: "nothing to do".

### S-29 Stand-alone API chat app

Conversation list (local title search, per-row delete, empty states) and thread; on a
phone the thread is pushed over the list. Composer: text (≤ 16,000 characters, grows
to ~7 lines), Enter sends, model selector (locked once the conversation exists), send
or stop, suggested next message. Assistant bubbles show name, model tag and copy.
**Images in replies are never loaded here** (web images become plain links). Errors
appear in a banner with Retry; a failed send restores the text; lists are disabled
while a reply is pending. Delete asks for confirmation.

### S-30 Capabilities present only on the legacy chat surface

These are **not part of the phone-first workbench**. They are listed so that the new
product can place them deliberately (see §9):

- **Schedule a message**: presets (in 15 minutes, in an hour, in 8 hours, tomorrow) or
  a date-time; carries the current model, effort and permission mode; no attachments.
  Cards above the input show scheduled (cancel), "accepted — running" (no cancel) and
  "not sent — reason" (dismiss); refreshed every 5 s while unfinished.
- **Export conversation**: self-contained web page (collapsibles opened), Markdown
  (with tool calls and diffs), JSON (raw messages); file name from the title and date.
- **Copy as Markdown / as plain text** on assistant messages.
- **Read aloud** (one message at a time) and **record-to-transcribe** voice input via a
  configured voice backend.
- **Conversation search**: ≥ 2 characters, results streamed — title hits first, then
  content hits grouped by project and session with highlighted snippets and progress;
  clicking a hit opens the session, loads the full transcript, scrolls to the message
  and flashes it.
- **Fork session / fork from here**, **copy the agent's own session id**, **multi-select
  delete**, a "running" tab with a count, "recent conversations" paging (40 per page).
- **Per-task stop** in a background-task strip.
- **"Show thinking" toggle**, reasoning shown as "Thought for N seconds".
- **Command dialogs** for help, model list (with search and "manage models"), token
  usage, and system status.
- **Command palette** (⌘/Ctrl+K): new chat, settings, theme, navigation, sessions
  (including content matches), files, commits, branches.

---

## 5. Externally observable behaviour of the service

Described as capabilities: what a client may ask, what it gets back, guarantees,
limits and error cases. Transport, addressing and naming are the new implementation's
choice. Unless stated, every capability requires an authenticated user, answers are
never cached by intermediaries, and "refused" means a machine-readable error with a
human-readable reason and no side effect.

Two channels are assumed: a **request/response channel** (for reads and commands) and
a **live channel** (one persistent bidirectional connection per page, shared by all
features of that page).

### 5.1 Live channel basics

- Authentication happens when the connection is established; an unauthenticated or
  rejected connection never receives application events (answers: rejected
  credentials → "unauthorised"; rejected by an access gateway in front of the service
  → "forbidden"; too many attempts → "too many requests" with a retry-after hint).
- Client behaviour: one connection per page; on close, retry every **3 s** without
  backoff, indefinitely; after a successful *re*-connect every feature re-establishes
  its state (the server keeps no per-connection subscriptions across reconnects).
  Nothing sent while disconnected is queued by the transport.
- Server keep-alive: a probe every **30 s**; a connection that did not answer the
  previous probe is dropped (detection within 30–60 s).
- Protections: inbound message larger than **16 MiB** → connection closed with the
  standard "message too big" status; an outbound backlog above **8 MiB** on two
  consecutive keep-alive checks → connection dropped (one burst is tolerated);
  per-client and global handshake rate limits and concurrent-connection caps.
- A malformed or unknown client request is answered with a request-level error to that
  client only; it never terminates a run.
- Request-level errors are a distinct event class from errors produced *by an agent
  run* so that clients can tell "your request was invalid / never started" (no
  terminal event will follow) from "the run reported a problem" (a terminal event
  will still follow).

### 5.2 Sessions

**Create.** Input: provider, project folder, optional first message. Output: a new
stable session id (opaque, URL-safe) and an initial name = the first four
whitespace-separated words of the message, or a fixed "untitled" fallback. The id
exists before any agent work and never changes; the agent's own native id for the
conversation is an internal mapping that clients never need (one read-only capability
returns it on request for copy-to-terminal use, refused while not yet assigned).

**List by project.** Paged (default 20, max 200 per page; the workbench asks for 50),
ordered by **time of the last accepted user message** (falling back to creation time),
newest first, with a has-more flag. Each row: id, provider, title, last activity,
last user-message time. Archived sessions are excluded.

**Recent across projects.** Paged (default 40, max 100), newest activity first,
excluding archived sessions and archived projects.

**Details by id.** Accepts the canonical id or an agent-native id and returns the
canonical id, provider, title, timestamps, archived flag and owning project. Unknown →
not found; malformed id → invalid.

**History.** Input: session id, optional limit and offset counted **backwards from the
newest message** (offset 0 = newest page; pages are returned oldest-first). Output:
messages, total, has-more, and the stored token usage when known. No limit = whole
transcript. Rows are already normalised: a tool result is attached to its call;
standalone orphan results are dropped; oversized tool output is capped (observed:
40,000 characters with a note of how much was dropped); a sub-agent's timeline is a
preview (last 200 steps, each text ≤ 4,000 characters). A session that has never run
returns an empty page. Performance expectation (observed): paging through a
multi-megabyte, unchanged transcript answers each page quickly — the cost of a page
must not grow with the size of the whole transcript on every request — while rows
appended since the last read are always included.

**Rename.** 1–500 characters (the workbench UI limits to 200); marks the name as
user-set.

**Archive / restore / delete.** Archive hides; restore un-hides; delete removes the
record and — by default — the agent's transcript on disk, including transcripts left
behind by earlier edit-and-resend branches. A list of all archived sessions (with
project info) is available. New activity on an archived session un-archives it.

**Fork.** Input: session id, optional message to cut at, optional title. Output: a new
independent session (default title "<source> (fork)") with the conversation copied up
to the cut, and the source's model and effort. Refused when the provider cannot fork
or the source has never run. The source is never modified.

**Running list.** Returns every session that is working now: (a) runs started through
the product, (b) sessions whose turn has ended but whose background work is still
alive (flagged as background, not interruptible, with a task list: id, kind,
description, start time), (c) turns being driven from a terminal outside the product
(flagged, not interruptible, with a status text naming the CLI). Clients poll it every
**5 s**; a locally started run missing from a poll is kept for a **10 s** grace period.

**Search (legacy surface).** Input: query (≥ 2 characters), limit (default 50, max
100). Output is **streamed**: first title matches (substring, by match position then
recency), then per-project content matches with progress counters, then a terminal
"done" (or "failed"). Only non-archived sessions of the offered agents are searched;
at most 2 matches per session; snippets ≈ 150 characters with highlight offsets; a
multi-word query must match as a phrase.

**Discovery of outside sessions.** Sessions created by the agents outside the product
are indexed at start-up and watched continuously (observed: a new or changed outside
session becomes visible to clients within roughly 6–8 s, bursts of changes arriving as
one update per session), with their project derived from the working folder.
Sub-agent transcripts never appear as sessions. Title precedence: a name already stored by the product → the agent's custom
title → its AI-generated title → its last prompt / index name → "Untitled <agent>
session". Titles are whitespace-collapsed and cut to 120 characters. A session whose
transcript file has disappeared is dropped from the index — but only when its
containing folder still exists and the scan fully succeeded (so an unmounted disk
never wipes the index).

**Session-changed notice.** Whenever a session is created, renamed (including by
automatic titling), gains activity, or first learns its native id, the connected
clients of users allowed to see that session receive a per-session delta (id, provider, title, activity times, project). A delta
with an empty title must not blank a title the client already has.

### 5.3 Automatic titles proposed by the agent

While a run streams, the server watches the agent's prose for a line that **starts**
with a fixed marker phrase followed by a colon (existing marker: "建议会话名", ASCII or
full-width colon; leading markdown decoration allowed). The rest of the line, with
surrounding quotes/brackets/emphasis and trailing punctuation removed and whitespace
collapsed, becomes the session title if it is 2–60 characters and contains at least
one letter or digit. Ignored: user text, mentions mid-sentence, lines inside fenced
code, lines over 400 characters, placeholder names. The newest proposal wins. It is
applied **only** when the current name was never set or was set automatically; a name
the owner typed is never replaced. The marker line itself is hidden from the rendered
transcript (also while streaming). A change is announced as in 5.2.

### 5.4 Submitting a turn

Input: session id, text, a client-generated **request id** (1–200 characters; the
server generates one if absent), and options: model, effort, permission mode, tool
rules (allowed list, blocked list, skip-prompts flag), attachments (descriptors
returned by the upload capability), and a short session summary used for
notifications.

Rules:

1. The server trusts the client for the session id and the text only. Provider,
   project folder and the agent's native conversation id are taken from the server's
   record of the session. A client-supplied working folder is never honoured (see §7).
2. **Receipt before work.** The request is recorded durably (who, session, provider,
   project, content, safe subset of options, source = interactive / queued /
   scheduled) and a **receipt** (request id, run id, session id, duplicate flag,
   current state) is sent to the requester *before* any agent work starts.
3. **Idempotency**, keyed by (user, request id): the same id with identical content
   and options returns the same receipt, flagged as a duplicate, with the run's
   current state — nothing is executed again, even while the session is busy and even
   after a server restart. The same id with different content, target or options is
   refused as a conflict.
4. **One run per session.** If the session already has a run in progress the request
   is refused ("busy") and no receipt is stored.
5. Model and effort carried by an accepted request become the session's recorded
   choice.
6. Durable run states: accepted → running → one of completed / failed / aborted /
   interrupted. An error reported mid-run does not fail a run that later completes
   successfully; an error after completion (background work failing) does.
7. Attachments are accepted only if they are files previously uploaded through the
   product (5.15); anything else is silently dropped; duplicates collapse.
8. Refusals: missing/unknown session; unsupported provider; invalid request id; busy;
   could not record the request; conflict.

Client-side timing contract (observed): if no receipt arrives within **20 s** the
client treats delivery as unknown; a **receipt lookup by request id** is available
(returns the caller's own record or nothing) and is the only basis on which a client
may re-submit.

### 5.5 The live event stream of a run

- Events of a run are delivered to every connection **watching** that run: the
  connection that started it and every connection, authorised for the session, that
  asked to watch it while it was running. Unrelated connections do not receive them.
- Every event carries the session's stable id, the **run id** and a per-run **sequence
  number** starting at 1 and increasing by 1. Event classes: assistant text (whole
  blocks and/or incremental deltas with an end marker), reasoning, tool call, tool
  result (paired by call id), status (carrying the token budget, 5.13), informational
  error, permission request / resolved / cancelled, history-truncated (5.8),
  background-task status (5.9), and exactly **one terminal event** per run carrying
  success / aborted and an exit status. Duplicate terminal events never reach clients.
- **Watch / catch-up.** Input: up to 64 sessions, each with the last sequence number
  seen and the run id that number belongs to. For each session the server first sends
  an **acknowledgement** — is a run in progress, its run id, the list of still-pending
  approval requests (with any auto-answer deadline) — and only then replays the events
  after the given sequence number, followed by live events. If the client's run id
  differs from the current run, replay starts from the beginning of the current run.
- A run buffers its most recent **5,000** events for replay. A client further behind
  must reload the stored transcript.
- **Finished runs are never replayed**; their content is served from the stored
  transcript. A finished run remains addressable for about **5 minutes** (longer while
  it still has background work) so late watchers can attach to background events.
- When all clients disconnect nothing is cancelled. A run may also start with no
  watcher at all (queued or scheduled sends).
- The stored transcript is the source of truth: after every terminal event the client
  re-reads the newest page and reconciles (live rows that are now persisted disappear;
  rows not yet persisted remain; the owner's just-sent message never flashes away or
  appears twice).

### 5.6 Human approval

Applies to agents that support interactive approval (Claude Code). Codex has none:
its permission mode maps to sandbox and approval policy only (5.12).

- **Decision order for an ordinary tool call:** bypass mode → allowed without asking;
  otherwise a matching *blocked* rule → denied ("disallowed by settings"); otherwise a
  matching *allowed* rule → allowed; otherwise a **permission request** is raised.
  Rule matching: exact tool name, or for shell commands a prefix pattern on the
  command text.
- **Request event:** request id, tool name, the full tool input, session id; for
  questions an optional auto-answer time.
- **Answer:** request id, allow or deny, optional replacement input (used to return
  question answers), optional message (the reason given to the agent on deny, e.g. the
  owner's plan revision note), optional rule to remember. A remembered rule is added
  to the live run's allowed set (and removed from its blocked set) so identical later
  calls in the same run are not asked; persisting it for future runs is done through
  the account's tool-rules preference.
- Every answer is announced on the run's stream ("resolved"), so other devices and
  replays retract the prompt.
- **Timeout:** an ordinary request not answered within **55 s** (operator-configurable)
  is cancelled with reason "timeout" and the tool call is denied; the run continues.
  Stopping the run cancels pending requests with reason "cancelled".
- **Plan approval and questions never time out** by themselves and are never
  auto-allowed by rules. In the auto-judge and bypass modes the agent runtime may
  resolve them itself without consulting the owner; the intended behaviour is an open
  question (§9).
- **Default answer for questions:** if a question is still unanswered after **30
  minutes** (operator-configurable; 0 disables), the server answers it itself: for
  each question the option(s) whose label carries a "(Recommended)" / "（推荐）" marker
  (first one for single-select, all for multi-select), noting that the owner did not
  answer in time; questions without a recommended option are left unanswered. The
  request event tells clients when this will happen.
- A notification trigger is raised for every permission request (5.25).

### 5.7 Stop, steer and queue

- **Stop.** Input: session id. Refused when no run is in progress or the agent could
  not be stopped. On success watchers receive the single terminal event marked
  aborted. Stopping also ends that process's held background work.
- **Steer** (agents that support it). Input: session id, text and/or attachments,
  options, request id. Output to the requester: *steered* or *unavailable*. Steered
  text is taken by the running turn at its next tool boundary and echoed on the stream
  as a user message of that turn. If the turn had no further tool boundary but
  continues with a follow-up, the run's terminal event is deferred until the follow-up
  finishes. *Unavailable* (no running turn, unsupported agent) means the client should
  queue the message. Empty steer is refused.
- **Queue** (per user and session, server-side, survives restarts and is the same on
  all devices):
  - add (text and/or attachments + the send options captured at queue time) → item
    with id and time; list; edit text; remove; send-now.
  - Limits: **20** items per session; 200,000 characters per item; text or attachment
    required. Editing/removing an item that is gone → "no longer queued".
  - **Draining:** first-in-first-out, one item per turn, each as a normal durable
    run. An item is taken shortly (≈ 0.3 s) after a run ends, after add/send-now, and
    on a 30 s safety poll. The queue **waits** while a run is in progress, while the
    previous queued turn has not settled, while background work of the session is
    outstanding, or while the agent's CLI is busy with that session in a terminal.
  - When an item is taken, connected clients are told (with the item), so they can
    show it as the owner's turn.
  - A taken item that cannot start becomes an interrupted record (5.10) and is never
    silently re-queued; a provider failure makes it a failed, recoverable record.
  - **Send-now outcomes:** *steered* (taken into the running turn and removed);
    *interrupted* (non-steerable run stopped, item first in line); *next* (steer missed
    or nothing running: item moved to the front and dispatched).
  - Queue changes are announced to the owner's devices so each refreshes its list.

### 5.8 Edit and resend

Input: as a normal send plus the identity of the user message to replace (each user
message in history carries such an anchor when it can be edited). Supported for Claude
Code and Codex; refused for agents that cannot re-run from a point, for a missing
anchor, or an anchor no longer in the transcript. After admission the first event of
the new run tells all watchers to drop the anchored message and everything after it;
then the run proceeds from the turn before the anchor (editing the first message
restarts the conversation). A refused edit (e.g. busy) must not alter the
conversation. Nothing is deleted from the agent's storage by an edit; superseded
branches are hidden from history and discovery and removed only by a permanent delete.
File changes made by the superseded turns are not reverted.

### 5.9 Background work and task telemetry

- After its terminal event a run may remain **held** while work it launched continues
  (background shell commands, sub-agents not explicitly run in the foreground,
  workflows, scheduled wake-ups/monitors). During a hold the session is not "in
  progress" (the composer is usable), but appears in the running list as background
  work, and its later events (same run id, increasing sequence) reach watchers.
- A held process is released when its last outstanding task ends, when the run is
  stopped, or after **30 minutes** without any event.
- A new message during a hold becomes a new turn of the same agent process when
  nothing essential changed (same folder, same effort, tool rules only widened, not an
  edit); model and permission mode are applied live. Otherwise a new process starts
  and the held one, with its work, is ended — the client must ask the owner first.
- **Stop one task.** Input: session id + task id. Refused for an unknown task or
  session. Success is reported on the stream as that task's status becoming stopped.
- **Task status events:** started / progress / updated / notification, with task id,
  the launching tool call's id, kind, description, status (running, completed,
  failed, stopped), summary, usage (total tokens, tool uses, duration) and, for
  workflows, per-agent rows (label, phase, model, state queued/running/done/failed,
  last tool, tokens, tool calls, duration, result preview).
- In stored history, unreported asynchronous work reads as running only if the process
  that launched it is still alive; otherwise stopped. A workflow agent's own
  transcript can be read on demand.

### 5.10 Restart and recovery

- On start-up, before accepting connections, every run still recorded as accepted or
  running becomes **interrupted**; nothing is re-run. A late result from the previous
  process can never overwrite that state.
- **Recovery list.** Returns the caller's own interrupted or failed runs that are
  neither dismissed nor already continued, newest first; filterable by project, by
  session, or "without a session"; limit 1–100 (default 50). Each record: run id,
  request id, session, provider, project, original content, source, state, times,
  error text (≤ 2,000 characters) and whether it was interrupted by a restart.
- **Continue** = a normal send that names the record it continues. The claim is atomic
  and single: the record must belong to the caller, be unresolved and unclaimed, and
  match session, provider and project; a second claim is refused ("no longer
  available"); a busy session refuses and releases the claim. The receipt names the
  continued record so every device can close its card. A continuation that fails is
  itself recoverable. The continuation text is fixed (continue; check the current
  state first; do not repeat completed steps; then the original request) and must not
  nest when a continuation is continued.
- **Dismiss.** Marks the record handled without running anything. Already handled →
  success with an "already handled" flag; unknown or foreign → not found.
- Clients learn of an interruption through: the watch acknowledgement (no run), a
  duplicate receipt reporting the interrupted state, the recovery list, the task
  inbox, and one notification trigger per affected session.

### 5.11 Scheduled messages (legacy surface)

Create: session, text (1–100,000 characters), absolute time (at most 365 days ahead;
past times allowed), send options. States: pending → claimed → sent | failed;
cancelled. List per session (all states) or all pending. Cancel a pending one /
dismiss a failed one; anything else (including someone else's) is refused. Due
messages are picked up within 30 s, claimed exactly once, and run with no browser
attached; a message that became due during downtime fires on the first pass after
start-up. **A due message interrupts a run in progress** in its session (watchers see
that run end as aborted) and then starts; if the interruption fails the message is
marked failed. Failures store a reason (≤ 500 characters) and are never retried; a
restart during execution marks the message failed with an explanatory reason.
Deleting a session deletes its schedules.

### 5.12 Providers, capabilities, models

- **Capability matrix** (per provider): supported permission modes and the default;
  whether images, files, stop, interactive approvals, token usage, effort, message
  editing and forking are supported.

  | | Claude Code | Codex |
  | --- | --- | --- |
  | Permission modes | ask, auto-judge, accept edits, bypass, plan | ask, accept edits, bypass |
  | Interactive approvals | yes | no |
  | Steer | yes | no |
  | Background-work hold / task telemetry | yes | no (none reported) |
  | Live token budget events | yes | no (stored usage only) |
  | Edit-and-resend, fork | yes | yes |
  | Effort levels | per model | per model |

- **Mode mapping for Codex:** ask → writes confined to the workspace, approval on
  request (which cannot be granted interactively, so such actions do not proceed);
  accept edits → workspace-confined, never asks; bypass → full access, never asks.
- **Mode mapping for Claude Code:** the chosen mode is passed to the agent; the
  account's "skip prompts" switch forces bypass except in plan mode; plan mode
  restricts the agent to read-only and planning tools.
- **Sign-in status** (per provider): installed?; authenticated?; account label;
  method (subscription sign-in file / long-lived token from the environment / API
  key); error text when not usable (not installed, not signed in, sign-in expired,
  credentials unreadable); and, when an API key overrides a still-valid subscription
  sign-in, an override record naming the variable, where it is set, and the bypassed
  account. A subscription sign-in with an expired access token but a usable refresh
  token counts as signed in.
- **Model list** (per provider): ordered options (value, label, description,
  recommended flag, aliases, extended-context variant, effort levels with a default,
  custom flag) and the default model. Built-ins first, then custom models.
  - Subscription agent A: a static list, one row per model family at its current
    version, newest first; exactly one recommended (= default). The extended-context
    window is a *variant* of a row, not a row. Old alias values resolve to the row that
    replaced them; an extended-context request on a model without one runs the plain
    model; unknown ids pass through unchanged.
  - Subscription agent B: follows the model list the agent CLI itself currently
    offers on this machine (only publicly listed entries, in the CLI's priority order,
    with readable names and their effort levels); falls back to a curated list when
    that cannot be read.
  - **Custom models:** create (name ≤ 80, id ≤ 200 without whitespace), update, delete;
    duplicate ids (including built-in values, aliases, variants) are refused; built-ins
    cannot be changed.
- **Session model/effort:** read the active model and effort of a session (source:
  recorded for the session / the agent's own state / default); set either. Resume uses
  the recorded model. An effort the model does not support is dropped (the agent
  decides). The UI clamps to the nearest supported level in the order
  none < minimal < low < medium < high < x-high < max < top tiers.
- **Agent process environment:** agents run with the host user's environment minus the
  product's own secrets and server settings.
- A retired provider is excluded from discovery, lists and pickers and is not used for
  new runs; old records naming it remain readable.

### 5.13 Token and context usage

- **Live (Claude Code):** during a run, a budget update per main-thread assistant
  message: used, window size, input (direct + cache read + cache write), output, cache
  read, cache write. Sub-agent traffic does not move the parent's budget. Clients
  apply an update only to the session it names.
- **Stored (per session):** the same shape from the newest assistant turn (answering
  quickly even for very large transcripts). Codex: used = the latest request's total,
  window = the model's reported window (omitted, never guessed, when unknown — the
  ring is then hidden), plus a separately labelled cumulative total. Agents without
  usage tracking answer "unsupported".
- **Window size precedence:** operator override → the window reported by the agent
  runtime → 1,000,000 when the model is an extended-context variant or usage already
  exceeds 200,000 → 200,000.
- After a compaction the figure drops accordingly while cumulative accounting keeps
  growing.

### 5.14 Slash commands

- **List** for a project: built-in commands (help, model list, cost/tokens, memory
  file, open settings, status) and custom commands discovered from the project's and
  the user's command folders (name from the file path, description from front-matter
  or first line), plus the agent's skills.
- **Execute:** built-ins return structured data for a dialog (help text and command
  list; current and available models; token usage and context window; version,
  uptime, provider, model, platform, memory). Custom commands return their expanded
  prompt (all-arguments and positional placeholders substituted) together with flags
  saying whether it embeds shell commands or file includes; **the server executes
  nothing** — the client sends the expanded prompt as a message after confirmation.
  A custom command outside the two command folders is refused; unknown → not found.

### 5.15 Uploads for attachments

Upload up to **10 files of ≤ 10 MiB each**, any type, in one request; each is stored
under a server-chosen name in a per-installation upload store and described by name,
stored path, size and media type. Stored files can be fetched back by name
(names containing path separators or traversal are refused; content-type sniffing is
disabled; non-image files and vector images are served as downloads). What reaches
the agent: raster images (JPEG, PNG, GIF, WebP) as images; every other file as a
referenced path the agent can read; an image-only message gets a default instruction
where the agent requires text. Images may only be read from the upload store or the
run's project folder (symlinks escaping these are refused).

### 5.16 API-model chat

- **Spaces:** a general space per API provider and one space per project; all
  conversations are private to their owner. An unknown or foreign space/conversation
  → refused / not found.
- **Status:** per API provider, whether a key is configured (and whether it is the
  user's or server-provided) and the models offered.
- **Conversations:** create (model, space) → empty conversation; list per space (≤ 100,
  by last user-message time); get with messages (role, text, status complete/error);
  delete (refused while a reply is pending). No rename.
- **Send:** text 1–16,000 characters (+ optional opt-in context flag). Returns the
  whole updated conversation when the reply is complete — **no streaming**. One
  pending reply per conversation (a second send is refused "still replying").
  Refused before anything is stored when no key exists. Context = the last 40
  completed messages; if history + new text exceeds 100,000 characters → refused
  ("too long, start a new conversation"). The first message's first 40 characters
  become the title. Closing the request cancels the reply; the turn is stored as an
  error row ("stopped") which is excluded from later context.
- **Upstream handling:** one completion per round (bounded output, 120 s timeout,
  redirects refused); failures become generic messages with the upstream status code
  but **never the upstream body**; an empty answer is an error.
- **Project framing:** in a project space the model is told the project's name and
  description as background data, explicitly not as instructions.
- **Note tools (when the shared-notes service is available):** search, read, write;
  at most 4 tool calls per reply, after which the model must answer; a project
  conversation may read its project's notes and the global notes, the general space
  only global; writes are validated, size-limited and tagged with the model's name;
  notes that look like credentials are withheld; if the notes service is down the
  reply proceeds without tools.
- **Keys:** save (basic shape validation), verify (models-list call; never a paid
  call), remove. Stored encrypted with a per-installation master key, one per user,
  never returned to any client. A server-side key file may act as fallback (a saved
  key wins).
- **Pay-as-you-go Claude API:** off unless the operator enables it (when off: save and
  verify are refused, nothing is stored, an earlier key is unused but removable).
  Saving requires the user's password again. Only genuine API keys are accepted —
  subscription sign-in tokens and organisation-admin keys are refused with specific
  messages, never echoing the value. Requests: one non-streamed call with prompt
  caching, larger output budget, 300 s timeout, one retry after 1.5 s for transient
  server statuses only. Outcomes are explained (invalid key, insufficient balance,
  model not allowed, conversation too long, rate limited, busy, declined, truncated —
  truncated text is kept with a note). Every response, including declined, truncated
  and empty ones, is recorded in a **spend ledger** per user, priced at the provider's
  public list prices for the answering model (cache writes ×1.25 for 5-minute and ×2
  for 1-hour lifetime; unknown models cost 0 and show as "unpriced"). Usage summary:
  enabled, configured, noted balance (amount, when noted, spent since, remaining —
  may be negative), today, this month, 14 daily rows (cost, calls, tokens). Balance
  note: 0–1,000,000 USD, rounded to cents; clearing forgets it. Recording never fails
  a reply.

### 5.17 Handoff and conversation chains

- **Build a handoff.** Input: project, source (agent session or API conversation,
  with its model label), target provider. Output: a human-readable **summary** and a
  **context block** to append to the owner's next message. Refused: source not in the
  project / not the caller's; same provider ("no handoff needed to change model");
  source is not the latest stretch of its chain.
- **The summary is deterministic — no model is called.** At most ~7,000 characters,
  in this order: header (source and number of owner messages); **Goal** (first owner
  message, ≤ 600 chars); **Owner's last request** (when more than one, ≤ 1,200);
  **Current state** (the source's final answer, ≤ 1,500); **Earlier conclusions and
  decisions** (final answers of earlier turns, ≤ 280 each, latest 8, with a count of
  omitted ones); **Files changed** (latest 30, with edit counts); **Commands run**
  (latest 10, ≤ 160 each); **Open questions** (up to 5 question sentences from the
  last answer); **What the owner said, in order** (numbered, ≤ 300 each); **Earlier
  summary** (≤ 1,500; when the source itself began from a handoff or was compacted,
  that earlier summary is carried here — never as the owner's words). Answers are
  condensed (code blocks replaced by a placeholder, markup removed). When over budget:
  drop oldest owner messages, then oldest conclusions, then shorten the earlier
  summary, then clip. An empty conversation still yields a summary saying so. An
  API-conversation source uses completed messages only.
- **The context block** is a clearly delimited section that states who handled the
  conversation before (provider and model) and who continues, that the owner's new
  message above it takes precedence, and target-specific advice: an agent target is
  told the summary is only background and to inspect project files and version-control
  state itself before acting; an API-model target is told it cannot see project files.
  In stored history, the first message of the new session contains the owner's text
  followed by this block; clients show the owner's text and fold the block.
- **Record a chain.** Input: project, title, from-session, to-session (kind, provider,
  model label). Creates the chain on the first handoff (title ≤ 80) or appends a
  segment (provider, session, model label, handoff time). A session belongs to at most
  one chain. List chains per project (newest updated first); rename; forget (sessions
  become plain rows again). Foreign/unknown → not found.
- **Project space for API chat.** A project folder without a space gets one created on
  demand (once per user and folder).

### 5.18 Everything on the computer

- **List.** Returns: running turns; the **30** most recently active sessions (not
  repeating running ones); the machine views scanned; the scan time. Per entry: a
  composite id (agent, machine view, native id), agent, machine view, title (≤ 80
  chars; from the agent's index/own title/first prompt, else the folder), working
  folder (shown home-relative), project path if locally reachable, which client drives
  it (desktop app / terminal / editor extension / background / the product itself),
  running, **waiting** (stopped mid-turn for its owner), turn start time, last update,
  the product's own project+session ids when it knows the session, and whether the
  product is driving it. Excluded unless running: sessions the user archived.
  Always excluded: sub-agent transcripts. A listing may be a few seconds old.
- **Running rule:** agent A — the agent's own "open session" record says busy or
  waiting (and the process is alive where that can be checked; otherwise the record or
  transcript moved within 30 minutes); agent B — its log shows an open turn and moved
  within 30 minutes; any session the product is driving is running regardless.
- **Open (drivable sessions).** Indexes the session on demand and returns project +
  session ids. Refused for read-only machine views, for sessions without content, or
  unknown ids.
- **Read transcript (read-only sessions).** Input: id, optional version seen, limit
  (default 300, 1–5,000). Unchanged version → "unchanged" + current entry state;
  otherwise the newest rows, total, has-more, version, and whether it can be continued.
  Transcripts over 40 MB are refused ("too large — view it on the computer").
- **Continue (read-only sessions).** Input: id, target provider. Allowed only when the
  session's working folder exists where the server can run agents (else refused);
  registers the project if new; returns project id, title, summary and context block
  (as 5.17, source labelled with machine view and agent).
- Ids are validated before any file access; anything resolving outside the agents' own
  storage is not found.

### 5.19 Follow, presence, activity

- **Follow a transcript.** A connection may follow up to **4** targets (a session id or
  a computer-list entry id); a fifth silently replaces the oldest. Reply: following /
  unavailable (client keeps polling). While followed, each burst of writes produces
  one "changed" event (≈ 150 ms settle), including writes by sub-agents that start
  later. **No events are sent while the product itself is driving the session** (its
  run stream already covers it). Closing the connection ends all follows.
- **Presence.** A connection reports the session ids on screen (≤ 32) and whether the
  page is visible; each report replaces the previous; closing forgets it. Effects:
  notifications for an on-screen session are suppressed; that user's finished results
  in those sessions are marked read; "finished, unseen" marks are cleared. Failed and
  interrupted runs are never auto-read.
- **Activity summary.** Per project (idle projects omitted): number of running
  sessions and the agents running; **attention** count + session ids (a running
  session with a pending approval/question; unresolved failed or interrupted runs);
  **unseen** count + session ids (a run or API reply that ended while no visible page
  showed the session; never counted if already in attention). Cleared by viewing the
  session, by acknowledging it in the inbox, or by the session running again. Unseen
  marks persist across restarts (bounded, oldest dropped). Every change triggers one
  coalesced "activity changed" hint (≈ 250 ms) to that user's connected clients, which re-read
  the summary; clients also poll (30 s connected, 10 s disconnected, when visible).

### 5.20 Plan usage ("quota")

- **Read.** Returns one snapshot per provider: available?, a list of windows (id,
  label such as 5-hour / weekly / daily / per-model, used percent 0–100 with one
  decimal, window length, reset time, optional model), balances (currency, total,
  granted, topped-up), credits, **source** (official account data / live usage
  endpoint / agent status-line snapshot / agent event / local log / unavailable),
  observed time, **stale** flag, a human-readable **note** explaining any degradation,
  a **problem** category (signed out / not configured / key invalid / unavailable),
  optional daily usage rows, optional number of redeemable reset credits.
- **Freshness.** An ordinary read may return a snapshot up to 60 s old per provider;
  a **fresh** read (all providers, or one named provider) lowers that to 10 s;
  concurrent reads never cause duplicate upstream reads; each upstream read has a 20 s
  deadline, and a failed read is reported (with a note) for the same period as a
  successful one.
- **Subscription agent A** — sources in order of preference: (1) live account usage
  using the machine's subscription sign-in (short timeout; reused for 5 min, 2 min on
  a fresh read; a sign-in about to expire is not used and **never refreshed by the
  product**); (2) the **last good reading**, used only during rate limiting, outages
  or an expired sign-in, with a note "…showing the reading from N minutes ago", stale
  after 15 minutes or once a reset time has passed, persisted across restarts;
  (3) a local snapshot written by the agent itself, stale once a reset passed or it is
  older than 6 hours; (4) unavailable with a note (not signed in; API-key sign-in has
  no plan windows; sign-in expired — renews on next agent run; sign-in rejected; too
  many queries; endpoint unreachable; no data yet).
  Back-off after failures: 5 minutes; consecutive rate-limit answers 5 → 10 → 20 → 40
  → 60 minutes (a longer server-provided retry hint wins, capped at 60); a fresh read
  never bypasses a back-off; a rejected sign-in never lets an old reading stand in.
- **Subscription agent B** — (1) official account limits via the agent's own service
  interface (12 s deadline), including reset-credit count and a "limit reached" note;
  (2) the newest usage event in recent local session logs (stale after 15 minutes or a
  passed reset; note that the official source was unavailable); (3) signed-out note.
- **API provider** — balance read with the saved key (8 s timeout), notes for missing
  key / invalid key / unreachable / insufficient balance; 14 days of usage rows
  (spend derived from balance movement, calls and tokens counted only for calls made
  through the product).
- Subscription snapshots describe the machine and are the same for all users; API
  snapshots are per user and invalidated when the key changes.
- Tokens, answer values and parse errors are never logged.
- **Client polling contract:** a fresh read of agent A when a usage surface opens, when
  the page returns to the foreground (at most once per 5 s) and after each agent-A
  turn ends; an ordinary read every 60 s while visible; nothing while hidden; a failed
  read keeps the previous figures.
- **Redeem a reset credit.** Input: provider, client-generated idempotency key (16–64
  URL-safe characters). Outcomes: reset / already redeemed (same key) / nothing to
  reset (credit not spent) / no credit. Refused: malformed request (credit not spent);
  provider without credits; another redemption in flight. A timeout answers "unknown
  whether it was spent — retrying with the same key cannot spend a second one". The
  answer includes freshly read snapshots.

### 5.21 Token analysis

Input: agent (each subscription agent, or the caller's own pay-as-you-go API usage),
period (day / week / month), optional fresh flag. Output: time zone used, ordered
buckets without gaps (30 days, 12 Monday-to-Sunday weeks, or 12 calendar months, the
current one last), each with input, output, cache-write and cache-read tokens,
estimated cost, number of calls (unknown for one agent), and shares by model and by
project (sorted by cost, then tokens, then name); last sync time; first recorded day;
a problem flag (analysis tool not installed / failed) when the latest refresh failed —
earlier days are still returned. Subscription-agent figures are derived offline from
the agents' local logs by an external analysis tool (no network call), at most every
45 s (10 s when fresh), one refresh at a time; the first refresh reads everything,
later ones only recent days; a day is replaced only by a reading with at least as many
tokens, so history survives log pruning. Unknown agent → not found; bad period →
invalid.

### 5.22 Suggested next message

Input: which assistant, and the tail of the conversation as turns with roles user /
assistant / tool (1–24 turns, each ≤ 8,000 characters, total ≤ 60,000). Output: one
suggestion (≤ 120 characters) or none, and its source (model / local rule / none).
Nothing is suggested unless the last turn is the assistant's. With an API key, one
short, cheap model call (≈ 8 s timeout, cancelled if the client leaves) over the last
12 turns, condensed, with the conversation presented as labelled data; the model
answers a single line or a "none" token. Rate limit: 12 model calls per user per
minute. Without a key, past the limit, or on any failure: a local rule suggests a
short "OK, continue" only when the last answer ends by asking whether to proceed.
Clients ask ~0.7 s after the conversation settles, once per conversation state, cache
results for the page's lifetime, send at most the last 16 turns, and stay silent on
failure. The feature can be switched off per account. Nothing about the conversation
is logged.

### 5.23 Preferences and drafts

- **Preferences.** Read all; merge-patch (only the keys sent change; atomic); key
  1–200 characters; any JSON value. After a change every connected client of that user
  is told which keys changed (names only) and re-reads them; clients also re-read on return to
  the foreground. Used in this domain for: tool rules per agent, model defaults and
  hidden models, session arrangement (pins/groups) per project, marks for read-only
  sessions, last-used agent, the suggestion switch, quick toggles.
- **Drafts.** List all (scope, text, queued messages, time); save (scope 1–200
  characters; text ≤ 100,000 characters — longer is refused; empty text removes the
  draft unless a queue exists); delete. Clients save ~1 s after the last keystroke;
  on load the server copy wins except for scopes edited on this page whose save has
  not left yet. **Pending attachments are device-local** and never synchronised.
  Signing out clears local drafts, pending receipts and pending attachments.

### 5.24 Task inbox (shared with the home/notification domain)

- **Read.** Returns items in four categories, each newest first, plus has-more and the
  check time. Scope: the caller's own runs with the offered coding agents whose session
  and project exist and are not archived.
  1. *approval* — one item per **live** pending approval/question/plan of a run that
     is still alive in the current server process (never reconstructed from stored
     records; disappears on restart or resolution); shows the tool name when known.
  2. *needs handling* — failed or interrupted runs not yet dismissed or continued
     (≤ 100), with error text (≤ 240 chars) and the interrupted-by-restart flag.
  3. *result* — per session, the newest unread completed run finished within **72
     hours** (≤ 50); hidden while that session is running or awaiting approval.
  4. *running* — accepted or running (≤ 50).
  Item: id, kind, run id, session id, provider, project name, title (session name,
  else the first prompt line ≤ 90 chars), preview (≤ 240), state, time, and a link to
  the session.
- **Acknowledge one.** Marks a finished item read/handled. Unknown/foreign → not
  found; still running or awaiting approval → conflict; repeated → success with an
  "already handled" flag. Acknowledging a result also reads older results of that
  session. It never approves, runs, continues or changes a run's state.
- **Acknowledge many.** 1–100 run ids; only completed, unread results are marked; the
  rest are skipped; returns the count.

### 5.25 Notification triggers raised by this domain

Raised for: turn finished; background work finished (nothing outstanding); run
failed; run interrupted by restart (one per user and session); approval/question
required; an agent's own attention request. Suppressed when the session is on a
visible page of that user, when the user switched that event off, or when the same
event was raised within 20 s. Payload: title = session name (≤ 80 chars), event kind,
provider, and a link that opens the session in its project (falls back to the home
screen). Channels other than in-app/web push carry only a label, "project · session"
and the link — never message content or error text. Delivery, channels and settings
belong to the notifications domain.

### 5.26 External agent API (optional module)

Authentication by an API key in a request header (never in the address).
Input: message (required); a registered project and/or a repository URL to clone
(HTTPS URLs of the one supported hosting service only, without embedded credentials);
provider; model; effort; stream flag (default on); an existing session id to continue;
cleanup flag for fresh clones; optional hosting token; optional branch creation
(explicit or generated name) and pull-request creation. Behaviour: registers the run
exactly like a workbench send (listed while running; one run per session → conflict
when busy; continuing a session uses that session's own provider and project;
mismatch → invalid). **Nobody can answer an approval prompt during these runs**, so
what would need approval is decided up front by configuration (see §7.3). Streaming output:
a status event, the session id, the normalised run events with sequence numbers
through the terminal event, optional branch / pull-request / hosting-error events,
then a final "done"; failures after acceptance arrive as an error event. Non-streaming
output: success, aborted?, session ids, the assistant's text messages, token totals,
project path, branch and pull-request info. A run aborted from the workbench ends
without creating a branch or pull request and says so. Credentials are passed to the
version-control tool through a helper, never in arguments or stored remote addresses.

### 5.27 Voice backend (optional module, legacy surface)

Report whether a voice backend is configured; transcribe an uploaded recording
(≤ 25 MB) to text; synthesise speech for a text (streamed audio). The backend address
is server-configured only; link-local/metadata addresses are refused; upstream
authentication failures, time-outs and unreachability are mapped to distinct errors.

---

## 6. Black-box acceptance tests

**Test fixtures assumed** (to be provided by the new implementation's test harness;
none of them prescribes an architecture):

- *Scripted agent*: a stand-in agent provider whose behaviour per turn can be
  scripted: emit prose (whole or incremental), reasoning, tool calls and results, a
  checklist, a permission request for a given tool/input, a structured question, a
  plan for approval, a sub-agent or background command that outlives the turn, token
  budget updates, a compaction, a title-proposal line, a mid-run error, a failure, or
  run until told to finish. It exists in a "steerable, approval-capable" flavour (S)
  and a "non-steerable, no approvals" flavour (N).
- *Scripted API model*: a stand-in OpenAI-compatible endpoint with controllable delay,
  answer, status code and body.
- *Controls*: restart the server; drop/restore the client's network; advance the
  server clock; a second independent client ("device B") signed in as the same user; a
  second user ("user 2").
- "The chat" = the workbench chat column; "row" = a session row in the side list.

Each test lists the features it verifies.

### 6.1 Sending and delivery

**AT-WB-001** (WB-010, WB-100, WB-030)
Given a project with no sessions and a new chat open,
When the owner types "fix the login bug please now thanks" and presses Enter,
Then the message appears immediately as the newest turn; a session is created whose
initial title is the first four words; the address changes to that session without the
chat being re-created; and the agent's reply appears beneath it.

**AT-WB-002** (WB-010)
Given a composing input method with a candidate open,
When Enter is pressed to confirm the candidate,
Then no message is sent; a second Enter sends it.

**AT-WB-003** (WB-010)
Given text in the field,
When Shift+Enter is pressed, Then a line break is inserted and nothing is sent;
When ⌘/Ctrl+Enter is pressed, Then the message is sent.

**AT-WB-004** (WB-010, WB-011)
Given a message with one attachment still uploading,
When Send is tapped twice in quick succession,
Then exactly one run is started and one user turn exists in the stored transcript.

**AT-WB-005** (WB-011)
Given a send whose receipt has arrived,
When the same request (same request id, same content) is submitted again,
Then the server answers with the same run id flagged as duplicate and the agent is
not invoked a second time.

**AT-WB-006** (WB-011) — negative
Given a request id that was already used,
When a request with that id but different text is submitted,
Then it is refused as a conflict and nothing runs.

**AT-WB-007** (WB-012)
Given the network is cut immediately after Send so that no receipt arrives,
When 20 seconds pass,
Then the chat shows the message as "delivery unconfirmed", Send is disabled, the
field is editable, and "Check delivery" / "Retry original" are offered (disabled while
offline).

**AT-WB-008** (WB-012)
Given AT-WB-007 and the server did in fact accept the message,
When the network returns and the owner taps Check delivery (or simply waits for the
automatic check),
Then the message becomes confirmed, nothing is re-sent, and the transcript contains
the message exactly once.

**AT-WB-009** (WB-012)
Given an unconfirmed send that the server never received, and the owner has since
typed a different draft,
When the owner taps Retry original,
Then the original text (not the new draft) is submitted with the original request id,
and the new draft is still in the field afterwards.

**AT-WB-010** (WB-012) — negative
Given an unconfirmed send and a server that cannot answer the delivery lookup,
When the owner taps Retry original,
Then nothing is re-sent and the banner says delivery could not be verified.

**AT-WB-011** (WB-012)
Given an unconfirmed send,
When the page is reloaded,
Then the unconfirmed state is shown again, is checked automatically, and no second run
is started.

**AT-WB-012** (WB-010, WB-150) — negative
Given the live connection is down,
When the owner presses Send,
Then no session is created, nothing is uploaded, the draft and attachments remain, and
a "not sent" notice is shown.

**AT-WB-013** (WB-050) — negative
Given a session with a run in progress,
When a second client submits a normal send to the same session (bypassing the UI),
Then it is refused as busy, no receipt is stored, and the running run is unaffected.

**AT-WB-014** (WB-011) — negative
Given a session id that does not exist,
When a send is submitted,
Then it is refused ("session not found") and no run starts.

### 6.2 Attachments, quotes, suggestions, commands

**AT-WB-015** (WB-013)
Given 12 files are dropped on the composer, one of them 11 MB,
When the drop completes,
Then at most 10 tiles are shown, the 11 MB file is rejected with a per-file error, and
the rest can be sent.

**AT-WB-016** (WB-013)
Given the platform delivers the same pasted screenshot twice,
When the paste completes, Then exactly one attachment tile exists;
When a different screenshot is pasted, Then a second tile appears.

**AT-WB-017** (WB-013, WB-021)
Given an image attached in session A but not sent,
When the owner opens session B and returns to A,
Then B shows no attachment and A still shows it; removing it makes it stay removed
after a reload.

**AT-WB-018** (WB-013) — negative
Given a send whose attachment list names a file path outside the upload store,
When it is submitted directly to the service,
Then the foreign path is dropped and never reaches the agent.

**AT-WB-019** (WB-014)
Given a pending image attachment,
When the owner opens it, draws an arrow, and taps "reply with the marked image",
Then the viewer closes, the pending attachment is replaced by a PNG containing the
arrow (long side ≤ 2,048 px), and the field has focus.

**AT-WB-020** (WB-014)
Given a sent message with three images,
When the owner opens the second and swipes sideways (or presses →),
Then the third is shown; a downward swipe (or Esc) closes the viewer and focus returns
to the thumbnail.

**AT-WB-021** (WB-015)
Given text selected inside one agent reply,
When the owner presses Quote and sends "why?",
Then the sent message contains the quoted text above "why?"; the next message sent
contains no quote.

**AT-WB-022** (WB-015) — negative
Given a selection spanning two messages, Then no Quote control appears.
Given a waiting quote, When the owner sends a slash command, Then the command is sent
as typed and the quote still waits.

**AT-WB-023** (WB-016)
Given a finished answer and an empty field showing a suggestion,
When Tab is pressed, Then the suggestion is in the field as editable text and nothing
is sent; When instead Enter is pressed on the empty field, Then the suggestion is sent
as is.

**AT-WB-024** (WB-016)
Given a suggestion and typed text "abc",
Then the suggestion is shown as a chip; When its Send is tapped, Then the suggestion
is sent and "abc" is not part of the message; and no suggestion is shown while a run
is in progress.

**AT-WB-025** (WB-016) — negative
Given 13 suggestion requests from one user within a minute,
Then at most 12 reach the model; further ones are answered by the local rule or with
"none", never with an error visible to the owner.

**AT-WB-026** (WB-018)
Given the field contains "/" and the command list is open,
When Tab is pressed, Then the first command's name is completed in the field and not
executed; When Enter is pressed on a highlighted built-in command, Then its result
dialog opens and the field is cleared.

**AT-WB-027** (WB-018) — negative
Given a custom command that embeds shell commands,
When the owner runs it and declines the confirmation,
Then nothing is sent to the agent.

**AT-WB-028** (WB-019)
Given a project containing a file named `router.ts`,
When the owner types "@rout" and presses Enter,
Then the file's project-relative path is inserted in the text.

**AT-WB-029** (WB-042)
Given an agent reply containing a fenced `bash` block with two lines,
When the owner taps Run,
Then the project's terminal panel opens and receives exactly those two lines; the
button shows a "sent" state briefly.

**AT-WB-030** (WB-042) — negative
Given a fenced block tagged `python`, an inline code span, and an untagged fence
containing program output,
Then none of them shows a Run button; and in a read-only external session no block
shows one.

**AT-WB-031** (WB-041) — negative
Given an agent reply that embeds an image from a web address,
When the reply is rendered,
Then no request to that address is made until the reader taps the placeholder, and
the request then carries no referrer.

### 6.3 Live stream, reconnect, multi-client

**AT-WB-032** (WB-030, WB-032, WB-034)
Given the scripted agent emits prose, then a file edit, then a shell command, then
prose,
When the run executes,
Then the transcript shows, in order, a turn label, prose, one tool stack with two rows
(edit with +/− counts, command) whose status goes running → done, prose; and the run
status row shows the activity and a step count of 2, then "turn finished" with a
duration, then disappears.

**AT-WB-033** (WB-032)
Given a stack of 9 tool rows, Then 5 rows and an "expand 4 more" control are shown;
Given an edit row is expanded, Then its diff and an "open file" action are shown;
Given a command produced 50,000 characters of output, Then only its tail is shown with
a note of how much was omitted.

**AT-WB-034** (WB-050, WB-052)
Given a run in progress,
When the client's network is dropped for 30 s and restored,
Then the client reconnects by itself, the transcript ends up containing every event
exactly once in order, and the running state is correct.

**AT-WB-035** (WB-050)
Given a run in progress and the only client closes the page,
When the run finishes,
Then reopening the session later shows the complete result from stored history, and
the row had a "finished, unseen" mark until opened.

**AT-WB-036** (WB-051)
Given the same session open on devices A and B,
When A sends a message,
Then B shows the run as in progress within 5 s and, after (re)opening or reconnecting
during the run, shows the same live events as A; when the run ends both show the same
transcript.

**AT-WB-037** (WB-052) — negative
Given a run that has finished,
When a client subscribes with "nothing seen yet",
Then no live events are replayed for it (no duplicated rows); the content comes from
history only.

**AT-WB-038** (WB-052)
Given a client that last saw sequence 40 of run 1, and run 2 is now in progress,
When it subscribes naming run 1 and 40,
Then it receives run 2's events from the beginning.

**AT-WB-039** (WB-030) — negative
Given the scripted agent emits a mid-run error and then continues to a successful end,
Then the error appears as a notice row, the session stays "running" until the terminal
event, and the run is recorded as completed.

**AT-WB-040** (WB-038)
Given a session with 300 messages,
When it is opened,
Then the view is at the newest message, only the newest page was fetched first,
scrolling to the top loads earlier messages without moving what the reader is looking
at, and "load full history" ends with all 300 available.

**AT-WB-041** (WB-038)
Given the reader has scrolled up during a run,
When new output arrives, Then the view does not move and a "back to latest" control is
shown; tapping it returns to the newest row and resumes following.

**AT-WB-042** (WB-150, WB-153) — negative
Given a connection that stops answering keep-alive probes,
Then the server drops it within 60 s and the client reconnects automatically.
Given a single inbound message larger than 16 MiB, Then the connection is closed with
a "too big" status and no run is affected.

### 6.4 Stop, steer, queue, edit

**AT-WB-043** (WB-053)
Given a run in progress with some output,
When the owner taps the stop disc (or presses ⌘.),
Then the run ends once (aborted), the partial output remains, the status row says
"stopped", and the session is idle and accepts a new message.

**AT-WB-044** (WB-053) — negative
Given an idle session, When a stop is requested through the service, Then it is
refused ("no active run") and nothing changes.

**AT-WB-045** (WB-053, WB-071)
Given a permission sheet is showing during a run,
When Esc is pressed, Then that request is denied and the run continues;
When ⌘. is pressed instead, Then the run stops.

**AT-WB-046** (WB-054)
Given a running turn of the steerable agent (S) that will make further tool calls,
When the owner types "also update the README" and taps the disc,
Then the message is taken into the running turn, appears in the transcript at that
point exactly once, and the field is cleared.

**AT-WB-047** (WB-054, WB-055)
Given a turn of agent S that ends at the moment of steering,
When the steer cannot be taken,
Then the message is queued automatically and sent as the next turn; it is not lost and
not sent twice.

**AT-WB-048** (WB-055)
Given a running turn of the non-steerable agent (N),
When the owner sends three messages,
Then they are listed as queued 1–3 and, after the run ends, are sent in that order,
one turn each.

**AT-WB-049** (WB-055)
Given two queued messages and no browser connected,
When the current run ends,
Then the server still sends both in order; reconnecting later shows both turns.

**AT-WB-050** (WB-055)
Given a queued message during a non-steerable run,
When the owner chooses "interrupt and send",
Then the running turn ends as aborted and the chosen message is the next turn.

**AT-WB-051** (WB-055) — negative
Given 20 queued messages in one session, When a 21st is added, Then it is refused
("queue full") and the text stays in the field.
Given a queued message that has just been sent, When the owner saves an edit to it,
Then the edit fails with "may already have been sent".

**AT-WB-052** (WB-055, WB-057)
Given a queued message and background work still outstanding from the last turn,
Then the queue does not drain until that work has finished or been stopped.

**AT-WB-053** (WB-056)
Given a session with turns U1/A1/U2/A2 and an agent that supports editing,
When the owner edits U2 to "U2′" and sends,
Then U2 and A2 disappear from the transcript on every device showing the session, U2′
appears in their place, and a new answer follows.

**AT-WB-054** (WB-056) — negative
Given an edit of U2 submitted while a run is in progress,
Then it is refused as busy and the transcript still contains U2 and A2.
Given an anchor that no longer exists, Then the edit is refused and nothing changes.

### 6.5 Approvals, plans, questions

**AT-WB-055** (WB-071)
Given the mode "ask every time" and the agent requests to run `npm test`,
Then a sheet shows the agent's name, "wants to run a command", the exact command, and
Deny / Always allow / Allow;
When Allow is tapped, Then the command runs and the sheet disappears.

**AT-WB-056** (WB-071)
Given the same request, When Deny is tapped,
Then the tool row is shown as "denied" (not "error") and the run continues.

**AT-WB-057** (WB-071, WB-073)
Given three pending requests, two of them for `git status` and one for `rm -rf x`,
When the owner taps Always allow on the first `git status` request,
Then both `git status` requests are answered, the `rm` request is still pending, the
rule appears in the account's allowed-tools list, and a later `git status` in a new
run is not asked.

**AT-WB-058** (WB-073)
Given a blocked rule and an allowed rule that both match a command,
Then the command is denied without a prompt (blocked wins).

**AT-WB-059** (WB-072)
Given a pending ordinary tool request and nobody answers,
When the approval timeout (default 55 s) passes,
Then the request disappears on all clients, the tool row shows "denied", and the run
continues.

**AT-WB-060** (WB-072)
Given a pending request shown on devices A and B,
When A answers it, Then it disappears on B as well;
When a client reloads mid-run after it was answered, Then it does not reappear.

**AT-WB-061** (WB-072)
Given a pending request, When the client reloads before answering,
Then the request is shown again after the reload (restored from the watch
acknowledgement).

**AT-WB-062** (WB-070)
Given the mode chip shows "ask every time",
When Shift+Tab is pressed repeatedly in the field,
Then the modes cycle and "bypass everything" is never selected; it can be selected
only from the menu, where it is styled as dangerous.

**AT-WB-063** (WB-070)
Given the mode "bypass everything", When the agent runs a shell command, Then no
prompt appears.
Given the mode "accept edits", When the agent edits a file, Then no prompt appears;
When it runs a shell command not covered by a rule, Then a prompt appears.

**AT-WB-064** (WB-074)
Given plan mode and the agent submits a plan,
Then a plan card with Approve-and-run / Keep revising is shown and the status row says
it is waiting for approval;
When the owner chooses Keep revising, types "only touch the frontend" and sends it
back, Then the agent receives that note as the reason and the run continues.

**AT-WB-065** (WB-075)
Given the agent asks two questions (one single-choice, one multi-choice),
Then the composer is replaced by a question sheet showing "1/2";
When the owner picks an option, taps Next, picks two options plus "Other: x", and
submits, Then the agent receives each question's answer(s) and the transcript shows
them.

**AT-WB-066** (WB-075)
Given a question, When the owner taps Skip,
Then the agent receives no answers and continues; the transcript shows "not answered".

**AT-WB-067** (WB-075)
Given a question with one option marked recommended and the default-answer delay at
30 minutes,
Then the sheet states the time at which the recommended option will be taken;
When the clock passes that time with no answer, Then the question is answered with
the recommended option and the run continues.

**AT-WB-068** (WB-075) — negative
Given the default-answer delay set to 0 (disabled),
When a question waits for 2 hours, Then it is still pending.
Given a question without a recommended option and the delay elapsed, Then it is
returned unanswered (as Skip).

**AT-WB-069** (WB-075) — negative
Given a question request with an empty/malformed question list,
Then a sheet with Deny / Skip is still shown and the owner can get the composer back.

**AT-WB-070** (WB-108, WB-065)
Given session A waits for an approval while session B is on screen,
Then A's row, the hidden-list button and A's project in the switcher show a red dot,
and a notification trigger is raised; opening A clears the dot.

### 6.6 Background work

**AT-WB-071** (WB-057)
Given a turn that launches a background command and ends,
Then the session shows as working (background), the composer is usable, a
"background tasks" button with badge 1 appears, and the task list shows the command as
running with elapsed time.

**AT-WB-072** (WB-057)
Given AT-WB-071 with agent S, When the owner sends a new message,
Then no confirmation is asked, the background command keeps running and its
completion is still reported afterwards.

**AT-WB-073** (WB-076)
Given background work running and the owner edits-and-resends an earlier message,
Then a confirmation naming the running work is shown; declining sends nothing.

**AT-WB-074** (WB-058) — negative
Given a stop request for a task id the session does not have,
Then it is refused ("no such task") and other tasks are unaffected.

**AT-WB-075** (WB-036)
Given a turn that spawns a sub-agent,
Then the sub-agent's calls appear inside its own panel, not as top-level rows, and the
parent's context ring does not jump with the sub-agent's token use.

### 6.7 Restart and recovery

**AT-WB-076** (WB-059)
Given a run in progress, When the server is restarted,
Then after reconnecting the session is idle, a "task interrupted (by a restart)" card
is shown in that session, the run was **not** re-executed, and the row shows a red
dot.

**AT-WB-077** (WB-059)
Given AT-WB-076, When the owner taps Continue,
Then one new run starts in the same session whose prompt is the fixed continuation
instruction followed by the original request, using the session's current mode and
model; the card closes; the composer text (if any) is untouched.

**AT-WB-078** (WB-059) — negative
Given an interrupted record shown on devices A and B,
When both tap Continue, Then exactly one continuation runs; the other device's card
closes without an error.

**AT-WB-079** (WB-059)
Given an interrupted record, When the owner taps ×,
Then the record no longer appears in the session, the inbox or as a red dot, and
nothing was run. Tapping × on a record already handled elsewhere closes it silently.

**AT-WB-080** (WB-059, WB-011)
Given a send whose receipt was lost and then the server restarted mid-run,
When the client re-submits the same request id,
Then it receives a duplicate receipt with state "interrupted" and the agent is not
invoked.

**AT-WB-081** (WB-055, WB-059) — negative
Given a queued message that the server had taken but could not start before a crash,
When the server restarts,
Then the message appears as an interrupted record for manual continuation and is not
sent automatically.

**AT-WB-082** (WB-072) — negative
Given a pending approval when the server restarts,
Then after restart no approval is pending anywhere (approvals are never reconstructed
from records).

### 6.8 Providers, models, effort

**AT-WB-083** (WB-083)
Given a new chat, When the model menu is opened,
Then it lists every offered provider's models in sections, with at most three models
plus the current one per section and a "more models" control, and no retired provider.

**AT-WB-084** (WB-083, WB-086)
Given a new chat on provider X, When a model of provider Y is picked before the first
message, Then the chat is now a Y chat without reloading; the next "new session" also
starts with Y.

**AT-WB-085** (WB-086)
Given an open session, When another model of the same provider is picked,
Then the next turn runs on that model; reopening the session later (on another
device) shows that model selected.

**AT-WB-086** (WB-084)
Given a stored legacy model value that is an alias of a current model,
Then the menu shows the current model's row as selected (no fallback to the default),
and the extended-context switch reflects the stored variant.

**AT-WB-087** (WB-085)
Given a model supporting four effort levels and the current effort at the highest,
When a model supporting only three lower levels is picked,
Then the effort becomes that model's nearest supported level; a model with no effort
levels shows no effort control.

**AT-WB-088** (WB-087) — negative
Given a custom model id equal to a built-in model id, alias or variant,
When it is saved, Then it is refused as a duplicate. Built-in rows offer no edit or
delete.

**AT-WB-089** (WB-088, WB-152)
Given an agent that is not signed in,
Then its settings card shows "not connected" with the reason; a send to that agent
ends with a readable error row and a single terminal failure (the session is idle
afterwards).

**AT-WB-090** (WB-088)
Given a valid subscription sign-in and an API key configured in the environment,
Then the status reports the API key as the method in use together with an override
warning naming the variable and the bypassed account; with no valid sign-in there is
no warning.

**AT-WB-091** (WB-091) — negative
Given stored sessions of a retired provider and an address requesting a new chat with
it, Then those sessions are not listed and the new chat opens with the default agent.

### 6.9 Sessions

**AT-WB-092** (WB-101)
Given sessions whose last user messages were today, yesterday, three days ago and 30
days ago, Then the history shows them under the four day headings in that order;
streamed agent output in an older session does not move it above a session with a
newer user message.

**AT-WB-093** (WB-101)
Given 120 sessions in a project, Then 50 are loaded first and "show earlier sessions"
loads the next 50; a failed load shows a notice and the control remains for a retry.

**AT-WB-094** (WB-102)
Given titles "Deploy API" and "Fix API tests", When "api fix" is typed in the search,
Then only "Fix API tests" is listed; clearing restores the list.

**AT-WB-095** (WB-103, WB-104)
Given a session auto-named from its first message,
When the agent's reply contains a line "<marker>: Checkout redesign",
Then the session title becomes "Checkout redesign" on all devices and that line is not
visible in the transcript.
Given the owner then renames it to "Mine", When the agent proposes another title,
Then the title stays "Mine".

**AT-WB-096** (WB-104) — negative
Given a title proposal inside a fenced code block, mid-sentence, 1 character long, or
longer than 60 characters, Then the title does not change.

**AT-WB-097** (WB-105)
Given a row is pinned on device A, Then it is in the Pinned section on device B.
Given a pinned row is moved into a group, Then it is no longer pinned. Given 20 groups
exist, When another is created, Then it is refused with a notice.

**AT-WB-098** (WB-106)
Given an open session, When it is archived,
Then the row disappears, a toast offers Undo, the chat shows a new chat, and the
session is listed under Archived; Undo (or Restore) brings it back.

**AT-WB-099** (WB-107)
Given a session, When Delete is chosen and confirmed,
Then the session, its record and the agent's transcript are gone and its link shows
"no longer exists"; cancelling the confirmation deletes nothing.

**AT-WB-100** (WB-007) — negative
Given a valid session link and an unreachable server,
Then the page says the session could not be opened and offers Retry; it does not say
the session no longer exists. When the server returns and Retry is tapped, the session
opens.

**AT-WB-101** (WB-004)
Given a link naming session S under the wrong project, Then the address is corrected
to S's real project and S opens. Given a link using the agent's native id, Then it
resolves to the canonical session.

**AT-WB-102** (WB-003)
Given project P where session S (older than the first history page) was last on
screen, When P is opened without a target, Then S opens.

**AT-WB-103** (WB-021)
Given text typed in session A and not sent,
Then A's row shows "draft" when another session is open; after a reload, and on
device B, opening A shows the text; sending or clearing removes the tag.

**AT-WB-104** (WB-022)
Given a new chat in project P holding "hello" and an image,
When the owner picks project Q in the switcher,
Then Q's new chat holds "hello" and the image and P's new chat is empty; if Q's new
chat already held "old", then P's now holds "old".

**AT-WB-105** (WB-108)
Given session A finishes a run while session B is on screen,
Then A's row shows a white dot, also after a reload and after a server restart, until
A is opened on any device; if the run ended in failure the dot is red instead.

**AT-WB-106** (WB-109, WB-110, WB-060)
Given an agent turn started in a terminal outside the product,
Then within a few seconds it appears under Running in the All list with its project
and elapsed time, and the session appears in its project's history with a sensible
title; its row shows the running mark and cannot be stopped from the product.

**AT-WB-107** (WB-111)
Given such a session open in the chat, When the terminal turn writes new output,
Then the chat shows it within ~2 s without a manual refresh.

**AT-WB-108** (WB-112)
Given a read-only external session, Then it opens with a read-only tag, no composer,
and follows new rows; no approval, plan or question can be answered from it.
Given its folder is not reachable by the server, Then "continue here" is not offered.

**AT-WB-109** (WB-112)
Given a read-only session whose folder is reachable, When "continue here" is tapped
twice quickly, Then one new conversation is prepared with a summary note; its first
message carries the summary; the original is unchanged.

**AT-WB-110** (WB-001)
Given a session open in Project scope with the phone's list sheet open,
When the scope is switched to All, Then the same session remains on screen and the
sheet remains open, now showing the All list.

### 6.10 Multi-model

**AT-WB-111** (WB-121, WB-122)
Given a conversation with agent X containing an edit to `a.ts` and a command,
When the owner picks a model of provider Y, confirms, and sends "continue",
Then a new session of Y exists in the same project; its first prompt contains
"continue" followed by a summary mentioning the goal, the last answer, `a.ts` and the
command; the history shows one row for the chain marked with Y; opening it shows X's
stretch read-only above a "handed over" divider.

**AT-WB-112** (WB-121) — negative
Given a reply still running, When another provider's model is picked, Then the owner
is told to wait and no handoff starts.
Given a pending handoff, When the owner taps Cancel handoff, Then the original session
is shown again and no new session was created.
Given the same provider as source and target submitted to the service, Then the
handoff is refused.

**AT-WB-113** (WB-122)
Given a chain X→Y, When the chain row is renamed, Then the chain's title changes and
the individual sessions keep their own names; When it is deleted and confirmed, Then
both sessions are deleted.

**AT-WB-114** (WB-122) — negative
Given a chain X→Y, When X's stretch is opened alone and another provider is picked,
Then no handoff is offered (only the latest stretch can be handed on).

**AT-WB-115** (WB-123)
Given the agent compacts its context during a run,
Then the transcript shows "compacting…" and then a divider with before → after token
figures and a foldable summary; the context ring's percentage drops.

### 6.11 API-model chat

**AT-WB-116** (WB-081)
Given a configured API key and a new chat with an API model in a project that has no
conversation space yet,
When the owner sends "hi",
Then the message shows at once, a thinking line with elapsed seconds shows, the full
reply then appears in one piece, and the conversation is listed in the project's
history titled "hi".

**AT-WB-117** (WB-081) — negative
Given no API key, When a send is attempted, Then it is refused with a message saying
where to add a key, nothing is stored, and the text is restored to the field.

**AT-WB-118** (WB-081) — negative
Given a reply pending, When a second message is submitted to the same conversation via
the service, Then it is refused ("still replying"); When the conversation is deleted,
Then that is refused until the reply ends.

**AT-WB-119** (WB-081)
Given a reply pending, When the owner taps Stop, Then the request is cancelled, the
turn is visibly marked as stopped/failed, the text returns to the field, and the
stopped turn's error row is not included in the context of the next message.

**AT-WB-120** (WB-081) — negative
Given the upstream API answers an error with a body containing internal details,
Then the owner sees a generic failure with the status code and never the body.

**AT-WB-121** (WB-081) — negative
Given user 2, When they request user 1's conversation by id, Then it is "not found".

**AT-WB-122** (WB-082, WB-089) — negative
Given the pay-as-you-go API is disabled by the operator, Then saving a key is refused
and nothing is stored. Given it is enabled, When a key is saved with a wrong password,
Then nothing is stored; When a subscription sign-in token is pasted as a key, Then it
is refused with a specific explanation that does not repeat the value.

**AT-WB-123** (WB-089) — negative
Given a saved API key, Then no read capability ever returns the key or any part of it.

### 6.12 Usage

**AT-WB-124** (WB-130, WB-131)
Given a run reporting 160,000 of 200,000 context tokens,
Then the ring shows 80 % in the warning colour and its card shows used/window,
input/output/cache figures and the compaction hint; with no window size known the
ring is hidden.

**AT-WB-125** (WB-131) — negative
Given sessions A (on screen) and B both running, When B reports a token budget,
Then A's ring does not change.

**AT-WB-126** (WB-132, WB-134)
Given a provider window at 37 % used,
Then the panel shows "63 %" in Remaining mode and "37 %" after switching to Used, and
the model menu's figure for that provider follows the same mode.

**AT-WB-127** (WB-133)
Given the live usage source is rate limited and a reading from 12 minutes ago exists,
Then the figures are still shown, with a note that they are from 12 minutes ago; after
15 minutes they are flagged stale; tapping the flag explains why and offers Refresh
now, which triggers a new read.

**AT-WB-128** (WB-133) — negative
Given the provider sign-in was rejected, Then an old reading is **not** shown as
current; the provider line says it is not signed in.

**AT-WB-129** (WB-135)
Given 2 reset credits, When the owner taps Use and confirms,
Then one credit is spent and the outcome is reported; When the request times out and
the owner retries, Then at most one credit in total is spent. Cancelling the
confirmation spends nothing.

**AT-WB-130** (WB-137)
Given usage recorded on 3 days this week,
When the token analysis is read for "week",
Then 12 consecutive weekly buckets are returned with this week last, this week's
totals equal the sum of the 3 days, split by model and by project.

**AT-WB-131** (WB-137) — negative
Given the analysis tool is missing, Then the report is returned with a "not installed"
problem and previously recorded days intact. Given an unknown period, Then the request
is refused as invalid.

### 6.13 Inbox, presence, activity

**AT-WB-132** (WB-064)
Given one live approval, one interrupted run, one unread result from yesterday, one
unread result from five days ago, and one running task,
Then the inbox lists the approval, the interrupted run, yesterday's result and the
running task — not the five-day-old result.

**AT-WB-133** (WB-064) — negative
Given a running task, When it is acknowledged, Then the request is refused (conflict).
Given user 2 acknowledges user 1's run, Then "not found".
Given a bulk acknowledge of 101 ids, Then it is refused as invalid.

**AT-WB-134** (WB-114, WB-065)
Given session A visibly on screen on device A, When A's run finishes,
Then no notification trigger is raised for it and it is not listed as an unread
result; with the page hidden, a trigger is raised and it is listed.

**AT-WB-135** (WB-113)
Given projects P (one agent running) and Q (a session awaiting approval),
Then the activity summary reports P running with that agent and Q with attention 1;
after the approval is answered and the run finishes unseen, Q reports unseen 1; after
Q's session is viewed, Q is omitted.

### 6.14 Scheduling, external API (optional modules)

**AT-WB-136** (WB-061)
Given a message scheduled 1 minute ahead and no browser connected,
Then within ~90 s it is sent exactly once and marked sent; a message scheduled in the
past is sent on the next pass.

**AT-WB-137** (WB-061) — negative
Given a schedule more than 365 days ahead, or empty text, Then it is refused. Given a
message already sent, When it is cancelled, Then that is refused. Given user 2 cancels
user 1's schedule, Then that is refused.

**AT-WB-138** (WB-063) — negative
Given no API key header (or the key only in the address), Then the external API
answers unauthorised. Given a session with a run in progress, Then a request naming
that session is refused as busy before anything is cloned.

### 6.15 Security-focused

**AT-WB-139** (WB-011, §7) — negative
Given user 2 and a session owned by user 1,
When user 2 tries to watch it, send to it, stop it, answer its approvals, read its
history, queue to it or follow it,
Then every attempt is refused and user 2 receives no events about it.

**AT-WB-140** (§7) — negative
Given a send that names a working folder different from the session's project,
Then the run still executes in the session's project folder (the client's folder is
ignored).

**AT-WB-141** (WB-072, WB-059) — negative
Given a tool was approved in a run that was then interrupted, When the run is
continued, Then the same tool call is asked again unless a saved rule covers it.

**AT-WB-142** (§7) — negative
Given any run, Then no event delivered to a client contains the agent's native
conversation id, provider credentials, or server environment values.

**AT-WB-143** (WB-041, §7) — negative
Given a reply referencing an image path outside the project and outside the upload
store, Then the image is not served.

### 6.16 Shell, rendering and remaining coverage

**AT-WB-144** (WB-002)
Given a 390 px wide viewport, Then the side list is hidden and opens as a sheet over a
dimmed backdrop with keyboard focus kept inside; Esc or a backdrop tap closes it and
focus returns to its button. Given a 1,280 px viewport, Then the list is a docked
column; hiding it persists across a reload on that device.

**AT-WB-145** (WB-005)
Given a desktop keyboard, Then ⌘/Ctrl+K focuses the session search, ⌘/Ctrl+N opens a
new chat with the caret in the message field, and ⌘/Ctrl+\ toggles the side list.
Given focus inside the terminal panel, When Ctrl+K is pressed, Then the workbench does
not react (the shell receives it).

**AT-WB-146** (WB-006)
Given a touch device with the side list hidden,
When a finger drags 60 px to the right over the transcript, Then the list opens before
the finger lifts; When the drag starts at the screen's left edge, selects text, starts
inside a horizontally scrolling code block, or is mostly vertical, Then it does not.

**AT-WB-147** (WB-006, WB-106)
Given a history row, When it is swiped left, Then Pin / Archive / Delete are revealed;
When a second row is swiped, Then the first closes; When Archive is tapped, Then the
row is archived. A vertical drag starting on a row scrolls the list instead.

**AT-WB-148** (WB-020)
Given three messages sent earlier in this conversation and an empty field,
When ↑ is pressed twice, Then the newest and then the previous message are shown in
the field; When ↓ is pressed twice, Then the original (empty) draft is back. Messages
sent in other conversations are never offered.

**AT-WB-149** (WB-031)
Given a reply containing a table, a fenced code block with a language, inline and
display math, a diagram block and a sentence mentioning two dollar amounts,
Then the table, highlighted code (with Copy), both formulas and the diagram are
rendered, and the dollar amounts remain plain text.

**AT-WB-150** (WB-033, WB-035, WB-034)
Given the agent emits reasoning, then a checklist of three items with one completed,
then updates the checklist to two completed,
Then the status row shows "1/3" and later "2/3"; unfolding it shows the newest
reasoning and one checklist (the update replaces the earlier list rather than adding a
second one).

**AT-WB-151** (WB-039, WB-040)
Given a finished reply that mentions a file with a line number and a folder,
When Copy is used on the reply, Then its text is on the clipboard and the control
briefly confirms; When the file reference is tapped, Then the file viewer opens that
file at that line; When the folder reference is tapped, Then the folder is revealed in
the file tree.

**AT-WB-152** (WB-062)
Given a session with turns U1/A1/U2/A2/U3/A3 on an agent that supports forking,
When it is forked at U2, Then a new session exists whose history ends at the cut
(including U2 where the agent cuts by message), with the source's model and effort,
and the source is unchanged.
Given a session that has never run, When it is forked, Then that is refused.

**AT-WB-153** (WB-080, WB-120)
Given project P, When one session is started with each offered agent,
Then both run in P's folder and both appear in P's single history, each with its own
provider mark.

**AT-WB-154** (WB-090, WB-070)
Given a session of a provider that supports only three permission modes,
Then the mode menu lists exactly those three; When a send names a mode that provider
does not support, Then the run uses that provider's default mode.

**AT-WB-155** (WB-136, WB-082)
Given a noted balance of 25.00 and two pay-as-you-go replies whose list-price costs
are 0.10 and 0.05, Then the usage summary shows 0.15 spent since the note and an
estimated balance of 24.85; a declined or truncated reply is still recorded with its
cost; clearing the note removes the estimate.

**AT-WB-156** (WB-151) — negative
Given the product sign-in has expired, When any workbench request is answered
"unauthorised", Then the user is taken to sign-in with an explanatory message, and no
further requests are attempted with the expired sign-in.

**AT-WB-157** (WB-017)
Given a browser without speech recognition, Then no microphone button is shown.
Given a browser with it, When the microphone is tapped and words are spoken, Then they
appear after the existing draft; When the message is sent, Then listening stops and no
late words appear in the emptied field.

**AT-WB-158** (WB-045)
Given the conversation search, When one character is submitted, Then it is refused;
When "alpha beta" is submitted, Then only sessions containing that phrase match, title
matches arrive before content matches, and selecting a content match opens the session
positioned on the matching message.

**AT-WB-159** (WB-044)
Given a session with tool calls, When it is exported as JSON, Then the file contains
every message; When exported as a web page, Then tool output that is collapsed on
screen is present and readable in the file; the file name is derived from the title
and the date.

**AT-WB-160** (WB-008) — negative
Given a transcript that makes the chat view fail while rendering,
Then the side list and inspector still work, an error state with "reload" and "new
session" is shown, and the session's stored history is unaffected.

**AT-WB-161** (WB-152, WB-037) — negative
Given an agent whose command-line tool is not installed, When a message is sent to it,
Then the transcript shows a readable "not installed" notice, the run ends with one
failed terminal event, and the session is idle.

**AT-WB-162** (WB-116, WB-100)
Given a session that has completed a run, When its native id is requested, Then it is
returned. Given a session that has never run, Then the request is refused as "not
available yet". In both cases the session's own id and link are unchanged.

**AT-WB-163** (WB-124)
Given the workbench shown as a side panel of another in-product app,
When the host hands over a text and a screenshot, Then the text waits as a quote above
the field and the screenshot as a pending attachment, the field has focus, and nothing
is sent until the owner sends; the Back control closes the panel instead of navigating
away.

---

## 7. Security and permission requirements (this domain)

### 7.1 Must never be possible

1. **Cross-user access.** Every operation on a session, conversation, run, queue item,
   draft, recovery record, inbox item, chain, preference or follow target must verify
   that it belongs to the caller. A user must never receive live events, session
   deltas, queue changes or preference-change hints about another user's data; every
   live event is delivered only to connections authorised for it.
2. **Client-chosen execution context.** The provider, the project folder the agent
   runs in, and the agent's native conversation id must come from server records. A
   client-supplied working folder must be ignored or validated against the session's
   project.
3. **Reading arbitrary files through attachments or image references.** Only files in
   the upload store (direct children, no traversal, no sub-folders) may be attached;
   images are read only from the upload store or the run's project folder; symlinks
   leading outside are refused; stored uploads are fetched by plain file name only.
4. **Leaking secrets to the browser or the agent.** API keys are encrypted at rest and
   never returned by any capability; provider sign-in tokens are never logged, never
   refreshed by the product, never sent anywhere but the provider; the agent's native
   ids and credentials never appear on the live stream; agent processes do not inherit
   the product's own secrets or server settings; a pay-as-you-go key must never be
   placed in the environment of a subscription agent (it would silently switch
   billing).
5. **Leaking upstream internals.** Raw upstream error bodies of API providers are not
   forwarded (at most a short, sanitised reason).
6. **Silent re-execution.** After a restart, crash or reconnect nothing is run again
   automatically: not interrupted runs, not taken-but-unstarted queued messages, not
   unconfirmed sends. A re-submission happens only with the original request id after
   a negative delivery check, and the server de-duplicates it.
7. **Approvals outliving their context.** An approval answers exactly one request.
   Pending approvals are never reconstructed from stored records, never carried into a
   continuation, another run or another session. A timeout or a stop resolves to
   *deny*. A blocked rule always beats an allowed rule.
8. **Reaching "bypass" by accident.** The bypass mode is selected only explicitly from
   the menu (never by the cycling shortcut), is visibly marked as dangerous, and is
   stored per session/device, not as a silent account default. The account-wide "skip
   prompts" switch must carry an explicit warning.
9. **Acting from read-only or summary surfaces.** The task inbox, earlier stretches of
   a chain, and read-only external sessions can never approve, answer, run, continue or
   stop anything.
10. **Automatic network fetches triggered by model output.** Images from the web in a
    reply are not requested until the reader asks, and then without a referrer; the
    stand-alone API chat never loads them at all.
11. **Instruction smuggling through context.** Handoff summaries, project descriptions,
    notes and opt-in context are passed to models as clearly delimited background data
    with an explicit statement that the owner's own message takes precedence; content
    that looks like a credential is withheld from API models.
12. **Unbounded resource use by one client.** Caps exist for message size, outbound
    backlog, subscriptions per request (64), presence entries (32), follows (4), queue
    length (20), suggestion calls (12/min), handshake rate and concurrent connections.
13. **Path escape in the computer-wide session list.** Ids are validated before any
    file access; anything resolving outside the agents' own storage is "not found";
    oversized transcripts are refused rather than read.

### 7.2 Needs explicit owner approval or confirmation

| Action | Requirement |
| --- | --- |
| A tool call not covered by mode or rules | Approval prompt showing the full command / target / diff preview |
| Executing a plan produced in plan mode | Approve-and-run on the plan card |
| Remembering a rule ("always allow") | Explicit tap; the saved rule text is shown before saving |
| Deleting a session, a chain or a conversation | Confirmation sheet stating it is permanent and what is removed |
| A send that would terminate running background work | Confirmation listing that work |
| Handing a conversation to another provider | Confirmation naming the target |
| Running a custom command that embeds shell commands | Confirmation |
| Spending a reset credit | Confirmation showing what will be reset; idempotent |
| Saving or replacing a pay-as-you-go API key | Re-entering the product password |
| Running a shell block from a reply in the terminal | An explicit tap on that block (see §9 on whether a second confirmation is wanted) |
| Continuing an interrupted task | An explicit tap; uses the *current* permission mode |

### 7.3 Further requirements

- The server's automatic answer to an unanswered question may only choose options the
  agent itself marked as recommended, must be announced in advance with its time, and
  must be switchable off by the operator.
- A scheduled message interrupts a running turn in its session; because this can
  discard work, the new product should make this explicit to the owner when scheduling
  (see §9).
- The external agent API runs with nobody available to answer approval prompts; it
  must therefore be off unless API keys exist, accept keys only in a header, validate
  clone sources (HTTPS on the supported host only, no embedded credentials, no
  option-like values), keep credentials out of command arguments and stored remote
  addresses, run only in registered projects or its own fresh clones inside the
  allowed workspace roots, decide by configuration what would need approval
  (pre-authorised, or denied and reported), and clean up only what it created.
- Logs must not contain message content, API keys, provider tokens or upstream answer
  bodies. Notification channels outside the app carry no message content.
- Usage readings are advisory: a stale or estimated figure must always be labelled as
  such.

---

## 8. Mobile requirements (this domain)

1. **Everything in §3 must be completable on a phone with one hand**: all row actions
   have a swipe *and* a visible "…" alternative; all menus become bottom sheets with a
   dimmed backdrop; all sheets are dismissible by backdrop tap.
2. **Runs survive the phone.** Locking the screen, switching apps, losing signal or
   closing the tab never stops, duplicates or loses a run or a queued message. On
   return the app catches up without user action (F-22) and without showing duplicate
   or missing rows.
3. **Sending survives the phone.** A message being sent when the app is suspended ends
   in exactly one of: confirmed, or visibly "unconfirmed" with Check / Retry — never
   silently lost, never sent twice (F-23). The unconfirmed state survives a reload of
   the same tab.
4. **On-screen keyboard.** The composer stays directly above the keyboard and the title
   bar at the top; the page never ends up zoomed or scrolled behind the keyboard after
   it closes; tapping composer chips, the attach button, the suggestion chip or the
   Quote pill does not dismiss the keyboard; a new chat focuses the field (which may
   raise the keyboard) while one-tap recovery "Continue" must **not** raise it.
5. **No focus zoom**: every text field ≥ 16 px.
6. **Touch targets ≥ 44 pt** including the code-block Run button, recovery pills,
   queue actions, and sheet buttons. Hover-only affordances are forbidden: Run and
   row-action entry points are always visible on touch devices (Copy on code blocks may
   be revealed on hover on pointer devices but must be reachable by focus/tap).
7. **Gestures**: swipe right on the chat opens the list (not from the very edge, which
   is Back); swipe left on a row reveals actions, claimed on the first horizontal move
   so the list does not pan diagonally; vertical moves always scroll; the usage pager
   moves only horizontally; in the image viewer pinch zooms, horizontal swipe changes
   image, downward swipe closes; long questions scroll inside their sheet with the
   buttons pinned.
8. **Selection on touch**: the Quote pill appears below a finger selection, clear of
   the system's selection menu, once the handles have rested.
9. **Input methods**: composing text (pinyin etc.) must never be interrupted by UI
   changes around the field (suggestions, chips), and the confirming Enter never
   sends.
10. **Dictation** via the browser where available; the microphone button is absent
    otherwise; the microphone is released when the chat is left.
11. **Paste from the photo/screenshot clipboard** attaches exactly one copy.
12. **Layout**: at phone width the side list is a sheet, the inspector is full-screen,
    recovery and delivery banners fill the column with wrapping text, the question
    sheet never lets choices overlap, model and effort menus are bottom sheets, the
    background-task panel is a bottom sheet.
13. **Home-screen (installed) mode**: the workbench fills the screen including safe
    areas; the composer sits at the bottom edge with the area below it in the composer
    colour.
14. **Battery/network**: polling happens only while the page is visible (running list
    5 s, activity 30 s, usage 60 s, All list 5 s, inbox 15 s); hidden pages make no
    periodic requests; returning to the foreground triggers one immediate refresh of
    each.
15. **Scope and list state across navigation**: switching scope on a phone keeps the
    list sheet open if it was open; opening a row closes the sheet; Back never walks
    through previously viewed sessions.
16. **Reduced motion and screen readers**: every status change relevant to a run (mode
    switched, run finished, waiting for approval) is announced; sheets trap focus and
    return it to their opener.

---

## 9. Open questions and ambiguities

1. **Approval timeout is 55 s by default.** On a phone, with a push notification
   round-trip, that is short: an unanswered tool request is denied and the agent
   continues without it. Should the new product use a longer default, make it a user
   setting, or keep waiting while a notification is outstanding? (Observed value;
   intent unknown.)
2. **Plan approval and questions in "auto-judge" and "bypass" modes** — the agent
   runtime may resolve them itself, so the owner would never see the card/sheet.
   Decide the intended behaviour.
3. **Session ownership / multi-user.** §7.1 item 1 requires per-user ownership checks
   everywhere. Confirm the new product is multi-user from day one.
4. **Which legacy-surface features move into the workbench?** Scheduling, export,
   content search, fork, per-task stop, read-aloud/voice recording, copy-as-text,
   "show thinking" toggle, command palette, bulk delete, copy native id (S-30). The
   phone-first workbench currently lacks all of them; I could not determine whether
   that is deliberate.
5. **Scheduled messages interrupt a running turn**, whereas queued messages wait.
   Is interruption really wanted for schedules? It can discard work in progress.
6. **Where the "last-used agent" lives.** The workbench remembers it per device, while
   the underlying engine also keeps an account-wide preference that changes when a
   session is opened. The intended rule (per device vs per account) is unclear.
7. **Per-session permission mode storage** is device-local today; model and effort are
   stored on the server per session. Should the mode also follow the session across
   devices?
8. **Codex "ask" mode cannot actually ask.** Its default mode maps to
   "approval on request" but no interactive approval exists, so such actions simply do
   not happen. Should the new product implement approvals for Codex (its runtime
   offers an approval protocol), or relabel the mode?
9. **Codex emits no live token budget and no background-task telemetry**; the ring is
   refreshed from stored usage after a turn. Is live parity desired?
10. **Steer acknowledgement timeout (8 s):** on timeout the message stays in the field
    and is not queued, to avoid duplicates. A request-id-based idempotent steer would
    allow safe automatic fallback — desirable?
11. **Dictation language is fixed** (Simplified Chinese). A language preference is
    presumably wanted in a public product.
12. **UI language.** The workbench's labels are hard-coded Chinese; the legacy surface
    is translated into about a dozen languages. The public product needs a decision on
    localisation of the workbench.
13. **"Run" on shell code blocks executes agent-authored commands with one tap.**
    Should there be a preview/confirm step, at least for destructive-looking commands
    or on first use? The untagged-fence heuristic uses a fixed list of well-known
    program names — keep, extend, or make it configurable?
14. **Machine-wide data in a multi-user installation.** Subscription-usage snapshots
    and the list of every session on the computer describe the machine, not a user.
    Who may see them in the new product — only the owner, or every signed-in user?
15. **API conversations cannot be renamed or archived** unless part of a chain.
    Limitation or intent?
16. **A chain containing a pay-as-you-go API conversation is treated as the generic
    API provider** for handoff rules (inferred). Should each API provider be a
    first-class handoff source/target?
17. **Removing a preference** — sending "null" stores null rather than deleting the
    key (inferred). Define deletion semantics explicitly.
18. **"Not installed" vs "not signed in"** for local agents: the new product should
    probe reliably and present three distinct states in the settings UI.
19. **Read-only "machine view".** A computer may offer a second view of agent
    sessions that the server can read but not drive (for example, the other operating
    system of a dual-OS machine). Is the generic capability "additional read-only
    session sources" wanted in the public product, and should "continue here"
    generalise to any reachable folder?
20. **Time zone for usage analysis** is fixed to one zone today (the owner's). It
    should presumably follow a user setting.
21. **Usage data sources** depend on vendor-specific, partly undocumented interfaces
    (live subscription usage, the agents' local caches and logs, an external log
    analysis tool). Their availability for a public product is uncertain; the UI
    contract (snapshot + source + stale + note) is what should be preserved.
22. **Reset credits** exist for one provider only; the generic shape is specified, the
    concrete redemption call is vendor-specific.
23. **Completion sound / tab-title marker:** I could not confirm whether the owner
    considers them part of the workbench experience.
24. **Attachment retention.** Define how long uploaded files and pending (unsent)
    attachments on the device are kept, and how they are cleaned up.
25. **Pending attachments do not sync across devices**, while draft text does. Intent?
26. **Maximum rename length** differs (500 on the service, 200 in the UI).
27. **Retired providers** (WB-091): the new product can simply omit them unless import
    of old sessions is a goal.
28. **Exact wording and structure of the handoff summary** are specified in §5.17 as
    observed; whether a model-written summary would be preferable was a deliberate
    non-goal of the existing system ("deterministic transcript summary").

---

## 10. Noticed outside my domain

- The workbench inspector hosts the project's **files / terminal / git / preview**
  panels and a **pull-request chip** for the current branch in the chat title bar
  (refreshes when a run ends, on focus, and every minute).
- The terminal panel **detects local dev-server addresses** printed by commands and
  offers them in the preview panel; terminals **survive disconnects** (about 30 minutes)
  with buffered output replay, and the number of live terminals is capped.
- Project switcher: **pin, archive (with undo), delete, "add to home screen"** for
  plain folders, press-slide-release selection; project list failures and empty states.
- **"New project" sheet** can be opened from the All-scope project chip.
- A project page lists **running and recent sessions** and a "new session" button that
  deep-links into the workbench; remote (SSH) projects open agents in a full-screen
  terminal instead of the workbench.
- **Sign-in expiry**: any unauthorised answer returns to the sign-in screen with a
  message; sessions are renewed at half-life.
- **"Sign out everywhere"** terminates the user's live connections.
- **Web push / e-mail / SMS / chat-app channels** for run events, per-event switches,
  20 s de-duplication, same-origin deep links.
- **Home-screen tiles**: task inbox tile status priority (to do > needs update > new
  results > running); usage widgets in three sizes.
- **Client self-update**: long-lived pages detect a new build (on resume, when back
  online, every 5 minutes) and either reload silently when safe or show a "refresh"
  toast.
- **User preference store with live cross-device sync** (merge-patch, change hints) and
  a **draft store** — shared infrastructure used by several domains.
- **Shared notes ("memory") tools** exposed to the API chat model (search/read/write
  with per-reply limits and scope rules).
- **Automations tab "agent drafts"**: saved instructions that can be scheduled as one
  execution into an existing session.
- An **AI task-board integration** (requirements-document parsing, task lists), **tool
  server (MCP) management** and **skills listing** per agent (domain 2).
- **Runtime/version status page** (which build the browser, the deployed client and the
  running server are on).
- **Voice settings** (voice backend) in settings; key storage is specified in domain 3.
- **First-run onboarding** asks for git name/e-mail before agent sign-in.
- **A localisation system** with about 13 languages exists for the legacy surface only.
