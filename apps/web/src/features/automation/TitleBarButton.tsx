import { CalendarClock } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { TitleBarItemProps } from '@/features/workbench/chat/slots';
import { useT } from '@/i18n';
import { automationsPath } from './SendLater';

/** The way from a conversation to its project's automations — shown only where the project has them switched on. */
export default function AutomationsButton({ project }: TitleBarItemProps) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <button type="button" className="wb-bar-button aut-titlebar" onClick={() => void navigate(automationsPath(project.id))} aria-label={t('automation.titleBar', { project: project.name })} title={t('automation.titleBar', { project: project.name })}>
      <CalendarClock size={20} aria-hidden="true" />
    </button>
  );
}
