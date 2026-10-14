import { GITHUB_CHANGED, type GithubAccount, type GithubActionLogEntry, type GithubInboxFilter, type GithubPullSummary, type GithubRepository, githubInboxFilterSchema, userTopic } from '@agent-studio/protocol';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, BookMarked, Copy, ExternalLink, GitFork, GitMerge, GitPullRequest, GitPullRequestDraft, Lock, RefreshCw, ShieldAlert } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate, useNavigationType, useParams } from 'react-router';
import { useRealtimeTopic } from '@/data/realtime';
import { useIsOwner, useUser } from '@/data/session';
import { ProblemNote, problemOf } from '@/features/projects/tools/kit';
import { useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { usePageVisible } from '@/platform/media';
import { Screen } from '@/shell/Screen';
import { ScreenStack, useRouteTransition, useScreenActive } from '@/shell/ScreenStack';
import { isSystemGesturePop } from '@/shell/back';
import { Badge, Banner, Button, DelayedSkeleton, EmptyState, ErrorState, IconButton, List, ListRow, SegmentedControl, Skeleton, StaleNotice, Tabs, progress, tabPanelProps, toast } from '@/ui';
import { type PullRef, githubApi, githubKeys } from './api';
import { PullSheet } from './PullSheet';
import { checkTone, checksLabel, shortSha, summaryVerdict, verdictKey, verdictTone } from './merge';
import './github.css';

type HomeTab = 'pulls' | 'repositories' | 'activity';

const TAB_KEY = 'studio.github.tab';
const FILTER_KEY = 'studio.github.filter';
function remembered<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const stored = window.localStorage.getItem(key);
    return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* this device will not remember */
  }
}

/** A freshness line: "Updated 2 minutes ago", re-worded as time passes. */
function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}

export function PullRow({ pull, onOpen, showRepository }: { pull: GithubPullSummary; onOpen: (ref: PullRef) => void; showRepository?: boolean }) {
  const t = useT();
  const verdict = summaryVerdict(pull);
  const Icon = pull.draft ? GitPullRequestDraft : GitPullRequest;
  return (
    <button type="button" className="gh-row" onClick={() => onOpen({ owner: pull.owner, repo: pull.repo, number: pull.number })} aria-haspopup="dialog">
      <span className="gh-row__mark" data-tone={verdictTone(verdict)} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="gh-row__text">
        <span className="gh-row__title">{pull.title}</span>
        <span className="gh-row__meta">
          {showRepository && (
            <span className="u-truncate">
              {pull.owner}/{pull.repo}
            </span>
          )}
          <span>#{pull.number}</span>
          {pull.author && <span className="u-truncate">{pull.author}</span>}
          <span className="u-truncate u-mono gh-row__branches">
            {pull.headRef} → {pull.baseRef}
          </span>
        </span>
        <span className="gh-row__meta">
          <span className="gh-row__state">
            <span className="pt-dot" data-tone={verdictTone(verdict)} />
            {t(verdictKey(verdict))}
          </span>
          <span>{checksLabel(pull.checks, t)}</span>
          <span className="u-tabular">
            +{t.number(pull.additions)} −{t.number(pull.deletions)}
          </span>
          <span>{t.relative(pull.updatedAt)}</span>
        </span>
      </span>
    </button>
  );
}

function AccountSetup({ account, onRecheck, checking }: { account: GithubAccount; onRecheck: () => void; checking: boolean }) {
  const t = useT();
  const state = account.state as Exclude<GithubAccount['state'], 'ready' | 'limited'>;
  return (
    <div className="gh-setup">
      <EmptyState
        icon={<ShieldAlert size={28} />}
        title={t(`github.account.${state}.title`)}
        description={
          <>
            {t(`github.account.${state}.text`)}
            {/* For every other state the server's sentence says what the words above say; only an unexpected failure carries the tool's own reason. */}
            {state === 'error' && (
              <span className="gh-says">
                <span className="gh-says__label">{t('github.account.serverSays')}</span>
                <span>{account.message}</span>
              </span>
            )}
          </>
        }
        action={
          <>
            <Button variant="primary" icon={<RefreshCw size={18} />} loading={checking} onClick={onRecheck}>
              {t('github.account.recheck')}
            </Button>
            <span className="gh-setup__age">{t('github.account.checked', { when: t.relative(account.checkedAt) })}</span>
          </>
        }
      />
      {account.command && (
        <details className="gh-howto">
          <summary>{t('github.account.howTo')}</summary>
          <p>{t('github.account.howToText')}</p>
          <div className="gh-command">
            <code>{account.command}</code>
            <IconButton label={t('github.account.copyCommand')} icon={<Copy size={18} />} tone="secondary" onClick={() => void copyText(account.command!).then((copied) => copied && toast.success(t('common.copied')))} />
          </div>
          <p>{t('github.account.tokenNote')}</p>
        </details>
      )}
    </div>
  );
}

