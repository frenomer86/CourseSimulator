/**
 * Language-level cmdlets: the pipeline (ForEach-Object, Where-Object, Select-Object, Sort-Object,
 * Group-Object, Measure-Object, Compare-Object, Tee-Object), output streams (Write-*), objects
 * (New-Object, Add-Member, Get-Member), data formats (JSON, CSV, HTML, CLIXML), dates, variables,
 * commands and help, modules, execution policy and signing, transcripts, files and hashes.
 * Registered after cmd-basic, so these replace its simpler versions.
 */

import { effectivePolicy, parseManifest, policyScopes, routeStream, streamWrite } from './lang.js';
import { listDir, lookup, mkdir, readFile, remove, writeFile, type FsNode } from '../fs.js';
import { ALIASES, CMDLET_TABLE, NATIVE_TABLE, asList, canonical, cmdletNames, isObj, isSecure, machine, prop, register, render, SECURE, toVfs, toWin, type Cx, type Obj, type Value } from './core.js';
import { binaryOp, construct, convertTo, errorRecord, formatDate, getMember, getVariable, importModuleText, invokeMethod, isBlock, isDate, isHash, isSpan, makeDate, makeSpan, msOf, num, parseDateText, reportError, runBlock, setVariable, signatureStatus, simpleHash, str, truthy, typeNameOf } from './lang.js';
import { sha1, sha256, md5 } from '../hash.js';

const ROOT = { user: 'root', groups: ['root'] };
const isArr = Array.isArray;

function input(cx: Cx): Value[] {
  if (cx.input) return cx.input;
  if (cx.P.inputobject !== undefined) return asList(cx.P.inputobject);
  return [];
}

function blockArg(v: Value): Obj | undefined {
  if (isBlock(v)) return v as Obj;
  return undefined;
}

/** The blocks given to a cmdlet: the leading positional block plus any other positional blocks. */
function blocks(cx: Cx): Obj[] {
  const out: Obj[] = [];
  if (cx.call.block !== undefined) out.push({ __type: 'block', src: cx.call.block });
  for (const p of cx.pos) if (isBlock(p)) out.push(p as Obj);
  return out;
}

/** A property spec: a name (with wildcards), a script block, or @{ Name/Label = ...; Expression = ... }. */
interface PropSpec {
  name: string;
  get: (item: Value) => Value;
  wildcard?: RegExp;
  descending?: boolean;
}

