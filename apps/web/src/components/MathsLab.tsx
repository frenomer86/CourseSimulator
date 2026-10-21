/**
 * The workspace for maths labs (engine E7): a set of tools (function plotter, truth tables,
 * sets, matrices, a random sampler, Euclid's algorithm) beside questions graded by the engine.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type CheckSpec, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  binomial,
  createMathsChecks,
  describeData,
  determinant,
  euclid,
  evaluate,
  inverse,
  matMul,
  modInverse,
  parseExpr,
  parseFormula,
  parseMatrix,
  parseSet,
  setOps,
  showFormula,
  showMatrix,
  transpose,
  truthTable,
  type MathsState,
} from '@cslab/engine-maths';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const mathsChecks = createMathsChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

type ToolId = 'plot' | 'logic' | 'sets' | 'matrix' | 'sample' | 'euclid' | 'stats';
const TOOL_LABEL: Record<ToolId, string> = { plot: 'Plot', logic: 'Truth table', sets: 'Sets', matrix: 'Matrices', sample: 'Sampler', euclid: 'Euclid', stats: 'Statistics' };

export function MathsLab({ lab }: { lab: LabSpec<MathsState> }) {
  const course = courseBySlug(lab.course);
  const tools = ((lab.config?.tools as ToolId[] | undefined) ?? ['plot']).filter((t) => t in TOOL_LABEL);
  const saved = useProgress((s) => s.workspaces[lab.id]) as MathsState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();

  const [answers, setAnswers] = useState<Record<string, string>>(() => saved?.answers ?? lab.initialState?.answers ?? {});
  const [tables, setTables] = useState<Record<string, Array<boolean | null>>>(() => saved?.tables ?? {});
  const [tool, setTool] = useState<ToolId>(tools[0] ?? 'plot');
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { answers, tables } satisfies MathsState), 400);
    return () => clearTimeout(t);
  }, [answers, tables, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const check = async () => {
    const r = await mathsChecks.run(lab, { answers, tables });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { answers, tables } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Clear all your answers?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setAnswers(lab.initialState?.answers ?? {});
    setTables({});
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => typeof c.id === 'string' || c.type === 'math.relation');

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

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
        <aside className="order-1 lg:order-none">
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

        <section className="order-0 lg:order-none min-w-0">
          <div className="rounded-lg border border-line bg-surface">
            <div className="flex flex-wrap gap-1 p-2 border-b border-line" role="tablist" aria-label="Tools">
              {tools.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tool === t} onClick={() => setTool(t)} className={`rounded-md px-3 py-1.5 text-sm font-medium ${tool === t ? 'bg-high text-white' : 'text-ink-soft hover:bg-bench'}`}>
                  {TOOL_LABEL[t]}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tool === 'plot' && <PlotTool initial={(lab.config?.plot as string[] | undefined) ?? ['x^2 - 2']} />}
              {tool === 'logic' && <LogicTool initial={String(lab.config?.formula ?? 'p -> q')} />}
              {tool === 'sets' && <SetsTool initialA={String(lab.config?.setA ?? '{1, 2, 3, 4}')} initialB={String(lab.config?.setB ?? '{3, 4, 5}')} universe={lab.config?.universe ? String(lab.config.universe) : ''} />}
              {tool === 'matrix' && <MatrixTool initialA={String(lab.config?.matrixA ?? '1 2; 3 4')} initialB={String(lab.config?.matrixB ?? '0 1; 1 0')} />}
              {tool === 'sample' && <SampleTool />}
              {tool === 'euclid' && <EuclidTool />}
              {tool === 'stats' && <StatsTool initial={String(lab.config?.data ?? '')} />}
            </div>
          </div>
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Questions</h2>
            <p className="text-xs text-ink-soft mt-0.5">Use the tools to work each one out.</p>
            <ol className="mt-3 space-y-3">
              {questions.map((q, i) => (
                <li key={`${String(q.id ?? q.label)}-${i}`}>
                  <Question
                    index={i + 1}
                    spec={q}
                    value={answers[String(q.id)] ?? ''}
                    table={tables[String(q.id)]}
                    onChange={(v) => {
                      setAnswers((a) => ({ ...a, [String(q.id)]: v }));
                      setResult(null);
                    }}
                    onTable={(t) => {
                      setTables((all) => ({ ...all, [String(q.id)]: t }));
                      setResult(null);
                    }}
                  />
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={check} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
                Check my answers
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
                    <span className="font-medium text-ink">Beyond the lab:</span> {lab.realityNote}
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

/* ----------------------------------------------------------------------------- questions */

