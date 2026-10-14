import type { MessageReceipt } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data/api';
import type { OutgoingPayload } from './delivery';
import { checkDelivery, dismissFailed, markSeen, outgoingOf, restoreOutbox, retryOriginal, sendMessage, useOutbox } from './outbox';

const send = vi.fn();
const receipt = vi.fn();
vi.mock('../api', () => ({
  workbenchApi: { send: (...args: unknown[]) => send(...args) as unknown, receipt: (...args: unknown[]) => receipt(...args) as unknown },
  SEND_TIMEOUT_MS: 20_000,
}));

const S = '01ssssssssssssssssssssssss';
const payload = (requestId: string, text = 'ship it'): OutgoingPayload => ({ requestId, text, attachmentIds: [], quote: null, whenBusy: 'queue' });
const accepted = (requestId: string): MessageReceipt => ({ requestId, sessionId: S, disposition: 'run', runId: null, queueItemId: null, duplicate: false, run: null, acceptedAt: 1 });
const noAnswer = () => new ApiError(0, 'network_error', 'No answer.');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const phase = () => outgoingOf(S).map((entry) => `${entry.payload.requestId}:${entry.phase}${entry.phase === 'unconfirmed' ? `/${entry.verdict}` : ''}`);

beforeEach(() => {
  send.mockReset();
  receipt.mockReset();
  useOutbox.setState({ bySession: {} });
  window.sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('the outbox', () => {
  it('sends once, and is done when the message shows up', async () => {
    send.mockResolvedValue(accepted('a'));
    expect(sendMessage(S, payload('a'), { expected: 'run' })).toBe(true);
    expect(phase()).toEqual(['a:sending']);
    await settle();
    expect(phase()).toEqual(['a:accepted']);
    markSeen(S, ['a']);
    expect(phase()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send a second message while the first is unsettled', async () => {
    send.mockRejectedValue(noAnswer());
    sendMessage(S, payload('a'), { expected: 'run' });
    expect(sendMessage(S, payload('b'), { expected: 'run' })).toBe(false);
    await settle();
    expect(phase()).toEqual(['a:unconfirmed/unknown']);
    expect(sendMessage(S, payload('b'), { expected: 'run' })).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a check that finds the receipt settles it without sending anything again', async () => {
    send.mockRejectedValue(noAnswer());
    sendMessage(S, payload('a'), { expected: 'run' });
    await settle();
    receipt.mockResolvedValue(accepted('a'));
    await checkDelivery(S, 'a');
    expect(phase()).toEqual(['a:accepted']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('"retry the original" asks first, and sends the same request only after the server said it never arrived', async () => {
    send.mockRejectedValueOnce(noAnswer());
    sendMessage(S, payload('a', 'the original'), { expected: 'run' });
    await settle();

    // The check itself fails: nothing is known, so nothing is sent.
    receipt.mockRejectedValueOnce(noAnswer());
    await retryOriginal(S, 'a');
    expect(phase()).toEqual(['a:unconfirmed/unverifiable']);
    expect(send).toHaveBeenCalledTimes(1);

    // The server holds a receipt after all: still nothing is sent.
    receipt.mockResolvedValueOnce(accepted('a'));
    await retryOriginal(S, 'a');
    expect(phase()).toEqual(['a:accepted']);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('…and does send it, once, with the same id and words, after a negative answer', async () => {
    send.mockRejectedValueOnce(noAnswer());
    sendMessage(S, payload('a', 'the original'), { expected: 'run' });
    await settle();
    receipt.mockRejectedValueOnce(new ApiError(404, 'receipt_not_found', 'No such receipt.'));
    send.mockResolvedValueOnce(accepted('a'));
    await retryOriginal(S, 'a');
    expect(phase()).toEqual(['a:accepted']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    expect(send.mock.calls[1]![1]).toMatchObject({ requestId: 'a', text: 'the original' });
  });

  it('a refusal blocks nothing, tells the caller, and gives way to the next attempt', async () => {
    send.mockRejectedValueOnce(new ApiError(409, 'queue_full', 'The queue is full.'));
    const onRefused = vi.fn();
    sendMessage(S, payload('a'), { expected: 'queued', onRefused });
    await settle();
    expect(phase()).toEqual(['a:failed']);
    expect(onRefused).toHaveBeenCalledTimes(1);

    send.mockResolvedValueOnce(accepted('b'));
    expect(sendMessage(S, payload('b'), { expected: 'run' })).toBe(true);
    // The refused one is not left on show beside the message that replaced it.
    expect(phase()).toEqual(['b:sending']);
    await settle();
    expect(phase()).toEqual(['b:accepted']);
  });

  it('a refusal can also simply be dismissed', async () => {
    send.mockRejectedValueOnce(new ApiError(422, 'validation_failed', 'No.'));
    sendMessage(S, payload('a'), { expected: 'run' });
    await settle();
    dismissFailed(S, 'a');
    expect(phase()).toEqual([]);
  });

  it('remembers an unsettled message across a reload of the tab, and checks it at once', async () => {
    send.mockReturnValue(new Promise(() => undefined));
    sendMessage(S, payload('a', 'sent just before the reload'), { expected: 'run' });
    const stored = window.sessionStorage.getItem('studio.workbench.outbox');
    expect(stored).toContain('sent just before the reload');

    // The reload: the page's memory is gone, the tab's storage is not.
    useOutbox.setState({ bySession: {} });
    receipt.mockRejectedValue(new ApiError(404, 'receipt_not_found', 'No such receipt.'));
    restoreOutbox();
    expect(phase()).toEqual(['a:checking']);
    await settle();
    expect(phase()).toEqual(['a:unconfirmed/not-received']);
    // Restoring twice does not double it.
    restoreOutbox();
    expect(outgoingOf(S)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a settled outbox leaves nothing behind in the tab', async () => {
    send.mockResolvedValue(accepted('a'));
    sendMessage(S, payload('a'), { expected: 'run' });
    await settle();
    expect(window.sessionStorage.getItem('studio.workbench.outbox')).toBeNull();
  });
});
