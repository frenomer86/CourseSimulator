/**
 * A small Terraform-style HCL reader: resource blocks with attributes, nested blocks and lists,
 * turned into console resources; a plan that diffs them against the account; and apply.
 *
 *   resource "cloud_vm" "web" {
 *     name   = "web-1"
 *     region = "af-west-1"
 *     size   = "small"
 *     security_group = cloud_sg.web.id
 *   }
 */

import { addResource, byName, removeResource, updateResource, withDefaults, type CloudState, type Resource, type ResourceType, type SgRule, type Statement } from './model.js';

export type HclValue = string | number | boolean | HclValue[] | { [k: string]: HclValue } | { ref: string };

export interface HclBlock {
  kind: 'resource' | 'variable' | 'output' | 'provider' | 'terraform' | 'module' | 'data';
  type?: string;
  name: string;
  attrs: Record<string, HclValue>;
  blocks: Array<{ name: string; attrs: Record<string, HclValue>; blocks: HclBlock['blocks'] }>;
  line: number;
}

export class HclError extends Error {
  constructor(message: string, public line: number) {
    super(message);
  }
}

export function parseHcl(src: string): HclBlock[] {
  const lines = src.split('\n');
  let i = 0;
  const err = (m: string) => new HclError(m, i + 1);
  const skipBlank = () => {
    while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#') || lines[i].trim().startsWith('//'))) i++;
  };
  const parseValue = (raw: string): HclValue => {
    const s = raw.trim().replace(/\s*#.*$/, '');
    if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return s.slice(1, -1).replace(/\\"/g, '"');
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (s.startsWith('[') && s.endsWith(']')) {
      const inner = s.slice(1, -1).trim();
      if (!inner) return [];
      return splitTop(inner).map(parseValue);
    }
    if (s.startsWith('{') && s.endsWith('}')) {
      const obj: { [k: string]: HclValue } = {};
      for (const part of splitTop(s.slice(1, -1))) {
        const eq = part.indexOf('=');
        if (eq === -1) throw err(`expected key = value in object: ${part}`);
        obj[part.slice(0, eq).trim()] = parseValue(part.slice(eq + 1));
      }
      return obj;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_*\[\]]+)+$/.test(s)) return { ref: s };
    if (/^var\.[A-Za-z_]\w*$/.test(s)) return { ref: s };
    throw err(`cannot read value: ${raw.trim()}`);
  };
  const parseBody = (): { attrs: Record<string, HclValue>; blocks: HclBlock['blocks'] } => {
    const attrs: Record<string, HclValue> = {};
    const blocks: HclBlock['blocks'] = [];
    for (;;) {
      skipBlank();
      if (i >= lines.length) throw err('unexpected end of file: missing }');
      const line = lines[i].trim();
      if (line === '}') {
        i++;
        return { attrs, blocks };
      }
      const nested = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:"([^"]*)")?\s*\{\s*$/.exec(line);
      if (nested) {
        i++;
        const body = parseBody();
        blocks.push({ name: nested[1] + (nested[2] ? ` "${nested[2]}"` : ''), ...body });
        continue;
      }
      const attr = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!attr) throw err(`expected attribute or block, got: ${line}`);
      let value = attr[2];
      // Multi-line lists / objects.
      if ((value.trim().startsWith('[') && !value.trim().endsWith(']')) || (value.trim().startsWith('{') && !value.trim().endsWith('}'))) {
        const open = value.trim()[0];
        const close = open === '[' ? ']' : '}';
        let depth = 0;
        let acc = '';
        for (;;) {
          for (const ch of lines[i]) {
            if (ch === open) depth++;
            if (ch === close) depth--;
          }
          acc += (acc ? ' ' : '') + (acc ? lines[i].trim() : value.trim());
          i++;
          if (depth <= 0) break;
          if (i >= lines.length) throw err('unterminated list');
        }
        attrs[attr[1]] = parseValue(acc);
        continue;
      }
      attrs[attr[1]] = parseValue(value);
      i++;
    }
  };
  const blocks: HclBlock[] = [];
  for (;;) {
    skipBlank();
    if (i >= lines.length) break;
    const line = lines[i].trim();
    const m = /^(resource|data)\s+"([^"]+)"\s+"([^"]+)"\s*\{\s*$/.exec(line) ?? /^(variable|output|module|provider)\s+"([^"]+)"\s*\{\s*$/.exec(line) ?? /^(terraform)\s*\{\s*$/.exec(line);
    if (!m) throw err(`expected a block such as resource "cloud_vm" "web" {, got: ${line}`);
    const start = i + 1;
    i++;
    const body = parseBody();
    if (m[1] === 'resource' || m[1] === 'data') blocks.push({ kind: m[1], type: m[2], name: m[3], ...body, line: start });
    else if (m[1] === 'terraform') blocks.push({ kind: 'terraform', name: 'terraform', ...body, line: start });
    else blocks.push({ kind: m[1] as HclBlock['kind'], name: m[2], ...body, line: start });
  }
  return blocks;
}

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (const ch of s) {
    if (ch === '"') inStr = !inStr;
    if (!inStr) {
      if (ch === '[' || ch === '{') depth++;
      if (ch === ']' || ch === '}') depth--;
      if (ch === ',' && depth === 0) {
        if (cur.trim()) out.push(cur);
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const TYPE_MAP: Record<string, ResourceType> = { cloud_vm: 'vm', cloud_instance: 'vm', cloud_security_group: 'sg', cloud_sg: 'sg', cloud_bucket: 'bucket', cloud_db: 'db', cloud_database: 'db', cloud_lb: 'lb', cloud_load_balancer: 'lb', cloud_asg: 'asg', cloud_autoscaling_group: 'asg', cloud_user: 'user', cloud_policy: 'policy', cloud_role: 'role', cloud_waf: 'waf', cloud_budget: 'budget', cloud_function: 'function', cloud_queue: 'queue' };

export interface Desired {
  address: string;
  type: ResourceType;
  resource: Omit<Resource, 'id'>;
  line: number;
}

/** Turns parsed blocks into desired resources, resolving references by address (type.name.id → the named resource). */
export function desiredResources(blocks: HclBlock[], variables: Record<string, HclValue> = {}): { desired: Desired[]; errors: string[] } {
  const errors: string[] = [];
  const desired: Desired[] = [];
  const vars: Record<string, HclValue> = { ...variables };
  for (const b of blocks) if (b.kind === 'variable' && vars[b.name] === undefined && b.attrs.default !== undefined) vars[b.name] = b.attrs.default;
  const nameOf = new Map<string, string>();
  for (const b of blocks) if (b.kind === 'resource') nameOf.set(`${b.type}.${b.name}`, String(b.attrs.name ?? b.name));
  const resolve = (v: HclValue): HclValue => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === 'object' && 'ref' in v && typeof (v as { ref: string }).ref === 'string') {
      const ref = (v as { ref: string }).ref;
      if (ref.startsWith('var.')) {
        const val = vars[ref.slice(4)];
        if (val === undefined) errors.push(`${ref} is not defined`);
        return val ?? '';
      }
      const m = /^([a-z_]+)\.([A-Za-z0-9_-]+)\.(id|name)$/.exec(ref);
      if (m && nameOf.has(`${m[1]}.${m[2]}`)) return nameOf.get(`${m[1]}.${m[2]}`)!;
      errors.push(`unknown reference ${ref}`);
      return ref;
    }
    return v;
  };
  for (const b of blocks) {
    if (b.kind !== 'resource') continue;
    const type = TYPE_MAP[b.type ?? ''];
    if (!type) {
      errors.push(`line ${b.line}: unknown resource type "${b.type}"`);
      continue;
    }
    const a: Record<string, HclValue> = {};
    for (const [k, v] of Object.entries(b.attrs)) a[k] = resolve(v);
    const str = (k: string) => (a[k] === undefined ? undefined : String(a[k]));
    const num = (k: string) => (a[k] === undefined ? undefined : Number(a[k]));
    const bool = (k: string) => (a[k] === undefined ? undefined : a[k] === true || a[k] === 'true');
    const list = (k: string) => (Array.isArray(a[k]) ? (a[k] as HclValue[]).map((x) => String(resolve(x))) : undefined);
    const base: Omit<Resource, 'id'> = { type, name: str('name') ?? b.name, region: str('region'), zone: str('zone'), tags: a.tags && typeof a.tags === 'object' && !Array.isArray(a.tags) ? Object.fromEntries(Object.entries(a.tags as Record<string, HclValue>).map(([k, v]) => [k, String(v)])) : undefined };
    let r: Omit<Resource, 'id'> = base;
    if (type === 'vm') r = { ...base, size: str('size'), image: str('image'), sg: str('security_group'), publicIp: bool('public_ip'), diskGb: num('disk_gb') };
    else if (type === 'sg') {
      const rules: SgRule[] = b.blocks
        .filter((x) => x.name === 'ingress')
        .map((x) => {
          const port = x.attrs.port === 'all' || x.attrs.port === '*' ? 'all' : Number(x.attrs.port);
          return { port, protocol: (String(x.attrs.protocol ?? 'tcp') as SgRule['protocol']), source: String(resolve(x.attrs.source ?? x.attrs.cidr ?? '0.0.0.0/0')) };
        });
      r = { ...base, rules };
    } else if (type === 'bucket') r = { ...base, public: bool('public'), encrypted: bool('encrypted'), versioning: bool('versioning'), storageGb: num('storage_gb'), website: bool('website') };
    else if (type === 'db') r = { ...base, engine: str('engine'), size: str('size'), multiAz: bool('multi_az'), encrypted: bool('encrypted'), public: bool('public'), backupDays: num('backup_days'), storageGb: num('storage_gb') };
    else if (type === 'lb') r = { ...base, targets: list('targets'), healthCheck: str('health_check'), listenerPort: num('port') };
    else if (type === 'asg') r = { ...base, size: str('size'), min: num('min'), max: num('max'), desired: num('desired'), targetCpu: num('target_cpu'), zones: list('zones'), lb: str('load_balancer') };
    else if (type === 'user') r = { ...base, policies: list('policies'), mfa: bool('mfa'), accessKeys: num('access_keys') };
    else if (type === 'role') r = { ...base, policies: list('policies') };
    else if (type === 'policy') {
      const statements: Statement[] = b.blocks
        .filter((x) => x.name === 'statement')
        .map((x) => ({ effect: (String(x.attrs.effect ?? 'Allow') as Statement['effect']), actions: (Array.isArray(x.attrs.actions) ? x.attrs.actions : [x.attrs.actions ?? '*']).map(String), resources: (Array.isArray(x.attrs.resources) ? x.attrs.resources : [x.attrs.resources ?? '*']).map(String) }));
      r = { ...base, statements };
    } else if (type === 'waf') r = { ...base, rateLimit: num('rate_limit') };
    else if (type === 'budget') r = { ...base, monthlyUsd: num('monthly_usd'), alertAt: num('alert_at') };
    else if (type === 'function') r = { ...base, memoryMb: num('memory_mb'), invocationsPerMonth: num('invocations_per_month'), avgMs: num('avg_ms') };
    const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) as Omit<Resource, 'id'>;
    desired.push({ address: `${b.type}.${b.name}`, type, resource: withDefaults(clean) as Omit<Resource, 'id'>, line: b.line });
  }
  return { desired, errors };
}

