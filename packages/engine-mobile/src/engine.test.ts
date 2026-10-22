import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { back, createMobileChecks, current, launch, lifecycleOf, parseApp, render, rotate, runScript, screenText, tap, type, type AppSpec, type MobileState } from './index.js';

const notes: AppSpec = {
  start: 'Home',
  permissions: ['camera'],
  screens: {
    Home: {
      title: 'Notes',
      retainState: true,
      onCreate: [{ action: 'load', keys: ['notes'] }],
      widgets: [
        { type: 'text', text: 'You have {{notes}} notes' },
        { type: 'input', id: 'note', hint: 'Write a note' },
        { type: 'button', text: 'Save', onTap: [{ action: 'if', input: 'note', notEmpty: true, then: [{ action: 'append', list: 'notes', from: 'note' }, { action: 'persist', keys: ['notes'] }, { action: 'clear', id: 'note' }, { action: 'toast', text: 'Saved' }], else: [{ action: 'toast', text: 'Write something first' }] }] },
        { type: 'button', text: 'Open list', onTap: [{ action: 'navigate', to: 'List' }] },
        { type: 'button', text: 'Take photo', onTap: [{ action: 'requestPermission', permission: 'camera', onGranted: [{ action: 'toast', text: 'Camera open' }], onDenied: [{ action: 'toast', text: 'Camera needed to attach a photo' }] }] },
        { type: 'button', text: 'Sync', onTap: [{ action: 'fetch', url: '/api/notes', method: 'POST', onSuccess: [{ action: 'toast', text: 'Synced' }], onError: [{ action: 'toast', text: 'Offline: saved locally' }] }] },
      ],
    },
    List: { title: 'All notes', widgets: [{ type: 'list', from: 'notes', empty: 'No notes yet', onTap: [{ action: 'remove', list: 'notes', index: 'tapped' }] }, { type: 'button', text: 'Back', onTap: [{ action: 'back' }] }] },
  },
};

describe('app spec', () => {
  it('parses and reports structural problems in plain words', () => {
    expect(parseApp(JSON.stringify(notes)).problems).toEqual([]);
    expect(parseApp(JSON.stringify({ start: 'Home', screens: { Home: { widgets: [{ type: 'button', text: 'Go', onTap: [{ action: 'navigate', to: 'Nowhere' }] }] } } })).problems[0].message).toMatch(/navigates to "Nowhere"/);
    expect(parseApp('{ not json').problems[0].message).toMatch(/does not parse/);
    expect(parseApp(JSON.stringify({ start: 'Home', permissions: [], screens: { Home: { widgets: [{ type: 'button', text: 'Go', onTap: [{ action: 'requestPermission', permission: 'location' }] }] } } })).problems[0].message).toMatch(/not declared/);
  });
});

