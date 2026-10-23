/**
 * The workspace for visualiser labs (engine E6): pick an algorithm, set its input, step
 * through the trace with pseudocode and variables, and answer questions graded from the trace.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type CheckSpec, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { ALGORITHMS, createVisualiserChecks, parseValues, runAlgorithm, type AlgorithmInput, type Graph, type Step, type Trace, type VizState } from '@cslab/engine-visualiser';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';
import { AlignmentVisual, AutomatonVisual, GridVisual, RulesVisual, TreeVisual, WeightedVisual } from './VisualiserVisuals';

const vizChecks = createVisualiserChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

interface Workspace extends VizState {
  algorithm: string;
}

export function VisualiserLab({ lab }: { lab: LabSpec<VizState> }) {
  const course = courseBySlug(lab.course);
  const algorithms = ((lab.config?.algorithms as string[] | undefined) ?? []).filter((a) => ALGORITHMS[a]);
  const editable = lab.config?.editableInput !== false;
  const starterInput: AlgorithmInput = lab.initialState?.input ?? {};
  const saved = useProgress((s) => s.workspaces[lab.id]) as Workspace | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();

  const [algorithm, setAlgorithm] = useState<string>(() => (saved?.algorithm && algorithms.includes(saved.algorithm) ? saved.algorithm : algorithms[0]));
  const [input, setInput] = useState<AlgorithmInput>(() => saved?.input ?? starterInput);
  const [answers, setAnswers] = useState<Record<string, string>>(() => saved?.answers ?? {});
  const [valuesText, setValuesText] = useState<string>(() => (saved?.input?.values ?? starterInput.values ?? []).join(', '));
  const [opsText, setOpsText] = useState<string>(() => (saved?.input?.ops ?? starterInput.ops ?? []).join('\n'));
  const [inputError, setInputError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);

  const algo = ALGORITHMS[algorithm];
  const trace = useMemo<Trace | { error: string }>(() => {
    try {
      return runAlgorithm(algorithm, input);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }, [algorithm, input]);
  const steps: Step[] = 'error' in trace ? [] : trace.steps;
  const step = steps[Math.min(stepIndex, Math.max(0, steps.length - 1))];

  useEffect(() => {
    setStepIndex(0);
    setPlaying(false);
  }, [algorithm, input]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setStepIndex((i) => {
        if (i >= steps.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 900 / speed);
    return () => clearInterval(t);
  }, [playing, speed, steps.length]);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { algorithm, input, answers } satisfies Workspace), 400);
    return () => clearTimeout(t);
  }, [algorithm, input, answers, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const applyValues = (text: string) => {
    setValuesText(text);
    try {
      const values = parseValues(text);
      setInputError(null);
      setInput((cur) => ({ ...cur, values }));
    } catch (err) {
      setInputError(err instanceof Error ? err.message : String(err));
    }
  };
  const applyOps = (text: string) => {
    setOpsText(text);
    setInput((cur) => ({ ...cur, ops: text.split('\n').map((l) => l.trim()).filter(Boolean) }));
  };

  const check = async () => {
    const r = await vizChecks.run(lab, { input, answers });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { algorithm, input, answers } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Reset the input and your answers to the starting state?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setInput(starterInput);
    setValuesText((starterInput.values ?? []).join(', '));
    setOpsText((starterInput.ops ?? []).join('\n'));
    setAnswers({});
    setResult(null);
    setInputError(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => c.type !== 'viz.input' && typeof c.id === 'string');
  const inputTasks = lab.checks.filter((c) => c.type === 'viz.input');

  if (!algo) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="text-2xl font-semibold">{lab.title}</h1>
        <p className="mt-2 text-ink-soft">This lab names an algorithm the visualiser does not have. This is a content error, not yours.</p>
      </div>
    );
  }

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
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-end gap-3">
              {algorithms.length > 1 ? (
                <label className="text-sm">
                  <span className="block text-xs text-ink-soft">Algorithm</span>
                  <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value)} className="input mt-1">
                    {algorithms.map((a) => (
                      <option key={a} value={a}>
                        {ALGORITHMS[a].name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="font-medium">{algo.name}</span>
              )}
              {(algo.inputKind === 'values' || algo.inputKind === 'values+target') && (
                <label className="text-sm flex-1 min-w-[180px]">
                  <span className="block text-xs text-ink-soft">Values</span>
                  <input type="text" value={valuesText} onChange={(e) => applyValues(e.target.value)} disabled={!editable} className="input mt-1 font-mono" spellCheck={false} aria-label="Values" />
                </label>
              )}
              {algo.inputKind === 'values+target' && (
                <label className="text-sm w-28">
                  <span className="block text-xs text-ink-soft">Target</span>
                  <input
                    type="number"
                    value={input.target ?? ''}
                    onChange={(e) => setInput((cur) => ({ ...cur, target: e.target.value === '' ? undefined : Number(e.target.value) }))}
                    disabled={!editable}
                    className="input mt-1 font-mono"
                    aria-label="Target"
                  />
                </label>
              )}
              {algo.inputKind === 'graph' && (
                <label className="text-sm">
                  <span className="block text-xs text-ink-soft">Start at</span>
                  <select value={input.start ?? input.graph?.nodes[0] ?? ''} onChange={(e) => setInput((cur) => ({ ...cur, start: e.target.value }))} disabled={!editable} className="input mt-1" aria-label="Start node">
                    {(input.graph?.nodes ?? []).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {algo.inputKind === 'automaton' && (
                <label className="text-sm flex-1 min-w-[180px]">
                  <span className="block text-xs text-ink-soft">Word (alphabet {'{'}{(input.automaton?.alphabet ?? []).join(', ')}{'}'})</span>
                  <input type="text" value={input.word ?? ''} onChange={(e) => setInput((cur) => ({ ...cur, word: e.target.value.trim() }))} disabled={!editable} className="input mt-1 font-mono" spellCheck={false} aria-label="Word" />
                </label>
              )}
              {algo.inputKind === 'weighted' && (
                <span className="text-sm text-ink-soft">
                  From <span className="font-medium text-ink">{input.start ?? input.weighted?.nodes[0]}</span> to <span className="font-medium text-ink">{input.goal ?? 'every node'}</span>
                </span>
              )}
              {algo.inputKind === 'alignment' && (
                <span className="text-sm text-ink-soft font-mono">
                  match {input.scoring?.match ?? 1}, mismatch {input.scoring?.mismatch ?? -1}, gap {input.scoring?.gap ?? -2}
                </span>
              )}
              {algo.inputKind === 'rules' && input.goal && (
                <span className="text-sm text-ink-soft">
                  Goal: <span className="font-mono text-ink">{input.goal}</span>
                </span>
              )}
            </div>
            {algo.inputKind === 'ops' && (
              <label className="block mt-3 text-sm">
                <span className="block text-xs text-ink-soft">Operations, one per line: add 5, remove, peek</span>
                <textarea value={opsText} onChange={(e) => applyOps(e.target.value)} disabled={!editable} rows={4} className="input mt-1 font-mono" spellCheck={false} aria-label="Operations" />
              </label>
            )}
            {inputError && <p className="mt-2 text-sm text-fault">{inputError}</p>}
            {'error' in trace && <p className="mt-2 text-sm text-fault">{trace.error}</p>}
          </div>

          <div className="rounded-lg border border-line bg-bench p-4">
            <Visual step={step} kind={algo.inputKind} input={input} />
            <p className="mt-3 text-[15px] min-h-[1.5em]" aria-live="polite">
              {step ? step.note : 'Nothing to show yet.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setStepIndex(0)} disabled={stepIndex === 0} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench disabled:opacity-50" aria-label="First step">
                ⏮
              </button>
              <button type="button" onClick={() => setStepIndex((i) => Math.max(0, i - 1))} disabled={stepIndex === 0} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench disabled:opacity-50" aria-label="Previous step">
                ◀ Back
              </button>
              <button type="button" onClick={() => setPlaying((p) => !p)} disabled={steps.length === 0 || stepIndex >= steps.length - 1} className="rounded-md bg-high px-4 py-1.5 text-sm text-white font-medium hover:bg-[#0c5a46] disabled:opacity-50">
                {playing ? 'Pause' : 'Play'}
              </button>
              <button type="button" onClick={() => setStepIndex((i) => Math.min(steps.length - 1, i + 1))} disabled={stepIndex >= steps.length - 1} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench disabled:opacity-50" aria-label="Next step">
                Next ▶
              </button>
              <button type="button" onClick={() => setStepIndex(Math.max(0, steps.length - 1))} disabled={stepIndex >= steps.length - 1} className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:bg-bench disabled:opacity-50" aria-label="Last step">
                ⏭
              </button>
              <label className="ml-auto text-xs text-ink-soft flex items-center gap-2">
                Speed
                <input type="range" min={0.5} max={4} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed" />
              </label>
            </div>
            <input type="range" min={0} max={Math.max(0, steps.length - 1)} value={Math.min(stepIndex, Math.max(0, steps.length - 1))} onChange={(e) => setStepIndex(Number(e.target.value))} className="mt-2 w-full" aria-label="Step" />
            <p className="text-xs text-ink-soft font-mono">
              Step {steps.length ? Math.min(stepIndex, steps.length - 1) + 1 : 0} of {steps.length}
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-[1fr_200px]">
            <div className="rounded-lg border border-line bg-surface p-3">
              <h2 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Pseudocode</h2>
              <ol className="mt-1 font-mono text-sm">
                {algo.pseudocode.map((line, i) => (
                  <li key={i} className={`whitespace-pre px-2 py-0.5 rounded ${step?.line === i + 1 ? 'bg-gold-soft border-l-2 border-gold' : ''}`}>
                    <span className="text-ink-faint select-none mr-2">{i + 1}</span>
                    {line}
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-lg border border-line bg-surface p-3">
              <h2 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Variables</h2>
              <table className="mt-1 font-mono text-sm w-full">
                <tbody>
                  {Object.entries(step?.vars ?? {}).map(([k, v]) => (
                    <tr key={k}>
                      <td className="text-ink-soft pr-2 py-0.5 align-top">{k}</td>
                      <td className="py-0.5 break-all">{v === null || v === undefined ? '–' : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v)}</td>
                    </tr>
                  ))}
                  {Object.keys(step?.vars ?? {}).length === 0 && (
                    <tr>
                      <td className="text-ink-faint">none</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Questions</h2>
            <p className="text-xs text-ink-soft mt-0.5">Step through the visualiser to find each answer.</p>
            <ol className="mt-3 space-y-3">
              {questions.map((q, i) => (
                <li key={String(q.id)}>
                  <label className="block text-sm">
                    <span className="block">
                      <span className="font-mono text-ink-faint mr-1">{i + 1}.</span>
                      {String(q.question ?? q.label)}
                    </span>
                    <input
                      type="text"
                      value={answers[String(q.id)] ?? ''}
                      onChange={(e) => {
                        setAnswers((a) => ({ ...a, [String(q.id)]: e.target.value }));
                        setResult(null);
                      }}
                      className="input mt-1 font-mono"
                      placeholder={placeholderFor(q)}
                      aria-label={String(q.question ?? q.label)}
                    />
                  </label>
                </li>
              ))}
              {inputTasks.map((q, i) => (
                <li key={`in-${i}`} className="text-sm rounded-md bg-bench border border-line px-3 py-2">
                  <span className="font-mono text-ink-faint mr-1">{questions.length + i + 1}.</span>
                  {String(q.question ?? q.label)} <span className="text-ink-soft">(set the input above)</span>
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

function placeholderFor(q: CheckSpec): string {
  if (q.type === 'viz.final' || (q.type === 'viz.state' && q.what === 'values')) return 'e.g. 1, 2, 3';
  if (q.type === 'viz.final' && q.what === 'order') return 'e.g. A, B, C';
  return 'your answer';
}

/* ----------------------------------------------------------------------------- visuals */

