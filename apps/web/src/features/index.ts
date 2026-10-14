/**
 * Every feature registers itself here: one import per feature, and the
 * feature's own `index.ts` adds its routes, settings pages and home tiles.
 *
 *   import './inbox';        // registerFeatureRoutes({ path: 'inbox', … }); registerSystemTile({ … });
 *
 * This module is imported once, by main.tsx, before the router is built.
 * Keep each feature's `index.ts` light — registrations and `() => import()`
 * loaders only — so that its code is downloaded when it is first opened.
 */
import './auth';
import './settings';
import './workbench';
