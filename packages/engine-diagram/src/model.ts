/**
 * Diagram model and the text notation that produces it. One grammar serves every diagram kind:
 *
 *   diagram: usecase | class | sequence | state | er | activity | bpmn | dfd | cpm
 *   actor Student                      declared node (kind, id, optional "label")
 *   usecase UC1 "Register for course"
 *   class Student { +name: string  +register(course) }      members on following lines, one per line
 *   STUDENT { int id PK  string name }                      ER entity with attributes
 *   A[Task]  B(Rounded)  C{Decision?}  D((Start))  E[(Store)]  F[[External]]   implicit shaped nodes
 *   A -> B : label          A --> B |label|     A ..> B : include     Course <|-- OnlineCourse
 *   Order "1" -- "*" Line : contains            STUDENT ||--o{ ENROLMENT : has
 *   Student ->> Portal : login()                Portal -->> Student : token
 *   [*] --> Idle           Idle --> Running : start [ready] / log
 *   A "Survey site" 3      B "Order kit" 10 after A      C "Train staff" 2,4,12 after A, B   (CPM/PERT)
 */

export type DiagramKind = 'usecase' | 'class' | 'sequence' | 'state' | 'er' | 'activity' | 'bpmn' | 'dfd' | 'cpm' | 'flow';

export type NodeKind =
  | 'actor'
  | 'usecase'
  | 'class'
  | 'interface'
  | 'entity'
  | 'process'
  | 'store'
  | 'state'
  | 'start'
  | 'end'
  | 'task'
  | 'decision'
  | 'gateway-exclusive'
  | 'gateway-parallel'
  | 'gateway-inclusive'
  | 'event'
  | 'participant'
  | 'activity'
  | 'note'
  | 'node';

export type EdgeKind = 'association' | 'directed' | 'include' | 'extend' | 'generalisation' | 'realisation' | 'aggregation' | 'composition' | 'dependency' | 'message' | 'return' | 'transition' | 'flow' | 'relationship' | 'precedes';

export interface DiagramNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** Class or entity members, one per line. */
  members?: string[];
  /** CPM: duration (expected, from PERT when three estimates are given). */
  duration?: number;
  optimistic?: number;
  likely?: number;
  pessimistic?: number;
  lane?: string;
  line: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
  fromCard?: string;
  toCard?: string;
  line: number;
  /** Sequence diagrams: the message order. */
  seq?: number;
}

export interface Diagram {
  kind: DiagramKind;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  lanes: Record<string, string[]>;
  /** Sequence fragments (loop/alt/opt) with the message numbers they cover. */
  fragments: Array<{ kind: string; label: string; from: number; to: number }>;
  errors: Array<{ line: number; message: string }>;
}

const DECL_KINDS: Record<string, NodeKind> = {
  actor: 'actor',
  usecase: 'usecase',
  class: 'class',
  interface: 'interface',
  entity: 'entity',
  process: 'process',
  store: 'store',
  datastore: 'store',
  state: 'state',
  start: 'start',
  end: 'end',
  task: 'task',
  activity: 'activity',
  decision: 'decision',
  gateway: 'gateway-exclusive',
  event: 'event',
  participant: 'participant',
  note: 'note',
  node: 'node',
};

