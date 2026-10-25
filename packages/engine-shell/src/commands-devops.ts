/**
 * Build and pipeline tools: `act` (runs .github/workflows locally, like nektos/act) and `make`
 * (a GNU make subset: variables, automatic variables, functions, pattern rules, .PHONY, and the
 * real error messages, including "missing separator" for a recipe indented with spaces).
 */

import { lookup, readFile, writeFile, mkdir, type DirNode } from './fs.js';
import { actor, runCommand, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { homeOf } from './system.js';
import { currentUser } from './shell.js';
import { findRepo, headCommit, loadGit, ROOT } from './git-core.js';
import { readWorkflows, runWorkflow, triggers, type CiInput, type CiRun } from './ci.js';
import { yList, yMap, yStr } from './yaml.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/* ----------------------------------------------------------------------------- act */

function filesUnder(ctx: Ctx, dir: string): { files: Record<string, string>; exec: string[] } {
  const files: Record<string, string> = {};
  const exec: string[] = [];
  const l = lookup(ctx.sys.fs, dir, actor(ctx));
  if (!l || l.node.type !== 'dir') return { files, exec };
  const walk = (node: DirNode, rel: string) => {
    for (const [n, c] of Object.entries(node.children)) {
      if (!rel && n === '.git') continue;
      const p = rel ? `${rel}/${n}` : n;
      if (c.type === 'dir') walk(c, p);
      else if (c.type === 'file') {
        files[p] = c.content;
        if (c.mode & 0o100) exec.push(p);
      }
    }
  };
  walk(l.node, '');
  return { files, exec };
}

function parseKv(list: string[], ctx: Ctx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kv of list) {
    const eq = kv.indexOf('=');
    if (eq === -1) out[kv] = ctx.vars[kv] ?? ctx.sys.env[kv] ?? '';
    else out[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return out;
}

function readEnvFile(ctx: Ctx, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFile(ctx.sys.fs, path, actor(ctx)).split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    /* none */
  }
  return out;
}

const act: Cmd = (args, io, ctx) => {
  const vals = (flag: string, short?: string) => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag || (short && args[i] === short)) out.push(args[++i] ?? '');
      else if (args[i].startsWith(flag + '=')) out.push(args[i].slice(flag.length + 1));
    }
    return out;
  };
  const has = (...f: string[]) => args.some((a) => f.includes(a));
  if (has('--version')) {
    io.out('act version 0.2.69\n');
    return 0;
  }
  if (has('-h', '--help')) {
    io.out('Run GitHub actions locally by specifying the event name (e.g. `push`) or an action name directly.\n\nUsage:\n  act [event name to run] [flags]\n\nFlags:\n  -j, --job string             run a specific job ID\n  -l, --list                   list workflows\n  -n, --dryrun                 validate without running containers\n  -s, --secret stringArray     secret to make available to actions with optional value (e.g. -s mysecret=foo or -s mysecret)\n      --secret-file string     file with list of secrets to read from (default ".secrets")\n      --var stringArray        variable to make available to actions\n      --input stringArray      action input to make available to actions (e.g. --input myinput=foo)\n  -W, --workflows string       path to workflow file(s) (default "./.github/workflows/")\n      --matrix map             specify which matrix configuration to include (e.g. --matrix java:13)\n      --artifact-server-path string   Defines the path where the artifact server stores uploads and retrieves downloads from.\n');
    return 0;
  }
  const docker = ctx.sys.services.docker;
  if (!ctx.sys.packages.docker?.installed || (docker && !docker.active)) {
    io.err('Error: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n');
    return 1;
  }
  const repoDir = findRepo(ctx) ?? ctx.sys.cwd;
  const { files, exec } = filesUnder(ctx, repoDir);
  const wfArg = vals('--workflows', '-W')[0];
  let wfs = readWorkflows(files);
  if (wfArg) {
    const target = abs(ctx, wfArg);
    const rel = target.startsWith(repoDir + '/') ? target.slice(repoDir.length + 1) : target;
    wfs = wfs.filter((w) => w.path === rel || w.path.startsWith(rel.replace(/\/$/, '') + '/'));
  }
  if (!wfs.length) {
    io.err(`Error: workflow is not valid. 'open ${repoDir}/.github/workflows: no such file or directory'\n`);
    return 1;
  }
  const event = args.find((a, i) => !a.startsWith('-') && !['-j', '--job', '-s', '--secret', '--secret-file', '--var', '--input', '-W', '--workflows', '--matrix', '-P', '--platform', '--artifact-server-path', '-e', '--eventpath', '--env-file', '--container-architecture'].includes(args[i - 1] ?? '')) ?? 'push';
  const onlyJob = vals('--job', '-j')[0];
  if (has('-l', '--list')) {
    const rows: string[][] = [['Stage', 'Job ID', 'Job name', 'Workflow name', 'Workflow file', 'Events']];
    for (const w of wfs) {
      if (w.error) continue;
      const jobs = yMap(w.doc.jobs);
      const stage: Record<string, number> = {};
      const depth = (k: string): number => (stage[k] ??= Math.max(-1, ...yList(yMap(jobs[k]).needs).map((n) => depth(yStr(n)))) + 1);
      const on = w.doc.on ?? w.doc.true;
      const events = typeof on === 'string' ? on : Array.isArray(on) ? on.map(yStr).join(',') : Object.keys(yMap(on)).join(',');
      for (const k of Object.keys(jobs)) rows.push([String(depth(k)), k, yStr(yMap(jobs[k]).name) || k, w.name, w.path.split('/').pop()!, events]);
    }
    const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
    for (const r of rows) io.out(r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd() + '\n');
    return 0;
  }
  const secretFile = vals('--secret-file')[0] ?? '.secrets';
  const secrets = { ...readEnvFile(ctx, abs(ctx, `${repoDir}/${secretFile}`)), ...parseKv(vals('--secret', '-s'), ctx) };
  const vars = parseKv(vals('--var'), ctx);
  const inputs = parseKv(vals('--input'), ctx);
  const matrixFilter: Record<string, string> = {};
  for (const m of vals('--matrix')) {
    const [k, v] = m.split(':');
    matrixFilter[k] = v;
  }
  let st = null as ReturnType<typeof loadGit> | null;
  let sha = '0'.repeat(40);
  let ref = 'refs/heads/main';
  if (findRepo(ctx)) {
    st = loadGit(ctx, repoDir);
    sha = headCommit(st) ?? sha;
    if (st.head.branch) ref = `refs/heads/${st.head.branch}`;
  } else io.err(`WARN  ⚠ unable to get git repo (Unable to find git repo in ${repoDir}) ⚠\n`);
  const cacheFile = `${homeOf(ctx.sys, currentUser(ctx))}/.cache/act/cache.json`;
  let cache: Record<string, Record<string, string>> = {};
  try {
    cache = JSON.parse(readFile(ctx.sys.fs, cacheFile, actor(ctx)));
  } catch {
    /* empty cache */
  }
  const artifactPath = vals('--artifact-server-path')[0];
  let failed = false;
  let ran = 0;
  for (const wf of wfs) {
    if (wf.error) {
      io.err(`Error: workflow is not valid. '${wf.path}': ${wf.error}\n`);
      failed = true;
      continue;
    }
    if (!triggers(wf.doc, event, ref) && !(event === 'push' && !wfArg && false)) continue;
    const jobs = yMap(wf.doc.jobs);
    if (onlyJob && !jobs[onlyJob]) continue;
    ran++;
    if (has('-n', '--dryrun')) {
      for (const k of Object.keys(jobs)) if (!onlyJob || k === onlyJob) io.out(`*DRYRUN* [${wf.name}/${yStr(yMap(jobs[k]).name) || k}] 🏁  Job succeeded\n`);
      continue;
    }
    const input: CiInput = {
      ctx,
      repo: `local/${repoDir.split('/').pop()}`,
      files,
      exec,
      history: st ? { ...st, commits: st.commits } : undefined,
      event,
      ref,
      sha,
      actor: 'nektos/act',
      secrets: { ...secrets, GITHUB_TOKEN: secrets.GITHUB_TOKEN ?? '' },
      vars,
      inputs,
      cache,
      environments: {},
      live: (job, text) => io.out(`[${wf.name}/${job}] ${text}\n`),
      onlyJob,
      matrixFilter: Object.keys(matrixFilter).length ? matrixFilter : undefined,
      serverUrl: 'https://github.com',
      runId: 1,
      runNumber: 1,
    };
    // Without an artifact server, upload-artifact fails exactly as it does under act.
    if (!artifactPath && Object.values(jobs).some((j) => yList(yMap(j).steps).some((s) => /^actions\/(upload|download)-artifact/.test(yStr(yMap(s).uses))))) io.err('WARN  ⚠ You are using upload/download-artifact without --artifact-server-path: those steps will fail ⚠\n');
    const run: CiRun = runWorkflow(input, wf);
    if (artifactPath) {
      for (const a of run.artifacts) {
        for (const [p, c] of Object.entries(a.files)) {
          const full = `${abs(ctx, artifactPath)}/1/${a.name}/${p}`;
          mkdir(ctx.sys.fs, full.slice(0, full.lastIndexOf('/')), actor(ctx), ctx.sys.now, true);
          writeFile(ctx.sys.fs, full, c, actor(ctx), ctx.sys.now);
        }
      }
    }
    for (const j of run.jobs) if (j.conclusion === 'failure') {
      io.err(`Error: Job '${j.name}' failed\n`);
      failed = true;
    }
    if (run.status === 'waiting') io.out(`[${wf.name}] environment approvals are not simulated by act; the job was skipped\n`);
  }
  try {
    mkdir(ctx.sys.fs, cacheFile.slice(0, cacheFile.lastIndexOf('/')), actor(ctx), ctx.sys.now, true);
    writeFile(ctx.sys.fs, cacheFile, JSON.stringify(cache), actor(ctx), ctx.sys.now);
  } catch {
    /* cache is best effort */
  }
  if (!ran && !failed) {
    io.err(`Error: Could not find any stages to run. View the valid jobs with \`act --list\`. Use \`act --help\` to find how to filter by Job ID/Workflow/Event Name\n`);
    return 1;
  }
  return failed ? 1 : 0;
};

