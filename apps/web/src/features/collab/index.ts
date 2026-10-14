import { Activity } from 'lucide-react';
import { registerTitleBarItem } from '@/features/workbench/chat/slots';
import { registerFeatureRoutes, registerSystemTile } from '@/registry';
import { useRunningTileStatus } from './running/status';

/**
 * Working with more than one agent: handing a conversation to another agent
 * (from the conversation's "…" menu), chains of handed-over conversations,
 * multi-agent tasks, and everything of yours that is running. Registration
 * only; the screens download when first opened.
 *
 * The workbench draws a chain's place under a conversation's title bar and a
 * handoff's notices in its transcript with `handoff/ChainBar` and
 * `handoff/HandoffNotice`; a project's page lists its tasks with
 * `tasks/ProjectTasksSection`.
 */
registerFeatureRoutes(
  { path: 'running', name: 'collab.running.title', load: () => import('./running/RunningScreen') },
  { path: 'tasks', name: 'collab.tasks.title', load: () => import('./tasks/TasksScreen') },
  { path: 'tasks/:taskId', name: 'collab.task.title', load: () => import('./tasks/TaskScreen') },
);

registerSystemTile({ id: 'running', title: 'collab.running.title', icon: Activity, tint: 'green', to: '/running', order: 15, useStatus: useRunningTileStatus });

// The conversation's "…": continue with another agent, ask several agents, what is running. At the far end of the title bar.
registerTitleBarItem({ id: 'conversation-menu', order: 900, placement: 'end', load: () => import('./ConversationMenu') });
