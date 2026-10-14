/*
 * The Codex stand-in: see ../bin/codex for what it is and how to steer it.
 *
 * Message shapes are taken from captures of `codex app-server` 0.160.0 (and,
 * where a message could not be provoked, from the schema that version prints
 * with `codex app-server generate-json-schema`; those places say so).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { assign, merge, parseDocument, parseOverride } from './toml.mjs';

export const VERSION = '0.160.0-standin';

const HOME = process.env.HOME || os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const STATE = path.join(os.tmpdir(), `codex-standin-${typeof process.getuid === 'function' ? process.getuid() : 'user'}`, crypto.createHash('sha256').update(HOME).digest('hex').slice(0, 16));
const THREADS = path.join(STATE, 'threads');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();
const seconds = () => Math.floor(Date.now() / 1000);
const stamp = crypto.randomBytes(3).toString('hex');
let counter = 0;
const nextId = (prefix) => `${prefix}_${stamp}_${(counter += 1)}`;
/** Thread and turn ids look like the real ones: UUIDs. */
const uuid = () => crypto.randomUUID();

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** What a test may set for this Codex home: `<codex home>/standin.json`. */
const control = () => readJson(path.join(CODEX_HOME, 'standin.json'), {});
/**
 * Only a Codex home a test prepared (one with a `standin.json`, `{}` will do)
 * has its `config.toml` and `rules/` read. Anywhere else — a developer's real
 * `~/.codex`, when a suite did not bother with a throw-away HOME — the
 * stand-in behaves like a fresh installation, so that it answers the same on
 * every machine and never looks at anybody's real settings.
 */
const PREPARED_HOME = fs.existsSync(path.join(CODEX_HOME, 'standin.json'));

function record(entry) {
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.appendFileSync(path.join(STATE, 'invocations.jsonl'), `${JSON.stringify({ at: now(), pid: process.pid, ...entry })}\n`);
  } catch {
    /* a read-only temp directory must not break the stand-in */
  }
}

/** How the real CLI shows a command: the shell it runs it with, the script quoted only when it has to be. */
function shellQuote(text) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'"'"'`)}'`;
}

// ---------------------------------------------------------------------------
// Configuration: user file, project file, `-c` overrides — layered like the real CLI
// ---------------------------------------------------------------------------

function readToml(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return parseDocument(text);
}

function ancestors(dir) {
  const all = [];
  let current = path.resolve(dir);
  for (;;) {
    all.push(current);
    const parent = path.dirname(current);
    if (parent === current) return all;
    current = parent;
  }
}

function configuration(overrides, cwd) {
  const session = {};
  for (const override of overrides) assign(session, override.path, override.value);
  const user = PREPARED_HOME ? (readToml(path.join(CODEX_HOME, 'config.toml')) ?? {}) : {};
  const withoutProject = merge(user, session);
  const layers = [{ name: { type: 'sessionFlags' }, version: 'standin', config: session, disabledReason: null }];
  let effective = withoutProject;
  let projectDir = null;
  if (cwd) {
    // The project is the nearest folder, from the working directory upwards, that has a `.codex/config.toml`.
    projectDir = ancestors(cwd).find((dir) => fs.existsSync(path.join(dir, '.codex', 'config.toml'))) ?? null;
    if (projectDir !== null) {
      const project = readToml(path.join(projectDir, '.codex', 'config.toml')) ?? {};
      const level = withoutProject.projects?.[projectDir]?.trust_level;
      const trusted = level === 'trusted';
      layers.push({
        name: { type: 'project', dotCodexFolder: path.join(projectDir, '.codex') },
        version: 'standin',
        config: project,
        disabledReason: trusted
          ? null
          : level === 'untrusted'
            ? `${projectDir} is marked as untrusted in the effective configuration. To load project-local config, hooks, and exec policies, update its trust setting.`
            : `To load project-local config, hooks, and exec policies, add ${projectDir} as a trusted project in ${path.join(CODEX_HOME, 'config.toml')}.`,
      });
      if (trusted) effective = merge(merge(user, project), session);
      else projectDir = null;
    }
  }
  layers.push({ name: { type: 'user', file: path.join(CODEX_HOME, 'config.toml'), profile: null }, version: 'standin', config: user, disabledReason: null });
  layers.push({ name: { type: 'system', file: '/etc/codex/config.toml' }, version: 'standin', config: {}, disabledReason: null });
  return { effective, layers, trustedProjectDir: projectDir };
}

/**
 * The instruction files a thread loads, as the real CLI reports them: from the
 * Codex home `AGENTS.override.md`, or `AGENTS.md` when there is no override
 * with text in it — an empty file is not loaded — and the project's own
 * `AGENTS.md`.
 */
function instructionSources(cwd) {
  const hasText = (file) => {
    try {
      return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').trim() !== '';
    } catch {
      return false;
    }
  };
  const sources = [];
  if (PREPARED_HOME) {
    const personal = ['AGENTS.override.md', 'AGENTS.md'].map((name) => path.join(CODEX_HOME, name)).find(hasText);
    if (personal) sources.push(personal);
    // A CLI that loads its home's instructions although they were hidden (for the test that the adapter notices).
    else if (control().claimPersonalInstructions === true) sources.push(path.join(CODEX_HOME, 'AGENTS.md'));
  }
  if (cwd && hasText(path.join(cwd, 'AGENTS.md'))) sources.push(path.join(cwd, 'AGENTS.md'));
  return sources;
}

/** Command prefixes that `prefix_rule(pattern=[…], decision="allow")` lines pre-approve. */
function allowRules(trustedProjectDir) {
  const prefixes = [];
  const directories = [...(PREPARED_HOME ? [path.join(CODEX_HOME, 'rules')] : []), ...(trustedProjectDir ? [path.join(trustedProjectDir, '.codex', 'rules')] : [])];
  for (const directory of directories) {
    let names;
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.rules'));
    } catch {
      continue;
    }
    for (const name of names) {
      const text = readJsonless(path.join(directory, name));
      for (const match of text.matchAll(/prefix_rule\(\s*pattern\s*=\s*(\[[^\]]*\])\s*,\s*decision\s*=\s*"allow"/g)) {
        try {
          prefixes.push(JSON.parse(match[1]));
        } catch {
          /* not a plain list of strings */
        }
      }
    }
  }
  return prefixes;
}

