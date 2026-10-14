import type { ChainEntry, Handoff } from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';
import { session } from '../testing';
import { chainPlace } from './ChainBar';
import { collapseChains, rowStandsFor } from './chains';
import { handoffFor } from './HandoffNotice';

describe('a chain in a session list', () => {
  const first = session({ id: 'a'.repeat(26), agentId: 'claude-code', createdAt: 100, lastUserMessageAt: 900, attention: 'needs-you' });
  const second = session({ id: 'b'.repeat(26), agentId: 'codex', chainId: first.id, parentSessionId: first.id, createdAt: 200, lastUserMessageAt: 300 });
  const third = session({ id: 'c'.repeat(26), agentId: 'claude-code', chainId: first.id, parentSessionId: second.id, createdAt: 300, lastUserMessageAt: 400 });
  const alone = session({ id: 'd'.repeat(26), createdAt: 150 });

  it('is one row: its newest conversation, standing for all of them', () => {
    const { sessions, chains } = collapseChains([alone, second, first, third]);
    expect(sessions.map((entry) => entry.id)).toEqual([alone.id, third.id]);
    expect(chains.get(third.id)).toEqual({ memberIds: [first.id, second.id, third.id], agentIds: ['claude-code', 'codex', 'claude-code'], count: 3 });
    expect(chains.has(alone.id)).toBe(false);
  });

  it('carries the most urgent mark of the chain and the last time the user spoke anywhere in it', () => {
    const { sessions } = collapseChains([first, second, third]);
    expect(sessions[0]).toMatchObject({ id: third.id, attention: 'needs-you', lastUserMessageAt: 900 });
    const running = collapseChains([first, { ...second, activeRunId: 'r'.repeat(26) }, third]).sessions[0]!;
    expect(running.activeRunId).toBe('r'.repeat(26));
  });

  it('marks a chain’s newest conversation even when the earlier ones are not in the list', () => {
    const { sessions, chains } = collapseChains([third]);
    expect(sessions).toEqual([third]);
    expect(chains.get(third.id)?.count).toBe(1);
  });

  it('leaves a list without chains exactly as it was', () => {
    const list = [alone, session({ createdAt: 10 })];
    const { sessions, chains } = collapseChains(list);
    expect(sessions).toEqual(list);
    expect(sessions[0]).toBe(list[0]);
    expect(chains.size).toBe(0);
  });

  it('marks the row of a chain as open while any of its parts is on screen', () => {
    const { chains } = collapseChains([first, second, third]);
    expect(rowStandsFor(third.id, chains.get(third.id), first.id)).toBe(true);
    expect(rowStandsFor(third.id, chains.get(third.id), alone.id)).toBe(false);
    expect(rowStandsFor(alone.id, undefined, alone.id)).toBe(true);
    expect(rowStandsFor(alone.id, undefined, null)).toBe(false);
  });
});

describe('a conversation’s place in its chain', () => {
  const entry = (id: string, current: boolean, latest: boolean): ChainEntry => ({
    session: session({ id: id.repeat(26) }),
    agentName: id,
    current,
    latest,
    previousSessionId: null,
    gapBefore: false,
    handoff: null,
  });

  it('knows the part before and after it, and the latest', () => {
    const place = chainPlace([entry('a', false, false), entry('b', true, false), entry('c', false, true)]);
    expect(place).toMatchObject({ index: 1, total: 3 });
    expect(place.previous?.agentName).toBe('a');
    expect(place.next?.agentName).toBe('c');
    expect(place.latest?.agentName).toBe('c');
  });

  it('has no part after the latest', () => {
    const place = chainPlace([entry('a', false, false), entry('b', true, true)]);
    expect(place.next).toBeNull();
    expect(place.current?.latest).toBe(true);
  });
});

describe('the record behind a handoff notice', () => {
  const handoff = (id: string, noticeSeq: number): Handoff => ({
    id: id.repeat(26),
    projectId: null,
    by: { userId: 'u'.repeat(26), displayName: 'Ada' },
    at: 1,
    source: { sessionId: 's'.repeat(26), agentId: 'claude-code', agentName: 'Claude Code', model: null, noticeSeq, title: 'T' },
    target: { sessionId: 't'.repeat(26), agentId: 'codex', agentName: 'Codex', model: null, noticeSeq: 1 },
    brief: { kind: 'digest', text: 'brief' },
    summary: { requested: false, status: 'not-requested', agentId: null, agentName: null, model: null, reason: null },
    note: null,
    started: false,
    firstRunId: null,
  });

  it('is the incoming handoff for the notice received, and the one at that place for a notice sent', () => {
    const incoming = handoff('i', 1);
    const early = handoff('e', 10);
    const late = handoff('l', 20);
    const data = { incoming, outgoing: [early, late] };
    expect(handoffFor('handoff_received', 1, data)).toBe(incoming);
    expect(handoffFor('handoff_sent', 10, data)).toBe(early);
    expect(handoffFor('handoff_sent', 20, data)).toBe(late);
    expect(handoffFor('handoff_sent', 99, data)).toBe(late);
    expect(handoffFor('handoff_sent', 1, undefined)).toBeNull();
  });
});