function stripComment(line: string): string {
  return line.replace(/(^|\s)(\/\/|%%|#).*$/, '').trimEnd();
}

/** Parses the notation. Never throws: problems are collected in `errors`. */
export function parseDiagram(src: string, defaultKind: DiagramKind = 'flow'): Diagram {
  const d: Diagram = { kind: defaultKind, nodes: [], edges: [], lanes: {}, fragments: [], errors: [] };
  const lines = src.split('\n');
  const nodeById = new Map<string, DiagramNode>();
  const ensure = (idRaw: string, kind: NodeKind, label: string | undefined, line: number): DiagramNode => {
    const id = idRaw.trim();
    let n = nodeById.get(id);
    if (!n) {
      n = { id, kind, label: label ?? id, line };
      nodeById.set(id, n);
      d.nodes.push(n);
    } else {
      if (label !== undefined) n.label = label;
      if (n.kind === 'node' && kind !== 'node') n.kind = kind;
    }
    return n;
  };
  let seq = 0;
  let bodyOf: DiagramNode | null = null;
  const fragStack: Array<{ kind: string; label: string; from: number }> = [];
  let currentLane: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = stripComment(lines[i]);
    const line = raw.trim();
    if (!line) continue;

    if (bodyOf) {
      if (line === '}') {
        bodyOf = null;
        continue;
      }
      (bodyOf.members ??= []).push(line);
      continue;
    }

    // diagram: kind
    const dk = /^diagram\s*:\s*(\w+)$/i.exec(line);
    if (dk) {
      const k = dk[1].toLowerCase() as DiagramKind;
      if (['usecase', 'class', 'sequence', 'state', 'er', 'activity', 'bpmn', 'dfd', 'cpm', 'flow'].includes(k)) d.kind = k;
      else d.errors.push({ line: lineNo, message: `unknown diagram kind "${dk[1]}"` });
      continue;
    }
    // lane Name { ... } or lane Name: A, B
    const laneOpen = /^(?:lane|pool|swimlane)\s+("[^"]+"|\S+)\s*(?:\{|:\s*(.*))?$/i.exec(line);
    if (laneOpen) {
      const name = laneOpen[1].replace(/^"|"$/g, '');
      d.lanes[name] ??= [];
      if (laneOpen[2] !== undefined) {
        for (const id of laneOpen[2].split(',').map((s) => s.trim()).filter(Boolean)) {
          d.lanes[name].push(id);
          ensure(id, 'task', undefined, lineNo).lane = name;
        }
      } else if (line.endsWith('{')) currentLane = name;
      continue;
    }
    if (line === '}' && currentLane) {
      currentLane = null;
      continue;
    }
    // Sequence fragments.
    const frag = /^(loop|alt|opt|par|else)\b\s*(.*)$/i.exec(line);
    if (frag && d.kind === 'sequence') {
      if (frag[1].toLowerCase() === 'else') {
        const open = fragStack.pop();
        if (open) d.fragments.push({ kind: open.kind, label: open.label, from: open.from, to: seq });
        fragStack.push({ kind: 'else', label: frag[2], from: seq + 1 });
      } else fragStack.push({ kind: frag[1].toLowerCase(), label: frag[2], from: seq + 1 });
      continue;
    }
    if (/^end$/i.test(line) && d.kind === 'sequence') {
      const open = fragStack.pop();
      if (open) d.fragments.push({ kind: open.kind, label: open.label, from: open.from, to: seq });
      else d.errors.push({ line: lineNo, message: 'end without a loop/alt/opt' });
      continue;
    }
    if (/^(activate|deactivate|autonumber|title)\b/i.test(line)) continue;

    // CPM activity: A "Label" 3 after B, C   or   A "Label" 2,4,12 after B
    const cpm = /^([A-Za-z0-9_-]+)\s+"([^"]*)"\s+(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?))?\s*(?:after\s+(.+))?$/i.exec(line);
    if (cpm && (d.kind === 'cpm' || /\bafter\b/i.test(line))) {
      const n = ensure(cpm[1], 'activity', cpm[2], lineNo);
      if (cpm[4] !== undefined) {
        n.optimistic = Number(cpm[3]);
        n.likely = Number(cpm[4]);
        n.pessimistic = Number(cpm[5]);
        n.duration = Math.round(((n.optimistic + 4 * n.likely + n.pessimistic) / 6) * 100) / 100;
      } else n.duration = Number(cpm[3]);
      for (const p of (cpm[6] ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
        ensure(p, 'activity', undefined, lineNo);
        d.edges.push({ from: p, to: n.id, kind: 'precedes', line: lineNo });
      }
      if (currentLane) n.lane = currentLane;
      continue;
    }

    // Declarations: kind Id "label" [{]
    const decl = /^(actor|usecase|class|interface|entity|process|store|datastore|state|start|end|task|activity|decision|gateway|event|participant|note|node)\s+("[^"]+"|[A-Za-z0-9_\-*[\]]+)(?:\s+(exclusive|parallel|inclusive))?(?:\s+"([^"]*)")?(?:\s+as\s+([A-Za-z0-9_-]+))?\s*(\{)?$/i.exec(line);
    if (decl) {
      const kindWord = decl[1].toLowerCase();
      let kind = DECL_KINDS[kindWord];
      if (kindWord === 'gateway' && decl[3]) kind = `gateway-${decl[3].toLowerCase()}` as NodeKind;
      const idOrLabel = decl[2].replace(/^"|"$/g, '');
      const id = decl[5] ?? idOrLabel;
      const label = decl[4] ?? idOrLabel;
      const n = ensure(id, kind, label, lineNo);
      if (currentLane) n.lane = currentLane;
      if (decl[6]) bodyOf = n;
      continue;
    }
    // ER entity with body: NAME {
    const entityBody = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\{$/.exec(line);
    if (entityBody) {
      const n = ensure(entityBody[1], d.kind === 'class' ? 'class' : d.kind === 'er' ? 'entity' : 'node', undefined, lineNo);
      bodyOf = n;
      continue;
    }

    // Edges: tokens with optional cardinalities and labels.
    const edge = parseEdge(line);
    if (edge) {
      const left = resolveShape(edge.left, d.kind);
      const right = resolveShape(edge.right, d.kind);
      // In state machines [*] on the right is the final state, a different node from the initial one.
      if (right.id === '[*]') {
        right.id = '[*]end';
        right.kind = 'end';
        right.label = '';
      }
      const a = ensure(left.id, left.kind, left.label, lineNo);
      const b = ensure(right.id, right.kind, right.label, lineNo);
      if (currentLane) {
        a.lane ??= currentLane;
        b.lane ??= currentLane;
      }
      let from = a.id;
      let to = b.id;
      let kind = edge.kind;
      let fromCard = edge.leftCard;
      let toCard = edge.rightCard;
      if (edge.reverse) {
        [from, to] = [to, from];
        [fromCard, toCard] = [toCard, fromCard];
      }
      if (d.kind === 'usecase' && kind === 'dependency') {
        const l = (edge.label ?? '').toLowerCase().replace(/[<>«»]/g, '').trim();
        if (l === 'include' || l === 'includes') kind = 'include';
        else if (l === 'extend' || l === 'extends') kind = 'extend';
      }
      if (d.kind === 'sequence' && (kind === 'directed' || kind === 'message' || kind === 'return' || kind === 'dependency')) {
        seq++;
        if (a.kind === 'node') a.kind = 'participant';
        if (b.kind === 'node') b.kind = 'participant';
        d.edges.push({ from, to, kind: kind === 'return' ? 'return' : 'message', label: edge.label, line: lineNo, seq });
        continue;
      }
      if (d.kind === 'state' && kind === 'directed') kind = 'transition';
      if ((d.kind === 'activity' || d.kind === 'bpmn' || d.kind === 'dfd' || d.kind === 'flow') && kind === 'directed') kind = 'flow';
      if (d.kind === 'cpm' && (kind === 'directed' || kind === 'association')) kind = 'precedes';
      if (d.kind === 'er' && kind === 'association') kind = 'relationship';
      d.edges.push({ from, to, kind, label: edge.label, fromCard, toCard, line: lineNo });
      continue;
    }
    // Bare shaped node: A[Label]
    const shaped = resolveShape(line, d.kind);
    if (shaped.explicit) {
      const n = ensure(shaped.id, shaped.kind, shaped.label, lineNo);
      if (currentLane) n.lane = currentLane;
      continue;
    }
    d.errors.push({ line: lineNo, message: `cannot read this line: ${line}` });
  }
  if (bodyOf) d.errors.push({ line: lines.length, message: `missing } for ${bodyOf.id}` });
  // Fix up kinds for the diagram type.
  for (const n of d.nodes) {
    if (n.kind !== 'node') continue;
    n.kind = d.kind === 'class' ? 'class' : d.kind === 'er' ? 'entity' : d.kind === 'state' ? 'state' : d.kind === 'usecase' ? 'usecase' : d.kind === 'sequence' ? 'participant' : d.kind === 'cpm' ? 'activity' : d.kind === 'dfd' ? 'process' : 'task';
  }
  if (d.kind === 'state') for (const n of d.nodes) if (n.id === '[*]') n.kind = 'start';
  return d;
}

interface ParsedEdge {
  left: string;
  right: string;
  kind: EdgeKind;
  label?: string;
  leftCard?: string;
  rightCard?: string;
  reverse: boolean;
}

const ARROWS: Array<{ re: RegExp; kind: EdgeKind; reverse?: boolean }> = [
  { re: /<\|\.\./, kind: 'realisation', reverse: true },
  { re: /\.\.\|>/, kind: 'realisation' },
  { re: /<\|--/, kind: 'generalisation', reverse: true },
  { re: /--\|>/, kind: 'generalisation' },
  { re: /--\*/, kind: 'composition', reverse: true },
  { re: /\*--/, kind: 'composition' },
  { re: /--o(?![{|])/, kind: 'aggregation', reverse: true },
  { re: /o--/, kind: 'aggregation' },
  { re: /-->>/, kind: 'return' },
  { re: /->>/, kind: 'message' },
  { re: /\.\.>/, kind: 'dependency' },
  { re: /-->/, kind: 'directed' },
  { re: /->/, kind: 'directed' },
  { re: /--/, kind: 'association' },
  { re: /\.\./, kind: 'dependency' },
];

const ER_SIDE = '(?:\\|\\||\\|o|o\\||\\}\\||\\}o|\\|\\{|o\\{)';
const ER_RE = new RegExp(`^(.+?)\\s+(${ER_SIDE})(--|\\.\\.)(${ER_SIDE})\\s+(.+)$`);

function parseEdge(line: string): ParsedEdge | null {
  // ER crow's foot: A ||--o{ B : label
  const er = ER_RE.exec(line);
  if (er) {
    const [, left, l, , r, rest] = er;
    const { text: right, label } = splitLabel(rest);
    return { left: left.trim(), right: right.trim(), kind: 'relationship', label, leftCard: erCard(l, true), rightCard: erCard(r, false), reverse: false };
  }
  for (const a of ARROWS) {
    const m = a.re.exec(line);
    if (!m || m.index === 0) continue;
    const leftRaw = line.slice(0, m.index).trim();
    const rightRaw = line.slice(m.index + m[0].length).trim();
    if (!leftRaw || !rightRaw) continue;
    const lc = /^(.*?)\s*"([^"]*)"$/.exec(leftRaw);
    const left = lc ? lc[1].trim() : leftRaw;
    const leftCard = lc ? lc[2] : undefined;
    let rightText = rightRaw;
    let label: string | undefined;
    const pipe = /^\|([^|]*)\|\s*(.+)$/.exec(rightText);
    if (pipe) {
      label = pipe[1].trim();
      rightText = pipe[2];
    }
    const sl = splitLabel(rightText);
    rightText = sl.text;
    label = sl.label ?? label;
    const rc = /^"([^"]*)"\s*(.+)$/.exec(rightText);
    const right = rc ? rc[2].trim() : rightText.trim();
    const rightCard = rc ? rc[1] : undefined;
    if (!left || !right) continue;
    return { left, right, kind: a.kind, label, leftCard, rightCard, reverse: a.reverse ?? false };
  }
  return null;
}

