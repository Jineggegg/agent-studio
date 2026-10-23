import { FolderOpen, Info, Mic, Palette, Settings, ShieldCheck, Users } from 'lucide-react';
import { registerSettingsPage, registerSettingsQuickControl, registerSystemTile } from '@/registry';
import { BUILD_ID } from '@/pwa/update';
import { useSession } from '@/data/session';
import { ThemeQuickControl, useThemeSummary } from './appearance';

function useVersionSummary(): string | undefined {
  return useSession((state) => state.serverVersion) ?? (BUILD_ID === 'dev' ? undefined : BUILD_ID);
}

/**
 * The settings pages the foundation provides, the appearance quick control,
 * and the Settings tile on the home screen. Features add their own pages the
 * same way, from their own `index.ts`.
 */
registerSettingsPage(
  {
    id: 'voice',
    title: 'voice.title',
    icon: Mic,
    tint: 'blue',
    group: 'general',
    order: 30,
    access: 'owner',
    load: () => import('../workbench/voice/VoiceSettings'),
  },
  {
    id: 'account',
    title: 'settings.account.title',
    icon: ShieldCheck,
    tint: 'blue',
    group: 'account',
    order: 10,
    load: () => import('./pages/AccountPage'),
  },
  {
    id: 'people',
    title: 'settings.people.title',
    icon: Users,
    tint: 'purple',
    group: 'account',
    order: 20,
    access: 'owner',
    load: () => import('./pages/PeoplePage'),
  },
  {
    id: 'appearance',
    title: 'settings.appearance.title',
    icon: Palette,
    tint: 'pink',
    group: 'general',
    order: 10,
    load: () => import('./pages/AppearancePage'),
    useSummary: useThemeSummary,
  },
  {
    id: 'projects',
    title: 'settings.projects.title',
    icon: FolderOpen,
    tint: 'amber',
    group: 'general',
    order: 20,
    load: () => import('./pages/ProjectsPage'),
  },
  {
    id: 'about',
    title: 'settings.about.title',
    icon: Info,
    tint: 'slate',
    group: 'system',
    order: 90,
    load: () => import('./pages/AboutPage'),
    useSummary: useVersionSummary,
  },
);

registerSettingsQuickControl({ id: 'appearance', order: 10, Component: ThemeQuickControl });

registerSystemTile({
  id: 'settings',
  title: 'settings.title',
  icon: Settings,
  tint: 'slate',
  to: '/settings',
  order: 900,
});
