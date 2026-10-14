import { ChartColumn } from 'lucide-react';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
import { useUsageTileStatus } from './status';

/**
 * Usage: tokens and cost by day, week and month, by agent, model and
 * project; plan windows as the agents reported them; budgets; money left
 * with API providers. Registration only. The home screen has no widget
 * registry yet, so the tile's status line carries the headline figure.
 */
registerFeatureRoutes({ path: 'usage', name: 'usage.title', load: () => import('./UsageScreen') });

registerSystemTile({ id: 'usage', title: 'usage.title', icon: ChartColumn, tint: 'teal', to: '/usage', order: 50, useStatus: useUsageTileStatus });
