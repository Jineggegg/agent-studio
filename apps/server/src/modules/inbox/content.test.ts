import {
  NOTIFICATION_EVENT_OF_KIND,
  NOTIFICATION_LIMITS,
  type NotificationKind,
  notificationKindSchema,
  safeAppLink,
  stripControlCharacters,
  toOneLine,
} from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import {
  type NotificationContent,
  type SessionContext,
  buildPushPayload,
  customContent,
  dedupeKeys,
  deviceAddedContent,
  needsYouContent,
  pluginContent,
  pushDelivery,
  runFailedContent,
  runFinishedContent,
  runInterruptedContent,
  summaryLine,
  testContent,
} from './content.js';
import { languageFromHeader } from './texts.js';

const SESSION = 's'.repeat(26);
const PROJECT = 'p'.repeat(26);
const RUN = 'r'.repeat(26);

const MESSAGE =
  'rotate the deploy key ghp_abcdefghijklmnopqrstuvwxyz0123 and push it to production';
const COMMAND =
  'curl -H "Authorization: Bearer abcdef0123456789" https://internal.example/deploy --data @secrets.json';
const ERROR =
  'connection to db.internal.example:5432 refused for user billing_admin (password=hunter2hunter2)';

/** A session the user named themselves. */
const named: SessionContext = {
  language: 'en',
  sessionId: SESSION,
  projectId: PROJECT,
  projectName: 'Billing',
  sessionTitle: 'Release prep',
  titleIsName: true,
  agentName: 'Claude Code',
};
/** A session whose title is the start of its first message. */
const unnamed: SessionContext = {
  ...named,
  sessionTitle: MESSAGE.slice(0, 60),
  titleIsName: false,
};

const everyKind = (context: SessionContext): NotificationContent[] => [
  needsYouContent(context, {
    runId: RUN,
    kind: 'tool',
    toolName: 'Bash',
    onBehalfOf: null,
    detail: COMMAND,
  }),
  needsYouContent(context, {
    runId: RUN,
    kind: 'tool',
    toolName: null,
    onBehalfOf: null,
    detail: COMMAND,
  }),
  needsYouContent(context, {
    runId: RUN,
    kind: 'tool',
    toolName: 'Bash',
    onBehalfOf: 'Sam',
    detail: COMMAND,
  }),
  needsYouContent(context, {
    runId: RUN,
    kind: 'question',
    toolName: null,
    onBehalfOf: null,
    detail: 'Should I drop the table billing_admin?',
  }),
  needsYouContent(context, {
    runId: RUN,
    kind: 'plan',
    toolName: 'ExitPlanMode',
    onBehalfOf: null,
    detail: null,
  }),
  runFinishedContent(context, { runId: RUN, unattended: false, detail: MESSAGE }),
  runFinishedContent(context, { runId: RUN, unattended: true, detail: MESSAGE }),
  runFailedContent(context, { runId: RUN, detail: ERROR }),
  runInterruptedContent(context, { runId: RUN }),
];

