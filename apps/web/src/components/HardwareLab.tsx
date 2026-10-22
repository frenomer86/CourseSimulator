/**
 * The workspace for hardware labs (engine E8). The lab's config.mode picks the bench:
 * a DC circuit with a multimeter, PC assembly, connector matching, a BIOS screen, or an Arduino-style board.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  buildSketchProgram,
  createHardwareChecks,
  formatQuantity,
  isLit,
  parseBoardOutput,
  placementProblem,
  pinTimeline,
  resistanceBetween,
  solve,
  validateBuild,
  type BoardComponent,
  type Component,
  type HardwareConfig,
  type HardwareState,
  type Measurement,
} from '@cslab/engine-hardware';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { runners, useRunnerStatus, warmRunner } from '../lib/runners';
import { Markdown } from './Markdown';
import { CodeEditor } from './CodeEditor';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const hwChecks = createHardwareChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

interface Layout {
  width?: number;
  height?: number;
  nodes: Record<string, [number, number]>;
  parts: Record<string, { a: [number, number]; b: [number, number] }>;
  wires?: Array<Array<[number, number]>>;
}

export function HardwareLab({ lab }: { lab: LabSpec<HardwareState> }) {
  const course = courseBySlug(lab.course);
  const config = (lab.config ?? {}) as unknown as HardwareConfig;
  const saved = useProgress((s) => s.workspaces[lab.id]) as HardwareState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const initial = useMemo<HardwareState>(() => ({ ...(lab.initialState ?? {}), source: lab.initialState?.source ?? config.starter }), [lab, config.starter]);
  const [state, setState] = useState<HardwareState>(() => ({ ...initial, ...(saved ?? {}) }));
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const update = (patch: Partial<HardwareState>) => {
    setState((s) => ({ ...s, ...patch }));
    setResult(null);
  };

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, state), 400);
    return () => clearTimeout(t);
  }, [state, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const check = async () => {
    const r = await hwChecks.run(lab, state);
    setResult(r);
    recordResult(lab, r, hintsShown);
    const outcome = {
      passed: r.passed,
      score: Math.round(r.score * 10000) / 100,
      checksPassed: r.checks.filter((c) => c.passed).length,
      checksTotal: r.checks.length,
      failedChecks: r.checks.filter((c) => !c.passed).map((c) => c.type),
      hintsUsed: hintsShown,
      attempt: (progress?.attempts ?? 0) + 1,
      durationS: secondsSince(openedAt.current),
    };
    track('submitted', labObject(lab), outcome);
    track(r.passed ? 'passed' : 'failed', labObject(lab), outcome);
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { ...state, run: undefined } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Put the bench back to its starting state?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setState(initial);
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => c.type === 'hw.answer' && typeof c.id === 'string');
  const interact = (action: string, detail?: Record<string, unknown>) => track('interacted', labObject(lab), undefined, { action, ...detail });

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-6">
      <nav className="text-sm text-ink-soft flex flex-wrap items-center gap-x-2">
        <Link to="/#courses" className="hover:text-ink">
          Courses
        </Link>
        <span>/</span>
        {course && (
          <Link to={`/courses/${course.slug}`} className="hover:text-ink">
            {course.title}
          </Link>
        )}
        {course && unit && (
          <>
            <span>/</span>
            <Link to={`/courses/${course.slug}/units/${unit.number}`} className="hover:text-ink">
              Unit {unit.number}
            </Link>
          </>
        )}
        <span>/</span>
        <span>{LEVEL_LABEL[lab.level]}</span>
      </nav>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{lab.title}</h1>
        <span className="text-sm text-ink-soft">
          {lab.topic}, about {lab.estimatedMinutes} min
          {progress?.passed && <span className="ml-3 text-high font-medium">Completed</span>}
        </span>
      </div>

      <ContestBanner entry={contest} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
        <aside className="order-1 lg:order-none space-y-4">
          <details open className="rounded-lg border border-line bg-surface lg:open">
            <summary className="cursor-pointer px-4 py-3 font-medium lg:pointer-events-none">Instructions</summary>
            <div className="px-4 pb-4 -mt-1">
              <Markdown source={lab.instructions} className="text-[15px]" />
              {lab.hints.length > 0 && (
                <div className="mt-4 border-t border-line pt-3">
                  {lab.hints.slice(0, hintsShown).map((h, i) => (
                    <p key={i} className="text-sm rounded-md bg-gold-soft border border-gold/40 px-3 py-2 mb-2 leading-relaxed">
                      <span className="font-medium">Hint {i + 1}.</span> {h}
                    </p>
                  ))}
                  {hintsShown < lab.hints.length ? (
                    <button
                      type="button"
                      onClick={() => {
                        track('asked-for-hint', labObject(lab), { hintIndex: hintsShown + 1, hintsTotal: lab.hints.length });
                        setHintsShown((n) => n + 1);
                      }}
                      className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink"
                    >
                      {hintsShown === 0 ? 'Show a hint' : 'Show another hint'} ({lab.hints.length - hintsShown} left)
                    </button>
                  ) : (
                    <span className="text-sm text-ink-faint">No more hints.</span>
                  )}
                </div>
              )}
            </div>
          </details>
        </aside>

        <section className="order-0 lg:order-none min-w-0 space-y-3">
          {config.mode === 'circuit' && config.circuit && <CircuitBench config={config} state={state} update={update} interact={interact} />}
          {config.mode === 'assembly' && config.build && <AssemblyBench config={config} state={state} update={update} interact={interact} />}
          {config.mode === 'match' && config.match && <MatchBench config={config} state={state} update={update} />}
          {config.mode === 'bios' && config.bios && <BiosBench config={config} state={state} update={update} />}
          {config.mode === 'board' && config.board && <BoardBench config={config} state={state} update={update} interact={interact} />}
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Tasks</h2>
            {questions.length > 0 && (
              <ol className="mt-3 space-y-3">
                {questions.map((q, i) => (
                  <li key={String(q.id)}>
                    <label className="block text-sm">
                      <span className="block">
                        <span className="font-mono text-ink-faint mr-1">{i + 1}.</span>
                        {String(q.question ?? q.label)}
                        {q.unit ? <span className="text-ink-faint"> ({String(q.unit)})</span> : null}
                      </span>
                      <input type="text" value={state.answers?.[String(q.id)] ?? ''} onChange={(e) => update({ answers: { ...(state.answers ?? {}), [String(q.id)]: e.target.value } })} className="input mt-1 font-mono" placeholder="e.g. 4.7k or 12m" aria-label={String(q.question ?? q.label)} spellCheck={false} />
                    </label>
                  </li>
                ))}
              </ol>
            )}
            <h3 className="mt-3 text-xs uppercase tracking-wide text-ink-faint font-medium">What will be checked</h3>
            <ul className="mt-1 space-y-1 text-sm text-ink-soft list-disc pl-4">
              {lab.checks.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={check} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
                Check my work
              </button>
              <button type="button" onClick={reset} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
                Start again
              </button>
            </div>
            {result && (
              <div className={`mt-3 rounded-lg border p-3 ${result.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`} role="status">
                <p className="font-medium text-sm">
                  {result.passed ? 'Correct. Every check passed.' : `${result.checks.filter((c) => c.passed).length} of ${result.checks.length} checks passed.`}
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {result.checks.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={`font-mono shrink-0 ${c.passed ? 'text-high' : 'text-fault'}`}>{c.passed ? '✓' : '✗'}</span>
                      <span>
                        <span className="font-medium">{c.label}.</span> {c.message}
                      </span>
                    </li>
                  ))}
                </ul>
                {result.passed && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {topicCheck && (
                      <Link to={`/courses/${lab.course}/units/${lab.unit}/topics/${lab.topicIndex}/check`} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench">
                        Take the topic check
                      </Link>
                    )}
                    {following && (
                      <Link to={`/labs/${following.id}`} className="rounded-md border border-high text-high px-3 py-1.5 text-sm font-medium hover:bg-high-soft">
                        Next lab: {following.title}
                      </Link>
                    )}
                  </div>
                )}
                {result.passed && lab.realityNote && (
                  <p className="mt-3 text-sm text-ink-soft border-t border-high/30 pt-3">
                    <span className="font-medium text-ink">On the real bench:</span> {lab.realityNote}
                  </p>
                )}
              </div>
            )}
          </div>
          <QuestionsAbout labId={lab.id} title="Questions about this lab" />
        </aside>
      </div>
    </div>
  );
}

type BenchProps = { config: HardwareConfig; state: HardwareState; update: (patch: Partial<HardwareState>) => void; interact?: (action: string, detail?: Record<string, unknown>) => void };

/* ----------------------------------------------------------------------------- circuit */

