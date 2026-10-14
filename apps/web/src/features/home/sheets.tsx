import type { PluginContributions } from '@agent-studio/protocol';
import { Check, FolderOutput, LayoutGrid, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { Button, EmptyState, Glyph, List, ListRow, Sheet, isImeConfirm } from '@/ui';
import type { TileInfo } from './catalogue';
import { type Entry, MAX_WIDGETS, WIDGET_SIZES, type WidgetSize, type WidgetType } from './layout';
import { LauncherTile } from './Tile';
import { SIZE_WORDS } from './widgets/WidgetArea';
import { WIDGET_KINDS } from './widgets/kinds';

// ---- the library: hidden tiles ---------------------------------------------------------------

export function LibrarySheet({ open, onClose, hidden, infos, nameOf, onRestore }: { open: boolean; onClose: () => void; hidden: readonly string[]; infos: ReadonlyMap<string, TileInfo>; nameOf: (id: string) => string; onRestore: (id: string) => void }) {
  const t = useT();
  const shown = hidden.filter((id) => infos.has(id));
  return (
    <Sheet open={open} onClose={onClose} title={t('home.library.title')} flush>
      {shown.length === 0 ? (
        <EmptyState compact icon={<Check size={26} />} title={t('home.library.empty')} description={t('home.library.emptyText')} />
      ) : (
        <List footer={t('home.library.footer')}>
          {shown.map((id) => {
            const info = infos.get(id)!;
            const Icon = info.icon;
            return (
              <ListRow
                key={id}
                leading={<Glyph icon={<Icon size={18} />} tint={info.tint} />}
                title={nameOf(id)}
                trailing={
                  <Button size="sm" variant="tinted" icon={<Plus size={16} />} onClick={() => onRestore(id)} aria-label={t('home.library.restoreName', { name: nameOf(id) })}>
                    {t('home.library.restore')}
                  </Button>
                }
              />
            );
          })}
        </List>
      )}
    </Sheet>
  );
}

// ---- the widget gallery ------------------------------------------------------------------------

export interface GalleryChoice {
  type: WidgetType;
  pluginId?: string;
  /** Shown in place of the kind's name (a plugin's links). */
  name?: string;
}

export function WidgetGallery({ open, onClose, contributions, count, onAdd }: { open: boolean; onClose: () => void; contributions: PluginContributions | undefined; count: number; onAdd: (choice: GalleryChoice, size: WidgetSize) => void }) {
  const t = useT();
  const plugins = new Map<string, string>();
  for (const link of contributions?.linkTiles ?? []) plugins.set(link.pluginId, link.pluginName);
  const choices: GalleryChoice[] = [{ type: 'usage' }, { type: 'inbox' }, { type: 'running' }, ...[...plugins].map(([pluginId, name]) => ({ type: 'plugin-links' as const, pluginId, name: t('home.widget.linksOf', { plugin: name }) }))];
  const full = count >= MAX_WIDGETS;
  return (
    <Sheet open={open} onClose={onClose} title={t('home.widget.gallery')} size="lg">
      <div className="hw-gallery">
        {full && <p className="hw-gallery__note">{t('home.widget.full', { max: t.number(MAX_WIDGETS) })}</p>}
        <ul className="hw-gallery__list">
          {choices.map((choice) => {
            const kind = WIDGET_KINDS[choice.type];
            const name = choice.name ?? t(kind.title);
            const Icon = kind.icon;
            return (
              <li key={`${choice.type}:${choice.pluginId ?? ''}`} className="hw-gallery__item">
                <Glyph icon={<Icon size={18} />} tint={kind.tint} size={36} />
                <div className="hw-gallery__text">
                  <p className="hw-gallery__name">{name}</p>
                  <p className="hw-gallery__description">{t(kind.description)}</p>
                </div>
                <div className="hw-gallery__sizes" role="group" aria-label={t('home.widget.sizesOf', { name })}>
                  {WIDGET_SIZES.map((size) => (
                    <Button key={size} size="sm" variant="neutral" disabled={full} onClick={() => onAdd(choice, size)} aria-label={t('home.widget.add', { size: t(SIZE_WORDS[size]), name })}>
                      {t(SIZE_WORDS[size])}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Sheet>
  );
}

// ---- an open folder ------------------------------------------------------------------------------

export interface FolderSheetProps {
  folder: Extract<Entry, { kind: 'folder' }> | null;
  open: boolean;
  onClose: () => void;
  editing: boolean;
  showName: boolean;
  infos: ReadonlyMap<string, TileInfo>;
  nameOf: (id: string) => string;
  onOpenTile: (info: TileInfo) => void;
  hrefOf: (info: TileInfo) => string | null;
  onRename: (name: string) => void;
  onRenameTile: (id: string, name: string | null) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
}

/** A folder, opened over the launcher: its tiles under its name; in edit mode, rename, reorder and take tiles out. */
export function FolderSheet({ folder, open, onClose, editing, showName, infos, nameOf, onOpenTile, hrefOf, onRename, onRenameTile, onMove, onRemove }: FolderSheetProps) {
  const t = useT();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState(folder?.name ?? '');
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => setName(folder?.name ?? ''), [folder?.name, open]);
  if (!folder) return null;
  const items = folder.items.filter((id) => infos.has(id));
  const commitName = () => {
    if (name.trim() === '') setName(folder.name);
    else if (name !== folder.name) onRename(name);
  };
  return (
    <Sheet open={open} onClose={onClose} title={folder.name} size="md">
      <div className="hf">
        {editing && (
          <input
            ref={field}
            className="hf__name"
            value={name}
            maxLength={48}
            aria-label={t('home.tileFolder.nameLabel')}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeConfirm(event)) {
                event.preventDefault();
                commitName();
                field.current?.blur();
              } else if (event.key === 'Escape') {
                // The field takes Escape first: the old name comes back and the folder stays open.
                event.preventDefault();
                event.stopPropagation();
                setName(folder.name);
              }
            }}
          />
        )}
        {items.length === 0 ? (
          <EmptyState compact icon={<LayoutGrid size={26} />} title={t('home.tileFolder.empty')} />
        ) : (
          <ul className="hf__grid" aria-label={folder.name}>
            {items.map((id, index) => {
              const info = infos.get(id)!;
              return (
                <li key={id} className="tile-slot">
                  <LauncherTile
                    info={info}
                    name={nameOf(id)}
                    status={null}
                    editing={editing}
                    showName={showName}
                    renaming={renaming === id}
                    onRenamed={(next) => {
                      setRenaming(null);
                      onRenameTile(id, next);
                    }}
                    onOpen={() => {
                      onClose();
                      onOpenTile(info);
                    }}
                    href={hrefOf(info)}
                    controls={{
                      canEarlier: index > 0,
                      canLater: index < items.length - 1,
                      onMove: (delta) => onMove(id, delta),
                      onRename: () => setRenaming(id),
                    }}
                  />
                  {editing && (
                    <button type="button" className="tile__badge" data-tone="out" aria-label={t('home.tileFolder.takeOut', { name: nameOf(id) })} title={t('home.tileFolder.takeOut', { name: nameOf(id) })} onClick={() => onRemove(id)}>
                      <FolderOutput size={13} strokeWidth={2.6} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editing && <p className="hf__hint">{t('home.tileFolder.editHint')}</p>}
      </div>
    </Sheet>
  );
}

