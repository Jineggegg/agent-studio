import { type GitStatus, type Project, gitIdentitySchema } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, ArrowUpFromLine, CloudUpload, Ellipsis, GitBranch, RefreshCw, TriangleAlert, Undo2, UserRound } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useIsOwner, useUser } from '@/data/session';
import { type Problem, ProblemNote, Stage, problemOf, useProjectEvents, wasCancelled } from '@/features/projects/tools/kit';
import { type InspectorPanelProps, requestInspector } from '@/features/workbench/inspector/registry';
import { useT } from '@/i18n';
import { Banner, Button, EmptyState, ErrorState, Form, IconButton, LoadingRow, MenuButton, Sheet, StaleNotice, Tabs, TextField, confirm, tabPanelProps, toast } from '@/ui';
import { gitApi, gitKeys } from './api';
import { BranchesTab } from './BranchesTab';
import { ChangesTab } from './ChangesTab';
import { CompareTab } from './CompareTab';
import { HistoryTab } from './HistoryTab';
import { AheadBehind, type GitScope, GitScopeProvider, type RunOptions } from './parts';
import { type Recovery, changedFileCount, recoveryFor, shortOid, syncOffers, undoOffer } from './status';
import { WorktreesTab } from './WorktreesTab';
import './git.css';

type TabId = 'changes' | 'history' | 'branches' | 'compare' | 'worktrees';

/** The commit name and e-mail, asked for once when git on the server has none. Kept per user, never written to the host's git settings. */
function IdentitySheet({ open, onDone }: { open: boolean; onDone: (saved: boolean) => void }) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const identity = useQuery({ queryKey: gitKeys.identity, queryFn: ({ signal }) => gitApi.identity(signal), staleTime: 5 * 60_000, enabled: open });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<{ name?: string; email?: string; form?: string }>({});
  const [saving, setSaving] = useState(false);
  const filled = useRef(false);

  useEffect(() => {
    if (!open) {
      filled.current = false;
      return;
    }
    if (filled.current || !identity.data) return;
    filled.current = true;
    setName(identity.data.name ?? user?.displayName ?? '');
    setEmail(identity.data.email ?? '');
    setErrors({});
  }, [open, identity.data, user]);

  const save = async () => {
    if (saving) return;
    const parsed = gitIdentitySchema.safeParse({ name, email });
    if (!parsed.success) {
      const found: typeof errors = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'name') found.name = t('git.identity.nameProblem');
        if (issue.path[0] === 'email') found.email = t('git.identity.emailProblem');
      }
      return setErrors(found);
    }
    setSaving(true);
    try {
      queryClient.setQueryData(gitKeys.identity, await gitApi.saveIdentity(parsed.data));
      toast.success(t('git.identity.saved'));
      onDone(true);
    } catch (error) {
      if (!wasCancelled(error)) setErrors({ form: problemOf(error, t).text });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => onDone(false)}
      title={t('git.identity.title')}
      dismissible={!saving}
      leading={
        <Button variant="plain" onClick={() => onDone(false)} disabled={saving}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={() => void save()} loading={saving}>
          {t('common.save')}
        </Button>
      }
    >
      <Form className="git-sheet" onSubmit={() => void save()}>
        <p className="git-sheet__lead">{t('git.identity.lead')}</p>
        {errors.form && (
          <Banner tone="danger" role="alert">
            {errors.form}
          </Banner>
        )}
        <TextField label={t('git.identity.name')} value={name} onChange={setName} error={errors.name} maxLength={100} autoComplete="name" enterKeyHint="next" data-autofocus="" />
        <TextField label={t('git.identity.email')} value={email} onChange={setEmail} error={errors.email} maxLength={200} type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" autoComplete="email" enterKeyHint="done" />
        <p className="pt-note git-sheet__note">{t('git.identity.note')}</p>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

const STATE_COPY = {
  none: { title: 'git.state.none.title', text: 'git.state.none.text' },
  nested: { title: 'git.state.nested.title', text: 'git.state.nested.text' },
  bare: { title: 'git.state.bare.title', text: 'git.state.bare.text' },
  untrusted: { title: 'git.state.untrusted.title', text: 'git.state.untrusted.text' },
  unavailable: { title: 'git.state.unavailable.title', text: 'git.state.unavailable.text' },
} as const;

