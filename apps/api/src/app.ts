/**
 * The HTTP API. buildApp() returns a Fastify instance so tests can inject requests
 * without opening a port. server.ts wires it to a database and the static web build.
 */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { iso, num, type Db, type Queryable } from './db.js';
import { hashPassword, hashToken, makeRateLimiter, newSessionToken, SESSION_DAYS, usernameFromEmail, verifyPassword } from './auth.js';
import { levelFromXp, XP, type AgeBand, type Mastery, type Profile, type ProgressRecords, type User } from './types.js';
import { HttpError } from './errors.js';
import { purgeOnAccountDelete, registerAnalytics } from './analytics.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    sessionId?: string;
  }
}

export interface AppOptions {
  db: Db;
  /** Allowed browser origin for cross-origin use. Omit when the API serves the web app itself. */
  corsOrigin?: string;
  logger?: boolean;
  /** Secret that derives research ids from user ids (learning analytics). Kept outside the database. */
  researchSalt?: string;
}

export { HttpError };

const MASTERY: Mastery[] = ['not_started', 'attempted', 'proficient', 'mastered'];

/* ----------------------------------------------------------------------------- schemas */

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(6, 'Use a password of at least 6 characters.').max(200);

const signUpBody = z.object({ email, password, displayName: z.string().trim().max(60).optional() });
const signInBody = z.object({ email, password: z.string().min(1).max(200) });
const deleteBody = z.object({ password: z.string().min(1).max(200) });

const profilePatch = z
  .object({
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/, 'Usernames are 3 to 24 characters: lowercase letters, digits and underscores.'),
    displayName: z.string().trim().min(1).max(60),
    avatarUrl: z.string().trim().url().max(500).nullable(),
    ageBand: z.enum(['under_18', '18_plus', 'undisclosed']),
    showOnBoards: z.boolean(),
  })
  .partial();

const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });
const syncItem = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lab_result'),
    id: uuid,
    at: isoDate,
    labId: z.string().min(1).max(200),
    course: z.string().min(1).max(200),
    level: z.enum(['beginner', 'intermediate', 'advanced']),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    hintsUsed: z.number().int().min(0).max(1000),
    checks: z.array(z.unknown()).max(100).optional(),
  }),
  z.object({
    kind: z.literal('check_attempt'),
    id: uuid,
    at: isoDate,
    course: z.string().min(1).max(200),
    unit: z.number().int().min(1).max(1000),
    topic: z.number().int().min(1).max(1000),
    score: z.number().min(0).max(100),
    passed: z.boolean(),
  }),
  z.object({
    kind: z.literal('topic_progress'),
    id: z.string().min(1).max(300),
    at: isoDate,
    course: z.string().min(1).max(200),
    unit: z.number().int().min(1).max(1000),
    topic: z.number().int().min(1).max(1000),
    mastery: z.enum(['not_started', 'attempted', 'proficient', 'mastered']),
    bestCheckScore: z.number().min(0).max(100).optional(),
  }),
]);
const syncBody = z.object({ items: z.array(syncItem).max(500) });
export type SyncItem = z.infer<typeof syncItem>;

/* ----------------------------------------------------------------------------- helpers */

interface ProfileRow {
  username: string;
  display_name: string;
  avatar_url: string | null;
  age_band: AgeBand;
  show_on_boards: boolean;
  xp: number;
}

function toProfile(r: ProfileRow): Profile {
  return {
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    ageBand: r.age_band,
    showOnBoards: r.show_on_boards,
    xp: num(r.xp),
    level: levelFromXp(num(r.xp)),
  };
}

async function loadProfile(q: Queryable, userId: string): Promise<Profile> {
  const r = await q.query<ProfileRow>('select username, display_name, avatar_url, age_band, show_on_boards, xp from profiles where user_id = $1', [userId]);
  if (!r.rows[0]) throw new HttpError(500, 'no_profile', 'Your profile is missing. Please contact support.');
  return toProfile(r.rows[0]);
}

