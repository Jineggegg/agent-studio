import { LIVE_EVENT, type LiveSessionEvent, type Session, type SessionEvent, liveSessionEventSchema, sessionEventSchema, sessionSnapshotSchema, sessionTopic } from '@agent-studio/protocol';
import { useEffect, useSyncExternalStore } from 'react';
import { isApiError } from '@/data/api';
import { onSessionEnd } from '@/data/auth';
import { type RealtimeEvent, realtime } from '@/data/realtime';
import { workbenchApi } from '../api';
import { markSeen } from '../composer/outbox';
import type { TranscriptState } from './model';
import { applyEvents, applyLive, applyPage, applySnapshot, applyUsage, initialTranscript, missingRange } from './reducer';

/**
 * One session, live: its transcript state, kept current for as long as
 * something on screen is looking at it.
 *
 * Opening reads the newest page of the log over HTTP and then subscribes to
 * the session's topic *from the last sequence number it holds*, so whatever
 * happened in between is replayed and nothing can fall into the crack. From
 * then on the realtime store looks after reconnection; this class only has to
 * apply what arrives — the reducer drops duplicates — and to fetch what a
 * replay could not bring (a gap longer than the replay window).
 *
 * Deltas arrive many times a second. They are applied at once but listeners
 * are told at most once per frame, so a fast stream costs one render per
 * frame however fast it is.
 */
export const NEWEST_PAGE = 200;
export const OLDER_PAGE = 400;
const GAP_PAGE = 1000;
/** A closed channel is kept this long: going back to a conversation just left is instant. */
const LINGER_MS = 60_000;

export type ChannelStatus =
  /** The first page is being read. */
  | 'loading'
  | 'ready'
  /** The first read failed; `error` says why. Retrying may help. */
  | 'error'
  /** The session does not exist (any more), or is not this user's to see. */
  | 'gone';

export interface ChannelState {
  status: ChannelStatus;
  error: unknown;
  transcript: TranscriptState;
  loadingOlder: boolean;
  /** Why the last attempt to read older history failed, if it did. */
  olderError: unknown;
  /** The server has more than is held here and it is being fetched. */
  catchingUp: boolean;
}

type Listener = () => void;

/** Told whenever a session's own topic announces that the session changed (its title, its mode, its mark). */
const sessionListeners = new Set<(session: Session) => void>();

