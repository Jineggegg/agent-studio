import { Puzzle } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { useT } from '@/i18n';
import { settingsPath } from '@/registry';
import { Button, EmptyState, ErrorState, LoadingRow } from '@/ui';
import { PanelFrame } from './PanelFrame';
import { usePluginContributions } from './contributions';
import './plugins.css';

/**
 * A plugin's own settings page (the owner's): its panel, under Settings →
 * Plugins. The address names the plugin and the panel:
 * `/settings/plugin-page/<plugin>/<panel>`.
 */
export default function PluginSettingsPage() {
  const t = useT();
  const navigate = useNavigate();
  const [, pluginId = '', panelId = ''] = (useParams()['*'] ?? '').split('/').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return '';
    }
  });
  const contributions = usePluginContributions();
  const page = contributions.data?.settingsPages.find((entry) => entry.pluginId === pluginId && entry.panelId === panelId) ?? null;

  if (contributions.isPending) return <LoadingRow label={t('common.loading')} />;
  if (!contributions.data) return <ErrorState error={contributions.error} onRetry={() => void contributions.refetch()} retrying={contributions.isFetching} />;
  if (!page) {
    return (
      <EmptyState
        icon={<Puzzle size={28} />}
        title={t('plugins.panel.gone')}
        description={t('plugins.panel.goneText')}
        action={
          <Button variant="tinted" onClick={() => void navigate(settingsPath('plugins'), { replace: true })}>
            {t('plugins.backToPlugins')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="pl-settings-panel">
      <p className="pl-settings-panel__head">
        <strong>{page.title}</strong>
        <span>{t('plugins.panel.from', { plugin: page.pluginName })}</span>
      </p>
      <PanelFrame key={`${pluginId}/${panelId}`} pluginId={pluginId} panelId={panelId} slot="settings-page" project={null} title={t('plugins.panel.frameLabel', { title: page.title, plugin: page.pluginName })} sizing="content" />
    </div>
  );
}
