/**
 * docker compose: a project is one or more compose files (merged in order, with compose.override.yaml
 * picked up automatically), interpolated from the shell's environment and the project's .env file.
 * Services start in depends_on order; a dependency's condition (service_started, service_healthy,
 * service_completed_successfully) is waited for on the simulated clock, so a database that needs a
 * few seconds to accept connections behaves as it would on a real machine.
 */

import { lookup, readFile } from './fs.js';
import { actor, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { dumpYaml, parseYaml, yList, yMap, yStr, type Yaml } from './yaml.js';
import { createContainer, dockerCmd } from './commands-docker.js';
import { build } from './docker-build.js';
import { pullImage } from './docker-registry.js';
import {
  dockerState,
  findImage,
  hex,
  joinPath,
  networksOf,
  parseBytes,
  parseDuration,
  prepareVolume,
  reconcile,
  removeProcess,
  removeVolumeDir,
  saveDocker,
  shq,
  startContainer,
  statusText,
  stopContainer,
  type DockerContainer,
  type DockerState,
  type HealthConfig,
} from './docker-engine.js';

type Map = Record<string, Yaml>;

const SERVICE_KEYS = new Set(['image', 'build', 'command', 'entrypoint', 'environment', 'env_file', 'ports', 'expose', 'volumes', 'depends_on', 'healthcheck', 'restart', 'networks', 'container_name', 'user', 'working_dir', 'labels', 'deploy', 'mem_limit', 'cpus', 'profiles', 'read_only', 'tmpfs', 'secrets', 'configs', 'hostname', 'init', 'stop_grace_period', 'logging', 'extra_hosts', 'pull_policy', 'platform', 'stdin_open', 'tty', 'cap_drop', 'cap_add', 'security_opt', 'ulimits', 'develop', 'scale', 'network_mode']);
const TOP_KEYS = new Set(['version', 'name', 'services', 'volumes', 'networks', 'secrets', 'configs', 'include']);
const LIST_MERGE = new Set(['ports', 'expose', 'volumes', 'env_file', 'secrets', 'dns', 'tmpfs', 'extra_hosts', 'cap_add', 'cap_drop', 'profiles']);

/** Merges a later compose file onto an earlier one, the way compose does. */
function merge(a: Yaml | undefined, b: Yaml, key = ''): Yaml {
  if (a === undefined) return b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (!LIST_MERGE.has(key)) return b;
    const target = (x: Yaml) => (typeof x === 'string' ? (key === 'volumes' || key === 'ports' ? x.split(':').slice(-1)[0].replace(/:ro$/, '') : x) : JSON.stringify(x));
    const out = [...a];
    for (const x of b) {
      const i = out.findIndex((y) => target(y) === target(x));
      if (i >= 0) out[i] = x;
      else out.push(x);
    }
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Map = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = key === 'environment' || key === 'labels' ? v : merge(a[k], v, k);
    return out;
  }
  return b;
}

/** Replaces ${VAR}, ${VAR:-default}, ${VAR:?error} and $VAR in every string of a document. */
function interpolate(doc: Yaml, vars: Record<string, string | undefined>, warn: (v: string) => void, fail: (msg: string) => void): Yaml {
  const one = (s: string): string =>
    s.replace(/\$\$|\$\{(\w+)(?:(:?)([-?+])((?:[^}\\]|\\.)*))?\}|\$(\w+)/g, (m, name, colon, op, word, bare) => {
      if (m === '$$') return '$';
      const n = name ?? bare;
      const v = vars[n];
      const unset = v === undefined || (colon && v === '');
      if (op === '-') return unset ? one(word) : v!;
      if (op === '?') {
        if (unset) fail(`required variable ${n} is missing a value: ${word || `${n} is required`}`);
        return v ?? '';
      }
      if (op === '+') return unset ? '' : one(word);
      if (v === undefined) {
        warn(n);
        return '';
      }
      return v;
    });
  const walk = (y: Yaml): Yaml => (typeof y === 'string' ? one(y) : Array.isArray(y) ? y.map(walk) : Object.fromEntries(Object.entries(y).map(([k, v]) => [k, walk(v)])));
  return walk(doc);
}

function dotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(t);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

interface Project {
  name: string;
  dir: string;
  files: string[];
  doc: Map;
  services: Record<string, Map>;
  order: string[];
}