function splitLabel(text: string): { text: string; label?: string } {
  const i = text.indexOf(':');
  if (i === -1) return { text };
  // Do not split inside quotes or shapes.
  const before = text.slice(0, i);
  const quotes = (before.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) return { text };
  const opens = (before.match(/[[({]/g) ?? []).length;
  const closes = (before.match(/[\])}]/g) ?? []).length;
  if (opens !== closes) return { text };
  return { text: before.trim(), label: text.slice(i + 1).trim() };
}

function erCard(side: string, left: boolean): string {
  const s = left ? side : side.split('').reverse().join('').replace('{', '}');
  const map: Record<string, string> = { '||': '1', '|o': '0..1', 'o|': '0..1', '}|': '1..*', '}o': '0..*', '|{': '1..*', 'o{': '0..*' };
  return map[side] ?? map[s] ?? side;
}

function resolveShape(text: string, kind: DiagramKind): { id: string; kind: NodeKind; label?: string; explicit: boolean } {
  const t = text.trim();
  const shapes: Array<[RegExp, NodeKind]> = [
    [/^([A-Za-z0-9_-]+)\(\((.+)\)\)$/, kind === 'bpmn' || kind === 'activity' ? 'event' : 'start'],
    [/^([A-Za-z0-9_-]+)\[\((.+)\)\]$/, 'store'],
    [/^([A-Za-z0-9_-]+)\[\[(.+)\]\]$/, 'entity'],
    [/^([A-Za-z0-9_-]+)\{(.+)\}$/, kind === 'bpmn' ? 'gateway-exclusive' : 'decision'],
    [/^([A-Za-z0-9_-]+)\((.+)\)$/, kind === 'usecase' ? 'usecase' : kind === 'dfd' ? 'process' : 'task'],
    [/^([A-Za-z0-9_-]+)\[(.+)\]$/, kind === 'dfd' ? 'entity' : 'task'],
  ];
  for (const [re, k] of shapes) {
    const m = re.exec(t);
    if (m) {
      let label = m[2].trim();
      let nk = k;
      if (nk === 'gateway-exclusive') {
        if (label.startsWith('+')) {
          nk = 'gateway-parallel';
          label = label.slice(1).trim() || 'AND';
        } else if (/^O\b/.test(label)) {
          nk = 'gateway-inclusive';
          label = label.slice(1).trim() || 'OR';
        } else if (/^X\b/.test(label)) label = label.slice(1).trim() || 'XOR';
      }
      if (nk === 'start' && /^(end|stop|finish)$/i.test(label)) nk = 'end';
      if (nk === 'event' && /^(end|stop|finish)/i.test(label)) nk = 'end';
      if (nk === 'event' && /^start/i.test(label)) nk = 'start';
      return { id: m[1], kind: nk, label, explicit: true };
    }
  }
  const quoted = /^"([^"]+)"$/.exec(t);
  if (quoted) return { id: quoted[1], kind: 'node', label: quoted[1], explicit: false };
  if (t === '[*]') return { id: '[*]', kind: 'start', label: '', explicit: false };
  return { id: t, kind: 'node', explicit: false };
}

