/**
 * Checks for mobile labs, under the "mobile.*" namespace. The state is the app JSON and answers.
 *
 *   mobile.valid     {}                                            the JSON parses and has no structural problems
 *   mobile.screen    { name, widget?: { type, text?, id? }, title? }
 *   mobile.flow      { steps: [...], screen?, text?, notText?, toast?, dialog?, list?: { from, count }, noErrors?: true,
 *                      lifecycle?: [patterns in order], request?: { url, ok }, permission?: { name, result }, persisted?: key,
 *                      offline?: true }                           runs the script on the device and inspects the result
 *   mobile.answer    { id, expected, options? }
 */

import { CheckRegistry, type CheckResult, type CheckSpec, type LabSpec } from '@cslab/lab-runtime';
import { parseApp, type DeviceConfig } from './app.js';
import { current, lifecycleOf, runScript, screenText } from './runtime.js';

export interface MobileConfig {
  device?: DeviceConfig;
  starter?: string;
}

export interface MobileState {
  source: string;
  answers?: Record<string, string>;
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}
function device(lab: LabSpec<unknown>, spec: CheckSpec): DeviceConfig {
  const base = ((lab.config as MobileConfig | undefined)?.device ?? {}) as DeviceConfig;
  return { ...base, offline: spec.offline === true ? true : base.offline, permissions: { ...(base.permissions ?? {}), ...((spec.permissions as Record<string, 'grant' | 'deny'> | undefined) ?? {}) } };
}

