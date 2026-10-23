/**
 * A PowerShell subset for Windows Server labs, with an Active Directory and file-share model.
 * A machine whose system has os: 'windows' routes every typed line here instead of to bash.
 *
 * Language: statements separated by ; or newlines, pipelines with |, $variables and $_.Property,
 * assignment, "double quotes" expanding $name and $(expression), 'single quotes', comma arrays,
 * (subexpressions), { script blocks } for ForEach-Object and Where-Object, and conditions with
 * -eq -ne -like -notlike -gt -ge -lt -le -and -or -not.
 *
 * Directory state lives in C:\Windows\NTDS\ntds.json (the VFS path /c/Windows/NTDS/ntds.json).
 */

import { FsError, listDir, lookup, mkdir, readFile, remove, writeFile } from './fs.js';
import type { ShellSystem } from './system.js';

/* ----------------------------------------------------------------------------- model */

export interface AdUser {
  sam: string;
  name: string;
  given?: string;
  surname?: string;
  upn?: string;
  dn: string;
  department?: string;
  title?: string;
  enabled: boolean;
  hasPassword: boolean;
}
export interface AdGroup {
  name: string;
  dn: string;
  scope: 'Global' | 'DomainLocal' | 'Universal';
  category: 'Security' | 'Distribution';
  /** Members as DNs. */
  members: string[];
}
export interface AdOu {
  name: string;
  dn: string;
  protected: boolean;
}
export interface SmbShare {
  name: string;
  path: string;
  access: Array<{ account: string; right: 'Full' | 'Change' | 'Read' }>;
}
export interface AdState {
  domain: string;
  netbios: string;
  ous: AdOu[];
  users: AdUser[];
  groups: AdGroup[];
  shares: SmbShare[];
}

const NTDS = '/c/Windows/NTDS/ntds.json';
const ROOT = { user: 'root', groups: ['root'] };

export function domainDn(domain: string): string {
  return domain
    .split('.')
    .map((p) => `DC=${p}`)
    .join(',');
}

export function newDirectory(domain: string, netbios: string): AdState {
  const dc = domainDn(domain);
  return {
    domain,
    netbios,
    ous: [{ name: 'Domain Controllers', dn: `OU=Domain Controllers,${dc}`, protected: true }],
    users: [{ sam: 'Administrator', name: 'Administrator', dn: `CN=Administrator,CN=Users,${dc}`, enabled: true, hasPassword: true }],
    groups: [
      { name: 'Domain Admins', dn: `CN=Domain Admins,CN=Users,${dc}`, scope: 'Global', category: 'Security', members: [`CN=Administrator,CN=Users,${dc}`] },
      { name: 'Domain Users', dn: `CN=Domain Users,CN=Users,${dc}`, scope: 'Global', category: 'Security', members: [] },
    ],
    shares: [],
  };
}

export function loadAd(sys: ShellSystem): AdState {
  try {
    return JSON.parse(readFile(sys.fs, NTDS, ROOT)) as AdState;
  } catch {
    return newDirectory('campus.local', 'CAMPUS');
  }
}

function saveAd(sys: ShellSystem, st: AdState): void {
  mkdir(sys.fs, '/c/Windows/NTDS', ROOT, sys.now, true);
  writeFile(sys.fs, NTDS, JSON.stringify(st, null, 1), ROOT, sys.now);
}

/* ----------------------------------------------------------------------------- paths */

