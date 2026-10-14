// The Claude Code stand-in (see ../bin/claude for what it is and the list of scenarios).
// Output shapes follow captures of Claude Code 2.1.283; fields no client reads are left out.
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

export const VERSION = '2.1.283-standin';

const HELP = `Usage: claude [options] [command] [prompt]

Claude Code stand-in for tests - speaks the stream-json protocol of the real
program and never contacts a model

Arguments:
  prompt                                Your prompt

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --append-system-prompt <prompt>       Append a system prompt to the default
                                        system prompt
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --forward-subagent-text               Forward subagent text and thinking
                                        blocks as assistant/user messages with
                                        parent_tool_use_id set
  -h, --help                            Display help for command
  --include-partial-messages            Include partial message chunks as they
                                        arrive
  --input-format <format>               Input format (only works with --print):
                                        "text" (default), or "stream-json"
  --mcp-config <configs...>             Load MCP servers from JSON files or
                                        strings (space-separated)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -p, --print                           Print response and exit (useful for
                                        pipes)
  --replay-user-messages                Re-emit user messages from stdin back on
                                        stdout for acknowledgment
  -r, --resume [value]                  Resume a conversation by session ID
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --settings <file-or-json>             Path to a settings JSON file or a JSON
                                        string to load additional settings from
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --verbose                             Override verbose mode setting from
                                        config
  -v, --version                         Output the version number

Commands:
  auth                                  Manage authentication
`;

const VALUE_FLAGS = new Set([
  '--add-dir',
  '--append-system-prompt',
  '--effort',
  '--input-format',
  '--mcp-config',
  '--model',
  '--output-format',
  '--permission-mode',
  '--permission-prompt-tool',
  '--resume',
  '-r',
  '--session-id',
  '--setting-sources',
  '--settings',
]);
const BOOLEAN_FLAGS = new Set(['-p', '--print', '--verbose', '--include-partial-messages', '--replay-user-messages', '--forward-subagent-text', '--strict-mcp-config']);
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ALIASES = { default: 'claude-opus-standin', fable: 'claude-fable-standin', opus: 'claude-opus-standin', sonnet: 'claude-sonnet-standin', haiku: 'claude-haiku-standin' };
const BUILT_IN_TOOLS = ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Read', 'TaskCreate', 'TaskUpdate', 'ToolSearch', 'WebFetch', 'Write'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_ONLY_COMMAND = /^(pwd|ls( [^>|;&`$]*)?|cat [^>|;&`$]+|echo [^>|;&`$]*)$/;

const uuid = () => crypto.randomUUID();
const out = (text) => process.stdout.write(text);
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const drained = () => new Promise((resolve) => process.stdout.write('', () => resolve()));

async function quit(code) {
  await drained();
  process.exit(code);
}

/** Where conversations, the sign-in marker and the record of invocations are kept. */
export function stateDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const key = crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 16);
  const directory = path.join(os.tmpdir(), `claude-standin-${uid}`, key);
  fs.mkdirSync(path.join(directory, 'sessions'), { recursive: true, mode: 0o700 });
  return directory;
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (VALUE_FLAGS.has(arg)) {
      if (at + 1 >= argv.length) fail(`error: option '${arg}' argument missing`);
      const name = arg === '-r' ? '--resume' : arg;
      values.set(name, [...(values.get(name) ?? []), argv[(at += 1)]]);
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(arg === '-p' ? '--print' : arg);
    } else if (arg.startsWith('-')) {
      fail(`error: unknown option '${arg}'`);
    } else {
      positional.push(arg);
    }
  }
  return { values, flags, positional, one: (name) => values.get(name)?.at(-1) };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function auth(argv) {
  const marker = path.join(stateDir(), 'signed-out');
  const signedOut = fs.existsSync(marker);
  if (argv[0] === 'login') {
    fs.rmSync(marker, { force: true });
    out('Signed in to the Claude Code stand-in.\n');
    return;
  }
  if (argv[0] === 'logout') {
    fs.writeFileSync(marker, '');
    out('Signed out of the Claude Code stand-in.\n');
    return;
  }
  if (argv[0] !== 'status') fail(`error: unknown command '${argv[0] ?? ''}'`);
  const home = path.join(os.homedir(), '.claude');
  if (argv.includes('--text')) {
    out(signedOut ? 'Not logged in. Run claude auth login to authenticate.\n' : 'Logged in as standin@example.test\n');
  } else {
    const common = { apiProvider: 'firstParty', analyticsDisabled: false, projectsDirectory: path.join(home, 'projects'), configDirectory: home };
    const answer = signedOut
      ? { loggedIn: false, authMethod: 'none', ...common }
      : { loggedIn: true, authMethod: 'claude.ai', ...common, email: 'standin@example.test', orgId: '00000000-0000-4000-8000-000000000000', orgName: 'Stand-in organisation', subscriptionType: 'max' };
    out(`${JSON.stringify(answer, null, 2)}\n`);
  }
  await quit(signedOut ? 1 : 0);
}

