/**
 * Competitions (docs/03-PRODUCT-SPEC.md section 6):
 *   general  individual; a problem set of labs and checks, a time window, speed tiebreak, hint penalty
 *   group    teams of team_min..team_max inside a group; team score = top 3 + 10% when everyone scores
 *   quest    co-op goal inside a group: the group together reaches `rules.goal` solves
 *
 * Rules (from the reference policies): drafts are visible to their creator only; open contests
 * to everyone, group contests to members. Problems are hidden until the contest is live.
 * Registration while scheduled or live; submissions only while live and inside the window.
 * Scores are recomputed by the database trigger; awards are given once when the contest ends.
 *
 * Status moves with the clock: scheduled → live at starts_at, live → finished at ends_at,
 * applied whenever a contest is read (no scheduler needed).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iso, num, type Db, type Queryable } from './db.js';
import { HttpError } from './errors.js';
import {
  groupRole,
  idParam,
  isFacilitatorRole,
  isGroupAdminRole,
  loadPeople,
  notify,
  platformRole,
  requireGroupMember,
  text,
  uuid,
  type Deps,
  type Person,
} from './common.js';
import type { Hub } from './realtime.js';

export type CompetitionKind = 'general' | 'group' | 'league' | 'quest';
export type CompetitionStatus = 'draft' | 'scheduled' | 'live' | 'scoring' | 'finished' | 'cancelled';

export interface Problem {
  ordinal: number;
  kind: 'lab' | 'check';
  contentId: string;
  level: string | null;
  points: number;
}

export interface Competition {
  id: string;
  kind: CompetitionKind;
  status: CompetitionStatus;
  title: string;
  description: string | null;
  courseSlug: string | null;
  groupId: string | null;
  createdBy: string;
  startsAt: string;
  endsAt: string;
  teamMin: number;
  teamMax: number;
  hintPenalty: number;
  wrongRunPenaltyS: number;
  rules: Record<string, unknown>;
  participants: number;
  problemCount: number;
  createdAt: string;
}

interface CompRow {
  id: string;
  kind: CompetitionKind;
  status: CompetitionStatus;
  title: string;
  description: string | null;
  course_slug: string | null;
  group_id: string | null;
  created_by: string;
  starts_at: unknown;
  ends_at: unknown;
  team_min: number;
  team_max: number;
  hint_penalty: unknown;
  wrong_run_penalty_s: number;
  rules: unknown;
  finished_at: unknown;
  created_at: unknown;
  participants: unknown;
  problem_count: unknown;
}

const COMP_SELECT = `c.id, c.kind, c.status, c.title, c.description, c.course_slug, c.group_id, c.created_by, c.starts_at, c.ends_at, c.team_min, c.team_max,
  c.hint_penalty, c.wrong_run_penalty_s, c.rules, c.finished_at, c.created_at,
  (select count(*) from competition_participants p where p.competition_id = c.id) as participants,
  (select count(*) from competition_problems p where p.competition_id = c.id) as problem_count`;

function toCompetition(r: CompRow): Competition {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    description: r.description,
    courseSlug: r.course_slug,
    groupId: r.group_id,
    createdBy: r.created_by,
    startsAt: iso(r.starts_at),
    endsAt: iso(r.ends_at),
    teamMin: num(r.team_min),
    teamMax: num(r.team_max),
    hintPenalty: num(r.hint_penalty),
    wrongRunPenaltyS: num(r.wrong_run_penalty_s),
    rules: (r.rules && typeof r.rules === 'object' ? r.rules : {}) as Record<string, unknown>,
    participants: num(r.participants),
    problemCount: num(r.problem_count),
    createdAt: iso(r.created_at),
  };
}

const problemBody = z.object({
  kind: z.enum(['lab', 'check']),
  contentId: z.string().trim().min(1).max(200),
  level: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
  points: z.number().int().min(1).max(1000),
});

const competitionBody = z
  .object({
    kind: z.enum(['general', 'group', 'quest']),
    title: text(160, 3),
    description: z.string().trim().max(4000).optional(),
    courseSlug: z.string().trim().max(200).optional(),
    groupId: uuid.optional(),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    teamMin: z.number().int().min(1).max(10).optional(),
    teamMax: z.number().int().min(1).max(10).optional(),
    hintPenalty: z.number().min(0).max(1).default(0.2),
    wrongRunPenaltyS: z.number().int().min(0).max(3600).default(300),
    rules: z.record(z.string(), z.unknown()).default({}),
    problems: z.array(problemBody).min(1).max(30),
  })
  .refine((b) => Date.parse(b.endsAt) > Date.parse(b.startsAt), { message: 'The contest must end after it starts.' })
  .refine((b) => b.kind === 'general' || b.groupId, { message: 'Group contests and quests live inside a group.' })
  .refine((b) => b.kind !== 'group' || ((b.teamMin ?? 2) >= 1 && (b.teamMax ?? 5) >= (b.teamMin ?? 2)), { message: 'Team sizes must make sense.' });

/* ----------------------------------------------------------------------------- lifecycle */

