/**
 * The PowerShell interpreter for Windows labs.
 *
 * Statements separated by ; or newlines; pipelines with |; $variables, $_.Property and
 * (subexpression).Property; assignment; "double quotes" expanding $name and $(expression);
 * 'single quotes'; comma arrays; @(...) arrays and @{ Key = value } hashtables; { script blocks };
 * foreach ($x in ...) { }, if / elseif / else; conditions with -eq -ne -like -notlike -match -gt
 * -ge -lt -le -contains -in -and -or -not; .\script.ps1 files.
 *
 * Cmdlets and native tools (ipconfig, gpresult, dcdiag ...) are registered by the cmdlet modules.
 */

import { lookup, readFile, type DirNode } from '../fs.js';
import type { ShellSystem } from '../system.js';
import { driveRoot, loadAd, loadEstate, saveAd, saveEstate, type AdState, type Estate, type Machine } from './model.js';

/* ----------------------------------------------------------------------------- values */

export type Obj = Record<string, unknown> & { __type?: string };
export type Value = unknown;

export class PsError extends Error {
  constructor(
    public cmd: string,
    message: string,
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

export function show(v: Value): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return '';
  if (isSecure(v)) return 'System.Security.SecureString';
  if (Array.isArray(v)) return v.map(show).join(' ');
  if (typeof v === 'object') {
    const o = v as Obj;
    if (o.__type === 'csv' || o.__type === 'hashtable') return `@{${Object.entries(o).filter(([k]) => k !== '__type').map(([k, x]) => `${k}=${show(x)}`).join('; ')}}`;
    if (o.__type === 'block') return String(o.src);
    return String(o.Name ?? o.DistinguishedName ?? o.Path ?? '[object]');
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
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? o[key] : undefined;
}

export const asList = (v: Value): Value[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
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
  const s = p.trim().replace(/^["']|["']$/g, '');
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

/* ----------------------------------------------------------------------------- tokens */

export type Tok =
  | { k: 'str'; v: string; expand: boolean }
  | { k: 'num'; v: number }
  | { k: 'var'; name: string; props: string[]; index?: number }
  | { k: 'param'; name: string; value?: string }
  | { k: 'word'; v: string }
  | { k: 'pipe' }
  | { k: 'semi' }
  | { k: 'comma' }
  | { k: 'assign'; op: '=' | '+=' }
  | { k: 'sub'; src: string; props: string[]; array?: boolean }
  | { k: 'hash'; src: string }
  | { k: 'block'; src: string };

export function readBalanced(src: string, i: number, open: string, close: string): [string, number] {
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return [src.slice(i + 1, j), j + 1];
    }
  }
  throw new PsError('', `Missing closing '${close}' in statement block or expression.`);
}

function readProps(src: string, i: number): [string[], number] {
  const m = /^((?:\.[A-Za-z_]\w*)*)/.exec(src.slice(i));
  return m && m[1] ? [m[1].slice(1).split('.'), i + m[1].length] : [[], i];
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '`' && src[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n' || c === ';') {
      toks.push({ k: 'semi' });
      i++;
      continue;
    }
    if (c === '|') {
      toks.push({ k: 'pipe' });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ k: 'comma' });
      i++;
      continue;
    }
    if (c === '+' && src[i + 1] === '=') {
      toks.push({ k: 'assign', op: '+=' });
      i += 2;
      continue;
    }
    if (c === '=' && src[i + 1] !== '=') {
      toks.push({ k: 'assign', op: '=' });
      i++;
      continue;
    }
    if (c === '@' && src[i + 1] === '{') {
      const [inner, end] = readBalanced(src, i + 1, '{', '}');
      toks.push({ k: 'hash', src: inner });
      i = end;
      continue;
    }
    if (c === '@' && src[i + 1] === '(') {
      const [inner, end] = readBalanced(src, i + 1, '(', ')');
      const [props, j] = readProps(src, end);
      toks.push({ k: 'sub', src: inner, props, array: true });
      i = j;
      continue;
    }
    if (c === '{') {
      const [inner, end] = readBalanced(src, i, '{', '}');
      toks.push({ k: 'block', src: inner });
      i = end;
      continue;
    }
    if (c === '(') {
      const [inner, end] = readBalanced(src, i, '(', ')');
      const [props, j] = readProps(src, end);
      toks.push({ k: 'sub', src: inner, props });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (; j < src.length; j++) {
        if (src[j] === "'" && src[j + 1] === "'") {
          s += "'";
          j++;
        } else if (src[j] === "'") break;
        else s += src[j];
      }
      if (j >= src.length) throw new PsError('', "The string is missing the terminator: '.");
      toks.push({ k: 'str', v: s, expand: false });
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (; j < src.length; j++) {
        if (src[j] === '`' && j + 1 < src.length) {
          s += src[j] + src[j + 1];
          j++;
        } else if (src[j] === '$' && src[j + 1] === '(') {
          const [inner, end] = readBalanced(src, j + 1, '(', ')');
          s += `$(${inner})`;
          j = end - 1;
        } else if (src[j] === '"') break;
        else s += src[j];
      }
      if (j >= src.length) throw new PsError('', 'The string is missing the terminator: ".');
      toks.push({ k: 'str', v: s, expand: true });
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$(?:env:)?([A-Za-z_][\w]*|_)((?:\.[A-Za-z_]\w*)*)(?:\[(\d+)\])?/.exec(src.slice(i));
      if (!m) throw new PsError('', `Unexpected '$' at position ${i + 1}.`);
      const isEnv = src.slice(i, i + 5).toLowerCase() === '$env:';
      toks.push({ k: 'var', name: isEnv ? `env:${m[1]}` : m[1], props: m[2] ? m[2].slice(1).split('.') : [], ...(m[3] !== undefined ? { index: Number(m[3]) } : {}) });
      i += m[0].length;
      continue;
    }
    if (c === '-' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      const m = /^-([A-Za-z][\w]*)(?::(\S+))?/.exec(src.slice(i))!;
      toks.push({ k: 'param', name: m[1], ...(m[2] !== undefined ? { value: m[2] } : {}) });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c) && /^\d+(\.\d+)?(KB|MB|GB|TB)?(?=[\s;|,)}\]]|$)/i.test(src.slice(i))) {
      const m = /^\d+(\.\d+)?(KB|MB|GB|TB)?/i.exec(src.slice(i))!;
      if (m[2]) toks.push({ k: 'word', v: m[0] });
      else toks.push({ k: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s;|,(){}]/.test(src[j]) && !(src[j] === '=' && j > i && src[j + 1] !== '=')) j++;
    if (j === i) j = i + 1;
    toks.push({ k: 'word', v: src.slice(i, j) });
    i = j;
  }
  return toks;
}

