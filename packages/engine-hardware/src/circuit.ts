/**
 * A DC circuit solver (modified nodal analysis) for resistors, voltage and current sources,
 * diodes and LEDs (constant-drop model, found by iteration), switches and wires.
 * Node "0", "gnd" or "GND" is ground.
 */

import { evaluate, parseExpr } from '@cslab/engine-maths';

export type ComponentType = 'R' | 'V' | 'I' | 'D' | 'LED' | 'SW' | 'W' | 'LAMP';

export interface Component {
  id: string;
  type: ComponentType;
  /** Ohms for R and LAMP, volts for V, amps for I. */
  value?: number;
  /** [a, b]: for V the + terminal first; for I the arrow points from a to b; for D the anode first. */
  nodes: [string, string];
  label?: string;
  /** Switches: closed or open. */
  closed?: boolean;
  /** Diodes and LEDs: forward drop (0.7 V for D, 2.0 V for LED by default). */
  vf?: number;
  /** Lamps: rated power at rated voltage, for "is it lit" displays. */
  ratedV?: number;
  ratedW?: number;
}

export interface Circuit {
  components: Component[];
}

export interface Solution {
  ok: boolean;
  error?: string;
  /** Node voltages relative to ground. */
  voltages: Record<string, number>;
  /** Current through each component from nodes[0] to nodes[1]; for V sources, the current supplied out of +. */
  currents: Record<string, number>;
  /** Power dissipated (positive) or supplied (negative for sources delivering). */
  power: Record<string, number>;
  on: Record<string, boolean>;
}

export function isGround(n: string): boolean {
  return n === '0' || n.toLowerCase() === 'gnd';
}

export function componentValue(c: Component, overrides: Record<string, number> = {}): number {
  return overrides[c.id] ?? c.value ?? 0;
}

function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Solves the circuit. `values` overrides component values (adjustable parts); `switches` overrides closed states. */
export function solve(circuit: Circuit, values: Record<string, number> = {}, switches: Record<string, boolean> = {}): Solution {
  const comps = circuit.components;
  const nodeIds = [...new Set(comps.flatMap((c) => c.nodes).filter((n) => !isGround(n)))];
  const idx = new Map(nodeIds.map((n, i) => [n, i]));
  const empty: Solution = { ok: false, voltages: {}, currents: {}, power: {}, on: {} };
  if (!comps.some((c) => c.nodes.some(isGround))) return { ...empty, error: 'The circuit has no ground reference (node 0 or gnd).' };

  // Diode states, refined by iteration.
  const diodes = comps.filter((c) => c.type === 'D' || c.type === 'LED');
  let on: Record<string, boolean> = Object.fromEntries(diodes.map((d) => [d.id, true]));
  const seen: string[] = [];
  for (let iter = 0; iter < 40; iter++) {
    // Voltage-source-like elements: V, closed switches, wires, diodes that are on.
    const vsrc: Array<{ c: Component; v: number }> = [];
    for (const c of comps) {
      if (c.type === 'V') vsrc.push({ c, v: componentValue(c, values) });
      else if (c.type === 'SW' && (switches[c.id] ?? c.closed ?? false)) vsrc.push({ c, v: 0 });
      else if (c.type === 'W') vsrc.push({ c, v: 0 });
      else if ((c.type === 'D' || c.type === 'LED') && on[c.id]) vsrc.push({ c, v: c.vf ?? (c.type === 'LED' ? 2.0 : 0.7) });
    }
    const n = nodeIds.length;
    const m = vsrc.length;
    const size = n + m;
    const A = Array.from({ length: size }, () => new Array(size).fill(0));
    const z = new Array(size).fill(0);
    const at = (node: string) => (isGround(node) ? -1 : idx.get(node)!);
    for (const c of comps) {
      const [a, b] = c.nodes.map(at);
      if (c.type === 'R' || c.type === 'LAMP') {
        const r = c.type === 'LAMP' ? lampResistance(c) : componentValue(c, values);
        if (r <= 0) return { ...empty, error: `${c.id} has a non-positive resistance.` };
        const g = 1 / r;
        if (a >= 0) A[a][a] += g;
        if (b >= 0) A[b][b] += g;
        if (a >= 0 && b >= 0) {
          A[a][b] -= g;
          A[b][a] -= g;
        }
      } else if (c.type === 'I') {
        const i = componentValue(c, values);
        if (a >= 0) z[a] -= i;
        if (b >= 0) z[b] += i;
      }
    }
    vsrc.forEach(({ c, v }, k) => {
      const [a, b] = c.nodes.map(at);
      const row = n + k;
      if (a >= 0) {
        A[a][row] += 1;
        A[row][a] += 1;
      }
      if (b >= 0) {
        A[b][row] -= 1;
        A[row][b] -= 1;
      }
      z[row] = v;
    });
    const x = size ? solveLinear(A, z) : [];
    if (!x) return { ...empty, error: 'The circuit cannot be solved: check for a loop of voltage sources or a floating part.' };
    const voltages: Record<string, number> = { '0': 0, gnd: 0 };
    nodeIds.forEach((id, i) => (voltages[id] = x[i]));
    const vOf = (node: string) => (isGround(node) ? 0 : voltages[node]);
    const currents: Record<string, number> = {};
    const power: Record<string, number> = {};
    vsrc.forEach(({ c }, k) => {
      const through = x[n + k]; // current flowing into + and out of −, inside the element
      currents[c.id] = c.type === 'V' ? -through : through;
    });
    let changed = false;
    const next = { ...on };
    for (const c of comps) {
      const [a, b] = c.nodes;
      const vab = vOf(a) - vOf(b);
      if (c.type === 'R' || c.type === 'LAMP') {
        const r = c.type === 'LAMP' ? lampResistance(c) : componentValue(c, values);
        currents[c.id] = vab / r;
        power[c.id] = vab * currents[c.id];
      } else if (c.type === 'I') {
        currents[c.id] = componentValue(c, values);
        power[c.id] = -vab * currents[c.id];
      } else if (c.type === 'V') {
        power[c.id] = -vab * currents[c.id];
      } else if (c.type === 'D' || c.type === 'LED') {
        if (on[c.id]) {
          const i = currents[c.id];
          if (i < -1e-9) {
            next[c.id] = false;
            changed = true;
          }
          power[c.id] = vab * i;
        } else {
          currents[c.id] = 0;
          power[c.id] = 0;
          if (vab > (c.vf ?? (c.type === 'LED' ? 2.0 : 0.7)) + 1e-9) {
            next[c.id] = true;
            changed = true;
          }
        }
      } else if (c.type === 'SW' && !(switches[c.id] ?? c.closed ?? false)) {
        currents[c.id] = 0;
        power[c.id] = 0;
      } else {
        power[c.id] = 0;
      }
    }
    if (!changed) return { ok: true, voltages, currents, power, on };
    const key = JSON.stringify(next);
    if (seen.includes(key)) return { ok: true, voltages, currents, power, on }; // oscillating: accept
    seen.push(key);
    on = next;
  }
  return { ...empty, error: 'The diode states did not settle.' };
}