function loadProject(ctx: Ctx, args: { files: string[]; project?: string; envFile?: string; profiles: string[] }, io: IO): Project | number {
  const dir0 = ctx.sys.cwd;
  const read = (p: string) => {
    try {
      return readFile(ctx.sys.fs, p, actor(ctx));
    } catch {
      return null;
    }
  };
  let files: string[];
  if (args.files.length) files = args.files.map((f) => abs(ctx, f));
  else {
    const main = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].map((n) => joinPath(dir0, n)).find((p) => lookup(ctx.sys.fs, p, actor(ctx)));
    if (!main) {
      io.err('no configuration file provided: not found\n');
      return 1;
    }
    files = [main];
    const override = ['compose.override.yaml', 'compose.override.yml', 'docker-compose.override.yml', 'docker-compose.override.yaml'].map((n) => joinPath(dir0, n)).find((p) => lookup(ctx.sys.fs, p, actor(ctx)));
    if (override) files.push(override);
  }
  const dir = files[0].slice(0, files[0].lastIndexOf('/')) || '/';
  const envText = read(args.envFile ? abs(ctx, args.envFile) : joinPath(dir, '.env'));
  if (args.envFile && envText === null) {
    io.err(`couldn't find env file: ${abs(ctx, args.envFile)}\n`);
    return 1;
  }
  const shellEnv: Record<string, string> = {};
  for (const k of ctx.exported) if (ctx.vars[k] !== undefined) shellEnv[k] = ctx.vars[k];
  const vars = { ...dotenv(envText ?? ''), ...shellEnv };
  let doc: Yaml = {};
  const warned = new Set<string>();
  let failed: string | null = null;
  for (const f of files) {
    const text = read(f);
    if (text === null) {
      io.err(`open ${f}: no such file or directory\n`);
      return 1;
    }
    let part: Yaml;
    try {
      part = parseYaml(text);
    } catch (e) {
      io.err(`yaml: ${(e as Error).message}\n`);
      return 15;
    }
    part = interpolate(part, vars, (v) => {
      if (!warned.has(v)) io.err(`WARN[0000] The "${v}" variable is not set. Defaulting to a blank string.\n`);
      warned.add(v);
    }, (msg) => (failed ??= msg));
    doc = merge(doc, part);
  }
  if (failed) {
    io.err(`error while interpolating services: ${failed}\n`);
    return 1;
  }
  const m = yMap(doc);
  for (const k of Object.keys(m)) {
    if (!TOP_KEYS.has(k) && !k.startsWith('x-')) {
      io.err(`validating ${files[0]}: (root) additional properties '${k}' not allowed\n`);
      return 15;
    }
  }
  if (m.version !== undefined) io.err(`WARN[0000] ${files[0]}: the attribute \`version\` is obsolete, it will be ignored, please remove it to avoid potential confusion\n`);
  const services = yMap(m.services) as Record<string, Map>;
  if (!Object.keys(services).length) {
    io.err(`${files[0]}: no service has been defined... services must be a mapping\n`);
    return 15;
  }
  for (const [n, s] of Object.entries(services)) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      io.err(`services.${n} must be a mapping\n`);
      return 15;
    }
    for (const k of Object.keys(s)) {
      if (!SERVICE_KEYS.has(k) && !k.startsWith('x-')) {
        io.err(`validating ${files[0]}: services.${n} additional properties '${k}' not allowed\n`);
        return 15;
      }
    }
    if (s.image === undefined && s.build === undefined) {
      io.err(`service "${n}" has neither an image nor a build context specified: invalid compose project\n`);
      return 15;
    }
  }
  const name = (args.project ?? (typeof m.name === 'string' ? m.name : undefined) ?? dir.split('/').pop() ?? 'project').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  // Profiles: services with profiles only run when one is active.
  const active = Object.fromEntries(Object.entries(services).filter(([, s]) => !s.profiles || yList(s.profiles).some((p) => args.profiles.includes(yStr(p)))));
  const order: string[] = [];
  const visit = (n: string, seen: string[]) => {
    if (order.includes(n)) return;
    if (seen.includes(n)) throw new Error(`dependency cycle detected: ${[...seen, n].join(' -> ')}`);
    for (const d of Object.keys(depsOf(services[n]))) {
      if (!services[d]) throw new Error(`service "${n}" depends on undefined service "${d}": invalid compose project`);
      visit(d, [...seen, n]);
    }
    order.push(n);
  };
  try {
    for (const n of Object.keys(active)) visit(n, []);
  } catch (e) {
    io.err((e as Error).message + '\n');
    return 15;
  }
  for (const [n, s] of Object.entries(services)) {
    for (const v of yList(s.volumes)) {
      if (typeof v !== 'string') continue;
      const src = v.split(':')[0];
      if (v.includes(':') && !/^[./~$]/.test(src) && !Object.keys(yMap(m.volumes)).includes(src)) {
        io.err(`service "${n}" refers to undefined volume ${src}: invalid compose project\n`);
        return 15;
      }
    }
    for (const sec of yList(s.secrets)) {
      const sn = typeof sec === 'string' ? sec : yStr(yMap(sec).source);
      if (!yMap(m.secrets)[sn]) {
        io.err(`service "${n}" refers to undefined secret ${sn}: invalid compose project\n`);
        return 15;
      }
    }
    for (const net of Array.isArray(s.networks) ? s.networks : Object.keys(yMap(s.networks))) {
      const nn = yStr(net);
      if (nn !== 'default' && !Object.keys(yMap(m.networks)).includes(nn)) {
        io.err(`service "${n}" refers to undefined network ${nn}: invalid compose project\n`);
        return 15;
      }
    }
  }
  return { name, dir, files, doc: m, services, order };
}

function depsOf(s: Map): Record<string, string> {
  const d = s.depends_on;
  if (Array.isArray(d)) return Object.fromEntries(d.map((x) => [yStr(x), 'service_started']));
  return Object.fromEntries(Object.entries(yMap(d)).map(([k, v]) => [k, yStr(yMap(v).condition) || 'service_started']));
}