/** Moves a contest with the clock and finalises it once. Returns the fresh row. */
async function syncStatus(db: Db, hub: Hub, row: CompRow): Promise<CompRow> {
  const now = Date.now();
  const starts = Date.parse(iso(row.starts_at));
  const ends = Date.parse(iso(row.ends_at));
  if (row.status === 'scheduled' && now >= starts && now < ends) {
    await db.query("update competitions set status = 'live' where id = $1 and status = 'scheduled'", [row.id]);
    return { ...row, status: 'live' };
  }
  if ((row.status === 'scheduled' || row.status === 'live') && now >= ends) {
    const claimed = await db.query("update competitions set status = 'finished', finished_at = now() where id = $1 and status in ('scheduled', 'live') and finished_at is null", [row.id]);
    if (claimed.rowCount > 0) await finalise(db, hub, row.id);
    return { ...row, status: 'finished' };
  }
  return row;
}

/** Awards once the contest is over, and a results notification for every participant. */
async function finalise(db: Db, hub: Hub, compId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = (await tx.query<CompRow>(`select ${COMP_SELECT} from competitions c where c.id = $1`, [compId])).rows[0];
    const participants = await tx.query<{ user_id: string; team_id: string | null }>('select user_id, team_id from competition_participants where competition_id = $1', [compId]);
    for (const p of participants.rows) await tx.query('select recompute_competition_score($1, $2)', [compId, p.user_id]);

    const award = (userId: string, kind: string, label: string, teamId: string | null = null) =>
      tx.query('insert into awards (user_id, competition_id, team_id, kind, label) values ($1, $2, $3, $4::award_kind, $5)', [userId, compId, teamId, kind, label]);
    const medals = ['gold', 'silver', 'bronze'];

    if (c.kind === 'group') {
      const teams = await tx.query<{ team_id: string; name: string; points: unknown }>(
        'select team_id, name, points from competition_team_standings where competition_id = $1 and points > 0 order by points desc, finish_s asc limit 3',
        [compId],
      );
      for (const [i, t] of teams.rows.entries()) {
        const members = await tx.query<{ user_id: string }>('select user_id from competition_participants where competition_id = $1 and team_id = $2', [compId, t.team_id]);
        for (const m of members.rows) await award(m.user_id, medals[i], `${medals[i][0].toUpperCase()}${medals[i].slice(1)}: ${c.title} (team ${t.name})`, t.team_id);
      }
      const top = await tx.query<{ team_id: string; user_id: string; name: string }>(
        `select distinct on (s.team_id) s.team_id, s.user_id, t.name from competition_scores s join competition_teams t on t.id = s.team_id
          where s.competition_id = $1 and s.team_id is not null and s.points > 0 order by s.team_id, s.points desc, s.finish_s asc`,
        [compId],
      );
      for (const t of top.rows) await award(t.user_id, 'top_contributor', `Top contributor for team ${t.name}: ${c.title}`, t.team_id);
    } else if (c.kind === 'quest') {
      const goal = Number((c.rules as Record<string, unknown> | null)?.goal ?? 0) || 0;
      const total = await tx.query<{ n: unknown }>('select coalesce(sum(solved), 0) as n from competition_scores where competition_id = $1', [compId]);
      if (num(total.rows[0].n) >= goal && goal > 0) {
        const helpers = await tx.query<{ user_id: string }>('select user_id from competition_scores where competition_id = $1 and solved > 0', [compId]);
        for (const h of helpers.rows) await award(h.user_id, 'quest', `Quest complete: ${c.title}`);
      }
    } else {
      const top = await tx.query<{ user_id: string }>(
        'select user_id from competition_scores where competition_id = $1 and points > 0 order by points desc, finish_s asc limit 3',
        [compId],
      );
      for (const [i, s] of top.rows.entries()) await award(s.user_id, medals[i], `${medals[i][0].toUpperCase()}${medals[i].slice(1)}: ${c.title}`);
    }

    if (c.kind !== 'quest') {
      const firsts = await tx.query<{ ordinal: number; user_id: string }>(
        `select distinct on (ordinal) ordinal, user_id from competition_submissions where competition_id = $1 and passed order by ordinal, submitted_at asc, id asc`,
        [compId],
      );
      for (const f of firsts.rows) await award(f.user_id, 'first_solve', `First to solve problem ${f.ordinal}: ${c.title}`);
      const helpful = await tx.query<{ user_id: string; n: unknown }>(
        `select user_id, (contributions ->> 'answers')::int as n from competition_scores where competition_id = $1 and (contributions ->> 'answers')::int > 0 order by n desc limit 1`,
        [compId],
      );
      if (helpful.rows[0]) await award(helpful.rows[0].user_id, 'most_helpful', `Most helpful: ${c.title}`);
    }

    await notify(
      tx,
      hub,
      participants.rows.map((p) => p.user_id),
      { kind: 'contest', title: `Results are in: ${c.title}`, body: 'See the final board and any awards on the contest page.', link: `/competitions/${compId}` },
    );
  });
}