/* ----------------------------------------------------------------------------- make */

interface Rule {
  targets: string[];
  deps: string[];
  orderOnly: string[];
  recipe: Array<{ text: string; line: number }>;
  line: number;
  pattern: boolean;
}

interface Makefile {
  vars: Record<string, { value: string; recursive: boolean }>;
  rules: Rule[];
  phony: Set<string>;
  oneshell: boolean;
  file: string;
  defaultGoal?: string;
}

class MakeError extends Error {
  constructor(
    public text: string,
    public code = 2,
  ) {
    super(text);
  }
}

function makeExpand(mk: Makefile, s: string, ctx: Ctx, auto: Record<string, string> = {}, depth = 0): string {
  if (depth > 20) throw new MakeError(`make: *** Recursive variable references itself (eventually).  Stop.`);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '$') {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === '$') {
      out += '$';
      i++;
      continue;
    }
    if (n === '(' || n === '{') {
      const close = n === '(' ? ')' : '}';
      let d = 1;
      let j = i + 2;
      while (j < s.length && d) {
        if (s[j] === n) d++;
        else if (s[j] === close) d--;
        if (d) j++;
      }
      const inner = s.slice(i + 2, j);
      out += makeRef(mk, inner, ctx, auto, depth);
      i = j;
      continue;
    }
    if (n && '@<^*?+|'.includes(n)) {
      out += auto[n] ?? '';
      i++;
      continue;
    }
    if (n) {
      out += makeRef(mk, n, ctx, auto, depth);
      i++;
    }
  }
  return out;
}

