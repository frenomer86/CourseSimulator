import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDb, type Db } from './db.js';
import { migrate } from './migrate.js';
let db: Db;
beforeAll(async () => { db = await openDb({}); });
afterAll(async () => { await db.close(); });
it('applies every migration on an empty database', async () => {
  const applied = await migrate(db);
  expect(applied).toContain('0003_community.sql');
  const cats = await db.query<{ n: unknown }>('select count(*) as n from forum_categories');
  expect(Number(cats.rows[0].n)).toBe(120);
  const v = await db.query('select * from competition_team_standings');
  expect(v.rows).toEqual([]);
});
