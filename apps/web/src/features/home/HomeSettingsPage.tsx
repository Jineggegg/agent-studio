import { RotateCcw, Type } from 'lucide-react';
import { useMemo } from 'react';
import { useProjects } from '@/data/projects';
import { useIsOwner } from '@/data/session';
import { usePluginContributions } from '@/features/plugins/contributions';
import { useT } from '@/i18n';
import { systemTiles } from '@/registry';
import { List, ListRow, Switch, confirm, toast } from '@/ui';
import { buildCatalogue } from './catalogue';
import { layoutCounts, resetArrangement, resetNames } from './layout';
import { setHomeLook, useHomeLook } from './look';
import { useHomeLayout } from './useHomeLayout';

/**
 * Settings → Home screen: how the launcher looks on this device, what the
 * account's arrangement holds, and the two resets — names, and the
 * arrangement — each asked first, each reaching every device.
 */
export default function HomeSettingsPage() {
  const t = useT();
  const isOwner = useIsOwner();
  const look = useHomeLook();
  const projects = useProjects();
  const contributions = usePluginContributions();
  const catalogue = useMemo(() => buildCatalogue(systemTiles(isOwner ? 'owner' : 'member'), projects.data, contributions.data), [isOwner, projects.data, contributions.data]);
  const known = useMemo(() => catalogue.map((info) => info.id), [catalogue]);
  const home = useHomeLayout(known, projects.isSuccess && contributions.isSuccess);
  const counts = layoutCounts(home.layout, home.arrangement);
  const arranged = home.layout.order.length > 0 || counts.folders > 0 || counts.hidden > 0 || home.layout.pageStarts.length > 0;

  const restoreNames = async () => {
    const agreed = await confirm({ title: t('home.settings.namesTitle'), message: t('home.settings.namesText'), confirmLabel: t('home.settings.namesConfirm') });
    if (!agreed) return;
    home.write((layout) => resetNames(layout));
    toast.success(t('home.settings.namesDone'));
  };
  const resetLayout = async () => {
    const agreed = await confirm({ title: t('home.settings.resetTitle'), message: t('home.settings.resetText'), confirmLabel: t('home.settings.resetConfirm'), tone: 'danger' });
    if (!agreed) return;
    home.write((layout) => resetArrangement(layout));
    toast.success(t('home.settings.resetDone'));
  };

  return (
    <>
      <List header={t('home.look.title')} footer={t('home.look.footer')}>
        <ListRow title={t('home.look.names')} subtitle={t('home.look.namesText')} control={<Switch checked={look.showNames} onChange={(showNames) => setHomeLook({ showNames })} />} />
        <ListRow title={t('home.look.large')} subtitle={t('home.look.largeText')} control={<Switch checked={look.largeIcons} onChange={(largeIcons) => setHomeLook({ largeIcons })} />} />
      </List>
      <List header={t('home.settings.arrangement')} footer={t('home.settings.arrangementFooter')}>
        <ListRow title={t('home.settings.folders')} value={counts.folders === 0 ? t('home.settings.none') : t('home.settings.foldersValue', { folders: t.number(counts.folders), tiles: t.number(counts.inFolders) })} />
        <ListRow title={t('home.settings.hidden')} value={counts.hidden === 0 ? t('home.settings.none') : t.number(counts.hidden)} />
        <ListRow title={t('home.settings.renamed')} value={counts.renamed === 0 ? t('home.settings.none') : t.number(counts.renamed)} />
      </List>
      <List>
        <ListRow leading={<Type size={20} />} title={t('home.settings.namesAction')} subtitle={t('home.settings.namesHint')} onPress={() => void restoreNames()} disabled={counts.renamed === 0} tone="accent" />
        <ListRow leading={<RotateCcw size={20} />} title={t('home.settings.resetAction')} subtitle={t('home.settings.resetHint')} onPress={() => void resetLayout()} disabled={!arranged} tone="danger" />
      </List>
    </>
  );
}
