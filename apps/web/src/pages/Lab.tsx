import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { createLogicChecks, emptyCircuit, type Circuit, type GateType } from '@cslab/engine-digital-logic';
import type { CodeState } from '@cslab/engine-code';
import type { ScenarioState } from '@cslab/engine-scenario';
import type { VizState } from '@cslab/engine-visualiser';
import type { MathsState } from '@cslab/engine-maths';
import type { NetState } from '@cslab/engine-network';
import type { ShellState } from '@cslab/engine-shell';
import type { HardwareState } from '@cslab/engine-hardware';
import type { CloudState } from '@cslab/engine-cloud';
import type { DiagramState } from '@cslab/engine-diagram';
import type { MobileState } from '@cslab/engine-mobile';
import { checkForTopic, courseBySlug, labById, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { LogicCanvas } from '../components/LogicCanvas';
import { TruthTablePanel } from '../components/TruthTablePanel';
import { Markdown } from '../components/Markdown';
import { NotFoundPage } from './NotFound';
import { ContestBanner, useContestEntry } from '../components/Contest';
import { SolutionShare } from '../components/SolutionShare';
import { QuestionsAbout } from './Forum';

const logicChecks = createLogicChecks();

// Each engine's workspace is loaded only when a lab of that kind is opened, so the first visit
// stays small and a learner on a slow connection downloads only the simulator they need.
const CodeLab = lazy(() => import('../components/CodeLab').then((m) => ({ default: m.CodeLab })));
const ScenarioLab = lazy(() => import('../components/ScenarioLab').then((m) => ({ default: m.ScenarioLab })));
const SqlLab = lazy(() => import('../components/SqlLab').then((m) => ({ default: m.SqlLab })));
const VisualiserLab = lazy(() => import('../components/VisualiserLab').then((m) => ({ default: m.VisualiserLab })));
const NetworkLab = lazy(() => import('../components/NetworkLab').then((m) => ({ default: m.NetworkLab })));
const TerminalLab = lazy(() => import('../components/TerminalLab').then((m) => ({ default: m.TerminalLab })));
const HardwareLab = lazy(() => import('../components/HardwareLab').then((m) => ({ default: m.HardwareLab })));
const CloudLab = lazy(() => import('../components/CloudLab').then((m) => ({ default: m.CloudLab })));
const DiagramLab = lazy(() => import('../components/DiagramLab').then((m) => ({ default: m.DiagramLab })));
const MobileLab = lazy(() => import('../components/MobileLab').then((m) => ({ default: m.MobileLab })));
const MathsLab = lazy(() => import('../components/MathsLab').then((m) => ({ default: m.MathsLab })));

function Loading({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-16" aria-busy>
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-ink-soft">Loading the simulator…</p>
    </div>
  );
}

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

export function LabPage() {
  const { id = '' } = useParams();
  const lab = labById(id);
  if (!lab) return <NotFoundPage />;
  const fallback = <Loading title={lab.title} />;
  if (lab.engine === 'E1') return <Suspense fallback={fallback}><CodeLab key={lab.id} lab={lab as LabSpec<CodeState>} /></Suspense>;
  if (lab.engine === 'E10') return <Suspense fallback={fallback}><ScenarioLab key={lab.id} lab={lab as LabSpec<ScenarioState>} /></Suspense>;
  if (lab.engine === 'E5') return <Suspense fallback={fallback}><SqlLab key={lab.id} lab={lab as LabSpec<{ sql: string }>} /></Suspense>;
  if (lab.engine === 'E6') return <Suspense fallback={fallback}><VisualiserLab key={lab.id} lab={lab as LabSpec<VizState>} /></Suspense>;
  if (lab.engine === 'E7') return <Suspense fallback={fallback}><MathsLab key={lab.id} lab={lab as LabSpec<MathsState>} /></Suspense>;
  if (lab.engine === 'E3') return <Suspense fallback={fallback}><NetworkLab key={lab.id} lab={lab as LabSpec<NetState>} /></Suspense>;
  if (lab.engine === 'E4') return <Suspense fallback={fallback}><TerminalLab key={lab.id} lab={lab as LabSpec<ShellState>} /></Suspense>;
  if (lab.engine === 'E8') return <Suspense fallback={fallback}><HardwareLab key={lab.id} lab={lab as LabSpec<HardwareState>} /></Suspense>;
  if (lab.engine === 'E12') return <Suspense fallback={fallback}><CloudLab key={lab.id} lab={lab as LabSpec<CloudState>} /></Suspense>;
  if (lab.engine === 'E9') return <Suspense fallback={fallback}><DiagramLab key={lab.id} lab={lab as LabSpec<DiagramState>} /></Suspense>;
  if (lab.engine === 'E11') return <Suspense fallback={fallback}><MobileLab key={lab.id} lab={lab as LabSpec<MobileState>} /></Suspense>;
  if (lab.engine !== 'E2') {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="text-2xl font-semibold">{lab.title}</h1>
        <p className="mt-2 text-ink-soft">This lab needs a simulator that is not built yet.</p>
      </div>
    );
  }
  return <LogicLab key={lab.id} lab={lab as LabSpec<Circuit>} />;
}

