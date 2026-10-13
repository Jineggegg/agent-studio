import os from 'node:os';
import path from 'node:path';

export type RuntimeEnv = 'development' | 'production' | 'test';
export type SandboxMode = 'auto' | 'bwrap' | 'off';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface StudioConfig {
  readonly env: RuntimeEnv;
  /** Interface to bind. Loopback by default: remote access goes through a tunnel or reverse proxy. */
  readonly host: string;
  /** 0 picks a free port (tests). */
  readonly port: number;
  /** Everything the server persists lives here; created with owner-only permissions. */
  readonly dataDir: string;
  /** Built web client to serve, or null to run API-only. */
  readonly webDir: string | null;
  /** Extra origins (scheme://host[:port]) the service is reachable at, e.g. a tunnel hostname. */
  readonly publicOrigins: readonly string[];
  /** Trust X-Forwarded-* from a proxy on the loopback interface. */
  readonly trustProxy: boolean;
  /** Directories a project's working directory must live under. */
  readonly workspaceRoots: readonly string[];
  readonly tls: { readonly certFile: string; readonly keyFile: string } | null;
  readonly sandbox: SandboxMode;
  readonly terminalEnabled: boolean;
  /** Operator-managed list of remote SSH hosts. Null means `remote-hosts.json` inside the data directory. */
  readonly remoteHostsFile: string | null;
  /** The one directory plugins may be installed from by path. Null turns installing from a directory off. */
  readonly pluginSourceDir: string | null;
  /** Let plugins with server code run when no isolation at all is available. Off unless the operator insists. */
  readonly pluginsUnsandboxed: boolean;
  readonly logLevel: LogLevel;
  /** Base64 of 32 bytes. When absent a key file is created inside the data directory. */
  readonly masterKey: string | null;
  /** Fixed first-run token for scripted installs. When absent one is generated and printed. */
  readonly setupToken: string | null;
  /** Names of environment variables that agent and terminal processes may inherit in addition to the baseline. */
  readonly childEnvPassthrough: readonly string[];
  readonly sessionIdleDays: number;
  readonly sessionMaxDays: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const ENV_PREFIX = 'AGENT_STUDIO_';
export const DEFAULT_PORT = 7420;

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return LOOPBACK_NAMES.has(name) || name.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(name);
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function flag(raw: string | undefined, fallback: boolean, name: string): boolean {
  if (raw === undefined || raw === '') return fallback;
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new ConfigError(`${name} must be on or off, got "${raw}".`);
}

function integer(raw: string | undefined, fallback: number, name: string, min: number, max: number) {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number between ${min} and ${max}, got "${raw}".`);
  }
  return value;
}

/** Normalises "https://studio.example.com/" to its origin and rejects anything with a path. */
export function parseOrigin(raw: string, name = 'origin'): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name}: "${raw}" is not a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${name}: "${raw}" must start with https:// or http://.`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new ConfigError(`${name}: "${raw}" must be a bare origin such as https://studio.example.com.`);
  }
  return url.origin;
}

export type ConfigOverrides = Partial<StudioConfig>;

/**
 * Reads configuration from AGENT_STUDIO_* variables only. Generic names such as
 * PORT, NODE_ENV or DATABASE_PATH are deliberately ignored so that a server
 * started from inside another service's shell can never pick up that service's
 * settings by accident.
 */
export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  overrides: ConfigOverrides = {},
): StudioConfig {
  const read = (key: string) => source[`${ENV_PREFIX}${key}`];

  const envName = read('ENV') ?? 'production';
  if (envName !== 'development' && envName !== 'production' && envName !== 'test') {
    throw new ConfigError(`${ENV_PREFIX}ENV must be development, production or test.`);
  }

  const sandbox = (read('SANDBOX') ?? 'auto').toLowerCase();
  if (sandbox !== 'auto' && sandbox !== 'bwrap' && sandbox !== 'off') {
    throw new ConfigError(`${ENV_PREFIX}SANDBOX must be auto, bwrap or off.`);
  }

  const logLevel = (read('LOG_LEVEL') ?? (envName === 'test' ? 'silent' : 'info')).toLowerCase();
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new ConfigError(`${ENV_PREFIX}LOG_LEVEL "${logLevel}" is not a log level.`);
  }

  const certFile = read('TLS_CERT');
  const keyFile = read('TLS_KEY');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError(`Set both ${ENV_PREFIX}TLS_CERT and ${ENV_PREFIX}TLS_KEY, or neither.`);
  }

  const masterKey = read('MASTER_KEY') ?? null;
  if (masterKey !== null && Buffer.from(masterKey, 'base64').length !== 32) {
    throw new ConfigError(`${ENV_PREFIX}MASTER_KEY must be 32 random bytes in base64.`);
  }

  const setupToken = read('SETUP_TOKEN') ?? null;
  if (setupToken !== null && setupToken.length < 16) {
    throw new ConfigError(`${ENV_PREFIX}SETUP_TOKEN must be at least 16 characters.`);
  }

  const dataDir = path.resolve(expandHome(read('DATA_DIR') ?? '~/.agent-studio'));
  const roots = list(read('WORKSPACE_ROOTS'));
  const workspaceRoots = (roots.length > 0 ? roots : [os.homedir()]).map((root) =>
    path.resolve(expandHome(root)),
  );

  const sessionIdleDays = integer(read('SESSION_IDLE_DAYS'), 30, `${ENV_PREFIX}SESSION_IDLE_DAYS`, 1, 365);
  const sessionMaxDays = integer(read('SESSION_MAX_DAYS'), 90, `${ENV_PREFIX}SESSION_MAX_DAYS`, 1, 730);

  const webDirRaw = read('WEB_DIR');
  const config: StudioConfig = {
    env: envName,
    host: read('HOST') ?? '127.0.0.1',
    port: integer(read('PORT'), DEFAULT_PORT, `${ENV_PREFIX}PORT`, 0, 65535),
    dataDir,
    webDir: webDirRaw === undefined ? null : webDirRaw === '' ? null : path.resolve(expandHome(webDirRaw)),
    publicOrigins: list(read('PUBLIC_ORIGINS')).map((raw) =>
      parseOrigin(raw, `${ENV_PREFIX}PUBLIC_ORIGINS`),
    ),
    trustProxy: flag(read('TRUST_PROXY'), false, `${ENV_PREFIX}TRUST_PROXY`),
    workspaceRoots,
    tls: certFile && keyFile ? { certFile: path.resolve(certFile), keyFile: path.resolve(keyFile) } : null,
    sandbox,
    terminalEnabled: flag(read('TERMINAL'), true, `${ENV_PREFIX}TERMINAL`),
    remoteHostsFile: read('REMOTE_HOSTS_FILE') ? path.resolve(expandHome(read('REMOTE_HOSTS_FILE')!)) : null,
    pluginSourceDir: read('PLUGIN_SOURCE_DIR') ? path.resolve(expandHome(read('PLUGIN_SOURCE_DIR')!)) : null,
    pluginsUnsandboxed: flag(read('PLUGINS_UNSANDBOXED'), false, `${ENV_PREFIX}PLUGINS_UNSANDBOXED`),
    logLevel: logLevel as LogLevel,
    masterKey,
    setupToken,
    childEnvPassthrough: list(read('CHILD_ENV_PASSTHROUGH')),
    sessionIdleDays,
    sessionMaxDays: Math.max(sessionMaxDays, sessionIdleDays),
    ...overrides,
  };

  for (const name of config.childEnvPassthrough) {
    if (name.startsWith(ENV_PREFIX)) {
      throw new ConfigError(`${name} can never be passed to agent processes.`);
    }
  }
  return config;
}
