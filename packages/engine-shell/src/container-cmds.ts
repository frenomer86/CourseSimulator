/**
 * Programs as they behave inside a simulated container: the image's package manager (apk or
 * apt-get), pip and npm during builds, busybox httpd and python3 -m http.server as foreground
 * servers, and the client tools that reach other containers by name (nc, curl, wget, pg_isready,
 * psql, redis-cli). On the host most of these fall back to the ordinary command.
 */

import { lookup, mkdir, writeFile, type DirNode } from './fs.js';
import { ExitSignal, runScript, type Ctx } from './shell.js';
import type { IO } from './util.js';
import {
  QUIET_PACKAGES,
  TOOLS,
  boxLink,
  containerFile,
  containerHttp,
  findImage,
  hex,
  joinPath,
  listening,
  withFileSecrets,
  writeContainerFile,
  type BoxLink,
  type DockerContainer,
} from './docker-engine.js';
import { dockerHttp, isNginx, loadNginx } from './docker-engine.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
const ROOT = { user: 'root', groups: ['root'] };

const inBox = (ctx: Ctx) => !!ctx.sys.container;
const distro = (ctx: Ctx) => ctx.sys.container?.distro ?? 'host';

/** The shell's "not found" in the container's own words. */
function notFound(ctx: Ctx, io: IO, name: string): number {
  if (!inBox(ctx)) io.err(`bash: ${name}: command not found\n`);
  else if (distro(ctx) === 'alpine') io.err(`/bin/sh: ${name}: not found\n`);
  else io.err(`/bin/sh: 1: ${name}: not found\n`);
  return 127;
}

function put(ctx: Ctx, path: string, content: string): void {
  mkdir(ctx.sys.fs, path.slice(0, path.lastIndexOf('/')) || '/', ROOT, ctx.sys.now, true);
  writeFile(ctx.sys.fs, path, content, ROOT, ctx.sys.now);
}

function read(ctx: Ctx, path: string): string | null {
  const l = lookup(ctx.sys.fs, path, ROOT);
  return l && l.node.type === 'file' ? l.node.content : null;
}

const isRoot = (ctx: Ctx) => (ctx.euser ?? ctx.sys.user) === 'root';

/* ----------------------------------------------------------------------------- package managers */

function toolsFor(pkg: string, manager: 'apk' | 'apt'): string[] | null {
  const hits = Object.entries(TOOLS).filter(([, t]) => (t[manager] ?? []).includes(pkg)).map(([n]) => n);
  if (hits.length) return hits;
  return QUIET_PACKAGES.includes(pkg) ? [] : null;
}

function install(ctx: Ctx, tools: string[]): void {
  for (const t of tools) {
    const p = ctx.sys.packages[`tool:${t}`];
    if (p) p.installed = true;
  }
}

const apk: Cmd = (args, io, ctx) => {
  if (distro(ctx) !== 'alpine') return notFound(ctx, io, 'apk');
  const [verb, ...rest] = args;
  const pkgs = rest.filter((a) => !a.startsWith('-'));
  const noCache = rest.includes('--no-cache');
  if ((verb === 'add' || verb === 'del' || verb === 'update' || verb === 'upgrade') && !isRoot(ctx)) {
    io.err('ERROR: Unable to lock database: Permission denied\nERROR: Failed to open apk database: Permission denied\n');
    return 99;
  }
  switch (verb) {
    case 'update':
      io.out('fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz\nfetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz\nv3.20.3-215-g9c3e3a8a1e1 [https://dl-cdn.alpinelinux.org/alpine/v3.20/main]\nOK: 24166 distinct packages available\n');
      put(ctx, '/var/cache/apk/APKINDEX.main.tar.gz', 'APKINDEX (2.4 MB)\n');
      return 0;
    case 'add': {
      if (!pkgs.length) {
        io.err('ERROR: no packages given\n');
        return 1;
      }
      const bad = pkgs.filter((p) => toolsFor(p.replace(/[=<>~].*$/, ''), 'apk') === null);
      if (bad.length) {
        io.err(`ERROR: unable to select packages:\n${bad.map((b) => `  ${b} (no such package):\n    required by: world[${b}]\n`).join('')}`);
        return bad.length;
      }
      if (!read(ctx, '/var/cache/apk/APKINDEX.main.tar.gz') || noCache) io.out('fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz\nfetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz\n');
      pkgs.forEach((p, i) => io.out(`(${i + 1}/${pkgs.length}) Installing ${p.replace(/[=<>~].*$/, '')} (${1 + (p.length % 7)}.${p.length % 10}.${i}-r0)\n`));
      for (const p of pkgs) install(ctx, toolsFor(p.replace(/[=<>~].*$/, ''), 'apk') ?? []);
      for (const p of pkgs) put(ctx, `/usr/share/apk/installed/${p.replace(/[=<>~].*$/, '')}`, `${p} (${pkgMb(p)} MB)\n`);
      if (!noCache) put(ctx, '/var/cache/apk/APKINDEX.main.tar.gz', 'APKINDEX (2.4 MB)\n');
      io.out(`OK: ${12 + pkgs.length * 3} MiB in ${14 + pkgs.length} packages\n`);
      return 0;
    }
    case 'del':
      for (const p of pkgs) {
        for (const t of toolsFor(p, 'apk') ?? []) {
          const rec = ctx.sys.packages[`tool:${t}`];
          if (rec) rec.installed = false;
        }
      }
      io.out(`OK: ${12} MiB in 14 packages\n`);
      return 0;
    case 'info':
      io.out(['musl', 'busybox', 'alpine-baselayout', 'apk-tools', ...Object.entries(ctx.sys.packages).filter(([n, p]) => n.startsWith('tool:') && p.installed).map(([n]) => n.slice(5))].join('\n') + '\n');
      return 0;
    default:
      io.err('usage: apk [<OPTIONS>...] COMMAND [<ARGUMENTS>...]\n\nCommands: add, del, update, upgrade, info\n');
      return 1;
  }
};

const LISTS = '/var/lib/apt/lists';

