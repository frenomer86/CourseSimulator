/**
 * The container runtime behind the simulated docker, docker compose and kubectl commands.
 *
 * State lives in /var/lib/docker/state.json. An image is a base from the catalogue plus the files,
 * modes, owners, users and packages its Dockerfile added. A container is an image plus a writable
 * layer, mounts, networks and limits. Whenever something runs inside a container (its command, a
 * docker exec, a health check, a Dockerfile RUN) the runtime builds a fresh simulated Linux system
 * from those layers (a "box"), runs the real shell in it, and records what changed: into the
 * container's writable layer, into an image layer, or back into bind mounts and volumes on the host.
 *
 * Containers on the same user-defined network reach each other by name; postgres needs a few
 * seconds before it accepts connections; health checks, restart policies and OOM kills follow the
 * simulated clock, which every typed line advances.
 */

import { lookup, mkdir, readFile, remove, writeFile, type DirNode, type FsNode } from './fs.js';
import { makeCtx, newSession, runScript, type Ctx } from './shell.js';
import { buildSystem, syncEtc, type ShellSystem } from './system.js';
import type { IO } from './util.js';
import { NGINX_DEFAULT_CONF, matchLocation, nginxPage, parseNginx, pickUpstream, type NginxConf } from './nginx-conf.js';


/* ----------------------------------------------------------------------------- types */

export interface HealthConfig {
  /** ["CMD", "pg_isready"], ["CMD-SHELL", "curl -f http://localhost/ || exit 1"] or ["NONE"]. */
  test: string[];
  interval: number;
  timeout?: number;
  retries: number;
  startPeriod: number;
}

export interface ImageUser {
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups?: string[];
}

export interface DockerImage {
  repo: string;
  tag: string;
  id: string;
  sizeMb: number;
  layers: number;
  base: string;
  user: string;
  expose: number[];
  /** CMD as a shell command line (exec-form words are quoted). */
  cmd: string;
  entrypoint?: string;
  workdir: string;
  env: Record<string, string>;
  /** Files added on top of the base image: absolute container path → content. */
  files: Record<string, string>;
  /** Octal modes of files and directories that are not 644 (files) or 755 (directories). */
  modes?: Record<string, string>;
  /** "user:group" of paths not owned by root. */
  owners?: Record<string, string>;
  /** Directories the build created (path → nothing; modes and owners above). */
  dirs?: Record<string, true>;
  users?: Record<string, ImageUser>;
  groups?: Record<string, number>;
  /** Packages a RUN apk add / apt-get install / pip install added. */
  pkgs?: string[];
  health?: HealthConfig;
  /** Working set in MiB; a container with a lower --memory limit is OOM-killed. */
  memMb?: number;
  labels?: Record<string, string>;
  volumes?: string[];
  history?: Array<{ by: string; sizeMb: number }>;
  /** Registry digests: "git.lab/org/app@sha256:…". */
  repoDigests?: string[];
  /** What the base image serves over HTTP, if anything: the document root. */
  webRoot?: string;
  /** Paths the base image has that a build deleted (rm /etc/nginx/conf.d/default.conf). */
  whiteouts?: string[];
  created: number;
}

export interface Layer {
  files: Record<string, string>;
  modes?: Record<string, string>;
  owners?: Record<string, string>;
  dirs?: Record<string, true>;
  deleted?: string[];
}

export interface Mount {
  source: string;
  target: string;
  kind: 'bind' | 'volume' | 'tmpfs';
  readOnly?: boolean;
}

export interface HealthState {
  status: 'starting' | 'healthy' | 'unhealthy';
  failing: number;
  last: number;
  log: Array<{ at: number; code: number; out: string }>;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'exited' | 'created';
  exitCode: number;
  ports: Array<{ host: number; container: number; ip?: string }>;
  env: Record<string, string>;
  mounts: Mount[];
  restart: string;
  network: string;
  logs: string[];
  created: number;
  /** Replaces the image's CMD. */
  command?: string;
  entrypoint?: string;
  user?: string;
  workdir?: string;
  rw?: Layer;
  /** --memory in bytes, --cpus as a fraction. */
  memory?: number;
  cpus?: number;
  oomKilled?: boolean;
  /** Networks beyond the first, and DNS aliases on user-defined networks. */
  networks?: string[];
  aliases?: string[];
  labels?: Record<string, string>;
  healthcheck?: HealthConfig | null;
  health?: HealthState;
  started?: number;
  finished?: number;
  /** When a daemon (postgres) starts accepting connections. */
  readyAt?: number;
  /** A foreground server the command started (busybox httpd, python3 -m http.server). */
  serve?: { port: number; root: string };
  pid?: number;
  restartCount?: number;
  manualStop?: boolean;
  /** Log lines that appear later: [time, line]. */
  pend?: Array<[number, string]>;
  readOnly?: boolean;
  /** nginx's configuration as loaded at start or the last reload, and its round-robin state. */
  web?: NginxConf;
  rr?: Record<string, number[]>;
}

export interface CacheEntry {
  image: DockerImage;
  at: number;
}

export interface DockerState {
  images: DockerImage[];
  containers: DockerContainer[];
  volumes: string[];
  networks: string[];
  cache?: Record<string, CacheEntry>;
  /** Volumes with labels (compose project) and networks' subnets are derived; nothing else is stored. */
}

export const STATE = '/var/lib/docker/state.json';
export const ROOT = { user: 'root', groups: ['root'] };
export const VOLUME_DIR = '/var/lib/docker/volumes';
export const volumePath = (name: string) => `${VOLUME_DIR}/${name}/_data`;

/* ----------------------------------------------------------------------------- the image catalogue */

export type Distro = 'alpine' | 'debian' | 'ubuntu' | 'scratch';

export interface CatalogueEntry {
  sizeMb: number;
  layers: number;
  expose: number[];
  cmd: string;
  entrypoint?: string;
  user?: string;
  webRoot?: string;
  defaultPage?: string;
  /** Exits at once unless given a long-running command. */
  oneShot?: boolean;
  distro: Distro;
  /** Tools present in the base image beyond the shell and core utilities. */
  tools: string[];
  /** A long-running service the image's default command starts. */
  daemon?: 'web' | 'postgres' | 'redis' | 'hello';
  memMb: number;
  env?: Record<string, string>;
  users?: Record<string, ImageUser>;
  workdir?: string;
}

const NGINX_PAGE = '<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working.</p>\n</body>\n</html>\n';
const HTTPD_PAGE = '<html><body><h1>It works!</h1></body></html>\n';
const PY_ENV = { PYTHON_VERSION: '3.12.7', LANG: 'C.UTF-8' };
const NODE_ENV = { NODE_VERSION: '20.18.0', YARN_VERSION: '1.22.22' };
const NGINX_USER = { nginx: { uid: 101, gid: 101, home: '/nonexistent', shell: '/bin/false' } };
const NODE_USER = { node: { uid: 1000, gid: 1000, home: '/home/node', shell: '/bin/sh' } };

export const CATALOGUE: Record<string, CatalogueEntry> = {
  'nginx:1.27-alpine': { sizeMb: 47.9, layers: 8, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE, distro: 'alpine', tools: ['curl'], daemon: 'web', memMb: 8, users: NGINX_USER },
  'nginx:1.27': { sizeMb: 192, layers: 7, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE, distro: 'debian', tools: ['curl'], daemon: 'web', memMb: 9, users: NGINX_USER },
  'nginx:latest': { sizeMb: 192, layers: 7, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE, distro: 'debian', tools: ['curl'], daemon: 'web', memMb: 9, users: NGINX_USER },
  'httpd:2.4': { sizeMb: 148, layers: 6, expose: [80], cmd: 'httpd-foreground', webRoot: '/usr/local/apache2/htdocs', defaultPage: HTTPD_PAGE, distro: 'debian', tools: [], daemon: 'web', memMb: 12, workdir: '/usr/local/apache2' },
  'python:3.12-slim': { sizeMb: 125, layers: 4, expose: [], cmd: 'python3', distro: 'debian', tools: ['python3'], memMb: 20, env: PY_ENV },
  'python:3.12': { sizeMb: 1020, layers: 7, expose: [], cmd: 'python3', distro: 'debian', tools: ['python3', 'curl', 'wget', 'git', 'make', 'procps'], memMb: 20, env: PY_ENV },
  'python:latest': { sizeMb: 1020, layers: 7, expose: [], cmd: 'python3', distro: 'debian', tools: ['python3', 'curl', 'wget', 'git', 'make', 'procps'], memMb: 20, env: PY_ENV },
  'node:20-alpine': { sizeMb: 133, layers: 4, expose: [], cmd: 'node', distro: 'alpine', tools: ['node'], memMb: 40, env: NODE_ENV, users: NODE_USER },
  'node:20': { sizeMb: 1100, layers: 8, expose: [], cmd: 'node', distro: 'debian', tools: ['node', 'curl', 'wget', 'git', 'make', 'procps', 'python3'], memMb: 40, env: NODE_ENV, users: NODE_USER },
  'postgres:16': { sizeMb: 432, layers: 13, expose: [5432], cmd: 'postgres', entrypoint: 'docker-entrypoint.sh', user: 'root', distro: 'debian', tools: ['psql'], daemon: 'postgres', memMb: 45, env: { PGDATA: '/var/lib/postgresql/data', PG_MAJOR: '16' }, users: { postgres: { uid: 999, gid: 999, home: '/var/lib/postgresql', shell: '/bin/bash' } } },
  'redis:7-alpine': { sizeMb: 41, layers: 6, expose: [6379], cmd: 'redis-server', entrypoint: 'docker-entrypoint.sh', distro: 'alpine', tools: ['redis-cli'], daemon: 'redis', memMb: 4, workdir: '/data', users: { redis: { uid: 999, gid: 1000, home: '/home/redis', shell: '/sbin/nologin' } } },
  'alpine:3.20': { sizeMb: 7.8, layers: 1, expose: [], cmd: '/bin/sh', oneShot: true, distro: 'alpine', tools: [], memMb: 1 },
  'alpine:latest': { sizeMb: 7.8, layers: 1, expose: [], cmd: '/bin/sh', oneShot: true, distro: 'alpine', tools: [], memMb: 1 },
  'ubuntu:24.04': { sizeMb: 78, layers: 1, expose: [], cmd: '/bin/bash', oneShot: true, distro: 'ubuntu', tools: ['procps'], memMb: 2 },
  'debian:12-slim': { sizeMb: 74.8, layers: 1, expose: [], cmd: 'bash', oneShot: true, distro: 'debian', tools: [], memMb: 2 },
  'busybox:1.36': { sizeMb: 4.3, layers: 1, expose: [], cmd: 'sh', oneShot: true, distro: 'alpine', tools: [], memMb: 1 },
  'hello-world:latest': { sizeMb: 0.01, layers: 1, expose: [], cmd: '/hello', oneShot: true, distro: 'scratch', tools: [], daemon: 'hello', memMb: 1 },
};

