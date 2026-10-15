import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const TERMINAL_PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64'];

// An independent download allow-list: review this pin when updating node-pty.
// The lockfile must agree with it, but cannot choose a network destination.
const TERMINAL_VERSION = '1.1.0';
const packages = TERMINAL_PLATFORMS.map((platform) => ({
  platform,
  url: `https://registry.npmjs.org/@lydell/node-pty-${platform}/-/node-pty-${platform}-${TERMINAL_VERSION}.tgz`,
}));

export function downloadTerminal(platform, entry) {
  const approved = packages.find((item) => item.platform === platform);
  if (!approved || entry?.version !== TERMINAL_VERSION || entry?.resolved !== approved.url) {
    throw new Error('The terminal lockfile entry does not match the approved npm package.');
  }
  if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity)) {
    throw new Error('The terminal lockfile entry must have a SHA-512 integrity hash.');
  }

  // Ignore curlrc, reject redirects and other protocols, and bound the request.
  // Only the independently approved URL is passed to curl, never lockfile data.
  const tarball = execFileSync('curl', [
    '--disable', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '0',
    '--proto', '=https', '--proto-redir', '=https', '--globoff',
    '--connect-timeout', '15', '--max-time', '120', '--url', approved.url,
  ], { maxBuffer: 64 * 1024 * 1024 });
  const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  if (actual !== entry.integrity) throw new Error('The terminal tarball does not match the lockfile integrity.');
  return tarball;
}
