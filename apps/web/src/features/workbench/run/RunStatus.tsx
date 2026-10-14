import type { Run } from '@agent-studio/protocol';
import { Hand, ListChecks, Square, TriangleAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { useSession } from '@/data/session';
import { type Translator, useT } from '@/i18n';
import { Button, Spinner, toast } from '@/ui';
import { workbenchApi } from '../api';
import { approvalHeadline } from '../approvals/ApprovalSurface';
import { newRequestId } from '../composer/delivery';
import { describeTool } from '../transcript/tools';
import { type RunProgress, describeOutcome, formatElapsed } from './status';

function activityText(progress: RunProgress, agentName: string, t: Translator): string {
  const { activity } = progress;
  switch (activity.phase) {
    case 'starting':
      return t('workbench.status.starting');
    case 'waiting':
      return activity.approval.kind === 'plan'
        ? t('workbench.status.waitingPlan')
        : activity.approval.kind === 'question'
          ? t('workbench.status.waitingQuestion')
          : t('workbench.status.waitingApproval', { what: approvalHeadline(activity.approval, agentName, t) });
    case 'tool': {
      const description = describeTool(activity.tool);
      const verb = description.verb ? t(description.verb) : description.name;
      return description.target ? `${verb} ${description.target}` : verb || t('workbench.status.working');
    }
    case 'thinking':
      return t('workbench.status.thinking');
    case 'writing':
      return t('workbench.status.writing');
    case 'working':
      return t('workbench.status.working');
  }
}

/** Time since `since` (server time), re-read once a second while shown. */
function useElapsed(since: number): number {
  const skew = useSession((state) => state.clockSkewMs);
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const tick = () => setNow(Date.now() + skew);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [skew, since]);
  return Math.max(0, now - since);
}

export interface RunStatusRowProps {
  progress: RunProgress;
  agentName: string;
  /** Show a stop control here: the composer's own is taken by "send" while something is typed. */
  showStop: boolean;
  stopping: boolean;
  onStop: () => void;
}

/** The last line of the transcript while the agent works: what it is doing, how far along, for how long. */
export function RunStatusRow({ progress, agentName, showStop, stopping, onStop }: RunStatusRowProps) {
  const t = useT();
  const elapsed = useElapsed(progress.since);
  const waiting = progress.activity.phase === 'waiting';
  return (
    <div className="wb-status" data-phase={progress.activity.phase} role="status" aria-live="off">
      <span className="wb-status__glyph">{waiting ? <Hand size={17} aria-hidden="true" /> : <Spinner size={17} />}</span>
      <span className="wb-status__text u-truncate">{stopping ? t('workbench.composer.stopping') : activityText(progress, agentName, t)}</span>
      {progress.todos && progress.todos.total > 0 && (
        <span className="wb-status__fact u-tabular" title={t('workbench.todos.title')}>
          <ListChecks size={14} aria-hidden="true" />
          {t('workbench.todos.progress', { done: t.number(progress.todos.done), total: t.number(progress.todos.total) })}
        </span>
      )}
      {progress.steps > 0 && <span className="wb-status__fact u-tabular">{t.plural('workbench.run.steps', progress.steps)}</span>}
      <span className="wb-status__fact u-tabular">
        {formatElapsed(elapsed, { seconds: t('workbench.unit.seconds'), minutes: t('workbench.unit.minutes'), hours: t('workbench.unit.hours') })}
      </span>
      {showStop && (
        <button type="button" className="wb-status__stop" onClick={onStop} disabled={stopping} aria-label={t('workbench.composer.stop')} title={t('workbench.composer.stop')}>
          {stopping ? <Spinner size={14} /> : <Square size={12} fill="currentColor" aria-hidden="true" />}
          <span>{t('workbench.composer.stopShort')}</span>
        </button>
      )}
    </div>
  );
}

export interface RecoveryCardProps {
  run: Run;
  /** Further unresolved runs behind this one. */
  more: number;
  /** A run is in progress or a message is unsettled: continuing must wait. */
  blocked: boolean;
  /** Only the person whose session it is may continue it. */
  canContinue: boolean;
  /** Read the session's state again (the live connection may not be there to say the card is done with). */
  onChanged: () => void;
  /** Bring the run's own rows into view. */
  onView: () => void;
}

/**
 * A run that failed or was interrupted and has not been dealt with. Nothing
 * is ever run again by itself: the user looks at what happened, then either
 * continues from where it stopped or dismisses the record.
 */
export function RecoveryCard({ run, more, blocked, canContinue, onChanged, onView }: RecoveryCardProps) {
  const t = useT();
  const [viewing, setViewing] = useState(false);
  const [working, setWorking] = useState<'continue' | 'dismiss' | null>(null);
  const outcome = describeOutcome(run.status === 'interrupted' ? 'interrupted' : 'failed', run.error, run.interruptedByRestart);

  const act = async (kind: 'continue' | 'dismiss') => {
    if (working) return;
    setWorking(kind);
    try {
      if (kind === 'continue') await workbenchApi.continueRun(run.id, newRequestId());
      else await workbenchApi.dismissRun(run.id);
    } catch (error) {
      // Someone else — another device — already continued or dismissed it: the card simply closes.
      const handled = isApiError(error) && (error.code === 'run_not_available' || error.code === 'run_not_continuable' || error.gone);
      if (!handled) toast.error(describeError(error, t));
    } finally {
      setWorking(null);
      onChanged();
    }
  };

  return (
    <section className="wb-recovery" aria-label={t(outcome.title)}>
      <div className="wb-recovery__head">
        <TriangleAlert size={19} aria-hidden="true" />
        <div className="wb-recovery__text">
          <p className="wb-recovery__title">
            {t(run.status === 'interrupted' ? 'workbench.recovery.interrupted' : 'workbench.recovery.failed')}
            {more > 0 && <span className="wb-recovery__more"> · {t.plural('workbench.recovery.more', more)}</span>}
          </p>
          <p className="wb-recovery__detail">
            {run.interruptedByRestart ? t('workbench.recovery.restartDetail') : run.status === 'interrupted' ? t('workbench.recovery.interruptedDetail') : t(outcome.title)}
          </p>
          {/* The agent's own words, when it gave any, on a line of their own: they are not a sentence of ours. */}
          {outcome.detail && <p className="wb-recovery__detail wb-recovery__reason">{outcome.detail}</p>}
        </div>
        <button type="button" className="wb-bar-button" disabled={working !== null} onClick={() => void act('dismiss')} aria-label={t('workbench.recovery.dismiss')} title={t('workbench.recovery.dismiss')}>
          {working === 'dismiss' ? <Spinner size={16} /> : <X size={18} aria-hidden="true" />}
        </button>
      </div>
      {viewing && (
        <div className="wb-recovery__request u-scroll" tabIndex={0}>
          <p className="wb-recovery__label">{t('workbench.recovery.original')}</p>
          <p>{run.text || t('workbench.delivery.attachmentsOnly')}</p>
        </div>
      )}
      <div className="wb-recovery__actions">
        <Button
          variant="neutral"
          aria-expanded={viewing}
          onClick={() => {
            setViewing(!viewing);
            if (!viewing) onView();
          }}
        >
          {viewing ? t('workbench.recovery.hide') : t('workbench.recovery.view')}
        </Button>
        {canContinue && (
          <Button variant="primary" loading={working === 'continue'} disabled={blocked || working !== null} onClick={() => void act('continue')}>
            {t('workbench.recovery.continue')}
          </Button>
        )}
      </div>
    </section>
  );
}