export function catalogueOf(img: Pick<DockerImage, 'base'>): CatalogueEntry | undefined {
  return CATALOGUE[img.base];
}

/** The service an image's default command starts: from the catalogue, or a web server for images that only say where their document root is. */
export function daemonOf(img: DockerImage): CatalogueEntry['daemon'] {
  return catalogueOf(img)?.daemon ?? (img.webRoot ? 'web' : undefined);
}

/* ----------------------------------------------------------------------------- small helpers */

export function hex(seed: string, n = 12): string {
  let h = 2166136261;
  let out = '';
  for (let r = 0; out.length < n; r++) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) ^ r;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
}

/** Resolves b against directory a, normalising . and .. (a trailing slash is kept). */
export const joinPath = (a: string, b: string) => {
  const raw = b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`;
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/') + (/\/\.?$/.test(b) && out.length ? '/' : '');
};

/** Quotes a word for a shell command line when it needs it. */
export function shq(w: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** Splits a command line into words the way the shell would, without expansions. */
export function words(line: string): string[] {
  return (line.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1'));
}

export function parseBytes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([bkmg]?)i?b?$/i.exec(s.trim());
  if (!m) return null;
  const mult = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as 'b'];
  return Math.round(Number(m[1]) * mult);
}

export function humanBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace(/\.?0+$/, '')}GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2).replace(/\.?0+$/, '')}MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2).replace(/\.?0+$/, '')}KiB`;
  return `${n}B`;
}

export function parseDuration(s: string | undefined, dflt: number): number {
  if (!s) return dflt;
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let m: RegExpExecArray | null;
  let any = false;
  while ((m = re.exec(String(s)))) {
    any = true;
    ms += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] as 's'];
  }
  return any ? ms : /^\d+$/.test(String(s)) ? Number(s) * 1000 : dflt;
}

/* ----------------------------------------------------------------------------- state */

export function loadDocker(ctx: Ctx): DockerState {
  try {
    return JSON.parse(readFile(ctx.sys.fs, STATE, ROOT)) as DockerState;
  } catch {
    return { images: [], containers: [], volumes: [], networks: ['bridge', 'host', 'none'] };
  }
}

export function saveDocker(ctx: Ctx, st: DockerState): void {
  mkdir(ctx.sys.fs, '/var/lib/docker', ROOT, ctx.sys.now, true);
  writeFile(ctx.sys.fs, STATE, JSON.stringify(st), ROOT, ctx.sys.now);
}

/** Loads the state and brings it up to the current time: late log lines, health checks, restarts. */
export function dockerState(ctx: Ctx): DockerState {
  const st = loadDocker(ctx);
  if (reconcile(ctx, st)) saveDocker(ctx, st);
  return st;
}

/* ----------------------------------------------------------------------------- image references */

export interface Ref {
  /** "nginx", "git.lab/akan-tech/portal". */
  repo: string;
  tag: string;
  digest?: string;
  registry: string;
  /** Path inside the registry: "library/nginx", "akan-tech/portal". */
  path: string;
}

export function parseRef(ref: string): Ref {
  let r = ref.trim();
  let digest: string | undefined;
  const at = r.indexOf('@');
  if (at >= 0) {
    digest = r.slice(at + 1);
    r = r.slice(0, at);
  }
  const lastSlash = r.lastIndexOf('/');
  const colon = r.lastIndexOf(':');
  let tag = 'latest';
  if (colon > lastSlash) {
    tag = r.slice(colon + 1);
    r = r.slice(0, colon);
  }
  r = r.replace(/^docker\.io\/(library\/)?/, '');
  const first = r.split('/')[0];
  const registry = r.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost') ? first : 'docker.io';
  const path = registry === 'docker.io' ? (r.includes('/') ? r : `library/${r}`) : r.slice(registry.length + 1);
  return { repo: r, tag, digest, registry, path };
}

export const normRef = (ref: string) => {
  const p = parseRef(ref);
  return p.digest ? `${p.repo}@${p.digest}` : `${p.repo}:${p.tag}`;
};

export function imageDigest(img: DockerImage): string {
  return 'sha256:' + hex('manifest' + img.id + JSON.stringify(img.files) + img.cmd + img.base, 64);
}

export function findImage(st: DockerState, ref: string): DockerImage | undefined {
  if (!ref) return undefined;
  const p = parseRef(ref);
  if (p.digest) return st.images.find((i) => i.repo === p.repo && (i.repoDigests ?? []).some((d) => d.endsWith('@' + p.digest)));
  return st.images.find((i) => i.repo === p.repo && i.tag === p.tag) ?? (/^(sha256:)?[0-9a-f]{4,}$/.test(ref) ? st.images.find((i) => i.id.startsWith(ref.replace(/^sha256:/, ''))) : undefined);
}

export function imageFromCatalogue(ctx: Ctx, ref: string): DockerImage | null {
  return baseImage(ref, ctx.sys.now);
}

/** An official image from the catalogue, as pulled at time now. */
export function baseImage(ref: string, now = 0): DockerImage | null {
  const p = parseRef(ref);
  const key = `${p.repo}:${p.tag}`;
  const entry = CATALOGUE[key];
  if (!entry || p.registry !== 'docker.io') return null;
  return {
    repo: p.repo,
    tag: p.tag,
    id: hex('img' + key),
    sizeMb: entry.sizeMb,
    layers: entry.layers,
    base: key,
    user: entry.user ?? (entry.daemon === 'redis' ? 'root' : 'root'),
    expose: [...entry.expose],
    cmd: entry.cmd,
    ...(entry.entrypoint ? { entrypoint: entry.entrypoint } : {}),
    workdir: entry.workdir ?? '/',
    env: { ...(entry.env ?? {}) },
    files: {},
    webRoot: entry.webRoot,
    repoDigests: [`${p.repo}@sha256:${hex(key, 64)}`],
    created: now - 20 * 86400000,
  };
}

/* ----------------------------------------------------------------------------- networking */

export const USER_NETWORK = (n: string) => !['bridge', 'host', 'none'].includes(n);

export function networksOf(c: DockerContainer): string[] {
  return [c.network, ...(c.networks ?? [])].filter((n, i, a) => n && a.indexOf(n) === i);
}

export function subnetOf(st: DockerState, net: string): number {
  if (net === 'bridge') return 17;
  const user = st.networks.filter(USER_NETWORK);
  const i = user.indexOf(net);
  return 18 + (i < 0 ? user.length : i);
}

export function ipOf(st: DockerState, c: DockerContainer, net = networksOf(c)[0]): string {
  if (!net || net === 'none') return '';
  if (net === 'host') return '';
  const members = st.containers.filter((k) => networksOf(k).includes(net));
  const idx = Math.max(0, members.indexOf(c));
  return `172.${subnetOf(st, net)}.0.${2 + idx}`;
}

/** Names that resolve to c on a user-defined network: its name, its aliases, its short id. */
export function dnsNames(c: DockerContainer): string[] {
  const svc = c.labels?.['com.docker.compose.service'];
  return [c.name, c.id.slice(0, 12), ...(c.aliases ?? []), ...(svc ? [svc] : [])];
}

export interface Peer {
  name: string;
  ip: string;
  container: DockerContainer;
  /** A Kubernetes Service: its port → the pod's target port. */
  ports?: Record<number, number>;
}

/** The containers c can reach by name: running ones sharing a user-defined network. */
export function peersOf(st: DockerState, c: DockerContainer | null): Record<string, Peer> {
  const out: Record<string, Peer> = {};
  if (!c) return out;
  for (const net of networksOf(c).filter(USER_NETWORK)) {
    for (const k of st.containers) {
      if (k.status !== 'running' || !networksOf(k).includes(net)) continue;
      for (const n of dnsNames(k)) if (!out[n]) out[n] = { name: n, ip: ipOf(st, k, net), container: k };
    }
  }
  return out;
}

