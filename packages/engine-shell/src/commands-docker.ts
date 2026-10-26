/**
 * The simulated docker command line. The runtime (docker-engine.ts) keeps state in
 * /var/lib/docker/state.json and runs containers' commands in their own simulated systems;
 * images come from a small mirror of Docker Hub, from docker build (docker-build.ts), or from the
 * lab forge's registry at git.lab (docker-registry.ts). docker compose lives in docker-compose.ts.
 */

import { lookup, mkdir, readFile, writeFile, type DirNode } from './fs.js';
import { actor, currentUser, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { parseYaml } from './yaml.js';
import { build } from './docker-build.js';
import { compose } from './docker-compose.js';
import { dockerLogin, dockerLogout, pullImage, pushImage } from './docker-registry.js';
import {
  BoxError,
  ROOT,
  STATE,
  USER_NETWORK,
  ago,
  catalogueOf,
  containerFile,
  dockerState,
  findImage,
  goTemplate,
  healthConfig,
  hex,
  humanBytes,
  imageDigest,
  ipOf,
  joinPath,
  mainCommand,
  mergeLayer,
  networksOf,
  ociError,
  openBox,
  parseBytes,
  parseDuration,
  parseRef,
  prepareVolume,
  removeProcess,
  removeVolumeDir,
  runInBox,
  saveDocker,
  shq,
  startContainer,
  statusText,
  stopContainer,
  subnetOf,
  volumePath,
  words,
  type DockerContainer,
  type DockerImage,
  type DockerState,
  type HealthConfig,
  type Mount,
} from './docker-engine.js';

export { dockerHttp, loadDocker, type DockerContainer, type DockerImage, type DockerState } from './docker-engine.js';
export { parseYaml };

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

const HELP = `
Usage:  docker [OPTIONS] COMMAND

A self-sufficient runtime for containers

Common Commands:
  run         Create and run a new container from an image
  exec        Execute a command in a running container
  ps          List containers
  build       Build an image from a Dockerfile
  pull        Download an image from a registry
  push        Upload an image to a registry
  images      List images
  login       Log in to a registry
  logout      Log out from a registry
  version     Show the Docker version information
  info        Display system-wide information

Management Commands:
  compose     Docker Compose
  container   Manage containers
  image       Manage images
  network     Manage networks
  system      Manage Docker
  volume      Manage volumes

Commands:
  cp, create, diff, history, inspect, kill, logs, port, rename, restart, rm, rmi, save, load,
  start, stats, stop, tag, top, update, wait
`;

/* ----------------------------------------------------------------------------- option parsing */

interface RunOpts {
  values: Record<string, string[]>;
  flags: Set<string>;
  rest: string[];
}

const RUN_VALUED = ['name', 'p', 'publish', 'e', 'env', 'env-file', 'v', 'volume', 'mount', 'tmpfs', 'restart', 'network', 'net', 'network-alias', 'w', 'workdir', 'u', 'user', 'm', 'memory', 'cpus', 'entrypoint', 'health-cmd', 'health-interval', 'health-retries', 'health-start-period', 'health-timeout', 'l', 'label', 'hostname', 'h', 'pids-limit', 'cap-drop', 'cap-add', 'security-opt', 'platform', 'add-host', 'pull', 'memory-swap', 'cpu-shares', 'log-driver', 'log-opt', 'stop-signal', 'ulimit'];

/** Parses docker run/create options up to the image name; repeated options keep every value. */
function parseRun(args: string[]): RunOpts {
  const values: Record<string, string[]> = {};
  const flags = new Set<string>();
  let i = 0;
  const add = (k: string, v: string) => (values[k] ??= []).push(v);
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      i++;
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (RUN_VALUED.includes(name)) add(name, eq < 0 ? args[++i] ?? '' : a.slice(eq + 1));
      else flags.add(name);
      continue;
    }
    // Short options, possibly bundled (-it, -dp 8080:80).
    for (let k = 1; k < a.length; k++) {
      const f = a[k];
      if (RUN_VALUED.includes(f)) {
        add(f, k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? '');
        break;
      }
      flags.add(f);
    }
  }
  return { values, flags, rest: args.slice(i) };
}

const one = (o: RunOpts, ...names: string[]) => {
  for (const n of names) if (o.values[n]?.length) return o.values[n][o.values[n].length - 1];
  return undefined;
};
const many = (o: RunOpts, ...names: string[]) => names.flatMap((n) => o.values[n] ?? []);

function simpleOpts(args: string[], valued: string[]): { values: Record<string, string>; flags: Set<string>; rest: string[] } {
  const o = parseRun(args.map((a) => a));
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const rest: string[] = [];
  // A simpler parser for the other subcommands: options anywhere.
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (valued.includes(name)) values[name] = eq < 0 ? args[++i] ?? '' : a.slice(eq + 1);
      else flags.add(name);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (valued.includes(a[k])) {
          values[a[k]] = k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? '';
          break;
        }
        flags.add(a[k]);
      }
    } else rest.push(a);
  }
  void o;
  return { values, flags, rest };
}

/* ----------------------------------------------------------------------------- JSON views (inspect, --format) */