/* ----------------------------------------------------------------------------- reading */

async function loadComp(db: Db, hub: Hub, id: string): Promise<CompRow | null> {
  const r = await db.query<CompRow>(`select ${COMP_SELECT} from competitions c where c.id = $1`, [id]);
  return r.rows[0] ? syncStatus(db, hub, r.rows[0]) : null;
}

/** Visibility: drafts only to their creator; group contests to members; the rest to everyone signed in. */
async function canSee(q: Queryable, c: CompRow, userId: string): Promise<boolean> {
  if (c.created_by === userId) return true;
  if (c.status === 'draft') return false;
  if (c.group_id) return !!(await groupRole(q, c.group_id, userId));
  return true;
}

async function requireVisible(db: Db, hub: Hub, id: string, userId: string): Promise<CompRow> {
  const c = await loadComp(db, hub, id);
  if (!c || !(await canSee(db, c, userId))) throw new HttpError(404, 'not_found', 'That contest does not exist, or you cannot see it.');
  return c;
}

async function loadProblems(q: Queryable, id: string): Promise<Problem[]> {
  const r = await q.query<{ ordinal: number; kind: 'lab' | 'check'; content_id: string; level: string | null; points: number }>(
    'select ordinal, kind, content_id, level, points from competition_problems where competition_id = $1 order by ordinal',
    [id],
  );
  return r.rows.map((p) => ({ ordinal: num(p.ordinal), kind: p.kind, contentId: p.content_id, level: p.level, points: num(p.points) }));
}

const problemsVisible = (c: CompRow, userId: string) => c.created_by === userId || c.status === 'live' || c.status === 'scoring' || c.status === 'finished';

export interface Standing {
  rank: number;
  person: Person | null;
  teamId: string | null;
  points: number;
  solved: number;
  finishS: number;
  penaltyS: number;
  contributions: Record<string, number>;
  solvedOrdinals: number[];
}

