/**
 * Tool cmdlets for automation labs on Windows: Pester tests and mocks, PSScriptAnalyzer,
 * Invoke-RestMethod/Invoke-WebRequest against the lab API, CIM queries, certificates, the Task
 * Scheduler (tasks really run their scripts), event logs, robocopy, winget and Chocolatey,
 * SecureString/CLIXML and SecretManagement, archives and mail.
 */

import { listDir, lookup, mkdir, readFile, writeFile } from '../fs.js';
import { ALIASES, CMDLET_TABLE, PsError, SECURE, canonical, asList, isObj, isSecure, machine, prop, register, registerNative, render, toVfs, toWin, type Cx, type Obj, type Value } from './core.js';
import { errorRecord, formatDate, getVariable, hostWrite, isBlock, isDate, isHash, makeDate, msOf, num, parseDateText, reportError, runBlock, runScriptText, RuntimeErr, setVariable, str, truthy, withScope } from './lang.js';
import { Parser, parseScript, type Block, type Elem, type Expr, type Stmt } from './parse.js';
import { APPROVED, moduleInstalled, orderOf } from './cmd-lang.js';
import { apiAt, handleApi } from '../labapi.js';
import { sha1, toBase64 } from '../hash.js';
import type { Machine } from './model.js';

const ROOT = { user: 'root', groups: ['root'] };
const isArr = Array.isArray;

function fail(cx: Cx, msg: string, type: string, terminating = true): never {
  throw new PsError(cx.call.name, msg, type, terminating);
}

function needModule(cx: Cx, mod: string): void {
  if (!moduleInstalled(cx, mod)) fail(cx, `The term '${cx.call.name}' is not recognized as the name of a cmdlet, function, script file, or operable program. (It comes from the ${mod} module: Install-Module ${mod}.)`, 'CommandNotFoundException');
}

/* ----------------------------------------------------------------------------- Pester */

interface PesterResult {
  path: string[];
  name: string;
  ok: boolean;
  skipped: boolean;
  message?: string;
  at?: string;
  file: string;
}
interface Frame {
  name: string;
  kind: 'Describe' | 'Context';
  beforeEach: Obj[];
  afterEach: Obj[];
  afterAll: Obj[];
  mocks: string[];
}
interface PesterRun {
  results: PesterResult[];
  frames: Frame[];
  file: string;
  direct: boolean;
  lines: string[];
  output: string;
}

const RUNS = new WeakMap<object, PesterRun>();

function pester(cx: Cx, create = true): PesterRun | undefined {
  let run = RUNS.get(cx.env.vars);
  if (!run && create) {
    run = { results: [], frames: [], file: cx.env.scriptPath ?? '', direct: true, lines: [], output: 'Normal' };
    RUNS.set(cx.env.vars, run);
  }
  return run;
}

function mocks(cx: Cx): Map<string, Obj> {
  if (!cx.env.mocks) cx.env.mocks = new Map();
  return cx.env.mocks;
}

function testLine(cx: Cx, run: PesterRun): string {
  const line = cx.env.line ?? 0;
  const text = run.file ? (fileLines(cx, run.file)[line - 1] ?? '').trim() : '';
  return `at ${text}, ${run.file}:${line}`;
}

function fileLines(cx: Cx, winPath: string): string[] {
  try {
    return readFile(cx.env.sys.fs, toVfs(cx.env, winPath), ROOT).split(/\r?\n/);
  } catch {
    return [];
  }
}

function describe(cx: Cx, kind: 'Describe' | 'Context'): Value[] {
  const name = str(cx.P.name ?? cx.pos[0]);
  const body = cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : (cx.P.fixture ?? cx.pos.find(isBlock)) as Obj;
  const run = pester(cx)!;
  const frame: Frame = { name, kind, beforeEach: [], afterEach: [], afterAll: [], mocks: [] };
  run.frames.push(frame);
  if (run.output === 'Detailed') run.lines.push(`${'  '.repeat(run.frames.length - 1)}${kind === 'Describe' ? 'Describing' : 'Context'} ${name}`);
  cx.env.tryDepth = (cx.env.tryDepth ?? 0) + 1;
  try {
    runBlock(cx.env, body, { newScope: true });
  } catch (e) {
    if (!(e instanceof RuntimeErr)) throw e;
    run.results.push({ path: run.frames.map((f) => f.name), name: `${kind} block failed`, ok: false, skipped: false, message: String((e.record.Exception as Obj).Message), at: testLine(cx, run), file: run.file });
  } finally {
    cx.env.tryDepth--;
    for (const h of frame.afterAll) runBlock(cx.env, h, { newScope: false });
    for (const m of frame.mocks) mocks(cx).delete(m);
    run.frames.pop();
  }
  if (run.direct && !run.frames.length) {
    const text = summary(run, true);
    RUNS.delete(cx.env.vars);
    cx.print(text);
  }
  return [];
}

function it(cx: Cx): Value[] {
  const run = pester(cx)!;
  const name = str(cx.P.name ?? cx.pos[0]);
  const body = (cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : (cx.P.test ?? cx.pos.find(isBlock))) as Obj | undefined;
  const cases = cx.P.testcases !== undefined ? asList(cx.P.testcases) : cx.P.foreach !== undefined ? asList(cx.P.foreach) : [null];
  for (const c of cases) {
    const vars = isHash(c) ? Object.fromEntries(Object.entries(c as Obj).filter(([k]) => !k.startsWith('__'))) : c !== null ? { _: c } : {};
    const title = name.replace(/<(\w+)>/g, (m, k: string) => (k in vars ? str(vars[k]) : m));
    const path = run.frames.map((f) => f.name);
    if (cx.P.skip || !body) {
      run.results.push({ path, name: title, ok: true, skipped: true, file: run.file });
      if (run.output === 'Detailed') run.lines.push(`${'  '.repeat(run.frames.length)}[!] ${title} is skipped`);
      continue;
    }
    const before = mocks(cx);
    const mockNames = [...before.keys()];
    let failure: { message: string; at: string } | undefined;
    cx.env.tryDepth = (cx.env.tryDepth ?? 0) + 1;
    try {
      withScope(cx.env, 'block', () => {
        for (const [k, v] of Object.entries(vars)) setVariable(cx.env, k, v);
        for (const f of run.frames) for (const h of f.beforeEach) runBlock(cx.env, h, { newScope: false });
        try {
          runBlock(cx.env, body, { newScope: false });
        } finally {
          for (const f of [...run.frames].reverse()) for (const h of f.afterEach) runBlock(cx.env, h, { newScope: false });
        }
      });
    } catch (e) {
      if (!(e instanceof RuntimeErr)) throw e;
      failure = { message: String((e.record.Exception as Obj).Message), at: testLine(cx, run) };
    } finally {
      cx.env.tryDepth--;
      // Mocks defined inside the It block end with it.
      for (const k of [...mocks(cx).keys()]) if (!mockNames.includes(k)) mocks(cx).delete(k);
    }
    run.results.push({ path, name: title, ok: !failure, skipped: false, message: failure?.message, at: failure?.at, file: run.file });
    const ms = 3 + (title.length % 9);
    if (run.output === 'Detailed' || failure) {
      const indent = run.output === 'Detailed' ? '  '.repeat(run.frames.length) : '';
      run.lines.push(`${indent}[${failure ? '-' : '+'}] ${run.output === 'Detailed' ? title : [...path, title].join('.')} ${ms}ms (${ms - 2}ms|2ms)`);
      if (failure) run.lines.push(`${indent} ${failure.message}`, `${indent} ${failure.at}`);
    }
  }
  return [];
}

function summary(run: PesterRun, direct: boolean): string {
  const passed = run.results.filter((r) => r.ok && !r.skipped).length;
  const failed = run.results.filter((r) => !r.ok).length;
  const skipped = run.results.filter((r) => r.skipped).length;
  const head = direct ? [] : [];
  return [...head, ...run.lines, `Tests completed in ${40 + run.results.length * 7}ms`, `Tests Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped} NotRun: 0`, ''].join('\n');
}

function shouldFail(_cx: Cx, msg: string): never {
  throw new PsError('Should', msg, 'PesterAssertionFailedException', true);
}

const fmtV = (v: Value): string => (v === null || v === undefined ? '$null' : typeof v === 'string' ? `'${v}'` : typeof v === 'boolean' ? (v ? '$true' : '$false') : isArr(v) ? `@(${v.map(fmtV).join(', ')})` : str(v));

function should(cx: Cx): Value[] {
  const P = cx.P;
  // Legacy syntax: Should Be 5, Should Not Be 5
  const legacy = cx.pos.map(str);
  let not = !!P.not;
  let op = Object.keys(P).find((k) => !['not', 'because', 'actualvalue', 'times', 'exactly', 'parameterfilter', 'expectedmessage', 'erroraction', 'scope', 'commandname', 'exceptiontype', 'errorid', 'expectedtype'].includes(k));
  let expected: Value = op ? P[op] : undefined;
  if (!op && legacy.length) {
    let i = 0;
    if (legacy[0].toLowerCase() === 'not') {
      not = true;
      i = 1;
    }
    op = legacy[i]?.toLowerCase();
    expected = cx.pos[i + 1];
  }
  if (!op) shouldFail(cx, 'Should needs an assertion such as -Be, -BeTrue, -Match or -Throw.');
  op = op!.toLowerCase();
  const actualList = P.actualvalue !== undefined ? asList(P.actualvalue) : cx.input ?? [];
  const actual: Value = actualList.length === 1 ? actualList[0] : actualList.length === 0 ? null : actualList;
  const because = P.because !== undefined ? `, because ${str(P.because)}` : '';
  const check = (ok: boolean, msg: string, notMsg: string) => {
    if (ok === not) shouldFail(cx, not ? notMsg : msg);
  };
  const eq = (a: Value, b: Value, cs: boolean) => (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : cs ? str(a) === str(b) : str(a).toLowerCase() === str(b).toLowerCase());
  switch (op) {
    case 'be':
    case 'beexactly': {
      const ok = isArr(actual) && isArr(expected) ? actual.length === expected.length && actual.every((x, i) => eq(x, (expected as Value[])[i], op === 'beexactly')) : actual === null || expected === null ? actual === expected || (actual === null && expected === undefined) : eq(actual, expected, op === 'beexactly');
      check(ok, typeof expected === 'string' && typeof actual === 'string' ? `Expected strings to be the same${because}, but they were different.\nExpected: ${fmtV(expected)}\nBut was:  ${fmtV(actual)}` : `Expected ${fmtV(expected)}${because}, but got ${fmtV(actual)}.`, `Expected ${fmtV(expected)} to be different from the actual value${because}, but got the same value.`);
      break;
    }
    case 'betrue':
      check(actual === true, `Expected $true${because}, but got ${fmtV(actual)}.`, `Expected not $true${because}, but got $true.`);
      break;
    case 'befalse':
      check(actual === false, `Expected $false${because}, but got ${fmtV(actual)}.`, `Expected not $false${because}, but got $false.`);
      break;
    case 'benullorempty':
      check(actual === null || actual === undefined || actual === '' || (isArr(actual) && actual.length === 0), `Expected $null or empty${because}, but got ${fmtV(actual)}.`, `Expected a value${because}, but got $null or empty.`);
      break;
    case 'begreaterthan':
    case 'belessthan':
    case 'begreaterorequal':
    case 'belessorequal': {
      const c = orderOf(actual, expected);
      const ok = op === 'begreaterthan' ? c > 0 : op === 'belessthan' ? c < 0 : op === 'begreaterorequal' ? c >= 0 : c <= 0;
      const word = { begreaterthan: 'greater than', belessthan: 'less than', begreaterorequal: 'greater than or equal to', belessorequal: 'less than or equal to' }[op];
      check(ok, `Expected the actual value to be ${word} ${fmtV(expected)}${because}, but got ${fmtV(actual)}.`, `Expected the actual value to not be ${word} ${fmtV(expected)}${because}, but got ${fmtV(actual)}.`);
      break;
    }
    case 'match':
    case 'matchexactly':
      check(new RegExp(str(expected), op === 'match' ? 'i' : '').test(str(actual)), `Expected regular expression ${fmtV(expected)} to match ${fmtV(actual)}${because}, but it did not match.`, `Expected regular expression ${fmtV(expected)} to not match ${fmtV(actual)}${because}, but it did match.`);
      break;
    case 'belike':
    case 'belikeexactly': {
      const re = new RegExp('^' + str(expected).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', op === 'belike' ? 'i' : '');
      check(re.test(str(actual)), `Expected like wildcard ${fmtV(expected)} to match ${fmtV(actual)}${because}, but it did not match.`, `Expected like wildcard ${fmtV(expected)} to not match ${fmtV(actual)}${because}, but it did match.`);
      break;
    }
    case 'contain':
      check(actualList.some((x) => eq(x, expected, false)), `Expected ${fmtV(expected)} to be found in collection ${fmtV(actualList)}${because}, but it was not found.`, `Expected ${fmtV(expected)} to not be found in collection ${fmtV(actualList)}${because}, but it was found.`);
      break;
    case 'bein':
      check(asList(expected).some((x) => eq(x, actual, false)), `Expected collection ${fmtV(expected)} to contain ${fmtV(actual)}${because}, but it was not found.`, `Expected collection ${fmtV(expected)} to not contain ${fmtV(actual)}${because}, but it was found.`);
      break;
    case 'havecount':
      check(actualList.length === num(expected), `Expected a collection with size ${str(expected)}${because}, but got collection with size ${actualList.length} ${fmtV(actualList)}.`, `Expected a collection with size different from ${str(expected)}${because}, but got collection with that size ${fmtV(actualList)}.`);
      break;
    case 'beoftype': {
      const t = isObj(expected) ? str(prop(expected, 'FullName')) : str(expected);
      const ok = truthy(runBlock(cx.env, { __type: 'block', src: `$args[0] -is [${t.replace(/^\[|\]$/g, '')}]` }, { args: [actual], newScope: true })[0]);
      check(ok, `Expected the value to have type [${t}] or any of its subtypes${because}, but got ${fmtV(actual)}.`, `Expected the value to not have type [${t}]${because}, but it did.`);
      break;
    }
    case 'exist': {
      const ok = !!lookup(cx.env.sys.fs, toVfs(cx.env, str(actual)), ROOT);
      check(ok, `Expected path ${fmtV(actual)} to exist${because}, but it did not exist.`, `Expected path ${fmtV(actual)} to not exist${because}, but it did exist.`);
      break;
    }
    case 'filecontentmatch':
    case 'filecontentmatchexactly': {
      let text = '';
      try {
        text = readFile(cx.env.sys.fs, toVfs(cx.env, str(actual)), ROOT);
      } catch {
        /* missing */
      }
      check(new RegExp(str(expected), op === 'filecontentmatch' ? 'i' : '').test(text), `Expected ${fmtV(expected)} to be found in file '${str(actual)}'${because}, but it was not found.`, `Expected ${fmtV(expected)} to not be found in file '${str(actual)}'${because}, but it was found.`);
      break;
    }
    case 'throw': {
      const block = isBlock(actual) ? actual : undefined;
      if (!block) shouldFail(cx, 'Should -Throw needs a script block: { code } | Should -Throw');
      let thrown: string | undefined;
      cx.env.tryDepth = (cx.env.tryDepth ?? 0) + 1;
      const savedEa = getVariable(cx.env, 'ErrorActionPreference');
      try {
        runBlock(cx.env, block, { newScope: true });
      } catch (e) {
        if (e instanceof RuntimeErr) thrown = String((e.record.Exception as Obj).Message);
        else if (e instanceof PsError) thrown = e.message;
        else throw e;
      } finally {
        cx.env.tryDepth--;
        setVariable(cx.env, 'ErrorActionPreference', savedEa);
      }
      const want = P.expectedmessage ?? (op === 'throw' && P.throw !== true ? P.throw : undefined) ?? (legacy.length > 1 ? cx.pos[legacy[0].toLowerCase() === 'not' ? 2 : 1] : undefined);
      if (not) {
        if (thrown !== undefined) shouldFail(cx, `Expected no exception to be thrown${because}, but an exception "${thrown}" was thrown.`);
        break;
      }
      if (thrown === undefined) shouldFail(cx, `Expected an exception${want !== undefined ? ` with message like ${fmtV(want)}` : ''} to be thrown${because}, but no exception was thrown.`);
      if (want !== undefined && want !== true) {
        const re = new RegExp('^' + str(want).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        if (!re.test(thrown!)) shouldFail(cx, `Expected an exception with message like ${fmtV(want)} to be thrown${because}, but the message was '${thrown}'.`);
      }
      break;
    }
    case 'invoke':
    case 'invokeverifiable': {
      const name = str(P.commandname ?? expected ?? cx.pos[0]);
      const m = mocks(cx).get(name.toLowerCase()) ?? mocks(cx).get(ALIASES[name.toLowerCase()] ?? '');
      if (!m) shouldFail(cx, `Should -Invoke: there is no mock for ${name}. Use Mock ${name} { } first.`);
      const filter = P.parameterfilter as Obj | undefined;
      const calls = (m!.calls as Obj[]).filter((c) => !filter || truthy(runBlock(cx.env, filter, { vars: Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('__'))), newScope: true })[0]));
      const times = P.times !== undefined ? num(P.times) : 1;
      const ok = P.exactly ? calls.length === times : calls.length >= times;
      check(ok, `Expected ${name} to be called ${P.exactly ? '' : 'at least '}${times} times${because}, but was called ${calls.length} times`, `Expected ${name} not to be called${because}, but it was called ${calls.length} times`);
      break;
    }
    default:
      shouldFail(cx, `Unknown Should operator -${op}.`);
  }
  return [];
}

