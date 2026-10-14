import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { PathLabel, ProblemNote, problemOf, splitPath } from '@/features/projects/tools/kit';
import { ChangeCounts } from '@/features/workbench/transcript/DiffView';
import { useT } from '@/i18n';
import { Button, EmptyState, ErrorState, LoadingRow, Select } from '@/ui';
import { gitApi, gitKeys } from './api';
import { Disclosure, LazyDiff, useGit } from './parts';
import { defaultCompareBase, shortOid } from './status';

const LETTER_KIND: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', U: 'untracked' };

/** Everything that differs from where this branch left another one: committed, staged, unstaged and new files alike. */
export function CompareTab() {
  const t = useT();
  const { project } = useGit();
  const branches = useQuery({ queryKey: gitKeys.branches(project.id), queryFn: ({ signal }) => gitApi.branches(project.id, signal), retry: false });
  const [base, setBase] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const suggested = useMemo(() => defaultCompareBase(branches.data), [branches.data]);
  const chosen = base !== null && branches.data?.branches.some((branch) => branch.name === base) ? base : suggested;

  // Another base is another comparison: rows opened for the old one are closed.
  useEffect(() => setOpen(new Set()), [chosen]);

  const comparison = useQuery({
    queryKey: gitKeys.compare(project.id, chosen ?? ''),
    queryFn: ({ signal }) => gitApi.compare(project.id, chosen!, signal),
    enabled: chosen !== null,
    retry: false,
  });

  if (branches.isPending) return <LoadingRow label={t('common.loading')} />;
  if (branches.isError && !branches.data) return <ErrorState compact error={branches.error} onRetry={() => void branches.refetch()} />;
  if (chosen === null) return <EmptyState compact title={t('git.compare.noBranches')} description={t('git.compare.noBranchesHint')} />;

  const options = branches.data.branches
    .filter((branch) => !branch.current && !(branch.kind === 'remote' && branch.name.endsWith('/HEAD')))
    .map((branch) => ({ value: branch.name, label: branch.name, ...(branch.kind === 'remote' ? { hint: t('git.branch.remoteShort') } : {}) }));

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="git-compare">
      <div className="git-compare__base">
        <span id="git-compare-base">{t('git.compare.against')}</span>
        <Select label={t('git.compare.against')} value={chosen} onChange={setBase} options={options} />
      </div>
      {comparison.isPending ? (
        <LoadingRow label={t('git.compare.loading')} />
      ) : comparison.isError ? (
        <ProblemNote
          problem={problemOf(comparison.error, t)}
          title={t('git.compare.failed')}
          action={
            <Button size="sm" variant="plain" onClick={() => void comparison.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : comparison.data.files.length === 0 ? (
        <EmptyState compact title={t('git.compare.same', { base: chosen })} />
      ) : (
        <>
          <p className="pt-note">
            {t.plural('git.compare.summary', comparison.data.files.length, { base: comparison.data.base })} · {t('git.compare.mergeBase', { oid: shortOid(comparison.data.mergeBase) })}
          </p>
          {comparison.data.files.map((file) => {
            const isOpen = open.has(file.path);
            const { name } = splitPath(file.path);
            return (
              <div key={file.path} className="git-change" data-open={isOpen || undefined}>
                <div className="git-row">
                  <button type="button" className="git-row__main" aria-expanded={isOpen} onClick={() => toggle(file.path)}>
                    <Disclosure open={isOpen} />
                    <span className="pt-letter" data-kind={LETTER_KIND[file.status]} aria-hidden="true">
                      {file.status}
                    </span>
                    <span className="git-row__text">
                      <PathLabel path={file.path} />
                      {file.originalPath && <span className="git-row__sub u-truncate">{t('git.change.renamedFrom', { path: file.originalPath })}</span>}
                    </span>
                    {file.additions !== null && file.deletions !== null && <ChangeCounts added={file.additions} removed={file.deletions} />}
                  </button>
                </div>
                {isOpen && (
                  <LazyDiff
                    queryKey={gitKeys.compareDiff(project.id, chosen, file.path)}
                    read={(signal) => gitApi.compareDiff(project.id, chosen, file.path, file.originalPath, signal)}
                    label={t('git.diff.label', { name })}
                  />
                )}
              </div>
            );
          })}
          {comparison.data.truncated && <p className="pt-note">{t('git.compare.truncated')}</p>}
        </>
      )}
    </div>
  );
}
