import { type Agent, COLLAB_LIMITS, type PermissionMode, type Project } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, Minus, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '@/data/api';
import { useProjects } from '@/data/projects';
import { useIsOwner } from '@/data/session';
import { gitApi, gitKeys } from '@/features/git/api';
import { useAgents } from '@/features/workbench/agents';
import { AgentMark } from '@/features/workbench/chat/parts';
import { modeLabel } from '@/features/workbench/chat/Pickers';
import { newRequestId } from '@/features/workbench/composer/delivery';
import { useT } from '@/i18n';
import { Banner, Button, ErrorState, IconButton, LoadingRow, SegmentedControl, Select, Sheet, Switch, TextArea, TextField, toast } from '@/ui';
import { collabApi, collabKeys } from '../api';
import { type CollabProblem, collabProblem } from '../problems';
import { PARTICIPANT_BLOCK_WORDS, TASK_PROBLEM_WORDS, type TaskDraft, initialTaskDraft, moveDraft, participantBlock, participantFor, repositoryReady, taskProblems, taskRequest, usableAgents } from './form';
import '../collab.css';

export interface TaskSheetProps {
  open: boolean;
  onClose: () => void;
  /** The project to ask in; null lets the person choose one. */
  project: Project | null;
}

/** A project where a task can be started: one the person may change, with conversations offered. */
const canAskIn = (project: Project): boolean => project.access === 'write' && !project.archived && project.features.assistant;

/**
 * "Ask several agents": one prompt to two to six agents, each in a
 * conversation of its own, followed as one task — optionally compared by one
 * more agent when all have finished.
 */
export default function TaskSheet({ open, onClose, project }: TaskSheetProps) {
  const t = useT();
  const agentsQuery = useAgents({ enabled: open });
  const projects = useProjects({ enabled: open && project === null });
  const [shown, setShown] = useState(open);
  const [locked, setLocked] = useState(false);
  if (open && !shown) setShown(true);
  const choices = useMemo(() => (project ? [project] : (projects.data ?? []).filter(canAskIn)), [project, projects.data]);

  return (
    <Sheet open={open} onClose={onClose} title={t('collab.task.newTitle')} size="lg" dismissible={!locked} onClosed={() => setShown(false)}>
      {!shown ? null : !agentsQuery.data || (project === null && !projects.data) ? (
        agentsQuery.isError || projects.isError ? (
          <ErrorState compact error={agentsQuery.error ?? projects.error} onRetry={() => void (agentsQuery.isError ? agentsQuery.refetch() : projects.refetch())} />
        ) : (
          <LoadingRow label={t('common.loading')} />
        )
      ) : (
        <TaskForm agents={agentsQuery.data} projects={choices} fixedProject={project} onClose={onClose} onSendingChange={setLocked} />
      )}
    </Sheet>
  );
}