function mockCmd(cx: Cx): Value[] {
  const name = str(cx.P.commandname ?? cx.pos[0]);
  const body = (cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : cx.P.mockwith ?? cx.pos.find(isBlock) ?? { __type: 'block', src: '' }) as Obj;
  const key = name.toLowerCase();
  const prev = mocks(cx).get(key);
  mocks(cx).set(key, { name, body, filter: cx.P.parameterfilter, calls: prev ? prev.calls : [] });
  const run = pester(cx, false);
  run?.frames[run.frames.length - 1]?.mocks.push(key);
  return [];
}

/* ----------------------------------------------------------------------------- PSScriptAnalyzer */

interface Finding {
  RuleName: string;
  Severity: 'Error' | 'Warning' | 'Information';
  Line: number;
  Message: string;
}

const PLURAL_OK = /(ss|us|is|data|status|news|settings|series|alias|address|access)$/i;

function analyze(src: string, file: string, aliases: Record<string, string>): Finding[] {
  let ast: Block;
  try {
    ast = parseScript(src);
  } catch (e) {
    return [{ RuleName: 'ParseError', Severity: 'Error', Line: (e as { line?: number }).line ?? 1, Message: (e as Error).message }];
  }
  const out: Finding[] = [];
  const assigned = new Map<string, number>();
  const used = new Set<string>();
  const add = (RuleName: string, Severity: Finding['Severity'], Line: number, Message: string) => out.push({ RuleName, Severity, Line, Message });
  const lineOfText = (needle: RegExp) => {
    const lines = src.split('\n');
    const i = lines.findIndex((l) => needle.test(l));
    return i >= 0 ? i + 1 : 1;
  };
  const visitExpr = (e: Expr | undefined, line: number): void => {
    if (!e) return;
    switch (e.t) {
      case 'var':
        used.add(e.name.toLowerCase());
        if (e.scope === 'global') add('PSAvoidGlobalVars', 'Warning', line, `Found global variable '$global:${e.name}'.`);
        return;
      case 'xstr':
        e.parts.forEach((p) => typeof p !== 'string' && visitExpr(p, line));
        return;
      case 'member':
        visitExpr(e.obj, line);
        if (typeof e.name !== 'string') visitExpr(e.name, line);
        return;
      case 'invoke':
        visitExpr(e.obj, line);
        e.args.forEach((a) => visitExpr(a, line));
        return;
      case 'index':
        visitExpr(e.obj, line);
        visitExpr(e.index, line);
        return;
      case 'array':
        e.items.forEach((x) => visitExpr(x, line));
        return;
      case 'sub':
        visitStmts(e.body);
        return;
      case 'paren':
        visitStmt(e.body);
        return;
      case 'hash':
        e.entries.forEach((x) => {
          visitExpr(x.key, line);
          visitStmt(x.value);
        });
        return;
      case 'block':
        try {
          const b = parseScript(e.src, e.line);
          visitBlock(b);
        } catch {
          /* reported by the outer parse */
        }
        return;
      case 'unary':
      case 'cast':
        visitExpr(e.e, line);
        return;
      case 'incdec':
        visitExpr(e.e, line);
        return;
      case 'bin':
        if ((e.op === 'eq' || e.op === 'ne') && e.r.t === 'var' && e.r.name.toLowerCase() === 'null') add('PSPossibleIncorrectComparisonWithNull', 'Warning', line, '$null should be on the left side of equality comparisons.');
        visitExpr(e.l, line);
        visitExpr(e.r, line);
        return;
    }
  };
  const visitElem = (el: Elem, line: number) => {
    if (el.t === 'expr') {
      visitExpr(el.e, line);
      return;
    }
    visitExpr(el.name, line);
    const name = el.name.t === 'str' ? el.name.v : '';
    const lower = name.toLowerCase();
    if (aliases[lower] && !/\.exe$/i.test(name)) add('PSAvoidUsingCmdletAliases', 'Warning', line, `'${name}' is an alias of '${displayName(aliases[lower])}'. Alias can introduce possible problems and make scripts hard to maintain. Please consider changing alias to its full content.`);
    if (lower === 'write-host') add('PSAvoidUsingWriteHost', 'Warning', line, `File '${file}' uses Write-Host. Avoid using Write-Host because it might not work in all hosts, does not work when there is no host, and (prior to PS 5.0) cannot be suppressed, captured, or redirected. Instead, use Write-Output, Write-Verbose, or Write-Information.`);
    if (lower === 'invoke-expression' || lower === 'iex') add('PSAvoidUsingInvokeExpression', 'Warning', line, 'Invoke-Expression is used. Please remove Invoke-Expression from script and find other options instead.');
    if (lower === 'convertto-securestring' && el.args.some((a) => a.t === 'param' && /^asplaintext$/i.test(a.name))) add('PSAvoidUsingConvertToSecureStringWithPlainText', 'Error', line, `File '${file}' uses ConvertTo-SecureString with plaintext. This will expose secure information. Encrypted standard strings should be used instead.`);
    const positional = el.args.filter((a) => a.t === 'arg').length;
    if (positional >= 3 && /-/.test(name)) add('PSAvoidUsingPositionalParameters', 'Information', line, `Cmdlet '${name}' has positional parameter. Please use named parameters instead of positional parameters when calling a command.`);
    for (const a of el.args) {
      if (a.t === 'param' && a.value) visitExpr(a.value, line);
      if (a.t === 'arg') visitExpr(a.e, line);
      if (a.t === 'splat') used.add(a.name.toLowerCase());
    }
  };
  const visitStmt = (s: Stmt): void => {
    switch (s.t) {
      case 'pipe':
        s.elems.forEach((el) => visitElem(el, s.line));
        return;
      case 'assign': {
        const t = s.target.t === 'var' ? s.target : s.target.t === 'cast' && s.target.e.t === 'var' ? s.target.e : undefined;
        if (t && s.op === '=') {
          if (!assigned.has(t.name.toLowerCase())) assigned.set(t.name.toLowerCase(), s.line);
          if (/^(_|psitem|input|args|matches|error|this|true|false)$/i.test(t.name)) add('PSAvoidAssignmentToAutomaticVariable', 'Warning', s.line, `The Variable '${t.name}' is an automatic variable that is built into PowerShell, assigning to it might have undesired side effects. If assignment is not by design, please use a different name.`);
          if (t.scope === 'global') add('PSAvoidGlobalVars', 'Warning', s.line, `Found global variable '$global:${t.name}'.`);
        } else visitExpr(s.target, s.line);
        if (s.op !== '=' && t) used.add(t.name.toLowerCase());
        visitStmt(s.value);
        return;
      }
      case 'if':
        s.clauses.forEach((c) => {
          visitStmt(c.cond);
          visitStmts(c.body);
        });
        if (s.else) visitStmts(s.else);
        return;
      case 'foreach':
        assigned.set(s.v.toLowerCase(), -1);
        used.add(s.v.toLowerCase());
        visitStmt(s.src);
        visitStmts(s.body);
        return;
      case 'for':
        [s.init, s.cond, s.step].forEach((x) => x && visitStmt(x));
        visitStmts(s.body);
        return;
      case 'while':
      case 'do':
        visitStmt(s.cond);
        visitStmts(s.body);
        return;
      case 'switch':
        if (s.subject) visitStmt(s.subject);
        s.clauses.forEach((c) => {
          if (c.pat) visitExpr(c.pat, s.line);
          visitStmts(c.body);
        });
        return;
      case 'try':
        visitStmts(s.body);
        s.catches.forEach((c) => {
          if (!c.body.length) add('PSAvoidUsingEmptyCatchBlock', 'Warning', s.line, 'Empty catch block is used. Please use Write-Error or throw statements in catch blocks.');
          visitStmts(c.body);
        });
        if (s.fin) visitStmts(s.fin);
        return;
      case 'throw':
      case 'return':
      case 'exit':
        if (s.value) visitStmt(s.value);
        return;
      case 'func': {
        const [verb, ...nounParts] = s.name.split('-');
        const noun = nounParts.join('-');
        const line = s.line;
        if (noun && !APPROVED.has(verb.toLowerCase())) add('PSUseApprovedVerbs', 'Warning', line, `The cmdlet '${s.name}' uses an unapproved verb.`);
        if (noun && /s$/i.test(noun) && !PLURAL_OK.test(noun)) add('PSUseSingularNouns', 'Warning', line, `The cmdlet '${s.name}' uses a plural noun. A singular noun should be used instead.`);
        const shouldProcess = s.block.binding && Object.keys(s.block.binding.named).some((k) => k === 'supportsshouldprocess');
        if (/^(new|set|remove|start|stop|restart|reset|update)$/i.test(verb) && noun && !shouldProcess) add('PSUseShouldProcessForStateChangingFunctions', 'Warning', line, `Function '${s.name}' has verb that could change system state. Therefore, the function has to support 'ShouldProcess'.`);
        for (const p of s.block.params ?? []) {
          if (/pass(word)?$|^pwd$|password/i.test(p.name) && (!p.type || /^string$/i.test(p.type))) add('PSAvoidUsingPlainTextForPassword', 'Warning', line, `Parameter '$${p.name}' should not use String type but either SecureString or PSCredential, otherwise it increases the chance to expose this sensitive information.`);
          if (p.dflt) visitExpr(p.dflt, line);
        }
        const before = new Set(used);
        visitBlock(s.block);
        for (const p of s.block.params ?? []) if (!used.has(p.name.toLowerCase()) || (before.has(p.name.toLowerCase()) && !bodyUses(s.block, p.name))) if (!bodyUses(s.block, p.name)) add('PSReviewUnusedParameter', 'Warning', line, `The parameter '${p.name}' has been declared but not used. `);
        return;
      }
    }
  };
  const visitStmts = (list: Stmt[]) => list.forEach(visitStmt);
  const visitBlock = (b: Block) => {
    for (const p of b.params ?? []) assigned.set(p.name.toLowerCase(), -1);
    [b.begin, b.process, b.end].forEach((l) => l && visitStmts(l));
  };
  visitBlock(ast);
  for (const [v, line] of assigned) if (line > 0 && !used.has(v)) add('PSUseDeclaredVarsMoreThanAssignments', 'Warning', line, `The variable '${v}' is assigned but never used.`);
  void lineOfText;
  return out.sort((a, b) => a.Line - b.Line);
}

function bodyUses(b: Block, name: string): boolean {
  const re = new RegExp(`\\$${name}\\b|\\$\\{${name}\\}|PSBoundParameters`, 'i');
  const text = JSON.stringify([b.begin, b.process, b.end]);
  return re.test(text) || new RegExp(`"name":"${name}"`, 'i').test(text);
}

function displayName(cmd: string): string {
  return cmd.replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => d + c.toUpperCase());
}

/* ----------------------------------------------------------------------------- web */