async function board(db: Db, c: CompRow, userId: string) {
  const scores = await db.query<{ user_id: string; team_id: string | null; points: unknown; solved: unknown; finish_s: unknown; penalty_s: unknown; contributions: unknown }>(
    `select p.user_id, p.team_id, coalesce(s.points, 0) as points, coalesce(s.solved, 0) as solved, coalesce(s.finish_s, 0) as finish_s, coalesce(s.penalty_s, 0) as penalty_s,
            coalesce(s.contributions, '{}'::jsonb) as contributions
       from competition_participants p left join competition_scores s on s.competition_id = p.competition_id and s.user_id = p.user_id
      where p.competition_id = $1 order by coalesce(s.points, 0) desc, coalesce(s.finish_s, 0) asc, p.joined_at asc`,
    [c.id],
  );
  const solvedRows = await db.query<{ user_id: string; ordinal: number }>('select distinct user_id, ordinal from competition_submissions where competition_id = $1 and passed', [c.id]);
  const solvedBy = new Map<string, number[]>();
  for (const s of solvedRows.rows) solvedBy.set(s.user_id, [...(solvedBy.get(s.user_id) ?? []), num(s.ordinal)].sort((a, b) => a - b));
  const people = await loadPeople(db, scores.rows.map((s) => s.user_id));
  const standings: Standing[] = scores.rows.map((s, i) => ({
    rank: i + 1,
    person: people.get(s.user_id) ?? null,
    teamId: s.team_id,
    points: num(s.points),
    solved: num(s.solved),
    finishS: num(s.finish_s),
    penaltyS: num(s.penalty_s),
    contributions: Object.fromEntries(Object.entries((s.contributions ?? {}) as Record<string, unknown>).map(([k, v]) => [k, num(v)])),
    solvedOrdinals: solvedBy.get(s.user_id) ?? [],
  }));

  let teams: Array<{ id: string; name: string; rank: number; points: number; basePoints: number; members: number; scorers: number; finishS: number }> = [];
  if (c.kind === 'group') {
    const all = await db.query<{ id: string; name: string }>('select id, name from competition_teams where competition_id = $1 order by created_at', [c.id]);
    const st = await db.query<{ team_id: string; points: unknown; base_points: unknown; members: unknown; scorers: unknown; finish_s: unknown }>(
      'select team_id, points, base_points, members, scorers, finish_s from competition_team_standings where competition_id = $1',
      [c.id],
    );
    const byTeam = new Map(st.rows.map((t) => [t.team_id, t]));
    teams = all.rows
      .map((t) => {
        const s = byTeam.get(t.id);
        const memberCount = standings.filter((x) => x.teamId === t.id).length;
        return { id: t.id, name: t.name, rank: 0, points: num(s?.points ?? 0), basePoints: num(s?.base_points ?? 0), members: s ? num(s.members) : memberCount, scorers: num(s?.scorers ?? 0), finishS: num(s?.finish_s ?? 0) };
      })
      .sort((a, b) => b.points - a.points || a.finishS - b.finishS)
      .map((t, i) => ({ ...t, rank: i + 1 }));
  }

  const mine = standings.find((s) => s.person?.id === userId) ?? null;
  const awards = await db.query<{ user_id: string; kind: string; label: string; team_id: string | null }>('select user_id, kind, label, team_id from awards where competition_id = $1 order by id', [c.id]);
  const quest = c.kind === 'quest' ? { goal: Number((c.rules as Record<string, unknown> | null)?.goal ?? 0) || 0, solved: standings.reduce((n, s) => n + s.solved, 0) } : null;
  return { standings, teams, mine, quest, awards: awards.rows.map((a) => ({ userId: a.user_id, kind: a.kind, label: a.label, teamId: a.team_id })) };
}

/* ----------------------------------------------------------------------------- routes */

