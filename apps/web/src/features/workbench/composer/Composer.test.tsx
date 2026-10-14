import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerProps, type ComposerSubmission } from './Composer';
import { __resetAttachmentsForTests, attachmentsOf } from './attachmentStore';
import { __resetDraftsForTests, applyRemoteDraft, getDraft, loadDraft, moveNewDraft, newChatDraftKey, noteDraftFlag, restoreNewDraft, sessionDraftKey, setDraft } from './drafts';
import { __resetDeviceMemoryForTests } from '../device';

const api = vi.hoisted(() => ({
  saveDraft: vi.fn(async (_sessionId: string, text: string) => ({ sessionId: 's', text, updatedAt: 1 })),
  draft: vi.fn(async () => ({ sessionId: 's', text: '', updatedAt: null as number | null })),
  uploadAttachment: vi.fn(),
  removeAttachment: vi.fn(async () => undefined),
  pendingAttachments: vi.fn(async () => ({ attachments: [] })),
}));
vi.mock('../api', () => ({ workbenchApi: api, SEND_TIMEOUT_MS: 20_000 }));

const SESSION = '01ssssssssssssssssssssssss';
const KEY = sessionDraftKey(SESSION);
const NEW_KEY = newChatDraftKey('01pppppppppppppppppppppppp');

/** A device with a keyboard and a mouse: Enter sends. */
function finePointer(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches && query.includes('hover'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function setup(overrides: Partial<ComposerProps> = {}) {
  const onSubmit = vi.fn<(submission: ComposerSubmission) => Promise<boolean> | boolean>(() => true);
  const onStop = vi.fn();
  const props: ComposerProps = {
    draftKey: KEY,
    placeholder: 'Message Demo agent',
    busy: false,
    canSteer: false,
    blocked: false,
    stopping: false,
    attachmentsEnabled: true,
    onSubmit,
    onStop,
    quote: null,
    onClearQuote: () => {},
    ...overrides,
  };
  const view = render(<Composer {...props} />);
  const field = screen.getByPlaceholderText('Message Demo agent') as HTMLTextAreaElement;
  return { ...view, field, onSubmit: props.onSubmit as typeof onSubmit, onStop, rerender: (next: Partial<ComposerProps>) => view.rerender(<Composer {...props} {...next} />) };
}

const type = (field: HTMLTextAreaElement, text: string) => fireEvent.change(field, { target: { value: text } });
const sendButton = () => screen.getByRole('button', { name: 'Send' });

beforeEach(() => {
  finePointer(true);
  for (const mock of Object.values(api)) mock.mockClear();
});
afterEach(() => {
  __resetDraftsForTests();
  __resetAttachmentsForTests();
  __resetDeviceMemoryForTests();
  vi.useRealTimers();
});

describe('sending from the keyboard', () => {
  it('sends on Enter, breaks the line on Shift+Enter, and sends on Ctrl/⌘+Enter', async () => {
    const { field, onSubmit } = setup();
    type(field, 'fix the login bug');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenLastCalledWith({ text: 'fix the login bug', quote: null, whenBusy: 'queue' });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it('on a touch keyboard Enter is a new line: only the button, or the chord, sends', async () => {
    finePointer(false);
    const { field, onSubmit } = setup();
    type(field, 'hello');
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it('never sends on the Enter that confirms an input-method candidate', async () => {
    const { field, onSubmit } = setup();
    type(field, 'ni hao');
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true });
    // Safari: the composition is over, but the key still reports code 229.
    fireEvent.compositionEnd(field);
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 });
    // Other browsers: the composition ended a few milliseconds before the key arrived.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 120));
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  });

  it('has nothing to send while the field is empty or holds only spaces', () => {
    const { field, onSubmit } = setup();
    expect(sendButton()).toBeDisabled();
    type(field, '   ');
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('steps through permission modes on Shift+Tab', () => {
    const onCycleMode = vi.fn();
    const { field } = setup({ onCycleMode });
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(onCycleMode).toHaveBeenCalledTimes(1);
  });
});

describe('the double-send guard', () => {
  it('sends once however fast the button is pressed', async () => {
    let finish: (taken: boolean) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const { field } = setup({ onSubmit });
    type(field, 'ship it');
    fireEvent.click(sendButton());
    fireEvent.click(sendButton());
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    // Once the first one is settled, a new message can go.
    type(field, 'and another');
    fireEvent.click(sendButton());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });

  it('sends nothing while an earlier message is unsettled, but lets the user keep typing', () => {
    const { field, onSubmit } = setup({ blocked: true });
    type(field, 'next thought');
    expect(field.value).toBe('next thought');
    expect(sendButton()).toBeDisabled();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps what was written when the send is not taken', async () => {
    const { field } = setup({ onSubmit: vi.fn(async () => false) });
    type(field, 'still here');
    fireEvent.click(sendButton());
    await waitFor(() => expect(sendButton()).not.toBeDisabled());
    expect(field.value).toBe('still here');
  });
});

describe('while the agent is working', () => {
  it('offers Stop when the field is empty', () => {
    const { onStop } = setup({ busy: true });
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('queues by default, and offers steering only when the agent can take it', async () => {
    const { field, onSubmit, rerender } = setup({ busy: true, canSteer: false });
    type(field, 'also update the README');
    expect(screen.queryByRole('button', { name: /Queue/ })).toBeInTheDocument();
    // No choice to make when the agent cannot be steered: the one button queues.
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ text: 'also update the README', quote: null, whenBusy: 'queue' }));

    rerender({ busy: true, canSteer: true });
    fireEvent.click(screen.getAllByRole('button', { name: /Queue/ })[0]!);
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Steer/ }));
    // The chip names the choice; the round button next to it carries it out.
    fireEvent.click(screen.getAllByRole('button', { name: 'Steer' }).at(-1)!);
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({ text: 'also update the README', quote: null, whenBusy: 'steer' }));
  });

  it('shows that stopping is under way', () => {
    setup({ busy: true, stopping: true });
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });
});

