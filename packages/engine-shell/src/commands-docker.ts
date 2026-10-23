/**
 * A simulated Docker engine for the terminal. State lives in /var/lib/docker/state.json inside the
 * simulated file system. Images come from a small catalogue of real names and sizes, or are built
 * from a Dockerfile (FROM, WORKDIR, COPY/ADD with --from, RUN, ENV, EXPOSE, USER, CMD, ENTRYPOINT,
 * multi-stage with AS). Containers record ports, environment, mounts and restart policy; web
 * servers (nginx, httpd) answer curl on their published ports.
 */

import { lookup, mkdir, readFile, writeFile, type DirNode } from './fs.js';
import { actor, currentUser, type Ctx } from './shell.js';
import { abs, parseOpts, type IO } from './util.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

export interface DockerImage {
  repo: string;
  tag: string;
  id: string;
  sizeMb: number;
  layers: number;
  base: string;
  user: string;
  expose: number[];
  cmd: string;
  workdir: string;
  env: Record<string, string>;
  /** Files added on top of the base image: absolute container path → content. */
  files: Record<string, string>;
  /** What the base image serves over HTTP, if anything: the document root. */
  webRoot?: string;
  created: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: 'running' | 'exited';
  exitCode: number;
  ports: Array<{ host: number; container: number }>;
  env: Record<string, string>;
  mounts: Array<{ source: string; target: string; kind: 'bind' | 'volume' }>;
  restart: string;
  network: string;
  logs: string[];
  created: number;
}

export interface DockerState {
  images: DockerImage[];
  containers: DockerContainer[];
  volumes: string[];
  networks: string[];
}

const STATE = '/var/lib/docker/state.json';
const ROOT = { user: 'root', groups: ['root'] };

interface CatalogueEntry {
  sizeMb: number;
  layers: number;
  expose: number[];
  cmd: string;
  user?: string;
  webRoot?: string;
  defaultPage?: string;
  /** Exits at once unless given a long-running command. */
  oneShot?: boolean;
}

const NGINX_PAGE = '<!DOCTYPE html>\n<html>\n<head><title>Welcome to nginx!</title></head>\n<body>\n<h1>Welcome to nginx!</h1>\n<p>If you see this page, the nginx web server is successfully installed and working.</p>\n</body>\n</html>\n';
const HTTPD_PAGE = '<html><body><h1>It works!</h1></body></html>\n';

const CATALOGUE: Record<string, CatalogueEntry> = {
  'nginx:1.27-alpine': { sizeMb: 47.9, layers: 8, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE },
  'nginx:1.27': { sizeMb: 192, layers: 7, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE },
  'nginx:latest': { sizeMb: 192, layers: 7, expose: [80], cmd: 'nginx -g "daemon off;"', webRoot: '/usr/share/nginx/html', defaultPage: NGINX_PAGE },
  'httpd:2.4': { sizeMb: 148, layers: 6, expose: [80], cmd: 'httpd-foreground', webRoot: '/usr/local/apache2/htdocs', defaultPage: HTTPD_PAGE },
  'python:3.12-slim': { sizeMb: 125, layers: 4, expose: [], cmd: 'python3' },
  'python:3.12': { sizeMb: 1020, layers: 7, expose: [], cmd: 'python3' },
  'python:latest': { sizeMb: 1020, layers: 7, expose: [], cmd: 'python3' },
  'node:20-alpine': { sizeMb: 133, layers: 4, expose: [], cmd: 'node' },
  'node:20': { sizeMb: 1100, layers: 8, expose: [], cmd: 'node' },
  'postgres:16': { sizeMb: 432, layers: 13, expose: [5432], cmd: 'postgres', user: 'postgres' },
  'redis:7-alpine': { sizeMb: 41, layers: 6, expose: [6379], cmd: 'redis-server' },
  'alpine:3.20': { sizeMb: 7.8, layers: 1, expose: [], cmd: '/bin/sh', oneShot: true },
  'alpine:latest': { sizeMb: 7.8, layers: 1, expose: [], cmd: '/bin/sh', oneShot: true },
  'ubuntu:24.04': { sizeMb: 78, layers: 1, expose: [], cmd: '/bin/bash', oneShot: true },
  'hello-world:latest': { sizeMb: 0.01, layers: 1, expose: [], cmd: '/hello', oneShot: true },
};

