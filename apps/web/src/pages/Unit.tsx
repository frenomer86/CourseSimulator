import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, MASTERY_LABEL, masteryRank, topicKey } from '@cslab/lab-runtime';
import { checkForTopic, courseBySlug, labsForTopic, unitOf } from '../lib/catalogue';
import { topicMastery, useProgress } from '../store/progress';
import { track } from '../lib/telemetry';
import { MasteryDot, MasteryLegend } from '../components/Mastery';
import { NotFoundPage } from './NotFound';

export function UnitPage() {
  const { slug = '', unit = '' } = useParams();
  const course = courseBySlug(slug);
  const n = Number(unit);
  const u = course ? unitOf(course, n) : undefined;
  const labs = useProgress((s) => s.labs);
  const topics = useProgress((s) => s.topics);
  const checks = useProgress((s) => s.checks);
  useEffect(() => {
    if (course && u) track('viewed', { type: 'unit', id: `${course.slug}:${n}`, course: course.slug, unit: n });
  }, [course, u, n]);
  if (!course || !u) return <NotFoundPage />;
  const state = { labs, topics, checks };
  const total = course.syllabus?.length ?? 0;
  const done = u.topics.filter((_, ti) => masteryRank(topicMastery(state, course.slug, n, ti + 1)) >= 2).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <nav className="text-sm text-ink-soft flex flex-wrap items-center gap-x-2">
        <Link to="/#courses" className="hover:text-ink">
          Courses
        </Link>
        <span>/</span>
        <Link to={`/courses/${course.slug}`} className="hover:text-ink">
          {course.title}
        </Link>
        <span>/</span>
        <span>Unit {n}</span>
      </nav>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{u.title}</h1>
      <p className="mt-2 text-sm text-ink-soft flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Unit {n} of {total}
        </span>
        {u.weeks && <span>Weeks {u.weeks}</span>}
        <span className="font-mono">
          {done}/{u.topics.length} topics proficient
        </span>
      </p>
      <div className="mt-3 h-1.5 w-full max-w-md rounded bg-bench-deep overflow-hidden">
        <span className="block h-full bg-high-bright" style={{ width: `${(done / u.topics.length) * 100}%` }} />
      </div>
      <div className="mt-3">
        <MasteryLegend />
      </div>

      <ol className="mt-6 space-y-3">
        {u.topics.map((title, ti) => {
          const t = ti + 1;
          const mastery = topicMastery(state, course.slug, n, t);
          const topicLabs = labsForTopic(course.slug, n, t);
          const check = checkForTopic(course.slug, n, t);
          const checkProgress = checks[topicKey(course.slug, n, t)];
          return (
            <li key={title} className="rounded-lg border border-line bg-surface p-4">
              <div className="flex items-start gap-3">
                <span className="mt-1">
                  <MasteryDot mastery={mastery} />
                </span>
                <div className="flex-1 min-w-0">
                  <h2 className="font-medium leading-snug">
                    <span className="font-mono text-ink-faint mr-2">
                      {n}.{t}
                    </span>
                    {title}
                  </h2>
                  <p className="text-xs text-ink-soft mt-0.5">
                    {MASTERY_LABEL[mastery]}
                    {checkProgress && ` · best check ${Math.round(checkProgress.bestScore)}%`}
                  </p>

                  <div className="mt-3 flex flex-wrap gap-2">
                    {topicLabs.map((lab) => {
                      const p = labs[lab.id];
                      return (
                        <Link
                          key={lab.id}
                          to={`/labs/${lab.id}`}
                          className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:border-ink-faint ${
                            p?.passed ? 'border-high/50 bg-high-soft' : 'border-line bg-bench'
                          }`}
                        >
                          <span className={`font-mono text-xs ${p?.passed ? 'text-high' : 'text-ink-faint'}`}>{p?.passed ? '✓' : '○'}</span>
                          <span>{lab.title}</span>
                          <span className="text-xs text-ink-soft">{LEVEL_LABEL[lab.level]}</span>
                        </Link>
                      );
                    })}
                    {check ? (
                      <Link
                        to={`/courses/${course.slug}/units/${n}/topics/${t}/check`}
                        className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium ${
                          checkProgress?.passed
                            ? 'border border-high text-high hover:bg-high-soft'
                            : 'bg-high text-white hover:bg-[#0c5a46]'
                        }`}
                      >
                        {checkProgress?.passed ? 'Retake the topic check' : checkProgress ? 'Try the topic check again' : 'Take the topic check'}
                      </Link>
                    ) : (
                      <span className="inline-flex items-center rounded-md border border-dashed border-line px-3 py-1.5 text-sm text-ink-faint">
                        Topic check coming soon
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-8 flex justify-between text-sm">
        {n > 1 ? (
          <Link to={`/courses/${course.slug}/units/${n - 1}`} className="text-ink-soft hover:text-ink">
            ← Unit {n - 1}
          </Link>
        ) : (
          <span />
        )}
        {n < total ? (
          <Link to={`/courses/${course.slug}/units/${n + 1}`} className="text-ink-soft hover:text-ink">
            Unit {n + 1} →
          </Link>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
