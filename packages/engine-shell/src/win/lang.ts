/**
 * The PowerShell evaluator: runs the AST from parse.ts against the cmdlet registry in core.ts.
 *
 * Values: JS strings, numbers, booleans, null and arrays; objects carry __type (hashtable,
 * psobject, datetime, timespan, block, error, type, version, list ...). Variables live in a chain
 * of scopes whose root is the session's global map. Output is emitted value by value, so host
 * text (Write-Host, errors) interleaves with it as in a console.
 *
 * Errors follow Windows PowerShell 5.1: cmdlet errors are non-terminating unless -ErrorAction Stop
 * (or $ErrorActionPreference = 'Stop'); parameter binding, method and AD identity errors end the
 * statement; throw ends the script; try/catch catches the terminating kinds.
 */

import { FsError, lookup, readFile, writeFile, mkdir } from '../fs.js';
import { ALIASES, CMDLET_TABLE, NATIVE_TABLE, PsError, SWITCHES, asList, isObj, isSecure, machine, prop, render, show, toVfs, toWin, type Call, type Cx, type Env, type Obj, type Value } from './core.js';
import { findClose, OPERATOR_NAMES, ParseError, Parser, parseScript, type Arg, type Block, type Elem, type Expr, type ParamDef, type Stmt } from './parse.js';

const ROOT = { user: 'root', groups: ['root'] };

/* ----------------------------------------------------------------------------- scopes */

export interface Scope {
  vars: Map<string, Value>;
  parent: Scope | null;
  kind: 'global' | 'script' | 'function' | 'block';
}

export function globalScope(env: Env): Scope {
  if (!env.scope) env.scope = { vars: env.vars, parent: null, kind: 'global' };
  let s = env.scope;
  while (s.parent) s = s.parent;
  return s;
}

function current(env: Env): Scope {
  return env.scope ?? globalScope(env);
}

const PREFS: Record<string, Value> = { erroractionpreference: 'Continue', verbosepreference: 'SilentlyContinue', warningpreference: 'Continue', debugpreference: 'SilentlyContinue', informationpreference: 'SilentlyContinue', progresspreference: 'Continue', whatifpreference: false, confirmpreference: 'High', ofs: ' ', maximumhistorycount: 4096 };

export function envVar(env: Env, name: string): Value {
  const n = name.toLowerCase();
  const set = env.vars.get('env:' + n);
  if (set !== undefined) return set;
  const user = env.sys.user;
  const map: Record<string, string> = {
    computername: machine(env).name,
    username: user,
    userdomain: env.st.netbios,
    userdnsdomain: env.st.domain.toUpperCase(),
    userprofile: `C:\\Users\\${user}`,
    homedrive: 'C:',
    homepath: `\\Users\\${user}`,
    temp: `C:\\Users\\${user}\\AppData\\Local\\Temp`,
    tmp: `C:\\Users\\${user}\\AppData\\Local\\Temp`,
    appdata: `C:\\Users\\${user}\\AppData\\Roaming`,
    localappdata: `C:\\Users\\${user}\\AppData\\Local`,
    windir: 'C:\\Windows',
    systemroot: 'C:\\Windows',
    systemdrive: 'C:',
    programfiles: 'C:\\Program Files',
    programdata: 'C:\\ProgramData',
    os: 'Windows_NT',
    processor_architecture: 'AMD64',
    number_of_processors: '4',
    path: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
    psmodulepath: `C:\\Users\\${user}\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules`,
    logonserver: `\\\\${env.est.machines[0]?.name ?? 'DC01'}`,
  };
  return map[n] ?? null;
}

export function getVariable(env: Env, name: string, scope?: string): Value {
  const n = name.toLowerCase();
  if (scope === 'env') return envVar(env, n);
  if (n === 'true') return true;
  if (n === 'false') return false;
  if (n === 'null') return null;
  if (scope === 'function') return env.vars.get('function:' + n) ?? null;
  if (n === '?') return env.ok !== false;
  if (n === 'psversiontable') return psVersionTable();
  if (n === 'home') return `C:\\Users\\${env.sys.user}`;
  if (n === 'pwd') return { __type: 'pathinfo', Path: toWin(env.sys.cwd) };
  if (n === 'pid') return 4242;
  if (n === 'host') return { __type: 'host', Name: 'ConsoleHost', Version: { __type: 'version', Major: 5, Minor: 1, Build: 20348, Revision: 2849 } };
  if (n === 'pshome') return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
  if (n === 'psculture') return 'en-GB';
  if (n === 'profile') return `C:\\Users\\${env.sys.user}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`;
  if (n === 'error') return globalScope(env).vars.get('error') ?? [];
  let s: Scope | null = scope === 'global' ? globalScope(env) : scope === 'script' ? scriptScope(env) : current(env);
  while (s) {
    if (s.vars.has(n)) return s.vars.get(n);
    if (scope === 'local') break;
    s = s.parent;
  }
  return n in PREFS ? PREFS[n] : null;
}

function scriptScope(env: Env): Scope {
  let s: Scope | null = current(env);
  while (s && s.kind !== 'script' && s.parent) s = s.parent;
  return s ?? globalScope(env);
}

export function setVariable(env: Env, name: string, value: Value, scope?: string): void {
  const n = name.toLowerCase();
  if (scope === 'env') {
    env.vars.set('env:' + n, value === null ? null : str(value));
    return;
  }
  if (n === 'true' || n === 'false') throw rtError(`Cannot overwrite variable ${name} because it is read-only or constant.`, 'SessionStateUnauthorizedAccessException', 'statement');
  if (n === 'null') return;
  if (scope === 'function') {
    env.vars.set('function:' + n, value);
    return;
  }
  const target = scope === 'global' ? globalScope(env) : scope === 'script' ? scriptScope(env) : current(env);
  target.vars.set(n, value);
}

export function withScope<T>(env: Env, kind: Scope['kind'], fn: (s: Scope) => T, vars?: Record<string, Value>): T {
  const saved = env.scope;
  const s: Scope = { vars: new Map(Object.entries(vars ?? {}).map(([k, v]) => [k.toLowerCase(), v])), parent: current(env), kind };
  env.scope = s;
  try {
    return fn(s);
  } finally {
    env.scope = saved;
  }
}

function psVersionTable(): Obj {
  return { __type: 'hashtable', PSVersion: { __type: 'version', Major: 5, Minor: 1, Build: 20348, Revision: 2849 }, PSEdition: 'Desktop', PSCompatibleVersions: ['1.0', '2.0', '3.0', '4.0', '5.0', '5.1.20348.2849'], BuildVersion: '10.0.20348.2849', CLRVersion: '4.0.30319.42000', WSManStackVersion: '3.0', PSRemotingProtocolVersion: '2.3', SerializationVersion: '1.1.0.1' };
}

/* ----------------------------------------------------------------------------- errors and control flow */

/** A terminating error: 'statement' ends the current statement, 'script' ends the whole run unless caught. */
export class RuntimeErr extends Error {
  constructor(
    public record: Obj,
    public kind: 'statement' | 'script',
  ) {
    super(String((record.Exception as Obj)?.Message ?? 'error'));
  }
}
class BreakEx {
  constructor(public label?: string) {}
}
class ContinueEx {
  constructor(public label?: string) {}
}
class ReturnEx {}
export class ExitEx {
  constructor(public code: number) {}
}

const TYPE_FULL: Record<string, string> = {
  ItemNotFoundException: 'System.Management.Automation.ItemNotFoundException',
  RuntimeException: 'System.Management.Automation.RuntimeException',
  CommandNotFoundException: 'System.Management.Automation.CommandNotFoundException',
  ParameterBindingException: 'System.Management.Automation.ParameterBindingException',
  ParameterBindingValidationException: 'System.Management.Automation.ParameterBindingValidationException',
  ParameterBindingArgumentTransformationException: 'System.Management.Automation.ParameterBindingArgumentTransformationException',
  MethodInvocationException: 'System.Management.Automation.MethodInvocationException',
  ADIdentityNotFoundException: 'Microsoft.ActiveDirectory.Management.ADIdentityNotFoundException',
  ADIdentityAlreadyExistsException: 'Microsoft.ActiveDirectory.Management.ADIdentityAlreadyExistsException',
  ADException: 'Microsoft.ActiveDirectory.Management.ADException',
  UnauthorizedAccessException: 'System.UnauthorizedAccessException',
  IOException: 'System.IO.IOException',
  WebException: 'System.Net.WebException',
  WriteErrorException: 'Microsoft.PowerShell.Commands.WriteErrorException',
  DivideByZeroException: 'System.DivideByZeroException',
  PSArgumentException: 'System.Management.Automation.PSArgumentException',
  ArgumentException: 'System.ArgumentException',
  PSInvalidCastException: 'System.Management.Automation.PSInvalidCastException',
  SessionStateUnauthorizedAccessException: 'System.Management.Automation.SessionStateUnauthorizedAccessException',
  ParseException: 'System.Management.Automation.ParseException',
  PSSecurityException: 'System.Management.Automation.PSSecurityException',
};

/** Exception types and the types catch [Base] also matches. */
const BASES: Record<string, string[]> = {
  ItemNotFoundException: ['SessionStateException', 'RuntimeException', 'SystemException'],
  CommandNotFoundException: ['RuntimeException', 'SystemException'],
  ParameterBindingException: ['RuntimeException', 'SystemException'],
  ParameterBindingValidationException: ['ParameterBindingException', 'RuntimeException', 'SystemException'],
  ParameterBindingArgumentTransformationException: ['ParameterBindingException', 'RuntimeException', 'SystemException'],
  MethodInvocationException: ['MethodException', 'RuntimeException', 'SystemException'],
  ADIdentityNotFoundException: ['ADException', 'InvalidOperationException', 'SystemException'],
  ADIdentityAlreadyExistsException: ['ADException', 'InvalidOperationException', 'SystemException'],
  ADException: ['InvalidOperationException', 'SystemException'],
  WriteErrorException: ['SystemException'],
  RuntimeException: ['SystemException'],
  UnauthorizedAccessException: ['SystemException'],
  IOException: ['SystemException'],
  WebException: ['InvalidOperationException', 'SystemException'],
  DivideByZeroException: ['ArithmeticException', 'SystemException'],
  ArgumentException: ['SystemException'],
  PSArgumentException: ['ArgumentException', 'SystemException'],
  PSInvalidCastException: ['InvalidCastException', 'RuntimeException', 'SystemException'],
  PSSecurityException: ['RuntimeException', 'SystemException'],
};

export function errorRecord(message: string, type = 'RuntimeException', opts: { id?: string; category?: string; target?: Value; command?: string; line?: number; script?: string } = {}): Obj {
  const short = type.replace(/^.*\./, '');
  const full = TYPE_FULL[short] ?? (type.includes('.') ? type : `System.${type}`);
  const exception: Obj = { __type: 'exception', Message: message, __exType: full };
  return {
    __type: 'error',
    Exception: exception,
    CategoryInfo: { __type: 'categoryinfo', Category: opts.category ?? 'NotSpecified', Reason: short, TargetName: opts.target === undefined ? '' : str(opts.target), Activity: opts.command ?? '' },
    FullyQualifiedErrorId: `${opts.id ?? short}${opts.command ? ',' + opts.command : ''}`,
    TargetObject: opts.target ?? null,
    InvocationInfo: { __type: 'invocation', MyCommand: opts.command ?? '', ScriptLineNumber: opts.line ?? 0, ScriptName: opts.script ?? '' },
    ScriptStackTrace: opts.line ? `at <ScriptBlock>, ${opts.script ?? '<No file>'}: line ${opts.line}` : '',
    __command: opts.command ?? '',
  };
}

export function rtError(message: string, type = 'RuntimeException', kind: 'statement' | 'script' = 'statement', opts: Parameters<typeof errorRecord>[2] = {}): RuntimeErr {
  return new RuntimeErr(errorRecord(message, type, opts), kind);
}

function exTypeOf(rec: Obj): string {
  return String((rec.Exception as Obj)?.__exType ?? 'System.Management.Automation.RuntimeException');
}

function catchMatches(rec: Obj, types: string[]): boolean {
  if (!types.length) return true;
  const full = exTypeOf(rec);
  const short = full.replace(/^.*\./, '');
  const chain = [short, ...(BASES[short] ?? ['SystemException']), 'Exception'];
  return types.some((t) => {
    const want = t.replace(/^System\.Management\.Automation\.|^System\.|^Microsoft\.ActiveDirectory\.Management\.|^Microsoft\.PowerShell\.Commands\./i, '').replace(/^.*\./, '');
    return chain.some((c) => c.toLowerCase() === want.toLowerCase());
  });
}

/** Records an error in $Error and the -ErrorVariable, newest first. */
function remember(env: Env, rec: Obj, errorVariable?: string): void {
  const g = globalScope(env);
  const list = (g.vars.get('error') as Value[] | undefined) ?? [];
  g.vars.set('error', [rec, ...list].slice(0, 256));
  if (errorVariable) {
    const plus = errorVariable.startsWith('+');
    const name = errorVariable.replace(/^\+/, '');
    const prev = plus ? asList(getVariable(env, name)) : [];
    setVariable(env, name, [...prev, rec]);
  }
}

export function hostWrite(env: Env, text: string): void {
  env.flush?.();
  env.out.push(text);
  const t = env.vars.get('__transcript');
  if (typeof t === 'string' && t) appendFile(env, t, text);
}

function appendFile(env: Env, vfs: string, text: string): void {
  let prev = '';
  try {
    prev = readFile(env.sys.fs, vfs, ROOT);
  } catch {
    /* new file */
  }
  try {
    writeFile(env.sys.fs, vfs, prev + text, ROOT, env.sys.now);
  } catch {
    /* unwritable */
  }
}

/** How an error is shown in the console: "Command : message", plus where it happened in a script. */
export function errorText(rec: Obj): string {
  const msg = String((rec.Exception as Obj)?.Message ?? '');
  const cmd = String(rec.__command ?? '');
  const inv = rec.InvocationInfo as Obj | undefined;
  const where = inv && inv.ScriptName && inv.ScriptLineNumber ? `\nAt ${inv.ScriptName}:${inv.ScriptLineNumber} char:1` : '';
  return `${cmd ? cmd + ' : ' : ''}${msg}${where}\n`;
}

/* ----------------------------------------------------------------------------- value helpers */

const isArr = Array.isArray;
export const isHash = (v: Value): boolean => isObj(v) && (v as Obj).__type === 'hashtable';
export const isDate = (v: Value): boolean => isObj(v) && (v as Obj).__type === 'datetime';
export const isSpan = (v: Value): boolean => isObj(v) && (v as Obj).__type === 'timespan';
export const isBlock = (v: Value): boolean => isObj(v) && (v as Obj).__type === 'block';
const isType = (v: Value): boolean => isObj(v) && (v as Obj).__type === 'type';
const LISTS = new WeakSet<object>();

export function makeDate(ms: number): Obj {
  return { __type: 'datetime', __ms: ms };
}
export function makeSpan(ms: number): Obj {
  return { __type: 'timespan', __ms: ms };
}
export const msOf = (d: Value) => Number((d as Obj).__ms);

export function truthy(v: Value): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (isArr(v)) return v.length === 0 ? false : v.length === 1 ? truthy(v[0]) : true;
  return true;
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));

/** Conversion to string, as casts, interpolation and -join do (invariant culture). */
export function str(v: Value): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (isArr(v)) return v.map(str).join(' ');
  if (isDate(v)) return formatDate(msOf(v), 'MM/dd/yyyy HH:mm:ss');
  if (isSpan(v)) return spanText(msOf(v));
  if (isHash(v)) return 'System.Collections.Hashtable';
  if (isSecure(v)) return 'System.Security.SecureString';
  const o = v as Obj;
  if (o.__type === 'psobject' || o.__type === 'csv' || o.__type === 'select') return `@{${Object.keys(o).filter((k) => !k.startsWith('__')).map((k) => `${k}=${str(o[k])}`).join('; ')}}`;
  if (o.__type === 'error') return String((o.Exception as Obj).Message);
  if (o.__type === 'exception') return String(o.Message);
  if (o.__type === 'type') return String(o.FullName);
  if (o.__type === 'version') return [o.Major, o.Minor, o.Build, o.Revision].filter((x) => x !== undefined && x !== -1).join('.');
  if (o.__type === 'guid') return String(o.Guid);
  if (o.__type === 'block') return String(o.src);
  return show(v);
}

