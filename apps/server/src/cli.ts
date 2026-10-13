import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import type { StudioConfig } from './kernel/config.js';
import { hashPassword } from './kernel/crypto.js';
import { Database } from './kernel/database.js';
import { VERSION } from './kernel/version.js';

/**
 * Operator commands. They act on the data directory directly, so they work
 * when the service is stopped and when nobody can sign in — and they are only
 * available to someone with a shell on the host, which is the point.
 */

export const USAGE = `Agent Cloud Studio ${VERSION}

Usage: agent-studio [command]

Commands:
  start                      Run the server (default)
  status                     Show whether the server answers, and where its data lives
  setup-token                Print the one-time token for creating the first account
  reset-password <username>  Set a new password for an account and sign it out everywhere
  unlock                     Clear every sign-in lock
  version                    Print the version
  help                       Show this text

Configuration is read from AGENT_STUDIO_* environment variables; see docs/configuration.md.
`;

function openDatabase(config: StudioConfig): Database {
  const file = path.join(config.dataDir, 'studio.db');
  if (!existsSync(file)) throw new Error(`No Studio data found in ${config.dataDir}. Has the server ever been started with this data directory?`);
  return new Database(file);
}

/** Reads one line without echoing it when attached to a terminal. */
async function readSecret(prompt: string, input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  output.write(prompt);
  const reader = createInterface({ input, terminal: true });
  input.setRawMode?.(false);
  return new Promise<string>((resolve) => {
    // Suppress echo by swallowing what readline would write back.
    (reader as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
    reader.question('', (answer) => {
      reader.close();
      output.write('\n');
      resolve(answer);
    });
  });
}

export async function resetPassword(config: StudioConfig, username: string, newPassword: string): Promise<void> {
  if (newPassword.length < PASSWORD_MIN_LENGTH) throw new Error(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  if (newPassword.length > 256) throw new Error('Use at most 256 characters.');
  const db = openDatabase(config);
  try {
    const user = db.get<{ id: string }>('SELECT id FROM users WHERE username = ?', username);
    if (!user) throw new Error(`There is no account named "${username}".`);
    const hash = await hashPassword(newPassword);
    db.transaction(() => {
      db.run('UPDATE users SET password_hash = ?, disabled = 0, updated_at = ? WHERE id = ?', hash, Date.now(), user.id);
      db.run('DELETE FROM auth_sessions WHERE user_id = ?', user.id);
      db.run('DELETE FROM api_tokens WHERE user_id = ?', user.id);
      db.run('DELETE FROM auth_throttle');
    });
  } finally {
    db.close();
  }
}

export function unlock(config: StudioConfig): number {
  const db = openDatabase(config);
  try {
    return db.run('DELETE FROM auth_throttle').changes;
  } finally {
    db.close();
  }
}

export async function status(config: StudioConfig): Promise<{ running: boolean; url: string; dataDir: string; accounts: number | null }> {
  const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
  const url = `${config.tls ? 'https' : 'http'}://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
  const running = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
    (response) => response.ok,
    () => false,
  );
  let accounts: number | null = null;
  if (existsSync(path.join(config.dataDir, 'studio.db'))) {
    const db = openDatabase(config);
    try {
      accounts = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
    } catch {
      accounts = null;
    } finally {
      db.close();
    }
  }
  return { running, url, dataDir: config.dataDir, accounts };
}

/** Runs an operator command. Returns the process exit code, or null when the server should start. */
export async function runCommand(
  argv: readonly string[],
  config: () => StudioConfig,
  io: { input: NodeJS.ReadStream; output: NodeJS.WriteStream } = { input: process.stdin, output: process.stdout },
): Promise<number | null> {
  const [command = 'start', ...rest] = argv;
  const print = (text: string) => io.output.write(text + '\n');
  switch (command) {
    case 'start':
      return null;
    case 'help':
    case '--help':
    case '-h':
      print(USAGE);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      print(VERSION);
      return 0;
    case 'status': {
      const report = await status(config());
      print(`Server:     ${report.running ? `answering at ${report.url}` : `not answering at ${report.url}`}`);
      print(`Data:       ${report.dataDir}`);
      print(`Accounts:   ${report.accounts === null ? 'no data yet' : report.accounts === 0 ? 'none — first-run setup is pending' : report.accounts}`);
      return report.running ? 0 : 1;
    }
    case 'setup-token': {
      const file = path.join(config().dataDir, 'setup-token');
      if (!existsSync(file)) {
        print('There is no pending setup token: either setup is complete or the server has not been started yet.');
        return 1;
      }
      print(readFileSync(file, 'utf8').trim());
      return 0;
    }
    case 'reset-password': {
      const username = rest[0];
      if (!username) {
        print('Usage: agent-studio reset-password <username>');
        return 2;
      }
      const password = await readSecret(`New password for ${username}: `, io.input, io.output);
      await resetPassword(config(), username, password);
      print(`Password changed. "${username}" has been signed out everywhere and all sign-in locks are cleared.`);
      return 0;
    }
    case 'unlock': {
      const cleared = unlock(config());
      print(cleared === 0 ? 'Nothing was locked.' : `Cleared ${cleared} lock${cleared === 1 ? '' : 's'}.`);
      return 0;
    }
    default:
      print(`Unknown command "${command}".\n`);
      print(USAGE);
      return 2;
  }
}
