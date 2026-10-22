/**
 * The workspace for diagram labs (engine E9): a text notation on the left, the rendered diagram
 * on the right, the studio's rule warnings, and for CPM networks the computed schedule.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { computeCpm, createDiagramChecks, layoutDiagram, parseDiagram, problemsFor, type Diagram, type DiagramConfig, type DiagramEdge, type DiagramNode, type DiagramState, type Layout } from '@cslab/engine-diagram';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const diagramChecks = createDiagramChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

const SYNTAX: Record<string, string[]> = {
  usecase: ['actor Student', 'usecase UC1 "Register for course"', 'UC2(Pay fees)', 'Student -> UC1', 'UC2 ..> UC3 : include', 'UC4 ..> UC2 : extend', 'Admin <|-- Registrar  (generalisation)'],
  class: ['class Student {', '  +name: string', '  +register(course)', '}', 'Student "1" -- "*" Enrolment : has', 'Person <|-- Student  (inheritance)', 'Order *-- Line  (composition)', 'Team o-- Member  (aggregation)', 'A ..> B  (dependency)'],
  sequence: ['participant Student', 'participant Portal', 'Student ->> Portal : login(user)', 'Portal -->> Student : token', 'alt success', '  ...', 'else failure', '  ...', 'end', 'loop every minute'],
  state: ['[*] --> Idle', 'Idle --> Running : start', 'Running --> Done : finish', 'Done --> [*]'],
  er: ['STUDENT {', '  int id PK', '  string name', '}', 'STUDENT ||--o{ ENROLMENT : enrols', '||  exactly one   |o  zero or one', '}|  one or more   }o  zero or more'],
  activity: ['S((Start))', 'A[Receive order]', 'G{Paid?}', 'G -->|yes| B[Issue receipt]', 'G -->|no| C[Send reminder]', 'E((End))'],
  bpmn: ['S((Start))', 'A[Receive order]', 'G{X Paid?}  exclusive', 'P{+}  parallel', 'G -->|yes| B[Issue receipt]', 'lane Cashier: A, B', 'E((End))'],
  dfd: ['entity Customer', 'process P1 "Validate order"', 'store D1 "Orders"', 'Customer -> P1 : order details', 'P1 -> D1 : valid order'],
  cpm: ['A "Survey site" 3', 'B "Order kit" 10 after A', 'C "Train staff" 2,4,12 after A   (PERT o,m,p)', 'F "Go live" 1 after B, C'],
  flow: ['A[Step one] --> B{Question?}', 'B -->|yes| C[Do this]', 'B -->|no| D[Do that]'],
};

export function DiagramLab({ lab }: { lab: LabSpec<DiagramState> }) {
  const course = courseBySlug(lab.course);
  const config = (lab.config ?? { kind: 'flow' }) as unknown as DiagramConfig;
  const saved = useProgress((s) => s.workspaces[lab.id]) as DiagramState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const initialSource = lab.initialState?.source ?? config.starter ?? '';
  const [source, setSource] = useState<string>(() => saved?.source ?? initialSource);
  const [answers, setAnswers] = useState<Record<string, string>>(() => saved?.answers ?? lab.initialState?.answers ?? {});
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [showSyntax, setShowSyntax] = useState(false);

  const diagram = useMemo(() => parseDiagram(source, config.kind), [source, config.kind]);
  const layout = useMemo(() => layoutDiagram(diagram), [diagram]);
  const problems = useMemo(() => problemsFor(diagram), [diagram]);
  const cpm = useMemo(() => (config.kind === 'cpm' ? computeCpm(diagram) : null), [diagram, config.kind]);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { source, answers } satisfies DiagramState), 400);
    return () => clearTimeout(t);
  }, [source, answers, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const check = async () => {
    const r = await diagramChecks.run(lab, { source, answers });
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
      nodes: diagram.nodes.length,
      edges: diagram.edges.length,
    };
    track('submitted', labObject(lab), outcome);
    track(r.passed ? 'passed' : 'failed', labObject(lab), outcome);
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { source, answers } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Replace your diagram with the starting text?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setSource(initialSource);
    setAnswers({});
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => c.type === 'diagram.answer' && typeof c.id === 'string');
  const kindName: Record<string, string> = { usecase: 'Use case diagram', class: 'Class diagram', sequence: 'Sequence diagram', state: 'State machine', er: 'Entity-relationship diagram', activity: 'Activity diagram', bpmn: 'BPMN process', dfd: 'Data flow diagram', cpm: 'Activity network (CPM/PERT)', flow: 'Flowchart' };

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
          <div className="rounded-lg border border-line bg-surface p-4">
            <button type="button" onClick={() => setShowSyntax((s) => !s)} className="text-sm font-medium w-full text-left" aria-expanded={showSyntax}>
              Notation for a {kindName[config.kind].toLowerCase()} {showSyntax ? '▾' : '▸'}
            </button>
            {showSyntax && (
              <pre className="mt-2 text-xs font-mono whitespace-pre-wrap text-ink-soft">{(SYNTAX[config.kind] ?? SYNTAX.flow).join('\n')}</pre>
            )}
          </div>
        </aside>

        <section className="order-0 lg:order-none min-w-0 space-y-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="rounded-lg border border-line bg-surface overflow-hidden flex flex-col">
              <div className="px-3 py-1.5 border-b border-line text-xs text-ink-soft flex justify-between">
                <span>{kindName[config.kind]} (text)</span>
                <span>{diagram.nodes.length} nodes, {diagram.edges.length} links</span>
              </div>
              <textarea value={source} onChange={(e) => { setSource(e.target.value); setResult(null); }} className="flex-1 min-h-[360px] p-3 font-mono text-[13px] leading-5 outline-none resize-y bg-surface" aria-label="Diagram notation" spellCheck={false} />
            </div>
            <div className="rounded-lg border border-line bg-bench p-2 overflow-auto min-h-[360px]">
              <DiagramSvg diagram={diagram} layout={layout} />
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3 text-sm" role="status" aria-label="Studio warnings">
            {problems.length === 0 ? (
              <p className="text-high">The studio finds no problems with the diagram.</p>
            ) : (
              <ul className="space-y-1 list-disc pl-4 text-ink-soft">
                {problems.slice(0, 8).map((p, i) => (
                  <li key={i}>{p.message}</li>
                ))}
                {problems.length > 8 && <li>…and {problems.length - 8} more.</li>}
              </ul>
            )}
          </div>
          {cpm && cpm.ok && (
            <div className="rounded-lg border border-line bg-surface p-3 text-sm overflow-x-auto">
              <h2 className="font-medium">Schedule: duration {cpm.duration}, critical path {cpm.criticalPath.join(' → ') || 'none'}{cpm.sigma !== undefined ? `, σ ≈ ${cpm.sigma.toFixed(2)}` : ''}</h2>
              <table className="mt-2 w-full font-mono text-xs">
                <thead>
                  <tr className="text-left text-ink-soft">
                    {['Activity', 'Dur', 'ES', 'EF', 'LS', 'LF', 'Slack'].map((h) => (
                      <th key={h} className="py-1 pr-3 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cpm.activities.map((a) => (
                    <tr key={a.id} className={a.critical ? 'text-fault font-medium' : ''}>
                      <td className="py-0.5 pr-3">{a.id} {a.label}</td>
                      <td className="py-0.5 pr-3">{a.duration}</td>
                      <td className="py-0.5 pr-3">{a.es}</td>
                      <td className="py-0.5 pr-3">{a.ef}</td>
                      <td className="py-0.5 pr-3">{a.ls}</td>
                      <td className="py-0.5 pr-3">{a.lf}</td>
                      <td className="py-0.5 pr-3">{a.slack}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cpm && !cpm.ok && <p className="text-sm text-fault">{cpm.error}</p>}
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
                      </span>
                      {Array.isArray(q.options) ? (
                        <select value={answers[String(q.id)] ?? ''} onChange={(e) => { setAnswers((a) => ({ ...a, [String(q.id)]: e.target.value })); setResult(null); }} className="input mt-1" aria-label={String(q.question ?? q.label)}>
                          <option value="">choose…</option>
                          {(q.options as string[]).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input type="text" value={answers[String(q.id)] ?? ''} onChange={(e) => { setAnswers((a) => ({ ...a, [String(q.id)]: e.target.value })); setResult(null); }} className="input mt-1 font-mono" aria-label={String(q.question ?? q.label)} spellCheck={false} />
                      )}
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
                Check my diagram
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
                    <span className="font-medium text-ink">In practice:</span> {lab.realityNote}
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

/* ----------------------------------------------------------------------------- rendering */

