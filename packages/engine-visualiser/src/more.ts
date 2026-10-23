/**
 * Algorithms for the later courses: finite automata, weighted and grid search, game trees,
 * sequence alignment and rule-based inference. Each records a trace the UI replays and whose
 * metrics the checks read. Tie-breaking is spelled out in each pseudocode so learners can
 * predict every step by hand.
 */

import { Recorder, registerAlgorithms, type Algorithm, type AlgorithmInput, type GameTree, type Metric, type Rule, type WeightedGraph } from './trace.js';

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/* ----------------------------------------------------------------------------- automata */

const dfa: Algorithm = {
  id: 'dfa',
  name: 'Deterministic finite automaton',
  inputKind: 'automaton',
  pseudocode: ['state = start state', 'for each symbol of the word:', '    state = δ(state, symbol)', '    if there is no transition: reject', 'accept if state is an accepting state'],
  run(input) {
    const r = new Recorder('dfa', dfa.pseudocode);
    const m = input.automaton;
    if (!m) throw new Error('This lab has no automaton.');
    const symbols = [...(input.word ?? '')];
    for (const s of symbols) if (!m.alphabet.includes(s)) throw new Error(`"${s}" is not in the alphabet {${m.alphabet.join(', ')}}.`);
    const delta = new Map(m.transitions.map(([from, sym, to]) => [`${from}|${sym}`, to]));
    let state = m.start;
    const path = [state];
    r.step(1, `Start in ${state}.`, { state }, { tape: { symbols, pos: 0 }, active: [state] });
    let dead = false;
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      r.step(2, `Read symbol ${i + 1}: ${sym}.`, { state, symbol: sym }, { tape: { symbols, pos: i }, active: [state] });
      const next = delta.get(`${state}|${sym}`);
      if (next === undefined) {
        dead = true;
        r.step(4, `No transition from ${state} on ${sym}: the word is rejected.`, { state, symbol: sym }, { tape: { symbols, pos: i }, active: [] });
        break;
      }
      r.step(3, `δ(${state}, ${sym}) = ${next}.`, { state: next, symbol: sym }, { tape: { symbols, pos: i + 1 }, active: [next] });
      state = next;
      path.push(state);
    }
    const accepted = !dead && m.accept.includes(state);
    r.step(5, dead ? 'Rejected: the machine got stuck.' : `End of the word in ${state}: ${accepted ? 'accepted' : 'rejected'}.`, { state, accepted }, { tape: { symbols, pos: symbols.length }, active: dead ? [] : [state] });
    return r.done({ accepted, final: dead ? '(stuck)' : state, path, steps: path.length - 1, length: symbols.length });
  },
};

/* ----------------------------------------------------------------------------- weighted search */

function adjacency(g: WeightedGraph): Map<string, Array<[string, number]>> {
  const adj = new Map<string, Array<[string, number]>>(g.nodes.map((n) => [n, []]));
  for (const [a, b, w] of g.edges) {
    adj.get(a)?.push([b, w]);
    adj.get(b)?.push([a, w]);
  }
  for (const [, list] of adj) list.sort((x, y) => byName(x[0], y[0]));
  return adj;
}

