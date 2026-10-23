import { Mail } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
registerFeatureRoutes({
  path: 'mailbox',
  name: 'mail.title',
  load: () => import('./MailboxScreen'),
});
registerSystemTile({
  id: 'mailbox',
  title: 'mail.title',
  icon: Mail,
  tint: 'blue',
  to: '/mailbox',
  order: 25,
});