/** Connects to the MCP servers of --mcp-config as a real client. */
async function connectMcp(options) {
  const servers = [];
  for (const source of options.values.get('--mcp-config') ?? []) {
    const text = source.trim().startsWith('{') ? source : fs.readFileSync(source, 'utf8');
    for (const [name, spec] of Object.entries(JSON.parse(text).mcpServers ?? {})) servers.push({ name, spec, client: null, tools: [], status: 'failed' });
  }
  if (servers.length > 0) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    for (const server of servers) {
      try {
        const transport = new StdioClientTransport({
          command: server.spec.command,
          args: server.spec.args ?? [],
          env: { ...process.env, ...(server.spec.env ?? {}) },
          stderr: 'ignore',
        });
        const client = new Client({ name: 'claude-code-standin', version: VERSION }, { capabilities: {} });
        await client.connect(transport);
        server.tools = (await client.listTools()).tools.map((tool) => tool.name);
        server.client = client;
        server.status = 'connected';
      } catch {
        server.status = 'failed';
      }
    }
  }
  return {
    servers,
    has: (qualified) => servers.some((server) => server.tools.some((tool) => `mcp__${server.name}__${tool}` === qualified)),
    async call(qualified, args, toolUseId) {
      const server = servers.find((candidate) => qualified.startsWith(`mcp__${candidate.name}__`));
      if (!server?.client) throw new Error(`MCP server for ${qualified} is not connected`);
      const name = qualified.slice(`mcp__${server.name}__`.length);
      // No timeout to speak of: a permission prompt may wait for a person.
      return server.client.callTool({ name, arguments: args, ...(toolUseId ? { _meta: { 'claudecode/toolUseId': toolUseId } } : {}) }, undefined, { timeout: 86_400_000 });
    },
    async close() {
      await Promise.all(servers.map((server) => server.client?.close().catch(() => {})));
    },
  };
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : (content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

/** [[scenario:name arguments]] markers, in order. */
function scenariosOf(text) {
  return [...text.matchAll(/\[\[scenario:([a-z-]+)(?:\s+([^\]]*))?\]\]/g)].map((match) => ({ name: match[1], args: (match[2] ?? '').trim() }));
}

export async function main(argv) {
  if (argv[0] === 'auth') return auth(argv.slice(1));
  if (argv.includes('--version') || argv.includes('-v')) return void out(`${VERSION} (Claude Code)\n`);
  if (argv.includes('--help') || argv.includes('-h')) return void out(HELP);
  const options = parseArgs(argv);
  const mode = options.one('--permission-mode');
  if (mode !== undefined && mode !== 'default' && !PERMISSION_MODES.includes(mode)) {
    fail(`error: option '--permission-mode <mode>' argument '${mode}' is invalid. Allowed choices are ${PERMISSION_MODES.join(', ')}.`);
  }
  if (!options.flags.has('--print')) fail('The Claude Code stand-in only runs non-interactively: pass -p.');
  if (options.one('--output-format') !== 'stream-json') fail('The Claude Code stand-in only prints --output-format stream-json.');
  if (!options.flags.has('--verbose')) fail('Error: When using --print, --output-format=stream-json requires --verbose');
  const effort = options.one('--effort');
  if (effort !== undefined && !EFFORTS.includes(effort)) {
    process.stderr.write(`Warning: Unknown --effort value '${effort}' — ignoring it and using the default effort. Valid values: ${EFFORTS.join(', ')}.\n`);
  }
  await converse(options);
}

