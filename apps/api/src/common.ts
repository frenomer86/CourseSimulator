/**
 * Shared pieces for the community and competition routes: who someone is (the safe public
 * shape), who may do what (the access rules from docs/reference/community-and-competition-schema.sql,
 * enforced here instead of row-level security), notifications, and join codes.
 */

import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { iso, num, type Db, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import type { PlatformRole } from './types.js';
import type { Hub } from './realtime.js';

export interface Deps {
  db: Db;
  requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  hub: Hub;
}

/* ----------------------------------------------------------------------------- people */

/** What other members see of someone: never an email, never an age band. */
export interface Person {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  platformRole: PlatformRole;
}

export interface PersonRow {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  platform_role: PlatformRole;
}

export const PERSON_SELECT = 'p.user_id, p.username, p.display_name, p.avatar_url, p.platform_role';

export function toPerson(r: PersonRow): Person {
  return { id: r.user_id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, platformRole: r.platform_role };
}

export async function loadPerson(q: Queryable, userId: string): Promise<Person | null> {
  const r = await q.query<PersonRow>(`select ${PERSON_SELECT} from profiles p where p.user_id = $1`, [userId]);
  return r.rows[0] ? toPerson(r.rows[0]) : null;
}

export async function loadPeople(q: Queryable, ids: string[]): Promise<Map<string, Person>> {
  const out = new Map<string, Person>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const r = await q.query<PersonRow>(`select ${PERSON_SELECT} from profiles p where p.user_id = any($1::uuid[])`, [unique]);
  for (const row of r.rows) out.set(row.user_id, toPerson(row));
  return out;
}

export async function platformRole(q: Queryable, userId: string): Promise<PlatformRole> {
  const r = await q.query<{ platform_role: PlatformRole }>('select platform_role from profiles where user_id = $1', [userId]);
  return r.rows[0]?.platform_role ?? 'learner';
}

export const isFacilitatorRole = (role: PlatformRole) => role === 'facilitator' || role === 'moderator' || role === 'admin';
export const isModeratorRole = (role: PlatformRole) => role === 'moderator' || role === 'admin';

/* ----------------------------------------------------------------------------- groups */

export type GroupRole = 'owner' | 'admin' | 'member';

export async function groupRole(q: Queryable, groupId: string, userId: string): Promise<GroupRole | null> {
  const r = await q.query<{ role: GroupRole }>('select role from group_members where group_id = $1 and user_id = $2', [groupId, userId]);
  return r.rows[0]?.role ?? null;
}

export const isGroupAdminRole = (role: GroupRole | null) => role === 'owner' || role === 'admin';

/** Members only: 403 otherwise (404 would leak nothing more, but a clear message helps a learner who left). */
export async function requireGroupMember(q: Queryable, groupId: string, userId: string): Promise<GroupRole> {
  const role = await groupRole(q, groupId, userId);
  if (!role) throw new HttpError(403, 'not_a_member', 'You are not a member of this group.');
  return role;
}

export async function requireGroupAdmin(q: Queryable, groupId: string, userId: string): Promise<GroupRole> {
  const role = await groupRole(q, groupId, userId);
  if (!isGroupAdminRole(role)) throw new HttpError(403, 'not_group_admin', 'Only the group owner or an admin can do that.');
  return role!;
}

export async function shareAGroup(q: Queryable, a: string, b: string): Promise<boolean> {
  const r = await q.query('select 1 from group_members x join group_members y on y.group_id = x.group_id where x.user_id = $1 and y.user_id = $2 limit 1', [a, b]);
  return r.rows.length > 0;
}

/* ----------------------------------------------------------------------------- blocks */

/** Users that `userId` has blocked. Their messages are hidden from `userId`. */
export async function blockedBy(q: Queryable, userId: string): Promise<Set<string>> {
  const r = await q.query<{ blocked_id: string }>('select blocked_id from blocks where blocker_id = $1', [userId]);
  return new Set(r.rows.map((x) => x.blocked_id));
}

export async function hasBlocked(q: Queryable, blockerId: string, blockedId: string): Promise<boolean> {
  const r = await q.query('select 1 from blocks where blocker_id = $1 and blocked_id = $2', [blockerId, blockedId]);
  return r.rows.length > 0;
}

/* ----------------------------------------------------------------------------- notifications */

export type NotificationKind = 'reply' | 'mention' | 'accepted' | 'invite' | 'deadline' | 'contest' | 'message' | 'task';

export interface Notification {
  id: number;
  kind: NotificationKind;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export async function notify(
  q: Queryable,
  hub: Hub | null,
  userIds: string[],
  n: { kind: NotificationKind; title: string; body?: string | null; link?: string | null },
): Promise<void> {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const r = await q.query<{ id: unknown; created_at: unknown }>(
      'insert into notifications (user_id, kind, title, body, link) values ($1, $2, $3, $4, $5) returning id, created_at',
      [userId, n.kind, n.title.slice(0, 200), n.body?.slice(0, 500) ?? null, n.link ?? null],
    );
    hub?.sendToUser(userId, {
      type: 'notification',
      notification: { id: num(r.rows[0].id), kind: n.kind, title: n.title, body: n.body ?? null, link: n.link ?? null, readAt: null, createdAt: iso(r.rows[0].created_at) },
    });
  }
}

/** @username mentions in a body, resolved to user ids (never the author's own). */
export async function mentionedUserIds(q: Queryable, body: string, exceptUserId: string): Promise<string[]> {
  const names = [...new Set((body.match(/(?:^|[^\w])@([a-z0-9_]{3,24})\b/g) ?? []).map((m) => m.replace(/^[^@]*@/, '')))].slice(0, 20);
  if (names.length === 0) return [];
  const r = await q.query<{ user_id: string }>('select user_id from profiles where username = any($1::text[]) and user_id <> $2', [names, exceptUserId]);
  return r.rows.map((x) => x.user_id);
}

/* ----------------------------------------------------------------------------- codes and ids */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I

export function newJoinCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export const uuid = z.string().uuid();
export const idParam = z.object({ id: uuid });

export function pageQuery(q: unknown): { limit: number; before?: string } {
  const p = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.string().datetime({ offset: true }).optional() }).parse(q ?? {});
  return p;
}

/** A plain text field: trimmed, bounded, never empty. */
export const text = (max: number, min = 1) => z.string().trim().min(min).max(max);
