import type { PluginSummary } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/i18n';
import { gitAddressProblem } from './InstallSheet';
import { changeText, isolationFacts, permissionWords, pluginChanges, pluginState, widens } from './words';

const en = getTranslator('en');
const zh = getTranslator('zh-CN');

function plugin(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'notes-counter',
    name: 'Notes counter',
    version: '1.0.0',
    description: '',
    author: 'Someone',
    license: 'MIT',
    homepage: null,
    source: { kind: 'directory', name: 'notes-counter' },
    hasServer: true,
    enabled: false,
    status: 'needs-approval',
    statusDetail: null,
    contentHash: 'hash-1',
    approval: { state: 'none', reasons: [], approvedAt: null, approvedBy: null, isolation: null },
    permissions: { requested: [], granted: [] },
    contributes: {
      tools: [{ name: 'count_notes', registeredName: 'plugin_notes_counter_count_notes', description: 'Counts.', declaredEffect: 'read', effect: 'read' }],
      panels: [{ id: 'notes', title: 'Notes', icon: 'notebook', entry: 'panel/index.html', slots: ['home-tile'] }],
      hooks: [],
      linkTiles: [],
    },
    retainedData: false,
    logTail: [],
    installedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('a plugin’s state in words', () => {
  it('names each status, and why it needs the owner', () => {
    expect(pluginState(plugin()).label).toBe('plugins.state.needsApproval');
    expect(pluginState(plugin()).detail).toBe('plugins.state.newDetail');
    expect(pluginState(plugin({ approval: { state: 'stale', reasons: ['permissions-changed'], approvedAt: 1, approvedBy: null, isolation: 'sandboxed' } })).detail).toBe('plugins.state.changedDetail');
    expect(pluginState(plugin({ status: 'running', enabled: true }))).toMatchObject({ label: 'plugins.state.running', tone: 'positive' });
    expect(pluginState(plugin({ status: 'stopped', enabled: false }))).toMatchObject({ label: 'plugins.state.off', tone: 'neutral' });
    expect(pluginState(plugin({ status: 'stopped', enabled: true })).detail).toBe('plugins.state.readyDetail');
    expect(pluginState(plugin({ status: 'stopped', enabled: true, hasServer: false })).detail).toBeNull();
    expect(pluginState(plugin({ status: 'crashed', enabled: true }))).toMatchObject({ label: 'plugins.state.crashed', tone: 'danger', detail: 'plugins.state.crashedDetail' });
    expect(pluginState(plugin({ status: 'crashed', enabled: false })).detail).toBe('plugins.state.crashedDisabled');
    expect(pluginState(plugin({ status: 'blocked-no-sandbox', enabled: true }))).toMatchObject({ label: 'plugins.state.blocked', tone: 'danger' });
  });
});

describe('permissions in plain words', () => {
  it('says what each permission lets a plugin do, with its risk', () => {
    expect(permissionWords('notifications', en)).toMatchObject({ risk: 'low', title: 'Send you notifications' });
    expect(permissionWords('projects:read', en)).toMatchObject({ risk: 'high', title: 'Read your projects’ files' });
    const host = permissionWords('network:api.example.com', en);
    expect(host).toMatchObject({ risk: 'medium', title: 'Send requests to api.example.com' });
    expect(host.text).toContain('exactly api.example.com');
    expect(host.text).toMatch(/leaves this machine/);
    const network = permissionWords('network', en);
    expect(network.risk).toBe('high');
    expect(network.text).toMatch(/local network/);
    expect(permissionWords('network:api.example.com', zh).title).toContain('api.example.com');
  });

  it('lists what the isolation in force keeps a plugin from, and what not', () => {
    const facts = isolationFacts({ level: 'restricted', bubblewrap: false, nodePermissions: true, restricts: { files: true, processes: true, network: false, otherProcesses: false }, unsandboxedAllowed: false, detail: '' });
    expect(facts.kept).toEqual(['plugins.isolation.files', 'plugins.isolation.processes']);
    expect(facts.notKept).toEqual(['plugins.isolation.network', 'plugins.isolation.otherProcesses']);
  });
});

describe('what an update changed', () => {
  it('lists new and dropped permissions, tools, pages, links and hooks', () => {
    const before = plugin({ permissions: { requested: ['notifications'], granted: ['notifications'] } });
    const after = plugin({
      version: '1.1.0',
      permissions: { requested: ['network:api.example.com'], granted: [] },
      contributes: {
        tools: [
          { name: 'count_notes', registeredName: 'plugin_notes_counter_count_notes', description: 'Counts, now differently.', declaredEffect: 'read', effect: 'read' },
          { name: 'add_note', registeredName: 'plugin_notes_counter_add_note', description: 'Adds.', declaredEffect: 'write', effect: 'write' },
        ],
        panels: [{ id: 'notes', title: 'Notes', icon: 'notebook', entry: 'panel/index.html', slots: ['home-tile', 'project-tab'] }],
        hooks: ['run.finished'],
        linkTiles: [{ id: 'docs', title: 'Docs', icon: 'link', url: 'https://docs.example.com/notes' }],
      },
    });
    const changes = pluginChanges(before, after);
    expect(changes).toEqual([
      { kind: 'version', from: '1.0.0', to: '1.1.0' },
      { kind: 'permission-added', permission: 'network:api.example.com' },
      { kind: 'permission-removed', permission: 'notifications' },
      { kind: 'tool-changed', name: 'count_notes' },
      { kind: 'tool-added', name: 'add_note' },
      { kind: 'panel-changed', title: 'Notes' },
      { kind: 'link-added', title: 'Docs', url: 'https://docs.example.com/notes' },
      { kind: 'hook-added', event: 'run.finished' },
    ]);
    expect(changes.filter(widens).map((change) => change.kind)).toEqual(['permission-added', 'tool-added', 'link-added', 'hook-added']);
    expect(changes.map((change) => changeText(change, en))).toContain('Newly asks: Send requests to api.example.com');
    expect(changes.map((change) => changeText(change, en))).toContain('New link: Docs → docs.example.com');
  });

  it('finds nothing when nothing that is approved changed', () => {
    expect(pluginChanges(plugin(), plugin({ contentHash: 'another' }))).toEqual([]);
  });
});

describe('a Git address before it is sent', () => {
  it('takes only https addresses without credentials or options', () => {
    expect(gitAddressProblem('https://github.com/owner/plugin')).toBeNull();
    expect(gitAddressProblem('')).toBe('empty');
    expect(gitAddressProblem('--upload-pack=evil')).toBe('option');
    expect(gitAddressProblem('git@github.com:owner/plugin.git')).toBe('scheme');
    expect(gitAddressProblem('http://github.com/owner/plugin')).toBe('scheme');
    expect(gitAddressProblem('ssh://github.com/owner/plugin')).toBe('scheme');
    expect(gitAddressProblem('https://user:token@github.com/owner/plugin')).toBe('credentials');
  });
});
