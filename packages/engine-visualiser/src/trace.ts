/**
 * Algorithms that record a trace: one step per executed pseudocode line, with the variables,
 * the data structure and what to highlight. The UI replays the trace; the checks read it.
 */

export interface Highlights {
  /** Indices being compared. */
  compare?: number[];
  /** Indices just swapped or written. */
  swap?: number[];
  /** Indices known to be in final position. */
  sorted?: number[];
  /** The current index of interest (i, or the key being inserted). */
  current?: number[];
  /** The index where the target was found. */
  found?: number[];
  /** Inclusive search range [low, high]. */
  range?: [number, number];
}

export interface Step {
  /** 1-based pseudocode line. */
  line: number;
  note: string;
  vars: Record<string, unknown>;
  values?: number[];
  highlights?: Highlights;
  stack?: number[];
  queue?: number[];
  visited?: string[];
  frontier?: string[];
  current?: string;
  /** Automata: the input word and the read position. */
  tape?: { symbols: string[]; pos: number };
  /** Automata: the state(s) the machine is in. */
  active?: string[];
  /** Text shown next to a node (distances, f = g + h, minimax values). */
  labels?: Record<string, string>;
  /** Dynamic-programming matrix, row by row. */
  cells?: Array<Array<string | number | null>>;
  /** The matrix cell being filled, [row, column]. */
  cell?: [number, number];
  /** Nodes or cells ("r,c") on the path found so far. */
  path?: string[];
  /** Rules: facts known so far. */
  known?: string[];
  /** Rules: index of the rule being considered. */
  rule?: number;
  /** Game trees: leaves skipped by pruning. */
  pruned?: string[];
}

export type Metric = number | boolean | string | number[] | string[];

export interface Trace {
  algorithm: string;
  pseudocode: string[];
  steps: Step[];
  metrics: Record<string, Metric>;
}

export interface Graph {
  nodes: string[];
  edges: Array<[string, string]>;
}

export interface Automaton {
  states: string[];
  alphabet: string[];
  start: string;
  accept: string[];
  transitions: Array<[string, string, string]>;
}

export interface WeightedGraph {
  nodes: string[];
  edges: Array<[string, string, number]>;
  /** Estimated cost from each node to the goal, for A*. */
  heuristic?: Record<string, number>;
  /** Optional positions in [0, 1] x [0, 1] for drawing. */
  layout?: Record<string, [number, number]>;
}

export interface GameTree {
  name: string;
  value?: number;
  children?: GameTree[];
}

export interface Rule {
  name?: string;
  if: string[];
  then: string;
}

export interface AlgorithmInput {
  values?: number[];
  target?: number;
  /** For stack and queue: "add 5" or "remove", one per line. */
  ops?: string[];
  graph?: Graph;
  start?: string;
  automaton?: Automaton;
  word?: string;
  weighted?: WeightedGraph;
  goal?: string;
  /** Grid rows: "." free, "#" wall, "S" start, "G" goal. */
  grid?: string[];
  tree?: GameTree;
  seqA?: string;
  seqB?: string;
  scoring?: { match: number; mismatch: number; gap: number };
  facts?: string[];
  rules?: Rule[];
}

export type InputKind = 'values' | 'values+target' | 'ops' | 'graph' | 'automaton' | 'weighted' | 'grid' | 'tree' | 'alignment' | 'rules';

export interface Algorithm {
  id: string;
  name: string;
  inputKind: InputKind;
  pseudocode: string[];
  run(input: AlgorithmInput): Trace;
}

const MAX_STEPS = 2000;

export class Recorder {
  steps: Step[] = [];
  constructor(
    private readonly algorithm: string,
    private readonly pseudocode: string[],
  ) {}
  step(line: number, note: string, vars: Record<string, unknown>, extra: Omit<Step, 'line' | 'note' | 'vars'> = {}): void {
    if (this.steps.length >= MAX_STEPS) throw new Error('The trace is too long; use a smaller input.');
    const copy: Step = { line, note, vars: { ...vars }, ...extra };
    if (extra.values) copy.values = [...extra.values];
    if (extra.stack) copy.stack = [...extra.stack];
    if (extra.queue) copy.queue = [...extra.queue];
    if (extra.visited) copy.visited = [...extra.visited];
    if (extra.frontier) copy.frontier = [...extra.frontier];
    if (extra.active) copy.active = [...extra.active];
    if (extra.path) copy.path = [...extra.path];
    if (extra.known) copy.known = [...extra.known];
    if (extra.pruned) copy.pruned = [...extra.pruned];
    if (extra.labels) copy.labels = { ...extra.labels };
    if (extra.cells) copy.cells = extra.cells.map((row) => [...row]);
    if (extra.tape) copy.tape = { symbols: [...extra.tape.symbols], pos: extra.tape.pos };
    this.steps.push(copy);
  }
  done(metrics: Record<string, Metric>): Trace {
    return { algorithm: this.algorithm, pseudocode: this.pseudocode, steps: this.steps, metrics };
  }
}

