import { describe, expect, it } from 'vitest';
import {
  addNode,
  connect,
  emptyCircuit,
  evaluate,
  toggleInput,
  truthTable,
  type Circuit,
} from './circuit';
import { evaluateExpression } from './expression';
import { createLogicChecks } from './checks';

function build(spec: Array<[string, Parameters<typeof addNode>[1], string?]>, wires: Array<[string, string, number?]>): Circuit {
  let c = emptyCircuit();
  const ids: Record<string, string> = {};
  for (const [key, type, label] of spec) {
    c = addNode(c, type, 0, 0, label);
    ids[key] = c.nodes[c.nodes.length - 1].id;
  }
  for (const [from, to, port] of wires) {
    c = connect(c, { node: ids[from], port: 0 }, { node: ids[to], port: port ?? 0 });
  }
  return c;
}

describe('gate evaluation', () => {
  it('computes AND of two inputs', () => {
    const c = build(
      [['a', 'INPUT', 'A'], ['b', 'INPUT', 'B'], ['g', 'AND'], ['y', 'OUTPUT', 'Y']],
      [['a', 'g', 0], ['b', 'g', 1], ['g', 'y', 0]],
    );
    const t = truthTable(c);
    expect(t.inputs).toEqual(['A', 'B']);
    expect(t.rows.map((r) => r.outputs[0])).toEqual([0, 0, 0, 1]);
  });

  it('reports unconnected inputs as undefined', () => {
    const c = build([['a', 'INPUT', 'A'], ['g', 'AND'], ['y', 'OUTPUT', 'Y']], [['a', 'g', 0], ['g', 'y', 0]]);
    const ev = evaluate(c);
    expect(ev.unconnected.length).toBe(1);
    expect(ev.nodeValues[c.nodes[2].id]).toBeUndefined();
  });

  it('toggles an input switch', () => {
    let c = addNode(emptyCircuit(), 'INPUT', 0, 0, 'A');
    const id = c.nodes[0].id;
    expect(evaluate(c).nodeValues[id]).toBe(0);
    c = toggleInput(c, id);
    expect(evaluate(c).nodeValues[id]).toBe(1);
  });

  it('detects combinational loops without hanging', () => {
    let c = addNode(emptyCircuit(), 'NOT', 0, 0);
    const id = c.nodes[0].id;
    c = connect(c, { node: id, port: 0 }, { node: id, port: 0 });
    // connect() refuses self-connections, so build a two-gate loop instead
    c = addNode(c, 'NOT', 0, 0);
    const id2 = c.nodes[1].id;
    c = connect(c, { node: id, port: 0 }, { node: id2, port: 0 });
    c = connect(c, { node: id2, port: 0 }, { node: id, port: 0 });
    const ev = evaluate(c);
    expect(ev.hasLoop).toBe(true);
  });

  it('replaces an existing wire into the same input port', () => {
    const c = build(
      [['a', 'INPUT', 'A'], ['b', 'INPUT', 'B'], ['n', 'NOT'], ['y', 'OUTPUT', 'Y']],
      [['a', 'n', 0], ['b', 'n', 0], ['n', 'y', 0]],
    );
    expect(c.wires.filter((w) => w.to.node === c.nodes[2].id).length).toBe(1);
  });
});

describe('expression evaluator', () => {
  const env = { A: 1 as const, B: 0 as const, CIN: 1 as const };
  it('handles operators and precedence', () => {
    expect(evaluateExpression('A & B', env)).toBe(0);
    expect(evaluateExpression('A | B', env)).toBe(1);
    expect(evaluateExpression('A ^ Cin', env)).toBe(0);
    expect(evaluateExpression('!B', env)).toBe(1);
    expect(evaluateExpression("B'", env)).toBe(1);
    expect(evaluateExpression('A & B | Cin', env)).toBe(1);
    expect(evaluateExpression('A & (B | Cin)', env)).toBe(1);
    expect(evaluateExpression('A AND NOT B', env)).toBe(1);
  });
  it('rejects unknown signals', () => {
    expect(() => evaluateExpression('Z', env)).toThrow(/Unknown signal/);
  });
});

describe('logic checks', () => {
  const registry = createLogicChecks();
  const halfAdder = build(
    [['a', 'INPUT', 'A'], ['b', 'INPUT', 'B'], ['x', 'XOR'], ['n', 'AND'], ['s', 'OUTPUT', 'S'], ['c', 'OUTPUT', 'C']],
    [['a', 'x', 0], ['b', 'x', 1], ['a', 'n', 0], ['b', 'n', 1], ['x', 's', 0], ['n', 'c', 0]],
  );

  it('passes a correct half adder', async () => {
    const result = await registry.run(
      {
        id: 't', course: 'BCSC 205', topic: '', level: 'intermediate', engine: 'E2', title: '', instructions: '',
        hints: [], estimatedMinutes: 1,
        checks: [
          { type: 'logic.truthTable', label: 'table', inputs: ['A', 'B'], outputs: { S: 'A ^ B', C: 'A & B' } },
          { type: 'logic.maxGates', label: 'gates', max: 2 },
          { type: 'logic.allConnected', label: 'wired' },
        ],
      },
      halfAdder,
    );
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it('explains a wrong output with a concrete counter-example', async () => {
    const result = await registry.run(
      {
        id: 't', course: 'BCSC 205', topic: '', level: 'intermediate', engine: 'E2', title: '', instructions: '',
        hints: [], estimatedMinutes: 1,
        checks: [{ type: 'logic.truthTable', label: 'table', inputs: ['A', 'B'], outputs: { S: 'A | B' } }],
      },
      halfAdder,
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0].message).toMatch(/A=1, B=1, S should be 1 but is 0/);
  });

  it('enforces allowed gates', async () => {
    const result = await registry.run(
      {
        id: 't', course: 'BCSC 205', topic: '', level: 'advanced', engine: 'E2', title: '', instructions: '',
        hints: [], estimatedMinutes: 1,
        checks: [{ type: 'logic.allowedGates', label: 'nand only', gates: ['NAND'] }],
      },
      halfAdder,
    );
    expect(result.passed).toBe(false);
    expect(result.checks[0].message).toMatch(/XOR/);
  });
});
