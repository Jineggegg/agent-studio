# 02 — Projects and Developer Tools

> **Provenance.** Written by the product-analysis group from the behaviour of a private predecessor system, as input for an independent implementation (see `docs/clean-room/PROCESS.md`). It describes what the product should do, never how the predecessor was built. Owner-specific private integrations were removed from this published copy. Where the implementation deliberately differs, `docs/requirements/README.md` says so. Statements about the predecessor's security behaviour were removed or restated as requirements before publication.

Group A (product analysis) hand-off document for the clean-room rebuild of "Agent Cloud Studio 2.0".
Domain: projects, file browser and editor, Git, GitHub, terminal, preview and built apps, background tasks, extensibility.

## Reading notes

- **What this is.** A description of what the product must do in this domain, as a user or an API client observes it. It says nothing about how the predecessor is built, and it must be implemented from scratch.
- **Evidence.** Statements were derived by Group A from a read-only study of the existing system: its screens, its service behaviour as a client would see it, behaviour described by its automated tests, its owner documentation and its change history. The existing system was **not run** for this analysis, so nothing here was confirmed by executing it; the acceptance tests in section 6 are the place where behaviour gets verified. A statement marked *(inferred)* was deduced rather than read directly.
- **Numbers.** Sizes, counts and time limits are recommended defaults for the new product. Where a number is a safety boundary the text says "must".
- **Reach codes** (where a feature is offered; the rebuild should offer everything it keeps in the main interface):
  - **M** — the main interface (home screen and workbench), i.e. what the owner uses every day.
  - **O** — a secondary, desktop-style management screen.
  - **S** — a service capability used by other features or by API clients.
- **Language.** The main interface is Simplified Chinese; short labels are quoted in the original where that helps a tester find a control. Large parts of the Git panel, file tree, task board and the slash-command dialogs are English-only in the old system; the rebuild should localise everything consistently.
- **Vocabulary used below.**
  - *Service* — the server program that runs on the owner's computer and that browsers connect to.
  - *Host* — the computer (and operating-system account) the Service runs on.
  - *Agent* — a coding-agent command-line program the Service runs on the host on the user's behalf (the old system offers two subscription-based agent CLIs, plus one API-only chat model that has no tools).
  - *Workspace project* — a host-wide registry entry that pairs one working directory with a stable random identifier. Sessions, files, Git and the terminal are addressed through it.
  - *Project card* — a per-user project shown as a tile on the home screen: name, description, icon, working directory (or remote host and directory), links, enabled agents and feature switches.
  - *Folder project* — a workspace project that has no project card for the current user (for example a folder where an agent was once run from a terminal).
  - *Workbench* — the chat workspace. It has two scopes switched at the top of its side list: **Project scope** (「项目」: one project's conversations with that project's tools) and **All scope** (「全部」: every agent session on the computer).
  - *Inspector* — the tool area at the right of the workbench with four panels: Files (「文件」), Terminal (「终端」), Git, Preview (「预览」).
  - *Viewport classes* — phone: width ≤ 699 px; tablet: 700–1023 px; desktop: ≥ 1024 px. Re-evaluated on resize and rotation.

---

## 1. Scope summary


---

## 2. Feature inventory

Priority: **Core** (the product is not usable for its purpose without it), **Important** (expected by the owner, used regularly), **Nice-to-have**. Class: **Generic** or **Private-excluded**.

### 2.1 Projects

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-001 | Workspace project registry | Each registered working directory is one project with a stable random identifier; at most one project per directory path. | Core | Generic | M |
| PJ-002 | Automatic project discovery | Folders in which a supported agent has a saved conversation appear as projects without being added; new ones appear live. | Core | Generic | M |
| PJ-003 | Add or create a folder as a project | Registering a path adds an existing folder or creates a missing one (including parents). | Core | Generic | M (indirect), O (form) |
| PJ-004 | Project location rules | Project folders must lie inside the allowed workspace root, never in system directories, never through a symlink that leaves the root. | Core | Generic | M |
| PJ-005 | Server folder browser | Browse the host's folders (sub-folders only) and create a folder, to pick a project path. | Important | Generic | O |
| PJ-006 | Create a project by cloning | Clone a remote repository into a chosen parent folder with live progress, then register it. | Important | Generic | O |
| PJ-007 | Rename a project | Change the display name only; the folder is never renamed. | Core | Generic | M (card name), O (registry name) |
| PJ-008 | Archive and restore a project | Hide a project from active lists without touching data; undo/restore. | Core | Generic | M |
| PJ-009 | Delete a project's records | Remove the project and its saved conversations; the working folder and its files are never deleted. | Core | Generic | M |
| PJ-010 | Starred projects | A host-wide favourite flag that sorts a project first. | Nice-to-have | Generic | O |
| PJ-011 | Pinned projects | Per-user, ordered pins that lead every project list and follow the user across devices. | Important | Generic | M |
| PJ-012 | Project list with sessions | List projects with a first page of conversations each, page further, receive live updates. | Core | Generic | M |
| PJ-013 | Project card | Per-user project record: name, description, icon colour and symbol, location, links, enabled agents, feature switches, automation defaults. | Core | Generic | M |
| PJ-014 | "New project" sheet | Home-screen "+" opens a sheet with two modes: let an AI build it, or create manually. | Core | Generic | M |
| PJ-015 | Project settings and card deletion | Edit every card field; delete the card (settings, drafts and API-chat history go; files and agent sessions stay). | Core | Generic | M |
| PJ-016 | Project page | Screen behind a project tile with tabs: assistant (sessions, new session, terminal), GitHub, automation, settings, and for built apps a home tab. | Core | Generic | M |
| PJ-017 | Project website links | Up to 8 named links per project with live reachability, a health reading, and in-app or new-tab opening. | Important | Generic | M |
| PJ-018 | Open a project in the workbench | Opening registers the folder as a workspace project if needed and lands in its workbench; a tile can be set to skip the project page. | Core | Generic | M |
| PJ-019 | Project switcher | Popover in the workbench side list: search, pinned and recent sections, activity marks, row actions, press-and-slide selection. | Core | Generic | M |
| PJ-020 | Add a folder project to the home screen | One action turns a folder project into a project card. | Important | Generic | M |
| PJ-021 | Project chip for a new conversation | In All scope a new conversation shows a chip to choose its project, with a small "+" that creates a project. | Important | Generic | M |
| PJ-022 | Draft follows the project | An unsent first message (and its attachments) moves with the conversation when its project is changed. | Important | Generic | M |
| PJ-023 | Per-project remembered place | Each project reopens its last conversation; the workbench reopens the last project and scope. | Core | Generic | M |
| PJ-024 | Project activity marks | Per project: running marks per agent, a "needs you" mark, a "finished, not yet seen" mark. | Important | Generic | M |
| PJ-025 | Scratch workspace | A default folder, created on first use, for agent sessions started outside any project. | Nice-to-have | Generic | M |
| PJ-026 | Remote-host projects | A project can live on an administrator-configured SSH host; agents or a shell open there in a persistent terminal session. | Important | Generic | M |
| PJ-027 | Remote host status | List configured hosts with online state, latency and which tools are installed. | Nice-to-have | Generic | M |
| PJ-028 | Execution lock on project edits | While scheduled work is pending for a project, edits that would strand it (directory, agents, switches, delete) are refused. | Important | Generic | M |
| PJ-029 | Deep links and redirects | Stable addresses for a project, a project tab, a conversation; older address forms redirect. | Important | Generic | M |
| PJ-030 | Older project sidebar | List with sort by name or recent activity, search, inline rename, archive view, running view, bulk session selection. | Nice-to-have | Generic | O |

### 2.2 Tool container

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-031 | Inspector | Four project tools (Files, Terminal, Git, Preview) in one slide-out area: docked on desktop, floating on tablet, full screen on phone. | Core | Generic | M |
| PJ-032 | Inspector layout memory | Open/closed, active panel and width are remembered per device; panels keep their state while hidden. | Important | Generic | M |
| PJ-033 | Keyboard shortcuts | Shortcuts for session search, new chat, side list, inspector, back; shown as hints only with a precise pointer. | Important | Generic | M |

### 2.3 Files and editor

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-034 | File tree | Whole-project tree, folders first, with ignore rules, a depth limit and an entry limit. | Core | Generic | M |
| PJ-035 | Tree view modes and metadata | Three densities: names only; with size and permissions; full columns with modified time. | Nice-to-have | Generic | M |
| PJ-036 | File-name filter | Case-insensitive name filter that keeps and expands matching branches. | Important | Generic | M |
| PJ-037 | Create file or folder | Inline name entry at root or inside a folder, with name rules. | Core | Generic | M |
| PJ-038 | Rename file or folder | Inline rename within the same folder. | Core | Generic | M |
| PJ-039 | Delete file or folder | Confirmed permanent deletion; folders recursively. | Core | Generic | M |
| PJ-040 | Upload | Multi-file picker, drag-and-drop of files and folders, per-folder targets, progress, limits. | Core | Generic | M |
| PJ-041 | Download | A file as-is; a folder as a ZIP archive. | Important | Generic | M |
| PJ-042 | Copy path | Copy an item's absolute path. | Nice-to-have | Generic | M |
| PJ-043 | Text editor | Open, edit and save one text file at a time, with an unsaved-changes guard. | Core | Generic | M |
| PJ-044 | Syntax highlighting | Colouring for common web, script, data, Markdown and environment-file formats. | Important | Generic | M |
| PJ-045 | Editor display settings | Word wrap, minimap, line numbers, font size; stored per user. | Nice-to-have | Generic | O (controls), M (effect) |
| PJ-046 | Diff view in the editor | Inline (unified) change view with next/previous change and a toggle. | Important | Generic | M |
| PJ-047 | Markdown and HTML preview | Rendered Markdown (tables, task lists, maths, code, diagrams); HTML in a sandboxed new tab. | Important | Generic | M |
| PJ-048 | Media preview and binary handling | Images, PDF, video and audio preview; a placeholder for known binary types. | Important | Generic | M |
| PJ-049 | Open files from chat | File links, "path:line" jumps, folder reveal and tool-row "open file" buttons open in the inspector. | Core | Generic | M |
| PJ-050 | File mentions in the composer | Typing "@" lists project files to insert a path. | Important | Generic | M |
| PJ-051 | Path confinement for file operations | Reads and writes are confined to the project after symlink resolution; nothing follows a symlink out. | Core | Generic | M |
| PJ-052 | Expand editor | The editor can take all the width the chat can spare. | Nice-to-have | Generic | M |

### 2.4 Git

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-053 | Change list (status) | Staged and unstaged groups with per-file status, counts and manual refresh. | Core | Generic | M |
| PJ-054 | Initialise a repository | A folder without a repository offers one-button initialisation; an empty repository offers a first commit. | Important | Generic | M |
| PJ-055 | Per-file diff | Expandable unified diff per changed file, with size limits. | Core | Generic | M |
| PJ-056 | Stage and unstage | Per file and all at once; reflects the real index. | Core | Generic | M |
| PJ-057 | Discard and delete untracked | Confirmed discard of a file's changes; confirmed deletion of an untracked file. | Core | Generic | M |
| PJ-058 | Commit | Commit staged files with a message. | Core | Generic | M |
| PJ-059 | Undo latest local commit | Remove the last commit and keep its changes staged. | Nice-to-have | Generic | M |
| PJ-060 | AI-written commit message | Generate a conventional commit message from the selected files' diff using a tool-less agent run. | Nice-to-have | Generic | S |
| PJ-061 | Branch list and switch | Searchable local and remote branches; switch with a click. | Core | Generic | M |
| PJ-062 | Create a branch | From the current branch, then switch to it. | Core | Generic | M |
| PJ-063 | Delete a branch | Safe delete by default, explicit force for unmerged; never the current branch. | Important | Generic | M |
| PJ-064 | Remote sync | Ahead/behind counts; fetch, pull, push; publish a branch that has no upstream. | Core | Generic | M |
| PJ-065 | Commit history | Recent commits with a branch graph, refs, and per-commit details and diff. | Important | Generic | M |
| PJ-066 | Compare against a branch | Everything that differs from the merge base with a chosen branch, including uncommitted and untracked files. | Important | Generic | M |
| PJ-067 | Worktrees | List, create (optionally switch into), open as a project, merge back (squash or merge commit), remove. | Important | Generic | M |
| PJ-068 | Commit identity | Per-user author name and e-mail, pre-filled from the host and applied to it. | Important | Generic | O |
| PJ-069 | Git input hardening | Branch names, refs, remote names and paths from clients can never act as options or leave the repository. | Core | Generic | M |

### 2.5 GitHub

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-070 | GitHub access through the host login | The Service uses the GitHub command-line login already present on the host; it never sees or stores the token. | Core | Generic | M |
| PJ-071 | Sign-in state and setup guidance | Clear states for "tool missing", "not signed in", "login expired", "read-only token", with a re-check button and folded instructions. | Core | Generic | M |
| PJ-072 | Pull-request inbox | Open PRs the account authored, is asked to review, or that sit in its own repositories; filters and counts. | Important | Generic | M |
| PJ-073 | My repositories | Every repository the account owns, most recently pushed first, each opening an in-app page. | Important | Generic | M |
| PJ-074 | Repository page | Description, visibility, default branch and its latest commit with checks, open PRs, recent merges. | Important | Generic | M |
| PJ-075 | Pull-request sheet | Facts, checks, files, description, mergeability and blockers for one PR; auto-refresh while checks run. | Important | Generic | M |
| PJ-076 | Guarded merge | Merge with a chosen method only when a fresh read shows no blocker; never bypasses protection; audited. | Important | Generic | M |
| PJ-077 | PR quick fixes | Update the branch, mark a draft ready, approve waiting workflow runs — each confirmed and audited. | Nice-to-have | Generic | M |
| PJ-078 | Merge log | The user's recent merge attempts with outcome. | Nice-to-have | Generic | M |
| PJ-079 | Project GitHub tab | A project whose links include a repository address gets a tab with that repository's page. | Important | Generic | M |
| PJ-080 | Branch PR chip | The workbench title bar shows the open PR of the project's current branch with a one-word state. | Important | Generic | M |
| PJ-081 | GitHub home widget | PR count and check summary in three sizes. | Nice-to-have | Generic | M |
| PJ-082 | CI runs widget | Running, queued and recently finished workflow runs across recently pushed repositories. | Nice-to-have | Generic | M |
| PJ-083 | Stored repository-host tokens | Per-user named tokens used only for cloning private repositories and for the programmatic agent run. | Nice-to-have | Generic | O |
| PJ-084 | Programmatic agent run with branch and PR | An API-key call can run an agent on a repository and then push a branch and open a PR. | Nice-to-have | Generic | S |

### 2.6 Terminal

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-085 | Project terminal | An interactive login shell on the host in the project's folder, inside the inspector. | Core | Generic | M |
| PJ-086 | Full-screen project terminal | The same shell opened full screen from the project page. | Important | Generic | M |
| PJ-087 | Persistent terminal sessions | The shell keeps running after the client leaves (30 minutes), re-attaches and replays recent output. | Core | Generic | M |
| PJ-088 | Terminal display | Fits its container, resizes the remote terminal, scrollback, copy/paste, program clipboard access. | Core | Generic | M |
| PJ-089 | Phone key bar | A row of helper keys (paste, escape, tab, arrows, interrupt, scroll to end) on narrow screens. | Core | Generic | M |
| PJ-090 | Touch selection and zoom | Long-press word selection with handles and a copy menu; pinch to change font size; inertial scrolling. | Important | Generic | M |
| PJ-091 | Run a command from chat | Shell code blocks in agent replies carry a run button that types the command into the project terminal. | Important | Generic | M |
| PJ-092 | Development-server address detection | Addresses printed in the terminal that look like local servers become preview shortcuts. | Important | Generic | M |
| PJ-093 | Agent sign-in in an embedded terminal | An agent's own login flow runs in a minimal terminal inside a dialog. | Important | Generic | M (first run), O (settings) |
| PJ-094 | Agent CLI in a terminal tab | Run or resume an agent's own terminal interface for a session, with restart/disconnect controls and tap-to-answer prompt buttons. | Nice-to-have | Generic | O |
| PJ-095 | Terminal resource limits | Caps on live terminals, message size, backlog, connection counts; heartbeat. | Core | Generic | M |
| PJ-096 | Terminal channel authentication | The terminal channel requires the signed-in session and ends when all sessions are revoked. | Core | Generic | M |

### 2.7 Preview, AI builds and built apps

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-097 | Preview panel | Show a web address (detected or typed) in a frame with reload and open-in-new-tab, and plain explanations when a frame cannot work. | Important | Generic | M |
| PJ-098 | AI build | Describe an app; the Service creates a folder, a local repository, a tile, and an unattended agent session that builds it. | Important | Generic | M |
| PJ-099 | Build name suggestion | A short name is suggested from the description and adopted with one key. | Nice-to-have | Generic | M |
| PJ-100 | Build progress and control | Tile states (queued, planning, percent, done, failed, stopped); queue of parallel builds; stop and continue. | Important | Generic | M |
| PJ-101 | Build permission modes | Unattended builds are deny-by-default: a restricted mode (default) and an opt-in OS-sandbox mode; the form states which applies. | Core (for builds) | Generic | M |
| PJ-102 | Built-app runner | Start a built app on demand (process or static files), stop it when idle, restart on new commits, show failures with a log. | Important | Generic | M |
| PJ-103 | App gateway | A built app is reached under a per-grant secret prefix on the same origin, in a sandbox that isolates it from the product. | Important | Generic | M |
| PJ-104 | App home with AI sidebar | The app's project page shows the running app with a side panel to ask the AI for changes or a fix. | Important | Generic | M |
| PJ-105 | In-app browser for links | A project link that permits framing opens in a sandboxed in-app browser cover. | Important | Generic | M |
| PJ-106 | Agent-driven browser | A headless browser an agent can drive through a tool server; the user watches screenshots and can stop sessions. | Nice-to-have | Generic | O (panel), S (tools) |

### 2.8 Background work

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-107 | Background-task sheet | Per conversation: sub-agents, background commands and workflows with status, elapsed time, tokens and output. | Important | Generic | M |
| PJ-108 | Stop a background task | Stop one background task of a session. | Nice-to-have | Generic | O (control), S |
| PJ-109 | Interrupted-run recovery card | A run cut short by a restart or failure shows a card: view original input, continue once, or dismiss. | Important | Generic | M |

### 2.9 Extensibility

| ID | Feature | Description | Priority | Class | Reach |
|---|---|---|---|---|---|
| PJ-110 | Tool-server (MCP) management | Per agent and scope: list, add, edit, delete tool servers; values are written to the agents' own configuration. | Important | Generic | O |
| PJ-111 | Tool-server import and "add to all" | Paste a JSON definition; add one server to every agent at once. | Nice-to-have | Generic | O |
| PJ-112 | Product-managed tool servers | Tool servers the product registers itself are shown locked and cannot be edited. | Nice-to-have | Generic | O |
| PJ-113 | Skills list | Discover skills per agent from user, project, plugin, repository and system locations; search and group. | Important | Generic | O |
| PJ-114 | Skill install | Upload a skill folder or definition file into the agent's user-level skill location. | Nice-to-have | Generic | O |
| PJ-115 | Slash-command menu | Typing "/" in the composer lists built-in commands, skills and custom commands, ranked by use. | Important | Generic | M |
| PJ-116 | Built-in slash commands | Help, model choice, token usage, status, project memory file, settings. | Important | Generic | M |
| PJ-117 | Custom slash commands | Markdown command files at user and project level with argument substitution. | Important | Generic | M |
| PJ-118 | Plugin system | Install from a Git address; a plugin adds one workspace tab and may run a server-side process reached through a proxy. | Nice-to-have | Generic | O |
| PJ-119 | Plugin management | List, enable/disable, update, uninstall; recommended plugins with one-tap install. | Nice-to-have | Generic | O |
| PJ-120 | Command palette | A searchable palette of actions, navigation, sessions, files, commits and branches. | Nice-to-have | Generic | O |
| PJ-121 | Task-planning integration | Detect an external task-planning tool in a project; task board, filters, task detail, requirements-document editor. | Nice-to-have | Generic | O |

### 2.10 Private, owner-specific (do not build)

| ID | Feature | Description (≤ 3 words) | Priority | Class | Reach |
|---|---|---|---|---|---|

Generic capabilities abstracted from the private items and specified in this document instead: a project page can host extra tabs (PJ-016); a project link can open an external tool inside the product (PJ-105); remote hosts come from administrator configuration (PJ-026); the CI widget itself (PJ-082) without any deployment line.

---

## 3. User flows

Each flow lists the features it exercises. Unless a step says otherwise it is the same on phone, tablet and desktop; differences are called out as **Phone:** / **Desktop:**.

### UF-01 Create a project by hand (PJ-013, PJ-014, PJ-004)

1. On the home screen the user taps the "new" tile (「新建」, a plus).
2. A sheet titled 「新建项目」 opens. At the top a two-way switch chooses the mode: "let an AI build it" (default) or "create manually" (「手动创建」). **Phone:** bottom sheet with a grabber and the action bar pinned at the bottom. **Desktop/tablet:** centred sheet.
3. The user switches to manual. Anything already typed in the other mode is kept while the sheet is open.
4. The form shows a live preview of the tile and these inputs: name (required), description (optional), location, links, icon colour and symbol, enabled agents, feature switches (section 4.2 lists limits and defaults).
5. The user presses 「创建项目」. While saving, the form is locked and the button shows progress.
6. On success the sheet closes, a short toast confirms the new project by name, the tile appears and the project page opens.
7. On failure the reason appears inline next to the form and nothing is created.
8. Note: whether the directory exists and is allowed is checked when the project is first opened in the workbench (UF-02), not when the card is saved.

### UF-02 Open a project and start a conversation (PJ-016, PJ-018, PJ-023)

1. The user taps a project tile on the home screen.
2. If the card is set to "open straight into the workbench" and the folder can be opened, the workbench appears in Project scope on that project, showing the conversation that was open last time (or a new chat). Otherwise the project page appears on its first tab.
3. On the project page's assistant tab (「AI 助手」) the user sees the project's links, running conversations, earlier conversations and a 「新建会话」 button.
4. Pressing 「新建会话」 opens the workbench with a new chat in that project. The agent is the one last used on this device unless the project does not enable it; then the project's first enabled agent.
5. Tapping an earlier conversation opens it in the workbench.
6. The workbench's back control returns to the project page; back from the project page returns to the home screen (the page shrinks into its tile).
7. Failure cases, each with a plain sentence and no navigation: the card has no directory; the directory does not exist; the directory is outside the allowed root or in a system location; the folder's workspace project is archived (the user is told to restore it first); the requested agent is not enabled for the project.

### UF-03 Switch to another project inside the workbench (PJ-019, PJ-023)

1. **Desktop/tablet:** the side list is a column at the left; the project switcher sits near its top. **Phone:** the user first opens the side list with the top-left button or by swiping a finger left-to-right over the chat; it slides in as a sheet.
2. The user presses the switcher. A popover lists pinned projects first (in pin order), then the rest by most recent activity. With seven or more projects a search field appears.
3. The user taps a project. Alternative gesture: press the switcher, keep the pointer or finger down, slide onto a row and release; releasing elsewhere leaves the list open.
4. The workbench shows that project at the place it was left (its last conversation, or the new chat that was being prepared there).
5. The project that is open is remembered on this device and is the one the workbench opens next time.

### UF-04 Pin, archive or delete a project from the switcher (PJ-008, PJ-009, PJ-011)

1. In the switcher list the user reveals a row's actions: swipe the row to the left (touch or two-finger trackpad swipe), press the row's "…" button, or use the context menu. Only one row shows actions at a time.
2. **Pin / unpin** (「置顶」 / 「取消置顶」): the row moves to or from the pinned section immediately; the pin order is saved for the user and appears on other devices.
3. **Archive** (「归档」): happens at once without a question. A toast offers undo (「撤销」). If the archived project was the open one, the workbench moves to the next project (preferring one that has a project card) or to its empty state. Undo restores the project and returns to where the user was.
4. **Delete** (「删除」, destructive): asks for confirmation naming the project. After confirming, the project and its saved conversations are removed; the folder and its files stay on disk. A toast confirms.
5. **Settings** (project cards only): opens the project's settings tab; back returns to the workbench.

### UF-05 Put a folder project on the home screen (PJ-020)

1. A folder project (one without a card) is drawn with a grey folder icon and its folder name; the switcher shows a hint that such projects can be added.
2. The user presses 「添加到主屏幕」 on its row (trailing button or row action).
3. A project card is created with the folder's name and path and default settings (all agents enabled, assistant on, "open straight into the workbench" on). The hint disappears and the row now shows the card's icon.

