import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { CdpPipe } from './cdp.js';
it('frames split CDP messages, correlates results and keeps target sessions', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const cdp = new CdpPipe(input, output);
  let sent = '';
  input.on('data', (chunk: Buffer) => {
    sent += chunk.toString();
  });
  const answer = cdp.call('Page.enable', {}, 'session-a');
  expect(JSON.parse(sent.slice(0, -1))).toMatchObject({
    id: 1,
    sessionId: 'session-a',
    method: 'Page.enable',
  });
  output.write('{"id":1,"res');
  output.write('ult":{"ok":true}}\0');
  expect(await answer).toEqual({ ok: true });
  cdp.close();
});
it('rejects pending commands on channel close', async () => {
  const cdp = new CdpPipe(new PassThrough(), new PassThrough());
  const answer = cdp.call('Browser.getVersion');
  cdp.close();
  await expect(answer).rejects.toMatchObject({ code: 'browser_closed' });
});