function DiagramSvg({ diagram, layout }: { diagram: Diagram; layout: Layout }) {
  if (diagram.kind === 'sequence') return <SequenceSvg diagram={diagram} layout={layout} />;
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const center = (id: string) => {
    const p = pos.get(id);
    return p ? { x: p.x + p.w / 2, y: p.y + p.h / 2, w: p.w, h: p.h } : null;
  };
  // Clip a line from a center to the node boundary (rectangle approximation).
  const edgePoint = (from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number }) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
    const sx = from.w / 2 / Math.abs(dx || 1e-9);
    const sy = from.h / 2 / Math.abs(dy || 1e-9);
    const s = Math.min(sx, sy);
    return { x: from.x + dx * s, y: from.y + dy * s };
  };
  const seenPairs = new Map<string, number>();
  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full h-auto" style={{ minWidth: Math.min(layout.width, 900) }} role="img" aria-label="Rendered diagram">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-ink)" />
        </marker>
        <marker id="open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="var(--color-ink)" strokeWidth="1.5" />
        </marker>
        <marker id="tri" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
          <path d="M 0 0 L 12 6 L 0 12 z" fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth="1.2" />
        </marker>
        <marker id="diamond" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="14" markerHeight="10" orient="auto-start-reverse">
          <path d="M 0 5 L 7 0 L 14 5 L 7 10 z" fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth="1.2" />
        </marker>
        <marker id="diamond-filled" viewBox="0 0 14 10" refX="13" refY="5" markerWidth="14" markerHeight="10" orient="auto-start-reverse">
          <path d="M 0 5 L 7 0 L 14 5 L 7 10 z" fill="var(--color-ink)" />
        </marker>
      </defs>
      {diagram.edges.map((e, i) => {
        const a = center(e.from);
        const b = center(e.to);
        if (!a || !b) return null;
        const key = [e.from, e.to].sort().join('|');
        const n = seenPairs.get(key) ?? 0;
        seenPairs.set(key, n + 1);
        const p1 = edgePoint(a, b);
        const p2 = edgePoint(b, a);
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2 + (n ? n * 14 : 0);
        const dashed = e.kind === 'dependency' || e.kind === 'include' || e.kind === 'extend' || e.kind === 'realisation' || e.kind === 'return';
        const marker = e.kind === 'generalisation' || e.kind === 'realisation' ? 'url(#tri)' : e.kind === 'aggregation' ? 'url(#diamond)' : e.kind === 'composition' ? 'url(#diamond-filled)' : e.kind === 'association' || e.kind === 'relationship' ? undefined : e.kind === 'dependency' || e.kind === 'include' || e.kind === 'extend' ? 'url(#open)' : 'url(#arrow)';
        const self = e.from === e.to;
        const label = e.kind === 'include' ? '«include»' : e.kind === 'extend' ? '«extend»' : e.label;
        return (
          <g key={i}>
            {self ? (
              <path d={`M ${a.x + a.w / 2} ${a.y - 8} C ${a.x + a.w / 2 + 40} ${a.y - 40}, ${a.x + a.w / 2 + 40} ${a.y + 30}, ${a.x + a.w / 2} ${a.y + 8}`} fill="none" stroke="var(--color-ink)" strokeWidth={1.3} markerEnd={marker} />
            ) : (
              <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="var(--color-ink)" strokeWidth={1.3} strokeDasharray={dashed ? '5 4' : undefined} markerEnd={marker} />
            )}
            {label && (
              <text x={mx} y={my - 4} fontSize={10} textAnchor="middle" fill="var(--color-ink-soft)" fontFamily="var(--font-sans)">
                <tspan style={{ paintOrder: 'stroke', stroke: 'var(--color-bench)', strokeWidth: 3 }}>{label}</tspan>
              </text>
            )}
            {(e.fromCard || e.toCard) && (
              <>
                {e.fromCard && (
                  <text x={p1.x + (p2.x - p1.x) * 0.12} y={p1.y + (p2.y - p1.y) * 0.12 - 4} fontSize={10} fill="var(--color-ink)" fontFamily="var(--font-mono)" textAnchor="middle">
                    {e.fromCard}
                  </text>
                )}
                {e.toCard && (
                  <text x={p2.x + (p1.x - p2.x) * 0.12} y={p2.y + (p1.y - p2.y) * 0.12 - 4} fontSize={10} fill="var(--color-ink)" fontFamily="var(--font-mono)" textAnchor="middle">
                    {e.toCard}
                  </text>
                )}
              </>
            )}
          </g>
        );
      })}
      {layout.nodes.map((p) => {
        const n = diagram.nodes.find((x) => x.id === p.id);
        return n ? <NodeShape key={p.id} node={n} p={p} kind={diagram.kind} /> : null;
      })}
    </svg>
  );
}

