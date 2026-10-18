/**
 * One small database interface with two drivers:
 *  - node-postgres (pg) when DATABASE_URL is set (production on the VPS);
 *  - PGlite, an embedded Postgres, otherwise (development and tests), stored in a folder
 *    or in memory. Both speak the same SQL, so there is one set of queries and migrations.
 */

import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Db extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  /** Runs several statements with no parameters (migrations). */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbOptions {
  /** postgres://user:pass@host:5432/db. When absent, PGlite is used. */
  databaseUrl?: string;
  /** Folder for PGlite's files. Omit for an in-memory database (tests). */
  dataDir?: string;
}

export async function openDb(opts: DbOptions): Promise<Db> {
  if (opts.databaseUrl) return openPostgres(opts.databaseUrl);
  return openPglite(opts.dataDir);
}

async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await c.query(text, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
  });
  const base = wrap(pool);
  await pool.query('select 1');
  return {
    kind: 'postgres',
    query: base.query,
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const out = await fn(wrap(client));
        await client.query('commit');
        return out;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function openPglite(dataDir?: string): Promise<Db> {
  if (dataDir) mkdirSync(dataDir, { recursive: true }); // PGlite does not create parent folders
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  const wrap = (c: { query: PGlite['query'] }): Queryable => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await c.query<T>(text, params as never[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  const base = wrap(db);
  return {
    kind: 'pglite',
    query: base.query,
    async exec(sql) {
      await db.exec(sql);
    },
    transaction(fn) {
      return db.transaction((tx) => fn(wrap(tx as unknown as { query: PGlite['query'] })));
    },
    async close() {
      await db.close();
    },
  };
}

/** Timestamps come back as Date from pg and as Date or string from PGlite; normalise to ISO. */
export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return new Date(v).toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return new Date(0).toISOString();
}

/** numeric columns arrive as strings from pg; make them numbers. */
export function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}