function aptGet(name: string): Cmd {
  return (args, io, ctx) => {
    if (distro(ctx) === 'alpine' || distro(ctx) === 'scratch') return notFound(ctx, io, name);
    if (name === 'apt') io.err('\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n');
    const verb = args.find((a) => !a.startsWith('-'));
    const pkgs = args.filter((a) => !a.startsWith('-')).slice(1);
    const yes = args.some((a) => a === '-y' || a === '--yes' || a === '-yq' || a === '-qy' || a === '--assume-yes');
    if (verb && ['update', 'install', 'upgrade', 'remove', 'purge', 'clean', 'autoremove'].includes(verb) && !isRoot(ctx)) {
      io.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?\n');
      return 100;
    }
    const listsDir = lookup(ctx.sys.fs, LISTS, ROOT);
    const hasLists = !!listsDir && listsDir.node.type === 'dir' && Object.keys((listsDir.node as DirNode).children).some((k) => k !== 'partial' && k !== 'lock');
    switch (verb) {
      case 'update':
        io.out('Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]\nGet:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]\nGet:3 http://deb.debian.org/debian-security bookworm-security InRelease [48.0 kB]\nGet:4 http://deb.debian.org/debian bookworm/main amd64 Packages [8789 kB]\nFetched 9043 kB in 2s (4521 kB/s)\nReading package lists... Done\n');
        put(ctx, `${LISTS}/deb.debian.org_debian_dists_bookworm_main_binary-amd64_Packages.lz4`, 'Packages index (18 MB)\n');
        return 0;
      case 'install': {
        io.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n');
        const missing = pkgs.filter((p) => !hasLists || toolsFor(p.replace(/=.*$/, ''), 'apt') === null);
        if (missing.length) {
          for (const p of missing) io.err(`E: Unable to locate package ${p}\n`);
          return 100;
        }
        io.out(`The following NEW packages will be installed:\n  ${pkgs.join(' ')}\n0 upgraded, ${pkgs.length} newly installed, 0 to remove and 0 not upgraded.\nNeed to get ${pkgs.length * 412} kB of archives.\nAfter this operation, ${pkgs.length * 1.4} MB of additional disk space will be used.\n`);
        if (!yes) {
          io.out('Do you want to continue? [Y/n] Abort.\n');
          return 1;
        }
        for (const p of pkgs) {
          install(ctx, toolsFor(p.replace(/=.*$/, ''), 'apt') ?? []);
          put(ctx, `/var/lib/dpkg/info/${p.replace(/=.*$/, '')}.list`, `/usr/bin/${p} (${pkgMb(p) * 2} MB)\n`);
          io.out(`Setting up ${p.replace(/=.*$/, '')} ...\n`);
        }
        put(ctx, '/var/cache/apt/archives/partial/.keep', '');
        return 0;
      }
      case 'clean':
      case 'autoremove':
      case 'upgrade':
      case 'remove':
      case 'purge':
        if (verb === 'upgrade' && !yes) {
          io.out('Reading package lists... Done\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n');
          return 0;
        }
        if (verb === 'remove' || verb === 'purge') for (const p of pkgs) for (const t of toolsFor(p, 'apt') ?? []) if (ctx.sys.packages[`tool:${t}`]) ctx.sys.packages[`tool:${t}`].installed = false;
        if (verb !== 'clean') io.out('Reading package lists... Done\n');
        return 0;
      default:
        io.err(`E: Invalid operation ${verb ?? ''}\n`);
        return 100;
    }
  };
}

/* ----------------------------------------------------------------------------- pip and npm */

function sitePackages(_ctx: Ctx): string {
  return '/usr/local/lib/python3.12/site-packages';
}

const pip: Cmd = (args, io, ctx) => {
  const [verb, ...rest] = args;
  const site = sitePackages(ctx);
  if (verb === '--version' || verb === '-V') {
    io.out(`pip 24.2 from ${site}/pip (python 3.12)\n`);
    return 0;
  }
  if (verb === 'freeze' || verb === 'list') {
    const d = lookup(ctx.sys.fs, site, ROOT);
    const names = d && d.node.type === 'dir' ? Object.keys(d.node.children).filter((n) => n !== 'pip').sort() : [];
    if (verb === 'list') io.out('Package    Version\n---------- -------\n' + ['pip', ...names].map((n) => `${n.padEnd(10)} ${n === 'pip' ? '24.2' : (read(ctx, `${site}/${n}/VERSION`) ?? '1.0.0').trim()}\n`).join(''));
    else io.out(names.map((n) => `${n}==${(read(ctx, `${site}/${n}/VERSION`) ?? '1.0.0').trim()}\n`).join(''));
    return 0;
  }
  if (verb !== 'install') {
    io.err(`ERROR: unknown command "${verb ?? ''}"\n`);
    return 1;
  }
  const reqs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-r' || a === '--requirement') {
      const f = joinPath(ctx.sys.cwd, rest[++i] ?? '');
      const text = read(ctx, f);
      if (text === null) {
        io.err(`ERROR: Could not open requirements file: [Errno 2] No such file or directory: '${rest[i]}'\n`);
        return 1;
      }
      reqs.push(...text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
    } else if (!a.startsWith('-')) reqs.push(a);
  }
  if (!reqs.length) {
    io.err('ERROR: You must give at least one requirement to install (see "pip help install")\n');
    return 1;
  }
  const installed: string[] = [];
  for (const r of reqs) {
    const m = /^([A-Za-z0-9_.-]+)(?:\[.*\])?\s*(?:==\s*([\w.]+)|[<>=~!].*)?$/.exec(r);
    if (!m) {
      io.err(`ERROR: Invalid requirement: '${r}'\n`);
      return 1;
    }
    const name = m[1].toLowerCase();
    const ver = m[2] ?? `${1 + (name.length % 4)}.${name.length % 10}.0`;
    io.out(`Collecting ${m[1]}${m[2] ? `==${m[2]}` : ''}\n  Downloading ${name}-${ver}-py3-none-any.whl (${40 + name.length * 13} kB)\n`);
    put(ctx, `${site}/${name}/__init__.py`, `# ${name} ${ver} (${pkgMb(name)} MB)\n`);
    put(ctx, `${site}/${name}/VERSION`, ver + '\n');
    installed.push(`${name}-${ver}`);
  }
  if (!rest.includes('--no-cache-dir')) put(ctx, `${ctx.sys.users[ctx.sys.user]?.home ?? '/root'}/.cache/pip/http-v2/${hex(reqs.join(','), 8)}`, 'cached wheels (45 MB)\n');
  io.out(`Installing collected packages: ${installed.map((x) => x.split('-')[0]).join(', ')}\nSuccessfully installed ${installed.join(' ')}\n`);
  if (isRoot(ctx)) io.out("WARNING: Running pip as the 'root' user can result in broken permissions and conflicting behaviour with the system package manager. It is recommended to use a virtual environment instead: https://pip.pypa.io/warnings/venv\n");
  return 0;
};

