/**
 * The PowerShell host for Windows labs: values, the session environment, Windows paths, the
 * cmdlet registry, output formatting and the entry points. The language itself (parser and
 * evaluator) lives in parse.ts and lang.ts.
 *
 * Cmdlets and native tools (ipconfig, gpresult, dcdiag ...) are registered by the cmdlet modules.
 */

import { lookup, type DirNode } from '../fs.js';
import type { ShellSystem } from '../system.js';
import { driveRoot, loadAd, loadEstate, saveAd, saveEstate, type AdState, type Estate, type Machine } from './model.js';
import { binaryOp, errorText, evalCollect, evalCondition, ExitEx, expandText, formatDate, getVariable, globalScope, makeCx as langMakeCx, RuntimeErr, runSource, setVariable, str as langStr, type Scope } from './lang.js';
import { needsMore } from './parse.js';

/* ----------------------------------------------------------------------------- values */

export type Obj = Record<string, unknown> & { __type?: string };
export type Value = unknown;

export class PsError extends Error {
  constructor(
    public cmd: string,
    message: string,
    /** Exception type for catch [Type] (defaults to one guessed from the message). */
    public type?: string,
    /** True for errors that end the statement even without -ErrorAction Stop. */
    public terminating?: boolean,
  ) {
    super(message);
  }
}

export const SECURE = '__secure';
export interface Secure {
  [SECURE]: true;
  plain: string;
}
export const isSecure = (v: unknown): v is Secure => !!v && typeof v === 'object' && SECURE in (v as object);
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !isSecure(v);

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));

export function show(v: Value): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return fmtNum(v);
  if (isSecure(v)) return 'System.Security.SecureString';
  if (Array.isArray(v)) return v.map(show).join(' ');
  if (typeof v === 'object') {
    const o = v as Obj;
    if (o.__type === 'csv' || o.__type === 'hashtable' || o.__type === 'psobject') return `@{${Object.entries(o).filter(([k]) => !k.startsWith('__')).map(([k, x]) => `${k}=${show(x)}`).join('; ')}}`;
    if (o.__type === 'block') return String(o.src);
    if (o.__type === 'datetime') return formatDate(Number(o.__ms), 'dd/MM/yyyy HH:mm:ss');
    if (o.__type === 'timespan' || o.__type === 'version' || o.__type === 'guid' || o.__type === 'type' || o.__type === 'error' || o.__type === 'exception') return langStr(o);
    if (o.__type === 'pathinfo') return String(o.Path);
    return String(o.Name ?? o.DistinguishedName ?? o.Path ?? o.Value ?? '[object]');
  }
  return String(v);
}

export function prop(v: Value, name: string): Value {
  if (Array.isArray(v)) {
    if (name.toLowerCase() === 'count' || name.toLowerCase() === 'length') return v.length;
    return v.map((x) => prop(x, name));
  }
  if (typeof v === 'string' && name.toLowerCase() === 'length') return v.length;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Obj;
  const n = name.toLowerCase();
  const key = Object.keys(o).find((k) => k.toLowerCase() === n && !k.startsWith('__'));
  if (key) return o[key];
  // Extra properties that objects carry but do not display by default.
  if (o.__extra && typeof o.__extra === 'object') {
    const extra = o.__extra as Obj;
    const k2 = Object.keys(extra).find((k) => k.toLowerCase() === n);
    if (k2) return extra[k2];
  }
  return undefined;
}

