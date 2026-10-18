/**
 * Digital logic engine (E2, digital part).
 * Pure TypeScript: no DOM, no React. The UI is a thin view over this model.
 */

export type Bit = 0 | 1;

export type GateType =
  | 'INPUT'
  | 'OUTPUT'
  | 'AND'
  | 'OR'
  | 'NOT'
  | 'NAND'
  | 'NOR'
  | 'XOR'
  | 'XNOR';

export const GATE_TYPES: GateType[] = ['INPUT', 'OUTPUT', 'AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR'];

export interface GateInfo {
  inputs: number;
  outputs: number;
  symbol: string;
  description: string;
}

export const GATE_INFO: Record<GateType, GateInfo> = {
  INPUT: { inputs: 0, outputs: 1, symbol: 'IN', description: 'A switch you can toggle between 0 and 1.' },
  OUTPUT: { inputs: 1, outputs: 0, symbol: 'OUT', description: 'A lamp that shows the value arriving at it.' },
  AND: { inputs: 2, outputs: 1, symbol: '&', description: 'Output is 1 only when every input is 1.' },
  OR: { inputs: 2, outputs: 1, symbol: '≥1', description: 'Output is 1 when at least one input is 1.' },
  NOT: { inputs: 1, outputs: 1, symbol: '1', description: 'Output is the opposite of the input.' },
  NAND: { inputs: 2, outputs: 1, symbol: '&', description: 'AND followed by NOT. A universal gate.' },
  NOR: { inputs: 2, outputs: 1, symbol: '≥1', description: 'OR followed by NOT. A universal gate.' },
  XOR: { inputs: 2, outputs: 1, symbol: '=1', description: 'Output is 1 when the inputs differ.' },
  XNOR: { inputs: 2, outputs: 1, symbol: '=1', description: 'Output is 1 when the inputs are the same.' },
};

export interface CircuitNode {
  id: string;
  type: GateType;
  x: number;
  y: number;
  /** Signal name for INPUT and OUTPUT nodes (A, B, Y, Sum ...). */
  label?: string;
  /** Current switch value, INPUT nodes only. */
  value?: Bit;
}

export interface PortRef {
  node: string;
  port: number;
}

export interface Wire {
  id: string;
  from: PortRef; // an output port
  to: PortRef; // an input port
}

export interface Circuit {
  nodes: CircuitNode[];
  wires: Wire[];
}

export function emptyCircuit(): Circuit {
  return { nodes: [], wires: [] };
}

