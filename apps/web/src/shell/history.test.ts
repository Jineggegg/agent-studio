import { beforeEach, describe, expect, it } from 'vitest';
import { __resetHistoryForTests, entryBefore, recordNavigation, setEntryTitle } from './history';

beforeEach(() => __resetHistoryForTests());

describe("the app's view of this tab's history", () => {
  it('knows nothing is behind a cold start', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/settings/account' });
    expect(entryBefore('a')).toBeNull();
  });

  it('follows pushes, so back can return to where the user came from', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/' });
    recordNavigation('PUSH', { key: 'b', pathname: '/settings' });
    recordNavigation('PUSH', { key: 'c', pathname: '/settings/account' });
    expect(entryBefore('c')).toMatchObject({ key: 'b', pathname: '/settings' });
    expect(entryBefore('b')).toMatchObject({ key: 'a', pathname: '/' });
  });

  it('treats a replace as a sibling: it adds no entry', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/' });
    recordNavigation('PUSH', { key: 'b', pathname: '/projects/p/chat' });
    recordNavigation('REPLACE', { key: 'c', pathname: '/projects/p/files' });
    recordNavigation('REPLACE', { key: 'd', pathname: '/projects/p/git' });
    // three tab switches later, back still leads home
    expect(entryBefore('d')).toMatchObject({ pathname: '/' });
    expect(entryBefore('b')).toBeNull();
  });

  it('follows the browser back and forward, and forgets the future after a new push', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/' });
    recordNavigation('PUSH', { key: 'b', pathname: '/settings' });
    recordNavigation('PUSH', { key: 'c', pathname: '/settings/about' });
    recordNavigation('POP', { key: 'b', pathname: '/settings' });
    expect(entryBefore('b')).toMatchObject({ key: 'a' });
    recordNavigation('PUSH', { key: 'd', pathname: '/settings/people' });
    expect(entryBefore('d')).toMatchObject({ key: 'b' });
    expect(entryBefore('c')).toBeNull(); // the old forward entry is gone
  });

  it('starts again when the browser lands on an entry it has never seen', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/' });
    recordNavigation('PUSH', { key: 'b', pathname: '/settings' });
    recordNavigation('POP', { key: 'zzz', pathname: '/inbox' });
    expect(entryBefore('zzz')).toBeNull();
  });

  it('remembers screen titles for the next screen’s back control, and survives a reload', () => {
    recordNavigation('INITIAL', { key: 'a', pathname: '/' });
    recordNavigation('PUSH', { key: 'b', pathname: '/settings' });
    setEntryTitle('b', 'Settings');
    recordNavigation('PUSH', { key: 'c', pathname: '/settings/account' });
    expect(entryBefore('c')).toMatchObject({ title: 'Settings' });

    // a reload keeps sessionStorage and the entry's key
    recordNavigation('INITIAL', { key: 'c', pathname: '/settings/account' });
    expect(entryBefore('c')).toMatchObject({ key: 'b', title: 'Settings' });
  });
});
