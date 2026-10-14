import { TERMINAL_LAUNCHERS, type TerminalLauncherInfo } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/**
 * Which of the server's sign-in launchers belong to which agent. A launcher
 * is only ever named by its key: what it runs is decided on the server.
 */
const FAMILY: Record<string, string> = { 'claude-code': 'claude', codex: 'codex' };

/** The sign-in launchers for an agent, in the order they should be offered. */
export function signInLaunchers(agentId: string, launchers: readonly TerminalLauncherInfo[]): TerminalLauncherInfo[] {
  const family = FAMILY[agentId] ?? agentId.split('-')[0]!;
  return launchers.filter((launcher) => launcher.kind === 'agent-sign-in' && (launcher.key === `${family}-login` || launcher.key.startsWith(`${family}-login-`)));
}

/** A translated name for the launchers this client knows; the server's own (English) title for any other. */
const TITLES: Record<string, MessageKey> = {
  [TERMINAL_LAUNCHERS.claudeLogin]: 'accounts.launcher.claudeLogin',
  [TERMINAL_LAUNCHERS.codexLogin]: 'accounts.launcher.codexLogin',
  [TERMINAL_LAUNCHERS.codexLoginDevice]: 'accounts.launcher.codexLoginDevice',
};

export const launcherTitleKey = (key: string): MessageKey | null => TITLES[key] ?? null;