export const asList = (v: Value): Value[] => (v === undefined || v === null ? (v === null ? [] : []) : Array.isArray(v) ? v : [v]);
export const str = (v: Value) => (v === undefined || v === null ? '' : show(v));
export const bool = (v: Value) => v === true || /^(\$?true|1|yes)$/i.test(str(v));
export const num = (v: Value) => {
  const s = str(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i.exec(s);
  if (!m) return Number(s);
  const unit = (m[2] ?? '').toUpperCase();
  return Number(m[1]) * (unit === 'KB' ? 1 / 1024 : unit === 'MB' ? 1 : unit === 'GB' ? 1024 : unit === 'TB' ? 1024 * 1024 : 1);
};

/* ----------------------------------------------------------------------------- environment */

export interface Env {
  sys: ShellSystem;
  vars: Map<string, Value>;
  out: string[];
  st: AdState;
  est: Estate;
  dirtyAd: boolean;
  dirtyEst: boolean;
  depth: number;
  /** The current variable scope (its root is `vars`). */
  scope?: Scope;
  /** Depth of enclosing try blocks: terminating errors propagate to them. */
  tryDepth?: number;
  /** $? for the last command. */
  ok?: boolean;
  /** Writes output still waiting to be formatted, before host text. */
  flush?: () => void;
  /** The object whose properties barewords name (in -Filter conditions). */
  filterSubject?: Value;
  /** Pester mocks by command name. */
  mocks?: Map<string, Obj>;
  callDepth?: number;
  /** The script file running (Windows path), for error positions and $PSScriptRoot. */
  scriptPath?: string;
  line?: number;
}

export function machine(env: Env): Machine {
  return env.est.machines.find((m) => m.name.toLowerCase() === env.est.current.toLowerCase()) ?? env.est.machines[0];
}

export function machineByName(env: Env, name: string): Machine | undefined {
  const n = name.toLowerCase().replace(/\..*$/, '');
  return env.est.machines.find((m) => m.name.toLowerCase() === n);
}

/** Windows path (C:\x, .\x, \\SERVER\share\x, ~) → VFS path. */
/** Extra UNC resolvers (DFS namespaces, SYSVOL): return a VFS path or null. */
export const UNC_RESOLVERS: Array<(env: Env, server: string, share: string, rest: string) => string | null> = [];

export function toVfs(env: Env, p: string): string {
  const s = p.trim().replace(/^["']|["']$/g, '').replace(/^Microsoft\.PowerShell\.Core\\FileSystem::/i, '');
  const unc = /^\\\\([^\\]+)\\([^\\]+)(\\.*)?$/.exec(s);
  if (unc) {
    for (const r of UNC_RESOLVERS) {
      const hit = r(env, unc[1], unc[2], unc[3] ?? '');
      if (hit) return hit;
    }
    const m = machineByName(env, unc[1]);
    const share = m?.shares.find((x) => x.name.toLowerCase() === unc[2].toLowerCase());
    if (m && share) return toVfsOn(env, m.name, share.path + (unc[3] ?? ''));
    if (m && /^[a-z]\$$/i.test(unc[2])) return toVfsOn(env, m.name, `${unc[2][0]}:${unc[3] ?? '\\'}`);
    return `/unc/${unc[1].toLowerCase()}/${unc[2].toLowerCase()}${(unc[3] ?? '').replace(/\\/g, '/')}`;
  }
  return toVfsOn(env, machine(env).name, s);
}

export function toVfsOn(env: Env, machineName: string, p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = `C:/Users/${env.sys.user}` + s.slice(1);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(s);
  if (drive) s = driveRoot(env.est, machineName, drive[1]) + (drive[2] ?? '');
  else if (!s.startsWith('/')) s = `${env.sys.cwd === '/' ? '' : env.sys.cwd}/${s}`;
  const out: string[] = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

/** VFS path → Windows path on its machine. */
export function toWin(p: string): string {
  const remote = /^\/m\/[^/]+\/([a-z])(\/.*)?$/.exec(p);
  if (remote) return `${remote[1].toUpperCase()}:${(remote[2] ?? '\\').replace(/\//g, '\\')}`;
  const m = /^\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '\\').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
}

/** Canonical Windows path for comparing and storing (C:\Shares\Finance, no trailing slash). */
export function normWin(p: string): string {
  const s = p.trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\').replace(/\\+$/, '');
  const m = /^([a-z]):/i.exec(s);
  return m ? m[1].toUpperCase() + s.slice(1) : s;
}

/** Splits native-command arguments on whitespace, keeping quoted parts together. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/* ----------------------------------------------------------------------------- registry */

export interface Call {
  name: string;
  positional: Value[];
  params: Record<string, Value>;
  block?: string;
  /** The script block value behind `block` (keeps its source line). */
  blockValue?: Value;
}

export interface Cx {
  env: Env;
  call: Call;
  name: string;
  P: Record<string, Value>;
  pos: Value[];
  input: Value[] | undefined;
  fail: (msg: string) => never;
  /** Runs PowerShell source with optional extra variables, returning its output objects. */
  run: (src: string, vars?: Record<string, Value>) => Value[];
  print: (text: string) => void;
}

export type Cmdlet = (cx: Cx) => Value[];
export type Native = (args: string[], cx: Cx) => Value[];

export const CMDLET_TABLE: Record<string, Cmdlet> = {};
export const NATIVE_TABLE: Record<string, Native> = {};
export const ALIASES: Record<string, string> = {};
export const SWITCHES = new Set(['asplaintext', 'force', 'recurse', 'reset', 'passthru', 'whatif', 'all', 'noclobber', 'notypeinformation', 'includemanagementtools', 'includeallsubfeature', 'useMaximumSize'.toLowerCase(), 'confirm', 'enforced', 'descending', 'unique', 'detailed', 'includedeletedobjects', 'restart', 'wait', 'informationlevel', 'simplematch', 'quiet', 'list', 'raw']);
export const HELP: Record<string, string> = {};

export function register(table: Record<string, Cmdlet>, help: Record<string, string> = {}, aliases: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(table)) CMDLET_TABLE[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(help)) HELP[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(aliases)) ALIASES[k.toLowerCase()] = v.toLowerCase();
}

export function registerNative(table: Record<string, Native>): void {
  for (const [k, v] of Object.entries(table)) NATIVE_TABLE[k.toLowerCase()] = v;
}

/** Real capitalisation of cmdlet names (Get-ChildItem), registered by modules; other names get a guess. */
export const CANONICAL: Record<string, string> = {};
export const NAMING = { display: (k: string) => k.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase()) };

export function canonical(names: string[]): void {
  for (const n of names) CANONICAL[n.toLowerCase()] = n;
}

export function cmdletNames(): string[] {
  return Object.keys(CMDLET_TABLE).filter((k) => !k.startsWith('__') && !k.includes('-cert-') && !k.endsWith('-lab')).map((k) => CANONICAL[k] ?? NAMING.display(k));
}

/* ----------------------------------------------------------------------------- evaluation (see lang.ts) */

export function getVar(env: Env, name: string, props: string[] = [], index?: number): Value {
  let v = getVariable(env, name.replace(/^env:/i, ''), /^env:/i.test(name) ? 'env' : undefined);
  if (index !== undefined) v = asList(v)[index];
  for (const p of props) v = prop(v, p);
  return v;
}

export function expandString(env: Env, s: string): string {
  return expandText(env, s);
}

/** Evaluates source and returns the objects it outputs. */
export function evalSource(env: Env, src: string): Value[] {
  return evalCollect(env, src);
}

export function compare(op: string, a: Value, b: Value): boolean {
  return Boolean(binaryOp({} as Env, op, a, b));
}

/**
 * Evaluates a condition. Operands: $_.Prop (the subject), bare Prop names when `bare` (for -Filter),
 * literals, $variables and (subexpressions).
 */
export function condition(env: Env, src: string, subject: Value, bare: boolean): boolean {
  return evalCondition(env, src, subject, bare);
}

export function invoke(env: Env, call: Call, input: Value[] | undefined): Value[] {
  const fn = CMDLET_TABLE[ALIASES[call.name.toLowerCase()] ?? call.name.toLowerCase()];
  if (!fn) throw new PsError(call.name, `The term '${call.name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or use Get-Command to see what this server has.`);
  return fn(langMakeCx(env, call, input));
}

/* ----------------------------------------------------------------------------- rendering */

const fmtCell = (v: Value): string => {
  if (Array.isArray(v)) return `{${v.map((x) => (isObj(x) && (x as Obj).__type === 'datetime' ? show(x) : show(x))).join(', ')}}`;
  return show(v);
};

const visibleKeys = (o: Obj) => Object.keys(o).filter((k) => !k.startsWith('__'));

function formatList(objs: Obj[]): string {
  return objs
    .map((o) => {
      const keys = visibleKeys(o);
      const w = Math.max(...keys.map((k) => k.length));
      return keys.map((k) => `${k.padEnd(w)} : ${fmtCell(o[k])}`).join('\n');
    })
    .join('\n\n');
}

function formatTable(objs: Obj[]): string {
  const keys = [...new Set(objs.flatMap((o) => visibleKeys(o)))];
  const widths = keys.map((k) => Math.max(k.length, ...objs.map((o) => fmtCell(o[k]).length)));
  const numeric = keys.map((k) => objs.every((o) => typeof o[k] === 'number' || o[k] === undefined || o[k] === null) && objs.some((o) => typeof o[k] === 'number'));
  const line = (cells: string[], header = false) => cells.map((c, i) => (numeric[i] && !header ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join(' ').trimEnd();
  return [line(keys.map((k, i) => (numeric[i] ? k.padStart(widths[i]) : k)), true), line(widths.map((w, i) => (numeric[i] ? '-'.repeat(keys[i].length).padStart(w) : '-'.repeat(keys[i].length).padEnd(w))), true), ...objs.map((o) => line(keys.map((k) => fmtCell(o[k]))))].join('\n');
}

/** Hashtables print as Name/Value rows, as PowerShell's default view does. */
function formatHash(objs: Obj[]): string {
  const rows = objs.flatMap((o) => visibleKeys(o).map((k) => [k, fmtCell(o[k])]));
  const w = Math.max(30, ...rows.map(([k]) => k.length));
  return [`${'Name'.padEnd(w)} Value`, `${'----'.padEnd(w)} -----`, ...rows.map(([k, v]) => `${k.padEnd(w)} ${v}`.trimEnd())].join('\n');
}

export const TABLE_TYPES = new Set(['file', 'share', 'access', 'member', 'cmd', 'select', 'feature', 'disk', 'volume', 'service', 'process', 'event', 'rule', 'printer', 'job', 'scope', 'lease', 'record', 'zone', 'gpo-link', 'vm', 'task', 'counter', 'ip', 'measure', 'quota', 'screen', 'policy-row', 'reservation', 'option', 'groupinfo', 'matchinfo-table', 'getmember', 'analyzer', 'module', 'hash-table']);

/** Values that print as plain lines rather than tables. */
const SCALAR_TYPES = new Set(['datetime', 'timespan', 'version', 'guid', 'type', 'error', 'exception', 'block', 'pathinfo', 'matchinfo']);

function scalarText(v: Value): string {
  if (isObj(v)) {
    const o = v as Obj;
    if (o.__type === 'datetime') return '\n' + formatDate(Number(o.__ms), 'dddd, dd MMMM yyyy HH:mm:ss') + '\n';
    if (o.__type === 'timespan') {
      const ms = Number(o.__ms);
      return `\nDays              : ${Math.trunc(ms / 86400000)}\nHours             : ${Math.trunc(ms / 3600000) % 24}\nMinutes           : ${Math.trunc(ms / 60000) % 60}\nSeconds           : ${Math.trunc(ms / 1000) % 60}\nMilliseconds      : ${ms % 1000}\nTotalDays         : ${fmtNum(ms / 86400000)}\nTotalHours        : ${fmtNum(ms / 3600000)}\nTotalMinutes      : ${fmtNum(ms / 60000)}\nTotalSeconds      : ${fmtNum(ms / 1000)}\n`;
    }
    if (o.__type === 'version') return `\nMajor  Minor  Build  Revision\n-----  -----  -----  --------\n${String(o.Major).padEnd(6)} ${String(o.Minor).padEnd(6)} ${String(o.Build).padEnd(6)} ${o.Revision}\n`;
    if (o.__type === 'type') return `\nIsPublic IsSerial Name                                     BaseType\n-------- -------- ----                                     --------\nTrue     True     ${String(o.Name).padEnd(40)} System.Object\n`;
    if (o.__type === 'matchinfo') return String(o.__display ?? o.Line);
    if (o.__type === 'error') return langStr(o);
  }
  return show(v);
}

export function render(values: Value[], forceTable = false, forceList = false): string {
  if (!values.length) return '';
  // Group runs of objects of the same kind; scalars print as lines in between.
  const parts: string[] = [];
  let i = 0;
  let anyObj = false;
  while (i < values.length) {
    const v = values[i];
    if (!isObj(v) || SCALAR_TYPES.has(String((v as Obj).__type))) {
      const lines: string[] = [];
      while (i < values.length && (!isObj(values[i]) || SCALAR_TYPES.has(String((values[i] as Obj).__type)))) lines.push(scalarText(values[i++]));
      parts.push(lines.join('\n').replace(/\n\n+/g, '\n\n'));
      continue;
    }
    const kind = String((v as Obj).__type);
    const run: Obj[] = [];
    while (i < values.length && isObj(values[i]) && !SCALAR_TYPES.has(String((values[i] as Obj).__type)) && String((values[i] as Obj).__type) === kind) run.push(values[i++] as Obj);
    anyObj = true;
    if (kind === 'hashtable') parts.push(formatHash(run));
    else if (kind === 'getmember') {
      const byType = new Map<string, Obj[]>();
      for (const o of run) byType.set(String(o.__typename), [...(byType.get(String(o.__typename)) ?? []), o]);
      parts.push([...byType].map(([t, list]) => `   TypeName: ${t}\n\n${formatTable(list)}`).join('\n\n'));
    }
    else {
      const nKeys = visibleKeys(run[0]).length;
      parts.push(forceTable || (!forceList && (nKeys <= 4 || TABLE_TYPES.has(kind))) ? formatTable(run) : formatList(run));
    }
  }
  return (anyObj ? '\n' : '') + parts.join(anyObj ? '\n\n' : '\n') + '\n' + (anyObj ? '\n' : '');
}

/* ----------------------------------------------------------------------------- entry points */

const SESSIONS = new WeakMap<object, Map<string, Value>>();

/** True while braces, parentheses or quotes are still open, so the terminal keeps reading lines. */
export function psAwaitsMore(src: string): boolean {
  return needsMore(src);
}

export function makeEnv(sys: ShellSystem, session: object): Env {
  let vars = SESSIONS.get(session);
  if (!vars) {
    vars = new Map();
    SESSIONS.set(session, vars);
  }
  const env: Env = { sys, vars, out: [], st: loadAd(sys), est: loadEstate(sys), dirtyAd: false, dirtyEst: false, depth: 0 };
  globalScope(env);
  return env;
}

export function commit(env: Env): void {
  if (env.dirtyAd) saveAd(env.sys, env.st);
  if (env.dirtyEst) saveEstate(env.sys, env.est);
}

/** Runs PowerShell (one line or a pasted script). `session` keeps variables and functions between lines. */
export function runPowerShell(sys: ShellSystem, line: string, session: object, record = true): { output: string; status: number; clear: boolean } {
  if (record && line.trim()) sys.history.push(line);
  const env = makeEnv(sys, session);
  let pending: Value[] = [];
  env.flush = () => {
    if (!pending.length) return;
    const text = render(pending);
    pending = [];
    env.out.push(text);
    const t = env.vars.get('__transcript');
    if (typeof t === 'string' && t) appendTranscript(env, t, text);
  };
  let status = 0;
  try {
    runSource(env, line, (v) => pending.push(v));
    env.flush();
    if (env.ok === false) status = 1;
  } catch (e) {
    env.flush();
    if (e instanceof RuntimeErr) {
      env.out.push(errorText(e.record));
      status = 1;
    } else if (e instanceof ExitEx) status = e.code;
    else if (e instanceof PsError) {
      env.out.push(`${e.cmd ? e.cmd + ' : ' : ''}${e.message}\n`);
      status = 1;
    } else throw e;
  }
  commit(env);
  const text = env.out.join('');
  return { output: text.replace(/\u001bc/g, '').replace(/^\n+/, '\n'), status, clear: text.includes('\u001bc') };
}

function appendTranscript(env: Env, vfs: string, text: string): void {
  const l = lookup(env.sys.fs, vfs, { user: 'root', groups: ['root'] });
  if (l && l.node.type === 'file') l.node.content += text;
}

export function promptPowerShell(sys: ShellSystem): string {
  const est = loadEstate(sys);
  const first = est.machines[0]?.name;
  const remote = est.current && first && est.current.toLowerCase() !== first.toLowerCase();
  return `${remote ? `[${est.current}]: ` : ''}PS ${toWin(sys.cwd)}> `;
}

/** Exists so callers can tell a path is a directory without importing fs helpers. */
export function isDir(fs: DirNode, path: string): boolean {
  const l = lookup(fs, path, { user: 'root', groups: ['root'] });
  return !!l && l.node.type === 'dir';
}

/**
 * Runs a read-only query for a check: on `machineName` (default: the first machine), without
 * saving anything, recording history or moving the learner's session. Returns the rendered output,
 * or "ERROR: ..." when the query fails. Errors are terminating here ($ErrorActionPreference = Stop).
 */
export function psQuery(sys: ShellSystem, script: string, machineName?: string): string {
  const env = makeEnv(sys, {});
  const target = machineName ? machineByName(env, machineName)?.name : env.est.machines[0]?.name;
  if (!target) return `ERROR: there is no machine called ${machineName}.`;
  env.est.current = target;
  setVariable(env, 'ErrorActionPreference', 'Stop');
  const savedCwd = sys.cwd;
  sys.cwd = driveRoot(env.est, target) + '/Users/Administrator';
  try {
    const out: Value[] = [];
    env.tryDepth = 1;
    runSource(env, script, (v) => out.push(v));
    return render(out).trim();
  } catch (e) {
    if (e instanceof RuntimeErr) return `ERROR: ${String((e.record.Exception as Obj).Message)}`;
    if (e instanceof PsError) return `ERROR: ${e.message}`;
    if (e instanceof ExitEx) return '';
    throw e;
  } finally {
    sys.cwd = savedCwd;
  }
}

export { getVariable };
