/**
 * A GitHub Actions style workflow runner. Each job runs in its own fresh simulated machine (the
 * "runner"), steps run with bash -eo pipefail, and the usual contexts, expressions, matrices,
 * needs, outputs, GITHUB_ENV/GITHUB_OUTPUT files, workflow commands, secrets masking, artifacts,
 * caches and environment approvals behave as on the real service. The lab forge runs workflows
 * after pushes and on pull requests; `act` runs them locally from the working tree.
 */

import { lookup, readFile, writeFile, mkdir } from './fs.js';
import { buildSystem, type SystemSpec } from './system.js';
import { makeCtx, newSession, runScript, type Ctx } from './shell.js';
import { sha256 } from './hash.js';
import { parseYaml, yList, yMap, yStr, type Yaml } from './yaml.js';
import type { GitState } from './git-state.js';
import { ancestors } from './git-core.js';
import { pathMatch } from './git-core.js';

export interface CiStep {
  number: number;
  name: string;
  conclusion: 'success' | 'failure' | 'skipped' | 'cancelled';
  seconds: number;
  log: string[];
}

export interface CiJob {
  id: number;
  key: string;
  name: string;
  status: 'completed' | 'waiting' | 'pending';
  conclusion: 'success' | 'failure' | 'skipped' | 'cancelled' | null;
  steps: CiStep[];
  seconds: number;
  outputs: Record<string, string>;
  environment?: string;
  matrix?: Record<string, string>;
}

export interface CiAnnotation {
  level: 'error' | 'warning' | 'notice';
  job: string;
  message: string;
  file?: string;
  line?: number;
}

export interface CiRun {
  id: number;
  number: number;
  repo: string;
  workflow: string;
  file: string;
  event: string;
  branch: string;
  sha: string;
  title: string;
  actor: string;
  status: 'completed' | 'waiting' | 'in_progress';
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null;
  jobs: CiJob[];
  annotations: CiAnnotation[];
  artifacts: Array<{ name: string; files: Record<string, string> }>;
  createdAt: number;
  attempt: number;
  pr?: number;
  inputs?: Record<string, string>;
  summary?: string;
}

export interface CiInput {
  ctx: Ctx;
  repo: string;
  /** Files of the commit (or working tree) being built. */
  files: Record<string, string>;
  exec: string[];
  /** Repository history, for actions/checkout with fetch-depth. */
  history?: GitState;
  event: string;
  ref: string;
  sha: string;
  actor: string;
  secrets: Record<string, string>;
  vars: Record<string, string>;
  inputs?: Record<string, string>;
  pr?: { number: number; base: string; head: string; title: string };
  cache: Record<string, Record<string, string>>;
  environments?: Record<string, { reviewers?: string[]; secrets?: Record<string, string>; vars?: Record<string, string> }>;
  approved?: string[];
  /** Live log lines (act prints as it goes). */
  live?: (job: string, text: string) => void;
  onlyJob?: string;
  matrixFilter?: Record<string, string>;
  serverUrl: string;
  runId: number;
  runNumber: number;
  /** A run resumed after an approval: jobs that already finished. */
  previous?: CiRun;
  title?: string;
}

/* ----------------------------------------------------------------------------- expressions */

type Val = string | number | boolean | null | Val[] | { [k: string]: Val };

interface ExprEnv {
  contexts: Record<string, Val>;
  status: { failed: boolean; cancelled: boolean };
  hashFiles: (pats: string[]) => string;
}

class ExprError extends Error {}

function tokenizeExpr(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let v = '';
      while (j < s.length) {
        if (s[j] === "'" && s[j + 1] === "'") {
          v += "'";
          j += 2;
        } else if (s[j] === "'") break;
        else v += s[j++];
      }
      out.push("'" + v);
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      out.push(two);
      i += 2;
      continue;
    }
    if ('()[],.!<>'.includes(c)) {
      out.push(c);
      i++;
      continue;
    }
    const m = /^[A-Za-z_][\w-]*|^-?\d+(\.\d+)?|^\*/.exec(s.slice(i));
    if (!m) throw new ExprError(`Unexpected symbol: '${c}'`);
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

