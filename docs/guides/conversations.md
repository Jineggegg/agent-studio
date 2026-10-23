# Conversations and CLI accounts

Conversation groups belong to each user. Create groups from the session list, assign a conversation from its settings, and filter the list by group. Removing a group leaves its conversations intact.

**Fork** copies a complete conversation. **Fork here** copies through a committed user or assistant message. **Edit and resend** creates a new branch ending before that user message and sends the replacement there. All later work uses a new native provider conversation; the original transcript is unchanged. Attachments get separate stored copies. Workspace files remain shared, and a branch does not restore files. Active conversations must finish before branching. Large histories over 20,000 events cannot be branched in one operation.

## Isolated CLI sign-ins

In Settings → CLI accounts, create an account profile and sign in with the provider's own terminal command. Each profile starts with an empty private configuration directory. Cloud Harness neither copies credentials from another account nor returns credential files through its API. Select a profile as the default for **new** sessions. Existing sessions retain their original account binding, including when resumed or branched. Deleting a Cloud Harness account stops its agent runs and login terminals before erasing its isolated profile directories. Startup also removes orphaned profile directories left by interrupted cleanup. Profiles are not an API-key management interface.

Claude uses `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME` and `CODEX_SQLITE_HOME`. When sandboxing is active, only the chosen server-generated profile directory is exposed writable; sibling profiles stay masked. The host account remains the default until a profile is selected. CLI account access can expire or be restricted independently of model availability.

## Fast mode and tool status

Conversation settings show the provider's advertised fast-mode support and refuse unavailable combinations. Claude requires noninteractive `--settings` support and version 2.1.205 or later, plus a supported Opus model and eligible account. Codex fast mode is available only when its model catalogue explicitly advertises the `fast` service tier for the selected model. These checks establish protocol/model support, not an entitlement or billing guarantee. Provider errors remain visible. Turning fast mode off is sent explicitly where supported. Context usage keeps using the provider-reported context ring.

The managed MCP bridge is shown as configured, rather than claiming a live connection when no run exists. A provider connection is created for each run. Additional managed tools are configured through the Tools settings.

## File checkpoints

Checkpoints cover existing UTF-8 files, at most 256 KiB each and 20 files per run, captured before an approved edit tool with explicit paths. They do not cover shell commands, new or removed files, binaries, unknown edit paths, or credential paths. Recognizable secret-bearing content is excluded as a whole from capture and preview; checkpoint restore never writes a redacted approximation. Preview a checkpoint from its message action, compare captured and current content, then explicitly confirm restore. A stale file version is refused. Restores use a checked parent directory and an atomic temporary-file rename; they do not rewind the transcript or claim a workspace rollback.

## External CLI history

An instance owner can explicitly configure transcript roots from the session list's Import action. No home directory is scanned automatically. Roots must be absolute canonical directories outside Cloud Harness's own data; symlinks and escapes are refused. Discovery examines at most 2,000 directory entries, 200 conversations, six directory levels, and 2 MiB per JSONL file. Metadata is bounded and contains no native provider IDs. Hidden entries, unsupported files and oversized transcripts are skipped.

Select a project and import a transcript to create a conversation owned by the importing user. Only supported user/assistant prose is copied from Claude Code or Codex JSONL. System prompts, tool invocations, approvals and native resume state are excluded. Original files are never changed. A changed source requires refreshing metadata; importing the same source version into the same project returns the existing copy. Discovery and import are owner-only because they read explicitly configured host directories.

Public integration references: [Claude Code fast mode](https://code.claude.com/docs/en/fast-mode), [Codex app-server](https://developers.openai.com/codex/app-server). CLI capability detection also uses the installed CLI help and generated public protocol schemas.
