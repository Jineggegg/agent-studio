# Working on projects

A project is a folder on the server. Besides conversations with agents, the
Studio gives you tools to work on that folder yourself: files and an editor,
Git, GitHub, a terminal, terminals on other machines, and sharing with other
people. This guide covers each of them.

In the Workbench these tools sit beside the conversation, under **Project
tools** (on a phone, **Show project tools**): **Files**, **Terminal** and
**Git**. A project's own page — links, settings, sharing — opens from its tile
on the home screen or from the project's name in the Workbench (**Settings of
… / Settings and sharing**).

What you may do depends on your access. The owner can do everything below.
Members can do what a project is shared with them for; see
[Sharing a project](#sharing-a-project-with-a-member).

## Files

The **Files** panel shows the project folder as a tree that loads as you open
folders.

- **Find a file by name**, or switch to **Search inside files** for text. Text
  search matches exactly what you typed, ignoring case, and lists the first
  matches only. Files left out by the project's ignore rules are not searched
  and are marked in the tree.
- **New file**, **New folder**, **Rename**, **Delete**, **Copy path** are in each
  row's menu and the panel's **More file actions**. Deleting removes the file
  from the server's disk: "There is no bin to restore it from."
- **Upload** with **Upload files** or by dropping files onto the panel or onto a
  folder: at most 100 files, 200 MB per file and 500 MB per upload. A file with
  the same name is not overwritten unless you confirm **Replace**. If the
  Studio is behind a reverse proxy, the proxy's own size limit applies first
  (the nginx example in [remote access](../deployment/remote-access.md) allows
  64 MB).
- **Download** a file, or **Download as ZIP** for a folder (up to 10,000
  entries and 1 GB).
- **Symbolic links** are listed, not followed. A link that leads outside the
  project cannot be opened: everything the file tools do is confined to the
  project folder after following links, for reading as well as writing.
- **Git's own data** (`.git`) cannot be read or changed through the file tools.
  Use the Git panel.

### The editor

Opening a text file opens the editor. It opens text files up to 5 MB; larger
files and other kinds of files offer a download instead. Pictures, PDFs,
sound and video are previewed.

The view switch offers **Edit**, **Text**, **Preview** (for Markdown) and
**Changes** (the file's uncommitted changes, when it has any). **Wrap long
lines** and **Read again from the server** are in the editor's menu. Unsaved
text is kept while the page stays open, also when you switch to another tool
or project and come back.

### When the file changed underneath you

The Studio notices when a file you are editing changes on the server — because
an agent, another person or a program wrote to it:

- While you edit: "This file has changed on the server while you were editing.
  Your text is untouched; saving will ask which version to keep."
- When you save, nothing is saved and you choose:
  - **Load the server's version** — your unsaved text is discarded;
  - **Overwrite with mine** — your text replaces what was written meanwhile.
- If the file was deleted or moved meanwhile: **Save it here again** puts it
  back at its path.
- If a file of that name appeared meanwhile: you choose in the same way.

Nothing is ever overwritten without you choosing so.

## The Git panel

The **Git** panel works on the repository whose top folder is the project
folder. Its header shows the branch, how far it is ahead of and behind its
upstream, and the sync buttons. Its tabs are **Changes**, **History**,
**Branches**, **Compare** and **Worktrees**.

- **Changes** lists conflicts, staged files, changed files and new files. Tap a
  file to see its changes. **Stage**, **Unstage**, **Stage all**, **Discard
  changes** (asks first; the changes are lost), and **Delete the file** for a
  file Git never tracked.
- **Commit** takes a message and commits the staged files. Commits made from the
  Studio carry the name and e-mail you set under **Commit name and e-mail…**
  ("Kept with your account in the Studio. The git settings of the server itself
  are not changed."); without them, whatever git on the server is configured
  with. The repository's commit hooks run, as they would in a terminal.
- **Undo the last commit** removes it from the branch and keeps its changes
  staged — only when it has not been pushed and is not a merge.
- **Fetch**, **Pull** and **Push**. Pull moves your branch forward to its
  upstream; if the two have diverged nothing is changed and you are told, and
  **Pull with a merge commit** merges instead (only when there are no
  conflicts). A push is never forced. **Publish** pushes a branch that has no
  upstream yet and remembers it.
- **History** lists commits; tap one to see what it changed.
- **Branches** lets you switch (uncommitted changes come along when they fit
  the other branch), create a branch and switch to it, check out a branch that
  exists only on the remote, and delete a branch. Deleting a branch that holds
  unmerged commits asks a second time.
- **Compare** shows which files differ from another branch.

A folder that is not a repository offers **Initialise a repository**, and a
repository with no commits offers **Commit everything as the first commit**.

**Credentials.** Fetch, pull, push and clone run git as the account the Studio
runs under, with that account's git configuration, credential helpers and SSH
keys (in `~/.ssh`; an SSH agent only if you pass `SSH_AUTH_SOCK` through with
`AGENT_STUDIO_CHILD_ENV_PASSTHROUGH`). Git can never prompt for a password
here. These commands do not run in the agent sandbox, so they work even where
agents are kept away from the credentials.

### Messages you may meet

| Message | What to do |
|---|---|
| "The remote refused the credentials git has on the server. Sign git in on the server (a credential helper or an SSH key), then try again." | Set up the credentials as the service account, in a terminal. |
| "The remote rejected the push: it has commits this branch lacks (non-fast-forward). Pull first, then push again." | Pull, then push. |
| "This branch and its upstream have diverged: each has commits the other lacks. Nothing was changed." | Use **Pull with a merge commit**, or sort it out in a terminal. |
| "The changes conflict and cannot be combined automatically. Nothing was changed." | Resolve in a terminal or with an agent. |
| "Uncommitted changes in this folder are in the way and would be lost. Commit or discard them first." | Commit or discard, then try again. |
| "An unfinished merge or rebase is in the way. Finish or abort it in a terminal first." | It was started outside the Studio; finish it there. |
| "Git does not know who is committing. Set your commit name and e-mail first." | **Commit name and e-mail…** in the panel's menu. |
| "The commit was refused, most likely by one of the repository's commit hooks." | Read the details; fix what the hook complains about. |
| "This branch has no upstream branch on a remote yet. Publish it first." | **Publish**. |
| "The remote could not be reached…" / "Git did not finish in time and was stopped." | Check the server's network. Remote operations stop after 60 seconds, a clone after 15 minutes. |
| "Another git command is running in this repository. Try again in a moment." | Wait. |

The panel may also say what is wrong with the folder itself:

- **This folder is not a Git repository** — offers to create one.
- **This folder is part of a larger repository** — the repository starts in a
  folder above the project. The Studio manages only a repository whose top is
  the project folder, so it shows nothing here. Make the repository's top
  folder the project instead.
- **This repository has no working files** — a bare repository.
- **Git refuses to use this folder** — the folder belongs to another system
  account, and git does not trust it. The Studio never overrides that. Change
  the folder's owner, or allow it for the service account with git's own
  `safe.directory` setting.
- **Git is not installed on the server** — install git for the service account.

## Worktrees

A worktree is a second checkout of the repository on its own branch, in its
own folder and as its own project — so two pieces of work, or two agents, do
not step on each other. Creating, removing and merging worktrees create and
remove project folders, so **only the owner** can do them.

- **New worktree**: pick a branch. An existing branch is checked out as it is; a
  new one starts from where you are. The folder is created next to the
  repository, in `<repository>-worktrees/<branch>` (with slashes and spaces in
  the branch name turned into dashes), and only if that place is inside a
  workspace folder. **Open it as a project afterwards** adds it to the
  home screen.
- **Merge back** merges the worktree's branch into the branch of the main
  checkout: **One commit** (all its changes squashed into a new commit) or
  **Merge commit**. If they conflict, nothing is changed and the files are
  named. **Afterwards remove the worktree and delete its branch** cleans up in
  the same step.
- **Remove** deletes the worktree's folder from the disk, deletes its branch
  when it is fully merged, and archives its project, so its conversations can
  still be restored. A worktree with uncommitted changes asks again, because
  those changes exist nowhere else.

## GitHub

The Studio talks to GitHub only through the GitHub CLI `gh` on the server,
signed in as the account the Studio runs under. It never reads, stores or shows
that login's token.

**Setting it up**, in a terminal on the server as the service account (the app
shows this command when it is needed):

```bash
gh auth login --hostname github.com --git-protocol https --web
```

If the GitHub screen says "This login can read but not merge", the login lacks
permission to write to repositories:

```bash
gh auth refresh --hostname github.com --scopes repo
```

Then choose **Check again**.

**It is the owner's.** That login is the owner's GitHub identity, so the GitHub
tile, the pull requests, the repositories and merging are for the owner only.
Members see "GitHub is the owner's". In a conversation, the owner also gets a
branch chip in the title bar: the project's branch and, when the branch has an
open pull request, its number and state. It opens that pull request, or the
Git panel when there is none.

What the **GitHub** screen offers:

- **Pull requests** — open pull requests you opened, were asked to review, or
  that are in your repositories (**All**, **Review**, **Mine**, **Repos**).
  Each opens with where it stands: checks, review, conflicts, changed files
  and description.
- **Repositories** — the account's repositories, each opening its page:
  default branch, last push, open pull requests, recent merges.
- **Activity** — every merge and fix asked for from the Studio, with its
  outcome, the refused ones too. It is written on the server before anything is
  sent to GitHub.

**Merging** (**Merge…** on a pull request): choose how (squash, merge commit or
rebase — whatever the repository allows), and whether to delete the branch.
Merging is not offered while something blocks it — a draft, conflicts, a branch
behind its base, a failed or unfinished required check, a missing review, a
login without permission — and each blocker is named. If checks that are not
required are failing, you have to acknowledge that first. The merge names the
exact commit you looked at: if the pull request changed since, it is refused
and nothing is merged. A repository with a merge queue gets the pull request
added to the queue.

**Fixes** under "Can be handled here", each confirmed first and recorded:
**Update the branch** (GitHub merges the base into it), **Mark as ready for
review**, and **Approve waiting workflow runs** (for runs from outside the
repository; this runs code someone else wrote, in workflows that may hold
secrets — approve only code you have read).

Merging and fixes need a signed-in browser; an API token can never merge.

**Not verified:** the reading parts (account, repositories, pull requests,
checks) were checked by hand against a real GitHub account. **Merging and the
fixes have never been run against the real GitHub service**, only against a
stand-in `gh`.

## The terminal

The **Terminal** panel is a shell on the server, in the project's folder.

**Who can use it.** Only the owner, and only from a signed-in browser — never
with an API token. A terminal is the account's own login shell and is **not
sandboxed**: it can do anything the account the Studio runs under can. That is
why members never get one ("The terminal is for the owner").

**Opening one.** **Open a terminal** (or **New terminal**). If you signed in
more than 15 minutes ago, the app asks for your password first ("Confirm it's
you"). After that the same browser can reconnect and open more without being
asked. Another browser of yours is asked once for each terminal it joins.

**It keeps running.**

- Leave the page, lock the phone or lose the connection: the shell keeps
  running on the server. When you come back, the panel reconnects and replays
  what was printed meanwhile (the last 1 MB).
- A terminal **nobody is attached to for 30 minutes is ended**. Any terminal is
  ended after 7 days. Both end the programs running in it.
- Terminals **end when the server stops** or restarts.
- **Close this terminal** ends the shell and everything still running in it.
- Limits: 16 open terminals per person, 32 on the server, 4 browsers attached to
  one terminal at the same time.

**On a phone or a tablet without a keyboard and mouse**, a key bar above the
keyboard adds the keys a touch keyboard lacks: **Esc**, **Tab**, **Ctrl** and
**Alt** (they apply to the next key), the four arrows, **Ctrl-C**, **Shift-Tab**,
**Paste** and a button that scrolls to the newest output. Where the browser
does not hand over its clipboard, Paste opens a field to paste into first.
**Larger text** and **Smaller text** are in the terminal's menu.

**Addresses a program prints** — a development server announcing
`http://localhost:5173`, for example — appear as chips you can open. Because
"localhost" means the server, not your phone, the chip opens the server's own
host name instead and says so. The port still has to be reachable from your
device.

**"Run" in a conversation.** Shell code in an agent's answer has a **Run**
button for the owner. It types the command into the terminal — one line,
without control characters — and never presses Enter: "Typed into the
terminal. Press Enter there to run it."

Opening a terminal is recorded in the security log with the project and, for a
remote terminal, the host. What you type and what is printed are never
recorded.

If there is no terminal at all, see
[Terminal unavailable](operations.md#terminal-unavailable).

## Remote machines

The owner can open terminals on other machines over SSH. Which machines exist
is decided only by the person who operates the server, in a file on the
server. Nothing a browser sends can add a machine, or name a host, a user, a
key, a command or an SSH option; the browser refers to a machine by its id.

### The hosts file

The file is `remote-hosts.json` in the data directory, or the path in
`AGENT_STUDIO_REMOTE_HOSTS_FILE`. An example:

```json
{
  "hosts": [
    { "id": "bastion", "name": "Bastion", "hostname": "bastion.example.net", "user": "ops" },
    {
      "id": "build-box",
      "name": "Build box",
      "hostname": "10.0.0.12",
      "user": "dev",
      "port": 2222,
      "identityFile": "/home/studio/.ssh/id_ed25519",
      "jumpHost": "bastion",
      "defaultDirectory": "/srv/work",
      "agents": true,
      "hostKeyChecking": "accept-new"
    }
  ]
}
```

The fields:

| Field | Required | Rule |
|---|---|---|
| `id` | yes | 1 to 32 lower-case letters, digits or hyphens, not starting or ending with a hyphen. Unique. |
| `name` | yes | 1 to 40 characters, no control characters, no surrounding spaces, no leading hyphen. |
| `hostname` | yes | A DNS name, an IPv4 address or a bare IPv6 address. |
| `user` | no | 1 to 32 letters, digits, dots, underscores or hyphens, not starting with a hyphen or dot. Default: ssh's own. |
| `port` | no | 1 to 65535. Default 22. |
| `identityFile` | no | Absolute path of the private key on the server: letters, digits and `. _ + @ -` only, no `..`, at most 400 characters. |
| `jumpHost` | no | The `id` of another entry to connect through. Only one hop: that entry cannot have a jump host itself. |
| `defaultDirectory` | no | Absolute path on the remote machine where sessions start: letters, digits and `. _ + @ -` only, no `..`, at most 300 characters. |
| `agents` | no | `true` or `false` (default). Whether agent CLIs may be started there through the server's remote launchers. |
| `hostKeyChecking` | no | `"strict"` (default): the host key must already be in the service account's `known_hosts`. `"accept-new"`: a first key is recorded, a changed one is refused. |

The file is checked as a whole. **One mistake rejects all of it**, and until
it is fixed no machine is offered. The message names the field and the rule
but never repeats the value, for example `hosts[0].agents: has the wrong type
(expected boolean)` or `hosts[1].jumpHost: is not the id of a host in this
file`. It is shown on the Remote machines page and written to the server's log.

Further rules:

- It must not be writable by the group or others (`chmod 600` is fine), and must
  belong to the account the server runs as, or to root: whoever can write it
  decides where the server connects and with which key.
- At most 16 hosts and 256 kB.
- No restart is needed: the file is read again whenever it changes.

How the Studio connects:

- No SSH configuration file is read (neither `~/.ssh/config` nor the system's),
  so SSH aliases do not work; name hosts by host name and use `jumpHost` for a
  bastion.
- Public-key authentication only, and never interactive: SSH cannot ask for a
  password, a passphrase or a host-key decision. Use a key without a passphrase
  for the service account, or an SSH agent whose socket you pass through with
  `AGENT_STUDIO_CHILD_ENV_PASSTHROUGH=SSH_AUTH_SOCK`.
- With strict host-key checking, connect once by hand as the service account
  (`ssh user@host`) to record the host key, or use `"accept-new"`.
- No forwarding of any kind: no agent, X11 or port forwarding.

### Using a machine

**Settings → Remote machines** (owner only) lists the machines with a status
check: online or offline, how long the connection took, and which of `tmux`,
`git`, `claude` and `codex` were found there. A failed check says why, for
example "The machine refused the server's key." or "The machine's host key is
not known to the server, or it has changed."

**Open a terminal there** asks for the folder to start in (or the machine's
default) and the project the terminal belongs to — every terminal belongs to a
project and is listed with its terminals. On the machine the session runs
inside `tmux` when `tmux` is installed, so it survives a lost connection;
**Done** only detaches. Without `tmux` the session ends when the connection
does.

The app opens a shell. The server also has launchers that start Claude Code or
Codex directly on a machine whose entry says `"agents": true`, but the app does
not offer them yet. Whatever you run on a remote machine, agents included, is
outside the Studio's permission engine and sandbox.

## Sharing a project with a member

People are added by the owner under **Settings → People**: **Add person** with a
username, a role (**Owner** or **Member**) and a first password, which you give
them in person. Changes to people ask for your password again.

To share a project, open its page and, under **Shared with**, **Add a person**
with one of:

- **Can view** — reads the project's files, changes and history. Changes
  nothing and runs nothing.
- **Can change** — also starts conversations with the agents the project
  offers, edits and uploads files, and stages, commits, switches branches,
  pulls and pushes; and edits the project's name, icon and links.

**Stop sharing** takes the project away at once. A member who loses write
access has their running agents stopped.

What a member can never do: open a terminal, use GitHub or remote machines,
create or remove worktrees, clone, add, archive or remove projects, change a
project's switches or the agents it offers, share a project, manage people,
manage model providers or plugins, switch memory off for assistants, or write
to the `global` memory folder. Owners always see every project.

Things to know before you add someone:

- **Conversations are private to the person who started them.** A member sees
  only their own, and the app's lists show everyone only their own. The owner
  may open another person's conversation — the app leads there, for example,
  from a member's request that only the owner can allow — but only to read and
  to answer approvals: "Only the person who started it can write in it."
- **A member's agents run as the service account**, with its permissions on
  the operating system. The role limits what the Studio's API lets them do, not
  what an approved command can do on the machine. Do not give a member account
  to someone you would not let run code on the machine.
- **Pushes use the server's credentials.** A member who can change a project
  pushes with whatever git on the server is signed in with.
- **Dangerous requests of a member's agent wait for the owner.** The member can
  deny them but not allow them.
- Disabling a person (**Can sign in** off) signs them out everywhere and disables
  their API tokens. An agent they had running at that moment is not stopped:
  this is a known gap.
