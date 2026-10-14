import { HANDOFF_NOTICE, type Handoff } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, FileText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { Sheet } from '@/ui';
import { Markdown } from '@/ui/markdown';
import { collabApi, collabKeys } from '../api';
import '../collab.css';

/** The notice codes a handoff writes into the two conversations. */
export const isHandoffNotice = (code: string): boolean => code === HANDOFF_NOTICE.received || code === HANDOFF_NOTICE.sent;

export interface HandoffNoticeProps {
  /** `handoff_received` or `handoff_sent`. */
  code: string;
  /** The notice's text: one line, then (for the one received) the brief as the new agent was given it. */
  text: string;
  /** The notice's place in the log, to find its record. */
  seq: number;
  /** The conversation the notice is in. */
  sessionId: string | null;
}

/** The record behind a notice: the handoff this conversation began with, or the one at this place among those that continued it. */
export function handoffFor(code: string, seq: number, data: { incoming: Handoff | null; outgoing: Handoff[] } | undefined): Handoff | null {
  if (!data) return null;
  if (code === HANDOFF_NOTICE.received) return data.incoming;
  return data.outgoing.find((handoff) => handoff.source.noticeSeq === seq) ?? data.outgoing.at(-1) ?? null;
}

/**
 * A handoff in the transcript, folded to one line: where the conversation
 * came from or went to, with that conversation one tap away, and the brief
 * the new agent was given behind "View brief".
 */
export function HandoffNotice({ code, text, seq, sessionId }: HandoffNoticeProps) {
  const t = useT();
  const navigate = useNavigate();
  const [briefOpen, setBriefOpen] = useState(false);
  const received = code === HANDOFF_NOTICE.received;
  const handoffs = useQuery({
    queryKey: collabKeys.handoffs(sessionId ?? ''),
    queryFn: ({ signal }) => collabApi.handoffs(sessionId!, signal),
    enabled: sessionId !== null,
    staleTime: 5 * 60_000,
  });
  const record = handoffFor(code, seq, handoffs.data);
  const other = record ? (received ? record.source : record.target) : null;
  const [firstLine = '', ...rest] = text.split('\n');
  // Without the record (it could not be read), the notice's own text still says what happened and carries the brief.
  const line = other ? (received ? t('collab.notice.received', { agent: other.agentName }) : t('collab.notice.sent', { agent: other.agentName })) : firstLine;
  const brief = record?.brief.text ?? (received ? rest.join('\n').trim() : '');
  const Icon = received ? ArrowDownLeft : ArrowUpRight;

  return (
    <div className="cl-notice" role="note">
      <Icon className="cl-notice__icon" size={16} aria-hidden="true" />
      <p className="cl-notice__line">
        <span className="cl-notice__text">{line}</span>
        {record && <span className="cl-notice__meta">{t.date(record.at, 'dateTime')}</span>}
      </p>
      <div className="cl-notice__actions">
        {brief !== '' && (
          <button type="button" className="wb-inline-button" onClick={() => setBriefOpen(true)}>
            <FileText size={15} aria-hidden="true" />
            {t('collab.notice.viewBrief')}
          </button>
        )}
        {other?.sessionId && (
          <button type="button" className="wb-inline-button" onClick={() => void navigate(workbenchPaths.lookup(other.sessionId!), { replace: true })}>
            {received ? t('collab.notice.openEarlier') : t('collab.notice.openLater')}
          </button>
        )}
        {other && other.sessionId === null && <span className="cl-notice__meta">{received ? t('collab.notice.earlierGone') : t('collab.notice.laterGone')}</span>}
      </div>
      {brief !== '' && (
        <Sheet open={briefOpen} onClose={() => setBriefOpen(false)} title={t('collab.brief.title')} size="lg">
          <div className="cl-brief">
            <p className="cl-brief__meta">
              {record
                ? record.brief.kind === 'summary'
                  ? t('collab.brief.summaryBy', { agent: record.summary.agentName ?? record.summary.agentId ?? '' })
                  : t('collab.brief.digest')
                : t('collab.brief.unknownKind')}
            </p>
            {record && record.summary.requested && record.summary.status !== 'written' && (
              <p className="cl-brief__meta">{t('collab.brief.summaryFallback', { reason: record.summary.reason ?? t('collab.brief.noReason') })}</p>
            )}
            {record?.note && (
              <blockquote className="cl-brief__note">
                <span className="cl-brief__note-label">{t('collab.brief.note')}</span>
                {record.note}
              </blockquote>
            )}
            <div className="cl-brief__body">
              <Markdown>{brief}</Markdown>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
