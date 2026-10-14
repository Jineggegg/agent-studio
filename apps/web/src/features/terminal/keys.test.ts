import { describe, expect, it } from 'vitest';
import { FONT_SIZE, KEYS, applyModifiers, arrowSequence, clampFontSize, controlCharacter, distinctUrls, isLoopbackHost, openableUrl, readFontSize, saveFontSize, wordAt } from './keys';
import { launcherTitleKey, signInLaunchers } from './launchers';

describe('sticky modifiers', () => {
  it('turns the next key into its control character', () => {
    expect(applyModifiers('c', { ctrl: true, alt: false })).toBe('\u0003');
    expect(applyModifiers('C', { ctrl: true, alt: false })).toBe('\u0003');
    expect(applyModifiers('a', { ctrl: true, alt: false })).toBe('\u0001');
    expect(applyModifiers('z', { ctrl: true, alt: false })).toBe('\u001a');
    expect(applyModifiers('[', { ctrl: true, alt: false })).toBe('\u001b');
    expect(applyModifiers(' ', { ctrl: true, alt: false })).toBe('\u0000');
    expect(controlCharacter('?')).toBe('\u007f');
  });

  it('leaves a key Ctrl cannot change as it is', () => {
    expect(applyModifiers('1', { ctrl: true, alt: false })).toBe('1');
    expect(applyModifiers('é', { ctrl: true, alt: false })).toBe('é');
  });

  it('makes Alt "Escape, then the key", and combines with Ctrl', () => {
    expect(applyModifiers('b', { ctrl: false, alt: true })).toBe('\u001bb');
    expect(applyModifiers('c', { ctrl: true, alt: true })).toBe('\u001b\u0003');
  });

  it('never touches pasted text or a word committed by an input method', () => {
    expect(applyModifiers('ls -la', { ctrl: true, alt: true })).toBe('ls -la');
    expect(applyModifiers('你好', { ctrl: true, alt: false })).toBe('你好');
    expect(applyModifiers('c', { ctrl: false, alt: false })).toBe('c');
  });
});

describe('arrow keys', () => {
  it('uses the normal or the application form as the program asked', () => {
    expect(arrowSequence('up', { ctrl: false, alt: false }, false)).toBe('\u001b[A');
    expect(arrowSequence('left', { ctrl: false, alt: false }, false)).toBe('\u001b[D');
    expect(arrowSequence('down', { ctrl: false, alt: false }, true)).toBe('\u001bOB');
  });

  it('carries modifiers the way xterm does', () => {
    expect(arrowSequence('right', { ctrl: true, alt: false }, false)).toBe('\u001b[1;5C');
    expect(arrowSequence('left', { ctrl: false, alt: true }, true)).toBe('\u001b[1;3D');
    expect(arrowSequence('up', { ctrl: true, alt: true }, false)).toBe('\u001b[1;7A');
  });

  it('knows the fixed keys', () => {
    expect(KEYS.interrupt).toBe('\u0003');
    expect(KEYS.escape).toBe('\u001b');
    expect(KEYS.shiftTab).toBe('\u001b[Z');
  });
});

