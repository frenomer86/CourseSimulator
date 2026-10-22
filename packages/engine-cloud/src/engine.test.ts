import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { addResource, apply, createCloudChecks, desiredResources, estimateCost, findings, formatPlan, parseHcl, plan, simulate, type CloudState, type Scenario } from './index.js';

function empty(): CloudState {
  return { resources: [] };
}

describe('cloud model and cost', () => {
  it('creates resources with defaults and prices them', () => {
    let s = empty();
    const vm = addResource(s, { type: 'vm', name: 'web-1', size: 'medium', region: 'af-west-1' });
    s = vm.state;
    expect(vm.resource.id).toBe('i-0001');
    expect(vm.resource.status).toBe('running');
    s = addResource(s, { type: 'bucket', name: 'results', storageGb: 100 }).state;
    s = addResource(s, { type: 'db', name: 'main', size: 'small', multiAz: true }).state;
    const c = estimateCost(s, 10);
    expect(c.lines.map((l) => l.name)).toEqual(['web-1', 'results', 'main', 'Data transfer out']);
    expect(c.lines[0].usd).toBeCloseTo(0.0416 * 730 * 1.15 + 20 * 0.08, 2);
    expect(c.lines[1].usd).toBeCloseTo(2.3, 2);
    expect(c.totalUsd).toBeGreaterThan(80);
  });
  it('raises posture findings and clears them when fixed', () => {
    let s = empty();
    s = addResource(s, { type: 'sg', name: 'open', rules: [{ port: 22, protocol: 'tcp', source: '0.0.0.0/0' }, { port: 80, protocol: 'tcp', source: '0.0.0.0/0' }] }).state;
    s = addResource(s, { type: 'vm', name: 'web', sg: 'sg-0001', publicIp: true }).state;
    s = addResource(s, { type: 'bucket', name: 'leak', public: true, encrypted: false }).state;
    s = addResource(s, { type: 'policy', name: 'admin', statements: [{ effect: 'Allow', actions: ['*'], resources: ['*'] }] }).state;
    s = addResource(s, { type: 'user', name: 'kofi', policies: ['pol-0004'], mfa: false, accessKeys: 2 }).state;
    const f = findings(s);
    expect(f.filter((x) => x.severity === 'high').map((x) => x.message)).toEqual([
      'Security group open allows port 22 from the whole internet.',
      'web has a public IP and SSH open to the internet.',
      'Bucket leak is publicly readable.',
      'User kofi has an administrator (wildcard) policy.',
    ]);
    expect(f.some((x) => x.message.includes('no MFA'))).toBe(true);
  });
});

const burst: Scenario = { durationMin: 40, traffic: [[0, 30], [10, 90], [14, 150], [18, 200], [30, 30]], sloAvailability: 0.999, sloP95Ms: 600 };

describe('workload simulation', () => {
  it('a single small VM drops requests under a burst', () => {
    const s = addResource(empty(), { type: 'vm', name: 'web', size: 'small', region: 'af-west-1' }).state;
    const r = simulate(s, burst);
    expect(r.availability).toBeLessThan(0.9);
    expect(r.sloMet).toBe(false);
    expect(r.notes.join(' ')).toMatch(/single instance/);
  });
  it('a load balancer with an autoscaling group scales out and meets the SLO', () => {
    let s = addResource(empty(), { type: 'lb', name: 'web-lb', region: 'af-west-1' }).state;
    s = addResource(s, { type: 'asg', name: 'web-asg', region: 'af-west-1', size: 'small', min: 2, max: 6, desired: 2, targetCpu: 60, zones: ['a', 'b'], lb: 'lb-0001' }).state;
    const r = simulate(s, burst);
    expect(r.scaleOuts).toBeGreaterThanOrEqual(2);
    expect(r.maxInstances).toBeGreaterThanOrEqual(4);
    expect(r.availability).toBeGreaterThan(0.97);
    expect(r.steps[39].instances).toBeLessThan(r.maxInstances); // scaled back in
  });
  it('survives a zone outage only with targets in two zones', () => {
    const outage: Scenario = { durationMin: 30, traffic: [[0, 60]], events: [{ at: 5, kind: 'zone-outage', zone: 'af-west-1a', durationMin: 15 }], sloAvailability: 0.99 };
    let one = addResource(empty(), { type: 'lb', name: 'lb', region: 'af-west-1' }).state;
    one = addResource(one, { type: 'vm', name: 'a1', size: 'medium', region: 'af-west-1', zone: 'a' }).state;
    one = addResource(one, { type: 'vm', name: 'a2', size: 'medium', region: 'af-west-1', zone: 'a' }).state;
    one = { ...one, resources: one.resources.map((r) => (r.type === 'lb' ? { ...r, targets: ['i-0002', 'i-0003'] } : r)) };
    expect(simulate(one, outage).availability).toBeLessThan(0.6);
    const two = { ...one, resources: one.resources.map((r) => (r.name === 'a2' ? { ...r, zone: 'b' } : r)) };
    expect(simulate(two, outage).availability).toBeGreaterThan(0.99);
  });
  it('a multi-AZ database recovers from failover in a minute', () => {
    const s0 = addResource(empty(), { type: 'vm', name: 'web', size: 'large', region: 'af-west-1' }).state;
    const single = addResource(s0, { type: 'db', name: 'db', multiAz: false }).state;
    const multi = addResource(s0, { type: 'db', name: 'db', multiAz: true }).state;
    const sc: Scenario = { durationMin: 30, traffic: [[0, 50]], events: [{ at: 10, kind: 'db-failover', durationMin: 10 }] };
    expect(simulate(single, sc).availability).toBeCloseTo(20 / 30, 2);
    expect(simulate(multi, sc).availability).toBeCloseTo(29 / 30, 2);
  });
});