function CircuitBench({ config, state, update, interact }: BenchProps) {
  const circuit = config.circuit!;
  const layout = (config.layout ?? { nodes: {}, parts: {} }) as Layout;
  const values = state.values ?? {};
  const switches = state.switches ?? {};
  const sol = useMemo(() => solve(circuit, values, switches), [circuit, values, switches]);
  const [meter, setMeter] = useState<'V' | 'I' | 'R'>('V');
  const [probes, setProbes] = useState<{ a?: string; b?: string; component?: string }>({});
  const W = layout.width ?? 520;
  const H = layout.height ?? 300;

  const reading = useMemo(() => {
    if (meter === 'I') {
      if (!probes.component) return null;
      return { value: sol.ok ? sol.currents[probes.component] ?? NaN : NaN, unit: 'A' };
    }
    if (!probes.a || !probes.b) return null;
    if (meter === 'V') return { value: sol.ok ? (sol.voltages[probes.a] ?? 0) - (sol.voltages[probes.b] ?? 0) : NaN, unit: 'V' };
    return { value: resistanceBetween(circuit, probes.a, probes.b, values, switches), unit: 'Ω' };
  }, [meter, probes, sol, circuit, values, switches]);

  // Record each new reading as a measurement the checks can see.
  useEffect(() => {
    if (!reading || !Number.isFinite(reading.value)) return;
    const m: Measurement = meter === 'I' ? { kind: 'I', component: probes.component, reading: reading.value } : { kind: meter, a: probes.a, b: probes.b, reading: reading.value };
    const prev = state.measurements ?? [];
    const last = prev[prev.length - 1];
    if (last && last.kind === m.kind && last.a === m.a && last.b === m.b && last.component === m.component) return;
    update({ measurements: [...prev.slice(-50), m] });
    interact?.('measure', { kind: m.kind });
  }, [reading?.value, meter, probes]); // eslint-disable-line react-hooks/exhaustive-deps

  const clickNode = (n: string) => {
    if (meter === 'I') return;
    setProbes((p) => (!p.a || (p.a && p.b) ? { a: n } : p.a === n ? p : { a: p.a, b: n }));
  };
  const clickPart = (c: Component) => {
    if (c.type === 'SW') {
      update({ switches: { ...switches, [c.id]: !(switches[c.id] ?? c.closed ?? false) } });
      interact?.('toggle', { id: c.id });
      return;
    }
    if (meter === 'I') setProbes({ component: c.id });
  };

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-bench p-2">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Circuit diagram. Click nodes to place the probes, click a switch to toggle it.">
          {(layout.wires ?? []).map((w, i) => (
            <polyline key={i} points={w.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} />
          ))}
          {circuit.components.map((c) => {
            const pos = layout.parts[c.id];
            if (!pos) return null;
            const [x1, y1] = pos.a;
            const [x2, y2] = pos.b;
            const mx = (x1 + x2) / 2;
            const my = (y1 + y2) / 2;
            const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
            const len = Math.hypot(x2 - x1, y2 - y1);
            const lit = isLit(c, sol);
            const closed = switches[c.id] ?? c.closed ?? false;
            const measuring = meter === 'I' && probes.component === c.id;
            const valueText = c.type === 'R' ? formatQuantity(values[c.id] ?? c.value ?? 0, 'Ω') : c.type === 'V' ? formatQuantity(values[c.id] ?? c.value ?? 0, 'V') : c.type === 'I' ? formatQuantity(values[c.id] ?? c.value ?? 0, 'A') : '';
            return (
              <g key={c.id} transform={`translate(${mx} ${my}) rotate(${angle})`} onClick={() => clickPart(c)} className={c.type === 'SW' || meter === 'I' ? 'cursor-pointer' : ''}>
                <line x1={-len / 2} y1={0} x2={len / 2} y2={0} stroke="var(--color-ink)" strokeWidth={1.5} />
                {c.type === 'R' && <rect x={-18} y={-7} width={36} height={14} fill={measuring ? 'var(--color-gold-soft)' : 'var(--color-surface)'} stroke="var(--color-ink)" strokeWidth={1.5} />}
                {c.type === 'LAMP' && (
                  <g>
                    <circle r={11} fill={lit ? '#ffd84d' : 'var(--color-surface)'} stroke="var(--color-ink)" strokeWidth={1.5} />
                    <line x1={-7} y1={-7} x2={7} y2={7} stroke="var(--color-ink)" />
                    <line x1={-7} y1={7} x2={7} y2={-7} stroke="var(--color-ink)" />
                  </g>
                )}
                {(c.type === 'V' || c.type === 'I') && (
                  <g>
                    <circle r={12} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.5} />
                    {c.type === 'V' ? (
                      <>
                        <text x={-6} y={4} fontSize={11} textAnchor="middle" fill="var(--color-ink)">+</text>
                        <text x={6} y={4} fontSize={11} textAnchor="middle" fill="var(--color-ink)">−</text>
                      </>
                    ) : (
                      <path d="M -7 0 L 7 0 M 3 -4 L 7 0 L 3 4" fill="none" stroke="var(--color-ink)" strokeWidth={1.5} />
                    )}
                  </g>
                )}
                {(c.type === 'D' || c.type === 'LED') && (
                  <g>
                    <polygon points="-8,-8 -8,8 7,0" fill={c.type === 'LED' && lit ? '#ff4d4d' : 'var(--color-surface)'} stroke="var(--color-ink)" strokeWidth={1.5} />
                    <line x1={7} y1={-8} x2={7} y2={8} stroke="var(--color-ink)" strokeWidth={1.5} />
                    {c.type === 'LED' && lit && <circle r={16} fill="#ff4d4d" opacity={0.25} />}
                  </g>
                )}
                {c.type === 'SW' && (
                  <g>
                    <line x1={-12} y1={0} x2={12} y2={closed ? 0 : -9} stroke="var(--color-high)" strokeWidth={2} />
                    <circle cx={-12} r={2.5} fill="var(--color-ink)" />
                    <circle cx={12} r={2.5} fill="var(--color-ink)" />
                  </g>
                )}
                <g transform={`rotate(${-angle})`}>
                  <text y={-16} fontSize={10} textAnchor="middle" fill="var(--color-ink)" fontFamily="var(--font-mono)">
                    {c.label ?? c.id}
                  </text>
                  {valueText && (
                    <text y={24} fontSize={9} textAnchor="middle" fill="var(--color-ink-soft)" fontFamily="var(--font-mono)">
                      {valueText}
                    </text>
                  )}
                </g>
              </g>
            );
          })}
          {Object.entries(layout.nodes).map(([n, [x, y]]) => {
            const isA = probes.a === n && meter !== 'I';
            const isB = probes.b === n && meter !== 'I';
            return (
              <g key={n} onClick={() => clickNode(n)} className={meter === 'I' ? '' : 'cursor-pointer'}>
                <circle cx={x} cy={y} r={isA || isB ? 7 : 4} fill={isA ? '#d33' : isB ? '#222' : 'var(--color-ink)'} />
                <text x={x + 8} y={y - 6} fontSize={9} fill="var(--color-ink-soft)" fontFamily="var(--font-mono)">
                  {n === '0' ? 'GND' : n}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-surface p-3 text-sm">
          <h2 className="font-medium">Multimeter</h2>
          <div className="mt-2 flex gap-1" role="radiogroup" aria-label="Multimeter mode">
            {(['V', 'I', 'R'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={meter === m} onClick={() => { setMeter(m); setProbes({}); }} className={`rounded-md px-3 py-1 text-sm font-medium ${meter === m ? 'bg-high text-white' : 'border border-line hover:bg-bench'}`}>
                {m === 'V' ? 'Volts' : m === 'I' ? 'Amps' : 'Ohms'}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-ink-soft">
            {meter === 'I' ? 'Click a component to put the ammeter in series with it.' : meter === 'V' ? 'Click a node for the red probe, then another for the black probe.' : 'Click two nodes; sources are switched off while measuring resistance.'}
          </p>
          <div className="mt-2 rounded-md bg-[#1b1f23] text-[#9fe0b5] font-mono text-2xl px-3 py-2 text-right" aria-live="polite" aria-label="Multimeter reading">
            {reading ? formatQuantity(reading.value, reading.unit) : '--.--'}
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            {meter === 'I' ? (probes.component ? `through ${probes.component}` : 'no component selected') : `red: ${probes.a ?? '–'}   black: ${probes.b ?? '–'}`}
            {!sol.ok && <span className="text-fault"> · {sol.error}</span>}
          </p>
        </div>
        {config.adjustable && Object.keys(config.adjustable).length > 0 && (
          <div className="rounded-lg border border-line bg-surface p-3 text-sm">
            <h2 className="font-medium">Adjust</h2>
            {Object.entries(config.adjustable).map(([id, a]) => {
              const comp = circuit.components.find((c) => c.id === id);
              const v = values[id] ?? comp?.value ?? a.min;
              return (
                <label key={id} className="block mt-2">
                  <span className="flex justify-between">
                    <span>{comp?.label ?? id}</span>
                    <span className="font-mono">{formatQuantity(v, a.unit ?? (comp?.type === 'V' ? 'V' : comp?.type === 'I' ? 'A' : 'Ω'))}</span>
                  </span>
                  <input type="range" min={a.min} max={a.max} step={a.step ?? (a.max - a.min) / 100} value={v} onChange={(e) => update({ values: { ...values, [id]: Number(e.target.value) } })} className="w-full" aria-label={`${comp?.label ?? id} value`} />
                  <input type="text" defaultValue={v} key={v} onBlur={(e) => { const n = Number(e.target.value.replace(/k$/i, '000').replace(/m$/i, 'e-3')); if (Number.isFinite(n)) update({ values: { ...values, [id]: n } }); }} className="input mt-1 font-mono w-32" aria-label={`${comp?.label ?? id} exact value`} />
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- assembly */

function AssemblyBench({ config, state, update, interact }: BenchProps) {
  const build = config.build!;
  const placements = state.placements ?? {};
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const v = useMemo(() => validateBuild(build, placements), [build, placements]);
  const placedIds = new Set(Object.values(placements));
  const kinds = [...new Set(build.parts.map((p) => p.kind))];
  const place = (slotId: string) => {
    if (!selected) {
      setMessage('Pick a part from the bin first.');
      return;
    }
    const problem = placementProblem(build, placements, slotId, selected);
    if (problem) {
      setMessage(problem);
      interact?.('reject', { slot: slotId, part: selected });
      return;
    }
    const part = build.parts.find((p) => p.id === selected)!;
    setMessage(`${part.name} fitted in ${build.slots.find((s) => s.id === slotId)?.label}.`);
    update({ placements: { ...placements, [slotId]: selected } });
    setSelected(null);
    interact?.('place', { slot: slotId, part: selected });
  };
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_1fr]">
      <div className="rounded-lg border border-line bg-surface p-3 text-sm">
        <h2 className="font-medium">Parts bin</h2>
        {kinds.map((k) => (
          <div key={k} className="mt-2">
            <h3 className="text-xs uppercase tracking-wide text-ink-faint">{k}</h3>
            <ul className="mt-1 space-y-1">
              {build.parts.filter((p) => p.kind === k).map((p) => {
                const used = placedIds.has(p.id);
                return (
                  <li key={p.id}>
                    <button type="button" disabled={used} onClick={() => setSelected(p.id)} className={`w-full text-left rounded-md border px-2 py-1 ${used ? 'opacity-40 border-line' : selected === p.id ? 'border-high bg-high-soft' : 'border-line hover:bg-bench'}`} aria-pressed={selected === p.id}>
                      <span className="font-medium">{p.name}</span>
                      <span className="block text-xs text-ink-soft">
                        {Object.entries(p.specs).map(([a, b]) => `${a}: ${String(b)}`).join(' · ')}
                        {p.watts ? ` · ${p.watts} W` : ''}
                        {p.price ? ` · GH₵${p.price}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <div className="rounded-lg border border-line bg-bench p-3 text-sm">
          <h2 className="font-medium">Bench</h2>
          <p className="text-xs text-ink-soft">Select a part, then click the slot it goes in. The bench refuses parts that do not fit.</p>
          <ul className="mt-2 space-y-1.5">
            {build.slots.map((s) => {
              const part = build.parts.find((p) => p.id === placements[s.id]);
              const bad = v.problems.find((p) => p.slot === s.id);
              return (
                <li key={s.id} className={`rounded-md border px-2 py-1.5 bg-surface ${bad ? 'border-fault' : part ? 'border-high' : 'border-dashed border-line'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => place(s.id)} className="text-left flex-1">
                      <span className="font-medium">{s.label}</span>
                      {s.required && !part && <span className="text-ink-faint"> (required)</span>}
                      <span className="block text-xs text-ink-soft">{part ? part.name : `empty, takes ${s.accepts.join(' / ')}`}</span>
                    </button>
                    {part && (
                      <button type="button" onClick={() => { const next = { ...placements }; delete next[s.id]; update({ placements: next }); }} className="text-xs text-ink-faint hover:text-fault" aria-label={`Remove ${part.name}`}>
                        remove
                      </button>
                    )}
                  </div>
                  {bad && <p className="mt-1 text-xs text-fault">{bad.message}</p>}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="rounded-lg border border-line bg-surface p-3 text-sm" role="status">
          {message && <p>{message}</p>}
          <p className="mt-1 text-xs text-ink-soft">
            Power: about {v.wattage.used} W drawn{v.wattage.rating ? `, ${v.wattage.rating} W supply ${v.wattage.ok ? '(enough headroom)' : '(too small)'}` : ', no supply fitted yet'}.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- match */

function MatchBench({ config, state, update }: BenchProps) {
  const m = config.match!;
  const matches = state.matches ?? {};
  return (
    <div className="rounded-lg border border-line bg-surface p-3 text-sm">
      <h2 className="font-medium">Match each connector to its purpose</h2>
      <table className="mt-2 w-full">
        <tbody>
          {m.items.map((it) => (
            <tr key={it.id} className="border-t border-line">
              <td className="py-2 pr-3 w-16 text-2xl text-center" aria-hidden="true">{it.picture ?? '▣'}</td>
              <td className="py-2 pr-3 font-medium">{it.name}</td>
              <td className="py-2">
                <select value={matches[it.id] ?? ''} onChange={(e) => update({ matches: { ...matches, [it.id]: e.target.value } })} className="input" aria-label={`Purpose of ${it.name}`}>
                  <option value="">choose…</option>
                  {m.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------------------- bios */

function BiosBench({ config, state, update }: BenchProps) {
  const settings = state.settings ?? {};
  return (
    <div className="rounded-lg border-4 border-[#2b3a67] bg-[#0b1b4a] text-[#e8eefc] font-mono text-sm p-4" role="group" aria-label="BIOS setup utility">
      <div className="flex justify-between border-b border-[#6b7bb0] pb-1 text-[#ffd84d]">
        <span>Aptio Setup Utility (simulated)</span>
        <span>Advanced · Boot · Security</span>
      </div>
      <dl className="mt-3 space-y-2">
        {config.bios!.settings.map((s) => (
          <div key={s.key} className="grid grid-cols-[1fr_auto] items-center gap-3">
            <dt>
              {s.label}
              {s.help && <span className="block text-xs text-[#9fb0e0]">{s.help}</span>}
            </dt>
            <dd>
              <select value={settings[s.key] ?? s.options[0]} onChange={(e) => update({ settings: { ...settings, [s.key]: e.target.value } })} className="bg-[#16307a] text-[#e8eefc] border border-[#6b7bb0] rounded px-2 py-1" aria-label={s.label}>
                {s.options.map((o) => (
                  <option key={o} value={o}>
                    [{o}]
                  </option>
                ))}
              </select>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs text-[#9fb0e0]">F10: Save and Exit (press Check my work on the right). Settings you do not change keep their defaults.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------- board */

function BoardBench({ config, state, update, interact }: BenchProps) {
  const board = config.board!;
  const runnerState = useRunnerStatus((s) => s.javascript);
  const [running, setRunning] = useState(false);
  useEffect(() => warmRunner('javascript'), []);
  const source = state.source ?? '';
  const run = state.run;
  const runSketch = async () => {
    setRunning(true);
    const program = buildSketchProgram(source, board);
    const r = await runners.get('javascript')!.run(program, '', 10000);
    const parsed = parseBoardOutput(r.stdout, r.stderr, r.timedOut ? 'The sketch ran out of time. Is there a loop that never calls delay()?' : r.error);
    update({ run: parsed });
    setRunning(false);
    interact?.('run', { ok: !parsed.error });
  };
  const outputs = board.components.filter((c) => ['led', 'rgb-led', 'buzzer', 'relay', 'motor', 'servo'].includes(c.kind));
  const inputs = board.components.filter((c) => !outputs.includes(c));
  const endMs = run?.endMs ?? board.runMs ?? 5000;
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line bg-surface overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-line text-sm">
          <span className="font-medium">sketch.ino <span className="text-ink-faint font-normal">(Arduino C, a subset)</span></span>
          <button type="button" onClick={runSketch} disabled={running || runnerState === 'loading'} className="rounded-md bg-high px-4 py-1.5 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
            {running ? 'Running…' : 'Upload and run'}
          </button>
        </div>
        <CodeEditor value={source} onChange={(v) => update({ source: v })} language="javascript" ariaLabel="Sketch editor" />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-line bg-bench p-3 text-sm">
          <h2 className="font-medium">Board: Arduino {board.board ?? 'Uno'}</h2>
          <ul className="mt-2 space-y-1.5">
            {board.components.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <ComponentGlyph c={c} run={run} endMs={endMs} />
                <span>
                  <span className="font-medium">{c.label ?? c.kind}</span> on pin {String(c.pin)}
                  {c.schedule && <span className="block text-xs text-ink-soft">{describeSchedule(c)}</span>}
                  {!c.schedule && c.value !== undefined && <span className="block text-xs text-ink-soft">reads {c.value}</span>}
                </span>
              </li>
            ))}
          </ul>
          {run && outputs.length > 0 && (
            <div className="mt-3">
              <h3 className="text-xs uppercase tracking-wide text-ink-faint">Pin timeline (0 to {Math.round(endMs)} ms)</h3>
              <svg viewBox={`0 0 400 ${outputs.length * 22 + 4}`} className="w-full h-auto mt-1" role="img" aria-label="Pin states over time">
                {outputs.map((c, k) => {
                  const tl = pinTimeline(run, c.pin, c.kind === 'servo' ? 'servo' : 'digital');
                  const pwm = pinTimeline(run, c.pin, 'pwm');
                  const y = k * 22 + 2;
                  const scale = 340 / Math.max(1, endMs);
                  const segs: JSX.Element[] = [];
                  const series = tl.length ? tl : pwm.map((e) => ({ t: e.t, v: e.v / 255 }));
                  for (let i = 0; i < series.length; i++) {
                    const t0 = series[i].t;
                    const t1 = series[i + 1]?.t ?? endMs;
                    const level = c.kind === 'servo' ? series[i].v / 180 : series[i].v;
                    segs.push(<rect key={i} x={55 + t0 * scale} y={y + 2 + (1 - Math.min(1, level)) * 14} width={Math.max(0.5, (t1 - t0) * scale)} height={Math.max(1, Math.min(1, level) * 14)} fill="var(--color-high)" />);
                  }
                  return (
                    <g key={k}>
                      <text x={0} y={y + 14} fontSize={10} fill="var(--color-ink)" fontFamily="var(--font-mono)">
                        pin {String(c.pin)}
                      </text>
                      <line x1={55} y1={y + 16} x2={395} y2={y + 16} stroke="var(--color-line)" />
                      {segs}
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          {inputs.length > 0 && <p className="mt-2 text-xs text-ink-faint">Inputs follow the schedule shown; the run lasts {Math.round(board.runMs ?? 5000)} ms of board time.</p>}
        </div>
        <div className="rounded-lg border border-line bg-[#1b1f23] text-[#e6edf3] font-mono text-xs p-3 min-h-[160px]">
          <div className="flex justify-between text-white/60 mb-1">
            <span>Serial Monitor</span>
            <span>9600 baud</span>
          </div>
          {!run && <p className="text-white/50">Upload and run the sketch to see output here.</p>}
          {run?.error && <p className="text-[#ff8a8a] whitespace-pre-wrap">Error: {run.error}</p>}
          {run && !run.error && <pre className="whitespace-pre-wrap max-h-64 overflow-y-auto">{run.serial || '(no serial output)'}</pre>}
          {run && !run.error && <p className="text-white/50 mt-1">Ran {run.loops} loop() calls in {Math.round(run.endMs)} ms of board time.</p>}
        </div>
      </div>
    </div>
  );
}

function describeSchedule(c: BoardComponent): string {
  const s = c.schedule ?? [];
  if (c.kind === 'button') {
    const presses: string[] = [];
    for (let i = 0; i < s.length; i++) if (s[i][1]) presses.push(`${(s[i][0] / 1000).toFixed(1)}–${((s[i + 1]?.[0] ?? Infinity) / 1000).toFixed(1)} s`);
    return presses.length ? `pressed at ${presses.join(', ')}` : 'never pressed';
  }
  return s.map(([t, v]) => `${(t / 1000).toFixed(1)} s: ${v}`).join(', ');
}

function ComponentGlyph({ c, run, endMs }: { c: BoardComponent; run?: HardwareState['run']; endMs: number }) {
  if (c.kind === 'led' || c.kind === 'rgb-led' || c.kind === 'relay' || c.kind === 'buzzer' || c.kind === 'motor') {
    const tl = run ? pinTimeline(run, c.pin) : [];
    const pwm = run ? pinTimeline(run, c.pin, 'pwm') : [];
    const last = tl.length ? tl[tl.length - 1].v : pwm.length ? pwm[pwm.length - 1].v / 255 : 0;
    const on = last > 0;
    void endMs;
    return <span className={`inline-block w-5 h-5 rounded-full border ${on ? 'bg-[#ff4d4d] border-[#ff4d4d] shadow-[0_0_8px_#ff4d4d]' : 'bg-surface border-line'}`} aria-label={`${c.label ?? c.kind} ${on ? 'on' : 'off'}`} />;
  }
  if (c.kind === 'servo') {
    const angles = run ? pinTimeline(run, c.pin, 'servo') : [];
    const a = angles.length ? angles[angles.length - 1].v : 90;
    return (
      <svg width={22} height={22} viewBox="0 0 22 22" aria-label={`servo at ${a} degrees`}>
        <circle cx={11} cy={11} r={9} fill="var(--color-surface)" stroke="var(--color-ink)" />
        <line x1={11} y1={11} x2={11 + 8 * Math.cos(((180 - a) * Math.PI) / 180)} y2={11 - 8 * Math.sin(((180 - a) * Math.PI) / 180)} stroke="var(--color-high)" strokeWidth={2} />
      </svg>
    );
  }
  if (c.kind === 'button') return <span className="inline-block w-5 h-5 rounded-sm border border-ink bg-surface" aria-hidden="true" />;
  return <span className="inline-block w-5 h-5 rounded-sm border border-line bg-gold-soft" aria-hidden="true" />;
}
