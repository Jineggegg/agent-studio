import { CLOSE_CODES, type ClientFrame, serverFrameSchema } from '@agent-studio/protocol';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

/**
 * The live connection: one WebSocket per tab, shared by every feature.
 *
 *   const stop = realtime.subscribe(`session:${id}`, (event) => { … }, { after: lastSeq });
 *
 * What it guarantees:
 *  - it reconnects by itself, with back-off and jitter, for as long as the tab lives;
 *  - after a gap it asks each topic for what was missed (the last sequence
 *    number seen) and never delivers the same numbered event twice;
 *  - it stops for good when the server says the session is over (close code
 *    4401) and tells the app, which shows sign-in.
 *
 * Disconnection is normal on a phone. Nothing here treats it as an error.
 */

export type RealtimeStatus =
  /** Not started (signed out). */
  | 'idle'
  /** A socket is opening, or open but not yet greeted. */
  | 'connecting'
  /** Live. */
  | 'open'
  /** Disconnected; another attempt is scheduled. */
  | 'waiting'
  /** The session ended. No more attempts until `start()` is called again. */
  | 'ended';

export interface RealtimeEvent<T = unknown> {
  topic: string;
  type: string;
  data: T;
  /** Present on durable topics. Strictly increasing per topic. */
  seq: number | undefined;
  /** Server time of the event, ms since the epoch. */
  at: number;
}

export interface SubscribeOptions {
  /** The last sequence number you already have; the server replays what came after it. */
  after?: number;
  /** In-flight state handed over on every (re)subscription — a half-streamed message, for example. */
  onSnapshot?: (snapshot: unknown) => void;
  /** The server accepted the subscription. Called again after every reconnect. */
  onSubscribed?: (info: { replayed: number; resumed: boolean }) => void;
  /** The server refused: the topic does not exist or is not yours. */
  onRejected?: (code: string) => void;
}

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface RealtimeDeps {
  createSocket: (url: string) => SocketLike;
  url: () => string;
  /** The server closed the connection because the session ended. */
  onAuthEnded: () => void;
  random?: () => number;
  now?: () => number;
}

export interface RealtimeSnapshot {
  status: RealtimeStatus;
  /** True once this tab has been live at least once since `start()`. */
  everConnected: boolean;
  /** When the status last changed, ms since the epoch. */
  since: number;
}

interface Subscription {
  handler: (event: RealtimeEvent) => void;
  options: SubscribeOptions;
  /** Highest sequence number delivered to this subscriber. */
  lastSeq: number | undefined;
  /** A subscribe frame has gone out on this subscriber's behalf and is unanswered. */
  awaiting: boolean;
  resumed: boolean;
}

interface TopicState {
  subscriptions: Set<Subscription>;
  /** Highest sequence number seen on the wire. */
  maxSeq: number | undefined;
  /** Whether the server knows about this topic on the current socket. */
  joined: boolean;
}

const OPEN = 1;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
/**
 * The server allows a connection 60 frames per 30 s and closes it beyond
 * that. Staying under 45 in any rolling 30 s keeps us clear whatever the
 * phase of its counter.
 */
const SEND_WINDOW_MS = 30_000;
const SEND_LIMIT = 45;
/** Kept free for pings, which must never queue behind a burst of subscriptions: a late ping looks like a dead connection. */
const PING_RESERVE = 3;

export class RealtimeClient {
  readonly #deps: Required<Omit<RealtimeDeps, 'onAuthEnded'>> & Pick<RealtimeDeps, 'onAuthEnded'>;
  readonly #topics = new Map<string, TopicState>();
  readonly #stateListeners = new Set<(snapshot: RealtimeSnapshot) => void>();
  readonly #readyListeners = new Set<(info: { reconnected: boolean }) => void>();
  #socket: SocketLike | null = null;
  #snapshot: RealtimeSnapshot = { status: 'idle', everConnected: false, since: 0 };
  #started = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #pongTimer: ReturnType<typeof setTimeout> | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #outbox: ClientFrame[] = [];
  #sentAt: number[] = [];

