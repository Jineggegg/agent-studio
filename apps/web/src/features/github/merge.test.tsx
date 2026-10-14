import { GITHUB_ERROR_CODES, type GithubPullDetail, githubBlockerCodeSchema, githubPullVerdictSchema } from '@agent-studio/protocol';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTranslator } from '@/i18n';
import { en } from '@/i18n/en';
import { zhCN } from '@/i18n/zh-CN';
import { renderInApp } from '@/test/render';
import { ConfirmHost } from '@/ui';
import { PullSheet } from './PullSheet';
import { type MergeChoice, acknowledged, blockerKey, checksLabel, mayMerge, mergeConfirmation, mergeGuard, mergeRequest, rememberedMethod, summaryVerdict, verdictKey, verdictTone } from './merge';

const api = vi.hoisted(() => ({ pull: vi.fn(), merge: vi.fn(), updateBranch: vi.fn(), markReady: vi.fn(), approveRuns: vi.fn() }));
vi.mock('./api', async (original) => ({ ...(await original<Record<string, unknown>>()), githubApi: api }));

const HEAD = 'a'.repeat(40);
const checks = (overrides: Partial<GithubPullDetail['checks']> = {}): GithubPullDetail['checks'] => ({ state: 'passing', total: 2, passing: 2, failing: 0, pending: 0, skipped: 0, ...overrides });

const pull = (overrides: Partial<GithubPullDetail> = {}): GithubPullDetail => ({
  owner: 'octo',
  repo: 'demo',
  number: 7,
  title: 'Add the login form',
  url: 'https://github.com/octo/demo/pull/7',
  author: 'mona',
  draft: false,
  headRef: 'feature/login',
  baseRef: 'main',
  headSha: HEAD,
  additions: 40,
  deletions: 3,
  changedFiles: 2,
  mergeable: 'mergeable',
  mergeState: 'clean',
  reviewDecision: 'approved',
  checks: checks(),
  updatedAt: Date.now() - 60_000,
  reasons: [],
  state: 'open',
  body: 'Adds the form.',
  bodyTruncated: false,
  createdAt: Date.now() - 3_600_000,
  checkRuns: [{ name: 'build', workflow: 'CI', state: 'passing', required: true, url: 'https://github.com/octo/demo/actions/runs/1' }],
  checkRunsTruncated: false,
  files: [{ path: 'src/login.tsx', status: 'A', additions: 40, deletions: 0 }],
  filesTruncated: false,
  mergeMethods: ['squash', 'merge'],
  deleteBranchOnMerge: false,
  crossRepository: false,
  canMerge: true,
  mergeQueue: false,
  blockers: [],
  optionalChecksFailing: false,
  mergeCommit: null,
  pendingRuns: [],
  fixes: { updateBranch: false, markReady: false, approveRuns: false },
  pollAfterMs: null,
  freshness: { fetchedAt: Date.now(), stale: false, staleReason: null },
  ...overrides,
});

const choice = (overrides: Partial<MergeChoice> = {}): MergeChoice => ({ method: 'squash', deleteBranch: false, acknowledgedHead: null, ...overrides });

afterEach(() => {
  for (const mock of Object.values(api)) mock.mockReset();
  window.localStorage.clear();
});