const npm: Cmd = (args, io, ctx) => {
  const [verb, ...rest] = args;
  if (verb === '--version' || verb === '-v') {
    io.out('10.8.2\n');
    return 0;
  }
  const pkgText = read(ctx, joinPath(ctx.sys.cwd, 'package.json'));
  if (pkgText === null) {
    io.err(`npm error code ENOENT\nnpm error syscall open\nnpm error path ${joinPath(ctx.sys.cwd, 'package.json')}\nnpm error errno -2\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '${joinPath(ctx.sys.cwd, 'package.json')}'\n`);
    return 254;
  }
  let pkg: { name?: string; version?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(pkgText);
  } catch {
    io.err('npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json\n');
    return 1;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(rest.includes('--omit=dev') || rest.includes('--production') ? {} : pkg.devDependencies ?? {}) };
  const modules = (prod: boolean) => {
    for (const [d, v] of Object.entries(prod ? pkg.dependencies ?? {} : deps)) put(ctx, joinPath(ctx.sys.cwd, `node_modules/${d}/package.json`), JSON.stringify({ name: d, version: String(v).replace(/^[\^~]/, '') }) + '\n');
    put(ctx, joinPath(ctx.sys.cwd, 'node_modules/.package-lock.json'), `{} (${12 + Object.keys(prod ? pkg.dependencies ?? {} : deps).length * 9} MB)\n`);
  };
  switch (verb) {
    case 'ci': {
      if (read(ctx, joinPath(ctx.sys.cwd, 'package-lock.json')) === null) {
        io.err('npm error code EUSAGE\nnpm error\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1. Run an install with npm@5 or\nnpm error later to generate a package-lock.json file, then try again.\n');
        return 1;
      }
      modules(rest.includes('--omit=dev') || rest.includes('--production'));
      io.out(`\nadded ${Object.keys(deps).length * 17 + 3} packages in 4s\n`);
      return 0;
    }
    case 'install':
    case 'i': {
      modules(false);
      if (read(ctx, joinPath(ctx.sys.cwd, 'package-lock.json')) === null) put(ctx, joinPath(ctx.sys.cwd, 'package-lock.json'), JSON.stringify({ name: pkg.name, lockfileVersion: 3 }, null, 2) + '\n');
      io.out(`\nadded ${Object.keys(deps).length * 17 + 3} packages in 5s\n`);
      return 0;
    }
    case 'run':
    case 'run-script':
    case 'test':
    case 't':
    case 'start': {
      const script = verb === 'run' || verb === 'run-script' ? rest[0] : verb === 't' ? 'test' : verb;
      if (!script) {
        io.out(`Scripts available in ${pkg.name ?? 'package'} via \`npm run-script\`:\n${Object.entries(pkg.scripts ?? {}).map(([k, v]) => `  ${k}\n    ${v}\n`).join('')}`);
        return 0;
      }
      const body = pkg.scripts?.[script];
      if (!body) {
        io.err(`npm error Missing script: "${script}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n`);
        return 1;
      }
      io.out(`\n> ${pkg.name ?? 'app'}@${pkg.version ?? '1.0.0'} ${script}\n> ${body}\n\n`);
      const saved = ctx.vars.PATH;
      ctx.vars.PATH = `${joinPath(ctx.sys.cwd, 'node_modules/.bin')}:${saved ?? ''}`;
      const code = runScript(ctx, body + '\n', [], 'sh', io);
      ctx.vars.PATH = saved;
      return code;
    }
    default:
      io.err(`Unknown command: "${verb ?? ''}"\n`);
      return 1;
  }
};

/* ----------------------------------------------------------------------------- foreground servers */

function serve(ctx: Ctx, port: number, root: string): never {
  const link = boxLink(ctx.sys);
  if (link) link.serve = { port, root };
  throw new ExitSignal(0);
}

/** busybox httpd: -f stays in the foreground; without it, it daemonises and the shell carries on. */
const httpd: Cmd = (args, io, ctx) => {
  if (!inBox(ctx) || distro(ctx) !== 'alpine') return notFound(ctx, io, 'httpd');
  let port = 80;
  let root = ctx.sys.cwd;
  let fg = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f') fg = true;
    else if (a === '-p') port = Number(String(args[++i]).split(':').pop());
    else if (a === '-h') root = joinPath(ctx.sys.cwd, args[++i] ?? '.');
    else if (/^-f?v+$/.test(a)) fg = fg || a.includes('f');
  }
  if (!lookup(ctx.sys.fs, root, ROOT)) {
    io.err(`httpd: can't change directory to '${root}': No such file or directory\n`);
    return 1;
  }
  if (port < 1024 && !isRoot(ctx)) {
    io.err(`httpd: bind: Permission denied\n`);
    return 1;
  }
  if (!fg) {
    // It forked into the background; if this was PID 1's last command, the container now exits.
    return 0;
  }
  return serve(ctx, port, root);
};

const python3: Cmd = (args, io, ctx) => {
  if (!inBox(ctx)) return HOST.python3 ? HOST.python3(args, io, ctx) : notFound(ctx, io, 'python3');
  if (args[0] === '--version' || args[0] === '-V') {
    io.out('Python 3.12.7\n');
    return 0;
  }
  if (args[0] === '-m' && args[1] === 'http.server') {
    let port = 8000;
    let root = ctx.sys.cwd;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === '--directory' || args[i] === '-d') root = joinPath(ctx.sys.cwd, args[++i] ?? '.');
      else if (args[i] === '--bind' || args[i] === '-b') i++;
      else if (/^\d+$/.test(args[i])) port = Number(args[i]);
    }
    if (port < 1024 && !isRoot(ctx)) {
      io.err('PermissionError: [Errno 13] Permission denied\n');
      return 1;
    }
    io.out(`Serving HTTP on 0.0.0.0 port ${port} (http://0.0.0.0:${port}/) ...\n`);
    return serve(ctx, port, root);
  }
  if (args[0] === '-m' && args[1] === 'pip') return pip(args.slice(2), io, ctx);
  if (!args.length) return 0;
  const file = args.find((a) => !a.startsWith('-'));
  if (file && read(ctx, joinPath(ctx.sys.cwd, file)) === null && !args.includes('-c')) {
    io.err(`python3: can't open file '${joinPath(ctx.sys.cwd, file)}': [Errno 2] No such file or directory\n`);
    return 2;
  }
  io.err('(This simulator does not run Python programs; use a shell script or python3 -m http.server.)\n');
  return 1;
};

