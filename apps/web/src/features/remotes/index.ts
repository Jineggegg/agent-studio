import { Server } from 'lucide-react';
import { registerSettingsPage } from '@/registry';

/**
 * Remote machines: the SSH hosts the operator of this server has listed, with
 * whether each answers, and a terminal on one. Owner only, like the terminal
 * itself. Registration only.
 */
registerSettingsPage({
  id: 'remote-machines',
  title: 'remotes.title',
  icon: Server,
  tint: 'sky',
  group: 'connections',
  order: 30,
  access: 'owner',
  load: () => import('./RemotesPage'),
});
