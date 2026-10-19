/**
 * Realtime: one WebSocket per browser tab, rooms per group.
 *
 * Protocol (JSON text frames):
 *   client → { type: 'auth', token }                      first frame; the session token
 *   server → { type: 'ready', userId }
 *   client → { type: 'join', groupId } / { type: 'leave', groupId }
 *   server → { type: 'presence', groupId, online: [{ displayName, avatarUrl }] }
 *   client → { type: 'message', groupId, body, replyTo? }  persisted, then broadcast to the room
 *   server → { type: 'message', groupId, message }
 *   server → { type: 'dm', conversationId, message }, { type: 'notification', notification }
 *   client → { type: 'ping' }  server → { type: 'pong' }
 *
 * Presence carries display name and avatar only (never ids, emails or roles), and a person
 * with two tabs open appears once. Messages a recipient has blocked are not delivered to them.
 */

import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { iso, num, type Db, type Queryable } from './db.js';
import { hashToken } from './auth.js';
import { blockedBy, groupRole, loadPerson, type Person } from './common.js';

export interface GroupMessage {
  id: number;
  groupId: string;
  author: Person | null;
  body: string;
  replyTo: number | null;
  createdAt: string;
  deletedAt: string | null;
}

interface Client {
  socket: WebSocket;
  userId: string;
  person: Person;
  rooms: Set<string>;
  blocked: Set<string>;
}

export interface Hub {
  /** Everyone in the room gets the payload, except users who have blocked `fromUserId`. */
  broadcast(groupId: string, payload: unknown, fromUserId?: string): void;
  sendToUser(userId: string, payload: unknown): void;
  presence(groupId: string): Array<{ displayName: string; avatarUrl: string | null }>;
  /** Called by the group routes so a REST-posted message also reaches open tabs. */
  attach(client: Client): void;
  detach(client: Client): void;
  join(client: Client, groupId: string): void;
  leave(client: Client, groupId: string): void;
  /** For tests. */
  size(): number;
}

export function createHub(): Hub {
  const rooms = new Map<string, Set<Client>>();
  const byUser = new Map<string, Set<Client>>();

  const send = (c: Client, payload: unknown) => {
    if (c.socket.readyState === c.socket.OPEN) c.socket.send(JSON.stringify(payload));
  };

  const presence = (groupId: string) => {
    const seen = new Map<string, { displayName: string; avatarUrl: string | null }>();
    for (const c of rooms.get(groupId) ?? []) seen.set(c.userId, { displayName: c.person.displayName, avatarUrl: c.person.avatarUrl });
    return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  };

  const pushPresence = (groupId: string) => {
    const payload = { type: 'presence', groupId, online: presence(groupId) };
    for (const c of rooms.get(groupId) ?? []) send(c, payload);
  };

  const hub: Hub = {
    broadcast(groupId, payload, fromUserId) {
      for (const c of rooms.get(groupId) ?? []) {
        if (fromUserId && c.userId !== fromUserId && c.blocked.has(fromUserId)) continue;
        send(c, payload);
      }
    },
    sendToUser(userId, payload) {
      for (const c of byUser.get(userId) ?? []) send(c, payload);
    },
    presence,
    attach(c) {
      if (!byUser.has(c.userId)) byUser.set(c.userId, new Set());
      byUser.get(c.userId)!.add(c);
    },
    detach(c) {
      for (const g of [...c.rooms]) hub.leave(c, g);
      const set = byUser.get(c.userId);
      set?.delete(c);
      if (set && set.size === 0) byUser.delete(c.userId);
    },
    join(c, groupId) {
      if (!rooms.has(groupId)) rooms.set(groupId, new Set());
      rooms.get(groupId)!.add(c);
      c.rooms.add(groupId);
      pushPresence(groupId);
    },
    leave(c, groupId) {
      const room = rooms.get(groupId);
      if (!room) return;
      room.delete(c);
      c.rooms.delete(groupId);
      if (room.size === 0) rooms.delete(groupId);
      else pushPresence(groupId);
    },
    size() {
      let n = 0;
      for (const s of byUser.values()) n += s.size;
      return n;
    },
  };
  return hub;
}

/* ----------------------------------------------------------------------------- messages */

export const MESSAGE_MAX = 4000;

export interface MessageRow {
  id: unknown;
  group_id: string;
  user_id: string;
  body: string;
  reply_to: unknown;
  created_at: unknown;
  deleted_at: unknown;
}

