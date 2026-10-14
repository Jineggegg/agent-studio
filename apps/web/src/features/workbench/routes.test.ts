import { describe, expect, it } from 'vitest';
import { canonicalPath, parseWorkbenchPath, workbenchPaths } from './routes';

const P = '01aaaaaaaaaaaaaaaaaaaaaaaa';
const Q = '01bbbbbbbbbbbbbbbbbbbbbbbb';
const S = '01cccccccccccccccccccccccc';

describe('workbench addresses', () => {
  it.each([
    ['/workbench', { kind: 'landing' }],
    ['/workbench/', { kind: 'landing' }],
    [`/workbench/p/${P}`, { kind: 'project', projectId: P }],
    [`/workbench/p/${P}/new`, { kind: 'new', projectId: P }],
    [`/workbench/p/${P}/s/${S}`, { kind: 'session', projectId: P, sessionId: S }],
    [`/workbench/s/${S}`, { kind: 'lookup', sessionId: S }],
    ['/workbench/s/3f2a%2Fnative-id', { kind: 'lookup', sessionId: '3f2a/native-id' }],
    ['/workbench/p', { kind: 'unknown' }],
    [`/workbench/p/${P}/s`, { kind: 'unknown' }],
    [`/workbench/p/${P}/files`, { kind: 'unknown' }],
    [`/workbench/p/${P}/s/${S}/extra`, { kind: 'unknown' }],
    ['/workbench/s/%E0%A4%A', { kind: 'unknown' }],
    ['/workbench/elsewhere', { kind: 'unknown' }],
  ])('%s', (path, expected) => {
    expect(parseWorkbenchPath(path)).toEqual(expected);
  });

  it('builds what it parses', () => {
    expect(parseWorkbenchPath(workbenchPaths.session(P, S))).toEqual({ kind: 'session', projectId: P, sessionId: S });
    expect(parseWorkbenchPath(workbenchPaths.session(null, S))).toEqual({ kind: 'lookup', sessionId: S });
    expect(parseWorkbenchPath(workbenchPaths.newChat(P))).toEqual({ kind: 'new', projectId: P });
    expect(parseWorkbenchPath(workbenchPaths.project(P))).toEqual({ kind: 'project', projectId: P });
  });

  it('corrects a link that names the wrong project, and leaves a right one alone', () => {
    expect(canonicalPath({ kind: 'session', projectId: P, sessionId: S }, Q)).toBe(workbenchPaths.session(Q, S));
    expect(canonicalPath({ kind: 'session', projectId: P, sessionId: S }, P)).toBeNull();
    expect(canonicalPath({ kind: 'lookup', sessionId: S }, P)).toBe(workbenchPaths.session(P, S));
    // A conversation outside any project lives at the short address.
    expect(canonicalPath({ kind: 'lookup', sessionId: S }, null)).toBeNull();
    expect(canonicalPath({ kind: 'session', projectId: P, sessionId: S }, null)).toBe(workbenchPaths.lookup(S));
  });
});
