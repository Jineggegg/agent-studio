import { expect, it } from 'vitest';
import { conversationTasks } from './model';
import type { TranscriptState } from '../transcript/model';
it('reports only actual loaded events and preserves terminal statuses and times', () => {
  const state = {
    pendingApprovals: [],
    runs: { r1: { runId: 'r1', agentId: 'coder', status: 'completed', startedAt: 1000 } },
    items: [
      { kind: 'run-end', runId: 'r1', at: 4000 },
      {
        kind: 'stack',
        runId: 'r1',
        entries: [
          {
            type: 'tool',
            toolCallId: 'parent',
            kind: 'agent',
            title: 'Review',
            status: 'ok',
            startedAt: 2000,
            finishedAt: 3500,
            children: [
              {
                type: 'tool',
                toolCallId: 'child',
                kind: 'read',
                title: 'Read file',
                status: 'denied',
                startedAt: 2100,
                finishedAt: 2200,
                children: [],
              },
            ],
          },
        ],
      },
    ],
  } as unknown as TranscriptState;
  const tasks = conversationTasks(state);
  expect(tasks).toHaveLength(3);
  expect(tasks.find((task) => task.id === 'r1:parent')).toMatchObject({
    type: 'agent',
    status: 'completed',
    startedAt: 2000,
    finishedAt: 3500,
  });
  expect(tasks.find((task) => task.id === 'r1:child')).toMatchObject({ status: 'denied' });
  expect(tasks.find((task) => task.id === 'run:r1')).toMatchObject({ finishedAt: 4000 });
  expect(conversationTasks({ runs: {}, items: [] } as unknown as TranscriptState)).toEqual([]);
});

it('distinguishes an actual pending approval from running work', () => {
  const state = {
    runs: { r: { runId: 'r', status: 'running', startedAt: 1 } },
    items: [],
    pendingApprovals: [{ runId: 'r' }],
  } as unknown as TranscriptState;
  expect(conversationTasks(state)[0]?.status).toBe('waiting');
});
