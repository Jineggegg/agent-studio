import { Monitor } from 'lucide-react';
import { registerSettingsPage } from '@/registry';
registerSettingsPage({
  id: 'devices',
  title: 'computer.title',
  icon: Monitor,
  tint: 'teal',
  group: 'assistants',
  order: 40,
  load: () => import('./DevicesPage'),
});