const node: Cmd = (args, io, ctx) => {
  if (!inBox(ctx)) return notFound(ctx, io, 'node');
  if (args[0] === '--version' || args[0] === '-v') {
    io.out('v20.18.0\n');
    return 0;
  }
  if (!args.length) return 0;
  io.err('(This simulator does not run JavaScript programs; use a shell script, or npm run for package scripts.)\n');
  return 1;
};

/* ----------------------------------------------------------------------------- reaching other containers */

interface Target {
  kind: 'self' | 'peer' | 'host';
  c?: DockerContainer;
  ip: string;
  /** A Kubernetes Service: its port -> the pod's port. */
  ports?: Record<number, number>;
}

const mapped = (t: Target, port: number) => t.ports?.[port] ?? port;

/** Resolves a host name the way a program inside the box would. */
function resolve(ctx: Ctx, link: BoxLink | undefined, host: string): Target | null {
  if (!link) return host === 'localhost' || host === '127.0.0.1' ? { kind: 'host', ip: '127.0.0.1' } : null;
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === ctx.sys.hostname) return link.self ? { kind: 'self', c: link.self, ip: '127.0.0.1' } : null;
  const p = link.peers[host];
  if (p) return { kind: p.container === link.self ? 'self' : 'peer', c: p.container, ip: p.ip, ports: p.ports };
  const byIp = Object.values(link.peers).find((x) => x.ip === host);
  if (byIp) return { kind: 'peer', c: byIp.container, ip: byIp.ip };
  return null;
}

/** Whether a TCP port is open, as seen from inside this box. */
function portOpen(ctx: Ctx, link: BoxLink, t: Target, port: number): boolean {
  if (t.kind === 'self' && link.serve?.port === port) return true;
  if (!t.c) return false;
  return listening(link.st, t.c, mapped(t, port), ctx.sys.now) === 'open';
}

const nc: Cmd = (args, io, ctx) => {
  const link = boxLink(ctx.sys);
  const pos = args.filter((a, i) => !a.startsWith('-') && !['-w', '-i', '-q'].includes(args[i - 1] ?? ''));
  const [host, portText] = pos;
  const verbose = args.some((a) => /^-\w*v/.test(a));
  const scan = args.some((a) => /^-\w*z/.test(a));
  if (!host || !portText) {
    io.err('usage: nc [-46CDdFhklNnrStUuvZz] [-I length] [-i interval] [-O length]\n\t  [-P proxy_username] [-p source_port] [-q seconds] [-s sourceaddr]\n\t  [-T keyword] [-V rtable] [-W recvlimit] [-w timeout] [-X proxy_protocol]\n\t  [-x proxy_address[:port]] [destination] [port]\n');
    return 1;
  }
  const port = Number(portText);
  const busybox = distro(ctx) === 'alpine';
  if (!link) {
    const open = (host === 'localhost' || host === '127.0.0.1') && (Object.values(ctx.sys.services).some((s) => s.active && s.port === port) || !!dockerHttp(ctx, port, '/'));
    if (verbose) io.err(open ? `Connection to ${host} (127.0.0.1) ${port} port [tcp/*] succeeded!\n` : `nc: connect to ${host} (127.0.0.1) port ${port} (tcp) failed: Connection refused\n`);
    return open ? 0 : 1;
  }
  const t = resolve(ctx, link, host);
  if (!t) {
    io.err(busybox ? `nc: bad address '${host}'\n` : `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known\n`);
    return 1;
  }
  const open = portOpen(ctx, link, t, port);
  if (verbose) {
    if (busybox) io.err(open ? `${host} (${t.ip}:${port}) open\n` : `nc: ${host} (${t.ip}:${port}): Connection refused\n`);
    else io.err(open ? `Connection to ${host} (${t.ip}) ${port} port [tcp/*] succeeded!\n` : `nc: connect to ${host} (${t.ip}) port ${port} (tcp) failed: Connection refused\n`);
  }
  if (!scan && open) io.out('');
  return open ? 0 : 1;
};

