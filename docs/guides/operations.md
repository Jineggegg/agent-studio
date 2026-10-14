# Operations

This guide is for whoever runs the Studio on a server: keeping it running,
upgrading it, backing it up, the commands for when nobody can sign in, what
the logs and the security log contain, and what to do when something does not
work.

Settings are environment variables starting with `AGENT_STUDIO_`;
[Configuration](../configuration.md) lists them all. Making the Studio reachable
from other devices is in
[Reaching your Studio from a phone](../deployment/remote-access.md).

## Running as a service

[Remote access](../deployment/remote-access.md#running-as-a-service-systemd)
has a systemd user unit to start from. Points that matter in practice:

- **Run it as an ordinary account** — the one whose projects, git credentials
  and agent sign-ins it should use. Never as root: the About page warns
  "This Studio runs as root, so every agent and terminal does too."
- **Give the service a `PATH` that finds everything.** The server looks for
  `claude`, `codex`, `gh`, `git`, `ssh` and `bwrap` on its own `PATH`, and a
  service manager's default is usually shorter than your shell's. If
  `command -v claude` in your shell prints `/home/you/.local/bin/claude`, the
  service needs that directory too, or Claude Code shows as not installed.
  Codex installed with npm starts through a Node.js script, so the directory
  of `node` belongs on that `PATH` as well. `ExecStart` needs the full path of
  `node` (`command -v node`).
- **Keep the settings in one file** that both the service and your shell can
  read, so that the operator commands below see the same data directory:

  ```ini
  # ~/.config/systemd/user/agent-studio.service (excerpt)
  [Service]
  WorkingDirectory=%h/agent-studio
  ExecStart=/usr/bin/node apps/server/dist/main.js
  EnvironmentFile=%h/.config/agent-studio.env
  Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
  Restart=on-failure
  ```

  ```bash
  # ~/.config/agent-studio.env
  AGENT_STUDIO_PUBLIC_ORIGINS=https://studio.example.com
  AGENT_STUDIO_TRUST_PROXY=on
  ```

- **The first start prints the setup token** to the service's output, so it
  ends up in the journal. It is useless once the owner account exists. To read
  it without the journal, use `setup-token` below.
- **Stopping** (`SIGTERM`, for example `systemctl --user stop agent-studio`)
  stops the agents' runs and ends every terminal; the server exits within 10
  seconds. On the next start, runs that were in progress are marked
  "Interrupted by a server restart" and **nothing is run again by itself**; a
  message queued behind such a run waits too. People continue or dismiss them
  in their conversations or from the inbox.

## Upgrading

The data directory is kept across upgrades; the database is migrated forward
automatically when the new version starts. There is no way back to an older
version other than restoring a backup, so make one first.

```bash
systemctl --user stop agent-studio
(umask 077; tar -C ~ -cpzf ~/agent-studio-data-$(date +%F).tar.gz .agent-studio)   # see Backups below
cd ~/agent-studio
git pull
npm ci
npm run build
systemctl --user start agent-studio
```

Before stopping, check that nothing important is running. The Workbench tile
says how many of your conversations are running; as the owner,
`GET /api/sessions?scope=all` lists everyone's conversations, running ones
first. Stopping interrupts them.

Browsers that have the app open notice the new version within a few minutes
(they check `/version.json`). A page that has been left alone reloads by
itself; otherwise "Agent Studio was updated — Refresh to use the new version."
**Settings → About → Check for a newer version** checks at once.

When you upgrade Claude Code or Codex themselves, nothing needs restarting:
the Studio reads a CLI's version and options again when its program file
changes. **Settings → Agent accounts** shows the version it found.

## Backups and restoring

**Stop the service**, then copy the whole data directory (`~/.agent-studio`
unless `AGENT_STUDIO_DATA_DIR` says otherwise), keeping its permissions. The
archive holds the master key, so it is created readable by you only:

```bash
systemctl --user stop agent-studio
(umask 077; tar -C ~ -cpzf agent-studio-data.tar.gz .agent-studio)
systemctl --user start agent-studio
```

It holds:

- `studio.db` — the database (with `studio.db-wal` and `studio.db-shm` while
  the server runs or after it stopped uncleanly);
- `master.key` — the key that protects stored credentials (absent when you
  supply `AGENT_STUDIO_MASTER_KEY`; then keep that value safe separately);
- `memory/` — the notes, as Markdown files;
- `attachments/` — files attached to messages;
- `plugins/` and `plugin-data/` — installed plugins and their data;
- `remote-hosts.json` — the list of remote machines, if you keep it here;
- `sandbox/` — an empty stand-in file the sandbox uses; harmless;
- `setup-token` — only until the owner account exists.

Treat a backup like a password manager export: with `master.key` it opens every
stored credential. To keep the two apart, supply `AGENT_STUDIO_MASTER_KEY`
from a secret manager and leave the key out of the backup.

**Not in the data directory**, so back them up yourself:

- the **project folders** — the Studio only records their paths;
- the agents' own records of their conversations, kept by the CLIs in their
  home directories (`~/.claude`, `~/.codex`). Without them a conversation still
  continues: Claude Code is given the earlier messages as text, and Codex
  starts a new thread with them and says so.

**Restoring**: stop the service, put the directory back where
`AGENT_STUDIO_DATA_DIR` points, owned by the service account (the server sets
its mode to `700` when it starts), use the same `AGENT_STUDIO_MASTER_KEY` if
you supplied one, and start.

On another machine, projects whose folders are not at the same paths say "The
project's folder no longer exists on the server." Without the original key,
everything works except what it protected: model providers' keys must be
entered again (the server reports such a key as no longer readable), and
devices must enable notifications again.

## Operator commands

The program behind the commands is the server itself,
`apps/server/dist/main.js` (installed as `agent-studio` in
`node_modules/.bin`). Run it from the repository folder **with the same
`AGENT_STUDIO_*` variables as the service** — otherwise it looks at the
default data directory and address:

```bash
cd ~/agent-studio
set -a; . ~/.config/agent-studio.env; set +a     # if you keep the settings in a file
node apps/server/dist/main.js status
```

| Command | What it does |
|---|---|
| `status` | Asks the server's health route and reads the data directory. Prints `Server: answering at …` or `not answering at …`, `Data: …` and `Accounts: …` ("none — first-run setup is pending" before setup). Exit code 0 when the server answers, 1 when not. |
| `setup-token` | Prints the pending one-time setup token, or says "There is no pending setup token: either setup is complete or the server has not been started yet." (exit code 1). |
| `reset-password <username>` | Asks for a new password (not shown as you type; or reads the first line of standard input) of 12 to 256 characters, sets it, **signs the account out everywhere, revokes all its API tokens, enables the account if it was disabled**, and clears every sign-in lock. |
| `unlock` | Clears every stored sign-in lock and identity-confirmation lock, for all accounts. Prints "Nothing was locked." or how many were cleared. |
| `version` | Prints the version. |
| `help` | Lists the commands. |

These work while the service runs and while it is stopped, and only for
someone who already has a shell on the machine as the service account.

About locks: after 5 wrong passwords for an account, each further failure
doubles the wait, from 30 seconds up to 15 minutes; an account with no failure
for an hour starts afresh. These locks survive restarts and are what `unlock`
clears. A separate limit of 20 failures per network address is kept in the
server's memory: `unlock` does not clear it, a restart or waiting does. Signing
in with a passkey works while the password is locked.

`status` connects to the address the server listens on (`127.0.0.1` when it
listens on all addresses). If the server speaks HTTPS itself
(`AGENT_STUDIO_TLS_CERT`), the certificate is checked like any client would,
and a certificate for a host name does not match `127.0.0.1`; then `status`
says "not answering" although the server runs. Use the health check below
instead.

## Health checks

- `GET /api/health` answers `{"status":"ok"}` without signing in. It is subject
  to the same host check as everything else: ask it at a loopback address
  (`curl -fsS http://127.0.0.1:7420/api/health`) or at a name listed in
  `AGENT_STUDIO_PUBLIC_ORIGINS`. Any other `Host` gets `403`
  `host_not_allowed`.
- `status` (above) for a check from a shell on the machine.
- For a closer look, sign in as the owner: **Settings → About** (configuration
  warnings, sandbox, terminal), **Settings → Agent accounts** (the agents),
  and the Memory screen's status card.

## Logs

The server writes to its standard output and standard error; under systemd,
read them with `journalctl --user -u agent-studio`.

- A few plain lines at start: the address, "(API only: no web client build was
  found)" when there is no client build, and on first runs the setup token.