function NodeShape({ node: n, p, kind }: { node: DiagramNode; p: { x: number; y: number; w: number; h: number }; kind: Diagram['kind'] }) {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const label = n.label || n.id;
  const text = (y = cy + 4, size = 11, weight = 500) => (
    <text x={cx} y={y} fontSize={size} textAnchor="middle" fill="var(--color-ink)" fontFamily="var(--font-sans)" fontWeight={weight}>
      {label}
    </text>
  );
  switch (n.kind) {
    case 'actor':
      return (
        <g>
          <circle cx={cx} cy={p.y + 10} r={8} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={cx} y1={p.y + 18} x2={cx} y2={p.y + 38} stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={cx - 14} y1={p.y + 26} x2={cx + 14} y2={p.y + 26} stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={cx} y1={p.y + 38} x2={cx - 12} y2={p.y + 54} stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={cx} y1={p.y + 38} x2={cx + 12} y2={p.y + 54} stroke="var(--color-ink)" strokeWidth={1.3} />
          <text x={cx} y={p.y + 70} fontSize={10} textAnchor="middle" fill="var(--color-ink)" fontFamily="var(--font-sans)">
            {label}
          </text>
        </g>
      );
    case 'usecase':
    case 'process':
      return (
        <g>
          {n.kind === 'process' && kind === 'dfd' ? <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={14} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} /> : <ellipse cx={cx} cy={cy} rx={p.w / 2} ry={p.h / 2} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />}
          {n.kind === 'process' && kind === 'dfd' && (
            <text x={cx} y={p.y + 12} fontSize={9} textAnchor="middle" fill="var(--color-ink-faint)" fontFamily="var(--font-mono)">
              {n.id}
            </text>
          )}
          {text(n.kind === 'process' && kind === 'dfd' ? cy + 8 : cy + 4, 10)}
        </g>
      );
    case 'class':
    case 'interface':
    case 'entity': {
      const members = n.members ?? [];
      return (
        <g>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={p.x} y1={p.y + 26} x2={p.x + p.w} y2={p.y + 26} stroke="var(--color-ink)" strokeWidth={1} />
          <text x={cx} y={p.y + 17} fontSize={11} textAnchor="middle" fill="var(--color-ink)" fontFamily="var(--font-sans)" fontWeight={600} fontStyle={n.kind === 'interface' ? 'italic' : undefined}>
            {n.kind === 'interface' ? '«interface» ' : ''}{label}
          </text>
          {members.map((m, i) => (
            <text key={i} x={p.x + 8} y={p.y + 42 + i * 16} fontSize={10} fill="var(--color-ink)" fontFamily="var(--font-mono)" fontWeight={/\bPK\b/.test(m) ? 700 : 400}>
              {m}
            </text>
          ))}
        </g>
      );
    }
    case 'store':
      return (
        <g>
          <line x1={p.x} y1={p.y} x2={p.x + p.w} y2={p.y} stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={p.x} y1={p.y + p.h} x2={p.x + p.w} y2={p.y + p.h} stroke="var(--color-ink)" strokeWidth={1.3} />
          <line x1={p.x} y1={p.y} x2={p.x} y2={p.y + p.h} stroke="var(--color-ink)" strokeWidth={1.3} />
          <text x={p.x + 6} y={cy + 4} fontSize={9} fill="var(--color-ink-faint)" fontFamily="var(--font-mono)">
            {n.id}
          </text>
          {text(cy + 4, 10)}
        </g>
      );
    case 'start':
      return <circle cx={cx} cy={cy} r={kind === 'bpmn' || kind === 'activity' ? 14 : 10} fill={kind === 'bpmn' ? 'var(--color-surface)' : 'var(--color-ink)'} stroke="var(--color-ink)" strokeWidth={1.5} />;
    case 'end':
      return (
        <g>
          <circle cx={cx} cy={cy} r={13} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={kind === 'bpmn' ? 3 : 1.5} />
          {kind !== 'bpmn' && kind !== 'activity' && <circle cx={cx} cy={cy} r={8} fill="var(--color-ink)" />}
        </g>
      );
    case 'event':
      return (
        <g>
          <circle cx={cx} cy={cy} r={15} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          <circle cx={cx} cy={cy} r={12} fill="none" stroke="var(--color-ink)" strokeWidth={1} />
          <text x={cx} y={p.y + p.h + 12} fontSize={9} textAnchor="middle" fill="var(--color-ink)">
            {label}
          </text>
        </g>
      );
    case 'decision':
    case 'gateway-exclusive':
    case 'gateway-parallel':
    case 'gateway-inclusive': {
      const sym = n.kind === 'gateway-parallel' ? '+' : n.kind === 'gateway-inclusive' ? 'O' : n.kind === 'gateway-exclusive' ? '×' : '';
      return (
        <g>
          <polygon points={`${cx},${p.y} ${p.x + p.w},${cy} ${cx},${p.y + p.h} ${p.x},${cy}`} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          {sym ? (
            <>
              <text x={cx} y={cy + 6} fontSize={16} textAnchor="middle" fill="var(--color-ink)" fontWeight={700}>
                {sym}
              </text>
              {label && !/^(x|xor|and|or|\+|o)$/i.test(label) && (
                <text x={cx} y={p.y + p.h + 12} fontSize={9} textAnchor="middle" fill="var(--color-ink)">
                  {label}
                </text>
              )}
            </>
          ) : (
            text(cy + 4, 10)
          )}
        </g>
      );
    }
    case 'state':
      return (
        <g>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={12} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          {text()}
        </g>
      );
    case 'activity':
      if (kind === 'cpm')
        return (
          <g>
            <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
            <text x={cx} y={p.y + 16} fontSize={11} textAnchor="middle" fill="var(--color-ink)" fontWeight={600} fontFamily="var(--font-mono)">
              {n.id} · {n.duration ?? '?'}
            </text>
            <text x={cx} y={p.y + 34} fontSize={9} textAnchor="middle" fill="var(--color-ink-soft)">
              {label.length > 18 ? label.slice(0, 17) + '…' : label}
            </text>
          </g>
        );
      return (
        <g>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={10} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          {text()}
        </g>
      );
    case 'note':
      return (
        <g>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="var(--color-gold-soft)" stroke="var(--color-ink)" strokeWidth={1} />
          {text(cy + 4, 10, 400)}
        </g>
      );
    default:
      return (
        <g>
          <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={kind === 'dfd' ? 0 : 6} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} />
          {text()}
        </g>
      );
  }
}

