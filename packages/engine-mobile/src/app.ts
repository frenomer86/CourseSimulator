/**
 * The declarative app a learner writes: screens made of widgets, and actions that run when
 * a button is tapped. Text may contain {{key}} placeholders filled from app data.
 */

export type Widget =
  | { type: 'text'; text: string; style?: 'title' | 'body' | 'caption' | 'error' }
  | { type: 'input'; id: string; hint?: string; inputType?: 'text' | 'number' | 'password' | 'phone' }
  | { type: 'button'; text: string; onTap: Action[]; style?: 'primary' | 'secondary' | 'danger' }
  | { type: 'list'; from: string; empty?: string; onTap?: Action[] }
  | { type: 'image'; src?: string; alt?: string }
  | { type: 'switch'; id: string; label: string }
  | { type: 'spacer' };

export type Action =
  | { action: 'navigate'; to: string }
  | { action: 'back' }
  | { action: 'toast'; text: string }
  | { action: 'dialog'; title?: string; text: string }
  | { action: 'set'; key: string; value?: string; from?: string }
  | { action: 'append'; list: string; from?: string; value?: string }
  | { action: 'remove'; list: string; index?: number | 'last' | 'tapped' }
  | { action: 'clear'; id: string }
  | { action: 'persist'; keys: string[] }
  | { action: 'load'; keys: string[] }
  | { action: 'fetch'; url: string; method?: 'GET' | 'POST'; from?: string; into?: string; onSuccess?: Action[]; onError?: Action[] }
  | { action: 'requestPermission'; permission: string; onGranted?: Action[]; onDenied?: Action[] }
  | { action: 'if'; key?: string; input?: string; equals?: string; notEmpty?: boolean; then: Action[]; else?: Action[] }
  | { action: 'queue'; list: string; from?: string; value?: string }
  | { action: 'sync'; list: string; url: string; onSuccess?: Action[]; onError?: Action[] }
  | { action: 'log'; text: string };

export interface Screen {
  title?: string;
  widgets: Widget[];
  /** Keep inputs across rotation (a ViewModel). Default false: rotation recreates the screen and loses them. */
  retainState?: boolean;
  /** Actions that run when the screen is created. */
  onCreate?: Action[];
}

export interface AppSpec {
  name?: string;
  start: string;
  screens: Record<string, Screen>;
  /** Permissions declared in the manifest; requesting an undeclared one fails. */
  permissions?: string[];
  /** Initial data. */
  data?: Record<string, unknown>;
}

export interface Endpoint {
  /** Response body (JSON-ish object or string) for a GET or POST. */
  response?: unknown;
  /** Simulated status; 200 by default. */
  status?: number;
  /** Fails while the device is offline (always true), or always. */
  alwaysFails?: boolean;
}

export interface DeviceConfig {
  endpoints?: Record<string, Endpoint>;
  /** What the user answers to permission prompts. */
  permissions?: Record<string, 'grant' | 'deny'>;
  offline?: boolean;
}

export interface AppProblem {
  path: string;
  message: string;
}

const ACTIONS = new Set(['navigate', 'back', 'toast', 'dialog', 'set', 'append', 'remove', 'clear', 'persist', 'load', 'fetch', 'requestPermission', 'if', 'queue', 'sync', 'log']);
const WIDGETS = new Set(['text', 'input', 'button', 'list', 'image', 'switch', 'spacer']);

/** Parses the learner's JSON and lists structural problems in plain words. */
export function parseApp(src: string): { app: AppSpec | null; problems: AppProblem[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    const m = /position (\d+)/.exec((e as Error).message);
    let where = '';
    if (m) {
      const pos = Number(m[1]);
      const line = src.slice(0, pos).split('\n').length;
      where = ` near line ${line}`;
    }
    return { app: null, problems: [{ path: '', message: `The JSON does not parse${where}: ${(e as Error).message.replace(/^JSON\.parse: /, '')}. Check commas, quotes and brackets.` }] };
  }
  const problems: AppProblem[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { app: null, problems: [{ path: '', message: 'The app must be a JSON object with "start" and "screens".' }] };
  const app = raw as AppSpec;
  if (!app.screens || typeof app.screens !== 'object') problems.push({ path: 'screens', message: '"screens" must be an object mapping screen names to screens.' });
  if (!app.start) problems.push({ path: 'start', message: '"start" must name the first screen.' });
  else if (app.screens && !app.screens[app.start]) problems.push({ path: 'start', message: `"start" names a screen "${app.start}" that does not exist.` });
  const checkActions = (actions: unknown, path: string) => {
    if (!Array.isArray(actions)) {
      problems.push({ path, message: `${path} must be a list of actions.` });
      return;
    }
    actions.forEach((a, i) => {
      const p = `${path}[${i}]`;
      if (!a || typeof a !== 'object' || !('action' in a)) {
        problems.push({ path: p, message: `${p} must be an object with an "action".` });
        return;
      }
      const act = a as Action;
      if (!ACTIONS.has(act.action)) problems.push({ path: p, message: `${p}: unknown action "${String(act.action)}". Known: ${[...ACTIONS].join(', ')}.` });
      if (act.action === 'navigate' && (!app.screens || !app.screens[act.to])) problems.push({ path: p, message: `${p} navigates to "${act.to}", which is not a screen.` });
      if (act.action === 'requestPermission' && app.permissions && !app.permissions.includes(act.permission)) problems.push({ path: p, message: `${p} requests "${act.permission}", which is not declared in "permissions" (the manifest).` });
      for (const k of ['onSuccess', 'onError', 'onGranted', 'onDenied', 'then', 'else'] as const) {
        const sub = (act as unknown as Record<string, unknown>)[k];
        if (sub !== undefined) checkActions(sub, `${p}.${k}`);
      }
    });
  };
  for (const [name, s] of Object.entries(app.screens ?? {})) {
    const sp = `screens.${name}`;
    if (!s || typeof s !== 'object' || !Array.isArray(s.widgets)) {
      problems.push({ path: sp, message: `${sp} must have a "widgets" list.` });
      continue;
    }
    s.widgets.forEach((w, i) => {
      const wp = `${sp}.widgets[${i}]`;
      if (!w || typeof w !== 'object' || !('type' in w)) {
        problems.push({ path: wp, message: `${wp} must be an object with a "type".` });
        return;
      }
      if (!WIDGETS.has(w.type)) problems.push({ path: wp, message: `${wp}: unknown widget type "${String(w.type)}". Known: ${[...WIDGETS].join(', ')}.` });
      if (w.type === 'button') {
        if (!w.text) problems.push({ path: wp, message: `${wp}: a button needs "text".` });
        checkActions(w.onTap, `${wp}.onTap`);
      }
      if (w.type === 'input' && !w.id) problems.push({ path: wp, message: `${wp}: an input needs an "id" so actions can read it.` });
      if (w.type === 'list' && !w.from) problems.push({ path: wp, message: `${wp}: a list needs "from", the data key it shows.` });
      if (w.type === 'list' && w.onTap) checkActions(w.onTap, `${wp}.onTap`);
    });
    if (s.onCreate) checkActions(s.onCreate, `${sp}.onCreate`);
  }
  return { app: problems.some((p) => p.path === '' || p.path === 'screens' || p.path === 'start') ? null : app, problems };
}

export function fill(text: string, data: Record<string, unknown>, inputs: Record<string, string> = {}): string {
  return String(text ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => {
    const v = inputs[k] ?? data[k];
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return String(v.length);
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
