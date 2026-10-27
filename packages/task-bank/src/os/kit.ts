/**
 * Shared builders for Operating Systems. The course is taught through algorithm labs (E1,
 * JavaScript): learners implement scheduling, synchronisation accounting, memory translation,
 * page and disk-scheduling algorithms, and file-system structures, and reason about design
 * trade-offs as case studies (E10). No real kernel runs; the algorithms are the point.
 */

import type { Check, Variant } from '../types.js';
import { templateMaker } from '../common.js';

export { caseStudy, lab, mdSafe } from '../common.js';
export type { Person, Variant } from '../types.js';

export const COURSE = 'operating-systems';
export const tmpl = templateMaker(COURSE, 'os');

/** Machines and workloads the labs talk about, for flavour and per-variant variation. */
export const MACHINES = [
  { host: 'lab-server', use: 'a shared teaching server' },
  { host: 'kiosk', use: 'a library catalogue kiosk' },
  { host: 'router', use: 'a campus edge router' },
  { host: 'phone', use: 'a budget Android phone' },
  { host: 'till', use: 'a market stall point-of-sale' },
  { host: 'sensor-hub', use: 'a farm sensor gateway' },
] as const;

export type Machine = (typeof MACHINES)[number];

/** The machine for a variant, rotated by variant number so consecutive variants always differ. */
export const machineOf = (v: Variant): Machine => MACHINES[(v.n - 1) % MACHINES.length];

/** An E1 JavaScript lab: starter code, function/source checks and the reference solution. */
export function js(o: { instructions: string; hints: string[]; starter: string; checks: Check[]; solution: string; realityNote: string }) {
  return {
    instructions: o.instructions,
    hints: o.hints,
    config: { language: 'javascript' },
    initialState: { language: 'javascript', source: o.starter },
    checks: [{ type: 'code.runs', label: 'The program runs' } as Check, ...o.checks],
    solution: [o.solution],
    realityNote: o.realityNote,
  };
}

/** A code.function check. */
export const fn = (label: string, name: string, cases: Array<{ args: unknown[]; expected: unknown }>, tolerance?: number): Check =>
  ({ type: 'code.function', label, name, cases, ...(tolerance !== undefined ? { tolerance } : {}) }) as Check;

/** A code.source check. */
export const src = (label: string, pattern: string, o: { flags?: string; mustMatch?: boolean; message?: string } = {}): Check =>
  ({ type: 'code.source', label, pattern, ...o }) as Check;
