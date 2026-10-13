import type { LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/i18n';
import type { Tint } from '@/ui/tints';

/**
 * The system tiles of the home screen (project tiles come from the server).
 *
 *   registerSystemTile({ id: 'inbox', title: 'inbox.title', icon: Inbox, tint: 'red', to: '/inbox', useStatus: useInboxTileStatus });
 */
export interface TileStatus {
  /** One short line under the tile's name: "3 need you", "Not set up". */
  text: string;
  tone?: 'neutral' | 'attention' | 'positive' | 'danger';
}

export interface SystemTile {
  id: string;
  title: MessageKey;
  icon: LucideIcon;
  tint: Tint;
  /** Where the tile goes. Must be a registered route. */
  to: string;
  /** Position among the system tiles; lower comes first. Default 100. */
  order?: number;
  /** `owner` hides the tile from members. Default `user`. */
  access?: 'user' | 'owner';
  /**
   * A hook for the tile's live status line. Return null for none — and while
   * the underlying state is still loading, so the line never flickers through
   * a wrong value. It is called only while the home screen is on show.
   */
  useStatus?: () => TileStatus | null;
}

const tiles: SystemTile[] = [];

export function registerSystemTile(...added: SystemTile[]): void {
  for (const tile of added) {
    if (tiles.some((existing) => existing.id === tile.id)) throw new Error(`The tile "${tile.id}" is registered twice.`);
    tiles.push(tile);
  }
}

/** The system tiles a user with `role` sees, in display order. */
export function systemTiles(role: 'owner' | 'member'): SystemTile[] {
  return tiles.filter((tile) => tile.access !== 'owner' || role === 'owner').sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** For tests. */
export function __resetTilesForTests(): void {
  tiles.length = 0;
}
