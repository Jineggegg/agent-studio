import { Globe } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
registerFeatureRoutes({
  path: 'browser',
  name: 'browser.title',
  load: () => import('./BrowserScreen'),
});
registerSystemTile({
  id: 'browser',
  title: 'browser.title',
  icon: Globe,
  tint: 'blue',
  to: '/browser',
  order: 34,
});