/* ----------------------------------------------------------------------------- reading a container's files */

function mountFor(mounts: Mount[], path: string): Mount | undefined {
  return [...mounts].sort((a, b) => b.target.length - a.target.length).find((m) => path === m.target || path.startsWith(m.target.replace(/\/$/, '') + '/'));
}

export function mountHostPath(m: Mount): string {
  return m.kind === 'volume' ? volumePath(m.source) : m.source;
}

/** A file inside a container (or image, when c is null): mounts, then the writable layer, then the image. */
export function containerFile(ctx: Ctx, img: DockerImage, c: DockerContainer | null, path: string): string | null {
  const m = c ? mountFor(c.mounts, path) : undefined;
  if (m) {
    if (m.kind === 'tmpfs') return null;
    const host = (mountHostPath(m) + '/' + path.slice(m.target.length)).replace(/\/+/g, '/').replace(/\/$/, '');
    const l = lookup(ctx.sys.fs, host, ROOT);
    return l && l.node.type === 'file' ? l.node.content : null;
  }
  if (c?.rw) {
    if (c.rw.files[path] !== undefined) return c.rw.files[path];
    if (c.rw.deleted?.includes(path)) return null;
  }
  if (img.files[path] !== undefined) return img.files[path];
  if (img.whiteouts?.includes(path)) return null;
  const entry = catalogueOf(img);
  if (entry?.webRoot && entry.defaultPage && path === `${entry.webRoot}/index.html`) return entry.defaultPage;
  if (isNginx(img) && path === NGINX_CONF) return NGINX_DEFAULT_CONF;
  return null;
}

/** The files directly inside a directory of a container: image, writable layer and mounts. */
export function containerDir(ctx: Ctx, img: DockerImage, c: DockerContainer | null, dir: string): string[] {
  const d = dir.replace(/\/$/, '');
  const names = new Set<string>();
  const m = c ? mountFor(c.mounts, d + '/x') : undefined;
  if (m && m.kind !== 'tmpfs' && (m.target.replace(/\/$/, '') === d || d.startsWith(m.target.replace(/\/$/, '') + '/'))) {
    const host = (mountHostPath(m) + '/' + d.slice(m.target.replace(/\/$/, '').length)).replace(/\/+/g, '/').replace(/\/$/, '');
    const l = lookup(ctx.sys.fs, host, ROOT);
    if (l && l.node.type === 'dir') for (const [n, child] of Object.entries(l.node.children)) if (child.type === 'file') names.add(`${d}/${n}`);
    return [...names].sort();
  }
  const add = (p: string) => {
    if (p.startsWith(d + '/') && !p.slice(d.length + 1).includes('/')) names.add(p);
  };
  Object.keys(img.files).forEach(add);
  if (isNginx(img) && !img.whiteouts?.includes(NGINX_CONF)) add(NGINX_CONF);
  Object.keys(c?.rw?.files ?? {}).forEach(add);
  for (const p of c?.rw?.deleted ?? []) names.delete(p);
  // A file mounted straight into the directory (-v ./site.conf:/etc/nginx/conf.d/site.conf).
  for (const fm of c?.mounts ?? []) if (fm.kind === 'bind' && fm.target.startsWith(d + '/') && !fm.target.slice(d.length + 1).includes('/')) names.add(fm.target);
  return [...names].sort();
}

/* ----------------------------------------------------------------------------- nginx */

export const NGINX_CONF = '/etc/nginx/conf.d/default.conf';
export const isNginx = (img: Pick<DockerImage, 'base'>) => img.base.startsWith('nginx:');

/** Reads and checks nginx's configuration (conf.d/*.conf) as the container sees it now. */
export function loadNginx(ctx: Ctx, st: DockerState, img: DockerImage, c: DockerContainer, read?: (path: string) => string | null, list?: string[]): { conf: NginxConf } | { error: string } {
  const files = (list ?? containerDir(ctx, img, c, '/etc/nginx/conf.d')).filter((p) => p.endsWith('.conf')).map((p) => ({ path: p, text: (read ? read(p) : containerFile(ctx, img, c, p)) ?? '' }));
  const peers = peersOf(st, c);
  return parseNginx(files, (h) => h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h) || !!peers[h] || dnsNames(c).includes(h));
}

function nginxRequest(ctx: Ctx, st: DockerState, c: DockerContainer, img: DockerImage, port: number, path: string, depth: number): HttpReply | 'empty' | null {
  const conf = c.web!;
  const srv = conf.servers.find((s) => s.listen.includes(port));
  if (!srv) return null;
  const loc = matchLocation(srv, path);
  if (!loc) return { status: 404, body: nginxPage(404, 'Not Found'), server: 'nginx' };
  if (loc.ret) return { status: loc.ret.code, body: loc.ret.text !== undefined ? loc.ret.text + (loc.ret.text.endsWith('\n') ? '' : '\n') : '', server: 'nginx' };
  if (loc.proxy) {
    const rest = loc.proxy.path !== undefined ? loc.proxy.path + path.slice(loc.path.length) : path;
    const targets: Array<{ host: string; port: number }> = [];
    if (loc.proxy.upstream) {
      const servers = conf.upstreams[loc.proxy.upstream] ?? [];
      const state = ((c.rr ??= {})[loc.proxy.upstream] ??= servers.map(() => 0));
      const tried = new Set<number>();
      for (let k = 0; k < servers.length; k++) {
        const i = pickUpstream(servers, state, tried);
        if (i < 0) break;
        tried.add(i);
        targets.push({ host: servers[i].host, port: servers[i].port });
      }
    } else targets.push({ host: loc.proxy.host!, port: loc.proxy.port ?? 80 });
    const peers = peersOf(st, c);
    for (const t of targets) {
      const target = t.host === 'localhost' || t.host === '127.0.0.1' ? c : peers[t.host]?.container ?? Object.values(peers).find((p) => p.ip === t.host)?.container;
      if (!target || depth > 4) continue;
      const r = target === c ? nginxRequest(ctx, st, c, img, t.port, rest, depth + 1) : containerHttp(ctx, st, target, t.port, rest);
      if (r && r !== 'empty') return r;
    }
    return { status: 502, body: nginxPage(502, 'Bad Gateway'), server: 'nginx' };
  }
  const root = loc.alias ?? loc.root ?? srv.root ?? '/usr/share/nginx/html';
  const rel = loc.alias ? path.slice(loc.path.length) : path;
  const index = loc.index ?? srv.index ?? ['index.html'];
  const want = (root + '/' + rel).replace(/\/+/g, '/');
  const body = want.endsWith('/') ? index.map((i) => containerFile(ctx, img, c, want + i)).find((b) => b !== null) ?? null : containerFile(ctx, img, c, want);
  return body === null ? { status: 404, body: nginxPage(404, 'Not Found'), server: 'nginx' } : { status: 200, body, server: 'nginx' };
}

/* ----------------------------------------------------------------------------- HTTP */

const NOT_FOUND_NGINX = '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center></body></html>\n';

export interface HttpReply {
  status: number;
  body: string;
  server: string;
}

/** What c answers to an HTTP request on its own port, or null when nothing listens there. */
export function containerHttp(ctx: Ctx, st: DockerState, c: DockerContainer, port: number, path: string): HttpReply | 'empty' | null {
  if (c.status !== 'running') return null;
  const img = findImage(st, c.image);
  if (!img) return null;
  const urlPath = (path.split('?')[0] || '/').replace(/^([^/])/, '/$1');
  if (c.serve && c.serve.port === port) {
    const want = (c.serve.root + '/' + (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath)).replace(/\/+/g, '/');
    const body = containerFile(ctx, img, c, want);
    return body === null ? { status: 404, body: '404 Not Found\n', server: 'busybox' } : { status: 200, body, server: 'busybox' };
  }
  if (c.web && isNginx(img) && !c.command) return nginxRequest(ctx, st, c, img, port, urlPath, 0);
  if (img.webRoot && daemonOf(img) === 'web' && !c.command) {
    if (!img.expose.includes(port) && port !== 80) return null;
    const want = (img.webRoot + (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath)).replace(/\/+/g, '/');
    const body = containerFile(ctx, img, c, want);
    return body === null ? { status: 404, body: NOT_FOUND_NGINX, server: img.base } : { status: 200, body, server: img.base };
  }
  if (listening(st, c, port) === 'open') return 'empty';
  return null;
}

/** Whether something in c accepts TCP connections on port right now. */
export function listening(st: DockerState, c: DockerContainer, port: number, now = Number.NaN): 'open' | 'refused' {
  if (c.status !== 'running') return 'refused';
  if (c.serve?.port === port) return 'open';
  const img = findImage(st, c.image);
  const daemon = img ? daemonOf(img) : undefined;
  if (!daemon || c.command) return 'refused';
  const ports = daemon === 'web' ? (c.web ? c.web.servers.flatMap((s) => s.listen) : [80, ...(img?.expose ?? [])]) : daemon === 'postgres' ? [5432] : daemon === 'redis' ? [6379] : [];
  if (!ports.includes(port)) return 'refused';
  if (c.readyAt !== undefined && !(now >= c.readyAt)) return 'refused';
  return 'open';
}

/** Other things that answer HTTP on a host port (kubectl port-forward registers here). */
export const HTTP_PROVIDERS: Array<(ctx: Ctx, port: number, path: string) => { body: string; server: string; status?: number } | null> = [];