function bestFirst(id: string, pseudocode: string[], useH: boolean, input: AlgorithmInput) {
  const r = new Recorder(id, pseudocode);
  const g = input.weighted;
  if (!g) throw new Error('This lab has no weighted graph.');
  const start = input.start ?? g.nodes[0];
  const goal = input.goal;
  const adj = adjacency(g);
  if (!adj.has(start)) throw new Error(`"${start}" is not a node of the graph.`);
  if (goal !== undefined && !adj.has(goal)) throw new Error(`"${goal}" is not a node of the graph.`);
  const h = (n: string) => (useH ? g.heuristic?.[n] ?? 0 : 0);
  const dist: Record<string, number> = { [start]: 0 };
  const parent: Record<string, string> = {};
  const open = new Set([start]);
  const closed: string[] = [];
  const labels = () => Object.fromEntries(Object.entries(dist).map(([n, d]) => [n, useH ? `${d}+${h(n)}` : String(d)]));
  const pathTo = (n: string) => {
    const p = [n];
    while (parent[p[0]]) p.unshift(parent[p[0]]);
    return p;
  };
  r.step(1, useH ? `Start at ${start}: g = 0, h = ${h(start)}.` : `Start at ${start} with distance 0.`, { start }, { visited: closed, frontier: [...open], current: start, labels: labels() });
  let reached = false;
  while (open.size) {
    const node = [...open].sort((a, b) => dist[a] + h(a) - (dist[b] + h(b)) || h(a) - h(b) || byName(a, b))[0];
    open.delete(node);
    closed.push(node);
    r.step(
      3,
      useH ? `Expand ${node}: f = ${dist[node]} + ${h(node)} = ${dist[node] + h(node)}, the smallest in the open set.` : `Expand ${node}: distance ${dist[node]}, the smallest not yet expanded.`,
      { node, g: dist[node], ...(useH ? { h: h(node), f: dist[node] + h(node) } : {}) },
      { visited: closed, frontier: [...open], current: node, labels: labels(), path: pathTo(node) },
    );
    if (node === goal) {
      reached = true;
      r.step(4, `${node} is the goal. Cost ${dist[node]}: ${pathTo(node).join(' → ')}.`, { node, cost: dist[node] }, { visited: closed, frontier: [...open], current: node, labels: labels(), path: pathTo(node) });
      break;
    }
    for (const [nb, w] of adj.get(node) ?? []) {
      if (closed.includes(nb)) continue;
      const ng = dist[node] + w;
      if (!(nb in dist) || ng < dist[nb]) {
        const was = dist[nb];
        dist[nb] = ng;
        parent[nb] = node;
        open.add(nb);
        r.step(6, was === undefined ? `${nb}: reached for the first time with ${useH ? 'g' : 'distance'} ${ng}.` : `${nb}: better route via ${node}, ${was} becomes ${ng}.`, { node, neighbour: nb, cost: w, g: ng }, { visited: closed, frontier: [...open], current: node, labels: labels() });
      } else {
        r.step(5, `${nb}: ${ng} via ${node} is no better than ${dist[nb]}.`, { node, neighbour: nb, cost: w }, { visited: closed, frontier: [...open], current: node, labels: labels() });
      }
    }
  }
  const metrics: Record<string, Metric> = { order: closed, expanded: closed.length, reached };
  if (goal !== undefined && reached) {
    metrics.distance = dist[goal];
    metrics.path = pathTo(goal);
  }
  for (const [n, d] of Object.entries(dist)) {
    metrics[`g:${n}`] = d;
    if (useH) metrics[`f:${n}`] = d + h(n);
  }
  return r.done(metrics);
}

const dijkstra: Algorithm = {
  id: 'dijkstra',
  name: 'Uniform-cost search (Dijkstra)',
  inputKind: 'weighted',
  pseudocode: [
    'open = {start}, d(start) = 0',
    'while open is not empty:',
    '    node = open node with the smallest d (ties: alphabetical)',
    '    if node is the goal: stop',
    '    for each neighbour not yet expanded (alphabetical):',
    '        if d(node) + cost < d(neighbour): update d, parent, add to open',
  ],
  run: (input) => bestFirst('dijkstra', dijkstra.pseudocode, false, input),
};

const astar: Algorithm = {
  id: 'astar',
  name: 'A* search',
  inputKind: 'weighted',
  pseudocode: [
    'open = {start}, g(start) = 0',
    'while open is not empty:',
    '    node = open node with the smallest f = g + h (ties: smaller h, then alphabetical)',
    '    if node is the goal: stop',
    '    for each neighbour not yet expanded (alphabetical):',
    '        if g(node) + cost < g(neighbour): update g, parent, add to open',
  ],
  run: (input) => bestFirst('astar', astar.pseudocode, true, input),
};

/* ----------------------------------------------------------------------------- grid search */

interface GridInfo {
  rows: string[];
  free: (r: number, c: number) => boolean;
  start: [number, number];
  goal: [number, number];
}

export function readGrid(rowsIn: string[] | undefined): GridInfo {
  const rows = (rowsIn ?? []).map((r) => r.replace(/\s+/g, ''));
  if (!rows.length) throw new Error('This lab has no grid.');
  let start: [number, number] | null = null;
  let goal: [number, number] | null = null;
  rows.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      if (ch === 'S') start = [r, c];
      if (ch === 'G') goal = [r, c];
    }),
  );
  if (!start || !goal) throw new Error('The grid needs one S (start) and one G (goal).');
  return { rows, free: (r, c) => r >= 0 && c >= 0 && r < rows.length && c < rows[r].length && rows[r][c] !== '#', start, goal };
}

