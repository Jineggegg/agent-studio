import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { PLUGIN_PANEL_SANDBOX } from '@agent-studio/protocol';
import { confine } from '../../kernel/paths.js';

/**
 * Serving a panel's files.
 *
 * The files are whatever a plugin author put there, so the response itself has
 * to make them harmless: the policy below turns the page into a document with
 * an opaque origin that can load scripts, styles, images and fonts from its
 * own folder and can connect to nothing at all.
 */

/** The only kinds of file a panel is served. Everything else answers "not found". */
export const PANEL_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const MAX_PANEL_ASSET_BYTES = 8 * 1024 * 1024;

/** Where the Studio's own panel helper is served, next to every panel's page. */
export const PANEL_SDK_PATH = '@studio/panel.js';

/**
 * The policy every panel file is served with. `base` is the address prefix of
 * this one grant, ending in a slash.
 *
 * - `sandbox allow-scripts allow-forms` — an opaque origin even if the page is
 *   opened outside the Studio's frame: no cookies, no storage, no same-origin
 *   access to the Studio. Scripts run; forms fire their events.
 * - `default-src 'none'` and the four lines after it — scripts, styles, images
 *   and fonts load from the grant's own folder only (and images from `data:`).
 *   The prefix is spelled out instead of `'self'` because a page with an
 *   opaque origin has no "self" every browser agrees on; it also keeps the
 *   page from loading anything else the Studio serves. No inline script, no
 *   `eval`.
 * - `connect-src 'none'` — no fetch, XHR, WebSocket, EventSource or beacon.
 * - `form-action 'none'` — a form cannot be posted anywhere either.
 * - `base-uri 'none'` — the page cannot re-point its relative addresses.
 * - `frame-ancestors 'self'` — only the Studio's own pages may embed it.
 * - `webrtc 'block'` — no peer connections, where the browser knows the directive.
 */
export function panelContentSecurityPolicy(base: string): string {
  return [
    `sandbox ${PLUGIN_PANEL_SANDBOX}`,
    "default-src 'none'",
    `script-src ${base}`,
    `style-src ${base}`,
    `img-src ${base} data:`,
    `font-src ${base}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
    "webrtc 'block'",
  ].join('; ');
}

/**
 * Headers of a panel file. Three of them replace what the server sends with
 * every other response, each for a reason:
 *
 * - `content-security-policy`: the Studio's own policy is for the Studio's
 *   pages; a panel gets the stricter one above.
 * - `cross-origin-resource-policy: cross-origin` (normally `same-origin`): the
 *   panel's page has an opaque origin, so to the browser its own script and
 *   style files are cross-origin loads, which `same-origin` would block.
 * - `x-frame-options: SAMEORIGIN` (normally `DENY`): the page exists to be
 *   framed — by the Studio only, as `frame-ancestors 'self'` also says.
 *
 * `access-control-allow-origin: *` is added because module scripts and fonts
 * are fetched with CORS, again from an opaque origin. The response carries no
 * credentials and the address is unguessable, so this gives nothing away.
 */
export function panelHeaders(base: string, contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': panelContentSecurityPolicy(base),
    'cross-origin-resource-policy': 'cross-origin',
    'x-frame-options': 'SAMEORIGIN',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  };
}

/** The content type for a requested path, or null when its kind is not served. */
export function panelContentType(requested: string): string | null {
  return PANEL_CONTENT_TYPES[path.posix.extname(requested).toLowerCase()] ?? null;
}

/**
 * True when a requested path is plain enough to look at further: relative,
 * forward slashes only, no empty, `.` or `..` segment, nothing hidden, no
 * characters outside a conservative set. The file system check comes after.
 */
export function isPlainAssetPath(requested: string): boolean {
  if (requested.length === 0 || requested.length > 300) return false;
  return requested.split('/').every((segment) => /^[A-Za-z0-9_@][A-Za-z0-9._@ -]*$/.test(segment) && !segment.endsWith('.'));
}

/** Reads a panel file from `root`, or returns null for anything that is not an ordinary, allowed file inside it. */
export async function readPanelAsset(root: string, requested: string): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isPlainAssetPath(requested)) return null;
  const contentType = panelContentType(requested);
  if (!contentType) return null;
  let real: string;
  try {
    real = await confine(root, requested);
  } catch {
    return null;
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_PANEL_ASSET_BYTES) return null;
    return { body: await handle.readFile(), contentType };
  } finally {
    await handle.close();
  }
}