function SequenceSvg({ diagram, layout }: { diagram: Diagram; layout: Layout }) {
  const lifelines = layout.lifelines ?? {};
  const messages = diagram.edges.filter((e): e is DiagramEdge & { seq: number } => e.seq !== undefined).sort((a, b) => a.seq - b.seq);
  const rowY = (seq: number) => 70 + seq * 34;
  return (
    <svg viewBox={`0 0 ${layout.width} ${layout.height}`} className="w-full h-auto" style={{ minWidth: Math.min(layout.width, 900) }} role="img" aria-label="Rendered sequence diagram">
      <defs>
        <marker id="sarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-ink)" />
        </marker>
        <marker id="sopen" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="var(--color-ink)" strokeWidth="1.5" />
        </marker>
      </defs>
      {layout.nodes.map((p) => {
        const n = diagram.nodes.find((x) => x.id === p.id)!;
        const x = lifelines[p.id];
        return (
          <g key={p.id}>
            <line x1={x} y1={p.y + p.h} x2={x} y2={layout.height - 10} stroke="var(--color-ink-faint)" strokeDasharray="4 4" />
            <rect x={p.x} y={p.y} width={p.w} height={p.h} fill="var(--color-surface)" stroke="var(--color-ink)" strokeWidth={1.3} rx={n.kind === 'actor' ? 18 : 3} />
            <text x={x} y={p.y + 22} fontSize={11} textAnchor="middle" fill="var(--color-ink)" fontWeight={600}>
              {n.label}
            </text>
          </g>
        );
      })}
      {diagram.fragments.map((f, i) => {
        const y1 = rowY(f.from) - 20;
        const y2 = rowY(f.to) + 10;
        return (
          <g key={i}>
            <rect x={20} y={y1} width={layout.width - 40} height={Math.max(20, y2 - y1)} fill="none" stroke="var(--color-ink-soft)" strokeDasharray="6 3" />
            <text x={26} y={y1 + 12} fontSize={10} fill="var(--color-ink-soft)" fontWeight={600}>
              {f.kind} {f.label ? `[${f.label}]` : ''}
            </text>
          </g>
        );
      })}
      {messages.map((m) => {
        const x1 = lifelines[m.from];
        const x2 = lifelines[m.to];
        if (x1 === undefined || x2 === undefined) return null;
        const y = rowY(m.seq);
        const self = x1 === x2;
        return (
          <g key={m.seq}>
            {self ? (
              <path d={`M ${x1} ${y} h 30 v 16 h -28`} fill="none" stroke="var(--color-ink)" strokeWidth={1.3} markerEnd="url(#sarrow)" />
            ) : (
              <line x1={x1} y1={y} x2={x2 + (x2 > x1 ? -4 : 4)} y2={y} stroke="var(--color-ink)" strokeWidth={1.3} strokeDasharray={m.kind === 'return' ? '5 4' : undefined} markerEnd={m.kind === 'return' ? 'url(#sopen)' : 'url(#sarrow)'} />
            )}
            <text x={self ? x1 + 36 : (x1 + x2) / 2} y={y - 5} fontSize={10} textAnchor={self ? 'start' : 'middle'} fill="var(--color-ink)" fontFamily="var(--font-mono)">
              {m.seq}. {m.label ?? ''}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