export function toVfs(sys: ShellSystem, p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  if (s === '~' || s.startsWith('~/')) s = (sys.users[sys.user]?.home ?? '/c/Users/Administrator') + s.slice(1);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(s);
  if (drive) s = `/${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  else if (!s.startsWith('/')) s = `${sys.cwd === '/' ? '' : sys.cwd}/${s}`;
  const out: string[] = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}

export function toWin(p: string): string {
  const m = /^\/([a-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${(m[2] ?? '\\').replace(/\//g, '\\')}` : p.replace(/\//g, '\\');
}

/* ----------------------------------------------------------------------------- values */

type Obj = Record<string, unknown> & { __type?: string };
type Value = unknown;

class PsError extends Error {
  constructor(public cmd: string, message: string) {
    super(message);
  }
}

const SECURE = '__secure';
interface Secure {
  [SECURE]: true;
  plain: string;
}
const isSecure = (v: unknown): v is Secure => !!v && typeof v === 'object' && SECURE in (v as object);

function show(v: Value): string {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return '';
  if (isSecure(v)) return 'System.Security.SecureString';
  if (Array.isArray(v)) return v.map(show).join(' ');
  if (typeof v === 'object') {
    const o = v as Obj;
    if (o.__type === 'csv') return `@{${Object.entries(o).filter(([k]) => k !== '__type').map(([k, x]) => `${k}=${show(x)}`).join('; ')}}`;
    return String(o.Name ?? o.DistinguishedName ?? '[object]');
  }
  return String(v);
}

function prop(v: Value, name: string): Value {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Obj;
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? o[key] : name.toLowerCase() === 'count' && Array.isArray(v) ? (v as unknown[]).length : undefined;
}

/* ----------------------------------------------------------------------------- tokens */

type Tok =
  | { k: 'str'; v: string; expand: boolean }
  | { k: 'num'; v: number }
  | { k: 'var'; name: string; props: string[] }
  | { k: 'param'; name: string; value?: string }
  | { k: 'word'; v: string }
  | { k: 'pipe' }
  | { k: 'semi' }
  | { k: 'comma' }
  | { k: 'assign' }
  | { k: 'sub'; src: string }
  | { k: 'block'; src: string };

function readBalanced(src: string, i: number, open: string, close: string): [string, number] {
  let depth = 0;
  let j = i;
  let quote: string | null = null;
  for (; j < src.length; j++) {
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

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') break;
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
    if (c === '=' && src[i + 1] !== '=') {
      toks.push({ k: 'assign' });
      i++;
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
      toks.push({ k: 'sub', src: inner });
      i = end;
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
      const m = /^\$([A-Za-z_][\w]*|_)((?:\.[A-Za-z_]\w*)*)/.exec(src.slice(i));
      if (!m) throw new PsError('', `Unexpected '$' at position ${i + 1}.`);
      toks.push({ k: 'var', name: m[1], props: m[2] ? m[2].slice(1).split('.') : [] });
      i += m[0].length;
      continue;
    }
    if (c === '-' && /[A-Za-z]/.test(src[i + 1] ?? '')) {
      const m = /^-([A-Za-z][\w]*)(?::(\S+))?/.exec(src.slice(i))!;
      toks.push({ k: 'param', name: m[1], ...(m[2] !== undefined ? { value: m[2] } : {}) });
      i += m[0].length;
      continue;
    }
    if (/[0-9]/.test(c) && /^\d+(\.\d+)?(?=[\s;|,)}]|$)/.test(src.slice(i))) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      toks.push({ k: 'num', v: Number(m[0]) });
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

/* ----------------------------------------------------------------------------- interpreter */

interface Env {
  sys: ShellSystem;
  vars: Map<string, Value>;
  out: string[];
  st: AdState;
  dirty: boolean;
}

const SWITCHES = new Set(['asplaintext', 'force', 'recurse', 'reset', 'passthru', 'whatif', 'all', 'noclobber', 'notypeinformation']);

interface Call {
  name: string;
  positional: Value[];
  params: Record<string, Value>;
  block?: string;
}

function getVar(env: Env, name: string, props: string[]): Value {
  let v: Value;
  const n = name.toLowerCase();
  if (n === 'true') v = true;
  else if (n === 'false') v = false;
  else if (n === 'null') v = null;
  else if (!env.vars.has(n)) v = null;
  else v = env.vars.get(n);
  for (const p of props) v = prop(v, p);
  return v;
}

function expandString(env: Env, s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '`' && i + 1 < s.length) {
      const n = s[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
    } else if (s[i] === '$' && s[i + 1] === '(') {
      const [inner, end] = readBalanced(s, i + 1, '(', ')');
      out += show(evalStatement(env, inner, true));
      i = end - 1;
    } else if (s[i] === '$') {
      const m = /^\$([A-Za-z_]\w*|_)/.exec(s.slice(i));
      if (!m) {
        out += '$';
        continue;
      }
      out += show(getVar(env, m[1], []));
      i += m[0].length - 1;
    } else out += s[i];
  }
  return out;
}

function valueOf(env: Env, t: Tok): Value {
  switch (t.k) {
    case 'str':
      return t.expand ? expandString(env, t.v) : t.v;
    case 'num':
      return t.v;
    case 'var':
      return getVar(env, t.name, t.props);
    case 'word':
      return t.v;
    case 'sub':
      return evalStatement(env, t.src, true);
    case 'block':
      return { __type: 'block', src: t.src };
    default:
      return undefined;
  }
}

