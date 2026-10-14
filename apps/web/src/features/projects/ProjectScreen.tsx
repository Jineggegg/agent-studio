import type { Project } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, MessagesSquare, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useStaleness } from '@/data/connection';
import { describeError, errorKind } from '@/data/errors';
import { projectKeys, useProjects, useProjectsLiveUpdates, useRemoveProject, useUpdateProject } from '@/data/projects';
import { useIsOwner } from '@/data/session';
import { type ProjectDraft, ProjectFields } from '@/features/home/ProjectFields';
import { projectSymbol } from '@/features/home/icons';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { Badge, Banner, Button, DelayedSkeleton, ErrorState, Form, Glyph, List, ListRow, LoadingRow, Sheet, Skeleton, StaleNotice, confirm, toTint, toast } from '@/ui';
import { AccessSection } from './AccessSection';
import { ProjectTasksSection } from '@/features/collab/tasks/ProjectTasksSection';
import { LinksSection } from './LinksSection';
import { SharingSection } from './SharingSection';
import { projectPageKeys, projectsApi } from './api';
import './projects.css';

function EditSheet({ project, open, onClose }: { project: Project; open: boolean; onClose: () => void }) {
  const t = useT();
  const update = useUpdateProject();
  const [draft, setDraft] = useState<ProjectDraft>({ name: project.name, description: project.description, symbol: project.icon.symbol, color: toTint(project.icon.color) });
  const [nameError, setNameError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDraft({ name: project.name, description: project.description, symbol: project.icon.symbol, color: toTint(project.icon.color) });
      setNameError(undefined);
      setFailure(null);
    }
  }

  const save = () => {
    if (update.isPending) return;
    if (draft.name.trim() === '') return setNameError(t('home.project.nameMissing'));
    update.mutate(
      { id: project.id, changes: { name: draft.name.trim(), description: draft.description.trim(), icon: { symbol: draft.symbol, color: draft.color } } },
      {
        onSuccess: () => {
          toast.success(t('home.project.saved'));
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
      title={t('home.project.edit')}
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
      <Form className="project-form" onSubmit={save}>
        {failure && (
          <Banner tone="danger" role="alert">
            {failure}
          </Banner>
        )}
        <ProjectFields
          draft={draft}
          onChange={(changes) => {
            setDraft((current) => ({ ...current, ...changes }));
            if (changes.name !== undefined) setNameError(undefined);
          }}
          nameError={nameError}
          disabled={update.isPending}
          autoFocusName
        />
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

function Loaded({ project, onRemove, removeFailure }: { project: Project; onRemove: (project: Project) => void; removeFailure: string | null }) {
  const t = useT();
  const isOwner = useIsOwner();
  const navigate = useNavigate();
  const update = useUpdateProject();
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(removeFailure);
  const writable = project.access === 'write';
  const Symbol = projectSymbol(project.icon.symbol);
  const busy = update.isPending;

  const setArchived = async (archived: boolean) => {
    if (archived && !(await confirm({ title: t('projects.archive.title', { name: project.name }), message: t('projects.archive.message'), confirmLabel: t('home.project.archive') }))) return;
    setFailure(null);
    update.mutate(
      { id: project.id, changes: { archived } },
      {
        onSuccess: () => toast.success(archived ? t('home.project.archived', { name: project.name }) : t('home.project.restored', { name: project.name })),
        onError: (error) => setFailure(describeError(error, t)),
      },
    );
  };

  const removeProject = async () => {
    // Exactly what goes, and what does not: nothing on the server's disk is touched.
    const agreed = await confirm({ title: t('home.project.removeConfirm.title', { name: project.name }), message: t('projects.remove.message', { folder: project.rootDir }), confirmLabel: t('projects.remove.confirm'), tone: 'danger' });
    if (agreed) onRemove(project);
  };

  return (
    <>
      {failure && (
        <Banner tone="danger" role="alert">
          {failure}
        </Banner>
      )}
      <div className="proj-head">
        <Glyph icon={<Symbol size={30} />} tint={toTint(project.icon.color)} size={60} />
        <div className="proj-head__text">
          {project.description ? <p className="proj-head__description">{project.description}</p> : <p className="proj-head__description proj-head__description--none">{t('projects.noDescription')}</p>}
          <div className="proj-head__badges">
            {project.archived && <Badge tone="warning">{t('home.project.archivedBadge')}</Badge>}
            {project.access === 'read' && <Badge>{t('home.project.readOnly')}</Badge>}
            {project.scratch && <Badge>{t('projects.scratch')}</Badge>}
          </div>
        </div>
      </div>
      <div className="proj-actions">
        {project.features.assistant && !project.archived && (
          <Button variant="primary" icon={<MessagesSquare size={18} />} onClick={() => void navigate(workbenchPaths.project(project.id))}>
            {t('projects.openWorkbench')}
          </Button>
        )}
        {writable && (
          <Button variant="neutral" icon={<Pencil size={18} />} onClick={() => setEditing(true)}>
            {t('projects.editDetails')}
          </Button>
        )}
      </div>

      <LinksSection project={project} />

      {/* The project's multi-agent tasks, and "Ask several agents" (features/collab). */}
      {project.features.assistant && <ProjectTasksSection project={project} />}

      {isOwner ? (
        <>
          <AccessSection project={project} />
          <SharingSection project={project} />
        </>
      ) : (
        <List header={t('projects.yourAccess.title')} footer={t('projects.yourAccess.footer')}>
          <ListRow title={writable ? t('projects.yourAccess.write') : t('projects.yourAccess.read')} subtitle={writable ? t('projects.yourAccess.writeText') : t('projects.yourAccess.readText')} />
          <ListRow title={t('projects.yourAccess.never')} subtitle={t('projects.yourAccess.neverText')} />
        </List>
      )}

      <List header={t('projects.about.title')}>
        <ListRow title={t('home.project.folder')} subtitle={<span className="u-mono proj-folder">{project.rootDir}</span>} />
        <ListRow title={t('home.project.createdAt')} value={t.date(project.createdAt, 'date')} />
      </List>

      {isOwner && !project.scratch && (
        <List header={t('projects.danger.title')} footer={t('projects.remove.footer')}>
          {project.archived ? (
            <ListRow leading={<ArchiveRestore size={20} />} title={t('home.project.restore')} subtitle={t('projects.restore.hint')} onPress={() => void setArchived(false)} disabled={busy} />
          ) : (
            <ListRow leading={<Archive size={20} />} title={t('home.project.archive')} subtitle={t('home.project.archiveHint')} onPress={() => void setArchived(true)} disabled={busy} />
          )}
          <ListRow leading={<Trash2 size={20} />} title={t('home.project.remove')} subtitle={t('projects.remove.hint')} tone="danger" onPress={() => void removeProject()} disabled={busy} />
        </List>
      )}
      <EditSheet project={project} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}

/**
 * A project's own page: what it is called and looks like, its websites, which
 * agents it offers and what they may do there, who it is shared with — and
 * archiving or removing it. Reached from the workbench and from the home
 * screen's project sheet.
 */
export default function ProjectScreen() {
  const t = useT();
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useProjectsLiveUpdates();
  // The list every screen shares is read first: it is usually there already, and it is what live updates keep current.
  const list = useProjects({ archived: 'include' });
  const listed = list.data?.find((project) => project.id === projectId);
  const remove = useRemoveProject();
  /** The project being removed: from the confirmation until the way home the page shows only that, and asks the server nothing more about it. */
  const [removing, setRemoving] = useState<Project | null>(null);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  const removeProject = (project: Project) => {
    setRemoveFailure(null);
    setRemoving(project);
    remove.mutate(project.id, {
      onSuccess: () => {
        toast.success(t('home.project.removed', { name: project.name }));
        void navigate('/', { replace: true });
      },
      onError: (error) => {
        setRemoving(null);
        setRemoveFailure(describeError(error, t));
      },
    });
  };
  const single = useQuery({
    queryKey: projectPageKeys.project(projectId),
    queryFn: ({ signal }) => projectsApi.project(projectId, signal),
    enabled: projectId !== '' && list.isSuccess && !listed && !removing,
    retry: false,
  });
  const project = listed ?? single.data ?? null;
  const staleness = useStaleness(list);
  const pending = list.isPending || (!listed && single.isPending && list.isSuccess);
  const error = list.error ?? single.error;
  const gone = list.isSuccess && !listed && single.isError && errorKind(single.error) === 'gone';

  return (
    <Screen title={removing?.name ?? project?.name ?? t('projects.page.title')} parent={{ to: '/', label: t('nav.home') }}>
      {removing ? (
        <LoadingRow label={t('projects.remove.removing', { name: removing.name })} />
      ) : project ? (
        <>
          {staleness.stale && <StaleNotice since={staleness.since} />}
          <Loaded key={project.id} project={project} onRemove={removeProject} removeFailure={removeFailure} />
        </>
      ) : pending ? (
        <DelayedSkeleton label={t('common.loading')}>
          <div className="proj-head">
            <Skeleton width={60} height={60} radius={18} />
            <div className="proj-head__text">
              <Skeleton width="70%" height={14} />
            </div>
          </div>
        </DelayedSkeleton>
      ) : (
        <ErrorState
          error={error}
          // Gone is gone: trying again would not bring it back, so the way on is home. Unreachable is another matter.
          {...(gone
            ? {
                kind: 'gone' as const,
                title: t('projects.gone.title'),
                description: t('projects.gone.text'),
                actions: (
                  <Button variant="tinted" onClick={() => void navigate('/', { replace: true })}>
                    {t('nav.backToHome')}
                  </Button>
                ),
              }
            : {
                onRetry: () => {
                  void queryClient.invalidateQueries({ queryKey: projectKeys.all });
                  void single.refetch();
                },
              })}
        />
      )}
    </Screen>
  );
}
