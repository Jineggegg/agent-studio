import { createHash } from 'node:crypto';
import { type NotificationSettings, type PushTestResult } from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorlds,
  device,
  idle,
  notifications,
  subscribe,
} from '../../src/modules/inbox/testing/world.js';
import { TestClient } from '../../src/testing/harness.js';

const worlds = createWorlds();
const start = worlds.start;
afterEach(() => worlds.closeAll());

const hashOf = (endpoint: string): string => createHash('sha256').update(endpoint).digest('hex');
const settings = async (client: TestClient, deviceHash?: string): Promise<NotificationSettings> =>
  (
    await client.get<NotificationSettings>(
      `/api/notifications/settings${deviceHash ? `?device=${deviceHash}` : ''}`,
    )
  ).body;

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

describe('preferences', () => {
  it("start with every event on, the app's list on, Web Push off and no details", async () => {
    const { kit } = await start();
    const fresh = await settings(kit.owner);
    expect(fresh.preferences).toEqual({
      events: {
        needsYou: true,
        replyFinished: true,
        backgroundFinished: true,
        failure: true,
        automation: true,
        plugin: true,
      },
      channels: { inApp: true, webPush: false },
      showDetails: false,
    });
    expect(fresh.push).toMatchObject({
      enabled: false,
      active: false,
      devices: [],
      maxDevices: 10,
    });
    expect(fresh.channels).toEqual([
      { id: 'inApp', configured: true, enabled: true },
      { id: 'webPush', configured: false, enabled: false },
    ]);
  });

  it('change one switch at a time, for one user at a time', async () => {
    const { kit } = await start();
    const member = await kit.t.member('other');
    const changed = await kit.owner.patch<NotificationSettings>('/api/notifications/preferences', {
      events: { failure: false },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.preferences.events).toEqual({
      needsYou: true,
      replyFinished: true,
      backgroundFinished: true,
      failure: false,
      automation: true,
      plugin: true,
    });
    expect(
      (
        await kit.owner.patch<NotificationSettings>('/api/notifications/preferences', {
          showDetails: true,
          channels: { inApp: false },
        })
      ).body.preferences,
    ).toMatchObject({
      events: { failure: false, needsYou: true },
      channels: { inApp: false, webPush: false },
      showDetails: true,
    });
    expect((await settings(member)).preferences.events.failure).toBe(true);
    // The change is announced to the account's other pages.
    expect(
      kit.userEvents(kit.owner.userId, 'notifications.settings.changed').length,
    ).toBeGreaterThan(0);
    expect(kit.userEvents(member.userId, 'notifications.settings.changed')).toEqual([]);

    // Nothing but known switches with boolean values is accepted.
    for (const body of [
      {},
      { events: { everything: false } },
      { events: { failure: 'no' } },
      { channels: { email: true } },
      { quietHours: true },
    ]) {
      expect((await kit.owner.patch('/api/notifications/preferences', body)).status).toBe(400);
    }
    // The Web Push switch means nothing without a device.
    expect(
      (await kit.owner.patch('/api/notifications/preferences', { channels: { webPush: true } }))
        .body,
    ).toMatchObject({ error: { code: 'no_devices' } });
    expect((await kit.t.anonymous().get('/api/notifications/settings')).status).toBe(401);

    // Rubbish written straight into the preference store is ignored, not obeyed.
    await kit.owner.patch('/api/preferences', {
      values: {
        'notifications.events': { failure: 'yes', needsYou: 0, replyFinished: false },
        'notifications.channels': 'all',
        'notifications.showDetails': 'on',
      },
    });
    expect((await settings(kit.owner)).preferences).toEqual({
      events: {
        needsYou: true,
        replyFinished: false,
        backgroundFinished: true,
        failure: true,
        automation: true,
        plugin: true,
      },
      channels: { inApp: true, webPush: false },
      showDetails: false,
    });
  });

  it('an event that is off, or a channel that is off, sends nothing through it', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner);
    const session = await kit.session(kit.owner, { title: 'Switches' });

    // The app's list off, Web Push on: pushed, not stored.
    await kit.owner.patch('/api/notifications/preferences', { channels: { inApp: false } });
    await kit.turn(kit.owner, session.id, 'one');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect(await notifications(kit.owner)).toEqual([]);

    // Web Push off, the list on: stored, not pushed.
    await kit.owner.patch('/api/notifications/preferences', {
      channels: { inApp: true, webPush: false },
    });
    await kit.turn(kit.owner, session.id, 'two');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect(await notifications(kit.owner)).toHaveLength(1);

    // With a device subscribed the switch can be turned back on.
    const back = await kit.owner.patch<NotificationSettings>('/api/notifications/preferences', {
      channels: { webPush: true },
    });
    expect(back.body.push).toMatchObject({ enabled: true, active: true });
  });
});