function propSpecs(cx: Cx, raw: Value): PropSpec[] {
  return asList(raw).flatMap((p): PropSpec[] => {
    if (isBlock(p)) return [{ name: String((p as Obj).src).trim(), get: (item) => collapseV(runBlock(cx.env, p, { dollarUnder: item, newScope: false })) }];
    if (isHash(p)) {
      const h = p as Obj;
      const name = str(prop(h, 'Name') ?? prop(h, 'N') ?? prop(h, 'Label') ?? prop(h, 'L') ?? '');
      const expr = prop(h, 'Expression') ?? prop(h, 'E');
      const desc = prop(h, 'Descending') ?? (prop(h, 'Ascending') !== undefined ? !truthy(prop(h, 'Ascending')) : undefined);
      const get = isBlock(expr) ? (item: Value) => collapseV(runBlock(cx.env, expr, { dollarUnder: item, newScope: false })) : (item: Value) => getMember(cx.env, item, str(expr));
      return [{ name: name || (isBlock(expr) ? String((expr as Obj).src).trim() : str(expr)), get, descending: desc === undefined ? undefined : truthy(desc) }];
    }
    const name = str(p);
    if (/[*?]/.test(name)) return [{ name, get: () => null, wildcard: new RegExp('^' + name.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') }];
    return [{ name, get: (item) => getMember(cx.env, item, name) }];
  });
}

const collapseV = (vals: Value[]): Value => (vals.length === 0 ? null : vals.length === 1 ? vals[0] : vals);

function allProps(v: Value): Array<[string, Value]> {
  if (!isObj(v)) return [];
  const o = v as Obj;
  const own = Object.entries(o).filter(([k]) => !k.startsWith('__'));
  const extra = isObj(o.__extra) ? Object.entries(o.__extra as Obj) : [];
  return [...own, ...extra];
}

/** Ordering used by Sort-Object and comparisons: numbers numerically, dates by time, text without case. */
export function orderOf(a: Value, b: Value): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (isDate(a) && isDate(b)) return msOf(a) - msOf(b);
  if (isSpan(a) && isSpan(b)) return msOf(a) - msOf(b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const as = str(a);
  const bs = str(b);
  const an = Number(as);
  const bn = Number(bs);
  if (as.trim() !== '' && bs.trim() !== '' && !Number.isNaN(an) && !Number.isNaN(bn) && (typeof a === 'number' || typeof b === 'number')) return an - bn;
  return as.localeCompare(bs, 'en', { sensitivity: 'base', numeric: false });
}

/* ----------------------------------------------------------------------------- JSON */

function toJson(v: Value, depth: number, indent: number, compress: boolean, level = 0): string {
  const pad = (n: number) => (compress ? '' : ' '.repeat(n * indent));
  const nl = compress ? '' : '\n';
  const sep = compress ? ':' : ':  ';
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (isDate(v)) return JSON.stringify(formatDate(msOf(v), "yyyy-MM-dd'T'HH:mm:ss"));
  if (isSpan(v) || isSecure(v)) return JSON.stringify(str(v));
  if (level > depth) return JSON.stringify(isArr(v) ? str(v) : typeNameOf(v));
  if (isArr(v)) {
    if (!v.length) return '[\n\n]'.replace(/\n/g, nl) || '[]';
    return `[${nl}${v.map((x) => pad(level + 1) + toJson(x, depth, indent, compress, level + 1)).join(',' + nl)}${nl}${pad(level)}]`;
  }
  if (isBlock(v)) return JSON.stringify(String((v as Obj).src));
  const entries = allProps(v);
  if (!entries.length) return '{\n\n}'.replace(/\n/g, nl) || '{}';
  return `{${nl}${entries.map(([k, x]) => `${pad(level + 1)}${JSON.stringify(k)}${sep}${toJson(x, depth, indent, compress, level + 1)}`).join(',' + nl)}${nl}${pad(level)}}`;
}

function fromJson(v: unknown, asHash: boolean): Value {
  if (Array.isArray(v)) return v.map((x) => fromJson(x, asHash));
  if (v && typeof v === 'object') {
    const o: Obj = { __type: asHash ? 'hashtable' : 'psobject' };
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = fromJson(x, asHash);
    return o;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    const t = parseDateText(v.replace(/\.\d+/, '').replace(/Z$/, ''));
    if (t !== null) return makeDate(t);
  }
  return v as Value;
}

/* ----------------------------------------------------------------------------- CSV */

function csvSplit(l: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) {
      if (ch === '"' && l[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function csvCell(v: Value): string {
  const s = isArr(v) ? 'System.Object[]' : isHash(v) ? 'System.Collections.Hashtable' : isDate(v) ? formatDate(msOf(v), 'dd/MM/yyyy HH:mm:ss') : isObj(v) && !isSpan(v) && !['version', 'guid'].includes(String((v as Obj).__type)) ? (str(v).startsWith('@{') ? typeNameOf(v) : str(v)) : str(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsvLines(objs: Value[], delim: string, typeInfo: boolean, header = true): string[] {
  const rows = objs.filter((o) => o !== null && o !== undefined);
  if (!rows.length) return [];
  const first = rows[0];
  const keys = isObj(first) ? allProps(first).map(([k]) => k) : ['Length'];
  const lines: string[] = [];
  if (typeInfo) lines.push(`#TYPE ${typeNameOf(first)}`);
  if (header) lines.push(keys.map((k) => `"${k}"`).join(delim));
  for (const o of rows) lines.push(keys.map((k) => csvCell(isObj(o) ? prop(o, k) : k === 'Length' ? str(o).length : null)).join(delim));
  return lines;
}

function fromCsvText(text: string, delim: string, header?: string[]): Obj[] {
  let rows = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (rows[0]?.startsWith('#TYPE')) rows = rows.slice(1);
  const head = header ?? csvSplit(rows.shift() ?? '', delim).map((h) => h.trim());
  return rows.map((r) => {
    const cells = csvSplit(r, delim);
    const o: Obj = { __type: 'csv' };
    head.forEach((h, i) => (o[h || `H${i + 1}`] = cells[i] ?? null));
    return o;
  });
}

/* ----------------------------------------------------------------------------- files */

function readText(cx: Cx, p: string): string {
  try {
    return readFile(cx.env.sys.fs, toVfs(cx.env, p), ROOT);
  } catch {
    return cx.fail(`Cannot find path '${resolveWin(cx, p)}' because it does not exist.`);
  }
}

function resolveWin(cx: Cx, p: string): string {
  return toWin(toVfs(cx.env, p));
}

function writeText(cx: Cx, p: string, text: string, append: boolean): void {
  const vfs = toVfs(cx.env, p);
  let prev = '';
  if (append) {
    try {
      prev = readFile(cx.env.sys.fs, vfs, ROOT);
    } catch {
      /* new file */
    }
  }
  try {
    writeFile(cx.env.sys.fs, vfs, prev + text, ROOT, cx.env.sys.now);
  } catch {
    cx.fail(`Could not find a part of the path '${toWin(vfs)}'.`);
  }
}

/** A FileInfo/DirectoryInfo-like object: Mode, LastWriteTime, Length, Name shown; the rest available. */
export function itemObject(vfs: string, node: FsNode): Obj {
  const isDir = node.type === 'dir';
  const win = toWin(vfs);
  const name = win.replace(/^.*\\/, '') || win;
  const ext = isDir ? '' : /\.[^.]*$/.exec(name)?.[0] ?? '';
  const ms = node.mtime || 1792661400000;
  return {
    __type: 'file',
    Mode: isDir ? 'd-----' : '-a----',
    // Directory listings show the date as 10/22/2026   9:30 AM.
    LastWriteTime: { ...makeDate(ms), __display: `${formatDate(ms, 'MM/dd/yyyy')} ${formatDate(ms, 'h:mm tt').padStart(8)}` },
    Length: isDir ? '' : node.type === 'file' ? node.content.length : 0,
    Name: name,
    __extra: { FullName: win, Extension: ext, BaseName: isDir ? name : name.slice(0, name.length - ext.length), DirectoryName: win.replace(/\\[^\\]*$/, ''), Directory: win.replace(/\\[^\\]*$/, ''), Parent: win.replace(/\\[^\\]*$/, ''), PSIsContainer: isDir, CreationTime: makeDate(node.mtime || 1792661400000), LastWriteTimeUtc: makeDate(node.mtime || 1792661400000), Attributes: isDir ? 'Directory' : 'Archive', Exists: true, PSPath: `Microsoft.PowerShell.Core\\FileSystem::${win}` },
  };
}

function wildRe(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

/** Paths a -Path value names, with wildcards in the last part expanded. */
function expandPaths(cx: Cx, p: string): string[] {
  const vfs = toVfs(cx.env, p);
  const leaf = vfs.slice(vfs.lastIndexOf('/') + 1);
  if (!/[*?]/.test(leaf)) return [vfs];
  const dir = vfs.slice(0, vfs.lastIndexOf('/')) || '/';
  try {
    return listDir(cx.env.sys.fs, dir, ROOT).filter((e) => wildRe(leaf).test(e.name)).map((e) => `${dir}/${e.name}`);
  } catch {
    return [];
  }
}

/* ----------------------------------------------------------------------------- the cmdlets */

const oldHelp = CMDLET_TABLE['get-help'];
const oldChildItem = CMDLET_TABLE['get-childitem'];

const APPROVED_VERBS: Array<[string, string]> = [
  ['Add', 'Common'], ['Clear', 'Common'], ['Close', 'Common'], ['Copy', 'Common'], ['Enter', 'Common'], ['Exit', 'Common'], ['Find', 'Common'], ['Format', 'Common'], ['Get', 'Common'], ['Hide', 'Common'], ['Join', 'Common'], ['Lock', 'Common'], ['Move', 'Common'], ['New', 'Common'], ['Open', 'Common'], ['Optimize', 'Common'], ['Pop', 'Common'], ['Push', 'Common'], ['Redo', 'Common'], ['Remove', 'Common'], ['Rename', 'Common'], ['Reset', 'Common'], ['Resize', 'Common'], ['Search', 'Common'], ['Select', 'Common'], ['Set', 'Common'], ['Show', 'Common'], ['Skip', 'Common'], ['Split', 'Common'], ['Step', 'Common'], ['Switch', 'Common'], ['Undo', 'Common'], ['Unlock', 'Common'], ['Watch', 'Common'],
  ['Connect', 'Communications'], ['Disconnect', 'Communications'], ['Read', 'Communications'], ['Receive', 'Communications'], ['Send', 'Communications'], ['Write', 'Communications'],
  ['Backup', 'Data'], ['Checkpoint', 'Data'], ['Compare', 'Data'], ['Compress', 'Data'], ['Convert', 'Data'], ['ConvertFrom', 'Data'], ['ConvertTo', 'Data'], ['Dismount', 'Data'], ['Edit', 'Data'], ['Expand', 'Data'], ['Export', 'Data'], ['Group', 'Data'], ['Import', 'Data'], ['Initialize', 'Data'], ['Limit', 'Data'], ['Merge', 'Data'], ['Mount', 'Data'], ['Out', 'Data'], ['Publish', 'Data'], ['Restore', 'Data'], ['Save', 'Data'], ['Sync', 'Data'], ['Unpublish', 'Data'], ['Update', 'Data'],
  ['Debug', 'Diagnostic'], ['Measure', 'Diagnostic'], ['Ping', 'Diagnostic'], ['Repair', 'Diagnostic'], ['Resolve', 'Diagnostic'], ['Test', 'Diagnostic'], ['Trace', 'Diagnostic'],
  ['Approve', 'Lifecycle'], ['Assert', 'Lifecycle'], ['Build', 'Lifecycle'], ['Complete', 'Lifecycle'], ['Confirm', 'Lifecycle'], ['Deny', 'Lifecycle'], ['Deploy', 'Lifecycle'], ['Disable', 'Lifecycle'], ['Enable', 'Lifecycle'], ['Install', 'Lifecycle'], ['Invoke', 'Lifecycle'], ['Register', 'Lifecycle'], ['Request', 'Lifecycle'], ['Restart', 'Lifecycle'], ['Resume', 'Lifecycle'], ['Start', 'Lifecycle'], ['Stop', 'Lifecycle'], ['Submit', 'Lifecycle'], ['Suspend', 'Lifecycle'], ['Uninstall', 'Lifecycle'], ['Unregister', 'Lifecycle'], ['Wait', 'Lifecycle'],
  ['Block', 'Security'], ['Grant', 'Security'], ['Protect', 'Security'], ['Revoke', 'Security'], ['Unblock', 'Security'], ['Unprotect', 'Security'], ['Use', 'Other'],
];
export const APPROVED = new Set(APPROVED_VERBS.map(([v]) => v.toLowerCase()));

/** Built-in modules every Windows Server has. */
const BUILTIN_MODULES = ['ActiveDirectory', 'DnsServer', 'DhcpServer', 'GroupPolicy', 'Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Security', 'NetSecurity', 'NetTCPIP', 'ScheduledTasks', 'ServerManager', 'SmbShare', 'Storage', 'PKI', 'Pester', 'PowerShellGet', 'PackageManagement'];

/** Modules in the offline gallery Install-Module can install. */
export const GALLERY: Record<string, string> = { Pester: '5.6.1', PSScriptAnalyzer: '1.22.0', 'Microsoft.PowerShell.SecretManagement': '1.1.2', 'Microsoft.PowerShell.SecretStore': '1.0.6', ImportExcel: '7.8.9', PSWindowsUpdate: '2.2.1.5', dbatools: '2.1.23', Posh_SSH: '3.2.3' };

export function moduleInstalled(cx: Cx, name: string): boolean {
  const roots = [`C:\\Program Files\\WindowsPowerShell\\Modules\\${name}`, `C:\\Users\\${cx.env.sys.user}\\Documents\\WindowsPowerShell\\Modules\\${name}`];
  return roots.some((r) => !!lookup(cx.env.sys.fs, toVfs(cx.env, r), ROOT));
}

function functionsList(cx: Cx): Obj[] {
  return [...cx.env.vars.entries()].filter(([k, v]) => k.startsWith('function:') && !(v as Obj).__private).map(([, v]) => v as Obj);
}

const MODULE_ROOTS = (cx: Cx) => [`C:\\Users\\${cx.env.sys.user}\\Documents\\WindowsPowerShell\\Modules`, 'C:\\Program Files\\WindowsPowerShell\\Modules'];

/** Imports a module through its manifest: RootModule, ModuleVersion and FunctionsToExport. */
function importManifest(cx: Cx, psd: string, name: string): void {
  const m = parseManifest(readText(cx, psd));
  const dir = psd.replace(/[\\/][^\\/]*$/, '');
  const rootFile = m.root ? `${dir}\\${m.root}` : `${dir}\\${name}.psm1`;
  importModuleText(cx.env, readText(cx, rootFile), rootFile, name, { version: m.version, exports: m.exports });
}

function helpFor(fn: Obj): Record<string, string> {
  const src = String(fn.__src ?? '');
  const m = /<#([\s\S]*?)#>/.exec(src);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key = '';
  for (const raw of m[1].split('\n')) {
    const l = raw.trim();
    const k = /^\.(\w+)(?:\s+(\S+))?/.exec(l);
    if (k) {
      key = k[1].toUpperCase() + (k[2] ? ' ' + k[2] : '');
      out[key] = '';
      continue;
    }
    if (key) out[key] += (out[key] ? '\n' : '') + l;
  }
  return out;
}

function syntaxOf(fn: Obj): string {
  const block = fn.__block as { params?: Array<{ name: string; type?: string; attrs: Array<{ name: string; named: Record<string, unknown> }> }> } | undefined;
  const parts = (block?.params ?? []).map((p) => {
    const mand = p.attrs.some((a) => a.name.toLowerCase() === 'parameter' && a.named.mandatory !== undefined);
    const t = p.type ? (/switch/i.test(p.type) ? '' : ` <${p.type}>`) : ' <Object>';
    return mand ? `-${p.name}${t}` : `[-${p.name}${t}]`;
  });
  return `${fn.Name} ${parts.join(' ')}${block?.params ? ' [<CommonParameters>]' : ''}`.trim();
}

register(
  {
    /* ------------------------------------------------------------ output streams */
    'write-output': (cx) => {
      const vals = cx.pos.length ? cx.pos : cx.P.inputobject !== undefined ? [cx.P.inputobject] : cx.input ?? [];
      if (cx.P.noenumerate) return vals;
      return vals.flatMap((v) => (isArr(v) ? v : [v]));
    },
    'write-host': (cx) => {
      const sep = cx.P.separator !== undefined ? str(cx.P.separator) : ' ';
      const items = cx.pos.length ? cx.pos : cx.P.object !== undefined ? [cx.P.object] : cx.input ?? [];
      const text = items.map((v) => (isArr(v) ? v.map(str).join(sep) : isObj(v) && !isDate(v) && !isSpan(v) ? str(v) : str(v))).join(sep);
      streamWrite(cx.env, '6', text + (cx.P.nonewline ? '' : '\n'), { __type: 'information', MessageData: text });
      return [];
    },
    'write-verbose': (cx) => {
      const msg = str(cx.P.message ?? cx.pos[0] ?? input(cx)[0]);
      if (/^(continue|inquire|stop)$/i.test(str(getVariable(cx.env, 'VerbosePreference'))) || truthy(cx.P.verbose)) streamWrite(cx.env, '4', `VERBOSE: ${msg}\n`, { __type: 'verbose', Message: msg });
      return [];
    },
    'write-debug': (cx) => {
      const msg = str(cx.P.message ?? cx.pos[0]);
      if (/^(continue|inquire|stop)$/i.test(str(getVariable(cx.env, 'DebugPreference'))) || truthy(cx.P.debug)) streamWrite(cx.env, '5', `DEBUG: ${msg}\n`, { __type: 'debug', Message: msg });
      return [];
    },
    'write-warning': (cx) => {
      const msg = str(cx.P.message ?? cx.pos[0] ?? input(cx)[0]);
      if (!/silentlycontinue|ignore/i.test(str(cx.P.warningaction ?? getVariable(cx.env, 'WarningPreference')))) streamWrite(cx.env, '3', `WARNING: ${msg}\n`, { __type: 'warning', Message: msg });
      return [];
    },
    'write-information': (cx) => {
      const msg = str(cx.P.messagedata ?? cx.pos[0]);
      const shown = /^(continue|inquire|stop)$/i.test(str(cx.P.informationaction ?? getVariable(cx.env, 'InformationPreference')));
      // Information records are kept even when not shown, so 6>&1 still captures them.
      if (!routeStream(cx.env, '6', `${msg}\n`, { __type: 'information', MessageData: msg }) && shown) cx.print(`${msg}\n`);
      return [];
    },
    'write-progress': () => [],
    'write-error': (cx) => {
      const msg = str(cx.P.message ?? cx.pos[0] ?? (isObj(cx.P.exception) ? prop(cx.P.exception, 'Message') : '') ?? input(cx)[0]);
      const inv = getVariable(cx.env, 'MyInvocation') as Obj | null;
      const fnName = inv && isObj(inv.MyCommand) ? str((inv.MyCommand as Obj).Name) : '';
      const rec = isObj(cx.P.errorrecord) ? (cx.P.errorrecord as Obj) : errorRecord(msg, 'WriteErrorException', { command: fnName || 'Write-Error', category: str(cx.P.category ?? 'NotSpecified'), id: str(cx.P.errorid ?? 'Microsoft.PowerShell.Commands.WriteErrorException'), target: cx.P.targetobject });
      reportError(cx.env, rec, cx.P.errorvariable !== undefined ? str(cx.P.errorvariable) : undefined, cx.P.erroraction !== undefined ? str(cx.P.erroraction) : undefined);
      return [];
    },
    'read-host': (cx) => {
      const queue = cx.env.vars.get('__readhost') as Value[] | undefined;
      const prompt = cx.P.prompt ?? cx.pos[0];
      if (queue?.length) {
        const v = queue.shift();
        if (prompt !== undefined) cx.print(`${str(prompt)}: ${cx.P.assecurestring ? '********' : str(v)}\n`);
        return [cx.P.assecurestring ? { [SECURE]: true, plain: str(v) } : str(v)];
      }
      cx.print(`${prompt !== undefined ? str(prompt) + ': ' : ''}\n(Read-Host cannot wait for typing in this terminal, so it returned an empty answer. Scripts that run unattended should take parameters instead.)\n`);
      return [cx.P.assecurestring ? { [SECURE]: true, plain: '' } : ''];
    },
    'out-null': () => [],
    'out-host': (cx) => {
      cx.print(render(input(cx)));
      return [];
    },
    'out-default': (cx) => {
      cx.print(render(input(cx)));
      return [];
    },
    'out-string': (cx) => {
      const text = render(input(cx)).replace(/^\n/, '');
      return cx.P.stream ? text.replace(/\n$/, '').split('\n') : [text];
    },
    'out-file': (cx) => {
      const path = str(cx.P.filepath ?? cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const vals = input(cx);
      const allText = vals.every((v) => typeof v === 'string' || typeof v === 'number');
      const text = allText ? vals.map(str).join('\r\n') + (cx.P.nonewline ? '' : '\r\n') : render(vals).replace(/^\n/, '');
      writeText(cx, path, text, !!cx.P.append);
      return [];
    },
    'tee-object': (cx) => {
      const vals = input(cx);
      if (cx.P.variable !== undefined) setVariable(cx.env, str(cx.P.variable), collapseV(vals));
      const path = cx.P.filepath ?? cx.P.path ?? cx.pos[0];
      if (path !== undefined) writeText(cx, str(path), render(vals).replace(/^\n/, ''), !!cx.P.append);
      return vals;
    },

    /* ------------------------------------------------------------ pipeline */
    'foreach-object': (cx) => {
      const env = cx.env;
      const bl = blocks(cx);
      const begin = blockArg(cx.P.begin);
      const end = blockArg(cx.P.end);
      const proc = asList(cx.P.process).filter(isBlock) as Obj[];
      let pBlocks = proc.length ? proc : bl;
      let b = begin;
      let e = end;
      if (!proc.length && !begin && !end && bl.length >= 2) {
        b = bl[0];
        pBlocks = [bl[1]];
        e = bl[2];
      }
      const member = cx.P.membername ?? (pBlocks.length ? undefined : cx.pos.find((x) => !isBlock(x)));
      if (!pBlocks.length && member === undefined) cx.fail("ForEach-Object needs a script block: ForEach-Object { $_ ... }");
      const out: Value[] = [];
      if (b) out.push(...runBlock(env, b, { newScope: false }));
      for (const item of cx.input ?? (cx.P.inputobject !== undefined ? [cx.P.inputobject] : [])) {
        if (member !== undefined) {
          const name = str(member);
          const pv = getMember(env, item, name);
          if (pv !== null && pv !== undefined) out.push(...(isArr(pv) ? pv : [pv]));
          else {
            try {
              const r = invokeMethod(env, item, name, asList(cx.P.argumentlist));
              if (r !== undefined) out.push(r);
            } catch {
              /* neither a property nor a method */
            }
          }
          continue;
        }
        for (const pb of pBlocks) out.push(...runBlock(env, pb, { dollarUnder: item, newScope: false, args: asList(cx.P.argumentlist) }));
      }
      if (e) out.push(...runBlock(env, e, { newScope: false }));
      return out;
    },
    'where-object': (cx) => {
      const env = cx.env;
      const items = input(cx);
      const fs = blocks(cx)[0] ?? blockArg(cx.P.filterscript);
      if (fs) return items.filter((item) => truthy(collapseV(runBlock(env, fs, { dollarUnder: item, newScope: false }))));
      // Simplified syntax: Where-Object Property -Operator Value, Where-Object Property, Where-Object -Not Property
      const property = str(cx.P.property ?? cx.pos.find((x) => !isBlock(x)) ?? '');
      const ops = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin', 'is', 'isnot'];
      const opKey = Object.keys(cx.P).find((k) => ops.includes(k.replace(/^c(?=[a-z]{2})/, '').replace(/^i(?=[a-z]{2})/, '')) && k !== 'inputobject');
      if (!property) cx.fail("Where-Object needs a script block or a property: Where-Object { $_.Name -like 'A*' } or Where-Object Name -like 'A*'");
      if (!opKey) {
        const negate = !!cx.P.not;
        return items.filter((item) => truthy(getMember(env, item, property)) !== negate);
      }
      const value = cx.P[opKey] === true && cx.pos.length > 1 ? cx.pos[1] : cx.P[opKey];
      return items.filter((item) => truthy(binaryOpSafe(cx, opKey, getMember(env, item, property), value)));
    },
    'select-object': (cx) => {
      let items = input(cx);
      const first = cx.P.first !== undefined ? num(cx.P.first) : undefined;
      const last = cx.P.last !== undefined ? num(cx.P.last) : undefined;
      const skip = cx.P.skip !== undefined ? num(cx.P.skip) : 0;
      const raw = cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined);
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      if (cx.P.unique) {
        const seen = new Set<string>();
        items = items.filter((x) => {
          const k = isObj(x) ? JSON.stringify(allProps(x).map(([, v]) => str(v))) : str(x).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      if (cx.P.index !== undefined) items = asList(cx.P.index).map((i) => items[num(i)]).filter((x) => x !== undefined);
      items = items.slice(skip);
      if (first !== undefined || last !== undefined) items = [...(first !== undefined ? items.slice(0, first) : []), ...(last !== undefined ? items.slice(Math.max(0, items.length - last)) : [])];
      if (cx.P.expandproperty !== undefined) {
        const name = str(cx.P.expandproperty);
        return items.flatMap((o) => {
          const v = getMember(cx.env, o, name);
          if (v === null || v === undefined) cx.fail(`Property "${name}" cannot be found.`);
          return isArr(v) ? v : [v];
        });
      }
      if (!specs.length || (specs.length === 1 && specs[0].wildcard && specs[0].name === '*' && cx.P.excludeproperty === undefined)) return items;
      const exclude = asList(cx.P.excludeproperty).map((x) => wildRe(str(x)));
      return items.map((o) => {
        const out: Obj = { __type: 'select' };
        for (const s of specs) {
          if (s.wildcard) {
            for (const [k, v] of allProps(o)) if (s.wildcard.test(k) && !exclude.some((re) => re.test(k))) out[k] = v;
            continue;
          }
          const key = isObj(o) ? allProps(o).find(([k]) => k.toLowerCase() === s.name.toLowerCase())?.[0] ?? s.name : s.name;
          out[key] = s.get(o) ?? null;
        }
        return out;
      });
    },
    'sort-object': (cx) => {
      const items = [...input(cx)];
      const raw = cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined);
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      const desc = !!cx.P.descending;
      const keyed = items.map((item) => ({ item, keys: specs.length ? specs.map((s) => s.get(item)) : [item] }));
      keyed.sort((a, b) => {
        for (let i = 0; i < a.keys.length; i++) {
          let c = orderOf(a.keys[i], b.keys[i]);
          const d = specs[i]?.descending ?? desc;
          if (d) c = -c;
          if (c) return c;
        }
        return 0;
      });
      let out = keyed.map((k) => k.item);
      if (cx.P.unique) out = out.filter((x, i) => i === 0 || orderOf(specs.length ? specs[0].get(out[i - 1]) : out[i - 1], specs.length ? specs[0].get(x) : x) !== 0);
      if (cx.P.top !== undefined) out = out.slice(0, num(cx.P.top));
      if (cx.P.bottom !== undefined) out = out.slice(-num(cx.P.bottom));
      return out;
    },
    'group-object': (cx) => {
      const raw = cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined);
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      const groups = new Map<string, { name: string; values: Value[]; items: Value[] }>();
      for (const item of input(cx)) {
        const values = specs.length ? specs.map((s) => s.get(item)) : [item];
        const name = values.map(str).join(', ');
        const k = cx.P.casesensitive ? name : name.toLowerCase();
        if (!groups.has(k)) groups.set(k, { name, values, items: [] });
        groups.get(k)!.items.push(item);
      }
      const list = [...groups.values()].sort((a, b) => orderOf(a.values[0], b.values[0]));
      if (cx.P.ashashtable) {
        const h: Obj = { __type: 'hashtable' };
        for (const g of list) h[g.name] = g.items.length === 1 ? g.items[0] : g.items;
        return [h];
      }
      return list.map((g) => (cx.P.noelement ? { __type: 'groupinfo', Count: g.items.length, Name: g.name } : { __type: 'groupinfo', Count: g.items.length, Name: g.name, Group: g.items, __extra: { Values: g.values } }));
    },
    'measure-object': (cx) => {
      const items = input(cx);
      const p = cx.P.property ?? cx.pos[0];
      const o: Obj = { __type: 'measureinfo' };
      if (cx.P.line || cx.P.word || cx.P.character) {
        const text = items.map(str).join('\n');
        const lines = items.flatMap((x) => str(x).split('\n'));
        if (cx.P.line) o.Lines = lines.length;
        if (cx.P.word) o.Words = text.split(/\s+/).filter(Boolean).length;
        if (cx.P.character) o.Characters = items.reduce<number>((a, x) => a + str(x).length, 0);
        o.Property = '';
        return [{ ...o, __type: 'select' }];
      }
      const vals = (p !== undefined ? items.map((i) => getMember(cx.env, i, str(p))) : items).filter((v) => v !== null && v !== undefined);
      o.Count = vals.length;
      const want = (k: string) => !!cx.P[k] || !!cx.P.allstats;
      const nums = vals.map((v) => (typeof v === 'number' ? v : Number(str(v))));
      if ((want('sum') || want('average')) && nums.some((n) => Number.isNaN(n))) cx.fail(`Input object "${str(vals[nums.findIndex((n) => Number.isNaN(n))])}" is not numeric.`);
      o.Average = want('average') ? (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null) : null;
      o.Sum = want('sum') ? nums.reduce((a, b) => a + b, 0) : null;
      o.Maximum = want('maximum') ? (vals.length ? [...vals].sort(orderOf).pop()! : null) : null;
      o.Minimum = want('minimum') ? (vals.length ? [...vals].sort(orderOf)[0] : null) : null;
      o.Property = p !== undefined ? str(p) : null;
      return [o];
    },
    'compare-object': (cx) => {
      const ref = asList(cx.P.referenceobject ?? cx.pos[0]);
      const dif = asList(cx.P.differenceobject ?? cx.pos[1]);
      const specs = cx.P.property !== undefined ? propSpecs(cx, cx.P.property) : [];
      const key = (v: Value) => (specs.length ? specs.map((s) => str(s.get(v)).toLowerCase()).join('\u0000') : isObj(v) ? JSON.stringify(allProps(v).map(([, x]) => str(x))) : str(v).toLowerCase());
      const out: Obj[] = [];
      const shape = (v: Value, side: string) => (specs.length ? { __type: 'select', ...Object.fromEntries(specs.map((s) => [s.name, s.get(v)])), SideIndicator: side } : { __type: 'select', InputObject: v, SideIndicator: side });
      const refKeys = ref.map(key);
      const difKeys = dif.map(key);
      if (cx.P.includeequal) ref.forEach((v, i) => difKeys.includes(refKeys[i]) && out.push(shape(v, '==')));
      if (!cx.P.excludedifferent) {
        dif.forEach((v, i) => !refKeys.includes(difKeys[i]) && out.push(shape(v, '=>')));
        ref.forEach((v, i) => !difKeys.includes(refKeys[i]) && out.push(shape(v, '<=')));
      }
      if (cx.P.passthru) return out.map((o) => o.InputObject ?? o);
      return out;
    },
    'get-unique': (cx) => input(cx).filter((x, i, a) => i === 0 || str(a[i - 1]) !== str(x)),
    'get-member': (cx) => {
      const items = input(cx);
      const filter = cx.P.membertype !== undefined ? str(cx.P.membertype).toLowerCase() : undefined;
      const nameRe = cx.P.name !== undefined || cx.pos[0] !== undefined ? wildRe(str(cx.P.name ?? cx.pos[0])) : undefined;
      const seen = new Set<string>();
      const out: Obj[] = [];
      for (const v of items.length ? items : cx.P.inputobject !== undefined ? [cx.P.inputobject] : []) {
        const tn = typeNameOf(v);
        if (seen.has(tn)) continue;
        seen.add(tn);
        for (const m of membersOf(v)) {
          if (filter && !m.MemberType.toLowerCase().includes(filter.replace(/s$/, ''))) continue;
          if (nameRe && !nameRe.test(m.Name)) continue;
          out.push({ __type: 'getmember', Name: m.Name, MemberType: m.MemberType, Definition: m.Definition, __typename: tn, __extra: { TypeName: tn } });
        }
      }
      if (!out.length && !items.length) cx.fail('You must specify an object for the Get-Member cmdlet.');
      return out;
    },

    /* ------------------------------------------------------------ formatting */
    'format-table': (cx) => {
      const raw = cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined);
      const items = input(cx);
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      const shaped = specs.length ? items.map((o) => Object.fromEntries([['__type', 'select'], ...specs.flatMap((s) => (s.wildcard ? allProps(o).filter(([k]) => s.wildcard!.test(k)) : [[s.name, s.get(o)]]))])) : items;
      cx.print(render(shaped as Value[], true));
      return [];
    },
    'format-list': (cx) => {
      const raw = cx.P.property ?? (cx.pos.length ? (cx.pos.length > 1 ? cx.pos : cx.pos[0]) : undefined);
      const items = input(cx);
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      const shaped = items.map((o) => (specs.length ? Object.fromEntries([['__type', 'list'], ...specs.flatMap((s) => (s.wildcard ? allProps(o) : [[s.name, s.get(o)]]))]) : isObj(o) ? { ...(o as Obj), __type: 'list' } : o));
      cx.print(render(shaped as Value[], false, true));
      return [];
    },
    'format-wide': (cx) => {
      const p = cx.P.property ?? cx.pos[0];
      cx.print('\n' + input(cx).map((o) => str(p ? getMember(cx.env, o, str(p)) : prop(o, 'Name') ?? o)).join('    ') + '\n\n');
      return [];
    },

    /* ------------------------------------------------------------ data formats */
    'convertto-json': (cx) => {
      const vals = input(cx);
      const depth = cx.P.depth !== undefined ? num(cx.P.depth) : 2;
      const v = vals.length === 1 && !cx.P.asarray ? vals[0] : vals;
      return [toJson(v, depth, 4, !!cx.P.compress)];
    },
    'convertfrom-json': (cx) => {
      const text = input(cx).map(str).join('\n');
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return cx.fail(`Invalid JSON primitive: ${text.trim().slice(0, 20)}. (${(e as Error).message})`);
      }
      const v = fromJson(data, !!cx.P.ashashtable);
      return isArr(v) && !cx.P.noenumerate ? v : [v];
    },
    'convertto-csv': (cx) => toCsvLines(input(cx), str(cx.P.delimiter ?? ','), !cx.P.notypeinformation && !cx.P.nti),
    'convertfrom-csv': (cx) => fromCsvText(input(cx).map(str).join('\n'), str(cx.P.delimiter ?? ','), cx.P.header !== undefined ? asList(cx.P.header).map(str) : undefined),
    'export-csv': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      if (!path) cx.fail('Export-Csv needs -Path.');
      const delim = str(cx.P.delimiter ?? ',');
      const vfs = toVfs(cx.env, path);
      const exists = !!lookup(cx.env.sys.fs, vfs, ROOT);
      const append = !!cx.P.append && exists;
      const lines = toCsvLines(input(cx), delim, !cx.P.notypeinformation && !cx.P.nti && !append, !append);
      writeText(cx, path, lines.map((l) => l + '\r\n').join(''), append);
      return [];
    },
    'import-csv': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      let text: string;
      try {
        text = readFile(cx.env.sys.fs, toVfs(cx.env, path), ROOT);
      } catch {
        return cx.fail(`Could not find file '${resolveWin(cx, path)}'.`);
      }
      return fromCsvText(text, str(cx.P.delimiter ?? ','), cx.P.header !== undefined ? asList(cx.P.header).map(str) : undefined);
    },
    'convertto-html': (cx) => {
      const items = input(cx);
      const raw = cx.P.property;
      const specs = raw === undefined ? [] : propSpecs(cx, raw);
      const keys = specs.length ? specs.map((s) => s.name) : items.length && isObj(items[0]) ? allProps(items[0]).map(([k]) => k) : ['*'];
      const cell = (o: Value, k: string, i: number) => esc(str(specs.length ? specs[i].get(o) : isObj(o) ? prop(o, k) : o));
      const asList_ = /^list$/i.test(str(cx.P.as ?? 'Table'));
      const table = asList_
        ? ['<table>', ...items.flatMap((o) => keys.map((k, i) => `<tr><td>${esc(k)}:</td><td>${cell(o, k, i)}</td></tr>`)), '</table>']
        : ['<table>', `<colgroup>${keys.map(() => '<col/>').join('')}</colgroup>`, `<tr>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr>`, ...items.map((o) => `<tr>${keys.map((k, i) => `<td>${cell(o, k, i)}</td>`).join('')}</tr>`), '</table>'];
      const pre = asList(cx.P.precontent).map(str);
      const post = asList(cx.P.postcontent).map(str);
      if (cx.P.fragment) return [...pre, ...table, ...post];
      const head = cx.P.head !== undefined ? asList(cx.P.head).map(str) : [`<title>${esc(str(cx.P.title ?? 'HTML TABLE'))}</title>`];
      const css = cx.P.cssuri !== undefined ? [`<link rel="stylesheet" type="text/css" href="${esc(str(cx.P.cssuri))}" />`] : [];
      return ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">', '<html xmlns="http://www.w3.org/1999/xhtml">', '<head>', ...head, ...css, '</head><body>', ...pre, ...table, ...post, '</body></html>'];
    },

    /* ------------------------------------------------------------ objects and variables */
    'new-object': (cx) => {
      const type = str(cx.P.typename ?? cx.pos[0]);
      const args = asList(cx.P.argumentlist ?? cx.pos[1]);
      const o = construct(cx.env, type, args);
      if (cx.P.property !== undefined && isHash(cx.P.property) && isObj(o)) {
        for (const [k, v] of Object.entries(cx.P.property as Obj)) if (!k.startsWith('__')) (o as Obj)[k] = v;
      }
      return [o];
    },
    'add-member': (cx) => {
      const targets = input(cx);
      const kind = str(cx.P.membertype ?? (cx.P.notepropertyname !== undefined || cx.P.notepropertymembers !== undefined ? 'NoteProperty' : cx.pos[0] ?? 'NoteProperty')).toLowerCase();
      const name = str(cx.P.name ?? cx.P.notepropertyname ?? (cx.P.membertype !== undefined ? cx.pos[0] : cx.pos[1]));
      const value = cx.P.value ?? cx.P.notepropertyvalue ?? (cx.P.membertype !== undefined ? cx.pos[1] : cx.pos[2]);
      for (const t of targets) {
        if (!isObj(t)) cx.fail(`Cannot add a member to a ${typeNameOf(t)} in this simulator: wrap values in [pscustomobject] first.`);
        const o = t as Obj;
        if (cx.P.notepropertymembers !== undefined && isHash(cx.P.notepropertymembers)) {
          for (const [k, v] of Object.entries(cx.P.notepropertymembers as Obj)) if (!k.startsWith('__')) o[k] = v;
          continue;
        }
        const existing = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
        if (kind === 'scriptmethod') {
          o.__scriptmethods = { ...((o.__scriptmethods as Obj) ?? {}), [name.toLowerCase()]: value };
          continue;
        }
        if (existing && !cx.P.force) cx.fail(`Cannot add a member with the name "${name}" because a member with that name already exists. To overwrite the member anyway, add the Force parameter to your command.`);
        if (kind === 'aliasproperty') o[name] = prop(o, str(value));
        else if (kind === 'scriptproperty') o[name] = collapseV(runBlock(cx.env, value, { vars: { this: o } }));
        else o[existing ?? name] = value;
      }
      return cx.P.passthru ? targets : [];
    },
    'get-variable': (cx) => {
      const want = cx.P.name ?? cx.pos[0];
      const scopes: Array<[string, Value]> = [];
      for (const [k, v] of cx.env.vars) if (!k.includes(':') && !k.startsWith('__')) scopes.push([k, v]);
      const list = want === undefined ? scopes : scopes.filter(([k]) => asList(want).some((w) => wildRe(str(w)).test(k)));
      if (want !== undefined && !list.length && !/[*?]/.test(str(want))) {
        const v = getVariable(cx.env, str(want));
        if (v !== null) return cx.P.valueonly ? [v] : [{ __type: 'select', Name: str(want), Value: v }];
        cx.fail(`Cannot find a variable with the name '${str(want)}'.`);
      }
      return cx.P.valueonly ? list.map(([, v]) => v) : list.map(([k, v]) => ({ __type: 'select', Name: k, Value: v }));
    },
    'set-variable': (cx) => {
      setVariable(cx.env, str(cx.P.name ?? cx.pos[0]), cx.P.value ?? cx.pos[1] ?? null, cx.P.scope !== undefined ? str(cx.P.scope).toLowerCase() : undefined);
      return [];
    },
    'new-variable': (cx) => {
      setVariable(cx.env, str(cx.P.name ?? cx.pos[0]), cx.P.value ?? cx.pos[1] ?? null, cx.P.scope !== undefined ? str(cx.P.scope).toLowerCase() : undefined);
      return [];
    },
    'remove-variable': (cx) => {
      for (const n of asList(cx.P.name ?? cx.pos[0])) {
        let s = cx.env.scope;
        while (s) {
          s.vars.delete(str(n).toLowerCase());
          s = s.parent ?? undefined;
        }
      }
      return [];
    },
    'clear-variable': (cx) => {
      for (const n of asList(cx.P.name ?? cx.pos[0])) setVariable(cx.env, str(n), null);
      return [];
    },

    /* ------------------------------------------------------------ dates, timing, randomness */
    'get-date': (cx) => {
      let ms = cx.env.sys.now;
      const base = cx.P.date ?? cx.pos[0];
      if (base !== undefined) {
        const d = isDate(base) ? (base as Obj) : (convertTo('datetime', base) as Obj);
        ms = msOf(d);
      }
      const d = new Date(ms);
      const part = (k: string, cur: number) => (cx.P[k] !== undefined ? num(cx.P[k]) : cur);
      ms = Date.UTC(part('year', d.getUTCFullYear()), part('month', d.getUTCMonth() + 1) - 1, part('day', d.getUTCDate()), part('hour', d.getUTCHours()), part('minute', d.getUTCMinutes()), part('second', d.getUTCSeconds()), part('millisecond', d.getUTCMilliseconds()));
      if (cx.P.format !== undefined) return [formatDate(ms, str(cx.P.format))];
      if (cx.P.uformat !== undefined) return [uformat(ms, str(cx.P.uformat))];
      return [makeDate(ms)];
    },
    'new-timespan': (cx) => {
      if (cx.P.start !== undefined || cx.P.end !== undefined) {
        const s = cx.P.start !== undefined ? msOf(convertTo('datetime', cx.P.start) as Obj) : cx.env.sys.now;
        const e = cx.P.end !== undefined ? msOf(convertTo('datetime', cx.P.end) as Obj) : cx.env.sys.now;
        return [makeSpan(e - s)];
      }
      const n = (k: string) => (cx.P[k] !== undefined ? num(cx.P[k]) : 0);
      return [makeSpan(((n('days') * 24 + n('hours')) * 60 + n('minutes')) * 60000 + n('seconds') * 1000 + n('milliseconds'))];
    },
    'start-sleep': (cx) => {
      const ms = cx.P.milliseconds !== undefined ? num(cx.P.milliseconds) : num(cx.P.seconds ?? cx.pos[0] ?? 0) * 1000;
      cx.env.sys.now += ms;
      return [];
    },
    'measure-command': (cx) => {
      const b = blocks(cx)[0] ?? blockArg(cx.P.expression);
      const before = cx.env.sys.now;
      if (b) runBlock(cx.env, b, { newScope: false });
      return [makeSpan(cx.env.sys.now - before + 12 + (String(b?.src ?? '').length % 40))];
    },
    'get-random': (cx) => {
      let seed = Number(cx.env.vars.get('__rand') ?? (cx.env.sys.now % 2147483647)) || 1;
      if (cx.P.setseed !== undefined) seed = num(cx.P.setseed) || 1;
      const rnd = () => {
        seed = (seed * 48271) % 2147483647;
        cx.env.vars.set('__rand', seed);
        return seed / 2147483647;
      };
      const pool = cx.P.inputobject !== undefined ? asList(cx.P.inputobject) : cx.input;
      if (pool && pool.length) {
        const count = cx.P.count !== undefined ? num(cx.P.count) : 1;
        const copy = [...pool];
        const out: Value[] = [];
        while (out.length < count && copy.length) out.push(copy.splice(Math.floor(rnd() * copy.length), 1)[0]);
        return out;
      }
      const min = cx.P.minimum !== undefined ? num(cx.P.minimum) : 0;
      const max = cx.P.maximum !== undefined ? num(cx.P.maximum) : cx.pos[0] !== undefined ? num(cx.pos[0]) : 2147483647;
      if (max <= min) cx.fail(`The Minimum value (${min}) cannot be greater than or equal to the Maximum value (${max}).`);
      return [min + Math.floor(rnd() * (max - min))];
    },
    'new-guid': (cx) => [invokeStatic(cx, 'guid', 'NewGuid')],
    'invoke-expression': (cx) => runBlock(cx.env, { __type: 'block', src: str(cx.P.command ?? cx.pos[0]) }, { newScope: false }),

    /* ------------------------------------------------------------ commands and help */
    'get-command': (cx) => {
      const pat = cx.P.name ?? cx.pos[0];
      const mods = (cx.env.vars.get('__modules') as Obj[] | undefined) ?? [];
      const fns = functionsList(cx).map((f) => ({ __type: 'cmd', CommandType: String(f.CommandType ?? 'Function'), Name: String(f.Name), Version: f.__module ? str(mods.find((m) => str(m.Name) === str(f.__module))?.Version ?? '') : '', Source: str(f.__module ?? '') }));
      if (cx.P.module !== undefined) {
        const want = asList(cx.P.module).map(str);
        return fns.filter((f) => want.some((w) => wildRe(w).test(f.Source))).sort((a, b) => a.Name.localeCompare(b.Name));
      }
      const cmds = cmdletNames().map((n) => ({ __type: 'cmd', CommandType: 'Cmdlet', Name: n, Version: '3.1.0.0', Source: '' }));
      const aliases = Object.keys(ALIASES).map((a) => ({ __type: 'cmd', CommandType: 'Alias', Name: `${a} -> ${cmdletNames().find((n) => n.toLowerCase() === ALIASES[a]) ?? ALIASES[a]}`, Version: '', Source: '' }));
      const natives = Object.keys(NATIVE_TABLE).map((n) => ({ __type: 'cmd', CommandType: 'Application', Name: n + '.exe', Version: '10.0.20348.1', Source: 'C:\\Windows\\system32\\' + n + '.exe' }));
      let all = [...fns, ...cmds, ...(cx.P.commandtype && /alias/i.test(str(cx.P.commandtype)) ? aliases : []), ...(cx.P.verb === undefined && cx.P.noun === undefined ? natives : [])];
      if (pat !== undefined) all = all.filter((c) => asList(pat).some((p) => wildRe(str(p)).test(String(c.Name).replace(/ ->.*$/, ''))) || (!/[*?]/.test(str(pat)) && ALIASES[str(pat).toLowerCase()] && String(c.Name).toLowerCase() === ALIASES[str(pat).toLowerCase()]));
      if (cx.P.verb !== undefined) all = all.filter((c) => wildRe(str(cx.P.verb)).test(String(c.Name).split('-')[0]));
      if (cx.P.noun !== undefined) all = all.filter((c) => wildRe(str(cx.P.noun)).test(String(c.Name).split('-').slice(1).join('-')));
      if (cx.P.commandtype !== undefined) all = all.filter((c) => new RegExp(str(cx.P.commandtype), 'i').test(String(c.CommandType)));
      if (pat !== undefined && !all.length && !/[*?]/.test(str(pat))) cx.fail(`The term '${str(pat)}' is not recognized as the name of a cmdlet, function, script file, or operable program.`);
      return all.sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
    },
    'get-alias': (cx) => {
      const pat = cx.P.name ?? cx.pos[0];
      const def = cx.P.definition;
      return Object.entries(ALIASES)
        .filter(([a, t]) => (pat === undefined || wildRe(str(pat)).test(a)) && (def === undefined || wildRe(str(def)).test(t)))
        .map(([a, t]) => ({ __type: 'cmd', CommandType: 'Alias', Name: `${a} -> ${cmdletNames().find((n) => n.toLowerCase() === t) ?? t}`, Version: '', Source: '' }));
    },
    'set-alias': (cx) => {
      ALIASES[str(cx.P.name ?? cx.pos[0]).toLowerCase()] = str(cx.P.value ?? cx.pos[1]).toLowerCase();
      return [];
    },
    'new-alias': (cx) => {
      ALIASES[str(cx.P.name ?? cx.pos[0]).toLowerCase()] = str(cx.P.value ?? cx.pos[1]).toLowerCase();
      return [];
    },
    'get-verb': (cx) => APPROVED_VERBS.filter(([v]) => cx.pos[0] === undefined && cx.P.verb === undefined ? true : wildRe(str(cx.P.verb ?? cx.pos[0])).test(v)).map(([Verb, Group]) => ({ __type: 'select', Verb, AliasPrefix: Verb.slice(0, 2).toLowerCase(), Group, Description: '' })),
    'get-help': (cx) => {
      const topic = str(cx.P.name ?? cx.pos[0]);
      const fn = cx.env.vars.get('function:' + topic.toLowerCase()) as Obj | undefined;
      if (!fn) return CMDLET_TABLE['__get-help'] ? CMDLET_TABLE['__get-help'](cx) : oldHelp ? oldHelp(cx) : [];
      const h = helpFor(fn);
      const lines = ['', 'NAME', `    ${fn.Name}`, '', 'SYNOPSIS', `    ${h.SYNOPSIS ?? ''}`, '', '', 'SYNTAX', `    ${syntaxOf(fn)}`, '', ''];
      if (h.DESCRIPTION) lines.push('DESCRIPTION', ...h.DESCRIPTION.split('\n').map((l) => '    ' + l), '', '');
      if (cx.P.full || cx.P.detailed || cx.P.parameter) {
        const ps = Object.entries(h).filter(([k]) => k.startsWith('PARAMETER '));
        if (ps.length) lines.push('PARAMETERS', ...ps.flatMap(([k, v]) => [`    -${k.slice(10)}`, ...v.split('\n').map((l) => '        ' + l), '']));
      }
      if (cx.P.examples || cx.P.full || cx.P.detailed) {
        const ex = Object.entries(h).filter(([k]) => k.startsWith('EXAMPLE'));
        ex.forEach(([, v], i) => lines.push(`    -------------------------- EXAMPLE ${i + 1} --------------------------`, '', ...v.split('\n').map((l) => '    ' + l), ''));
      }
      if (!h.SYNOPSIS) lines.push('REMARKS', '    This function has no comment-based help. Add a <# .SYNOPSIS ... #> block at the start of its body.', '');
      return [lines.join('\n')];
    },

    /* ------------------------------------------------------------ modules, policy, signing, transcripts */
    'import-module': (cx) => {
      for (const n of asList(cx.P.name ?? cx.pos[0])) {
        const name = str(n);
        if (/\.(psm1|ps1)$/i.test(name)) {
          const text = readText(cx, name);
          importModuleText(cx.env, text, resolveWin(cx, name), name.replace(/^.*[\\/]/, '').replace(/\.\w+$/, ''));
          continue;
        }
        if (/\.psd1$/i.test(name)) {
          importManifest(cx, resolveWin(cx, name), name.replace(/^.*[\\/]/, '').replace(/\.\w+$/, ''));
          continue;
        }
        if (BUILTIN_MODULES.some((m) => m.toLowerCase() === name.toLowerCase())) continue;
        let found = false;
        for (const root of MODULE_ROOTS(cx)) {
          const psd = toVfs(cx.env, `${root}\\${name}\\${name}.psd1`);
          const psm = toVfs(cx.env, `${root}\\${name}\\${name}.psm1`);
          const ld = lookup(cx.env.sys.fs, psd, ROOT);
          const lm = lookup(cx.env.sys.fs, psm, ROOT);
          if (ld && ld.node.type === 'file') importManifest(cx, toWin(psd), name);
          else if (lm && lm.node.type === 'file') importModuleText(cx.env, lm.node.content, toWin(psm), name);
          else continue;
          found = true;
          break;
        }
        if (found) continue;
        if (moduleInstalled(cx, name)) continue;
        cx.fail(`The specified module '${name}' was not loaded because no valid module file was found in any module directory.`);
      }
      return [];
    },
    'get-module': (cx) => {
      const loaded = (cx.env.vars.get('__modules') as Obj[] | undefined) ?? [];
      if (cx.P.listavailable) {
        const installed = Object.keys(GALLERY).filter((m) => moduleInstalled(cx, m)).map((m) => ({ __type: 'module', ModuleType: 'Script', Version: GALLERY[m], Name: m, ExportedCommands: '{...}' }));
        const builtIn = BUILTIN_MODULES.map((m) => ({ __type: 'module', ModuleType: 'Manifest', Version: m === 'Pester' ? '3.4.0' : '1.0.0.0', Name: m, ExportedCommands: '{...}' }));
        for (const root of MODULE_ROOTS(cx)) {
          const l = lookup(cx.env.sys.fs, toVfs(cx.env, root), ROOT);
          if (!l || l.node.type !== 'dir') continue;
          for (const dir of Object.keys(l.node.children)) {
            if ([...installed, ...builtIn].some((m) => str(m.Name).toLowerCase() === dir.toLowerCase())) continue;
            const psd = lookup(cx.env.sys.fs, toVfs(cx.env, `${root}\\${dir}\\${dir}.psd1`), ROOT);
            const psm = lookup(cx.env.sys.fs, toVfs(cx.env, `${root}\\${dir}\\${dir}.psm1`), ROOT);
            if (psd?.node.type === 'file') installed.push({ __type: 'module', ModuleType: 'Script', Version: parseManifest(psd.node.content).version ?? '0.0', Name: dir, ExportedCommands: '{...}' });
            else if (psm?.node.type === 'file') installed.push({ __type: 'module', ModuleType: 'Script', Version: '0.0', Name: dir, ExportedCommands: '{...}' });
          }
        }
        const want = cx.P.name ?? cx.pos[0];
        return [...installed, ...builtIn].filter((m) => want === undefined || wildRe(str(want)).test(String(m.Name)));
      }
      return loaded.map((m) => ({ ...m, __type: 'module' }));
    },
    'remove-module': (cx) => {
      const name = str(cx.P.name ?? cx.pos[0]).toLowerCase();
      for (const [k, v] of [...cx.env.vars]) if (k.startsWith('function:') && isObj(v) && str(v.__module).toLowerCase() === name) cx.env.vars.delete(k);
      cx.env.vars.set('__modules', ((cx.env.vars.get('__modules') as Obj[] | undefined) ?? []).filter((m) => str(m.Name).toLowerCase() !== name));
      return [];
    },
    'export-modulemember': (cx) => {
      const list = cx.env.vars.get('__exporting');
      if (Array.isArray(list)) list.push(...asList(cx.P.function ?? cx.pos[0]).map(str));
      return [];
    },
    'new-modulemanifest': (cx) => {
      const path = str(cx.P.path ?? cx.pos[0]);
      const v = (k: string, d: string) => (cx.P[k] !== undefined ? str(cx.P[k]) : d);
      const fns = asList(cx.P.functionstoexport).map((f) => `'${str(f)}'`).join(', ') || "'*'";
      writeText(cx, path, `#\n# Module manifest for module '${path.replace(/^.*\\/, '').replace(/\.psd1$/i, '')}'\n#\n\n@{\n    RootModule = '${v('rootmodule', '')}'\n    ModuleVersion = '${v('moduleversion', '1.0')}'\n    GUID = '6d3b9b8e-4c1e-4b7a-9d2f-1a2b3c4d5e6f'\n    Author = '${v('author', cx.env.sys.user)}'\n    Description = '${v('description', '')}'\n    PowerShellVersion = '5.1'\n    FunctionsToExport = @(${fns})\n    CmdletsToExport = @()\n    VariablesToExport = '*'\n    AliasesToExport = @()\n}\n`, false);
      return [];
    },
    'test-modulemanifest': (cx) => {
      const path = str(cx.P.path ?? cx.pos[0]);
      const text = readText(cx, path);
      if (!/ModuleVersion\s*=/.test(text)) cx.fail(`The module manifest '${path}' could not be processed because it is not a valid PowerShell module manifest file. Remove the elements that are not permitted.`);
      return [{ __type: 'module', ModuleType: 'Script', Version: /ModuleVersion\s*=\s*'([^']+)'/.exec(text)?.[1] ?? '1.0', Name: path.replace(/^.*\\/, '').replace(/\.psd1$/i, ''), ExportedCommands: '{...}' }];
    },
    'find-module': (cx) => {
      const want = cx.P.name ?? cx.pos[0];
      return Object.entries(GALLERY).filter(([n]) => want === undefined || wildRe(str(want)).test(n)).map(([Name, Version]) => ({ __type: 'module', Version, Name, Repository: 'PSGallery', Description: `${Name} module` }));
    },
    'install-module': (cx) => {
      for (const n of asList(cx.P.name ?? cx.pos[0])) {
        const key = Object.keys(GALLERY).find((g) => g.toLowerCase() === str(n).toLowerCase());
        if (!key) cx.fail(`No match was found for the specified search criteria and module name '${str(n)}'. Try Get-PSRepository to see all available registered module repositories.`);
        const trusted = cx.env.vars.get('__psgallerytrusted') === true;
        if (!trusted && !cx.P.force) {
          cx.print(`\nUntrusted repository\nYou are installing the modules from an untrusted repository. If you trust this repository, change its InstallationPolicy value by running the Set-PSRepository cmdlet. Are you sure you want to install the modules from 'PSGallery'?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "N"):\n(This terminal cannot answer prompts, so nothing was installed. Add -Force, or trust PSGallery with Set-PSRepository -Name PSGallery -InstallationPolicy Trusted.)\n`);
          continue;
        }
        const scope = str(cx.P.scope ?? 'AllUsers').toLowerCase();
        const root = scope === 'currentuser' ? `C:\\Users\\${cx.env.sys.user}\\Documents\\WindowsPowerShell\\Modules` : 'C:\\Program Files\\WindowsPowerShell\\Modules';
        mkdir(cx.env.sys.fs, toVfs(cx.env, `${root}\\${key}\\${GALLERY[key!]}`), ROOT, cx.env.sys.now, true);
        writeFile(cx.env.sys.fs, toVfs(cx.env, `${root}\\${key}\\${GALLERY[key!]}\\${key}.psd1`), `@{ ModuleVersion = '${GALLERY[key!]}' }\n`, ROOT, cx.env.sys.now);
      }
      return [];
    },
    'get-installedmodule': (cx) => Object.keys(GALLERY).filter((m) => moduleInstalled(cx, m)).map((m) => ({ __type: 'module', Version: GALLERY[m], Name: m, Repository: 'PSGallery', Description: `${m} module` })),
    'uninstall-module': (cx) => {
      const name = str(cx.P.name ?? cx.pos[0]);
      for (const root of ['C:\\Program Files\\WindowsPowerShell\\Modules', `C:\\Users\\${cx.env.sys.user}\\Documents\\WindowsPowerShell\\Modules`]) {
        const vfs = toVfs(cx.env, `${root}\\${name}`);
        if (lookup(cx.env.sys.fs, vfs, ROOT)) remove(cx.env.sys.fs, vfs, ROOT, true);
      }
      return [];
    },
    'set-psrepository': (cx) => {
      if (/trusted/i.test(str(cx.P.installationpolicy))) cx.env.vars.set('__psgallerytrusted', /^trusted$/i.test(str(cx.P.installationpolicy)));
      return [];
    },
    'get-psrepository': (cx) => [{ __type: 'select', Name: 'PSGallery', InstallationPolicy: cx.env.vars.get('__psgallerytrusted') === true ? 'Trusted' : 'Untrusted', SourceLocation: 'https://www.powershellgallery.com/api/v2' }],
    'get-executionpolicy': (cx) => {
      const s = policyScopes(cx.env);
      if (cx.P.list) return [['MachinePolicy', 'Undefined'], ['UserPolicy', 'Undefined'], ['Process', s.Process], ['CurrentUser', s.CurrentUser], ['LocalMachine', s.LocalMachine]].map(([Scope, ExecutionPolicy]) => ({ __type: 'select', Scope, ExecutionPolicy }));
      if (cx.P.scope !== undefined) {
        const k = Object.keys(s).find((x) => x.toLowerCase() === str(cx.P.scope).toLowerCase()) as keyof typeof s | undefined;
        return [k ? s[k] : 'Undefined'];
      }
      return [effectivePolicy(cx.env)];
    },
    'set-executionpolicy': (cx) => {
      const policy = str(cx.P.executionpolicy ?? cx.pos[0]);
      const valid = ['Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass', 'Default', 'Undefined'];
      const hit = valid.find((v) => v.toLowerCase() === policy.toLowerCase());
      if (!hit) cx.fail(`Cannot bind parameter 'ExecutionPolicy'. Cannot convert value "${policy}" to type "Microsoft.PowerShell.ExecutionPolicy". Error: "Unable to match the identifier name ${policy} to a valid enumerator name. Specify one of the following enumerator names and try again: ${valid.join(', ')}"`);
      const scope = str(cx.P.scope ?? 'LocalMachine').toLowerCase();
      if (!cx.P.force && scope !== 'process') {
        cx.print(`\nExecution Policy Change\nThe execution policy helps protect you from scripts that you do not trust. Changing the execution policy might expose you to the security risks described in the about_Execution_Policies help topic at https:/go.microsoft.com/fwlink/?LinkID=135170. Do you want to change the execution policy?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "N"):\n(This terminal cannot answer prompts, so the policy was not changed. Add -Force.)\n`);
        return [];
      }
      const value = hit === 'Default' ? 'RemoteSigned' : hit;
      const m = machine(cx.env) as unknown as Obj;
      if (scope === 'process') cx.env.vars.set('__executionpolicy', value);
      else if (scope === 'currentuser') {
        m.userPolicies = { ...((isObj(m.userPolicies) ? m.userPolicies : {}) as Obj), [cx.env.sys.user.toLowerCase()]: value } as Obj;
        cx.env.dirtyEst = true;
      } else if (scope === 'localmachine') {
        m.executionPolicy = value;
        cx.env.dirtyEst = true;
      } else cx.fail(`Cannot set execution policy at scope ${str(cx.P.scope)}: it is set by Group Policy.`);
      const order = ['process', 'currentuser', 'localmachine'];
      const s = policyScopes(cx.env);
      const over = order.slice(0, order.indexOf(scope)).map((k) => (k === 'process' ? s.Process : s.CurrentUser)).find((p) => p !== 'Undefined');
      if (over && over.toLowerCase() !== value!.toLowerCase()) cx.print(`Set-ExecutionPolicy : Windows PowerShell updated your execution policy successfully, but the setting is overridden by a policy defined at a more specific scope.  Due to the override, your shell will retain its current effective execution policy of ${effectivePolicy(cx.env)}. Type "Get-ExecutionPolicy -List" to view your execution policy settings.\n`);
      return [];
    },
    'unblock-file': () => [],
    'set-authenticodesignature': (cx) => {
      const path = str(cx.P.filepath ?? cx.P.literalpath ?? cx.pos[0]);
      const cert = cx.P.certificate;
      if (!isObj(cert) || !/code\s*sign/i.test(str(prop(cert, 'EnhancedKeyUsageList') ?? prop(cert, 'Template') ?? ''))) cx.fail('Cannot sign code. The specified certificate is not suitable for code signing. Use a certificate from Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert.');
      const text = readText(cx, path).replace(/\r?\n# SIG # Begin signature block[\s\S]*$/, '');
      const signed = `${text}${text.endsWith('\n') ? '' : '\r\n'}\r\n# SIG # Begin signature block\r\n# LabHash: ${simpleHash(`${text}${text.endsWith('\n') ? '' : '\r\n'}`)}\r\n# Signer: ${str(prop(cert, 'Subject'))} (${str(prop(cert, 'Thumbprint'))})\r\n# SIG # End signature block\r\n`;
      writeText(cx, path, signed, false);
      return [{ __type: 'select', SignerCertificate: str(prop(cert, 'Thumbprint')), Status: 'Valid', StatusMessage: 'Signature verified.', Path: resolveWin(cx, path).replace(/^.*\\/, '') }];
    },
    'get-authenticodesignature': (cx) => {
      return expandPaths(cx, str(cx.P.filepath ?? cx.P.literalpath ?? cx.pos[0])).map((vfs) => {
        const text = readFile(cx.env.sys.fs, vfs, ROOT);
        const status = signatureStatus(text);
        const signer = /# Signer: .*\(([0-9A-F]+)\)/i.exec(text)?.[1] ?? '';
        return { __type: 'select', SignerCertificate: signer, Status: status, StatusMessage: status === 'Valid' ? 'Signature verified.' : status === 'HashMismatch' ? 'The contents of file ' + toWin(vfs) + ' might have been changed by an unauthorized user or process, because the hash of the file does not match the hash stored in the digital signature.' : 'The file is not digitally signed.', Path: toWin(vfs).replace(/^.*\\/, '') };
      });
    },
    'start-transcript': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0] ?? `C:\\Users\\${cx.env.sys.user}\\Documents\\PowerShell_transcript.${machine(cx.env).name}.txt`);
      const vfs = toVfs(cx.env, path);
      const header = `**********************\r\nWindows PowerShell transcript start\r\nStart time: ${formatDate(cx.env.sys.now, 'yyyyMMddHHmmss')}\r\nUsername: ${cx.env.st.netbios}\\${cx.env.sys.user}\r\nRunAs User: ${cx.env.st.netbios}\\${cx.env.sys.user}\r\nMachine: ${machine(cx.env).name} (Microsoft Windows NT 10.0.20348.0)\r\nHost Application: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n**********************\r\n`;
      writeText(cx, path, header, !!cx.P.append);
      cx.print(`Transcript started, output file is ${toWin(vfs)}\n`);
      cx.env.vars.set('__transcript', vfs);
      return [];
    },
    'stop-transcript': (cx) => {
      const vfs = cx.env.vars.get('__transcript');
      if (typeof vfs !== 'string' || !vfs) cx.fail('An error occurred stopping transcription: The host is not currently transcribing.');
      cx.env.vars.set('__transcript', '');
      const l = lookup(cx.env.sys.fs, vfs as string, ROOT);
      if (l && l.node.type === 'file') l.node.content += `**********************\r\nWindows PowerShell transcript end\r\nEnd time: ${formatDate(cx.env.sys.now, 'yyyyMMddHHmmss')}\r\n**********************\r\n`;
      cx.print(`Transcript stopped, output file is ${toWin(vfs as string)}\n`);
      return [];
    },

    /* ------------------------------------------------------------ paths and files */
    'join-path': (cx) => {
      const parts = [cx.P.path ?? cx.pos[0], cx.P.childpath ?? cx.pos[1], ...asList(cx.P.additionalchildpath), ...cx.pos.slice(2)].filter((x) => x !== undefined).map(str);
      return asList(cx.P.path ?? cx.pos[0]).length > 1 ? asList(cx.P.path ?? cx.pos[0]).map((p) => `${str(p).replace(/\\+$/, '')}\\${parts.slice(1).join('\\')}`) : [parts.map((p, i) => (i === 0 ? p.replace(/\\+$/, '') : p.replace(/^\\+|\\+$/g, ''))).join('\\')];
    },
    'split-path': (cx) => {
      const p = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]).replace(/\//g, '\\');
      const leaf = p.replace(/\\+$/, '').replace(/^.*\\/, '');
      if (cx.P.leaf) return [leaf];
      if (cx.P.leafbase) return [leaf.replace(/\.[^.]*$/, '')];
      if (cx.P.extension) return [/\.[^.]*$/.exec(leaf)?.[0] ?? ''];
      if (cx.P.qualifier) return [/^[A-Za-z]:/.exec(p)?.[0] ?? cx.fail(`Cannot parse path because path '${p}' does not have a qualifier specified.`)];
      if (cx.P.noqualifier) return [p.replace(/^[A-Za-z]:/, '')];
      if (cx.P.isabsolute) return [/^[A-Za-z]:\\|^\\\\/.test(p)];
      return [p.replace(/\\+$/, '').replace(/\\[^\\]*$/, '') || p];
    },
    'resolve-path': (cx) => {
      const p = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const hits = expandPaths(cx, p).filter((v) => !!lookup(cx.env.sys.fs, v, ROOT));
      if (!hits.length) cx.fail(`Cannot find path '${resolveWin(cx, p)}' because it does not exist.`);
      return hits.map((v) => ({ __type: 'pathinfo', Path: toWin(v) }));
    },
    'test-path': (cx) => {
      const p = cx.P.path ?? cx.P.literalpath ?? cx.pos[0];
      return asList(p).map((x) => {
        if (cx.P.isvalid) return !/[<>|"?*]/.test(str(x).replace(/^[A-Za-z]:/, ''));
        const hits = expandPaths(cx, str(x)).map((v) => lookup(cx.env.sys.fs, v, ROOT)).filter(Boolean);
        if (!hits.length) return false;
        const kind = str(cx.P.pathtype ?? 'Any').toLowerCase();
        if (kind === 'leaf') return hits.some((l) => l!.node.type === 'file');
        if (kind === 'container') return hits.some((l) => l!.node.type === 'dir');
        if (cx.P.olderthan !== undefined) return hits.some((l) => l!.node.mtime < msOf(convertTo('datetime', cx.P.olderthan) as Obj));
        if (cx.P.newerthan !== undefined) return hits.some((l) => l!.node.mtime > msOf(convertTo('datetime', cx.P.newerthan) as Obj));
        return true;
      });
    },
    'get-item': (cx) => {
      const p = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0] ?? '.');
      const hits = expandPaths(cx, p).map((v) => ({ v, l: lookup(cx.env.sys.fs, v, ROOT) })).filter((x) => x.l);
      if (!hits.length) cx.fail(`Cannot find path '${resolveWin(cx, p)}' because it does not exist.`);
      return hits.map((x) => itemObject(x.v, x.l!.node));
    },
    'get-childitem': (cx) => {
      const p0 = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0] ?? '.');
      if (/^cert:/i.test(p0)) return oldChildItem(cx);
      const recurse = !!cx.P.recurse;
      const depth = cx.P.depth !== undefined ? num(cx.P.depth) : Infinity;
      const filter = cx.P.filter !== undefined ? wildRe(str(cx.P.filter)) : undefined;
      const include = asList(cx.P.include).map((x) => wildRe(str(x)));
      const exclude = asList(cx.P.exclude).map((x) => wildRe(str(x)));
      const out: Obj[] = [];
      const roots = expandPaths(cx, p0);
      for (const root of roots) {
        const rl = lookup(cx.env.sys.fs, root, ROOT);
        if (!rl) cx.fail(`Cannot find path '${toWin(root)}' because it does not exist.`);
        if (rl!.node.type === 'file') {
          out.push(itemObject(root, rl!.node));
          continue;
        }
        const walk = (dir: string, level: number) => {
          let entries: ReturnType<typeof listDir> = [];
          try {
            entries = listDir(cx.env.sys.fs, dir, ROOT);
          } catch {
            return;
          }
          for (const { name, node } of entries) {
            const full = `${dir === '/' ? '' : dir}/${name}`;
            const isDir = node.type === 'dir';
            const okName = (!filter || filter.test(name)) && (!include.length || include.some((r) => r.test(name))) && !exclude.some((r) => r.test(name));
            const okKind = cx.P.file ? !isDir : cx.P.directory ? isDir : true;
            if (okName && okKind) out.push(itemObject(full, node));
            if (recurse && isDir && level < depth) walk(full, level + 1);
          }
        };
        walk(root, 0);
      }
      if (cx.P.name) return out.map((o) => (recurse ? toWin(String((o.__extra as Obj).FullName)).slice(toWin(roots[0]).length + 1) : o.Name));
      return out;
    },
    'get-content': (cx) => {
      const paths = asList(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const out: Value[] = [];
      for (const p of paths) {
        const hits = expandPaths(cx, str(p));
        if (!hits.length || !hits.some((h) => lookup(cx.env.sys.fs, h, ROOT))) cx.fail(`Cannot find path '${resolveWin(cx, str(p))}' because it does not exist.`);
        for (const h of hits) {
          const l = lookup(cx.env.sys.fs, h, ROOT);
          if (!l || l.node.type !== 'file') continue;
          const text = l.node.content;
          if (cx.P.raw) {
            out.push(text);
            continue;
          }
          let lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
          const first = cx.P.totalcount ?? cx.P.first ?? cx.P.head;
          if (first !== undefined) lines = lines.slice(0, num(first));
          if (cx.P.tail !== undefined || cx.P.last !== undefined) lines = lines.slice(-num(cx.P.tail ?? cx.P.last));
          out.push(...lines);
        }
      }
      return out;
    },
    'set-content': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const vals = cx.P.value !== undefined ? asList(cx.P.value) : cx.pos.length > 1 ? asList(cx.pos[1]) : input(cx);
      writeText(cx, path, vals.map(str).join('\r\n') + (cx.P.nonewline ? '' : '\r\n'), false);
      return [];
    },
    'add-content': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const vals = cx.P.value !== undefined ? asList(cx.P.value) : cx.pos.length > 1 ? asList(cx.pos[1]) : input(cx);
      const vfs = toVfs(cx.env, path);
      let prev = '';
      try {
        prev = readFile(cx.env.sys.fs, vfs, ROOT);
      } catch {
        /* new file */
      }
      const sep = prev && !/\n$/.test(prev) ? '\r\n' : '';
      writeText(cx, path, prev + sep + vals.map(str).join('\r\n') + (cx.P.nonewline ? '' : '\r\n'), false);
      return [];
    },
    'clear-content': (cx) => {
      for (const p of asList(cx.P.path ?? cx.pos[0])) writeText(cx, str(p), '', false);
      return [];
    },
    'get-filehash': (cx) => {
      const alg = str(cx.P.algorithm ?? 'SHA256').toUpperCase();
      const fn = alg === 'MD5' ? md5 : alg === 'SHA1' ? sha1 : alg === 'SHA256' ? sha256 : cx.fail(`Cannot validate argument on parameter 'Algorithm'. The argument "${alg}" does not belong to the set "SHA1,SHA256,SHA384,SHA512,MD5" specified by the ValidateSet attribute.`);
      const paths = asList(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]).flatMap((p) => expandPaths(cx, str(p)));
      if (!paths.length) cx.fail(`Cannot find path because it does not exist.`);
      return paths.map((vfs) => {
        let text: string;
        try {
          text = readFile(cx.env.sys.fs, vfs, ROOT);
        } catch {
          return cx.fail(`Cannot find path '${toWin(vfs)}' because it does not exist.`);
        }
        return { __type: 'select', Algorithm: alg, Hash: fn(text).toUpperCase(), Path: toWin(vfs) };
      });
    },
  },
  {
    'foreach-object': 'ForEach-Object { <script using $_> }   or   ForEach-Object -MemberName <property>',
    'where-object': "Where-Object { $_.Property -eq 'value' }   or   Where-Object Property -eq 'value'",
    'select-object': 'Select-Object [-Property] <names | @{Name=..; Expression={..}}> [-First n] [-Last n] [-Skip n] [-Unique] [-ExpandProperty <name>]',
    'sort-object': 'Sort-Object [-Property] <names | @{Expression={..}; Descending=$true}> [-Descending] [-Unique]',
    'group-object': 'Group-Object [-Property] <names> [-NoElement] [-AsHashTable]',
    'measure-object': 'Measure-Object [-Property <name>] [-Sum] [-Average] [-Maximum] [-Minimum]   or   -Line -Word -Character',
    'convertto-json': 'ConvertTo-Json [-Depth n] [-Compress]',
    'export-csv': 'Export-Csv -Path <file> -NoTypeInformation [-Append] [-Delimiter ;]',
    'get-date': "Get-Date [-Date <datetime>] [-Format 'yyyy-MM-dd'] [-UFormat '%Y-%m-%d']",
    'write-error': 'Write-Error -Message <text> [-Category <category>] [-ErrorId <id>]',
    'set-executionpolicy': 'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned|AllSigned|Restricted|Bypass [-Scope Process|CurrentUser|LocalMachine] -Force',
    'start-transcript': 'Start-Transcript -Path <file> [-Append]   ...   Stop-Transcript',
  },
  { '%': 'foreach-object', foreach: 'foreach-object', '?': 'where-object', where: 'where-object', select: 'select-object', sort: 'sort-object', group: 'group-object', measure: 'measure-object', compare: 'compare-object', diff: 'compare-object', tee: 'tee-object', gm: 'get-member', ft: 'format-table', fl: 'format-list', fw: 'format-wide', echo: 'write-output', write: 'write-output', gv: 'get-variable', sv: 'set-variable', iex: 'invoke-expression', gcm: 'get-command', gal: 'get-alias', gi: 'get-item', gc: 'get-content', cat: 'get-content', type: 'get-content', sc: 'set-content', ac: 'add-content', dir: 'get-childitem', ls: 'get-childitem', gci: 'get-childitem', ipmo: 'import-module', gmo: 'get-module', rvpa: 'resolve-path', sleep: 'start-sleep', h: 'get-history', man: 'get-help', help: 'get-help' },
);

