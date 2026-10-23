/**
 * Real product screenshots, with a disposable account and fictional data only.
 *
 *   node scripts/showcase/capture.mjs --lang en|zh-CN --out <directory>
 *
 * Captures are taken at twice the pixel density so the composed images stay sharp.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect, request } from '@playwright/test';
import { content, files, fixedTest, fixedTotal } from './content.mjs';

const { values: args } = parseArgs({
  options: { lang: { type: 'string', default: 'en' }, out: { type: 'string' } },
});
const lang = args.lang === 'zh-CN' ? 'zh-CN' : 'en';
const t = content(lang);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.resolve(args.out ?? path.join(repo, 'docs/assets/showcase', lang, 'raw'));
const webDir = path.join(repo, 'apps/web/dist');
if (!existsSync(path.join(webDir, 'index.html'))) throw new Error('Run npm run build first.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'cloud-harness-showcase-'));
const workspace = path.join(temporary, 'workspace');
const home = path.join(temporary, 'home');
const data = path.join(temporary, 'data');
const setup = randomBytes(24).toString('hex');
for (const directory of [workspace, home, data, output])
  await mkdir(directory, { recursive: true });
const child = spawn(
  process.execPath,
  ['--import', 'tsx', path.join(repo, 'scripts/showcase/server.ts')],
  {
    cwd: repo,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      TSX_TSCONFIG_PATH: path.join(repo, 'apps/server/tsconfig.json'),
      SHOWCASE_DATA: data,
      SHOWCASE_WORKSPACE: workspace,
      SHOWCASE_WEB: webDir,
      SHOWCASE_SETUP: setup,
      SHOWCASE_LANG: lang,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
);
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});
let browser;
let api;
let cleaning;
async function cleanup() {
  cleaning ??= (async () => {
    await Promise.allSettled([browser?.close(), api?.dispose()]);
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(force);
    }
    await rm(temporary, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    void cleanup().then(() => process.exit(1));
  });

/** A throwaway Git repository for the fictional project, so the Git panel shows a real change. */
function git(cwd, ...command) {
  execFileSync(
    'git',
    ['-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', ...command],
    {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: 'ignore',
    },
  );
}

