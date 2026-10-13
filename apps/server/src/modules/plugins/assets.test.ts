import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPlainAssetPath, panelContentSecurityPolicy, panelContentType, panelHeaders, readPanelAsset } from './assets.js';

describe('panel response headers', () => {
  const base = 'https://studio.example.com/api/plugins/panel/TOKEN/';

  it('is exactly the intended policy', () => {
    expect(panelContentSecurityPolicy(base)).toBe(
      [
        'sandbox allow-scripts allow-forms',
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
      ].join('; '),
    );
  });

  it('never allows same-origin, inline code, eval, wildcards or other schemes', () => {
    const policy = panelContentSecurityPolicy(base);
    for (const forbidden of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'unsafe-inline', 'unsafe-eval', "'self' ", '*', 'https:;', 'blob:', 'http://']) {
      expect(policy.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('sets the three headers that differ from the rest of the server, and no more', () => {
    expect(panelHeaders(base, 'text/css; charset=utf-8')).toEqual({
      'content-type': 'text/css; charset=utf-8',
      'content-security-policy': panelContentSecurityPolicy(base),
      'cross-origin-resource-policy': 'cross-origin',
      'x-frame-options': 'SAMEORIGIN',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
  });
});

describe('which files a panel is served', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['lib/mod.mjs', 'text/javascript; charset=utf-8'],
    ['style.CSS', 'text/css; charset=utf-8'],
    ['data.json', 'application/json; charset=utf-8'],
    ['logo.svg', 'image/svg+xml'],
    ['photo.JPG', 'image/jpeg'],
    ['font.woff2', 'font/woff2'],
  ])('serves %s as %s', (file, type) => {
    expect(panelContentType(file)).toBe(type);
  });

  it.each(['run.sh', 'page.php', 'archive.zip', 'addon.node', 'module.wasm', 'app.js.map', 'doc.pdf', 'index.htm', 'page.xhtml', 'legacy.swf', 'noextension', 'feed.xml', 'app.ts'])(
    'does not serve %s',
    (file) => {
      expect(panelContentType(file)).toBeNull();
    },
  );

  it.each(['../plugin.json', '..', '.', './index.html', '/etc/passwd', '//evil.test/x.js', 'a/../b.js', 'a//b.js', 'a/./b.js', '.env', '.git/config', 'a/.hidden.js', 'a\\b.js', 'a\u0000.js', '%2e%2e/x.js', 'a/%2e%2e/b.js', 'x.js?y', 'x.js#y', 'C:/x.js', 'trailing/', 'dot./x.js', '', 'a'.repeat(301)])(
    'does not consider %j a plain path',
    (requested) => {
      expect(isPlainAssetPath(requested)).toBe(false);
    },
  );

  it('considers ordinary relative paths plain', () => {
    for (const requested of ['index.html', 'js/app.js', 'img/logo 2.png', '@studio/panel.js', 'a/b/c/d.css', 'under_score-dash.js']) {
      expect(isPlainAssetPath(requested), requested).toBe(true);
    }
  });
});

describe('readPanelAsset', () => {
  let root: string;
  let panel: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'plugin-assets-'));
    panel = path.join(root, 'plugin', 'panel');
    await mkdir(path.join(panel, 'js'), { recursive: true });
    await writeFile(path.join(panel, 'index.html'), '<!doctype html>');
    await writeFile(path.join(panel, 'js', 'app.js'), 'export {};');
    await writeFile(path.join(panel, 'notes.md'), '# not served');
    await writeFile(path.join(root, 'plugin', 'plugin.json'), '{}');
    await writeFile(path.join(root, 'plugin', 'server.js'), 'secret server code');
    await writeFile(path.join(root, 'outside.js'), 'outside');
    await symlink(path.join(root, 'outside.js'), path.join(panel, 'escape.js'));
    await symlink(path.join(root, 'plugin'), path.join(panel, 'up'));
    await mkdir(path.join(panel, 'folder.js'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads files of the panel folder', async () => {
    expect(await readPanelAsset(panel, 'index.html')).toMatchObject({ contentType: 'text/html; charset=utf-8' });
    expect((await readPanelAsset(panel, 'js/app.js'))?.body.toString()).toBe('export {};');
  });

  it.each(['../plugin.json', '../server.js', '../../outside.js', 'js/../../server.js', 'notes.md', 'missing.js', 'escape.js', 'up/server.js', 'up/plugin.json', 'folder.js', 'js', '/etc/passwd', 'index.html/', 'index.html/x.js'])(
    'returns nothing for %s',
    async (requested) => {
      expect(await readPanelAsset(panel, requested)).toBeNull();
    },
  );
});