const cname = (p: Project, svc: string) => yStr(p.services[svc].container_name) || `${p.name}-${svc}-1`;

function health(s: Map): HealthConfig | null | undefined {
  if (s.healthcheck === undefined) return undefined;
  const h = yMap(s.healthcheck);
  if (yStr(h.disable) === 'true') return null;
  const t = h.test;
  const test = Array.isArray(t) ? t.map(yStr) : ['CMD-SHELL', yStr(t)];
  return { test, interval: parseDuration(yStr(h.interval), 30000), timeout: parseDuration(yStr(h.timeout), 30000), retries: Number(yStr(h.retries) || 3), startPeriod: parseDuration(yStr(h.start_period), 0) };
}

function envList(ctx: Ctx, p: Project, s: Map, io: IO): string[] | null {
  const out: string[] = [];
  for (const f of yList(s.env_file)) {
    const path = joinPath(p.dir, typeof f === 'string' ? f : yStr(yMap(f).path));
    let text: string;
    try {
      text = readFile(ctx.sys.fs, path, actor(ctx));
    } catch {
      if (typeof f !== 'string' && yStr(yMap(f).required) === 'false') continue;
      io.err(`env file ${path} not found: stat ${path}: no such file or directory\n`);
      return null;
    }
    for (const [k, v] of Object.entries(dotenv(text))) out.push(`${k}=${v}`);
  }
  const e = s.environment;
  if (Array.isArray(e)) out.push(...e.map(yStr));
  else for (const [k, v] of Object.entries(yMap(e))) out.push(`${k}=${yStr(v)}`);
  return out;
}

