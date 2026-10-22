/**
 * Checks for diagram labs, under the "diagram.*" namespace. The state is the notation text.
 *
 *   diagram.parses   {}                                   no syntax errors
 *   diagram.node     { kind?, pattern, count? }           nodes whose id or label matches the regex
 *   diagram.edge     { from, to, kind?, text?, fromCard?, toCard?, either?: true }
 *   diagram.count    { kind, min?, max? }
 *   diagram.rules    { level?: 'context'|'level0' }       the kind's well-formedness rules pass
 *   diagram.member   { class, member }                     a class/entity has a member matching the regex
 *   diagram.path     { from, to }                          to is reachable from from
 *   diagram.order    { messages: [regex...] }              sequence messages appear in this order
 *   diagram.cpm      { duration?, critical?: [ids], slack?: {id: n} }
 *   diagram.answer   { id, expected, tolerance?, options? }
 */

import { CheckRegistry, type CheckResult, type CheckSpec, type LabSpec } from '@cslab/lab-runtime';
import { computeCpm } from './cpm.js';
import { nodesMatching, parseDiagram, reachable, type Diagram, type DiagramKind, type EdgeKind, type NodeKind } from './model.js';
import { problemsFor } from './rules.js';

export interface DiagramConfig {
  kind: DiagramKind;
  starter?: string;
  reference?: string[];
}

export interface DiagramState {
  source: string;
  answers?: Record<string, string>;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}
function kindOf(lab: LabSpec<unknown>): DiagramKind {
  return ((lab.config as { kind?: DiagramKind } | undefined)?.kind ?? 'flow') as DiagramKind;
}
function parsed(state: DiagramState, lab: LabSpec<unknown>): Diagram {
  return parseDiagram(state.source ?? '', kindOf(lab));
}

const KIND_WORD: Partial<Record<NodeKind, string>> = { actor: 'actor', usecase: 'use case', class: 'class', entity: 'entity', process: 'process', store: 'data store', state: 'state', start: 'start node', end: 'end node', task: 'task', decision: 'decision', 'gateway-exclusive': 'exclusive gateway', 'gateway-parallel': 'parallel gateway', 'gateway-inclusive': 'inclusive gateway', event: 'event', participant: 'participant', activity: 'activity' };

