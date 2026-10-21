import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import type { LabSpec } from '@cslab/lab-runtime';
import { compareResults, createSqlChecks, describe as describeDb, execAll, setSqlLoader, withDatabase, type SqlState } from './index.js';

const require = createRequire(import.meta.url);

beforeAll(() => {
  const wasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  setSqlLoader(() => initSqlJs({ locateFile: (f: string) => join(wasmDir, f) }));
});

const schema = `
CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT NOT NULL, level INTEGER NOT NULL);
INSERT INTO students VALUES (1, 'Ama', 200), (2, 'Kofi', 100), (3, 'Esi', 200);
CREATE TABLE marks (student_id INTEGER REFERENCES students(id), course TEXT, mark INTEGER);
INSERT INTO marks VALUES (1, 'CS101', 80), (1, 'CS103', 60), (2, 'CS101', 55), (3, 'CS101', NULL);
`;

const checks = createSqlChecks();
const state = (sql: string): SqlState => ({ schema, sql });
const lab = (specs: LabSpec['checks']): LabSpec<SqlState> => ({
  id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E5', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1,
});

describe('database basics', () => {
  it('opens a fresh database per call and describes it', async () => {
    const tables = await withDatabase(schema, (db) => describeDb(db));
    expect(tables.map((t) => t.name)).toEqual(['marks', 'students']);
    expect(tables[1].columns.map((c) => c.name)).toEqual(['id', 'name', 'level']);
    expect(tables[1].rowCount).toBe(3);
    const rows = await withDatabase(schema, (db) => execAll(db, 'SELECT name FROM students ORDER BY name'));
    expect(rows[0].rows).toEqual([['Ama'], ['Esi'], ['Kofi']]);
  });
});

describe('compareResults', () => {
  const expected = { columns: ['name', 'level'], rows: [['Ama', 200], ['Esi', 200]] };
  it('compares as a set by default and in order when asked', () => {
    expect(compareResults({ columns: ['n', 'l'], rows: [['Esi', 200], ['Ama', 200]] }, expected)).toBeNull();
    expect(compareResults({ columns: ['n', 'l'], rows: [['Esi', 200], ['Ama', 200]] }, expected, { ordered: true })).toMatch(/row 1 should be \("Ama", 200\)/);
    expect(compareResults({ columns: ['n', 'l'], rows: [['Ama', 200]] }, expected)).toMatch(/expected 2 rows but got 1/);
    expect(compareResults({ columns: ['n', 'l'], rows: [['Ama', 200], ['Kofi', 100]] }, expected)).toMatch(/\("Esi", 200\) is missing/);
    expect(compareResults(null, expected)).toMatch(/no rows at all/);
  });
  it('checks column names only when asked, and tolerates decimals', () => {
    expect(compareResults({ columns: ['NAME', 'Level'], rows: expected.rows }, expected, { columns: true })).toBeNull();
    expect(compareResults({ columns: ['x', 'y'], rows: expected.rows }, expected, { columns: true })).toMatch(/columns should be name, level/);
    expect(compareResults({ columns: ['a'], rows: [[66.6667]] }, { columns: ['a'], rows: [[66.67]] })).toBeNull();
    expect(compareResults({ columns: ['a'], rows: [['70']] }, { columns: ['a'], rows: [[70]] })).toBeNull();
  });
});

describe('sql.* checks', () => {
  it('sql.query against a reference query, with errors explained', async () => {
    const spec = lab([{ type: 'sql.query', label: 'level 200', expectedQuery: 'SELECT name FROM students WHERE level = 200 ORDER BY name', ordered: true }]);
    expect((await checks.run(spec, state('SELECT name FROM students WHERE level = 200 ORDER BY name'))).passed).toBe(true);
    const wrongOrder = await checks.run(spec, state('SELECT name FROM students WHERE level = 200 ORDER BY name DESC'));
    expect(wrongOrder.checks[0].message).toMatch(/row 1 should be \("Ama"\)/);
    const bad = await checks.run(spec, state('SELECT nam FROM students'));
    expect(bad.checks[0].message).toMatch(/no such column: nam/);
    const unordered = lab([{ type: 'sql.query', label: 'set', expectedQuery: 'SELECT name FROM students WHERE level = 200' }]);
    expect((await checks.run(unordered, state('SELECT name FROM students WHERE level = 200 ORDER BY name DESC'))).passed).toBe(true);
    const literal = lab([{ type: 'sql.query', label: 'count', expected: [[3]] }]);
    expect((await checks.run(literal, state('SELECT COUNT(*) FROM students'))).passed).toBe(true);
  });

  it('sql.script probes the database after a DDL/DML script', async () => {
    const spec = lab([
      {
        type: 'sql.script',
        label: 'table',
        solution: "CREATE TABLE lecturers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO lecturers VALUES (1, 'Dr Owusu');",
        probes: [
          { query: 'SELECT COUNT(*) FROM lecturers', expected: [[1]], name: 'row count' },
          { query: 'SELECT name FROM lecturers', expectedQuery: 'SELECT name FROM lecturers', name: 'names' },
        ],
      },
      { type: 'sql.rejects', label: 'not null', statement: 'INSERT INTO lecturers (id, name) VALUES (2, NULL)' },
    ]);
    const good = state("CREATE TABLE lecturers (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO lecturers VALUES (1, 'Dr Owusu');");
    expect((await checks.run(spec, good)).passed).toBe(true);
    const noConstraint = await checks.run(spec, state("CREATE TABLE lecturers (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO lecturers VALUES (1, 'Dr Owusu');"));
    expect(noConstraint.checks[0].passed).toBe(true);
    expect(noConstraint.checks[1].message).toMatch(/accepted a row it should have refused/);
    const empty = await checks.run(spec, state('CREATE TABLE lecturers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'));
    expect(empty.checks[0].message).toMatch(/row count is not right: the row \(1\) is missing/);
  });

  it('sql.runs and sql.source', async () => {
    expect((await checks.run(lab([{ type: 'sql.runs', label: 'runs' }]), state('SELECT 1'))).passed).toBe(true);
    expect((await checks.run(lab([{ type: 'sql.runs', label: 'runs' }]), state('SELEC 1'))).checks[0].message).toMatch(/syntax error/);
    const join = lab([{ type: 'sql.source', label: 'join', pattern: '\\bJOIN\\b', message: 'Use a JOIN.' }]);
    expect((await checks.run(join, state('SELECT * FROM students s JOIN marks m ON m.student_id = s.id'))).passed).toBe(true);
    expect((await checks.run(join, state('SELECT * FROM students, marks'))).checks[0].message).toBe('Use a JOIN.');
  });
});
