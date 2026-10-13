import { describe, expect, it } from 'vitest';
import { cleanToolText } from './gh.runner.js';
import { blockersOf, checkRuns, httpsOnly, optionalChecksFailing, shortenBody, summariseChecks, toPullSummary, verdictOf, type MergeFacts, type RawContext } from './github.model.js';

const run = (name: string, conclusion: string | null, required: boolean, status = 'COMPLETED'): RawContext => ({ __typename: 'CheckRun', name, status, conclusion, isRequired: required, detailsUrl: `https://ci.example/${name}` });
const facts = (overrides: Partial<MergeFacts> = {}): MergeFacts => ({
  incomplete: false,
  state: 'open',
  draft: false,
  canMerge: true,
  mergeable: 'mergeable',
  mergeState: 'clean',
  checkRuns: [],
  mergeQueue: false,
  mergeMethods: ['squash'],
  ...overrides,
});
const codes = (overrides: Partial<MergeFacts>) => blockersOf(facts(overrides)).map((blocker) => blocker.code);

describe('may a pull request be merged?', () => {
  it('lets a clean, open, permitted pull request through and nothing else', () => {
    expect(codes({})).toEqual([]);
    expect(codes({ mergeState: 'has_hooks' })).toEqual([]);
    expect(codes({ mergeState: 'unstable' })).toEqual([]);
  });

  it.each<[Partial<MergeFacts>, string[]]>([
    [{ incomplete: true }, ['incomplete']],
    [{ state: 'closed' }, ['not_open']],
    [{ state: 'merged' }, ['not_open']],
    [{ draft: true }, ['draft']],
    [{ mergeState: 'draft' }, ['draft']],
    [{ canMerge: false }, ['no_permission']],
    [{ mergeable: 'conflicting' }, ['conflicts']],
    [{ mergeState: 'dirty' }, ['conflicts']],
    [{ mergeable: 'unknown' }, ['checking']],
    [{ mergeState: 'unknown' }, ['checking']],
    [{ mergeState: 'behind' }, ['behind']],
    [{ mergeState: 'blocked' }, ['blocked']],
    [{ mergeMethods: [] }, ['no_merge_method']],
    [{ draft: true, canMerge: false, mergeState: 'behind' }, ['draft', 'no_permission', 'behind']],
    [{ incomplete: true, state: 'closed', draft: true }, ['incomplete', 'not_open']],
  ])('%j → %j', (overrides, expected) => {
    expect(codes(overrides)).toEqual(expected);
  });

  it('judges required checks, and names them rather than a vague "blocked"', () => {
    const required = (state: 'failing' | 'pending' | 'passing') => ({ name: 'build', workflow: null, state, required: true, url: null });
    const optional = { name: 'lint', workflow: null, state: 'failing' as const, required: false, url: null };
    expect(codes({ mergeState: 'blocked', checkRuns: [required('failing')] })).toEqual(['required_checks_failed']);
    expect(codes({ mergeState: 'blocked', checkRuns: [required('pending')] })).toEqual(['required_checks_pending']);
    expect(codes({ mergeState: 'blocked', checkRuns: [required('passing')] })).toEqual(['blocked']);
    // A failing check that is not required does not block; it must be acknowledged instead.
    expect(codes({ mergeState: 'unstable', checkRuns: [optional, required('passing')] })).toEqual([]);
    expect(optionalChecksFailing([optional, required('passing')])).toBe(true);
    expect(optionalChecksFailing([required('failing')])).toBe(false);
  });

  it('leaves "behind" and "blocked" to a merge queue, and nothing else', () => {
    expect(codes({ mergeQueue: true, mergeState: 'behind' })).toEqual([]);
    expect(codes({ mergeQueue: true, mergeState: 'blocked' })).toEqual([]);
    expect(codes({ mergeQueue: true, mergeMethods: [] })).toEqual([]);
    expect(codes({ mergeQueue: true, draft: true })).toEqual(['draft']);
    expect(codes({ mergeQueue: true, mergeable: 'conflicting' })).toEqual(['conflicts']);
    expect(codes({ mergeQueue: true, canMerge: false })).toEqual(['no_permission']);
  });
});

