/**
 * Forum: categories (four fixed ones plus one per course), threads that can be attached to a
 * course, unit, topic or lab, replies, votes, an accepted answer and facilitator endorsements.
 *
 * Rules (from the reference policies): the Lecturers category is visible to facilitators only;
 * anyone signed in creates threads and replies except on a locked thread; authors and
 * moderators edit; votes are the voter's own; the asker or a facilitator accepts an answer;
 * facilitators endorse.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iso, num, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import {
  idParam,
  isFacilitatorRole,
  isModeratorRole,
  loadPeople,
  mentionedUserIds,
  notify,
  platformRole,
  text,
  uuid,
  type Deps,
  type Person,
} from './common.js';

export interface Category {
  id: string;
  name: string;
  description: string | null;
  lecturersOnly: boolean;
  threads: number;
}

export interface ThreadSummary {
  id: string;
  categoryId: string;
  author: Person | null;
  title: string;
  tags: string[];
  courseSlug: string | null;
  unitIndex: number | null;
  topicIndex: number | null;
  labId: string | null;
  solved: boolean;
  locked: boolean;
  pinned: boolean;
  views: number;
  replies: number;
  votes: number;
  createdAt: string;
  updatedAt: string;
}

export interface Post {
  id: string;
  threadId: string;
  author: Person | null;
  body: string;
  parentId: string | null;
  endorsed: boolean;
  accepted: boolean;
  votes: number;
  myVote: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

interface ThreadRow {
  id: string;
  category_id: string;
  author_id: string;
  title: string;
  body: string;
  tags: string[] | null;
  course_slug: string | null;
  unit_index: number | null;
  topic_index: number | null;
  lab_id: string | null;
  accepted_post_id: string | null;
  locked: boolean;
  pinned: boolean;
  views: unknown;
  created_at: unknown;
  updated_at: unknown;
  replies: unknown;
  votes: unknown;
}

const THREAD_SELECT = `t.id, t.category_id, t.author_id, t.title, t.body, t.tags, t.course_slug, t.unit_index, t.topic_index, t.lab_id, t.accepted_post_id,
  t.locked, t.pinned, t.views, t.created_at, t.updated_at,
  (select count(*) from forum_posts p where p.thread_id = t.id and p.deleted_at is null) as replies,
  (select coalesce(sum(v.value), 0) from forum_posts p join post_votes v on v.post_id = p.id where p.thread_id = t.id and p.deleted_at is null) as votes`;

function toSummary(r: ThreadRow, people: Map<string, Person>): ThreadSummary {
  return {
    id: r.id,
    categoryId: r.category_id,
    author: people.get(r.author_id) ?? null,
    title: r.title,
    tags: r.tags ?? [],
    courseSlug: r.course_slug,
    unitIndex: r.unit_index,
    topicIndex: r.topic_index,
    labId: r.lab_id,
    solved: !!r.accepted_post_id,
    locked: r.locked,
    pinned: r.pinned,
    views: num(r.views),
    replies: num(r.replies),
    votes: num(r.votes),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

interface PostRow {
  id: string;
  thread_id: string;
  author_id: string;
  body: string;
  parent_id: string | null;
  lecturer_endorsed: boolean;
  created_at: unknown;
  edited_at: unknown;
  deleted_at: unknown;
  votes: unknown;
  my_vote: unknown;
}

const POST_SELECT = `p.id, p.thread_id, p.author_id, p.body, p.parent_id, p.lecturer_endorsed, p.created_at, p.edited_at, p.deleted_at,
  (select coalesce(sum(v.value), 0) from post_votes v where v.post_id = p.id) as votes,
  (select coalesce(max(v.value), 0) from post_votes v where v.post_id = p.id and v.user_id = $1) as my_vote`;

function toPost(r: PostRow, people: Map<string, Person>, acceptedId: string | null): Post {
  const deleted = !!r.deleted_at;
  return {
    id: r.id,
    threadId: r.thread_id,
    author: people.get(r.author_id) ?? null,
    body: deleted ? '' : r.body,
    parentId: r.parent_id,
    endorsed: r.lecturer_endorsed,
    accepted: r.id === acceptedId,
    votes: num(r.votes),
    myVote: num(r.my_vote),
    createdAt: iso(r.created_at),
    editedAt: r.edited_at ? iso(r.edited_at) : null,
    deletedAt: deleted ? iso(r.deleted_at) : null,
  };
}

async function canSeeCategory(q: Queryable, categoryId: string, userId: string): Promise<boolean> {
  const c = await q.query<{ lecturers_only: boolean }>('select lecturers_only from forum_categories where id = $1', [categoryId]);
  if (!c.rows[0]) return false;
  if (!c.rows[0].lecturers_only) return true;
  return isFacilitatorRole(await platformRole(q, userId));
}

async function loadThread(q: Queryable, id: string, userId: string): Promise<ThreadRow> {
  const r = await q.query<ThreadRow>(`select ${THREAD_SELECT} from forum_threads t where t.id = $1`, [id]);
  const t = r.rows[0];
  if (!t || !(await canSeeCategory(q, t.category_id, userId))) throw new HttpError(404, 'not_found', 'That thread does not exist, or you cannot see it.');
  return t;
}

const threadBody = z.object({
  categoryId: z.string().trim().min(1).max(100),
  title: text(200, 5),
  body: z.string().trim().max(20000).default(''),
  tags: z.array(z.string().trim().min(1).max(30)).max(5).default([]),
  courseSlug: z.string().trim().max(200).optional(),
  unitIndex: z.number().int().min(1).max(1000).optional(),
  topicIndex: z.number().int().min(1).max(1000).optional(),
  labId: z.string().trim().max(200).optional(),
});

export function registerForum(app: FastifyInstance, deps: Deps): void {
  const { db, requireAuth, hub } = deps;

  app.get('/api/forum/categories', { preHandler: requireAuth }, async (req) => {
    const facilitator = isFacilitatorRole(await platformRole(db, req.userId!));
    const r = await db.query<{ id: string; name: string; description: string | null; lecturers_only: boolean; threads: unknown }>(
      `select c.id, c.name, c.description, c.lecturers_only, (select count(*) from forum_threads t where t.category_id = c.id) as threads
         from forum_categories c where not c.lecturers_only or $1 order by c.sort_order, c.name`,
      [facilitator],
    );
    const categories: Category[] = r.rows.map((c) => ({ id: c.id, name: c.name, description: c.description, lecturersOnly: c.lecturers_only, threads: num(c.threads) }));
    return { categories };
  });

  app.get('/api/forum/threads', { preHandler: requireAuth }, async (req) => {
    const qs = z
      .object({
        category: z.string().trim().max(100).optional(),
        labId: z.string().trim().max(200).optional(),
        course: z.string().trim().max(200).optional(),
        unit: z.coerce.number().int().min(1).optional(),
        topic: z.coerce.number().int().min(1).optional(),
        q: z.string().trim().max(120).optional(),
        unsolved: z.string().max(5).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(req.query ?? {});
    const userId = req.userId!;
    const facilitator = isFacilitatorRole(await platformRole(db, userId));
    const where: string[] = ['(not c.lecturers_only or $1)'];
    const params: unknown[] = [facilitator];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (qs.category) add('t.category_id = ?', qs.category);
    if (qs.labId) add('t.lab_id = ?', qs.labId);
    if (qs.course) add('t.course_slug = ?', qs.course);
    if (qs.unit) add('t.unit_index = ?', qs.unit);
    if (qs.topic) add('t.topic_index = ?', qs.topic);
    if (qs.q) {
      params.push(qs.q);
      where.push(`(t.title ilike '%' || $${params.length} || '%' or t.body ilike '%' || $${params.length} || '%')`);
    }
    if (qs.unsolved === '1' || qs.unsolved === 'true') where.push('t.accepted_post_id is null');
    params.push(qs.limit);
    const r = await db.query<ThreadRow>(
      `select ${THREAD_SELECT} from forum_threads t join forum_categories c on c.id = t.category_id where ${where.join(' and ')}
        order by t.pinned desc, t.updated_at desc limit $${params.length}`,
      params,
    );
    const people = await loadPeople(db, r.rows.map((t) => t.author_id));
    return { threads: r.rows.map((t) => toSummary(t, people)) };
  });

  app.post('/api/forum/threads', { preHandler: requireAuth }, async (req, reply) => {
    const body = threadBody.parse(req.body);
    const userId = req.userId!;
    if (!(await canSeeCategory(db, body.categoryId, userId))) throw new HttpError(404, 'not_found', 'No such category, or you cannot post there.');
    const id = await db.transaction(async (tx) => {
      const t = await tx.query<{ id: string; created_at: unknown }>(
        `insert into forum_threads (category_id, author_id, title, body, tags, course_slug, unit_index, topic_index, lab_id)
         values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9) returning id, created_at`,
        [body.categoryId, userId, body.title, body.body, body.tags, body.courseSlug ?? null, body.unitIndex ?? null, body.topicIndex ?? null, body.labId ?? null],
      );
      const mentioned = await mentionedUserIds(tx, body.body, userId);
      await notify(tx, hub, mentioned, { kind: 'mention', title: `You were mentioned in "${body.title}"`, link: `/forum/threads/${t.rows[0].id}` });
      return t.rows[0].id;
    });
    const t = await loadThread(db, id, userId);
    const people = await loadPeople(db, [userId]);
    return reply.status(201).send({ thread: { ...toSummary(t, people), body: t.body } });
  });

  app.get('/api/forum/threads/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const t = await loadThread(db, id, userId);
    void db.query('update forum_threads set views = views + 1 where id = $1', [id]).catch(() => {});
    const posts = await db.query<PostRow>(`select ${POST_SELECT} from forum_posts p where p.thread_id = $2 order by p.created_at`, [userId, id]);
    const people = await loadPeople(db, [t.author_id, ...posts.rows.map((p) => p.author_id)]);
    const role = await platformRole(db, userId);
    return {
      thread: { ...toSummary(t, people), body: t.body, acceptedPostId: t.accepted_post_id },
      posts: posts.rows.map((p) => toPost(p, people, t.accepted_post_id)),
      can: {
        reply: !t.locked,
        edit: t.author_id === userId || isModeratorRole(role),
        accept: t.author_id === userId || isFacilitatorRole(role),
        endorse: isFacilitatorRole(role),
        moderate: isModeratorRole(role),
      },
    };
  });

  app.patch('/api/forum/threads/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({ title: text(200, 5), body: z.string().trim().max(20000), tags: z.array(z.string().trim().min(1).max(30)).max(5), locked: z.boolean(), pinned: z.boolean() })
      .partial()
      .parse(req.body);
    const userId = req.userId!;
    const t = await loadThread(db, id, userId);
    const role = await platformRole(db, userId);
    const moderator = isModeratorRole(role);
    if (t.author_id !== userId && !moderator) throw new HttpError(403, 'forbidden', 'Only the person who asked, or a moderator, can edit this.');
    if ((body.locked !== undefined || body.pinned !== undefined) && !moderator) throw new HttpError(403, 'forbidden', 'Only a moderator can lock or pin a thread.');
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown, cast = '') => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (body.title !== undefined) add('title', body.title);
    if (body.body !== undefined) add('body', body.body);
    if (body.tags !== undefined) add('tags', body.tags, '::text[]');
    if (body.locked !== undefined) add('locked', body.locked);
    if (body.pinned !== undefined) add('pinned', body.pinned);
    if (sets.length) await db.query(`update forum_threads set ${sets.join(', ')} where id = $1`, params);
    return { ok: true };
  });

  app.post('/api/forum/threads/:id/posts', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ body: text(20000), parentId: uuid.nullable().optional() }).parse(req.body);
    const userId = req.userId!;
    const t = await loadThread(db, id, userId);
    if (t.locked) throw new HttpError(403, 'locked', 'This thread is locked, so no more replies can be added.');
    const postId = await db.transaction(async (tx) => {
      let parentAuthor: string | null = null;
      if (body.parentId) {
        const parent = await tx.query<{ author_id: string }>('select author_id from forum_posts where id = $1 and thread_id = $2', [body.parentId, id]);
        if (!parent.rows[0]) throw new HttpError(404, 'not_found', 'The reply you are answering is gone.');
        parentAuthor = parent.rows[0].author_id;
      }
      const p = await tx.query<{ id: string }>('insert into forum_posts (thread_id, author_id, body, parent_id) values ($1, $2, $3, $4) returning id', [id, userId, body.body, body.parentId ?? null]);
      await tx.query('update forum_threads set updated_at = now() where id = $1', [id]);
      const link = `/forum/threads/${id}#post-${p.rows[0].id}`;
      const replyTargets = [t.author_id, parentAuthor].filter((u): u is string => !!u && u !== userId);
      await notify(tx, hub, replyTargets, { kind: 'reply', title: `New reply on "${t.title}"`, body: body.body.slice(0, 140), link });
      const mentioned = (await mentionedUserIds(tx, body.body, userId)).filter((u) => !replyTargets.includes(u));
      await notify(tx, hub, mentioned, { kind: 'mention', title: `You were mentioned in "${t.title}"`, link });
      return p.rows[0].id;
    });
    const r = await db.query<PostRow>(`select ${POST_SELECT} from forum_posts p where p.id = $2`, [userId, postId]);
    const people = await loadPeople(db, [userId]);
    return reply.status(201).send({ post: toPost(r.rows[0], people, t.accepted_post_id) });
  });

  app.patch('/api/forum/posts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { body } = z.object({ body: text(20000) }).parse(req.body);
    const userId = req.userId!;
    const p = await db.query<{ author_id: string; deleted_at: unknown }>('select author_id, deleted_at from forum_posts where id = $1', [id]);
    if (!p.rows[0] || p.rows[0].deleted_at) throw new HttpError(404, 'not_found', 'No such reply.');
    if (p.rows[0].author_id !== userId && !isModeratorRole(await platformRole(db, userId))) throw new HttpError(403, 'forbidden', 'You can only edit your own replies.');
    await db.query('update forum_posts set body = $2, edited_at = now() where id = $1', [id, body]);
    return { ok: true };
  });

  app.delete('/api/forum/posts/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const p = await db.query<{ author_id: string; thread_id: string }>('select author_id, thread_id from forum_posts where id = $1', [id]);
    if (!p.rows[0]) return reply.status(204).send();
    if (p.rows[0].author_id !== userId && !isModeratorRole(await platformRole(db, userId))) throw new HttpError(403, 'forbidden', 'You can only remove your own replies.');
    await db.query('update forum_posts set deleted_at = now() where id = $1 and deleted_at is null', [id]);
    await db.query('update forum_threads set accepted_post_id = null where id = $1 and accepted_post_id = $2', [p.rows[0].thread_id, id]);
    return reply.status(204).send();
  });

  app.put('/api/forum/posts/:id/vote', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { value } = z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }).parse(req.body);
    const userId = req.userId!;
    const p = await db.query<{ thread_id: string; author_id: string }>('select thread_id, author_id from forum_posts where id = $1 and deleted_at is null', [id]);
    if (!p.rows[0]) throw new HttpError(404, 'not_found', 'No such reply.');
    await loadThread(db, p.rows[0].thread_id, userId);
    if (value === 0) await db.query('delete from post_votes where post_id = $1 and user_id = $2', [id, userId]);
    else await db.query('insert into post_votes (post_id, user_id, value) values ($1, $2, $3) on conflict (post_id, user_id) do update set value = excluded.value', [id, userId, value]);
    const votes = await db.query<{ n: unknown }>('select coalesce(sum(value), 0) as n from post_votes where post_id = $1', [id]);
    return { votes: num(votes.rows[0].n), myVote: value };
  });

  app.post('/api/forum/threads/:id/accept', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { postId } = z.object({ postId: uuid.nullable() }).parse(req.body);
    const userId = req.userId!;
    const t = await loadThread(db, id, userId);
    if (t.author_id !== userId && !isFacilitatorRole(await platformRole(db, userId))) {
      throw new HttpError(403, 'forbidden', 'Only the person who asked, or a facilitator, can mark the answer.');
    }
    if (postId) {
      const p = await db.query<{ author_id: string }>('select author_id from forum_posts where id = $1 and thread_id = $2 and deleted_at is null', [postId, id]);
      if (!p.rows[0]) throw new HttpError(404, 'not_found', 'No such reply on this thread.');
      await db.query('update forum_threads set accepted_post_id = $2 where id = $1', [id, postId]);
      if (p.rows[0].author_id !== userId) {
        await notify(db, hub, [p.rows[0].author_id], { kind: 'accepted', title: `Your answer on "${t.title}" was accepted`, link: `/forum/threads/${id}#post-${postId}` });
      }
    } else {
      await db.query('update forum_threads set accepted_post_id = null where id = $1', [id]);
    }
    return { acceptedPostId: postId };
  });

  app.post('/api/forum/posts/:id/endorse', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { endorsed } = z.object({ endorsed: z.boolean() }).parse(req.body);
    const userId = req.userId!;
    if (!isFacilitatorRole(await platformRole(db, userId))) throw new HttpError(403, 'not_facilitator', 'Only a facilitator can endorse an answer.');
    const r = await db.query('update forum_posts set lecturer_endorsed = $2 where id = $1 and deleted_at is null', [id, endorsed]);
    if (r.rowCount === 0) throw new HttpError(404, 'not_found', 'No such reply.');
    return { endorsed };
  });
}
