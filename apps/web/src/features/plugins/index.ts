import { Puzzle } from 'lucide-react';
import { refreshInspectorPanels, registerInspectorPanel } from '@/features/workbench/inspector/registry';
import { registerFeatureRoutes, registerSettingsPage } from '@/registry';
import { hasProjectTabs, onProjectTabsChange, usePluginsSummary } from './summary';

/**
 * Plugins: the owner's page to install, review, approve, update and remove
 * them, and the host for what enabled plugins contribute — a panel opened
 * from its launcher tile, a tab of a project beside the chat, a page in
 * settings. Every panel runs in a sandboxed frame and reaches the Studio only
 * through the relay in `relay.ts`. Registration only; the launcher shows the
 * plugins' tiles itself (see `features/home`).
 */
registerFeatureRoutes({ path: 'plugins/:pluginId/:panelId', name: 'plugins.panel.title', load: () => import('./PanelScreen') });

registerSettingsPage(
  { id: 'plugins', title: 'plugins.title', icon: Puzzle, tint: 'purple', group: 'system', order: 50, access: 'owner', load: () => import('./PluginsPage'), useSummary: usePluginsSummary },
  { id: 'plugin-page', title: 'plugins.pages.pageTitle', icon: Puzzle, tint: 'purple', group: 'system', access: 'owner', parent: 'plugins', load: () => import('./PluginSettingsPage') },
);

// One tab beside the chat holds the plugins' project tabs; it exists only while some plugin offers one.
registerInspectorPanel({
  id: 'plugins',
  title: 'plugins.tab.title',
  icon: Puzzle,
  order: 90,
  available: (context) => context.project !== null && hasProjectTabs(),
  load: () => import('./ProjectTabPanel'),
});
onProjectTabsChange(refreshInspectorPanels);
