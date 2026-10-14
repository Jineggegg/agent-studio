import { type CloneJob, PROJECT_CLONE_UPDATED, type Project, cloneJobSchema, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { projectKeys } from '@/data/projects';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { FolderPicker } from '@/features/home/FolderPicker';
import { type MessageKey, hasMessage, useT } from '@/i18n';
import { Banner, Button, Form, ProgressLine, TextField, toast } from '@/ui';
import { projectsApi } from './api';
import { type CloneAddressProblem, cloneAddressProblem, repositoryName } from './copy';
import './clone.css';

export interface CloneFormHandle {
  submit(): void;
}

export interface CloneFormProps {
  onCreated: (project: Project) => void;
  /** A clone is being started or is running: the sheet must not be dismissed by accident. */
  onBusyChange: (busy: boolean) => void;
  ref?: Ref<CloneFormHandle>;
}

const ADDRESS_PROBLEM: Record<CloneAddressProblem, MessageKey> = {
  empty: 'projects.clone.problem.empty',
  spaces: 'projects.clone.problem.spaces',
  scheme: 'projects.clone.problem.scheme',
  credentials: 'projects.clone.problem.credentials',
};
/** Git's last line rarely ends like a sentence; the one after it should still read as a new one. */
const asSentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** Refusals that are about where the clone goes, shown under that field. */
const FOLDER_CODES = new Set(['invalid_path', 'folder_missing', 'outside_workspace', 'folder_not_allowed', 'target_exists', 'project_exists', 'no_workspace_root']);

/**
 * Make a project from a repository: the server clones it into a folder of the
 * workspace and registers that folder. Progress arrives live; closing the
 * page does not stop the clone, cancelling does — and a clone that fails or
 * is cancelled leaves no half-made folder behind.
 */
export function CloneForm({ onCreated, onBusyChange, ref }: CloneFormProps) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [directoryName, setDirectoryName] = useState('');
  const [name, setName] = useState('');
  const [errors, setErrors] = useState<{ url?: string; parentDir?: string; directoryName?: string; form?: string }>({});
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState<CloneJob | null>(null);
  const [picking, setPicking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const finished = useRef<string | null>(null);

  const running = job?.state === 'running';
  const busy = starting || running;
  useEffect(() => {
    onBusyChange(busy);
    // Only the fact matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // Progress is pushed on the user's own topic…
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type !== PROJECT_CLONE_UPDATED) return;
    const parsed = cloneJobSchema.safeParse(event.data);
    if (parsed.success) setJob((current) => (current && current.id === parsed.data.id ? parsed.data : current));
  });
  // …and asked for now and then as well, in case the live connection was away at the wrong moment.
  const polled = useQuery({
    queryKey: ['projects', 'clone', job?.id ?? ''],
    queryFn: ({ signal }) => projectsApi.cloneJob(job!.id, signal),
    enabled: running,
    refetchInterval: running ? 2500 : false,
    retry: false,
    gcTime: 0,
  });
  useEffect(() => {
    if (polled.data) setJob((current) => (current && current.id === polled.data.id && current.state === 'running' ? polled.data : current));
  }, [polled.data]);

  useEffect(() => {
    if (!job || job.state === 'running' || finished.current === job.id) return;
    finished.current = job.id;
    if (job.state === 'done' && job.project) {
      void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      toast.success(t('projects.clone.done', { name: job.project.name }));
      setJob(null);
      setUrl('');
      setDirectoryName('');
      setName('');
      onCreated(job.project);
    } else if (job.state === 'failed') {
      const code = job.error?.code ?? '';
      const key = `errors.${code}`;
      // A clone that failed for no recognised reason comes with the server's one sentence and nothing more to unfold.
      const reason = code !== 'git_failed' && hasMessage(key) ? t(key) : (job.error?.message ?? t('projects.clone.failed'));
      setErrors({ form: `${asSentence(reason)} ${t('projects.clone.nothingLeft')}` });
      setJob(null);
    } else {
      setErrors({ form: `${t('projects.clone.cancelled')} ${t('projects.clone.nothingLeft')}` });
      setJob(null);
    }
  }, [job, onCreated, queryClient, t]);

  const submit = async () => {
    if (busy) return;
    const problem = cloneAddressProblem(url);
    if (problem) return setErrors({ url: t(ADDRESS_PROBLEM[problem]) });
    const folder = parentDir.trim();
    if (folder !== '' && !folder.startsWith('/') && !folder.startsWith('~')) return setErrors({ parentDir: t('errors.invalid_path') });
    setErrors({});
    setStarting(true);
    try {
      setJob(await projectsApi.clone({ url: url.trim(), ...(folder ? { parentDir: folder } : {}), ...(directoryName.trim() ? { directoryName: directoryName.trim() } : {}), ...(name.trim() ? { name: name.trim() } : {}) }));
    } catch (error) {
      if (isApiError(error) && error.code === 'reauth_cancelled') return;
      const text = describeError(error, t);
      if (isApiError(error) && error.code === 'invalid_repository_url') setErrors({ url: error.message || text });
      else if (isApiError(error) && error.code === 'invalid_directory_name') setErrors({ directoryName: text });
      else if (isApiError(error) && FOLDER_CODES.has(error.code)) setErrors({ parentDir: text });
      else setErrors({ form: text });
    } finally {
      setStarting(false);
    }
  };
  useImperativeHandle(ref, () => ({ submit: () => void submit() }));

  const cancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await projectsApi.cancelClone(job.id);
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setCancelling(false);
    }
  };

  if (job && running) {
    return (
      <div className="proj-clone" role="status" aria-live="polite">
        <p className="proj-clone__title">{t('projects.clone.running')}</p>
        <p className="proj-clone__url u-mono">{job.url}</p>
        <ProgressLine inline active {...(job.percent === null ? {} : { value: job.percent / 100 })} label={t('projects.clone.progress')} />
        <p className="proj-clone__phase">
          {job.phase || t('projects.clone.starting')}
          {job.percent !== null ? ` — ${job.percent}%` : ''}
        </p>
        <p className="proj-clone__target">{t('projects.clone.into', { folder: job.targetDir })}</p>
        <Button variant="neutral" loading={cancelling} onClick={() => void cancel()}>
          {t('projects.clone.cancel')}
        </Button>
        <p className="ui-list__footer">{t('projects.clone.runningNote')}</p>
      </div>
    );
  }

  const suggested = repositoryName(url);
  return (
    <>
      <Form className="project-form" onSubmit={() => void submit()}>
        {errors.form && (
          <Banner tone="danger" role="alert">
            {errors.form}
          </Banner>
        )}
        <TextField
          label={t('projects.clone.url')}
          value={url}
          onChange={(value) => {
            setUrl(value);
            if (errors.url) setErrors((current) => ({ ...current, url: undefined }));
          }}
          error={errors.url}
          hint={t('projects.clone.urlHint')}
          placeholder="https://github.com/owner/repository.git"
          mono
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="next"
          disabled={busy}
          maxLength={500}
          data-autofocus=""
        />
        <div className="project-form__folder">
          <TextField
            label={t('projects.clone.parent')}
            optional
            value={parentDir}
            onChange={(value) => {
              setParentDir(value);
              if (errors.parentDir) setErrors((current) => ({ ...current, parentDir: undefined }));
            }}
            error={errors.parentDir}
            hint={t('projects.clone.parentHint')}
            placeholder="~/projects"
            mono
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="next"
            disabled={busy}
          />
          <Button variant="neutral" onClick={() => setPicking(true)} disabled={busy}>
            {t('home.project.browse')}
          </Button>
        </div>
        <TextField
          label={t('projects.clone.directory')}
          optional
          value={directoryName}
          onChange={(value) => {
            setDirectoryName(value);
            if (errors.directoryName) setErrors((current) => ({ ...current, directoryName: undefined }));
          }}
          error={errors.directoryName}
          hint={suggested ? t('projects.clone.directoryHint', { name: suggested }) : t('projects.clone.directoryHintEmpty')}
          placeholder={suggested || undefined}
          mono
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          enterKeyHint="next"
          disabled={busy}
          maxLength={100}
        />
        <TextField label={t('home.project.name')} optional value={name} onChange={setName} hint={t('projects.clone.nameHint')} maxLength={80} enterKeyHint="done" disabled={busy} />
        <p className="ui-list__footer">{t('projects.clone.credentialsNote')}</p>
        <button type="submit" hidden />
      </Form>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        onChoose={(path) => {
          setParentDir(path);
          setPicking(false);
          setErrors((current) => ({ ...current, parentDir: undefined }));
        }}
      />
    </>
  );
}