function LogicLab({ lab }: { lab: LabSpec<Circuit> }) {
  const course = courseBySlug(lab.course);
  const saved = useProgress((s) => s.workspaces[lab.id]) as Circuit | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();

  const [circuit, setCircuit] = useState<Circuit>(() => saved ?? lab.initialState ?? emptyCircuit());
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const [checking, setChecking] = useState(false);

  const palette = (lab.config?.palette as GateType[] | undefined) ?? ['INPUT', 'OUTPUT', 'AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR', 'XNOR'];
  const inputLabels = lab.config?.inputLabels as string[] | undefined;
  const outputLabels = lab.config?.outputLabels as string[] | undefined;

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, circuit), 400);
    return () => clearTimeout(t);
  }, [circuit, lab.id, saveWorkspace]);

  const onChange = useCallback((c: Circuit) => {
    setCircuit(c);
    setResult(null);
  }, []);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const check = async () => {
    setChecking(true);
    const r = await logicChecks.run(lab, circuit);
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: circuit, gates: circuit.nodes.length, wires: circuit.wires.length }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
    setChecking(false);
  };

  const resetBench = () => {
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setCircuit(lab.initialState ?? emptyCircuit());
    setResult(null);
  };

  const contest = useContestEntry('lab', lab.id, lab.course);
  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;

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

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)_300px]">
        {/* Instructions */}
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

        {/* Bench */}
        <section className="order-0 lg:order-none min-w-0">
          <LogicCanvas
            circuit={circuit}
            onChange={onChange}
            palette={palette}
            inputLabels={inputLabels}
            outputLabels={outputLabels}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={check}
              disabled={checking}
              className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60"
            >
              Check my circuit
            </button>
            <button
              type="button"
              onClick={resetBench}
              className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench"
            >
              Reset the bench
            </button>
            {result?.passed && (
              <span className="ml-auto flex flex-wrap gap-2">
                {topicCheck && (
                  <Link
                    to={`/courses/${lab.course}/units/${lab.unit}/topics/${lab.topicIndex}/check`}
                    className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench"
                  >
                    Take the topic check
                  </Link>
                )}
                {following && (
                  <Link to={`/labs/${following.id}`} className="rounded-md border border-high text-high px-4 py-2 font-medium hover:bg-high-soft">
                    Next lab: {following.title}
                  </Link>
                )}
              </span>
            )}
          </div>

          {result && (
            <div
              className={`mt-3 rounded-lg border p-4 ${
                result.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'
              }`}
              role="status"
            >
              <p className="font-medium">
                {result.passed
                  ? 'Correct. Every check passed.'
                  : `${result.checks.filter((c) => c.passed).length} of ${result.checks.length} checks passed.`}
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
              {result.passed && lab.realityNote && (
                <p className="mt-3 text-sm text-ink-soft border-t border-high/30 pt-3">
                  <span className="font-medium text-ink">On real hardware:</span> {lab.realityNote}
                </p>
              )}
            </div>
          )}
        </section>

        {/* Truth table and checks */}
        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Truth table</h2>
            <p className="text-xs text-ink-soft mt-0.5 mb-3">Computed live from your circuit.</p>
            <TruthTablePanel circuit={circuit} />
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">What will be checked</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-soft list-disc pl-4">
              {lab.checks.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
          </div>
          <QuestionsAbout labId={lab.id} title="Questions about this lab" />
          {contest.active.length === 0 && (
            <SolutionShare
              lab={lab}
              passed={!!progress?.passed}
              artefact={circuit}
              onOpen={(payload) => {
                setCircuit(payload as Circuit);
                setResult(null);
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
