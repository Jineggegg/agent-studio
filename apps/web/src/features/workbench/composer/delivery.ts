import type { AttachmentRef } from '@agent-studio/protocol';
import { isApiError } from '@/data/api';

/**
 * What happens to a message between "the user pressed send" and "it is in the
 * transcript": a small state machine, pure, so that the one rule that matters
 * can be read off it and tested —
 *
 *   **a message is sent again only after the server has said it never got it.**
 *
 *  sending ──acknowledged──▶ accepted ──seen──▶ (done)
 *     │ refused                 ▲
 *     ▼                         │ found
 *   failed      lost ──▶ unconfirmed ──check──▶ checking
 *                            ▲  │ retry (only when verdict = not-received)
 *                            │  ▼
 *            not-found / check-failed        sending (same request id, same content)
 */
export type DeliveryPhase =
  /** The request is on its way. */
  | 'sending'
  /** The server acknowledged it; it has not shown up in the transcript or the queue yet. */
  | 'accepted'
  /** No acknowledgement arrived: it may or may not have been received. */
  | 'unconfirmed'
  /** Asking the server whether it holds a receipt for the request id. */
  | 'checking'
  /** The server refused it: nothing was sent, nothing was lost. */
  | 'failed';

/** What the last check said about an unconfirmed message. */
export type DeliveryVerdict =
  /** Not checked yet. */
  | 'unknown'
  /** The server is certain it never accepted this request id: sending it again is safe. */
  | 'not-received'
  /** The check itself could not be done: nothing may be re-sent. */
  | 'unverifiable';

export interface OutgoingPayload {
  requestId: string;
  text: string;
  attachmentIds: string[];
  quote: string | null;
  whenBusy: 'queue' | 'steer';
}

export interface Outgoing {
  sessionId: string;
  /** Exactly what was (or will be) submitted; a retry sends this, unchanged. */
  payload: OutgoingPayload;
  /** For drawing the message while it is on its way. */
  attachments: AttachmentRef[];
  createdAt: number;
  phase: DeliveryPhase;
  verdict: DeliveryVerdict;
  /** Whether it was meant to start a turn, wait in the queue or join the running turn. */
  expected: 'run' | 'queued' | 'steered';
  /** What the server did with it, once it said. */
  disposition: 'run' | 'queued' | 'steered' | null;
  /** Why it was refused: the server's code and its sentence. */
  refusal: { code: string; message: string } | null;
  attempts: number;
}

export type DeliveryEvent =
  | { type: 'acknowledged'; disposition: 'run' | 'queued' | 'steered' }
  /** The request failed without an answer: offline, a timeout, a server error. */
  | { type: 'lost' }
  | { type: 'refused'; code: string; message: string }
  | { type: 'check' }
  | { type: 'found'; disposition: 'run' | 'queued' | 'steered' }
  | { type: 'not-found' }
  | { type: 'check-failed' }
  | { type: 'retry' }
  /** It appeared in the transcript or in the queue. */
  | { type: 'seen' }
  | { type: 'dismiss' };

export function createOutgoing(sessionId: string, payload: OutgoingPayload, attachments: AttachmentRef[], expected: Outgoing['expected'], now: number): Outgoing {
  return { sessionId, payload, attachments, createdAt: now, phase: 'sending', verdict: 'unknown', expected, disposition: null, refusal: null, attempts: 1 };
}

/** The next state, or null when the message is done with (delivered and visible, or dismissed). */
export function deliver(outgoing: Outgoing, event: DeliveryEvent): Outgoing | null {
  switch (event.type) {
    case 'seen':
      // Proof of delivery, whatever we thought was going on.
      return outgoing.phase === 'failed' ? outgoing : null;
    case 'dismiss':
      return outgoing.phase === 'failed' ? null : outgoing;
    case 'acknowledged':
      return outgoing.phase === 'sending' || outgoing.phase === 'unconfirmed' || outgoing.phase === 'checking'
        ? { ...outgoing, phase: 'accepted', disposition: event.disposition, verdict: 'unknown' }
        : outgoing;
    case 'lost':
      return outgoing.phase === 'sending' ? { ...outgoing, phase: 'unconfirmed', verdict: 'unknown' } : outgoing;
    case 'refused':
      return outgoing.phase === 'sending' ? { ...outgoing, phase: 'failed', refusal: { code: event.code, message: event.message } } : outgoing;
    case 'check':
      return outgoing.phase === 'unconfirmed' ? { ...outgoing, phase: 'checking' } : outgoing;
    case 'found':
      return outgoing.phase === 'checking' || outgoing.phase === 'unconfirmed' ? { ...outgoing, phase: 'accepted', disposition: event.disposition, verdict: 'unknown' } : outgoing;
    case 'not-found':
      return outgoing.phase === 'checking' ? { ...outgoing, phase: 'unconfirmed', verdict: 'not-received' } : outgoing;
    case 'check-failed':
      return outgoing.phase === 'checking' ? { ...outgoing, phase: 'unconfirmed', verdict: 'unverifiable' } : outgoing;
    case 'retry':
      // Never a blind resend: only a negative answer from the server opens this door.
      return canRetry(outgoing) ? { ...outgoing, phase: 'sending', verdict: 'unknown', attempts: outgoing.attempts + 1 } : outgoing;
  }
}

/** The original may be submitted again: the server has said, since the last attempt, that it holds no receipt for it. */
export const canRetry = (outgoing: Outgoing): boolean => outgoing.phase === 'unconfirmed' && outgoing.verdict === 'not-received';

export const canCheck = (outgoing: Outgoing): boolean => outgoing.phase === 'unconfirmed';

/** While a message's fate is open, nothing else may be sent in that conversation — one draft can never run twice. */
export const blocksSending = (outgoing: Outgoing): boolean => outgoing.phase === 'sending' || outgoing.phase === 'unconfirmed' || outgoing.phase === 'checking';

/** What a failed send means: the server said no (nothing happened), or nobody knows. */
export function classifySendError(error: unknown): DeliveryEvent {
  if (!isApiError(error)) return { type: 'lost' };
  // The server is working on this very request right now: it did arrive.
  if (error.code === 'request_in_progress') return { type: 'lost' };
  if (error.status === 429) return { type: 'refused', code: error.code, message: error.message };
  if (error.status >= 400 && error.status < 500) return { type: 'refused', code: error.code, message: error.message };
  // No answer, a timeout, or a server that failed half-way: the message may have been recorded.
  return { type: 'lost' };
}

/** What a failed delivery check means. Only "no such receipt" is a negative answer. */
export function classifyCheckError(error: unknown): DeliveryEvent {
  if (isApiError(error) && error.status === 404 && error.code === 'receipt_not_found') return { type: 'not-found' };
  return { type: 'check-failed' };
}

let counter = 0;

/** A request id no other message of this user will ever have. */
export function newRequestId(): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  counter += 1;
  return `web-${Date.now().toString(36)}-${counter.toString(36)}-${random}`;
}
