import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import type { guardedRequest } from '../../kernel/net.js';
import { createTestStudio } from '../../testing/harness.js';
import { createBrowserEngine } from './engine.js';

/** Opt-in synthetic smoke; never uses a personal browser or real external service. */
it('operates a real isolated Chromium over CDP while routing only guarded synthetic HTTPS', async (test) => {
  const executable = process.env.CLOUD_HARNESS_TEST_CHROMIUM;
  if (!executable || !existsSync(executable)) return test.skip();
  const studio = await createTestStudio({ config: { sandbox: 'auto' } });
  const spawn = vi.spyOn(studio.studio.context.processes, 'spawn');
  let engine: Awaited<ReturnType<typeof createBrowserEngine>> | undefined;
  let stderr = '';
  const request = vi.fn<typeof guardedRequest>().mockImplementation(async (url) => ({
    status: 200,
    headers: { 'content-type': url.endsWith('/worker.js') ? 'text/javascript' : 'text/html' },
    body: Readable.from([
      url.endsWith('/worker.js')
        ? 'fetch("https://127.0.0.1/worker-secret")'
        : '<!doctype html><title>Synthetic browser</title><input style="position:absolute;left:20px;top:20px;width:200px" id="field"><button style="position:absolute;left:20px;top:100px" onclick="document.title=\'clicked:\'+document.getElementById(\'field\').value">Click</button><p style="margin-top:150px">Synthetic text only</p><img src="https://127.0.0.1/private"><iframe src="https://169.254.169.254/meta"></iframe><script>try { new WebSocket("wss://example.test/socket"); } catch {} navigator.serviceWorker?.register("/worker.js").catch(()=>{}); fetch("https://example.test/resource").catch(()=>{});</script>',
    ]),
  }));
  try {
    if (studio.studio.context.sandbox.status.mode !== 'bwrap') return test.skip();
    engine = await createBrowserEngine(studio.studio.context, executable, () => {}, {
      runtimeRoot: path.dirname(executable),
      request,
      onStderr: (text) => {
        stderr = (stderr + text).slice(-8000);
      },
    });
    expect(Object.keys(spawn.mock.calls.at(-1)?.[2]?.env ?? {}).sort()).toEqual([
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR',
    ]);
    const first = await engine.action({ action: 'navigate', url: 'https://example.test' });
    expect(first.text).toContain('Synthetic text only');
    expect(first.screenshot.subarray(1, 4).toString()).toBe('PNG');
    await engine.action({ action: 'click', x: 50, y: 30 });
    await engine.action({ action: 'type', text: 'synthetic input' });
    const clicked = await engine.action({ action: 'click', x: 40, y: 110 });
    expect(clicked.title).toBe('clicked:synthetic input');
    expect(request.mock.calls.every(([url]) => url.startsWith('https://example.test'))).toBe(true);
  } catch (error) {
    throw new Error(`Isolated browser smoke failed: ${String(error)}\n${stderr}`, { cause: error });
  } finally {
    await engine?.close();
    await studio.close();
  }
}, 90_000);
