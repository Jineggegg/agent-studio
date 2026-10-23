# Guides

Task-oriented guides for people who install, use and run Cloud Harness.
Start with the first one; the others can be read in any order.

Prefer a visual introduction? Start with the **[screenshot tour](showcase.md)**
or **[中文截图导览](showcase.zh-CN.md)** for the workspace, multiple models,
shared memory, agent handoffs, tools, mail and your own domain.

## Using the Studio

| Guide                                                                      | What it covers                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Getting started](getting-started.md)                                      | Installing, the first run and the setup token, creating the owner account, connecting Claude Code, Codex and API model providers, adding a project, the first conversation, installing the app on a phone.                                                                     |
| [Agents and approvals](agents-and-approvals.md)                            | How every agent request is decided; the permission modes and what each allows for Claude Code, Codex and API models; approvals, "allow and remember", dangerous requests, plans; unattended runs; the per-project switches; what the sandbox does and does not do; the limits. |
| [Working on projects](working-on-projects.md)                              | Files and the editor, the Git panel and its messages, worktrees, GitHub, the terminal, remote machines and their hosts file, sharing a project with members.                                                                                                                   |
| [Memory, automation and notifications](memory-automation-notifications.md) | Shared memory, automations and their schedules, sending messages later, the inbox, Web Push and the lock screen, handing a conversation to another agent and multi-agent tasks, usage figures and plan windows.                                                                |

## Running the Studio

| Guide                                                               | What it covers                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Operations](operations.md)                                         | Running it as a service, upgrades, backups and restoring, the operator commands, logs, health checks, the security log, the warnings on the About page, troubleshooting. |
| [Configuration](../configuration.md)                                | Every `AGENT_STUDIO_*` environment variable, what agents inherit, backups in brief.                                                                                      |
| [Reaching your Studio from a phone](../deployment/remote-access.md) | Tailscale, Cloudflare Tunnel, a reverse proxy, SSH forwarding, HTTPS without a proxy, a systemd unit.                                                                    |
| [Security](../../SECURITY.md)                                       | The trust model, what protects you and what does not, the hardening checklist, reporting a vulnerability.                                                                |

## Extending and checking it

| Guide                                                          | What it covers                                                                                       |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Writing plugins](writing-plugins.md)                          | Plugins: the manifest, permissions, isolation, the SDK, hooks, panels, installing.                   |
| [Smoke tests against the real agent CLIs](agent-smoke-test.md) | How the Claude Code and Codex adapters are checked against the real programs, and what was observed. |

For how the system is put together, see the
[architecture](../architecture/ARCHITECTURE.md) and the
[decision records](../adr). What is finished and what is not is kept in
[docs/STATUS.md](../STATUS.md).

## Cloud Harness additions

- [Conversations](conversations.md): groups, branches, account profiles, imports and checkpoints.
- [Browser, images and voice](browser-and-media.md): isolated browsing, annotation and dictation.
- [Model providers](providers.md): native Anthropic and OpenAI-compatible protocols.
- [Tools and skills](tools-and-skills.md): scoped skills, slash commands and MCP.
- [Mail and notification channels](mail-and-channels.md): personal OAuth setup, reviewed sending and local summaries.
- [Static project apps](project-apps.md): reviewed builds and isolated previews.
- [Windows companion](../../companion/windows/README.md): pairing and local confirmation.
- [Desktop wrapper](../../desktop/README.md): packaging, permissions and platform checks.
