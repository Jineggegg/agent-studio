import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PermissionMode } from '@agent-studio/protocol';
import type { BridgeConnection, HistoryMessage, PromptAttachment } from '../agents/adapter.js';
import type { CliFeatures } from './cli.js';

/**
 * How the Studio starts Claude Code for one turn, and what it writes to it.
 *
 * ```
 * claude --print --verbose
 *        --input-format stream-json --output-format stream-json
 *        --include-partial-messages --replay-user-messages [--forward-subagent-text]
 *        --permission-mode plan|manual
 *        --permission-prompt-tool mcp__studio__permission_prompt
 *        --mcp-config <private temporary file> --strict-mcp-config
 *        --setting-sources ""
 *        [--model <alias or id>] [--effort <level>] [--resume <conversation id>]
 *        [--append-system-prompt <shared-memory conventions>] [--add-dir <attachments folder>]…
 * ```
 *
 * - **stream-json both ways.** The prompt goes in on standard input, never on
 *   the command line (which every local user can read); the input stays open,
 *   so a further message can be steered into the running turn and an
 *   interrupt can be sent; images travel as content blocks.
 * - **`--permission-prompt-tool`** routes every permission prompt of the CLI to
 *   the Studio's bridge, where the server's permission engine decides.
 * - **`--permission-mode`** is only ever `plan` or the ordinary asking mode.
 *   The Studio's `ask`, `accept-edits` and `auto` differ in what the *engine*
 *   answers, not in what the CLI asks. Nothing that makes the CLI skip prompts
 *   (`bypassPermissions`, `acceptEdits`, `auto`, `dontAsk`, allow lists) is
 *   ever passed.
 * - **`--setting-sources ""` and `--strict-mcp-config`** switch off the user's,
 *   the project's and the local settings files and every MCP server but the
 *   Studio's. See the module's header for why.
 * - **`--mcp-config`** names a file because the bridge's configuration holds
 *   the run's token, and a command line is visible in the process list.
 * - **`--add-dir`** names the folder of the message's attachments, so that the
 *   CLI may read them without a permission prompt the engine would have to
 *   refuse (they live in the Studio's data directory).
 */

/** Images above this size are handed over as files rather than inline (the model API caps an image at 5 MB encoded). */
export const INLINE_IMAGE_BYTES = 3_500_000;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,199}$/;

/** A model name that is safe to pass as an argument: it cannot be mistaken for an option. */
export function isValidModel(model: string): boolean {
  return MODEL_PATTERN.test(model);
}

/** The Studio's name for "whatever Claude Code picks": no `--model` is passed. */
export const DEFAULT_MODEL = 'default';

export interface InvocationInput {
  readonly features: CliFeatures;
  readonly bridge: BridgeConnection;
  readonly mcpConfigPath: string;
  readonly permissionMode: PermissionMode;
  readonly model: string | null;
  readonly effort: string | null;
  readonly resume: string | null;
  readonly appendSystemPrompt: string | null;
  readonly addDirs: readonly string[];
}

export function buildArgs(input: InvocationInput): string[] {
  const { features, bridge } = input;
  const args = ['--print', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages'];
  if (features.replayUserMessages) args.push('--replay-user-messages');
  if (features.forwardSubagentText) args.push('--forward-subagent-text');
  args.push('--permission-mode', input.permissionMode === 'plan' ? 'plan' : features.askingMode);
  args.push('--permission-prompt-tool', `mcp__${bridge.serverName}__${bridge.permissionPromptTool}`);
  args.push('--mcp-config', input.mcpConfigPath, '--strict-mcp-config');
  args.push('--setting-sources', '');
  if (input.model !== null && input.model !== DEFAULT_MODEL) args.push('--model', input.model);
  if (input.effort !== null && features.efforts.includes(input.effort)) args.push('--effort', input.effort);
  if (input.resume !== null) args.push('--resume', input.resume);
  if (input.appendSystemPrompt !== null && input.appendSystemPrompt.trim() !== '') args.push('--append-system-prompt', input.appendSystemPrompt);
  for (const directory of input.addDirs) args.push('--add-dir', directory);
  return args;
}

/** The MCP configuration that starts the Studio's bridge, exactly as the runtime described it. */
export function buildMcpConfig(bridge: BridgeConnection): string {
  return JSON.stringify({
    mcpServers: {
      [bridge.serverName]: { type: 'stdio', command: bridge.command, args: [...bridge.args], env: { ...bridge.env } },
    },
  });
}

/** The folders that hold a message's attachments. */
export function attachmentDirs(attachments: readonly PromptAttachment[]): string[] {
  return [...new Set(attachments.map((attachment) => path.dirname(attachment.path)))];
}

const HISTORY_MESSAGES = 40;
const HISTORY_MESSAGE_CHARS = 4_000;
const HISTORY_CHARS = 60_000;

/**
 * The earlier conversation as text, for a turn that has to start a new
 * conversation of the CLI's because the old one cannot be resumed.
 */
export function historyPreamble(history: readonly HistoryMessage[]): string {
  const recent = history.slice(-HISTORY_MESSAGES);
  const parts: string[] = [];
  let used = 0;
  for (let at = recent.length - 1; at >= 0; at -= 1) {
    const message = recent[at]!;
    const body = message.text.length > HISTORY_MESSAGE_CHARS ? `${message.text.slice(0, HISTORY_MESSAGE_CHARS)}…` : message.text;
    const part = `${message.role === 'user' ? 'User' : 'Assistant'}: ${body}`;
    if (used + part.length > HISTORY_CHARS) break;
    used += part.length;
    parts.unshift(part);
  }
  if (parts.length === 0) return '';
  return [
    'The conversation so far (the earlier session could not be reopened, so it is repeated here as text for context; do not answer it again):',
    '',
    parts.join('\n\n'),
    '',
    'End of the earlier conversation. The new message follows.',
    '',
    '',
  ].join('\n');
}

export interface UserMessageInput {
  readonly text: string;
  /** Text the user quoted from an earlier message. */
  readonly quote?: string | null;
  readonly attachments: readonly PromptAttachment[];
  /** Put in front of everything (the earlier conversation, when it has to be repeated). */
  readonly preamble?: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * One message in the shape `--input-format stream-json` reads: a user message
 * of the model API. Raster images go inline; every attachment is also named
 * with its path, so the agent can open a file with its own tools.
 */
export async function buildUserMessage(input: UserMessageInput): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  if (input.preamble) lines.push(input.preamble);
  if (input.quote && input.quote.trim() !== '') {
    lines.push(input.quote.split('\n').map((line) => `> ${line}`).join('\n'), '');
  }
  lines.push(input.text);

  const images: ContentBlock[] = [];
  const listed: string[] = [];
  for (const attachment of input.attachments) {
    let inline = false;
    if (attachment.isImage && attachment.size <= INLINE_IMAGE_BYTES) {
      try {
        const data = await readFile(attachment.path);
        images.push({ type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: data.toString('base64') } });
        inline = true;
      } catch {
        /* unreadable here: it is still listed by path below */
      }
    }
    // A name is chosen by the user: keep it on one line so it cannot pose as instructions.
    const name = attachment.name.replace(/[\r\n]+/g, ' ').slice(0, 200);
    listed.push(`- ${name} (${attachment.mediaType}, ${attachment.size} bytes${inline ? ', shown above as an image' : ''}): ${attachment.path}`);
  }
  if (listed.length > 0) lines.push('', 'Files attached to this message (read them from these paths):', ...listed);

  const content: ContentBlock[] = [...images, { type: 'text', text: lines.join('\n') }];
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null };
}
