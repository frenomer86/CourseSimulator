/**
 * The workspace for database labs (engine E5): a schema browser, a SQL editor, a results
 * panel and the checker. SQLite runs in the browser; every run starts from the lab's schema.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, type EventObject, type LabResult, type LabSpec } from '@cslab/lab-runtime';
import { createSqlChecks, describe as describeDb, describeSqlError, execAll, withDatabase, type ResultSet, type SqlState, type TableInfo } from '@cslab/engine-sql';
import { checkForTopic, courseBySlug, nextLab, unitOf } from '../lib/catalogue';
import { configureSqlEngine } from '../lib/sql';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { SqlEditor } from './SqlEditor';
import { Markdown } from './Markdown';
import { ContestBanner, useContestEntry } from './Contest';
import { QuestionsAbout } from '../pages/Forum';

configureSqlEngine();
const sqlChecks = createSqlChecks();

function labObject(lab: LabSpec<unknown>): EventObject {
  return { type: 'lab', id: lab.id, course: lab.course, unit: lab.unit, topic: lab.topicIndex, labId: lab.id, labLevel: lab.level };
}

interface Workspace {
  sql: string;
}

const MAX_ROWS = 200;

export function SqlLab({ lab }: { lab: LabSpec<Workspace> }) {
  const course = courseBySlug(lab.course);
  const schema = String(lab.config?.schema ?? '');
  const starter = lab.initialState?.sql ?? '';
  const saved = useProgress((s) => s.workspaces[lab.id]) as Workspace | undefined;
  const progress = useProgress((s) => s.labs[lab.id]);
  const { recordResult, saveWorkspace, clearWorkspace } = useProgress();

  const [sql, setSql] = useState<string>(() => saved?.sql ?? starter);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [results, setResults] = useState<{ sets: ResultSet[]; error: string | null; timeMs: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LabResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [hintsShown, setHintsShown] = useState(0);
  const [peek, setPeek] = useState<{ table: string; set: ResultSet } | null>(null);

  useEffect(() => {
    let cancelled = false;
    withDatabase(schema, (db) => describeDb(db))
      .then((t) => {
        if (!cancelled) setTables(t);
      })
      .catch((err) => {
        if (!cancelled) setSchemaError(describeSqlError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [schema]);

  useEffect(() => {
    const t = setTimeout(() => saveWorkspace(lab.id, { sql } satisfies Workspace), 400);
    return () => clearTimeout(t);
  }, [sql, lab.id, saveWorkspace]);

  const openedAt = useRef(Date.now());
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track('launched', labObject(lab));
  }, [lab]);

  const contest = useContestEntry('lab', lab.id, lab.course);
  const state: SqlState = { schema, sql };

  const run = async () => {
    setRunning(true);
    const started = Date.now();
    try {
      const sets = await withDatabase(schema, (db) => execAll(db, sql));
      setResults({ sets, error: null, timeMs: Date.now() - started });
      track('interacted', labObject(lab), { error: false, timeMs: Date.now() - started }, { action: 'run' });
    } catch (err) {
      setResults({ sets: [], error: describeSqlError(err), timeMs: Date.now() - started });
      track('interacted', labObject(lab), { error: true }, { action: 'run' });
    }
    setRunning(false);
  };

  const peekTable = async (name: string) => {
    if (peek?.table === name) {
      setPeek(null);
      return;
    }
    const set = await withDatabase(schema, (db) => execAll(db, `SELECT * FROM "${name.replace(/"/g, '""')}" LIMIT 5`)[0] ?? { columns: [], rows: [] });
    setPeek({ table: name, set });
  };

  const check = async () => {
    setChecking(true);
    const r = await sqlChecks.run(lab as unknown as LabSpec<SqlState>, state);
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
    track('saved', { ...labObject(lab), type: 'lab-artefact' }, { artefact: { sql }, lines: sql.split('\n').length }, { reason: r.passed ? 'pass' : 'submit' });
    void contest.submit(r.passed, hintsShown);
    setChecking(false);
  };

  const reset = () => {
    if (sql !== starter && !window.confirm('Replace your SQL with the starting text?')) return;
    track('interacted', labObject(lab), undefined, { action: 'reset' });
    clearWorkspace(lab.id);
    setSql(starter);
    setResults(null);
    setResult(null);
  };

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
            <span className="font-mono">query.sql</span>
            <span>SQLite runs in your browser. Every run starts from the lab's data.</span>
          </div>
          <SqlEditor value={sql} onChange={(v) => { setSql(v); setResult(null); }} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={run} disabled={running || checking} className="rounded-md border border-high text-high px-4 py-2 font-medium hover:bg-high-soft disabled:opacity-60">
              {running ? 'Running…' : 'Run'}
            </button>
            <button type="button" onClick={check} disabled={running || checking} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46] disabled:opacity-60">
              {checking ? 'Checking…' : 'Check my SQL'}
            </button>
            <button type="button" onClick={reset} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
              Start again
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

          <div className="mt-3 rounded-lg border border-line bg-surface p-3 min-h-[96px]" aria-live="polite" aria-label="Query results">
            {results === null ? (
              <p className="text-sm text-ink-soft">{running ? 'Running…' : 'Press Run to see the rows your SQL returns.'}</p>
            ) : results.error ? (
              <p className="text-sm text-fault font-mono whitespace-pre-wrap">{results.error}</p>
            ) : results.sets.length === 0 ? (
              <p className="text-sm text-ink-soft">The SQL ran and returned no rows (statements such as CREATE, INSERT and UPDATE do not return rows). {results.timeMs} ms.</p>
            ) : (
              results.sets.map((set, i) => <ResultTable key={i} set={set} caption={results.sets.length > 1 ? `Result ${i + 1}` : undefined} />)
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
                  <span className="font-medium text-ink">In a real system:</span> {lab.realityNote}
                </p>
              )}
            </div>
          )}
        </section>

        <aside className="order-2 lg:order-none space-y-4">
          <div className="rounded-lg border border-line bg-surface p-4">
            <h2 className="font-medium">Tables</h2>
            <p className="text-xs text-ink-soft mt-0.5">Click a table to see its first rows.</p>
            {schemaError && <p className="mt-2 text-sm text-fault">{schemaError}</p>}
            {tables === null && !schemaError && <p className="mt-2 text-sm text-ink-soft">Loading…</p>}
            <ul className="mt-2 space-y-2">
              {tables?.map((t) => (
                <li key={t.name} className="text-sm">
                  <button type="button" onClick={() => void peekTable(t.name)} className="font-mono font-medium text-ink hover:text-high">
                    {t.name} <span className="text-ink-faint font-normal">({t.rowCount} rows)</span>
                  </button>
                  <ul className="mt-0.5 ml-3 text-xs text-ink-soft font-mono space-y-0.5">
                    {t.columns.map((c) => (
                      <li key={c.name}>
                        {c.primaryKey ? '🔑 ' : ''}
                        {c.name} <span className="text-ink-faint">{c.type.toLowerCase()}{c.notNull ? ' not null' : ''}</span>
                      </li>
                    ))}
                  </ul>
                  {peek?.table === t.name && (
                    <div className="mt-1 -ml-1">
                      <ResultTable set={peek.set} compact />
                    </div>
                  )}
                </li>
              ))}
            </ul>
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
        </aside>
      </div>
    </div>
  );
}

function ResultTable({ set, caption, compact = false }: { set: ResultSet; caption?: string; compact?: boolean }) {
  const rows = set.rows.slice(0, MAX_ROWS);
  return (
    <div className={`overflow-x-auto ${compact ? '' : 'mb-3'}`}>
      {caption && <p className="text-xs text-ink-soft mb-1">{caption}</p>}
      <table className={`font-mono border-collapse ${compact ? 'text-[11px]' : 'text-sm'}`}>
        <thead>
          <tr>
            {set.columns.map((c, i) => (
              <th key={i} className="border border-line px-2 py-1 bg-bench text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className={`border border-line px-2 py-0.5 ${cell === null ? 'text-ink-faint italic' : ''}`}>
                  {cell === null ? 'NULL' : cell instanceof Uint8Array ? '<blob>' : String(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-ink-soft mt-1">
        {set.rows.length} row{set.rows.length === 1 ? '' : 's'}
        {set.rows.length > MAX_ROWS ? `, showing the first ${MAX_ROWS}` : ''}
      </p>
    </div>
  );
}
