/**
 * Direct messages: one-to-one conversations between people who share a group.
 * Either side can block the other; a blocked person cannot send, and the blocker sees nothing
 * new from them. Under-18 accounts can message only people in their class groups.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iso, num, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import { hasBlocked, idParam, loadPeople, loadPerson, notify, pageQuery, shareAGroup, text, uuid, type Deps, type Person } from './common.js';

export interface DirectMessage {
  id: number;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  other: Person | null;
  lastMessage: DirectMessage | null;
  unread: number;
  createdAt: string;
}

interface DmRow {
  id: unknown;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: unknown;
}

const toDm = (r: DmRow): DirectMessage => ({ id: num(r.id), conversationId: r.conversation_id, senderId: r.sender_id, body: r.body, createdAt: iso(r.created_at) });

async function otherMember(q: Queryable, conversationId: string, userId: string): Promise<string> {
  const me = await q.query('select 1 from conversation_members where conversation_id = $1 and user_id = $2', [conversationId, userId]);
  if (!me.rows.length) throw new HttpError(404, 'not_found', 'No such conversation.');
  const r = await q.query<{ user_id: string }>('select user_id from conversation_members where conversation_id = $1 and user_id <> $2', [conversationId, userId]);
  return r.rows[0]?.user_id ?? userId;
}

async function sharedClassGroup(q: Queryable, a: string, b: string): Promise<boolean> {
  const r = await q.query(
    "select 1 from group_members x join group_members y on y.group_id = x.group_id join groups g on g.id = x.group_id where x.user_id = $1 and y.user_id = $2 and g.kind = 'class' limit 1",
    [a, b],
  );
  return r.rows.length > 0;
}

export function registerMessages(app: FastifyInstance, deps: Deps): void {
  const { db, requireAuth, hub } = deps;

  app.get('/api/conversations', { preHandler: requireAuth }, async (req) => {
    const userId = req.userId!;
    const r = await db.query<{ id: string; created_at: unknown; other_id: string | null; last_read_at: unknown }>(
      `select c.id, c.created_at, m.last_read_at, (select o.user_id from conversation_members o where o.conversation_id = c.id and o.user_id <> $1 limit 1) as other_id
         from conversations c join conversation_members m on m.conversation_id = c.id and m.user_id = $1
        order by (select max(created_at) from direct_messages d where d.conversation_id = c.id) desc nulls last, c.created_at desc limit 100`,
      [userId],
    );
    const people = await loadPeople(db, r.rows.map((c) => c.other_id).filter((x): x is string => !!x));
    const conversations: Conversation[] = [];
    for (const c of r.rows) {
      const last = await db.query<DmRow>('select id, conversation_id, sender_id, body, created_at from direct_messages where conversation_id = $1 order by created_at desc limit 1', [c.id]);
      const unread = await db.query<{ n: unknown }>(
        'select count(*) as n from direct_messages where conversation_id = $1 and sender_id <> $2 and ($3::timestamptz is null or created_at > $3)',
        [c.id, userId, c.last_read_at ?? null],
      );
      conversations.push({
        id: c.id,
        other: c.other_id ? (people.get(c.other_id) ?? null) : null,
        lastMessage: last.rows[0] ? toDm(last.rows[0]) : null,
        unread: num(unread.rows[0].n),
        createdAt: iso(c.created_at),
      });
    }
    return { conversations };
  });

  /** Opens (or finds) the one-to-one conversation with someone you share a group with. */
  app.post('/api/conversations', { preHandler: requireAuth }, async (req, reply) => {
    const { userId: target } = z.object({ userId: uuid }).parse(req.body);
    const userId = req.userId!;
    if (target === userId) throw new HttpError(400, 'invalid', 'That is you.');
    const other = await loadPerson(db, target);
    if (!other) throw new HttpError(404, 'not_found', 'No such person.');
    if (!(await shareAGroup(db, userId, target))) throw new HttpError(403, 'no_shared_group', 'You can message people you share a group with.');
    const age = await db.query<{ age_band: string }>('select age_band from profiles where user_id = any($1::uuid[]) and age_band = $2', [[userId, target], 'under_18']);
    if (age.rows.length && !(await sharedClassGroup(db, userId, target))) {
      throw new HttpError(403, 'minor_protection', 'Under-18 accounts can message only within their class groups.');
    }
    if (await hasBlocked(db, target, userId)) throw new HttpError(403, 'blocked', 'You cannot message this person.');
    if (await hasBlocked(db, userId, target)) throw new HttpError(403, 'you_blocked', 'You have blocked this person. Unblock them first.');
    const existing = await db.query<{ conversation_id: string }>(
      `select a.conversation_id from conversation_members a join conversation_members b on b.conversation_id = a.conversation_id
        where a.user_id = $1 and b.user_id = $2 limit 1`,
      [userId, target],
    );
    if (existing.rows[0]) return { conversationId: existing.rows[0].conversation_id, other };
    const id = await db.transaction(async (tx) => {
      const c = await tx.query<{ id: string }>('insert into conversations default values returning id');
      await tx.query('insert into conversation_members (conversation_id, user_id) values ($1, $2), ($1, $3)', [c.rows[0].id, userId, target]);
      return c.rows[0].id;
    });
    return reply.status(201).send({ conversationId: id, other });
  });

  app.get('/api/conversations/:id/messages', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit, before } = pageQuery(req.query);
    const userId = req.userId!;
    const otherId = await otherMember(db, id, userId);
    const other = otherId === userId ? null : await loadPerson(db, otherId);
    const r = await db.query<DmRow>(
      `select id, conversation_id, sender_id, body, created_at from direct_messages where conversation_id = $1 and ($2::timestamptz is null or created_at < $2)
        order by created_at desc limit $3`,
      [id, before ?? null, limit],
    );
    if (!before) await db.query('update conversation_members set last_read_at = now() where conversation_id = $1 and user_id = $2', [id, userId]);
    return { messages: r.rows.reverse().map(toDm), other, blocked: other ? await hasBlocked(db, userId, other.id) : false };
  });

  app.post('/api/conversations/:id/messages', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { body } = z.object({ body: text(4000) }).parse(req.body);
    const userId = req.userId!;
    const otherId = await otherMember(db, id, userId);
    if (otherId !== userId) {
      if (await hasBlocked(db, otherId, userId)) throw new HttpError(403, 'blocked', 'You cannot message this person.');
      if (await hasBlocked(db, userId, otherId)) throw new HttpError(403, 'you_blocked', 'You have blocked this person. Unblock them first.');
    }
    const r = await db.query<DmRow>('insert into direct_messages (conversation_id, sender_id, body) values ($1, $2, $3) returning id, conversation_id, sender_id, body, created_at', [id, userId, body]);
    await db.query('update conversation_members set last_read_at = now() where conversation_id = $1 and user_id = $2', [id, userId]);
    const message = toDm(r.rows[0]);
    if (otherId !== userId) {
      hub.sendToUser(otherId, { type: 'dm', conversationId: id, message });
      // One unread "new message" notice per conversation, not one per line.
      const pending = await db.query('select 1 from notifications where user_id = $1 and link = $2 and read_at is null limit 1', [otherId, `/messages/${id}`]);
      if (!pending.rows.length) {
        const me = await loadPerson(db, userId);
        await notify(db, hub, [otherId], { kind: 'message', title: `New message from ${me?.displayName ?? 'someone'}`, link: `/messages/${id}` });
      }
    }
    return reply.status(201).send({ message });
  });
}