const key = (r: number, c: number) => `${r},${c}`;
const unkey = (k: string): [number, number] => k.split(',').map(Number) as [number, number];
/** Up, right, down, left. */
const MOVES: Array<[number, number]> = [
  [-1, 0],
  [0, 1],
  [1, 0],
  [0, -1],
];

function gridSearch(id: string, pseudocode: string[], informed: boolean, gridRows: string[] | undefined) {
  const r = new Recorder(id, pseudocode);
  const g = readGrid(gridRows);
  const s = key(...g.start);
  const goal = key(...g.goal);
  const h = (k: string) => {
    const [a, b] = unkey(k);
    return informed ? Math.abs(a - g.goal[0]) + Math.abs(b - g.goal[1]) : 0;
  };
  const dist: Record<string, number> = { [s]: 0 };
  const parent: Record<string, string> = {};
  const open: string[] = [s];
  const closed: string[] = [];
  const pathTo = (k: string) => {
    const p = [k];
    while (parent[p[0]]) p.unshift(parent[p[0]]);
    return p;
  };
  r.step(1, `Start at ${s}.`, { start: s }, { visited: closed, frontier: open, current: s });
  let reached = false;
  while (open.length) {
    if (informed) {
      open.sort((a, b) => {
        const [ar, ac] = unkey(a);
        const [br, bc] = unkey(b);
        return dist[a] + h(a) - (dist[b] + h(b)) || h(a) - h(b) || ar - br || ac - bc;
      });
    }
    const node = open.shift()!;
    closed.push(node);
    r.step(3, informed ? `Expand ${node}: f = ${dist[node]} + ${h(node)} = ${dist[node] + h(node)}.` : `Expand ${node} (distance ${dist[node]}).`, { node, g: dist[node], ...(informed ? { h: h(node) } : {}) }, { visited: closed, frontier: open, current: node });
    if (node === goal) {
      reached = true;
      r.step(4, `Goal reached in ${dist[node]} moves after expanding ${closed.length} cells.`, { node, moves: dist[node] }, { visited: closed, frontier: open, current: node, path: pathTo(node) });
      break;
    }
    const [nr, nc] = unkey(node);
    for (const [dr, dc] of MOVES) {
      const rr = nr + dr;
      const cc = nc + dc;
      if (!g.free(rr, cc)) continue;
      const k = key(rr, cc);
      if (closed.includes(k)) continue;
      const ng = dist[node] + 1;
      if (!(k in dist) || ng < dist[k]) {
        dist[k] = ng;
        parent[k] = node;
        if (!open.includes(k)) open.push(k);
        r.step(5, `Add ${k} with ${informed ? `g = ${ng}, h = ${h(k)}` : `distance ${ng}`}.`, { node, neighbour: k, g: ng }, { visited: closed, frontier: open, current: node });
      }
    }
  }
  const metrics: Record<string, Metric> = { expanded: closed.length, reached, order: closed };
  if (reached) {
    metrics.pathLength = dist[goal];
    metrics.path = pathTo(goal);
  }
  return r.done(metrics);
}

const gridBfs: Algorithm = {
  id: 'gridBfs',
  name: 'Breadth-first search on a grid',
  inputKind: 'grid',
  pseudocode: [
    'queue = [start]',
    'while queue is not empty:',
    '    cell = remove the front of the queue',
    '    if cell is the goal: stop',
    '    for each free neighbour (up, right, down, left) not seen: record parent, add to the back',
  ],
  run: (input) => gridSearch('gridBfs', gridBfs.pseudocode, false, input.grid),
};

const gridAstar: Algorithm = {
  id: 'gridAstar',
  name: 'A* on a grid (Manhattan distance)',
  inputKind: 'grid',
  pseudocode: [
    'open = [start], g(start) = 0, h = Manhattan distance to the goal',
    'while open is not empty:',
    '    cell = open cell with the smallest f = g + h (ties: smaller h, then top row, then left column)',
    '    if cell is the goal: stop',
    '    for each free neighbour (up, right, down, left) not expanded: if g + 1 is better, record it',
  ],
  run: (input) => gridSearch('gridAstar', gridAstar.pseudocode, true, input.grid),
};

