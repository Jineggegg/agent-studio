import type { Project } from '@agent-studio/protocol';
import { ChevronLeft, ChevronRight, Moon, Plus, RefreshCw, Settings, Sun } from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useStaleness } from '@/data/connection';
import { describeError } from '@/data/errors';
import { useProjects, useProjectsLiveUpdates } from '@/data/projects';
import { useSession } from '@/data/session';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { useLongPress } from '@/platform/long-press';
import { useTheme } from '@/platform/theme';
import { checkForUpdate } from '@/pwa/update';
import { type SystemTile, type TileStatus, projectPath, settingsPath, systemTiles } from '@/registry';
import { useScreenActive } from '@/shell/ScreenStack';
import { toggleTheme } from '@/shell/appearance';
import { announceFirstPaint } from '@/shell/launch';
import { useDocumentTitle } from '@/shell/title';
import { Banner, Button, IconButton, Skeleton, StaleNotice, isAnyOverlayOpen, progress, toTint, useDelayedFlag } from '@/ui';
import { NewProjectSheet } from './NewProjectSheet';
import { ProjectSheet } from './ProjectSheet';
import { projectSymbol } from './icons';
import { TILE_GEOMETRY, chunk, usePaging } from './usePaging';
import './home.css';

interface TileViewProps {
  name: string;
  icon: ReactNode;
  tint?: string;
  status?: TileStatus | null;
  onOpen: () => void;
  /** A long press, right-click or context-menu key. */
  onMore?: (() => void) | undefined;
  create?: boolean;
}

function TileView({ name, icon, tint, status, onOpen, onMore, create }: TileViewProps) {
  const longPress = useLongPress(() => onMore?.());
  return (
    <button type="button" className="tile u-no-callout" onClick={onOpen} title={name} {...(onMore ? longPress : {})}>
      <span className="tile__plate" data-tint={tint} data-create={create || undefined}>
        {icon}
      </span>
      <span className="tile__text">
        <span className="tile__name">{name}</span>
        {status && (
          <span className="tile__status" data-tone={status.tone ?? 'neutral'}>
            {status.text}
          </span>
        )}
      </span>
    </button>
  );
}

const useNoStatus = (): TileStatus | null => null;

function SystemTileView({ tile, onOpen }: { tile: SystemTile; onOpen: () => void }) {
  const t = useT();
  // Each tile instance always belongs to the same registration, so its hook never changes.
  const useStatus = tile.useStatus ?? useNoStatus;
  const status = useStatus();
  const Icon = tile.icon;
  return <TileView name={t(tile.title)} icon={<Icon size={30} aria-hidden="true" />} tint={tile.tint} status={status} onOpen={onOpen} />;
}

type TileEntry = { kind: 'system'; tile: SystemTile } | { kind: 'project'; project: Project } | { kind: 'placeholder'; id: string } | { kind: 'create' };

/**
 * The launcher: today's date, a few actions, and pages of tiles — the system
 * apps that features have registered, one tile per project, and "New project".
 * It stays mounted under whatever app is open, so coming back is instant and
 * nothing has moved.
 */