describe('the application-server key', () => {
  it('is generated once, served to signed-in clients, and its private half stays on the server', async () => {
    const world = await start();
    const { kit } = world;
    expect((await kit.t.anonymous().get('/api/notifications/push/key')).status).toBe(401);
    const key = (await kit.owner.get<{ publicKey: string }>('/api/notifications/push/key')).body
      .publicKey;
    expect(Buffer.from(key, 'base64url')).toHaveLength(65);
    expect((await settings(kit.owner)).push.publicKey).toBe(key);
    const member = await kit.t.member();
    expect(
      (await member.get<{ publicKey: string }>('/api/notifications/push/key')).body.publicKey,
    ).toBe(key);

    // In the database it is sealed; no response and no preference carries the private scalar.
    const context = kit.t.studio.context;
    const stored = JSON.parse(context.secrets.reveal('inbox.vapid-keys')!) as {
      privateKey: string;
      publicKey: string;
    };
    expect(stored.publicKey).toBe(key);
    const row = context.db.get<{ sealed: string; hint: string }>(
      "SELECT sealed, hint FROM secrets WHERE name = 'inbox.vapid-keys'",
    )!;
    expect(row.sealed).not.toContain(stored.privateKey);
    // The stored hint is a fixed marker: no part of the pair is kept in the clear beside the sealed value.
    expect(row.hint).toBe('••••');
    for (const url of [
      '/api/notifications/settings',
      '/api/notifications/push/key',
      '/api/preferences',
    ]) {
      expect(JSON.stringify((await kit.owner.get(url)).body)).not.toContain(stored.privateKey);
    }

    // The same key after a restart: subscriptions made for it keep working.
    await kit.t.studio.stop();
    const again = await start({ kit: { restartOf: kit }, push: world.push, clock: world.clock });
    expect(
      (await again.kit.owner.get<{ publicKey: string }>('/api/notifications/push/key')).body
        .publicKey,
    ).toBe(key);
  });
});