/** curl and wget inside a container: other containers by name, the container itself on localhost. */
function httpClient(kind: 'curl' | 'wget'): Cmd {
  return (args, io, ctx) => {
    const link = boxLink(ctx.sys);
    if (!link) return HOST[kind](args, io, ctx);
    if (args[0] === '--version' || args[0] === '-V') {
      io.out(kind === 'curl' ? `curl 8.9.1 (x86_64-${distro(ctx) === 'alpine' ? 'alpine-linux-musl' : 'pc-linux-gnu'}) libcurl/8.9.1 OpenSSL/3.3.2 zlib/1.3.1\n` : 'GNU Wget 1.21.3 built on linux-gnu.\n');
      return 0;
    }
    const url = args.find((a, i) => !a.startsWith('-') && !['-o', '-O', '-w', '-H', '-X', '-d', '-u', '-m', '--max-time', '--output', '-T', '--connect-timeout', '--retry'].includes(args[i - 1] ?? '')) ?? '';
    const m = /^(?:(https?):\/\/)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url);
    if (!m) {
      io.err(kind === 'curl' ? `curl: (3) URL rejected: Malformed input to a URL function\n` : `wget: bad address '${url}'\n`);
      return kind === 'curl' ? 3 : 1;
    }
    const host = m[2];
    const port = Number(m[3] ?? (m[1] === 'https' ? 443 : 80));
    const path = m[4] ?? '/';
    const quietCurl = args.some((a) => /^-\w*s/.test(a) && !a.startsWith('--')) || args.includes('--silent');
    const showErr = args.some((a) => /^-\w*S/.test(a)) || args.includes('--show-error');
    const failFlag = args.some((a) => /^-\w*f/.test(a) && !a.startsWith('--')) || args.includes('--fail');
    const fail = (curlCode: number, curlMsg: string, wgetMsg: string) => {
      if (kind === 'curl') {
        if (!quietCurl || showErr) io.err(`curl: (${curlCode}) ${curlMsg}\n`);
        return curlCode;
      }
      io.err(`${wgetMsg}\n`);
      return curlCode === 22 ? 8 : 1;
    };
    const t = resolve(ctx, link, host);
    if (!t) return fail(6, `Could not resolve host: ${host}`, `wget: bad address '${host}'`);
    let reply = null as ReturnType<typeof containerHttp> | null;
    if (t.kind === 'self' && link.serve?.port === port) {
      const want = (link.serve.root + '/' + (path.endsWith('/') ? path + 'index.html' : path.split('?')[0])).replace(/\/+/g, '/');
      const body = read(ctx, want);
      reply = body === null ? { status: 404, body: '404 Not Found\n', server: 'busybox' } : { status: 200, body, server: 'busybox' };
    } else if (t.c) reply = containerHttp(link.host, link.st, t.c, mapped(t, port), path);
    if (t.c && listening(link.st, t.c, mapped(t, port), ctx.sys.now) !== 'open' && !(t.kind === 'self' && link.serve?.port === port) && !(t.c.serve?.port === mapped(t, port))) reply = null;
    if (!reply) return fail(7, `Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`, `wget: can't connect to remote host (${t.ip}): Connection refused`);
    if (reply === 'empty') return fail(52, 'Empty reply from server', 'wget: error getting response: Connection reset by peer');
    if (reply.status >= 400 && (kind === 'wget' || failFlag)) return fail(22, `The requested URL returned error: ${reply.status}`, `wget: server returned error: HTTP/1.1 ${reply.status} Not Found`);
    const writeOut = args[args.indexOf('-w') + 1];
    if (kind === 'curl') {
      const oi = args.findIndex((a) => a === '-o' || a === '--output');
      const head = args.includes('-I') || args.includes('--head');
      const text = head ? `HTTP/1.1 ${reply.status} ${reply.status === 200 ? 'OK' : 'Not Found'}\r\nServer: ${reply.server.split(':')[0]}\r\nContent-Length: ${reply.body.length}\r\n\r\n` : reply.body;
      if (oi >= 0 && args[oi + 1] && args[oi + 1] !== '/dev/null') put(ctx, joinPath(ctx.sys.cwd, args[oi + 1]), text);
      else if (oi < 0) io.out(text);
      if (args.includes('-w') && writeOut) io.out(writeOut.replace(/%\{http_code\}/g, String(reply.status)).replace(/\\n/g, '\n'));
      return 0;
    }
    // wget: -qO- prints, -O FILE saves, --spider only checks.
    if (args.includes('--spider')) return 0;
    const oi = args.findIndex((a) => a === '-O' || /^-\w*O$/.test(a));
    const dest = args.some((a) => /^-\w*O-$/.test(a)) ? '-' : oi >= 0 ? args[oi + 1] : path.split('/').pop() || 'index.html';
    if (!args.some((a) => /^-\w*q/.test(a))) io.err(`Connecting to ${host}:${port} (${t.ip}:${port})\n`);
    if (dest === '-') io.out(reply.body);
    else put(ctx, joinPath(ctx.sys.cwd, dest), reply.body);
    return 0;
  };
}

/* ----------------------------------------------------------------------------- postgres and redis clients */

interface PgDb {
  tables: Record<string, { cols: string[]; rows: string[][] }>;
}

function pgTarget(ctx: Ctx, args: string[]): { link: BoxLink; t: Target | null; host: string; port: number; user: string; db: string; local: boolean } | null {
  const link = boxLink(ctx.sys);
  if (!link) return null;
  const val = (short: string, long: string) => {
    const i = args.findIndex((a) => a === short || a === long);
    if (i >= 0) return args[i + 1];
    const eq = args.find((a) => a.startsWith(long + '='));
    return eq ? eq.slice(long.length + 1) : undefined;
  };
  const env = (k: string) => ctx.vars[k] ?? ctx.sys.env[k];
  const host = val('-h', '--host') ?? env('PGHOST') ?? '';
  const port = Number(val('-p', '--port') ?? env('PGPORT') ?? 5432);
  const user = val('-U', '--username') ?? env('PGUSER') ?? ctx.sys.user;
  const db = val('-d', '--dbname') ?? env('PGDATABASE') ?? user;
  const local = !host || host === '/var/run/postgresql';
  const t = local ? (link.self ? { kind: 'self' as const, c: link.self, ip: '' } : null) : resolve(ctx, link, host);
  return { link, t, host: local ? '/var/run/postgresql' : host, port, user, db, local };
}

function pgServerEnv(link: BoxLink, c: DockerContainer): Record<string, string> {
  const img = findImage(link.st, c.image);
  const env = { ...(img?.env ?? {}), ...c.env };
  return img ? withFileSecrets(link.host, img, c, env) : env;
}

const pgIsReady: Cmd = (args, io, ctx) => {
  const p = pgTarget(ctx, args);
  if (!p) return notFound(ctx, io, 'pg_isready');
  const quiet = args.includes('-q') || args.includes('--quiet');
  const where = p.local ? `/var/run/postgresql:${p.port}` : `${p.host}:${p.port}`;
  const ok = !!p.t && !!p.t.c && portOpen(ctx, p.link, p.t, p.port);
  if (!quiet) io.out(`${where} - ${ok ? 'accepting connections' : 'no response'}\n`);
  return ok ? 0 : 2;
};

function pgLoad(ctx: Ctx, link: BoxLink, c: DockerContainer, pgdata: string): PgDb {
  const path = `${pgdata}/cslab-db.json`;
  const text = c === link.self ? read(ctx, path) : (() => {
    const img = findImage(link.st, c.image);
    return img ? containerFile(link.host, img, c, path) : null;
  })();
  try {
    return text ? (JSON.parse(text) as PgDb) : { tables: {} };
  } catch {
    return { tables: {} };
  }
}