export function createDiagramChecks(): CheckRegistry<DiagramState> {
  return new CheckRegistry<DiagramState>()
    .register('diagram.parses', async (state, spec, lab) => {
      const d = parsed(state, lab);
      if (!state.source?.trim()) return fail(spec, 'Write the diagram first.');
      return d.errors.length ? fail(spec, `The notation has ${d.errors.length} problem${d.errors.length === 1 ? '' : 's'}: ${d.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`) : pass(spec, `The diagram reads correctly: ${d.nodes.length} node${d.nodes.length === 1 ? '' : 's'}, ${d.edges.length} connection${d.edges.length === 1 ? '' : 's'}.`);
    })

    .register('diagram.node', async (state, spec, lab) => {
      const d = parsed(state, lab);
      // "label" is the check's own label, so the node pattern comes in "pattern".
      let hits = nodesMatching(d, String(spec.pattern));
      if (spec.kind) hits = hits.filter((n) => n.kind === spec.kind || (spec.kind === 'gateway' && n.kind.startsWith('gateway')));
      const need = Number(spec.count ?? 1);
      const what = `${spec.kind ? (KIND_WORD[spec.kind as NodeKind] ?? String(spec.kind)) + ' ' : ''}matching "${String(spec.pattern)}"`;
      return hits.length >= need ? pass(spec, String(spec.success ?? `Found ${hits.map((n) => n.label).join(', ')}.`)) : fail(spec, String(spec.message ?? (hits.length ? `Only ${hits.length} ${what}; ${need} needed.` : `No ${what} in the diagram.`)));
    })

    .register('diagram.count', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const n = d.nodes.filter((x) => x.kind === spec.kind || (spec.kind === 'gateway' && x.kind.startsWith('gateway'))).length;
      const word = KIND_WORD[spec.kind as NodeKind] ?? String(spec.kind);
      if (spec.min !== undefined && n < Number(spec.min)) return fail(spec, String(spec.message ?? `The diagram has ${n} ${word}${n === 1 ? '' : 's'}; at least ${String(spec.min)} expected.`));
      if (spec.max !== undefined && n > Number(spec.max)) return fail(spec, String(spec.message ?? `The diagram has ${n} ${word}s; at most ${String(spec.max)} expected.`));
      return pass(spec, `${n} ${word}${n === 1 ? '' : 's'}.`);
    })

    .register('diagram.edge', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const from = new RegExp(String(spec.from), 'i');
      const to = new RegExp(String(spec.to), 'i');
      const matchNode = (id: string, re: RegExp) => {
        const n = d.nodes.find((x) => x.id === id);
        return !!n && (re.test(n.id) || re.test(n.label));
      };
      const kinds = spec.kind ? (Array.isArray(spec.kind) ? (spec.kind as EdgeKind[]) : [spec.kind as EdgeKind]) : null;
      const ok = d.edges.filter((e) => {
        const direct = matchNode(e.from, from) && matchNode(e.to, to);
        const reverse = spec.either === true && matchNode(e.from, to) && matchNode(e.to, from);
        if (!direct && !reverse) return false;
        if (kinds && !kinds.includes(e.kind) && !(kinds.includes('association') && e.kind === 'directed')) return false;
        // "label" is the check's own label, so the edge text pattern comes in "text".
        if (spec.text !== undefined && !new RegExp(String(spec.text), 'i').test(e.label ?? '')) return false;
        if (spec.fromCard !== undefined && (direct ? e.fromCard : e.toCard) !== spec.fromCard) return false;
        if (spec.toCard !== undefined && (direct ? e.toCard : e.fromCard) !== spec.toCard) return false;
        return true;
      });
      if (ok.length) return pass(spec, String(spec.success ?? `${ok[0].from} ${ok[0].kind} ${ok[0].to}${ok[0].label ? ` (${ok[0].label})` : ''}.`));
      const near = d.edges.find((e) => matchNode(e.from, from) && matchNode(e.to, to));
      if (near) {
        const kindOk = !kinds || kinds.includes(near.kind) || (kinds.includes('association') && near.kind === 'directed');
        if (!kindOk) return fail(spec, String(spec.message ?? `${near.from} is connected to ${near.to}, but as ${near.kind}; it should be ${kinds!.join(' or ')}.`));
        if (spec.text !== undefined) return fail(spec, String(spec.message ?? `${near.from} to ${near.to} is labelled "${near.label ?? ''}"; expected something like "${String(spec.text)}".`));
        if (spec.fromCard !== undefined || spec.toCard !== undefined) return fail(spec, String(spec.message ?? `${near.from} to ${near.to} has multiplicities ${near.fromCard ?? '?'} to ${near.toCard ?? '?'}; expected ${String(spec.fromCard ?? '?')} to ${String(spec.toCard ?? '?')}.`));
      }
      return fail(spec, String(spec.message ?? `No connection from "${String(spec.from)}" to "${String(spec.to)}" in the diagram.`));
    })

    .register('diagram.rules', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const problems = spec.level ? [...d.errors.map((e) => ({ message: `line ${e.line}: ${e.message}` })), ...(await import('./rules.js')).dfdProblems(d, spec.level as 'context' | 'level0')] : problemsFor(d);
      return problems.length ? fail(spec, `${problems.length} rule${problems.length === 1 ? '' : 's'} broken: ${problems.slice(0, 4).map((p) => p.message).join(' ')}`) : pass(spec, 'The diagram follows the notation rules.');
    })

    .register('diagram.member', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const owners = nodesMatching(d, String(spec.class));
      if (!owners.length) return fail(spec, `No class or entity matching "${String(spec.class)}".`);
      const re = new RegExp(String(spec.member), 'i');
      const hit = owners.find((o) => (o.members ?? []).some((m) => re.test(m)));
      return hit ? pass(spec, `${hit.label} has ${hit.members!.find((m) => re.test(m))}.`) : fail(spec, String(spec.message ?? `${owners[0].label} has no member matching "${String(spec.member)}".`));
    })

    .register('diagram.path', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const a = nodesMatching(d, String(spec.from))[0];
      const b = nodesMatching(d, String(spec.to))[0];
      if (!a || !b) return fail(spec, `Both "${String(spec.from)}" and "${String(spec.to)}" must exist.`);
      return reachable(d, a.id).has(b.id) ? pass(spec, `${a.label} leads to ${b.label}.`) : fail(spec, String(spec.message ?? `There is no path from ${a.label} to ${b.label}.`));
    })

    .register('diagram.order', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const msgs = d.edges.filter((e) => e.seq !== undefined).sort((a, b) => a.seq! - b.seq!);
      const wanted = (spec.messages as string[]).map((m) => new RegExp(m, 'i'));
      let pos = 0;
      for (const w of wanted) {
        const idx = msgs.findIndex((m, i) => i >= pos && w.test(m.label ?? ''));
        if (idx === -1) return fail(spec, String(spec.message ?? `No message matching "${w.source}" after position ${pos} in the sequence.`));
        pos = idx + 1;
      }
      return pass(spec, `The ${wanted.length} messages appear in the right order.`);
    })

    .register('diagram.cpm', async (state, spec, lab) => {
      const d = parsed(state, lab);
      const r = computeCpm(d);
      if (!r.ok) return fail(spec, r.error ?? 'The network cannot be computed.');
      if (spec.duration !== undefined && Math.abs(r.duration - Number(spec.duration)) > Number(spec.tolerance ?? 0.01)) return fail(spec, String(spec.message ?? `The network's duration is ${r.duration}; expected ${String(spec.duration)}. Check the dependencies and durations.`), r);
      if (spec.critical) {
        const want = (spec.critical as string[]).map(String);
        const have = r.criticalPath;
        if (want.join(',') !== have.join(',')) return fail(spec, String(spec.message ?? `The critical path is ${have.join(' → ') || 'empty'}; expected ${want.join(' → ')}.`), r);
      }
      if (spec.slack) {
        for (const [id, s] of Object.entries(spec.slack as Record<string, number>)) {
          const a = r.activities.find((x) => x.id === id);
          if (!a) return fail(spec, `Activity ${id} is missing.`);
          if (Math.abs(a.slack - s) > 0.01) return fail(spec, `Activity ${id} has slack ${a.slack}; expected ${s}.`);
        }
      }
      return pass(spec, `Duration ${r.duration}, critical path ${r.criticalPath.join(' → ')}.`);
    })

    .register('diagram.answer', async (state, spec) => {
      const text = (state.answers?.[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      if (typeof spec.expected === 'number') {
        const n = Number(text.replace(/[^\d.-]/g, ''));
        if (!Number.isFinite(n)) return fail(spec, `"${text}" is not a number.`);
        return Math.abs(n - spec.expected) <= Number(spec.tolerance ?? 0.01) + Math.abs(spec.expected) * Number(spec.relative ?? 0) ? pass(spec, String(spec.success ?? `Right: ${spec.expected}.`)) : fail(spec, String(spec.message ?? 'Not quite. Check the working.'));
      }
      const accepted = (Array.isArray(spec.expected) ? spec.expected : [spec.expected]).map((x) => String(x).trim().toLowerCase());
      const norm = text.toLowerCase().replace(/\s*(->|→|,)\s*/g, ',').replace(/\s+/g, ' ');
      return accepted.some((a) => a.replace(/\s*(->|→|,)\s*/g, ',').replace(/\s+/g, ' ') === norm) ? pass(spec, String(spec.success ?? 'Correct.')) : fail(spec, String(spec.message ?? 'Not the expected answer.'));
    });
}