export function toMessage(r: MessageRow, people: Map<string, Person>): GroupMessage {
  const deleted = !!r.deleted_at;
  return {
    id: num(r.id),
    groupId: r.group_id,
    author: people.get(r.user_id) ?? null,
    body: deleted ? '' : r.body,
    replyTo: r.reply_to === null || r.reply_to === undefined ? null : num(r.reply_to),
    createdAt: iso(r.created_at),
    deletedAt: deleted ? iso(r.deleted_at) : null,
  };
}

/** Persists a chat message (members only, 1 to 4000 characters) and pushes it to the room. */
export async function postGroupMessage(q: Queryable, hub: Hub, groupId: string, userId: string, body: string, replyTo: number | null): Promise<GroupMessage> {
  const r = await q.query<MessageRow>(
    'insert into group_messages (group_id, user_id, body, reply_to) values ($1, $2, $3, $4) returning id, group_id, user_id, body, reply_to, created_at, deleted_at',
    [groupId, userId, body, replyTo],
  );
  const person = await loadPerson(q, userId);
  const message = toMessage(r.rows[0], new Map(person ? [[userId, person]] : []));
  hub.broadcast(groupId, { type: 'message', groupId, message }, userId);
  return message;
}

/* ----------------------------------------------------------------------------- the endpoint */

const frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(200) }),
  z.object({ type: z.literal('join'), groupId: z.string().uuid() }),
  z.object({ type: z.literal('leave'), groupId: z.string().uuid() }),
  z.object({ type: z.literal('message'), groupId: z.string().uuid(), body: z.string().trim().min(1).max(MESSAGE_MAX), replyTo: z.number().int().positive().nullable().optional() }),
  z.object({ type: z.literal('ping') }),
]);

export async function registerRealtime(app: FastifyInstance, deps: { db: Db; hub: Hub }): Promise<void> {
  const { db, hub } = deps;
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/api/ws', { websocket: true }, (socket) => {
    let client: Client | null = null;
    const reply = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
    };
    const fail = (code: string, message: string) => reply({ type: 'error', code, message });

    // A socket that never authenticates is dropped.
    const authTimer = setTimeout(() => {
      if (!client) socket.close(4001, 'auth timeout');
    }, 10_000);

    socket.on('message', (raw: unknown) => {
      void (async () => {
        let parsed: z.infer<typeof frame>;
        try {
          parsed = frame.parse(JSON.parse(String(raw)));
        } catch {
          return fail('bad_frame', 'That message was not understood.');
        }
        if (parsed.type === 'ping') return reply({ type: 'pong' });
        if (parsed.type === 'auth') {
          if (client) return;
          const s = await db.query<{ user_id: string }>('select user_id from sessions where token_hash = $1 and expires_at > now()', [hashToken(parsed.token)]);
          const userId = s.rows[0]?.user_id;
          const person = userId ? await loadPerson(db, userId) : null;
          if (!userId || !person) {
            fail('unauthorized', 'Please sign in again.');
            return socket.close(4001, 'unauthorized');
          }
          client = { socket, userId, person, rooms: new Set(), blocked: await blockedBy(db, userId) };
          hub.attach(client);
          clearTimeout(authTimer);
          return reply({ type: 'ready', userId });
        }
        if (!client) return fail('unauthorized', 'Send auth first.');
        if (parsed.type === 'join') {
          const role = await groupRole(db, parsed.groupId, client.userId);
          if (!role) return fail('not_a_member', 'You are not a member of this group.');
          client.blocked = await blockedBy(db, client.userId);
          hub.join(client, parsed.groupId);
          return;
        }
        if (parsed.type === 'leave') return hub.leave(client, parsed.groupId);
        if (parsed.type === 'message') {
          const role = await groupRole(db, parsed.groupId, client.userId);
          if (!role) return fail('not_a_member', 'You are not a member of this group.');
          const message = await postGroupMessage(db, hub, parsed.groupId, client.userId, parsed.body, parsed.replyTo ?? null);
          // The sender's own tab gets it too (broadcast skips nobody but blockers).
          if (!client.rooms.has(parsed.groupId)) reply({ type: 'message', groupId: parsed.groupId, message });
        }
      })().catch((err) => {
        app.log.error(err);
        fail('server_error', 'Something went wrong.');
      });
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (client) hub.detach(client);
      client = null;
    });
    socket.on('error', () => {
      if (client) hub.detach(client);
      client = null;
    });
  });
}
