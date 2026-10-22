/**
 * The emulator: runs an app with an Android-style activity lifecycle, a back stack, in-memory
 * data, persistent preferences that survive a process kill, a simulated network and permissions.
 * Every method is synchronous and deterministic so checks can replay a script of user actions.
 */

import { fill, type Action, type AppSpec, type DeviceConfig, type Screen, type Widget } from './app.js';

export interface Activity {
  screen: string;
  inputs: Record<string, string>;
  switches: Record<string, boolean>;
  tappedIndex?: number;
}

export interface LifecycleEvent {
  screen: string;
  event: 'onCreate' | 'onStart' | 'onResume' | 'onPause' | 'onStop' | 'onDestroy' | 'onSaveInstanceState' | 'onRestoreInstanceState';
  cause: string;
}

export interface Device {
  app: AppSpec;
  config: DeviceConfig;
  stack: Activity[];
  data: Record<string, unknown>;
  prefs: Record<string, unknown>;
  lifecycle: LifecycleEvent[];
  toasts: string[];
  dialog: { title?: string; text: string } | null;
  logs: string[];
  requests: Array<{ url: string; method: string; ok: boolean; offline: boolean }>;
  permissionLog: Array<{ permission: string; result: 'granted' | 'denied' | 'undeclared' }>;
  offline: boolean;
  backgrounded: boolean;
  rotated: boolean;
  killed: boolean;
  errors: string[];
  steps: number;
}

export function launch(app: AppSpec, config: DeviceConfig = {}, prefs: Record<string, unknown> = {}): Device {
  const d: Device = { app, config, stack: [], data: JSON.parse(JSON.stringify(app.data ?? {})), prefs: { ...prefs }, lifecycle: [], toasts: [], dialog: null, logs: [], requests: [], permissionLog: [], offline: config.offline ?? false, backgrounded: false, rotated: false, killed: false, errors: [], steps: 0 };
  startActivity(d, app.start, 'launch');
  return d;
}

export function current(d: Device): Activity | undefined {
  return d.stack[d.stack.length - 1];
}

export function currentScreen(d: Device): Screen | undefined {
  const a = current(d);
  return a ? d.app.screens[a.screen] : undefined;
}

function log(d: Device, screen: string, event: LifecycleEvent['event'], cause: string): void {
  d.lifecycle.push({ screen, event, cause });
}

function startActivity(d: Device, screen: string, cause: string): void {
  if (!d.app.screens[screen]) {
    d.errors.push(`No screen called "${screen}".`);
    return;
  }
  const prev = current(d);
  if (prev) log(d, prev.screen, 'onPause', cause);
  const act: Activity = { screen, inputs: {}, switches: {} };
  d.stack.push(act);
  log(d, screen, 'onCreate', cause);
  runActions(d, d.app.screens[screen].onCreate ?? [], act);
  log(d, screen, 'onStart', cause);
  log(d, screen, 'onResume', cause);
  if (prev) log(d, prev.screen, 'onStop', cause);
}

/** The visible widgets with placeholders filled. */
export function render(d: Device): Array<{ widget: Widget; text?: string; value?: string; items?: string[]; on?: boolean }> {
  const a = current(d);
  const s = currentScreen(d);
  if (!a || !s) return [];
  return s.widgets.map((w) => {
    switch (w.type) {
      case 'text':
        return { widget: w, text: fill(w.text, d.data, a.inputs) };
      case 'input':
        return { widget: w, value: a.inputs[w.id] ?? '' };
      case 'button':
        return { widget: w, text: fill(w.text, d.data, a.inputs) };
      case 'list': {
        const v = d.data[w.from];
        const items = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))) : [];
        return { widget: w, items, text: items.length ? undefined : fill(w.empty ?? 'Nothing here yet', d.data, a.inputs) };
      }
      case 'switch':
        return { widget: w, on: a.switches[w.id] ?? false, text: w.label };
      default:
        return { widget: w };
    }
  });
}