- Then one JSON object per line: `level` (30 info, 40 warning, 50 error), `time`
  (milliseconds), `msg`, and context. At the default level `info`, each HTTP
  request gives an "incoming request" line with the method, the path **without
  its query string** and the client address **shortened to its network**
  (`203.0.113.x`; an IPv6 address to its `/48`), and a "request completed" line
  with the status code and the time it took. `Authorization` and `Cookie`
  headers are replaced by `[redacted]`.
- Warnings worth reading: "agent processes will run without a sandbox" at
  start, configuration warnings of the most serious kind at start, "remote
  hosts file rejected; no remote host is offered" with the reason, and an
  agent turn that failed (with the end of the CLI's error output).
- Not logged: message text, tool input and output, file contents, terminal
  input and output, credentials. As a safety net, credential-shaped text is
  removed from error messages before they are logged.

`AGENT_STUDIO_LOG_LEVEL=warn` drops the per-request lines. With
`AGENT_STUDIO_TRUST_PROXY=on`, a proxy on the same machine may supply the real
client address in `X-Forwarded-For`; without it, every request appears to come
from the proxy.

## The security log

Security-relevant events are kept in the database: sign-ins and refused
sign-ins, wrong passwords when confirming your identity, password changes,
passkeys added and removed, devices signed out, API tokens created and revoked,
the first setup and refused setup attempts, people added, changed and deleted,
model providers created, changed and removed, notification devices added, the
memory switch for assistants, dangerous agent requests and how they were
decided, terminals opened (project, launcher, remote host — never what was
typed), and GitHub merges and fixes with their outcome.

Entries carry no secrets, and addresses are shortened like in the logs. The
newest 2,000 entries of each kind (changes, sign-ins, failures) are kept; older
ones are removed when the server starts.

Read it under **Settings → Account & security → Recent security events**. The
owner sees everyone's events; anyone else sees their own. The API is
`GET /api/audit` (`?category=change|sign-in|failure&limit=…`, at most 200).

Look now and then for sign-ins from networks you do not recognise, refused
sign-ins in bulk, tokens or passkeys you did not create, and dangerous requests
allowed by Auto.

## Configuration warnings on the About page

As the owner, **Settings → About** starts with "Things to know about this
installation" when there is something. Each warning has **How to fix it**.

| Warning | Fix |
|---|---|
| "This Studio accepts unencrypted connections from other machines." | `AGENT_STUDIO_HOST` is not a loopback address and there is no TLS certificate. Bind to `127.0.0.1` and put a tunnel or TLS proxy in front, or set `AGENT_STUDIO_TLS_CERT` and `AGENT_STUDIO_TLS_KEY`. |
| "Sign-ins through http://… are not encrypted by the browser." | A public origin uses `http`. Cookies cannot be `Secure` there and passkeys do not work. Acceptable only on a network that encrypts itself (a mesh VPN); otherwise serve it over https. |
| "Proxy headers are trusted, but no public address is configured." | Turn `AGENT_STUDIO_TRUST_PROXY` off, or list the address the proxy serves in `AGENT_STUDIO_PUBLIC_ORIGINS`. |
| "Agents run without a sandbox, so an approved command could read the Studio's own data." | See [The sandbox is off](#the-sandbox-is-off). |
| "The key that protects stored credentials lives in the data directory." | Information. Fine for a personal machine; supply `AGENT_STUDIO_MASTER_KEY` from a secret manager to keep the key apart from the data and its backups. |
| "Other accounts on this machine can read the Studio's data directory." | `chmod 700` the data directory. |
| "This Studio runs as root, so every agent and terminal does too." | Run the service under an unprivileged account. |

The About page also shows the version, the build, how long the server has been
running, the sandbox and terminal state, and for the owner the Node.js version,
platform, data folder, workspace folders and public addresses. Members see no
warnings.

## Troubleshooting

### Cannot reach it from the phone

By default the Studio listens on `127.0.0.1` only, which nothing outside the
machine can reach. That is on purpose.

1. Set up one of the ways in
   [remote access](../deployment/remote-access.md): Tailscale, a tunnel, a
   reverse proxy, or SSH forwarding.
2. Set `AGENT_STUDIO_PUBLIC_ORIGINS` to **exactly** the origin you type on the
   phone — scheme, host name and port: `https://studio.example.com`, or
   `https://studio.example.com:8443` if you use a port. Restart.
3. Check from the server what the proxy will send:
   `curl -s -H 'Host: studio.example.com' http://127.0.0.1:7420/api/health`
   should print `{"status":"ok"}`.

If the phone shows `host_not_allowed` — "This address is not one this server
answers to. Add it to AGENT_STUDIO_PUBLIC_ORIGINS." — the name in the address
bar is not in the list. If the page loads but stays on "Reconnecting…", or the
terminal never connects, the proxy does not pass WebSockets (nginx needs the
`Upgrade` and `Connection` headers from the example). If uploads of large
files fail, the proxy's own body-size limit is lower than the Studio's.

### Writes are refused with "origin not accepted"

Pages load, but saving anything fails with "Requests from this address are not
accepted by the server" (code `origin_not_allowed`). The browser's `Origin`
must be the very origin the request was sent to, and that origin must be
loopback or listed. Usual causes behind a proxy:

- **The proxy rewrites the `Host` header** to `127.0.0.1:7420`. Forward the
  original (nginx: `proxy_set_header Host $host;`; Caddy keeps it by default).
- **The listed origin differs from the one the browser uses**: `http://` listed
  but the browser uses `https://`, or a port is missing.
- **The proxy drops the `Origin` header**: then the message is "This request is
  missing its Origin."

"This page is out of step with your session. Refresh and try again." (code
`csrf_failed`) is something else: the page holds an old anti-forgery token.
Reload it.

### Passkeys are unavailable

"Passkeys need an https address with a host name (or localhost)." Browsers do
not allow passkeys on IP addresses or on plain `http`, except at `localhost`.
Reach the Studio at an `https` address with a host name (Tailscale's
`*.ts.net` name with `tailscale serve`, a tunnel, a proxy with a certificate),
or, on the server itself or through SSH forwarding, at `http://localhost:7420`.
A passkey works only at the address it was created at.

### The sandbox is off

The About page shows "Agent sandbox: Off" with the reason, for example
"bubblewrap is not usable here (…)". Run the same check the server runs, as the
service account:

```bash
bwrap --bind / / --unshare-pid --proc /proc --die-with-parent -- true && echo works
```

- `bwrap: command not found` — install the `bubblewrap` package.
- An error about user namespaces or `uid map` — unprivileged user namespaces
  are disabled or restricted on this system (by a kernel setting or a security
  policy such as AppArmor). How to allow them for bubblewrap depends on the
  distribution.
- Works in your shell but not in the service — service hardening options can
  stop it; for example a bubblewrap installed setuid-root cannot work under
  `NoNewPrivileges=yes`.

Then restart the Studio and check About again. With `AGENT_STUDIO_SANDBOX=bwrap`
the server refuses to start without a working sandbox, so it can never run
without one by accident. What changes without it is described in
[Agents and approvals](agents-and-approvals.md#without-bubblewrap).

### An agent shows "not installed" or "not signed in"

On **Settings → Agent accounts**, choose **Check again** first: the status is
kept for up to a minute.

- **"Not installed"** although it runs in your shell: the service's `PATH` does
  not contain the program's directory (see
  [Running as a service](#running-as-a-service)), or the service runs as
  another account.
- **"Not signed in"** although you signed in: you signed in as a different
  account, or with a different `HOME` or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`
  than the service uses. Sign in again from **Settings → Agent accounts** —
  that runs the sign-in as the service account — or in a shell as that
  account.
- **You use an API key in an environment variable** (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`): the Studio never passes those to the CLIs. Use the CLI's
  own sign-in.
- **"too old for the Studio"**: update the CLI.
- **"It is not known whether Claude Code is signed in"**: `claude auth status`
  gave no readable answer. Try a message; if it fails with "not signed in", sign
  in again.

A run that fails for this reason ends with "The agent is not signed in on this
server" in the conversation.

### Codex refuses to run without a sandbox

"Codex is switched off here because the Studio's sandbox is not available…".
Codex runs read-only commands without asking anybody, and without the sandbox
those could read the Studio's data and every credential of the account. Fix the
sandbox ([above](#the-sandbox-is-off)). Only if you accept that risk, set
`AGENT_STUDIO_CODEX_WITHOUT_SANDBOX=on` and restart. Even then Codex refuses
while its home has saved command rules ("Codex has saved command rules…"): turn
the sandbox on, or move the files in `~/.codex/rules/` away.

### Terminal unavailable

The Terminal panel says why:

| It says | Cause and fix |
|---|---|
| "Terminals are turned off" | `AGENT_STUDIO_TERMINAL=off`. Remove it and restart, if you want terminals. |
| "The terminal is for the owner" | You are a member. Members never get a terminal. |
| "A terminal needs a signed-in browser" | You are using an API token. |
| "Terminals cannot run on this server" | The terminal library could not be loaded: there is no prebuilt binary for this platform, or optional dependencies were left out at install (`npm ci --omit=optional`). Run `npm ci` without that option. |
| "Too many terminals are open." | 16 per person, 32 per server. Close one. |

Opening a terminal asks for your password when you signed in more than 15
minutes ago. A terminal that keeps "Connecting…" usually means WebSockets do
not get through a proxy. The agents' sign-in buttons on **Settings → Agent
accounts** need the terminal too.

### Pull request checks that cannot run

A pull request on the GitHub screen says "runs await approval": GitHub holds
workflow runs of a contributor from outside the repository until a maintainer
approves them. **Approve waiting workflow runs** on the pull request does that —
it runs code someone else wrote, in workflows that may hold the repository's
secrets, so read the change first. It needs a `gh` login allowed to write to the
repository ("This login can read but not merge" means it is not:
`gh auth refresh --hostname github.com --scopes repo`). This action has not
been run against the real GitHub service yet.

### An agent's tests or builds fail inside the sandbox

Commands an **API model** runs have no network unless the request for network
access was allowed, and can write only inside the project (plus a private
`/tmp`); a test suite that downloads packages or writes to your home directory
fails there. Allow the network request when it is asked, or run the command
yourself in the terminal. Claude Code and Codex are not limited in this way,
but with **Agents may use this machine's credentials** off, anything that needs
the account's keys or tokens (`git push` over SSH, `gh`, a private package
registry) fails inside their runs even when approved.

### Locked out

- Wrong password too often: wait (at most 15 minutes per failure), sign in with
  a passkey, or run `unlock`.
- Forgotten password: `reset-password <username>` as the operator. An owner can
  also reset another person's password under **Settings → People**.
- A disabled account: an owner switches **Can sign in** back on under
  **Settings → People**; `reset-password` also enables it.

### The app shows an old version or a blank page

Open `/reset.html` on your Studio's address (for example
`https://studio.example.com/reset.html`). It removes the files this browser
cached for the app and its background worker; nothing on the server changes
and you stay signed in. **Settings → About → Clear cached files** does the same
from inside the app.
