import { registerTitleBarItem } from '@/features/workbench/chat/slots';
import { registerFeatureRoutes } from '@/registry';
registerFeatureRoutes({
  path: 'projects/:projectId/apps',
  name: 'apps.title',
  load: () => import('./MiniAppsScreen'),
});
registerTitleBarItem({ id: 'mini-apps', order: 35, load: () => import('./TitleBarButton') });