describe('devices', () => {
  it('subscribe: the first device turns the channel on, announces itself, and is recognisable as "this device"', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = push.browser('phone');
    const response = await kit.owner.request<NotificationSettings>(
      'POST',
      '/api/notifications/push/devices',
      phone.subscription(),
      { 'user-agent': CHROME_ANDROID },
    );
    expect(response.status).toBe(200);
    expect(response.body.push).toMatchObject({ enabled: true, active: true });
    expect(response.body.push.devices).toEqual([
      {
        id: expect.any(String),
        label: 'Chrome on Android',
        fingerprint: hashOf(phone.endpoint).slice(0, 16),
        current: true,
        createdAt: expect.any(Number),
        lastDeliveredAt: null,
      },
    ]);
    // The endpoint itself is never handed back to a page.
    expect(JSON.stringify(response.body)).not.toContain(phone.path);

    await idle(world);
    expect(push.payloads(phone)).toEqual([
      {
        title: 'Notifications are on',
        body: 'Chrome on Android will now receive notifications.',
        tag: 'system:device-added',
        url: '/settings/notifications',
      },
    ]);
    expect(push.to(phone)[0]!.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      ttl: '3600',
      urgency: 'normal',
      authorization: expect.stringMatching(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/),
    });
    expect((await notifications(kit.owner))[0]).toMatchObject({
      kind: 'system',
      title: 'Notifications are on',
      link: '/settings/notifications',
    });

    // A page recognises its own row by the hash of its endpoint; any other page sees no marker.
    expect((await settings(kit.owner, hashOf(phone.endpoint))).push.devices[0]).toMatchObject({
      current: true,
      lastDeliveredAt: expect.any(Number),
    });
    expect((await settings(kit.owner)).push.devices[0]!.current).toBe(false);
    expect(
      (await settings(kit.owner, hashOf('https://fcm.googleapis.com/other'))).push.devices[0]!
        .current,
    ).toBe(false);
    expect((await kit.owner.get('/api/notifications/settings?device=nonsense')).status).toBe(400);

    // The same browser subscribing again is the same device (renamed here), not a second one.
    await subscribe(kit.owner, phone, { label: 'Pocket\u0007 phone\nline two' });
    const renamed = await settings(kit.owner);
    expect(renamed.push.devices).toHaveLength(1);
    expect(renamed.push.devices[0]!.label).toBe('Pocket phone line two');

    // It is on the record as a security event, once, with the network it came from.
    const audit = (
      await kit.owner.get<{ events: Array<{ action: string; subject: string | null }> }>(
        '/api/audit?limit=50',
      )
    ).body.events;
    expect(audit.filter((event) => event.action === 'push.device-added')).toEqual([
      expect.objectContaining({ subject: 'Chrome on Android' }),
    ]);
  });

  it('refuses what is not a subscription a browser could have made', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = push.browser();
    const good = phone.subscription() as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    expect((await kit.t.anonymous().post('/api/notifications/push/devices', good)).status).toBe(
      401,
    );
    const hostile: Array<Record<string, unknown>> = [
      { ...good, endpoint: 'https://attacker.example/collect' },
      { ...good, endpoint: 'http://169.254.169.254/latest/meta-data' },
      { ...good, endpoint: 'file:///etc/passwd' },
      { ...good, endpoint: `http://user:pw@${new URL(good.endpoint).host}/push/x` },
      { ...good, keys: { p256dh: 'AAAA'.repeat(8), auth: good.keys.auth } },
      { ...good, keys: { p256dh: good.keys.p256dh, auth: 'AAAAAAAAAAAA' } },
      { ...good, keys: { p256dh: good.keys.p256dh } },
      { endpoint: good.endpoint },
      { ...good, actAs: 'someone-else' },
    ];
    for (const body of hostile)
      expect(
        (await kit.owner.post('/api/notifications/push/devices', body)).status,
        JSON.stringify(body).slice(0, 80),
      ).toBe(400);
    expect((await settings(kit.owner)).push).toMatchObject({ enabled: false, devices: [] });
    expect(push.received).toEqual([]);

    // An API token has no browser to subscribe.
    const token = (
      await kit.owner.post<{ token: string }>('/api/auth/tokens', {
        name: 'robot',
        scopes: ['read', 'write'],
      })
    ).body.token;
    const robot = new TestClient(kit.t.studio);
    robot.bearer = token;
    expect((await robot.post('/api/notifications/push/devices', good)).body).toMatchObject({
      error: { code: 'session_required' },
    });
    // It can still read the key and the settings.
    expect((await robot.get('/api/notifications/settings')).status).toBe(200);
  });

  it('by default accepts only the push services browsers use — and only over https', async () => {
    // No stand-in is allowed here: this Studio runs with the production policy.
    const { kit, push } = await start({
      inbox: { push: { allowedHosts: undefined, policy: undefined } },
    });
    const browser = push.browser();
    expect(
      (await kit.owner.post('/api/notifications/push/devices', browser.subscription())).body,
    ).toMatchObject({ error: { code: 'unsupported_push_service' } });
    // A real service is refused over plain http. (An accepted address is never subscribed here: this test must not contact one.)
    expect(
      (
        await kit.owner.post('/api/notifications/push/devices', {
          ...browser.subscription(),
          endpoint: 'http://fcm.googleapis.com/fcm/send/abc',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await kit.owner.post('/api/notifications/push/devices', {
          ...browser.subscription(),
          endpoint: 'https://fcm.googleapis.com.evil.example/fcm/send/abc',
        })
      ).status,
    ).toBe(400);
    expect(push.received).toEqual([]);
    expect((await settings(kit.owner)).push.devices).toEqual([]);
  });

  it('keeps at most ten devices per user', async () => {
    const world = await start();
    const { kit, push } = world;
    for (let index = 0; index < 10; index += 1)
      await subscribe(kit.owner, push.browser(`d${index}`), {
        resubscribe: false,
        label: `Device ${index}`,
      });
    const eleventh = await kit.owner.post(
      '/api/notifications/push/devices',
      push.browser('d10').subscription(),
    );
    expect(eleventh.status).toBe(409);
    expect(eleventh.body).toMatchObject({ error: { code: 'too_many_devices' } });
    expect((await settings(kit.owner)).push.devices).toHaveLength(10);
    // Another user's allowance is their own.
    const member = await kit.t.member();
    await subscribe(member, push.browser('theirs'));
    await idle(world);
  });

  it('remove: the other devices keep receiving; with the last one gone the channel is off', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner, 'phone');
    const tablet = await device(world, kit.owner, 'tablet');
    const [first, second] = (await settings(kit.owner, hashOf(tablet.endpoint))).push.devices;
    expect([first!.current, second!.current]).toEqual([false, true]);
    const session = await kit.session(kit.owner, { title: 'Devices' });

    const removed = await kit.owner.delete<NotificationSettings>(
      `/api/notifications/push/devices/${second!.id}`,
    );
    expect(removed.body.push).toMatchObject({ enabled: true, active: true });
    expect(removed.body.push.devices.map((entry) => entry.id)).toEqual([first!.id]);
    await kit.turn(kit.owner, session.id, 'one');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect(push.to(tablet)).toEqual([]);

    // The last one: the switch goes off and cannot be turned on with nothing to push to.
    const last = await kit.owner.delete<NotificationSettings>(
      `/api/notifications/push/devices/${first!.id}`,
    );
    expect(last.body.push).toMatchObject({ enabled: false, active: false, devices: [] });
    expect(last.body.channels[1]).toEqual({ id: 'webPush', configured: false, enabled: false });
    await kit.turn(kit.owner, session.id, 'two');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect((await kit.owner.delete(`/api/notifications/push/devices/${first!.id}`)).status).toBe(
      404,
    );

    // A device the user took away comes back as a new device: announced again.
    await subscribe(kit.owner, phone, { resubscribe: true });
    await idle(world);
    expect(push.payloads(phone).at(-1)).toMatchObject({ title: 'Notifications are on' });
    expect((await settings(kit.owner)).push.enabled).toBe(true);
  });

  it("are each user's own: nobody removes or unsubscribes somebody else's", async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('intruder');
    await kit.share(kit.project, member);
    const phone = await device(world, kit.owner);
    const [mine] = (await settings(kit.owner)).push.devices;

    expect((await member.delete(`/api/notifications/push/devices/${mine!.id}`)).status).toBe(404);
    expect((await member.delete(`/api/notifications/push/devices/${mine!.id}`)).body).toEqual(
      (await member.delete(`/api/notifications/push/devices/${'0'.repeat(26)}`)).body,
    );
    expect(
      (await member.post('/api/notifications/push/unsubscribe', { endpoint: phone.endpoint }))
        .status,
    ).toBe(200);
    expect((await settings(kit.owner)).push.devices).toHaveLength(1);
    expect((await settings(member)).push.devices).toEqual([]);

    const session = await kit.session(kit.owner, { title: 'Still mine' });
    await kit.turn(kit.owner, session.id, 'go');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);

    // The browser unsubscribing itself removes its own row, and the channel follows.
    expect(
      (
        await kit.owner.post<NotificationSettings>('/api/notifications/push/unsubscribe', {
          endpoint: phone.endpoint,
        })
      ).body.push,
    ).toMatchObject({ enabled: false, devices: [] });
  });

  it('a browser belongs to one account at a time', async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('next-user');
    await kit.share(kit.project, member);
    const shared = await device(world, kit.owner, 'family-tablet');

    // Somebody else signs in on the same browser and enables notifications: the same endpoint.
    await subscribe(member, shared);
    await idle(world);
    expect((await settings(kit.owner)).push.devices).toEqual([]);
    expect((await settings(member)).push.devices).toHaveLength(1);
    push.received.length = 0;

    // What happens to the first account no longer reaches that browser.
    const session = await kit.session(kit.owner, { title: 'Private work' });
    await kit.turn(kit.owner, session.id, 'go');
    await idle(world);
    expect(push.received).toEqual([]);
  });
});