export interface PlanLine {
  action: 'create' | 'update' | 'destroy' | 'no-op';
  address: string;
  name: string;
  type: ResourceType;
  changes: Array<{ key: string; from: unknown; to: unknown }>;
}

const COMPARE_KEYS: Array<Exclude<keyof Resource, 'id' | 'type' | 'name'>> = ['region', 'zone', 'size', 'image', 'sg', 'publicIp', 'diskGb', 'rules', 'public', 'encrypted', 'versioning', 'storageGb', 'website', 'engine', 'multiAz', 'backupDays', 'targets', 'healthCheck', 'listenerPort', 'min', 'max', 'desired', 'targetCpu', 'zones', 'lb', 'policies', 'mfa', 'accessKeys', 'statements', 'rateLimit', 'monthlyUsd', 'alertAt', 'memoryMb', 'invocationsPerMonth', 'avgMs', 'tags'];

/** References written by name (security groups, targets, load balancers, policies) resolved to ids where those resources exist. */
function normaliseRefs(state: CloudState, r: Omit<Resource, 'id'>): Omit<Resource, 'id'> {
  const idOf = (type: ResourceType, nameOrId: string) => byName(state, type, nameOrId)?.id ?? nameOrId;
  return {
    ...r,
    sg: r.sg ? idOf('sg', r.sg) : r.sg,
    targets: r.targets?.map((t) => idOf('vm', t)),
    lb: r.lb ? idOf('lb', r.lb) : r.lb,
    policies: r.policies?.map((p) => idOf('policy', p)),
  };
}

