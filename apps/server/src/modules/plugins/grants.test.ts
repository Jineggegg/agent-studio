import { describe, expect, it } from 'vitest';
import { PanelGrantStore } from './grants.js';

const binding = (extra: Record<string, unknown> = {}) => ({
  pluginId: 'demo',
  panelId: 'main',
  slot: 'home-tile' as const,
  userId: 'u1',
  credentialId: 'session-1',
  projectId: null,
  assetRoot: '/data/plugins/demo/panel',
  entryFile: 'index.html',
  ...extra,
});

function store(options: { maxPerUser?: number; maxTotal?: number } = {}) {
  const clock = { now: 1_000_000 };
  const grants = new PanelGrantStore({ ttlMs: 60_000, maxPerUser: options.maxPerUser ?? 3, maxTotal: options.maxTotal ?? 100, now: () => clock.now });
  return { grants, clock };
}

describe('panel grants', () => {
  it('mints an unguessable token bound to plugin, panel, user and project', () => {
    const { grants } = store();
    const first = grants.mint(binding({ projectId: 'p1' }));
    const second = grants.mint(binding({ projectId: 'p1' }));
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(grants.resolve(first.token)).toMatchObject({ pluginId: 'demo', panelId: 'main', userId: 'u1', credentialId: 'session-1', projectId: 'p1', expiresAt: 1_060_000 });
  });

  it('resolves nothing for a wrong, altered, truncated or malformed token', () => {
    const { grants } = store();
    const { token } = grants.mint(binding());
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    for (const wrong of [flipped, token.slice(0, -1), token + 'A', token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(), '', 'x', '../' + token, `${token}/`, ` ${token}`, 'A'.repeat(43), null, undefined, 42, { token }, [token]]) {
      expect(grants.resolve(wrong), String(wrong)).toBeNull();
    }
    expect(grants.resolve(token)).not.toBeNull();
  });

  it('expires', () => {
    const { grants, clock } = store();
    const { token } = grants.mint(binding());
    clock.now += 59_999;
    expect(grants.resolve(token)).not.toBeNull();
    clock.now += 1;
    expect(grants.resolve(token)).toBeNull();
    expect(grants.size).toBe(0);
    clock.now -= 10;
    // Expiry is final: turning the clock back does not bring a grant back.
    expect(grants.resolve(token)).toBeNull();
  });

  it('is revoked with the session, the user, the plugin or the project it was bound to', () => {
    const { grants } = store({ maxPerUser: 10 });
    const bySession = grants.mint(binding({ credentialId: 'session-2' })).token;
    const byUser = grants.mint(binding({ userId: 'u2' })).token;
    const byPlugin = grants.mint(binding({ pluginId: 'other' })).token;
    const byProject = grants.mint(binding({ projectId: 'p9' })).token;
    const kept = grants.mint(binding()).token;

    expect(grants.revoke((grant) => grant.credentialId === 'session-2')).toBe(1);
    expect(grants.revoke((grant) => grant.userId === 'u2')).toBe(1);
    expect(grants.revoke((grant) => grant.pluginId === 'other')).toBe(1);
    expect(grants.revoke((grant) => grant.projectId === 'p9')).toBe(1);
    for (const token of [bySession, byUser, byPlugin, byProject]) expect(grants.resolve(token)).toBeNull();
    expect(grants.resolve(kept)).not.toBeNull();
  });

  it('keeps only the newest grants of a user, and bounds the total', () => {
    const { grants } = store({ maxPerUser: 3, maxTotal: 5 });
    const tokens = Array.from({ length: 5 }, () => grants.mint(binding()).token);
    expect(tokens.map((token) => grants.resolve(token) !== null)).toEqual([false, false, true, true, true]);

    const others = Array.from({ length: 4 }, (_, index) => grants.mint(binding({ userId: `other-${index}` })).token);
    expect(grants.size).toBeLessThanOrEqual(5);
    expect(grants.resolve(others.at(-1)!)).not.toBeNull();
  });

  it('sweeps expired grants when a new one is minted', () => {
    const { grants, clock } = store({ maxPerUser: 50 });
    for (let i = 0; i < 10; i += 1) grants.mint(binding({ userId: `u${i}` }));
    clock.now += 61_000;
    grants.mint(binding());
    expect(grants.size).toBe(1);
  });
});