function pgSave(ctx: Ctx, link: BoxLink, c: DockerContainer, pgdata: string, db: PgDb): void {
  const path = `${pgdata}/cslab-db.json`;
  if (c === link.self) put(ctx, path, JSON.stringify(db));
  else {
    const img = findImage(link.st, c.image);
    if (img) writeContainerFile(link.host, link.st, img, c, path, JSON.stringify(db), 'postgres:postgres');
  }
}

function pgTable(cols: string[], rows: string[][]): string {
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => (r[i] ?? '').length)));
  const head = ' ' + cols.map((c, i) => c.padStart(Math.floor((w[i] + c.length) / 2)).padEnd(w[i])).join(' | ') + ' ';
  const sep = cols.map((_, i) => '-'.repeat(w[i] + 2)).join('+');
  const body = rows.map((r) => ' ' + r.map((v, i) => (/^-?\d+(\.\d+)?$/.test(v) ? v.padStart(w[i]) : v.padEnd(w[i]))).join(' | ') + ' ');
  return [head.replace(/\s+$/, ''), sep, ...body.map((b) => b.replace(/\s+$/, '')), `(${rows.length} row${rows.length === 1 ? '' : 's'})`, ''].join('\n') + '\n';
}

function splitValues(s: string): string[] {
  return (s.match(/'(?:[^']|'')*'|[^,]+/g) ?? []).map((v) => v.trim().replace(/^'(.*)'$/s, '$1').replace(/''/g, "'"));
}