describe('the merge guard', () => {
  it('offers a merge only for an open pull request that nothing blocks', () => {
    expect(mergeGuard(pull()).offered).toBe(true);
    expect(mergeGuard(pull({ blockers: [{ code: 'required_checks_failed', message: 'A required check failed.' }] })).offered).toBe(false);
    expect(mergeGuard(pull({ state: 'merged' })).offered).toBe(false);
    expect(mergeGuard(pull({ state: 'closed' })).offered).toBe(false);
    expect(mergeGuard(pull({ mergeMethods: [] })).offered).toBe(false);
  });

  it('takes away the merge for each blocker alone', () => {
    for (const code of githubBlockerCodeSchema.options) {
      expect(mergeGuard(pull({ blockers: [{ code, message: 'no' }] })).offered, code).toBe(false);
      expect(mayMerge(mergeGuard(pull({ blockers: [{ code, message: 'no' }] })), choice(), HEAD), code).toBe(false);
    }
  });

  it('needs a method the repository allows', () => {
    const guard = mergeGuard(pull());
    expect(mayMerge(guard, choice({ method: null }), HEAD)).toBe(false);
    expect(mayMerge(guard, choice({ method: 'rebase' }), HEAD)).toBe(false);
    expect(mayMerge(guard, choice({ method: 'merge' }), HEAD)).toBe(true);
  });

  it('needs failing optional checks to be acknowledged — for the commit that was looked at', () => {
    const detail = pull({ optionalChecksFailing: true });
    const guard = mergeGuard(detail);
    expect(mayMerge(guard, choice(), HEAD)).toBe(false);
    expect(mayMerge(guard, choice({ acknowledgedHead: HEAD }), HEAD)).toBe(true);
    // The pull request moved on: the acknowledgement no longer counts.
    const moved = 'b'.repeat(40);
    expect(acknowledged(choice({ acknowledgedHead: HEAD }), moved)).toBe(false);
    expect(mayMerge(guard, choice({ acknowledgedHead: HEAD }), moved)).toBe(false);
  });

  it('sends the head commit that was on screen, and acknowledges only when there was something to acknowledge', () => {
    const guard = mergeGuard(pull());
    expect(mergeRequest(pull(), guard, { ...choice({ acknowledgedHead: HEAD, deleteBranch: true }), method: 'squash' })).toEqual({ method: 'squash', headSha: HEAD, deleteBranch: true, acknowledgeFailingChecks: false });
    const failing = pull({ optionalChecksFailing: true });
    expect(mergeRequest(failing, mergeGuard(failing), { ...choice({ acknowledgedHead: HEAD }), method: 'merge' })).toEqual({ method: 'merge', headSha: HEAD, deleteBranch: false, acknowledgeFailingChecks: true });
  });

  it('does not offer to delete a branch that is not its to delete', () => {
    expect(mergeGuard(pull()).mayDeleteBranch).toBe(true);
    for (const overrides of [{ crossRepository: true }, { deleteBranchOnMerge: true }, { mergeQueue: true }]) {
      const guard = mergeGuard(pull(overrides));
      expect(guard.mayDeleteBranch, JSON.stringify(overrides)).toBe(false);
      expect(mergeRequest(pull(overrides), guard, { ...choice({ deleteBranch: true }), method: 'squash' }).deleteBranch).toBe(false);
    }
  });

  it('offers the method used last in a repository first, when it is still allowed', () => {
    const store = new Map<string, string>([['studio.github.method.octo/demo', 'merge']]);
    const storage = { getItem: (key: string) => store.get(key) ?? null };
    expect(rememberedMethod('octo', 'demo', ['squash', 'merge'], storage)).toBe('merge');
    expect(rememberedMethod('octo', 'demo', ['squash', 'rebase'], storage)).toBe('squash');
    expect(rememberedMethod('octo', 'other', ['rebase'], storage)).toBe('rebase');
    expect(rememberedMethod('octo', 'other', [], storage)).toBeNull();
  });
});

describe('the last question before a merge', () => {
  it('names the repository, the pull request, the method and the commit, and says it cannot be undone here', () => {
    const question = mergeConfirmation(pull(), 'squash', { deleteBranch: false, queued: false }, getTranslator('en'));
    expect(question.title).toBe('Merge octo/demo #7?');
    expect(question.message).toBe('The commits of feature/login (at aaaaaaa) are squashed into one commit on main. A merge cannot be undone from the Studio.');
    expect(question.confirmLabel).toBe('Merge pull request #7');
  });

  it('says what else will happen', () => {
    const question = mergeConfirmation(pull(), 'merge', { deleteBranch: true, queued: true }, getTranslator('en'));
    expect(question.message).toContain('feature/login (at aaaaaaa) is joined to main with a merge commit.');
    expect(question.message).toContain('It goes through the merge queue.');
    expect(question.message).toContain('Afterwards the branch feature/login is deleted.');
    expect(mergeConfirmation(pull(), 'rebase', { deleteBranch: false, queued: false }, getTranslator('zh-CN')).title).toBe('合并 octo/demo #7？');
  });
});

