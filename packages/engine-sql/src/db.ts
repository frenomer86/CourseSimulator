/**
 * A thin layer over sql.js (SQLite compiled to WebAssembly). The host decides how the
 * WebAssembly file is found: the web app passes a bundled URL, tests pass a file path.
 */

import type { Database, SqlJsStatic } from 'sql.js';

export type Cell = number | string | null | Uint8Array;

export interface ResultSet {
  columns: string[];
  rows: Cell[][];
}

let loader: (() => Promise<SqlJsStatic>) | null = null;
let cached: Promise<SqlJsStatic> | null = null;

/** Must be called once by the host before any database is opened. */
export function setSqlLoader(fn: () => Promise<SqlJsStatic>): void {
  loader = fn;
  cached = null;
}

export function getSql(): Promise<SqlJsStatic> {
  if (!loader) return Promise.reject(new Error('The SQL engine is not configured. Call setSqlLoader first.'));
  cached ??= loader().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

/** Opens a fresh in-memory database, runs the schema, hands it to `fn`, and closes it. */
export async function withDatabase<T>(schema: string, fn: (db: Database) => T | Promise<T>): Promise<T> {
  const SQL = await getSql();
  const db = new SQL.Database();
  try {
    if (schema.trim()) db.exec(schema);
    return await fn(db);
  } finally {
    db.close();
  }
}

/** Runs one or more statements. Returns a result set per statement that produced rows. */
export function execAll(db: Database, sql: string): ResultSet[] {
  return db.exec(sql).map((r) => ({ columns: r.columns, rows: r.values as Cell[][] }));
}

export function lastResult(sets: ResultSet[]): ResultSet | null {
  return sets.length ? sets[sets.length - 1] : null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  rowCount: number;
}

/** Tables and their columns, for the schema browser. */
export function describe(db: Database): TableInfo[] {
  const names = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const out: TableInfo[] = [];
  for (const [name] of names[0]?.values ?? []) {
    const info = db.exec(`PRAGMA table_info("${String(name).replace(/"/g, '""')}")`);
    const columns = (info[0]?.values ?? []).map((r) => ({ name: String(r[1]), type: String(r[2] ?? ''), notNull: r[3] === 1, primaryKey: Number(r[5]) > 0 }));
    const count = db.exec(`SELECT COUNT(*) FROM "${String(name).replace(/"/g, '""')}"`);
    out.push({ name: String(name), columns, rowCount: Number(count[0]?.values[0]?.[0] ?? 0) });
  }
  return out;
}

/** Turns a SQLite error into a sentence a learner can act on. */
export function describeSqlError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^Error:\s*/i, '');
}