function lampResistance(c: Component): number {
  if (c.value) return c.value;
  const v = c.ratedV ?? 12;
  const w = c.ratedW ?? 6;
  return (v * v) / w;
}

/** True when a lamp or LED is visibly on (more than a tenth of rated power, or forward current above 1 mA). */
export function isLit(c: Component, sol: Solution): boolean {
  if (!sol.ok) return false;
  if (c.type === 'LED') return sol.on[c.id] && (sol.currents[c.id] ?? 0) > 1e-3;
  if (c.type === 'LAMP') return (sol.power[c.id] ?? 0) > (c.ratedW ?? 6) * 0.1;
  return false;
}

/**
 * Evaluates an expression over the solution: V(n), V(a,b), I(X), P(X), R(X) with ordinary arithmetic.
 * Example: "V(n2) - V(n3)" or "I(R1) * 1000".
 */
export function evalCircuitExpr(expr: string, circuit: Circuit, sol: Solution, values: Record<string, number> = {}): number {
  if (!sol.ok) return NaN;
  const num = (x: number) => (Number.isFinite(x) ? `(${x})` : 'NaN');
  let s = expr.replace(/V\(\s*([^,()\s]+)\s*,\s*([^,()\s]+)\s*\)/g, (_, a: string, b: string) => num((sol.voltages[a] ?? (isGround(a) ? 0 : NaN)) - (sol.voltages[b] ?? (isGround(b) ? 0 : NaN))));
  s = s.replace(/V\(\s*([^,()\s]+)\s*\)/g, (_, a: string) => num(sol.voltages[a] ?? (isGround(a) ? 0 : NaN)));
  s = s.replace(/I\(\s*([^,()\s]+)\s*\)/g, (_, id: string) => num(sol.currents[id] ?? NaN));
  s = s.replace(/P\(\s*([^,()\s]+)\s*\)/g, (_, id: string) => num(sol.power[id] ?? NaN));
  s = s.replace(/R\(\s*([^,()\s]+)\s*\)/g, (_, id: string) => {
    const c = circuit.components.find((x) => x.id === id);
    return num(c ? componentValue(c, values) : NaN);
  });
  try {
    return evaluate(parseExpr(s), {});
  } catch {
    return NaN;
  }
}

/** Formats a quantity with an SI prefix and unit, as a multimeter would. */
export function formatQuantity(x: number, unit: string, digits = 3): string {
  if (!Number.isFinite(x)) return '---';
  const abs = Math.abs(x);
  const prefixes: Array<[number, string]> = [
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
  ];
  if (abs < 1e-9) return `0 ${unit}`;
  for (const [scale, p] of prefixes) {
    if (abs >= scale * 0.999) return `${Number((x / scale).toPrecision(digits))} ${p}${unit}`;
  }
  return `${Number((x / 1e-6).toPrecision(digits))} µ${unit}`;
}

/** Equivalent resistance seen between two nodes with sources zeroed: found by injecting a 1 A test source. */
export function resistanceBetween(circuit: Circuit, a: string, b: string, values: Record<string, number> = {}, switches: Record<string, boolean> = {}): number {
  const zeroed: Circuit = {
    components: circuit.components
      .filter((c) => c.type !== 'I')
      .map((c) => (c.type === 'V' ? { ...c, type: 'W' as const } : c))
      .concat([{ id: '__test', type: 'I', value: 1, nodes: [b, a] }]),
  };
  // Make sure a ground exists: use b as reference if the circuit has none.
  const hasGround = zeroed.components.some((c) => c.nodes.some(isGround));
  const probe = hasGround ? zeroed : { components: zeroed.components.map((c) => ({ ...c, nodes: c.nodes.map((n) => (n === b ? '0' : n)) as [string, string] })) };
  const sol = solve(probe, values, switches);
  if (!sol.ok) return NaN;
  const va = sol.voltages[a] ?? (isGround(a) ? 0 : NaN);
  const vb = hasGround ? sol.voltages[b] ?? (isGround(b) ? 0 : NaN) : 0;
  return va - vb;
}
