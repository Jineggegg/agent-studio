import { AppWindow } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { TitleBarItemProps } from '@/features/workbench/chat/slots';
import { useT } from '@/i18n';
export default function AppsButton({ project }: TitleBarItemProps) {
  const t = useT(),
    navigate = useNavigate();
  return (
    <button
      type="button"
      className="wb-bar-button"
      aria-label={t('apps.title')}
      title={t('apps.title')}
      onClick={() => void navigate(`/projects/${encodeURIComponent(project.id)}/apps`)}
    >
      <AppWindow size={20} aria-hidden="true" />
    </button>
  );
}
