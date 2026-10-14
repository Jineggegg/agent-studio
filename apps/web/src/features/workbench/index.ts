import { MessagesSquare, ShieldCheck } from 'lucide-react';
import { registerFeatureRoutes, registerSettingsPage, registerSystemTile } from '@/registry';
import { useWorkbenchTileStatus } from './status';

/**
 * The workbench: the chat surface through which a person drives coding
 * agents. Registrations and lazy loaders only — the feature's code downloads
 * when it is first opened (and in the background once the app is idle, since
 * it is where most time is spent).
 *
 * Other features add their tools to the workbench's inspector with
 * `registerInspectorPanel` from './inspector/registry' (see the README).
 */
registerFeatureRoutes(
  { path: 'workbench/*', name: 'workbench.title', load: () => import('./WorkbenchScreen'), preloadWhenIdle: true },
  // A project's page is its workbench: the home screen's project tiles lead here.
  { path: 'projects/:projectId/*', name: 'workbench.title', load: () => import('./ProjectRedirect') },
);

registerSystemTile({ id: 'workbench', title: 'workbench.title', icon: MessagesSquare, tint: 'blue', to: '/workbench', order: 10, useStatus: useWorkbenchTileStatus });

registerSettingsPage({
  id: 'permissions',
  title: 'workbench.rules.title',
  icon: ShieldCheck,
  tint: 'green',
  group: 'assistants',
  order: 20,
  load: () => import('./settings/PermissionRulesPage'),
});

if (import.meta.env.DEV) {
  // Stand-in panels for looking at the inspector's container before the real tools exist. Never in a production build.
  void import('./dev/samplePanels');
}
