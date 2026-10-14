import type { Approval } from '@agent-studio/protocol';

/** Fixtures for the approval tests. Not imported by anything that ships. */
export const ME = '01meeeeeeeeeeeeeeeeeeeeeee';
export const OTHER = '01otherrrrrrrrrrrrrrrrrrrr';

export function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: '01aaaaaaaaaaaaaaaaaaaaaaaa',
    runId: '01rrrrrrrrrrrrrrrrrrrrrrrr',
    sessionId: '01ssssssssssssssssssssssss',
    projectId: '01pppppppppppppppppppppppp',
    userId: ME,
    kind: 'tool',
    toolName: 'Bash',
    toolKind: 'execute',
    toolCallId: 'call-1',
    title: 'Run npm test',
    command: 'npm test',
    paths: [],
    diff: null,
    input: { command: 'npm test' },
    plan: null,
    questions: null,
    risk: 'medium',
    riskCategories: [],
    reason: 'This changes something, so it needs your approval.',
    requiresOwner: false,
    suggestedRule: { tool: 'Bash', pattern: 'npm test *' },
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    note: null,
    answers: null,
    expiresAt: null,
    createdAt: 0,
    ...overrides,
  };
}