function spanText(ms: number): string {
  const neg = ms < 0;
  let t = Math.abs(ms);
  const d = Math.floor(t / 86400000);
  t -= d * 86400000;
  const h = Math.floor(t / 3600000);
  t -= h * 3600000;
  const m = Math.floor(t / 60000);
  t -= m * 60000;
  const s = Math.floor(t / 1000);
  const frac = t - s * 1000;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${neg ? '-' : ''}${d ? d + '.' : ''}${p(h)}:${p(m)}:${p(s)}${frac ? '.' + String(frac).padStart(3, '0') + '0000' : ''}`;
}

export function num(v: Value, type = 'System.Int32'): number {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isArr(v) && v.length === 1) return num(v[0], type);
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    const n = /^0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : Number(s.replace(/^\+/, ''));
    if (!Number.isNaN(n)) return n;
  }
  throw rtError(`Cannot convert value "${str(v)}" to type "${type}". Error: "Input string was not in a correct format."`, 'PSInvalidCastException');
}

/** Banker's rounding, as .NET uses for [int] casts and [math]::Round. */
export function roundEven(x: number, digits = 0): number {
  const f = 10 ** digits;
  const y = x * f;
  const r = Math.round(y);
  const isHalf = Math.abs(y % 1) === 0.5;
  return (isHalf ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

/** Output of a value into the pipeline: arrays are written element by element. */
function emitValue(v: Value, emit: (x: Value) => void): void {
  if (v === undefined) return;
  if (isArr(v)) for (const x of v) emit(x);
  else emit(v);
}

function collapse(vals: Value[]): Value {
  return vals.length === 0 ? null : vals.length === 1 ? vals[0] : vals;
}

/* ----------------------------------------------------------------------------- dates and formatting */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** .NET custom date format (yyyy MM dd HH mm ss tt ddd dddd MMM MMMM fff K) and standard ones (d D t T f F g G s u o). */
export function formatDate(ms: number, fmt: string): string {
  const std: Record<string, string> = { d: 'dd/MM/yyyy', D: 'dd MMMM yyyy', t: 'HH:mm', T: 'HH:mm:ss', f: 'dddd, dd MMMM yyyy HH:mm', F: 'dddd, dd MMMM yyyy HH:mm:ss', g: 'dd/MM/yyyy HH:mm', G: 'dd/MM/yyyy HH:mm:ss', s: "yyyy-MM-dd'T'HH:mm:ss", u: "yyyy-MM-dd HH:mm:ss'Z'", o: "yyyy-MM-dd'T'HH:mm:ss.fffffffK", O: "yyyy-MM-dd'T'HH:mm:ss.fffffffK", M: 'dd MMMM', Y: 'MMMM yyyy', r: "ddd, dd MMM yyyy HH:mm:ss 'GMT'", R: "ddd, dd MMM yyyy HH:mm:ss 'GMT'" };
  if (fmt.length === 1 && std[fmt]) fmt = std[fmt];
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return fmt.replace(/'([^']*)'|"([^"]*)"|\\(.)|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fffffff|ffff|fff|ff|f|tt|K|zzz/g, (t, q1?: string, q2?: string, esc?: string) => {
    if (q1 !== undefined) return q1;
    if (q2 !== undefined) return q2;
    if (esc !== undefined) return esc;
    switch (t) {
      case 'yyyy': return String(d.getUTCFullYear());
      case 'yy': return p(d.getUTCFullYear() % 100);
      case 'MMMM': return MONTHS[d.getUTCMonth()];
      case 'MMM': return MONTHS[d.getUTCMonth()].slice(0, 3);
      case 'MM': return p(d.getUTCMonth() + 1);
      case 'M': return String(d.getUTCMonth() + 1);
      case 'dddd': return DAYS[d.getUTCDay()];
      case 'ddd': return DAYS[d.getUTCDay()].slice(0, 3);
      case 'dd': return p(d.getUTCDate());
      case 'd': return String(d.getUTCDate());
      case 'HH': return p(d.getUTCHours());
      case 'H': return String(d.getUTCHours());
      case 'hh': return p(d.getUTCHours() % 12 || 12);
      case 'h': return String(d.getUTCHours() % 12 || 12);
      case 'mm': return p(d.getUTCMinutes());
      case 'm': return String(d.getUTCMinutes());
      case 'ss': return p(d.getUTCSeconds());
      case 's': return String(d.getUTCSeconds());
      case 'tt': return d.getUTCHours() < 12 ? 'AM' : 'PM';
      case 'K': return 'Z';
      case 'zzz': return '+00:00';
      default: return p(d.getUTCMilliseconds(), 3).padEnd(t.length, '0').slice(0, t.length);
    }
  });
}

/** Parses date text the way [datetime] casts do (invariant culture), or null. */
export function parseDateText(s: string): number | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(t);
  if (m) {
    let h = +(m[4] ?? 0);
    if (m[7]?.toUpperCase() === 'PM' && h < 12) h += 12;
    if (m[7]?.toUpperCase() === 'AM' && h === 12) h = 0;
    return Date.UTC(+m[3], +m[1] - 1, +m[2], h, +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m![2].toLowerCase().slice(0, 3)));
    if (mon >= 0) return Date.UTC(+m[3], mon, +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  }
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase().startsWith(m![1].toLowerCase().slice(0, 3)));
    if (mon >= 0) return Date.UTC(+m[3], mon, +m[2]);
  }
  return null;
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** .NET numeric format strings: N2, F1, D3, P0, C, X, E, G and custom 0.00 / #,##0. */
export function formatNumber(n: number, fmt: string): string {
  const m = /^([NnFfDdPpCcXxEeGgRr])(\d*)$/.exec(fmt);
  if (m) {
    const k = m[1].toUpperCase();
    const prec = m[2] === '' ? undefined : Number(m[2]);
    switch (k) {
      case 'N': {
        const s = roundEven(n, prec ?? 2).toFixed(prec ?? 2);
        const [i, f] = s.split('.');
        return (i.startsWith('-') ? '-' + groupThousands(i.slice(1)) : groupThousands(i)) + (f ? '.' + f : '');
      }
      case 'F':
        return roundEven(n, prec ?? 2).toFixed(prec ?? 2);
      case 'D':
        return (n < 0 ? '-' : '') + String(Math.abs(Math.trunc(n))).padStart(prec ?? 0, '0');
      case 'P': {
        const s = (n * 100).toFixed(prec ?? 2);
        const [i, f] = s.split('.');
        return groupThousands(i) + (f ? '.' + f : '') + ' %';
      }
      case 'C': {
        const s = Math.abs(n).toFixed(prec ?? 2);
        const [i, f] = s.split('.');
        return `${n < 0 ? '-' : ''}£${groupThousands(i)}${f ? '.' + f : ''}`;
      }
      case 'X': {
        const s = (Math.trunc(n) >>> 0).toString(16).padStart(prec ?? 0, '0');
        return m[1] === 'X' ? s.toUpperCase() : s;
      }
      case 'E':
        return n.toExponential(prec ?? 6).replace(/e([+-])(\d)$/, 'e$10$2').replace(/e([+-])(\d\d)$/, 'e$10$2').replace('e', m[1] === 'E' ? 'E' : 'e');
      case 'G':
      case 'R':
        return prec ? String(Number(n.toPrecision(prec))) : fmtNum(n);
    }
  }
  // Custom: 0 (digit), # (optional digit), . and , (grouping), % (percent).
  if (/^[0#,.%]+$/.test(fmt)) {
    let v = n;
    if (fmt.includes('%')) v *= 100;
    const [ip, fp = ''] = fmt.replace('%', '').split('.');
    const decimals = fp.length;
    const minFrac = (fp.match(/0/g) ?? []).length;
    let s = Math.abs(roundEven(v, decimals)).toFixed(decimals);
    let [i, f = ''] = s.split('.');
    while (f.length > minFrac && f.endsWith('0')) f = f.slice(0, -1);
    const minInt = (ip.replace(/,/g, '').match(/0/g) ?? []).length;
    i = i.padStart(minInt, '0');
    if (i === '0' && minInt === 0) i = '';
    if (ip.includes(',')) i = groupThousands(i);
    s = (v < 0 ? '-' : '') + i + (f ? '.' + f : '') + (fmt.includes('%') ? '%' : '');
    return s;
  }
  return fmtNum(n);
}

/** Formats one value with a .NET format string. */
export function formatValue(v: Value, fmt: string): string {
  if (isDate(v)) return formatDate(msOf(v), fmt);
  if (isSpan(v)) return spanText(msOf(v));
  if (typeof v === 'number') return formatNumber(v, fmt);
  if (typeof v === 'string' && fmt && /^[NnFfDdPpXx]\d*$/.test(fmt) && !Number.isNaN(Number(v)) && v.trim() !== '') return v;
  return str(v);
}

/** The -f operator and [string]::Format: {0}, {1,-10}, {0:N2}, {{ }}. */
export function formatComposite(fmt: string, args: Value[]): string {
  return fmt.replace(/\{\{|\}\}|\{(\d+)(?:,(-?\d+))?(?::([^}]*))?\}/g, (m, idx?: string, align?: string, spec?: string) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const i = Number(idx);
    if (i >= args.length) throw rtError(`Error formatting a string: Index (zero based) must be greater than or equal to zero and less than the size of the argument list..`, 'FormatException');
    const v = args[i];
    let s = spec ? formatValue(v, spec) : isDate(v) ? formatDate(msOf(v), 'dd/MM/yyyy HH:mm:ss') : str(v);
    if (align) {
      const w = Number(align);
      s = w < 0 ? s.padEnd(-w) : s.padStart(w);
    }
    return s;
  });
}

/* ----------------------------------------------------------------------------- types */

const TYPE_ALIASES: Record<string, string> = {
  int: 'System.Int32', int32: 'System.Int32', long: 'System.Int64', int64: 'System.Int64', int16: 'System.Int16', byte: 'System.Byte', uint32: 'System.UInt32', uint64: 'System.UInt64',
  double: 'System.Double', float: 'System.Single', single: 'System.Single', decimal: 'System.Decimal',
  string: 'System.String', char: 'System.Char', bool: 'System.Boolean', boolean: 'System.Boolean',
  datetime: 'System.DateTime', timespan: 'System.TimeSpan', array: 'System.Array', object: 'System.Object', 'object[]': 'System.Object[]',
  hashtable: 'System.Collections.Hashtable', ordered: 'System.Collections.Specialized.OrderedDictionary', pscustomobject: 'System.Management.Automation.PSObject', psobject: 'System.Management.Automation.PSObject',
  scriptblock: 'System.Management.Automation.ScriptBlock', securestring: 'System.Security.SecureString', pscredential: 'System.Management.Automation.PSCredential', regex: 'System.Text.RegularExpressions.Regex',
  version: 'System.Version', guid: 'System.Guid', void: 'System.Void', math: 'System.Math', convert: 'System.Convert', environment: 'System.Environment', 'io.path': 'System.IO.Path', 'io.file': 'System.IO.File', 'io.directory': 'System.IO.Directory',
  switch: 'System.Management.Automation.SwitchParameter', xml: 'System.Xml.XmlDocument', ipaddress: 'System.Net.IPAddress', mailaddress: 'System.Net.Mail.MailAddress', uri: 'System.Uri',
  'collections.arraylist': 'System.Collections.ArrayList', arraylist: 'System.Collections.ArrayList', 'text.encoding': 'System.Text.Encoding', 'text.stringbuilder': 'System.Text.StringBuilder',
};

export function fullTypeName(name: string): string {
  const n = name.trim();
  const arr = n.endsWith('[]');
  const base = arr ? n.slice(0, -2) : n;
  const k = base.toLowerCase().replace(/^system\./, '');
  const full = TYPE_ALIASES[k] ?? TYPE_ALIASES[base.toLowerCase()] ?? (/^system\./i.test(base) ? base : /\./.test(base) ? (/^(collections|io|text|net|management|security)\./i.test(base) ? 'System.' + base : base) : 'System.' + base[0].toUpperCase() + base.slice(1));
  return arr ? full + '[]' : full;
}

function typeObj(name: string): Obj {
  const full = fullTypeName(name);
  return { __type: 'type', Name: full.replace(/^.*\./, ''), FullName: full };
}

/** The .NET type name of a value, as GetType() reports it. */
export function typeNameOf(v: Value): string {
  if (v === null || v === undefined) return 'System.Object';
  if (typeof v === 'string') return 'System.String';
  if (typeof v === 'number') return Number.isInteger(v) ? (Math.abs(v) > 2147483647 ? 'System.Int64' : 'System.Int32') : 'System.Double';
  if (typeof v === 'boolean') return 'System.Boolean';
  if (isArr(v)) return LISTS.has(v) ? 'System.Collections.ArrayList' : 'System.Object[]';
  if (isSecure(v)) return 'System.Security.SecureString';
  const t = String((v as Obj).__type ?? '');
  const map: Record<string, string> = {
    hashtable: (v as Obj).__ordered ? 'System.Collections.Specialized.OrderedDictionary' : 'System.Collections.Hashtable', datetime: 'System.DateTime', timespan: 'System.TimeSpan', block: 'System.Management.Automation.ScriptBlock', error: 'System.Management.Automation.ErrorRecord', exception: String((v as Obj).__exType ?? 'System.Exception'),
    type: 'System.RuntimeType', version: 'System.Version', guid: 'System.Guid', psobject: 'System.Management.Automation.PSCustomObject', csv: 'System.Management.Automation.PSCustomObject', select: 'System.Management.Automation.PSCustomObject', list: 'System.Management.Automation.PSCustomObject',
    file: String((v as Obj).Mode ?? '').startsWith('d') ? 'System.IO.DirectoryInfo' : 'System.IO.FileInfo', service: 'System.ServiceProcess.ServiceController', process: 'System.Diagnostics.Process', event: 'System.Diagnostics.Eventing.Reader.EventLogRecord',
    credential: 'System.Management.Automation.PSCredential', matchinfo: 'Microsoft.PowerShell.Commands.MatchInfo', groupinfo: 'Microsoft.PowerShell.Commands.GroupInfo', measure: 'Microsoft.PowerShell.Commands.GenericMeasureInfo', regex: 'System.Text.RegularExpressions.Regex', match: 'System.Text.RegularExpressions.Match',
    aduser: 'Microsoft.ActiveDirectory.Management.ADUser', adgroup: 'Microsoft.ActiveDirectory.Management.ADGroup', adcomputer: 'Microsoft.ActiveDirectory.Management.ADComputer', adou: 'Microsoft.ActiveDirectory.Management.ADOrganizationalUnit', task: 'Microsoft.Management.Infrastructure.CimInstance#Root/Microsoft/Windows/TaskScheduler/MSFT_ScheduledTask', function: 'System.Management.Automation.FunctionInfo', cmd: 'System.Management.Automation.CmdletInfo',
  };
  return map[t] ?? 'System.Management.Automation.PSCustomObject';
}

function isOfType(v: Value, type: string): boolean {
  const full = fullTypeName(type).toLowerCase();
  const short = full.replace(/^.*\./, '');
  if (short === 'object') return v !== null && v !== undefined;
  if (v === null || v === undefined) return false;
  if (full.endsWith('[]') || short === 'array') return isArr(v);
  if (/^(int32|int64|int16|byte|uint32|uint64)$/.test(short)) return typeof v === 'number' && Number.isInteger(v);
  if (/^(double|single|decimal)$/.test(short)) return typeof v === 'number';
  if (short === 'valuetype') return typeof v === 'number' || typeof v === 'boolean' || isDate(v);
  if (short === 'pscustomobject' || short === 'psobject') return isObj(v) && !isHash(v) && !isDate(v) && !isSpan(v) && !isBlock(v);
  if (short === 'hashtable' || short === 'idictionary' || short === 'ordereddictionary') return isHash(v);
  if (short === 'arraylist' || /list`1|list\[/.test(full)) return isArr(v) && LISTS.has(v);
  const actual = typeNameOf(v).toLowerCase();
  return actual === full || actual.replace(/^.*\./, '') === short || (short === 'exception' && actual.endsWith('exception'));
}

