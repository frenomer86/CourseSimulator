import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, LEVEL_ORDER, masteryRank, type LabLevel } from '@cslab/lab-runtime';
import {
  AREAS,
  checkForTopic,
  courseBySlug,
  ENGINE_NAMES,
  labsForCourse,
  labsForUnit,
  loadSchedule,
  programmesForCourse,
  TIER_LABEL,
  topicByRef,
  type Course,
  type ScheduleWeek,
} from '../lib/catalogue';
import { topicMastery, useProgress } from '../store/progress';
import { track } from '../lib/telemetry';
import { MasteryDot, MasteryLegend } from '../components/Mastery';
import { NotFoundPage } from './NotFound';

const LEVEL_HINT: Record<LabLevel, string> = {
  beginner: 'Guided. The bench shows you each step.',
  intermediate: 'A goal and hints. The checker grades your work.',
  advanced: 'An open challenge with real constraints.',
};

export function CoursePage() {
  const { slug = '' } = useParams();
  const course = courseBySlug(slug);
  const progress = useProgress((s) => s.labs);
  const topics = useProgress((s) => s.topics);
  const checks = useProgress((s) => s.checks);
  useEffect(() => {
    if (course) track('viewed', { type: 'course', id: course.slug, course: course.slug });
  }, [course]);
  if (!course) return <NotFoundPage />;
  const labs = labsForCourse(course.slug);
  const state = { labs: progress, topics, checks };

  const units = course.syllabus ?? [];
  const totalTopics = units.reduce((n, u) => n + u.topics.length, 0);
  const proficientTopics = units.reduce(
    (n, u, ui) => n + u.topics.filter((_, ti) => masteryRank(topicMastery(state, course.slug, ui + 1, ti + 1)) >= 2).length,
    0,
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="text-sm text-ink-soft">
        <Link to="/#courses" className="hover:text-ink">
          Courses
        </Link>
        <span className="mx-2">/</span>
        <span>{AREAS[course.area]}</span>
      </nav>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{course.title}</h1>
      <p className="mt-2 text-ink-soft text-sm">
        {course.level !== 'bachelor' && `${TIER_LABEL[course.level]} course · `}
        {course.engines.map((e) => ENGINE_NAMES[e] ?? e).join(', ')}
      </p>
      {course.description && <p className="mt-4 max-w-[70ch] leading-relaxed">{course.description}</p>}
      <InProgrammes slug={course.slug} />
      <p className="mt-3 flex flex-wrap gap-2 text-sm">
        <Link to={`/forum/c/${course.slug}`} className="rounded-md border border-line bg-surface px-3 py-1.5 hover:bg-bench">
          Questions about this course
        </Link>
        <Link to={`/community?course=${course.slug}`} className="rounded-md border border-line bg-surface px-3 py-1.5 hover:bg-bench">
          Study groups
        </Link>
      </p>

      {units.length > 0 ? (
        <section className="mt-8">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Units</h2>
              <p className="text-sm text-ink-soft mt-1">
                Each unit is a few topics. Pass a topic check to become proficient; pass an Advanced lab to master it.
              </p>
            </div>
            <div className="text-sm text-ink-soft flex items-center gap-3">
              <span className="font-mono">
                <span className={proficientTopics === totalTopics ? 'text-high' : 'text-ink'}>{proficientTopics}</span>/{totalTopics}{' '}
                topics proficient
              </span>
              <span className="inline-block w-24 h-1.5 rounded bg-bench-deep overflow-hidden">
                <span
                  className="block h-full bg-high-bright"
                  style={{ width: `${totalTopics ? (proficientTopics / totalTopics) * 100 : 0}%` }}
                />
              </span>
            </div>
          </div>
          <div className="mt-3">
            <MasteryLegend />
          </div>

          <ol className="mt-4 grid gap-3 md:grid-cols-2">
            {units.map((u, ui) => {
              const n = ui + 1;
              const unitLabs = labsForUnit(course.slug, n);
              const checksReady = u.topics.filter((_, ti) => checkForTopic(course.slug, n, ti + 1)).length;
              const done = u.topics.filter((_, ti) => masteryRank(topicMastery(state, course.slug, n, ti + 1)) >= 2).length;
              return (
                <li key={u.title}>
                  <Link
                    to={`/courses/${course.slug}/units/${n}`}
                    className="block rounded-lg border border-line bg-surface p-4 hover:border-ink-faint h-full"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="font-medium leading-snug">
                        <span className="font-mono text-ink-faint mr-2">Unit {n}</span>
                        {u.title}
                      </h3>
                      {u.weeks && <span className="text-xs text-ink-faint font-mono shrink-0">weeks {u.weeks}</span>}
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
                      {u.topics.map((t, ti) => (
                        <span key={t} title={t}>
                          <MasteryDot mastery={topicMastery(state, course.slug, n, ti + 1)} />
                        </span>
                      ))}
                      <span className="ml-auto font-mono text-xs text-ink-soft">
                        {done}/{u.topics.length}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-ink-soft">
                      {u.topics.length} topics
                      {checksReady > 0 && ` · ${checksReady} check${checksReady === 1 ? '' : 's'}`}
                      {unitLabs.length > 0 && ` · ${unitLabs.length} lab${unitLabs.length === 1 ? '' : 's'}`}
                      {checksReady === 0 && unitLabs.length === 0 && ' · reading only for now'}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
      ) : (
        <section className="mt-8">
          <h2 className="text-xl font-semibold">Topics</h2>
          <p className="text-sm text-ink-soft mt-1">A detailed syllabus for this course is still being written.</p>
          <ul className="mt-3 list-disc pl-5 space-y-1.5 leading-relaxed">
            {course.topics.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      )}

      {course.weeks && <WeeklyPlan course={course} />}

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_1fr]">
        <section>
          <h2 className="text-xl font-semibold">All labs</h2>
          {labs.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-line bg-surface p-5 text-ink-soft">
              <p>No labs are published for this course yet. The units above show what they will cover.</p>
            </div>
          ) : (
            <div className="mt-3 space-y-5">
              {LEVEL_ORDER.map((level) => {
                const group = labs.filter((l) => l.level === level);
                if (group.length === 0) return null;
                return (
                  <div key={level}>
                    <h3 className="font-medium flex items-baseline gap-2">
                      {LEVEL_LABEL[level]}
                      <span className="text-sm font-normal text-ink-soft">{LEVEL_HINT[level]}</span>
                    </h3>
                    <ol className="mt-2 space-y-2">
                      {group.map((lab) => {
                        const p = progress[lab.id];
                        return (
                          <li key={lab.id}>
                            <Link
                              to={`/labs/${lab.id}`}
                              className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:border-ink-faint"
                            >
                              <span
                                className={`size-6 shrink-0 rounded-full border-2 grid place-items-center text-xs font-mono ${
                                  p?.passed ? 'border-high bg-high text-white' : 'border-line text-ink-faint'
                                }`}
                                aria-label={p?.passed ? 'Completed' : 'Not completed'}
                              >
                                {p?.passed ? '✓' : ''}
                              </span>
                              <span className="flex-1 min-w-0">
                                <span className="block font-medium truncate">{lab.title}</span>
                                <span className="block text-sm text-ink-soft truncate">
                                  {lab.unit ? `Unit ${lab.unit} · ` : ''}
                                  {lab.topic}
                                </span>
                              </span>
                              <span className="text-sm text-ink-faint font-mono shrink-0">{lab.estimatedMinutes} min</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ol>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          {course.outcomes && (
            <div>
              <h2 className="text-xl font-semibold">By the end you can</h2>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-[15px] leading-relaxed">
                {course.outcomes.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          )}
          {course.modelledOn && (
            <p className="mt-4 text-sm text-ink-soft">Depth modelled on: {course.modelledOn.join('; ')}.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function InProgrammes({ slug }: { slug: string }) {
  const list = programmesForCourse(slug);
  if (list.length === 0) return null;
  return (
    <p className="mt-3 text-sm text-ink-soft">
      Part of {list.length === 1 ? 'the programme' : `${list.length} programmes`}:{' '}
      {list.map((p, i) => (
        <span key={p.slug}>
          {i > 0 && ', '}
          <Link to={`/programmes/${p.slug}`} className="text-ink underline underline-offset-2 hover:text-high">
            {p.title}
          </Link>
        </span>
      ))}
      .
    </p>
  );
}

/** The course laid out as teaching weeks, each with an exercise and simulation tasks a lecturer can assign. */
function WeeklyPlan({ course }: { course: Course }) {
  const [weeks, setWeeks] = useState<ScheduleWeek[]>([]);
  useEffect(() => {
    let live = true;
    setWeeks([]);
    loadSchedule(course.slug).then((w) => live && setWeeks(w ?? []));
    return () => {
      live = false;
    };
  }, [course.slug]);
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold">Week by week</h2>
      <p className="text-sm text-ink-soft mt-1">
        {course.weeks} teaching weeks. Each has an exercise and simulation tasks at three levels that a lecturer can assign.
      </p>
      <ol className="mt-4 space-y-2">
        {weeks.map((w) => (
          <li key={w.week}>
            <details className="rounded-lg border border-line bg-surface px-4 py-3">
              <summary className="cursor-pointer">
                <span className="font-mono text-sm text-ink-faint mr-3">Week {w.week}</span>
                <span className="font-medium">{w.title}</span>
              </summary>
              <div className="mt-3 space-y-3 text-[15px] leading-relaxed">
                <ul className="list-disc pl-5 text-ink-soft">
                  {w.topics.map((ref) => (
                    <li key={ref}>
                      <Link to={`/courses/${course.slug}/units/${ref.split('.')[0]}`} className="hover:text-ink">
                        {topicByRef(course, ref)}
                      </Link>
                    </li>
                  ))}
                </ul>
                <p>
                  <span className="font-medium">Exercise.</span> {w.exercise}
                </p>
                <ul className="space-y-1.5">
                  {w.tasks.map((t) => (
                    <li key={t.level + t.title} className="flex gap-2">
                      <span className="shrink-0 self-start rounded border border-line px-1.5 py-0.5 text-xs font-mono">
                        {LEVEL_LABEL[t.level]}
                      </span>
                      <span>
                        {t.title} <span className="text-sm text-ink-faint">· {ENGINE_NAMES[t.engine] ?? t.engine}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