/* ----------------------------------------------------------------------------- game trees */

function leafNames(n: GameTree): string[] {
  return n.children?.length ? n.children.flatMap(leafNames) : [n.name];
}

const minimax: Algorithm = {
  id: 'minimax',
  name: 'Minimax',
  inputKind: 'tree',
  pseudocode: ['minimax(node, max to move):', '    if node is a leaf: return its value', '    for each child, left to right: value = minimax(child, other player)', '    MAX takes the largest child value, MIN the smallest'],
  run(input) {
    const r = new Recorder('minimax', minimax.pseudocode);
    const tree = input.tree;
    if (!tree) throw new Error('This lab has no game tree.');
    const labels: Record<string, string> = {};
    const evaluated: string[] = [];
    const values: Record<string, number> = {};
    const visit = (n: GameTree, isMax: boolean): number => {
      if (!n.children?.length) {
        const v = n.value ?? 0;
        evaluated.push(n.name);
        labels[n.name] = String(v);
        values[n.name] = v;
        r.step(2, `Leaf ${n.name} is worth ${v}.`, { node: n.name, value: v }, { visited: evaluated, current: n.name, labels });
        return v;
      }
      let best = isMax ? -Infinity : Infinity;
      for (const c of n.children) {
        const v = visit(c, !isMax);
        best = isMax ? Math.max(best, v) : Math.min(best, v);
        labels[n.name] = String(best);
        r.step(3, `${n.name} (${isMax ? 'MAX' : 'MIN'}) has seen ${c.name} = ${v}; its value so far is ${best}.`, { node: n.name, child: c.name, value: best }, { visited: evaluated, current: n.name, labels });
      }
      values[n.name] = best;
      r.step(4, `${n.name} (${isMax ? 'MAX' : 'MIN'}) is worth ${best}.`, { node: n.name, value: best }, { visited: evaluated, current: n.name, labels });
      return best;
    };
    const value = visit(tree, true);
    const best = tree.children?.find((c) => values[c.name] === value)?.name ?? tree.name;
    const metrics: Record<string, Metric> = { value, best, evaluated: evaluated.length, pruned: [], prunedCount: 0 };
    for (const [n, v] of Object.entries(values)) metrics[`value:${n}`] = v;
    return r.done(metrics);
  },
};

const alphabeta: Algorithm = {
  id: 'alphabeta',
  name: 'Alpha-beta pruning',
  inputKind: 'tree',
  pseudocode: [
    'alphabeta(node, α, β, max to move):',
    '    if node is a leaf: return its value',
    '    MAX: for each child: v = max(v, alphabeta(child)); α = max(α, v)',
    '    MIN: for each child: v = min(v, alphabeta(child)); β = min(β, v)',
    '    if α ≥ β: skip the remaining children (prune)',
  ],
  run(input) {
    const r = new Recorder('alphabeta', alphabeta.pseudocode);
    const tree = input.tree;
    if (!tree) throw new Error('This lab has no game tree.');
    const labels: Record<string, string> = {};
    const evaluated: string[] = [];
    const pruned: string[] = [];
    let best = tree.name;
    const fmt = (x: number) => (x === Infinity ? '+∞' : x === -Infinity ? '−∞' : String(x));
    const visit = (n: GameTree, alphaIn: number, betaIn: number, isMax: boolean, isRoot: boolean): number => {
      let alpha = alphaIn;
      let beta = betaIn;
      if (!n.children?.length) {
        const v = n.value ?? 0;
        evaluated.push(n.name);
        labels[n.name] = String(v);
        r.step(2, `Leaf ${n.name} is worth ${v}.`, { node: n.name, value: v, α: fmt(alpha), β: fmt(beta) }, { visited: evaluated, pruned, current: n.name, labels });
        return v;
      }
      let v = isMax ? -Infinity : Infinity;
      const kids = n.children;
      for (let i = 0; i < kids.length; i++) {
        const cv = visit(kids[i], alpha, beta, !isMax, false);
        if (isMax) {
          if (cv > v && isRoot) best = kids[i].name;
          v = Math.max(v, cv);
          alpha = Math.max(alpha, v);
        } else {
          v = Math.min(v, cv);
          beta = Math.min(beta, v);
        }
        labels[n.name] = String(v);
        r.step(isMax ? 3 : 4, `${n.name} (${isMax ? 'MAX' : 'MIN'}) after ${kids[i].name}: v = ${v}, α = ${fmt(alpha)}, β = ${fmt(beta)}.`, { node: n.name, v, α: fmt(alpha), β: fmt(beta) }, { visited: evaluated, pruned, current: n.name, labels });
        if (alpha >= beta && i < kids.length - 1) {
          const skipped = kids.slice(i + 1).flatMap(leafNames);
          pruned.push(...skipped);
          r.step(5, `α ≥ β at ${n.name}: prune ${skipped.join(', ')}.`, { node: n.name, α: fmt(alpha), β: fmt(beta) }, { visited: evaluated, pruned, current: n.name, labels });
          break;
        }
      }
      return v;
    };
    const value = visit(tree, -Infinity, Infinity, true, true);
    return r.done({ value, best, evaluated: evaluated.length, pruned, prunedCount: pruned.length });
  },
};

