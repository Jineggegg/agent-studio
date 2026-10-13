import { accessSync, constants, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PluginIsolation, PluginIsolationLevel } from '@agent-studio/protocol';
import type { ModuleContext } from '../../kernel/module.js';
import type { SdkLocation } from './sdk-install.js';

/**
 * How a plugin process is contained, and an honest account of how well.
 *
 * Two layers, each tried for real before it is believed:
 *
 * 1. **bubblewrap** (`isolate` profile): the process starts in an empty file
 *    system that holds the system's program folders, the Node binary, the
 *    plugin's code and the SDK (all read-only) and the plugin's data folder.
 *    No home directory, no /etc, no /run, no network namespace shared with the
 *    host, no other process in sight.
 * 2. **Node's permission model**: the runtime itself refuses file access
 *    outside the same folders, child processes, worker threads, native
 *    add-ons and WASI. On the Node versions this server supports it does not
 *    cover the network, and Node's own documentation says it is a seat belt
 *    for honest code rather than a wall against hostile code.
 *
 * With both, a plugin is `sandboxed`. With only the second it is `restricted`
 * — and the status says so in as many words. With neither it does not run
 * unless the operator has insisted.
 */

export const ISOLATION_RANK: Readonly<Record<PluginIsolationLevel, number>> = { none: 0, restricted: 1, sandboxed: 2 };

export interface LaunchRequest {
  /** The plugin's code. Read-only to the process. */
  readonly pluginDir: string;
  /** The only folder the process may write to. */
  readonly dataDir: string;
  /** Absolute path of the server entry inside `pluginDir`. */
  readonly entry: string;
  /** The owner granted `network`: the process keeps the machine's network. */
  readonly network: boolean;
  readonly memoryMb: number;
}

export interface Launch {
  readonly file: string;
  readonly args: string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}

export interface IsolationOptions {
  /** Test seam: leave Node's permission flags out, to prove what bubblewrap does alone. Never set from configuration. */
  readonly nodePermissions: boolean;
}

interface Probed {
  readonly bubblewrap: boolean;
  readonly bubblewrapProblem: string | null;
  /** The flag that turns the permission model on, when this Node has one that works. */
  readonly permissionFlag: string | null;
  /** This Node's permission model also covers the network. */
  readonly permissionCoversNetwork: boolean;
}

export class Isolation {
  readonly #context: ModuleContext;
  readonly #sdk: SdkLocation;
  readonly #options: IsolationOptions;
  readonly #node: string;
  readonly #located = new Map<string, string>();
  #probe: Promise<Probed> | null = null;
  #probed: Probed | null = null;

  constructor(context: ModuleContext, sdk: SdkLocation, options: IsolationOptions) {
    this.#context = context;
    this.#sdk = sdk;
    this.#options = options;
    // The real file, so that binding it into an empty root needs no chain of links.
    this.#node = realpathSync(process.execPath);
  }

  /** Runs both layers once with a harmless program and remembers what actually worked. */
  #detect(): Promise<Probed> {
    this.#probe ??= (async () => {
      const { sandbox, processes } = this.#context;
      const env = this.#env(this.#sdk.modulesDir);

      let bubblewrap = false;
      let bubblewrapProblem: string | null = sandbox.status.mode === 'bwrap' ? null : (sandbox.status.reason ?? 'bubblewrap is not in use.');
      if (sandbox.status.mode === 'bwrap') {
        try {
          const command = sandbox.wrap(this.#node, ['-e', 'process.stdout.write("studio-probe-ok")'], {
            kind: 'isolate',
            readable: [this.#node, this.#sdk.modulesDir],
            writable: [],
            network: false,
          });
          const result = await processes.run(this.#locate(command.file), command.args, { env, timeoutMs: 10_000, maxOutputBytes: 4096 });
          bubblewrap = result.code === 0 && result.stdout === 'studio-probe-ok';
          if (!bubblewrap) bubblewrapProblem = (result.stderr.trim().split('\n')[0] ?? '').slice(0, 200) || `exit ${result.code}`;
        } catch (error) {
          bubblewrapProblem = error instanceof Error ? error.message : 'bubblewrap could not be started.';
        }
      }

      let permissionFlag: string | null = null;
      if (this.#options.nodePermissions) {
        const flags = process.allowedNodeEnvironmentFlags;
        const candidate = flags.has('--permission') ? '--permission' : flags.has('--experimental-permission') ? '--experimental-permission' : null;
        if (candidate) {
          try {
            // Allowed to read the SDK folder and nothing else: reading its own binary must be refused.
            const script =
              'const fs=require("node:fs");let own="read";try{fs.readFileSync(process.execPath)}catch{own="denied"}' +
              'let child="started";try{require("node:child_process").spawnSync("true")}catch{child="denied"}' +
              'process.stdout.write(own+":"+child)';
            const result = await processes.run(this.#node, [candidate, `--allow-fs-read=${this.#sdk.modulesDir}`, '-e', script], {
              env,
              timeoutMs: 10_000,
              maxOutputBytes: 4096,
            });
            if (result.code === 0 && result.stdout === 'denied:denied') permissionFlag = candidate;
          } catch {
            /* the flag exists but does not work here: treat it as absent */
          }
        }
      }

