import type { GithubCheckRun, GithubMergeMethod, GithubMergeResult, GithubPullDetail } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, CircleDashed, CircleSlash, ExternalLink, GitMerge, GitPullRequest, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type Problem, ProblemNote, problemOf, wasCancelled } from '@/features/projects/tools/kit';
import { hasMessage, useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import { Badge, Banner, Button, ErrorState, IconButton, List, ListRow, LoadingRow, Sheet, StaleNotice, Switch, confirm, toast } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { type PullRef, githubApi, githubKeys } from './api';
import { type MergeChoice, acknowledged, blockerKey, checkTone, checksLabel, mayMerge, mergeConfirmation, mergeGuard, mergeRequest, methodHintKey, methodKey, rememberMethod, rememberedMethod, shortSha } from './merge';
import './github.css';

const FILE_KIND: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added' };

function CheckRow({ run }: { run: GithubCheckRun }) {
  const t = useT();
  const Icon = run.state === 'passing' ? Check : run.state === 'failing' ? X : run.state === 'pending' ? CircleDashed : CircleSlash;
  return (
    <li className="gh-check" data-state={run.state}>
      <span className="gh-check__icon" aria-hidden="true">
        <Icon size={15} />
      </span>
      <span className="gh-check__text">
        <span className="gh-check__name">{run.name}</span>
        <span className="gh-check__meta">
          {t(`github.check.${run.state}`)}
          {run.workflow && run.workflow !== run.name ? ` · ${run.workflow}` : ''}
        </span>
      </span>
      {run.required && <Badge>{t('github.check.required')}</Badge>}
      {run.url && (
        <a className="gh-icon-link" href={run.url} target="_blank" rel="noopener noreferrer" aria-label={t('github.check.log', { name: run.name })}>
          <ExternalLink size={16} aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export interface PullSheetProps {
  /** The pull request to show; null closes the sheet. */
  pull: PullRef | null;
  onClose: () => void;
}

type Step = 'detail' | 'merge' | 'done';

/**
 * One pull request: what it is, whether its checks pass, what it changes, and
 * whether it can be merged from here. Merging is guarded three times — the
 * control is absent while anything blocks, the last question names exactly
 * what will be merged, and the server decides again on a fresh read and may
 * still refuse, in which case its reason is shown as it gave it.
 */
export function PullSheet({ pull, onClose }: PullSheetProps) {
  const t = useT();
  const visible = usePageVisible();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<PullRef | null>(pull);
  if (pull && (shown === null || pull.owner !== shown.owner || pull.repo !== shown.repo || pull.number !== shown.number)) setShown(pull);
  const open = pull !== null;

  const [step, setStep] = useState<Step>('detail');
  const [choice, setChoice] = useState<MergeChoice>({ method: null, deleteBranch: false, acknowledgedHead: null });
  const [working, setWorking] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ problem: Problem; unknown: boolean } | null>(null);
  const [result, setResult] = useState<GithubMergeResult | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);

  const key = shown ? `${shown.owner}/${shown.repo}#${shown.number}` : '';
  useEffect(() => {
    setStep('detail');
    setRefusal(null);
    setResult(null);
    setShowAllFiles(false);
    setChoice({ method: null, deleteBranch: false, acknowledgedHead: null });
  }, [key]);

  const detail = useQuery({
    queryKey: shown ? githubKeys.pull(shown) : ['github', 'pull', 'none'],
    queryFn: ({ signal }) => githubApi.pull(shown!, false, signal),
    enabled: open && shown !== null,
    retry: false,
    staleTime: 10_000,
    // While checks run or mergeability is being worked out the server says when to look again; hidden or closed, nobody looks.
    refetchInterval: (query) => (open && visible && step === 'detail' && working === null ? (query.state.data?.pollAfterMs ?? false) : false),
  });
  const data = detail.data;

  const reload = async () => {
    if (!shown) return;
    try {
      queryClient.setQueryData(githubKeys.pull(shown), await githubApi.pull(shown, true));
    } catch {
      void detail.refetch();
    }
  };

  const afterChange = () => {
    void queryClient.invalidateQueries({ queryKey: githubKeys.all, predicate: (query) => query.queryKey[1] !== 'pull' });
  };

  if (!shown) return null;
  const guard = data ? mergeGuard(data) : null;
  const busy = working !== null;

  // ---- the small fixes, each behind its own question ------------------------------------------

  const fix = async (id: string, question: Parameters<typeof confirm>[0], action: () => Promise<{ message: string; pull: GithubPullDetail }>) => {
    if (!(await confirm(question))) return;
    setWorking(id);
    setRefusal(null);
    try {
      const done = await action();
      queryClient.setQueryData(githubKeys.pull(shown), done.pull);
      toast.success(done.message);
      afterChange();
    } catch (error) {
      if (!wasCancelled(error)) setRefusal({ problem: problemOf(error, t), unknown: problemOf(error, t).code === 'github_outcome_unknown' });
    } finally {
      setWorking(null);
    }
  };

  const merge = async () => {
    if (!data || !guard || choice.method === null || !mayMerge(guard, choice, data.headSha)) return;
    const method = choice.method;
    const question = mergeConfirmation(data, method, { deleteBranch: guard.mayDeleteBranch && choice.deleteBranch, queued: guard.queued }, t);
    if (!(await confirm({ ...question, tone: 'danger' }))) return;
    setWorking('merge');
    setRefusal(null);
    try {
      const merged = await githubApi.merge(shown, mergeRequest(data, guard, { ...choice, method }));
      rememberMethod(shown.owner, shown.repo, method);
      setResult(merged);
      setStep('done');
      toast.success(merged.outcome === 'queued' ? t('github.merge.queuedToast', { number: shown.number }) : t('github.merge.mergedToast', { number: shown.number }));
      afterChange();
      void detail.refetch();
    } catch (error) {
      if (wasCancelled(error)) return;
      const problem = problemOf(error, t);
      setRefusal({ problem, unknown: problem.code === 'github_outcome_unknown' || problem.code === 'timeout' || problem.code === 'network_error' });
    } finally {
      setWorking(null);
    }
  };

  const startMerge = () => {
    if (!data || !guard) return;
    setChoice({ method: rememberedMethod(shown.owner, shown.repo, guard.methods), deleteBranch: false, acknowledgedHead: null });
    setRefusal(null);
    setStep('merge');
  };

  const files = data ? (showAllFiles ? data.files : data.files.slice(0, 8)) : [];
  const title = `${shown.owner}/${shown.repo} #${shown.number}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      fill
      dismissible={!busy}
      leading={
        step === 'merge' ? (
          <IconButton label={t('github.merge.back')} icon={<ArrowLeft size={21} />} disabled={busy} onClick={() => setStep('detail')} />
        ) : undefined
      }
      trailing={
        <>
          {data && (
            <a className="gh-icon-link" href={data.url} target="_blank" rel="noopener noreferrer" aria-label={t('github.openOnGithub')} title={t('github.openOnGithub')}>
              <ExternalLink size={19} aria-hidden="true" />
            </a>
          )}
          <IconButton label={t('github.refresh')} icon={<RefreshCw size={19} />} busy={detail.isFetching} disabled={busy} onClick={() => void reload()} />
          <IconButton label={t('common.close')} icon={<X size={21} />} disabled={busy} onClick={onClose} />
        </>
      }
      footer={
        data && guard && step === 'detail' ? (
          guard.offered ? (
            <Button variant="primary" block icon={<GitMerge size={18} />} disabled={busy} onClick={startMerge}>
              {t('github.merge.start')}
            </Button>
          ) : (
            // Something blocks the merge: there is no merge control to press — only the reason, above.
            <p className="gh-footer-note" role="status">
              {data.state === 'merged' ? t('github.blocked.merged') : data.state === 'closed' ? t('github.blocked.closed') : t.plural('github.blocked.summary', guard.blockers.length)}
            </p>
          )
        ) : data && guard && step === 'merge' ? (
          <Button variant="primary" block icon={<GitMerge size={18} />} loading={working === 'merge'} disabled={busy || !mayMerge(guard, choice, data.headSha)} onClick={() => void merge()}>
            {t('github.merge.action', { number: shown.number })}
          </Button>
        ) : step === 'done' ? (
          <Button variant="primary" block onClick={onClose}>
            {t('common.done')}
          </Button>
        ) : undefined
      }
    >
      <div className="gh-pull">
        {detail.isPending ? (
          <LoadingRow label={t('github.pull.loading')} />
        ) : !data ? (
          <ErrorState compact error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
        ) : step === 'done' && result ? (
          <div className="gh-done">
            <span className="gh-done__mark" aria-hidden="true">
              <GitMerge size={28} />
            </span>
            <p className="gh-done__title">{result.outcome === 'queued' ? t('github.merge.queued') : t('github.merge.merged')}</p>
            <p className="gh-done__text">{result.message}</p>
            {result.mergeCommit && <p className="gh-done__text u-mono">{shortSha(result.mergeCommit)}</p>}
            {result.branchDeleted !== null && <p className="gh-done__text">{result.branchDeleted ? t('github.merge.branchDeleted', { head: data.headRef }) : t('github.merge.branchKept', { head: data.headRef })}</p>}
          </div>
        ) : (
          <>
            {data.freshness.stale && <StaleNotice since={data.freshness.fetchedAt} {...(data.freshness.staleReason ? { reason: data.freshness.staleReason } : {})} />}
            {detail.isError && <ProblemNote problem={problemOf(detail.error, t)} title={t('github.refreshFailed')} />}
            {refusal && (
              <ProblemNote
                problem={refusal.problem}
                title={refusal.unknown ? t('github.merge.unknown') : step === 'merge' ? t('github.merge.refused') : t('github.fix.refused')}
                onDismiss={() => setRefusal(null)}
                action={
                  <Button
                    size="sm"
                    variant="neutral"
                    onClick={() => {
                      setRefusal(null);
                      setStep('detail');
                      void reload();
                    }}
                  >
                    {t('github.reload')}
                  </Button>
                }
              />
            )}

            <header className="gh-pull__head">
              <p className="gh-pull__title">
                <GitPullRequest size={18} aria-hidden="true" />
                <span>{data.title}</span>
              </p>
              <p className="gh-pull__meta">
                {data.author ? t('github.pull.by', { author: data.author }) : t('github.pull.byUnknown')} · {t('github.pull.updated', { when: t.relative(data.updatedAt) })}
              </p>
              <p className="gh-pull__branches">
                <span className="pt-pill u-mono">
                  <span>{data.headRef}</span>
                </span>
                <span aria-hidden="true">→</span>
                <span className="visually-hidden">{t('github.pull.into')}</span>
                <span className="pt-pill u-mono">
                  <span>{data.baseRef}</span>
                </span>
                <span className="u-mono gh-pull__sha">{shortSha(data.headSha)}</span>
                {data.draft && <Badge>{t('github.verdict.draft')}</Badge>}
                {data.state !== 'open' && <Badge tone={data.state === 'merged' ? 'positive' : 'neutral'}>{t(`github.state.${data.state}`)}</Badge>}
              </p>
            </header>

            {step === 'merge' && guard ? (
              <div className="gh-merge">
                <fieldset className="gh-methods">
                  <legend>{t('github.merge.method')}</legend>
                  {guard.methods.map((method: GithubMergeMethod) => (
                    <label key={method} className="gh-method" data-checked={choice.method === method || undefined}>
                      <input type="radio" name="merge-method" checked={choice.method === method} disabled={busy} onChange={() => setChoice((current) => ({ ...current, method }))} />
                      <span className="gh-method__text">
                        <span className="gh-method__name">{t(methodKey(method))}</span>
                        <span className="gh-method__hint">{t(methodHintKey(method))}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <List>
                  {guard.mayDeleteBranch && (
                    <ListRow
                      title={t('github.merge.deleteBranch', { head: data.headRef })}
                      control={<Switch checked={choice.deleteBranch} disabled={busy} onChange={(deleteBranch) => setChoice((current) => ({ ...current, deleteBranch }))} />}
                    />
                  )}
                  {guard.needsAcknowledgement && (
                    <ListRow
                      title={t('github.merge.acknowledge')}
                      subtitle={t('github.merge.acknowledgeHint')}
                      control={
                        <Switch
                          checked={acknowledged(choice, data.headSha)}
                          disabled={busy}
                          onChange={(on) => setChoice((current) => ({ ...current, acknowledgedHead: on ? data.headSha : null }))}
                        />
                      }
                    />
                  )}
                </List>
                {data.deleteBranchOnMerge && <p className="pt-note">{t('github.merge.autoDelete')}</p>}
                {guard.queued && <p className="pt-note">{t('github.merge.queueNote')}</p>}
                {data.checks.pending > 0 && <p className="pt-note">{t('github.merge.pendingNote')}</p>}
              </div>
            ) : (
              <>
                {guard && guard.blockers.length > 0 && (
                  <section className="gh-blockers" aria-label={t('github.blocked.title')}>
                    <Banner tone="warning" title={t('github.blocked.title')}>
                      <ul>
                        {guard.blockers.map((blocker) => (
                          // The server's own sentence says the same thing in English only; it is kept for a reason this client has no words for.
                          <li key={blocker.code}>{hasMessage(blockerKey(blocker.code)) ? t(blockerKey(blocker.code)) : blocker.message}</li>
                        ))}
                      </ul>
                    </Banner>
                  </section>
                )}

                {(data.fixes.updateBranch || data.fixes.markReady || data.fixes.approveRuns) && (
                  <List header={t('github.fix.title')} footer={t('github.fix.footer')}>
                    {data.fixes.updateBranch && (
                      <ListRow
                        title={t('github.fix.updateBranch')}
                        subtitle={t('github.fix.updateBranchHint', { base: data.baseRef, head: data.headRef })}
                        tone="accent"
                        disabled={busy}
                        onPress={() =>
                          void fix(
                            'update',
                            { title: t('github.fix.updateBranch.title', { number: data.number }), message: t('github.fix.updateBranch.message', { base: data.baseRef, head: data.headRef, sha: shortSha(data.headSha) }), confirmLabel: t('github.fix.updateBranch') },
                            () => githubApi.updateBranch(shown, data.headSha),
                          )
                        }
                      />
                    )}
                    {data.fixes.markReady && (
                      <ListRow
                        title={t('github.fix.markReady')}
                        subtitle={t('github.fix.markReadyHint')}
                        tone="accent"
                        disabled={busy}
                        onPress={() => void fix('ready', { title: t('github.fix.markReady.title', { number: data.number }), message: t('github.fix.markReady.message'), confirmLabel: t('github.fix.markReady') }, () => githubApi.markReady(shown))}
                      />
                    )}
                    {data.fixes.approveRuns && data.pendingRuns.length > 0 && (
                      <ListRow
                        title={t.plural('github.fix.approveRuns', data.pendingRuns.length)}
                        subtitle={t('github.fix.approveRunsHint')}
                        tone="danger"
                        disabled={busy}
                        onPress={() =>
                          void fix(
                            'approve',
                            {
                              title: t.plural('github.fix.approveRuns.title', data.pendingRuns.length),
                              message: `${t('github.fix.approveRuns.message')} ${t.list(data.pendingRuns.map((run) => run.name))}`,
                              confirmLabel: t('github.fix.approveRuns.confirm'),
                              tone: 'danger',
                            },
                            () => githubApi.approveRuns(shown, data.pendingRuns.map((run) => run.id)),
                          )
                        }
                      />
                    )}
                  </List>
                )}

                <List header={t('github.pull.facts')}>
                  <ListRow title={t('github.pull.checks')} value={checksLabel(data.checks, t)} leading={<span className="pt-dot" data-tone={checkTone(data.checks.state)} />} />
                  <ListRow title={t('github.pull.review')} value={data.reviewDecision ? t(`github.review.${data.reviewDecision}`) : t('github.review.none')} />
                  <ListRow title={t('github.pull.changes')} value={`+${t.number(data.additions)} −${t.number(data.deletions)} · ${t.plural('github.pull.files', data.changedFiles)}`} />
                  <ListRow title={t('github.pull.mergeable')} value={t(`github.mergeable.${data.mergeable}`)} />
                </List>

                {data.checkRuns.length > 0 && (
                  <section className="gh-section" aria-label={t('github.pull.checks')}>
                    <h3 className="pt-section">
                      <span>{t('github.pull.checks')}</span>
                    </h3>
                    <ul className="gh-checks">
                      {data.checkRuns.map((run, index) => (
                        <CheckRow key={`${run.name}:${index}`} run={run} />
                      ))}
                    </ul>
                    {data.checkRunsTruncated && <p className="pt-note">{t('github.pull.checksTruncated')}</p>}
                  </section>
                )}

                {data.files.length > 0 && (
                  <section className="gh-section" aria-label={t('github.pull.changedFiles')}>
                    <h3 className="pt-section">
                      <span>{t('github.pull.changedFiles')}</span>
                    </h3>
                    <ul className="gh-files">
                      {files.map((file) => (
                        <li key={file.path} className="gh-file">
                          <span className="pt-letter" data-kind={FILE_KIND[file.status]} aria-hidden="true">
                            {file.status}
                          </span>
                          <span className="gh-file__path u-mono">{file.path}</span>
                          <span className="gh-file__counts">
                            +{t.number(file.additions)} −{t.number(file.deletions)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {data.files.length > 8 && !showAllFiles && (
                      <div className="gh-more">
                        <Button size="sm" variant="plain" onClick={() => setShowAllFiles(true)}>
                          {t('github.pull.showAllFiles', { count: t.number(data.files.length) })}
                        </Button>
                      </div>
                    )}
                    {data.filesTruncated && <p className="pt-note">{t('github.pull.filesTruncated')}</p>}
                  </section>
                )}

                {data.body.trim() !== '' && (
                  <section className="gh-section gh-body" aria-label={t('github.pull.description')}>
                    <h3 className="pt-section">
                      <span>{t('github.pull.description')}</span>
                    </h3>
                    <div className="gh-body__text">
                      {/* Written by whoever opened the pull request: rendered as untrusted text, never as HTML. */}
                      <Markdown compact>{data.body}</Markdown>
                    </div>
                    {data.bodyTruncated && <p className="pt-note">{t('github.pull.descriptionTruncated')}</p>}
                  </section>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
