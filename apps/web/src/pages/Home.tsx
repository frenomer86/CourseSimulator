import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Circuit } from '@cslab/engine-digital-logic';
import { COURSES, coursesByArea, labsForCourse } from '../lib/catalogue';
import { useProgress } from '../store/progress';
import { LogicCanvas } from '../components/LogicCanvas';

const HERO_CIRCUIT: Circuit = {
  nodes: [
    { id: 'a', type: 'INPUT', x: 40, y: 60, label: 'A', value: 1 },
    { id: 'b', type: 'INPUT', x: 40, y: 160, label: 'B', value: 0 },
    { id: 'x', type: 'XOR', x: 210, y: 60 },
    { id: 'n', type: 'AND', x: 210, y: 160 },
    { id: 's', type: 'OUTPUT', x: 390, y: 60, label: 'Sum' },
    { id: 'c', type: 'OUTPUT', x: 390, y: 160, label: 'Carry' },
  ],
  wires: [
    { id: 'w1', from: { node: 'a', port: 0 }, to: { node: 'x', port: 0 } },
    { id: 'w2', from: { node: 'b', port: 0 }, to: { node: 'x', port: 1 } },
    { id: 'w3', from: { node: 'a', port: 0 }, to: { node: 'n', port: 0 } },
    { id: 'w4', from: { node: 'b', port: 0 }, to: { node: 'n', port: 1 } },
    { id: 'w5', from: { node: 'x', port: 0 }, to: { node: 's', port: 0 } },
    { id: 'w6', from: { node: 'n', port: 0 }, to: { node: 'c', port: 0 } },
  ],
};

export function HomePage() {
  const [demo, setDemo] = useState<Circuit>(HERO_CIRCUIT);
  const progress = useProgress((s) => s.labs);
  const groups = coursesByArea();
  const totalLabs = COURSES.reduce((n, c) => n + labsForCourse(c.slug).length, 0);
  const done = Object.values(progress).filter((p) => p.passed).length;

  return (
    <div>
      <section className="bg-surface border-b border-line">
        <div className="mx-auto max-w-6xl px-4 py-10 lg:py-16 grid gap-10 lg:grid-cols-[1.1fr_1fr] items-center">
          <div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold leading-[1.1] tracking-tight">
              Every practical in your Computer Science degree, in your browser.
            </h1>
            <p className="mt-5 text-lg text-ink-soft max-w-[52ch] leading-relaxed">
              Wire circuits, subnet networks, query databases and run code with no lab kit, no server and no
              installation. Built for students across Africa who learn on a phone or a shared laptop.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href="#courses" className="rounded-md bg-high px-5 py-2.5 text-white font-medium hover:bg-[#0c5a46]">
                Browse the courses
              </a>
              <Link
                to="/courses/digital-logic-design"
                className="rounded-md border border-line bg-surface px-5 py-2.5 font-medium hover:bg-bench"
              >
                Start with Digital Logic
              </Link>
            </div>
            <dl className="mt-8 grid grid-cols-3 gap-4 max-w-md text-sm">
              <div>
                <dt className="text-ink-soft">Courses</dt>
                <dd className="text-2xl font-semibold font-mono">{COURSES.length}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">Labs ready</dt>
                <dd className="text-2xl font-semibold font-mono">{totalLabs}</dd>
              </div>
              <div>
                <dt className="text-ink-soft">You completed</dt>
                <dd className="text-2xl font-semibold font-mono">{done}</dd>
              </div>
            </dl>
          </div>
          <div>
            <div className="rounded-lg border border-line bg-bench p-3">
              <LogicCanvas circuit={demo} onChange={setDemo} width={460} height={230} compact />
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              A live half adder. Tap the A and B switches and watch the carry light up.
            </p>
          </div>
        </div>
      </section>

      <section id="courses" className="mx-auto max-w-6xl px-4 py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-2xl font-semibold">Courses</h2>
          <p className="text-sm text-ink-soft max-w-[60ch]">
            Organised by area. The year is the suggested place in a four-year degree. Courses without labs yet show
            their syllabus so you know what is coming.
          </p>
        </div>

        <div className="mt-6 grid gap-8 md:grid-cols-2">
          {groups.map((g) => (
            <div key={g.area}>
              <h3 className="font-semibold text-ink border-b-2 border-ink pb-1.5">{g.name}</h3>
              <ul className="mt-1 divide-y divide-line">
                {g.courses.map((c) => {
                  const labs = labsForCourse(c.slug);
                  const passed = labs.filter((l) => progress[l.id]?.passed).length;
                  return (
                    <li key={c.slug}>
                      <Link
                        to={`/courses/${c.slug}`}
                        className="flex items-center justify-between gap-3 py-2.5 hover:bg-surface -mx-2 px-2 rounded"
                      >
                        <span className="flex items-baseline gap-3 min-w-0">
                          <span className="font-mono text-xs text-ink-faint w-8 shrink-0">Y{c.year}</span>
                          <span className="truncate">{c.title}</span>
                        </span>
                        {labs.length > 0 ? (
                          <span className="font-mono text-xs shrink-0 flex items-center gap-1.5">
                            <span className={passed === labs.length ? 'text-high' : 'text-ink-soft'}>
                              {passed}/{labs.length}
                            </span>
                            <span className="inline-block w-12 h-1.5 rounded bg-bench-deep overflow-hidden">
                              <span
                                className="block h-full bg-high-bright"
                                style={{ width: `${(passed / labs.length) * 100}%` }}
                              />
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-ink-faint shrink-0">syllabus</span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
