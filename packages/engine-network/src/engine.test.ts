import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import {
  createNetworkChecks,
  describeSubnet,
  formatIp,
  normaliseAnswer,
  parseIp,
  parsePrefix,
  ping,
  prefixForHosts,
  setDevice,
  setIface,
  setLink,
  splitEqually,
  usableHosts,
  vlsm,
  type NetState,
  type Topology,
} from './index.js';

describe('IPv4 maths', () => {
  it('parses addresses and masks', () => {
    expect(formatIp(parseIp('192.168.1.10')!)).toBe('192.168.1.10');
    expect(parseIp('256.1.1.1')).toBeNull();
    expect(parsePrefix('255.255.255.192')).toBe(26);
    expect(parsePrefix('/24')).toBe(24);
    expect(parsePrefix('255.255.0.255')).toBeNull();
    expect(usableHosts(26)).toBe(62);
    expect(prefixForHosts(300)).toBe(23);
    expect(prefixForHosts(2)).toBe(30);
  });
  it('describes and splits subnets', () => {
    const s = describeSubnet(parseIp('192.168.10.77')!, 26);
    expect(s).toMatchObject({ network: '192.168.10.64', broadcast: '192.168.10.127', firstHost: '192.168.10.65', lastHost: '192.168.10.126', mask: '255.255.255.192', usable: 62 });
    expect(splitEqually(parseIp('192.168.10.0')!, 24, 26).map((x) => x.network)).toEqual(['192.168.10.0', '192.168.10.64', '192.168.10.128', '192.168.10.192']);
    const plan = vlsm(parseIp('10.1.0.0')!, 22, [{ name: 'students', hosts: 300 }, { name: 'staff', hosts: 100 }, { name: 'labs', hosts: 50 }, { name: 'link', hosts: 2 }]);
    expect(plan.map((p) => `${p.name} ${p.cidr}`)).toEqual(['students 10.1.0.0/23', 'staff 10.1.2.0/25', 'labs 10.1.2.128/26', 'link 10.1.2.192/30']);
  });
  it('normalises answers', () => {
    expect(normaliseAnswer(' 192.168.001.0/24 ')).toBe('192.168.1.0/24');
    expect(normaliseAnswer('62')).toBe('62');
  });
});

const lan: Topology = {
  devices: [
    { id: 'pc1', kind: 'pc', name: 'PC1', x: 0, y: 0, interfaces: [{ id: 'eth0', ip: '192.168.1.10', mask: '255.255.255.0' }], gateway: '192.168.1.1' },
    { id: 'pc2', kind: 'pc', name: 'PC2', x: 0, y: 0, interfaces: [{ id: 'eth0', ip: '192.168.1.20', mask: '255.255.255.0' }], gateway: '192.168.1.1' },
    { id: 'sw1', kind: 'switch', name: 'Switch', x: 0, y: 0, interfaces: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] },
    { id: 'r1', kind: 'router', name: 'R1', x: 0, y: 0, interfaces: [{ id: 'g0', ip: '192.168.1.1', mask: '/24' }, { id: 'g1', ip: '10.0.0.1', mask: '/30' }] },
    { id: 'r2', kind: 'router', name: 'R2', x: 0, y: 0, interfaces: [{ id: 'g0', ip: '192.168.2.1', mask: '/24' }, { id: 'g1', ip: '10.0.0.2', mask: '/30' }] },
    { id: 'srv', kind: 'server', name: 'Server', x: 0, y: 0, interfaces: [{ id: 'eth0', ip: '192.168.2.50', mask: '/24' }], gateway: '192.168.2.1' },
  ],
  links: [
    { id: 'l1', a: { device: 'pc1', iface: 'eth0' }, b: { device: 'sw1', iface: 'p1' } },
    { id: 'l2', a: { device: 'pc2', iface: 'eth0' }, b: { device: 'sw1', iface: 'p2' } },
    { id: 'l3', a: { device: 'sw1', iface: 'p3' }, b: { device: 'r1', iface: 'g0' } },
    { id: 'l4', a: { device: 'r1', iface: 'g1' }, b: { device: 'r2', iface: 'g1' } },
    { id: 'l5', a: { device: 'r2', iface: 'g0' }, b: { device: 'srv', iface: 'eth0' } },
  ],
};