async function converse(options) {
  const state = stateDir();
  const cwd = process.cwd();
  const partial = options.flags.has('--include-partial-messages');
  const replay = options.flags.has('--replay-user-messages');
  const addDirs = (options.values.get('--add-dir') ?? []).map((directory) => path.resolve(directory));
  const promptTool = options.one('--permission-prompt-tool');
  const requestedModel = options.one('--model') ?? 'default';
  const knownModel = Object.hasOwn(MODEL_ALIASES, requestedModel) || requestedModel.startsWith('claude-');
  const model = MODEL_ALIASES[requestedModel] ?? requestedModel;
  if (!knownModel) process.stderr.write(`[claude-code:unrecognized_model] ${JSON.stringify({ model: requestedModel, query_source: 'sdk' })}\n`);
  let permissionMode = options.one('--permission-mode') === 'plan' ? 'plan' : 'default';

  // For assertions in tests: what this process was started with.
  const mcpSources = (options.values.get('--mcp-config') ?? []).map((source) => (source.trim().startsWith('{') ? { inline: source } : { file: source, text: fs.readFileSync(source, 'utf8') }));
  fs.appendFileSync(
    path.join(state, 'invocations.jsonl'),
    `${JSON.stringify({ pid: process.pid, ppid: process.ppid, at: Date.now(), cwd, argv: process.argv.slice(2), env: process.env, mcpConfig: mcpSources })}\n`,
    { mode: 0o600 },
  );

  const mcp = await connectMcp(options);
  if (promptTool !== undefined && !mcp.has(promptTool)) {
    process.stderr.write(`Error: MCP tool ${promptTool} (passed via --permission-prompt-tool) not found. Available MCP tools: none\n`);
    await mcp.close();
    await quit(1);
  }

  // ---- the conversation this process holds -------------------------------------
  const sessionFile = (id) => path.join(state, 'sessions', `${id}.json`);
  const resumeId = options.one('--resume');
  let session = null;
  let resumeFailure = null;
  if (resumeId !== undefined) {
    const saved = UUID.test(resumeId) && fs.existsSync(sessionFile(resumeId)) ? JSON.parse(fs.readFileSync(sessionFile(resumeId), 'utf8')) : null;
    if (saved && saved.cwd === cwd) session = saved;
    else if (UUID.test(resumeId)) resumeFailure = `No conversation found with session ID: ${resumeId}`;
    else resumeFailure = `Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "${resumeId}" is not a UUID and does not match any session title.`;
  }
  session ??= { id: options.one('--session-id') ?? uuid(), cwd, turns: [], usage: {} };
  session.usage ??= {};
  const save = () => fs.writeFileSync(sessionFile(session.id), JSON.stringify(session), { mode: 0o600 });

  // ---- input: messages and control requests ------------------------------------
  const turnQueue = [];
  const steerQueue = [];
  let inputClosed = false;
  let turnRunning = false;
  let stubborn = false;
  let abort = new globalThis.AbortController();
  let interruptId = null;
  const waiters = [];
  const notify = () => {
    for (const resume of waiters.splice(0)) resume();
  };
  /** Resolves when a message arrives or the input closes. */
  const changed = () => new Promise((resolve) => waiters.push(resolve));

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.trim() === '') return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'user') {
      (turnRunning ? steerQueue : turnQueue).push(message);
    } else if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      if (stubborn) return;
      if (turnRunning) {
        interruptId = message.request_id;
        abort.abort();
      } else {
        emit({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } });
      }
    }
    notify();
  });
  input.on('close', () => {
    inputClosed = true;
    notify();
  });
  for (const prompt of options.positional) turnQueue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });

  // ---- output helpers ------------------------------------------------------------
  const toolPrefix = `toolu_si${crypto.randomBytes(4).toString('hex')}`;
  let counter = 0;
  const nextId = (prefix) => `${prefix}${String((counter += 1)).padStart(4, '0')}`;
  const base = () => ({ session_id: session.id, uuid: uuid() });
  // Like the real CLI: `modelUsage` and the cost are totals of the whole conversation, resumes included,
  // while a result's `usage` is that turn's (main thread only).
  const totals = (session.usage[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  let turnUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  let requests = 0;
  let resultIndex = 0;
  let rateLimitPrinted = false;
  let lastError = false;
  const pause = (ms) => sleep(ms, undefined, { signal: abort.signal });

  const printInit = () => {
    emit({
      type: 'system',
      subtype: 'init',
      cwd,
      session_id: session.id,
      tools: [...BUILT_IN_TOOLS, ...mcp.servers.flatMap((server) => server.tools.map((tool) => `mcp__${server.name}__${tool}`)).filter((tool) => tool !== promptTool)],
      mcp_servers: mcp.servers.map((server) => ({ name: server.name, status: server.status, source: 'dynamic' })),
      model,
      permissionMode,
      slash_commands: [],
      apiKeySource: 'none',
      claude_code_version: VERSION,
      output_style: 'default',
      agents: ['general-purpose'],
      skills: [],
      plugins: [],
      capabilities: ['interrupt_receipt_v1'],
      uuid: uuid(),
    });
  };

  // The account's usage windows, as the CLI reports them (times in seconds). Like Claude's, they reset on the hour:
  // the five-hour window two to three hours from now, the weekly one four days later — so what the Studio makes of
  // them never depends on the day the tests run. `fiveHourPassed` reports a five-hour window whose reset time has
  // just gone by, as a reading taken before a reset looks afterwards.
  const rateLimitInfo = (status, { fiveHourPassed = false } = {}) => {
    const HOUR = 3600;
    const nextHour = Math.ceil(Date.now() / 1000 / HOUR) * HOUR;
    const fiveHour = fiveHourPassed ? Math.floor(Date.now() / 1000) - 60 : nextHour + 2 * HOUR;
    const sevenDay = nextHour + 4 * 24 * HOUR;
    return {
      status,
      resetsAt: fiveHour,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: status === 'allowed' ? 0.25 : 0.97, resetsAt: fiveHour }, seven_day: { utilization: 0.1, resetsAt: sevenDay } },
    };
  };

  /** One request to the "model": a message of content blocks, streamed like the real thing. */
  async function apiMessage(blocks, { parent = null, delayMs = 0, extra = {} } = {}) {
    requests += 1;
    const id = nextId('msg_standin');
    const usage = { input_tokens: 12, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 + 300 * requests, output_tokens: 0 };
    const stream = partial && parent === null;
    const envelope = { session_id: session.id, parent_tool_use_id: parent };
    const streamEvent = (event) => stream && emit({ type: 'stream_event', event, ...envelope, uuid: uuid() });
    const message = (content) => ({ model, id, type: 'message', role: 'assistant', content, stop_reason: null, stop_sequence: null, usage: { ...usage } });
    streamEvent({ type: 'message_start', message: message([]) });
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'text') {
        streamEvent({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        let sent = '';
        for (const piece of block.pieces ?? [block.text]) {
          if (delayMs > 0) {
            try {
              await pause(delayMs);
            } catch (error) {
              // Interrupted mid-answer: the real CLI prints what it has, marked as cut short.
              if (sent !== '') emit({ type: 'assistant', message: message([{ type: 'text', text: sent }]), ...envelope, uuid: uuid(), ...extra, aborted: true });
              throw error;
            }
          }
          streamEvent({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
          sent += piece;
        }
        usage.output_tokens += block.text.split(/\s+/).length;
        emit({ type: 'assistant', message: message([{ type: 'text', text: block.text }]), ...envelope, uuid: uuid(), ...extra });
      } else if (block.type === 'thinking') {
        streamEvent({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } });
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'c3RhbmQtaW4=' } });
        usage.output_tokens += 20;
        emit({ type: 'assistant', message: message([{ type: 'thinking', thinking: block.thinking, signature: 'c3RhbmQtaW4=' }]), ...envelope, uuid: uuid(), ...extra });
      } else {
        const start = { type: 'tool_use', id: block.id, name: block.name, input: {}, caller: { type: 'direct' } };
        streamEvent({ type: 'content_block_start', index, content_block: start });
        streamEvent({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        usage.output_tokens += 30;
        emit({ type: 'assistant', message: message([{ ...start, input: block.input }]), ...envelope, uuid: uuid(), ...extra });
      }
      streamEvent({ type: 'content_block_stop', index });
    }
    const stopReason = blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    streamEvent({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { ...usage } });
    streamEvent({ type: 'message_stop' });
    totals.inputTokens += usage.input_tokens;
    totals.outputTokens += usage.output_tokens;
    totals.cacheReadInputTokens += usage.cache_read_input_tokens;
    totals.cacheCreationInputTokens += usage.cache_creation_input_tokens;
    if (parent === null) for (const key of Object.keys(turnUsage)) turnUsage[key] += usage[key];
    if (!rateLimitPrinted) {
      rateLimitPrinted = true;
      emit({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo('allowed'), ...base() });
    }
  }

  /** A made-up assistant message that carries an API failure, as the real CLI prints them. */
  function apiFailure(kind, sentence, status) {
    const message = { model: '<synthetic>', id: uuid(), type: 'message', role: 'assistant', content: [{ type: 'text', text: sentence }], stop_reason: 'stop_sequence', stop_sequence: '', usage: { input_tokens: 0, output_tokens: 0 } };
    emit({ type: 'assistant', message, parent_tool_use_id: null, ...base(), error: kind, is_api_error_message: true });
    return { failure: { sentence, status } };
  }

  function printResult(turn, fields) {
    const costOf = (used) => Number(((used.inputTokens + used.outputTokens + used.cacheReadInputTokens + used.cacheCreationInputTokens) * 0.000001).toFixed(6));
    const used = Object.entries(session.usage).filter(([, entry]) => costOf(entry) > 0);
    const cost = Number(used.reduce((sum, [, entry]) => sum + costOf(entry), 0).toFixed(6));
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: Date.now() - turn.startedAt,
      duration_api_ms: Date.now() - turn.startedAt,
      num_turns: turn.steps + 1,
      result: turn.lastText,
      stop_reason: 'end_turn',
      session_id: session.id,
      total_cost_usd: cost,
      usage: { ...turnUsage },
      modelUsage: Object.fromEntries(used.map(([name, entry]) => [name, { ...entry, webSearchRequests: 0, costUSD: costOf(entry), contextWindow: 200000, maxOutputTokens: 32000 }])),
      permission_denials: turn.denials,
      terminal_reason: 'completed',
      uuid: uuid(),
      queued_turn_count: 0,
      result_index: resultIndex,
      ...fields,
    });
    resultIndex += 1;
    lastError = fields?.is_error === true;
  }

  // ---- what a scenario can do ------------------------------------------------------
  function makeTurn(userText, images) {
    const turn = { startedAt: Date.now(), steps: 0, lastText: '', denials: [], userText, images, background: [] };

    turn.say = async (text, { pieces, delayMs = 0, thinking = '', parent = null, extra } = {}) => {
      const blocks = [...(parent === null ? [{ type: 'thinking', thinking }] : []), { type: 'text', text, pieces: pieces ?? splitPieces(text) }];
      await apiMessage(blocks, { parent, delayMs, extra });
      if (parent === null) turn.lastText = text;
    };

    /** Asks the permission prompt tool, as the real CLI does for anything that is not plainly a read. */
    turn.permit = async (name, toolInput, id) => {
      if (promptTool === undefined) return { behavior: 'deny', message: `Claude requested permissions to use ${name}, but you haven't granted it yet.` };
      const answer = await mcp.call(promptTool, { tool_name: name, input: toolInput, tool_use_id: id }, id);
      try {
        const decision = JSON.parse(textOf(answer.content));
        if (decision.behavior === 'allow') return { behavior: 'allow', updatedInput: decision.updatedInput ?? toolInput };
        return { behavior: 'deny', message: String(decision.message ?? 'Permission denied.') };
      } catch {
        return { behavior: 'deny', message: 'The permission prompt tool gave an answer that could not be read.' };
      }
    };

    /**
     * One tool call: announced, permitted (when `ask`), carried out by `run`, and its result printed.
     * `run` returns { content, structured?, isError? }. Returns { denied, message } | the run's value.
     */
    turn.tool = async (name, toolInput, run, { ask = true, parent = null, extra, async: launched = false } = {}) => {
      const id = nextId(toolPrefix);
      turn.steps += 1;
      await apiMessage([{ type: 'tool_use', id, name, input: toolInput }], { parent, extra });
      const envelope = { parent_tool_use_id: parent, session_id: session.id, uuid: uuid(), ...(extra ?? {}) };
      if (ask) {
        const decision = await Promise.race([turn.permit(name, toolInput, id), aborted()]);
        if (decision.behavior !== 'allow') {
          turn.denials.push({ tool_name: name, tool_use_id: id, tool_input: toolInput });
          emit({
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', content: decision.message, is_error: true, tool_use_id: id }] },
            ...envelope,
            tool_use_result: `Error: ${decision.message}`,
            tool_result_meta: [{ id, non_execution_kind: 'permission-rule' }],
          });
          return { id, denied: true, message: decision.message };
        }
        toolInput = decision.updatedInput;
      }
      const result = await run(toolInput, id);
      emit({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: result.content, ...(result.isError ? { is_error: true } : parent === null ? {} : { is_error: false }) }] },
        ...envelope,
        // The real CLI attaches the structured result only on its main thread.
        ...(parent === null && result.structured !== undefined ? { tool_use_result: result.structured } : {}),
      });
      if (!launched) await turn.boundary();
      return { id, denied: false, ...result };
    };

    /** Between steps the real CLI takes a message that was written to its input meanwhile. */
    turn.boundary = async () => {
      while (steerQueue.length > 0) {
        const steered = steerQueue.shift();
        if (replay) emit({ ...steered, session_id: session.id, parent_tool_use_id: null, uuid: uuid(), isReplay: true });
        const said = textOf(steered.message?.content);
        session.turns.push({ user: said, reply: '(steered)' });
        await turn.say(`Steered: ${clip(said, 300)}`);
      }
    };
    return turn;
  }

  const aborted = () =>
    new Promise((_resolve, reject) => {
      if (abort.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      abort.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });

  const splitPieces = (text) => text.match(/\S+\s*/g) ?? [text];
  const insideReadable = (file) => [cwd, ...addDirs].some((root) => file === root || file.startsWith(`${root}${path.sep}`));

  const scenarios = {
    async recall(turn) {
      const earlier = session.turns.map((entry, index) => `${index + 1}) ${clip(entry.user, 200)}`);
      await turn.say(earlier.length === 0 ? 'Nothing was said before this message.' : `Earlier in this conversation you said: ${earlier.join(' ')}`);
    },
    async 'echo-prompt'(turn) {
      await turn.say(turn.userText, { pieces: [turn.userText] });
    },
    async 'system-prompt'(turn) {
      const appended = options.one('--append-system-prompt');
      const text = appended === undefined ? 'Nothing was appended to my system prompt.' : appended;
      await turn.say(text, { pieces: [text] });
    },
    async 'edit-file'(turn, args) {
      const name = args || 'standin-note.txt';
      const file = path.resolve(cwd, name);
      const content = `written by the stand-in\n`;
      const outcome = await turn.tool('Write', { file_path: file, content }, (given) => {
        const before = fs.existsSync(given.file_path) ? fs.readFileSync(given.file_path, 'utf8') : null;
        fs.mkdirSync(path.dirname(given.file_path), { recursive: true });
        fs.writeFileSync(given.file_path, given.content);
        const oldLines = before === null ? [] : before.replace(/\n$/, '').split('\n');
        const newLines = given.content.replace(/\n$/, '').split('\n');
        const structuredPatch = before === null ? [] : [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines: [...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)] }];
        return {
          content: `${before === null ? 'File created successfully at' : 'The file has been updated:'} ${given.file_path}`,
          structured: { type: before === null ? 'create' : 'update', filePath: given.file_path, content: given.content, structuredPatch, originalFile: before, userModified: false },
        };
      });
      await turn.say(outcome.denied ? `I could not write ${name}: ${outcome.message}` : `The file ${name} is written.`);
    },
    async bash(turn, args) {
      const command = args || 'echo standin > standin-out.txt';
      const outcome = await turn.tool(
        'Bash',
        { command, description: 'Run a command for the stand-in' },
        (given) => ({ content: `stand-in ran: ${given.command}`, structured: { stdout: `stand-in ran: ${given.command}`, stderr: '', interrupted: false, isImage: false } }),
        { ask: !READ_ONLY_COMMAND.test(command) },
      );
      await turn.say(outcome.denied ? `I could not run that: ${outcome.message}` : `The command finished: ${command}`);
    },
    async 'read-file'(turn, args) {
      const file = path.resolve(cwd, args || 'README.md');
      const outcome = await turn.tool('Read', { file_path: file }, readFile, { ask: !insideReadable(file) });
      await turn.say(outcome.denied ? `I could not read ${path.basename(file)}: ${outcome.message}` : outcome.isError ? `Reading ${path.basename(file)} failed: ${outcome.content}` : `${path.basename(file)} says: ${clip(outcome.content, 500)}`);
    },
    async 'read-attachment'(turn) {
      const files = [...turn.userText.matchAll(/^- .*\): (\/.+)$/gm)].map((match) => match[1]);
      if (files.length === 0) return turn.say('No files were attached to this message.');
      const said = [];
      for (const file of files) {
        const outcome = await turn.tool('Read', { file_path: file }, readFile, { ask: !insideReadable(file) });
        said.push(outcome.denied ? `${path.basename(file)} was refused: ${outcome.message}` : outcome.isError ? `${path.basename(file)} could not be read: ${outcome.content}` : `${path.basename(file)} says: ${clip(outcome.content, 300)}`);
      }
      await turn.say(said.join(' | '));
    },
    async 'studio-tool'(turn, args) {
      const [name, ...rest] = args.split(/\s+/);
      const qualified = `mcp__studio__${name}`;
      let toolInput;
      try {
        toolInput = rest.length > 0 ? JSON.parse(rest.join(' ')) : {};
      } catch {
        return turn.say(`The arguments for ${name} are not JSON.`);
      }
      if (!mcp.has(qualified)) return turn.say(`There is no tool named ${qualified} here.`);
      const outcome = await turn.tool(qualified, toolInput, async (given, id) => {
        const answer = await mcp.call(qualified, given, id);
        return { content: textOf(answer.content), isError: answer.isError === true };
      });
      await turn.say(outcome.denied ? `The tool ${name} was refused: ${outcome.message}` : `The tool ${name} answered${outcome.isError ? ' with an error' : ''}: ${clip(outcome.content, 500)}`);
    },
    async 'ask-user'(turn) {
      const questions = [
        { question: 'Which colour should the button be?', header: 'Colour', options: [{ label: 'Red', description: 'A warm red' }, { label: 'Blue (Recommended)', description: 'A calm blue' }], multiSelect: false },
        { question: 'Which pages need it?', header: 'Pages', options: [{ label: 'Home', description: 'The start page' }, { label: 'Settings', description: 'The settings page' }], multiSelect: true },
      ];
      const outcome = await turn.tool('AskUserQuestion', { questions }, (given) => {
        const answers = given.answers ?? {};
        const listed = Object.entries(answers).map(([question, answer]) => `"${question}"="${answer}"`);
        return { content: `Your questions have been answered: ${listed.join(', ')}. You can now continue with these answers in mind.`, structured: { questions, answers } };
      });
      await turn.say(outcome.denied ? `No answer came: ${outcome.message}` : `You chose: ${JSON.stringify(outcome.structured.answers)}`);
    },
    async plan(turn) {
      const plan = '1. Create plan-output.txt in the project.\n2. Report back.\n';
      await turn.say('Here is my plan.');
      const outcome = await turn.tool('ExitPlanMode', { plan, planFilePath: path.join(os.homedir(), '.claude', 'plans', 'standin-plan.md') }, (given) => {
        permissionMode = 'default';
        emit({ type: 'system', subtype: 'status', status: null, permissionMode, ...base() });
        return { content: `User has approved your plan. You can now start coding.\n\n## Approved Plan:\n${given.plan}`, structured: { plan: given.plan, isAgent: false } };
      });
      if (outcome.denied) return turn.say(`The plan was not approved: ${outcome.message}`);
      await turn.say('The plan is approved; carrying it out.');
      await scenarios['edit-file'](turn, 'plan-output.txt');
    },
    async todo(turn) {
      const create = (subject) => () => {
        const id = String((turn.todoCount = (turn.todoCount ?? 0) + 1));
        return { content: `Task #${id} created successfully: ${subject}`, structured: { task: { id, subject } } };
      };
      const update = (from, to) => (given) => ({ content: `Updated task #${given.taskId} status`, structured: { success: true, taskId: given.taskId, updatedFields: ['status'], statusChange: { from, to } } });
      await turn.tool('TaskCreate', { subject: 'Check the directory', description: 'Look at what is there' }, create('Check the directory'), { ask: false });
      await turn.tool('TaskCreate', { subject: 'Report', description: 'Say what was found' }, create('Report'), { ask: false });
      await turn.tool('TaskUpdate', { taskId: '1', status: 'in_progress' }, update('pending', 'in_progress'), { ask: false });
      await turn.tool('TaskUpdate', { taskId: '1', status: 'completed' }, update('in_progress', 'completed'), { ask: false });
      await turn.tool('TaskUpdate', { taskId: '2', status: 'completed' }, update('pending', 'completed'), { ask: false });
      await turn.say('Both to-dos are done.');
    },
    async 'todo-legacy'(turn) {
      const ok = () => ({ content: 'Todos have been modified successfully.' });
      await turn.tool('TodoWrite', { todos: [{ content: 'Check the directory', status: 'in_progress', activeForm: 'Checking the directory' }, { content: 'Report', status: 'pending', activeForm: 'Reporting' }] }, ok, { ask: false });
      await turn.tool('TodoWrite', { todos: [{ content: 'Check the directory', status: 'completed', activeForm: 'Checking the directory' }, { content: 'Report', status: 'completed', activeForm: 'Reporting' }] }, ok, { ask: false });
      await turn.say('Both to-dos are done.');
    },
    async 'sub-agent'(turn) {
      const description = 'Find the working directory';
      const prompt = 'Run pwd and reply with its output only.';
      const taskId = `a${crypto.randomBytes(8).toString('hex')}`;
      const launch = await turn.tool(
        'Agent',
        { description, subagent_type: 'general-purpose', prompt },
        (_given, id) => {
          emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: taskId, task_type: 'local_agent', description }], ...base() });
          emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description, subagent_type: 'general-purpose', is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent', prompt, ...base() });
          return {
            content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${taskId}\nThe agent is working in the background. You will be notified automatically when it completes.` }],
            structured: { isAsync: true, status: 'async_launched', agentId: taskId, description, resolvedModel: model, prompt },
          };
        },
        { ask: false, async: true },
      );
      // What the sub-agent does is printed with the id of the call that started it, complete blocks only.
      const extra = { subagent_type: 'general-purpose', task_description: description };
      await turn.tool('Bash', { command: 'pwd', description: 'Print working directory' }, () => ({ content: cwd }), { ask: false, parent: launch.id, extra, async: true });
      emit({ type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: launch.id, description: 'Running Print working directory', subagent_type: 'general-purpose', usage: { total_tokens: 11083, tool_uses: 1, duration_ms: 20 }, last_tool_name: 'Bash', ...base() });
      await turn.say('Waiting for the sub-agent to complete...');
      // The turn ends here; the sub-agent reports later and the CLI then starts a turn by itself.
      turn.background.push(async (next) => {
        await pause(150);
        await next.say(cwd, { parent: launch.id, extra });
        emit({ type: 'system', subtype: 'background_tasks_changed', tasks: [], ...base() });
        emit({ type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status: 'completed', end_time: Date.now() }, ...base() });
        emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: launch.id, status: 'completed', summary: cwd, usage: { total_tokens: 11846, tool_uses: 1, duration_ms: 170 }, ...base() });
        printInit();
        await next.say(`The sub-agent reported: ${cwd}`);
      });
    },
    async thinking(turn) {
      await turn.say('The answer is 4.', { thinking: 'Two plus two: that is four.' });
    },
    async long(turn, args) {
      const pieces = Array.from({ length: Number(args) > 0 ? Number(args) : 100 }, (_unused, index) => `tick ${index + 1} `);
      await turn.say(pieces.join(''), { pieces, delayMs: 40 });
    },
    async steerable(turn) {
      await turn.say('Working on it.');
      await turn.tool('Bash', { command: 'pwd', description: 'Print working directory' }, async () => {
        // A step that takes a while: a steered message arrives during it.
        const deadline = Date.now() + 10_000;
        while (steerQueue.length === 0 && Date.now() < deadline) await pause(50);
        return { content: cwd };
      }, { ask: false });
      if (!turn.lastText.startsWith('Steered: ')) await turn.say('No further instructions arrived.');
    },
    async inspect(turn, args) {
      const report = {
        cwd,
        flags: process.argv.slice(2).filter((arg) => arg.startsWith('-')),
        envNames: Object.keys(process.env).sort(),
        canRead: Object.fromEntries(
          args
            .split(/\s+/)
            .filter(Boolean)
            .map((file) => {
              try {
                // A folder: how many entries it shows. A file: whether it can be read.
                return [file, fs.statSync(file).isDirectory() ? fs.readdirSync(file).length : fs.readFileSync(file).length >= 0];
              } catch {
                return [file, false];
              }
            }),
        ),
      };
      const text = JSON.stringify(report);
      await turn.say(text, { pieces: [text] });
    },
    async compact(turn) {
      emit({ type: 'system', subtype: 'status', status: 'compacting', ...base() });
      emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 }, ...base() });
      await turn.say('Carrying on after the compaction.');
    },
    async retry(turn) {
      for (const attempt of [1, 2]) emit({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded_error', ...base() });
      await turn.say('The request went through on the third try.');
    },
    async 'rate-warning'(turn) {
      rateLimitPrinted = true;
      emit({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo('allowed_warning'), ...base() });
      await turn.say('The limit is close, but here is the answer.');
    },
    async 'rate-reset-passed'(turn) {
      rateLimitPrinted = true;
      emit({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo('allowed', { fiveHourPassed: true }), ...base() });
      await turn.say('The five-hour window has just reset.');
    },
    async 'unknown-event'(turn) {
      emit({ type: 'future_event', payload: { anything: true }, ...base() });
      emit({ type: 'system', subtype: 'future_subtype', ...base() });
      emit({ type: 'stream_event', event: { type: 'future_stream_event' }, session_id: session.id, parent_tool_use_id: null, uuid: uuid() });
      await turn.say('Unknown events were printed and nothing broke.');
    },
    async noisy(turn) {
      out('warning: this line is not JSON\n');
      await turn.say('A stray line was printed, and the answer still arrived.');
    },
    'not-signed-in': () => apiFailure('authentication_failed', 'Not logged in · Please run /login', null),
    'usage-limit': () => {
      rateLimitPrinted = true;
      emit({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo('rejected'), ...base() });
      return apiFailure('rate_limit', "You've hit your limit · resets 3pm (UTC)", 429);
    },
    overloaded: () => apiFailure('server_error', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 529),
    'error-result': () => ({ errorResult: 'Something went wrong inside the stand-in.' }),
    async crash(turn) {
      await turn.say('Starting, and then', { pieces: ['Starting, ', 'and then'] }).catch(() => {});
      process.stderr.write('fatal: the stand-in crashed on purpose; api_key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n');
      await quit(3);
    },
    async garbage() {
      out('Segmentation fault (this is not JSON)\n');
      await mcp.close();
      await quit(0);
    },
    async die() {
      if (partial) emit({ type: 'stream_event', event: { type: 'message_start', message: { model, id: nextId('msg_standin'), type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }, session_id: session.id, parent_tool_use_id: null, uuid: uuid() });
      if (partial) emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: session.id, parent_tool_use_id: null, uuid: uuid() });
      if (partial) emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Half an ans' } }, session_id: session.id, parent_tool_use_id: null, uuid: uuid() });
      await drained();
      process.kill(process.pid, 'SIGKILL');
      await sleep(5000);
    },
    async stubborn(turn) {
      stubborn = true;
      process.on('SIGTERM', () => {});
      process.on('SIGINT', () => {});
      const pieces = Array.from({ length: 1500 }, (_unused, index) => `stuck ${index + 1} `);
      await turn.say(pieces.join(''), { pieces, delayMs: 40 });
    },
  };

  function readFile(given) {
    try {
      return { content: fs.readFileSync(given.file_path, 'utf8').slice(0, 2000) };
    } catch (error) {
      return { content: `${error.code ?? 'ERROR'}: could not read ${given.file_path}`, isError: true };
    }
  }

  // ---- one turn -----------------------------------------------------------------------
  async function runTurn(message, { selfStarted = null } = {}) {
    turnRunning = true;
    turnUsage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    abort = new globalThis.AbortController();
    interruptId = null;
    const content = message?.message?.content;
    const userText = textOf(content);
    const images = Array.isArray(content) ? content.filter((block) => block.type === 'image') : [];
    const turn = makeTurn(userText, images);
    let background = [];
    try {
      if (selfStarted) {
        await selfStarted(turn);
        printResult(turn, { origin: { kind: 'task-notification' } });
        return;
      }
      printInit();
      emit({ type: 'system', subtype: 'status', status: 'requesting', ...base() });
      if (replay) emit({ ...message, session_id: session.id, parent_tool_use_id: null, uuid: uuid(), isReplay: true });

      if (fs.existsSync(path.join(state, 'signed-out'))) return void failTurn(turn, scenarios['not-signed-in']());
      if (!knownModel) {
        const sentence = `There's an issue with the selected model (${requestedModel}). It may not exist or you may not have access to it. Run --model to pick a different model.`;
        return void failTurn(turn, apiFailure('model_not_found', sentence, 404));
      }
      const wanted = scenariosOf(userText);
      if (wanted.length === 0) {
        const about = images.length === 0 ? '' : ` I received ${images.length} image(s): ${images.map((image) => `${image.source?.media_type} of ${Buffer.from(image.source?.data ?? '', 'base64').length} bytes`).join(', ')}.`;
        await turn.say(`You said: “${clip(userText, 300)}”.${about} This is the Claude Code stand-in; message ${session.turns.length + 1} of this conversation.`);
      }
      for (const { name, args } of wanted) {
        const play = scenarios[name];
        if (!play) {
          await turn.say(`The stand-in has no scenario called "${name}".`);
          continue;
        }
        const outcome = await play(turn, args);
        if (outcome?.failure) return void failTurn(turn, outcome);
        if (outcome?.errorResult) {
          session.turns.push({ user: userText, reply: '(failed)' });
          save();
          printResult(turn, { subtype: 'error_during_execution', is_error: true, errors: [outcome.errorResult], terminal_reason: 'error', result: undefined });
          return;
        }
      }
      session.turns.push({ user: userText, reply: turn.lastText });
      save();
      printResult(turn);
      background = turn.background;
    } catch (error) {
      if (error?.name !== 'AbortError') throw error;
      // Interrupted: say so the way the real CLI does.
      emit({ type: 'control_response', response: { subtype: 'success', request_id: interruptId, response: { still_queued: [] } } });
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, ...base() });
      session.turns.push({ user: userText, reply: '(interrupted)' });
      save();
      printResult(turn, { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'], result: undefined });
    } finally {
      turnRunning = false;
      for (const work of background) selfStartedQueue.push(work);
    }
  }

  function failTurn(turn, outcome) {
    // The real CLI keeps a failed turn in its conversation, which can still be resumed.
    session.turns.push({ user: turn.userText, reply: '(failed)' });
    save();
    printResult(turn, { is_error: true, terminal_reason: 'api_error', api_error_status: outcome.failure.status, result: outcome.failure.sentence, modelUsage: {}, stop_reason: 'stop_sequence' });
  }

  // ---- the main loop ---------------------------------------------------------------------
  const selfStartedQueue = [];
  for (;;) {
    while (turnQueue.length === 0 && selfStartedQueue.length === 0 && !inputClosed) await changed();
    if (resumeFailure !== null) {
      process.stderr.write(`${resumeFailure}\n`);
      emit({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0, stop_reason: null, session_id: UUID.test(resumeId) ? resumeId : uuid(), total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [], uuid: uuid(), errors: [resumeFailure], result_index: 0 });
      while (!inputClosed) await changed();
      await mcp.close();
      await quit(1);
    }
    if (selfStartedQueue.length > 0) {
      await runTurn(null, { selfStarted: selfStartedQueue.shift() });
      continue;
    }
    if (turnQueue.length === 0) break;
    await runTurn(turnQueue.shift());
    // What arrived during the turn and was not taken at a step boundary is the next turn.
    turnQueue.push(...steerQueue.splice(0));
  }
  input.close();
  await mcp.close();
  await quit(lastError ? 1 : 0);
}
