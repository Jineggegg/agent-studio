import dns from 'node:dns';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_MANIFEST_FILE, type PluginManifest, type PluginSourceEntry } from '@agent-studio/protocol';
import { randomToken } from '../../kernel/crypto.js';
import { StudioError, badRequest, conflict, forbidden, unavailable, unprocessable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { checkUrl, isAddressAllowed } from '../../kernel/net.js';
import { confine } from '../../kernel/paths.js';
import { redactSecrets } from '../../kernel/redact.js';
import { checkManifestFiles, readManifest } from './manifest.js';
import type { StoredSource } from './store.js';
import { copyTree, hashTree, type TreeFile } from './tree.js';

/**
 * Getting a plugin's files onto this machine — and nothing more.
 *
 * Installing copies and checks. It never runs anything that came with the
 * plugin: no install scripts, no build step, no package manager, no Git hooks.
 * A plugin ships what it needs.
 */

/** A plugin's files, copied and validated, waiting to be moved into place. */
export interface StagedPlugin {
  /** A folder inside the plugins directory, so that moving it into place is a rename. */
  readonly directory: string;
  readonly manifest: PluginManifest;
  readonly files: readonly TreeFile[];
  readonly contentHash: string;
  readonly source: StoredSource;
  readonly commit: string | null;
}

export interface InstallerOptions {
  readonly pluginsDir: string;
  readonly gitTimeoutMs: number;
  /** Test seam: also accept `file://` repositories. Never set from configuration. */
  readonly allowLocalGit: boolean;
}

const GIT_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::\d{1,5})?\/[A-Za-z0-9._~/-]{1,300}$/;
const LOCAL_GIT_URL = /^file:\/\/\/[A-Za-z0-9._~/-]{1,400}$/;

/** Settings that keep `git clone` from doing anything but fetching one revision of one repository. */
const GIT_HARDENING = [
  'core.hooksPath=/dev/null',
  'core.symlinks=false',
  'core.autocrlf=false',
  'core.fsmonitor=false',
  'core.askPass=',
  'credential.helper=',
  'http.followRedirects=false',
  'http.lowSpeedLimit=1000',
  'http.lowSpeedTime=20',
  'submodule.recurse=false',
  'transfer.fsckObjects=true',
] as const;

export class PluginInstaller {
  readonly #context: ModuleContext;
  readonly #options: InstallerOptions;

  constructor(context: ModuleContext, options: InstallerOptions) {
    this.#context = context;
    this.#options = options;
  }

  get #stagingRoot(): string {
    return path.join(this.#options.pluginsDir, '.staging');
  }

  async #newStagingDir(): Promise<string> {
    await fs.mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
    return path.join(this.#stagingRoot, randomToken(12));
  }