function readJsonless(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Threads on disk (so that a later process can resume them)
// ---------------------------------------------------------------------------

const threadFile = (id) => path.join(THREADS, `${id}.json`);
const isThreadId = (id) => typeof id === 'string' && /^[0-9a-fA-F-]{8,64}$/.test(id);

function loadThread(id) {
  return isThreadId(id) ? readJson(threadFile(id), null) : null;
}

function saveThread(thread) {
  if (thread.ephemeral) return;
  fs.mkdirSync(THREADS, { recursive: true });
  fs.writeFileSync(threadFile(thread.id), JSON.stringify(thread));
}

// ---------------------------------------------------------------------------
// The app-server
// ---------------------------------------------------------------------------

class Interrupted extends Error {}

/** The token figures after `requests` model requests: every pretend request costs the same. */
function tokenUsage(requests) {
  const last = { totalTokens: 1240, inputTokens: 1200, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 8 };
  const total = Object.fromEntries(Object.entries(last).map(([name, value]) => [name, value * requests]));
  return { total, last, modelContextWindow: 258400 };
}

const DEFAULT_MODELS = [
  {
    id: 'standin-large',
    model: 'standin-large',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Stand-in Large',
    description: 'Answers from a script. For tests.',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
      { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: true,
  },
  {
    id: 'standin-small',
    model: 'standin-small',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'Stand-in Small',
    description: 'The same script, labelled smaller.',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' }],
    defaultReasoningEffort: 'low',
    inputModalities: ['text'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: false,
  },
];

const DEFAULT_ACCOUNT = { type: 'chatgpt', email: 'codex-standin@example.test', planType: 'plus' };

class AppServer {
  constructor(overrides) {
    this.overrides = overrides;
    this.initialized = false;
    this.pending = new Map();
    this.nextRequestId = 0;
    this.threads = new Map();
    this.active = null;
    this.children = new Set();
    this.mcp = new Map();
    this.stubborn = false;
  }

  send(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.send({ method, params, emittedAtMs: now() });
  }

  /** A request to the client. Resolves with its result; null when the client answered with an error. */
  ask(method, params) {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  async line(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (message.method === undefined && message.id !== undefined) {
      const resolve = this.pending.get(message.id);
      if (!resolve) return;
      this.pending.delete(message.id);
      if (this.active?.thread) this.notify('serverRequest/resolved', { threadId: this.active.thread.id, requestId: message.id });
      resolve(message.error ? null : (message.result ?? null));
      return;
    }
    if (message.id === undefined) {
      if (message.method === 'initialized') this.initialized = true;
      return;
    }
    try {
      const result = await this.request(message.method, message.params ?? {});
      this.send({ id: message.id, result });
    } catch (error) {
      this.send({ id: message.id, error: { code: error.code ?? -32600, message: error.message } });
    }
  }

  fail(message, code = -32600) {
    return Object.assign(new Error(message), { code });
  }

  async request(method, params) {
    if (method === 'initialize') {
      if (this.helloDone) throw this.fail('Already initialized');
      this.helloDone = true;
      return { userAgent: `${params.clientInfo?.name ?? 'client'}/${VERSION} (stand-in)`, codexHome: CODEX_HOME, platformFamily: 'unix', platformOs: process.platform };
    }
    if (!this.helloDone) throw this.fail('Not initialized');
    switch (method) {
      case 'account/read': {
        const state = control();
        if (state.signedIn === false) return { account: null, requiresOpenaiAuth: true, workspaceRouting: null };
        return { account: state.account ?? DEFAULT_ACCOUNT, requiresOpenaiAuth: true, workspaceRouting: null };
      }
      case 'model/list':
        return { data: control().models ?? DEFAULT_MODELS, nextCursor: null };
      case 'config/read': {
        const { effective, layers } = configuration(this.overrides, params.cwd ?? null);
        return { config: effective, origins: {}, layers: params.includeLayers ? layers : null };
      }
      case 'thread/start':
        return this.openThread(null, params);
      case 'thread/resume':
        return this.openThread(params.threadId, params);
      case 'thread/inject_items':
        return this.inject(params);
      case 'thread/delete': {
        if (!loadThread(params.threadId)) throw this.fail(`no rollout found for thread id ${params.threadId}`);
        fs.rmSync(threadFile(params.threadId), { force: true });
        this.threads.delete(params.threadId);
        return {};
      }
      case 'turn/start':
        return this.startTurn(params);
      case 'turn/steer':
        return this.steer(params);
      case 'turn/interrupt':
        return this.interrupt(params);
      default:
        throw this.fail(`the Codex stand-in does not implement ${method}`, -32601);
    }
  }

  // ---- threads ----------------------------------------------------------------

  openThread(resumeId, params) {
    const cwd = params.cwd ?? process.cwd();
    const { effective } = configuration(this.overrides, cwd);
    let thread;
    if (resumeId !== null) {
      if (!isThreadId(resumeId)) throw this.fail(`invalid session id: invalid character: expected an optional prefix of \`urn:uuid:\` followed by [0-9a-fA-F-], found \`${String(resumeId)[0]}\` at 1`);
      thread = this.threads.get(resumeId) ?? loadThread(resumeId);
      if (!thread) throw this.fail(`no rollout found for thread id ${resumeId}`);
    } else {
      thread = { id: uuid(), items: [], turns: 0, usage: 0, createdAt: seconds(), ephemeral: params.ephemeral === true, developerInstructions: params.developerInstructions ?? effective.developer_instructions ?? null };
    }
    // A CLI that does not take the client's settings (for the test that the adapter notices).
    const obeys = control().ignoreThreadSettings !== true;
    thread.cwd = cwd;
    thread.model = params.model ?? thread.model ?? effective.model ?? 'standin-large';
    thread.approvalPolicy = (obeys ? params.approvalPolicy : null) ?? effective.approval_policy ?? 'on-request';
    thread.approvalsReviewer = (obeys ? params.approvalsReviewer : null) ?? effective.approvals_reviewer ?? 'user';
    thread.sandbox = (obeys ? params.sandbox : null) ?? effective.sandbox_mode ?? 'read-only';
    this.threads.set(thread.id, thread);
    saveThread(thread);
    record({ event: resumeId === null ? 'thread/start' : 'thread/resume', params: { ...params, developerInstructions: params.developerInstructions ?? null } });
    const view = this.threadView(thread);
    if (resumeId === null) queueMicrotask(() => this.notify('thread/started', { thread: view }));
    // Like the real CLI: a reopened conversation reports the token figures of its previous turn once more.
    else if (thread.usage > 0 && thread.lastTurnId) {
      const usage = tokenUsage(thread.usage);
      queueMicrotask(() => this.notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: thread.lastTurnId, tokenUsage: usage }));
    }
    return {
      thread: view,
      model: thread.model,
      modelProvider: 'standin',
      serviceTier: null,
      disabledPluginIds: [],
      cwd,
      runtimeWorkspaceRoots: [cwd],
      instructionSources: instructionSources(cwd),
      approvalPolicy: thread.approvalPolicy,
      approvalsReviewer: thread.approvalsReviewer,
      sandbox: thread.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : thread.sandbox === 'workspace-write' ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : { type: 'dangerFullAccess' },
      activePermissionProfile: null,
      reasoningEffort: null,
      multiAgentMode: 'explicitRequestOnly',
    };
  }

  threadView(thread) {
    return {
      id: thread.id,
      sessionId: thread.id,
      forkedFromId: null,
      parentThreadId: null,
      preview: thread.items.find((item) => item.role === 'user')?.text.slice(0, 80) ?? '',
      ephemeral: thread.ephemeral,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: 'paginated',
      modelProvider: 'standin',
      model: thread.model,
      reasoningEffort: null,
      createdAt: thread.createdAt,
      updatedAt: seconds(),
      recencyAt: seconds(),
      status: { type: 'idle' },
      path: thread.ephemeral ? null : threadFile(thread.id),
      cwd: thread.cwd,
      cliVersion: VERSION,
      originator: 'codex-standin',
      source: 'vscode',
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    };
  }

  requireThread(id) {
    const thread = this.threads.get(id);
    if (!thread) throw this.fail(`thread not found: ${id}`);
    return thread;
  }

  inject(params) {
    const thread = this.requireThread(params.threadId);
    for (const item of params.items ?? []) {
      if (item?.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
      const text = (item.content ?? []).map((part) => part.text ?? '').join('');
      thread.items.push({ role: item.role, text, injected: true });
    }
    saveThread(thread);
    return {};
  }

  // ---- turns --------------------------------------------------------------------

  startTurn(params) {
    const thread = this.requireThread(params.threadId);
    if (this.active) throw this.fail('a turn is already in progress');
    const turn = new Turn(this, thread, params);
    this.active = turn;
    record({
      event: 'turn/start',
      params: { ...params, input: (params.input ?? []).map((part) => (part.type === 'text' ? { type: 'text', text: String(part.text).slice(0, 2000) } : part)) },
    });
    // The answer to the request goes out first; the turn follows.
    setImmediate(() => {
      turn.run().finally(() => {
        if (this.active === turn) this.active = null;
      });
    });
    return { turn: turn.view('inProgress') };
  }

  steer(params) {
    const turn = this.active;
    if (!turn || turn.finished) throw this.fail('no active turn to steer');
    if (params.expectedTurnId !== turn.id) throw this.fail(`expected active turn id ${params.expectedTurnId} but found ${turn.id}`);
    const text = (params.input ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('');
    turn.thread.items.push({ role: 'user', text, steered: true });
    turn.steered.push(text);
    for (const waiter of turn.steerWaiters.splice(0)) waiter(text);
    return { turnId: turn.id };
  }

  interrupt(params) {
    const turn = this.active;
    if (turn && turn.id === params.turnId && !this.stubborn) turn.interrupt();
    return {};
  }

  shutdown(code = 0) {
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    for (const connection of this.mcp.values()) connection.then((client) => client?.close()).catch(() => {});
    setTimeout(() => process.exit(code), 20);
  }
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

const SCENARIO = /\[\[scenario:([a-z-]+)(?:[ \t]+([^\]]*))?\]\]/g;
/** What the pretend read-only sandbox lets a command do without asking. */
const READ_ONLY_COMMANDS = new Set(['ls', 'cat', 'pwd', 'echo', 'head', 'wc', 'sleep', 'true', 'env', 'printenv', 'printf']);

class Turn {
  constructor(server, thread, params) {
    this.server = server;
    this.thread = thread;
    this.params = params;
    this.id = uuid();
    this.startedAt = seconds();
    this.startedMs = now();
    this.interrupted = false;
    this.finished = false;
    this.steered = [];
    this.steerWaiters = [];
    this.wake = [];
    this.text = (params.input ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    this.images = (params.input ?? []).filter((part) => part.type === 'localImage').map((part) => part.path);
    const settings = configuration(server.overrides, thread.cwd);
    this.config = settings.effective;
    this.trustedProjectDir = settings.trustedProjectDir;
    if (params.model) thread.model = params.model;
    if (control().ignoreThreadSettings !== true) {
      if (params.approvalPolicy) thread.approvalPolicy = params.approvalPolicy;
      if (params.sandboxPolicy) thread.sandbox = params.sandboxPolicy.type === 'readOnly' ? 'read-only' : params.sandboxPolicy.type === 'workspaceWrite' ? 'workspace-write' : 'danger-full-access';
    }
  }

  view(status, error = null) {
    return {
      id: this.id,
      items: [],
      itemsView: 'notLoaded',
      status,
      error,
      startedAt: this.startedAt,
      completedAt: status === 'inProgress' ? null : seconds(),
      durationMs: status === 'inProgress' ? null : now() - this.startedMs,
    };
  }

  note(method, params) {
    this.server.notify(method, { threadId: this.thread.id, turnId: this.id, ...params });
  }

  interrupt() {
    this.interrupted = true;
    for (const child of this.server.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    for (const wake of this.wake.splice(0)) wake();
  }

  check() {
    if (this.interrupted) throw new Interrupted();
  }

  /** Waits, but not past an interrupt. */
  async pause(ms) {
    this.check();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.check();
  }

  item(phase, item) {
    this.note(phase === 'started' ? 'item/started' : 'item/completed', { item, ...(phase === 'started' ? { startedAtMs: now() } : { completedAtMs: now() }) });
  }

  // ---- what the pretend model does ---------------------------------------------

  async say(text, options = {}) {
    const id = nextId('msg');
    const message = { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
    this.item('started', message);
    const chunks = Math.max(1, options.chunks ?? 3);
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let at = 0; at < text.length; at += size) {
      if (options.delayMs) await this.pause(options.delayMs);
      else this.check();
      this.note('item/agentMessage/delta', { itemId: id, delta: text.slice(at, at + size) });
    }
    this.item('completed', { ...message, text });
    this.thread.items.push({ role: 'assistant', text });
    this.usage();
  }

  async think(text) {
    const id = nextId('rs');
    this.item('started', { type: 'reasoning', id, summary: [], content: [] });
    const parts = text.split('\n\n');
    parts.forEach((part, index) => {
      this.note('item/reasoning/summaryPartAdded', { itemId: id, summaryIndex: index });
      for (const piece of part.match(/[\s\S]{1,12}/g) ?? []) this.note('item/reasoning/summaryTextDelta', { itemId: id, delta: piece, summaryIndex: index });
    });
    this.item('completed', { type: 'reasoning', id, summary: parts, content: [] });
  }

  usage() {
    this.thread.usage += 1;
    this.thread.lastTurnId = this.id;
    this.note('thread/tokenUsage/updated', { tokenUsage: tokenUsage(this.thread.usage) });
    // The weekly window resets three days from now, on the hour (in seconds): never a date the tests could outlive.
    const resetsAt = Math.ceil(Date.now() / 1000 / 3600) * 3600 + 3 * 24 * 3600;
    this.server.notify('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        normalModelSlug: null,
        primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt },
        secondary: null,
        credits: null,
        individualLimit: null,
        spendControlReached: null,
        planType: 'plus',
        rateLimitReachedType: null,
      },
    });
  }

  /** Runs a program for real, streaming what it prints. Only ever what a test asked for. */
  runProcess(itemId, script) {
    return new Promise((resolve) => {
      // Like the real CLI's default: variables that look like credentials do not reach the command.
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN/i.test(name)));
      const child = spawn('/bin/sh', ['-c', script], { cwd: this.thread.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.server.children.add(child);
      let output = '';
      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        output += text;
        this.note('item/commandExecution/outputDelta', { itemId, delta: text });
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', () => resolve({ output, exitCode: 127 }));
      child.on('close', (code) => {
        this.server.children.delete(child);
        resolve({ output, exitCode: code ?? 137 });
      });
    });
  }

  commandItem(id, script, extra) {
    return {
      type: 'commandExecution',
      id,
      pluginId: null,
      scriptPath: null,
      command: `/bin/bash -lc ${shellQuote(script)}`,
      cwd: this.thread.cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: script }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      ...extra,
    };
  }

  /**
   * A command that has to leave the sandbox ("require_escalated"): the client
   * is asked first — unless a saved rule allows the command or the approval
   * policy is `never`, exactly the two ways the real CLI skips the question.
   * Returns what the pretend model is told.
   */
  async escalatedCommand(script, reason = null) {
    const id = nextId('call');
    const words = script.trim().split(/\s+/);
    const ruled = allowRules(this.trustedProjectDir).some((prefix) => prefix.length > 0 && prefix.every((word, index) => words[index] === word));
    const unasked = ruled || this.thread.approvalPolicy === 'never';
    this.item('started', this.commandItem(id, script, unasked ? { processId: String(process.pid), source: 'unifiedExecStartup' } : {}));
    if (!unasked) {
      this.server.notify('thread/status/changed', { threadId: this.thread.id, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
      const answer = await this.server.ask('item/commandExecution/requestApproval', {
        kind: 'command',
        threadId: this.thread.id,
        turnId: this.id,
        itemId: id,
        startedAtMs: now(),
        environmentId: 'local',
        ...(reason ? { reason } : {}),
        command: `/bin/bash -lc ${shellQuote(script)}`,
        cwd: this.thread.cwd,
        commandActions: [{ type: 'unknown', command: script }],
        proposedExecpolicyAmendment: words,
        availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: words } }, 'cancel'],
      });
      this.server.notify('thread/status/changed', { threadId: this.thread.id, status: { type: 'active', activeFlags: [] } });
      const decision = answer?.decision;
      const accepted = decision === 'accept' || decision === 'acceptForSession' || (decision !== null && typeof decision === 'object' && 'acceptWithExecpolicyAmendment' in decision);
      if (!accepted) {
        this.item('completed', this.commandItem(id, script, { status: 'declined' }));
        if (decision === 'cancel') this.interrupted = true;
        this.check();
        return 'exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }';
      }
    }
    this.check();
    const started = now();
    const { output, exitCode } = await this.runProcess(id, script);
    this.check();
    this.item('completed', this.commandItem(id, script, { processId: String(process.pid), source: 'unifiedExecStartup', status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output === '' ? null : output, exitCode, durationMs: now() - started }));
    return `Process exited with code ${exitCode}\nOutput:\n${output}`;
  }

  /** A command inside the read-only sandbox: runs without asking, and cannot change anything. */
  async sandboxedCommand(script) {
    const program = script.trim().split(/\s+/)[0];
    if (!READ_ONLY_COMMANDS.has(program) || /[>|;&`$]/.test(script)) {
      // The real CLI reports no item at all for a command its sandbox refused; the model just sees the failure.
      return `Process exited with code 1\nOutput:\n${program}: Read-only file system\n`;
    }
    const id = nextId('call');
    this.item('started', this.commandItem(id, script, { processId: String(process.pid), source: 'unifiedExecStartup', commandActions: [{ type: program === 'ls' ? 'listFiles' : 'unknown', command: script, ...(program === 'ls' ? { path: null } : {}) }] }));
    const started = now();
    const { output, exitCode } = await this.runProcess(id, script);
    this.check();
    this.item('completed', this.commandItem(id, script, { processId: String(process.pid), source: 'unifiedExecStartup', status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output === '' ? null : output, exitCode, durationMs: now() - started }));
    return `Process exited with code ${exitCode}\nOutput:\n${output}`;
  }

  /** A patch: announced as an item, then put to the client, then written. */
  async fileChange(name, content) {
    const id = nextId('call');
    const target = path.resolve(this.thread.cwd, name);
    const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const lines = (text) => {
      const all = text.split('\n');
      if (all[all.length - 1] === '') all.pop();
      return all;
    };
    const change =
      before === null
        ? { path: target, kind: { type: 'add' }, diff: content }
        : {
            path: target,
            kind: { type: 'update', move_path: null },
            diff: `@@ -1,${lines(before).length} +1,${lines(content).length} @@\n${lines(before).map((line) => `-${line}`).join('\n')}\n${lines(content).map((line) => `+${line}`).join('\n')}\n`,
          };
    const item = { type: 'fileChange', id, changes: [change], status: 'inProgress' };
    this.item('started', item);
    let accepted = this.thread.approvalPolicy === 'never';
    let decision = null;
    if (!accepted) {
      const answer = await this.server.ask('item/fileChange/requestApproval', { threadId: this.thread.id, turnId: this.id, itemId: id, startedAtMs: now(), reason: null, grantRoot: null });
      decision = answer?.decision;
      accepted = decision === 'accept' || decision === 'acceptForSession';
    }
    if (!accepted) {
      this.item('completed', { ...item, status: 'declined' });
      if (decision === 'cancel') this.interrupted = true;
      this.check();
      return 'patch rejected by user';
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    this.item('completed', { ...item, status: 'completed' });
    this.note('turn/diff/updated', { diff: `diff --git a/${name} b/${name}\n--- ${before === null ? '/dev/null' : `a/${name}`}\n+++ b/${name}\n` });
    return `Success. Updated the following files:\n${before === null ? 'A' : 'M'} ${name}\n`;
  }

  /** The MCP server the client configured under `name`, connected to for real. Null when there is none. */
  mcpClient(name) {
    if (!this.server.mcp.has(name)) {
      const definition = this.config.mcp_servers?.[name];
      const connect = async () => {
        if (!definition || definition.enabled === false || typeof definition.command !== 'string') return null;
        this.server.notify('mcpServer/startupStatus/updated', { threadId: this.thread.id, name, status: 'starting', error: null, failureReason: null });
        // Like the real CLI: the server gets a small environment of its own, plus the variables named in `env_vars`
        // (forwarded from this process) and the ones written out under `env`.
        const env = { PATH: process.env.PATH ?? '', HOME };
        for (const forwarded of definition.env_vars ?? []) {
          if (typeof forwarded === 'string' && process.env[forwarded] !== undefined) env[forwarded] = process.env[forwarded];
        }
        Object.assign(env, definition.env ?? {});
        try {
          const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
          const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
          const client = new Client({ name: 'codex-standin', version: VERSION }, { capabilities: {} });
          await client.connect(new StdioClientTransport({ command: definition.command, args: definition.args ?? [], env, stderr: 'ignore' }));
          this.server.notify('mcpServer/startupStatus/updated', { threadId: this.thread.id, name, status: 'ready', error: null, failureReason: null });
          return client;
        } catch (error) {
          this.server.notify('mcpServer/startupStatus/updated', { threadId: this.thread.id, name, status: 'failed', error: String(error?.message ?? error), failureReason: null });
          return null;
        }
      };
      this.server.mcp.set(name, connect());
    }
    return this.server.mcp.get(name);
  }

  async mcpCall(serverName, tool, args) {
    const id = nextId('call');
    const item = { type: 'mcpToolCall', id, server: serverName, tool, status: 'inProgress', arguments: args, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
    const definition = this.config.mcp_servers?.[serverName] ?? {};
    if ((definition.disabled_tools ?? []).includes(tool)) return `the tool ${tool} is not offered by ${serverName}`;
    const client = await this.mcpClient(serverName);
    if (!client) return `the MCP server ${serverName} is not available`;
    this.item('started', item);
    if ((definition.default_tools_approval_mode ?? 'auto') !== 'approve') {
      const answer = await this.elicit(serverName, tool, args);
      if (answer?.action !== 'accept') {
        this.item('completed', { ...item, status: 'failed', error: { message: 'user rejected MCP tool call' } });
        if (answer?.action === 'cancel') this.interrupted = true;
        this.check();
        return 'user rejected MCP tool call';
      }
    }
    const started = now();
    try {
      const result = await client.callTool({ name: tool, arguments: args });
      const failed = result.isError === true;
      this.item('completed', { ...item, status: failed ? 'failed' : 'completed', result: { content: result.content ?? [], structuredContent: null, _meta: null }, ...(failed ? { error: { message: (result.content ?? []).map((part) => part.text ?? '').join('\n') } } : {}), durationMs: now() - started });
      return (result.content ?? []).map((part) => part.text ?? '').join('\n');
    } catch (error) {
      this.item('completed', { ...item, status: 'failed', error: { message: String(error?.message ?? error) }, durationMs: now() - started });
      return `tool call failed: ${String(error?.message ?? error)}`;
    }
  }

  /** How Codex asks about an MCP tool call: an MCP elicitation marked as an approval. */
  elicit(serverName, tool, args) {
    return this.server.ask('mcpServer/elicitation/request', {
      threadId: this.thread.id,
      turnId: this.id,
      serverName,
      mode: 'form',
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_description: `The ${tool} tool.`, tool_params: args, tool_params_display: Object.entries(args ?? {}).map(([name, value]) => ({ name, value, display_name: name })) },
      message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
      requestedSchema: { type: 'object', properties: {} },
    });
  }

  fail(error) {
    this.failure = error;
    throw new TurnFailed();
  }

  // ---- scenarios ------------------------------------------------------------------

  async play(name, argument) {
    switch (name) {
      case 'recall': {
        const earlier = this.thread.items.slice(0, this.thread.items.length - 1);
        await this.say(earlier.length === 0 ? 'This is the start of our conversation.' : `Earlier in this conversation: ${earlier.map((entry, index) => `${index + 1}. ${entry.role}: ${entry.text.replace(/\[\[[^\]]*\]\]/g, '').trim()}`).join(' | ')}`);
        return;
      }
      case 'echo-prompt':
        await this.say(this.text);
        return;
      case 'thinking':
        await this.think('Reading the request.\n\nChoosing a short answer.');
        await this.say('After thinking it over: this is the answer.');
        return;
      case 'run-command': {
        const result = await this.escalatedCommand(argument || 'touch codex-standin-ran.txt', 'The stand-in wants to run this outside its sandbox.');
        await this.say(/rejected/.test(result) ? 'The command was not allowed, so I did not run it.' : `The command finished. ${result.split('\n')[0]}.`);
        return;
      }
      case 'read-command': {
        const result = await this.sandboxedCommand(argument || 'ls');
        await this.say(/Read-only file system/.test(result) ? 'The sandbox did not let that command run.' : `I ran it. ${result.split('\n')[0]}.`);
        return;
      }
      case 'file-change': {
        const [file, ...rest] = (argument || 'standin-note.txt').split(/\s+/);
        const result = await this.fileChange(file, rest.length > 0 ? `${rest.join(' ')}\n` : 'written by the Codex stand-in\n');
        await this.say(/rejected/.test(result) ? 'The change was not allowed, so the file is untouched.' : `I changed ${file}.`);
        return;
      }
      case 'studio-tool': {
        const space = (argument || 'memory_search {"query":"stand-in"}').indexOf(' ');
        const text = argument || 'memory_search {"query":"stand-in"}';
        const tool = space === -1 ? text : text.slice(0, space);
        let args;
        try {
          args = space === -1 ? {} : JSON.parse(text.slice(space + 1));
        } catch {
          args = {};
        }
        const result = await this.mcpCall('studio', tool, args);
        await this.say(`The Studio tool ${tool} answered: ${result}`);
        return;
      }
      case 'mcp-elicit': {
        // A tool of some other MCP server. There is no such server: only the question to the client is real.
        // (The refusal's shape is from the schema; the question's from a capture.)
        const [serverName = 'other', tool = 'do_thing'] = (argument || '').split(/\s+/).filter(Boolean);
        const id = nextId('call');
        const item = { type: 'mcpToolCall', id, server: serverName, tool, status: 'inProgress', arguments: { target: 'x' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
        this.item('started', item);
        const answer = await this.elicit(serverName, tool, { target: 'x' });
        if (answer?.action === 'accept') {
          this.item('completed', { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'the other server did the thing' }], structuredContent: null, _meta: null }, durationMs: 1 });
          await this.say(`The tool ${tool} ran.`);
        } else {
          this.item('completed', { ...item, status: 'failed', error: { message: 'user rejected MCP tool call' } });
          if (answer?.action === 'cancel') this.interrupted = true;
          this.check();
          await this.say(`The tool ${tool} was not allowed.`);
        }
        return;
      }
      case 'long': {
        const pieces = Math.max(1, Number.parseInt(argument || '100', 10) || 100);
        const id = nextId('msg');
        const message = { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
        this.item('started', message);
        let text = '';
        for (let index = 1; index <= pieces; index += 1) {
          await this.pause(40);
          const piece = `piece ${index}. `;
          text += piece;
          this.note('item/agentMessage/delta', { itemId: id, delta: piece });
        }
        this.item('completed', { ...message, text });
        this.thread.items.push({ role: 'assistant', text });
        this.usage();
        return;
      }
      case 'steerable': {
        await this.sandboxedCommand('echo working');
        const text = this.steered.length > 0 ? this.steered[this.steered.length - 1] : await Promise.race([new Promise((resolve) => this.steerWaiters.push(resolve)), this.pause(10_000).then(() => null)]);
        this.check();
        await this.say(text === null ? 'Nobody steered me, so I finished as planned.' : `You steered me: ${text}`);
        return;
      }
      case 'plan':
        this.note('turn/plan/updated', { explanation: null, plan: [{ step: 'Read the code', status: 'inProgress' }, { step: 'Write the fix', status: 'pending' }] });
        await this.pause(20);
        this.note('turn/plan/updated', { explanation: null, plan: [{ step: 'Read the code', status: 'completed' }, { step: 'Write the fix', status: 'inProgress' }] });
        await this.say('I am working through a plan of two steps.');
        return;
      case 'web-search': {
        const id = nextId('ws');
        const query = argument || 'agent studio';
        this.item('started', { type: 'webSearch', id, query, action: null, results: null });
        this.item('completed', { type: 'webSearch', id, query, action: { type: 'search', query, queries: [query] }, results: null });
        await this.say(`I searched the web for ${query}.`);
        return;
      }
      case 'ask-user': {
        // Shape from the schema (`item/tool/requestUserInput`): the real CLI offers this tool only in its plan mode.
        const answer = await this.server.ask('item/tool/requestUserInput', {
          threadId: this.thread.id,
          turnId: this.id,
          itemId: nextId('call'),
          questions: [{ id: 'database', header: 'Database', question: 'Which database should I use?', isOther: true, isSecret: false, options: [{ label: 'SQLite (Recommended)', description: 'Simple and local.' }, { label: 'Postgres', description: 'A server.' }] }],
          isBlocking: true,
          autoResolutionMs: null,
        });
        const chosen = answer?.answers?.database?.answers ?? [];
        await this.say(chosen.length > 0 ? `You chose: ${chosen.join(', ')}.` : 'You left the choice to me.');
        return;
      }
      case 'permissions': {
        // Shape from the schema (`item/permissions/requestApproval`).
        const answer = await this.server.ask('item/permissions/requestApproval', { threadId: this.thread.id, turnId: this.id, itemId: nextId('call'), environmentId: 'local', startedAtMs: now(), cwd: this.thread.cwd, reason: 'The stand-in would like to write anywhere.', permissions: { network: { enabled: true }, fileSystem: { read: null, write: ['/'] } } });
        const granted = answer?.permissions ?? {};
        await this.say(Object.keys(granted).length === 0 ? 'No wider permissions were granted.' : `Wider permissions were granted: ${JSON.stringify(granted)}`);
        return;
      }
      case 'sub-agent': {
        const id = nextId('call');
        const childThread = uuid();
        const childTurn = uuid();
        const call = { type: 'collabAgentToolCall', id, tool: 'spawnAgent', status: 'inProgress', senderThreadId: this.thread.id, receiverThreadIds: [], prompt: 'Look into the tests.', model: '', reasoningEffort: 'medium', agentsStates: {} };
        this.item('started', call);
        this.item('completed', { ...call, status: 'completed', receiverThreadIds: [childThread], model: this.thread.model, agentsStates: { [childThread]: { status: 'pendingInit', message: null } } });
        const child = (method, params) => this.server.notify(method, { threadId: childThread, turnId: childTurn, ...params });
        this.server.notify('turn/started', { threadId: childThread, turn: { id: childTurn, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: seconds(), completedAt: null, durationMs: null } });
        const message = { type: 'agentMessage', id: nextId('msg'), text: '', phase: null, memoryCitation: null, delivery: null, questions: null };
        child('item/started', { item: message, startedAtMs: now() });
        child('item/agentMessage/delta', { itemId: message.id, delta: 'The tests look fine.' });
        child('item/completed', { item: { ...message, text: 'The tests look fine.' }, completedAtMs: now() });
        // The sub-agent's turn ends on its own thread — which must not end the run.
        this.server.notify('turn/completed', { threadId: childThread, turn: { id: childTurn, items: [], itemsView: 'notLoaded', status: 'completed', error: null, startedAt: seconds(), completedAt: seconds(), durationMs: 5 } });
        await this.pause(30);
        await this.say('My sub-agent reports that the tests look fine.');
        return;
      }
      case 'inspect': {
        const paths = (argument || '').split(/\s+/).filter(Boolean);
        const readable = (file) => {
          try {
            return fs.readFileSync(file).length;
          } catch {
            return null;
          }
        };
        const size = (file) => {
          try {
            return fs.statSync(file).size;
          } catch {
            return null;
          }
        };
        let rules;
        try {
          rules = fs.readdirSync(path.join(CODEX_HOME, 'rules'));
        } catch {
          rules = [];
        }
        const token = process.env.STUDIO_BRIDGE_TOKEN ?? '';
        await this.say(
          JSON.stringify({
            cwd: process.cwd(),
            argv: process.argv.slice(2),
            environment: Object.keys(process.env).sort(),
            tokenInArguments: token !== '' && process.argv.some((argument_) => argument_.includes(token)),
            model: this.thread.model,
            effort: this.params.effort ?? null,
            approvalPolicy: this.thread.approvalPolicy,
            approvalsReviewer: this.thread.approvalsReviewer,
            sandbox: this.thread.sandbox,
            developerInstructions: this.thread.developerInstructions,
            mcpServers: Object.fromEntries(Object.entries(this.config.mcp_servers ?? {}).map(([name, value]) => [name, { command: value.command ?? null, args: value.args ?? null, enabled: value.enabled !== false }])),
            features: this.config.features ?? {},
            home: {
              configBytes: size(path.join(CODEX_HOME, 'config.toml')),
              hooksBytes: size(path.join(CODEX_HOME, 'hooks.json')),
              agentsBytes: size(path.join(CODEX_HOME, 'AGENTS.md')),
              overrideBytes: size(path.join(CODEX_HOME, 'AGENTS.override.md')),
              rules,
            },
            instructionSources: instructionSources(this.thread.cwd),
            images: this.images.map((file) => ({ path: file, bytes: readable(file) })),
            readable: Object.fromEntries(paths.map((file) => [file, readable(file) !== null])),
            bytes: Object.fromEntries(paths.map((file) => [file, readable(file)])),
          }),
        );
        return;
      }
      case 'compact': {
        const id = nextId('compact');
        this.item('started', { type: 'contextCompaction', id });
        this.item('completed', { type: 'contextCompaction', id });
        await this.say('I made room and carried on.');
        return;
      }
      case 'retry':
        for (const attempt of [1, 2]) {
          this.server.notify('error', { error: { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: 'stream disconnected before completion: Transport error: network error: error decoding response body', misalignment: null }, willRetry: true, threadId: this.thread.id, turnId: this.id });
          await this.pause(10);
        }
        await this.say('The connection came back and here is the answer.');
        return;
      case 'warning':
        this.server.notify('warning', { threadId: this.thread.id, message: 'Model metadata for `standin-large` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' });
        await this.say('That was a warning; the answer is unaffected.');
        return;
      case 'rename':
        this.server.notify('thread/name/updated', { threadId: this.thread.id, threadName: argument || 'A better name' });
        await this.say('I gave this conversation a name.');
        return;
      case 'unknown-event': {
        this.server.notify('thread/somethingNew/happened', { threadId: this.thread.id, detail: { nested: true } });
        this.item('started', { type: 'holographicProjection', id: nextId('holo'), brightness: 11 });
        this.note('item/agentMessage/delta', { itemId: 42, delta: { not: 'a string' } });
        const answer = await this.server.ask('item/futureThing/requestApproval', { threadId: this.thread.id, something: true });
        await this.say(answer === null ? 'The client declined a request it did not know, as it should.' : 'The client answered a request it cannot know.');
        return;
      }
      case 'noise':
        // Valid JSON that is no message at all.
        process.stdout.write('"just a string"\n[1,2,3]\n{"neither":"request nor response"}\n\n');
        await this.say('I printed some JSON that is not a message.');
        return;
      case 'stubborn':
        this.server.stubborn = true;
        process.on('SIGTERM', () => {});
        await this.say('I will not stop. ', { chunks: 1 });
        // Never finishes: only SIGKILL ends it.
        await new Promise(() => {});
        return;
      // ---- failures ----
      case 'not-signed-in':
        this.fail({ message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: 0000000000000000-LHR, request id: req_00000000000000000000000000000000', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null, misalignment: null });
        return;
      case 'usage-limit':
        this.fail({ message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 14th, 2026 6:46 PM.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null });
        return;
      case 'model-unavailable':
        this.fail({ message: `{"error":{"message":"The model \`${this.thread.model}\` does not exist or you do not have access to it.","type":"invalid_request_error","param":"model","code":"model_not_found"}}`, codexErrorInfo: 'other', additionalDetails: null, misalignment: null });
        return;
      case 'stream-lost':
        this.fail({ message: 'stream disconnected before completion: Transport error: network error: error decoding response body', codexErrorInfo: 'other', additionalDetails: null, misalignment: null });
        return;
      case 'fail-turn':
        this.fail({ message: argument || 'something went wrong inside the stand-in', codexErrorInfo: 'other', additionalDetails: null, misalignment: null });
        return;
      case 'crash': {
        const id = nextId('msg');
        this.item('started', { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null });
        this.note('item/agentMessage/delta', { itemId: id, delta: 'I was in the middle of ' });
        process.stderr.write('\u001b[31mERROR\u001b[0m codex_core: thread main panicked at the stand-in\napi_key=sk-standin0123456789abcdef0123456789\n');
        await sleep(20);
        process.exit(3);
        return;
      }
      case 'garbage': {
        const id = nextId('msg');
        this.item('started', { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null });
        this.note('item/agentMessage/delta', { itemId: id, delta: 'Before the nonsense. ' });
        process.stdout.write('this line is <<<not JSON>>>\n');
        await sleep(2000);
        return;
      }
      case 'die': {
        const id = nextId('msg');
        this.item('started', { type: 'agentMessage', id, text: '', phase: null, memoryCitation: null, delivery: null, questions: null });
        this.note('item/agentMessage/delta', { itemId: id, delta: 'Cut off mid-' });
        await sleep(20);
        process.kill(process.pid, 'SIGKILL');
        await sleep(1000);
        return;
      }
      default:
        await this.say(`The Codex stand-in has no scenario called "${name}".`);
    }
  }

  async run() {
    const { server, thread } = this;
    server.notify('thread/status/changed', { threadId: thread.id, status: { type: 'active', activeFlags: [] } });
    server.notify('turn/started', { threadId: thread.id, turn: this.view('inProgress') });
    const userItem = { type: 'userMessage', id: uuid(), clientId: null, content: this.params.input ?? [] };
    this.item('started', userItem);
    this.item('completed', userItem);
    thread.items.push({ role: 'user', text: this.text });
    thread.turns += 1;

    let status = 'completed';
    let error = null;
    try {
      if (control().signedIn === false) this.fail({ message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } }, additionalDetails: null, misalignment: null });
      if (/^unknown/.test(thread.model)) await this.play('model-unavailable', '');
      const scenarios = [...this.text.matchAll(SCENARIO)].map((match) => ({ name: match[1], argument: (match[2] ?? '').trim() }));
      if (scenarios.length === 0) {
        const said = this.text.replace(/\s+/g, ' ').trim();
        await this.say(`Hello from the Codex stand-in. You said: ${said.length > 200 ? `${said.slice(0, 200)}…` : said}`);
      }
      for (const scenario of scenarios) {
        this.check();
        await this.play(scenario.name, scenario.argument);
      }
    } catch (caught) {
      if (caught instanceof Interrupted) status = 'interrupted';
      else if (caught instanceof TurnFailed) {
        status = 'failed';
        error = this.failure;
        server.notify('error', { error, willRetry: false, threadId: thread.id, turnId: this.id });
      } else {
        status = 'failed';
        error = { message: `the stand-in itself failed: ${caught?.message ?? caught}`, codexErrorInfo: 'other', additionalDetails: null, misalignment: null };
      }
    }
    this.finished = true;
    saveThread(thread);
    server.notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } });
    server.notify('turn/completed', { threadId: thread.id, turn: this.view(status, error) });
  }
}

class TurnFailed extends Error {}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

function usage() {
  process.stderr.write('The Codex stand-in knows: codex --version | codex login status | codex app-server [-c key=value]…\n');
  process.exit(2);
}

export async function main(argv) {
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write(`codex-cli ${control().version ?? VERSION}\n`);
    return;
  }
  const overrides = [];
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '-c' || argument === '--config') {
      const override = parseOverride(argv[index + 1] ?? '');
      if (override) overrides.push(override);
      index += 1;
    } else if (argument === '--enable' || argument === '--disable') {
      overrides.push({ path: ['features', argv[index + 1] ?? ''], value: argument === '--enable' });
      index += 1;
    } else positional.push(argument);
  }

  if (positional[0] === 'login' && positional[1] === 'status') {
    // The real CLI writes this to the error stream.
    if (control().signedIn === false) {
      process.stderr.write('Not logged in\n');
      process.exitCode = 1;
    } else process.stderr.write('Logged in using ChatGPT\n');
    return;
  }
  if (positional[0] !== 'app-server' || positional.length > 1) usage();

  const state = control();
  record({ event: 'app-server', argv, cwd: process.cwd(), environment: Object.keys(process.env).sort() });
  if (typeof state.startupError === 'string') {
    process.stderr.write(`Error: ${state.startupError}\n`);
    process.exit(1);
  }
  // Like the real CLI, a configuration that cannot be loaded ends the process before it says anything.
  try {
    const { effective } = configuration(overrides, process.cwd());
    for (const [name, definition] of Object.entries(effective.mcp_servers ?? {})) {
      if (definition === null || typeof definition !== 'object' || (typeof definition.command !== 'string' && typeof definition.url !== 'string')) {
        process.stderr.write(`Error: invalid transport\nin \`mcp_servers.${name}\`\n\n`);
        process.exit(1);
      }
    }
  } catch (error) {
    process.stderr.write(`Error: failed to load configuration: ${error.message}\n`);
    process.exit(1);
  }

  const server = new AppServer(overrides);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() !== '') void server.line(line);
  });
  // The client closing our input is the end of the connection.
  lines.on('close', () => {
    if (!server.stubborn) server.shutdown(0);
  });
  process.on('SIGTERM', () => {
    if (!server.stubborn) server.shutdown(143);
  });
}