describe('quotations', () => {
  it('sends the quote with the message and lets it be removed first', async () => {
    const onClearQuote = vi.fn();
    const { field, onSubmit } = setup({ quote: 'the passage', onClearQuote });
    expect(screen.getByText('the passage')).toBeInTheDocument();
    type(field, 'why?');
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ text: 'why?', quote: 'the passage', whenBusy: 'queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the quotation' }));
    expect(onClearQuote).toHaveBeenCalled();
  });
});

describe('drafts', () => {
  it('saves what is typed a moment after the last key press, once', async () => {
    vi.useFakeTimers();
    const { field } = setup();
    type(field, 'a');
    type(field, 'ab');
    type(field, 'abc');
    expect(api.saveDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(800);
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
    expect(api.saveDraft).toHaveBeenCalledWith(SESSION, 'abc', false);
    // Unchanged text is not saved again.
    type(field, 'abc');
    await vi.advanceTimersByTimeAsync(800);
    expect(api.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("restores the session's draft from the server, without overwriting what was typed while it loaded", async () => {
    api.draft.mockResolvedValueOnce({ sessionId: SESSION, text: 'from last time', updatedAt: 5 });
    const { field } = setup();
    await act(async () => loadDraft(SESSION));
    expect(field.value).toBe('from last time');

    __resetDraftsForTests();
    let answer: (draft: { sessionId: string; text: string; updatedAt: number }) => void = () => {};
    api.draft.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const loading = loadDraft(SESSION);
    act(() => setDraft(KEY, 'typed meanwhile'));
    await act(async () => {
      answer({ sessionId: SESSION, text: 'older', updatedAt: 6 });
      await loading;
    });
    expect(getDraft(KEY)).toBe('typed meanwhile');
  });

  it('takes a draft written on another device — unless this one has unsaved changes of its own', async () => {
    vi.useFakeTimers();
    setup();
    act(() => applyRemoteDraft(SESSION, 'from the phone'));
    expect(getDraft(KEY)).toBe('from the phone');

    act(() => setDraft(KEY, 'typing here'));
    act(() => applyRemoteDraft(SESSION, 'from the phone again'));
    expect(getDraft(KEY)).toBe('typing here');
    await vi.advanceTimersByTimeAsync(800);
    // Saved now; a later change from elsewhere is taken again.
    await vi.advanceTimersByTimeAsync(4000);
    act(() => applyRemoteDraft(SESSION, 'newer, from the phone'));
    expect(getDraft(KEY)).toBe('newer, from the phone');
  });

  it('drops an untouched draft when the server says the session has none (it went out from another device)', async () => {
    vi.useFakeTimers();
    setup();
    act(() => applyRemoteDraft(SESSION, 'half a thought'));
    act(() => noteDraftFlag(SESSION, false));
    expect(getDraft(KEY)).toBe('');
    // …but never text that is being typed here.
    act(() => setDraft(KEY, 'mine'));
    act(() => noteDraftFlag(SESSION, false));
    expect(getDraft(KEY)).toBe('mine');
  });

  it('keeps the draft of an unsent conversation on the device, and moves it with the conversation to another project', () => {
    const P = '01pppppppppppppppppppppppp';
    const Q = '01qqqqqqqqqqqqqqqqqqqqqqqq';
    setDraft(newChatDraftKey(P), 'hello');
    setDraft(newChatDraftKey(Q), 'old');
    expect(api.saveDraft).not.toHaveBeenCalled();

    expect(moveNewDraft(P, Q)).toBe(true);
    // Swapped, never overwritten.
    expect(getDraft(newChatDraftKey(Q))).toBe('hello');
    expect(getDraft(newChatDraftKey(P))).toBe('old');

    // Nothing moves when there is nothing to move, or nowhere to go.
    setDraft(newChatDraftKey(P), '   ');
    expect(moveNewDraft(P, Q)).toBe(false);
    expect(moveNewDraft(Q, Q)).toBe(false);
    expect(getDraft(newChatDraftKey(Q))).toBe('hello');

    // After a reload the device still has it.
    __resetDraftsForTests();
    restoreNewDraft(Q);
    expect(getDraft(newChatDraftKey(Q))).toBe('hello');
  });
});

describe('attachments', () => {
  const file = (name: string, bytes: number) => new File([new Uint8Array(bytes).fill(name.length)], name, { type: 'text/plain' });

  it('says in words which files were left out and why, and keeps the rest', async () => {
    const { field } = setup({ draftKey: NEW_KEY });
    const offered = [file('big.bin', 11 * 1024 * 1024), ...Array.from({ length: 11 }, (_, index) => file(`note-${index}.txt`, 10 + index))];
    fireEvent.paste(field, { clipboardData: { files: offered, getData: () => '' } });

    await waitFor(() => expect(attachmentsOf(NEW_KEY)).toHaveLength(10));
    expect(await screen.findByText('“big.bin” is larger than 10 MB and was not attached.')).toBeInTheDocument();
    expect(screen.getByText('A message can carry 10 files; 1 was left out.')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    // The files alone are something to send.
    expect(sendButton()).not.toBeDisabled();
  });

  it('attaches the same file once however often it arrives, and lets one be removed', async () => {
    const { field } = setup({ draftKey: NEW_KEY });
    const picture = file('screenshot.txt', 300);
    fireEvent.paste(field, { clipboardData: { files: [picture, file('screenshot.txt', 300)], getData: () => '' } });
    await waitFor(() => expect(attachmentsOf(NEW_KEY)).toHaveLength(1));
    fireEvent.paste(field, { clipboardData: { files: [file('screenshot.txt', 300)], getData: () => '' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attachmentsOf(NEW_KEY)).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Remove screenshot.txt' }));
    expect(attachmentsOf(NEW_KEY)).toHaveLength(0);
    expect(sendButton()).toBeDisabled();
  });

  it('uploads at once in a conversation that exists, shows progress, and blocks sending on a failed file', async () => {
    let report: (fraction: number) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    api.uploadAttachment.mockImplementationOnce(
      (_sessionId: string, _file: File, options: { onProgress?: (fraction: number) => void }) =>
        new Promise((_resolve, reject) => {
          report = options.onProgress ?? report;
          fail = reject;
        }),
    );
    const { field } = setup();
    fireEvent.paste(field, { clipboardData: { files: [file('report.txt', 500)], getData: () => '' } });
    await waitFor(() => expect(api.uploadAttachment).toHaveBeenCalledTimes(1));
    act(() => report(0.4));
    expect(screen.getByRole('progressbar', { name: 'Uploading report.txt' })).toHaveAttribute('aria-valuenow', '40');

    await act(async () => fail(new Error('boom')));
    expect(await screen.findByText(/“report.txt” was not uploaded/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('keeps a file for a conversation that does not exist yet, without pretending to upload it', async () => {
    const { field } = setup({ draftKey: NEW_KEY });
    fireEvent.paste(field, { clipboardData: { files: [file('plan.txt', 120)], getData: () => '' } });
    await waitFor(() => expect(attachmentsOf(NEW_KEY)).toHaveLength(1));
    // Nothing went to the server, nothing is drawn as in progress, and the message can be sent.
    expect(api.uploadAttachment).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveAttribute('data-status', 'held');
    expect(sendButton()).not.toBeDisabled();
    expect(sendButton().querySelector('.ui-spinner')).toBeNull();
  });

  it('puts pasted text in the field and attaches the picture that came with it', async () => {
    const { field } = setup({ draftKey: NEW_KEY });
    const event = fireEvent.paste(field, { clipboardData: { files: [file('shot.txt', 40)], getData: () => 'caption' } });
    // The browser's own paste of the text is left alone…
    expect(event).toBe(true);
    await waitFor(() => expect(attachmentsOf(NEW_KEY)).toHaveLength(1));
  });
});