/** All visible text on the screen, for checks. */
export function screenText(d: Device): string {
  const s = currentScreen(d);
  return [s?.title ?? '', ...render(d).flatMap((r) => [r.text ?? '', ...(r.items ?? []), r.value ?? ''])].filter(Boolean).join('\n');
}

export function type(d: Device, inputId: string, text: string): void {
  const a = current(d);
  if (!a) return;
  const s = currentScreen(d);
  if (!s?.widgets.some((w) => w.type === 'input' && w.id === inputId)) {
    d.errors.push(`There is no input "${inputId}" on ${a.screen}.`);
    return;
  }
  a.inputs[inputId] = text;
  d.steps++;
}

export function toggle(d: Device, switchId: string): void {
  const a = current(d);
  if (!a) return;
  a.switches[switchId] = !(a.switches[switchId] ?? false);
  d.steps++;
}

/** Taps the button with this text (placeholders filled), or a list item by index with "item:N". */
export function tap(d: Device, buttonText: string): boolean {
  const a = current(d);
  const s = currentScreen(d);
  if (!a || !s) return false;
  d.steps++;
  const item = /^item:(\d+)$/.exec(buttonText);
  if (item) {
    const list = s.widgets.find((w): w is Extract<Widget, { type: 'list' }> => w.type === 'list');
    if (!list) {
      d.errors.push(`No list on ${a.screen} to tap.`);
      return false;
    }
    a.tappedIndex = Number(item[1]);
    runActions(d, list.onTap ?? [], a);
    return true;
  }
  const btn = s.widgets.find((w): w is Extract<Widget, { type: 'button' }> => w.type === 'button' && fill(w.text, d.data, a.inputs).toLowerCase() === buttonText.toLowerCase());
  if (!btn) {
    d.errors.push(`There is no button "${buttonText}" on ${a.screen}.`);
    return false;
  }
  runActions(d, btn.onTap, a);
  return true;
}

export function back(d: Device): void {
  d.steps++;
  if (d.dialog) {
    d.dialog = null;
    return;
  }
  const a = current(d);
  if (!a) return;
  if (d.stack.length === 1) {
    log(d, a.screen, 'onPause', 'back (exit)');
    log(d, a.screen, 'onStop', 'back (exit)');
    log(d, a.screen, 'onDestroy', 'back (exit)');
    d.stack.pop();
    d.logs.push('The app exited (back on the first screen).');
    return;
  }
  log(d, a.screen, 'onPause', 'back');
  d.stack.pop();
  const prev = current(d)!;
  log(d, prev.screen, 'onStart', 'back');
  log(d, prev.screen, 'onResume', 'back');
  log(d, a.screen, 'onStop', 'back');
  log(d, a.screen, 'onDestroy', 'back');
}

export function rotate(d: Device): void {
  d.steps++;
  const a = current(d);
  if (!a) return;
  const s = d.app.screens[a.screen];
  log(d, a.screen, 'onPause', 'rotation');
  log(d, a.screen, 'onSaveInstanceState', 'rotation');
  log(d, a.screen, 'onStop', 'rotation');
  log(d, a.screen, 'onDestroy', 'rotation');
  const kept = s?.retainState ? { ...a.inputs } : {};
  const keptSwitches = s?.retainState ? { ...a.switches } : {};
  d.stack[d.stack.length - 1] = { screen: a.screen, inputs: kept, switches: keptSwitches };
  d.rotated = !d.rotated;
  log(d, a.screen, 'onCreate', 'rotation');
  runActions(d, s?.onCreate ?? [], current(d)!);
  log(d, a.screen, 'onStart', 'rotation');
  log(d, a.screen, 'onRestoreInstanceState', 'rotation');
  log(d, a.screen, 'onResume', 'rotation');
}

export function background(d: Device): void {
  d.steps++;
  const a = current(d);
  if (!a || d.backgrounded) return;
  log(d, a.screen, 'onPause', 'home button');
  log(d, a.screen, 'onStop', 'home button');
  d.backgrounded = true;
}

