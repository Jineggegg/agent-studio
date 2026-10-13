import {
  AUTOMATION_EVENT,
  AUTOMATION_LIMITS,
  type Automation,
  type AutomationAction,
  type AutomationExecution,
  type AutomationGuard,
  type AutomationHistory,
  type AutomationList,
  type AutomationModeOption,
  type AutomationOptions,
  type AutomationReason,
  type AutomationTrigger,
  type CreateAutomationRequest,
  type PermissionMode,
  type ProjectAccess,
  type RunAutomationResponse,
  type SchedulePreview,
  type Session,
  type UnattendedBehaviour,
  type UpdateAutomationRequest,
  appLinks,
  toOneLine,
} from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { badRequest, conflict, describeError, forbidden, isStudioError, notFound, unprocessable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { ProjectRecord } from '../projects/projects.service.js';
import { type OverduePlan, ScheduleError, describeInstant, isScheduleTrigger, nextOccurrence, planOverdue, upcomingOccurrences, validateSchedule } from './schedule.js';
import type { AutomationRow, AutomationStore, ClaimTexts, ExecutionRow } from './store.js';
import { type AutomationTextKey, say, sayCounted } from './texts.js';

type AgentRun = Extract<AutomationAction, { type: 'agent-run' }>;

const MODES: readonly PermissionMode[] = ['plan', 'ask', 'accept-edits', 'auto'];
const BEHAVIOUR: Readonly<Record<PermissionMode, UnattendedBehaviour>> = { plan: 'read-only', ask: 'deny-and-report', 'accept-edits': 'edits-allowed', auto: 'auto' };
/** Modes that let an unattended run change things without anybody having looked: only where the owner enabled auto mode. */
const NEEDS_AUTO_MODE: ReadonlySet<PermissionMode> = new Set(['accept-edits', 'auto']);
const MODE_NAME: Readonly<Record<PermissionMode, string>> = { plan: 'plan', ask: 'ask', 'accept-edits': 'accept edits', auto: 'auto' };

const automationNotFound = () => notFound('No such automation.', 'automation_not_found');
const clipSummary = (value: string): string => toOneLine(redactSecrets(value), AUTOMATION_LIMITS.summaryChars);

export function presentExecution(row: ExecutionRow): AutomationExecution {
  return {
    id: row.id,
    automationId: row.automation_id,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    reason: row.reason,
    summary: row.summary,
    sessionId: row.session_id,
    runId: row.run_id,
  };
}

/** What `run.finished` and `run.interrupted` on `internal:runs` carry, as far as this module reads them. */
export interface RunEnded {
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly userId: string;
  readonly agentId: string;
  readonly status: 'completed' | 'failed' | 'stopped' | 'interrupted';
  readonly error: { code: string; message: string } | null;
}

/**
 * Automations: who may do what with them, how one is carried out, and how
 * the record of each execution is kept true to what really happened.
 *
 * An execution never throws to whoever triggered it and is never retried.
 */
export class AutomationService {
  readonly #context: ModuleContext;
  readonly #store: AutomationStore;
  readonly #now: () => number;
  readonly #graceMs: number;

  constructor(deps: { context: ModuleContext; store: AutomationStore; now: () => number; graceMs: number }) {
    this.#context = deps.context;
    this.#store = deps.store;
    this.#now = deps.now;
    this.#graceMs = deps.graceMs;
  }

  // ---- access ----------------------------------------------------------------

  /** Reading needs to see the project; an automation of a project the caller cannot see does not exist for them. */
  #readable(principal: Principal, projectId: string, id: string): { row: AutomationRow; project: ProjectRecord; access: ProjectAccess } {
    const projects = this.#context.services.projects;
    const project = projects.requireAccess(principal, projectId, 'read');
    const row = this.#store.find(projectId, id);
    if (!row) throw automationNotFound();
    return { row, project, access: projects.accessOf(principal, projectId) ?? 'read' };
  }

  /** Changing needs write access to the project, and the automation must be the caller's own — or the caller the instance owner. */
  #manageable(principal: Principal, projectId: string, id: string): { row: AutomationRow; project: ProjectRecord } {
    const project = this.#context.services.projects.requireAccess(principal, projectId, 'write');
    const row = this.#store.find(projectId, id);
    if (!row) throw automationNotFound();
    if (principal.role !== 'owner' && row.created_by !== principal.userId) {
      throw forbidden('Only the person who created this automation, or the owner, can change it.', 'not_your_automation');
    }
    return { row, project };
  }

  #featureOn(project: ProjectRecord): boolean {
    return this.#context.services.projects.isFeatureEnabled(project, 'automation');
  }

  /** Nothing can be created, changed or run where automations are switched off. */
  #assertUsable(project: ProjectRecord): void {
    if (!this.#featureOn(project)) throw conflict('Automations are switched off for this project.', 'automation_disabled');
    if (project.archivedAt !== null) throw conflict('This project is archived.', 'project_archived');
  }

  #announce(row: Pick<AutomationRow, 'id' | 'project_id'>, change: 'created' | 'updated' | 'removed' | 'ran'): void {
    this.#context.bus.publish(`project:${row.project_id}`, AUTOMATION_EVENT.changed, { projectId: row.project_id, automationId: row.id, change });
  }

  // ---- presenting --------------------------------------------------------------

  #autoMode(project: ProjectRecord): boolean {
    return this.#context.services.agents.sessions.autoModeEnabled(project);
  }

  /** Why a run of this automation would be refused right now; null when it would be let through. */
  #refusal(row: AutomationRow, action: AutomationAction, project: ProjectRecord): AutomationReason | null {
    const { agents, projects } = this.#context.services;
    if (!this.#featureOn(project)) return 'automation-off';
    if (project.archivedAt !== null) return 'project-archived';
    const creator = agents.principalFor(row.created_by);
    if (!creator) return 'creator-disabled';
    const access = projects.accessOf(creator, project.id);
    if (action.type === 'notify') return access === null ? 'access-lost' : null;
    if (access !== 'write') return 'access-lost';
    if (!agents.adapter(action.agentId)) return 'agent-unavailable';
    if (!projects.isAgentEnabled(project, action.agentId)) return 'agent-not-enabled';
    if (NEEDS_AUTO_MODE.has(action.permissionMode) && !this.#autoMode(project)) return 'mode-not-allowed';
    return null;
  }

  #person(userId: string): { id: string; displayName: string } {
    return { id: userId, displayName: this.#context.services.auth.findUser(userId)?.displayName ?? '' };
  }

  #guard(row: AutomationRow, action: AgentRun, project: ProjectRecord): AutomationGuard {
    const refusal = this.#refusal(row, action, project);
    return { actsAs: this.#person(row.created_by), permissionMode: action.permissionMode, behaviour: BEHAVIOUR[action.permissionMode], allowed: refusal === null, refusal };
  }

  #present(principal: Principal, row: AutomationRow, project: ProjectRecord, access: ProjectAccess): Automation {
    const trigger = JSON.parse(row.trigger) as AutomationTrigger;
    const action = JSON.parse(row.action) as AutomationAction;
    const latest = this.#store.latest(row.id);
    const enabled = row.enabled === 1;
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      enabled,
      timeZone: row.time_zone,
      trigger,
      action,
      createdBy: this.#person(row.created_by),
      canManage: access === 'write' && (principal.role === 'owner' || row.created_by === principal.userId),
      nextRunAt: row.next_run_at,
      state: !enabled ? 'off' : trigger.type === 'event' ? 'waiting' : row.next_run_at === null ? 'off' : 'scheduled',
      disabledReason: enabled ? null : row.disabled_reason,
      running: this.#store.openOf(row.id) !== undefined,
      lastRun: latest ? presentExecution(latest) : null,
      guard: action.type === 'agent-run' ? this.#guard(row, action, project) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ---- reading -----------------------------------------------------------------

  list(principal: Principal, projectId: string): AutomationList {
    const projects = this.#context.services.projects;
    const project = projects.requireAccess(principal, projectId, 'read');
    const access = projects.accessOf(principal, projectId) ?? 'read';
    return {
      automations: this.#store.ofProject(projectId).map((row) => this.#present(principal, row, project, access)),
      enabled: this.#featureOn(project),
      limit: AUTOMATION_LIMITS.perProject,
    };
  }

  get(principal: Principal, projectId: string, id: string): Automation {
    const { row, project, access } = this.#readable(principal, projectId, id);
    return this.#present(principal, row, project, access);
  }

  history(principal: Principal, projectId: string, id: string, query: { limit: number; before?: string | undefined }): AutomationHistory {
    const { row } = this.#readable(principal, projectId, id);
    const rows = this.#store.history(row.id, query.limit + 1, query.before);
    return { runs: rows.slice(0, query.limit).map(presentExecution), hasMore: rows.length > query.limit };
  }

  #modeOptions(project: ProjectRecord, supported: readonly PermissionMode[]): AutomationModeOption[] {
    const autoMode = this.#autoMode(project);
    return MODES.map((mode) => {
      const refusal = !supported.includes(mode) ? ('unsupported' as const) : NEEDS_AUTO_MODE.has(mode) && !autoMode ? ('auto-mode-off' as const) : null;
      return { mode, behaviour: BEHAVIOUR[mode], allowed: refusal === null, refusal };
    });
  }

  /** What a form may offer: which agents, and for each mode whether an unattended run may use it here. */
  async options(principal: Principal, projectId: string): Promise<AutomationOptions> {
    const { agents, projects } = this.#context.services;
    const project = projects.requireAccess(principal, projectId, 'read');
    const offered = agents.adapters().filter((adapter) => projects.isAgentEnabled(project, adapter.id));
    const described = await Promise.all(
      offered.map(async (adapter) => {
        try {
          const [status, capabilities] = await Promise.all([adapter.status(), adapter.capabilities()]);
          return {
            id: adapter.id,
            displayName: adapter.displayName,
            available: status.installed && status.problem === null,
            problem: status.problem,
            models: capabilities.models.map((model) => ({ id: model.id, label: model.label })),
            defaultModel: capabilities.defaultModel,
            modes: this.#modeOptions(project, capabilities.permissionModes),
          };
        } catch (error) {
          this.#context.log.warn({ agent: adapter.id, err: redactSecrets(describeError(error)) }, 'an agent could not describe itself');
          return { id: adapter.id, displayName: adapter.displayName, available: false, problem: 'This agent cannot be reached right now.', models: [], defaultModel: null, modes: this.#modeOptions(project, []) };
        }
      }),
    );
    return {
      enabled: this.#featureOn(project),
      canCreate: projects.accessOf(principal, projectId) === 'write',
      count: this.#store.countOfProject(projectId),
      limit: AUTOMATION_LIMITS.perProject,
      autoMode: this.#autoMode(project),
      actsAs: { id: principal.userId, displayName: principal.displayName },
      events: ['run-failed'],
      agents: described,
    };
  }

  preview(body: { timeZone: string; trigger: AutomationTrigger }): SchedulePreview {
    if (!isScheduleTrigger(body.trigger)) return { runs: [] };
    const now = this.#now();
    this.#validSchedule(body.trigger, body.timeZone, now, 'bad-request');
    return { runs: upcomingOccurrences(body.trigger, body.timeZone, now, AUTOMATION_LIMITS.previewRuns) };
  }

  // ---- validating --------------------------------------------------------------

  /** A one-off whose time has passed is a bad request when it is being set, and a conflict when an old one is being switched on. */
  #validSchedule(trigger: AutomationTrigger, timeZone: string, now: number, passed: 'bad-request' | 'conflict' | 'accept'): void {
    if (!isScheduleTrigger(trigger)) return;
    try {
      validateSchedule(trigger, timeZone, now);
    } catch (error) {
      if (!(error instanceof ScheduleError)) throw error;
      if (error.code !== 'time_passed') throw badRequest(error.message, undefined, error.code);
      if (passed === 'bad-request') throw badRequest(error.message, undefined, error.code);
      if (passed === 'conflict') throw conflict('Its time has passed. Edit the date and time first.', error.code);
    }
  }

  /**
   * An agent run must be something its creator could start by hand right now:
   * an agent offered in the project, a mode an unattended run may use here,
   * and — when it continues a session — one of the creator's own sessions in
   * this project with that agent.
   */
  async #checkAgentRun(creator: Principal, project: ProjectRecord, action: AgentRun): Promise<void> {
    const { agents, projects } = this.#context.services;
    const adapter = agents.adapter(action.agentId);
    if (!adapter) throw unprocessable('That agent is not available on this Studio.', 'agent_unavailable');
    if (!projects.isAgentEnabled(project, action.agentId)) throw unprocessable('That agent is not offered in this project.', 'agent_not_enabled');
    const capabilities = await adapter.capabilities();
    if (!capabilities.permissionModes.includes(action.permissionMode)) {
      throw unprocessable(`${adapter.displayName} does not have that permission mode.`, 'unsupported_permission_mode');
    }
    if (NEEDS_AUTO_MODE.has(action.permissionMode) && !this.#autoMode(project)) {
      throw unprocessable('An automation may use that mode only where the project’s owner has enabled auto mode.', 'mode_not_allowed');
    }
    if (action.session.type === 'existing' && !this.#usableSession(creator, project.id, action)) {
      throw unprocessable('Choose one of your own sessions in this project that uses this agent.', 'session_not_usable');
    }
  }

  #usableSession(creator: Principal, projectId: string, action: AgentRun): Session | null {
    if (action.session.type !== 'existing') return null;
    try {
      const session = this.#context.services.agents.getSession(creator, action.session.sessionId);
      return session.userId === creator.userId && session.projectId === projectId && session.agentId === action.agentId ? session : null;
    } catch {
      return null;
    }
  }

  // ---- changing ----------------------------------------------------------------

  async create(principal: Principal, projectId: string, body: CreateAutomationRequest): Promise<Automation> {
    const project = this.#context.services.projects.requireAccess(principal, projectId, 'write');
    this.#assertUsable(project);
    if (this.#store.countOfProject(projectId) >= AUTOMATION_LIMITS.perProject) {
      throw conflict(`A project can have at most ${AUTOMATION_LIMITS.perProject} automations.`, 'automation_limit');
    }
    const now = this.#now();
    this.#validSchedule(body.trigger, body.timeZone, now, 'bad-request');
    // It acts as whoever creates it; there is no way to name anybody else.
    if (body.action.type === 'agent-run') await this.#checkAgentRun(principal, project, body.action);

    const row: AutomationRow = {
      id: newId(),
      project_id: projectId,
      created_by: principal.userId,
      name: body.name,
      enabled: body.enabled ? 1 : 0,
      time_zone: body.timeZone,
      trigger: JSON.stringify(body.trigger),
      action: JSON.stringify(body.action),
      event: body.trigger.type === 'event' ? body.trigger.event : null,
      next_run_at: body.enabled && isScheduleTrigger(body.trigger) ? nextOccurrence(body.trigger, body.timeZone, now) : null,
      disabled_reason: null,
      created_at: now,
      updated_at: now,
    };
    // Counted and inserted together, so two requests at once cannot both take the last place.
    this.#context.db.transaction(() => {
      if (this.#store.countOfProject(projectId) >= AUTOMATION_LIMITS.perProject) {
        throw conflict(`A project can have at most ${AUTOMATION_LIMITS.perProject} automations.`, 'automation_limit');
      }
      this.#store.insert(row);
    });
    this.#announce(row, 'created');
    return this.#present(principal, row, project, 'write');
  }

  async update(principal: Principal, projectId: string, id: string, patch: UpdateAutomationRequest): Promise<Automation> {
    const { row, project } = this.#manageable(principal, projectId, id);
    this.#assertUsable(project);
    const now = this.#now();
    const trigger = patch.trigger ?? (JSON.parse(row.trigger) as AutomationTrigger);
    const action = patch.action ?? (JSON.parse(row.action) as AutomationAction);
    const timeZone = patch.timeZone ?? row.time_zone;
    const enabled = patch.enabled ?? row.enabled === 1;
    if (trigger.type === 'event' && action.type !== 'notify') throw badRequest('An event can only trigger a notification.', undefined, 'invalid_request');

    const scheduleChanged = patch.trigger !== undefined || patch.timeZone !== undefined;
    // A switched-off one-off may keep a time that has passed; a switched-on one may not.
    this.#validSchedule(trigger, timeZone, now, !enabled ? 'accept' : scheduleChanged ? 'bad-request' : 'conflict');

    const switchingOn = enabled && row.enabled !== 1;
    if (patch.action !== undefined || switchingOn) {
      // What it does is checked against the account it acts as — its creator — whoever edits it.
      const creator = this.#context.services.agents.principalFor(row.created_by);
      if (!creator || this.#context.services.projects.accessOf(creator, projectId) !== 'write') {
        throw conflict('The person who created this automation can no longer work in this project.', 'creator_without_access');
      }
      if (action.type === 'agent-run' && patch.action !== undefined) await this.#checkAgentRun(creator, project, action);
    }

    this.#store.update(
      row.id,
      {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        enabled: enabled ? 1 : 0,
        timeZone,
        trigger: JSON.stringify(trigger),
        action: JSON.stringify(action),
        event: trigger.type === 'event' ? trigger.event : null,
        // Editing plans the next run again; switching off clears it.
        nextRunAt: enabled && isScheduleTrigger(trigger) ? nextOccurrence(trigger, timeZone, now) : null,
        disabledReason: enabled || patch.enabled === false ? null : row.disabled_reason,
      },
      now,
    );
    this.#announce(row, 'updated');
    return this.#present(principal, this.#store.find(projectId, id)!, project, 'write');
  }

  remove(principal: Principal, projectId: string, id: string): void {
    const { row } = this.#manageable(principal, projectId, id);
    this.#store.remove(row.id);
    this.#announce(row, 'removed');
  }

  /**
   * Runs it once, now — also when it is switched off — without touching its
   * schedule. While an execution of it is in progress nothing is executed
   * and nothing is recorded.
   */
  async runNow(principal: Principal, projectId: string, id: string): Promise<RunAutomationResponse> {
    const { row, project } = this.#manageable(principal, projectId, id);
    this.#assertUsable(project);
    const execution = this.#store.claimNow(row.id, 'manual', this.#now());
    if (execution) await this.#execute(row, execution, null);
    const fresh = this.#store.find(projectId, id) ?? row;
    return { automation: this.#present(principal, fresh, project, 'write'), execution: execution ? presentExecution(this.#store.execution(execution.id) ?? execution) : null };
  }

  // ---- the scheduler's side ------------------------------------------------------

  #claimTexts(row: AutomationRow): ClaimTexts {
    const language = this.#context.services.inbox.languageOf(row.created_by);
    const when = (at: number) => describeInstant(at, row.time_zone, language);
    return {
      missed: (plan: OverduePlan) =>
        plan.earlierMissed === 0 ? say(language, 'missed.one', { when: when(plan.scheduledFor) }) : say(language, 'missed.other', { when: when(plan.scheduledFor), count: plan.earlierMissed }),
      earlierMissed: (plan: OverduePlan, dueAt: number) => sayCounted(language, 'missed.earlier', plan.earlierMissed, { when: when(dueAt) }),
      stillRunning: () => say(language, 'skipped.stillRunning'),
    };
  }

  /**
   * One pass over what is due. Each automation is claimed — in a transaction,
   * before anything is done — and only what was claimed is carried out. Two
   * passes at once therefore do the work of one.
   */
  async runDue(now: number): Promise<number> {
    let executed = 0;
    for (const id of this.#store.due(now, 50)) {
      try {
        const claim = this.#store.claimDue(
          id,
          now,
          (row) => planOverdue({ trigger: JSON.parse(row.trigger) as Exclude<AutomationTrigger, { type: 'event' }>, timeZone: row.time_zone, dueAt: row.next_run_at!, now, graceMs: this.#graceMs }),
          this.#claimTexts(this.#store.byId(id)!),
        );
        if (claim.kind === 'nothing') continue;
        if (claim.kind === 'run') {
          await this.#execute(claim.automation, claim.execution, null);
          executed += 1;
        } else {
          this.#store.pruneHistory(id, AUTOMATION_LIMITS.historyPerAutomation);
        }
        this.#announce(claim.automation, 'ran');
      } catch (error) {
        this.#context.log.error({ automationId: id, err: redactSecrets(describeError(error)) }, 'an automation could not be processed');
      }
    }
    return executed;
  }

  /** At start-up: whatever was open when the previous process ended is closed as interrupted. Nothing is run from it. */
  recover(): number {
    const now = this.#now();
    let closed = 0;
    for (const execution of this.#store.openExecutions()) {
      const row = this.#store.byId(execution.automation_id);
      const language = row ? this.#context.services.inbox.languageOf(row.created_by) : 'en';
      const summary = say(language, execution.run_id === null ? 'failed.interruptedBeforeStart' : 'failed.interrupted');
      if (this.#store.finish(execution.id, { outcome: 'failed', reason: 'interrupted', summary, endedAt: now })) closed += 1;
    }
    return closed;
  }

  /** A request of an unattended run needed approval and was denied because nobody was there. */
  approvalSkipped(runId: string): void {
    this.#store.countDenied(runId);
  }

  /** A run ended. If one of our executions started it, the record now says how it really went. */
  runEnded(event: RunEnded): void {
    const execution = this.#store.openByRun(event.runId);
    if (execution) this.#close(execution, event);
    // A run cut short by a restart has its own notice; "a run failed" means a run that ended in an error.
    if (event.projectId !== null && event.status === 'failed') this.#fireEvent(event);
  }

  /** A person lost write access to a project: what they created there is switched off. */
  accessChanged(projectId: string, userId: string, access: ProjectAccess | null): void {
    if (access === 'write' || this.#context.services.auth.findUser(userId)?.role === 'owner') return;
    for (const row of this.#store.disableOfCreator(projectId, userId, 'access-lost', this.#now())) this.#announce(row, 'updated');
  }

  // ---- carrying one out ------------------------------------------------------------

  #end(row: AutomationRow, execution: ExecutionRow, outcome: AutomationExecution['outcome'], reason: AutomationReason | null, summary: string): void {
    if (this.#store.finish(execution.id, { outcome, reason, summary: clipSummary(summary), endedAt: this.#now() })) {
      this.#store.pruneHistory(row.id, AUTOMATION_LIMITS.historyPerAutomation);
      this.#announce(row, 'ran');
    }
  }

  /** Tells the creator what became of an agent run, through their own switches. Never throws. */
  async #tell(row: AutomationRow, project: ProjectRecord, kind: 'background-finished' | 'run-failed', body: AutomationTextKey, detail: string | null, sessionId: string | null, runId: string | null): Promise<void> {
    const inbox = this.#context.services.inbox;
    try {
      await inbox.notify(row.created_by, {
        kind,
        title: project.name,
        body: say(inbox.languageOf(row.created_by), body, { name: row.name }),
        detail,
        link: sessionId === null ? appLinks.automations(project.id) : appLinks.session(sessionId, project.id),
        tag: `automation:${row.id}`,
        projectId: project.id,
        sessionId,
        runId,
      });
    } catch (error) {
      this.#context.log.warn({ automationId: row.id, err: redactSecrets(describeError(error)) }, 'notifying about an automation failed');
    }
  }

  /**
   * Carries out a claimed execution. A `notify` is finished when this
   * returns; an `agent-run` is started, and its execution stays open until
   * the run ends. Whatever goes wrong ends up in the record, not in the caller.
   */
  async #execute(row: AutomationRow, execution: ExecutionRow, eventDetail: string | null): Promise<void> {
    const { agents, projects, inbox, auth } = this.#context.services;
    const language = inbox.languageOf(row.created_by);
    try {
      const project = projects.find(row.project_id);
      if (!project) return this.#end(row, execution, 'denied', 'project-archived', say(language, 'denied.projectArchived'));
      const action = JSON.parse(row.action) as AutomationAction;
      const creatorName = auth.findUser(row.created_by)?.displayName ?? '';
      const agentName = action.type === 'agent-run' ? (agents.adapter(action.agentId)?.displayName ?? action.agentId) : '';
      const refuse = async (reason: AutomationReason, key: AutomationTextKey, tellCreator: boolean): Promise<void> => {
        const summary = say(language, key, { creator: creatorName, agent: agentName, mode: action.type === 'agent-run' ? MODE_NAME[action.permissionMode] : '' });
        this.#end(row, execution, 'denied', reason, summary);
        // What the owner switched off on purpose is recorded quietly; what the creator has to fix, they are told.
        if (tellCreator) await this.#tell(row, project, 'run-failed', 'notify.notRun', summary, null, null);
      };

      // The guard rails, checked every time: what was true when it was created may not be true now.
      if (!this.#featureOn(project)) return await refuse('automation-off', 'denied.automationOff', false);
      if (project.archivedAt !== null) return await refuse('project-archived', 'denied.projectArchived', false);
      const creator = agents.principalFor(row.created_by);
      if (!creator) return await refuse('creator-disabled', 'denied.creatorDisabled', false);
      const access = projects.accessOf(creator, project.id);

      if (action.type === 'notify') {
        if (access === null) return await refuse('access-lost', 'denied.accessLostRead', false);
        const result = await inbox.notify(row.created_by, {
          kind: 'automation',
          title: project.name,
          body: action.message,
          detail: eventDetail,
          // The message is the user's own words; a lock screen is told which reminder fired, not what it says.
          discreet: { body: say(language, 'notify.reminder', { name: row.name }) },
          link: appLinks.automations(project.id),
          tag: `automation:${row.id}`,
          projectId: project.id,
        });
        const devices = result.push?.accepted ?? 0;
        switch (result.status) {
          case 'delivered': {
            const vars = { message: action.message };
            const summary = result.inApp && devices > 0 ? sayCounted(language, 'notified.both', devices, vars) : devices > 0 ? sayCounted(language, 'notified.devices', devices, vars) : say(language, 'notified.app', vars);
            return this.#end(row, execution, 'notified', null, summary);
          }
          case 'event-off':
            return this.#end(row, execution, 'quiet', 'event-off', say(language, 'quiet.eventOff'));
          case 'channels-off':
            return this.#end(row, execution, 'quiet', 'channels-off', say(language, 'quiet.channelsOff'));
          case 'not-delivered':
            return this.#end(row, execution, 'failed', 'not-delivered', say(language, 'failed.notDelivered'));
          case 'no-access':
            return this.#end(row, execution, 'denied', 'access-lost', say(language, 'denied.accessLostRead', { creator: creatorName }));
          default:
            return this.#end(row, execution, 'denied', 'creator-disabled', say(language, 'denied.creatorDisabled', { creator: creatorName }));
        }
      }

      if (access !== 'write') return await refuse('access-lost', 'denied.accessLost', false);
      const adapter = agents.adapter(action.agentId);
      if (!adapter) return await refuse('agent-unavailable', 'denied.agentUnavailable', true);
      if (!projects.isAgentEnabled(project, action.agentId)) return await refuse('agent-not-enabled', 'denied.agentNotEnabled', true);
      const [status, capabilities] = await Promise.all([adapter.status(), adapter.capabilities()]);
      if (!status.installed) return await refuse('agent-unavailable', 'denied.agentUnavailable', true);
      if (!capabilities.permissionModes.includes(action.permissionMode)) return await refuse('mode-not-supported', 'denied.modeNotSupported', true);
      if (NEEDS_AUTO_MODE.has(action.permissionMode) && !this.#autoMode(project)) return await refuse('mode-not-allowed', 'denied.modeNotAllowed', true);

      let session: Session;
      if (action.session.type === 'existing') {
        const existing = this.#usableSession(creator, project.id, action);
        if (!existing) return await refuse('session-gone', 'denied.sessionGone', true);
        session = existing;
      } else {
        session = await agents.createSession(creator, {
          projectId: project.id,
          agentId: action.agentId,
          permissionMode: action.permissionMode,
          title: toOneLine(row.name, 200),
          ...(action.model === undefined ? {} : { model: action.model }),
          ...(action.effort === undefined ? {} : { effort: action.effort }),
        });
      }
      const sessionTitle = toOneLine(session.title, 80);

      let runId: string | null;
      try {
        // Unattended, with the origin saying so: the engine denies whatever would need approval.
        // `reject`, never `queue`: a queued message would later run as an ordinary turn, without these guard rails.
        const receipt = await agents.sendMessage(
          creator,
          session.id,
          {
            requestId: `automation-${execution.id}`,
            text: action.prompt,
            permissionMode: action.permissionMode,
            whenBusy: 'reject',
            ...(action.model === undefined ? {} : { model: action.model }),
            ...(action.effort === undefined ? {} : { effort: action.effort }),
          },
          { origin: 'automation' },
        );
        runId = receipt.runId;
      } catch (error) {
        if (isStudioError(error) && error.code === 'session_busy') {
          return this.#end(row, execution, 'skipped', 'session-busy', say(language, 'skipped.sessionBusy', { session: sessionTitle }));
        }
        throw error;
      }
      this.#store.attachRun(execution.id, session.id, runId, clipSummary(say(language, 'started', { agent: agentName, session: sessionTitle, mode: MODE_NAME[action.permissionMode] })));
      this.#announce(row, 'ran');
      // The run's end is reported on the bus. Should it ever have ended before the line above, it is read back instead.
      if (runId !== null && !agents.isRunning(session.id)) {
        const run = agents.runs.getRun(creator, runId);
        if (run.status !== 'accepted' && run.status !== 'running') {
          this.#close(this.#store.execution(execution.id) ?? execution, { runId, sessionId: session.id, projectId: project.id, userId: creator.userId, agentId: action.agentId, status: run.status, error: run.error });
        }
      }
    } catch (error) {
      // A StudioError's message is written for people; anything else goes to the log only.
      const shown = isStudioError(error) ? error.message : 'an internal error.';
      if (!isStudioError(error)) this.#context.log.error({ automationId: row.id, err: redactSecrets(describeError(error)) }, 'an automation failed unexpectedly');
      this.#end(row, execution, 'failed', 'error', say(language, 'failed.error', { error: shown }));
      const project = projects.find(row.project_id);
      if (project && (JSON.parse(row.action) as AutomationAction).type === 'agent-run') await this.#tell(row, project, 'run-failed', 'notify.failed', clipSummary(shown), null, null);
    }
  }

  /** The run an execution started has ended: close the execution with what happened, and tell the creator. */
  #close(execution: ExecutionRow, event: RunEnded): void {
    const row = this.#store.byId(execution.automation_id);
    if (!row) return;
    const { agents, inbox, projects } = this.#context.services;
    const language = inbox.languageOf(row.created_by);
    const project = projects.find(row.project_id);
    const agent = agents.adapter(event.agentId)?.displayName ?? event.agentId;
    let session = '';
    try {
      const creator = agents.principalFor(row.created_by);
      if (creator) session = toOneLine(agents.getSession(creator, event.sessionId).title, 80);
    } catch {
      /* the session is gone; the sentence does without its name */
    }
    const tell = (kind: 'background-finished' | 'run-failed', body: AutomationTextKey, detail: string | null): void => {
      if (project) void this.#tell(row, project, kind, body, detail, event.sessionId, event.runId);
    };

    if (event.status === 'completed') {
      if (execution.denied_count > 0) {
        const summary = sayCounted(language, 'denied.approval', execution.denied_count, { agent, session });
        this.#end(row, execution, 'denied', 'approval-needed', summary);
        tell('run-failed', 'notify.denied', summary);
      } else {
        this.#end(row, execution, 'completed', null, say(language, 'completed', { agent, session }));
        tell('background-finished', 'notify.finished', null);
      }
    } else if (event.status === 'failed') {
      const error = clipSummary(event.error?.message ?? '');
      this.#end(row, execution, 'failed', 'run-failed', say(language, 'failed.run', { agent, session, error }));
      tell('run-failed', 'notify.failed', error);
    } else if (event.status === 'stopped') {
      // Somebody stopped it by hand: they know.
      this.#end(row, execution, 'failed', 'run-stopped', say(language, 'failed.stopped', { session }));
    } else {
      // Cut short by a restart. The inbox sends the one notice per session; here only the record is set right.
      this.#end(row, execution, 'failed', 'interrupted', say(language, 'failed.interrupted'));
    }
  }

  /** "When a run in this project fails": every enabled automation waiting for it whose creator may see that run. */
  #fireEvent(event: RunEnded): void {
    const { agents } = this.#context.services;
    for (const row of this.#store.waitingFor(event.projectId!, 'run-failed')) {
      const creator = agents.principalFor(row.created_by);
      // A member is told about their own runs; an instance owner — who may open any session — about everybody's.
      if (!creator || (creator.userId !== event.userId && creator.role !== 'owner')) continue;
      const now = this.#now();
      const execution = this.#store.claimNow(row.id, 'event', now);
      if (!execution) {
        this.#store.recordSkipped(row.id, 'event', now, say(this.#context.services.inbox.languageOf(row.created_by), 'skipped.stillRunning'));
        this.#store.pruneHistory(row.id, AUTOMATION_LIMITS.historyPerAutomation);
        continue;
      }
      const agent = agents.adapter(event.agentId)?.displayName ?? event.agentId;
      const reason = event.error?.message ?? null;
      void this.#execute(row, execution, reason === null ? agent : `${agent}: ${reason}`);
    }
  }
}
