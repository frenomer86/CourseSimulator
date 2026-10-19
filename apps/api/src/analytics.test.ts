/** Consent, event ingestion and the learner's own data, against in-memory Postgres. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { openDb, type Db } from './db.js';
import { migrate } from './migrate.js';
import { researchIdFor } from './analytics.js';

let db: Db;
let app: FastifyInstance;
const SALT = 'test-salt';

beforeAll(async () => {
  db = await openDb({});
  await migrate(db);
  app = await buildApp({ db, researchSalt: SALT });
});

afterAll(async () => {
  await app.close();
  await db.close();
});

const json = (res: { body: string }) => JSON.parse(res.body);
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(email: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email, password: 'secret123' } });
  expect(res.statusCode).toBe(201);
  return json(res) as { token: string; user: { id: string } };
}

let n = 0;
const uuid = () => {
  n += 1;
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
const SESSION = '11111111-1111-4111-8111-111111111111';

function event(over: Record<string, unknown> = {}) {
  return {
    id: uuid(),
    occurredAt: new Date().toISOString(),
    verb: 'passed',
    objectType: 'lab',
    objectId: 'digital-logic-design-b1-meet-the-gates',
    course: 'digital-logic-design',
    unit: 2,
    topic: 3,
    labId: 'digital-logic-design-b1-meet-the-gates',
    labLevel: 'beginner',
    result: { score: 1, hintsUsed: 0 },
    sessionId: SESSION,
    deviceClass: 'phone',
    connectionClass: '3g',
    appVersion: '0.1.0',
    ...over,
  };
}

describe('research consent', () => {
  let token = '';
  let userId = '';

  it('starts with no consent and the current notice version', async () => {
    const me = await signUp('kofi@example.com');
    token = me.token;
    userId = me.user.id;
    const res = await app.inject({ method: 'GET', url: '/api/me/consent', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(json(res).consent).toBeNull();
    expect(json(res).noticeVersion).toBe('1');
  });

  it('records consent, then withdrawal, with history under the research id', async () => {
    const give = await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(token),
      payload: { noticeVersion: '1.0', researchEvents: true, researchSnapshots: false, researchSocial: false, contactFollowup: true },
    });
    expect(give.statusCode).toBe(200);
    expect(json(give).consent.researchEvents).toBe(true);
    expect(json(give).consent.withdrawnAt).toBeNull();

    const withdraw = await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(token),
      payload: { noticeVersion: '1.0', researchEvents: false, researchSnapshots: false, researchSocial: false, contactFollowup: false },
    });
    expect(withdraw.statusCode).toBe(200);
    expect(json(withdraw).consent.withdrawnAt).not.toBeNull();

    const rid = researchIdFor(SALT, userId);
    const history = await db.query('select research_events from analytics.consent_history where research_id = $1 order by id', [rid]);
    expect(history.rows.map((r) => r.research_events)).toEqual([true, false]);
    const log = await db.query("select count(*)::int as n from analytics.access_log where action = 'consent_change' and actor = $1", [userId]);
    expect(Number(log.rows[0].n)).toBe(2);
  });

  it('requires guardian consent for under-18 learners', async () => {
    const me = await signUp('abena@example.com');
    await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(me.token), payload: { ageBand: 'under_18' } });
    const no = await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(me.token),
      payload: { noticeVersion: '1.0', researchEvents: true, researchSnapshots: false, researchSocial: false, contactFollowup: false },
    });
    expect(no.statusCode).toBe(400);
    expect(json(no).error).toBe('guardian_required');
    const yes = await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(me.token),
      payload: { noticeVersion: '1.0', researchEvents: true, researchSnapshots: false, researchSocial: false, contactFollowup: false, guardianConsent: true },
    });
    expect(yes.statusCode).toBe(200);
  });
});

describe('event ingestion and your data', () => {
  let token = '';
  let userId = '';

  beforeAll(async () => {
    const me = await signUp('yaw@example.com');
    token = me.token;
    userId = me.user.id;
  });

  it('rejects anonymous and malformed batches', async () => {
    const anon = await app.inject({ method: 'POST', url: '/api/events', payload: { events: [event()] } });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/api/events', headers: auth(token), payload: { events: [event({ verb: 'danced' })] } });
    expect(bad.statusCode).toBe(400);
  });

  it('stores events under a research id, flags research consent at ingest time, and is idempotent', async () => {
    const e1 = event();
    const first = await app.inject({ method: 'POST', url: '/api/events', headers: auth(token), payload: { events: [e1, event({ verb: 'viewed', objectType: 'course', objectId: 'digital-logic-design' })] } });
    expect(first.statusCode).toBe(200);
    expect(json(first).accepted.length).toBe(2);
    const again = await app.inject({ method: 'POST', url: '/api/events', headers: auth(token), payload: { events: [e1] } });
    expect(again.statusCode).toBe(200);

    const rid = researchIdFor(SALT, userId);
    const rows = await db.query<{ verb: string; research_consented: boolean; research_id: string }>(
      'select verb, research_consented, research_id from analytics.learning_events where research_id = $1 order by id',
      [rid],
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.every((r) => r.research_consented === false)).toBe(true);
    expect(rows.rows[0].research_id).not.toBe(userId);

    await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(token),
      payload: { noticeVersion: '1.0', researchEvents: true, researchSnapshots: true, researchSocial: false, contactFollowup: false },
    });
    const after = await app.inject({ method: 'POST', url: '/api/events', headers: auth(token), payload: { events: [event({ verb: 'failed' })] } });
    expect(after.statusCode).toBe(200);
    const flagged = await db.query<{ research_consented: boolean }>("select research_consented from analytics.learning_events where research_id = $1 and verb = 'failed'", [rid]);
    expect(flagged.rows[0].research_consented).toBe(true);
  });

  it('stores a lab artefact as a snapshot and keeps only its hash in the event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: auth(token),
      payload: {
        events: [
          event({
            verb: 'saved',
            objectType: 'lab-artefact',
            result: { artefact: { nodes: [{ id: 'a', type: 'INPUT' }], wires: [] }, edits: 7 },
            context: { reason: 'submit' },
          }),
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const rid = researchIdFor(SALT, userId);
    const snap = await db.query<{ sha256: string; reason: string; research_consented: boolean }>('select sha256, reason, research_consented from analytics.lab_snapshots where research_id = $1', [rid]);
    expect(snap.rows.length).toBe(1);
    expect(snap.rows[0].reason).toBe('submit');
    expect(snap.rows[0].research_consented).toBe(true);
    const ev = await db.query<{ result: { sha256?: string; artefact?: unknown; edits?: number } }>("select result from analytics.learning_events where research_id = $1 and verb = 'saved'", [rid]);
    expect(ev.rows[0].result.sha256).toBe(snap.rows[0].sha256);
    expect(ev.rows[0].result.artefact).toBeUndefined();
    expect(ev.rows[0].result.edits).toBe(7);
  });

  it('shows the learner their own data and exports it as JSON and CSV', async () => {
    const data = await app.inject({ method: 'GET', url: '/api/me/data', headers: auth(token) });
    expect(data.statusCode).toBe(200);
    const body = json(data);
    expect(body.events.total).toBe(4);
    expect(body.events.inResearchStream).toBe(2);
    expect(body.snapshots.total).toBe(1);
    expect(body.recent[0].verb).toBeDefined();
    expect(body.researchId).toBe(researchIdFor(SALT, userId));

    const js = await app.inject({ method: 'GET', url: '/api/me/data/export', headers: auth(token) });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/json/);
    expect(json(js).events.length).toBe(4);
    expect(json(js).snapshots.length).toBe(1);

    const csv = await app.inject({ method: 'GET', url: '/api/me/data/export?format=csv', headers: auth(token) });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    const lines = csv.body.trim().split('\n');
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain('verb,object_type');

    const log = await db.query("select action, count(*)::int as n from analytics.access_log where actor = $1 group by action", [userId]);
    const actions = Object.fromEntries(log.rows.map((r) => [r.action, Number(r.n)]));
    expect(actions.export).toBe(2);
    expect(actions.reidentify).toBe(1);
  });

  it('deletes recorded activity on request regardless of consent', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/me/data', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(json(res).eventsDeleted).toBe(4);
    expect(json(res).snapshotsDeleted).toBe(1);
    const data = json(await app.inject({ method: 'GET', url: '/api/me/data', headers: auth(token) }));
    expect(data.events.total).toBe(0);
  });
});

describe('account deletion', () => {
  it('keeps consented events, drops the rest, and logs it', async () => {
    const me = await signUp('esi@example.com');
    const rid = researchIdFor(SALT, me.user.id);
    await app.inject({ method: 'POST', url: '/api/events', headers: auth(me.token), payload: { events: [event({ verb: 'viewed', objectType: 'course', objectId: 'c' })] } });
    await app.inject({
      method: 'PUT',
      url: '/api/me/consent',
      headers: auth(me.token),
      payload: { noticeVersion: '1.0', researchEvents: true, researchSnapshots: false, researchSocial: false, contactFollowup: false },
    });
    await app.inject({ method: 'POST', url: '/api/events', headers: auth(me.token), payload: { events: [event({ verb: 'passed' })] } });
    const del = await app.inject({ method: 'DELETE', url: '/api/me', headers: auth(me.token), payload: { password: 'secret123' } });
    expect(del.statusCode).toBe(204);
    const left = await db.query<{ verb: string; research_consented: boolean }>('select verb, research_consented from analytics.learning_events where research_id = $1', [rid]);
    expect(left.rows.length).toBe(1);
    expect(left.rows[0].verb).toBe('passed');
    expect(left.rows[0].research_consented).toBe(true);
    const consent = await db.query('select 1 from analytics.consents where user_id = $1', [me.user.id]);
    expect(consent.rows.length).toBe(0);
    const log = await db.query("select detail from analytics.access_log where action = 'delete' and target = $1", [rid]);
    expect(log.rows.length).toBe(1);
  });
});