const psql: Cmd = (args, io, ctx) => {
  const p = pgTarget(ctx, args);
  if (!p) return notFound(ctx, io, 'psql');
  const where = p.local ? `connection to server on socket "/var/run/postgresql/.s.PGSQL.${p.port}"` : `connection to server at "${p.host}" (${p.t?.ip ?? '?'}), port ${p.port}`;
  if (!p.t) {
    io.err(`psql: error: could not translate host name "${p.host}" to address: Name or service not known\n`);
    return 2;
  }
  if (!p.t.c || !portOpen(ctx, p.link, p.t, p.port)) {
    io.err(`psql: error: ${where} failed: ${p.local ? 'No such file or directory\n\tIs the server running locally and accepting connections on that socket?' : 'Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?'}\n`);
    return 2;
  }
  const env = pgServerEnv(p.link, p.t.c);
  const owner = env.POSTGRES_USER ?? 'postgres';
  if (p.user !== owner) {
    io.err(`psql: error: ${where} failed: FATAL:  role "${p.user}" does not exist\n`);
    return 2;
  }
  const password = ctx.vars.PGPASSWORD ?? ctx.sys.env.PGPASSWORD;
  if (!p.local && env.POSTGRES_HOST_AUTH_METHOD !== 'trust' && password !== env.POSTGRES_PASSWORD) {
    io.err(`psql: error: ${where} failed: ${password === undefined ? 'fe_sendauth: no password supplied' : `FATAL:  password authentication failed for user "${p.user}"`}\n`);
    return 2;
  }
  const dbName = env.POSTGRES_DB ?? owner;
  if (p.db !== dbName && p.db !== 'postgres') {
    io.err(`psql: error: ${where} failed: FATAL:  database "${p.db}" does not exist\n`);
    return 2;
  }
  const ci = args.findIndex((a) => a === '-c' || a === '--command' || /^-[a-zA-Z]+c$/.test(a));
  const sqlText = ci >= 0 ? args[ci + 1] ?? '' : io.stdin;
  const tuplesOnly = args.some((a) => /^-\w*t/.test(a) && a !== '-c');
  const pgdata = env.PGDATA ?? '/var/lib/postgresql/data';
  const store = pgLoad(ctx, p.link, p.t.c, pgdata);
  let dirty = false;
  let code = 0;
  for (const stmtRaw of sqlText.split(/;\s*(?:\n|$)|;\s+(?=\S)/)) {
    const stmt = stmtRaw.trim().replace(/;$/, '');
    if (!stmt) continue;
    let m: RegExpExecArray | null;
    if (/^\\dt$/.test(stmt)) {
      const names = Object.keys(store.tables).sort();
      io.out(names.length ? `${tuplesOnly ? '' : '          List of relations\n'}${pgTable(['Schema', 'Name', 'Type', 'Owner'], names.map((n) => ['public', n, 'table', owner]))}` : 'Did not find any relations.\n');
    } else if (/^\\l$/.test(stmt)) {
      io.out(pgTable(['Name', 'Owner', 'Encoding'], [...new Set([dbName, 'postgres', 'template0', 'template1'])].map((n) => [n, owner, 'UTF8'])));
    } else if (/^select\s+1$/i.test(stmt)) {
      io.out(tuplesOnly ? '        1\n\n' : pgTable(['?column?'], [['1']]));
    } else if (/^select\s+version\(\)$/i.test(stmt)) {
      io.out(pgTable(['version'], [['PostgreSQL 16.4 (Debian 16.4-1.pgdg120+2) on x86_64-pc-linux-gnu']]));
    } else if (/^select\s+current_database\(\)$/i.test(stmt)) {
      io.out(tuplesOnly ? ` ${p.db}\n\n` : pgTable(['current_database'], [[p.db]]));
    } else if ((m = /^create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\s*\(([\s\S]*)\)$/i.exec(stmt))) {
      const name = m[1].toLowerCase();
      if (store.tables[name] && !/if\s+not\s+exists/i.test(stmt)) {
        io.err(`ERROR:  relation "${name}" already exists\n`);
        code = 1;
        continue;
      }
      store.tables[name] ??= { cols: m[2].split(',').map((c) => c.trim().split(/\s+/)[0].toLowerCase()).filter((c) => !/^(primary|unique|foreign|constraint)$/i.test(c)), rows: [] };
      dirty = true;
      io.out('CREATE TABLE\n');
    } else if ((m = /^insert\s+into\s+(\w+)\s*(?:\(([^)]*)\))?\s*values\s*([\s\S]+)$/i.exec(stmt))) {
      const tbl = store.tables[m[1].toLowerCase()];
      if (!tbl) {
        io.err(`ERROR:  relation "${m[1]}" does not exist\n`);
        code = 1;
        continue;
      }
      const cols = m[2] ? m[2].split(',').map((c) => c.trim().toLowerCase()) : tbl.cols;
      const groups = m[3].match(/\((?:'(?:[^']|'')*'|[^)])*\)/g) ?? [];
      for (const g of groups) {
        const vals = splitValues(g.slice(1, -1));
        tbl.rows.push(tbl.cols.map((c) => (cols.indexOf(c) >= 0 ? vals[cols.indexOf(c)] ?? '' : String(tbl.rows.length + 1))));
      }
      dirty = true;
      io.out(`INSERT 0 ${groups.length}\n`);
    } else if ((m = /^select\s+(.+?)\s+from\s+(\w+)(?:\s+where\s+(\w+)\s*=\s*('(?:[^']|'')*'|\S+))?(?:\s+order\s+by\s+(\w+))?$/i.exec(stmt))) {
      const tbl = store.tables[m[2].toLowerCase()];
      if (!tbl) {
        io.err(`ERROR:  relation "${m[2]}" does not exist\nLINE 1: ${stmt}\n`);
        code = 1;
        continue;
      }
      let rows = tbl.rows;
      if (m[3]) {
        const ci2 = tbl.cols.indexOf(m[3].toLowerCase());
        const want = m[4].replace(/^'(.*)'$/s, '$1');
        rows = rows.filter((r) => r[ci2] === want);
      }
      if (/^count\(\*\)$/i.test(m[1].trim())) {
        io.out(tuplesOnly ? `     ${rows.length}\n\n` : pgTable(['count'], [[String(rows.length)]]));
        continue;
      }
      const cols = m[1].trim() === '*' ? tbl.cols : m[1].split(',').map((c) => c.trim().toLowerCase());
      const out = rows.map((r) => cols.map((c) => r[tbl.cols.indexOf(c)] ?? ''));
      io.out(tuplesOnly ? out.map((r) => ' ' + r.join(' | ')).join('\n') + '\n\n' : pgTable(cols, out));
    } else if ((m = /^drop\s+table\s+(?:if\s+exists\s+)?(\w+)$/i.exec(stmt))) {
      delete store.tables[m[1].toLowerCase()];
      dirty = true;
      io.out('DROP TABLE\n');
    } else {
      io.err(`ERROR:  this simulated PostgreSQL understands CREATE TABLE, INSERT, SELECT, DROP TABLE, \\dt and \\l\n`);
      code = 1;
    }
  }
  if (dirty) pgSave(ctx, p.link, p.t.c, pgdata, store);
  return code ? 1 : 0;
};

const redisCli: Cmd = (args, io, ctx) => {
  const link = boxLink(ctx.sys);
  if (!link) return notFound(ctx, io, 'redis-cli');
  const hi = args.indexOf('-h');
  const pi = args.indexOf('-p');
  const host = hi >= 0 ? args[hi + 1] : '127.0.0.1';
  const port = pi >= 0 ? Number(args[pi + 1]) : 6379;
  const cmd = args.filter((a, i) => !a.startsWith('-') && i !== hi + 1 && i !== pi + 1);
  const t = resolve(ctx, link, host);
  if (!t) {
    io.err(`Could not connect to Redis at ${host}:${port}: Name does not resolve\n`);
    return 1;
  }
  if (!t.c || !portOpen(ctx, link, t, port)) {
    io.err(`Could not connect to Redis at ${host}:${port}: Connection refused\n`);
    return 1;
  }
  const path = '/data/cslab-redis.json';
  const img = findImage(link.st, t.c.image)!;
  const self = t.c === link.self;
  const raw = self ? read(ctx, path) : containerFile(link.host, img, t.c, path);
  const store: Record<string, string> = raw ? JSON.parse(raw) : {};
  const save = () => (self ? put(ctx, path, JSON.stringify(store)) : writeContainerFile(link.host, link.st, img, t.c!, path, JSON.stringify(store), 'redis:redis'));
  const [verb, k, v] = cmd;
  switch ((verb ?? 'PING').toUpperCase()) {
    case 'PING':
      io.out('PONG\n');
      return 0;
    case 'SET':
      store[k] = v ?? '';
      save();
      io.out('OK\n');
      return 0;
    case 'GET':
      io.out(store[k] === undefined ? '(nil)\n' : `"${store[k]}"\n`);
      return 0;
    case 'INCR':
      store[k] = String(Number(store[k] ?? 0) + 1);
      save();
      io.out(`(integer) ${store[k]}\n`);
      return 0;
    case 'DEL':
      io.out(`(integer) ${k in store ? 1 : 0}\n`);
      delete store[k];
      save();
      return 0;
    case 'KEYS':
      io.out(Object.keys(store).map((x, i) => `${i + 1}) "${x}"\n`).join('') || '(empty array)\n');
      return 0;
    default:
      io.err(`(error) ERR unknown command '${verb}'\n`);
      return 1;
  }
};

const systemctl: Cmd = (args, io, ctx) => {
  if (!inBox(ctx)) return HOST.systemctl(args, io, ctx);
  io.err("System has not been booted with systemd as init system (PID 1). Can't operate.\nFailed to connect to bus: Host is down\n");
  return 1;
};

const sleep: Cmd = (args, io, ctx) => {
  if (inBox(ctx) && (args[0] === 'infinity' || Number(args[0]) >= 3600)) return forever(ctx);
  return HOST.sleep(args, io, ctx);
};

/** A process that never ends by itself (sleep infinity, tail -f): the container keeps running. */
function forever(ctx: Ctx): never {
  const link = boxLink(ctx.sys);
  if (link) link.forever = true;
  throw new ExitSignal(0);
}

const tail: Cmd = (args, io, ctx) => {
  if (inBox(ctx) && args.some((a) => a === '-f' || a === '-F' || a === '--follow')) {
    const files = args.filter((a) => !a.startsWith('-'));
    if (files.length) HOST.tail(args.filter((a) => a !== '-f' && a !== '-F' && a !== '--follow'), io, ctx);
    return forever(ctx);
  }
  return HOST.tail(args, io, ctx);
};

/** busybox adduser (-D, -S, -H, -u, -G, -h, -s) and Debian adduser (--disabled-password, --system, --group). */
const adduser: Cmd = (args, io, ctx) => {
  const ua: string[] = [];
  let name = '';
  let group = '';
  let system = false;
  let noHome = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-u' || a === '--uid') ua.push('-u', args[++i]);
    else if (a === '-G' || a === '--ingroup') group = args[++i];
    else if (a === '-h' || a === '--home') ua.push('-d', args[++i]);
    else if (a === '-s' || a === '--shell') ua.push('-s', args[++i]);
    else if (a === '-g' || a === '--gecos') ua.push('-c', args[++i]);
    else if (a === '-S' || a === '--system') system = true;
    else if (a === '-H' || a === '--no-create-home') noHome = true;
    else if (a === '-D' || a === '--disabled-password' || a === '--disabled-login' || a === '--group' || a === '-q' || a === '--quiet') continue;
    else if (!a.startsWith('-')) {
      if (!name) name = a;
      else group = a;
    }
  }
  if (!name) {
    io.err('adduser: no user name given\n');
    return 1;
  }
  if (ctx.sys.users[name]) {
    io.err(`adduser: user '${name}' in use\n`);
    return 1;
  }
  if (group && !ctx.sys.groups[group]) {
    io.err(`adduser: unknown group ${group}\n`);
    return 1;
  }
  if (system) ua.push('-r');
  if (!noHome && !system) ua.push('-m');
  if (group) ua.push('-g', group);
  return HOST.useradd([...ua, name], io, ctx);
};

