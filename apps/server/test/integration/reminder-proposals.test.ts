import { afterEach, describe, expect, it } from 'vitest';
import {
  createAutomationWorlds,
  listAutomations,
} from '../../src/modules/automation/testing/world.js';
const worlds = createAutomationWorlds();
afterEach(() => worlds.closeAll());
describe('agent reminder proposals', () => {
  it('does not schedule until a person approves, validates timezone, and consumes approval once', async () => {
    const { kit } = await worlds.start({ at: '2026-10-23T12:00:00Z' });
    const context = {
      userId: kit.owner.userId!,
      projectId: kit.project.id,
      runId: 'fake-run',
      sessionId: 'fake-session',
      agentId: 'scripted',
    };
    const registry = kit.t.studio.context.agentTools;
    expect(
      (
        await registry.call('reminder_propose', context, {
          operation: 'create',
          name: 'Review',
          message: 'Review a synthetic note',
          timeZone: 'MadeUp/Zone',
          trigger: { type: 'daily', time: '09:00' },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await registry.call(
          'reminder_propose',
          { ...context, projectId: null },
          {
            operation: 'create',
            name: 'Review',
            message: 'Review',
            timeZone: 'UTC',
            trigger: { type: 'daily', time: '09:00' },
          },
        )
      ).isError,
    ).toBe(true);
    const result = await registry.call('reminder_propose', context, {
      operation: 'create',
      name: 'Review',
      message: 'Review a synthetic note',
      timeZone: 'Asia/Shanghai',
      trigger: { type: 'daily', time: '09:00' },
    });
    expect(result.isError).toBeUndefined();
    const proposal = JSON.parse(result.text) as { proposalId: string };
    expect((await listAutomations(kit.owner, kit.project.id)).automations).toEqual([]);
    const url = `/api/projects/${kit.project.id}/reminder-proposals/${proposal.proposalId}/approve`;
    const member = await kit.t.member();
    expect((await member.post(url, { confirmed: true })).status).toBe(404);
    expect((await kit.owner.post(url, { confirmed: false })).status).toBe(400);
    expect((await kit.owner.post(url, { confirmed: true })).status).toBe(200);
    expect((await kit.owner.post(url, { confirmed: true })).status).toBe(404);
    const [created] = (await listAutomations(kit.owner, kit.project.id)).automations;
    expect(created).toMatchObject({ enabled: true, timeZone: 'Asia/Shanghai' });
    const status = await registry.call('reminder_status', context, {});
    expect(status.text).toContain('Review');
    const pause = JSON.parse(
      (
        await registry.call('reminder_propose', context, {
          operation: 'pause',
          automationId: created!.id,
        })
      ).text,
    ) as { proposalId: string };
    expect((await listAutomations(kit.owner, kit.project.id)).automations[0]!.enabled).toBe(true);
    expect(
      (
        await kit.owner.post(
          `/api/projects/${kit.project.id}/reminder-proposals/${pause.proposalId}/approve`,
          { confirmed: true },
        )
      ).status,
    ).toBe(200);
    expect((await listAutomations(kit.owner, kit.project.id)).automations[0]!.enabled).toBe(false);
  });
});