/** [type] casts and parameter type constraints. */
export function convertTo(type: string, v: Value): Value {
  const full = fullTypeName(type);
  const short = full.replace(/^.*\./, '').toLowerCase();
  const fail = (): never => {
    throw rtError(`Cannot convert value "${str(v)}" to type "${full}". Error: "${short === 'datetime' ? 'String was not recognized as a valid DateTime.' : 'Input string was not in a correct format.'}"`, 'PSInvalidCastException');
  };
  if (full.endsWith('[]')) {
    const inner = full.slice(0, -2);
    return asList(v).map((x) => convertTo(inner, x));
  }
  switch (short) {
    case 'object':
      return v;
    case 'void':
      return undefined;
    case 'int32':
    case 'int64':
    case 'int16':
    case 'byte':
    case 'uint32':
    case 'uint64': {
      if (typeof v === 'string' && v.trim().length === 1 && short === 'byte') return v.charCodeAt(0);
      const n = num(v, full);
      return roundEven(n);
    }
    case 'double':
    case 'single':
    case 'decimal':
      return num(v, full);
    case 'string':
      return v === null ? '' : str(v);
    case 'char':
      return typeof v === 'number' ? String.fromCharCode(v) : str(v).length === 1 ? str(v) : fail();
    case 'boolean':
      return truthy(v);
    case 'switchparameter':
      return truthy(v);
    case 'datetime': {
      if (isDate(v)) return v;
      if (typeof v === 'number') return makeDate(v);
      const t = parseDateText(str(v));
      return t === null ? fail() : makeDate(t);
    }
    case 'timespan': {
      if (isSpan(v)) return v;
      const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str(v));
      if (!m) return fail();
      return makeSpan((+(m[1] ?? 0) * 86400 + +m[2] * 3600 + +m[3] * 60 + +(m[4] ?? 0)) * 1000);
    }
    case 'array':
      return asList(v);
    case 'hashtable':
      if (isHash(v)) return v;
      return fail();
    case 'ordereddictionary':
      if (isHash(v)) return { ...(v as Obj), __ordered: true };
      return fail();
    case 'psobject':
    case 'pscustomobject':
      if (isHash(v)) {
        const o: Obj = { __type: 'psobject' };
        for (const [k, x] of Object.entries(v as Obj)) if (!k.startsWith('__')) o[k] = x;
        return o;
      }
      return v;
    case 'scriptblock':
      return isBlock(v) ? v : { __type: 'block', src: str(v) };
    case 'regex':
      return { __type: 'regex', Pattern: str(v) };
    case 'version': {
      const parts = str(v).split('.').map(Number);
      if (parts.some((x) => Number.isNaN(x))) return fail();
      return { __type: 'version', Major: parts[0] ?? 0, Minor: parts[1] ?? 0, Build: parts[2] ?? -1, Revision: parts[3] ?? -1 };
    }
    case 'guid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str(v)) ? { __type: 'guid', Guid: str(v).toLowerCase() } : fail();
    case 'securestring':
      return isSecure(v) ? v : fail();
    case 'pscredential':
      return isObj(v) && (v as Obj).__type === 'credential' ? v : fail();
    case 'ipaddress':
      return /^(\d{1,3}\.){3}\d{1,3}$/.test(str(v)) && str(v).split('.').every((x) => +x <= 255) ? str(v) : fail();
    case 'arraylist': {
      const l = [...asList(v)];
      LISTS.add(l);
      return l;
    }
    case 'xmldocument':
      throw rtError('XML documents are not available in this simulator: use ConvertFrom-Json, Import-Csv or plain text.', 'RuntimeException');
  }
  if (/collections\.generic\.list/i.test(full)) {
    const l = [...asList(v)];
    LISTS.add(l);
    return l;
  }
  return v;
}

/* ----------------------------------------------------------------------------- comparison */

function likeRegex(pat: string, cs: boolean): RegExp {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '`' && i + 1 < pat.length) re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pat.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += '[' + pat.slice(i + 1, end) + ']';
        i = end;
      }
    } else re += c.replace(/[.*+?^${}()|\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', cs ? '' : 'i');
}

/** .NET regex syntax to JavaScript: inline (?i), named groups, \A \z. */
export function jsRegex(pattern: string, cs: boolean, global = false): RegExp {
  let p = pattern;
  let flags = cs ? '' : 'i';
  const inline = /^\(\?([imsx]+)\)/.exec(p);
  if (inline) {
    p = p.slice(inline[0].length);
    if (inline[1].includes('i')) flags = flags.includes('i') ? flags : flags + 'i';
    if (inline[1].includes('m')) flags += 'm';
    if (inline[1].includes('s')) flags += 's';
  }
  p = p.replace(/\\A/g, '^').replace(/\\[zZ]/g, '$');
  try {
    return new RegExp(p, flags + (global ? 'g' : ''));
  } catch (e) {
    throw rtError(`The regular expression pattern ${pattern} is not valid: ${(e as Error).message.replace(/^Invalid regular expression: /, '')}`, 'ArgumentException');
  }
}

function scalarEq(a: Value, b: Value, cs: boolean): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (isDate(b) && typeof a === 'string') return parseDateText(a) === msOf(b);
  if (typeof a === 'number') {
    if (b === null || b === undefined) return false;
    if (typeof b === 'number') return a === b;
    try {
      return a === num(b);
    } catch {
      return false;
    }
  }
  if (typeof a === 'boolean') return a === truthy(b);
  if (typeof a === 'string') {
    if (b === null || b === undefined) return false;
    const bs = str(b);
    return cs ? a === bs : a.toLowerCase() === bs.toLowerCase();
  }
  if (isDate(a)) {
    if (isDate(b)) return msOf(a) === msOf(b);
    const t = typeof b === 'string' ? parseDateText(b) : null;
    return t !== null && t === msOf(a);
  }
  if (isSpan(a) && isSpan(b)) return msOf(a) === msOf(b);
  if (isObj(a) && (a as Obj).__type === 'version' && isObj(b)) return str(a) === str(b);
  return a === b;
}

function scalarCmp(a: Value, b: Value, cs: boolean): number {
  // A date on the right turns date text on the left into a date (event times are often text).
  if (isDate(b) && typeof a === 'string') {
    const t = parseDateText(a);
    if (t !== null) return t - msOf(b);
  }
  if (typeof a === 'number') return a - num(b);
  if (isDate(a)) {
    const bt = isDate(b) ? msOf(b) : typeof b === 'string' ? parseDateText(b) : null;
    if (bt === null) throw rtError(`Could not compare "${str(a)}" to "${str(b)}". Error: "Cannot convert value "${str(b)}" to type "System.DateTime"."`, 'RuntimeException');
    return msOf(a) - bt;
  }
  if (isSpan(a) && isSpan(b)) return msOf(a) - msOf(b);
  if (isObj(a) && (a as Obj).__type === 'version') {
    const bv = convertTo('version', b) as Obj;
    for (const k of ['Major', 'Minor', 'Build', 'Revision']) {
      const d = Number((a as Obj)[k]) - Number(bv[k]);
      if (d) return d;
    }
    return 0;
  }
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  const as = str(a);
  const bs = str(b);
  return cs ? (as < bs ? -1 : as > bs ? 1 : 0) : as.localeCompare(bs, 'en', { sensitivity: 'accent' });
}

export function binaryOp(env: Env, op: string, l: Value, r: Value): Value {
  const cs = op.startsWith('c') && op.length > 1 && !['contains'].includes(op) && OPERATOR_NAMES.has(op) && OPERATOR_NAMES.has(op.slice(1));
  const base = (op.startsWith('c') || op.startsWith('i')) && OPERATOR_NAMES.has(op.slice(1)) && !OPERATOR_NAMES.has(op) ? op.slice(1) : op.startsWith('i') && OPERATOR_NAMES.has(op.slice(1)) && op !== 'in' && op !== 'is' && op !== 'isnot' ? op.slice(1) : op;
  const csFlag = cs || (op.startsWith('c') && !OPERATOR_NAMES.has(op.slice(0)) && OPERATOR_NAMES.has(op.slice(1)));
  switch (base) {
    case '+':
      return add(l, r);
    case '-':
      if (isDate(l) && isDate(r)) return makeSpan(msOf(l) - msOf(r));
      if (isDate(l) && isSpan(r)) return makeDate(msOf(l) - msOf(r));
      if (isSpan(l) && isSpan(r)) return makeSpan(msOf(l) - msOf(r));
      return num(l) - num(r);
    case '*':
      if (typeof l === 'string') return l.repeat(Math.max(0, num(r)));
      if (isArr(l)) return Array.from({ length: Math.max(0, num(r)) }, () => l).flat();
      return num(l) * num(r);
    case '/': {
      const d = num(r);
      if (d === 0) throw rtError('Attempted to divide by zero.', 'RuntimeException');
      return num(l) / d;
    }
    case '%': {
      const d = num(r);
      if (d === 0) throw rtError('Attempted to divide by zero.', 'RuntimeException');
      return num(l) % d;
    }
    case '..': {
      const a = Math.trunc(num(l));
      const b = Math.trunc(num(r));
      if (Math.abs(b - a) > 100000) throw rtError('The range is too large (the simulator allows up to 100000 numbers).', 'RuntimeException');
      return Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => (a <= b ? a + i : a - i));
    }
    case 'f':
      return formatComposite(str(l), asList(r));
    case 'and':
    case 'or':
      return base === 'and' ? truthy(l) && truthy(r) : truthy(l) || truthy(r);
    case 'xor':
      return truthy(l) !== truthy(r);
    case 'band':
      return num(l) & num(r);
    case 'bor':
      return num(l) | num(r);
    case 'bxor':
      return num(l) ^ num(r);
    case 'shl':
      return num(l) << num(r);
    case 'shr':
      return num(l) >> num(r);
    case 'is':
      return isOfType(l, isType(r) ? String((r as Obj).FullName) : str(r));
    case 'isnot':
      return !isOfType(l, isType(r) ? String((r as Obj).FullName) : str(r));
    case 'as':
      try {
        const v = convertTo(isType(r) ? String((r as Obj).FullName) : str(r), l);
        return v === undefined ? null : v;
      } catch {
        return null;
      }
    case 'contains':
    case 'notcontains': {
      const has = asList(l).some((x) => scalarEq(x, r, csFlag));
      return base === 'contains' ? has : !has;
    }
    case 'in':
    case 'notin': {
      const has = asList(r).some((x) => scalarEq(x, l, csFlag));
      return base === 'in' ? has : !has;
    }
    case 'join':
      return asList(l).map(str).join(str(r));
    case 'split': {
      const [pat, max] = isArr(r) ? r : [r];
      const re = jsRegex(str(pat), csFlag);
      return asList(l).flatMap((s) => {
        const parts = str(s).split(re).filter((x) => x !== undefined) as string[];
        if (max !== undefined && num(max) > 0 && parts.length > num(max)) {
          const n = num(max);
          const head = parts.slice(0, n - 1);
          let rest = str(s);
          for (let k = 0; k < n - 1; k++) {
            const m = re.exec(rest);
            if (!m) break;
            rest = rest.slice(m.index + m[0].length);
          }
          return [...head, rest];
        }
        return parts;
      });
    }
    case 'replace': {
      const [pat, rep] = isArr(r) ? r : [r, ''];
      const re = jsRegex(str(pat), csFlag, true);
      const repl = str(rep ?? '').replace(/\$\{(\w+)\}/g, '$<$1>');
      const one = (s: Value) => str(s).replace(re, repl);
      return isArr(l) ? l.map(one) : one(l);
    }
  }
  // Comparisons: an array on the left filters it.
  const test = (x: Value): boolean => {
    switch (base) {
      case 'eq': return scalarEq(x, r, csFlag);
      case 'ne': return !scalarEq(x, r, csFlag);
      case 'gt': return scalarCmp(x, r, csFlag) > 0;
      case 'ge': return scalarCmp(x, r, csFlag) >= 0;
      case 'lt': return scalarCmp(x, r, csFlag) < 0;
      case 'le': return scalarCmp(x, r, csFlag) <= 0;
      case 'like': return likeRegex(str(r), csFlag).test(str(x));
      case 'notlike': return !likeRegex(str(r), csFlag).test(str(x));
      case 'match': return jsRegex(str(r), csFlag).test(str(x));
      case 'notmatch': return !jsRegex(str(r), csFlag).test(str(x));
    }
    throw rtError(`Unknown operator -${op}.`, 'RuntimeException');
  };
  if (isArr(l)) return l.filter(test);
  if (base === 'match') {
    const m = jsRegex(str(r), csFlag).exec(str(l));
    if (m) {
      const h: Obj = { __type: 'hashtable' };
      m.forEach((g, i) => {
        if (g !== undefined) h[String(i)] = g;
      });
      for (const [k, g] of Object.entries(m.groups ?? {})) if (g !== undefined) h[k] = g;
      setVariable(env, 'Matches', h);
      return true;
    }
    return false;
  }
  return test(l);
}

function add(l: Value, r: Value): Value {
  if (l === null || l === undefined) return isArr(r) ? [...r] : r;
  if (isArr(l)) return [...l, ...(isArr(r) ? r : [r])];
  if (typeof l === 'string') return l + str(r);
  if (isHash(l)) {
    if (!isHash(r)) throw rtError('A hash table can only be added to another hash table.', 'RuntimeException');
    const out: Obj = { ...(l as Obj) };
    for (const [k, v] of Object.entries(r as Obj)) {
      if (k.startsWith('__')) continue;
      if (Object.keys(out).some((x) => x.toLowerCase() === k.toLowerCase())) throw rtError(`Item has already been added. Key in dictionary: '${k}'  Key being added: '${k}'`, 'ArgumentException');
      out[k] = v;
    }
    return out;
  }
  if (isDate(l)) {
    if (isSpan(r)) return makeDate(msOf(l) + msOf(r));
    throw rtError(`Method invocation failed because [System.DateTime] does not contain a method named 'op_Addition'.`, 'RuntimeException');
  }
  if (isSpan(l) && isSpan(r)) return makeSpan(msOf(l) + msOf(r));
  return num(l) + num(r);
}

/* ----------------------------------------------------------------------------- members and methods */

function keyOf(o: Obj, name: string): string | undefined {
  const n = name.toLowerCase();
  return Object.keys(o).find((k) => k.toLowerCase() === n && !k.startsWith('__'));
}

export function getMember(env: Env, v: Value, name: string): Value {
  const n = name.toLowerCase();
  if (v === null || v === undefined) return null;
  if (isArr(v)) {
    if (n === 'count' || n === 'length' || n === 'longlength') return v.length;
    if (n === 'issynchronized' || n === 'isfixedsize') return !LISTS.has(v);
    // Member enumeration: $users.Name
    return v.flatMap((x) => {
      const m = getMember(env, x, name);
      return m === null || m === undefined ? [] : isArr(m) ? m : [m];
    });
  }
  if (typeof v === 'string') return n === 'length' ? v.length : null;
  if (typeof v === 'number' || typeof v === 'boolean') return null;
  const o = v as Obj;
  if (n === 'psobject') return { __type: 'psobjectinfo', Properties: visibleProps(o).map(([k, x]) => ({ __type: 'psprop', Name: k, Value: x, MemberType: 'NoteProperty', TypeNameOfValue: typeNameOf(x) })), TypeNames: [typeNameOf(o)], BaseObject: o };
  if (isHash(o)) {
    const k = keyOf(o, name);
    if (k) return o[k];
    if (n === 'count') return visibleProps(o).length;
    if (n === 'keys') return visibleProps(o).map(([key]) => key);
    if (n === 'values') return visibleProps(o).map(([, x]) => x);
    return null;
  }
  if (isDate(o)) {
    const d = new Date(msOf(o));
    const map: Record<string, Value> = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond: d.getUTCMilliseconds(), dayofweek: DAYS[d.getUTCDay()], dayofyear: Math.floor((msOf(o) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1, date: makeDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())), ticks: msOf(o) * 10000 + 621355968000000000, timeofday: makeSpan(msOf(o) % 86400000), kind: 'Local' };
    return map[n] ?? null;
  }
  if (isSpan(o)) {
    const ms = msOf(o);
    const map: Record<string, Value> = { days: Math.trunc(ms / 86400000), hours: Math.trunc(ms / 3600000) % 24, minutes: Math.trunc(ms / 60000) % 60, seconds: Math.trunc(ms / 1000) % 60, milliseconds: ms % 1000, totaldays: ms / 86400000, totalhours: ms / 3600000, totalminutes: ms / 60000, totalseconds: ms / 1000, totalmilliseconds: ms, ticks: ms * 10000 };
    return map[n] ?? null;
  }
  if (o.__type === 'error' && n === 'exception') return o.Exception;
  if (o.__type === 'type') {
    if (n === 'name') return o.Name;
    if (n === 'fullname') return o.FullName;
    if (n === 'basetype') return typeObj('System.Object');
  }
  return prop(o, name) ?? null;
}

function visibleProps(o: Obj): Array<[string, Value]> {
  const own = Object.entries(o).filter(([k]) => !k.startsWith('__'));
  const extra = isObj(o.__extra) ? Object.entries(o.__extra as Obj) : [];
  return [...own, ...extra];
}

function setMember(_env: Env, target: Value, name: string, value: Value): void {
  if (!isObj(target)) throw rtError(target === null ? `The property '${name}' cannot be found on this object. Verify that the property exists and can be set.` : `'${name}' is a ReadOnly property.`, 'RuntimeException');
  const o = target as Obj;
  if (isDate(o) || isSpan(o)) throw rtError(`'${name}' is a ReadOnly property.`, 'RuntimeException');
  const k = keyOf(o, name);
  if (k) o[k] = value;
  else if (isHash(o) || o.__type === 'psobject' || o.__type === 'csv' || o.__type === 'select') o[name] = value;
  else throw rtError(`The property '${name}' cannot be found on this object. Verify that the property exists and can be set.`, 'RuntimeException');
}

