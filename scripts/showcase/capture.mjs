/** Real product screenshots, with a disposable account and fictional data only. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, request } from '@playwright/test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(repo, 'docs/assets/screenshots');
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
      PATH: `${path.join(repo, 'tests/fixtures/bin')}:/usr/bin:/bin`,
      HOME: home,
      LANG: 'C.UTF-8',
      TSX_TSCONFIG_PATH: path.join(repo, 'apps/server/tsconfig.json'),
      SHOWCASE_DATA: data,
      SHOWCASE_WORKSPACE: workspace,
      SHOWCASE_WEB: webDir,
      SHOWCASE_SETUP: setup,
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
      displayName: 'Alex · Demo',
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
      'appearance.language': 'en',
      'onboarding.progress': { v: 1, state: 'dismissed', steps: {}, updatedAt: Date.now() },
    },
  });
  const project = await call('POST', '/api/projects', {
    name: 'Atlas reading space',
    rootDir: path.join(workspace, 'atlas'),
    createDirectory: true,
  });
  await mkdir(path.join(project.rootDir, 'src'), { recursive: true });
  await writeFile(
    path.join(project.rootDir, 'README.md'),
    '# Atlas\n\nA fictional community reading space.\n\n## Design direction\n\n- Make room for good ideas.\n- Keep the primary action clear.\n- Work comfortably on any screen.\n\n## Review\n\nShared decisions live in Memory.\nAsk a second agent for a review before release.\n',
  );
  await writeFile(
    path.join(project.rootDir, 'src', 'navigation.ts'),
    'export const sections = [\n  { label: "Discover", path: "/discover" },\n  { label: "Collections", path: "/collections" },\n  { label: "Reading now", path: "/reading" },\n];\n',
  );
  await writeFile(
    path.join(project.rootDir, 'design-notes.md'),
    '# Design notes\n\nUse calm surfaces, clear labels and generous touch targets.\n',
  );
  await call('POST', '/api/projects', {
    name: 'Field notes',
    rootDir: path.join(workspace, 'field-notes'),
    createDirectory: true,
  });
  await call('POST', '/api/projects', {
    name: 'Launch checklist',
    rootDir: path.join(workspace, 'launch-checklist'),
    createDirectory: true,
  });
  const { folders } = await call('GET', '/api/memory/folders');
  const folder = folders.find((item) => item.project?.id === project.id).name;
  for (const note of [
    {
      folder,
      title: 'Atlas design principles',
      body: '## A calm place for reading\n\nKeep one clear primary action on each screen. Make keyboard focus visible and touch controls at least 44 pixels.\n\n### Across devices\nUse a sidebar on desktop, a compact workspace on tablet, and one focused conversation on phone.\n\nThese are fictional project decisions for the Cloud Harness showcase.',
      tags: ['design', 'shared'],
      keywords: ['Atlas', 'design', 'navigation'],
    },
    {
      folder,
      title: 'Review handoff',
      body: 'The planner defined the reading flow. The reviewer checks accessibility and navigation. Keep the next step in the conversation, then record lasting decisions here.',
      tags: ['review', 'handoff'],
      keywords: ['review', 'handoff', 'Atlas'],
    },
    {
      folder,
      title: 'Release checklist',
      body: 'Review the phone layout, test keyboard focus, then update the project guide. Use fictional examples in public screenshots.',
      tags: ['release'],
      keywords: ['release', 'checklist'],
    },
    {
      folder: 'global',
      title: 'How we work together',
      body: 'Search existing notes before starting. Write down decisions that another assistant will need. Keep credentials and personal data out of shared notes.',
      tags: ['workflow'],
      keywords: ['memory', 'decisions', 'workflow'],
    },
  ])
    await call('POST', '/api/memory/notes', note);
  for (const entry of [
    {
      kind: 'skill',
      name: 'design-review',
      description: 'Review hierarchy, readable contrast and touch interaction.',
      content:
        'Review $ARGUMENTS for clear hierarchy, visible focus and comfortable touch controls.',
    },
    {
      kind: 'command',
      name: 'handoff',
      description: 'Leave a concise summary for the next assistant.',
      content: 'Summarize $ARGUMENTS: decisions, open questions and the next concrete step.',
    },
    {
      kind: 'skill',
      name: 'release-check',
      description: 'Check the small details before sharing a release.',
      content: 'Review $ARGUMENTS for tested behavior, clear documentation and safe sample data.',
    },
  ])
    await call('POST', '/api/tool-library', entry);
  // These are catalogue examples, not verified connections. Reserved hosts cannot contact providers.
  for (const provider of [
    {
      id: 'anthropic-demo',
      name: 'Anthropic · Example catalogue',
      kind: 'anthropic',
      baseUrl: 'https://anthropic.example.invalid',
      models: [
        { id: 'example-reasoning', name: 'Reasoning model · example', tools: true, images: true },
        { id: 'example-fast', name: 'Fast model · example', tools: true },
      ],
    },
    {
      id: 'compatible-demo',
      name: 'OpenAI compatible · Example catalogue',
      kind: 'openai-compatible',
      baseUrl: 'https://models.example.invalid/v1',
      models: [
        { id: 'example-general', name: 'General model · example', tools: true, images: true },
        { id: 'example-code', name: 'Coding model · example', tools: true },
      ],
    },
    {
      id: 'local-demo',
      name: 'Local models · Example catalogue',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      allowPrivateNetwork: true,
      keyRequired: false,
      models: [{ id: 'example-local', name: 'Local model · example', tools: true }],
    },
  ])
    await call('POST', '/api/providers', provider);
  const account = await call('POST', '/api/mailbox/accounts', {
    provider: 'gmail',
    name: 'Atlas demo mailbox',
    credentials: { accessToken: 'fictional-showcase-transport-only' },
  });
  await call('POST', `/api/mailbox/accounts/${account.id}/drafts`, {
    to: ['design@example.invalid'],
    subject: 'Re: Atlas design review',
    text: 'Thanks! I will review the phone and tablet layouts and leave the findings in our shared project notes.',
  });
  const group = await call('POST', '/api/conversation-groups', { name: 'Atlas · Design review' });
  const makeSession = (title, agentId = 'showcase-planner') =>
    call('POST', '/api/sessions', {
      projectId: project.id,
      agentId,
      title,
      model: 'scripted-large',
      permissionMode: 'plan',
      groupId: group.id,
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
  const main = await makeSession('A calmer reading experience');
  await send(
    main,
    'Plan the Atlas reading experience. Keep it clear on desktop, tablet and phone.',
  );
  await settled(main);
  await call('PATCH', `/api/sessions/${main.id}`, { pinned: true });
  const review = await makeSession('Navigation and accessibility', 'showcase-reviewer');
  await send(review, 'Review the primary navigation and accessibility of the Atlas plan.');
  await settled(review);
  const handoff = await call('POST', `/api/sessions/${review.id}/handoff`, {
    requestId: randomBytes(16).toString('hex'),
    agentId: 'showcase-planner',
    model: 'scripted-large',
    permissionMode: 'plan',
    note: 'Continue from the review. Keep the accessibility recommendations with the project.',
    start: true,
  });
  await settled(handoff.session);
  const { task } = await call('POST', `/api/projects/${project.id}/tasks`, {
    requestId: randomBytes(16).toString('hex'),
    title: 'Two perspectives on the Atlas navigation',
    prompt:
      'Review the Atlas navigation. Keep the primary action clear and the design comfortable across devices.',
    participants: [
      { agentId: 'showcase-planner', model: 'scripted-large' },
      { agentId: 'showcase-reviewer', model: 'scripted-large' },
    ],
    isolation: 'shared',
  });
  await expect
    .poll(async () => (await call('GET', `/api/tasks/${task.id}`)).state, { timeout: 15_000 })
    .toBe('completed');

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL,
    storageState: await api.storageState(),
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const unexpected = [];
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === baseURL ? route.continue() : route.abort(),
  );
  context.on('page', (page) => page.on('pageerror', (error) => unexpected.push(error.message)));
  const page = await context.newPage();
  const scenes = [];
  const screenshot = async (name, description) => {
    // eslint-disable-next-line no-undef -- Evaluated by Playwright inside the browser.
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    await expect(page.getByText('Loading…', { exact: true }).filter({ visible: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    scenes.push({ image: `${name}.png`, description, viewport: page.viewportSize() });
    console.log(`Captured ${name}.png`);
  };
  const visit = async (route) => {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
  };
  const conversation = `/workbench/p/${project.id}/s/${main.id}`;
  await visit(conversation);
  await expect(page.getByText('A calmer reading space', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show project tools' }).click();
  const panel = page.getByRole('complementary', { name: 'Project tools' });
  await panel.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await screenshot(
    'desktop',
    'Actual desktop workspace with scripted sample conversation and fictional project files.',
  );
  await copyFile(path.join(output, 'desktop.png'), path.join(output, 'workspace.png'));
  await call('PATCH', '/api/preferences', { values: { 'appearance.theme': 'dark' } });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await screenshot('workspace-dark', 'The same real workspace using the product dark theme.');
  await call('PATCH', '/api/preferences', { values: { 'appearance.theme': 'light' } });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Hide project tools' }).first().click();
  await visit(`/workbench/p/${project.id}/new`);
  await page.getByRole('button', { name: /^Agent and model:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Agent and model', exact: true })).toBeVisible();
  await screenshot(
    'agent-picker',
    'Actual model picker; CLI status comes from test fixtures, not connected accounts.',
  );
  await page.keyboard.press('Escape');
  await visit('/settings/models');
  await screenshot(
    'models',
    'Actual native Anthropic, OpenAI-compatible and local provider catalogue configuration. Examples are not verified connections.',
  );
  await visit('/memory');
  await expect(page.getByRole('button', { name: /^Atlas design principles/ })).toBeVisible();
  await screenshot('memory', 'Fictional shared notes in project and global folders.');
  await visit(`/workbench/p/${project.id}/s/${handoff.session.id}`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate((element) => {
    const scroller = element.querySelector('.wb-window') ?? element;
    scroller.scrollTop = 0;
  });
  await page.getByRole('button', { name: 'View brief', exact: true }).click();
  await screenshot(
    'collaboration',
    'Actual handoff brief showing the user note and context carried between scripted assistants.',
  );
  await visit(`/tasks/${task.id}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await screenshot('tasks', 'Actual multi-agent task with two scripted perspectives.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await visit('/tool-library');
  await screenshot('tools', 'Reusable skills and prompts created through the product API.');
  await visit('/mailbox');
  await expect(page.getByRole('button', { name: /Atlas — the next design review/ })).toBeVisible();
  await screenshot(
    'mail',
    'Actual mailbox with a closed synthetic mail transport. No email is sent.',
  );
  await page.getByRole('button', { name: /Atlas — the next design review/ }).click();
  await screenshot('mail-reading', 'An entirely fictional email rendered as plain text.');
  const running = await makeSession('Reviewing the mobile navigation');
  await send(running, 'Keep working on the Atlas navigation review.');
  const runningReview = await makeSession('Checking keyboard and touch', 'showcase-reviewer');
  await send(runningReview, 'Keep working on the accessibility review.');
  await visit('/running');
  await screenshot(
    'activity',
    'Two scripted assistants paused in running state to demonstrate activity visibility.',
  );
  await visit('/');
  await screenshot('launcher', 'Actual launcher with fictional projects.');
  await page.setViewportSize({ width: 820, height: 1180 });
  await visit('/memory');
  await page.getByRole('button', { name: /^Atlas design principles/ }).click();
  await screenshot('tablet', 'Tablet layout showing a fictional shared project note.');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await makeSession('Ready for review');
  await call('PATCH', `/api/sessions/${mobile.id}`, { groupId: null });
  await send(mobile, 'A short mobile handoff.');
  await settled(mobile);
  await visit(`/workbench/p/${project.id}/s/${mobile.id}`);
  await page.getByRole('region', { name: 'Conversation', exact: true }).evaluate((element) => {
    element.scrollTop = 0;
  });
  await screenshot(
    'phone',
    'Phone layout showing a short scripted handoff in the same fictional project.',
  );
  if (process.argv.includes('--domain')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await visit('/settings/domain');
    await page.getByLabel('Your domain').fill('harness.example.com');
    await screenshot('domain', 'Actual custom-domain setup page with an example hostname.');
    await page
      .getByRole('heading', { name: '2 · Set up your connection', exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await screenshot(
      'domain-setup',
      'Actual generated Caddy and server configuration for a reserved example hostname.',
    );
  }
  if (unexpected.length) throw new Error(`Page errors: ${unexpected.join('; ')}`);
  await writeFile(
    path.join(output, 'manifest.json'),
    `${JSON.stringify({ data: 'Fictional Atlas project. Scripted agent responses and a closed synthetic mail transport. Real product UI; no live accounts.', scenes }, null, 2)}\n`,
  );
} finally {
  await cleanup();
}
