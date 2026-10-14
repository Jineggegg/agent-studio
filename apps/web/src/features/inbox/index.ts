import { Inbox } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
import { useInboxTileStatus } from './status';

/**
 * The inbox: everything that waits for the user across their conversations —
 * approvals, failures, unread results, work in progress — and the stored
 * notifications. Registration only; the screen downloads when it is opened.
 * The tile's line follows the server's summary over the live connection.
 */
registerFeatureRoutes({ path: 'inbox', name: 'inbox.title', load: () => import('./InboxScreen') });

registerSystemTile({ id: 'inbox', title: 'inbox.title', icon: Inbox, tint: 'red', to: '/inbox', order: 20, useStatus: useInboxTileStatus });