function indexValue(env: Env, v: Value, idx: Value): Value {
  if (isArr(idx)) return idx.map((i) => indexValue(env, v, i));
  if (v === null || v === undefined) throw rtError('Cannot index into a null array.', 'RuntimeException');
  if (isHash(v)) {
    const k = keyOf(v as Obj, str(idx));
    return k === undefined ? null : (v as Obj)[k];
  }
  if (typeof v === 'string') {
    const i = num(idx);
    const j = i < 0 ? v.length + i : i;
    return v[j] ?? null;
  }
  const list = isArr(v) ? v : [v];
  const i = num(idx);
  const j = i < 0 ? list.length + i : i;
  return j >= 0 && j < list.length ? list[j] : null;
}

function method(name: string, args: Value[], n: number): void {
  if (args.length < n) throw rtError(`Cannot find an overload for "${name}" and the argument count: "${args.length}".`, 'MethodException');
}

export function invokeMethod(env: Env, v: Value, name: string, args: Value[]): Value {
  const n = name.toLowerCase();
  if (v === null || v === undefined) throw rtError('You cannot call a method on a null-valued expression.', 'RuntimeException');
  if (n === 'gettype') return typeObj(typeNameOf(v));
  if (n === 'tostring' && !(typeof v === 'number' && args.length) && !(isDate(v) && args.length)) return isDate(v) ? formatDate(msOf(v), 'dd/MM/yyyy HH:mm:ss') : str(v);
  if (n === 'equals') return scalarEq(v, args[0], true);
  if (n === 'gethashcode') return str(v).length * 31;
  if (typeof v === 'string') {
    const s = v;
    const a = (i: number) => str(args[i]);
    switch (n) {
      case 'toupper': case 'toupperinvariant': return s.toUpperCase();
      case 'tolower': case 'tolowerinvariant': return s.toLowerCase();
      case 'trim': return args.length ? trimChars(s, a(0), true, true) : s.trim();
      case 'trimstart': return args.length ? trimChars(s, a(0), true, false) : s.trimStart();
      case 'trimend': return args.length ? trimChars(s, a(0), false, true) : s.trimEnd();
      case 'split': {
        method(name, args, 1);
        const seps = asList(args[0]).flatMap((x) => (str(x).length > 1 && !isArr(args[0]) ? [...str(x)] : [str(x)]));
        const re = new RegExp(seps.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '\\s');
        let parts = s.split(re);
        if (args[1] !== undefined && typeof args[1] === 'number') {
          const max = args[1];
          if (parts.length > max) parts = [...parts.slice(0, max - 1), s.split(re).slice(max - 1).join(seps[0])];
        }
        if (args.some((x) => /RemoveEmptyEntries/i.test(str(x)))) parts = parts.filter(Boolean);
        return parts;
      }
      case 'replace': method(name, args, 2); return s.split(a(0)).join(a(1));
      case 'contains': method(name, args, 1); return s.includes(a(0));
      case 'startswith': method(name, args, 1); return args[1] !== undefined && /ignorecase/i.test(str(args[1])) ? s.toLowerCase().startsWith(a(0).toLowerCase()) : s.startsWith(a(0));
      case 'endswith': method(name, args, 1); return args[1] !== undefined && /ignorecase/i.test(str(args[1])) ? s.toLowerCase().endsWith(a(0).toLowerCase()) : s.endsWith(a(0));
      case 'indexof': method(name, args, 1); return s.indexOf(a(0), args[1] !== undefined ? num(args[1]) : 0);
      case 'lastindexof': method(name, args, 1); return s.lastIndexOf(a(0));
      case 'substring': {
        method(name, args, 1);
        const start = num(args[0]);
        if (start > s.length || start < 0) throw rtError(`Exception calling "Substring" with "${args.length}" argument(s): "startIndex cannot be larger than length of string."`, 'MethodInvocationException');
        if (args[1] !== undefined && start + num(args[1]) > s.length) throw rtError(`Exception calling "Substring" with "2" argument(s): "Index and length must refer to a location within the string."`, 'MethodInvocationException');
        return args[1] !== undefined ? s.substr(start, num(args[1])) : s.slice(start);
      }
      case 'padleft': method(name, args, 1); return s.padStart(num(args[0]), args[1] !== undefined ? a(1) : ' ');
      case 'padright': method(name, args, 1); return s.padEnd(num(args[0]), args[1] !== undefined ? a(1) : ' ');
      case 'insert': method(name, args, 2); return s.slice(0, num(args[0])) + a(1) + s.slice(num(args[0]));
      case 'remove': method(name, args, 1); return args[1] !== undefined ? s.slice(0, num(args[0])) + s.slice(num(args[0]) + num(args[1])) : s.slice(0, num(args[0]));
      case 'tochararray': return [...s];
      case 'compareto': return scalarCmp(s, args[0], true);
      case 'normalize': return s.normalize();
      case 'format': return formatComposite(s, args);
      case 'getbytes': return [...new TextEncoder().encode(s)];
    }
  }
  if (typeof v === 'number') {
    if (n === 'tostring') return args.length ? formatNumber(v, str(args[0])) : str(v);
    if (n === 'compareto') return v - num(args[0]);
  }
  if (isArr(v)) {
    switch (n) {
      case 'contains': return v.some((x) => scalarEq(x, args[0], true));
      case 'indexof': return v.findIndex((x) => scalarEq(x, args[0], true));
      case 'where': {
        const block = args[0];
        const mode = str(args[1] ?? 'Default').toLowerCase();
        const hits = v.filter((x) => truthy(collapse(runBlock(env, block, { dollarUnder: x }))));
        return mode === 'first' ? hits.slice(0, 1) : mode === 'last' ? hits.slice(-1) : mode === 'split' ? [hits, v.filter((x) => !hits.includes(x))] : hits;
      }
      case 'foreach': {
        const block = args[0];
        if (isBlock(block)) return v.flatMap((x) => runBlock(env, block, { dollarUnder: x }));
        return v.map((x) => getMember(env, x, str(block)));
      }
      case 'clone': return [...v];
      case 'add':
      case 'remove':
      case 'removeat':
      case 'insert':
      case 'clear':
      case 'addrange':
        if (!LISTS.has(v)) throw rtError(`Exception calling "${name}" with "${args.length}" argument(s): "Collection was of a fixed size."`, 'MethodInvocationException');
        if (n === 'add') {
          v.push(args[0]);
          return v.length - 1;
        }
        if (n === 'addrange') {
          v.push(...asList(args[0]));
          return undefined;
        }
        if (n === 'remove') {
          const i = v.findIndex((x) => scalarEq(x, args[0], true));
          if (i >= 0) v.splice(i, 1);
          return undefined;
        }
        if (n === 'removeat') {
          v.splice(num(args[0]), 1);
          return undefined;
        }
        if (n === 'insert') {
          v.splice(num(args[0]), 0, args[1]);
          return undefined;
        }
        v.length = 0;
        return undefined;
      case 'toarray': return [...v];
      case 'sort': v.sort((x, y) => scalarCmp(x, y, false)); return undefined;
      case 'reverse': v.reverse(); return undefined;
      case 'gethashcode': return v.length;
    }
  }
  if (isHash(v)) {
    const h = v as Obj;
    switch (n) {
      case 'containskey': return keyOf(h, str(args[0])) !== undefined;
      case 'containsvalue': return visibleProps(h).some(([, x]) => scalarEq(x, args[0], true));
      case 'add':
        method(name, args, 2);
        if (keyOf(h, str(args[0])) !== undefined) throw rtError(`Exception calling "Add" with "2" argument(s): "Item has already been added. Key in dictionary: '${str(args[0])}'  Key being added: '${str(args[0])}'"`, 'MethodInvocationException');
        h[str(args[0])] = args[1];
        return undefined;
      case 'remove': {
        const k = keyOf(h, str(args[0]));
        if (k) delete h[k];
        return undefined;
      }
      case 'clear':
        for (const k of Object.keys(h)) if (!k.startsWith('__')) delete h[k];
        return undefined;
      case 'getenumerator': return visibleProps(h).map(([k, x]) => ({ __type: 'psobject', Name: k, Key: k, Value: x }));
      case 'clone': return { ...h };
      case 'item': return getMember(env, h, str(args[0]));
    }
  }
  if (isDate(v)) {
    const ms = msOf(v);
    const d = new Date(ms);
    const addMonths = (k: number) => {
      const x = new Date(ms);
      x.setUTCMonth(x.getUTCMonth() + k);
      return makeDate(x.getTime());
    };
    switch (n) {
      case 'adddays': return makeDate(ms + num(args[0]) * 86400000);
      case 'addhours': return makeDate(ms + num(args[0]) * 3600000);
      case 'addminutes': return makeDate(ms + num(args[0]) * 60000);
      case 'addseconds': return makeDate(ms + num(args[0]) * 1000);
      case 'addmilliseconds': return makeDate(ms + num(args[0]));
      case 'addmonths': return addMonths(num(args[0]));
      case 'addyears': return addMonths(num(args[0]) * 12);
      case 'add': return makeDate(ms + msOf(args[0] as Obj));
      case 'subtract': return isDate(args[0]) ? makeSpan(ms - msOf(args[0] as Obj)) : makeDate(ms - msOf(args[0] as Obj));
      case 'tostring': return formatDate(ms, args.length ? str(args[0]) : 'dd/MM/yyyy HH:mm:ss');
      case 'toshortdatestring': return formatDate(ms, 'd');
      case 'tolongdatestring': return formatDate(ms, 'D');
      case 'toshorttimestring': return formatDate(ms, 't');
      case 'tolongtimestring': return formatDate(ms, 'T');
      case 'touniversaltime': case 'tolocaltime': return v;
      case 'compareto': return Math.sign(ms - msOf(convertTo('datetime', args[0]) as Obj));
      case 'getdatetimeformats': return [formatDate(ms, 'd')];
    }
    void d;
  }
  if (isSpan(v)) {
    if (n === 'tostring') return spanText(msOf(v));
    if (n === 'add') return makeSpan(msOf(v) + msOf(args[0] as Obj));
  }
  if (isBlock(v)) {
    if (n === 'invoke' || n === 'invokereturnasis') return collapse(runBlock(env, v, { args }));
    if (n === 'getnewclosure') return v;
  }
  if (isObj(v)) {
    const o = v as Obj;
    if (o.__type === 'regex') {
      const re = jsRegex(String(o.Pattern), false, n === 'matches' || n === 'replace');
      if (n === 'ismatch') return re.test(str(args[0]));
      if (n === 'match') return matchObj(re.exec(str(args[0])));
      if (n === 'matches') return [...str(args[0]).matchAll(re)].map((m) => matchObj(m));
      if (n === 'replace') return str(args[0]).replace(re, str(args[1]).replace(/\$\{(\w+)\}/g, '$<$1>'));
      if (n === 'split') return str(args[0]).split(re);
    }
    if (o.__type === 'credential' && n === 'getnetworkcredential') return { __type: 'psobject', UserName: str(o.UserName).replace(/^.*\\/, ''), Password: isSecure(o.Password) ? (o.Password as { plain: string }).plain : '', Domain: str(o.UserName).includes('\\') ? str(o.UserName).split('\\')[0] : '' };
    if (o.__type === 'pscmdlet') return cmdletMethod(env, o, n, args);
    if (o.__type === 'stringbuilder') {
      if (n === 'append' || n === 'appendline') {
        o.text = String(o.text ?? '') + str(args[0] ?? '') + (n === 'appendline' ? '\r\n' : '');
        return o;
      }
      if (n === 'tostring') return String(o.text ?? '');
    }
    if (o.__type === 'guid' && n === 'tostring') return String(o.Guid);
    if (o.__type === 'exception' && n === 'tostring') return `${o.__exType}: ${o.Message}`;
    if (typeof o.__methods === 'object' && o.__methods && typeof (o.__methods as Record<string, unknown>)[n] === 'function') return ((o.__methods as Record<string, (...a: Value[]) => Value>)[n])(...args);
    // Script methods added with Add-Member -MemberType ScriptMethod
    const sm = isObj(o.__scriptmethods) ? (o.__scriptmethods as Obj)[n] : undefined;
    if (sm) return collapse(runBlock(env, sm, { args, vars: { this: o } }));
  }
  throw rtError(`Method invocation failed because [${typeNameOf(v)}] does not contain a method named '${name}'.`, 'RuntimeException');
}

function matchObj(m: RegExpExecArray | RegExpMatchArray | null): Obj | null {
  if (!m) return { __type: 'match', Success: false, Value: '', Index: 0, Groups: [] };
  return { __type: 'match', Success: true, Value: m[0], Index: m.index ?? 0, Length: m[0].length, Groups: [...m].map((g, i) => ({ __type: 'psobject', Name: String(i), Value: g ?? '', Success: g !== undefined })) };
}

