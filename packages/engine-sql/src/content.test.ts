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
  "spreadsheet-analytics-b1-the-pivot-as-a-query": "SELECT product, SUM(qty * unit_price) AS revenue, COUNT(*) AS lines, ROUND(100.0 * SUM(qty * unit_price) / (SELECT SUM(qty * unit_price) FROM sales), 1) AS share FROM sales GROUP BY product ORDER BY revenue DESC, product;",
  "business-intelligence-and-dashboards-i1-running-totals-over-a-star-schema": "WITH m AS (SELECT d.month, SUM(f.revenue) AS revenue FROM fact_sales f JOIN dim_date d ON d.date_key = f.date_key WHERE d.year = 2025 GROUP BY d.month) SELECT month, revenue, SUM(revenue) OVER (ORDER BY month) AS running_total, revenue - LAG(revenue) OVER (ORDER BY month) AS change FROM m ORDER BY month;",
  "enterprise-resource-planning-i1-three-way-match": "SELECT i.inv_id, i.po_id, i.line, p.material, COALESCE(g.qty_received, 0) AS received, i.qty_invoiced, p.unit_price AS po_price, i.unit_price AS invoice_price FROM invoices i JOIN po_lines p ON p.po_id = i.po_id AND p.line = i.line LEFT JOIN goods_receipts g ON g.po_id = i.po_id AND g.line = i.line WHERE i.qty_invoiced > COALESCE(g.qty_received, 0) OR i.unit_price <> p.unit_price ORDER BY i.inv_id, i.line;",
  "health-data-standards-and-interoperability-i1-map-local-codes-to-icd": "SELECT COALESCE(m.icd10, 'UNMAPPED') AS icd10, COALESCE(m.icd_title, 'Not mapped') AS title, COUNT(*) AS encounters FROM encounters e LEFT JOIN concept_map m ON m.local_code = e.local_code GROUP BY 1, 2 ORDER BY encounters DESC, icd10;",
  "electronic-health-records-i1-pivoting-an-eav-record": "SELECT e.id, p.name, e.visit_date, MAX(CASE WHEN o.concept = 'TEMP' THEN o.value_num END) AS temperature, MAX(CASE WHEN o.concept = 'WEIGHT' THEN o.value_num END) AS weight, MAX(CASE WHEN o.concept = 'DIAGNOSIS' THEN o.value_text END) AS diagnosis FROM encounters e JOIN patients p ON p.id = e.patient_id LEFT JOIN obs o ON o.encounter_id = e.id GROUP BY e.id, p.name, e.visit_date ORDER BY e.visit_date, e.id;",
  "data-mining-and-warehousing-i1-market-basket-in-sql": "WITH n AS (SELECT COUNT(DISTINCT basket_id) AS total FROM baskets), item_count AS (SELECT item, COUNT(DISTINCT basket_id) AS c FROM baskets GROUP BY item), pairs AS (SELECT a.item AS item_a, b.item AS item_b, COUNT(*) AS pair_count FROM baskets a JOIN baskets b ON a.basket_id = b.basket_id AND a.item < b.item GROUP BY a.item, b.item) SELECT p.item_a, p.item_b, p.pair_count AS support, ROUND(1.0 * p.pair_count / ca.c, 2) AS confidence, ROUND((1.0 * p.pair_count / ca.c) / (1.0 * cb.c / n.total), 2) AS lift FROM pairs p JOIN item_count ca ON ca.item = p.item_a JOIN item_count cb ON cb.item = p.item_b CROSS JOIN n WHERE p.pair_count >= 3 ORDER BY lift DESC, p.item_a, p.item_b;",
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
