import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps } from './Composer';
import { __resetAttachmentsForTests } from './attachmentStore';
import { __resetDraftsForTests, getDraft, sessionDraftKey } from './drafts';
import { type MentionMatch, insertMention, mentionAt } from './mentions';
import { __resetDeviceMemoryForTests } from '../device';

const api = vi.hoisted(() => ({ saveDraft: vi.fn(async (_id: string, text: string) => ({ sessionId: 's', text, updatedAt: 1 })), draft: vi.fn(), uploadAttachment: vi.fn(), removeAttachment: vi.fn(), pendingAttachments: vi.fn() }));
vi.mock('../api', () => ({ workbenchApi: api, SEND_TIMEOUT_MS: 20_000 }));

describe('finding the mention at the caret', () => {
  it('starts at an "@" that opens the text or follows white space', () => {
    expect(mentionAt('@app', 4)).toEqual({ start: 0, end: 4, query: 'app' });
    expect(mentionAt('look at @src/ap', 15)).toEqual({ start: 8, end: 15, query: 'src/ap' });
    expect(mentionAt('line one\n@re', 12)).toEqual({ start: 9, end: 12, query: 're' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
  });

  it('is not opened by the "@" of an address or a version', () => {
    expect(mentionAt('mail me@example.com', 19)).toBeNull();
    expect(mentionAt('react@19', 8)).toBeNull();
    expect(mentionAt('a @b@c', 6)).toBeNull();
  });

  it('ends at white space and needs the caret inside it', () => {
    expect(mentionAt('@app is here', 12)).toBeNull();
    expect(mentionAt('@app is here', 4)).toEqual({ start: 0, end: 4, query: 'app' });
    expect(mentionAt('@app', 2)).toEqual({ start: 0, end: 2, query: 'a' });
    expect(mentionAt('hello', 3)).toBeNull();
    expect(mentionAt('', 0)).toBeNull();
  });
});

describe('putting the chosen path in', () => {
  it('replaces the mention with the path and a space, and leaves the caret after it', () => {
    expect(insertMention('see @test', { start: 4, end: 9, query: 'test' }, 'src/app.test.ts')).toEqual({ text: 'see src/app.test.ts ', caret: 20 });
  });

  it('replaces the whole word the caret was in, and does not double the space', () => {
    expect(insertMention('@ap please', { start: 0, end: 3, query: 'ap' }, 'src/app.ts')).toEqual({ text: 'src/app.ts please', caret: 11 });
    expect(insertMention('fix @apXX now', { start: 4, end: 7, query: 'ap' }, 'a.ts')).toEqual({ text: 'fix a.ts now', caret: 9 });
  });
});

describe('the picker in the message field', () => {
  const KEY = sessionDraftKey('01ssssssssssssssssssssssss');
  const FILES: MentionMatch[] = [
    { path: 'src/app.test.ts', name: 'app.test.ts', kind: 'file' },
    { path: 'tests', name: 'tests', kind: 'directory' },
    { path: 'docs/testing.md', name: 'testing.md', kind: 'file' },
  ];

  function setup(search = vi.fn(async () => FILES)) {
    const onSubmit = vi.fn(() => true);
    const props: ComposerProps = { draftKey: KEY, placeholder: 'Message', busy: false, canSteer: false, blocked: false, stopping: false, attachmentsEnabled: false, onSubmit, onStop: () => {}, quote: null, onClearQuote: () => {}, mentions: { search } };
    render(<Composer {...props} />);
    const field = screen.getByPlaceholderText('Message') as HTMLTextAreaElement;
    const type = (text: string) => {
      fireEvent.change(field, { target: { value: text, selectionStart: text.length, selectionEnd: text.length } });
    };
    return { field, type, onSubmit, search };
  }

  beforeEach(() => {
    // A device with a keyboard: Enter would send.
    window.matchMedia = ((query: string) => ({ matches: query.includes('hover'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  });
  afterEach(() => {
    __resetDraftsForTests();
    __resetAttachmentsForTests();
    __resetDeviceMemoryForTests();
  });

  it('offers the project\'s files for what follows the "@"', async () => {
    const { type, search } = setup();
    type('look at @test');
    expect(await screen.findByRole('option', { name: /app\.test\.ts/ })).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith('test', expect.anything());
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('Enter chooses the highlighted file instead of sending, and inserts its path', async () => {
    const { field, type, onSubmit } = setup();
    type('look at @test');
    await screen.findByRole('option', { name: /app\.test\.ts/ });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    // A folder is inserted with its slash.
    expect(getDraft(KEY)).toBe('look at tests/ ');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  });

  it('a tap chooses too', async () => {
    const { type } = setup();
    type('@test');
    fireEvent.click(await screen.findByRole('option', { name: /testing\.md/ }));
    expect(getDraft(KEY)).toBe('docs/testing.md ');
  });

  it('Escape puts the list away without touching the text, and it stays away', async () => {
    const { field, type } = setup();
    type('@test');
    await screen.findByRole('option', { name: /app\.test\.ts/ });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type('@tests');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(getDraft(KEY)).toBe('@tests');
  });

  it('says so when nothing matches, and Enter then sends as usual', async () => {
    const { field, type, onSubmit } = setup(vi.fn(async () => []));
    type('@zzz');
    expect(await screen.findByText('No file is called “zzz”.')).toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('does not open outside a project (no source of files)', () => {
    const onSubmit = vi.fn(() => true);
    render(<Composer draftKey={KEY} placeholder="Message" busy={false} canSteer={false} blocked={false} stopping={false} attachmentsEnabled={false} onSubmit={onSubmit} onStop={() => {}} quote={null} onClearQuote={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Message'), { target: { value: '@test', selectionStart: 5, selectionEnd: 5 } });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
