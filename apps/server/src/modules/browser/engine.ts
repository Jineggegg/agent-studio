import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { BrowserAction } from '@agent-studio/protocol';
import { conflict, unavailable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { guardedRequest } from '../../kernel/net.js';
import { buildChildEnv, terminate } from '../../kernel/process.js';
import { CdpPipe } from './cdp.js';
import { BrowserNetwork, browserUrl, type BrowserRequest } from './network.js';

export interface BrowserEngine {
  action(
    input: BrowserAction,
  ): Promise<{ url: string; title: string; text: string; screenshot: Buffer }>;
  close(): Promise<void>;
}
export type BrowserEngineFactory = (
  context: ModuleContext,
  executable: string,
  authorize: () => void,
) => Promise<BrowserEngine>;

/** No project, home directory, host sockets or credentials are mounted into Chromium. */
export interface BrowserTestOptions {
  runtimeRoot?: string;
  request?: typeof guardedRequest;
  onStderr?: (chunk: string) => void;
}
export const createBrowserEngine = async (
  context: ModuleContext,
  executable: string,
  authorize: () => void,
  test?: BrowserTestOptions,
): Promise<BrowserEngine> => {
  if (test && context.config.env !== 'test')
    throw unavailable('Test browser options are disabled.', 'browser_unavailable');
  if (context.sandbox.status.mode !== 'bwrap')
    throw unavailable(
      'An isolated browser requires the Linux sandbox.',
      'browser_sandbox_unavailable',
    );
  const binary = await realpath(executable);
  if (!path.isAbsolute(executable) || binary !== executable || !(await stat(binary)).isFile())
    throw unavailable('The configured browser is unavailable.', 'browser_unavailable');
  // System Chromium includes its resources under these already read-only runtime roots.
  // Never expose an arbitrary executable's parent (which could contain credentials).
  const testRoot = test?.runtimeRoot ? await realpath(test.runtimeRoot) : null;
  if (testRoot && path.dirname(binary) !== testRoot)
    throw unavailable('Invalid test browser root.', 'browser_unavailable');
  if (
    !testRoot &&
    !['/usr/', '/bin/', '/opt/cloud-harness-chromium/'].some((root) => binary.startsWith(root))
  )
    throw unavailable(
      'Install Chromium under /usr or /opt/cloud-harness-chromium.',
      'browser_unavailable',
    );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloud-harness-browser-'));
  const profile = path.join(directory, 'profile');
  const temporary = path.join(directory, 'tmp');
  await mkdir(profile);
  await mkdir(temporary);
  const wrapped = context.sandbox.wrap(
    binary,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      '--no-startup-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-features=MediaRouter,OptimizationHints,ServiceWorker,WebRtc',
      '--renderer-process-limit=3',
      `--user-data-dir=${profile}`,
    ],
    {
      kind: 'isolate',
      readable: testRoot
        ? [testRoot]
        : binary.startsWith('/opt/cloud-harness-chromium/')
          ? ['/opt/cloud-harness-chromium']
          : [],
      writable: [directory],
      network: false,
    },
  );
  if (!wrapped.sandboxed || !wrapped.args.includes('--unshare-net')) {
    await rm(directory, { recursive: true, force: true });
    throw unavailable('Browser network isolation is unavailable.', 'browser_sandbox_unavailable');
  }
  const child = context.processes.spawn(wrapped.file, wrapped.args, {
    cwd: directory,
    // Browsing needs no operator passthrough, proxy credentials or host XDG paths.
    env: buildChildEnv({
      source: {},
      extra: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TMPDIR: temporary, HOME: profile },
    }),
    debugPipe: true,
  });
  child.stdout?.resume();
  if (test?.onStderr)
    child.stderr?.on('data', (chunk: Buffer) => test.onStderr?.(chunk.toString()));
  else child.stderr?.resume();
  const cdp = new CdpPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const network = new BrowserNetwork(test?.request);
  const targets = new Map<string, Promise<string>>();
  const waiters = new Map<string, (ready: Promise<string>) => void>();
  let mainTarget: string | null = null;
  let mainSession: string | null = null;
  let closed = false;
  let working = false;
  let load: (() => void) | null = null;
  const close = async () => {
    if (closed) return;
    closed = true;
    network.close();
    cdp.close();
    terminate(child, 500);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else {
        child.once('close', () => resolve());
        setTimeout(resolve, 2000).unref();
      }
    });
    await rm(directory, { recursive: true, force: true });
  };
  child.once('error', () => {
    void close();
  });
  child.once('exit', () => {
    void close();
  });

  async function attach(params: Record<string, unknown>): Promise<string> {
    const sessionId = String(params.sessionId);
    const info = params.targetInfo as { targetId: string; type: string };
    if (
      !['page', 'iframe'].includes(info.type) ||
      (info.type === 'page' && mainTarget !== null && info.targetId !== mainTarget)
    ) {
      await cdp.call('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      return sessionId;
    }
    if (info.type === 'page') {
      mainTarget = info.targetId;
      mainSession = sessionId;
    }
    await cdp.call(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: false },
      sessionId,
    );
    await cdp.call('Network.enable', {}, sessionId);
    await cdp.call('Network.setBypassServiceWorker', { bypass: true }, sessionId);
    await cdp.call(
      'Network.setBlockedURLs',
      { urls: ['file://*', 'ftp://*', 'ws://*', 'wss://*', 'chrome://*', 'devtools://*'] },
      sessionId,
    );
    await cdp.call(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    await cdp.call('Page.enable', {}, sessionId);
    if (info.type === 'page')
      await cdp.call(
        'Emulation.setDeviceMetricsOverride',
        { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
        sessionId,
      );
    await cdp.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
    return sessionId;
  }
  async function intercepted(params: Record<string, unknown>, sessionId?: string) {
    const requestId = String(params.requestId);
    try {
      authorize();
      const request = params.request as BrowserRequest;
      // Blob/data resources remain renderer-local; requests crossing the network are HTTPS only.
      const response = await network.fetch(request);
      await cdp.call(
        'Fetch.fulfillRequest',
        {
          requestId,
          responseCode: response.status,
          responseHeaders: response.headers,
          body: response.body,
        },
        sessionId,
      );
    } catch {
      await cdp
        .call('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId)
        .catch(() => {});
    }
  }
  cdp.onEvent = (method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      const info = params.targetInfo as { targetId: string };
      if (targets.size >= 32) {
        void close();
        return;
      }
      const ready = attach(params);
      targets.set(info.targetId, ready);
      waiters.get(info.targetId)?.(ready);
      void ready.catch((error: unknown) => {
        test?.onStderr?.(`Browser target setup failed: ${String(error)}`);
        return close();
      });
    } else if (method === 'Fetch.requestPaused') void intercepted(params, sessionId);
    else if (method === 'Page.loadEventFired' && sessionId === mainSession) load?.();
    else if (method === 'Page.javascriptDialogOpening')
      void cdp.call('Page.handleJavaScriptDialog', { accept: false }, sessionId).catch(() => {});
  };
  try {
    await cdp.call('Browser.getVersion');
    await cdp.call('Browser.setDownloadBehavior', { behavior: 'deny' });
    await cdp.call('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const created = await cdp.call('Target.createTarget', { url: 'about:blank' });
    const targetId = String(created.targetId);
    mainSession = await (targets.get(targetId) ??
      new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(targetId);
          reject(
            unavailable(
              'Browser target was not isolated before navigation.',
              'browser_unavailable',
            ),
          );
        }, 15_000);
        waiters.set(targetId, (ready) => {
          clearTimeout(timeout);
          waiters.delete(targetId);
          void ready.then(resolve, reject);
        });
      }));
  } catch {
    await close();
    throw unavailable('Could not start the isolated browser.', 'browser_unavailable');
  }

  return {
    close,
    async action(input) {
      authorize();
      if (closed || !mainSession) throw unavailable('Browser closed.', 'browser_closed');
      if (working) throw conflict('A browser action is already in progress.', 'browser_busy');
      working = true;
      try {
        if (input.action === 'navigate') {
          browserUrl(input.url);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const loaded = new Promise<void>((resolve) => {
            load = resolve;
            timer = setTimeout(resolve, 12_000);
          });
          try {
            const result = await cdp.call('Page.navigate', { url: input.url }, mainSession);
            if (result.errorText)
              throw unavailable(
                'Browser navigation was blocked or failed.',
                'browser_navigation_failed',
              );
            await loaded;
          } finally {
            clearTimeout(timer);
            load = null;
          }
        } else if (input.action === 'click') {
          await cdp.call(
            'Input.dispatchMouseEvent',
            { type: 'mousePressed', x: input.x, y: input.y, button: 'left', clickCount: 1 },
            mainSession,
          );
          await cdp.call(
            'Input.dispatchMouseEvent',
            { type: 'mouseReleased', x: input.x, y: input.y, button: 'left', clickCount: 1 },
            mainSession,
          );
        } else if (input.action === 'type')
          await cdp.call('Input.insertText', { text: input.text }, mainSession);
        // This expression is constant; users and models cannot provide JavaScript.
        const details = await cdp.call(
          'Runtime.evaluate',
          {
            expression:
              'JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||" ").slice(0,20000)})',
            returnByValue: true,
          },
          mainSession,
        );
        const result = details.result as { value?: unknown };
        let raw: { url: string; title: string; text: string };
        try {
          const value: unknown =
            typeof result?.value === 'string' ? JSON.parse(result.value) : null;
          if (
            !value ||
            typeof value !== 'object' ||
            !('url' in value) ||
            typeof value.url !== 'string' ||
            !('title' in value) ||
            typeof value.title !== 'string' ||
            !('text' in value) ||
            typeof value.text !== 'string'
          )
            throw new Error('Invalid browser text');
          raw = { url: value.url, title: value.title, text: value.text };
        } catch {
          // The page can replace globals; never surface its arbitrary parse errors.
          throw unavailable('Browser page text is unavailable.', 'browser_snapshot_failed');
        }
        const capture = await cdp.call(
          'Page.captureScreenshot',
          { format: 'png', captureBeyondViewport: false },
          mainSession,
        );
        if (typeof capture.data !== 'string' || capture.data.length > 8 * 1024 * 1024)
          throw unavailable('Screenshot exceeded the browser limit.', 'browser_screenshot_large');
        return {
          url: raw.url.slice(0, 2048),
          title: raw.title.slice(0, 500),
          text: raw.text.slice(0, 20_000),
          screenshot: Buffer.from(capture.data, 'base64'),
        };
      } finally {
        working = false;
      }
    },
  };
};
