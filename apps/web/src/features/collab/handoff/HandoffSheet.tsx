import type { Agent, HandoffInput, HandoffResponse, PermissionMode, Project, Session } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BookText, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { isApiError } from '@/data/api';
import { useAgents } from '@/features/workbench/agents';
import { AgentMark, ChoiceRow } from '@/features/workbench/chat/parts';
import { modeLabel } from '@/features/workbench/chat/Pickers';
import { newRequestId } from '@/features/workbench/composer/delivery';
import { workbenchPaths } from '@/features/workbench/routes';
import { upsertSession } from '@/features/workbench/sessions/queries';
import { useT } from '@/i18n';
import { Banner, Button, ErrorState, LoadingRow, SegmentedControl, Select, Sheet, TextArea, toast } from '@/ui';
import { collabKeys, collabApi } from '../api';
import { type CollabProblem, collabProblem } from '../problems';
import { DRAFT_PROBLEM_WORDS, type HandoffDraft, TARGET_BLOCK_WORDS, carriedMode, defaultModel, draftProblem, handoffRequest, handoffTargets, initialDraft, summaryWriters } from './form';

export interface HandoffSheetProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  project: Project | null;
  /** A reply is running in the conversation: the server would refuse. */
  busy: boolean;
}

const DEFAULT_MODEL = '';

/**
 * "Continue with another agent": a new conversation in the same project
 * with the agent chosen here, begun with a brief of this one — the digest
 * the Studio builds by rule, or a summary a model writes from it. This
 * conversation stays as it is.
 */
export function HandoffSheet({ open, onClose, session, project, busy }: HandoffSheetProps) {
  const t = useT();
  const agentsQuery = useAgents({ enabled: open });
  const agents = agentsQuery.data;
  const [shown, setShown] = useState(open);
  const [locked, setLocked] = useState(false);
  if (open && !shown) setShown(true);

  return (
    <Sheet open={open} onClose={onClose} title={t('collab.handoff.title')} size="lg" dismissible={!locked} onClosed={() => setShown(false)}>
      {!shown ? null : !agents ? (
        agentsQuery.isError ? (
          <ErrorState compact error={agentsQuery.error} onRetry={() => void agentsQuery.refetch()} retrying={agentsQuery.isFetching} />
        ) : (
          <LoadingRow label={t('common.loading')} />
        )
      ) : (
        <HandoffForm session={session} project={project} busy={busy} agents={agents} onClose={onClose} onSendingChange={setLocked} />
      )}
    </Sheet>
  );
}