async function loadUser(q: Queryable, userId: string): Promise<User> {
  const r = await q.query<{ id: string; email: string; created_at: unknown }>('select id, email, created_at from users where id = $1', [userId]);
  if (!r.rows[0]) throw new HttpError(401, 'unauthorized', 'Please sign in again.');
  return { id: r.rows[0].id, email: r.rows[0].email, createdAt: iso(r.rows[0].created_at) };
}

async function createSession(q: Queryable, userId: string): Promise<string> {
  const { token, hash } = newSessionToken();
  await q.query(`insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [userId, hash]);
  return token;
}

async function loadProgress(q: Queryable, userId: string): Promise<ProgressRecords> {
  const labs = await q.query<{
    lab_id: string;
    passed: boolean;
    best_score: unknown;
    attempts: unknown;
    hints_used: unknown;
    last_attempt_at: unknown;
    completed_at: unknown;
  }>(
    `select lab_id, bool_or(passed) as passed, max(score)::float8 as best_score, count(*)::int as attempts,
            max(hints_used)::int as hints_used, max(created_at) as last_attempt_at,
            min(created_at) filter (where passed) as completed_at
       from lab_results where user_id = $1 group by lab_id`,
    [userId],
  );
  const checks = await q.query<{
    course_slug: string;
    unit_index: number;
    topic_index: number;
    attempts: unknown;
    best_score: unknown;
    passed: boolean;
    last_attempt_at: unknown;
  }>(
    `select course_slug, unit_index, topic_index, count(*)::int as attempts, max(score)::float8 as best_score,
            bool_or(passed) as passed, max(created_at) as last_attempt_at
       from check_attempts where user_id = $1 group by course_slug, unit_index, topic_index`,
    [userId],
  );
  const topics = await q.query<{ course_slug: string; unit_index: number; topic_index: number; mastery: Mastery; best_check_score: unknown; updated_at: unknown }>(
    'select course_slug, unit_index, topic_index, mastery, best_check_score::float8 as best_check_score, updated_at from topic_progress where user_id = $1',
    [userId],
  );
  const out: ProgressRecords = { labs: {}, topics: {}, checks: {} };
  for (const r of labs.rows) {
    out.labs[r.lab_id] = {
      passed: r.passed,
      bestScore: num(r.best_score),
      attempts: num(r.attempts),
      hintsUsed: num(r.hints_used),
      lastAttemptAt: iso(r.last_attempt_at),
      completedAt: r.completed_at ? iso(r.completed_at) : undefined,
    };
  }
  for (const r of checks.rows) {
    out.checks[`${r.course_slug}:${r.unit_index}:${r.topic_index}`] = {
      attempts: num(r.attempts),
      bestScore: num(r.best_score),
      passed: r.passed,
      lastAttemptAt: iso(r.last_attempt_at),
    };
  }
  for (const r of topics.rows) {
    const best = r.best_check_score === null || r.best_check_score === undefined ? undefined : num(r.best_check_score);
    out.topics[`${r.course_slug}:${r.unit_index}:${r.topic_index}`] = {
      mastery: r.mastery,
      bestCheckScore: best && best > 0 ? best : undefined,
      updatedAt: iso(r.updated_at),
    };
  }
  return out;
}

/** Writes one queued item. Returns true when it was applied (or already there). */
async function applyItem(q: Queryable, userId: string, item: SyncItem): Promise<void> {
  switch (item.kind) {
    case 'lab_result': {
      const firstPass =
        item.passed &&
        (await q.query('select 1 from lab_results where user_id = $1 and lab_id = $2 and passed limit 1', [userId, item.labId])).rows.length === 0;
      const r = await q.query(
        `insert into lab_results (user_id, lab_id, course_slug, level, passed, score, hints_used, checks, client_attempt_id, created_at)
         values ($1, $2, $3, $4::lab_level, $5, $6, $7, $8::jsonb, $9::uuid, least($10::timestamptz, now()))
         on conflict (client_attempt_id) do nothing`,
        [userId, item.labId, item.course, item.level, item.passed, Math.round(item.score * 1000) / 1000, item.hintsUsed, JSON.stringify(item.checks ?? []), item.id, item.at],
      );
      if (r.rowCount > 0 && firstPass) await q.query('update profiles set xp = xp + $2, updated_at = now() where user_id = $1', [userId, XP[item.level]]);
      return;
    }
    case 'check_attempt': {
      const firstPass =
        item.passed &&
        (
          await q.query('select 1 from check_attempts where user_id = $1 and course_slug = $2 and unit_index = $3 and topic_index = $4 and passed limit 1', [
            userId,
            item.course,
            item.unit,
            item.topic,
          ])
        ).rows.length === 0;
      const r = await q.query(
        `insert into check_attempts (user_id, course_slug, unit_index, topic_index, score, passed, client_attempt_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7::uuid, least($8::timestamptz, now()))
         on conflict (client_attempt_id) do nothing`,
        [userId, item.course, item.unit, item.topic, Math.round(item.score * 100) / 100, item.passed, item.id, item.at],
      );
      if (r.rowCount > 0 && firstPass) await q.query('update profiles set xp = xp + $2, updated_at = now() where user_id = $1', [userId, XP.check]);
      return;
    }
    case 'topic_progress': {
      await q.query(
        `insert into topic_progress (user_id, course_slug, unit_index, topic_index, mastery, best_check_score, updated_at)
         values ($1, $2, $3, $4, $5::mastery, $6, now())
         on conflict (user_id, course_slug, unit_index, topic_index) do update set
           mastery = case when mastery_rank(excluded.mastery) > mastery_rank(topic_progress.mastery) then excluded.mastery else topic_progress.mastery end,
           best_check_score = nullif(greatest(coalesce(topic_progress.best_check_score, 0), coalesce(excluded.best_check_score, 0)), 0),
           updated_at = now()`,
        [userId, item.course, item.unit, item.topic, item.mastery, item.bestCheckScore ?? null],
      );
      return;
    }
  }
}

/* ----------------------------------------------------------------------------- the app */

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const researchSalt = opts.researchSalt ?? 'development-only-salt';
  const app = Fastify({
    // Operational logs: method, URL, status and timing per request; never bodies, and no auth headers.
    logger: opts.logger ? { redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[redacted]' } } : false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });
  if (opts.corsOrigin) await app.register(cors, { origin: opts.corsOrigin.split(',').map((s) => s.trim()) });

  const authLimit = makeRateLimiter(20, 10 * 60 * 1000);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: 'invalid', message: first?.message ?? 'Please check what you entered.', path: first?.path });
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? 'bad_request', message: e.message ?? 'Bad request.' });
    app.log.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Something went wrong on the server. Please try again.' });
  });

  /** Resolves the bearer token to a user; 401 when missing or expired. */
  async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'unauthorized', 'Please sign in.');
    const r = await db.query<{ id: string; user_id: string; expires_at: unknown }>(
      'select id, user_id, expires_at from sessions where token_hash = $1 and expires_at > now()',
      [hashToken(token)],
    );
    const s = r.rows[0];
    if (!s) throw new HttpError(401, 'unauthorized', 'Your sign-in has expired. Please sign in again.');
    req.userId = s.user_id;
    req.sessionId = s.id;
    // Keep active sessions alive: touch at most once an hour and extend when under 30 days remain.
    void db
      .query(
        `update sessions set last_seen_at = now(),
                expires_at = greatest(expires_at, now() + interval '30 days')
          where id = $1 and last_seen_at < now() - interval '1 hour'`,
        [s.id],
      )
      .catch(() => {});
  }

  app.get('/api/health', async () => ({ ok: true, accounts: true, database: db.kind }));

  app.post('/api/auth/sign-up', async (req, reply) => {
    if (!authLimit(`su:${req.ip}`)) throw new HttpError(429, 'rate_limited', 'Too many attempts for now. Please wait a few minutes.');
    const body = signUpBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const result = await db.transaction(async (tx) => {
      const existing = await tx.query('select 1 from users where email = $1', [body.email]);
      if (existing.rows.length) throw new HttpError(409, 'email_taken', 'There is already an account with that email. Try signing in.');
      const u = await tx.query<{ id: string }>('insert into users (email, password_hash) values ($1, $2) returning id', [body.email, passwordHash]);
      const userId = u.rows[0].id;
      const base = usernameFromEmail(body.email);
      let username = base;
      for (let n = 1; (await tx.query('select 1 from profiles where username = $1', [username])).rows.length; n++) username = `${base.slice(0, 20)}${n}`;
      await tx.query('insert into profiles (user_id, username, display_name) values ($1, $2, $3)', [userId, username, body.displayName || username]);
      const token = await createSession(tx, userId);
      return { token, user: await loadUser(tx, userId), profile: await loadProfile(tx, userId) };
    });
    return reply.status(201).send(result);
  });

  app.post('/api/auth/sign-in', async (req) => {
    if (!authLimit(`si:${req.ip}`)) throw new HttpError(429, 'rate_limited', 'Too many attempts for now. Please wait a few minutes.');
    const body = signInBody.parse(req.body);
    const r = await db.query<{ id: string; password_hash: string }>('select id, password_hash from users where email = $1', [body.email]);
    const u = r.rows[0];
    if (!u || !(await verifyPassword(body.password, u.password_hash))) throw new HttpError(401, 'invalid_credentials', 'That email and password do not match.');
    const token = await createSession(db, u.id);
    return { token, user: await loadUser(db, u.id), profile: await loadProfile(db, u.id) };
  });

  app.post('/api/auth/sign-out', { preHandler: requireAuth }, async (req, reply) => {
    await db.query('delete from sessions where id = $1', [req.sessionId]);
    return reply.status(204).send();
  });

  app.get('/api/me', { preHandler: requireAuth }, async (req) => ({
    user: await loadUser(db, req.userId!),
    profile: await loadProfile(db, req.userId!),
  }));

  app.patch('/api/me/profile', { preHandler: requireAuth }, async (req) => {
    const patch = profilePatch.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [req.userId];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.username !== undefined) add('username', patch.username);
    if (patch.displayName !== undefined) add('display_name', patch.displayName);
    if (patch.avatarUrl !== undefined) add('avatar_url', patch.avatarUrl);
    if (patch.ageBand !== undefined) add('age_band', patch.ageBand);
    if (patch.showOnBoards !== undefined) add('show_on_boards', patch.showOnBoards);
    if (sets.length) {
      try {
        await db.query(`update profiles set ${sets.join(', ')}, updated_at = now() where user_id = $1`, params);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === '23505' || /unique|duplicate/i.test(e.message ?? '')) throw new HttpError(409, 'username_taken', 'That username is taken. Try another.');
        throw err;
      }
    }
    return { profile: await loadProfile(db, req.userId!) };
  });

  app.get('/api/me/progress', { preHandler: requireAuth }, async (req) => loadProgress(db, req.userId!));

  app.post('/api/me/progress/sync', { preHandler: requireAuth }, async (req) => {
    const { items } = syncBody.parse(req.body);
    const userId = req.userId!;
    const accepted = await db.transaction(async (tx) => {
      const ok: string[] = [];
      for (const item of items) {
        await applyItem(tx, userId, item);
        ok.push(item.id);
      }
      return ok;
    });
    return { accepted, records: await loadProgress(db, userId), profile: await loadProfile(db, userId) };
  });

  app.delete('/api/me', { preHandler: requireAuth }, async (req, reply) => {
    const body = deleteBody.parse(req.body);
    const r = await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [req.userId]);
    if (!r.rows[0] || !(await verifyPassword(body.password, r.rows[0].password_hash))) throw new HttpError(401, 'invalid_credentials', 'That password is not right.');
    await db.transaction(async (tx) => {
      await purgeOnAccountDelete(tx, researchSalt, req.userId!);
      await tx.query('delete from users where id = $1', [req.userId]);
    });
    return reply.status(204).send();
  });

  registerAnalytics(app, { db, researchSalt, requireAuth });

  app.get('/api/*', async () => {
    throw new HttpError(404, 'not_found', 'No such API route.');
  });

  return app;
}

/** Order helper exported for tests. */
export const MASTERY_ORDER = MASTERY;