/** The docker run arguments for a service, and the settings docker run has no flag for. */
function runArgs(ctx: Ctx, p: Project, svc: string, io: IO, name = cname(p, svc), image?: string): string[] | null {
  const s = p.services[svc];
  const a = ['--name', name];
  const nets = Array.isArray(s.networks) ? s.networks.map(yStr) : Object.keys(yMap(s.networks));
  const net = (n: string) => (n === 'default' ? `${p.name}_default` : yStr(yMap(yMap(p.doc.networks)[n]).name) || (yStr(yMap(yMap(p.doc.networks)[n]).external) === 'true' ? n : `${p.name}_${n}`));
  a.push('--network', net(nets[0] ?? 'default'));
  for (const port of yList(s.ports)) {
    if (typeof port === 'string') a.push('-p', port);
    else {
      const m = yMap(port);
      a.push('-p', `${yStr(m.published)}:${yStr(m.target)}`);
    }
  }
  const env = envList(ctx, p, s, io);
  if (!env) return null;
  for (const e of env) a.push('-e', e);
  for (const v of yList(s.volumes)) {
    if (typeof v === 'string') {
      const [src, ...tgt] = v.split(':');
      if (!tgt.length) a.push('-v', src);
      else {
        const named = !/^[./~$]/.test(src);
        const vdef = yMap(yMap(p.doc.volumes)[src]);
        const vname = yStr(vdef.name) || (yStr(vdef.external) === 'true' ? src : `${p.name}_${src}`);
        a.push('-v', `${named ? vname : src.startsWith('/') ? src : joinPath(p.dir, src)}:${tgt.join(':')}`);
      }
    } else {
      const m = yMap(v);
      const type = yStr(m.type) || 'volume';
      const src = yStr(m.source);
      const source = type === 'bind' ? (src.startsWith('/') ? src : joinPath(p.dir, src)) : `${p.name}_${src}`;
      a.push('--mount', `type=${type},source=${source},target=${yStr(m.target)}${yStr(m.read_only) === 'true' ? ',readonly' : ''}`);
    }
  }
  for (const sec of yList(s.secrets)) {
    const sn = typeof sec === 'string' ? sec : yStr(yMap(sec).source);
    const target = typeof sec === 'string' ? `/run/secrets/${sn}` : yStr(yMap(sec).target) ? (yStr(yMap(sec).target).startsWith('/') ? yStr(yMap(sec).target) : `/run/secrets/${yStr(yMap(sec).target)}`) : `/run/secrets/${sn}`;
    const def = yMap(yMap(p.doc.secrets)[sn]);
    if (def.file !== undefined) a.push('-v', `${joinPath(p.dir, yStr(def.file))}:${target}:ro`);
  }
  for (const t of yList(s.tmpfs)) a.push('--tmpfs', yStr(t));
  if (typeof s.restart === 'string') a.push('--restart', s.restart);
  if (typeof s.user === 'string') a.push('-u', s.user);
  if (typeof s.working_dir === 'string') a.push('-w', s.working_dir);
  const limits = yMap(yMap(yMap(s.deploy).resources).limits);
  const mem = yStr(limits.memory) || yStr(s.mem_limit);
  if (mem) a.push('--memory', mem.replace(/([kmg])$/i, '$1b').replace(/b+$/i, 'b'));
  const cpus = yStr(limits.cpus) || yStr(s.cpus);
  if (cpus) a.push('--cpus', cpus);
  if (yStr(s.read_only) === 'true') a.push('--read-only');
  for (const [k, v] of Object.entries(yMap(s.labels))) a.push('--label', `${k}=${yStr(v)}`);
  if (Array.isArray(s.labels)) for (const l of s.labels) a.push('--label', yStr(l));
  if (s.entrypoint !== undefined) a.push('--entrypoint', Array.isArray(s.entrypoint) ? s.entrypoint.map(yStr).map(shq).join(' ') : yStr(s.entrypoint));
  a.push(image ?? imageOf(p, svc));
  if (typeof s.command === 'string') a.push(...(s.command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["'](.*)["']$/s, '$1')));
  else if (Array.isArray(s.command)) a.push(...s.command.map(yStr));
  return a;
}

const imageOf = (p: Project, svc: string) => yStr(p.services[svc].image) || `${p.name}-${svc}`;

function configHash(p: Project, svc: string): string {
  return hex(JSON.stringify(p.services[svc]) + JSON.stringify(p.doc.secrets ?? ''), 16);
}

function ensureNetworks(ctx: Ctx, st: DockerState, p: Project, io: IO): void {
  const wanted = new Set<string>();
  for (const svc of p.order) {
    const s = p.services[svc];
    const nets = Array.isArray(s.networks) ? s.networks.map(yStr) : Object.keys(yMap(s.networks));
    for (const n of nets.length ? nets : ['default']) wanted.add(n);
  }
  for (const n of wanted) {
    const def = yMap(yMap(p.doc.networks)[n]);
    const full = n === 'default' ? `${p.name}_default` : yStr(def.name) || (yStr(def.external) === 'true' ? n : `${p.name}_${n}`);
    if (st.networks.includes(full)) continue;
    if (yStr(def.external) === 'true') continue;
    st.networks.push(full);
    io.out(` ✔ Network ${full}  Created\n`);
  }
  for (const [v, defY] of Object.entries(yMap(p.doc.volumes))) {
    const def = yMap(defY);
    if (yStr(def.external) === 'true') continue;
    const full = yStr(def.name) || `${p.name}_${v}`;
    if (st.volumes.includes(full)) continue;
    prepareVolume(ctx, st, full);
    io.out(` ✔ Volume "${full}"  Created\n`);
  }
}

/** Builds a service's image when it has a build section and the image is missing (or --build). */
function buildService(ctx: Ctx, st: DockerState, p: Project, svc: string, force: boolean, io: IO): number {
  const s = p.services[svc];
  if (s.build === undefined) return 0;
  const image = imageOf(p, svc);
  if (!force && findImage(st, image)) return 0;
  const b = s.build;
  const bm = yMap(b);
  const context = typeof b === 'string' ? b : yStr(bm.context) || '.';
  const ctxDir = context.startsWith('/') ? context : joinPath(p.dir, context);
  const dockerfile = joinPath(ctxDir, yStr(bm.dockerfile) || 'Dockerfile');
  const buildArgs: Record<string, string> = Array.isArray(bm.args) ? Object.fromEntries(bm.args.map((x) => yStr(x).split('=')).map(([k, ...v]) => [k, v.join('=')])) : Object.fromEntries(Object.entries(yMap(bm.args)).map(([k, v]) => [k, yStr(v)]));
  io.out(`[+] Building 1.2s (${svc})\n`);
  const code = build(ctx, st, { tags: [image], contextDir: ctxDir, dockerfile, buildArgs, target: yStr(bm.target) || undefined, noCache: false, quiet: false, labels: { 'com.docker.compose.project': p.name, 'com.docker.compose.service': svc } }, { stdin: '', out: () => {}, err: io.err });
  if (code) {
    io.err(`failed to solve: building ${svc} failed\n`);
    return code;
  }
  io.out(` ✔ Service ${svc}  Built\n`);
  return 0;
}

function serviceContainer(st: DockerState, p: Project, svc: string): DockerContainer | undefined {
  return st.containers.find((c) => c.name === cname(p, svc));
}

/** Creates (or recreates) and starts one service's container. */
function upService(ctx: Ctx, st: DockerState, p: Project, svc: string, opts: { forceRecreate: boolean; noStart?: boolean }, io: IO): number {
  const s = p.services[svc];
  const hash = configHash(p, svc);
  const existing = serviceContainer(st, p, svc);
  const img = findImage(st, imageOf(p, svc));
  const sameImage = existing && img && (existing.image === `${img.repo}:${img.tag}`) && existing.labels?.['com.docker.compose.image'] === img.id;
  if (existing && existing.labels?.['com.docker.compose.config-hash'] === hash && sameImage && !opts.forceRecreate) {
    if (existing.status === 'running') {
      io.out(` ✔ Container ${existing.name}  Running\n`);
      return 0;
    }
    const r = startContainer(ctx, st, existing);
    io.out(` ✔ Container ${existing.name}  Started\n`);
    return r.error ? r.code : 0;
  }
  let recreated = false;
  if (existing) {
    stopContainer(ctx, existing, 0);
    st.containers = st.containers.filter((c) => c !== existing);
    recreated = true;
  }
  if (!img && s.image !== undefined) {
    const pulled = pullImage(ctx, st, imageOf(p, svc), { stdin: '', out: () => {}, err: io.err }, true);
    if (!pulled) return 18;
    io.out(` ✔ ${svc} Pulled\n`);
  }
  const args = runArgs(ctx, p, svc, io);
  if (!args) return 1;
  const r = createContainer(ctx, st, args, { stdin: '', out: () => {}, err: io.err });
  if (!r.c) return r.code;
  const c = r.c;
  const nets = Array.isArray(s.networks) ? s.networks.map(yStr) : Object.keys(yMap(s.networks));
  const net = (n: string) => (n === 'default' ? `${p.name}_default` : yStr(yMap(yMap(p.doc.networks)[n]).name) || `${p.name}_${n}`);
  c.networks = nets.slice(1).map(net);
  const aliases: string[] = [];
  for (const [, v] of Object.entries(yMap(s.networks))) aliases.push(...yList(yMap(v).aliases).map(yStr));
  if (aliases.length) c.aliases = aliases;
  c.labels = { ...(c.labels ?? {}), 'com.docker.compose.project': p.name, 'com.docker.compose.service': svc, 'com.docker.compose.config-hash': hash, 'com.docker.compose.image': findImage(st, imageOf(p, svc))?.id ?? '', 'com.docker.compose.project.working_dir': p.dir, 'com.docker.compose.oneoff': 'False' };
  const h = health(s);
  if (h !== undefined) c.healthcheck = h;
  if (opts.noStart) {
    io.out(` ✔ Container ${c.name}  Created\n`);
    return 0;
  }
  const clash = c.ports.find((port) => st.containers.some((k) => k !== c && k.status === 'running' && k.ports.some((q) => q.host === port.host)) || Object.values(ctx.sys.services).some((x) => x.active && x.port === port.host));
  if (clash) {
    io.err(`Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${clash.host} failed: port is already allocated\n`);
    return 1;
  }
  const res = startContainer(ctx, st, c);
  if (res.error) {
    io.err(`Error response from daemon: ${res.error}\n`);
    return res.code;
  }
  io.out(` ✔ Container ${c.name}  ${recreated ? 'Recreated' : 'Started'}\n`);
  return 0;
}

/** Waits (on the simulated clock) until dependency d of a service meets its condition. */
function waitFor(ctx: Ctx, st: DockerState, p: Project, dep: string, condition: string, io: IO): number {
  const c = serviceContainer(st, p, dep);
  if (!c) {
    io.err(`dependency failed to start: container for service "${dep}" not found\n`);
    return 1;
  }
  if (condition === 'service_started') return 0;
  if (condition === 'service_healthy' && !c.healthcheck && !findImage(st, c.image)?.health) {
    io.err(`dependency failed to start: container ${c.name} has no healthcheck configured\n`);
    return 1;
  }
  const deadline = ctx.sys.now + 120000;
  for (;;) {
    reconcile(ctx, st);
    if (condition === 'service_completed_successfully') {
      if (c.status === 'exited') {
        if (c.exitCode === 0) {
          io.out(` ✔ Container ${c.name}  Exited\n`);
          return 0;
        }
        io.err(`service "${dep}" didn't complete successfully: exit ${c.exitCode}\n`);
        return 1;
      }
    } else {
      if (c.status !== 'running') {
        io.err(`dependency failed to start: container ${c.name} exited (${c.exitCode})\n`);
        return 1;
      }
      if (c.health?.status === 'healthy') {
        io.out(` ✔ Container ${c.name}  Healthy\n`);
        return 0;
      }
      if (c.health?.status === 'unhealthy') {
        io.err(`dependency failed to start: container ${c.name} is unhealthy\n`);
        return 1;
      }
    }
    if (ctx.sys.now >= deadline) {
      io.err(`dependency failed to start: timed out waiting for ${c.name}\n`);
      return 1;
    }
    const step = Math.min(c.healthcheck?.interval ?? findImage(st, c.image)?.health?.interval ?? 1000, 2000);
    ctx.sys.now += Math.max(step, 250);
  }
}

function psTable(ctx: Ctx, st: DockerState, p: Project, all: boolean, io: IO, format?: string, quiet = false): number {
  const cs = st.containers.filter((c) => c.labels?.['com.docker.compose.project'] === p.name && (all || c.status === 'running'));
  if (quiet) {
    for (const c of cs) io.out(c.id + '\n');
    return 0;
  }
  const rows = cs.map((c) => {
    const img = findImage(st, c.image);
    const cmd = img ? [c.entrypoint ?? img.entrypoint ?? '', c.command ?? img.cmd].filter(Boolean).join(' ') : '';
    return { Name: c.name, Image: c.image, Command: `"${cmd.length > 20 ? cmd.slice(0, 19) + '…' : cmd}"`, Service: c.labels?.['com.docker.compose.service'] ?? '', RunningFor: 'About a minute ago', Status: statusText(ctx, c), Ports: c.ports.map((q) => `${q.ip ?? '0.0.0.0'}:${q.host}->${q.container}/tcp`).join(', '), State: c.status };
  });
  if (format === 'json') {
    for (const r of rows) io.out(JSON.stringify(r) + '\n');
    return 0;
  }
  const heads: Array<[keyof (typeof rows)[number], string]> = [['Name', 'NAME'], ['Image', 'IMAGE'], ['Command', 'COMMAND'], ['Service', 'SERVICE'], ['RunningFor', 'CREATED'], ['Status', 'STATUS'], ['Ports', 'PORTS']];
  const w = heads.map(([k, h]) => Math.max(h.length, ...rows.map((r) => String(r[k]).length)));
  io.out(heads.map(([, h], i) => (i < heads.length - 1 ? h.padEnd(w[i] + 3) : h)).join('') + '\n');
  for (const r of rows) io.out(heads.map(([k], i) => (i < heads.length - 1 ? String(r[k]).padEnd(w[i] + 3) : String(r[k]))).join('').trimEnd() + '\n');
  return 0;
}

export function compose(args: string[], io: IO, ctx: Ctx): number {
  const files: string[] = [];
  const profiles: string[] = [];
  let project: string | undefined;
  let envFile: string | undefined;
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    if (a === '-f' || a === '--file') files.push(args[++i]);
    else if (a.startsWith('--file=')) files.push(a.slice(7));
    else if (a === '-p' || a === '--project-name') project = args[++i];
    else if (a === '--env-file') envFile = args[++i];
    else if (a === '--profile') profiles.push(args[++i]);
    else if (a === '--project-directory') i++;
  }
  const [verb, ...rest] = args.slice(i);
  if (!verb || verb === 'help' || verb === '--help') {
    io.out('Usage:  docker compose [OPTIONS] COMMAND\n\nCommands: build, config, down, exec, images, logs, ls, ps, pull, push, restart, rm, run, start, stop, top, up\n');
    return 0;
  }
  if (verb === 'version') {
    io.out('Docker Compose version v2.29.7\n');
    return 0;
  }
  if (verb === 'ls') {
    const st = dockerState(ctx);
    const projects = [...new Set(st.containers.map((c) => c.labels?.['com.docker.compose.project']).filter(Boolean))] as string[];
    io.out('NAME                STATUS              CONFIG FILES\n');
    for (const pr of projects) {
      const cs = st.containers.filter((c) => c.labels?.['com.docker.compose.project'] === pr);
      io.out(`${pr.padEnd(20)}${`running(${cs.filter((c) => c.status === 'running').length})`.padEnd(20)}${cs[0].labels?.['com.docker.compose.project.working_dir'] ?? ''}/compose.yaml\n`);
    }
    return 0;
  }
  const p = loadProject(ctx, { files, project, envFile, profiles }, io);
  if (typeof p === 'number') return p;
  const st = dockerState(ctx);
  const done = (code = 0) => {
    saveDocker(ctx, st);
    return code;
  };
  const named = rest.filter((r) => !r.startsWith('-'));
  const targets = (list: string[]) => {
    const bad = list.find((n) => !p.services[n]);
    if (bad) {
      io.err(`no such service: ${bad}\n`);
      return null;
    }
    return list.length ? list : p.order;
  };
  switch (verb) {
    case 'config': {
      if (rest.includes('--services')) {
        io.out(Object.keys(p.services).join('\n') + '\n');
        return 0;
      }
      if (rest.includes('--volumes')) {
        io.out(Object.keys(yMap(p.doc.volumes)).join('\n') + (Object.keys(yMap(p.doc.volumes)).length ? '\n' : ''));
        return 0;
      }
      if (rest.includes('-q') || rest.includes('--quiet')) return 0;
      const out: Map = { name: p.name, services: Object.fromEntries(Object.keys(p.services).sort().map((n) => [n, p.services[n]])) };
      for (const k of ['networks', 'volumes', 'secrets']) if (p.doc[k] !== undefined) out[k] = p.doc[k];
      if (!out.networks) out.networks = { default: { name: `${p.name}_default` } };
      io.out(dumpYaml(out));
      return 0;
    }
    case 'build': {
      const list = targets(named);
      if (!list) return 1;
      for (const svc of list) {
        if (p.services[svc].build === undefined) continue;
        const code = buildService(ctx, st, p, svc, true, io);
        if (code) return done(code);
      }
      return done();
    }
    case 'pull': {
      for (const svc of targets(named) ?? []) {
        if (p.services[svc].image === undefined) continue;
        if (!pullImage(ctx, st, imageOf(p, svc), { stdin: '', out: () => {}, err: io.err }, true)) return done(18);
        io.out(` ✔ ${svc} Pulled\n`);
      }
      return done();
    }
    case 'push': {
      for (const svc of targets(named) ?? []) {
        if (!p.services[svc].image) continue;
        saveDocker(ctx, st);
        const code = dockerCmd(['push', imageOf(p, svc)], io, ctx);
        if (code) return code;
      }
      return 0;
    }
    case 'up':
    case 'create': {
      const list = targets(named);
      if (!list) return 1;
      const detach = rest.includes('-d') || rest.includes('--detach') || verb === 'create';
      const want = new Set<string>();
      const addDeps = (n: string) => {
        if (want.has(n)) return;
        want.add(n);
        if (!rest.includes('--no-deps')) for (const d of Object.keys(depsOf(p.services[n]))) addDeps(d);
      };
      list.forEach(addDeps);
      const order = p.order.filter((n) => want.has(n));
      for (const svc of order) {
        const code = buildService(ctx, st, p, svc, rest.includes('--build'), io);
        if (code) return done(code);
      }
      io.out(`[+] Running ${order.length}/${order.length}\n`);
      ensureNetworks(ctx, st, p, io);
      for (const svc of order) {
        for (const [d, cond] of Object.entries(depsOf(p.services[svc]))) {
          if (!want.has(d)) continue;
          const code = waitFor(ctx, st, p, d, cond, io);
          if (code) return done(code);
        }
        const code = upService(ctx, st, p, svc, { forceRecreate: rest.includes('--force-recreate'), noStart: verb === 'create' }, io);
        if (code) return done(code);
      }
      // Containers from services no longer in the file.
      const orphans = st.containers.filter((c) => c.labels?.['com.docker.compose.project'] === p.name && c.labels['com.docker.compose.oneoff'] !== 'True' && !p.services[c.labels['com.docker.compose.service'] ?? '']);
      if (orphans.length) {
        if (rest.includes('--remove-orphans')) {
          for (const c of orphans) {
            stopContainer(ctx, c, 0);
            st.containers = st.containers.filter((k) => k !== c);
            io.out(` ✔ Container ${c.name}  Removed\n`);
          }
        } else io.err(`WARN[0000] Found orphan containers ([${orphans.map((c) => c.name).join(' ')}]) for this project. If you removed or renamed this service in your compose file, you can run this command with the --remove-orphans flag to clean it up.\n`);
      }
      if (rest.includes('--wait')) {
        for (const svc of order) {
          const c = serviceContainer(st, p, svc);
          if (!c || c.status !== 'running') {
            io.err(`container ${cname(p, svc)} exited (${c?.exitCode ?? 1})\n`);
            return done(1);
          }
          if (c.healthcheck || findImage(st, c.image)?.health) {
            const code = waitFor(ctx, st, p, svc, 'service_healthy', io);
            if (code) return done(code);
          }
        }
      }
      if (!detach) {
        for (const svc of order) for (const l of serviceContainer(st, p, svc)?.logs ?? []) io.out(`${svc}-1  | ${l}\n`);
        io.out('(docker compose up without -d stays attached to the logs; the simulator gives you your prompt back. Use -d.)\n');
      }
      return done();
    }
    case 'ps':
      return psTable(ctx, st, p, rest.includes('-a') || rest.includes('--all'), io, rest.includes('--format') ? rest[rest.indexOf('--format') + 1] : undefined, rest.includes('-q'));
    case 'logs': {
      const list = targets(named);
      if (!list) return 1;
      const tailAt = rest.indexOf('--tail');
      const tail = tailAt >= 0 ? Number(rest[tailAt + 1]) : 0;
      const width = Math.max(...list.map((n) => `${n}-1`.length));
      for (const svc of list) {
        const c = serviceContainer(st, p, svc);
        const ls = c?.logs ?? [];
        for (const l of tail ? ls.slice(-tail) : ls) io.out(`${(rest.includes('--no-log-prefix') ? '' : `${`${svc}-1`.padEnd(width)}  | `)}${l}\n`);
      }
      return 0;
    }
    case 'exec': {
      const flags: string[] = [];
      let k = 0;
      while (rest[k]?.startsWith('-')) {
        const a = rest[k];
        if (['-u', '--user', '-w', '--workdir', '-e', '--env'].includes(a)) flags.push(a, rest[++k]);
        else if (a !== '-T' && a !== '--no-TTY' && a !== '-it') flags.push(a);
        k++;
      }
      const svc = rest[k];
      if (!svc || !p.services[svc]) {
        io.err(svc ? `service "${svc}" is not running\n` : '"docker compose exec" requires at least 2 arguments.\n');
        return 1;
      }
      const c = serviceContainer(st, p, svc);
      if (!c || c.status !== 'running') {
        io.err(`service "${svc}" is not running\n`);
        return 1;
      }
      saveDocker(ctx, st);
      return dockerCmd(['exec', ...flags, c.name, ...rest.slice(k + 1)], io, ctx);
    }
    case 'run': {
      let k = 0;
      const extra: string[] = [];
      let rm = false;
      let noDeps = false;
      while (rest[k]?.startsWith('-')) {
        const a = rest[k];
        if (a === '--rm') rm = true;
        else if (a === '--no-deps') noDeps = true;
        else if (['-e', '--env', '-u', '--user', '-w', '--workdir', '--entrypoint'].includes(a)) extra.push(a, rest[++k]);
        k++;
      }
      const svc = rest[k];
      if (!svc || !p.services[svc]) {
        io.err(`no such service: ${svc ?? ''}\n`);
        return 1;
      }
      if (!noDeps) {
        ensureNetworks(ctx, st, p, io);
        for (const [d, cond] of Object.entries(depsOf(p.services[svc]))) {
          if (!serviceContainer(st, p, d) || serviceContainer(st, p, d)!.status !== 'running') {
            const code = upService(ctx, st, p, d, { forceRecreate: false }, io);
            if (code) return done(code);
          }
          const code = waitFor(ctx, st, p, d, cond, io);
          if (code) return done(code);
        }
      } else ensureNetworks(ctx, st, p, { stdin: '', out: () => {}, err: io.err });
      const code0 = buildService(ctx, st, p, svc, false, io);
      if (code0) return done(code0);
      const name = `${p.name}-${svc}-run-${hex(String(ctx.sys.now), 12)}`;
      const base = runArgs(ctx, p, svc, io, name);
      if (!base) return done(1);
      const imgAt = base.lastIndexOf(imageOf(p, svc));
      const cmd = rest.slice(k + 1);
      const args2 = [...base.slice(0, imgAt).filter((_, idx, arr) => !(arr[idx - 1] === '-p' || base[idx] === '-p')), ...extra, imageOf(p, svc), ...(cmd.length ? cmd : base.slice(imgAt + 1))];
      const r = createContainer(ctx, st, args2, { stdin: '', out: () => {}, err: io.err });
      if (!r.c) return done(r.code);
      r.c.labels = { ...(r.c.labels ?? {}), 'com.docker.compose.project': p.name, 'com.docker.compose.service': svc, 'com.docker.compose.oneoff': 'True' };
      const res = startContainer(ctx, st, r.c, io);
      if (res.error) {
        io.err(`Error response from daemon: ${res.error}\n`);
        return done(res.code);
      }
      if (rm && r.c.status !== 'running') {
        removeProcess(ctx, r.c);
        st.containers = st.containers.filter((c) => c !== r.c);
      }
      return done(r.c.status === 'running' ? 0 : r.c.exitCode);
    }
    case 'restart':
    case 'start':
    case 'stop': {
      const list = targets(named);
      if (!list) return 1;
      for (const svc of verb === 'stop' ? [...list].reverse() : list) {
        const c = serviceContainer(st, p, svc);
        if (!c) continue;
        if (verb !== 'start') {
          stopContainer(ctx, c, 0);
          if (verb === 'stop') io.out(` ✔ Container ${c.name}  Stopped\n`);
        }
        if (verb !== 'stop') {
          startContainer(ctx, st, c);
          io.out(` ✔ Container ${c.name}  ${verb === 'restart' ? 'Started' : 'Started'}\n`);
        }
      }
      return done();
    }
    case 'rm': {
      for (const svc of targets(named) ?? []) {
        const c = serviceContainer(st, p, svc);
        if (!c || c.status === 'running') continue;
        st.containers = st.containers.filter((k) => k !== c);
        io.out(` ✔ Container ${c.name}  Removed\n`);
      }
      return done();
    }
    case 'down': {
      const mine = st.containers.filter((c) => c.labels?.['com.docker.compose.project'] === p.name);
      const byOrder = [...p.order].reverse().map((s) => mine.find((c) => c.labels?.['com.docker.compose.service'] === s && c.labels['com.docker.compose.oneoff'] !== 'True')).filter((c): c is DockerContainer => !!c);
      const others = mine.filter((c) => !byOrder.includes(c));
      for (const c of [...byOrder, ...others]) {
        stopContainer(ctx, c, 0);
        st.containers = st.containers.filter((k) => k !== c);
        io.out(` ✔ Container ${c.name}  Removed\n`);
      }
      const nets = st.networks.filter((n) => n.startsWith(`${p.name}_`) && !st.containers.some((c) => networksOf(c).includes(n)));
      st.networks = st.networks.filter((n) => !nets.includes(n));
      for (const n of nets) io.out(` ✔ Network ${n}  Removed\n`);
      if (rest.includes('-v') || rest.includes('--volumes')) {
        const vols = Object.entries(yMap(p.doc.volumes)).filter(([, d]) => yStr(yMap(d).external) !== 'true').map(([v, d]) => yStr(yMap(d).name) || `${p.name}_${v}`);
        for (const v of vols) {
          if (!st.volumes.includes(v)) continue;
          st.volumes = st.volumes.filter((x) => x !== v);
          removeVolumeDir(ctx, v);
          io.out(` ✔ Volume ${v}  Removed\n`);
        }
      }
      const rmi = rest.indexOf('--rmi');
      if (rmi >= 0) {
        const which = rest[rmi + 1];
        for (const svc of p.order) {
          if (which === 'local' && p.services[svc].image !== undefined) continue;
          const img = findImage(st, imageOf(p, svc));
          if (img) {
            st.images = st.images.filter((x) => x !== img);
            io.out(` ✔ Image ${imageOf(p, svc)}  Removed\n`);
          }
        }
      }
      return done();
    }
    case 'images': {
      io.out('CONTAINER           REPOSITORY          TAG                 IMAGE ID            SIZE\n');
      for (const c of st.containers.filter((k) => k.labels?.['com.docker.compose.project'] === p.name)) {
        const img = findImage(st, c.image);
        io.out(`${c.name.padEnd(20)}${(img?.repo ?? '').padEnd(20)}${(img?.tag ?? '').padEnd(20)}${(img?.id ?? '').slice(0, 12).padEnd(20)}${img?.sizeMb ?? 0}MB\n`);
      }
      return 0;
    }
    case 'top': {
      for (const svc of targets(named) ?? []) {
        const c = serviceContainer(st, p, svc);
        if (!c || c.status !== 'running') continue;
        io.out(`${c.name}\n`);
        saveDocker(ctx, st);
        dockerCmd(['top', c.name], io, ctx);
      }
      return 0;
    }
    default:
      io.err(`unknown docker command: "compose ${verb}"\n`);
      return 1;
  }
}

export { parseBytes };