function hex(seed: string, n = 12): string {
  let h = 2166136261;
  let out = '';
  for (let r = 0; out.length < n; r++) {
    for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) ^ r;
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, n);
}

const normRef = (ref: string) => (ref.includes(':') ? ref : `${ref}:latest`);

export function loadDocker(ctx: Ctx): DockerState {
  try {
    return JSON.parse(readFile(ctx.sys.fs, STATE, ROOT)) as DockerState;
  } catch {
    return { images: [], containers: [], volumes: [], networks: ['bridge', 'host', 'none'] };
  }
}

function saveDocker(ctx: Ctx, st: DockerState): void {
  mkdir(ctx.sys.fs, '/var/lib/docker', ROOT, ctx.sys.now, true);
  writeFile(ctx.sys.fs, STATE, JSON.stringify(st), ROOT, ctx.sys.now);
}

function findImage(st: DockerState, ref: string): DockerImage | undefined {
  const r = normRef(ref);
  return st.images.find((i) => `${i.repo}:${i.tag}` === r || i.id.startsWith(ref));
}

function pullImage(ctx: Ctx, st: DockerState, ref: string, io: IO, quiet = false): DockerImage | null {
  const r = normRef(ref);
  const existing = findImage(st, r);
  if (existing) return existing;
  const entry = CATALOGUE[r];
  if (!entry) {
    io.err(`Error response from daemon: pull access denied for ${r.split(':')[0]}, repository does not exist or may require 'docker login'.\n(This lab's registry has: ${Object.keys(CATALOGUE).join(', ')}.)\n`);
    return null;
  }
  const [repo, tag] = r.split(':');
  if (!quiet) io.out(`${tag}: Pulling from library/${repo}\n${Array.from({ length: entry.layers }, (_, i) => `${hex(r + i)}: Pull complete\n`).join('')}Digest: sha256:${hex(r, 64)}\nStatus: Downloaded newer image for ${r}\ndocker.io/library/${r}\n`);
  const img: DockerImage = { repo, tag, id: hex('img' + r), sizeMb: entry.sizeMb, layers: entry.layers, base: r, user: entry.user ?? 'root', expose: entry.expose, cmd: entry.cmd, workdir: '/', env: {}, files: {}, webRoot: entry.webRoot, created: ctx.sys.now };
  st.images.push(img);
  return img;
}

function hostFiles(ctx: Ctx, path: string): Record<string, string> | null {
  const a = actor(ctx);
  const l = lookup(ctx.sys.fs, path, a);
  if (!l) return null;
  if (l.node.type === 'file') return { '': l.node.content };
  if (l.node.type !== 'dir') return null;
  const out: Record<string, string> = {};
  const visit = (n: DirNode, rel: string) => {
    for (const [name, child] of Object.entries(n.children)) {
      const p = rel ? `${rel}/${name}` : name;
      if (child.type === 'dir') visit(child, p);
      else if (child.type === 'file') out[p] = child.content;
    }
  };
  visit(l.node, '');
  return out;
}

const joinPath = (a: string, b: string) => (b.startsWith('/') ? b : `${a.replace(/\/$/, '')}/${b}`).replace(/\/+/g, '/');

/** Parses JSON-array or shell form of CMD/ENTRYPOINT into one string. */
function cmdText(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      return (JSON.parse(t) as string[]).join(' ');
    } catch {
      return t;
    }
  }
  return t;
}