const truthyVal = (v: Val) => !(v === false || v === null || v === '' || v === 0);
const toStr = (v: Val): string => (v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const looseEq = (a: Val, b: Val) => {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return toStr(a) === toStr(b);
};

function evalExpr(src: string, env: ExprEnv): Val {
  const t = tokenizeExpr(src);
  let k = 0;
  const peek = () => t[k];
  const next = () => t[k++];
  const or = (): Val => {
    let v = and();
    while (peek() === '||') {
      next();
      const r = and();
      v = truthyVal(v) ? v : r;
    }
    return v;
  };
  const and = (): Val => {
    let v = cmp();
    while (peek() === '&&') {
      next();
      const r = cmp();
      v = truthyVal(v) ? r : v;
    }
    return v;
  };
  const cmp = (): Val => {
    let v = unary();
    while (['==', '!=', '<', '>', '<=', '>='].includes(peek())) {
      const op = next();
      const r = unary();
      if (op === '==') v = looseEq(v, r);
      else if (op === '!=') v = !looseEq(v, r);
      else {
        const [a, b] = [Number(v), Number(r)];
        v = op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b;
      }
    }
    return v;
  };
  const unary = (): Val => {
    if (peek() === '!') {
      next();
      return !truthyVal(unary());
    }
    return postfix(primary());
  };
  const postfix = (v: Val): Val => {
    for (;;) {
      if (peek() === '.') {
        next();
        const key = next();
        v = key === '*' ? (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []) : getProp(v, key);
      } else if (peek() === '[') {
        next();
        const key = or();
        if (next() !== ']') throw new ExprError("Expected ']'");
        v = getProp(v, toStr(key));
      } else return v;
    }
  };
  const getProp = (v: Val, key: string): Val => {
    if (Array.isArray(v)) return /^\d+$/.test(key) ? v[Number(key)] ?? null : v.map((x) => getProp(x, key));
    if (v && typeof v === 'object') {
      const hit = Object.keys(v).find((x) => x.toLowerCase() === key.toLowerCase());
      return hit !== undefined ? v[hit] : null;
    }
    return null;
  };
  const primary = (): Val => {
    const tok = next();
    if (tok === undefined) throw new ExprError('Unexpected end of expression');
    if (tok === '(') {
      const v = or();
      if (next() !== ')') throw new ExprError("Expected ')'");
      return v;
    }
    if (tok.startsWith("'")) return tok.slice(1);
    if (/^-?\d/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (peek() === '(') {
      next();
      const args: Val[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') next();
        else if (peek() !== ')') throw new ExprError("Expected ',' or ')'");
      }
      next();
      return call(tok, args);
    }
    const ctxName = Object.keys(env.contexts).find((c) => c.toLowerCase() === tok.toLowerCase());
    if (!ctxName) throw new ExprError(`Unrecognized named-value: '${tok}'`);
    return env.contexts[ctxName];
  };
  const call = (name: string, a: Val[]): Val => {
    switch (name.toLowerCase()) {
      case 'success':
        return !env.status.failed && !env.status.cancelled;
      case 'failure':
        return env.status.failed;
      case 'always':
        return true;
      case 'cancelled':
        return env.status.cancelled;
      case 'contains':
        return Array.isArray(a[0]) ? a[0].some((x) => looseEq(x, a[1])) : toStr(a[0]).toLowerCase().includes(toStr(a[1]).toLowerCase());
      case 'startswith':
        return toStr(a[0]).toLowerCase().startsWith(toStr(a[1]).toLowerCase());
      case 'endswith':
        return toStr(a[0]).toLowerCase().endsWith(toStr(a[1]).toLowerCase());
      case 'format':
        return toStr(a[0]).replace(/\{(\d+)\}/g, (_, n: string) => toStr(a[Number(n) + 1] ?? ''));
      case 'join':
        return Array.isArray(a[0]) ? a[0].map(toStr).join(a[1] === undefined ? ',' : toStr(a[1])) : toStr(a[0]);
      case 'tojson':
        return JSON.stringify(a[0], null, 2);
      case 'fromjson':
        return JSON.parse(toStr(a[0])) as Val;
      case 'hashfiles':
        return env.hashFiles(a.map(toStr));
    }
    throw new ExprError(`Unrecognized function: '${name}'`);
  };
  const v = or();
  if (k < t.length) throw new ExprError(`Unexpected symbol: '${t[k]}'`);
  return v;
}

/** Replaces ${{ ... }} in text. */
function interpolate(text: string, env: ExprEnv): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e: string) => toStr(evalExpr(e.trim(), env)));
}

