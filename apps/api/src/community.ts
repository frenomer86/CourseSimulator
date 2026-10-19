/**
 * Groups, group chat (REST side), resources, facilitator tasks, blocks, notifications, reports
 * and public profiles. Access rules follow the reference schema's policies:
 *
 *   groups        read: public or member · create: anyone signed in (becomes owner) ·
 *                 update: owner/admin · delete: owner
 *   members       read: member, or the group is public · join: self, public group or join code ·
 *                 leave: self, or owner/admin removes · roles: owner/admin, never the owner's
 *   messages      read/send: members · delete: author, owner/admin or moderator · 4000 chars
 *   resources     group ones to members · course library to everyone signed in · solution shares
 *                 to the owner and to those who passed the same lab · manage: owner, group admin, moderator
 *   tasks         create/delete: a facilitator who is owner/admin · read: members ·
 *                 per-member completion: owner/admin
 *   blocks, notifications: own · reports: anyone signed in creates
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iso, num, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import { levelFromXp } from './types.js';
import {
  blockedBy,
  groupRole,
  idParam,
  isFacilitatorRole,
  isGroupAdminRole,
  isModeratorRole,
  loadPeople,
  loadPerson,
  newJoinCode,
  notify,
  pageQuery,
  platformRole,
  requireGroupAdmin,
  requireGroupMember,
  text,
  toPerson,
  uuid,
  type Deps,
  type GroupRole,
  type Notification,
  type Person,
  type PersonRow,
} from './common.js';
import { MESSAGE_MAX, postGroupMessage, toMessage, type MessageRow } from './realtime.js';

/* ----------------------------------------------------------------------------- shapes */

export interface Group {
  id: string;
  kind: 'study' | 'class' | 'team';
  name: string;
  description: string | null;
  visibility: 'public' | 'invite';
  courseSlug: string | null;
  createdBy: string;
  createdAt: string;
  memberCount: number;
  /** The caller's role, null when not a member. */
  myRole: GroupRole | null;
  /** Only sent to members. */
  joinCode: string | null;
}

interface GroupRow {
  id: string;
  kind: Group['kind'];
  name: string;
  description: string | null;
  visibility: Group['visibility'];
  course_slug: string | null;
  join_code: string;
  created_by: string;
  created_at: unknown;
  member_count: unknown;
  my_role: GroupRole | null;
}

const GROUP_SELECT = `g.id, g.kind, g.name, g.description, g.visibility, g.course_slug, g.join_code, g.created_by, g.created_at,
  (select count(*) from group_members m where m.group_id = g.id) as member_count,
  (select m.role from group_members m where m.group_id = g.id and m.user_id = $1) as my_role`;

function toGroup(r: GroupRow): Group {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    courseSlug: r.course_slug,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    memberCount: num(r.member_count),
    myRole: r.my_role,
    joinCode: r.my_role ? r.join_code : null,
  };
}

async function loadGroup(q: Queryable, groupId: string, userId: string): Promise<Group | null> {
  const r = await q.query<GroupRow>(`select ${GROUP_SELECT} from groups g where g.id = $2`, [userId, groupId]);
  return r.rows[0] ? toGroup(r.rows[0]) : null;
}

/** 404 for a group the caller may not see (invite-only and not a member), so its existence is not confirmed. */
async function requireVisibleGroup(q: Queryable, groupId: string, userId: string): Promise<Group> {
  const g = await loadGroup(q, groupId, userId);
  if (!g || (g.visibility !== 'public' && !g.myRole)) throw new HttpError(404, 'not_found', 'That group does not exist, or you cannot see it.');
  return g;
}

const groupBody = z.object({
  name: text(80, 3),
  description: z.string().trim().max(1000).optional(),
  visibility: z.enum(['public', 'invite']).default('public'),
  kind: z.enum(['study', 'class', 'team']).default('study'),
  courseSlug: z.string().trim().max(200).optional(),
});

