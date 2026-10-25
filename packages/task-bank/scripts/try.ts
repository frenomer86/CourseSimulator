/**
 * Debug helper: build templates whose id matches a pattern, check that the starter fails and the
 * reference solution passes, and print the failing checks with their output.
 *   npx vite-node packages/task-bank/scripts/try.ts COURSE PATTERN [VARIANT]
 */
import type { LabSpec } from '@cslab/lab-runtime';
import { createShellChecks, runLines, systemFromInitial, type ShellState } from '@cslab/engine-shell';
import { buildTask, loadCourse } from '../src/index';

const [course, pattern = '', variant = '1'] = process.argv.slice(2).filter((a) => a !== '--');
const shell = createShellChecks();
const templates = (await loadCourse(course)).filter((t) => new RegExp(pattern).test(t.id) && t.engine === 'E4');
for (const t of templates) {
  const lab = buildTask(t, Number(variant));
  const before = await shell.run(lab as LabSpec<ShellState>, { system: systemFromInitial(lab.initialState), history: [] });
  const sys = systemFromInitial(lab.initialState);
  const out = runLines(sys, lab.solution ?? []);
  const r = await shell.run(lab as LabSpec<ShellState>, { system: sys, history: sys.history });
  const failing = r.checks.filter((c) => !c.passed);
  if (!before.passed && !failing.length) {
    console.log(`ok   ${t.id}`);
    continue;
  }
  console.log(`FAIL ${t.id}${before.passed ? ' (starter passes)' : ''}`);
  for (const c of failing) console.log(`  - ${c.label}: ${c.message}${c.detail !== undefined ? `\n    detail: ${JSON.stringify(c.detail).slice(0, 600)}` : ''}`);
  if (failing.length) console.log(out.slice(-1500).replace(/^/gm, '    | '));
}
