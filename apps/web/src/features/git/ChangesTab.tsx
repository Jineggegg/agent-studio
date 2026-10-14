import type { GitStatus } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Ellipsis, FileDiff, FileText, GitCommitHorizontal, Minus, Plus, Trash2, Undo2 } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { PathLabel, SwipeRow, type SwipeAction, splitPath } from '@/features/projects/tools/kit';
import { useLanguage, useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { useLayoutClass } from '@/platform/layout';
import { isApplePlatform } from '@/platform/media';
import { Banner, Button, EmptyState, IconButton, Menu, type MenuEntry, TextArea, confirm, toast } from '@/ui';
import { gitApi, gitKeys } from './api';
import { Disclosure, LazyDiff, SectionTitle, useGit } from './parts';
import { CHANGE_GROUPS, type Change, type ChangeGroup, groupChanges, shortOid } from './status';

const GROUP_TITLE = {
  conflicted: 'git.changes.conflicted',
  staged: 'git.changes.staged',
  unstaged: 'git.changes.unstaged',
  untracked: 'git.changes.untracked',
} as const;

function ChangeRow({ change, open, onToggle, onMenu }: { change: Change; open: boolean; onToggle: () => void; onMenu: (change: Change, anchor: HTMLElement) => void }) {
  const t = useT();
  const { project, writable, busy, run } = useGit();
  const path = change.file.path;
  const { name } = splitPath(path);
  const staged = change.group === 'staged';
  const stage = () => void run(`stage:${path}`, () => gitApi.stage(project.id, [path]));
  const unstage = () => void run(`unstage:${path}`, () => gitApi.unstage(project.id, [path]));

  const swipe: SwipeAction[] = !writable
    ? []
    : staged
      ? [{ id: 'unstage', label: t('git.unstage'), icon: <Minus size={18} />, tone: 'accent', onSelect: unstage }]
      : change.group === 'conflicted'
        ? []
        : [{ id: 'stage', label: t('git.stage'), icon: <Plus size={18} />, tone: 'accent', onSelect: stage }];

  return (
    <div className="git-change" data-open={open || undefined}>
      <SwipeRow actions={swipe}>
        <div className="git-row">
          <button type="button" className="git-row__main" aria-expanded={open} onClick={onToggle} aria-label={t('git.change.label', { path, state: t(`git.kind.${change.kind}`) })}>
            <Disclosure open={open} />
            <span className="pt-letter" data-kind={change.kind} aria-hidden="true">
              {change.letter}
            </span>
            <span className="git-row__text">
              <PathLabel path={path} />
              {change.file.originalPath && <span className="git-row__sub u-truncate">{t('git.change.renamedFrom', { path: change.file.originalPath })}</span>}
            </span>
          </button>
          {writable && change.group !== 'conflicted' && (
            <IconButton
              label={staged ? t('git.unstageNamed', { name }) : t('git.stageNamed', { name })}
              icon={staged ? <Minus size={19} /> : <Plus size={19} />}
              tone="secondary"
              busy={busy === `stage:${path}` || busy === `unstage:${path}`}
              disabled={busy !== null}
              onClick={staged ? unstage : stage}
            />
          )}
          <IconButton label={t('git.change.actions', { name })} icon={<Ellipsis size={19} />} tone="secondary" aria-haspopup="menu" onClick={(event) => onMenu(change, event.currentTarget)} />
        </div>
      </SwipeRow>
      {open &&
        (path.endsWith('/') ? (
          <p className="git-diff__note">{t('git.diff.folder')}</p>
        ) : (
          <LazyDiff queryKey={gitKeys.diff(project.id, path, staged)} read={(signal) => gitApi.diff(project.id, path, staged, signal)} label={t('git.diff.label', { name })} />
        ))}
    </div>
  );
}

/** What changed since the last commit, what of it will go into the next one, and the commit itself. */
export function ChangesTab({ status }: { status: GitStatus }) {
  const t = useT();
  const language = useLanguage();
  const layout = useLayoutClass();
  const { project, writable, busy, run, ask, askIdentity, report } = useGit();
  const groups = useMemo(() => groupChanges(status.files, language), [status.files, language]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState('');
  const [composing, setComposing] = useState(false);
  const [menu, setMenu] = useState<Change | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const identity = useQuery({ queryKey: gitKeys.identity, queryFn: ({ signal }) => gitApi.identity(signal), staleTime: 5 * 60_000 });

  const stagedCount = groups.staged.length;
  const canCommit = writable && stagedCount > 0 && message.trim() !== '' && busy === null;

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const commit = async () => {
    if (!canCommit) return;
    if (identity.data?.source === 'none' && !(await askIdentity())) return;
    const attempt = () => run('commit', () => gitApi.commitStaged(project.id, { message }), { operation: 'commit', quiet: true });
    let result = await attempt();
    // The server is the one that knows whether git has a name to commit under: asked once, then the commit goes ahead.
    if (!result.ok && result.recovery === 'set-identity' && (await askIdentity())) result = await attempt();
    if (result.ok) {
      setMessage('');
      setComposing(false);
      toast.success(t('git.commit.done', { oid: shortOid(result.value.oid), subject: result.value.subject }));
    } else report(result.problem);
  };

  const firstCommit = async () => {
    if (identity.data?.source === 'none' && !(await askIdentity())) return;
    const attempt = () => run('commit', () => gitApi.initialCommit(project.id, message.trim() || undefined), { operation: 'commit', quiet: true });
    let result = await attempt();
    if (!result.ok && result.recovery === 'set-identity' && (await askIdentity())) result = await attempt();
    if (result.ok) {
      setMessage('');
      toast.success(t('git.commit.done', { oid: shortOid(result.value.oid), subject: result.value.subject }));
    } else report(result.problem);
  };

  const discard = async (change: Change) => {
    const { name } = splitPath(change.file.path);
    const untracked = change.group === 'untracked';
    const agreed = await confirm({
      title: untracked ? t('git.delete.title', { name }) : t('git.discard.title', { name }),
      message: untracked ? t('git.delete.message') : change.file.worktree === 'deleted' ? t('git.discard.messageDeleted') : t('git.discard.message'),
      confirmLabel: untracked ? t('git.delete.confirm') : t('git.discard.confirm'),
      tone: 'danger',
    });
    if (!agreed) return;
    const path = change.file.path;
    await run(`discard:${path}`, () => (untracked ? gitApi.deleteUntracked(project.id, path) : gitApi.discard(project.id, path)), {
      done: untracked ? t('git.delete.done', { name }) : t('git.discard.done', { name }),
    });
  };

  const onMessageKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void commit();
    }
  };

  const menuItems = useMemo((): MenuEntry[] => {
    if (!menu) return [];
    const path = menu.file.path;
    const items: MenuEntry[] = [];
    if (!path.endsWith('/') && menu.file.worktree !== 'deleted' && !(menu.group === 'staged' && menu.file.index === 'deleted')) {
      items.push({ id: 'open', label: t('git.change.open'), icon: <FileText size={18} />, onSelect: () => ask({ type: 'open-file', path }) });
      items.push({ id: 'changes', label: t('git.change.openChanges'), icon: <FileDiff size={18} />, onSelect: () => ask({ type: 'open-file', path, view: 'changes' }) });
    }
    items.push({ id: 'copy', label: t('files.copyPath'), icon: <Copy size={18} />, onSelect: () => void copyText(path).then((copied) => copied && toast.success(t('files.pathCopied'))) });
    if (writable && menu.group === 'unstaged') {
      items.push({ separator: true, id: 'separator' }, { id: 'discard', label: t('git.discard'), icon: <Undo2 size={18} />, tone: 'danger', onSelect: () => void discard(menu) });
    }
    if (writable && menu.group === 'untracked') {
      items.push({ separator: true, id: 'separator' }, { id: 'delete', label: t('git.delete'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void discard(menu) });
    }
    return items;
    // `discard` reads only what is passed to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, writable, t, ask]);

  const groupAction = (group: ChangeGroup) => {
    if (!writable || groups[group].length === 0) return undefined;
    const paths = groups[group].map((change) => change.file.path);
    if (group === 'staged') {
      return (
        <Button size="sm" variant="plain" disabled={busy !== null} onClick={() => void run('unstage-all', () => gitApi.unstage(project.id, 'all'))}>
          {t('git.unstageAll')}
        </Button>
      );
    }
    if (group === 'conflicted') return undefined;
    return (
      <Button size="sm" variant="plain" disabled={busy !== null} onClick={() => void run(`stage-all:${group}`, () => gitApi.stage(project.id, paths.length > 2000 ? 'all' : paths))}>
        {t('git.stageAll')}
      </Button>
    );
  };

  const author = identity.data && identity.data.source !== 'none' && identity.data.name ? t('git.commit.as', { name: identity.data.name }) : null;
  const collapsed = layout === 'phone' && !composing && message === '';
  const shortcut = isApplePlatform() ? '⌘↩' : 'Ctrl+↩';

  return (
    <div className="git-changes">
      {!status.hasCommits && (
        <div className="pt-problem">
          <Banner tone="info" title={t('git.noCommits.title')}>
            <p>{t('git.noCommits.text')}</p>
            {writable && status.files.length > 0 && (
              <Button size="sm" variant="neutral" loading={busy === 'commit'} disabled={busy !== null} onClick={() => void firstCommit()}>
                {t('git.noCommits.action')}
              </Button>
            )}
          </Banner>
        </div>
      )}

      {writable &&
        (collapsed ? (
          <div className="git-commit git-commit--collapsed">
            <Button block variant={stagedCount > 0 ? 'tinted' : 'neutral'} icon={<GitCommitHorizontal size={18} />} disabled={stagedCount === 0} onClick={() => setComposing(true)}>
              {stagedCount > 0 ? t.plural('git.commit.open', stagedCount) : t('git.commit.nothingStaged')}
            </Button>
          </div>
        ) : (
          <div className="git-commit">
            <TextArea
              label={t('git.commit.message')}
              hideLabel
              placeholder={t('git.commit.placeholder')}
              value={message}
              onChange={setMessage}
              rows={3}
              autoGrow
              maxRows={10}
              maxLength={20_000}
              onKeyDown={onMessageKey}
              {...(layout === 'phone' && composing ? { 'data-autofocus': '', autoFocus: true } : {})}
            />
            <div className="git-commit__bar">
              <p className="git-commit__summary">
                <span>{stagedCount > 0 ? t.plural('git.commit.staged', stagedCount) : t('git.commit.nothingStaged')}</span>
                {author && (
                  <button type="button" className="git-commit__author" onClick={() => void askIdentity()} title={identity.data?.email ?? undefined}>
                    {author}
                  </button>
                )}
              </p>
              <Button size="sm" variant="primary" icon={<Check size={16} />} loading={busy === 'commit'} disabled={!canCommit} onClick={() => void commit()} title={t('git.commit.shortcut', { keys: shortcut })}>
                {t('git.commit')}
              </Button>
            </div>
          </div>
        ))}

      {status.files.length === 0 ? (
        <EmptyState compact icon={<Check size={26} />} title={t('git.changes.none')} description={status.hasCommits ? t('git.changes.noneHint') : undefined} />
      ) : (
        CHANGE_GROUPS.map((group) =>
          groups[group].length === 0 ? null : (
            <section key={group} className="git-group" aria-label={t(GROUP_TITLE[group])}>
              <SectionTitle count={groups[group].length} action={groupAction(group)}>
                {t(GROUP_TITLE[group])}
              </SectionTitle>
              {group === 'conflicted' && <p className="pt-note">{t('git.changes.conflictedNote')}</p>}
              {groups[group].map((change) => (
                <ChangeRow
                  key={change.key}
                  change={change}
                  open={open.has(change.key)}
                  onToggle={() => toggle(change.key)}
                  onMenu={(target, anchor) => {
                    menuAnchor.current = anchor;
                    setMenu(target);
                    setMenuOpen(true);
                  }}
                />
              ))}
            </section>
          ),
        )
      )}
      {status.truncated && <p className="pt-note">{t('git.changes.truncated')}</p>}

      <Menu open={menuOpen && menu !== null} onClose={() => setMenuOpen(false)} anchor={menuAnchor} label={menu ? t('git.change.actions', { name: splitPath(menu.file.path).name }) : ''} align="end" items={menuItems} />
    </div>
  );
}
