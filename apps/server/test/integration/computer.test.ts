import type { ComputerAction, ComputerDevice, ComputerProposal } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentsKit, type AgentsKit } from '../../src/testing/agents-kit.js';
let kit: AgentsKit;
beforeEach(async () => {
  kit = await createAgentsKit();
});
afterEach(async () => {
  await kit.close();
});
type Paired = { deviceId: string; token: string };
type Lease = { id: string; lease: string; action: ComputerAction; expiresAt: number };
async function pair(): Promise<Paired> {
  const code = await kit.owner.post<{ token: string }>('/api/computer/pairings');
  expect(code.status).toBe(200);
  const body = { token: code.body.token, name: 'Synthetic Windows', platform: 'windows' };
  const result = await kit.t.anonymous().post<Paired>('/api/computer/pair', body);
  expect(result.status).toBe(200);
  expect((await kit.t.anonymous().post('/api/computer/pair', body)).status).toBe(401);
  const rows = kit.t.studio.context.db.all('SELECT token_hash FROM computer_devices');
  expect(JSON.stringify(rows)).not.toContain(result.body.token);
  return result.body;
}
const devicePost = <T>(device: Paired, url: string, body: unknown) =>
  kit.t.anonymous().request<T>('POST', url, body, { authorization: `Bearer ${device.token}` });
const poll = (device: Paired) =>
  devicePost<Lease | null>(device, '/api/computer/poll', { width: 1920, height: 1080 });
async function propose(device: Paired, action: ComputerAction) {
  const result = await kit.owner.post<ComputerProposal>('/api/computer/actions', {
    deviceId: device.deviceId,
    action,
    reason: 'Synthetic safety test',
  });
  expect(result.status).toBe(200);
  return result.body;
}
async function approve(row: ComputerProposal) {
  expect(
    (
      await kit.owner.post(`/api/computer/actions/${row.id}/approve`, {
        confirm: true,
        action: row.action,
      })
    ).status,
  ).toBe(200);
}