export function createMobileChecks(): CheckRegistry<MobileState> {
  return new CheckRegistry<MobileState>()
    .register('mobile.valid', async (state, spec) => {
      if (!state.source?.trim()) return fail(spec, 'Write the app first.');
      const { app, problems } = parseApp(state.source);
      if (!app) return fail(spec, problems[0]?.message ?? 'The app is not valid.');
      if (problems.length) return fail(spec, `The app has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.slice(0, 3).map((p) => p.message).join(' ')}`);
      return pass(spec, `The app has ${Object.keys(app.screens).length} screen${Object.keys(app.screens).length === 1 ? '' : 's'} and starts on ${app.start}.`);
    })

    .register('mobile.screen', async (state, spec) => {
      const { app } = parseApp(state.source ?? '');
      if (!app) return fail(spec, 'The app does not parse yet.');
      const s = app.screens[String(spec.name)];
      if (!s) return fail(spec, String(spec.message ?? `There is no screen called "${String(spec.name)}".`));
      if (spec.title !== undefined && !new RegExp(String(spec.title), 'i').test(s.title ?? '')) return fail(spec, `${String(spec.name)} should have a title like "${String(spec.title)}".`);
      const w = spec.widget as { type?: string; text?: string; id?: string } | undefined;
      if (w) {
        const hit = s.widgets.find((x) => (!w.type || x.type === w.type) && (!w.text || ('text' in x && new RegExp(w.text, 'i').test(String(x.text)))) && (!w.id || ('id' in x && x.id === w.id)));
        if (!hit) return fail(spec, String(spec.message ?? `${String(spec.name)} needs a ${w.type ?? 'widget'}${w.text ? ` with text like "${w.text}"` : ''}${w.id ? ` with id "${w.id}"` : ''}.`));
      }
      return pass(spec, String(spec.success ?? `${String(spec.name)} is set up.`));
    })

    .register('mobile.flow', async (state, spec, lab) => {
      const { app, problems } = parseApp(state.source ?? '');
      if (!app) return fail(spec, problems[0]?.message ?? 'The app does not parse yet.');
      const d = runScript(app, device(lab, spec), (spec.steps as string[] | undefined) ?? []);
      const cur = current(d);
      if (spec.noErrors && d.errors.length) return fail(spec, String(spec.message ?? `During "${((spec.steps as string[]) ?? []).join(', ')}": ${d.errors[0]}`), d.errors);
      if (spec.screen !== undefined && cur?.screen !== spec.screen) return fail(spec, String(spec.message ?? `After the steps the app shows ${cur ? cur.screen : 'nothing (it exited)'}, but it should show ${String(spec.screen)}.`));
      const text = cur ? screenText(d) : '';
      if (spec.text !== undefined && !new RegExp(String(spec.text), 'i').test(text)) return fail(spec, String(spec.message ?? `The screen should show text like "${String(spec.text)}". It shows: ${text.replace(/\n/g, ' | ').slice(0, 120)}`));
      if (spec.notText !== undefined && new RegExp(String(spec.notText), 'i').test(text)) return fail(spec, String(spec.message ?? `The screen should no longer show "${String(spec.notText)}".`));
      if (spec.toast !== undefined && !d.toasts.some((t) => new RegExp(String(spec.toast), 'i').test(t))) return fail(spec, String(spec.message ?? `A toast like "${String(spec.toast)}" should have appeared${d.toasts.length ? ` (saw: ${d.toasts.join(' / ')})` : ''}.`));
      if (spec.dialog !== undefined && !(d.dialog && new RegExp(String(spec.dialog), 'i').test(d.dialog.text))) return fail(spec, String(spec.message ?? `A dialog like "${String(spec.dialog)}" should be showing.`));
      if (spec.list) {
        const l = spec.list as { from: string; count: number };
        const v = d.data[l.from];
        const n = Array.isArray(v) ? v.length : 0;
        if (n !== l.count) return fail(spec, String(spec.message ?? `The list "${l.from}" should have ${l.count} item${l.count === 1 ? '' : 's'} but has ${n}.`));
      }
      if (spec.lifecycle) {
        const seq = lifecycleOf(d);
        let pos = 0;
        for (const p of spec.lifecycle as string[]) {
          const re = new RegExp(p);
          const idx = seq.findIndex((s, i) => i >= pos && re.test(s));
          if (idx === -1) return fail(spec, String(spec.message ?? `Expected the lifecycle to include ${p} after position ${pos}; it was: ${seq.slice(Math.max(0, pos - 2), pos + 8).join(' → ')}`), seq);
          pos = idx + 1;
        }
      }
      if (spec.request) {
        const r = spec.request as { url: string; ok?: boolean; count?: number };
        const hits = d.requests.filter((x) => x.url === r.url && (r.ok === undefined || x.ok === r.ok));
        if (r.count !== undefined ? hits.length !== r.count : !hits.length) return fail(spec, String(spec.message ?? `Expected ${r.count ?? 'a'} ${r.ok === false ? 'failed ' : r.ok ? 'successful ' : ''}request${r.count === 1 || r.count === undefined ? '' : 's'} to ${r.url}; saw ${d.requests.filter((x) => x.url === r.url).length}.`));
      }
      if (spec.permission) {
        const p = spec.permission as { name: string; result: string };
        if (!d.permissionLog.some((x) => x.permission === p.name && x.result === p.result)) return fail(spec, String(spec.message ?? `Expected a ${p.result} ${p.name} permission request; log: ${d.permissionLog.map((x) => `${x.permission}:${x.result}`).join(', ') || 'none'}.`));
      }
      if (spec.persisted !== undefined && (d.prefs[String(spec.persisted)] === undefined || d.prefs[String(spec.persisted)] === null)) return fail(spec, String(spec.message ?? `"${String(spec.persisted)}" was never persisted (use the "persist" action).`));
      return pass(spec, String(spec.success ?? `After ${((spec.steps as string[]) ?? []).length} step${((spec.steps as string[]) ?? []).length === 1 ? '' : 's'} the app behaves as required.`));
    })

    .register('mobile.answer', async (state, spec) => {
      const text = (state.answers?.[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      const accepted = (Array.isArray(spec.expected) ? spec.expected : [spec.expected]).map((x) => String(x).trim().toLowerCase());
      return accepted.includes(text.toLowerCase()) ? pass(spec, String(spec.success ?? 'Correct.')) : fail(spec, String(spec.message ?? 'Not the expected answer.'));
    });
}
