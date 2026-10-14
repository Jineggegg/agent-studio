import type { GitWorktree } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, GitMerge, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { projectKeys } from '@/data/projects';
import { ProblemNote, type Problem } from '@/features/projects/tools/kit';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { Button, Checkbox, EmptyState, ErrorState, Form, LoadingRow, SegmentedControl, Sheet, TextArea, TextField, confirm, toast } from '@/ui';
import { gitApi, gitKeys } from './api';
import { AheadBehind, useGit } from './parts';
import { shortOid } from './status';

const folderLabel = (path: string): string => path.split('/').filter(Boolean).slice(-2).join('/');

function MergeSheet({ worktree, into, onClose }: { worktree: GitWorktree | null; into: string | null; onClose: () => void }) {
  const t = useT();
  const { project, busy, run } = useGit();
  const [shown, setShown] = useState(worktree);
  if (worktree && worktree !== shown) setShown(worktree);
  const [method, setMethod] = useState<'squash' | 'merge'>('squash');
  const [message, setMessage] = useState('');
  const [cleanup, setCleanup] = useState(true);
  const [problem, setProblem] = useState<Problem | null>(null);
  if (!shown) return null;
  const branch = shown.branch ?? '';

  const merge = async () => {
    const agreed = await confirm({
      title: t('git.worktree.merge.confirmTitle', { branch, into: into ?? '' }),
      message: [method === 'squash' ? t('git.worktree.merge.confirmSquash') : t('git.worktree.merge.confirmMerge'), cleanup ? t('git.worktree.merge.confirmCleanup', { branch }) : ''].filter(Boolean).join(' '),
      confirmLabel: t('git.worktree.merge'),
      tone: cleanup ? 'danger' : 'default',
    });
    if (!agreed) return;
    setProblem(null);
    const result = await run(`merge:${shown.path}`, () => gitApi.mergeWorktree(project.id, { path: shown.path, squash: method === 'squash', cleanup, ...(message.trim() ? { message: message.trim() } : {}) }), { quiet: true });
    if (!result.ok) return setProblem(result.problem);
    toast.success(t('git.worktree.merged', { branch: result.value.branch, into: result.value.into, oid: shortOid(result.value.oid) }));
    if (result.value.cleanupError) toast.warning(t('git.worktree.cleanupFailed'), { detail: result.value.cleanupError, duration: 'persistent' });
    onClose();
  };

  return (
    <Sheet
      open={worktree !== null}
      onClose={onClose}
      title={t('git.worktree.merge.title')}
      dismissible={busy === null}
      footer={
        <Button variant="primary" block loading={busy === `merge:${shown.path}`} disabled={busy !== null} onClick={() => void merge()}>
          {t('git.worktree.merge.action', { into: into ?? '' })}
        </Button>
      }
    >
      <div className="git-sheet">
        <p className="git-sheet__lead">{t('git.worktree.merge.lead', { branch, into: into ?? '', count: t.number(shown.ahead ?? 0) })}</p>
        {problem && <ProblemNote problem={problem} title={t('git.worktree.merge.refused')} />}
        <SegmentedControl
          label={t('git.worktree.merge.method')}
          value={method}
          onChange={setMethod}
          options={[
            { value: 'squash', label: t('git.worktree.merge.squash') },
            { value: 'merge', label: t('git.worktree.merge.commit') },
          ]}
        />
        <p className="pt-note git-sheet__note">{method === 'squash' ? t('git.worktree.merge.squashHint') : t('git.worktree.merge.commitHint')}</p>
        <TextArea label={t('git.worktree.merge.message')} optional value={message} onChange={setMessage} rows={2} autoGrow maxRows={6} hint={t('git.worktree.merge.messageHint')} />
        <Checkbox checked={cleanup} onChange={setCleanup} label={t('git.worktree.merge.cleanup')} hint={t('git.worktree.merge.cleanupHint', { branch })} />
      </div>
    </Sheet>
  );
}