function Question({
  index,
  spec,
  value,
  table,
  onChange,
  onTable,
}: {
  index: number;
  spec: CheckSpec;
  value: string;
  table: Array<boolean | null> | undefined;
  onChange: (v: string) => void;
  onTable: (t: Array<boolean | null>) => void;
}) {
  const text = String(spec.question ?? spec.label);
  if (spec.type === 'math.relation') {
    return (
      <div className="text-sm rounded-md bg-bench border border-line px-3 py-2">
        <span className="font-mono text-ink-faint mr-1">{index}.</span>
        {text} <span className="text-ink-soft">(uses your answers to {(spec.using as string[]).join(' and ')})</span>
      </div>
    );
  }
  if (spec.type === 'math.truthTable') {
    let tt;
    try {
      tt = truthTable(parseFormula(String(spec.formula)));
    } catch {
      return <p className="text-sm text-fault">This question's formula is invalid.</p>;
    }
    const current = table ?? tt.rows.map(() => null);
    return (
      <div className="text-sm">
        <span className="font-mono text-ink-faint mr-1">{index}.</span>
        {text}
        <table className="mt-2 font-mono text-xs border-collapse">
          <thead>
            <tr>
              {tt.variables.map((v) => (
                <th key={v} className="border border-line px-2 py-1 bg-bench">
                  {v}
                </th>
              ))}
              <th className="border border-line px-2 py-1 bg-high-soft text-high">result</th>
            </tr>
          </thead>
          <tbody>
            {tt.rows.map((r, i) => (
              <tr key={i}>
                {r.inputs.map((b, k) => (
                  <td key={k} className="border border-line px-2 py-0.5 text-center text-ink-soft">
                    {b ? 'T' : 'F'}
                  </td>
                ))}
                <td className="border border-line px-1 py-0.5 text-center">
                  <select
                    value={current[i] === null || current[i] === undefined ? '' : current[i] ? 'T' : 'F'}
                    onChange={(e) => {
                      const next = [...current];
                      next[i] = e.target.value === '' ? null : e.target.value === 'T';
                      onTable(next);
                    }}
                    className="bg-surface border border-line rounded px-1"
                    aria-label={`Row ${i + 1} result`}
                  >
                    <option value="">?</option>
                    <option value="T">T</option>
                    <option value="F">F</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const placeholder =
    spec.type === 'math.set' ? 'e.g. {1, 2, 3}' : spec.type === 'math.matrix' ? 'e.g. 1 2; 3 4' : spec.type === 'math.logic' ? 'e.g. ~p | q' : spec.type === 'math.expr' ? 'e.g. 3x^2 - 2' : 'your answer';
  return (
    <label className="block text-sm">
      <span className="block">
        <span className="font-mono text-ink-faint mr-1">{index}.</span>
        {text}
      </span>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="input mt-1 font-mono" placeholder={placeholder} aria-label={text} spellCheck={false} />
    </label>
  );
}

/* ----------------------------------------------------------------------------- tools */

function PlotTool({ initial }: { initial: string[] }) {
  const [exprs, setExprs] = useState<string[]>(initial.length ? initial : ['x^2 - 2']);
  const [xmin, setXmin] = useState(-5);
  const [xmax, setXmax] = useState(5);
  const w = 520;
  const h = 300;
  const COLOURS = ['var(--color-high)', 'var(--color-gold-deep)', 'var(--color-fault)', '#4f6fb5'];
  const curves = useMemo(() => {
    const out: Array<{ expr: string; points: Array<[number, number] | null>; error: string | null }> = [];
    for (const expr of exprs) {
      if (!expr.trim()) {
        out.push({ expr, points: [], error: null });
        continue;
      }
      try {
        const node = parseExpr(expr);
        const points: Array<[number, number] | null> = [];
        for (let i = 0; i <= 400; i++) {
          const x = xmin + ((xmax - xmin) * i) / 400;
          const y = evaluate(node, { x });
          points.push(Number.isFinite(y) ? [x, y] : null);
        }
        out.push({ expr, points, error: null });
      } catch (err) {
        out.push({ expr, points: [], error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }, [exprs, xmin, xmax]);
  const ys = curves.flatMap((c) => c.points.filter((p): p is [number, number] => !!p).map((p) => p[1]));
  const finite = ys.filter((y) => Math.abs(y) < 1e6);
  let ymin = Math.min(-1, ...finite);
  let ymax = Math.max(1, ...finite);
  if (ymax - ymin > 200) {
    ymin = Math.max(ymin, -100);
    ymax = Math.min(ymax, 100);
  }
  const pad = (ymax - ymin) * 0.08;
  ymin -= pad;
  ymax += pad;
  const sx = (x: number) => ((x - xmin) / (xmax - xmin)) * w;
  const sy = (y: number) => h - ((y - ymin) / (ymax - ymin)) * h;
  const path = (points: Array<[number, number] | null>) => {
    let d = '';
    let pen = false;
    for (const p of points) {
      if (!p || p[1] < ymin - 10 * (ymax - ymin) || p[1] > ymax + 10 * (ymax - ymin)) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  const ticks = (lo: number, hi: number) => {
    const span = hi - lo;
    const step = Math.pow(10, Math.floor(Math.log10(span))) * (span / Math.pow(10, Math.floor(Math.log10(span))) < 2 ? 0.25 : span / Math.pow(10, Math.floor(Math.log10(span))) < 5 ? 0.5 : 1);
    const out: number[] = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(Math.round(t * 1000) / 1000);
    return out;
  };
  return (
    <div>
      <div className="space-y-2">
        {exprs.map((e, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: COLOURS[i % COLOURS.length] }} />
            <span className="font-mono text-sm text-ink-soft">y =</span>
            <input type="text" value={e} onChange={(ev) => setExprs((all) => all.map((x, k) => (k === i ? ev.target.value : x)))} className="input font-mono flex-1" aria-label={`Function ${i + 1}`} spellCheck={false} />
            {exprs.length > 1 && (
              <button type="button" onClick={() => setExprs((all) => all.filter((_, k) => k !== i))} className="text-ink-faint hover:text-fault" aria-label="Remove function">
                ×
              </button>
            )}
          </div>
        ))}
        {exprs.length < 4 && (
          <button type="button" onClick={() => setExprs((all) => [...all, ''])} className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">
            Add another function
          </button>
        )}
        {curves.map((c, i) => c.error && <p key={i} className="text-xs text-fault">{c.expr}: {c.error}</p>)}
      </div>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <label>
          x from <input type="number" value={xmin} onChange={(e) => setXmin(Number(e.target.value))} className="input inline-block w-20 ml-1" aria-label="x minimum" />
        </label>
        <label>
          to <input type="number" value={xmax} onChange={(e) => setXmax(Number(e.target.value))} className="input inline-block w-20 ml-1" aria-label="x maximum" />
        </label>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-3 w-full h-auto rounded border border-line bg-bench" role="img" aria-label="Function plot">
        {ticks(xmin, xmax).map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} y1={0} x2={sx(t)} y2={h} stroke="var(--color-line)" strokeWidth={t === 0 ? 1.5 : 0.5} />
            <text x={sx(t) + 2} y={h - 3} fontSize={9} fill="var(--color-ink-faint)" fontFamily="var(--font-mono)">
              {t}
            </text>
          </g>
        ))}
        {ticks(ymin, ymax).map((t) => (
          <g key={`y${t}`}>
            <line x1={0} y1={sy(t)} x2={w} y2={sy(t)} stroke="var(--color-line)" strokeWidth={t === 0 ? 1.5 : 0.5} />
            <text x={3} y={sy(t) - 2} fontSize={9} fill="var(--color-ink-faint)" fontFamily="var(--font-mono)">
              {t}
            </text>
          </g>
        ))}
        {curves.map((c, i) => (
          <path key={i} d={path(c.points)} fill="none" stroke={COLOURS[i % COLOURS.length]} strokeWidth={2} />
        ))}
      </svg>
      <p className="mt-1 text-xs text-ink-soft">Functions of x. Use ^ for powers, sqrt, sin, cos, exp, ln, log, abs, and pi.</p>
    </div>
  );
}

function LogicTool({ initial }: { initial: string }) {
  const [formula, setFormula] = useState(initial);
  const [second, setSecond] = useState('');
  const parsed = useMemo(() => {
    try {
      const f = parseFormula(formula);
      const g = second.trim() ? parseFormula(second) : null;
      const vars = [...new Set([...truthTable(f).variables, ...(g ? truthTable(g).variables : [])])].sort();
      return { f, g, table: truthTable(f, vars), table2: g ? truthTable(g, vars) : null, error: null as string | null };
    } catch (err) {
      return { f: null, g: null, table: null, table2: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [formula, second]);
  const same = parsed.table && parsed.table2 ? parsed.table.rows.every((r, i) => r.output === parsed.table2!.rows[i].output) : null;
  return (
    <div>
      <label className="block text-sm">
        Formula
        <input type="text" value={formula} onChange={(e) => setFormula(e.target.value)} className="input mt-1 font-mono" aria-label="Formula" spellCheck={false} />
      </label>
      <label className="block text-sm mt-2">
        Compare with (optional)
        <input type="text" value={second} onChange={(e) => setSecond(e.target.value)} className="input mt-1 font-mono" aria-label="Second formula" spellCheck={false} placeholder="e.g. ~p | q" />
      </label>
      <p className="mt-1 text-xs text-ink-soft">Write not as ~ or ¬, and as &amp; or ∧, or as | or ∨, implies as -&gt;, iff as &lt;-&gt;, xor as ^.</p>
      {parsed.error && <p className="mt-2 text-sm text-fault">{parsed.error}</p>}
      {parsed.table && parsed.f && (
        <div className="mt-3 overflow-x-auto">
          <p className="text-sm font-mono mb-1">{showFormula(parsed.f)}{parsed.g ? `   versus   ${showFormula(parsed.g)}` : ''}</p>
          <table className="font-mono text-sm border-collapse">
            <thead>
              <tr>
                {parsed.table.variables.map((v) => (
                  <th key={v} className="border border-line px-2.5 py-1 bg-bench">
                    {v}
                  </th>
                ))}
                <th className="border border-line px-2.5 py-1 bg-high-soft text-high">A</th>
                {parsed.table2 && <th className="border border-line px-2.5 py-1 bg-gold-soft text-gold-deep">B</th>}
              </tr>
            </thead>
            <tbody>
              {parsed.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.inputs.map((b, k) => (
                    <td key={k} className="border border-line px-2.5 py-0.5 text-center text-ink-soft">
                      {b ? 'T' : 'F'}
                    </td>
                  ))}
                  <td className={`border border-line px-2.5 py-0.5 text-center font-medium ${r.output ? 'text-high' : 'text-ink-faint'}`}>{r.output ? 'T' : 'F'}</td>
                  {parsed.table2 && <td className={`border border-line px-2.5 py-0.5 text-center font-medium ${parsed.table2.rows[i].output ? 'text-high' : 'text-ink-faint'}`}>{parsed.table2.rows[i].output ? 'T' : 'F'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-sm">
            {parsed.table.rows.every((r) => r.output) ? 'A is a tautology (always true).' : parsed.table.rows.every((r) => !r.output) ? 'A is a contradiction (always false).' : 'A is a contingency (sometimes true).'}
            {same !== null && <span className="ml-2">{same ? 'A and B are logically equivalent.' : 'A and B differ.'}</span>}
          </p>
        </div>
      )}
    </div>
  );
}

function SetsTool({ initialA, initialB, universe }: { initialA: string; initialB: string; universe: string }) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const [u, setU] = useState(universe);
  const A = parseSet(a);
  const B = parseSet(b);
  const U = parseSet(u);
  const show = (s: string[]) => (s.length ? `{${s.join(', ')}}` : '∅');
  const only = (s: string[], not: string[]) => s.filter((x) => !not.includes(x));
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          A = <input type="text" value={a} onChange={(e) => setA(e.target.value)} className="input mt-1 font-mono" aria-label="Set A" />
        </label>
        <label className="text-sm">
          B = <input type="text" value={b} onChange={(e) => setB(e.target.value)} className="input mt-1 font-mono" aria-label="Set B" />
        </label>
        <label className="text-sm sm:col-span-2">
          Universe U (for complements, optional) = <input type="text" value={u} onChange={(e) => setU(e.target.value)} className="input mt-1 font-mono" aria-label="Universe" placeholder="e.g. {1, 2, 3, 4, 5, 6}" />
        </label>
      </div>
      <svg viewBox="0 0 320 180" className="mt-3 w-full max-w-sm h-auto" role="img" aria-label="Venn diagram">
        <circle cx={120} cy={90} r={70} fill="rgba(47,174,132,0.18)" stroke="var(--color-high)" />
        <circle cx={200} cy={90} r={70} fill="rgba(232,176,75,0.22)" stroke="var(--color-gold-deep)" />
        <text x={60} y={30} fontSize={12} fill="var(--color-high)">A</text>
        <text x={255} y={30} fontSize={12} fill="var(--color-gold-deep)">B</text>
        <text x={75} y={95} fontSize={11} textAnchor="middle" fontFamily="var(--font-mono)">{only(A, B).join(' ') || '·'}</text>
        <text x={160} y={95} fontSize={11} textAnchor="middle" fontFamily="var(--font-mono)">{setOps.intersection(A, B).join(' ') || '·'}</text>
        <text x={245} y={95} fontSize={11} textAnchor="middle" fontFamily="var(--font-mono)">{only(B, A).join(' ') || '·'}</text>
      </svg>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm font-mono">
        <dt className="text-ink-soft">A ∪ B</dt>
        <dd>{show(setOps.union(A, B))}</dd>
        <dt className="text-ink-soft">A ∩ B</dt>
        <dd>{show(setOps.intersection(A, B))}</dd>
        <dt className="text-ink-soft">A − B</dt>
        <dd>{show(setOps.difference(A, B))}</dd>
        <dt className="text-ink-soft">A ⊕ B</dt>
        <dd>{show(setOps.symmetricDifference(A, B))}</dd>
        {U.length > 0 && (
          <>
            <dt className="text-ink-soft">Aᶜ</dt>
            <dd>{show(setOps.complement(A, U))}</dd>
            <dt className="text-ink-soft">Bᶜ</dt>
            <dd>{show(setOps.complement(B, U))}</dd>
          </>
        )}
        <dt className="text-ink-soft">|A|, |B|, |P(A)|</dt>
        <dd>
          {A.length}, {B.length}, {setOps.powerSetSize(A)}
        </dd>
        <dt className="text-ink-soft">|A × B|</dt>
        <dd>{setOps.cartesianSize(A, B)}</dd>
      </dl>
    </div>
  );
}

function MatrixTool({ initialA, initialB }: { initialA: string; initialB: string }) {
  const [a, setA] = useState(initialA);
  const [b, setB] = useState(initialB);
  const out = useMemo(() => {
    try {
      const A = parseMatrix(a);
      const lines: Array<[string, string]> = [];
      lines.push([`A is ${A.length}×${A[0].length}`, '']);
      lines.push(['Aᵀ', showMatrix(transpose(A))]);
      if (A.length === A[0].length) {
        lines.push(['det A', String(Math.round(determinant(A) * 1e6) / 1e6)]);
        try {
          lines.push(['A⁻¹', showMatrix(inverse(A))]);
        } catch (err) {
          lines.push(['A⁻¹', err instanceof Error ? err.message : String(err)]);
        }
      }
      if (b.trim()) {
        const B = parseMatrix(b);
        try {
          lines.push(['A × B', showMatrix(matMul(A, B))]);
        } catch (err) {
          lines.push(['A × B', err instanceof Error ? err.message : String(err)]);
        }
        if (A.length === B.length && A[0].length === B[0].length) lines.push(['A + B', showMatrix(A.map((r, i) => r.map((v, j) => v + B[i][j])))]);
      }
      return { lines, error: null as string | null };
    } catch (err) {
      return { lines: [], error: err instanceof Error ? err.message : String(err) };
    }
  }, [a, b]);
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          A (rows separated by ;)
          <textarea value={a} onChange={(e) => setA(e.target.value)} rows={3} className="input mt-1 font-mono" aria-label="Matrix A" spellCheck={false} />
        </label>
        <label className="text-sm">
          B (optional)
          <textarea value={b} onChange={(e) => setB(e.target.value)} rows={3} className="input mt-1 font-mono" aria-label="Matrix B" spellCheck={false} />
        </label>
      </div>
      {out.error && <p className="mt-2 text-sm text-fault">{out.error}</p>}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm font-mono">
        {out.lines.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-soft">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SampleTool() {
  const [experiment, setExperiment] = useState<'dice' | 'coins' | 'binomial'>('dice');
  const [trials, setTrials] = useState(1000);
  const [n, setN] = useState(5);
  const [p, setP] = useState(0.3);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [ran, setRan] = useState(0);
  const run = () => {
    const c: Record<number, number> = {};
    for (let i = 0; i < trials; i++) {
      let v: number;
      if (experiment === 'dice') v = 1 + Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6);
      else if (experiment === 'coins') {
        v = 0;
        for (let k = 0; k < n; k++) v += Math.random() < 0.5 ? 1 : 0;
      } else {
        v = 0;
        for (let k = 0; k < n; k++) v += Math.random() < p ? 1 : 0;
      }
      c[v] = (c[v] ?? 0) + 1;
    }
    setCounts(c);
    setRan(trials);
  };
  const keys = Object.keys(counts).map(Number).sort((x, y) => x - y);
  const maxCount = Math.max(1, ...keys.map((k) => counts[k]));
  const theory = (k: number) => (experiment === 'dice' ? (6 - Math.abs(k - 7)) / 36 : experiment === 'coins' ? binomial(n, k, 0.5) : binomial(n, k, p));
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label>
          Experiment
          <select value={experiment} onChange={(e) => setExperiment(e.target.value as typeof experiment)} className="input mt-1">
            <option value="dice">Sum of two dice</option>
            <option value="coins">Heads in n coin flips</option>
            <option value="binomial">Successes in n trials with probability p</option>
          </select>
        </label>
        {experiment !== 'dice' && (
          <label>
            n <input type="number" min={1} max={50} value={n} onChange={(e) => setN(Number(e.target.value))} className="input mt-1 w-20" aria-label="n" />
          </label>
        )}
        {experiment === 'binomial' && (
          <label>
            p <input type="number" min={0} max={1} step={0.05} value={p} onChange={(e) => setP(Number(e.target.value))} className="input mt-1 w-24" aria-label="p" />
          </label>
        )}
        <label>
          Trials
          <select value={trials} onChange={(e) => setTrials(Number(e.target.value))} className="input mt-1">
            {[10, 100, 1000, 10000, 100000].map((t) => (
              <option key={t} value={t}>
                {t.toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={run} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
          Run
        </button>
      </div>
      {ran > 0 && (
        <div className="mt-3">
          <p className="text-xs text-ink-soft mb-1">{ran.toLocaleString()} trials. Bars: observed; marks: theory.</p>
          <div className="flex items-end gap-1 h-40">
            {keys.map((k) => (
              <div key={k} className="flex-1 flex flex-col items-center justify-end h-full relative" title={`${k}: ${counts[k]} (${((counts[k] / ran) * 100).toFixed(1)}%)`}>
                <div className="absolute left-0 right-0 border-t-2 border-gold-deep" style={{ bottom: `${(theory(k) * ran * 100) / maxCount}%` }} />
                <div className="w-full bg-high-bright rounded-t" style={{ height: `${(counts[k] / maxCount) * 100}%` }} />
                <span className="text-[10px] font-mono text-ink-soft mt-0.5">{k}</span>
              </div>
            ))}
          </div>
          <table className="mt-2 font-mono text-xs border-collapse">
            <thead>
              <tr>
                <th className="border border-line px-2 py-0.5 bg-bench">value</th>
                <th className="border border-line px-2 py-0.5 bg-bench">observed</th>
                <th className="border border-line px-2 py-0.5 bg-bench">theory</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <td className="border border-line px-2 py-0.5 text-center">{k}</td>
                  <td className="border border-line px-2 py-0.5 text-center">{(counts[k] / ran).toFixed(4)}</td>
                  <td className="border border-line px-2 py-0.5 text-center">{theory(k).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EuclidTool() {
  const [a, setA] = useState(240);
  const [b, setB] = useState(46);
  const [m, setM] = useState(26);
  const e = euclid(a, b);
  const inv = modInverse(a, m);
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-end gap-3">
        <label>
          a <input type="number" value={a} onChange={(ev) => setA(Number(ev.target.value))} className="input mt-1 w-28" aria-label="a" />
        </label>
        <label>
          b <input type="number" value={b} onChange={(ev) => setB(Number(ev.target.value))} className="input mt-1 w-28" aria-label="b" />
        </label>
        <label>
          modulus n <input type="number" value={m} onChange={(ev) => setM(Number(ev.target.value))} className="input mt-1 w-28" aria-label="modulus" />
        </label>
      </div>
      <table className="mt-3 font-mono text-xs border-collapse">
        <thead>
          <tr>
            {['a', 'b', 'q', 'r'].map((h) => (
              <th key={h} className="border border-line px-3 py-0.5 bg-bench">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {e.steps.map((s, i) => (
            <tr key={i}>
              <td className="border border-line px-3 py-0.5 text-center">{s.a}</td>
              <td className="border border-line px-3 py-0.5 text-center">{s.b}</td>
              <td className="border border-line px-3 py-0.5 text-center">{s.q}</td>
              <td className="border border-line px-3 py-0.5 text-center">{s.r}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 font-mono">
        gcd({a}, {b}) = {e.gcd}; {a}·({e.x}) + {b}·({e.y}) = {e.gcd}
      </p>
      <p className="mt-1 font-mono">
        {a}⁻¹ mod {m} = {inv === null ? 'does not exist (not coprime)' : inv}
      </p>
    </div>
  );
}

function StatsTool({ initial }: { initial: string }) {
  const [text, setText] = useState(initial || '2, 4, 4, 4, 5, 5, 7, 9');
  const values = text
    .split(/[,\s;]+/)
    .filter(Boolean)
    .map(Number)
    .filter((v) => !Number.isNaN(v));
  const d = describeData(values);
  const fmt = (v: number) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : '–');
  return (
    <div className="text-sm">
      <label className="block">
        Data
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} className="input mt-1 font-mono" aria-label="Data values" />
      </label>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono">
        <dt className="text-ink-soft">n</dt>
        <dd>{d.n}</dd>
        <dt className="text-ink-soft">mean</dt>
        <dd>{fmt(d.mean)}</dd>
        <dt className="text-ink-soft">median</dt>
        <dd>{fmt(d.median)}</dd>
        <dt className="text-ink-soft">variance (population)</dt>
        <dd>{fmt(d.variance)}</dd>
        <dt className="text-ink-soft">standard deviation</dt>
        <dd>{fmt(d.sd)}</dd>
        <dt className="text-ink-soft">min, max</dt>
        <dd>
          {fmt(d.min)}, {fmt(d.max)}
        </dd>
      </dl>
    </div>
  );
}
