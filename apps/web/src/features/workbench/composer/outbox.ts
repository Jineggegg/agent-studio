import type { AttachmentRef, MessageReceipt } from '@agent-studio/protocol';
import { create } from 'zustand';
import { onSessionEnd } from '@/data/auth';
import { workbenchApi } from '../api';
import { type DeliveryEvent, type Outgoing, type OutgoingPayload, blocksSending, classifyCheckError, classifySendError, createOutgoing, deliver } from './delivery';

/**
 * Messages on their way: one list per session, driven by the delivery state
 * machine (`delivery.ts`). This module does the talking to the server; the
 * rules about what may happen when are the machine's.
 *
 * Messages whose fate is still open are mirrored in sessionStorage, so a
 * reload of the same tab shows them again — as unconfirmed, and checked at
 * once — instead of forgetting that something was sent.
 */
interface OutboxState {
  bySession: Record<string, Outgoing[]>;
}

export const useOutbox = create<OutboxState>(() => ({ bySession: {} }));

const STORAGE_KEY = 'studio.workbench.outbox';

function persist(): void {
  try {
    const open: Outgoing[] = [];
    for (const list of Object.values(useOutbox.getState().bySession)) for (const outgoing of list) if (blocksSending(outgoing)) open.push(outgoing);
    if (open.length === 0) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    /* private mode: the state lasts for this page only */
  }
}

function update(sessionId: string, change: (list: Outgoing[]) => Outgoing[]): void {
  useOutbox.setState((state) => {
    const before = state.bySession[sessionId] ?? [];
    const after = change(before);
    if (after === before) return state;
    const bySession = { ...state.bySession };
    if (after.length === 0) delete bySession[sessionId];
    else bySession[sessionId] = after;
    return { bySession };
  });
  persist();
}

export const outgoingOf = (sessionId: string): Outgoing[] => useOutbox.getState().bySession[sessionId] ?? [];

function find(sessionId: string, requestId: string): Outgoing | undefined {
  return outgoingOf(sessionId).find((entry) => entry.payload.requestId === requestId);
}

/** Feeds an event to one message's state machine. */
export function dispatch(sessionId: string, requestId: string, event: DeliveryEvent): Outgoing | null {
  let result: Outgoing | null = null;
  update(sessionId, (list) => {
    const index = list.findIndex((entry) => entry.payload.requestId === requestId);
    if (index === -1) return list;
    const next = deliver(list[index]!, event);
    result = next;
    if (next === list[index]) return list;
    const copy = [...list];
    if (next === null) copy.splice(index, 1);
    else copy[index] = next;
    return copy;
  });
  return result;
}

export interface SendHooks {
  /** The server answered: the message is recorded. */
  onReceipt?: (receipt: MessageReceipt) => void;
  /** The server said no: nothing was sent. */
  onRefused?: (outgoing: Outgoing) => void;
}

async function transmit(outgoing: Outgoing, hooks: SendHooks): Promise<void> {
  const { sessionId, payload } = outgoing;
  try {
    const receipt = await workbenchApi.send(sessionId, {
      requestId: payload.requestId,
      text: payload.text,
      attachmentIds: payload.attachmentIds,
      ...(payload.quote === null ? {} : { quote: payload.quote }),
      whenBusy: payload.whenBusy,
    });
    dispatch(sessionId, payload.requestId, { type: 'acknowledged', disposition: receipt.disposition });
    hooks.onReceipt?.(receipt);
  } catch (error) {
    const event = classifySendError(error);
    const next = dispatch(sessionId, payload.requestId, event);
    if (event.type === 'refused' && next) hooks.onRefused?.(next);
  }
}

/**
 * Sends a message. Returns false — and sends nothing — when another message
 * of this session is still unsettled: one draft can never run twice.
 */
export function sendMessage(
  sessionId: string,
  payload: OutgoingPayload,
  options: { attachments?: AttachmentRef[]; expected: Outgoing['expected']; now?: number } & SendHooks,
): boolean {
  if (outgoingOf(sessionId).some(blocksSending)) return false;
  const outgoing = createOutgoing(sessionId, payload, options.attachments ?? [], options.expected, options.now ?? Date.now());
  // A refusal that was on show has been answered by this new attempt: its notice does not linger beside it.
  update(sessionId, (list) => [...list.filter((entry) => entry.phase !== 'failed'), outgoing]);
  void transmit(outgoing, options);
  return true;
}

