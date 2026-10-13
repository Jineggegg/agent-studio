import { INBOX_EVENT, NOTIFICATION_LIMITS, type PushDeliveryOutcome, type PushDevice, type PushSubscribeRequest, type PushTestResult, userTopic } from '@agent-studio/protocol';
import { newId } from '../../kernel/crypto.js';
import { conflict, describeError, notFound, rateLimited } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { NetPolicy } from '../../kernel/net.js';
import type { Principal } from '../../kernel/principal.js';
import { type NotificationContent, type PushDelivery, buildPushPayload, pushDelivery, testContent } from './content.js';
import { type DeviceRow, DeviceStore, deviceLabel, endpointHash, presentDevice } from './devices.js';
import { SlidingRate } from './limits.js';
import type { NotificationSwitches } from './preferences.js';
import { type PushMessage, type PushSubscription, type VapidKeys, generateVapidKeys, pushTopic, sendPush, validateSubscription } from './webpush.js';

export interface PushOptions {
  /** Push services that may be contacted. Leave out for the real ones. */
  readonly allowedHosts?: readonly string[];
  /** Tests only: reach a stand-in push service on this machine. */
  readonly policy?: NetPolicy;
  readonly timeoutMs?: number;
  /** Requests to push services in flight at once. */
  readonly concurrency?: number;
  /** Sends that may wait for a free slot; beyond this they are dropped. */
  readonly maxWaiting?: number;
  /** Notifications one user may be pushed per minute. */
  readonly perUserPerMinute?: number;
  /** The contact presented to push services (`mailto:` or `https:`). */
  readonly vapidSubject?: string;
}

export interface DeviceDelivery {
  readonly id: string;
  readonly label: string;
  readonly endpointHash: string;
  readonly outcome: PushDeliveryOutcome;
  readonly httpStatus?: number;
  /** The subscription was deleted as a result. */
  readonly removed: boolean;
}

export interface DeliveryReport {
  /** False when nothing was sent at all; `reason` says why. */
  readonly attempted: boolean;
  readonly reason: 'no-devices' | 'rate-limited' | 'stopped' | null;
  readonly devices: readonly DeviceDelivery[];
  /** Devices whose push service accepted the message. */
  readonly accepted: number;
}

/** Where the VAPID key pair lives in the secret store. The private key is read only inside this process. */
const VAPID_SECRET = 'inbox.vapid-keys';
/** What push services are told when no public https origin is configured. */
const FALLBACK_SUBJECT = 'mailto:operator@agent-studio.invalid';

/** At most `limit` tasks at once; a bounded number may wait, the rest are refused. */
class Slots {
  #active = 0;
  #closed = false;
  readonly #waiting: Array<(granted: boolean) => void> = [];
  readonly #limit: number;
  readonly #maxWaiting: number;

  constructor(limit: number, maxWaiting: number) {
    this.#limit = Math.max(1, limit);
    this.#maxWaiting = Math.max(0, maxWaiting);
  }

