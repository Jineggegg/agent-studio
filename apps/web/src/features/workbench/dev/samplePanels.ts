import { FlaskConical, Ruler } from 'lucide-react';
import { registerInspectorPanel } from '../inspector/registry';

/**
 * Two stand-in panels, registered in development builds only (see the
 * feature's index.ts), so the inspector's container — docked, floating, full
 * screen; tabs, badges, keep-alive, requests — can be looked at before the
 * real project tools exist. A production build never contains this file.
 */
registerInspectorPanel(
  {
    id: 'sample',
    title: 'workbench.inspector.sample',
    icon: FlaskConical,
    order: 900,
    handles: ['open-file', 'run-command'],
    keepAlive: true,
    load: () => import('./SamplePanel'),
    useBadge: () => ({ count: 2, label: '2' }),
  },
  { id: 'sample-ruler', title: 'workbench.inspector.sampleRuler', icon: Ruler, order: 910, load: () => import('./SamplePanel') },
);
