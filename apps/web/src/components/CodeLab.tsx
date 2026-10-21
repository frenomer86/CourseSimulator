/**
 * The workspace for code labs (engine E1): instructions, an editor, a run console and the
 * checker. Programs run in a worker in the browser; nothing is sent to a server.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { createCodeChecks, LANGUAGE_LABEL, type CodeLanguage, type CodeState, type RunResult } from '@cslab/engine-code';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { runners, useRunnerStatus, warmRunner } from '../lib/runners';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { CodeEditor } from './CodeEditor';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const codeChecks = createCodeChecks(runners);

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

export function CodeLab({ lab }: { lab: LabSpec<CodeState> }) {
  const course = courseBySlug(lab.course);
  const language: CodeLanguage = (lab.config?.language as CodeLanguage | undefined) ?? lab.initialState?.language ?? 'python';
  const starter = lab.initialState?.source ?? '';
  const saved = useProgress((s) => s.workspaces[lab.id]) as CodeState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const runnerState = useRunnerStatus((s) => s[language]);

  const [source, setSource] = useState<string>(() => (saved && saved.language === language ? saved.source : starter));
  const [stdin, setStdin] = useState<string>(() => String(lab.config?.sampleInput ?? ''));
  const [showInput, setShowInput] = useState<boolean>(() => Boolean(lab.config?.sampleInput));
  const [output, setOutput] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LabResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [hintsShown, setHintsShown] = useState(0);

  useEffect(() => {
    warmRunner(language);
  }, [language]);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { language, source } satisfies CodeState), 400);
    return () => clearTimeout(t);
  }, [source, language, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const run = async () => {
    setRunning(true);
    setOutput(null);
    const r = await runners.get(language)!.run(source, stdin);
    setOutput(r);
    setRunning(false);
    track('interacted', labObject(lab), { error: r.error !== null, timeMs: r.timeMs }, { action: 'run' });
  };

  const check = async () => {
    setChecking(true);
    const r = await codeChecks.run(lab, { language, source });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { language, source }, lines: source.split('\n').length }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
    setChecking(false);
  };

  const reset = () => {
    if (source !== starter && !window.confirm('Replace your code with the starting code?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setSource(starter);
    setOutput(null);
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;

  const runtimeNote =
    runnerState === 'loading'
      ? `Loading ${LANGUAGE_LABEL[language]} (about 10 MB, only the first time)…`
      : runnerState === 'error'
        ? `${LANGUAGE_LABEL[language]} could not load. Check your connection and reload the page.`
        : `${LANGUAGE_LABEL[language]} runs in your browser. Nothing is sent anywhere.`;

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
          <div className="flex items-center justify-between gap-3 mb-2 text-xs text-ink-soft">
            <span className="font-mono">{lab.config?.filename ? String(lab.config.filename) : language === 'python' ? 'main.py' : 'main.js'}</span>
            <span aria-live="polite">{runtimeNote}</span>
          </div>
          <CodeEditor value={source} onChange={(v) => { setSource(v); setResult(null); }} language={language} ariaLabel={`${LANGUAGE_LABEL[language]} code`} />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={run}
              disabled={running || checking}
              className="rounded-md border border-high text-high px-4 py-2 font-medium hover:bg-high-soft disabled:opacity-60"
            >
              {running ? 'Running…' : 'Run'}
            </button>
            <button
              type="button"
              onClick={check}
              disabled={running || checking}
              className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60"
            >
              {checking ? 'Checking…' : 'Check my code'}
            </button>
            <button type="button" onClick={reset} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
              Start again
            </button>
            <button type="button" onClick={() => setShowInput((v) => !v)} className="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">
              {showInput ? 'Hide program input' : 'Program input'}
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

          {showInput && (
            <label className="block mt-3">
              <span className="text-xs text-ink-soft">What the program reads as input, one line per prompt.</span>
              <textarea
                value={stdin}
                onChange={(e) => setStdin(e.target.value)}
                rows={3}
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm"
              />
            </label>
          )}

          <div className="mt-3 rounded-lg border border-line bg-[#15202b] text-[#e6edf3] p-3 font-mono text-sm min-h-[96px] whitespace-pre-wrap break-words" aria-live="polite" aria-label="Program output">
            {output === null ? (
              <span className="text-[#8a94a3]">{running ? 'Running…' : 'Press Run to see your program’s output here.'}</span>
            ) : (
              <>
                {output.stdout && <div>{output.stdout}</div>}
                {output.stderr && <div className="text-[#f0b3a8]">{output.stderr}</div>}
                {output.error && <div className="text-[#ffb4a8] mt-1">{output.error}</div>}
                {!output.stdout && !output.stderr && !output.error && <span className="text-[#8a94a3]">(no output)</span>}
                <div className="text-[#8a94a3] mt-2 text-xs">
                  {output.error ? 'Stopped' : 'Finished'} in {output.timeMs} ms
                </div>
              </>
            )}
          </div>

          {result && (
            <div className={`mt-3 rounded-lg border p-4 ${result.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`} role="status">
              <p className="font-medium">
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
              {result.passed && lab.realityNote && (
                <p className="mt-3 text-sm text-ink-soft border-t border-high/30 pt-3">
                  <span className="font-medium text-ink">Beyond the lab:</span> {lab.realityNote}
                </p>
              )}
            </div>
          )}
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">What will be checked</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-soft list-disc pl-4">
              {lab.checks.map((c, i) => (
                <li key={i}>{c.label}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-soft">
            <h2 className="font-medium text-ink">How to work</h2>
            <p className="mt-1">Press Run as often as you like to see output. Check my code grades it against the list above and saves your result.</p>
            <p className="mt-1">Tab indents. Your code is saved on this device as you type.</p>
          </div>
          <QuestionsAbout labId={lab.id} title="Questions about this lab" />
        </aside>
      </div>
    </div>
  );
}