/** Reads one value, joining comma-separated parts into an array. */
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
  const call: Call = { name: first.k === 'word' ? first.v : first.v, positional: [], params: {} };
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
      if (!next || next.k === 'param' || next.k === 'pipe' || next.k === 'semi' || SWITCHES.has(key)) {
        call.params[key] = true;
        i++;
        continue;
      }
      const [v, j] = readValue(env, toks, i + 1);
      call.params[key] = v;
      i = j;
      continue;
    }
    if (t.k === 'block') {
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

function splitOn(toks: Tok[], kind: 'pipe' | 'semi'): Tok[][] {
  const parts: Tok[][] = [[]];
  for (const t of toks) {
    if (t.k === kind) parts.push([]);
    else parts[parts.length - 1].push(t);
  }
  return parts;
}

/** Runs a pipeline and returns its output objects. */
function evalStatement(env: Env, src: string, capture = false): Value {
  let toks = tokenize(src);
  const results: Value[] = [];
  for (const stmt of splitOn(toks, 'semi')) {
    if (!stmt.length) continue;
    toks = stmt;
    let assignTo: string | undefined;
    if (toks[0]?.k === 'var' && toks[1]?.k === 'assign') {
      assignTo = toks[0].name.toLowerCase();
      toks = toks.slice(2);
    }
    let value: Value[];
    if (toks.length && toks[0].k !== 'word') {
      const [v, j] = readValue(env, toks, 0);
      if (j < toks.length && toks[j].k === 'pipe') value = runPipeline(env, splitOn(toks.slice(j + 1), 'pipe'), Array.isArray(v) ? v : [v]);
      else value = Array.isArray(v) ? v : [v];
    } else value = runPipeline(env, splitOn(toks, 'pipe'), undefined);
    if (assignTo) env.vars.set(assignTo, value.length === 1 ? value[0] : value);
    else results.push(...value);
  }
  if (capture) return results.length === 1 ? results[0] : results;
  return results;
}

function runPipeline(env: Env, stages: Tok[][], input: Value[] | undefined): Value[] {
  let cur = input;
  for (const stage of stages) {
    if (!stage.length) throw new PsError('', 'An empty pipe element is not allowed.');
    const call = parseCall(env, stage);
    cur = invoke(env, call, cur);
  }
  return cur ?? [];
}

/* ----------------------------------------------------------------------------- conditions */

function compare(op: string, a: Value, b: Value): boolean {
  const as = show(a).toLowerCase();
  const bs = show(b).toLowerCase();
  const an = Number(as);
  const bn = Number(bs);
  const numeric = as !== '' && bs !== '' && !Number.isNaN(an) && !Number.isNaN(bn);
  switch (op) {
    case 'eq':
      return typeof a === 'boolean' || typeof b === 'boolean' ? String(a).toLowerCase() === String(b).toLowerCase() || (a === true && bs === 'true') || (a === false && bs === 'false') : as === bs;
    case 'ne':
      return !compare('eq', a, b);
    case 'like':
      return new RegExp('^' + bs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(as);
    case 'notlike':
      return !compare('like', a, b);
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

/** Evaluates "A -op B -and C -op D" where operands are $_.Prop, bare Prop names, literals or $vars. */
function condition(env: Env, src: string, subject: Value, bare: boolean): boolean {
  const toks = tokenize(src.trim());
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
  const term = (): boolean => {
    const t = toks[i];
    if (t?.k === 'param' && t.name.toLowerCase() === 'not') {
      i++;
      return !term();
    }
    if (t?.k === 'sub') {
      i++;
      return condition(env, t.src, subject, bare);
    }
    const left = operand();
    const op = toks[i];
    if (!op || op.k !== 'param' || ['and', 'or'].includes(op.name.toLowerCase())) return !!left && left !== 'False' && left !== 0;
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

/* ----------------------------------------------------------------------------- AD helpers */

function findUser(st: AdState, id: Value): AdUser | undefined {
  const s = show(id).toLowerCase();
  return st.users.find((u) => u.sam.toLowerCase() === s || u.dn.toLowerCase() === s || u.name.toLowerCase() === s || u.upn?.toLowerCase() === s);
}
function findGroup(st: AdState, id: Value): AdGroup | undefined {
  const s = show(id).toLowerCase();
  return st.groups.find((g) => g.name.toLowerCase() === s || g.dn.toLowerCase() === s);
}
function containerExists(st: AdState, dn: string): boolean {
  const d = dn.toLowerCase();
  const dc = domainDn(st.domain).toLowerCase();
  return d === dc || d === `cn=users,${dc}` || d === `cn=computers,${dc}` || st.ous.some((o) => o.dn.toLowerCase() === d);
}
function userView(u: AdUser, props: string[]): Obj {
  const o: Obj = { __type: 'ADUser', DistinguishedName: u.dn, Enabled: u.enabled, GivenName: u.given ?? '', Name: u.name, ObjectClass: 'user', SamAccountName: u.sam, Surname: u.surname ?? '', UserPrincipalName: u.upn ?? '' };
  if (props.some((p) => p === '*' || p.toLowerCase() === 'department')) o.Department = u.department ?? '';
  if (props.some((p) => p === '*' || p.toLowerCase() === 'title')) o.Title = u.title ?? '';
  if (props.some((p) => p === '*' || p.toLowerCase() === 'memberof')) o.MemberOf = [] as string[];
  return o;
}
function groupView(g: AdGroup): Obj {
  return { __type: 'ADGroup', DistinguishedName: g.dn, GroupCategory: g.category, GroupScope: g.scope, Name: g.name, ObjectClass: 'group', SamAccountName: g.name };
}
function ouView(o: AdOu): Obj {
  return { __type: 'ADOU', DistinguishedName: o.dn, Name: o.name, ObjectClass: 'organizationalUnit', ProtectedFromAccidentalDeletion: o.protected };
}

function passwordOk(pw: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return pw.length >= 8 && classes >= 3;
}

const COMPLEXITY = 'The password does not meet the length, complexity, or history requirement of the domain.';

/** Which member kinds a group of each scope may contain (same forest, simplified). */
function nestingProblem(group: AdGroup, member: AdUser | AdGroup): string | null {
  if (!('scope' in member)) return null;
  if (group.scope === 'Global' && member.scope !== 'Global') return `A ${member.scope} group cannot be a member of a Global group. Global groups contain users and other Global groups (the G in AGDLP).`;
  if (group.scope === 'Universal' && member.scope === 'DomainLocal') return 'A DomainLocal group cannot be a member of a Universal group.';
  if (member.dn === group.dn) return 'A group cannot be a member of itself.';
  return null;
}

/* ----------------------------------------------------------------------------- formatting */

function formatList(objs: Obj[]): string {
  return objs
    .map((o) => {
      const keys = Object.keys(o).filter((k) => k !== '__type');
      const w = Math.max(...keys.map((k) => k.length));
      return keys.map((k) => `${k.padEnd(w)} : ${show(o[k])}`).join('\n');
    })
    .join('\n\n');
}

function formatTable(objs: Obj[]): string {
  const keys = [...new Set(objs.flatMap((o) => Object.keys(o).filter((k) => k !== '__type')))];
  const widths = keys.map((k) => Math.max(k.length, ...objs.map((o) => show(o[k]).length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join(' ').trimEnd();
  return [line(keys), line(widths.map((w) => '-'.repeat(w))), ...objs.map((o) => line(keys.map((k) => show(o[k]))))].join('\n');
}

function render(values: Value[], forceTable = false, forceList = false): string {
  if (!values.length) return '';
  const objs = values.filter((v) => v && typeof v === 'object' && !Array.isArray(v) && !isSecure(v)) as Obj[];
  const scalars = values.filter((v) => !(v && typeof v === 'object' && !Array.isArray(v)) || isSecure(v));
  const parts: string[] = [];
  if (scalars.length) parts.push(scalars.map(show).join('\n'));
  if (objs.length) {
    const nKeys = Object.keys(objs[0]).filter((k) => k !== '__type').length;
    parts.push((forceTable || (!forceList && (nKeys <= 4 || ['file', 'share', 'access', 'member', 'cmd'].includes(String(objs[0].__type))))) ? formatTable(objs) : formatList(objs));
  }
  return '\n' + parts.join('\n\n') + '\n\n';
}

/* ----------------------------------------------------------------------------- cmdlets */

const ALIASES: Record<string, string> = {
  dir: 'get-childitem', ls: 'get-childitem', gci: 'get-childitem', cd: 'set-location', sl: 'set-location', pwd: 'get-location', gl: 'get-location', cat: 'get-content', type: 'get-content', gc: 'get-content',
  echo: 'write-output', write: 'write-output', cls: 'clear-host', clear: 'clear-host', mkdir: 'new-item', md: 'new-item', del: 'remove-item', rm: 'remove-item', erase: 'remove-item',
  '%': 'foreach-object', foreach: 'foreach-object', '?': 'where-object', where: 'where-object', select: 'select-object', sort: 'sort-object', measure: 'measure-object', ft: 'format-table', fl: 'format-list', man: 'get-help', help: 'get-help',
};

export const CMDLETS = [
  'Get-Location', 'Set-Location', 'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content', 'New-Item', 'Remove-Item', 'Test-Path', 'Import-Csv', 'Export-Csv', 'Write-Output', 'Write-Host', 'Clear-Host',
  'ForEach-Object', 'Where-Object', 'Select-Object', 'Sort-Object', 'Measure-Object', 'Format-Table', 'Format-List', 'ConvertTo-SecureString', 'Get-Help', 'Get-Command',
  'Get-ADDomain', 'New-ADOrganizationalUnit', 'Get-ADOrganizationalUnit', 'Remove-ADOrganizationalUnit', 'Set-ADOrganizationalUnit', 'New-ADUser', 'Get-ADUser', 'Set-ADUser', 'Remove-ADUser',
  'Enable-ADAccount', 'Disable-ADAccount', 'Set-ADAccountPassword', 'Move-ADObject', 'New-ADGroup', 'Get-ADGroup', 'Remove-ADGroup', 'Add-ADGroupMember', 'Remove-ADGroupMember', 'Get-ADGroupMember', 'Get-ADPrincipalGroupMembership',
  'New-SmbShare', 'Get-SmbShare', 'Remove-SmbShare', 'Get-SmbShareAccess', 'hostname', 'whoami',
];

const HELP: Record<string, string> = {
  'new-aduser': 'New-ADUser -Name <string> [-GivenName] [-Surname] [-SamAccountName] [-UserPrincipalName] [-Department] [-Path <OU DN>] [-AccountPassword <SecureString>] [-Enabled <bool>]',
  'new-adgroup': 'New-ADGroup -Name <string> -GroupScope Global|DomainLocal|Universal [-GroupCategory Security|Distribution] [-Path <OU DN>]',
  'add-adgroupmember': 'Add-ADGroupMember -Identity <group> -Members <user or group>[,<...>]',
  'new-adorganizationalunit': 'New-ADOrganizationalUnit -Name <string> [-Path <parent DN>] [-ProtectedFromAccidentalDeletion <bool>]',
  'get-aduser': 'Get-ADUser -Identity <user> | -Filter <condition> [-SearchBase <DN>] [-Properties <names>]',
  'new-smbshare': 'New-SmbShare -Name <string> -Path <folder> [-FullAccess <accounts>] [-ChangeAccess <accounts>] [-ReadAccess <accounts>]',
  'import-csv': 'Import-Csv -Path <file>   (each row becomes an object with one property per column)',
  'foreach-object': 'ForEach-Object { <statements using $_> }',
  'where-object': "Where-Object { $_.Property -eq 'value' }",
};

const asList = (v: Value): Value[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: Value) => (v === undefined || v === null ? '' : show(v));
const bool = (v: Value) => v === true || /^(\$?true|1)$/i.test(str(v));

function invoke(env: Env, call: Call, input: Value[] | undefined): Value[] {
  const name = ALIASES[call.name.toLowerCase()] ?? call.name.toLowerCase();
  const P = call.params;
  const pos = call.positional;
  const sys = env.sys;
  const st = env.st;
  const dc = domainDn(st.domain);
  const fail = (msg: string): never => {
    throw new PsError(call.name, msg);
  };
  const identity = () => P.identity ?? pos[0] ?? fail('Cannot validate argument on parameter \'Identity\'. The argument is null.');
  const path = () => str(P.path ?? P.literalpath ?? pos[0] ?? '.');

  switch (name) {
    /* ---------------------------------------------------------- files */
    case 'get-location':
      return [{ __type: 'path', Path: toWin(sys.cwd) }];
    case 'set-location': {
      const target = toVfs(sys, path());
      const l = lookup(sys.fs, target, ROOT);
      if (!l || l.node.type !== 'dir') fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      sys.cwd = target;
      return [];
    }
    case 'get-childitem': {
      const target = toVfs(sys, path());
      try {
        return listDir(sys.fs, target, ROOT).map(({ name: n, node }) => ({ __type: 'file', Mode: node.type === 'dir' ? 'd-----' : '-a----', LastWriteTime: '10/22/2026  9:30 AM', Length: node.type === 'file' ? node.content.length : '', Name: n }));
      } catch {
        return fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      }
    }
    case 'get-content': {
      const target = toVfs(sys, path());
      try {
        return readFile(sys.fs, target, ROOT).replace(/\n$/, '').split('\n');
      } catch {
        return fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      }
    }
    case 'set-content':
    case 'add-content': {
      const target = toVfs(sys, path());
      const text = asList(P.value ?? pos[1] ?? input).map(show).join('\n') + '\n';
      let prev = '';
      if (name === 'add-content') {
        try {
          prev = readFile(sys.fs, target, ROOT);
        } catch {
          /* new file */
        }
      }
      try {
        writeFile(sys.fs, target, prev + text, ROOT, sys.now);
      } catch (e) {
        fail(e instanceof FsError ? `Could not find a part of the path '${toWin(target)}'.` : String(e));
      }
      return [];
    }
    case 'new-item': {
      const target = toVfs(sys, str(P.path ?? pos[0]) + (P.name ? '/' + str(P.name) : ''));
      const kind = str(P.itemtype ?? (call.name.toLowerCase() === 'mkdir' || call.name.toLowerCase() === 'md' ? 'Directory' : 'File')).toLowerCase();
      if (lookup(sys.fs, target, ROOT) && !P.force) fail(`An item with the specified name ${toWin(target)} already exists.`);
      if (kind === 'directory') mkdir(sys.fs, target, ROOT, sys.now, true);
      else {
        mkdir(sys.fs, target.slice(0, target.lastIndexOf('/')) || '/', ROOT, sys.now, true);
        writeFile(sys.fs, target, P.value !== undefined ? str(P.value) + '\n' : '', ROOT, sys.now);
      }
      return [{ __type: 'file', Mode: kind === 'directory' ? 'd-----' : '-a----', LastWriteTime: '10/22/2026  9:30 AM', Length: '', Name: target.split('/').pop() }];
    }
    case 'remove-item': {
      const target = toVfs(sys, path());
      try {
        remove(sys.fs, target, ROOT, !!P.recurse);
      } catch {
        fail(`Cannot find path '${toWin(target)}' because it does not exist.`);
      }
      return [];
    }
    case 'test-path':
      return [!!lookup(sys.fs, toVfs(sys, path()), ROOT)];
    case 'import-csv': {
      const target = toVfs(sys, path());
      let text: string;
      try {
        text = readFile(sys.fs, target, ROOT);
      } catch {
        return fail(`Could not find file '${toWin(target)}'.`);
      }
      const rows = text.split(/\r?\n/).filter((l) => l.trim());
      const split = (l: string) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const header = split(rows[0] ?? '');
      return rows.slice(1).map((r) => {
        const cells = split(r);
        return Object.fromEntries([['__type', 'csv'], ...header.map((h, i) => [h, cells[i] ?? ''])]);
      });
    }
    case 'export-csv': {
      const target = toVfs(sys, path());
      const objs = (input ?? []).filter((v) => v && typeof v === 'object') as Obj[];
      const keys = objs.length ? Object.keys(objs[0]).filter((k) => k !== '__type') : [];
      writeFile(sys.fs, target, [keys.map((k) => `"${k}"`).join(','), ...objs.map((o) => keys.map((k) => `"${show(o[k])}"`).join(','))].join('\n') + '\n', ROOT, sys.now);
      return [];
    }
    case 'write-output':
    case 'write-host':
      return [asList(P.object ?? pos.length > 1 ? pos : pos[0]).map(show).join(' ')];
    case 'clear-host':
      env.out.push('\u001bc');
      return [];
    case 'hostname':
      return [sys.hostname.toUpperCase()];
    case 'whoami':
      return [`${st.netbios.toLowerCase()}\\${sys.user.toLowerCase()}`];

    /* ---------------------------------------------------------- pipeline */
    case 'foreach-object': {
      if (!call.block) fail('ForEach-Object needs a script block: ForEach-Object { ... }');
      const out: Value[] = [];
      const saved = env.vars.get('_');
      for (const item of input ?? []) {
        env.vars.set('_', item);
        out.push(...asList(evalStatement(env, call.block!)));
      }
      env.vars.set('_', saved);
      return out;
    }
    case 'where-object': {
      if (!call.block) fail("Where-Object needs a script block: Where-Object { $_.Name -like 'A*' }");
      return (input ?? []).filter((item) => condition(env, call.block!, item, false));
    }
    case 'select-object': {
      const first = P.first !== undefined ? Number(str(P.first)) : undefined;
      const props = asList(P.property ?? (pos.length ? (pos.length > 1 ? pos : pos[0]) : undefined)).map(str).filter(Boolean);
      let items = input ?? [];
      if (first !== undefined) items = items.slice(0, first);
      if (P.expandproperty) return items.map((o) => prop(o, str(P.expandproperty)));
      if (!props.length) return items;
      return items.map((o) => Object.fromEntries([['__type', 'select'], ...props.map((p) => [Object.keys(o as Obj).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p, prop(o, p)])]));
    }
    case 'sort-object': {
      const by = str(P.property ?? pos[0]);
      const items = [...(input ?? [])];
      items.sort((a, b) => show(by ? prop(a, by) : a).localeCompare(show(by ? prop(b, by) : b)));
      if (P.descending) items.reverse();
      return items;
    }
    case 'measure-object':
      return [{ __type: 'measure', Count: (input ?? []).length }];
    case 'format-table':
      env.out.push(render(input ?? [], true));
      return [];
    case 'format-list':
      env.out.push(render(input ?? [], false, true));
      return [];
    case 'convertto-securestring':
      if (!P.asplaintext) fail('Use -AsPlainText -Force to convert a typed password in this lab.');
      return [{ [SECURE]: true, plain: str(pos[0] ?? P.string) } as Secure];
    case 'get-help': {
      const topic = str(P.name ?? pos[0]).toLowerCase();
      return [HELP[topic] ?? (topic ? `No detailed help for ${topic} in this lab. Try Get-Command to list cmdlets.` : 'Get-Help <cmdlet>. Try Get-Command to list the cmdlets this server knows.')];
    }
    case 'get-command':
      return CMDLETS.filter((c) => !pos[0] || new RegExp('^' + str(pos[0]).replace(/\*/g, '.*') + '$', 'i').test(c)).map((c) => ({ __type: 'cmd', CommandType: 'Cmdlet', Name: c }));

    /* ---------------------------------------------------------- AD: domain and OUs */
    case 'get-addomain':
      return [{ __type: 'ADDomain', DistinguishedName: dc, DNSRoot: st.domain, NetBIOSName: st.netbios, UsersContainer: `CN=Users,${dc}` }];
    case 'new-adorganizationalunit': {
      const n = str(P.name ?? pos[0]);
      if (!n) fail("Cannot validate argument on parameter 'Name'.");
      const parent = str(P.path ?? dc);
      if (!containerExists(st, parent)) fail(`Directory object not found: ${parent}. Create the parent OU first, or check the -Path DN.`);
      const dn = `OU=${n},${parent}`;
      if (st.ous.some((o) => o.dn.toLowerCase() === dn.toLowerCase())) fail('An attempt was made to add an object to the directory with a name that is already in use.');
      st.ous.push({ name: n, dn, protected: P.protectedfromaccidentaldeletion === undefined ? true : bool(P.protectedfromaccidentaldeletion) });
      env.dirty = true;
      return [];
    }
    case 'get-adorganizationalunit': {
      if (P.identity ?? pos[0]) {
        const o = st.ous.find((k) => k.dn.toLowerCase() === str(P.identity ?? pos[0]).toLowerCase() || k.name.toLowerCase() === str(P.identity ?? pos[0]).toLowerCase());
        return o ? [ouView(o)] : fail(`Cannot find an object with identity: '${str(P.identity ?? pos[0])}'.`);
      }
      return st.ous.map(ouView).filter((o) => condition(env, str(P.filter ?? '*'), o, true));
    }
    case 'set-adorganizationalunit': {
      const o = st.ous.find((k) => k.dn.toLowerCase() === str(identity()).toLowerCase());
      if (!o) fail(`Cannot find an object with identity: '${str(identity())}'.`);
      if (P.protectedfromaccidentaldeletion !== undefined) o!.protected = bool(P.protectedfromaccidentaldeletion);
      env.dirty = true;
      return [];
    }
    case 'remove-adorganizationalunit': {
      const o = st.ous.find((k) => k.dn.toLowerCase() === str(identity()).toLowerCase());
      if (!o) fail(`Cannot find an object with identity: '${str(identity())}'.`);
      if (o!.protected) fail('Access is denied. The OU is protected from accidental deletion: Set-ADOrganizationalUnit -ProtectedFromAccidentalDeletion $false first.');
      if ([...st.users, ...st.groups, ...st.ous].some((x) => x.dn.toLowerCase().endsWith(',' + o!.dn.toLowerCase()))) fail('The directory service can perform the requested operation only on a leaf object. The OU is not empty.');
      st.ous = st.ous.filter((k) => k !== o);
      env.dirty = true;
      return [];
    }

    /* ---------------------------------------------------------- AD: users */
    case 'new-aduser': {
      const n = str(P.name ?? pos[0]);
      if (!n) fail("Cannot validate argument on parameter 'Name'. The argument is null or empty.");
      const sam = str(P.samaccountname ?? n);
      if (sam.length > 20) fail(`The SamAccountName "${sam}" is longer than 20 characters.`);
      if (/[\s"/\\[\]:;|=,+*?<>]/.test(sam)) fail(`The SamAccountName "${sam}" contains characters that are not allowed.`);
      if (st.users.some((u) => u.sam.toLowerCase() === sam.toLowerCase()) || st.groups.some((g) => g.name.toLowerCase() === sam.toLowerCase())) fail('The specified account already exists');
      const parent = str(P.path ?? `CN=Users,${dc}`);
      if (!containerExists(st, parent)) fail(`Directory object not found: ${parent}.`);
      const pw = P.accountpassword;
      if (pw !== undefined && !isSecure(pw)) fail('Cannot bind parameter \'AccountPassword\': use ConvertTo-SecureString to make a SecureString.');
      if (pw && !passwordOk((pw as Secure).plain)) fail(COMPLEXITY);
      const enabled = P.enabled === undefined ? false : bool(P.enabled);
      if (enabled && !pw) fail(COMPLEXITY + ' (An enabled account needs -AccountPassword.)');
      const dn = `CN=${n},${parent}`;
      if ([...st.users, ...st.groups].some((x) => x.dn.toLowerCase() === dn.toLowerCase())) fail('An attempt was made to add an object to the directory with a name that is already in use.');
      st.users.push({ sam, name: n, given: P.givenname !== undefined ? str(P.givenname) : undefined, surname: P.surname !== undefined ? str(P.surname) : undefined, upn: P.userprincipalname !== undefined ? str(P.userprincipalname) : `${sam}@${st.domain}`, dn, department: P.department !== undefined ? str(P.department) : undefined, title: P.title !== undefined ? str(P.title) : undefined, enabled, hasPassword: !!pw });
      const du = st.groups.find((g) => g.name === 'Domain Users');
      du?.members.push(dn);
      env.dirty = true;
      return [];
    }
    case 'get-aduser': {
      const props = asList(P.properties).map(str);
      if (P.identity ?? (pos[0] !== undefined && P.filter === undefined)) {
        const u = findUser(st, P.identity ?? pos[0]);
        return u ? [userView(u, props)] : fail(`Cannot find an object with identity: '${str(P.identity ?? pos[0])}' under: '${dc}'.`);
      }
      if (P.filter === undefined) fail("Use -Identity <name> or -Filter, for example Get-ADUser -Filter *");
      const base = P.searchbase !== undefined ? str(P.searchbase).toLowerCase() : null;
      return st.users
        .filter((u) => !base || u.dn.toLowerCase().endsWith(',' + base))
        .map((u) => userView(u, [...props, 'department', 'title']))
        .filter((o) => condition(env, str(P.filter), o, true))
        .map((o) => {
          if (!props.some((p) => p === '*' || p.toLowerCase() === 'department')) delete o.Department;
          if (!props.some((p) => p === '*' || p.toLowerCase() === 'title')) delete o.Title;
          return o;
        });
    }
    case 'set-aduser': {
      const targets = input?.length && P.identity === undefined && pos[0] === undefined ? input.map((o) => prop(o, 'SamAccountName')) : [identity()];
      for (const id of targets) {
        const u = findUser(st, id) ?? fail(`Cannot find an object with identity: '${str(id)}'.`);
        if (P.department !== undefined) u.department = str(P.department);
        if (P.title !== undefined) u.title = str(P.title);
        if (P.givenname !== undefined) u.given = str(P.givenname);
        if (P.surname !== undefined) u.surname = str(P.surname);
      }
      env.dirty = true;
      return [];
    }
    case 'enable-adaccount':
    case 'disable-adaccount': {
      const targets = input?.length && P.identity === undefined && pos[0] === undefined ? input.map((o) => prop(o, 'SamAccountName')) : [identity()];
      for (const id of targets) {
        const u = findUser(st, id) ?? fail(`Cannot find an object with identity: '${str(id)}'.`);
        if (name === 'enable-adaccount' && !u.hasPassword) fail(COMPLEXITY + ' Set a password with Set-ADAccountPassword -Reset first.');
        u.enabled = name === 'enable-adaccount';
      }
      env.dirty = true;
      return [];
    }
    case 'set-adaccountpassword': {
      const u = findUser(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      const pw = P.newpassword;
      if (!isSecure(pw)) fail("Use -Reset -NewPassword (ConvertTo-SecureString 'password' -AsPlainText -Force).");
      if (!passwordOk((pw as Secure).plain)) fail(COMPLEXITY);
      u.hasPassword = true;
      env.dirty = true;
      return [];
    }
    case 'remove-aduser': {
      const u = findUser(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      st.users = st.users.filter((x) => x !== u);
      for (const g of st.groups) g.members = g.members.filter((m) => m !== u.dn);
      env.dirty = true;
      return [];
    }
    case 'move-adobject': {
      const id = str(identity());
      const target = str(P.targetpath ?? pos[1]);
      if (!containerExists(st, target)) fail(`Directory object not found: ${target}.`);
      const obj = st.users.find((u) => u.dn.toLowerCase() === id.toLowerCase() || u.sam.toLowerCase() === id.toLowerCase()) ?? st.groups.find((g) => g.dn.toLowerCase() === id.toLowerCase() || g.name.toLowerCase() === id.toLowerCase());
      if (!obj) fail(`Cannot find an object with identity: '${id}'.`);
      const oldDn = obj!.dn;
      obj!.dn = `CN=${obj!.name},${target}`;
      for (const g of st.groups) g.members = g.members.map((m) => (m === oldDn ? obj!.dn : m));
      env.dirty = true;
      return [];
    }

    /* ---------------------------------------------------------- AD: groups */
    case 'new-adgroup': {
      const n = str(P.name ?? pos[0]);
      const scopeRaw = str(P.groupscope ?? pos[1]);
      const scope = (['Global', 'DomainLocal', 'Universal'] as const).find((s) => s.toLowerCase() === scopeRaw.toLowerCase());
      if (!n) fail("Cannot validate argument on parameter 'Name'.");
      if (!scope) fail("Cannot bind parameter 'GroupScope'. Use Global, DomainLocal or Universal.");
      const parent = str(P.path ?? `CN=Users,${dc}`);
      if (!containerExists(st, parent)) fail(`Directory object not found: ${parent}.`);
      if (findGroup(st, n) || st.users.some((u) => u.sam.toLowerCase() === n.toLowerCase())) fail('The specified group already exists');
      const category = str(P.groupcategory ?? 'Security').toLowerCase() === 'distribution' ? 'Distribution' : 'Security';
      st.groups.push({ name: n, dn: `CN=${n},${parent}`, scope: scope!, category, members: [] });
      env.dirty = true;
      return [];
    }
    case 'get-adgroup': {
      if (P.identity ?? (pos[0] !== undefined && P.filter === undefined)) {
        const g = findGroup(st, P.identity ?? pos[0]);
        return g ? [groupView(g)] : fail(`Cannot find an object with identity: '${str(P.identity ?? pos[0])}'.`);
      }
      return st.groups.map(groupView).filter((o) => condition(env, str(P.filter ?? '*'), o, true));
    }
    case 'remove-adgroup': {
      const g = findGroup(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      st.groups = st.groups.filter((x) => x !== g);
      for (const x of st.groups) x.members = x.members.filter((m) => m !== g.dn);
      env.dirty = true;
      return [];
    }
    case 'add-adgroupmember':
    case 'remove-adgroupmember': {
      const g = findGroup(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      const members = asList(P.members ?? pos[1] ?? input?.map((o) => prop(o, 'SamAccountName') ?? o));
      if (!members.length) fail("Cannot validate argument on parameter 'Members'.");
      for (const m of members) {
        const obj = findUser(st, m) ?? findGroup(st, m);
        if (!obj) fail(`Cannot find an object with identity: '${str(m)}' under: '${dc}'.`);
        if (name === 'remove-adgroupmember') {
          g.members = g.members.filter((x) => x !== obj!.dn);
          continue;
        }
        const problem = nestingProblem(g, obj!);
        if (problem) fail(problem);
        if (!g.members.includes(obj!.dn)) g.members.push(obj!.dn);
      }
      env.dirty = true;
      return [];
    }
    case 'get-adgroupmember': {
      const g = findGroup(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      const collect = (grp: AdGroup, seen: Set<string>): Obj[] =>
        grp.members.flatMap((dn) => {
          const u = st.users.find((x) => x.dn === dn);
          if (u) return [{ __type: 'member', distinguishedName: u.dn, name: u.name, objectClass: 'user', SamAccountName: u.sam }];
          const sub = st.groups.find((x) => x.dn === dn);
          if (!sub) return [];
          if (P.recursive && !seen.has(sub.dn)) return collect(sub, new Set([...seen, sub.dn]));
          return [{ __type: 'member', distinguishedName: sub.dn, name: sub.name, objectClass: 'group', SamAccountName: sub.name }];
        });
      return collect(g, new Set([g.dn]));
    }
    case 'get-adprincipalgroupmembership': {
      const u = findUser(st, identity()) ?? findGroup(st, identity()) ?? fail(`Cannot find an object with identity: '${str(identity())}'.`);
      return st.groups.filter((g) => g.members.includes(u.dn)).map(groupView);
    }

    /* ---------------------------------------------------------- shares */
    case 'new-smbshare': {
      const n = str(P.name ?? pos[0]);
      const folder = toVfs(sys, str(P.path ?? pos[1]));
      const l = lookup(sys.fs, folder, ROOT);
      if (!l || l.node.type !== 'dir') fail(`The system cannot find the file specified: ${toWin(folder)}. Create the folder first with New-Item -ItemType Directory.`);
      if (st.shares.some((s) => s.name.toLowerCase() === n.toLowerCase())) fail('The name has already been shared.');
      const access: SmbShare['access'] = [];
      const add = (v: Value, right: 'Full' | 'Change' | 'Read') => {
        for (const a of asList(v)) {
          const acct = str(a);
          const shortName = acct.includes('\\') ? acct.split('\\')[1] : acct;
          if (!/^everyone$/i.test(shortName) && !findUser(st, shortName) && !findGroup(st, shortName)) fail(`No mapping between account names and security IDs was done: ${acct}`);
          access.push({ account: acct.includes('\\') || /^everyone$/i.test(acct) ? acct : `${st.netbios}\\${acct}`, right });
        }
      };
      if (P.fullaccess !== undefined) add(P.fullaccess, 'Full');
      if (P.changeaccess !== undefined) add(P.changeaccess, 'Change');
      if (P.readaccess !== undefined) add(P.readaccess, 'Read');
      if (!access.length) access.push({ account: 'Everyone', right: 'Read' });
      st.shares.push({ name: n, path: toWin(folder), access });
      env.dirty = true;
      return [{ __type: 'share', Name: n, ScopeName: '*', Path: toWin(folder), Description: '' }];
    }
    case 'get-smbshare':
      return [
        { __type: 'share', Name: 'ADMIN$', ScopeName: '*', Path: 'C:\\Windows', Description: 'Remote Admin' },
        { __type: 'share', Name: 'C$', ScopeName: '*', Path: 'C:\\', Description: 'Default share' },
        ...st.shares.map((s) => ({ __type: 'share', Name: s.name, ScopeName: '*', Path: s.path, Description: '' })),
      ].filter((s) => !(P.name ?? pos[0]) || s.Name.toLowerCase() === str(P.name ?? pos[0]).toLowerCase());
    case 'get-smbshareaccess': {
      const s = st.shares.find((x) => x.name.toLowerCase() === str(P.name ?? pos[0]).toLowerCase()) ?? fail(`No MSFT_SMBShare objects found with property 'Name' equal to '${str(P.name ?? pos[0])}'.`);
      return s.access.map((a) => ({ __type: 'access', Name: s.name, ScopeName: '*', AccountName: a.account, AccessControlType: 'Allow', AccessRight: a.right }));
    }
    case 'remove-smbshare': {
      const n = str(P.name ?? pos[0]);
      if (!st.shares.some((s) => s.name.toLowerCase() === n.toLowerCase())) fail(`No MSFT_SMBShare objects found with property 'Name' equal to '${n}'.`);
      st.shares = st.shares.filter((s) => s.name.toLowerCase() !== n.toLowerCase());
      env.dirty = true;
      return [];
    }
  }
  return fail(`The term '${call.name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or Get-Command to see what this server has.`);
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
  return depth > 0 || quote !== null;
}

/** Runs one PowerShell line on a Windows machine. `session` keeps variables between lines. */
export function runPowerShell(sys: ShellSystem, line: string, session: object, record = true): { output: string; status: number; clear: boolean } {
  if (record && line.trim()) sys.history.push(line);
  let vars = SESSIONS.get(session);
  if (!vars) {
    vars = new Map();
    SESSIONS.set(session, vars);
  }
  const env: Env = { sys, vars, out: [], st: loadAd(sys), dirty: false };
  let status = 0;
  try {
    const values = evalStatement(env, line) as Value[];
    env.out.push(render(values));
  } catch (e) {
    if (e instanceof PsError) {
      env.out.push(`${e.cmd ? e.cmd + ' : ' : ''}${e.message}\n`);
      status = 1;
    } else throw e;
  }
  if (env.dirty) saveAd(sys, env.st);
  const text = env.out.join('');
  return { output: text.replace(/\u001bc/g, '').replace(/^\n+/, '\n'), status, clear: text.includes('\u001bc') };
}

export function promptPowerShell(sys: ShellSystem): string {
  return `PS ${toWin(sys.cwd)}> `;
}