  constructor(deps: RealtimeDeps) {
    this.#deps = {
      random: Math.random,
      now: Date.now,
      ...deps,
    };
  }

  // ---- public surface ------------------------------------------------------

  get state(): RealtimeSnapshot {
    return this.#snapshot;
  }

  /** Begin (or resume) connecting. Call when a session exists. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#attempt = 0;
    this.#connect();
  }

  /** Close and stay closed. Call on sign-out. */
  stop(): void {
    this.#started = false;
    this.#teardown();
    for (const topic of this.#topics.values()) topic.joined = false;
    this.#setStatus('idle', { everConnected: false });
  }

  /**
   * Listen to a topic. Returns the function that stops listening.
   * Safe to call before the connection is up: the subscription is sent as soon as it is.
   */
  subscribe<T = unknown>(topic: string, handler: (event: RealtimeEvent<T>) => void, options: SubscribeOptions = {}): () => void {
    let state = this.#topics.get(topic);
    if (!state) this.#topics.set(topic, (state = { subscriptions: new Set(), maxSeq: undefined, joined: false }));
    const subscription: Subscription = {
      handler: handler as (event: RealtimeEvent) => void,
      options,
      // Without `after`, "from now on": anything the topic has already carried is not owed to this subscriber.
      lastSeq: options.after ?? state.maxSeq,
      awaiting: false,
      resumed: false,
    };
    state.subscriptions.add(subscription);
    if (this.#snapshot.status === 'open') {
      subscription.awaiting = true;
      this.#enqueue({ op: 'subscribe', topic, ...(options.after === undefined ? {} : { after: options.after }) });
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#topics.get(topic);
      if (!current) return;
      current.subscriptions.delete(subscription);
      if (current.subscriptions.size > 0) return;
      this.#topics.delete(topic);
      if (current.joined && this.#snapshot.status === 'open') this.#enqueue({ op: 'unsubscribe', topic });
    };
  }

  /** Called on every greeting from the server; `reconnected` is false only for the first of a session. */
  onReady(listener: (info: { reconnected: boolean }) => void): () => void {
    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  onState(listener: (snapshot: RealtimeSnapshot) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * The page came back (visible again, network returned). Reconnect at once
   * instead of waiting out the back-off, and check that an apparently open
   * socket is really alive — phones drop them without saying so.
   */
  wake(): void {
    if (!this.#started) return;
    if (this.#snapshot.status === 'waiting') {
      this.#clearRetry();
      this.#connect();
    } else if (this.#snapshot.status === 'open') {
      this.#ping(4_000);
    }
  }

  // ---- connection ----------------------------------------------------------

  #connect(): void {
    if (!this.#started) return;
    this.#teardown();
    this.#setStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.#deps.createSocket(this.#deps.url());
    } catch {
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    socket.onmessage = (event) => {
      if (this.#socket === socket) this.#receive(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket === socket) this.#closed(event.code);
    };
    socket.onerror = () => {
      /* a close event always follows; that is where we react */
    };
    socket.onopen = () => {
      /* wait for the server's greeting before sending anything */
    };
  }

  #teardown(): void {
    this.#clearRetry();
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#pingTimer = this.#pongTimer = this.#flushTimer = null;
    this.#outbox = [];
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, 'client closing');
      } catch {
        /* already closed */
      }
    }
  }

  #closed(code: number): void {
    this.#teardown();
    for (const topic of this.#topics.values()) {
      topic.joined = false;
      for (const subscription of topic.subscriptions) subscription.awaiting = false;
    }
    if (!this.#started) return;

    if (code === CLOSE_CODES.authEnded) {
      this.#started = false;
      this.#setStatus('ended');
      this.#deps.onAuthEnded();
      return;
    }
    if (code === CLOSE_CODES.slowConsumer) {
      // We fell behind; the server wants us to come straight back and replay.
      this.#attempt = 0;
    } else if (code === CLOSE_CODES.protocol) {
      // Our own mistake. Coming back instantly would only repeat it.
      this.#attempt = Math.max(this.#attempt, 3);
    }
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    this.#setStatus('waiting');
    const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.#attempt, 10));
    // "Equal jitter": at least half the ceiling, so a fleet of tabs spreads out without anyone retrying instantly.
    const delay = ceiling / 2 + this.#deps.random() * (ceiling / 2);
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  // ---- frames in -------------------------------------------------------------

  #receive(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = serverFrameSchema.safeParse(parsed);
    if (!result.success) return;
    const frame = result.data;

    // Anything at all from the server proves the connection is alive.
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pongTimer = null;

    switch (frame.op) {
      case 'ready': {
        const reconnected = this.#snapshot.everConnected;
        this.#attempt = 0;
        this.#setStatus('open', { everConnected: true });
        this.#pingTimer = setInterval(() => this.#ping(PONG_TIMEOUT_MS), PING_INTERVAL_MS);
        for (const [topic, state] of this.#topics) {
          if (state.subscriptions.size === 0) continue;
          let after: number | undefined;
          for (const subscription of state.subscriptions) {
            subscription.awaiting = true;
            subscription.resumed = reconnected;
            if (subscription.lastSeq !== undefined) after = after === undefined ? subscription.lastSeq : Math.min(after, subscription.lastSeq);
          }
          this.#enqueue({ op: 'subscribe', topic, ...(after === undefined ? {} : { after }) });
        }
        for (const listener of [...this.#readyListeners]) listener({ reconnected });
        return;
      }
      case 'subscribed': {
        const state = this.#topics.get(frame.topic);
        if (!state) return;
        state.joined = true;
        for (const subscription of [...state.subscriptions]) {
          if (!subscription.awaiting) continue;
          subscription.awaiting = false;
          subscription.options.onSubscribed?.({ replayed: frame.replayed, resumed: subscription.resumed });
          if (frame.snapshot !== undefined) subscription.options.onSnapshot?.(frame.snapshot);
        }
        return;
      }
      case 'rejected': {
        const state = this.#topics.get(frame.topic);
        if (!state) return;
        for (const subscription of [...state.subscriptions]) {
          if (!subscription.awaiting) continue;
          subscription.awaiting = false;
          subscription.options.onRejected?.(frame.code);
        }
        return;
      }
      case 'event': {
        const state = this.#topics.get(frame.topic);
        if (!state) return;
        const seq = frame.seq;
        if (seq !== undefined && (state.maxSeq === undefined || seq > state.maxSeq)) state.maxSeq = seq;
        const event: RealtimeEvent = { topic: frame.topic, type: frame.type, data: frame.data, seq, at: frame.at };
        for (const subscription of [...state.subscriptions]) {
          if (seq !== undefined) {
            // A replay overlaps what was delivered live; each subscriber gets each number once.
            if (subscription.lastSeq !== undefined && seq <= subscription.lastSeq) continue;
            subscription.lastSeq = seq;
          }
          try {
            subscription.handler(event);
          } catch (error) {
            // One feature's bug must not stop delivery to the others.
            queueMicrotask(() => {
              throw error;
            });
          }
        }
        return;
      }
      case 'pong':
        return;
    }
  }

  // ---- frames out ----------------------------------------------------------

  #ping(timeoutMs: number): void {
    if (this.#snapshot.status !== 'open') return;
    // The deadline is armed before the ping leaves, so an answer can never arrive ahead of it.
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pongTimer = setTimeout(() => {
      this.#pongTimer = null;
      // Silence: the socket is dead even if it has not noticed. Treat it as closed.
      this.#closed(1006);
    }, timeoutMs);
    this.#outbox.unshift({ op: 'ping', t: this.#deps.now() });
    this.#flush();
  }

  #enqueue(frame: ClientFrame): void {
    this.#outbox.push(frame);
    this.#flush();
  }

  #flush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN || this.#snapshot.status !== 'open') return;
    const now = this.#deps.now();
    this.#sentAt = this.#sentAt.filter((time) => now - time < SEND_WINDOW_MS);

    while (this.#outbox.length > 0) {
      const frame = this.#outbox[0]!;
      // The world may have moved on while the frame waited its turn.
      if (frame.op === 'subscribe' && !this.#topics.get(frame.topic)?.subscriptions.size) {
        this.#outbox.shift();
        continue;
      }
      if (frame.op === 'unsubscribe' && this.#topics.get(frame.topic)?.subscriptions.size) {
        this.#outbox.shift();
        continue;
      }
      if (this.#sentAt.length >= (frame.op === 'ping' ? SEND_LIMIT : SEND_LIMIT - PING_RESERVE)) {
        const wait = SEND_WINDOW_MS - (now - this.#sentAt[0]!) + 5;
        this.#flushTimer = setTimeout(() => this.#flush(), wait);
        return;
      }
      this.#outbox.shift();
      this.#sentAt.push(now);
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        return; // the close event will follow
      }
    }
  }

  // ---- state ---------------------------------------------------------------

  #setStatus(status: RealtimeStatus, extra: Partial<RealtimeSnapshot> = {}): void {
    if (this.#snapshot.status === status && Object.keys(extra).length === 0) return;
    this.#snapshot = { ...this.#snapshot, ...extra, status, since: this.#deps.now() };
    for (const listener of [...this.#stateListeners]) listener(this.#snapshot);
  }
}

// ---- the app's instance ------------------------------------------------------

let authEndedHandler: () => void = () => {};

/** Wired once by `data/auth.ts`. */
export function setRealtimeAuthEndedHandler(handler: () => void): void {
  authEndedHandler = handler;
}

export const realtime = new RealtimeClient({
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  url: () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/realtime`,
  onAuthEnded: () => authEndedHandler(),
});

/** Connection state for components. */
export const useRealtimeState = create<RealtimeSnapshot>(() => realtime.state);
realtime.onState((snapshot) => useRealtimeState.setState(snapshot, true));

export const useRealtimeStatus = (): RealtimeStatus => useRealtimeState((state) => state.status);

/**
 * Subscribe a component to a topic for as long as it is mounted.
 * Pass `null` as the topic to stay unsubscribed (no id yet, signed out, …).
 */
export function useRealtimeTopic<T = unknown>(
  topic: string | null,
  handler: (event: RealtimeEvent<T>) => void,
  options: SubscribeOptions = {},
): void {
  const handlerRef = useRef(handler);
  const optionsRef = useRef(options);
  useEffect(() => {
    handlerRef.current = handler;
    optionsRef.current = options;
  });
  const after = options.after;
  useEffect(() => {
    if (topic === null) return;
    return realtime.subscribe<T>(topic, (event) => handlerRef.current(event), {
      ...(after === undefined ? {} : { after }),
      onSnapshot: (snapshot) => optionsRef.current.onSnapshot?.(snapshot),
      onSubscribed: (info) => optionsRef.current.onSubscribed?.(info),
      onRejected: (code) => optionsRef.current.onRejected?.(code),
    });
    // `after` is where to start; it is read once per subscription on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);
}

/** Run `handler` every time the live connection comes back after a gap — the moment to re-read live status. */
export function useOnReconnect(handler: () => void): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(
    () =>
      realtime.onReady(({ reconnected }) => {
        if (reconnected) ref.current();
      }),
    [],
  );
}
