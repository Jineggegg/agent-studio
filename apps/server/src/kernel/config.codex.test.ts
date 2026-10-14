import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig: running Codex without a sandbox', () => {
  it('is off unless the operator says so', () => {
    expect(loadConfig({}).codexWithoutSandbox).toBe(false);
    expect(loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: '' }).codexWithoutSandbox).toBe(false);
  });

  it('takes only an explicit on or off', () => {
    expect(loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: 'on' }).codexWithoutSandbox).toBe(true);
    expect(loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: 'true' }).codexWithoutSandbox).toBe(true);
    expect(loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: 'off' }).codexWithoutSandbox).toBe(false);
    expect(() => loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: 'maybe' })).toThrow(ConfigError);
    expect(() => loadConfig({ AGENT_STUDIO_CODEX_WITHOUT_SANDBOX: 'maybe' })).toThrow(/AGENT_STUDIO_CODEX_WITHOUT_SANDBOX must be on or off/);
  });

  it('ignores the name without the prefix, and does not follow the sandbox setting', () => {
    expect(loadConfig({ CODEX_WITHOUT_SANDBOX: 'on' }).codexWithoutSandbox).toBe(false);
    // Turning the sandbox off does not by itself allow Codex to run without one.
    expect(loadConfig({ AGENT_STUDIO_SANDBOX: 'off' }).codexWithoutSandbox).toBe(false);
  });

  it('can be set by a caller that builds the configuration itself', () => {
    expect(loadConfig({}, { codexWithoutSandbox: true }).codexWithoutSandbox).toBe(true);
  });
});
