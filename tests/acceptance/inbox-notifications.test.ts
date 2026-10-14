import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Realtime, until } from './support/realtime.js';
import type { ApiClient, RunningStudio } from './support/studio.js';
import {
  approvalsWaiting,
  createMember,
  createProject,
  createSession,
  decide,
  runEnded,
  runToEnd,
  send,
  shareProject,
  startAgentStudio,
  type ErrorBody,
  type Json,
  type Project,
} from './support/workbench.js';

/**
 * 6.3 — Notifications, their preferences and Web Push at the API level
 * (requirements 04 §6.3 AT-NTF-016…042, §7.5).
 *
 * Deliberate differences: in-app and Web Push only (no e-mail, SMS or relay
 * channel — AT-NTF-029…037 have nothing to test); and the sentence a
 * notification leads with says which conversation and what happened, never
 * the message, the command or the error text.
 *
 * What cannot be done from outside: the server delivers only to real push
 * services, and registering a device makes it send a confirmation there. So
 * nothing here registers a device; acceptance of a subscription, the device
 * list, removal and real deliveries are left to the module's own suite, which
 * has a stand-in push service. Refusals, the key, preferences and the
 * test-send report with no device are checked here.
 */
describe('6.3 notifications and preferences', () => {
  let studio: RunningStudio;
  let owner: ApiClient;
  let project: Project;
  let people = 0;

  beforeAll(async () => {
    studio = await startAgentStudio();
    owner = await studio.owner();
    project = await createProject(studio, owner, 'Notify Project');
  });
  afterAll(() => studio?.destroy());

  async function person(): Promise<ApiClient> {
    const member = await createMember(studio, owner, `notifyuser${(people += 1)}`);
    await shareProject(owner, project.id, member.userId!, 'write');
    return member;
  }
  const stored = async (client: ApiClient, query = '?order=newest') =>
    (
      await client.get<{ notifications: Json[]; unread: number; hasMore: boolean }>(
        `/api/notifications${query}`,
      )
    ).body;
  /** Waits until the person's list holds a notification of that kind (they are raised just after the event). */
  const notificationOf = (client: ApiClient, kind: string, sessionId?: string) =>
    until(
      async () =>
        (await stored(client)).notifications.find(
          (item) => item.kind === kind && (sessionId === undefined || item.sessionId === sessionId),
        ),
      { what: `a ${kind} notification` },
    );

  it('AT-NTF-042: a brand-new user has every event on, the in-app list on and Web Push off; changing one switch leaves all the others as they were', async () => {
    const me = await person();
    const fresh = (await me.get<Json>('/api/notifications/settings')).body;
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
      showDetails: false, // what a notification says off-device is the short form unless the user asks for more
    });
    expect(fresh.channels).toEqual([
      { id: 'inApp', configured: true, enabled: true },
      { id: 'webPush', configured: false, enabled: false },
    ]);
    const changed = await me.patch<Json>('/api/notifications/preferences', {
      events: { failure: false },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.preferences).toEqual({
      ...fresh.preferences,
      events: { ...fresh.preferences.events, failure: false },
    });
    const detailed = await me.patch<Json>('/api/notifications/preferences', { showDetails: true });
    expect(detailed.body.preferences).toEqual({
      ...fresh.preferences,
      events: { ...fresh.preferences.events, failure: false },
      showDetails: true,
    });
    // On another device of the same account the change is already there; another account is untouched.
    const elsewhere = studio.client();
    await elsewhere.login({
      username: `notifyuser${people}`,
      password: `notifyuser${people} passphrase 12`,
    });
    expect(
      (await elsewhere.get<Json>('/api/notifications/settings')).body.preferences.events.failure,
    ).toBe(false);
    expect(
      (await owner.get<Json>('/api/notifications/settings')).body.preferences.events.failure,
    ).toBe(true);

    // Only known switches, only booleans, and never "nothing".
    for (const bad of [
      {},
      { events: { everything: false } },
      { events: { failure: 'no' } },
      { channels: { email: true } },
      { quietHours: true },
      { showDetails: 'yes' },
    ]) {
      expect(
        (await me.patch('/api/notifications/preferences', bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    // AT-NTF-021: with no subscribed device the Web Push switch cannot be turned on.
    const push = await me.patch<ErrorBody>('/api/notifications/preferences', {
      channels: { webPush: true },
    });
    expect(push.status).toBe(409);
    expect(push.body.error.code).toBe('no_devices');
    expect((await me.get<Json>('/api/notifications/settings')).body.preferences.channels).toEqual({
      inApp: true,
      webPush: false,
    });
    expect((await studio.client().get('/api/notifications/settings')).status).toBe(401);
  });

  it('AT-NTF-042: switching off "reply finished" alone leaves "background finished" — and every other switch — unchanged', async () => {
    const me = await person();
    const before = (await me.get<Json>('/api/notifications/settings')).body.preferences;
    expect(before.events).toMatchObject({ replyFinished: true, backgroundFinished: true });
    const changed = await me.patch<Json>('/api/notifications/preferences', {
      events: { replyFinished: false },
    });
    expect(changed.body.preferences).toEqual({
      ...before,
      events: { ...before.events, replyFinished: false },
    });
    expect((await me.get<Json>('/api/notifications/settings')).body.preferences).toEqual(
      changed.body.preferences,
    );
    // The other way round: each switch moves alone, whichever is changed and in either direction.
    const background = await me.patch<Json>('/api/notifications/preferences', {
      events: { backgroundFinished: false },
    });
    expect(background.body.preferences.events).toEqual({
      ...before.events,
      replyFinished: false,
      backgroundFinished: false,
    });
    const reply = await me.patch<Json>('/api/notifications/preferences', {
      events: { replyFinished: true },
    });
    expect(reply.body.preferences.events).toEqual({
      ...before.events,
      backgroundFinished: false,
    });
  });

  it('AT-NTF-025 (adapted): a "needs you" notification names the conversation, the agent and the tool, and leads to the session — its sentence carries neither the command nor the message', async () => {
    const me = await person();
    const live = await Realtime.open(studio, me);
    await live.subscribe(`user:${me.userId}`);
    const session = await createSession(me, project.id, 'claude-code', { title: 'Release prep' });
    const run = await send(
      me,
      session.id,
      'my message mentions hunter2 [[scenario:bash npm test --token=abc123secret]]',
    );
    const [approval] = await approvalsWaiting(me, session.id);
    const notification = await notificationOf(me, 'needs-you', session.id);
    expect(notification).toMatchObject({
      title: 'Release prep',
      body: 'Claude Code needs your approval to use Bash',
      link: `/projects/${project.id}/sessions/${session.id}`,
      tag: `needs-you:${session.id}`,
      runId: run.runId,
      projectId: project.id,
      targetAvailable: true,
      readAt: null,
    });
    for (const text of [notification.title, notification.body]) {
      expect(text).not.toContain('npm test');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('abc123secret');
    }
    // The extra line (shown in the app, and off-device only when the user chose "show details") never holds a secret-looking value.
    expect(notification.detail).toContain('npm test');
    expect(notification.detail).not.toContain('abc123secret');
    // Every device is told a notification arrived, with the new unread count.
    const told = await live.event(`user:${me.userId}`, 'notifications.changed', {
      where: (frame) => frame.data.reason === 'added',
    });
    expect(told.data.unread).toBeGreaterThanOrEqual(1);
    expect((await me.get<Json>('/api/notifications/unread')).body.unread).toBe(1);

    // Once the request is answered there is nothing left to do: the notification is read by itself.
    await decide(me, approval!.id, 'deny');
    await runEnded(me, run.runId!);
    const after = await until(
      async () => {
        const item = (await stored(me)).notifications.find((entry) => entry.id === notification.id);
        return item && item.readAt !== null ? item : undefined;
      },
      { what: 'the answered request’s notification to be read' },
    );
    expect(after.readAt).toBeGreaterThan(0);
    await live.close();
  });

  it('AT-NTF-029 (adapted): a failure notification says that the run failed, in which conversation — its sentence carries no error text, and the detail line has secret-looking values removed', async () => {
    const me = await person();
    const session = await createSession(me, project.id, 'claude-code', { title: 'Nightly import' });
    await runToEnd(me, session.id, 'import with the password hunter2 [[scenario:crash]]');
    const notification = await notificationOf(me, 'run-failed', session.id);
    expect(notification).toMatchObject({
      title: 'Nightly import',
      body: "Claude Code's run failed",
      tag: `run-failed:${session.id}`,
    });
    expect(notification.body).not.toMatch(/exit code|crashed|api_key|hunter2/);
    expect(notification.detail).toContain('ended with an error');
    expect(notification.detail).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'); // the key-shaped string the stand-in prints as it dies
    expect(notification.detail).toContain('[redacted]');
  });

  it('AT-NTF-023: with "reply finished" off and "error" on, a finished run raises nothing and a failed run does', async () => {
    const me = await person();
    expect(
      (await me.patch('/api/notifications/preferences', { events: { replyFinished: false } }))
        .status,
    ).toBe(200);
    const fine = await createSession(me, project.id);
    const broken = await createSession(me, project.id);
    await runToEnd(me, fine.id, 'this finishes');
    await runToEnd(me, broken.id, 'this fails [[scenario:crash]]');
    await notificationOf(me, 'run-failed', broken.id);
    const list = (await stored(me)).notifications;
    expect(list.map((item) => item.kind)).toEqual(['run-failed']);
    // Switched off means not stored at all — the result is still in the inbox, where it belongs.
    expect((await me.get<Json>('/api/inbox')).body.counts).toMatchObject({
      results: 1,
      needsHandling: 1,
    });

    // The other way round.
    await me.patch('/api/notifications/preferences', {
      events: { replyFinished: true, failure: false },
    });
    const fine2 = await createSession(me, project.id);
    const broken2 = await createSession(me, project.id);
    await runToEnd(me, broken2.id, 'this fails quietly [[scenario:crash]]');
    await runToEnd(me, fine2.id, 'this finishes loudly');
    await notificationOf(me, 'reply-finished', fine2.id);
    expect(
      (await stored(me)).notifications.filter((item) => item.sessionId === broken2.id),
    ).toEqual([]);
  });

  it('NTF-01: with "needs you" off no notification is raised for an approval — the request itself still waits, in the session and the inbox', async () => {
    const me = await person();
    await me.patch('/api/notifications/preferences', {
      events: { needsYou: false, replyFinished: false },
    });
    const session = await createSession(me, project.id);
    const run = await send(me, session.id, 'quiet approval [[scenario:bash npm test]]');
    const [approval] = await approvalsWaiting(me, session.id);
    expect((await me.get<Json>('/api/inbox')).body.counts.approvals).toBe(1);
    await decide(me, approval!.id, 'allow');
    await runEnded(me, run.runId!);
    expect((await stored(me)).notifications).toEqual([]);
  });

  it('AT-NTF-028 (adapted): two "reply finished" notifications for one conversation and one for another are two notifications, not three — the newer replaces the older', async () => {
    const me = await person();
    const a = await createSession(me, project.id);
    const b = await createSession(me, project.id);
    const first = await runToEnd(me, a.id, 'first reply in A');
    await notificationOf(me, 'reply-finished', a.id);
    await runToEnd(me, b.id, 'a reply in B');
    await notificationOf(me, 'reply-finished', b.id);
    const second = await runToEnd(me, a.id, 'second reply in A');
    const newest = await until(
      async () => (await stored(me)).notifications.find((item) => item.runId === second.id),
      { what: 'the newer notification for A' },
    );
    const list = (await stored(me)).notifications;
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.tag).sort()).toEqual(
      [`reply-finished:${a.id}`, `reply-finished:${b.id}`].sort(),
    );
    expect(list.some((item) => item.runId === first.id)).toBe(false);
    expect(newest.sessionId).toBe(a.id);
  });

  it('the notification list is one’s own: reading, reading all, deleting and clearing change only the caller’s — another person’s notification is "not found"', async () => {
    const me = await person();
    const other = await person();
    const sessions = [
      await createSession(me, project.id),
      await createSession(me, project.id),
      await createSession(me, project.id),
    ];
    for (const session of sessions) {
      await runToEnd(me, session.id, 'done');
      await notificationOf(me, 'reply-finished', session.id);
    }
    const theirs = await createSession(other, project.id);
    await runToEnd(other, theirs.id, 'done for someone else');
    const foreign = await notificationOf(other, 'reply-finished', theirs.id);

    let mine = await stored(me);
    expect(mine.unread).toBe(3);
    expect(mine.notifications.every((item) => item.sessionId !== theirs.id)).toBe(true);
    const [newest, middle, oldest] = mine.notifications;
    expect((await me.post<Json>(`/api/notifications/${newest!.id}/read`)).body).toEqual({
      changed: 1,
      unread: 2,
    });
    expect((await me.post<Json>(`/api/notifications/${newest!.id}/read`)).body).toEqual({
      changed: 0,
      unread: 2,
    });
    expect((await stored(me, '?unread=only')).notifications.map((item) => item.id).sort()).toEqual(
      [middle!.id, oldest!.id].sort(),
    );
    expect((await stored(me, '?order=unread-first')).notifications.at(-1)!.id).toBe(newest!.id);
    // Read everything about one conversation, then everything.
    expect(
      (await me.post<Json>('/api/notifications/read-all', { sessionId: middle!.sessionId })).body,
    ).toEqual({ changed: 1, unread: 1 });
    expect((await me.delete<Json>(`/api/notifications/${oldest!.id}`)).body).toEqual({
      changed: 1,
      unread: 0,
    });
    expect((await me.post<Json>('/api/notifications/clear', { scope: 'read' })).body).toEqual({
      changed: 2,
      unread: 0,
    });
    mine = await stored(me);
    expect(mine.notifications).toEqual([]);

    for (const attempt of [
      me.post(`/api/notifications/${foreign.id}/read`),
      me.delete(`/api/notifications/${foreign.id}`),
      me.post('/api/notifications/0123456789abcdefghjkmnpqrs/read'),
    ]) {
      const refused = await attempt;
      expect(refused.status).toBe(404);
      expect((refused.body as ErrorBody).error.code).toBe('notification_not_found');
    }
    expect((await me.post<Json>('/api/notifications/clear', { scope: 'all' })).body.changed).toBe(
      0,
    );
    expect((await stored(other)).notifications.map((item) => item.id)).toEqual([foreign.id]);
    expect((await stored(other)).unread).toBe(1);
    expect((await studio.client().get('/api/notifications')).status).toBe(401);
  });

  it('a notification about a project the person can no longer see loses its target — it does not lead anywhere and names nothing new', async () => {
    const me = await person();
    const side = await createProject(studio, owner, 'Short Lived');
    await shareProject(owner, side.id, me.userId!, 'write');
    const session = await createSession(me, side.id, 'claude-code', {
      title: 'Work in the side project',
    });
    await runToEnd(me, session.id, 'done');
    const before = await notificationOf(me, 'reply-finished', session.id);
    expect(before).toMatchObject({
      targetAvailable: true,
      link: `/projects/${side.id}/sessions/${session.id}`,
    });
    await owner.delete(`/api/projects/${side.id}/members/${me.userId}`);
    const after = (await stored(me)).notifications.find((item) => item.id === before.id)!;
    expect(after).toMatchObject({ targetAvailable: false, link: '/' });
  });

  describe('Web Push, at the API', () => {
    const keys = {
      p256dh:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
      auth: 'tBHItJI5svbpez7KI4CCXg',
    };

    it('NTF-04: every signed-in browser can fetch the server’s public push key; it is the same key each time and no private part is ever shown', async () => {
      const me = await person();
      const key = await me.get<{ publicKey: string }>('/api/notifications/push/key');
      expect(key.status).toBe(200);
      expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/); // an uncompressed P-256 point, base64url
      expect(Buffer.from(key.body.publicKey, 'base64url')[0]).toBe(4);
      expect(
        (await owner.get<{ publicKey: string }>('/api/notifications/push/key')).body.publicKey,
      ).toBe(key.body.publicKey);
      const settings = (await me.get<Json>('/api/notifications/settings')).body;
      expect(settings.push).toEqual({
        publicKey: key.body.publicKey,
        enabled: false,
        active: false,
        devices: [],
        maxDevices: 10,
      });
      expect(JSON.stringify(settings)).not.toMatch(/private|"d":/i);
      expect((await studio.client().get('/api/notifications/push/key')).status).toBe(401);
    });

    it('AT-NTF-016 (negative): a subscription is accepted only for a known browser push service over https with well-formed keys — anything else is refused and no device is stored', async () => {
      const me = await person();
      const unsupported = [
        'http://fcm.googleapis.com/fcm/send/abc', // not https
        'https://127.0.0.1:9/push/abc', // the server itself
        'https://169.254.169.254/latest/meta-data', // a metadata address
        'https://push.example.com/send/abc', // not a push service
        'https://fcm.googleapis.com.evil.example/fcm/send/abc', // a look-alike host
        'https://fcm.googleapis.com@evil.example/fcm/send/abc', // the real name as a user name
        'https://evil.example/?next=https://fcm.googleapis.com/fcm/send/abc',
      ];
      for (const endpoint of unsupported) {
        const refused = await me.post<ErrorBody>('/api/notifications/push/devices', {
          endpoint,
          keys,
        });
        expect(refused.status, endpoint).toBe(400);
        expect(refused.body.error.code, endpoint).toBe('unsupported_push_service');
      }
      const badKeys = await me.post<ErrorBody>('/api/notifications/push/devices', {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA', auth: 'AAAAAAAAAAAA' },
      });
      expect(badKeys.status).toBe(400);
      expect(badKeys.body.error.code).toBe('invalid_subscription');
      for (const malformed of [
        { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
        { keys },
        { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys, userId: owner.userId },
        {},
      ]) {
        expect((await me.post('/api/notifications/push/devices', malformed)).status).toBe(400);
      }
      const settings = (await me.get<Json>('/api/notifications/settings')).body;
      expect(settings.push.devices).toEqual([]);
      expect(settings.push.enabled).toBe(false);
      expect(settings.preferences.channels.webPush).toBe(false);
    });

    it('NTF-07: devices are registered from a browser, never with an API token; an unknown device id is "not found" and unsubscribing an endpoint one does not hold changes nothing', async () => {
      const me = await person();
      const token = await me.post<{ token: string }>('/api/auth/tokens', {
        name: 'push-probe',
        scopes: ['read', 'write'],
      });
      const robot = studio.client();
      robot.bearer = token.body.token;
      for (const attempt of [
        robot.post('/api/notifications/push/devices', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
          keys,
        }),
        robot.post('/api/notifications/push/unsubscribe', {
          endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        }),
      ]) {
        const refused = await attempt;
        expect(refused.status).toBe(403);
        expect((refused.body as ErrorBody).error.code).toBe('session_required');
      }
      const gone = await me.delete<ErrorBody>(
        '/api/notifications/push/devices/0123456789abcdefghjkmnpqrs',
      );
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe('device_not_found');
      const before = (await me.get<Json>('/api/notifications/settings')).body;
      const unsubscribed = await me.post<Json>('/api/notifications/push/unsubscribe', {
        endpoint: 'https://fcm.googleapis.com/fcm/send/somebody-elses-endpoint',
      });
      expect(unsubscribed.status).toBe(200);
      expect(unsubscribed.body).toEqual(before);
    });

    it('AT-AUT-012/035 (adapted): a test send with no device says so — nothing was sent, to nobody — rather than reporting success', async () => {
      const me = await person();
      for (const origin of ['settings', 'automations']) {
        const report = await me.post<Json>('/api/notifications/push/test', { origin });
        expect(report.status).toBe(200);
        expect(report.body).toEqual({
          ok: false,
          enabled: false,
          devices: [],
          sent: 0,
          removed: 0,
          failed: 0,
        });
      }
      expect((await me.post('/api/notifications/push/test', { origin: 'elsewhere' })).status).toBe(
        400,
      );
      expect((await me.post('/api/notifications/push/test', { device: 'not-a-hash' })).status).toBe(
        400,
      );
    });
  });
});
