/**
 * Check handlers for SQL labs, under the "sql.*" namespace. Every check runs the learner's
 * SQL on a fresh database built from the lab's schema, so checks never affect each other.
 *
 *   sql.runs     {}                                              the SQL executes without error
 *   sql.query    { expectedQuery | expected: {columns, rows}, ordered?, columns?, tolerance?, minRows? }
 *                the last result set of the learner's SQL matches the reference query's result
 *   sql.script   { solution?, probes: [{ query, expectedQuery? | expected, ordered? }] }
 *                after the learner's script, each probe query gives the expected rows
 *                (expectedQuery runs on a reference database built from schema + solution)
 *   sql.rejects  { statement, message? }  after the learner's script, this statement must fail
 *   sql.source   { pattern, flags?, mustMatch?, message? }      the SQL text itself
 */

import { CheckRegistry, type CheckResult, type CheckSpec } from '@cslab/lab-runtime';
import { compareResults, type CompareOptions } from './compare.js';
import { describeSqlError, execAll, lastResult, withDatabase, type Cell, type ResultSet } from './db.js';

/** The learner's SQL together with the schema the lab provides. */
export interface SqlState {
  schema: string;
  sql: string;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

function literalResult(expected: unknown): ResultSet | null {
  if (Array.isArray(expected)) return { columns: [], rows: expected as Cell[][] };
  if (expected && typeof expected === 'object' && Array.isArray((expected as { rows?: unknown }).rows)) {
    const e = expected as { columns?: string[]; rows: Cell[][] };
    return { columns: e.columns ?? [], rows: e.rows };
  }
  return null;
}

function options(spec: CheckSpec, extra?: { ordered?: boolean }): CompareOptions {
  return {
    ordered: extra?.ordered ?? spec.ordered === true,
    columns: spec.columns === true,
    tolerance: typeof spec.tolerance === 'number' ? spec.tolerance : undefined,
  };
}

async function expectedFromQuery(schema: string, setup: string, query: string): Promise<ResultSet> {
  return withDatabase(schema, (db) => {
    if (setup.trim()) db.exec(setup);
    const r = lastResult(execAll(db, query));
    return r ?? { columns: [], rows: [] };
  });
}

export function createSqlChecks(): CheckRegistry<SqlState> {
  return new CheckRegistry<SqlState>()
    .register('sql.runs', async (state, spec) => {
      try {
        await withDatabase(state.schema, (db) => execAll(db, state.sql));
        return pass(spec, 'Your SQL runs without errors.');
      } catch (err) {
        return fail(spec, `Your SQL has an error: ${describeSqlError(err)}`);
      }
    })

    .register('sql.query', async (state, spec) => {
      let actual: ResultSet | null;
      try {
        actual = await withDatabase(state.schema, (db) => lastResult(execAll(db, state.sql)));
      } catch (err) {
        return fail(spec, `Your SQL has an error: ${describeSqlError(err)}`);
      }
      let expected: ResultSet | null = literalResult(spec.expected);
      if (!expected && typeof spec.expectedQuery === 'string') expected = await expectedFromQuery(state.schema, '', spec.expectedQuery);
      if (!expected) return fail(spec, 'This check has no expected result. This is a content error, not yours.');
      if (typeof spec.minRows === 'number' && (actual?.rows.length ?? 0) < spec.minRows) return fail(spec, `Expected at least ${spec.minRows} rows but got ${actual?.rows.length ?? 0}.`);
      // A literal expectation without column names cannot check columns.
      const opts = options(spec);
      if (expected.columns.length === 0) {
        opts.columns = false;
        expected = { columns: actual?.columns ?? [], rows: expected.rows };
      }
      const problem = compareResults(actual, expected, opts);
      return problem ? fail(spec, `Not yet: ${problem}.`, actual) : pass(spec, `The result is right: ${expected.rows.length} row${expected.rows.length === 1 ? '' : 's'}.`);
    })

    .register('sql.script', async (state, spec) => {
      const probes = (spec.probes as Array<{ query: string; expected?: unknown; expectedQuery?: string; ordered?: boolean; name?: string }>) ?? [];
      const solution = typeof spec.solution === 'string' ? spec.solution : '';
      try {
        return await withDatabase(state.schema, async (db) => {
          try {
            execAll(db, state.sql);
          } catch (err) {
            return fail(spec, `Your SQL has an error: ${describeSqlError(err)}`);
          }
          for (let i = 0; i < probes.length; i++) {
            const p = probes[i];
            const label = p.name ?? `probe ${i + 1}`;
            let actual: ResultSet | null;
            try {
              actual = lastResult(execAll(db, p.query));
            } catch (err) {
              return fail(spec, `After your script, ${label} failed: ${describeSqlError(err)}`);
            }
            let expected = literalResult(p.expected);
            if (!expected && p.expectedQuery) expected = await expectedFromQuery(state.schema, solution, p.expectedQuery);
            if (!expected) return fail(spec, `${label} has no expected result. This is a content error, not yours.`);
            const opts = options(spec, { ordered: p.ordered });
            if (expected.columns.length === 0) {
              opts.columns = false;
              expected = { columns: actual?.columns ?? [], rows: expected.rows };
            }
            const problem = compareResults(actual, expected, opts);
            if (problem) return fail(spec, `After your script, ${label} is not right: ${problem}.`, actual);
          }
          return pass(spec, String(spec.success ?? `Your script leaves the database in the right state (${probes.length} probe${probes.length === 1 ? '' : 's'} passed).`));
        });
      } catch (err) {
        return fail(spec, `The schema could not be built: ${describeSqlError(err)}`);
      }
    })

    .register('sql.rejects', async (state, spec) => {
      const statement = String(spec.statement ?? '');
      try {
        return await withDatabase(state.schema, (db) => {
          try {
            execAll(db, state.sql);
          } catch (err) {
            return fail(spec, `Your SQL has an error: ${describeSqlError(err)}`);
          }
          try {
            execAll(db, statement);
          } catch (err) {
            return pass(spec, String(spec.success ?? `The database refused it, as it should: ${describeSqlError(err)}`));
          }
          return fail(spec, String(spec.message ?? 'The database accepted a row it should have refused. Add the missing constraint.'));
        });
      } catch (err) {
        return fail(spec, `The schema could not be built: ${describeSqlError(err)}`);
      }
    })

    .register('sql.source', async (state, spec) => {
      const re = new RegExp(String(spec.pattern), (spec.flags as string | undefined) ?? 'i');
      const found = re.test(state.sql);
      const mustMatch = spec.mustMatch !== false;
      if (found === mustMatch) return pass(spec, String(spec.success ?? 'Your SQL uses what this lab asks for.'));
      return fail(spec, String(spec.message ?? (mustMatch ? 'Your SQL is missing something this lab asks you to use.' : 'Your SQL uses something this lab asks you to avoid.')));
    });
}