/** HTTP body for a request to a published host port, or null when no container listens there. */
export function dockerHttp(ctx: Ctx, port: number, path: string): { body: string; server: string; status?: number } | null {
  for (const p of HTTP_PROVIDERS) {
    const r = p(ctx, port, path);
    if (r) return r;
  }
  if (!lookup(ctx.sys.fs, STATE, ROOT)) return null;
  const st = dockerState(ctx);
  const c = st.containers.find((k) => k.status === 'running' && k.ports.some((p) => p.host === port));
  if (!c) return null;
  const containerPort = c.ports.find((p) => p.host === port)!.container;
  const r = containerHttp(ctx, st, c, containerPort, path);
  // nginx's load-balancing position moves with every request.
  if (c.rr && Object.keys(c.rr).length) saveDocker(ctx, st);
  if (!r || r === 'empty') return { body: '', server: 'none' };
  return { body: r.body, server: r.server, status: r.status };
}

/* ----------------------------------------------------------------------------- boxes: running things inside a container */

/** What a command inside a box can see of the container world (kept out of the serialisable system). */
export interface BoxLink {
  st: DockerState;
  host: Ctx;
  self: DockerContainer | null;
  image: DockerImage;
  peers: Record<string, Peer>;
  /** Set by a foreground server command (busybox httpd -f, python3 -m http.server). */
  serve?: { port: number; root: string };
  /** Set by sleep infinity or tail -f: the process never ends by itself. */
  forever?: boolean;
  /** Set while a Dockerfile builds. */
  building?: boolean;
}

const LINKS = new WeakMap<ShellSystem, BoxLink>();
export const boxLink = (sys: ShellSystem): BoxLink | undefined => LINKS.get(sys);

/** Tools a container may have and the packages that bring them. */
export const TOOLS: Record<string, { provides: string[]; apk?: string[]; apt?: string[] }> = {
  curl: { provides: ['curl'], apk: ['curl'], apt: ['curl'] },
  wget: { provides: ['wget'], apt: ['wget'] },
  bash: { provides: ['bash'], apk: ['bash'] },
  git: { provides: ['git'], apk: ['git'], apt: ['git'] },
  jq: { provides: ['jq'], apk: ['jq'], apt: ['jq'] },
  make: { provides: ['make'], apk: ['make', 'build-base'], apt: ['make', 'build-essential'] },
  gcc: { provides: ['gcc', 'cc', 'g++'], apk: ['gcc', 'build-base', 'g++', 'musl-dev'], apt: ['gcc', 'build-essential', 'g++'] },
  procps: { provides: ['ps', 'top', 'pgrep', 'pkill', 'free', 'uptime'], apk: ['procps'], apt: ['procps'] },
  netcat: { provides: ['nc'], apk: ['netcat-openbsd'], apt: ['netcat-openbsd', 'netcat-traditional'] },
  ping: { provides: ['ping'], apt: ['iputils-ping'] },
  psql: { provides: ['psql', 'pg_isready', 'pg_dump'], apk: ['postgresql-client', 'postgresql16-client'], apt: ['postgresql-client'] },
  'redis-cli': { provides: ['redis-cli'], apk: ['redis'], apt: ['redis-tools'] },
  python3: { provides: ['python3', 'python', 'pip', 'pip3'], apk: ['python3', 'py3-pip'], apt: ['python3', 'python3-pip'] },
  node: { provides: ['node', 'npm', 'npx'], apk: ['nodejs', 'npm'], apt: ['nodejs', 'npm'] },
  tini: { provides: ['tini'], apk: ['tini'], apt: ['tini'] },
  shellcheck: { provides: ['shellcheck'], apk: ['shellcheck'], apt: ['shellcheck'] },
  openssl: { provides: ['openssl'], apk: ['openssl'], apt: ['openssl'] },
  zip: { provides: ['zip', 'unzip'], apk: ['zip', 'unzip'], apt: ['zip', 'unzip'] },
  ssh: { provides: ['ssh', 'scp', 'ssh-keygen'], apk: ['openssh-client'], apt: ['openssh-client'] },
  sudo: { provides: ['sudo'], apk: ['sudo'], apt: ['sudo'] },
  crontab: { provides: ['crontab'], apk: [], apt: ['cron'] },
};

/** Package names a package manager accepts that bring no tool of their own. */
export const QUIET_PACKAGES = ['ca-certificates', 'tzdata', 'libpq-dev', 'libpq', 'libffi-dev', 'musl-dev', 'less', 'vim', 'nano', 'gnupg', 'iproute2', 'dnsutils', 'bind-tools', 'shadow', 'su-exec', 'gosu', 'htop', 'busybox-extras', 'coreutils', 'findutils', 'grep', 'sed', 'gawk', 'tar', 'gzip', 'locales', 'libc6', 'apt-transport-https', 'lsb-release', 'software-properties-common', 'python3-venv', 'py3-virtualenv', 'nginx', 'logrotate', 'rsync', 'file', 'xz', 'xz-utils'];

export function distroOf(img: DockerImage): Distro {
  return catalogueOf(img)?.distro ?? (/alpine/.test(img.base) ? 'alpine' : 'debian');
}

const OS_RELEASE: Record<Distro, string> = {
  alpine: 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\nHOME_URL="https://alpinelinux.org/"\n',
  debian: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION="12 (bookworm)"\nVERSION_CODENAME=bookworm\nID=debian\n',
  ubuntu: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\n',
  scratch: '',
};

export interface BoxOpts {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  /** The command PID 1 runs, for ps inside the container. */
  pid1?: string;
  building?: boolean;
  now?: number;
  /** Names this box resolves, instead of the container's Docker networks (Kubernetes DNS). */
  peers?: Record<string, Peer>;
  hostname?: string;
  ip?: string;
}

export interface Box {
  sys: ShellSystem;
  ctx: Ctx;
  link: BoxLink;
  /** Records what changed. 'container' writes the writable layer and mounts; 'image' returns a layer. */
  finish(into: 'container' | 'image' | 'none'): { layer: Layer; users: Record<string, ImageUser>; groups: Record<string, number>; pkgs: string[] };
}

export class BoxError extends Error {}

type Snap = { files: Map<string, { c: string; m: number; o: string }>; dirs: Map<string, { m: number; o: string }> };

const SKIP = /^\/(proc|sys|dev)(\/|$)|^\/etc\/(passwd|group|shadow|gshadow|hostname|hosts|resolv\.conf)$/;

function snapshot(root: DirNode, skipUnder: string[]): Snap {
  const snap: Snap = { files: new Map(), dirs: new Map() };
  const rec = (p: string, n: FsNode) => {
    if (SKIP.test(p) || skipUnder.some((s) => p === s || p.startsWith(s + '/'))) return;
    if (n.type === 'dir') {
      if (p !== '/') snap.dirs.set(p, { m: n.mode & 0o7777, o: `${n.owner}:${n.group}` });
      for (const [name, child] of Object.entries(n.children)) rec(p === '/' ? `/${name}` : `${p}/${name}`, child);
    } else if (n.type === 'file') snap.files.set(p, { c: n.content, m: n.mode & 0o7777, o: `${n.owner}:${n.group}` });
  };
  rec('/', root);
  return snap;
}

function lockTree(node: FsNode): void {
  node.mode &= ~0o222;
  if (node.type === 'dir') for (const c of Object.values(node.children)) lockTree(c);
}

function copyTree(fromRoot: DirNode, from: string, toSys: ShellSystem, to: string): void {
  const l = lookup(fromRoot, from, ROOT);
  if (!l) return;
  const put = (path: string, n: FsNode) => {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/';
    if (dir !== '/') mkdir(toSys.fs, dir, ROOT, toSys.now, true);
    const parent = lookup(toSys.fs, dir, ROOT)!.node as DirNode;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (n.type === 'dir') {
      const existing = parent.children[name];
      if (!existing || existing.type !== 'dir') parent.children[name] = { type: 'dir', children: {}, mode: n.mode, owner: n.owner, group: n.group, mtime: n.mtime };
      else Object.assign(existing, { mode: n.mode, owner: n.owner, group: n.group });
      for (const [k, child] of Object.entries(n.children)) put(`${path}/${k}`, child);
    } else if (n.type === 'file') parent.children[name] = { type: 'file', content: n.content, mode: n.mode, owner: n.owner, group: n.group, mtime: n.mtime };
  };
  if (to === '/') {
    if (l.node.type === 'dir') for (const [k, child] of Object.entries(l.node.children)) put(`/${k}`, child);
  } else put(to.replace(/\/$/, ''), l.node);
}

/** Mirrors a subtree of the box back onto the host (writable bind mounts and volumes). */
function syncBack(box: ShellSystem, boxPath: string, host: Ctx, hostPath: string): void {
  const b = lookup(box.fs, boxPath, ROOT);
  if (!b) return;
  if (b.node.type === 'file') {
    writeFile(host.sys.fs, hostPath, b.node.content, ROOT, host.sys.now);
    const h = lookup(host.sys.fs, hostPath, ROOT);
    if (h) Object.assign(h.node, { mode: b.node.mode, owner: b.node.owner, group: b.node.group });
    return;
  }
  if (b.node.type !== 'dir') return;
  mkdir(host.sys.fs, hostPath, ROOT, host.sys.now, true);
  const h = lookup(host.sys.fs, hostPath, ROOT)!.node as DirNode;
  h.mode = b.node.mode;
  h.owner = b.node.owner;
  h.group = b.node.group;
  for (const name of Object.keys(h.children)) if (!b.node.children[name]) delete h.children[name];
  for (const [name, child] of Object.entries(b.node.children)) {
    if (child.type === 'dir' || child.type === 'file') syncBack(box, `${boxPath}/${name}`, host, `${hostPath}/${name}`);
  }
}