export default function HomeScreen() {
  const t = useT();
  const navigate = useNavigate();
  const active = useScreenActive();
  const layout = useLayoutClass();
  const theme = useTheme();
  const user = useSession((state) => state.user);
  const isOwner = user?.role === 'owner';
  const projects = useProjects();
  const staleness = useStaleness(projects);
  useProjectsLiveUpdates();
  useDocumentTitle('');
  useEffect(() => announceFirstPaint(), []);

  const [creating, setCreating] = useState(false);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const showPlaceholders = useDelayedFlag(projects.isPending);

  const now = useToday(active);

  const entries = useMemo<TileEntry[]>(() => {
    const list: TileEntry[] = systemTiles(isOwner ? 'owner' : 'member').map((tile) => ({ kind: 'system', tile }));
    if (projects.data) for (const project of projects.data) list.push({ kind: 'project', project });
    else if (showPlaceholders) for (let index = 0; index < 4; index += 1) list.push({ kind: 'placeholder', id: `placeholder-${index}` });
    if (isOwner) list.push({ kind: 'create' });
    return list;
  }, [isOwner, projects.data, showPlaceholders]);

  const pager = useRef<HTMLDivElement>(null);
  const geometry = TILE_GEOMETRY[layout];
  const { metrics, page, goTo, onScroll } = usePaging(pager, (grid) => Math.ceil(entries.length / Math.max(1, grid.columns * grid.rows)) || 1);
  const pages = useMemo(() => chunk(entries, metrics.columns * metrics.rows), [entries, metrics]);
  const pageCount = pages.length;

  // Left and right arrows turn pages — unless the keys belong to something else right now.
  useEffect(() => {
    if (!active || pageCount < 2) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isAnyOverlayOpen()) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.getAttribute('role') === 'slider')) return;
      if (event.key === 'ArrowRight') goTo(page + 1);
      else if (event.key === 'ArrowLeft') goTo(page - 1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, goTo, page, pageCount]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const done = progress.start();
    try {
      // A newer build, if one is being served, replaces this page right away.
      if (await checkForUpdate({ reloadIfNewer: true })) return;
      await projects.refetch();
    } finally {
      done();
      setRefreshing(false);
    }
  }, [projects, refreshing]);

  const openProject = (project: Project) => {
    const path = projectPath(project.id);
    if (path) void navigate(path);
    else setOpenProjectId(project.id);
  };

  const openProjectRecord = openProjectId ? (projects.data?.find((project) => project.id === openProjectId) ?? null) : null;
  const gridStyle = {
    '--columns': metrics.columns,
    '--row-height': `${metrics.rowHeight}px`,
    '--column-gap': `${geometry.columnGap}px`,
    '--row-gap': `${geometry.rowGap}px`,
  } as CSSProperties;

  return (
    <main className="home">
      <header className="home__header">
        <div className="home__date">
          <h1 className="visually-hidden">{t('nav.home')}</h1>
          <p className="home__weekday">{t.date(now, 'weekday')}</p>
          <p className="home__day">{t.date(now, 'monthDay')}</p>
        </div>
        <div className="home__actions">
          <IconButton
            label={theme === 'dark' ? t('home.useLight') : t('home.useDark')}
            icon={theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />}
            onClick={toggleTheme}
          />
          <IconButton label={t('home.refresh')} icon={<RefreshCw size={21} />} busy={refreshing} onClick={() => void refresh()} />
          <IconButton label={t('settings.title')} icon={<Settings size={22} />} onClick={() => void navigate(settingsPath())} />
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
      {projects.data?.length === 0 && (
        <div className="home__notice">
          <p className="home__hint">{isOwner ? t('home.empty.owner') : t('home.empty.member')}</p>
        </div>
      )}

      <div ref={pager} className="home__pager" onScroll={onScroll} role="group" aria-label={t('home.pages')}>
        {pages.map((tiles, index) => (
          <section key={index} className="home__page" aria-label={t('home.pageOf', { page: index + 1, count: pageCount })}>
            <ul className="home__grid" style={gridStyle}>
              {tiles.map((entry) => (
                <li key={entry.kind === 'system' ? `system:${entry.tile.id}` : entry.kind === 'project' ? `project:${entry.project.id}` : entry.kind === 'create' ? 'create' : entry.id}>
                  {entry.kind === 'system' ? (
                    <SystemTileView tile={entry.tile} onOpen={() => void navigate(entry.tile.to)} />
                  ) : entry.kind === 'project' ? (
                    <TileView
                      name={entry.project.name}
                      icon={<ProjectIcon symbol={entry.project.icon.symbol} />}
                      tint={toTint(entry.project.icon.color)}
                      status={entry.project.access === 'read' ? { text: t('home.project.readOnly') } : null}
                      onOpen={() => openProject(entry.project)}
                      onMore={() => setOpenProjectId(entry.project.id)}
                    />
                  ) : entry.kind === 'create' ? (
                    <TileView name={t('home.newProject')} icon={<Plus size={28} aria-hidden="true" />} create onOpen={() => setCreating(true)} />
                  ) : (
                    <div className="tile__skeleton" aria-hidden="true">
                      <Skeleton width={60} height={60} radius={18} />
                      <Skeleton width={52} height={10} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <footer className="home__footer">
        {pageCount > 1 && (
          <>
            <IconButton label={t('home.previousPage')} icon={<ChevronLeft size={22} />} tone="secondary" disabled={page === 0} onClick={() => goTo(page - 1)} />
            <div className="home__dots" role="img" aria-label={t('home.pageOf', { page: page + 1, count: pageCount })}>
              {pages.map((_, index) => (
                <span key={index} className="home__dot" data-current={index === page || undefined} />
              ))}
            </div>
            <IconButton label={t('home.nextPage')} icon={<ChevronRight size={22} />} tone="secondary" disabled={page >= pageCount - 1} onClick={() => goTo(page + 1)} />
          </>
        )}
      </footer>

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

function ProjectIcon({ symbol }: { symbol: string }) {
  const Icon = projectSymbol(symbol);
  return <Icon size={30} aria-hidden="true" />;
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
