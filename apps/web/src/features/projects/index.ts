import { registerFeatureRoutes } from '@/registry';

/**
 * A project's own page — its name and icon, websites, the agents it offers
 * and what they may do, sharing, archiving and removal — and making a project
 * by cloning a repository. Registration only.
 *
 * The page lives at `/projects/<id>/settings`; the workbench's project
 * switcher and title, and the home screen's project sheet, lead to it.
 */
registerFeatureRoutes({ path: 'projects/:projectId/settings', name: 'projects.page.title', load: () => import('./ProjectScreen') });