function ListSkeleton() {
  const t = useT();
  return (
    <DelayedSkeleton label={t('common.loading')}>
      <List>
        {[0, 1, 2].map((index) => (
          <ListRow key={index} leading={<Skeleton width={30} height={30} radius={9} />} title={<Skeleton width="55%" height={12} />} subtitle={<Skeleton width="80%" height={10} />} />
        ))}
      </List>
    </DelayedSkeleton>
  );
}

// ---- pull requests ---------------------------------------------------------------------

function Inbox({ onOpen, onRepository }: { onOpen: (ref: PullRef) => void; onRepository: (owner: string, repo: string) => void }) {
  const t = useT();
  const active = useScreenActive();
  const [filter, setFilter] = useState<GithubInboxFilter>(() => remembered(FILTER_KEY, githubInboxFilterSchema.options, 'all'));
  const inbox = useQuery({ queryKey: githubKeys.inbox(filter), queryFn: ({ signal }) => githubApi.inbox(filter, false, signal), enabled: active, staleTime: 30_000, retry: false, placeholderData: (previous) => previous });
  const counts = inbox.data?.counts;
  const groups = useMemo(() => {
    const byRepository = new Map<string, GithubPullSummary[]>();
    for (const pull of inbox.data?.pulls ?? []) {
      const key = `${pull.owner}/${pull.repo}`;
      const list = byRepository.get(key) ?? [];
      list.push(pull);
      byRepository.set(key, list);
    }
    return [...byRepository.entries()];
  }, [inbox.data]);

  const label = (text: string, count: number | undefined) => (count === undefined ? text : `${text} ${t.number(count)}`);

  return (
    <>
      <div className="gh-filter">
        <SegmentedControl
          label={t('github.inbox.filter')}
          value={filter}
          onChange={(next) => {
            setFilter(next);
            remember(FILTER_KEY, next);
          }}
          options={[
            { value: 'all', label: label(t('github.inbox.all'), counts?.all) },
            { value: 'review_requested', label: label(t('github.inbox.review'), counts?.reviewRequested) },
            { value: 'authored', label: label(t('github.inbox.mine'), counts?.authored) },
            { value: 'own_repositories', label: label(t('github.inbox.own'), counts?.ownRepositories) },
          ]}
        />
        {/* The segments are a word each so that four fit a phone; the sentence says what the chosen one holds. */}
        <p className="gh-filter__about">{t(`github.inbox.about.${filter}`)}</p>
      </div>
      {inbox.isPending ? (
        <ListSkeleton />
      ) : !inbox.data ? (
        <ErrorState error={inbox.error} title={t('github.unreadable')} onRetry={() => void inbox.refetch()} retrying={inbox.isFetching} />
      ) : (
        <>
          {inbox.isError && (
            <ProblemNote
              problem={problemOf(inbox.error, t)}
              title={t('github.unreadable')}
              action={
                <Button size="sm" variant="plain" onClick={() => void inbox.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          )}
          {inbox.data.freshness.stale && <StaleNotice since={inbox.data.freshness.fetchedAt} {...(inbox.data.freshness.staleReason ? { reason: inbox.data.freshness.staleReason } : {})} />}
          {groups.length === 0 ? (
            <EmptyState icon={<GitPullRequest size={28} />} title={t(`github.inbox.empty.${filter}`)} description={t('github.inbox.emptyHint')} />
          ) : (
            groups.map(([repository, pulls]) => {
              const [owner, repo] = repository.split('/') as [string, string];
              return (
                <section key={repository} className="gh-group" aria-label={repository}>
                  <h2 className="gh-group__title">
                    <button type="button" onClick={() => onRepository(owner, repo)}>
                      <BookMarked size={15} aria-hidden="true" />
                      <span className="u-truncate">{repository}</span>
                    </button>
                    <span className="gh-group__count">{t.number(pulls.length)}</span>
                  </h2>
                  <div className="gh-card">
                    {pulls.map((pull) => (
                      <PullRow key={pull.number} pull={pull} onOpen={onOpen} />
                    ))}
                  </div>
                </section>
              );
            })
          )}
          {inbox.data.truncated && <p className="ui-list__footer">{t('github.inbox.truncated')}</p>}
        </>
      )}
    </>
  );
}

// ---- repositories ----------------------------------------------------------------------

function RepositoryBadges({ repository }: { repository: GithubRepository }) {
  const t = useT();
  return (
    <>
      {repository.private && (
        <span className="pt-pill">
          <Lock size={11} aria-hidden="true" />
          {t('github.repo.private')}
        </span>
      )}
      {repository.fork && (
        <span className="pt-pill">
          <GitFork size={11} aria-hidden="true" />
          {t('github.repo.fork')}
        </span>
      )}
      {repository.archived && (
        <span className="pt-pill" data-tone="warning">
          <Archive size={11} aria-hidden="true" />
          {t('github.repo.archived')}
        </span>
      )}
    </>
  );
}

function Repositories({ onRepository }: { onRepository: (owner: string, repo: string) => void }) {
  const t = useT();
  const active = useScreenActive();
  const list = useInfiniteQuery({
    queryKey: githubKeys.repositories,
    queryFn: ({ pageParam, signal }) => githubApi.repositories(pageParam, false, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: active,
    staleTime: 30_000,
    retry: false,
  });
  if (list.isPending) return <ListSkeleton />;
  if (!list.data) return <ErrorState error={list.error} title={t('github.unreadable')} onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  const repositories = list.data.pages.flatMap((page) => page.repositories);
  const first = list.data.pages[0]!;
  if (repositories.length === 0) return <EmptyState icon={<BookMarked size={28} />} title={t('github.repo.none')} />;
  return (
    <>
      {list.isError && <ProblemNote problem={problemOf(list.error, t)} title={t('github.unreadable')} />}
      {first.freshness.stale && <StaleNotice since={first.freshness.fetchedAt} {...(first.freshness.staleReason ? { reason: first.freshness.staleReason } : {})} />}
      <div className="gh-card">
        {repositories.map((repository) => (
          <button key={`${repository.owner}/${repository.name}`} type="button" className="gh-row" onClick={() => onRepository(repository.owner, repository.name)}>
            <span className="gh-row__mark" data-tone={checkTone(repository.checks)} aria-hidden="true">
              <BookMarked size={18} />
            </span>
            <span className="gh-row__text">
              <span className="gh-row__title gh-row__title--name">
                <span className="u-truncate">{repository.name}</span>
                <RepositoryBadges repository={repository} />
              </span>
              {repository.description && <span className="gh-row__description">{repository.description}</span>}
              <span className="gh-row__meta">
                {repository.language && <span>{repository.language}</span>}
                {repository.defaultBranch && <span className="u-mono u-truncate">{repository.defaultBranch}</span>}
                {repository.openPullRequests > 0 && <span>{t.plural('github.repo.pulls', repository.openPullRequests)}</span>}
                {repository.openIssues > 0 && <span>{t.plural('github.repo.issues', repository.openIssues)}</span>}
                {repository.pushedAt !== null && <span>{t('github.repo.pushed', { when: t.relative(repository.pushedAt) })}</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
      {list.hasNextPage ? (
        <div className="gh-more">
          <Button variant="neutral" size="sm" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {t('github.repo.more', { shown: t.number(repositories.length), total: t.number(first.totalCount) })}
          </Button>
        </div>
      ) : (
        <p className="ui-list__footer">{t.plural('github.repo.count', repositories.length)}</p>
      )}
    </>
  );
}

// ---- what was attempted ----------------------------------------------------------------

const OUTCOME_TONE: Record<GithubActionLogEntry['outcome'], 'positive' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  started: 'info',
  merged: 'positive',
  queued: 'positive',
  done: 'positive',
  refused: 'warning',
  failed: 'danger',
  unknown: 'warning',
  invalid: 'neutral',
};

function Activity({ onOpen }: { onOpen: (ref: PullRef) => void }) {
  const t = useT();
  const active = useScreenActive();
  const log = useQuery({ queryKey: githubKeys.actions, queryFn: ({ signal }) => githubApi.actions(signal), enabled: active, staleTime: 10_000, retry: false });
  if (log.isPending) return <ListSkeleton />;
  if (!log.data) return <ErrorState error={log.error} onRetry={() => void log.refetch()} retrying={log.isFetching} />;
  if (log.data.length === 0) return <EmptyState icon={<GitMerge size={28} />} title={t('github.log.empty')} description={t('github.log.emptyHint')} />;
  return (
    <List footer={t('github.log.footer')}>
      {log.data.map((entry) => (
        <ListRow
          key={entry.id}
          title={
            <span className="gh-log__title">
              <span>{t(`github.action.${entry.action}`)}</span>
              <span className="u-truncate">
                {entry.owner}/{entry.repo}
                {entry.number !== null ? ` #${entry.number}` : ''}
              </span>
            </span>
          }
          subtitle={
            <>
              {entry.message}
              <span className="gh-log__meta">
                {[entry.method ? t(`github.method.${entry.method}`) : null, entry.headSha ? shortSha(entry.headSha) : null, t.relative(entry.at)].filter(Boolean).join(' · ')}
              </span>
            </>
          }
          trailing={<Badge tone={OUTCOME_TONE[entry.outcome]}>{t(`github.outcome.${entry.outcome}`)}</Badge>}
          {...(entry.number !== null ? { onPress: () => onOpen({ owner: entry.owner, repo: entry.repo, number: entry.number! }) } : {})}
        />
      ))}
    </List>
  );
}

// ---- one repository --------------------------------------------------------------------

function RepositoryScreen({ owner, repo, onOpen }: { owner: string; repo: string; onOpen: (ref: PullRef) => void }) {
  const t = useT();
  const active = useScreenActive();
  const page = useQuery({ queryKey: githubKeys.repository(owner, repo), queryFn: ({ signal }) => githubApi.repository(owner, repo, false, signal), enabled: active, staleTime: 30_000, retry: false });
  const refresh = () => void progress.track(githubApi.repository(owner, repo, true).then((data) => page.refetch().then(() => data)));
  const data = page.data;
  return (
    <Screen
      title={repo}
      caption={owner}
      parent={{ to: '/github', label: t('github.title') }}
      actions={<IconButton label={t('github.refresh')} icon={<RefreshCw size={20} />} busy={page.isFetching} onClick={refresh} />}
    >
      {page.isPending ? (
        <ListSkeleton />
      ) : !data ? (
        <ErrorState error={page.error} title={t('github.unreadable')} onRetry={() => void page.refetch()} retrying={page.isFetching} />
      ) : (
        <>
          {page.isError && <ProblemNote problem={problemOf(page.error, t)} title={t('github.unreadable')} />}
          {data.freshness.stale && <StaleNotice since={data.freshness.fetchedAt} {...(data.freshness.staleReason ? { reason: data.freshness.staleReason } : {})} />}
          <div className="gh-repo">
            {data.repository.description && <p className="gh-repo__description">{data.repository.description}</p>}
            <p className="gh-repo__badges">
              <span className="pt-pill">{data.repository.private ? t('github.repo.private') : t('github.repo.public')}</span>
              <RepositoryBadges repository={{ ...data.repository, private: false }} />
              {!data.canWrite && (
                <span className="pt-pill" data-tone="warning">
                  {t('github.repo.readOnly')}
                </span>
              )}
            </p>
            <a className="gh-link" href={data.repository.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              {t('github.openOnGithub')}
            </a>
          </div>
          <List header={t('github.repo.facts')}>
            <ListRow title={t('github.repo.defaultBranch')} value={<span className="u-mono">{data.repository.defaultBranch ?? '—'}</span>} />
            {data.repository.pushedAt !== null && <ListRow title={t('github.repo.lastPush')} value={t.relative(data.repository.pushedAt)} />}
            {data.latestCommit && (
              <ListRow
                leading={<span className="pt-dot" data-tone={checkTone(data.latestCommit.checks.state)} />}
                title={data.latestCommit.title}
                subtitle={
                  <>
                    <span className="u-mono">{shortSha(data.latestCommit.oid)}</span> · {data.latestCommit.author ?? t('github.pull.byUnknown')} · {t.relative(data.latestCommit.committedAt)} · {checksLabel(data.latestCommit.checks, t)}
                  </>
                }
              />
            )}
          </List>
          <section className="gh-group" aria-label={t('github.repo.openPulls')}>
            <h2 className="gh-group__title">
              <span>{t('github.repo.openPulls')}</span>
              <span className="gh-group__count">{t.number(data.pullCount)}</span>
            </h2>
            {data.pulls.length === 0 ? (
              <p className="ui-list__footer">{t('github.repo.noPulls')}</p>
            ) : (
              <div className="gh-card">
                {data.pulls.map((pull) => (
                  <PullRow key={pull.number} pull={pull} onOpen={onOpen} />
                ))}
              </div>
            )}
            {data.pullCount > data.pulls.length && <p className="ui-list__footer">{t('github.repo.pullsTruncated', { shown: t.number(data.pulls.length), total: t.number(data.pullCount) })}</p>}
          </section>
          {data.recentMerges.length > 0 && (
            <List header={t('github.repo.recentMerges')}>
              {data.recentMerges.map((merge) => (
                <ListRow
                  key={merge.number}
                  leading={<GitMerge size={20} />}
                  title={merge.title}
                  subtitle={`#${merge.number} · ${merge.author ?? t('github.pull.byUnknown')} · ${t.relative(merge.mergedAt)}`}
                  trailing={
                    <a className="gh-icon-link" href={merge.url} target="_blank" rel="noopener noreferrer" aria-label={t('github.repo.openMerge', { number: merge.number })}>
                      <ExternalLink size={17} aria-hidden="true" />
                    </a>
                  }
                />
              ))}
            </List>
          )}
        </>
      )}
    </Screen>
  );
}

// ---- the app ----------------------------------------------------------------------------

function Home({ onOpen, onRepository }: { onOpen: (ref: PullRef) => void; onRepository: (owner: string, repo: string) => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const active = useScreenActive();
  const visible = usePageVisible();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<HomeTab>(() => remembered(TAB_KEY, ['pulls', 'repositories', 'activity'], 'pulls'));
  const account = useQuery({ queryKey: githubKeys.account, queryFn: ({ signal }) => githubApi.account(false, signal), enabled: isOwner && active, staleTime: 30_000, retry: false });
  const [rechecking, setRechecking] = useState(false);
  // Relative times ("checked 2 minutes ago") are re-worded while the screen is being looked at.
  useNow(30_000, active && visible);

  const recheck = async () => {
    setRechecking(true);
    try {
      const before = account.data?.checkedAt;
      const answer = await githubApi.account(true);
      queryClient.setQueryData(githubKeys.account, answer);
      // The server looks again at most every few seconds; an answer that is still the earlier one is said to be.
      if (answer.checkedAt === before) toast.info(t('github.account.recentlyChecked'));
      await queryClient.invalidateQueries({ queryKey: githubKeys.all, predicate: (query) => query.queryKey[1] !== 'account' });
    } catch {
      await account.refetch();
    } finally {
      setRechecking(false);
    }
  };
  const refreshAll = () => {
    void progress.track(
      (async () => {
        await Promise.allSettled([githubApi.account(true).then((data) => queryClient.setQueryData(githubKeys.account, data)), githubApi.inbox('all', true)]);
        await queryClient.invalidateQueries({ queryKey: githubKeys.all, predicate: (query) => query.queryKey[1] !== 'account' });
      })(),
    );
  };

  let body: ReactNode;
  let caption: ReactNode;
  if (!isOwner) {
    // The GitHub login on the server is the owner's own identity; nothing of it is lent to anyone else.
    body = <EmptyState icon={<Lock size={28} />} title={t('github.ownerOnly.title')} description={t('github.ownerOnly.text')} />;
  } else if (account.isPending) {
    body = <ListSkeleton />;
  } else if (!account.data) {
    body = <ErrorState error={account.error} title={t('github.unreadable')} onRetry={() => void account.refetch()} retrying={account.isFetching} />;
  } else if (account.data.state !== 'ready' && account.data.state !== 'limited') {
    body = <AccountSetup account={account.data} onRecheck={() => void recheck()} checking={rechecking} />;
  } else {
    caption = (
      <span className="gh-account">
        <span className="pt-dot" data-tone="positive" />
        <span>{account.data.login ?? t('github.account.signedIn')}</span>
        {account.data.state === 'limited' && <Badge tone="warning">{t('github.account.readOnly')}</Badge>}
        <span className="gh-account__age">{t('github.account.checked', { when: t.relative(account.data.checkedAt) })}</span>
      </span>
    );
    body = (
      <>
        {account.data.state === 'limited' && (
          <Banner tone="warning" title={t('github.account.limited.title')}>
            {t('github.account.limited.text')}
          </Banner>
        )}
        <div {...tabPanelProps('github', tab)}>
          {tab === 'pulls' && <Inbox onOpen={onOpen} onRepository={onRepository} />}
          {tab === 'repositories' && <Repositories onRepository={onRepository} />}
          {tab === 'activity' && <Activity onOpen={onOpen} />}
        </div>
      </>
    );
  }
  const ready = isOwner && (account.data?.state === 'ready' || account.data?.state === 'limited');

  return (
    <Screen
      className="gh-screen"
      title={t('github.title')}
      caption={caption}
      actions={ready ? <IconButton label={t('github.refresh')} icon={<RefreshCw size={20} />} onClick={refreshAll} /> : undefined}
      toolbar={
        ready ? (
          <Tabs
            label={t('github.tabs.label')}
            idBase="github"
            value={tab}
            onChange={(next) => {
              setTab(next);
              remember(TAB_KEY, next);
            }}
            tabs={[
              { value: 'pulls', label: t('github.tabs.pulls') },
              { value: 'repositories', label: t('github.tabs.repositories') },
              { value: 'activity', label: t('github.tabs.activity') },
            ]}
            stretch
          />
        ) : undefined
      }
    >
      {body}
    </Screen>
  );
}

/**
 * GitHub, as far as the server's own `gh` login reaches: pull requests that
 * concern the owner, their repositories, and a guarded way to merge. There is
 * no sign-in here — that happens in a terminal on the server.
 */
export default function GithubScreen() {
  const navigate = useNavigate();
  const navigationType = useNavigationType();
  const user = useUser();
  const queryClient = useQueryClient();
  const rest = (useParams()['*'] ?? '').split('/').filter(Boolean);
  const repository = rest[0] === 'r' && rest[1] && rest[2] ? { owner: rest[1], repo: rest[2] } : null;
  const screenKey = repository ? `r:${repository.owner}/${repository.repo}` : ':home';
  const transition = useRouteTransition(screenKey, navigationType, isSystemGesturePop);
  const [pull, setPull] = useState<PullRef | null>(null);

  // A merge or a fix — here or on another device — makes every list out of date.
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type === GITHUB_CHANGED) void queryClient.invalidateQueries({ queryKey: githubKeys.all });
  });

  const openRepository = (owner: string, repo: string) => void navigate(`/github/r/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);

  return (
    <>
      <ScreenStack screenKey={screenKey} kind={transition}>
        {repository ? <RepositoryScreen owner={repository.owner} repo={repository.repo} onOpen={setPull} /> : <Home onOpen={setPull} onRepository={openRepository} />}
      </ScreenStack>
      <PullSheet pull={pull} onClose={() => setPull(null)} />
    </>
  );
}
