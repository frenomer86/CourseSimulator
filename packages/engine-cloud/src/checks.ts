/**
 * Checks for cloud labs, under the "cloud.*" namespace.
 *
 *   cloud.exists   { kind, name?, where?: {field: value | [all of] | {">=": n} | {"<=": n} | {"!=": v}}, count?: n }
 *   cloud.sg       { name | vm, allows?: [{port, source}], denies?: [{port, source}] }
 *   cloud.findings { maxHigh?: 0, maxMedium?: n }                 the posture scanner is clean
 *   cloud.sim      { scenario: key into config.scenarios, availability?, p95Ms?, maxInstances?, scaleOuts?, maxErrors? }
 *   cloud.cost     { max, egressGb? }                               monthly estimate under budget
 *   cloud.answer   { id, expected: string | string[] | number, tolerance?, question, options? }
 *   cloud.hcl      { minResources?: n, mentions?: [resource types] }   the code parses
 *   cloud.lb       { name, minTargets?, minZones? }
 *   cloud.asg      { name, min?, max?, minZones?, maxTargetCpu?, attachedTo? }
 *   cloud.iam      { user, mfa?, noWildcard?, maxKeys?, hasPolicy? }
 */

import { CheckRegistry, type CheckResult, type CheckSpec, type LabSpec } from '@cslab/lab-runtime';
import { byId, byName, estimateCost, findings, ofType, policyIsWildcard, sgAllows, userPolicies, type CloudState, type Resource, type ResourceType } from './model.js';
import { simulate, type Scenario } from './sim.js';
import { desiredResources, parseHcl } from './hcl.js';

export interface CloudQuestion {
  id: string;
  question: string;
  options?: string[];
}

export interface CloudConfig {
  /** Which console panels to show. */
  panels?: Array<'resources' | 'network' | 'iam' | 'monitor' | 'billing' | 'iac' | 'scanner'>;
  scenarios?: Record<string, Scenario>;
  starterHcl?: string;
  variables?: Record<string, string | number | boolean>;
  /** Resource types the learner may create. */
  allowed?: ResourceType[];
}

function fail(spec: CheckSpec, message: string, detail?: unknown): CheckResult {
  return { type: spec.type, label: spec.label, passed: false, message, detail };
}
function pass(spec: CheckSpec, message: string): CheckResult {
  return { type: spec.type, label: spec.label, passed: true, message };
}
function cfg(lab: LabSpec<unknown>): CloudConfig {
  return (lab.config ?? {}) as unknown as CloudConfig;
}

function matches(r: Resource, where: Record<string, unknown>): string | null {
  for (const [k, want] of Object.entries(where)) {
    const have = (r as unknown as Record<string, unknown>)[k];
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      const w = want as Record<string, unknown>;
      if ('>=' in w && !(Number(have) >= Number(w['>=']))) return `${k} is ${String(have)}, needs at least ${String(w['>='])}`;
      if ('<=' in w && !(Number(have) <= Number(w['<=']))) return `${k} is ${String(have)}, needs at most ${String(w['<='])}`;
      if ('!=' in w && have === w['!=']) return `${k} should not be ${String(w['!='])}`;
      if ('in' in w && !(w.in as unknown[]).includes(have)) return `${k} is ${String(have)}, expected one of ${(w.in as unknown[]).join(', ')}`;
      continue;
    }
    if (Array.isArray(want)) {
      if (!Array.isArray(have)) return `${k} is not set`;
      const key = (x: unknown) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
      const haveKeys = (have as unknown[]).map(key);
      const missing = want.filter((x) => !haveKeys.includes(key(x)));
      if (missing.length) return `${k} is missing ${missing.map((m) => (typeof m === 'object' ? describeValue(m) : String(m))).join(', ')}`;
      if (k === 'statements' && (have as unknown[]).length !== want.length) return `${k} has extra entries beyond what was asked for`;
      continue;
    }
    if (have !== want) return `${k} is ${have === undefined ? 'not set' : String(have)}, expected ${String(want)}`;
  }
  return null;
}

function describeValue(v: unknown): string {
  if (v && typeof v === 'object' && 'actions' in (v as object)) {
    const s = v as { effect?: string; actions?: string[]; resources?: string[] };
    return `${s.effect ?? 'Allow'} ${(s.actions ?? []).join(',')} on ${(s.resources ?? []).join(',')}`;
  }
  return JSON.stringify(v);
}

