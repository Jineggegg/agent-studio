import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { newId } from './crypto.js';
import type { EventBus, StudioEvent } from './events.js';
import type { HttpKernel } from './http.js';
import type { Principal } from './principal.js';

export interface ReplayEvent {
  readonly seq: number;
  readonly type: string;
  readonly data: unknown;
  readonly at: number;
}

export interface TopicSpec {
  /** Topics are named `<kind>:<key>`; this is the kind, e.g. "session". */
  readonly kind: string;
  /** May this caller listen to this key? Called on every subscribe. */
  authorize(principal: Principal, key: string): boolean;
  /** Durable events after `afterSeq`, oldest first, for clients catching up after a gap. */
  replay?(key: string, afterSeq: number): ReplayEvent[];
  /** State handed to a new subscriber straight away (for example a half-streamed message). */
  snapshot?(key: string): unknown;
  /** The newest sequence number of a durable topic, so a fresh subscriber knows where "now" is. */
  head?(key: string): number;
}

const clientMessage = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), topic: z.string().min(3).max(200), after: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('unsubscribe'), topic: z.string().min(3).max(200) }),
  z.object({ op: z.literal('ping'), t: z.number().optional() }),
]);

const MAX_TOPICS_PER_CONNECTION = 200;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_MS = 30_000;
/** Frames a client may send per heartbeat interval; a screen full of lists subscribes to many topics at once. */
const MESSAGE_BUDGET = 400;
const MAX_CONNECTIONS_PER_USER = 24;
const MAX_CONNECTIONS = 512;
export const CLOSE_TOO_MANY = 4429;
export const CLOSE_AUTH_ENDED = 4401;
export const CLOSE_SLOW_CONSUMER = 4408;
export const CLOSE_PROTOCOL = 4400;

interface Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly principal: Principal;
  readonly topics: Set<string>;
  alive: boolean;
  budget: number;
}

/**
 * One WebSocket per browser tab carries every live update. Clients subscribe
 * to topics; each subscription is authorised individually, and durable topics
 * can be replayed from a sequence number so a phone that slept through part
 * of a run catches up exactly.
 */
export class RealtimeHub {
  readonly #topics = new Map<string, TopicSpec>();
  readonly #subscribers = new Map<string, Set<Connection>>();
  readonly #connections = new Set<Connection>();
  readonly #http: HttpKernel;
  readonly #log: FastifyBaseLogger;
  #timer: NodeJS.Timeout | null = null;

  constructor(http: HttpKernel, bus: EventBus, log: FastifyBaseLogger) {
    this.#http = http;
    this.#log = log;
    bus.subscribeAll((event) => this.#deliver(event));
    bus.on('auth.credential.revoked', (event) => {
      const { credentialId } = event.data as { credentialId: string };
      this.#closeWhere((connection) => connection.principal.credentialId === credentialId);
    });
    bus.on('auth.user.revoked', (event) => {
      const { userId } = event.data as { userId: string };
      this.#closeWhere((connection) => connection.principal.userId === userId);
    });
    this.registerTopic({ kind: 'user', authorize: (principal, key) => principal.userId === key });
    this.registerTopic({ kind: 'system', authorize: () => true });
  }

  registerTopic(spec: TopicSpec): void {
    if (this.#topics.has(spec.kind)) throw new Error(`Realtime topic kind "${spec.kind}" is already registered.`);
    this.#topics.set(spec.kind, spec);
  }

  /** Mounts the endpoint. Called once by the composition root. */
  mount(): void {
    this.#http.app.get(
      '/api/realtime',
      { websocket: true, config: { studio: { access: 'user', scope: 'read', sessionOnly: false, recentAuth: false } } },
      (socket, request) => {
        const principal = request.principal;
        if (!principal) {
          socket.close(CLOSE_AUTH_ENDED, 'unauthenticated');
          return;
        }
        this.#accept(socket, principal);
      },
    );
    this.#timer = setInterval(() => this.#heartbeat(), HEARTBEAT_MS);
    this.#timer.unref();
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  close(): void {
    if (this.#timer) clearInterval(this.#timer);
    for (const connection of this.#connections) connection.socket.close(1001, 'server shutting down');
    this.#connections.clear();
    this.#subscribers.clear();
  }

  #accept(socket: WebSocket, principal: Principal): void {
    let mine = 0;
    for (const other of this.#connections) if (other.principal.userId === principal.userId) mine += 1;
    if (mine >= MAX_CONNECTIONS_PER_USER || this.#connections.size >= MAX_CONNECTIONS) {
      socket.close(CLOSE_TOO_MANY, 'too many connections');
      return;
    }
    const connection: Connection = { id: newId(), socket, principal, topics: new Set(), alive: true, budget: MESSAGE_BUDGET };
    this.#connections.add(connection);
    this.#send(connection, { op: 'ready', connectionId: connection.id, serverTime: Date.now() });

    socket.on('pong', () => {
      connection.alive = true;
    });
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return socket.close(CLOSE_PROTOCOL, 'text frames only');
      connection.budget -= 1;
      if (connection.budget < 0) return socket.close(CLOSE_PROTOCOL, 'too many messages');
      let parsed: z.infer<typeof clientMessage>;
      try {
        parsed = clientMessage.parse(JSON.parse(String(raw)));
      } catch {
        return socket.close(CLOSE_PROTOCOL, 'malformed message');
      }
      if (parsed.op === 'ping') return this.#send(connection, { op: 'pong', t: parsed.t });
      if (parsed.op === 'unsubscribe') return this.#unsubscribe(connection, parsed.topic);
      return this.#subscribe(connection, parsed.topic, parsed.after);
    });
    const drop = () => {
      for (const topic of connection.topics) this.#subscribers.get(topic)?.delete(connection);
      connection.topics.clear();
      this.#connections.delete(connection);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  #subscribe(connection: Connection, topic: string, after: number | undefined): void {
    const separator = topic.indexOf(':');
    const kind = separator === -1 ? topic : topic.slice(0, separator);
    const key = separator === -1 ? '' : topic.slice(separator + 1);
    const spec = this.#topics.get(kind);
    let allowed = false;
    try {
      allowed = spec !== undefined && key.length > 0 && spec.authorize(connection.principal, key);
    } catch (error) {
      this.#log.warn({ err: error, topic }, 'topic authorisation failed');
    }
    // Unknown and forbidden topics are indistinguishable to the client.
    if (!spec || !allowed) return this.#send(connection, { op: 'rejected', topic, code: 'forbidden' });
    if (connection.topics.size >= MAX_TOPICS_PER_CONNECTION && !connection.topics.has(topic)) {
      return this.#send(connection, { op: 'rejected', topic, code: 'too_many_subscriptions' });
    }

    // Join first, then replay: an event published in between is delivered
    // twice at worst (clients drop duplicates by sequence number), never lost.
    connection.topics.add(topic);
    let set = this.#subscribers.get(topic);
    if (!set) this.#subscribers.set(topic, (set = new Set()));
    set.add(connection);

    const replayed = after !== undefined && spec.replay ? spec.replay(key, after) : [];
    this.#send(connection, {
      op: 'subscribed',
      topic,
      replayed: replayed.length,
      ...(spec.head ? { head: spec.head(key) } : {}),
      ...(spec.snapshot ? { snapshot: spec.snapshot(key) } : {}),
    });
    for (const event of replayed) {
      this.#send(connection, { op: 'event', topic, type: event.type, data: event.data, seq: event.seq, at: event.at });
    }
  }

  #unsubscribe(connection: Connection, topic: string): void {
    connection.topics.delete(topic);
    const set = this.#subscribers.get(topic);
    set?.delete(connection);
    if (set?.size === 0) this.#subscribers.delete(topic);
  }

