import type { Agent, PermissionMode, Project } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FilePen, Map as MapIcon, ShieldQuestion, TriangleAlert, Zap } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { useIsOwner } from '@/data/session';
import { type MessageKey, type Translator, useT } from '@/i18n';
import { useCanHover } from '@/platform/media';
import { Badge, Banner, Menu, Switch, toast } from '@/ui';
import { type Unavailable, agentUnavailable, agentsFor, findModel, modelLabel, useProjectAgentSettings } from '../agents';
import { workbenchApi } from '../api';
import { workbenchKeys } from '../sessions/queries';
import { AdaptivePopover, AgentMark, ChoiceRow } from './parts';

// ---- permission mode -----------------------------------------------------------------

const MODE_ICONS: Record<PermissionMode, ReactNode> = {
  plan: <MapIcon size={18} aria-hidden="true" />,
  ask: <ShieldQuestion size={18} aria-hidden="true" />,
  'accept-edits': <FilePen size={18} aria-hidden="true" />,
  auto: <Zap size={18} aria-hidden="true" />,
};

const MODE_LABELS: Record<PermissionMode, MessageKey> = {
  plan: 'workbench.mode.plan',
  ask: 'workbench.mode.ask',
  'accept-edits': 'workbench.mode.accept-edits',
  auto: 'workbench.mode.auto',
};

const MODE_HINTS: Record<PermissionMode, MessageKey> = {
  plan: 'workbench.mode.plan.hint',
  ask: 'workbench.mode.ask.hint',
  'accept-edits': 'workbench.mode.accept-edits.hint',
  auto: 'workbench.mode.auto.hint',
};

export const modeLabel = (mode: PermissionMode, t: Translator): string => t(MODE_LABELS[mode]);
export const modeHint = (mode: PermissionMode, t: Translator): string => t(MODE_HINTS[mode]);

export interface ModeSwitcherProps {
  /** The mode chosen for the conversation. */
  mode: PermissionMode;
  /** The mode runs really use: `auto` falls back to `ask` where the project has not enabled it. */
  effective: PermissionMode;
  agent: Agent | undefined;
  project: Project | null;
  disabled?: boolean;
  onChange: (mode: PermissionMode) => void;
}

/**
 * How much the agent may do without asking, in plain words. `auto` is set
 * apart: it comes with a warning, and it works only where the owner has
 * allowed it for the project — which is said, and can be changed here by the
 * owner, rather than left as a choice that silently does something else.
 */
