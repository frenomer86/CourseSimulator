/** Every SQL lab in content/ must pass its own checks with a reference solution, and fail with the starter. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import type { LabSpec } from '@cslab/lab-runtime';
import { createSqlChecks, setSqlLoader, type SqlState } from './index.js';

const require = createRequire(import.meta.url);

beforeAll(() => {
  const wasmDir = dirname(require.resolve('sql.js/dist/sql-wasm.wasm'));
  setSqlLoader(() => initSqlJs({ locateFile: (f: string) => join(wasmDir, f) }));
});

const SOLUTIONS: Record<string, string> = {
  'fundamentals-of-computer-science-b1-first-select': 'SELECT name, programme FROM students WHERE level = 100 ORDER BY name;',
  'database-systems-and-design-b1-select-where-order': "SELECT name, hometown FROM students WHERE programme = 'Computer Science' AND level = 200 ORDER BY name;",
  'database-systems-and-design-b2-group-by-having': 'SELECT programme, COUNT(*) AS students FROM students GROUP BY programme HAVING COUNT(*) > 2 ORDER BY students DESC;',
  'database-systems-and-design-i1-join':
    "SELECT s.name, c.title, e.mark FROM enrolments e JOIN students s ON s.id = e.student_id JOIN courses c ON c.code = e.course_code WHERE e.semester = '2025-1' ORDER BY s.name, c.title;",
  'database-systems-and-design-i2-subqueries-sets': 'SELECT s.name, s.programme FROM students s LEFT JOIN enrolments e ON e.student_id = s.id WHERE e.student_id IS NULL ORDER BY s.name;',
  'database-systems-and-design-a1-create-clinic-schema': `PRAGMA foreign_keys = ON;
CREATE TABLE patients (id INTEGER PRIMARY KEY, name TEXT NOT NULL, date_of_birth TEXT NOT NULL, phone TEXT UNIQUE);
CREATE TABLE visits (id INTEGER PRIMARY KEY, patient_id INTEGER NOT NULL REFERENCES patients(id), visit_date TEXT NOT NULL, temperature_c REAL CHECK (temperature_c BETWEEN 30 AND 45), notes TEXT);
INSERT INTO patients VALUES (1, 'Akosua Boateng', '1998-04-17', '0244000111'), (2, 'Yaw Mensah', '1975-11-02', NULL);
INSERT INTO visits VALUES (1, 1, '2026-10-01', 37.2, 'Headache'), (2, 2, '2026-10-01', 38.9, 'Fever'), (3, 1, '2026-10-15', NULL, 'Follow-up');`,
  'database-systems-and-design-a2-transcript-report': `SELECT s.name, COUNT(*) AS courses, ROUND(AVG(e.mark), 1) AS average,
  CASE WHEN AVG(e.mark) >= 60 THEN 'Good' ELSE 'At risk' END AS standing
FROM students s JOIN enrolments e ON e.student_id = s.id
WHERE e.mark IS NOT NULL GROUP BY s.id, s.name ORDER BY average DESC, s.name;`,
};

const root = join(__dirname, '../../../content/courses');
const labs: LabSpec<{ sql: string }>[] = [];
for (const course of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory())) {
  for (const f of readdirSync(join(root, course)).filter((f) => f.endsWith('.json'))) {
    const lab = JSON.parse(readFileSync(join(root, course, f), 'utf8')) as LabSpec<{ sql: string }>;
    if (lab.engine === 'E5') labs.push(lab);
  }
}

const checks = createSqlChecks();

describe('SQL labs in content/', () => {
  it('finds the SQL labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(7);
  });
  for (const lab of labs) {
    it(`${lab.id}: the reference solution passes and the starter does not`, async () => {
      const solution = SOLUTIONS[lab.id];
      expect(solution, `a reference solution for ${lab.id}`).toBeTruthy();
      const schema = String(lab.config?.schema ?? '');
      const good = await checks.run(lab as unknown as LabSpec<SqlState>, { schema, sql: solution });
      expect(good.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
      const starter = await checks.run(lab as unknown as LabSpec<SqlState>, { schema, sql: lab.initialState?.sql ?? '' });
      expect(starter.passed).toBe(false);
    });
  }
});
