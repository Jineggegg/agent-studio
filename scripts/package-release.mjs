#!/usr/bin/env node
/**
 * Builds the release archive that `packaging/install.sh` installs: the built
 * server and web client with only their runtime dependencies, the terminal's
 * prebuilt binaries for every platform the installer supports, and the
 * `agent-studio` command. Run after `npm run build`, on Linux (GNU tar):
 *
 *   node scripts/package-release.mjs [--out dist-release]
 *
 * Writes `agent-studio-<version>.tar.gz`, a copy of `install.sh` and
 * `SHA256SUMS` into the output folder. The archive is reproducible for a given
 * commit: entries are sorted, owned by root and dated to the last commit.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadTerminal, TERMINAL_PLATFORMS } from './release-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = path.resolve(root, outIndex === -1 ? 'dist-release' : args[outIndex + 1]);

const PTY = '@lydell/node-pty';

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const name = `agent-studio-${version}`;
const stage = path.join(out, name);

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    ...options,
  });
}

function need(file, hint) {
  if (!existsSync(path.join(root, file))) {
    console.error(`${file} is missing. ${hint}`);
    process.exit(1);
  }
}

need('apps/server/dist/main.js', 'Run `npm run build` first.');
need('apps/web/dist/index.html', 'Run `npm run build` first.');
need('packages/protocol/dist/index.js', 'Run `npm run build` first.');
need('packages/plugin-sdk/dist/index.js', 'Run `npm run build` first.');

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// What runs. Source maps and compiled tests stay behind.
const runtimeOnly = (source) => !/\.(map|test\.js|test\.d\.ts)$/.test(source);
const copy = (from, to = from) =>
  cpSync(path.join(root, from), path.join(stage, to), { recursive: true, filter: runtimeOnly });
for (const entry of [
  'package.json',
  'package-lock.json',
  '.npmrc',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'docs/configuration.md',
  'docs/licenses/THIRD_PARTY_LICENSES.md',
  'apps/server/package.json',
  'apps/server/dist',
  'apps/web/package.json',
  'apps/web/dist',
  'packages/protocol/package.json',
  'packages/protocol/dist',
  'packages/plugin-sdk/package.json',
  'packages/plugin-sdk/dist',
]) {
  copy(entry);
}
copy('packaging/bin', 'bin');
chmodSync(path.join(stage, 'bin', 'agent-studio'), 0o755);
chmodSync(path.join(stage, 'bin', 'cloud-harness'), 0o755);

// Runtime dependencies of the server and the packages it loads, exactly as the lockfile pins them.
run(
  'npm',
  [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--workspace=@agent-studio/server',
    '--workspace=@agent-studio/protocol',
    '--workspace=@agent-studio/plugin-sdk',
  ],
  {
    cwd: stage,
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);

// npm installs the terminal binary of this machine only. The others come from the registry, each checked
// against the integrity the lockfile records for it.
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
for (const platform of TERMINAL_PLATFORMS) {
  const key = `node_modules/${PTY}-${platform}`;
  if (existsSync(path.join(stage, key))) continue;
  const entry = lock.packages[key];
  const tarball = downloadTerminal(platform, entry);
  const target = path.join(stage, key);
  mkdirSync(target, { recursive: true });
  execFileSync('tar', ['-xzf', '-', '-C', target, '--strip-components=1'], { input: tarball });
}

// Installing the web workspace was never asked for; its manifest is there only so that the lockfile matches.
rmSync(path.join(stage, 'node_modules', '@agent-studio', 'web'), { force: true, recursive: true });
writeFileSync(path.join(stage, 'VERSION'), `${version}\n`);

const epoch = run('git', ['log', '-1', '--format=%ct'], { cwd: root }).trim();
const archive = `${name}.tar.gz`;
run('tar', [
  '--sort=name',
  `--mtime=@${epoch}`,
  '--owner=0',
  '--group=0',
  '--numeric-owner',
  '-czf',
  path.join(out, archive),
  '-C',
  out,
  name,
]);
rmSync(stage, { recursive: true, force: true });

cpSync(path.join(root, 'packaging', 'install.sh'), path.join(out, 'install.sh'));
const sums = [archive, 'install.sh']
  .map(
    (file) =>
      `${createHash('sha256')
        .update(readFileSync(path.join(out, file)))
        .digest('hex')}  ${file}`,
  )
  .join('\n');
writeFileSync(path.join(out, 'SHA256SUMS'), `${sums}\n`);
console.log(`\n${path.relative(root, out)}/\n${sums}`);
