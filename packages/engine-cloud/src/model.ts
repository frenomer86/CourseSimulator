/**
 * The simulated cloud account: a catalogue of regions, instance sizes and prices, and the
 * resource records a learner creates in the console or through infrastructure as code.
 */

export type ResourceType = 'vm' | 'sg' | 'bucket' | 'db' | 'lb' | 'asg' | 'user' | 'policy' | 'role' | 'waf' | 'budget' | 'function' | 'queue';

export interface SgRule {
  port: number | 'all';
  protocol: 'tcp' | 'udp' | 'icmp' | 'all';
  /** CIDR such as 0.0.0.0/0, 10.0.0.0/16, or "sg:<id>" for another security group. */
  source: string;
}

export interface Statement {
  effect: 'Allow' | 'Deny';
  /** e.g. ["s3:GetObject", "ec2:*", "*"] */
  actions: string[];
  /** e.g. ["bucket:results", "*"] */
  resources: string[];
}

export interface Resource {
  id: string;
  type: ResourceType;
  name: string;
  region?: string;
  zone?: string;
  // vm
  size?: string;
  image?: string;
  sg?: string;
  publicIp?: boolean;
  status?: 'running' | 'stopped';
  diskGb?: number;
  // sg
  rules?: SgRule[];
  // bucket
  public?: boolean;
  encrypted?: boolean;
  versioning?: boolean;
  storageGb?: number;
  website?: boolean;
  // db
  engine?: string;
  multiAz?: boolean;
  backupDays?: number;
  // lb
  targets?: string[];
  healthCheck?: string;
  listenerPort?: number;
  // asg
  min?: number;
  max?: number;
  desired?: number;
  targetCpu?: number;
  zones?: string[];
  lb?: string;
  // user / role
  policies?: string[];
  mfa?: boolean;
  accessKeys?: number;
  // policy
  statements?: Statement[];
  // waf
  rateLimit?: number;
  // budget
  monthlyUsd?: number;
  alertAt?: number;
  // function
  memoryMb?: number;
  invocationsPerMonth?: number;
  avgMs?: number;
  tags?: Record<string, string>;
}

export interface CloudState {
  resources: Resource[];
  hcl?: string;
  answers?: Record<string, string>;
  lastSim?: SimSummary;
  /** Counter for generated ids. */
  seq?: number;
}

export interface SimSummary {
  availability: number;
  p95Ms: number;
  totalRequests: number;
  errors: number;
  maxInstances: number;
  minInstances: number;
  scaleOuts: number;
  costUsd: number;
  notes: string[];
}

export interface Region {
  id: string;
  name: string;
  /** Round-trip latency from Accra in ms. */
  latencyFromGhanaMs: number;
  /** Price multiplier relative to us-east-1. */
  priceFactor: number;
  zones: string[];
  inCountry?: boolean;
  dataResidency: string;
}

export const REGIONS: Region[] = [
  { id: 'af-west-1', name: 'Lagos (West Africa)', latencyFromGhanaMs: 45, priceFactor: 1.15, zones: ['a', 'b', 'c'], dataResidency: 'Nigeria' },
  { id: 'af-south-1', name: 'Cape Town (South Africa)', latencyFromGhanaMs: 180, priceFactor: 1.2, zones: ['a', 'b', 'c'], dataResidency: 'South Africa' },
  { id: 'eu-west-1', name: 'Ireland (Europe)', latencyFromGhanaMs: 110, priceFactor: 1.05, zones: ['a', 'b', 'c'], dataResidency: 'EU' },
  { id: 'us-east-1', name: 'N. Virginia (USA)', latencyFromGhanaMs: 190, priceFactor: 1.0, zones: ['a', 'b', 'c'], dataResidency: 'USA' },
  { id: 'gh-accra-1', name: 'Accra (local provider)', latencyFromGhanaMs: 8, priceFactor: 1.35, zones: ['a', 'b'], inCountry: true, dataResidency: 'Ghana' },
];

export interface InstanceSize {
  id: string;
  vcpu: number;
  memoryGb: number;
  /** On-demand price per hour in us-east-1. */
  hourlyUsd: number;
  /** Requests per second one instance can serve for the reference web app. */
  rps: number;
}

