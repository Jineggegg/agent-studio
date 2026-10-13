import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  type Location,
  Navigate,
  type RouteObject,
  createBrowserRouter,
  matchPath,
  useLocation,
  useMatches,
  useNavigate,
  useNavigationType,
  useOutlet,
} from 'react-router';
import { loadSession } from '@/data/auth';
import { useIsOwner, useSession } from '@/data/session';
import { currentTranslator, useT } from '@/i18n';
import { type FeatureRoute, featureRoutes, sealFeatureRoutes } from '@/registry';
import { Button, ConfirmHost, ErrorState, ProgressLine, ToastViewport } from '@/ui';
import { APP_CONTENT_ID } from '@/ui/overlay';
import { RootError, ScreenBoundary } from './Boundary';
import { ConnectionCue } from './ConnectionCue';
import { lazyScreen, preloadWhenIdle } from './LazyScreen';
import { Screen } from './Screen';
import { ScreenScope, ScreenStack, type TransitionKind, useScreen } from './ScreenStack';
import { installBackGestures, isSystemGesturePop, useBack } from './back';
import { type Zone, resolveRedirect } from './guard';
import { recordNavigation } from './history';
import { announceFirstPaint } from './launch';

interface RouteHandle {
  zone?: Zone;
  /** The route's path pattern; identifies which app a location belongs to. */
  pattern?: string;
  home?: boolean;
}

/** What the app shows as its base layer and what it mounts around the screens. Supplied by main.tsx. */
export interface AppParts {
  /** The home screen: always mounted under the apps while signed in. */
  Home: () => ReactNode;
  Login: () => ReactNode;
  Setup: () => ReactNode;
  /** Mounted once, above everything: the step-up dialog and other app-wide hosts. */
  Hosts?: () => ReactNode;
  /** Extra routes that need no session (the development gallery). */
  openRoutes?: RouteObject[];
  /** Routes inside the signed-in shell that are part of the foundation (settings). */
  shellRoutes?: FeatureRoute[];
}

function StartupUnreachable() {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  useEffect(() => announceFirstPaint(), []);
  return (
    <div className="screen-status">
      <ErrorState
        kind="unreachable"
        title={t('shell.unreachable.title')}
        description={t('shell.unreachable.description')}
        retrying={retrying}
        onRetry={() => {
          // The status stays "unreachable" until the server answers, so this screen stays up meanwhile.
          setRetrying(true);
          void loadSession().finally(() => setRetrying(false));
        }}
      />
    </div>
  );
}

function NotFoundScreen() {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Screen title={t('shell.notFound.title')} largeTitle={false}>
      <ErrorState
        kind="gone"
        title={t('shell.notFound.title')}
        description={t('shell.notFound.description')}
        actions={
          <Button variant="tinted" onClick={() => void navigate('/', { replace: true })}>
            {t('shell.goHome')}
          </Button>
        }
      />
    </Screen>
  );
}

function OwnerOnly({ children }: { children: ReactNode }) {
  const t = useT();
  const navigate = useNavigate();
  const isOwner = useIsOwner();
  if (isOwner) return children;
  return (
    <Screen title={t('shell.ownerOnly.title')} largeTitle={false}>
      <ErrorState
        kind="forbidden"
        title={t('shell.ownerOnly.title')}
        description={t('shell.ownerOnly.description')}
        actions={
          <Button variant="tinted" onClick={() => void navigate('/', { replace: true })}>
            {t('shell.goHome')}
          </Button>
        }
      />
    </Screen>
  );
}

/** One screen's worth of isolation: its own error boundary, reset when the screen's address changes. */
function Isolated({ children }: { children: ReactNode }) {
  const screen = useScreen();
  return <ScreenBoundary resetKey={screen.location.pathname}>{children}</ScreenBoundary>;
}

/**
 * The same, for an app opened over the home screen. While the app's own screen
 * is not on show — its code is downloading, or failed to — "back" still leads home.
 */
function IsolatedApp({ children }: { children: ReactNode }) {
  const t = useT();
  useBack({ to: '/', label: t('nav.home') }, { fallback: true });
  return <Isolated>{children}</Isolated>;
}

function toRouteObject(route: FeatureRoute): RouteObject {
  const name = route.name;
  // The placeholder is drawn long after this table is built: look the name up then, in the language of the moment.
  const Component = lazyScreen(route.load, name ? { name: () => currentTranslator()(name) } : {});
  if (route.preloadWhenIdle) preloadWhenIdle(Component);
  const element = (
    <IsolatedApp>
      <Component />
    </IsolatedApp>
  );
  return {
    id: `app:${route.path}`,
    path: route.path,
    element: route.access === 'owner' ? <OwnerOnly>{element}</OwnerOnly> : element,
    handle: { zone: 'app', pattern: route.path } satisfies RouteHandle,
  };
}

function useHandle(): RouteHandle {
  const matches = useMatches();
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const handle = matches[index]!.handle as RouteHandle | undefined;
    if (handle?.zone) return handle;
  }
  return {};
}