describe('runtime', () => {
  it('runs the lifecycle for launch, navigation, back and rotation', () => {
    const d = launch(notes);
    expect(lifecycleOf(d)).toEqual(['Home.onCreate', 'Home.onStart', 'Home.onResume']);
    tap(d, 'Open list');
    expect(current(d)?.screen).toBe('List');
    expect(lifecycleOf(d).slice(3)).toEqual(['Home.onPause', 'List.onCreate', 'List.onStart', 'List.onResume', 'Home.onStop']);
    back(d);
    expect(current(d)?.screen).toBe('Home');
    expect(lifecycleOf(d).slice(8)).toEqual(['List.onPause', 'Home.onStart', 'Home.onResume', 'List.onStop', 'List.onDestroy']);
    type(d, 'note', 'buy data');
    rotate(d);
    expect(current(d)?.inputs.note).toBe('buy data'); // retainState keeps it
    expect(lifecycleOf(d).slice(13)).toEqual(['Home.onPause', 'Home.onSaveInstanceState', 'Home.onStop', 'Home.onDestroy', 'Home.onCreate', 'Home.onStart', 'Home.onRestoreInstanceState', 'Home.onResume']);
    const plain: AppSpec = { ...notes, screens: { ...notes.screens, Home: { ...notes.screens.Home, retainState: false } } };
    const d2 = launch(plain);
    type(d2, 'note', 'lost');
    rotate(d2);
    expect(current(d2)?.inputs.note).toBeUndefined();
  });
  it('saves, lists, persists across a process kill, and handles offline and permissions', () => {
    let d = runScript(notes, { endpoints: { '/api/notes': { response: { ok: true } } } }, ['tap:Save', 'type:note=Buy data bundle', 'tap:Save', 'type:note=Call Ama', 'tap:Save', 'tap:Open list']);
    expect(d.toasts).toEqual(['Write something first', 'Saved', 'Saved']);
    expect(render(d)[0].items).toEqual(['Buy data bundle', 'Call Ama']);
    expect(screenText(d)).toContain('All notes');
    tap(d, 'item:0');
    expect(render(d)[0].items).toEqual(['Call Ama']);
    d = runScript(notes, {}, ['type:note=Keep me', 'tap:Save', 'kill']);
    expect(d.killed).toBe(true);
    expect(d.data.notes).toEqual(['Keep me']);
    expect(screenText(d)).toContain('You have 1 notes');
    const off = runScript(notes, { endpoints: { '/api/notes': {} }, offline: true }, ['tap:Sync']);
    expect(off.toasts).toEqual(['Offline: saved locally']);
    expect(off.requests[0]).toMatchObject({ ok: false, offline: true });
    expect(off.errors).toEqual([]);
    const denied = runScript(notes, { permissions: { camera: 'deny' } }, ['tap:Take photo']);
    expect(denied.toasts).toEqual(['Camera needed to attach a photo']);
    expect(denied.permissionLog).toEqual([{ permission: 'camera', result: 'denied' }]);
    const unhandled: AppSpec = { start: 'A', screens: { A: { widgets: [{ type: 'button', text: 'Load', onTap: [{ action: 'fetch', url: '/x' }] }] } } };
    expect(runScript(unhandled, { endpoints: { '/x': {} }, offline: true }, ['tap:Load']).errors[0]).toMatch(/failed while offline/);
  });
});

describe('mobile.* checks', () => {
  const checks = createMobileChecks();
  const lab = (specs: LabSpec['checks']): LabSpec<MobileState> => ({ id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E11', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1, config: { device: { endpoints: { '/api/notes': {} }, permissions: { camera: 'deny' } } } });
  it('judges validity, screens, flows, lifecycle, persistence, offline and permissions', async () => {
    const spec = lab([
      { type: 'mobile.valid', label: 'valid' },
      { type: 'mobile.screen', label: 'home has input', name: 'Home', widget: { type: 'input', id: 'note' } },
      { type: 'mobile.flow', label: 'save adds', steps: ['type:note=Hello', 'tap:Save'], toast: 'saved', list: { from: 'notes', count: 1 }, noErrors: true },
      { type: 'mobile.flow', label: 'navigate', steps: ['tap:Open list'], screen: 'List', lifecycle: ['Home.onPause', 'List.onCreate', 'List.onResume', 'Home.onStop'] },
      { type: 'mobile.flow', label: 'survives kill', steps: ['type:note=Hello', 'tap:Save', 'kill'], text: 'You have 1 notes', persisted: 'notes' },
      { type: 'mobile.flow', label: 'offline handled', steps: ['tap:Sync'], offline: true, toast: 'offline', noErrors: true, request: { url: '/api/notes', ok: false } },
      { type: 'mobile.flow', label: 'denied handled', steps: ['tap:Take photo'], permission: { name: 'camera', result: 'denied' }, toast: 'camera', noErrors: true },
      { type: 'mobile.flow', label: 'rotation keeps text', steps: ['type:note=Draft', 'rotate'], text: 'Draft' },
    ]);
    const r = await checks.run(spec, { source: JSON.stringify(notes) });
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
    const bare = { start: 'Home', screens: { Home: { widgets: [{ type: 'input', id: 'note' }, { type: 'button', text: 'Save', onTap: [{ action: 'append', list: 'notes', from: 'note' }] }] } } };
    const r2 = await checks.run(spec, { source: JSON.stringify(bare) });
    expect(r2.checks.map((c) => c.passed)).toEqual([true, true, false, false, false, false, false, false]);
    expect(r2.checks[4].message).toMatch(/You have 1 notes/);
  });
});
