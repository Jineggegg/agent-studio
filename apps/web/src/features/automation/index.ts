import { registerTitleBarItem } from '@/features/workbench/chat/slots';
import { registerFeatureRoutes } from '@/registry';

/**
 * Automation: a project's automations — reminders and unattended agent runs
 * on a schedule or a project event — at `/projects/<id>/automations` (where
 * notifications about them lead), reached from a conversation's title bar
 * when the project has them switched on. "Send later" in the message field
 * and the list of scheduled messages above it come from this feature too
 * (`SendLater`, `DeferredList`). Registration only.
 */
registerFeatureRoutes({ path: 'projects/:projectId/automations', name: 'automation.title', load: () => import('./AutomationsScreen') });

registerTitleBarItem({ id: 'automations', order: 30, load: () => import('./TitleBarButton'), available: ({ project }) => project.features.automation });
