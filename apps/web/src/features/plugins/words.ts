import {
  type PluginApprovalReason,
  type PluginIsolation,
  type PluginPanelSlot,
  type PluginPermission,
  type PluginSummary,
  describePluginPermission,
} from '@agent-studio/protocol';
import type { MessageKey, Translator } from '@/i18n';

/**
 * What the plugins screen says, worked out from the server's summaries: a
 * plugin's state in words, each permission in plain words with its risk, and
 * what an update changed. Pure, so the wording rules are tested without a screen.
 */

export type Tone = 'neutral' | 'positive' | 'warning' | 'danger';

export interface PluginState {
  label: MessageKey;
  tone: Tone;
  /** A sentence under it, when the state needs one. */
  detail: MessageKey | null;
}

/** The plugin's status as the owner should read it. */
export function pluginState(plugin: Pick<PluginSummary, 'status' | 'enabled' | 'hasServer' | 'approval'>): PluginState {
  switch (plugin.status) {
    case 'running':
      return { label: 'plugins.state.running', tone: 'positive', detail: null };
    case 'crashed':
      return { label: 'plugins.state.crashed', tone: 'danger', detail: plugin.enabled ? 'plugins.state.crashedDetail' : 'plugins.state.crashedDisabled' };
    case 'needs-approval':
      return { label: 'plugins.state.needsApproval', tone: 'warning', detail: plugin.approval.state === 'stale' ? 'plugins.state.changedDetail' : 'plugins.state.newDetail' };
    case 'blocked-no-sandbox':
      return { label: 'plugins.state.blocked', tone: 'danger', detail: 'plugins.state.blockedDetail' };
    case 'stopped':
      if (!plugin.enabled) return { label: 'plugins.state.off', tone: 'neutral', detail: null };
      return { label: 'plugins.state.ready', tone: 'positive', detail: plugin.hasServer ? 'plugins.state.readyDetail' : null };
  }
}

export interface PermissionWords {
  permission: PluginPermission;
  title: string;
  text: string;
  risk: 'low' | 'medium' | 'high';
}

/** One permission in plain words, with how much it matters. */
export function permissionWords(permission: PluginPermission, t: Translator): PermissionWords {
  const info = describePluginPermission(permission);
  switch (info.kind) {
    case 'notifications':
      return { permission, risk: info.risk, title: t('plugins.permission.notifications'), text: t('plugins.permission.notificationsText') };
    case 'projects:read':
      return { permission, risk: info.risk, title: t('plugins.permission.projects'), text: t('plugins.permission.projectsText') };
    case 'network-host':
      return { permission, risk: info.risk, title: t('plugins.permission.host', { host: info.host ?? '' }), text: t('plugins.permission.hostText', { host: info.host ?? '' }) };
    case 'network-raw':
      return { permission, risk: info.risk, title: t('plugins.permission.network'), text: t('plugins.permission.networkText') };
  }
}

export const RISK_LABELS: Record<PermissionWords['risk'], MessageKey> = {
  low: 'plugins.risk.low',
  medium: 'plugins.risk.medium',
  high: 'plugins.risk.high',
};

export const SLOT_LABELS: Record<PluginPanelSlot, MessageKey> = {
  'home-tile': 'plugins.slot.home',
  'project-tab': 'plugins.slot.project',
  'settings-page': 'plugins.slot.settings',
};

export const REASON_LABELS: Record<PluginApprovalReason, MessageKey> = {
  'permissions-changed': 'plugins.reason.permissions',
  'contributions-changed': 'plugins.reason.contributions',
  'content-changed': 'plugins.reason.content',
};

/** What the isolation in force keeps a plugin from, as short phrases (kept from / not kept from). */
export function isolationFacts(isolation: PluginIsolation): { kept: MessageKey[]; notKept: MessageKey[] } {
  const kept: MessageKey[] = [];
  const notKept: MessageKey[] = [];
  (isolation.restricts.files ? kept : notKept).push('plugins.isolation.files');
  (isolation.restricts.processes ? kept : notKept).push('plugins.isolation.processes');
  (isolation.restricts.network ? kept : notKept).push('plugins.isolation.network');
  (isolation.restricts.otherProcesses ? kept : notKept).push('plugins.isolation.otherProcesses');
  return { kept, notKept };
}

export const ISOLATION_LABELS: Record<PluginIsolation['level'], MessageKey> = {
  sandboxed: 'plugins.isolation.sandboxed',
  restricted: 'plugins.isolation.restricted',
  none: 'plugins.isolation.none',
};

// ---- what changed --------------------------------------------------------------------------

export type PluginChange =
  | { kind: 'version'; from: string; to: string }
  | { kind: 'permission-added' | 'permission-removed'; permission: PluginPermission }
  | { kind: 'tool-added' | 'tool-removed'; name: string }
  | { kind: 'tool-changed'; name: string }
  | { kind: 'panel-added' | 'panel-removed'; title: string }
  | { kind: 'panel-changed'; title: string }
  | { kind: 'link-added' | 'link-removed'; title: string; url: string }
  | { kind: 'link-changed'; title: string; url: string }
  | { kind: 'hook-added' | 'hook-removed'; event: string }
  | { kind: 'server-added' | 'server-removed' };

type Comparable = Pick<PluginSummary, 'version' | 'hasServer' | 'permissions' | 'contributes'>;