describe('subscriptions the push service no longer knows', () => {
  it('are removed the first time it says so, and nothing more is sent to them', async () => {
    const world = await start();
    const { kit, push } = world;
    const gone = await device(world, kit.owner, 'old-phone');
    const fine = await device(world, kit.owner, 'laptop');
    const session = await kit.session(kit.owner, { title: 'Pruning' });

    push.answer(gone, 410);
    await kit.turn(kit.owner, session.id, 'one');
    await idle(world);
    expect(push.to(gone)).toHaveLength(1);
    expect((await settings(kit.owner)).push.devices.map((entry) => entry.label)).toHaveLength(1);
    await kit.turn(kit.owner, session.id, 'two');
    await idle(world);
    expect(push.to(gone)).toHaveLength(1);
    expect(push.to(fine)).toHaveLength(2);

    // 404 means the same. Here it is the last device: the channel goes off with it.
    push.answer(fine, 404);
    const result = (await kit.owner.post<PushTestResult>('/api/notifications/push/test', {})).body;
    expect(result).toMatchObject({
      ok: false,
      enabled: false,
      sent: 0,
      removed: 1,
      failed: 0,
      devices: [{ outcome: 'gone', removed: true }],
    });
    expect((await settings(kit.owner)).push).toMatchObject({ enabled: false, devices: [] });
  });
});