/** Ensures a named volume's directory exists, copying the image's content into it when it is new and empty. */
export function prepareVolume(ctx: Ctx, st: DockerState, name: string, img?: DockerImage, target?: string): void {
  if (!st.volumes.includes(name)) st.volumes.push(name);
  const dir = volumePath(name);
  const existed = lookup(ctx.sys.fs, dir, ROOT);
  mkdir(ctx.sys.fs, dir, ROOT, ctx.sys.now, true);
  if (existed && existed.node.type === 'dir' && Object.keys(existed.node.children).length) return;
  if (!img || !target) return;
  const prefix = target.replace(/\/$/, '') + '/';
  for (const [p, content] of Object.entries(img.files)) {
    if (!p.startsWith(prefix)) continue;
    const dest = `${dir}/${p.slice(prefix.length)}`;
    mkdir(ctx.sys.fs, dest.slice(0, dest.lastIndexOf('/')), ROOT, ctx.sys.now, true);
    writeFile(ctx.sys.fs, dest, content, ROOT, ctx.sys.now);
    const owner = img.owners?.[p];
    if (owner) {
      const n = lookup(ctx.sys.fs, dest, ROOT)!.node;
      [n.owner, n.group] = owner.split(':');
    }
  }
  const owner = img.owners?.[target.replace(/\/$/, '')];
  if (owner) {
    const n = lookup(ctx.sys.fs, dir, ROOT)!.node;
    [n.owner, n.group] = owner.split(':');
  }
}

/** Builds the simulated system a command runs in: c's layers and mounts, or an image being built. */
export function openBox(host: Ctx, st: DockerState, img: DockerImage, c: DockerContainer | null, opts: BoxOpts = {}): Box {
  const entry = catalogueOf(img);
  const distro = distroOf(img);
  const files: Record<string, { content?: string; mode?: string; owner?: string; group?: string } | null> = {};
  const legacy = !img.modes && !img.owners && !img.dirs;
  const ownerOf = (owners: Record<string, string> | undefined, p: string) => {
    const o = owners?.[p];
    return o ? { owner: o.split(':')[0], group: o.split(':')[1] ?? o.split(':')[0] } : {};
  };
  for (const p of Object.keys(img.dirs ?? {})) files[p + '/'] = { mode: img.modes?.[p] ?? '755', ...ownerOf(img.owners, p) };
  for (const [p, content] of Object.entries(img.files)) files[p] = { content, mode: img.modes?.[p] ?? (legacy ? '755' : '644'), ...ownerOf(img.owners, p) };
  if (entry?.webRoot && entry.defaultPage && img.files[`${entry.webRoot}/index.html`] === undefined && !img.whiteouts?.includes(`${entry.webRoot}/index.html`)) files[`${entry.webRoot}/index.html`] = { content: entry.defaultPage, mode: '644' };
  if (isNginx(img) && img.files[NGINX_CONF] === undefined && !img.whiteouts?.includes(NGINX_CONF)) files[NGINX_CONF] = { content: NGINX_DEFAULT_CONF, mode: '644' };
  if (entry?.webRoot) files[entry.webRoot + '/'] = files[entry.webRoot + '/'] ?? { mode: '755' };
  if (c?.rw) {
    for (const p of Object.keys(c.rw.dirs ?? {})) files[p + '/'] = { mode: c.rw.modes?.[p] ?? '755', ...ownerOf(c.rw.owners, p) };
    for (const [p, content] of Object.entries(c.rw.files)) files[p] = { content, mode: c.rw.modes?.[p] ?? '644', ...ownerOf(c.rw.owners, p) };
  }
  if (OS_RELEASE[distro]) files['/etc/os-release'] = { content: OS_RELEASE[distro], mode: '644' };
  if (distro === 'alpine') files['/etc/alpine-release'] = { content: '3.20.3\n', mode: '644' };
  if (distro === 'debian') files['/etc/debian_version'] = { content: '12.7\n', mode: '644' };
  const workdir = opts.workdir ?? c?.workdir ?? img.workdir ?? '/';
  const id = c?.id ?? hex('build' + img.id + host.sys.now, 64);
  const self = c;
  const peers = opts.peers ?? peersOf(st, c);
  const hosts: Record<string, string> = { localhost: '127.0.0.1' };
  for (const [n, p] of Object.entries(peers)) hosts[n] = p.ip;
  const ip = opts.ip ?? (c ? ipOf(st, c) : '172.17.0.250');
  const box = buildSystem({ user: 'root', hostname: opts.hostname ?? (c ? c.id.slice(0, 12) : 'buildkitsandbox'), files: files as never, cwd: '/', network: { address: `${ip || '127.0.0.1'}/16`, gateway: ip ? ip.replace(/\.\d+$/, '.1') : undefined, hosts } });
  box.now = opts.now ?? host.sys.now;
  box.container = { id, distro };
  // Users: the base image's, then the ones the build added.
  const addUser = (name: string, u: ImageUser) => {
    const gname = Object.entries(box.groups).find(([, g]) => g.gid === u.gid)?.[0] ?? name;
    if (!box.groups[gname]) box.groups[gname] = { gid: u.gid, members: [] };
    box.users[name] = { uid: u.uid, gid: u.gid, home: u.home, shell: u.shell, groups: [gname, ...(u.groups ?? [])], comment: name, password: 'locked', lastChanged: box.now };
    for (const g of u.groups ?? []) {
      if (!box.groups[g]) box.groups[g] = { gid: 2000 + Object.keys(box.groups).length, members: [] };
      if (!box.groups[g].members.includes(name)) box.groups[g].members.push(name);
    }
  };
  for (const name of Object.keys(box.users)) if (name !== 'root') delete box.users[name];
  if (distro !== 'scratch') addUser('nobody', { uid: 65534, gid: 65534, home: '/nonexistent', shell: '/usr/sbin/nologin' });
  if (distro === 'debian' || distro === 'ubuntu') addUser('www-data', { uid: 33, gid: 33, home: '/var/www', shell: '/usr/sbin/nologin' });
  for (const [n, u] of Object.entries(entry?.users ?? {})) addUser(n, u);
  for (const [g, gid] of Object.entries(img.groups ?? {})) if (!box.groups[g]) box.groups[g] = { gid, members: [] };
  for (const [n, u] of Object.entries(img.users ?? {})) addUser(n, u);
  syncEtc(box);
  // Packages: only what this image has. The tools below decide their own commands.
  const toolCommands = new Set(Object.values(TOOLS).flatMap((t) => t.provides));
  for (const p of Object.values(box.packages)) {
    if (!p.provides?.length) continue;
    p.installed = false;
    p.provides = p.provides.filter((c) => !toolCommands.has(c));
  }
  const have = new Set([...(entry?.tools ?? []), ...(img.pkgs ?? [])]);
  if (distro === 'alpine') ['wget', 'netcat', 'ping', 'procps'].forEach((t) => have.add(t));
  if (distro !== 'alpine' && distro !== 'scratch') have.add('bash');
  for (const [tool, t] of Object.entries(TOOLS)) box.packages[`tool:${tool}`] = { version: '1', description: tool, installed: have.has(tool), provides: [...t.provides] };
  // cgroup limits and the process namespace.
  const put = (p: string, text: string) => {
    mkdir(box.fs, p.slice(0, p.lastIndexOf('/')), ROOT, box.now, true);
    writeFile(box.fs, p, text, ROOT, box.now);
  };
  put('/sys/fs/cgroup/memory.max', c?.memory ? `${c.memory}\n` : 'max\n');
  put('/sys/fs/cgroup/cpu.max', c?.cpus ? `${Math.round(c.cpus * 100000)} 100000\n` : 'max 100000\n');
  put('/sys/fs/cgroup/pids.max', 'max\n');
  put('/proc/1/cgroup', '0::/\n');
  put('/etc/hosts', `127.0.0.1\tlocalhost\n${ip ? `${ip}\t${box.hostname}\n` : ''}`);
  put('/etc/resolv.conf', c && networksOf(c).some(USER_NETWORK) ? 'nameserver 127.0.0.11\noptions ndots:0\n' : 'nameserver 10.0.0.2\n');
  // Mounts: host directories and volumes appear at their targets.
  const mountTargets: string[] = [];
  for (const m of c?.mounts ?? []) {
    const target = m.target.replace(/\/$/, '') || '/';
    mountTargets.push(target);
    if (m.kind === 'tmpfs') {
      mkdir(box.fs, target, ROOT, box.now, true);
      const n = lookup(box.fs, target, ROOT)!.node as DirNode;
      n.children = {};
      n.mode = 0o1777;
      continue;
    }
    if (m.kind === 'volume') prepareVolume(host, st, m.source, img, target);
    const hostPath = mountHostPath(m);
    const hl = lookup(host.sys.fs, hostPath, ROOT);
    if (!hl) continue;
    // A mount hides what the image had at that path.
    const existing = lookup(box.fs, target, ROOT);
    if (existing && existing.node.type === 'dir' && hl.node.type === 'dir') existing.node.children = {};
    copyTree(host.sys.fs, hostPath, box, target);
    if (m.readOnly) {
      const l = lookup(box.fs, target, ROOT);
      if (l) lockTree(l.node);
    }
  }
  // The user and the working directory.
  const userSpec = opts.user ?? c?.user ?? img.user ?? 'root';
  const [uname, gname] = (userSpec || 'root').split(':');
  let user = box.users[uname] ? uname : Object.entries(box.users).find(([, u]) => String(u.uid) === uname)?.[0];
  if (!user) {
    if (!/^\d+$/.test(uname)) throw new BoxError(`unable to find user ${uname}: no matching entries in passwd file`);
    user = uname;
    box.users[user] = { uid: Number(uname), gid: Number(gname ?? uname) || Number(uname), home: '/', shell: '/bin/sh', groups: [], comment: '', password: 'locked', lastChanged: box.now };
  }
  if (!lookup(box.fs, workdir, ROOT)) mkdir(box.fs, workdir, ROOT, box.now, true);
  box.user = user;
  box.cwd = workdir;
  const home = box.users[user]?.home ?? '/';
  box.env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOSTNAME: box.hostname, HOME: home, ...img.env, ...(c?.env ?? {}), ...(opts.env ?? {}) };
  if (user !== 'root' || !box.env.USER) delete box.env.USER;
  box.processes = opts.pid1 ? [{ pid: 1, user, cmd: opts.pid1, cpu: 0.1, mem: 0.3 }] : [];
  box.nextPid = opts.pid1 ? 7 : 1;
  box.sudoers = ['root'];
  box.history = [];
  box.services = {};
  const ctx = makeCtx(box, newSession(box));
  const link: BoxLink = { st, host, self, image: img, peers, building: !!opts.building };
  LINKS.set(box, link);
  const before = snapshot(box.fs, mountTargets);
  const usersBefore = new Set(Object.keys(box.users));
  const groupsBefore = new Set(Object.keys(box.groups));
  const pkgsBefore = new Set(Object.entries(box.packages).filter(([, p]) => p.installed).map(([n]) => n));
  return {
    sys: box,
    ctx,
    link,
    finish(into) {
      const after = snapshot(box.fs, mountTargets);
      const layer: Layer = { files: {}, modes: {}, owners: {}, dirs: {}, deleted: [] };
      for (const [p, f] of after.files) {
        const b = before.files.get(p);
        if (b && b.c === f.c && b.m === f.m && b.o === f.o) continue;
        layer.files[p] = f.c;
        if (f.m !== 0o644) layer.modes![p] = f.m.toString(8);
        if (f.o !== 'root:root') layer.owners![p] = f.o;
      }
      for (const [p, d] of after.dirs) {
        const b = before.dirs.get(p);
        if (b && b.m === d.m && b.o === d.o) continue;
        layer.dirs![p] = true;
        if (d.m !== 0o755) layer.modes![p] = d.m.toString(8);
        if (d.o !== 'root:root') layer.owners![p] = d.o;
      }
      for (const p of before.files.keys()) if (!after.files.has(p)) layer.deleted!.push(p);
      for (const p of before.dirs.keys()) if (!after.dirs.has(p)) layer.deleted!.push(p);
      const users: Record<string, ImageUser> = {};
      for (const [n, u] of Object.entries(box.users)) if (!usersBefore.has(n)) users[n] = { uid: u.uid, gid: u.gid, home: u.home, shell: u.shell, groups: u.groups.slice(1) };
      const groups: Record<string, number> = {};
      for (const [g, rec] of Object.entries(box.groups)) if (!groupsBefore.has(g)) groups[g] = rec.gid;
      const pkgs = Object.entries(box.packages).filter(([n, p]) => p.installed && !pkgsBefore.has(n) && n.startsWith('tool:')).map(([n]) => n.slice(5));
      if (into === 'container' && c) {
        c.rw = mergeLayer(c.rw, layer, img);
        for (const m of c.mounts) {
          if (m.readOnly || m.kind === 'tmpfs') continue;
          syncBack(box, m.target.replace(/\/$/, '') || '/', host, mountHostPath(m));
        }
      }
      return { layer, users, groups, pkgs };
    },
  };
}

