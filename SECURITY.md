# Security

Agent Cloud Studio lets AI agents run commands on your machine and lets you
reach that from a phone. That is a serious thing to put on a network, and this
document says plainly what protects you, what does not, and how to tell us when
we got something wrong.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
private reporting instead: on the repository page choose **Security → Report a
vulnerability**. Include what you did, what happened and what you expected; a
proof of concept helps. You will get an acknowledgement within a few days. Once
a fix is released the advisory is published and you are credited unless you ask
not to be.

This is a volunteer-maintained project without a bounty programme.

## Supported versions

Security fixes go into the latest release only.

## The trust model

- **The owner** is the person who runs the server. They are trusted completely:
  the server acts with the operating-system permissions of the account it runs
  under, and the terminal is literally the owner's shell.
- **Members** are collaborators the owner invites. They can use only the
  projects shared with them and cannot reach the terminal, people, providers,
  plugins or remote hosts. But an agent a member runs still executes as the
  service account. The role limits the API, not the operating system: do not
  give a member account to someone you would not let run code on the machine.
- **Agents** are not trusted. Every side effect an agent asks for goes through
  one permission engine on the server, and anything risky waits for a human.
- **Plugins** are not trusted. They run in separate sandboxed processes and can
  do only what the owner granted.
- **Everything from the network** is hostile until authenticated: the only
  things an anonymous visitor can obtain are the client's static files, a bare
  health answer, whether setup is needed, and the sign-in routes.

## What protects you

**The front door**
- Loopback by default; remote access is expected to go through a tunnel, mesh
  VPN or reverse proxy that terminates TLS (`docs/deployment/remote-access.md`).
- The `Host` header must be loopback or a configured origin (defeats DNS
  rebinding).
- First-run setup needs a one-time token printed on the server's console.
- Passwords: scrypt, twelve characters minimum, per-account lockout with
  doubling waits that survive restarts; attempts are counted before the
  password is compared. Passkeys (WebAuthn) with user verification required.
- Sessions are random server-side tokens in an `HttpOnly`, `SameSite=Strict`
  cookie (`__Host-` and `Secure` over HTTPS). State-changing requests and
  WebSocket handshakes must come from the same origin and carry an
  anti-forgery token. Credentials are never accepted in URLs. There is no CORS.
- Sensitive changes (new API token, new passkey, provider keys, people,
  plugins, opening a terminal) require that you proved your identity in the
  last fifteen minutes.
- Every `/api` route declares who may call it, and the server refuses to start
  if one does not. Access control follows the route the router matched, not
  the spelling of the URL.
- A strict content security policy (`script-src 'self'`), no raw HTML
  rendering in the client, and frames are refused.

**Agents**
- One permission engine for every agent: modes (plan, ask, accept-edits,
  auto), allow/deny/ask rules, and a risk classifier. Destructive commands,
  privilege escalation, writes outside the project, credential locations and
  download-and-run pipelines are asked about even when a broad rule would
  allow them; the Studio's own data is off limits in every mode. `auto` has to
  be switched on per project by the owner.
- Approvals are durable, expire, and can be answered from any of your devices;
  unattended (scheduled) runs are denied rather than left waiting.
- Agent processes get an allow-listed environment — nothing the server was
  configured with, no API keys from its environment.
- On Linux with bubblewrap, agent processes cannot see the Studio's data
  directory at all, and commands run by API models are confined to the project
  directory with credentials hidden and the network off unless you allow it.
- Agent CLIs keep their own sign-in. The Studio never reads or forwards their
  credentials and uses only their documented interfaces.

**Your data**
- The data directory is owner-only. Stored credentials (model API keys, push
  keys) are encrypted with AES-256-GCM and are never returned by the API.
- File, Git and download APIs are confined to the project directory after
  following symbolic links, for reads as well as writes. The file tools of API
  models, whose commands can change the project while a tool runs, go further
  on Linux: they open files through descriptors and check where those really
  are, so swapping a directory for a link mid-call leads nowhere. Elsewhere
  only the last step of a path is protected that way.
- External programs (`git`, `gh`, `ssh`) are run without a shell, with
  client-supplied values validated and placed after `--`.
- Outbound requests to addresses that come from configuration or users (model
  endpoints, push services, project links) are checked after DNS resolution,
  never follow redirects and cannot reach private addresses unless the owner
  allows it for that one endpoint; link-local addresses are never reachable.
- Memory notes are handed to models as clearly delimited reference material;
  notes that look like they contain a credential are withheld from models.
- Logs and the security log carry no secrets, query strings or full client
  addresses.

**The supply chain**
- Dependency install scripts are disabled; the lockfile may only reference the
  public registry with integrity hashes; CI audits dependencies and licences
  and scans every commit for secrets.
- CI runs only on GitHub-hosted runners with a read-only token and no secrets,
  so a pull request from a fork cannot reach anything.

## What does not protect you — read this

- **An approved command is a command.** If you allow `rm -rf build`, it runs.
  The sandbox for CLI agents hides the Studio's own data; it does not stop an
  approved command from changing other files the service account can write.
- **Without bubblewrap there is no sandbox** (macOS, Windows, or Linux with
  unprivileged user namespaces disabled). The permission engine still applies,
  and the app tells you the sandbox is off, but a command you approve can then
  read anything the service account can — including the Studio's key file.
- **The risk classifier is a heuristic.** It parses shell commands
  conservatively and asks when unsure, but a sufficiently obfuscated command
  might be classified as ordinary. In `ask` mode that still means it asks; in
  `auto` mode it would run. Keep `auto` for projects you would let the agent
  loose in anyway.
- **Prompt injection is real.** A web page, a file in a repository or a memory
  note can contain text that tries to steer an agent. Approvals and the sandbox
  limit what a steered agent can do; nothing can stop it from *asking*.
- **The terminal is your shell.** Anyone who gets an owner session that
  authenticated recently has the machine. Use a passkey, keep the service off
  the open internet where you can (a mesh VPN is ideal), and put an
  identity-aware proxy in front if you must expose it publicly.
- **Members are not isolated from each other at the OS level** (see the trust
  model).
- **Plugins without bubblewrap** are restricted only by Node's permission
  model, which does not cover network access; the app says so and refuses to
  treat such a plugin's tools as read-only.
- This project has had an AI-assisted security review by a reviewer that had
  not written the code (no critical, high or medium findings; the two low ones
  are fixed) and an adversarial test suite, but **no independent professional
  audit**.

## Hardening checklist for operators

1. Run the service as an ordinary, unprivileged account — never root.
2. Keep `AGENT_STUDIO_HOST` on loopback; publish through Tailscale or a
   tunnel; set `AGENT_STUDIO_PUBLIC_ORIGINS` to exactly the address you use.
3. On Linux, install bubblewrap and check **Settings → About** says the
   sandbox is on.
4. Register a passkey and use a long, unique password.
5. Leave projects in `ask` mode unless you have a reason not to.
6. Give `AGENT_STUDIO_WORKSPACE_ROOTS` the narrowest directory that contains
   your projects.
7. Supply `AGENT_STUDIO_MASTER_KEY` from a secret manager if backups of the
   data directory leave the machine.
8. Review the recent security events under **Settings → Account & security** now and then.