/** Compares desired resources with the account. Resources in the account that the code does not mention are left alone unless `manageAll`. */
export function plan(state: CloudState, desired: Desired[], manageAll = false): PlanLine[] {
  const out: PlanLine[] = [];
  const seen = new Set<string>();
  for (const d of desired) {
    const existing = byName(state, d.type, d.resource.name);
    if (!existing) {
      out.push({ action: 'create', address: d.address, name: d.resource.name, type: d.type, changes: Object.entries(d.resource).filter(([k, v]) => k !== 'type' && v !== undefined).map(([key, to]) => ({ key, from: undefined, to })) });
      continue;
    }
    seen.add(existing.id);
    const changes: PlanLine['changes'] = [];
    const want = normaliseRefs(state, d.resource);
    for (const k of COMPARE_KEYS) {
      const to = want[k];
      if (to === undefined) continue;
      const from = existing[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) changes.push({ key: k, from, to });
    }
    out.push({ action: changes.length ? 'update' : 'no-op', address: d.address, name: d.resource.name, type: d.type, changes });
  }
  if (manageAll) for (const r of state.resources) if (!seen.has(r.id)) out.push({ action: 'destroy', address: `${r.type}.${r.name}`, name: r.name, type: r.type, changes: [] });
  return out;
}

export function apply(state: CloudState, desired: Desired[], manageAll = false): { state: CloudState; applied: PlanLine[] } {
  const lines = plan(state, desired, manageAll);
  let next = state;
  for (const l of lines) {
    if (l.action === 'destroy') {
      const r = byName(next, l.type, l.name);
      if (r) next = removeResource(next, r.id);
    }
  }
  for (const d of desired) {
    const existing = byName(next, d.type, d.resource.name);
    if (!existing) next = addResource(next, d.resource).state;
    else {
      const patch: Partial<Resource> = {};
      for (const k of COMPARE_KEYS) if (d.resource[k] !== undefined) (patch as Record<string, unknown>)[k] = d.resource[k];
      next = updateResource(next, existing.id, patch);
    }
  }
  // References by name: vm.sg and lb.targets and asg.lb may name resources; map names to ids.
  next = { ...next, resources: next.resources.map((r) => ({ ...r, sg: r.sg ? byName(next, 'sg', r.sg)?.id ?? r.sg : r.sg, targets: r.targets?.map((t) => byName(next, 'vm', t)?.id ?? t), lb: r.lb ? byName(next, 'lb', r.lb)?.id ?? r.lb : r.lb, policies: r.policies?.map((p) => byName(next, 'policy', p)?.id ?? p) })) };
  return { state: next, applied: lines.filter((l) => l.action !== 'no-op') };
}

export function formatPlan(lines: PlanLine[]): string {
  const out: string[] = [];
  for (const l of lines) {
    const sym = l.action === 'create' ? '+' : l.action === 'update' ? '~' : l.action === 'destroy' ? '-' : ' ';
    out.push(`${sym} ${l.address} (${l.name})${l.action === 'no-op' ? '  unchanged' : ''}`);
    for (const c of l.changes) out.push(`    ${c.key}: ${c.from === undefined ? '' : JSON.stringify(c.from) + ' -> '}${JSON.stringify(c.to)}`);
  }
  const n = (a: PlanLine['action']) => lines.filter((l) => l.action === a).length;
  out.push('', `Plan: ${n('create')} to add, ${n('update')} to change, ${n('destroy')} to destroy.`);
  return out.join('\n');
}