function trimChars(s: string, chars: string, start: boolean, end: boolean): string {
  let a = 0;
  let b = s.length;
  if (start) while (a < b && chars.includes(s[a])) a++;
  if (end) while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function cmdletMethod(env: Env, o: Obj, n: string, args: Value[]): Value {
  if (n === 'shouldprocess') {
    const target = str(args[0]);
    const action = args.length > 1 ? str(args[1]) : String(o.__command ?? '');
    if (truthy(getVariable(env, 'WhatIfPreference'))) {
      hostWrite(env, `What if: Performing the operation "${action}" on target "${target}".\n`);
      return false;
    }
    return true;
  }
  if (n === 'shouldcontinue') return true;
  if (n === 'writeverbose') {
    if (/continue/i.test(str(getVariable(env, 'VerbosePreference')))) hostWrite(env, `VERBOSE: ${str(args[0])}\n`);
    return undefined;
  }
  if (n === 'writewarning') {
    hostWrite(env, `WARNING: ${str(args[0])}\n`);
    return undefined;
  }
  if (n === 'throwterminatingerror') {
    const rec = isObj(args[0]) && (args[0] as Obj).__type === 'error' ? (args[0] as Obj) : errorRecord(str(args[0]));
    throw new RuntimeErr({ ...rec, __command: o.__command }, 'statement');
  }
  if (n === 'writeerror') {
    const rec = isObj(args[0]) && (args[0] as Obj).__type === 'error' ? (args[0] as Obj) : errorRecord(str(args[0]), 'WriteErrorException');
    reportError(env, { ...rec, __command: o.__command }, undefined, 'continue');
    return undefined;
  }
  throw rtError(`Method invocation failed because [System.Management.Automation.PSScriptCmdlet] does not contain a method named '${n}'.`, 'RuntimeException');
}

/* ----------------------------------------------------------------------------- static members */

let guidCounter = 0;

function staticMember(env: Env, type: string, name: string, args: Value[] | null): Value {
  const full = fullTypeName(type);
  const t = full.toLowerCase();
  const n = name.toLowerCase();
  const a = (i: number) => args?.[i];
  const call = args !== null;
  const unknown = (): never => {
    throw rtError(call ? `Method invocation failed because [${full}] does not contain a method named '${name}'.` : `The static property '${name}' cannot be found on type [${full}].`, 'RuntimeException');
  };
  if (n === 'new' && call) return construct(env, type, args!);
  switch (t) {
    case 'system.math': {
      const x = num(a(0));
      const map: Record<string, () => Value> = { round: () => roundEven(x, a(1) !== undefined ? num(a(1)) : 0), floor: () => Math.floor(x), ceiling: () => Math.ceil(x), truncate: () => Math.trunc(x), abs: () => Math.abs(x), sqrt: () => Math.sqrt(x), pow: () => Math.pow(x, num(a(1))), max: () => Math.max(x, num(a(1))), min: () => Math.min(x, num(a(1))), log: () => (a(1) !== undefined ? Math.log(x) / Math.log(num(a(1))) : Math.log(x)), log10: () => Math.log10(x), exp: () => Math.exp(x), sign: () => Math.sign(x), pi: () => Math.PI, e: () => Math.E };
      return (map[n] ?? unknown)();
    }
    case 'system.string':
      if (n === 'isnullorempty') return a(0) === null || a(0) === undefined || str(a(0)) === '';
      if (n === 'isnullorwhitespace') return a(0) === null || a(0) === undefined || str(a(0)).trim() === '';
      if (n === 'join') return (args!.length === 2 ? asList(a(1)) : args!.slice(1)).map(str).join(str(a(0)));
      if (n === 'format') return formatComposite(str(a(0)), args!.length === 2 && isArr(a(1)) ? (a(1) as Value[]) : args!.slice(1));
      if (n === 'concat') return args!.map(str).join('');
      if (n === 'empty') return '';
      if (n === 'compare') return scalarCmp(a(0), a(1), !(a(2) === true));
      return unknown();
    case 'system.datetime':
      if (n === 'now' || n === 'utcnow') return makeDate(env.sys.now);
      if (n === 'today') {
        const d = new Date(env.sys.now);
        return makeDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      }
      if (n === 'parse' || n === 'parseexact') {
        if (n === 'parseexact') {
          const v = parseExact(str(a(0)), str(a(1)));
          if (v === null) throw rtError(`Exception calling "ParseExact" with "${args!.length}" argument(s): "String was not recognized as a valid DateTime."`, 'MethodInvocationException');
          return makeDate(v);
        }
        const v = parseDateText(str(a(0)));
        if (v === null) throw rtError(`Exception calling "Parse" with "1" argument(s): "String was not recognized as a valid DateTime."`, 'MethodInvocationException');
        return makeDate(v);
      }
      if (n === 'daysinmonth') return new Date(Date.UTC(num(a(0)), num(a(1)), 0)).getUTCDate();
      if (n === 'isleapyear') return new Date(Date.UTC(num(a(0)), 1, 29)).getUTCDate() === 29;
      if (n === 'minvalue') return makeDate(Date.UTC(1, 0, 1));
      if (n === 'maxvalue') return makeDate(Date.UTC(9999, 11, 31, 23, 59, 59));
      return unknown();
    case 'system.timespan': {
      const x = num(a(0));
      const map: Record<string, number> = { fromdays: 86400000, fromhours: 3600000, fromminutes: 60000, fromseconds: 1000, frommilliseconds: 1 };
      if (map[n]) return makeSpan(x * map[n]);
      if (n === 'zero') return makeSpan(0);
      return unknown();
    }
    case 'system.int32':
    case 'system.int64':
    case 'system.double':
    case 'system.decimal':
      if (n === 'parse') return convertTo(full, a(0));
      if (n === 'maxvalue') return t === 'system.int32' ? 2147483647 : Number.MAX_SAFE_INTEGER;
      if (n === 'minvalue') return t === 'system.int32' ? -2147483648 : Number.MIN_SAFE_INTEGER;
      if (n === 'tryparse') {
        try {
          const v = convertTo(full, a(0));
          if (isObj(a(1)) && (a(1) as Obj).__type === 'ref') ((a(1) as Obj).set_ as (x: Value) => void)(v);
          return true;
        } catch {
          return false;
        }
      }
      return unknown();
    case 'system.guid':
      if (n === 'newguid') {
        const h = (k: number) => ((env.sys.now + ++guidCounter * 2654435761 + k * 40503) >>> 0).toString(16).padStart(8, '0');
        const s = `${h(1)}-${h(2).slice(0, 4)}-4${h(3).slice(0, 3)}-a${h(4).slice(0, 3)}-${h(5)}${h(6).slice(0, 4)}`;
        return { __type: 'guid', Guid: s };
      }
      if (n === 'empty') return { __type: 'guid', Guid: '00000000-0000-0000-0000-000000000000' };
      return unknown();
    case 'system.io.path': {
      const p = str(a(0)).replace(/\//g, '\\');
      const leaf = p.replace(/^.*\\/, '');
      const map: Record<string, () => Value> = {
        getfilename: () => leaf,
        getextension: () => (/\.[^.]*$/.exec(leaf)?.[0] ?? ''),
        getfilenamewithoutextension: () => leaf.replace(/\.[^.]*$/, ''),
        getdirectoryname: () => p.replace(/\\[^\\]*$/, ''),
        combine: () => args!.map((x) => str(x).replace(/\\+$/, '')).join('\\'),
        join: () => args!.map((x) => str(x).replace(/\\+$/, '')).join('\\'),
        gettemppath: () => `C:\\Users\\${env.sys.user}\\AppData\\Local\\Temp\\`,
        gettempfilename: () => `C:\\Users\\${env.sys.user}\\AppData\\Local\\Temp\\tmp${(++guidCounter).toString(16).toUpperCase().padStart(4, '0')}.tmp`,
        getrandomfilename: () => `${(env.sys.now + ++guidCounter).toString(36).slice(-8)}.${(guidCounter * 7).toString(36).padStart(3, 'x').slice(-3)}`,
        changeextension: () => p.replace(/\.[^.\\]*$/, '') + str(a(1)),
        ispathrooted: () => /^[A-Za-z]:\\|^\\\\/.test(p),
        getinvalidfilenamechars: () => ['"', '<', '>', '|', ':', '*', '?', '\\', '/'],
      };
      return (map[n] ?? unknown)();
    }
    case 'system.io.file':
    case 'system.io.directory': {
      const vfs = toVfs(env, str(a(0)));
      const l = lookup(env.sys.fs, vfs, ROOT);
      if (n === 'exists') return t === 'system.io.file' ? !!l && l.node.type === 'file' : !!l && l.node.type === 'dir';
      if (n === 'readalltext') {
        if (!l || l.node.type !== 'file') throw rtError(`Exception calling "ReadAllText" with "1" argument(s): "Could not find file '${str(a(0))}'."`, 'MethodInvocationException');
        return l.node.content;
      }
      if (n === 'readalllines') {
        if (!l || l.node.type !== 'file') throw rtError(`Exception calling "ReadAllLines" with "1" argument(s): "Could not find file '${str(a(0))}'."`, 'MethodInvocationException');
        return l.node.content.replace(/\r?\n$/, '').split(/\r?\n/);
      }
      if (n === 'writealltext' || n === 'appendalltext' || n === 'writealllines') {
        const text = n === 'writealllines' ? asList(a(1)).map(str).join('\r\n') + '\r\n' : str(a(1));
        const prev = n === 'appendalltext' && l && l.node.type === 'file' ? l.node.content : '';
        writeFile(env.sys.fs, vfs, prev + text, ROOT, env.sys.now);
        return undefined;
      }
      if (n === 'createdirectory') {
        mkdir(env.sys.fs, vfs, ROOT, env.sys.now, true);
        return undefined;
      }
      return unknown();
    }
    case 'system.environment': {
      const map: Record<string, () => Value> = { machinename: () => machine(env).name, username: () => env.sys.user, userdomainname: () => env.st.netbios, newline: () => '\r\n', osversion: () => ({ __type: 'psobject', Platform: 'Win32NT', VersionString: 'Microsoft Windows NT 10.0.20348.0' }), currentdirectory: () => toWin(env.sys.cwd), processorcount: () => 4, is64bitoperatingsystem: () => true, getenvironmentvariable: () => envVar(env, str(a(0))), tickcount: () => env.sys.now % 2147483647, getfolderpath: () => `C:\\Users\\${env.sys.user}\\Documents` };
      return (map[n] ?? unknown)();
    }
    case 'system.convert': {
      if (n === 'tobase64string') {
        const bytes = asList(a(0)).map((x) => num(x));
        return btoa(String.fromCharCode(...bytes));
      }
      if (n === 'frombase64string') {
        try {
          return [...atob(str(a(0)))].map((c) => c.charCodeAt(0));
        } catch {
          throw rtError(`Exception calling "FromBase64String" with "1" argument(s): "The input is not a valid Base-64 string."`, 'MethodInvocationException');
        }
      }
      if (n === 'toint32') return convertTo('int', a(0));
      if (n === 'tostring') return str(a(0));
      if (n === 'toboolean') return truthy(a(0));
      if (n === 'todatetime') return convertTo('datetime', a(0));
      return unknown();
    }
    case 'system.text.encoding': {
      if (['utf8', 'ascii', 'unicode', 'default'].includes(n)) return { __type: 'encoding', Name: n, __methods: { getbytes: (s: Value) => [...new TextEncoder().encode(str(s))], getstring: (b: Value) => new TextDecoder().decode(Uint8Array.from(asList(b).map((x) => num(x)))) } };
      return unknown();
    }
    case 'system.text.regularexpressions.regex': {
      const re = (g: boolean) => jsRegex(str(a(1)), false, g);
      if (n === 'escape') return str(a(0)).replace(/[.*+?^${}()|[\]\\\s#]/g, '\\$&');
      if (n === 'ismatch') return re(false).test(str(a(0)));
      if (n === 'match') return matchObj(re(false).exec(str(a(0))));
      if (n === 'matches') return [...str(a(0)).matchAll(re(true))].map((m) => matchObj(m));
      if (n === 'replace') return str(a(0)).replace(re(true), str(a(2)).replace(/\$\{(\w+)\}/g, '$<$1>'));
      if (n === 'split') return str(a(0)).split(re(false));
      return unknown();
    }
    case 'system.web.security.membership':
      if (n === 'generatepassword') {
        const len = num(a(0));
        const special = num(a(1) ?? 2);
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        const sym = '!@#$%^&*-_=+';
        let seed = (env.sys.now + ++guidCounter * 7919) >>> 0;
        const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
        const out = Array.from({ length: len }, (_, i) => (i < special ? sym[Math.floor(rnd() * sym.length)] : chars[Math.floor(rnd() * chars.length)]));
        return out.sort(() => rnd() - 0.5).join('');
      }
      return unknown();
    case 'system.management.automation.psobject':
    case 'system.object':
      return unknown();
  }
  if (/collections\.generic\.list|arraylist/i.test(t) && n === 'new') return construct(env, type, args ?? []);
  throw rtError(`Unable to find type [${type}].`, 'RuntimeException');
}

function parseExact(s: string, fmt: string): number | null {
  const tokens = fmt.match(/yyyy|MM|dd|HH|mm|ss|M|d|H|./g) ?? [];
  let re = '^';
  const order: string[] = [];
  for (const t of tokens) {
    if (/^(yyyy|MM|dd|HH|mm|ss|M|d|H)$/.test(t)) {
      re += t === 'yyyy' ? '(\\d{4})' : t.length === 2 ? '(\\d{2})' : '(\\d{1,2})';
      order.push(t[0]);
    } else re += t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const m = new RegExp(re + '$').exec(s);
  if (!m) return null;
  const part: Record<string, number> = { y: 1, M: 1, d: 1, H: 0, m: 0, s: 0 };
  order.forEach((k, i) => (part[k] = Number(m[i + 1])));
  return Date.UTC(part.y, part.M - 1, part.d, part.H, part.m, part.s);
}

/** New-Object and [type]::new(). */
export function construct(_env: Env, type: string, args: Value[]): Value {
  const full = fullTypeName(type).toLowerCase();
  if (/arraylist|collections\.generic\.list/.test(full)) {
    const l: Value[] = args.length && isArr(args[0]) ? [...(args[0] as Value[])] : [];
    LISTS.add(l);
    return l;
  }
  if (/hashtable|ordereddictionary|dictionary/.test(full)) return { __type: 'hashtable' };
  if (/psobject|pscustomobject|system\.object$/.test(full)) return { __type: 'psobject' };
  if (/pscredential/.test(full)) return { __type: 'credential', UserName: str(args[0]), Password: args[1] };
  if (/stringbuilder/.test(full)) return { __type: 'stringbuilder', text: str(args[0] ?? '') };
  if (/datetime/.test(full)) return makeDate(Date.UTC(num(args[0]), num(args[1] ?? 1) - 1, num(args[2] ?? 1), num(args[3] ?? 0), num(args[4] ?? 0), num(args[5] ?? 0)));
  if (/timespan/.test(full)) return makeSpan(args.length >= 3 ? ((args.length === 4 ? num(args[0]) * 86400 : 0) + num(args[args.length - 3]) * 3600 + num(args[args.length - 2]) * 60 + num(args[args.length - 1])) * 1000 : num(args[0]) / 10000);
  if (/regex/.test(full)) return { __type: 'regex', Pattern: str(args[0]) };
  if (/version/.test(full)) return convertTo('version', args.map(str).join('.'));
  if (/securestring/.test(full)) return { __secure: true, plain: '' };
  if (/exception/.test(full)) return { __type: 'exception', Message: str(args[0] ?? `Exception of type '${fullTypeName(type)}' was thrown.`), __exType: fullTypeName(type) };
  if (/system\.net\.webclient/.test(full)) throw rtError('System.Net.WebClient is not simulated: use Invoke-RestMethod or Invoke-WebRequest.', 'RuntimeException');
  if (/mailaddress/.test(full)) {
    const s = str(args[0]);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw rtError(`Exception calling ".ctor" with "1" argument(s): "The specified string is not in the form required for an e-mail address."`, 'MethodInvocationException');
    return { __type: 'psobject', Address: s, User: s.split('@')[0], Host: s.split('@')[1] };
  }
  throw rtError(`Cannot find type [${type}]: verify that the assembly containing this type is loaded.`, 'PSArgumentException');
}

/* ----------------------------------------------------------------------------- evaluation */

interface RunOpts {
  dollarUnder?: Value;
  args?: Value[];
  vars?: Record<string, Value>;
  input?: Value[];
  newScope?: boolean;
  emit?: (v: Value) => void;
  bound?: Record<string, Value>;
}

export function evalExpr(env: Env, e: Expr): Value {
  switch (e.t) {
    case 'num':
      return e.v;
    case 'str':
      return e.v;
    case 'xstr':
      return e.parts.map((p) => (typeof p === 'string' ? p : interp(env, evalExpr(env, p)))).join('');
    case 'var':
      return getVariable(env, e.name, e.scope);
    case 'bare': {
      const subject = env.filterSubject;
      if (subject !== undefined) return getMember(env, subject, e.name);
      return e.name;
    }
    case 'type':
      return typeObj(e.name);
    case 'member': {
      const name = typeof e.name === 'string' ? e.name : str(evalExpr(env, e.name));
      if (e.static) {
        const t = e.obj.t === 'type' ? e.obj.name : String((evalExpr(env, e.obj) as Obj)?.FullName ?? '');
        return staticMember(env, t, name, null);
      }
      return getMember(env, evalExpr(env, e.obj), name);
    }
    case 'invoke': {
      const args = e.args.map((a) => evalExpr(env, a));
      if (e.static) {
        const t = e.obj.t === 'type' ? e.obj.name : String((evalExpr(env, e.obj) as Obj)?.FullName ?? '');
        return staticMember(env, t, e.name, args);
      }
      const target = evalExpr(env, e.obj);
      if (isArr(target) && !['count', 'contains', 'indexof', 'where', 'foreach', 'clone', 'add', 'remove', 'removeat', 'insert', 'clear', 'addrange', 'toarray', 'gettype', 'tostring', 'equals', 'sort', 'reverse', 'gethashcode'].includes(e.name.toLowerCase())) {
        // Method calls on a collection apply to each element (member enumeration).
        return target.map((x) => invokeMethod(env, x, e.name, args));
      }
      return invokeMethod(env, target, e.name, args);
    }
    case 'index':
      return indexValue(env, evalExpr(env, e.obj), evalExpr(env, e.index));
    case 'array':
      return e.items.map((x) => evalExpr(env, x));
    case 'sub': {
      const out = collect(env, (emit) => execStmts(env, e.body, emit));
      return e.array ? out : collapse(out);
    }
    case 'paren': {
      if (e.body.t === 'pipe' && e.body.elems.length === 1 && e.body.elems[0].t === 'expr' && !e.body.elems[0].redirs.length) return evalExpr(env, e.body.elems[0].e);
      if (e.body.t === 'assign') {
        execStmt(env, e.body, () => {});
        return evalExpr(env, e.body.target);
      }
      return collapse(collect(env, (emit) => execStmt(env, e.body, emit)));
    }
    case 'hash': {
      const h: Obj = { __type: 'hashtable' };
      for (const ent of e.entries) {
        const k = str(evalExpr(env, ent.key));
        if (keyOf(h, k) !== undefined) throw rtError(`Duplicate keys '${k}' are not allowed in hash literals.`, 'ParseException');
        h[k] = stmtValue(env, ent.value);
      }
      return h;
    }
    case 'block':
      return { __type: 'block', src: e.src, __line: e.line };
    case 'unary': {
      const v = evalExpr(env, e.e);
      switch (e.op) {
        case 'not':
          return !truthy(v);
        case 'bnot':
          return ~num(v);
        case '-':
          return isSpan(v) ? makeSpan(-msOf(v)) : -num(v);
        case '+':
          return num(v);
        case 'split':
          return asList(v).flatMap((s) => str(s).trim().split(/\s+/).filter(Boolean));
        case 'join':
          return asList(v).map(str).join('');
      }
      return v;
    }
    case 'incdec': {
      const old = evalExpr(env, e.e);
      const nv = num(old) + (e.op === '++' ? 1 : -1);
      assignTo(env, e.e, nv);
      return e.prefix ? nv : old;
    }
    case 'bin': {
      if (e.op === 'and') return truthy(evalExpr(env, e.l)) && truthy(evalExpr(env, e.r));
      if (e.op === 'or') return truthy(evalExpr(env, e.l)) || truthy(evalExpr(env, e.r));
      return binaryOp(env, e.op, evalExpr(env, e.l), evalExpr(env, e.r));
    }
    case 'cast': {
      const v = evalExpr(env, e.e);
      return convertTo(e.type, v);
    }
  }
}

/** A value inside a double-quoted string: arrays join with $OFS, dates use the invariant format. */
function interp(env: Env, v: Value): string {
  if (isArr(v)) return v.map((x) => interp(env, x)).join(str(getVariable(env, 'OFS') ?? ' '));
  return str(v);
}

/** The value of a statement used as a value: an expression keeps its shape; pipelines collapse. */
export function stmtValue(env: Env, s: Stmt): Value {
  if (s.t === 'pipe' && s.elems.length === 1 && s.elems[0].t === 'expr' && !s.elems[0].redirs.length) return evalExpr(env, s.elems[0].e);
  if (s.t === 'assign') {
    execStmt(env, s, () => {});
    return evalExpr(env, s.target);
  }
  return collapse(collect(env, (emit) => execStmt(env, s, emit)));
}

function collect(_env: Env, run: (emit: (v: Value) => void) => void): Value[] {
  const out: Value[] = [];
  run((v) => out.push(v));
  return out;
}

function assignTo(env: Env, target: Expr, value: Value): void {
  if (target.t === 'var') {
    setVariable(env, target.name, value, target.scope);
    return;
  }
  if (target.t === 'cast' && target.e.t === 'var') {
    setVariable(env, target.e.name, convertTo(target.type, value), target.e.scope);
    return;
  }
  if (target.t === 'member') {
    const obj = evalExpr(env, target.obj);
    setMember(env, obj, typeof target.name === 'string' ? target.name : str(evalExpr(env, target.name)), value);
    return;
  }
  if (target.t === 'index') {
    const obj = evalExpr(env, target.obj);
    const idx = evalExpr(env, target.index);
    if (isHash(obj)) {
      const k = keyOf(obj as Obj, str(idx));
      (obj as Obj)[k ?? str(idx)] = value;
      return;
    }
    if (isArr(obj)) {
      const i = num(idx);
      const j = i < 0 ? obj.length + i : i;
      if (j < 0 || j >= obj.length) throw rtError('Index was outside the bounds of the array.', 'RuntimeException');
      obj[j] = value;
      return;
    }
    if (isObj(obj)) {
      setMember(env, obj, str(idx), value);
      return;
    }
    throw rtError('Unable to index into an object of type ' + typeNameOf(obj) + '.', 'RuntimeException');
  }
  throw rtError('The assignment expression is not valid. The input to an assignment operator must be an object that is able to accept assignments, such as a variable or a property.', 'ParseException');
}

/* ----------------------------------------------------------------------------- statements */

export function execStmts(env: Env, stmts: Stmt[], emit: (v: Value) => void): void {
  for (const s of stmts) {
    try {
      execStmt(env, s, emit);
    } catch (e) {
      // A statement-terminating error outside any try ends only this statement.
      if (e instanceof RuntimeErr && e.kind === 'statement' && !(env.tryDepth ?? 0)) {
        reportTerminating(env, e, s);
        continue;
      }
      throw e;
    }
  }
}

function lineOf(s: Stmt): number {
  return s.line;
}

function reportTerminating(env: Env, e: RuntimeErr, s: Stmt): void {
  const inv = e.record.InvocationInfo as Obj | undefined;
  if (inv && !inv.ScriptLineNumber && env.scriptPath) {
    inv.ScriptLineNumber = lineOf(s);
    inv.ScriptName = env.scriptPath;
  }
  remember(env, e.record);
  env.ok = false;
  hostWrite(env, errorText(e.record));
}

function loop(label: string | undefined, body: () => void): 'break' | 'continue' | 'normal' {
  try {
    body();
    return 'normal';
  } catch (e) {
    if (e instanceof BreakEx && (!e.label || e.label.toLowerCase() === label?.toLowerCase())) return 'break';
    if (e instanceof ContinueEx && (!e.label || e.label.toLowerCase() === label?.toLowerCase())) return 'continue';
    throw e;
  }
}

let loopGuard = 0;
function guard(): void {
  if (++loopGuard > 200000) {
    loopGuard = 0;
    throw rtError('The loop ran more than 200000 times; the simulator stopped it.', 'RuntimeException', 'script');
  }
}

export function execStmt(env: Env, s: Stmt, emit: (v: Value) => void): void {
  switch (s.t) {
    case 'pipe':
      execPipe(env, s, emit);
      return;
    case 'assign': {
      let value = stmtValue(env, s.value);
      if (s.op !== '=') {
        const old = evalExpr(env, s.target);
        const op = s.op.slice(0, -1);
        value = op === '??' ? (old === null || old === undefined ? value : old) : binaryOp(env, op, old, value);
      }
      if (value === undefined) value = null;
      assignTo(env, s.target, value);
      env.ok = true;
      return;
    }
    case 'if':
      for (const c of s.clauses) {
        if (truthy(stmtValue(env, c.cond))) {
          execStmts(env, c.body, emit);
          return;
        }
      }
      if (s.else) execStmts(env, s.else, emit);
      return;
    case 'foreach': {
      const items = asList(stmtValue(env, s.src));
      for (const item of items) {
        guard();
        setVariable(env, s.v, item);
        const r = loop(s.label, () => execStmts(env, s.body, emit));
        if (r === 'break') break;
      }
      return;
    }
    case 'for': {
      if (s.init) execStmt(env, s.init, () => {});
      for (;;) {
        guard();
        if (s.cond && !truthy(stmtValue(env, s.cond))) break;
        const r = loop(s.label, () => execStmts(env, s.body, emit));
        if (r === 'break') break;
        if (s.step) execStmt(env, s.step, () => {});
      }
      return;
    }
    case 'while':
      while (truthy(stmtValue(env, s.cond))) {
        guard();
        if (loop(s.label, () => execStmts(env, s.body, emit)) === 'break') break;
      }
      return;
    case 'do':
      for (;;) {
        guard();
        if (loop(s.label, () => execStmts(env, s.body, emit)) === 'break') break;
        const c = truthy(stmtValue(env, s.cond));
        if (s.until ? c : !c) break;
      }
      return;
    case 'switch':
      execSwitch(env, s, emit);
      return;
    case 'try':
      execTry(env, s, emit);
      return;
    case 'throw': {
      const v = s.value ? stmtValue(env, s.value) : null;
      let rec: Obj;
      if (isObj(v) && (v as Obj).__type === 'error') rec = v as Obj;
      else if (isObj(v) && (v as Obj).__type === 'exception') rec = errorRecord(String((v as Obj).Message), String((v as Obj).__exType));
      else if (isType(v)) rec = errorRecord(`Exception of type '${(v as Obj).FullName}' was thrown.`, String((v as Obj).FullName));
      else rec = errorRecord(v === null ? 'ScriptHalted' : str(v), 'RuntimeException', { target: v ?? undefined });
      const inv = rec.InvocationInfo as Obj;
      if (env.scriptPath && !inv.ScriptLineNumber) {
        inv.ScriptLineNumber = s.line;
        inv.ScriptName = env.scriptPath;
      }
      throw new RuntimeErr(rec, 'script');
    }
    case 'return':
      if (s.value) emitValue(stmtValue(env, s.value), emit);
      throw new ReturnEx();
    case 'break':
      throw new BreakEx(s.label);
    case 'continue':
      throw new ContinueEx(s.label);
    case 'exit':
      throw new ExitEx(s.value ? num(stmtValue(env, s.value)) : 0);
    case 'func':
      env.vars.set('function:' + s.name.toLowerCase(), { __type: 'function', Name: s.name, CommandType: s.filter ? 'Filter' : 'Function', __block: s.block, __filter: s.filter, __src: s.src, __script: env.scriptPath ?? '' } as Obj);
      // Functions defined in a function or script body are visible to the rest of the run.
      return;
    case 'trap':
      return;
  }
}

function execTry(env: Env, s: Extract<Stmt, { t: 'try' }>, emit: (v: Value) => void): void {
  env.tryDepth = (env.tryDepth ?? 0) + 1;
  let pending: unknown;
  try {
    try {
      execStmts(env, s.body, emit);
    } finally {
      env.tryDepth--;
    }
  } catch (e) {
    if (e instanceof RuntimeErr) {
      const clause = s.catches.find((c) => catchMatches(e.record, c.types));
      if (clause) {
        remember(env, e.record);
        const saved = getVariable(env, '_');
        const savedItem = getVariable(env, 'PSItem');
        setVariable(env, '_', e.record);
        setVariable(env, 'PSItem', e.record);
        try {
          execStmts(env, clause.body, emit);
        } catch (inner) {
          pending = inner;
        } finally {
          setVariable(env, '_', saved);
          setVariable(env, 'PSItem', savedItem);
        }
      } else pending = e;
    } else pending = e;
  }
  if (s.fin) execStmts(env, s.fin, emit);
  if (pending !== undefined) throw pending;
}

function execSwitch(env: Env, s: Extract<Stmt, { t: 'switch' }>, emit: (v: Value) => void): void {
  const regex = s.flags.includes('regex');
  const wildcard = s.flags.includes('wildcard');
  const cs = s.flags.includes('casesensitive');
  let items: Value[];
  if (s.file) {
    const path = toVfs(env, str(evalExpr(env, s.file)));
    try {
      items = readFile(env.sys.fs, path, ROOT).replace(/\r?\n$/, '').split(/\r?\n/);
    } catch {
      throw rtError(`Cannot find path '${str(evalExpr(env, s.file))}' because it does not exist.`, 'ItemNotFoundException');
    }
  } else items = asList(stmtValue(env, s.subject!));
  if (s.subject && !s.file && items.length === 0) items = [null];
  const savedUnder = getVariable(env, '_');
  try {
    outer: for (const item of items) {
      guard();
      setVariable(env, '_', item);
      let matched = false;
      for (const c of s.clauses) {
        if (c.pat === null) continue;
        let hit: boolean;
        if (c.pat.t === 'block') hit = truthy(collapse(runBlock(env, evalExpr(env, c.pat), { dollarUnder: item, newScope: false })));
        else {
          const pv = evalExpr(env, c.pat);
          if (regex) {
            const m = jsRegex(str(pv), cs).exec(str(item));
            hit = !!m;
            if (m) {
              const h: Obj = { __type: 'hashtable' };
              m.forEach((g, i) => g !== undefined && (h[String(i)] = g));
              for (const [k, g] of Object.entries(m.groups ?? {})) if (g !== undefined) h[k] = g;
              setVariable(env, 'Matches', h);
            }
          } else if (wildcard) hit = likeRegex(str(pv), cs).test(str(item));
          else hit = scalarEq(typeof item === 'number' ? item : str(item), pv, cs) || scalarEq(pv, item, cs);
        }
        if (hit) {
          matched = true;
          const r = loop(undefined, () => execStmts(env, c.body, emit));
          if (r === 'break') break outer;
          if (r === 'continue') continue outer;
        }
      }
      if (!matched) {
        const d = s.clauses.find((c) => c.pat === null);
        if (d) {
          const r = loop(undefined, () => execStmts(env, d.body, emit));
          if (r === 'break') break;
        }
      }
    }
  } finally {
    setVariable(env, '_', savedUnder);
  }
}

/* ----------------------------------------------------------------------------- pipelines and commands */

function execPipe(env: Env, s: Extract<Stmt, { t: 'pipe' }>, emit: (v: Value) => void): void {
  env.line = s.line;
  let input: Value[] | undefined;
  for (let k = 0; k < s.elems.length; k++) {
    const last = k === s.elems.length - 1;
    const el = s.elems[k];
    const out: Value[] = [];
    const sink = last && !el.redirs.length ? emit : (v: Value) => out.push(v);
    env.line = s.line;
    runElement(env, el, input, sink, last);
    if (el.redirs.length) {
      redirect(env, el.redirs, out);
      if (last) for (const v of el.redirs.some((r) => r.stream === '1' || r.stream === '*') ? [] : out) emit(v);
    }
    input = out;
  }
}

function redirect(env: Env, redirs: Elem['redirs'], values: Value[]): void {
  for (const r of redirs) {
    if (r.op === 'merge' || !r.target) continue;
    if (r.stream !== '1' && r.stream !== '*') continue;
    const target = str(evalExpr(env, r.target));
    if (target === '$null' || r.target.t === 'var' && (r.target as { name: string }).name.toLowerCase() === 'null') continue;
    const text = render(values).replace(/^\n/, '');
    const vfs = toVfs(env, target);
    let prev = '';
    if (r.op === '>>') {
      try {
        prev = readFile(env.sys.fs, vfs, ROOT);
      } catch {
        /* new file */
      }
    }
    try {
      writeFile(env.sys.fs, vfs, prev + text, ROOT, env.sys.now);
    } catch {
      throw rtError(`Could not find a part of the path '${target}'.`, 'DirectoryNotFoundException');
    }
  }
}

function runElement(env: Env, el: Elem, input: Value[] | undefined, emit: (v: Value) => void, last: boolean): void {
  if (el.t === 'expr') {
    const v = evalExpr(env, el.e);
    // ++ and -- used as statements change the variable without writing output.
    if (el.e.t !== 'incdec') emitValue(v, emit);
    env.ok = true;
    return;
  }
  // Name: a string (command or path), a script block (& { }), or a value from a variable.
  let target: Value;
  if (el.name.t === 'block') target = evalExpr(env, el.name);
  else target = evalExpr(env, el.name);
  const args = el.args;
  if (isBlock(target)) {
    const { positional, named } = evalArgs(env, args);
    for (const v of runBlock(env, target, { args: [...positional, ...Object.entries(named).flatMap(([k, v]) => [`-${k}`, v])], input, newScope: el.call !== '.' })) emit(v);
    return;
  }
  if (isObj(target) && (target as Obj).__type === 'function') {
    callFunction(env, target as Obj, args, input, emit, String((target as Obj).Name));
    return;
  }
  const name = str(target);
  invokeByName(env, name, el, input, emit, last);
}

/** Evaluated arguments: positional values and named parameters (a switch is true unless given a value). */
interface EvalArg {
  kind: 'param' | 'arg';
  name?: string;
  value?: Value;
  hasValue?: boolean;
  text: string;
}

function evalArgList(env: Env, args: Arg[]): EvalArg[] {
  const out: EvalArg[] = [];
  for (const a of args) {
    if (a.t === 'splat') {
      const v = getVariable(env, a.name);
      if (isHash(v)) for (const [k, x] of visibleProps(v as Obj)) out.push({ kind: 'param', name: k, value: x, hasValue: true, text: `-${k}` });
      else for (const x of asList(v)) out.push({ kind: 'arg', value: x, text: str(x) });
      continue;
    }
    if (a.t === 'param') {
      out.push({ kind: 'param', name: a.name, value: a.value ? evalExpr(env, a.value) : undefined, hasValue: !!a.value, text: a.text });
      continue;
    }
    out.push({ kind: 'arg', value: a.e.t === 'block' ? { __type: 'block', src: a.e.src, __line: a.e.line } : evalExpr(env, a.e), text: a.text });
  }
  return out;
}

function evalArgs(env: Env, args: Arg[]): { positional: Value[]; named: Record<string, Value> } {
  const list = evalArgList(env, args);
  const positional: Value[] = [];
  const named: Record<string, Value> = {};
  for (const a of list) {
    if (a.kind === 'param') named[a.name!] = a.hasValue ? a.value! : true;
    else positional.push(a.value!);
  }
  return { positional, named };
}

const STATE_VERBS = /^(new|set|remove|add|stop|start|restart|disable|enable|move|rename|clear|copy|install|uninstall|register|unregister|grant|revoke|reset|unlock|suspend|resume|update|initialize|format|mount|dismount|publish|unpublish|import|export|out|send)-/i;

function invokeByName(env: Env, name: string, el: Extract<Elem, { t: 'cmd' }>, input: Value[] | undefined, emit: (v: Value) => void, last: boolean): void {
  void last;
  const key = name.toLowerCase();
  // Functions defined in this session (and Pester mocks) win over cmdlets.
  const mock = (env.mocks as Map<string, Obj> | undefined)?.get(key) ?? (env.mocks as Map<string, Obj> | undefined)?.get(ALIASES[key] ?? '');
  const fn = env.vars.get('function:' + key) as Obj | undefined;
  if (mock) {
    callMock(env, mock, el, input, emit);
    return;
  }
  if (fn) {
    callFunction(env, fn, el.args, input, emit, name);
    return;
  }
  const resolved = ALIASES[key] ?? key;
  const aliasFn = env.vars.get('function:' + resolved) as Obj | undefined;
  if (aliasFn) {
    callFunction(env, aliasFn, el.args, input, emit, name);
    return;
  }
  // Script files: .\x.ps1, C:\x\y.ps1
  if (/\.ps1$/i.test(name) || /^\.{1,2}[\\/]/.test(name) || /^[A-Za-z]:\\/.test(name)) {
    if (/\.ps1$/i.test(name)) {
      runScriptFile(env, name, el, input, emit);
      return;
    }
  }
  const cmdlet = CMDLET_TABLE[resolved];
  const native = NATIVE_TABLE[resolved] ?? NATIVE_TABLE[resolved.replace(/\.exe$/, '')];
  if (!cmdlet && !native) {
    // Commands from modules on disk load automatically on first use.
    if (autoloadModule(env, key)) {
      invokeByName(env, name, el, input, emit, last);
      return;
    }
    throw rtError(`The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`, 'CommandNotFoundException', 'statement', { target: name, category: 'ObjectNotFound', id: 'CommandNotFoundException' });
  }
  const list = evalArgList(env, el.args);
  if (!cmdlet && native) {
    const raw = list.map((a) => (a.kind === 'param' ? `-${a.name}${a.hasValue ? ':' + str(a.value) : ''}` : str(a.value)));
    const cx = makeCx(env, { name, positional: list.filter((a) => a.kind === 'arg').map((a) => a.value!), params: {} }, input);
    let out: Value[];
    try {
      out = native(raw, cx);
    } catch (e) {
      if (e instanceof PsError) {
        handleCmdletError(env, name, e, {}, resolved);
        return;
      }
      throw e;
    }
    // A native tool may report an exit code (robocopy, winget ...).
    const code = Number(env.vars.get('__exitcode') ?? 0);
    env.vars.delete('__exitcode');
    setVariable(env, 'LASTEXITCODE', code, 'global');
    env.ok = code === 0;
    for (const v of out) emit(v);
    return;
  }
  // Bind to the cmdlet's Call: -Name value pairs (a switch takes no value), the rest positional.
  const call: Call = { name, positional: [], params: {} };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.kind === 'param') {
      const k = a.name!.toLowerCase();
      if (a.hasValue) call.params[k] = a.value!;
      else {
        const next = list[i + 1];
        if (next && next.kind === 'arg' && !SWITCHES.has(k) && !COMMON_SWITCHES.has(k)) {
          call.params[k] = next.value!;
          i++;
        } else call.params[k] = true;
      }
      continue;
    }
    if (isBlock(a.value) && call.block === undefined && call.positional.length === 0) {
      call.block = String((a.value as Obj).src);
      call.blockValue = a.value;
      continue;
    }
    call.positional.push(a.value!);
  }
  const P = call.params;
  const ea = String(P.erroraction ?? P.ea ?? getVariable(env, 'ErrorActionPreference'));
  const ev = P.errorvariable ?? P.ev;
  // -WhatIf on a cmdlet that changes state: describe and do nothing.
  if ((truthy(P.whatif) || (truthy(getVariable(env, 'WhatIfPreference')) && P.whatif === undefined)) && STATE_VERBS.test(resolved) && !/^(out-|export-)/.test(resolved)) {
    const targets = asList(P.identity ?? P.path ?? P.literalpath ?? P.name ?? P.filepath ?? call.positional[0] ?? (input?.length ? input.map((x) => prop(x, 'Name') ?? str(x)) : ''));
    for (const t of targets.length ? targets : ['']) hostWrite(env, `What if: Performing the operation "${displayVerb(resolved)}" on target "${isObj(t) ? str(prop(t, 'Name') ?? prop(t, 'DistinguishedName') ?? show(t)) : str(t)}".\n`);
    env.ok = true;
    return;
  }
  if (P.confirm === true && STATE_VERBS.test(resolved)) {
    hostWrite(env, `\nConfirm\nAre you sure you want to perform this action?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"):\n(This terminal cannot answer prompts, so the simulator answers No. Use -Confirm:$false to proceed.)\n`);
    return;
  }
  const cx = makeCx(env, call, input);
  let out: Value[];
  try {
    out = cmdlet(cx);
  } catch (e) {
    if (e instanceof PsError || e instanceof FsError) {
      const err = e instanceof PsError ? e : new PsError(name, /ENOENT|No such file/.test(e.message) ? `Could not find a part of the path '${toWin(e.message.replace(/:.*$/, ""))}'.` : e.message.replace(/^\/\S*: /, ''));
      handleCmdletError(env, name, err, { ea, ev: ev === undefined ? undefined : str(ev) }, resolved);
      return;
    }
    throw e;
  }
  env.ok = true;
  if (P.outvariable ?? P.ov) setVariable(env, str(P.outvariable ?? P.ov), collapse(out));
  for (const v of out) emit(v);
}

const COMMON_SWITCHES = new Set(['verbose', 'debug', 'whatif', 'confirm', 'passthru', 'force', 'recurse', 'append', 'notypeinformation', 'raw', 'asplaintext', 'descending', 'unique', 'simplematch', 'casesensitive', 'notmatch', 'list', 'file', 'directory', 'compress', 'noelement', 'ashashtable', 'asstring', 'includeequal', 'excludedifferent', 'quiet', 'nonewline', 'usebasicparsing', 'skipcertificatecheck', 'fragment', 'enumerate', 'sum', 'average', 'maximum', 'minimum', 'line', 'word', 'character', 'allowclobber', 'skippublishercheck', 'includeuserinfo', 'detailed', 'full', 'examples', 'online', 'all', 'listavailable', 'parameter', 'codesigningcert', 'nologo', 'noprofile']);

function displayVerb(cmd: string): string {
  return cmd.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());
}

/** A cmdlet failed: classify the error, then stop, report or stay quiet as -ErrorAction says. */
function handleCmdletError(env: Env, name: string, e: PsError, o: { ea?: string; ev?: string }, resolved: string): void {
  const msg = e.message;
  const ad = /-ad|^get-gpo|^new-gpo|-gp/i.test(resolved);
  const type = (e as PsError & { type?: string }).type ?? (/Cannot find (path|drive)|because it does not exist|Could not find (a part of the path|file)/i.test(msg) ? 'ItemNotFoundException' : ad && /cannot find an object|was not found|not found|does not exist/i.test(msg) ? 'ADIdentityNotFoundException' : ad && /already exists|already in use|is already a member/i.test(msg) ? 'ADIdentityAlreadyExistsException' : /access is denied|permission|unauthori[sz]ed/i.test(msg) ? 'UnauthorizedAccessException' : /The remote server returned an error|Unable to connect/i.test(msg) ? 'WebException' : ad ? 'ADException' : 'WriteErrorException');
  const rec = errorRecord(msg, type, { command: name, id: type, category: type === 'ItemNotFoundException' ? 'ObjectNotFound' : type === 'UnauthorizedAccessException' ? 'PermissionDenied' : 'NotSpecified' });
  if (env.scriptPath && env.line) {
    (rec.InvocationInfo as Obj).ScriptLineNumber = env.line;
    (rec.InvocationInfo as Obj).ScriptName = env.scriptPath;
  }
  // AD identity errors and web errors end the statement even without -ErrorAction Stop.
  const terminating = ad || type === 'WebException' || (e as PsError & { terminating?: boolean }).terminating;
  reportError(env, rec, o.ev, o.ea, terminating);
}

export function reportError(env: Env, rec: Obj, errorVariable?: string, action?: string, terminating = false): void {
  const ea = String(action ?? getVariable(env, 'ErrorActionPreference')).toLowerCase();
  env.ok = false;
  if (ea === 'stop') {
    remember(env, rec, errorVariable);
    throw new RuntimeErr(rec, 'script');
  }
  if (terminating) {
    remember(env, rec, errorVariable);
    throw new RuntimeErr(rec, 'statement');
  }
  if (ea === 'ignore') return;
  remember(env, rec, errorVariable);
  if (ea === 'silentlycontinue') return;
  hostWrite(env, errorText(rec));
}

export function makeCx(env: Env, call: Call, input: Value[] | undefined): Cx {
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
      const block = { __type: 'block', src } as Obj;
      const under = vars && '_' in vars ? vars._ : undefined;
      const rest = Object.fromEntries(Object.entries(vars ?? {}).filter(([k]) => k !== '_'));
      return runBlock(env, block, { dollarUnder: under, vars: rest });
    },
    print: (text) => hostWrite(env, text),
  };
}

