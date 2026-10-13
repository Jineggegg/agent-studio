export interface StudioEvent<T = unknown> {
  /** Routing key, e.g. "session:abc" or "user:42". */
  readonly topic: string;
  /** What happened, e.g. "run.status". */
  readonly type: string;
  readonly data: T;
  /** Position in the topic's durable log, when the event is persisted and replayable. */
  readonly seq?: number;
  readonly at: number;
}

export type EventHandler = (event: StudioEvent) => void;

/**
 * In-process publish/subscribe. Modules announce what happened; other modules
 * (and the realtime hub, which forwards to browsers) react without the
 * publisher knowing who is listening.
 */
export class EventBus {
  readonly #handlers = new Set<{ match: (topic: string, type: string) => boolean; handler: EventHandler }>();
  #onError: (error: unknown, event: StudioEvent) => void = () => {};

  setErrorHandler(handler: (error: unknown, event: StudioEvent) => void): void {
    this.#onError = handler;
  }

  publish<T>(topic: string, type: string, data: T, seq?: number): StudioEvent<T> {
    const event: StudioEvent<T> = { topic, type, data, at: Date.now(), ...(seq === undefined ? {} : { seq }) };
    for (const entry of [...this.#handlers]) {
      if (!entry.match(topic, type)) continue;
      try {
        entry.handler(event);
      } catch (error) {
        this.#onError(error, event);
      }
    }
    return event;
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribeAll(handler: EventHandler): () => void {
    return this.#add(() => true, handler);
  }

  /** Subscribe to one event type, on any topic. */
  on(type: string, handler: EventHandler): () => void {
    return this.#add((_topic, eventType) => eventType === type, handler);
  }

  /** Subscribe to one exact topic. */
  onTopic(topic: string, handler: EventHandler): () => void {
    return this.#add((eventTopic) => eventTopic === topic, handler);
  }

  #add(match: (topic: string, type: string) => boolean, handler: EventHandler): () => void {
    const entry = { match, handler };
    this.#handlers.add(entry);
    return () => {
      this.#handlers.delete(entry);
    };
  }
}
