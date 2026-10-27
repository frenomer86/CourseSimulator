/**
 * Shared builders for Web Application Security. This course is defensive throughout: learners
 * write the secure code (encoders, validators, authorisation checks, token handling, security
 * headers) and the least-privilege SQL that stops a class of attack, and reason through OWASP
 * triage, threat-modelling and remediation as case studies. Nothing here teaches how to run an
 * attack; every lab is about recognising a weakness and closing it.
 */

import type { Check, Variant } from '../types.js';
import { templateMaker } from '../common.js';

export { caseStudy, lab, mdSafe } from '../common.js';
export type { Person, Variant } from '../types.js';

export const COURSE = 'web-application-security';
export const tmpl = templateMaker(COURSE, 'was');

/** Small web applications the labs harden. Names and purposes only — never real hosts. */
export const APPS = [
  { app: 'fees-portal', org: 'a polytechnic fees portal', host: 'fees.campus.test', what: 'students pay and view fees' },
  { app: 'clinic-booking', org: 'a community clinic booking site', host: 'clinic.health.test', what: 'patients book appointments' },
  { app: 'momo-wallet', org: 'a mobile-money wallet', host: 'wallet.pay.test', what: 'users send and receive money' },
  { app: 'market-list', org: 'a farmers\' market listing board', host: 'market.agro.test', what: 'traders post produce prices' },
  { app: 'bus-tickets', org: 'an intercity bus ticketing service', host: 'tickets.transit.test', what: 'travellers buy tickets' },
  { app: 'library-cat', org: 'a university library catalogue', host: 'library.campus.test', what: 'readers borrow and reserve books' },
] as const;

export type App = (typeof APPS)[number];

/** An E1 JavaScript lab: starter code, function/script/source checks and the reference solution. */
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

/** An E5 SQL lab: the schema the lab provides, checks and the reference solution SQL. */
export function sql(o: { instructions: string; hints: string[]; schema: string; checks: Check[]; solution: string; realityNote: string }) {
  return {
    instructions: o.instructions,
    hints: o.hints,
    config: { language: 'sql', schema: o.schema },
    initialState: { schema: o.schema, sql: '' },
    checks: o.checks,
    solution: [o.solution],
    realityNote: o.realityNote,
  };
}

/** A code.function check. */
export const fn = (label: string, name: string, cases: Array<{ args: unknown[]; expected: unknown }>, tolerance?: number): Check =>
  ({ type: 'code.function', label, name, cases, ...(tolerance !== undefined ? { tolerance } : {}) }) as Check;

/** A code.source check: the learner's code must (or must not) match a pattern. */
export const src = (label: string, pattern: string, o: { flags?: string; mustMatch?: boolean; message?: string } = {}): Check =>
  ({ type: 'code.source', label, pattern, ...o }) as Check;

/** A code.script check: run assertions against the learner's definitions. */
export const script = (label: string, body: string, success?: string): Check =>
  ({ type: 'code.script', label, script: body, ...(success ? { success } : {}) }) as Check;

/** The app for a variant, rotated by variant number so consecutive variants always differ. */
export const appOf = (v: Variant): App => APPS[(v.n - 1) % APPS.length];
