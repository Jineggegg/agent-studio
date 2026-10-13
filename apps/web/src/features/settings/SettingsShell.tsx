import { type ComponentType, type ReactNode, useEffect, useRef } from 'react';
import { useNavigate, useNavigationType, useParams } from 'react-router';
import { useSession } from '@/data/session';
import { type MessageKey, useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { SETTINGS_GROUPS, type SettingsGroup, type SettingsPage, findSettingsPage, settingsPages, settingsPath, settingsQuickControls } from '@/registry';
import { type LazyComponent, lazyScreen } from '@/shell/LazyScreen';
import { Screen } from '@/shell/Screen';
import { ScreenStack, useRouteTransition } from '@/shell/ScreenStack';
import { ScreenBoundary } from '@/shell/Boundary';
import { isSystemGesturePop, useBack } from '@/shell/back';
import { useScrollRestoration } from '@/shell/scroll';
import { useDocumentTitle } from '@/shell/title';
import { Avatar, Button, ErrorState, Glyph, List, ListRow } from '@/ui';
import { ChevronLeft } from 'lucide-react';
import './settings.css';

const GROUP_TITLES: Record<SettingsGroup, MessageKey | null> = {
  account: null,
  general: 'settings.group.general',
  assistants: 'settings.group.assistants',
  connections: 'settings.group.connections',
  system: 'settings.group.system',
};

const loaders = new Map<string, LazyComponent<object>>();
function componentFor(page: SettingsPage): LazyComponent<object> {
  let component = loaders.get(page.id);
  if (!component) loaders.set(page.id, (component = lazyScreen(page.load as () => Promise<{ default: ComponentType<object> }>)));
  return component;
}

const useNoSummary = (): string | undefined => undefined;

function PageRow({ page, selected, replace }: { page: SettingsPage; selected: boolean; replace: boolean }) {
  const t = useT();
  // A row always belongs to the same page, so the hook it calls never changes.
  const useSummary = page.useSummary ?? useNoSummary;
  const summary = useSummary();
  const Icon = page.icon;
  return (
    <ListRow
      leading={<Glyph icon={<Icon size={18} />} tint={page.tint} />}
      title={t(page.title)}
      value={summary}
      to={settingsPath(page.id)}
      replace={replace}
      selected={selected || undefined}
    />
  );
}

/** The root list: who is signed in, the one-tap controls, then every registered page by group. */
function RootList({ selectedId, split }: { selectedId: string | null; split: boolean }) {
  const t = useT();
  const user = useSession((state) => state.user);
  if (!user) return null;
  const pages = settingsPages(user.role).filter((page) => !page.parent);
  const quick = settingsQuickControls();
  const account = pages.find((page) => page.id === 'account');

  return (
    <>
      {account && (
        <List aria-label={t('settings.account.title')}>
          <ListRow
            leading={<Avatar name={user.displayName || user.username} size={48} />}
            title={
              <span className="settings-account__text">
                <span className="settings-account__name u-truncate">{user.displayName || user.username}</span>
              </span>
            }
            subtitle={`@${user.username} · ${t('settings.account.title')}`}
            to={settingsPath(account.id)}
            replace={split}
            selected={selectedId === account.id || undefined}
          />
          {pages
            .filter((page) => page.group === 'account' && page.id !== 'account')
            .map((page) => (
              <PageRow key={page.id} page={page} selected={selectedId === page.id} replace={split} />
            ))}
        </List>
      )}

      {quick.length > 0 && (
        <List aria-label={t('settings.quick')}>
          {quick.map(({ id, Component }) => (
            <div key={id} role="listitem">
              <Component />
            </div>
          ))}
        </List>
      )}

      {SETTINGS_GROUPS.filter((group) => group !== 'account' || !account).map((group) => {
        const members = pages.filter((page) => page.group === group);
        if (members.length === 0) return null;
        const title = GROUP_TITLES[group];
        return (
          <List key={group} header={title ? t(title) : undefined}>
            {members.map((page) => (
              <PageRow key={page.id} page={page} selected={selectedId === page.id} replace={split} />
            ))}
          </List>
        );
      })}
    </>
  );
}

function Problem({ kind }: { kind: 'missing' | 'forbidden' }) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <ErrorState
      kind={kind === 'missing' ? 'gone' : 'forbidden'}
      title={kind === 'missing' ? t('settings.missing.title') : t('shell.ownerOnly.title')}
      description={kind === 'missing' ? t('settings.missing.description') : t('shell.ownerOnly.description')}
      actions={
        <Button variant="tinted" onClick={() => void navigate(settingsPath(), { replace: true })}>
          {t('settings.backToSettings')}
        </Button>
      }
    />
  );
}

