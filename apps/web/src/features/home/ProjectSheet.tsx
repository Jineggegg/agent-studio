import type { Project } from '@agent-studio/protocol';
import { Archive, ArchiveRestore, Pencil, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '@/data/errors';
import { useRemoveProject, useUpdateProject } from '@/data/projects';
import { useIsOwner } from '@/data/session';
import { useT } from '@/i18n';
import { projectSettingsPath } from '@/registry';
import { Badge, Banner, Button, ConfirmDialog, Form, Glyph, List, ListRow, Sheet, toTint, toast } from '@/ui';
import { type ProjectDraft, ProjectFields } from './ProjectFields';
import { projectSymbol } from './icons';

export interface ProjectSheetProps {
  /** The project to show; null closes the sheet. */
  project: Project | null;
  onClose: () => void;
}

const draftOf = (project: Project): ProjectDraft => ({
  name: project.name,
  description: project.description,
  symbol: project.icon.symbol,
  color: toTint(project.icon.color),
});

/**
 * A project's details and — for those allowed — rename, archive and remove.
 * It is what a project tile opens until a feature provides the project's own page.
 */
export function ProjectSheet({ project, onClose }: ProjectSheetProps) {
  const t = useT();
  const navigate = useNavigate();
  const isOwner = useIsOwner();
  const update = useUpdateProject();
  const remove = useRemoveProject();
  // The sheet keeps showing the last project while it animates away.
  const [shown, setShown] = useState<Project | null>(project);
  if (project && project !== shown) setShown(project);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProjectDraft | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const projectId = project?.id;
  useEffect(() => {
    setEditing(false);
    setFailure(null);
    setNameError(undefined);
  }, [projectId]);

  if (!shown) return null;
  const canEdit = shown.access === 'write';
  const Symbol = projectSymbol(shown.icon.symbol);
  const busy = update.isPending || remove.isPending;

  const startEditing = () => {
    setDraft(draftOf(shown));
    setFailure(null);
    setNameError(undefined);
    setEditing(true);
  };

  const save = () => {
    if (!draft || busy) return;
    if (draft.name.trim() === '') {
      setNameError(t('home.project.nameMissing'));
      return;
    }
    update.mutate(
      { id: shown.id, changes: { name: draft.name.trim(), description: draft.description.trim(), icon: { symbol: draft.symbol, color: draft.color } } },
      {
        onSuccess: (saved) => {
          setShown(saved);
          setEditing(false);
          toast.success(t('home.project.saved'));
        },
        onError: (error) => setFailure(describeError(error, t)),
      },
    );
  };

  const setArchived = (archived: boolean) => {
    update.mutate(
      { id: shown.id, changes: { archived } },
      {
        onSuccess: () => {
          onClose();
          if (archived) {
            toast.show({
              title: t('home.project.archived', { name: shown.name }),
              detail: t('home.project.archivedDetail'),
              action: { label: t('common.undo'), onSelect: () => update.mutate({ id: shown.id, changes: { archived: false } }) },
            });
          } else {
            toast.success(t('home.project.restored', { name: shown.name }));
          }
        },
        onError: (error) => setFailure(describeError(error, t)),
      },
    );
  };

  return (
    <>
      <Sheet
        open={project !== null}
        onClose={onClose}
        title={editing ? t('home.project.edit') : t('home.project.details')}
        dismissible={!busy}
        leading={
          editing ? (
            <Button variant="plain" onClick={() => setEditing(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
          ) : undefined
        }
        trailing={
          editing ? (
            <Button variant="plain" onClick={save} loading={update.isPending}>
              {t('common.save')}
            </Button>
          ) : undefined
        }
      >
        {editing && draft ? (
          <Form className="project-form" onSubmit={save}>
            {failure && (
              <Banner tone="danger" role="alert">
                {failure}
              </Banner>
            )}
            <ProjectFields
              draft={draft}
              onChange={(changes) => {
                setDraft((current) => (current ? { ...current, ...changes } : current));
                if (changes.name !== undefined) setNameError(undefined);
              }}
              nameError={nameError}
              disabled={busy}
              autoFocusName
            />
            <button type="submit" hidden />
          </Form>
        ) : (
          <div className="project-detail">
            {failure && (
              <Banner tone="danger" role="alert">
                {failure}
              </Banner>
            )}
            <div className="project-detail__head">
              <Glyph icon={<Symbol size={32} />} tint={toTint(shown.icon.color)} size={64} />
              <div style={{ minWidth: 0 }}>
                <p className="project-detail__name">{shown.name}</p>
                {shown.description && <p className="project-detail__description">{shown.description}</p>}
                {(shown.archived || shown.access === 'read') && (
                  <div className="project-detail__badges">
                    {shown.archived && <Badge tone="warning">{t('home.project.archivedBadge')}</Badge>}
                    {shown.access === 'read' && <Badge>{t('home.project.readOnly')}</Badge>}
                  </div>
                )}
              </div>
            </div>

            {projectSettingsPath(shown.id) && (
              // The project's own page: links, the agents it offers, what they may do there, and who it is shared with.
              <List>
                <ListRow
                  leading={<Settings2 size={20} />}
                  title={t('projects.page.open')}
                  subtitle={t('projects.page.openHint')}
                  chevron
                  onPress={() => {
                    const path = projectSettingsPath(shown.id);
                    onClose();
                    if (path) void navigate(path);
                  }}
                />
              </List>
            )}

            <List>
              <ListRow title={t('home.project.folder')} subtitle={<span className="u-mono">{shown.rootDir}</span>} />
              <ListRow title={t('home.project.access')} value={shown.access === 'write' ? t('home.project.accessWrite') : t('home.project.accessRead')} />
              <ListRow title={t('home.project.createdAt')} value={t.date(shown.createdAt, 'date')} />
            </List>

            {canEdit && (
              <List footer={isOwner ? t('home.project.removeHint') : undefined}>
                <ListRow leading={<Pencil size={20} />} title={t('home.project.edit')} onPress={startEditing} disabled={busy} />
                {isOwner &&
                  (shown.archived ? (
                    <ListRow leading={<ArchiveRestore size={20} />} title={t('home.project.restore')} onPress={() => setArchived(false)} disabled={busy} />
                  ) : (
                    <ListRow leading={<Archive size={20} />} title={t('home.project.archive')} subtitle={t('home.project.archiveHint')} onPress={() => setArchived(true)} disabled={busy} />
                  ))}
                {isOwner && <ListRow leading={<Trash2 size={20} />} title={t('home.project.remove')} tone="danger" onPress={() => setConfirmingRemoval(true)} disabled={busy} />}
              </List>
            )}
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={confirmingRemoval}
        title={t('home.project.removeConfirm.title', { name: shown.name })}
        message={t('home.project.removeConfirm.message')}
        confirmLabel={t('common.remove')}
        tone="danger"
        onCancel={() => setConfirmingRemoval(false)}
        onConfirm={async () => {
          try {
            await remove.mutateAsync(shown.id);
            setConfirmingRemoval(false);
            onClose();
            toast.success(t('home.project.removed', { name: shown.name }));
          } catch (error) {
            setConfirmingRemoval(false);
            setFailure(describeError(error, t));
          }
        }}
      />
    </>
  );
}