function containerJson(_ctx: Ctx, st: DockerState, c: DockerContainer): Record<string, unknown> {
  const img = findImage(st, c.image);
  const h = healthConfig(st, c);
  const main = img ? mainCommand(img, c) : '';
  const argv = words(main);
  const iso = (t?: number) => (t ? new Date(t).toISOString() : '0001-01-01T00:00:00Z');
  const nets: Record<string, unknown> = {};
  for (const n of networksOf(c)) nets[n] = { IPAddress: ipOf(st, c, n), Gateway: ipOf(st, c, n).replace(/\.\d+$/, '.1'), Aliases: USER_NETWORK(n) ? [c.name, c.id.slice(0, 12), ...(c.aliases ?? [])] : null, NetworkID: hex('net' + n, 64), MacAddress: `02:42:ac:${subnetOf(st, n).toString(16)}:00:0${(Number(ipOf(st, c, n).split('.').pop()) || 2).toString(16)}` };
  return {
    Id: c.id,
    Created: iso(c.created),
    Path: argv[0] ?? '',
    Args: argv.slice(1),
    State: {
      Status: c.status,
      Running: c.status === 'running',
      Paused: false,
      Restarting: false,
      OOMKilled: !!c.oomKilled,
      Dead: false,
      Pid: c.status === 'running' ? c.pid ?? 0 : 0,
      ExitCode: c.exitCode,
      Error: '',
      StartedAt: iso(c.started),
      FinishedAt: iso(c.finished),
      ...(c.health ? { Health: { Status: c.health.status, FailingStreak: c.health.failing, Log: c.health.log.map((l) => ({ Start: iso(l.at), End: iso(l.at + 40), ExitCode: l.code, Output: l.out })) } } : {}),
    },
    Image: 'sha256:' + hex(img?.id ?? c.image, 64),
    Name: '/' + c.name,
    RestartCount: c.restartCount ?? 0,
    HostConfig: {
      Binds: c.mounts.filter((m) => m.kind === 'bind').map((m) => `${m.source}:${m.target}${m.readOnly ? ':ro' : ''}`),
      NetworkMode: c.network,
      PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.container}/tcp`, [{ HostIp: p.ip ?? '', HostPort: String(p.host) }]])),
      RestartPolicy: { Name: c.restart.split(':')[0], MaximumRetryCount: Number(c.restart.split(':')[1] ?? 0) },
      Memory: c.memory ?? 0,
      NanoCpus: c.cpus ? Math.round(c.cpus * 1e9) : 0,
      ReadonlyRootfs: !!c.readOnly,
    },
    Mounts: c.mounts.map((m) => ({ Type: m.kind, ...(m.kind === 'volume' ? { Name: m.source } : {}), Source: m.kind === 'volume' ? volumePath(m.source) : m.source, Destination: m.target, Mode: m.readOnly ? 'ro' : '', RW: !m.readOnly })),
    Config: {
      Hostname: c.id.slice(0, 12),
      User: c.user ?? img?.user ?? '',
      Env: Object.entries({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...(img?.env ?? {}), ...c.env }).map(([k, v]) => `${k}=${v}`),
      Cmd: words(c.command ?? img?.cmd ?? ''),
      Entrypoint: (c.entrypoint ?? img?.entrypoint) ? words(c.entrypoint ?? img?.entrypoint ?? '') : null,
      Image: c.image,
      WorkingDir: c.workdir ?? img?.workdir ?? '',
      Labels: { ...(img?.labels ?? {}), ...(c.labels ?? {}) },
      ExposedPorts: Object.fromEntries((img?.expose ?? []).map((p) => [`${p}/tcp`, {}])),
      ...(h ? { Healthcheck: { Test: h.test, Interval: h.interval * 1e6, Timeout: (h.timeout ?? 30000) * 1e6, Retries: h.retries, StartPeriod: h.startPeriod * 1e6 } } : {}),
    },
    NetworkSettings: {
      Ports: Object.fromEntries([...(img?.expose ?? []).map((p) => [`${p}/tcp`, null]), ...c.ports.map((p) => [`${p.container}/tcp`, [{ HostIp: p.ip ?? '0.0.0.0', HostPort: String(p.host) }]])]),
      IPAddress: c.network === 'bridge' ? ipOf(st, c, 'bridge') : '',
      Networks: nets,
    },
  };
}

function imageJson(img: DockerImage): Record<string, unknown> {
  return {
    Id: 'sha256:' + hex(img.id, 64),
    RepoTags: img.repo === '<none>' ? [] : [`${img.repo}:${img.tag}`],
    RepoDigests: img.repoDigests ?? [],
    Created: new Date(img.created).toISOString(),
    Size: Math.round(img.sizeMb * 1e6),
    Architecture: 'amd64',
    Os: 'linux',
    Config: {
      User: img.user,
      ExposedPorts: Object.fromEntries(img.expose.map((p) => [`${p}/tcp`, {}])),
      Env: Object.entries({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...img.env }).map(([k, v]) => `${k}=${v}`),
      Cmd: img.cmd ? words(img.cmd) : null,
      Entrypoint: img.entrypoint ? words(img.entrypoint) : null,
      WorkingDir: img.workdir === '/' ? '' : img.workdir,
      Labels: img.labels ?? null,
      Volumes: img.volumes ? Object.fromEntries(img.volumes.map((v) => [v, {}])) : null,
      ...(img.health && img.health.test[0] !== 'NONE' ? { Healthcheck: { Test: img.health.test, Interval: img.health.interval * 1e6, Retries: img.health.retries } } : {}),
    },
    RootFS: { Type: 'layers', Layers: Array.from({ length: img.layers }, (_, i) => 'sha256:' + hex(img.id + i, 64)) },
  };
}

function psRow(ctx: Ctx, st: DockerState, c: DockerContainer): Record<string, string> {
  const img = findImage(st, c.image);
  const cmd = img ? mainCommand(img, c) : '';
  return {
    ID: c.id.slice(0, 12),
    Image: c.image,
    Command: `"${cmd.length > 20 ? cmd.slice(0, 19) + '…' : cmd}"`,
    CreatedAt: new Date(c.created).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000 UTC'),
    RunningFor: `${ago(ctx.sys.now - c.created)} ago`,
    Ports: portsText(c),
    State: c.status,
    Status: statusText(ctx, c),
    Names: c.name,
    Labels: Object.entries(c.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(','),
    Mounts: c.mounts.map((m) => (m.kind === 'volume' ? m.source : m.source.split('/').pop() ?? '')).join(','),
    Networks: networksOf(c).join(','),
    Size: c.rw ? `${humanBytes(Object.values(c.rw.files).reduce((a, f) => a + f.length, 0))} (virtual ${img?.sizeMb ?? 0}MB)` : '0B',
  };
}

function imageRow(img: DockerImage, now: number): Record<string, string> {
  return {
    Repository: img.repo,
    Tag: img.tag,
    ID: img.id.slice(0, 12),
    Digest: img.repoDigests?.[0]?.split('@')[1] ?? '<none>',
    CreatedSince: `${ago(now - img.created)} ago`,
    CreatedAt: new Date(img.created).toISOString(),
    Size: img.sizeMb >= 1000 ? `${(img.sizeMb / 1000).toFixed(2)}GB` : `${img.sizeMb}MB`,
  };
}

function portsText(c: DockerContainer): string {
  return c.ports.map((p) => `${p.ip ?? '0.0.0.0'}:${p.host}->${p.container}/tcp`).join(', ');
}

/** Prints rows with a Go-template --format, or the default table. */
function table(io: IO, rows: Array<Record<string, string>>, format: string | undefined, headers: Array<[string, string, number]>): void {
  if (format && format !== 'table') {
    const isTable = format.startsWith('table');
    const tpl = isTable ? format.replace(/^table\s*/, '') : format;
    if (format === 'json') {
      for (const r of rows) io.out(JSON.stringify(r) + '\n');
      return;
    }
    const out = rows.map((r) => goTemplate(tpl, r));
    if (isTable) {
      const head = tpl.replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, f: string) => (headers.find(([k]) => k === f)?.[1] ?? f.toUpperCase())).replace(/\\t/g, '\t');
      const all = [head, ...out].map((l) => l.split('\t'));
      const w = all[0].map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
      for (const r of all) io.out(r.map((cell, i) => (i < r.length - 1 ? cell.padEnd(w[i] + 3) : cell)).join('').trimEnd() + '\n');
      return;
    }
    for (const l of out) io.out(l + '\n');
    return;
  }
  const w = headers.map(([k, h, min]) => Math.max(min, h.length, ...rows.map((r) => (r[k] ?? '').length)));
  io.out(headers.map(([, h], i) => (i < headers.length - 1 ? h.padEnd(w[i] + 3) : h)).join('') + '\n');
  for (const r of rows) io.out(headers.map(([k], i) => (i < headers.length - 1 ? (r[k] ?? '').padEnd(w[i] + 3) : r[k] ?? '')).join('').trimEnd() + '\n');
}

/* ----------------------------------------------------------------------------- docker run */

const NAMES_A = ['brave', 'calm', 'eager', 'kind', 'quiet', 'swift', 'bold', 'keen'];
const NAMES_B = ['akan', 'ewe', 'ga', 'dagbani', 'fante', 'nzema', 'hausa', 'twi'];

function envFile(ctx: Ctx, path: string, io: IO): Record<string, string> | null {
  let text: string;
  try {
    text = readFile(ctx.sys.fs, abs(ctx, path), actor(ctx));
  } catch {
    io.err(`docker: open ${path}: no such file or directory.\n`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

export interface CreateResult {
  c?: DockerContainer;
  code: number;
}

/** docker create / run: builds the container record (and pulls the image) without starting it. */
export function createContainer(ctx: Ctx, st: DockerState, args: string[], io: IO): CreateResult {
  const o = parseRun(args);
  const imageRef = o.rest[0];
  if (!imageRef) {
    io.err('"docker run" requires at least 1 argument.\nSee \'docker run --help\'.\n\nUsage:  docker run [OPTIONS] IMAGE [COMMAND] [ARG...]\n');
    return { code: 1 };
  }
  const quietPull = !!findImage(st, imageRef) || one(o, 'pull') === 'never';
  if (!findImage(st, imageRef)) io.err(`Unable to find image '${imageRef.includes(':') || imageRef.includes('@') ? imageRef : imageRef + ':latest'}' locally\n`);
  const img = pullImage(ctx, st, imageRef, quietPull ? { stdin: '', out: () => {}, err: io.err } : { stdin: '', out: io.err, err: io.err });
  if (!img) return { code: 125 };
  const name = one(o, 'name') ?? `${NAMES_A[st.containers.length % NAMES_A.length]}_${NAMES_B[(st.containers.length * 3) % NAMES_B.length]}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    io.err(`docker: Error response from daemon: Invalid container name (${name}), only [a-zA-Z0-9][a-zA-Z0-9_.-] are allowed.\n`);
    return { code: 125 };
  }
  if (st.containers.some((c) => c.name === name)) {
    const other = st.containers.find((c) => c.name === name)!;
    io.err(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${other.id}". You have to remove (or rename) that container to be able to reuse that name.\n`);
    return { code: 125 };
  }
  const ports: DockerContainer['ports'] = [];
  for (const p of many(o, 'p', 'publish')) {
    const parts = p.replace(/\/(tcp|udp)$/, '').split(':');
    const [ip, hostPort, containerPort] = parts.length === 3 ? parts : parts.length === 2 ? ['', ...parts] : ['', '', parts[0]];
    if (parts.length > 3 || !/^\d+$/.test(containerPort) || (hostPort && !/^\d+$/.test(hostPort)) || (ip && !/^[\d.]+$/.test(ip))) {
      io.err(`docker: invalid publish "${p}": use HOST:CONTAINER, for example -p 8080:80\n`);
      return { code: 125 };
    }
    ports.push({ host: hostPort ? Number(hostPort) : 32768 + st.containers.length * 3 + ports.length, container: Number(containerPort), ...(ip && ip !== '0.0.0.0' ? { ip } : {}) });
  }
  if (o.flags.has('P')) img.expose.forEach((p, i) => ports.push({ host: 32768 + i + st.containers.length * 3, container: p }));
  const env: Record<string, string> = {};
  for (const f of many(o, 'env-file')) {
    const e = envFile(ctx, f, io);
    if (!e) return { code: 125 };
    Object.assign(env, e);
  }
  for (const e of many(o, 'e', 'env')) {
    const eq = e.indexOf('=');
    if (eq < 0) {
      // -e NAME passes the variable through from the shell.
      const v = ctx.exported.has(e) ? ctx.vars[e] : ctx.sys.env[e];
      if (v !== undefined) env[e] = v;
    } else env[e.slice(0, eq)] = e.slice(eq + 1);
  }
  const mounts: Mount[] = [];
  for (const v of many(o, 'v', 'volume')) {
    const parts = v.split(':');
    if (parts.length === 1) {
      // An anonymous volume.
      mounts.push({ source: hex('anon' + name + v, 64), target: v, kind: 'volume' });
      continue;
    }
    const [src, target, mode] = parts;
    if (!target?.startsWith('/')) {
      io.err(`docker: Error response from daemon: invalid volume specification: '${v}': invalid mount config for type "${/^[./~]/.test(src) ? 'bind' : 'volume'}": invalid mount path: '${target ?? ''}' mount path must be absolute.\n`);
      return { code: 125 };
    }
    const isBind = /^[/.~$]/.test(src);
    if (isBind) {
      const hostPath = abs(ctx, src);
      if (!lookup(ctx.sys.fs, hostPath, actor(ctx))) {
        // Docker creates a missing bind source as an empty root-owned directory.
        mkdir(ctx.sys.fs, hostPath, ROOT, ctx.sys.now, true);
      }
      mounts.push({ source: hostPath, target, kind: 'bind', ...(mode?.split(',').includes('ro') ? { readOnly: true } : {}) });
    } else {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(src)) {
        io.err(`docker: Error response from daemon: create ${src}: "${src}" includes invalid characters for a local volume name, only "[a-zA-Z0-9][a-zA-Z0-9_.-]" are allowed. If you intended to pass a host directory, use absolute path.\n`);
        return { code: 125 };
      }
      mounts.push({ source: src, target, kind: 'volume', ...(mode?.split(',').includes('ro') ? { readOnly: true } : {}) });
    }
  }
  for (const spec of many(o, 'mount')) {
    const kv = Object.fromEntries(spec.split(',').map((p) => p.split('=')).map(([k, v]) => [k, v ?? 'true']));
    const kind = (kv.type ?? 'volume') as Mount['kind'];
    const target = kv.target ?? kv.destination ?? kv.dst;
    if (!target) {
      io.err('docker: invalid argument "' + spec + '" for "--mount" flag: target is required\n');
      return { code: 125 };
    }
    const source = kind === 'bind' ? abs(ctx, kv.source ?? kv.src ?? '') : kv.source ?? kv.src ?? hex('anon' + name + target, 64);
    if (kind === 'bind' && !lookup(ctx.sys.fs, source, actor(ctx))) {
      io.err(`docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${source}\n`);
      return { code: 125 };
    }
    mounts.push({ source, target, kind, ...(kv.readonly === 'true' || kv.ro === 'true' ? { readOnly: true } : {}) });
  }
  for (const t of many(o, 'tmpfs')) mounts.push({ source: 'tmpfs', target: t.split(':')[0], kind: 'tmpfs' });
  for (const v of img.volumes ?? []) if (!mounts.some((m) => m.target === v)) mounts.push({ source: hex('anon' + name + v, 64), target: v, kind: 'volume' });
  const network = one(o, 'network', 'net') ?? 'bridge';
  if (!st.networks.includes(network) && !network.startsWith('container:')) {
    io.err(`docker: Error response from daemon: network ${network} not found.\n`);
    return { code: 125 };
  }
  const memText = one(o, 'm', 'memory');
  const memory = memText ? parseBytes(memText) : undefined;
  if (memText && (memory === null || memory! < 6 * 1024 * 1024)) {
    io.err(memory === null ? `invalid argument "${memText}" for "-m, --memory" flag: invalid size: '${memText}'\n` : 'docker: Error response from daemon: Minimum memory limit allowed is 6MB.\n');
    return { code: 125 };
  }
  const cpusText = one(o, 'cpus');
  const cpus = cpusText ? Number(cpusText) : undefined;
  if (cpusText && !(cpus! > 0)) {
    io.err(`invalid argument "${cpusText}" for "--cpus" flag: failed to parse ${cpusText} as a rational number\n`);
    return { code: 125 };
  }
  if (cpus && cpus > 4) {
    io.err(`docker: Error response from daemon: Range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available.\n`);
    return { code: 125 };
  }
  const restart = one(o, 'restart') ?? 'no';
  if (!/^(no|always|unless-stopped|on-failure(:\d+)?)$/.test(restart)) {
    io.err(`docker: invalid restart policy '${restart}'\n`);
    return { code: 125 };
  }
  if (restart !== 'no' && o.flags.has('rm')) {
    io.err('docker: Conflicting options: --restart and --rm.\n');
    return { code: 125 };
  }
  let healthcheck: HealthConfig | null | undefined;
  if (o.flags.has('no-healthcheck')) healthcheck = null;
  else if (one(o, 'health-cmd')) healthcheck = { test: ['CMD-SHELL', one(o, 'health-cmd')!], interval: parseDuration(one(o, 'health-interval'), 30000), retries: Number(one(o, 'health-retries') ?? 3), startPeriod: parseDuration(one(o, 'health-start-period'), 0), timeout: parseDuration(one(o, 'health-timeout'), 30000) };
  const labels: Record<string, string> = {};
  for (const l of many(o, 'l', 'label')) {
    const eq = l.indexOf('=');
    labels[eq < 0 ? l : l.slice(0, eq)] = eq < 0 ? '' : l.slice(eq + 1);
  }
  const cmdWords = o.rest.slice(1);
  const ep = one(o, 'entrypoint');
  const c: DockerContainer = {
    id: hex('c' + name + st.containers.length + ctx.sys.now, 64),
    name,
    image: `${img.repo}:${img.tag}`,
    status: 'created',
    exitCode: 0,
    ports,
    env,
    mounts,
    restart,
    network,
    logs: [],
    created: ctx.sys.now,
    ...(cmdWords.length ? { command: cmdWords.map(shq).join(' ') } : {}),
    ...(ep !== undefined ? { entrypoint: ep } : {}),
    ...(one(o, 'u', 'user') ? { user: one(o, 'u', 'user') } : {}),
    ...(one(o, 'w', 'workdir') ? { workdir: one(o, 'w', 'workdir') } : {}),
    ...(memory ? { memory } : {}),
    ...(cpus ? { cpus } : {}),
    ...(many(o, 'network-alias').length ? { aliases: many(o, 'network-alias') } : {}),
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(healthcheck !== undefined ? { healthcheck } : {}),
    ...(o.flags.has('read-only') ? { readOnly: true } : {}),
  };
  if (parseRef(imageRef).digest) c.image = `${parseRef(imageRef).repo}@${parseRef(imageRef).digest}`;
  else if (img.repo === '<none>') c.image = img.id;
  if (one(o, 'network-alias') && !USER_NETWORK(network)) {
    io.err('docker: Error response from daemon: network-scoped alias is supported only for containers in user defined networks.\n');
    return { code: 125 };
  }
  for (const m of mounts) if (m.kind === 'volume') prepareVolume(ctx, st, m.source, img, m.target);
  st.containers.push(c);
  return { c, code: 0 };
}

