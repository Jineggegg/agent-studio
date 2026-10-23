import { Wrench } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
registerFeatureRoutes({
  path: 'tool-library',
  name: 'library.title',
  load: () => import('./ToolLibraryScreen'),
});
registerSystemTile({
  id: 'tool-library',
  title: 'library.title',
  icon: Wrench,
  tint: 'purple',
  to: '/tool-library',
  order: 32,
});
