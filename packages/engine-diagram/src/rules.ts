/** Well-formedness rules per diagram kind, phrased as the studio's warnings. */

import { computeCpm } from './cpm.js';
import { inEdges, orphans, outEdges, reachable, type Diagram } from './model.js';

export interface Problem {
  node?: string;
  message: string;
}

export function dfdProblems(d: Diagram, level: 'context' | 'level0' | 'any' = 'any'): Problem[] {
  const out: Problem[] = [];
  const processes = d.nodes.filter((n) => n.kind === 'process');
  if (!processes.length) out.push({ message: 'A data flow diagram needs at least one process (a rounded node).' });
  if (level === 'context' && processes.length !== 1) out.push({ message: `A context diagram has exactly one process (the whole system); this one has ${processes.length}.` });
  if (level === 'context' && d.nodes.some((n) => n.kind === 'store')) out.push({ message: 'A context diagram shows no data stores; they appear from level 0 down.' });
  for (const p of processes) {
    if (!inEdges(d, p.id).length) out.push({ node: p.id, message: `Process ${p.label} has no input: a process cannot produce data from nothing (a "miracle").` });
    if (!outEdges(d, p.id).length) out.push({ node: p.id, message: `Process ${p.label} has no output: data goes in and disappears (a "black hole").` });
  }
  for (const e of d.edges) {
    const a = d.nodes.find((n) => n.id === e.from);
    const b = d.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const nonProcess = (k: string) => k === 'store' || k === 'entity';
    if (nonProcess(a.kind) && nonProcess(b.kind)) out.push({ message: `Data cannot flow directly from ${a.label} to ${b.label}: every flow must pass through a process.` });
    if (!e.label && d.kind === 'dfd') out.push({ message: `The flow from ${a.label} to ${b.label} needs a name for the data it carries (write ": data name").` });
  }
  for (const n of orphans(d)) out.push({ node: n.id, message: `${n.label} is not connected to anything.` });
  return out;
}

export function bpmnProblems(d: Diagram): Problem[] {
  const out: Problem[] = [];
  const starts = d.nodes.filter((n) => n.kind === 'start');
  const ends = d.nodes.filter((n) => n.kind === 'end');
  if (!starts.length) out.push({ message: 'The process needs a start event, e.g. S((Start)).' });
  if (!ends.length) out.push({ message: 'The process needs an end event, e.g. E((End)).' });
  for (const n of d.nodes) {
    const outs = outEdges(d, n.id).length;
    const ins = inEdges(d, n.id).length;
    if ((n.kind === 'task' || n.kind === 'activity') && outs > 1) out.push({ node: n.id, message: `Task ${n.label} has ${outs} outgoing flows; use a gateway to split the flow.` });
    if (n.kind === 'start' && ins > 0) out.push({ node: n.id, message: 'A start event has no incoming flow.' });
    if (n.kind === 'end' && outs > 0) out.push({ node: n.id, message: 'An end event has no outgoing flow.' });
    if (n.kind.startsWith('gateway') && outs > 1) {
      for (const e of outEdges(d, n.id)) if (!e.label && n.kind === 'gateway-exclusive') out.push({ message: `The flows out of gateway ${n.label} need conditions (write |yes| or : yes).` });
    }
  }
  // Split/join pairing per gateway type.
  for (const t of ['gateway-exclusive', 'gateway-parallel', 'gateway-inclusive'] as const) {
    const splits = d.nodes.filter((n) => n.kind === t && outEdges(d, n.id).length > 1).length;
    const joins = d.nodes.filter((n) => n.kind === t && inEdges(d, n.id).length > 1).length;
    if (splits !== joins) out.push({ message: `${splits} ${t.replace('gateway-', '')} split${splits === 1 ? '' : 's'} but ${joins} join${joins === 1 ? '' : 's'}: every split should be closed by a join of the same type.` });
  }
  if (starts.length) {
    const r = reachable(d, starts[0].id);
    for (const n of d.nodes) if (!r.has(n.id) && n.kind !== 'start' && n.kind !== 'note') out.push({ node: n.id, message: `${n.label} cannot be reached from the start event.` });
    for (const e of ends) {
      const back = reachable({ ...d, edges: d.edges.map((x) => ({ ...x, from: x.to, to: x.from })) }, e.id);
      for (const n of d.nodes) if (!back.has(n.id) && n.kind !== 'end' && n.kind !== 'note' && ends.length === 1) out.push({ node: n.id, message: `${n.label} never leads to the end event.` });
    }
  }
  return out;
}

export function stateProblems(d: Diagram): Problem[] {
  const out: Problem[] = [];
  const initial = d.nodes.find((n) => n.kind === 'start');
  if (!initial) out.push({ message: 'The machine needs an initial pseudo-state: [*] --> FirstState.' });
  const states = d.nodes.filter((n) => n.kind === 'state');
  if (!states.length) out.push({ message: 'No states found.' });
  if (initial) {
    const r = reachable(d, initial.id);
    for (const s of states) if (!r.has(s.id)) out.push({ node: s.id, message: `State ${s.label} cannot be reached from the initial state.` });
  }
  for (const e of d.edges) if (e.kind === 'transition' && !e.label && e.from !== '[*]' && e.to !== '[*]end') out.push({ message: `The transition from ${e.from} to ${e.to} needs an event (write : event).` });
  return out;
}

