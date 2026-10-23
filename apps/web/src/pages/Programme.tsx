import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AREAS,
  CHECKS,
  courseBySlug,
  ENGINE_NAMES,
  labsForCourse,
  programmeBySlug,
  PROGRAMMES,
  TIER_LABEL,
  TIER_ORDER,
  type Course,
  type Tier,
} from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { NotFoundPage } from './NotFound';

export function ProgrammePage() {
  const { slug = '' } = useParams();
  const programme = programmeBySlug(slug);
  const [params, setParams] = useSearchParams();
  const labs = useProgress((s) => s.labs);
  const checks = useProgress((s) => s.checks);
  useEffect(() => {
    if (programme) document.title = `${programme.title} · CS Virtual Lab`;
    return () => {
      document.title = 'CS Virtual Lab';
    };
  }, [programme]);
  if (!programme) return <NotFoundPage />;

  const asked = params.get('level') as Tier | null;
  const tier: Tier = asked && TIER_ORDER.includes(asked) && programme.levels ? asked : 'bachelor';
  const level = programme.levels?.[tier];
  const toCourses = (list: string[]) => list.map((s) => courseBySlug(s)).filter((c): c is Course => !!c);
  const core = toCourses(level ? level.core : programme.courses);
  const electives = toCourses(level ? level.electives : []);
  const courses = [...core, ...electives];
  const allLabs = courses.flatMap((c) => labsForCourse(c.slug));
  const labsPassed = allLabs.filter((l) => labs[l.id]?.passed).length;
  const allChecks = CHECKS.filter((c) => courses.some((k) => k.slug === c.course));
  const checksPassed = allChecks.filter((c) => checks[`${c.course}:${c.unit}:${c.topic}`]?.passed).length;
  const engines = [...new Set(courses.flatMap((c) => c.engines))];
  const others = PROGRAMMES.filter((p) => p.slug !== programme.slug);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <nav className="text-sm text-ink-soft">
        <Link to="/#programmes" className="hover:text-ink">
          Programmes
        </Link>
        <span className="mx-2">/</span>
        <span>{programme.title}</span>
      </nav>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{programme.title}</h1>
      <p className="mt-3 max-w-[70ch] leading-relaxed">{programme.description}</p>

      <dl className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm max-w-2xl">
        <Stat label="Courses" value={courses.length} />
        <Stat label="Labs ready" value={allLabs.length} />
        <Stat label="Labs you passed" value={labsPassed} />
        <Stat label="Checks you passed" value={checksPassed} />
      </dl>

      <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section>
          {programme.levels && (
            <div role="tablist" aria-label="Level of study" className="mb-6 flex flex-wrap gap-2">
              {TIER_ORDER.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={t === tier}
                  onClick={() => setParams(t === 'bachelor' ? {} : { level: t }, { replace: true })}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    t === tier ? 'border-ink bg-ink text-white' : 'border-line bg-surface hover:bg-bench'
                  }`}
                >
                  {TIER_LABEL[t]}
                </button>
              ))}
            </div>
          )}
          {level && (
            <p className="mb-4 text-sm text-ink-soft">
              {level.award} · {level.years} years · {level.core.length} core courses
              {level.electives.length > 0 && ` and ${level.electivesRequired} of ${level.electives.length} electives`}
            </p>
          )}
          <h2 className="text-xl font-semibold">{electives.length > 0 ? 'Core courses' : 'Courses'}</h2>
          <p className="mt-1 text-sm text-ink-soft">
            A suggested order. Shared courses carry your progress between programmes. Courses without labs yet show their syllabus and
            topic checks where they exist.
          </p>
          <CourseList courses={core} />
          {electives.length > 0 && (
            <>
              <h2 className="mt-8 text-xl font-semibold">Electives</h2>
              <p className="mt-1 text-sm text-ink-soft">Choose {level?.electivesRequired ?? 'some'} of these.</p>
              <CourseList courses={electives} />
            </>
          )}
          {level && level.milestones.length > 0 && (
            <>
              <h2 className="mt-8 text-xl font-semibold">Milestones</h2>
              <ul className="mt-2 list-disc pl-5 space-y-1 text-[15px] leading-relaxed">
                {level.milestones.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="space-y-6">
          <div>
            <h2 className="text-xl font-semibold">By the end you can</h2>
            <ul className="mt-2 list-disc pl-5 space-y-1 text-[15px] leading-relaxed">
              {programme.outcomes.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="font-semibold">Simulators you will use</h2>
            <ul className="mt-2 flex flex-wrap gap-1.5 text-sm">
              {engines.map((e) => (
                <li key={e} className="rounded-md border border-line bg-surface px-2 py-0.5">
                  {ENGINE_NAMES[e] ?? e}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="font-semibold">Other programmes</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {others.map((p) => (
                <li key={p.slug}>
                  <Link to={`/programmes/${p.slug}`} className="text-ink-soft hover:text-ink underline-offset-2 hover:underline">
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}

function CourseList({ courses }: { courses: Course[] }) {
  const labs = useProgress((s) => s.labs);
  return (
    <ol className="mt-4 space-y-2">
      {courses.map((c, i) => {
        const courseLabs = labsForCourse(c.slug);
        const passed = courseLabs.filter((l) => labs[l.id]?.passed).length;
        const courseChecks = CHECKS.filter((k) => k.course === c.slug).length;
        const units = c.syllabus?.length ?? 0;
        return (
          <li key={c.slug}>
            <Link to={`/courses/${c.slug}`} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:border-ink-faint">
              <span className="font-mono text-sm text-ink-faint w-6 shrink-0 text-right">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{c.title}</span>
                <span className="block text-xs text-ink-soft truncate">
                  {AREAS[c.area]} · {c.engines.map((e) => ENGINE_NAMES[e] ?? e).join(', ')}
                </span>
              </span>
              <span className="text-xs font-mono text-ink-soft shrink-0 text-right">
                {courseLabs.length > 0 ? (
                  <span className={passed === courseLabs.length ? 'text-high' : ''}>
                    {passed}/{courseLabs.length} labs
                  </span>
                ) : (
                  <span className="text-ink-faint">{units > 0 ? `${units} units` : 'syllabus'}</span>
                )}
                {courseChecks > 0 && <span className="block text-ink-faint">{courseChecks} checks</span>}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-surface border border-line p-3">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-xl font-semibold font-mono">{value}</dd>
    </div>
  );
}
