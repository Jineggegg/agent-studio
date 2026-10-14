import { GitBranch } from 'lucide-react';
import { registerInspectorPanel } from '@/features/workbench/inspector/registry';
import { useGitBadge } from './badge';

/**
 * Git: a project's uncommitted changes, commits, branches and its remote — as
 * a panel of the workbench's inspector. Registration only; the panel is
 * downloaded when it is first shown.
 */
registerInspectorPanel({
  id: 'git',
  title: 'git.title',
  icon: GitBranch,
  order: 30,
  handles: ['show-changes'],
  useBadge: useGitBadge,
  load: () => import('./GitPanel'),
});
