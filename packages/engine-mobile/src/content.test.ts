/**
 * Every E11 lab must be solvable: a reference app per lab id passes every check,
 * and the starter app does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createMobileChecks, type AppSpec, type MobileConfig, type MobileState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

const SOLUTIONS: Record<string, { app: AppSpec; answers?: Record<string, string> }> = {
  'mobile-application-development-b1-two-screens-and-the-lifecycle': {
    app: {
      start: 'Home',
      screens: {
        Home: { title: 'Home', widgets: [{ type: 'text', text: 'Welcome' }, { type: 'button', text: 'Open details', onTap: [{ action: 'navigate', to: 'Details' }] }] },
        Details: { title: 'Details', widgets: [{ type: 'text', text: 'Some details' }, { type: 'button', text: 'Back home', onTap: [{ action: 'back' }] }] },
      },
    },
    answers: { q1: 'onPause of the current activity', q2: 'Destroys and recreates the activity' },
  },
  'mobile-application-development-i1-notes-that-survive': {
    app: {
      start: 'Home',
      data: { notes: [] },
      screens: {
        Home: {
          title: 'Notes',
          retainState: true,
          onCreate: [{ action: 'load', keys: ['notes'] }],
          widgets: [
            { type: 'input', id: 'note', hint: 'Write a note' },
            { type: 'button', text: 'Save', onTap: [{ action: 'if', input: 'note', notEmpty: true, then: [{ action: 'append', list: 'notes', from: 'note' }, { action: 'persist', keys: ['notes'] }, { action: 'clear', id: 'note' }, { action: 'toast', text: 'Saved' }], else: [{ action: 'toast', text: 'Write something first' }] }] },
            { type: 'list', from: 'notes', empty: 'No notes yet' },
          ],
        },
      },
    },
  },
  'mobile-application-development-i2-offline-first-sync': {
    app: {
      start: 'Home',
      data: { visits: [] },
      screens: {
        Home: {
          title: 'Farm visits',
          onCreate: [{ action: 'load', keys: ['visits'] }],
          widgets: [
            { type: 'input', id: 'farm', hint: 'Farm name' },
            { type: 'button', text: 'Record visit', onTap: [{ action: 'queue', list: 'visits', from: 'farm' }, { action: 'persist', keys: ['visits'] }, { action: 'clear', id: 'farm' }, { action: 'sync', list: 'visits', url: '/api/visits', onSuccess: [{ action: 'persist', keys: ['visits'] }, { action: 'toast', text: 'Synced' }], onError: [{ action: 'toast', text: 'Saved offline, will sync later' }] }] },
            { type: 'button', text: 'Sync now', onTap: [{ action: 'sync', list: 'visits', url: '/api/visits', onSuccess: [{ action: 'persist', keys: ['visits'] }, { action: 'toast', text: 'Synced' }], onError: [{ action: 'toast', text: 'Still offline' }] }] },
            { type: 'list', from: 'visits', empty: 'No visits recorded' },
          ],
        },
      },
    },
  },
  'mobile-application-development-i3-permissions-done-right': {
    app: {
      start: 'Home',
      permissions: ['camera', 'location'],
      screens: {
        Home: {
          title: 'Delivery',
          widgets: [
            { type: 'text', text: 'Photo: {{photo}}' },
            { type: 'text', text: 'Location: {{location}}' },
            { type: 'button', text: 'Attach photo', onTap: [{ action: 'requestPermission', permission: 'camera', onGranted: [{ action: 'set', key: 'photo', value: 'photo attached' }, { action: 'toast', text: 'Photo attached' }], onDenied: [{ action: 'toast', text: 'You can still deliver without a photo' }] }] },
            { type: 'button', text: 'Get location', onTap: [{ action: 'requestPermission', permission: 'location', onGranted: [{ action: 'set', key: 'location', value: '5.6037, -0.1870' }], onDenied: [{ action: 'toast', text: 'Enter the address manually' }, { action: 'navigate', to: 'Manual' }] }] },
          ],
        },
        Manual: { title: 'Address', widgets: [{ type: 'input', id: 'address', hint: 'Delivery address' }, { type: 'button', text: 'Use address', onTap: [{ action: 'set', key: 'location', from: 'address' }, { action: 'back' }] }] },
      },
    },
  },
  'digital-health-and-telemedicine-i1-chw-visit-form': {
    app: {
      start: 'Visit',
      data: { visits: [] },
      screens: {
        Visit: {
          title: 'Household visit',
          onCreate: [{ action: 'load', keys: ['visits'] }],
          widgets: [
            { type: 'input', id: 'child', hint: "Child's name" },
            { type: 'switch', id: 'danger', label: 'Danger signs present' },
            { type: 'text', text: '{{visits}} visits saved' },
            {
              type: 'button',
              text: 'Save visit',
              onTap: [
                {
                  action: 'if',
                  input: 'child',
                  notEmpty: true,
                  then: [
                    { action: 'queue', list: 'visits', from: 'child' },
                    { action: 'persist', keys: ['visits'] },
                    { action: 'if', input: 'danger', equals: 'true', then: [{ action: 'set', key: 'referred', value: 'yes' }, { action: 'dialog', title: 'Referral', text: 'Refer to the nearest health facility now' }] },
                    { action: 'sync', list: 'visits', url: '/api/visits', onSuccess: [{ action: 'toast', text: 'Sent to the district server' }], onError: [{ action: 'toast', text: 'Saved on phone; will send when online' }] },
                  ],
                  else: [{ action: 'toast', text: "Enter the child's name" }],
                },
              ],
            },
            { type: 'button', text: 'View visits', onTap: [{ action: 'navigate', to: 'Summary' }] },
          ],
        },
        Summary: { title: 'Visits', widgets: [{ type: 'list', from: 'visits', empty: 'No visits yet' }, { type: 'button', text: 'Back', onTap: [{ action: 'back' }] }] },
      },
    },
  },
};

function allLabs(): LabSpec<MobileState>[] {
  const out: LabSpec<MobileState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<MobileState>;
      if (raw.engine === 'E11') out.push(raw);
    }
  }
  return out;
}

describe('E11 lab content', () => {
  const checks = createMobileChecks();
  const labs = allLabs();
  it('finds the mobile labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(5);
  });
  for (const lab of labs) {
    const config = lab.config as unknown as MobileConfig;
    describe(lab.id, () => {
      it('has a solution and only mobile.* checks', () => {
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('mobile.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const r = await checks.run(lab, { source: config.starter ?? '' });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference app', async () => {
        const sol = SOLUTIONS[lab.id];
        const r = await checks.run(lab, { source: JSON.stringify(sol.app, null, 2), answers: sol.answers });
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