export function ModeSwitcher({ mode, effective, agent, project, disabled, onChange }: ModeSwitcherProps) {
  const t = useT();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const canHover = useCanHover();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const settings = useProjectAgentSettings(open && project ? project.id : null);
  const modes = agent?.capabilities.permissionModes ?? [mode];
  const autoEnabled = settings.data?.autoMode ?? effective === 'auto';
  const downgraded = mode === 'auto' && effective !== 'auto';

  const setAutoAllowed = async (allowed: boolean) => {
    if (!project || saving) return;
    setSaving(true);
    try {
      const saved = await workbenchApi.saveProjectSettings(project.id, { autoMode: allowed });
      queryClient.setQueryData(workbenchKeys.projectSettings(project.id), saved);
      // Sessions report the mode they really run in; read them again.
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.all, predicate: (query) => query.queryKey[1] === 'session' || query.queryKey[1] === 'sessions' });
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="wb-mode"
        data-mode={mode}
        data-downgraded={downgraded || undefined}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('workbench.mode.button', { mode: modeLabel(mode, t) })}
        title={t('workbench.mode.button', { mode: modeLabel(mode, t) })}
        onClick={() => setOpen(!open)}
      >
        {MODE_ICONS[mode]}
        <span className="wb-mode__label">{modeLabel(mode, t)}</span>
        {downgraded && <TriangleAlert className="wb-mode__warn" size={14} aria-hidden="true" />}
      </button>
      <AdaptivePopover open={open} onClose={() => setOpen(false)} anchor={anchor} title={t('workbench.mode.sheetTitle')} align="end" width={380}>
        <div className="wb-choices" role="radiogroup" aria-label={t('workbench.mode.title')}>
          {modes.map((option) => {
            const auto = option === 'auto';
            const blocked = auto && project !== null && settings.data !== undefined && !autoEnabled;
            return (
              <ChoiceRow
                key={option}
                selected={option === mode}
                disabled={blocked && option !== mode}
                tone={auto ? 'warning' : 'default'}
                icon={MODE_ICONS[option]}
                title={t(MODE_LABELS[option])}
                description={t(MODE_HINTS[option])}
                onSelect={() => {
                  setOpen(false);
                  if (option !== mode) onChange(option);
                }}
              />
            );
          })}
        </div>
        {modes.includes('auto') && (
          <div className="wb-mode__auto">
            <Banner tone="warning" title={t('workbench.mode.auto.warningTitle')}>
              {t('workbench.mode.auto.warning')}
            </Banner>
            {project === null ? null : isOwner ? (
              <label className="wb-mode__allow">
                <span>
                  <strong>{t('workbench.mode.auto.allow', { project: project.name })}</strong>
                  <span>{autoEnabled ? t('workbench.mode.auto.allowedHint') : t('workbench.mode.auto.notAllowedHint')}</span>
                </span>
                <Switch checked={autoEnabled} disabled={saving || settings.data === undefined} onChange={(allowed) => void setAutoAllowed(allowed)} label={t('workbench.mode.auto.allow', { project: project.name })} />
              </label>
            ) : (
              !autoEnabled && settings.data !== undefined && <p className="wb-mode__note">{t('workbench.mode.auto.ownerOnly', { project: project.name })}</p>
            )}
            {downgraded && <p className="wb-mode__note">{t('workbench.mode.auto.downgraded', { mode: modeLabel(effective, t) })}</p>}
          </div>
        )}
        {canHover && <p className="wb-mode__shortcut">{t('workbench.mode.shortcut')}</p>}
      </AdaptivePopover>
    </>
  );
}

// ---- agent and model -------------------------------------------------------------------

const UNAVAILABLE: Record<Exclude<Unavailable, null>, MessageKey> = {
  'not-installed': 'workbench.agent.notInstalled',
  'not-signed-in': 'workbench.agent.notSignedIn',
  'not-offered': 'workbench.agent.notOffered',
  'read-only': 'workbench.agent.readOnly',
};

/** Why an agent cannot be used, in words: the server's own sentence when it gave one. */
export function unavailableText(agent: Agent, reason: Exclude<Unavailable, null>, t: Translator): string {
  if ((reason === 'not-installed' || reason === 'not-signed-in') && agent.status.problem) return agent.status.problem;
  return t(UNAVAILABLE[reason]);
}

export interface AgentModelChipProps {
  agents: readonly Agent[];
  project: Pick<Project, 'agents' | 'access'> | null;
  agentId: string | null;
  model: string | null;
  /** The conversation has started: its agent is fixed, only the model can change. */
  locked: boolean;
  disabled?: boolean;
  onChoose: (agentId: string, model: string | null) => void;
}

/**
 * The one place the agent and its model are chosen. Before the first message
 * any agent the project offers can be picked; one that cannot run is listed
 * with the reason and cannot be chosen. Once a conversation has started its
 * agent stays, and only its models are listed.
 */
