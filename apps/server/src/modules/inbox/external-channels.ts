import { z } from 'zod';
import {
  notificationChannelInputSchema,
  notificationChannelKindSchema,
  notificationChannelTestSchema,
  type ExternalNotificationChannel,
  type NotificationChannelInput,
} from '@agent-studio/protocol';
import { badRequest, unavailable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import { checkUrl, guardedRequest, readBody } from '../../kernel/net.js';
import { redactSecrets } from '../../kernel/redact.js';
import type { NotificationContent } from './content.js';
import { sendSmtp, type SmtpDelivery } from './smtp.js';

export interface ExternalChannelOptions {
  http?: typeof guardedRequest;
  smtp?: (value: SmtpDelivery) => Promise<void>;
}
const key = (user: string, kind: string) => `notifications:${user}:${kind}`;
const kinds = ['smtp', 'bark'] as const;
export class ExternalChannels {
  readonly #pending = new Set<Promise<number>>();
  readonly #budgets = new Map<string, { at: number; count: number }>();
  constructor(
    readonly context: ModuleContext,
    readonly options: ExternalChannelOptions = {},
  ) {}
  config(userId: string, kind: 'smtp' | 'bark'): NotificationChannelInput | null {
    const value = this.context.secrets.reveal(key(userId, kind));
    return value ? notificationChannelInputSchema.parse(JSON.parse(value)) : null;
  }
  list(userId: string): ExternalNotificationChannel[] {
    return kinds.flatMap<ExternalNotificationChannel>((kind) => {
      const config = this.config(userId, kind);
      if (!config) return [];
      if (config.kind === 'smtp') {
        const { password, ...rest } = config;
        return [{ ...rest, credentialSaved: Boolean(password) }];
      }
      const { deviceKey, ...rest } = config;
      return [{ ...rest, credentialSaved: Boolean(deviceKey) }];
    });
  }
  enabled(userId: string): boolean {
    return kinds.some((kind) => this.config(userId, kind)?.enabled);
  }
  async #send(config: NotificationChannelInput, title: string, text: string): Promise<void> {
    if (config.kind === 'smtp') {
      if (!config.password) throw badRequest('Add an SMTP password.');
      await (this.options.smtp ?? sendSmtp)({ ...config, password: config.password, title, text });
      return;
    }
    if (!config.deviceKey) throw badRequest('Add a Bark device key.');
    const response = await (this.options.http ?? guardedRequest)(
      `${config.endpoint.replace(/\/$/, '')}/push`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ device_key: config.deviceKey, title, body: text }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (response.status !== 200) {
      response.body.destroy();
      throw unavailable(
        'The notification service rejected delivery.',
        'notification_delivery_failed',
      );
    }
    const result = z
      .object({ code: z.number() })
      .safeParse(JSON.parse((await readBody(response.body, 65536)).toString('utf8')));
    if (!result.success || result.data.code !== 200)
      throw unavailable(
        'The notification service did not confirm delivery.',
        'notification_delivery_failed',
      );
  }
  deliver(userId: string, content: NotificationContent, showDetails: boolean): Promise<number> {
    const now = Date.now(),
      old = this.#budgets.get(userId),
      budget = old && now - old.at < 60000 ? old : { at: now, count: 0 };
    this.#budgets.set(userId, budget);
    // Bound both delivery work and rate memory, including accounts no longer in use.
    if (this.#budgets.size > 1000)
      for (const [id, value] of this.#budgets) if (now - value.at > 60000) this.#budgets.delete(id);
    if (budget.count >= 10 || this.#pending.size >= 20) return Promise.resolve(0);
    budget.count += 1;
    const send = async () => {
      let accepted = 0;
      for (const kind of kinds) {
        const config = this.config(userId, kind);
        if (!config?.enabled) continue;
        try {
          await this.#send(
            config,
            redactSecrets(showDetails ? content.title : content.discreet.title),
            redactSecrets(showDetails ? content.body : content.discreet.body),
          );
          accepted += 1;
        } catch {
          /* No provider errors, endpoints, recipients, credentials or message content enter logs. */
        }
      }
      return accepted;
    };
    const task = send().catch(() => 0);
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return task;
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
  register(): void {
    const { http, secrets } = this.context;
    http.route({
      method: 'GET',
      url: '/api/notifications/channels',
      access: 'user',
      handler: ({ user }) => ({ channels: this.list(user.userId) }),
    });
    http.route({
      method: 'PUT',
      url: '/api/notifications/channels',
      access: 'user',
      sessionOnly: true,
      recentAuth: true,
      body: notificationChannelInputSchema,
      bodyLimit: 12000,
      handler: ({ user, body }) => {
        const previous = this.config(user.userId, body.kind);
        let value: NotificationChannelInput;
        if (body.kind === 'bark') {
          checkUrl(body.endpoint);
          const deviceKey =
            body.deviceKey ??
            (previous?.kind === 'bark' && previous.endpoint === body.endpoint
              ? previous.deviceKey
              : undefined);
          if (!deviceKey) throw badRequest('Enter a device key when changing the endpoint.');
          value = { ...body, deviceKey };
        } else {
          const password =
            body.password ??
            (previous?.kind === 'smtp' &&
            previous.host === body.host &&
            previous.username === body.username
              ? previous.password
              : undefined);
          if (!password)
            throw badRequest('Enter a password when changing the SMTP host or username.');
          value = { ...body, password };
        }
        secrets.put(key(user.userId, body.kind), JSON.stringify(value));
        this.context.services.audit.record({
          category: 'change',
          action: 'notification.channel.updated',
          userId: user.userId,
          subject: body.kind,
        });
        return { channels: this.list(user.userId) };
      },
    });
    http.route({
      method: 'DELETE',
      url: '/api/notifications/channels/:kind',
      access: 'user',
      sessionOnly: true,
      recentAuth: true,
      params: z.object({ kind: notificationChannelKindSchema }),
      handler: ({ user, params }) => {
        secrets.delete(key(user.userId, params.kind));
      },
    });
    http.route({
      method: 'POST',
      url: '/api/notifications/channels/:kind/test',
      access: 'user',
      sessionOnly: true,
      recentAuth: true,
      params: z.object({ kind: notificationChannelKindSchema }),
      body: notificationChannelTestSchema,
      rateLimit: { max: 3, windowMs: 60000 },
      handler: async ({ user, params }) => {
        const config = this.config(user.userId, params.kind);
        if (!config) throw badRequest('Save channel settings first.');
        try {
          await this.#send(config, 'Cloud Harness', 'Notification connection test');
        } catch {
          throw unavailable(
            'The notification service could not confirm this test. Check your settings.',
            'notification_delivery_failed',
          );
        }
        return { accepted: true };
      },
    });
  }
}
