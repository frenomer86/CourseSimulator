/** Deterministic layouts: layered left-to-right for graphs, a grid for class/ER, columns for sequence. */

import type { Diagram, DiagramNode } from './model.js';

export interface Placed {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  nodes: Placed[];
  /** Sequence diagrams: lifeline x per participant. */
  lifelines?: Record<string, number>;
}

export function nodeSize(n: DiagramNode, kind: Diagram['kind']): { w: number; h: number } {
  const label = n.label || n.id;
  const members = n.members ?? [];
  if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'entity') {
    const longest = Math.max(label.length, ...members.map((m) => m.length), 8);
    return { w: Math.min(260, 20 + longest * 7), h: 30 + members.length * 16 + (members.length ? 8 : 0) };
  }
  if (n.kind === 'start' || n.kind === 'end') return { w: 28, h: 28 };
  if (n.kind === 'event') return { w: 32, h: 32 };
  if (n.kind.startsWith('gateway')) return { w: 40, h: 40 };
  if (n.kind === 'decision') return { w: Math.max(80, label.length * 7 + 30), h: 50 };
  if (n.kind === 'actor') return { w: 44, h: 60 };
  if (n.kind === 'usecase') return { w: Math.max(100, label.length * 6.5 + 24), h: 44 };
  if (n.kind === 'process' && kind === 'dfd') return { w: Math.max(90, label.length * 6.5 + 24), h: 50 };
  if (n.kind === 'store') return { w: Math.max(90, label.length * 7 + 20), h: 32 };
  if (n.kind === 'activity' && kind === 'cpm') return { w: 110, h: 54 };
  return { w: Math.max(80, Math.min(220, label.length * 7 + 24)), h: 36 };
}

export function layoutDiagram(d: Diagram): Layout {
  if (d.kind === 'sequence') return layoutSequence(d);
  if (d.kind === 'class' || d.kind === 'er') return layoutGrid(d);
  return layoutLayered(d, d.kind === 'usecase');
}

function layoutLayered(d: Diagram, actorsLeft: boolean): Layout {
  const ids = d.nodes.map((n) => n.id);
  const level = new Map<string, number>();
  // Longest-path layering over a DAG; cycles are broken by ignoring back edges in DFS order.
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const dfs = (id: string) => {
    visited.add(id);
    onStack.add(id);
    for (const e of d.edges) {
      if (e.from !== id) continue;
      if (onStack.has(e.to)) continue; // back edge
      preds.get(e.to)?.push(id);
      if (!visited.has(e.to)) dfs(e.to);
    }
    onStack.delete(id);
  };
  const sources = ids.filter((id) => !d.edges.some((e) => e.to === id));
  for (const s of sources) dfs(s);
  for (const id of ids) if (!visited.has(id)) dfs(id);
  const depth = (id: string, seen = new Set<string>()): number => {
    if (level.has(id)) return level.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ps = preds.get(id) ?? [];
    const l = ps.length ? Math.max(...ps.map((p) => depth(p, seen))) + 1 : 0;
    level.set(id, l);
    return l;
  };
  for (const id of ids) depth(id);
  if (actorsLeft) for (const n of d.nodes) if (n.kind === 'actor') level.set(n.id, 0);
  const columns = new Map<number, DiagramNode[]>();
  for (const n of d.nodes) {
    const l = level.get(n.id) ?? 0;
    columns.set(l, [...(columns.get(l) ?? []), n]);
  }
  const colW = 190;
  const placed: Placed[] = [];
  let height = 0;
  for (const [l, nodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    let y = 30;
    for (const n of nodes) {
      const s = nodeSize(n, d.kind);
      placed.push({ id: n.id, x: 40 + l * colW + (90 - s.w / 2), y, w: s.w, h: s.h });
      y += s.h + 34;
    }
    height = Math.max(height, y);
  }
  const width = 40 + Math.max(1, columns.size) * colW;
  return { width, height: Math.max(height + 10, 120), nodes: placed };
}

function layoutGrid(d: Diagram): Layout {
  const nodes = d.nodes.filter((n) => n.kind !== 'note');
  const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(nodes.length))));
  const placed: Placed[] = [];
  const colW = 240;
  const rowHeights: number[] = [];
  nodes.forEach((n, i) => {
    const s = nodeSize(n, d.kind);
    const r = Math.floor(i / cols);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, s.h);
  });
  nodes.forEach((n, i) => {
    const s = nodeSize(n, d.kind);
    const c = i % cols;
    const r = Math.floor(i / cols);
    const y = 30 + rowHeights.slice(0, r).reduce((a, b) => a + b + 60, 0);
    placed.push({ id: n.id, x: 30 + c * colW, y, w: s.w, h: s.h });
  });
  const height = 30 + rowHeights.reduce((a, b) => a + b + 60, 0) + 10;
  return { width: 30 + cols * colW, height: Math.max(height, 120), nodes: placed };
}

function layoutSequence(d: Diagram): Layout {
  const parts = d.nodes.filter((n) => n.kind === 'participant' || n.kind === 'actor');
  const lifelines: Record<string, number> = {};
  const placed: Placed[] = [];
  parts.forEach((p, i) => {
    const x = 80 + i * 160;
    lifelines[p.id] = x;
    placed.push({ id: p.id, x: x - 60, y: 10, w: 120, h: 36 });
  });
  const messages = d.edges.filter((e) => e.seq !== undefined).length;
  return { width: 80 + Math.max(1, parts.length) * 160, height: 80 + messages * 34 + d.fragments.length * 20 + 20, nodes: placed, lifelines };
}
