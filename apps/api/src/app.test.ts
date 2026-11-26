/** End-to-end API tests against an in-memory Postgres (PGlite); no services needed. */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, DEFAULT_TRUST_PROXY, parseTrustProxy } from './app.js';
import { makeRateLimiter } from './auth.js';
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

describe('accounts', () => {
  let token = '';

  it('signs up, derives a username and starts a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email: 'Ama.Mensah@Example.com', password: 'secret123', displayName: 'Ama' } });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.user.email).toBe('ama.mensah@example.com');
    expect(body.profile.username).toBe('ama_mensah');
    expect(body.profile.displayName).toBe('Ama');
    expect(body.profile.level).toBe(1);
    expect(typeof body.token).toBe('string');
    token = body.token;
  });

  it('rejects a second account with the same email and short passwords', async () => {
    const dup = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email: 'ama.mensah@example.com', password: 'secret123' } });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error).toBe('email_taken');
    const short = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email: 'x@example.com', password: '123' } });
    expect(short.statusCode).toBe(400);
  });

  it('gives a fresh username suffix when the derived one is taken', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email: 'ama.mensah@other.org', password: 'secret123' } });
    expect(res.statusCode).toBe(201);
    expect(json(res).profile.username).toBe('ama_mensah1');
  });

  it('signs in with the right password only', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'ama.mensah@example.com', password: 'wrong' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'AMA.MENSAH@example.com', password: 'secret123' } });
    expect(good.statusCode).toBe(200);
    expect(json(good).profile.username).toBe('ama_mensah');
  });

  it('serves and updates the profile, refusing a taken username', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(json(me).user.email).toBe('ama.mensah@example.com');

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/me/profile',
      headers: auth(token),
      payload: { displayName: 'Ama M.', username: 'ama', ageBand: '18_plus', showOnBoards: false, avatarUrl: 'https://example.com/a.png' },
    });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).profile).toMatchObject({ displayName: 'Ama M.', username: 'ama', ageBand: '18_plus', showOnBoards: false, avatarUrl: 'https://example.com/a.png' });

    const taken = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(token), payload: { username: 'ama_mensah1' } });
    expect(taken.statusCode).toBe(409);
    const badName = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(token), payload: { username: 'Not Valid!' } });
    expect(badName.statusCode).toBe(400);
    const badAvatarJs = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(token), payload: { avatarUrl: 'javascript:alert(1)' } });
    expect(badAvatarJs.statusCode).toBe(400);
    const badAvatarData = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(token), payload: { avatarUrl: 'data:text/html,<script>alert(1)</script>' } });
    expect(badAvatarData.statusCode).toBe(400);
  });

  it('requires a valid token', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth('nonsense') })).statusCode).toBe(401);
  });

  it('signs out and the token stops working', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'ama.mensah@example.com', password: 'secret123' } });
    const t = json(res).token;
    expect((await app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: auth(t) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth(t) })).statusCode).toBe(401);
    // The first session is untouched.
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).statusCode).toBe(200);
  });
});

