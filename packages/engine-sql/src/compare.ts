/** Comparing a learner's result set with the expected one, with messages that say what differs. */

import type { Cell, ResultSet } from './db.js';

export interface CompareOptions {
  /** Row order matters (the lab asks for ORDER BY). Default false: rows are compared as a multiset. */
  ordered?: boolean;
  /** Column names must match (case-insensitive). Default false: only the values matter. */
  columns?: boolean;
  /** Tolerance for numeric cells. Default 0.005 (two decimal places). */
  tolerance?: number;
}

function norm(c: Cell): string | number | null {
  if (c === null || c === undefined) return null;
  if (c instanceof Uint8Array) return `blob:${c.length}`;
  if (typeof c === 'number') return c;
  const s = String(c);
  return s;
}

function cellEqual(a: Cell, b: Cell, tolerance: number): boolean {
  const x = norm(a);
  const y = norm(b);
  if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= tolerance + 1e-9;
  if (typeof x === 'number' && typeof y === 'string' && y.trim() !== '' && !Number.isNaN(Number(y))) return Math.abs(x - Number(y)) <= tolerance + 1e-9;
  if (typeof y === 'number' && typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) return Math.abs(y - Number(x)) <= tolerance + 1e-9;
  return x === y;
}

function rowEqual(a: Cell[], b: Cell[], tolerance: number): boolean {
  return a.length === b.length && a.every((c, i) => cellEqual(c, b[i], tolerance));
}

export function showRow(row: Cell[]): string {
  return `(${row.map((c) => (c === null ? 'NULL' : c instanceof Uint8Array ? '<blob>' : typeof c === 'number' ? String(Number.isInteger(c) ? c : Math.round(c * 1000) / 1000) : JSON.stringify(c))).join(', ')})`;
}

/** Null on success, otherwise a sentence describing the first difference found. */
export function compareResults(actual: ResultSet | null, expected: ResultSet, opts: CompareOptions = {}): string | null {
  const tolerance = opts.tolerance ?? 0.005;
  if (!actual) return 'your SQL returned no rows at all (did the last statement return a result?)';
  if (opts.columns) {
    const got = actual.columns.map((c) => c.toLowerCase());
    const want = expected.columns.map((c) => c.toLowerCase());
    if (got.length !== want.length || got.some((c, i) => c !== want[i])) return `the columns should be ${expected.columns.join(', ')} but were ${actual.columns.join(', ')}`;
  } else if (actual.columns.length !== expected.columns.length) {
    return `the result should have ${expected.columns.length} column${expected.columns.length === 1 ? '' : 's'} (${expected.columns.join(', ')}) but has ${actual.columns.length}`;
  }
  if (actual.rows.length !== expected.rows.length) return `expected ${expected.rows.length} row${expected.rows.length === 1 ? '' : 's'} but got ${actual.rows.length}`;
  if (opts.ordered) {
    for (let i = 0; i < expected.rows.length; i++) {
      if (!rowEqual(actual.rows[i], expected.rows[i], tolerance)) return `row ${i + 1} should be ${showRow(expected.rows[i])} but was ${showRow(actual.rows[i])} (check the order too)`;
    }
    return null;
  }
  const remaining = actual.rows.slice();
  for (const want of expected.rows) {
    const i = remaining.findIndex((r) => rowEqual(r, want, tolerance));
    if (i < 0) return `the row ${showRow(want)} is missing from your result`;
    remaining.splice(i, 1);
  }
  if (remaining.length) return `the row ${showRow(remaining[0])} should not be in the result`;
  return null;
}