function portClash(ctx: Ctx, st: DockerState, c: DockerContainer): number | null {
  for (const p of c.ports) {
    const used = st.containers.some((k) => k !== c && k.status === 'running' && k.ports.some((q) => q.host === p.host)) || Object.values(ctx.sys.services).some((s) => s.active && s.port === p.host);
    if (used) return p.host;
  }
  return null;
}

/** Starts a created container, reporting the errors docker run reports. */
function runStart(ctx: Ctx, st: DockerState, c: DockerContainer, io: IO, attach: boolean): number {
  const clash = portClash(ctx, st, c);
  if (clash !== null) {
    io.err(`docker: Error response from daemon: driver failed programming external connectivity on endpoint ${c.name} (${hex(c.id, 64)}): Bind for 0.0.0.0:${clash} failed: port is already allocated.\n`);
    c.status = 'created';
    return 125;
  }
  const r = startContainer(ctx, st, c, attach ? io : undefined);
  if (r.error) {
    io.err((r.error.startsWith('unable to find user') ? `docker: Error response from daemon: ${r.error}.` : ociError(r.error)) + '\n');
    return r.code;
  }
  return r.code;
}

/* ----------------------------------------------------------------------------- docker cp */

function cp(ctx: Ctx, st: DockerState, args: string[], io: IO): number {
  const [src, dst] = args.filter((a) => !a.startsWith('-'));
  if (!src || !dst) {
    io.err('"docker cp" requires exactly 2 arguments.\n');
    return 1;
  }
  const split = (s: string) => {
    const m = /^([a-zA-Z0-9][\w.-]*):(.*)$/.exec(s);
    return m && !s.startsWith('/') && !s.startsWith('.') ? { c: m[1], path: m[2] } : null;
  };
  const from = split(src);
  const to = split(dst);
  const containerOf = (ref: string) => st.containers.find((c) => c.name === ref || c.id.startsWith(ref));
  if (from) {
    const c = containerOf(from.c);
    if (!c) {
      io.err(`Error response from daemon: No such container: ${from.c}\n`);
      return 1;
    }
    const img = findImage(st, c.image)!;
    const path = joinPath(c.workdir ?? img.workdir ?? '/', from.path);
    const content = containerFile(ctx, img, c, path);
    const all = { ...img.files, ...(c.rw?.files ?? {}) };
    const under = Object.keys(all).filter((p) => p.startsWith(path.replace(/\/$/, '') + '/') && !c.rw?.deleted?.includes(p));
    if (content === null && !under.length) {
      io.err(`Error response from daemon: Could not find the file ${path} in container ${from.c}\n`);
      return 1;
    }
    let hostDst = abs(ctx, dst);
    try {
      if (content !== null) {
        const l = lookup(ctx.sys.fs, hostDst, actor(ctx));
        if (l && l.node.type === 'dir') hostDst = joinPath(hostDst, path.split('/').pop()!);
        writeFile(ctx.sys.fs, hostDst, content, actor(ctx), ctx.sys.now);
      } else {
        const l = lookup(ctx.sys.fs, hostDst, actor(ctx));
        const base = l && l.node.type === 'dir' ? joinPath(hostDst, path.replace(/\/$/, '').split('/').pop()!) : hostDst;
        for (const p of under) {
          const v = containerFile(ctx, img, c, p);
          if (v === null) continue;
          const target = joinPath(base, p.slice(path.replace(/\/$/, '').length + 1));
          mkdir(ctx.sys.fs, target.slice(0, target.lastIndexOf('/')), actor(ctx), ctx.sys.now, true);
          writeFile(ctx.sys.fs, target, v, actor(ctx), ctx.sys.now);
        }
      }
    } catch (e) {
      io.err(`Error: ${(e as Error).message}\n`);
      return 1;
    }
    io.out(`Successfully copied ${humanBytes((content ?? under.map((p) => all[p]).join('')).length)} to ${dst}\n`);
    return 0;
  }
  if (to) {
    const c = containerOf(to.c);
    if (!c) {
      io.err(`Error response from daemon: No such container: ${to.c}\n`);
      return 1;
    }
    const img = findImage(st, c.image)!;
    const hostSrc = abs(ctx, src);
    const l = lookup(ctx.sys.fs, hostSrc, actor(ctx));
    if (!l) {
      io.err(`lstat ${hostSrc}: no such file or directory\n`);
      return 1;
    }
    const target = joinPath(c.workdir ?? img.workdir ?? '/', to.path);
    const isDirTarget = to.path.endsWith('/') || Object.keys({ ...img.files, ...(c.rw?.files ?? {}) }).some((p) => p.startsWith(target.replace(/\/$/, '') + '/')) || !!img.dirs?.[target] || !!c.rw?.dirs?.[target];
    let total = 0;
    const put = (path: string, content: string) => {
      total += content.length;
      const m = c.mounts.find((k) => path === k.target || path.startsWith(k.target.replace(/\/$/, '') + '/'));
      if (m && m.kind !== 'tmpfs') {
        const hp = (m.kind === 'volume' ? volumePath(m.source) : m.source) + '/' + path.slice(m.target.length);
        mkdir(ctx.sys.fs, hp.replace(/\/+/g, '/').slice(0, hp.replace(/\/+/g, '/').lastIndexOf('/')), ROOT, ctx.sys.now, true);
        writeFile(ctx.sys.fs, hp.replace(/\/+/g, '/'), content, ROOT, ctx.sys.now);
      } else c.rw = mergeLayer(c.rw, { files: { [path]: content } }, img);
    };
    if (l.node.type === 'file') put(isDirTarget ? joinPath(target, hostSrc.split('/').pop()!) : target, l.node.content);
    else if (l.node.type === 'dir') {
      const base = isDirTarget ? joinPath(target, hostSrc.split('/').pop()!) : target;
      const walk = (n: DirNode, rel: string) => {
        for (const [k, child] of Object.entries(n.children)) {
          if (child.type === 'dir') walk(child, `${rel}/${k}`);
          else if (child.type === 'file') put(joinPath(base, `${rel}/${k}`.replace(/^\//, '')), child.content);
        }
      };
      walk(l.node, '');
    }
    io.out(`Successfully copied ${humanBytes(total)} to ${to.c}:${to.path}\n`);
    return 0;
  }
  io.err('must specify at least one container source\n');
  return 1;
}

/* ----------------------------------------------------------------------------- the command */

const docker: Cmd = (args, io, ctx) => {
  const user = currentUser(ctx);
  const inGroup = ctx.sys.users[user]?.groups?.includes('docker') || ctx.sys.groups.docker?.members.includes(user);
  if (user !== 'root' && !inGroup) {
    io.err('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/containers/json": dial unix /var/run/docker.sock: connect: permission denied\n(Use sudo, or add yourself to the docker group with: sudo usermod -aG docker $USER, then log in again.)\n');
    return 1;
  }
  if (ctx.sys.services.docker && !ctx.sys.services.docker.active) {
    io.err('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    return 1;
  }
  // Global options.
  while (args[0] === '--context' || args[0] === '-H' || args[0] === '--host' || args[0] === '--debug' || args[0] === '-D' || args[0] === '--log-level') args = args[0] === '--debug' || args[0] === '-D' ? args.slice(1) : args.slice(2);
  let [sub, ...rest] = args;
  if (sub === 'container' || sub === 'image' || sub === 'buildx' || sub === 'builder') {
    const [verb, ...more] = rest;
    const map: Record<string, Record<string, string>> = {
      container: { ls: 'ps', list: 'ps', rm: 'rm', inspect: 'inspect', prune: 'container-prune' },
      image: { ls: 'images', list: 'images', rm: 'rmi', inspect: 'inspect', prune: 'image-prune' },
      buildx: { build: 'build' },
      builder: { prune: 'builder-prune', build: 'build' },
    };
    sub = map[sub][verb] ?? verb;
    rest = more;
  }
  const st = dockerState(ctx);
  const done = (code = 0) => {
    saveDocker(ctx, st);
    return code;
  };
  const containerOf = (ref: string) => st.containers.find((c) => c.name === ref) ?? st.containers.find((c) => ref.length >= 3 && c.id.startsWith(ref));
  const noSuch = (ref: string) => {
    io.err(`Error response from daemon: No such container: ${ref}\n`);
    return 1;
  };

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      io.out(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      if (sub === 'version') io.out('Client:\n Version:           27.3.1\n API version:       1.47\n Go version:        go1.22.7\n OS/Arch:           linux/amd64\n\nServer: Docker Engine - Community\n Engine:\n  Version:          27.3.1\n  API version:      1.47 (minimum version 1.24)\n  OS/Arch:          linux/amd64\n containerd:\n  Version:          1.7.22\n runc:\n  Version:          1.1.14\n');
      else io.out('Docker version 27.3.1, build ce12230\n');
      return 0;
    case 'info':
      io.out(`Client: Docker Engine - Community\n Version:    27.3.1\n\nServer:\n Containers: ${st.containers.length}\n  Running: ${st.containers.filter((c) => c.status === 'running').length}\n  Paused: 0\n  Stopped: ${st.containers.filter((c) => c.status !== 'running').length}\n Images: ${st.images.length}\n Server Version: 27.3.1\n Storage Driver: overlay2\n Cgroup Driver: systemd\n Cgroup Version: 2\n Kernel Version: 6.4.0-150600.23.25-default\n Operating System: ${ctx.sys.os === 'windows' ? 'Windows' : 'openSUSE Leap 15.6'}\n CPUs: 4\n Total Memory: 3.84GiB\n Name: ${ctx.sys.hostname}\n Docker Root Dir: /var/lib/docker\n`);
      return 0;
    case 'login':
      return dockerLogin(ctx, rest, io);
    case 'logout':
      return dockerLogout(ctx, rest, io);
    case 'pull': {
      const o = simpleOpts(rest, ['platform']);
      const ref = o.rest[0];
      if (!ref) {
        io.err('"docker pull" requires exactly 1 argument.\n');
        return 1;
      }
      // A tag that exists locally is pulled again from the registry (it may have moved).
      const r = parseRef(ref);
      if (r.registry !== 'docker.io' && !r.digest) st.images = st.images.filter((i) => !(i.repo === r.repo && i.tag === r.tag));
      if (findImage(st, ref)) {
        const img = findImage(st, ref)!;
        io.out(`${r.tag}: Pulling from ${r.path}\nDigest: ${img.repoDigests?.[0]?.split('@')[1] ?? 'sha256:' + hex(img.id, 64)}\nStatus: Image is up to date for ${r.repo}:${r.tag}\n${r.registry === 'docker.io' ? 'docker.io/' + r.path : r.repo}:${r.tag}\n`);
        return 0;
      }
      return pullImage(ctx, st, ref, o.flags.has('q') || o.flags.has('quiet') ? { stdin: '', out: () => {}, err: io.err } : io) ? done() : done(1);
    }
    case 'push': {
      const o = simpleOpts(rest, []);
      if (!o.rest[0]) {
        io.err('"docker push" requires exactly 1 argument.\n');
        return 1;
      }
      return done(pushImage(ctx, st, o.rest[0], io, o.flags.has('a') || o.flags.has('all-tags')));
    }
    case 'tag': {
      const [srcRef, dstRef] = rest.filter((a) => !a.startsWith('-'));
      if (!srcRef || !dstRef) {
        io.err('"docker tag" requires exactly 2 arguments.\n\nUsage:  docker tag SOURCE_IMAGE[:TAG] TARGET_IMAGE[:TAG]\n');
        return 1;
      }
      const src = findImage(st, srcRef);
      if (!src) {
        io.err(`Error response from daemon: No such image: ${srcRef.includes(':') ? srcRef : srcRef + ':latest'}\n`);
        return 1;
      }
      const d = parseRef(dstRef);
      if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(d.repo.replace(/^[^/]+\.[^/]+\//, '').replace(/^localhost(:\d+)?\//, ''))) {
        io.err(`Error parsing reference: "${dstRef}" is not a valid repository/tag: invalid reference format: repository name (${d.repo}) must be lowercase\n`);
        return 1;
      }
      st.images = st.images.filter((i) => !(i.repo === d.repo && i.tag === d.tag));
      st.images.push({ ...structuredClone(src), repo: d.repo, tag: d.tag, repoDigests: (src.repoDigests ?? []).filter((x) => x.startsWith(d.repo + '@')) });
      return done();
    }
    case 'images': {
      const o = simpleOpts(rest, ['format', 'filter', 'f']);
      let list = st.images.filter((i) => o.flags.has('a') || o.flags.has('all') || i.repo !== '<none>' || true);
      const want = o.rest[0];
      if (want) {
        const r = parseRef(want);
        list = list.filter((i) => i.repo === r.repo && (!want.includes(':') || i.tag === r.tag));
      }
      const filter = o.values.filter ?? o.values.f;
      if (filter === 'dangling=true') list = list.filter((i) => i.repo === '<none>');
      if (filter?.startsWith('reference=')) {
        const re = new RegExp('^' + filter.slice(10).replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
        list = list.filter((i) => re.test(`${i.repo}:${i.tag}`) || re.test(i.repo));
      }
      if (o.flags.has('q') || o.flags.has('quiet')) {
        for (const id of [...new Set(list.map((i) => i.id.slice(0, 12)))]) io.out(id + '\n');
        return 0;
      }
      const rows = list.map((i) => imageRow(i, ctx.sys.now));
      const digests = o.flags.has('digests');
      table(io, rows, o.values.format, [['Repository', 'REPOSITORY', 10], ['Tag', 'TAG', 6], ...(digests ? [['Digest', 'DIGEST', 10] as [string, string, number]] : []), ['ID', 'IMAGE ID', 12], ['CreatedSince', 'CREATED', 12], ['Size', 'SIZE', 4]]);
      return 0;
    }
    case 'rmi': {
      const o = simpleOpts(rest, []);
      const force = o.flags.has('f') || o.flags.has('force');
      let code = 0;
      for (const ref of o.rest) {
        const img = findImage(st, ref);
        if (!img) {
          io.err(`Error response from daemon: No such image: ${ref}\n`);
          code = 1;
          continue;
        }
        const byId = /^[0-9a-f]{4,}$/.test(ref) && img.id.startsWith(ref);
        const sameId = st.images.filter((i) => i.id === img.id);
        if (byId && sameId.length > 1 && !force) {
          io.err(`Error response from daemon: conflict: unable to delete ${ref} (must be forced) - image is referenced in multiple repositories\n`);
          code = 1;
          continue;
        }
        const using = st.containers.find((c) => c.image === `${img.repo}:${img.tag}` || c.image === img.id);
        if (using && !force && sameId.length === 1) {
          io.err(`Error response from daemon: conflict: unable to ${byId ? 'delete' : 'remove repository reference'} "${ref}" (must ${using.status === 'running' ? 'force' : 'force'}) - container ${using.id.slice(0, 12)} is using its referenced image ${img.id.slice(0, 12)}\n`);
          code = 1;
          continue;
        }
        const gone = byId ? sameId : [img];
        st.images = st.images.filter((i) => !gone.includes(i));
        for (const g of gone) if (g.repo !== '<none>') io.out(`Untagged: ${g.repo}:${g.tag}\n`);
        if (!st.images.some((i) => i.id === img.id)) io.out(`Deleted: sha256:${hex(img.id, 64)}\n`);
      }
      return done(code);
    }
    case 'build': {
      const o = simpleOpts(rest, ['t', 'tag', 'f', 'file', 'build-arg', 'target', 'platform', 'progress', 'label', 'network', 'cache-from', 'output', 'o']);
      const tags: string[] = [];
      const buildArgs: Record<string, string> = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '-t' || rest[i] === '--tag') tags.push(rest[++i]);
        else if (rest[i].startsWith('--tag=')) tags.push(rest[i].slice(6));
        else if (rest[i].startsWith('-t') && rest[i].length > 2) tags.push(rest[i].slice(2));
        else if (rest[i] === '--build-arg') {
          const kv = rest[++i] ?? '';
          const eq = kv.indexOf('=');
          if (eq < 0) buildArgs[kv] = ctx.vars[kv] ?? ctx.sys.env[kv] ?? '';
          else buildArgs[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      const contextArg = o.rest[0];
      if (!contextArg) {
        io.err('ERROR: "docker buildx build" requires exactly 1 argument.\nSee \'docker buildx build --help\'.\n\nUsage:  docker buildx build [OPTIONS] PATH | URL | -\n(Did you forget the "." for the build context?)\n');
        return 1;
      }
      for (const t of tags) {
        if (!/^[a-z0-9][a-z0-9._\/:-]*$/.test(t) || /[A-Z]/.test(t)) {
          io.err(`ERROR: invalid tag "${t}": repository name must be lowercase\n`);
          return 1;
        }
      }
      const ctxDir = abs(ctx, contextArg);
      const file = o.values.f ?? o.values.file ? abs(ctx, (o.values.f ?? o.values.file)!) : joinPath(ctxDir, 'Dockerfile');
      const code = build(ctx, st, { tags, contextDir: ctxDir, dockerfile: file, buildArgs, target: o.values.target, noCache: o.flags.has('no-cache'), quiet: o.flags.has('q') || o.flags.has('quiet') }, io);
      if (!tags.length && code === 0 && !o.flags.has('q')) io.err('(The image has no name. Tag it with -t name:version so you can run it by name.)\n');
      return done(code);
    }
    case 'create':
    case 'run': {
      const o = parseRun(rest);
      const r = createContainer(ctx, st, rest, io);
      if (!r.c) return done(r.code);
      const c = r.c;
      if (sub === 'create') {
        io.out(c.id + '\n');
        return done();
      }
      const detach = o.flags.has('d') || o.flags.has('detach');
      const interactive = o.flags.has('i') && o.flags.has('t');
      const code = runStart(ctx, st, c, io, !detach);
      if (code === 125 && c.status === 'created' && portClash(ctx, st, c) !== null) return done(125);
      if (c.status === 'created') {
        // The runtime could not start the program: the container stays in Created.
        return done(code);
      }
      if (o.flags.has('rm') && c.status !== 'running') {
        removeProcess(ctx, c);
        st.containers = st.containers.filter((k) => k !== c);
        return done(c.exitCode);
      }
      if (detach) io.out(c.id + '\n');
      else if (c.status === 'running') {
        if (interactive) io.out(`(You would now be inside the container's shell. The simulator does not keep interactive sessions: run commands in it with docker exec ${c.name} COMMAND.)\n`);
        else io.out('(Running in the foreground. The simulator gives you your prompt back, as if you had detached with Ctrl+P Ctrl+Q. Next time use -d.)\n');
      }
      return done(c.status === 'running' ? 0 : c.exitCode);
    }
    case 'compose':
      saveDocker(ctx, st);
      return compose(rest, io, ctx);
    case 'ps': {
      const o = simpleOpts(rest, ['format', 'filter', 'f', 'n']);
      const all = o.flags.has('a') || o.flags.has('all');
      let list = st.containers.filter((c) => all || c.status === 'running');
      const filters: string[] = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === '--filter' || rest[i] === '-f') filters.push(rest[++i]);
      for (const f of filters) {
        const [k, ...v] = f.split('=');
        const val = v.join('=');
        if (k === 'name') list = list.filter((c) => c.name.includes(val));
        else if (k === 'status') list = (all ? list : st.containers).filter((c) => c.status === val);
        else if (k === 'ancestor') list = list.filter((c) => c.image === val || c.image === `${val}:latest`);
        else if (k === 'label') list = list.filter((c) => (val.includes('=') ? c.labels?.[val.split('=')[0]] === val.split('=')[1] : c.labels?.[val] !== undefined));
        else if (k === 'health') list = list.filter((c) => c.health?.status === val);
        else if (k === 'network') list = list.filter((c) => networksOf(c).includes(val));
        else if (k === 'exited') list = list.filter((c) => c.status === 'exited' && c.exitCode === Number(val));
      }
      if (o.flags.has('l') || o.flags.has('latest')) list = list.slice(-1);
      if (o.flags.has('q') || o.flags.has('quiet')) {
        for (const c of [...list].reverse()) io.out(c.id.slice(0, 12) + '\n');
        return 0;
      }
      table(io, [...list].reverse().map((c) => psRow(ctx, st, c)), o.values.format, [['ID', 'CONTAINER ID', 12], ['Image', 'IMAGE', 5], ['Command', 'COMMAND', 7], ['RunningFor', 'CREATED', 7], ['Status', 'STATUS', 6], ['Ports', 'PORTS', 5], ['Names', 'NAMES', 5]]);
      return 0;
    }
    case 'stop':
    case 'start':
    case 'restart':
    case 'kill': {
      const o = simpleOpts(rest, ['t', 'time', 's', 'signal']);
      let code = 0;
      for (const ref of o.rest) {
        const c = containerOf(ref);
        if (!c) {
          code = noSuch(ref);
          continue;
        }
        if (sub === 'start' || sub === 'restart') {
          if (sub === 'restart' && c.status === 'running') stopContainer(ctx, c, 0, false);
          if (sub === 'start' && c.status === 'running') {
            io.out(ref + '\n');
            continue;
          }
          const clash = portClash(ctx, st, c);
          if (clash !== null) {
            io.err(`Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${clash} failed: port is already allocated\nError: failed to start containers: ${ref}\n`);
            code = 1;
            continue;
          }
          const r = startContainer(ctx, st, c, o.flags.has('a') ? io : undefined);
          if (r.error) {
            io.err(`Error response from daemon: ${r.error.startsWith('unable') ? r.error : ociError(r.error).replace(/^docker: Error response from daemon: /, '')}\nError: failed to start containers: ${ref}\n`);
            code = 1;
            continue;
          }
        } else {
          if (c.status !== 'running' && sub === 'kill') {
            io.err(`Error response from daemon: cannot kill container: ${ref}: container ${c.id} is not running\n`);
            code = 1;
            continue;
          }
          stopContainer(ctx, c, sub === 'kill' ? 137 : c.serve || catalogueOf(findImage(st, c.image) ?? { base: '' })?.daemon ? 0 : 143);
        }
        if (!o.flags.has('a')) io.out(ref + '\n');
      }
      return done(code);
    }
    case 'rm': {
      const o = simpleOpts(rest, []);
      const force = o.flags.has('f') || o.flags.has('force');
      let code = 0;
      for (const ref of o.rest) {
        const c = containerOf(ref);
        if (!c) {
          code = noSuch(ref);
          continue;
        }
        if (c.status === 'running' && !force) {
          io.err(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove\n`);
          code = 1;
          continue;
        }
        removeProcess(ctx, c);
        st.containers = st.containers.filter((k) => k !== c);
        if (o.flags.has('v') || o.flags.has('volumes')) {
          for (const m of c.mounts) if (m.kind === 'volume' && /^[0-9a-f]{64}$/.test(m.source)) {
            st.volumes = st.volumes.filter((v) => v !== m.source);
            removeVolumeDir(ctx, m.source);
          }
        }
        io.out(ref + '\n');
      }
      return done(code);
    }
    case 'rename': {
      const [from, to] = rest;
      const c = containerOf(from ?? '');
      if (!c) return noSuch(from ?? '');
      if (st.containers.some((k) => k.name === to)) {
        io.err(`Error response from daemon: Error when allocating new name: Conflict. The container name "/${to}" is already in use.\n`);
        return 1;
      }
      c.name = to;
      return done();
    }
    case 'logs': {
      const o = simpleOpts(rest, ['tail', 'n', 'since', 'until']);
      const ref = o.rest[0] ?? '';
      const c = containerOf(ref);
      if (!c) return noSuch(ref);
      let ls = c.logs;
      const tail = o.values.tail ?? o.values.n;
      if (tail && tail !== 'all') ls = ls.slice(-Number(tail));
      const stamp = o.flags.has('t') || o.flags.has('timestamps');
      for (const l of ls) io.out((stamp ? new Date(c.started ?? c.created).toISOString().replace('Z', '000000Z') + ' ' : '') + l + '\n');
      if (o.flags.has('f') || o.flags.has('follow')) io.out('(docker logs -f would keep following; the simulator returns.)\n');
      return 0;
    }
    case 'wait': {
      let code = 0;
      for (const ref of rest) {
        const c = containerOf(ref);
        if (!c) {
          code = noSuch(ref);
          continue;
        }
        if (c.status === 'running') {
          io.out(`(${ref} is still running; docker wait would block until it stops.)\n`);
          continue;
        }
        io.out(c.exitCode + '\n');
      }
      return code;
    }
    case 'exec': {
      const o = parseRun(rest.map((a) => (a === '--user' ? '-u' : a)));
      const ref = o.rest[0] ?? '';
      const c = containerOf(ref);
      if (!ref) {
        io.err('"docker exec" requires at least 2 arguments.\n\nUsage:  docker exec [OPTIONS] CONTAINER COMMAND [ARG...]\n');
        return 1;
      }
      if (!c) return noSuch(ref);
      if (c.status !== 'running') {
        io.err(`Error response from daemon: container ${c.id} is not running\n`);
        return 1;
      }
      const argv = o.rest.slice(1);
      if (!argv.length) {
        io.err('"docker exec" requires at least 2 arguments.\n');
        return 1;
      }
      const img = findImage(st, c.image)!;
      const interactive = o.flags.has('i') && o.flags.has('t');
      if (interactive && argv.length === 1 && /^(\/bin\/)?(ba)?sh$/.test(argv[0])) {
        io.out(`(You would now be inside ${c.name}'s shell. The simulator does not keep interactive sessions: run each command as docker exec ${c.name} COMMAND, or docker exec ${c.name} sh -c '…' for several.)\n`);
        return 0;
      }
      const env: Record<string, string> = {};
      for (const e of many(o, 'e', 'env')) {
        const eq = e.indexOf('=');
        if (eq > 0) env[e.slice(0, eq)] = e.slice(eq + 1);
      }
      let box;
      try {
        box = openBox(ctx, st, img, c, { user: one(o, 'u', 'user'), workdir: one(o, 'w', 'workdir'), env, pid1: mainCommand(img, c) });
      } catch (e) {
        if (e instanceof BoxError) {
          io.err(`Error response from daemon: ${e.message}\n`);
          return 126;
        }
        throw e;
      }
      box.sys.processes.push({ pid: box.sys.nextPid++, user: box.sys.user, cmd: argv.join(' '), cpu: 0, mem: 0.1 });
      const line = argv.map(shq).join(' ');
      const r = runInBox(box, line, { out: io.out, err: io.err, stdin: o.flags.has('i') ? io.stdin : '' });
      box.finish('container');
      if (r.out.startsWith('__OCI__')) {
        io.err(`OCI runtime exec failed: exec failed: unable to start container process: ${r.out.slice(7)}: unknown\n`);
        return done(r.code);
      }
      // A server started by exec keeps running in the container.
      if (r.serve && !c.serve) c.serve = r.serve;
      return done(r.code);
    }
    case 'cp':
      return done(cp(ctx, st, rest, io));
    case 'diff': {
      const c = containerOf(rest[0] ?? '');
      if (!c) return noSuch(rest[0] ?? '');
      const img = findImage(st, c.image)!;
      const lines = new Map<string, string>();
      const parents = (p: string) => {
        const parts = p.split('/').filter(Boolean);
        for (let i = 1; i < parts.length; i++) {
          const d = '/' + parts.slice(0, i).join('/');
          if (!lines.has(d)) lines.set(d, 'C');
        }
      };
      for (const p of Object.keys(c.rw?.dirs ?? {})) {
        parents(p);
        lines.set(p, img.dirs?.[p] ? 'C' : 'A');
      }
      for (const p of Object.keys(c.rw?.files ?? {})) {
        parents(p);
        const page = catalogueOf(img)?.webRoot && p === `${catalogueOf(img)!.webRoot}/index.html`;
        lines.set(p, img.files[p] !== undefined || page ? 'C' : 'A');
      }
      for (const p of c.rw?.deleted ?? []) {
        parents(p);
        lines.set(p, 'D');
      }
      for (const [p, k] of [...lines].sort(([a], [b]) => a.localeCompare(b))) io.out(`${k} ${p}\n`);
      return 0;
    }
    case 'commit': {
      const [ref, target] = rest.filter((a) => !a.startsWith('-'));
      const c = containerOf(ref ?? '');
      if (!c) return noSuch(ref ?? '');
      const img = findImage(st, c.image)!;
      const t = parseRef(target ?? '<none>:<none>');
      const out: DockerImage = structuredClone(img);
      for (const p of c.rw?.deleted ?? []) delete out.files[p];
      Object.assign(out.files, c.rw?.files ?? {});
      out.modes = { ...(out.modes ?? {}), ...(c.rw?.modes ?? {}) };
      out.owners = { ...(out.owners ?? {}), ...(c.rw?.owners ?? {}) };
      out.dirs = { ...(out.dirs ?? {}), ...(c.rw?.dirs ?? {}) };
      Object.assign(out, { repo: target ? t.repo : '<none>', tag: target ? t.tag : '<none>', id: hex('commit' + c.id + ctx.sys.now), layers: img.layers + 1, created: ctx.sys.now, history: [...(img.history ?? []), { by: 'docker commit (no Dockerfile: nobody can see how this layer was made)', sizeMb: 0.1 }] });
      delete out.repoDigests;
      st.images = st.images.filter((i) => !(i.repo === out.repo && i.tag === out.tag));
      st.images.push(out);
      io.out(`sha256:${hex(out.id, 64)}\n`);
      return done();
    }
    case 'history': {
      const o = simpleOpts(rest, ['format']);
      const img = findImage(st, o.rest[0] ?? '');
      if (!img) {
        io.err(`Error response from daemon: No such image: ${o.rest[0] ?? ''}\n`);
        return 1;
      }
      const noTrunc = o.flags.has('no-trunc');
      const rows: Array<Record<string, string>> = [];
      for (const h of [...(img.history ?? [])].reverse()) rows.push({ ID: rows.length ? '<missing>' : img.id.slice(0, 12), CreatedSince: `${ago(ctx.sys.now - img.created)} ago`, CreatedBy: noTrunc || h.by.length <= 45 ? h.by : h.by.slice(0, 44) + '…', Size: h.sizeMb < 0.001 ? '0B' : h.sizeMb < 1 ? `${Math.round(h.sizeMb * 1000)}kB` : `${h.sizeMb.toFixed(1)}MB`, Comment: 'buildkit.dockerfile.v0' });
      const baseSize = img.sizeMb - (img.history ?? []).reduce((a, h) => a + h.sizeMb, 0);
      rows.push({ ID: rows.length ? '<missing>' : img.id.slice(0, 12), CreatedSince: '3 weeks ago', CreatedBy: `/bin/sh -c #(nop) layers of ${img.base}`, Size: `${Math.max(0, baseSize).toFixed(1)}MB`, Comment: '' });
      table(io, rows, o.values.format, [['ID', 'IMAGE', 12], ['CreatedSince', 'CREATED', 12], ['CreatedBy', 'CREATED BY', 10], ['Size', 'SIZE', 6], ['Comment', 'COMMENT', 7]]);
      return 0;
    }
    case 'inspect': {
      const o = simpleOpts(rest, ['f', 'format', 'type']);
      const fmt = o.values.f ?? o.values.format;
      const out: unknown[] = [];
      let code = 0;
      for (const ref of o.rest) {
        const c = o.values.type === 'image' ? undefined : containerOf(ref);
        const img = c || o.values.type === 'volume' || o.values.type === 'network' ? undefined : findImage(st, ref);
        const vol = !c && !img && st.volumes.includes(ref) ? ref : undefined;
        const net = !c && !img && !vol && st.networks.includes(ref) ? ref : undefined;
        if (c) out.push(containerJson(ctx, st, c));
        else if (img) out.push(imageJson(img));
        else if (vol) out.push(volumeJson(st, vol));
        else if (net) out.push(networkJson(st, net));
        else {
          io.err(`Error: No such object: ${ref}\n`);
          code = 1;
        }
      }
      if (fmt) for (const x of out) io.out(goTemplate(fmt, x) + '\n');
      else io.out(JSON.stringify(out, null, 4) + '\n');
      return code;
    }
    case 'port': {
      const c = containerOf(rest[0] ?? '');
      if (!c) return noSuch(rest[0] ?? '');
      for (const p of c.ports) io.out(`${p.container}/tcp -> ${p.ip ?? '0.0.0.0'}:${p.host}\n`);
      return 0;
    }
    case 'top': {
      const c = containerOf(rest[0] ?? '');
      if (!c) return noSuch(rest[0] ?? '');
      if (c.status !== 'running') {
        io.err(`Error response from daemon: container ${c.id} is not running\n`);
        return 1;
      }
      const img = findImage(st, c.image)!;
      io.out(`UID                 PID                 PPID                C                   STIME               TTY                 TIME                CMD\n${((c.user ?? img.user) || 'root').split(':')[0].padEnd(20)}${String(c.pid ?? 0).padEnd(20)}${String((c.pid ?? 1) - 21).padEnd(20)}0                   ${new Date(c.started ?? c.created).toISOString().slice(11, 16).padEnd(20)}?                   00:00:00            ${mainCommand(img, c)}\n`);
      return 0;
    }
    case 'stats': {
      const o = simpleOpts(rest, ['format']);
      const list = (o.rest.length ? o.rest.map((r) => containerOf(r)).filter((x): x is DockerContainer => !!x) : st.containers).filter((c) => c.status === 'running' || o.flags.has('a'));
      const rows = list.map((c) => {
        const img = findImage(st, c.image);
        const used = (img?.memMb ?? catalogueOf(img ?? { base: '' })?.memMb ?? 8) * 1024 * 1024 * (c.status === 'running' ? 1 : 0);
        const limit = c.memory ?? 4123168604;
        return { ID: c.id.slice(0, 12), Container: c.id.slice(0, 12), Name: c.name, CPUPerc: `${c.status === 'running' ? (0.01 + (parseInt(c.id.slice(0, 2), 16) % 50) / 100).toFixed(2) : '0.00'}%`, MemUsage: `${humanBytes(used)} / ${humanBytes(limit)}`, MemPerc: `${((used / limit) * 100).toFixed(2)}%`, NetIO: '1.2kB / 0B', BlockIO: '0B / 0B', PIDs: c.status === 'running' ? '3' : '0' };
      });
      table(io, rows, o.values.format, [['ID', 'CONTAINER ID', 12], ['Name', 'NAME', 4], ['CPUPerc', 'CPU %', 5], ['MemUsage', 'MEM USAGE / LIMIT', 17], ['MemPerc', 'MEM %', 5], ['NetIO', 'NET I/O', 7], ['BlockIO', 'BLOCK I/O', 9], ['PIDs', 'PIDS', 4]]);
      if (!o.flags.has('no-stream')) io.out('(docker stats keeps refreshing; the simulator shows one sample. Use --no-stream in scripts.)\n');
      return 0;
    }
    case 'update': {
      const o = parseRun(rest);
      let code = 0;
      for (const ref of o.rest) {
        const c = containerOf(ref);
        if (!c) {
          code = noSuch(ref);
          continue;
        }
        const mem = one(o, 'm', 'memory');
        if (mem) c.memory = parseBytes(mem) ?? c.memory;
        const cpus = one(o, 'cpus');
        if (cpus) c.cpus = Number(cpus);
        const restart = one(o, 'restart');
        if (restart) c.restart = restart;
        io.out(ref + '\n');
      }
      return done(code);
    }
    case 'save': {
      const o = simpleOpts(rest, ['o', 'output']);
      const imgs = o.rest.map((r) => findImage(st, r));
      if (!o.rest.length || imgs.some((i) => !i)) {
        io.err(`Error response from daemon: reference does not exist\n`);
        return 1;
      }
      const dest = o.values.o ?? o.values.output;
      const payload = `#CSLAB-IMAGE-ARCHIVE\n${JSON.stringify(imgs)}\n`;
      if (!dest) {
        io.out(payload);
        return 0;
      }
      try {
        writeFile(ctx.sys.fs, abs(ctx, dest), payload, actor(ctx), ctx.sys.now);
      } catch (e) {
        io.err(`open ${dest}: ${(e as Error).message}\n`);
        return 1;
      }
      return 0;
    }
    case 'load': {
      const o = simpleOpts(rest, ['i', 'input']);
      const src = o.values.i ?? o.values.input;
      let text = io.stdin;
      if (src) {
        try {
          text = readFile(ctx.sys.fs, abs(ctx, src), actor(ctx));
        } catch {
          io.err(`open ${src}: no such file or directory\n`);
          return 1;
        }
      }
      text = text.replace(/^#CSLAB-GZ[^\n]*\n/, '');
      if (!text.startsWith('#CSLAB-IMAGE-ARCHIVE\n')) {
        io.err('Error response from daemon: unexpected EOF\n(That file is not an image archive made by docker save.)\n');
        return 1;
      }
      const imgs = JSON.parse(text.split('\n')[1]) as DockerImage[];
      for (const img of imgs) {
        st.images = st.images.filter((i) => !(i.repo === img.repo && i.tag === img.tag));
        st.images.push(img);
        io.out(`Loaded image: ${img.repo}:${img.tag}\n`);
      }
      return done();
    }
    case 'volume':
      return done(volumeCmd(ctx, st, rest, io));
    case 'network':
      return done(networkCmd(ctx, st, rest, io));
    case 'container-prune': {
      const gone = st.containers.filter((c) => c.status !== 'running');
      st.containers = st.containers.filter((c) => c.status === 'running');
      io.out(`Deleted Containers:\n${gone.map((c) => c.id + '\n').join('')}\nTotal reclaimed space: ${humanBytes(gone.length * 4096)}\n`);
      return done();
    }
    case 'image-prune': {
      const all = rest.includes('-a') || rest.includes('--all');
      const used = new Set(st.containers.map((c) => c.image));
      const gone = st.images.filter((i) => (i.repo === '<none>' || all) && !used.has(`${i.repo}:${i.tag}`) && !used.has(i.id));
      st.images = st.images.filter((i) => !gone.includes(i));
      io.out(`${gone.length ? `Deleted Images:\n${gone.map((i) => `${i.repo === '<none>' ? '' : `untagged: ${i.repo}:${i.tag}\n`}deleted: sha256:${hex(i.id, 64)}\n`).join('')}\n` : ''}Total reclaimed space: ${(gone.reduce((a, i) => a + i.sizeMb, 0)).toFixed(1)}MB\n`);
      return done();
    }
    case 'builder-prune':
      st.cache = {};
      io.out('Total:\t0B\n');
      return done();
    case 'system': {
      const [verb, ...more] = rest;
      if (verb === 'df') {
        const active = new Set(st.containers.filter((c) => c.status === 'running').map((c) => c.image));
        const size = st.images.reduce((a, i) => a + i.sizeMb, 0);
        io.out(`TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE\nImages          ${String(st.images.length).padEnd(10)}${String(st.images.filter((i) => active.has(`${i.repo}:${i.tag}`)).length).padEnd(10)}${(size.toFixed(1) + 'MB').padEnd(10)}${st.images.filter((i) => !active.has(`${i.repo}:${i.tag}`)).reduce((a, i) => a + i.sizeMb, 0).toFixed(1)}MB\nContainers      ${String(st.containers.length).padEnd(10)}${String(st.containers.filter((c) => c.status === 'running').length).padEnd(10)}0B        0B\nLocal Volumes   ${String(st.volumes.length).padEnd(10)}${String(st.volumes.filter((v) => st.containers.some((c) => c.mounts.some((m) => m.source === v))).length).padEnd(10)}0B        0B\nBuild Cache     ${String(Object.keys(st.cache ?? {}).length).padEnd(10)}0         0B        0B\n`);
        return 0;
      }
      if (verb === 'prune') {
        const all = more.includes('-a') || more.includes('--all');
        if (!more.includes('-f') && !more.includes('--force')) {
          io.out('WARNING! This will remove:\n  - all stopped containers\n  - all networks not used by at least one container\n  - all dangling images\n  - unused build cache\n\nAre you sure you want to continue? [y/N] \n(Not removed: add -f to confirm without a prompt.)\n');
          return 1;
        }
        st.containers = st.containers.filter((c) => c.status === 'running');
        const used = new Set(st.containers.map((c) => c.image));
        st.images = st.images.filter((i) => used.has(`${i.repo}:${i.tag}`) || (!all && i.repo !== '<none>'));
        st.networks = st.networks.filter((n) => !USER_NETWORK(n) || st.containers.some((c) => networksOf(c).includes(n)));
        if (more.includes('--volumes')) {
          const keep = st.volumes.filter((v) => st.containers.some((c) => c.mounts.some((m) => m.source === v)));
          for (const v of st.volumes.filter((x) => !keep.includes(x))) removeVolumeDir(ctx, v);
          st.volumes = keep;
        }
        st.cache = {};
        io.out('Total reclaimed space: 0B\n');
        return done();
      }
      io.err('Usage:  docker system COMMAND (df, prune)\n');
      return 1;
    }
  }
  io.err(`docker: '${sub}' is not a docker command.\nSee 'docker --help'\n`);
  return 1;
};

/* ----------------------------------------------------------------------------- volumes and networks */

function volumeJson(st: DockerState, name: string): Record<string, unknown> {
  const labels = st.containers.find((c) => c.mounts.some((m) => m.source === name))?.labels?.['com.docker.compose.project'];
  return { CreatedAt: '2026-01-01T00:00:00Z', Driver: 'local', Labels: labels ? { 'com.docker.compose.project': labels, 'com.docker.compose.volume': name.slice(labels.length + 1) } : null, Mountpoint: volumePath(name), Name: name, Options: null, Scope: 'local' };
}

function networkJson(st: DockerState, name: string): Record<string, unknown> {
  const sub = subnetOf(st, name);
  const members = st.containers.filter((c) => c.status === 'running' && networksOf(c).includes(name));
  return {
    Name: name,
    Id: hex('net' + name, 64),
    Scope: 'local',
    Driver: name === 'host' ? 'host' : name === 'none' ? 'null' : 'bridge',
    IPAM: { Driver: 'default', Config: name === 'host' || name === 'none' ? [] : [{ Subnet: `172.${sub}.0.0/16`, Gateway: `172.${sub}.0.1` }] },
    Internal: false,
    Containers: Object.fromEntries(members.map((c) => [c.id, { Name: c.name, IPv4Address: `${ipOf(st, c, name)}/16` }])),
    Labels: {},
  };
}

function volumeCmd(ctx: Ctx, st: DockerState, rest: string[], io: IO): number {
  const [verb, ...more] = rest;
  const o = simpleOpts(more, ['format', 'f', 'filter', 'label']);
  switch (verb) {
    case 'create': {
      const name = o.rest[0] ?? hex('vol' + ctx.sys.now + st.volumes.length, 64);
      prepareVolume(ctx, st, name);
      io.out(name + '\n');
      return 0;
    }
    case 'ls': {
      if (o.flags.has('q')) {
        for (const v of st.volumes) io.out(v + '\n');
        return 0;
      }
      table(io, st.volumes.map((v) => ({ Driver: 'local', Name: v, Mountpoint: volumePath(v) })), o.values.format, [['Driver', 'DRIVER', 6], ['Name', 'VOLUME NAME', 11]]);
      return 0;
    }
    case 'inspect': {
      const fmt = o.values.format ?? o.values.f;
      const out: unknown[] = [];
      for (const v of o.rest) {
        if (!st.volumes.includes(v)) {
          io.err(`Error response from daemon: get ${v}: no such volume\n`);
          return 1;
        }
        out.push(volumeJson(st, v));
      }
      if (fmt) for (const x of out) io.out(goTemplate(fmt, x) + '\n');
      else io.out(JSON.stringify(out, null, 4) + '\n');
      return 0;
    }
    case 'rm': {
      let code = 0;
      for (const v of o.rest) {
        if (!st.volumes.includes(v)) {
          io.err(`Error response from daemon: get ${v}: no such volume\n`);
          code = 1;
          continue;
        }
        const user = st.containers.find((c) => c.mounts.some((m) => m.kind === 'volume' && m.source === v));
        if (user && !o.flags.has('f')) {
          io.err(`Error response from daemon: remove ${v}: volume is in use - [${user.id}]\n`);
          code = 1;
          continue;
        }
        st.volumes = st.volumes.filter((x) => x !== v);
        removeVolumeDir(ctx, v);
        io.out(v + '\n');
      }
      return code;
    }
    case 'prune': {
      const all = o.flags.has('a') || o.flags.has('all');
      const unused = st.volumes.filter((v) => !st.containers.some((c) => c.mounts.some((m) => m.source === v)) && (all || /^[0-9a-f]{64}$/.test(v)));
      if (!o.flags.has('f') && !o.flags.has('force')) {
        io.out('WARNING! This will remove anonymous local volumes not used by at least one container.\nAre you sure you want to continue? [y/N] \n(Not removed: add -f to confirm without a prompt.)\n');
        return 1;
      }
      for (const v of unused) removeVolumeDir(ctx, v);
      st.volumes = st.volumes.filter((v) => !unused.includes(v));
      io.out(`${unused.length ? `Deleted Volumes:\n${unused.join('\n')}\n\n` : ''}Total reclaimed space: 0B\n`);
      return 0;
    }
  }
  io.err('Usage:  docker volume COMMAND (create, inspect, ls, prune, rm)\n');
  return 1;
}

function networkCmd(_ctx: Ctx, st: DockerState, rest: string[], io: IO): number {
  const [verb, ...more] = rest;
  const o = simpleOpts(more, ['d', 'driver', 'subnet', 'gateway', 'alias', 'format', 'f', 'ip', 'label']);
  switch (verb) {
    case 'create': {
      const name = o.rest[0];
      if (!name) {
        io.err('"docker network create" requires exactly 1 argument.\n');
        return 1;
      }
      if (st.networks.includes(name)) {
        io.err(`Error response from daemon: network with name ${name} already exists\n`);
        return 1;
      }
      st.networks.push(name);
      io.out(hex('net' + name, 64) + '\n');
      return 0;
    }
    case 'ls': {
      if (o.flags.has('q')) {
        for (const n of st.networks) io.out(hex('net' + n) + '\n');
        return 0;
      }
      table(io, st.networks.map((n) => ({ ID: hex('net' + n), Name: n, Driver: n === 'host' ? 'host' : n === 'none' ? 'null' : 'bridge', Scope: 'local' })), o.values.format, [['ID', 'NETWORK ID', 12], ['Name', 'NAME', 4], ['Driver', 'DRIVER', 6], ['Scope', 'SCOPE', 5]]);
      return 0;
    }
    case 'inspect': {
      const fmt = o.values.format ?? o.values.f;
      const out: unknown[] = [];
      for (const n of o.rest) {
        if (!st.networks.includes(n)) {
          io.err(`Error response from daemon: network ${n} not found\n`);
          return 1;
        }
        out.push(networkJson(st, n));
      }
      if (fmt) for (const x of out) io.out(goTemplate(fmt, x) + '\n');
      else io.out(JSON.stringify(out, null, 4) + '\n');
      return 0;
    }
    case 'rm': {
      let code = 0;
      for (const n of o.rest) {
        if (!st.networks.includes(n)) {
          io.err(`Error response from daemon: network ${n} not found\n`);
          code = 1;
          continue;
        }
        if (!USER_NETWORK(n)) {
          io.err(`Error response from daemon: ${n} is a pre-defined network and cannot be removed\n`);
          code = 1;
          continue;
        }
        const user = st.containers.find((c) => c.status === 'running' && networksOf(c).includes(n));
        if (user) {
          io.err(`Error response from daemon: error while removing network: network ${n} id ${hex('net' + n, 64)} has active endpoints\n`);
          code = 1;
          continue;
        }
        st.networks = st.networks.filter((x) => x !== n);
        for (const c of st.containers) {
          if (c.network === n) c.network = 'none';
          c.networks = c.networks?.filter((x) => x !== n);
        }
        io.out(n + '\n');
      }
      return code;
    }
    case 'connect':
    case 'disconnect': {
      const [net, ref] = o.rest;
      if (!st.networks.includes(net ?? '')) {
        io.err(`Error response from daemon: network ${net ?? ''} not found\n`);
        return 1;
      }
      const c = st.containers.find((k) => k.name === ref || k.id.startsWith(ref ?? '-'));
      if (!c) {
        io.err(`Error response from daemon: No such container: ${ref ?? ''}\n`);
        return 1;
      }
      if (verb === 'connect') {
        if (networksOf(c).includes(net)) {
          io.err(`Error response from daemon: endpoint with name ${c.name} already exists in network ${net}\n`);
          return 1;
        }
        if (c.network === 'none' || !c.network) c.network = net;
        else c.networks = [...(c.networks ?? []), net];
        if (o.values.alias) c.aliases = [...(c.aliases ?? []), o.values.alias];
      } else {
        if (!networksOf(c).includes(net)) {
          io.err(`Error response from daemon: container ${c.id} is not connected to network ${net}\n`);
          return 1;
        }
        if (c.network === net) {
          c.network = c.networks?.[0] ?? 'none';
          c.networks = c.networks?.slice(1);
        } else c.networks = c.networks?.filter((x) => x !== net);
      }
      return 0;
    }
    case 'prune': {
      const unused = st.networks.filter((n) => USER_NETWORK(n) && !st.containers.some((c) => networksOf(c).includes(n)));
      st.networks = st.networks.filter((n) => !unused.includes(n));
      io.out(unused.length ? `Deleted Networks:\n${unused.join('\n')}\n` : '');
      return 0;
    }
  }
  io.err('Usage:  docker network COMMAND (connect, create, disconnect, inspect, ls, prune, rm)\n');
  return 1;
}

export const DOCKER_COMMANDS: Record<string, Cmd> = { docker };
export { docker as dockerCmd, STATE, imageDigest };
