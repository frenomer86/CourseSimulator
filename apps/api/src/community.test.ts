/** Groups, chat, resources, facilitator tasks, blocks and notifications, against in-memory Postgres. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { buildApp } from './app.js';
import { openDb, type Db } from './db.js';
import { migrate } from './migrate.js';

let db: Db;
let app: FastifyInstance;

beforeAll(async () => {
  db = await openDb({});
  await migrate(db);
  app = await buildApp({ db });
  await app.ready();
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
  expect(res.statusCode).toBe(201);
  const b = json(res);
  return { token: b.token, id: b.user.id, username: b.profile.username };
}

let ama: Account; // facilitator, group owner
let kofi: Account; // learner
let esi: Account; // learner, not in the group
let groupId = '';
let joinCode = '';

describe('facilitator role', () => {
  it('is self-declared and flagged as unverified', async () => {
    ama = await signUp('ama@example.com', 'Ama');
    kofi = await signUp('kofi@example.com', 'Kofi');
    esi = await signUp('esi@example.com', 'Esi');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: auth(ama.token) });
    expect(json(me).profile).toMatchObject({ platformRole: 'learner', facilitatorVerified: false });
    const res = await app.inject({ method: 'POST', url: '/api/me/facilitator', headers: auth(ama.token) });
    expect(res.statusCode).toBe(200);
    expect(json(res).profile).toMatchObject({ platformRole: 'facilitator', facilitatorVerified: false });
    const row = await db.query<{ facilitator_requested_at: unknown }>('select facilitator_requested_at from profiles where user_id = $1', [ama.id]);
    expect(row.rows[0].facilitator_requested_at).toBeTruthy();
  });
});

describe('groups', () => {
  it('anyone signed in creates a group and becomes its owner, with a join code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(ama.token),
      payload: { name: 'Logic study circle', description: 'Thursday evenings', visibility: 'invite', courseSlug: 'digital-logic-design' },
    });
    expect(res.statusCode).toBe(201);
    const g = json(res).group;
    expect(g).toMatchObject({ name: 'Logic study circle', visibility: 'invite', myRole: 'owner', memberCount: 1 });
    expect(g.joinCode).toMatch(/^[A-Z2-9]{8}$/);
    groupId = g.id;
    joinCode = g.joinCode;
    const short = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(ama.token), payload: { name: 'ab' } });
    expect(short.statusCode).toBe(400);
  });

  it('hides an invite-only group from non-members and refuses a direct join', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/groups/${groupId}`, headers: auth(kofi.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/groups/${groupId}/join`, headers: auth(kofi.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/groups/${groupId}/members`, headers: auth(kofi.token) })).statusCode).toBe(404);
  });

  it('lets a learner preview and join by code (case-insensitive), and then see the group', async () => {
    const preview = await app.inject({ method: 'GET', url: `/api/groups/by-code/${joinCode.toLowerCase()}`, headers: auth(kofi.token) });
    expect(preview.statusCode).toBe(200);
    expect(json(preview).group).toMatchObject({ name: 'Logic study circle', joinCode: null, myRole: null });
    const bad = await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(kofi.token), payload: { code: 'ZZZZZZZZ' } });
    expect(bad.statusCode).toBe(404);
    const res = await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(kofi.token), payload: { code: joinCode.toLowerCase() } });
    expect(res.statusCode).toBe(200);
    expect(json(res).group).toMatchObject({ myRole: 'member', memberCount: 2 });
    const mine = await app.inject({ method: 'GET', url: '/api/groups?scope=mine', headers: auth(kofi.token) });
    expect(json(mine).groups.map((g: { id: string }) => g.id)).toEqual([groupId]);
  });

  it('lists members with roles; only the owner or an admin changes roles or removes people', async () => {
    const members = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/members`, headers: auth(kofi.token) });
    expect(members.statusCode).toBe(200);
    const list = json(members).members;
    expect(list.map((m: { username: string; role: string }) => [m.username, m.role])).toEqual([
      [ama.username, 'owner'],
      [kofi.username, 'member'],
    ]);
    expect(list[0]).not.toHaveProperty('email');

    const denied = await app.inject({ method: 'PATCH', url: `/api/groups/${groupId}/members/${ama.id}`, headers: auth(kofi.token), payload: { role: 'member' } });
    expect(denied.statusCode).toBe(403);
    const promote = await app.inject({ method: 'PATCH', url: `/api/groups/${groupId}/members/${kofi.id}`, headers: auth(ama.token), payload: { role: 'admin' } });
    expect(promote.statusCode).toBe(200);
    const owner = await app.inject({ method: 'PATCH', url: `/api/groups/${groupId}/members/${ama.id}`, headers: auth(kofi.token), payload: { role: 'member' } });
    expect(owner.statusCode).toBe(403);
    expect(json(owner).error).toBe('is_owner');
  });

  it('only owner or admin updates the group; only the owner deletes it', async () => {
    const stranger = await app.inject({ method: 'PATCH', url: `/api/groups/${groupId}`, headers: auth(esi.token), payload: { name: 'Hijacked' } });
    expect(stranger.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PATCH', url: `/api/groups/${groupId}`, headers: auth(kofi.token), payload: { description: 'Thursdays at 6' } });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).group.description).toBe('Thursdays at 6');
    const del = await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}`, headers: auth(kofi.token) });
    expect(del.statusCode).toBe(403);
  });

  it('public groups are discoverable and joinable directly; leaving works', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(esi.token), payload: { name: 'Open networking club', visibility: 'public' } });
    const pub = json(res).group;
    const found = await app.inject({ method: 'GET', url: '/api/groups?scope=public&q=network', headers: auth(kofi.token) });
    expect(json(found).groups.map((g: { id: string }) => g.id)).toContain(pub.id);
    const join = await app.inject({ method: 'POST', url: `/api/groups/${pub.id}/join`, headers: auth(kofi.token) });
    expect(join.statusCode).toBe(200);
    expect(json(join).group.memberCount).toBe(2);
    const leave = await app.inject({ method: 'POST', url: `/api/groups/${pub.id}/leave`, headers: auth(kofi.token) });
    expect(leave.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/api/groups/${pub.id}`, headers: auth(kofi.token) });
    expect(json(after).group).toMatchObject({ memberCount: 1, myRole: null, joinCode: null });
    // The owner leaving an otherwise empty group removes it.
    await app.inject({ method: 'POST', url: `/api/groups/${pub.id}/leave`, headers: auth(esi.token) });
    expect((await app.inject({ method: 'GET', url: `/api/groups/${pub.id}`, headers: auth(esi.token) })).statusCode).toBe(404);
  });
});

describe('group chat', () => {
  it('members post and read messages; non-members cannot; bodies are capped at 4000 characters', async () => {
    const denied = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/messages`, headers: auth(esi.token), payload: { body: 'hi' } });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(esi.token) })).statusCode).toBe(403);
    const long = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token), payload: { body: 'x'.repeat(4001) } });
    expect(long.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token), payload: { body: 'Welcome, everyone.' } });
    expect(ok.statusCode).toBe(201);
    expect(json(ok).message).toMatchObject({ body: 'Welcome, everyone.', author: { username: ama.username } });
    const list = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(kofi.token) });
    expect(json(list).messages.map((m: { body: string }) => m.body)).toEqual(['Welcome, everyone.']);
  });

  it('a blocked member’s messages are hidden from the blocker', async () => {
    await app.inject({ method: 'POST', url: `/api/groups/${groupId}/messages`, headers: auth(kofi.token), payload: { body: 'Hello from Kofi' } });
    const block = await app.inject({ method: 'PUT', url: `/api/me/blocks/${kofi.id}`, headers: auth(ama.token) });
    expect(block.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token) });
    expect(json(list).messages.map((m: { body: string }) => m.body)).toEqual(['Welcome, everyone.']);
    const unblock = await app.inject({ method: 'DELETE', url: `/api/me/blocks/${kofi.id}`, headers: auth(ama.token) });
    expect(unblock.statusCode).toBe(204);
    const again = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token) });
    expect(json(again).messages).toHaveLength(2);
  });

  it('authors remove their own messages; others cannot', async () => {
    const list = json(await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token) })).messages;
    const kofis = list.find((m: { author: { username: string } }) => m.author.username === kofi.username);
    const denied = await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}/messages/${kofis.id}`, headers: auth(esi.token) });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'DELETE', url: `/api/groups/${groupId}/messages/${kofis.id}`, headers: auth(kofi.token) });
    expect(ok.statusCode).toBe(204);
    const after = json(await app.inject({ method: 'GET', url: `/api/groups/${groupId}/messages`, headers: auth(ama.token) })).messages;
    expect(after.find((m: { id: number }) => m.id === kofis.id)).toMatchObject({ body: '', deletedAt: expect.any(String) });
  });

  it('over the WebSocket: presence shows display name and avatar only, and messages reach the room', async () => {
    const frames = (ws: WebSocket) => {
      const queue: unknown[] = [];
      const waiters: Array<(v: unknown) => void> = [];
      ws.on('message', (raw) => {
        const v = JSON.parse(String(raw));
        const w = waiters.shift();
        if (w) w(v);
        else queue.push(v);
      });
      return () => (queue.length ? Promise.resolve(queue.shift()) : new Promise<unknown>((r) => waiters.push(r)));
    };
    const wsA = await app.injectWS('/api/ws');
    const nextA = frames(wsA);
    wsA.send(JSON.stringify({ type: 'auth', token: ama.token }));
    expect(await nextA()).toMatchObject({ type: 'ready', userId: ama.id });
    wsA.send(JSON.stringify({ type: 'join', groupId }));
    expect(await nextA()).toEqual({ type: 'presence', groupId, online: [{ displayName: 'Ama', avatarUrl: null }] });

    const wsE = await app.injectWS('/api/ws');
    const nextE = frames(wsE);
    wsE.send(JSON.stringify({ type: 'auth', token: esi.token }));
    await nextE();
    wsE.send(JSON.stringify({ type: 'join', groupId }));
    expect(await nextE()).toMatchObject({ type: 'error', code: 'not_a_member' });

    const wsK = await app.injectWS('/api/ws');
    const nextK = frames(wsK);
    wsK.send(JSON.stringify({ type: 'auth', token: kofi.token }));
    await nextK();
    wsK.send(JSON.stringify({ type: 'join', groupId }));
    const presence = (await nextK()) as { online: Array<{ displayName: string }> };
    expect(presence.online.map((p) => p.displayName)).toEqual(['Ama', 'Kofi']);
    expect(JSON.stringify(presence)).not.toContain(kofi.id);
    expect(await nextA()).toMatchObject({ type: 'presence' });

    wsK.send(JSON.stringify({ type: 'message', groupId, body: 'Live from the bench' }));
    const got = (await nextA()) as { type: string; message: { body: string; author: { displayName: string } } };
    expect(got.type).toBe('message');
    expect(got.message).toMatchObject({ body: 'Live from the bench', author: { displayName: 'Kofi' } });
    expect(await nextK()).toMatchObject({ type: 'message' });
    const stored = await db.query<{ body: string }>('select body from group_messages where group_id = $1 order by id desc limit 1', [groupId]);
    expect(stored.rows[0].body).toBe('Live from the bench');

    const unauth = await app.injectWS('/api/ws');
    const nextU = frames(unauth);
    unauth.send(JSON.stringify({ type: 'join', groupId }));
    expect(await nextU()).toMatchObject({ type: 'error', code: 'unauthorized' });

    // Leaving the room (or closing the tab) takes the person off the rail for everyone else.
    wsK.send(JSON.stringify({ type: 'leave', groupId }));
    expect(await nextA()).toEqual({ type: 'presence', groupId, online: [{ displayName: 'Ama', avatarUrl: null }] });
    wsK.close();
    wsA.close();
    wsE.close();
    unauth.close();
  });
});

describe('resources', () => {
  it('group resources are for members; the course library is open; solution shares need a pass', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/resources', headers: auth(esi.token), payload: { kind: 'link', groupId, title: 'Notes', url: 'https://example.com/n' } });
    expect(denied.statusCode).toBe(403);
    const link = await app.inject({ method: 'POST', url: '/api/resources', headers: auth(kofi.token), payload: { kind: 'link', groupId, title: 'Karnaugh maps explained', url: 'https://example.com/kmap' } });
    expect(link.statusCode).toBe(201);
    const note = await app.inject({
      method: 'POST',
      url: '/api/resources',
      headers: auth(ama.token),
      payload: { kind: 'note', courseSlug: 'digital-logic-design', title: 'Remember De Morgan', body: 'NOT (A AND B) = NOT A OR NOT B' },
    });
    expect(note.statusCode).toBe(201);
    const inGroup = await app.inject({ method: 'GET', url: `/api/resources?groupId=${groupId}`, headers: auth(ama.token) });
    expect(json(inGroup).resources.map((r: { title: string }) => r.title)).toEqual(['Karnaugh maps explained']);
    expect((await app.inject({ method: 'GET', url: `/api/resources?groupId=${groupId}`, headers: auth(esi.token) })).statusCode).toBe(403);
    const library = await app.inject({ method: 'GET', url: '/api/resources?courseSlug=digital-logic-design', headers: auth(esi.token) });
    expect(json(library).resources.map((r: { title: string }) => r.title)).toEqual(['Remember De Morgan']);

    const labId = 'digital-logic-design-b1-meet-the-gates';
    const notPassed = await app.inject({
      method: 'POST',
      url: '/api/resources',
      headers: auth(kofi.token),
      payload: { kind: 'solution', courseSlug: 'digital-logic-design', labId, title: 'My AND gate', payload: { nodes: [], wires: [] } },
    });
    expect(notPassed.statusCode).toBe(403);
    // Kofi passes the lab through the normal sync path, then shares.
    const sync = await app.inject({
      method: 'POST',
      url: '/api/me/progress/sync',
      headers: auth(kofi.token),
      payload: { items: [{ kind: 'lab_result', id: '44444444-4444-4444-8444-444444444444', at: new Date().toISOString(), labId, course: 'digital-logic-design', level: 'beginner', passed: true, score: 1, hintsUsed: 0 }] },
    });
    expect(sync.statusCode).toBe(200);
    const share = await app.inject({
      method: 'POST',
      url: '/api/resources',
      headers: auth(kofi.token),
      payload: { kind: 'solution', courseSlug: 'digital-logic-design', labId, title: 'My AND gate', payload: { nodes: [], wires: [] } },
    });
    expect(share.statusCode).toBe(201);
    // Esi has not passed it, so she sees nothing; Kofi sees his own.
    expect(json(await app.inject({ method: 'GET', url: `/api/resources?labId=${labId}`, headers: auth(esi.token) })).resources).toEqual([]);
    expect(json(await app.inject({ method: 'GET', url: `/api/resources?labId=${labId}`, headers: auth(kofi.token) })).resources).toHaveLength(1);
    // The library never lists solutions.
    expect(json(await app.inject({ method: 'GET', url: '/api/resources?courseSlug=digital-logic-design', headers: auth(esi.token) })).resources).toHaveLength(1);
    // Only the owner, a group admin or a moderator removes a resource.
    const rid = json(link).resource.id;
    expect((await app.inject({ method: 'DELETE', url: `/api/resources/${rid}`, headers: auth(esi.token) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `/api/resources/${rid}`, headers: auth(ama.token) })).statusCode).toBe(204);
  });
});

describe('facilitator tasks', () => {
  let taskId = '';
  const labId = 'digital-logic-design-b1-meet-the-gates';

  it('a facilitator who is owner or admin sets a task; members are notified; learners cannot set tasks', async () => {
    const learner = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/tasks`,
      headers: auth(kofi.token),
      payload: { title: 'Week 1', items: [{ kind: 'lab', id: labId }] },
    });
    expect(learner.statusCode).toBe(403);
    expect(json(learner).error).toBe('not_facilitator');
    const res = await app.inject({
      method: 'POST',
      url: `/api/groups/${groupId}/tasks`,
      headers: auth(ama.token),
      payload: { title: 'Week 1: gates and a check', items: [{ kind: 'lab', id: labId }, { kind: 'check', id: 'digital-logic-design:2:3' }], dueAt: '2030-01-01T00:00:00.000Z' },
    });
    expect(res.statusCode).toBe(201);
    taskId = json(res).task.id;
    expect(json(res).task.mine).toEqual({ done: 0, total: 2, completedIds: [] });
    const inbox = await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(kofi.token) });
    expect(json(inbox).notifications[0]).toMatchObject({ kind: 'deadline', link: `/groups/${groupId}?tab=tasks` });
  });

  it('members see their own completion; the owner sees everyone’s', async () => {
    const mine = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/tasks`, headers: auth(kofi.token) });
    expect(json(mine).tasks[0].mine).toEqual({ done: 1, total: 2, completedIds: [labId] });
    const detail = await app.inject({ method: 'GET', url: `/api/groups/${groupId}/tasks/${taskId}`, headers: auth(ama.token) });
    const members = json(detail).members as Array<{ username: string; done: number }>;
    expect(members.find((m) => m.username === kofi.username)?.done).toBe(1);
    expect(members.find((m) => m.username === ama.username)?.done).toBe(0);
    expect((await app.inject({ method: 'GET', url: `/api/groups/${groupId}/tasks`, headers: auth(esi.token) })).statusCode).toBe(403);
  });
});

describe('notifications and reports', () => {
  it('marks notifications read and accepts a report', async () => {
    const before = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(kofi.token) }));
    expect(before.unread).toBeGreaterThan(0);
    await app.inject({ method: 'POST', url: '/api/me/notifications/read', headers: auth(kofi.token), payload: {} });
    const after = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(kofi.token) }));
    expect(after.unread).toBe(0);
    const report = await app.inject({ method: 'POST', url: '/api/reports', headers: auth(kofi.token), payload: { targetKind: 'group_message', targetId: '1', reason: 'Spam' } });
    expect(report.statusCode).toBe(201);
  });

  it('serves a public profile without email, with awards and contributions', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/people/${kofi.username}`, headers: auth(ama.token) });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.person).toMatchObject({ username: kofi.username, displayName: 'Kofi' });
    expect(JSON.stringify(body)).not.toContain('kofi@example.com');
    expect(body.canMessage).toBe(true);
    expect(body.awards).toEqual([]);
  });
});