export const SIZES: InstanceSize[] = [
  { id: 'nano', vcpu: 1, memoryGb: 0.5, hourlyUsd: 0.0052, rps: 15 },
  { id: 'small', vcpu: 1, memoryGb: 2, hourlyUsd: 0.0208, rps: 50 },
  { id: 'medium', vcpu: 2, memoryGb: 4, hourlyUsd: 0.0416, rps: 120 },
  { id: 'large', vcpu: 4, memoryGb: 8, hourlyUsd: 0.0832, rps: 260 },
  { id: 'xlarge', vcpu: 8, memoryGb: 16, hourlyUsd: 0.1664, rps: 550 },
  { id: '2xlarge', vcpu: 16, memoryGb: 32, hourlyUsd: 0.3328, rps: 1100 },
];

export const PRICES = {
  storageGbMonth: 0.023,
  blockGbMonth: 0.08,
  dbFactor: 1.6,
  multiAzFactor: 2,
  lbHourly: 0.0225,
  lbPerGb: 0.008,
  natHourly: 0.045,
  egressPerGb: 0.09,
  functionPerMillion: 0.2,
  functionGbSecond: 0.0000166667,
  queuePerMillion: 0.4,
  wafHourly: 0.0139,
  hoursPerMonth: 730,
};

export const IMAGES = ['Ubuntu 24.04', 'openSUSE Leap 15.6', 'Windows Server 2022', 'Amazon Linux 2023'];
export const DB_ENGINES = ['PostgreSQL 16', 'MySQL 8', 'MariaDB 11'];

export function regionOf(id: string | undefined): Region | undefined {
  return REGIONS.find((r) => r.id === id);
}
export function sizeOf(id: string | undefined): InstanceSize | undefined {
  return SIZES.find((s) => s.id === id);
}

export function byId(state: CloudState, id: string | undefined): Resource | undefined {
  return state.resources.find((r) => r.id === id);
}
export function ofType(state: CloudState, type: ResourceType): Resource[] {
  return state.resources.filter((r) => r.type === type);
}
export function byName(state: CloudState, type: ResourceType, name: string): Resource | undefined {
  return state.resources.find((r) => r.type === type && r.name === name);
}

/** Creates a resource with defaults and a fresh id; returns the new state. */
export function addResource(state: CloudState, r: Omit<Resource, 'id'> & { id?: string }): { state: CloudState; resource: Resource } {
  const seq = (state.seq ?? 0) + 1;
  const prefix: Record<ResourceType, string> = { vm: 'i', sg: 'sg', bucket: 'bkt', db: 'db', lb: 'lb', asg: 'asg', user: 'usr', policy: 'pol', role: 'role', waf: 'waf', budget: 'bgt', function: 'fn', queue: 'q' };
  const resource: Resource = { ...withDefaults(r), id: r.id ?? `${prefix[r.type]}-${String(seq).padStart(4, '0')}` };
  return { state: { ...state, seq, resources: [...state.resources, resource] }, resource };
}

export function updateResource(state: CloudState, id: string, patch: Partial<Resource>): CloudState {
  return { ...state, resources: state.resources.map((r) => (r.id === id ? { ...r, ...patch } : r)) };
}

export function removeResource(state: CloudState, id: string): CloudState {
  return {
    ...state,
    resources: state.resources
      .filter((r) => r.id !== id)
      .map((r) => (r.targets?.includes(id) ? { ...r, targets: r.targets.filter((t) => t !== id) } : r.sg === id ? { ...r, sg: undefined } : r.lb === id ? { ...r, lb: undefined } : r)),
  };
}