describe('ping', () => {
  it('works within a switch and fails across routers without routes', () => {
    expect(ping(lan, 'pc1', 'pc2')).toMatchObject({ ok: true, pathDevices: ['pc1', 'pc2'] });
    const r = ping(lan, 'pc1', '192.168.2.50');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/R1 has no route to 192.168.2.50/);
  });
  it('succeeds with static routes both ways, and explains a missing return route', () => {
    const oneWay = setDevice(lan, 'r1', { routes: [{ network: '192.168.2.0/24', via: '10.0.0.2' }] });
    const r = ping(oneWay, 'pc1', 'srv');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/request reached Server, but the reply could not get back: R2 has no route to 192.168.1.10/);
    const both = setDevice(oneWay, 'r2', { routes: [{ network: '0.0.0.0/0', via: '10.0.0.1' }] });
    const ok = ping(both, 'pc1', 'srv');
    expect(ok.ok).toBe(true);
    expect(ok.pathDevices).toEqual(['pc1', 'r1', 'r2', 'srv']);
  });
  it('explains wrong masks, missing gateways, broken cables and duplicate addresses', () => {
    expect(ping(setIface(lan, 'pc2', 'eth0', { mask: '255.255.255.128' }), 'pc1', 'pc2').ok).toBe(true); // .10 and .20 still share the /25
    const wrongSubnet = setIface(lan, 'pc2', 'eth0', { ip: '192.168.1.200', mask: '255.255.255.128' });
    const r1 = ping(wrongSubnet, 'pc1', '192.168.1.200');
    expect(r1.ok).toBe(false);
    expect(r1.reason).toMatch(/reply could not get back: PC2's default gateway 192.168.1.1 is not on PC2's own subnet/);
    const noGw = setDevice(lan, 'pc1', { gateway: undefined });
    expect(ping(noGw, 'pc1', '192.168.2.50').reason).toMatch(/no default gateway/);
    const cut = setLink(lan, 'l1', { broken: true });
    expect(ping(cut, 'pc1', 'pc2').reason).toMatch(/cannot find 192.168.1.20/);
    const dup = setIface(lan, 'pc2', 'eth0', { ip: '192.168.1.10' });
    expect(ping(dup, 'r1', '192.168.1.10').reason).toMatch(/Two devices answer/);
    const bad = setIface(lan, 'pc1', 'eth0', { ip: '192.168.1.0' });
    expect(ping(bad, 'pc1', 'pc2').reason).toMatch(/network or broadcast address/);
  });
});

describe('net.* checks', () => {
  const checks = createNetworkChecks();
  const lab = (specs: LabSpec['checks']): LabSpec<NetState> => ({
    id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E3', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1,
  });
  it('judges interfaces, gateways, pings, duplicates and answers', async () => {
    const spec = lab([
      { type: 'net.interface', label: 'pc1 addr', device: 'pc1', iface: 'eth0', subnet: '192.168.1.0/24', not: ['192.168.1.1'] },
      { type: 'net.gateway', label: 'pc1 gw', device: 'pc1', subnet: '192.168.1.0/24' },
      { type: 'net.ping', label: 'pc1 to pc2', from: 'pc1', to: 'pc2' },
      { type: 'net.noDuplicates', label: 'unique' },
      { type: 'net.answer', label: 'mask', id: 'q1', expected: '255.255.255.192' },
      { type: 'net.answers', label: 'nets', id: 'q2', expected: ['192.168.10.0', '192.168.10.64', '192.168.10.128', '192.168.10.192'] },
    ]);
    const good = await checks.run(spec, { topology: lan, answers: { q1: '/26', q2: '192.168.10.192, 192.168.10.0, 192.168.10.64, 192.168.10.128' } });
    expect(good.checks.filter((c) => !c.passed).map((c) => c.message)).toEqual([]);
    const bad = await checks.run(spec, { topology: setIface(lan, 'pc1', 'eth0', { ip: '192.168.1.1' }), answers: { q1: '255.255.255.0', q2: '192.168.10.0' } });
    expect(bad.checks[0].message).toMatch(/reserved in this lab/);
    expect(bad.checks[4].passed).toBe(false);
    expect(bad.checks[5].message).toMatch(/missing 192.168.10.64/);
  });
});