function values(input: AlgorithmInput): number[] {
  return (input.values ?? []).slice();
}

/* ----------------------------------------------------------------------------- searching */

const linearSearch: Algorithm = {
  id: 'linearSearch',
  name: 'Linear search',
  inputKind: 'values+target',
  pseudocode: ['for i from 0 to n - 1:', '    if values[i] == target:', '        return i', 'return -1'],
  run(input) {
    const r = new Recorder('linearSearch', linearSearch.pseudocode);
    const v = values(input);
    const target = input.target ?? 0;
    let comparisons = 0;
    for (let i = 0; i < v.length; i++) {
      r.step(1, `Look at position ${i}.`, { i, target }, { values: v, highlights: { current: [i] } });
      comparisons++;
      const hit = v[i] === target;
      r.step(2, `Is ${v[i]} equal to ${target}? ${hit ? 'Yes.' : 'No.'}`, { i, target, comparisons }, { values: v, highlights: { compare: [i] } });
      if (hit) {
        r.step(3, `Found ${target} at index ${i}.`, { i, target, comparisons }, { values: v, highlights: { found: [i] } });
        return r.done({ comparisons, index: i, found: true });
      }
    }
    r.step(4, `${target} is not in the list.`, { target, comparisons }, { values: v });
    return r.done({ comparisons, index: -1, found: false });
  },
};