export function withDefaults(r: Omit<Resource, 'id'> & { id?: string }): Omit<Resource, 'id'> & { id?: string } {
  switch (r.type) {
    case 'vm':
      return { region: 'us-east-1', zone: 'a', size: 'small', image: IMAGES[0], publicIp: true, status: 'running', diskGb: 20, ...r };
    case 'sg':
      return { rules: [], ...r };
    case 'bucket':
      return { region: 'us-east-1', public: false, encrypted: false, versioning: false, storageGb: 10, website: false, ...r };
    case 'db':
      return { region: 'us-east-1', engine: DB_ENGINES[0], size: 'small', multiAz: false, encrypted: false, public: false, backupDays: 0, storageGb: 20, ...r };
    case 'lb':
      return { region: 'us-east-1', targets: [], healthCheck: '/', listenerPort: 80, ...r };
    case 'asg':
      return { region: 'us-east-1', size: 'small', min: 1, max: 1, desired: 1, targetCpu: 70, zones: ['a'], ...r };
    case 'user':
      return { policies: [], mfa: false, accessKeys: 0, ...r };
    case 'role':
      return { policies: [], ...r };
    case 'policy':
      return { statements: [], ...r };
    case 'waf':
      return { rateLimit: 1000, ...r };
    case 'budget':
      return { monthlyUsd: 100, alertAt: 80, ...r };
    case 'function':
      return { region: 'us-east-1', memoryMb: 256, invocationsPerMonth: 1000000, avgMs: 200, ...r };
    case 'queue':
      return { region: 'us-east-1', ...r };
  }
  return r;
}

/** Monthly cost estimate per resource and in total. */
export function estimateCost(state: CloudState, egressGb = 50): { lines: Array<{ id: string; name: string; usd: number; detail: string }>; totalUsd: number } {
  const lines: Array<{ id: string; name: string; usd: number; detail: string }> = [];
  const h = PRICES.hoursPerMonth;
  const factor = (region?: string) => regionOf(region)?.priceFactor ?? 1;
  for (const r of state.resources) {
    const f = factor(r.region);
    switch (r.type) {
      case 'vm': {
        const s = sizeOf(r.size);
        if (!s) break;
        const running = r.status !== 'stopped';
        const compute = running ? s.hourlyUsd * h * f : 0;
        const disk = (r.diskGb ?? 20) * PRICES.blockGbMonth;
        lines.push({ id: r.id, name: r.name, usd: compute + disk, detail: `${r.size} ${running ? `${h} h × $${(s.hourlyUsd * f).toFixed(4)}` : 'stopped'} + ${r.diskGb ?? 20} GB disk` });
        break;
      }
      case 'asg': {
        const s = sizeOf(r.size);
        if (!s) break;
        const avg = ((r.min ?? 1) + (r.desired ?? r.min ?? 1)) / 2;
        lines.push({ id: r.id, name: r.name, usd: s.hourlyUsd * h * f * avg + avg * 20 * PRICES.blockGbMonth, detail: `about ${avg} × ${r.size} on average` });
        break;
      }
      case 'bucket':
        lines.push({ id: r.id, name: r.name, usd: (r.storageGb ?? 10) * PRICES.storageGbMonth * f, detail: `${r.storageGb ?? 10} GB object storage` });
        break;
      case 'db': {
        const s = sizeOf(r.size);
        if (!s) break;
        const usd = s.hourlyUsd * PRICES.dbFactor * h * f * (r.multiAz ? PRICES.multiAzFactor : 1) + (r.storageGb ?? 20) * PRICES.blockGbMonth * 1.5;
        lines.push({ id: r.id, name: r.name, usd, detail: `${r.engine} on ${r.size}${r.multiAz ? ', Multi-AZ' : ''}` });
        break;
      }
      case 'lb':
        lines.push({ id: r.id, name: r.name, usd: PRICES.lbHourly * h * f + egressGb * PRICES.lbPerGb, detail: 'load balancer hours + processed data' });
        break;
      case 'waf':
        lines.push({ id: r.id, name: r.name, usd: PRICES.wafHourly * h, detail: 'web application firewall' });
        break;
      case 'function': {
        const gbs = ((r.memoryMb ?? 256) / 1024) * ((r.avgMs ?? 200) / 1000) * (r.invocationsPerMonth ?? 0);
        lines.push({ id: r.id, name: r.name, usd: ((r.invocationsPerMonth ?? 0) / 1e6) * PRICES.functionPerMillion + gbs * PRICES.functionGbSecond, detail: `${((r.invocationsPerMonth ?? 0) / 1e6).toFixed(1)} M invocations, ${r.memoryMb} MB, ${r.avgMs} ms` });
        break;
      }
      case 'queue':
        lines.push({ id: r.id, name: r.name, usd: PRICES.queuePerMillion, detail: 'first million requests' });
        break;
    }
  }
  const egress = egressGb * PRICES.egressPerGb;
  lines.push({ id: 'egress', name: 'Data transfer out', usd: egress, detail: `${egressGb} GB to the internet` });
  return { lines, totalUsd: lines.reduce((s, l) => s + l.usd, 0) };
}