function binaryOpSafe(cx: Cx, op: string, l: Value, r: Value): Value {
  return binaryOp(cx.env, op, l, r);
}

function invokeStatic(cx: Cx, type: string, method: string): Value {
  return runBlock(cx.env, { __type: 'block', src: `[${type}]::${method}()` }, { newScope: false })[0];
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Get-Date -UFormat (Unix-style %Y %m %d %H %M %S %A %B %j %s). */
function uformat(ms: number, f: string): string {
  return f.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
    const map: Record<string, string> = { Y: 'yyyy', y: 'yy', m: 'MM', d: 'dd', H: 'HH', M: 'mm', S: 'ss', A: 'dddd', a: 'ddd', B: 'MMMM', b: 'MMM', I: 'hh', p: 'tt', Z: 'K', e: 'd' };
    if (c === '%') return '%';
    if (c === 'j') return String(Math.floor((ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / 86400000) + 1).padStart(3, '0');
    if (c === 's') return String(Math.floor(ms / 1000));
    if (c === 'F') return formatDate(ms, 'yyyy-MM-dd');
    if (c === 'T') return formatDate(ms, 'HH:mm:ss');
    if (c === 'D') return formatDate(ms, 'MM/dd/yy');
    if (c === 'u') return String(new Date(ms).getUTCDay() || 7);
    if (c === 'V') {
      const d = new Date(ms);
      const day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day + 3);
      const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      return String(1 + Math.round(((d.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7)).padStart(2, '0');
    }
    return map[c] ? formatDate(ms, map[c]) : '%' + c;
  });
}

/** Members Get-Member lists for a value. */
function membersOf(v: Value): Array<{ Name: string; MemberType: string; Definition: string }> {
  const m = (Name: string, MemberType: string, Definition: string) => ({ Name, MemberType, Definition });
  const common = [m('Equals', 'Method', 'bool Equals(System.Object obj)'), m('GetHashCode', 'Method', 'int GetHashCode()'), m('GetType', 'Method', 'type GetType()'), m('ToString', 'Method', 'string ToString()')];
  if (typeof v === 'string') return [m('Contains', 'Method', 'bool Contains(string value)'), m('EndsWith', 'Method', 'bool EndsWith(string value)'), ...common.slice(0, 2), m('IndexOf', 'Method', 'int IndexOf(string value)'), m('Insert', 'Method', 'string Insert(int startIndex, string value)'), m('PadLeft', 'Method', 'string PadLeft(int totalWidth)'), m('PadRight', 'Method', 'string PadRight(int totalWidth)'), m('Remove', 'Method', 'string Remove(int startIndex)'), m('Replace', 'Method', 'string Replace(string oldValue, string newValue)'), m('Split', 'Method', 'string[] Split(char[] separator)'), m('StartsWith', 'Method', 'bool StartsWith(string value)'), m('Substring', 'Method', 'string Substring(int startIndex)'), m('ToLower', 'Method', 'string ToLower()'), common[3], m('ToUpper', 'Method', 'string ToUpper()'), m('Trim', 'Method', 'string Trim()'), m('TrimEnd', 'Method', 'string TrimEnd()'), m('TrimStart', 'Method', 'string TrimStart()'), m('Chars', 'ParameterizedProperty', 'char Chars(int index) {get;}'), m('Length', 'Property', 'int Length {get;}')];
  if (typeof v === 'number') return [m('CompareTo', 'Method', 'int CompareTo(System.Object value)'), ...common];
  if (isDate(v)) return [m('AddDays', 'Method', 'datetime AddDays(double value)'), m('AddHours', 'Method', 'datetime AddHours(double value)'), m('AddMinutes', 'Method', 'datetime AddMinutes(double value)'), m('AddMonths', 'Method', 'datetime AddMonths(int months)'), m('AddYears', 'Method', 'datetime AddYears(int value)'), ...common, m('ToShortDateString', 'Method', 'string ToShortDateString()'), m('Date', 'Property', 'datetime Date {get;}'), m('Day', 'Property', 'int Day {get;}'), m('DayOfWeek', 'Property', 'System.DayOfWeek DayOfWeek {get;}'), m('Hour', 'Property', 'int Hour {get;}'), m('Month', 'Property', 'int Month {get;}'), m('Year', 'Property', 'int Year {get;}')];
  if (isHash(v)) return [m('Add', 'Method', 'void Add(System.Object key, System.Object value)'), m('Clear', 'Method', 'void Clear()'), m('ContainsKey', 'Method', 'bool ContainsKey(System.Object key)'), m('ContainsValue', 'Method', 'bool ContainsValue(System.Object value)'), ...common.slice(0, 2), m('GetEnumerator', 'Method', 'System.Collections.IDictionaryEnumerator GetEnumerator()'), common[2], m('Remove', 'Method', 'void Remove(System.Object key)'), common[3], m('Count', 'Property', 'int Count {get;}'), m('Keys', 'Property', 'System.Collections.ICollection Keys {get;}'), m('Values', 'Property', 'System.Collections.ICollection Values {get;}')];
  if (isArr(v)) return [m('Count', 'Property', 'int Count {get;}'), m('Length', 'Property', 'int Length {get;}')];
  if (isObj(v)) {
    const o = v as Obj;
    const note = ['psobject', 'csv', 'select'].includes(String(o.__type));
    const props = allProps(o).map(([k, x]) => m(k, note ? 'NoteProperty' : 'Property', `${typeNameOf(x).replace(/^System\./, '')} ${k}${note ? '=' + str(x).slice(0, 40) : ' {get;set;}'}`));
    const methods = o.__type === 'service' ? [m('Start', 'Method', 'void Start()'), m('Stop', 'Method', 'void Stop()'), m('Refresh', 'Method', 'void Refresh()')] : o.__type === 'file' ? [m('CopyTo', 'Method', 'System.IO.FileInfo CopyTo(string destFileName)'), m('Delete', 'Method', 'void Delete()'), m('MoveTo', 'Method', 'void MoveTo(string destFileName)')] : [];
    return [...methods, ...common, ...props].sort((a, b) => (a.MemberType === b.MemberType ? a.Name.localeCompare(b.Name) : a.MemberType === 'Method' ? -1 : 1));
  }
  return common;
}


canonical(['Write-Output', 'Write-Host', 'Write-Verbose', 'Write-Debug', 'Write-Warning', 'Write-Information', 'Write-Progress', 'Write-Error', 'Read-Host', 'Out-Null', 'Out-Host', 'Out-Default', 'Out-String', 'Out-File', 'Tee-Object', 'ForEach-Object', 'Where-Object', 'Select-Object', 'Sort-Object', 'Group-Object', 'Measure-Object', 'Compare-Object', 'Get-Unique', 'Get-Member', 'Format-Table', 'Format-List', 'Format-Wide', 'ConvertTo-Json', 'ConvertFrom-Json', 'ConvertTo-Csv', 'ConvertFrom-Csv', 'Export-Csv', 'Import-Csv', 'ConvertTo-Html', 'New-Object', 'Add-Member', 'Get-Variable', 'Set-Variable', 'New-Variable', 'Remove-Variable', 'Clear-Variable', 'Get-Date', 'New-TimeSpan', 'Start-Sleep', 'Measure-Command', 'Get-Random', 'New-Guid', 'Invoke-Expression', 'Get-Command', 'Get-Alias', 'Set-Alias', 'New-Alias', 'Get-Verb', 'Get-Help', 'Import-Module', 'Get-Module', 'Remove-Module', 'Export-ModuleMember', 'New-ModuleManifest', 'Test-ModuleManifest', 'Find-Module', 'Install-Module', 'Get-InstalledModule', 'Uninstall-Module', 'Set-PSRepository', 'Get-PSRepository', 'Get-ExecutionPolicy', 'Set-ExecutionPolicy', 'Unblock-File', 'Set-AuthenticodeSignature', 'Get-AuthenticodeSignature', 'Start-Transcript', 'Stop-Transcript', 'Join-Path', 'Split-Path', 'Resolve-Path', 'Test-Path', 'Get-Item', 'Get-ChildItem', 'Get-Content', 'Set-Content', 'Add-Content', 'Clear-Content', 'Get-FileHash']);