/* ----------------------------------------------------------------------------- script blocks, functions and scripts */

function blockAst(b: Obj): Block {
  try {
    return parseScript(String(b.src), Number(b.__line ?? 1));
  } catch (e) {
    if (e instanceof ParseError) throw rtError(`${e.message}`, 'ParseException', 'statement');
    throw e;
  }
}

/** Runs a script block and returns its output. */
export function runBlock(env: Env, b: Value, opts: RunOpts = {}): Value[] {
  if (!isBlock(b)) throw rtError(`Cannot invoke '${str(b)}': it is not a script block.`, 'RuntimeException');
  const ast = blockAst(b as Obj);
  const out: Value[] = [];
  const emit = opts.emit ?? ((v: Value) => out.push(v));
  const run = () => {
    if (opts.dollarUnder !== undefined) {
      setVariable(env, '_', opts.dollarUnder);
      setVariable(env, 'PSItem', opts.dollarUnder);
    }
    for (const [k, v] of Object.entries(opts.vars ?? {})) setVariable(env, k, v);
    setVariable(env, 'args', opts.args ?? []);
    if (ast.params?.length) bindParams(env, ast.params, buildArgs(opts.args ?? []), 'script block', !!ast.binding, undefined);
    setVariable(env, 'input', opts.input ?? []);
    try {
      runBody(env, ast, opts.input, emit);
    } catch (e) {
      if (!(e instanceof ReturnEx)) throw e;
    }
  };
  if (opts.newScope === false) {
    const saved = opts.dollarUnder !== undefined ? getVariable(env, '_') : undefined;
    try {
      run();
    } finally {
      if (opts.dollarUnder !== undefined) setVariable(env, '_', saved);
    }
  } else withScope(env, 'block', run);
  return out;
}

