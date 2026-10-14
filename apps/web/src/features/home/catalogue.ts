import type { PluginContributions, PluginLinkTileContribution, PluginPanelContribution, Project } from '@agent-studio/protocol';
import type { LucideIcon } from 'lucide-react';
import { pluginIcon } from '@/features/plugins/icons';
import type { SystemTile } from '@/registry';
import { type Tint, tintFor, toTint } from '@/ui';
import { projectSymbol } from './icons';
import { tileIds } from './layout';

/**
 * Every tile the launcher can show, in their natural order: the system apps
 * features registered, the person's projects, then what enabled plugins add
 * (panels opened from a tile, and links). The arrangement decides where each
 * goes; this decides what exists.
 */
export type TileInfo =
  | { kind: 'system'; id: string; icon: LucideIcon; tint: Tint; system: SystemTile }
  | { kind: 'project'; id: string; icon: LucideIcon; tint: Tint; project: Project }
  | { kind: 'panel'; id: string; icon: LucideIcon; tint: Tint; panel: PluginPanelContribution }
  | { kind: 'link'; id: string; icon: LucideIcon; tint: Tint; link: PluginLinkTileContribution };

export function buildCatalogue(system: readonly SystemTile[], projects: readonly Project[] | undefined, contributions: PluginContributions | undefined): TileInfo[] {
  const tiles: TileInfo[] = system.map((tile) => ({ kind: 'system', id: tileIds.system(tile.id), icon: tile.icon, tint: tile.tint, system: tile }));
  for (const project of projects ?? []) tiles.push({ kind: 'project', id: tileIds.project(project.id), icon: projectSymbol(project.icon.symbol), tint: toTint(project.icon.color), project });
  for (const panel of contributions?.homeTiles ?? []) tiles.push({ kind: 'panel', id: tileIds.panel(panel.pluginId, panel.panelId), icon: pluginIcon(panel.icon), tint: tintFor(panel.pluginId), panel });
  for (const link of contributions?.linkTiles ?? []) tiles.push({ kind: 'link', id: tileIds.link(link.pluginId, link.id), icon: pluginIcon(link.icon, 'link'), tint: tintFor(link.pluginId), link });
  return tiles;
}

/** The address a plugin's panel tile opens. */
export const panelScreenPath = (panel: Pick<PluginPanelContribution, 'pluginId' | 'panelId'>): string => `/plugins/${encodeURIComponent(panel.pluginId)}/${encodeURIComponent(panel.panelId)}`;

/** Only an https address leaves the Studio from a link tile; anything else is not offered. */
export function safeLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' ? parsed.href : null;
  } catch {
    return null;
  }
}