/** One project's repository: what changed, the commit, branches, the remote, history — and honest words when there is no repository to speak of. */
function ProjectGit({ project, sessionId, request, onRequestHandled }: InspectorPanelProps & { project: Project }) {
  const t = useT();
  const user = useUser();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const writable = project.access === 'write';
  const [tab, setTab] = useState<TabId>('changes');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ problem: Problem; recovery: Recovery | null } | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const identityWaiter = useRef<((saved: boolean) => void) | null>(null);
  const running = useRef(false);

  const status = useQuery({ queryKey: gitKeys.status(project.id), queryFn: ({ signal }) => gitApi.status(project.id, signal), meta: { live: true }, staleTime: 5_000 });
  const staleness = useStaleness(status);

  // The repository changing — here, in a terminal's wake, on another device — arrives as an event; several at once are one re-read.
  const timer = useRef<number | null>(null);
  const reread = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: gitKeys.all(project.id) });
    }, 160);
  }, [queryClient, project.id]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  useProjectEvents(project.id, { onGit: reread, onFiles: reread, onReconnect: reread });

  useEffect(() => {
    if (!request) return;
    if (request.type === 'show-changes') setTab('changes');
    onRequestHandled();
    // Each request is handled once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const run = useCallback<GitScope['run']>(
    async <T,>(key: string, action: () => Promise<T>, options: RunOptions = {}) => {
      if (running.current) return { ok: false as const, problem: { text: t('git.busy') }, recovery: null };
      running.current = true;
      setBusy(key);
      if (!options.quiet) setProblem(null);
      try {
        const value = await action();
        if (options.done) toast.success(options.done);
        return { ok: true as const, value };
      } catch (error) {
        const found = problemOf(error, t);
        const recovery = found.code ? recoveryFor(found.code, options.operation ?? 'other') : null;
        if (!options.quiet && !wasCancelled(error)) setProblem({ problem: found, recovery });
        return { ok: false as const, problem: found, recovery };
      } finally {
        running.current = false;
        setBusy(null);
        // Whatever happened, what is on screen is read again: a refusal can leave things changed too (a fetch before a failed pull).
        void queryClient.invalidateQueries({ queryKey: gitKeys.all(project.id) });
      }
    },
    [queryClient, project.id, t],
  );

  const askIdentity = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        identityWaiter.current?.(false);
        identityWaiter.current = resolve;
        setIdentityOpen(true);
      }),
    [],
  );

  const scope = useMemo<GitScope>(
    () => ({
      project,
      writable,
      busy,
      run,
      report: (found) => setProblem(found ? { problem: found, recovery: null } : null),
      ask: (wanted) => void requestInspector(wanted, { project, sessionId, role: user?.role ?? 'member' }),
      askIdentity,
    }),
    [project, writable, busy, run, sessionId, user?.role, askIdentity],
  );

  // ---- sync ---------------------------------------------------------------------------

  const data = status.data;
  const offers = data ? syncOffers(data) : null;
  const fetchRemote = () => void run('fetch', () => gitApi.fetch(project.id), { done: t('git.sync.fetched') });
  const pull = async (mode: 'ff-only' | 'merge' = 'ff-only') => {
    if (!offers?.pull || !data?.branch) return;
    if (mode === 'merge') {
      const agreed = await confirm({ title: t('git.sync.pullMerge.title'), message: t('git.sync.pullMerge.message', { upstream: data.branch.upstream ?? '' }), confirmLabel: t('git.sync.pullMerge.confirm') });
      if (!agreed) return;
    } else if (offers.pull.count > 0) {
      const agreed = await confirm({ title: t.plural('git.sync.pull.title', offers.pull.count), message: t('git.sync.pull.message', { upstream: data.branch.upstream ?? '' }), confirmLabel: t('git.sync.pull') });
      if (!agreed) return;
    }
    const result = await run('pull', () => gitApi.pull(project.id, mode), { operation: 'pull' });
    if (result.ok) toast.success(result.value.summary.trim() === '' ? t('git.sync.pulled') : t('git.sync.pulledSummary', { summary: result.value.summary.split('\n')[0]! }));
  };
  const push = async (publish: boolean) => {
    if (!data?.branch || !offers?.remote) return;
    const branch = data.branch.name ?? '';
    const agreed = await confirm(
      publish
        ? { title: t('git.sync.publish.title', { branch }), message: t('git.sync.publish.message', { remote: offers.remote }), confirmLabel: t('git.sync.publish') }
        : { title: t.plural('git.sync.push.title', offers.push?.count ?? 0), message: t('git.sync.push.message', { upstream: data.branch.upstream ?? offers.remote }), confirmLabel: t('git.sync.push') },
    );
    if (!agreed) return;
    await run('push', () => gitApi.push(project.id, publish), { operation: 'push', done: publish ? t('git.sync.published', { branch }) : t('git.sync.pushed') });
  };
  const undo = async () => {
    const agreed = await confirm({ title: t('git.undo.title'), message: t('git.undo.message'), confirmLabel: t('git.undo.confirm'), tone: 'danger' });
    if (!agreed) return;
    const result = await run('undo', () => gitApi.undoCommit(project.id));
    if (result.ok) toast.success(t('git.undo.done', { oid: shortOid(result.value.undone) }));
  };

  const recoveryAction = (recovery: Recovery | null) => {
    if (recovery === 'pull-with-merge') return <Button size="sm" variant="neutral" onClick={() => void pull('merge')}>{t('git.sync.pullMerge')}</Button>;
    if (recovery === 'pull-first') return <Button size="sm" variant="neutral" onClick={() => void pull()}>{t('git.sync.pull')}</Button>;
    if (recovery === 'publish') return <Button size="sm" variant="neutral" onClick={() => void push(true)}>{t('git.sync.publish')}</Button>;
    if (recovery === 'set-identity') return <Button size="sm" variant="neutral" onClick={() => void askIdentity()}>{t('git.identity.set')}</Button>;
    return undefined;
  };

  const identitySheet = (
    <IdentitySheet
      open={identityOpen}
      onDone={(saved) => {
        setIdentityOpen(false);
        identityWaiter.current?.(saved);
        identityWaiter.current = null;
      }}
    />
  );

  // ---- states that are not a repository to work in -------------------------------------------

  if (status.isPending) {
    return (
      <div className="pt-panel">
        <LoadingRow label={t('git.loading')} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="pt-panel">
        <Stage>
          <ErrorState error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />
        </Stage>
      </div>
    );
  }
  if (data.state !== 'ready') {
    const copy = STATE_COPY[data.state];
    return (
      <div className="pt-panel">
        <Stage>
          <EmptyState
            icon={data.state === 'none' ? <GitBranch size={28} /> : <TriangleAlert size={28} />}
            title={t(copy.title)}
            description={
              <>
                {t(copy.text)}
                {data.message && (
                  <span className="git-says">
                    <span className="git-says__label">{t('git.state.serverSays')}</span>
                    <span>{data.message}</span>
                  </span>
                )}
              </>
            }
            action={
              <>
                {data.state === 'none' && writable && (
                  <Button variant="primary" loading={busy === 'init'} onClick={() => void run('init', () => gitApi.init(project.id), { done: t('git.state.none.done') })}>
                    {t('git.state.none.action')}
                  </Button>
                )}
                <Button variant="plain" onClick={() => void status.refetch()} loading={status.isFetching && busy === null}>
                  {t('git.state.recheck')}
                </Button>
              </>
            }
          />
        </Stage>
        {problem && <ProblemNote problem={problem.problem} onDismiss={() => setProblem(null)} />}
      </div>
    );
  }

  const branch = data.branch;
  const branchLabel = branch?.detached || !branch?.name ? t('git.branch.detached', { oid: shortOid(branch?.oid) }) : branch.name;
  const undoState = undoOffer(data);
  const tabs: { value: TabId; label: string; accessory?: ReactNode }[] = [
    { value: 'changes', label: t('git.tab.changes'), ...(changedFileCount(data) > 0 ? { accessory: <span className="git-tab-count">{t.number(changedFileCount(data))}</span> } : {}) },
    { value: 'history', label: t('git.tab.history') },
    { value: 'branches', label: t('git.tab.branches') },
    { value: 'compare', label: t('git.tab.compare') },
    ...(isOwner && writable ? [{ value: 'worktrees' as const, label: t('git.tab.worktrees') }] : []),
  ];
  const shown = tabs.some((entry) => entry.value === tab) ? tab : 'changes';

  return (
    <GitScopeProvider value={scope}>
      <div className="pt-panel git">
        <header className="pt-toolbar git__bar">
          <button type="button" className="git-branch-button" onClick={() => setTab('branches')} aria-label={t('git.branch.button', { branch: branchLabel })} title={branch?.upstream ? t('git.branch.tracks', { upstream: branch.upstream }) : t('git.branch.noUpstream')}>
            <GitBranch size={17} aria-hidden="true" />
            <span className="u-truncate">{branchLabel}</span>
            <AheadBehind ahead={branch?.ahead ?? null} behind={branch?.behind ?? null} />
          </button>
          <span className="pt-toolbar__spacer" />
          {offers?.fetch && writable && (
            <IconButton label={t('git.sync.fetch', { remote: offers.remote ?? '' })} icon={<RefreshCw size={18} />} tone="secondary" busy={busy === 'fetch'} disabled={busy !== null} onClick={fetchRemote} />
          )}
          {offers?.pull && writable && (
            <button type="button" className="git-sync" data-active={offers.pull.count > 0 || undefined} disabled={busy !== null} aria-busy={busy === 'pull' || undefined} onClick={() => void pull()} aria-label={t.plural('git.sync.pullLabel', offers.pull.count)}>
              <ArrowDownToLine size={18} aria-hidden="true" />
              {offers.pull.count > 0 && <span aria-hidden="true">{t.number(offers.pull.count)}</span>}
            </button>
          )}
          {offers?.push && writable && (
            <button type="button" className="git-sync" data-active={offers.push.count > 0 || undefined} disabled={busy !== null || offers.push.count === 0} aria-busy={busy === 'push' || undefined} onClick={() => void push(false)} aria-label={t.plural('git.sync.pushLabel', offers.push.count)}>
              <ArrowUpFromLine size={18} aria-hidden="true" />
              {offers.push.count > 0 && <span aria-hidden="true">{t.number(offers.push.count)}</span>}
            </button>
          )}
          {offers?.publish && writable && (
            <Button size="sm" variant="tinted" icon={<CloudUpload size={16} />} loading={busy === 'push'} disabled={busy !== null} onClick={() => void push(true)}>
              {t('git.sync.publish')}
            </Button>
          )}
          <MenuButton
            label={t('git.more')}
            icon={<Ellipsis size={20} />}
            items={[
              { id: 'refresh', label: t('git.refresh'), icon: <RefreshCw size={18} />, onSelect: () => void queryClient.invalidateQueries({ queryKey: gitKeys.all(project.id) }) },
              ...(writable
                ? [
                    { id: 'identity', label: t('git.identity.menu'), icon: <UserRound size={18} />, onSelect: () => void askIdentity() },
                    {
                      id: 'undo',
                      label: t('git.undo'),
                      hint: undoState.offered ? t('git.undo.hint') : undoState.reason === 'pushed' ? t('git.undo.pushed') : undoState.reason === 'detached' ? t('git.undo.detached') : t('git.undo.noCommits'),
                      icon: <Undo2 size={18} />,
                      disabled: !undoState.offered || busy !== null,
                      onSelect: () => void undo(),
                    },
                  ]
                : []),
            ]}
          />
        </header>
        <Tabs label={t('git.tab.label')} idBase="git-panel" value={shown} onChange={setTab} tabs={tabs} />

        <div className="pt-scroll" {...tabPanelProps('git-panel', shown)} tabIndex={-1}>
          {staleness.stale && <StaleNotice since={staleness.since} />}
          {offers?.remote === null && shown === 'changes' && data.hasCommits && <p className="pt-note">{t('git.sync.noRemote')}</p>}
          {data.operation && (
            <div className="pt-problem">
              <Banner tone="warning" title={t('git.operation.title', { operation: t(`git.operation.${data.operation}`) })}>
                {t('git.operation.text')}
              </Banner>
            </div>
          )}
          {problem && <ProblemNote problem={problem.problem} onDismiss={() => setProblem(null)} action={recoveryAction(problem.recovery)} />}
          {shown === 'changes' && <ChangesTab status={data} />}
          {shown === 'history' && <HistoryTab />}
          {shown === 'branches' && <BranchesTab status={data} />}
          {shown === 'compare' && <CompareTab />}
          {shown === 'worktrees' && <WorktreesTab />}
        </div>
      </div>
      {identitySheet}
    </GitScopeProvider>
  );
}

/** The inspector's Git panel. */
export default function GitPanel(props: InspectorPanelProps) {
  if (!props.project) return null;
  return <ProjectGit key={props.project.id} {...props} project={props.project} />;
}

/** For the badge on the panel's tab: how many files have uncommitted changes. */
export function countChanges(status: GitStatus | undefined): number {
  return status?.state === 'ready' ? changedFileCount(status) : 0;
}
