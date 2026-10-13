import { CircleAlert, LogIn, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { type Translator, hasMessage, useT } from '@/i18n';
import { Button, ErrorState, List, ListRow, LoadingRow } from '@/ui';
import { type AuditEvent, useAuditEvents } from '../../api';

const VISIBLE_AT_FIRST = 6;

/** A sentence for an audit action; unknown ones (from a newer server) are shown readably rather than hidden. */
export function describeAuditAction(action: string, t: Translator): string {
  const key = `audit.${action}`;
  if (hasMessage(key)) return t(key);
  const words = action.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function icon(event: AuditEvent) {
  if (event.category === 'failure') return <CircleAlert size={20} style={{ color: 'var(--color-warning)' }} />;
  if (event.category === 'sign-in') return <LogIn size={20} />;
  return <ShieldCheck size={20} />;
}

/** Recent security-relevant events: sign-ins, refusals, and changes to how the account can be reached. */
export function EventsSection() {
  const t = useT();
  const events = useAuditEvents(30);
  const [expanded, setExpanded] = useState(false);
  const all = events.data ?? [];
  const shown = expanded ? all : all.slice(0, VISIBLE_AT_FIRST);

  return (
    <List
      header={t('account.events')}
      footer={t('account.events.hint')}
      headerAction={
        all.length > VISIBLE_AT_FIRST ? (
          <Button variant="plain" size="sm" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
            {expanded ? t('account.events.collapse') : t('account.events.showAll', { count: all.length })}
          </Button>
        ) : undefined
      }
    >
      {events.isPending ? (
        <LoadingRow label={t('common.loading')} />
      ) : !events.data ? (
        <ErrorState error={events.error} onRetry={() => void events.refetch()} retrying={events.isFetching} compact />
      ) : all.length === 0 ? (
        <ListRow title={t('account.events.none')} />
      ) : (
        shown.map((event) => (
          <ListRow
            key={event.id}
            leading={icon(event)}
            title={describeAuditAction(event.action, t)}
            subtitle={[t.date(event.at, 'dateTime'), event.address, event.subject, event.detail].filter(Boolean).join(' · ')}
          />
        ))
      )}
    </List>
  );
}
