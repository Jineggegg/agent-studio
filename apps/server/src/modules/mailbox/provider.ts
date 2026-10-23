import { z } from 'zod';
import {
  mailAddressSchema,
  type MailCredentials,
  type MailDraftInput,
  type MailMessage,
  type MailSearch,
} from '@agent-studio/protocol';
import { badRequest, unavailable } from '../../kernel/errors.js';
import { guardedRequest, readBody } from '../../kernel/net.js';

export type MailTransport = typeof guardedRequest;
const gmailRoot = 'https://gmail.googleapis.com/gmail/v1/users/me';
const graphRoot = 'https://graph.microsoft.com/v1.0/me';
const enc = encodeURIComponent;
const failure = () =>
  unavailable(
    'The mail service could not complete this request. Check account credentials and permissions.',
    'mail_service_failed',
  );
const remoteId = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_+=./-]+$/)
  .refine((s) => s !== '.' && s !== '..');
const attachment = z.object({
  id: remoteId,
  name: z.string().default('attachment'),
  size: z.number().nonnegative().default(0),
  contentType: z.string().default('application/octet-stream'),
  contentBytes: z.string().optional(),
  '@odata.type': z.string().optional(),
});
const graphMessage = z.object({
  id: remoteId,
  subject: z.string().default(''),
  from: z
    .object({
      emailAddress: z.object({ address: z.string().default(''), name: z.string().default('') }),
    })
    .optional(),
  toRecipients: z.array(z.object({ emailAddress: z.object({ address: z.string() }) })).default([]),
  receivedDateTime: z.string().optional(),
  isRead: z.boolean().default(false),
  bodyPreview: z.string().default(''),
  body: z.object({ contentType: z.string(), content: z.string() }).optional(),
  attachments: z.array(attachment).default([]),
});
interface GmailPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number; attachmentId?: string };
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailPart[];
}
const gmailPart: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    body: z
      .object({
        data: z.string().optional(),
        size: z.number().nonnegative().optional(),
        attachmentId: remoteId.optional(),
      })
      .optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .max(200)
      .optional(),
    parts: z.array(gmailPart).max(100).optional(),
  }),
);
const gmailMessage = z.object({
  id: remoteId,
  snippet: z.string().default(''),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  payload: gmailPart.optional(),
});

