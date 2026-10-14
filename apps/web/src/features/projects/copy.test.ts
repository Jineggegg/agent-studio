import { PROJECT_FEATURES, type ProjectLinkStatus, remoteFailureCodeSchema } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { failureKey } from '@/features/remotes/RemotesPage';
import { getTranslator } from '@/i18n';
import { en } from '@/i18n/en';
import { zhCN } from '@/i18n/zh-CN';
import { AUTO_MODE_COPY, FEATURE_COPY, FEATURE_ORDER, cloneAddressProblem, hostOf, linkProblem, linkStatusText, repositoryName } from './copy';

describe('the words on a project\'s switches', () => {
  it('cover every switch the protocol defines, in both languages', () => {
    expect([...FEATURE_ORDER].sort()).toEqual([...PROJECT_FEATURES].sort());
    for (const feature of PROJECT_FEATURES) {
      const copy = FEATURE_COPY[feature];
      expect(copy, feature).toBeDefined();
      for (const key of [copy.title, copy.consequence, ...(copy.risk ? [copy.risk.title, copy.risk.message, copy.risk.confirm] : [])]) {
        expect(en[key], `${feature}: ${key} (en)`).toBeTruthy();
        expect(zhCN[key], `${feature}: ${key} (zh-CN)`).toBeTruthy();
        expect(zhCN[key], `${key} is translated`).not.toBe(en[key]);
      }
    }
  });

  it('say what each one does while on and what stops while off', () => {
    for (const feature of PROJECT_FEATURES) {
      const text = en[FEATURE_COPY[feature].consequence];
      expect(text, feature).toMatch(/\bOn:/);
      expect(text, feature).toMatch(/\bOff:/);
    }
    expect(en[AUTO_MODE_COPY.consequence]).toMatch(/\bOn:.*\bOff:/s);
  });

  it('use the plain words for the ones that matter most', () => {
    expect(en[FEATURE_COPY.automation.consequence]).toContain('lets schedules start agent runs here while nobody is watching');
    expect(en[FEATURE_COPY.instructions.consequence]).toContain('load this project’s CLAUDE.md for Claude Code');
    expect(en[FEATURE_COPY.agentCredentials.consequence]).toContain('lets agents use this machine’s SSH keys and tokens — needed for an agent to push');
  });

  it('make the risk of handing over credentials plain, and ask before switching it on', () => {
    const risk = FEATURE_COPY.agentCredentials.risk;
    expect(risk).toBeDefined();
    expect(en[risk!.message]).toMatch(/read the SSH and GPG keys/);
    expect(en[risk!.message]).toMatch(/send them elsewhere/);
    expect(en[risk!.title]).toContain('{project}');
    expect(AUTO_MODE_COPY.risk).toBeDefined();
    // The switches that only narrow what happens need no question.
    expect(FEATURE_COPY.assistant.risk).toBeUndefined();
    expect(FEATURE_COPY.instructions.risk).toBeUndefined();
  });
});

describe('links', () => {
  const status = (overrides: Partial<ProjectLinkStatus>): ProjectLinkStatus => ({ linkId: 'l', state: 'ok', status: 200, latencyMs: 142, frameable: true, checkedAt: 1, ...overrides });
  const t = getTranslator('en');

  it('says what a probe found in a few words', () => {
    expect(linkStatusText(undefined, t)).toEqual({ text: 'Checking…', tone: 'neutral' });
    expect(linkStatusText(status({}), t)).toEqual({ text: '142 ms', tone: 'positive' });
    expect(linkStatusText(status({ state: 'http_error', status: 503 }), t)).toEqual({ text: 'HTTP 503', tone: 'warning' });
    expect(linkStatusText(status({ state: 'unreachable', status: null, latencyMs: null }), t)).toEqual({ text: 'No answer', tone: 'danger' });
    expect(linkStatusText(status({ state: 'blocked', status: null, latencyMs: null }), t)).toEqual({ text: 'Not checked: private address', tone: 'neutral' });
  });

  it('checks a link before it is sent', () => {
    expect(linkProblem('', 'https://example.com')).toBe('label');
    expect(linkProblem('Docs', '')).toBe('url');
    expect(linkProblem('Docs', 'example.com')).toBe('scheme');
    expect(linkProblem('Docs', 'javascript:alert(1)')).toBe('scheme');
    expect(linkProblem('Docs', 'ftp://example.com')).toBe('scheme');
    expect(linkProblem('Docs', 'https://user:pw@example.com')).toBe('credentials');
    expect(linkProblem('Docs', 'https://example.com/docs')).toBeNull();
    expect(linkProblem('Local', 'http://localhost:3000')).toBeNull();
  });

  it('shows a host, not a whole address', () => {
    expect(hostOf('https://docs.example.com/guide?x=1')).toBe('docs.example.com');
    expect(hostOf('http://localhost:5173/')).toBe('localhost:5173');
    expect(hostOf('nonsense')).toBe('nonsense');
  });
});

describe('a repository address', () => {
  it('accepts the three forms the server accepts', () => {
    for (const address of ['https://github.com/octo/demo.git', 'https://git.example.com:8443/team/repo', 'ssh://git@github.com/octo/demo.git', 'ssh://github.com:22/octo/demo', 'git@github.com:octo/demo.git']) {
      expect(cloneAddressProblem(address), address).toBeNull();
    }
  });

  it('says in advance why the others will be refused', () => {
    expect(cloneAddressProblem('  ')).toBe('empty');
    expect(cloneAddressProblem('https://github.com/a b')).toBe('spaces');
    expect(cloneAddressProblem('http://github.com/octo/demo')).toBe('scheme');
    expect(cloneAddressProblem('file:///etc')).toBe('scheme');
    expect(cloneAddressProblem('ext::sh -c x')).toBe('spaces');
    expect(cloneAddressProblem('ext::sh')).toBe('scheme');
    expect(cloneAddressProblem('--upload-pack=x')).toBe('scheme');
    expect(cloneAddressProblem('/srv/repos/demo')).toBe('scheme');
    expect(cloneAddressProblem('https://user:token@github.com/octo/demo')).toBe('credentials');
    expect(cloneAddressProblem('https://token@github.com/octo/demo')).toBe('credentials');
    expect(cloneAddressProblem('ssh://git:pw@github.com/octo/demo')).toBe('credentials');
  });

  it('suggests the folder name the server would choose', () => {
    expect(repositoryName('https://github.com/octo/demo.git')).toBe('demo');
    expect(repositoryName('git@github.com:octo/my-app.git')).toBe('my-app');
    expect(repositoryName('https://example.com/team/repo/')).toBe('repo');
    expect(repositoryName('')).toBe('');
  });
});

describe('remote machines', () => {
  it('have words for every reason a machine could not be checked, in both languages', () => {
    for (const code of remoteFailureCodeSchema.options) {
      expect(en[failureKey(code)], `${code} (en)`).toBeTruthy();
      expect(zhCN[failureKey(code)], `${code} (zh-CN)`).toBeTruthy();
    }
  });
});