/** An `if:` condition: a bare expression, or one wrapped in ${{ }}; status functions default to success(). */
function condition(text: string | undefined, env: ExprEnv): boolean {
  if (text === undefined || text === '') return !env.status.failed && !env.status.cancelled;
  const e = text.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  const usesStatus = /\b(success|failure|always|cancelled)\s*\(/i.test(e);
  const v = truthyVal(evalExpr(e, env));
  return usesStatus ? v : v && !env.status.failed && !env.status.cancelled;
}

/* ----------------------------------------------------------------------------- triggers */

export interface WorkflowFile {
  path: string;
  doc: Record<string, Yaml>;
  name: string;
  error?: string;
}

export function readWorkflows(files: Record<string, string>): WorkflowFile[] {
  const out: WorkflowFile[] = [];
  for (const p of Object.keys(files).sort()) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) continue;
    try {
      const doc = yMap(parseYaml(files[p]));
      const errors = validateWorkflow(doc);
      out.push({ path: p, doc, name: yStr(doc.name) || p.replace(/^.*\//, ''), error: errors[0] });
    } catch (e) {
      out.push({ path: p, doc: {}, name: p.replace(/^.*\//, ''), error: (e as Error).message });
    }
  }
  return out;
}

function validateWorkflow(doc: Record<string, Yaml>): string[] {
  const errs: string[] = [];
  if (doc.on === undefined && doc.true === undefined) errs.push("Required property is missing: 'on'");
  const jobs = yMap(doc.jobs);
  if (!Object.keys(jobs).length) errs.push("Required property is missing: 'jobs'");
  for (const [k, j] of Object.entries(jobs)) {
    const jm = yMap(j);
    if (jm['runs-on'] === undefined && jm.uses === undefined) errs.push(`Job '${k}' is missing 'runs-on'`);
    for (const n of yList(jm.needs)) if (!jobs[yStr(n)]) errs.push(`Job '${k}' depends on unknown job '${yStr(n)}'`);
    yList(jm.steps).forEach((s, i) => {
      const sm = yMap(s);
      if (sm.run === undefined && sm.uses === undefined) errs.push(`Job '${k}' step ${i + 1}: a step needs 'run' or 'uses'`);
      if (sm.run !== undefined && sm.uses !== undefined) errs.push(`Job '${k}' step ${i + 1}: a step cannot have both 'run' and 'uses'`);
    });
  }
  return errs;
}

const globList = (v: Yaml | undefined) => yList(v).map(yStr);
const refGlob = (pat: string, name: string) => new RegExp('^' + pat.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.') + '$').test(name);

/** Whether a workflow runs for an event. `changed` lists paths touched (for paths filters). */
export function triggers(doc: Record<string, Yaml>, event: string, ref: string, changed?: string[], baseBranch?: string): boolean {
  const on = doc.on ?? doc.true;
  let spec: Yaml | undefined;
  if (typeof on === 'string') spec = on === event ? '' : undefined;
  else if (Array.isArray(on)) spec = on.map(yStr).includes(event) ? '' : undefined;
  else spec = Object.prototype.hasOwnProperty.call(yMap(on), event) ? yMap(on)[event] : undefined;
  if (spec === undefined) return false;
  const f = yMap(spec);
  const isTag = ref.startsWith('refs/tags/');
  const name = ref.replace(/^refs\/(heads|tags)\//, '');
  const branchName = event === 'pull_request' ? baseBranch ?? name : name;
  if (event === 'push') {
    const branches = globList(f.branches);
    const ignore = globList(f['branches-ignore']);
    const tags = globList(f.tags);
    const tagsIgnore = globList(f['tags-ignore']);
    const hasBranchFilter = f.branches !== undefined || f['branches-ignore'] !== undefined;
    const hasTagFilter = f.tags !== undefined || f['tags-ignore'] !== undefined;
    if (isTag) {
      if (!hasTagFilter && hasBranchFilter) return false;
      if (tags.length && !tags.some((p) => refGlob(p, name))) return false;
      if (tagsIgnore.some((p) => refGlob(p, name))) return false;
    } else {
      if (!hasBranchFilter && hasTagFilter) return false;
      if (branches.length && !matchesWithNegation(branches, name)) return false;
      if (ignore.some((p) => refGlob(p, name))) return false;
    }
  }
  if (event === 'pull_request' || event === 'pull_request_target') {
    const branches = globList(f.branches);
    if (branches.length && !matchesWithNegation(branches, branchName)) return false;
    if (globList(f['branches-ignore']).some((p) => refGlob(p, branchName))) return false;
  }
  if (changed && (f.paths !== undefined || f['paths-ignore'] !== undefined)) {
    const paths = globList(f.paths);
    const ignore = globList(f['paths-ignore']);
    if (paths.length && !changed.some((p) => matchesWithNegation(paths, p, true))) return false;
    if (ignore.length && changed.every((p) => ignore.some((q) => pathMatch(p, [q])))) return false;
  }
  return true;
}

function matchesWithNegation(pats: string[], name: string, isPath = false): boolean {
  let hit = false;
  for (const p of pats) {
    const neg = p.startsWith('!');
    const pat = neg ? p.slice(1) : p;
    if (isPath ? pathMatch(name, [pat]) : refGlob(pat, name)) hit = !neg;
  }
  return hit;
}

/* ----------------------------------------------------------------------------- matrices */

function expandMatrix(m: Yaml | undefined, env: ExprEnv): Array<Record<string, string>> {
  if (m === undefined) return [{}];
  if (typeof m === 'string') {
    const v = evalExpr(m.replace(/^\$\{\{|\}\}$/g, '').trim(), env);
    return expandMatrix(v as unknown as Yaml, env);
  }
  const map = yMap(m);
  const keys = Object.keys(map).filter((k) => k !== 'include' && k !== 'exclude');
  let combos: Array<Record<string, string>> = [{}];
  for (const k of keys) {
    const vals = yList(map[k]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
    const next: Array<Record<string, string>> = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [k]: v });
    combos = next;
  }
  if (!keys.length) combos = [];
  for (const ex of yList(map.exclude)) {
    const e = Object.fromEntries(Object.entries(yMap(ex)).map(([k, v]) => [k, yStr(v)]));
    combos = combos.filter((c) => !Object.entries(e).every(([k, v]) => c[k] === v));
  }
  for (const inc of yList(map.include)) {
    const e = Object.fromEntries(Object.entries(yMap(inc)).map(([k, v]) => [k, yStr(v)]));
    const original = Object.entries(e).filter(([k]) => keys.includes(k));
    const matching = combos.filter((c) => original.every(([k, v]) => c[k] === v));
    if (matching.length && original.length) for (const c of matching) Object.assign(c, Object.fromEntries(Object.entries(e).filter(([k]) => !keys.includes(k) || c[k] === e[k])));
    else combos.push(e);
  }
  return combos.length ? combos : [{}];
}

/* ----------------------------------------------------------------------------- the runner machine */

const RUNNER_PACKAGES: SystemSpec['packages'] = {
  git: { installed: true },
  curl: { installed: true },
  jq: { installed: true },
  shellcheck: { installed: true },
  zip: { installed: true },
  make: { installed: true },
  docker: { installed: true },
  rsync: { installed: true },
};

function runnerBox(input: CiInput, workspace: string): ReturnType<typeof buildSystem> {
  const box = buildSystem({
    hostname: 'runner',
    user: 'runner',
    users: { runner: { sudo: true, groups: ['docker'] } },
    packages: RUNNER_PACKAGES,
    services: { docker: { active: true, enabled: true } as never },
    cwd: workspace,
    now: new Date(input.ctx.sys.now).toISOString(),
    files: { [`${workspace}/.keep`]: '' },
  } as SystemSpec);
  if (!box.sudoers.includes('runner')) box.sudoers.push('runner');
  return box;
}

function writeBoxFile(box: ReturnType<typeof buildSystem>, path: string, content: string, exec = false): void {
  const who = { user: 'runner', groups: ['runner'] };
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  mkdir(box.fs, dir, { user: 'root', groups: ['root'] }, box.now, true);
  const d = lookup(box.fs, dir, { user: 'root', groups: ['root'] });
  if (d && d.node.owner === 'root' && dir.startsWith('/home/runner')) {
    d.node.owner = 'runner';
    d.node.group = 'runner';
  }
  writeFile(box.fs, path, content, { user: 'root', groups: ['root'] }, box.now);
  const l = lookup(box.fs, path, who);
  if (l) {
    l.node.owner = 'runner';
    l.node.group = 'runner';
    if (exec) l.node.mode |= 0o111;
  }
}

function readBox(box: ReturnType<typeof buildSystem>, path: string): string | null {
  try {
    return readFile(box.fs, path, { user: 'root', groups: ['root'] });
  } catch {
    return null;
  }
}

function boxFiles(box: ReturnType<typeof buildSystem>, base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const l = lookup(box.fs, base, { user: 'root', groups: ['root'] });
  if (!l) return out;
  if (l.node.type === 'file') {
    out[base.split('/').pop()!] = l.node.content;
    return out;
  }
  const walk = (node: typeof l.node, rel: string) => {
    if (node.type !== 'dir') return;
    for (const [n, c] of Object.entries(node.children)) {
      if (n === '.git' && !rel) continue;
      const p = rel ? `${rel}/${n}` : n;
      if (c.type === 'dir') walk(c, p);
      else if (c.type === 'file') out[p] = c.content;
    }
  };
  walk(l.node, '');
  return out;
}

function globIn(files: Record<string, string>, pattern: string): string[] {
  const pat = pattern.replace(/^\.\//, '');
  return Object.keys(files).filter((p) => pathMatch(p, [pat]) || p.startsWith(pat.replace(/\/$/, '') + '/'));
}

/* ----------------------------------------------------------------------------- running */

/** Runs one workflow for an event. */
export function runWorkflow(input: CiInput, wf: WorkflowFile): CiRun {
  const doc = wf.doc;
  const run: CiRun = {
    id: input.runId,
    number: input.runNumber,
    repo: input.repo,
    workflow: wf.name,
    file: wf.path,
    event: input.event,
    branch: input.pr ? input.pr.head : input.ref.replace(/^refs\/(heads|tags)\//, ''),
    sha: input.sha,
    title: input.title ?? wf.name,
    actor: input.actor,
    status: 'in_progress',
    conclusion: null,
    jobs: [],
    annotations: [],
    artifacts: input.previous?.artifacts ?? [],
    createdAt: input.ctx.sys.now,
    attempt: input.previous?.attempt ?? 1,
    pr: input.pr?.number,
    inputs: input.inputs,
  };
  if (wf.error) {
    run.status = 'completed';
    run.conclusion = 'failure';
    run.annotations.push({ level: 'error', job: '.github', message: `Invalid workflow file: ${wf.path}: ${wf.error}`, file: wf.path });
    return run;
  }
  const repoName = input.repo.split('/')[1] ?? input.repo;
  const workspace = `/home/runner/work/${repoName}/${repoName}`;
  const masks = new Set(Object.values(input.secrets).filter((s) => s.length > 2));
  const mask = (s: string) => {
    let out = s;
    for (const m of masks) out = out.split(m).join('***');
    return out;
  };
  const github: Record<string, Val> = {
    sha: input.sha,
    ref: input.ref,
    ref_name: input.ref.replace(/^refs\/(heads|tags)\//, ''),
    ref_type: input.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    event_name: input.event,
    repository: input.repo,
    repository_owner: input.repo.split('/')[0],
    actor: input.actor,
    triggering_actor: input.actor,
    run_id: String(input.runId),
    run_number: String(input.runNumber),
    run_attempt: String(run.attempt),
    workflow: wf.name,
    workspace,
    server_url: input.serverUrl,
    api_url: `${input.serverUrl}/api/v3`,
    head_ref: input.pr?.head ?? '',
    base_ref: input.pr?.base ?? '',
    event: input.pr ? { pull_request: { number: input.pr.number, title: input.pr.title, head: { ref: input.pr.head, sha: input.sha }, base: { ref: input.pr.base } }, number: input.pr.number } : { inputs: input.inputs ?? {}, ref: input.ref },
  };
  const wfEnv = Object.fromEntries(Object.entries(yMap(doc.env)).map(([k, v]) => [k, yStr(v)]));
  const jobs = yMap(doc.jobs);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (k: string, stack: string[] = []) => {
    if (seen.has(k)) return;
    if (stack.includes(k)) throw new Error(`Job dependency cycle: ${[...stack, k].join(' -> ')}`);
    for (const n of yList(yMap(jobs[k]).needs)) visit(yStr(n), [...stack, k]);
    seen.add(k);
    order.push(k);
  };
  for (const k of Object.keys(jobs)) visit(k);
  const results: Record<string, { result: string; outputs: Record<string, string> }> = {};
  let jobId = input.runId * 10;
  let waiting = false;
  for (const key of order) {
    if (input.onlyJob && key !== input.onlyJob) continue;
    const j = yMap(jobs[key]);
    const needs = yList(j.needs).map(yStr);
    const needsCtx: Record<string, Val> = {};
    for (const n of needs) needsCtx[n] = { result: results[n]?.result ?? 'skipped', outputs: results[n]?.outputs ?? {} };
    const failedNeed = needs.some((n) => results[n] && results[n].result !== 'success');
    const pendingNeed = needs.some((n) => !results[n]) && !input.onlyJob;
    const baseEnv: ExprEnv = {
      contexts: { github, env: { ...wfEnv }, vars: input.vars, secrets: input.secrets, needs: needsCtx, inputs: input.inputs ?? {}, runner: { os: 'Linux', arch: 'X64', name: 'runner', temp: '/home/runner/work/_temp' }, matrix: {}, strategy: {}, job: { status: 'success' }, steps: {} },
      status: { failed: failedNeed, cancelled: false },
      hashFiles: (pats) => hashFilesOf(input.files, pats),
    };
    const combos = expandMatrix(yMap(j.strategy).matrix, baseEnv).filter((c) => !input.matrixFilter || Object.entries(input.matrixFilter).every(([k, v]) => c[k] === v));
    const failFast = yStr(yMap(j.strategy)['fail-fast']) !== 'false';
    let anyFailed = false;
    const jobOutputs: Record<string, string> = {};
    for (const combo of combos) {
      const label = yStr(j.name) || key;
      const comboVals = Object.values(combo);
      const env0: ExprEnv = { ...baseEnv, contexts: { ...baseEnv.contexts, matrix: combo, strategy: { 'fail-fast': failFast, 'job-index': combos.indexOf(combo), 'job-total': combos.length } } };
      let name: string;
      try {
        name = j.name ? interpolate(yStr(j.name), env0) : comboVals.length ? `${label} (${comboVals.join(', ')})` : label;
      } catch {
        name = label;
      }
      const prev = input.previous?.jobs.find((x) => x.key === key && x.name === name && x.status === 'completed');
      if (prev) {
        run.jobs.push(prev);
        if (prev.conclusion === 'failure') anyFailed = true;
        Object.assign(jobOutputs, prev.outputs);
        continue;
      }
      const job: CiJob = { id: ++jobId, key, name, status: 'completed', conclusion: null, steps: [], seconds: 0, outputs: {}, matrix: Object.keys(combo).length ? combo : undefined };
      run.jobs.push(job);
      if (pendingNeed || waiting) {
        job.status = 'pending';
        continue;
      }
      if (anyFailed && failFast) {
        job.conclusion = 'cancelled';
        continue;
      }
      let ok: boolean;
      try {
        ok = condition(j.if !== undefined ? yStr(j.if) : undefined, env0);
      } catch (e) {
        run.annotations.push({ level: 'error', job: name, message: `The workflow is not valid. ${wf.path}: ${(e as Error).message}`, file: wf.path });
        job.conclusion = 'failure';
        anyFailed = true;
        continue;
      }
      if (!ok) {
        job.conclusion = 'skipped';
        continue;
      }
      // Environments with required reviewers wait for an approval.
      const envName = typeof j.environment === 'string' ? j.environment : yStr(yMap(j.environment).name);
      if (envName) {
        job.environment = envName;
        const envSpec = input.environments?.[envName];
        if (envSpec?.reviewers?.length && !input.approved?.includes(envName)) {
          job.status = 'waiting';
          waiting = true;
          continue;
        }
      }
      const envSecrets = envName ? input.environments?.[envName]?.secrets ?? {} : {};
      for (const s of Object.values(envSecrets)) if (s.length > 2) masks.add(s);
      const r = runJob(input, run, job, j, { ...env0, contexts: { ...env0.contexts, secrets: { ...input.secrets, ...envSecrets }, vars: { ...input.vars, ...(envName ? input.environments?.[envName]?.vars ?? {} : {}) } } }, workspace, wfEnv, mask);
      if (!r) anyFailed = true;
      Object.assign(jobOutputs, job.outputs);
    }
    if (run.jobs.some((x) => x.key === key && (x.status === 'pending' || x.status === 'waiting'))) continue;
    const mine = run.jobs.filter((x) => x.key === key);
    results[key] = {
      result: mine.some((x) => x.conclusion === 'failure') ? 'failure' : mine.every((x) => x.conclusion === 'skipped') ? 'skipped' : mine.some((x) => x.conclusion === 'cancelled') ? 'cancelled' : 'success',
      outputs: jobOutputs,
    };
  }
  if (waiting || run.jobs.some((x) => x.status === 'waiting')) {
    run.status = 'waiting';
    return run;
  }
  run.status = 'completed';
  const concl = run.jobs.map((x) => x.conclusion);
  run.conclusion = concl.some((c) => c === 'failure') ? 'failure' : concl.some((c) => c === 'cancelled') ? 'cancelled' : concl.length && concl.every((c) => c === 'skipped') ? 'skipped' : 'success';
  return run;
}

function hashFilesOf(files: Record<string, string>, pats: string[]): string {
  const hits = [...new Set(pats.flatMap((p) => Object.keys(files).filter((f) => pathMatch(f, [p.replace(/^\.\//, '')]))))].sort();
  if (!hits.length) return '';
  return sha256(hits.map((h) => sha256(files[h])).join(''));
}

/** Runs one job (one matrix combination). Returns whether it succeeded. */
function runJob(input: CiInput, run: CiRun, job: CiJob, j: Record<string, Yaml>, env0: ExprEnv, workspace: string, wfEnv: Record<string, string>, mask: (s: string) => string): boolean {
  const box = runnerBox(input, workspace);
  const live = (text: string) => input.live?.(job.name, mask(text));
  const jobEnv: Record<string, string> = { ...wfEnv };
  for (const [k, v] of Object.entries(yMap(j.env))) jobEnv[k] = interpolate(yStr(v), env0);
  const defaults = yMap(yMap(j.defaults).run);
  const stepsCtx: Record<string, Val> = {};
  const envMap: Record<string, string> = {};
  const pathAdds: string[] = [];
  let failed = false;
  let stepNo = 1;
  const setup: CiStep = { number: stepNo++, name: 'Set up job', conclusion: 'success', seconds: 1, log: [`Current runner version: '2.320.0'`, `Operating System`, `  Ubuntu`, `  24.04.1`, `  LTS`, `Runner Image`, `  Image: ubuntu-24.04`, `Prepare workflow directory`, `Prepare all required actions`, `Complete job name: ${job.name}`] };
  job.steps.push(setup);
  live('🚀  Start image=catthehacker/ubuntu:act-latest');
  if (yMap(j.services) && Object.keys(yMap(j.services)).length) setup.log.push(`Note: service containers (${Object.keys(yMap(j.services)).join(', ')}) are not started in this simulator.`);
  const steps = yList(j.steps);
  const post: Array<() => void> = [];
  for (const [n, raw] of steps.entries()) {
    const s = yMap(raw);
    const ctxNow: ExprEnv = { ...env0, contexts: { ...env0.contexts, env: { ...jobEnv, ...envMap }, steps: stepsCtx, job: { status: failed ? 'failure' : 'success' } }, status: { failed, cancelled: false } };
    const stepEnv: Record<string, string> = { ...jobEnv, ...envMap };
    let display: string;
    try {
      for (const [k, v] of Object.entries(yMap(s.env))) stepEnv[k] = interpolate(yStr(v), ctxNow);
      display = s.name ? interpolate(yStr(s.name), ctxNow) : s.uses ? `Run ${yStr(s.uses)}` : `Run ${yStr(s.run).split('\n')[0]}`;
    } catch (e) {
      display = s.name ? yStr(s.name) : `step ${n + 1}`;
      job.steps.push({ number: stepNo++, name: display, conclusion: 'failure', seconds: 0, log: [`Error: ${(e as Error).message}`] });
      failed = true;
      continue;
    }
    const step: CiStep = { number: stepNo++, name: display, conclusion: 'success', seconds: 1, log: [] };
    let run2: boolean;
    try {
      run2 = condition(s.if !== undefined ? yStr(s.if) : undefined, ctxNow);
    } catch (e) {
      step.conclusion = 'failure';
      step.log.push(`Error: The step's if: is not valid: ${(e as Error).message}`);
      job.steps.push(step);
      failed = true;
      continue;
    }
    if (!run2) {
      step.conclusion = 'skipped';
      job.steps.push(step);
      continue;
    }
    job.steps.push(step);
    live(`⭐ Run Main ${display}`);
    const id = s.id ? yStr(s.id) : undefined;
    const outputs: Record<string, string> = {};
    let code = 0;
    const out = (text: string) => {
      for (const line of text.replace(/\n$/, '').split('\n')) {
        const cmd = /^::(error|warning|notice|add-mask|group|endgroup|debug|set-output)(?:\s+([^:]*))?::(.*)$/.exec(line);
        if (cmd) {
          const [, kind, props = '', msg] = cmd;
          if (kind === 'add-mask') {
            if (msg.length > 2) (input.secrets as Record<string, string>)[`__mask${Object.keys(input.secrets).length}`] = msg;
            continue;
          }
          if (kind === 'group') {
            step.log.push(`▶ ${msg}`);
            continue;
          }
          if (kind === 'endgroup' || kind === 'debug') continue;
          if (kind === 'set-output') {
            const nm = /name=([\w-]+)/.exec(props)?.[1];
            if (nm) outputs[nm] = msg;
            continue;
          }
          const file = /file=([^,]+)/.exec(props)?.[1];
          const ln = /line=(\d+)/.exec(props)?.[1];
          run.annotations.push({ level: kind as 'error', job: job.name, message: msg, file, line: ln ? Number(ln) : undefined });
          step.log.push(`${kind === 'error' ? 'Error' : kind === 'warning' ? 'Warning' : 'Notice'}: ${msg}`);
          live(`  | ${kind === 'error' ? '❗' : '⚠'} ${msg}`);
          continue;
        }
        step.log.push(mask(line));
        live(`  | ${line}`);
      }
    };
    try {
      if (s.uses !== undefined) {
        const withArgs: Record<string, string> = {};
        for (const [k, v] of Object.entries(yMap(s.with))) withArgs[k] = interpolate(yStr(v), ctxNow);
        code = runAction(input, run, job, box, workspace, interpolate(yStr(s.uses), ctxNow), withArgs, step, out, post, stepEnv);
      } else {
        const script = interpolate(yStr(s.run), ctxNow);
        const shellName = yStr(s.shell) || yStr(defaults.shell) || 'bash';
        const wd = yStr(s['working-directory']) || yStr(defaults['working-directory']);
        code = runStepScript(input, box, workspace, script, shellName, wd, stepEnv, pathAdds, out);
      }
    } catch (e) {
      out(`Error: ${(e as Error).message}`);
      code = 1;
    }
    // GITHUB_ENV, GITHUB_OUTPUT, GITHUB_PATH written by the step.
    const envFile = readBox(box, '/home/runner/work/_temp/_runner_file_commands/set_env') ?? '';
    for (const [k, v] of parseFileCommands(envFile)) envMap[k] = v;
    for (const [k, v] of parseFileCommands(readBox(box, '/home/runner/work/_temp/_runner_file_commands/set_output') ?? '')) outputs[k] = v;
    for (const p of (readBox(box, '/home/runner/work/_temp/_runner_file_commands/add_path') ?? '').split('\n').filter(Boolean)) if (!pathAdds.includes(p)) pathAdds.unshift(p);
    const summary = readBox(box, '/home/runner/work/_temp/_runner_file_commands/step_summary');
    if (summary) run.summary = (run.summary ?? '') + summary;
    for (const f of ['set_env', 'set_output', 'add_path', 'step_summary']) writeBoxFile(box, `/home/runner/work/_temp/_runner_file_commands/${f}`, '');
    step.seconds = 1 + Math.min(20, step.log.length);
    const continueOnError = yStr(s['continue-on-error']) === 'true';
    if (code !== 0) {
      step.log.push(`Error: Process completed with exit code ${code}.`);
      if (!run.annotations.some((a) => a.job === job.name && a.message.startsWith('Process completed'))) run.annotations.push({ level: 'error', job: job.name, message: `Process completed with exit code ${code}.` });
      live(`  ❌  Failure - Main ${display}`);
      live(`exitcode '${code}': failure`);
      if (continueOnError) step.conclusion = 'failure';
      else {
        step.conclusion = 'failure';
        failed = true;
      }
    } else live(`  ✅  Success - Main ${display}`);
    if (id) stepsCtx[id] = { outputs, outcome: code === 0 ? 'success' : 'failure', conclusion: code === 0 || continueOnError ? 'success' : 'failure' };
  }
  for (const p of post) p();
  job.steps.push({ number: stepNo++, name: 'Complete job', conclusion: 'success', seconds: 0, log: ['Cleaning up orphan processes'] });
  // Job outputs.
  const outCtx: ExprEnv = { ...env0, contexts: { ...env0.contexts, steps: stepsCtx, env: { ...jobEnv, ...envMap } } };
  for (const [k, v] of Object.entries(yMap(j.outputs))) {
    try {
      job.outputs[k] = interpolate(yStr(v), outCtx);
    } catch {
      job.outputs[k] = '';
    }
  }
  const contErr = yStr(j['continue-on-error']) === 'true';
  job.conclusion = failed && !contErr ? 'failure' : 'success';
  job.seconds = job.steps.reduce((s, x) => s + x.seconds, 0);
  live(failed ? '🏁  Job failed' : '🏁  Job succeeded');
  return !failed || contErr;
}

function parseFileCommands(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const heredoc = /^([\w-]+)<<(.+)$/.exec(l);
    if (heredoc) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== heredoc[2]) body.push(lines[i++]);
      out.push([heredoc[1], body.join('\n')]);
      continue;
    }
    const eq = l.indexOf('=');
    if (eq > 0) out.push([l.slice(0, eq), l.slice(eq + 1)]);
  }
  return out;
}

function runStepScript(input: CiInput, box: ReturnType<typeof buildSystem>, workspace: string, script: string, shellName: string, wd: string, env: Record<string, string>, pathAdds: string[], out: (s: string) => void): number {
  const bctx = makeCtx(box, newSession(box));
  const runnerEnv: Record<string, string> = {
    ...env,
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKSPACE: workspace,
    GITHUB_SHA: input.sha,
    GITHUB_REF: input.ref,
    GITHUB_REF_NAME: input.ref.replace(/^refs\/(heads|tags)\//, ''),
    GITHUB_REPOSITORY: input.repo,
    GITHUB_EVENT_NAME: input.event,
    GITHUB_ACTOR: input.actor,
    GITHUB_RUN_ID: String(input.runId),
    GITHUB_RUN_NUMBER: String(input.runNumber),
    GITHUB_SERVER_URL: input.serverUrl,
    GITHUB_HEAD_REF: input.pr?.head ?? '',
    GITHUB_BASE_REF: input.pr?.base ?? '',
    RUNNER_OS: 'Linux',
    RUNNER_TEMP: '/home/runner/work/_temp',
    HOME: '/home/runner',
    GITHUB_ENV: '/home/runner/work/_temp/_runner_file_commands/set_env',
    GITHUB_OUTPUT: '/home/runner/work/_temp/_runner_file_commands/set_output',
    GITHUB_PATH: '/home/runner/work/_temp/_runner_file_commands/add_path',
    GITHUB_STEP_SUMMARY: '/home/runner/work/_temp/_runner_file_commands/step_summary',
  };
  for (const f of ['set_env', 'set_output', 'add_path', 'step_summary']) if (readBox(box, `/home/runner/work/_temp/_runner_file_commands/${f}`) === null) writeBoxFile(box, `/home/runner/work/_temp/_runner_file_commands/${f}`, '');
  for (const [k, v] of Object.entries(runnerEnv)) {
    bctx.vars[k] = v;
    bctx.exported.add(k);
  }
  if (pathAdds.length) {
    bctx.vars.PATH = `${pathAdds.join(':')}:${bctx.vars.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`;
    bctx.exported.add('PATH');
  }
  box.cwd = wd ? (wd.startsWith('/') ? wd : `${workspace}/${wd}`) : workspace;
  if (!lookup(box.fs, box.cwd, { user: 'root', groups: ['root'] })) {
    out(`Error: An error occurred trying to start process '/usr/bin/bash' with working directory '${box.cwd}'. No such file or directory`);
    return 1;
  }
  const prelude = shellName === 'sh' ? 'set -e\n' : shellName === 'bash' ? 'set -eo pipefail\n' : '';
  const io = { stdin: '', out: (s: string) => out(s), err: (s: string) => out(s) };
  try {
    return runScript(bctx, prelude + script, [], shellName === 'sh' ? 'sh' : 'bash', io);
  } catch (e) {
    out(String((e as Error).message ?? e));
    return 1;
  }
}

/** The actions the runner understands, and what they do in the runner machine. */
function runAction(input: CiInput, run: CiRun, job: CiJob, box: ReturnType<typeof buildSystem>, workspace: string, uses: string, w: Record<string, string>, step: CiStep, out: (s: string) => void, post: Array<() => void>, env: Record<string, string>): number {
  const [name, version = ''] = uses.split('@');
  switch (name) {
    case 'actions/checkout': {
      const depth = w['fetch-depth'] !== undefined ? Number(w['fetch-depth']) : 1;
      const dest = w.path ? `${workspace}/${w.path}` : workspace;
      out(`Syncing repository: ${input.repo}`);
      for (const [p, content] of Object.entries(input.files)) writeBoxFile(box, `${dest}/${p}`, content, input.exec.includes(p));
      if (input.history) {
        // A real repository in the workspace: shallow (fetch-depth: 1) unless fetch-depth: 0.
        const st = input.history;
        const keep = new Set<string>();
        const shallow: string[] = [];
        if (depth === 0) for (const c of ancestors(st, input.sha)) keep.add(c);
        else {
          let frontier = [input.sha];
          for (let d = 1; d <= depth && frontier.length; d++) {
            const next: string[] = [];
            for (const c of frontier) {
              if (!st.commits[c] || keep.has(c)) continue;
              keep.add(c);
              if (d === depth && st.commits[c].parents.length) shallow.push(c);
              else next.push(...st.commits[c].parents);
            }
            frontier = next;
          }
        }
        const branch = input.ref.startsWith('refs/heads/') ? input.ref.slice(11) : null;
        const commits: GitState['commits'] = {};
        for (const c of keep) commits[c] = st.commits[c];
        const tags: Record<string, string> = {};
        if (depth === 0) for (const [t, id] of Object.entries(st.tags)) if (keep.has(id)) tags[t] = id;
        const gs: GitState = {
          head: branch ? { branch } : { detached: input.sha },
          branches: branch ? { [branch]: input.sha } : {},
          commits,
          index: { ...input.files },
          config: {},
          tags,
          remotes: { origin: { url: `${input.serverUrl}/${input.repo}` } },
          remoteRefs: branch ? { [`origin/${branch}`]: input.sha } : {},
          upstream: branch ? { [branch]: { remote: 'origin', merge: branch } } : {},
          ...(shallow.length ? { shallow } : {}),
          ...(input.exec.length ? { x: [...input.exec] } : {}),
          annotated: depth === 0 ? st.annotated : undefined,
        };
        writeBoxFile(box, `${dest}/.git/state.json`, JSON.stringify(gs));
        writeBoxFile(box, `${dest}/.git/HEAD`, branch ? `ref: refs/heads/${branch}\n` : input.sha + '\n');
        mkdir(box.fs, `${dest}/.git/objects`, { user: 'root', groups: ['root'] }, box.now, true);
        out(`Fetching the repository`);
        out(`[command]/usr/bin/git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules${depth ? ` --depth=${depth}` : ''} origin +${input.sha}:${input.ref}`);
        out(branch ? `[command]/usr/bin/git checkout --progress --force -B ${branch} refs/remotes/origin/${branch}` : `[command]/usr/bin/git checkout --progress --force ${input.sha}`);
      }
      return 0;
    }
    case 'actions/setup-python':
    case 'actions/setup-node':
    case 'actions/setup-java':
    case 'actions/setup-go':
    case 'actions/setup-dotnet': {
      const lang = name.split('-')[1];
      const v = w[`${lang}-version`] ?? w['python-version'] ?? w['node-version'] ?? w['java-version'] ?? w['go-version'] ?? 'latest';
      out(`Successfully set up ${lang} (${v})`);
      out(`Note: this simulator's runner has no ${lang} interpreter; run shell, make, bats or docker steps instead.`);
      return 0;
    }
    case 'actions/cache':
    case 'actions/cache/restore':
    case 'actions/cache/save': {
      const key = w.key;
      if (!key) {
        out('Error: Input required and not supplied: key');
        return 1;
      }
      const paths = (w.path ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
      const restoreKeys = (w['restore-keys'] ?? '').split('\n').map((p) => p.trim()).filter(Boolean);
      const resolve = (p: string) => (p.startsWith('~') ? '/home/runner' + p.slice(1) : p.startsWith('/') ? p : `${workspace}/${p}`);
      let hitKey: string | undefined;
      if (name !== 'actions/cache/save') {
        hitKey = input.cache[key] ? key : restoreKeys.map((rk) => Object.keys(input.cache).filter((k) => k.startsWith(rk)).sort().pop()).find(Boolean);
        if (hitKey) {
          for (const [p, c] of Object.entries(input.cache[hitKey])) writeBoxFile(box, p, c);
          out(`Cache restored from key: ${hitKey}`);
        } else out(`Cache not found for input keys: ${[key, ...restoreKeys].join(', ')}`);
      }
      if (name !== 'actions/cache/restore' && hitKey !== key) {
        post.push(() => {
          const saved: Record<string, string> = {};
          for (const p of paths) for (const [rel, c] of Object.entries(boxFiles(box, resolve(p)))) saved[`${resolve(p)}/${rel}`.replace(/\/[^/]+$/, (m) => (rel.includes('/') || boxFiles(box, resolve(p))[rel] !== undefined ? m : m))] = c;
          if (Object.keys(saved).length) {
            input.cache[key] = saved;
            job.steps.push({ number: job.steps.length + 1, name: `Post ${step.name}`, conclusion: 'success', seconds: 1, log: [`Cache saved with key: ${key}`] });
          }
        });
      }
      return 0;
    }
    case 'actions/upload-artifact': {
      const nm = w.name ?? 'artifact';
      const files: Record<string, string> = {};
      for (const p of (w.path ?? '').split('\n').map((x) => x.trim()).filter(Boolean)) {
        const abs = p.startsWith('/') ? p : `${workspace}/${p.replace(/^\.\//, '')}`;
        const l = lookup(box.fs, abs, { user: 'root', groups: ['root'] });
        if (l?.node.type === 'file') files[p.split('/').pop()!] = l.node.content;
        else if (l?.node.type === 'dir') Object.assign(files, boxFiles(box, abs));
        else for (const hit of globIn(boxFiles(box, workspace), p)) files[hit.split('/').pop()!] = boxFiles(box, workspace)[hit];
      }
      if (!Object.keys(files).length) {
        const mode = w['if-no-files-found'] ?? 'warn';
        out(`${mode === 'error' ? 'Error' : 'Warning'}: No files were found with the provided path: ${w.path ?? ''}. No artifacts will be uploaded.`);
        return mode === 'error' ? 1 : 0;
      }
      if (run.artifacts.some((a) => a.name === nm)) {
        out(`Error: Failed to CreateArtifact: Received non-retryable error: Failed request: (409) Conflict: an artifact with this name already exists on the workflow run`);
        return 1;
      }
      run.artifacts.push({ name: nm, files });
      out(`With the provided path, there will be ${Object.keys(files).length} file${Object.keys(files).length === 1 ? '' : 's'} uploaded`);
      out(`Artifact ${nm} has been successfully uploaded! Final size is ${Object.values(files).reduce((s, c) => s + c.length, 0)} bytes.`);
      return 0;
    }
    case 'actions/download-artifact': {
      const wanted = w.name ? run.artifacts.filter((a) => a.name === w.name) : run.artifacts;
      if (!wanted.length) {
        out(`Error: Unable to download artifact(s): Artifact not found for name: ${w.name ?? '(all)'}`);
        return 1;
      }
      for (const a of wanted) {
        const dir = w.path ? (w.path.startsWith('/') ? w.path : `${workspace}/${w.path}`) : w.name ? workspace : `${workspace}/${a.name}`;
        for (const [p, c] of Object.entries(a.files)) writeBoxFile(box, `${dir}/${p}`, c);
        out(`Artifact download completed successfully: ${a.name}`);
      }
      return 0;
    }
    case 'actions/github-script':
      out('Error: actions/github-script runs JavaScript, which this simulator does not run; use a run: step with gh or curl.');
      return 1;
  }
  out(`Error: Unable to resolve action \`${uses}\`, this simulator runs the actions/checkout, setup-*, cache, upload-artifact and download-artifact actions; use run: steps for anything else.`);
  void version;
  void env;
  return 1;
}

/* ----------------------------------------------------------------------------- text output */

export const mark = (c: string | null, status?: string) => (status === 'waiting' ? '*' : status === 'pending' ? '-' : c === 'success' ? '✓' : c === 'failure' ? 'X' : c === 'skipped' ? '-' : c === 'cancelled' ? '!' : '*');

export function runLogText(run: CiRun, onlyFailed = false): string {
  const lines: string[] = [];
  for (const j of run.jobs) {
    if (onlyFailed && j.conclusion !== 'failure') continue;
    for (const s of j.steps) {
      if (onlyFailed && s.conclusion !== 'failure') continue;
      if (s.conclusion === 'skipped') continue;
      for (const l of s.log.length ? s.log : ['']) lines.push(`${j.name}\t${s.name}\t${l}`);
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

export { evalExpr as ciEval, interpolate as ciInterpolate, ExprError };
