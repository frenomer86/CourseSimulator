import { Link, useParams } from 'react-router-dom';
import { LEVEL_LABEL, LEVEL_ORDER, type LabLevel } from '@cslab/lab-runtime';
import { AREAS, courseBySlug, ENGINE_NAMES, labsForCourse } from '../lib/catalogue';
import { useProgress } from '../store/progress';
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
  if (!course) return <NotFoundPage />;
  const labs = labsForCourse(course.slug);

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
      <p className="mt-2 text-ink-soft flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span>
          Year {course.year}, semester {course.semester}
        </span>
        <span>{course.engines.map((e) => ENGINE_NAMES[e] ?? e).join(', ')}</span>
      </p>
      {course.description && <p className="mt-4 max-w-[70ch] leading-relaxed">{course.description}</p>}

      <div className="mt-8 grid gap-10 lg:grid-cols-[1fr_1.1fr]">
        <section>
          <h2 className="text-xl font-semibold">Labs</h2>
          {labs.length === 0 ? (
            <div className="mt-3 rounded-lg border border-dashed border-line bg-surface p-5 text-ink-soft">
              <p>No labs are published for this course yet. The syllabus on this page shows what they will cover.</p>
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
                                <span className="block text-sm text-ink-soft truncate">{lab.topic}</span>
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
          <h2 className="text-xl font-semibold">Syllabus</h2>
          {course.outcomes && (
            <div className="mt-3">
              <h3 className="font-medium">By the end you can</h3>
              <ul className="mt-1.5 list-disc pl-5 space-y-1 text-[15px] leading-relaxed">
                {course.outcomes.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          )}
          {course.syllabus ? (
            <ol className="mt-4 space-y-4">
              {course.syllabus.map((u, i) => (
                <li key={u.title} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">
                      <span className="font-mono text-ink-faint mr-2">{i + 1}</span>
                      {u.title}
                    </h3>
                    {u.weeks && <span className="text-xs text-ink-faint font-mono shrink-0">weeks {u.weeks}</span>}
                  </div>
                  <ul className="mt-2 list-disc pl-5 space-y-1 text-[15px] leading-relaxed text-ink-soft">
                    {u.topics.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          ) : (
            <ul className="mt-3 list-disc pl-5 space-y-1.5 leading-relaxed">
              {course.topics.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
          {course.modelledOn && (
            <p className="mt-4 text-sm text-ink-soft">
              Depth modelled on: {course.modelledOn.join('; ')}.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