function makeRef(mk: Makefile, inner: string, ctx: Ctx, auto: Record<string, string>, depth: number): string {
  const fn = /^(\w[\w-]*)\s+([\s\S]*)$/.exec(inner);
  const args = (raw: string) => {
    const out: string[] = [];
    let d = 0;
    let cur = '';
    for (const ch of raw) {
      if (ch === '(' || ch === '{') d++;
      if (ch === ')' || ch === '}') d--;
      if (ch === ',' && d === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const x = (t: string) => makeExpand(mk, t, ctx, auto, depth + 1);
  const words = (t: string) => x(t).split(/\s+/).filter(Boolean);
  if (fn) {
    const a = args(fn[2]);
    switch (fn[1]) {
      case 'shell': {
        const buf: string[] = [];
        runCommand(ctx, ['bash', '-c', x(fn[2])], { stdin: '', out: (t) => buf.push(t), err: () => {} });
        return buf.join('').replace(/\n+$/, '').replace(/\n/g, ' ');
      }
      case 'wildcard': {
        const out: string[] = [];
        for (const pat of words(fn[2])) {
          const dir = pat.includes('/') ? pat.slice(0, pat.lastIndexOf('/')) : '.';
          const base = pat.slice(pat.lastIndexOf('/') + 1);
          const re = new RegExp('^' + base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          const l = lookup(ctx.sys.fs, abs(ctx, dir), actor(ctx));
          if (l?.node.type === 'dir') for (const name of Object.keys(l.node.children).sort()) if (re.test(name) && !name.startsWith('.')) out.push(dir === '.' ? name : `${dir}/${name}`);
        }
        return out.join(' ');
      }
      case 'patsubst': {
        const [from, to, list] = a.map(x);
        const [pre, post] = from.trim().split('%');
        return list.split(/\s+/).filter(Boolean).map((w) => (from.includes('%') ? (w.startsWith(pre) && w.endsWith(post ?? '') ? to.trim().replace('%', w.slice(pre.length, w.length - (post ?? '').length)) : w) : w === from.trim() ? to.trim() : w)).join(' ');
      }
      case 'subst': {
        const [from, to, text] = a.map(x);
        return text.split(from).join(to);
      }
      case 'strip':
        return words(fn[2]).join(' ');
      case 'sort':
        return [...new Set(words(fn[2]))].sort().join(' ');
      case 'notdir':
        return words(fn[2]).map((w) => w.slice(w.lastIndexOf('/') + 1)).join(' ');
      case 'dir':
        return words(fn[2]).map((w) => (w.includes('/') ? w.slice(0, w.lastIndexOf('/') + 1) : './')).join(' ');
      case 'basename':
        return words(fn[2]).map((w) => w.replace(/\.[^./]*$/, '')).join(' ');
      case 'suffix':
        return words(fn[2]).map((w) => /\.[^./]*$/.exec(w)?.[0] ?? '').filter(Boolean).join(' ');
      case 'addprefix':
        return x(a[1]).split(/\s+/).filter(Boolean).map((w) => x(a[0]).trim() + w).join(' ');
      case 'addsuffix':
        return x(a[1]).split(/\s+/).filter(Boolean).map((w) => w + x(a[0]).trim()).join(' ');
      case 'filter':
      case 'filter-out': {
        const pats = x(a[0]).split(/\s+/).filter(Boolean).map((p) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace('%', '.*') + '$'));
        return x(a[1]).split(/\s+/).filter(Boolean).filter((w) => pats.some((re) => re.test(w)) === (fn[1] === 'filter')).join(' ');
      }
      case 'words':
        return String(words(fn[2]).length);
      case 'word':
        return x(a[1]).split(/\s+/).filter(Boolean)[Number(x(a[0])) - 1] ?? '';
      case 'firstword':
        return words(fn[2])[0] ?? '';
      case 'lastword':
        return words(fn[2]).pop() ?? '';
      case 'if':
        return x(a[0]).trim() ? x(a[1] ?? '') : x(a[2] ?? '');
      case 'foreach': {
        const v = x(a[0]).trim();
        return x(a[1]).split(/\s+/).filter(Boolean).map((w) => makeExpand({ ...mk, vars: { ...mk.vars, [v]: { value: w, recursive: false } } }, a[2], ctx, auto, depth + 1)).join(' ');
      }
      case 'info':
        ctx.requests;
        return '';
      case 'error':
        throw new MakeError(`${mk.file}: *** ${x(fn[2])}.  Stop.`);
      case 'warning':
        return '';
    }
  }
  const sub = /^([\w.-]+):([^=]*)=(.*)$/.exec(inner);
  if (sub) {
    const v = makeRef(mk, sub[1], ctx, auto, depth);
    const [from, to] = [sub[2], sub[3]];
    return v.split(/\s+/).filter(Boolean).map((w) => (from.includes('%') ? w.replace(new RegExp('^' + from.replace('%', '(.*)') + '$'), to.replace('%', '$1')) : w.endsWith(from) ? w.slice(0, w.length - from.length) + to : w)).join(' ');
  }
  if (inner === '@' || inner === '<' || inner === '^' || inner === '*') return auto[inner] ?? '';
  if (inner === '@D') return (auto['@'] ?? '').includes('/') ? auto['@'].slice(0, auto['@'].lastIndexOf('/')) : '.';
  if (inner === '@F') return (auto['@'] ?? '').split('/').pop() ?? '';
  const v = mk.vars[inner];
  if (v) return v.recursive ? makeExpand(mk, v.value, ctx, auto, depth + 1) : v.value;
  return ctx.vars[inner] ?? ctx.sys.env[inner] ?? '';
}

function parseMakefile(text: string, file: string, ctx: Ctx, cmdVars: Record<string, string>): Makefile {
  const mk: Makefile = { vars: {}, rules: [], phony: new Set(), oneshell: false, file };
  const raw = text.replace(/\\\n[ \t]*/g, ' ').split('\n');
  let current: Rule | null = null;
  const cond: boolean[] = [];
  raw.forEach((line0, idx) => {
    const n = idx + 1;
    const line = line0.replace(/\r$/, '');
    const active = cond.every(Boolean);
    const ifm = /^\s*(ifeq|ifneq|ifdef|ifndef)\s+(.*)$/.exec(line);
    if (ifm) {
      let ok = false;
      if (ifm[1] === 'ifdef' || ifm[1] === 'ifndef') ok = (makeRef(mk, ifm[2].trim(), ctx, {}, 0) !== '') === (ifm[1] === 'ifdef');
      else {
        const m = /^\(\s*(.*?)\s*,\s*(.*?)\s*\)$/.exec(ifm[2].trim()) ?? /^["'](.*)["']\s+["'](.*)["']$/.exec(ifm[2].trim());
        const [a, b] = m ? [makeExpand(mk, m[1], ctx), makeExpand(mk, m[2], ctx)] : ['', ''];
        ok = (a === b) === (ifm[1] === 'ifeq');
      }
      cond.push(ok);
      return;
    }
    if (/^\s*else\s*$/.test(line)) {
      cond[cond.length - 1] = !cond[cond.length - 1];
      return;
    }
    if (/^\s*endif\s*$/.test(line)) {
      cond.pop();
      return;
    }
    if (!active) return;
    if (line.startsWith('\t')) {
      if (!current) throw new MakeError(`${file}:${n}: *** recipe commences before first target.  Stop.`);
      current.recipe.push({ text: line.slice(1), line: n });
      return;
    }
    const t = line.replace(/(^|[^\\])#.*$/, '$1').trimEnd();
    if (!t.trim()) return;
    const assign = /^\s*(?:export\s+)?([\w.-]+)\s*(:{1,2}=|\?=|\+=|=)\s*(.*)$/.exec(t);
    if (assign && !/^[^=]*:[^=]/.test(t.replace(/:{1,2}=/, ''))) {
      const [, name, op, value] = assign;
      if (cmdVars[name] !== undefined) return;
      if (op === '?=') {
        if (mk.vars[name] || ctx.vars[name] !== undefined || ctx.sys.env[name] !== undefined) return;
        mk.vars[name] = { value, recursive: true };
      } else if (op === '+=') {
        const old = mk.vars[name];
        mk.vars[name] = { value: (old ? (old.recursive ? old.value : old.value) + ' ' : '') + (old && !old.recursive ? makeExpand(mk, value, ctx) : value), recursive: old?.recursive ?? true };
      } else if (op === ':=' || op === '::=') mk.vars[name] = { value: makeExpand(mk, value, ctx), recursive: false };
      else mk.vars[name] = { value, recursive: true };
      current = null;
      return;
    }
    if (/^\s*(-?include)\s/.test(t)) return;
    if (/^\s*export\s*$/.test(t)) return;
    const rm = /^([^:]+?)\s*(::?)\s*(.*)$/.exec(t);
    if (!rm) {
      if (/^ {8}\S/.test(line0)) throw new MakeError(`${file}:${n}: *** missing separator (did you mean TAB instead of 8 spaces?).  Stop.`);
      throw new MakeError(`${file}:${n}: *** missing separator.  Stop.`);
    }
    const targets = makeExpand(mk, rm[1], ctx).split(/\s+/).filter(Boolean);
    let rest = rm[3];
    let inline: string | null = null;
    const semi = rest.indexOf(';');
    if (semi !== -1) {
      inline = rest.slice(semi + 1).trim();
      rest = rest.slice(0, semi);
    }
    const [normal, order = ''] = rest.split('|');
    const deps = makeExpand(mk, normal, ctx).split(/\s+/).filter(Boolean);
    const orderOnly = makeExpand(mk, order, ctx).split(/\s+/).filter(Boolean);
    if (targets.includes('.PHONY')) {
      for (const d of deps) mk.phony.add(d);
      current = null;
      return;
    }
    if (targets.includes('.ONESHELL')) {
      mk.oneshell = true;
      return;
    }
    if (targets.includes('.DEFAULT_GOAL')) return;
    if (targets.every((x) => x.startsWith('.') && /^\.[A-Z_]+$/.test(x))) {
      current = null;
      return;
    }
    current = { targets, deps, orderOnly, recipe: inline ? [{ text: inline, line: n }] : [], line: n, pattern: targets.some((x) => x.includes('%')) };
    mk.rules.push(current);
    if (!mk.defaultGoal && !current.pattern && !targets[0].startsWith('.')) mk.defaultGoal = targets[0];
  });
  for (const [k, v] of Object.entries(cmdVars)) mk.vars[k] = { value: v, recursive: false };
  if (mk.vars['.DEFAULT_GOAL']) mk.defaultGoal = mk.vars['.DEFAULT_GOAL'].value.trim();
  return mk;
}

const make: Cmd = (args, io, ctx) => {
  let dir = ctx.sys.cwd;
  let file: string | undefined;
  const goals: string[] = [];
  const cmdVars: Record<string, string> = {};
  let dry = false;
  let silent = false;
  let keepGoing = false;
  let always = false;
  let question = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '--directory') dir = abs(ctx, args[++i]);
    else if (a.startsWith('-C') && a.length > 2) dir = abs(ctx, a.slice(2));
    else if (a === '-f' || a === '--file' || a === '--makefile') file = args[++i];
    else if (a === '-n' || a === '--dry-run' || a === '--just-print') dry = true;
    else if (a === '-s' || a === '--silent' || a === '--quiet') silent = true;
    else if (a === '-k' || a === '--keep-going') keepGoing = true;
    else if (a === '-B' || a === '--always-make') always = true;
    else if (a === '-q' || a === '--question') question = true;
    else if (a === '-j' || a === '--jobs') {
      if (/^\d+$/.test(args[i + 1] ?? '')) i++;
    } else if (/^-j\d*$/.test(a) || a === '--no-print-directory' || a === '-w' || a === '-e') continue;
    else if (a === '--version' || a === '-v') {
      io.out('GNU Make 4.4.1\nBuilt for x86_64-pc-linux-gnu\nCopyright (C) 1988-2023 Free Software Foundation, Inc.\n');
      return 0;
    } else if (/^[A-Za-z_][\w.-]*=/.test(a)) cmdVars[a.slice(0, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else if (a.startsWith('-')) {
      io.err(`make: invalid option -- '${a.replace(/^-+/, '')}'\nUsage: make [options] [target] ...\n`);
      return 2;
    } else goals.push(a);
  }
  const cwd = ctx.sys.cwd;
  const chdir = dir !== cwd;
  const names = file ? [file] : ['GNUmakefile', 'makefile', 'Makefile'];
  const found = names.map((n) => (n.startsWith('/') ? n : `${dir === '/' ? '' : dir}/${n}`)).find((p) => lookup(ctx.sys.fs, p, actor(ctx))?.node.type === 'file');
  if (!found) {
    if (file) io.err(`make: ${file}: No such file or directory\nmake: *** No rule to make target '${file}'.  Stop.\n`);
    else if (goals.length) io.err(`make: *** No rule to make target '${goals[0]}'.  Stop.\n`);
    else io.err('make: *** No targets specified and no makefile found.  Stop.\n');
    return 2;
  }
  const shown = found.split('/').pop()!;
  ctx.sys.cwd = dir;
  if (chdir) io.out(`make: Entering directory '${dir}'\n`);
  try {
    const mk = parseMakefile(readFile(ctx.sys.fs, found, actor(ctx)), shown, ctx, cmdVars);
    const mtime = (p: string): number | null => {
      const l = lookup(ctx.sys.fs, abs(ctx, p), actor(ctx));
      return l ? l.node.mtime : null;
    };
    const built = new Map<string, boolean>();
    let didSomething = false;
    let failures = 0;
    const ruleFor = (t: string): { rule: Rule; stem?: string; deps: string[] } | null => {
      const explicit = mk.rules.filter((r) => !r.pattern && r.targets.includes(t));
      const withRecipe = explicit.find((r) => r.recipe.length);
      const deps = explicit.flatMap((r) => r.deps);
      if (withRecipe || (explicit.length && !mk.rules.some((r) => r.pattern))) return explicit.length ? { rule: withRecipe ?? explicit[0], deps } : null;
      for (const r of mk.rules.filter((x) => x.pattern)) {
        for (const pt of r.targets) {
          const [pre, post] = pt.split('%');
          if (!t.startsWith(pre) || !t.endsWith(post)) continue;
          const stem = t.slice(pre.length, t.length - post.length);
          const pdeps = r.deps.map((d) => d.replace('%', stem));
          if (pdeps.every((d) => mtime(d) !== null || ruleFor(d))) return { rule: r, stem, deps: [...pdeps, ...deps] };
        }
      }
      return explicit.length ? { rule: explicit[0], deps } : null;
    };
    const build = (t: string, parent: string | null, stack: string[]): boolean => {
      if (built.has(t)) return built.get(t)!;
      if (stack.includes(t)) {
        io.err(`make: Circular ${stack[stack.length - 1]} <- ${t} dependency dropped.\n`);
        return true;
      }
      const r = ruleFor(t);
      if (!r) {
        if (mtime(t) !== null) {
          built.set(t, true);
          return true;
        }
        throw new MakeError(parent ? `make: *** No rule to make target '${t}', needed by '${parent}'.  Stop.` : `make: *** No rule to make target '${t}'.  Stop.`);
      }
      let ok = true;
      for (const d of r.deps) {
        if (!build(d, t, [...stack, t])) {
          ok = false;
          if (!keepGoing) break;
        }
      }
      for (const d of r.rule.orderOnly) build(d, t, [...stack, t]);
      if (!ok) {
        built.set(t, false);
        return false;
      }
      const tm = mtime(t);
      const phony = mk.phony.has(t);
      const stale = always || phony || tm === null || r.deps.some((d) => (mtime(d) ?? Infinity) > tm);
      if (!stale || !r.rule.recipe.length) {
        built.set(t, true);
        return true;
      }
      if (question) {
        built.set(t, false);
        return false;
      }
      didSomething = true;
      const auto = { '@': t, '<': r.deps[0] ?? '', '^': [...new Set(r.deps)].join(' '), '+': r.deps.join(' '), '?': r.deps.filter((d) => tm === null || (mtime(d) ?? 0) > tm).join(' '), '*': r.stem ?? t.replace(/\.[^.]*$/, ''), '|': r.rule.orderOnly.join(' ') };
      const lines = mk.oneshell ? [{ text: r.rule.recipe.map((x) => x.text).join('\n'), line: r.rule.recipe[0].line }] : r.rule.recipe;
      for (const rl of lines) {
        let cmd = makeExpand(mk, rl.text, ctx, auto);
        let quiet = silent;
        let ignore = false;
        let force = false;
        while (/^[@\-+]/.test(cmd)) {
          if (cmd[0] === '@') quiet = true;
          if (cmd[0] === '-') ignore = true;
          if (cmd[0] === '+') force = true;
          cmd = cmd.slice(1);
        }
        if (!quiet || dry) io.out(cmd + '\n');
        if (dry && !force) continue;
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(mk.vars)) if (/^[A-Z_][A-Z0-9_]*$/.test(k)) env[k] = v.recursive ? makeExpand(mk, v.value, ctx) : v.value;
        const code = runCommand(ctx, ['bash', '-c', cmd], io);
        if (code !== 0) {
          if (ignore) {
            io.err(`make: [${shown}:${rl.line}: ${t}] Error ${code} (ignored)\n`);
            continue;
          }
          io.err(`make: *** [${shown}:${rl.line}: ${t}] Error ${code}\n`);
          failures++;
          built.set(t, false);
          return false;
        }
      }
      built.set(t, true);
      return true;
    };
    const targets = goals.length ? goals : mk.defaultGoal ? [mk.defaultGoal] : [];
    if (!targets.length) throw new MakeError('make: *** No targets.  Stop.');
    let allOk = true;
    for (const goal of targets) {
      const before: boolean = didSomething;
      didSomething = false;
      const ok = build(goal, null, []);
      if (!ok) {
        allOk = false;
        if (!keepGoing) break;
      } else if (!didSomething && !question) {
        const r = ruleFor(goal);
        io.out(r && (r.rule.recipe.length || mk.phony.has(goal)) && !mk.phony.has(goal) ? `make: '${goal}' is up to date.\n` : `make: Nothing to be done for '${goal}'.\n`);
      }
      didSomething = didSomething || before;
    }
    if (keepGoing && failures) io.err('make: Target not remade because of errors.\n');
    if (question) return allOk ? 0 : 1;
    return allOk ? 0 : 2;
  } catch (e) {
    if (e instanceof MakeError) {
      io.err(e.text + '\n');
      return e.code;
    }
    throw e;
  } finally {
    if (chdir) io.out(`make: Leaving directory '${dir}'\n`);
    ctx.sys.cwd = cwd;
  }
};

export const DEVOPS_COMMANDS: Record<string, Cmd> = { act, make };

void ROOT;
