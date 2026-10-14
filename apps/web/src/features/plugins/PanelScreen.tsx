import { Puzzle } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import { Button, DelayedSkeleton, ErrorState, Skeleton } from '@/ui';
import { PanelFrame } from './PanelFrame';
import { usePluginContributions } from './contributions';
import './plugins.css';

/**
 * A plugin's panel opened from its launcher tile: the whole screen is the
 * panel, under the Studio's own bar (back, and the plugin it comes from).
 */
export default function PanelScreen() {
  const t = useT();
  const navigate = useNavigate();
  const { pluginId = '', panelId = '' } = useParams();
  const contributions = usePluginContributions();
  const tile = contributions.data?.homeTiles.find((entry) => entry.pluginId === pluginId && entry.panelId === panelId) ?? null;
  const title = tile?.title ?? t('plugins.panel.title');

  return (
    <Screen title={title} subtitle={tile ? t('plugins.panel.from', { plugin: tile.pluginName }) : undefined} largeTitle={false} width="full" className="pl-screen">
      {tile ? (
        <PanelFrame key={`${pluginId}/${panelId}`} pluginId={pluginId} panelId={panelId} slot="home-tile" project={null} title={t('plugins.panel.frameLabel', { title: tile.title, plugin: tile.pluginName })} sizing="fill" />
      ) : contributions.isPending ? (
        <DelayedSkeleton label={t('common.loading')}>
          <Skeleton width="100%" height={320} radius={14} />
        </DelayedSkeleton>
      ) : contributions.data ? (
        <ErrorState
          kind="gone"
          title={t('plugins.panel.gone')}
          description={t('plugins.panel.goneText')}
          actions={
            <Button variant="tinted" icon={<Puzzle size={18} />} onClick={() => void navigate('/', { replace: true })}>
              {t('nav.backToHome')}
            </Button>
          }
        />
      ) : (
        <ErrorState error={contributions.error} onRetry={() => void contributions.refetch()} retrying={contributions.isFetching} />
      )}
    </Screen>
  );
}