function Visual({ step, kind, input }: { step: Step | undefined; kind: string; input: AlgorithmInput }) {
  if (!step) return <div className="h-24" />;
  if (kind === 'graph' && input.graph) return <GraphVisual step={step} graph={input.graph} />;
  if (kind === 'automaton' && input.automaton) return <AutomatonVisual step={step} m={input.automaton} />;
  if (kind === 'weighted' && input.weighted) return <WeightedVisual step={step} g={input.weighted} />;
  if (kind === 'grid' && input.grid) return <GridVisual step={step} rows={input.grid} />;
  if (kind === 'tree' && input.tree) return <TreeVisual step={step} tree={input.tree} />;
  if (kind === 'alignment') return <AlignmentVisual step={step} a={(input.seqA ?? '').toUpperCase()} b={(input.seqB ?? '').toUpperCase()} />;
  if (kind === 'rules') return <RulesVisual step={step} input={input} />;
  if (kind === 'ops') return <OpsVisual step={step} />;
  return <ArrayVisual step={step} />;
}

function ArrayVisual({ step }: { step: Step }) {
  const v = step.values ?? [];
  const h = step.highlights ?? {};
  const max = Math.max(1, ...v.map((x) => Math.abs(x)));
  const inRange = (i: number) => (h.range ? i >= h.range[0] && i <= h.range[1] : true);
  return (
    <div className="flex items-end gap-1.5 min-h-[120px] overflow-x-auto pb-1">
      {v.map((x, i) => {
        const isCompare = h.compare?.includes(i);
        const isSwap = h.swap?.includes(i);
        const isFound = h.found?.includes(i);
        const isCurrent = h.current?.includes(i);
        const isSorted = h.sorted?.includes(i);
        const colour = isFound ? 'bg-high text-white' : isSwap ? 'bg-gold text-ink' : isCompare ? 'bg-gold-soft border-gold' : isCurrent ? 'bg-high-soft border-high' : isSorted ? 'bg-high-soft text-high' : 'bg-surface';
        return (
          <div key={i} className={`flex flex-col items-center ${inRange(i) ? '' : 'opacity-30'}`}>
            <div className={`w-9 rounded-t border border-line flex items-end justify-center font-mono text-sm ${colour}`} style={{ height: `${28 + (Math.abs(x) / max) * 72}px` }}>
              <span className="pb-1">{x}</span>
            </div>
            <span className="text-[10px] text-ink-faint font-mono mt-0.5">{i}</span>
          </div>
        );
      })}
      {v.length === 0 && <span className="text-sm text-ink-soft">Enter some values.</span>}
    </div>
  );
}