describe('infrastructure as code', () => {
  const src = `
variable "region" {
  default = "af-west-1"
}

resource "cloud_security_group" "web" {
  name = "web-sg"
  ingress {
    port     = 80
    protocol = "tcp"
    source   = "0.0.0.0/0"
  }
  ingress {
    port   = 22
    source = "10.0.0.0/16"
  }
}

resource "cloud_vm" "web" {
  name           = "web-1"
  region         = var.region
  size           = "small"
  security_group = cloud_security_group.web.id
  tags = { env = "prod", owner = "ama" }
}

resource "cloud_bucket" "assets" {
  name      = "assets"
  encrypted = true
  public    = false
}
`;
  it('parses blocks, resolves references and plans', () => {
    const blocks = parseHcl(src);
    expect(blocks.map((b) => `${b.kind}:${b.type ?? ''}:${b.name}`)).toEqual(['variable::region', 'resource:cloud_security_group:web', 'resource:cloud_vm:web', 'resource:cloud_bucket:assets']);
    const { desired, errors } = desiredResources(blocks);
    expect(errors).toEqual([]);
    expect(desired.map((d) => d.resource.name)).toEqual(['web-sg', 'web-1', 'assets']);
    expect(desired[0].resource.rules).toEqual([{ port: 80, protocol: 'tcp', source: '0.0.0.0/0' }, { port: 22, protocol: 'tcp', source: '10.0.0.0/16' }]);
    expect(desired[1].resource.region).toBe('af-west-1');
    expect(desired[1].resource.sg).toBe('web-sg');
    expect(desired[1].resource.tags).toEqual({ env: 'prod', owner: 'ama' });
    const p = plan(empty(), desired);
    expect(p.map((l) => l.action)).toEqual(['create', 'create', 'create']);
    expect(formatPlan(p)).toContain('Plan: 3 to add, 0 to change, 0 to destroy.');
    const { state } = apply(empty(), desired);
    expect(state.resources.find((r) => r.name === 'web-1')?.sg).toBe('sg-0001');
    // Drift: someone made the bucket public in the console; the plan shows a change back.
    const drifted = { ...state, resources: state.resources.map((r) => (r.name === 'assets' ? { ...r, public: true } : r)) };
    const p2 = plan(drifted, desired);
    expect(p2.map((l) => l.action)).toEqual(['no-op', 'no-op', 'update']);
    expect(p2[2].changes).toEqual([{ key: 'public', from: true, to: false }]);
  });
  it('reports syntax errors with a line', () => {
    expect(() => parseHcl('resource "cloud_vm" "x" {\n  name = \n}')).toThrow(/cannot read value/);
    expect(() => parseHcl('resource "cloud_vm" "x" {\n  name = "a"\n')).toThrow(/missing }/);
  });
});

describe('cloud.* checks', () => {
  const checks = createCloudChecks();
  const lab = (config: Record<string, unknown>, specs: LabSpec['checks']): LabSpec<CloudState> => ({ id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E12', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1, config });
  it('judges resources, security groups, findings, simulation, cost, answers and IAM', async () => {
    let s = addResource(empty(), { type: 'sg', name: 'web-sg', rules: [{ port: 80, protocol: 'tcp', source: '0.0.0.0/0' }] }).state;
    s = addResource(s, { type: 'vm', name: 'web-1', size: 'small', region: 'af-west-1', sg: 'sg-0001' }).state;
    s = addResource(s, { type: 'bucket', name: 'site', encrypted: true, website: true }).state;
    s = addResource(s, { type: 'policy', name: 'read-results', statements: [{ effect: 'Allow', actions: ['s3:GetObject'], resources: ['bucket:results'] }] }).state;
    s = addResource(s, { type: 'user', name: 'ama', policies: ['pol-0004'], mfa: true, accessKeys: 0 }).state;
    s = { ...s, answers: { q1: 'PaaS', q2: '42' } };
    const spec3: LabSpec<CloudState> = lab(
      { scenarios: { quiet: { durationMin: 10, traffic: [[0, 20]] } } },
      [
        { type: 'cloud.exists', label: 'A VM in Lagos', kind: 'vm', where: { region: 'af-west-1', status: 'running' } },
        { type: 'cloud.sg', label: 'web open on 80', vm: 'web-1', allows: [{ port: 80, source: 'internet' }], denies: [{ port: 22, source: 'internet' }] },
        { type: 'cloud.findings', label: 'clean', maxHigh: 0 },
        { type: 'cloud.sim', label: 'serves quiet traffic', scenario: 'quiet', availability: 0.999 },
        { type: 'cloud.cost', label: 'under budget', max: 60 },
        { type: 'cloud.answer', label: 'service model', id: 'q1', expected: ['paas'] },
        { type: 'cloud.answer', label: 'number', id: 'q2', expected: 40, tolerance: 0.1 },
        { type: 'cloud.iam', label: 'least privilege', user: 'ama', mfa: true, noWildcard: true, allowsOnly: ['s3:GetObject'] },
      ],
    );
    const r = await checks.run(spec3, s);
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
  });
});