      const probed: Probed = {
        bubblewrap,
        bubblewrapProblem,
        permissionFlag,
        permissionCoversNetwork: permissionFlag !== null && process.allowedNodeEnvironmentFlags.has('--allow-net'),
      };
      this.#probed = probed;
      return probed;
    })();
    return this.#probe;
  }

  /** What is in force on this machine, for the owner and for every decision that depends on it. */
  async state(): Promise<PluginIsolation> {
    const probed = await this.#detect();
    const nodePermissions = probed.permissionFlag !== null;
    const level: PluginIsolationLevel = probed.bubblewrap ? 'sandboxed' : nodePermissions ? 'restricted' : 'none';
    const unsandboxedAllowed = this.#context.config.pluginsUnsandboxed;

    let detail: string;
    if (level === 'sandboxed') {
      detail = nodePermissions
        ? "Plugin code runs in a bubblewrap sandbox that contains only its own files, with no network and no view of other processes, and under Node's permission model inside it."
        : "Plugin code runs in a bubblewrap sandbox that contains only its own files, with no network and no view of other processes. Node's permission model is not available as a second layer.";
    } else if (level === 'restricted') {
      detail =
        `bubblewrap is not usable here (${probed.bubblewrapProblem ?? 'unknown reason'}), so plugin code is held back only by Node's permission model: ` +
        'no files outside its own folders, no child processes, no native add-ons. ' +
        (probed.permissionCoversNetwork ? '' : 'It CAN open network connections, including to services on this machine, and can signal other processes of this account. ') +
        'Node does not promise that this layer withstands code written to break out. Install bubblewrap for real isolation.';
    } else {
      detail =
        `Neither bubblewrap (${probed.bubblewrapProblem ?? 'unknown reason'}) nor Node's permission model is available, so plugin code cannot be isolated at all. ` +
        (unsandboxedAllowed
          ? 'The operator has allowed running plugins unsandboxed: a plugin with server code can do anything this server can.'
          : 'Plugins with server code cannot be enabled. (An operator can override this with AGENT_STUDIO_PLUGINS_UNSANDBOXED=on, at the price of giving plugins everything this server can do.)');
    }

    return {
      level,
      bubblewrap: probed.bubblewrap,
      nodePermissions,
      restricts: {
        files: level !== 'none',
        processes: nodePermissions,
        network: probed.bubblewrap || probed.permissionCoversNetwork,
        otherProcesses: probed.bubblewrap,
      },
      unsandboxedAllowed,
      detail,
    };
  }

  /**
   * Where a program named on the server's PATH really is. The launcher is
   * started by its full path, so that the server's PATH — which names folders
   * of the account the server runs as — need not be handed to a plugin.
   */
  #locate(file: string): string {
    if (path.isAbsolute(file)) return file;
    const known = this.#located.get(file);
    if (known) return known;
    for (const directory of (this.#context.processes.env().PATH ?? '/usr/bin:/bin').split(':')) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.join(directory, file);
      try {
        accessSync(candidate, constants.X_OK);
        this.#located.set(file, candidate);
        return candidate;
      } catch {
        /* not in this folder */
      }
    }
    return file;
  }

  /** A deliberately small environment: nothing inherited that was not chosen here. */
  #env(home: string): Record<string, string> {
    const base = this.#context.processes.env();
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      LANG: base.LANG ?? 'C.UTF-8',
      NO_COLOR: '1',
    };
    if (base.TZ) env.TZ = base.TZ;
    return env;
  }

  /** The command that starts a plugin's server code under the isolation in force. Call {@link state} first. */
  launch(request: LaunchRequest): Launch {
    const probed = this.#probed;
    if (!probed) throw new Error('Isolation.state() must be awaited before launch().');

    const args: string[] = [`--max-old-space-size=${request.memoryMb}`, '--no-addons'];
    if (probed.permissionFlag) {
      args.push(
        probed.permissionFlag,
        `--allow-fs-read=${request.pluginDir}`,
        `--allow-fs-read=${this.#sdk.modulesDir}`,
        `--allow-fs-read=${this.#sdk.packageJson}`,
        `--allow-fs-read=${request.dataDir}`,
        `--allow-fs-write=${request.dataDir}`,
      );
      if (request.network && probed.permissionCoversNetwork) args.push('--allow-net');
    }
    args.push(request.entry);

    const env = this.#env(request.dataDir);
    if (!probed.bubblewrap) return { file: this.#node, args, env, cwd: request.dataDir };

    const command = this.#context.sandbox.wrap(this.#node, args, {
      kind: 'isolate',
      readable: [this.#node, request.pluginDir, this.#sdk.modulesDir, this.#sdk.packageJson],
      writable: [request.dataDir],
      network: request.network,
    });
    return { file: this.#locate(command.file), args: command.args, env, cwd: request.dataDir };
  }
}