describe('the test notification', () => {
  it('goes to every device through the same path and reports each one', async () => {
    const world = await start();
    const { kit, push, clock } = world;
    // No devices: said plainly, and it does not count against the limit.
    expect((await kit.owner.post<PushTestResult>('/api/notifications/push/test', {})).body).toEqual(
      { ok: false, enabled: false, devices: [], sent: 0, removed: 0, failed: 0 },
    );

    const phone = await device(world, kit.owner, 'phone');
    const laptop = await device(world, kit.owner, 'laptop');
    const broken = await device(world, kit.owner, 'broken');
    push.answer(broken, 503);
    // The channel switch does not matter to a test.
    await kit.owner.patch('/api/notifications/preferences', { channels: { webPush: false } });

    const result = await kit.owner.post<PushTestResult>('/api/notifications/push/test', {
      origin: 'settings',
      device: hashOf(laptop.endpoint),
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, enabled: false, sent: 2, removed: 0, failed: 1 });
    expect(
      result.body.devices.map((entry) => [entry.outcome, entry.current, entry.httpStatus ?? null]),
    ).toEqual([
      ['sent', false, null],
      ['sent', true, null],
      ['rejected', false, 503],
    ]);
    expect(push.payloads(phone)).toEqual([
      {
        title: 'Test notification',
        body: 'Notifications from Cloud Harness reach this device.',
        tag: 'system:test',
        url: '/settings/notifications',
      },
    ]);
    expect(push.to(phone)[0]!.headers).toMatchObject({ urgency: 'high', ttl: '600' });
    // A test is not an event: nothing is added to the list.
    expect(await notifications(kit.owner)).toEqual([]);

    // Again at once: refused, with how long to wait.
    const again = await kit.owner.post('/api/notifications/push/test', {});
    expect(again.status).toBe(429);
    expect(again.body).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfterSeconds: 10 } },
    });
    expect(again.headers['retry-after']).toBe('10');
    // Each user has their own allowance.
    const member = await kit.t.member();
    expect((await member.post('/api/notifications/push/test', {})).status).toBe(200);

    // Later it works again; started from an automations tab it opens the home screen.
    clock.advance(10_001);
    push.received.length = 0;
    expect(
      (
        await kit.owner.post<PushTestResult>('/api/notifications/push/test', {
          origin: 'automations',
        })
      ).body.sent,
    ).toBe(2);
    expect(push.payloads(phone)[0]!.url).toBe('/');

    // Twelve an hour at most.
    for (let sent = 2; sent < 12; sent += 1) {
      clock.advance(10_001);
      expect((await kit.owner.post('/api/notifications/push/test', {})).status).toBe(200);
    }
    clock.advance(10_001);
    const thirteenth = await kit.owner.post<{ error: { details: { retryAfterSeconds: number } } }>(
      '/api/notifications/push/test',
      {},
    );
    expect(thirteenth.status).toBe(429);
    expect(thirteenth.body.error.details.retryAfterSeconds).toBeGreaterThan(60);
    expect(
      (await kit.owner.post('/api/notifications/push/test', { origin: 'elsewhere' })).status,
    ).toBe(400);
  });
});

