import type { ComponentType } from 'react';
import { matchPath } from 'react-router';
import type { MessageKey } from '@/i18n';

/**
 * Where features plug their screens into the app.
 *
 *   // src/features/index.ts
 *   registerFeatureRoutes({ path: 'inbox', name: 'inbox.title', load: () => import('./inbox/InboxScreen') });
 *
 * A route exists only when a feature has registered it: there are no
 * placeholder screens. Until `projects/:projectId/*` is registered, for
 * example, the home screen opens a project's details sheet instead of
 * navigating to a page that is not there.
 */
export interface FeatureRoute {
  /**
   * Path under the app root, no leading slash. End it with `/*` when the
   * feature has screens of its own beneath it (it then renders its own
   * `<Routes>` or reads the rest of the path):
   * `'workbench/*'`, `'projects/:projectId/*'`, `'inbox'`.
   */
  path: string;
  /** `() => import('./SomeScreen')` — the module's default export is the screen. Loaded on first use. */
  load: () => Promise<{ default: ComponentType }>;
  /** What the surface is called, for the "Loading …" placeholder. */
  name?: MessageKey;
  /** Who may open it. Default `user` (anyone signed in). */
  access?: 'user' | 'owner';
  /** Download in the background once the app is idle, so it opens instantly. For the heaviest surfaces. */
  preloadWhenIdle?: boolean;
}

const routes: FeatureRoute[] = [];
let sealed = false;

/** Add screens to the app. Call at module load, from `src/features/index.ts`. */
export function registerFeatureRoutes(...added: FeatureRoute[]): void {
  if (sealed) throw new Error('Feature routes must be registered before the app starts (in src/features/index.ts).');
  for (const route of added) {
    if (route.path.startsWith('/')) throw new Error(`Feature route paths have no leading slash: "${route.path}".`);
    if (routes.some((existing) => existing.path === route.path)) throw new Error(`The route "${route.path}" is registered twice.`);
    routes.push(route);
  }
}

export function featureRoutes(): readonly FeatureRoute[] {
  return routes;
}

/** Called when the router is built; later registrations would be silently ignored, so they throw instead. */
export function sealFeatureRoutes(): void {
  sealed = true;
}

/** The registered route that would show `pathname`, if any. */
export function featureRouteFor(pathname: string): FeatureRoute | null {
  return routes.find((route) => matchPath({ path: `/${route.path}`, end: !route.path.endsWith('*') }, pathname) !== null) ?? null;
}

/** The address of a project's page — or null while no feature provides one. */
export function projectPath(projectId: string): string | null {
  const path = `/projects/${projectId}`;
  return featureRouteFor(path) ? path : null;
}

/** The address of a project's own page — its settings, links and sharing — or null while no feature provides one. */
export function projectSettingsPath(projectId: string): string | null {
  return routes.some((route) => route.path === 'projects/:projectId/settings') ? `/projects/${projectId}/settings` : null;
}

/** For tests. */
export function __resetFeatureRoutesForTests(): void {
  routes.length = 0;
  sealed = false;
}
