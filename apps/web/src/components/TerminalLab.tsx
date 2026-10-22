/**
 * The workspace for terminal labs (engine E4): a simulated Linux shell with a transcript,
 * command history, tab completion, an editor panel for nano/vi/crontab, and the lab's checks.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import {
  COMMANDS,
  FsError,
  ShellSyntaxError,
  actorFor,
  createShellChecks,
  installCrontab,
  listDir,
  newSession,
  parse,
  readFile,
  resolvePath,
  runLine,
  systemFromInitial,
  writeFile,
  type Session,
  type ShellState,
  type ShellSystem,
} from '@cslab/engine-shell';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

const shellChecks = createShellChecks();

interface Line {
  kind: 'cmd' | 'out';
  text: string;
}

interface Workspace {
  system: ShellSystem;
  transcript: Line[];
}

interface EditorState {
  kind: 'editor' | 'crontab';
  title: string;
  path?: string;
  user?: string;
  content: string;
}

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

function promptFor(sys: ShellSystem): string {
  const home = sys.users[sys.user]?.home ?? '/';
  const cwd = sys.cwd === home ? '~' : sys.cwd.startsWith(home + '/') ? '~' + sys.cwd.slice(home.length) : sys.cwd;
  return `${sys.user}@${sys.hostname}:${cwd}${sys.user === 'root' ? '#' : '$'} `;
}

const COMMAND_NAMES = [...new Set([...Object.keys(COMMANDS), 'cd', 'export', 'unset', 'set', 'exit', 'source', 'read', 'history', 'umask', 'type', 'bash', 'let', 'eval', 'logout'])].filter((c) => /^[a-z]/.test(c)).sort();

export function TerminalLab({ lab }: { lab: LabSpec<ShellState> }) {
  const course = courseBySlug(lab.course);
  const saved = useProgress((s) => s.workspaces[lab.id]) as Workspace | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();
  const reference = (lab.config?.reference as string[] | undefined) ?? [];

  const sysRef = useRef<ShellSystem>(saved?.system && typeof saved.system === 'object' && 'fs' in saved.system ? saved.system : systemFromInitial(lab.initialState));
  const sessionRef = useRef<Session>(newSession(sysRef.current));
  const [tick, setTick] = useState(0);
  const [transcript, setTranscript] = useState<Line[]>(() => saved?.transcript ?? [{ kind: 'out', text: `Welcome to ${sysRef.current.hostname} (openSUSE Leap 15.6). Type a command, or man <command> for help.\n` }]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [result, setResult] = useState<LabResult | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const sys = sysRef.current;

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { system: sysRef.current, transcript: transcript.slice(-300) } satisfies Workspace), 500);
    return () => clearTimeout(t);
  }, [transcript, tick, lab.id, saveWorkspace]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [transcript]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);

  const handleRequests = useCallback((requests: ReturnType<typeof runLine>['requests']) => {
    for (const r of requests) {
      if (r.kind === 'clear') setTranscript([]);
      else if (r.kind === 'editor') setEditor({ kind: 'editor', title: r.path ?? '', path: r.path, content: r.content ?? '' });
      else if (r.kind === 'crontab') setEditor({ kind: 'crontab', title: `crontab for ${r.user ?? sysRef.current.user}`, user: r.user, content: r.content ?? '' });
    }
  }, []);

  const execute = (line: string) => {
    const full = [...pending, line].join('\n');
    // Keep reading lines while the input is an unfinished quote or here document.
    try {
      parse(full);
    } catch (e) {
      if (e instanceof ShellSyntaxError && /unexpected EOF|expected 'fi'|expected 'done'|expected 'esac'|expected '}'/.test(e.message)) {
        setPending((p) => [...p, line]);
        setTranscript((t) => [...t, { kind: 'cmd', text: (pending.length ? '> ' : promptFor(sysRef.current)) + line }]);
        setInput('');
        return;
      }
    }
    setPending([]);
    const promptText = pending.length ? '> ' : promptFor(sysRef.current);
    let r: ReturnType<typeof runLine>;
    try {
      r = runLine(sysRef.current, full, sessionRef.current);
    } catch (e) {
      r = { output: `bash: internal error: ${(e as Error).message}\n`, status: 1, requests: [] };
    }
    setTranscript((t) => {
      const next = [...t, { kind: 'cmd' as const, text: promptText + line }];
      if (r.output) next.push({ kind: 'out', text: r.output });
      return next.slice(-600);
    });
    handleRequests(r.requests);
    setInput('');
    setHistIndex(null);
    setResult(null);
    setTick((n) => n + 1);
    track('interacted', labObject(lab), { status: r.status }, { action: 'command', command: line.split(/\s+/)[0] });
  };

  const complete = () => {
    const parts = input.split(/\s+/);
    const last = parts[parts.length - 1] ?? '';
    const isCommand = parts.length === 1;
    let candidates: string[] = [];
    if (isCommand && !last.includes('/')) candidates = COMMAND_NAMES.filter((c) => c.startsWith(last));
    else {
      const home = sys.users[sys.user]?.home ?? '/';
      const dirPart = last.includes('/') ? last.slice(0, last.lastIndexOf('/') + 1) : '';
      const base = last.slice(dirPart.length);
      try {
        const entries = listDir(sys.fs, resolvePath(sys.cwd, dirPart || '.', home), actorFor(sys));
        candidates = entries.filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.'))).map((e) => dirPart + e.name + (e.node.type === 'dir' ? '/' : ''));
      } catch {
        candidates = [];
      }
    }
    if (candidates.length === 1) {
      parts[parts.length - 1] = candidates[0] + (candidates[0].endsWith('/') ? '' : ' ');
      setInput(parts.join(' '));
    } else if (candidates.length > 1) {
      // Fill the common prefix, and list the options.
      let prefix = candidates[0];
      for (const c of candidates) while (!c.startsWith(prefix)) prefix = prefix.slice(0, -1);
      parts[parts.length - 1] = prefix;
      setInput(parts.join(' '));
      setTranscript((t) => [...t, { kind: 'cmd', text: promptFor(sys) + input }, { kind: 'out', text: candidates.map((c) => c.replace(/\/$/, '')).join('  ') + '\n' }]);
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const hist = sys.history;
    if (e.key === 'Enter') {
      e.preventDefault();
      execute(input);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hist.length) return;
      const idx = histIndex === null ? hist.length - 1 : Math.max(0, histIndex - 1);
      setHistIndex(idx);
      setInput(hist[idx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIndex === null) return;
      const idx = histIndex + 1;
      if (idx >= hist.length) {
        setHistIndex(null);
        setInput('');
      } else {
        setHistIndex(idx);
        setInput(hist[idx]);
      }
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setTranscript([]);
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      setTranscript((t) => [...t, { kind: 'cmd', text: promptFor(sys) + input + '^C' }]);
      setInput('');
      setPending([]);
    }
  };

  const saveEditor = () => {
    if (!editor) return;
    const s = sysRef.current;
    if (editor.kind === 'crontab') {
      const err = installCrontab(s, editor.user ?? s.user, editor.content);
      if (err) {
        setEditorError(err);
        return;
      }
      setTranscript((t) => [...t, { kind: 'out', text: `crontab: installing new crontab\n` }]);
    } else if (editor.path) {
      try {
        writeFile(s.fs, editor.path, editor.content, actorFor(s), s.now);
      } catch (e) {
        setEditorError(e instanceof FsError ? `Cannot write ${editor.path}: ${e.message.replace(/^.*?: /, '')}. Do you need sudo?` : (e as Error).message);
        return;
      }
      setTranscript((t) => [...t, { kind: 'out', text: `[ Wrote ${editor.content.split('\n').length - (editor.content.endsWith('\n') ? 1 : 0)} lines to ${editor.path} ]\n` }]);
    }
    track('interacted', labObject(lab), undefined, { action: 'edit', path: editor.path ?? 'crontab' });
    setEditor(null);
    setEditorError(null);
    setTick((n) => n + 1);
    setResult(null);
    inputRef.current?.focus();
  };

  const check = async () => {
    const s = sysRef.current;
    const r = await shellChecks.run(lab, { system: s, history: s.history });
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
      commands: s.history.length,
    };
    track('submitted', labObject(lab), outcome);
    track(r.passed ? 'passed' : 'failed', labObject(lab), outcome);
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { history: s.history } }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
  };

  const reset = () => {
    if (!window.confirm('Reset the machine to its starting state? Your commands and files will be lost.')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    sysRef.current = systemFromInitial(lab.initialState);
    sessionRef.current = newSession(sysRef.current);
    setTranscript([{ kind: 'out', text: `Machine reset. Welcome to ${sysRef.current.hostname}.\n` }]);
    setInput('');
    setPending([]);
    setResult(null);
    setTick((n) => n + 1);
  };

  const following = useMemo(() => nextLab(lab), [lab]);
  const unit = course && lab.unit ? unitOf(course, lab.unit) : undefined;
  const topicCheck = lab.unit && lab.topicIndex ? checkForTopic(lab.course, lab.unit, lab.topicIndex) : undefined;
  const cwdFiles = useMemo(() => {
    try {
      return listDir(sys.fs, sys.cwd, actorFor(sys)).filter((e) => !e.name.startsWith('.'));
    } catch {
      return [];
    }
  }, [sys, tick]); // eslint-disable-line react-hooks/exhaustive-deps

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
          {reference.length > 0 && (
            <div className="rounded-lg border border-line bg-surface p-4">
              <h2 className="text-xs uppercase tracking-wide text-ink-faint font-medium">Commands you may need</h2>
              <ul className="mt-2 space-y-1 font-mono text-xs">
                {reference.map((r) => (
                  <li key={r}>
                    <button type="button" onClick={() => { setInput(r.split('  ')[0]); inputRef.current?.focus(); }} className="text-left hover:text-high">
                      {r}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-soft">Type man followed by a command for its manual page.</p>
            </div>
          )}
        </aside>

        <section className="order-0 lg:order-none min-w-0 space-y-3">
          <div className="rounded-lg border border-line bg-[#1b1f23] text-[#e6edf3] font-mono text-[13px] leading-5 shadow-inner" onClick={() => inputRef.current?.focus()} role="group" aria-label="Terminal">
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 text-xs text-white/60">
              <span>
                {sys.user}@{sys.hostname}: {sys.cwd}
              </span>
              <span>bash (simulated)</span>
            </div>
            <div className="h-[420px] overflow-y-auto px-3 py-2" aria-live="polite" aria-label="Terminal output">
              {transcript.map((l, i) => (
                <pre key={i} className={`whitespace-pre-wrap break-words ${l.kind === 'cmd' ? 'text-[#9fe0b5]' : ''}`}>
                  {l.text}
                </pre>
              ))}
              <div className="flex">
                <span className="text-[#9fe0b5] shrink-0">{pending.length ? '> ' : promptFor(sys)}</span>
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKey}
                  className="flex-1 bg-transparent outline-none text-[#e6edf3] caret-[#9fe0b5] min-w-0"
                  aria-label="Command input"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  disabled={!!editor}
                />
              </div>
              <div ref={endRef} />
            </div>
            <div className="px-3 py-1.5 border-t border-white/10 text-xs text-white/50 flex flex-wrap gap-x-4">
              <span>Enter runs</span>
              <span>Tab completes</span>
              <span>↑ ↓ history</span>
              <span>Ctrl+L clears</span>
            </div>
          </div>

          {editor && (
            <div className="rounded-lg border border-high bg-surface" role="dialog" aria-label={`Editing ${editor.title}`}>
              <div className="flex items-center justify-between px-3 py-2 border-b border-line text-sm">
                <span className="font-mono">
                  {editor.kind === 'crontab' ? 'crontab -e' : 'GNU nano'}: <span className="font-medium">{editor.title}</span>
                </span>
                <span className="text-xs text-ink-soft">On a real system: Ctrl+O saves, Ctrl+X exits (nano); :wq saves and quits (vim).</span>
              </div>
              <textarea
                value={editor.content}
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
                className="w-full h-64 p-3 font-mono text-[13px] leading-5 bg-[#1b1f23] text-[#e6edf3] outline-none resize-y"
                aria-label="Editor"
                spellCheck={false}
                autoFocus
              />
              {editorError && <p className="px-3 py-2 text-sm text-fault border-t border-line whitespace-pre-wrap">{editorError}</p>}
              <div className="flex gap-2 px-3 py-2 border-t border-line">
                <button type="button" onClick={saveEditor} className="rounded-md bg-high px-3 py-1.5 text-white text-sm font-medium hover:bg-[#0c5a46]">
                  Save and exit
                </button>
                <button type="button" onClick={() => { setEditor(null); setEditorError(null); inputRef.current?.focus(); }} className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-bench">
                  Exit without saving
                </button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-line bg-surface p-3 text-xs text-ink-soft">
            <span className="font-medium text-ink">In {sys.cwd}:</span>{' '}
            {cwdFiles.length ? cwdFiles.map((e) => (
              <span key={e.name} className={`font-mono mr-3 ${e.node.type === 'dir' ? 'text-high' : ''}`}>
                {e.name}
                {e.node.type === 'dir' ? '/' : ''}
              </span>
            )) : <span className="font-mono">(empty)</span>}
          </div>
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Tasks</h2>
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
                Reset machine
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
                    <span className="font-medium text-ink">On a real server:</span> {lab.realityNote}
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

export function readSimFile(sys: ShellSystem, path: string): string | null {
  try {
    return readFile(sys.fs, path, { user: 'root', groups: ['root'] });
  } catch {
    return null;
  }
}