export function usecaseProblems(d: Diagram): Problem[] {
  const out: Problem[] = [];
  const actors = d.nodes.filter((n) => n.kind === 'actor');
  const ucs = d.nodes.filter((n) => n.kind === 'usecase');
  if (!actors.length) out.push({ message: 'Declare at least one actor: actor Student.' });
  if (!ucs.length) out.push({ message: 'Declare use cases: usecase UC1 "Register for course" or UC1(Register for course).' });
  for (const u of ucs) {
    const linked = d.edges.some((e) => (e.from === u.id || e.to === u.id) && (e.kind === 'association' || e.kind === 'directed' || e.kind === 'include' || e.kind === 'extend'));
    if (!linked) out.push({ node: u.id, message: `Use case ${u.label} is not linked to any actor or other use case.` });
  }
  for (const e of d.edges) {
    const a = d.nodes.find((n) => n.id === e.from);
    const b = d.nodes.find((n) => n.id === e.to);
    if (a?.kind === 'actor' && b?.kind === 'actor' && e.kind !== 'generalisation') out.push({ message: `Actors ${a.label} and ${b.label} cannot be associated; actors connect to use cases.` });
    if ((e.kind === 'include' || e.kind === 'extend') && (a?.kind !== 'usecase' || b?.kind !== 'usecase')) out.push({ message: `${e.kind} relationships join two use cases, not ${a?.label} and ${b?.label}.` });
  }
  for (const n of orphans(d)) out.push({ node: n.id, message: `${n.label} is not connected to anything.` });
  return out;
}

export function classProblems(d: Diagram): Problem[] {
  const out: Problem[] = [];
  for (const n of d.nodes.filter((x) => x.kind === 'class')) {
    if (!n.members?.length) out.push({ node: n.id, message: `Class ${n.label} has no attributes or operations; add them in braces.` });
  }
  for (const e of d.edges) {
    if (e.kind === 'generalisation' && e.from === e.to) out.push({ message: `${e.from} cannot inherit from itself.` });
  }
  // Generalisation cycles.
  const gen = { ...d, edges: d.edges.filter((e) => e.kind === 'generalisation') };
  for (const n of d.nodes) {
    const r = reachable(gen, n.id);
    if ([...r].some((x) => x !== n.id && reachable(gen, x).has(n.id))) {
      out.push({ node: n.id, message: `There is a cycle of inheritance through ${n.label}.` });
      break;
    }
  }
  for (const n of orphans(d)) out.push({ node: n.id, message: `${n.label} is not related to any other class.` });
  return out;
}

export function erProblems(d: Diagram): Problem[] {
  const out: Problem[] = [];
  for (const n of d.nodes.filter((x) => x.kind === 'entity')) {
    if (!n.members?.length) out.push({ node: n.id, message: `Entity ${n.label} has no attributes.` });
    else if (!n.members.some((m) => /\bPK\b/i.test(m))) out.push({ node: n.id, message: `Entity ${n.label} has no primary key (mark one attribute PK).` });
  }
  for (const e of d.edges) if (e.kind === 'relationship' && !e.label) out.push({ message: `The relationship between ${e.from} and ${e.to} needs a verb (write : enrols).` });
  for (const n of orphans(d)) out.push({ node: n.id, message: `${n.label} is not related to any other entity.` });
  return out;
}

export function cpmProblems(d: Diagram): Problem[] {
  const r = computeCpm(d);
  if (!r.ok) return [{ message: r.error ?? 'The network cannot be computed.' }];
  const out: Problem[] = [];
  const starts = r.activities.filter((a) => !a.predecessors.length);
  if (starts.length > 1) out.push({ message: `${starts.length} activities have no predecessor (${starts.map((a) => a.id).join(', ')}): fine if they really can all start on day 0.` });
  return out;
}

export function problemsFor(d: Diagram): Problem[] {
  const base = d.errors.map((e) => ({ message: `line ${e.line}: ${e.message}` }));
  switch (d.kind) {
    case 'dfd':
      return [...base, ...dfdProblems(d)];
    case 'bpmn':
    case 'activity':
      return [...base, ...bpmnProblems(d)];
    case 'state':
      return [...base, ...stateProblems(d)];
    case 'usecase':
      return [...base, ...usecaseProblems(d)];
    case 'class':
      return [...base, ...classProblems(d)];
    case 'er':
      return [...base, ...erProblems(d)];
    case 'cpm':
      return [...base, ...cpmProblems(d)];
    default:
      return [...base, ...orphans(d).map((n) => ({ node: n.id, message: `${n.label} is not connected to anything.` }))];
  }
}