function webRequest(cx: Cx, rest: boolean): Value[] {
  const P = cx.P;
  for (const k of ['maximumretrycount', 'retryintervalsec', 'skipcertificatecheck', 'statuscodevariable', 'responseheaderstvariable']) if (P[k] !== undefined) fail(cx, `A parameter cannot be found that matches parameter name '${k === 'maximumretrycount' ? 'MaximumRetryCount' : k === 'retryintervalsec' ? 'RetryIntervalSec' : k === 'skipcertificatecheck' ? 'SkipCertificateCheck' : 'StatusCodeVariable'}'. (Windows PowerShell 5.1 has no built-in retries: write a loop with try/catch.)`, 'ParameterBindingException');
  const uri = str(P.uri ?? cx.pos[0]);
  const m = /^(https?):\/\/([^/:?#]+)(?::(\d+))?([/?][^\s#]*)?$/i.exec(uri);
  if (!m) fail(cx, `Invalid URI: The format of the URI could not be determined.`, 'UriFormatException');
  const port = Number(m![3] ?? (m![1].toLowerCase() === 'https' ? 443 : 80));
  if (!apiAt(cx.env.sys, m![2], port)) fail(cx, 'Unable to connect to the remote server', 'WebException');
  const headers: Record<string, string> = {};
  if (isHash(P.headers)) for (const [k, v] of Object.entries(P.headers as Obj)) if (!k.startsWith('__')) headers[k] = str(v);
  if (isObj(P.credential) && (P.credential as Obj).__type === 'credential') {
    const c = P.credential as Obj;
    headers.Authorization = `Basic ${toBase64(`${str(c.UserName)}:${isSecure(c.Password) ? (c.Password as { plain: string }).plain : ''}`)}`;
  }
  const method = str(P.method ?? 'GET').toUpperCase();
  let path = m![4] ?? '/';
  let body: string | undefined;
  if (P.body !== undefined && P.body !== null) {
    if (isHash(P.body)) {
      const form = Object.entries(P.body as Obj).filter(([k]) => !k.startsWith('__')).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(str(v))}`).join('&');
      if (method === 'GET') path += (path.includes('?') ? '&' : '?') + form;
      else body = form;
    } else body = str(P.body);
  }
  const ct = P.contenttype !== undefined ? str(P.contenttype) : body !== undefined ? 'application/x-www-form-urlencoded' : undefined;
  if (ct) headers['Content-Type'] = ct;
  const res = handleApi(cx.env.sys, { method, path, headers, body });
  if (res.status >= 400) {
    const reason = res.reason;
    const msg = res.body.trim() || `The remote server returned an error: (${res.status}) ${reason}.`;
    const rec = errorRecord(msg, 'WebException', { command: cx.call.name, id: 'WebCmdletWebResponseException,Microsoft.PowerShell.Commands.InvokeRestMethodCommand', category: 'InvalidOperation' });
    (rec.Exception as Obj).Message = `The remote server returned an error: (${res.status}) ${reason}.`;
    (rec.Exception as Obj).Response = { __type: 'psobject', StatusCode: res.status, StatusDescription: reason, Headers: { __type: 'hashtable', ...res.headers } };
    rec.ErrorDetails = { __type: 'psobject', Message: res.body.trim() };
    // In Windows PowerShell 5.1 the console shows the response body as the error message.
    rec.__display = msg;
    reportError(cx.env, { ...rec, Exception: { ...(rec.Exception as Obj), Message: msg !== res.body.trim() ? msg : `The remote server returned an error: (${res.status}) ${reason}.` } }, P.errorvariable !== undefined ? str(P.errorvariable) : undefined, P.erroraction !== undefined ? str(P.erroraction) : undefined, true);
    return [];
  }
  if (P.outfile !== undefined) {
    writeFile(cx.env.sys.fs, toVfs(cx.env, str(P.outfile)), res.body, ROOT, cx.env.sys.now);
    return [];
  }
  if (!rest) {
    const h: Obj = { __type: 'hashtable', ...res.headers };
    return [{ __type: 'webresponse', StatusCode: res.status, StatusDescription: res.reason, Content: res.body, RawContent: `HTTP/1.1 ${res.status} ${res.reason}\r\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${res.body}`, Headers: h, RawContentLength: res.body.length }];
  }
  if (!res.body) return [];
  if (/json/i.test(res.headers['Content-Type'] ?? '')) {
    const v = toPs(JSON.parse(res.body));
    return isArr(v) ? v : [v];
  }
  return [res.body];
}

function toPs(v: unknown): Value {
  if (Array.isArray(v)) return v.map(toPs);
  if (v && typeof v === 'object') {
    const o: Obj = { __type: 'psobject' };
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = toPs(x);
    return o;
  }
  return v as Value;
}

/* ----------------------------------------------------------------------------- CIM, drives, certificates */

type Cert = { subject: string; template: string; thumb: string; notAfter?: string; notBefore?: string; issuer?: string; dns?: string[]; friendly?: string };
const certStore = (m: Machine) => ((m as Machine & { certs?: Cert[] }).certs ??= []);

function freeGb(p: { sizeGb: number; freeGb?: number }): number {
  return p.freeGb ?? Math.round(p.sizeGb * 0.55 * 100) / 100;
}

function cimFilter(filter: string | undefined, o: Obj): boolean {
  if (!filter) return true;
  return filter.split(/\s+AND\s+/i).every((cond) => {
    const m = /^\s*(\w+)\s*(=|<>|!=|<|>|LIKE)\s*'?([^']*)'?\s*$/i.exec(cond);
    if (!m) return true;
    const v = str(prop(o, m[1]));
    const want = m[3];
    switch (m[2].toUpperCase()) {
      case '=':
        return v.toLowerCase() === want.toLowerCase();
      case '<>':
      case '!=':
        return v.toLowerCase() !== want.toLowerCase();
      case '<':
        return Number(v) < Number(want);
      case '>':
        return Number(v) > Number(want);
      case 'LIKE':
        return new RegExp('^' + want.replace(/%/g, '.*') + '$', 'i').test(v);
    }
    return true;
  });
}

function cim(cx: Cx): Value[] {
  const cls = str(cx.P.classname ?? cx.P.class ?? cx.pos[0]).toLowerCase();
  const m = cx.P.computername !== undefined ? cx.env.est.machines.find((x) => x.name.toLowerCase() === str(cx.P.computername).toLowerCase()) ?? machine(cx.env) : machine(cx.env);
  const GB = 1024 ** 3;
  let rows: Obj[] = [];
  if (cls === 'win32_logicaldisk' || cls === 'win32_volume') {
    rows = m.disks.flatMap((d) => d.partitions.filter((p) => p.letter && p.fs).map((p) => ({ __type: 'select', DeviceID: `${p.letter}:`, DriveType: 3, ProviderName: '', VolumeName: p.label ?? '', Size: Math.round(p.sizeGb * GB), FreeSpace: Math.round(freeGb(p) * GB) })));
    if (!rows.some((r) => r.DeviceID === 'C:')) rows.unshift({ __type: 'select', DeviceID: 'C:', DriveType: 3, ProviderName: '', VolumeName: '', Size: 127 * GB, FreeSpace: Math.round(((m as Machine & { cFreeGb?: number }).cFreeGb ?? 61.4) * GB) });
  } else if (cls === 'win32_operatingsystem') rows = [{ __type: 'select', SystemDirectory: 'C:\\Windows\\system32', Organization: '', BuildNumber: '20348', RegisteredUser: 'Windows User', SerialNumber: '00454-60000-00001-AA001', Version: '10.0.20348', __extra: { Caption: `Microsoft ${m.os}`, CSName: m.name, LastBootUpTime: makeDate(cx.env.sys.now - 3 * 86400000 - 4 * 3600000), FreePhysicalMemory: (m as Machine & { freeMemKb?: number }).freeMemKb ?? 4194304, TotalVisibleMemorySize: 8388608, OSArchitecture: '64-bit' } }];
  else if (cls === 'win32_computersystem') rows = [{ __type: 'select', Name: m.name, PrimaryOwnerName: 'Windows User', Domain: m.domain ?? 'WORKGROUP', TotalPhysicalMemory: 8589934592, Model: 'Virtual Machine', Manufacturer: 'Microsoft Corporation', __extra: { NumberOfProcessors: 1, NumberOfLogicalProcessors: 4, PartOfDomain: !!m.domain } }];
  else if (cls === 'win32_service') rows = Object.entries(m.services).map(([n, s]) => ({ __type: 'select', ProcessId: s.status === 'Running' ? 1000 + n.length : 0, Name: n, StartMode: s.start === 'Automatic' ? 'Auto' : s.start, State: s.status, Status: 'OK' }));
  else if (cls === 'win32_bios') rows = [{ __type: 'select', SMBIOSBIOSVersion: 'Hyper-V UEFI Release v4.1', Manufacturer: 'Microsoft Corporation', Name: 'Hyper-V UEFI Release v4.1', SerialNumber: `${m.name}-0001`, Version: 'VRTUAL - 1' }];
  else fail(cx, `Invalid class "${str(cx.P.classname ?? cx.P.class ?? cx.pos[0])}"`, 'CimException');
  const filter = cx.P.filter !== undefined ? str(cx.P.filter) : undefined;
  return rows.filter((r) => cimFilter(filter, r) && cimFilter(filter, { ...r, ...((r.__extra as Obj) ?? {}) }));
}

function certObjects(cx: Cx, path: string): Obj[] {
  const m = machine(cx.env);
  let list = certStore(m).map((c) => ({
    __type: 'cert',
    Thumbprint: c.thumb,
    Subject: c.subject,
    __extra: { NotAfter: makeDate(parseDateText(c.notAfter ?? '2027-10-22') ?? 0), NotBefore: makeDate(parseDateText(c.notBefore ?? '2026-01-01') ?? 0), Issuer: c.issuer ?? c.subject, FriendlyName: c.friendly ?? '', HasPrivateKey: true, DnsNameList: c.dns ?? [c.subject.replace(/^CN=/, '')], EnhancedKeyUsageList: /code/i.test(c.template) ? 'Code Signing (1.3.6.1.5.5.7.3.3)' : 'Server Authentication (1.3.6.1.5.5.7.3.1)', Template: c.template, PSParentPath: path },
  })) as Obj[];
  if (cx.P.codesigningcert) list = list.filter((c) => /code/i.test(str((c.__extra as Obj).Template)));
  if (cx.P.expiringindays !== undefined) list = list.filter((c) => msOf((c.__extra as Obj).NotAfter as Obj) - cx.env.sys.now <= num(cx.P.expiringindays) * 86400000);
  if (cx.P.dnsname !== undefined) list = list.filter((c) => asList((c.__extra as Obj).DnsNameList).some((d) => new RegExp('^' + str(cx.P.dnsname).replace(/\*/g, '.*') + '$', 'i').test(str(d))));
  const thumb = /\\([0-9A-F]{40})$/i.exec(path)?.[1];
  if (thumb) list = list.filter((c) => str(c.Thumbprint).toUpperCase() === thumb.toUpperCase());
  return list;
}

/* ----------------------------------------------------------------------------- scheduled tasks */

type Task = Machine['tasks'][number] & { path?: string; triggers?: Obj[]; argument?: string; execute?: string; workingDirectory?: string; runLevel?: string; logonType?: string; lastRun?: number; lastResult?: number; description?: string; settings?: Obj; passwordStored?: boolean; repetition?: string };

/** "\\ICT\\" style task folder, with leading and trailing backslashes. */
function taskFolder(p: Value): string {
  const s = str(p ?? '\\').trim() || '\\';
  return ('\\' + s.replace(/^\\+|\\+$/g, '') + '\\').replace(/^\\\\$/, '\\');
}

function taskOf(cx: Cx, name: string): Task {
  const m = machine(cx.env);
  // "\\ICT\\Nightly Clean" names the folder and the task.
  const slash = name.lastIndexOf('\\');
  const folder = cx.P.taskpath !== undefined ? taskFolder(cx.P.taskpath) : slash > 0 ? taskFolder(name.slice(0, slash)) : undefined;
  const leaf = slash >= 0 ? name.slice(slash + 1) : name;
  const t = m.tasks.find((x) => x.name.toLowerCase() === leaf.toLowerCase() && (folder === undefined || ((x as Task).path ?? '\\').toLowerCase() === folder.toLowerCase()));
  if (!t) fail(cx, `No MSFT_ScheduledTask objects found with property 'TaskName' equal to '${name}'.  Verify the value of the property and retry.`, 'CimJobException', false);
  return t as Task;
}

/** Runs a task's action now (powershell.exe -File script.ps1 runs the script) and records the result. */
function runTask(cx: Cx, t: Task): number {
  const exe = (t.execute ?? t.action.split(/\s+/)[0] ?? '').toLowerCase();
  const arg = t.argument ?? t.action.slice(t.action.indexOf(' ') + 1);
  let code = 0;
  // The task runs as its principal (SYSTEM shows as COMPUTER$), starting in its working directory or System32.
  const savedRunAs = cx.env.vars.get('__runas');
  const savedCwd = cx.env.sys.cwd;
  const u = t.user.replace(/^NT AUTHORITY\\/i, '');
  cx.env.vars.set('__runas', /^(system|localsystem)$/i.test(u) ? `${machine(cx.env).name}$` : /^(local|network) ?service$/i.test(u) ? u.toUpperCase() : u.replace(/^.*\\/, ''));
  const cwd = toVfs(cx.env, t.workingDirectory || 'C:\\Windows\\System32');
  mkdir(cx.env.sys.fs, cwd, ROOT, cx.env.sys.now, true);
  cx.env.sys.cwd = cwd;
  try {
    if (/powershell(\.exe)?$|pwsh(\.exe)?$/.test(exe)) {
      const file = /-File\s+("([^"]+)"|(\S+))/i.exec(arg);
      const command = /-Command\s+("([^"]+)"|(.+))$/i.exec(arg);
      try {
        if (file) {
          const p = file[2] ?? file[3];
          const text = readFile(cx.env.sys.fs, toVfs(cx.env, p), ROOT);
          const savedTry = cx.env.tryDepth;
          cx.env.tryDepth = 1;
          try {
            const r = runScriptText(cx.env, text, toWin(toVfs(cx.env, p)), (arg.slice((file.index ?? 0) + file[0].length).trim().match(/"[^"]*"|\S+/g) ?? []).map((x) => x.replace(/^"|"$/g, '')));
            code = r.exit;
          } finally {
            cx.env.tryDepth = savedTry;
          }
        } else if (command) runBlock(cx.env, { __type: 'block', src: command[2] ?? command[3] }, { newScope: true });
      } catch {
        // An unhandled terminating error ends powershell.exe with exit code 1.
        code = 1;
      }
    } else if (exe && !/robocopy|cmd(\.exe)?$/.test(exe)) code = 2147942402; // file not found
  } finally {
    if (savedRunAs === undefined) cx.env.vars.delete('__runas');
    else cx.env.vars.set('__runas', savedRunAs);
    cx.env.sys.cwd = savedCwd;
  }
  t.lastRun = cx.env.sys.now;
  t.lastResult = code;
  cx.env.dirtyEst = true;
  return code;
}

/** "2am", "3:30pm" or "02:00" as that time today on the simulated clock. */
function timeToday(cx: Cx, s: string): number | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([ap]m)?\s*$/i.exec(s);
  if (!m || (!m[2] && !m[4])) return null;
  let h = Number(m[1]) % 24;
  if (m[4]) h = (h % 12) + (/pm/i.test(m[4]) ? 12 : 0);
  const d = new Date(cx.env.sys.now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, Number(m[2] ?? 0), Number(m[3] ?? 0));
}

/** The next time a daily, weekly or once trigger fires after the simulated clock. */
function nextRun(cx: Cx, t: Task): Value {
  const now = cx.env.sys.now;
  let best: number | null = null;
  for (const tr of t.triggers ?? []) {
    const sb = parseDateText(str(tr.StartBoundary));
    if (sb === null || sb === undefined) continue;
    const kind = str(tr.Kind);
    let at = sb;
    if (kind === 'Daily' || kind === 'Weekly') {
      const step = (kind === 'Weekly' ? 7 : Number(tr.DaysInterval ?? 1) || 1) * 86400000;
      while (at <= now) at += step;
    } else if (at <= now) continue;
    if (best === null || at < best) best = at;
  }
  return best === null ? null : makeDate(best);
}

function taskView(t: Task): Obj {
  return { __type: 'task', TaskPath: t.path ?? '\\', TaskName: t.name, State: t.enabled ? 'Ready' : 'Disabled', Trigger: t.trigger, Action: t.action, User: t.user, __extra: { Description: t.description ?? '', URI: `${t.path ?? '\\'}${t.name}`, Actions: [{ __type: 'psobject', Execute: t.execute ?? t.action.split(' ')[0], Arguments: t.argument ?? '', WorkingDirectory: t.workingDirectory ?? '' }], Triggers: t.triggers?.length ? t.triggers : [{ __type: 'psobject', Text: t.trigger, Repetition: t.repetition ?? '' }], Principal: { __type: 'psobject', UserId: t.user, RunLevel: t.runLevel ?? 'Limited', LogonType: t.logonType ?? 'ServiceAccount' }, Settings: t.settings ?? {} } };
}

/* ----------------------------------------------------------------------------- packages (winget, choco) */

interface Pkg {
  id: string;
  name: string;
  version: string;
  choco: string;
}
const CATALOG: Pkg[] = [
  { id: 'Git.Git', name: 'Git', version: '2.47.0', choco: 'git' },
  { id: '7zip.7zip', name: '7-Zip', version: '24.08', choco: '7zip' },
  { id: 'Mozilla.Firefox', name: 'Mozilla Firefox', version: '131.0.3', choco: 'firefox' },
  { id: 'Google.Chrome', name: 'Google Chrome', version: '130.0.6723.70', choco: 'googlechrome' },
  { id: 'Notepad++.Notepad++', name: 'Notepad++', version: '8.7', choco: 'notepadplusplus' },
  { id: 'VideoLAN.VLC', name: 'VLC media player', version: '3.0.21', choco: 'vlc' },
  { id: 'Microsoft.VisualStudioCode', name: 'Microsoft Visual Studio Code', version: '1.94.2', choco: 'vscode' },
  { id: 'Python.Python.3.12', name: 'Python 3.12', version: '3.12.7', choco: 'python' },
  { id: 'OpenJS.NodeJS.LTS', name: 'Node.js LTS', version: '20.18.0', choco: 'nodejs-lts' },
  { id: 'PuTTY.PuTTY', name: 'PuTTY', version: '0.81', choco: 'putty' },
  { id: 'WinSCP.WinSCP', name: 'WinSCP', version: '6.3.5', choco: 'winscp' },
  { id: 'Microsoft.PowerShell', name: 'PowerShell', version: '7.4.6', choco: 'powershell-core' },
  { id: 'Adobe.Acrobat.Reader.64-bit', name: 'Adobe Acrobat Reader (64-bit)', version: '24.003.20180', choco: 'adobereader' },
  { id: 'TheDocumentFoundation.LibreOffice', name: 'LibreOffice', version: '24.8.2', choco: 'libreoffice-fresh' },
  { id: 'Zoom.Zoom', name: 'Zoom Workplace', version: '6.2.5', choco: 'zoom' },
];

type Installed = { id: string; version: string; pinned?: boolean };
const apps = (m: Machine) => ((m as Machine & { apps?: Installed[] }).apps ??= []);

function findPkg(q: string): Pkg | undefined {
  const k = q.toLowerCase();
  return CATALOG.find((p) => p.id.toLowerCase() === k || p.choco === k || p.name.toLowerCase() === k);
}

function exitCode(cx: Cx, n: number): void {
  cx.env.vars.set('__exitcode', n);
}

function flag(args: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a.toLowerCase() === n) return args[i + 1] ?? '';
      if (a.toLowerCase().startsWith(n + '=')) return a.slice(n.length + 1);
    }
  }
  return undefined;
}

/* ----------------------------------------------------------------------------- secure strings */

const DPAPI = '01000000d08c9ddf0115d1118c7a00c04fc297eb01000000';

function protect(cx: Cx, plain: string, key?: string): string {
  const k = key ?? `${machine(cx.env).name}\\${cx.env.sys.user}`;
  const bytes = [...plain].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8]);
  const kb = [...sha1(k)].map((c) => c.charCodeAt(0));
  return DPAPI + bytes.map((b, i) => (b ^ kb[i % kb.length]).toString(16).padStart(2, '0')).join('') + sha1(k + plain).slice(0, 8);
}

function unprotect(cx: Cx, text: string, key?: string): string | null {
  if (!text.startsWith(DPAPI)) return null;
  const k = key ?? `${machine(cx.env).name}\\${cx.env.sys.user}`;
  const body = text.slice(DPAPI.length, -8);
  const kb = [...sha1(k)].map((c) => c.charCodeAt(0));
  const bytes = (body.match(/../g) ?? []).map((h, i) => parseInt(h, 16) ^ kb[i % kb.length]);
  let plain = '';
  for (let i = 0; i < bytes.length; i += 2) plain += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  return sha1(k + plain).slice(0, 8) === text.slice(-8) ? plain : null;
}

function secretStorePath(cx: Cx): string {
  return toVfs(cx.env, `C:\\Users\\${cx.env.sys.user}\\AppData\\Local\\Microsoft\\PowerShell\\secretmanagement\\localstore\\storefile.json`);
}

interface Store {
  vaults: Array<{ name: string; module: string; isDefault: boolean }>;
  config: { authentication: 'Password' | 'None'; interaction: 'Prompt' | 'None'; password?: string };
  secrets: Record<string, { type: string; value: string; user?: string }>;
  unlocked?: boolean;
}

function loadStore(cx: Cx): Store {
  try {
    return JSON.parse(readFile(cx.env.sys.fs, secretStorePath(cx), ROOT)) as Store;
  } catch {
    return { vaults: [], config: { authentication: 'Password', interaction: 'Prompt' }, secrets: {} };
  }
}

function saveStore(cx: Cx, s: Store): void {
  const p = secretStorePath(cx);
  mkdir(cx.env.sys.fs, p.slice(0, p.lastIndexOf('/')), ROOT, cx.env.sys.now, true);
  writeFile(cx.env.sys.fs, p, JSON.stringify(s), ROOT, cx.env.sys.now);
}

function storeReady(cx: Cx, s: Store): void {
  if (!s.vaults.length) fail(cx, 'There are no secret vaults registered. Register one with Register-SecretVault -Name LocalStore -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault.', 'InvalidOperationException');
  if (s.config.authentication === 'Password' && !cx.env.vars.get('__storeunlocked')) fail(cx, 'A valid password is required to access the Microsoft.PowerShell.SecretStore vault. Use the Unlock-SecretStore cmdlet to provide the required password to access the store. (An unattended script needs Set-SecretStoreConfiguration -Authentication None -Interaction None, or a password it can read safely.)', 'InvalidOperationException');
}

/* ----------------------------------------------------------------------------- register */

const oldChildItem = CMDLET_TABLE['get-childitem'];

register(
  {
    /* Pester */
    describe: (cx) => describe(cx, 'Describe'),
    context: (cx) => describe(cx, 'Context'),
    it: (cx) => it(cx),
    beforeall: (cx) => {
      const b = cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : cx.pos.find(isBlock);
      if (b) runBlock(cx.env, b, { newScope: false });
      return [];
    },
    beforeeach: (cx) => {
      const run = pester(cx);
      const b = cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : cx.pos.find(isBlock);
      if (run?.frames.length && b) run.frames[run.frames.length - 1].beforeEach.push(b as Obj);
      return [];
    },
    aftereach: (cx) => {
      const run = pester(cx);
      const b = cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : cx.pos.find(isBlock);
      if (run?.frames.length && b) run.frames[run.frames.length - 1].afterEach.push(b as Obj);
      return [];
    },
    afterall: (cx) => {
      const run = pester(cx);
      const b = cx.call.block !== undefined ? ((cx.call.blockValue as Obj | undefined) ?? { __type: 'block', src: cx.call.block }) : cx.pos.find(isBlock);
      if (run?.frames.length && b) run.frames[run.frames.length - 1].afterAll.push(b as Obj);
      return [];
    },
    should: (cx) => should(cx),
    mock: (cx) => mockCmd(cx),
    'assert-mockcalled': (cx) => should({ ...cx, P: { ...cx.P, invoke: true, commandname: cx.P.commandname ?? cx.pos[0] }, pos: [], input: [] }),
    'invoke-pester': (cx) => {
      const target = str(cx.P.path ?? cx.P.script ?? cx.pos[0] ?? '.');
      const vfs = toVfs(cx.env, target);
      const l = lookup(cx.env.sys.fs, vfs, ROOT);
      if (!l) fail(cx, `Cannot find path '${toWin(vfs)}' because it does not exist.`, 'ItemNotFoundException', false);
      const files: string[] = [];
      const walk = (p: string) => {
        const node = lookup(cx.env.sys.fs, p, ROOT);
        if (!node) return;
        if (node.node.type === 'file') {
          if (/\.tests\.ps1$/i.test(p) || p === vfs) files.push(p);
          return;
        }
        for (const e of listDir(cx.env.sys.fs, p, ROOT)) walk(`${p}/${e.name}`);
      };
      walk(vfs);
      const output = str(cx.P.output ?? (cx.P.passthru ? 'Normal' : 'Normal'));
      const all: PesterResult[] = [];
      const lines: string[] = [];
      let discovered = 0;
      for (const f of files) {
        const text = readFile(cx.env.sys.fs, f, ROOT);
        discovered += (text.match(/^\s*It\s+['"]/gim) ?? []).length;
      }
      for (const f of files) {
        const text = readFile(cx.env.sys.fs, f, ROOT);
        const run: PesterRun = { results: [], frames: [], file: toWin(f), direct: false, lines: [], output: /detailed|diagnostic/i.test(output) ? 'Detailed' : output };
        RUNS.set(cx.env.vars, run);
        if (run.output === 'Detailed') run.lines.push('', `Running tests from '${toWin(f)}'`);
        try {
          runScriptText(cx.env, text, toWin(f));
        } catch (e) {
          if (e instanceof RuntimeErr) run.results.push({ path: [], name: 'the test file', ok: false, skipped: false, message: String((e.record.Exception as Obj).Message), at: `at ${toWin(f)}`, file: toWin(f) });
          else throw e;
        } finally {
          RUNS.delete(cx.env.vars);
        }
        all.push(...run.results);
        lines.push(...run.lines);
      }
      const passed = all.filter((r) => r.ok && !r.skipped).length;
      const failed = all.filter((r) => !r.ok).length;
      const skipped = all.filter((r) => r.skipped).length;
      if (!/none/i.test(output)) cx.print([`Starting discovery in ${files.length} file${files.length === 1 ? '' : 's'}.`, `Discovery found ${discovered} tests in ${20 + discovered * 3}ms.`, 'Running tests.', ...lines, `Tests completed in ${60 + all.length * 9}ms`, `Tests Passed: ${passed}, Failed: ${failed}, Skipped: ${skipped} NotRun: 0`, ''].join('\n'));
      cx.env.vars.set('__pesterlast', { passed, failed });
      if (cx.P.passthru) return [{ __type: 'psobject', Result: failed ? 'Failed' : 'Passed', TotalCount: all.length, PassedCount: passed, FailedCount: failed, SkippedCount: skipped, NotRunCount: 0, Tests: all.map((r) => ({ __type: 'psobject', Name: r.name, Path: [...r.path, r.name].join('.'), Result: r.skipped ? 'Skipped' : r.ok ? 'Passed' : 'Failed', ErrorRecord: r.message ?? null })) }];
      return [];
    },

    /* PSScriptAnalyzer */
    'invoke-scriptanalyzer': (cx) => {
      needModule(cx, 'PSScriptAnalyzer');
      const sev = cx.P.severity !== undefined ? asList(cx.P.severity).map((s) => str(s).toLowerCase()) : undefined;
      const include = cx.P.includerule !== undefined ? asList(cx.P.includerule).map((x) => str(x).toLowerCase()) : undefined;
      const exclude = asList(cx.P.excluderule).map((x) => str(x).toLowerCase());
      const targets: Array<{ file: string; src: string }> = [];
      if (cx.P.scriptdefinition !== undefined) targets.push({ file: '', src: str(cx.P.scriptdefinition) });
      else {
        const p = toVfs(cx.env, str(cx.P.path ?? cx.pos[0]));
        const l = lookup(cx.env.sys.fs, p, ROOT);
        if (!l) fail(cx, `Cannot find path '${toWin(p)}' because it does not exist.`, 'ItemNotFoundException', false);
        const walk = (q: string) => {
          const n = lookup(cx.env.sys.fs, q, ROOT);
          if (!n) return;
          if (n.node.type === 'file' && /\.ps(m?1)$/i.test(q)) targets.push({ file: q, src: n.node.content });
          else if (n.node.type === 'dir') for (const e of listDir(cx.env.sys.fs, q, ROOT)) if (cx.P.recurse || lookup(cx.env.sys.fs, `${q}/${e.name}`, ROOT)?.node.type === 'file') walk(`${q}/${e.name}`);
        };
        walk(p);
      }
      return targets.flatMap((t) =>
        analyze(t.src, toWin(t.file).replace(/^.*\\/, ''), ALIASES)
          .filter((f) => (!sev || sev.includes(f.Severity.toLowerCase())) && (!include || include.includes(f.RuleName.toLowerCase())) && !exclude.includes(f.RuleName.toLowerCase()))
          .map((f) => ({ __type: 'analyzer', RuleName: f.RuleName, Severity: f.Severity, ScriptName: toWin(t.file).replace(/^.*\\/, ''), Line: f.Line, Message: f.Message })),
      );
    },
    'get-scriptanalyzerrule': (cx) => {
      needModule(cx, 'PSScriptAnalyzer');
      return ['PSAvoidUsingCmdletAliases', 'PSAvoidUsingWriteHost', 'PSAvoidUsingPlainTextForPassword', 'PSAvoidUsingConvertToSecureStringWithPlainText', 'PSAvoidUsingInvokeExpression', 'PSUseDeclaredVarsMoreThanAssignments', 'PSUseApprovedVerbs', 'PSUseSingularNouns', 'PSUseShouldProcessForStateChangingFunctions', 'PSAvoidUsingPositionalParameters', 'PSAvoidGlobalVars', 'PSAvoidUsingEmptyCatchBlock', 'PSReviewUnusedParameter', 'PSPossibleIncorrectComparisonWithNull', 'PSAvoidAssignmentToAutomaticVariable'].map((r) => ({ __type: 'select', RuleName: r, Severity: /PlainText$|SecureString/.test(r) ? 'Error' : r === 'PSAvoidUsingPositionalParameters' ? 'Information' : 'Warning' }));
    },

    /* web */
    'invoke-restmethod': (cx) => webRequest(cx, true),
    'invoke-webrequest': (cx) => webRequest(cx, false),

    /* CIM and drives */
    'get-ciminstance': (cx) => cim(cx),
    'get-wmiobject': (cx) => cim(cx),
    'get-psdrive': (cx) => {
      const m = machine(cx.env);
      const want = cx.P.name ?? cx.pos[0];
      const drives = cim({ ...cx, P: { classname: 'Win32_LogicalDisk' }, pos: [] }).map((d) => {
        const o = d as Obj;
        const size = Number(o.Size);
        const free = Number(o.FreeSpace);
        return { __type: 'select', Name: str(o.DeviceID).replace(':', ''), 'Used (GB)': Math.round(((size - free) / 1024 ** 3) * 100) / 100, 'Free (GB)': Math.round((free / 1024 ** 3) * 100) / 100, Provider: 'FileSystem', Root: `${str(o.DeviceID)}\\`, __extra: { Used: size - free, Free: free } };
      });
      void m;
      return drives.filter((d) => want === undefined || str(d.Name).toLowerCase() === str(want).toLowerCase().replace(':', ''));
    },

    /* certificates */
    'get-childitem': (cx) => {
      const p = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0] ?? '.');
      if (/^cert:/i.test(p)) return certObjects(cx, p);
      return oldChildItem(cx);
    },
    'new-selfsignedcertificate': (cx) => {
      const m = machine(cx.env);
      const dns = asList(cx.P.dnsname).map(str);
      const subject = cx.P.subject !== undefined ? str(cx.P.subject).replace(/^(?!CN=)/i, 'CN=') : `CN=${dns[0] ?? m.name}`;
      const type = str(cx.P.type ?? 'SSLServerAuthentication');
      const notAfter = cx.P.notafter !== undefined ? formatDate(msOf(isDate(cx.P.notafter) ? (cx.P.notafter as Obj) : (makeDate(parseDateText(str(cx.P.notafter)) ?? cx.env.sys.now))), "yyyy-MM-dd'T'HH:mm:ss") : formatDate(cx.env.sys.now + 365 * 86400000, "yyyy-MM-dd'T'HH:mm:ss");
      const thumb = sha1(subject + cx.env.sys.now + certStore(m).length).toUpperCase();
      certStore(m).push({ subject, template: /code/i.test(type) ? 'CodeSigning' : 'WebServer', thumb, notAfter, notBefore: formatDate(cx.env.sys.now, "yyyy-MM-dd'T'HH:mm:ss"), issuer: subject, dns: dns.length ? dns : [subject.replace(/^CN=/, '')], friendly: str(cx.P.friendlyname ?? '') });
      cx.env.dirtyEst = true;
      return certObjects(cx, `Cert:\\LocalMachine\\My\\${thumb}`);
    },

    /* scheduled tasks */
    'new-scheduledtaskaction': (cx) => [{ __type: 'taskaction', Execute: str(cx.P.execute ?? cx.pos[0]), Argument: str(cx.P.argument ?? ''), WorkingDirectory: str(cx.P.workingdirectory ?? '') }],
    'new-scheduledtasktrigger': (cx) => {
      const at = cx.P.at !== undefined ? (isDate(cx.P.at) ? formatDate(msOf(cx.P.at as Obj), 'h:mmtt').toLowerCase().replace(':00', '') : str(cx.P.at)) : '';
      let text = cx.P.daily ? `Daily at ${at}` : cx.P.weekly ? `Weekly on ${asList(cx.P.daysofweek).map(str).join(', ')} at ${at}` : cx.P.atstartup ? 'At startup' : cx.P.atlogon ? 'At log on' : `Once at ${at}`;
      if (cx.P.daysinterval !== undefined && num(cx.P.daysinterval) > 1) text = text.replace('Daily', `Every ${num(cx.P.daysinterval)} days`);
      const rep = cx.P.repetitioninterval !== undefined ? str(cx.P.repetitioninterval) : '';
      const atMs = cx.P.at !== undefined ? (isDate(cx.P.at) ? msOf(cx.P.at as Obj) : timeToday(cx, str(cx.P.at)) ?? parseDateText(str(cx.P.at))) : undefined;
      const kind = cx.P.daily ? 'Daily' : cx.P.weekly ? 'Weekly' : cx.P.atstartup ? 'AtStartup' : cx.P.atlogon ? 'AtLogOn' : 'Once';
      return [{ __type: 'tasktrigger', Text: rep ? `${text}, repeat every ${rep}${cx.P.repetitionduration !== undefined ? ` for ${str(cx.P.repetitionduration)}` : ''}` : text, Repetition: rep, Kind: kind, StartBoundary: atMs !== undefined && atMs !== null ? formatDate(atMs, "yyyy-MM-dd'T'HH:mm:ss") : '', DaysInterval: cx.P.daysinterval !== undefined ? num(cx.P.daysinterval) : kind === 'Daily' ? 1 : undefined, DaysOfWeek: cx.P.daysofweek !== undefined ? asList(cx.P.daysofweek).map(str).join(', ') : undefined, Enabled: true }];
    },
    'new-scheduledtaskprincipal': (cx) => [{ __type: 'taskprincipal', UserId: str(cx.P.userid ?? cx.P.groupid ?? 'SYSTEM'), LogonType: str(cx.P.logontype ?? 'ServiceAccount'), RunLevel: str(cx.P.runlevel ?? 'Limited') }],
    'new-scheduledtasksettingsset': (cx) => {
      // Task Scheduler keeps time limits as ISO 8601 durations: PT1H, PT30M, P3D.
      const iso = (ms: number) => {
        const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
        return `P${d ? `${d}D` : ''}${h || m || s ? 'T' : ''}${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s ? `${s}S` : ''}` || 'PT0S';
      };
      const names: Record<string, string> = { executiontimelimit: 'ExecutionTimeLimit', startwhenavailable: 'StartWhenAvailable', restartcount: 'RestartCount', restartinterval: 'RestartInterval', multipleinstances: 'MultipleInstances', allowstartifonbatteries: 'AllowStartIfOnBatteries', dontstopifgoingonbatteries: 'DontStopIfGoingOnBatteries', runonlyifnetworkavailable: 'RunOnlyIfNetworkAvailable', hidden: 'Hidden', waketorun: 'WakeToRun' };
      return [{ __type: 'tasksettings', MultipleInstances: 'IgnoreNew', ExecutionTimeLimit: 'PT72H', ...Object.fromEntries(Object.entries(cx.P).map(([k, v]) => [names[k] ?? k, isObj(v) && (v as Obj).__type === 'timespan' ? iso(Number((v as Obj).__ms)) : isObj(v) ? str(v) : v])) }];
    },
    'register-scheduledtask': (cx) => {
      const m = machine(cx.env);
      const name = str(cx.P.taskname ?? cx.pos[0]);
      if (!name) fail(cx, 'Register-ScheduledTask needs -TaskName.', 'ParameterBindingException', false);
      const folder = taskFolder(cx.P.taskpath);
      const same = (t: Machine['tasks'][number]) => t.name.toLowerCase() === name.toLowerCase() && ((t as Task).path ?? '\\').toLowerCase() === folder.toLowerCase();
      if (m.tasks.some(same) && !cx.P.force) fail(cx, `Cannot create a file when that file already exists: task ${name}. Use -Force to replace it.`, 'IOException', false);
      const actions = asList(cx.P.action);
      const triggers = asList(cx.P.trigger);
      if (!actions.length || !triggers.length) fail(cx, 'Register-ScheduledTask needs -Action (New-ScheduledTaskAction) and -Trigger (New-ScheduledTaskTrigger).', 'ParameterBindingException', false);
      const a = actions[0] as Obj;
      const principal = isObj(cx.P.principal) ? (cx.P.principal as Obj) : undefined;
      const user = str(principal?.UserId ?? cx.P.user ?? 'SYSTEM');
      const task: Task = { name, action: `${str(a.Execute)} ${str(a.Argument)}`.trim(), trigger: triggers.map((t) => str((t as Obj).Text)).join('; '), user, enabled: true, execute: str(a.Execute), argument: str(a.Argument), workingDirectory: str(a.WorkingDirectory ?? ''), runLevel: str(principal?.RunLevel ?? cx.P.runlevel ?? 'Limited'), logonType: str(principal?.LogonType ?? (cx.P.password !== undefined ? 'Password' : /^(system|nt authority\\system|localservice|networkservice)$/i.test(user) ? 'ServiceAccount' : 'Interactive')), description: str(cx.P.description ?? ''), settings: isObj(cx.P.settings) ? (cx.P.settings as Obj) : undefined, passwordStored: cx.P.password !== undefined, repetition: triggers.map((t) => str((t as Obj).Repetition ?? '')).filter(Boolean).join('; '), path: folder, triggers: triggers.filter(isObj).map((t) => ({ ...(t as Obj), __type: 'psobject' })) };
      m.tasks = m.tasks.filter((t) => !same(t));
      m.tasks.push(task);
      cx.env.dirtyEst = true;
      return [{ __type: 'task', TaskPath: folder, TaskName: name, State: 'Ready' }];
    },
    'get-scheduledtask': (cx) => {
      const want = cx.P.taskname ?? cx.pos[0];
      const folder = cx.P.taskpath !== undefined ? str(cx.P.taskpath) : undefined;
      const list = machine(cx.env).tasks.filter((t) => (want === undefined || new RegExp('^' + str(want).replace(/\*/g, '.*') + '$', 'i').test(t.name)) && (folder === undefined || new RegExp('^' + folder.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*') + '$', 'i').test((t as Task).path ?? '\\'))).map((t) => taskView(t as Task));
      if (want !== undefined && !/\*/.test(str(want)) && !list.length) fail(cx, `No MSFT_ScheduledTask objects found with property 'TaskName' equal to '${str(want)}'.  Verify the value of the property and retry.`, 'CimJobException', false);
      return list;
    },
    'get-scheduledtaskinfo': (cx) => {
      const t = taskOf(cx, str(cx.P.taskname ?? cx.pos[0] ?? prop(cx.input?.[0], 'TaskName')));
      return [{ __type: 'select', LastRunTime: t.lastRun ? makeDate(t.lastRun) : null, LastTaskResult: t.lastRun ? t.lastResult : 267011, NextRunTime: nextRun(cx, t), NumberOfMissedRuns: 0, TaskName: t.name, TaskPath: t.path ?? '\\' }];
    },
    'start-scheduledtask': (cx) => {
      const t = taskOf(cx, str(cx.P.taskname ?? cx.pos[0] ?? prop(cx.input?.[0], 'TaskName')));
      if (!t.enabled) fail(cx, `The task is disabled. (Enable-ScheduledTask -TaskName ${t.name})`, 'CimException', false);
      runTask(cx, t);
      return [];
    },
    'enable-scheduledtask': (cx) => {
      const t = taskOf(cx, str(cx.P.taskname ?? cx.pos[0] ?? prop(cx.input?.[0], 'TaskName')));
      t.enabled = true;
      cx.env.dirtyEst = true;
      return [taskView(t)];
    },
    'disable-scheduledtask': (cx) => {
      const t = taskOf(cx, str(cx.P.taskname ?? cx.pos[0] ?? prop(cx.input?.[0], 'TaskName')));
      t.enabled = false;
      cx.env.dirtyEst = true;
      return [taskView(t)];
    },
    'set-scheduledtask': (cx) => {
      const t = taskOf(cx, str(cx.P.taskname ?? cx.pos[0]));
      if (cx.P.trigger !== undefined) t.trigger = asList(cx.P.trigger).map((x) => str((x as Obj).Text)).join('; ');
      if (cx.P.action !== undefined) {
        const a = asList(cx.P.action)[0] as Obj;
        t.execute = str(a.Execute);
        t.argument = str(a.Argument);
        t.action = `${t.execute} ${t.argument}`.trim();
      }
      if (isObj(cx.P.principal)) {
        t.user = str((cx.P.principal as Obj).UserId);
        t.runLevel = str((cx.P.principal as Obj).RunLevel);
      }
      cx.env.dirtyEst = true;
      return [taskView(t)];
    },

    /* event logs */
    'new-eventlog': (cx) => {
      const m = machine(cx.env) as Machine & { eventSources?: Record<string, string> };
      for (const s of asList(cx.P.source)) (m.eventSources ??= {})[str(s).toLowerCase()] = str(cx.P.logname);
      cx.env.dirtyEst = true;
      return [];
    },
    'write-eventlog': (cx) => {
      const m = machine(cx.env) as Machine & { eventSources?: Record<string, string> };
      const source = str(cx.P.source);
      const log = str(cx.P.logname);
      const known = m.eventSources?.[source.toLowerCase()] ?? (/^(Application|System)$/i.test(log) && /^(Application|EventLog|Service Control Manager)$/i.test(source) ? log : undefined);
      if (!known) fail(cx, `The source name "${source}" does not exist on computer "localhost". (Register it once with New-EventLog -LogName ${log || 'Application'} -Source ${source}.)`, 'InvalidOperationException', false);
      const level = str(cx.P.entrytype ?? 'Information');
      m.events.push({ log: log as Machine['events'][number]['log'], id: num(cx.P.eventid), level: (/error/i.test(level) ? 'Error' : /warn/i.test(level) ? 'Warning' : /failure/i.test(level) ? 'Audit Failure' : /success/i.test(level) ? 'Audit Success' : 'Information') as Machine['events'][number]['level'], source, time: formatDate(cx.env.sys.now, 'MM/dd/yyyy HH:mm:ss'), message: str(cx.P.message) });
      cx.env.dirtyEst = true;
      return [];
    },
    'get-eventlog': (cx) => {
      const m = machine(cx.env);
      const log = str(cx.P.logname ?? cx.pos[0]);
      let evs = m.events.map((e, i) => ({ e, i })).filter(({ e }) => e.log.toLowerCase() === log.toLowerCase());
      if (cx.P.instanceid !== undefined) evs = evs.filter(({ e }) => asList(cx.P.instanceid).map((x) => num(x)).includes(e.id));
      if (cx.P.entrytype !== undefined) evs = evs.filter(({ e }) => asList(cx.P.entrytype).some((t) => e.level.toLowerCase().replace('audit ', '') === str(t).toLowerCase().replace('audit', '').trim() || e.level.toLowerCase() === str(t).toLowerCase()));
      if (cx.P.source !== undefined) evs = evs.filter(({ e }) => new RegExp('^' + str(cx.P.source).replace(/\*/g, '.*') + '$', 'i').test(e.source));
      if (cx.P.after !== undefined) evs = evs.filter(({ e }) => (parseDateText(e.time) ?? 0) > msOf(isDate(cx.P.after) ? (cx.P.after as Obj) : makeDate(parseDateText(str(cx.P.after)) ?? 0)));
      if (cx.P.before !== undefined) evs = evs.filter(({ e }) => (parseDateText(e.time) ?? 0) < msOf(isDate(cx.P.before) ? (cx.P.before as Obj) : makeDate(parseDateText(str(cx.P.before)) ?? 0)));
      if (cx.P.message !== undefined) evs = evs.filter(({ e }) => new RegExp('^' + str(cx.P.message).replace(/\*/g, '.*') + '$', 'is').test(e.message));
      evs.reverse();
      if (cx.P.newest !== undefined) evs = evs.slice(0, num(cx.P.newest));
      if (!evs.length && !m.events.some((e) => e.log.toLowerCase() === log.toLowerCase()) && !/^(application|system|security)$/i.test(log)) fail(cx, `The event log '${log}' on computer '.' does not exist.`, 'InvalidOperationException', false);
      return evs.map(({ e, i }) => {
        const t = parseDateText(e.time) ?? cx.env.sys.now;
        return { __type: 'eventlogentry', Index: 10000 + i, Time: formatDate(t, 'MMM dd HH:mm'), EntryType: e.level.replace('Audit ', ''), Source: e.source, InstanceID: e.id, Message: e.message.slice(0, 60), __extra: { TimeGenerated: makeDate(t), EventID: e.id, FullMessage: e.message, ReplacementStrings: Object.values(e.data ?? {}) } };
      });
    },

    /* secure strings, CLIXML, secrets */
    'convertto-securestring': (cx) => {
      const s = str(cx.P.string ?? cx.pos[0] ?? cx.input?.[0]);
      if (cx.P.asplaintext) {
        if (!cx.P.force) fail(cx, 'The system cannot protect plain text input. To suppress this warning and convert the plain text to a SecureString, reissue the command specifying the Force parameter. For more information, type: get-help ConvertTo-SecureString.', 'ArgumentException', false);
        return [{ [SECURE]: true, plain: s }];
      }
      const key = cx.P.key !== undefined ? asList(cx.P.key).map(str).join(',') : undefined;
      const plain = unprotect(cx, s, key);
      if (plain === null) fail(cx, 'Key not valid for use in specified state.', 'CryptographicException', false);
      return [{ [SECURE]: true, plain: plain! }];
    },
    'convertfrom-securestring': (cx) => {
      const sec = cx.P.securestring ?? cx.pos[0] ?? cx.input?.[0];
      if (!isSecure(sec)) fail(cx, 'ConvertFrom-SecureString needs a SecureString (from Read-Host -AsSecureString or ConvertTo-SecureString).', 'ParameterBindingException', false);
      if (cx.P.asplaintext) return [(sec as { plain: string }).plain];
      const key = cx.P.key !== undefined ? asList(cx.P.key).map(str).join(',') : undefined;
      return [protect(cx, (sec as { plain: string }).plain, key)];
    },
    'export-clixml': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      const items = cx.input ?? asList(cx.P.inputobject);
      const objs = items.map((v, i) => {
        if (isObj(v) && (v as Obj).__type === 'credential') {
          const c = v as Obj;
          return `  <Obj RefId="${i}">\r\n    <TN RefId="${i}">\r\n      <T>System.Management.Automation.PSCredential</T>\r\n      <T>System.Object</T>\r\n    </TN>\r\n    <ToString>System.Management.Automation.PSCredential</ToString>\r\n    <Props>\r\n      <S N="UserName">${str(c.UserName)}</S>\r\n      <SS N="Password">${protect(cx, isSecure(c.Password) ? (c.Password as { plain: string }).plain : '')}</SS>\r\n    </Props>\r\n  </Obj>`;
        }
        return `  <Obj RefId="${i}">\r\n    <LabJson>${JSON.stringify(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</LabJson>\r\n  </Obj>`;
      });
      writeFile(cx.env.sys.fs, toVfs(cx.env, path), `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">\r\n${objs.join('\r\n')}\r\n</Objs>\r\n`, ROOT, cx.env.sys.now);
      return [];
    },
    'import-clixml': (cx) => {
      const path = str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]);
      let text: string;
      try {
        text = readFile(cx.env.sys.fs, toVfs(cx.env, path), ROOT);
      } catch {
        return fail(cx, `Could not find file '${toWin(toVfs(cx.env, path))}'.`, 'ItemNotFoundException', false);
      }
      const out: Value[] = [];
      for (const m of text.matchAll(/<Obj RefId="\d+">([\s\S]*?)<\/Obj>/g)) {
        const body = m[1];
        if (/PSCredential/.test(body)) {
          const user = /<S N="UserName">([^<]*)<\/S>/.exec(body)?.[1] ?? '';
          const enc = /<SS N="Password">([^<]*)<\/SS>/.exec(body)?.[1] ?? '';
          const plain = unprotect(cx, enc);
          if (plain === null) fail(cx, 'Key not valid for use in specified state. (The password was encrypted by a different user or on a different computer: Windows protects it with that account\'s keys.)', 'CryptographicException', false);
          out.push({ __type: 'credential', UserName: user, Password: { [SECURE]: true, plain: plain! } });
          continue;
        }
        const j = /<LabJson>([\s\S]*?)<\/LabJson>/.exec(body)?.[1];
        if (j) out.push(JSON.parse(j.replace(/&lt;/g, '<').replace(/&amp;/g, '&')) as Value);
      }
      return out;
    },
    'register-secretvault': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      const s = loadStore(cx);
      const name = str(cx.P.name ?? cx.pos[0]);
      const mod = str(cx.P.modulename ?? '');
      if (/secretstore/i.test(mod)) needModule(cx, 'Microsoft.PowerShell.SecretStore');
      if (cx.P.defaultvault) s.vaults.forEach((v) => (v.isDefault = false));
      s.vaults = [...s.vaults.filter((v) => v.name.toLowerCase() !== name.toLowerCase()), { name, module: mod, isDefault: !!cx.P.defaultvault || !s.vaults.length }];
      saveStore(cx, s);
      return [];
    },
    'get-secretvault': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      return loadStore(cx).vaults.map((v) => ({ __type: 'select', Name: v.name, ModuleName: v.module, IsDefaultVault: v.isDefault }));
    },
    'set-secretstoreconfiguration': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretStore');
      const s = loadStore(cx);
      if (cx.P.authentication !== undefined) s.config.authentication = /none/i.test(str(cx.P.authentication)) ? 'None' : 'Password';
      if (cx.P.interaction !== undefined) s.config.interaction = /none/i.test(str(cx.P.interaction)) ? 'None' : 'Prompt';
      saveStore(cx, s);
      return [];
    },
    'unlock-secretstore': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretStore');
      cx.env.vars.set('__storeunlocked', true);
      return [];
    },
    'set-secret': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      const s = loadStore(cx);
      storeReady(cx, s);
      const name = str(cx.P.name ?? cx.pos[0]);
      const v = cx.P.secret ?? cx.P.securestringsecret ?? cx.pos[1];
      if (isObj(v) && (v as Obj).__type === 'credential') s.secrets[name] = { type: 'PSCredential', user: str((v as Obj).UserName), value: protect(cx, isSecure((v as Obj).Password) ? ((v as Obj).Password as { plain: string }).plain : '') };
      else if (isSecure(v)) s.secrets[name] = { type: 'SecureString', value: protect(cx, (v as { plain: string }).plain) };
      else s.secrets[name] = { type: 'String', value: protect(cx, str(v)) };
      saveStore(cx, s);
      return [];
    },
    'get-secret': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      const s = loadStore(cx);
      storeReady(cx, s);
      const name = str(cx.P.name ?? cx.pos[0]);
      const rec = Object.entries(s.secrets).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      if (!rec) fail(cx, `Get-Secret : The secret ${name} was not found.`, 'ItemNotFoundException', false);
      const plain = unprotect(cx, rec!.value) ?? '';
      if (rec!.type === 'PSCredential') return [{ __type: 'credential', UserName: rec!.user, Password: { [SECURE]: true, plain } }];
      if (cx.P.asplaintext || rec!.type === 'String') return [plain];
      return [{ [SECURE]: true, plain }];
    },
    'get-secretinfo': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      const s = loadStore(cx);
      return Object.entries(s.secrets).map(([Name, r]) => ({ __type: 'select', Name, Type: r.type, VaultName: s.vaults.find((v) => v.isDefault)?.name ?? '' }));
    },
    'remove-secret': (cx) => {
      needModule(cx, 'Microsoft.PowerShell.SecretManagement');
      const s = loadStore(cx);
      delete s.secrets[str(cx.P.name ?? cx.pos[0])];
      saveStore(cx, s);
      return [];
    },

    /* archives and mail */
    'compress-archive': (cx) => {
      const dest = str(cx.P.destinationpath ?? cx.pos[1]);
      const destVfs = toVfs(cx.env, /\.zip$/i.test(dest) ? dest : dest + '.zip');
      if (lookup(cx.env.sys.fs, destVfs, ROOT) && !cx.P.force && !cx.P.update) fail(cx, `The archive file ${toWin(destVfs)} already exists. Use the -Update parameter to update the existing archive file or use the -Force parameter to overwrite the existing archive file.`, 'IOException', false);
      const entries: Array<{ path: string; content: string }> = [];
      for (const p of asList(cx.P.path ?? cx.P.literalpath ?? cx.pos[0])) {
        const base = toVfs(cx.env, str(p).replace(/\\\*$/, ''));
        const l = lookup(cx.env.sys.fs, base, ROOT);
        if (!l) fail(cx, `The path '${str(p)}' either does not exist or is not a valid file system path.`, 'ItemNotFoundException', false);
        const strip = /\\\*$/.test(str(p)) ? base : base.slice(0, base.lastIndexOf('/'));
        const walk = (q: string) => {
          const n = lookup(cx.env.sys.fs, q, ROOT)!;
          if (n.node.type === 'file') entries.push({ path: q.slice(strip.length + 1), content: n.node.content });
          else for (const e of listDir(cx.env.sys.fs, q, ROOT)) walk(`${q}/${e.name}`);
        };
        walk(base);
      }
      writeFile(cx.env.sys.fs, destVfs, '#CSLAB-ZIP\n' + JSON.stringify(entries), ROOT, cx.env.sys.now);
      return [];
    },
    'expand-archive': (cx) => {
      const src = toVfs(cx.env, str(cx.P.path ?? cx.P.literalpath ?? cx.pos[0]));
      const dest = toVfs(cx.env, str(cx.P.destinationpath ?? cx.pos[1] ?? '.'));
      let text: string;
      try {
        text = readFile(cx.env.sys.fs, src, ROOT);
      } catch {
        return fail(cx, `The path '${toWin(src)}' either does not exist or is not a valid file system path.`, 'ItemNotFoundException', false);
      }
      if (!text.startsWith('#CSLAB-ZIP\n')) fail(cx, `${toWin(src)} is not a supported archive file format.`, 'IOException', false);
      for (const e of JSON.parse(text.slice(11)) as Array<{ path: string; content: string }>) {
        const target = `${dest}/${e.path}`;
        if (lookup(cx.env.sys.fs, target, ROOT) && !cx.P.force) fail(cx, `Failed to create file '${toWin(target)}' while expanding the archive file '${toWin(src)}' contents as the file '${toWin(target)}' already exists. Use the -Force parameter if you want to overwrite the existing directory '${toWin(dest)}' contents when expanding the archive file.`, 'IOException', false);
        mkdir(cx.env.sys.fs, target.slice(0, target.lastIndexOf('/')), ROOT, cx.env.sys.now, true);
        writeFile(cx.env.sys.fs, target, e.content, ROOT, cx.env.sys.now);
      }
      return [];
    },
    'send-mailmessage': (cx) => {
      const to = asList(cx.P.to ?? cx.pos[0]).map(str);
      if (!to.length || cx.P.smtpserver === undefined && !getVariable(cx.env, 'PSEmailServer')) fail(cx, 'The SMTP server name has not been set. Use -SmtpServer or $PSEmailServer.', 'InvalidOperationException', false);
      const vfs = toVfs(cx.env, 'C:\\LabMail\\outbox.txt');
      let prev = '';
      try {
        prev = readFile(cx.env.sys.fs, vfs, ROOT);
      } catch {
        mkdir(cx.env.sys.fs, vfs.slice(0, vfs.lastIndexOf('/')), ROOT, cx.env.sys.now, true);
      }
      const attach = asList(cx.P.attachments).map(str);
      writeFile(cx.env.sys.fs, vfs, `${prev}From: ${str(cx.P.from)}\r\nTo: ${to.join(', ')}\r\nSubject: ${str(cx.P.subject ?? cx.pos[1])}\r\nDate: ${formatDate(cx.env.sys.now, 'r')}\r\nSmtpServer: ${str(cx.P.smtpserver ?? getVariable(cx.env, 'PSEmailServer'))}${attach.length ? `\r\nAttachments: ${attach.join(', ')}` : ''}\r\n\r\n${str(cx.P.body ?? cx.pos[2] ?? '')}\r\n.\r\n`, ROOT, cx.env.sys.now);
      return [];
    },
  },
  {
    'invoke-pester': 'Invoke-Pester [-Path] <file.Tests.ps1 | folder> [-Output Detailed] [-PassThru]',
    should: 'Should -Be <value> | -BeTrue | -BeNullOrEmpty | -Match <regex> | -Contain <item> | -HaveCount <n> | -Throw [-ExpectedMessage <text>] | -Invoke <command> -Times <n> [-Not]',
    mock: 'Mock <command> { <replacement> } [-ParameterFilter { $Name -eq "x" }]',
    'invoke-scriptanalyzer': 'Invoke-ScriptAnalyzer -Path <script.ps1 | folder> [-Recurse] [-Severity Error,Warning] [-ExcludeRule <rules>]',
    'invoke-restmethod': "Invoke-RestMethod -Uri <url> [-Method Get|Post|Put|Delete] [-Headers @{Authorization = \"Bearer $token\"}] [-Body ($obj | ConvertTo-Json)] [-ContentType 'application/json']",
    'register-scheduledtask': 'Register-ScheduledTask -TaskName <name> -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -File C:\\Scripts\\x.ps1") -Trigger (New-ScheduledTaskTrigger -Daily -At 2am) [-Principal (New-ScheduledTaskPrincipal -UserId SYSTEM -RunLevel Highest)]',
    'write-eventlog': 'Write-EventLog -LogName Application -Source <registered source> -EventId <n> -EntryType Information|Warning|Error -Message <text>',
    'get-ciminstance': "Get-CimInstance -ClassName Win32_LogicalDisk [-Filter \"DriveType=3\"]",
    'export-clixml': 'Get-Credential | Export-Clixml -Path <file>   ... later: $cred = Import-Clixml -Path <file>',
    'set-secret': 'Set-Secret -Name <name> -Secret <value|SecureString|PSCredential>   (Microsoft.PowerShell.SecretManagement)',
  },
  { gcim: 'get-ciminstance', gwmi: 'get-wmiobject', irm: 'invoke-restmethod', iwr: 'invoke-webrequest', curl: 'invoke-webrequest', wget: 'invoke-webrequest', gdr: 'get-psdrive' },
);

