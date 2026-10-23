/**
 * Every E2 lab written after this test must be solvable: a reference circuit per lab id passes every
 * check, and an empty canvas does not. The Digital Logic Design labs were verified in the browser.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createLogicChecks } from './checks';
import { emptyCircuit, type Circuit, type CircuitNode, type GateType } from './circuit';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');
const LEGACY = new Set(['digital-logic-design']);

/** Build a circuit from gates written as [id, type, label?] and wires written as [from, to, toPort]. */
function build(gates: Array<[string, GateType, string?]>, wires: Array<[string, string, number]>): Circuit {
  const nodes: CircuitNode[] = gates.map(([id, type, label], i) => ({ id, type, x: 80 * i, y: 0, ...(label ? { label } : {}), ...(type === 'INPUT' ? { value: 0 as const } : {}) }));
  return { nodes, wires: wires.map(([from, to, port], i) => ({ id: 'w' + i, from: { node: from, port: 0 }, to: { node: to, port } })) };
}

const SOLUTIONS: Record<string, Circuit> = {
  'vlsi-design-i1-xor-from-nand-cells': build(
    [['a', 'INPUT', 'A'], ['b', 'INPUT', 'B'], ['n1', 'NAND'], ['n2', 'NAND'], ['n3', 'NAND'], ['n4', 'NAND'], ['y', 'OUTPUT', 'Y']],
    [['a', 'n1', 0], ['b', 'n1', 1], ['a', 'n2', 0], ['n1', 'n2', 1], ['b', 'n3', 0], ['n1', 'n3', 1], ['n2', 'n4', 0], ['n3', 'n4', 1], ['n4', 'y', 0]],
  ),
};

function allLabs(): LabSpec<Circuit>[] {
  const out: LabSpec<Circuit>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<Circuit>;
      if (raw.engine === 'E2') out.push(raw);
    }
  }
  return out;
}

describe('E2 lab content', () => {
  const checks = createLogicChecks();
  for (const lab of allLabs()) {
    if (LEGACY.has(lab.course)) continue;
    describe(lab.id, () => {
      it('has a reference circuit', () => {
        expect(SOLUTIONS[lab.id], `no reference circuit for ${lab.id}`).toBeDefined();
      });
      it('does not pass on an empty canvas', async () => {
        const r = await checks.run(lab, emptyCircuit());
        expect(r.passed).toBe(false);
      });
      it('passes with the reference circuit', async () => {
        const r = await checks.run(lab, SOLUTIONS[lab.id]);
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