  /** Copies `from` into a staging folder and checks that it is a plugin. */
  async #stage(from: string, source: StoredSource, commit: string | null): Promise<StagedPlugin> {
    const directory = await this.#newStagingDir();
    try {
      const files = await copyTree(from, directory);
      const manifest = await readManifest(directory);
      checkManifestFiles(manifest, files);
      return { directory, manifest, files, source, commit, contentHash: await hashTree(directory) };
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async discard(staged: StagedPlugin): Promise<void> {
    await fs.rm(staged.directory, { recursive: true, force: true });
  }

  /** Removes what an interrupted install left behind. */
  async cleanUp(): Promise<void> {
    await fs.rm(this.#stagingRoot, { recursive: true, force: true });
  }

  // ---- from a folder the operator set aside ---------------------------------

  #sourceDir(): string {
    const directory = this.#context.config.pluginSourceDir;
    if (!directory) {
      throw conflict(
        'Installing from a folder is turned off. An operator can set AGENT_STUDIO_PLUGIN_SOURCE_DIR to a folder of plugins.',
        'source_dir_not_configured',
      );
    }
    return directory;
  }

  async fromDirectory(name: string): Promise<StagedPlugin> {
    const root = this.#sourceDir();
    let real: string;
    try {
      real = await confine(root, name);
    } catch (error) {
      if (error instanceof StudioError) throw forbidden('That folder is not inside the plugin source directory.', 'path_outside_root');
      throw unprocessable('The plugin source directory does not exist.', 'source_dir_missing');
    }
    const stat = await fs.stat(real).catch(() => null);
    if (!stat?.isDirectory()) throw unprocessable(`There is no folder named "${name}" in the plugin source directory.`, 'source_not_found');
    return this.#stage(real, { kind: 'directory', name }, null);
  }

  /** The folders of the source directory, each with whether it could be installed. */
  async listSources(installed: ReadonlySet<string>): Promise<{ configured: boolean; entries: PluginSourceEntry[] }> {
    const root = this.#context.config.pluginSourceDir;
    if (!root) return { configured: false, entries: [] };
    const names = await fs.readdir(root).catch(() => [] as string[]);
    const entries: PluginSourceEntry[] = [];
    for (const name of names.sort().slice(0, 200)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
      const directory = path.join(root, name);
      const stat = await fs.lstat(directory).catch(() => null);
      if (!stat?.isDirectory()) continue;
      try {
        const manifest = await readManifest(directory);
        entries.push({
          name,
          valid: true,
          problem: null,
          id: manifest.id,
          title: manifest.name,
          version: manifest.version,
          description: manifest.description,
          installed: installed.has(manifest.id),
        });
      } catch (error) {
        entries.push({
          name,
          valid: false,
          problem: error instanceof StudioError ? error.message : `${PLUGIN_MANIFEST_FILE} could not be read.`,
          id: null,
          title: null,
          version: null,
          description: null,
          installed: false,
        });
      }
    }
    return { configured: true, entries };
  }

  // ---- from a Git repository ------------------------------------------------

  /**
   * Checks a repository address before anything is contacted, and resolves its
   * host once so that Git connects to the address that was vetted and to no
   * other (a second, different DNS answer cannot redirect the download inward).
   */
  async #vetGitUrl(raw: string): Promise<{ url: string; pin: string | null; local: string | null }> {
    if (this.#options.allowLocalGit && LOCAL_GIT_URL.test(raw)) {
      return { url: raw, pin: null, local: raw.slice('file://'.length) };
    }
    if (!GIT_URL.test(raw)) {
      throw badRequest(
        'Give a repository address of the form https://host/path. Other schemes, credentials, options and query strings are not accepted.',
        undefined,
        'invalid_git_url',
      );
    }
    const url = checkUrl(raw); // https only, no credentials, no private literal address
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) !== 0) return { url: raw, pin: null, local: null };
    let addresses: dns.LookupAddress[];
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch {
      throw unavailable(`The host "${host}" could not be found.`, 'git_host_unresolved');
    }
    if (addresses.length === 0 || addresses.some((entry) => !isAddressAllowed(entry.address, {}))) {
      throw forbidden('That address is not reachable from this server by policy.', 'address_not_allowed');
    }
    const first = addresses[0]!;
    const literal = first.family === 6 ? `[${first.address}]` : first.address;
    return { url: raw, pin: `${host}:${url.port || '443'}:${literal}`, local: null };
  }

  async #git(args: readonly string[], options: { writable: string; expose: string | null; network: boolean; cwd?: string }) {
    const { processes, sandbox } = this.#context;
    // Git runs sandboxed where that is possible: it may write to the clone folder and nowhere else.
    const command = sandbox.wrap('git', args, {
      kind: 'confine',
      writable: [options.writable],
      network: options.network,
      ...(options.expose ? { expose: [options.expose] } : {}),
    });
    return processes.run(command.file, command.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: this.#options.gitTimeoutMs,
      maxOutputBytes: 64 * 1024,
      env: processes.env({
        // No system or user configuration: no url rewrites, credential helpers, filters or hooks from there.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_ADVICE: '0',
        LC_ALL: 'C',
      }),
    });
  }

  async fromGit(rawUrl: string, ref: string | null): Promise<StagedPlugin> {
    const { url, pin, local } = await this.#vetGitUrl(rawUrl);
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-studio-plugin-'));
    const clone = path.join(work, 'clone');
    try {
      const settings = [
        'protocol.allow=never',
        local ? 'protocol.file.allow=always' : 'protocol.https.allow=always',
        ...GIT_HARDENING,
        ...(pin ? [`http.curloptResolve=${pin}`] : []),
      ];
      const args = [
        ...settings.flatMap((setting) => ['-c', setting]),
        'clone',
        '--depth=1',
        '--single-branch',
        '--no-tags',
        // An empty template: the new repository gets no hooks folder at all.
        '--template=',
        ...(ref ? [`--branch=${ref}`] : []),
        '--',
        url,
        clone,
      ];
      const cloned = await this.#git(args, { writable: work, expose: local, network: true });
      if (cloned.timedOut) throw unavailable('Downloading the repository took too long and was stopped.', 'git_timeout');
      if (cloned.code !== 0) {
        const lastLine = redactSecrets(cloned.stderr.trim().split('\n').at(-1) ?? '').slice(0, 300);
        throw new StudioError(502, 'git_clone_failed', `The repository could not be downloaded: ${lastLine || 'git reported no reason'}`);
      }
      const head = await this.#git(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD'], {
        writable: work,
        expose: null,
        network: false,
        cwd: clone,
      });
      const commit = /^[0-9a-f]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
      if (!commit) throw new StudioError(502, 'git_clone_failed', 'The downloaded repository has no commit to install.');
      return await this.#stage(clone, { kind: 'git', url, ref }, commit);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }
}