describe('limits on sending', () => {
  it('drops what exceeds the per-user rate instead of queueing it', async () => {
    const world = await start({ inbox: { push: { perUserPerMinute: 2 } } });
    const { kit, push, clock } = world;
    const phone = await device(world, kit.owner);
    // The confirmation used one of this minute's two.
    const inbox = kit.t.studio.context.services.inbox;
    const send = (index: number) =>
      inbox.notify(kit.owner.userId!, {
        kind: 'automation',
        title: 'demo',
        body: `reminder ${index}`,
        link: '/',
        tag: `automation:${index}`,
      });

    expect(await send(1)).toMatchObject({
      status: 'delivered',
      inApp: true,
      push: { attempted: true, accepted: 1 },
    });
    const dropped = await send(2);
    expect(dropped).toMatchObject({
      status: 'delivered',
      inApp: true,
      push: { attempted: false, reason: 'rate-limited', accepted: 0 },
    });
    expect(push.to(phone)).toHaveLength(1);

    // A minute later there is room again — and what was dropped is not delivered late.
    clock.advance(60_001);
    await send(3);
    await idle(world);
    expect(push.payloads(phone).map((payload) => payload.body)).toEqual([
      'reminder 1',
      'reminder 3',
    ]);
    // The app's own list is not rate-limited.
    expect(await notifications(kit.owner)).toHaveLength(3);
  });

  it('talks to push services a bounded number at a time', async () => {
    const world = await start({ inbox: { push: { concurrency: 2 } } });
    const { kit, push } = world;
    const browsers = [];
    for (let index = 0; index < 6; index += 1)
      browsers.push(await device(world, kit.owner, `d${index}`));
    const releases = browsers.map((browser) => push.hold(browser));
    push.maxConcurrent = 0;

    const pending = kit.t.studio.context.services.inbox.notify(kit.owner.userId!, {
      kind: 'automation',
      title: 'demo',
      body: 'all at once',
      link: '/',
      tag: 'automation:burst',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Two requests are with the service; the other four wait their turn.
    expect(push.received).toHaveLength(2);
    for (const release of releases) release();
    expect(await pending).toMatchObject({ status: 'delivered', push: { accepted: 6 } });
    expect(push.maxConcurrent).toBe(2);
    expect(push.received).toHaveLength(6);
  });
});

describe('signing out', () => {
  it('"sign out everywhere" ends every device\'s subscription; the same browser comes back quietly, a new one is announced', async () => {
    const world = await start();
    const { kit, push } = world;
    const member = await kit.t.member('traveller');
    await kit.share(kit.project, member);
    const phone = await device(world, member, 'phone');
    const laptopClient = await kit.t.signIn('traveller');
    const laptop = await device(world, laptopClient, 'laptop');
    const session = await kit.session(member, { title: 'Before signing out' });
    await kit.turn(member, session.id, 'one');
    await idle(world);
    expect([push.to(phone).length, push.to(laptop).length]).toEqual([1, 1]);
    push.received.length = 0;

    expect((await member.post('/api/auth/logout-everywhere')).status).toBe(204);
    // No browser of the account is signed in any more: no device is subscribed to it, and nothing is sent.
    const devicesLeft = kit.t.studio.context.db.all(
      'SELECT id FROM inbox_push_devices WHERE user_id = ?',
      member.userId!,
    );
    expect(devicesLeft).toEqual([]);
    const agents = kit.t.studio.context.services.agents;
    const receipt = await agents.sendMessage(
      agents.principalFor(member.userId!)!,
      session.id,
      { requestId: 'after-sign-out', text: 'scheduled while signed out' },
      { origin: 'scheduled' },
    );
    await kit.runEnded(kit.owner, receipt.runId!);
    await idle(world);
    expect(push.received).toEqual([]);

    // The same browser signs in again and re-registers what it still holds: no announcement, and the switch stays as it was left (on).
    const back = await kit.t.signIn('traveller');
    const quiet = await back.post<NotificationSettings>(
      '/api/notifications/push/devices',
      phone.subscription({ resubscribe: true }),
    );
    expect(quiet.body.push).toMatchObject({ enabled: true, active: true });
    expect(quiet.body.push.devices).toHaveLength(1);
    await idle(world);
    expect(push.received).toEqual([]);
    const auditBefore = (
      await kit.owner.get<{ events: Array<{ action: string; userId: string | null }> }>(
        '/api/audit?limit=100',
      )
    ).body.events.filter(
      (event) => event.action === 'push.device-added' && event.userId === member.userId,
    );
    expect(auditBefore).toHaveLength(2);

    // A switch the user had turned off is not turned back on by re-registering.
    await back.patch('/api/notifications/preferences', { channels: { webPush: false } });
    await back.post('/api/auth/logout-everywhere');
    const third = await kit.t.signIn('traveller');
    expect(
      (
        await third.post<NotificationSettings>(
          '/api/notifications/push/devices',
          phone.subscription({ resubscribe: true }),
        )
      ).body.push,
    ).toMatchObject({ enabled: false, active: false });

    // An endpoint nobody has seen claims to be a re-registration: it is a new device — announced, switched on, on the record.
    const stranger = push.browser('stranger');
    expect(
      (
        await third.post<NotificationSettings>(
          '/api/notifications/push/devices',
          stranger.subscription({ resubscribe: true }),
        )
      ).body.push,
    ).toMatchObject({ enabled: true, active: true });
    await idle(world);
    expect(push.payloads(stranger)).toEqual([
      expect.objectContaining({ title: 'Notifications are on' }),
    ]);
    expect(push.payloads(phone)).toEqual([
      expect.objectContaining({ title: 'Notifications are on' }),
    ]);
    const auditAfter = (
      await kit.owner.get<{ events: Array<{ action: string; userId: string | null }> }>(
        '/api/audit?limit=100',
      )
    ).body.events.filter(
      (event) => event.action === 'push.device-added' && event.userId === member.userId,
    );
    expect(auditAfter).toHaveLength(3);
  });

  it("signing out of one browser ends that browser's subscription only", async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner, 'phone');
    const second = await kit.t.signIn('owner');
    const laptop = await device(world, second, 'laptop');

    expect((await second.post('/api/auth/logout')).status).toBe(204);
    expect((await settings(kit.owner)).push).toMatchObject({ enabled: true, active: true });
    expect((await settings(kit.owner)).push.devices).toHaveLength(1);
    const session = await kit.session(kit.owner, { title: 'One browser fewer' });
    await kit.turn(kit.owner, session.id, 'go');
    await idle(world);
    expect(push.to(phone)).toHaveLength(1);
    expect(push.to(laptop)).toEqual([]);

    // Ending a session from the list of signed-in devices does the same.
    const third = await kit.t.signIn('owner');
    const tablet = await device(world, third, 'tablet');
    const sessions = (
      await kit.owner.get<{ sessions: Array<{ id: string; current: boolean }> }>(
        '/api/auth/sessions',
      )
    ).body.sessions;
    const other = sessions.find((entry) => !entry.current)!;
    expect((await kit.owner.delete(`/api/auth/sessions/${other.id}`)).status).toBe(204);
    await kit.turn(kit.owner, session.id, 'again');
    await idle(world);
    expect(push.to(tablet)).toEqual([]);
    // (Subscribing the tablet cleared the record of what the stand-in had received before.)
    expect(push.to(phone)).toHaveLength(1);
  });

  it('a sign-in that simply expired is noticed when something is about to be sent', async () => {
    const world = await start();
    const { kit, push } = world;
    const phone = await device(world, kit.owner, 'phone');
    const second = await kit.t.signIn('owner');
    const forgotten = await device(world, second, 'forgotten-laptop');
    // The second browser's session runs out without anybody signing out: no event tells of it.
    const context = kit.t.studio.context;
    const laptopRow = context.db.get<{ credential_id: string }>(
      'SELECT credential_id FROM inbox_push_devices ORDER BY created_at DESC LIMIT 1',
    )!;
    context.db.run(
      'UPDATE auth_sessions SET expires_at = ? WHERE id = ?',
      Date.now() - 1000,
      laptopRow.credential_id,
    );

    const result = (await kit.owner.post<PushTestResult>('/api/notifications/push/test', {})).body;
    expect(result.devices.map((entry) => [entry.outcome, entry.removed])).toEqual([
      ['sent', false],
      ['signed-out', true],
    ]);
    expect(push.to(phone)).toHaveLength(1);
    expect(push.to(forgotten)).toEqual([]);
    expect((await settings(kit.owner)).push.devices).toHaveLength(1);
  });
});
