/**
 * A simulated Ansible: ansible-playbook, ad-hoc ansible and ansible-inventory. Playbooks run their
 * tasks against localhost (the machine itself, connection local) or against Docker containers
 * (connection community.docker.docker). Modules really change the system — packages, files,
 * templates, lines in files, services, users, groups, commands, git checkouts — and report
 * changed only when something changed, so a second run shows changed=0. Supports become, vars,
 * vars_files, roles, loops, when, register, notify/handlers, --check, --diff, --tags,
 * --syntax-check and --list-tasks, with Jinja2 expressions and filters for the common cases.
 */

import { lookup, mkdir, readFile, writeFile } from './fs.js';
import { actor, currentUser, runCommand, type Ctx } from './shell.js';
import { isSudoer } from './system.js';
import { abs, type IO } from './util.js';
import { parseYaml, type Yaml } from './yaml.js';
import { BoxError, dockerState, findImage, openBox, saveDocker, type Box, type DockerState } from './docker-engine.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;
type V = unknown;
type Vars = Record<string, V>;
const ROOT = { user: 'root', groups: ['root'] };

/* ----------------------------------------------------------------------------- Jinja2 (the common subset) */

class TplError extends Error {}

/** Splits an expression on a top-level operator, outside quotes and brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth === 0 && s.startsWith(sep, i)) {
      out.push(cur);
      cur = '';
      i += sep.length - 1;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function lookupVar(vars: Vars, path: string): V {
  let cur: V = vars;
  for (const part of path.match(/[^.[\]]+|\[[^\]]*\]/g) ?? []) {
    const key = part.startsWith('[') ? part.slice(1, -1).replace(/^['"]|['"]$/g, '') : part;
    if (cur && typeof cur === 'object') cur = (cur as Record<string, V>)[key];
    else return undefined;
  }
  return cur;
}

const truthy = (v: V) => !(v === undefined || v === null || v === false || v === '' || v === 0 || v === 'false' || v === 'no' || v === 'False' || (Array.isArray(v) && !v.length));
const str = (v: V): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function evalExpr(expr: string, vars: Vars): V {
  const e = expr.trim();
  if (!e) return '';
  // Filters: value | filter(args)
  const pipes = splitTop(e, '|');
  if (pipes.length > 1) {
    let v = evalExpr(pipes[0], vars);
    for (const f of pipes.slice(1)) {
      const m = /^\s*(\w+)\s*(?:\((.*)\))?\s*$/s.exec(f);
      if (!m) throw new TplError(`template error while templating string: unexpected '${f.trim()}'`);
      const args = m[2] ? splitTop(m[2], ',').map((a) => evalExpr(a, vars)) : [];
      v = applyFilter(m[1], v, args);
    }
    return v;
  }
  const ors = splitTop(e, ' or ');
  if (ors.length > 1) return ors.some((x) => truthy(evalExpr(x, vars)));
  const ands = splitTop(e, ' and ');
  if (ands.length > 1) return ands.every((x) => truthy(evalExpr(x, vars)));
  if (e.startsWith('not ')) return !truthy(evalExpr(e.slice(4), vars));
  for (const op of ['==', '!=', '>=', '<=', ' > ', ' < ', ' not in ', ' in ']) {
    const parts = splitTop(e, op);
    if (parts.length === 2) {
      const a = evalExpr(parts[0], vars);
      const b = evalExpr(parts[1], vars);
      switch (op.trim()) {
        case '==':
          return str(a) === str(b);
        case '!=':
          return str(a) !== str(b);
        case '>=':
          return Number(a) >= Number(b);
        case '<=':
          return Number(a) <= Number(b);
        case '>':
          return Number(a) > Number(b);
        case '<':
          return Number(a) < Number(b);
        case 'in':
          return Array.isArray(b) ? b.map(str).includes(str(a)) : str(b).includes(str(a));
        case 'not in':
          return !(Array.isArray(b) ? b.map(str).includes(str(a)) : str(b).includes(str(a)));
      }
    }
  }
  const tests = /^(.+?)\s+is\s+(not\s+)?(defined|undefined|none|succeeded|failed|changed|skipped)$/.exec(e);
  if (tests) {
    const v = tests[3] === 'defined' || tests[3] === 'undefined' ? lookupVarSafe(tests[1].trim(), vars) : evalExpr(tests[1], vars);
    let r: boolean;
    switch (tests[3]) {
      case 'defined':
        r = v !== undefined;
        break;
      case 'undefined':
        r = v === undefined;
        break;
      case 'none':
        r = v === null;
        break;
      case 'changed':
        r = !!(v as Vars)?.changed;
        break;
      case 'failed':
        r = !!(v as Vars)?.failed;
        break;
      case 'skipped':
        r = !!(v as Vars)?.skipped;
        break;
      default:
        r = !(v as Vars)?.failed;
    }
    return tests[2] ? !r : r;
  }
  if (/^'(?:[^'\\]|\\.)*'$|^"(?:[^"\\]|\\.)*"$/s.test(e)) return e.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  if (/^(true|True)$/.test(e)) return true;
  if (/^(false|False)$/.test(e)) return false;
  if (/^(none|None)$/.test(e)) return null;
  if (e.startsWith('[') && e.endsWith(']')) return e.slice(1, -1).trim() ? splitTop(e.slice(1, -1), ',').map((x) => evalExpr(x, vars)) : [];
  if (e.startsWith('(') && e.endsWith(')')) return evalExpr(e.slice(1, -1), vars);
  const plus = splitTop(e, ' ~ ');
  if (plus.length > 1) return plus.map((x) => str(evalExpr(x, vars))).join('');
  const add = splitTop(e, ' + ');
  if (add.length > 1) {
    const vs = add.map((x) => evalExpr(x, vars));
    return vs.every((x) => typeof x === 'number') ? (vs as number[]).reduce((a, b) => a + b, 0) : vs.every(Array.isArray) ? vs.flat() : vs.map(str).join('');
  }
  if (/^[A-Za-z_][\w.[\]'"]*$/.test(e)) {
    const v = lookupVarSafe(e, vars);
    if (v === undefined) throw new TplError(`'${e.split(/[.[]/)[0]}${e.includes('.') ? '' : ''}' is undefined`.replace(/^'(.+)' is undefined$/, (m0) => (lookupVarSafe(e.split(/[.[]/)[0], vars) === undefined ? m0 : `'dict object' has no attribute '${e.split('.').pop()}'`)));
    return v;
  }
  throw new TplError(`template error while templating string: unexpected '${e}'`);
}

function lookupVarSafe(path: string, vars: Vars): V {
  return lookupVar(vars, path);
}

function applyFilter(name: string, v: V, args: V[]): V {
  switch (name) {
    case 'default':
    case 'd':
      return v === undefined || (args[1] === true && !truthy(v)) ? args[0] : v;
    case 'upper':
      return str(v).toUpperCase();
    case 'lower':
      return str(v).toLowerCase();
    case 'trim':
      return str(v).trim();
    case 'length':
    case 'count':
      return Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : str(v).length;
    case 'join':
      return Array.isArray(v) ? v.map(str).join(str(args[0] ?? '')) : str(v);
    case 'int':
      return Math.trunc(Number(v)) || 0;
    case 'string':
      return str(v);
    case 'bool':
      return truthy(v);
    case 'replace':
      return str(v).split(str(args[0])).join(str(args[1]));
    case 'quote':
      return `'${str(v).replace(/'/g, `'"'"'`)}'`;
    case 'to_json':
      return JSON.stringify(v);
    case 'to_nice_yaml':
      return str(v);
    case 'basename':
      return str(v).split('/').pop();
    case 'dirname':
      return str(v).split('/').slice(0, -1).join('/');
    case 'first':
      return Array.isArray(v) ? v[0] : str(v)[0];
    case 'last':
      return Array.isArray(v) ? v[v.length - 1] : str(v).slice(-1);
    case 'sort':
      return Array.isArray(v) ? [...v].sort() : v;
    case 'unique':
      return Array.isArray(v) ? [...new Set(v)] : v;
    case 'list':
      return Array.isArray(v) ? v : [v];
    case 'mandatory':
      if (v === undefined) throw new TplError('Mandatory variable not defined.');
      return v;
    case 'regex_replace':
      return str(v).replace(new RegExp(str(args[0]), 'g'), str(args[1]).replace(/\\(\d)/g, '$$$1'));
    case 'b64encode':
      return btoa(str(v));
    case 'b64decode':
      return atob(str(v));
  }
  throw new TplError(`template error while templating string: No filter named '${name}'.`);
}

/** Renders a Jinja2 template: {{ expr }}, {% if %}/{% elif %}/{% else %}/{% endif %}, {% for x in y %}/{% endfor %}, {# comments #}. */
export function renderTemplate(text: string, vars: Vars): string {
  type Node = { kind: 'text'; text: string } | { kind: 'expr'; expr: string } | { kind: 'tag'; tag: string };
  const nodes: Node[] = [];
  const re = /\{\{-?\s*([\s\S]*?)\s*-?\}\}|\{%-?\s*([\s\S]*?)\s*-?%\}|\{#[\s\S]*?#\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let before = text.slice(last, m.index);
    if (m[0].startsWith('{%-') || m[0].startsWith('{{-')) before = before.replace(/\s+$/, '');
    if (before) nodes.push({ kind: 'text', text: before });
    if (m[1] !== undefined) nodes.push({ kind: 'expr', expr: m[1] });
    else if (m[2] !== undefined) nodes.push({ kind: 'tag', tag: m[2] });
    last = re.lastIndex;
    // Jinja's trim_blocks: a newline right after a block tag is dropped.
    if (m[2] !== undefined && text[last] === '\n') last++;
  }
  if (last < text.length) nodes.push({ kind: 'text', text: text.slice(last) });
  let i = 0;
  const run = (scope: Vars, stop: string[]): { out: string; stop: string } => {
    let out = '';
    while (i < nodes.length) {
      const n = nodes[i++];
      if (n.kind === 'text') out += n.text;
      else if (n.kind === 'expr') out += str(evalExpr(n.expr, scope));
      else {
        const t = n.tag;
        if (stop.some((s) => t === s || t.startsWith(s + ' '))) return { out, stop: t };
        const fm = /^for\s+(\w+)(?:\s*,\s*(\w+))?\s+in\s+(.+)$/.exec(t);
        if (fm) {
          const coll = evalExpr(fm[3], scope);
          const items: Array<[V, V]> = Array.isArray(coll) ? coll.map((x) => [x, undefined]) : coll && typeof coll === 'object' ? Object.entries(coll as Vars).map(([k, x]) => [k, x]) : [];
          const start = i;
          let end = i;
          if (!items.length) {
            run(scope, ['endfor']);
            end = i;
          }
          items.forEach(([a, b], idx) => {
            i = start;
            const inner: Vars = { ...scope, [fm[1]]: a, ...(fm[2] ? { [fm[2]]: b } : {}), loop: { index: idx + 1, index0: idx, first: idx === 0, last: idx === items.length - 1, length: items.length } };
            out += run(inner, ['endfor']).out;
            end = i;
          });
          i = end;
          continue;
        }
        const im = /^if\s+(.+)$/.exec(t);
        if (im) {
          let taken = truthy(evalExpr(im[1], scope));
          let r = run(scope, ['elif', 'else', 'endif']);
          if (taken) out += r.out;
          while (r.stop !== 'endif') {
            if (r.stop.startsWith('elif')) {
              const cond = !taken && truthy(evalExpr(r.stop.slice(5), scope));
              const r2 = run(scope, ['elif', 'else', 'endif']);
              if (cond) out += r2.out;
              taken = taken || cond;
              r = r2;
            } else {
              const r2 = run(scope, ['endif']);
              if (!taken) out += r2.out;
              r = r2;
            }
          }
          continue;
        }
        const sm = /^set\s+(\w+)\s*=\s*(.+)$/.exec(t);
        if (sm) {
          scope[sm[1]] = evalExpr(sm[2], scope);
          continue;
        }
        throw new TplError(`template error while templating string: Encountered unknown tag '${t.split(' ')[0]}'.`);
      }
    }
    return { out, stop: '' };
  };
  return run({ ...vars }, []).out;
}

