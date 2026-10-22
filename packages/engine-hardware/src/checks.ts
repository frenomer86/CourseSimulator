/**
 * Checks for hardware labs, under the "hw.*" namespace. The lab's config says which bench is in use:
 *   config.mode = 'circuit' | 'assembly' | 'match' | 'bios' | 'board'
 *
 * circuit:  hw.expr { expr, expected?, tolerance?, min?, max? }     a quantity of the solved circuit (V(n), I(R1), P(R1)...)
 *           hw.answer { id, expected (number or expr), tolerance?, question, unit? }   a number typed by the learner
 *           hw.measured { kind: 'V'|'I'|'R', a?, b?, component? }   the learner used the multimeter on that point
 *           hw.lit { id, lit }                                       an LED or lamp is on/off
 *           hw.switch { id, closed }
 * assembly: hw.placed { slot, kind?, part? }, hw.buildValid {}, hw.budget { max }
 * match:    hw.matches {}                                            every item matched to its answer
 * bios:     hw.setting { key, value }
 * board:    hw.ran {}, hw.blink { pin, periodMs, tolerance?, minToggles? }, hw.follows { pin, input, inverted? },
 *           hw.serial { contains?|pattern?|minLines? }, hw.pwm { pin, minDistinct?, reachesMax? }, hw.servo { pin, angles },
 *           hw.pinState { pin, at, value }, hw.tone { pin }, hw.source { pattern?|contains?, message }
 */

import { CheckRegistry, type CheckResult, type CheckSpec, type LabSpec } from '@cslab/lab-runtime';
import { evalCircuitExpr, formatQuantity, isLit, solve, type Circuit } from './circuit.js';
import { buildCost, validateBuild, type Build, type PartKind } from './assembly.js';
import { blinkStats, followsInput, levelAt, pinTimeline, pwmStats, servoAngles, type BoardConfig, type BoardRun } from './board.js';

export type BenchMode = 'circuit' | 'assembly' | 'match' | 'bios' | 'board';

export interface Measurement {
  kind: 'V' | 'I' | 'R';
  a?: string;
  b?: string;
  component?: string;
  reading: number;
}

export interface MatchItem {
  id: string;
  name: string;
  /** A short description or an emoji/glyph standing in for a picture. */
  picture?: string;
  answer: string;
}

export interface BiosSetting {
  key: string;
  label: string;
  options: string[];
  help?: string;
}

export interface HardwareConfig {
  mode: BenchMode;
  circuit?: Circuit;
  adjustable?: Record<string, { min: number; max: number; step?: number; unit?: string }>;
  layout?: unknown;
  build?: Build;
  match?: { items: MatchItem[]; options: string[] };
  bios?: { settings: BiosSetting[] };
  board?: BoardConfig;
  starter?: string;
}

export interface HardwareState {
  values?: Record<string, number>;
  switches?: Record<string, boolean>;
  measurements?: Measurement[];
  answers?: Record<string, string>;
  placements?: Record<string, string>;
  matches?: Record<string, string>;
  settings?: Record<string, string>;
  source?: string;
  run?: BoardRun;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}

function cfg(lab: LabSpec<unknown>): HardwareConfig {
  return (lab.config ?? {}) as unknown as HardwareConfig;
}

function within(actual: number, spec: CheckSpec): string | null {
  if (!Number.isFinite(actual)) return 'the value could not be computed';
  if (spec.min !== undefined && actual < Number(spec.min)) return `it is ${fmt(actual, spec)}, below the minimum ${fmt(Number(spec.min), spec)}`;
  if (spec.max !== undefined && actual > Number(spec.max)) return `it is ${fmt(actual, spec)}, above the maximum ${fmt(Number(spec.max), spec)}`;
  if (spec.expected !== undefined) {
    const exp = Number(spec.expected);
    const tol = spec.tolerance !== undefined ? Number(spec.tolerance) : 0.05;
    const diff = Math.abs(actual - exp);
    if (diff > Math.max(Math.abs(exp) * tol, Number(spec.absolute ?? 1e-9))) return `it is ${fmt(actual, spec)}, but should be about ${fmt(exp, spec)}`;
  }
  return null;
}