/** Puts a layer of changes on top of another (a container's writable layer, or an image). */
export function mergeLayer(base: Layer | undefined, top: Layer, img?: DockerImage): Layer {
  const out: Layer = { files: { ...(base?.files ?? {}) }, modes: { ...(base?.modes ?? {}) }, owners: { ...(base?.owners ?? {}) }, dirs: { ...(base?.dirs ?? {}) }, deleted: [...(base?.deleted ?? [])] };
  for (const p of top.deleted ?? []) {
    delete out.files[p];
    delete out.dirs![p];
    if (img && (img.files[p] !== undefined || img.dirs?.[p]) && !out.deleted!.includes(p)) out.deleted!.push(p);
  }
  Object.assign(out.files, top.files);
  Object.assign(out.modes!, top.modes ?? {});
  Object.assign(out.owners!, top.owners ?? {});
  Object.assign(out.dirs!, top.dirs ?? {});
  out.deleted = out.deleted!.filter((p) => out.files[p] === undefined);
  return out;
}

/** Applies a build layer to an image being built. */
export function applyToImage(img: DockerImage, layer: Layer): void {
  for (const p of layer.deleted ?? []) {
    delete img.files[p];
    if (img.dirs) delete img.dirs[p];
    img.whiteouts = [...new Set([...(img.whiteouts ?? []), p])];
  }
  for (const p of Object.keys(layer.files)) if (img.whiteouts?.includes(p)) img.whiteouts = img.whiteouts.filter((w) => w !== p);
  Object.assign(img.files, layer.files);
  if (Object.keys(layer.modes ?? {}).length) img.modes = { ...(img.modes ?? {}), ...layer.modes };
  if (Object.keys(layer.owners ?? {}).length) img.owners = { ...(img.owners ?? {}), ...layer.owners };
  if (Object.keys(layer.dirs ?? {}).length) img.dirs = { ...(img.dirs ?? {}), ...layer.dirs };
  if (!img.modes) img.modes = {};
}

/* ----------------------------------------------------------------------------- running commands */

export interface RunResult {
  code: number;
  out: string;
  serve?: { port: number; root: string };
  forever?: boolean;
}

/** The command line PID 1 runs: entrypoint plus command. */
export function mainCommand(img: DockerImage, c: Pick<DockerContainer, 'command' | 'entrypoint'> | null): string {
  const ep = c?.entrypoint !== undefined ? c.entrypoint : img.entrypoint ?? '';
  const cmd = c?.command !== undefined ? c.command : img.cmd;
  // The catalogue's docker-entrypoint.sh just runs its arguments.
  const epUsed = ep === 'docker-entrypoint.sh' ? '' : ep;
  return [epUsed, cmd].filter(Boolean).join(' ');
}

/** Why the runtime cannot start a program, in the OCI runtime's words, or null when it can. */
function startProblem(box: Box, line: string): { code: number; why: string } | null {
  const [prog] = words(line);
  if (!prog) return null;
  const sys = box.sys;
  const lookupProg = (p: string) => lookup(sys.fs, p, ROOT);
  if (prog.includes('/')) {
    const path = prog.startsWith('/') ? prog : joinPath(sys.cwd, prog);
    const l = lookupProg(path);
    if (!l) {
      // /bin/sh, /usr/bin/env ...: the system's own programs, if the image has them.
      const base = path.split('/').pop()!;
      if (/^\/(usr\/)?(local\/)?(s)?bin\/[^/]+$/.test(path) && (SHELL_WORDS.has(base) || COMMAND_NAMES().has(base))) {
        const owner = Object.values(sys.packages).find((p) => p.provides?.includes(base));
        if (!owner || owner.installed) return null;
      }
      return { code: 127, why: `exec: "${prog}": stat ${path}: no such file or directory` };
    }
    if (l.node.type !== 'file') return { code: 126, why: `exec: "${prog}": permission denied` };
    const u = sys.users[sys.user];
    const canX = sys.user === 'root' ? (l.node.mode & 0o111) !== 0 : (l.node.owner === sys.user ? l.node.mode & 0o100 : u && (u.groups.includes(l.node.group)) ? l.node.mode & 0o010 : l.node.mode & 0o001) !== 0;
    if (!canX) return { code: 126, why: `exec ${path}: permission denied` };
    const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(l.node.content);
    if (shebang) {
      const interp = shebang[1].endsWith('/env') ? shebang[2] ?? '' : shebang[1].split('/').pop()!;
      const owner = Object.values(sys.packages).find((p) => p.provides?.includes(interp));
      if (owner && !owner.installed) return { code: 127, why: `exec ${path}: no such file or directory` };
    }
    return null;
  }
  if (SHELL_WORDS.has(prog)) return null;
  const owner = Object.values(sys.packages).find((p) => p.provides?.includes(prog));
  if (owner && !owner.installed) return { code: 127, why: `exec: "${prog}": executable file not found in $PATH` };
  if (COMMAND_NAMES().has(prog)) return null;
  for (const dir of (sys.env.PATH ?? '').split(':')) if (lookupProg(`${dir}/${prog}`)) return null;
  return { code: 127, why: `exec: "${prog}": executable file not found in $PATH` };
}

