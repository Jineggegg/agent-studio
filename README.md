# Cloud Harness

**Your self-hosted workspace for AI agents, projects and everyday tools — on phone, tablet and desktop.**

Cloud Harness runs on your own machine — a workstation, a home server, a
VPS — next to the agent CLIs you already use, and gives you one touch-first web
app to drive them from an iPhone, an iPad or a desktop browser. The agents work
on _your_ files with _your_ sign-ins; your phone only ever talks to your server.

```
phone / tablet / laptop ──HTTPS──▶ your server (Cloud Harness) ──▶ Claude Code CLI · Codex CLI · model APIs
```

[简体中文](README.zh-CN.md) · [Guides](docs/guides/README.md) · [Architecture](docs/architecture/ARCHITECTURE.md) · [Security](SECURITY.md) · [Status](docs/STATUS.md)

> **Status: beta.** The server, its security model and its test suites are the
> most mature parts. The client has been verified in desktop and emulated
> phone/tablet browsers, not yet on physical devices. Read
> [what is and is not finished](docs/STATUS.md) before relying on it.

## What it does

**Work with agents**

- Chat with **Claude Code** and **Codex** through their official CLIs (using
  the sign-in you already have), with **Anthropic’s native Messages API**, and with **OpenAI-compatible API models**
  (DeepSeek, OpenAI, a model server on your own machine) using a key you store
  encrypted on the server.
- Live streaming of text, reasoning, tool calls and diffs. Runs belong to the
  server: lock your phone, lose signal, switch devices — the run carries on and
  the transcript catches up exactly where it left off.
- **You stay in control.** Every side effect an agent asks for passes through
  one permission engine. Risky actions wait for your approval — the inbox and a
  push notification point you to them — and you answer in the conversation,
  from any of your devices.
- Queue messages while an agent is busy, steer a running turn, stop it, and
  continue a run that a restart interrupted.
- Use several agents on the same project, hand a conversation from one model to
  another with a summary, and see token usage and cost per session.

- Organise conversations into groups, branch from a message, edit a prompt into a
  new branch, and select isolated CLI account profiles. Inspect context usage,
  supported speed options and real text-file checkpoints before restoring them.
- Annotate attached images, dictate a draft, listen to an answer and follow
  background work. Import external CLI conversations only from roots you enable.

**Work on projects**

- Projects are folders on your server. Browse and edit files, review diffs,
  stage, commit, branch, push and pull, work in Git worktrees.
- See pull requests and CI status and merge with safeguards, through the GitHub
  CLI sign-in already on your server.
- A real terminal in the project directory that keeps running when you put the
  phone down, and terminals on other machines you have configured over SSH.

**Remember and automate**

- **Shared memory**: Markdown notes — per project and global — that every agent
  can search and write through the same tools, and that you can read, edit and
  delete. An agent sees only its own project's notes and the global ones.
- **Automations**: schedules that notify you or start an agent run unattended
  (what would need approval is denied and reported, never silently done).
- **Inbox and Web Push**: what needs you, what failed, what finished.

- Optional **mail** connects your Gmail or Outlook account for folders, search,
  reading, attachments, encrypted drafts and explicitly confirmed sending.
  Summary generation requires consent and a configured local model.
- Add SMTP or Bark notifications and let agents propose reminders for approval.

**Tools around the conversation**

- Manage project-scoped **skills, slash commands and MCP connections**. External
  MCP calls use the same tool approval flow as other agent actions.
- Build and preview **static project apps** in an isolated frame. An optional
  agent browser runs behind a sandbox and guarded network transport.
- Pair your own Windows device for reviewed screenshot, click and typing actions.
  No device, account or external service is preconfigured.

**Built for touch**

- An installable PWA with phone, tablet and desktop layouts, light and dark
  themes, English and Simplified Chinese. An optional [desktop wrapper](desktop/README.md)
  connects to your existing installation.

**Extend it**

- A plugin system for your own tools: plugins run in sandboxed processes with
  only the permissions you grant, and their UI is isolated from your session.
- New agents plug in through one adapter interface.

## Quick start

On Linux (or WSL on Windows) or macOS, as the user who will run it:

```bash
curl -fsSL https://raw.githubusercontent.com/Jineggegg/cloud-harness/main/packaging/install.sh | bash
```

