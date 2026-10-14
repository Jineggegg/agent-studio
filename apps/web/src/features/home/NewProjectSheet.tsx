import type { Project } from '@agent-studio/protocol';
import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { useCreateProject } from '@/data/projects';
import { CloneForm, type CloneFormHandle } from '@/features/projects/CloneForm';
import { useT } from '@/i18n';
import { Banner, Button, Form, ListRow, SegmentedControl, Sheet, Switch, TextField, toast } from '@/ui';
import { FolderPicker } from './FolderPicker';
import { type ProjectDraft, ProjectFields } from './ProjectFields';

export interface NewProjectSheetProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (project: Project) => void;
}

const EMPTY: ProjectDraft = { name: '', description: '', symbol: 'folder', color: 'blue' };
/** Refusals that are about the folder: shown under the folder field rather than above the form. */
const FOLDER_CODES = new Set(['invalid_path', 'folder_missing', 'outside_workspace', 'folder_not_allowed', 'project_exists']);

function lastSegment(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

/**
 * Set a project up by hand — a name, the folder on the server it works in, and how its tile looks — or make one by
 * cloning a repository into the workspace. Both forms stay alive while the sheet is open, so switching loses nothing.
 */
export function NewProjectSheet({ open, onClose, onCreated }: NewProjectSheetProps) {
  const t = useT();
  const create = useCreateProject();
  const [draft, setDraft] = useState<ProjectDraft>(EMPTY);
  const [rootDir, setRootDir] = useState('');
  const [createDirectory, setCreateDirectory] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; rootDir?: string; form?: string }>({});
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<'manual' | 'clone'>('manual');
  const [cloning, setCloning] = useState(false);
  const clone = useRef<CloneFormHandle>(null);
  const busy = create.isPending || cloning;

  // A fresh form each time the sheet opens; the draft survives a mere dismissal mid-typing only until then.
  useEffect(() => {
    if (!open) return;
    setErrors({});
  }, [open]);

  const reset = () => {
    setDraft(EMPTY);
    setRootDir('');
    setCreateDirectory(false);
    setErrors({});
  };

  const submit = () => {
    if (busy) return;
    const found: typeof errors = {};
    if (draft.name.trim() === '') found.name = t('home.project.nameMissing');
    const folder = rootDir.trim();
    if (folder === '') found.rootDir = t('home.project.folderMissing');
    else if (!folder.startsWith('/') && !folder.startsWith('~/') && folder !== '~' && !/^[a-zA-Z]:[\\/]/.test(folder)) found.rootDir = t('errors.invalid_path');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    create.mutate(
      {
        name: draft.name.trim(),
        rootDir: folder,
        description: draft.description.trim(),
        icon: { symbol: draft.symbol, color: draft.color },
        createDirectory,
      },
      {
        onSuccess: (project) => {
          toast.success(t('home.project.created', { name: project.name }));
          reset();
          onClose();
          onCreated?.(project);
        },
        onError: (error) => {
          const text = describeError(error, t);
          if (isApiError(error) && FOLDER_CODES.has(error.code)) setErrors({ rootDir: text });
          else setErrors({ form: text });
        },
      },
    );
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title={t('home.newProject')}
        dismissible={!busy}
        fill
        leading={
          <Button variant="plain" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
        }
        trailing={
          <Button variant="plain" onClick={() => (mode === 'clone' ? clone.current?.submit() : submit())} loading={create.isPending} disabled={cloning}>
            {mode === 'clone' ? t('projects.clone.action') : t('common.create')}
          </Button>
        }
      >
        <div className="project-form__mode">
          <SegmentedControl
            label={t('projects.new.mode')}
            value={mode}
            onChange={setMode}
            disabled={busy}
            options={[
              { value: 'manual', label: t('projects.new.manual') },
              { value: 'clone', label: t('projects.new.clone') },
            ]}
          />
        </div>
        <div hidden={mode !== 'clone'}>
          <CloneForm
            ref={clone}
            onBusyChange={setCloning}
            onCreated={(project) => {
              onClose();
              onCreated?.(project);
            }}
          />
        </div>
        <Form className="project-form" onSubmit={submit} hidden={mode !== 'manual'}>
          {errors.form && (
            <Banner tone="danger" role="alert">
              {errors.form}
            </Banner>
          )}
          <ProjectFields
            draft={draft}
            onChange={(changes) => {
              setDraft((current) => ({ ...current, ...changes }));
              if (changes.name !== undefined && errors.name) setErrors((current) => ({ ...current, name: undefined }));
            }}
            nameError={errors.name}
            disabled={busy}
            autoFocusName
          >
            <div className="project-form__folder">
              <TextField
                label={t('home.project.folder')}
                value={rootDir}
                onChange={(value) => {
                  setRootDir(value);
                  if (errors.rootDir) setErrors((current) => ({ ...current, rootDir: undefined }));
                }}
                hint={t('home.project.folderHint')}
                error={errors.rootDir}
                placeholder="~/projects/my-app"
                mono
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                enterKeyHint="done"
                disabled={busy}
              />
              <Button variant="neutral" onClick={() => setPicking(true)} disabled={busy}>
                {t('home.project.browse')}
              </Button>
            </div>
            <div className="project-form__switch">
              <ListRow
                title={t('home.project.createFolder')}
                subtitle={t('home.project.createFolderHint')}
                control={<Switch checked={createDirectory} onChange={setCreateDirectory} disabled={busy} />}
              />
            </div>
          </ProjectFields>
          {/* Lets Enter in a field submit the form on a hardware keyboard. */}
          <button type="submit" hidden />
        </Form>
      </Sheet>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onChoose={(path) => {
          setRootDir(path);
          setPicking(false);
          setErrors((current) => ({ ...current, rootDir: undefined }));
          if (draft.name.trim() === '') setDraft((current) => ({ ...current, name: lastSegment(path) }));
        }}
      />
    </>
  );
}
