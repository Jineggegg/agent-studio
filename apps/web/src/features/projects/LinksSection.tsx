import { MAX_PROJECT_LINKS, type Project, type ProjectLinkInput } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { describeError } from '@/data/errors';
import { useUpdateProject } from '@/data/projects';
import { useIsOwner } from '@/data/session';
import { type MessageKey, useT } from '@/i18n';
import { Banner, Button, Form, IconButton, List, Sheet, Spinner, Switch, TextField, toast } from '@/ui';
import { projectPageKeys, projectsApi } from './api';
import { hostOf, linkProblem, linkStatusText } from './copy';

interface Row {
  key: string;
  id?: string;
  label: string;
  url: string;
  local: boolean;
}

const PROBLEM: Record<NonNullable<ReturnType<typeof linkProblem>>, MessageKey> = {
  label: 'projects.links.problem.label',
  url: 'projects.links.problem.url',
  scheme: 'projects.links.problem.scheme',
  credentials: 'projects.links.problem.credentials',
};

let rowCounter = 0;
const newRow = (): Row => ({ key: `new-${(rowCounter += 1)}`, label: '', url: '', local: false });

function EditLinksSheet({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const update = useUpdateProject();
  const [rows, setRows] = useState<Row[]>([]);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRows(project.links.length > 0 ? project.links.map((link) => ({ key: link.id, id: link.id, label: link.label, url: link.url, local: link.local })) : [newRow()]);
    setProblems({});
    setFailure(null);
    // The form starts from the saved links each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const change = (key: string, changes: Partial<Row>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...changes } : row)));
    setProblems((current) => ({ ...current, [key]: '' }));
  };

  const save = () => {
    if (update.isPending) return;
    // A row left entirely empty was never meant to be a link.
    const kept = rows.filter((row) => row.label.trim() !== '' || row.url.trim() !== '');
    const found: Record<string, string> = {};
    for (const row of kept) {
      const problem = linkProblem(row.label, row.url);
      if (problem) found[row.key] = t(PROBLEM[problem]);
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    const links: ProjectLinkInput[] = kept.map((row) => {
      // Only the owner marks a link as a local service. Anyone else keeps a mark the owner set — until they change the address.
      const original = project.links.find((link) => link.id === row.id);
      const local = isOwner ? row.local : original?.local === true && original.url === row.url.trim();
      return { ...(row.id ? { id: row.id } : {}), label: row.label.trim(), url: row.url.trim(), local };
    });
    update.mutate(
      { id: project.id, changes: { links } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: projectPageKeys.links(project.id) });
          toast.success(t('projects.links.saved'));
          onClose();
        },
        onError: (error) => setFailure(describeError(error, t)),
      },
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('projects.links.edit')}
      fill
      dismissible={!update.isPending}
      leading={
        <Button variant="plain" onClick={onClose} disabled={update.isPending}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={save} loading={update.isPending}>
          {t('common.save')}
        </Button>
      }
    >
      <Form className="proj-links-form" onSubmit={save}>
        {failure && (
          <Banner tone="danger" role="alert">
            {failure}
          </Banner>
        )}
        {rows.map((row, index) => (
          <fieldset key={row.key} className="proj-link-edit">
            <legend className="visually-hidden">{t('projects.links.rowLegend', { number: index + 1 })}</legend>
            <div className="proj-link-edit__fields">
              <TextField label={t('projects.links.label')} value={row.label} onChange={(label) => change(row.key, { label })} maxLength={40} placeholder={t('projects.links.labelPlaceholder')} disabled={update.isPending} enterKeyHint="next" />
              <TextField
                label={t('projects.links.url')}
                value={row.url}
                onChange={(url) => change(row.key, { url })}
                maxLength={500}
                placeholder="https://"
                error={problems[row.key] || undefined}
                mono
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={update.isPending}
                enterKeyHint="done"
              />
              {isOwner && (
                <label className="proj-link-edit__local">
                  <span>
                    <span className="proj-link-edit__local-title">{t('projects.links.local')}</span>
                    <span className="proj-link-edit__local-hint">{t('projects.links.localHint')}</span>
                  </span>
                  <Switch checked={row.local} onChange={(local) => change(row.key, { local })} disabled={update.isPending} label={t('projects.links.local')} />
                </label>
              )}
            </div>
            <IconButton label={t('projects.links.remove', { number: index + 1 })} icon={<Trash2 size={19} />} tone="secondary" disabled={update.isPending} onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))} />
          </fieldset>
        ))}
        <Button variant="neutral" icon={<Plus size={18} />} disabled={rows.length >= MAX_PROJECT_LINKS || update.isPending} onClick={() => setRows((current) => [...current, newRow()])}>
          {t('projects.links.add')}
        </Button>
        <p className="ui-list__footer">{t('projects.links.limit', { max: MAX_PROJECT_LINKS })}</p>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

