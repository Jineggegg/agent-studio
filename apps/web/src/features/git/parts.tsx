import type { Project } from '@agent-studio/protocol';
import { type QueryKey, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, createContext, useContext } from 'react';
import { type Problem, ProblemNote, hunksOnly, problemOf } from '@/features/projects/tools/kit';
import type { InspectorRequest } from '@/features/workbench/inspector/registry';
import { DiffView } from '@/features/workbench/transcript/DiffView';
import { useT } from '@/i18n';
import { Button, Spinner } from '@/ui';
import type { Recovery } from './status';

export type GitOperation = 'pull' | 'push' | 'commit' | 'delete-branch' | 'remove-worktree' | 'other';

export interface RunOptions {
  /** What kind of thing was attempted, for choosing what to offer after a refusal. */
  operation?: GitOperation;
  /** Shown as a toast when it worked. */
  done?: string;
  /** Do not put a refusal in the panel's banner; the caller shows it where it happened. */
  quiet?: boolean;
}

/** What every part of the Git panel needs: the project, whether it may be changed, and one way to run an action. */
export interface GitScope {
  project: Project;
  writable: boolean;
  /** The key of the action in flight, if any. While one runs, the others wait. */
  busy: string | null;
  /**
   * Run one action: marks it busy, re-reads what it may have changed, and on
   * a refusal says why in the panel. Resolves with the result, or null when
   * it was refused (the reason is then on screen, or returned to `quiet` callers).
   */
  run: <T>(key: string, action: () => Promise<T>, options?: RunOptions) => Promise<{ ok: true; value: T } | { ok: false; problem: Problem; recovery: Recovery | null }>;
  /** Put a refusal in the panel's banner (for `quiet` callers that decided it belongs there after all). */
  report: (problem: Problem | null) => void;
  /** Ask another panel of the inspector for something (open a file on its changes). */
  ask: (request: InspectorRequest) => void;
  /** Open the sheet for the commit name and e-mail. Resolves true once an identity is saved. */
  askIdentity: () => Promise<boolean>;
}

const Scope = createContext<GitScope | null>(null);
export const GitScopeProvider = Scope.Provider;

export function useGit(): GitScope {
  const scope = useContext(Scope);
  if (!scope) throw new Error('The Git panel’s parts must be rendered inside it.');
  return scope;
}

/** A diff that is read only once its row is opened, and re-read when the repository changes. */
export function LazyDiff({ queryKey, read, label }: { queryKey: QueryKey; read: (signal: AbortSignal) => Promise<{ diff: string; binary: boolean; truncated: boolean }>; label: string }) {
  const t = useT();
  const query = useQuery({ queryKey, queryFn: ({ signal }) => read(signal), retry: false, staleTime: 10_000 });
  if (query.isPending) {
    return (
      <p className="git-diff__note" role="status">
        <Spinner size={14} /> {t('git.diff.loading')}
      </p>
    );
  }
  if (query.isError) {
    return (
      <ProblemNote
        problem={problemOf(query.error, t)}
        action={
          <Button size="sm" variant="plain" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }
  if (query.data.binary) return <p className="git-diff__note">{t('git.diff.binary')}</p>;
  if (query.data.diff === '') return <p className="git-diff__note">{t('git.diff.empty')}</p>;
  return (
    <div className="git-diff">
      <DiffView patch={hunksOnly(query.data.diff)} limit={1500} label={label} />
      {query.data.truncated && <p className="git-diff__note">{t('git.diff.truncated')}</p>}
    </div>
  );
}

/** The chevron that says a row opens in place. */
export function Disclosure({ open }: { open: boolean }) {
  return (
    <span className="git-row__chevron" data-open={open || undefined} aria-hidden="true">
      <ChevronRight size={15} />
    </span>
  );
}

/** "↑2 ↓1" with the words for assistive technology; nothing when both are zero or unknown. */
export function AheadBehind({ ahead, behind }: { ahead: number | null; behind: number | null }) {
  const t = useT();
  if (!ahead && !behind) return null;
  return (
    <span className="git-counts" aria-label={t('git.aheadBehind', { ahead: t.number(ahead ?? 0), behind: t.number(behind ?? 0) })}>
      {!!ahead && <span aria-hidden="true">↑{t.number(ahead)}</span>}
      {!!behind && <span aria-hidden="true">↓{t.number(behind)}</span>}
    </span>
  );
}

export function SectionTitle({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  const t = useT();
  return (
    <h3 className="pt-section">
      <span>
        {children}
        {count !== undefined && <span className="git-section__count"> {t.number(count)}</span>}
      </span>
      {action}
    </h3>
  );
}
