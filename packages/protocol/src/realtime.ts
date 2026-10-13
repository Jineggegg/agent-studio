import { z } from 'zod';

/**
 * Realtime protocol (JSON text frames over one WebSocket at /api/realtime).
 *
 * Client → server: subscribe / unsubscribe / ping.
 * Server → client: ready, subscribed, rejected, event, pong.
 *
 * Topics are `<kind>:<key>`. Durable topics number their events; pass the last
 * sequence number you saw as `after` when you subscribe again and the server
 * replays what you missed. Drop any event whose `seq` you have already seen.
 */
export const clientFrameSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('subscribe'), topic: z.string(), after: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('unsubscribe'), topic: z.string() }),
  z.object({ op: z.literal('ping'), t: z.number().optional() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const serverFrameSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('ready'), connectionId: z.string(), serverTime: z.number() }),
  z.object({ op: z.literal('subscribed'), topic: z.string(), replayed: z.number(), snapshot: z.unknown().optional() }),
  z.object({ op: z.literal('rejected'), topic: z.string(), code: z.string() }),
  z.object({
    op: z.literal('event'),
    topic: z.string(),
    type: z.string(),
    data: z.unknown(),
    seq: z.number().optional(),
    at: z.number(),
  }),
  z.object({ op: z.literal('pong'), t: z.number().optional() }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/** WebSocket close codes with a meaning specific to this service. */
export const CLOSE_CODES = {
  /** The session ended or was revoked: sign in again. */
  authEnded: 4401,
  /** The client was not reading fast enough: reconnect and replay. */
  slowConsumer: 4408,
  /** The client broke the protocol. */
  protocol: 4400,
  /** This account already has too many live connections: close some tabs. */
  tooMany: 4429,
} as const;

export const userTopic = (userId: string) => `user:${userId}`;
export const SYSTEM_TOPIC = 'system:status';
