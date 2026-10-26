/**
 * docker build: reads a Dockerfile and its build context, runs each RUN in a build box, keeps a
 * layer cache keyed by the instruction and the files it copies (so instruction order decides what
 * gets rebuilt), honours .dockerignore, and only builds the stages the target needs.
 */

import { lookup, readFile, type DirNode } from './fs.js';
import { actor, type Ctx } from './shell.js';
import type { IO } from './util.js';
import {
  BoxError,
  applyToImage,
  findImage,
  hex,
  imageFromCatalogue,
  joinPath,
  normRef,
  openBox,
  parseDuration,
  parseRef,
  runInBox,
  shq,
  type DockerImage,
  type DockerState,
  type HealthConfig,
  type Layer,
} from './docker-engine.js';
import { pullImage } from './docker-registry.js';

export interface BuildOpts {
  tags: string[];
  contextDir: string;
  dockerfile: string;
  buildArgs: Record<string, string>;
  target?: string;
  noCache: boolean;
  quiet: boolean;
  /** Labels to add (compose adds its own). */
  labels?: Record<string, string>;
}

interface Instr {
  op: string;
  arg: string;
  raw: string;
}

/** Splits a Dockerfile into instructions: continuation lines joined, comments dropped. */
export function parseDockerfile(text: string): Instr[] {
  const out: Instr[] = [];
  const src = text.replace(/\r/g, '').split('\n');
  let buf = '';
  for (const lineRaw of src) {
    const line = lineRaw.replace(/^\s+/, '');
    if (!buf && (line.startsWith('#') || !line.trim())) continue;
    if (buf && line.startsWith('#')) continue;
    if (/\\\s*$/.test(line)) {
      buf += line.replace(/\\\s*$/, ' ');
      continue;
    }
    buf += line;
    const t = buf.trim();
    buf = '';
    if (!t) continue;
    const sp = t.search(/\s/);
    out.push({ op: (sp < 0 ? t : t.slice(0, sp)).toUpperCase(), arg: sp < 0 ? '' : t.slice(sp + 1).trim(), raw: t });
  }
  return out;
}

/** JSON-array or shell form of CMD/ENTRYPOINT/RUN as a command line for the box's shell. */
export function commandLine(raw: string): { line: string; exec: boolean } {
  const t = raw.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t) as string[];
      if (Array.isArray(arr)) return { line: arr.map(shq).join(' '), exec: true };
    } catch {
      /* fall through: Docker treats invalid JSON as shell form */
    }
  }
  return { line: `/bin/sh -c ${shq(t)}`, exec: false };
}

/* ----------------------------------------------------------------------------- .dockerignore */

function globRe(pattern: string): RegExp {
  let p = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      re += '.*';
      i++;
      if (p[i + 1] === '/') i++;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  p = re;
  return new RegExp(`^${p}(/.*)?$`);
}

export function dockerignore(text: string | null): (rel: string) => boolean {
  const rules = (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => ({ neg: l.startsWith('!'), re: globRe(l.replace(/^!/, '')) }));
  return (rel) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(rel)) ignored = !r.neg;
    return ignored;
  };
}

/* ----------------------------------------------------------------------------- the build context */

interface CtxFile {
  content: string;
  mode: number;
}

function contextFiles(ctx: Ctx, dir: string): Record<string, CtxFile> | null {
  const l = lookup(ctx.sys.fs, dir, actor(ctx));
  if (!l || l.node.type !== 'dir') return null;
  const out: Record<string, CtxFile> = {};
  const visit = (n: DirNode, rel: string) => {
    for (const [name, child] of Object.entries(n.children)) {
      const p = rel ? `${rel}/${name}` : name;
      if (child.type === 'dir') {
        out[p + '/'] = { content: '', mode: child.mode };
        visit(child, p);
      } else if (child.type === 'file') out[p] = { content: child.content, mode: child.mode };
    }
  };
  visit(l.node, '');
  return out;
}