/* ----------------------------------------------------------------------------- resources */

export interface Resource {
  id: string;
  kind: 'link' | 'note' | 'file' | 'solution';
  owner: Person | null;
  groupId: string | null;
  courseSlug: string | null;
  labId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  payload: unknown;
  createdAt: string;
}

interface ResourceRow {
  id: string;
  kind: Resource['kind'];
  owner_id: string;
  group_id: string | null;
  course_slug: string | null;
  lab_id: string | null;
  title: string;
  body: string | null;
  url: string | null;
  payload: unknown;
  created_at: unknown;
}

const RESOURCE_SELECT = 'r.id, r.kind, r.owner_id, r.group_id, r.course_slug, r.lab_id, r.title, r.body, r.url, r.payload, r.created_at';

function toResource(r: ResourceRow, people: Map<string, Person>): Resource {
  return {
    id: r.id,
    kind: r.kind,
    owner: people.get(r.owner_id) ?? null,
    groupId: r.group_id,
    courseSlug: r.course_slug,
    labId: r.lab_id,
    title: r.title,
    body: r.body,
    url: r.url,
    payload: r.payload ?? null,
    createdAt: iso(r.created_at),
  };
}

const resourceBody = z
  .object({
    kind: z.enum(['link', 'note', 'solution']),
    groupId: uuid.optional(),
    courseSlug: z.string().trim().min(1).max(200).optional(),
    labId: z.string().trim().min(1).max(200).optional(),
    title: text(160),
    body: z.string().trim().max(20000).optional(),
    url: z.string().trim().url().max(2000).optional(),
    payload: z.unknown().optional(),
  })
  .refine((b) => b.groupId || b.courseSlug, { message: 'Share to a group or to a course library.' })
  .refine((b) => b.kind !== 'link' || b.url, { message: 'A link needs a web address.' })
  .refine((b) => b.kind !== 'solution' || (b.labId && b.payload !== undefined), { message: 'A solution share needs the lab and your work.' });

async function passedLab(q: Queryable, userId: string, labId: string): Promise<boolean> {
  const r = await q.query('select 1 from lab_results where user_id = $1 and lab_id = $2 and passed limit 1', [userId, labId]);
  return r.rows.length > 0;
}

/* ----------------------------------------------------------------------------- tasks */

export interface TaskItem {
  kind: 'lab' | 'check';
  id: string;
  title?: string;
}

export interface GroupTask {
  id: string;
  groupId: string;
  createdBy: Person | null;
  title: string;
  description: string | null;
  items: TaskItem[];
  dueAt: string | null;
  createdAt: string;
  /** The caller's completion. */
  mine: { done: number; total: number; completedIds: string[] };
}

interface TaskRow {
  id: string;
  group_id: string;
  created_by: string;
  title: string;
  description: string | null;
  items: unknown;
  due_at: unknown;
  created_at: unknown;
}

const taskItem = z.object({ kind: z.enum(['lab', 'check']), id: z.string().trim().min(1).max(200), title: z.string().trim().max(200).optional() });
const taskBody = z.object({
  title: text(160, 3),
  description: z.string().trim().max(2000).optional(),
  items: z.array(taskItem).min(1).max(30),
  dueAt: z.string().datetime({ offset: true }).optional(),
});

/** Which of a task's items a user has completed: a passed lab result, or a passed check attempt. */
async function completedItems(q: Queryable, userId: string, items: TaskItem[]): Promise<string[]> {
  const labIds = items.filter((i) => i.kind === 'lab').map((i) => i.id);
  const checkKeys = items.filter((i) => i.kind === 'check').map((i) => i.id);
  const done: string[] = [];
  if (labIds.length) {
    const r = await q.query<{ lab_id: string }>('select distinct lab_id from lab_results where user_id = $1 and passed and lab_id = any($2::text[])', [userId, labIds]);
    done.push(...r.rows.map((x) => x.lab_id));
  }
  if (checkKeys.length) {
    const r = await q.query<{ key: string }>(
      `select distinct course_slug || ':' || unit_index || ':' || topic_index as key from check_attempts
        where user_id = $1 and passed and course_slug || ':' || unit_index || ':' || topic_index = any($2::text[])`,
      [userId, checkKeys],
    );
    done.push(...r.rows.map((x) => x.key));
  }
  return done;
}