export function foreground(d: Device): void {
  d.steps++;
  const a = current(d);
  if (!a || !d.backgrounded) return;
  log(d, a.screen, 'onStart', 'return to app');
  log(d, a.screen, 'onResume', 'return to app');
  d.backgrounded = false;
}

/** The system kills the process (low memory); only persisted preferences survive the relaunch. */
export function killAndRelaunch(d: Device): Device {
  const next = launch(d.app, d.config, d.prefs);
  next.lifecycle.unshift({ screen: current(d)?.screen ?? d.app.start, event: 'onDestroy', cause: 'process killed' });
  next.killed = true;
  next.offline = d.offline;
  next.logs.push('The process was killed and the app relaunched. Only data saved with "persist" came back.');
  return next;
}

export function setOffline(d: Device, offline: boolean): void {
  d.offline = offline;
  d.steps++;
}

function runActions(d: Device, actions: Action[], a: Activity, depth = 0): void {
  if (depth > 10) {
    d.errors.push('Actions nested too deeply.');
    return;
  }
  for (const act of actions) {
    if (!current(d) || current(d) !== a) {
      // The activity changed (navigate/back): the rest runs on the new one only for toasts/logs.
      if (act.action !== 'toast' && act.action !== 'log' && act.action !== 'navigate' && act.action !== 'back') continue;
    }
    switch (act.action) {
      case 'navigate':
        startActivity(d, act.to, `tap on ${a.screen}`);
        a = current(d) ?? a;
        break;
      case 'back':
        back(d);
        a = current(d) ?? a;
        break;
      case 'toast':
        d.toasts.push(fill(act.text, d.data, a.inputs));
        break;
      case 'dialog':
        d.dialog = { title: act.title, text: fill(act.text, d.data, a.inputs) };
        break;
      case 'set':
        d.data[act.key] = act.from !== undefined ? a.inputs[act.from] ?? '' : fill(act.value ?? '', d.data, a.inputs);
        break;
      case 'append': {
        const v = act.from !== undefined ? a.inputs[act.from] ?? '' : fill(act.value ?? '', d.data, a.inputs);
        const list = Array.isArray(d.data[act.list]) ? (d.data[act.list] as unknown[]) : [];
        d.data[act.list] = [...list, v];
        break;
      }
      case 'queue': {
        const v = act.from !== undefined ? a.inputs[act.from] ?? '' : fill(act.value ?? '', d.data, a.inputs);
        const list = Array.isArray(d.data[act.list]) ? (d.data[act.list] as unknown[]) : [];
        d.data[act.list] = [...list, { value: v, synced: false }];
        break;
      }
      case 'remove': {
        const list = Array.isArray(d.data[act.list]) ? [...(d.data[act.list] as unknown[])] : [];
        const idx = act.index === 'tapped' ? a.tappedIndex ?? -1 : act.index === 'last' || act.index === undefined ? list.length - 1 : act.index;
        if (idx >= 0 && idx < list.length) list.splice(idx, 1);
        d.data[act.list] = list;
        break;
      }
      case 'clear':
        a.inputs[act.id] = '';
        break;
      case 'persist':
        for (const k of act.keys) d.prefs[k] = JSON.parse(JSON.stringify(d.data[k] ?? null));
        break;
      case 'load':
        for (const k of act.keys) if (d.prefs[k] !== undefined && d.prefs[k] !== null) d.data[k] = JSON.parse(JSON.stringify(d.prefs[k]));
        break;
      case 'fetch': {
        const ep = d.config.endpoints?.[act.url];
        const ok = !d.offline && !!ep && !ep.alwaysFails && (ep.status ?? 200) < 400;
        d.requests.push({ url: act.url, method: act.method ?? 'GET', ok, offline: d.offline });
        if (ok) {
          if (act.into) d.data[act.into] = ep!.response ?? null;
          runActions(d, act.onSuccess ?? [], a, depth + 1);
        } else {
          if (!act.onError?.length) d.errors.push(d.offline ? `Network request to ${act.url} failed while offline and nothing handled it: the app would crash or hang.` : `Request to ${act.url} failed (${ep ? `status ${ep.status ?? 500}` : 'unknown endpoint'}) and nothing handled it.`);
          runActions(d, act.onError ?? [], a, depth + 1);
        }
        break;
      }
      case 'sync': {
        const list = Array.isArray(d.data[act.list]) ? (d.data[act.list] as Array<{ value: unknown; synced?: boolean }>) : [];
        const ep = d.config.endpoints?.[act.url];
        const ok = !d.offline && !!ep && !ep.alwaysFails;
        d.requests.push({ url: act.url, method: 'POST', ok, offline: d.offline });
        if (ok) {
          d.data[act.list] = list.map((x) => (typeof x === 'object' && x ? { ...x, synced: true } : x));
          runActions(d, act.onSuccess ?? [], a, depth + 1);
        } else runActions(d, act.onError ?? [], a, depth + 1);
        break;
      }
      case 'requestPermission': {
        const declared = (d.app.permissions ?? []).includes(act.permission);
        const answer = declared ? d.config.permissions?.[act.permission] ?? 'grant' : 'deny';
        d.permissionLog.push({ permission: act.permission, result: !declared ? 'undeclared' : answer === 'grant' ? 'granted' : 'denied' });
        if (!declared) d.errors.push(`Permission "${act.permission}" is not declared in the manifest, so the system denies it without asking.`);
        if (declared && answer === 'grant') runActions(d, act.onGranted ?? [], a, depth + 1);
        else {
          if (!act.onDenied?.length) d.errors.push(`Permission "${act.permission}" was denied and the app did not handle it.`);
          runActions(d, act.onDenied ?? [], a, depth + 1);
        }
        break;
      }
      case 'if': {
        let truth: boolean;
        if (act.input !== undefined) {
          // Switches read as "true"/"false" so an if can test them like inputs.
          const v = a.inputs[act.input] ?? (act.input in a.switches ? String(a.switches[act.input]) : '');
          truth = act.notEmpty ? v.trim() !== '' : act.equals !== undefined ? v === act.equals : v !== '';
        } else {
          const v = d.data[act.key ?? ''];
          truth = act.notEmpty ? (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== '' && v !== null) : act.equals !== undefined ? String(v) === act.equals : !!v;
        }
        runActions(d, truth ? act.then : act.else ?? [], a, depth + 1);
        break;
      }
      case 'log':
        d.logs.push(fill(act.text, d.data, a.inputs));
        break;
    }
  }
}

