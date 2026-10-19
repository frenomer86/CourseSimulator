/** Competitions: visibility, registration, submissions, scoring, team standings and awards. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type Db } from './db.js';
import { migrate } from './migrate.js';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await openDb({});
  await migrate(db);
  app = await buildApp({ db });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const json = (res: { body: string }) => JSON.parse(res.body);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface Account {
  token: string;
  id: string;
  username: string;
}

async function signUp(email: string, displayName: string): Promise<Account> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email, password: 'secret123', displayName } });
  const b = json(res);
  return { token: b.token, id: b.user.id, username: b.profile.username };
}

const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const LAB_B1 = 'digital-logic-design-b1-meet-the-gates';
const LAB_I1 = 'digital-logic-design-i1-half-adder';
const CHECK = 'digital-logic-design:2:3';
const problems = [
  { kind: 'lab', contentId: LAB_B1, level: 'beginner', points: 100 },
  { kind: 'lab', contentId: LAB_I1, level: 'intermediate', points: 200 },
  { kind: 'check', contentId: CHECK, points: 100 },
];

let ama: Account; // facilitator
let kofi: Account;
let esi: Account;
let yaw: Account;

describe('general contest', () => {
  let compId = '';

  it('only a facilitator creates an open contest; it starts as a draft only the creator sees', async () => {
    ama = await signUp('ama@example.com', 'Ama');
    kofi = await signUp('kofi@example.com', 'Kofi');
    esi = await signUp('esi@example.com', 'Esi');
    yaw = await signUp('yaw@example.com', 'Yaw');
    const learner = await app.inject({
      method: 'POST',
      url: '/api/competitions',
      headers: auth(kofi.token),
      payload: { kind: 'general', title: 'Gates sprint', startsAt: minutes(5), endsAt: minutes(65), problems },
    });
    expect(learner.statusCode).toBe(403);
    await app.inject({ method: 'POST', url: '/api/me/facilitator', headers: auth(ama.token) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/competitions',
      headers: auth(ama.token),
      payload: { kind: 'general', title: 'Gates sprint', description: 'Three problems, one hour.', startsAt: minutes(5), endsAt: minutes(65), problems },
    });
    expect(res.statusCode).toBe(201);
    compId = json(res).competition.id;
    expect(json(res).competition.status).toBe('draft');
    expect((await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(kofi.token) })).statusCode).toBe(404);
    const open = json(await app.inject({ method: 'GET', url: '/api/competitions', headers: auth(kofi.token) })).competitions;
    expect(open).toEqual([]);
  });

  it('once published it is listed, learners register, but problems stay hidden until it is live', async () => {
    const publish = await app.inject({ method: 'PATCH', url: `/api/competitions/${compId}`, headers: auth(ama.token), payload: { status: 'scheduled' } });
    expect(publish.statusCode).toBe(200);
    expect(json(publish).competition.status).toBe('scheduled');
    const view = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(kofi.token) }));
    expect(view.competition.problemCount).toBe(3);
    expect(view.problems).toBeNull();
    const creatorView = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(ama.token) }));
    expect(creatorView.problems).toHaveLength(3);
    for (const a of [kofi, esi, yaw]) {
      const reg = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(a.token), payload: {} });
      expect(reg.statusCode).toBe(200);
    }
    const early = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: true } });
    expect(early.statusCode).toBe(409);
    expect(json(early).error).toBe('not_live');
  });

  it('goes live with the clock; submissions score once per problem with hint and wrong-run penalties, speed breaks ties', async () => {
    await db.query("update competitions set starts_at = now() - interval '10 minutes', ends_at = now() + interval '50 minutes' where id = $1", [compId]);
    const view = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(kofi.token) }));
    expect(view.competition.status).toBe('live');
    expect(view.problems.map((p: { contentId: string }) => p.contentId)).toEqual([LAB_B1, LAB_I1, CHECK]);

    const active = json(await app.inject({ method: 'GET', url: `/api/competitions/active?labId=${LAB_B1}`, headers: auth(kofi.token) })).active;
    expect(active).toEqual([{ competitionId: compId, title: 'Gates sprint', ordinal: 1, endsAt: expect.any(String) }]);
    expect(json(await app.inject({ method: 'GET', url: `/api/competitions/active?labId=${LAB_B1}`, headers: auth(ama.token) })).active).toEqual([]);

    const notRegistered = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(ama.token), payload: { ordinal: 1, passed: true } });
    expect(notRegistered.statusCode).toBe(403);

    // Kofi: fails once then passes problem 1 (wrong-run penalty), passes problem 2 with 1 hint (20% off).
    expect((await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: false } })).statusCode).toBe(201);
    const k1 = json(await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: true } }));
    expect(k1.score).toMatchObject({ points: 100, solved: 1 });
    expect(k1.score.finishS).toBeGreaterThanOrEqual(300 + 600);
    const k2 = json(await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 2, passed: true, hintsUsed: 1 } }));
    expect(k2.score).toMatchObject({ points: 260, solved: 2 });
    // Solving the same problem again adds nothing.
    const k1b = json(await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: true } }));
    expect(k1b.score.points).toBe(260);

    // Esi: the same 260 points but without the wrong run, so she finishes faster and ranks first.
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(esi.token), payload: { ordinal: 1, passed: true } });
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(esi.token), payload: { ordinal: 2, passed: true, hintsUsed: 1 } });
    // Yaw: one check.
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(yaw.token), payload: { ordinal: 3, passed: true } });

    const board = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}/board`, headers: auth(ama.token) }));
    expect(board.status).toBe('live');
    expect(board.standings.map((s: { person: { username: string }; rank: number; points: number }) => [s.rank, s.person.username, s.points])).toEqual([
      [1, esi.username, 260],
      [2, kofi.username, 260],
      [3, yaw.username, 100],
    ]);
    expect(board.standings[1].contributions).toMatchObject({ beginner: 1, intermediate: 1, advanced: 0, checks: 0, answers: 0, resources: 0 });
    expect(board.standings[1].solvedOrdinals).toEqual([1, 2]);
    expect(board.standings[2].contributions).toMatchObject({ checks: 1 });
    expect(board.standings[1].penaltyS).toBe(300);
  });

  it('ends with the clock: awards gold, silver, bronze and first solves, notifies participants, and refuses late submissions', async () => {
    await db.query("update competitions set ends_at = now() - interval '1 second' where id = $1", [compId]);
    const view = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(kofi.token) }));
    expect(view.competition.status).toBe('finished');
    const late = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 3, passed: true } });
    expect(late.statusCode).toBe(409);
    const board = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}/board`, headers: auth(kofi.token) }));
    const kinds = (userId: string) => board.awards.filter((a: { userId: string }) => a.userId === userId).map((a: { kind: string }) => a.kind).sort();
    expect(kinds(esi.id)).toEqual(['gold']);
    expect(kinds(kofi.id)).toEqual(['first_solve', 'first_solve', 'silver']);
    expect(kinds(yaw.id)).toEqual(['bronze', 'first_solve']);
    const mine = json(await app.inject({ method: 'GET', url: '/api/me/awards', headers: auth(esi.token) })).awards;
    expect(mine[0]).toMatchObject({ kind: 'gold', competitionTitle: 'Gates sprint' });
    const profile = json(await app.inject({ method: 'GET', url: `/api/people/${esi.username}`, headers: auth(kofi.token) }));
    expect(profile.awards[0].kind).toBe('gold');
    const inbox = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(yaw.token) })).notifications;
    expect(inbox[0]).toMatchObject({ kind: 'contest', link: `/competitions/${compId}` });
    // Finalisation happened exactly once.
    const again = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}/board`, headers: auth(kofi.token) }));
    expect(again.awards).toHaveLength(board.awards.length);
    // Registration is closed too.
    expect((await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(ama.token), payload: {} })).statusCode).toBe(409);
    const closed = await app.inject({ method: 'PATCH', url: `/api/competitions/${compId}`, headers: auth(ama.token), payload: { title: 'Renamed' } });
    expect(closed.statusCode).toBe(409);
  });
});

describe('group contest and quest', () => {
  let groupId = '';
  let compId = '';
  let questId = '';

  it('a group admin runs a team contest that only members can see and join', async () => {
    const g = json(await app.inject({ method: 'POST', url: '/api/groups', headers: auth(kofi.token), payload: { name: 'Team practice' } })).group;
    groupId = g.id;
    for (const a of [esi, yaw]) await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(a.token), payload: { code: g.joinCode } });
    const outsider = await app.inject({
      method: 'POST',
      url: '/api/competitions',
      headers: auth(ama.token),
      payload: { kind: 'group', groupId, title: 'Pairs cup', startsAt: minutes(-1), endsAt: minutes(60), teamMin: 1, teamMax: 2, problems },
    });
    expect(outsider.statusCode).toBe(403);
    const res = await app.inject({
      method: 'POST',
      url: '/api/competitions',
      headers: auth(kofi.token),
      payload: { kind: 'group', groupId, title: 'Pairs cup', startsAt: minutes(-1), endsAt: minutes(60), teamMin: 1, teamMax: 2, problems },
    });
    expect(res.statusCode).toBe(201);
    compId = json(res).competition.id;
    await app.inject({ method: 'PATCH', url: `/api/competitions/${compId}`, headers: auth(kofi.token), payload: { status: 'scheduled' } });
    expect((await app.inject({ method: 'GET', url: `/api/competitions/${compId}`, headers: auth(ama.token) })).statusCode).toBe(404);
    const list = json(await app.inject({ method: 'GET', url: `/api/competitions?scope=group&groupId=${groupId}`, headers: auth(esi.token) })).competitions;
    expect(list.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([[compId, 'live']]);
    const notes = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(esi.token) })).notifications;
    expect(notes[0]).toMatchObject({ kind: 'contest', title: 'New contest in your group: Pairs cup' });
  });

  it('teams form up to team_max; the standings view sums the top members with a bonus when everyone scores', async () => {
    const noTeam = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(kofi.token), payload: {} });
    expect(noTeam.statusCode).toBe(400);
    const k = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(kofi.token), payload: { teamName: 'Nand Lovers' } });
    expect(k.statusCode).toBe(200);
    const teamId = json(k).registration.teamId as string;
    expect((await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(esi.token), payload: { teamId } })).statusCode).toBe(200);
    const full = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(yaw.token), payload: { teamId } });
    expect(full.statusCode).toBe(409);
    const y = await app.inject({ method: 'POST', url: `/api/competitions/${compId}/register`, headers: auth(yaw.token), payload: { teamName: 'Solo Xor' } });
    expect(y.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: true } });
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(esi.token), payload: { ordinal: 2, passed: true } });
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(yaw.token), payload: { ordinal: 1, passed: true } });
    await app.inject({ method: 'POST', url: `/api/competitions/${compId}/submissions`, headers: auth(yaw.token), payload: { ordinal: 3, passed: true } });

    const board = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}/board`, headers: auth(esi.token) }));
    // Nand Lovers: 100 + 200 = 300, everyone scored → 330. Solo Xor: 200, everyone scored → 220.
    expect(board.teams.map((t: { name: string; points: number; basePoints: number; members: number; scorers: number; rank: number }) => [t.rank, t.name, t.basePoints, t.points, t.members, t.scorers])).toEqual([
      [1, 'Nand Lovers', 300, 330, 2, 2],
      [2, 'Solo Xor', 200, 220, 1, 1],
    ]);
    expect(board.standings.find((s: { person: { id: string } }) => s.person.id === esi.id)).toMatchObject({ teamId, points: 200, contributions: expect.objectContaining({ intermediate: 1 }) });
    const view = await db.query<{ points: unknown }>('select points from competition_team_standings where competition_id = $1 order by points desc', [compId]);
    expect(view.rows.map((r) => Number(r.points))).toEqual([330, 220]);
  });

  it('awards team medals and a top contributor per team when the contest ends', async () => {
    await db.query("update competitions set ends_at = now() - interval '1 second' where id = $1", [compId]);
    const board = json(await app.inject({ method: 'GET', url: `/api/competitions/${compId}/board`, headers: auth(kofi.token) }));
    expect(board.status).toBe('finished');
    const kinds = (userId: string) => board.awards.filter((a: { userId: string }) => a.userId === userId).map((a: { kind: string }) => a.kind).sort();
    expect(kinds(kofi.id)).toEqual(['first_solve', 'gold']);
    expect(kinds(esi.id)).toEqual(['first_solve', 'gold', 'top_contributor']);
    expect(kinds(yaw.id)).toEqual(['first_solve', 'silver', 'top_contributor']);
  });

  it('a co-op quest inside the group rewards everyone who contributed once the goal is met', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/competitions',
      headers: auth(kofi.token),
      payload: { kind: 'quest', groupId, title: 'Three gates together', startsAt: minutes(-1), endsAt: minutes(60), rules: { goal: 2 }, problems: problems.slice(0, 2) },
    });
    expect(res.statusCode).toBe(201);
    questId = json(res).competition.id;
    await app.inject({ method: 'PATCH', url: `/api/competitions/${questId}`, headers: auth(kofi.token), payload: { status: 'scheduled' } });
    expect((await app.inject({ method: 'POST', url: `/api/competitions/${questId}/register`, headers: auth(ama.token), payload: {} })).statusCode).toBe(404);
    for (const a of [kofi, esi, yaw]) expect((await app.inject({ method: 'POST', url: `/api/competitions/${questId}/register`, headers: auth(a.token), payload: {} })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/competitions/${questId}/submissions`, headers: auth(kofi.token), payload: { ordinal: 1, passed: true } });
    let board = json(await app.inject({ method: 'GET', url: `/api/competitions/${questId}/board`, headers: auth(kofi.token) }));
    expect(board.quest).toEqual({ goal: 2, solved: 1 });
    await app.inject({ method: 'POST', url: `/api/competitions/${questId}/submissions`, headers: auth(esi.token), payload: { ordinal: 2, passed: true } });
    await db.query("update competitions set ends_at = now() - interval '1 second' where id = $1", [questId]);
    board = json(await app.inject({ method: 'GET', url: `/api/competitions/${questId}/board`, headers: auth(kofi.token) }));
    expect(board.quest).toEqual({ goal: 2, solved: 2 });
    const winners = board.awards.filter((a: { kind: string }) => a.kind === 'quest').map((a: { userId: string }) => a.userId).sort();
    expect(winners).toEqual([kofi.id, esi.id].sort());
  });
});
