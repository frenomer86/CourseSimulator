/**
 * The workspace for scenario labs (engine E10): a branching case study. The learner reads the
 * situation, examines evidence, writes where asked, and makes decisions that have consequences.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  choiceAvailable,
  choose,
  createScenarioChecks,
  currentNode,
  isFinished,
  setAnswer,
  startScenario,
  validateScenario,
  viewEvidence,
  wordCount,
  type ScenarioSpec,
  type ScenarioState,
} from '@cslab/engine-scenario';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const scenarioChecks = createScenarioChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

const KIND_LABEL: Record<string, string> = {
  email: 'Email',
  log: 'Log',
  policy: 'Policy',
  interview: 'Interview',
  document: 'Document',
  photo: 'Photo',
  message: 'Message',
  report: 'Report',
};

export function ScenarioLab({ lab }: { lab: LabSpec<ScenarioState> }) {
  const course = courseBySlug(lab.course);
  const rawSpec = lab.config?.scenario;
  const spec = useMemo(() => (validateScenario(rawSpec) ? (rawSpec as ScenarioSpec) : null), [rawSpec]);
  const saved = useProgress((s) => s.workspaces[lab.id]) as ScenarioState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();

  const [state, setState] = useState<ScenarioState>(() => (saved && spec && spec.nodes.some((n) => n.id === saved.current) ? saved : spec ? startScenario(spec) : { current: '', path: [], flags: [], score: 0, viewed: [], answers: {} }));
  const [openEvidence, setOpenEvidence] = useState<string | null>(null);
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, state), 300);
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
  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;

  if (!spec) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-16">
        <h1 className="text-2xl font-semibold">{lab.title}</h1>
        <p className="mt-2 text-ink-soft">This case study's content is not valid. This is a content error, not yours.</p>
      </div>
    );
  }

  const node = currentNode(spec, state);
  const finished = isFinished(spec, state);
  const stepNumber = state.path.length + 1;

  const decide = (choiceId: string) => {
    const next = choose(spec, state, choiceId);
    if (next === state) return;
    setState(next);
    setOpenEvidence(null);
    setResult(null);
    track('interacted', labObject(lab), { step: stepNumber, choice: choiceId }, { action: 'decide', node: node.id });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const examine = (id: string) => {
    setOpenEvidence((cur) => (cur === id ? null : id));
    if (!state.viewed.includes(id)) {
      setState((s) => viewEvidence(s, id));
      track('interacted', labObject(lab), undefined, { action: 'examine', evidence: id });
    }
  };

  const check = async () => {
    const r = await scenarioChecks.run(lab as LabSpec<ScenarioState & { finished: boolean }>, { ...state, finished });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { path: state.path, flags: state.flags, score: state.score, ending: state.current }, steps: state.path.length }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const restart = () => {
    if (state.path.length > 0 && !window.confirm('Start the case again from the beginning? Your decisions so far will be cleared.')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setState(startScenario(spec));
    setOpenEvidence(null);
    setResult(null);
  };

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
        <aside className="order-1 lg:order-none">
          <details open className="rounded-lg border border-line bg-surface lg:open">
            <summary className="cursor-pointer px-4 py-3 font-medium lg:pointer-events-none">Briefing</summary>
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
            <div className="px-5 pt-4 flex items-center justify-between gap-3 text-xs text-ink-soft">
              <span className="font-mono">Step {stepNumber}</span>
              {node.end && (
                <span
                  className={`rounded-full px-2.5 py-0.5 font-medium ${
                    node.outcome === 'good' ? 'bg-high-soft text-high' : node.outcome === 'bad' ? 'bg-fault-soft text-fault' : 'bg-gold-soft text-gold-deep'
                  }`}
                >
                  {node.outcome === 'good' ? 'A good outcome' : node.outcome === 'bad' ? 'A bad outcome' : 'Mixed outcome'}
                </span>
              )}
            </div>
            <div className="px-5 pb-5">
              <h2 className="mt-1 text-xl font-semibold">{node.title}</h2>
              {state.lastFeedback && state.path.length > 0 && (
                <div className="mt-3 rounded-md border border-gold/40 bg-gold-soft px-3 py-2 text-sm">
                  <Markdown source={state.lastFeedback} />
                </div>
              )}
              <Markdown source={node.text} className="mt-3 text-[15px]" />

              {node.evidence && node.evidence.length > 0 && (
                <div className="mt-4">
                  <h3 className="text-sm font-medium">Evidence</h3>
                  <ul className="mt-2 space-y-2">
                    {node.evidence.map((e) => {
                      const seen = state.viewed.includes(e.id);
                      const open = openEvidence === e.id;
                      return (
                        <li key={e.id} className={`rounded-md border ${open ? 'border-high' : 'border-line'} bg-bench`}>
                          <button type="button" onClick={() => examine(e.id)} className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm">
                            <span className={`font-mono text-xs ${seen ? 'text-high' : 'text-ink-faint'}`}>{seen ? '✓' : '○'}</span>
                            {e.kind && <span className="text-xs uppercase tracking-wide text-ink-faint">{KIND_LABEL[e.kind] ?? e.kind}</span>}
                            <span className="font-medium">{e.title}</span>
                            <span className="ml-auto text-xs text-ink-soft">{open ? 'Close' : 'Examine'}</span>
                          </button>
                          {open && (
                            <div className="px-3 pb-3 border-t border-line pt-2">
                              <Markdown source={e.text} className="text-sm" />
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {node.prompts?.map((p) => {
                const text = state.answers[p.id] ?? '';
                return (
                  <label key={p.id} className="block mt-4">
                    <span className="text-sm font-medium">{p.label}</span>
                    {p.hint && <span className="block text-xs text-ink-soft mt-0.5">{p.hint}</span>}
                    <textarea
                      value={text}
                      onChange={(e) => {
                        setState((s) => setAnswer(s, p.id, e.target.value));
                        setResult(null);
                      }}
                      rows={5}
                      className="mt-1.5 w-full rounded-md border border-line bg-surface px-3 py-2 text-[15px] leading-relaxed"
                    />
                    <span className="block text-xs text-ink-faint mt-1">
                      {wordCount(text)} words{p.minWords ? ` (at least ${p.minWords})` : ''}
                    </span>
                  </label>
                );
              })}

              {!node.end && node.choices && (
                <div className="mt-5">
                  <h3 className="text-sm font-medium">What do you do?</h3>
                  <ul className="mt-2 space-y-2">
                    {node.choices.map((c) => {
                      const available = choiceAvailable(c, state);
                      const needsWords = (node.prompts ?? []).some((p) => (p.minWords ?? 0) > wordCount(state.answers[p.id] ?? ''));
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => decide(c.id)}
                            disabled={!available || needsWords}
                            className="w-full text-left rounded-md border border-line bg-surface px-4 py-3 text-[15px] hover:border-high hover:bg-high-soft disabled:opacity-50 disabled:hover:bg-surface disabled:hover:border-line"
                            title={!available ? 'Examine the evidence first.' : needsWords ? 'Finish your written answer first.' : undefined}
                          >
                            {c.text}
                            {!available && <span className="block text-xs text-ink-soft mt-0.5">Examine the evidence first.</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={check} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
              {finished ? 'Check my decisions' : 'Check so far'}
            </button>
            <button type="button" onClick={restart} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
              Start the case again
            </button>
            {result?.passed && (
              <span className="ml-auto flex flex-wrap gap-2">
                {topicCheck && (
                  <Link to={`/courses/${lab.course}/units/${lab.unit}/topics/${lab.topicIndex}/check`} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
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
            <div className={`mt-3 rounded-lg border p-4 ${result.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`} role="status">
              <p className="font-medium">
                {result.passed ? 'Well handled. Every check passed.' : `${result.checks.filter((c) => c.passed).length} of ${result.checks.length} checks passed.`}
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
                  <span className="font-medium text-ink">In practice:</span> {lab.realityNote}
                </p>
              )}
            </div>
          )}
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Your path so far</h2>
            {state.path.length === 0 ? (
              <p className="mt-1 text-sm text-ink-soft">No decisions yet.</p>
            ) : (
              <ol className="mt-2 space-y-1 text-sm text-ink-soft list-decimal pl-5">
                {state.path.map((s, i) => {
                  const n = spec.nodes.find((x) => x.id === s.node);
                  const c = n?.choices?.find((x) => x.id === s.choice);
                  return <li key={i}>{c?.text ?? s.choice}</li>;
                })}
              </ol>
            )}
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">What will be checked</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-soft list-disc pl-4">
              {lab.checks.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
          </div>
          <QuestionsAbout labId={lab.id} title="Questions about this case" />
        </aside>
      </div>
    </div>
  );
}
