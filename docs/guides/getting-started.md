# Getting started

This guide takes you from a fresh checkout to a first conversation with an
agent, and then onto your phone. It assumes you have read the
[quick start](../../README.md#quick-start) and want the details: what each step
does, what you will see, and what to do when a step goes wrong.

Agent Cloud Studio is beta software. The server and its security model are the
most mature parts. The client has been tested in desktop browsers and in
browsers emulating phone and tablet screens, not on a physical iPhone or iPad.
[docs/STATUS.md](../STATUS.md) lists what is finished.

## What you need

- **A machine you control**, running Linux. The test suites run on Linux. On
  macOS the server runs, but there is no agent sandbox (see
  [What the sandbox does](agents-and-approvals.md#what-the-sandbox-does)).
- **An ordinary user account** to run it under, never root. Agents and the
  terminal act with that account's permissions.
- **Node.js 22.13 or newer** and **git**. No compiler is needed.
- **bubblewrap** (`bwrap`), on Linux. Without it agents run without a sandbox,
  and Codex is switched off by default.
- **The agents you want to use**, installed for that same account: the
  [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI, the
  [Codex](https://developers.openai.com/codex/cli) CLI, or an API key for an
  OpenAI-compatible model service. You can add them later.
- Optional: the GitHub CLI `gh` (for the GitHub screen), `ssh` (for remote
  machines).

## Install and build

```bash
git clone https://github.com/Jineggegg/agent-studio.git
cd agent-studio
npm ci
npm run build
```

`npm ci` runs no install scripts: the repository's `.npmrc` turns them off, and
nothing here needs them. The terminal uses a prebuilt binary
(`@lydell/node-pty`, an optional dependency, built for Linux, macOS and Windows
on x64 and arm64). If it cannot be loaded on your machine, the terminal turns
itself off and everything else still works.

`npm run build` builds the shared packages, the server (`apps/server/dist`) and
the web client (`apps/web/dist`).

## First run

```bash
npm start
```

The server prints its address and, on the first run, a one-time setup token:

```
  Agent Cloud Studio is running at http://127.0.0.1:7420

  First run — create the owner account with this one-time setup token:

      Xrdh25gMtNpuLcRBKL-So9Oj

  It is also saved in /home/you/.agent-studio/setup-token until setup is complete.
```

Things to know about the token:

- It proves that whoever creates the owner account controls the machine.
  Anyone with the token and network access to the server could create the
  owner account, so do not paste it anywhere public.
- It is also in the file `setup-token` in the data directory, readable only by
  the service account. `node apps/server/dist/main.js setup-token`, run from
  the repository folder with the same `AGENT_STUDIO_*` settings as the server,
  prints it (see [Operator commands](operations.md#operator-commands)).
- **A new token is made each time the server starts until setup is done.** If
  you restart, use the newest one. To fix the token for a scripted install,
  set `AGENT_STUDIO_SETUP_TOKEN` (at least 16 characters).
- The file is deleted when the owner account exists.

By default the server listens on `127.0.0.1` only. Open the address in a
browser **on the same machine**. On a headless server, forward the port from
your own computer instead:

```bash
ssh -L 7420:127.0.0.1:7420 you@server
```

and open `http://localhost:7420` there. Prefer `localhost` to `127.0.0.1`:
passkeys work on `localhost` but never on an IP address.

If you run the server with other settings (another port, another data
directory), see [Configuration](../configuration.md). Every setting is an
`AGENT_STUDIO_*` environment variable; none is required.

## Create the owner account

The first page is **Set up your Studio**. Fill in:

- **Setup token** — the token from the console.
- **Username** — 3 to 64 letters, digits, dots, dashes and underscores,
  starting with a letter or digit.
- **Display name** — how you appear in the app.
- **Password** and **Password again** — at least 12 characters. Very common
  passwords, the username itself and a single repeated character are refused.

Choose **Create account**. You are signed in at once, and the setup form is gone
for good: the first account is the owner, and the owner adds everyone else
later under **Settings → People**.

If it goes wrong:

| You see | What it means |
|---|---|
| "That setup token is not correct. Copy it again from the server's console." | The token does not match. After a restart, use the newest token. |
| "Too many attempts. Try again at …" | Setup attempts are limited per network address. Wait. |
| "This Studio is already set up. Sign in instead." | An owner account exists. Use the sign-in page. If you lost the password, see [Operator commands](operations.md#operator-commands). |
| "This address is not one this server answers to. Add it to AGENT_STUDIO_PUBLIC_ORIGINS." | You opened the Studio under a name it does not know. See [Troubleshooting](operations.md#cannot-reach-it-from-the-phone). |

## What you see next

There is no setup wizard beyond that first page. You land on the **home
screen**: tiles for the built-in apps (Workbench, Settings, GitHub for the
owner, and others such as Inbox and Memory), one tile per project, and **New
project**. With no projects yet, it says so and suggests adding one.

A sensible order for the first visit:

1. **Settings → About.** As the owner you see warnings about the
   configuration here, for example that the agent sandbox is off. Fix those
   first; [Operations](operations.md#configuration-warnings-on-the-about-page)
   explains each one.
2. **Settings → Agent accounts.** Connect at least one agent (next section).
3. **New project** on the home screen.
4. **Open the project** and start a conversation.
5. Optional: **Settings → Account & security → Add a passkey**, and set up your
   phone.

## Connect an agent

### How the app shows agents

**Settings → Agent accounts** lists every agent the server offers. For each
one it shows:

- whether its program is installed on the server, and its version;
- which account it is signed in with (a label, never a credential);
- a badge: **Ready**, **Not signed in** or **Not installed**;
- for the owner, buttons that start the agent's own sign-in in a terminal on
  the server;
- when the server has something to say, a line starting "The server says: …".

The server asks the CLIs about their status in the background and keeps the
answer for a short while (30 seconds for Claude Code, up to a minute for
Codex). After you install or sign in, choose **Check again**.

The server looks for the programs on **its own** `PATH`, as the account it runs
under. If you start it with `npm start` from your shell, that is your shell's
`PATH`. A service manager usually gives a shorter one; see
[An agent shows "not installed" or "not signed in"](operations.md#an-agent-shows-not-installed-or-not-signed-in).

Members see the same page but cannot start a sign-in: "Only the owner can sign
an agent in."

### Claude Code

1. Install Claude Code for the account the Studio runs as, following
   [its documentation](https://docs.claude.com/en/docs/claude-code). The Studio
   needs a version whose `--help` lists the options it uses; an older one is
   reported as "too old for the Studio" with the options it lacks.
2. Sign in, in one of two ways:
   - in a shell on the server: `claude auth login`;
   - in the app: **Settings → Agent accounts → Sign in to Claude Code**. A
     terminal sheet opens on the server and runs `claude auth login`. "This is
     the agent's own sign-in, running on the server. Follow what it prints;
     closing this sheet ends it."
3. Choose **Check again**. The badge should say **Ready** and show the
   account.

The in-app sign-in needs the terminal: it is only offered when the terminal is
available (see [Terminal unavailable](operations.md#terminal-unavailable)), and
opening a terminal asks for your password if you signed in more than 15
minutes ago. The sign-in runs inside the same sandbox as the agents, so it
cannot see the Studio's own data.

Things that are different from using Claude Code in your own terminal:

- **Keys in environment variables are not used.** Variables starting with
  `ANTHROPIC_` or `CLAUDE_` are removed before Claude Code starts (except
  `CLAUDE_CONFIG_DIR`, if you pass it through with
  `AGENT_STUDIO_CHILD_ENV_PASSTHROUGH`). Claude Code uses the sign-in it
  stores itself.
- **Your Claude Code settings files and MCP servers are not loaded.** The
  Studio's permission engine decides instead. A project's `CLAUDE.md` is still
  passed on; see
  [Agents and approvals](agents-and-approvals.md#claude-code).

### Codex

1. Install the Codex CLI for the account the Studio runs as. The Studio's own
   status message suggests `npm install -g @openai/codex`; see
   [its documentation](https://developers.openai.com/codex/cli).
2. Sign in, in one of these ways:
   - in a shell on the server: `codex login` (or `codex login --device-auth`);
   - in the app: **Settings → Agent accounts → Sign in to Codex**, which runs
     `codex login` in a terminal on the server;
   - in the app: **Sign in to Codex with a code (works from a phone)**, which
     runs `codex login --device-auth`. Use this one when you are not sitting
     at the server.
3. Choose **Check again**.

Codex needs the agent sandbox. Without bubblewrap the badge may say Ready while
the line under it says "Codex is switched off here because the Studio's sandbox
is not available…". The reason, and the setting that overrides it, are in
[Agents and approvals](agents-and-approvals.md#without-bubblewrap).

Like Claude Code, Codex does not get model keys from the server's environment:
variables starting with `OPENAI_`, `AZURE_OPENAI_` or `CODEX_` and anything
ending in `_API_KEY` are removed (`CODEX_HOME` is kept if you pass it through).
With the sandbox on, the account's own Codex settings, rules, hooks and
personal `AGENTS.md` are hidden from it.

### An API model provider

An API provider is any service that speaks the OpenAI-compatible "chat
completions" protocol: DeepSeek, OpenAI, or a model server on your own machine.
Each enabled provider becomes one agent that everyone signed in to this Studio
can use. Only the owner adds, changes and removes providers. The key is stored
encrypted on the server and can never be read back.

The server side is complete and tested against a stand-in provider; it has
never been run against a real provider. The app's page for it,
**Settings → Models**, was still being built when this guide was written. What
the server offers, whichever way you reach it:

- **Presets** — starting values for DeepSeek (`https://api.deepseek.com`),
  OpenAI (`https://api.openai.com/v1`) and "Custom / self-hosted". They come
  from public documentation and have **not** been checked against the live
  services; model ids and context windows may be out of date. No prices are
  preset, so costs stay "unknown" until you enter prices.
- **The key** — write-only. Pasted values that are plainly something else are
  refused: an address, a sign-in token of a subscription or browser session,
  an organisation admin key, a GitHub, Slack or AWS credential, this Studio's
  own API tokens. Creating a provider, saving or replacing a key, changing the
  address and allowing the private network each need a browser session in
  which you confirmed your identity in the last 15 minutes; an API token can
  never do them. **Changing the address removes the saved key.**
- **The private-network switch** (`allowPrivateNetwork`) — off by default:
  then only `https` addresses that resolve to public IP addresses are
  contacted. On: loopback and private addresses are allowed too, and plain
  `http` only to those. Link-local addresses (such as cloud metadata services)
  are never contacted, and redirects are never followed.
- **Verify** — asks the provider for its model list (free), or, when it has
  none, for one token. The answer is a sentence such as "Local model could not
  be reached." with a code such as `provider_auth_failed` or
  `provider_unreachable`.
- **Discover models** — adds the provider's model list to the catalogue.
  Discovered models are marked as unable to call tools or read images, and
  start hidden from the pickers when the catalogue already offers a model. **A
  model only gets the Studio's tools (reading files, editing, running
  commands, memory) when its catalogue entry says `tools: true`**; edit the
  catalogue for models that support function calling.

If your build has no **Settings → Models** page yet, the owner can create a
provider from the browser's developer console, on a desktop browser:

1. Sign out and sign in again, so that your identity counts as confirmed for
   the next 15 minutes.
2. Open the developer console on any page of your Studio and run:

   ```js
   const state = await (await fetch('/api/auth/state')).json();
   const headers = { 'content-type': 'application/json', 'x-studio-csrf': state.csrfToken };
   const { presets } = await (await fetch('/api/providers/presets')).json();
   const p = presets.find((preset) => preset.id === 'deepseek'); // or 'openai'
   const response = await fetch('/api/providers', {
     method: 'POST',
     headers,
     body: JSON.stringify({
       name: p.name, baseUrl: p.baseUrl, allowPrivateNetwork: p.allowPrivateNetwork,
       keyRequired: p.keyRequired, balance: p.balance, models: p.models,
       defaultModel: p.defaultModel, preset: p.id, apiKey: prompt('API key'),
     }),
   });
   const created = await response.json();
   console.log(response.status, created);
   ```

3. Check the connection:

   ```js
   console.log(await (await fetch(`/api/providers/${created.id}/verify`, { method: 'POST', headers, body: '{}' })).json());
   ```

A status of `403` with `reauth_required` means step 1 is more than 15 minutes
old. For a server on your own machine, use the `custom` preset values with your
own `name`, `baseUrl` (for example `http://127.0.0.1:11434/v1`),
`allowPrivateNetwork: true`, `keyRequired: false` and a `models` list such as
`[{ "id": "your-model", "name": "Your model", "tools": true }]`. The request
fields are described in `packages/protocol/src/providers.ts`.

The new agent then appears in **Settings → Agent accounts** and in the agent
picker of every project that offers all agents.

## Add a project

A project is a folder on the server that agents work in. Only the owner can
add one: on the home screen choose **New project**. There are two ways:

**From a folder**

1. **Name** — required. **Description**, **Symbol** and **Colour** are for the
   tile.
2. **Folder** — the full path on the server, starting with `/` or `~/`, or
   choose **Browse** to pick one inside the workspace folders.
3. **Create the folder** — switch it on if the folder does not exist yet.
4. **Create**.

**Clone a repository**

1. **Repository address** — `https://…`, `ssh://…` or `user@host:path`, with no
   password or token in it.
2. **Clone into** — a folder inside the workspace (empty: the first workspace
   folder). **Folder name** — empty: the repository's name. It must not exist.
3. **Clone**. The clone runs on the server and carries on if you close the
   page. Cancelling stops it and removes what was fetched. A clone may take at
   most 15 minutes.

A private repository is cloned with whatever git on the server is already
signed in with (a credential helper or an SSH key). The Studio stores no
repository password.

Rules for the folder:

- It must be inside one of the **workspace folders**. By default that is your
  home directory; `AGENT_STUDIO_WORKSPACE_ROOTS` changes it. Otherwise: "Projects
  must live inside one of the Studio's workspace folders."
- It cannot be the home directory itself or a system folder: "That folder
  cannot be a project. Choose a folder inside it."
- It cannot overlap the Studio's data directory.
- A folder can be only one project: "That folder is already a project."

Removing a project later (on its page, **Settings and sharing**) deletes what
the Studio stored about it — conversations, schedules, sharing, settings — and
never the folder or its files. Archiving hides it and keeps everything.

## Your first conversation

1. Tap the project's tile. It opens the **Workbench** in that project.
2. Choose **New conversation**.
3. Check the agent: the button next to the message field shows the agent and
   model. Tap it to choose another; an agent that cannot be used is listed
   with the reason ("Installed, but not signed in on this server."). A
   conversation keeps the agent it started with.
4. Check the permission mode: the button in the title bar reads
   "Permissions: …". A first conversation starts in **Ask**; later ones start
   in the mode you last used with that agent on this device, never in Auto.
   Leave it on **Ask** for now; the modes are explained in
   [Agents and approvals](agents-and-approvals.md).
5. Type your message and send it. On a computer, Enter sends and Shift+Enter
   starts a new line. On a touch screen, Enter starts a new line and the Send
   button sends (so does Ctrl+Enter or ⌘+Enter with a keyboard).

What you will see:

- The answer streams in, with the agent's reasoning and each tool call as a
  row ("Read", "Edit", "Run", …) that you can open.
- When the agent wants to do something the mode does not allow by itself, a
  **permission request** appears: "Claude Code wants to run a command", with
  the command, **Allow**, **Deny** and more. See
  [What an approval shows](agents-and-approvals.md#what-an-approval-shows).
- A small ring in the title bar shows how full the context window is, when the
  agent reports it.

More you can do in the message field:

- **Attach files** — at most 10 files of up to 10 MB each per message.
- **Mention a file** — type `@` and part of a file name.
- **While the agent is working** — **Queue** sends your message as the next
  turn; **Steer** hands it to the agent inside the turn in progress, where the
  agent supports that. **Stop the agent** (Esc on a keyboard) stops the turn.

Runs belong to the server. You can lock the phone, close the tab or switch
devices; the run goes on and the transcript catches up when you return. If the
server restarts while a run is in progress, the run is marked "Interrupted by a
server restart" and nothing is run again by itself: **Continue** sends it
again, **Dismiss without running anything** puts it away. Look at what was
already done before continuing.

## Use it from your phone

1. **Make the server reachable** from the phone. The safe ways are a mesh VPN
   such as Tailscale, a tunnel such as Cloudflare Tunnel, or a reverse proxy
   that terminates TLS. Follow
   [Reaching your Studio from a phone](../deployment/remote-access.md). Keep
   `AGENT_STUDIO_HOST` on loopback and set `AGENT_STUDIO_PUBLIC_ORIGINS` to the
   exact address you will open, for example `https://studio.example.com`.
2. **Open that address** on the phone and sign in.
3. **Install it.** On iPhone or iPad, in Safari: **Share → Add to Home
   Screen**. On Android, in Chrome: the menu's **Install app** or **Add to Home
   screen**. The installed app is called **Agent Studio**.

Use an `https` address with a host name. Over plain `http` (for example a
tailnet IP address) the page works, but the browser gives it no background
worker — so no offline notice and no notifications — and passkeys do not work
there.

On iPhone and iPad, notifications work only in the app added to the Home
Screen, on iOS or iPadOS 16.4 or later. How to switch them on is in
[Memory, automation and notifications](memory-automation-notifications.md#web-push-notifications).

None of this has been tried on a physical iPhone or iPad yet.

## When something goes wrong

[Operations](operations.md#troubleshooting) has a troubleshooting section:
the phone cannot reach the server, writes are refused with "origin not
accepted", passkeys are unavailable, the sandbox is off, an agent shows "not
signed in", Codex refuses to run, the terminal is unavailable.