type Resolved = { state: 'ok'; page: SettingsPage } | { state: 'missing' } | { state: 'forbidden' };

function resolvePage(id: string, role: 'owner' | 'member'): Resolved {
  const page = findSettingsPage(id);
  if (!page) return { state: 'missing' };
  if (page.access === 'owner' && role !== 'owner') return { state: 'forbidden' };
  return { state: 'ok', page };
}

function PageContent({ resolved }: { resolved: Resolved }): ReactNode {
  if (resolved.state !== 'ok') return <Problem kind={resolved.state} />;
  const Component = componentFor(resolved.page);
  return (
    <ScreenBoundary resetKey={resolved.page.id}>
      <Component />
    </ScreenBoundary>
  );
}

/** Phone: one page fills the screen, pushed from the list. */
function PhonePage({ id, role }: { id: string; role: 'owner' | 'member' }) {
  const t = useT();
  const resolved = resolvePage(id, role);
  const parentPage = resolved.state === 'ok' && resolved.page.parent ? findSettingsPage(resolved.page.parent) : null;
  const parent = parentPage ? { to: settingsPath(parentPage.id), label: t(parentPage.title) } : { to: settingsPath(), label: t('settings.title') };
  return (
    <Screen title={resolved.state === 'ok' ? t(resolved.page.title) : t('settings.title')} parent={parent} largeTitle={resolved.state === 'ok'}>
      <PageContent resolved={resolved} />
    </Screen>
  );
}

/** Tablet and wide: the chosen page beside the list. It starts at its top and has its own heading. */
function DetailPane({ id, role }: { id: string; role: 'owner' | 'member' }) {
  const t = useT();
  const resolved = resolvePage(id, role);
  const scroller = useRef<HTMLDivElement>(null);
  const title = resolved.state === 'ok' ? t(resolved.page.title) : t('settings.title');
  const parentPage = resolved.state === 'ok' && resolved.page.parent ? findSettingsPage(resolved.page.parent) : null;
  // A page one level deeper has its own back control, naming its parent.
  const back = useBack(parentPage ? { to: settingsPath(parentPage.id), label: t(parentPage.title) } : null);
  useDocumentTitle(title);
  useScrollRestoration(scroller, `settings:${id}`);

  return (
    <div className="settings-pane">
      <div ref={scroller} className="u-scroll" style={{ flex: 1, minHeight: 0 }}>
        <div className="settings-pane__inner">
          <div className="settings-pane__head">
            {back && (
              <button type="button" className="ui-navbar__back" onClick={back.go} aria-label={back.accessibleLabel}>
                <ChevronLeft size={24} strokeWidth={2.2} aria-hidden="true" />
                <span>{back.label}</span>
              </button>
            )}
            <h1 className="settings-pane__title">{title}</h1>
          </div>
          <PageContent resolved={resolved} />
        </div>
      </div>
    </div>
  );
}

/**
 * Settings. On tablet and wide the list stays beside the chosen page; on a
 * phone it is one screen at a time, pushed from the side, and going back
 * restores where the list was scrolled to. Every page has its own address.
 */
export default function SettingsShell() {
  const t = useT();
  const layout = useLayoutClass();
  const navigationType = useNavigationType();
  const role = useSession((state) => state.user?.role ?? 'member');
  const pageId = (useParams()['*'] ?? '').split('/')[0] || null;
  const transition = useRouteTransition(pageId ?? ':root', navigationType, isSystemGesturePop);

  // The split view always shows a page: with none chosen, the first one.
  const defaultId = settingsPages(role).find((page) => !page.parent)?.id ?? null;
  const shownId = pageId ?? defaultId;
  const selected = shownId ? (findSettingsPage(shownId)?.parent ?? shownId) : null;

  // Pages a person is likely to open next download in the background once settings is on screen.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const page of settingsPages(role).slice(0, 4)) void componentFor(page).preload();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [role]);

  if (layout === 'phone') {
    return (
      <ScreenStack screenKey={pageId ?? ':root'} kind={transition}>
        {pageId ? (
          <PhonePage id={pageId} role={role} />
        ) : (
          <Screen title={t('settings.title')}>
            <RootList selectedId={null} split={false} />
          </Screen>
        )}
      </ScreenStack>
    );
  }

  return (
    <div className="settings-split">
      <div className="settings-split__list">
        <Screen title={t('settings.title')} scrollId="settings-list">
          <RootList selectedId={selected} split />
        </Screen>
      </div>
      <div className="settings-split__detail">
        <ScreenStack screenKey={shownId} kind={transition === 'none' ? 'none' : 'fade'}>
          {shownId ? <DetailPane id={shownId} role={role} /> : null}
        </ScreenStack>
      </div>
    </div>
  );
}