function matchSources(files: Record<string, CtxFile>, src: string): string[] {
  const s = src.replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s === '.') return [''];
  if (/[*?[]/.test(s)) {
    const re = new RegExp('^' + s.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '/?$');
    return Object.keys(files).filter((k) => re.test(k)).map((k) => k.replace(/\/$/, ''));
  }
  if (files[s] || files[s + '/']) return [s];
  return [];
}

/* ----------------------------------------------------------------------------- sizes */

const SIZE_MARK = /\((\d+(?:\.\d+)?) (kB|MB|GB)\)/;

export function layerMb(layer: Layer): number {
  let bytes = 0;
  for (const c of Object.values(layer.files)) {
    const m = SIZE_MARK.exec(c);
    bytes += m ? Number(m[1]) * { kB: 1e3, MB: 1e6, GB: 1e9 }[m[2] as 'MB'] : c.length;
  }
  return bytes / 1e6;
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ----------------------------------------------------------------------------- the build */

export function build(ctx: Ctx, st: DockerState, o: BuildOpts, io: IO): number {
  let text: string;
  try {
    text = readFile(ctx.sys.fs, o.dockerfile, actor(ctx));
  } catch {
    io.err(`ERROR: failed to solve: failed to read dockerfile: open ${o.dockerfile.split('/').pop()}: no such file or directory\n`);
    return 1;
  }
  const files = contextFiles(ctx, o.contextDir);
  if (!files) {
    io.err(`ERROR: unable to prepare context: path "${o.contextDir}" not found\n`);
    return 1;
  }
  let ignoreText: string | null = null;
  try {
    ignoreText = readFile(ctx.sys.fs, joinPath(o.contextDir, '.dockerignore'), actor(ctx));
  } catch {
    /* none */
  }
  const ignored = dockerignore(ignoreText);
  for (const k of Object.keys(files)) if (ignored(k.replace(/\/$/, ''))) delete files[k];
  const instrs = parseDockerfile(text);
  if (!instrs.length) {
    io.err('ERROR: failed to solve: the Dockerfile cannot be empty\n');
    return 1;
  }
  // Stages.
  interface Stage {
    name: string;
    index: number;
    from: string;
    body: Instr[];
  }
  const globalArgs: Record<string, string> = {};
  const stages: Stage[] = [];
  for (const ins of instrs) {
    if (ins.op === 'FROM') {
      const m = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(ins.arg);
      if (!m) {
        io.err(`ERROR: failed to solve: dockerfile parse error on line: FROM requires either one or three arguments\n`);
        return 1;
      }
      stages.push({ name: m[2] ?? '', index: stages.length, from: m[1], body: [] });
      continue;
    }
    if (!stages.length) {
      if (ins.op === 'ARG') {
        const [k, ...v] = ins.arg.split('=');
        globalArgs[k.trim()] = o.buildArgs[k.trim()] ?? v.join('=').replace(/^"|"$/g, '');
        continue;
      }
      io.err(`ERROR: failed to solve: no build stage in current context\n(Every Dockerfile starts with FROM <image>; ${ins.op} came first.)\n`);
      return 1;
    }
    stages[stages.length - 1].body.push(ins);
  }
  const subst = (s: string, vars: Record<string, string>) => s.replace(/\$\{(\w+)(?::?-([^}]*))?\}|\$(\w+)/g, (_, a, d, b) => vars[a ?? b] ?? d ?? '');
  const targetIdx = o.target ? stages.findIndex((s) => s.name === o.target) : stages.length - 1;
  if (targetIdx < 0) {
    io.err(`ERROR: failed to solve: target stage "${o.target}" could not be found\n`);
    return 1;
  }
  // The stages the target needs, through FROM and COPY --from.
  const needed = new Set<number>();
  const stageRef = (ref: string, before: number) => {
    const byName = stages.findIndex((s, i) => i < before && s.name === ref);
    if (byName >= 0) return byName;
    if (/^\d+$/.test(ref) && Number(ref) < before) return Number(ref);
    return -1;
  };
  const need = (i: number) => {
    if (needed.has(i)) return;
    needed.add(i);
    const s = stages[i];
    const fromStage = stageRef(subst(s.from, globalArgs), i);
    if (fromStage >= 0) need(fromStage);
    for (const ins of s.body) {
      const m = /--from=(\S+)/.exec(ins.arg);
      if ((ins.op === 'COPY' || ins.op === 'ADD') && m) {
        const r = stageRef(m[1], i);
        if (r >= 0) need(r);
      }
    }
  };
  need(targetIdx);
  const steps = (s: Stage) => 1 + s.body.filter((b) => ['COPY', 'ADD', 'RUN', 'WORKDIR'].includes(b.op)).length;
  let n = 1;
  const say = (t: string) => {
    if (!o.quiet) io.out(t);
  };
  say(`#0 building with "default" instance using docker driver\n\n#1 [internal] load build definition from ${o.dockerfile.split('/').pop()}\n#1 transferring dockerfile: ${text.length}B done\n#1 DONE 0.0s\n\n`);
  n = 2;
  for (const i of [...needed].sort()) {
    const from = subst(stages[i].from, globalArgs);
    if (stageRef(from, i) < 0 && from !== 'scratch') {
      say(`#${n} [internal] load metadata for ${parseRef(from).registry === 'docker.io' ? `docker.io/${parseRef(from).path}:${parseRef(from).tag}` : from}\n#${n} DONE 0.4s\n\n`);
      n++;
    }
  }
  say(`#${n} [internal] load .dockerignore\n#${n} transferring context: ${ignoreText?.length ?? 2}B done\n#${n} DONE 0.0s\n\n`);
  n++;
  const built: Record<number, DockerImage> = {};
  const cache = (st.cache ??= {});
  let failed = false;
  for (const i of [...needed].sort((a, b) => a - b)) {
    const s = stages[i];
    const label = (k: number) => `[${s.name ? s.name + ' ' : needed.size > 1 ? `stage-${i} ` : ''}${k}/${steps(s)}]`;
    const fromRef = subst(s.from, globalArgs);
    const fromStage = stageRef(fromRef, i);
    let cur: DockerImage;
    if (fromStage >= 0) cur = structuredClone(built[fromStage]);
    else if (fromRef === 'scratch') cur = { repo: 'scratch', tag: 'latest', id: hex('scratch'), sizeMb: 0, layers: 0, base: 'scratch', user: '', expose: [], cmd: '', workdir: '/', env: {}, files: {}, modes: {}, created: ctx.sys.now };
    else {
      const base = findImage(st, fromRef) ?? pullImage(ctx, st, fromRef, { stdin: '', out: () => {}, err: io.err }, true);
      if (!base) {
        io.err(`ERROR: failed to solve: ${fromRef}: failed to resolve source metadata for docker.io/${parseRef(fromRef).path}:${parseRef(fromRef).tag}: pull access denied, repository does not exist or may require authorization\n`);
        return 1;
      }
      cur = structuredClone(base);
      cur.base = imageFromCatalogue(ctx, fromRef) ? normRef(fromRef) : base.base;
      cur.history = [...(base.history ?? [])];
      cur.labels = { ...(base.labels ?? {}) };
    }
    cur.modes ??= {};
    let key = 'from:' + cur.id + ':' + fromRef;
    say(`#${n} ${label(1)} FROM ${fromStage >= 0 ? stages[fromStage].name || `stage-${fromStage}` : parseRef(fromRef).registry === 'docker.io' ? `docker.io/${parseRef(fromRef).path}:${parseRef(fromRef).tag}` : fromRef}\n#${n} DONE 0.0s\n\n`);
    n++;
    let k = 1;
    const vars: Record<string, string> = { ...globalArgs, ...cur.env };
    const stageArgs: Record<string, string> = {};
    let contextShown = false;
    for (const ins of s.body) {
      const arg = ['RUN', 'CMD', 'ENTRYPOINT', 'HEALTHCHECK'].includes(ins.op) ? ins.arg : subst(ins.arg, { ...vars, ...stageArgs });
      switch (ins.op) {
        case 'ARG': {
          const [name, ...v] = arg.split('=');
          const nm = name.trim();
          stageArgs[nm] = o.buildArgs[nm] ?? globalArgs[nm] ?? v.join('=').replace(/^"|"$/g, '');
          key += `|ARG ${nm}=${stageArgs[nm]}`;
          break;
        }
        case 'ENV': {
          const pairs = /^\w+=/.test(arg) ? (arg.match(/(\w+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g) ?? []).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1).replace(/^["'](.*)["']$/s, '$1')]) : [[arg.split(/\s+/)[0], arg.slice(arg.split(/\s+/)[0].length).trim()]];
          for (const [kk, v] of pairs) {
            cur.env[kk] = v;
            vars[kk] = v;
          }
          key += `|ENV ${arg}`;
          break;
        }
        case 'LABEL': {
          for (const p of arg.match(/([\w.-]+)=("(?:[^"\\]|\\.)*"|\S+)/g) ?? []) cur.labels = { ...(cur.labels ?? {}), [p.slice(0, p.indexOf('='))]: p.slice(p.indexOf('=') + 1).replace(/^"(.*)"$/s, '$1') };
          key += `|LABEL ${arg}`;
          break;
        }
        case 'EXPOSE':
          for (const p of arg.split(/\s+/)) {
            const port = Number(p.split('/')[0]);
            if (port && !cur.expose.includes(port)) cur.expose.push(port);
          }
          key += `|EXPOSE ${arg}`;
          break;
        case 'USER':
          cur.user = arg;
          key += `|USER ${arg}`;
          break;
        case 'CMD':
          cur.cmd = commandLine(arg).line;
          key += `|CMD ${arg}`;
          break;
        case 'ENTRYPOINT':
          cur.entrypoint = commandLine(arg).line;
          if (!arg.trim().startsWith('[')) cur.cmd = '';
          key += `|ENTRYPOINT ${arg}`;
          break;
        case 'VOLUME': {
          const vols = arg.trim().startsWith('[') ? (JSON.parse(arg) as string[]) : arg.split(/\s+/);
          cur.volumes = [...new Set([...(cur.volumes ?? []), ...vols])];
          key += `|VOLUME ${arg}`;
          break;
        }
        case 'HEALTHCHECK': {
          if (/^NONE$/i.test(arg.trim())) cur.health = { test: ['NONE'], interval: 0, retries: 0, startPeriod: 0 };
          else {
            const opts: Record<string, string> = {};
            let rest = arg;
            for (;;) {
              const m = /^--([\w-]+)=(\S+)\s+/.exec(rest);
              if (!m) break;
              opts[m[1]] = m[2];
              rest = rest.slice(m[0].length);
            }
            const cm = /^CMD\s+(.*)$/is.exec(rest.trim());
            if (!cm) {
              io.err('ERROR: failed to solve: dockerfile parse error: HEALTHCHECK needs CMD or NONE\n');
              return 1;
            }
            const c = commandLine(cm[1]);
            const h: HealthConfig = { test: c.exec ? ['CMD', ...(JSON.parse(cm[1]) as string[])] : ['CMD-SHELL', cm[1].trim()], interval: parseDuration(opts.interval, 30000), timeout: parseDuration(opts.timeout, 30000), retries: Number(opts.retries ?? 3), startPeriod: parseDuration(opts['start-period'], 0) };
            cur.health = h;
          }
          key += `|HEALTHCHECK ${arg}`;
          break;
        }
        case 'STOPSIGNAL':
        case 'SHELL':
        case 'ONBUILD':
        case 'MAINTAINER':
          key += `|${ins.raw}`;
          break;
        case 'WORKDIR':
        case 'COPY':
        case 'ADD':
        case 'RUN': {
          k++;
          const shown = ins.op === 'RUN' ? ins.arg : arg;
          // Work out what this step adds, and its cache key.
          let layer: Layer = { files: {}, modes: {}, owners: {}, dirs: {} };
          let users: Record<string, NonNullable<DockerImage['users']>[string]> = {};
          let groups: Record<string, number> = {};
          let pkgs: string[] = [];
          let runOut = '';
          if (ins.op === 'WORKDIR') {
            const dir = joinPath(cur.workdir, arg);
            cur.workdir = dir;
            if (!cur.files[dir] && !cur.dirs?.[dir]) layer.dirs![dir] = true;
            key += `|WORKDIR ${dir}`;
          } else if (ins.op === 'COPY' || ins.op === 'ADD') {
            const parts = arg.match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? [];
            let fromStageName: string | undefined;
            let chown: string | undefined;
            let chmod: string | undefined;
            while (parts[0]?.startsWith('--')) {
              const opt = parts.shift()!;
              if (opt.startsWith('--from=')) fromStageName = opt.slice(7);
              else if (opt.startsWith('--chown=')) chown = opt.slice(8);
              else if (opt.startsWith('--chmod=')) chmod = opt.slice(8);
            }
            if (parts.length < 2) {
              io.err(`ERROR: failed to solve: dockerfile parse error: ${ins.op} requires at least two arguments, but only one was provided. Destination could not be determined\n`);
              return 1;
            }
            const destRaw = parts.pop()!;
            const dest = joinPath(cur.workdir, destRaw);
            const toDir = destRaw.endsWith('/') || destRaw === '.' || parts.length > 1 || !!cur.dirs?.[dest] || dest === cur.workdir || Object.keys(cur.files).some((p) => p.startsWith(dest.replace(/\/$/, '') + '/'));
            if (chown) {
              const [u, g] = chown.split(':');
              const known = u === 'root' || /^\d+$/.test(u) || cur.users?.[u] || ['nginx', 'node', 'postgres', 'redis', 'www-data', 'nobody'].includes(u);
              if (!known) {
                io.err(`ERROR: failed to solve: failed to compute cache key: unable to convert uid/gid chown string to host mapping: can't find uid for user ${u}: no such user: ${u}\n`);
                return 1;
              }
              chown = `${u}:${g ?? u}`;
            }
            const owner = chown ?? 'root:root';
            const add = (path: string, content: string, mode: number) => {
              layer.files[path] = content;
              const m = chmod ? parseInt(chmod, 8) : mode & 0o7777;
              if (m !== 0o644) layer.modes![path] = m.toString(8);
              if (owner !== 'root:root') layer.owners![path] = owner;
            };
            if (fromStageName) {
              const r = stageRef(fromStageName, i);
              let srcImg: DockerImage | undefined = r >= 0 ? built[r] : undefined;
              if (!srcImg) srcImg = findImage(st, fromStageName) ?? pullImage(ctx, st, fromStageName, { stdin: '', out: () => {}, err: io.err }, true) ?? undefined;
              if (!srcImg) {
                io.err(`ERROR: failed to solve: ${fromStageName}: not found\n`);
                return 1;
              }
              for (const src of parts) {
                const srcPath = joinPath(srcImg.workdir, src).replace(/\/$/, '');
                const hits = Object.entries(srcImg.files).filter(([p]) => p === srcPath || p.startsWith(srcPath + '/'));
                if (!hits.length) {
                  io.err(`ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "${srcPath}": not found\n`);
                  return 1;
                }
                for (const [p, c] of hits) {
                  const rel = p === srcPath ? p.split('/').pop()! : p.slice(srcPath.length + 1);
                  const target = p === srcPath && !toDir ? dest : joinPath(dest, p === srcPath ? rel : rel);
                  add(target, c, parseInt(srcImg.modes?.[p] ?? (srcImg.modes ? '644' : '755'), 8));
                }
              }
              key += `|COPY --from=${fromStageName} ${hex(JSON.stringify(layer), 16)}`;
            } else {
              if (!contextShown) {
                say(`#${n} [internal] load build context\n#${n} transferring context: ${Object.values(files).reduce((a, f) => a + f.content.length, 0)}B done\n#${n} DONE 0.0s\n\n`);
                n++;
                contextShown = true;
              }
              for (const src of parts) {
                if (/^https?:\/\//.test(src)) {
                  io.err(`ERROR: failed to solve: failed to load cache key: Get "${src}": dial tcp: lookup ${src.split('/')[2]}: no such host\n`);
                  return 1;
                }
                const hits = matchSources(files, src);
                if (!hits.length) {
                  io.err(`#${n} ${label(k)} ${ins.op} ${shown}\n#${n} ERROR: failed to calculate checksum of ref: "/${src.replace(/^\.\//, '')}": not found\n------\n > ${label(k)} ${ins.op} ${shown}:\n------\nERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/${src.replace(/^\.\//, '')}": not found\n${ignored(src.replace(/^\.\//, '')) ? `(${src} is listed in .dockerignore, so it is not in the build context.)\n` : ''}`);
                  return 1;
                }
                for (const h of hits) {
                  const isDir = h === '' || files[h + '/'];
                  if (isDir) {
                    const prefix = h ? h + '/' : '';
                    for (const [p, f] of Object.entries(files)) {
                      if (!p.startsWith(prefix) || p === prefix) continue;
                      const rel = p.slice(prefix.length);
                      if (rel.endsWith('/')) layer.dirs![joinPath(dest, rel.replace(/\/$/, ''))] = true;
                      else add(joinPath(dest, rel), f.content, f.mode);
                    }
                    if (dest !== '/') layer.dirs![dest.replace(/\/$/, '')] = true;
                  } else {
                    const f = files[h];
                    add(toDir ? joinPath(dest, h.split('/').pop()!) : dest, f.content, f.mode);
                  }
                }
              }
              key += `|${ins.op} ${chown ?? ''} ${chmod ?? ''} ${hex(JSON.stringify(layer), 16)}`;
            }
          } else {
            key += `|RUN ${ins.arg}|${JSON.stringify(stageArgs)}`;
          }
          const ck = hex(key, 32);
          key = ck;
          const hit = !o.noCache && cache[ck];
          say(`#${n} ${label(k)} ${ins.op} ${shown}\n`);
          if (hit) {
            const keep = { repo: cur.repo, tag: cur.tag };
            cur = structuredClone(hit.image);
            Object.assign(cur, keep);
            say(`#${n} CACHED\n\n`);
            n++;
            break;
          }
          if (ins.op === 'RUN') {
            const line = commandLine(ins.arg).line;
            const env = { ...Object.fromEntries(Object.entries(stageArgs)), ...cur.env };
            let box;
            try {
              box = openBox(ctx, st, cur, null, { building: true, env });
            } catch (e) {
              if (e instanceof BoxError) {
                io.err(`#${n} ERROR: ${e.message}\n------\n > ${label(k)} RUN ${ins.arg}:\n------\nERROR: failed to solve: ${e.message}\n`);
                return 1;
              }
              throw e;
            }
            const r = runInBox(box, line);
            const res = box.finish('image');
            runOut = r.out.startsWith('__OCI__') ? r.out.slice(7) + '\n' : r.out;
            const t0 = 0.1;
            const outLines = runOut.split('\n').filter((l, idx, a) => l || idx < a.length - 1);
            outLines.forEach((l, idx) => say(`#${n} ${(t0 + idx * 0.137).toFixed(3)} ${l}\n`));
            if (r.code !== 0) {
              const shell = commandLine(ins.arg).exec ? ins.arg : `/bin/sh -c ${ins.arg}`;
              io.err(`#${n} ERROR: process "${shell}" did not complete successfully: exit code: ${r.code}\n------\n > ${label(k)} RUN ${ins.arg}:\n${outLines.slice(-6).map((l, idx) => `${(t0 + idx * 0.137).toFixed(3)} ${l}\n`).join('')}------\nERROR: failed to solve: process "${shell}" did not complete successfully: exit code: ${r.code}\n`);
              failed = true;
              return 1;
            }
            layer = res.layer;
            users = res.users;
            groups = res.groups;
            pkgs = res.pkgs;
          }
          applyToImage(cur, layer);
          if (Object.keys(users).length) cur.users = { ...(cur.users ?? {}), ...users };
          if (Object.keys(groups).length) cur.groups = { ...(cur.groups ?? {}), ...groups };
          if (pkgs.length) cur.pkgs = [...new Set([...(cur.pkgs ?? []), ...pkgs])];
          const mb = layerMb(layer) + (ins.op === 'RUN' ? 0.01 : 0);
          if (ins.op !== 'WORKDIR') cur.layers++;
          cur.sizeMb = round(cur.sizeMb + mb);
          cur.history = [...(cur.history ?? []), { by: `${ins.op} ${shown}`, sizeMb: round(mb) }];
          cur.id = hex(ck + 'img', 12);
          say(`#${n} DONE ${(0.1 + runOut.length / 900).toFixed(1)}s\n\n`);
          n++;
          cache[ck] = { image: structuredClone(cur), at: ctx.sys.now };
          break;
        }
        default:
          io.err(`ERROR: failed to solve: dockerfile parse error on line: unknown instruction: ${ins.op}\n`);
          return 1;
      }
    }
    // Metadata-only steps still change the image's identity.
    cur.id = hex(key + JSON.stringify([cur.cmd, cur.entrypoint, cur.user, cur.env, cur.expose, cur.health, cur.labels, cur.volumes]), 12);
    built[i] = cur;
  }
  void failed;
  // Keep the cache from growing without bound.
  const keys = Object.keys(cache);
  if (keys.length > 80) for (const k of keys.sort((a, b) => cache[a].at - cache[b].at).slice(0, keys.length - 80)) delete cache[k];
  const final = built[targetIdx];
  final.labels = { ...(final.labels ?? {}), ...(o.labels ?? {}) };
  final.created = ctx.sys.now;
  delete final.repoDigests;
  say(`#${n} exporting to image\n#${n} exporting layers 0.1s done\n#${n} writing image sha256:${hex(final.id, 64)} done\n`);
  for (const tag of o.tags) {
    const r = parseRef(tag);
    const prev = st.images.find((im) => im.repo === r.repo && im.tag === r.tag);
    if (prev && prev.id !== final.id) {
      // The old image keeps its id but loses the name: a dangling <none>:<none> image.
      if (!st.images.some((im) => im !== prev && im.id === prev.id)) Object.assign(prev, { repo: '<none>', tag: '<none>' });
      else st.images = st.images.filter((im) => im !== prev);
    } else if (prev) st.images = st.images.filter((im) => im !== prev);
    st.images.push({ ...structuredClone(final), repo: r.repo, tag: r.tag });
    say(`#${n} naming to ${r.registry === 'docker.io' ? `docker.io/${r.path}` : r.repo}:${r.tag} done\n`);
  }
  if (!o.tags.length) st.images.push({ ...structuredClone(final), repo: '<none>', tag: '<none>' });
  say(`#${n} DONE 0.2s\n`);
  if (o.quiet) io.out(`sha256:${hex(final.id, 64)}\n`);
  return 0;
}