let counter = 0;
export function newId(prefix = 'n'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function gateFn(type: GateType, inputs: Array<Bit | undefined>): Bit | undefined {
  if (inputs.some((v) => v === undefined)) return undefined;
  const a = inputs as Bit[];
  switch (type) {
    case 'AND':
      return a.every((v) => v === 1) ? 1 : 0;
    case 'OR':
      return a.some((v) => v === 1) ? 1 : 0;
    case 'NOT':
      return a[0] === 1 ? 0 : 1;
    case 'NAND':
      return a.every((v) => v === 1) ? 0 : 1;
    case 'NOR':
      return a.some((v) => v === 1) ? 0 : 1;
    case 'XOR':
      return (a.reduce<number>((s, v) => s + v, 0) % 2) as Bit;
    case 'XNOR':
      return a.reduce<number>((s, v) => s + v, 0) % 2 === 0 ? 1 : 0;
    case 'OUTPUT':
      return a[0];
    case 'INPUT':
      return undefined;
  }
}

export interface Evaluation {
  /** Output value of every node (undefined when an input is unconnected or a loop exists). */
  nodeValues: Record<string, Bit | undefined>;
  /** Value carried by every wire. */
  wireValues: Record<string, Bit | undefined>;
  /** Node ids whose inputs are not all connected. */
  unconnected: string[];
  /** True if a combinational loop was detected. */
  hasLoop: boolean;
}

/**
 * Evaluate a combinational circuit. INPUT values come from `overrides` when given,
 * otherwise from each INPUT node's own `value`.
 */
export function evaluate(circuit: Circuit, overrides?: Record<string, Bit>): Evaluation {
  const nodeById = new Map(circuit.nodes.map((n) => [n.id, n]));
  const wiresInto = new Map<string, Wire[]>();
  for (const w of circuit.wires) {
    const list = wiresInto.get(w.to.node) ?? [];
    list.push(w);
    wiresInto.set(w.to.node, list);
  }

  const nodeValues: Record<string, Bit | undefined> = {};
  const unconnected = new Set<string>();
  const visiting = new Set<string>();
  let hasLoop = false;

  const valueOf = (id: string): Bit | undefined => {
    if (id in nodeValues) return nodeValues[id];
    const node = nodeById.get(id);
    if (!node) return undefined;
    if (node.type === 'INPUT') {
      const v = overrides && id in overrides ? overrides[id] : node.value ?? 0;
      nodeValues[id] = v;
      return v;
    }
    if (visiting.has(id)) {
      hasLoop = true;
      return undefined;
    }
    visiting.add(id);
    const info = GATE_INFO[node.type];
    const inputs: Array<Bit | undefined> = [];
    for (let p = 0; p < info.inputs; p += 1) {
      const wire = (wiresInto.get(id) ?? []).find((w) => w.to.port === p);
      if (!wire) {
        unconnected.add(id);
        inputs.push(undefined);
      } else {
        inputs.push(valueOf(wire.from.node));
      }
    }
    visiting.delete(id);
    const v = gateFn(node.type, inputs);
    nodeValues[id] = v;
    return v;
  };

  for (const n of circuit.nodes) valueOf(n.id);

  const wireValues: Record<string, Bit | undefined> = {};
  for (const w of circuit.wires) wireValues[w.id] = nodeValues[w.from.node];

  return { nodeValues, wireValues, unconnected: [...unconnected], hasLoop };
}

export interface TruthTable {
  inputs: string[]; // labels, sorted
  outputs: string[]; // labels, sorted
  rows: Array<{ inputs: Bit[]; outputs: Array<Bit | undefined> }>;
}

function labelOf(n: CircuitNode): string {
  return (n.label ?? n.id).trim();
}

/** Enumerate every input combination (inputs sorted by label) and record the outputs. */
export function truthTable(circuit: Circuit): TruthTable {
  const inputNodes = circuit.nodes
    .filter((n) => n.type === 'INPUT')
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const outputNodes = circuit.nodes
    .filter((n) => n.type === 'OUTPUT')
    .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
  const rows: TruthTable['rows'] = [];
  const n = inputNodes.length;
  const total = 1 << n;
  for (let i = 0; i < total; i += 1) {
    const overrides: Record<string, Bit> = {};
    const bits: Bit[] = [];
    for (let k = 0; k < n; k += 1) {
      const bit = ((i >> (n - 1 - k)) & 1) as Bit;
      bits.push(bit);
      overrides[inputNodes[k].id] = bit;
    }
    const ev = evaluate(circuit, overrides);
    rows.push({ inputs: bits, outputs: outputNodes.map((o) => ev.nodeValues[o.id]) });
  }
  return { inputs: inputNodes.map(labelOf), outputs: outputNodes.map(labelOf), rows };
}

/* ----------------------------- editing helpers ----------------------------- */

export function addNode(circuit: Circuit, type: GateType, x: number, y: number, label?: string): Circuit {
  const node: CircuitNode = { id: newId(), type, x, y };
  if (label) node.label = label;
  if (type === 'INPUT') node.value = 0;
  return { ...circuit, nodes: [...circuit.nodes, node] };
}

export function removeNode(circuit: Circuit, id: string): Circuit {
  return {
    nodes: circuit.nodes.filter((n) => n.id !== id),
    wires: circuit.wires.filter((w) => w.from.node !== id && w.to.node !== id),
  };
}

export function moveNode(circuit: Circuit, id: string, x: number, y: number): Circuit {
  return { ...circuit, nodes: circuit.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)) };
}

export function relabelNode(circuit: Circuit, id: string, label: string): Circuit {
  return { ...circuit, nodes: circuit.nodes.map((n) => (n.id === id ? { ...n, label } : n)) };
}

export function toggleInput(circuit: Circuit, id: string): Circuit {
  return {
    ...circuit,
    nodes: circuit.nodes.map((n) =>
      n.id === id && n.type === 'INPUT' ? { ...n, value: n.value === 1 ? 0 : 1 } : n,
    ),
  };
}

/**
 * Connect an output port to an input port. An input port accepts one wire,
 * so an existing wire into that port is replaced. Returns the circuit unchanged
 * when the connection is invalid.
 */
export function connect(circuit: Circuit, from: PortRef, to: PortRef): Circuit {
  const src = circuit.nodes.find((n) => n.id === from.node);
  const dst = circuit.nodes.find((n) => n.id === to.node);
  if (!src || !dst || src.id === dst.id) return circuit;
  if (GATE_INFO[src.type].outputs === 0) return circuit;
  if (to.port >= GATE_INFO[dst.type].inputs) return circuit;
  const wires = circuit.wires.filter((w) => !(w.to.node === to.node && w.to.port === to.port));
  wires.push({ id: newId('w'), from, to });
  return { ...circuit, wires };
}

export function removeWire(circuit: Circuit, id: string): Circuit {
  return { ...circuit, wires: circuit.wires.filter((w) => w.id !== id) };
}

export function countGates(circuit: Circuit): number {
  return circuit.nodes.filter((n) => n.type !== 'INPUT' && n.type !== 'OUTPUT').length;
}