const addgroup: Cmd = (args, io, ctx) => {
  const ga: string[] = [];
  let name = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-g' || a === '--gid') ga.push('-g', args[++i]);
    else if (a === '-S' || a === '--system') ga.push('-r');
    else if (!a.startsWith('-')) name = a;
  }
  if (!name) {
    io.err('addgroup: no group name given\n');
    return 1;
  }
  return HOST.groupadd([...ga, name], io, ctx);
};

/* ----------------------------------------------------------------------------- nginx inside its container */

/** nginx -t, -T, -s reload and -v, reading the configuration from the container's own files. */
const nginx: Cmd = (args, io, ctx) => {
  const link = boxLink(ctx.sys);
  if (!link || !isNginx(link.image)) return HOST.nginx ? HOST.nginx(args, io, ctx) : notFound(ctx, io, 'nginx');
  if (args.includes('-v') || args.includes('-V')) {
    io.err('nginx version: nginx/1.27.2\n');
    return 0;
  }
  const dir = '/etc/nginx/conf.d';
  const l = lookup(ctx.sys.fs, dir, ROOT);
  const list = l && l.node.type === 'dir' ? Object.entries(l.node.children).filter(([, n]) => n.type === 'file').map(([n]) => `${dir}/${n}`).sort() : [];
  const load = () => (link.self ? loadNginx(link.host, link.st, link.image, link.self, (p) => read(ctx, p), list) : { error: 'no container' });
  const ok = 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n';
  if (args.includes('-t') || args.includes('-T')) {
    const r = load();
    if ('error' in r) {
      io.err(`nginx: [emerg] ${r.error}\nnginx: configuration file /etc/nginx/nginx.conf test failed\n`);
      return 1;
    }
    io.err(ok);
    if (args.includes('-T')) for (const p of list) io.out(`# configuration file ${p}:\n${read(ctx, p) ?? ''}\n`);
    return 0;
  }
  const si = args.indexOf('-s');
  if (si >= 0) {
    const sig = args[si + 1];
    if (sig === 'reload') {
      const r = load();
      if ('error' in r) {
        io.err(`nginx: [emerg] ${r.error}\n`);
        return 1;
      }
      if (link.self) {
        link.self.web = r.conf;
        link.self.rr = {};
        link.self.logs.push('[notice] 1#1: signal 1 (SIGHUP) received from 30, reconfiguring', '[notice] 1#1: reconfiguring');
      }
      io.err(`${new Date(ctx.sys.now).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/')} [notice] 30#30: signal process started\n`);
      return 0;
    }
    if (sig === 'stop' || sig === 'quit' || sig === 'reopen') {
      io.err(`${new Date(ctx.sys.now).toISOString().replace('T', ' ').slice(0, 19).replace(/-/g, '/')} [notice] 30#30: signal process started\n`);
      return 0;
    }
    io.err(`nginx: invalid option: "-s ${sig ?? ''}"\n`);
    return 1;
  }
  io.err('nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address in use)\n(nginx already runs as this container\'s main process; use nginx -t to test the configuration and nginx -s reload to apply it.)\n');
  return 1;
};

/* ----------------------------------------------------------------------------- wiring */

let HOST: Record<string, Cmd> = {};

/** Commands that behave differently inside a container. Given the host's commands to fall back on. */
export function containerCommands(host: Record<string, Cmd>): Record<string, Cmd> {
  HOST = host;
  const pick = (name: string, inside: Cmd): Cmd => (args, io, ctx) => (inBox(ctx) ? inside(args, io, ctx) : host[name] ? host[name](args, io, ctx) : notFound(ctx, io, name));
  return {
    apk: pick('apk', apk),
    'apt-get': pick('apt-get', aptGet('apt-get')),
    apt: pick('apt', aptGet('apt')),
    pip: pick('pip', pip),
    pip3: pick('pip3', pip),
    npm: pick('npm', npm),
    node: pick('node', node),
    python3: python3,
    python: pick('python', python3),
    httpd: pick('httpd', httpd),
    nc,
    curl: httpClient('curl'),
    wget: httpClient('wget'),
    pg_isready: pgIsReady,
    psql,
    'redis-cli': redisCli,
    systemctl,
    sleep,
    tail,
    adduser,
    addgroup,
    nginx,

  };
}


/** Rough installed sizes, so image-size lessons show real differences. */
function pkgMb(name: string): number {
  const n = name.toLowerCase().replace(/[=<>~].*$/, '');
  const known: Record<string, number> = { numpy: 38, pandas: 62, scipy: 105, flask: 3.2, django: 33, requests: 0.6, psycopg2: 7, 'psycopg2-binary': 9, gunicorn: 0.6, curl: 2.6, git: 18, jq: 1.2, bash: 2.1, make: 0.5, gcc: 120, 'build-base': 220, 'build-essential': 260, python3: 48, nodejs: 74, npm: 12, 'postgresql-client': 9, tini: 0.1, openssl: 4.4, 'ca-certificates': 0.7, tzdata: 3.4 };
  return known[n] ?? 1.5;
}
