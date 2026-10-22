/**
 * A minute-by-minute workload simulation: traffic arrives at the deployment, instances serve
 * it up to their capacity, autoscaling reacts, failures are injected, and the run is scored
 * against an SLA and priced.
 */

import { byId, estimateCost, ofType, regionOf, sizeOf, type CloudState, type Resource, type SimSummary } from './model.js';

export interface SimEvent {
  at: number;
  kind: 'zone-outage' | 'vm-crash' | 'ddos' | 'db-failover' | 'bad-deploy';
  zone?: string;
  vm?: string;
  extraRps?: number;
  durationMin?: number;
}

export interface Scenario {
  durationMin: number;
  /** Piecewise traffic: [minute, requests per second] steps. */
  traffic: Array<[number, number]>;
  events?: SimEvent[];
  sloAvailability?: number;
  sloP95Ms?: number;
  /** Which app tier serves the traffic: a load balancer name, an ASG name, or a VM name. Defaults to the first LB, else ASG, else VM. */
  entry?: string;
}

export interface SimStep {
  t: number;
  rps: number;
  capacity: number;
  served: number;
  errors: number;
  p95Ms: number;
  instances: number;
  healthy: number;
  cpu: number;
  note?: string;
}

export interface SimResult extends SimSummary {
  steps: SimStep[];
  sloMet: boolean;
}

interface Instance {
  id: string;
  zone: string;
  size: string;
  readyAt: number;
  healthy: boolean;
  downUntil?: number;
  lostAt?: number;
  replaced?: boolean;
}

function trafficAt(traffic: Array<[number, number]>, t: number): number {
  let v = traffic[0]?.[1] ?? 0;
  for (const [at, rps] of traffic) if (t >= at) v = rps;
  return v;
}

/** Finds what serves traffic: the entry resource and the instances behind it. */
function entryOf(state: CloudState, scenario: Scenario): { entry?: Resource; vms: Resource[]; asg?: Resource } {
  let entry: Resource | undefined;
  if (scenario.entry) entry = state.resources.find((r) => r.name === scenario.entry || r.id === scenario.entry);
  if (!entry) entry = ofType(state, 'lb')[0] ?? ofType(state, 'asg')[0] ?? ofType(state, 'vm')[0];
  if (!entry) return { vms: [] };
  if (entry.type === 'vm') return { entry, vms: [entry] };
  if (entry.type === 'asg') return { entry, vms: [], asg: entry };
  const vms = (entry.targets ?? []).map((id) => byId(state, id)).filter((r): r is Resource => !!r && r.type === 'vm');
  const asg = ofType(state, 'asg').find((a) => a.lb === entry!.id || a.lb === entry!.name);
  return { entry, vms, asg };
}