function buildArgs(values: Value[]): EvalArg[] {
  return values.map((v) => (typeof v === 'string' && /^-[A-Za-z]\w*$/.test(v) ? { kind: 'param' as const, name: v.slice(1), text: v } : { kind: 'arg' as const, value: v, text: str(v) }));
}

/** begin, then process once per input item (with $_), then end. */
function runBody(env: Env, ast: Block, input: Value[] | undefined, emit: (v: Value) => void, perItem?: (item: Value) => void): void {
  if (ast.begin) execStmts(env, ast.begin, emit);
  if (ast.process) {
    const items = input ?? [];
    if (!input) {
      setVariable(env, '_', null);
      execStmts(env, ast.process, emit);
    } else
      for (const item of items) {
        setVariable(env, '_', item);
        setVariable(env, 'PSItem', item);
        perItem?.(item);
        execStmts(env, ast.process, emit);
      }
  }
  if (ast.end) execStmts(env, ast.end, emit);
}

const COMMON_PARAMS = ['verbose', 'debug', 'erroraction', 'warningaction', 'informationaction', 'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'whatif', 'confirm'];

function attr(p: ParamDef, name: string) {
  return p.attrs.find((a) => a.name.toLowerCase() === name.toLowerCase());
}
function isSwitch(p: ParamDef) {
  return !!p.type && /^(switch|system\.management\.automation\.switchparameter)$/i.test(p.type);
}

/**
 * Binds arguments to a param() list in the current scope: named (exact, prefix or alias), then
 * positional by Position or order; converts types, applies defaults and validation attributes.
 * Returns the bound parameters ($PSBoundParameters) and leftover arguments ($args).
 */
function bindParams(env: Env, params: ParamDef[], args: EvalArg[], fnName: string, advanced: boolean, pipelineItem: Value | undefined, common?: Record<string, Value>): { bound: Obj; rest: Value[] } {
  const bound: Obj = { __type: 'hashtable' };
  const rest: Value[] = [];
  const byName = (n: string): ParamDef | undefined => {
    const k = n.toLowerCase();
    const exact = params.find((p) => p.name.toLowerCase() === k || (attr(p, 'alias')?.args ?? []).some((a) => a.t === 'str' && a.v.toLowerCase() === k));
    if (exact) return exact;
    const pre = params.filter((p) => p.name.toLowerCase().startsWith(k));
    if (pre.length > 1) throw bindErr(fnName, `Parameter cannot be processed because the parameter name '${n}' is ambiguous. Possible matches include: ${pre.map((p) => '-' + p.name).join(' ')}.`, 'ParameterBindingException');
    return pre[0];
  };
  const values = new Map<ParamDef, Value>();
  const positional: Value[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.kind === 'arg') {
      positional.push(a.value!);
      continue;
    }
    const p = byName(a.name!);
    if (!p) {
      const k = a.name!.toLowerCase();
      const commonHit = COMMON_PARAMS.find((c) => c === k || (k.length >= 2 && c.startsWith(k))) ?? (k === 'ea' ? 'erroraction' : k === 'ev' ? 'errorvariable' : k === 'wi' ? 'whatif' : k === 'vb' ? 'verbose' : undefined);
      if (advanced && commonHit) {
        let v: Value = true;
        if (a.hasValue) v = a.value!;
        else if (!['verbose', 'debug', 'whatif', 'confirm'].includes(commonHit)) {
          const next = args[i + 1];
          if (next && next.kind === 'arg') {
            v = next.value!;
            i++;
          }
        }
        if (common) common[commonHit] = v;
        continue;
      }
      if (advanced) throw bindErr(fnName, `A parameter cannot be found that matches parameter name '${a.name}'.`, 'ParameterBindingException', 'NamedParameterNotFound');
      rest.push(`-${a.name}`);
      if (a.hasValue) rest.push(a.value!);
      continue;
    }
    if (isSwitch(p)) values.set(p, a.hasValue ? truthy(a.value) : true);
    else if (a.hasValue) values.set(p, a.value!);
    else {
      const next = args[i + 1];
      if (!next || next.kind !== 'arg') throw bindErr(fnName, `Missing an argument for parameter '${p.name}'. Specify a parameter of type '${fullTypeName(p.type ?? 'object')}' and try again.`, 'ParameterBindingException', 'MissingArgument');
      values.set(p, next.value!);
      i++;
    }
  }
  // Positional binding: by Position where given, else in declaration order (switches never bind by position).
  const posOf = (p: ParamDef) => {
    const pa = attr(p, 'parameter');
    const v = pa?.named.position;
    return v && v !== true ? num(evalExpr(env, v)) : undefined;
  };
  const anyPosition = params.some((p) => posOf(p) !== undefined);
  const candidates = params.filter((p) => !values.has(p) && !isSwitch(p) && (!anyPosition || posOf(p) !== undefined)).sort((a, b) => (posOf(a) ?? params.indexOf(a)) - (posOf(b) ?? params.indexOf(b)));
  for (const v of positional) {
    const p = candidates.shift();
    if (p) values.set(p, v);
    else if (advanced) throw bindErr(fnName, `A positional parameter cannot be found that accepts argument '${str(v)}'.`, 'ParameterBindingException', 'PositionalParameterNotFound');
    else rest.push(v);
  }
  // Pipeline input.
  if (pipelineItem !== undefined) {
    for (const p of params) {
      if (values.has(p)) continue;
      const pa = attr(p, 'parameter');
      if (!pa) continue;
      if (pa.named.valuefrompipeline) values.set(p, pipelineItem);
      else if (pa.named.valuefrompipelinebypropertyname) {
        const names = [p.name, ...(attr(p, 'alias')?.args ?? []).map((x) => (x.t === 'str' ? x.v : ''))];
        for (const n of names) {
          const v = isObj(pipelineItem) ? prop(pipelineItem, n) : undefined;
          if (v !== undefined && v !== null) {
            values.set(p, v);
            break;
          }
        }
      }
    }
  }
  for (const p of params) {
    let v: Value;
    const given = values.has(p);
    if (given) v = values.get(p)!;
    else {
      const pa = attr(p, 'parameter');
      const mandatory = pa && pa.named.mandatory !== undefined && (pa.named.mandatory === true || truthy(evalExpr(env, pa.named.mandatory as Expr)));
      if (mandatory) throw bindErr(fnName, `Cannot process command because of one or more missing mandatory parameters: ${p.name}.`, 'ParameterBindingException', 'MissingMandatoryParameter');
      v = isSwitch(p) ? false : p.dflt ? evalExpr(env, p.dflt) : null;
      if (p.type && !isSwitch(p) && p.dflt === undefined) v = /^(int|int32|long|double|decimal)$/i.test(p.type) ? 0 : /^string$/i.test(p.type) ? '' : /^bool/i.test(p.type) ? false : v;
      setVariable(env, p.name, v, 'local');
      continue;
    }
    if (p.type && !isSwitch(p)) {
      try {
        v = convertTo(p.type, v);
      } catch (e) {
        if (e instanceof RuntimeErr) throw bindErr(fnName, `Cannot process argument transformation on parameter '${p.name}'. ${e.message}`, 'ParameterBindingArgumentTransformationException');
        throw e;
      }
    }
    validate(env, fnName, p, v);
    setVariable(env, p.name, v, 'local');
    bound[p.name] = v;
  }
  return { bound, rest };
}

function bindErr(fn: string, msg: string, type: string, id?: string): RuntimeErr {
  return new RuntimeErr(errorRecord(msg, type, { command: fn, id: id ?? type, category: 'InvalidArgument' }), 'statement');
}