function build(ctx: Ctx, st: DockerState, tag: string, contextDir: string, dockerfile: string, io: IO): number {
  let text: string;
  try {
    text = readFile(ctx.sys.fs, dockerfile, actor(ctx));
  } catch {
    io.err(`ERROR: failed to read dockerfile: open ${dockerfile}: no such file or directory\n`);
    return 1;
  }
  const lines = text.replace(/\\\n/g, ' ').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const stages: Record<string, DockerImage> = {};
  let cur: DockerImage | null = null;
  let step = 0;
  const total = lines.length;
  for (const line of lines) {
    step++;
    const sp = line.search(/\s/);
    const instr = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1).trim();
    io.out(`#${step + 1} [${step}/${total}] ${instr} ${arg}\n`);
    if (instr !== 'FROM' && !cur) {
      io.err(`ERROR: ${instr} before FROM: every Dockerfile starts with FROM <image>\n`);
      return 1;
    }
    switch (instr) {
      case 'FROM': {
        const m = /^(\S+)(?:\s+AS\s+(\S+))?$/i.exec(arg);
        if (!m) {
          io.err('ERROR: FROM needs an image, for example FROM python:3.12-slim\n');
          return 1;
        }
        const from = stages[m[1]] ?? pullImage(ctx, st, m[1], io, true);
        if (!from) return 1;
        cur = { ...from, files: { ...from.files }, env: { ...from.env }, expose: [...from.expose], base: stages[m[1]] ? from.base : normRef(m[1]) };
        if (m[2]) stages[m[2]] = cur;
        break;
      }
      case 'WORKDIR':
        cur!.workdir = joinPath(cur!.workdir, arg);
        break;
      case 'COPY':
      case 'ADD': {
        const parts = arg.split(/\s+/);
        let fromStage: string | undefined;
        while (parts[0]?.startsWith('--')) {
          const opt = parts.shift()!;
          if (opt.startsWith('--from=')) fromStage = opt.slice(7);
        }
        if (parts.length < 2) {
          io.err(`ERROR: ${instr} needs a source and a destination\n`);
          return 1;
        }
        const dest = joinPath(cur!.workdir, parts.pop()!);
        let added = 0;
        for (const src of parts) {
          if (fromStage) {
            const stage = stages[fromStage];
            if (!stage) {
              io.err(`ERROR: no build stage called ${fromStage}\n`);
              return 1;
            }
            const srcPath = joinPath(stage.workdir, src);
            for (const [p, c] of Object.entries(stage.files)) {
              if (p === srcPath || p.startsWith(srcPath.replace(/\/$/, '') + '/')) {
                const relp = p === srcPath ? p.split('/').pop()! : p.slice(srcPath.replace(/\/$/, '').length + 1);
                cur!.files[dest.endsWith('/') || Object.keys(stage.files).length > 1 ? joinPath(dest, relp) : dest] = c;
                added += c.length;
              }
            }
            continue;
          }
          const files = hostFiles(ctx, src === '.' ? contextDir : joinPath(contextDir, src));
          if (!files) {
            io.err(`ERROR: failed to compute cache key: "/${src}": not found\n`);
            return 1;
          }
          for (const [p, c] of Object.entries(files)) {
            if (p.startsWith('.git/') || p === 'Dockerfile') continue;
            const target = p === '' ? (dest.endsWith('/') ? joinPath(dest, src.split('/').pop()!) : dest) : joinPath(dest, p);
            cur!.files[target] = c;
            added += c.length;
          }
        }
        cur!.layers++;
        cur!.sizeMb = Math.round((cur!.sizeMb + added / 1e6) * 100) / 100;
        break;
      }
      case 'RUN': {
        let mb = 0.5;
        if (/pip\s+install/.test(arg)) mb += /--no-cache-dir/.test(arg) ? 18 : 45;
        if (/apt-get\s+install|apk\s+add/.test(arg)) mb += /rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(arg) || /--no-cache/.test(arg) ? 30 : 85;
        if (/npm\s+(ci|install)/.test(arg)) mb += 60;
        if (/useradd|adduser/.test(arg)) mb += 0.1;
        cur!.layers++;
        cur!.sizeMb = Math.round((cur!.sizeMb + mb) * 100) / 100;
        break;
      }
      case 'ENV': {
        const m = /^(\w+)(?:=|\s+)(.*)$/.exec(arg);
        if (m) cur!.env[m[1]] = m[2].replace(/^"|"$/g, '');
        break;
      }
      case 'EXPOSE':
        for (const p of arg.split(/\s+/)) {
          const port = Number(p.split('/')[0]);
          if (!cur!.expose.includes(port)) cur!.expose.push(port);
        }
        break;
      case 'USER':
        cur!.user = arg;
        break;
      case 'CMD':
      case 'ENTRYPOINT':
        cur!.cmd = cmdText(arg);
        break;
      case 'LABEL':
      case 'ARG':
      case 'HEALTHCHECK':
      case 'VOLUME':
        break;
      default:
        io.err(`ERROR: unknown instruction: ${instr}\n`);
        return 1;
    }
  }
  if (!cur) {
    io.err('ERROR: the Dockerfile is empty\n');
    return 1;
  }
  const [repo, t] = normRef(tag).split(':');
  st.images = st.images.filter((i) => !(i.repo === repo && i.tag === t));
  const img: DockerImage = { ...cur, repo, tag: t, id: hex('build' + tag + JSON.stringify(cur.files) + cur.cmd + cur.user), created: ctx.sys.now };
  st.images.push(img);
  io.out(`#${total + 2} exporting to image\n#${total + 2} naming to docker.io/library/${repo}:${t} done\n`);
  return 0;
}