describe('addresses a program printed', () => {
  const vite = { url: 'http://localhost:5173/', scheme: 'http' as const, host: 'localhost', port: 5173 };

  it('opens them as printed on the Studio\'s own machine', () => {
    expect(openableUrl(vite, 'localhost')).toEqual({ href: 'http://localhost:5173/', label: 'localhost:5173', substituted: false });
    expect(openableUrl(vite, '127.0.0.1').substituted).toBe(false);
  });

  it('puts the Studio\'s host in place of "localhost" from another device, and says so', () => {
    expect(openableUrl(vite, 'studio.lan')).toEqual({ href: 'http://studio.lan:5173/', label: 'studio.lan:5173', substituted: true });
    expect(openableUrl({ url: 'http://127.0.0.1:8000/docs?x=1', scheme: 'http', host: '127.0.0.1', port: 8000 }, '192.168.1.20')).toEqual({
      href: 'http://192.168.1.20:8000/docs?x=1',
      label: '192.168.1.20:8000/docs?x=1',
      substituted: true,
    });
  });

  it('never offers 0.0.0.0, which is no address to visit', () => {
    expect(openableUrl({ url: 'http://0.0.0.0:3000', scheme: 'http', host: '0.0.0.0', port: 3000 }, 'localhost').href).toBe('http://localhost:3000/');
    expect(openableUrl({ url: 'http://0.0.0.0:3000', scheme: 'http', host: '0.0.0.0', port: 3000 }, 'studio.lan').href).toBe('http://studio.lan:3000/');
  });

  it('shows one chip per address, however it was printed, and only the latest few', () => {
    const printed = [
      { url: 'http://localhost:5173', scheme: 'http' as const, host: 'localhost', port: 5173 },
      vite,
      { url: 'http://0.0.0.0:5173/', scheme: 'http' as const, host: '0.0.0.0', port: 5173 },
      { url: 'http://localhost:5173/admin', scheme: 'http' as const, host: 'localhost', port: 5173 },
    ];
    expect(distinctUrls(printed, 'localhost').map((entry) => entry.href)).toEqual(['http://localhost:5173/', 'http://localhost:5173/admin']);
    expect(distinctUrls(printed, 'localhost')[0]!.url).toBe(printed[0]);
    const many = Array.from({ length: 9 }, (_, index) => ({ url: `http://localhost:${3000 + index}/`, scheme: 'http' as const, host: 'localhost', port: 3000 + index }));
    expect(distinctUrls(many, 'localhost').map((entry) => entry.url.port)).toEqual([3003, 3004, 3005, 3006, 3007, 3008]);
  });

  it('recognises loopback names', () => {
    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0', '[::1]', '[::]']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['example.com', '192.168.1.5', 'localhost.evil.example']) expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe('selecting a word under a finger', () => {
  it('takes the run of characters around the column', () => {
    expect(wordAt('git commit -m "msg"', 5)).toEqual({ start: 4, length: 6 });
    expect(wordAt('see src/app.ts:12 here', 8)).toEqual({ start: 4, length: 13 });
    expect(wordAt('https://example.com/a?b=1 ', 3)).toEqual({ start: 0, length: 25 });
  });

  it('selects nothing on blank space or outside the line', () => {
    expect(wordAt('a  b', 1)).toBeNull();
    expect(wordAt('abc', 9)).toBeNull();
    expect(wordAt('', 0)).toBeNull();
  });
});

describe('font size, remembered on the device', () => {
  it('keeps to a readable range', () => {
    expect(clampFontSize(2)).toBe(FONT_SIZE.min);
    expect(clampFontSize(99)).toBe(FONT_SIZE.max);
    expect(clampFontSize(14.6)).toBe(15);
  });

  it('reads back what was saved, and falls back to the default for the screen', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readFontSize(false, storage)).toBe(FONT_SIZE.default);
    expect(readFontSize(true, storage)).toBe(FONT_SIZE.defaultPhone);
    saveFontSize(18, storage);
    expect(readFontSize(true, storage)).toBe(18);
    store.set('studio.terminal.fontSize', 'huge');
    expect(readFontSize(false, storage)).toBe(FONT_SIZE.default);
  });
});

describe('an agent\'s sign-in launchers', () => {
  const launchers = [
    { key: 'claude-login', title: 'Claude sign-in', kind: 'agent-sign-in' as const, requiresProject: false, requiresRemote: false, available: true, unavailableReason: null },
    { key: 'codex-login', title: 'Codex sign-in', kind: 'agent-sign-in' as const, requiresProject: false, requiresRemote: false, available: true, unavailableReason: null },
    { key: 'codex-login-device', title: 'Codex device sign-in', kind: 'agent-sign-in' as const, requiresProject: false, requiresRemote: false, available: false, unavailableReason: 'codex is not installed' },
    { key: 'remote-shell', title: 'Remote shell', kind: 'remote' as const, requiresProject: false, requiresRemote: true, available: true, unavailableReason: null },
    { key: 'codex-tui', title: 'Codex', kind: 'other' as const, requiresProject: true, requiresRemote: false, available: true, unavailableReason: null },
  ];

  it('are chosen by key from the server\'s list, per agent', () => {
    expect(signInLaunchers('claude-code', launchers).map((launcher) => launcher.key)).toEqual(['claude-login']);
    expect(signInLaunchers('codex', launchers).map((launcher) => launcher.key)).toEqual(['codex-login', 'codex-login-device']);
    expect(signInLaunchers('demo', launchers)).toEqual([]);
  });

  it('have a translated name where this client knows them', () => {
    expect(launcherTitleKey('claude-login')).toBe('accounts.launcher.claudeLogin');
    expect(launcherTitleKey('codex-login-device')).toBe('accounts.launcher.codexLoginDevice');
    expect(launcherTitleKey('something-new')).toBeNull();
  });
});
