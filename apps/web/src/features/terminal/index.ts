import { KeyRound, SquareTerminal } from 'lucide-react';
import { registerInspectorPanel } from '@/features/workbench/inspector/registry';
import { registerSettingsPage } from '@/registry';
import { terminalUsable } from './usable';

/**
 * The terminal: shells on the server in a project's folder, as a panel of the
 * workbench's inspector — and the settings page where each agent's own
 * sign-in runs in one. Registration only; xterm.js is downloaded when a
 * terminal is first shown.
 *
 * The panel stays mounted once opened: a shell keeps its screen and its
 * connection while another tool is on show or the tools are closed.
 */
registerInspectorPanel({
  id: 'terminal',
  title: 'terminal.title',
  icon: SquareTerminal,
  order: 20,
  // Only the owner has a terminal to type into, and only where the server can start one; elsewhere the conversation offers no "Run" at all.
  handles: (context) => (context.role === 'owner' && terminalUsable() ? ['run-command'] : []),
  keepAlive: true,
  load: () => import('./TerminalPanel'),
});

registerSettingsPage({
  id: 'agent-accounts',
  title: 'accounts.title',
  icon: KeyRound,
  tint: 'teal',
  group: 'assistants',
  order: 10,
  load: () => import('./AgentAccountsPage'),
});
