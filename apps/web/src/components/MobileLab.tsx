/**
 * The workspace for mobile labs (engine E11): the app's JSON on the left, a phone frame running
 * it on the right with device controls (back, home, rotate, offline, kill), the lifecycle log,
 * the data store and the lab's checks.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { back, background, current, currentScreen, foreground, killAndRelaunch, launch, parseApp, render, rotate, setOffline, tap, toggle, type, type Device, type MobileConfig, type MobileState } from '@cslab/engine-mobile';
import { createMobileChecks } from '@cslab/engine-mobile';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const mobileChecks = createMobileChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

export function MobileLab({ lab }: { lab: LabSpec<MobileState> }) {
  const course = courseBySlug(lab.course);
  const config = (lab.config ?? {}) as unknown as MobileConfig;
  const saved = useProgress((s) => s.workspaces[lab.id]) as MobileState | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const initialSource = lab.initialState?.source ?? config.starter ?? '{\n  "start": "Home",\n  "screens": {\n    "Home": { "title": "Home", "widgets": [] }\n  }\n}\n';
  const [source, setSource] = useState<string>(() => saved?.source ?? initialSource);
  const [answers, setAnswers] = useState<Record<string, string>>(() => saved?.answers ?? {});
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const parsed = useMemo(() => parseApp(source), [source]);
  const [device, setDevice] = useState<Device | null>(null);
  const [tick, setTick] = useState(0);
  const [permissions, setPermissions] = useState<Record<string, 'grant' | 'deny'>>(() => config.device?.permissions ?? {});

  // Relaunch whenever the app changes and is valid.
  useEffect(() => {
    if (parsed.app && !parsed.problems.length) setDevice(launch(parsed.app, { ...(config.device ?? {}), permissions }));
    else if (!parsed.app) setDevice(null);
  }, [parsed.app, parsed.problems.length, config.device, permissions]);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { source, answers } satisfies MobileState), 400);
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
  const act = (fn: (d: Device) => Device | void, action: string) => {
    if (!device) return;
    const next = fn(device);
    if (next) setDevice(next);
    setTick((n) => n + 1);
    track('interacted', labObject(lab), undefined, { action });
  };

  const check = async () => {
    const r = await mobileChecks.run(lab, { source, answers });
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { source, answers } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Replace your app with the starting code?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setSource(initialSource);
    setAnswers({});
    setResult(null);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const questions = lab.checks.filter((c) => c.type === 'mobile.answer' && typeof c.id === 'string');
  const screen = device ? currentScreen(device) : undefined;
  const activity = device ? current(device) : undefined;
  const widgets = device ? render(device) : [];
  const declared = parsed.app?.permissions ?? [];
  void tick;

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

      <div className="mt-5 grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)_300px]">
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
          <details className="rounded-lg border border-line bg-surface">
            <summary className="cursor-pointer px-4 py-3 font-medium text-sm">App format reference</summary>
            <pre className="px-4 pb-4 text-xs font-mono whitespace-pre-wrap text-ink-soft">{`{
  "start": "Home",
  "permissions": ["camera"],
  "data": { "notes": [] },
  "screens": {
    "Home": {
      "title": "Notes",
      "retainState": true,
      "onCreate": [{ "action": "load", "keys": ["notes"] }],
      "widgets": [
        { "type": "text", "text": "{{notes}} notes" },
        { "type": "input", "id": "note", "hint": "Write" },
        { "type": "button", "text": "Save", "onTap": [
          { "action": "append", "list": "notes", "from": "note" },
          { "action": "persist", "keys": ["notes"] },
          { "action": "toast", "text": "Saved" }
        ] },
        { "type": "list", "from": "notes", "empty": "Nothing yet" }
      ]
    }
  }
}

Actions: navigate{to}, back, toast{text}, dialog{text},
set{key,from|value}, append{list,from|value}, remove{list,index},
clear{id}, persist{keys}, load{keys},
fetch{url,onSuccess,onError}, requestPermission{permission,onGranted,onDenied},
if{input|key, notEmpty|equals, then, else}, queue{list,from}, sync{list,url,...}`}</pre>
          </details>
        </aside>

        <section className="order-0 lg:order-none min-w-0 space-y-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_300px]">
            <div className="rounded-lg border border-line bg-surface overflow-hidden flex flex-col">
              <div className="px-3 py-1.5 border-b border-line text-xs text-ink-soft flex justify-between">
                <span>app.json</span>
                <span>{parsed.app ? `${Object.keys(parsed.app.screens).length} screens` : 'not valid yet'}</span>
              </div>
              <textarea value={source} onChange={(e) => { setSource(e.target.value); setResult(null); }} className="flex-1 min-h-[420px] p-3 font-mono text-[12.5px] leading-5 outline-none resize-y bg-surface" aria-label="App JSON" spellCheck={false} />
              {parsed.problems.length > 0 && (
                <ul className="px-3 py-2 border-t border-line text-xs text-fault space-y-0.5" role="status">
                  {parsed.problems.slice(0, 5).map((p, i) => (
                    <li key={i}>{p.message}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-2">
              <div className={`mx-auto rounded-[28px] border-[6px] border-[#1b1f23] bg-[#1b1f23] shadow-lg ${device?.rotated ? 'w-[300px]' : 'w-[240px]'}`} role="group" aria-label="Phone">
                <div className={`rounded-[22px] bg-white overflow-hidden flex flex-col ${device?.rotated ? 'h-[240px]' : 'h-[440px]'}`}>
                  <div className="flex justify-between items-center px-3 py-1 text-[10px] bg-[#f3f4f6] text-ink-soft">
                    <span>{device?.offline ? '✈ offline' : '▲ 4G'}</span>
                    <span>12:30</span>
                    <span>▮▮▮</span>
                  </div>
                  <div className="px-3 py-2 bg-[#0f766e] text-white text-sm font-medium flex items-center gap-2">
                    {device && device.stack.length > 1 && (
                      <button type="button" onClick={() => act((d) => { back(d); }, 'back')} aria-label="Up">
                        ←
                      </button>
                    )}
                    <span>{screen?.title ?? activity?.screen ?? (parsed.app ? 'App' : 'No app')}</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-2 text-sm text-[#111]" aria-label="Screen">
                    {!device && <p className="text-xs text-ink-faint">Fix the JSON to run the app.</p>}
                    {device && !activity && <p className="text-xs text-ink-faint">The app exited. Press Relaunch.</p>}
                    {device?.backgrounded && <p className="text-xs text-ink-faint">The app is in the background. Press Resume.</p>}
                    {!device?.backgrounded &&
                      widgets.map((r, i) => {
                        const w = r.widget;
                        if (w.type === 'text') return <p key={i} className={w.style === 'title' ? 'text-lg font-semibold' : w.style === 'caption' ? 'text-xs text-[#555]' : w.style === 'error' ? 'text-xs text-red-600' : ''}>{r.text}</p>;
                        if (w.type === 'input') return <input key={i} type={w.inputType === 'password' ? 'password' : 'text'} value={r.value ?? ''} placeholder={w.hint} onChange={(e) => act((d) => { type(d, w.id, e.target.value); }, 'type')} className="w-full border-b border-[#999] bg-transparent px-1 py-1 outline-none" aria-label={w.hint ?? w.id} />;
                        if (w.type === 'button') return <button key={i} type="button" onClick={() => act((d) => { tap(d, r.text ?? w.text); }, 'tap')} className={`w-full rounded-md px-3 py-2 text-sm font-medium ${w.style === 'secondary' ? 'border border-[#0f766e] text-[#0f766e]' : w.style === 'danger' ? 'bg-red-600 text-white' : 'bg-[#0f766e] text-white'}`}>{r.text}</button>;
                        if (w.type === 'list')
                          return (
                            <ul key={i} className="divide-y divide-[#eee] border border-[#eee] rounded-md" aria-label={`List of ${w.from}`}>
                              {(r.items ?? []).length === 0 && <li className="px-2 py-2 text-xs text-[#777]">{r.text}</li>}
                              {(r.items ?? []).map((it, k) => (
                                <li key={k}>
                                  <button type="button" onClick={() => act((d) => { tap(d, `item:${k}`); }, 'item')} className="w-full text-left px-2 py-1.5 text-sm hover:bg-[#f3f4f6]">
                                    {it}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          );
                        if (w.type === 'switch')
                          return (
                            <label key={i} className="flex items-center justify-between">
                              <span>{w.label}</span>
                              <input type="checkbox" checked={r.on ?? false} onChange={() => act((d) => { toggle(d, w.id); }, 'toggle')} aria-label={w.label} />
                            </label>
                          );
                        if (w.type === 'image') return <div key={i} className="h-20 rounded-md bg-[#e5e7eb] flex items-center justify-center text-xs text-[#777]">{w.alt ?? 'image'}</div>;
                        return <div key={i} className="h-3" />;
                      })}
                    {device?.dialog && (
                      <div className="rounded-md border border-[#ccc] bg-white shadow p-3 text-sm" role="dialog">
                        {device.dialog.title && <p className="font-semibold">{device.dialog.title}</p>}
                        <p>{device.dialog.text}</p>
                        <button type="button" onClick={() => act((d) => { d.dialog = null; }, 'dismiss')} className="mt-2 text-[#0f766e] font-medium">
                          OK
                        </button>
                      </div>
                    )}
                  </div>
                  {device && device.toasts.length > 0 && <div className="mx-4 mb-2 rounded-full bg-[#333] text-white text-xs px-3 py-1 text-center" role="status" aria-label="Toast">{device.toasts[device.toasts.length - 1]}</div>}
                  <div className="flex justify-around py-1 bg-[#f3f4f6] text-[#555] text-sm">
                    <button type="button" onClick={() => act((d) => { back(d); }, 'back')} aria-label="Back">
                      ◁
                    </button>
                    <button type="button" onClick={() => act((d) => (d.backgrounded ? foreground(d) : background(d)), 'home')} aria-label="Home">
                      ○
                    </button>
                    <button type="button" onClick={() => act((d) => { rotate(d); }, 'rotate')} aria-label="Rotate">
                      ⟳
                    </button>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 justify-center text-xs">
                <button type="button" onClick={() => act((d) => (d.backgrounded ? foreground(d) : background(d)), 'home')} className="rounded border border-line px-2 py-1 hover:bg-bench">
                  {device?.backgrounded ? 'Resume' : 'Home button'}
                </button>
                <button type="button" onClick={() => act((d) => { setOffline(d, !d.offline); }, 'offline')} className="rounded border border-line px-2 py-1 hover:bg-bench">
                  {device?.offline ? 'Go online' : 'Go offline'}
                </button>
                <button type="button" onClick={() => act((d) => killAndRelaunch(d), 'kill')} className="rounded border border-line px-2 py-1 hover:bg-bench">
                  Kill process and relaunch
                </button>
                <button type="button" onClick={() => { if (parsed.app) setDevice(launch(parsed.app, { ...(config.device ?? {}), permissions })); }} className="rounded border border-line px-2 py-1 hover:bg-bench">
                  Relaunch
                </button>
              </div>
              {declared.length > 0 && (
                <div className="text-xs text-ink-soft flex flex-wrap gap-2 justify-center">
                  {declared.map((p) => (
                    <label key={p} className="flex items-center gap-1">
                      {p}:
                      <select value={permissions[p] ?? 'grant'} onChange={(e) => setPermissions((x) => ({ ...x, [p]: e.target.value as 'grant' | 'deny' }))} className="input py-0.5 text-xs" aria-label={`${p} permission answer`}>
                        <option value="grant">user grants</option>
                        <option value="deny">user denies</option>
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2 text-xs">
            <div className="rounded-lg border border-line bg-surface p-3">
              <h2 className="font-medium text-sm">Lifecycle log</h2>
              <ol className="mt-1 font-mono max-h-40 overflow-y-auto space-y-0.5" aria-label="Lifecycle log">
                {device?.lifecycle.slice(-30).map((e, i) => (
                  <li key={i}>
                    <span className="text-ink-soft">{e.screen}.</span>
                    <span className={e.event === 'onDestroy' ? 'text-fault' : e.event === 'onResume' ? 'text-high' : ''}>{e.event}</span> <span className="text-ink-faint">({e.cause})</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-lg border border-line bg-surface p-3">
              <h2 className="font-medium text-sm">Data and device</h2>
              <pre className="mt-1 font-mono whitespace-pre-wrap max-h-40 overflow-y-auto" aria-label="App data">{device ? JSON.stringify({ data: device.data, persisted: device.prefs, requests: device.requests.length, permissions: device.permissionLog }, null, 1) : ''}</pre>
              {device && device.errors.length > 0 && (
                <ul className="mt-1 text-fault space-y-0.5" role="status" aria-label="Runtime errors">
                  {device.errors.slice(-3).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
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
                Check my app
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
                    <span className="font-medium text-ink">On a real phone:</span> {lab.realityNote}
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