describe('progress sync', () => {
  let token = '';
  const labAttempt = '11111111-1111-4111-8111-111111111111';
  const labPass = '22222222-2222-4222-8222-222222222222';
  const checkPass = '33333333-3333-4333-8333-333333333333';

  beforeAll(async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/sign-up', payload: { email: 'kofi@example.com', password: 'secret123' } });
    token = json(res).token;
  });

  it('starts empty', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me/progress', headers: auth(token) });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ labs: {}, topics: {}, checks: {} });
  });

  it('applies a batch in order and aggregates it', async () => {
    const items = [
      { kind: 'lab_result', id: labAttempt, at: '2026-10-01T10:00:00.000Z', labId: 'dld-b1', course: 'dld', level: 'beginner', passed: false, score: 0.5, hintsUsed: 1, checks: [{ label: 'x', passed: false }] },
      { kind: 'lab_result', id: labPass, at: '2026-10-01T10:05:00.000Z', labId: 'dld-b1', course: 'dld', level: 'beginner', passed: true, score: 1, hintsUsed: 2 },
      { kind: 'topic_progress', id: 'dld:2:3', at: '2026-10-01T10:05:00.000Z', course: 'dld', unit: 2, topic: 3, mastery: 'attempted' },
      { kind: 'check_attempt', id: checkPass, at: '2026-10-02T10:00:00.000Z', course: 'dld', unit: 2, topic: 3, score: 83.33, passed: true },
      { kind: 'topic_progress', id: 'dld:2:3', at: '2026-10-02T10:00:00.000Z', course: 'dld', unit: 2, topic: 3, mastery: 'proficient', bestCheckScore: 83.33 },
    ];
    const res = await app.inject({ method: 'POST', url: '/api/me/progress/sync', headers: auth(token), payload: { items } });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.accepted).toEqual([labAttempt, labPass, 'dld:2:3', checkPass, 'dld:2:3']);
    expect(body.records.labs['dld-b1']).toEqual({
      passed: true,
      bestScore: 1,
      attempts: 2,
      hintsUsed: 2,
      lastAttemptAt: '2026-10-01T10:05:00.000Z',
      completedAt: '2026-10-01T10:05:00.000Z',
    });
    expect(body.records.checks['dld:2:3']).toEqual({ attempts: 1, bestScore: 83.33, passed: true, lastAttemptAt: '2026-10-02T10:00:00.000Z' });
    expect(body.records.topics['dld:2:3']).toMatchObject({ mastery: 'proficient', bestCheckScore: 83.33 });
    // XP: 10 for the first beginner pass, 15 for the first check pass.
    expect(body.profile.xp).toBe(25);
  });

  it('is idempotent: a replayed batch adds nothing and never lowers mastery', async () => {
    const items = [
      { kind: 'lab_result', id: labPass, at: '2026-10-01T10:05:00.000Z', labId: 'dld-b1', course: 'dld', level: 'beginner', passed: true, score: 1, hintsUsed: 2 },
      { kind: 'check_attempt', id: checkPass, at: '2026-10-02T10:00:00.000Z', course: 'dld', unit: 2, topic: 3, score: 83.33, passed: true },
      { kind: 'topic_progress', id: 'dld:2:3', at: '2026-09-01T10:00:00.000Z', course: 'dld', unit: 2, topic: 3, mastery: 'attempted', bestCheckScore: 50 },
    ];
    const res = await app.inject({ method: 'POST', url: '/api/me/progress/sync', headers: auth(token), payload: { items } });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.records.labs['dld-b1'].attempts).toBe(2);
    expect(body.records.checks['dld:2:3'].attempts).toBe(1);
    expect(body.records.topics['dld:2:3']).toMatchObject({ mastery: 'proficient', bestCheckScore: 83.33 });
    expect(body.profile.xp).toBe(25);
  });

  it('rejects malformed items without applying any of the batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/progress/sync',
      headers: auth(token),
      payload: { items: [{ kind: 'lab_result', id: 'not-a-uuid', at: 'yesterday', labId: 'x', course: 'c', level: 'beginner', passed: true, score: 2, hintsUsed: 0 }] },
    });
    expect(res.statusCode).toBe(400);
    const after = await app.inject({ method: 'GET', url: '/api/me/progress', headers: auth(token) });
    expect(Object.keys(json(after).labs)).toEqual(['dld-b1']);
  });

  it('keeps progress for the account, not the device: a new session sees the same records', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in', payload: { email: 'kofi@example.com', password: 'secret123' } });
    const res = await app.inject({ method: 'GET', url: '/api/me/progress', headers: auth(json(login).token) });
    expect(json(res).labs['dld-b1'].passed).toBe(true);
  });

  it('deletes the account with the password and everything goes with it', async () => {
    const no = await app.inject({ method: 'DELETE', url: '/api/me', headers: auth(token), payload: { password: 'wrong' } });
    expect(no.statusCode).toBe(401);
    const yes = await app.inject({ method: 'DELETE', url: '/api/me', headers: auth(token), payload: { password: 'secret123' } });
    expect(yes.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: auth(token) })).statusCode).toBe(401);
    const rows = await db.query('select count(*)::int as n from lab_results');
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});

describe('rate limiting and proxy trust', () => {
  it('evicts expired entries and keeps blocked keys instead of clearing the whole map', () => {
    vi.useFakeTimers();
    try {
      const limit = makeRateLimiter(2, 10_000);
      expect(limit('victim')).toBe(true);
      expect(limit('victim')).toBe(true);
      expect(limit('victim')).toBe(false);
      // Flooding distinct keys must not clear the rate-limited key.
      for (let i = 0; i < 10_005; i++) limit(`flood-${i}`);
      expect(limit('victim')).toBe(false);

      // Once the window expires, keys are evicted and allowed again.
      vi.advanceTimersByTime(10_001);
      expect(limit('victim')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores spoofed X-Forwarded-For from direct clients and behind a private proxy hop', async () => {
    const isolated = await buildApp({ db });
    try {
      // Direct connection from a public IP trying to spoof X-Forwarded-For on every attempt.
      for (let i = 0; i < 20; i++) {
        const res = await isolated.inject({
          method: 'POST',
          url: '/api/auth/sign-in',
          remoteAddress: '198.51.100.10',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
          payload: { email: 'nobody@example.com', password: 'wrong' },
        });
        expect(res.statusCode).toBe(401);
      }
      const blockedDirect = await isolated.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        remoteAddress: '198.51.100.10',
        headers: { 'x-forwarded-for': '203.0.113.99' },
        payload: { email: 'nobody@example.com', password: 'wrong' },
      });
      expect(blockedDirect.statusCode).toBe(429);

      // Behind Caddy on a Docker bridge (private IP): spoofed leftmost IP is ignored, real client IP is rate-limited.
      for (let i = 0; i < 20; i++) {
        const res = await isolated.inject({
          method: 'POST',
          url: '/api/auth/sign-in',
          remoteAddress: '172.18.0.2',
          headers: { 'x-forwarded-for': `203.0.113.${i + 1}, 198.51.100.20` },
          payload: { email: 'nobody@example.com', password: 'wrong' },
        });
        expect(res.statusCode).toBe(401);
      }
      const blockedProxied = await isolated.inject({
        method: 'POST',
        url: '/api/auth/sign-in',
        remoteAddress: '172.18.0.2',
        headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.20' },
        payload: { email: 'nobody@example.com', password: 'wrong' },
      });
      expect(blockedProxied.statusCode).toBe(429);
    } finally {
      await isolated.close();
    }
  });

  it('parses TRUST_PROXY settings safely', () => {
    expect(parseTrustProxy(undefined)).toEqual(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('')).toEqual(DEFAULT_TRUST_PROXY);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('loopback, 172.16.0.0/12')).toEqual(['loopback', '172.16.0.0/12']);
  });
});
