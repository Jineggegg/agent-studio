import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, startTestStudio, type RunningStudio } from './support/studio.js';

/**
 * Roles (SEC-027/028, threat 7.1.8). This product has two roles — owner and
 * member — rather than the predecessor's single account. A member must not
 * reach any owner-only route, must not see or change other accounts, and an API
 * token must not perform account management.
 *
 * OWNER_ONLY is maintained by hand: it should list every route registered with
 * `access: 'owner'`. If a new owner route is added and not added here, the
 * enumeration test below still guards the ones listed; keep it in step with the
 * route registrations.
 */
const ID = '00000000000000000000000000';
const OWNER_ONLY: Array<{ method: string; url: string }> = [
  { method: 'GET', url: '/api/users' },
  { method: 'POST', url: '/api/users' },
  { method: 'PATCH', url: `/api/users/${ID}` },
  { method: 'DELETE', url: `/api/users/${ID}` },
  { method: 'PUT', url: `/api/agents/projects/${ID}/settings` },
  { method: 'GET', url: '/api/projects/browse' },
  { method: 'POST', url: '/api/projects/scratch' },
  { method: 'POST', url: '/api/projects' },
  { method: 'DELETE', url: `/api/projects/${ID}` },
  { method: 'GET', url: `/api/projects/${ID}/members` },
  { method: 'PUT', url: `/api/projects/${ID}/members/${ID}` },
  { method: 'DELETE', url: `/api/projects/${ID}/members/${ID}` },
  { method: 'POST', url: '/api/projects/clone' },
  { method: 'GET', url: `/api/projects/clone/${ID}` },
  { method: 'DELETE', url: `/api/projects/clone/${ID}` },
  { method: 'GET', url: '/api/plugins' },
  { method: 'GET', url: '/api/plugins/sources' },
  { method: 'POST', url: '/api/plugins/install' },
  { method: 'GET', url: `/api/plugins/${ID}` },
  { method: 'POST', url: `/api/plugins/${ID}/enable` },
  { method: 'POST', url: `/api/plugins/${ID}/disable` },
  { method: 'POST', url: `/api/plugins/${ID}/update` },
  { method: 'POST', url: `/api/plugins/${ID}/uninstall` },
  { method: 'PUT', url: '/api/memory/settings' },
  { method: 'POST', url: '/api/memory/reindex' },
  { method: 'GET', url: '/api/remotes/hosts' },
  { method: 'GET', url: `/api/remotes/hosts/${ID}/status` },
  { method: 'GET', url: '/api/terminal/sessions' },
  { method: 'POST', url: '/api/terminal/sessions' },
  { method: 'GET', url: `/api/terminal/sessions/${ID}` },
  { method: 'PATCH', url: `/api/terminal/sessions/${ID}` },
  { method: 'DELETE', url: `/api/terminal/sessions/${ID}` },
  { method: 'POST', url: `/api/terminal/sessions/${ID}/input` },
];

describe('roles: a member cannot reach owner-only capabilities or other accounts', () => {
  let studio: RunningStudio;
  let member: ApiClient;
  beforeAll(async () => {
    studio = await startTestStudio();
    const owner = await studio.owner();
    await owner.post('/api/users', {
      username: 'themember',
      password: 'a member passphrase 12',
      role: 'member',
    });
    member = new ApiClient(studio.url);
    const login = await member.login({ username: 'themember', password: 'a member passphrase 12' });
    expect(login.status).toBe(200);
    expect((login.body as { user: { role: string } }).user.role).toBe('member');
  });
  afterAll(() => studio?.destroy());

  it('SEC-027: a member may use member-level routes (sanity)', async () => {
    expect((await member.get('/api/projects')).status).toBe(200);
    expect((await member.get('/api/system/info')).status).toBe(200);
  });

  it('7.1.8: every owner-only route refuses a member with owner_required', async () => {
    for (const { method, url } of OWNER_ONLY) {
      const response = await member.request<{ error: { code: string } }>(
        method,
        url,
        method === 'GET' || method === 'DELETE' ? undefined : {},
      );
      expect(response.status, `${method} ${url}`).toBe(403);
      expect(response.body.error.code, `${method} ${url}`).toBe('owner_required');
    }
  });

  it('SEC-028: a member cannot see or change other accounts', async () => {
    expect((await member.get('/api/users')).status).toBe(403); // cannot list accounts
    const owner = await studio.owner();
    const ownerId = (await owner.get<{ user: { id: string } }>('/api/auth/state')).body.user.id;
    // Cannot promote/disable another account.
    expect((await member.patch(`/api/users/${ownerId}`, { role: 'member' })).status).toBe(403);
    expect((await member.delete(`/api/users/${ownerId}`)).status).toBe(403);
    // The owner is unchanged.
    expect((await owner.get<{ user: { role: string } }>('/api/auth/state')).body.user.role).toBe(
      'owner',
    );
  });

  it('7.1.8: an API token cannot perform account management', async () => {
    const owner = await studio.owner();
    const created = await owner.post<{ token: string }>('/api/auth/tokens', {
      name: 'admin-token',
      scopes: ['read', 'write', 'admin'],
    });
    const robot = studio.client();
    robot.bearer = created.body.token;
    // Even an admin-scoped token is refused on the session-only management routes.
    expect(
      (await robot.post('/api/users', { username: 'viatoken', password: 'a passphrase of twelve' }))
        .status,
    ).toBe(403);
    expect((await robot.patch(`/api/users/${ID}`, { role: 'member' })).status).toBe(403);
    expect((await robot.delete(`/api/users/${ID}`)).status).toBe(403);
    // No new account slipped through.
    const users = await owner.get<{ users: Array<{ username: string }> }>('/api/users');
    expect(users.body.users.some((u) => u.username === 'viatoken')).toBe(false);
  });
});