try {
  const baseURL = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Showcase server startup timed out.')), 90_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      resolve(message.url);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`Showcase server exited. ${logs}`));
    });
  });
  api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
  const signedIn = await api.post('/api/auth/setup', {
    data: {
      setupToken: setup,
      username: 'alex',
      password: randomBytes(32).toString('hex'),
      displayName: t.user,
    },
  });
  if (!signedIn.ok()) throw new Error(`Setup: ${signedIn.status()} ${await signedIn.text()}`);
  const { csrfToken } = await (await api.get('/api/auth/state')).json();
  const call = async (method, url, body) => {
    const response = await api.fetch(url, {
      method,
      headers: { 'x-studio-csrf': csrfToken },
      ...(body === undefined ? {} : { data: body }),
    });
    if (!response.ok())
      throw new Error(`${method} ${url}: ${response.status()} ${await response.text()}`);
    return response.status() === 204 || !(await response.body()).length
      ? undefined
      : response.json();
  };
  await call('PATCH', '/api/preferences', {
    values: {
      'appearance.theme': 'light',
      'appearance.language': lang,
      'onboarding.progress': { v: 1, state: 'dismissed', steps: {}, updatedAt: Date.now() },
    },
  });

  // ---- the fictional project ---------------------------------------------------------
  const project = await call('POST', '/api/projects', {
    name: t.project,
    rootDir: path.join(workspace, t.project),
    createDirectory: true,
  });
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project.rootDir, name)), { recursive: true });
    await writeFile(path.join(project.rootDir, name), text);
  }
  git(project.rootDir, 'init', '-q', '-b', 'main');
  git(project.rootDir, 'add', '.');
  git(project.rootDir, 'commit', '-q', '-m', 'Checkout totals');
  await writeFile(path.join(project.rootDir, 'src/cart/total.ts'), fixedTotal);
  await writeFile(path.join(project.rootDir, 'src/cart/total.test.ts'), fixedTest);
  for (const name of t.otherProjects)
    await call('POST', '/api/projects', {
      name,
      rootDir: path.join(workspace, name),
      createDirectory: true,
    });

  const { folders } = await call('GET', '/api/memory/folders');
  const folder = folders.find((item) => item.project?.id === project.id).name;
  for (const note of t.memory) await call('POST', '/api/memory/notes', { folder, ...note });
  await call('POST', '/api/memory/notes', { folder: 'global', ...t.globalMemory });
  for (const entry of t.tools) await call('POST', '/api/tool-library', entry);
  // Catalogue examples, not verified connections. Reserved hosts cannot contact providers.
  for (const provider of [
    {
      id: 'anthropic-demo',
      name: t.providers.anthropic,
      kind: 'anthropic',
      baseUrl: 'https://anthropic.example.invalid',
      models: [
        { id: 'example-reasoning', name: t.providers.reasoning, tools: true, images: true },
        { id: 'example-fast', name: t.providers.fast, tools: true },
      ],
    },
    {
      id: 'compatible-demo',
      name: t.providers.compatible,
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.invalid/v1',
      models: [{ id: 'example-code', name: t.providers.code, tools: true }],
    },
    {
      id: 'local-demo',
      name: t.providers.local,
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowPrivateNetwork: true,
      keyRequired: false,
      models: [{ id: 'example-local', name: t.providers.localModel, tools: true }],
    },
  ])
    await call('POST', '/api/providers', provider);
  const account = await call('POST', '/api/mailbox/accounts', {
    provider: 'gmail',
    name: t.mailbox,
    credentials: { accessToken: 'fictional-showcase-transport-only' },
  });
  void account;

  // ---- conversations -----------------------------------------------------------------
  const group = await call('POST', '/api/conversation-groups', { name: t.group });
  const makeSession = (title, agentId = 'claude-code', extra = {}) =>
    call('POST', '/api/sessions', {
      projectId: project.id,
      agentId,
      title,
      permissionMode: 'ask',
      groupId: group.id,
      ...extra,
    });
  const send = (session, text) =>
    call('POST', `/api/sessions/${session.id}/messages`, {
      requestId: randomBytes(16).toString('hex'),
      text,
    });
  const settled = async (session) => {
    await expect
      .poll(async () => (await call('GET', `/api/sessions/${session.id}`)).activeRunId, {
        timeout: 15_000,
      })
      .toBe(null);
  };
  const fix = await makeSession(t.titles.fix);
  await send(fix, t.prompts.fix);
  await settled(fix);
  await call('PATCH', `/api/sessions/${fix.id}`, { pinned: true });
  const { task } = await call('POST', `/api/projects/${project.id}/tasks`, {
    requestId: randomBytes(16).toString('hex'),
    title: t.titles.task,
    prompt: t.prompts.review,
    participants: [{ agentId: 'claude-code' }, { agentId: 'codex' }],
    isolation: 'shared',
  });
  await expect
    .poll(async () => (await call('GET', `/api/tasks/${task.id}`)).state, { timeout: 15_000 })
    .toBe('completed');
  const upgrade = await makeSession(t.titles.upgrade, 'claude-code', { groupId: null });
  await send(upgrade, t.prompts.upgrade);
  const notes = await makeSession(t.titles.notes, 'codex', { groupId: null });
  await send(notes, t.prompts.notes);
  const refund = await makeSession(t.titles.refund);
  await send(refund, t.prompts.refund);

  // ---- the browser -------------------------------------------------------------------
  browser = await chromium.launch({ headless: true });
  const contextFor = (viewport, extra = {}) =>
    browser.newContext({
      baseURL,
      storageState: undefined,
      viewport,
      deviceScaleFactor: 2,
      locale: lang === 'zh-CN' ? 'zh-CN' : 'en-GB',
      timezoneId: 'Europe/London',
      colorScheme: 'light',
      reducedMotion: 'reduce',
      ...extra,
    });
  const unexpected = [];
  const state = await api.storageState();
  const open = async (viewport, extra) => {
    const context = await contextFor(viewport, { storageState: state, ...extra });
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort(),
    );
    context.on('page', (page) => page.on('pageerror', (error) => unexpected.push(error.message)));
    return context.newPage();
  };
  const settle = async (page) => {
    // eslint-disable-next-line no-undef -- Evaluated by Playwright inside the browser.
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await expect(page.locator('text=/^(Loading…|加载中…)$/').filter({ visible: true })).toHaveCount(
      0,
    );
  };
  const shoot = async (page, name, target) => {
    await settle(page);
    const file = path.join(output, `${name}.png`);
    if (target) await target.screenshot({ path: file, animations: 'disabled' });
    else await page.screenshot({ path: file, animations: 'disabled' });
    console.log(`Captured ${name}.png`);
  };
  /** One picture around several elements, with some room around them. */
  const shootAround = async (page, name, locator, pad = 24) => {
    await settle(page);
    const boxes = (
      await Promise.all((await locator.all()).map((item) => item.boundingBox()))
    ).filter((box) => box && box.width > 1 && box.height > 1);
    if (!boxes.length) throw new Error(`Nothing to capture for ${name}.`);
    const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) - pad);
    const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) - pad);
    const right = Math.max(...boxes.map((box) => box.x + box.width)) + pad;
    const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + pad;
    await page.screenshot({
      path: path.join(output, `${name}.png`),
      clip: { x: left, y: top, width: right - left, height: bottom - top },
      animations: 'disabled',
    });
    console.log(`Captured ${name}.png`);
  };
  const visit = async (page, route) => {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
  };
  const conversation = (session) => `/workbench/p/${project.id}/s/${session.id}`;

  const toTop = (page) =>
    page.getByRole('region', { name: t.ui.conversation, exact: true }).evaluate((element) => {
      const scroller = element.querySelector('.wb-window') ?? element;
      scroller.scrollTop = 0;
    });

  // Desktop: the conversation with the change open, and the real diff in the Git panel.
  const desk = await open({ width: 1600, height: 1000 });
  await visit(desk, conversation(fix));
  await expect(desk.getByRole('heading', { level: 2 }).first()).toBeVisible();
  await desk.getByRole('button', { name: t.ui.showTools }).click();
  const panel = desk.locator(`[aria-label="${t.ui.projectTools}"]`).first();
  await panel.getByText(t.ui.git, { exact: true }).first().click();
  await panel.getByText('total.ts', { exact: true }).first().click();
  await expect(
    panel.getByText('Math.round(pence * (1 - discount)) / 100;', { exact: false }).first(),
  ).toBeVisible();
  await toTop(desk);
  await shoot(desk, 'desktop');
  await call('PATCH', '/api/preferences', { values: { 'appearance.theme': 'dark' } });
  await desk.reload();
  await desk.waitForLoadState('networkidle');
  await panel.getByText('total.ts', { exact: true }).first().click();
  await expect(
    panel.getByText('Math.round(pence * (1 - discount)) / 100;', { exact: false }).first(),
  ).toBeVisible();
  await toTop(desk);
  await shoot(desk, 'desktop-dark');
  await call('PATCH', '/api/preferences', { values: { 'appearance.theme': 'light' } });
  await desk.reload();
  await desk.waitForLoadState('networkidle');
  await desk.getByRole('button', { name: t.ui.hideTools }).first().click();

  // The run on its own: what the agent read, changed and ran, and its answer.
  const column = await open({ width: 1000, height: 1500 });
  await visit(column, conversation(fix));
  await expect(column.getByRole('heading', { level: 2 }).first()).toBeVisible();
  await toTop(column);
  await shoot(column, 'run', column.getByRole('region', { name: t.ui.conversation, exact: true }));

  await visit(desk, `/workbench/p/${project.id}/new`);
  await desk.getByRole('button', { name: t.ui.agentPicker }).click();
  const picker = desk.getByRole('dialog').first();
  await expect(picker).toBeVisible();
  await shoot(desk, 'agents', picker);
  await desk.keyboard.press('Escape');

  await visit(desk, `/tasks/${task.id}`);
  await shoot(desk, 'task-page');
  await shootAround(desk, 'task', desk.locator('.cl-card'), 12);
  await visit(desk, '/memory');
  await desk.getByRole('button', { name: new RegExp(`^${t.memory[0].title}`) }).click();
  const note = desk.getByRole('dialog').first();
  await expect(note).toBeVisible();
  await shoot(desk, 'memory', note);
  await desk.keyboard.press('Escape');
  await visit(desk, '/running');
  await shootAround(desk, 'running', desk.locator('h1:visible, .cl-row-actions:visible'));
  await visit(desk, '/');
  await shoot(desk, 'launcher');
  await visit(desk, '/tool-library');
  await shoot(desk, 'tools');
  await visit(desk, '/settings/models');
  await shoot(desk, 'models');
  await visit(desk, '/mailbox');
  await desk.getByRole('button', { name: new RegExp(t.mail[0].subject) }).click();
  await shoot(desk, 'mail');

  await visit(desk, '/settings/domain');
  await desk.getByLabel(t.ui.domain, { exact: true }).fill('harness.example.com');
  await shoot(desk, 'domain');

  const phone = await open({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await visit(phone, conversation(refund));
  await expect(phone.getByText(t.refundIntro)).toBeVisible();
  await shoot(phone, 'phone');
  await shoot(phone, 'approval', phone.locator('.wb-approval').first());

  const tablet = await open({ width: 820, height: 1180 }, { isMobile: true, hasTouch: true });
  await visit(tablet, conversation(fix));
  await toTop(tablet);
  await shoot(tablet, 'tablet');

  if (unexpected.length) throw new Error(`Page errors: ${unexpected.join('; ')}`);
} finally {
  await cleanup();
}
