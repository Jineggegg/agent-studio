import type { Inbox, InboxItem, InboxItemKind } from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';

/** The four groups, in the order they are shown, each with what its rows want from the reader. */
export const INBOX_GROUPS: readonly { key: keyof Inbox['groups']; kind: InboxItemKind; title: MessageKey; footer: MessageKey }[] = [
  { key: 'approvals', kind: 'approval', title: 'inbox.group.approvals', footer: 'inbox.group.approvals.footer' },
  { key: 'needsHandling', kind: 'needs-handling', title: 'inbox.group.needsHandling', footer: 'inbox.group.needsHandling.footer' },
  { key: 'results', kind: 'result', title: 'inbox.group.results', footer: 'inbox.group.results.footer' },
  { key: 'running', kind: 'running', title: 'inbox.group.running', footer: 'inbox.group.running.footer' },
];

/** What a row waits for, why it stopped, or how it ended — one line, never the tool's input. */
export function itemDetail(item: InboxItem, t: Translator): string {
  switch (item.kind) {
    case 'approval': {
      const approval = item.approval;
      if (approval?.kind === 'question') return t('inbox.detail.question');
      if (approval?.kind === 'plan') return t('inbox.detail.plan');
      const base = approval?.toolName ? t('inbox.detail.approval', { tool: approval.toolName }) : t('inbox.detail.approvalUnnamed');
      return approval?.requiresOwner ? `${base} · ${t('inbox.detail.ownerOnly')}` : base;
    }
    case 'needs-handling':
      if (item.interruptedByRestart) return t('inbox.detail.restart');
      if (item.runStatus === 'interrupted') return t('inbox.detail.interrupted');
      return item.error ? t('inbox.detail.failedBecause', { reason: item.error }) : t('inbox.detail.failed');
    case 'running':
      return item.runStatus === 'accepted' ? t('inbox.detail.waitingToStart') : t('inbox.detail.running');
    case 'result':
      return item.preview.trim() !== '' ? item.preview : t('inbox.detail.finished');
  }
}

/** The row's name: the session's, else the first line of what was asked. */
export function itemTitle(item: InboxItem, t: Translator): string {
  const title = item.title.trim();
  if (title !== '') return title;
  const first = item.preview.split('\n', 1)[0]?.trim() ?? '';
  return first !== '' ? first.slice(0, 90) : t('inbox.untitled');
}

/**
 * The inbox without rows the user has just put away. A read that started
 * before an acknowledgement may still answer with the old row; it never comes
 * back on screen.
 */
export function withoutAcknowledged(inbox: Inbox, gone: ReadonlySet<string>): Inbox {
  if (gone.size === 0) return inbox;
  const keep = (items: InboxItem[]) => items.filter((item) => !(item.acknowledgeable && gone.has(item.runId)));
  const needsHandling = keep(inbox.groups.needsHandling);
  const results = keep(inbox.groups.results);
  if (needsHandling.length === inbox.groups.needsHandling.length && results.length === inbox.groups.results.length) return inbox;
  return {
    ...inbox,
    groups: { ...inbox.groups, needsHandling, results },
    counts: {
      ...inbox.counts,
      needsHandling: Math.max(0, inbox.counts.needsHandling - (inbox.groups.needsHandling.length - needsHandling.length)),
      results: Math.max(0, inbox.counts.results - (inbox.groups.results.length - results.length)),
    },
  };
}

export function isEmpty(inbox: Inbox): boolean {
  return INBOX_GROUPS.every((group) => inbox.groups[group.key].length === 0);
}

/**
 * Why acknowledging was refused, in words — and both say plainly that
 * nothing was approved or started.
 */
export function acknowledgeRefusal(code: string, t: Translator): string | null {
  if (code === 'queue_waiting') return t('inbox.ack.queueWaiting');
  if (code === 'task_in_progress') return t('inbox.ack.inProgress');
  if (code === 'task_not_found') return t('inbox.ack.gone');
  return null;
}