export function onSessionAnnounced(listener: (session: Session) => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

const schedule: (callback: () => void) => void =
  typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? (callback) => {
        // A hidden page gets no frames; a timer still does, so state is current the moment the page returns.
        let done = false;
        const run = () => {
          if (done) return;
          done = true;
          callback();
        };
        window.requestAnimationFrame(run);
        window.setTimeout(run, 120);
      }
    : (callback) => void setTimeout(callback, 16);

export class SessionChannel {
  readonly sessionId: string;
  #state: ChannelState;
  readonly #listeners = new Set<Listener>();
  /** What has arrived since the last frame, in order of arrival. */
  #inbox: Array<{ durable: SessionEvent } | { live: LiveSessionEvent }> = [];
  #unsubscribe: (() => void) | null = null;
  #retainers = 0;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #notifyPending = false;
  #opening: Promise<void> | null = null;
  #filling = false;
  #resyncing = false;
  #usageTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(sessionId: string, options: { empty?: boolean } = {}) {
    this.sessionId = sessionId;
    this.#state = {
      status: options.empty ? 'ready' : 'loading',
      error: null,
      transcript: initialTranscript(sessionId),
      loadingOlder: false,
      olderError: null,
      catchingUp: false,
    };
  }

  // ---- for React -------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getState = (): ChannelState => this.#state;

  #emit(): void {
    this.#notifyPending = false;
    for (const listener of [...this.#listeners]) listener();
  }

  #set(patch: Partial<ChannelState>, immediate = false): void {
    this.#state = { ...this.#state, ...patch };
    if (immediate) {
      this.#emit();
      return;
    }
    this.#soon();
  }

  /** One notification per frame at most, however much arrives. */
  #soon(): void {
    if (this.#notifyPending) return;
    this.#notifyPending = true;
    schedule(() => {
      if (!this.#notifyPending || this.#disposed) return;
      this.#drain();
      this.#emit();
    });
  }

  /** Applies everything that has arrived, in order; a run of durable events goes through the reducer as one batch. */
  #drain(): void {
    if (this.#inbox.length === 0) return;
    const inbox = this.#inbox;
    this.#inbox = [];
    let transcript = this.#state.transcript;
    let batch: SessionEvent[] = [];
    for (const entry of inbox) {
      if ('durable' in entry) {
        batch.push(entry.durable);
        continue;
      }
      if (batch.length > 0) {
        transcript = applyEvents(transcript, batch);
        batch = [];
      }
      transcript = applyLive(transcript, entry.live);
    }
    if (batch.length > 0) transcript = applyEvents(transcript, batch);
    this.#adopt(transcript);
  }

  /** Takes a new transcript state without telling anyone yet, and does what follows from it. */
  #adopt(next: TranscriptState): void {
    const before = this.#state.transcript;
    if (next === before) return;
    this.#state = { ...this.#state, transcript: next };
    // A message of ours that shows up in the log or the queue is delivered, whatever its request thought.
    if (next.requestIds !== before.requestIds) markSeen(this.sessionId, next.requestIds);
    if (next.queue !== before.queue && next.queue.length > 0) markSeen(this.sessionId, next.queue.map((item) => item.requestId));
    if (next.gap && !this.#filling) void this.#fill();
  }

  /** The transcript as it is with everything received so far applied. */
  #current(): TranscriptState {
    this.#drain();
    return this.#state.transcript;
  }

  #transcript(next: TranscriptState, immediate = false): void {
    if (next === this.#state.transcript) return;
    this.#adopt(next);
    if (immediate) this.#emit();
    else this.#soon();
  }

  // ---- lifetime --------------------------------------------------------------

  retain(): void {
    this.#retainers += 1;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
    if (!this.#unsubscribe && !this.#opening) void this.open();
  }

  release(): void {
    this.#retainers = Math.max(0, this.#retainers - 1);
    if (this.#retainers > 0 || this.#closeTimer) return;
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = null;
      if (this.#retainers === 0) this.dispose();
    }, LINGER_MS);
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    if (this.#usageTimer) clearTimeout(this.#usageTimer);
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    channels.delete(this.sessionId);
  }

  /** Reads the newest page (unless something is held already) and starts listening. Safe to call again after a failure. */
  open(): Promise<void> {
    if (this.#opening) return this.#opening;
    this.#opening = this.#open().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #open(): Promise<void> {
    if (this.#disposed) return;
    const fresh = this.#state.status !== 'ready';
    if (fresh) {
      this.#set({ status: 'loading', error: null }, true);
      try {
        const page = await workbenchApi.events(this.sessionId, { limit: NEWEST_PAGE });
        if (this.#disposed) return;
        this.#adopt(applyPage(this.#current(), page, 'older'));
        this.#set({ status: 'ready', error: null }, true);
      } catch (error) {
        if (this.#disposed) return;
        this.#set({ status: isApiError(error) && (error.gone || error.status === 403) ? 'gone' : 'error', error }, true);
        return;
      }
    }
    this.#listen();
    // The snapshot over HTTP as well: approvals and the queue show even while the live connection is down.
    void this.#readSnapshot();
    void this.#readUsage();
  }

  #listen(): void {
    if (this.#unsubscribe || this.#disposed) return;
    this.#unsubscribe = realtime.subscribe(sessionTopic(this.sessionId), (event) => this.#receive(event), {
      after: this.#current().lastSeq,
      onSnapshot: (raw) => {
        const snapshot = sessionSnapshotSchema.safeParse(raw);
        if (!snapshot.success) return;
        // The replay follows this frame. If it starts later than the event after the last one held, the hole
        // shows up in the reducer as a gap and is read over HTTP.
        this.#transcript(applySnapshot(this.#current(), snapshot.data, 'replace'));
      },
      onRejected: () => {
        // Not ours any more (removed, or access withdrawn). What is on screen stays readable; nothing new will come.
        if (this.#state.status !== 'ready') this.#set({ status: 'gone' }, true);
      },
    });
  }

  #receive(event: RealtimeEvent): void {
    if (event.seq !== undefined) {
      const durable = sessionEventSchema.safeParse({ seq: event.seq, type: event.type, data: event.data, at: event.at });
      if (!durable.success) return;
      this.#inbox.push({ durable: durable.data });
      this.#soon();
      if (durable.data.type === 'usage.reported') this.#usageSoon();
      if (durable.data.type === 'run.finished' && (durable.data.data.status === 'failed' || durable.data.data.status === 'interrupted')) this.#snapshotSoon();
      return;
    }
    const live = liveSessionEventSchema.safeParse({ type: event.type, data: event.data });
    if (!live.success) return;
    if (live.data.type === LIVE_EVENT.sessionUpdated) {
      const session = live.data.data.session;
      for (const listener of [...sessionListeners]) listener(session);
      // A recovery card closes when the run it is about was continued or dismissed — possibly on another device.
      if (this.#current().unresolvedRuns.length > 0) this.#snapshotSoon();
      return;
    }
    this.#inbox.push({ live: live.data });
    this.#soon();
  }

  // ---- catching up -----------------------------------------------------------

  async #readSnapshot(): Promise<void> {
    try {
      const snapshot = await workbenchApi.state(this.sessionId);
      if (this.#disposed) return;
      this.#transcript(applySnapshot(this.#current(), snapshot, 'merge'), true);
      if (missingRange(this.#state.transcript, snapshot.lastSeq)) void this.#fill(snapshot.lastSeq);
    } catch {
      /* the live connection brings the same thing; and the next resync tries again */
    }
  }

  #snapshotSoon(): void {
    if (this.#snapshotTimer) return;
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = null;
      void this.#readSnapshot();
    }, 200);
  }

  async #readUsage(): Promise<void> {
    try {
      const usage = await workbenchApi.usage(this.sessionId);
      if (!this.#disposed) this.#transcript(applyUsage(this.#current(), usage));
    } catch {
      /* the ring simply shows what the events said */
    }
  }

  #usageSoon(): void {
    if (this.#usageTimer) return;
    this.#usageTimer = setTimeout(() => {
      this.#usageTimer = null;
      void this.#readUsage();
    }, 1200);
  }

  /** Fetches the durable events that are missing — a hole in the middle, or everything after what is held. */
  async #fill(serverLastSeq = 0): Promise<void> {
    if (this.#filling || this.#disposed) return;
    this.#filling = true;
    this.#set({ catchingUp: true });
    try {
      for (let round = 0; round < 50; round += 1) {
        const missing = missingRange(this.#current(), serverLastSeq);
        if (!missing) break;
        const page = await workbenchApi.events(this.sessionId, { after: missing.after, limit: GAP_PAGE });
        if (this.#disposed) return;
        serverLastSeq = Math.max(serverLastSeq, page.lastSeq);
        const before = this.#current();
        this.#transcript(applyPage(before, page, 'newer'), true);
        // Nothing new came back: stop rather than ask the same question for ever.
        if (this.#state.transcript === before) break;
      }
    } catch {
      /* still behind; the next reconnect or return to the page tries again */
    } finally {
      this.#filling = false;
      this.#set({ catchingUp: false });
    }
  }

  /**
   * Makes sure nothing was missed: asks the server where the session is and
   * reads whatever is not held. For the moments a socket may have died
   * without saying so — the page returning from the background, the network
   * coming back.
   */
  async resync(): Promise<void> {
    if (this.#resyncing || this.#disposed) return;
    if (this.#state.status !== 'ready') {
      if (this.#state.status === 'error') await this.open();
      return;
    }
    this.#resyncing = true;
    try {
      await this.#readSnapshot();
    } finally {
      this.#resyncing = false;
    }
  }

  // ---- history ---------------------------------------------------------------

  async loadOlder(): Promise<void> {
    const { loadingOlder, status } = this.#state;
    const transcript = this.#current();
    if (status !== 'ready' || loadingOlder || !transcript.hasOlder || transcript.firstSeq <= 1) return;
    this.#set({ loadingOlder: true, olderError: null }, true);
    try {
      const page = await workbenchApi.events(this.sessionId, { before: transcript.firstSeq, limit: OLDER_PAGE });
      if (this.#disposed) return;
      this.#adopt(applyPage(this.#current(), page, 'older'));
      this.#set({ loadingOlder: false }, true);
    } catch (error) {
      if (!this.#disposed) this.#set({ loadingOlder: false, olderError: error }, true);
    }
  }

  /** Reads history back until the event with `seq` is held (for jumping to a search hit). False when it cannot be reached. */
  async loadBackTo(seq: number): Promise<boolean> {
    for (let round = 0; round < 60; round += 1) {
      const { transcript, status } = this.#state;
      if (status !== 'ready') return false;
      if (transcript.firstSeq !== 0 && transcript.firstSeq <= seq) return true;
      if (!transcript.hasOlder) return transcript.firstSeq <= seq;
      await this.loadOlder();
      if (this.#state.olderError) return false;
    }
    return false;
  }
}

// ---- the open channels -------------------------------------------------------------

const channels = new Map<string, SessionChannel>();

export function channelFor(sessionId: string): SessionChannel {
  let channel = channels.get(sessionId);
  if (!channel) channels.set(sessionId, (channel = new SessionChannel(sessionId)));
  return channel;
}

/** A session that was created a moment ago has no history to read: open it empty, already listening from the start. */
export function seedEmptyChannel(sessionId: string): SessionChannel {
  let channel = channels.get(sessionId);
  if (!channel) channels.set(sessionId, (channel = new SessionChannel(sessionId, { empty: true })));
  return channel;
}

const NO_STATE: ChannelState = {
  status: 'ready',
  error: null,
  transcript: initialTranscript(''),
  loadingOlder: false,
  olderError: null,
  catchingUp: false,
};
const subscribeNothing = (): (() => void) => () => {};
const getNothing = (): ChannelState => NO_STATE;

/** The live state of a session for as long as the component is mounted. With `null`: an empty, idle state. */
export function useChannel(sessionId: string | null): { channel: SessionChannel | null; state: ChannelState } {
  const channel = sessionId === null ? null : channelFor(sessionId);
  useEffect(() => {
    if (!channel) return;
    channel.retain();
    return () => channel.release();
  }, [channel]);
  const state = useSyncExternalStore(channel ? channel.subscribe : subscribeNothing, channel ? channel.getState : getNothing, channel ? channel.getState : getNothing);
  return { channel, state };
}

/** Every open channel checks that it missed nothing. Called when the page returns and when the connection does. */
export function resyncOpenChannels(): void {
  for (const channel of channels.values()) void channel.resync();
}

function forgetAll(): void {
  for (const channel of [...channels.values()]) channel.dispose();
  channels.clear();
}

if (typeof window !== 'undefined') {
  onSessionEnd(forgetAll);
  let lastResync = 0;
  const onReturn = () => {
    if (document.visibilityState === 'hidden') return;
    const now = Date.now();
    if (now - lastResync < 3_000) return;
    lastResync = now;
    resyncOpenChannels();
  };
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('online', onReturn);
  realtime.onReady(({ reconnected }) => {
    if (reconnected) resyncOpenChannels();
  });
}

/** For tests. */
export function __resetChannelsForTests(): void {
  forgetAll();
}