/** Templates every string in a value (task arguments, vars). A string that is exactly "{{ x }}" keeps x's type. */
function templ(v: V, vars: Vars): V {
  if (typeof v === 'string') {
    const whole = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(v.trim());
    if (whole && !whole[1].includes('}}')) return evalExpr(whole[1], vars);
    return v.includes('{{') || v.includes('{%') ? renderTemplate(v, vars) : v;
  }
  if (Array.isArray(v)) return v.map((x) => templ(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Vars).map(([k, x]) => [k, templ(x, vars)]));
  return v;
}

/* ----------------------------------------------------------------------------- inventory */

interface Host {
  name: string;
  vars: Vars;
  groups: string[];
}

function parseInventory(text: string): Record<string, Host> | string {
  const hosts: Record<string, Host> = {};
  const groupVars: Record<string, Vars> = {};
  const children: Record<string, string[]> = {};
  const t = text.trim();
  if (/^(all|\w+):\s*$/m.test(t) && /hosts:|children:/.test(t)) {
    // YAML inventory.
    const doc = parseYaml(t) as Record<string, Yaml>;
    const walk = (group: string, node: Yaml) => {
      const n = (node && typeof node === 'object' && !Array.isArray(node) ? node : {}) as Record<string, Yaml>;
      groupVars[group] = { ...(groupVars[group] ?? {}), ...((n.vars ?? {}) as Vars) };
      for (const [h, hv] of Object.entries((n.hosts ?? {}) as Record<string, Yaml>)) {
        hosts[h] ??= { name: h, vars: {}, groups: [] };
        Object.assign(hosts[h].vars, (hv && typeof hv === 'object' ? hv : {}) as Vars);
        if (!hosts[h].groups.includes(group)) hosts[h].groups.push(group);
      }
      for (const [c, cv] of Object.entries((n.children ?? {}) as Record<string, Yaml>)) {
        (children[group] ??= []).push(c);
        walk(c, cv);
      }
    };
    for (const [g, node] of Object.entries(doc)) walk(g, node);
  } else {
    let section = 'ungrouped';
    let kind: 'hosts' | 'vars' | 'children' = 'hosts';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/[#;].*$/, '').trim();
      if (!line) continue;
      const sec = /^\[([\w.-]+)(?::(vars|children))?\]$/.exec(line);
      if (sec) {
        section = sec[1];
        kind = (sec[2] as 'vars' | 'children') ?? 'hosts';
        continue;
      }
      if (kind === 'vars') {
        const [k, ...v] = line.split('=');
        (groupVars[section] ??= {})[k.trim()] = v.join('=').trim();
        continue;
      }
      if (kind === 'children') {
        (children[section] ??= []).push(line);
        continue;
      }
      const [h, ...kv] = line.split(/\s+/);
      if (!/^[\w.-]+$/.test(h)) return `Failed to parse inventory: invalid host pattern '${h}'`;
      hosts[h] ??= { name: h, vars: {}, groups: [] };
      for (const p of kv) {
        const eq = p.indexOf('=');
        if (eq > 0) hosts[h].vars[p.slice(0, eq)] = p.slice(eq + 1).replace(/^['"]|['"]$/g, '');
      }
      if (!hosts[h].groups.includes(section)) hosts[h].groups.push(section);
    }
  }
  // Groups inherit hosts from their children; group vars apply to members.
  const membersOf = (g: string, seen: string[] = []): string[] => (seen.includes(g) ? [] : [...Object.values(hosts).filter((h) => h.groups.includes(g)).map((h) => h.name), ...(children[g] ?? []).flatMap((c) => membersOf(c, [...seen, g]))]);
  for (const g of Object.keys({ ...children, ...groupVars })) for (const h of membersOf(g)) if (!hosts[h].groups.includes(g)) hosts[h].groups.push(g);
  for (const h of Object.values(hosts)) h.vars = { ...Object.assign({}, ...h.groups.map((g) => groupVars[g] ?? {})), ...(groupVars.all ?? {}), ...h.vars };
  return hosts;
}

function loadInventory(ctx: Ctx, spec: string | undefined, io: IO, cwdDir: string): Record<string, Host> | null {
  const read = (p: string) => {
    try {
      return readFile(ctx.sys.fs, abs(ctx, p), actor(ctx));
    } catch {
      return null;
    }
  };
  let src = spec;
  if (!src) {
    const cfg = read(`${cwdDir}/ansible.cfg`) ?? read('/etc/ansible/ansible.cfg');
    src = cfg ? /^\s*inventory\s*=\s*(\S+)/m.exec(cfg)?.[1] : undefined;
    if (src && !src.startsWith('/')) src = `${cwdDir}/${src}`;
  }
  if (src && src.includes(',')) {
    const hosts: Record<string, Host> = {};
    for (const h of src.split(',').map((x) => x.trim()).filter(Boolean)) hosts[h] = { name: h, vars: {}, groups: ['ungrouped'] };
    return hosts;
  }
  const text = src ? read(src) : read('/etc/ansible/hosts');
  if (text === null) {
    io.err(`[WARNING]: Unable to parse ${src ?? '/etc/ansible/hosts'} as an inventory source\n[WARNING]: No inventory was parsed, only implicit localhost is available\n`);
    return {};
  }
  const r = parseInventory(text);
  if (typeof r === 'string') {
    io.err(`[WARNING]:  * ${r}\n`);
    return null;
  }
  return r;
}

function selectHosts(hosts: Record<string, Host>, pattern: string): Host[] {
  const out = new Map<string, Host>();
  for (const part of pattern.split(/[:,]/).map((p) => p.trim()).filter(Boolean)) {
    const neg = part.startsWith('!');
    const p = part.replace(/^[!&]/, '');
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const hits = p === 'all' ? Object.values(hosts) : Object.values(hosts).filter((h) => re.test(h.name) || h.groups.some((g) => re.test(g)));
    if (neg) for (const h of hits) out.delete(h.name);
    else for (const h of hits) out.set(h.name, h);
  }
  // The implicit localhost.
  if (!out.size && /^(localhost|127\.0\.0\.1)$/.test(pattern)) out.set('localhost', { name: 'localhost', vars: { ansible_connection: 'local' }, groups: ['ungrouped'] });
  return [...out.values()];
}

/* ----------------------------------------------------------------------------- connections */

interface Conn {
  ctx: Ctx;
  /** Called after each task to keep a container's changes. */
  done(): void;
  distro: 'suse' | 'debian' | 'alpine';
  facts: Vars;
}

function connect(ctx: Ctx, host: Host, become: boolean, becomeUser: string): Conn | { unreachable: string } {
  const conn = str(host.vars.ansible_connection);
  const local = conn === 'local' || ((!conn || conn === 'smart' || conn === 'ssh') && /^(localhost|127\.0\.0\.1)$/.test(host.name)) || (conn === 'ssh' && host.name === ctx.sys.hostname);
  if (local) {
    const c: Ctx = { ...ctx, euser: become ? becomeUser : ctx.euser };
    return { ctx: c, done: () => {}, distro: 'suse', facts: localFacts(ctx, host) };
  }
  if (/docker$/.test(conn)) {
    const st: DockerState = dockerState(ctx);
    const name = str(host.vars.ansible_host ?? host.name);
    const c = st.containers.find((k) => k.name === name);
    if (!c || c.status !== 'running') return { unreachable: `Failed to create temporary directory. In some cases, you may have been able to authenticate and did not have permissions on the target directory. Consider changing the remote tmp path in ansible.cfg to a path rooted in "/tmp". Error: container ${name} is not running` };
    const img = findImage(st, c.image)!;
    let box: Box;
    try {
      box = openBox(ctx, st, img, c, become ? { user: becomeUser } : {});
    } catch (e) {
      if (e instanceof BoxError) return { unreachable: e.message };
      throw e;
    }
    const distro = box.sys.container?.distro === 'alpine' ? 'alpine' : 'debian';
    return {
      ctx: box.ctx,
      done: () => {
        box.finish('container');
        saveDocker(ctx, st);
      },
      distro,
      facts: { ansible_hostname: c.id.slice(0, 12), ansible_os_family: distro === 'alpine' ? 'Alpine' : 'Debian', ansible_distribution: distro === 'alpine' ? 'Alpine' : 'Debian', ansible_user_id: box.sys.user, ansible_virtualization_type: 'docker' },
    };
  }
  return { unreachable: `Failed to connect to the host via ssh: ssh: connect to host ${str(host.vars.ansible_host ?? host.name)} port ${str(host.vars.ansible_port ?? 22)}: Connection refused` };
}

function localFacts(ctx: Ctx, host: Host): Vars {
  const sys = ctx.sys;
  return {
    ansible_hostname: sys.hostname,
    ansible_fqdn: sys.hostname,
    ansible_os_family: 'Suse',
    ansible_distribution: 'openSUSE Leap',
    ansible_distribution_version: '15.6',
    ansible_pkg_mgr: 'zypper',
    ansible_service_mgr: 'systemd',
    ansible_user_id: currentUser(ctx),
    ansible_default_ipv4: { address: sys.network?.address.split('/')[0] ?? '10.0.0.10' },
    inventory_hostname: host.name,
  };
}

/* ----------------------------------------------------------------------------- modules */

interface Result {
  changed?: boolean;
  failed?: boolean;
  skipped?: boolean;
  msg?: string;
  rc?: number;
  stdout?: string;
  stderr?: string;
  stdout_lines?: string[];
  diff?: { before: string; after: string; path: string };
  [k: string]: V;
}

interface RunEnv {
  conn: Conn;
  check: boolean;
  dir: string;
  role?: string;
}

const capture = (): { io: IO; out: () => string; err: () => string } => {
  const o: string[] = [];
  const e: string[] = [];
  return { io: { stdin: '', out: (t) => o.push(t), err: (t) => e.push(t) }, out: () => o.join(''), err: () => e.join('') };
};

function run(env: RunEnv, argv: string[]): { rc: number; out: string; err: string } {
  const c = capture();
  const rc = runCommand(env.conn.ctx, argv, c.io);
  return { rc, out: c.out(), err: c.err() };
}

const isRoot = (env: RunEnv) => currentUser(env.conn.ctx) === 'root';

function node(env: RunEnv, path: string) {
  return lookup(env.conn.ctx.sys.fs, path, ROOT);
}

function readText(env: RunEnv, path: string): string | null {
  const l = node(env, path);
  return l && l.node.type === 'file' ? l.node.content : null;
}

/** Applies owner/group/mode to a path, reporting whether anything changed. */
function attrs(env: RunEnv, path: string, a: Vars): { changed: boolean; error?: string } {
  const l = node(env, path);
  if (!l) return { changed: false };
  let changed = false;
  const sys = env.conn.ctx.sys;
  if (a.owner !== undefined && l.node.owner !== str(a.owner)) {
    if (!sys.users[str(a.owner)]) return { changed, error: `chown failed: failed to look up user ${str(a.owner)}` };
    if (!isRoot(env)) return { changed, error: `chown failed: [Errno 1] Operation not permitted: b'${path}'` };
    if (!env.check) l.node.owner = str(a.owner);
    changed = true;
  }
  if (a.group !== undefined && l.node.group !== str(a.group)) {
    if (!sys.groups[str(a.group)]) return { changed, error: `chgrp failed: failed to look up group ${str(a.group)}` };
    if (!env.check) l.node.group = str(a.group);
    changed = true;
  }
  if (a.mode !== undefined) {
    const raw = str(a.mode).replace(/^0o/, '');
    const m = /^[0-7]{3,4}$/.test(raw) ? parseInt(raw, 8) : null;
    if (m === null) return { changed, error: `bad symbolic permission for mode: ${str(a.mode)}` };
    if ((l.node.mode & 0o7777) !== m) {
      if (!env.check) l.node.mode = (l.node.mode & ~0o7777) | m;
      changed = true;
    }
  }
  return { changed };
}

function writeManaged(env: RunEnv, dest: string, content: string, a: Vars): Result {
  const before = readText(env, dest);
  const l = node(env, dest);
  if (l && l.node.type === 'dir') return { failed: true, msg: `Destination ${dest} is a directory; set dest to a file path.` };
  const parent = dest.slice(0, dest.lastIndexOf('/')) || '/';
  if (!node(env, parent)) return { failed: true, msg: `Destination directory ${parent} does not exist` };
  let changed = before !== content;
  if (changed && !env.check) {
    try {
      writeFile(env.conn.ctx.sys.fs, dest, content, actor(env.conn.ctx), env.conn.ctx.sys.now);
    } catch (e) {
      return { failed: true, msg: `Destination ${parent} not writable: ${(e as Error).message}` };
    }
  }
  if (!env.check || before !== null) {
    const at = attrs(env, dest, a);
    if (at.error) return { failed: true, msg: at.error };
    changed = changed || at.changed;
  }
  return { changed, dest, ...(before !== content ? { diff: { before: before ?? '', after: content, path: dest } } : {}) };
}

/** Finds a file a module refers to: the role's or playbook's files/ (or templates/) folder, else the path as given. */
function findSource(ctx: Ctx, env: RunEnv, src: string, kind: 'files' | 'templates'): string | null {
  const cands = src.startsWith('/') ? [src] : [...(env.role ? [`${env.dir}/roles/${env.role}/${kind}/${src}`] : []), `${env.dir}/${kind}/${src}`, `${env.dir}/${src}`];
  for (const c of cands) {
    try {
      readFile(ctx.sys.fs, c, actor(ctx));
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

const asList = (v: V): string[] => (Array.isArray(v) ? v.map(str) : str(v).split(',').map((x) => x.trim()).filter(Boolean));
const yes = (v: V) => ['yes', 'true', 'True', true, 'on', '1', 1].includes(v as string);

type Module = (a: Vars, env: RunEnv, host: Host, hostCtx: Ctx, vars: Vars) => Result;

const MODULES: Record<string, Module> = {
  ping: () => ({ changed: false, ping: 'pong' }),
  debug: (a, _env, _h, _c, vars) => (a.var !== undefined ? { changed: false, [str(a.var)]: (() => { try { return evalExpr(str(a.var), vars); } catch { return 'VARIABLE IS NOT DEFINED!'; } })() } : { changed: false, msg: (a.msg ?? 'Hello world!') as string }),
  fail: (a) => ({ failed: true, msg: str(a.msg ?? 'Failed as requested from task') }),
  assert: (a, _e, _h, _c, vars) => {
    for (const cond of asList(a.that ?? [])) {
      let ok = false;
      try {
        ok = truthy(evalExpr(cond, vars));
      } catch {
        ok = false;
      }
      if (!ok) return { failed: true, assertion: cond, msg: str(a.fail_msg ?? a.msg ?? 'Assertion failed') };
    }
    return { changed: false, msg: str(a.success_msg ?? 'All assertions passed') };
  },
  set_fact: (a) => ({ changed: false, ansible_facts: a }),
  package: (a, env) => pkg(a, env, env.conn.distro === 'alpine' ? 'apk' : env.conn.distro === 'debian' ? 'apt' : 'zypper'),
  zypper: (a, env) => (env.conn.distro !== 'suse' ? { failed: true, msg: 'Failed to find required executable "zypper" in paths: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } : pkg(a, env, 'zypper')),
  apt: (a, env) => (env.conn.distro !== 'debian' ? { failed: true, msg: env.conn.distro === 'suse' ? 'Could not import the apt module: apt-get is not installed on this openSUSE host. Use ansible.builtin.package or community.general.zypper.' : 'apt-get not found' } : pkg(a, env, 'apt')),
  apk: (a, env) => (env.conn.distro !== 'alpine' ? { failed: true, msg: 'Failed to find required executable "apk"' } : pkg(a, env, 'apk')),
  dnf: () => ({ failed: true, msg: 'Failed to find required executable "dnf" in paths: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }),
  copy: (a, env, _h, hostCtx) => {
    const dest = str(a.dest);
    if (!dest) return { failed: true, msg: 'missing required arguments: dest' };
    let content: string;
    if (a.content !== undefined) content = str(a.content);
    else {
      const src = findSource(hostCtx, env, str(a.src), 'files');
      if (!src) return { failed: true, msg: `Could not find or access '${str(a.src)}'\nSearched in:\n\t${env.dir}/files/${str(a.src)}\n\t${env.dir}/${str(a.src)} on the Ansible Controller.\nIf you are using a module and expect the file to exist on the remote, see the remote_src option` };
      content = readFile(hostCtx.sys.fs, src, actor(hostCtx));
    }
    const target = node(env, dest)?.node.type === 'dir' ? `${dest.replace(/\/$/, '')}/${str(a.src).split('/').pop()}` : dest;
    return writeManaged(env, target, content, a);
  },
  template: (a, env, _h, hostCtx, vars) => {
    const src = findSource(hostCtx, env, str(a.src), 'templates');
    if (!src) return { failed: true, msg: `Could not find or access '${str(a.src)}'\nSearched in:\n\t${env.dir}/templates/${str(a.src)}\n\t${env.dir}/${str(a.src)}` };
    let content: string;
    try {
      content = renderTemplate(readFile(hostCtx.sys.fs, src, actor(hostCtx)), vars);
    } catch (e) {
      return { failed: true, msg: `AnsibleUndefinedVariable: ${(e as Error).message}. ${str(a.src)}` };
    }
    return writeManaged(env, str(a.dest), content, a);
  },
  file: (a, env) => {
    const path = str(a.path ?? a.dest ?? a.name);
    const state = str(a.state ?? (node(env, path) ? (node(env, path)!.node.type === 'dir' ? 'directory' : 'file') : 'file'));
    const fs = env.conn.ctx.sys.fs;
    const exists = node(env, path);
    try {
      switch (state) {
        case 'directory': {
          if (exists && exists.node.type !== 'dir') return { failed: true, msg: `${path} already exists as a ${exists.node.type}` };
          let changed = !exists;
          if (!exists && !env.check) mkdir(fs, path, actor(env.conn.ctx), env.conn.ctx.sys.now, true);
          const at = attrs(env, path, a);
          if (at.error) return { failed: true, msg: at.error };
          changed = changed || at.changed;
          return { changed, path, state };
        }
        case 'absent': {
          if (!exists) return { changed: false, path, state: 'absent' };
          if (!env.check) run(env, ['rm', '-rf', path]);
          return { changed: true, path, state: 'absent' };
        }
        case 'touch': {
          if (!env.check) run(env, ['touch', path]);
          const at = attrs(env, path, a);
          return { changed: true, path, ...(at.error ? { failed: true, msg: at.error } : {}) };
        }
        case 'link': {
          const src = str(a.src);
          const l = lookup(fs, path, ROOT, false);
          if (l && l.node.type === 'link' && l.node.target === src) return { changed: false, path, src };
          if (!env.check) {
            const r = run(env, ['ln', '-sfn', src, path]);
            if (r.rc) return { failed: true, msg: r.err.trim() };
          }
          return { changed: true, path, src };
        }
        default: {
          if (!exists) return { failed: true, msg: `file (${path}) is absent, cannot continue`, path };
          const at = attrs(env, path, a);
          if (at.error) return { failed: true, msg: at.error };
          return { changed: at.changed, path };
        }
      }
    } catch (e) {
      return { failed: true, msg: (e as Error).message };
    }
  },
  lineinfile: (a, env) => {
    const path = str(a.path ?? a.dest);
    let text = readText(env, path);
    if (text === null) {
      if (!yes(a.create)) return { failed: true, rc: 257, msg: `Destination ${path} does not exist !` };
      text = '';
    }
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const line = a.line !== undefined ? str(a.line) : undefined;
    const re = a.regexp !== undefined ? new RegExp(str(a.regexp)) : null;
    let next = [...lines];
    if (str(a.state ?? 'present') === 'absent') next = lines.filter((l) => !(re ? re.test(l) : l === line));
    else {
      if (line === undefined) return { failed: true, msg: 'line is required with state=present' };
      const idx = re ? lines.map((l, i) => (re.test(l) ? i : -1)).filter((i) => i >= 0).pop() ?? -1 : lines.indexOf(line);
      if (idx >= 0) next[idx] = line;
      else if (!lines.includes(line)) {
        const after = a.insertafter && a.insertafter !== 'EOF' ? lines.map((l, i) => (new RegExp(str(a.insertafter)).test(l) ? i : -1)).filter((i) => i >= 0).pop() : undefined;
        const before = a.insertbefore ? (a.insertbefore === 'BOF' ? 0 : lines.findIndex((l) => new RegExp(str(a.insertbefore)).test(l))) : undefined;
        if (before !== undefined && before >= 0) next.splice(before, 0, line);
        else if (after !== undefined) next.splice(after + 1, 0, line);
        else next.push(line);
      }
    }
    const content = next.join('\n') + (next.length ? '\n' : '');
    const r = writeManaged(env, path, content, a);
    if (r.changed && !r.failed) r.msg = str(a.state) === 'absent' ? `${lines.length - next.length} line(s) removed` : node(env, path) && text.includes(line ?? '\u0000') ? 'line replaced' : 'line added';
    return r;
  },
  service: (a, env) => svc(a, env),
  systemd: (a, env) => svc(a, env),
  systemd_service: (a, env) => svc(a, env),
  user: (a, env) => {
    const sys = env.conn.ctx.sys;
    const name = str(a.name);
    const exists = !!sys.users[name];
    if (str(a.state ?? 'present') === 'absent') {
      if (!exists) return { changed: false, name, state: 'absent' };
      if (!isRoot(env)) return { failed: true, msg: 'userdel: Permission denied.' };
      if (!env.check) run(env, ['userdel', ...(yes(a.remove) ? ['-r'] : []), name]);
      return { changed: true, name, state: 'absent' };
    }
    const groups = a.groups !== undefined ? asList(a.groups) : [];
    if (!exists) {
      if (!isRoot(env)) return { failed: true, msg: 'useradd: Permission denied.\nuseradd: cannot lock /etc/passwd; try again later.', name };
      for (const g of groups) if (!sys.groups[g]) return { failed: true, msg: `Group ${g} does not exist`, name };
      if (!env.check) {
        const r = run(env, ['useradd', ...(yes(a.system) ? ['-r'] : []), ...(a.create_home === undefined || yes(a.create_home) ? ['-m'] : []), ...(a.shell ? ['-s', str(a.shell)] : []), ...(a.uid ? ['-u', str(a.uid)] : []), ...(a.comment ? ['-c', str(a.comment)] : []), ...(a.home ? ['-d', str(a.home)] : []), ...(groups.length ? ['-G', groups.join(',')] : []), name]);
        if (r.rc) return { failed: true, msg: (r.err || r.out).trim(), name };
      }
      return { changed: true, name, state: 'present', groups: groups.join(','), shell: str(a.shell ?? '/bin/bash') };
    }
    const u = sys.users[name];
    let changed = false;
    if (a.shell && u.shell !== str(a.shell)) {
      changed = true;
      if (!env.check) run(env, ['usermod', '-s', str(a.shell), name]);
    }
    const have = u.groups.slice(1);
    const want = yes(a.append) ? [...new Set([...have, ...groups])] : a.groups !== undefined ? groups : have;
    if (a.groups !== undefined && (want.length !== have.length || want.some((g) => !have.includes(g)))) {
      for (const g of groups) if (!sys.groups[g]) return { failed: true, msg: `Group ${g} does not exist`, name };
      changed = true;
      if (!env.check) run(env, ['usermod', '-G', want.join(','), name]);
    }
    if (changed && !isRoot(env)) return { failed: true, msg: 'usermod: Permission denied.', name };
    return { changed, name, state: 'present' };
  },
  group: (a, env) => {
    const sys = env.conn.ctx.sys;
    const name = str(a.name);
    const exists = !!sys.groups[name];
    if (str(a.state ?? 'present') === 'absent') {
      if (exists && !env.check) run(env, ['groupdel', name]);
      return { changed: exists, name };
    }
    if (exists) return { changed: false, name, gid: sys.groups[name].gid };
    if (!isRoot(env)) return { failed: true, msg: 'groupadd: Permission denied.' };
    if (!env.check) run(env, ['groupadd', ...(yes(a.system) ? ['-r'] : []), ...(a.gid ? ['-g', str(a.gid)] : []), name]);
    return { changed: true, name };
  },
  command: (a, env) => cmd(a, env, false),
  shell: (a, env) => cmd(a, env, true),
  stat: (a, env) => {
    const p = str(a.path);
    const l = node(env, p);
    return { changed: false, stat: l ? { exists: true, isdir: l.node.type === 'dir', isreg: l.node.type === 'file', mode: (l.node.mode & 0o7777).toString(8).padStart(4, '0'), pw_name: l.node.owner, gr_name: l.node.group, path: p } : { exists: false } };
  },
  git: (a, env) => {
    const dest = str(a.dest);
    const repo = str(a.repo);
    const version = str(a.version ?? 'HEAD');
    const has = node(env, `${dest}/.git`);
    const head = () => run(env, ['git', '-C', dest, 'rev-parse', 'HEAD']).out.trim();
    const before = has ? head() : '';
    if (env.check) return { changed: !has, before, after: before };
    if (!has) {
      const r = run(env, ['git', 'clone', '-q', repo, dest]);
      if (r.rc) return { failed: true, msg: `Failed to download remote objects and refs: ${r.err.trim()}`, cmd: `/usr/bin/git clone --origin origin ${repo} ${dest}` };
    } else {
      const r = run(env, ['git', '-C', dest, 'fetch', '-q', 'origin']);
      if (r.rc) return { failed: true, msg: r.err.trim() };
    }
    if (version !== 'HEAD') {
      const r = run(env, ['git', '-C', dest, 'checkout', '-q', '--force', version]);
      if (r.rc) return { failed: true, msg: `Failed to checkout ${version}: ${r.err.trim()}` };
      run(env, ['git', '-C', dest, 'merge', '-q', '--ff-only', `origin/${version}`]);
    } else if (has) run(env, ['git', '-C', dest, 'merge', '-q', '--ff-only', '@{u}']);
    const after = head();
    return { changed: before !== after, before: before || null, after };
  },
  uri: (a, env) => {
    const r = run(env, ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', str(a.url)]);
    const status = Number(r.out.trim()) || -1;
    const want = Array.isArray(a.status_code) ? a.status_code.map(Number) : [Number(a.status_code ?? 200)];
    return want.includes(status) ? { changed: false, status, url: str(a.url) } : { failed: true, status, url: str(a.url), msg: status < 0 ? `Status code was -1 and not [${want.join(', ')}]: Request failed: <urlopen error [Errno 111] Connection refused>` : `Status code was ${status} and not [${want.join(', ')}]: HTTP Error ${status}` };
  },
};

function pkg(a: Vars, env: RunEnv, manager: 'zypper' | 'apt' | 'apk'): Result {
  const names = asList(a.name ?? a.pkg);
  const state = str(a.state ?? 'present');
  const sys = env.conn.ctx.sys;
  const installed = (n: string) => (manager === 'zypper' ? !!sys.packages[n]?.installed : !!Object.entries(sys.packages).find(([k, p]) => k.startsWith('tool:') && p.installed && (p.provides ?? []).length && (k === `tool:${n}` || readText(env, `/usr/share/apk/installed/${n}`) !== null || readText(env, `/var/lib/dpkg/info/${n}.list`) !== null)));
  const missing = names.filter((n) => manager === 'zypper' && !sys.packages[n]);
  if (missing.length) return { failed: true, msg: `No provider of '${missing[0]}' found.`, rc: 104 };
  if (state === 'absent') {
    const present = names.filter(installed);
    if (!present.length) return { changed: false, msg: 'Nothing to remove' };
    if (!isRoot(env)) return { failed: true, msg: 'Root privileges are required for uninstalling packages.' };
    if (!env.check) run(env, manager === 'zypper' ? ['zypper', '--non-interactive', 'remove', ...present] : manager === 'apt' ? ['apt-get', 'remove', '-y', ...present] : ['apk', 'del', ...present]);
    return { changed: true, removed: present };
  }
  const todo = names.filter((n) => !installed(n));
  if (!todo.length) return { changed: false, msg: `All packages are already installed` };
  if (!isRoot(env)) return { failed: true, rc: 1, msg: manager === 'zypper' ? 'Root privileges are required for installing or uninstalling packages.' : manager === 'apt' ? "Failed to lock apt for exclusive operation: Failed to lock directory /var/lib/apt/lists/: E:Could not open lock file /var/lib/apt/lists/lock - open (13: Permission denied)" : 'ERROR: Unable to lock database: Permission denied' };
  if (env.check) return { changed: true, installed: todo };
  if (manager === 'apt' && yes(a.update_cache)) run(env, ['apt-get', 'update']);
  const r = run(env, manager === 'zypper' ? ['zypper', '--non-interactive', 'install', ...todo] : manager === 'apt' ? ['apt-get', 'install', '-y', ...todo] : ['apk', 'add', '--no-cache', ...todo]);
  if (r.rc) return { failed: true, rc: r.rc, msg: (r.err || r.out).trim().split('\n').pop() ?? 'install failed', stdout: r.out };
  return { changed: true, installed: todo };
}

function svc(a: Vars, env: RunEnv): Result {
  const sys = env.conn.ctx.sys;
  if (sys.container) return { failed: true, msg: 'Service is in unknown state', status: {} , warnings: ['System has not been booted with systemd as init system (PID 1). Can\'t operate.'] };
  const name = str(a.name).replace(/\.service$/, '');
  const s = sys.services[name];
  if (!s || (s.package && !sys.packages[s.package]?.installed)) return { failed: true, msg: `Could not find the requested service ${name}: host` };
  let changed = false;
  const want = a.state !== undefined ? str(a.state) : undefined;
  const steps: string[][] = [];
  if (a.enabled !== undefined && s.enabled !== yes(a.enabled)) {
    changed = true;
    steps.push(['systemctl', yes(a.enabled) ? 'enable' : 'disable', name]);
  }
  if (want === 'started' && !s.active) {
    changed = true;
    steps.push(['systemctl', 'start', name]);
  } else if (want === 'stopped' && s.active) {
    changed = true;
    steps.push(['systemctl', 'stop', name]);
  } else if (want === 'restarted' || want === 'reloaded') {
    changed = true;
    steps.push(['systemctl', want === 'restarted' ? 'restart' : 'reload', name]);
  }
  if (changed && !isRoot(env)) return { failed: true, msg: `Unable to ${want === 'started' ? 'start' : 'change'} service ${name}: Failed to ${steps[0][1]} ${name}.service: Access denied` };
  if (!env.check) {
    for (const st of steps) {
      const r = run(env, st);
      if (r.rc) return { failed: true, msg: `Unable to ${st[1]} service ${name}: ${(r.err || r.out).trim()}` };
    }
  }
  return { changed, name, state: s.active ? 'started' : 'stopped', enabled: s.enabled };
}

function cmd(a: Vars, env: RunEnv, shell: boolean): Result {
  const text = str(a._raw_params ?? a.cmd ?? a.argv);
  if (a.creates && node(env, str(a.creates))) return { changed: false, skipped_reason: 'creates exists', msg: `Did not run command since '${str(a.creates)}' exists`, rc: 0, stdout: '', stdout_lines: [] };
  if (a.removes && !node(env, str(a.removes))) return { changed: false, msg: `Did not run command since '${str(a.removes)}' does not exist`, rc: 0, stdout: '', stdout_lines: [] };
  if (env.check) return { changed: false, skipped: true, msg: 'Command would have run if not in check mode' };
  const savedCwd = env.conn.ctx.sys.cwd;
  if (a.chdir) env.conn.ctx.sys.cwd = str(a.chdir);
  const c = capture();
  let rc: number;
  try {
    rc = shell ? runCommand(env.conn.ctx, ['bash', '-c', text], c.io) : runCommand(env.conn.ctx, text.match(/"[^"]*"|'[^']*'|\S+/g)?.map((w) => w.replace(/^["'](.*)["']$/s, '$1')) ?? [], c.io);
  } finally {
    env.conn.ctx.sys.cwd = savedCwd;
  }
  const out = c.out().replace(/\n$/, '');
  const err = c.err().replace(/\n$/, '');
  return { changed: true, rc, stdout: out, stderr: err, stdout_lines: out ? out.split('\n') : [], cmd: text, ...(rc ? { failed: true, msg: 'non-zero return code' } : {}) };
}

/* ----------------------------------------------------------------------------- playbooks */

const TASK_KEYS = new Set(['name', 'when', 'loop', 'with_items', 'with_list', 'register', 'notify', 'become', 'become_user', 'tags', 'changed_when', 'failed_when', 'ignore_errors', 'vars', 'args', 'loop_control', 'delegate_to', 'run_once', 'no_log', 'check_mode', 'block', 'rescue', 'always', 'environment', 'listen', 'retries', 'delay', 'until']);
const PREFIX = /^(ansible\.builtin\.|ansible\.legacy\.|community\.general\.|community\.docker\.|ansible\.posix\.)/;

interface Task {
  raw: Record<string, Yaml>;
  module: string;
  args: Vars;
  name: string;
  role?: string;
}

function kvArgs(s: string): Vars {
  const out: Vars = {};
  const rest: string[] = [];
  for (const w of s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const m = /^(\w+)=(.*)$/s.exec(w);
    if (m) out[m[1]] = m[2].replace(/^["'](.*)["']$/s, '$1');
    else rest.push(w);
  }
  if (rest.length) out._raw_params = rest.join(' ');
  return out;
}

function toTask(raw: Record<string, Yaml>, role?: string): Task | string {
  const keys = Object.keys(raw).filter((k) => !TASK_KEYS.has(k));
  if (raw.block) return { raw, module: 'block', args: {}, name: str(raw.name ?? ''), role };
  if (!keys.length) return `no module/action detected in task.`;
  if (keys.length > 1) return `conflicting action statements: ${keys.slice(0, 2).join(', ')}`;
  const full = keys[0];
  const mod = full.replace(PREFIX, '');
  const v = raw[full];
  let args: Vars = typeof v === 'string' ? (['command', 'shell', 'debug'].includes(mod) ? (mod === 'debug' ? kvArgs(v) : { _raw_params: v }) : kvArgs(v)) : ((v ?? {}) as Vars);
  if (raw.args && typeof raw.args === 'object') args = { ...args, ...(raw.args as Vars) };
  if (!MODULES[mod] && !['include_tasks', 'import_tasks', 'include_role', 'import_role', 'meta', 'pause'].includes(mod)) return `couldn't resolve module/action '${full}'. This often indicates a misspelling, missing collection, or incorrect module path.`;
  return { raw, module: mod, args, name: str(raw.name ?? `${mod}${mod === 'command' || mod === 'shell' ? '' : ''}`), role };
}

const stars = (title: string) => `${title} ${'*'.repeat(Math.max(3, 79 - title.length))}`;

interface Stats {
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  skipped: number;
  rescued: number;
  ignored: number;
}

function diffText(d: { before: string; after: string; path: string }): string {
  const a = d.before.split('\n');
  const b = d.after.split('\n');
  if (a[a.length - 1] === '') a.pop();
  if (b[b.length - 1] === '') b.pop();
  const out = [`--- before: ${d.path}`, `+++ after: ${d.path}`, `@@ -1,${a.length} +1,${b.length} @@`];
  // A plain line-by-line diff is enough for configuration files.
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(' ' + a[i]);
      i++;
      j++;
    } else if (i < a.length && !b.slice(j).includes(a[i])) out.push('-' + a[i++]);
    else if (j < b.length && !a.slice(i).includes(b[j])) out.push('+' + b[j++]);
    else if (i < a.length) out.push('-' + a[i++]);
  }
  return out.join('\n') + '\n';
}

interface PlayOpts {
  check: boolean;
  diff: boolean;
  tags: string[];
  skipTags: string[];
  extraVars: Vars;
  limit?: string;
  verbose: number;
  becomeAll: boolean;
}

function readYamlFile(ctx: Ctx, path: string): Yaml | null {
  try {
    return parseYaml(readFile(ctx.sys.fs, path, actor(ctx)));
  } catch {
    return null;
  }
}

function loadTasks(ctx: Ctx, path: string, role: string | undefined, io: IO): Task[] | null {
  const doc = readYamlFile(ctx, path);
  if (doc === null) return [];
  if (!Array.isArray(doc)) {
    io.err(`ERROR! A malformed block was encountered while loading tasks: ${path} should contain a list of tasks\n`);
    return null;
  }
  const out: Task[] = [];
  for (const t of doc) {
    const r = toTask(t as Record<string, Yaml>, role);
    if (typeof r === 'string') {
      io.err(`ERROR! ${r}\n\nThe error appears to be in '${path}'\n`);
      return null;
    }
    out.push(r);
  }
  return out;
}

function playbook(ctx: Ctx, file: string, inv: Record<string, Host>, o: PlayOpts, io: IO, mode: 'run' | 'syntax' | 'list'): number {
  let text: string;
  try {
    text = readFile(ctx.sys.fs, abs(ctx, file), actor(ctx));
  } catch {
    io.err(`ERROR! the playbook: ${file} could not be found\n`);
    return 1;
  }
  let doc: Yaml;
  try {
    doc = parseYaml(text);
  } catch (e) {
    io.err(`ERROR! We were unable to read either as JSON nor YAML, these are the errors we got from each:\nJSON: Expecting value: line 1 column 1 (char 0)\n\nSyntax Error while loading YAML.\n  ${(e as Error).message}\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
    return 4;
  }
  if (!Array.isArray(doc)) {
    io.err(`ERROR! A playbook must be a list of plays, got a ${typeof doc === 'object' ? 'dict' : 'string'} instead\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
    return 4;
  }
  const dir = abs(ctx, file).slice(0, abs(ctx, file).lastIndexOf('/')) || '/';
  // Parse every play first: errors stop the run before anything changes.
  interface Play {
    name: string;
    hosts: string;
    become: boolean;
    becomeUser: string;
    gather: boolean;
    vars: Vars;
    tasks: Task[];
    handlers: Task[];
  }
  const plays: Play[] = [];
  for (const p of doc as Array<Record<string, Yaml>>) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    if (p.import_playbook) continue;
    if (!p.hosts) {
      io.err(`ERROR! the field 'hosts' is required but was not set\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
      return 4;
    }
    const known = new Set(['name', 'hosts', 'become', 'become_user', 'become_method', 'gather_facts', 'vars', 'vars_files', 'tasks', 'handlers', 'pre_tasks', 'post_tasks', 'roles', 'remote_user', 'connection', 'serial', 'any_errors_fatal', 'environment', 'tags', 'strategy', 'max_fail_percentage']);
    const bad = Object.keys(p).find((k) => !known.has(k));
    if (bad) {
      io.err(`ERROR! '${bad}' is not a valid attribute for a Play\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
      return 4;
    }
    let vars: Vars = { ...((p.vars ?? {}) as Vars) };
    for (const vf of Array.isArray(p.vars_files) ? p.vars_files : p.vars_files ? [p.vars_files] : []) {
      const y = readYamlFile(ctx, str(vf).startsWith('/') ? str(vf) : `${dir}/${str(vf)}`);
      if (y === null) {
        io.err(`ERROR! vars file ${str(vf)} was not found\n`);
        return 1;
      }
      vars = { ...vars, ...(y as Vars) };
    }
    const tasks: Task[] = [];
    const handlers: Task[] = [];
    const addList = (list: Yaml | undefined, into: Task[], role?: string): boolean => {
      for (const t of Array.isArray(list) ? list : []) {
        const r = toTask(t as Record<string, Yaml>, role);
        if (typeof r === 'string') {
          io.err(`ERROR! ${r}\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
          return false;
        }
        into.push(r);
      }
      return true;
    };
    if (!addList(p.pre_tasks, tasks)) return 4;
    for (const r of Array.isArray(p.roles) ? p.roles : []) {
      const rname = typeof r === 'string' ? r : str((r as Record<string, Yaml>).role ?? (r as Record<string, Yaml>).name);
      const rdir = `${dir}/roles/${rname}`;
      if (!lookup(ctx.sys.fs, rdir, actor(ctx))) {
        io.err(`ERROR! the role '${rname}' was not found in ${dir}/roles:${dir}\n\nThe error appears to be in '${abs(ctx, file)}'\n`);
        return 1;
      }
      const defaults = readYamlFile(ctx, `${rdir}/defaults/main.yml`);
      if (defaults && typeof defaults === 'object') vars = { ...(defaults as Vars), ...vars };
      const rvars = readYamlFile(ctx, `${rdir}/vars/main.yml`);
      if (rvars && typeof rvars === 'object') vars = { ...vars, ...(rvars as Vars) };
      const rt = loadTasks(ctx, `${rdir}/tasks/main.yml`, rname, io);
      const rh = loadTasks(ctx, `${rdir}/handlers/main.yml`, rname, io);
      if (!rt || !rh) return 4;
      tasks.push(...rt);
      handlers.push(...rh);
    }
    if (!addList(p.tasks, tasks) || !addList(p.post_tasks, tasks) || !addList(p.handlers, handlers)) return 4;
    plays.push({ name: str(p.name ?? p.hosts), hosts: str(p.hosts), become: yes(p.become) || o.becomeAll, becomeUser: str(p.become_user ?? 'root'), gather: p.gather_facts === undefined || yes(p.gather_facts), vars, tasks, handlers });
  }
  if (mode === 'syntax') {
    io.out(`\nplaybook: ${file}\n`);
    return 0;
  }
  if (mode === 'list') {
    io.out(`\nplaybook: ${file}\n`);
    for (const p of plays) {
      io.out(`\n  play #${plays.indexOf(p) + 1} (${p.hosts}): ${p.name}\tTAGS: []\n    tasks:\n`);
      for (const t of p.tasks) io.out(`      ${t.role ? `${t.role} : ` : ''}${t.name || t.module}\tTAGS: [${asList(t.raw.tags ?? []).join(', ')}]\n`);
    }
    return 0;
  }
  const stats: Record<string, Stats> = {};
  const st = (h: string) => (stats[h] ??= { ok: 0, changed: 0, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 });
  const dead = new Set<string>();
  const say = (s: string) => io.out(s);
  for (const play of plays) {
    say(`\n${stars(`PLAY [${play.name}]`)}\n`);
    let hosts = selectHosts(inv, play.hosts);
    if (o.limit) hosts = hosts.filter((h) => selectHosts(inv, o.limit!).some((x) => x.name === h.name));
    if (!hosts.length) {
      say('skipping: no hosts matched\n');
      continue;
    }
    const conns = new Map<string, Conn>();
    const hostVars = new Map<string, Vars>();
    for (const h of hosts) {
      if (dead.has(h.name)) continue;
      const c = connect(ctx, h, play.become, play.becomeUser);
      if ('unreachable' in c) {
        if (play.gather) say(`\n${stars('TASK [Gathering Facts]')}\n`);
        say(`fatal: [${h.name}]: UNREACHABLE! => {"changed": false, "msg": ${JSON.stringify(c.unreachable)}, "unreachable": true}\n`);
        st(h.name).unreachable++;
        dead.add(h.name);
        continue;
      }
      if (play.become && currentUser(ctx) !== 'root' && !h.vars.ansible_connection?.toString().endsWith('docker') && !isSudoer(ctx.sys, currentUser(ctx))) {
        say(`fatal: [${h.name}]: FAILED! => {"msg": "Missing sudo password"}\n`);
        st(h.name).failed++;
        dead.add(h.name);
        continue;
      }
      conns.set(h.name, c);
      hostVars.set(h.name, { ...c.facts, ansible_facts: { ...c.facts }, ...h.vars, ...play.vars, ...o.extraVars, inventory_hostname: h.name, group_names: h.groups.filter((g) => g !== 'ungrouped'), ansible_check_mode: o.check, playbook_dir: dir, hostvars: {} });
    }
    if (play.gather && conns.size) {
      say(`\n${stars('TASK [Gathering Facts]')}\n`);
      for (const h of conns.keys()) {
        say(`ok: [${h}]\n`);
        st(h).ok++;
      }
    }
    const notified = new Map<string, Set<string>>();
    const header = (t: Task, kind: string, vars: Vars) => say(`\n${stars(`${kind} [${t.role ? `${t.role} : ` : ''}${templSafe(t.name || t.module, vars)}]`)}\n`);
    const selected = (t: Task) => {
      const tags = asList(t.raw.tags ?? []);
      if (o.tags.length && !tags.some((x) => o.tags.includes(x)) && !tags.includes('always')) return false;
      return !(o.skipTags.length && tags.some((x) => o.skipTags.includes(x)));
    };
    const runTask = (t: Task, hostName: string, extra: Vars = {}, kind?: string): 'ok' | 'failed' => {
      const conn = conns.get(hostName)!;
      const vars = { ...hostVars.get(hostName)!, ...((t.raw.vars ?? {}) as Vars), ...extra };
      if (!selected(t)) return 'ok';
      if (kind) header(t, kind, vars);
      const loopSrc = t.raw.loop ?? t.raw.with_items ?? t.raw.with_list;
      let items: V[] | null = null;
      if (loopSrc !== undefined) {
        try {
          const l = templ(loopSrc, vars);
          items = Array.isArray(l) ? l.flat() : [l];
        } catch (e) {
          say(`fatal: [${hostName}]: FAILED! => {"msg": ${JSON.stringify(`'${(e as Error).message}'`)}}\n`);
          st(hostName).failed++;
          return 'failed';
        }
      }
      const becomeTask = t.raw.become !== undefined ? yes(t.raw.become) : undefined;
      let taskConn = conn;
      if (becomeTask !== undefined) {
        const c2 = connect(ctx, inv[hostName] ?? { name: hostName, vars: { ansible_connection: 'local' }, groups: [] }, becomeTask, str(t.raw.become_user ?? 'root'));
        if (!('unreachable' in c2)) taskConn = c2;
      }
      const results: Result[] = [];
      let anyChanged = false;
      let failed = false;
      for (const item of items ?? [undefined]) {
        const iv = items ? { ...vars, item } : vars;
        if (t.raw.when !== undefined) {
          let pass = true;
          try {
            pass = asList(Array.isArray(t.raw.when) ? t.raw.when : [str(t.raw.when)]).every((w) => truthy(evalExpr(w.replace(/^\{\{\s*|\s*\}\}$/g, ''), iv)));
          } catch (e) {
            say(`fatal: [${hostName}]: FAILED! => {"msg": ${JSON.stringify(`The conditional check '${str(t.raw.when)}' failed. The error was: error while evaluating conditional (${str(t.raw.when)}): ${(e as Error).message}`)}}\n`);
            st(hostName).failed++;
            return 'failed';
          }
          if (!pass) {
            say(`skipping: [${hostName}]${items ? ` => (item=${str(item)})` : ''}\n`);
            if (!items) {
              st(hostName).skipped++;
              if (t.raw.register) hostVars.get(hostName)![str(t.raw.register)] = { changed: false, skipped: true, skip_reason: 'Conditional result was False' };
              return 'ok';
            }
            continue;
          }
        }
        let args: Vars;
        try {
          args = templ(t.args, iv) as Vars;
        } catch (e) {
          say(`fatal: [${hostName}]: FAILED! => {"msg": ${JSON.stringify(`The task includes an option with an undefined variable. The error was: ${(e as Error).message}`)}}\n`);
          st(hostName).failed++;
          return 'failed';
        }
        if (t.module === 'meta' || t.module === 'pause') continue;
        if (t.module === 'include_tasks' || t.module === 'import_tasks') {
          const f = str(args._raw_params ?? args.file);
          const inc = loadTasks(ctx, f.startsWith('/') ? f : `${dir}/${f}`, t.role, io);
          if (!inc) return 'failed';
          for (const it of inc) if (runTask(it, hostName, items ? { item } : {}, 'TASK') === 'failed') return 'failed';
          continue;
        }
        const env: RunEnv = { conn: taskConn, check: o.check || t.raw.check_mode === 'true', dir, role: t.role };
        let r: Result;
        try {
          r = MODULES[t.module](args, env, inv[hostName] ?? { name: hostName, vars: {}, groups: [] }, ctx, iv);
        } catch (e) {
          r = { failed: true, msg: (e as Error).message };
        }
        if (t.raw.changed_when !== undefined) {
          try {
            r.changed = truthy(evalExpr(str(t.raw.changed_when), { ...iv, ...r, [str(t.raw.register ?? '_r')]: r }));
          } catch {
            /* leave as reported */
          }
        }
        if (t.raw.failed_when !== undefined) {
          try {
            r.failed = truthy(evalExpr(str(t.raw.failed_when), { ...iv, ...r, [str(t.raw.register ?? '_r')]: r }));
          } catch {
            /* leave as reported */
          }
        }
        taskConn.done();
        if (r.ansible_facts && typeof r.ansible_facts === 'object') Object.assign(hostVars.get(hostName)!, r.ansible_facts);
        results.push(items ? { ...r, item } : r);
        const label = items ? ` => (item=${typeof item === 'object' ? JSON.stringify(item) : str(item)})` : '';
        if (r.failed) {
          failed = true;
          const shown: Result = { ...r };
          delete shown.diff;
          say(`${t.raw.ignore_errors && yes(t.raw.ignore_errors) ? '' : ''}${items ? `failed: [${hostName}]${label} => ` : `fatal: [${hostName}]: FAILED! => `}${JSON.stringify({ changed: !!r.changed, ...shown, failed: undefined })}\n`.replace(/,"failed":undefined|"failed":undefined,?/, ''));
          if (!items) break;
          continue;
        }
        if (o.diff && r.diff) say(diffText(r.diff));
        if (r.changed) anyChanged = true;
        if (t.module === 'debug') {
          const shown = Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'changed'));
          say(`ok: [${hostName}]${label} => ${JSON.stringify(shown, null, 4).replace(/\n/g, '\n')}\n`);
        } else if (o.verbose && (t.module === 'command' || t.module === 'shell')) say(`${r.changed ? 'changed' : 'ok'}: [${hostName}]${label} => ${JSON.stringify({ changed: r.changed, cmd: r.cmd, rc: r.rc, stdout: r.stdout, stderr: r.stderr })}\n`);
        else if (r.skipped) say(`skipping: [${hostName}]${label}\n`);
        else say(`${r.changed ? 'changed' : 'ok'}: [${hostName}]${label}\n`);
      }
      const reg = t.raw.register ? str(t.raw.register) : undefined;
      const summary: Result = items ? { changed: anyChanged, failed, results } : results[0] ?? { changed: false };
      if (reg) hostVars.get(hostName)![reg] = summary;
      if (failed) {
        if (yes(t.raw.ignore_errors)) {
          say('...ignoring\n');
          st(hostName).ignored++;
          return 'ok';
        }
        st(hostName).failed++;
        return 'failed';
      }
      if (summary.skipped && !anyChanged) st(hostName).skipped++;
      else {
        st(hostName).ok++;
        if (anyChanged) st(hostName).changed++;
      }
      if (anyChanged && t.raw.notify) for (const n of asList(t.raw.notify)) (notified.get(hostName) ?? notified.set(hostName, new Set()).get(hostName)!).add(n);
      return 'ok';
    };
    for (const t of play.tasks) {
      const live = [...conns.keys()].filter((h) => !dead.has(h));
      if (!live.length) break;
      if (!selected(t)) continue;
      // include_tasks prints its own tasks' headers.
      if (t.module !== 'include_tasks' && t.module !== 'import_tasks') header(t, 'TASK', hostVars.get(live[0])!);
      for (const h of live) if (runTask(t, h) === 'failed') dead.add(h);
    }
    // Handlers run once, at the end of the play, on the hosts that notified them.
    for (const hd of play.handlers) {
      const hostsFor = [...conns.keys()].filter((h) => !dead.has(h) && (notified.get(h)?.has(hd.name) || (hd.raw.listen !== undefined && asList(hd.raw.listen).some((l) => notified.get(h)?.has(l)))));
      if (!hostsFor.length) continue;
      header(hd, 'RUNNING HANDLER', hostVars.get(hostsFor[0])!);
      for (const h of hostsFor) if (runTask(hd, h) === 'failed') dead.add(h);
    }
  }
  say(`\n${stars('PLAY RECAP')}\n`);
  for (const [h, s] of Object.entries(stats)) say(`${h.padEnd(26)} : ok=${String(s.ok).padEnd(4)} changed=${String(s.changed).padEnd(4)} unreachable=${String(s.unreachable).padEnd(4)} failed=${String(s.failed).padEnd(4)} skipped=${String(s.skipped).padEnd(4)} rescued=${String(s.rescued).padEnd(4)} ignored=${String(s.ignored).padEnd(4)}\n`);
  say('\n');
  const failedAny = Object.values(stats).some((s) => s.failed);
  const unreachAny = Object.values(stats).some((s) => s.unreachable);
  return failedAny ? 2 : unreachAny ? 4 : 0;
}

function templSafe(s: string, vars: Vars): string {
  try {
    return str(templ(s, vars));
  } catch {
    return s;
  }
}

/* ----------------------------------------------------------------------------- the commands */

function commonOpts(args: string[]): { o: PlayOpts; inventory?: string; rest: string[]; module?: string; moduleArgs?: string; flags: Set<string> } {
  const o: PlayOpts = { check: false, diff: false, tags: [], skipTags: [], extraVars: {}, verbose: 0, becomeAll: false };
  let inventory: string | undefined;
  let module: string | undefined;
  let moduleArgs: string | undefined;
  const rest: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = () => (a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : args[++i] ?? '');
    if (a === '-i' || a.startsWith('--inventory')) inventory = val();
    else if (a === '-C' || a === '--check') o.check = true;
    else if (a === '-D' || a === '--diff') o.diff = true;
    else if (a === '-t' || a.startsWith('--tags')) o.tags.push(...val().split(','));
    else if (a.startsWith('--skip-tags')) o.skipTags.push(...val().split(','));
    else if (a === '-e' || a.startsWith('--extra-vars')) {
      const v = val();
      if (v.trim().startsWith('{')) {
        try {
          Object.assign(o.extraVars, JSON.parse(v));
        } catch {
          /* ignored */
        }
      } else Object.assign(o.extraVars, kvArgs(v));
      delete o.extraVars._raw_params;
    } else if (a === '-l' || a.startsWith('--limit')) o.limit = val();
    else if (a === '-b' || a === '--become') o.becomeAll = true;
    else if (a === '-K' || a === '--ask-become-pass') flags.add('K');
    else if (/^-v+$/.test(a)) o.verbose = a.length - 1;
    else if (a === '-m' || a === '--module-name') module = val();
    else if (a === '-a' || a === '--args') moduleArgs = val();
    else if (a === '-c' || a.startsWith('--connection')) flags.add('conn:' + val());
    else if (a.startsWith('--')) flags.add(a.slice(2));
    else rest.push(a);
  }
  return { o, inventory, rest, module, moduleArgs, flags };
}

const ansiblePlaybook: Cmd = (args, io, ctx) => {
  if (args.includes('--version')) {
    io.out('ansible-playbook [core 2.17.5]\n  python version = 3.11.10\n  jinja version = 3.1.4\n');
    return 0;
  }
  const c = commonOpts(args);
  if (!c.rest.length) {
    io.err('usage: ansible-playbook [-h] [--version] [-v] [-k] [-u REMOTE_USER] [-c CONNECTION] [-i INVENTORY] [-C] [-D] [-e EXTRA_VARS] [-t TAGS] [-l SUBSET] playbook [playbook ...]\nansible-playbook: error: the following arguments are required: playbook\n');
    return 2;
  }
  const first = abs(ctx, c.rest[0]);
  const inv = loadInventory(ctx, c.inventory, io, first.slice(0, first.lastIndexOf('/')) || '/');
  if (!inv) return 1;
  const conn = [...c.flags].find((f) => f.startsWith('conn:'))?.slice(5);
  if (conn) for (const h of Object.values(inv)) h.vars.ansible_connection ??= conn;
  const mode = c.flags.has('syntax-check') ? 'syntax' : c.flags.has('list-tasks') || c.flags.has('list-hosts') ? 'list' : 'run';
  let code = 0;
  for (const pb of c.rest) {
    code = playbook(ctx, pb, inv, c.o, io, mode);
    if (code) break;
  }
  return code;
};

const ansible: Cmd = (args, io, ctx) => {
  if (args.includes('--version')) {
    io.out('ansible [core 2.17.5]\n  config file = None\n  python version = 3.11.10\n  jinja version = 3.1.4\n');
    return 0;
  }
  const c = commonOpts(args);
  const pattern = c.rest[0];
  if (!pattern) {
    io.err('usage: ansible [-h] [--version] [-v] [-b] [-i INVENTORY] [-m MODULE_NAME] [-a MODULE_ARGS] pattern\nansible: error: the following arguments are required: pattern\n');
    return 2;
  }
  const inv = loadInventory(ctx, c.inventory, io, ctx.sys.cwd);
  if (!inv) return 1;
  const conn = [...c.flags].find((f) => f.startsWith('conn:'))?.slice(5);
  if (conn) for (const h of Object.values(inv)) h.vars.ansible_connection ??= conn;
  const hosts = selectHosts(inv, pattern);
  if (c.flags.has('list-hosts')) {
    io.out(`  hosts (${hosts.length}):\n${hosts.map((h) => `    ${h.name}\n`).join('')}`);
    return 0;
  }
  if (!hosts.length) {
    io.err(`[WARNING]: Could not match supplied host pattern, ignoring: ${pattern}\n[WARNING]: No hosts matched, nothing to do\n`);
    return 0;
  }
  const mod = (c.module ?? 'command').replace(PREFIX, '');
  if (!MODULES[mod]) {
    io.err(`ERROR! couldn't resolve module/action '${c.module}'. This often indicates a misspelling, missing collection, or incorrect module path.\n`);
    return 1;
  }
  let code = 0;
  for (const h of hosts) {
    const cn = connect(ctx, h, c.o.becomeAll, 'root');
    if ('unreachable' in cn) {
      io.out(`${h.name} | UNREACHABLE! => {\n    "changed": false,\n    "msg": ${JSON.stringify(cn.unreachable)},\n    "unreachable": true\n}\n`);
      code = 4;
      continue;
    }
    const a = mod === 'command' || mod === 'shell' ? { _raw_params: c.moduleArgs ?? '' } : kvArgs(c.moduleArgs ?? '');
    const r = MODULES[mod](a, { conn: cn, check: c.o.check, dir: ctx.sys.cwd }, h, ctx, { ...cn.facts, ...h.vars });
    cn.done();
    if (mod === 'command' || mod === 'shell') {
      io.out(`${h.name} | ${r.failed ? 'FAILED' : r.changed ? 'CHANGED' : 'SUCCESS'} | rc=${r.rc ?? 0} >>\n${r.stdout ?? ''}${r.stderr ? `${r.stdout ? '\n' : ''}${r.stderr}` : ''}\n`);
    } else {
      const shown = { ...r };
      delete shown.diff;
      io.out(`${h.name} | ${r.failed ? 'FAILED!' : r.changed ? 'CHANGED' : 'SUCCESS'} => ${JSON.stringify(shown, null, 4)}\n`);
    }
    if (r.failed) code = 2;
  }
  return code;
};

const ansibleInventory: Cmd = (args, io, ctx) => {
  const c = commonOpts(args);
  const inv = loadInventory(ctx, c.inventory, io, ctx.sys.cwd);
  if (!inv) return 1;
  if (c.flags.has('graph')) {
    const groups = new Map<string, string[]>();
    for (const h of Object.values(inv)) for (const g of h.groups) (groups.get(g) ?? groups.set(g, []).get(g)!).push(h.name);
    io.out('@all:\n' + [...groups].map(([g, hs]) => `  |--@${g}:\n${hs.map((h) => `  |  |--${h}\n`).join('')}`).join(''));
    return 0;
  }
  const out: Record<string, V> = { _meta: { hostvars: Object.fromEntries(Object.values(inv).map((h) => [h.name, h.vars])) }, all: { children: ['ungrouped', ...new Set(Object.values(inv).flatMap((h) => h.groups).filter((g) => g !== 'ungrouped'))] } };
  for (const h of Object.values(inv)) for (const g of h.groups) ((out[g] ??= { hosts: [] }) as { hosts: string[] }).hosts.push(h.name);
  io.out(JSON.stringify(out, null, 4) + '\n');
  return 0;
};

export const ANSIBLE_COMMANDS: Record<string, Cmd> = { 'ansible-playbook': ansiblePlaybook, ansible, 'ansible-inventory': ansibleInventory };
export { parseInventory };