  /** Runs `task` when a slot is free. Resolves with null when there was no room to wait, or the pool closed first. */
  async run<T>(task: () => Promise<T>): Promise<T | null> {
    if (this.#closed) return null;
    if (this.#active >= this.#limit) {
      if (this.#waiting.length >= this.#maxWaiting) return null;
      // A freed slot is handed over directly, so the count never exceeds the limit.
      if (!(await new Promise<boolean>((resolve) => this.#waiting.push(resolve)))) return null;
    } else {
      this.#active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.#waiting.shift();
      if (next) next(true);
      else this.#active -= 1;
    }
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter(false);
  }
}

/**
 * The Web Push channel: the installation's VAPID identity, the subscribed
 * devices, and the one path by which anything is ever sent to a push service.
 *
 * Sending never throws and is never awaited by the event that caused it: a
 * push service that is slow, down or hostile cannot hold up or fail a run.
 */
export class PushChannel {
  readonly devices: DeviceStore;
  readonly #context: ModuleContext;
  readonly #switches: NotificationSwitches;
  readonly #options: PushOptions;
  readonly #now: () => number;
  readonly #slots: Slots;
  readonly #perUser: SlidingRate;
  readonly #testInterval: SlidingRate;
  readonly #testsPerHour: SlidingRate;
  readonly #inFlight = new Set<Promise<unknown>>();
  #vapid: VapidKeys | null = null;
  #stopped = false;

  constructor(deps: { context: ModuleContext; switches: NotificationSwitches; options: PushOptions; now: () => number }) {
    this.#context = deps.context;
    this.#switches = deps.switches;
    this.#options = deps.options;
    this.#now = deps.now;
    this.devices = new DeviceStore(deps.context.db, deps.context.keys.derive('inbox.push-subscriptions'));
    this.#slots = new Slots(deps.options.concurrency ?? 4, deps.options.maxWaiting ?? 200);
    this.#perUser = new SlidingRate(deps.options.perUserPerMinute ?? NOTIFICATION_LIMITS.pushPerMinute, 60_000, deps.now);
    this.#testInterval = new SlidingRate(1, NOTIFICATION_LIMITS.testIntervalMs, deps.now);
    this.#testsPerHour = new SlidingRate(NOTIFICATION_LIMITS.testsPerHour, 60 * 60 * 1000, deps.now);
  }

  // ---- identity --------------------------------------------------------------

  /** The key pair, generated once per installation. Replaced only when the stored one can no longer be read. */
  #keys(): VapidKeys {
    if (this.#vapid) return this.#vapid;
    const secrets = this.#context.secrets;
    try {
      const stored = secrets.reveal(VAPID_SECRET);
      if (stored !== null) {
        const parsed = JSON.parse(stored) as Partial<VapidKeys>;
        if (typeof parsed.privateKey === 'string' && typeof parsed.publicKey === 'string') {
          return (this.#vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey });
        }
      }
    } catch (error) {
      // The master key was replaced: the old pair is lost, and with it every subscription made for it.
      this.#context.log.warn({ err: describeError(error) }, 'the stored Web Push key pair cannot be read; a new one is generated and devices must subscribe again');
    }
    const fresh = generateVapidKeys();
    // The private key first: the stored hint is the tail of the value, which is then part of the public key.
    secrets.put(VAPID_SECRET, JSON.stringify({ privateKey: fresh.privateKey, publicKey: fresh.publicKey }));
    return (this.#vapid = fresh);
  }

  publicKey(): string {
    return this.#keys().publicKey;
  }

  #subject(): string {
    return this.#options.vapidSubject ?? this.#context.config.publicOrigins.find((origin) => origin.startsWith('https://')) ?? FALLBACK_SUBJECT;
  }

  // ---- devices ---------------------------------------------------------------

  list(userId: string, currentHash: string | null): PushDevice[] {
    return this.devices.ofUser(userId).map((row) => presentDevice(row, currentHash));
  }

  #announceSettings(userId: string, reason: 'device-added' | 'device-removed'): void {
    this.#context.bus.publish(userTopic(userId), INBOX_EVENT.settingsChanged, { reason });
  }

  /**
   * Registers a browser. Returns whether it has to be announced: a device
   * that is new to the account — or one that came back without saying it is a
   * re-registration — switches the channel on and tells every device.
   */
  subscribe(
    principal: Principal,
    request: PushSubscribeRequest,
    meta: { userAgent: string | null; ip: string | null },
  ): { device: DeviceRow; announce: boolean } {
    const subscription: PushSubscription = { endpoint: request.endpoint, p256dh: request.keys.p256dh, auth: request.keys.auth };
    validateSubscription(subscription, this.#options.allowedHosts, this.#options.policy);
    const userId = principal.userId;
    const hash = endpointHash(subscription.endpoint);
    const now = this.#now();
    const language = this.#switches.language(userId);

    let existing = this.devices.byHash(hash);
    if (existing && existing.user_id !== userId) {
      // One browser, one account: whoever used it before no longer receives anything on it.
      this.devices.remove(existing.id);
      this.#announceSettings(existing.user_id, 'device-removed');
      existing = undefined;
    }
    const known = existing !== undefined || this.devices.wasRetired(userId, hash, now);

    let device: DeviceRow;
    if (existing) {
      const label = request.label === undefined ? null : deviceLabel({ label: request.label, endpoint: subscription.endpoint }, language);
      this.devices.refresh(existing.id, { sealed: this.devices.seal(existing.id, subscription), credentialId: principal.credentialId, label });
      device = this.devices.find(userId, existing.id)!;
    } else {
      if (this.devices.count(userId) >= NOTIFICATION_LIMITS.devicesPerUser) {
        throw conflict(`At most ${NOTIFICATION_LIMITS.devicesPerUser} devices can receive notifications. Remove one first.`, 'too_many_devices');
      }
      const id = newId();
      device = {
        id,
        user_id: userId,
        credential_id: principal.credentialId,
        endpoint_hash: hash,
        sealed: this.devices.seal(id, subscription),
        label: deviceLabel({ label: request.label, userAgent: meta.userAgent, endpoint: subscription.endpoint }, language),
        created_at: now,
        last_delivered_at: null,
      };
      this.devices.insert(device);
    }
    this.devices.forgetRetired(userId, hash);

    if (!known) {
      // A listener nobody has seen before: on the record, with where it came from.
      this.#context.services.audit.record({ category: 'change', action: 'push.device-added', userId, subject: device.label, address: meta.ip });
    }
    const silent = request.resubscribe && known;
    if (!silent) this.#switches.setChannel(userId, 'webPush', true);
    this.#announceSettings(userId, 'device-added');
    return { device, announce: !silent };
  }

  /** Removes one of the caller's devices. With none left the channel is switched off. */
  remove(userId: string, deviceId: string): void {
    const row = this.devices.find(userId, deviceId);
    if (!row) throw notFound('No such device.', 'device_not_found');
    this.#drop(row, 'removed');
  }

  /** The browser unsubscribed itself. Only the caller's own subscription is ever affected. */
  unsubscribe(userId: string, endpoint: string): boolean {
    const row = this.devices.byHash(endpointHash(endpoint));
    if (!row || row.user_id !== userId) return false;
    this.#drop(row, 'removed');
    return true;
  }

  /**
   * `removed`     the user took it away, or its push service says it is gone: the channel follows the devices.
   * `signed-out`  its browser is no longer signed in: remembered, so that it can come back quietly, and the switch stays as the user left it.
   */
  #drop(row: DeviceRow, why: 'removed' | 'signed-out'): void {
    if (!this.devices.remove(row.id)) return;
    if (why === 'signed-out') this.devices.retire(row.user_id, row.endpoint_hash, this.#now());
    else if (this.devices.count(row.user_id) === 0) this.#switches.setChannel(row.user_id, 'webPush', false);
    this.#announceSettings(row.user_id, 'device-removed');
  }

  /**
   * A sign-in ended (sign-out, "sign out everywhere", a changed password, a
   * disabled account): the devices it registered stop receiving at once.
   */
  credentialRevoked(credentialId: string): number {
    const rows = this.devices.ofCredential(credentialId);
    for (const row of rows) this.#drop(row, 'signed-out');
    return rows.length;
  }

  /** A sign-in can also end without an event (it expired): checked whenever something is about to be sent. */
  #signedIn(row: DeviceRow): boolean {
    const principal = this.#context.services.agents.principalFor(row.user_id);
    if (!principal) return false;
    return this.#context.http.authenticator.isCredentialLive({ ...principal, via: 'session', credentialId: row.credential_id });
  }

  // ---- sending ---------------------------------------------------------------

  async #sendOne(row: DeviceRow, message: PushMessage): Promise<DeviceDelivery> {
    const base = { id: row.id, label: row.label, endpointHash: row.endpoint_hash };
    if (!this.#signedIn(row)) {
      this.#drop(row, 'signed-out');
      return { ...base, outcome: 'signed-out', removed: true };
    }
    const subscription = this.devices.open(row);
    if (!subscription) {
      this.#drop(row, 'removed');
      return { ...base, outcome: 'gone', removed: true };
    }
    const outcome = await this.#slots.run(async () => {
      try {
        return await sendPush(
          subscription,
          message,
          { keys: this.#keys(), subject: this.#subject() },
          {
            ...(this.#options.allowedHosts ? { allowedHosts: this.#options.allowedHosts } : {}),
            ...(this.#options.policy ? { policy: this.#options.policy } : {}),
            timeoutMs: this.#options.timeoutMs ?? 15_000,
          },
        );
      } catch (error) {
        return { status: 'unreachable' as const, reason: describeError(error) };
      }
    });
    if (outcome === null) return { ...base, outcome: 'unreachable', removed: false };
    switch (outcome.status) {
      case 'sent':
        this.devices.markDelivered(row.id, this.#now());
        return { ...base, outcome: 'sent', removed: false };
      case 'gone':
        this.#drop(row, 'removed');
        return { ...base, outcome: 'gone', removed: true };
      case 'rejected':
        this.#context.log.warn({ deviceId: row.id, status: outcome.httpStatus }, 'a push service refused a message');
        return { ...base, outcome: 'rejected', httpStatus: outcome.httpStatus, removed: false };
      default:
        this.#context.log.warn({ deviceId: row.id }, 'a push service could not be reached');
        return { ...base, outcome: 'unreachable', removed: false };
    }
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    void work.finally(() => this.#inFlight.delete(work)).catch(() => {});
    return work;
  }

  async #sendAll(rows: readonly DeviceRow[], message: PushMessage): Promise<DeliveryReport> {
    const settled = await Promise.all(
      rows.map((row) =>
        this.#sendOne(row, message).catch((error: unknown): DeviceDelivery => {
          this.#context.log.error({ deviceId: row.id, err: describeError(error) }, 'sending a push failed unexpectedly');
          return { id: row.id, label: row.label, endpointHash: row.endpoint_hash, outcome: 'unreachable', removed: false };
        }),
      ),
    );
    return { attempted: true, reason: null, devices: settled, accepted: settled.filter((entry) => entry.outcome === 'sent').length };
  }

  /**
   * Sends one notification to every device of a user. Resolves when every
   * push service has answered (or timed out); it never rejects.
   */
  deliver(userId: string, content: NotificationContent, options: { showDetails: boolean; delivery?: PushDelivery }): Promise<DeliveryReport> {
    if (this.#stopped) return Promise.resolve({ attempted: false, reason: 'stopped', devices: [], accepted: 0 });
    const rows = this.devices.ofUser(userId);
    if (rows.length === 0) return Promise.resolve({ attempted: false, reason: 'no-devices', devices: [], accepted: 0 });
    if (!this.#perUser.take(userId)) {
      // Dropped, not queued — and logged without what it said.
      this.#context.log.warn({ userId, kind: content.kind }, 'a push notification was dropped: too many in a minute');
      return Promise.resolve({ attempted: false, reason: 'rate-limited', devices: [], accepted: 0 });
    }
    const delivery = options.delivery ?? pushDelivery(content.kind);
    const message: PushMessage = {
      payload: buildPushPayload(content, { showDetails: options.showDetails }),
      ttlSeconds: delivery.ttlSeconds,
      urgency: delivery.urgency,
      // The user is part of the key: two accounts on one push service never replace each other's messages.
      topic: pushTopic(`${userId}\n${content.tag}`),
    };
    return this.#track(this.#sendAll(rows, message));
  }

  /**
   * Sends a real message through the same path to every device of the
   * caller, whatever the channel switch says, and reports device by device
   * where it went or why not.
   */
  async test(principal: Principal, origin: 'settings' | 'automations', currentHash: string | null): Promise<PushTestResult> {
    const userId = principal.userId;
    const wait = Math.max(this.#testInterval.waitMs(userId), this.#testsPerHour.waitMs(userId));
    if (wait > 0) throw rateLimited(Math.ceil(wait / 1000), 'A test was sent a moment ago. Try again shortly.');

    const enabled = this.#switches.read(userId).channels.webPush;
    const rows = this.devices.ofUser(userId);
    // Nothing to send to: said plainly, and it does not count against the limit.
    if (rows.length === 0 || this.#stopped) return { ok: false, enabled, devices: [], sent: 0, removed: 0, failed: 0 };
    this.#testInterval.take(userId);
    this.#testsPerHour.take(userId);
    const content = testContent(this.#switches.language(userId), origin);
    const delivery = pushDelivery('system', { test: true });
    const report = await this.#track(
      this.#sendAll(rows, {
        payload: buildPushPayload(content, { showDetails: false }),
        ttlSeconds: delivery.ttlSeconds,
        urgency: delivery.urgency,
        topic: pushTopic(`${userId}\n${content.tag}`),
      }),
    );
    const devices = report.devices.map((entry) => ({
      id: entry.id,
      label: entry.label,
      current: currentHash !== null && entry.endpointHash === currentHash,
      outcome: entry.outcome,
      ...(entry.httpStatus === undefined ? {} : { httpStatus: entry.httpStatus }),
      removed: entry.removed,
    }));
    const removed = devices.filter((entry) => entry.removed).length;
    return {
      ok: report.accepted > 0,
      enabled: this.#switches.read(userId).channels.webPush,
      devices,
      sent: report.accepted,
      removed,
      failed: devices.length - report.accepted - removed,
    };
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Resolves when nothing is on its way to a push service. */
  async idle(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  /** Nothing new is sent; what waits for a slot is dropped; what is in flight is given until its own time-out. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#slots.close();
    await this.idle();
  }

  housekeeping(): void {
    this.devices.pruneRetired(this.#now());
  }
}
