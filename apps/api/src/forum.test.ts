/** Forum and direct messages, against in-memory Postgres. */

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

let ama: Account; // facilitator
let kofi: Account;
let esi: Account;
let threadId = '';
let answerId = '';
const labId = 'digital-logic-design-b1-meet-the-gates';

describe('forum', () => {
  it('seeds the fixed categories and one per course; the Lecturers one is for facilitators', async () => {
    ama = await signUp('ama@example.com', 'Ama');
    kofi = await signUp('kofi@example.com', 'Kofi');
    esi = await signUp('esi@example.com', 'Esi');
    await app.inject({ method: 'POST', url: '/api/me/facilitator', headers: auth(ama.token) });
    const learnerView = json(await app.inject({ method: 'GET', url: '/api/forum/categories', headers: auth(kofi.token) })).categories as Array<{ id: string }>;
    const ids = learnerView.map((c) => c.id);
    expect(ids.slice(0, 3)).toEqual(['general', 'help', 'careers']);
    expect(ids).toContain('digital-logic-design');
    expect(ids).not.toContain('lecturers');
    expect(learnerView.length).toBe(119);
    const facilitatorView = json(await app.inject({ method: 'GET', url: '/api/forum/categories', headers: auth(ama.token) })).categories as Array<{ id: string }>;
    expect(facilitatorView.map((c) => c.id)).toContain('lecturers');
    const denied = await app.inject({ method: 'POST', url: '/api/forum/threads', headers: auth(kofi.token), payload: { categoryId: 'lecturers', title: 'Marking schemes', body: 'How do you mark?' } });
    expect(denied.statusCode).toBe(404);
  });

  it('a learner asks a question attached to a lab, and it shows beside that lab', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/forum/threads',
      headers: auth(kofi.token),
      payload: { categoryId: 'digital-logic-design', title: 'Why does my AND gate stay low?', body: 'Both inputs are on but Y stays 0. @' + ama.username + ' any idea?', labId, courseSlug: 'digital-logic-design', unitIndex: 2, topicIndex: 3, tags: ['gates'] },
    });
    expect(res.statusCode).toBe(201);
    threadId = json(res).thread.id;
    expect(json(res).thread).toMatchObject({ labId, solved: false, replies: 0, tags: ['gates'] });
    const byLab = json(await app.inject({ method: 'GET', url: `/api/forum/threads?labId=${labId}`, headers: auth(esi.token) })).threads;
    expect(byLab.map((t: { id: string }) => t.id)).toEqual([threadId]);
    const byTopic = json(await app.inject({ method: 'GET', url: '/api/forum/threads?course=digital-logic-design&unit=2&topic=3', headers: auth(esi.token) })).threads;
    expect(byTopic).toHaveLength(1);
    const search = json(await app.inject({ method: 'GET', url: '/api/forum/threads?q=stay%20low', headers: auth(esi.token) })).threads;
    expect(search).toHaveLength(1);
    // Ama was mentioned.
    const inbox = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(ama.token) })).notifications;
    expect(inbox[0]).toMatchObject({ kind: 'mention', link: `/forum/threads/${threadId}` });
  });

  it('replies notify the asker; votes are per person; the asker accepts an answer and the thread is solved', async () => {
    const reply = await app.inject({ method: 'POST', url: `/api/forum/threads/${threadId}/posts`, headers: auth(esi.token), payload: { body: 'Check that the wire goes to the output pin, not the input.' } });
    expect(reply.statusCode).toBe(201);
    answerId = json(reply).post.id;
    const inbox = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(kofi.token) })).notifications;
    expect(inbox[0]).toMatchObject({ kind: 'reply', link: `/forum/threads/${threadId}#post-${answerId}` });

    const up = await app.inject({ method: 'PUT', url: `/api/forum/posts/${answerId}/vote`, headers: auth(kofi.token), payload: { value: 1 } });
    expect(json(up)).toEqual({ votes: 1, myVote: 1 });
    const again = await app.inject({ method: 'PUT', url: `/api/forum/posts/${answerId}/vote`, headers: auth(kofi.token), payload: { value: 1 } });
    expect(json(again).votes).toBe(1);
    const other = await app.inject({ method: 'PUT', url: `/api/forum/posts/${answerId}/vote`, headers: auth(ama.token), payload: { value: 1 } });
    expect(json(other).votes).toBe(2);

    const notAsker = await app.inject({ method: 'POST', url: `/api/forum/threads/${threadId}/accept`, headers: auth(esi.token), payload: { postId: answerId } });
    expect(notAsker.statusCode).toBe(403);
    const accept = await app.inject({ method: 'POST', url: `/api/forum/threads/${threadId}/accept`, headers: auth(kofi.token), payload: { postId: answerId } });
    expect(accept.statusCode).toBe(200);
    const view = json(await app.inject({ method: 'GET', url: `/api/forum/threads/${threadId}`, headers: auth(esi.token) }));
    expect(view.thread.solved).toBe(true);
    expect(view.posts[0]).toMatchObject({ accepted: true, votes: 2, myVote: 0, endorsed: false });
    expect(view.can).toEqual({ reply: true, edit: false, accept: false, endorse: false, moderate: false });
    const esiInbox = json(await app.inject({ method: 'GET', url: '/api/me/notifications', headers: auth(esi.token) })).notifications;
    expect(esiInbox[0]).toMatchObject({ kind: 'accepted' });
  });

  it('a facilitator endorses an answer and can also accept; learners cannot endorse', async () => {
    const denied = await app.inject({ method: 'POST', url: `/api/forum/posts/${answerId}/endorse`, headers: auth(kofi.token), payload: { endorsed: true } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: `/api/forum/posts/${answerId}/endorse`, headers: auth(ama.token), payload: { endorsed: true } });
    expect(ok.statusCode).toBe(200);
    const view = json(await app.inject({ method: 'GET', url: `/api/forum/threads/${threadId}`, headers: auth(ama.token) }));
    expect(view.posts[0].endorsed).toBe(true);
    expect(view.can.accept).toBe(true);
  });

  it('authors edit their own replies and threads; a locked thread takes no replies', async () => {
    const notMine = await app.inject({ method: 'PATCH', url: `/api/forum/posts/${answerId}`, headers: auth(kofi.token), payload: { body: 'edited by someone else' } });
    expect(notMine.statusCode).toBe(403);
    const mine = await app.inject({ method: 'PATCH', url: `/api/forum/posts/${answerId}`, headers: auth(esi.token), payload: { body: 'Check the wire goes to the output pin.' } });
    expect(mine.statusCode).toBe(200);
    const lockDenied = await app.inject({ method: 'PATCH', url: `/api/forum/threads/${threadId}`, headers: auth(kofi.token), payload: { locked: true } });
    expect(lockDenied.statusCode).toBe(403);
    await db.query("update profiles set platform_role = 'moderator' where user_id = $1", [ama.id]);
    const lock = await app.inject({ method: 'PATCH', url: `/api/forum/threads/${threadId}`, headers: auth(ama.token), payload: { locked: true } });
    expect(lock.statusCode).toBe(200);
    const reply = await app.inject({ method: 'POST', url: `/api/forum/threads/${threadId}/posts`, headers: auth(esi.token), payload: { body: 'one more' } });
    expect(reply.statusCode).toBe(403);
    await db.query("update profiles set platform_role = 'facilitator' where user_id = $1", [ama.id]);
  });
});