export function simulate(state: CloudState, scenario: Scenario): SimResult {
  const { entry, vms, asg } = entryOf(state, scenario);
  const steps: SimStep[] = [];
  const notes: string[] = [];
  const region = regionOf(entry?.region ?? vms[0]?.region ?? asg?.region);
  const baseLatency = (region?.latencyFromGhanaMs ?? 150) + 60;
  const hasLb = entry?.type === 'lb';
  const waf = ofType(state, 'waf')[0];
  const db = ofType(state, 'db')[0];

  // Instances: static targets, plus ASG-managed ones.
  const instances: Instance[] = vms.filter((v) => v.status !== 'stopped').map((v) => ({ id: v.id, zone: `${v.region ?? 'us-east-1'}${v.zone ?? 'a'}`, size: v.size ?? 'small', readyAt: 0, healthy: true }));
  const asgZones = (asg?.zones?.length ? asg.zones : ['a']).map((z) => `${asg?.region ?? 'us-east-1'}${z}`);
  let desired = asg ? Math.max(asg.min ?? 1, Math.min(asg.max ?? 1, asg.desired ?? asg.min ?? 1)) : 0;
  let asgSeq = 0;
  const launch = (t: number) => {
    const zone = asgZones[asgSeq % asgZones.length];
    asgSeq++;
    instances.push({ id: `${asg!.id}-${asgSeq}`, zone, size: asg!.size ?? 'small', readyAt: t === 0 ? 0 : t + 2, healthy: true });
  };
  for (let k = 0; k < desired; k++) launch(0);
  if (!entry) notes.push('Nothing is deployed to serve the traffic: every request failed.');
  if (entry?.type === 'vm' && !hasLb) notes.push(`All traffic goes to the single instance ${entry.name}; there is no load balancer or autoscaling.`);

  let totalReq = 0;
  let totalErr = 0;
  let maxInst = instances.length;
  let minInst = instances.length;
  let scaleOuts = 0;
  let aboveSince = -1;
  let belowSince = -1;
  let cooldownUntil = -1;
  let dbDownUntil = -1;
  let instanceMinutes = 0;
  const p95s: number[] = [];
  const events = scenario.events ?? [];
  const sizeRps = (s: string) => sizeOf(s)?.rps ?? 50;

  for (let t = 0; t < scenario.durationMin; t++) {
    let note: string | undefined;
    let rps = trafficAt(scenario.traffic, t);
    // Events starting now.
    for (const e of events.filter((x) => x.at === t)) {
      const dur = e.durationMin ?? 10;
      if (e.kind === 'zone-outage') {
        const zone = e.zone ?? asgZones[0];
        let hit = 0;
        for (const i of instances) if (i.zone === zone || i.zone.endsWith(zone)) {
          i.healthy = false;
          i.downUntil = t + dur;
          i.lostAt = t;
          hit++;
        }
        note = `Zone ${zone} outage: ${hit} instance${hit === 1 ? '' : 's'} lost for ${dur} min.`;
        if (db && !db.multiAz && (db.zone === zone || `${db.region ?? 'us-east-1'}${db.zone ?? 'a'}` === zone)) dbDownUntil = t + dur;
      } else if (e.kind === 'vm-crash') {
        const target = instances.find((i) => i.id === e.vm || byId(state, i.id)?.name === e.vm) ?? instances[0];
        if (target) {
          target.healthy = false;
          target.downUntil = t + dur;
          target.lostAt = t;
          note = `Instance ${byId(state, target.id)?.name ?? target.id} crashed.`;
        }
      } else if (e.kind === 'ddos') {
        note = `DDoS: ${e.extraRps ?? 1000} extra requests/s for ${dur} min${waf ? ', mostly dropped by the WAF' : ''}.`;
      } else if (e.kind === 'db-failover') {
        dbDownUntil = t + (db?.multiAz ? 1 : dur);
        note = db ? `Database failover: ${db.multiAz ? 'standby promoted in about a minute' : `no standby, down for ${dur} min`}.` : 'Database failover event, but no managed database is deployed.';
      } else if (e.kind === 'bad-deploy') {
        note = 'A bad deploy raised errors until rolled back.';
      }
    }
    const activeDdos = events.find((e) => e.kind === 'ddos' && t >= e.at && t < e.at + (e.durationMin ?? 10));
    if (activeDdos) rps += waf ? (activeDdos.extraRps ?? 1000) * 0.1 : activeDdos.extraRps ?? 1000;
    const badDeploy = events.find((e) => e.kind === 'bad-deploy' && t >= e.at && t < e.at + (e.durationMin ?? 5));

    // Recover instances whose outage ended; ASG replaces lost instances after 3 minutes.
    for (const i of instances) if (!i.healthy && i.downUntil !== undefined && t >= i.downUntil) i.healthy = true;
    if (asg) {
      // Replace instances that have been unhealthy for 3 minutes, in another zone when there is one.
      const mine = instances.filter((i) => i.id.startsWith(asg.id));
      const healthyOrComing = mine.filter((i) => i.healthy).length;
      const lost = mine.filter((i) => !i.healthy && i.lostAt !== undefined && t - i.lostAt >= 3 && !i.replaced);
      for (const l of lost) {
        if (healthyOrComing + lost.indexOf(l) >= desired) break;
        const zone = asgZones.find((z) => z !== l.zone) ?? asgZones[0];
        if (zone === l.zone && asgZones.length === 1) continue; // nowhere else to go
        l.replaced = true;
        asgSeq++;
        instances.push({ id: `${asg.id}-${asgSeq}`, zone, size: asg.size ?? 'small', readyAt: t + 2, healthy: true });
        note = (note ? note + ' ' : '') + `Autoscaling replaced a lost instance in ${zone}.`;
      }
      // Replaced instances leave the group when they come back.
      for (let k = instances.length - 1; k >= 0; k--) {
        const i = instances[k];
        if (i.replaced && i.healthy) instances.splice(k, 1);
      }
    }

    const live = instances.filter((i) => i.healthy && i.readyAt <= t);
    const capacity = live.reduce((s, i) => s + sizeRps(i.size), 0) * (badDeploy ? 0.5 : 1);
    instanceMinutes += instances.filter((i) => i.healthy || i.readyAt > t).length;
    let served = Math.min(rps, capacity);
    if (!entry) served = 0;
    if (dbDownUntil > t) served = 0;
    if (!hasLb && entry?.type === 'vm' && !live.length) served = 0;
    const errors = Math.max(0, rps - served);
    const u = capacity > 0 ? rps / capacity : 2;
    const p95 = served === 0 && rps > 0 ? 5000 : baseLatency * (1 + 3 * Math.pow(Math.min(u, 1), 3)) + (u > 0.95 ? 400 : 0);
    const cpu = Math.min(100, Math.round(u * 100));
    totalReq += rps * 60;
    totalErr += errors * 60;
    if (rps > 0) p95s.push(p95);
    maxInst = Math.max(maxInst, live.length);
    minInst = Math.min(minInst, live.length);

    // Autoscaling policy: target tracking on CPU with a 3-minute cooldown.
    if (asg) {
      const target = asg.targetCpu ?? 70;
      if (cpu > target) {
        if (aboveSince < 0) aboveSince = t;
        belowSince = -1;
        if (t - aboveSince >= 1 && t >= cooldownUntil && desired < (asg.max ?? 1)) {
          // Target tracking: add enough instances to bring utilisation back to the target.
          const needed = Math.min(asg.max ?? 1, Math.max(desired + 1, Math.ceil(desired * (u * 100) / target)));
          const add = needed - desired;
          for (let k = 0; k < add; k++) launch(t);
          desired = needed;
          cooldownUntil = t + 3;
          scaleOuts++;
          note = (note ? note + ' ' : '') + `Scaled out to ${desired} (CPU ${cpu}% > ${target}%).`;
        }
      } else {
        aboveSince = -1;
        if (cpu < target * 0.5) {
          if (belowSince < 0) belowSince = t;
          if (t - belowSince >= 5 && t >= cooldownUntil && desired > (asg.min ?? 1)) {
            desired--;
            const victim = instances.filter((i) => i.id.startsWith(asg.id) && i.healthy).pop();
            if (victim) instances.splice(instances.indexOf(victim), 1);
            cooldownUntil = t + 3;
            belowSince = -1;
            note = (note ? note + ' ' : '') + `Scaled in to ${desired}.`;
          }
        } else belowSince = -1;
      }
    }
    steps.push({ t, rps: Math.round(rps), capacity: Math.round(capacity), served: Math.round(served), errors: Math.round(errors), p95Ms: Math.round(p95), instances: instances.length, healthy: live.length, cpu, note });
  }

  const availability = totalReq ? (totalReq - totalErr) / totalReq : 1;
  const sorted = [...p95s].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
  const hourly = (sizeOf(asg?.size ?? vms[0]?.size ?? 'small')?.hourlyUsd ?? 0.02) * (region?.priceFactor ?? 1);
  const runCost = (instanceMinutes / 60) * hourly;
  const monthly = estimateCost(state).totalUsd;
  const sloA = scenario.sloAvailability ?? 0.999;
  const sloP = scenario.sloP95Ms ?? 500;
  const sloMet = availability >= sloA && p95 <= sloP;
  if (!sloMet) notes.push(`SLO missed: availability ${(availability * 100).toFixed(2)}% (target ${(sloA * 100).toFixed(2)}%), p95 ${Math.round(p95)} ms (target ${sloP} ms).`);
  else notes.push(`SLO met: availability ${(availability * 100).toFixed(3)}%, p95 ${Math.round(p95)} ms.`);
  if (hasLb && (entry?.targets?.length ?? 0) + (asg ? 1 : 0) === 0) notes.push('The load balancer has no healthy targets.');
  return { steps, availability, p95Ms: Math.round(p95), totalRequests: Math.round(totalReq), errors: Math.round(totalErr), maxInstances: maxInst, minInstances: minInst, scaleOuts, costUsd: Math.round((runCost + monthly / 730 / 60 * scenario.durationMin) * 100) / 100, notes, sloMet };
}

export function summaryOf(r: SimResult): SimSummary {
  const { availability, p95Ms, totalRequests, errors, maxInstances, minInstances, scaleOuts, costUsd, notes } = r;
  return { availability, p95Ms, totalRequests, errors, maxInstances, minInstances, scaleOuts, costUsd, notes };
}