/** Splits source into top-level statements (on ; and newlines outside quotes, braces and parentheses). */
export function splitStatements(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (c === '`' && src[i + 1] === '\n') {
      i++;
      continue;
    }
    if (depth === 0 && (c === ';' || c === '\n')) {
      // A newline before "else" or "elseif" continues an if statement.
      if (c === '\n' && /^\s*(else|elseif)\b/i.test(src.slice(i + 1))) {
        cur += ' ';
        continue;
      }
      if (cur.trim()) out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Splits a statement at top-level pipes. */
function splitPipes(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const c of src) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    if (depth === 0 && c === '|') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
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

export function cmdletNames(): string[] {
  return Object.keys(CMDLET_TABLE).map((k) => k.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase()).replace(/Ad([A-Z])/g, 'AD$1').replace(/Gp([A-Z])/g, 'GP$1').replace(/Smb/g, 'Smb').replace(/Dns/g, 'Dns'));
}

/* ----------------------------------------------------------------------------- evaluation */

export function getVar(env: Env, name: string, props: string[], index?: number): Value {
  let v: Value;
  const n = name.toLowerCase();
  if (n === 'true') v = true;
  else if (n === 'false') v = false;
  else if (n === 'null') v = null;
  else if (n.startsWith('env:')) v = n === 'env:computername' ? machine(env).name : n === 'env:username' ? env.sys.user : n === 'env:userdomain' ? env.st.netbios : null;
  else v = env.vars.has(n) ? env.vars.get(n) : null;
  if (index !== undefined) v = asList(v)[index];
  for (const p of props) v = prop(v, p);
  return v;
}

export function expandString(env: Env, s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`' && i + 1 < s.length) {
      const n = s[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (s[i] === '$' && s[i + 1] === '(') {
      const [inner, end] = readBalanced(s, i + 1, '(', ')');
      out += show(single(evalSource(env, inner)));
      i = end - 1;
    } else if (s[i] === '$') {
      const m = /^\$(?:env:)?([A-Za-z_]\w*|_)/.exec(s.slice(i));
      if (!m) {
        out += '$';
        continue;
      }
      const isEnv = s.slice(i, i + 5).toLowerCase() === '$env:';
      out += show(getVar(env, isEnv ? `env:${m[1]}` : m[1], []));
      i += m[0].length - 1;
    } else out += s[i];
  }
  return out;
}

const single = (vals: Value[]): Value => (vals.length === 1 ? vals[0] : vals);

function parseHash(env: Env, src: string): Obj {
  const o: Obj = { __type: 'hashtable' };
  for (const part of splitStatements(src)) {
    const m = /^\s*['"]?([A-Za-z_][\w ]*?)['"]?\s*=\s*([\s\S]*)$/.exec(part);
    if (!m) throw new PsError('', `Missing '=' operator after key in hash literal: ${part.trim()}`);
    o[m[1].trim()] = single(evalSource(env, m[2]));
  }
  return o;
}

export function valueOf(env: Env, t: Tok): Value {
  switch (t.k) {
    case 'str':
      return t.expand ? expandString(env, t.v) : t.v;
    case 'num':
      return t.v;
    case 'var':
      return getVar(env, t.name, t.props, t.index);
    case 'word':
      return t.v;
    case 'sub': {
      const vals = evalSource(env, t.src);
      let v: Value = t.array ? vals : single(vals);
      for (const p of t.props) v = prop(v, p);
      return v;
    }
    case 'hash':
      return parseHash(env, t.src);
    case 'block':
      return { __type: 'block', src: t.src };
    default:
      return undefined;
  }
}

function readValue(env: Env, toks: Tok[], i: number): [Value, number] {
  const items: Value[] = [valueOf(env, toks[i])];
  let j = i + 1;
  while (toks[j]?.k === 'comma' && toks[j + 1] && !['pipe', 'semi', 'param'].includes(toks[j + 1].k)) {
    items.push(valueOf(env, toks[j + 1]));
    j += 2;
  }
  return [items.length > 1 ? items : items[0], j];
}

function parseCall(env: Env, toks: Tok[]): Call {
  const first = toks[0];
  if (!first || (first.k !== 'word' && first.k !== 'str')) throw new PsError('', 'Expected a command.');
  const call: Call = { name: first.v, positional: [], params: {} };
  for (let i = 1; i < toks.length; ) {
    const t = toks[i];
    if (t.k === 'param') {
      const key = t.name.toLowerCase();
      if (t.value !== undefined) {
        call.params[key] = t.value.startsWith('$') ? getVar(env, t.value.slice(1), []) : t.value;
        i++;
        continue;
      }
      const next = toks[i + 1];
      if (!next || next.k === 'param' || next.k === 'pipe' || next.k === 'semi' || (SWITCHES.has(key) && next.k !== 'var')) {
        call.params[key] = true;
        i++;
        continue;
      }
      const [v, j] = readValue(env, toks, i + 1);
      call.params[key] = v;
      i = j;
      continue;
    }
    if (t.k === 'block' && call.block === undefined && call.positional.length === 0) {
      call.block = t.src;
      i++;
      continue;
    }
    const [v, j] = readValue(env, toks, i);
    call.positional.push(v);
    i = j;
  }
  return call;
}

/** Evaluates source and returns the objects it outputs. */
export function evalSource(env: Env, src: string): Value[] {
  if (++env.depth > 40) {
    env.depth = 0;
    throw new PsError('', 'The script called itself too deeply.');
  }
  try {
    const results: Value[] = [];
    for (const stmt of splitStatements(src)) results.push(...evalStatement(env, stmt));
    return results;
  } finally {
    env.depth--;
  }
}

function evalStatement(env: Env, stmt: string): Value[] {
  const s = stmt.trim();
  // foreach ($x in <expr>) { body }
  const fe = /^foreach\s*\(\s*\$(\w+)\s+in\s+/i.exec(s);
  if (fe) {
    const open = s.indexOf('(');
    const [head, end] = readBalanced(s, open, '(', ')');
    const listSrc = head.replace(/^\s*\$\w+\s+in\s+/i, '');
    const bodyStart = s.indexOf('{', end);
    if (bodyStart < 0) throw new PsError('', 'Missing statement body in foreach loop.');
    const [body] = readBalanced(s, bodyStart, '{', '}');
    const out: Value[] = [];
    for (const item of asList(single(evalSource(env, listSrc)))) {
      env.vars.set(fe[1].toLowerCase(), item);
      out.push(...evalSource(env, body));
    }
    return out;
  }
  // if (cond) { } elseif (cond) { } else { }
  if (/^if\s*\(/i.test(s)) {
    let rest = s;
    for (;;) {
      const open = rest.indexOf('(');
      const [cond, end] = readBalanced(rest, open, '(', ')');
      const bodyStart = rest.indexOf('{', end);
      if (bodyStart < 0) throw new PsError('', 'Missing statement block after if ( condition ).');
      const [body, bodyEnd] = readBalanced(rest, bodyStart, '{', '}');
      if (condition(env, cond, undefined, false)) return evalSource(env, body);
      const tail = rest.slice(bodyEnd).trim();
      if (/^elseif\s*\(/i.test(tail)) {
        rest = tail.replace(/^elseif/i, 'if');
        continue;
      }
      if (/^else\s*\{/i.test(tail)) {
        const [elseBody] = readBalanced(tail, tail.indexOf('{'), '{', '}');
        return evalSource(env, elseBody);
      }
      return [];
    }
  }
  const pipes = splitPipes(s);
  // Native command at the start of the pipeline, with raw arguments.
  const nm = /^\s*(?:&\s*)?([A-Za-z][\w.-]*?)(\.exe)?(?:\s+([\s\S]*))?$/.exec(pipes[0]);
  if (nm && NATIVE_TABLE[nm[1].toLowerCase()] && !CMDLET_TABLE[nm[1].toLowerCase()]) {
    const cx = makeCx(env, { name: nm[1], positional: [], params: {} }, undefined);
    let cur = NATIVE_TABLE[nm[1].toLowerCase()](splitArgs(nm[3] ?? ''), cx);
    for (const stage of pipes.slice(1)) cur = invoke(env, parseCall(env, tokenize(stage)), cur);
    return cur;
  }
  // Script files: .\name.ps1 or & .\name.ps1
  const script = /^\s*&?\s*(\.{1,2}[\\/][^\s|]+\.ps1|[A-Za-z]:\\[^\s|]+\.ps1)(?:\s+([^|]*))?$/i.exec(pipes[0]);
  if (script) {
    const path = toVfs(env, script[1]);
    let text: string;
    try {
      text = readFile(env.sys.fs, path, { user: 'root', groups: ['root'] });
    } catch {
      throw new PsError(script[1], `The term '${script[1]}' is not recognized as the name of a cmdlet, function, script file, or operable program.`);
    }
    env.vars.set('args', splitArgs(script[2] ?? ''));
    let cur = evalSource(env, text);
    for (const stage of pipes.slice(1)) cur = invoke(env, parseCall(env, tokenize(stage)), cur);
    return cur;
  }
  let toks = tokenize(s);
  let assignTo: { name: string; op: '=' | '+=' } | undefined;
  if (toks[0]?.k === 'var' && toks[1]?.k === 'assign') {
    assignTo = { name: toks[0].name.toLowerCase(), op: (toks[1] as { op: '=' | '+=' }).op };
    toks = toks.slice(2);
  }
  let value: Value[];
  if (toks.length && toks[0].k !== 'word') {
    const [v, j] = readValue(env, toks, 0);
    let vals = asList(v);
    if (toks[j]?.k === 'param') {
      // An expression such as $a -eq 5 or (Get-X).Count -gt 2
      vals = [condition(env, s.slice(s.indexOf('=') >= 0 && assignTo ? s.indexOf('=') + (assignTo.op === '+=' ? 2 : 1) : 0), undefined, false)];
      value = vals;
    } else if (j < toks.length && toks[j].k === 'pipe') value = runPipeline(env, splitOnPipe(toks.slice(j + 1)), vals);
    else value = Array.isArray(v) ? v : [v];
  } else value = toks.length ? runPipeline(env, splitOnPipe(toks), undefined) : [];
  if (assignTo) {
    const v = value.length === 1 ? value[0] : value;
    if (assignTo.op === '+=') {
      const prev = env.vars.get(assignTo.name);
      env.vars.set(assignTo.name, typeof prev === 'number' && typeof v === 'number' ? prev + v : typeof prev === 'string' ? prev + str(v) : [...asList(prev), ...asList(v)]);
    } else env.vars.set(assignTo.name, v);
    return [];
  }
  return value;
}

function splitOnPipe(toks: Tok[]): Tok[][] {
  const parts: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === 'pipe') parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts;
}

function runPipeline(env: Env, stages: Tok[][], input: Value[] | undefined): Value[] {
  let cur = input;
  for (const stage of stages) {
    if (!stage.length) throw new PsError('', 'An empty pipe element is not allowed.');
    cur = invoke(env, parseCall(env, stage), cur);
  }
  return cur ?? [];
}

/* ----------------------------------------------------------------------------- conditions */

export function compare(op: string, a: Value, b: Value): boolean {
  if (op === 'contains' || op === 'notcontains') {
    const has = asList(a).some((x) => str(x).toLowerCase() === str(b).toLowerCase());
    return op === 'contains' ? has : !has;
  }
  if (op === 'in' || op === 'notin') {
    const has = asList(b).some((x) => str(x).toLowerCase() === str(a).toLowerCase());
    return op === 'in' ? has : !has;
  }
  if (Array.isArray(a) && !['eq', 'ne'].includes(op)) return a.some((x) => compare(op, x, b));
  const as = show(a).toLowerCase();
  const bs = show(b).toLowerCase();
  const an = Number(as);
  const bn = Number(bs);
  const numeric = as !== '' && bs !== '' && !Number.isNaN(an) && !Number.isNaN(bn);
  switch (op) {
    case 'eq':
      if (Array.isArray(a)) return a.some((x) => compare('eq', x, b));
      return as === bs;
    case 'ne':
      return !compare('eq', a, b);
    case 'like':
      return new RegExp('^' + bs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(as);
    case 'notlike':
      return !compare('like', a, b);
    case 'match':
      return new RegExp(show(b), 'i').test(show(a));
    case 'notmatch':
      return !new RegExp(show(b), 'i').test(show(a));
    case 'gt':
      return numeric ? an > bn : as > bs;
    case 'ge':
      return numeric ? an >= bn : as >= bs;
    case 'lt':
      return numeric ? an < bn : as < bs;
    case 'le':
      return numeric ? an <= bn : as <= bs;
  }
  throw new PsError('', `Unknown operator -${op}.`);
}

/**
 * Evaluates a condition. Operands: $_.Prop (the subject), bare Prop names when `bare` (for -Filter),
 * literals, $variables and (subexpressions).
 */
export function condition(env: Env, src: string, subject: Value, bare: boolean): boolean {
  const toks = tokenize(src.trim());
  if (!toks.length) return false;
  if (toks.length === 1 && toks[0].k === 'word' && toks[0].v === '*') return true;
  let i = 0;
  const operand = (): Value => {
    const t = toks[i++];
    if (!t) throw new PsError('', 'Incomplete condition.');
    if (t.k === 'var' && t.name === '_') {
      let v: Value = subject;
      for (const p of t.props) v = prop(v, p);
      return v;
    }
    if (t.k === 'word' && bare && /^[A-Za-z]\w*$/.test(t.v)) return prop(subject, t.v);
    return valueOf(env, t);
  };
  const truthy = (v: Value) => !(v === false || v === null || v === undefined || v === 0 || v === '' || v === 'False' || (Array.isArray(v) && v.length === 0));
  const term = (): boolean => {
    const t = toks[i];
    if (t?.k === 'param' && t.name.toLowerCase() === 'not') {
      i++;
      return !term();
    }
    if (t?.k === 'word' && t.v === '!') {
      i++;
      return !term();
    }
    if (t?.k === 'sub' && !t.props.length && (toks[i + 1] === undefined || (toks[i + 1].k === 'param' && ['and', 'or'].includes((toks[i + 1] as { name: string }).name.toLowerCase())))) {
      i++;
      return condition(env, t.src, subject, bare);
    }
    const left = operand();
    const op = toks[i];
    if (!op || op.k !== 'param' || ['and', 'or'].includes(op.name.toLowerCase())) return truthy(left);
    i++;
    return compare(op.name.toLowerCase(), left, operand());
  };
  let result = term();
  while (i < toks.length) {
    const op = toks[i++];
    if (op.k !== 'param') throw new PsError('', 'Unexpected token in condition.');
    const rhs = term();
    if (op.name.toLowerCase() === 'and') result = result && rhs;
    else if (op.name.toLowerCase() === 'or') result = result || rhs;
    else throw new PsError('', `Unexpected operator -${op.name} in condition.`);
  }
  return result;
}

/* ----------------------------------------------------------------------------- invoke */

function makeCx(env: Env, call: Call, input: Value[] | undefined): Cx {
  const name = ALIASES[call.name.toLowerCase()] ?? call.name.toLowerCase();
  return {
    env,
    call,
    name,
    P: call.params,
    pos: call.positional,
    input,
    fail: (msg: string): never => {
      throw new PsError(call.name, msg);
    },
    run: (src, vars) => {
      const saved = new Map<string, Value>();
      for (const [k, v] of Object.entries(vars ?? {})) {
        saved.set(k, env.vars.get(k));
        env.vars.set(k, v);
      }
      try {
        return evalSource(env, src);
      } finally {
        for (const [k, v] of saved) env.vars.set(k, v);
      }
    },
    print: (text) => env.out.push(text),
  };
}

export function invoke(env: Env, call: Call, input: Value[] | undefined): Value[] {
  const cx = makeCx(env, call, input);
  const fn = CMDLET_TABLE[cx.name];
  if (fn) return fn(cx);
  const native = NATIVE_TABLE[cx.name];
  if (native) return native(call.positional.map(str), cx);
  throw new PsError(call.name, `The term '${call.name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or use Get-Command to see what this server has.`);
}

/* ----------------------------------------------------------------------------- rendering */

function formatList(objs: Obj[]): string {
  return objs
    .map((o) => {
      const keys = Object.keys(o).filter((k) => k !== '__type');
      const w = Math.max(...keys.map((k) => k.length));
      return keys.map((k) => `${k.padEnd(w)} : ${Array.isArray(o[k]) ? `{${(o[k] as Value[]).map(show).join(', ')}}` : show(o[k])}`).join('\n');
    })
    .join('\n\n');
}

function formatTable(objs: Obj[]): string {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o).filter((k) => k !== '__type')))];
  const cell = (v: Value) => (Array.isArray(v) ? `{${v.map(show).join(', ')}}` : show(v));
  const widths = keys.map((k) => Math.max(k.length, ...objs.map((o) => cell(o[k]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(' ').trimEnd();
  return [line(keys), line(widths.map((w) => '-'.repeat(w))), ...objs.map((o) => line(keys.map((k) => cell(o[k]))))].join('\n');
}

export const TABLE_TYPES = new Set(['file', 'share', 'access', 'member', 'cmd', 'select', 'feature', 'disk', 'volume', 'service', 'process', 'event', 'rule', 'printer', 'job', 'scope', 'lease', 'record', 'zone', 'gpo-link', 'vm', 'task', 'counter', 'ip', 'measure', 'quota', 'screen', 'policy-row', 'reservation', 'option']);

export function render(values: Value[], forceTable = false, forceList = false): string {
  if (!values.length) return '';
  const objs = values.filter(isObj) as Obj[];
  const scalars = values.filter((v) => !isObj(v));
  const parts: string[] = [];
  if (scalars.length) parts.push(scalars.map(show).join('\n'));
  if (objs.length) {
    const nKeys = Object.keys(objs[0]).filter((k) => k !== '__type').length;
    parts.push(forceTable || (!forceList && (nKeys <= 4 || TABLE_TYPES.has(String(objs[0].__type)))) ? formatTable(objs) : formatList(objs));
  }
  return (objs.length ? '\n' : '') + parts.join('\n\n') + '\n' + (objs.length ? '\n' : '');
}

/* ----------------------------------------------------------------------------- entry points */

const SESSIONS = new WeakMap<object, Map<string, Value>>();

/** True while braces, parentheses or quotes are still open, so the terminal keeps reading lines. */
export function psAwaitsMore(src: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const c of src) {
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
  }
  return depth > 0 || quote !== null || /`\s*$/.test(src);
}

export function makeEnv(sys: ShellSystem, session: object): Env {
  let vars = SESSIONS.get(session);
  if (!vars) {
    vars = new Map();
    SESSIONS.set(session, vars);
  }
  return { sys, vars, out: [], st: loadAd(sys), est: loadEstate(sys), dirtyAd: false, dirtyEst: false, depth: 0 };
}

export function commit(env: Env): void {
  if (env.dirtyAd) saveAd(env.sys, env.st);
  if (env.dirtyEst) saveEstate(env.sys, env.est);
}

/** Runs one PowerShell line on a Windows machine. `session` keeps variables between lines. */
export function runPowerShell(sys: ShellSystem, line: string, session: object, record = true): { output: string; status: number; clear: boolean } {
  if (record && line.trim()) sys.history.push(line);
  const env = makeEnv(sys, session);
  let status = 0;
  try {
    const values = evalSource(env, line);
    env.out.push(render(values));
  } catch (e) {
    if (e instanceof PsError) {
      env.out.push(`${e.cmd ? e.cmd + ' : ' : ''}${e.message}\n`);
      status = 1;
    } else throw e;
  }
  commit(env);
  const text = env.out.join('');
  return { output: text.replace(/\u001bc/g, '').replace(/^\n+/, '\n'), status, clear: text.includes('\u001bc') };
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
 * or "ERROR: ..." when the query fails.
 */
export function psQuery(sys: ShellSystem, script: string, machineName?: string): string {
  const env = makeEnv(sys, {});
  const target = machineName ? machineByName(env, machineName)?.name : env.est.machines[0]?.name;
  if (!target) return `ERROR: there is no machine called ${machineName}.`;
  env.est.current = target;
  const savedCwd = sys.cwd;
  sys.cwd = driveRoot(env.est, target) + '/Users/Administrator';
  try {
    return render(evalSource(env, script)).trim();
  } catch (e) {
    if (e instanceof PsError) return `ERROR: ${e.message}`;
    throw e;
  } finally {
    sys.cwd = savedCwd;
  }
}