  /**
   * Checks the subscriptions of the matching connections again and ends the
   * ones their topic no longer authorises. Call it when access changes while
   * clients are connected (a member is taken off a project, say): a
   * subscription is otherwise only checked when it is made. The client gets a
   * `rejected` frame for each topic it loses. Returns how many were ended.
   */
  reauthorize(match: (principal: Principal) => boolean): number {
    let ended = 0;
    for (const connection of this.#connections) {
      if (!match(connection.principal)) continue;
      for (const topic of [...connection.topics]) {
        const separator = topic.indexOf(':');
        const spec = this.#topics.get(separator === -1 ? topic : topic.slice(0, separator));
        let allowed = false;
        try {
          allowed = spec !== undefined && spec.authorize(connection.principal, topic.slice(separator + 1));
        } catch (error) {
          this.#log.warn({ err: error, topic }, 'topic authorisation failed');
        }
        if (allowed) continue;
        this.#unsubscribe(connection, topic);
        this.#send(connection, { op: 'rejected', topic, code: 'forbidden' });
        ended += 1;
      }
    }
    return ended;
  }

  #deliver(event: StudioEvent): void {
    const set = this.#subscribers.get(event.topic);
    if (!set || set.size === 0) return;
    const frame = JSON.stringify({
      op: 'event',
      topic: event.topic,
      type: event.type,
      data: event.data,
      at: event.at,
      ...(event.seq === undefined ? {} : { seq: event.seq }),
    });
    for (const connection of set) this.#sendRaw(connection, frame);
  }

  #send(connection: Connection, message: unknown): void {
    this.#sendRaw(connection, JSON.stringify(message));
  }

  #sendRaw(connection: Connection, frame: string): void {
    const socket = connection.socket;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // The client will reconnect and replay from its last sequence number.
      socket.close(CLOSE_SLOW_CONSUMER, 'falling behind');
      return;
    }
    socket.send(frame);
  }

  #heartbeat(): void {
    const authenticator = this.#http.authenticator;
    for (const connection of this.#connections) {
      connection.budget = MESSAGE_BUDGET;
      if (!authenticator.isCredentialLive(connection.principal)) {
        connection.socket.close(CLOSE_AUTH_ENDED, 'session ended');
        continue;
      }
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }

  #closeWhere(predicate: (connection: Connection) => boolean): void {
    for (const connection of this.#connections) {
      if (predicate(connection)) connection.socket.close(CLOSE_AUTH_ENDED, 'session ended');
    }
  }
}