const binarySearch: Algorithm = {
  id: 'binarySearch',
  name: 'Binary search (sorted list)',
  inputKind: 'values+target',
  pseudocode: [
    'low = 0, high = n - 1',
    'while low <= high:',
    '    mid = (low + high) // 2',
    '    if values[mid] == target:',
    '        return mid',
    '    else if values[mid] < target:',
    '        low = mid + 1',
    '    else:',
    '        high = mid - 1',
    'return -1',
  ],
  run(input) {
    const r = new Recorder('binarySearch', binarySearch.pseudocode);
    const v = values(input);
    const target = input.target ?? 0;
    let low = 0;
    let high = v.length - 1;
    let comparisons = 0;
    let iterations = 0;
    r.step(1, `Search between positions ${low} and ${high}.`, { low, high, target }, { values: v, highlights: { range: [low, high] } });
    while (low <= high) {
      iterations++;
      r.step(2, `low (${low}) is not above high (${high}), keep going.`, { low, high, target, comparisons }, { values: v, highlights: { range: [low, high] } });
      const mid = Math.floor((low + high) / 2);
      r.step(3, `The middle is position ${mid}, value ${v[mid]}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: [low, high], current: [mid] } });
      comparisons++;
      if (v[mid] === target) {
        r.step(4, `${v[mid]} equals ${target}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: [low, high], compare: [mid] } });
        r.step(5, `Found ${target} at index ${mid} after ${comparisons} comparison${comparisons === 1 ? '' : 's'}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { found: [mid] } });
        return r.done({ comparisons, iterations, index: mid, found: true });
      }
      r.step(4, `${v[mid]} is not ${target}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: [low, high], compare: [mid] } });
      if (v[mid] < target) {
        r.step(6, `${v[mid]} is less than ${target}: the target must be to the right.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: [low, high], compare: [mid] } });
        low = mid + 1;
        r.step(7, `low becomes ${low}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: low <= high ? [low, high] : undefined } });
      } else {
        r.step(8, `${v[mid]} is greater than ${target}: the target must be to the left.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: [low, high], compare: [mid] } });
        high = mid - 1;
        r.step(9, `high becomes ${high}.`, { low, high, mid, target, comparisons }, { values: v, highlights: { range: low <= high ? [low, high] : undefined } });
      }
    }
    r.step(10, `low (${low}) is above high (${high}): ${target} is not in the list.`, { low, high, target, comparisons }, { values: v });
    return r.done({ comparisons, iterations, index: -1, found: false });
  },
};

/* ----------------------------------------------------------------------------- sorting */

const bubbleSort: Algorithm = {
  id: 'bubbleSort',
  name: 'Bubble sort',
  inputKind: 'values',
  pseudocode: [
    'for pass from 1 to n - 1:',
    '    swapped = false',
    '    for j from 0 to n - pass - 1:',
    '        if values[j] > values[j + 1]:',
    '            swap values[j] and values[j + 1]',
    '            swapped = true',
    '    if not swapped: stop early',
  ],
  run(input) {
    const r = new Recorder('bubbleSort', bubbleSort.pseudocode);
    const v = values(input);
    const n = v.length;
    let comparisons = 0;
    let swaps = 0;
    let passes = 0;
    const sorted: number[] = [];
    for (let pass = 1; pass <= n - 1; pass++) {
      passes = pass;
      let swapped = false;
      r.step(1, `Pass ${pass} of at most ${n - 1}.`, { pass, swaps, comparisons }, { values: v, highlights: { sorted } });
      r.step(2, 'No swaps yet in this pass.', { pass, swapped, swaps, comparisons }, { values: v, highlights: { sorted } });
      for (let j = 0; j <= n - pass - 1; j++) {
        comparisons++;
        const bigger = v[j] > v[j + 1];
        r.step(4, `Compare ${v[j]} and ${v[j + 1]}: ${bigger ? 'out of order, swap' : 'in order'}.`, { pass, j, swapped, swaps, comparisons }, { values: v, highlights: { compare: [j, j + 1], sorted } });
        if (bigger) {
          [v[j], v[j + 1]] = [v[j + 1], v[j]];
          swaps++;
          swapped = true;
          r.step(5, `Swapped: now ${v[j]}, ${v[j + 1]}.`, { pass, j, swapped, swaps, comparisons }, { values: v, highlights: { swap: [j, j + 1], sorted } });
        }
      }
      sorted.unshift(n - pass);
      if (!swapped) {
        r.step(7, `No swaps in pass ${pass}: the list is sorted.`, { pass, swapped, swaps, comparisons }, { values: v, highlights: { sorted: v.map((_, i) => i) } });
        return r.done({ comparisons, swaps, passes, values: v });
      }
      r.step(7, `Pass ${pass} done: ${v[n - pass]} is in its final place.`, { pass, swapped, swaps, comparisons }, { values: v, highlights: { sorted } });
    }
    r.step(7, 'All passes done: the list is sorted.', { swaps, comparisons, passes }, { values: v, highlights: { sorted: v.map((_, i) => i) } });
    return r.done({ comparisons, swaps, passes, values: v });
  },
};

const selectionSort: Algorithm = {
  id: 'selectionSort',
  name: 'Selection sort',
  inputKind: 'values',
  pseudocode: [
    'for i from 0 to n - 2:',
    '    minIndex = i',
    '    for j from i + 1 to n - 1:',
    '        if values[j] < values[minIndex]:',
    '            minIndex = j',
    '    swap values[i] and values[minIndex]',
  ],
  run(input) {
    const r = new Recorder('selectionSort', selectionSort.pseudocode);
    const v = values(input);
    const n = v.length;
    let comparisons = 0;
    let swaps = 0;
    const sorted: number[] = [];
    for (let i = 0; i <= n - 2; i++) {
      r.step(1, `Find the smallest value from position ${i} onward.`, { i, swaps, comparisons }, { values: v, highlights: { current: [i], sorted } });
      let minIndex = i;
      r.step(2, `Assume position ${i} (value ${v[i]}) is the smallest.`, { i, minIndex, swaps, comparisons }, { values: v, highlights: { current: [minIndex], sorted } });
      for (let j = i + 1; j < n; j++) {
        comparisons++;
        const smaller = v[j] < v[minIndex];
        r.step(4, `Is ${v[j]} smaller than ${v[minIndex]}? ${smaller ? 'Yes.' : 'No.'}`, { i, j, minIndex, swaps, comparisons }, { values: v, highlights: { compare: [j, minIndex], sorted } });
        if (smaller) {
          minIndex = j;
          r.step(5, `New smallest at position ${j}.`, { i, j, minIndex, swaps, comparisons }, { values: v, highlights: { current: [minIndex], sorted } });
        }
      }
      if (minIndex !== i) {
        [v[i], v[minIndex]] = [v[minIndex], v[i]];
        swaps++;
        r.step(6, `Swap ${v[minIndex]} and ${v[i]}: ${v[i]} is now in place.`, { i, minIndex, swaps, comparisons }, { values: v, highlights: { swap: [i, minIndex], sorted } });
      } else {
        r.step(6, `${v[i]} is already the smallest: no swap needed.`, { i, minIndex, swaps, comparisons }, { values: v, highlights: { current: [i], sorted } });
      }
      sorted.push(i);
    }
    r.step(6, 'Done: the list is sorted.', { swaps, comparisons }, { values: v, highlights: { sorted: v.map((_, i) => i) } });
    return r.done({ comparisons, swaps, values: v });
  },
};

const insertionSort: Algorithm = {
  id: 'insertionSort',
  name: 'Insertion sort',
  inputKind: 'values',
  pseudocode: [
    'for i from 1 to n - 1:',
    '    key = values[i], j = i - 1',
    '    while j >= 0 and values[j] > key:',
    '        values[j + 1] = values[j]   (shift right)',
    '        j = j - 1',
    '    values[j + 1] = key',
  ],
  run(input) {
    const r = new Recorder('insertionSort', insertionSort.pseudocode);
    const v = values(input);
    const n = v.length;
    let comparisons = 0;
    let shifts = 0;
    for (let i = 1; i < n; i++) {
      r.step(1, `Insert the value at position ${i} into the sorted part on its left.`, { i, shifts, comparisons }, { values: v, highlights: { current: [i], sorted: v.slice(0, i).map((_, k) => k) } });
      const key = v[i];
      let j = i - 1;
      r.step(2, `key = ${key}, start comparing from position ${j}.`, { i, key, j, shifts, comparisons }, { values: v, highlights: { current: [i], sorted: v.slice(0, i).map((_, k) => k) } });
      while (j >= 0) {
        comparisons++;
        const bigger = v[j] > key;
        r.step(3, `Is ${v[j]} greater than ${key}? ${bigger ? 'Yes, shift it right.' : 'No, stop.'}`, { i, key, j, shifts, comparisons }, { values: v, highlights: { compare: [j], current: [j + 1] } });
        if (!bigger) break;
        v[j + 1] = v[j];
        shifts++;
        r.step(4, `Shift ${v[j]} to position ${j + 1}.`, { i, key, j, shifts, comparisons }, { values: v, highlights: { swap: [j + 1] } });
        j--;
        r.step(5, `j becomes ${j}.`, { i, key, j, shifts, comparisons }, { values: v });
      }
      v[j + 1] = key;
      r.step(6, `Place ${key} at position ${j + 1}.`, { i, key, j, shifts, comparisons }, { values: v, highlights: { swap: [j + 1], sorted: v.slice(0, i + 1).map((_, k) => k) } });
    }
    r.step(6, 'Done: the list is sorted.', { shifts, comparisons }, { values: v, highlights: { sorted: v.map((_, i) => i) } });
    return r.done({ comparisons, shifts, values: v });
  },
};

/* ----------------------------------------------------------------------------- stack and queue */

function parseOps(ops: string[] | undefined): Array<{ op: 'add' | 'remove' | 'peek'; value?: number; raw: string }> {
  return (ops ?? [])
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const m = /^(add|push|enqueue|insert)\s+(-?\d+)$/i.exec(raw);
      if (m) return { op: 'add' as const, value: Number(m[2]), raw };
      if (/^(remove|pop|dequeue|delete)$/i.test(raw)) return { op: 'remove' as const, raw };
      if (/^(peek|top|front)$/i.test(raw)) return { op: 'peek' as const, raw };
      throw new Error(`Cannot understand the operation "${raw}". Use "add 5", "remove" or "peek".`);
    });
}

const stackOps: Algorithm = {
  id: 'stack',
  name: 'Stack (last in, first out)',
  inputKind: 'ops',
  pseudocode: ['read the next operation', 'add x: put x on top of the stack', 'remove: take the top item off (error if empty)', 'peek: look at the top item without removing it'],
  run(input) {
    const r = new Recorder('stack', stackOps.pseudocode);
    const stack: number[] = [];
    const removed: number[] = [];
    let maxSize = 0;
    let errors = 0;
    for (const o of parseOps(input.ops)) {
      r.step(1, `Operation: ${o.raw}.`, { size: stack.length }, { stack });
      if (o.op === 'add') {
        stack.push(o.value!);
        maxSize = Math.max(maxSize, stack.length);
        r.step(2, `Put ${o.value} on top. Size is now ${stack.length}.`, { size: stack.length, top: o.value }, { stack });
      } else if (o.op === 'remove') {
        if (stack.length === 0) {
          errors++;
          r.step(3, 'The stack is empty: nothing to remove (underflow).', { size: 0, errors }, { stack });
        } else {
          const x = stack.pop()!;
          removed.push(x);
          r.step(3, `Took ${x} off the top. Size is now ${stack.length}.`, { size: stack.length, removed: x }, { stack });
        }
      } else {
        r.step(4, stack.length ? `The top is ${stack[stack.length - 1]}.` : 'The stack is empty.', { size: stack.length, top: stack[stack.length - 1] ?? null }, { stack });
      }
    }
    return r.done({ final: stack.slice(), removed, maxSize, errors, size: stack.length });
  },
};

const queueOps: Algorithm = {
  id: 'queue',
  name: 'Queue (first in, first out)',
  inputKind: 'ops',
  pseudocode: ['read the next operation', 'add x: put x at the back of the queue', 'remove: take the front item off (error if empty)', 'peek: look at the front item without removing it'],
  run(input) {
    const r = new Recorder('queue', queueOps.pseudocode);
    const queue: number[] = [];
    const removed: number[] = [];
    let maxSize = 0;
    let errors = 0;
    for (const o of parseOps(input.ops)) {
      r.step(1, `Operation: ${o.raw}.`, { size: queue.length }, { queue });
      if (o.op === 'add') {
        queue.push(o.value!);
        maxSize = Math.max(maxSize, queue.length);
        r.step(2, `Put ${o.value} at the back. Size is now ${queue.length}.`, { size: queue.length, back: o.value }, { queue });
      } else if (o.op === 'remove') {
        if (queue.length === 0) {
          errors++;
          r.step(3, 'The queue is empty: nothing to remove.', { size: 0, errors }, { queue });
        } else {
          const x = queue.shift()!;
          removed.push(x);
          r.step(3, `Took ${x} from the front. Size is now ${queue.length}.`, { size: queue.length, removed: x }, { queue });
        }
      } else {
        r.step(4, queue.length ? `The front is ${queue[0]}.` : 'The queue is empty.', { size: queue.length, front: queue[0] ?? null }, { queue });
      }
    }
    return r.done({ final: queue.slice(), removed, maxSize, errors, size: queue.length });
  },
};

/* ----------------------------------------------------------------------------- graphs */

function neighbours(graph: Graph): Map<string, string[]> {
  const adj = new Map<string, string[]>(graph.nodes.map((n) => [n, []]));
  for (const [a, b] of graph.edges) {
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  for (const [, list] of adj) list.sort();
  return adj;
}

const bfs: Algorithm = {
  id: 'bfs',
  name: 'Breadth-first search',
  inputKind: 'graph',
  pseudocode: [
    'visited = {start}, queue = [start]',
    'while queue is not empty:',
    '    node = remove front of queue',
    '    for each neighbour of node (alphabetical):',
    '        if neighbour not visited:',
    '            mark visited, add to back of queue',
  ],
  run(input) {
    const r = new Recorder('bfs', bfs.pseudocode);
    const graph = input.graph ?? { nodes: [], edges: [] };
    const start = input.start ?? graph.nodes[0];
    const adj = neighbours(graph);
    if (!adj.has(start)) throw new Error(`"${start}" is not a node of the graph.`);
    const visited: string[] = [start];
    const queue: string[] = [start];
    const order: string[] = [];
    const depth: Record<string, number> = { [start]: 0 };
    r.step(1, `Start at ${start}.`, { start }, { visited, frontier: queue, current: start });
    while (queue.length) {
      r.step(2, `Queue: ${queue.join(', ')}.`, { queue: queue.join(', ') }, { visited, frontier: queue });
      const node = queue.shift()!;
      order.push(node);
      r.step(3, `Visit ${node}.`, { node, order: order.join(' → ') }, { visited, frontier: queue, current: node });
      for (const nb of adj.get(node) ?? []) {
        r.step(4, `Look at neighbour ${nb}.`, { node, neighbour: nb }, { visited, frontier: queue, current: node });
        if (!visited.includes(nb)) {
          visited.push(nb);
          queue.push(nb);
          depth[nb] = depth[node] + 1;
          r.step(6, `${nb} is new: mark it and add it to the queue (distance ${depth[nb]}).`, { node, neighbour: nb, distance: depth[nb] }, { visited, frontier: queue, current: node });
        } else {
          r.step(5, `${nb} was already seen.`, { node, neighbour: nb }, { visited, frontier: queue, current: node });
        }
      }
    }
    r.step(2, `Queue empty: visited ${order.length} node${order.length === 1 ? '' : 's'}.`, { order: order.join(' → ') }, { visited, frontier: [] });
    const metrics: Record<string, Metric> = { order, visitedCount: order.length };
    for (const [n, d] of Object.entries(depth)) metrics[`depth:${n}`] = d;
    return r.done(metrics);
  },
};

const dfs: Algorithm = {
  id: 'dfs',
  name: 'Depth-first search',
  inputKind: 'graph',
  pseudocode: [
    'visit(node):',
    '    mark node visited',
    '    for each neighbour of node (alphabetical):',
    '        if neighbour not visited:',
    '            visit(neighbour)',
  ],
  run(input) {
    const r = new Recorder('dfs', dfs.pseudocode);
    const graph = input.graph ?? { nodes: [], edges: [] };
    const start = input.start ?? graph.nodes[0];
    const adj = neighbours(graph);
    if (!adj.has(start)) throw new Error(`"${start}" is not a node of the graph.`);
    const visited: string[] = [];
    const stack: string[] = [];
    const order: string[] = [];
    const visit = (node: string, depthN: number) => {
      stack.push(node);
      r.step(1, `visit(${node})${depthN ? ` at depth ${depthN}` : ''}.`, { node, depth: depthN }, { visited, frontier: stack, current: node });
      visited.push(node);
      order.push(node);
      r.step(2, `Mark ${node} visited. Order so far: ${order.join(' → ')}.`, { node, order: order.join(' → ') }, { visited, frontier: stack, current: node });
      for (const nb of adj.get(node) ?? []) {
        r.step(3, `From ${node}, look at neighbour ${nb}.`, { node, neighbour: nb }, { visited, frontier: stack, current: node });
        if (!visited.includes(nb)) {
          r.step(5, `${nb} is new: go deeper.`, { node, neighbour: nb }, { visited, frontier: stack, current: node });
          visit(nb, depthN + 1);
          r.step(3, `Back at ${node}.`, { node }, { visited, frontier: stack, current: node });
        } else {
          r.step(4, `${nb} was already visited.`, { node, neighbour: nb }, { visited, frontier: stack, current: node });
        }
      }
      stack.pop();
    };
    visit(start, 0);
    r.step(1, `Finished: visited ${order.length} node${order.length === 1 ? '' : 's'}.`, { order: order.join(' → ') }, { visited, frontier: [] });
    return r.done({ order, visitedCount: order.length });
  },
};

export const ALGORITHMS: Record<string, Algorithm> = Object.fromEntries(
  [linearSearch, binarySearch, bubbleSort, selectionSort, insertionSort, stackOps, queueOps, bfs, dfs].map((a) => [a.id, a]),
);

/** Adds algorithms defined in other modules (more.ts) to the registry. */
export function registerAlgorithms(list: Algorithm[]): void {
  for (const a of list) ALGORITHMS[a.id] = a;
}

export function runAlgorithm(id: string, input: AlgorithmInput): Trace {
  const a = ALGORITHMS[id];
  if (!a) throw new Error(`Unknown algorithm "${id}".`);
  return a.run(input);
}

/** Parses "5, 3, 8" or "5 3 8" into numbers. Throws on anything else. */
export function parseValues(text: string): number[] {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const nums = parts.map(Number);
  if (nums.some((n) => Number.isNaN(n))) throw new Error('Use whole numbers separated by commas, for example 5, 3, 8.');
  return nums;
}