/* ------------------------------------------------------------------ helpers over a diagram */

export function nodeOf(d: Diagram, idOrLabel: string | RegExp): DiagramNode | undefined {
  if (typeof idOrLabel === 'string') return d.nodes.find((n) => n.id === idOrLabel) ?? d.nodes.find((n) => n.label.toLowerCase() === idOrLabel.toLowerCase());
  return d.nodes.find((n) => idOrLabel.test(n.id) || idOrLabel.test(n.label));
}

export function nodesMatching(d: Diagram, pattern: string): DiagramNode[] {
  const re = new RegExp(pattern, 'i');
  return d.nodes.filter((n) => re.test(n.id) || re.test(n.label));
}

export function outEdges(d: Diagram, id: string): DiagramEdge[] {
  return d.edges.filter((e) => e.from === id);
}
export function inEdges(d: Diagram, id: string): DiagramEdge[] {
  return d.edges.filter((e) => e.to === id);
}

export function reachable(d: Diagram, from: string, undirected = false): Set<string> {
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of d.edges) {
      const next = e.from === cur ? e.to : undirected && e.to === cur ? e.from : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

export function orphans(d: Diagram): DiagramNode[] {
  return d.nodes.filter((n) => n.kind !== 'note' && !d.edges.some((e) => e.from === n.id || e.to === n.id));
}