function OpsVisual({ step }: { step: Step }) {
  const items = step.stack ?? step.queue ?? [];
  const isStack = step.stack !== undefined;
  return (
    <div className="min-h-[120px]">
      <p className="text-xs text-ink-soft mb-2">{isStack ? 'Top of the stack is on the right.' : 'Front of the queue is on the left.'}</p>
      <div className="flex items-center gap-1.5">
        {!isStack && <span className="text-xs text-ink-faint mr-1">front →</span>}
        {items.map((x, i) => (
          <div key={i} className={`w-11 h-11 rounded border border-line grid place-items-center font-mono text-sm ${isStack && i === items.length - 1 ? 'bg-high-soft border-high' : !isStack && i === 0 ? 'bg-high-soft border-high' : 'bg-surface'}`}>
            {x}
          </div>
        ))}
        {items.length === 0 && <span className="text-sm text-ink-soft">(empty)</span>}
        {isStack && <span className="text-xs text-ink-faint ml-1">← top</span>}
      </div>
    </div>
  );
}

function GraphVisual({ step, graph }: { step: Step; graph: Graph }) {
  const n = graph.nodes.length;
  const w = 420;
  const hgt = 260;
  const cx = w / 2;
  const cy = hgt / 2;
  const rad = Math.min(w, hgt) / 2 - 36;
  const pos = new Map(graph.nodes.map((node, i) => [node, { x: cx + rad * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: cy + rad * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) }]));
  const visited = new Set(step.visited ?? []);
  const frontier = new Set(step.frontier ?? []);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${hgt}`} className="w-full max-w-[460px] h-auto" role="img" aria-label="Graph">
        {graph.edges.map(([a, b], i) => {
          const p = pos.get(a);
          const q = pos.get(b);
          if (!p || !q) return null;
          return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--color-line)" strokeWidth={2} />;
        })}
        {graph.nodes.map((node) => {
          const p = pos.get(node)!;
          const isCurrent = step.current === node;
          const fill = isCurrent ? 'var(--color-gold)' : visited.has(node) ? 'var(--color-high)' : frontier.has(node) ? 'var(--color-high-soft)' : 'var(--color-surface)';
          const text = isCurrent ? 'var(--color-ink)' : visited.has(node) ? '#fff' : 'var(--color-ink)';
          return (
            <g key={node}>
              <circle cx={p.x} cy={p.y} r={22} fill={fill} stroke={frontier.has(node) ? 'var(--color-high)' : 'var(--color-ink-faint)'} strokeWidth={frontier.has(node) ? 3 : 1.5} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fill={text}>
                {node.length > 7 ? node.slice(0, 7) : node}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-ink-soft">
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-high align-middle mr-1" /> visited
        <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-high bg-high-soft align-middle ml-3 mr-1" /> waiting
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-gold align-middle ml-3 mr-1" /> current
        {step.frontier && step.frontier.length > 0 && <span className="ml-3 font-mono">{step.stack !== undefined ? 'stack' : 'queue'}: {step.frontier.join(', ')}</span>}
      </p>
    </div>
  );
}