/** Extra checkouts of the same repository, each on its own branch and each a project of its own — for work that runs side by side. */
export function WorktreesTab() {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project, busy, run, report } = useGit();
  const worktrees = useQuery({ queryKey: gitKeys.worktrees(project.id), queryFn: ({ signal }) => gitApi.worktrees(project.id, signal), retry: false });
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState('');
  const [branchProblem, setBranchProblem] = useState<string | null>(null);
  const [openAfter, setOpenAfter] = useState(true);
  const [merging, setMerging] = useState<GitWorktree | null>(null);

  if (worktrees.isPending) return <LoadingRow label={t('common.loading')} />;
  if (worktrees.isError && !worktrees.data) return <ErrorState compact error={worktrees.error} onRetry={() => void worktrees.refetch()} />;
  const data = worktrees.data;
  const linked = data.worktrees.filter((entry) => !entry.main);

  const goTo = (projectId: string) => void navigate(workbenchPaths.project(projectId), { replace: true });

  const create = async () => {
    const wanted = branch.trim();
    if (wanted === '') return setBranchProblem(t('git.branch.new.nameMissing'));
    setBranchProblem(null);
    const result = await run('create-worktree', () => gitApi.createWorktree(project.id, { branch: wanted }), { quiet: true });
    if (!result.ok) return setBranchProblem(result.problem.text);
    void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    setBranch('');
    setCreating(false);
    toast.success(result.value.branchCreated ? t('git.worktree.createdNew', { branch: wanted }) : t('git.worktree.created', { branch: wanted }));
    if (openAfter) goTo(result.value.project.id);
  };

  const open = async (worktree: GitWorktree) => {
    if (worktree.projectId && !worktree.projectArchived) return goTo(worktree.projectId);
    const result = await run(`open:${worktree.path}`, () => gitApi.openWorktree(project.id, worktree.path));
    if (!result.ok) return;
    void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    goTo(result.value.project.id);
  };

  const remove = async (worktree: GitWorktree) => {
    const name = worktree.branch ?? folderLabel(worktree.path);
    const agreed = await confirm({
      title: t('git.worktree.remove.title', { name }),
      message: worktree.branch ? t('git.worktree.remove.message', { branch: worktree.branch }) : t('git.worktree.remove.messageDetached'),
      confirmLabel: t('git.worktree.remove'),
      tone: 'danger',
    });
    if (!agreed) return;
    const attempt = (force: boolean) =>
      run(`remove:${worktree.path}`, () => gitApi.removeWorktree(project.id, { path: worktree.path, force, deleteBranch: worktree.branch !== null }), { operation: 'remove-worktree', quiet: true });
    let result = await attempt(false);
    if (!result.ok && result.recovery === 'force-remove-worktree') {
      // Uncommitted work is in there. Removing it anyway is a second, separate decision.
      const forced = await confirm({
        title: t('git.worktree.force.title', { name }),
        message: t.plural('git.worktree.force.message', worktree.changes ?? 0),
        confirmLabel: t('git.worktree.force.confirm'),
        tone: 'danger',
      });
      if (!forced) return;
      result = await attempt(true);
    }
    if (!result.ok) return report(result.problem);
    void queryClient.invalidateQueries({ queryKey: projectKeys.all });
    toast.success(t('git.worktree.removed', { name }));
    if (result.value.branchNote) toast.warning(t('git.worktree.branchKept', { branch: result.value.branch ?? '' }), { detail: result.value.branchNote });
  };

  return (
    <div className="git-worktrees">
      <div className="git-branches__bar">
        <p className="git-worktrees__count">{t.plural('git.worktree.count', linked.length)}</p>
        {!creating && data.location !== null && (
          <Button size="sm" variant="tinted" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            {t('git.worktree.new')}
          </Button>
        )}
      </div>
      {data.location === null && <p className="pt-note">{t('git.worktree.noLocation')}</p>}

      {creating && (
        <Form className="git-form" onSubmit={() => void create()}>
          <TextField
            label={t('git.worktree.new.branch')}
            value={branch}
            onChange={(value) => {
              setBranch(value);
              setBranchProblem(null);
            }}
            placeholder="feature/second-idea"
            hint={t('git.worktree.new.hint', { base: data.baseBranch ?? '—', location: data.location ?? '' })}
            error={branchProblem ?? undefined}
            mono
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            maxLength={250}
            data-autofocus=""
            autoFocus
          />
          <Checkbox checked={openAfter} onChange={setOpenAfter} label={t('git.worktree.new.openAfter')} />
          <div className="git-form__actions">
            <Button
              variant="plain"
              size="sm"
              onClick={() => {
                setCreating(false);
                setBranchProblem(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={busy === 'create-worktree'} disabled={busy !== null}>
              {t('git.worktree.new.create')}
            </Button>
          </div>
        </Form>
      )}

      {linked.length === 0 && !creating && <EmptyState compact title={t('git.worktree.empty')} description={t('git.worktree.emptyHint')} />}

      <ul className="git-list">
        {data.worktrees.map((worktree) => {
          const name = worktree.branch ?? t('git.worktree.detached', { oid: shortOid(worktree.oid) });
          const canMerge = !worktree.main && !worktree.current && worktree.branch !== null && (worktree.ahead ?? 0) > 0;
          return (
            <li key={worktree.path} className="git-worktree">
              <div className="git-branch__text">
                <p className="git-branch__name">
                  <span className="u-truncate">{name}</span>
                  {worktree.current && (
                    <span className="pt-pill" data-tone="accent">
                      {t('git.worktree.here')}
                    </span>
                  )}
                  {worktree.main && <span className="pt-pill">{t('git.worktree.main')}</span>}
                  {worktree.locked && <span className="pt-pill">{t('git.worktree.locked')}</span>}
                  {worktree.missing && (
                    <span className="pt-pill" data-tone="warning">
                      {t('git.worktree.missing')}
                    </span>
                  )}
                  {!worktree.main && <AheadBehind ahead={worktree.ahead} behind={worktree.behind} />}
                </p>
                <p className="git-branch__sub u-truncate">
                  <span className="u-mono">{folderLabel(worktree.path)}</span>
                  {worktree.changes !== null && worktree.changes > 0 && <> · {t.plural('git.worktree.changes', worktree.changes)}</>}
                  {worktree.subject && <> · {worktree.subject}</>}
                </p>
                {!worktree.current && (
                  <div className="git-worktree__actions">
                    <Button size="sm" variant="neutral" icon={<ExternalLink size={15} />} loading={busy === `open:${worktree.path}`} disabled={busy !== null || worktree.missing} onClick={() => void open(worktree)}>
                      {t('git.worktree.open')}
                    </Button>
                    {!worktree.main && (
                      <>
                        <Button size="sm" variant="neutral" icon={<GitMerge size={15} />} disabled={busy !== null || !canMerge} onClick={() => setMerging(worktree)} title={canMerge ? undefined : t('git.worktree.nothingToMerge')}>
                          {t('git.worktree.merge')}
                        </Button>
                        <Button size="sm" variant="plain-danger" icon={<Trash2 size={15} />} loading={busy === `remove:${worktree.path}`} disabled={busy !== null} onClick={() => void remove(worktree)}>
                          {t('git.worktree.remove')}
                        </Button>
                      </>
                    )}
                  </div>
                )}
                {!worktree.main && !worktree.current && !canMerge && worktree.branch !== null && <p className="git-worktree__hint">{t('git.worktree.nothingToMerge')}</p>}
              </div>
            </li>
          );
        })}
      </ul>
      <MergeSheet worktree={merging} into={data.baseBranch} onClose={() => setMerging(null)} />
    </div>
  );
}
