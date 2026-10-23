import {
  COMPUTER_LIMITS,
  computerActionSchema,
  computerApproveSchema,
  computerCompleteSchema,
  computerLeaseRequestSchema,
  computerPairRequestSchema,
  computerPollSchema,
  computerProposalInputSchema,
  idSchema,
  type ComputerAction,
  type ComputerDevice,
  type ComputerProposal,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { newId, randomToken, SecretBox, sha256 } from '../../kernel/crypto.js';
import { badRequest, conflict, notFound, unauthorized } from '../../kernel/errors.js';
import type { StudioModule } from '../../kernel/module.js';
import type { Principal } from '../../kernel/principal.js';

interface Device {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  width: number;
  height: number;
}
interface Action {
  payload: string;
  id: string;
  device_id: string;
  user_id: string;
  session_id: string | null;
  reason: string;
  status: ComputerProposal['status'];
  created_at: number;
  expires_at: number;
  result: string | null;
  lease_hash: string | null;
}
const deviceParams = z.object({ deviceId: idSchema });
const actionParams = z.object({ actionId: idSchema });
const FIVE_MINUTES = 5 * 60_000;
const presentDevice = (row: Device): ComputerDevice => ({
  id: row.id,
  name: row.name,
  platform: 'windows',
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  width: row.width,
  height: row.height,
});
const missing = () => notFound('No such device or action.', 'computer_not_found');

/** Outbound companions receive only individually approved actions; the server never opens a desktop connection. */
export function createComputerModule(): StudioModule {
  const screenshots = new Map<string, { userId: string; bytes: Buffer; until: number }>();
  return {
    name: 'computer',
    migrations: [
      {
        version: 1,
        name: 'explicit device pairing and one-use action leases',
        sql: `
      CREATE TABLE computer_pairings (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE computer_devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER, width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX computer_devices_owner ON computer_devices(user_id);
      CREATE TABLE computer_actions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES computer_devices(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result TEXT, lease_hash TEXT);
      CREATE INDEX computer_actions_device ON computer_actions(device_id, created_at);
    `,
      },
    ],
    setup(context) {
      const { db, http } = context;
      const actionBox = new SecretBox(context.keys.derive('computer-action-text'));
      const audit = (userId: string, action: string, subject: string) =>
        context.services.audit.record({ category: 'change', action, userId, subject });
      const purge = () => {
        db.run('DELETE FROM computer_pairings WHERE expires_at <= ?', Date.now());
        db.run(
          "UPDATE computer_actions SET status = 'expired', result = CASE WHEN status IN ('leased', 'executing') THEN 'Lease expired; execution outcome is unknown.' ELSE 'Approval expired; nothing was dispatched.' END, lease_hash = NULL WHERE expires_at <= ? AND status IN ('pending', 'approved', 'leased', 'executing')",
          Date.now(),
        );
        for (const [id, item] of screenshots) if (item.until <= Date.now()) screenshots.delete(id);
        // Encrypted action text is deleted with its row, including account/device cascades.
        db.run(
          "DELETE FROM computer_actions WHERE created_at < ? AND status IN ('completed', 'rejected', 'failed', 'expired')",
          Date.now() - 24 * 60 * 60_000,
        );
      };
      const requireDevice = (userId: string, id: string): Device => {
        const row = db.get<Device>(
          'SELECT * FROM computer_devices WHERE id = ? AND user_id = ?',
          id,
          userId,
        );
        if (!row) throw missing();
        return row;
      };
      const requireAction = (userId: string, id: string): Action => {
        purge();
        const row = db.get<Action>(
          'SELECT * FROM computer_actions WHERE id = ? AND user_id = ?',
          id,
          userId,
        );
        if (!row) throw missing();
        return row;
      };
      const actionOf = (row: Action): ComputerAction =>
        computerActionSchema.parse(JSON.parse(actionBox.open(row.payload, row.id)));
      const present = (row: Action): ComputerProposal => ({
        id: row.id,
        deviceId: row.device_id,
        sessionId: row.session_id,
        action: actionOf(row),
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        result: row.result,
        screenshotAvailable: screenshots.has(row.id),
      });
      const authenticate = (header: string | undefined): Device => {
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
        const row = match
          ? db.get<Device>('SELECT * FROM computer_devices WHERE token_hash = ?', sha256(match[1]!))
          : undefined;
        if (!row || !context.services.agents.principalFor(row.user_id))
          throw unauthorized('The device is not paired.', 'computer_unpaired');
        return row;
      };
      const propose = (
        user: Principal,
        input: z.infer<typeof computerProposalInputSchema>,
        sessionId: string | null,
      ): ComputerProposal => {
        purge();
        const device = requireDevice(user.userId, input.deviceId);
        if (
          (db.get<{ n: number }>(
            "SELECT count(*) AS n FROM computer_actions WHERE device_id = ? AND status IN ('pending', 'approved', 'leased', 'executing')",
            device.id,
          )?.n ?? 0) >= COMPUTER_LIMITS.pendingPerDevice
        )
          throw conflict(
            'Review the pending actions before proposing more.',
            'computer_queue_full',
          );
        const id = newId(),
          now = Date.now();
        db.transaction(() => {
          db.run(
            "INSERT INTO computer_actions (id,device_id,user_id,session_id,reason,payload,status,created_at,expires_at) VALUES (?,?,?,?,?,?,'pending',?,?)",
            id,
            device.id,
            user.userId,
            sessionId,
            input.reason,
            actionBox.seal(JSON.stringify(input.action), id),
            now,
            now + FIVE_MINUTES,
          );
        });
        audit(user.userId, 'computer.action.proposed', id);
        return present(requireAction(user.userId, id));
      };
      const leaseAction = (device: Device, id: string, lease: string): Action => {
        const row = requireAction(device.user_id, id);
        if (
          row.device_id !== device.id ||
          row.lease_hash !== sha256(lease) ||
          !['leased', 'executing'].includes(row.status)
        )
          throw conflict('This action lease is no longer valid.', 'computer_lease_invalid');
        return row;
      };
      http.route({
        method: 'GET',
        url: '/api/computer/devices',
        access: 'user',
        sessionOnly: true,
        handler: ({ user }) => ({
          devices: db
            .all<Device>(
              'SELECT * FROM computer_devices WHERE user_id = ? ORDER BY created_at',
              user.userId,
            )
            .map(presentDevice),
        }),
      });
      http.route({
        method: 'POST',
        url: '/api/computer/pairings',
        access: 'user',
        sessionOnly: true,
        recentAuth: true,
        rateLimit: { max: 5, windowMs: 60_000 },
        handler: ({ user }) => {
          purge();
          if (
            (db.get<{ n: number }>(
              'SELECT count(*) AS n FROM computer_devices WHERE user_id = ?',
              user.userId,
            )?.n ?? 0) >= COMPUTER_LIMITS.devicesPerUser
          )
            throw conflict('Remove a device before pairing another.', 'computer_device_limit');
          const token = randomToken(),
            expiresAt = Date.now() + FIVE_MINUTES;
          db.transaction(() => {
            db.run('DELETE FROM computer_pairings WHERE user_id = ?', user.userId);
            db.run(
              'INSERT INTO computer_pairings VALUES (?,?,?)',
              sha256(token),
              user.userId,
              expiresAt,
            );
          });
          audit(user.userId, 'computer.pairing.created', user.userId);
          return { token, expiresAt };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/pair',
        access: 'self',
        body: computerPairRequestSchema,
        rateLimit: { max: 10, windowMs: 60_000 },
        handler: ({ body }) => {
          purge();
          const pairing = db.get<{ user_id: string }>(
            'SELECT user_id FROM computer_pairings WHERE hash = ? AND expires_at > ?',
            sha256(body.token),
            Date.now(),
          );
          if (!pairing || !context.services.agents.principalFor(pairing.user_id))
            throw unauthorized(
              'The pairing code expired or was already used.',
              'computer_pairing_invalid',
            );
          if (
            (db.get<{ n: number }>(
              'SELECT count(*) AS n FROM computer_devices WHERE user_id = ?',
              pairing.user_id,
            )?.n ?? 0) >= COMPUTER_LIMITS.devicesPerUser
          )
            throw conflict('Device limit reached.');
          const id = newId(),
            token = randomToken();
          db.transaction(() => {
            db.run('DELETE FROM computer_pairings WHERE hash = ?', sha256(body.token));
            db.run(
              'INSERT INTO computer_devices (id,user_id,name,token_hash,created_at) VALUES (?,?,?,?,?)',
              id,
              pairing.user_id,
              body.name,
              sha256(token),
              Date.now(),
            );
          });
          audit(pairing.user_id, 'computer.device.paired', id);
          return { deviceId: id, token };
        },
      });
      http.route({
        method: 'DELETE',
        url: '/api/computer/devices/:deviceId',
        access: 'user',
        sessionOnly: true,
        params: deviceParams,
        handler: ({ user, params }) => {
          requireDevice(user.userId, params.deviceId);
          db.transaction(() => {
            for (const row of db.all<{ id: string }>(
              'SELECT id FROM computer_actions WHERE device_id = ?',
              params.deviceId,
            )) {
              screenshots.delete(row.id);
            }
            db.run(
              'DELETE FROM computer_devices WHERE id = ? AND user_id = ?',
              params.deviceId,
              user.userId,
            );
          });
          audit(user.userId, 'computer.device.revoked', params.deviceId);
        },
      });
      http.route({
        method: 'GET',
        url: '/api/computer/actions',
        access: 'user',
        sessionOnly: true,
        handler: ({ user }) => {
          purge();
          return {
            actions: db
              .all<Action>(
                'SELECT * FROM computer_actions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
                user.userId,
              )
              .map(present),
          };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/actions',
        access: 'user',
        sessionOnly: true,
        body: computerProposalInputSchema,
        handler: ({ user, body }) => propose(user, body, null),
      });
      http.route({
        method: 'POST',
        url: '/api/computer/actions/:actionId/approve',
        access: 'user',
        sessionOnly: true,
        params: actionParams,
        body: computerApproveSchema,
        handler: ({ user, params, body }) => {
          const row = requireAction(user.userId, params.actionId);
          if (
            row.status !== 'pending' ||
            JSON.stringify(body.action) !== JSON.stringify(actionOf(row))
          )
            throw conflict(
              'The action is no longer awaiting this approval.',
              'computer_approval_stale',
            );
          db.run(
            "UPDATE computer_actions SET status = 'approved', expires_at = ? WHERE id = ?",
            Date.now() + 120_000,
            row.id,
          );
          audit(user.userId, 'computer.action.approved', row.id);
          return present(requireAction(user.userId, row.id));
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/actions/:actionId/reject',
        access: 'user',
        sessionOnly: true,
        params: actionParams,
        handler: ({ user, params }) => {
          const row = requireAction(user.userId, params.actionId);
          if (!['pending', 'approved', 'leased'].includes(row.status))
            throw conflict('The action already finished or began executing.');
          db.run(
            "UPDATE computer_actions SET status = 'rejected', lease_hash = NULL, result = 'Cancelled by the user.' WHERE id = ?",
            row.id,
          );
          return present(requireAction(user.userId, row.id));
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/poll',
        access: 'self',
        body: computerPollSchema,
        rateLimit: { max: 120, windowMs: 60_000 },
        handler: ({ request, body }) => {
          const device = authenticate(request.headers.authorization);
          purge();
          db.run(
            'UPDATE computer_devices SET last_seen_at = ?, width = ?, height = ? WHERE id = ?',
            Date.now(),
            body.width,
            body.height,
            device.id,
          );
          if (
            db.get(
              "SELECT id FROM computer_actions WHERE device_id = ? AND status IN ('leased','executing')",
              device.id,
            )
          )
            return null;
          const row = db.get<Action>(
            "SELECT * FROM computer_actions WHERE device_id = ? AND status = 'approved' ORDER BY created_at LIMIT 1",
            device.id,
          );
          if (!row) return null;
          const action = actionOf(row);
          if (action.kind === 'click' && (action.x >= body.width || action.y >= body.height)) {
            db.run(
              "UPDATE computer_actions SET status = 'failed', result = 'Coordinates are outside the current primary screen.' WHERE id = ?",
              row.id,
            );
            return null;
          }
          const lease = randomToken(),
            expiresAt = Date.now() + 120_000;
          db.run(
            "UPDATE computer_actions SET status = 'leased', lease_hash = ?, expires_at = ? WHERE id = ?",
            sha256(lease),
            expiresAt,
            row.id,
          );
          return { id: row.id, action, lease, expiresAt };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/actions/:actionId/authorize',
        access: 'self',
        params: actionParams,
        body: computerLeaseRequestSchema,
        handler: ({ request, params, body }) => {
          const device = authenticate(request.headers.authorization),
            row = leaseAction(device, params.actionId, body.lease);
          if (row.status !== 'leased')
            throw conflict('This execution authorization was already consumed.');
          db.run(
            "UPDATE computer_actions SET status = 'executing', expires_at = ? WHERE id = ?",
            Date.now() + 30_000,
            row.id,
          );
          audit(device.user_id, 'computer.action.dispatched', row.id);
          return { authorized: true, expiresAt: Date.now() + 30_000 };
        },
      });
      http.route({
        method: 'POST',
        url: '/api/computer/actions/:actionId/complete',
        access: 'self',
        params: actionParams,
        body: computerCompleteSchema,
        bodyLimit: Math.ceil(COMPUTER_LIMITS.screenshotBytes / 3) * 4 + 4096,
        handler: ({ request, params, body }) => {
          const device = authenticate(request.headers.authorization),
            row = leaseAction(device, params.actionId, body.lease);
          const action = actionOf(row);
          if (body.success && row.status !== 'executing')
            throw conflict('Local confirmation must authorize the action first.');
          if (body.screenshot !== undefined && (!body.success || action.kind !== 'screenshot'))
            throw badRequest('This action cannot attach a screenshot.');
          if (body.success && action.kind === 'screenshot' && body.screenshot === undefined)
            throw badRequest('A screenshot result is required.');
          if (body.screenshot !== undefined) {
            const bytes = Buffer.from(body.screenshot, 'base64');
            if (
              bytes.length < 4 ||
              bytes.length > COMPUTER_LIMITS.screenshotBytes ||
              bytes[0] !== 255 ||
              bytes[1] !== 216 ||
              bytes[bytes.length - 2] !== 255 ||
              bytes[bytes.length - 1] !== 217
            )
              throw badRequest('Invalid or oversized JPEG screenshot.');
            // Only the most recent screenshot per device is retained, in memory for five minutes.
            for (const old of db.all<{ id: string }>(
              'SELECT id FROM computer_actions WHERE device_id = ?',
              device.id,
            ))
              screenshots.delete(old.id);
            if (screenshots.size >= 20) screenshots.delete(screenshots.keys().next().value!);
            screenshots.set(row.id, {
              userId: device.user_id,
              bytes,
              until: Date.now() + FIVE_MINUTES,
            });
            setTimeout(() => screenshots.delete(row.id), FIVE_MINUTES).unref();
          }
          db.run(
            'UPDATE computer_actions SET status = ?, result = ?, lease_hash = NULL WHERE id = ?',
            body.success ? 'completed' : 'failed',
            body.success
              ? 'The companion reported completion.'
              : 'The local user declined or the companion could not complete this action.',
            row.id,
          );
          audit(
            device.user_id,
            body.success ? 'computer.action.completed' : 'computer.action.failed',
            row.id,
          );
          return { accepted: true };
        },
      });
      http.route({
        method: 'GET',
        url: '/api/computer/actions/:actionId/screenshot',
        access: 'user',
        sessionOnly: true,
        params: actionParams,
        handler: ({ user, params }) => {
          requireAction(user.userId, params.actionId);
          const item = screenshots.get(params.actionId);
          if (!item || item.userId !== user.userId)
            throw notFound(
              'The screenshot expired or was already viewed.',
              'computer_screenshot_expired',
            );
          screenshots.delete(params.actionId);
          return { mediaType: 'image/jpeg', data: item.bytes.toString('base64') };
        },
      });
      context.bus.on('auth.user.deleted', (event) => {
        const { userId } = event.data as { userId: string };
        for (const [id, item] of screenshots) if (item.userId === userId) screenshots.delete(id);
      });
      context.agentTools.register({
        name: 'computer_devices',
        description:
          'List only your explicitly paired Windows devices. Devices do not grant permission to act.',
        input: z.object({}).strict(),
        effect: 'read',
        handler: (tool) => ({
          text: JSON.stringify(
            db
              .all<Device>('SELECT * FROM computer_devices WHERE user_id = ?', tool.userId)
              .map(presentDevice),
          ),
        }),
      });
      context.agentTools.register({
        name: 'computer_propose',
        description:
          'Propose one screenshot, primary-screen click, or literal text entry on your paired Windows device. A person must approve the exact action in Devices and confirm locally. This tool never executes an action and never returns screenshots.',
        input: computerProposalInputSchema,
        effect: 'write',
        handler: (tool, input) => {
          const user = context.services.agents.principalFor(tool.userId);
          if (!user) throw unauthorized();
          const session = context.services.agents.getSession(user, tool.sessionId);
          if (session.userId !== user.userId) throw missing();
          const row = propose(user, input, session.id);
          return {
            text: `Proposed action ${row.id}. Awaiting explicit approval in Devices and local confirmation; nothing has executed.`,
          };
        },
      });
    },
    stop() {
      screenshots.clear();
    },
  };
}
export const computerModule = createComputerModule();
