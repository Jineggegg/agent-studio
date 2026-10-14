import { Brain } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
import { useMemoryTileStatus } from './status';

/**
 * Memory: the Markdown notes every assistant reads and writes, for the
 * person — search, read, write, move and delete them, and (the owner) decide
 * whether assistants may use memory at all. Registration only; the app
 * downloads when it is opened.
 */
registerFeatureRoutes({ path: 'memory', name: 'memory.title', load: () => import('./MemoryScreen') });

registerSystemTile({ id: 'memory', title: 'memory.title', icon: Brain, tint: 'purple', to: '/memory', order: 30, useStatus: useMemoryTileStatus });
