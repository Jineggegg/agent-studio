import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import './styles/tokens.css';
import './styles/base.css';
import './ui/styles/index.css';
import './shell/shell.css';
// Features register their routes, settings pages and tiles as a side effect of being imported.
import './features';
import { initializeData, loadSession } from './data/auth';
import { queryClient } from './data/query';
import LoginScreen from './features/auth/LoginScreen';
import { ReauthDialog } from './features/auth/ReauthDialog';
import SetupScreen from './features/auth/SetupScreen';
import HomeScreen from './features/home/HomeScreen';
import { startLayoutTracking } from './platform/layout';
import { startViewportTracking } from './platform/viewport';
import { registerServiceWorker } from './pwa/register';
import { startUpdateChecks } from './pwa/update';
import { createAppRouter } from './shell/App';
import { startAppearanceSync } from './shell/appearance';
import { failLaunch } from './shell/launch';
import type { RouteObject } from 'react-router';
import { lazyScreen } from './shell/LazyScreen';

/**
 * Start-up, in the order things must exist: layout and viewport tracking
 * (so the first frame has the right class and height), the data layer's
 * wiring, the router with everything the features registered, then the first
 * question to the server — who is this? Until that is answered the launch
 * screen stays up.
 */
function start(): void {
  const container = document.getElementById('root');
  if (!container) throw new Error('The page has no #root element.');

  startLayoutTracking();
  startViewportTracking();
  initializeData();
  startAppearanceSync();

  const openRoutes: RouteObject[] = [];
  if (import.meta.env.DEV) {
    // The component gallery exists only in development builds; the import below is dropped from production bundles.
    const Gallery = lazyScreen(() => import('./features/dev/ComponentGallery'));
    openRoutes.push({ id: 'dev-components', path: 'dev/components', element: <Gallery />, handle: { zone: 'open' } });
  }

  const router = createAppRouter({
    Home: HomeScreen,
    Login: LoginScreen,
    Setup: SetupScreen,
    Hosts: ReauthDialog,
    openRoutes,
    shellRoutes: [{ path: 'settings/*', name: 'settings.title', load: () => import('./features/settings/SettingsShell') }],
  });

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );

  void loadSession();
  registerServiceWorker((path) => void router.navigate(path));
  startUpdateChecks();
}

try {
  start();
} catch (error) {
  // Nothing is on screen yet except the launch screen: hand over to the launch error screen.
  failLaunch('crash');
  throw error;
}
