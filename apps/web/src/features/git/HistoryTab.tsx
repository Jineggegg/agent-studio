import type { GitCommit } from '@agent-studio/protocol';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Copy, GitBranch, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { PathLabel, ProblemNote, hunksOnly, problemOf } from '@/features/projects/tools/kit';
import { ChangeCounts, DiffView } from '@/features/workbench/transcript/DiffView';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { Button, EmptyState, ErrorState, LoadingRow, Sheet, toast } from '@/ui';
import { gitApi, gitKeys } from './api';
import { useGit } from './parts';
import { shortOid, splitPatch } from './status';

const LETTER_KIND: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified', U: 'untracked' };

export function RefPills({ refs }: { refs: GitCommit['refs'] }) {
  if (refs.length === 0) return null;
  return (
    <span className="git-refs">
      {refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className="pt-pill" data-tone={ref.kind === 'head' ? 'accent' : ref.kind === 'tag' ? 'warning' : ref.kind === 'remote' ? 'neutral' : 'info'}>
          {ref.kind === 'tag' ? <Tag size={11} aria-hidden="true" /> : <GitBranch size={11} aria-hidden="true" />}
          <span>{ref.name}</span>
        </span>
      ))}
    </span>
  );
}

/** One commit in full: who, when, what it says, the files it touched and the diff against its first parent. */
function CommitSheet({ oid, onClose }: { oid: string | null; onClose: () => void }) {
  const t = useT();
  const { project } = useGit();
  const [shown, setShown] = useState(oid);
  if (oid && oid !== shown) setShown(oid);
  const detail = useQuery({
    queryKey: gitKeys.commit(project.id, shown ?? ''),
    queryFn: ({ signal }) => gitApi.commit(project.id, shown!, signal),
    enabled: shown !== null && oid !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const commit = detail.data;
  const parts = useMemo(() => splitPatch(commit?.diff ?? ''), [commit?.diff]);
  const unmatched = commit
    ? parts
        .filter((part) => !commit.files.some((file) => file.path === part.path))
        .map((part) => part.patch)
        .join('')
    : '';
  return (
    <Sheet open={oid !== null} onClose={onClose} title={t('git.commit.title', { oid: shortOid(shown) })} size="lg" fill flush>
      <div className="git-commit-detail">
        {detail.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : detail.isError ? (
          <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} />
        ) : commit ? (
          <>
            <header className="git-commit-detail__head">
              <p className="git-commit-detail__subject">{commit.subject}</p>
              {commit.body.trim() !== '' && <p className="git-commit-detail__body">{commit.body.trim()}</p>}
              <RefPills refs={commit.refs} />
              <p className="git-commit-detail__meta">
                {t('git.commit.by', { name: commit.authorName, when: t.date(commit.authoredAt, 'dateTime') })}
                {commit.committerName !== commit.authorName && <> · {t('git.commit.committedBy', { name: commit.committerName })}</>}
              </p>
              <button
                type="button"
                className="git-oid"
                onClick={() => void copyText(commit.oid).then((copied) => copied && toast.success(t('git.commit.oidCopied')))}
                aria-label={t('git.commit.copyOid', { oid: commit.oid })}
              >
                <span className="u-mono">{commit.oid}</span>
                <Copy size={14} aria-hidden="true" />
              </button>
            </header>
            <h3 className="pt-section">
              <span>{t.plural('git.commit.files', commit.files.length)}</span>
              <ChangeCounts added={commit.additions} removed={commit.deletions} />
            </h3>
            <ul className="git-commit-detail__files">
              {commit.files.map((file) => {
                const part = parts.find((entry) => entry.path === file.path);
                return (
                  <li key={file.path}>
                    <div className="git-file">
                      <span className="pt-letter" data-kind={LETTER_KIND[file.status]} aria-hidden="true">
                        {file.status}
                      </span>
                      <PathLabel path={file.path} />
                      {file.additions !== null && file.deletions !== null ? <ChangeCounts added={file.additions} removed={file.deletions} /> : <span className="git-file__binary">{t('git.diff.binaryShort')}</span>}
                    </div>
                    {part && (
                      <div className="git-diff">
                        <DiffView patch={hunksOnly(part.patch)} limit={800} label={t('git.diff.label', { name: file.path })} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* Whatever of the patch could not be matched to a file above is still shown, with git's own headers. */}
            {unmatched !== '' && (
              <div className="git-diff">
                <DiffView patch={unmatched} limit={800} label={t('git.commit.diffLabel', { oid: shortOid(commit.oid) })} />
              </div>
            )}
            {commit.diffTruncated && <p className="git-diff__note git-commit-detail__note">{t('git.diff.truncated')}</p>}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The repository's history, newest first, a page at a time. */
export function HistoryTab() {
  const t = useT();
  const { project } = useGit();
  const [selected, setSelected] = useState<string | null>(null);
  const log = useInfiniteQuery({
    queryKey: gitKeys.log(project.id),
    queryFn: ({ pageParam, signal }) => gitApi.log(project.id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    retry: false,
  });

  if (log.isPending) return <LoadingRow label={t('git.history.loading')} />;
  if (log.isError && !log.data) return <ErrorState compact error={log.error} onRetry={() => void log.refetch()} />;
  const commits = log.data.pages.flatMap((page) => page.commits);
  if (commits.length === 0) return <EmptyState compact title={t('git.history.empty')} description={t('git.history.emptyHint')} />;

  return (
    <div className="git-history">
      {log.isError && <ProblemNote problem={problemOf(log.error, t)} />}
      <ol className="git-history__list">
        {commits.map((commit) => (
          <li key={commit.oid}>
            <button type="button" className="git-commit-row" onClick={() => setSelected(commit.oid)} aria-haspopup="dialog">
              <span className="git-commit-row__subject">{commit.subject || t('git.history.noSubject')}</span>
              <RefPills refs={commit.refs} />
              <span className="git-commit-row__meta">
                <span className="u-truncate">{commit.authorName}</span>
                <span>{t.relative(commit.authoredAt)}</span>
                <span className="u-mono">{shortOid(commit.oid)}</span>
                {commit.parents.length > 1 && <span>{t('git.history.merge')}</span>}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {log.hasNextPage ? (
        <div className="git-more">
          <Button variant="neutral" size="sm" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('git.history.more')}
          </Button>
        </div>
      ) : (
        <p className="pt-note">{t.plural('git.history.end', commits.length)}</p>
      )}
      <CommitSheet oid={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
