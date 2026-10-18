/** Applies every migrations/*.sql not yet recorded in schema_migrations, each in a transaction. */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const applied = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const done: string[] = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(new URL(name, `file://${dir.replace(/\\/g, '/')}`), 'utf8');
    await db.exec(`begin;\n${sql}\ninsert into schema_migrations (name) values ('${name.replace(/'/g, "''")}');\ncommit;`);
    done.push(name);
  }
  return done;
}