/** A scripted session: steps are strings such as "tap:Save", "type:note=Buy data", "back", "rotate", "home", "resume", "offline", "online", "kill", "toggle:x", "item:0". */
export function runScript(app: AppSpec, config: DeviceConfig, steps: string[]): Device {
  let d = launch(app, config);
  for (const step of steps) {
    const [cmd, rest] = splitStep(step);
    switch (cmd) {
      case 'tap':
        tap(d, rest);
        break;
      case 'type': {
        const eq = rest.indexOf('=');
        type(d, rest.slice(0, eq), rest.slice(eq + 1));
        break;
      }
      case 'toggle':
        toggle(d, rest);
        break;
      case 'item':
        tap(d, `item:${rest}`);
        break;
      case 'back':
        back(d);
        break;
      case 'rotate':
        rotate(d);
        break;
      case 'home':
        background(d);
        break;
      case 'resume':
        foreground(d);
        break;
      case 'offline':
        setOffline(d, true);
        break;
      case 'online':
        setOffline(d, false);
        break;
      case 'kill':
        d = killAndRelaunch(d);
        break;
      default:
        d.errors.push(`Unknown script step "${step}".`);
    }
  }
  return d;
}

function splitStep(step: string): [string, string] {
  const i = step.indexOf(':');
  return i === -1 ? [step.trim(), ''] : [step.slice(0, i).trim(), step.slice(i + 1)];
}

export function lifecycleOf(d: Device, screen?: string): string[] {
  return d.lifecycle.filter((e) => !screen || e.screen === screen).map((e) => `${e.screen}.${e.event}`);
}