describe('words for what the server reports', () => {
  it('has a sentence for every GitHub error code, in both languages', () => {
    for (const code of GITHUB_ERROR_CODES) {
      const key = `errors.${code}` as keyof typeof en;
      expect(en[key], `${code} (en)`).toBeTruthy();
      expect(zhCN[key], `${code} (zh-CN)`).toBeTruthy();
    }
  });

  it('has words for every blocker and every verdict, in both languages', () => {
    for (const code of githubBlockerCodeSchema.options) {
      expect(en[blockerKey(code)], code).toBeTruthy();
      expect(zhCN[blockerKey(code)], code).toBeTruthy();
    }
    for (const verdict of githubPullVerdictSchema.options) {
      expect(en[verdictKey(verdict)], verdict).toBeTruthy();
      expect(zhCN[verdictKey(verdict)], verdict).toBeTruthy();
      expect(['positive', 'danger', 'warning', 'running', 'neutral']).toContain(verdictTone(verdict));
    }
  });

  it('puts the worst news about checks first', () => {
    const t = getTranslator('en');
    expect(checksLabel(checks({ state: 'failing', total: 5, passing: 2, failing: 2, pending: 1 }), t)).toBe('2 checks failing');
    expect(checksLabel(checks({ state: 'pending', total: 3, passing: 2, pending: 1 }), t)).toBe('1 check running');
    expect(checksLabel(checks({ total: 5, passing: 5 }), t)).toBe('All 5 checks passing');
    expect(checksLabel(checks({ state: 'none', total: 0, passing: 0 }), t)).toBe('No checks');
  });

  it('gives a pull request in a list one word, worst first', () => {
    expect(summaryVerdict(pull({ draft: true, mergeable: 'conflicting' }))).toBe('draft');
    expect(summaryVerdict(pull({ mergeable: 'conflicting', checks: checks({ state: 'failing' }) }))).toBe('conflicts');
    expect(summaryVerdict(pull({ mergeState: 'behind' }))).toBe('behind');
    expect(summaryVerdict(pull({ checks: checks({ state: 'failing' }) }))).toBe('checks_failed');
    expect(summaryVerdict(pull({ checks: checks({ state: 'pending' }) }))).toBe('checks_running');
    expect(summaryVerdict(pull({ reviewDecision: 'changes_requested' }))).toBe('changes_requested');
    expect(summaryVerdict(pull({ reviewDecision: 'review_required' }))).toBe('review_required');
    expect(summaryVerdict(pull({ mergeable: 'unknown' }))).toBe('checking');
    expect(summaryVerdict(pull())).toBe('mergeable');
  });
});

describe('the pull-request sheet', () => {
  const open = () =>
    renderInApp(
      <>
        <PullSheet pull={{ owner: 'octo', repo: 'demo', number: 7 }} onClose={() => {}} />
        <ConfirmHost />
      </>,
    );

  it('has no merge control at all while something blocks, and says what does', async () => {
    api.pull.mockResolvedValue(
      pull({
        blockers: [
          { code: 'required_checks_failed', message: 'The required check "build" failed.' },
          { code: 'behind', message: 'The branch is behind main.' },
        ],
        checks: checks({ state: 'failing', failing: 1, passing: 1 }),
      }),
    );
    open();
    expect(await screen.findByText('This cannot be merged from here yet')).toBeInTheDocument();
    expect(screen.getByText('A required check failed')).toBeInTheDocument();
    expect(screen.getByText('It is behind its base branch and has to be updated first')).toBeInTheDocument();
    // The server's own sentence says the same in English only: the reader gets one sentence per reason, in their language.
    expect(screen.queryByText('The required check "build" failed.')).toBeNull();
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull();
    expect(screen.getByText('Merging is not offered while 2 things block it.')).toBeInTheDocument();
  });

  it('walks a merge through the method, the question that names it, and the result', async () => {
    api.pull.mockResolvedValue(pull());
    api.merge.mockResolvedValue({ outcome: 'merged', mergeCommit: 'c'.repeat(40), message: 'Pull request merged.', branchDeleted: null });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge…' }));
    expect(screen.getByRole('radio', { name: /Squash and merge/ })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /Merge commit/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge #7' }));
    // Nothing is sent before the question is answered.
    expect(await screen.findByRole('alertdialog', { name: 'Merge octo/demo #7?' })).toBeInTheDocument();
    expect(api.merge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Merge pull request #7' }));
    await waitFor(() => expect(api.merge).toHaveBeenCalledWith({ owner: 'octo', repo: 'demo', number: 7 }, { method: 'merge', headSha: HEAD, deleteBranch: false, acknowledgeFailingChecks: false }));
    expect(await screen.findByText('Merged')).toBeInTheDocument();
    expect(screen.getByText('ccccccc')).toBeInTheDocument();
  });

  it('shows a refusal as the server worded it, with a reload and no way to merge anyway', async () => {
    const { ApiError } = await import('@/data/http');
    api.pull.mockResolvedValue(pull());
    api.merge.mockRejectedValue(new ApiError(409, 'github_head_moved', 'The pull request changed since you looked at it: its head is now bbbbbbb. Review it again before merging.', { headSha: 'b'.repeat(40) }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Merge #7' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Merge pull request #7' }));
    expect(await screen.findByText('Not merged')).toBeInTheDocument();
    expect(screen.getByText(/its head is now bbbbbbb/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /anyway/i })).toBeNull();
    expect(api.merge).toHaveBeenCalledTimes(1);
  });

  it('keeps the merge button off until failing optional checks are acknowledged', async () => {
    api.pull.mockResolvedValue(pull({ optionalChecksFailing: true, checks: checks({ state: 'failing', failing: 1, passing: 1 }) }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Merge…' }));
    expect(screen.getByRole('button', { name: 'Merge #7' })).toBeDisabled();
    fireEvent.click(within(screen.getByText('I have seen that checks which are not required are failing').closest('label')!).getByRole('switch'));
    expect(screen.getByRole('button', { name: 'Merge #7' })).toBeEnabled();
  });
});
