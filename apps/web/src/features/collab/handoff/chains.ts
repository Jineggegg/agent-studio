import type { Attention, Session } from '@agent-studio/protocol';

/**
 * Conversations handed from one agent to another form a chain: the first
 * one's id is the chain's id (`chainId` on the others, null on itself). A
 * session list shows a chain as one row — its newest conversation, the only
 * one that can be handed on — carrying the chain's liveliest mark and its
 * newest time. Pure, so the folding rules are tested without a screen.
 */

export interface ChainSummary {
  /** The conversations of the chain that are in the list, oldest first. */
  memberIds: string[];
  /** Their agents, oldest first (an agent can appear more than once). */
  agentIds: string[];
  /** Conversations of the chain in the list. A chain's newest may be listed without the others: then 1. */
  count: number;
}

export const chainKey = (session: Pick<Session, 'id' | 'chainId'>): string => session.chainId ?? session.id;

const ATTENTION_RANK: Record<Attention, number> = { 'needs-you': 3, running: 2, unseen: 1, none: 0 };

function newestFirst(a: Session, b: Session): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);
}

/**
 * Folds every chain in `sessions` into one entry: the chain's newest
 * conversation, standing for all of them. Its attention is the most urgent
 * of the chain's, a run anywhere in the chain shows as running, and it sorts
 * by the last time the user spoke anywhere in the chain. Sessions outside any
 * chain pass through unchanged, in their order.
 */
export function collapseChains(sessions: readonly Session[]): { sessions: Session[]; chains: Map<string, ChainSummary> } {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const key = chainKey(session);
    const group = groups.get(key);
    if (group) {
      if (!group.some((member) => member.id === session.id)) group.push(session);
    } else groups.set(key, [session]);
  }

  const chains = new Map<string, ChainSummary>();
  const standIn = new Map<string, Session>();
  for (const [key, group] of groups) {
    const ordered = [...group].sort(newestFirst);
    const newest = ordered[0]!;
    const isChain = group.length > 1 || newest.chainId !== null;
    if (!isChain) continue;
    const oldestFirst = [...ordered].reverse();
    let attention: Attention = newest.attention;
    for (const member of ordered) if (ATTENTION_RANK[member.attention] > ATTENTION_RANK[attention]) attention = member.attention;
    const activeRunId = newest.activeRunId ?? ordered.find((member) => member.activeRunId !== null)?.activeRunId ?? null;
    const spokenTimes = ordered.map((member) => member.lastUserMessageAt).filter((value): value is number => value !== null);
    const lastUserMessageAt = spokenTimes.length > 0 ? Math.max(...spokenTimes) : newest.lastUserMessageAt;
    const changed = attention !== newest.attention || activeRunId !== newest.activeRunId || lastUserMessageAt !== newest.lastUserMessageAt;
    standIn.set(key, changed ? { ...newest, attention, activeRunId, lastUserMessageAt } : newest);
    chains.set(newest.id, { memberIds: oldestFirst.map((member) => member.id), agentIds: oldestFirst.map((member) => member.agentId), count: group.length });
  }

  const result: Session[] = [];
  const placed = new Set<string>();
  for (const session of sessions) {
    const key = chainKey(session);
    const chosen = standIn.get(key);
    if (!chosen) {
      result.push(session);
      continue;
    }
    if (placed.has(key)) continue;
    placed.add(key);
    result.push(chosen);
  }
  return { sessions: result, chains };
}

/** Whether `sessionId` is one of the conversations a list row stands for. */
export function rowStandsFor(rowSessionId: string, chain: ChainSummary | undefined, sessionId: string | null): boolean {
  if (sessionId === null) return false;
  return rowSessionId === sessionId || (chain?.memberIds.includes(sessionId) ?? false);
}
