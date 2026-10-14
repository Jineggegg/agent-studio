import { FolderTree } from 'lucide-react';
import { registerInspectorPanel } from '@/features/workbench/inspector/registry';

/**
 * Files: a project's tree, search, and the editor a file opens in — as a
 * panel of the workbench's inspector. Registration only; the panel (and the
 * editor it brings) is downloaded when it is first shown.
 *
 * It stays mounted once opened, so text being edited is still there after a
 * look at the terminal or with the tools closed.
 */
registerInspectorPanel({
  id: 'files',
  title: 'files.title',
  icon: FolderTree,
  order: 10,
  handles: ['open-file', 'reveal-folder'],
  keepAlive: true,
  load: () => import('./FilesPanel'),
});
