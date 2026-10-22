/**
 * Every E3 lab must be solvable: a reference solution per lab id passes every check,
 * and the starting state does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createNetworkChecks, setDevice, setIface, setLink, validateTopology, type NetState, type Topology } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

type Solve = (t: Topology) => { topology: Topology; answers: Record<string, string> };

const SOLUTIONS: Record<string, Solve> = {
  'computer-networking-i-b1-two-pcs-one-switch': (t) => ({
    topology: setIface(setIface(t, 'pc1', 'eth0', { ip: '192.168.1.10', mask: '255.255.255.0' }), 'pc2', 'eth0', { ip: '192.168.1.20', mask: '/24' }),
    answers: {},
  }),
  'computer-networking-i-b2-across-the-router': (t) => ({
    topology: setDevice(setDevice(t, 'pc1', { gateway: '192.168.1.1' }), 'pc2', { gateway: '192.168.1.1' }),
    answers: {},
  }),
  'computer-networking-i-i1-subnet-a-slash-24': (t) => {
    let x = t;
    const put = (id: string, ip: string, gw: string) => {
      x = setIface(x, id, 'eth0', { ip, mask: '255.255.255.192' });
      x = setDevice(x, id, { gateway: gw });
    };
    put('admin', '192.168.10.2', '192.168.10.1');
    put('science', '192.168.10.70', '192.168.10.65');
    put('arts', '192.168.10.130', '192.168.10.129');
    put('library', '192.168.10.254', '192.168.10.193');
    return { topology: x, answers: { mask: '/26', nets: '192.168.10.0 192.168.10.64 192.168.10.128 192.168.10.192', bcast: '192.168.10.191', hosts: '62' } };
  },
  'computer-networking-i-i2-campus-vlsm': (t) => ({
    topology: setIface(setIface(t, 'r1', 's0', { ip: '10.1.2.193', mask: '/30' }), 'r2', 's0', { ip: '10.1.2.194', mask: '255.255.255.252' }),
    answers: { students: '10.1.0.0/23', staff: '10.1.2.0/25', labs: '10.1.2.128/26', link: '10.1.2.192/30', spare: '60' },
  }),
  'computer-networking-i-a1-troubleshoot-the-office': (t) => {
    let x = setLink(t, 'l1', { broken: false });
    x = setIface(x, 'pc2', 'eth0', { ip: '192.168.1.11' });
    x = setDevice(x, 'pc3', { gateway: '192.168.1.1' });
    return { topology: x, answers: {} };
  },
  'computer-networking-ii-b1-static-routes': (t) => ({
    topology: setDevice(setDevice(t, 'r1', { routes: [{ network: '192.168.2.0/24', via: '10.0.0.2' }] }), 'r2', { routes: [{ network: '0.0.0.0/0', via: '10.0.0.1' }] }),
    answers: {},
  }),
  'computer-networking-ii-i1-hub-and-two-branches': (t) => {
    let x = setDevice(t, 'ksi', { routes: [{ network: '0.0.0.0/0', via: '10.0.12.2' }] });
    x = setDevice(x, 'tml', { routes: [{ network: '0.0.0.0/0', via: '10.0.13.2' }] });
    x = setDevice(x, 'hub', { routes: [{ network: '172.16.1.0/24', via: '10.0.12.1' }, { network: '172.16.3.0/24', via: '10.0.13.1' }] });
    return { topology: x, answers: { lpm: '172.16.3.0/24' } };
  },
};

function allLabs(): LabSpec<NetState>[] {
  const out: LabSpec<NetState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<NetState>;
      if (raw.engine === 'E3') out.push(raw);
    }
  }
  return out;
}

describe('E3 lab content', () => {
  const checks = createNetworkChecks();
  const labs = allLabs();
  it('finds the network labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(7);
  });
  for (const lab of labs) {
    describe(lab.id, () => {
      it('has a valid topology, a solution, and uses only net.* checks', () => {
        expect(validateTopology(lab.initialState?.topology)).toBe(true);
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('net.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const r = await checks.run(lab, { topology: lab.initialState!.topology, answers: {} });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference solution', async () => {
        const state = SOLUTIONS[lab.id](lab.initialState!.topology);
        const r = await checks.run(lab, state);
        expect(r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
        expect(r.passed).toBe(true);
      });
    });
  }
});