/** The signed-in shell: the home screen stays alive underneath; apps open over it and close back into it. */
function SignedInShell({ Home }: { Home: () => ReactNode }) {
  const location = useLocation();
  const outlet = useOutlet();
  const navigationType = useNavigationType();
  const handle = useHandle();

  const isHome = handle.home === true;
  const appKey = isHome
    ? null
    : handle.pattern && handle.pattern !== '*'
      ? (matchPath({ path: `/${handle.pattern}`, end: !handle.pattern.endsWith('*') }, location.pathname)?.pathnameBase ?? location.pathname)
      : location.pathname;

  const previousKey = useRef<string | null>(appKey);
  const [homeLocation, setHomeLocation] = useState<Location>(location);
  if (isHome && homeLocation.key !== location.key) setHomeLocation(location);

  let kind: TransitionKind = 'none';
  if (previousKey.current !== appKey) {
    if (navigationType === 'POP' && isSystemGesturePop()) kind = 'none';
    else if (previousKey.current === null) kind = 'open';
    else if (appKey === null) kind = 'close';
    else kind = navigationType === 'PUSH' ? 'push' : navigationType === 'POP' ? 'pop' : 'fade';
  }
  useEffect(() => {
    previousKey.current = appKey;
  }, [appKey]);

  return (
    <div className="shell">
      <div className="shell__home" data-covered={!isHome || undefined} inert={!isHome} aria-hidden={!isHome || undefined}>
        <ScreenScope value={{ active: isHome, location: homeLocation, depth: 1 }}>
          <ScreenBoundary resetKey="home">
            <Home />
          </ScreenBoundary>
        </ScreenScope>
      </div>
      <ScreenStack screenKey={appKey} kind={kind} passThrough>
        {isHome ? null : outlet}
      </ScreenStack>
    </div>
  );
}

function AppRoot({ Hosts }: { Hosts?: (() => ReactNode) | undefined }) {
  const location = useLocation();
  const outlet = useOutlet();
  const handle = useHandle();
  const status = useSession((state) => state.status);
  const needsSetup = useSession((state) => state.needsSetup);
  const authenticated = useSession((state) => state.authenticated);

  const zone: Zone = handle.zone ?? 'app';
  let screenKey: string | null;
  let content: ReactNode = null;

  if (status === 'loading' && zone !== 'open') {
    // The launch screen is still up; nothing is drawn until the server has said who this is.
    screenKey = null;
  } else if (status === 'unreachable' && zone !== 'open') {
    screenKey = 'unreachable';
    content = <StartupUnreachable />;
  } else {
    const redirect = resolveRedirect({
      zone,
      needsSetup,
      authenticated,
      current: location.pathname + location.search + location.hash,
      intended: (location.state as { from?: unknown } | null)?.from as string | null,
    });
    screenKey = zone;
    const navigation = redirect ? <Navigate to={redirect.to} replace state={redirect.from ? { from: redirect.from } : null} /> : null;
    // Leaving sign-in after a successful sign-in: keep the form in the picture while the app fades in over it.
    content = redirect ? zone === 'app' ? navigation : (
      <>
        {outlet}
        {navigation}
      </>
    ) : outlet;
  }

  return (
    <div className="app">
      <ProgressLine />
      <div id={APP_CONTENT_ID} className="app__content">
        <ScreenStack screenKey={screenKey} kind="fade">
          {content}
        </ScreenStack>
      </div>
      <ConnectionCue />
      <div id="overlay-root" className="app__overlays" />
      <ToastViewport />
      <ConfirmHost />
      {Hosts && <Hosts />}
    </div>
  );
}

/** Builds the router from the foundation's own screens and everything the features registered. */
export function createAppRouter(parts: AppParts) {
  sealFeatureRoutes();
  const { Home, Login, Setup } = parts;

  const routes: RouteObject[] = [
    {
      id: 'root',
      path: '/',
      element: <AppRoot Hosts={parts.Hosts} />,
      errorElement: <RootError />,
      children: [
        { id: 'setup', path: 'setup', element: <Isolated><Setup /></Isolated>, handle: { zone: 'setup' } satisfies RouteHandle },
        { id: 'login', path: 'login', element: <Isolated><Login /></Isolated>, handle: { zone: 'login' } satisfies RouteHandle },
        ...(parts.openRoutes ?? []),
        {
          id: 'shell',
          element: <SignedInShell Home={Home} />,
          handle: { zone: 'app' } satisfies RouteHandle,
          children: [
            { id: 'home', index: true, handle: { zone: 'app', home: true } satisfies RouteHandle },
            ...[...(parts.shellRoutes ?? []), ...featureRoutes()].map(toRouteObject),
            { id: 'not-found', path: '*', element: <NotFoundScreen />, handle: { zone: 'app', pattern: '*' } satisfies RouteHandle },
          ],
        },
      ],
    },
  ];

  const router = createBrowserRouter(routes);
  recordNavigation('INITIAL', router.state.location);
  router.subscribe((state) => recordNavigation(state.historyAction, state.location));
  installBackGestures(() => router.state.location.key);
  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;