/* ----------------------------------------------------------------------------- alignment */

const needlemanWunsch: Algorithm = {
  id: 'needlemanWunsch',
  name: 'Needleman-Wunsch global alignment',
  inputKind: 'alignment',
  pseudocode: [
    'F[i][0] = i × gap, F[0][j] = j × gap',
    'for each cell (i, j), row by row:',
    '    F[i][j] = max(F[i-1][j-1] + s(a_i, b_j), F[i-1][j] + gap, F[i][j-1] + gap)',
    'trace back from the bottom-right corner (prefer diagonal, then up, then left)',
  ],
  run(input) {
    const r = new Recorder('needlemanWunsch', needlemanWunsch.pseudocode);
    const a = (input.seqA ?? '').toUpperCase();
    const b = (input.seqB ?? '').toUpperCase();
    if (!a || !b) throw new Error('This lab needs two sequences.');
    if (a.length > 20 || b.length > 20) throw new Error('Use sequences of at most 20 letters each.');
    const { match, mismatch, gap } = input.scoring ?? { match: 1, mismatch: -1, gap: -2 };
    const n = a.length;
    const m = b.length;
    const F: Array<Array<number | null>> = Array.from({ length: n + 1 }, () => Array<number | null>(m + 1).fill(null));
    for (let i = 0; i <= n; i++) F[i][0] = i * gap;
    for (let j = 0; j <= m; j++) F[0][j] = j * gap;
    r.step(1, `First row and column: multiples of the gap penalty ${gap}.`, { gap }, { cells: F });
    const score = (i: number, j: number) => (a[i - 1] === b[j - 1] ? match : mismatch);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const diag = (F[i - 1][j - 1] as number) + score(i, j);
        const up = (F[i - 1][j] as number) + gap;
        const left = (F[i][j - 1] as number) + gap;
        F[i][j] = Math.max(diag, up, left);
        r.step(3, `F[${i}][${j}]: ${a[i - 1]} vs ${b[j - 1]} → max(${diag}, ${up}, ${left}) = ${F[i][j]}.`, { i, j, diag, up, left, value: F[i][j] }, { cells: F, cell: [i, j] });
      }
    }
    let i = n;
    let j = m;
    let alignA = '';
    let alignB = '';
    const path = [key(i, j)];
    while (i > 0 || j > 0) {
      const here = F[i][j] as number;
      if (i > 0 && j > 0 && here === (F[i - 1][j - 1] as number) + score(i, j)) {
        alignA = a[i - 1] + alignA;
        alignB = b[j - 1] + alignB;
        i--;
        j--;
      } else if (i > 0 && here === (F[i - 1][j] as number) + gap) {
        alignA = a[i - 1] + alignA;
        alignB = '-' + alignB;
        i--;
      } else {
        alignA = '-' + alignA;
        alignB = b[j - 1] + alignB;
        j--;
      }
      path.unshift(key(i, j));
      r.step(4, `Trace back to (${i}, ${j}).`, { i, j, alignA, alignB }, { cells: F, cell: [i, j], path });
    }
    let matches = 0;
    let gaps = 0;
    for (let k = 0; k < alignA.length; k++) {
      if (alignA[k] === '-' || alignB[k] === '-') gaps++;
      else if (alignA[k] === alignB[k]) matches++;
    }
    const metrics: Record<string, Metric> = { score: F[n][m] as number, alignA, alignB, matches, gaps, mismatches: alignA.length - matches - gaps };
    for (let x = 0; x <= n; x++) for (let y = 0; y <= m; y++) metrics[`cell:${x},${y}`] = F[x][y] as number;
    return r.done(metrics);
  },
};