### UF-06 Start a conversation in All scope and choose its project (PJ-021, PJ-022)

1. In All scope the user starts a new conversation. It starts in the project of the most recent known session.
2. The chat title bar shows a project chip (icon, name, chevron). Pressing it opens a list ordered like the switcher (pinned first).
3. Choosing another project moves the new conversation there. Any text already typed, and any attachments, move with it (rules in section 4.6).
4. A small "+" in the list opens the "new project" sheet. A project created there that has a local folder becomes the conversation's project at once; the unsent message follows. One without a local folder only produces a toast and changes nothing.
5. After the first message is sent the chip disappears; the conversation's project is shown under the title and can no longer be changed.

### UF-07 Edit or delete a project card (PJ-015, PJ-028)

1. The user opens the project page and its 「设置」 tab (or "Settings" from the switcher row).
2. The same form as creation appears with current values. The user changes fields and presses 「保存项目」. A toast confirms.
3. If scheduled work is pending for the project, changing the directory, removing an agent, switching off the assistant or automation, and deleting are refused with a sentence asking the user to cancel the pending work first. Renaming still works.
4. Delete: a destructive row at the bottom explains what will be removed (the card's settings, automation drafts, API-chat conversations) and what stays (files and agent conversations). Confirming removes the tile and returns to the home screen with a toast. If the delete fails, a toast with a retry action appears.

### UF-08 Use a project's website links (PJ-017, PJ-105)

1. A project with links shows a globe button in its page's navigation bar and a card for its first link on the assistant tab.
2. The globe opens a sheet listing every link with its label, host and live status: a spinner while checking, then a latency in milliseconds, an HTTP status when the site answered with an error, or "cannot connect".
3. A link whose address ends in a health-check path is read as a health endpoint and shows a short summary (overall status, database status, version) instead of a latency.
4. Tapping a link: if the site allows being framed it opens in an in-app browser cover (title, reload, open in new tab, done); otherwise it opens in a new browser tab.
5. A link that is a repository address on the public GitHub service does not leave the app from the assistant tab: it switches to the project's GitHub tab and shows the open-PR count when known.

### UF-09 Create a project by cloning a repository (PJ-006, PJ-005, PJ-083) — reach O

1. The user opens the two-step "create project" dialog and enters a parent folder (typed, chosen from up to five auto-suggestions, or picked in the folder browser) and a repository address.
2. For an address that is not SSH, an optional authentication card offers: a saved token (first one preselected), a one-off token typed now, or none.
3. The confirmation step shows the path, the source and which authentication will be used.
4. On confirm, cloning starts; the dialog shows the latest progress line and all its controls are disabled.
5. Success: the dialog closes and the new project (named after the repository) appears in the list.
6. Failure: the reason is shown (authentication failed; repository not found; target folder already exists; invalid address; connection lost) and the dialog stays on the confirmation step. A failed or abandoned clone leaves no partial folder.

### UF-10 Browse, open and edit a file (PJ-034, PJ-036, PJ-043, PJ-044)

1. The user opens the inspector on Files. **Desktop/tablet:** press the Files button in the chat title bar (or the inspector shortcut). **Phone:** press the single tools button; the inspector covers the screen on the panel used last; choose Files.
2. The project's tree loads once. Folders expand and collapse instantly on tap. A filter field narrows the tree by name.
3. Tapping a text file replaces the tree with the editor for that file. Tapping a common image type opens an image viewer instead.
4. The user edits. A dot beside the file name marks unsaved changes.
5. Save with the save button or the platform save shortcut. A brief "saved" confirmation appears; errors appear in a strip under the editor header.
6. Closing the editor (close button or Escape) returns to the tree exactly as it was (same expanded folders and scroll position). With unsaved changes the user is asked to confirm discarding them.

### UF-11 Create, rename and delete items (PJ-037, PJ-038, PJ-039)

1. Create: header buttons create at the project root; a folder's context menu creates inside that folder. An inline field appears, prefilled with a default name and selected. Enter confirms, Escape cancels.
2. Rename: context menu → rename; the row turns into a field with the current name. An unchanged name cancels silently.
3. Invalid names are rejected with a short message and the field stays open.
4. Delete: context menu → delete; a dialog names the item and warns that deletion is permanent (and, for a folder, includes everything inside). Confirming deletes; there is no trash and no undo.
5. After each operation the tree refreshes and a short toast confirms.

### UF-12 Upload and download (PJ-040, PJ-041)

1. Upload by the header upload button (multi-file picker, target = root), by a folder's upload action (target = that folder), or by dragging files or folders from the desktop onto the tree (dropped on a folder → that folder; on a file → its parent; on empty space → root).
2. During upload a banner shows a percentage and the file name or count. On completion it reports how many files were uploaded; on failure it shows the reason.
3. A file with the same name as an existing file replaces it without asking.
4. More than the allowed number of files, or a file above the size limit, is refused before sending with a message naming the limit.
5. Download: a file's context menu downloads the file; a folder's downloads a ZIP archive of the folder as the tree currently shows it (ignored files are not included).

### UF-13 Open a file an agent mentioned (PJ-049, PJ-050)

1. In a chat message the user taps a file reference. The inspector opens on Files with that file in the editor. **Phone:** the inspector covers the chat; closing it returns to the chat at the same place.
2. A reference of the form "path:line" places the caret on that line, centred. Tapping the same reference again jumps again.
3. A reference ending in a slash reveals that folder in the tree (all ancestors expanded) instead of opening an editor.
4. Tool rows in the transcript that touched a file offer an "open file" button with the same effect.
5. While composing, typing "@" followed by text lists up to ten matching project files; choosing one inserts its project-relative path.

### UF-14 Review and commit changes (PJ-053, PJ-055, PJ-056, PJ-057, PJ-058)

1. The user opens the inspector on Git. The header shows the current branch; the Changes tab shows two groups: Staged and Changes (unstaged), each with a count.
2. Expanding a row shows that file's diff. Tapping the file path opens the file in the editor with an inline change view.
3. Ticking a file's checkbox stages it; unticking unstages it. "Stage all" and "Unstage all" act on a whole group.
4. The trash control on a modified or deleted file discards its changes after confirmation; on an untracked file it deletes the file after confirmation.
5. The user types a commit message and presses Commit. **Desktop:** the message field is always visible and a keyboard shortcut (modifier + Enter) commits at once. **Phone:** the composer starts collapsed as a "commit N files" button that expands to the field.
6. The button is disabled when the message is blank or nothing is staged. After a successful commit the message clears and the lists refresh.

### UF-15 Work with branches (PJ-061, PJ-062, PJ-063)

1. Pressing the branch name opens a searchable list of local branches plus remote-only branch names. Choosing one switches to it.
2. "Create new branch" asks for a name, states which branch it will start from (the current one), creates it and switches to it.
3. The Branches tab lists local and remote sections. A local branch other than the current one offers Switch and Delete.
4. Delete asks for confirmation and explains that a normal delete only works for fully merged branches; a checkbox enables force delete for an unmerged branch. The current branch cannot be deleted.

### UF-16 Sync with the remote (PJ-064)

1. With no remote configured, no sync controls are shown.
2. With a remote but no upstream for the current branch, only Publish is offered; it asks for confirmation, pushes the branch and sets its upstream.
3. With an upstream: Fetch is always offered; Pull appears with a count when the branch is behind; Push appears with a count when it is ahead. Pull and Push ask for confirmation naming the count and the remote.
4. While any sync action runs, all sync buttons are disabled and the active one shows progress.
5. A failure shows a dismissible error banner in the panel.

### UF-17 Compare and inspect history (PJ-065, PJ-066)

1. Compare tab: the user picks a base branch (default: the repository's main line). The panel lists every file that differs from the common ancestor, including uncommitted and untracked files, with a summary line. Expanding a row loads its diff.
2. Commits tab: the 50 most recent commits across branches are drawn with a branch graph, ref labels, author and date. Expanding a commit shows its files, added/removed line counts and full diff.

### UF-18 Use a worktree for parallel work (PJ-067)

1. Worktrees tab → "New worktree". The user types a branch name. If the branch exists it will be checked out as-is; otherwise the user picks the branch to start from. A line previews where the folder will be created. A checkbox (on by default) switches to the new worktree afterwards.
2. Creating registers the worktree as its own project (named "repository · branch") and, if requested, moves the workbench there. Conversations started there belong to that project.
3. From any other worktree's row the user can Open it, Merge it, or Remove it. The worktree currently in use only shows a tick.
4. Merge: a dialog shows "branch → base" and the number of commits; options: squash (default on), commit message (prefilled), clean up afterwards (default on: remove the worktree and delete its branch). On conflict nothing is changed and the conflicted files are listed.
5. Remove: a dialog warns when there are uncommitted changes (then removal requires ticking "discard uncommitted changes") and offers "also delete the branch" (default on). The linked project is archived, so its conversations stay recoverable.

### UF-19 First steps in a folder without a repository (PJ-054)

1. A project whose folder is not a repository shows an explanation and a single "initialise" button in the Git panel.
2. After initialising, a repository with files but no commits shows a "create initial commit" button that commits everything in the folder.

### UF-20 Review and merge a pull request (PJ-072 – PJ-078)

1. The user opens the GitHub app from the home screen. The top line shows the signed-in account and when data was last synced.
2. A segmented filter chooses: all, awaiting my review, opened by me, my repositories; each shows a count. The choice is remembered on the device.
3. PRs are grouped by repository. Each row shows title, number, author, branches, a compact check summary, change size, review state, a conflict badge and a relative time.
4. Tapping a row opens the PR sheet (**Phone:** bottom sheet at about 92 % height; **Desktop/tablet:** centred dialog). It shows the facts, the list of checks, the changed files and the description. While any check is running it refreshes itself every 15 seconds.
5. If something blocks merging, the sheet states the first blocker in a sentence and the merge button is disabled. Where the app can fix the blocker itself (branch is behind → update branch; PR is a draft → mark ready; workflow runs wait for approval → approve) a button offers it, each behind a confirmation.
6. Otherwise the user presses 「合并…」, chooses one of the methods the repository allows, optionally asks to delete the branch afterwards, and — if a non-required check failed — explicitly acknowledges that.
7. A final confirmation names the repository, the method, the short commit identifier and states that the merge cannot be undone from the app.
8. Result: "merged" or "queued for merge" with the merge commit; the PR disappears from lists at once. If the PR changed in the meantime the merge is refused and the user is offered a reload.
9. Recent merge attempts (including refused ones) are listed under the inbox.

### UF-21 GitHub is not available (PJ-071)

1. If the GitHub command-line tool is missing on the host, not signed in, expired, too old, or cannot reach GitHub, the GitHub app replaces its lists with a setup state: a one-line reason, a 「重新检查」 button, and a folded "how to set up" section containing the single command to run on the host.
2. The user cannot sign in from the browser; signing in happens in a terminal on the host. After doing so the user presses re-check.
3. If the token is valid but cannot merge, the account line shows a "read-only" badge and merge controls explain the missing permission.
4. Elsewhere (branch PR chip, widgets, project tab) missing GitHub access simply shows nothing or a one-line explanation — never an error dialog.

### UF-22 Follow the pull request of the branch being worked on (PJ-080)

1. When the open project's current branch has an open PR on GitHub, a chip "PR #N · state" appears in the workbench title bar. **Phone:** number and coloured dot only.
2. The state is one word or short phrase, worst news first: draft, conflicts, needs branch update, runs awaiting approval, checks failed, checks running, review needed / changes requested / cannot merge yet, checking, mergeable.
3. Tapping the chip opens the same PR sheet as UF-20.
4. The chip refreshes when the window regains focus, once a minute while visible, and immediately after an agent run in the open conversation ends.

### UF-23 Use the terminal, leave, and come back (PJ-085 – PJ-090)

1. The user opens the inspector on Terminal. The first time, a shell starts in the project's folder and prints a one-line notice naming the folder, then the shell's prompt.
2. The user types commands. Interactive prompts (passwords, yes/no) are answered by typing in the terminal.
3. **Phone:** a key bar above the keyboard offers paste, Esc, Tab, Shift+Tab, Ctrl, Alt, the four arrows, interrupt (Ctrl+C) and scroll-to-end. Long-press selects a word and shows handles and a small copy menu. Pinch changes the font size.
4. The user closes the inspector, switches conversation, locks the phone or closes the browser. The shell keeps running on the host.
5. Returning within 30 minutes re-attaches to the same shell: a short "reconnected" notice is followed by the recent output, and a long-running command is still running. After 30 minutes without a client the shell is ended; the next visit starts a fresh one.
6. Switching to another project shows that project's own terminal.

### UF-24 Run a command from a chat message (PJ-091)

1. An agent's reply contains a shell command in a code block. The block shows a run button (「运行」) that is always visible (the copy button beside it appears on hover).
2. The user taps run. The inspector opens on Terminal (**Phone:** full screen) and the command is typed into the project's shell and executed. The button shows a tick for two seconds.
3. Output, and any prompt such as a password request, appears only in the terminal; the user answers there.
4. Nothing is reported back to the agent automatically. Tapping run again runs the command again.

### UF-25 Preview a development server (PJ-092, PJ-097)

1. The user starts a development server in the project terminal. When it prints its address, a dot appears on the Preview tab.
2. On Preview, the newest detected address is loaded in a frame; up to six detected addresses are offered as chips.
3. The user may type any http(s) address (a bare "host:port" is accepted) and submit, reload, or open the address in a new browser tab.
4. If the address is a loopback address but the user is on another device, a note explains that it may not open and offers to substitute the host name the product itself is reached by.
5. If the product is served securely and the address is not, a note explains that the browser refuses to embed it and points to "open in new tab".

### UF-26 Have an AI build an app (PJ-098 – PJ-101)

1. Home "+" → sheet in "let an AI build it" mode.
2. The user describes what to build (up to 8000 characters). After a short pause a name is suggested; Enter or Tab in the empty name field adopts it. The user may type a name and choose an icon instead.
3. A notice under the form states which permission mode this build will use and, in restricted mode, what the AI will not be able to do (install, run, test) and what the administrator would have to do to enable the sandbox.
4. The user presses 「开始开发」. Missing description or name moves focus to the field with a hint; nothing else blocks.
5. The sheet closes, a tile appears immediately and a toast says development started.
6. The tile shows progress: queued, planning, then a percentage that follows the agent's own checklist; finally a short completion animation, or a "not finished" / "stopped" state.
7. Tapping an unfinished tile opens the build's conversation in the workbench, where every step can be read.
8. In home edit mode a running build can be stopped (with confirmation; files written so far are kept) and a failed one continued.

### UF-27 Use a built app and ask the AI to change it (PJ-102 – PJ-104)

1. Tapping a finished build's tile opens its project page on a "home" tab (「主页」) that starts the app and shows it in a frame. States shown while waiting: starting; opening.
2. **Desktop (≥ 1024 px):** an AI side panel sits beside the app. **Narrower:** a floating button opens the panel as a bottom sheet.
3. In the panel the user types a change request (up to 2000 characters) and sends it. A banner over the app shows the AI's current step. When the AI finishes, the app restarts on the new code and the frame reloads.
4. If the app fails to start, the page shows the reason, the last lines of its output, a retry button and a "let the AI fix it" button that sends the reason and the output to the build's conversation.
5. The project's settings tab shows the app's run state and Start / Restart / Stop buttons. An app left unused for 30 minutes stops by itself and starts again when opened.

### UF-28 Work on a remote host (PJ-026, PJ-027)

1. The administrator lists SSH hosts in the Service's configuration; users cannot add hosts from the browser.
2. When creating or editing a project card the user picks one of the hosts instead of "this computer" and enters the directory on that host.
3. The project's assistant tab shows the host with online/offline state and a re-check button, and one card per enabled agent plus a terminal card. An agent that is not installed on the host is marked so and disabled.
4. Tapping a card opens a full-screen terminal connected to that host, in the project's remote directory, running the agent (or a login shell).
5. Pressing 「完成」 only detaches. The session keeps running on the host; opening the same card again returns to it. (If the host lacks a terminal multiplexer the session ends on detach and the page says so under details.)
6. Settings lists all configured hosts with state, latency and which tools were found.

### UF-29 Look at background work (PJ-107)

1. When a conversation's agent has launched sub-agents, background commands or workflows, a 「后台任务」 button appears near the composer with a count of running ones.
2. Pressing it opens a sheet (**wide column:** side sheet; **narrow:** bottom sheet) listing tasks newest first with kind, status, elapsed time and token count.
3. Selecting a task shows its detail: for a command, the command line and the tail of its output; for a sub-agent or workflow, its read-only transcript.
4. Escape steps back, then closes. The conversation stays usable the whole time.

### UF-30 Recover an interrupted run (PJ-109)

1. After a Service restart or a failed run, the affected conversation shows a compact card above the composer: "task interrupted" or "task not finished", noting that some operations may already have happened.
2. "View" reveals the original input (read-only) and refreshes the transcript so the user can check what was done.
3. "Continue" sends one continuation message asking the agent to check the current state first and not repeat finished steps. The card closes.
4. The close control dismisses the card without running anything.
5. A run continued or dismissed on one device disappears from the others.

### UF-31 Use slash commands (PJ-115 – PJ-117)

1. In an agent chat the user types "/" at the start of the field or after a space. A list of commands opens above the field.
2. Typing narrows it. Up/Down move, Enter runs the highlighted entry, Tab only completes the name into the field, Escape closes.
3. A built-in command opens its dialog or acts immediately (section 4.19). A custom command's text, with arguments substituted, is sent to the agent as an ordinary message. A skill's name is inserted into the field for the user to finish and send.
4. While a run is in progress, text starting with "/" is not intercepted; it is treated like any other message.

### UF-32 Add a tool server for an agent (PJ-110 – PJ-112) — reach O

1. In the agent's settings the user opens the tool-server list and chooses "add" (for this agent, or for all agents at once).
2. The user picks a scope (user-wide, a project, or — for agents that support it — a private per-project scope), a transport (local process or network), and fills in the fields; or pastes a JSON definition.
3. Saving writes the entry into the agent's own configuration; the list refreshes. The same name in the same scope replaces the old entry.
4. Entries can be edited (scope cannot be changed) or deleted after a confirmation. Entries registered by the product itself are shown locked.

### UF-33 Install a skill (PJ-113, PJ-114) — reach O

1. The agent's skill list shows discovered skills grouped by where they come from, with a search field.
2. "Add skill" opens a dialog where the user drops or chooses a skill folder or a skill definition file. Queued items show name, size and file count.
3. Installing copies them into the agent's user-level skill location; an existing skill of the same folder name is replaced entirely. The list refreshes and a confirmation shows.

### UF-34 Install and use a plugin (PJ-118, PJ-119) — reach O

1. In plugin settings the user pastes a Git address (or taps install on a recommended plugin) after reading a warning to install only trusted code.
2. The plugin is downloaded, checked and built; it appears as a card with version, an enable switch, update and uninstall.
3. An enabled plugin adds one tab to the project workspace. Opening the tab loads the plugin's interface, which receives the current theme, project and session and can call its own server-side part.
4. Disabling removes the tab and stops the plugin's process. Uninstall is a two-step confirmation.

### UF-35 Plan tasks with the external planning tool (PJ-121) — reach O

1. A per-user switch enables the feature; it requires the planning tool to be installed on the host (settings show how to install it when missing).
2. In a project that is not set up, the tasks tab explains the feature and offers to initialise (an embedded terminal runs the tool's setup).
3. With tasks present the user gets a board (columns by status), list and grid views, search, filters, sorting, and a task detail dialog where the status can be changed.
4. A requirements-document editor creates and edits documents in the project's planning folder. Generating tasks from a document is done by asking the agent; the editor only shows how.

---

## 4. Screens and interaction requirements

Rules that apply to every screen in this domain:

- **Unreachable is not gone.** When a read fails (offline, timeout), keep showing the last good content and add an inline notice with a retry control. Only a definite "does not exist" answer may show a "not found" state.
- **Only the newest answer wins.** A slow earlier response must never overwrite a later one (project lists, PR reads, file-mention lists, comparisons).
- **Errors are sentences.** One plain sentence in the interface language; technical detail folded under a "details" disclosure; never a raw English browser error.
- **Touch targets** are at least 44 px. Controls that appear on hover for a pointer must be permanently visible, or reachable another way, on touch devices.
- **Sheets and dialogs** trap focus, close with Escape and a tap on the backdrop (unless an operation is in flight), and return focus to the control that opened them.
- **Reduced motion:** slides and pulses become fades.
- **Never show a folder path where a name will do** in the main interface (switcher, chip, lists show names only).

### 4.1 "New project" sheet

- **Shows:** title; close button; a two-option mode switch (AI build / manual) operable with arrow keys; the form of the chosen mode. Both forms stay alive while the sheet is open so switching loses no input.
- **Focus order:** close → selected mode → the visible form. Closing plays an exit animation and returns focus to the "+" that opened it.
- **States:** idle; saving (form locked, spinner on the primary button); inline error.
- **Phone:** bottom sheet with grabber; action bar pinned above the keyboard. **Desktop/tablet:** centred.

### 4.2 Project form (creation and the settings tab)

| Field | Rule | Default for a new project |
|---|---|---|
| Name | Required after trimming; 1–80 characters; any characters | empty (preview shows a placeholder name) |
| Description | 0–1000 characters | empty |
| Location | "This computer" or one of the configured remote hosts. The host choice appears only if at least one host is configured. A previously saved host that is no longer configured stays selectable. | this computer |
| Directory (local) | 0–1000 characters; if not empty it must be an absolute path. Empty is allowed: then only API chat and non-folder features work. | empty |
| Remote directory | 0–300 characters; "~", "~/…" or an absolute path made only of letters, digits, dot, underscore, dash and slash; no ".." segment. Requires a host. | empty |
| Open straight into the workbench | Switch (local projects) | on |
| Links | 0–8 rows; label required, ≤ 40 characters; address required, ≤ 500 characters, http or https only. "Add link" is disabled at 8. | none |
| Icon colour | One of 8 muted colours | slate |
| Icon symbol | One of 11 symbols (folder, waveform, graduation cap, candlestick chart, line chart, mail, terminal, spark, book, globe, cloud) | folder |
| Agents | One switch per offered agent/model; "only available inside this project" | all on |
| Features | Switches: assistant; automation | assistant on, automation off |

- With the assistant switched on, at least one agent must be enabled.
- **Controls:** cancel (creation only); primary button 「创建项目」 / 「保存项目」; in settings only, a destructive 「删除项目」 row with a footnote on what is removed.
- **States:** idle; saving; inline error from the service (for example the name-length sentence, "directory must be an absolute path", the pending-work refusal); success toast.
- **Built apps:** the settings tab begins with an "app" section showing run state (reading / running / starting / failed to start / not running) with Start, Restart and Stop.

### 4.3 Project page

- **Navigation bar:** back control (returns to the home screen from any tab; when a view has been pushed over a tab it reads "back to <tab>"); project name; globe button when the project has links.
- **Tab strip** in this order: app home (built apps only) → assistant (when the assistant is on or the API chat model is enabled) → GitHub (when a link is a repository address) → automation (when on) → settings (always). Opens on the first tab. Switching tabs does not add browser history and opens the tab at its top.
- **Assistant tab, top to bottom:**
  1. *Links card* (if any links): first link with label, host and an open button (new tab); a status line under it if a later link is a health endpoint ("checking…", then a summary such as status, database status and version); remaining non-health links as chips; a repository link as an in-app button with the open-PR count.
  2. *Remote host block* (remote projects only): section 4.22.
  3. *Sessions:* primary button 「新建会话」 (local directory) or 「新建对话」 (no local directory), disabled when nothing can start; a 「终端」 button (local directory only) that opens the full-screen terminal; a hint to fill in the directory when the assistant is on but no directory is set; a "running" section with a count; a history section with a refresh button.
  4. *Rows:* agent mark, title (an untitled one reads 「新会话」 / 「新对话」), agent name, time (clock time today, "yesterday", otherwise month/day) or a live indicator. The first 8 rows are shown, then "show all N" / "collapse".
- **Data:** up to 50 agent conversations of the folder plus the project's API-chat conversations, newest first. Running state is re-read every 15 seconds while visible and on window focus.
- **States:** loading sessions; empty ("no sessions yet — press new session"); inline error; unknown project ("this project does not exist or was deleted" + "back to home"); list still loading (activity indicator).
- **Without a local directory** API-chat conversations open in a chat view pushed over the tab; the tab stays mounted and keeps its scroll position.

### 4.4 Links sheet and in-app browser

- **Sheet:** title "<project> · websites"; done button; one card per link: label, host, status, open glyph.
- **Status values:** spinner while checking; for a health link its summary with a coloured dot; otherwise green dot + "N ms" (answered successfully), "HTTP <status>" (answered with an error), "cannot connect" (no answer, or the status read failed).
- **Open behaviour:** frameable → in-app browser cover; otherwise new tab.
- **In-app browser cover:** done, title, reload, open-in-new-tab; the page runs in a sandboxed frame. Escape closes the browser first, then the sheet.

### 4.5 Workbench side list — project parts

Top to bottom in Project scope: back control (labelled with the page the user came from, home otherwise); scope switch 「全部 | 项目」; hide/close button; **project switcher**; new-chat button (reads "draft" when the project's never-sent new chat holds text); session search; history (domain 1).

**Switcher trigger**

- Shows project icon (card colour and symbol, or a grey folder), name (「选择项目」 if none), up/down chevron.
- When closed it carries at most one dot summarising the *other* projects: red if any needs the user, otherwise white if any has a finished conversation not yet seen. Never a spinner.
- Its accessible name states the current project and the counts for other projects (running, needing the user, finished).
- Loading: skeleton.

**Switcher popover** (about 320 px wide)

- Search field only when there are 7 or more projects; matches the card name and the folder name, never paths. Not auto-focused on touch-only devices (so the keyboard does not rise).
- Section "pinned" (「置顶」) in pin order; section "recent" (「最近」, headed only when both sections exist) ordered by newest conversation activity; projects without activity keep the service's order at the end.
- Row: icon, name, pin glyph, marks, tick on the current project. Marks: one animated running mark per agent at work, in that agent's colour; a red "needs you" dot; a white "finished" dot only when there is no red one.
- Folder projects additionally show a trailing "add to home screen" button and a one-line hint.
- Footer link to manage projects on the home screen.
- Empty states: no project at all; no project whose name contains the query.
- **Row actions:** revealed by swiping left, a "…" button, or the context menu; one row open at a time; tapping elsewhere or the open row closes it; the tap that ends a swipe never selects the row; Escape closes the actions but keeps the popover. Actions: pin/unpin; add to home screen (folder projects); settings (project cards); archive; delete (red).
- **Press-and-slide:** pressing the trigger opens the list at once; sliding highlights the row under the pointer; the list auto-scrolls near its edges; lifting on a row selects it; lifting elsewhere leaves the list open. While a finger slides, nothing behind the list scrolls, and that block ends with the touch.
- **Touch vs pointer:** swipe actions work with a finger and with a two-finger trackpad swipe; the "…" button remains available on touch screens.

### 4.6 Project chip (All scope, new conversation only)

- **Shows:** icon + name + chevron in the chat title bar, before the tool buttons. Accessible name: "project: X, change project".
- **Menu** (about 300 px): same ordering and section headings as the switcher; pins are read-only here; tick on the current one; its height can be dragged by a corner handle (minimum 140 px; arrow keys change it in 40 px steps) and is remembered on the device.
- **"+"** ("add project") sits on the last section heading; it exists only when the home screen is available behind the workbench; it never takes initial focus; pressing it closes the list without selecting.
- **Draft-carry rules** when the project changes:
  - text and attachments move to the chosen project's new chat;
  - attachments alone also move;
  - if the destination already holds an unsent draft, the two are swapped rather than one overwritten, and moving back restores both;
  - between an agent chat and the API chat model, text follows but attachments stay;
  - nothing moves when the draft is empty or blank, when the project is unchanged, or while a first message is being sent or awaits its delivery receipt.
- **Locked state:** once the conversation exists, the chip is replaced by the project name under the title.

### 4.7 Workbench centre states related to projects

| Situation | What is shown |
|---|---|
| Projects still loading | Skeleton |
| No projects | "No projects yet" with a link back to the home screen |
| Project list could not be read | "Project list failed to load" + retry + back to home |
| Address names an unknown project | "Cannot find this project" + "open the most recent project" |
| Conversation cannot be reached right now | "Could not open this conversation" + retry |
| Conversation definitely gone | "This conversation no longer exists" + "start a new one" |
| Old address form for a conversation that is gone | "Cannot find this conversation" + "open the workbench" |

### 4.8 Inspector

- **Title-bar controls.** **Desktop/tablet:** a group of four buttons (Files, Terminal, Git, Preview); pressing the active one closes the inspector; tooltips mention the inspector shortcut. **Phone:** one button that opens the inspector on the panel used last.
- **Header inside:** the same four choices as a segmented control (labels collapse to icons when the panel is narrower than about 380 px), and a close button.
- **Presentation.** Desktop: docked beside the chat; the chat always keeps at least 360 px. Tablet: floats over the chat with a shadow, at most the window width minus 32 px. Phone: full screen, sized to the visible area above the on-screen keyboard.
- **Resizing** (not on phone): drag the left edge; width 320–1100 px, default 440 px; double-click the edge resets to 440 px. The width is remembered when the drag ends.
- **Panel lifecycle.** A panel is created the first time it is shown, after the slide-in animation ends (a plain panel in its background colour stands in), and then stays alive while hidden or while the inspector is closed — the terminal keeps its shell, the tree keeps expanded folders and scroll. Changing project rebuilds the inspector for the new project.
- **Closed inspector** is removed from the tab order and from assistive technology.
- **Preview tab dot** when a new address was detected while the panel was not visible.
- **Availability.** The same four tools are offered in Project scope and, for a conversation that has a project, in All scope. Without a project there are no tool buttons.

### 4.9 Files panel — tree

- **Header controls, in order:** upload (tooltip states the per-file limit; shows a spinner and a mini progress bar while uploading); new file; new folder; refresh; collapse all; three view-mode buttons; filter field with a clear button. Action buttons are disabled while an operation runs.
- **Listing rules:** the whole tree is loaded in one request; folders first, then names in locale order; no user-selectable sort; dot-files are shown; a symbolic link is listed as a file, even when it points to a folder *(inferred)*.
- **Always hidden:** dependency folders and version-control metadata folders (the usual names). **Additionally:** if the project root has an ignore file, its rules (including negations) hide files and folders — only the root ignore file is read; if there is none, a fixed list of conventional build, cache and virtual-environment folder names is hidden.
- **Depth:** 10 levels below the root; deeper folders are listed but cannot be expanded. **Size:** more than 10,000 visible entries is refused (see 5.3).
- **View modes:** simple (names); compact (names + size and permissions for files); detailed (columns: name, size, modified, permissions — the default). Size uses base-1024 units with one decimal; modified time is relative ("just now", minutes, hours, days up to 30) then a date; permissions are the nine-character read/write/execute form.
- **Filter:** case-insensitive substring on names; a folder stays if it or any descendant matches; matching branches expand automatically; clearing the filter does not re-collapse.
- **Context menu** (right-click; must also be reachable on touch — the old system relies on the browser's own long-press context event, which is unreliable on phones): file → rename, delete, copy path, download; folder → new file, new folder, upload, rename, delete, copy path, download. Arrow keys move, Enter/Space activates, Escape or an outside click closes.
- **Inline create/rename:** field prefilled and selected; Enter confirms, Escape cancels, clicking away confirms.
- **Name rules:** not blank; none of `< > : " / \ | ? *` or control characters; not a reserved device name (CON, PRN, AUX, NUL, COM1–9, LPT1–9, case-insensitive, exact match only); not only dots. Violations show a red toast and keep the field open.
- **Upload entry points:** header button; upload action on a folder row; folder context menu; drag-and-drop. Dropped folders are walked recursively and their structure recreated; operating-system clutter files are skipped. The picker cannot pick folders.
- **Drag-over state:** dashed overlay naming the target; the target folder row is highlighted.
- **Upload banner:** in progress (percentage capped at 99 until the service answers; file name or count); success for about 1.4 s ("uploaded X of Y"); failure for about 3.2 s with the reason.
- **Toasts** (3 s): created, renamed, deleted, path copied, folder downloaded as ZIP, uploaded N files, or the service's error sentence.
- **Delete dialog:** title names the kind; body states that deletion is permanent (and for folders that all contents go); cancel and a red delete button with spinner.
- **Image viewer** (for common image extensions opened from the tree): name, close, the image, the path; states loading / cannot load.
- **States:** loading (the old system blanks the panel on every refresh and loses the scroll position — the rebuild should keep the tree visible while refreshing); empty project ("no files found — check the project path is accessible"); no filter match; load failure with the service's sentence and refresh as the only retry.
- **Refresh:** manual, and automatic after every operation done in the tree. The old system does not refresh after agent edits or terminal activity (see open question Q-07).
- **Reveal:** a request from chat expands every ancestor of the named folder as far as the tree contains it.
- **Phone:** no special layout in the old system; rows must still meet the touch-target rule and every context-menu action must be reachable by touch.

### 4.10 Editor

- **One file at a time**; no tabs. Opening another file while the current one has unsaved changes asks for confirmation.
- **Header, in order:** file name with unsaved dot; copy path (confirmation for 2 s); Markdown preview toggle (Markdown files); "open HTML preview in new tab" (HTML files); editor settings; download (downloads the current buffer including unsaved edits); save (label changes to saving… then saved for 2 s); close.
- **Tool strip:** change navigation in diff mode ("i / N changes", previous, next — wrapping — and a show/hide-highlight toggle); expand/collapse editor width (text files only).
- **Footer:** line count, character count, a reminder of the save and close keys.
- **Editing:** line numbers, folding, bracket matching, auto-closing brackets, completion, selection-match highlighting, in-file search, undo/redo; single cursor.
- **Highlighting** by extension: JavaScript and TypeScript families (including module variants), Python, HTML, CSS and its common preprocessors, JSON, Markdown, and environment-variable files; everything else plain. Theme follows the app's light/dark setting.
- **Save:** platform save shortcut anywhere on the page while the editor is open, or the save button. Encoding is always UTF-8.
- **Unsaved-changes guard:** closing (Escape, close button), opening another file, and leaving the page ask before discarding. A file is not "changed" merely because of its line-ending style; undoing an edit by hand clears the mark. Escape is ignored while a menu, dialog or other overlay owns it.
- **No conflict detection:** if the file changed on disk meanwhile, saving overwrites it (see Q-08).
- **Jump to line:** honoured once per request; beyond the end goes to the last line; typing afterwards does not pull the caret back.
- **Diff mode:** inline (unified), removed lines red, added lines green, changed words emphasised, gutter markers, a "showing changes" badge, scrolled to the first change; optional minimap with change markers. No accept/reject controls. Baseline when opened from the Git panel: the last commit versus the working file; an untracked file shows as entirely added; a deleted file shows its last committed content.
- **Markdown preview** renders the unsaved buffer: tables and task lists, display maths, highlighted code blocks with a language label and copy button, diagrams from fenced diagram code (source shown while loading or on a parse error); links open in a new tab.
- **HTML preview** opens a new tab showing the unsaved buffer in a sandboxed frame (scripts, forms, dialogs and pop-ups allowed; no access to the product's origin).
- **Media:** images (common raster formats, vector, animated), PDF (verified by its signature before display), video and audio open as previews with no autoplay and an "open in new tab" link (not for vector images). Known binary types (archives, executables, office documents, fonts, databases, disk images, compiled code) show a "binary file — cannot be displayed" placeholder. Saving does nothing for previews and binaries. Any other file is shown as text.
- **States:** loading ("loading <name>…"); load error (a non-editable error state, never error text inside the editable buffer); save error strip; media loading; media error.
- **Expand:** the inspector takes all width the chat can spare (desktop: chat keeps 360 px; tablet: window minus 32 px; no effect on phone).
- **Settings (per user, synced):** word wrap (default off), minimap (on), line numbers (on), font size (default 12; choices 10–16, 18, 20). A change reaches an open editor immediately and other devices on their next preference sync.

### 4.11 Git panel

**Header** (hidden entirely when the folder has no repository)

- Branch button: current branch name followed by "↑n" (ahead), "↓n" (behind) or a tick (up to date) when a remote exists.
- Branch dropdown: auto-focused search; local branches plus remote-only names (shown without the remote prefix); tick on the current one; "no matching branches"; "create new branch" at the bottom. Choosing switches immediately; the dropdown closes only on success.
- Sync buttons per UF-16. **Phone:** icons only. **Desktop/tablet:** icon + label.
- Icon buttons: undo latest local commit; refresh (spins and is disabled while loading).
- Error banner: red, dismissible.

**Confirmations** (cancel, Escape and backdrop all cancel): pull, push, publish, undo commit ("removes the commit but keeps its changes staged"), discard ("cannot be undone"), delete untracked file ("cannot be undone"), commit via the button (names the count and message), switch branch from the Branches tab (reminds about uncommitted changes), delete branch. Fetch has none. The keyboard commit shortcut skips the confirmation.

**No repository:** title, one-paragraph explanation, an initialise button (with progress label), failure text under the button. **No project selected:** a one-line prompt.

**Sub-tabs:** Changes (badge = number of changed files), Compare, Commits, Branches, Worktrees; the strip scrolls sideways when narrow. The panel always opens on Changes.

**Changes**

- Commit composer: three-row message field; "N files selected"; commit button disabled when the message is blank, nothing is staged, or a commit is in flight. Success clears the message; failure keeps it.
- Two sections, each ordered modified → added → deleted → untracked: "Staged (n)" with "unstage all" (empty text when none); "Changes (n)" with "stage all" (empty text when everything is staged).
- A file appears once: under Staged if the index holds any change for it.
- Classification: conflicted files are shown as modified and never as staged; a staged rename appears under its new path; ignored files are omitted.
- Row: checkbox (staged state; toggles optimistically, requests are applied one at a time, and the list re-reads the true state afterwards so staging done outside the app shows too); expand chevron; path (opens the file with a change view); trash (discard for modified/deleted, delete for untracked, none for newly added); status badge with letter M / A / D / U.
- Expanded diff: additions green, deletions red, hunk headers tinted, context muted, scroll area capped in height. **Phone:** a wrap/scroll toggle, wrap on by default. **Desktop:** horizontal scroll.
- Diff limits in the viewer: at most 200,000 characters and 1,500 lines, with a notice when cut. Untracked file → all additions; untracked directory → a one-line note; deleted file → all deletions; tracked file → unstaged changes if any, otherwise staged ones.
- States: spinner; "no changes detected"; "no commits yet" with the initial-commit button.
- Desktop only: a small legend explaining the status letters.

**Compare**

- Base selector grouped into local and remote branches, plus a refresh button. Default base: local main line by its conventional names, then the remote's, then the first branch that is not the current one.
- Summary "N files changed vs <base>" and the short identifier of the merge base.
- Rows sorted by path with badge M / A / D / R / U and "renamed from <old>". Diffs load on expand; a failed load shows a sentence and retries on re-expand; a pure rename says so.
- States: no differences; no branches available; base shares no history with the current branch; comparison failed (with the reason).
- Re-runs whenever the change list reloads, keeping the list on screen and reloading open diffs in place. Changing base collapses all rows.

**Commits**

- Up to 50 commits across local branches, remote branches and tags, children before parents; a lane graph with cycling colours and a larger dot at merges and forks; ref pills (tags marked); one-line subject; author and short date; 7-character identifier.
- Expanding a commit shows full identifier, author, date, a files/added/removed summary, a changed-files list with per-file counts, and the diff.
- States: spinner; "no commits found". No paging or search in the old system (Q-10).

**Branches**

- Summary of local/remote counts; new-branch button; search; sticky "Local" and "Remote" sections.
- Current row: "current" pill, ahead/behind, tick. Other local rows: switch, delete. Remote rows: "remote" pill, no actions.
- New-branch dialog: name field with an example placeholder, a note naming the branch it starts from, cancel/create. Enter submits; success switches to the new branch.
- **Touch:** row actions must be visible without hover.

**Worktrees**

- Top row: count of linked worktrees, refresh, "new worktree".
- Row: icon (main checkout vs linked), branch name or "detached @ <short id>", pills (current, main worktree, locked), last two path segments, ahead/behind versus the base branch, "n changes", last commit subject.
- Row actions (any worktree other than the current one): open; merge (disabled when detached or zero commits ahead, with an explanation); remove. The main checkout offers only open. One action runs at a time; the busy row shows a spinner. Actions are always visible on narrow screens.
- Empty state: a short explanation of what worktrees are for and a "create your first worktree" button.
- Error banner: sentence plus details, with the first five conflicted files when relevant.
- Dialogs per UF-18.

### 4.12 GitHub app

- **Account line:** status dot; account name (or "not signed in"; a neutral title before the first answer); "syncing…" or "synced <relative time>"; a "read-only" badge when the login cannot merge.
- **Setup state:** reason heading; re-check button with spinner; folded "how to set up" with the one command to run on the host and a note that the product only calls the tool and never reads or stores its token.
- **Loading:** skeleton groups. **Error:** a callout "cannot read GitHub", folded details, retry; the previous list stays visible beneath.
- **Reload triggers:** opening; tab becoming visible; leaving a repository page (all may use cached data); the refresh button, retry, re-check and after any merge or fix (fresh read).
- **Filter** (segmented, each with a count): all / awaiting my review / opened by me / my repositories.
- **PR list:** grouped by "owner/name" with a count, groups ordered by most recent activity. Row: mark tinted by check state; title (two lines); draft badge; number; author; "head → base"; up to 8 check beads (failures first); a check label (N failing / N running / all passing / no checks); "+adds −dels", N files; review badge (approved / changes requested / review needed); conflict badge; relative time (re-evaluated every 30 s).
- **Empty texts** per filter; a footer when a category was truncated at 50.
- **My repositories:** row with icon tinted by default-branch checks, name, private/public, fork, archived, description (two lines), language, default branch, check state, open-PR and issue counts when above zero, last-push time. Footer when the account has more than are listed. Tap → repository page with a back button; back keeps the filter.
- **Repository page:** card (name, external "open on GitHub" link, description, visibility, fork/archived, default branch, last push, newest default-branch commit with check dot, short identifier and title); "open PRs" section (count, rows as above, empty text, truncation footer); "recent merges" section (hidden when empty; rows link out).
- **Merge log:** up to 6 rows with repository and number, method or "not executed", short commit, message, time, and a badge (merged / queued / refused / failed / to confirm / in progress / invalid request).
- **Phone:** chevrons hidden; filter full-width; no pull-to-refresh and no swipe-to-dismiss in the old system.

### 4.13 Pull-request sheet

- **Header:** close (or back on the merge step); title; refresh; "open on GitHub".
- **Detail step:** repository; title; author and updated time; "head → base"; short commit identifier; facts: checks (counts or "none"), review (badge or "not required"), changes (+/− with a five-square diffstat), mergeability (no conflicts / being computed / conflicts / behind the base / blocked by branch protection / checks failing / merged / closed).
- **"Can be handled here"** section with the quick fixes that apply.
- **Checks list:** icon, name, workflow and state (failing / running / passing / skipped), "required" badge, external log link; ordered failing → running → passing → skipped, required first; first 100.
- **Files:** first 8, then "show all N"; change letter A / M / D / R / C; first 100.
- **Description:** plain text, six lines, expandable.
- **Footer:** with a blocker — its sentence and a disabled merge button; otherwise 「合并…」.
- **Merge step:** a small branch-into-base drawing; method choices (only those the repository allows; order squash / merge commit / rebase) with a one-line explanation; the last method used per repository is preselected; "delete <head> after merging" switch (off by default; hidden for forks, auto-delete repositories and merge queues; a note when the repository deletes automatically); warning with an explicit "I understand, merge anyway" switch when a non-required check fails (the acknowledgement lapses if the head commit changes); notes for running checks, merge queue, missing or negative review; facts; red "merge #N" button; final confirmation.
- **Done step:** "merged" or "entered the merge queue", message, merge commit, done button; toast.
- **Quick-fix confirmations:** update branch (non-destructive; names base, head, short commit); mark ready; approve runs (destructive styling; lists the runs and their environments; warns about running outside contributors' code with secrets).
- **Behaviour:** opens from cached data and re-reads if the head differs from the row; re-reads every 15 s while a check runs (detail step, tab visible) and 4 s after an update-branch; cannot be closed while a merge or fix is in flight; errors show as a callout ("not merged" / "merge outcome unknown" / "not completed") with a reload button for stale-state refusals.
- **Phone:** bottom sheet at about 92 % height; method buttons wrap to full rows.

### 4.14 Branch PR chip

- Text "PR #N", a coloured dot and a state label; tooltip with the PR title and branch. Tones: green (mergeable), orange (needs action), pulsing orange (in progress), red (conflicts, failed checks), grey (draft).
- Not rendered when there is no such PR, the folder is not a checkout of a GitHub repository, GitHub access is missing, or the first read failed. A later failed read keeps the last value.
- The sheet opened from the chip stays open even if a merge makes the chip disappear.

### 4.15 GitHub and CI widgets (home screen)

- **GitHub widget.** Small: "N PRs" and a one-line check summary. Medium: first three PRs and the total. Large: the figure plus four PRs. Header shows "N awaiting review" when applicable and "may be stale" after a failed poll. Tap opens the GitHub app.
- **CI widget.** "N running" and "N queued"; rows with title or workflow, repository, and "running · N min" / "queued" / "<result> · N min ago"; dot colours for running, queued, success, failure. Small: figures; medium: two runs; large: figures plus five runs. Empty: "no recent CI runs".
- Neither is in the default widget set. Polling: GitHub widget every 2 minutes; CI widget every 30 s while anything is active, otherwise every 2 minutes; both pause when hidden or covered.

### 4.16 Terminal views

**Minimal view** (inspector panel, full-screen cover, sign-in dialog)

- Only the terminal surface and, on narrow screens, the key bar. Fixed dark theme, 14 px monospace font, blinking cursor, 10,000 lines of scrollback.
- **States:**
  - before the connection: empty dark surface;
  - connected: a one-line notice naming the folder, then output;
  - connection lost: the terminal reconnects with back-off and shows a small "reconnecting" indication;
  - refused by the service: a red line in the terminal ("invalid project path", "invalid session", "too many active terminals — close one and try again");
  - process ended: a yellow line with the exit code; further typing is ignored; a "start again" control is offered.
- **Sizing:** refits and tells the service the new columns and rows whenever its container changes (rotation, inspector drag, on-screen keyboard), debounced by about 50 ms.
- **Copy/paste:** copy shortcut with a selection copies, without one sends an interrupt; paste shortcut sends the clipboard as input; programs may set the clipboard through the standard terminal sequence.

**Full-screen cover** (from the project page): header with 「完成」, a heading ("Terminal" or the agent and host), a caption ("this computer · <project>" or "<host> · SSH"). Escape closes only when focus is on the cover, not inside the terminal. Closing only detaches.

**Key bar** (width < 768 px; pinned to the bottom of the terminal view; scrolls sideways; never takes focus, so the on-screen keyboard stays up; disabled while disconnected). Keys in order: paste, Esc, Tab, Shift+Tab, Ctrl (sticky), Alt (sticky), ↑, ↓, ←, →, Ctrl+C, scroll to end. Ctrl/Alt apply to the next key, whether it comes from the bar or from the on-screen keyboard.

**Touch (any size):** long-press (about 600 ms) selects the word under the finger and shows two handles and a floating "copy / select all" menu; dragging extends; the selection point sits above the finger so it is not hidden; a tap clears. Selecting dismisses the on-screen keyboard; a plain tap focuses the terminal and raises it. Two-finger pinch changes the font size between 8 and 48 px and refits (not remembered). One-finger scrolling coasts.

**Full view** (reach O, agent CLI terminal): header with status dot, session title, and buttons: restart; disconnect (while connected); a toggle that starts the agent's CLI with its permission prompts skipped (see Q-16). Overlays: loading; connecting (naming the project and what will run); a large "continue in shell" button. On narrow screens, when the visible output ends with a numbered choice prompt (2–5 options), a strip of buttons "N. label" plus Esc appears; tapping one sends that digit.

### 4.17 Run button on code blocks

- **Which blocks:** fenced blocks tagged as a shell language (bash, sh, shell, zsh, console, shellsession, terminal; case-insensitive) with a non-empty command; and untagged blocks of 1–8 non-blank lines in which every line is a command starting with a well-known program name or a path, a comment, or a continuation of a line ending in a backslash, with at least one real command. Not: other languages, inline code, empty blocks, blocks that mix commands with output or prose, file trees, configuration, or blocks of 9 or more lines.
- **Where:** only where a terminal sits beside the transcript (Project scope; All scope when the conversation has a project). Not in read-only transcripts.
- **What is sent:** if any line begins with a "$ " prompt, only those lines with the prompt removed (output lines dropped); otherwise the whole block, trimmed. Each line break becomes Enter and a final Enter is added.
- **Timing:** typed at once if the shell has already printed on this connection; otherwise after the shell's first output plus a short delay. After a reconnect, the next command waits for the new connection's first output.
- **Appearance:** play icon and label, always visible, 44 px target; green tick for 2 s after a tap.

### 4.18 Preview panel

- **Bar:** address field (placeholder example "localhost:5173 or a full address"; URL keyboard on touch); reload; open in new tab (both inert without an address).
- **Chips:** up to 6 detected addresses, newest first; the selected one is marked.
- **Notes:** invalid input ("enter an http or https address"); loopback seen from another device (with a one-tap host substitution); insecure page inside a secure product.
- **Frame:** sandboxed (scripts, same-origin for the page's own origin, forms, pop-ups, dialogs and downloads allowed); no referrer; a spinner until loaded.
- **Empty:** "nothing to preview yet", an explanation, and an "open terminal" button.
- No back/forward and no device-size presets in the old system.

### 4.19 Slash-command menu and command dialogs

- **Opening rule:** "/" at the start of the field or after whitespace; not inside an unclosed code fence; not when the field is blank.
- **Rows:** name and description; a close button at the bottom; the list is not drawn when nothing matches.
- **Order:** built-ins, then skills (deduplicated), then custom commands; re-sorted by how often each was used in this project on this device.
- **Filtering** (case-insensitive, about 150 ms debounce): names starting with the query; if none, names containing it; if none, descriptions containing it. A query containing ":" matches by prefix only.
- **Keys:** Up/Down (wrapping, highlighted row kept in view); Enter acts on the highlighted or first row; Tab completes "name " into the field and closes; Escape closes; click selects.
- **Sending text that starts with "/":** if the first word exactly matches a listed non-skill command it runs locally (field and attachments clear; the text enters input history); anything else is sent to the agent unchanged.
- **Built-ins:**
  - *help* — a dialog listing the built-ins with a filter field, a syntax note and a tip;
  - *models* — a dialog showing the active model for the current agent, a searchable list (search shown above 6 models), selection saved for this session and as the default for new chats, with a confirmation notice or the error;
  - *cost* — token usage: total, input/output or "breakdown unavailable", context window when larger than usage, agent and model;
  - *status* — runtime banner, package, version, uptime, agent, model, runtime version, platform, memory;
  - *memory* — opens the project's agent-instruction file in the editor, or says where to create it; asks to select a project when none;
  - *config* — opens settings.
  - All dialogs close with the close buttons or Escape.
- **Custom command with a shell marker:** a confirmation warns that the command contains shell commands; cancelling adds a "cancelled" note; otherwise the processed text is sent.

### 4.20 AI build form, tile states and app home

**Form**

- "What to build": six-row field, up to 8000 characters, a counter from 7000, a hint to be specific (who uses it, which functions, where data lives).
- "Name and icon": live tile preview (placeholder name when empty; a suggested name drawn in secondary colour); name field up to 80 characters; hint "leave empty to use the AI's suggestion"; icon picker (default: slate colour, spark symbol).
- **Suggestion behaviour:** requested once the description has at least 4 characters, the name is empty and typing has paused about 700 ms; a "naming…" hint while pending; the result shows as the placeholder with an "adopt" pill; plain Enter or Tab in the empty name field adopts without submitting; an input-method confirmation Enter is ignored; new typing cancels the pending request and late answers are dropped; the same description is never asked twice; shortening below 4 characters clears the suggestion; a typed name stops suggestions; a failed request changes nothing.
- **Submit** is never disabled. Missing description → focus the field, shake the card (not under reduced motion), show a one-line hint. Missing name with no suggestion → focus the name with a hint (a different hint while a suggestion is in flight). The description is checked first. Modifier + Enter in the description submits.
- **Preparing:** fields and cancel disabled; button reads "preparing…"; failure shows the service's sentence inline and unlocks.
- **Mode notice:** sandbox (commands run sandboxed, write only this folder, reach only package registries, never push or publish); unknown (neutral text); restricted (an orange note stating the AI can only write code and documentation and commit locally — no installs, no running, no tests — in one of three variants: sandbox components missing, with a copyable install command; installed but not switched on; platform unsupported).
- The unsent draft (name, description, icon) is kept on the device until a build starts.

**Tile states**

| State | Tile |
|---|---|
| Queued | Dim icon, short circling arc, "queued" |
| Building, no checklist yet | Breathing ring, "planning" |
| Building with checklist | "developing N %"; N = (completed steps + half a step while one is in progress) ÷ total, clamped to 4–96 % |
| Finished | "done" with a ring-completion animation of about 1.7 s (0.7 s under reduced motion), then an ordinary tile |
| Failed | Red badge, "not finished" |
| Stopped by the user | "stopped" |

- An unfinished tile links to the build's live conversation. Accessible name: "name, state".
- Polling every 3 s only while a build is queued or building and the tab is visible; immediately when the tab returns; a failed poll keeps the last state.
- Toasts only for transitions seen in this visit: finished; "not finished" with the reason and a "continue" action (8 s; not for user stops).
- Edit mode: running build → "stop developing X" (with confirmation: stops at once, files kept, can be continued later); failed build → "continue developing X".

**App home tab**

- First build still running: "queued" / "AI is developing", current step or "c / t steps" or "planning steps", and a "watch development" button.
- Starting / opening states; open failed ("cannot open this app" + message + retry); start failed ("app did not start" + reason + last 12 output lines + retry + "let the AI fix it", disabled while the AI works); unfinished and nothing runnable ("not finished yet" + error + "continue").
- While the AI changes a running app: banner with the current step and progress and a "view" link; then "restarting" overlay and a reloaded frame.
- AI side panel: new conversation; recent conversations; "quick change" field (3 rows, 2000 characters, Enter sends, Shift+Enter newline; disabled with a hint while the AI is busy); a send button; while the app runs, "restart" and "open in new tab".

### 4.21 Background-task sheet and recovery card

**Button:** appears once the conversation has launched anything; badge shows the running count with the agent's activity mark, or the total once none runs.

**Sheet** (modal): header "N running · M total" or "M total, all ended"; close; list newest first — kind icon, title (command text, sub-agent description or workflow name), meta line (kind · detail · elapsed · tokens), last output line for commands, status badge (running / done / failed / stopped). Detail: for a command "$ <command>" and the last 4000 characters of output or "no output read yet"; for a sub-agent or workflow its read-only transcript. Elapsed reads "N s", "M min SS s", "H h M min" and ticks only while the sheet is open and something runs; tokens read "N" or in ten-thousands from 10,000.

- When nothing has been reported for a task: "running" while the conversation is busy; otherwise sub-agents and workflows read "stopped" and commands "done".
- Command output is what the agent itself last read, not a live tail.
- Escape steps back then closes and never triggers the "stop run" shortcut; Tab is trapped; focus returns to the button.
- The old main interface has no per-task stop control (the older interface has an immediate stop button per task) — see Q-13.

**Marks elsewhere:** conversation rows with only background work still show the running mark; project rows show marks per section 4.5.

**Recovery card:** title "task interrupted" (restart) or "task not finished" (failure); a line that some operations may already have run; view/collapse original input; continue (only for runs inside a conversation; disabled while a run or an unconfirmed send is in flight); close (marks handled; on failure "could not close, try again"); load failure with a refresh button. Refreshes on focus, visibility, reconnection and run events. Tap targets padded to 44 px.

### 4.22 Remote host section and host list

- **Project page section:** heading "start on <host label>"; host row with online/offline and a re-check button (spinner "checking"); offline alert "cannot reach <label>" with retry; one card per enabled agent and one terminal card, each captioned "runs on <label>" or "not installed"; cards disabled while offline, not installed or launching (spinner on the card); launch errors as one red line; a collapsed "details" area with connection method, target, remote directory, latency, a "session will not be kept" note when the multiplexer is missing, and the check result when offline.
- **Settings list:** one row per configured host: label, target, tools found (each ✓/✗) or the failure sentence, a badge "online N ms" / "offline", and a re-check button. States: reading; "no remote hosts yet"; read failure with retry (never shown as an empty list).

### 4.23 Tool-server screen (reach O)

- **Header:** title, one-line description, an "add" menu (add for all agents / add for this agent).
- **List:** loads user scope first, then each project's scopes in parallel, appending as they arrive; sorted by scope (user, project, private), project name, name. Row: transport icon, name, badges for transport, scope and project; lines for command, address, arguments, working directory, environment; edit and delete.
- **Masking:** environment values show the first two and last two characters around asterisks (four or fewer characters: asterisks only). Headers are not shown in the list. The edit form does not show stored secret values without an explicit reveal action (section 7).
- **Managed rows:** a lock badge and "managed by the product"; no details, no buttons.
- **Add/edit dialog:** tabs "form" / "JSON import" (add only); scope buttons (read-only when editing); project picker for non-user scopes; name; transport; for a local process: command, arguments (one per line), working directory where supported; for a network server: address, headers (KEY=value per line); environment (KEY=value per line); agent-specific extras. JSON import validates live (invalid JSON; missing type; missing command; missing address; unsupported transport). Submit is disabled until required fields are valid. Renaming on edit saves the new entry then removes the old.
- **States:** loading; "no tool servers configured"; error box; "saved" for 2 s; partial failure of "add for all" names each agent's error.

### 4.24 Skills screen (reach O)

- Search with clear; "add skill"; refresh. Groups in order: user, plugin, repository, project, administrator, system — each with a count. Card: how to invoke it, name, description (or a "no description" note), plugin/project badges, source path.
- Add dialog: drop zone; choose files / choose folder; queue rows (name, "N files" or "definition file", size, remove); a disclosure showing where it will be installed; install button with count. Client limits: 500 files per folder, 30 MB total, 20 queued items; a folder must contain a definition file.
- States: loading; "no skills discovered yet"; "no matching skills"; "saved" pill for 6 s.
- No view, edit, delete or enable/disable in the old screen.

### 4.25 Plugins screen and plugin tab (reach O)

- **Top:** address field; install button; error text; a warning to install only reviewed or trusted plugins; a note that a plugin folder can also be dropped into the plugins location by hand.
- **Sections:** official and other; each lists installed cards, then dashed "recommended" cards not yet installed (hidden once a plugin with the same name or repository address is installed).
- **Installed card:** icon, display name, version chip, "tab" chip, a pulsing "running" marker while its process runs, description, author, repository link; update (disabled with an explanation when the plugin has no remote); two-step uninstall; enable switch. Disabled plugins are dimmed.
- **Plugin tab:** icon and display name after the built-in tabs behind a divider; small screens show icons only for inactive tabs; load failure shows "plugin failed to load" with the reason.

### 4.26 Older interface: project sidebar, create-project dialog, folder browser, command palette (reach O)

- **Project sidebar:** modes projects / conversations / running (count badge) / archive; search per mode; refresh; "+"; collapse to a narrow rail; width draggable 220–640 px (default 288). Order: starred first, then by name or by recent activity (a per-user preference). Row: star toggle, name, session count and shortened path, rename (inline), remove. Remove dialog offers archive, permanent delete, cancel. Expanded project: new session, select (bulk), first 20 sessions, "load more". Loading shows a progress bar "current/total".
- **Archive view:** one card per archived project (name, count, path, restore, its sessions) and individually archived sessions with restore and permanent delete.
- **Phone:** the sidebar is a drawer over a dimmed backdrop; rows are cards with always-visible rename and delete.
- **Create-project dialog:** two steps (configure → confirm) as in UF-09; full screen on phones.
- **Folder browser:** opens at the workspace root; toolbar: show/hide hidden folders (hidden by default), new folder, close; rows: ".." then folders alphabetically, each with a select button; footer with the current path, cancel and "use this folder". Going above the root shows the service's refusal.
- **Command palette:** opens with the palette shortcut; groups: actions (new chat, settings, theme), navigation (the workspace tabs), Git (fetch at once; pull and push after a confirmation), settings pages, sessions (with message-text matches from 2 characters), files (first 500), commits (50), branches (selecting one switches immediately). Each data group shows 5 rows plus "browse all (n)".

### 4.27 Task board and requirements-document editor (reach O)

- **Settings:** when the planning tool is missing, a card with the install command and next steps; when present, an enable switch.
- **Board:** search; view switch board / list / grid; filter panel (status, priority, sort; "showing X of Y"; clear); quick-sort buttons; help; documents menu; "add task" (opens an explanation to ask the agent — no form). Columns: to-do, in progress, done always; blocked, deferred, cancelled when populated. Card: identifier, title, parent, priority, dependencies, status, sub-task progress.
- **Task dialog** (full screen on phones): copy identifier; edit title and description; status select applied immediately; read-only priority; dependency chips; collapsible implementation details and test strategy.
- **Next-task banner** in an empty chat: not configured → initialise; next task → title, priority, "start task" (prefills the composer); none pending → totals and "review".
- **Document editor:** name field (100 characters, illegal characters stripped, fixed text-file suffix); preview, wrap, theme, download, "generate tasks" (instruction dialog only), save, full screen, close; Markdown editing with line numbers; footer counts; a new document starts from a ten-section outline; overwrite confirmation when the name exists; empty content or name is refused.

### 4.28 Agent browser panel (reach O)

- Title; runtime badge (disabled / ready / installing / setup required); settings and refresh; "N active / N total"; "updated <relative time>".
- Session list: title or site, status (ready / stopped / unavailable), last action. Main area: latest screenshot with a marker where the agent last acted; full-screen view; stop; delete.
- Empty states: "no browser sessions yet" or "browser is disabled", with example prompts. Setup card with an "install runtime" button.
- The user watches only (screenshots); there is no way to click or type into the agent's browser. No automatic refresh.

---

## 5. Externally observable behaviour of the service

Capabilities are described by what a client supplies, what it receives, limits and failure cases. Addresses, message names and field names are deliberately not given; the rebuild defines its own.

### 5.0 Conventions

- **Authentication.** Every capability in this document requires a signed-in session unless stated otherwise. A request without valid credentials is answered **401** before any request body is read, and the client signs the user out. Exceptions, each with its own credential: the built-app gateway (a secret in the address, 5.10), the agent-browser tool endpoint (a service-generated bearer token, 5.11), and the programmatic agent run (an API key in a header, 5.16).
- **Credentials in addresses.** Session credentials are never accepted in an address — not for progress streams or real-time channels (terminal, plugin relay) either (domain 3, W-03).
- **Status categories.** 400 malformed or invalid input; 401 not signed in; 403 refused by a location or confinement rule; 404 unknown item — also used for another user's item, so existence is not revealed; 409 conflicts with current state; 413 too large; 429 too many requests (with a retry-after hint); 502/503/504 an external tool or site failed, is unavailable, or timed out. The categories are used uniformly: a failed read is never a success answer carrying an error note, and invalid input is never a server error.
- **Error shape.** A failure carries a stable machine-readable reason, a human sentence and optional details. Raw output of external tools is never returned unfiltered: control characters and anything that looks like a token are removed and the text is length-capped.
- **Global request limits (recommended defaults; domain 3 section 5.1).**
  - Body of an authenticated request: up to 50 MB (larger → 413). Unauthenticated bodies: small (tens of kilobytes).
  - A whole request must arrive within a deadline sized for the largest upload; headers within a short deadline.
  - Per client: a request burst with a steady refill, and a cap on requests in progress; over the limit → 429.
  - Real-time channels: messages up to 16 MiB (larger closes the channel); a per-client cap on open channels; opening is rate-limited.
- **Caching.** Answers that reflect live state (projects, GitHub, builds, apps, remote hosts) are marked not-cacheable.
- **No cross-origin reads; the product refuses to be framed by other origins.**

### 5.1 Workspace projects

**What is remembered per project:** identifier, working-directory path, optional custom display name, starred flag, archived flag. Nothing else; "last activity" is always derived from its conversations. Whether the registry is host-wide or per user is decided by 7.1 (see Q-02).

**Display name:** the custom name if set; otherwise the name declared in the folder's package manifest if one is readable; otherwise the folder's last path segment.

**Path normalisation before storing or comparing:** trim; collapse dot segments and duplicate separators; drop trailing separators (except on a root); platform-appropriate separator rules. Letter case is preserved and compared exactly. Explicit registration stores the real path (symlinks resolved), so a symlinked spelling and its target are one project.

**Discovery**

- Source: the saved conversation histories of each offered agent under the Service user's home. For each conversation the recorded working directory decides its project. Sub-agent transcripts and side files are not conversations.
- When: once at start; on every project-list read (concurrent readers share one scan; scans after the first are incremental); and continuously by watching the history folders (about every 6 s).
- Effects: an unknown directory becomes a project; a conversation whose history file is gone is dropped; projects are never removed automatically (a project with zero conversations stays); activity in an archived project's folder un-archives it.
- A missing or moved working folder is not detected; the project stays listed and each tool reports its own "not found".
- Live updates: each indexed change is pushed to connected clients as a conversation update carrying its project (batched: about 0.5 s quiet period, at most 2 s). While a list is being built, clients receive progress (current, total) and a completion signal. Rename, star, archive, restore, delete and create are pushed as well.

**List active projects**

- Input: optional conversations-per-project page size (default 20, clamped 1–200) and offset.
- Output per project: identifier, path, display name, starred flag, first page of conversations (identifier, agent, title, last activity time, last user-message time), total and has-more.
- Conversation order: by last user instruction (falling back to creation), newest first. Archived conversations are excluded.
- Project order is unspecified; clients sort.

**List archived projects** — each with all of its conversations.

**Page a project's conversations** — inputs: project, page size (default 20, max 200), offset. Errors: negative or non-numeric values → 400; unknown project → 404. Works for archived projects.

**Register (add or create)**

- Input: path (required), optional custom name.
- Behaviour: missing folders are created, including parents. The stored name is the supplied name or the folder's last segment.
- Output: the project, and whether it was newly created or an archived project at that path was reactivated (same identifier, name and star).
- Errors: blank path → 400; location rule violated → 400 with the specific reason (system directory; outside the allowed root; symlink target outside the root); an active project already exists at that path → 409.

**Location rules** (apply to register, clone, folder creation, folder browsing and opening a project card)

- Allowed: the workspace root (default: the Service user's home) and anything inside it.
- Forbidden, exactly or anywhere beneath: the filesystem root; the operating system's configuration, binary, device, process, library, boot, run-state, optional-software, administrator-home and temporary directories (temporary areas intended for users under the variable-data directory are excepted); on Windows-style drives the system, program and recycle folders.
- A path that is itself a symlink must resolve inside the root.

**Clone into a new project** (two steps)

1. Submit: parent folder, repository address, optional saved-token reference, optional one-off token. Returns an opaque single-use handle; nothing has started.
2. Open a progress stream with the handle. The handle works once, only for the submitting user, for 60 seconds; otherwise 404.

- The stream delivers progress text as the transfer tool emits it, then either "complete" (with the registered project) or "error" (a sentence). Validation failures also arrive as an error on the stream.
- Checks, in order: path and address present; the address is not option-like and parses; transport is http, https or ssh (including the "user@host:path" form) — every other transport is refused; no credentials embedded in the address ("put the token in the token field"); location rules; the saved token exists and belongs to the caller; the target folder "<parent>/<repository name>" does not exist.
- The token never appears in the handle, the address, the process arguments, progress text, or the cloned repository's configuration. It is offered only to the public GitHub host over https, and the host's stored credentials are not used for that clone.
- Closing the stream cancels the clone. A failed or cancelled clone removes the partial folder. The clone has an overall time limit.
- Failure sentences: authentication failed; repository not found or no access; directory already exists; the tool's last output; transfer tool not installed.

**Rename** — input: project, new display name. Blank clears the custom name. Unknown project → 404.

**Star toggle** — returns the new state. Unknown project → 404.

**Archive** — sets the archived flag; conversations, histories and folder untouched. **Restore** — clears it. Unknown project → 404.

**Delete permanently** — in order: delete every saved history file of every conversation of that folder (archived ones included); remove the conversation records; remove the project record. The working folder and its files are never touched. If a history file survives, discovery will re-create the project with a new identifier.

**Per-user project preferences** (stored for the user, synced to all devices, mirrored locally for first paint, refreshed live when another device changes them): ordered list of pinned projects (client cap 50); project sort order for the older list; conversation pins and groups per project.

**Folder browsing**

- Input: optional path; a home shorthand means the workspace root.
- Output: the resolved path and the directories directly inside it. Conventional dependency, build and cache folder names are left out; dot-folders are returned but sorted last; at the root a few conventional names (desktop, documents, projects, code…) come first.
- Errors: outside the rules → 403; not a directory → 400; not accessible → 404; more than 10,000 entries → refused as too large.

**Create folder** — one level only. Errors: missing path → 400; outside the rules → 403; parent missing → 404; already exists → 409.

### 5.2 Project cards, launching, links and activity

All reads and writes are scoped to the signed-in user: another user's card answers 404.

**List / read / create / update / delete a card**

- Create answers "created" with the card (server-assigned identifier and updated time). Update keeps the card's position in the list.
- Validation (400 with a sentence): name 1–80 after trimming; description ≤ 1000; directory ≤ 1000 and absolute if not empty; features and agents from the offered sets with no duplicates; assistant on requires at least one agent; colour and symbol from the fixed sets; links ≤ 8, each label 1–40, address ≤ 500 and http/https; remote host must be one the administrator configured; remote directory per the rule in 4.2; a remote directory without a host is refused; notify must be a boolean; morning time HH:MM.
- Omitted optional fields take defaults; omitted automation defaults and the open-in-workbench flag keep their stored values.
- No limit on the number of cards and no uniqueness rule on name or directory.
- **Execution lock (409):** while scheduled messages are pending for the card's directory, changing the directory, removing an agent, switching off the assistant or automation, and deleting are refused. Renaming is allowed.
- **Delete** removes the card and its task drafts and tells other parts of the product to forget its API-chat conversations and automations. Files and agent conversations are untouched. The workspace project for the folder is **not** deleted.

**Launch (open in the workbench)**

- Input: card, optional agent.
- Output: the workbench address for that folder — a plain project address, or with an agent a new chat preselecting it. As a side effect the folder is registered as a workspace project if it was not yet.
- Refusals: remote card (400); agent not offered or not enabled for the card (400); no assistant and no API chat (400); no directory (400); directory does not exist (400); folder outside the allowed root or in a system directory (400); the folder's workspace project is archived (409, "restore it first").

**Scratch launch** — input: an agent. Opens a new chat in the scratch workspace folder, created on first use. Unavailable → 503.

**Card ↔ workspace-project pairing** — for each local card with a directory, the identifier of the workspace project at that folder, or none. A vanished folder never fails the list.

**Card for a folder** — input: a workspace project. Returns the user's card for that folder, creating one if none exists (named after the folder, assistant on, all agents, default icon). Idempotent per user. Used when the API chat model is first used in a folder project. Unknown or archived project → 404.

**Link status**

- Input: card. Output per link: answered-successfully flag; HTTP status or none; latency; frameable flag; for a health link a reading of status, database state and version.
- A link is a health link when its path ends with a conventional health-check segment. It is read with a normal read request, accepted only if the answer is JSON of at most 4096 characters, keeping only short plain words (≤ 32 characters each).
- Other links are probed with a header-only request, falling back to a normal read when the site rejects that method; bodies are never read.
- Frameable means the site sends no frame-blocking header and no restrictive frame-ancestors policy.
- Limits: 6 s per request; at most 4 redirects; results cached 60 s per address.
- Link-local and cloud-metadata addresses are never contacted — also not through a redirect — and are reported as unreachable. Loopback, private-network and overlay-network addresses are deliberately allowed (the owner's own services live there).

**Project activity snapshot**

- Output per workspace project that has anything to report: running count; running agents; "needs the user" count with conversation identifiers; "finished, unseen" count with conversation identifiers.
- "Needs the user": a pending approval or question, or an unresolved failed or interrupted run. "Unseen": a run ended while no visible page showed that conversation; cleared by viewing it, by a new run, or by acknowledging it in the task inbox. A conversation with both counts only as "needs the user".
- Unseen marks survive a restart (cap 500). Changes are announced to clients as one debounced "read again" signal (about 250 ms). While the real-time channel is down clients poll every 10 s; otherwise every 30 s.

### 5.3 Files

All paths are addressed relative to a workspace project (absolute paths inside it are also accepted).

**List the tree**

- Input: project; a flag to apply the project's ignore file.
- Output: nested entries with name, absolute path, kind (file or directory), size, modified time, permissions (numeric and symbolic), a symlink marker, children.
- Limits: 10 levels; more than 10,000 entries → 413 with advice to choose a narrower folder or add ignore rules (the walk stops as soon as the limit is passed; the limit is shared across the whole tree).
- Errors: unknown project → 404; project folder missing → 404 naming the path.

**Read a text file** — output: content as UTF-8 text and the resolved path. A maximum readable size applies (Q-09). Errors: invalid path → 400; outside the project → 403; missing → 404; no permission → 403; a directory → 400.

**Read raw bytes** — a byte stream with a content type guessed from the extension. Errors as above.

**Save a text file** — inputs: path, content (a string; empty allowed). Creates the file if its parent exists. Errors: missing or non-string content → 400; outside the project or through an escaping symlink → 403; parent missing → 404; body above the request limit → 413.

**Create** — inputs: parent path (optional), kind, name. Errors: missing name or kind → 400; invalid kind → 400; name rule violated → 400 with the specific reason; already exists → 409; parent not found → 404 (for a new file, missing parents are created; for a new folder the parent must exist); confinement → 403.

**Rename** — inputs: existing path, new name (same folder). Errors: missing inputs → 400; name rules → 400; not found → 404; name taken → 409; confinement → 403.

**Delete** — input: path. Folders are removed recursively. Errors: missing path → 400; not found → 404; confinement → 403; the project root itself → 403.

**Upload** — multipart: files, target folder (blank means the root), an aligned list of relative paths for folder uploads.

- Limits: at most 20 files per request; at most 200 MB per file. Violations → 400 naming the limit.
- Missing target folders are created. Existing files are overwritten.
- A file whose destination would leave the project is skipped; the answer reports how many of the requested files were stored.
- Output: stored files (name, path, size, type), counts, target.

**Chat attachment store** (domain 1; listed for completeness): one host-wide folder; up to 10 files of 10 MB per request; stored under a sanitised unique name; served back only by exact name, with script-capable types forced to download.

**Extra read-only roots (optional, Q-12).** If files that an agent mentions outside the project must open, text and raw reads may also accept absolute paths under explicitly listed read-only roots (for example the agent's own history folder). Nothing can ever be written, created, renamed, uploaded or deleted there, and paths are confined after symlink resolution.

### 5.4 Git

All capabilities take a workspace project; the working directory comes from the stored project, never from the client.

**Status** — output: current branch; whether the repository has commits; lists of modified, added, deleted, untracked and staged paths (relative to the repository root). A folder that is not a repository is reported as such (not as an error).

**Initialise** — creates a repository; "already initialised" is reported without change.

**Initial commit** — stages everything in the project folder and commits with a standard first-commit message. Refused (400) when the repository already has commits.

**File diff** — unified text for one path (unstaged changes if any, else staged). **File with baseline** — current content, last-committed content, deleted and untracked flags; a directory → 400.

**Commit diff** — the commit's full textual diff, cut at 500,000 characters with a marker and a truncated flag.

**Stage / unstage** — a non-empty list of paths.

**Discard** — one path: an untracked file or directory is deleted; a modified or deleted file is restored; a newly added file is unstaged. Nothing to discard → 400.

**Delete untracked** — one path; refused (400) if the path is not untracked or does not exist.

**Commit** — message and a non-empty list of paths; the listed paths are staged and committed. No amend, sign-off or identity override. A hook or identity failure returns the tool's message.

**Undo latest local commit** — removes the last commit keeping its changes staged (also works for the very first commit). No commit → 400. If the commit was already pushed, the user is warned first.

**Branches** — output: local branches; remote branches (short names not shadowed locally, and full names).

**Switch** — one branch name; the version-control tool itself decides whether a dirty tree allows it.

**Create branch** — from the current commit, then switch.

**Delete branch** — name and a strict boolean "force" (a non-boolean → 400). The current branch → 400 even when forced. An unmerged branch without force is refused with the tool's reason.

**History** — input: limit (default 10, max 100; the interface asks for 50). Output per commit: identifier, parents, refs, author, e-mail, date, subject, a change-count summary. Stash entries are excluded.

**Remote status** — output: has remote; has upstream; branch; remote branch; remote name; ahead; behind; up to date. Counts are against the last fetched state.

**Fetch / pull / push / publish**

- Remote choice: the upstream's remote, else the conventional default remote; publish uses the default remote if present, else the first remote, and sets the upstream.
- Pull follows the host's own merge-or-rebase configuration. Push is never forced.
- Credentials are never handled by the product; the host's helpers or keys are used, and the tool must never prompt.
- **Required failure classes** (Q-11): merge conflicts; uncommitted changes in the way; network error; no remote configured; branches diverged; push rejected (non-fast-forward); authentication failed; no upstream.
- These operations have a time limit (recommended: 60 s for network operations), with a clear timeout message.

**Branch comparison**

- List: input a base ref; output the base, the merge-base commit, and files (path, previous path for renames, status M/A/D/R/U) sorted by path — covering committed, staged, unstaged and untracked differences from the merge base.
- File: input base, path and optional previous path; output the diff (an untracked file as all additions).
- Errors (400, each distinguishable): invalid base; unknown base; no common history.

**Generate a commit message**

- Inputs: paths; which agent to use.
- Uses the diff of those paths (for new files a short excerpt), truncated to a few thousand characters, to ask for a conventional commit message (short subject, wrapped body).
- The agent run has **no tools at all** and its reply is used as text only, so instructions hidden in a diff cannot cause actions.
- Output: the message, cleaned of code fences and headings; a generic fallback message on empty output or error.

**Commit identity** — read: the user's stored author name and e-mail (pre-filled from the host's own configuration on first read). Write: both required; the e-mail must look like one (else 400); stored for the user and applied to the host's configuration (a failure to apply does not fail the save).

### 5.5 Worktrees

**List** — output: repository root; base branch (the branch of the main checkout); per worktree: path, branch, head commit, main flag, current flag, locked flag, detached flag, changed-file count, ahead/behind versus the base branch, last commit subject and date, linked project and whether that project is archived. The main checkout is first. Not a repository → 400; unknown project → 404.

**Create (and register as a project)**

- Inputs: branch (required); optional base branch.
- Location: a sibling folder of the repository named "<repository>-worktrees", then a folder derived from the branch name (path separators, whitespace and reserved punctuation become dashes).
- An existing local branch is checked out as-is; otherwise a new branch is created from the base (default: the main checkout's branch).
- The worktree is registered as a project named "<repository folder> · <branch>". If registration fails the worktree is removed again, and the branch is deleted only if this call created it.
- Errors: invalid branch name → 400 (before anything runs); branch already checked out in another worktree → 409; destination folder exists → 409; unknown base → 400.

**Open as a project** — input: worktree path. Returns the linked project (restoring an archived one, or registering a new one). A path that is not a worktree of this repository → 404.

**Merge back**

- Inputs: worktree path; squash (boolean); message; remove-after-merge (boolean). Strings are never coerced to booleans.
- Runs in the main checkout, onto the branch checked out there. Squash produces one commit with the message; otherwise a merge commit is always created.
- Preconditions: both working trees clean (else 409, saying which is dirty); neither side detached (400); the main checkout cannot be merged into itself (400).
- On conflict the merge is rolled back and the answer is 409 with the list of conflicted paths. If the rollback itself fails, that is reported distinctly.
- Optional clean-up removes the worktree and deletes its branch; a clean-up failure is returned alongside a successful merge and must be shown to the user.

**Remove**

- Inputs: worktree path; force; delete-branch.
- Refused for the main checkout (400); refused when dirty unless forced (409); nothing is removed if the dirty check itself cannot be performed.
- Output: removed path; branch; whether the branch was deleted; the archived project (the linked project is archived, never deleted); any archival error.

No automatic pruning.

### 5.6 GitHub

The Service reaches GitHub only through the GitHub command-line tool installed and signed in on the host, fixed to the public GitHub service. There is no OAuth flow and no token entry for these capabilities.

**Shared limits:** at most 3 concurrent calls to the tool and 24 waiting (beyond → "busy", 503); read timeout 20 s; merge timeout 60 s; fix timeout 30 s; identical concurrent reads share one call; a forced refresh within 5 s of the previous fetch reuses it.

**Account status** — output: tool installed; signed in; account name; whether the login can merge; a sentence; checked-at. Cached 60 s. Never returns a token or a credential location.

**Inbox** — three searches of open PRs in non-archived repositories (authored by the account; review requested from it; in repositories under its own name), 50 each, newest update first, merged into one list (max 150) with de-duplication and reasons, plus a truncated flag. Per PR: owner, repository, number, title (≤ 300), author, address, draft flag, head and base branch names, head commit, additions, deletions, changed files, mergeable (yes / conflicting / unknown), merge state, review decision, check counts and overall state, updated time. Cached 45 s.

**Repository list** — repositories the account owns (private, forks and archived included; not organisation-owned, not collaborator-only), most recently pushed first, first 100, plus the total. Cached 45 s; dropped by any merge or fix.

**Repository page** — description (≤ 300); private/fork/archived; default branch; last push; write permission; newest default-branch commit (identifier, title ≤ 200, author, time, checks); up to 30 open PRs plus the total; up to 6 recent merges. Cached 45 s per repository. The per-project variant answers "nothing" when no link is a repository and 404 for another user's card.

**PR detail** — adds: state (open / closed / merged); plain-text description (≤ 1600 characters, cut at a sentence or line boundary); created time; up to 100 checks (name, workflow, state, required, https-only log address); up to 100 files with totals; allowed merge methods; auto-delete flag; fork flag; write permission; merge-queue flag; blockers; merge commit; workflow runs waiting for approval. Cached 45 s.

**Blockers** (each with its own sentence): PR not open; draft; no permission; merge conflict; required checks failed; required checks pending; head behind the base; blocked by branch rules; no allowed merge method. With a merge queue, "behind" and "blocked" do not block.

**Merge**

- Inputs: method (merge / squash / rebase); the full head-commit identifier the user saw; optional delete-branch; optional acknowledge-failing-checks.
- Always decided on a fresh, complete read (partial data → refusal).
- Refusal order: not open; head moved (the sentence names the new short identifier); first blocker; method not enabled (400); failing or unstable optional checks without acknowledgement.
- Never bypasses branch protection, never uses administrator override, never enables auto-merge. GitHub is told to refuse if the head moves during the call.
- Output: merged or queued; merge commit; a sentence.
- One merge or fix per PR at a time (a second → 409).
- Timeout → 504 "outcome unknown"; settled later when a read finds the PR merged at the same head.
- A merged PR is hidden from inbox and repository answers for 5 minutes (GitHub's search lags).

**Fixes** — update branch (needs the seen head; only while behind); mark ready (only drafts); approve runs (1–20 distinct run identifiers, each of which a fresh read must list as approvable by this account; approved one by one; a partial failure names what went through). Each returns a sentence and the fresh PR. Timeout → 504 "outcome unknown".

**Audit** — every merge and fix attempt, including refused and malformed ones, is recorded for the user **before** it runs; if the record cannot be written nothing runs. **Merge log** — the user's last 20 attempts.

**Branch PR lookup** — input: a workspace project. Reads the folder's current branch and default remote; accepts only remotes on the public GitHub host; finds an open PR from that branch of the same repository (branches of forks ignored). Answers "nothing" for: no PR; detached head; other host; unusable branch name; tool missing or signed out; PR closed. Unknown or archived project → 404. Cached 30 s per project. The local repository read has a 5 s limit and never prompts.

**CI reading** — watches the account's own non-archived repositories pushed within 3 days, at most 6 (list cached 10 minutes); 15 latest runs each; running first, then queued, then the 6 newest finished. Output: counts; runs (title, workflow, repository, state, timing); watched repositories; per-repository problems. Cached 30 s. One unreadable repository is listed under problems; a signed-out account fails the whole reading.

**Failure classes** (each a distinct reason and sentence): tool not installed (503); not signed in or login expired (409); timeout (504); busy (503); API rate limit reached (429); organisation single-sign-on required (403); repository or PR not found or not accessible (404); host cannot reach GitHub (502); other tool failure (502, with a redacted one-line detail of at most 160 characters); malformed input (400).

**Input rules:** owner — letters, digits, hyphen, 1–39 characters, not starting with a hyphen; repository — letters, digits, dot, underscore, hyphen, 1–100, not "." or ".."; PR number — positive integer without leading zeros; commit identifier — exactly 40 lower-case hexadecimal characters; refresh flag — strictly boolean-like.

### 5.7 Terminal channel

A real-time, bidirectional channel. The client sends an opening message, then input and resize messages; the service sends output, error notices and "address detected" notices.

**Opening message** — the project (the Service derives the working directory from the project record; the client never supplies a directory); optional conversation; which program (plain shell, a named agent's CLI, or a one-off action chosen from a server-side list, such as an agent's sign-in or a remote launch — never free text from the browser); terminal size (default 80×24 when absent); optional "restart" flag.

- Plain shell → an interactive login shell in the project's directory.
- One-off action → run once; the process ends when the action ends.
- Agent program → that agent's CLI, resuming the conversation's native session when one is known, otherwise a new one.
- First output is a one-line notice naming what was started and where.
- The project's directory must exist and be a directory (else an error notice, no process). The conversation identifier must be made of safe characters (else an error notice).

**Identity and lifetime**

- A terminal process is identified by: user + project directory + conversation (or none) + what runs (login shell, agent CLI or the one-off action). Opening with an identity that is already running **attaches** to it: a "reconnected" notice, then the replay buffer.
- Replay buffer: the last 5,000 output chunks; it keeps filling while no client is attached.
- When the last client leaves, the process keeps running for exactly 30 minutes and is then ended. Re-attaching cancels the countdown. A late close from a superseded connection does not detach the newer one.
- The restart flag ends the existing process first and starts fresh.
- When the process exits, an exit notice (code, signal) is sent.
- One plain shell per directory; distinct commands and distinct agent conversations each get their own process (Q-14).

**Limits** — at most 32 live terminal processes host-wide; at the cap the oldest one without a client is ended to make room; if all have clients the open is refused with "too many active terminals". Heartbeat every 30 s; a client that does not answer by the next beat is dropped; a client with more than 8 MiB of unsent output on two consecutive beats is dropped.

**Address detection** — output is scanned (formatting codes removed, addresses wrapped across lines rejoined, trailing punctuation removed) for http(s) addresses; each new one is announced once per connection. Replayed output is not re-announced (hence the client-side memory in 4.18).

**Environment of the process** — the host account's normal environment with the Service's own settings and secrets removed, plus terminal type and colour settings. It runs as the same operating-system account as the Service; a terminal is deliberately not a sandbox (7.3).

**Authentication** — a valid session is required to open the channel (else 401); opening is rate-limited (429 with retry-after); "sign out everywhere" closes the user's open channels at once.

### 5.8 Remote hosts

- **Configuration** is done by the administrator outside the browser: up to 16 hosts, each with a short lower-case identifier (letters, digits, hyphen; ≤ 32), a label (≤ 40 characters), an SSH target (an alias or user@host), and optionally a default directory. Malformed entries are skipped (and logged without echoing them); they never stop the Service. A host with a default directory may seed a project card for new users.
- **List hosts** — identifier, label, target (no directories).
- **Host status** — output: online; latency; checked-at; which tools were found (each agent CLI, the terminal multiplexer); an optional note. Unknown host → 404 without any connection attempt. Cached 60 s; concurrent checks share one probe. The probe is non-interactive (never prompts), 6 s to connect, 12 s overall. Failures map to short sentences (≤ 120 characters): authentication failed; host key check failed; cannot resolve host; connection refused; timed out; network unreachable; no SSH client on this computer; or "SSH failed: <last line>".
- **Remote launch** — input: card; what to run (one of the agents, or a shell). Output: a title and a reference to the server-side launch that the terminal channel then starts; the command itself never travels through the browser. Behaviour on the host: change to the project's remote directory; verify the program exists (else a clear message and a non-zero exit); create or re-attach a persistent multiplexer session named from the agent and the directory, so reopening returns to the same session; without a multiplexer, run directly (session not kept). Agents on the remote host use configuration folders separate from the host owner's own, so the user's sign-in there does not touch the host owner's.
- **Refusals:** card has no remote host (400); host no longer configured (409); unknown program (400); agent not enabled for the card (400); another user's card (404).
- The browser can never choose the host, the directory outside the validated form, or the command (see section 7).

### 5.9 AI builds

Each user sees only their own builds.

**Environment** — output: current mode (restricted or sandbox); which sandbox components are missing; whether a sandbox is possible on this platform.

**Suggest a name** — input: description (≤ 8000; over → 400). Always answers with a name and where it came from (a short model call when the user has an API key for the low-cost model — 4 s limit, only the first 2000 characters sent, at most 20 per user per minute, reply cleaned to ≤ 12 characters; otherwise, or on any failure, a local rule producing ≤ 8 characters with a generic fallback).

**Create**

- Inputs: name (1–80), icon colour and symbol (from the fixed sets), description (1–8000).
- Effects: a folder under the builds root (default: a "projects" folder in the Service user's home) named by a slug of the name (ASCII words, lower-case, hyphenated, ≤ 40 characters; a generic slug when the name has no ASCII words; "-2", "-3"… on collision); a local repository; a guide file the AI must follow; a project card (tile); a workspace project; a conversation titled with the name and an "AI build" marker; the build is queued or started.
- Output: "created" with the build and its card.
- Errors: wrong types → 400; name, description or icon invalid → 400 with a sentence; builds root not inside the user's home → 500 configuration error and nothing created; any failure after the folder exists → everything created so far is rolled back.

**Build record** — identifiers of build, card, workspace project and conversation; folder; state (queued, building, done, failed); total steps, completed steps, current step; created, started, finished times; error sentence.

**Queue** — 2 builds run at once by default (configurable, minimum 1); the rest wait first-in-first-out.

**Progress** — follows the agent's own checklist (at most 60 items of 200 characters).

**Continue** — optional message (≤ 8000). Refused (409) while building, or while the conversation is running elsewhere. Progress resets and the build re-queues in the same conversation.

**Cancel** — queued or building → failed with a "cancelled" reason; already done or ended → 409. A late failure from the stopped run never overwrites "cancelled".

**Restart of the Service** — builds that were running become failed with a "restart interrupted it; continue in the conversation" sentence, with step counts re-read from the conversation; queued builds start a few seconds after boot in creation order.

**Adoption** — a failed build whose conversation is run again from the workbench shows as building again with live steps, then done or failed. Finished builds are never re-adopted.

**Failure reporting** — a failure that is not a user stop is reported once to the project's automations (domain 4).

**No delete capability**; deleting the card hides the build and leaves the folder and conversation on disk.

**Tool policy for the unattended run** — see section 7.4.

### 5.10 Built apps and the app gateway

**Open** — input: card; optional restart flag. Output: status and, when running, the address. A card that is not an AI build → 404.

**Status / stop** — separate capabilities. Stop asks the whole process group to end and forces it after 3 s.

**How an app is started** (first match): a package manifest with a start script → run it; a declared main file inside the folder → run it; an index page in the root or a conventional output folder → serve static files; none → failed with a sentence listing the three options.

- A process app receives a free loopback port through its environment and must listen on it. Ready = any HTTP answer (polled every 250 ms). Not ready after 30 s → failed with a sentence explaining the port requirement. Other failures: "exited with code N"; "could not start".
- Idle stop after 30 minutes without use (checked each minute); the next open or gateway request starts it again. Opening restarts it when the repository has a newer commit than the one running.
- The last 40 output lines are kept and returned only in the failed state.
- The number of running apps is capped.

**Gateway**

- Address: the product's own origin, a fixed prefix, a long random secret, a trailing slash. The secret is the only credential; no cookie or session is involved.
- A grant is bound to one user and one card; expires after an idle period and an absolute maximum age (see 7.5 for links opened in a new tab); the number of live grants is capped (then 429); all dropped by "sign out everywhere"; all lost on a Service restart (old addresses then answer 401 and reopening from the product issues a new one).
- Answers: unknown app 404; expired or unknown grant 401 ("open it again from the product"); card deleted 404; missing trailing slash → permanent redirect; app not running → 502 with the start error.
- Static apps: read-only (other methods 405); invalid address 400; missing file 404 — including dot-files, links leaving the folder and encoded parent steps.
- Process apps: upstream time limit 120 s; request bodies up to 50 MB (413 beyond); rewritten documents up to 10 MB; "no response" / "response interrupted" → 502.
- Isolation: every response carries a sandbox policy without same-origin, so the app runs in an opaque origin and cannot read the product's storage or call its API as the user; it may be embedded only by the product's own pages; cookies, credentials and proxy headers are removed from forwarded requests; only a short allow-list of response headers is returned, so an app cannot set cookies; root-relative addresses in documents, styles, scripts and redirects are rewritten under the prefix; browser storage is replaced by in-memory stand-ins; service workers are refused. Real-time sockets to apps are not supported.

**Guide for generated apps** (user-visible traits the AI is told to deliver): interface in the product's language and quiet visual style with light and dark palettes; readable body size, rounded cards, 44 px touch targets; phone, tablet and desktop layouts; reduced-motion support; data kept in the project on the host; no login of its own; relative addresses only; no service worker or real-time socket.

### 5.11 Agent-driven browser

- **User capabilities:** status; read and write settings (feature off by default); install the browser runtime (package, browser and — on Linux — system dependencies; each step limited to 10 minutes; a message when administrator rights are needed); list sessions; stop a session; delete a session.
- **Enabling** registers a tool server with every supported agent at user level; **disabling** unregisters it and stops all sessions.
- **Tools offered to agents:** create a session (optionally with a named persistent profile, name ≤ 80 characters); list sessions; close a session; snapshot (screenshot plus up to 30,000 characters of page text); screenshot; navigate (http/https only; a bare host gets https; 30 s); click (by selector, visible text or coordinates; 10 s); type or fill (optionally pressing Enter); fill a form; press a key; select an option; wait for text, address or time (default 5 s, 250 ms–30 s); tabs (list, new, select, close).
- **Limits:** 1440×900 viewport; headless; at most 3 active sessions (configurable); a session stops after 30 minutes of inactivity; each tool call limited to 60 s; sessions live in memory and end at shutdown. With the runtime missing, a created session is "unavailable" and carries the setup message.
- **Tool endpoint** requires a Service-generated secret (else 401); unknown tool 404; failures 400 with the reason.

### 5.12 Background work and recovery

- **Stop a background task** — a message on the chat channel naming the conversation and the task. Success is silent (the stream then reports the task stopped). Failures: missing conversation or task identifier; unknown conversation; task not tracked. Which agent it belongs to is taken from the conversation, never from the request.
- **Lifetimes:** an agent process holding background work is released after 30 minutes of silence (restarting on every message); a finished run stays attachable for 5 minutes, extended in 5-minute steps while work is outstanding.
- **Recovery list** — inputs: optional project path, conversation, limit 1–100. Output: the user's runs that ended interrupted or failed and are not yet handled, each flagged when the interruption was a Service restart. **Look up by request identifier** — another user's → nothing. **Resolve** — marks handled without running anything; idempotent; unknown or another user's → 404.
- **Continuation** — a recovery record can be claimed by exactly one new run; a second attempt is refused.
- **On restart** unfinished work is marked interrupted and never replayed automatically; one notification per affected conversation.

### 5.13 Tool servers, skills and commands

**Tool servers (MCP)**

- **List** — inputs: agent; optional scope; optional project path. Output: servers per scope. An unsupported scope yields an empty list.
- **Save** — inputs: name; transport; scope (default project); project path; for a process: command, arguments, environment, working directory; for a network server: address, headers; agent-specific extras. Same name in the same scope overwrites. Errors (400, each distinguishable): name missing; transport missing or unknown; scope unknown; agent unknown; scope not supported by this agent; transport not supported by this agent; command missing; address missing.
- **Support matrix:** one agent supports user, project and private-per-project scopes and process, HTTP and event-stream transports; the others support user and project scopes and process and HTTP transports.
- **Delete** — reports whether anything was removed.
- **Save for all agents** — per-agent results; partial success possible; private scope and event-stream transport are refused.
- Entries are written to each agent's own configuration; the product keeps no copy. There is no enable/disable, no health check and no tool listing (Q-27).

**Skills**

- **List** — inputs: agent; optional project path. Output per skill: name, description, how to invoke it, scope (user, project, plugin, repository, administrator, system), source path, plugin. Unreadable skills are skipped. Skills of disabled agent plugins are excluded.
- **Install** — one or more entries, each a definition file's content and optional supporting files (text or base64) with a folder name. The whole batch is validated before anything is written. Folder name: requested name, else the skill's declared name, else the file name, else a numbered default; unsafe characters become hyphens. An existing folder is replaced completely. Errors (400): nothing supplied; content missing; name missing; duplicate target in one batch; duplicate file; a supporting-file path that is absolute, climbs out, or collides with the definition file; agent does not support writing.
- **Delete** — confined to the managed skill location; reports whether anything was removed.

**Commands**

- **List** — input: optional project path. Output: the six built-ins and the custom commands (name, description, level, metadata). Custom commands are Markdown files found recursively in the agent's standard user-level and project-level command locations; the name is a slash followed by the file's relative path without its extension; the description comes from the front matter or the first content line.
- **Execute** — inputs: command name; for a custom command its file; arguments; context (agent, model, conversation). A built-in returns an action and data for the client to present. A custom command returns its text with the all-arguments placeholder and positional placeholders substituted (placeholders without an argument stay as typed), plus flags "contains file references" and "contains shell commands". The service itself runs no shell and expands no file reference.
- Errors: name missing → 400; custom command without a file → 400; file outside the command locations → 403; not found → 404.
- Front matter is parsed as data only; it can never execute code.

### 5.14 Plugins

- **A plugin** is a folder with a manifest declaring: a machine name (letters, digits, hyphen, underscore), a display name, a browser entry script (relative path, no parent steps), optionally a version, description, author, an icon (a vector image inside the plugin), a server script, and a list of declared permissions. The only extension point is one workspace tab.
- **List** — every valid plugin found in the plugins location (re-scanned on each call, so a folder added by hand appears), with its manifest values, enabled flag (default on), repository address (credentials stripped) and whether its process is running. Invalid manifests and duplicates are skipped silently.
- **Install** — input: a Git address beginning with the https or the SSH form (anything else → 400). Steps: shallow download to a temporary place; require a valid manifest at the root; refuse a name already installed; install dependencies with their install scripts disabled; run the plugin's build step if it has one (60 s limit); move into place; start its process if it has one. Download and dependency install have time limits too, and every failed step returns its specific reason.
- **Update** — stop the process, fast-forward to the latest revision, re-validate, reinstall and rebuild, restart if it was running.
- **Enable / disable** — a strict boolean; enabling starts the process, disabling stops it.
- **Uninstall** — stop the process, delete the folder (retrying briefly if busy), drop its stored settings.
- **Assets** — files inside the plugin folder by relative path, not cacheable; anything resolving outside the folder → 404.
- **Request proxy** — any method and path to the plugin's own process on a loopback port. Only the content type and the plugin's configured secrets are forwarded; the user's credentials are **not**. Started on demand if not running. No process → 503; disabled → 503; unknown → 404.
- **Real-time relay** — frames relayed both ways with their type preserved; distinct close reasons for invalid name, not running, upstream error.
- **Process lifecycle** — must announce readiness and its port within 10 s or it is ended; polite stop, forced after 5 s; enabled plugins start at Service boot; a crashed process is restarted only by the next proxied request; all stop at shutdown; it runs with a minimal environment (never the Service's secrets).
- **Interface contract** — the tab's interface runs in an isolated frame (7.6) and is given, through a narrow message interface: the theme, the current project (identifier and path) and conversation (identifier and title), a way to subscribe to changes of these, and a helper to call its own process through the proxy.

### 5.15 Task planning

- **Installation status** — is the external planning tool present, its version, whether its tool server is configured. **Tool-server status** — found, scope, names of configured keys only (never values).
- **Project status** — planning folder present; task file present; "configured" only when both; counts by status and completion percentage. Blank project → 400; unknown → 404.
- **List tasks** — tolerates the tool's plain and tagged file layouts; defaults for missing fields (status pending, priority medium, a placeholder title); empty list when there is no file; unparsable file → 500.
- **Update a task** — a status-only change sets the status directly; anything else is delegated to the tool's AI-assisted update.
- **Requirement documents** — list, read, save text or Markdown documents directly inside the planning folder's documents area. Save accepts only names made of letters, digits, underscore, dash, dot and space, with non-empty content; a name that would leave the folder → 400 before any file access; missing → 404.
- **Further capabilities:** initialise a project (400 if already initialised); add a task (a prompt, or title and description; priority high/medium/low; dependencies as comma-separated numeric identifiers); parse a document into tasks (count 1–100, append flag); list and apply document templates.
- Values that become arguments of the external tool are validated so they can never be read as options. A failure of the tool is reported as an external-tool failure, with its output filtered per 5.0. Successful changes are announced to open clients, which refetch.

### 5.16 Stored tokens and the programmatic agent run

- **Stored repository-host tokens** (per user): list (never the value); create (name, kind, value required; description optional); delete; enable/disable (strict boolean). Used only for cloning and for the programmatic run. Unknown or another user's → 404. (Storage protection is specified by domain 3.)
- **Programmatic agent run** (API key in a header; streaming or single answer):
  - Inputs: a task message (required); a repository address and/or a registered project (at least one); agent; model; optional token; optional branch name; create-branch; create-PR; clean-up (default on, only for clones the call created); optional existing conversation to continue.
  - Path handling: address only → clone into a temporary location inside the allowed workspace roots; project only → the project's folder; both → reuse the project's folder when its remote matches (mismatch → error). The client never names a folder directly.
  - After a successful run, optionally: create the branch (given name validated against version-control naming rules, or generated from the message: lower-case words joined by hyphens with a short time-based suffix, ≤ 50 characters), push it, and open a PR whose title is the newest commit's subject (or the message) and whose body lists recent commit subjects.
  - Branch and PR results are reported as part of the answer; a failure there does not fail the run; both are skipped when the run was aborted.
  - Errors: neither address nor project → 400; empty message → 400; unknown agent → 400; a conversation already running → 409; unknown conversation → 404.
  - Temporary clones are deleted shortly after the run.

---

## 6. Black-box acceptance tests

Conventions for these tests:

- They are written against behaviour only and can be run through the interface or through whatever client interface the rebuild exposes.
- "Signed-in user U" means a client holding valid credentials. "The workspace root" is the configured root for project folders (default: the Service user's home). `P` denotes a test project whose folder is inside the workspace root.
- Limits are written with their recommended defaults; where the rebuild makes a limit configurable, the test uses the configured value.
- "Refused with 4xx" means the request fails with that status category and a human sentence, and **nothing on disk or in stored state has changed**.
- Tests marked **[neg]** are negative tests; **[sec]** are security tests; **[O]** tests a feature with reach code O (section 2).

### 6.1 Workspace projects

- **AT-PJ-001** (PJ-001, PJ-003) — *Given* an existing empty folder inside the workspace root, *when* U registers its path, *then* the answer contains a new identifier and a display name equal to the folder's last path segment, and the project appears in the active list.
- **AT-PJ-002** (PJ-003) — *Given* a path inside the root whose last two segments do not exist, *when* U registers it, *then* both folders exist afterwards and the project is listed.
- **AT-PJ-003** (PJ-001) — *Given* a registered project, *when* U registers the same path again, *then* the request is refused with 409 and the list still contains exactly one project for that path.
- **AT-PJ-004** (PJ-001) — *Given* a registered project at path X, *when* U registers X written with a trailing separator, with a doubled separator, or with a "./" segment, *then* each is refused with 409 (same project).
- **AT-PJ-005** (PJ-004) **[neg][sec]** — *When* U registers the filesystem root, the system configuration directory, or the system temporary directory, *then* each is refused with 400 and a reason naming system directories; no project is created.
- **AT-PJ-006** (PJ-004) **[neg][sec]** — *Given* a workspace root R, *when* U registers a path outside R that is not a system directory, *then* it is refused with 400 and a reason naming the allowed root; the folder is not created.
- **AT-PJ-007** (PJ-004) **[neg][sec]** — *Given* a symlink inside R pointing to a folder outside R, *when* U registers the symlink's path, *then* it is refused with 400.
- **AT-PJ-008** (PJ-003) **[neg]** — *When* U registers a blank path, *then* 400.
- **AT-PJ-009** (PJ-002, PJ-012) — *Given* a client connected to live updates and a folder F that is not a project, *when* an agent conversation is saved for F by running the agent outside the product, *then* within 15 seconds the client shows a project for F containing that conversation, without a reload.
- **AT-PJ-010** (PJ-007) — *Given* project P, *when* U renames it to "Demo", *then* lists show "Demo" and the folder's name on disk is unchanged; *when* U renames it to blank, *then* the display name falls back to the folder-derived name.
- **AT-PJ-011** (PJ-008) — *Given* P with two conversations, *when* U archives P, *then* P is absent from the active list and present in the archived list with both conversations; the folder and history files are unchanged; *when* U restores P, *then* it is back in the active list with the same identifier.
- **AT-PJ-012** (PJ-008, PJ-019) — *Given* P is open in the workbench, *when* U archives it from the switcher, *then* a toast with undo appears and the workbench shows another project or the empty state; *when* U presses undo, *then* P is restored and the workbench returns to where it was.
- **AT-PJ-013** (PJ-009) **[sec]** — *Given* P with a conversation and a file `keep.txt` in its folder, *when* U deletes P permanently and confirms, *then* P and its conversation are gone from every list, and `keep.txt` and the folder still exist.
- **AT-PJ-014** (PJ-003, PJ-008) — *Given* an archived project at path X, *when* U registers X, *then* the answer says the archived project was reactivated and carries the original identifier and name.
- **AT-PJ-015** (PJ-012) — *Given* P with 45 conversations, *when* U lists projects with defaults, *then* P carries 20 conversations, total 45 and has-more true; a page size of 500 returns at most 200; **[neg]** a negative or non-numeric offset when paging is refused with 400.
- **AT-PJ-016** (PJ-012) — *Given* the project list request fails (service unreachable), *then* the workbench shows a "failed to load" state with retry and not the "no projects" state; after connectivity returns, retry shows the projects.
- **AT-PJ-017** (PJ-005) **[O]** — *When* U browses the workspace root, *then* only directories are returned (no files), dependency and build folders are left out and dot-folders come last; **[neg]** browsing a system directory or above the root is refused with 403; a file path is refused with 400.
- **AT-PJ-018** (PJ-005) **[O][neg]** — *When* U creates a folder that exists → 409; whose parent does not exist → 404; outside the root → 403.
- **AT-PJ-019** (PJ-006) **[O]** — *Given* a reachable public test repository "sample", *when* U clones it into parent folder D, *then* the client receives at least one progress message followed by a completion carrying a project whose folder is `D/sample` and whose name is "sample"; the folder contains the repository.
- **AT-PJ-020** (PJ-006) **[O][neg][sec]** — *When* U submits a clone whose address uses a local-file transport, an external-helper transport, or begins with a dash, *then* the stream ends with an error before any transfer starts and no folder is created.
- **AT-PJ-021** (PJ-006) **[O][neg][sec]** — *When* U submits an address with a user-and-secret part embedded, *then* the error tells the user to put the token in the token field and does not repeat the secret.
- **AT-PJ-022** (PJ-006) **[O][sec]** — *Given* a clone handle issued to U, *then* opening its progress stream a second time, as another user, or more than 60 seconds after issue, answers 404; another user's attempt does not consume U's handle.
- **AT-PJ-023** (PJ-006) **[O][neg]** — *Given* `D/sample` already exists with a file in it, *when* U clones "sample" into D, *then* an "already exists" error is reported and the existing folder is untouched.
- **AT-PJ-024** (PJ-006) **[O]** — *Given* a clone in progress, *when* the client closes the progress stream, *then* the transfer stops and the partial folder is removed.
- **AT-PJ-025** (PJ-006, PJ-083) **[O][sec]** — *Given* a private test repository and a valid token supplied in the token field, *when* the clone completes, *then* the token appears neither in the cloned repository's stored configuration nor in any progress message nor in the handle.

### 6.2 Project cards, launching and links

- **AT-PJ-026** (PJ-013) — *When* U creates a card with a valid name, *then* the answer is "created" with an identifier, the tile appears on U's home screen, and **[sec]** another signed-in user reading that identifier gets 404.
- **AT-PJ-027** (PJ-013) **[neg]** — A name that is blank after trimming, or 81 characters long, is refused with 400; an 80-character name is accepted.
- **AT-PJ-028** (PJ-013) **[neg]** — A non-empty directory that is not an absolute path is refused with 400.
- **AT-PJ-029** (PJ-017) **[neg][sec]** — A card with 9 links is refused; a link whose address uses a script scheme is refused; 8 http/https links are accepted.
- **AT-PJ-030** (PJ-013) **[neg]** — Assistant switched on with no agent enabled is refused with 400.
- **AT-PJ-031** (PJ-018) — *Given* a card whose directory exists inside the root and is not yet a workspace project, *when* U launches it, *then* the answer is a workbench address for that folder, and the folder is now a workspace project.
- **AT-PJ-032** (PJ-018, PJ-004) **[neg][sec]** — Launch is refused with a sentence when the card has no directory; when the directory does not exist; when it is a system directory or outside the root; and with 409 when the folder's workspace project is archived.
- **AT-PJ-033** (PJ-018) **[neg]** — Launching with an agent the card does not enable is refused with 400.
- **AT-PJ-034** (PJ-028) — *Given* a card with a scheduled message pending for its directory, *then* changing the directory, disabling an agent, switching off the assistant, and deleting are each refused with 409; renaming succeeds.
- **AT-PJ-035** (PJ-015) — *Given* a card whose folder holds files and agent conversations, *when* U deletes the card and confirms, *then* the tile is gone, and the files, the agent conversations and the workspace project all remain.
- **AT-PJ-036** (PJ-018, PJ-029) — *Given* a card with "open straight into the workbench" on, *when* U taps its tile, *then* the workbench opens on that project; pressing back shows the home screen (not the project page).
- **AT-PJ-037** (PJ-014) — *Given* the "new project" sheet with text typed in the AI form, *when* U switches to manual, types a name and switches back, *then* both forms still hold their text.
- **AT-PJ-038** (PJ-017) — *Given* a card with (a) a link that answers successfully, (b) a link that answers with a server error, (c) a link to a closed port, (d) a health-check link returning a small JSON status, *when* U opens the links sheet, *then* (a) shows a latency in ms, (b) shows the HTTP status, (c) shows "cannot connect", (d) shows a status summary.
- **AT-PJ-039** (PJ-017) **[neg][sec]** — *Given* a link to a link-local / cloud-metadata address (directly, or via a site that redirects there), *when* link status is read, *then* that address receives no request (verify at a listener) and the link shows as unreachable.
- **AT-PJ-040** (PJ-105) — *Given* one link to a site that permits framing and one to a site that forbids it, *when* U taps each in the links sheet, *then* the first opens in the in-app browser cover and the second opens a new browser tab.
- **AT-PJ-041** (PJ-016) — *Given* a card with assistant on, a repository link and automation off, *then* its page shows tabs in the order assistant, GitHub, settings; switching tabs adds no browser-history entries (one "back" returns to the home screen).

### 6.3 Workbench: switching and remembering

- **AT-PJ-042** (PJ-019, PJ-011) — *Given* projects A, B, C where C is pinned and B has the newest activity, *then* the switcher lists C under pinned, then B, then A.
- **AT-PJ-043** (PJ-011) — *Given* U pins A on device 1, *when* U opens the switcher on device 2, *then* A is pinned there too, in the same order.
- **AT-PJ-044** (PJ-019) **[sec]** — The switcher and the project chip never display a filesystem path; searching for part of a path that is not part of a name returns no match; searching part of the card name or folder name finds the project.
- **AT-PJ-045** (PJ-019) — With 6 projects no search field is shown; with 7 it is.
- **AT-PJ-046** (PJ-024) — *Given* project A with a run in progress, B with a pending approval, C with a finished conversation never viewed, *then* A's row shows a running mark, B's a red mark, C's a white mark; a project with both a pending approval and an unseen result shows only the red mark; opening C's conversation clears its mark.
- **AT-PJ-047** (PJ-020) — *Given* a folder project F, *when* U presses "add to home screen" on its row, *then* a card named after the folder exists on the home screen, the row shows the card's icon, and the hint is gone.
- **AT-PJ-048** (PJ-023) — *Given* U opened conversation c1 in A, then c2 in B, *when* U switches to A, *then* c1 is shown; *when* U later opens the workbench without naming a project, *then* the project used last on this device is shown.
- **AT-PJ-049** (PJ-021, PJ-022) — *Given* a new conversation in All scope in project A with text "hello" and one attachment, *when* U picks project B from the chip, *then* the new conversation is in B and still holds "hello" and the attachment.
- **AT-PJ-050** (PJ-022) — *Given* additionally an unsent draft "old" already waiting in B, *when* U moves from A to B as above, *then* B shows "hello" and A now holds "old"; moving back restores both to their original places.
- **AT-PJ-051** (PJ-021) — *After* the first message of the conversation is sent, the chip is no longer shown and the project cannot be changed.
- **AT-PJ-052** (PJ-019) — *When* U presses the switcher, slides onto project B and releases, B opens; *when* U releases outside any row, the list stays open and nothing is selected.
- **AT-PJ-053** (PJ-029) **[neg]** — An address naming an unknown project shows a "cannot find this project" state with a way to open the most recent project; it does not show a blank screen or an error dialog.

### 6.4 Inspector

- **AT-PJ-054** (PJ-031, PJ-032, PJ-033) — *Given* a desktop-width window, *when* U presses the inspector shortcut, *then* the inspector opens on the panel used last; *when* U reloads, *then* it is still open on the same panel with the same width.
- **AT-PJ-055** (PJ-031) — Dragging the edge cannot make the inspector narrower than 320 px or wider than 1100 px, nor leave the chat less than 360 px; double-clicking the edge sets 440 px.
- **AT-PJ-056** (PJ-031) — *Given* a phone-width window, *then* one tools button is shown; pressing it shows the inspector full screen on the panel used last, with no resize handle.
- **AT-PJ-057** (PJ-032) — *Given* a command printing a line every second in the terminal panel, *when* U closes the inspector for 10 seconds and reopens it, *then* the output continued without a "reconnected" notice.
- **AT-PJ-058** (PJ-031) — *Given* a conversation in All scope that belongs to project A, *then* the four tool buttons are offered and act on A; a new conversation without a project offers none.

### 6.5 Files and editor

- **AT-PJ-059** (PJ-034) — *Given* P containing a dependency folder, version-control metadata, an ignore file listing `*.log` with a negation for `keep.log`, and files `a.log`, `keep.log`, `src/x.ts`, *then* the tree shows the ignore file, `keep.log` and `src/x.ts`; hides `a.log`, the dependency folder and the metadata folder; and lists folders before files.
- **AT-PJ-060** (PJ-034) **[neg]** — *Given* P with more than 10,000 non-ignored entries, *when* the tree is requested, *then* it is refused with 413 and a sentence advising a narrower folder or ignore rules.
- **AT-PJ-061** (PJ-051) **[neg][sec]** — *When* U reads a file with a relative path that climbs out of P, or an absolute path of a file in another project, *then* 403 and no content.
- **AT-PJ-062** (PJ-051) **[neg][sec]** — *Given* inside P a symlink to a file outside P, a symlink to a folder outside P, and a dangling symlink, *when* U saves through the file link, creates or uploads inside the folder link, or saves to the dangling link, *then* each is refused with 403 and the outside targets are unchanged.
- **AT-PJ-063** (PJ-051) — *Given* a symlink inside P that points to another file inside P, saving through it succeeds; deleting a symlink removes the link and not its target.
- **AT-PJ-064** (PJ-037) **[neg]** — Creating an item named with a slash, a control character, a reserved device name, only dots, or blank is refused with 400 and a reason; the tree is unchanged and the inline field stays open.
- **AT-PJ-065** (PJ-037, PJ-038) **[neg]** — Creating an item whose name exists → 409; renaming to an existing sibling's name → 409.
- **AT-PJ-066** (PJ-039) — *Given* a folder with nested files, *when* U deletes it and confirms, *then* the folder and all contents are gone; cancelling the dialog deletes nothing; **[neg][sec]** deleting the project root is refused with 403.
- **AT-PJ-067** (PJ-040) **[neg]** — Uploading 21 files in one request is refused with a message naming the 20-file limit; uploading a file larger than 200 MB is refused with a message naming that limit; nothing is stored.
- **AT-PJ-068** (PJ-040) — *When* U drags a folder containing `a/b/c.txt` onto a tree folder T, *then* `T/<folder>/a/b/c.txt` exists; uploading a file whose name exists replaces its content.
- **AT-PJ-069** (PJ-040, PJ-051) **[neg][sec]** — *Given* an upload of two files where one declares a relative path climbing out of P, *then* only the other is stored, the answer reports 1 of 2, and nothing is written outside P.
- **AT-PJ-070** (PJ-043) **[neg]** — Saving a text body above the request limit (default 50 MB) is refused with 413 and the file on disk is unchanged; the editor shows a readable error.
- **AT-PJ-071** (PJ-043) — *Given* an edited file, *when* U presses Escape or the close button, *then* a confirmation appears; declining keeps the editor and the edits; accepting closes it. With no edits, closing does not ask.
- **AT-PJ-072** (PJ-043) — *When* U edits and presses the save shortcut, *then* the file on disk equals the buffer, the unsaved mark disappears and a "saved" confirmation shows briefly.
- **AT-PJ-073** (PJ-043) — *Given* a file with Windows line endings, opening it shows no unsaved mark; typing a character and deleting it clears the mark again.
- **AT-PJ-074** (PJ-049) — *When* U taps a chat reference "src/app.ts:130", *then* the inspector shows that file with the caret on line 130; a reference to line 99999 lands on the last line; tapping the same reference again jumps again after the caret was moved.
- **AT-PJ-075** (PJ-049) — *When* U taps a chat reference ending in a slash for an existing nested folder, *then* the tree is shown with every ancestor of that folder expanded and no editor opens.
- **AT-PJ-076** (PJ-049) — A bare file name that exists once in P opens that file; an absolute path is opened as given and never replaced by a same-named project file.
- **AT-PJ-077** (PJ-048) — A PNG, a PDF, an MP4 and an MP3 in P each open as a preview without autoplay; **[neg]** a text file renamed to ".pdf" shows a "cannot display" state rather than a broken viewer.
- **AT-PJ-078** (PJ-048) — A ZIP archive opens a "binary file" placeholder; the save shortcut does nothing.
- **AT-PJ-079** (PJ-047) — *Given* a Markdown file with a table and a code block, *when* U edits it without saving and toggles preview, *then* the preview shows the edited text rendered.
- **AT-PJ-080** (PJ-046, PJ-053) — *Given* a tracked file with two separate modified regions, *when* U opens it from the Git panel, *then* the editor shows an inline change view reading "1/2", "next" moves to the second change and "next" again wraps to the first; the toggle hides and re-shows the highlighting.
- **AT-PJ-081** (PJ-050) — *Given* P with 30 files whose names contain "test", *when* U types "@test" in the composer, *then* a list of at most 10 files appears; choosing one replaces "@test" with that file's project-relative path followed by a space.
- **AT-PJ-082** (PJ-045) — *When* U turns word wrap on, *then* an already open editor wraps immediately, and a second device shows wrap on after its next preference sync.
- **AT-PJ-083** (PJ-041) — Downloading a file yields bytes identical to the file on disk (binary file included); downloading a folder yields a ZIP whose entries are exactly the files the tree shows under that folder.
- **AT-PJ-084** (PJ-036) — *Given* nested folders, *when* U types a substring matching only a deep file, *then* only the branch leading to it is shown, expanded; clearing the filter shows everything again.
- **AT-PJ-085** (PJ-034) — *Given* P's folder was deleted on disk, *when* the tree is requested, *then* a "project path not found" state is shown (404 class) and other projects are unaffected.

### 6.6 Git

- **AT-PJ-086** (PJ-054) — *Given* P without a repository, *then* the Git panel offers initialisation and no branch header; *when* U initialises, *then* status works and reports no commits; *when* U creates the initial commit, *then* history has one commit containing P's files; **[neg]** a second initial-commit request is refused with 400.
- **AT-PJ-087** (PJ-053) — *Given* a repository with one modified, one newly added (staged), one deleted, one untracked file and one file with a space in its name, *then* status lists each in the right group with the right letter, and the spaced path intact.
- **AT-PJ-088** (PJ-053) — A staged rename appears once, under its new path; a file in merge conflict appears as modified and never under staged.
- **AT-PJ-089** (PJ-056) — *When* U ticks a file, *then* the repository's index contains it (verify with the version-control tool); *when* a file is staged outside the product and U refreshes, *then* it shows as staged.
- **AT-PJ-090** (PJ-058) — With a blank message, or with nothing staged, the commit control is disabled; committing two staged files with message "m" creates one commit with message "m" containing exactly those files, clears the message field and empties the staged group.
- **AT-PJ-091** (PJ-057) — Discarding a modified file (after confirmation) restores its committed content; deleting an untracked file removes it from disk; **[neg]** asking to delete-as-untracked a tracked file is refused with 400.
- **AT-PJ-092** (PJ-059) — *Given* two commits, *when* U undoes the latest and confirms, *then* history has one commit and the undone commit's changes are staged.
- **AT-PJ-093** (PJ-061, PJ-062) — Creating branch "feature/login-form" succeeds and the header shows it as current; choosing another branch from the dropdown switches to it.
- **AT-PJ-094** (PJ-069) **[neg][sec]** — For each of the names "-f", "--orphan=x", "bad name", "bad;name", "a..b", a name ending in ".lock", and a name containing "$(…)": create, switch, delete and "compare against" are refused with 400 before the version-control tool runs; the repository's branches, files and configuration are unchanged.
- **AT-PJ-095** (PJ-063) — A fully merged branch is deleted by a normal delete; **[neg]** an unmerged branch is refused without force and deleted with force; the current branch is refused even with force; a non-boolean force value is refused with 400.
- **AT-PJ-096** (PJ-064) — *Given* a remote one commit ahead and a local branch two commits ahead, *when* U fetches, *then* the header shows "↑2 ↓1", and Pull and Push are both offered with their counts.
- **AT-PJ-097** (PJ-064) — *Given* a branch without upstream and a configured remote, only Publish is offered; after publishing, the remote has the branch, the upstream is set and Fetch is offered.
- **AT-PJ-098** (PJ-064) **[neg]** — *Given* a push the remote rejects as non-fast-forward, *then* the panel shows an error identifying a rejected / non-fast-forward push (not merely "push failed").
- **AT-PJ-099** (PJ-064) **[neg]** — *Given* a pull that conflicts, *then* the panel shows an error naming conflicts; *given* the remote is unreachable, *then* a network error; *given* credentials are rejected, *then* an authentication error; in none of these does the request hang beyond the configured time limit, and the tool never waits for interactive input.
- **AT-PJ-100** (PJ-064) — With no remote configured, no fetch/pull/push/publish control is shown.
- **AT-PJ-101** (PJ-066) — *Given* a feature branch with one committed change, one staged change, one unstaged change and one untracked file relative to the main branch, *when* U compares against main, *then* all four files are listed with a summary "4 files changed" and the merge-base identifier; expanding the untracked file shows all additions.
- **AT-PJ-102** (PJ-066) **[neg]** — Comparing against an unknown branch → 400 "unknown"; against a branch with no common history → 400 with that reason; the panel shows the corresponding sentence, not a generic failure.
- **AT-PJ-103** (PJ-065) — *Given* a repository with 60 commits and a merge, *then* the Commits tab shows 50 commits newest first with a graph in which the merge joins two lanes; expanding a commit shows its files and line counts; a commit whose diff exceeds the limit is cut with a visible "truncated" marker.
- **AT-PJ-104** (PJ-055) — *Given* a changed file whose diff exceeds 200,000 characters, *then* the expanded row shows a truncated diff with a notice and the interface stays responsive.
- **AT-PJ-105** (PJ-060) **[sec]** — *Given* a diff containing text that instructs the reader to delete files, *when* a commit message is generated, *then* the result is plain text and no file in the project changed and no command ran.
- **AT-PJ-106** (PJ-068) — Saving a commit identity with a malformed e-mail is refused with 400; a valid pair is stored and returned on the next read; a commit made afterwards carries that author.
- **AT-PJ-107** (PJ-053) — *Given* the status read fails (service unreachable), *then* the panel shows an error with a retry and keeps the last list.

### 6.7 Worktrees

- **AT-PJ-108** (PJ-067) — *Given* repository folder `repo`, *when* U creates a worktree for new branch "feature/x", *then* a folder exists under the sibling `repo-worktrees` directory, a project named "repo · feature/x" exists, and (with "switch" ticked) the workbench is on that project.
- **AT-PJ-109** (PJ-067, PJ-069) **[neg]** — Worktree branch names that are blank, start with a dash or slash, end with a slash or dot, contain "..", "//", whitespace, shell punctuation, a path component starting with a dot, or a component ending in ".lock" are refused with 400 and no folder or branch is created; " feature/login-form " (with surrounding spaces) is accepted as "feature/login-form".
- **AT-PJ-110** (PJ-067) **[neg]** — Creating a worktree for a branch already checked out elsewhere → 409; when the destination folder already exists → 409.
- **AT-PJ-111** (PJ-067) — *Given* a worktree two commits ahead, *when* U merges with squash and clean-up, *then* the main checkout's branch has exactly one new commit with the given message, the worktree folder and its branch are gone, and its project is archived.
- **AT-PJ-112** (PJ-067) **[neg]** — *Given* a worktree whose change conflicts with the main checkout, *when* U merges, *then* 409 with the conflicted file names; the main checkout has no new commit, no merge in progress and a clean tree.
- **AT-PJ-113** (PJ-067) **[neg]** — Merging when the worktree has uncommitted changes → 409 naming the dirty side; merging the main checkout into itself → 400.
- **AT-PJ-114** (PJ-067) — Removing a worktree with uncommitted changes is refused with 409 unless forced; with force the folder is removed; the main checkout can never be removed (400); the linked project ends archived with its conversations still restorable.
- **AT-PJ-115** (PJ-067) **[neg]** — Sending the text "true" where a boolean option is expected does not enable the option (it is rejected or treated as not set).

### 6.8 GitHub

- **AT-PJ-116** (PJ-071) **[neg]** — *Given* a host without the GitHub command-line tool, *when* U opens the GitHub app, *then* a setup state says the tool is not installed, offers re-check and folded instructions; no list, no error dialog.
- **AT-PJ-117** (PJ-071) **[neg]** — *Given* the tool is installed but not signed in, *then* the setup state says so and shows (folded) the sign-in command to run on the host; the browser offers no sign-in form; *when* the login is done on the host and U presses re-check, *then* the inbox loads.
- **AT-PJ-118** (PJ-070) **[sec]** — No answer of any GitHub capability, including error details, contains the login's token or a credential file location; an induced tool failure whose output contains a token-shaped string is shown with that string replaced.
- **AT-PJ-119** (PJ-071) — *Given* a login that can read but not merge, *then* the account line shows a read-only badge and the PR sheet's merge button is disabled with a sentence naming the missing permission.
- **AT-PJ-120** (PJ-072) — *Given* PRs authored by the account in two repositories and one PR awaiting its review, *then* "all" shows them grouped by repository with counts; "awaiting my review" shows one; the chosen filter is still selected after a reload.
- **AT-PJ-121** (PJ-073, PJ-074) — "My repositories" lists the account's own repositories (private and archived included) most recently pushed first; tapping one shows its page with default branch, latest commit and open PRs; back returns to the list with the same filter.
- **AT-PJ-122** (PJ-075) — *Given* a PR with one failing required check, one running and one passing check, *then* the sheet lists them in that order with the required badge, and re-reads by itself within 20 seconds while the check runs.
- **AT-PJ-123** (PJ-076) — *Given* an open, mergeable PR with passing checks, *when* U merges with "squash" and confirms, *then* the PR is merged on GitHub with that method, the sheet shows the merge commit, and the PR is absent from the inbox immediately (also if the list is refreshed within the next minute).
- **AT-PJ-124** (PJ-076) **[neg]** — *Given* the PR's head changes after the sheet was opened, *when* U confirms the merge, *then* it is refused with a sentence naming the new head and nothing is merged.
- **AT-PJ-125** (PJ-076) **[neg]** — A PR with a failing required check, a draft PR, a conflicting PR and a closed PR each show their blocker and cannot be merged (a direct request is refused); a PR with only a non-required check failing can be merged only after the explicit acknowledgement.
- **AT-PJ-126** (PJ-076) **[neg][sec]** — *Given* a PR blocked by branch protection (missing required review) and a login with administrator rights, *then* the product still refuses to merge; it never uses an override and never enables auto-merge.
- **AT-PJ-127** (PJ-076) **[neg]** — Two merge requests for the same PR sent at the same time: exactly one proceeds; the other is refused with 409.
- **AT-PJ-128** (PJ-078) — After a successful merge, a refused merge and a malformed merge request, the merge log shows three rows with outcomes merged, refused and invalid.
- **AT-PJ-129** (PJ-070) **[neg]** — An owner name starting with a hyphen, a repository named "..", PR number "0" or "01", and a commit identifier that is not 40 lower-case hexadecimal characters are each refused with 400 without contacting GitHub.
- **AT-PJ-130** (PJ-077) — *Given* a PR behind its base, "update branch" (after confirmation) brings it up to date; **[neg]** the same request for a PR that is not behind is refused; "approve runs" with an identifier that is not currently awaiting approval is refused and approves nothing.
- **AT-PJ-131** (PJ-079) — A card with a link to a repository on the public GitHub service shows a GitHub tab with that repository's page; a card without such a link has no GitHub tab.
- **AT-PJ-132** (PJ-080) — *Given* P's current branch has an open PR, *then* the title bar shows "PR #N" with a state; *when* an agent run in the open conversation ends after pushing a fix, *then* the chip re-reads within a few seconds; *given* no PR, a non-GitHub remote, or a signed-out host, *then* no chip is shown and no error appears.
- **AT-PJ-133** (PJ-081, PJ-082) — The GitHub widget shows the PR count and a one-line check summary; after a failed refresh it keeps the last figures with a "may be stale" marker. The CI widget lists running runs before queued and finished ones.
- **AT-PJ-134** (PJ-072) — *Given* GitHub is unreachable after a successful load, *then* the inbox keeps the last list under an error callout with retry.

### 6.9 Terminal

- **AT-PJ-135** (PJ-085) — *When* U opens the terminal for P and prints the working directory, *then* it equals P's folder; the first line shown names that folder.
- **AT-PJ-136** (PJ-087) — *Given* U sets a shell variable and starts a counter printing each second, *when* U closes the browser for one minute and reopens the terminal, *then* a "reconnected" notice is followed by recent output, the counter kept running in between, and the variable still has its value.
- **AT-PJ-137** (PJ-087) — *Given* no client attached for longer than the retention time (30 minutes; use a shortened setting in test), *then* the shell process no longer exists on the host and reopening starts a new shell without the earlier variable.
- **AT-PJ-138** (PJ-088) — *When* the terminal's container is resized, *then* the shell reports the new column and row count within one second.
- **AT-PJ-139** (PJ-085) **[neg]** — Opening a terminal for a directory that does not exist shows an "invalid project path" notice and starts no process.
- **AT-PJ-140** (PJ-096) **[neg][sec]** — Opening the terminal channel without credentials, with an expired credential, or with another deployment's credential is refused with 401 and no process is started.
- **AT-PJ-141** (PJ-096) **[sec]** — *Given* an open terminal, *when* U uses "sign out everywhere" on another device, *then* the terminal channel closes within seconds and cannot be reopened without signing in.
- **AT-PJ-142** (PJ-095) **[neg]** — *Given* the cap of live terminals (default 32) all attached, the next open is refused with a "too many active terminals" notice; after one client detaches, a new terminal can be opened.
- **AT-PJ-143** (PJ-095) **[neg]** — A single message larger than the channel limit (default 16 MiB) closes the channel without crashing the Service; other users' channels are unaffected.
- **AT-PJ-144** (PJ-085) **[sec]** — Printing the environment in the terminal shows none of the Service's own secrets or configuration values (signing secrets, storage location, API keys of the product).
- **AT-PJ-145** (PJ-089) — *Given* a phone-width window with a command running, *when* U taps the interrupt key on the key bar, *then* the command stops; the arrow-up key recalls the previous command; tapping bar keys does not dismiss the on-screen keyboard; the bar is absent at tablet width.
- **AT-PJ-146** (PJ-090) — *Given* a touch device, long-pressing a word in the output selects it and offers copy; after copying, the clipboard holds that word.
- **AT-PJ-147** (PJ-091) — *Given* an agent reply with a fenced `bash` block `echo hi`, *then* a run button is shown; tapping it opens the terminal panel and the shell prints "hi"; tapping again prints it again. A fenced block of another language and inline code show no run button.
- **AT-PJ-148** (PJ-091) — A console-transcript block with two lines starting "$ " and output lines between them runs exactly the two commands. An untagged one-line block starting with a well-known program gets a run button; an untagged block of nine lines, or one mixing a command with output, gets none.
- **AT-PJ-149** (PJ-091) — *Given* the terminal panel was never opened, *when* U taps run, *then* the command is executed exactly once after the shell is ready (not lost, not doubled).
- **AT-PJ-150** (PJ-091) **[sec]** — Tapping run sends nothing to the agent: no new message appears in the conversation.
- **AT-PJ-151** (PJ-092, PJ-097) — *When* a program in the terminal prints a loopback address with a port, *then* a chip for it appears in Preview and a dot on the Preview tab; a printed address of a public website without a port produces no chip; chips survive a page reload on the same device.
- **AT-PJ-152** (PJ-085) — Terminals of two different projects are independent: a variable set in one is absent in the other.

### 6.10 Preview, AI builds and built apps

- **AT-PJ-153** (PJ-097) — Typing "localhost:5173" loads `http://localhost:5173/`; **[neg]** typing a non-web scheme shows an "enter an http or https address" message and loads nothing.
- **AT-PJ-154** (PJ-097) — *Given* the product is opened from another device and the address is a loopback address, *then* a note offers to substitute the product's own host name; accepting changes only the host part.
- **AT-PJ-155** (PJ-098) — *When* U starts a build with name "Habit tracker" and a description, *then* the answer is "created"; a folder with a slug of the name exists under the builds root containing an initialised repository and the guide file; a tile appears at once; a conversation for the build exists.
- **AT-PJ-156** (PJ-098) **[neg]** — A build with an empty description, an 81-character name, a description of 8001 characters, or an icon outside the offered sets is refused with 400 and creates no folder, tile or conversation.
- **AT-PJ-157** (PJ-098) — Two builds started at the same moment with the same name get two different folders.
- **AT-PJ-158** (PJ-100) — *Given* a parallel limit of 2, *when* U starts three builds, *then* two are "building" and the third "queued"; when one ends the third starts.
- **AT-PJ-159** (PJ-100) — Cancelling a queued build marks it stopped and it never starts later; cancelling a running build stops the agent within seconds and keeps the files written so far; **[neg]** cancelling it again → 409.
- **AT-PJ-160** (PJ-100) — Continuing a failed build re-queues it in the same conversation with progress reset; **[neg]** continuing a build that is running → 409.
- **AT-PJ-161** (PJ-100) — *Given* a build whose checklist has 8 steps, 5 completed and one in progress, *then* the tile reads 69 %; with 0 of 8 it reads no less than 4 %; with 8 of 8 and still running no more than 96 %.
- **AT-PJ-162** (PJ-101) **[sec]** — In restricted mode, instruct the build agent (through the description) to: run a package installer; run an interpreter; fetch a web page; write a file outside the build folder; write into the repository's hook or configuration area; write an agent-settings file in the folder; read through a symlink. *Then* every such action is denied, the denials are visible in the conversation, and the host shows no effect of them.
- **AT-PJ-163** (PJ-101) **[sec]** — In sandbox mode, a command run by the agent cannot read the user's SSH or agent-credential folders, cannot create a file outside the build folder, cannot reach a host other than the package registries, and cannot modify the repository's hooks.
- **AT-PJ-164** (PJ-101) **[neg][sec]** — *Given* sandbox mode is switched on but the sandbox cannot start, *then* the build fails with a clear reason; it does not run commands unconfined.
- **AT-PJ-165** (PJ-101) — The build form states the current mode; in restricted mode it says what the AI cannot do, and the variant (components missing / not switched on / unsupported) matches the host's actual state.
- **AT-PJ-166** (PJ-099) — *Given* a description of at least 4 characters and an empty name, *then* after a pause a suggestion appears; Enter in the name field adopts it without starting the build; typing a name removes the suggestion and no further suggestion requests are made.
- **AT-PJ-167** (PJ-100) — *Given* a build running when the Service restarts, *then* afterwards the tile shows "not finished" with a sentence that a restart interrupted it; a build that was queued starts by itself after boot.
- **AT-PJ-168** (PJ-102) — *Given* a finished build with a start script that listens on the port it is given, *when* U opens its tile, *then* the app answers in the frame; left unused past the idle time (30 minutes; shortened in test) its process no longer exists; opening the tile again starts it.
- **AT-PJ-169** (PJ-102) **[neg]** — *Given* an app that listens on a fixed port of its own choosing, *then* after 30 seconds the page shows "did not start", an explanation that it must listen on the port provided, the last output lines, retry and "let the AI fix it".
- **AT-PJ-170** (PJ-103) **[neg][sec]** — For a static app: reading its index works through the gateway address; a write method is refused with 405; a dot-file, a path with encoded parent steps and a symlink leaving the folder each answer 404.
- **AT-PJ-171** (PJ-103) **[neg][sec]** — A gateway address with an unknown secret answers 401; a valid address answers 401 after "sign out everywhere" and after a Service restart; an address issued to U for app A never serves app B.
- **AT-PJ-172** (PJ-103) **[sec]** — A script in a built app's page cannot read the product's stored session, cannot call the product's API with the user's rights, and cannot navigate the surrounding product page.
- **AT-PJ-173** (PJ-103) **[sec]** — A response from the app that tries to set a cookie results in no cookie being stored for the product's origin; the app never receives the user's product cookies or credentials.
- **AT-PJ-174** (PJ-104) — *When* U sends a change through the app's AI panel and the agent commits it, *then* the banner shows progress, the app restarts and the frame shows the changed app without U reloading.
- **AT-PJ-175** (PJ-015, PJ-102) — The settings tab of a built app shows its run state; Stop ends the process; Start brings it back.

### 6.11 Remote hosts

- **AT-PJ-176** (PJ-027) — The host list contains exactly the administrator-configured hosts; **[neg]** asking the status of an unknown host name answers 404 and makes no connection attempt.
- **AT-PJ-177** (PJ-027) **[neg]** — *Given* a configured host that is unreachable, *then* its status is "offline" with a short reason within 12 seconds; the page shows an alert with retry, not an empty list; a second status request within 60 seconds does not open a second connection.
- **AT-PJ-178** (PJ-026) — *Given* a remote card with an agent enabled and installed on the host, *when* U opens that agent's card, types something, presses done, and opens it again, *then* the same session with the earlier output is shown.
- **AT-PJ-179** (PJ-026) **[neg][sec]** — A card's remote directory containing a space, a semicolon, a quote, a dollar sign, a backtick or a ".." segment is refused with 400; a remote directory without a host is refused; a host name not in the configuration is refused.
- **AT-PJ-180** (PJ-026) **[neg][sec]** — A remote launch for another user's card answers 404; for an agent the card does not enable, 400; no request field lets the client supply a host address or a command.

### 6.12 Background work and recovery

- **AT-PJ-181** (PJ-107) — *Given* a conversation whose agent started a background command and a sub-agent, *then* the background button shows "2"; the sheet lists both with kind, status and elapsed time; the command's detail shows its command line; the composer accepts and sends a new message while they run.
- **AT-PJ-182** (PJ-107) — In the sheet, Escape first returns from a task's detail to the list, then closes the sheet, and never stops the run.
- **AT-PJ-183** (PJ-108) **[neg]** — A stop request naming an unknown conversation or a task that is not tracked is refused with a specific reason; a valid stop request results in the task being reported stopped.
- **AT-PJ-184** (PJ-109) — *Given* a run in progress when the Service restarts, *then* the conversation shows an "interrupted" card noting the restart; "view" shows the original input; "continue" sends exactly one continuation and closes the card; nothing was re-run automatically before U pressed continue.
- **AT-PJ-185** (PJ-109) **[neg]** — *Given* the same card open on two devices, *when* U presses continue on both, *then* exactly one continuation run starts and the card disappears on both.
- **AT-PJ-186** (PJ-109) — Dismissing a recovery card marks the run handled, starts nothing, and the card does not come back after a reload; **[sec]** another user cannot list or resolve U's interrupted runs (404 / empty).

### 6.13 Extensibility

- **AT-PJ-187** (PJ-110) **[O]** — *When* U adds a process-type tool server named "t1" at user scope for agent X, *then* the list shows it with the right badges, and agent X's own configuration (as read by the agent's CLI) contains it; saving "t1" again with a different command replaces the entry; deleting reports removal and the list no longer shows it.
- **AT-PJ-188** (PJ-110) **[O][neg]** — Saving without a name, without a transport, a process server without a command, a network server without an address, a scope the agent does not support, or a transport the agent does not support is refused with 400, each with a distinguishable reason.
- **AT-PJ-189** (PJ-110) **[O][sec]** — An environment value "supersecretvalue" is shown in the list only masked (first and last two characters); a four-character value is fully masked; the edit form does not reveal the stored value without an explicit reveal action.
- **AT-PJ-190** (PJ-112) **[O]** — A tool server registered by the product itself appears with a "managed" lock and offers neither edit nor delete.
- **AT-PJ-191** (PJ-111) **[O]** — "Add for all agents" returns one result per agent; when one agent's configuration cannot be written, the others still succeed and the failure is named.
- **AT-PJ-192** (PJ-113, PJ-114) **[O]** — Installing a skill folder containing a definition file and a helper script makes the skill appear under "user" with its declared name and description; installing a folder of the same name again replaces it completely (a file that existed only in the old version is gone).
- **AT-PJ-193** (PJ-114) **[O][neg][sec]** — A skill upload whose supporting file path is absolute or climbs out with parent steps is refused with 400 and nothing of the batch is written; a batch with two entries targeting the same folder is refused entirely.
- **AT-PJ-194** (PJ-115) — Typing "/" at the start of the composer opens the command list; typing "/" inside an unclosed code fence does not; with "/mod" typed, Tab completes the first match's name followed by a space and executes nothing; Enter executes it.
- **AT-PJ-195** (PJ-117) — *Given* a project-level command file "review" whose text contains the all-arguments placeholder and the first-positional placeholder, *when* U sends "/review alpha beta", *then* the message sent to the agent contains "alpha beta" and "alpha" in the respective places.
- **AT-PJ-196** (PJ-117) **[neg][sec]** — Asking to execute a command whose file lies outside the command locations (for example a system file) is refused with 403 and returns no file content.
- **AT-PJ-197** (PJ-116) — The model command lists models of the active agent only; choosing one shows a confirmation and the next run in that conversation uses it; the cost and status commands report the same model.
- **AT-PJ-198** (PJ-115) — While a run is in progress, sending text starting with "/" is delivered to the agent as an ordinary message (queued or steering) and no dialog opens.
- **AT-PJ-199** (PJ-118, PJ-119) **[O][neg]** — Installing from an address that does not start with the https or the SSH form, or that starts with a dash, is refused with 400; installing a repository without a valid manifest fails with a sentence naming the manifest and leaves nothing installed.
- **AT-PJ-200** (PJ-118, PJ-119) **[O]** — Installing a valid sample plugin shows its card and adds one tab; opening the tab renders the plugin's interface and it can fetch data from its own server-side part; disabling removes the tab and its process no longer runs; uninstalling (two-step) removes the card and the folder.
- **AT-PJ-201** (PJ-118) **[O][sec]** — A request relayed to a plugin's server-side part carries none of the user's credentials (verify inside a test plugin); a plugin asset path with parent steps answers 404; a plugin process's environment contains none of the Service's secrets.
- **AT-PJ-202** (PJ-121) **[O][neg][sec]** — Saving a requirements document whose name contains a path separator or parent steps is refused with 400 before any file is touched; adding a task with a priority outside high/medium/low, or with dependency text that starts with a dash, is refused with 400 and the external tool is not run.
- **AT-PJ-203** (PJ-121) **[O]** — *Given* a project with a task file of five tasks in three statuses, *then* the board shows them in the matching columns with correct counts; changing a task's status in its dialog moves the card and persists after a reload.
- **AT-PJ-204** (PJ-106) **[O]** — With the agent browser disabled, the panel says so and agents have no browser tools; after enabling and installing the runtime, an agent can open a page and the panel shows a screenshot of it; **[neg]** a fourth concurrent session (default cap 3) is refused; a tool call without the Service-issued secret answers 401.

### 6.14 Cross-cutting

- **AT-PJ-205** (all) **[neg][sec]** — For one representative capability of every group in section 5 (project list, card read, tree, file read, file save, upload, status, commit, worktree list, GitHub inbox, merge, host status, remote launch, build create, app open, tool-server list, skill list, command execute, plugin list, task list), a request without credentials answers 401, performs nothing and — for requests with a body — does not process the body.
- **AT-PJ-206** (all) **[neg]** — A client exceeding the request burst limit receives 429 with a retry-after hint; after waiting, requests succeed again.
- **AT-PJ-207** (PJ-013, PJ-098, PJ-078, PJ-083) **[sec]** — Signed-in user V cannot read, change or delete U's cards, builds, stored tokens or merge log: each answers 404 or an empty list, never U's data.
- **AT-PJ-208** (PJ-012, PJ-072, PJ-107) — With the network disconnected after content was loaded, project lists, the GitHub inbox and background-task marks keep their last content with a visible "may be out of date" or error notice; nothing is shown as deleted; after reconnecting they refresh without a reload.
- **AT-PJ-209** (PJ-019, PJ-031, PJ-089) — At phone width every action in this section that the tests perform with a pointer (row actions, context-menu file actions, branch switch and delete, worktree actions, PR merge) can be completed with touch only, without hover.
- **AT-PJ-210** (all) — No error message shown in this domain contains a raw untranslated browser or tool exception; each failure presents one sentence in the interface language with optional folded details.

---

## 7. Security and permission requirements

### 7.1 Trust model the rebuild must state explicitly

- The product is at heart a **single-owner tool**: everything in this domain (terminal, file operations, version control, built apps, plugins) ultimately runs as the one operating-system account that runs the Service, so a signed-in user is as powerful as that account. The rebuild must document this prominently and must not present any feature here as a sandbox unless section 7.4 or 7.5 says so.
- **Ownership:** either (a) the product is single-user by design and refuses to create a second account, or (b) every workspace project, terminal process, build, app grant and file operation is bound to its owner and checked on every request, so that no signed-in user can address another user's project, terminal or directory. Per-user data (project cards, builds, tokens, merge log, recovery records) is always owner-checked, answering 404 for others.

### 7.2 Path confinement

- **Project folders** may only be registered, created, cloned into, browsed or opened inside the workspace root, never in system directories, never via a symlink whose target leaves the root (5.1). These rules apply to every way a folder can become a project, including automatic discovery and "start a chat in this path" (Q-03).
- **File operations** address a project and a path. The resolved path must be inside the project.
  - **Writes** (save, create, rename, delete, upload) must additionally resolve symlinks on the deepest existing ancestor and on the target itself and stay inside the project's real folder; dangling symlinks are refused; rename and delete act on a link itself, never its target.
  - **Reads** must be confined after symlink resolution as well: a link inside the project that points outside it is not readable.
  - The project root itself can never be deleted or renamed through file operations.
  - An upload entry whose destination would leave the project is not written.
- **Extra read-only roots**, if kept at all (Q-12), are read-only without exception and confined after symlink resolution.
- **Deleting a project never deletes the working folder.** Only the product's own records and the agents' saved conversation files for that folder are removed.
- **Command files, skill files, plugin assets, requirement documents, built-app static files** are each confined to their own folder: no absolute paths, no parent steps (plain or encoded), no dot-files for static apps, symlinks resolved before the check.

### 7.3 Running external programs

- Every external program (version control, the GitHub command-line tool, the SSH client, package installers, the planning tool) is started **without a shell**, with arguments passed as a list.
- Values that come from a client (branch names, refs, remote names, file paths, repository owner and name, numbers, priorities, dependency lists, remote directories, plugin addresses) are validated against a strict pattern **before** the program starts, can never begin with a dash, and are separated from options by an end-of-options marker where the program supports one. A refused value changes nothing.
- External programs must never prompt: no interactive credential or host-key questions. They run in a neutral working directory when the directory is irrelevant, with debugging output disabled.
- Every external call has a time limit and its outcome on timeout is reported as "unknown" where a write may have happened (merge, PR fixes), never as success or as a clean failure.
- **Cloning:** only http, https and ssh transports; never helper, file or other transports (enforced both by the product and by the tool's own allow-list); no credentials in addresses; a token is handed to the tool only through a mechanism that is not visible in process listings, only for the intended host over https, and never persisted in the clone.
- **The terminal is the one deliberate exception**: it runs whatever the user types, as the Service's account. Requirements: authenticated channel; the working directory is derived by the Service from a registered project, never supplied by the client; the Service's own secrets and configuration are removed from the shell's environment (this prevents accidental leakage only; the shell can still read what the account can read); terminal processes are not shared between users.
- **One-off commands in a terminal.** Anything that is not typed by the user (agent sign-in, remote launch) is chosen from a server-side list (sign-in of agent X; remote launch for card Y), never passed as free text from the browser.

### 7.4 Unattended AI builds (deny by default)

Nobody approves tool use during a build, so the Service decides every tool call itself, before the agent's own rules apply, including calls made by sub-agents. If the decision component is missing, fails or answers unexpectedly, the call is **denied**.

**Both modes**

- Only listed tool categories are allowed: the agent's checklist bookkeeping; sub-agents (without separate worktrees); reading, searching and writing files strictly inside the build folder.
- Every path argument must be inside the build folder, checked level by level; **any symlink at any level is refused**, even one pointing inside the folder. Search patterns may not contain parent steps, home shortcuts or outside absolute paths.
- **Control files can never be written**, anywhere in the folder: agent settings folders, version-control metadata (hooks and configuration included), tool-server definitions, editor and commit-hook configuration. Plain instruction documents for agents may be written because they grant nothing.
- No web fetch, no web search, no external tool servers, no skills, no monitors. Questions to the user and plan approval are refused with guidance to decide and record assumptions in the README.
- The build loads none of the user's or the project's agent settings and starts no tool servers, so nothing configured elsewhere can widen its rights.
- The agent process receives only a short allow-list of environment values (basic shell and locale values, what the agent needs for its own login, proxy settings, cache locations, commit identity). None of the Service's secrets.
- The agent is told never to push or publish.

**Restricted mode (default)**

- Shell commands are accepted only as a plain list of words: the raw text may contain letters, digits, spaces and a small set of harmless punctuation — therefore no quotes, variable expansion, wildcards, pipes, redirection, chaining or line breaks.
- The program must be one of: print working directory, list, show file content (whole, head, tail, count), make directory, touch, remove, move, copy; and a few version-control subcommands (initialise, status, diff, log, add, commit with a one-word message), each with a fixed set of options.
- Every path argument is confined as above; write commands cannot touch control files; the build folder itself cannot be removed.
- Consequently: no interpreters, no package managers, no network, no tests. The form says so (4.20).

**Sandbox mode (explicit administrator opt-in, and only when the operating system's sandbox components are present)**

- Any command may run, but only inside the agent CLI's operating-system sandbox, and a command can never opt out of it.
- Writable: the build folder (minus control files) and the sandbox's own temporary area. Package-manager caches are redirected into a cache folder inside the project that is excluded from version control.
- Readable: the build folder and well-known toolchain install locations. The rest of the home directory — SSH keys, agent logins, user configuration, other projects, the product's own data — is unreadable.
- Network: only the public package registries for JavaScript and Python, plus mirror hosts the administrator adds.
- If the sandbox cannot start, the build **fails**; it never falls back to running unconfined.
- Installed-but-not-enabled must remain "restricted": the sandbox is used only after the administrator has verified on that machine that it really blocks (reading SSH keys, writing outside the folder, reaching other hosts, writing hooks) and has switched it on.

**Further requirements:** the symlink check and the file access it guards happen as one step (for example, access relative to an already-opened folder), so a link swapped in between cannot redirect a write; sandboxed commands cannot read the agent's own login values, or at least cannot send them anywhere; the administrator documentation says that continuing a build conversation by hand in the workbench uses the user's normal permission settings, not this policy.

### 7.5 Built apps

- **Running a built app:** generated code and its dependencies are untrusted. Built apps run with the same confinement as sandboxed builds (or under a separate low-privilege account) and with a filtered environment; where such confinement is not available, a clear warning is shown before the first start of any app.
- **Browser-side isolation (must keep):** the app is served under an opaque origin (sandbox policy without same-origin on the frame and on every response); it cannot read the product's storage, call its API as the user, set cookies, register service workers or navigate the product page; it may be embedded only by the product; forwarded requests carry no user cookies, credentials or proxy headers.
- **Gateway grants** are unguessable, bound to one user and one app, expire, are capped in number and die with "sign out everywhere". A gateway link opened in a new tab is short-lived or bound to the session, so a copy left in the browser history cannot be replayed later.

### 7.6 Plugins

What a plugin **may** do: add one workspace tab; render its own interface there; receive the theme, current project (identifier and path) and conversation (identifier and title); call its own server-side part through the product's proxy; run a server-side process on the host. Plugins are code from third parties; the settings screen warns to install only trusted plugins.

**Requirements for 2.0 if plugins are kept:**

- A plugin's interface runs in an isolated frame with an opaque origin and talks to the product only through a narrow message interface; it never has access to the signed-in session.
- Declared permissions are enforced and shown before install; a plugin gets nothing it did not declare.
- The proxy never forwards the user's credentials; plugin processes never receive the product's secrets and are confined at least to their own folder plus the current project; the install-time build step runs under the same confinement.
- Install sources are validated (https or SSH repository addresses only, no option-like values); dependency install scripts stay disabled; every install step has a time limit and reports its specific failure.
- Plugin names follow a strict pattern on every path that carries them; plugin icons are sanitised (no scripts, foreign content, external references).
- Per-plugin secrets need a management screen; they must never be readable by other plugins.

### 7.7 Secrets and sensitive output

- No capability returns a token, password or key: stored repository-host tokens are write-only; the GitHub login's token and credential location are never read or reported; tool-server environment values and headers are masked in lists and are not revealed in forms without an explicit action; planning-tool key **names** only.
- Text coming back from external tools is filtered before display: colour codes and control characters removed, token-shaped strings replaced, length capped; advice to use administrator override or auto-merge is never relayed.
- Remote addresses with embedded credentials may be recognised but are never echoed.
- Project paths are not shown in the main interface's project lists (names only).
- Session credentials in addresses (streams, channels) are redacted from logs.

### 7.8 Writes to GitHub

- Merges and fixes are decided on a fresh and complete read, serialised per pull request, and recorded in an audit log **before** execution; without a log record nothing runs.
- The product merges only what the user saw: the request carries the head commit, and a moved head refuses the merge.
- No administrator override, no auto-merge, no bypass of required checks or reviews, even when the login would allow it. Failing optional checks require an explicit, per-head acknowledgement.
- Approving workflow runs requires each run to be listed as approvable in a fresh read; the confirmation warns about running outside contributors' code with secrets.
- Every destructive action has a confirmation naming the object (repository, number, method, short commit).

### 7.9 Remote hosts

- Hosts exist only in administrator configuration; the browser can never name a host, a target or a command. Malformed configuration entries are skipped without echoing them.
- Remote directories are restricted to a safe character set without parent steps.
- Status probes are fixed, non-interactive, cached and single-flight so that polling clients cannot multiply logins on the host.
- Agent logins made on a remote host are stored there, separately from the host owner's own; the interface must tell the user that the host's owner can read them.

### 7.10 Server-side requests on behalf of the user

- The link checker contacts addresses chosen by the user. It must refuse link-local and metadata addresses (IPv4 and IPv6, mapped forms, also after redirects), limit redirects, time out quickly, never read bodies except small JSON from health links, and cache results. Loopback and private addresses are allowed on purpose (single-owner model); in a multi-user deployment they must be refused too.
- The agent-driven browser can reach http(s) addresses, including loopback and private ones, and named profiles persist cookies on the host. If kept, it needs an administrator switch, a session cap and timeouts, and — in a multi-user deployment — an address policy.

### 7.11 Frames

- Preview frame, in-app browser and HTML preview load third-party or generated content. Each must be sandboxed so that the content cannot reach the product: HTML preview and built apps without same-origin; preview and in-app browser pages keep their own origin but can never script the product page; no referrer is sent.
- The product itself refuses to be framed by other origins.

### 7.12 Must never be possible

1. Reading or writing a file outside the addressed project (apart from the documented read-only roots) through any file, upload, download, command, skill, plugin-asset or static-app capability — including via symlinks, parent steps, absolute paths or encoded forms.
2. Registering or cloning a project into a system directory or outside the workspace root.
3. Deleting a working folder by deleting a project or a project card.
4. Passing a client-supplied value to an external program as an option or as shell syntax.
5. Receiving any stored secret, the GitHub login token, or another user's data from any capability.
6. Merging a pull request that is blocked by its repository's rules, or one whose head changed after the user reviewed it.
7. An unattended build writing outside its folder, writing control files, following a symlink, reaching the network (restricted mode) or reaching hosts beyond package registries (sandbox mode), or running unconfined because the sandbox was unavailable.
8. A built app or a previewed page reading the product's session or acting as the user.
9. Opening a terminal, a file capability or any capability of this document without a valid session; or keeping a terminal channel open after all of the user's sessions were revoked.
10. The browser choosing a remote host, or a command to run on one.
11. An interrupted run being re-executed automatically, or being continued twice.
12. Automation, a plugin or an agent merging, pushing or deploying without the user's explicit action in the relevant screen (builds never push; the run button never reports back to the agent).

---

## 8. Mobile requirements (this domain)

**General**

- Three layouts by width: phone ≤ 699 px, tablet 700–1023 px, desktop ≥ 1024 px; re-evaluated on rotation. A tablet rotating between tablet and desktop width keeps open panels alive (no reload of the terminal or tree).
- All targets ≥ 44 px. Nothing may depend on hover: the old system hides branch-row actions, the folder-row upload icon and some worktree actions behind hover, and exposes file actions only through a context-menu event. The rebuild must provide a touch route for each (visible buttons, swipe actions or a long-press menu).
- Safe areas: panels pad for the notch and home indicator; full-screen covers reach the screen edges in an installed home-screen app.
- Typing in any field must not leave the page zoomed (fields render at a size the phone browser does not auto-zoom).
- The page behind a sheet, popover or sliding list must not scroll while a finger is on it; that block ends when the finger lifts.

**Projects**

- Side list is a sheet from the left on phones, opened by the top-left button or by a left-to-right swipe over the chat (about 56 px, mostly horizontal, not starting within about 20 px of the screen edge so the system back gesture still works). Focus is trapped; Escape (hardware keyboard) closes; switching scope inside the open sheet arrives in the other scope with the sheet still open.
- Switcher rows: swipe left for actions, one row open at a time, plus an always-available "…" button; press-and-slide selection works with a finger; the search field does not grab focus on touch-only devices.
- "New project" and PR sheets are bottom sheets with a grabber and pinned actions; forms stay above the keyboard.
- Project page tabs are a 44 px segmented strip; back gestures: edge swipe and a hardware-keyboard back shortcut.

**Inspector and tools**

- Phone: one tools button; inspector is a full-screen sheet above the keyboard; no resizing; closing returns to the chat at the same scroll position.
- Opening a file reference or pressing a run button from the chat brings the right panel forward; closing it returns to the message.
- Files: rows and actions usable by touch; uploads through the system file picker (photos and files); downloads through the browser's download handling; the editor's toolbar stays reachable on long unwrapped lines; the unsaved-changes prompt also protects against accidental back navigation.
- Git: sync buttons as icons; commit composer collapsed to a single "commit N files" button until tapped; diff with a wrap/scroll toggle (wrap by default); row actions labelled with text; dialogs full-width.
- GitHub: PR sheet as a 92 % bottom sheet; merge-method buttons wrap; the branch PR chip shows number and dot only; widgets tap through to the app.
- Preview: address field uses the URL keyboard without auto-capitalisation or correction; the loopback note is especially relevant on phones (the phone is never the host).

**Terminal**

- Key bar (width < 768 px) above the on-screen keyboard with: paste, Esc, Tab, Shift+Tab, Ctrl, Alt, arrows, interrupt, scroll to end; horizontally scrollable; never steals focus. Ctrl and Alt must combine with the next key from the on-screen keyboard.
- The terminal resizes to the area above the keyboard so the prompt stays visible; rotation refits.
- Long-press word selection with draggable handles and a copy menu; selection point offset above the finger; selecting hides the keyboard, a tap brings it back.
- Pinch to change font size (8–48 px); inertial one-finger scrolling.
- A paste button is required because phone browsers restrict clipboard reads to a direct tap.
- Tap-to-answer buttons for numbered choice prompts printed by agent CLIs (narrow screens).
- Sessions survive locking the phone or switching apps (30-minute retention) and reconnect on return without losing a running command.

**Builds and apps**

- The build form is a bottom sheet; the name-suggestion pill is tappable (not only keyboard-adoptable).
- Tile states must be distinguishable without colour alone (label text accompanies the ring).
- App home: below 1024 px the AI panel is a floating button opening a bottom sheet with focus trap; the app frame fills the remaining screen.

**Background work**

- The background-task sheet is a bottom sheet on narrow columns; recovery-card buttons have 44 px targets and the card fills the column width.

**Connectivity**

- Phones change networks and get suspended. Lists keep their last content with a notice, polling pauses while the page is hidden and resumes at once on return, and the terminal and live project updates reconnect with back-off.

---

## 9. Open questions and ambiguities

**Model and ownership**

- **Q-01** Two notions of "project" coexist (host-wide workspace project; per-user project card) and are paired by folder. Several cards may point at one folder; deleting one does not delete the other; a deleted workspace project is silently re-registered when its card is opened. Should 2.0 unify them into one object?
- **Q-02** Is 2.0 single-user by design, or must ownership of workspace projects, stars, archive state, directories and terminals be enforced everywhere (see 7.1)?
- **Q-03** Automatic discovery and "start a chat in this path" follow the location rules (7.2). Should discovery also respect the archived state, or un-archive a project on any new activity?
- **Q-04** Does 2.0 need an administrator-defined list of reserved project names and directories?
- **Q-05** A card's directory is validated only when opened, not when saved; launch errors from that check are in English. Validate on save?
- **Q-29** "Starred" (host-wide, older interface) and "pinned" (per user, main interface) overlap; the main interface treats stars as pins until the user pins something. Keep only pins?
- **Q-30** Card deletion leaves the workspace project and agent conversations; workspace-project deletion leaves the card. Should one action offer both?

**Feature placement**

- **Q-06** Features with reach code O (section 2): clone-to-create, folder browser, commit identity, editor display settings, stored repository tokens, tool-server management, skills, plugins, command palette, task planning, agent-browser panel and its on/off switch, per-task stop for background work, agent CLI terminal mode. Which move into the main interface in 2.0? (Priorities in section 2 are this analyst's proposal.)

**Files and editor**

- **Q-07** The tree does not refresh after an agent edits files or after terminal activity; the user must press refresh. Should it watch for changes?
- **Q-08** No conflict detection: saving overwrites a file that changed on disk since it was opened (last write wins). Add a changed-on-disk check?
- **Q-09** Text reads: define a maximum openable size (suggest 5–10 MB with a "too large — download instead" state), binary sniffing (an unknown binary never opens as editable text), the text encoding, and line-ending preservation.
- **Q-12** Extra read-only roots (5.3): needed in 2.0, or should agent-mentioned files outside the project simply not open?
- **Q-20** There is no search inside file contents and no move/copy/duplicate. Add content search?
- Folder download is assembled in the browser from the visible tree, one request per file; empty folders and ignored files are missing. Should the service produce the archive?

**Git**

- **Q-10** Absent: history paging and search, amend, stash, rebase, cherry-pick, revert, tags, branch rename, remote management, conflict-resolution interface, side-by-side diff, automatic status refresh. Which are wanted?
- **Q-11** Remote operations: section 5.4 specifies distinct failure classes and a time limit; confirm.
- **Q-21** Commit-message generation (PJ-060): surface it next to the message field, and with which agents?
- **Q-24** A new-worktree name that matches only a remote branch creates a fresh local branch instead of tracking it; clean-up and archival errors after merge/remove are returned but not shown; if one worktree's state cannot be read the whole list fails. Intended behaviour for each?
- Detached-head state is shown as such (not as a branch named "HEAD", and publish is not offered). Undo-commit warns when the commit was already pushed. Discard works on a staged rename. Switching branch refreshes the branch list and counts as well as the change list.
- A project nested inside a larger repository shows the whole repository's changes *(inferred)*.

**GitHub**

- **Q-19** Only the public GitHub service; only repositories under the user's own account in "my repositories" (organisation repositories appear only through authored/review searches); no creation of pull requests, no issues, releases or commit lists, no notifications for CI or PR events, no sign-in from the interface. Which of these does 2.0 want? Should other hosts (Enterprise, other forges) be pluggable?
- The fix audit log has no reader. The repository tab appears only for https links.

**Terminal**

- **Q-14** One plain shell per folder, shared by the inspector and the project page; no second terminal, no tabs, no restart or kill control and no connection indicator in the main interface; an ended shell cannot be restarted without leaving the view. Add multiple terminals and a restart control?
- **Q-15** Terminal scope: section 7.3 limits the terminal to project directories and to one-off actions from a server-side list; confirm.
- **Q-16** The agent-CLI terminal (PJ-094) has a toggle that starts the agent with its permission prompts skipped. Keep, restrict to an administrator setting, or drop?
- Re-attaching applies the new client's terminal size at once; the replay buffer is bounded in bytes as well as in chunks; reconnect uses back-off; the key bar's Ctrl/Alt combine with soft-keyboard letters; links in agent sign-in output are clickable.

**Preview, builds, apps**

- **Q-17** Built apps: confinement, gateway-link lifetime and a cap on running apps are specified in 5.10 and 7.5. Are real-time sockets to apps wanted?
- **Q-25** Preview does not forward ports: a development server bound to loopback is unreachable from a phone, and an insecure address cannot be framed in a secure deployment. Should the Service proxy a project's local ports (authenticated, per project)?
- Builds cannot be deleted from the interface (deleting the card leaves folder and conversation). The build agent is fixed to one agent. Is a completion notification for builds wanted (none specific was observed)?
- Only JavaScript and Python package registries are reachable in sandbox mode.

**Background work**

- **Q-13** The main interface cannot stop a single background task, and a conversation with only background work cannot be interrupted there. Add a stop control with confirmation?
- Command output in the sheet is what the agent last read, not a live tail.

**Extensibility**

- **Q-18** Plugin trust model (7.6): keep plugins at all in 2.0? If yes, isolated frames and enforced permissions change the plugin contract, and a screen for per-plugin secrets is needed. The plugin-side contract is described from the host side only.
- **Q-27** Tool servers: are enable/disable, a connection test and a listing of tools wanted? Values are masked in every answer and form (7.7), and a project-scope entry always names its project — there is no fallback folder.
- **Q-23** Custom commands: the "contains shell commands" confirmation should trigger only on actual shell markers; decide whether file-reference and shell markers are expanded by the product or only flagged, and which front-matter options take effect; should the API-only chat get a slash menu?
- **Q-28** Task planning: keep the integration at all (it depends on a third-party tool and its keys)? If kept: a board column for tasks in "review", correct sort labels, every listed document template usable, and screens for add-task, parse-document and initialise.
- Skills: no view, edit, delete or enable/disable in the interface; one agent refuses skill installs.

**Language**

- **Q-26** The Git panel, much of the file tree, the task board and the command dialogs are English in an otherwise Chinese interface. 2.0 should define its supported languages and localise uniformly.

**Programmatic run**

- **Q-22** Programmatic agent run: which address forms are accepted (https on the public GitHub host; SSH as well?), which base branch a PR targets, and a rejected address answers 400. Is this capability in scope for 2.0?

---

## 10. Noticed outside my domain

- (Domain 1) A programmatic "run an agent on a repository" capability authenticated by API key, with streaming answers and session continuation; only its branch/PR part is specified here (5.16).
- (Domain 1) The workbench can be embedded as an assistant panel beside another embedded tool, receiving that tool's current screen as an attachment and reporting "needs you / finished" back to the host page — a generic capability hiding inside a private feature.
- (Domain 1) All scope can list sessions from an additional read-only source (for example a second operating-system environment on the same machine) as size-limited transcripts, and can hand such a session over to continue inside the product.
- (Domain 1) Conversation hand-over between agents is stored as per-project chains that can be renamed and forgotten.
- (Domain 1) The chat attachment store is one host-wide folder (10 files of 10 MB per request), not per project; attachments are referenced by absolute path.
- (Domain 1) Full-text search across conversations exists as a streamed capability used by the older sidebar and palette.
- (Domain 1) A toggle exists to start an agent's CLI with permission prompts skipped (older terminal tab) — a permission-model decision.
- (Domain 1) Suggested next messages can reference the session's pull request ("one-tap PR fixes").
- (Domain 3) A "version and runtime status" page compares the browser's build, the deployed build, the running Service and the checkout, and looks up the latest commit of the product's own source repository.
- (Domain 3) Updating the Service is an operator action only; no signed-in capability pulls or reinstalls it (domain 3, SEC-082).
- (Domain 3) The Service has a host command-line tool (start, status, options for port and data location) and an experimental launcher that runs the product inside a container sandbox.
- (Domain 3) Whether a desktop wrapper application is in scope is an open question there.
- (Domain 3) First-run onboarding collects the commit identity and offers agent sign-in in an embedded terminal.
- (Domain 3) Stored repository-host tokens are encrypted at rest, like every other stored secret (domain 3, W-07).
- (Domain 3) Real-time channels check the request's origin; with cookie sessions this is what prevents cross-site connection hijacking.
- (Domain 4) A failed AI build is reported once to the project's automations; builds have no dedicated completion notification.
- (Domain 4) Project activity marks, the task inbox and recovery cards share one underlying record of runs; acknowledging in one place clears the others.
- (Domain 4) The older interface supports about a dozen interface languages; the main interface is Chinese-first with English fragments.
- (Domain 4) Home-screen widgets for GitHub and CI are specified here (4.15) because their data is this domain's.
