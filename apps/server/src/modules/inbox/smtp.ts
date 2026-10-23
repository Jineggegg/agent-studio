import { lookup } from 'node:dns/promises';
import tls from 'node:tls';
import { isAddressAllowed } from '../../kernel/net.js';
import { forbidden, unavailable } from '../../kernel/errors.js';

export interface SmtpDelivery {
  host: string;
  port: 465;
  username: string;
  password: string;
  from: string;
  to: string;
  title: string;
  text: string;
}

/** Implicit TLS submission only. Resolve once, reject every nonpublic result, connect to the vetted IP. */
export async function sendSmtp(input: SmtpDelivery): Promise<void> {
  let addresses;
  try {
    addresses = await lookup(input.host, { all: true });
  } catch {
    throw unavailable('The SMTP server could not be resolved.', 'notification_delivery_failed');
  }
  if (!addresses.length || addresses.some((a) => !isAddressAllowed(a.address, {})))
    throw forbidden('SMTP requires a public address.', 'address_not_allowed');
  const socket = tls.connect({
    host: addresses[0]!.address,
    port: 465,
    servername: input.host,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  });
  let buffer = '',
    pending: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  let failed: Error | null = null;
  const fail = () => {
    failed = new Error('SMTP exchange failed');
    pending?.reject(failed);
    pending = null;
    socket.destroy();
  };
  const timer = setTimeout(fail, 20000);
  const consume = () => {
    if (!pending) return;
    const lines = buffer.split('\r\n');
    let end = 0;
    for (const line of lines.slice(0, -1)) {
      end += line.length + 2;
      if (/^\d{3} /.test(line)) {
        const done = pending;
        pending = null;
        const reply = buffer.slice(0, end);
        buffer = buffer.slice(end);
        done.resolve(reply);
        return;
      }
      if (!/^\d{3}-/.test(line)) {
        fail();
        return;
      }
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536) fail();
    else consume();
  });
  socket.on('error', fail);
  socket.on('close', () => {
    if (pending) fail();
  });
  const reply = () =>
    new Promise<string>((resolve, reject) => {
      if (failed) {
        reject(failed);
        return;
      }
      pending = { resolve, reject };
      consume();
    });
  const exchange = async (command: string | null, code: number) => {
    const wait = reply();
    if (command !== null) socket.write(`${command}\r\n`);
    const response = await wait;
    if (!response.startsWith(String(code))) throw new Error('SMTP refused command');
    return response;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('SMTP connection closed')));
    });
    await exchange(null, 220);
    const capabilities = await exchange('EHLO cloud-harness.invalid', 250);
    if (!/AUTH[^\r\n]*\bPLAIN\b/i.test(capabilities))
      throw new Error('SMTP PLAIN authentication unavailable');
    await exchange(
      `AUTH PLAIN ${Buffer.from(`\0${input.username}\0${input.password}`).toString('base64')}`,
      235,
    );
    await exchange(`MAIL FROM:<${input.from}>`, 250);
    await exchange(`RCPT TO:<${input.to}>`, 250);
    await exchange('DATA', 354);
    const subject = `=?UTF-8?B?${Buffer.from(input.title.slice(0, 200)).toString('base64')}?=`;
    const body =
      Buffer.from(input.text)
        .toString('base64')
        .match(/.{1,76}/g)
        ?.join('\r\n') ?? '';
    await exchange(
      `From: ${input.from}\r\nTo: ${input.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}\r\n.`,
      250,
    );
    // DATA acceptance is the delivery boundary. QUIT cannot turn success into a retry.
    socket.end('QUIT\r\n');
  } catch {
    throw unavailable(
      'The SMTP service could not confirm delivery. Check its configuration and delivery history.',
      'notification_delivery_failed',
    );
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
