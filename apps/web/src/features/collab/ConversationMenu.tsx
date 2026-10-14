import { Activity, ArrowRightLeft, Ellipsis, Users } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useUser } from '@/data/session';
import type { TitleBarItemProps } from '@/features/workbench/chat/slots';
import { useSessionQuery } from '@/features/workbench/sessions/queries';
import { useT } from '@/i18n';
import { type MenuEntry, Menu } from '@/ui';
import { HandoffSheet } from './handoff/HandoffSheet';
import './collab.css';

const TaskSheet = lazy(() => import('./tasks/TaskSheet'));

/**
 * The conversation's "…" in its title bar: continue it with another agent,
 * ask several agents about something in this project, see what is running.
 */
export default function ConversationMenu({ project, sessionId, busy }: TitleBarItemProps) {
  const t = useT();
  const navigate = useNavigate();
  const user = useUser();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [asking, setAsking] = useState(false);
  // Downloaded the first time it is asked for, then kept, so it can play its exit.
  const [askLoaded, setAskLoaded] = useState(false);
  const session = useSessionQuery(sessionId).data ?? null;
  const writable = project.access === 'write';
  const mine = session !== null && session.userId === user?.id;

  const items: MenuEntry[] = [];
  if (session && mine && writable) {
    items.push({ id: 'handoff', label: t('collab.menu.handoff'), hint: busy ? t('collab.menu.handoffBusy') : t('collab.menu.handoffHint'), icon: <ArrowRightLeft size={18} />, onSelect: () => setHandoff(true) });
  }
  if (writable && project.features.assistant && !project.archived) {
    items.push({ id: 'ask', label: t('collab.menu.ask'), hint: t('collab.menu.askHint'), icon: <Users size={18} />, onSelect: () => {
        setAskLoaded(true);
        setAsking(true);
      } });
  }
  items.push({ id: 'running', label: t('collab.menu.running'), icon: <Activity size={18} />, onSelect: () => void navigate('/running') });

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="wb-bar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('collab.menu.label')}
        title={t('collab.menu.label')}
        onClick={() => setOpen(!open)}
      >
        <Ellipsis size={21} aria-hidden="true" />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} items={items} label={t('collab.menu.label')} align="end" />
      {session && <HandoffSheet open={handoff} onClose={() => setHandoff(false)} session={session} project={project} busy={busy} />}
      {askLoaded && (
        <Suspense fallback={null}>
          <TaskSheet open={asking} onClose={() => setAsking(false)} project={project} />
        </Suspense>
      )}
    </>
  );
}