describe('reading GitHub’s answer', () => {
  it('orders checks worst first and counts them', () => {
    const rollup = {
      state: 'FAILURE',
      contexts: {
        nodes: [
          run('passing', 'SUCCESS', false),
          run('neutral', 'NEUTRAL', false),
          run('cancelled', 'CANCELLED', false),
          run('queued', null, true, 'QUEUED'),
          run('required-failing', 'FAILURE', true),
          { __typename: 'StatusContext', context: 'status/error', state: 'ERROR', targetUrl: 'javascript:alert(1)', isRequired: false },
          { __typename: 'StatusContext', context: 'status/expected', state: 'EXPECTED', isRequired: true },
          null,
        ],
      },
    };
    expect(checkRuns(rollup).runs.map((entry) => [entry.name, entry.state])).toEqual([
      ['required-failing', 'failing'],
      ['cancelled', 'failing'],
      ['status/error', 'failing'],
      ['queued', 'pending'],
      ['status/expected', 'pending'],
      ['passing', 'passing'],
      ['neutral', 'skipped'],
    ]);
    expect(checkRuns(rollup).runs.find((entry) => entry.name === 'status/error')!.url).toBeNull();
    expect(summariseChecks(rollup)).toEqual({ state: 'failing', total: 7, passing: 1, failing: 3, pending: 2, skipped: 1 });
    expect(summariseChecks(null)).toEqual({ state: 'none', total: 0, passing: 0, failing: 0, pending: 0, skipped: 0 });
    // With no individual checks read, GitHub's own roll-up decides.
    expect(summariseChecks({ state: 'PENDING' }).state).toBe('pending');
    expect(summariseChecks({ state: 'SUCCESS' }).state).toBe('passing');
  });

  it('drops a pull request it cannot identify, and passes on only https links', () => {
    expect(toPullSummary({})).toBeNull();
    expect(toPullSummary({ number: 1, headRefOid: 'a'.repeat(40), repository: { name: 'r' } })).toBeNull();
    const pull = toPullSummary({ number: 1, headRefOid: 'a'.repeat(40), title: 'x'.repeat(400), url: 'http://github.com/o/r/pull/1', repository: { name: 'r', owner: { login: 'o' } } })!;
    expect(pull.url).toBe('https://github.com/o/r/pull/1');
    expect(pull.title).toHaveLength(300);
    expect(pull).toMatchObject({ mergeable: 'unknown', mergeState: 'unknown', reviewDecision: null, author: null, draft: false });
    expect(httpsOnly('https://ok.example/x')).toBe('https://ok.example/x');
    for (const bad of ['http://x.example', 'javascript:alert(1)', 'https://x.example/a b', '', null, undefined]) expect(httpsOnly(bad)).toBeNull();
  });

  it('sums a pull request up in one word, worst news first', () => {
    const base = toPullSummary({ number: 1, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', repository: { name: 'r', owner: { login: 'o' } } })!;
    expect(verdictOf(base)).toBe('mergeable');
    expect(verdictOf(base, 2)).toBe('awaiting_approval');
    expect(verdictOf({ ...base, mergeState: 'behind' }, 2)).toBe('behind');
    expect(verdictOf({ ...base, draft: true, mergeable: 'conflicting' })).toBe('draft');
    expect(verdictOf({ ...base, mergeable: 'conflicting', mergeState: 'behind' })).toBe('conflicts');
  });

  it('shortens a long description at a sentence or line end', () => {
    expect(shortenBody('short')).toEqual({ body: 'short', truncated: false });
    expect(shortenBody(null)).toEqual({ body: '', truncated: false });
    const long = shortenBody(`${'One sentence here. '.repeat(200)}`, 100);
    expect(long.truncated).toBe(true);
    expect(long.body.length).toBeLessThanOrEqual(100);
    expect(long.body.endsWith('.')).toBe(true);
    expect(shortenBody('x'.repeat(500), 100).body).toHaveLength(100);
  });
});

describe('what a tool printed, made safe to show', () => {
  it('removes tokens, credential locations, control characters and ways round a refusal', () => {
    const cleaned = cleanToolText('\u001b[31mfailed\u001b[0m: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 read from /home/me/.config/gh/hosts.yml\r\nor C:\\Users\\me\\AppData\\gh\\hosts.yml and ~/.config/gh/config.yml', 400);
    expect(cleaned).not.toMatch(/ghp_|hosts\.yml|config\.yml|\/home\/|AppData/);
    expect(cleaned.includes('\u001b')).toBe(false);
    expect(cleaned).toContain('failed');
    expect(cleaned).toContain('[path]');
    expect(cleanToolText('Required check missing. Use --admin to bypass this. Try again later.')).toBe('Required check missing. Try again later.');
    expect(cleanToolText('See https://docs.github.com/rest/pulls for details')).toBe('See https://docs.github.com/rest/pulls for details');
    expect(cleanToolText('x'.repeat(500))).toHaveLength(160);
  });
});