function TaskForm({ agents, projects, fixedProject, onClose, onSendingChange }: { agents: readonly Agent[]; projects: readonly Project[]; fixedProject: Project | null; onClose: () => void; onSendingChange: (sending: boolean) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOwner = useIsOwner();
  const [draft, setDraft] = useState<TaskDraft>(() => {
    const projectId = fixedProject?.id ?? projects[0]?.id ?? null;
    const project = projects.find((entry) => entry.id === projectId) ?? null;
    return initialTaskDraft(usableAgents(agents, project), projectId);
  });
  const [requestId] = useState(newRequestId);
  const [sending, setSendingState] = useState(false);
  const [problem, setProblem] = useState<CollabProblem | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const setSending = (value: boolean) => {
    setSendingState(value);
    onSendingChange(value);
  };

  const project = projects.find((entry) => entry.id === draft.projectId) ?? null;
  const usable = useMemo(() => usableAgents(agents, project), [agents, project]);
  const blocked = agents.filter((agent) => participantBlock(agent, project) !== null && (project === null || project.agents === null || project.agents.includes(agent.id)));
  // A worktree each needs the project to be a Git repository that is ready: say so before the server has to.
  const wantsWorktrees = draft.isolation === 'worktrees' && isOwner && draft.projectId !== null;
  const repositoryQuery = useQuery({
    queryKey: gitKeys.status(draft.projectId ?? ''),
    queryFn: ({ signal }) => gitApi.status(draft.projectId!, signal),
    enabled: wantsWorktrees,
    staleTime: 15_000,
    retry: false,
  });
  const repository = wantsWorktrees ? (repositoryQuery.data ?? null) : null;
  const problems = taskProblems(draft, usable, isOwner, repository ? repositoryReady(repository) : null);
  const writers = usable.filter((agent) => agent.capabilities.permissionModes.includes('plan'));
  const change = (patch: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const agentOptions = usable.map((agent) => ({ value: agent.id, label: agent.displayName }));

  const submit = async () => {
    setShowProblems(true);
    if (problems.length > 0 || sending || !draft.projectId) return;
    setSending(true);
    setProblem(null);
    try {
      const { task } = await collabApi.createTask(draft.projectId, taskRequest(draft, requestId));
      void queryClient.invalidateQueries({ queryKey: collabKeys.tasks });
      void queryClient.invalidateQueries({ queryKey: collabKeys.running });
      queryClient.setQueryData(collabKeys.task(task.id), task);
      toast.success(t('collab.task.started', { count: t.number(task.participants.length) }));
      setSending(false);
      onClose();
      void navigate(`/tasks/${encodeURIComponent(task.id)}`);
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) setProblem(collabProblem(error, t));
      setSending(false);
    }
  };

  const visibleProblems = showProblems ? problems : [];
  return (
    <div className="cl-form">
      <p className="cl-form__lead">{t('collab.task.lead')}</p>
      {!fixedProject && (
        <label className="cl-field">
          <span className="cl-field__label">{t('collab.task.project')}</span>
          {projects.length === 0 ? (
            <p className="cl-form__note">{t('collab.task.noProjects')}</p>
          ) : (
            <Select
              label={t('collab.task.project')}
              value={draft.projectId ?? projects[0]!.id}
              onChange={(projectId) => {
                const next = projects.find((entry) => entry.id === projectId) ?? null;
                setDraft((current) => moveDraft(current, usableAgents(agents, next), projectId));
              }}
              options={projects.map((entry) => ({ value: entry.id, label: entry.name }))}
              block
              disabled={sending}
            />
          )}
        </label>
      )}

      <TextArea
        label={t('collab.task.prompt')}
        value={draft.prompt}
        onChange={(prompt) => change({ prompt })}
        autoGrow
        rows={4}
        maxRows={12}
        maxLength={COLLAB_LIMITS.taskPromptChars}
        placeholder={t('collab.task.promptPlaceholder')}
        disabled={sending}
        data-autofocus=""
        error={visibleProblems.includes('no-prompt') ? t(TASK_PROBLEM_WORDS['no-prompt']) : visibleProblems.includes('prompt-too-long') ? t(TASK_PROBLEM_WORDS['prompt-too-long']) : undefined}
      />
      <TextField
        label={t('collab.task.name')}
        optional
        value={draft.title}
        onChange={(title) => change({ title })}
        maxLength={COLLAB_LIMITS.taskTitleChars}
        hint={t('collab.task.nameHint')}
        disabled={sending}
      />

      <section className="cl-form__section" aria-labelledby="cl-task-who">
        <h3 id="cl-task-who" className="cl-form__heading">
          {t('collab.task.who', { count: t.number(draft.participants.length) })}
        </h3>
        <ol className="cl-participants">
          {draft.participants.map((participant, index) => {
            const agent = agents.find((entry) => entry.id === participant.agentId);
            const models = agent?.capabilities.models ?? [];
            const modes = (agent?.capabilities.permissionModes ?? []).map((mode) => ({ value: mode, label: modeLabel(mode, t) }));
            const update = (patch: Partial<typeof participant>) =>
              setDraft((current) => ({ ...current, participants: current.participants.map((entry) => (entry.key === participant.key ? { ...entry, ...patch } : entry)) }));
            return (
              <li key={participant.key} className="cl-participant-row">
                <span className="cl-participant-row__number" aria-hidden="true">
                  {index + 1}
                </span>
                <AgentMark agentId={participant.agentId} size={26} />
                <div className="cl-participant-row__fields">
                  <Select
                    label={t('collab.task.agentOf', { number: index + 1 })}
                    value={participant.agentId}
                    onChange={(agentId) => {
                      const next = agents.find((entry) => entry.id === agentId);
                      if (next) update({ ...participantFor(next), key: participant.key });
                    }}
                    options={agentOptions.some((option) => option.value === participant.agentId) ? agentOptions : [...agentOptions, { value: participant.agentId, label: agent?.displayName ?? participant.agentId }]}
                    block
                    disabled={sending}
                  />
                  {models.length > 0 && (
                    <Select
                      label={t('collab.task.modelOf', { number: index + 1 })}
                      value={participant.model ?? models[0]!.id}
                      onChange={(model) => update({ model })}
                      options={models.map((model) => ({ value: model.id, label: model.label }))}
                      block
                      disabled={sending}
                    />
                  )}
                  {draft.isolation === 'worktrees' && modes.length > 0 && participant.permissionMode && (
                    <Select label={t('collab.task.modeOf', { number: index + 1 })} value={participant.permissionMode} onChange={(mode: PermissionMode) => update({ permissionMode: mode })} options={modes} block disabled={sending} />
                  )}
                </div>
                {draft.participants.length > COLLAB_LIMITS.minParticipants && (
                  <IconButton
                    label={t('collab.task.removeParticipant', { number: index + 1 })}
                    icon={<Minus size={18} />}
                    tone="secondary"
                    disabled={sending}
                    onClick={() => setDraft((current) => ({ ...current, participants: current.participants.filter((entry) => entry.key !== participant.key) }))}
                  />
                )}
              </li>
            );
          })}
        </ol>
        {draft.participants.length < COLLAB_LIMITS.maxParticipants && usable.length > 0 && (
          <Button
            variant="plain"
            size="sm"
            icon={<Plus size={16} />}
            disabled={sending}
            onClick={() => {
              const used = new Set(draft.participants.map((participant) => participant.agentId));
              const next = usable.find((agent) => !used.has(agent.id)) ?? usable[0]!;
              setDraft((current) => ({ ...current, participants: [...current.participants, participantFor(next)] }));
            }}
          >
            {t('collab.task.addParticipant')}
          </Button>
        )}
        {usable.length === 0 && <p className="cl-form__error">{t('collab.task.noAgents')}</p>}
        {blocked.length > 0 && (
          <p className="cl-form__note">
            {t('collab.task.unavailable', { agents: t.list(blocked.map((agent) => `${agent.displayName} (${t(PARTICIPANT_BLOCK_WORDS[participantBlock(agent, project)!])})`)) })}
          </p>
        )}
        {visibleProblems
          .filter((entry) => entry === 'too-few' || entry === 'too-many' || entry === 'participant-unusable')
          .map((entry) => (
            <p key={entry} className="cl-form__error" role="alert">
              {t(TASK_PROBLEM_WORDS[entry])}
            </p>
          ))}
      </section>

      <section className="cl-form__section" aria-labelledby="cl-task-where">
        <h3 id="cl-task-where" className="cl-form__heading">
          {t('collab.task.where')}
        </h3>
        <SegmentedControl
          label={t('collab.task.where')}
          value={draft.isolation}
          onChange={(isolation) => change({ isolation })}
          disabled={sending}
          options={[
            { value: 'shared', label: t('collab.task.shared'), icon: <Users size={16} aria-hidden="true" /> },
            { value: 'worktrees', label: t('collab.task.worktrees'), icon: <FolderGit2 size={16} aria-hidden="true" />, disabled: !isOwner },
          ]}
        />
        <p className="cl-form__note">{draft.isolation === 'shared' ? t('collab.task.sharedText') : t('collab.task.worktreesText')}</p>
        {!isOwner && <p className="cl-form__note">{t('collab.task.worktreesOwnerOnly')}</p>}
        {problems.includes('needs-repository') && (
          <p className="cl-form__error" role="alert">
            {t(TASK_PROBLEM_WORDS['needs-repository'], { project: project?.name ?? '' })}
            {repository?.state !== 'none' && repository?.message ? ` ${repository.message}` : ''}
          </p>
        )}
      </section>

      <section className="cl-form__section">
        <label className="cl-switch-row">
          <span className="cl-switch-row__text">
            <strong>{t('collab.task.synthesis')}</strong>
            <span>{t('collab.task.synthesisText')}</span>
          </span>
          <Switch checked={draft.synthesis} onChange={(synthesis) => change({ synthesis })} disabled={sending || writers.length === 0} label={t('collab.task.synthesis')} />
        </label>
        {draft.synthesis && writers.length > 0 && (
          <div className="cl-form__row">
            <label className="cl-field">
              <span className="cl-field__label">{t('collab.task.synthesisAgent')}</span>
              <Select
                label={t('collab.task.synthesisAgent')}
                value={draft.synthesisAgentId ?? writers[0]!.id}
                onChange={(synthesisAgentId) => change({ synthesisAgentId, synthesisModel: null })}
                options={writers.map((agent) => ({ value: agent.id, label: agent.displayName }))}
                block
                disabled={sending}
              />
            </label>
          </div>
        )}
        {visibleProblems.includes('synthesis-unusable') && (
          <p className="cl-form__error" role="alert">
            {t(TASK_PROBLEM_WORDS['synthesis-unusable'])}
          </p>
        )}
      </section>

      <div className="cl-form__actions">
        {/* Beside the button that was pressed, so it is seen however far the sheet was scrolled. */}
        {problem && (
          <Banner tone="danger" role="alert">
            {problem.text}
          </Banner>
        )}
        <Button variant="primary" icon={<Users size={18} />} onClick={() => void submit()} loading={sending} loadingLabel={t('collab.task.starting')} block disabled={usable.length === 0}>
          {t('collab.task.submit', { count: t.number(draft.participants.length) })}
        </Button>
        <Button variant="plain" onClick={onClose} disabled={sending} block>
          {t('common.cancel')}
        </Button>
        <p className="cl-form__note">{t('collab.task.deleteNote')}</p>
      </div>
    </div>
  );
}