const TYPE_LABEL: Record<ResourceType, string> = { vm: 'virtual machine', sg: 'security group', bucket: 'bucket', db: 'database', lb: 'load balancer', asg: 'autoscaling group', user: 'IAM user', policy: 'IAM policy', role: 'IAM role', waf: 'web application firewall', budget: 'budget', function: 'function', queue: 'queue' };

export function createCloudChecks(): CheckRegistry<CloudState> {
  return new CheckRegistry<CloudState>()
    .register('cloud.exists', async (state, spec) => {
      // "type" is the check's own type, so the resource type comes in "kind".
      const type = String(spec.kind) as ResourceType;
      const where = (spec.where as Record<string, unknown> | undefined) ?? {};
      let pool = ofType(state, type);
      if (spec.name) pool = pool.filter((r) => r.name === spec.name);
      const need = Number(spec.count ?? 1);
      const ok = pool.filter((r) => matches(r, where) === null);
      if (need === 0) return ok.length === 0 ? pass(spec, String(spec.success ?? `No ${TYPE_LABEL[type]} matches, as required.`)) : fail(spec, String(spec.message ?? `There should be no ${TYPE_LABEL[type]} like this, but ${ok[0].name} exists.`));
      if (!pool.length) return fail(spec, String(spec.message ?? `No ${TYPE_LABEL[type]}${spec.name ? ` called ${String(spec.name)}` : ''} exists yet.`));
      if (ok.length >= need) return pass(spec, String(spec.success ?? `${ok.length} ${TYPE_LABEL[type]}${ok.length === 1 ? '' : 's'} as required.`));
      const why = matches(pool[0], where);
      return fail(spec, String(spec.message ?? (need > 1 ? `Only ${ok.length} of the ${need} ${TYPE_LABEL[type]}s required match${why ? ` (${pool[0].name}: ${why})` : ''}.` : `${TYPE_LABEL[type]} ${pool[0].name}: ${why}.`)));
    })

    .register('cloud.sg', async (state, spec) => {
      let sg: Resource | undefined;
      if (spec.vm) {
        const vm = byName(state, 'vm', String(spec.vm));
        if (!vm) return fail(spec, `No virtual machine called ${String(spec.vm)}.`);
        sg = byId(state, vm.sg);
        if (!sg) return fail(spec, `${vm.name} has no security group attached.`);
      } else sg = byName(state, 'sg', String(spec.name)) ?? byId(state, String(spec.name));
      if (!sg) return fail(spec, String(spec.message ?? `No security group called ${String(spec.name)} exists yet.`));
      for (const rule of (spec.allows as Array<{ port: number; source: string }> | undefined) ?? []) {
        if (!sgAllows(sg, rule.port, rule.source)) return fail(spec, String(spec.message ?? `${sg.name} does not allow port ${rule.port} from ${rule.source}.`));
      }
      for (const rule of (spec.denies as Array<{ port: number; source: string }> | undefined) ?? []) {
        if (sgAllows(sg, rule.port, rule.source)) return fail(spec, String(spec.message ?? `${sg.name} still allows port ${rule.port} from ${rule.source}.`));
      }
      return pass(spec, String(spec.success ?? `${sg.name} has the right rules.`));
    })

    .register('cloud.findings', async (state, spec) => {
      const f = findings(state);
      const high = f.filter((x) => x.severity === 'high');
      const medium = f.filter((x) => x.severity === 'medium');
      if (high.length > Number(spec.maxHigh ?? 0)) return fail(spec, `The scanner still reports ${high.length} high-severity finding${high.length === 1 ? '' : 's'}: ${high.map((x) => x.message).join(' ')}`);
      if (spec.maxMedium !== undefined && medium.length > Number(spec.maxMedium)) return fail(spec, `The scanner still reports ${medium.length} medium findings: ${medium.map((x) => x.message).join(' ')}`);
      return pass(spec, high.length || medium.length ? `No high-severity findings (${medium.length} medium left).` : 'The posture scanner is clean.');
    })

    .register('cloud.sim', async (state, spec, lab) => {
      const scenario = cfg(lab).scenarios?.[String(spec.scenario)];
      if (!scenario) return fail(spec, 'This check names a scenario the lab does not define. This is a content error, not yours.');
      const r = simulate(state, scenario);
      const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
      if (spec.availability !== undefined && r.availability < Number(spec.availability)) return fail(spec, String(spec.message ?? `Availability was ${pct(r.availability)}; the target is ${pct(Number(spec.availability))}. ${r.notes.join(' ')}`), r);
      if (spec.p95Ms !== undefined && r.p95Ms > Number(spec.p95Ms)) return fail(spec, String(spec.message ?? `p95 latency was ${r.p95Ms} ms; the target is ${String(spec.p95Ms)} ms. Add capacity or move closer to the users.`), r);
      if (spec.maxInstances !== undefined && r.maxInstances < Number(spec.maxInstances)) return fail(spec, String(spec.message ?? `The deployment only reached ${r.maxInstances} instance${r.maxInstances === 1 ? '' : 's'}; it should scale to at least ${String(spec.maxInstances)}.`), r);
      if (spec.scaleOuts !== undefined && r.scaleOuts < Number(spec.scaleOuts)) return fail(spec, String(spec.message ?? `Autoscaling never scaled out; check the maximum size and the CPU target.`), r);
      if (spec.maxErrors !== undefined && r.errors > Number(spec.maxErrors)) return fail(spec, String(spec.message ?? `${r.errors} requests failed during the run; at most ${String(spec.maxErrors)} allowed.`), r);
      return pass(spec, String(spec.success ?? `Availability ${pct(r.availability)}, p95 ${r.p95Ms} ms, peak ${r.maxInstances} instance${r.maxInstances === 1 ? '' : 's'}.`));
    })

    .register('cloud.cost', async (state, spec) => {
      const c = estimateCost(state, spec.egressGb !== undefined ? Number(spec.egressGb) : 50);
      const usd = Math.round(c.totalUsd * 100) / 100;
      if (spec.min !== undefined && usd < Number(spec.min)) return fail(spec, String(spec.message ?? `The estimate is $${usd}/month, below $${String(spec.min)}: something required is missing.`));
      return usd <= Number(spec.max) ? pass(spec, `The estimate is $${usd}/month, within the $${String(spec.max)} budget.`) : fail(spec, String(spec.message ?? `The estimate is $${usd}/month, over the $${String(spec.max)} budget. Right-size or remove what is not needed.`), c);
    })

    .register('cloud.answer', async (state, spec) => {
      const text = (state.answers?.[String(spec.id)] ?? '').trim();
      if (!text) return fail(spec, 'Answer this question first.');
      if (typeof spec.expected === 'number') {
        const n = Number(text.replace(/[$,%\s]/g, ''));
        if (!Number.isFinite(n)) return fail(spec, `"${text}" is not a number.`);
        const tol = Number(spec.tolerance ?? 0.05);
        return Math.abs(n - spec.expected) <= Math.max(Math.abs(spec.expected) * tol, Number(spec.absolute ?? 0.5)) ? pass(spec, String(spec.success ?? `Right: about ${spec.expected}.`)) : fail(spec, String(spec.message ?? 'Not quite. Check the working.'));
      }
      const accepted = (Array.isArray(spec.expected) ? spec.expected : [spec.expected]).map((x) => String(x).trim().toLowerCase());
      return accepted.includes(text.toLowerCase()) ? pass(spec, String(spec.success ?? 'Correct.')) : fail(spec, String(spec.message ?? 'Not the right choice. Think about who manages what at each level.'));
    })

    .register('cloud.hcl', async (state, spec) => {
      const src = state.hcl ?? '';
      if (!src.trim()) return fail(spec, 'Write the infrastructure code first.');
      try {
        const blocks = parseHcl(src);
        const { desired, errors } = desiredResources(blocks);
        if (errors.length) return fail(spec, `The code has problems: ${errors.join('; ')}`);
        if (spec.minResources !== undefined && desired.length < Number(spec.minResources)) return fail(spec, `The code declares ${desired.length} resource${desired.length === 1 ? '' : 's'}; at least ${String(spec.minResources)} needed.`);
        for (const t of (spec.mentions as string[] | undefined) ?? []) if (!desired.some((d) => d.type === t)) return fail(spec, `The code should declare a ${TYPE_LABEL[t as ResourceType] ?? t}.`);
        return pass(spec, `The code parses and declares ${desired.length} resource${desired.length === 1 ? '' : 's'}.`);
      } catch (e) {
        return fail(spec, `The code does not parse: ${(e as Error).message}`);
      }
    })

    .register('cloud.lb', async (state, spec) => {
      const lb = byName(state, 'lb', String(spec.name));
      if (!lb) return fail(spec, String(spec.message ?? `No load balancer called ${String(spec.name)} exists yet.`));
      const targets = (lb.targets ?? []).map((id) => byId(state, id)).filter((r): r is Resource => !!r);
      const asg = ofType(state, 'asg').find((a) => a.lb === lb.id || a.lb === lb.name);
      const zones = new Set([...targets.map((t) => `${t.region}${t.zone}`), ...(asg?.zones ?? []).map((z) => `${asg?.region}${z}`)]);
      const count = targets.length + (asg ? asg.min ?? 1 : 0);
      if (spec.minTargets !== undefined && count < Number(spec.minTargets)) return fail(spec, `${lb.name} has ${count} target${count === 1 ? '' : 's'}; at least ${String(spec.minTargets)} needed (attach instances or an autoscaling group).`);
      if (spec.minZones !== undefined && zones.size < Number(spec.minZones)) return fail(spec, `${lb.name}'s targets are in ${zones.size} zone${zones.size === 1 ? '' : 's'}; spread them over at least ${String(spec.minZones)} so one zone failing does not take the site down.`);
      return pass(spec, `${lb.name} balances ${count} target${count === 1 ? '' : 's'} across ${zones.size} zone${zones.size === 1 ? '' : 's'}.`);
    })

    .register('cloud.asg', async (state, spec) => {
      const asg = byName(state, 'asg', String(spec.name));
      if (!asg) return fail(spec, String(spec.message ?? `No autoscaling group called ${String(spec.name)} exists yet.`));
      if (spec.min !== undefined && (asg.min ?? 0) < Number(spec.min)) return fail(spec, `${asg.name} has a minimum of ${asg.min}; it should be at least ${String(spec.min)}.`);
      if (spec.max !== undefined && (asg.max ?? 0) < Number(spec.max)) return fail(spec, `${asg.name} has a maximum of ${asg.max}; it should be at least ${String(spec.max)} so it can scale out.`);
      if (spec.minZones !== undefined && (asg.zones?.length ?? 0) < Number(spec.minZones)) return fail(spec, `${asg.name} launches in ${asg.zones?.length ?? 0} zone${(asg.zones?.length ?? 0) === 1 ? '' : 's'}; use at least ${String(spec.minZones)}.`);
      if (spec.maxTargetCpu !== undefined && (asg.targetCpu ?? 100) > Number(spec.maxTargetCpu)) return fail(spec, `${asg.name} scales at ${asg.targetCpu}% CPU; use ${String(spec.maxTargetCpu)}% or lower to scale before it saturates.`);
      if (spec.attachedTo !== undefined) {
        const lb = byName(state, 'lb', String(spec.attachedTo));
        if (!lb || (asg.lb !== lb.id && asg.lb !== lb.name)) return fail(spec, `${asg.name} is not attached to the load balancer ${String(spec.attachedTo)}.`);
      }
      return pass(spec, `${asg.name}: ${asg.min}–${asg.max} × ${asg.size} in ${asg.zones?.length ?? 1} zone${(asg.zones?.length ?? 1) === 1 ? '' : 's'}.`);
    })

    .register('cloud.iam', async (state, spec) => {
      const user = byName(state, 'user', String(spec.user)) ?? byName(state, 'role', String(spec.user));
      if (!user) return fail(spec, String(spec.message ?? `No IAM user called ${String(spec.user)} exists yet.`));
      if (spec.mfa && !user.mfa) return fail(spec, `${user.name} has no MFA enabled.`);
      if (spec.noWildcard && userPolicies(state, user).some(policyIsWildcard)) return fail(spec, `${user.name} still has a policy that allows every action on every resource.`);
      if (spec.maxKeys !== undefined && (user.accessKeys ?? 0) > Number(spec.maxKeys)) return fail(spec, `${user.name} has ${user.accessKeys} access keys; at most ${String(spec.maxKeys)} allowed.`);
      if (spec.hasPolicy !== undefined && !userPolicies(state, user).some((p) => p.name === spec.hasPolicy)) return fail(spec, `${user.name} does not have the policy ${String(spec.hasPolicy)} attached.`);
      if (spec.allowsOnly !== undefined) {
        const allowed = new Set((spec.allowsOnly as string[]).map(String));
        const extra = userPolicies(state, user).flatMap((p) => p.statements ?? []).filter((s) => s.effect === 'Allow').flatMap((s) => s.actions).filter((a) => !allowed.has(a) && ![...allowed].some((x) => x.endsWith(':*') && a.startsWith(x.slice(0, -1))));
        if (extra.length) return fail(spec, `${user.name} can also ${extra.join(', ')}, which the job does not need.`);
      }
      return pass(spec, `${user.name} follows least privilege.`);
    });
}
