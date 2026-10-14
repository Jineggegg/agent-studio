import type { GitBranch as Branch, GitStatus } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { Check, Plus, Search, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Button, EmptyState, ErrorState, Form, IconButton, LoadingRow, TextField, confirm } from '@/ui';
import { gitApi, gitKeys } from './api';
import { AheadBehind, SectionTitle, useGit } from './parts';
import { listBranches } from './status';

function BranchRow({ branch, dirty }: { branch: Branch; dirty: boolean }) {
  const t = useT();
  const { project, writable, busy, run, report } = useGit();
  const remote = branch.kind === 'remote';

  const switchTo = async () => {
    // Nothing is carried over silently: the server refuses when uncommitted work would be lost, and says so.
    if (dirty && !(await confirm({ title: t('git.branch.switch.title', { name: branch.name }), message: t('git.branch.switch.message'), confirmLabel: t('git.branch.switch') }))) return;
    await run(`switch:${branch.name}`, () => gitApi.switchBranch(project.id, branch.name, branch.kind), { done: t('git.branch.switched', { name: remote && branch.remote ? branch.name.slice(branch.remote.length + 1) : branch.name }) });
  };

  const remove = async () => {
    if (!(await confirm({ title: t('git.branch.delete.title', { name: branch.name }), message: t('git.branch.delete.message'), confirmLabel: t('git.branch.delete'), tone: 'danger' }))) return;
    const result = await run(`delete:${branch.name}`, () => gitApi.deleteBranch(project.id, branch.name, false), { operation: 'delete-branch', quiet: true, done: t('git.branch.deleted', { name: branch.name }) });
    if (result.ok) return;
    if (result.recovery !== 'force-delete-branch') return report(result.problem);
    // Not merged anywhere: deleting it loses commits. That takes a second, explicit, yes.
    const forced = await confirm({
      title: t('git.branch.force.title', { name: branch.name }),
      message: t('git.branch.force.message'),
      confirmLabel: t('git.branch.force.confirm'),
      tone: 'danger',
    });
    if (forced) await run(`delete:${branch.name}`, () => gitApi.deleteBranch(project.id, branch.name, true), { operation: 'delete-branch', done: t('git.branch.deleted', { name: branch.name }) });
  };

  return (
    <li className="git-branch" data-current={branch.current || undefined}>
      <div className="git-branch__text">
        <p className="git-branch__name">
          <span className="u-truncate">{branch.name}</span>
          {branch.current && (
            <span className="pt-pill" data-tone="accent">
              <Check size={11} aria-hidden="true" />
              {t('git.branch.current')}
            </span>
          )}
          {branch.checkedOutElsewhere && <span className="pt-pill">{t('git.branch.elsewhere')}</span>}
          {branch.upstreamGone && (
            <span className="pt-pill" data-tone="warning">
              {t('git.branch.upstreamGone')}
            </span>
          )}
          <AheadBehind ahead={branch.ahead} behind={branch.behind} />
        </p>
        <p className="git-branch__sub u-truncate">
          {branch.subject} · {t.relative(branch.committedAt)}
        </p>
      </div>
      {writable && !branch.current && !branch.checkedOutElsewhere && (
        <Button size="sm" variant="neutral" loading={busy === `switch:${branch.name}`} disabled={busy !== null} onClick={() => void switchTo()}>
          {remote ? t('git.branch.checkout') : t('git.branch.switch')}
        </Button>
      )}
      {writable && !remote && !branch.current && (
        <IconButton label={t('git.branch.deleteNamed', { name: branch.name })} icon={<Trash2 size={18} />} tone="secondary" busy={busy === `delete:${branch.name}`} disabled={busy !== null} onClick={() => void remove()} />
      )}
    </li>
  );
}

/** Every branch, a way to find one, switch to it, start a new one, and delete one that is done with. */
export function BranchesTab({ status }: { status: GitStatus }) {
  const t = useT();
  const { project, writable, busy, run } = useGit();
  const branches = useQuery({ queryKey: gitKeys.branches(project.id), queryFn: ({ signal }) => gitApi.branches(project.id, signal), retry: false });
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  if (branches.isPending) return <LoadingRow label={t('common.loading')} />;
  if (branches.isError && !branches.data) return <ErrorState compact error={branches.error} onRetry={() => void branches.refetch()} />;
  const { local, remote } = listBranches(branches.data, query);
  const total = branches.data.branches.length;
  const current = branches.data.current;

  const create = async () => {
    const wanted = name.trim();
    if (wanted === '') return setNameProblem(t('git.branch.new.nameMissing'));
    setNameProblem(null);
    const result = await run('create-branch', () => gitApi.createBranch(project.id, { name: wanted }), { quiet: true, done: t('git.branch.created', { name: wanted }) });
    if (result.ok) {
      setName('');
      setCreating(false);
    } else setNameProblem(result.problem.text);
  };

  return (
    <div className="git-branches">
      <div className="git-branches__bar">
        {total > 6 && (
          <label className="pt-search git-branches__search">
            <Search size={17} aria-hidden="true" />
            <input type="search" value={query} placeholder={t('git.branch.search')} aria-label={t('git.branch.search')} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
            {query !== '' && (
              <button type="button" className="pt-search__clear" onClick={() => setQuery('')} aria-label={t('files.search.clear')}>
                <X size={16} aria-hidden="true" />
              </button>
            )}
          </label>
        )}
        {writable && !creating && status.hasCommits && (
          <Button size="sm" variant="tinted" icon={<Plus size={16} />} onClick={() => setCreating(true)}>
            {t('git.branch.new')}
          </Button>
        )}
      </div>

      {creating && (
        <Form className="git-form" onSubmit={() => void create()}>
          <TextField
            label={t('git.branch.new.name')}
            value={name}
            onChange={(value) => {
              setName(value);
              setNameProblem(null);
            }}
            placeholder="feature/login-form"
            hint={current ? t('git.branch.new.from', { branch: current }) : t('git.branch.new.fromCommit')}
            error={nameProblem ?? undefined}
            mono
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="done"
            maxLength={250}
            data-autofocus=""
            autoFocus
          />
          <div className="git-form__actions">
            <Button
              variant="plain"
              size="sm"
              onClick={() => {
                setCreating(false);
                setNameProblem(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={busy === 'create-branch'} disabled={busy !== null}>
              {t('git.branch.new.create')}
            </Button>
          </div>
        </Form>
      )}

      {local.length === 0 && remote.length === 0 ? (
        <EmptyState compact title={query ? t('git.branch.noMatch', { query }) : t('git.branch.none')} />
      ) : (
        <>
          {local.length > 0 && (
            <section aria-label={t('git.branch.local')}>
              <SectionTitle count={local.length}>{t('git.branch.local')}</SectionTitle>
              <ul className="git-list">
                {local.map((branch) => (
                  <BranchRow key={branch.name} branch={branch} dirty={status.files.length > 0} />
                ))}
              </ul>
            </section>
          )}
          {remote.length > 0 && (
            <section aria-label={t('git.branch.remote')}>
              <SectionTitle count={remote.length}>{t('git.branch.remote')}</SectionTitle>
              <p className="pt-note">{t('git.branch.remoteNote')}</p>
              <ul className="git-list">
                {remote.map((branch) => (
                  <BranchRow key={branch.name} branch={branch} dirty={status.files.length > 0} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