describe('what a push carries by default', () => {
  it('names the session, the assistant and what happened', () => {
    const payloads = everyKind(named).map((content) =>
      buildPushPayload(content, { showDetails: false }),
    );
    expect(payloads.map((payload) => payload.body)).toEqual([
      'Claude Code needs your approval to use Bash',
      'Claude Code needs your approval for a tool action',
      "Claude Code needs an owner's approval to use Bash (run by Sam)",
      'Claude Code has a question for you',
      'Claude Code has a plan waiting for you to confirm',
      'Claude Code finished its reply',
      'Claude Code finished its background work',
      "Claude Code's run failed",
      "Claude Code's run was cut short by a restart. Open the session to continue.",
    ]);
    for (const payload of payloads) {
      expect(payload.title).toBe('Release prep');
      expect(payload.url).toBe(`/projects/${PROJECT}/sessions/${SESSION}`);
      expect(Object.keys(payload).sort()).toEqual(['body', 'tag', 'title', 'url']);
    }
  });

  it('never carries message text, command text or error text — whatever the session is called', () => {
    for (const context of [named, unnamed, { ...unnamed, projectId: null, projectName: null }]) {
      const everything = JSON.stringify(
        everyKind(context).map((content) => buildPushPayload(content, { showDetails: false })),
      );
      for (const forbidden of [
        'rotate',
        'deploy key',
        'ghp_',
        'production',
        'curl',
        'Authorization',
        'Bearer',
        'internal.example',
        'secrets.json',
        'db.internal',
        'billing_admin',
        'hunter2',
        'refused',
        'drop the table',
      ]) {
        expect(everything, `${forbidden} in ${context.sessionTitle}`).not.toContain(forbidden);
      }
    }
  });

  it('calls a session that was never named by its project — its automatic title is the start of a message', () => {
    expect(
      new Set(
        everyKind(unnamed).map(
          (content) => buildPushPayload(content, { showDetails: false }).title,
        ),
      ),
    ).toEqual(new Set(['Billing']));
    // Outside any project there is only the product's name left.
    const nowhere = { ...unnamed, projectId: null, projectName: null };
    expect(
      new Set(
        everyKind(nowhere).map(
          (content) => buildPushPayload(content, { showDetails: false }).title,
        ),
      ),
    ).toEqual(new Set(['Cloud Harness']));
    expect(
      buildPushPayload(
        runFinishedContent(nowhere, { runId: RUN, unattended: false, detail: null }),
        { showDetails: false },
      ).url,
    ).toBe(`/sessions/${SESSION}`);
    // The app's own list shows the title either way.
    expect(runFinishedContent(unnamed, { runId: RUN, unattended: false, detail: null }).title).toBe(
      MESSAGE.slice(0, 60),
    );
  });

  it("writes in the account's language", () => {
    const chinese = { ...named, language: 'zh-CN' as const };
    expect(
      buildPushPayload(
        needsYouContent(chinese, {
          runId: RUN,
          kind: 'tool',
          toolName: 'Bash',
          onBehalfOf: null,
          detail: null,
        }),
        { showDetails: false },
      ).body,
    ).toBe('Claude Code 需要你批准使用 Bash');
    expect(
      buildPushPayload(
        runFinishedContent(chinese, { runId: RUN, unattended: false, detail: null }),
        { showDetails: false },
      ).body,
    ).toBe('Claude Code 已完成回复');
    expect(languageFromHeader('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
    expect(languageFromHeader('fr-FR,fr;q=0.9,en;q=0.5,zh;q=0.4')).toBe('en');
    expect(languageFromHeader('en;q=0.1, zh-TW;q=0.9')).toBe('zh-CN');
    expect(languageFromHeader('de-DE,de;q=0.9')).toBeNull();
    expect(languageFromHeader(undefined)).toBeNull();
    expect(languageFromHeader('en;q=0')).toBeNull();
  });
});

describe('what a push carries when the user asked for details', () => {
  it('adds one line of substance, with credentials removed, within the bounds', () => {
    const payloads = everyKind(unnamed).map((content) =>
      buildPushPayload(content, { showDetails: true }),
    );
    // (The redactor takes out the token and, as the value of an "Authorization:" field, the scheme word before it.)
    expect(payloads[0]!.body).toBe(
      'Claude Code needs your approval to use Bash — curl -H "Authorization: [redacted] [redacted]" https://internal.example/deploy --data @secrets.json',
    );
    expect(payloads[3]!.body).toBe(
      'Claude Code has a question for you — Should I drop the table billing_admin?',
    );
    // A plan's text stays in the session even then.
    expect(payloads[4]!.body).toBe('Claude Code has a plan waiting for you to confirm');
    expect(payloads[5]!.body).toBe(
      'Claude Code finished its reply — rotate the deploy key [redacted] and push it to production',
    );
    expect(payloads[7]!.body).toBe(
      "Claude Code's run failed — connection to db.internal.example:5432 refused for user billing_admin (password=[redacted]",
    );
    expect(payloads[8]!.body).toBe(
      "Claude Code's run was cut short by a restart. Open the session to continue.",
    );
    // The title is the session's own, cleaned the same way.
    expect(payloads[0]!.title).toBe('rotate the deploy key [redacted] and');

    const everything = JSON.stringify(payloads);
    for (const secret of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'abcdef0123456789',
      'hunter2hunter2',
    ])
      expect(everything).not.toContain(secret);
    for (const payload of payloads) {
      expect(Array.from(payload.title).length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.titleChars);
      expect(Array.from(payload.body).length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.bodyChars);
    }
  });

  it('keeps a long or multi-line detail to one bounded line', () => {
    const long = runFailedContent(named, {
      runId: RUN,
      detail: `first line\nsecond line\t${'x'.repeat(1000)}`,
    });
    expect(long.detail).toMatch(/^first line second line x+$/);
    expect(Array.from(long.detail!).length).toBe(NOTIFICATION_LIMITS.detailChars);
    const payload = buildPushPayload(long, { showDetails: true });
    expect(payload.body).not.toContain('\n');
    expect(Array.from(payload.body).length).toBeLessThanOrEqual(NOTIFICATION_LIMITS.bodyChars);
    expect(summaryLine('   ')).toBeNull();
    expect(summaryLine(null)).toBeNull();
    expect(summaryLine('token: abcdefghij1234567890')).toBe('token: [redacted]');
  });
});

describe('notifications that are not about a session', () => {
  it('a new device and a test say only that', () => {
    expect(
      buildPushPayload(deviceAddedContent('en', 'Chrome on Android'), { showDetails: false }),
    ).toEqual({
      title: 'Notifications are on',
      body: 'Chrome on Android will now receive notifications.',
      tag: 'system:device-added',
      url: '/settings/notifications',
    });
    expect(deviceAddedContent('zh-CN', 'iPhone 上的 Safari').body).toBe(
      'iPhone 上的 Safari 现在会收到通知。',
    );
    expect(buildPushPayload(testContent('en', 'settings'), { showDetails: true }).url).toBe(
      '/settings/notifications',
    );
    expect(buildPushPayload(testContent('en', 'automations'), { showDetails: true })).toEqual({
      title: 'Test notification',
      body: 'Notifications from Cloud Harness reach this device.',
      tag: 'system:test',
      url: '/',
    });
  });

  it("a plugin's words are content: the app shows them, a lock screen only says which plugin has news", () => {
    const content = pluginContent('en', {
      pluginId: 'deploy-watch',
      pluginName: 'Deploy Watch',
      title: 'Deploy of api-7f3c failed',
      body: 'Exit code 1: token=abcdef0123456789 rejected',
      projectId: PROJECT,
      projectName: 'Billing',
    });
    expect(content).toMatchObject({
      kind: 'plugin',
      title: 'Deploy of api-7f3c failed',
      body: 'Exit code 1: token=[redacted] rejected',
      link: `/projects/${PROJECT}`,
      tag: `plugin:deploy-watch:${PROJECT}`,
    });
    expect(buildPushPayload(content, { showDetails: false })).toEqual({
      title: 'Billing',
      body: 'Deploy Watch sent a notification',
      tag: `plugin:deploy-watch:${PROJECT}`,
      url: `/projects/${PROJECT}`,
    });
    expect(buildPushPayload(content, { showDetails: true })).toMatchObject({
      title: 'Deploy of api-7f3c failed',
      body: 'Exit code 1: token=[redacted] rejected',
    });
    // Without a project it opens the home screen under the product's name.
    const global = pluginContent('en', {
      pluginId: 'p',
      pluginName: '',
      title: '',
      body: '',
      projectId: null,
      projectName: null,
    });
    expect(global).toMatchObject({
      title: 'p',
      body: 'p sent a notification',
      link: '/',
      tag: 'plugin:p:none',
    });
    expect(buildPushPayload(global, { showDetails: false }).title).toBe('Cloud Harness');
  });

  it('what another module hands in is bounded, cleaned and reduced to a link into the app', () => {
    const content = customContent({
      kind: 'automation',
      title: `Billing\n${'t'.repeat(200)}`,
      body: 'b'.repeat(500),
      detail: 'because password=hunter2hunter2',
      discreet: { body: 'Reminder from “Stand-up”' },
      link: 'https://evil.example/phish',
      tag: 'automation:abc',
      projectId: PROJECT,
    });
    expect(Array.from(content.title).length).toBe(NOTIFICATION_LIMITS.titleChars);
    expect(content.title.startsWith('Billing t')).toBe(true);
    expect(Array.from(content.body).length).toBe(NOTIFICATION_LIMITS.bodyChars);
    expect(content.detail).toBe('because password=[redacted]');
    expect(content.link).toBe('/');
    expect(content).toMatchObject({
      sessionId: null,
      runId: null,
      projectId: PROJECT,
      tag: 'automation:abc',
    });
    // The discreet strength is what was handed in for it; a part left out falls back to the full one.
    expect(content.discreet).toEqual({ title: content.title, body: 'Reminder from “Stand-up”' });
    expect(buildPushPayload(content, { showDetails: false }).body).toBe('Reminder from “Stand-up”');
    expect(buildPushPayload(content, { showDetails: true }).body.startsWith('bbbb')).toBe(true);
    expect(
      customContent({ kind: 'automation', title: ' ', body: 'x', link: '/inbox', tag: '' }),
    ).toMatchObject({ title: 'Cloud Harness', link: '/inbox', tag: 'automation:untagged' });
  });
});

describe('replacement tags and duplicate suppression', () => {
  it('a tag is the same for the same session and event, and different otherwise', () => {
    const other: SessionContext = { ...named, sessionId: 't'.repeat(26) };
    const tag = (content: NotificationContent) => content.tag;
    expect(tag(runFinishedContent(named, { runId: RUN, unattended: false, detail: null }))).toBe(
      `reply-finished:${SESSION}`,
    );
    // Another run in the same session: the same slot — the newer notification replaces the older.
    expect(
      tag(runFinishedContent(named, { runId: 'q'.repeat(26), unattended: false, detail: 'other' })),
    ).toBe(`reply-finished:${SESSION}`);
    expect(tag(runFinishedContent(other, { runId: RUN, unattended: false, detail: null }))).toBe(
      `reply-finished:${other.sessionId}`,
    );
    // Different events about one session each have their own slot.
    const tags = everyKind(named).map(tag);
    expect(new Set(tags)).toEqual(
      new Set([
        `needs-you:${SESSION}`,
        `reply-finished:${SESSION}`,
        `background-finished:${SESSION}`,
        `run-failed:${SESSION}`,
        `run-interrupted:${SESSION}`,
      ]),
    );
    // The tag never depends on the language or on what the notification says.
    expect(
      tag(runFailedContent({ ...named, language: 'zh-CN' }, { runId: RUN, detail: 'x' })),
    ).toBe(tag(runFailedContent(named, { runId: RUN, detail: 'y' })));
    for (const value of tags) expect(value.length).toBeLessThanOrEqual(120);
  });

  it('the identity of an event tells the same request from a different one', () => {
    const user = 'u'.repeat(26);
    // The same tool asking again in the same session is the same event …
    expect(dedupeKeys.needsYou(user, SESSION, 'tool', 'Bash')).toBe(
      dedupeKeys.needsYou(user, SESSION, 'tool', 'Bash'),
    );
    // … another tool, another kind of request, another session or another recipient is not.
    const distinct = new Set([
      dedupeKeys.needsYou(user, SESSION, 'tool', 'Bash'),
      dedupeKeys.needsYou(user, SESSION, 'tool', 'Edit'),
      dedupeKeys.needsYou(user, SESSION, 'tool', null),
      dedupeKeys.needsYou(user, SESSION, 'question', null),
      dedupeKeys.needsYou(user, 't'.repeat(26), 'tool', 'Bash'),
      dedupeKeys.needsYou('v'.repeat(26), SESSION, 'tool', 'Bash'),
      dedupeKeys.runFailed(user, SESSION, 'rate_limited'),
      dedupeKeys.runFailed(user, SESSION, 'agent_error'),
      dedupeKeys.runFailed(user, SESSION, null),
      dedupeKeys.runFinished(user, SESSION, RUN),
      dedupeKeys.runFinished(user, SESSION, 'q'.repeat(26)),
    ]);
    expect(distinct.size).toBe(11);
  });
});

describe('how urgently a push is delivered', () => {
  it('a waiting request wakes the device, but not after it has expired', () => {
    expect(pushDelivery('needs-you', { expiresInMs: 30 * 60_000 })).toEqual({
      ttlSeconds: 1800,
      urgency: 'high',
    });
    expect(pushDelivery('needs-you', { expiresInMs: 90_500 })).toEqual({
      ttlSeconds: 91,
      urgency: 'high',
    });
    expect(pushDelivery('needs-you', { expiresInMs: 5_000 }).ttlSeconds).toBe(60);
    expect(pushDelivery('needs-you', { expiresInMs: -1 }).ttlSeconds).toBe(60);
    expect(pushDelivery('needs-you', { expiresInMs: 7 * 24 * 3_600_000 }).ttlSeconds).toBe(86_400);
    expect(pushDelivery('needs-you', { expiresInMs: null })).toEqual({
      ttlSeconds: 1800,
      urgency: 'high',
    });
    expect(pushDelivery('needs-you')).toEqual({ ttlSeconds: 1800, urgency: 'high' });
  });

  it('every kind has a bounded time to live, and background work is the least urgent', () => {
    const kinds = notificationKindSchema.options as NotificationKind[];
    for (const kind of kinds) {
      const delivery = pushDelivery(kind);
      expect(delivery.ttlSeconds).toBeGreaterThanOrEqual(60);
      expect(delivery.ttlSeconds).toBeLessThanOrEqual(86_400);
    }
    expect(Object.fromEntries(kinds.map((kind) => [kind, pushDelivery(kind).urgency]))).toEqual({
      'needs-you': 'high',
      'reply-finished': 'normal',
      'background-finished': 'low',
      'run-failed': 'normal',
      'run-interrupted': 'normal',
      automation: 'normal',
      plugin: 'low',
      system: 'normal',
    });
    expect(pushDelivery('system', { test: true })).toEqual({ ttlSeconds: 600, urgency: 'high' });
    // Every kind but `system` is governed by a switch.
    expect(kinds.filter((kind) => NOTIFICATION_EVENT_OF_KIND[kind] === null)).toEqual(['system']);
  });
});

describe('links', () => {
  it('accepts paths inside the app', () => {
    for (const link of [
      '/',
      '/inbox',
      `/projects/${PROJECT}`,
      `/projects/${PROJECT}/sessions/${SESSION}`,
      '/settings/notifications',
      '/a/b/',
      '/search?q=a%20b&next=//x#frag',
      '/.well-known/x',
      '/项目/一',
      '/a%2Fb',
    ]) {
      expect(safeAppLink(link), link).toBe(link);
    }
  });

  it('turns everything else into the home screen', () => {
    const hostile: unknown[] = [
      'https://evil.example/x',
      'http://localhost:7420/inbox',
      '//evil.example/x',
      '///evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/a\\b',
      'javascript:alert(1)',
      'data:text/html,x',
      'inbox',
      './inbox',
      '../inbox',
      '',
      ' /inbox',
      '/in box',
      '/inbox\n',
      '/a\u0000b',
      '/a\tb',
      // Dot segments, plain and percent-encoded: after normalisation they could point anywhere.
      '/a/../../etc',
      '/..',
      '/.',
      '/a/./b',
      '/a/%2e%2e/b',
      '/a/%2E%2e//evil.example',
      '/a/.%2e/b',
      '/a//b',
      '/..//evil.example',
      `/${'a'.repeat(NOTIFICATION_LIMITS.linkChars)}`,
      null,
      undefined,
      42,
      {},
      ['/inbox'],
    ];
    for (const link of hostile) expect(safeAppLink(link), JSON.stringify(link)).toBe('/');
    // Characters that hide in a string: a line separator, a no-break space, a control from the C1 block.
    for (const code of [0x2028, 0x2029, 0xa0, 0x85, 0x7f])
      expect(safeAppLink(`/a${String.fromCodePoint(code)}b`), code.toString(16)).toBe('/');
    expect(safeAppLink(`/${'a'.repeat(NOTIFICATION_LIMITS.linkChars - 1)}`)).toHaveLength(
      NOTIFICATION_LIMITS.linkChars,
    );
  });
});

describe('text people typed', () => {
  it('becomes one clean, bounded line', () => {
    const override = String.fromCodePoint(0x202e);
    const isolate = String.fromCodePoint(0x2066);
    expect(toOneLine(`  Deploy\r\n\treminder\u0007  ${override}exe.txt${isolate} `, 80)).toBe(
      'Deploy reminder exe.txt',
    );
    expect(toOneLine(`a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x85)}c`, 80)).toBe(
      'a b c',
    );
    expect(toOneLine('x'.repeat(50), 40)).toHaveLength(40);
    // Cut by code point, not in the middle of a character.
    expect(toOneLine('😀'.repeat(10), 4)).toBe('😀😀😀😀');
    expect(toOneLine('提醒我提交周报', 4)).toBe('提醒我提');
    expect(toOneLine('ab   ', 3)).toBe('ab');
    expect(toOneLine(' \n\t ', 10)).toBe('');
  });

  it('a prompt keeps its line breaks and loses only what is invisible', () => {
    const override = String.fromCodePoint(0x202e);
    expect(
      stripControlCharacters(`line one\r\nline two\n\tindented\u0000\u001b[31m${override}`),
    ).toBe('line one\nline two\n\tindented[31m');
  });
});
