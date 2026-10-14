import { ChevronLeft, ChevronRight, FolderPlus, Minus, Plus, X } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import type { SystemTile, TileStatus } from '@/registry';
import { isImeConfirm } from '@/ui';
import type { TileInfo } from './catalogue';
import { NAME_MAX } from './layout';

/** The part a tile shares in every state: its plate, and its name and line under it. */
export function TileFace({ icon, tint, name, showName, status, create, children }: { icon: ReactNode; tint?: string | undefined; name: string; showName: boolean; status?: TileStatus | null; create?: boolean; children?: ReactNode }) {
  return (
    <>
      <span className="tile__plate" data-tint={tint} data-create={create || undefined}>
        {icon}
      </span>
      <span className="tile__text" data-hidden-names={!showName || undefined}>
        {children ?? <span className={showName ? 'tile__name' : 'visually-hidden'}>{name}</span>}
        {status && showName && (
          <span className="tile__status" data-tone={status.tone ?? 'neutral'}>
            {status.text}
          </span>
        )}
      </span>
    </>
  );
}

const useNoStatus = (): TileStatus | null => null;

/** A system tile's live line. Each instance always belongs to the same registration, so its hook never changes. */
export function useSystemStatus(tile: SystemTile | undefined): TileStatus | null {
  const useStatus = tile?.useStatus ?? useNoStatus;
  return useStatus();
}

/** A name being typed in place: Enter or leaving keeps it, Escape keeps the old one. */
export function RenameField({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => field.current?.select(), []);
  const finish = (name: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  };
  return (
    <input
      ref={field}
      className="tile__rename"
      value={value}
      maxLength={NAME_MAX * 2}
      aria-label={label}
      enterKeyHint="done"
      data-no-drag=""
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !isImeConfirm(event)) {
          event.preventDefault();
          finish(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}

export interface EditControls {
  canEarlier: boolean;
  canLater: boolean;
  onMove: (delta: -1 | 1) => void;
  onHide?: (() => void) | undefined;
  onDissolve?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  onFolder?: ((anchor: HTMLElement) => void) | undefined;
}

/**
 * The edit-mode controls of a tile: a badge to hide it (or to undo a folder),
 * and — for keyboards and assistive technology, out of sight until focused —
 * move earlier, add to a folder, move later. (Its name is a button of its own
 * in edit mode: that is how it is renamed, by touch or by keyboard.)
 */
export function TileEditControls({ name, controls }: { name: string; controls: EditControls }) {
  const t = useT();
  const folderButton = useRef<HTMLButtonElement>(null);
  return (
    <>
      {controls.onHide && (
        <button type="button" className="tile__badge" data-no-drag="" aria-label={t('home.edit.hide', { name })} title={t('home.edit.hide', { name })} onClick={controls.onHide}>
          <Minus size={14} strokeWidth={3} aria-hidden="true" />
        </button>
      )}
      {controls.onDissolve && (
        <button type="button" className="tile__badge" data-no-drag="" aria-label={t('home.tileFolder.dissolve', { name })} title={t('home.tileFolder.dissolve', { name })} onClick={controls.onDissolve}>
          <X size={14} strokeWidth={3} aria-hidden="true" />
        </button>
      )}
      <div className="tile__access" data-no-drag="" role="group" aria-label={t('home.edit.controlsOf', { name })}>
        <button type="button" className="tile__access-button" data-move="earlier" aria-label={t('home.edit.earlier', { name })} disabled={!controls.canEarlier} onClick={() => controls.onMove(-1)}>
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        {controls.onFolder && (
          <button ref={folderButton} type="button" className="tile__access-button" aria-label={t('home.edit.toFolder', { name })} aria-haspopup="menu" onClick={() => folderButton.current && controls.onFolder?.(folderButton.current)}>
            <FolderPlus size={16} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="tile__access-button" data-move="later" aria-label={t('home.edit.later', { name })} disabled={!controls.canLater} onClick={() => controls.onMove(1)}>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

export interface LauncherTileProps {
  info: TileInfo;
  /** What the tile is called now: its custom name, or its own. */
  name: string;
  status: TileStatus | null;
  editing: boolean;
  showName: boolean;
  renaming: boolean;
  onRenamed: (name: string | null) => void;
  onOpen: () => void;
  /** Where a link tile leads (https only); null for every other tile. */
  href: string | null;
  controls: EditControls;
}

/** One tile of the launcher, in its normal and its edit-mode form. */
export function LauncherTile({ info, name, status, editing, showName, renaming, onRenamed, onOpen, href, controls }: LauncherTileProps) {
  const t = useT();
  const Icon = info.icon;
  const icon = <Icon size={30} aria-hidden="true" />;
  if (editing) {
    return (
      <div className="tile" data-editing="">
        <div className="tile__body" role="group" aria-label={name} title={name}>
          <TileFace icon={icon} tint={info.tint} name={name} showName={showName}>
            {renaming ? (
              <RenameField initial={name} label={t('home.edit.renameLabel')} onDone={onRenamed} />
            ) : (
              <button type="button" className="tile__name-button" aria-label={t('home.edit.rename', { name })} onClick={controls.onRename}>
                <span className={showName ? 'tile__name' : 'visually-hidden'}>{name}</span>
              </button>
            )}
          </TileFace>
        </div>
        <TileEditControls name={name} controls={controls} />
      </div>
    );
  }
  if (href) {
    return (
      <div className="tile">
        <a className="tile__body u-no-callout" href={href} target="_blank" rel="noopener noreferrer" title={name} draggable={false} aria-label={t('home.link.open', { name })}>
          <TileFace icon={icon} tint={info.tint} name={name} showName={showName} status={status} />
        </a>
      </div>
    );
  }
  return (
    <div className="tile">
      <button type="button" className="tile__body u-no-callout" onClick={onOpen} title={name}>
        <TileFace icon={icon} tint={info.tint} name={name} showName={showName} status={status} />
      </button>
    </div>
  );
}

/** A folder: up to nine little plates of what it holds, and its name. */
export function FolderTile({ name, items, editing, showName, onOpen, controls }: { name: string; items: readonly TileInfo[]; editing: boolean; showName: boolean; onOpen: () => void; controls: EditControls }) {
  const t = useT();
  return (
    <div className="tile" data-editing={editing || undefined}>
      <button type="button" className="tile__body u-no-callout" onClick={onOpen} title={name} aria-label={t('home.tileFolder.open', { name, count: t.number(items.length) })}>
        <span className="tile__plate tile__plate--folder" aria-hidden="true">
          {items.slice(0, 9).map((item) => {
            const Icon = item.icon;
            return (
              <span key={item.id} className="tile__mini" data-tint={item.tint}>
                <Icon size={11} strokeWidth={2.4} />
              </span>
            );
          })}
        </span>
        <span className="tile__text">
          <span className={showName ? 'tile__name' : 'visually-hidden'}>{name}</span>
        </span>
      </button>
      {editing && <TileEditControls name={name} controls={controls} />}
    </div>
  );
}

/** "New project", after the last tile. */
export function CreateTile({ label, onPress, showName }: { label: string; onPress: () => void; showName: boolean }) {
  return (
    <div className="tile">
      <button type="button" className="tile__body u-no-callout" onClick={onPress} title={label}>
        <TileFace icon={<Plus size={28} aria-hidden="true" />} name={label} showName={showName} create />
      </button>
    </div>
  );
}

/** Props that make an element a draggable slot of the launcher. */
export interface SlotProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}