/**
 * The project's websites — its deployment, its docs, its repository — each
 * with whether it answers right now. The server only reports that a site
 * answered, how and how fast; it never passes on anything the site said.
 */
export function LinksSection({ project }: { project: Project }) {
  const t = useT();
  const queryClient = useQueryClient();
  const writable = project.access === 'write';
  const [editing, setEditing] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const status = useQuery({
    queryKey: projectPageKeys.links(project.id),
    queryFn: ({ signal }) => projectsApi.linkStatus(project.id, false, signal),
    enabled: project.links.length > 0,
    staleTime: 60_000,
    retry: false,
  });
  const byLink = new Map((status.data ?? []).map((entry) => [entry.linkId, entry]));

  const recheck = async () => {
    setRechecking(true);
    try {
      queryClient.setQueryData(projectPageKeys.links(project.id), await projectsApi.linkStatus(project.id, true));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setRechecking(false);
    }
  };

  return (
    <>
      <List
        header={t('projects.links.title')}
        headerAction={
          <span className="proj-header-actions">
            {project.links.length > 0 && <IconButton label={t('projects.links.recheck')} icon={<RefreshCw size={18} />} tone="secondary" busy={rechecking || status.isFetching} onClick={() => void recheck()} />}
            {writable && <IconButton label={t('projects.links.edit')} icon={<Pencil size={18} />} tone="secondary" onClick={() => setEditing(true)} />}
          </span>
        }
        footer={project.links.length === 0 ? (writable ? t('projects.links.emptyHint') : t('projects.links.emptyReadOnly')) : status.isError ? t('projects.links.statusFailed') : undefined}
      >
        {project.links.length === 0 ? (
          <div className="proj-empty-row" role="listitem">
            <Globe size={20} aria-hidden="true" />
            <span>{t('projects.links.empty')}</span>
            {writable && (
              <Button size="sm" variant="tinted" onClick={() => setEditing(true)}>
                {t('projects.links.add')}
              </Button>
            )}
          </div>
        ) : (
          project.links.map((link) => {
            const found = status.isError ? { text: t('projects.links.unknown'), tone: 'neutral' as const } : linkStatusText(byLink.get(link.id), t);
            return (
              <a key={link.id} role="listitem" className="proj-link" href={link.url} target="_blank" rel="noopener noreferrer">
                <span className="proj-link__text">
                  <span className="proj-link__label">{link.label}</span>
                  <span className="proj-link__host u-truncate">
                    {hostOf(link.url)}
                    {link.local ? ` · ${t('projects.links.localBadge')}` : ''}
                  </span>
                </span>
                <span className="proj-link__status" data-tone={found.tone}>
                  {status.isPending ? <Spinner size={13} /> : <span className="pt-dot" data-tone={found.tone === 'neutral' ? undefined : found.tone} />}
                  {found.text}
                </span>
                <ExternalLink size={17} aria-hidden="true" />
                <span className="visually-hidden">{t('projects.links.opensNewTab')}</span>
              </a>
            );
          })
        )}
      </List>
      <EditLinksSheet project={project} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}