function HandoffForm({ session, project, busy, agents, onClose, onSendingChange }: { session: Session; project: Project | null; busy: boolean; agents: readonly Agent[]; onClose: () => void; onSendingChange: (sending: boolean) => void }) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const targets = useMemo(() => handoffTargets(agents, project, session.agentId), [agents, project, session.agentId]);
  const writers = useMemo(() => summaryWriters(agents, project), [agents, project]);
  const [draft, setDraft] = useState<HandoffDraft>(() => initialDraft(targets, session.permissionMode, writers));
  // One id for this sheet: sending again after a lost answer makes the same handoff, not a second one.
  const [requestId] = useState(newRequestId);
  const [sending, setSendingState] = useState(false);
  const setSending = (value: boolean) => {
    setSendingState(value);
    onSendingChange(value);
  };
  const [problem, setProblem] = useState<CollabProblem | null>(null);
  const [showProblems, setShowProblems] = useState(false);

  const target = agents.find((agent) => agent.id === draft.agentId);
  const writer = agents.find((agent) => agent.id === draft.summaryAgentId);
  const invalid = draftProblem(draft, targets, writers);
  const sourceAgent = agents.find((agent) => agent.id === session.agentId);
  const change = (patch: Partial<HandoffDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const chooseTarget = (agent: Agent) => change({ agentId: agent.id, model: defaultModel(agent), permissionMode: carriedMode(agent, session.permissionMode) });

  const submit = async () => {
    setShowProblems(true);
    if (invalid || sending || busy) return;
    setSending(true);
    setProblem(null);
    let response: HandoffResponse;
    try {
      const request: HandoffInput = handoffRequest(draft, requestId);
      response = await collabApi.handOff(session.id, request);
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) setProblem(collabProblem(error, t));
      setSending(false);
      return;
    }
    upsertSession(queryClient, response.session);
    void queryClient.invalidateQueries({ queryKey: collabKeys.all });
    const { summary } = response.handoff;
    if (summary.requested && summary.status !== 'written') {
      toast.show({ title: t('collab.handoff.digestUsed'), ...(summary.reason ? { detail: summary.reason } : {}) });
    } else {
      toast.success(t('collab.handoff.done', { agent: response.handoff.target.agentName }));
    }
    if (response.startProblem) toast.warning(t('collab.handoff.notStarted'), { detail: response.startProblem });
    setSending(false);
    onClose();
    void navigate(workbenchPaths.session(response.session.projectId, response.session.id), { replace: true });
  };

  const modelOptions = target ? target.capabilities.models.map((model) => ({ value: model.id, label: model.label, ...(model.description ? { hint: model.description } : {}) })) : [];
  const modeOptions = target ? target.capabilities.permissionModes.map((mode) => ({ value: mode, label: modeLabel(mode, t) })) : [];
  const writerModels = writer ? [{ value: DEFAULT_MODEL, label: t('collab.handoff.writerDefaultModel') }, ...writer.capabilities.models.map((model) => ({ value: model.id, label: model.label }))] : [];

  return (
    <div className="cl-form">
      <p className="cl-form__lead">{t('collab.handoff.lead', { agent: sourceAgent?.displayName ?? session.agentId })}</p>
      {busy && (
        <Banner tone="warning" title={t('collab.handoff.busyTitle')}>
          {t('collab.handoff.busy')}
        </Banner>
      )}

      <section className="cl-form__section" aria-labelledby="cl-handoff-who">
        <h3 id="cl-handoff-who" className="cl-form__heading">
          {t('collab.handoff.who')}
        </h3>
        <div className="wb-choices" role="radiogroup" aria-labelledby="cl-handoff-who">
          {targets.map(({ agent, blocked }) => (
            <ChoiceRow
              key={agent.id}
              selected={agent.id === draft.agentId}
              disabled={blocked !== null || sending}
              icon={<AgentMark agentId={agent.id} size={26} />}
              title={agent.displayName}
              description={blocked ? t(TARGET_BLOCK_WORDS[blocked]) : [agent.status.version, agent.status.account].filter(Boolean).join(' · ') || t('workbench.agent.ready')}
              onSelect={() => chooseTarget(agent)}
            />
          ))}
        </div>
        {target && (
          <div className="cl-form__row">
            {modelOptions.length > 0 ? (
              <label className="cl-field">
                <span className="cl-field__label">{t('collab.handoff.model')}</span>
                <Select label={t('collab.handoff.model')} value={draft.model ?? modelOptions[0]!.value} onChange={(model) => change({ model })} options={modelOptions} block disabled={sending} />
              </label>
            ) : (
              <p className="cl-form__note">{t('workbench.agent.defaultModel')}</p>
            )}
            {modeOptions.length > 0 && draft.permissionMode && (
              <label className="cl-field">
                <span className="cl-field__label">{t('collab.handoff.mode')}</span>
                <Select label={t('collab.handoff.mode')} value={draft.permissionMode} onChange={(mode: PermissionMode) => change({ permissionMode: mode })} options={modeOptions} block disabled={sending} />
              </label>
            )}
          </div>
        )}
        {showProblems && invalid && (invalid === 'no-agent' || invalid === 'blocked-agent') && (
          <p className="cl-form__error" role="alert">
            {t(DRAFT_PROBLEM_WORDS[invalid])}
          </p>
        )}
      </section>

      <section className="cl-form__section" aria-labelledby="cl-handoff-brief">
        <h3 id="cl-handoff-brief" className="cl-form__heading">
          {t('collab.handoff.brief')}
        </h3>
        <SegmentedControl
          label={t('collab.handoff.brief')}
          value={draft.brief}
          onChange={(brief) => change({ brief })}
          disabled={sending}
          options={[
            { value: 'digest', label: t('collab.handoff.digest'), icon: <BookText size={16} aria-hidden="true" /> },
            { value: 'summary', label: t('collab.handoff.summary'), icon: <Sparkles size={16} aria-hidden="true" />, disabled: writers.length === 0 },
          ]}
        />
        <p className="cl-form__note">{draft.brief === 'digest' ? t('collab.handoff.digestText') : t('collab.handoff.summaryText')}</p>
        {writers.length === 0 && <p className="cl-form__note">{t('collab.handoff.noWriters')}</p>}
        {draft.brief === 'summary' && writers.length > 0 && (
          <div className="cl-form__row">
            <label className="cl-field">
              <span className="cl-field__label">{t('collab.handoff.writer')}</span>
              <Select
                label={t('collab.handoff.writer')}
                value={draft.summaryAgentId ?? writers[0]!.id}
                onChange={(summaryAgentId) => change({ summaryAgentId, summaryModel: null })}
                options={writers.map((agent) => ({ value: agent.id, label: agent.displayName }))}
                block
                disabled={sending}
              />
            </label>
            {writerModels.length > 1 && (
              <label className="cl-field">
                <span className="cl-field__label">{t('collab.handoff.writerModel')}</span>
                <Select label={t('collab.handoff.writerModel')} value={draft.summaryModel ?? DEFAULT_MODEL} onChange={(model) => change({ summaryModel: model === DEFAULT_MODEL ? null : model })} options={writerModels} block disabled={sending} />
              </label>
            )}
          </div>
        )}
      </section>

      <section className="cl-form__section">
        <TextArea
          label={t('collab.handoff.note')}
          optional
          value={draft.note}
          onChange={(note) => change({ note })}
          autoGrow
          maxRows={8}
          rows={3}
          maxLength={4000}
          disabled={sending}
          hint={draft.start ? t('collab.handoff.noteStart') : t('collab.handoff.noteDraft')}
          error={showProblems && invalid === 'note-too-long' ? t(DRAFT_PROBLEM_WORDS[invalid]) : undefined}
        />
        <SegmentedControl
          label={t('collab.handoff.when')}
          value={draft.start ? 'start' : 'open'}
          onChange={(value) => change({ start: value === 'start' })}
          disabled={sending}
          options={[
            { value: 'open', label: t('collab.handoff.openOnly') },
            { value: 'start', label: t('collab.handoff.startNow') },
          ]}
        />
        <p className="cl-form__note">{draft.start ? t('collab.handoff.startText') : t('collab.handoff.openText')}</p>
      </section>

      <div className="cl-form__actions">
        {/* Beside the button that was pressed, so it is seen however far the sheet was scrolled. */}
        {problem && (
          <Banner
            tone="danger"
            role="alert"
            action={
              problem.latestSessionId ? (
                <Button
                  size="sm"
                  variant="plain"
                  onClick={() => {
                    onClose();
                    void navigate(workbenchPaths.lookup(problem.latestSessionId!), { replace: true });
                  }}
                >
                  {t('collab.handoff.openLatest')}
                </Button>
              ) : undefined
            }
          >
            {problem.text}
          </Banner>
        )}
        <Button
          variant="primary"
          icon={<ArrowRight size={18} />}
          onClick={() => void submit()}
          loading={sending}
          loadingLabel={draft.brief === 'summary' ? t('collab.handoff.writing') : t('collab.handoff.sending')}
          disabled={busy}
          block
        >
          {target ? t('collab.handoff.submit', { agent: target.displayName }) : t('collab.handoff.submitGeneric')}
        </Button>
        {sending && draft.brief === 'summary' && <p className="cl-form__note">{t('collab.handoff.writingText')}</p>}
        <Button variant="plain" onClick={onClose} disabled={sending} block>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
