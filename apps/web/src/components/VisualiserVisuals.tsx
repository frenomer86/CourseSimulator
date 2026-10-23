/**
 * Pictures for the visualiser's later input kinds: automata with a tape, weighted maps, grids,
 * game trees, alignment matrices and rule bases. Each draws one step of a trace.
 */

import type { AlgorithmInput, Automaton, GameTree, Step, WeightedGraph } from '@cslab/engine-visualiser';

const C = {
  gold: 'var(--color-gold)',
  high: 'var(--color-high)',
  highSoft: 'var(--color-high-soft)',
  surface: 'var(--color-surface)',
  line: 'var(--color-line)',
  ink: 'var(--color-ink)',
  faint: 'var(--color-ink-faint)',
  mono: 'var(--font-mono)',
};

function circleLayout(names: string[], w: number, h: number, margin = 40) {
  const n = names.length;
  const rad = Math.min(w, h) / 2 - margin;
  return new Map(names.map((name, i) => [name, { x: w / 2 + rad * Math.cos((2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2), y: h / 2 + rad * Math.sin((2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2) }]));
}

/* ----------------------------------------------------------------------------- automaton */

export function AutomatonVisual({ step, m }: { step: Step; m: Automaton }) {
  const w = 440;
  const h = 260;
  const pos = circleLayout(m.states, w, h, 56);
  const active = new Set(step.active ?? []);
  const grouped = new Map<string, string[]>();
  for (const [from, sym, to] of m.transitions) {
    const k = `${from}→${to}`;
    grouped.set(k, [...(grouped.get(k) ?? []), sym]);
  }
  const r = 22;
  const tape = step.tape;
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-[480px] h-auto" role="img" aria-label="State diagram">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={C.faint} />
          </marker>
        </defs>
        {[...grouped].map(([k, syms]) => {
          const [from, to] = k.split('→');
          const p = pos.get(from);
          const q = pos.get(to);
          if (!p || !q) return null;
          const label = syms.join(',');
          if (from === to) {
            const cx = p.x;
            const cy = p.y - r - 14;
            return (
              <g key={k}>
                <circle cx={cx} cy={cy} r={14} fill="none" stroke={C.faint} strokeWidth={1.5} />
                <text x={cx} y={cy - 18} textAnchor="middle" fontSize={12} fontFamily={C.mono} fill={C.ink}>
                  {label}
                </text>
              </g>
            );
          }
          const both = grouped.has(`${to}→${from}`);
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const off = both ? 16 : 0;
          const nx = -uy * off;
          const ny = ux * off;
          const x1 = p.x + ux * r + nx;
          const y1 = p.y + uy * r + ny;
          const x2 = q.x - ux * (r + 3) + nx;
          const y2 = q.y - uy * (r + 3) + ny;
          return (
            <g key={k}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={C.faint} strokeWidth={1.5} markerEnd="url(#arrow)" />
              <text x={(x1 + x2) / 2 + nx * 0.8} y={(y1 + y2) / 2 + ny * 0.8 - 4} textAnchor="middle" fontSize={12} fontFamily={C.mono} fill={C.ink}>
                {label}
              </text>
            </g>
          );
        })}
        {m.states.map((s) => {
          const p = pos.get(s)!;
          const on = active.has(s);
          return (
            <g key={s}>
              {s === m.start && <line x1={p.x - r - 26} y1={p.y} x2={p.x - r - 3} y2={p.y} stroke={C.ink} strokeWidth={1.5} markerEnd="url(#arrow)" />}
              <circle cx={p.x} cy={p.y} r={r} fill={on ? C.gold : C.surface} stroke={C.ink} strokeWidth={1.5} />
              {m.accept.includes(s) && <circle cx={p.x} cy={p.y} r={r - 4} fill="none" stroke={C.ink} strokeWidth={1.2} />}
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={12} fontFamily={C.mono} fill={C.ink}>
                {s}
              </text>
            </g>
          );
        })}
      </svg>
      {tape && (
        <div className="mt-2 flex items-center gap-1" aria-label="Tape">
          {tape.symbols.map((sym, i) => (
            <span key={i} className={`w-8 h-8 grid place-items-center rounded border font-mono text-sm ${i === tape.pos ? 'border-gold bg-gold-soft' : i < tape.pos ? 'border-line bg-bench text-ink-faint' : 'border-line bg-surface'}`}>
              {sym}
            </span>
          ))}
          {tape.symbols.length === 0 && <span className="text-sm text-ink-soft">(empty word)</span>}
          <span className="text-xs text-ink-soft ml-2">double ring = accepting, arrow = start</span>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------- weighted map */

export function WeightedVisual({ step, g }: { step: Step; g: WeightedGraph }) {
  const w = 440;
  const h = 300;
  const pos = g.layout
    ? new Map(g.nodes.map((n) => [n, { x: 36 + (g.layout![n]?.[0] ?? 0.5) * (w - 72), y: 26 + (g.layout![n]?.[1] ?? 0.5) * (h - 60) }]))
    : circleLayout(g.nodes, w, h);
  const visited = new Set(step.visited ?? []);
  const frontier = new Set(step.frontier ?? []);
  const path = step.path ?? [];
  const onPath = (a: string, b: string) => path.some((p, i) => i > 0 && ((path[i - 1] === a && p === b) || (path[i - 1] === b && p === a)));
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-[480px] h-auto" role="img" aria-label="Weighted graph">
        {g.edges.map(([a, b, wt], i) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          const hot = onPath(a, b);
          return (
            <g key={i}>
              <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={hot ? C.high : C.line} strokeWidth={hot ? 4 : 2} />
              <text x={(p.x + q.x) / 2} y={(p.y + q.y) / 2 - 4} textAnchor="middle" fontSize={11} fontFamily={C.mono} fill={C.ink} style={{ paintOrder: 'stroke', stroke: 'var(--color-bench)', strokeWidth: 3 }}>
                {wt}
              </text>
            </g>
          );
        })}
        {g.nodes.map((n) => {
          const p = pos.get(n)!;
          const isCurrent = step.current === n;
          const fill = isCurrent ? C.gold : visited.has(n) ? C.high : frontier.has(n) ? C.highSoft : C.surface;
          const label = step.labels?.[n];
          return (
            <g key={n}>
              <circle cx={p.x} cy={p.y} r={8} fill={fill} stroke={frontier.has(n) ? C.high : C.faint} strokeWidth={frontier.has(n) ? 3 : 1.5} />
              <text x={p.x} y={p.y - 13} textAnchor="middle" fontSize={11} fontFamily={C.mono} fill={C.ink}>
                {n}
              </text>
              {label !== undefined && (
                <text x={p.x} y={p.y + 21} textAnchor="middle" fontSize={10} fontFamily={C.mono} fill={C.high}>
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-ink-soft">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-high align-middle mr-1" /> expanded
        <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-high bg-high-soft align-middle ml-3 mr-1" /> open
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-gold align-middle ml-3 mr-1" /> current
        <span className="ml-3">green numbers: cost so far{step.labels && Object.values(step.labels).some((v) => v.includes('+')) ? ' + estimate to the goal' : ''}</span>
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------- grid */

export function GridVisual({ step, rows }: { step: Step; rows: string[] }) {
  const closed = new Set(step.visited ?? []);
  const open = new Set(step.frontier ?? []);
  const path = new Set(step.path ?? []);
  return (
    <div>
      <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `repeat(${Math.max(...rows.map((r) => r.length))}, 1.9rem)` }} role="img" aria-label="Grid">
        {rows.flatMap((row, r) =>
          [...row].map((ch, c) => {
            const k = `${r},${c}`;
            const wall = ch === '#';
            const cls = wall
              ? ''
              : step.current === k
                ? 'bg-gold'
                : path.has(k)
                  ? 'bg-high text-white'
                  : closed.has(k)
                    ? 'bg-high-soft'
                    : open.has(k)
                      ? 'bg-gold-soft border-gold'
                      : 'bg-surface';
            return (
              <span key={k} title={k} className={`h-[1.9rem] grid place-items-center rounded-sm border border-line font-mono text-xs ${cls}`} style={wall ? { background: C.ink } : undefined}>
                {ch === 'S' || ch === 'G' ? ch : ''}
              </span>
            );
          }),
        )}
      </div>
      <p className="mt-2 text-xs text-ink-soft">
        Cells are named row,column from 0,0 at the top left.
        <span className="inline-block w-2.5 h-2.5 bg-high-soft border border-line align-middle ml-3 mr-1" /> expanded
        <span className="inline-block w-2.5 h-2.5 bg-gold-soft border border-gold align-middle ml-3 mr-1" /> open
        <span className="inline-block w-2.5 h-2.5 bg-high align-middle ml-3 mr-1" /> path
        <span className="ml-3 font-mono">expanded: {closed.size}</span>
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------------------- game tree */

export function TreeVisual({ step, tree }: { step: Step; tree: GameTree }) {
  const placed: Array<{ n: GameTree; x: number; y: number; depth: number; parent?: { x: number; y: number } }> = [];
  let leafIndex = 0;
  let maxDepth = 0;
  const countLeaves = (n: GameTree): number => (n.children?.length ? n.children.reduce((a, c) => a + countLeaves(c), 0) : 1);
  const totalLeaves = countLeaves(tree);
  const w = Math.max(360, totalLeaves * 46);
  const place = (n: GameTree, depth: number): { x: number; y: number } => {
    maxDepth = Math.max(maxDepth, depth);
    let x: number;
    if (!n.children?.length) {
      x = 30 + leafIndex * ((w - 60) / Math.max(1, totalLeaves - 1));
      leafIndex++;
    } else {
      const xs = n.children.map((c) => place(c, depth + 1).x);
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    const at = { x, y: 0 };
    placed.push({ n, x, y: depth, depth });
    return at;
  };
  place(tree, 0);
  const rowH = 70;
  const h = (maxDepth + 1) * rowH + 10;
  const byName = new Map(placed.map((p) => [p.n.name, p]));
  const yOf = (d: number) => 24 + d * rowH;
  const visited = new Set(step.visited ?? []);
  const pruned = new Set(step.pruned ?? []);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-auto" style={{ width: Math.min(w, 560), maxWidth: '100%' }} role="img" aria-label="Game tree">
        {placed.map(({ n }) =>
          (n.children ?? []).map((c) => {
            const a = byName.get(n.name)!;
            const b = byName.get(c.name)!;
            return <line key={`${n.name}-${c.name}`} x1={a.x} y1={yOf(a.depth)} x2={b.x} y2={yOf(b.depth)} stroke={C.line} strokeWidth={1.5} strokeDasharray={pruned.has(c.name) ? '4 3' : undefined} />;
          }),
        )}
        {placed.map(({ n, x, depth }) => {
          const isMax = depth % 2 === 0;
          const isLeaf = !n.children?.length;
          const isPruned = pruned.has(n.name);
          const fill = step.current === n.name ? C.gold : isLeaf && visited.has(n.name) ? C.highSoft : C.surface;
          const label = step.labels?.[n.name];
          return (
            <g key={n.name} opacity={isPruned ? 0.35 : 1}>
              {isLeaf ? (
                <rect x={x - 15} y={yOf(depth) - 13} width={30} height={26} rx={4} fill={fill} stroke={C.faint} strokeDasharray={isPruned ? '3 2' : undefined} />
              ) : (
                <polygon points={isMax ? `${x},${yOf(depth) - 16} ${x - 17},${yOf(depth) + 12} ${x + 17},${yOf(depth) + 12}` : `${x},${yOf(depth) + 16} ${x - 17},${yOf(depth) - 12} ${x + 17},${yOf(depth) - 12}`} fill={fill} stroke={C.ink} strokeWidth={1.3} />
              )}
              <text x={x} y={yOf(depth) + 4} textAnchor="middle" fontSize={10} fontFamily={C.mono} fill={C.ink}>
                {isLeaf ? (n.value ?? '') : (label ?? '')}
              </text>
              <text x={x} y={yOf(depth) + (isLeaf ? 26 : 28)} textAnchor="middle" fontSize={9} fontFamily={C.mono} fill={C.faint}>
                {n.name}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-ink-soft">▲ MAX moves, ▼ MIN moves. Numbers inside are values found so far; faded leaves were pruned.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------- alignment */

export function AlignmentVisual({ step, a, b }: { step: Step; a: string; b: string }) {
  const cells = step.cells ?? [];
  const path = new Set(step.path ?? []);
  const [ci, cj] = step.cell ?? [-1, -1];
  return (
    <div className="overflow-x-auto">
      <table className="font-mono text-sm border-collapse" aria-label="Score matrix">
        <thead>
          <tr>
            <th className="w-9" />
            <th className="w-9 text-ink-faint font-normal">-</th>
            {[...b].map((ch, j) => (
              <th key={j} className="w-9 font-medium">
                {ch}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((row, i) => (
            <tr key={i}>
              <th className={`w-9 ${i === 0 ? 'text-ink-faint font-normal' : 'font-medium'}`}>{i === 0 ? '-' : a[i - 1]}</th>
              {row.map((v, j) => {
                const here = i === ci && j === cj;
                const onPath = path.has(`${i},${j}`);
                return (
                  <td key={j} className={`w-9 h-8 text-center border border-line ${here ? 'bg-gold' : onPath ? 'bg-high text-white' : v === null ? 'bg-bench' : 'bg-surface'}`}>
                    {v ?? ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-soft">Rows follow the first sequence and columns the second. Cell (i, j) is the best score for aligning their first i and j letters.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------- rules */

export function RulesVisual({ step, input }: { step: Step; input: AlgorithmInput }) {
  const start = new Set(input.facts ?? []);
  const known = step.known ?? [...start];
  const knownSet = new Set(known);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <h3 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Known facts</h3>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {known.map((f) => (
            <span key={f} className={`rounded px-2 py-0.5 font-mono text-xs border ${start.has(f) ? 'border-line bg-surface' : 'border-high bg-high-soft text-high'} ${step.current === f ? 'ring-2 ring-gold' : ''}`}>
              {f}
            </span>
          ))}
        </div>
        {step.current && !knownSet.has(step.current) && (
          <p className="mt-2 text-xs">
            Trying to prove <span className="font-mono rounded px-1.5 py-0.5 bg-gold-soft border border-gold">{step.current}</span>
          </p>
        )}
      </div>
      <div>
        <h3 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Rules</h3>
        <ol className="mt-1 space-y-1">
          {(input.rules ?? []).map((r, i) => (
            <li key={i} className={`font-mono text-xs rounded px-2 py-1 border ${step.rule === i ? 'border-gold bg-gold-soft' : 'border-line bg-surface'}`}>
              <span className="text-ink-faint mr-1">{r.name ?? `R${i + 1}`}</span>
              {r.if.join(' ∧ ')} → <span className={knownSet.has(r.then) ? 'text-high font-medium' : ''}>{r.then}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
