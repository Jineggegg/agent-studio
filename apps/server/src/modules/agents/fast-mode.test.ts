import type { AgentCapabilities } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { modelOption } from '../codex/status.js';
import { requireFastMode } from './fast-mode.js';
const capabilities: AgentCapabilities = {
  models: [
    { id: 'speed', label: 'Speed', fastMode: true },
    { id: 'standard', label: 'Standard', fastMode: false },
  ],
  defaultModel: 'speed',
  permissionModes: ['ask'],
  images: false,
  steering: false,
  resume: true,
  planMode: true,
  usage: true,
  fastMode: { supported: true, reason: null },
};
describe('truthful provider fast-mode detection', () => {
  it('requires explicit Codex catalogue support for the selected model', () => {
    expect(() => requireFastMode('codex', 'speed', capabilities)).not.toThrow();
    for (const model of ['standard', 'unknown', null])
      expect(() => requireFastMode('codex', model, capabilities)).toThrow();
    expect(modelOption({ id: 'old', model: 'old' }).fastMode).toBeUndefined();
    expect(modelOption({ id: 'no-fast', model: 'no-fast', serviceTiers: [] }).fastMode).toBe(false);
    expect(
      modelOption({
        id: 'speed',
        model: 'speed',
        serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Speed tier' }],
      }).fastMode,
    ).toBe(true);
  });
  it('restricts Claude to the documented Opus models and a supported CLI', () => {
    for (const model of ['opus', 'opus[1m]', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5'])
      expect(() => requireFastMode('claude-code', model, capabilities)).not.toThrow();
    for (const model of ['default', 'sonnet', 'claude-opus-4-7', 'claude-opus-5-9', null])
      expect(() => requireFastMode('claude-code', model, capabilities)).toThrow();
    expect(() =>
      requireFastMode('claude-code', 'opus', {
        ...capabilities,
        fastMode: { supported: false, reason: 'Older CLI' },
      }),
    ).toThrow();
  });
});