const SHELL_WORDS = new Set(['sh', 'bash', 'exec', 'echo', 'printf', 'test', 'cd', 'set', 'export', 'true', 'false', 'sleep', 'env', 'exit']);
let commandNames: Set<string> | null = null;
let commandsRef: Record<string, unknown> | null = null;
/** Registered by commands.ts so the runtime knows which programs exist without importing it. */
export function registerCommands(cmds: Record<string, unknown>): void {
  commandsRef = cmds;
  commandNames = null;
}
function COMMAND_NAMES(): Set<string> {
  if (!commandNames) commandNames = new Set(Object.keys(commandsRef ?? {}));
  return commandNames;
}

/** Runs a command line inside a box, collecting its output. */
export function runInBox(box: Box, line: string, io?: Partial<IO> & { stdin?: string }): RunResult {
  const out: string[] = [];
  const problem = startProblem(box, line);
  if (problem) return { code: problem.code, out: `__OCI__${problem.why}` };
  const sink = (t: string) => {
    out.push(t);
  };
  const code = runScript(box.ctx, line + '\n', [], 'sh', { stdin: io?.stdin ?? '', out: io?.out ? (t) => (sink(t), io.out!(t)) : sink, err: io?.err ? (t) => (sink(t), io.err!(t)) : sink });
  return { code, out: out.join(''), serve: box.link.serve, forever: box.link.forever };
}

export const ociError = (why: string) => `docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: ${why}: unknown.`;

const lines = (text: string) => text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);

/** Starts (or restarts) a container: daemons come up, other commands run in a box. */
export function startContainer(ctx: Ctx, st: DockerState, c: DockerContainer, io?: IO, boxOpts: Partial<BoxOpts> = {}): { code: number; error?: string } {
  const img = findImage(st, c.image);
  c.started = ctx.sys.now;
  c.manualStop = false;
  c.oomKilled = false;
  c.serve = undefined;
  c.readyAt = undefined;
  c.pend = [];
  const fail = (code: number, error?: string) => {
    c.status = error ? 'created' : 'exited';
    c.exitCode = code;
    c.finished = ctx.sys.now;
    removeProcess(ctx, c);
    return { code, error };
  };
  if (!img) return fail(125, `No such image: ${c.image}`);
  const entry = catalogueOf(img);
  const need = img.memMb ?? entry?.memMb ?? 8;
  if (c.memory && need * 1024 * 1024 > c.memory) {
    c.oomKilled = true;
    c.logs.push('Killed');
    return fail(137);
  }
  const main = mainCommand(img, c);
  const daemon = daemonOf(img) && main === mainCommand(img, null) && !c.command && c.entrypoint === undefined ? daemonOf(img) : undefined;
  c.health = c.healthcheck === null ? undefined : (c.healthcheck ?? img.health) && (c.healthcheck ?? img.health)!.test[0] !== 'NONE' ? { status: 'starting', failing: 0, last: ctx.sys.now, log: [] } : undefined;
  addProcess(ctx, st, c, img, main);
  if (daemon === 'hello') {
    c.logs.push('', 'Hello from Docker!', 'This message shows that your installation appears to be working correctly.', '');
    return fail(0);
  }
  if (daemon === 'web') {
    if (isNginx(img)) {
      const loaded = loadNginx(ctx, st, img, c);
      if ('error' in loaded) {
        c.logs.push('/docker-entrypoint.sh: Configuration complete; ready for start up', `nginx: [emerg] ${loaded.error}`);
        return fail(1);
      }
      c.web = loaded.conf;
      c.rr = {};
    }
    c.logs.push('/docker-entrypoint.sh: Configuration complete; ready for start up', `${img.base.split(':')[0]}: start worker processes`);
    c.status = 'running';
    c.exitCode = 0;
    return { code: 0 };
  }
  if (daemon === 'redis') {
    c.logs.push('1:C * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo', '1:M * Ready to accept connections tcp');
    c.status = 'running';
    c.exitCode = 0;
    c.readyAt = ctx.sys.now;
    return { code: 0 };
  }
  if (daemon === 'postgres') {
    const env = withFileSecrets(ctx, img, c, { ...img.env, ...c.env });
    if (!env.POSTGRES_PASSWORD && env.POSTGRES_HOST_AUTH_METHOD !== 'trust') {
      c.logs.push('Error: Database is uninitialized and superuser password is not specified.', '       You must specify POSTGRES_PASSWORD to a non-empty value for the', '       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".');
      return fail(1);
    }
    const pgdata = env.PGDATA ?? '/var/lib/postgresql/data';
    const fresh = containerFile(ctx, img, c, `${pgdata}/PG_VERSION`) === null;
    if (fresh) {
      writeContainerFile(ctx, st, img, c, `${pgdata}/PG_VERSION`, '16\n', 'postgres:postgres');
      if (env.POSTGRES_DB) writeContainerFile(ctx, st, img, c, `${pgdata}/base/${env.POSTGRES_DB}/PG_VERSION`, '16\n', 'postgres:postgres');
      c.logs.push('The files belonging to this database system will be owned by user "postgres".', 'fixing permissions on existing directory /var/lib/postgresql/data ... ok', 'creating subdirectories ... ok', 'performing post-bootstrap initialization ... ok', 'syncing data to disk ... ok', 'Success. You can now start the database server using:', 'waiting for server to start.... done', 'server started');
      if (env.POSTGRES_DB) c.logs.push(`CREATE DATABASE`);
      c.readyAt = ctx.sys.now + 3000;
      c.pend = [
        [ctx.sys.now + 2500, 'PostgreSQL init process complete; ready for start up.'],
        [ctx.sys.now + 3000, 'LOG:  database system is ready to accept connections'],
      ];
    } else {
      c.logs.push('PostgreSQL Database directory appears to contain a database; Skipping initialization');
      c.readyAt = ctx.sys.now + 1000;
      c.pend = [[ctx.sys.now + 1000, 'LOG:  database system is ready to accept connections']];
    }
    c.status = 'running';
    c.exitCode = 0;
    return { code: 0 };
  }
  let box: Box;
  try {
    box = openBox(ctx, st, img, c, { ...boxOpts, pid1: main });
  } catch (e) {
    if (e instanceof BoxError) return fail(126, e.message);
    throw e;
  }
  const r = runInBox(box, main, io ? { out: io.out, err: io.err } : undefined);
  box.finish('container');
  if (r.out.startsWith('__OCI__')) return fail(r.code, r.out.slice(7));
  c.logs.push(...lines(r.out));
  if (r.serve) {
    c.serve = r.serve;
    c.status = 'running';
    c.exitCode = 0;
    return { code: 0 };
  }
  // sleep infinity and tail -f never end by themselves.
  if (r.forever) {
    c.status = 'running';
    c.exitCode = 0;
    return { code: 0 };
  }
  return fail(r.code);
}

function addProcess(ctx: Ctx, st: DockerState, c: DockerContainer, img: DockerImage, main: string): void {
  removeProcess(ctx, c);
  const pid = 24000 + (parseInt(c.id.slice(0, 4), 16) % 5000);
  c.pid = pid;
  ctx.sys.processes.push({ pid, user: (c.user ?? img.user ?? 'root').split(':')[0] || 'root', cmd: main || img.cmd, cpu: 0.2, mem: 0.6 });
  void st;
}

export function removeProcess(ctx: Ctx, c: DockerContainer): void {
  if (c.pid) ctx.sys.processes = ctx.sys.processes.filter((p) => p.pid !== c.pid);
}

export function stopContainer(ctx: Ctx, c: DockerContainer, code: number, manual = true): void {
  if (c.status === 'running') {
    c.status = 'exited';
    c.exitCode = code;
    c.finished = ctx.sys.now;
  }
  c.serve = undefined;
  c.health = undefined;
  if (manual) c.manualStop = true;
  removeProcess(ctx, c);
}

/** Writes a file into a container: through a mount when one covers the path, else the writable layer. */
export function writeContainerFile(ctx: Ctx, st: DockerState, img: DockerImage, c: DockerContainer, path: string, content: string, owner?: string): void {
  const m = mountFor(c.mounts, path);
  if (m && m.kind !== 'tmpfs') {
    if (m.kind === 'volume') prepareVolume(ctx, st, m.source, img, m.target);
    const host = (mountHostPath(m) + '/' + path.slice(m.target.length)).replace(/\/+/g, '/');
    mkdir(ctx.sys.fs, host.slice(0, host.lastIndexOf('/')), ROOT, ctx.sys.now, true);
    writeFile(ctx.sys.fs, host, content, ROOT, ctx.sys.now);
    if (owner) {
      const n = lookup(ctx.sys.fs, host, ROOT)!.node;
      [n.owner, n.group] = owner.split(':');
    }
    return;
  }
  c.rw = mergeLayer(c.rw, { files: { [path]: content }, owners: owner ? { [path]: owner } : {} }, img);
}

/* ----------------------------------------------------------------------------- health checks and restarts */

export function healthConfig(st: DockerState, c: DockerContainer): HealthConfig | undefined {
  if (c.healthcheck === null) return undefined;
  const h = c.healthcheck ?? findImage(st, c.image)?.health;
  return h && h.test[0] !== 'NONE' ? h : undefined;
}