/** Asks the server whether it holds a receipt for the message. Never sends anything. */
export async function checkDelivery(sessionId: string, requestId: string, hooks: SendHooks = {}): Promise<Outgoing | null> {
  const before = find(sessionId, requestId);
  if (!before || before.phase !== 'unconfirmed') return before ?? null;
  dispatch(sessionId, requestId, { type: 'check' });
  try {
    const receipt = await workbenchApi.receipt(sessionId, requestId);
    const next = dispatch(sessionId, requestId, { type: 'found', disposition: receipt.disposition });
    hooks.onReceipt?.(receipt);
    return next;
  } catch (error) {
    return dispatch(sessionId, requestId, classifyCheckError(error));
  }
}

/**
 * "Retry the original": checks first, and submits the original request again
 * — the same request id, the same content — only when the server answered
 * that it never received it.
 */
export async function retryOriginal(sessionId: string, requestId: string, hooks: SendHooks = {}): Promise<Outgoing | null> {
  const checked = await checkDelivery(sessionId, requestId, hooks);
  if (!checked || checked.phase !== 'unconfirmed' || checked.verdict !== 'not-received') return checked;
  const retrying = dispatch(sessionId, requestId, { type: 'retry' });
  if (!retrying || retrying.phase !== 'sending') return retrying;
  await transmit(retrying, hooks);
  return find(sessionId, requestId) ?? null;
}

/** The message appeared in the transcript or in the queue: it is delivered. */
export function markSeen(sessionId: string, requestIds: Iterable<string>): void {
  const pending = outgoingOf(sessionId);
  if (pending.length === 0) return;
  const seen = requestIds instanceof Set ? (requestIds as Set<string>) : new Set(requestIds);
  for (const outgoing of pending) if (seen.has(outgoing.payload.requestId)) dispatch(sessionId, outgoing.payload.requestId, { type: 'seen' });
}

export const dismissFailed = (sessionId: string, requestId: string): void => void dispatch(sessionId, requestId, { type: 'dismiss' });

/**
 * After a reload: what was unsettled when the page went away is unsettled
 * still. Each such message comes back as unconfirmed and is checked at once.
 */
export function restoreOutbox(): void {
  let stored: unknown;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  if (!Array.isArray(stored)) return;
  const restored: Outgoing[] = [];
  for (const entry of stored as Partial<Outgoing>[]) {
    if (typeof entry?.sessionId !== 'string' || typeof entry.payload?.requestId !== 'string' || typeof entry.payload.text !== 'string') continue;
    if (find(entry.sessionId, entry.payload.requestId)) continue;
    restored.push({
      sessionId: entry.sessionId,
      payload: {
        requestId: entry.payload.requestId,
        text: entry.payload.text,
        attachmentIds: Array.isArray(entry.payload.attachmentIds) ? entry.payload.attachmentIds.filter((id): id is string => typeof id === 'string') : [],
        quote: typeof entry.payload.quote === 'string' ? entry.payload.quote : null,
        whenBusy: entry.payload.whenBusy === 'steer' ? 'steer' : 'queue',
      },
      attachments: Array.isArray(entry.attachments) ? entry.attachments : [],
      createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
      // Whatever it was doing, the page that was doing it is gone.
      phase: 'unconfirmed',
      verdict: 'unknown',
      expected: entry.expected === 'queued' || entry.expected === 'steered' ? entry.expected : 'run',
      disposition: null,
      refusal: null,
      attempts: typeof entry.attempts === 'number' ? entry.attempts : 1,
    });
  }
  for (const outgoing of restored) {
    update(outgoing.sessionId, (list) => [...list, outgoing]);
    void checkDelivery(outgoing.sessionId, outgoing.payload.requestId);
  }
}

function forgetAll(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  useOutbox.setState({ bySession: {} }, true);
}

if (typeof window !== 'undefined') onSessionEnd(forgetAll);

/** For tests. */
export function __resetOutboxForTests(): void {
  forgetAll();
}
