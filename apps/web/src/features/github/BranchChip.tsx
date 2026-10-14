import { useQuery } from '@tanstack/react-query';
import { GitBranch, GitPullRequest } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { gitApi, gitKeys } from '@/features/git/api';
import type { TitleBarItemProps } from '@/features/workbench/chat/slots';
import { showInspectorPanel } from '@/features/workbench/inspector/registry';
import { useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import { useScreenActive } from '@/shell/ScreenStack';
import { githubApi, githubKeys } from './api';
import { PullSheet } from './PullSheet';
import { verdictKey, verdictTone } from './merge';
import './github.css';

/**
 * In the conversation's title bar: the branch the project is on and, when
 * that branch has an open pull request, its number and one word for where it
 * stands. Tapping the pull request opens its sheet; tapping a bare branch
 * opens the Git panel.
 *
 * It says nothing rather than something wrong: no repository, no GitHub
 * login, a first read that failed — each of those simply leaves the chip, or
 * its pull-request half, out. A later read that fails keeps what was known.
 */
export default function BranchChip({ project, busy, compact }: TitleBarItemProps) {
  const t = useT();
  const active = useScreenActive();
  const visible = usePageVisible();
  const [open, setOpen] = useState(false);
  const status = useQuery({ queryKey: gitKeys.status(project.id), queryFn: ({ signal }) => gitApi.status(project.id, signal), staleTime: 15_000, retry: false });
  const branch = status.data?.state === 'ready' && status.data.branch && !status.data.branch.detached ? status.data.branch.name : null;
  const lookup = useQuery({
    queryKey: githubKeys.branchPull(project.id),
    queryFn: ({ signal }) => githubApi.branchPull(project.id, false, signal),
    enabled: branch !== null && active,
    staleTime: 30_000,
    retry: false,
    // Once a minute while someone is looking; never while the page or the workbench is hidden.
    refetchInterval: active && visible ? 60_000 : false,
  });

  // An agent that just finished may have pushed: look again at once rather than in a minute.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && branch !== null) {
      void status.refetch();
      void githubApi.branchPull(project.id, true).then(
        () => lookup.refetch(),
        () => undefined,
      );
    }
    wasBusy.current = busy;
    // Only the run ending matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // The branch changed underneath (a switch in the Git panel): the pull request of the old one no longer applies.
  useEffect(() => {
    if (branch !== null && lookup.data && lookup.data.branch !== null && lookup.data.branch !== branch) void lookup.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  const found = lookup.data?.result === 'found' && lookup.data.pull && lookup.data.verdict && lookup.data.branch === branch ? lookup.data : null;
  // The sheet stays open even if a merge makes the chip's pull request disappear.
  const [sheet, setSheet] = useState<{ owner: string; repo: string; number: number } | null>(null);

  if (branch === null) return null;
  if (!found && compact) return <PullSheet pull={open ? sheet : null} onClose={() => setOpen(false)} />;

  const pull = found?.pull ?? null;
  const verdict = found?.verdict ?? null;
  const label = pull && verdict ? t('github.chip.label', { branch, number: pull.number, state: t(verdictKey(verdict)) }) : t('github.chip.branch', { branch });

  return (
    <>
      <button
        type="button"
        className="gh-chip"
        data-compact={compact || undefined}
        aria-label={label}
        title={pull ? `${pull.title} — ${label}` : label}
        aria-haspopup={pull ? 'dialog' : undefined}
        onClick={() => {
          if (pull) {
            setSheet({ owner: pull.owner, repo: pull.repo, number: pull.number });
            setOpen(true);
          } else showInspectorPanel('git');
        }}
      >
        {!compact && (
          <>
            <GitBranch size={15} aria-hidden="true" />
            <span className="gh-chip__branch u-truncate">{branch}</span>
          </>
        )}
        {pull && verdict && (
          <span className="gh-chip__pull">
            {compact && <GitPullRequest size={15} aria-hidden="true" />}
            <span className="u-tabular">#{pull.number}</span>
            <span className="pt-dot" data-tone={verdictTone(verdict)} />
            {!compact && <span className="gh-chip__state">{t(verdictKey(verdict))}</span>}
          </span>
        )}
      </button>
      <PullSheet pull={open ? sheet : null} onClose={() => setOpen(false)} />
    </>
  );
}
