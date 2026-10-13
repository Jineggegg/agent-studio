import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig: plugin settings', () => {
  it('installs from no directory and never runs plugins unsandboxed unless told to', () => {
    const config = loadConfig({});
    expect(config.pluginSourceDir).toBeNull();
    expect(config.pluginsUnsandboxed).toBe(false);
  });

  it('reads the source directory as an absolute path', () => {
    expect(loadConfig({ AGENT_STUDIO_PLUGIN_SOURCE_DIR: '~/studio-plugins' }).pluginSourceDir).toBe(
      path.join(os.homedir(), 'studio-plugins'),
    );
    expect(loadConfig({ AGENT_STUDIO_PLUGIN_SOURCE_DIR: '/srv/plugins/../plugins' }).pluginSourceDir).toBe('/srv/plugins');
    expect(loadConfig({ AGENT_STUDIO_PLUGIN_SOURCE_DIR: '' }).pluginSourceDir).toBeNull();
  });

  it('takes the unsandboxed switch only as an explicit on or off', () => {
    expect(loadConfig({ AGENT_STUDIO_PLUGINS_UNSANDBOXED: 'on' }).pluginsUnsandboxed).toBe(true);
    expect(loadConfig({ AGENT_STUDIO_PLUGINS_UNSANDBOXED: 'off' }).pluginsUnsandboxed).toBe(false);
    expect(() => loadConfig({ AGENT_STUDIO_PLUGINS_UNSANDBOXED: 'maybe' })).toThrow(ConfigError);
  });

  it('ignores names without the prefix', () => {
    const config = loadConfig({ PLUGIN_SOURCE_DIR: '/srv/other', PLUGINS_UNSANDBOXED: 'on' });
    expect(config.pluginSourceDir).toBeNull();
    expect(config.pluginsUnsandboxed).toBe(false);
  });
});