/* ----------------------------------------------------------------------------- rules */

const ruleName = (rule: Rule, i: number) => rule.name ?? `R${i + 1}`;

const forwardChaining: Algorithm = {
  id: 'forwardChaining',
  name: 'Forward chaining',
  inputKind: 'rules',
  pseudocode: [
    'known = the starting facts',
    'scan the rules from the top:',
    '    if every premise is known and the conclusion is new:',
    '        add the conclusion; stop if it is the goal; scan again from the top',
    'stop when a full scan fires no rule',
  ],
  run(input) {
    const r = new Recorder('forwardChaining', forwardChaining.pseudocode);
    const rules = input.rules ?? [];
    const known = [...(input.facts ?? [])];
    const derived: string[] = [];
    const fired: string[] = [];
    r.step(1, `Start with ${known.length} facts.`, { facts: known.length }, { known });
    let goalReached = input.goal !== undefined && known.includes(input.goal);
    while (!goalReached) {
      let any = false;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        const ok = rule.if.every((p) => known.includes(p));
        if (ok && !known.includes(rule.then)) {
          known.push(rule.then);
          derived.push(rule.then);
          fired.push(ruleName(rule, i));
          r.step(4, `${ruleName(rule, i)} fires: ${rule.if.join(' and ')} gives ${rule.then}.`, { rule: ruleName(rule, i), derived: rule.then }, { known, rule: i });
          any = true;
          if (rule.then === input.goal) goalReached = true;
          break;
        }
        r.step(3, ok ? `${ruleName(rule, i)}: ${rule.then} is already known.` : `${ruleName(rule, i)}: not every premise is known.`, { rule: ruleName(rule, i) }, { known, rule: i });
      }
      if (!any) break;
    }
    r.step(5, goalReached ? `The goal ${input.goal} is derived.` : 'No rule can fire: stop.', { goalReached }, { known });
    return r.done({ derived, newFacts: derived.length, rulesFired: fired, firings: fired.length, goalReached, known });
  },
};

const backwardChaining: Algorithm = {
  id: 'backwardChaining',
  name: 'Backward chaining',
  inputKind: 'rules',
  pseudocode: ['prove(goal):', '    if goal is a known fact: true', '    for each rule that concludes goal, top to bottom:', '        if prove(premise) for every premise, in order: add goal, true', '    otherwise: false'],
  run(input) {
    const r = new Recorder('backwardChaining', backwardChaining.pseudocode);
    const rules = input.rules ?? [];
    const known = [...(input.facts ?? [])];
    const asked: string[] = [];
    const used: string[] = [];
    const added: string[] = [];
    if (!input.goal) throw new Error('Backward chaining needs a goal.');
    const prove = (g: string, stack: string[]): boolean => {
      asked.push(g);
      r.step(1, `Can we prove ${g}?`, { goal: g, depth: stack.length }, { known, current: g });
      if (known.includes(g)) {
        r.step(2, `${g} is a known fact.`, { goal: g }, { known, current: g });
        return true;
      }
      if (stack.includes(g)) return false;
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule.then !== g) continue;
        r.step(3, `Try ${ruleName(rule, i)}: ${rule.if.join(' and ')} would give ${g}.`, { goal: g, rule: ruleName(rule, i) }, { known, rule: i, current: g });
        if (rule.if.every((p) => prove(p, [...stack, g]))) {
          known.push(g);
          added.push(g);
          used.push(ruleName(rule, i));
          r.step(4, `${ruleName(rule, i)} proves ${g}.`, { goal: g, rule: ruleName(rule, i) }, { known, rule: i, current: g });
          return true;
        }
      }
      r.step(5, `${g} cannot be proved.`, { goal: g }, { known, current: g });
      return false;
    };
    const proved = prove(input.goal, []);
    return r.done({ proved, asked, askedCount: asked.length, rulesUsed: used, newFacts: added.length, derived: added });
  },
};

export const MORE_ALGORITHMS: Algorithm[] = [dfa, dijkstra, astar, gridBfs, gridAstar, minimax, alphabeta, needlemanWunsch, forwardChaining, backwardChaining];
registerAlgorithms(MORE_ALGORITHMS);