function fmt(x: number, spec: CheckSpec): string {
  return spec.unit ? formatQuantity(x, String(spec.unit)) : String(Number(x.toPrecision(4)));
}

export function createHardwareChecks(): CheckRegistry<HardwareState> {
  return new CheckRegistry<HardwareState>()
    /* ---------------------------------------------------------------- circuit */
    .register('hw.expr', async (state, spec, lab) => {
      const c = cfg(lab).circuit;
      if (!c) return fail(spec, 'This lab has no circuit. This is a content error, not yours.');
      const sol = solve(c, state.values ?? {}, state.switches ?? {});
      if (!sol.ok) return fail(spec, `The circuit cannot be solved: ${sol.error}`);
      const v = evalCircuitExpr(String(spec.expr), c, sol, state.values ?? {});
      const problem = within(v, spec);
      return problem ? fail(spec, String(spec.message ?? `${String(spec.what ?? spec.expr)}: ${problem}.`)) : pass(spec, String(spec.success ?? `${String(spec.what ?? spec.expr)} = ${fmt(v, spec)}.`));
    })
    .register('hw.answer', async (state, spec, lab) => {
      const text = (state.answers?.[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      const n = parseNumberWithPrefix(text);
      if (n === null) return fail(spec, `"${text}" is not a number. Type the value, with a prefix if you like (for example 4.7k or 12m).`);
      let expected = Number(spec.expected);
      if (typeof spec.expected === 'string' && Number.isNaN(expected)) {
        const c = cfg(lab).circuit;
        if (!c) return fail(spec, 'This lab has no circuit. This is a content error, not yours.');
        const sol = solve(c, state.values ?? {}, state.switches ?? {});
        expected = evalCircuitExpr(spec.expected, c, sol, state.values ?? {});
      }
      const problem = within(n, { ...spec, expected, min: undefined, max: undefined });
      return problem ? fail(spec, String(spec.message ?? 'Not quite. Measure it with the multimeter, or work it out from Ohm\'s law and the divider rules.')) : pass(spec, String(spec.success ?? `Right: ${fmt(expected, spec)}.`));
    })
    .register('hw.measured', async (state, spec) => {
      const ms = state.measurements ?? [];
      const kind = String(spec.kind);
      const hit = ms.some((m) => {
        if (m.kind !== kind) return false;
        if (spec.component) return m.component === spec.component;
        const pair = [String(spec.a), String(spec.b)];
        return (m.a === pair[0] && m.b === pair[1]) || (m.a === pair[1] && m.b === pair[0]);
      });
      const what = spec.component ? `the current through ${String(spec.component)}` : `${kind === 'V' ? 'the voltage' : kind === 'R' ? 'the resistance' : 'the current'} between ${String(spec.a)} and ${String(spec.b)}`;
      return hit ? pass(spec, `You measured ${what}.`) : fail(spec, String(spec.message ?? `Use the multimeter to measure ${what}.`));
    })
    .register('hw.lit', async (state, spec, lab) => {
      const c = cfg(lab).circuit;
      const comp = c?.components.find((x) => x.id === String(spec.id));
      if (!c || !comp) return fail(spec, 'No such lamp in this lab. This is a content error, not yours.');
      const sol = solve(c, state.values ?? {}, state.switches ?? {});
      if (!sol.ok) return fail(spec, `The circuit cannot be solved: ${sol.error}`);
      const lit = isLit(comp, sol);
      const want = spec.lit !== false;
      return lit === want ? pass(spec, `${comp.label ?? comp.id} is ${lit ? 'on' : 'off'}.`) : fail(spec, String(spec.message ?? `${comp.label ?? comp.id} should be ${want ? 'on' : 'off'} but is ${lit ? 'on' : 'off'}.`));
    })
    .register('hw.switch', async (state, spec, lab) => {
      const comp = cfg(lab).circuit?.components.find((x) => x.id === String(spec.id));
      const closed = state.switches?.[String(spec.id)] ?? comp?.closed ?? false;
      const want = spec.closed !== false;
      return closed === want ? pass(spec, `${String(spec.id)} is ${closed ? 'closed' : 'open'}.`) : fail(spec, String(spec.message ?? `${String(spec.id)} should be ${want ? 'closed' : 'open'}.`));
    })

    /* ---------------------------------------------------------------- assembly */
    .register('hw.placed', async (state, spec, lab) => {
      const build = cfg(lab).build;
      if (!build) return fail(spec, 'This lab has no build. This is a content error, not yours.');
      const slot = build.slots.find((s) => s.id === String(spec.slot));
      const partId = state.placements?.[String(spec.slot)];
      const part = build.parts.find((p) => p.id === partId);
      if (!slot) return fail(spec, 'No such slot. This is a content error, not yours.');
      if (!part) return fail(spec, String(spec.message ?? `${slot.label} is still empty.`));
      if (spec.kind && part.kind !== (spec.kind as PartKind)) return fail(spec, `${slot.label} holds ${part.name}, not a ${String(spec.kind)}.`);
      if (spec.part && part.id !== spec.part) return fail(spec, String(spec.message ?? `${slot.label} holds ${part.name}; that is not the right choice for this build.`));
      return pass(spec, `${slot.label}: ${part.name}.`);
    })
    .register('hw.buildValid', async (state, spec, lab) => {
      const build = cfg(lab).build;
      if (!build) return fail(spec, 'This lab has no build. This is a content error, not yours.');
      const v = validateBuild(build, state.placements ?? {}, spec.margin !== undefined ? Number(spec.margin) : 1.25);
      if (v.missing.length) return fail(spec, `Still empty: ${v.missing.map((s) => s.label).join(', ')}.`);
      if (v.problems.length) return fail(spec, v.problems.map((p) => p.message).join(' '));
      return pass(spec, `Every part fits and the supply has headroom (${v.wattage.used} W drawn, ${v.wattage.rating} W rated).`);
    })
    .register('hw.budget', async (state, spec, lab) => {
      const build = cfg(lab).build;
      if (!build) return fail(spec, 'This lab has no build. This is a content error, not yours.');
      const cost = buildCost(build, state.placements ?? {});
      return cost <= Number(spec.max) ? pass(spec, `The build costs GH₵${cost}, within the GH₵${String(spec.max)} budget.`) : fail(spec, `The build costs GH₵${cost}, over the GH₵${String(spec.max)} budget.`);
    })

    /* ---------------------------------------------------------------- match */
    .register('hw.matches', async (state, spec, lab) => {
      const items = cfg(lab).match?.items ?? [];
      const wrong = items.filter((it) => (state.matches?.[it.id] ?? '') !== it.answer);
      const blank = wrong.filter((it) => !state.matches?.[it.id]);
      if (!wrong.length) return pass(spec, `All ${items.length} matched correctly.`);
      if (blank.length === wrong.length) return fail(spec, `${blank.length} item${blank.length === 1 ? ' is' : 's are'} not matched yet.`);
      return fail(spec, `${wrong.length} of ${items.length} are wrong: ${wrong.filter((w) => state.matches?.[w.id]).map((w) => w.name).join(', ')}. Look again at the shape and the purpose.`);
    })

    /* ---------------------------------------------------------------- bios */
    .register('hw.setting', async (state, spec, lab) => {
      const def = cfg(lab).bios?.settings.find((s) => s.key === String(spec.key));
      const value = state.settings?.[String(spec.key)];
      if (!def) return fail(spec, 'No such setting. This is a content error, not yours.');
      return value === String(spec.value) ? pass(spec, `${def.label}: ${value}.`) : fail(spec, String(spec.message ?? `${def.label} is "${value ?? 'unset'}"; it should be "${String(spec.value)}".`));
    })

    /* ---------------------------------------------------------------- board */
    .register('hw.ran', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      if (state.run.error) return fail(spec, `The sketch stopped with an error: ${state.run.error}`);
      return pass(spec, `The sketch ran for ${Math.round(state.run.endMs)} ms of board time (${state.run.loops} loop${state.run.loops === 1 ? '' : 's'}).`);
    })
    .register('hw.blink', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const s = blinkStats(state.run, spec.pin as number | string);
      const minToggles = Number(spec.minToggles ?? 4);
      if (s.toggles < minToggles) return fail(spec, String(spec.message ?? `Pin ${String(spec.pin)} changed ${s.toggles} time${s.toggles === 1 ? '' : 's'}; it should keep toggling (at least ${minToggles} changes in the run). Remember delay() between writes.`));
      if (spec.periodMs !== undefined && s.periodMs !== null) {
        const tol = Number(spec.tolerance ?? 0.2);
        if (Math.abs(s.periodMs - Number(spec.periodMs)) > Number(spec.periodMs) * tol) return fail(spec, `Pin ${String(spec.pin)} blinks with a period of about ${Math.round(s.periodMs)} ms; it should be ${String(spec.periodMs)} ms.`);
      }
      if (spec.dutyCycle !== undefined && s.dutyCycle !== null && Math.abs(s.dutyCycle - Number(spec.dutyCycle)) > Number(spec.tolerance ?? 0.2)) return fail(spec, `The on time is ${Math.round(s.dutyCycle * 100)}% of the period; it should be ${Math.round(Number(spec.dutyCycle) * 100)}%.`);
      return pass(spec, `Pin ${String(spec.pin)} blinks${s.periodMs ? ` every ${Math.round(s.periodMs)} ms` : ''}.`);
    })
    .register('hw.follows', async (state, spec, lab) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const input = cfg(lab).board?.components.find((c) => String(c.pin) === String(spec.input));
      if (!input) return fail(spec, 'No such input in this lab. This is a content error, not yours.');
      const r = followsInput(state.run, spec.pin as number | string, input, spec.inverted === true);
      return r.ok ? pass(spec, r.detail) : fail(spec, String(spec.message ?? r.detail));
    })
    .register('hw.serial', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const text = state.run.serial;
      const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);
      for (const c of list(spec.contains)) if (!text.includes(c)) return fail(spec, String(spec.message ?? `The serial monitor should show "${c}".`));
      if (spec.pattern !== undefined && !new RegExp(String(spec.pattern), 'm').test(text)) return fail(spec, String(spec.message ?? 'The serial output does not match what was asked for.'));
      const lines = text.split('\n').filter((l) => l.trim()).length;
      if (spec.minLines !== undefined && lines < Number(spec.minLines)) return fail(spec, String(spec.message ?? `The serial monitor shows ${lines} line${lines === 1 ? '' : 's'}; at least ${String(spec.minLines)} expected. Is the print inside loop()?`));
      return pass(spec, String(spec.success ?? `The serial monitor shows the right output (${lines} line${lines === 1 ? '' : 's'}).`));
    })
    .register('hw.pwm', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const s = pwmStats(state.run, spec.pin as number | string);
      if (!s.writes) return fail(spec, String(spec.message ?? `Nothing was written with analogWrite to pin ${String(spec.pin)}.`));
      if (spec.minDistinct !== undefined && s.distinct < Number(spec.minDistinct)) return fail(spec, `Pin ${String(spec.pin)} only saw ${s.distinct} different PWM value${s.distinct === 1 ? '' : 's'}; a fade needs many steps.`);
      if (spec.reachesMax && s.max < 250) return fail(spec, `The PWM value on pin ${String(spec.pin)} only reached ${s.max}; it should reach 255.`);
      if (spec.reachesMin && s.min > 5) return fail(spec, `The PWM value on pin ${String(spec.pin)} never went below ${s.min}; it should reach 0.`);
      return pass(spec, `Pin ${String(spec.pin)} was driven with PWM from ${s.min} to ${s.max} (${s.distinct} levels).`);
    })
    .register('hw.servo', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const angles = servoAngles(state.run, spec.pin as number | string);
      if (!angles.length) return fail(spec, `The servo on pin ${String(spec.pin)} was never moved (servo.write).`);
      const want = (spec.angles as number[] | undefined) ?? [];
      const missing = want.filter((a) => !angles.some((x) => Math.abs(x - a) <= Number(spec.tolerance ?? 5)));
      return missing.length ? fail(spec, `The servo went to ${[...new Set(angles)].join(', ')}°, but never to ${missing.join('° or ')}°.`) : pass(spec, `The servo reached ${want.join('°, ')}°.`);
    })
    .register('hw.pinState', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const v = levelAt(state.run, spec.pin as number | string, Number(spec.at));
      const want = Number(spec.value) ? 1 : 0;
      if (v === null) return fail(spec, `Pin ${String(spec.pin)} was never written by ${String(spec.at)} ms.`);
      return v === want ? pass(spec, `Pin ${String(spec.pin)} was ${want ? 'HIGH' : 'LOW'} at ${String(spec.at)} ms.`) : fail(spec, String(spec.message ?? `Pin ${String(spec.pin)} was ${v ? 'HIGH' : 'LOW'} at ${String(spec.at)} ms; it should be ${want ? 'HIGH' : 'LOW'}.`));
    })
    .register('hw.tone', async (state, spec) => {
      if (!state.run) return fail(spec, 'Run the sketch first.');
      const tones = pinTimeline(state.run, spec.pin as number | string, 'tone').filter((e) => e.v > 0);
      if (!tones.length) return fail(spec, String(spec.message ?? `No tone was played on pin ${String(spec.pin)}. Use tone(pin, frequency).`));
      if (spec.minFrequency !== undefined && !tones.some((t) => t.v >= Number(spec.minFrequency))) return fail(spec, `The highest tone was ${Math.max(...tones.map((t) => t.v))} Hz; at least ${String(spec.minFrequency)} Hz expected.`);
      return pass(spec, `A tone of ${tones[0].v} Hz played on pin ${String(spec.pin)}.`);
    })
    .register('hw.source', async (state, spec) => {
      const src = state.source ?? '';
      if (spec.contains !== undefined && !src.includes(String(spec.contains))) return fail(spec, String(spec.message ?? `The sketch should use ${String(spec.contains)}.`));
      if (spec.pattern !== undefined && !new RegExp(String(spec.pattern), 'm').test(src)) return fail(spec, String(spec.message ?? 'The sketch does not contain what was asked for.'));
      if (spec.notPattern !== undefined && new RegExp(String(spec.notPattern), 'm').test(src)) return fail(spec, String(spec.message ?? 'The sketch contains something it should not.'));
      return pass(spec, String(spec.success ?? 'The sketch has the required code.'));
    });
}

/** "4.7k" → 4700, "12m" → 0.012, "2.2M" → 2.2e6, "100" → 100, "0.5 A" → 0.5 */
export function parseNumberWithPrefix(text: string): number | null {
  const m = /^\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*([kKMmuµGn]?)\s*(?:[A-Za-zΩ]*)\s*$/.exec(text.replace(/,/g, ''));
  if (!m) return null;
  const mult: Record<string, number> = { '': 1, k: 1e3, K: 1e3, M: 1e6, m: 1e-3, u: 1e-6, µ: 1e-6, G: 1e9, n: 1e-9 };
  return Number(m[1]) * (mult[m[2]] ?? 1);
}
