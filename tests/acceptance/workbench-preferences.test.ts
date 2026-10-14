import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime } from './support/realtime.js';
import { startTestStudio, type ApiClient, type RunningStudio } from './support/studio.js';
import { createMember, signIn, type Json } from './support/workbench.js';

/**
 * 5.23 — Preferences that follow the account (requirements 01 §5.23; 02
 * AT-PJ-082; 04 §7.6). The service keeps a small map of named values per
 * account; a change made on one device is announced to the others. What each
 * value means is the client's business.
 */
describe('5.23 preferences follow the account', () => {
  let studio: RunningStudio;
  let owner: ApiClient;

  beforeAll(async () => {
    studio = await startTestStudio();
    owner = await studio.owner();
  });
  afterAll(() => studio?.destroy());

  const read = async (client: ApiClient) =>
    (await client.get<{ values: Json }>('/api/preferences')).body.values;
  const write = (client: ApiClient, values: Record<string, unknown>) =>
    client.patch<Json>('/api/preferences', { values });

  it('AT-PJ-082 (adapted): a preference switched on one device is there on the other — which is told at once — and survives signing in again', async () => {
    const tablet = await studio.owner();
    const live = await Realtime.open(studio, tablet);
    await live.subscribe(`user:${tablet.userId}`);
    const saved = await write(owner, { 'editor.wordWrap': true, 'appearance.theme': 'dark' });
    expect(saved.status).toBe(200);
    const told = await live.event(`user:${tablet.userId}`, 'preferences.changed');
    expect(JSON.stringify(told.data)).toContain('editor.wordWrap');
    expect(await read(tablet)).toMatchObject({
      'editor.wordWrap': true,
      'appearance.theme': 'dark',
    });
    // Changing one value leaves the others alone; null removes a value.
    await write(tablet, { 'editor.wordWrap': false });
    expect(await read(owner)).toMatchObject({
      'editor.wordWrap': false,
      'appearance.theme': 'dark',
    });
    await write(tablet, { 'appearance.theme': null });
    expect(await read(owner)).not.toHaveProperty('appearance.theme');
    expect(await read(await studio.owner())).toMatchObject({ 'editor.wordWrap': false });
    await live.close();
  });

  it('preferences are one’s own: another account neither sees nor changes them, and hears nothing about them', async () => {
    const member = await createMember(studio, owner, 'prefmember');
    const live = await Realtime.open(studio, member);
    await live.subscribe(`user:${member.userId}`);
    await write(owner, { 'home.layout': { tiles: ['inbox', 'usage'] } });
    expect(await read(member)).not.toHaveProperty('home.layout');
    await write(member, { 'home.layout': { tiles: ['memory'] } });
    expect((await read(owner))['home.layout']).toEqual({ tiles: ['inbox', 'usage'] });
    expect((await read(await signIn(studio, 'prefmember')))['home.layout']).toEqual({
      tiles: ['memory'],
    });
    const from = live.mark();
    await write(owner, { 'home.layout': { tiles: ['inbox'] } });
    live.sendFrame({ op: 'ping' });
    await live.waitFor((frame) => frame.op === 'pong', { from });
    expect(live.frames.slice(from).filter((frame) => frame.op === 'event')).toEqual([]);
    expect((await studio.client().get('/api/preferences')).status).toBe(401);
    expect((await studio.client().patch('/api/preferences', { values: { 'a.b': 1 } })).status).toBe(
      401,
    );
    await live.close();
  });

  it('a preference has a plain dotted name and a bounded size — anything else is refused and nothing is stored', async () => {
    const before = await read(owner);
    for (const key of [
      '',
      'Has Spaces',
      '../etc/passwd',
      '__proto__',
      'a/b',
      'a'.repeat(81),
      '.leading',
      'trailing.',
      'UPPER.case',
    ]) {
      expect((await write(owner, { [key]: 1 })).status, JSON.stringify(key)).toBe(400);
    }
    const tooBig = await write(owner, { 'home.blob': 'x'.repeat(64 * 1024 + 1) });
    expect(tooBig.status).toBe(413);
    expect((await owner.patch('/api/preferences', { 'editor.wordWrap': true })).status).toBe(400); // not wrapped in "values"
    expect(await read(owner)).toEqual(before);
    expect(Object.getPrototypeOf(await read(owner))).toBe(Object.prototype);
  });
});
