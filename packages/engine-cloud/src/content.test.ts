/**
 * Every E12 lab must be solvable: a reference deployment per lab id passes every check,
 * and the starting account does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { addResource, apply, createCloudChecks, desiredResources, parseHcl, removeResource, updateResource, type CloudConfig, type CloudState, type Resource } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

type Solve = (s: CloudState, config: CloudConfig) => CloudState;

const add = (s: CloudState, r: Omit<Resource, 'id'>) => addResource(s, r).state;
const byName = (s: CloudState, type: Resource['type'], name: string) => s.resources.find((r) => r.type === type && r.name === name)!;

const SOLUTIONS: Record<string, Solve> = {
  'cloud-computing-b1-launch-a-vm-and-host-a-page': (s) => {
    s = add(s, { type: 'sg', name: 'web-sg', rules: [{ port: 80, protocol: 'tcp', source: '0.0.0.0/0' }, { port: 22, protocol: 'tcp', source: '10.0.0.0/16' }] });
    return add(s, { type: 'vm', name: 'web-1', region: 'af-west-1', size: 'small', sg: byName(s, 'sg', 'web-sg').id, publicIp: true });
  },
  'cloud-computing-b2-classify-the-services': (s) => ({ ...s, answers: { q1: 'IaaS', q2: 'PaaS', q3: 'SaaS', q4: 'FaaS', q5: 'Private cloud', q6: 'Public cloud' } }),
  'cloud-computing-i1-scale-for-results-day': (s) => {
    s = add(s, { type: 'lb', name: 'web-lb', region: 'af-west-1' });
    s = add(s, { type: 'asg', name: 'web-asg', region: 'af-west-1', size: 'small', min: 2, max: 10, desired: 2, targetCpu: 50, zones: ['a', 'b'], lb: byName(s, 'lb', 'web-lb').id });
    return add(s, { type: 'db', name: 'results-db', region: 'af-west-1', size: 'small', multiAz: true, encrypted: true, backupDays: 7 });
  },
  'cloud-computing-i2-fix-the-misconfigured-account': (s) => {
    s = updateResource(s, 'bkt-0004', { public: false, encrypted: true });
    s = updateResource(s, 'sg-0001', { rules: [{ port: 80, protocol: 'tcp', source: '0.0.0.0/0' }, { port: 22, protocol: 'tcp', source: '10.0.0.0/16' }] });
    s = updateResource(s, 'sg-0002', { rules: [{ port: 3306, protocol: 'tcp', source: 'sg:sg-0001' }] });
    s = updateResource(s, 'db-0005', { public: false, encrypted: true, backupDays: 7 });
    return updateResource(s, 'usr-0008', { mfa: true, accessKeys: 1, policies: ['pol-0007'] });
  },
  'cloud-computing-a1-right-size-for-a-budget': (s) => {
    s = updateResource(s, 'lb-0001', { region: 'af-west-1' });
    s = updateResource(s, 'i-0002', { region: 'af-west-1', size: 'small', diskGb: 20 });
    s = updateResource(s, 'i-0003', { region: 'af-west-1', size: 'small', diskGb: 20 });
    s = updateResource(s, 'db-0004', { region: 'af-west-1', size: 'small', storageGb: 20 });
    s = updateResource(s, 'bkt-0005', { region: 'af-west-1', storageGb: 40 });
    return add(s, { type: 'budget', name: 'library', monthlyUsd: 150, alertAt: 80 });
  },
  'cloud-computing-a2-survive-a-zone-outage': (s) => {
    s = add(s, { type: 'asg', name: 'api-asg', region: 'af-west-1', size: 'medium', min: 2, max: 6, desired: 2, targetCpu: 60, zones: ['a', 'b'], lb: 'lb-0001' });
    s = updateResource(s, 'db-0003', { multiAz: true });
    return add(s, { type: 'waf', name: 'api-waf', rateLimit: 500 });
  },
  'infrastructure-as-code-i1-provision-with-code': (s) => {
    const hcl = 'resource "cloud_security_group" "web" {\n  name = "web-sg"\n  ingress {\n    port   = 80\n    source = "0.0.0.0/0"\n  }\n  ingress {\n    port   = 22\n    source = "10.0.0.0/16"\n  }\n}\n\nresource "cloud_vm" "web" {\n  name           = "web-1"\n  region         = "af-west-1"\n  size           = "small"\n  security_group = cloud_security_group.web.id\n}\n\nresource "cloud_bucket" "assets" {\n  name      = "web-assets"\n  encrypted = true\n  public    = false\n}\n';
    const { desired } = desiredResources(parseHcl(hcl));
    return { ...apply(s, desired).state, hcl };
  },
  'infrastructure-as-code-a1-detect-and-fix-drift': (s, config) => {
    const { desired } = desiredResources(parseHcl(config.starterHcl ?? ''));
    return { ...apply(s, desired).state, hcl: config.starterHcl, answers: { changed: '2' } };
  },
  'site-reliability-engineering-b1-error-budgets': (s) => ({ ...s, answers: { budget: '43.2', budget2: '21.6', sli: '99.92', met: 'Yes', left: '18.2', decision: 'Continue releasing, but watch the burn rate' } }),
  'site-reliability-engineering-i1-failover-drill': (s) => {
    s = updateResource(s, 'db-0002', { multiAz: true });
    s = add(s, { type: 'vm', name: 'web-2', region: 'af-west-1', zone: 'b', size: 'medium' });
    s = add(s, { type: 'lb', name: 'web-lb', region: 'af-west-1', targets: ['i-0001', byName(s, 'vm', 'web-2').id] });
    return { ...s, answers: { before: '10', after: '1' } };
  },
  'serverless-and-cloud-native-applications-i1-functions-or-servers': (s) => {
    s = add(s, { type: 'function', name: 'lookup', region: 'af-west-1', memoryMb: 128, avgMs: 100, invocationsPerMonth: 2000000 });
    return { ...s, answers: { low: 'Function', high: 'Virtual machine', fncost: '81.7' } };
  },
  'cloud-security-i1-least-privilege': (s) => {
    s = add(s, { type: 'policy', name: 'results-upload', statements: [{ effect: 'Allow', actions: ['s3:PutObject'], resources: ['bucket:results'] }] });
    const pol = byName(s, 'policy', 'results-upload').id;
    s = add(s, { type: 'role', name: 'uploader', policies: [pol] });
    return updateResource(s, 'usr-0003', { mfa: true, accessKeys: 1, policies: [pol] });
  },
};

function allLabs(): LabSpec<CloudState>[] {
  const out: LabSpec<CloudState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<CloudState>;
      if (raw.engine === 'E12') out.push(raw);
    }
  }
  return out;
}

describe('E12 lab content', () => {
  const checks = createCloudChecks();
  const labs = allLabs();
  it('finds the cloud labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(12);
  });
  for (const lab of labs) {
    const config = lab.config as unknown as CloudConfig;
    describe(lab.id, () => {
      it('has a solution and only cloud.* checks', () => {
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('cloud.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const r = await checks.run(lab, { resources: [], ...(lab.initialState ?? {}), hcl: config.starterHcl });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference deployment', async () => {
        const start: CloudState = JSON.parse(JSON.stringify({ resources: [], ...(lab.initialState ?? {}), hcl: config.starterHcl }));
        const state = SOLUTIONS[lab.id](start, config);
        const r = await checks.run(lab, state);
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
  it('removeResource keeps references consistent', () => {
    let s = add({ resources: [] }, { type: 'vm', name: 'a' });
    s = add(s, { type: 'lb', name: 'l', targets: ['i-0001'] });
    s = removeResource(s, 'i-0001');
    expect(s.resources[0].targets).toEqual([]);
  });
});