/** Runs c's health check once, at time `at`. */
export function runHealthCheck(ctx: Ctx, st: DockerState, c: DockerContainer, at: number): void {
  const h = healthConfig(st, c);
  const img = findImage(st, c.image);
  if (!h || !img || c.status !== 'running') return;
  const state = (c.health ??= { status: 'starting', failing: 0, last: c.started ?? at, log: [] });
  const line = h.test[0] === 'CMD-SHELL' ? h.test.slice(1).join(' ') : h.test[0] === 'CMD' ? h.test.slice(1).map(shq).join(' ') : h.test.join(' ');
  let r: RunResult;
  try {
    const box = openBox(ctx, st, img, c, { now: at, pid1: mainCommand(img, c) });
    r = runInBox(box, line);
    box.finish('none');
  } catch {
    r = { code: 1, out: 'health check could not run\n' };
  }
  if (r.out.startsWith('__OCI__')) r = { code: 1, out: r.out.slice(7) + '\n' };
  state.last = at;
  state.log = [...state.log, { at, code: r.code, out: r.out }].slice(-5);
  if (r.code === 0) {
    state.status = 'healthy';
    state.failing = 0;
  } else if (at >= (c.started ?? 0) + h.startPeriod) {
    state.failing++;
    if (state.failing >= h.retries) state.status = 'unhealthy';
  }
}

const RESTARTS = ['always', 'unless-stopped', 'on-failure'];

/** Brings containers up to the current time. Returns whether anything changed. */
export function reconcile(ctx: Ctx, st: DockerState): boolean {
  let changed = false;
  const now = ctx.sys.now;
  for (const c of st.containers) {
    if (c.pend?.length) {
      const due = c.pend.filter(([t]) => t <= now);
      if (due.length) {
        c.logs.push(...due.map(([, l]) => l));
        c.pend = c.pend.filter(([t]) => t > now);
        changed = true;
      }
    }
    if (c.status === 'running') {
      const h = healthConfig(st, c);
      if (h && c.health && now - c.health.last >= h.interval) {
        // Catch up on the checks that would have run, at most a few.
        let t = c.health.last + h.interval;
        for (let i = 0; i < 4 && t <= now; i++, t += h.interval) runHealthCheck(ctx, st, c, t);
        if (now - c.health.last >= h.interval) runHealthCheck(ctx, st, c, now);
        changed = true;
      }
      continue;
    }
    const [policy, max] = c.restart.split(':');
    if (c.status !== 'exited' || !RESTARTS.includes(policy) || c.manualStop) continue;
    if (policy === 'on-failure' && (c.exitCode === 0 || (max && (c.restartCount ?? 0) >= Number(max)))) continue;
    const backoff = 1000 * 2 ** Math.min(c.restartCount ?? 0, 5);
    if (now < (c.finished ?? 0) + backoff) continue;
    c.restartCount = (c.restartCount ?? 0) + 1;
    startContainer(ctx, st, c);
    changed = true;
  }
  return changed;
}

/* ----------------------------------------------------------------------------- Go templates (--format) */

type Val = unknown;

function goString(v: Val): string {
  if (v === undefined || v === null) return '<no value>';
  if (Array.isArray(v)) return `[${v.map(goString).join(' ')}]`;
  if (typeof v === 'object') return `map[${Object.entries(v as Record<string, Val>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${k}:${goString(x)}`).join(' ')}]`;
  return String(v);
}

/** A small subset of Go's text/template: fields, json, index, range, if/else, join, upper, lower, len, printf. */
export function goTemplate(tpl: string, data: Val): string {
  const src = tpl.replace(/\\t/g, '\t').replace(/\\n/g, '\n');
  type Tok = { text: string } | { act: string };
  const toks: Tok[] = [];
  const re = /\{\{(-?)\s*([\s\S]*?)\s*(-?)\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let trimNext = false;
  while ((m = re.exec(src))) {
    let text = src.slice(last, m.index);
    if (trimNext) text = text.replace(/^\s+/, '');
    if (m[1]) text = text.replace(/\s+$/, '');
    if (text) toks.push({ text });
    toks.push({ act: m[2] });
    trimNext = !!m[3];
    last = re.lastIndex;
  }
  let tail = src.slice(last);
  if (trimNext) tail = tail.replace(/^\s+/, '');
  if (tail) toks.push({ text: tail });
  let i = 0;
  const field = (dot: Val, path: string): Val => {
    if (path === '.') return dot;
    let cur: Val = dot;
    for (const part of path.split('.').filter(Boolean)) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, Val>)[part];
      else return undefined;
    }
    return cur;
  };
  const argVal = (dot: Val, a: string): Val => {
    if (/^".*"$/.test(a)) return a.slice(1, -1).replace(/\\t/g, '\t').replace(/\\n/g, '\n');
    if (/^-?\d+$/.test(a)) return Number(a);
    if (a.startsWith('.')) return field(dot, a);
    if (a.startsWith('$')) return field(dot, a.slice(1) || '.');
    return a;
  };
  const evalExpr = (dot: Val, expr: string): Val => {
    const stages = expr.split('|').map((s) => s.trim());
    let val: Val = undefined;
    stages.forEach((stage, si) => {
      const parts = stage.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
      const [fn, ...rest] = parts;
      const args = rest.map((a) => (a.startsWith('(') ? undefined : argVal(dot, a)));
      if (si > 0) args.push(val);
      switch (fn) {
        case 'json':
          val = JSON.stringify(args[0] ?? null);
          break;
        case 'index': {
          let v = args[0];
          for (const k of args.slice(1)) v = v && typeof v === 'object' ? (v as Record<string, Val>)[String(k)] : undefined;
          val = v;
          break;
        }
        case 'join':
          val = Array.isArray(args[0]) ? (args[0] as Val[]).map(String).join(String(args[1] ?? '')) : '';
          break;
        case 'upper':
          val = String(args[0] ?? '').toUpperCase();
          break;
        case 'lower':
          val = String(args[0] ?? '').toLowerCase();
          break;
        case 'len':
          val = Array.isArray(args[0]) ? args[0].length : args[0] && typeof args[0] === 'object' ? Object.keys(args[0]).length : String(args[0] ?? '').length;
          break;
        case 'printf': {
          let k = 1;
          val = String(args[0] ?? '').replace(/%[sdvq]/g, (f) => (f === '%q' ? JSON.stringify(String(args[k++])) : goString(args[k++])));
          break;
        }
        case 'println':
          val = args.map(goString).join(' ') + '\n';
          break;
        case 'title':
          val = String(args[0] ?? '').replace(/\b\w/g, (x) => x.toUpperCase());
          break;
        default:
          val = argVal(dot, fn ?? '');
      }
    });
    return val;
  };
  const truthy = (v: Val) => !(v === undefined || v === null || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length));
  const run = (dot: Val, stopAt: string[]): { out: string; stop: string } => {
    let out = '';
    while (i < toks.length) {
      const t = toks[i++];
      if ('text' in t) {
        out += t.text;
        continue;
      }
      const a = t.act;
      if (stopAt.some((s) => a === s || a.startsWith(s + ' '))) return { out, stop: a };
      if (a.startsWith('range ')) {
        const coll = evalExpr(dot, a.slice(6));
        const start = i;
        const items = Array.isArray(coll) ? coll : coll && typeof coll === 'object' ? Object.keys(coll as object).sort().map((k) => (coll as Record<string, Val>)[k]) : [];
        if (!items.length) {
          run(dot, ['end']);
          continue;
        }
        let end = start;
        for (const item of items) {
          i = start;
          out += run(item, ['end']).out;
          end = i;
        }
        i = end;
        continue;
      }
      if (a.startsWith('if ') || a.startsWith('with ')) {
        const isWith = a.startsWith('with ');
        const v = evalExpr(dot, a.slice(isWith ? 5 : 3));
        if (truthy(v)) {
          const r = run(isWith ? v : dot, ['else', 'end']);
          out += r.out;
          if (r.stop === 'else') run(dot, ['end']);
        } else {
          const r = run(dot, ['else', 'end']);
          if (r.stop === 'else') out += run(dot, ['end']).out;
        }
        continue;
      }
      if (a.startsWith('/*')) continue;
      const v = evalExpr(dot, a);
      out += typeof v === 'string' ? v : goString(v);
    }
    return { out, stop: '' };
  };
  return run(data, []).out;
}

/* ----------------------------------------------------------------------------- misc for the CLI */

export function removeVolumeDir(ctx: Ctx, name: string): void {
  try {
    remove(ctx.sys.fs, `${VOLUME_DIR}/${name}`, ROOT, true);
  } catch {
    /* already gone */
  }
}

export function ago(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? 'About a minute' : `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return h === 1 ? 'About an hour' : `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** The STATUS column of docker ps. */
export function statusText(ctx: Ctx, c: DockerContainer): string {
  const now = ctx.sys.now;
  if (c.status === 'created') return 'Created';
  if (c.status === 'exited') return `Exited (${c.exitCode}) ${ago(now - (c.finished ?? c.created))} ago`;
  const health = c.health ? ` (${c.health.status === 'starting' ? 'health: starting' : c.health.status})` : '';
  return `Up ${ago(now - (c.started ?? c.created))}${health}`;
}

/** The official images read NAME_FILE variables (POSTGRES_PASSWORD_FILE=/run/secrets/db): the file's content becomes NAME. */
export function withFileSecrets(ctx: Ctx, img: DockerImage, c: DockerContainer, env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (!k.endsWith('_FILE') || !/^(POSTGRES|MYSQL|MARIADB|REDIS)_/.test(k)) continue;
    const content = containerFile(ctx, img, c, v);
    if (content !== null) out[k.slice(0, -5)] = content.replace(/\r?\n$/, '');
  }
  return out;
}