async function toTask(q: Queryable, r: TaskRow, userId: string, people: Map<string, Person>): Promise<GroupTask> {
  const items = (Array.isArray(r.items) ? r.items : []) as TaskItem[];
  const completedIds = await completedItems(q, userId, items);
  return {
    id: r.id,
    groupId: r.group_id,
    createdBy: people.get(r.created_by) ?? null,
    title: r.title,
    description: r.description,
    items,
    dueAt: r.due_at ? iso(r.due_at) : null,
    createdAt: iso(r.created_at),
    mine: { done: completedIds.length, total: items.length, completedIds },
  };
}

/* ----------------------------------------------------------------------------- routes */

export function registerCommunity(app: FastifyInstance, deps: Deps): void {
  const { db, requireAuth, hub } = deps;

  /* ---- groups ---- */

  app.get('/api/groups', { preHandler: requireAuth }, async (req) => {
    const { scope, q: search } = z.object({ scope: z.enum(['mine', 'public']).default('mine'), q: z.string().trim().max(80).optional() }).parse(req.query ?? {});
    const userId = req.userId!;
    const r =
      scope === 'mine'
        ? await db.query<GroupRow>(`select ${GROUP_SELECT} from groups g join group_members gm on gm.group_id = g.id and gm.user_id = $1 order by gm.joined_at desc`, [userId])
        : await db.query<GroupRow>(
            `select ${GROUP_SELECT} from groups g where g.visibility = 'public' and ($2::text is null or g.name ilike '%' || $2 || '%' or coalesce(g.course_slug, '') = $2)
              order by (select count(*) from group_members m where m.group_id = g.id) desc, g.created_at desc limit 50`,
            [userId, search ?? null],
          );
    return { groups: r.rows.map(toGroup) };
  });

  app.post('/api/groups', { preHandler: requireAuth }, async (req, reply) => {
    const body = groupBody.parse(req.body);
    const userId = req.userId!;
    const group = await db.transaction(async (tx) => {
      let id = '';
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newJoinCode();
        const taken = await tx.query('select 1 from groups where join_code = $1', [code]);
        if (taken.rows.length) continue;
        const r = await tx.query<{ id: string }>(
          'insert into groups (kind, name, description, visibility, course_slug, join_code, created_by) values ($1::group_kind, $2, $3, $4::group_visibility, $5, $6, $7) returning id',
          [body.kind, body.name, body.description || null, body.visibility, body.courseSlug || null, code, userId],
        );
        id = r.rows[0].id;
        break;
      }
      if (!id) throw new HttpError(500, 'no_code', 'Could not make a join code. Please try again.');
      await tx.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'owner')", [id, userId]);
      return loadGroup(tx, id, userId);
    });
    return reply.status(201).send({ group });
  });

  app.get('/api/groups/by-code/:code', { preHandler: requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string().trim().toUpperCase().min(4).max(12) }).parse(req.params);
    const r = await db.query<GroupRow>(`select ${GROUP_SELECT} from groups g where g.join_code = $2`, [req.userId, code]);
    if (!r.rows[0]) throw new HttpError(404, 'bad_code', 'No group has that code. Check it with whoever shared it.');
    const g = toGroup(r.rows[0]);
    return { group: { ...g, joinCode: null } };
  });

  app.post('/api/groups/join', { preHandler: requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string().trim().toUpperCase().min(4).max(12) }).parse(req.body);
    const userId = req.userId!;
    const r = await db.query<{ id: string }>('select id from groups where join_code = $1', [code]);
    if (!r.rows[0]) throw new HttpError(404, 'bad_code', 'No group has that code. Check it with whoever shared it.');
    const groupId = r.rows[0].id;
    await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [groupId, userId]);
    return { group: await loadGroup(db, groupId, userId) };
  });

  app.get('/api/groups/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const group = await requireVisibleGroup(db, id, req.userId!);
    return { group, online: group.myRole ? hub.presence(id) : [] };
  });

  app.patch('/api/groups/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = groupBody.partial().parse(req.body);
    await requireGroupAdmin(db, id, req.userId!);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.name !== undefined) add('name', body.name);
    if (body.description !== undefined) add('description', body.description || null);
    if (body.visibility !== undefined) add('visibility', body.visibility);
    if (body.courseSlug !== undefined) add('course_slug', body.courseSlug || null);
    if (sets.length) await db.query(`update groups set ${sets.join(', ')} where id = $1`, params);
    return { group: await loadGroup(db, id, req.userId!) };
  });

  app.post('/api/groups/:id/code', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    await requireGroupAdmin(db, id, req.userId!);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newJoinCode();
      const taken = await db.query('select 1 from groups where join_code = $1', [code]);
      if (taken.rows.length) continue;
      await db.query('update groups set join_code = $2 where id = $1', [id, code]);
      break;
    }
    return { group: await loadGroup(db, id, req.userId!) };
  });

  app.delete('/api/groups/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const role = await groupRole(db, id, req.userId!);
    const pr = await platformRole(db, req.userId!);
    if (role !== 'owner' && pr !== 'admin') throw new HttpError(403, 'not_owner', 'Only the group owner can delete it.');
    await db.query('delete from groups where id = $1', [id]);
    return reply.status(204).send();
  });

  /* ---- members ---- */

  app.post('/api/groups/:id/join', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const g = await loadGroup(db, id, userId);
    if (!g || (g.visibility !== 'public' && !g.myRole)) throw new HttpError(404, 'not_found', 'That group does not exist, or it needs a join code.');
    await db.query("insert into group_members (group_id, user_id, role) values ($1, $2, 'member') on conflict do nothing", [id, userId]);
    return { group: await loadGroup(db, id, userId) };
  });

  app.post('/api/groups/:id/leave', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    await db.transaction(async (tx) => {
      const role = await groupRole(tx, id, userId);
      if (!role) return;
      await tx.query('delete from group_members where group_id = $1 and user_id = $2', [id, userId]);
      if (role === 'owner') {
        // Hand the group to the longest-standing admin, else member; an empty group is removed.
        const next = await tx.query<{ user_id: string }>(
          "select user_id from group_members where group_id = $1 order by (role = 'admin') desc, joined_at asc limit 1",
          [id],
        );
        if (next.rows[0]) await tx.query("update group_members set role = 'owner' where group_id = $1 and user_id = $2", [id, next.rows[0].user_id]);
        else await tx.query('delete from groups where id = $1', [id]);
      }
    });
    return reply.status(204).send();
  });

  app.get('/api/groups/:id/members', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    await requireVisibleGroup(db, id, req.userId!);
    const r = await db.query<PersonRow & { role: GroupRole; joined_at: unknown }>(
      `select p.user_id, p.username, p.display_name, p.avatar_url, p.platform_role, m.role, m.joined_at
         from group_members m join profiles p on p.user_id = m.user_id where m.group_id = $1
        order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, m.joined_at`,
      [id],
    );
    return { members: r.rows.map((row) => ({ ...toPerson(row), role: row.role, joinedAt: iso(row.joined_at) })), online: hub.presence(id) };
  });

  app.patch('/api/groups/:id/members/:userId', { preHandler: requireAuth }, async (req) => {
    const { id, userId: target } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const { role } = z.object({ role: z.enum(['admin', 'member']) }).parse(req.body);
    await requireGroupAdmin(db, id, req.userId!);
    const current = await groupRole(db, id, target);
    if (!current) throw new HttpError(404, 'not_found', 'That person is not in the group.');
    if (current === 'owner') throw new HttpError(403, 'is_owner', "The owner's role cannot be changed.");
    await db.query('update group_members set role = $3::group_role where group_id = $1 and user_id = $2', [id, target, role]);
    return { ok: true };
  });

  app.delete('/api/groups/:id/members/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const { id, userId: target } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    await requireGroupAdmin(db, id, req.userId!);
    const current = await groupRole(db, id, target);
    if (current === 'owner') throw new HttpError(403, 'is_owner', 'The owner cannot be removed.');
    await db.query('delete from group_members where group_id = $1 and user_id = $2', [id, target]);
    return reply.status(204).send();
  });

  /* ---- chat (REST; the WebSocket in realtime.ts is the live path) ---- */

  app.get('/api/groups/:id/messages', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { limit, before } = pageQuery(req.query);
    const userId = req.userId!;
    await requireGroupMember(db, id, userId);
    const blocked = await blockedBy(db, userId);
    const r = await db.query<MessageRow>(
      `select id, group_id, user_id, body, reply_to, created_at, deleted_at from group_messages
        where group_id = $1 and ($2::timestamptz is null or created_at < $2) order by created_at desc limit $3`,
      [id, before ?? null, limit],
    );
    const rows = r.rows.filter((m) => !blocked.has(m.user_id)).reverse();
    const people = await loadPeople(db, rows.map((m) => m.user_id));
    return { messages: rows.map((m) => toMessage(m, people)), online: hub.presence(id) };
  });

  app.post('/api/groups/:id/messages', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { body, replyTo } = z.object({ body: text(MESSAGE_MAX), replyTo: z.number().int().positive().nullable().optional() }).parse(req.body);
    const userId = req.userId!;
    await requireGroupMember(db, id, userId);
    const message = await postGroupMessage(db, hub, id, userId, body, replyTo ?? null);
    return reply.status(201).send({ message });
  });

  app.delete('/api/groups/:id/messages/:mid', { preHandler: requireAuth }, async (req, reply) => {
    const { id, mid } = z.object({ id: uuid, mid: z.coerce.number().int().positive() }).parse(req.params);
    const userId = req.userId!;
    const role = await requireGroupMember(db, id, userId);
    const m = await db.query<{ user_id: string }>('select user_id from group_messages where id = $1 and group_id = $2', [mid, id]);
    if (!m.rows[0]) throw new HttpError(404, 'not_found', 'No such message.');
    const allowed = m.rows[0].user_id === userId || isGroupAdminRole(role) || isModeratorRole(await platformRole(db, userId));
    if (!allowed) throw new HttpError(403, 'forbidden', 'You can only remove your own messages.');
    await db.query('update group_messages set deleted_at = now() where id = $1 and deleted_at is null', [mid]);
    hub.broadcast(id, { type: 'message-deleted', groupId: id, id: mid });
    return reply.status(204).send();
  });

  /* ---- resources ---- */

  app.get('/api/resources', { preHandler: requireAuth }, async (req) => {
    const { groupId, courseSlug, labId } = z
      .object({ groupId: uuid.optional(), courseSlug: z.string().trim().max(200).optional(), labId: z.string().trim().max(200).optional() })
      .parse(req.query ?? {});
    const userId = req.userId!;
    let rows: ResourceRow[];
    if (groupId) {
      await requireGroupMember(db, groupId, userId);
      rows = (await db.query<ResourceRow>(`select ${RESOURCE_SELECT} from resources r where r.group_id = $1 order by r.created_at desc limit 200`, [groupId])).rows;
    } else if (labId) {
      // Solution shares for a lab (course library): the owner's own, and others' only once you have passed it.
      const passed = await passedLab(db, userId, labId);
      rows = (
        await db.query<ResourceRow>(
          `select ${RESOURCE_SELECT} from resources r where r.group_id is null and r.lab_id = $1 and r.kind = 'solution' and (r.owner_id = $2 or $3)
            order by r.created_at desc limit 100`,
          [labId, userId, passed],
        )
      ).rows;
    } else if (courseSlug) {
      rows = (
        await db.query<ResourceRow>(
          `select ${RESOURCE_SELECT} from resources r where r.group_id is null and r.course_slug = $1 and r.kind <> 'solution' order by r.created_at desc limit 200`,
          [courseSlug],
        )
      ).rows;
    } else {
      throw new HttpError(400, 'invalid', 'Say which group, course or lab you want resources for.');
    }
    const people = await loadPeople(db, rows.map((r) => r.owner_id));
    return { resources: rows.map((r) => toResource(r, people)) };
  });

  app.post('/api/resources', { preHandler: requireAuth }, async (req, reply) => {
    const body = resourceBody.parse(req.body);
    const userId = req.userId!;
    if (body.groupId) await requireGroupMember(db, body.groupId, userId);
    if (body.kind === 'solution' && !(await passedLab(db, userId, body.labId!))) {
      throw new HttpError(403, 'not_passed', 'You can share a solution once you have passed the lab.');
    }
    const payload = body.payload === undefined ? null : JSON.stringify(body.payload);
    if (payload && payload.length > 200_000) throw new HttpError(400, 'too_large', 'That work is too large to share.');
    const r = await db.query<ResourceRow>(
      `insert into resources (kind, owner_id, group_id, course_slug, lab_id, title, body, url, payload)
       values ($1::resource_kind, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) returning ${RESOURCE_SELECT.replace(/r\./g, '')}`,
      [body.kind, userId, body.groupId ?? null, body.courseSlug ?? null, body.labId ?? null, body.title, body.body || null, body.url ?? null, payload],
    );
    const person = await loadPerson(db, userId);
    return reply.status(201).send({ resource: toResource(r.rows[0], new Map(person ? [[userId, person]] : [])) });
  });

  app.delete('/api/resources/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const r = await db.query<{ owner_id: string; group_id: string | null }>('select owner_id, group_id from resources where id = $1', [id]);
    if (!r.rows[0]) return reply.status(204).send();
    const row = r.rows[0];
    const allowed =
      row.owner_id === userId ||
      isModeratorRole(await platformRole(db, userId)) ||
      (row.group_id !== null && isGroupAdminRole(await groupRole(db, row.group_id, userId)));
    if (!allowed) throw new HttpError(403, 'forbidden', 'Only the person who shared this, a group admin or a moderator can remove it.');
    await db.query('delete from resources where id = $1', [id]);
    return reply.status(204).send();
  });

  /* ---- facilitator tasks ---- */

  async function requireFacilitatorAdmin(q: Queryable, groupId: string, userId: string): Promise<void> {
    const role = await groupRole(q, groupId, userId);
    if (!isGroupAdminRole(role)) throw new HttpError(403, 'not_group_admin', 'Only the group owner or an admin can set tasks.');
    const pr = await platformRole(q, userId);
    if (!isFacilitatorRole(pr)) throw new HttpError(403, 'not_facilitator', 'Setting tasks is for facilitators. You can declare yourself one on your profile.');
  }

  app.get('/api/groups/:id/tasks', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    await requireGroupMember(db, id, userId);
    const r = await db.query<TaskRow>('select id, group_id, created_by, title, description, items, due_at, created_at from group_tasks where group_id = $1 order by created_at desc', [id]);
    const people = await loadPeople(db, r.rows.map((t) => t.created_by));
    const tasks: GroupTask[] = [];
    for (const row of r.rows) tasks.push(await toTask(db, row, userId, people));
    return { tasks };
  });

  app.post('/api/groups/:id/tasks', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = taskBody.parse(req.body);
    const userId = req.userId!;
    await requireFacilitatorAdmin(db, id, userId);
    const r = await db.query<TaskRow>(
      `insert into group_tasks (group_id, created_by, title, description, items, due_at) values ($1, $2, $3, $4, $5::jsonb, $6)
       returning id, group_id, created_by, title, description, items, due_at, created_at`,
      [id, userId, body.title, body.description || null, JSON.stringify(body.items), body.dueAt ?? null],
    );
    const g = await db.query<{ name: string }>('select name from groups where id = $1', [id]);
    const members = await db.query<{ user_id: string }>('select user_id from group_members where group_id = $1 and user_id <> $2', [id, userId]);
    await notify(db, hub, members.rows.map((m) => m.user_id), {
      kind: body.dueAt ? 'deadline' : 'task',
      title: `New task in ${g.rows[0]?.name ?? 'your group'}: ${body.title}`,
      body: body.dueAt ? `Due ${new Date(body.dueAt).toUTCString()}.` : `${body.items.length} item${body.items.length === 1 ? '' : 's'} to complete.`,
      link: `/groups/${id}?tab=tasks`,
    });
    const people = await loadPeople(db, [userId]);
    return reply.status(201).send({ task: await toTask(db, r.rows[0], userId, people) });
  });

  /** Per-member completion: for the owner and admins. Members see only their own on the list. */
  app.get('/api/groups/:id/tasks/:taskId', { preHandler: requireAuth }, async (req) => {
    const { id, taskId } = z.object({ id: uuid, taskId: uuid }).parse(req.params);
    const userId = req.userId!;
    const role = await requireGroupMember(db, id, userId);
    const r = await db.query<TaskRow>('select id, group_id, created_by, title, description, items, due_at, created_at from group_tasks where id = $1 and group_id = $2', [taskId, id]);
    if (!r.rows[0]) throw new HttpError(404, 'not_found', 'No such task.');
    const people = await loadPeople(db, [r.rows[0].created_by]);
    const task = await toTask(db, r.rows[0], userId, people);
    if (!isGroupAdminRole(role)) return { task, members: null };
    const members = await db.query<PersonRow & { role: GroupRole }>(
      `select p.user_id, p.username, p.display_name, p.avatar_url, p.platform_role, m.role from group_members m join profiles p on p.user_id = m.user_id where m.group_id = $1 order by p.display_name`,
      [id],
    );
    const out = [];
    for (const m of members.rows) {
      const completedIds = await completedItems(db, m.user_id, task.items);
      out.push({ ...toPerson(m), role: m.role, done: completedIds.length, total: task.items.length, completedIds });
    }
    return { task, members: out };
  });

  app.delete('/api/groups/:id/tasks/:taskId', { preHandler: requireAuth }, async (req, reply) => {
    const { id, taskId } = z.object({ id: uuid, taskId: uuid }).parse(req.params);
    await requireFacilitatorAdmin(db, id, req.userId!);
    await db.query('delete from group_tasks where id = $1 and group_id = $2', [taskId, id]);
    return reply.status(204).send();
  });

  /* ---- blocks ---- */

  app.get('/api/me/blocks', { preHandler: requireAuth }, async (req) => {
    const r = await db.query<PersonRow>(
      'select p.user_id, p.username, p.display_name, p.avatar_url, p.platform_role from blocks b join profiles p on p.user_id = b.blocked_id where b.blocker_id = $1 order by b.created_at desc',
      [req.userId],
    );
    return { blocked: r.rows.map(toPerson) };
  });

  app.put('/api/me/blocks/:userId', { preHandler: requireAuth }, async (req) => {
    const { userId: target } = z.object({ userId: uuid }).parse(req.params);
    if (target === req.userId) throw new HttpError(400, 'invalid', 'You cannot block yourself.');
    if (!(await loadPerson(db, target))) throw new HttpError(404, 'not_found', 'No such person.');
    await db.query('insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing', [req.userId, target]);
    return { ok: true };
  });

  app.delete('/api/me/blocks/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const { userId: target } = z.object({ userId: uuid }).parse(req.params);
    await db.query('delete from blocks where blocker_id = $1 and blocked_id = $2', [req.userId, target]);
    return reply.status(204).send();
  });

  /* ---- notifications ---- */

  app.get('/api/me/notifications', { preHandler: requireAuth }, async (req) => {
    const r = await db.query<{ id: unknown; kind: Notification['kind']; title: string; body: string | null; link: string | null; read_at: unknown; created_at: unknown }>(
      'select id, kind, title, body, link, read_at, created_at from notifications where user_id = $1 order by created_at desc limit 100',
      [req.userId],
    );
    const notifications: Notification[] = r.rows.map((n) => ({
      id: num(n.id),
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      readAt: n.read_at ? iso(n.read_at) : null,
      createdAt: iso(n.created_at),
    }));
    return { notifications, unread: notifications.filter((n) => !n.readAt).length };
  });

  app.post('/api/me/notifications/read', { preHandler: requireAuth }, async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).parse(req.body ?? {});
    if (ids) await db.query('update notifications set read_at = now() where user_id = $1 and read_at is null and id = any($2::bigint[])', [req.userId, ids]);
    else await db.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [req.userId]);
    return { ok: true };
  });

  /* ---- reports ---- */

  app.post('/api/reports', { preHandler: requireAuth }, async (req, reply) => {
    const body = z
      .object({ targetKind: z.enum(['thread', 'post', 'group_message', 'dm', 'resource', 'profile']), targetId: z.string().trim().min(1).max(200), reason: text(2000) })
      .parse(req.body);
    await db.query('insert into reports (reporter_id, target_kind, target_id, reason) values ($1, $2, $3, $4)', [req.userId, body.targetKind, body.targetId, body.reason]);
    return reply.status(201).send({ ok: true });
  });

  /* ---- public profiles ---- */

  app.get('/api/people/:username', { preHandler: requireAuth }, async (req) => {
    const { username } = z.object({ username: z.string().trim().toLowerCase().max(24) }).parse(req.params);
    const r = await db.query<PersonRow & { xp: unknown; bio: string | null; show_on_boards: boolean; created_at: unknown }>(
      `select p.user_id, p.username, p.display_name, p.avatar_url, p.platform_role, p.xp, p.bio, p.show_on_boards, p.created_at from profiles p where p.username = $1`,
      [username],
    );
    if (!r.rows[0]) throw new HttpError(404, 'not_found', 'No one has that username.');
    const row = r.rows[0];
    const awards = await db.query<{ id: unknown; kind: string; label: string; competition_id: string | null; title: string | null; awarded_at: unknown }>(
      'select a.id, a.kind, a.label, a.competition_id, c.title, a.awarded_at from awards a left join competitions c on c.id = a.competition_id where a.user_id = $1 order by a.awarded_at desc limit 50',
      [row.user_id],
    );
    const shared = await db.query<{ n: unknown }>(
      `select (select count(*) from forum_posts fp join forum_threads t on t.accepted_post_id = fp.id where fp.author_id = $1)
            + (select count(*) from resources where owner_id = $1) as n`,
      [row.user_id],
    );
    const sharesAGroup = row.user_id !== req.userId && (await db.query('select 1 from group_members x join group_members y on y.group_id = x.group_id where x.user_id = $1 and y.user_id = $2 limit 1', [req.userId, row.user_id])).rows.length > 0;
    return {
      person: toPerson(row),
      xp: row.show_on_boards ? num(row.xp) : null,
      level: row.show_on_boards ? levelFromXp(num(row.xp)) : null,
      bio: row.bio,
      memberSince: iso(row.created_at),
      contributions: num(shared.rows[0].n),
      canMessage: sharesAGroup,
      awards: awards.rows.map((a) => ({ id: num(a.id), kind: a.kind, label: a.label, competitionId: a.competition_id, competitionTitle: a.title, awardedAt: iso(a.awarded_at) })),
    };
  });

}
