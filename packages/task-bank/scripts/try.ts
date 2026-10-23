/**
 * Debug helper: build one variant of a template and run PowerShell lines against it.
 *   npx vite-node packages/task-bank/scripts/try.ts <template-id> <variant> [commands.txt]
 * With no lines, it runs the template's reference solution and prints the check results.
 */
import { createShellChecks, runLines, systemFromInitial, type ShellState } from '@cslab/engine-shell';
import type { LabSpec } from '@cslab/lab-runtime';
import { buildTask, loadCourse, TASK_COURSES } from '../src/index';

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const [id, n = '1', file] = args;
// Lines come from a file (one command per line), because CLI wrappers eat arguments that start with "-".
const lines = file ? readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()) : [];
const all = (await Promise.all(TASK_COURSES.map((c) => loadCourse(c)))).flat();
const t = all.find((x) => x.id === id);
if (!t) throw new Error(`no template ${id}`);
const lab = buildTask(t, Number(n));
const sys = systemFromInitial(lab.initialState);
const script = lines.length ? lines : lab.solution ?? [];
const transcript = runLines(sys, script);
console.log(transcript);
const shell = createShellChecks();
const r = await shell.run(lab as LabSpec<ShellState>, { system: sys, history: sys.history });
for (const c of r.checks) console.log(c.passed ? 'PASS' : 'FAIL', c.label, c.passed ? '' : `: ${c.message}`);