export function AgentModelChip({ agents, project, agentId, model, locked, disabled, onChoose }: AgentModelChipProps) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const current = agents.find((agent) => agent.id === agentId);
  const listed = locked ? (current ? [current] : []) : agentsFor(agents, project);
  const label = current ? `${current.displayName}${model ? ` · ${modelLabel(current, model)}` : ''}` : t('workbench.agent.choose');

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="wb-chip wb-chip--agent"
        disabled={disabled || listed.length === 0}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('workbench.agent.button', { current: label })}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        {current && <AgentMark agentId={current.id} size={20} />}
        <span className="u-truncate">{current ? (model ? modelLabel(current, model) : current.displayName) : t('workbench.agent.choose')}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <AdaptivePopover open={open} onClose={() => setOpen(false)} anchor={anchor} title={locked ? t('workbench.agent.modelTitle') : t('workbench.agent.title')} width={360}>
        <div className="wb-choices">
          {listed.map((agent) => {
            const reason = locked ? null : agentUnavailable(agent, project);
            const models = agent.capabilities.models;
            return (
              <section key={agent.id} className="wb-agent" data-unavailable={reason !== null || undefined} aria-label={agent.displayName}>
                <header className="wb-agent__head">
                  <AgentMark agentId={agent.id} size={26} />
                  <div className="wb-agent__text">
                    <p className="wb-agent__name">{agent.displayName}</p>
                    <p className="wb-agent__status" data-tone={reason ? 'warning' : undefined}>
                      {reason ? unavailableText(agent, reason, t) : [agent.status.version, agent.status.account].filter(Boolean).join(' · ') || t('workbench.agent.ready')}
                    </p>
                  </div>
                  {reason && <Badge tone="warning">{t('workbench.agent.unavailable')}</Badge>}
                </header>
                <div role="radiogroup" aria-label={t('workbench.agent.modelsOf', { agent: agent.displayName })}>
                  {models.length === 0 ? (
                    <ChoiceRow
                      selected={agent.id === agentId}
                      disabled={reason !== null}
                      title={t('workbench.agent.defaultModel')}
                      onSelect={() => {
                        setOpen(false);
                        onChoose(agent.id, null);
                      }}
                    />
                  ) : (
                    models.map((option) => (
                      <ChoiceRow
                        key={option.id}
                        selected={agent.id === agentId && option.id === model}
                        disabled={reason !== null}
                        title={option.label}
                        description={option.description}
                        badge={option.recommended ? <Badge tone="accent">{t('workbench.agent.recommended')}</Badge> : undefined}
                        onSelect={() => {
                          setOpen(false);
                          if (agent.id !== agentId || option.id !== model) onChoose(agent.id, option.id);
                        }}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
        {locked && <p className="wb-mode__shortcut">{t('workbench.agent.lockedHint')}</p>}
      </AdaptivePopover>
    </>
  );
}

const EFFORT_LABELS: Record<string, MessageKey> = {
  minimal: 'workbench.effort.minimal',
  low: 'workbench.effort.low',
  medium: 'workbench.effort.medium',
  high: 'workbench.effort.high',
  xhigh: 'workbench.effort.xhigh',
  max: 'workbench.effort.max',
};

export const effortLabel = (effort: string, t: Translator): string => {
  const key = EFFORT_LABELS[effort.toLowerCase()];
  return key ? t(key) : effort;
};

/** How hard the model should think, for models that have levels. Absent for those that do not. */
export function EffortChip({ agent, model, effort, disabled, onChoose }: { agent: Agent | undefined; model: string | null; effort: string | null; disabled?: boolean; onChoose: (effort: string) => void }) {
  const t = useT();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const option = findModel(agent, model);
  const efforts = option?.efforts ?? [];
  if (efforts.length === 0) return null;
  const current = effort !== null && efforts.includes(effort) ? effort : (option?.defaultEffort ?? efforts[0]!);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="wb-chip"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workbench.effort.button', { effort: effortLabel(current, t) })}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setOpen(!open)}
      >
        <span className="u-truncate">{effortLabel(current, t)}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        label={t('workbench.effort.title')}
        items={efforts.map((level) => ({
          id: level,
          label: effortLabel(level, t),
          ...(level === option?.defaultEffort ? { hint: t('workbench.effort.default') } : {}),
          checked: level === current,
          onSelect: () => {
            if (level !== current) onChoose(level);
          },
        }))}
      />
    </>
  );
}
