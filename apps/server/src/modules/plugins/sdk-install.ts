import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Makes the plugin SDK available to plugin processes.
 *
 * A plugin imports `@agent-studio/plugin-sdk` like any package, yet ships no
 * `node_modules` and is never built or installed with a package manager. It
 * works because Node looks for packages in the folders above the importing
 * file: plugins live in `<data>/plugins/<id>/`, and the Studio keeps a copy of
 * the SDK in `<data>/plugins/node_modules/`. That copy is plain JavaScript, is
 * handed to a plugin process read-only, and is rewritten whenever it differs
 * from the SDK this server came with.
 *
 * The same folder gets a `package.json` that says `"type": "module"`, so a
 * plugin without a package manifest of its own has its `.js` files treated as
 * ES modules.
 */

export interface SdkLocation {
  /** `<plugins>/node_modules` — readable by every plugin process. */
  readonly modulesDir: string;
  /** `<plugins>/package.json` — readable by every plugin process. */
  readonly packageJson: string;
  /** The browser helper, served to panels. */
  readonly panelFile: string;
  readonly version: string;
}

const RUNTIME_FILES = ['plugin.js', 'framing.js', 'panel.js'] as const;

/** Finds the SDK package this server was installed with. */
async function findSdkPackage(): Promise<string> {
  const candidates: string[] = [];
  try {
    candidates.push(path.dirname(createRequire(import.meta.url).resolve('@agent-studio/plugin-sdk/package.json')));
  } catch {
    /* not resolvable as a package: fall back to the workspace layout */
  }
  candidates.push(fileURLToPath(new URL('../../../../../packages/plugin-sdk', import.meta.url)));
  for (const candidate of candidates) {
    if (await fs.stat(path.join(candidate, 'package.json')).then(() => true, () => false)) return candidate;
  }
  throw new Error('The plugin SDK package (@agent-studio/plugin-sdk) was not found next to the server.');
}

async function writeIfDifferent(file: string, content: Buffer | string): Promise<void> {
  const next = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const current = await fs.readFile(file).catch(() => null);
  if (current && current.equals(next)) return;
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, next, { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function installSdk(pluginsDir: string): Promise<SdkLocation> {
  const packageDir = await findSdkPackage();
  const version = (JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as { version: string }).version;
  // A source checkout carries the runtime as plain files under src; a published package under dist.
  let sourceDir = path.join(packageDir, 'src');
  if (!(await fs.stat(path.join(sourceDir, 'plugin.js')).then(() => true, () => false))) sourceDir = path.join(packageDir, 'dist');

  const modulesDir = path.join(pluginsDir, 'node_modules');
  const target = path.join(modulesDir, '@agent-studio', 'plugin-sdk');
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of RUNTIME_FILES) {
    await writeIfDifferent(path.join(target, name), await fs.readFile(path.join(sourceDir, name)));
  }
  await writeIfDifferent(path.join(target, 'index.js'), "export * from './plugin.js';\nexport * from './framing.js';\n");
  await writeIfDifferent(
    path.join(target, 'package.json'),
    JSON.stringify(
      {
        name: '@agent-studio/plugin-sdk',
        version,
        type: 'module',
        exports: { '.': './index.js', './panel': './panel.js' },
      },
      null,
      2,
    ) + '\n',
  );
  const packageJson = path.join(pluginsDir, 'package.json');
  await writeIfDifferent(packageJson, JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');
  return { modulesDir, packageJson, panelFile: path.join(target, 'panel.js'), version };
}