/* Process objects carry Name, CPU and WS as on Windows, besides the columns they display. */
const oldGetProcess = CMDLET_TABLE['get-process'];
register({
  'get-process': (cx) => {
    const want = cx.P.name ?? cx.pos[0];
    const list = oldGetProcess({ ...cx, P: { ...cx.P, name: undefined }, pos: [] }).map((p) => {
      const o = p as Obj;
      return { ...o, __extra: { Name: o.ProcessName, CPU: o['CPU(s)'], WS: Number(o['WS(MB)']) * 1048576, Handles: 200 + Number(o.Id) % 300 } };
    });
    if (want === undefined) return list;
    const hits = list.filter((o) => asList(want).some((w) => new RegExp('^' + str(w).replace(/\*/g, '.*') + '$', 'i').test(str((o as Obj).ProcessName))));
    if (!hits.length) fail(cx, `Cannot find a process with the name "${str(want)}". Verify the process name and call the cmdlet again.`, 'ProcessCommandException', false);
    return hits;
  },
});

/* ----------------------------------------------------------------------------- native tools */

registerNative({
  robocopy: (args, cx) => {
    const pos = args.filter((a) => !a.startsWith('/'));
    const opts = args.filter((a) => a.startsWith('/')).map((a) => a.toUpperCase());
    const [src, dst, ...patterns] = pos;
    if (!src || !dst) {
      exitCode(cx, 16);
      return ['', '-------------------------------------------------------------------------------', '   ROBOCOPY     ::     Robust File Copy for Windows', '-------------------------------------------------------------------------------', '', '              Usage :: ROBOCOPY source destination [file [file]...] [options]', '', 'ERROR : Invalid Parameter #1'];
    }
    const sVfs = toVfs(cx.env, src.replace(/\\$/, ''));
    const dVfs = toVfs(cx.env, dst.replace(/\\$/, ''));
    const sl = lookup(cx.env.sys.fs, sVfs, ROOT);
    if (!sl || sl.node.type !== 'dir') {
      exitCode(cx, 16);
      return [`${formatDate(cx.env.sys.now, 'yyyy/MM/dd HH:mm:ss')} ERROR 2 (0x00000002) Accessing Source Directory ${toWin(sVfs)}\\`, 'The system cannot find the file specified.'];
    }
    const mir = opts.includes('/MIR');
    const recurse = mir || opts.includes('/E') || opts.includes('/S');
    const purge = mir || opts.includes('/PURGE');
    const listOnly = opts.includes('/L');
    const xo = opts.includes('/XO');
    const mov = opts.includes('/MOV');
    const xf = (() => {
      const i = args.findIndex((a) => a.toUpperCase() === '/XF');
      if (i < 0) return [];
      const out: string[] = [];
      for (let k = i + 1; k < args.length && !args[k].startsWith('/'); k++) out.push(args[k]);
      return out;
    })();
    const xd = (() => {
      const i = args.findIndex((a) => a.toUpperCase() === '/XD');
      if (i < 0) return [];
      const out: string[] = [];
      for (let k = i + 1; k < args.length && !args[k].startsWith('/'); k++) out.push(args[k]);
      return out;
    })();
    const minAge = Number(/^\/MINAGE:(\d+)$/.exec(opts.find((o) => o.startsWith('/MINAGE:')) ?? '')?.[1] ?? 0);
    const logOpt = args.find((a) => /^\/LOG\+?:/i.test(a));
    const pats = (patterns.length ? patterns : ['*.*']).filter((p) => !xf.includes(p) && !xd.includes(p)).map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
    const wild = (list: string[]) => list.map((p) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));
    const xfRe = wild(xf);
    const xdRe = wild(xd);
    const lines: string[] = [];
    const stats = { dirs: [0, 0, 0, 0], files: [0, 0, 0, 0], bytes: [0, 0, 0, 0], extras: 0 };
    const visit = (sDir: string, dDir: string, top: boolean) => {
      stats.dirs[0]++;
      const dl = lookup(cx.env.sys.fs, dDir, ROOT);
      if (!dl) {
        stats.dirs[1]++;
        if (!listOnly) mkdir(cx.env.sys.fs, dDir, ROOT, cx.env.sys.now, true);
      } else if (!top) stats.dirs[2]++;
      const entries = listDir(cx.env.sys.fs, sDir, ROOT);
      lines.push(`\t                   ${entries.filter((e) => e.node.type === 'file').length}\t${toWin(sDir)}\\`);
      for (const e of entries) {
        if (e.node.type !== 'file') continue;
        if (!pats.some((r) => r.test(e.name)) || xfRe.some((r) => r.test(e.name))) continue;
        if (minAge && cx.env.sys.now - e.node.mtime < minAge * 86400000) continue;
        stats.files[0]++;
        stats.bytes[0] += e.node.content.length;
        const target = `${dDir}/${e.name}`;
        const tl = lookup(cx.env.sys.fs, target, ROOT);
        const same = tl && tl.node.type === 'file' && tl.node.content === e.node.content;
        const older = tl && tl.node.type === 'file' && xo && e.node.mtime <= tl.node.mtime;
        if (same || older) {
          stats.files[2]++;
          stats.bytes[2] += e.node.content.length;
          continue;
        }
        lines.push(`\t    ${tl ? 'Newer   ' : 'New File'}  \t\t${String(e.node.content.length).padStart(8)}\t${e.name}`);
        stats.files[1]++;
        stats.bytes[1] += e.node.content.length;
        if (!listOnly) {
          writeFile(cx.env.sys.fs, target, e.node.content, ROOT, e.node.mtime);
          if (mov) {
            const sNode = lookup(cx.env.sys.fs, `${sDir}/${e.name}`, ROOT);
            if (sNode) delete (lookup(cx.env.sys.fs, sDir, ROOT)!.node as { children: Record<string, unknown> }).children[e.name];
          }
        }
      }
      if (purge && lookup(cx.env.sys.fs, dDir, ROOT)) {
        for (const e of listDir(cx.env.sys.fs, dDir, ROOT)) {
          const inSrc = lookup(cx.env.sys.fs, `${sDir}/${e.name}`, ROOT);
          if (inSrc) continue;
          if (e.node.type === 'file' && xfRe.some((r) => r.test(e.name))) continue;
          stats.extras++;
          lines.push(`\t    *EXTRA ${e.node.type === 'dir' ? 'Dir ' : 'File'}  \t\t${e.node.type === 'file' ? String(e.node.content.length).padStart(8) : ''}\t${e.name}`);
          if (!listOnly) delete (lookup(cx.env.sys.fs, dDir, ROOT)!.node as { children: Record<string, unknown> }).children[e.name];
        }
      }
      if (recurse) for (const e of entries) if (e.node.type === 'dir' && !xdRe.some((r) => r.test(e.name))) visit(`${sDir}/${e.name}`, `${dDir}/${e.name}`, false);
    };
    visit(sVfs, dVfs, true);
    const code = (stats.files[1] ? 1 : 0) | (stats.extras ? 2 : 0);
    exitCode(cx, code);
    const when = formatDate(cx.env.sys.now, 'dddd, dd MMMM yyyy HH:mm:ss');
    const row = (label: string, v: number[], extra: number) => `${label.padStart(10)} :${v.map((x) => String(x).padStart(10)).join('')}${'0'.padStart(10)}${String(extra).padStart(10)}`;
    const out = ['', '-------------------------------------------------------------------------------', '   ROBOCOPY     ::     Robust File Copy for Windows', '-------------------------------------------------------------------------------', '', `  Started : ${when}`, `   Source : ${toWin(sVfs)}\\`, `     Dest : ${toWin(dVfs)}\\`, '', `    Files : ${(patterns.length ? patterns : ['*.*']).join(' ')}`, '', `  Options : ${[...(patterns.length ? [] : ['*.*']), ...opts].join(' ')} /DCOPY:DA /COPY:DAT /R:1000000 /W:30`, '', '------------------------------------------------------------------------------', '', ...lines, '', '------------------------------------------------------------------------------', '', '               Total    Copied   Skipped  Mismatch    FAILED    Extras', row('Dirs', [stats.dirs[0], stats.dirs[1], stats.dirs[0] - stats.dirs[1]], 0), row('Files', [stats.files[0], stats.files[1], stats.files[2]], stats.extras), row('Bytes', [stats.bytes[0], stats.bytes[1], stats.bytes[2]], 0), `   Ended : ${when}`, ''];
    if (logOpt) {
      const m = /^\/LOG(\+?):(.+)$/i.exec(logOpt)!;
      const vfs = toVfs(cx.env, m[2]);
      let prev = '';
      if (m[1]) {
        try {
          prev = readFile(cx.env.sys.fs, vfs, ROOT);
        } catch {
          /* new log */
        }
      }
      writeFile(cx.env.sys.fs, vfs, prev + out.join('\r\n') + '\r\n', ROOT, cx.env.sys.now);
      return [`\n Log File : ${toWin(vfs)}`];
    }
    return out;
  },
  winget: (args, cx) => {
    const m = machine(cx.env);
    const sub = (args[0] ?? '').toLowerCase();
    const id = flag(args, '--id', '-q', '--query') ?? args.slice(1).find((a) => !a.startsWith('-'));
    const installed = apps(m);
    const agreed = args.includes('--accept-source-agreements') || (m as Machine & { wingetAgreed?: boolean }).wingetAgreed;
    const needAgreement = (): string[] | null => {
      if (agreed) {
        (m as Machine & { wingetAgreed?: boolean }).wingetAgreed = true;
        cx.env.dirtyEst = true;
        return null;
      }
      exitCode(cx, -1978335212);
      return ["The `msstore` source requires that you view the following agreements before using.", 'Terms of Transaction: https://aka.ms/microsoft-store-terms-of-transaction', 'Do you agree to all the source agreements terms?', '[Y] Yes  [N] No: ', '(This terminal cannot answer prompts. Unattended installs need --accept-source-agreements --accept-package-agreements.)'];
    };
    const table = (rows: string[][], head: string[]) => {
      const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      return [head.map((h, i) => h.padEnd(w[i])).join(' '), '-'.repeat(w.reduce((a, b) => a + b + 1, -1)), ...rows.map((r) => r.map((c, i) => c.padEnd(w[i])).join(' ').trimEnd())];
    };
    if (sub === '--version' || sub === '-v') return ['v1.8.1911'];
    if (sub === 'search') {
      const q = (id ?? '').toLowerCase();
      const hits = CATALOG.filter((p) => p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      if (!hits.length) {
        exitCode(cx, -1978335212);
        return ['No package found matching input criteria.'];
      }
      return table(hits.map((p) => [p.name, p.id, p.version, 'winget']), ['Name', 'Id', 'Version', 'Source']);
    }
    if (sub === 'list') {
      const rows = installed.filter((a) => !id || a.id.toLowerCase().includes(id.toLowerCase())).map((a) => {
        const p = findPkg(a.id)!;
        return [p.name, p.id, a.version, p.version !== a.version ? p.version : '', 'winget'];
      });
      return table(rows, ['Name', 'Id', 'Version', 'Available', 'Source']);
    }
    if (sub === 'show') {
      const p = id ? findPkg(id) : undefined;
      if (!p) {
        exitCode(cx, -1978335212);
        return ['No package found matching input criteria.'];
      }
      return [`Found ${p.name} [${p.id}]`, `Version: ${p.version}`, 'Publisher: ' + p.id.split('.')[0], `Installer Type: exe`];
    }
    if (sub === 'install') {
      const a = needAgreement();
      if (a) return a;
      const p = id ? findPkg(id) : undefined;
      if (!p) {
        exitCode(cx, -1978335212);
        return ['No package found matching input criteria.'];
      }
      const version = flag(args, '--version', '-v') ?? p.version;
      if (installed.some((x) => x.id === p.id)) {
        exitCode(cx, -1978335189);
        return ['Found an existing package already installed. Trying to upgrade the installed package...', 'No available upgrade found.', 'No newer package versions are available from the configured sources.'];
      }
      installed.push({ id: p.id, version });
      cx.env.dirtyEst = true;
      return [`Found ${p.name} [${p.id}] Version ${version}`, 'This application is licensed to you by its owner.', 'Microsoft is not responsible for, nor does it grant any licenses to, third-party packages.', `Downloading https://example.invalid/${p.choco}-${version}.exe`, '  ██████████████████████████████  100%', 'Successfully verified installer hash', 'Starting package install...', 'Successfully installed'];
    }
    if (sub === 'upgrade') {
      const all = args.includes('--all') || args.includes('-r') || args.includes('--recurse');
      const list = installed.filter((x) => findPkg(x.id)!.version !== x.version && !x.pinned);
      const held = installed.filter((x) => findPkg(x.id)!.version !== x.version && x.pinned).length;
      const pinNote = held ? [`${held} package(s) have pins that prevent upgrade. Use the 'winget pin' command to view and edit pins. Using the --include-pinned argument may show more results.`] : [];
      if (!id && !all) return [...table(list.map((x) => [findPkg(x.id)!.name, x.id, x.version, findPkg(x.id)!.version, 'winget']), ['Name', 'Id', 'Version', 'Available', 'Source']), `${list.length} upgrades available.`, ...pinNote];
      const a = needAgreement();
      if (a) return a;
      const targets = all ? list : installed.filter((x) => x.id.toLowerCase() === findPkg(id!)?.id.toLowerCase());
      if (!targets.length) return all ? ['No installed package found matching input criteria.', ...pinNote] : ['No installed package found matching input criteria.'];
      const out: string[] = [];
      for (const t of targets) {
        if (t.pinned) {
          out.push(`${t.id} is pinned and was not upgraded.`);
          continue;
        }
        t.version = findPkg(t.id)!.version;
        out.push(`Found ${findPkg(t.id)!.name} [${t.id}] Version ${t.version}`, 'Successfully installed');
      }
      cx.env.dirtyEst = true;
      return out;
    }
    if (sub === 'uninstall') {
      const p = id ? findPkg(id) : undefined;
      const i = p ? installed.findIndex((x) => x.id === p.id) : -1;
      if (i < 0) {
        exitCode(cx, -1978335212);
        return ['No installed package found matching input criteria.'];
      }
      installed.splice(i, 1);
      cx.env.dirtyEst = true;
      return [`Found ${p!.name} [${p!.id}]`, 'Starting package uninstall...', 'Successfully uninstalled'];
    }
    if (sub === 'pin') {
      const action = (args[1] ?? '').toLowerCase();
      if (action === 'list') return table(installed.filter((x) => x.pinned).map((x) => [findPkg(x.id)!.name, x.id, x.version, 'winget', 'Pinning']), ['Name', 'Id', 'Version', 'Source', 'Pin type']);
      const p = id ? findPkg(id) : undefined;
      const t = p ? installed.find((x) => x.id === p.id) : undefined;
      if (!t) return ['No installed package found matching input criteria.'];
      t.pinned = action === 'add';
      cx.env.dirtyEst = true;
      return [action === 'add' ? 'Pin added successfully.' : 'Pin removed successfully.'];
    }
    if (sub === 'export') {
      const out = flag(args, '-o', '--output');
      if (!out) return ['winget export -o <file.json>'];
      writeFile(cx.env.sys.fs, toVfs(cx.env, out), JSON.stringify({ $schema: 'https://aka.ms/winget-packages.schema.2.0.json', Sources: [{ Packages: installed.map((x) => ({ PackageIdentifier: x.id, Version: x.version })), SourceDetails: { Name: 'winget' } }] }, null, 2), ROOT, cx.env.sys.now);
      return [`Installed package is being exported to ${out}`];
    }
    if (sub === 'import') {
      const a = needAgreement();
      if (a) return a;
      const file = flag(args, '-i', '--import-file');
      if (!file) return ['winget import -i <file.json>'];
      const data = JSON.parse(readFile(cx.env.sys.fs, toVfs(cx.env, file), ROOT)) as { Sources: Array<{ Packages: Array<{ PackageIdentifier: string; Version?: string }> }> };
      const out: string[] = [];
      for (const pk of data.Sources.flatMap((s) => s.Packages)) {
        const p = findPkg(pk.PackageIdentifier);
        if (!p) {
          out.push(`Package not found: ${pk.PackageIdentifier}`);
          continue;
        }
        if (installed.some((x) => x.id === p.id)) {
          out.push(`Package is already installed: ${p.id}`);
          continue;
        }
        installed.push({ id: p.id, version: pk.Version ?? p.version });
        out.push(`Successfully installed ${p.id}`);
      }
      cx.env.dirtyEst = true;
      return out;
    }
    return ['Windows Package Manager v1.8.1911', 'usage: winget  [<command>] [<options>]', '', 'The following commands are available:', '  install    Installs the given package', '  list       Display installed packages', '  upgrade    Shows and performs available upgrades', '  uninstall  Uninstalls the given package', '  search     Find and show basic info of packages', '  show       Shows information about a package', '  pin        Manage package pins', '  export     Exports a list of the installed packages', '  import     Installs all the packages in a file'];
  },
  choco: (args, cx) => {
    const m = machine(cx.env);
    const sub = (args[0] ?? '').toLowerCase();
    // Options that take a value (--version 2.45.0, --source x, -n=git) are not package names.
    const VALUED = /^(--version|--source|-s|--params|--package-parameters|--name|-n|--timeout|--execution-timeout)$/i;
    const names = args.slice(1).filter((a, i, all) => !a.startsWith('-') && !VALUED.test(all[i] ?? '') && !VALUED.test(args.slice(1)[i - 1] ?? ''));
    const versionArg = (() => {
      const eq = args.find((a) => /^--version=/i.test(a));
      if (eq) return eq.slice(10);
      const i = args.findIndex((a) => /^--version$/i.test(a));
      return i >= 0 ? args[i + 1] : undefined;
    })();
    const yes = args.some((a) => /^(-y|--yes|--confirm|-confirm)$/i.test(a));
    const installed = apps(m);
    const prompt = () => {
      exitCode(cx, 1);
      return [`Do you want to run the script?([Y]es/[A]ll - yes to all/[N]o/[P]rint): `, '(This terminal cannot answer prompts: add -y for unattended installs.)'];
    };
    if (sub === '--version' || sub === '-v') return ['2.3.0'];
    if (sub === 'list') return ['Chocolatey v2.3.0', ...installed.map((x) => `${findPkg(x.id)!.choco} ${x.version}`), `${installed.length} packages installed.`];
    if (sub === 'outdated') {
      const list = installed.filter((x) => findPkg(x.id)!.version !== x.version);
      return ['Chocolatey v2.3.0', 'Outdated Packages', ' Output is package name | current version | available version | pinned?', '', ...list.map((x) => `${findPkg(x.id)!.choco}|${x.version}|${findPkg(x.id)!.version}|${x.pinned ? 'true' : 'false'}`), '', `Chocolatey has determined ${list.length} package(s) are outdated.`];
    }
    if (sub === 'search' || sub === 'find') return ['Chocolatey v2.3.0', ...CATALOG.filter((p) => p.choco.includes((names[0] ?? '').toLowerCase())).map((p) => `${p.choco} ${p.version} [Approved]`)];
    if (sub === 'install') {
      if (!yes) return prompt();
      const out = ['Chocolatey v2.3.0', `Installing the following packages:`, names.join(';')];
      let failed = 0;
      for (const n of names) {
        const p = findPkg(n);
        if (!p) {
          out.push(`${n} not installed. The package was not found with the source(s) listed.`);
          failed++;
          continue;
        }
        const version = versionArg ?? p.version;
        if (installed.some((x) => x.id === p.id)) {
          out.push(`${p.choco} v${installed.find((x) => x.id === p.id)!.version} already installed.`, ' Use --force to reinstall, specify a version to install, or try upgrade.');
          continue;
        }
        installed.push({ id: p.id, version });
        out.push(`${p.choco} v${version} [Approved]`, ` The install of ${p.choco} was successful.`);
      }
      out.push('', `Chocolatey installed ${names.length - failed}/${names.length} packages.`);
      exitCode(cx, failed ? 1 : 0);
      cx.env.dirtyEst = true;
      return out;
    }
    if (sub === 'upgrade') {
      if (!yes) return prompt();
      const targets = names[0] === 'all' ? installed : installed.filter((x) => names.some((n) => findPkg(n)?.id === x.id));
      const out = ['Chocolatey v2.3.0', 'Upgrading the following packages:', names.join(';')];
      for (const t of targets) {
        const p = findPkg(t.id)!;
        if (t.pinned) out.push(`${p.choco} is pinned. Skipping pinned package.`);
        else if (t.version === p.version) out.push(`${p.choco} v${t.version} is the latest version available based on your source(s).`);
        else {
          out.push(`You have ${p.choco} v${t.version} installed. Version ${p.version} is available based on your source(s).`, ` The upgrade of ${p.choco} was successful.`);
          t.version = p.version;
        }
      }
      cx.env.dirtyEst = true;
      return out;
    }
    if (sub === 'uninstall') {
      if (!yes) return prompt();
      for (const n of names) {
        const p = findPkg(n);
        const i = p ? installed.findIndex((x) => x.id === p.id) : -1;
        if (i >= 0) installed.splice(i, 1);
      }
      cx.env.dirtyEst = true;
      return ['Chocolatey v2.3.0', ...names.map((n) => ` ${n} has been successfully uninstalled.`)];
    }
    if (sub === 'pin') {
      const action = (args[1] ?? 'list').toLowerCase();
      const name = (args.find((a) => /^(-n=|--name=)/.test(a)) ?? '').replace(/^(-n=|--name=)/, '') || args[args.indexOf('-n') + 1];
      if (action === 'list') return ['Chocolatey v2.3.0', ...installed.filter((x) => x.pinned).map((x) => `${findPkg(x.id)!.choco}|${x.version}`)];
      const p = name ? findPkg(name) : undefined;
      const t = p ? installed.find((x) => x.id === p.id) : undefined;
      if (!t) return [`Unable to find package named '${name ?? ''}' to pin. Make sure it is installed.`];
      t.pinned = action === 'add';
      cx.env.dirtyEst = true;
      return [`Successfully ${action === 'add' ? 'added a pin for' : 'removed a pin for'} ${p!.choco} v${t.version}.`];
    }
    return ['Chocolatey v2.3.0', 'Please run \'choco -?\' or \'choco <command> -?\' for help menu.'];
  },
  schtasks: (args, cx) => {
    const m = machine(cx.env);
    const opt = (k: string) => {
      const i = args.findIndex((a) => a.toUpperCase() === k);
      return i >= 0 ? args[i + 1] : undefined;
    };
    if (args.some((a) => /^\/create$/i.test(a))) {
      const name = opt('/TN') ?? '';
      const tr = opt('/TR') ?? '';
      const sc = (opt('/SC') ?? 'ONCE').toUpperCase();
      const st = opt('/ST') ?? '00:00';
      if (m.tasks.some((t) => t.name.toLowerCase() === name.toLowerCase()) && !args.some((a) => /^\/f$/i.test(a))) {
        exitCode(cx, 1);
        return [`ERROR: Cannot create a file when that file already exists.`];
      }
      const trigger = sc === 'DAILY' ? `Daily at ${st}` : sc === 'WEEKLY' ? `Weekly on ${opt('/D') ?? 'MON'} at ${st}` : sc === 'ONSTART' ? 'At startup' : sc === 'ONLOGON' ? 'At log on' : sc === 'MINUTE' || sc === 'HOURLY' ? `Every ${opt('/MO') ?? 1} ${sc === 'MINUTE' ? 'minute(s)' : 'hour(s)'}` : `Once at ${st}`;
      const exe = tr.split(/\s+/)[0];
      m.tasks = m.tasks.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
      m.tasks.push({ name, action: tr, trigger, user: opt('/RU') ?? 'SYSTEM', enabled: true, execute: exe, argument: tr.slice(exe.length).trim(), runLevel: /highest/i.test(opt('/RL') ?? '') ? 'Highest' : 'Limited' } as Task);
      cx.env.dirtyEst = true;
      return [`SUCCESS: The scheduled task "${name}" has successfully been created.`];
    }
    if (args.some((a) => /^\/delete$/i.test(a))) {
      const name = opt('/TN') ?? '';
      if (!m.tasks.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        exitCode(cx, 1);
        return ['ERROR: The system cannot find the file specified.'];
      }
      m.tasks = m.tasks.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
      cx.env.dirtyEst = true;
      return [`SUCCESS: The scheduled task "${name}" was successfully deleted.`];
    }
    if (args.some((a) => /^\/run$/i.test(a))) {
      const name = opt('/TN') ?? '';
      const t = m.tasks.find((x) => `${(x as Task).path ?? '\\'}${x.name}`.toLowerCase() === (name.startsWith('\\') ? name : '\\' + name).toLowerCase()) as Task | undefined;
      if (!t) {
        exitCode(cx, 1);
        return ['ERROR: The system cannot find the file specified.'];
      }
      runTask({ env: cx.env, call: { name: 'schtasks', positional: [], params: {} }, name: 'schtasks', P: {}, pos: [], input: undefined, fail: cx.fail, run: cx.run, print: cx.print }, t);
      return [`SUCCESS: Attempted to run the scheduled task "${t.name}".`];
    }
    if (args.some((a) => /^\/change$/i.test(a))) {
      const t = m.tasks.find((x) => x.name.toLowerCase() === (opt('/TN') ?? '').toLowerCase());
      if (!t) return ['ERROR: The system cannot find the file specified.'];
      if (args.some((a) => /^\/disable$/i.test(a))) t.enabled = false;
      if (args.some((a) => /^\/enable$/i.test(a))) t.enabled = true;
      cx.env.dirtyEst = true;
      return [`SUCCESS: The parameters of scheduled task "${t.name}" have been changed.`];
    }
    const name = opt('/TN');
    const full = (t: Machine['tasks'][number]) => `${(t as Task).path ?? '\\'}${t.name}`;
    const list = m.tasks.filter((t) => !name || full(t).toLowerCase() === (name.startsWith('\\') ? name : '\\' + name).toLowerCase());
    if (args.some((a) => /^\/v$/i.test(a)) || /list/i.test(opt('/FO') ?? '')) return list.flatMap((t) => [`Folder: ${((t as Task).path ?? '\\').replace(/(.)\\$/, '$1')}`, `HostName:                             ${m.name}`, `TaskName:                             ${full(t)}`, `Next Run Time:                        N/A`, `Status:                               ${t.enabled ? 'Ready' : 'Disabled'}`, `Last Run Time:                        ${(t as Task).lastRun ? formatDate((t as Task).lastRun!, 'dd/MM/yyyy HH:mm:ss') : 'N/A'}`, `Last Result:                          ${(t as Task).lastResult ?? 267011}`, `Task To Run:                          ${t.action}`, `Run As User:                          ${t.user}`, `Schedule Type:                        ${t.trigger}`, '']);
    return ['', 'Folder: \\', 'TaskName                                 Next Run Time          Status', '======================================== ====================== ===============', ...list.map((t) => `${t.name.padEnd(40)} ${'N/A'.padEnd(22)} ${t.enabled ? 'Ready' : 'Disabled'}`)];
  },
});