describe('direct messages', () => {
  let conversationId = '';

  it('needs a shared group', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(kofi.token), payload: { userId: esi.id } });
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('no_shared_group');
  });

  it('opens one conversation between two members of a group and delivers messages', async () => {
    const g = json(await app.inject({ method: 'POST', url: '/api/groups', headers: auth(kofi.token), payload: { name: 'Pair study' } })).group;
    await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(esi.token), payload: { code: g.joinCode } });
    const open = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(kofi.token), payload: { userId: esi.id } });
    expect(open.statusCode).toBe(201);
    conversationId = json(open).conversationId;
    const same = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(esi.token), payload: { userId: kofi.id } });
    expect(json(same).conversationId).toBe(conversationId);

    const send = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: auth(kofi.token), payload: { body: 'Shall we do unit 3 tonight?' } });
    expect(send.statusCode).toBe(201);
    const list = json(await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(esi.token) })).conversations;
    expect(list[0]).toMatchObject({ id: conversationId, unread: 1, other: { username: kofi.username } });
    const msgs = json(await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages`, headers: auth(esi.token) }));
    expect(msgs.messages.map((m: { body: string }) => m.body)).toEqual(['Shall we do unit 3 tonight?']);
    const after = json(await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(esi.token) })).conversations;
    expect(after[0].unread).toBe(0);
    // Outsiders see nothing.
    expect((await app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages`, headers: auth(ama.token) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: auth(ama.token), payload: { body: 'hi' } })).statusCode).toBe(404);
  });

  it('blocked users cannot message, and the blocker is told to unblock first', async () => {
    await app.inject({ method: 'PUT', url: `/api/me/blocks/${kofi.id}`, headers: auth(esi.token) });
    const blocked = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: auth(kofi.token), payload: { body: 'Hello?' } });
    expect(blocked.statusCode).toBe(403);
    expect(json(blocked).error).toBe('blocked');
    const blocker = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: auth(esi.token), payload: { body: 'Go away' } });
    expect(blocker.statusCode).toBe(403);
    expect(json(blocker).error).toBe('you_blocked');
    const reopen = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(kofi.token), payload: { userId: esi.id } });
    expect(reopen.statusCode).toBe(403);
    await app.inject({ method: 'DELETE', url: `/api/me/blocks/${kofi.id}`, headers: auth(esi.token) });
    const ok = await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: auth(kofi.token), payload: { body: 'Hello again' } });
    expect(ok.statusCode).toBe(201);
  });

  it('under-18 accounts message only within class groups', async () => {
    await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth(esi.token), payload: { ageBand: 'under_18' } });
    const g = json(await app.inject({ method: 'POST', url: '/api/groups', headers: auth(ama.token), payload: { name: 'Study buddies' } })).group;
    await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(esi.token), payload: { code: g.joinCode } });
    const denied = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(ama.token), payload: { userId: esi.id } });
    expect(denied.statusCode).toBe(403);
    expect(json(denied).error).toBe('minor_protection');
    const cls = json(await app.inject({ method: 'POST', url: '/api/groups', headers: auth(ama.token), payload: { name: 'Form 3 Computing', kind: 'class' } })).group;
    await app.inject({ method: 'POST', url: '/api/groups/join', headers: auth(esi.token), payload: { code: cls.joinCode } });
    const ok = await app.inject({ method: 'POST', url: '/api/conversations', headers: auth(ama.token), payload: { userId: esi.id } });
    expect(ok.statusCode).toBe(201);
  });
});