function validate(env: Env, fn: string, p: ParamDef, v: Value): void {
  const prefix = `Cannot validate argument on parameter '${p.name}'. `;
  const fail = (m: string) => {
    throw bindErr(fn, prefix + m, 'ParameterBindingValidationException');
  };
  for (const a of p.attrs) {
    const n = a.name.toLowerCase();
    const args = a.args.map((x) => evalExpr(env, x));
    if (n === 'validatenotnullorempty' && (v === null || v === undefined || str(v) === '' || (isArr(v) && v.length === 0))) fail('The argument is null or empty. Provide an argument that is not null or empty, and then try the command again.');
    if (n === 'validatenotnull' && (v === null || v === undefined)) fail('The argument is null. Provide a valid value for the argument, and then try running the command again.');
    for (const item of asList(v)) {
      if (n === 'validateset') {
        const set = args.flatMap((x) => asList(x)).map(str);
        if (!set.some((s) => s.toLowerCase() === str(item).toLowerCase())) fail(`The argument "${str(item)}" does not belong to the set "${set.join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`);
      }
      if (n === 'validaterange') {
        const x = num(item);
        if (x < num(args[0])) fail(`The ${str(item)} argument is less than the minimum allowed range of ${str(args[0])}. Supply an argument that is greater than or equal to ${str(args[0])} and then try the command again.`);
        if (x > num(args[1])) fail(`The ${str(item)} argument is greater than the maximum allowed range of ${str(args[1])}. Supply an argument that is less than or equal to ${str(args[1])} and then try the command again.`);
      }
      if (n === 'validatepattern' && !jsRegex(str(args[0]), false).test(str(item))) fail(`The argument "${str(item)}" does not match the "${str(args[0])}" pattern. Supply an argument that matches "${str(args[0])}" and try the command again.`);
      if (n === 'validatelength') {
        const len = str(item).length;
        if (len < num(args[0])) fail(`The character length (${len}) of the argument is too short. Specify an argument with a length that is greater than or equal to "${str(args[0])}", and then try the command again.`);
        if (len > num(args[1])) fail(`The character length of the ${len} argument is too long. Shorten the character length of the argument so it is fewer than or equal to "${str(args[1])}" characters, and then try the command again.`);
      }
      if (n === 'validatescript' && !truthy(collapse(runBlock(env, args[0], { dollarUnder: item })))) fail(`The "${String((args[0] as Obj).src).trim()}" validation script for the argument with value "${str(item)}" did not return a result of True. Determine why the validation script failed, and then try the command again.`);
    }
    if (n === 'validatecount') {
      const c = asList(v).length;
      if (c < num(args[0]) || c > num(args[1])) fail(`The parameter requires at least ${str(args[0])} value(s) and no more than ${str(args[1])} value(s) - ${c} value(s) were provided.`);
    }
  }
}

function callFunction(env: Env, fn: Obj, args: Arg[], input: Value[] | undefined, emit: (v: Value) => void, callName: string): void {
  const ast = fn.__block as Block;
  const advanced = !!ast.binding || (ast.params ?? []).some((p) => p.attrs.some((a) => /^(parameter|validate|alias)/i.test(a.name)));
  const list = evalArgList(env, args);
  const name = String(fn.Name);
  const depth = (env.callDepth ?? 0) + 1;
  if (depth > 100) throw rtError('The script failed due to call depth overflow.', 'ScriptCallDepthException', 'script');
  env.callDepth = depth;
  const savedScript = env.scriptPath;
  try {
    withScope(env, 'function', () => {
      const common: Record<string, Value> = {};
      const params = ast.params ?? [];
      const pipelineBinding = !!input && params.some((p) => attr(p, 'parameter')?.named.valuefrompipeline || attr(p, 'parameter')?.named.valuefrompipelinebypropertyname);
      const { bound, rest } = bindParams(env, params, list, name, advanced, pipelineBinding ? input?.[0] : undefined, common);
      setVariable(env, 'args', rest, 'local');
      setVariable(env, 'PSBoundParameters', bound, 'local');
      setVariable(env, 'MyInvocation', { __type: 'invocation', MyCommand: { __type: 'psobject', Name: name }, InvocationName: callName, ScriptName: fn.__script ?? '', Line: '', BoundParameters: bound }, 'local');
      if (advanced) {
        setVariable(env, 'PSCmdlet', { __type: 'pscmdlet', __command: name, MyInvocation: { __type: 'invocation', MyCommand: { __type: 'psobject', Name: name } }, ParameterSetName: '__AllParameterSets' }, 'local');
        if (common.verbose !== undefined) setVariable(env, 'VerbosePreference', truthy(common.verbose) ? 'Continue' : 'SilentlyContinue', 'local');
        if (common.whatif !== undefined) setVariable(env, 'WhatIfPreference', truthy(common.whatif), 'local');
        if (common.erroraction !== undefined) setVariable(env, 'ErrorActionPreference', str(common.erroraction), 'local');
        if (common.warningaction !== undefined) setVariable(env, 'WarningPreference', str(common.warningaction), 'local');
      }
      setVariable(env, 'input', input ?? [], 'local');
      const body: Block = fn.__filter ? { ...ast, process: ast.end, end: undefined, named: true } : ast;
      const errorVariable = common.errorvariable !== undefined ? str(common.errorvariable) : undefined;
      try {
        runBody(env, body, input, emit, pipelineBinding ? (item) => bindPipelineItem(env, params, item, name) : undefined);
      } catch (e) {
        if (e instanceof ReturnEx) return;
        if (e instanceof RuntimeErr && errorVariable) remember(env, e.record, errorVariable);
        throw e;
      }
    });
  } finally {
    env.callDepth = depth - 1;
    env.scriptPath = savedScript;
  }
  env.ok = true;
}

/** In a process block, each pipeline item rebinds the ValueFromPipeline parameters. */
function bindPipelineItem(env: Env, params: ParamDef[], item: Value, fnName: string): void {
  for (const p of params) {
    const pa = attr(p, 'parameter');
    if (!pa) continue;
    let v: Value | undefined;
    if (pa.named.valuefrompipeline) v = item;
    else if (pa.named.valuefrompipelinebypropertyname && isObj(item)) {
      for (const n of [p.name, ...(attr(p, 'alias')?.args ?? []).map((x) => (x.t === 'str' ? x.v : ''))]) {
        const x = prop(item, n);
        if (x !== undefined && x !== null) {
          v = x;
          break;
        }
      }
    }
    if (v === undefined) continue;
    if (p.type && !isSwitch(p)) v = convertTo(p.type, v);
    validate(env, fnName, p, v);
    setVariable(env, p.name, v, 'local');
  }
}

/** Execution policy for script files: Restricted blocks all; AllSigned needs a valid signature. */
function checkPolicy(env: Env, path: string, text: string): void {
  const policy = str(env.vars.get('__executionpolicy') ?? (machine(env) as unknown as Obj).executionPolicy ?? 'RemoteSigned').toLowerCase();
  if (policy === 'restricted') throw rtError(`File ${path} cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.`, 'PSSecurityException', 'script', { id: 'UnauthorizedAccess' });
  if (policy === 'allsigned') {
    const sig = signatureStatus(text);
    if (sig !== 'Valid') throw rtError(`File ${path} cannot be loaded. The file ${path} is not digitally signed. You cannot run this script on the current system. For more information about running scripts and setting execution policy, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.`, 'PSSecurityException', 'script', { id: 'UnauthorizedAccess' });
  }
}

/** Signature block written by Set-AuthenticodeSignature: a hash of the script text before it. */
export function signatureStatus(text: string): 'Valid' | 'HashMismatch' | 'NotSigned' {
  const m = /\r?\n# SIG # Begin signature block\r?\n# LabHash: ([0-9a-f]+)[\s\S]*# SIG # End signature block\r?\n?$/.exec(text);
  if (!m) return 'NotSigned';
  const body = text.slice(0, m.index);
  return simpleHash(body) === m[1] ? 'Valid' : 'HashMismatch';
}

export function simpleHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + s.charCodeAt(i), 2246822519);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(2);
}

function runScriptFile(env: Env, name: string, el: Extract<Elem, { t: 'cmd' }>, input: Value[] | undefined, emit: (v: Value) => void): void {
  const vfs = toVfs(env, name);
  const l = lookup(env.sys.fs, vfs, ROOT);
  if (!l || l.node.type !== 'file') throw rtError(`The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`, 'CommandNotFoundException', 'statement', { target: name, category: 'ObjectNotFound' });
  const text = l.node.content;
  const winPath = toWin(vfs);
  checkPolicy(env, winPath, text);
  let ast: Block;
  try {
    ast = parseScript(text);
  } catch (e) {
    if (e instanceof ParseError) throw rtError(`At ${winPath}:${e.line} char:1\n${e.message}`, 'ParseException', 'script');
    throw e;
  }
  const list = evalArgList(env, el.args);
  const savedPath = env.scriptPath;
  const run = () => {
    env.scriptPath = winPath;
    setVariable(env, 'PSScriptRoot', winPath.replace(/\\[^\\]*$/, ''), 'local');
    setVariable(env, 'PSCommandPath', winPath, 'local');
    const common: Record<string, Value> = {};
    const advanced = !!ast.binding || (ast.params ?? []).some((p) => p.attrs.length);
    const { bound, rest } = ast.params ? bindParams(env, ast.params, list, winPath, advanced, undefined, common) : { bound: { __type: 'hashtable' } as Obj, rest: list.map((a) => (a.kind === 'param' ? `-${a.name}` : a.value!)) };
    setVariable(env, 'args', rest, 'local');
    setVariable(env, 'PSBoundParameters', bound, 'local');
    if (common.verbose !== undefined) setVariable(env, 'VerbosePreference', truthy(common.verbose) ? 'Continue' : 'SilentlyContinue', 'local');
    if (common.whatif !== undefined) setVariable(env, 'WhatIfPreference', truthy(common.whatif), 'local');
    if (advanced) setVariable(env, 'PSCmdlet', { __type: 'pscmdlet', __command: winPath }, 'local');
    try {
      runBody(env, ast, input, emit);
      setVariable(env, 'LASTEXITCODE', 0, 'global');
    } catch (e) {
      if (e instanceof ReturnEx) return;
      if (e instanceof ExitEx) {
        setVariable(env, 'LASTEXITCODE', e.code, 'global');
        env.ok = e.code === 0;
        return;
      }
      throw e;
    }
  };
  try {
    if (el.call === '.') run();
    else withScope(env, 'script', run);
  } finally {
    env.scriptPath = savedPath;
  }
}

/** Module folders searched for Name\Name.psm1 when a command is not found. */
function autoloadModule(env: Env, cmd: string): boolean {
  const user = env.sys.user;
  const roots = [`C:\\Users\\${user}\\Documents\\WindowsPowerShell\\Modules`, 'C:\\Program Files\\WindowsPowerShell\\Modules'];
  const tried = (env.vars.get('__autoloaded') as string[] | undefined) ?? [];
  for (const root of roots) {
    const vfs = toVfs(env, root);
    const l = lookup(env.sys.fs, vfs, ROOT);
    if (!l || l.node.type !== 'dir') continue;
    for (const [mod, node] of Object.entries(l.node.children)) {
      if (node.type !== 'dir' || tried.includes(mod.toLowerCase())) continue;
      const psm = Object.entries(node.children).find(([f]) => f.toLowerCase() === `${mod.toLowerCase()}.psm1`);
      if (!psm || psm[1].type !== 'file') continue;
      if (!new RegExp(`function\\s+${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(psm[1].content)) continue;
      env.vars.set('__autoloaded', [...tried, mod.toLowerCase()]);
      importModuleText(env, psm[1].content, `${root}\\${mod}\\${psm[0]}`, mod);
      return true;
    }
  }
  return false;
}

/** Runs a module's text so its functions become available (Export-ModuleMember is honoured loosely). */
export function importModuleText(env: Env, text: string, path: string, name: string): void {
  const ast = parseScript(text);
  const saved = env.scriptPath;
  env.scriptPath = path;
  try {
    withScope(env, 'script', () => runBody(env, ast, undefined, () => {}));
  } finally {
    env.scriptPath = saved;
  }
  const mods = (env.vars.get('__modules') as Obj[] | undefined) ?? [];
  if (!mods.some((m) => str(m.Name).toLowerCase() === name.toLowerCase())) env.vars.set('__modules', [...mods, { __type: 'select', ModuleType: 'Script', Version: '1.0', Name: name, ExportedCommands: [...env.vars.keys()].filter((k) => k.startsWith('function:')).map((k) => k.slice(9)), Path: path }]);
}

/** Runs script text as a script file would run: its own scope, $PSScriptRoot, exit codes. Returns its output. */
export function runScriptText(env: Env, text: string, winPath: string, args: Value[] = []): { out: Value[]; exit: number } {
  const ast = parseScript(text);
  const out: Value[] = [];
  const saved = env.scriptPath;
  let exit = 0;
  try {
    withScope(env, 'script', () => {
      env.scriptPath = winPath;
      setVariable(env, 'PSScriptRoot', winPath.replace(/\\[^\\]*$/, ''), 'local');
      setVariable(env, 'PSCommandPath', winPath, 'local');
      if (ast.params) bindParams(env, ast.params, buildArgs(args), winPath, !!ast.binding, undefined, {});
      setVariable(env, 'args', args, 'local');
      try {
        runBody(env, ast, undefined, (v) => out.push(v));
      } catch (e) {
        if (e instanceof ExitEx) exit = e.code;
        else if (!(e instanceof ReturnEx)) throw e;
      }
    });
  } finally {
    env.scriptPath = saved;
  }
  return { out, exit };
}

/* ----------------------------------------------------------------------------- Pester mocks */

function callMock(env: Env, mock: Obj, el: Extract<Elem, { t: 'cmd' }>, input: Value[] | undefined, emit: (v: Value) => void): void {
  const { positional, named } = evalArgs(env, el.args);
  const filter = mock.filter as Obj | undefined;
  const vars: Record<string, Value> = { ...Object.fromEntries(Object.entries(named).map(([k, v]) => [k, v])) };
  if (filter && !truthy(collapse(runBlock(env, filter, { vars, args: positional })))) {
    // The filter did not match: fall back to the real command.
    const key = String(mock.name).toLowerCase();
    const mocks = env.mocks as Map<string, Obj>;
    mocks.delete(key);
    try {
      invokeByName(env, String(mock.name), el, input, emit, true);
    } finally {
      mocks.set(key, mock);
    }
    return;
  }
  (mock.calls as Obj[]).push({ __type: 'hashtable', ...named, __positional: positional });
  for (const v of runBlock(env, mock.body, { vars, args: positional, input })) emit(v);
}

/* ----------------------------------------------------------------------------- entry points */

/** Parses and runs source, streaming output to emit. Statement errors outside try print and continue. */
export function runSource(env: Env, src: string, emit: (v: Value) => void, lineBase = 1): void {
  let ast: Block;
  try {
    ast = parseScript(src, lineBase);
  } catch (e) {
    if (e instanceof ParseError) throw new PsError('', `At line:${e.line} char:1\n${e.message}`);
    throw e;
  }
  loopGuard = 0;
  runBody(env, ast, undefined, emit);
}

/** Evaluates source and returns its output values (for checks and cmdlets). */
export function evalCollect(env: Env, src: string): Value[] {
  const out: Value[] = [];
  runSource(env, src, (v) => out.push(v));
  return out;
}

/** -Filter conditions (AD) and Where-Object script blocks: barewords are properties of the subject. */
export function evalCondition(env: Env, src: string, subject: Value, bare: boolean): boolean {
  const text = src.trim();
  if (!text || text === '*') return text === '*';
  let e: Expr;
  try {
    const p = new Parser(text);
    e = p.parseExpression();
    p.wsnl();
    if (p.i < text.length) {
      // A full script block body (Where-Object { ...; ... }).
      const out = runBlock(env, { __type: 'block', src: text }, { dollarUnder: subject, newScope: false });
      return truthy(collapse(out));
    }
  } catch (err) {
    if (err instanceof ParseError) throw new PsError('', `The filter is not valid: ${err.message}`);
    throw err;
  }
  const savedSubject = env.filterSubject;
  const savedUnder = getVariable(env, '_');
  if (bare) env.filterSubject = subject;
  setVariable(env, '_', subject);
  try {
    return truthy(evalExpr(env, e));
  } finally {
    env.filterSubject = savedSubject;
    setVariable(env, '_', savedUnder);
  }
}

/** Expands "..." text with $variables and $(...) (used by cmdlets that take templates). */
export function expandText(env: Env, s: string): string {
  return new Parser(s).parseExpandable(s).map((p) => (typeof p === 'string' ? p : interp(env, evalExpr(env, p)))).join('');
}

export { findClose, Parser, ParseError };
export type { Block };