/** HTTP body for a request to a published host port, or null when no container listens there. */
export function dockerHttp(ctx: Ctx, port: number, path: string): { body: string; server: string } | null {
  if (!lookup(ctx.sys.fs, STATE, ROOT)) return null;
  const st = loadDocker(ctx);
  const c = st.containers.find((k) => k.status === 'running' && k.ports.some((p) => p.host === port));
  if (!c) return null;
  const img = findImage(st, c.image);
  const containerPort = c.ports.find((p) => p.host === port)!.container;
  if (!img?.webRoot || !img.expose.includes(containerPort)) return { body: '', server: 'none' };
  const urlPath = (path.split('?')[0] || '/').replace(/^([^/])/, '/$1');
  const want = (img.webRoot + (urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath)).replace(/\/+/g, "/");
  for (const m of c.mounts) {
    if (want === m.target || want.startsWith(m.target.replace(/\/$/, '') + '/')) {
      const hostPath = m.kind === 'bind' ? (m.source + '/' + want.slice(m.target.length)).split('/').filter(Boolean).reduce((acc, part) => acc + '/' + part, '') : '';
      try {
        return { body: readFile(ctx.sys.fs, hostPath, ROOT), server: img.base };
      } catch {
        return { body: '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center></body></html>\n', server: img.base };
      }
    }
  }
  if (img.files[want] !== undefined) return { body: img.files[want], server: img.base };
  const entry = CATALOGUE[img.base];
  if (want === `${img.webRoot}/index.html` && entry?.defaultPage) return { body: entry.defaultPage, server: img.base };
  return { body: '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center></body></html>\n', server: img.base };
}

function portsText(c: DockerContainer): string {
  return c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(', ');
}