The installer downloads the newest release and a private copy of Node.js,
checks both against their published SHA-256 sums, starts the Studio as a
background service for your user (systemd or launchd) and prints the address
and a **one-time setup token**. It never needs root, except — if you agree — to
install `bubblewrap`, which gives agents a sandbox on Linux. Options:
`… | bash -s -- --help`. Manage it afterwards with
`cloud-harness service status|restart|logs`; settings live in
`~/.config/agent-studio/env`, data in `~/.agent-studio`. The earlier
`agent-studio` command and `AGENT_STUDIO_*` settings remain supported.
The package namespace is retained for compatibility; the product is Cloud Harness.

macOS works but is less tested than Linux and has no sandbox (see
[SECURITY.md](SECURITY.md)); Codex then refuses to run unless you allow it.

<details>
<summary>From source instead</summary>

You need Node.js **22.13 or newer** and git. No compiler is required.

```bash
git clone https://github.com/Jineggegg/cloud-harness.git
cd cloud-harness
npm ci
npm run build
npm start
```

</details>

Open `http://127.0.0.1:7420` on the same machine, enter the setup token and
create the owner account. Then:

1. **Connect an agent.** Install and sign in to the CLIs you want — the app
   shows which ones it found and offers a terminal for their sign-in:
   - Claude Code: <https://docs.claude.com/en/docs/claude-code>
   - Codex: <https://developers.openai.com/codex/cli>
   - or add an API provider and key under **Settings → Models**.
2. **Add a project** — any folder inside your home directory.
3. **Start a conversation.**

To reach it from your phone, see
[Reaching your Studio from a phone](docs/deployment/remote-access.md)
(Tailscale, Cloudflare Tunnel, a reverse proxy, or plain SSH forwarding), then
choose _Add to Home Screen_.

Everything is configured through `AGENT_STUDIO_*` environment variables; none
is required. See [Configuration](docs/configuration.md).

## Security in one minute

An app that lets agents run commands and is reachable from a phone has to be
honest about its security. The short version:

- Loopback by default; one-time setup token; scrypt passwords with lockout;
  passkeys; server-side sessions in `HttpOnly` cookies with same-origin and
  anti-forgery checks; every API route declares who may call it.
- Agents are not trusted: one server-side permission engine, human approval for
  risky actions, an allow-listed environment, and — on Linux with bubblewrap —
  a sandbox that hides the Studio's own data from agent processes and confines
  API-model commands to the project.
- Secrets are encrypted at rest and never returned by the API.
- **Limits you should know:** an approved command really runs; without
  bubblewrap there is no sandbox; the terminal is your own shell; there has
  been no independent audit.

[SECURITY.md](SECURITY.md) has the full trust model, the limits and a hardening
checklist. Please report vulnerabilities privately as described there.

## How it is built

TypeScript throughout: a Node.js server (Fastify, the SQLite engine built into
Node), a React client (Vite), and a shared protocol package of zod schemas.
The security-critical code is concentrated in a small kernel
(`apps/server/src/kernel`); features are modules on top of it. Details and the
reasoning behind the main decisions are in
[ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) and the
[decision records](docs/adr).

```bash
npm run dev                 # server with reload + client with hot reload
npm run typecheck && npm run lint
npm run test:unit
npm run test:integration
npm run test:acceptance     # black-box, against the built server
npm run test:e2e            # browsers at phone, tablet and desktop sizes
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Where it came from, and what "independent" means here

The idea comes from a private system built on top of CloudCLI UI, which is
AGPL-licensed. This project is implemented from
behavioural requirement documents ([docs/requirements](docs/requirements)), with
its own architecture, data model, protocol and design, and a mechanical
comparison of the two code bases is part of the release checklist.

It was built with heavy AI assistance: AI agents wrote the requirement
documents and the code under the direction of an orchestrating agent and the
project owner. The separation between "those who read the old system" and
"those who wrote the new one" was enforced by instruction, not by operating
system isolation, so this is **not** claimed to be a strict clean-room
implementation. [docs/clean-room/PROCESS.md](docs/clean-room/PROCESS.md)
describes exactly what was done and where it fell short.

Cloud Harness is not affiliated with Anthropic, OpenAI, DeepSeek, GitHub
or CloudCLI. Claude Code, Codex and the other names belong to their owners; you
need your own accounts and must follow each provider's terms.

## Licence

[MIT](LICENSE). Third-party dependencies and their licences are listed in
[docs/licenses/THIRD_PARTY_LICENSES.md](docs/licenses/THIRD_PARTY_LICENSES.md).