/**
 * What differs between the plugin as it was and as it is now: what an update
 * brought. Only what the owner approves is compared — permissions, tools and
 * what they say they do, panels and where they appear, link tiles and where
 * they lead, hooks, and whether there is server code.
 */
export function pluginChanges(before: Comparable, after: Comparable): PluginChange[] {
  const changes: PluginChange[] = [];
  if (before.version !== after.version) changes.push({ kind: 'version', from: before.version, to: after.version });
  if (!before.hasServer && after.hasServer) changes.push({ kind: 'server-added' });
  if (before.hasServer && !after.hasServer) changes.push({ kind: 'server-removed' });

  const permissionsBefore = new Set(before.permissions.requested);
  const permissionsAfter = new Set(after.permissions.requested);
  for (const permission of after.permissions.requested) if (!permissionsBefore.has(permission)) changes.push({ kind: 'permission-added', permission });
  for (const permission of before.permissions.requested) if (!permissionsAfter.has(permission)) changes.push({ kind: 'permission-removed', permission });

  const toolsBefore = new Map(before.contributes.tools.map((tool) => [tool.name, tool]));
  const toolsAfter = new Map(after.contributes.tools.map((tool) => [tool.name, tool]));
  for (const [name, tool] of toolsAfter) {
    const old = toolsBefore.get(name);
    if (!old) changes.push({ kind: 'tool-added', name });
    else if (old.description !== tool.description || old.declaredEffect !== tool.declaredEffect) changes.push({ kind: 'tool-changed', name });
  }
  for (const name of toolsBefore.keys()) if (!toolsAfter.has(name)) changes.push({ kind: 'tool-removed', name });

  const panelsBefore = new Map(before.contributes.panels.map((panel) => [panel.id, panel]));
  const panelsAfter = new Map(after.contributes.panels.map((panel) => [panel.id, panel]));
  for (const [id, panel] of panelsAfter) {
    const old = panelsBefore.get(id);
    if (!old) changes.push({ kind: 'panel-added', title: panel.title });
    else if (old.title !== panel.title || [...old.slots].sort().join() !== [...panel.slots].sort().join() || old.entry !== panel.entry) changes.push({ kind: 'panel-changed', title: panel.title });
  }
  for (const [id, panel] of panelsBefore) if (!panelsAfter.has(id)) changes.push({ kind: 'panel-removed', title: panel.title });

  const linksBefore = new Map(before.contributes.linkTiles.map((link) => [link.id, link]));
  const linksAfter = new Map(after.contributes.linkTiles.map((link) => [link.id, link]));
  for (const [id, link] of linksAfter) {
    const old = linksBefore.get(id);
    if (!old) changes.push({ kind: 'link-added', title: link.title, url: link.url });
    else if (old.url !== link.url || old.title !== link.title) changes.push({ kind: 'link-changed', title: link.title, url: link.url });
  }
  for (const [id, link] of linksBefore) if (!linksAfter.has(id)) changes.push({ kind: 'link-removed', title: link.title, url: link.url });

  const hooksBefore = new Set(before.contributes.hooks);
  const hooksAfter = new Set(after.contributes.hooks);
  for (const event of after.contributes.hooks) if (!hooksBefore.has(event)) changes.push({ kind: 'hook-added', event });
  for (const event of before.contributes.hooks) if (!hooksAfter.has(event)) changes.push({ kind: 'hook-removed', event });
  return changes;
}

/** A change in one line. */
export function changeText(change: PluginChange, t: Translator): string {
  switch (change.kind) {
    case 'version':
      return t('plugins.change.version', { from: change.from, to: change.to });
    case 'server-added':
      return t('plugins.change.serverAdded');
    case 'server-removed':
      return t('plugins.change.serverRemoved');
    case 'permission-added':
      return t('plugins.change.permissionAdded', { permission: permissionWords(change.permission, t).title });
    case 'permission-removed':
      return t('plugins.change.permissionRemoved', { permission: permissionWords(change.permission, t).title });
    case 'tool-added':
      return t('plugins.change.toolAdded', { name: change.name });
    case 'tool-removed':
      return t('plugins.change.toolRemoved', { name: change.name });
    case 'tool-changed':
      return t('plugins.change.toolChanged', { name: change.name });
    case 'panel-added':
      return t('plugins.change.panelAdded', { title: change.title });
    case 'panel-removed':
      return t('plugins.change.panelRemoved', { title: change.title });
    case 'panel-changed':
      return t('plugins.change.panelChanged', { title: change.title });
    case 'link-added':
      return t('plugins.change.linkAdded', { title: change.title, host: hostOf(change.url) });
    case 'link-removed':
      return t('plugins.change.linkRemoved', { title: change.title });
    case 'link-changed':
      return t('plugins.change.linkChanged', { title: change.title, host: hostOf(change.url) });
    case 'hook-added':
      return t('plugins.change.hookAdded', { event: change.event });
    case 'hook-removed':
      return t('plugins.change.hookRemoved', { event: change.event });
  }
}

/** The host of an address, for showing where a link leads. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Whether a change asks for more than before (a reason to look twice). */
export const widens = (change: PluginChange): boolean =>
  change.kind === 'permission-added' || change.kind === 'server-added' || change.kind === 'tool-added' || change.kind === 'link-added' || change.kind === 'link-changed' || change.kind === 'hook-added';
