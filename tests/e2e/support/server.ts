import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_BIN, SETUP_TOKEN, WEB_DIR, repoRoot, runRoot } from './env.js';

/**
 * Starts the demo server (the real server plus the scripted demo agents) from
 * its TypeScript sources, serving the built web client, with a data directory,
 * a workspace and a home directory that exist only for this run. `stop()`
 * ends the server and deletes all three.
 */

export interface StudioServer {
  readonly url: string;
  readonly port: number;
  /** Data, workspace and home live under here. */
  readonly root: string;
  /** The server's only workspace root. */
  readonly workspace: string;
  /** Everything the server printed, when its output was captured. */
  output(): string;
  /** Settles with the exit code when the server process ends, for whatever reason. */
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface StartOptions {
  readonly port: number;
  /** `inherit` passes the server's output through (the launcher); `capture` keeps it for error messages (specs). */
  readonly output?: 'inherit' | 'capture';
}

/** How long a demo approval or question waits before the server answers it by itself. Short, so nothing a test leaves waiting outlives the run by much. */
const APPROVAL_TTL_MS = 120_000;
const QUESTION_TTL_MS = 60_000;

export async function startStudioServer({
  port,
  output = 'capture',
}: StartOptions): Promise<StudioServer> {
  if (!existsSync(path.join(WEB_DIR, 'index.html'))) {
    throw new Error(
      `There is no client build in ${WEB_DIR}. Run "npm run build" first, or point E2E_WEB_DIR at a build.`,
    );
  }
  const url = `http://127.0.0.1:${port}`;
  // Something already answering there (a server left over from a killed run) would be mistaken for this one.
  const taken = await fetch(`${url}/api/health`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`Port ${port} is already in use; stop whatever listens there first.`);

  const root = runRoot(port);
  // Every run starts from nothing, also after a run that was killed before it could clean up.
  rmSync(root, { recursive: true, force: true });
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  for (const directory of [dataDir, workspace, home]) mkdirSync(directory, { recursive: true });

  let printed = '';
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'apps/server/src/testing/demo-server.ts')],
    {
      cwd: repoRoot,
      env: {
        // A deliberately small environment: nothing of the shell that started the run leaks into the server.
        PATH: [FIXTURE_BIN, process.env.PATH].filter(Boolean).join(path.delimiter),
        HOME: home,
        LANG: 'C.UTF-8',
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        TSX_TSCONFIG_PATH: path.join(repoRoot, 'apps/server/tsconfig.json'),
        AGENT_STUDIO_ENV: 'test',
        AGENT_STUDIO_HOST: '127.0.0.1',
        AGENT_STUDIO_PORT: String(port),
        AGENT_STUDIO_DATA_DIR: dataDir,
        AGENT_STUDIO_WORKSPACE_ROOTS: workspace,
        AGENT_STUDIO_WEB_DIR: WEB_DIR,
        AGENT_STUDIO_SETUP_TOKEN: SETUP_TOKEN,
        AGENT_STUDIO_SANDBOX: 'off',
        AGENT_STUDIO_LOG_LEVEL: 'warn',
        AGENT_STUDIO_DEMO_APPROVAL_TTL_MS: String(APPROVAL_TTL_MS),
        AGENT_STUDIO_DEMO_QUESTION_TTL_MS: String(QUESTION_TTL_MS),
      },
      stdio: output === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => (printed += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (printed += chunk.toString()));

  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code) => resolve(code)),
  );
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(force);
      }
      rmSync(root, { recursive: true, force: true });
    })();
    return stopped;
  };

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      throw new Error(
        `The demo server exited during start-up (code ${child.exitCode}).\n${printed}`,
      );
    }
    const healthy = await fetch(`${url}/api/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (healthy) break;
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`The demo server did not answer on ${url} within 90 seconds.\n${printed}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { url, port, root, workspace, output: () => printed, exited, stop };
}