/** Does the security group allow this port from this source? */
export function sgAllows(sg: Resource | undefined, port: number, from: string): boolean {
  if (!sg?.rules) return false;
  return sg.rules.some((r) => (r.port === 'all' || r.port === port) && (r.protocol === 'all' || r.protocol === 'tcp') && (r.source === '0.0.0.0/0' || r.source === from || (from === 'internet' && r.source === '0.0.0.0/0')));
}

/** True when a policy statement grants broad rights. */
export function policyIsWildcard(p: Resource | undefined): boolean {
  return !!p?.statements?.some((s) => s.effect === 'Allow' && s.actions.some((a) => a === '*' || a === '*:*') && s.resources.some((r) => r === '*'));
}

export function userPolicies(state: CloudState, user: Resource): Resource[] {
  return (user.policies ?? []).map((id) => byId(state, id) ?? byName(state, 'policy', id)).filter((p): p is Resource => !!p);
}

/** Security findings a posture scanner would raise. */
export function findings(state: CloudState): Array<{ severity: 'high' | 'medium' | 'low'; resource: string; message: string }> {
  const out: Array<{ severity: 'high' | 'medium' | 'low'; resource: string; message: string }> = [];
  for (const r of state.resources) {
    if (r.type === 'bucket' && r.public) out.push({ severity: 'high', resource: r.name, message: `Bucket ${r.name} is publicly readable.` });
    if (r.type === 'bucket' && !r.encrypted) out.push({ severity: 'medium', resource: r.name, message: `Bucket ${r.name} is not encrypted at rest.` });
    if (r.type === 'sg') {
      for (const rule of r.rules ?? []) {
        if (rule.source === '0.0.0.0/0' && (rule.port === 22 || rule.port === 3389 || rule.port === 'all')) out.push({ severity: 'high', resource: r.name, message: `Security group ${r.name} allows ${rule.port === 'all' ? 'all ports' : `port ${rule.port}`} from the whole internet.` });
        if (rule.source === '0.0.0.0/0' && (rule.port === 3306 || rule.port === 5432)) out.push({ severity: 'high', resource: r.name, message: `Security group ${r.name} exposes the database port ${rule.port} to the internet.` });
      }
    }
    if (r.type === 'db' && r.public) out.push({ severity: 'high', resource: r.name, message: `Database ${r.name} is publicly accessible.` });
    if (r.type === 'db' && !r.encrypted) out.push({ severity: 'medium', resource: r.name, message: `Database ${r.name} is not encrypted at rest.` });
    if (r.type === 'db' && !(r.backupDays && r.backupDays > 0)) out.push({ severity: 'medium', resource: r.name, message: `Database ${r.name} has no automated backups.` });
    if (r.type === 'user') {
      if (!r.mfa) out.push({ severity: 'medium', resource: r.name, message: `User ${r.name} has no MFA.` });
      if (userPolicies(state, r).some(policyIsWildcard)) out.push({ severity: 'high', resource: r.name, message: `User ${r.name} has an administrator (wildcard) policy.` });
      if ((r.accessKeys ?? 0) > 1) out.push({ severity: 'low', resource: r.name, message: `User ${r.name} has ${r.accessKeys} long-lived access keys.` });
    }
    if (r.type === 'vm' && r.publicIp && r.sg) {
      const sg = byId(state, r.sg);
      if (sg && sgAllows(sg, 22, 'internet')) out.push({ severity: 'high', resource: r.name, message: `${r.name} has a public IP and SSH open to the internet.` });
    }
  }
  return out;
}
