/** Critical path method over an activity-on-node network. */

import type { Diagram } from './model.js';

export interface CpmActivity {
  id: string;
  label: string;
  duration: number;
  es: number;
  ef: number;
  ls: number;
  lf: number;
  slack: number;
  critical: boolean;
  predecessors: string[];
  variance?: number;
}

export interface CpmResult {
  ok: boolean;
  error?: string;
  activities: CpmActivity[];
  duration: number;
  criticalPath: string[];
  /** Standard deviation of the critical path when PERT estimates were given. */
  sigma?: number;
}

export function computeCpm(d: Diagram): CpmResult {
  const acts = d.nodes.filter((n) => n.kind === 'activity' || n.kind === 'task' || n.kind === 'node');
  const preds = new Map<string, string[]>(acts.map((a) => [a.id, []]));
  for (const e of d.edges) if (preds.has(e.to) && preds.has(e.from)) preds.get(e.to)!.push(e.from);
  for (const a of acts) if (a.duration === undefined) return { ok: false, error: `${a.label || a.id} has no duration.`, activities: [], duration: 0, criticalPath: [] };
  // Topological order.
  const order: string[] = [];
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 1) return false;
    if (s === 2) return true;
    state.set(id, 1);
    for (const p of preds.get(id) ?? []) if (!visit(p)) return false;
    state.set(id, 2);
    order.push(id);
    return true;
  };
  for (const a of acts) if (!visit(a.id)) return { ok: false, error: 'The network has a cycle: an activity depends on itself through others.', activities: [], duration: 0, criticalPath: [] };
  const byId = new Map(acts.map((a) => [a.id, a]));
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const start = Math.max(0, ...(preds.get(id) ?? []).map((p) => ef.get(p) ?? 0));
    es.set(id, start);
    ef.set(id, start + (byId.get(id)!.duration ?? 0));
  }
  const duration = Math.max(0, ...[...ef.values()]);
  const succ = new Map<string, string[]>(acts.map((a) => [a.id, []]));
  for (const [id, ps] of preds) for (const p of ps) succ.get(p)!.push(id);
  const lf = new Map<string, number>();
  const ls = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const finish = succ.get(id)!.length ? Math.min(...succ.get(id)!.map((s) => ls.get(s)!)) : duration;
    lf.set(id, finish);
    ls.set(id, finish - (byId.get(id)!.duration ?? 0));
  }
  const activities: CpmActivity[] = acts.map((a) => {
    const slack = Math.round(((ls.get(a.id) ?? 0) - (es.get(a.id) ?? 0)) * 100) / 100;
    const variance = a.pessimistic !== undefined && a.optimistic !== undefined ? Math.pow((a.pessimistic - a.optimistic) / 6, 2) : undefined;
    return { id: a.id, label: a.label, duration: a.duration ?? 0, es: es.get(a.id)!, ef: ef.get(a.id)!, ls: ls.get(a.id)!, lf: lf.get(a.id)!, slack, critical: Math.abs(slack) < 1e-9, predecessors: preds.get(a.id) ?? [], variance };
  });
  // Critical path: walk from a critical start along critical successors.
  const critical = new Set(activities.filter((a) => a.critical).map((a) => a.id));
  const path: string[] = [];
  let cur = order.find((id) => critical.has(id) && (preds.get(id) ?? []).every((p) => !critical.has(p)));
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = succ.get(cur)!.find((s) => critical.has(s) && Math.abs((es.get(s) ?? 0) - (ef.get(cur!) ?? 0)) < 1e-9);
  }
  const variances = path.map((id) => activities.find((a) => a.id === id)?.variance).filter((v): v is number => v !== undefined);
  const sigma = variances.length === path.length && path.length ? Math.sqrt(variances.reduce((a, b) => a + b, 0)) : undefined;
  return { ok: true, activities, duration, criticalPath: path, sigma };
}
