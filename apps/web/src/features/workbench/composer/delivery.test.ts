import { describe, expect, it } from 'vitest';
import { ApiError } from '@/data/api';
import { type DeliveryEvent, type Outgoing, blocksSending, canCheck, canRetry, classifyCheckError, classifySendError, createOutgoing, deliver, newRequestId } from './delivery';

const fresh = (): Outgoing => createOutgoing('01ssssssssssssssssssssssss', { requestId: 'req-1', text: 'ship it', attachmentIds: [], quote: null, whenBusy: 'queue' }, [], 'run', 1000);
const play = (events: DeliveryEvent[], start: Outgoing | null = fresh()): Outgoing | null => events.reduce<Outgoing | null>((state, event) => (state ? deliver(state, event) : null), start);

describe('delivering a message', () => {
  it('is done once the server acknowledged it and it showed up', () => {
    const accepted = play([{ type: 'acknowledged', disposition: 'run' }])!;
    expect(accepted).toMatchObject({ phase: 'accepted', disposition: 'run' });
    expect(blocksSending(accepted)).toBe(false);
    expect(deliver(accepted, { type: 'seen' })).toBeNull();
  });

  it('is done as soon as it shows up, even when the acknowledgement never arrived', () => {
    expect(play([{ type: 'seen' }])).toBeNull();
    expect(play([{ type: 'lost' }, { type: 'seen' }])).toBeNull();
    expect(play([{ type: 'lost' }, { type: 'check' }, { type: 'seen' }])).toBeNull();
  });

  it('becomes unconfirmed, and blocks further sending, when no acknowledgement arrives', () => {
    const lost = play([{ type: 'lost' }])!;
    expect(lost).toMatchObject({ phase: 'unconfirmed', verdict: 'unknown' });
    expect(blocksSending(lost)).toBe(true);
    expect(canCheck(lost)).toBe(true);
    expect(canRetry(lost)).toBe(false);
  });

  it('is confirmed by a positive check, with nothing sent again', () => {
    const found = play([{ type: 'lost' }, { type: 'check' }, { type: 'found', disposition: 'queued' }])!;
    expect(found).toMatchObject({ phase: 'accepted', disposition: 'queued', attempts: 1 });
  });

  it('may be retried only after the server said it never got it — with the same request', () => {
    const negative = play([{ type: 'lost' }, { type: 'check' }, { type: 'not-found' }])!;
    expect(negative).toMatchObject({ phase: 'unconfirmed', verdict: 'not-received' });
    expect(canRetry(negative)).toBe(true);
    const retried = deliver(negative, { type: 'retry' })!;
    expect(retried).toMatchObject({ phase: 'sending', attempts: 2, verdict: 'unknown' });
    expect(retried.payload).toBe(negative.payload);
  });

  it.each([
    ['it was never checked', [{ type: 'lost' }]],
    ['the check could not be done', [{ type: 'lost' }, { type: 'check' }, { type: 'check-failed' }]],
    ['the check is still running', [{ type: 'lost' }, { type: 'check' }]],
    ['it is still being sent', []],
    ['it was acknowledged', [{ type: 'acknowledged', disposition: 'run' }]],
    ['it was refused', [{ type: 'refused', code: 'queue_full', message: 'Full.' }]],
  ] as [string, DeliveryEvent[]][])('refuses a retry when %s', (_name, events) => {
    const before = play(events)!;
    expect(canRetry(before)).toBe(false);
    const after = deliver(before, { type: 'retry' })!;
    expect(after).toBe(before);
    expect(after.attempts).toBe(1);
  });

  it('needs a fresh negative answer for every retry', () => {
    const second = play([{ type: 'lost' }, { type: 'check' }, { type: 'not-found' }, { type: 'retry' }, { type: 'lost' }])!;
    expect(second).toMatchObject({ phase: 'unconfirmed', verdict: 'unknown', attempts: 2 });
    expect(canRetry(second)).toBe(false);
  });

  it('says when delivery could not be verified', () => {
    expect(play([{ type: 'lost' }, { type: 'check' }, { type: 'check-failed' }])).toMatchObject({ phase: 'unconfirmed', verdict: 'unverifiable' });
  });

  it('keeps a refused message until it is dismissed, and never calls it delivered', () => {
    const refused = play([{ type: 'refused', code: 'queue_full', message: 'The queue is full.' }])!;
    expect(refused).toMatchObject({ phase: 'failed', refusal: { code: 'queue_full' } });
    expect(blocksSending(refused)).toBe(false);
    expect(deliver(refused, { type: 'seen' })).toBe(refused);
    expect(deliver(refused, { type: 'dismiss' })).toBeNull();
  });

  it('ignores events that do not belong to its state', () => {
    const accepted = play([{ type: 'acknowledged', disposition: 'run' }])!;
    for (const event of [{ type: 'lost' }, { type: 'refused', code: 'x', message: 'y' }, { type: 'check' }, { type: 'not-found' }, { type: 'dismiss' }] as DeliveryEvent[]) {
      expect(deliver(accepted, event)).toBe(accepted);
    }
  });
});

describe('reading a failed request', () => {
  it.each([
    ['no network', new ApiError(0, 'network_error', 'x'), 'lost'],
    ['a timeout', new ApiError(0, 'timeout', 'x'), 'lost'],
    ['a server error', new ApiError(502, 'server_error', 'x'), 'lost'],
    ['the same request still being processed', new ApiError(409, 'request_in_progress', 'x'), 'lost'],
    ['something that is not an API error', new Error('boom'), 'lost'],
    ['a full queue', new ApiError(409, 'queue_full', 'x'), 'refused'],
    ['a session that is gone', new ApiError(404, 'session_not_found', 'x'), 'refused'],
    ['too many requests', new ApiError(429, 'rate_limited', 'x'), 'refused'],
    ['an invalid message', new ApiError(400, 'invalid_request', 'x'), 'refused'],
  ])('treats %s as %s', (_name, error, expected) => {
    expect(classifySendError(error).type).toBe(expected);
  });

  it('takes only "no such receipt" as a negative answer to a check', () => {
    expect(classifyCheckError(new ApiError(404, 'receipt_not_found', 'x')).type).toBe('not-found');
    // An older server without the route, a session that is gone, no network: none of these prove anything.
    expect(classifyCheckError(new ApiError(404, 'not_found', 'x')).type).toBe('check-failed');
    expect(classifyCheckError(new ApiError(404, 'session_not_found', 'x')).type).toBe('check-failed');
    expect(classifyCheckError(new ApiError(0, 'network_error', 'x')).type).toBe('check-failed');
    expect(classifyCheckError(new ApiError(500, 'server_error', 'x')).type).toBe('check-failed');
  });
});

describe('request ids', () => {
  it('are unique and within the length the server accepts', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRequestId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(200);
  });
});