const docker: Cmd = (args, io, ctx) => {
  const user = currentUser(ctx);
  const inGroup = ctx.sys.users[user]?.groups?.includes('docker') || ctx.sys.groups.docker?.members.includes(user);
  if (user !== 'root' && !inGroup) {
    io.err('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n(Use sudo, or add yourself to the docker group with: sudo usermod -aG docker $USER)\n');
    return 1;
  }
  if (ctx.sys.services.docker && !ctx.sys.services.docker.active) {
    io.err('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    return 1;
  }
  let [sub, ...rest] = args;
  if (sub === 'container' || sub === 'image') {
    const [verb, ...more] = rest;
    sub = verb === 'ls' ? (sub === 'image' ? 'images' : 'ps') : verb;
    rest = more;
  }
  const st = loadDocker(ctx);
  const done = (code = 0) => {
    saveDocker(ctx, st);
    return code;
  };
  const containerOf = (ref: string) => st.containers.find((c) => c.name === ref || c.id.startsWith(ref));

  switch (sub) {
    case undefined:
    case 'help':
    case '--help':
      io.out('Usage:  docker [OPTIONS] COMMAND\n\nCommands: run, ps, images, pull, build, stop, start, restart, rm, rmi, logs, exec, inspect, volume, network, version\n');
      return 0;
    case 'version':
    case '--version':
      io.out('Docker version 27.3.1, build ce12230\n');
      return 0;
    case 'info':
      io.out(`Containers: ${st.containers.length}\n Running: ${st.containers.filter((c) => c.status === 'running').length}\nImages: ${st.images.length}\nServer Version: 27.3.1\nStorage Driver: overlay2\n`);
      return 0;
    case 'pull': {
      const ref = rest.find((x) => !x.startsWith('-'));
      if (!ref) {
        io.err('"docker pull" requires exactly 1 argument.\n');
        return 1;
      }
      return pullImage(ctx, st, ref, io) ? done() : 1;
    }
    case 'images': {
      io.out('REPOSITORY        TAG            IMAGE ID       CREATED        SIZE\n');
      for (const i of st.images) io.out(`${i.repo.padEnd(18)}${i.tag.padEnd(15)}${i.id.padEnd(15)}${'2 minutes ago'.padEnd(15)}${i.sizeMb >= 1000 ? (i.sizeMb / 1000).toFixed(2) + 'GB' : i.sizeMb + 'MB'}\n`);
      return 0;
    }
    case 'rmi': {
      for (const ref of rest.filter((x) => !x.startsWith('-'))) {
        const img = findImage(st, ref);
        if (!img) {
          io.err(`Error response from daemon: No such image: ${ref}\n`);
          return done(1);
        }
        const user = st.containers.find((c) => c.image === `${img.repo}:${img.tag}`);
        if (user && !rest.includes('-f')) {
          io.err(`Error response from daemon: conflict: unable to remove repository reference "${ref}" (must force) - container ${user.id} is using its referenced image\n`);
          return done(1);
        }
        st.images = st.images.filter((i) => i !== img);
        io.out(`Untagged: ${img.repo}:${img.tag}\nDeleted: sha256:${img.id}\n`);
      }
      return done();
    }
    case 'build': {
      const o = parseOpts(rest, ['t', 'tag', 'f', 'file']);
      const tag = o.values.t ?? o.values.tag;
      const contextArg = o.rest[0];
      if (!contextArg) {
        io.err('ERROR: "docker buildx build" requires exactly 1 argument. Did you forget the "." for the build context?\n');
        return 1;
      }
      if (!tag) {
        io.err('Tag your image with -t name:version so you can run it, for example docker build -t portal:1.0 .\n');
        return 1;
      }
      const ctxDir = abs(ctx, contextArg);
      const file = o.values.f ?? o.values.file ? abs(ctx, (o.values.f ?? o.values.file)!) : joinPath(ctxDir, 'Dockerfile');
      const code = build(ctx, st, tag, ctxDir, file, io);
      return done(code);
    }
    case 'run': {
      const o = parseOpts(rest, ['name', 'p', 'publish', 'e', 'env', 'v', 'volume', 'restart', 'network', 'w'], {}, true);
      // parseOpts keeps only the last value of a repeated option, so collect -p, -e and -v by hand.
      const WITH_VALUE = new Set(['-p', '--publish', '-e', '--env', '-v', '--volume', '--name', '--restart', '--network', '-w']);
      const many = (short: string, long: string) => {
        const vals: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          const t = rest[i];
          if (!t.startsWith('-')) break; // the image name: options end here
          if (t === `-${short}` || t === `--${long}`) vals.push(rest[i + 1] ?? '');
          else if (t.startsWith(`--${long}=`)) vals.push(t.slice(long.length + 3));
          if (WITH_VALUE.has(t)) i++;
        }
        return vals;
      };
      const imageRef = o.rest[0];
      if (!imageRef) {
        io.err('"docker run" requires at least 1 argument.\n');
        return 1;
      }
      const img = pullImage(ctx, st, imageRef, io, !!findImage(st, imageRef));
      if (!img) return done(1);
      const name = o.values.name ?? `${['brave', 'calm', 'eager', 'kind'][st.containers.length % 4]}_${['akan', 'ewe', 'ga', 'dagbani'][st.containers.length % 4]}`;
      if (st.containers.some((c) => c.name === name)) {
        io.err(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use. Remove it with docker rm ${name}.\n`);
        return done(125);
      }
      const ports: DockerContainer['ports'] = [];
      for (const p of many('p', 'publish')) {
        const m = /^(?:[\d.]+:)?(\d+):(\d+)(?:\/tcp)?$/.exec(p);
        if (!m) {
          io.err(`docker: invalid publish "${p}": use HOST:CONTAINER, for example -p 8080:80\n`);
          return done(125);
        }
        const host = Number(m[1]);
        const used = st.containers.some((c) => c.status === 'running' && c.ports.some((q) => q.host === host)) || Object.values(ctx.sys.services).some((s) => s.active && s.port === host);
        if (used) {
          io.err(`docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:${host} failed: port is already allocated.\n`);
          return done(125);
        }
        ports.push({ host, container: Number(m[2]) });
      }
      const env: Record<string, string> = { ...img.env };
      for (const e of many('e', 'env')) {
        const [k, ...v] = e.split('=');
        env[k] = v.join('=');
      }
      const mounts: DockerContainer['mounts'] = [];
      for (const v of many('v', 'volume')) {
        const [src, target] = v.split(':');
        if (!target) {
          io.err(`docker: invalid volume "${v}": use SOURCE:TARGET\n`);
          return done(125);
        }
        const isBind = src.startsWith('/') || src.startsWith('.') || src.startsWith('~') || src.startsWith('$');
        if (isBind) {
          const hostPath = abs(ctx, src);
          if (!lookup(ctx.sys.fs, hostPath, actor(ctx))) {
            io.err(`docker: Error response from daemon: invalid mount config: bind source path does not exist: ${hostPath}\n`);
            return done(125);
          }
          mounts.push({ source: hostPath, target, kind: 'bind' });
        } else {
          if (!st.volumes.includes(src)) st.volumes.push(src);
          mounts.push({ source: src, target, kind: 'volume' });
        }
      }
      const entry = CATALOGUE[img.base];
      const command = o.rest.slice(1).join(' ');
      const oneShot = command ? !/sleep|tail -f|server|nginx|httpd/.test(command) : !!entry?.oneShot && img.cmd === entry.cmd;
      const id = hex('c' + name + st.containers.length, 64);
      const logs: string[] = [];
      if (img.webRoot) logs.push(`/docker-entrypoint.sh: Configuration complete; ready for start up`, `${img.base.split(':')[0]}: start worker processes`);
      else if (img.base.startsWith('postgres')) logs.push(env.POSTGRES_PASSWORD ? 'database system is ready to accept connections' : 'Error: Database is uninitialized and superuser password is not specified. You must specify POSTGRES_PASSWORD.');
      else if (img.base.startsWith('redis')) logs.push('Ready to accept connections tcp');
      else if (img.base.startsWith('hello-world')) logs.push('Hello from Docker!', 'This message shows that your installation appears to be working correctly.');
      if (command.startsWith('echo ')) logs.push(command.slice(5).replace(/^["']|["']$/g, ''));
      const failed = img.base.startsWith('postgres') && !env.POSTGRES_PASSWORD;
      const c: DockerContainer = { id, name, image: `${img.repo}:${img.tag}`, status: oneShot || failed ? 'exited' : 'running', exitCode: failed ? 1 : 0, ports, env, mounts, restart: o.values.restart ?? 'no', network: o.values.network ?? 'bridge', logs, created: ctx.sys.now };
      if (rest.includes('--rm') && c.status === 'exited') {
        for (const l of logs) io.out(l + '\n');
        return done();
      }
      st.containers.push(c);
      if (rest.includes('-d') || rest.includes('--detach')) io.out(id + '\n');
      else {
        for (const l of logs) io.out(l + '\n');
        if (c.status === 'running') io.out('(Running in the foreground. The simulator gives you your prompt back, as if you had detached with Ctrl+P Ctrl+Q. Next time use -d.)\n');
      }
      return done(failed ? 1 : 0);
    }
    case 'ps': {
      const all = rest.includes('-a') || rest.includes('--all');
      const list = st.containers.filter((c) => all || c.status === 'running');
      if (rest.includes('-q')) {
        for (const c of list) io.out(c.id.slice(0, 12) + '\n');
        return 0;
      }
      io.out('CONTAINER ID   IMAGE                 COMMAND        STATUS                    PORTS                    NAMES\n');
      for (const c of list) {
        const img = findImage(st, c.image);
        io.out(`${c.id.slice(0, 12).padEnd(15)}${c.image.padEnd(22)}${('"' + (img?.cmd ?? '').slice(0, 10) + '…"').padEnd(15)}${(c.status === 'running' ? 'Up 2 minutes' : `Exited (${c.exitCode}) 1 minute ago`).padEnd(26)}${portsText(c).padEnd(25)}${c.name}\n`);
      }
      return 0;
    }
    case 'stop':
    case 'start':
    case 'restart':
    case 'kill': {
      for (const ref of rest.filter((x) => !x.startsWith('-'))) {
        const c = containerOf(ref);
        if (!c) {
          io.err(`Error response from daemon: No such container: ${ref}\n`);
          return done(1);
        }
        if (sub === 'start' || sub === 'restart') {
          const clash = c.ports.find((p) => st.containers.some((k) => k !== c && k.status === 'running' && k.ports.some((q) => q.host === p.host)));
          if (clash) {
            io.err(`Error response from daemon: Bind for 0.0.0.0:${clash.host} failed: port is already allocated\n`);
            return done(1);
          }
          c.status = 'running';
          c.exitCode = 0;
        } else {
          c.status = 'exited';
          c.exitCode = sub === 'kill' ? 137 : 0;
        }
        io.out(ref + '\n');
      }
      return done();
    }
    case 'rm': {
      const force = rest.includes('-f') || rest.includes('--force');
      for (const ref of rest.filter((x) => !x.startsWith('-'))) {
        const c = containerOf(ref);
        if (!c) {
          io.err(`Error response from daemon: No such container: ${ref}\n`);
          return done(1);
        }
        if (c.status === 'running' && !force) {
          io.err(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove\n`);
          return done(1);
        }
        st.containers = st.containers.filter((k) => k !== c);
        io.out(ref + '\n');
      }
      return done();
    }
    case 'logs': {
      const c = containerOf(rest.filter((x) => !x.startsWith('-'))[0] ?? '');
      if (!c) {
        io.err(`Error response from daemon: No such container: ${rest[0] ?? ''}\n`);
        return 1;
      }
      for (const l of c.logs) io.out(l + '\n');
      return 0;
    }
    case 'exec': {
      const o = parseOpts(rest, ['u', 'user', 'w'], {}, true);
      const c = containerOf(o.rest[0] ?? '');
      if (!c) {
        io.err(`Error response from daemon: No such container: ${o.rest[0] ?? ''}\n`);
        return 1;
      }
      if (c.status !== 'running') {
        io.err(`Error response from daemon: container ${c.id.slice(0, 12)} is not running\n`);
        return 1;
      }
      const img = findImage(st, c.image)!;
      const [cmd, ...cargs] = o.rest.slice(1);
      if (cmd === 'whoami' || (cmd === 'id' && cargs.length === 0)) io.out((o.values.u ?? o.values.user ?? img.user) + '\n');
      else if (cmd === 'env' || cmd === 'printenv') for (const [k, v] of Object.entries({ PATH: '/usr/local/bin:/usr/bin:/bin', HOSTNAME: c.id.slice(0, 12), ...c.env })) io.out(`${k}=${v}\n`);
      else if (cmd === 'pwd') io.out(img.workdir + '\n');
      else if (cmd === 'cat' || cmd === 'ls') {
        const p = joinPath(img.workdir, cargs[0] ?? '.');
        const m = c.mounts.find((k) => k.kind === 'bind' && (p === k.target || p.startsWith(k.target.replace(/\/$/, '') + '/')));
        if (m) {
          const hostPath = (m.source + '/' + p.slice(m.target.length)).split('/').filter(Boolean).reduce((acc, part) => acc + '/' + part, '');
          if (cmd === 'cat') {
            try {
              io.out(readFile(ctx.sys.fs, hostPath, ROOT));
              return 0;
            } catch {
              io.err(`cat: can't open '${p}': No such file or directory\n`);
              return 1;
            }
          }
          const f = hostFiles(ctx, hostPath);
          if (!f) {
            io.err(`ls: ${p}: No such file or directory\n`);
            return 1;
          }
          io.out([...new Set(Object.keys(f).map((k) => k.split('/')[0]))].sort().join('\n') + '\n');
          return 0;
        }
        if (cmd === 'cat') {
          if (img.files[p] === undefined) {
            io.err(`cat: can't open '${p}': No such file or directory\n`);
            return 1;
          }
          io.out(img.files[p]);
        } else {
          const names = [...new Set(Object.keys(img.files).filter((k) => k.startsWith(p.replace(/\/$/, '') + '/')).map((k) => k.slice(p.replace(/\/$/, '').length + 1).split('/')[0]))].sort();
          io.out(names.length ? names.join('\n') + '\n' : '');
        }
      } else io.out(`(exec ${cmd ?? ''}: this simulator runs whoami, env, pwd, cat and ls inside containers.)\n`);
      return 0;
    }
    case 'inspect': {
      const ref = rest.filter((x) => !x.startsWith('-'))[0] ?? '';
      const c = containerOf(ref);
      const img = c ? findImage(st, c.image) : findImage(st, ref);
      if (!c && !img) {
        io.err(`Error: No such object: ${ref}\n`);
        return 1;
      }
      const obj = c
        ? { Id: c.id, Name: '/' + c.name, State: { Status: c.status, ExitCode: c.exitCode }, Config: { Image: c.image, Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`), User: img?.user ?? 'root' }, HostConfig: { RestartPolicy: { Name: c.restart }, PortBindings: Object.fromEntries(c.ports.map((p) => [`${p.container}/tcp`, [{ HostPort: String(p.host) }]])) }, Mounts: c.mounts.map((m) => ({ Type: m.kind, Source: m.source, Destination: m.target })) }
        : { Id: 'sha256:' + img!.id, RepoTags: [`${img!.repo}:${img!.tag}`], Size: Math.round(img!.sizeMb * 1e6), Config: { User: img!.user, ExposedPorts: Object.fromEntries(img!.expose.map((p) => [`${p}/tcp`, {}])), Cmd: [img!.cmd], WorkingDir: img!.workdir, Env: Object.entries(img!.env).map(([k, v]) => `${k}=${v}`) }, RootFS: { Layers: Array.from({ length: img!.layers }, (_, i) => 'sha256:' + hex(img!.id + i, 16)) } };
      io.out(JSON.stringify([obj], null, 4) + '\n');
      return 0;
    }
    case 'volume': {
      const [verb, name] = rest;
      if (verb === 'create' && name) {
        if (!st.volumes.includes(name)) st.volumes.push(name);
        io.out(name + '\n');
        return done();
      }
      if (verb === 'ls') {
        io.out('DRIVER    VOLUME NAME\n' + st.volumes.map((v) => `local     ${v}\n`).join(''));
        return 0;
      }
      if (verb === 'rm' && name) {
        st.volumes = st.volumes.filter((v) => v !== name);
        io.out(name + '\n');
        return done();
      }
      io.err('Usage: docker volume create|ls|rm NAME\n');
      return 1;
    }
    case 'network': {
      const [verb, name] = rest;
      if (verb === 'create' && name) {
        if (!st.networks.includes(name)) st.networks.push(name);
        io.out(hex('net' + name, 64) + '\n');
        return done();
      }
      if (verb === 'ls') {
        io.out('NETWORK ID     NAME      DRIVER    SCOPE\n' + st.networks.map((n) => `${hex('net' + n)}   ${n.padEnd(10)}${n === 'host' ? 'host' : n === 'none' ? 'null' : 'bridge'}    local\n`).join(''));
        return 0;
      }
      io.err('Usage: docker network create|ls NAME\n');
      return 1;
    }
  }
  io.err(`docker: '${sub}' is not a docker command in this simulator.\nSee 'docker --help'\n`);
  return 1;
};

export const DOCKER_COMMANDS: Record<string, Cmd> = { docker };
