import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  DEFAULT_PASS_MARK,
  drawItems,
  gradeCheck,
  topicKey,
  type CheckAnswer,
  type CheckGrade,
  type CheckItem,
} from '@cslab/lab-runtime';
import { checkForTopic, courseBySlug, unitOf } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { secondsSince, track } from '../lib/telemetry';
import { InlineMarkdown, Markdown } from '../components/Markdown';
import { NotFoundPage } from './NotFound';
import { ContestBanner, useContestEntry } from '../components/Contest';

export function TopicCheckPage() {
  const { slug = '', unit = '', topic = '' } = useParams();
  const course = courseBySlug(slug);
  const n = Number(unit);
  const t = Number(topic);
  const u = course ? unitOf(course, n) : undefined;
  const spec = checkForTopic(slug, n, t);
  if (!course || !u || !u.topics[t - 1]) return <NotFoundPage />;
  if (!spec) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-2xl font-semibold">No check for this topic yet.</h1>
        <p className="mt-2 text-ink-soft">Checks are being written unit by unit.</p>
        <Link to={`/courses/${course.slug}/units/${n}`} className="mt-6 inline-block rounded-md bg-high px-4 py-2 text-white font-medium">
          Back to unit {n}
        </Link>
      </div>
    );
  }
  return <CheckSitting key={`${slug}:${n}:${t}`} courseTitle={course.title} unitTitle={u.title} topicTitle={u.topics[t - 1]} spec={spec} />;
}