export function registerCompetitions(app: FastifyInstance, deps: Deps): void {
  const { db, requireAuth, hub } = deps;

  app.get('/api/competitions', { preHandler: requireAuth }, async (req) => {
    const { scope, groupId } = z.object({ scope: z.enum(['open', 'group', 'mine']).default('open'), groupId: uuid.optional() }).parse(req.query ?? {});
    const userId = req.userId!;
    let rows: CompRow[];
    if (scope === 'group') {
      if (!groupId) throw new HttpError(400, 'invalid', 'Which group?');
      await requireGroupMember(db, groupId, userId);
      rows = (await db.query<CompRow>(`select ${COMP_SELECT} from competitions c where c.group_id = $1 and (c.status <> 'draft' or c.created_by = $2) order by c.starts_at desc limit 50`, [groupId, userId])).rows;
    } else if (scope === 'mine') {
      rows = (
        await db.query<CompRow>(
          `select ${COMP_SELECT} from competitions c where c.created_by = $1 or exists (select 1 from competition_participants p where p.competition_id = c.id and p.user_id = $1)
            order by c.starts_at desc limit 50`,
          [userId],
        )
      ).rows;
    } else {
      rows = (
        await db.query<CompRow>(
          `select ${COMP_SELECT} from competitions c where c.group_id is null and c.kind = 'general' and (c.status in ('scheduled', 'live', 'scoring', 'finished') or c.created_by = $1)
            order by (c.status in ('live', 'scheduled')) desc, c.starts_at desc limit 50`,
          [userId],
        )
      ).rows;
    }
    const synced: Competition[] = [];
    for (const r of rows) synced.push(toCompetition(await syncStatus(db, hub, r)));
    return { competitions: synced };
  });

  app.post('/api/competitions', { preHandler: requireAuth }, async (req, reply) => {
    const body = competitionBody.parse(req.body);
    const userId = req.userId!;
    const role = await platformRole(db, userId);
    if (body.groupId) {
      const gr = await groupRole(db, body.groupId, userId);
      if (!isGroupAdminRole(gr) && !isFacilitatorRole(role)) throw new HttpError(403, 'forbidden', 'Only the group owner, an admin or a facilitator can run a contest in a group.');
      if (!gr) throw new HttpError(403, 'not_a_member', 'Join the group first.');
    } else if (!isFacilitatorRole(role)) {
      throw new HttpError(403, 'not_facilitator', 'Open contests are run by facilitators. You can declare yourself one on your profile.');
    }
    const teamMin = body.kind === 'group' ? (body.teamMin ?? 2) : 1;
    const teamMax = body.kind === 'group' ? (body.teamMax ?? 5) : 1;
    const id = await db.transaction(async (tx) => {
      const c = await tx.query<{ id: string }>(
        `insert into competitions (kind, status, title, description, course_slug, group_id, created_by, starts_at, ends_at, team_min, team_max, hint_penalty, wrong_run_penalty_s, rules)
         values ($1::competition_kind, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) returning id`,
        [body.kind, body.title, body.description || null, body.courseSlug || null, body.groupId ?? null, userId, body.startsAt, body.endsAt, teamMin, teamMax, body.hintPenalty, body.wrongRunPenaltyS, JSON.stringify(body.rules)],
      );
      for (const [i, p] of body.problems.entries()) {
        await tx.query('insert into competition_problems (competition_id, ordinal, kind, content_id, level, points) values ($1, $2, $3, $4, $5, $6)', [c.rows[0].id, i + 1, p.kind, p.contentId, p.level ?? null, p.points]);
      }
      return c.rows[0].id;
    });
    const c = await loadComp(db, hub, id);
    return reply.status(201).send({ competition: toCompetition(c!), problems: await loadProblems(db, id) });
  });

  app.get('/api/competitions/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const c = await requireVisible(db, hub, id, userId);
    const me = await db.query<{ team_id: string | null; joined_at: unknown }>('select team_id, joined_at from competition_participants where competition_id = $1 and user_id = $2', [id, userId]);
    const teams = await db.query<{ id: string; name: string; group_id: string | null; members: unknown }>(
      'select t.id, t.name, t.group_id, (select count(*) from competition_participants p where p.team_id = t.id) as members from competition_teams t where t.competition_id = $1 order by t.created_at',
      [id],
    );
    const creator = await loadPeople(db, [c.created_by]);
    return {
      competition: toCompetition(c),
      creator: creator.get(c.created_by) ?? null,
      problems: problemsVisible(c, userId) ? await loadProblems(db, id) : null,
      registration: me.rows[0] ? { teamId: me.rows[0].team_id, joinedAt: iso(me.rows[0].joined_at) } : null,
      teams: teams.rows.map((t) => ({ id: t.id, name: t.name, groupId: t.group_id, members: num(t.members) })),
      canManage: c.created_by === userId,
    };
  });

  /** The creator publishes (draft → scheduled), cancels, or edits while nobody can see the problems yet. */
  app.patch('/api/competitions/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z
      .object({
        status: z.enum(['scheduled', 'cancelled']).optional(),
        title: text(160, 3).optional(),
        description: z.string().trim().max(4000).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }).optional(),
        problems: z.array(problemBody).min(1).max(30).optional(),
      })
      .parse(req.body);
    const userId = req.userId!;
    const c = await loadComp(db, hub, id);
    if (!c || c.created_by !== userId) throw new HttpError(404, 'not_found', 'That contest does not exist, or you cannot manage it.');
    if (c.status === 'finished' || c.status === 'cancelled') throw new HttpError(409, 'closed', 'This contest is over and cannot be changed.');
    await db.transaction(async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [id];
      const add = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.title !== undefined) add('title', body.title);
      if (body.description !== undefined) add('description', body.description || null);
      if (body.startsAt !== undefined) add('starts_at', body.startsAt);
      if (body.endsAt !== undefined) add('ends_at', body.endsAt);
      if (body.status) add('status', body.status);
      if (sets.length) await tx.query(`update competitions set ${sets.join(', ')} where id = $1`, params);
      if (body.problems) {
        if (c.status === 'live') throw new HttpError(409, 'live', 'Problems cannot change while the contest is live.');
        await tx.query('delete from competition_problems where competition_id = $1', [id]);
        for (const [i, p] of body.problems.entries()) {
          await tx.query('insert into competition_problems (competition_id, ordinal, kind, content_id, level, points) values ($1, $2, $3, $4, $5, $6)', [id, i + 1, p.kind, p.contentId, p.level ?? null, p.points]);
        }
      }
    });
    if (body.status === 'scheduled' && c.status === 'draft' && c.group_id) {
      const members = await db.query<{ user_id: string }>('select user_id from group_members where group_id = $1 and user_id <> $2', [c.group_id, userId]);
      await notify(db, hub, members.rows.map((m) => m.user_id), {
        kind: 'contest',
        title: `${c.kind === 'quest' ? 'New quest' : 'New contest'} in your group: ${body.title ?? c.title}`,
        body: `Starts ${new Date(body.startsAt ?? iso(c.starts_at)).toUTCString()}.`,
        link: `/competitions/${id}`,
      });
    }
    const fresh = await loadComp(db, hub, id);
    return { competition: toCompetition(fresh!) };
  });

  app.post('/api/competitions/:id/register', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ teamId: uuid.optional(), teamName: z.string().trim().min(2).max(60).optional() }).parse(req.body ?? {});
    const userId = req.userId!;
    const c = await requireVisible(db, hub, id, userId);
    if (!(c.status === 'scheduled' || c.status === 'live') || Date.now() >= Date.parse(iso(c.ends_at))) {
      throw new HttpError(409, 'not_open', 'Registration is closed for this contest.');
    }
    if (c.group_id) await requireGroupMember(db, c.group_id, userId);
    let teamId: string | null = null;
    if (c.kind === 'group') {
      if (body.teamId) {
        const t = await db.query<{ id: string; members: unknown }>('select t.id, (select count(*) from competition_participants p where p.team_id = t.id) as members from competition_teams t where t.id = $1 and t.competition_id = $2', [body.teamId, id]);
        if (!t.rows[0]) throw new HttpError(404, 'not_found', 'No such team.');
        if (num(t.rows[0].members) >= num(c.team_max)) throw new HttpError(409, 'team_full', 'That team is full.');
        teamId = t.rows[0].id;
      } else if (body.teamName) {
        const taken = await db.query('select 1 from competition_teams where competition_id = $1 and lower(name) = lower($2)', [id, body.teamName]);
        if (taken.rows.length) throw new HttpError(409, 'team_exists', 'A team with that name already exists. Join it instead.');
        const t = await db.query<{ id: string }>('insert into competition_teams (competition_id, group_id, name, created_by) values ($1, $2, $3, $4) returning id', [id, c.group_id, body.teamName, userId]);
        teamId = t.rows[0].id;
      } else {
        throw new HttpError(400, 'team_required', 'Pick a team to join or give a name for a new one.');
      }
    }
    await db.query(
      'insert into competition_participants (competition_id, user_id, team_id) values ($1, $2, $3) on conflict (competition_id, user_id) do update set team_id = excluded.team_id',
      [id, userId, teamId],
    );
    await db.query('update competition_scores set team_id = $3 where competition_id = $1 and user_id = $2', [id, userId, teamId]);
    return { registration: { teamId, joinedAt: new Date().toISOString() } };
  });

  /** Live contests the caller is registered in that include this lab or check, so the lab page can submit. */
  app.get('/api/competitions/active', { preHandler: requireAuth }, async (req) => {
    const { labId, checkId } = z.object({ labId: z.string().trim().max(200).optional(), checkId: z.string().trim().max(200).optional() }).parse(req.query ?? {});
    const userId = req.userId!;
    const contentId = labId ?? checkId;
    if (!contentId) return { active: [] };
    const rows = await db.query<CompRow & { ordinal: number }>(
      `select ${COMP_SELECT}, pr.ordinal from competitions c
         join competition_participants p on p.competition_id = c.id and p.user_id = $1
         join competition_problems pr on pr.competition_id = c.id and pr.content_id = $2
        where c.status in ('scheduled', 'live') order by c.ends_at`,
      [userId, contentId],
    );
    const active = [];
    for (const r of rows.rows) {
      const c = await syncStatus(db, hub, r);
      if (c.status === 'live') active.push({ competitionId: c.id, title: c.title, ordinal: num(r.ordinal), endsAt: iso(c.ends_at) });
    }
    return { active };
  });

  app.post('/api/competitions/:id/submissions', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ ordinal: z.number().int().min(1).max(30), passed: z.boolean(), hintsUsed: z.number().int().min(0).max(100).default(0) }).parse(req.body);
    const userId = req.userId!;
    const c = await requireVisible(db, hub, id, userId);
    const now = Date.now();
    if (c.status !== 'live' || now < Date.parse(iso(c.starts_at)) || now > Date.parse(iso(c.ends_at))) {
      throw new HttpError(409, 'not_live', 'This contest is not running right now, so nothing can be submitted.');
    }
    const reg = await db.query('select 1 from competition_participants where competition_id = $1 and user_id = $2', [id, userId]);
    if (!reg.rows.length) throw new HttpError(403, 'not_registered', 'Register for the contest before submitting.');
    const problem = await db.query('select 1 from competition_problems where competition_id = $1 and ordinal = $2', [id, body.ordinal]);
    if (!problem.rows.length) throw new HttpError(404, 'not_found', 'No such problem in this contest.');
    await db.query('insert into competition_submissions (competition_id, ordinal, user_id, passed, hints_used) values ($1, $2, $3, $4, $5)', [id, body.ordinal, userId, body.passed, body.hintsUsed]);
    const s = await db.query<{ points: unknown; solved: unknown; finish_s: unknown }>('select points, solved, finish_s from competition_scores where competition_id = $1 and user_id = $2', [id, userId]);
    const score = s.rows[0] ? { points: num(s.rows[0].points), solved: num(s.rows[0].solved), finishS: num(s.rows[0].finish_s) } : { points: 0, solved: 0, finishS: 0 };
    return reply.status(201).send({ score });
  });

  app.get('/api/competitions/:id/board', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = req.userId!;
    const c = await requireVisible(db, hub, id, userId);
    return { status: c.status, endsAt: iso(c.ends_at), ...(await board(db, c, userId)) };
  });

  app.get('/api/me/awards', { preHandler: requireAuth }, async (req) => {
    const r = await db.query<{ id: unknown; kind: string; label: string; competition_id: string | null; title: string | null; awarded_at: unknown }>(
      'select a.id, a.kind, a.label, a.competition_id, c.title, a.awarded_at from awards a left join competitions c on c.id = a.competition_id where a.user_id = $1 order by a.awarded_at desc limit 100',
      [req.userId],
    );
    return { awards: r.rows.map((a) => ({ id: num(a.id), kind: a.kind, label: a.label, competitionId: a.competition_id, competitionTitle: a.title, awardedAt: iso(a.awarded_at) })) };
  });
}