export { render, hostWrite, truthy, Parser };

canonical(['Describe', 'Context', 'It', 'BeforeAll', 'BeforeEach', 'AfterEach', 'AfterAll', 'Should', 'Mock', 'Assert-MockCalled', 'Invoke-Pester', 'Invoke-ScriptAnalyzer', 'Get-ScriptAnalyzerRule', 'Invoke-RestMethod', 'Invoke-WebRequest', 'Get-CimInstance', 'Get-WmiObject', 'Get-PSDrive', 'New-SelfSignedCertificate', 'New-ScheduledTaskAction', 'New-ScheduledTaskTrigger', 'New-ScheduledTaskPrincipal', 'New-ScheduledTaskSettingsSet', 'Register-ScheduledTask', 'Get-ScheduledTask', 'Get-ScheduledTaskInfo', 'Start-ScheduledTask', 'Enable-ScheduledTask', 'Disable-ScheduledTask', 'Set-ScheduledTask', 'Unregister-ScheduledTask', 'New-EventLog', 'Write-EventLog', 'Get-EventLog', 'Get-WinEvent', 'ConvertTo-SecureString', 'ConvertFrom-SecureString', 'Export-Clixml', 'Import-Clixml', 'Register-SecretVault', 'Get-SecretVault', 'Set-SecretStoreConfiguration', 'Unlock-SecretStore', 'Set-Secret', 'Get-Secret', 'Get-SecretInfo', 'Remove-Secret', 'Compress-Archive', 'Expand-Archive', 'Send-MailMessage', 'Get-Process', 'Stop-Process', 'Get-Service', 'Start-Service', 'Stop-Service', 'Restart-Service', 'Set-Service', 'New-Item', 'Remove-Item', 'Copy-Item', 'Move-Item', 'Rename-Item', 'Get-Acl', 'Set-Acl', 'Get-Credential', 'Get-Location', 'Set-Location', 'Clear-Host', 'Invoke-Command', 'Enter-PSSession', 'Exit-PSSession']);