describe('explicit Windows companion boundary', () => {
  it('starts with no devices, pairs once, and refuses other users and stale credentials', async () => {
    expect(
      (await kit.owner.get<{ devices: ComputerDevice[] }>('/api/computer/devices')).body.devices,
    ).toEqual([]);
    const device = await pair();
    const member = await kit.t.member('computer-member');
    expect(
      (await member.get<{ devices: ComputerDevice[] }>('/api/computer/devices')).body.devices,
    ).toEqual([]);
    expect((await member.delete(`/api/computer/devices/${device.deviceId}`)).status).toBe(404);
    expect(
      (
        await member.post('/api/computer/actions', {
          deviceId: device.deviceId,
          action: { kind: 'screenshot' },
          reason: 'Unauthorized',
        })
      ).status,
    ).toBe(404);
    expect((await poll(device)).body).toBeNull();
    expect((await kit.owner.delete(`/api/computer/devices/${device.deviceId}`)).status).toBe(204);
    expect((await poll(device)).status).toBe(401);
  });

  it('requires the exact browser-approved action and a one-use local authorization', async () => {
    const device = await pair();
    const row = await propose(device, {
      kind: 'type',
      text: 'literal {ENTER}; never a command API',
    });
    expect((await poll(device)).body).toBeNull();
    expect(
      (
        await kit.owner.post(`/api/computer/actions/${row.id}/approve`, {
          confirm: true,
          action: { kind: 'type', text: 'different text' },
        })
      ).status,
    ).toBe(409);
    await approve(row);
    const lease = (await poll(device)).body!;
    expect(lease.action).toEqual(row.action);
    expect((await poll(device)).body).toBeNull();
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/complete`, {
          lease: lease.lease,
          success: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/authorize`, {
          lease: lease.lease,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/authorize`, {
          lease: lease.lease,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/complete`, {
          lease: lease.lease,
          success: true,
          screenshot: '/9j/2Q==',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/complete`, {
          lease: lease.lease,
          success: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/complete`, {
          lease: lease.lease,
          success: true,
        })
      ).status,
    ).toBe(409);
    expect(
      JSON.stringify(kit.t.studio.context.db.all('SELECT * FROM computer_actions')),
    ).not.toContain('literal {ENTER}');
    expect(
      (
        await kit.owner.post('/api/computer/actions', {
          deviceId: device.deviceId,
          action: { kind: 'shell', command: 'forbidden' },
          reason: 'Invalid primitive',
        })
      ).status,
    ).toBe(400);
    await kit.owner.delete(`/api/computer/devices/${device.deviceId}`);
  });

  it('binds leases to their device and invalidates cancellation and expiry without dispatching again', async () => {
    const first = await pair(),
      second = await pair();
    const row = await propose(first, { kind: 'click', x: 12, y: 20 });
    await approve(row);
    const lease = (await poll(first)).body!;
    expect(
      (
        await devicePost(second, `/api/computer/actions/${row.id}/authorize`, {
          lease: lease.lease,
        })
      ).status,
    ).toBe(409);
    expect((await kit.owner.post(`/api/computer/actions/${row.id}/reject`)).status).toBe(200);
    expect(
      (await devicePost(first, `/api/computer/actions/${row.id}/authorize`, { lease: lease.lease }))
        .status,
    ).toBe(409);
    const expiring = await propose(first, { kind: 'screenshot' });
    await approve(expiring);
    const expiringLease = (await poll(first)).body!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiringLease.expiresAt + 1);
    try {
      expect(
        (
          await devicePost(first, `/api/computer/actions/${expiring.id}/authorize`, {
            lease: expiringLease.lease,
          })
        ).status,
      ).toBe(409);
      expect((await poll(first)).body).toBeNull();
    } finally {
      clock.mockRestore();
    }
    await kit.owner.delete(`/api/computer/devices/${first.deviceId}`);
    await kit.owner.delete(`/api/computer/devices/${second.deviceId}`);
  });

  it('lets an agent propose an action while leaving execution pending for both people approvals', async () => {
    const device = await pair();
    expect(
      (await kit.owner.put(`/api/agents/projects/${kit.project.id}/settings`, { autoMode: true }))
        .status,
    ).toBe(200);
    const session = await kit.session(kit.owner, { permissionMode: 'auto' });
    kit.agent.script([
      {
        studioTool: {
          name: 'computer_propose',
          input: {
            deviceId: device.deviceId,
            action: { kind: 'click', x: 20, y: 30 },
            reason: 'Review this click',
          },
        },
      },
    ]);
    await kit.turn(kit.owner, session.id, 'Propose only');
    expect(kit.agent.lastRun.toolResults[0]?.text).toContain('nothing has executed');
    expect((await poll(device)).body).toBeNull();
    const rows = (await kit.owner.get<{ actions: ComputerProposal[] }>('/api/computer/actions'))
      .body.actions;
    expect(rows.find((row) => row.deviceId === device.deviceId)).toMatchObject({
      sessionId: session.id,
      status: 'pending',
    });
    await kit.owner.delete(`/api/computer/devices/${device.deviceId}`);
  });

  it('keeps screenshots ephemeral, readable once by their user, and absent from agent tools', async () => {
    const device = await pair();
    const row = await propose(device, { kind: 'screenshot' });
    await approve(row);
    const lease = (await poll(device)).body!;
    await devicePost(device, `/api/computer/actions/${row.id}/authorize`, { lease: lease.lease });
    expect(
      (
        await devicePost(device, `/api/computer/actions/${row.id}/complete`, {
          lease: lease.lease,
          success: true,
          screenshot: '/9j/2Q==',
        })
      ).status,
    ).toBe(200);
    const member = await kit.t.member('screenshot-member');
    expect((await member.get(`/api/computer/actions/${row.id}/screenshot`)).status).toBe(404);
    expect((await kit.owner.get(`/api/computer/actions/${row.id}/screenshot`)).body).toEqual({
      mediaType: 'image/jpeg',
      data: '/9j/2Q==',
    });
    expect((await kit.owner.get(`/api/computer/actions/${row.id}/screenshot`)).status).toBe(404);
    expect(
      kit.t.studio.context.agentTools
        .list()
        .filter((tool) => tool.name.startsWith('computer_'))
        .map((tool) => [tool.name, tool.effect]),
    ).toEqual([
      ['computer_devices', 'read'],
      ['computer_propose', 'write'],
    ]);
    await kit.owner.delete(`/api/computer/devices/${device.deviceId}`);
  });
});
