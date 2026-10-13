# Configuration

The server is configured only through environment variables that start with
`AGENT_STUDIO_`. Generic names such as `PORT`, `HOST` or `NODE_ENV` are ignored
on purpose, so starting the Studio from a shell that belongs to another service
can never make it pick up that service's settings.

Nothing is required: with no variables set, the server listens on
`http://127.0.0.1:7420` and keeps its data in `~/.agent-studio`.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_STUDIO_HOST` | `127.0.0.1` | Interface to listen on. Keep it on loopback and put a tunnel or TLS-terminating proxy in front for remote access. |
| `AGENT_STUDIO_PORT` | `7420` | Port to listen on. |
| `AGENT_STUDIO_DATA_DIR` | `~/.agent-studio` | Database, encryption key, memory notes, attachments. Created with owner-only permissions. |
| `AGENT_STUDIO_PUBLIC_ORIGINS` | *(empty)* | Comma-separated origins the Studio is reached at besides loopback, e.g. `https://studio.example.com`. A request whose `Host` is not loopback and not listed here is refused. |
| `AGENT_STUDIO_TRUST_PROXY` | `off` | Trust `X-Forwarded-For` from a proxy on the loopback interface, so rate limits and the security log see the real client address. |
| `AGENT_STUDIO_WORKSPACE_ROOTS` | your home directory | Comma-separated directories under which project folders must live. |
| `AGENT_STUDIO_TLS_CERT`, `AGENT_STUDIO_TLS_KEY` | *(none)* | PEM files; when both are set the server speaks HTTPS itself. |
| `AGENT_STUDIO_SANDBOX` | `auto` | `auto`: sandbox agent processes with bubblewrap when it works. `bwrap`: refuse to start without it. `off`: never sandbox. |
| `AGENT_STUDIO_TERMINAL` | `on` | Set to `off` to remove the terminal feature entirely. |
| `AGENT_STUDIO_CHILD_ENV_PASSTHROUGH` | *(empty)* | Names of extra environment variables that agent and terminal processes may inherit (for example `SSH_AUTH_SOCK`). Variables named `AGENT_STUDIO_*` can never be listed. |
| `AGENT_STUDIO_MASTER_KEY` | *(a file in the data directory)* | 32 random bytes in base64 (`openssl rand -base64 32`). Protects stored credentials. Supply it from a secret manager to keep it apart from the data. |
| `AGENT_STUDIO_SETUP_TOKEN` | *(generated)* | Fixed first-run token for scripted installs (at least 16 characters). |
| `AGENT_STUDIO_SESSION_IDLE_DAYS` | `30` | A browser session unused for this long ends. |
| `AGENT_STUDIO_SESSION_MAX_DAYS` | `90` | A browser session ends after this long regardless of use. |
| `AGENT_STUDIO_REMOTE_HOSTS_FILE` | `<data dir>/remote-hosts.json` | Operator-managed list of SSH hosts that projects may use. |
| `AGENT_STUDIO_PLUGIN_SOURCE_DIR` | *(none)* | A directory on the server from which the owner may install plugins by name. Plugins can also be installed from an https Git address. |
| `AGENT_STUDIO_PLUGINS_UNSANDBOXED` | `off` | Allow plugins with server-side code to run when no sandbox is available at all. Leave off unless you wrote the plugin yourself. |
| `AGENT_STUDIO_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `AGENT_STUDIO_WEB_DIR` | the bundled client | Directory of a built web client to serve; empty string serves the API only. |
| `AGENT_STUDIO_ENV` | `production` | `development` or `test` relax nothing security-relevant; they only change logging and rate-limit ceilings for tests. |

## What the agents inherit

Agent CLIs, terminals and Git commands start with a small allow-listed
environment: `PATH`, `HOME`, locale, proxy and certificate variables, and the
XDG directories. API keys present in the server's environment are **not**
passed on. An agent CLI therefore uses its own sign-in (`claude` and `codex`
keep their credentials in your home directory); keys for API models are entered
in the app and stored encrypted.

## Operator commands

```
agent-studio status                     # is it answering, and where is its data
agent-studio setup-token                # the one-time token for creating the first account
agent-studio reset-password <username>  # new password; signs the account out everywhere
agent-studio unlock                     # clear sign-in locks
agent-studio version
```

These act on the data directory directly, so they work while the service is
stopped — and only for someone who already has a shell on the host.

## Backup and moving to another machine

Stop the service, then copy the whole data directory. It contains:

- `studio.db` (plus `-wal`/`-shm` files if the service was not stopped cleanly),
- `master.key` — without it the stored credentials cannot be decrypted (not
  present if you supply `AGENT_STUDIO_MASTER_KEY`; then back up that value),
- `memory/` — your notes, as plain Markdown,
- `attachments/`.

Treat a backup like a password manager export. On the new machine keep the
directory permissions at `700`.
