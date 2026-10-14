import { AUTOMATION_LIMITS, type PermissionMode, type Project } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '@/data/errors';
import { useIsOwner } from '@/data/session';
import { useAttachments } from '@/features/workbench/composer/attachmentStore';
import { type DraftKey, flushDraft, setDraft, useDrafts } from '@/features/workbench/composer/drafts';
import { useT } from '@/i18n';
import { Banner, Button, Sheet, TextField, toast } from '@/ui';
import { automationKeys, deferredApi } from './api';
import { deviceTimeZone, fromLocalInput, toLocalInput, zoneOffset } from './time';
import { whenText } from './words';
import './later.css';

const QUICK = [
  { minutes: 15, label: 'automation.later.in15' },
  { minutes: 60, label: 'automation.later.in60' },
  { minutes: 8 * 60, label: 'automation.later.in480' },
  { minutes: 24 * 60, label: 'automation.later.in1440' },
] as const;

/** Why "send later" cannot take this message yet, or null when it can. */
export function sendLaterBlock(input: { text: string; files: number; quote: boolean; projectAutomation: boolean | null }): 'empty' | 'files' | 'quote' | 'automation-off' | 'too-long' | null {
  if (input.projectAutomation === false) return 'automation-off';
  if (input.text.trim() === '') return 'empty';
  if (input.text.length > AUTOMATION_LIMITS.deferredTextChars) return 'too-long';
  if (input.files > 0) return 'files';
  if (input.quote) return 'quote';
  return null;
}

/** An automations page link for a project. Matches `appLinks.automations` in the protocol. */
export const automationsPath = (projectId: string): string => `/projects/${encodeURIComponent(projectId)}/automations`;

export interface SendLaterProps {
  sessionId: string;
  draftKey: DraftKey;
  project: Project | null;
  /** What the composer has selected: sent along and used when the message goes out. */
  options: { model: string | null; effort: string | null; permissionMode: PermissionMode };
  hasQuote: boolean;
  /** An earlier message is still unconfirmed: nothing is scheduled until it is settled. */
  blocked: boolean;
}

const EMPTY: readonly unknown[] = [];

/**
 * "Send later", beside Send: the text in the field is scheduled for a time
 * and sent then — as if typed at that moment, with this conversation's
 * usual permissions — even when no browser is open. Text only.
 */
export function SendLater({ sessionId, draftKey, project, options, hasQuote, blocked }: SendLaterProps) {
  const t = useT();
  const navigate = useNavigate();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const text = useDrafts((state) => state.texts[draftKey] ?? '');
  const files = useAttachments((state) => state.byKey[draftKey] ?? EMPTY).length;
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const block = sendLaterBlock({ text, files, quote: hasQuote, projectAutomation: project ? project.features.automation : null });
  const zone = deviceTimeZone();

  const show = () => {
    const moment = Date.now();
    setNow(moment);
    setCustom(toLocalInput(moment + 60 * 60 * 1000));
    setProblem(null);
    setOpen(true);
  };

  const schedule = async (sendAt: number, key: string) => {
    if (busy || block) return;
    setBusy(key);
    setProblem(null);
    try {
      const created = await deferredApi.create({
        sessionId,
        text,
        sendAt,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        permissionMode: options.permissionMode,
      });
      // Unlike a sent message, a scheduled one leaves the draft the server keeps for this conversation alone
      // (so it can't empty a newer one when it goes out later): the field is emptied from here, on every device.
      setDraft(draftKey, '');
      void flushDraft(draftKey);
      void queryClient.invalidateQueries({ queryKey: automationKeys.deferred(sessionId) });
      toast.success(t('automation.later.scheduled', { when: whenText(created.sendAt, Date.now(), t) }));
      setOpen(false);
    } catch (error) {
      setProblem(describeError(error, t));
    } finally {
      setBusy(null);
    }
  };

  const customAt = fromLocalInput(custom);
  const customProblem = custom !== '' && (customAt === null || customAt <= Date.now() + 30_000) ? t('automation.later.pastTime') : null;
  const blockText =
    block === 'automation-off'
      ? isOwner
        ? t('automation.later.offOwner')
        : t('automation.later.offMember')
      : block === 'files'
        ? t('automation.later.files')
        : block === 'quote'
          ? t('automation.later.quote')
          : block === 'too-long'
            ? t('automation.later.tooLong', { max: t.number(AUTOMATION_LIMITS.deferredTextChars) })
            : block === 'empty'
              ? t('automation.later.empty')
              : null;

  return (
    <>
      <button
        type="button"
        className="wb-bar-button aut-later-button"
        // Nothing to schedule, or an earlier message still unsettled. Where the project does not allow it, the sheet says why.
        disabled={blocked || (block === 'empty' && project?.features.automation !== false)}
        onClick={show}
        aria-label={t('automation.later.label')}
        title={t('automation.later.label')}
        onPointerDown={(event) => event.preventDefault()}
      >
        <Clock size={19} aria-hidden="true" />
      </button>
      <Sheet open={open} onClose={() => !busy && setOpen(false)} title={t('automation.later.title')} dismissible={busy === null}>
        <div className="aut-later">
          {text.trim() !== '' && <p className="aut-later__text">{text.length > 400 ? `${text.slice(0, 400)}…` : text}</p>}
          {blockText && (
            <Banner tone={block === 'empty' ? 'info' : 'warning'}>
              <p>{blockText}</p>
              {block === 'automation-off' && project && isOwner && (
                <Button
                  size="sm"
                  variant="tinted"
                  data-autofocus=""
                  onClick={() => {
                    setOpen(false);
                    void navigate(automationsPath(project.id));
                  }}
                >
                  {t('automation.later.openAutomations')}
                </Button>
              )}
            </Banner>
          )}
          {problem && (
            <Banner tone="danger" role="alert">
              <p>{problem}</p>
            </Banner>
          )}
          <ul className="aut-later__choices" aria-label={t('automation.later.quick')}>
            {QUICK.map((choice, index) => {
              const at = now + choice.minutes * 60_000;
              return (
                <li key={choice.minutes}>
                  <button
                    type="button"
                    className="aut-later__choice"
                    disabled={block !== null || busy !== null}
                    // The likeliest choice takes the focus, rather than the date field (which would bring up a picker on some phones).
                    data-autofocus={block === null && index === 0 ? '' : undefined}
                    onClick={() => void schedule(at, String(choice.minutes))}
                  >
                    <span>{t(choice.label)}</span>
                    <span className="aut-later__time">{busy === String(choice.minutes) ? t('automation.later.scheduling') : whenText(at, now, t)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="aut-later__custom">
            <TextField
              label={t('automation.later.custom', { zone: `${zone} ${zoneOffset(zone)}`.trim() })}
              type="datetime-local"
              value={custom}
              onChange={setCustom}
              error={customProblem}
              disabled={block !== null}
            />
            <Button variant="primary" icon={<CalendarClock size={17} />} loading={busy === 'custom'} disabled={block !== null || busy !== null || customAt === null || customProblem !== null} onClick={() => customAt !== null && void schedule(customAt, 'custom')}>
              {t('automation.later.schedule')}
            </Button>
          </div>
          <p className="aut-later__note">{t('automation.later.note')}</p>
        </div>
      </Sheet>
    </>
  );
}
