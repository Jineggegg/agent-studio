import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Frame, type Page } from '@playwright/test';
import type { AuthState, PluginPanelGrant } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, type TestClient } from '../../src/testing/harness.js';
import { EXAMPLE_PLUGIN, HOSTILE_PLUGIN, pluginStudio, type PluginTestStudio } from './plugins-fixtures/kit.js';

/**
 * The panel isolation, checked in a real browser.
 *
 * A minimal page served by the Studio plays the web client: it opens a panel
 * the way `packages/protocol/src/plugins.ts` says to, and relays its messages.
 * One panel is the example plugin's (it must work); the other is hostile (it
 * must get nowhere).
 */

/** The embedding page's half of the panel protocol, as small as it can be made. */
const HOST_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Studio (test host page)</title></head>
<body><div id="panels"></div><script src="/host.js"></script></body></html>`;

const HOST_SCRIPT = `
const CHANNEL = 'agent-studio-panel';
let csrf = null;
let user = null;
const api = async (method, url, body) => {
  const response = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-studio-csrf': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
};
window.signIn = async (username, password) => {
  const state = (await api('POST', '/api/auth/login', { username, password })).body;
  csrf = state.csrfToken;
  user = state.user;
  return user.displayName;
};
window.stillSignedIn = async () => (await api('GET', '/api/auth/state')).body.user !== null;
window.panelLog = {};
window.openPanel = async (pluginId, panelId, sandbox) => {
  const grant = (await api('POST', '/api/plugins/' + pluginId + '/panels/' + panelId + '/open', { slot: 'home-tile' })).body;
  const frame = document.createElement('iframe');
  frame.id = 'panel-' + pluginId;
  frame.setAttribute('sandbox', sandbox ?? grant.sandbox);
  frame.referrerPolicy = 'no-referrer';
  const log = (window.panelLog[pluginId] = { accepted: [], ignored: 0 });
  window.addEventListener('message', async (event) => {
    // Only this frame, and only as the opaque origin it must have.
    if (event.source !== frame.contentWindow || event.origin !== 'null') { log.ignored += 1; return; }
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.v !== 1) { log.ignored += 1; return; }
    log.accepted.push(message.type);
    const send = (body) => frame.contentWindow.postMessage({ channel: CHANNEL, v: 1, ...body }, '*');
    if (message.type === 'ready') {
      send({ type: 'init', context: { pluginId, panelId, slot: 'home-tile', theme: 'dark', locale: 'en', project: null, user: { displayName: user.displayName } } });
    } else if (message.type === 'request') {
      const answer = await api('POST', '/api/plugins/' + pluginId + '/rpc', { panel: grant.panel, method: message.method, params: message.params });
      send(answer.status === 200
        ? { type: 'response', id: message.id, ok: answer.body.ok, result: answer.body.result, error: answer.body.error }
        : { type: 'response', id: message.id, ok: false, error: answer.body.error });
    } else if (message.type === 'resize') {
      frame.style.height = Math.min(message.height, 2000) + 'px';
    }
  });
  frame.src = grant.url;
  document.getElementById('panels').append(frame);
  return grant;
};
document.body.dataset.ready = 'true';
`;

type Attempt = { ok: boolean; value?: unknown; error?: string };

describe('a panel in a real browser', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  let webDir: string;
  let browser: Browser | null = null;
  let page: Page;
  let origin: string;
  let unavailable: string | null = null;
  /** What the browser set out to request, and what became of it. */
  const requests: { url: string; frameUrl: string; outcome: 'pending' | 'answered' | 'blocked' }[] = [];
  /** What actually arrived at the server. */
  const reached: { url: string; origin: string | undefined; cookie: boolean }[] = [];

  beforeAll(async () => {
    try {
      if (!existsSync(chromium.executablePath())) throw new Error('the Chromium build Playwright expects is not installed');
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      unavailable = `SKIPPED: no browser could be started (${error instanceof Error ? error.message.split('\n')[0] : 'unknown reason'}), so panel isolation was not checked in a browser here.`;
      console.warn(unavailable);
      return;
    }
    webDir = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-plugin-web-'));
    await writeFile(path.join(webDir, 'index.html'), HOST_PAGE);
    await writeFile(path.join(webDir, 'host.js'), HOST_SCRIPT);
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN, hostile: HOSTILE_PLUGIN }, config: { webDir } });
    owner = await t.owner();
    await t.installAndEnable(owner, 'notes-counter');
    await t.installAndEnable(owner, 'hostile', []);
    origin = (await t.listen()).url;
    t.studio.app.server.on('request', (request) => {
      reached.push({ url: request.url ?? '', origin: request.headers.origin, cookie: request.headers.cookie !== undefined });
    });

    const context = await browser.newContext();
    page = await context.newPage();
    const tracked = new Map<unknown, (typeof requests)[number]>();
    page.on('request', (request) => {
      const entry = { url: request.url(), frameUrl: request.frame().url(), outcome: 'pending' as const };
      tracked.set(request, entry);
      requests.push(entry);
    });
    page.on('response', (response) => {
      const entry = tracked.get(response.request());
      if (entry) entry.outcome = 'answered';
    });
    page.on('requestfailed', (request) => {
      const entry = tracked.get(request);
      if (entry) entry.outcome = 'blocked';
    });
    await page.goto(`${origin}/`);
    await page.waitForSelector('body[data-ready="true"]', { state: 'attached' });
    // Everything run inside the browser is given as source text: this file is compiled for Node, not for a page.
    expect(await page.evaluate(`window.signIn('owner', ${JSON.stringify(TEST_PASSWORD)})`)).toBe('owner');
    // A cookie that scripts of the Studio's own origin can read: what a panel must not be able to see.
    await page.evaluate(`document.cookie = 'studio_visible=readable-by-the-studio-page; path=/'`);
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await t?.close();
    if (webDir) await rm(webDir, { recursive: true, force: true });
  });

  const open = (pluginId: string, panelId: string, sandbox?: string) =>
    page.evaluate<PluginPanelGrant>(`window.openPanel(${JSON.stringify(pluginId)}, ${JSON.stringify(panelId)}, ${JSON.stringify(sandbox ?? null)} ?? undefined)`);
  const frameOf = async (grant: PluginPanelGrant): Promise<Frame> => {
    await page.waitForFunction(`[...document.querySelectorAll('iframe')].some((frame) => frame.src.endsWith(${JSON.stringify(grant.url)}))`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = page.frames().find((candidate) => candidate.url().endsWith(grant.url));
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('The panel frame did not load.');
  };
  const hostileReport = async (frame: Frame): Promise<Record<string, Attempt>> => {
    await frame.waitForSelector('#report[data-done="true"]', { state: 'attached', timeout: 20_000 });
    return JSON.parse((await frame.textContent('#report'))!) as Record<string, Attempt>;
  };

  it('runs the example panel: its script loads, it calls its plugin through the page, and shows the answer', async (context) => {
    if (unavailable) return context.skip(unavailable);
    const grant = await open('notes-counter', 'notes');
    const frame = await frameOf(grant);
    expect(await page.getAttribute('#panel-notes-counter', 'sandbox')).toBe('allow-scripts allow-forms');

    // The greeting comes from the plugin's server code, for the signed-in user.
    // (Waiting is done with locators: the panel's policy forbids eval, even to the test tool's own polling.)
    await frame.locator('#greeting', { hasText: 'Hello, owner' }).waitFor();
    expect(await frame.textContent('#total')).toBe('0');
    // The panel's own stylesheet applied and the theme from the page arrived.
    expect(await frame.evaluate(`document.documentElement.dataset.theme`)).toBe('dark');
    expect(await frame.evaluate(`getComputedStyle(document.querySelector('.count')).fontWeight`)).toBe('600');

    await frame.fill('#text', 'written in a sandboxed frame');
    await frame.click('button[type="submit"]');
    await frame.locator('#total', { hasText: /^1$/ }).waitFor();
    expect(await frame.textContent('#notes li')).toBe('#1 written in a sandboxed frame');
    // It really went through the server: an agent's tool sees the same note.
    expect((await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {})).text).toContain('#1 (owner): written in a sandboxed frame');

    const log = await page.evaluate<{ accepted: string[]; ignored: number }>(`window.panelLog['notes-counter']`);
    expect(log.accepted).toEqual(expect.arrayContaining(['ready', 'request', 'resize']));
    // The frame was resized to its content, as it asked.
    expect(await page.evaluate(`document.getElementById('panel-notes-counter').style.height`)).toMatch(/^\d+px$/);
  });

  it('gives a hostile panel no cookie, no storage, no API, no network and no hold on the page around it', async (context) => {
    if (unavailable) return context.skip(unavailable);
    requests.length = 0;
    reached.length = 0;
    const grant = await open('hostile', 'attack');
    const frame = await frameOf(grant);
    const report = await hostileReport(frame);
    const got = (name: string) => report[name]!;

    // It did run, as a document without an origin of its own.
    expect(got('scriptRan')).toEqual({ ok: true, value: true });
    expect(got('origin').value).toEqual({ self: 'null', location: origin });
    expect(got('inlineScriptRan').ok).toBe(false);
    expect(got('eval').ok).toBe(false);
    expect(got('new Function').ok).toBe(false);

    // The session and the Studio's stored state.
    expect(got('cookie').ok).toBe(false);
    expect(got('cookie').error).toMatch(/SecurityError/);
    expect(got('setCookie').ok).toBe(false);
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'serviceWorker']) expect(got(name).ok, name).toBe(false);
    expect(await page.evaluate(`document.cookie`)).toBe('studio_visible=readable-by-the-studio-page');

    // The API, and the network at large.
    for (const name of ['fetch /api/auth/state', 'fetch with credentials', 'fetch no-cors', 'fetch own asset', 'xhr', 'websocket', 'eventsource']) {
      expect(got(name).ok, name).toBe(false);
    }
    // (A beacon tells the script that queued it nothing about its fate; whether one left is checked below.)
    for (const name of ['image from the Studio', 'image from elsewhere', 'script from the Studio']) expect(got(name).ok, name).toBe(false);
    expect(got('image from own folder')).toEqual({ ok: true, value: 'loaded' });

    // The page it is embedded in.
    for (const name of ['parent document', 'parent storage', 'top location read', 'top navigation', 'popup']) expect(got(name).ok, name).toBe(false);
    expect(page.url()).toBe(`${origin}/`);
    // The form "posted" — to nowhere: the policy forbids every form target, and the session is still there.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await page.evaluate(`window.stillSignedIn()`)).toBe(true);
    expect((await owner.get<AuthState>('/api/auth/state')).body.user).not.toBeNull();
    expect(frame.url().endsWith(grant.url)).toBe(true);

    // The one channel it has works — and carries an id and a name, nothing more.
    expect(got('panel call').ok).toBe(true);
    expect(got('panel call').value).toMatchObject({
      context: { pluginId: 'hostile', theme: 'dark', user: { displayName: 'owner' } },
      answer: { params: { greeting: 'from the hostile panel' }, context: { user: { id: owner.userId, displayName: 'owner' }, projectId: null, slot: 'home-tile' } },
    });

    // Seen from the browser: whatever the frame set out to request outside its own folder was blocked before it left.
    const fromPanel = requests.filter((request) => request.frameUrl.includes(grant.panel));
    const prefix = `${origin}/api/plugins/panel/${grant.panel}/`;
    const own = fromPanel.filter((request) => request.url.startsWith(prefix));
    const foreign = fromPanel.filter((request) => !request.url.startsWith(prefix));
    expect(own.map((request) => request.url.slice(prefix.length)).sort()).toEqual(expect.arrayContaining(['@studio/panel.js', 'attack.css', 'attack.js', 'pixel.svg']));
    expect(foreign.length).toBeGreaterThanOrEqual(5);
    expect(foreign.filter((request) => request.outcome !== 'blocked')).toEqual([]);
    expect(requests.filter((request) => request.url.includes('evil.example') && request.outcome !== 'blocked')).toEqual([]);

    // Seen from the server: none of it arrived. Not the image, not the style's background, not the beacon,
    // not the form, not the socket — and nothing at all from a page without an origin except its own files.
    expect(reached.filter((request) => /leak=|logout|realtime|\/api\/health|^\/api\/plugins$/.test(request.url))).toEqual([]);
    expect(reached.filter((request) => request.origin === 'null' && !request.url.startsWith(`/api/plugins/panel/${grant.panel}/`))).toEqual([]);
    // The panel's own files were asked for without the session cookie.
    const assetRequests = reached.filter((request) => request.url.startsWith(`/api/plugins/panel/${grant.panel}/`));
    expect(assetRequests.length).toBeGreaterThanOrEqual(4);
    // The frame's first load is started by the Studio's page and may carry the cookie (the route ignores it);
    // everything the panel itself then loads comes from a page without an origin, and carries none.
    const withCookie = assetRequests.filter((request) => request.cookie).map((request) => request.url.split('/').at(-1));
    expect(withCookie.filter((file) => file !== 'index.html')).toEqual([]);
  });

  it('stays without an origin even if the page embedding it forgets the sandbox, or it is opened on its own', async (context) => {
    if (unavailable) return context.skip(unavailable);
    // A host page that wrongly adds allow-same-origin: the policy sent with the panel's files still applies.
    await page.evaluate(`document.getElementById('panel-hostile')?.remove()`);
    const careless = await open('hostile', 'attack', 'allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation');
    const framed = await hostileReport(await frameOf(careless));
    expect(framed.origin!.value).toEqual({ self: 'null', location: origin });
    for (const name of ['cookie', 'localStorage', 'fetch /api/auth/state', 'fetch with credentials', 'parent document', 'popup', 'top navigation']) {
      expect(framed[name]!.ok, name).toBe(false);
    }
    expect(page.url()).toBe(`${origin}/`);

    // Opened directly in a tab of the same browser, with the same cookies: still nothing.
    const tab = await page.context().newPage();
    try {
      await tab.goto(`${origin}${careless.url}`);
      const alone = await hostileReport(tab.mainFrame());
      expect(alone.origin!.value).toEqual({ self: 'null', location: origin });
      for (const name of ['cookie', 'localStorage', 'fetch /api/auth/state', 'fetch with credentials', 'xhr']) expect(alone[name]!.ok, name).toBe(false);
      // No page embeds it here, so even its one channel leads nowhere.
      expect(alone['panel call']!.ok).toBe(false);
    } finally {
      await tab.close();
    }
  });

  it('cannot be framed by another site', async (context) => {
    if (unavailable) return context.skip(unavailable);
    const grant = await open('notes-counter', 'notes');
    const other = await page.context().newPage();
    try {
      // A page of another origin (a data: document) tries to embed the panel.
      await other.setContent(`<iframe id="stolen" src="${origin}${grant.url}"></iframe>`);
      await other.waitForTimeout(800);
      const embedded = other.frames().find((frame) => frame.url().includes(grant.panel));
      const text = embedded ? await embedded.evaluate<string>(`document.body?.innerText ?? ''`).catch(() => '') : '';
      expect(text).not.toContain('Hello, owner');
      expect(text).not.toContain('New note');
    } finally {
      await other.close();
    }
  });
});