function CheckSitting({
  courseTitle,
  unitTitle,
  topicTitle,
  spec,
}: {
  courseTitle: string;
  unitTitle: string;
  topicTitle: string;
  spec: NonNullable<ReturnType<typeof checkForTopic>>;
}) {
  const [seed, setSeed] = useState(() => Date.now());
  const items = useMemo(() => drawItems(spec, seed), [spec, seed]);
  const [answers, setAnswers] = useState<Record<string, CheckAnswer>>({});
  const [grade, setGrade] = useState<CheckGrade | null>(null);
  const recordCheck = useProgress((s) => s.recordCheck);
  const previous = useProgress((s) => s.checks[topicKey(spec.course, spec.unit, spec.topic)]);
  const passMark = spec.passMark ?? DEFAULT_PASS_MARK;
  const contest = useContestEntry('check', `${spec.course}:${spec.unit}:${spec.topic}`, spec.course);

  const unanswered = items.filter((it) => {
    const a = answers[it.id];
    return a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0);
  }).length;

  const setAnswer = (id: string, value: CheckAnswer) => setAnswers((prev) => ({ ...prev, [id]: value }));

  const mark = () => {
    const g = gradeCheck(items, answers, passMark);
    setGrade(g);
    recordCheck(spec.course, spec.unit, spec.topic, g.score, g.passed);
    const place = { course: spec.course, unit: spec.unit, topic: spec.topic };
    for (const r of g.items) track('answered', { type: 'check-item', id: r.id, ...place }, { correct: r.correct });
    track(g.passed ? 'passed' : 'failed', { type: 'check', id: `${spec.course}:${spec.unit}:${spec.topic}`, ...place }, {
      score: g.score,
      correct: g.correct,
      total: g.total,
      passMark,
      attempt: (previous?.attempts ?? 0) + 1,
      durationS: secondsSince(seed),
    });
    void contest.submit(g.passed, 0);
    window.scrollTo({ top: 0 });
  };

  const newSet = () => {
    setSeed(Date.now());
    setAnswers({});
    setGrade(null);
    window.scrollTo({ top: 0 });
  };

  const unitPath = `/courses/${spec.course}/units/${spec.unit}`;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav className="text-sm text-ink-soft flex flex-wrap items-center gap-x-2">
        <Link to="/#courses" className="hover:text-ink">
          Courses
        </Link>
        <span>/</span>
        <Link to={`/courses/${spec.course}`} className="hover:text-ink">
          {courseTitle}
        </Link>
        <span>/</span>
        <Link to={unitPath} className="hover:text-ink">
          Unit {spec.unit}
        </Link>
        <span>/</span>
        <span>Topic check</span>
      </nav>
      <p className="mt-3 text-xs uppercase tracking-wide text-ink-faint font-medium">
        {unitTitle} · topic {spec.unit}.{spec.topic}
      </p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">{topicTitle}</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {items.length} questions drawn from a pool of {spec.items.length}. Score {passMark}% or more to become proficient. You can
        retake it as often as you like and the questions change.
        {previous && ` Your best so far is ${Math.round(previous.bestScore)}%.`}
      </p>
      <ContestBanner entry={contest} />

      {grade && (
        <div
          className={`mt-5 rounded-lg border p-4 ${grade.passed ? 'border-high bg-high-soft' : 'border-fault/40 bg-fault-soft'}`}
          role="status"
        >
          <p className="font-medium">
            {grade.passed ? 'Passed. You are proficient in this topic.' : `Not yet. You need ${passMark}% to pass.`}
          </p>
          <p className="mt-1 text-sm">
            {grade.correct} of {grade.total} correct, {Math.round(grade.score)}%.
            {grade.score === 100 && ' A perfect score.'}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={newSet} className="rounded-md bg-high px-4 py-2 text-white font-medium hover:bg-[#0c5a46]">
              {grade.passed ? 'Try another set' : 'Try again with new questions'}
            </button>
            <Link to={unitPath} className="rounded-md border border-line bg-surface px-4 py-2 font-medium hover:bg-bench">
              Back to unit {spec.unit}
            </Link>
          </div>
        </div>
      )}

      <ol className="mt-6 space-y-4">
        {items.map((item, i) => {
          const result = grade?.items.find((r) => r.id === item.id);
          const border = !result ? 'border-line' : result.correct ? 'border-high' : 'border-fault/60';
          return (
            <li key={item.id} className={`rounded-lg border bg-surface p-4 ${border}`}>
              <div className="flex items-start gap-3">
                <span className="font-mono text-sm text-ink-faint mt-0.5 w-5 shrink-0">{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <Markdown source={item.prompt} className="text-[15px]" />
                  <div className="mt-3">
                    <ItemInput item={item} value={answers[item.id]} disabled={!!grade} onChange={(v) => setAnswer(item.id, v)} />
                  </div>
                  {result && (
                    <div className={`mt-3 text-sm rounded-md px-3 py-2 ${result.correct ? 'bg-high-soft' : 'bg-fault-soft'}`}>
                      <p className="font-medium">
                        {result.correct ? 'Correct.' : result.blank ? 'Left blank.' : 'Not quite.'}
                        {!result.correct && <span className="font-normal"> {correctAnswerText(item)}</span>}
                      </p>
                      {item.explanation && <Markdown source={item.explanation} className="mt-1 text-ink-soft" />}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {!grade && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={mark} className="rounded-md bg-high px-5 py-2.5 text-white font-medium hover:bg-[#0c5a46]">
            Mark my answers
          </button>
          <span className="text-sm text-ink-soft">
            {unanswered === 0 ? 'All answered.' : `${unanswered} still blank. Blank answers count as wrong.`}
          </span>
        </div>
      )}
    </div>
  );
}

function correctAnswerText(item: CheckItem): string {
  switch (item.type) {
    case 'choice':
      return `The answer is: ${item.options[item.answer]}`;
    case 'multi':
      return `The answers are: ${item.answer.map((i) => item.options[i]).join('; ')}`;
    case 'numeric':
      return `The answer is ${item.answer}${item.unit ? ` ${item.unit}` : ''}${item.tolerance ? ` (within ${item.tolerance})` : ''}.`;
    case 'text':
      return '';
  }
}

function ItemInput({
  item,
  value,
  disabled,
  onChange,
}: {
  item: CheckItem;
  value: CheckAnswer;
  disabled: boolean;
  onChange: (v: CheckAnswer) => void;
}) {
  const base =
    'w-full rounded-md border border-line bg-surface px-3 py-2 font-mono text-[15px] focus:border-high disabled:bg-bench disabled:text-ink-soft';
  switch (item.type) {
    case 'choice':
      return (
        <div role="radiogroup" className="space-y-1.5">
          {item.options.map((opt, i) => (
            <label
              key={i}
              className={`flex items-start gap-2.5 rounded-md border px-3 py-2 cursor-pointer ${
                value === i ? 'border-high bg-high-soft' : 'border-line hover:bg-bench'
              } ${disabled ? 'cursor-default' : ''}`}
            >
              <input
                type="radio"
                name={item.id}
                value={i}
                aria-label={`Option ${i + 1}`}
                checked={value === i}
                disabled={disabled}
                onChange={() => onChange(i)}
                className="mt-1 accent-[var(--color-high)]"
              />
              <InlineMarkdown source={opt} className="text-[15px] leading-snug" />
            </label>
          ))}
        </div>
      );
    case 'multi': {
      const chosen = Array.isArray(value) ? value : [];
      return (
        <div className="space-y-1.5">
          <p className="text-xs text-ink-soft">Choose every answer that applies.</p>
          {item.options.map((opt, i) => {
            const on = chosen.includes(i);
            return (
              <label
                key={i}
                className={`flex items-start gap-2.5 rounded-md border px-3 py-2 cursor-pointer ${
                  on ? 'border-high bg-high-soft' : 'border-line hover:bg-bench'
                } ${disabled ? 'cursor-default' : ''}`}
              >
                <input
                  type="checkbox"
                  value={i}
                  aria-label={`Option ${i + 1}`}
                  checked={on}
                  disabled={disabled}
                  onChange={() => onChange(on ? chosen.filter((c) => c !== i) : [...chosen, i])}
                  className="mt-1 accent-[var(--color-high)]"
                />
                <InlineMarkdown source={opt} className="text-[15px] leading-snug" />
              </label>
            );
          })}
        </div>
      );
    }
    case 'numeric':
      return (
        <div className="flex items-center gap-2 max-w-xs">
          <input
            type="text"
            inputMode="decimal"
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Your answer"
            className={base}
            aria-label="Numeric answer"
          />
          {item.unit && <span className="text-sm text-ink-soft shrink-0">{item.unit}</span>}
        </div>
      );
    case 'text':
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={item.placeholder ?? 'Your answer'}
          className={`${base} max-w-sm`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Text answer"
        />
      );
  }
}