/** All email is rendered as inert text. No images, styles, forms or links are loaded. */
export function htmlToMailText(raw: string): string {
  return (
    raw
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<\s*(br|\/p|\/div|\/tr|\/li)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,7}|#x[a-f0-9]{1,6});/gi, (entity) => {
        const named: Record<string, string> = {
          '&amp;': '&',
          '&lt;': '<',
          '&gt;': '>',
          '&quot;': '"',
          '&apos;': "'",
          '&nbsp;': ' ',
        };
        if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
        const value = entity.toLowerCase().startsWith('&#x')
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number(entity.slice(2, -1));
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
          ? String.fromCodePoint(value)
          : '';
      })
      // eslint-disable-next-line no-control-regex -- Reject or remove control characters from untrusted mail data.
      .replace(/\x00/g, '')
      .slice(0, 500000)
  );
}
function gmailView(raw: unknown): MailMessage {
  const m = gmailMessage.parse(raw);
  const headers = m.payload?.headers ?? [];
  const get = (name: string, max: number) =>
    (headers.find((h) => h.name.toLowerCase() === name)?.value ?? '').slice(0, max);
  const plain: string[] = [],
    html: string[] = [],
    attachments: MailMessage['attachments'] = [];
  const visit = (p: GmailPart, depth: number) => {
    if (depth > 20) return;
    if (p.filename && p.body?.attachmentId && attachments.length < 100)
      attachments.push({
        id: p.body.attachmentId,
        name: p.filename.slice(0, 512),
        size: p.body.size ?? 0,
        type: (p.mimeType ?? 'application/octet-stream').slice(0, 200),
      });
    else if (p.body?.data) {
      const text = Buffer.from(p.body.data, 'base64url').toString('utf8');
      if (p.mimeType === 'text/plain') plain.push(text);
      else if (p.mimeType === 'text/html') html.push(htmlToMailText(text));
    }
    for (const child of p.parts ?? []) visit(child, depth + 1);
  };
  if (m.payload) visit(m.payload, 0);
  const at = Number(m.internalDate);
  return {
    id: m.id,
    subject: get('subject', 1000),
    from: get('from', 2000),
    to: get('to', 4000),
    receivedAt: Number.isFinite(at) ? at : null,
    unread: m.labelIds.includes('UNREAD'),
    preview: m.snippet.slice(0, 1000),
    text: (plain.length ? plain : html).join('\n').slice(0, 500000),
    attachments,
  };
}
function graphView(raw: unknown): MailMessage {
  const m = graphMessage.parse(raw);
  const at = Date.parse(m.receivedDateTime ?? '');
  return {
    id: m.id,
    subject: m.subject.slice(0, 1000),
    from: (m.from?.emailAddress.address ?? '').slice(0, 2000),
    to: m.toRecipients
      .map((r) => r.emailAddress.address)
      .join(', ')
      .slice(0, 4000),
    receivedAt: Number.isFinite(at) ? at : null,
    unread: !m.isRead,
    preview: m.bodyPreview.slice(0, 1000),
    text: (m.body?.contentType.toLowerCase() === 'html'
      ? htmlToMailText(m.body.content)
      : (m.body?.content ?? '')
    ).slice(0, 500000),
    attachments: m.attachments
      .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
      .slice(0, 100)
      .map((a) => ({
        id: a.id,
        name: a.name.slice(0, 512),
        size: a.size,
        type: a.contentType.slice(0, 200),
      })),
  };
}
export class MailProvider {
  constructor(
    readonly provider: 'gmail' | 'outlook',
    private credentials: MailCredentials,
    readonly saveCredentials: (value: MailCredentials) => void,
    readonly transport: MailTransport = guardedRequest,
  ) {}
  async #json(url: string, method = 'GET', body?: unknown, retry = true): Promise<unknown> {
    try {
      const response = await this.transport(url, {
        method,
        headers: {
          authorization: `Bearer ${this.credentials.accessToken}`,
          'content-type': 'application/json',
          prefer: 'outlook.body-content-type="text"',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25000),
      });
      if (response.status === 401 && retry && this.credentials.refreshToken) {
        response.body.destroy();
        await this.#refresh();
        return this.#json(url, method, body, false);
      }
      if (response.status < 200 || response.status >= 300) {
        response.body.destroy();
        throw failure();
      }
      const bytes = await readBody(response.body, 8 * 1024 * 1024);
      return bytes.length ? (JSON.parse(bytes.toString('utf8')) as unknown) : {};
    } catch {
      throw failure();
    }
  }
  async #refresh(): Promise<void> {
    const c = this.credentials;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: c.refreshToken!,
      client_id: c.clientId!,
      ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
    });
    const url =
      this.provider === 'gmail'
        ? 'https://oauth2.googleapis.com/token'
        : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
    const response = await this.transport(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });
    if (response.status !== 200) {
      response.body.destroy();
      throw failure();
    }
    const token = z
      .object({
        access_token: z
          .string()
          .min(1)
          .max(16384)
          // eslint-disable-next-line no-control-regex -- Reject or remove control characters from untrusted mail data.
          .regex(/^[^\s\x00-\x1f\x7f]+$/),
        refresh_token: z.string().optional(),
      })
      .parse(JSON.parse((await readBody(response.body, 65536)).toString('utf8')));
    this.credentials = {
      ...c,
      accessToken: token.access_token,
      ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
    };
    this.saveCredentials(this.credentials);
  }
  async folders() {
    if (this.provider === 'gmail') {
      const data = z
        .object({ labels: z.array(z.object({ id: remoteId, name: z.string() })).max(10000) })
        .parse(await this.#json(`${gmailRoot}/labels`));
      return {
        folders: data.labels
          .slice(0, 500)
          .map((f) => ({ id: f.id, name: f.name.slice(0, 512), unread: null })),
        truncated: data.labels.length > 500,
      };
    }
    const data = z
      .object({
        value: z.array(
          z.object({
            id: remoteId,
            displayName: z.string(),
            unreadItemCount: z.number().nonnegative(),
          }),
        ),
        '@odata.nextLink': z.string().optional(),
      })
      .parse(await this.#json(`${graphRoot}/mailFolders?$top=100`));
    return {
      folders: data.value.map((f) => ({
        id: f.id,
        name: f.displayName.slice(0, 512),
        unread: f.unreadItemCount,
      })),
      truncated: Boolean(data['@odata.nextLink']),
    };
  }
  async list(query: MailSearch) {
    if (this.provider === 'gmail') {
      const params = new URLSearchParams({ maxResults: '25', q: query.search });
      if (query.folder) params.set('labelIds', query.folder);
      if (query.cursor) params.set('pageToken', query.cursor);
      const data = z
        .object({
          messages: z
            .array(z.object({ id: remoteId }))
            .max(25)
            .default([]),
          nextPageToken: z.string().optional(),
        })
        .parse(await this.#json(`${gmailRoot}/messages?${params}`));
      const messages: MailMessage[] = [];
      // Small batches prevent a folder refresh from opening 25 connections at once.
      for (let i = 0; i < data.messages.length; i += 5)
        messages.push(
          ...(await Promise.all(data.messages.slice(i, i + 5).map((m) => this.message(m.id)))),
        );
      return { messages, cursor: data.nextPageToken ?? null };
    }
    const folderPath = query.folder ? `/mailFolders/${enc(query.folder)}/messages` : '/messages';
    const path = `${graphRoot}${folderPath}`;
    const params = new URLSearchParams({
      $top: '25',
      $select: 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview',
    });
    if (query.search) params.set('$search', JSON.stringify(query.search));
    else params.set('$orderby', 'receivedDateTime desc');
    let url = `${path}?${params}`;
    if (query.cursor) {
      const cursor = new URL(query.cursor);
      if (
        cursor.origin !== 'https://graph.microsoft.com' ||
        cursor.pathname !== new URL(path).pathname ||
        cursor.username ||
        cursor.password ||
        cursor.hash
      )
        throw badRequest('Invalid mailbox cursor.');
      url = cursor.toString();
    }
    const data = z
      .object({
        value: z.array(graphMessage).max(25),
        '@odata.nextLink': z.string().max(8192).optional(),
      })
      .parse(await this.#json(url));
    return { messages: data.value.map(graphView), cursor: data['@odata.nextLink'] ?? null };
  }
  async message(id: string): Promise<MailMessage> {
    return this.provider === 'gmail'
      ? gmailView(await this.#json(`${gmailRoot}/messages/${enc(id)}?format=full`))
      : graphView(
          await this.#json(
            `${graphRoot}/messages/${enc(id)}?$expand=attachments($select=id,name,size,contentType)`,
          ),
        );
  }
  async attachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ bytes: Buffer; name: string }> {
    const message = await this.message(messageId);
    const metadata = message.attachments.find((a) => a.id === attachmentId);
    if (!metadata || metadata.size > 5 * 1024 * 1024)
      throw badRequest('This attachment is missing or exceeds the 5 MB download limit.');
    let bytes: Buffer;
    if (this.provider === 'gmail') {
      const data = z
        .object({ data: z.string(), size: z.number() })
        .parse(
          await this.#json(
            `${gmailRoot}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
          ),
        );
      bytes = Buffer.from(data.data, 'base64url');
    } else {
      const data = attachment.parse(
        await this.#json(
          `${graphRoot}/messages/${enc(messageId)}/attachments/${enc(attachmentId)}`,
        ),
      );
      if (!data.contentBytes || data['@odata.type'] !== '#microsoft.graph.fileAttachment')
        throw badRequest('Only file attachments can be downloaded.');
      bytes = Buffer.from(data.contentBytes, 'base64');
    }
    if (bytes.length > 5 * 1024 * 1024)
      throw badRequest('This attachment exceeds the 5 MB download limit.');
    return { bytes, name: metadata.name };
  }
  async send(draft: MailDraftInput): Promise<void> {
    if (this.provider === 'gmail') {
      const profile = z
        .object({ emailAddress: mailAddressSchema })
        .parse(await this.#json(`${gmailRoot}/profile`));
      const subject = `=?UTF-8?B?${Buffer.from(draft.subject).toString('base64')}?=`;
      const message = `From: ${profile.emailAddress}\r\nTo: ${draft.to.join(', ')}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${
        Buffer.from(draft.text)
          .toString('base64')
          .match(/.{1,76}/g)
          ?.join('\r\n') ?? ''
      }`;
      await this.#json(
        `${gmailRoot}/messages/send`,
        'POST',
        { raw: Buffer.from(message).toString('base64url') },
        false,
      );
    } else
      await this.#json(
        `${graphRoot}/sendMail`,
        'POST',
        {
          message: {
            subject: draft.subject,
            body: { contentType: 'Text', content: draft.text },
            toRecipients: draft.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: true,
        },
        false,
      );
  }
}
