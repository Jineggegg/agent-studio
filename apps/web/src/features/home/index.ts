import { LayoutGrid } from 'lucide-react';
import { registerSettingsPage } from '@/registry';

/**
 * The launcher itself is the app's base layer (main.tsx mounts `HomeScreen`
 * under every app). What it registers: Settings → Home screen — how the
 * launcher looks on this device, and the resets of the account's
 * arrangement.
 */
registerSettingsPage({ id: 'home', title: 'home.settings.title', icon: LayoutGrid, tint: 'blue', group: 'general', order: 15, load: () => import('./HomeSettingsPage') });
