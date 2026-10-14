import { type ChainEntry, HANDOFF_NOTICE, type Session } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AgentMark } from '@/features/workbench/chat/parts';
import { workbenchPaths } from '@/features/workbench/routes';
import { useT } from '@/i18n';
import { Menu } from '@/ui';
import { collabApi, collabKeys } from '../api';
import '../collab.css';

export interface ChainBarProps {
  session: Session;
  /** The transcript's rows, to notice a handoff out of a conversation that began no chain itself. */
  items: readonly { kind: string; code?: string }[];
}

/** Where a conversation stands in its chain: which part, the agents before and after it, and the way to each. */
export interface ChainPlace {
  index: number;
  total: number;
  previous: ChainEntry | null;
  next: ChainEntry | null;
  latest: ChainEntry | null;
  current: ChainEntry | null;
}

export function chainPlace(entries: readonly ChainEntry[]): ChainPlace {
  const index = entries.findIndex((entry) => entry.current);
  return {
    index,
    total: entries.length,
    previous: index > 0 ? entries[index - 1]! : null,
    next: index >= 0 && index < entries.length - 1 ? entries[index + 1]! : null,
    latest: entries.find((entry) => entry.latest) ?? entries.at(-1) ?? null,
    current: index >= 0 ? entries[index]! : null,
  };
}

/**
 * A slim strip under the title bar of a conversation that belongs to a
 * chain: its place in it, the agent before and after, and — on an earlier
 * part — that the conversation continues elsewhere, with the way there.
 */
export function ChainBar({ session, items }: ChainBarProps) {
  const t = useT();
  const navigate = useNavigate();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const handedOn = useMemo(() => items.some((item) => item.kind === 'notice' && item.code === HANDOFF_NOTICE.sent), [items]);
  const inChain = session.chainId !== null || session.parentSessionId !== null || handedOn;
  const chain = useQuery({
    queryKey: collabKeys.chain(session.id),
    queryFn: ({ signal }) => collabApi.chain(session.id, signal),
    enabled: inChain,
    staleTime: 60_000,
  });
  const entries = chain.data?.sessions ?? [];
  if (!inChain || entries.length < 2) return null;
  const place = chainPlace(entries);
  if (!place.current) return null;

  const go = (entry: ChainEntry) => void navigate(workbenchPaths.session(entry.session.projectId, entry.session.id), { replace: true });
  const notLatest = !place.current.latest && place.latest !== null;

  return (
    <nav className="cl-chainbar" aria-label={t('collab.chain.label')} data-earlier={notLatest || undefined}>
      <button
        ref={menuAnchor}
        type="button"
        className="cl-chainbar__place"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(!menuOpen)}
        title={t('collab.chain.all')}
      >
        <Layers size={15} aria-hidden="true" />
        <span>{t('collab.chain.place', { index: t.number(place.index + 1), total: t.number(place.total) })}</span>
      </button>
      <Menu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchor={menuAnchor}
        label={t('collab.chain.all')}
        items={entries.map((entry, index) => ({
          id: entry.session.id,
          label: `${index + 1}. ${entry.agentName}`,
          hint: [entry.session.title, entry.handoff ? t.date(entry.handoff.at, 'dateTime') : t.date(entry.session.createdAt, 'dateTime'), entry.gapBefore ? t('collab.chain.gap') : null].filter(Boolean).join(' · '),
          checked: entry.current,
          onSelect: () => !entry.current && go(entry),
        }))}
      />
      <div className="cl-chainbar__steps">
        {place.previous ? (
          <button type="button" className="cl-chainbar__step" onClick={() => go(place.previous!)} aria-label={t('collab.chain.previous', { agent: place.previous.agentName })} title={t('collab.chain.previous', { agent: place.previous.agentName })}>
            <ChevronLeft size={16} aria-hidden="true" />
            <AgentMark agentId={place.previous.session.agentId} size={18} />
            <span className="u-truncate">{place.previous.agentName}</span>
          </button>
        ) : (
          <span className="cl-chainbar__edge">{place.current.gapBefore ? t('collab.chain.gap') : t('collab.chain.first')}</span>
        )}
        {place.next ? (
          <button type="button" className="cl-chainbar__step" data-next="" onClick={() => go(place.next!)} aria-label={t('collab.chain.next', { agent: place.next.agentName })} title={t('collab.chain.next', { agent: place.next.agentName })}>
            <span className="u-truncate">{place.next.agentName}</span>
            <AgentMark agentId={place.next.session.agentId} size={18} />
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        ) : (
          <span className="cl-chainbar__edge">{t('collab.chain.latest')}</span>
        )}
      </div>
      {notLatest && place.latest && (
        <p className="cl-chainbar__note">
          {t('collab.chain.continues', { agent: place.latest.agentName })}{' '}
          <button type="button" className="wb-inline-button" onClick={() => go(place.latest!)}>
            {t('collab.chain.openLatest')}
          </button>
        </p>
      )}
    </nav>
  );
}
