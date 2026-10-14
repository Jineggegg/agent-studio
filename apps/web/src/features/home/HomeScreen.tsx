import type { Project } from '@agent-studio/protocol';
import { Check, ChevronLeft, ChevronRight, LayoutGrid, Library, Moon, PencilRuler, RefreshCw, Settings, Sun } from 'lucide-react';
import { type CSSProperties, type ReactNode, type Ref, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { useProjects, useProjectsLiveUpdates } from '@/data/projects';
import { useSession } from '@/data/session';
import { usePluginContributions, usePluginsLiveUpdates } from '@/features/plugins/contributions';
import { WelcomeCard } from '@/features/onboarding/WelcomeCard';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { useTheme } from '@/platform/theme';
import { checkForUpdate } from '@/pwa/update';
import { type TileStatus, projectPath, settingsPath, systemTiles } from '@/registry';
import { useScreenActive } from '@/shell/ScreenStack';
import { toggleTheme } from '@/shell/appearance';
import { announceFirstPaint } from '@/shell/launch';
import { useDocumentTitle } from '@/shell/title';
import { Banner, Button, IconButton, Menu, Skeleton, StaleNotice, Switch, isAnyOverlayOpen, progress, toast, useDelayedFlag } from '@/ui';
import { NewProjectSheet } from './NewProjectSheet';
import { ProjectSheet } from './ProjectSheet';
import { CreateTile, FolderTile, LauncherTile, TileFace, useSystemStatus } from './Tile';
import { type TileInfo, buildCatalogue, panelScreenPath, safeLinkUrl } from './catalogue';
import { type DropResult, type Ghost, useGridDrag } from './drag';
import { useFlip } from './flip';
import {
  type Entry,
  addToFolder,
  addWidget,
  dissolveFolder,
  folderOfOne,
  hideTile,
  isFolderId,
  makeFolder,
  moveBy,
  moveInFolder,
  moveToNewPage,
  applyOrder,
  paginate,
  removeFromFolder,
  renameFolder,
  renameTile,
  restoreTile,
} from './layout';
import { setHomeLook, useHomeLook } from './look';
import { FolderSheet, LibrarySheet, WidgetGallery } from './sheets';
import { TILE_GEOMETRY, gridFor, largeGeometry, namelessGeometry, rowsBelow, usePageTracking, usePagerSize } from './usePaging';
import { defaultWidgets, useHomeLayout, useLayoutMerging } from './useHomeLayout';
import { WidgetArea } from './widgets/WidgetArea';
import './home.css';

/** An id for an attribute selector (ids hold ':' and '.'). */
/** `.home__page`'s top padding and the gap between its widgets and its tiles, in px (home.css). */
const PAGE_TOP_PADDING = 12;
const WIDGET_GAP = 18;

const cssEscape = (value: string): string => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&'));

type Cell = { kind: 'entry'; id: string; entry: Entry } | { kind: 'create'; id: 'create' } | { kind: 'placeholder'; id: string };

/** The default name of a tile: a system app's title, a project's or a plugin's own name. */
function useDefaultName() {
  const t = useT();
  return useCallback((info: TileInfo): string => (info.kind === 'system' ? t(info.system.title) : info.kind === 'project' ? info.project.name : info.kind === 'panel' ? info.panel.title : info.link.title), [t]);
}

/** A catalogue tile in the grid, with its live line. One cell always shows the same tile, so it always calls the same status hook. */
function TileCell(props: { info: TileInfo; name: string; editing: boolean; showName: boolean; renaming: boolean; onRenamed: (name: string | null) => void; onOpen: () => void; controls: Parameters<typeof LauncherTile>[0]['controls'] }) {
  const t = useT();
  const system = useSystemStatus(props.info.kind === 'system' ? props.info.system : undefined);
  const status: TileStatus | null = system ?? (props.info.kind === 'project' && props.info.project.access === 'read' ? { text: t('home.project.readOnly') } : null);
  return (
    <LauncherTile
      info={props.info}
      name={props.name}
      status={status}
      editing={props.editing}
      showName={props.showName}
      renaming={props.renaming}
      onRenamed={props.onRenamed}
      onOpen={props.onOpen}
      href={props.info.kind === 'link' ? safeLinkUrl(props.info.link.url) : null}
      controls={props.controls}
    />
  );
}

/** The lifted copy of a tile, following the finger above everything. */
function TileGhost({ ghost, ghostRef, children }: { ghost: Ghost; ghostRef: Ref<HTMLDivElement | null>; children: ReactNode }) {
  const own = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (own.current) own.current.style.transform = `translate3d(${ghost.x}px, ${ghost.y}px, 0)`;
    // Placed once; the drag moves it from here on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghost.id]);
  return createPortal(
    <div
      ref={(element) => {
        own.current = element;
        if (typeof ghostRef === 'function') ghostRef(element);
        else if (ghostRef) (ghostRef as { current: HTMLDivElement | null }).current = element;
      }}
      className="home-ghost"
      style={{ width: ghost.width, height: ghost.height }}
      aria-hidden="true"
    >
      {children}
    </div>,
    document.body,
  );
}

/**
 * The launcher: today's date, a few actions, widgets, and pages of tiles —
 * the system apps features registered, one tile per project, what plugins
 * add, and "New project". It stays mounted under whatever app is open, so
 * coming back is instant and nothing has moved.
 *
 * In edit mode (a long press, or the edit action) tiles and widgets can be
 * dragged — or moved with buttons — hidden into the library, renamed in
 * place, gathered into folders; widgets are added, resized and removed. The
 * arrangement follows the person to every device (`home.layout`); how the
 * launcher looks (names, large icons) belongs to this device.
 */
export default function HomeScreen() {
  const t = useT();
  const navigate = useNavigate();
  const active = useScreenActive();
  const layoutClass = useLayoutClass();
  const theme = useTheme();
  const user = useSession((state) => state.user);
  const isOwner = user?.role === 'owner';
  const projects = useProjects();
  const contributions = usePluginContributions();
  const staleness = useStaleness(projects);
  useProjectsLiveUpdates();
  usePluginsLiveUpdates();
  useLayoutMerging();
  useDocumentTitle('');
  useEffect(() => announceFirstPaint(), []);
  const look = useHomeLook();
  const defaultName = useDefaultName();

  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [folderMenu, setFolderMenu] = useState<{ tileId: string } | null>(null);
  const folderMenuAnchor = useRef<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [unreadableDismissed, setUnreadableDismissed] = useState(false);
  const [focusAfterMove, setFocusAfterMove] = useState<{ id: string; which: 'earlier' | 'later' } | null>(null);
  const showPlaceholders = useDelayedFlag(projects.isPending);
  const now = useToday(active);
  const announce = useCallback((text: string) => {
    // A repeated sentence is still spoken: clear first, then say it.
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(text), 30);
  }, []);

  // ---- what exists, and how it is arranged -----------------------------------------------
  const system = useMemo(() => systemTiles(isOwner ? 'owner' : 'member'), [isOwner]);
  const catalogue = useMemo(() => buildCatalogue(system, projects.data, contributions.data), [system, projects.data, contributions.data]);
  const infos = useMemo(() => new Map(catalogue.map((info) => [info.id, info])), [catalogue]);
  const known = useMemo(() => catalogue.map((info) => info.id), [catalogue]);
  const home = useHomeLayout(known, projects.isSuccess && contributions.isSuccess);
  const { layout, arrangement } = home;
  const nameOf = useCallback((id: string): string => {
    const info = infos.get(id);
    return layout.names[id] ?? (info ? defaultName(info) : id);
  }, [infos, layout.names, defaultName]);
  const entryName = useCallback((entry: Entry): string => (entry.kind === 'folder' ? entry.name : nameOf(entry.id)), [nameOf]);
  const widgets = layout.widgets ?? defaultWidgets(layoutClass);

  // ---- pages ---------------------------------------------------------------------------------
  const pager = useRef<HTMLDivElement>(null);
  const size = usePagerSize(pager, editing);
  const sized = look.largeIcons ? largeGeometry(TILE_GEOMETRY[layoutClass]) : TILE_GEOMETRY[layoutClass];
  const geometry = look.showNames ? sized : namelessGeometry(sized);
  // Rows fill what a page leaves under its own top padding.
  const pageHeight = Math.max(0, (size.height || 600) - PAGE_TOP_PADDING);
  const metrics = gridFor(size.width || 390, pageHeight, geometry);
  const [widgetHeight, setWidgetHeight] = useState(0);
  const widgetObserver = useRef<ResizeObserver | null>(null);
  const widgetAreaRef = useCallback((element: HTMLDivElement | null) => {
    widgetObserver.current?.disconnect();
    widgetObserver.current = null;
    if (!element) {
      setWidgetHeight(0);
      return;
    }
    const measure = () => setWidgetHeight(element.offsetHeight);
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      widgetObserver.current = new ResizeObserver(measure);
      widgetObserver.current.observe(element);
    }
  }, []);
  const widgetsShown = widgets.length > 0;
  // Counted with the rows' real height, so the last row under the widgets is never cut off.
  const firstRows = rowsBelow(pageHeight, widgetsShown ? widgetHeight + WIDGET_GAP : 0, { ...geometry, rowHeight: metrics.rowHeight });
  const capacity = metrics.columns * metrics.rows;
  const firstCapacity = metrics.columns * firstRows;

  // ---- dragging --------------------------------------------------------------------------------
  const entryIds = useMemo(() => arrangement.entries.map((entry) => entry.id), [arrangement]);
  const [pageCountForDrag, setPageCountForDrag] = useState(1);
  const [pageNow, setPageNow] = useState(0);
  const goToRef = useRef<(page: number) => void>(() => {});
  const drag = useGridDrag({
    container: pager,
    editing,
    ids: entryIds,
    onEnterEdit: () => setEditing(true),
    canLift: (id) => arrangement.entries.some((entry) => entry.id === id),
    canMerge: (dragged, target) => !isFolderId(dragged) && infos.has(dragged) && (infos.has(target) || isFolderId(target)),
    pages: { current: pageNow, count: pageCountForDrag, goTo: (page) => goToRef.current(page) },
    onDrop: (result: DropResult) => onDrop(result),
  });

  const ordered = useMemo(() => {
    const order = drag.preview ?? entryIds;
    const byId = new Map(arrangement.entries.map((entry) => [entry.id, entry]));
    return order.map((id) => byId.get(id)).filter((entry): entry is Entry => entry !== undefined);
  }, [drag.preview, entryIds, arrangement]);

  const cells = useMemo<Cell[]>(() => {
    const list: Cell[] = ordered.map((entry) => ({ kind: 'entry', id: entry.id, entry }));
    if (!projects.data && showPlaceholders) for (let index = 0; index < 4; index += 1) list.push({ kind: 'placeholder', id: `placeholder-${index}` });
    if (isOwner && !editing) list.push({ kind: 'create', id: 'create' });
    return list;
  }, [ordered, projects.data, showPlaceholders, isOwner, editing]);
  const pages = useMemo(() => paginate(cells, firstCapacity, capacity, arrangement.pageStarts), [cells, firstCapacity, capacity, arrangement.pageStarts]);
  const pageCount = pages.length + (drag.dragged ? 1 : 0);
  const { page, goTo, onScroll } = usePageTracking(pager, pageCount, size.width);
  goToRef.current = goTo;
  if (pageNow !== page) setPageNow(page);
  if (pageCountForDrag !== pageCount) setPageCountForDrag(pageCount);
  useFlip(pager, `${ordered.map((entry) => entry.id).join()}|${firstCapacity}|${capacity}`);

  const pageOf = useCallback((id: string) => pages.findIndex((cellsOfPage) => cellsOfPage.some((cell) => cell.id === id)), [pages]);

  // After a keyboard move across a page boundary: the page follows the tile, and focus stays on its button.
  useLayoutEffect(() => {
    if (!focusAfterMove) return;
    const target = pageOf(focusAfterMove.id);
    if (target >= 0 && target !== page) goTo(target);
    const button = pager.current?.querySelector<HTMLButtonElement>(`[data-slot-id="${cssEscape(focusAfterMove.id)}"] [data-move="${focusAfterMove.which}"]`);
    if (button && !button.disabled) button.focus({ preventScroll: true });
    else pager.current?.querySelector<HTMLButtonElement>(`[data-slot-id="${cssEscape(focusAfterMove.id)}"] [data-move]:not(:disabled)`)?.focus({ preventScroll: true });
    setFocusAfterMove(null);
  }, [focusAfterMove, pageOf, page, goTo]);

  // ---- writing ---------------------------------------------------------------------------------
  const positionText = (id: string, order: readonly string[]): string => {
    const index = order.indexOf(id);
    const pageIndex = paginate(order.map((entryId) => ({ id: entryId })), firstCapacity, capacity, arrangement.pageStarts).findIndex((cellsOfPage) => cellsOfPage.some((cell) => cell.id === id));
    return t('home.edit.position', { position: t.number(index + 1), count: t.number(order.length), page: t.number(pageIndex + 1) });
  };

  function onDrop(result: DropResult) {
    const draggedEntry = arrangement.entries.find((entry) => entry.id === result.dragged);
    const name = draggedEntry ? entryName(draggedEntry) : '';
    if (result.kind === 'order') {
      home.write((current, scene) => applyOrder(current, scene, result.ids));
      announce(t('home.edit.moved', { name, where: positionText(result.dragged, result.ids) }));
    } else if (result.kind === 'merge') {
      const target = result.target;
      if (isFolderId(target)) {
        home.write((current, scene) => addToFolder(current, scene, result.dragged, target));
        announce(t('home.tileFolder.added', { name, folder: entryName(arrangement.entries.find((entry) => entry.id === target)!) }));
      } else {
        const bothProjects = infos.get(result.dragged)?.kind === 'project' && infos.get(target)?.kind === 'project';
        const folderName = bothProjects ? t('home.tileFolder.projects') : t('home.tileFolder.tools');
        home.write((current, scene) => makeFolder(current, scene, result.dragged, target, folderName));
        announce(t('home.tileFolder.made', { folder: folderName, first: nameOf(target), second: name }));
      }
    } else if (result.kind === 'new-page') {
      home.write((current, scene) => moveToNewPage(current, scene, result.dragged));
      announce(t('home.edit.newPage', { name }));
    }
  }

  const moveEntryBy = (entry: Entry, delta: -1 | 1) => {
    const index = entryIds.indexOf(entry.id);
    const target = index + delta;
    if (target < 0 || target >= entryIds.length) return;
    const order = [...entryIds];
    order.splice(index, 1);
    order.splice(target, 0, entry.id);
    home.write((current, scene) => moveBy(current, scene, entry.id, delta));
    setFocusAfterMove({ id: entry.id, which: delta < 0 ? 'earlier' : 'later' });
    announce(t('home.edit.moved', { name: entryName(entry), where: positionText(entry.id, order) }));
  };

  const hide = (id: string) => {
    const name = nameOf(id);
    home.write((current, scene) => hideTile(current, scene, id));
    announce(t('home.edit.hidden', { name }));
    toast.show({ title: t('home.edit.hidden', { name }), action: { label: t('common.undo'), onSelect: () => home.write((current, scene) => restoreTile(current, scene, id)) } });
  };

  const openTile = (info: TileInfo) => {
    if (info.kind === 'system') void navigate(info.system.to);
    else if (info.kind === 'project') openProject(info.project);
    else if (info.kind === 'panel') void navigate(panelScreenPath(info.panel));
  };

  const openProject = (project: Project) => {
    const path = projectPath(project.id);
    if (path) void navigate(path);
    else setOpenProjectId(project.id);
  };

  // ---- leaving edit mode -------------------------------------------------------------------------
  // Whatever was being carried is put back by the drag itself when edit mode ends.
  const leaveEditing = useCallback(() => {
    setEditing(false);
    setRenaming(null);
  }, []);
  useEffect(() => {
    if (!active && editing) leaveEditing();
  }, [active, editing, leaveEditing]);

  // Left and right arrows turn pages; Escape leaves edit mode — unless the keys belong to something else right now.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isAnyOverlayOpen() || drag.dragged) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.getAttribute('role') === 'slider')) return;
      if (event.key === 'Escape' && editing) leaveEditing();
      else if (event.key === 'ArrowRight' && pageCount > 1) goTo(page + 1);
      else if (event.key === 'ArrowLeft' && pageCount > 1) goTo(page - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, goTo, page, pageCount, editing, leaveEditing, drag.dragged]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const done = progress.start();
    try {
      // A newer build, if one is being served, replaces this page right away.
      if (await checkForUpdate({ reloadIfNewer: true })) return;
      await Promise.all([projects.refetch(), contributions.refetch()]);
    } finally {
      done();
      setRefreshing(false);
    }
  }, [projects, contributions, refreshing]);

  const openProjectRecord = openProjectId ? (projects.data?.find((project) => project.id === openProjectId) ?? null) : null;
  const openFolder = openFolderId ? (arrangement.entries.find((entry): entry is Extract<Entry, { kind: 'folder' }> => entry.kind === 'folder' && entry.id === openFolderId) ?? null) : null;
  const [lastFolder, setLastFolder] = useState(openFolder);
  if (openFolder && openFolder !== lastFolder) setLastFolder(openFolder);
  const gridStyle = {
    '--columns': metrics.columns,
    '--row-height': `${metrics.rowHeight}px`,
    '--column-gap': `${geometry.columnGap}px`,
    '--row-gap': `${geometry.rowGap}px`,
  } as CSSProperties;
  const folders = arrangement.entries.filter((entry): entry is Extract<Entry, { kind: 'folder' }> => entry.kind === 'folder');

  const renderCell = (cell: Cell) => {
    if (cell.kind === 'placeholder') {
      return (
        <li key={cell.id} className="tile-slot">
          <div className="tile__skeleton" aria-hidden="true">
            <Skeleton width={60} height={60} radius={18} />
            <Skeleton width={52} height={10} />
          </div>
        </li>
      );
    }
    if (cell.kind === 'create') {
      return (
        <li key="create" className="tile-slot">
          <CreateTile label={t('home.newProject')} onPress={() => setCreating(true)} showName={look.showNames} />
        </li>
      );
    }
    const entry = cell.entry;
    const position = entryIds.indexOf(entry.id);
    const common = {
      className: 'tile-slot u-no-callout',
      'data-slot-id': entry.id,
      'data-flip-id': entry.id,
      'data-lifted': drag.dragged === entry.id || undefined,
      'data-merge': drag.mergeTarget === entry.id || undefined,
      ...drag.bind(entry.id),
    };
    if (entry.kind === 'folder') {
      const items = entry.items.map((id) => infos.get(id)).filter((info): info is TileInfo => info !== undefined);
      return (
        <li key={entry.id} {...common}>
          <FolderTile
            name={entry.name}
            items={items}
            editing={editing}
            showName={look.showNames}
            onOpen={() => setOpenFolderId(entry.id)}
            controls={{
              canEarlier: position > 0,
              canLater: position < entryIds.length - 1,
              onMove: (delta) => moveEntryBy(entry, delta),
              onDissolve: () => {
                home.write((current, scene) => dissolveFolder(current, scene, entry.id));
                announce(t('home.tileFolder.dissolved', { name: entry.name }));
              },
            }}
          />
        </li>
      );
    }
    const info = infos.get(entry.id);
    if (!info) return null;
    return (
      <li key={entry.id} {...common}>
        <TileCell
          info={info}
          name={nameOf(entry.id)}
          editing={editing}
          showName={look.showNames}
          renaming={renaming === entry.id}
          onRenamed={(name) => {
            setRenaming(null);
            if (name !== null) home.write((current) => renameTile(current, entry.id, name, defaultName(info)));
          }}
          onOpen={() => openTile(info)}
          controls={{
            canEarlier: position > 0,
            canLater: position < entryIds.length - 1,
            onMove: (delta) => moveEntryBy(entry, delta),
            onHide: () => hide(entry.id),
            onRename: () => setRenaming(entry.id),
            onFolder: (anchor) => {
              folderMenuAnchor.current = anchor;
              setFolderMenu({ tileId: entry.id });
            },
          }}
        />
      </li>
    );
  };

  const draggedEntry = drag.ghost ? arrangement.entries.find((entry) => entry.id === drag.ghost!.id) : undefined;
  const draggedInfo = draggedEntry?.kind === 'tile' ? infos.get(draggedEntry.id) : undefined;

  return (
    <main className="home" data-editing={editing || undefined} data-large={look.largeIcons || undefined} data-dragging={drag.dragged ? '' : undefined}>
      <header className="home__header">
        <div className="home__date">
          <h1 className="visually-hidden">{t('nav.home')}</h1>
          <p className="home__weekday">{t.date(now, 'weekday')}</p>
          <p className="home__day">{t.date(now, 'monthDay')}</p>
        </div>
        <div className="home__actions">
          {editing ? (
            <>
              <IconButton label={t('home.widget.addAction')} icon={<LayoutGrid size={21} />} onClick={() => setGalleryOpen(true)} />
              <IconButton label={arrangement.hidden.length > 0 ? t('home.library.openCount', { count: t.number(arrangement.hidden.length) }) : t('home.library.open')} icon={<Library size={21} />} onClick={() => setLibraryOpen(true)} />
              <Button variant="primary" size="sm" icon={<Check size={17} />} onClick={leaveEditing} className="home__done">
                {t('common.done')}
              </Button>
            </>
          ) : (
            <>
              <IconButton label={theme === 'dark' ? t('home.useLight') : t('home.useDark')} icon={theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />} onClick={toggleTheme} />
              <IconButton label={t('home.refresh')} icon={<RefreshCw size={21} />} busy={refreshing} onClick={() => void refresh()} />
              <IconButton label={t('home.edit.start')} icon={<PencilRuler size={21} />} onClick={() => setEditing(true)} />
              <IconButton label={t('settings.title')} icon={<Settings size={22} />} onClick={() => void navigate(settingsPath())} />
            </>
          )}
        </div>
      </header>

      {projects.isError && (
        <div className="home__notice">
          <Banner
            tone="warning"
            title={projects.data ? t('home.error.stale') : t('home.error.title')}
            action={
              <Button variant="plain" size="sm" onClick={() => void projects.refetch()} loading={projects.isFetching}>
                {t('common.retry')}
              </Button>
            }
          >
            {describeError(projects.error, t)}
          </Banner>
        </div>
      )}
      {!projects.isError && staleness.stale && (
        <div className="home__notice">
          <StaleNotice since={staleness.since} />
        </div>
      )}
      {home.status === 'unreadable' && !unreadableDismissed && (
        <div className="home__notice">
          <Banner
            tone="info"
            title={t('home.layout.unreadableTitle')}
            action={
              <Button variant="plain" size="sm" onClick={() => setUnreadableDismissed(true)}>
                {t('common.dismiss')}
              </Button>
            }
          >
            {t('home.layout.unreadable')}
          </Banner>
        </div>
      )}
      {!editing && <WelcomeCard className="home__notice" />}
      {projects.data?.length === 0 && !editing && (
        <div className="home__notice">
          <p className="home__hint">{isOwner ? t('home.empty.owner') : t('home.empty.member')}</p>
        </div>
      )}

      <div
        ref={pager}
        className="home__pager"
        onScroll={onScroll}
        role="group"
        aria-label={t('home.pages')}
        onClick={(event) => {
          // A tap on empty space ends edit mode; a tap on anything that does something does not, nor does the end of a swipe.
          if (!editing || drag.dragged) return;
          const target = event.target as HTMLElement;
          if (target.closest('.tile-slot, .hw-card, button, a, input')) return;
          leaveEditing();
        }}
      >
        {pages.map((pageCells, index) => (
          <section
            key={index}
            className="home__page"
            data-page={index}
            aria-label={t('home.pageOf', { page: index + 1, count: pages.length })}
            onFocus={() => {
              // Keyboard focus landing on another page brings that page into view.
              if (index !== page) goTo(index);
            }}
          >
            {index === 0 && widgetsShown && (
              <WidgetArea
                widgets={widgets}
                editing={editing}
                contributions={contributions.data}
                onEnterEdit={() => setEditing(true)}
                onChange={(next) => home.write((current) => ({ ...current, widgets: next }))}
                onOpen={(to) => void navigate(to)}
                announce={announce}
                areaRef={widgetAreaRef}
              />
            )}
            <ul className="home__grid" style={gridStyle}>
              {pageCells.map((cell) => renderCell(cell))}
            </ul>
          </section>
        ))}
        {drag.dragged && (
          <section className="home__page home__page--new" data-page="new" aria-hidden="true">
            <div className="home__new-page" data-new-page="" data-armed={drag.overNewPage || undefined}>
              <span>{t('home.edit.newPageHint')}</span>
            </div>
          </section>
        )}
      </div>

      <footer className="home__footer">
        {pageCount > 1 && (
          <div className="home__pages">
            <IconButton label={t('home.previousPage')} icon={<ChevronLeft size={22} />} tone="secondary" disabled={page === 0} onClick={() => goTo(page - 1)} />
            <div className="home__dots" role="img" aria-label={t('home.pageOf', { page: page + 1, count: pageCount })}>
              {Array.from({ length: pageCount }, (_, index) => (
                <span key={index} className="home__dot" data-current={index === page || undefined} data-new={drag.dragged && index === pageCount - 1 ? '' : undefined} />
              ))}
            </div>
            <IconButton label={t('home.nextPage')} icon={<ChevronRight size={22} />} tone="secondary" disabled={page >= pageCount - 1} onClick={() => goTo(page + 1)} />
          </div>
        )}
        {editing && (
          <div className="home__look" role="group" aria-label={t('home.look.title')}>
            <label className="home__look-item">
              <span>{t('home.look.names')}</span>
              <Switch checked={look.showNames} onChange={(showNames) => setHomeLook({ showNames })} label={t('home.look.names')} />
            </label>
            <label className="home__look-item">
              <span>{t('home.look.large')}</span>
              <Switch checked={look.largeIcons} onChange={(largeIcons) => setHomeLook({ largeIcons })} label={t('home.look.large')} />
            </label>
          </div>
        )}
      </footer>

      {drag.ghost && (
        <TileGhost ghost={drag.ghost} ghostRef={drag.ghostRef}>
          {draggedInfo ? (
            (() => {
              const Icon = draggedInfo.icon;
              return <TileFace icon={<Icon size={30} aria-hidden="true" />} tint={draggedInfo.tint} name={nameOf(draggedInfo.id)} showName={look.showNames} />;
            })()
          ) : draggedEntry?.kind === 'folder' ? (
            <TileFace icon={<LayoutGrid size={28} aria-hidden="true" />} name={draggedEntry.name} showName={look.showNames} />
          ) : null}
        </TileGhost>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <Menu
        open={folderMenu !== null}
        onClose={() => setFolderMenu(null)}
        anchor={folderMenuAnchor}
        label={t('home.tileFolder.choose')}
        items={[
          ...folders.map((folder) => ({
            id: folder.id,
            label: folder.name,
            onSelect: () => {
              const tileId = folderMenu?.tileId;
              if (!tileId) return;
              home.write((current, scene) => addToFolder(current, scene, tileId, folder.id));
              announce(t('home.tileFolder.added', { name: nameOf(tileId), folder: folder.name }));
            },
          })),
          ...(folders.length > 0 ? [{ separator: true as const, id: 'separator' }] : []),
          {
            id: 'new-folder',
            label: t('home.tileFolder.new'),
            onSelect: () => {
              const tileId = folderMenu?.tileId;
              if (!tileId) return;
              const name = infos.get(tileId)?.kind === 'project' ? t('home.tileFolder.projects') : t('home.tileFolder.tools');
              home.write((current, scene) => folderOfOne(current, scene, tileId, name));
              announce(t('home.tileFolder.made1', { folder: name, name: nameOf(tileId) }));
            },
          },
        ]}
      />

      <FolderSheet
        folder={openFolder ?? lastFolder}
        open={openFolder !== null}
        onClose={() => setOpenFolderId(null)}
        editing={editing}
        showName={look.showNames}
        infos={infos}
        nameOf={nameOf}
        hrefOf={(info) => (info.kind === 'link' ? safeLinkUrl(info.link.url) : null)}
        onOpenTile={openTile}
        onRename={(name) => openFolderId && home.write((current) => renameFolder(current, openFolderId, name))}
        onRenameTile={(id, name) => {
          const info = infos.get(id);
          if (name !== null && info) home.write((current) => renameTile(current, id, name, defaultName(info)));
        }}
        onMove={(id, delta) => {
          const folder = openFolder;
          if (!folder) return;
          const index = folder.items.indexOf(id) + delta;
          home.write((current) => moveInFolder(current, folder.id, id, index));
          announce(t('home.tileFolder.movedInside', { name: nameOf(id), position: t.number(index + 1), count: t.number(folder.items.length) }));
        }}
        onRemove={(id) => {
          home.write((current, scene) => removeFromFolder(current, scene, id));
          announce(t('home.tileFolder.takenOut', { name: nameOf(id) }));
        }}
      />

      <LibrarySheet
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        hidden={arrangement.hidden}
        infos={infos}
        nameOf={nameOf}
        onRestore={(id) => {
          home.write((current, scene) => restoreTile(current, scene, id));
          announce(t('home.library.restored', { name: nameOf(id) }));
        }}
      />

      <WidgetGallery
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        contributions={contributions.data}
        count={widgets.length}
        onAdd={(choice, sizeChoice) => {
          home.write((current) => ({ ...current, widgets: addWidget(current.widgets ?? defaultWidgets(layoutClass), choice.type, sizeChoice, choice.pluginId) }));
          setGalleryOpen(false);
          announce(t('home.widget.added', { name: choice.name ?? choice.type }));
          goTo(0);
        }}
      />

      <NewProjectSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(project) => {
          const path = projectPath(project.id);
          if (path) void navigate(path);
        }}
      />
      <ProjectSheet project={openProjectRecord} onClose={() => setOpenProjectId(null)} />
    </main>
  );
}

/** The current moment, refreshed when the day may have changed: on return to the home screen and at midnight. */
function useToday(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const tomorrow = new Date();
    tomorrow.setHours(24, 0, 2, 0);
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(tomorrow.getTime() - Date.now(), 2 ** 31 - 1));
    const onVisible = () => document.visibilityState === 'visible' && setNow(Date.now());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active]);
  return now;
}
