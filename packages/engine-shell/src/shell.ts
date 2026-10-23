/**
 * A bash-subset interpreter over the simulated system: quoting, pipes, redirections,
 * here documents, variables and parameter expansion, command substitution, arithmetic,
 * globbing, if/for/while/until, functions, set -e, and scripts.
 */

import { FsError, glob as fsGlob, lookup, readFile, resolvePath, setUmask, writeFile, can } from './fs.js';
import { actorFor, commandAvailable, homeOf, syncEtc, type ShellSystem } from './system.js';
import { COMMANDS, type IO } from './commands.js';

/* ------------------------------------------------------------------ tokens */

export interface Part {
  s: string;
  q: 'n' | 's' | 'd';
}
export type Word = Part[];
interface HereDoc {
  body: string;
  quoted: boolean;
}
type Tok = { t: 'word'; w: Word; line: number } | { t: 'op'; v: string; line: number; heredoc?: HereDoc; body?: string } | { t: 'nl'; line: number } | { t: 'eof'; line: number };

const OPS3 = ['2>&1', '<<-', '&>>'];
const OPS2 = ['||', '&&', '>>', '<<', '2>', '&>', '>&', '((', ';;'];
const OPS1 = ['|', '&', ';', '(', ')', '<', '>'];

export class ShellSyntaxError extends Error {}

/**
 * True when the input opens a here document whose closing delimiter has not been typed yet.
 * The tokenizer accepts an unterminated here document (as bash does at the end of a script), so
 * an interactive terminal uses this to keep reading lines instead.
 */
export function awaitsHeredoc(src: string): boolean {
  const open: Array<{ delim: string; strip: boolean }> = [];
  const re = /<<(-?)\s*(['"]?)([A-Za-z_][\w]*)\2/g;
  for (const line of src.split('\n')) {
    if (open.length) {
      const cmp = open[0].strip ? line.replace(/^\t+/, '') : line;
      if (cmp === open[0].delim) open.shift();
      continue;
    }
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      if (line[m.index - 1] === '<') continue; // a <<< here-string
      open.push({ delim: m[3], strip: m[1] === '-' });
    }
  }
  return open.length > 0;
}

export function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let pending: Array<{ tok: Extract<Tok, { t: 'op' }>; delim: string; quoted: boolean; strip: boolean }> = [];
  const atWordStart = () => {
    const last = toks[toks.length - 1];
    return !last || last.t !== 'word' || true;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      toks.push({ t: 'nl', line });
      i++;
      line++;
      if (pending.length) {
        for (const h of pending) {
          const lines: string[] = [];
          for (;;) {
            if (i >= src.length) break;
            let end = src.indexOf('\n', i);
            if (end === -1) end = src.length;
            const l = src.slice(i, end);
            i = Math.min(end + 1, src.length);
            line++;
            const cmp = h.strip ? l.replace(/^\t+/, '') : l;
            if (cmp === h.delim) break;
            lines.push(h.strip ? l.replace(/^\t+/, '') : l);
          }
          h.tok.heredoc = { body: lines.length ? lines.join('\n') + '\n' : '', quoted: h.quoted };
        }
        pending = [];
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (ch === '#' && atWordStart()) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    // (( arithmetic ))
    if (src.startsWith('((', i)) {
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (src[j] === ')' && src[j - 1] === ')') {
        // j is the outer ')', j-1 the inner one: the body sits between "((" and "))".
        toks.push({ t: 'op', v: '((', line, body: src.slice(i + 2, j - 1) });
        i = j + 1;
        continue;
      }
    }
    const op = OPS3.find((o) => src.startsWith(o, i)) ?? OPS2.find((o) => src.startsWith(o, i)) ?? OPS1.find((o) => src.startsWith(o, i));
    if (op && !(op === '2>' && toks[toks.length - 1]?.t === 'word' && !/\s/.test(src[i - 1] ?? ' '))) {
      if (op === '(' || op === ')') {
        toks.push({ t: 'op', v: op, line });
        i += 1;
        continue;
      }
      const tok: Extract<Tok, { t: 'op' }> = { t: 'op', v: op, line };
      toks.push(tok);
      i += op.length;
      if (op === '<<' || op === '<<-') {
        // read the delimiter word
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        let quoted = false;
        if (src[i] === "'" || src[i] === '"') {
          const q = src[i++];
          while (i < src.length && src[i] !== q) delim += src[i++];
          i++;
          quoted = true;
        } else {
          while (i < src.length && !/[\s;|&<>]/.test(src[i])) {
            if (src[i] === '\\') {
              quoted = true;
              i++;
            }
            delim += src[i++];
          }
        }
        pending.push({ tok, delim, quoted, strip: op === '<<-' });
      }
      continue;
    }
    // A word.
    const parts: Part[] = [];
    let cur = '';
    const flush = () => {
      if (cur) parts.push({ s: cur, q: 'n' });
      cur = '';
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\n' || c === ' ' || c === '\t' || c === '\r') break;
      if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '<' || c === '>') break;
      if (c === "'") {
        flush();
        let j = i + 1;
        let s = '';
        while (j < src.length && src[j] !== "'") {
          if (src[j] === '\n') line++;
          s += src[j++];
        }
        if (j >= src.length) throw new ShellSyntaxError('unexpected EOF while looking for matching `\'\'');
        parts.push({ s, q: 's' });
        i = j + 1;
        continue;
      }
      if (c === '"') {
        flush();
        let j = i + 1;
        let s = '';
        while (j < src.length && src[j] !== '"') {
          if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1])) {
            if (src[j + 1] === '\n') {
              j += 2;
              continue;
            }
            s += '\u0001' + src[j + 1]; // escaped literal marker
            j += 2;
            continue;
          }
          if (src[j] === '$' && src[j + 1] === '(') {
            const end = matchParen(src, j + 1);
            s += src.slice(j, end + 1);
            j = end + 1;
            continue;
          }
          if (src[j] === '`') {
            const end = src.indexOf('`', j + 1);
            if (end === -1) throw new ShellSyntaxError('unexpected EOF while looking for matching ``\'');
            s += src.slice(j, end + 1);
            j = end + 1;
            continue;
          }
          if (src[j] === '\n') line++;
          s += src[j++];
        }
        if (j >= src.length) throw new ShellSyntaxError('unexpected EOF while looking for matching `"\'');
        parts.push({ s, q: 'd' });
        i = j + 1;
        continue;
      }
      if (c === '\\') {
        flush();
        if (i + 1 < src.length) parts.push({ s: src[i + 1], q: 's' });
        i += 2;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') {
        const end = matchParen(src, i + 1);
        cur += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        const end = src.indexOf('}', i);
        if (end === -1) throw new ShellSyntaxError('bad substitution');
        cur += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (c === '`') {
        const end = src.indexOf('`', i + 1);
        if (end === -1) throw new ShellSyntaxError('unexpected EOF while looking for matching ``\'');
        cur += src.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      cur += c;
      i++;
    }
    flush();
    toks.push({ t: 'word', w: parts, line });
  }
  toks.push({ t: 'nl', line });
  if (pending.length) for (const h of pending) h.tok.heredoc = { body: '', quoted: h.quoted };
  toks.push({ t: 'eof', line });
  return toks;
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  let inS = false;
  let inD = false;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (inS) {
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === '\\') j++;
      else if (c === '"') inD = false;
      continue;
    }
    if (c === "'") inS = true;
    else if (c === '"') inD = true;
    else if (c === '\\') j++;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new ShellSyntaxError('unexpected EOF while looking for matching `)\'');
}

/* ------------------------------------------------------------------ AST */

export interface Redir {
  fd: 0 | 1 | 2 | 3; // 3 = both (&>)
  op: '>' | '>>' | '<' | '<<' | '>&';
  target?: Word;
  heredoc?: HereDoc;
}
export type Node =
  | { t: 'simple'; words: Word[]; redirs: Redir[]; assigns: Array<{ name: string; value: Word }>; line: number }
  | { t: 'pipeline'; cmds: Node[]; negate: boolean }
  | { t: 'andor'; left: Node; op: '&&' | '||'; right: Node }
  | { t: 'list'; items: Node[] }
  | { t: 'if'; branches: Array<{ cond: Node; body: Node }>; else?: Node }
  | { t: 'for'; name: string; words?: Word[]; body: Node }
  | { t: 'cfor'; init: string; cond: string; step: string; body: Node }
  | { t: 'while'; cond: Node; body: Node; until: boolean }
  | { t: 'case'; word: Word; items: Array<{ patterns: Word[]; body: Node }> }
  | { t: 'func'; name: string; body: Node }
  | { t: 'group'; body: Node; sub: boolean; redirs: Redir[] }
  | { t: 'arith'; expr: string };

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', '{', '}', '!']);

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok {
    return this.toks[this.i];
  }
  next(): Tok {
    return this.toks[this.i++];
  }
  isWord(s: string, t: Tok = this.peek()): boolean {
    return t.t === 'word' && t.w.length === 1 && t.w[0].q === 'n' && t.w[0].s === s;
  }
  isOp(s: string, t: Tok = this.peek()): boolean {
    return t.t === 'op' && t.v === s;
  }
  skipNl(): void {
    while (this.peek().t === 'nl' || this.isOp(';')) this.next();
  }
  expectWord(s: string): void {
    if (!this.isWord(s)) throw new ShellSyntaxError(`syntax error near line ${this.peek().line}: expected '${s}'`);
    this.next();
  }
  wordText(t: Tok): string | null {
    return t.t === 'word' && t.w.every((p) => p.q === 'n') ? t.w.map((p) => p.s).join('') : null;
  }

  parseScript(): Node {
    const list = this.parseList(new Set());
    if (this.peek().t !== 'eof') throw new ShellSyntaxError(`syntax error near unexpected token '${describe(this.peek())}' (line ${this.peek().line})`);
    return list;
  }

  parseList(stop: Set<string>): Node {
    const items: Node[] = [];
    for (;;) {
      this.skipNl();
      const t = this.peek();
      if (t.t === 'eof') break;
      if (t.t === 'word' && stop.has(this.wordText(t) ?? '')) break;
      if (this.isOp(')') || this.isOp(';;')) break;
      items.push(this.parseAndOr());
      const s = this.peek();
      if (s.t === 'nl' || this.isOp(';') || this.isOp('&')) {
        this.next();
        continue;
      }
      if (s.t === 'eof' || (s.t === 'word' && stop.has(this.wordText(s) ?? '')) || this.isOp(')') || this.isOp(';;')) break;
      throw new ShellSyntaxError(`syntax error near unexpected token '${describe(s)}' (line ${s.line})`);
    }
    return items.length === 1 ? items[0] : { t: 'list', items };
  }

  parseAndOr(): Node {
    let left = this.parsePipeline();
    while (this.isOp('&&') || this.isOp('||')) {
      const op = (this.next() as Extract<Tok, { t: 'op' }>).v as '&&' | '||';
      while (this.peek().t === 'nl') this.next();
      const right = this.parsePipeline();
      left = { t: 'andor', left, op, right };
    }
    return left;
  }

  parsePipeline(): Node {
    let negate = false;
    if (this.isWord('!')) {
      this.next();
      negate = true;
    }
    const cmds = [this.parseCommand()];
    while (this.isOp('|')) {
      this.next();
      while (this.peek().t === 'nl') this.next();
      cmds.push(this.parseCommand());
    }
    return cmds.length === 1 && !negate ? cmds[0] : { t: 'pipeline', cmds, negate };
  }

  parseCommand(): Node {
    const t = this.peek();
    if (t.t === 'op' && t.v === '((') {
      this.next();
      return { t: 'arith', expr: t.body ?? '' };
    }
    if (this.isOp('(')) {
      this.next();
      const body = this.parseList(new Set());
      if (!this.isOp(')')) throw new ShellSyntaxError("syntax error: expected ')'");
      this.next();
      return { t: 'group', body, sub: true, redirs: this.parseRedirs() };
    }
    const w = this.wordText(t);
    if (w === '{') {
      this.next();
      const body = this.parseList(new Set(['}']));
      this.expectWord('}');
      return { t: 'group', body, sub: false, redirs: this.parseRedirs() };
    }
    if (w === 'if') return this.parseIf();
    if (w === 'for') return this.parseFor();
    if (w === 'while' || w === 'until') return this.parseWhile(w === 'until');
    if (w === 'case') return this.parseCase();
    if (w === 'function') {
      this.next();
      const name = this.wordText(this.next());
      if (!name) throw new ShellSyntaxError('syntax error: function name expected');
      if (this.isOp('(')) {
        this.next();
        if (!this.isOp(')')) throw new ShellSyntaxError("syntax error: expected ')'");
        this.next();
      }
      this.skipNl();
      const body = this.parseCommand();
      return { t: 'func', name, body };
    }
    if (t.t === 'word' && w && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w) && this.isOp('(', this.toks[this.i + 1]) && this.isOp(')', this.toks[this.i + 2])) {
      this.i += 3;
      this.skipNl();
      const body = this.parseCommand();
      return { t: 'func', name: w, body };
    }
    return this.parseSimple();
  }

  parseRedirs(): Redir[] {
    const redirs: Redir[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') break;
      const r = this.parseRedir(t);
      if (!r) break;
      redirs.push(r);
    }
    return redirs;
  }

  parseRedir(t: Extract<Tok, { t: 'op' }>): Redir | null {
    const map: Record<string, Redir> = {
      '>': { fd: 1, op: '>' },
      '>>': { fd: 1, op: '>>' },
      '<': { fd: 0, op: '<' },
      '2>': { fd: 2, op: '>' },
      '2>&1': { fd: 2, op: '>&' },
      '>&': { fd: 1, op: '>&' },
      '&>': { fd: 3, op: '>' },
      '&>>': { fd: 3, op: '>>' },
      '<<': { fd: 0, op: '<<' },
      '<<-': { fd: 0, op: '<<' },
    };
    const base = map[t.v];
    if (!base) return null;
    this.next();
    const r: Redir = { ...base };
    if (t.v === '2>&1') return r;
    if (t.v === '<<' || t.v === '<<-') {
      r.heredoc = t.heredoc ?? { body: '', quoted: false };
      return r;
    }
    if (t.v === '2>' && this.peek().t === 'op' && this.isOp('>')) {
      this.next();
      r.op = '>>';
    }
    const target = this.next();
    if (target.t !== 'word') throw new ShellSyntaxError(`syntax error near unexpected token '${describe(target)}'`);
    r.target = target.w;
    return r;
  }

  parseSimple(): Node {
    const words: Word[] = [];
    const redirs: Redir[] = [];
    const assigns: Array<{ name: string; value: Word }> = [];
    const line = this.peek().line;
    for (;;) {
      const t = this.peek();
      if (t.t === 'word') {
        const txt = this.wordText(t);
        if (words.length === 0 && txt !== null && RESERVED.has(txt) && txt !== '{' && txt !== '}') {
          if (txt === '{' || txt === '}') break;
          throw new ShellSyntaxError(`syntax error near unexpected token '${txt}' (line ${t.line})`);
        }
        if (txt === '}' && words.length === 0) break;
        const first = t.w[0];
        const m = first && first.q === 'n' ? /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/.exec(first.s) : null;
        if (words.length === 0 && m) {
          this.next();
          const head: Part = { s: first.s.slice(m[0].length), q: 'n' };
          const rest: Word = [head, ...t.w.slice(1)].filter((p) => p.s !== '' || p.q !== 'n');
          const marker: Part = { s: '\u0002+=', q: 's' };
          assigns.push({ name: m[1], value: m[2] === '+=' ? [marker, ...rest] : rest });
          continue;
        }
        words.push(t.w);
        this.next();
        continue;
      }
      if (t.t === 'op') {
        const r = this.parseRedir(t);
        if (r) {
          redirs.push(r);
          continue;
        }
      }
      break;
    }
    if (!words.length && !assigns.length && !redirs.length) {
      const t = this.peek();
      throw new ShellSyntaxError(`syntax error near unexpected token '${describe(t)}' (line ${t.line})`);
    }
    return { t: 'simple', words, redirs, assigns, line };
  }

  parseIf(): Node {
    this.expectWord('if');
    const branches: Array<{ cond: Node; body: Node }> = [];
    const cond = this.parseList(new Set(['then']));
    this.expectWord('then');
    const body = this.parseList(new Set(['elif', 'else', 'fi']));
    branches.push({ cond, body });
    let elseBody: Node | undefined;
    for (;;) {
      if (this.isWord('elif')) {
        this.next();
        const c = this.parseList(new Set(['then']));
        this.expectWord('then');
        const b = this.parseList(new Set(['elif', 'else', 'fi']));
        branches.push({ cond: c, body: b });
        continue;
      }
      if (this.isWord('else')) {
        this.next();
        elseBody = this.parseList(new Set(['fi']));
      }
      this.expectWord('fi');
      break;
    }
    return { t: 'if', branches, else: elseBody };
  }

  parseFor(): Node {
    this.expectWord('for');
    const t = this.peek();
    if (t.t === 'op' && t.v === '((') {
      this.next();
      const [init = '', cond = '', step = ''] = (t.body ?? '').split(';');
      this.skipNl();
      this.expectWord('do');
      const body = this.parseList(new Set(['done']));
      this.expectWord('done');
      return { t: 'cfor', init, cond, step, body };
    }
    const name = this.wordText(this.next());
    if (!name) throw new ShellSyntaxError('syntax error: for needs a variable name');
    let words: Word[] | undefined;
    if (this.isWord('in')) {
      this.next();
      words = [];
      while (this.peek().t === 'word') words.push((this.next() as Extract<Tok, { t: 'word' }>).w);
    }
    this.skipNl();
    this.expectWord('do');
    const body = this.parseList(new Set(['done']));
    this.expectWord('done');
    return { t: 'for', name, words, body };
  }

  parseWhile(until: boolean): Node {
    this.next();
    const cond = this.parseList(new Set(['do']));
    this.expectWord('do');
    const body = this.parseList(new Set(['done']));
    this.expectWord('done');
    return { t: 'while', cond, body, until };
  }

  parseCase(): Node {
    this.expectWord('case');
    const w = this.next();
    if (w.t !== 'word') throw new ShellSyntaxError('syntax error: case needs a word');
    this.skipNl();
    this.expectWord('in');
    const items: Array<{ patterns: Word[]; body: Node }> = [];
    for (;;) {
      this.skipNl();
      if (this.isWord('esac')) {
        this.next();
        break;
      }
      if (this.isOp('(')) this.next();
      const patterns: Word[] = [];
      for (;;) {
        const p = this.next();
        if (p.t !== 'word') throw new ShellSyntaxError('syntax error in case pattern');
        patterns.push(p.w);
        if (this.isOp('|')) {
          this.next();
          continue;
        }
        break;
      }
      if (!this.isOp(')')) throw new ShellSyntaxError("syntax error: expected ')' after case pattern");
      this.next();
      const body = this.parseList(new Set(['esac']));
      if (this.isOp(';;')) this.next();
      items.push({ patterns, body });
    }
    return { t: 'case', word: w.w, items };
  }
}

function describe(t: Tok): string {
  if (t.t === 'word') return t.w.map((p) => p.s).join('');
  if (t.t === 'op') return t.v;
  return t.t === 'nl' ? 'newline' : 'end of file';
}

export function parse(src: string): Node {
  return new Parser(tokenize(src)).parseScript();
}

/* ------------------------------------------------------------------ execution context */

export interface Request {
  kind: 'editor' | 'clear' | 'crontab' | 'logout';
  path?: string;
  content?: string;
  user?: string;
}

export class ExitSignal {
  constructor(public code: number) {}
}
class ReturnSignal {
  constructor(public code: number) {}
}
class BreakSignal {
  constructor(public levels: number) {}
}
class ContinueSignal {
  constructor(public levels: number) {}
}

export interface Ctx {
  sys: ShellSystem;
  vars: Record<string, string>;
  exported: Set<string>;
  funcs: Record<string, Node>;
  params: string[];
  scriptName: string;
  status: number;
  errexit: boolean;
  nounset: boolean;
  xtrace: boolean;
  condDepth: number;
  loopDepth: number;
  depth: number;
  requests: Request[];
  /** Effective user for this command (sudo). */
  euser?: string;
  /** Commands executed, for checks. */
  steps: number;
}

export function newSession(sys: ShellSystem): Pick<Ctx, 'vars' | 'exported' | 'funcs' | 'status'> {
  return { vars: { ...sys.env }, exported: new Set(Object.keys(sys.env)), funcs: {}, status: 0 };
}

export function makeCtx(sys: ShellSystem, session?: Pick<Ctx, 'vars' | 'exported' | 'funcs' | 'status'>): Ctx {
  const s = session ?? newSession(sys);
  return { sys, vars: s.vars, exported: s.exported, funcs: s.funcs, params: [], scriptName: 'bash', status: s.status, errexit: false, nounset: false, xtrace: false, condDepth: 0, loopDepth: 0, depth: 0, requests: [], steps: 0 };
}

export function currentUser(ctx: Ctx): string {
  return ctx.euser ?? ctx.sys.user;
}
export function actor(ctx: Ctx) {
  return actorFor(ctx.sys, currentUser(ctx));
}

/* ------------------------------------------------------------------ expansion */

function getVar(ctx: Ctx, name: string): string | undefined {
  if (/^\d+$/.test(name)) return name === '0' ? ctx.scriptName : ctx.params[Number(name) - 1];
  if (name === '#') return String(ctx.params.length);
  if (name === '?') return String(ctx.status);
  if (name === '$') return '1101';
  if (name === '@' || name === '*') return ctx.params.join(' ');
  if (name === 'PWD') return ctx.sys.cwd;
  if (name === 'HOME' && ctx.vars.HOME === undefined) return homeOf(ctx.sys, currentUser(ctx));
  if (name === 'RANDOM') return String(Math.floor(Math.random() * 32768));
  if (name === 'UID') return String(ctx.sys.users[currentUser(ctx)]?.uid ?? 0);
  if (name === 'HOSTNAME') return ctx.sys.hostname;
  return ctx.vars[name];
}

function setVar(ctx: Ctx, name: string, value: string): void {
  ctx.vars[name] = value;
  if (name === 'PATH' || ctx.exported.has(name)) ctx.sys.env[name] = value;
}

function patternToRegex(pat: string, anchor: 'start' | 'end' | 'full', greedy: boolean): RegExp {
  let re = '';
  for (const c of pat) {
    if (c === '*') re += greedy ? '.*' : '.*?';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (anchor === 'start') return new RegExp('^' + re);
  if (anchor === 'end') return new RegExp(re + '$');
  return new RegExp('^' + re + '$');
}

export function globMatch(pat: string, text: string): boolean {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pat.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        re += '[' + pat.slice(i + 1, end).replace(/^!/, '^') + ']';
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$').test(text);
}

function expandParam(ctx: Ctx, inner: string): string {
  // ${#name}
  let m = /^#([A-Za-z_][A-Za-z0-9_]*|[@*#?])$/.exec(inner);
  if (m) return m[1] === '@' || m[1] === '*' ? String(ctx.params.length) : String((getVar(ctx, m[1]) ?? '').length);
  m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$])(.*)$/s.exec(inner);
  if (!m) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  const name = m[1];
  const rest = m[2];
  const val = getVar(ctx, name);
  if (rest === '') {
    if (val === undefined && ctx.nounset) throw new ShellError(`${name}: unbound variable`, 1);
    return val ?? '';
  }
  let op = /^(:-|:=|:\+|:\?|-|=|\+|\?|##|#|%%|%|\/\/|\/|\^\^|\^|,,|,|:)/.exec(rest)?.[1];
  if (!op) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  const arg = rest.slice(op.length);
  const unsetOrNull = val === undefined || (op.startsWith(':') && val === '');
  switch (op) {
    case ':-':
    case '-':
      return unsetOrNull ? expandText(ctx, arg, true) : val!;
    case ':=':
    case '=':
      if (unsetOrNull) setVar(ctx, name, expandText(ctx, arg, true));
      return getVar(ctx, name) ?? '';
    case ':+':
    case '+':
      return unsetOrNull ? '' : expandText(ctx, arg, true);
    case ':?':
    case '?':
      if (unsetOrNull) throw new ShellError(`${name}: ${arg || 'parameter null or not set'}`, 1);
      return val!;
    case '#':
    case '##': {
      const v = val ?? '';
      const re = patternToRegex(expandText(ctx, arg, true), 'start', op === '##');
      return v.replace(re, '');
    }
    case '%':
    case '%%': {
      const v = val ?? '';
      const re = patternToRegex(expandText(ctx, arg, true), 'end', op === '%%');
      return v.replace(re, '');
    }
    case '/':
    case '//': {
      const v = val ?? '';
      const slash = arg.indexOf('/');
      const pat = slash === -1 ? arg : arg.slice(0, slash);
      const rep = slash === -1 ? '' : arg.slice(slash + 1);
      const re = patternToRegex(expandText(ctx, pat, true), 'full', true);
      const src = re.source.slice(1, -1);
      return v.replace(new RegExp(src, op === '//' ? 'g' : ''), expandText(ctx, rep, true));
    }
    case '^^':
      return (val ?? '').toUpperCase();
    case '^':
      return (val ?? '').replace(/^./, (c) => c.toUpperCase());
    case ',,':
      return (val ?? '').toLowerCase();
    case ',':
      return (val ?? '').replace(/^./, (c) => c.toLowerCase());
    case ':': {
      const [off, len] = arg.split(':').map((x) => Number(evalArith(ctx, x || '0')));
      const v = val ?? '';
      return len === undefined || Number.isNaN(len) ? v.slice(off) : v.slice(off, off + len);
    }
  }
  return val ?? '';
}

export class ShellError extends Error {
  constructor(message: string, public code = 1) {
    super(message);
  }
}

/** Expands $var, ${...}, $(...), `...`, $((...)) in a piece of text. */
export function expandText(ctx: Ctx, text: string, inQuotes: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\u0001') {
      out += text[++i] ?? '';
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) {
        out += c;
        continue;
      }
      out += commandSubst(ctx, text.slice(i + 1, end));
      i = end;
      continue;
    }
    if (c !== '$') {
      out += c;
      continue;
    }
    const n = text[i + 1];
    if (n === '(' && text[i + 2] === '(') {
      // arithmetic: find matching "))"
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '(') depth++;
        else if (text[j] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const expr = text.slice(i + 3, j - 1);
      out += String(evalArith(ctx, expr));
      i = j;
      continue;
    }
    if (n === '(') {
      const end = matchParen(text, i + 1);
      out += commandSubst(ctx, text.slice(i + 2, end));
      i = end;
      continue;
    }
    if (n === '{') {
      const end = text.indexOf('}', i);
      if (end === -1) throw new ShellSyntaxError('bad substitution');
      out += expandParam(ctx, text.slice(i + 2, end));
      i = end;
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|\d|[@*#?$!])/.exec(text.slice(i + 1));
    if (!m) {
      out += c;
      continue;
    }
    const v = getVar(ctx, m[1]);
    if (v === undefined && ctx.nounset && !'@*#?$!'.includes(m[1])) throw new ShellError(`${m[1]}: unbound variable`, 1);
    out += v ?? '';
    i += m[1].length;
  }
  void inQuotes;
  return out;
}

function commandSubst(ctx: Ctx, src: string): string {
  const sub: Ctx = { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported), depth: ctx.depth + 1, condDepth: 0, loopDepth: 0 };
  if (sub.depth > 40) throw new ShellError('command substitution nested too deeply', 1);
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: (s) => ctxErr(ctx, s) };
  try {
    const node = parse(src);
    const code = exec(sub, node, io);
    ctx.status = code;
  } catch (e) {
    if (e instanceof ExitSignal) ctx.status = e.code;
    else throw e;
  }
  ctx.requests.push(...sub.requests);
  return buf.join('').replace(/\n+$/, '');
}

const errSink = new WeakMap<Ctx, (s: string) => void>();
function ctxErr(ctx: Ctx, s: string): void {
  errSink.get(ctx)?.(s);
}

/** Expands a word into fields (after splitting and globbing). */
export function expandWord(ctx: Ctx, word: Word): string[] {
  const fields: Array<{ s: string; glob: boolean; quoted: boolean }> = [];
  let cur = '';
  let curGlob = false;
  let quoted = false;
  let any = false;
  // Glob characters inside quotes are protected with markers so only unquoted ones match files.
  const protect = (s: string) => s.replace(/[*?[]/g, (c) => (c === '*' ? '\u0003' : c === '?' ? '\u0004' : '\u0005'));
  const restore = (s: string) => s.replace(/[\u0003\u0004\u0005]/g, (c) => (c === '\u0003' ? '*' : c === '\u0004' ? '?' : '['));
  word.forEach((part, idx) => {
    if (part.q === 's') {
      cur += protect(part.s);
      quoted = true;
      any = true;
      return;
    }
    if (part.q === 'd') {
      // "$@" expands to one field per parameter.
      if (part.s === '$@' || part.s === '${@}') {
        if (ctx.params.length === 0) {
          quoted = quoted || cur !== '';
          return;
        }
        ctx.params.forEach((p, k) => {
          if (k === 0) cur += p;
          else {
            fields.push({ s: cur, glob: curGlob, quoted: true });
            cur = p;
            curGlob = false;
          }
        });
        quoted = true;
        any = true;
        return;
      }
      cur += protect(expandText(ctx, part.s, true));
      quoted = true;
      any = true;
      return;
    }
    let text = part.s;
    if (idx === 0 && text.startsWith('~')) {
      const m = /^~([A-Za-z0-9_-]*)(?=\/|$)/.exec(text);
      if (m) text = (m[1] ? ctx.sys.users[m[1]]?.home ?? `~${m[1]}` : homeOf(ctx.sys, currentUser(ctx))) + text.slice(m[0].length);
    }
    const literalGlob = /[*?[]/.test(part.s);
    const expanded = expandText(ctx, text, false);
    const pieces = expanded.split(/([ \t\n]+)/);
    any = true;
    pieces.forEach((piece, k) => {
      if (k % 2 === 1) {
        if (cur !== '' || quoted) fields.push({ s: cur, glob: curGlob, quoted });
        cur = '';
        curGlob = false;
        quoted = false;
        return;
      }
      if (piece === '') return;
      cur += piece;
      curGlob = curGlob || literalGlob || /[*?[]/.test(piece);
    });
  });
  if (cur !== '' || quoted || !any) fields.push({ s: cur, glob: curGlob, quoted });
  const out: string[] = [];
  for (const f of fields) {
    if (f.glob) {
      let matches: string[] | null = null;
      try {
        matches = fsGlob(ctx.sys.fs, ctx.sys.cwd, f.s, actor(ctx), homeOf(ctx.sys, currentUser(ctx)));
      } catch {
        matches = null;
      }
      if (matches && matches.length) {
        out.push(...matches.sort().map(restore));
        continue;
      }
    }
    out.push(restore(f.s));
  }
  return out;
}

function expandWords(ctx: Ctx, words: Word[]): string[] {
  return words.flatMap((w) => expandWord(ctx, w));
}

/** A word expanded without field splitting or globbing (for redirection targets and case words). */
function expandSingle(ctx: Ctx, word: Word): string {
  return word
    .map((p, idx) => {
      if (p.q === 's') return p.s;
      if (p.q === 'd') return expandText(ctx, p.s, true);
      let text = p.s;
      if (idx === 0 && text.startsWith('~')) {
        const m = /^~([A-Za-z0-9_-]*)(?=\/|$)/.exec(text);
        if (m) text = (m[1] ? ctx.sys.users[m[1]]?.home ?? `~${m[1]}` : homeOf(ctx.sys, currentUser(ctx))) + text.slice(m[0].length);
      }
      return expandText(ctx, text, false);
    })
    .join('');
}

/* ------------------------------------------------------------------ arithmetic */

export function evalArith(ctx: Ctx, src: string): number {
  const toks: string[] = [];
  const re = /\s*(\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<<=|>>=|<<|>>|<=|>=|==|!=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|[-+*/%()<>!~&|^?:=])/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(i))) break;
      throw new ShellError(`${src}: syntax error in expression`, 1);
    }
    toks.push(m[1]);
    i = re.lastIndex;
  }
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  };
  const varVal = (name: string) => num(getVar(ctx, name) ?? 0);

  function assignment(): number {
    // name op= expr
    if (/^[A-Za-z_]/.test(peek() ?? '') && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>='].includes(toks[p + 1] ?? '')) {
      const name = next();
      const op = next();
      const rhs = assignment();
      let v = varVal(name);
      if (op === '=') v = rhs;
      else if (op === '+=') v += rhs;
      else if (op === '-=') v -= rhs;
      else if (op === '*=') v *= rhs;
      else if (op === '/=') v = Math.trunc(v / rhs);
      else if (op === '%=') v %= rhs;
      else if (op === '<<=') v <<= rhs;
      else v >>= rhs;
      setVar(ctx, name, String(v));
      return v;
    }
    return ternary();
  }
  function ternary(): number {
    const c = binary(0);
    if (peek() === '?') {
      next();
      const a = assignment();
      if (next() !== ':') throw new ShellError('expected :', 1);
      const b = assignment();
      return c ? a : b;
    }
    return c;
  }
  const PREC: Record<string, number> = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 };
  function binary(min: number): number {
    let left = unary();
    for (;;) {
      const op = peek();
      const prec = op ? PREC[op] : undefined;
      if (prec === undefined || prec < min) return left;
      next();
      const right = op === '**' ? binary(prec) : binary(prec + 1);
      switch (op) {
        case '||': left = left || right ? 1 : 0; break;
        case '&&': left = left && right ? 1 : 0; break;
        case '|': left |= right; break;
        case '^': left ^= right; break;
        case '&': left &= right; break;
        case '==': left = left === right ? 1 : 0; break;
        case '!=': left = left !== right ? 1 : 0; break;
        case '<': left = left < right ? 1 : 0; break;
        case '>': left = left > right ? 1 : 0; break;
        case '<=': left = left <= right ? 1 : 0; break;
        case '>=': left = left >= right ? 1 : 0; break;
        case '<<': left <<= right; break;
        case '>>': left >>= right; break;
        case '+': left += right; break;
        case '-': left -= right; break;
        case '*': left *= right; break;
        case '/': if (right === 0) throw new ShellError('division by 0', 1); left = Math.trunc(left / right); break;
        case '%': if (right === 0) throw new ShellError('division by 0', 1); left %= right; break;
        case '**': left = Math.pow(left, right); break;
      }
    }
  }
  function unary(): number {
    const t = peek();
    if (t === '-') { next(); return -unary(); }
    if (t === '+') { next(); return unary(); }
    if (t === '!') { next(); return unary() ? 0 : 1; }
    if (t === '~') { next(); return ~unary(); }
    if (t === '++' || t === '--') {
      next();
      const name = next();
      const v = varVal(name) + (t === '++' ? 1 : -1);
      setVar(ctx, name, String(v));
      return v;
    }
    return postfix();
  }
  function postfix(): number {
    const t = next();
    if (t === undefined) throw new ShellError('syntax error: operand expected', 1);
    if (t === '(') {
      const v = assignment();
      if (next() !== ')') throw new ShellError('syntax error: missing )', 1);
      return v;
    }
    if (/^\d+$/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '++' || peek() === '--') {
        const op = next();
        const v = varVal(t);
        setVar(ctx, t, String(v + (op === '++' ? 1 : -1)));
        return v;
      }
      return varVal(t);
    }
    throw new ShellError(`syntax error: operand expected (error token is "${t}")`, 1);
  }
  if (toks.length === 0) return 0;
  const v = assignment();
  if (p < toks.length) throw new ShellError(`syntax error in expression (error token is "${toks[p]}")`, 1);
  return v;
}

/* ------------------------------------------------------------------ execution */

function applyRedirs(ctx: Ctx, redirs: Redir[], io: IO): { io: IO; finish: () => void } {
  let stdin = io.stdin;
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  let outTarget: { path: string; append: boolean } | null = null;
  let errTarget: { path: string; append: boolean } | null = null;
  let errToOut = false;
  let outToErr = false;
  for (const r of redirs) {
    if (r.op === '<<') {
      stdin = r.heredoc!.quoted ? r.heredoc!.body : expandText(ctx, r.heredoc!.body, true);
      continue;
    }
    if (r.op === '>&') {
      if (r.fd === 2) errToOut = true;
      else {
        const t = r.target ? expandSingle(ctx, r.target) : '1';
        if (t === '2') outToErr = true;
        else if (t !== '1') {
          const path = resolvePath(ctx.sys.cwd, t, homeOf(ctx.sys, currentUser(ctx)));
          outTarget = { path, append: false };
          errTarget = outTarget;
          writeFile(ctx.sys.fs, path, '', actor(ctx), ctx.sys.now);
        }
      }
      continue;
    }
    const target = resolvePath(ctx.sys.cwd, expandSingle(ctx, r.target!), homeOf(ctx.sys, currentUser(ctx)));
    if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr' || target === '/dev/tty') {
      if (r.op === '<') stdin = '';
      else if (target === '/dev/null') {
        if (r.fd === 1 || r.fd === 3) outTarget = { path: target, append: true };
        if (r.fd === 2 || r.fd === 3) errTarget = { path: target, append: true };
      }
      continue;
    }
    if (r.op === '<') {
      stdin = readFile(ctx.sys.fs, target, actor(ctx));
      continue;
    }
    const t = { path: target, append: r.op === '>>' };
    if (r.fd === 1) outTarget = t;
    else if (r.fd === 2) errTarget = t;
    else {
      outTarget = t;
      errTarget = t;
    }
    // Create/truncate now, as the shell does.
    if (!t.append) writeFile(ctx.sys.fs, target, '', actor(ctx), ctx.sys.now);
    else if (!lookup(ctx.sys.fs, target, actor(ctx))) writeFile(ctx.sys.fs, target, '', actor(ctx), ctx.sys.now);
  }
  const out = outTarget ? (s: string) => outBuf.push(s) : outToErr ? io.err : io.out;
  const err = errTarget ? (s: string) => errBuf.push(s) : errToOut ? out : io.err;
  // Without a stdin redirection the command consumes the caller's stdin (so `read` in a loop advances it).
  const ownStdin = stdin !== io.stdin;
  let localStdin = stdin;
  const shared: IO = {
    get stdin() {
      return ownStdin ? localStdin : io.stdin;
    },
    set stdin(v: string) {
      if (ownStdin) localStdin = v;
      else io.stdin = v;
    },
    out,
    err,
    interactive: ownStdin ? false : io.interactive,
  };
  const finish = () => {
    if (outTarget && outTarget.path !== '/dev/null') writeFile(ctx.sys.fs, outTarget.path, outBuf.join(''), actor(ctx), ctx.sys.now, true);
    if (errTarget && errTarget.path !== '/dev/null') writeFile(ctx.sys.fs, errTarget.path, errBuf.join(''), actor(ctx), ctx.sys.now, true);
  };
  return { io: shared, finish };
}

function truthy(code: number): boolean {
  return code === 0;
}

export function exec(ctx: Ctx, node: Node, io: IO): number {
  errSink.set(ctx, io.err);
  switch (node.t) {
    case 'list': {
      let code = 0;
      for (const item of node.items) {
        code = exec(ctx, item, io);
        ctx.status = code;
      }
      return code;
    }
    case 'andor': {
      ctx.condDepth++;
      let left: number;
      try {
        left = exec(ctx, node.left, io);
      } finally {
        ctx.condDepth--;
      }
      ctx.status = left;
      if (node.op === '&&' ? truthy(left) : !truthy(left)) {
        const r = exec(ctx, node.right, io);
        ctx.status = r;
        return r;
      }
      return left;
    }
    case 'pipeline': {
      let input = io.stdin;
      let code = 0;
      for (let k = 0; k < node.cmds.length; k++) {
        const last = k === node.cmds.length - 1;
        const buf: string[] = [];
        const stageIo: IO = { stdin: input, out: last ? io.out : (s) => buf.push(s), err: io.err };
        const saveStatus = ctx.status;
        if (!last) ctx.condDepth++;
        try {
          code = exec(ctx, node.cmds[k], stageIo);
        } finally {
          if (!last) ctx.condDepth--;
        }
        if (!last) ctx.status = saveStatus;
        input = buf.join('');
      }
      const final = node.negate ? (code === 0 ? 1 : 0) : code;
      ctx.status = final;
      if (ctx.errexit && final !== 0 && ctx.condDepth === 0) throw new ExitSignal(final);
      return final;
    }
    case 'if': {
      for (const b of node.branches) {
        ctx.condDepth++;
        let c: number;
        try {
          c = exec(ctx, b.cond, io);
        } finally {
          ctx.condDepth--;
        }
        if (truthy(c)) return exec(ctx, b.body, io);
      }
      if (node.else) return exec(ctx, node.else, io);
      ctx.status = 0;
      return 0;
    }
    case 'while': {
      let code = 0;
      let guard = 0;
      ctx.loopDepth++;
      try {
        for (;;) {
          if (++guard > 10000) throw new ShellError('loop ran more than 10000 times; stopped by the simulator', 1);
          ctx.condDepth++;
          let c: number;
          try {
            c = exec(ctx, node.cond, io);
          } finally {
            ctx.condDepth--;
          }
          if (node.until ? truthy(c) : !truthy(c)) break;
          try {
            code = exec(ctx, node.body, io);
          } catch (e) {
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (e instanceof ContinueSignal) {
              if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
              continue;
            }
            throw e;
          }
        }
      } finally {
        ctx.loopDepth--;
      }
      ctx.status = code;
      return code;
    }
    case 'for': {
      const items = node.words ? expandWords(ctx, node.words) : [...ctx.params];
      let code = 0;
      ctx.loopDepth++;
      try {
        for (const item of items) {
          setVar(ctx, node.name, item);
          try {
            code = exec(ctx, node.body, io);
          } catch (e) {
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (e instanceof ContinueSignal) {
              if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
              continue;
            }
            throw e;
          }
        }
      } finally {
        ctx.loopDepth--;
      }
      ctx.status = code;
      return code;
    }
    case 'cfor': {
      let code = 0;
      let guard = 0;
      if (node.init.trim()) evalArith(ctx, node.init);
      ctx.loopDepth++;
      try {
        for (;;) {
          if (++guard > 10000) throw new ShellError('loop ran more than 10000 times; stopped by the simulator', 1);
          if (node.cond.trim() && !evalArith(ctx, node.cond)) break;
          try {
            code = exec(ctx, node.body, io);
          } catch (e) {
            if (e instanceof BreakSignal) {
              if (e.levels > 1) throw new BreakSignal(e.levels - 1);
              break;
            }
            if (e instanceof ContinueSignal) {
              if (e.levels > 1) throw new ContinueSignal(e.levels - 1);
            } else throw e;
          }
          if (node.step.trim()) evalArith(ctx, node.step);
        }
      } finally {
        ctx.loopDepth--;
      }
      ctx.status = code;
      return code;
    }
    case 'case': {
      const w = expandSingle(ctx, node.word);
      for (const item of node.items) {
        if (item.patterns.some((p) => globMatch(expandSingle(ctx, p), w))) return exec(ctx, item.body, io);
      }
      ctx.status = 0;
      return 0;
    }
    case 'func':
      ctx.funcs[node.name] = node.body;
      ctx.status = 0;
      return 0;
    case 'group': {
      const r = applyRedirs(ctx, node.redirs, io);
      const sub = node.sub ? { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported) } : ctx;
      let code: number;
      try {
        code = exec(sub, node.body, r.io);
      } catch (e) {
        if (node.sub && e instanceof ExitSignal) code = e.code;
        else throw e;
      } finally {
        r.finish();
      }
      if (node.sub) {
        ctx.requests.push(...sub.requests.filter((q) => !ctx.requests.includes(q)));
        ctx.sys.cwd = sub.sys.cwd;
      }
      ctx.status = code;
      return code;
    }
    case 'arith': {
      const v = evalArith(ctx, node.expr);
      ctx.status = v === 0 ? 1 : 0;
      if (ctx.errexit && ctx.status !== 0 && ctx.condDepth === 0) throw new ExitSignal(ctx.status);
      return ctx.status;
    }
    case 'simple':
      return execSimple(ctx, node, io);
  }
}

const SHELL_BUILTINS = new Set(['cd', 'export', 'unset', 'set', 'shift', 'exit', 'return', 'break', 'continue', 'source', '.', 'read', 'local', 'declare', 'let', 'eval', 'exec', 'alias', 'unalias', 'type', 'command', 'builtin', 'umask', 'history', 'help', 'pushd', 'popd', 'dirs', 'logout', 'bash', 'sh', 'hash', 'getopts', 'trap', 'wait', 'jobs', 'fg', 'bg', 'readonly']);

function execSimple(ctx: Ctx, node: Extract<Node, { t: 'simple' }>, io: IO): number {
  const words = expandWords(ctx, node.words);
  if (words.length === 0) {
    // Pure assignments.
    for (const a of node.assigns) {
      let value = expandSingle(ctx, a.value);
      if (value.startsWith('\u0002+=')) value = (getVar(ctx, a.name) ?? '') + value.slice(3);
      setVar(ctx, a.name, value);
    }
    if (node.redirs.length) {
      const r = applyRedirs(ctx, node.redirs, io);
      r.finish();
    }
    ctx.status = 0;
    return 0;
  }
  // Temporary environment assignments (VAR=x cmd) just set the variables for us.
  const saved: Record<string, string | undefined> = {};
  for (const a of node.assigns) {
    saved[a.name] = ctx.vars[a.name];
    let value = expandSingle(ctx, a.value);
    if (value.startsWith('\u0002+=')) value = (getVar(ctx, a.name) ?? '') + value.slice(3);
    setVar(ctx, a.name, value);
  }
  let r: ReturnType<typeof applyRedirs>;
  try {
    r = applyRedirs(ctx, node.redirs, io);
  } catch (e) {
    if (e instanceof FsError) {
      const typed = node.redirs.map((x) => (x.target ? expandSingle(ctx, x.target) : '')).find((t) => e.message.includes(t)) ?? '';
      io.err(`bash: ${typed || e.message.split(': ')[0]}: ${e.message.slice(e.message.lastIndexOf(': ') + 2)}\n`);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete ctx.vars[k];
        else ctx.vars[k] = v;
      }
      ctx.status = 1;
      if (ctx.errexit && ctx.condDepth === 0) throw new ExitSignal(1);
      return 1;
    }
    throw e;
  }
  let code: number;
  try {
    if (ctx.xtrace) io.err(`+ ${words.join(' ')}\n`);
    code = runCommand(ctx, words, r.io);
  } catch (e) {
    if (e instanceof ShellError) {
      r.io.err(`${words[0]}: ${e.message}\n`);
      code = e.code;
    } else if (e instanceof FsError) {
      r.io.err(`${words[0]}: ${e.message}\n`);
      code = 1;
    } else throw e;
  } finally {
    r.finish();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete ctx.vars[k];
      else ctx.vars[k] = v;
    }
  }
  ctx.status = code;
  ctx.steps++;
  if (ctx.errexit && code !== 0 && ctx.condDepth === 0) throw new ExitSignal(code);
  return code;
}

/** Runs one command (function, builtin, simulated program or script) with already-expanded words. */
export function runCommand(ctx: Ctx, words: string[], io: IO): number {
  const [name, ...args] = words;
  if (ctx.funcs[name]) {
    const savedParams = ctx.params;
    ctx.params = args;
    try {
      return exec(ctx, ctx.funcs[name], io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.code;
      throw e;
    } finally {
      ctx.params = savedParams;
    }
  }
  if (SHELL_BUILTINS.has(name)) return builtin(ctx, name, args, io);
  const avail = commandAvailable(ctx.sys, name);
  if (!avail.ok) {
    io.err(`bash: ${name}: command not found\n`);
    if (avail.package) io.err(`The program '${name}' can be found in the package '${avail.package}'. Try: sudo zypper install ${avail.package}\n`);
    return 127;
  }
  const cmd = COMMANDS[name];
  if (cmd) {
    setUmask(ctx.sys.umask);
    const code = cmd(args, io, ctx);
    syncEtcIfNeeded(ctx, name);
    return code;
  }
  // A script or program on the file system?
  const path = name.includes('/') ? resolvePath(ctx.sys.cwd, name, homeOf(ctx.sys, currentUser(ctx))) : findInPath(ctx, name);
  if (path) {
    const l = lookup(ctx.sys.fs, path, actor(ctx));
    if (!l) {
      io.err(`bash: ${name}: No such file or directory\n`);
      return 127;
    }
    if (l.node.type === 'dir') {
      io.err(`bash: ${name}: Is a directory\n`);
      return 126;
    }
    if (l.node.type !== 'file') {
      io.err(`bash: ${name}: No such file or directory\n`);
      return 127;
    }
    if (!can(l.node, actor(ctx), 'x')) {
      io.err(`bash: ${name}: Permission denied\n`);
      return 126;
    }
    if (!can(l.node, actor(ctx), 'r')) {
      io.err(`bash: ${name}: Permission denied\n`);
      return 126;
    }
    return runScript(ctx, l.node.content, args, name, io);
  }
  io.err(`bash: ${name}: command not found\n`);
  return 127;
}

function syncEtcIfNeeded(ctx: Ctx, name: string): void {
  if (['useradd', 'userdel', 'usermod', 'groupadd', 'groupdel', 'gpasswd', 'passwd', 'chage', 'chsh'].includes(name)) syncEtc(ctx.sys);
}

function findInPath(ctx: Ctx, name: string): string | null {
  const dirs = (ctx.vars.PATH ?? ctx.sys.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':');
  for (const d of dirs) {
    if (!d) continue;
    try {
      const l = lookup(ctx.sys.fs, `${d}/${name}`, actor(ctx));
      if (l && l.node.type === 'file') return `${d}/${name}`;
    } catch {
      /* unreadable dir */
    }
  }
  return null;
}

/** Runs script source with its own positional parameters. Variables are inherited (copied) like a child process. */
export function runScript(ctx: Ctx, src: string, args: string[], name: string, io: IO): number {
  const sub: Ctx = { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported), funcs: {}, params: args, scriptName: name, errexit: false, nounset: false, xtrace: false, condDepth: 0, loopDepth: 0, depth: ctx.depth + 1 };
  if (sub.depth > 20) {
    io.err(`bash: ${name}: scripts nested too deeply\n`);
    return 1;
  }
  const savedCwd = ctx.sys.cwd;
  const savedUser = ctx.sys.user;
  let code: number;
  try {
    const node = parse(src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1) : src);
    code = exec(sub, node, io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else if (e instanceof ReturnSignal) code = e.code;
    else if (e instanceof ShellSyntaxError) {
      io.err(`${name}: ${e.message}\n`);
      code = 2;
    } else if (e instanceof ShellError) {
      io.err(`${name}: ${e.message}\n`);
      code = e.code;
    } else throw e;
  }
  ctx.requests.push(...sub.requests);
  ctx.steps += sub.steps;
  ctx.sys.cwd = savedCwd;
  ctx.sys.user = savedUser;
  return code;
}

/* ------------------------------------------------------------------ shell builtins */

function builtin(ctx: Ctx, name: string, args: string[], io: IO): number {
  const sys = ctx.sys;
  switch (name) {
    case 'cd': {
      const target = args[0] === undefined || args[0] === '~' ? homeOf(sys, currentUser(ctx)) : args[0] === '-' ? ctx.vars.OLDPWD ?? sys.cwd : args[0];
      const path = resolvePath(sys.cwd, target, homeOf(sys, currentUser(ctx)));
      try {
        const l = lookup(sys.fs, path, actor(ctx));
        if (!l) {
          io.err(`bash: cd: ${args[0] ?? ''}: No such file or directory\n`);
          return 1;
        }
        if (l.node.type !== 'dir') {
          io.err(`bash: cd: ${args[0]}: Not a directory\n`);
          return 1;
        }
        if (!can(l.node, actor(ctx), 'x')) {
          io.err(`bash: cd: ${args[0]}: Permission denied\n`);
          return 1;
        }
        ctx.vars.OLDPWD = sys.cwd;
        sys.cwd = l.path;
        ctx.vars.PWD = l.path;
        sys.env.PWD = l.path;
        return 0;
      } catch (e) {
        if (e instanceof FsError) {
          io.err(`bash: cd: ${args[0]}: ${e.message.replace(/^.*?: /, '')}\n`);
          return 1;
        }
        throw e;
      }
    }
    case 'export': {
      if (!args.length) {
        for (const k of [...ctx.exported].sort()) io.out(`declare -x ${k}="${ctx.vars[k] ?? ''}"\n`);
        return 0;
      }
      for (const a of args) {
        const eq = a.indexOf('=');
        const k = eq === -1 ? a : a.slice(0, eq);
        if (eq !== -1) ctx.vars[k] = a.slice(eq + 1);
        ctx.exported.add(k);
        if (ctx.vars[k] !== undefined) sys.env[k] = ctx.vars[k];
      }
      return 0;
    }
    case 'unset':
      for (const a of args) {
        delete ctx.vars[a];
        delete sys.env[a];
        ctx.exported.delete(a);
        delete ctx.funcs[a];
      }
      return 0;
    case 'readonly':
    case 'declare':
    case 'local': {
      for (const a of args) {
        if (a.startsWith('-')) continue;
        const eq = a.indexOf('=');
        if (eq !== -1) setVar(ctx, a.slice(0, eq), a.slice(eq + 1));
        else if (name === 'local' && ctx.vars[a] === undefined) ctx.vars[a] = '';
      }
      return 0;
    }
    case 'set': {
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^[-+][euxo]+$/.test(a)) {
          const on = a[0] === '-';
          if (a.includes('e')) ctx.errexit = on;
          if (a.includes('u')) ctx.nounset = on;
          if (a.includes('x')) ctx.xtrace = on;
          if (a.includes('o')) {
            const name = args[++k];
            if (name === 'errexit') ctx.errexit = on;
            if (name === 'nounset') ctx.nounset = on;
            if (name === 'xtrace') ctx.xtrace = on;
          }
          continue;
        }
        if (a === '--') {
          ctx.params = args.slice(k + 1);
          break;
        }
        ctx.params = args.slice(k);
        break;
      }
      if (!args.length) for (const k of Object.keys(ctx.vars).sort()) io.out(`${k}=${ctx.vars[k]}\n`);
      return 0;
    }
    case 'shift': {
      const n = args[0] ? Number(args[0]) : 1;
      if (n > ctx.params.length) return 1;
      ctx.params = ctx.params.slice(n);
      return 0;
    }
    case 'exit':
    case 'logout': {
      const code = args[0] !== undefined ? Number(args[0]) & 255 : ctx.status;
      if (ctx.depth === 0 && ctx.scriptName === 'bash') {
        const prev = sys.userStack.pop();
        if (prev) {
          sys.user = prev.user;
          sys.cwd = prev.cwd;
          ctx.vars.HOME = homeOf(sys, prev.user);
          ctx.vars.USER = prev.user;
          sys.env.USER = prev.user;
          sys.env.HOME = ctx.vars.HOME;
          io.out('logout\n');
          return 0;
        }
        ctx.requests.push({ kind: 'logout' });
        io.out('logout\n(This is a simulated terminal; the session stays open.)\n');
        return 0;
      }
      throw new ExitSignal(code);
    }
    case 'return':
      throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) & 255 : ctx.status);
    case 'break':
      if (ctx.loopDepth === 0) {
        io.err('bash: break: only meaningful in a `for\', `while\', or `until\' loop\n');
        return 0;
      }
      throw new BreakSignal(args[0] ? Number(args[0]) : 1);
    case 'continue':
      if (ctx.loopDepth === 0) {
        io.err('bash: continue: only meaningful in a `for\', `while\', or `until\' loop\n');
        return 0;
      }
      throw new ContinueSignal(args[0] ? Number(args[0]) : 1);
    case 'source':
    case '.': {
      if (!args[0]) {
        io.err(`bash: ${name}: filename argument required\n`);
        return 2;
      }
      const path = resolvePath(sys.cwd, args[0], homeOf(sys, currentUser(ctx)));
      let src: string;
      try {
        src = readFile(sys.fs, path, actor(ctx));
      } catch (e) {
        io.err(`bash: ${args[0]}: ${(e as Error).message.replace(/^.*?: /, '')}\n`);
        return 1;
      }
      const savedParams = ctx.params;
      if (args.length > 1) ctx.params = args.slice(1);
      try {
        return exec(ctx, parse(src), io);
      } catch (e) {
        if (e instanceof ReturnSignal) return e.code;
        if (e instanceof ShellSyntaxError) {
          io.err(`bash: ${args[0]}: ${e.message}\n`);
          return 2;
        }
        throw e;
      } finally {
        ctx.params = savedParams;
      }
    }
    case 'bash':
    case 'sh': {
      let i = 0;
      const opts: string[] = [];
      while (args[i]?.startsWith('-')) opts.push(args[i++]);
      if (opts.includes('-c')) return runScript(ctx, args[i] ?? '', args.slice(i + 1), 'bash', io);
      if (!args[i]) {
        io.out('(A nested interactive shell is not simulated; you are already in bash.)\n');
        return 0;
      }
      const path = resolvePath(sys.cwd, args[i], homeOf(sys, currentUser(ctx)));
      let src: string;
      try {
        src = readFile(sys.fs, path, actor(ctx));
      } catch (e) {
        io.err(`bash: ${args[i]}: ${(e as Error).message.replace(/^.*?: /, '')}\n`);
        return 127;
      }
      const sub = runScriptWithOpts(ctx, src, args.slice(i + 1), args[i], io, opts);
      return sub;
    }
    case 'read': {
      let i = 0;
      let prompt = '';
      let raw = false;
      while (args[i]?.startsWith('-')) {
        if (args[i] === '-p') prompt = args[++i] ?? '';
        else if (args[i] === '-r') raw = true;
        i++;
      }
      void raw;
      const names = args.slice(i);
      if (prompt) io.out(prompt);
      const nl = io.stdin.indexOf('\n');
      if (io.stdin === '') {
        // End of input, or an interactive read: the simulator cannot wait for keystrokes.
        for (const n of names) setVar(ctx, n, '');
        if (!names.length) setVar(ctx, 'REPLY', '');
        if (io.interactive) io.err('(read: this simulator cannot wait for typed input; give it with a pipe or a here document, e.g. echo value | ./script.sh)\n');
        return 1;
      }
      const line = nl === -1 ? io.stdin : io.stdin.slice(0, nl);
      io.stdin = nl === -1 ? '' : io.stdin.slice(nl + 1);
      if (!names.length) setVar(ctx, 'REPLY', line);
      else {
        const fields = line.trim().split(/\s+/);
        names.forEach((n, k) => setVar(ctx, n, k === names.length - 1 ? fields.slice(k).join(' ') : fields[k] ?? ''));
      }
      return 0;
    }
    case 'let': {
      let v = 0;
      for (const a of args) v = evalArith(ctx, a);
      return v === 0 ? 1 : 0;
    }
    case 'eval':
      return exec(ctx, parse(args.join(' ')), io);
    case 'exec':
      return args.length ? runCommand(ctx, args, io) : 0;
    case 'alias':
    case 'unalias':
    case 'hash':
    case 'trap':
    case 'wait':
    case 'getopts':
      return 0;
    case 'jobs':
    case 'fg':
    case 'bg':
      io.out('(Job control is not simulated: commands here run to completion.)\n');
      return 0;
    case 'type':
    case 'command':
    case 'builtin': {
      if (name === 'command' && args[0] !== '-v') return runCommand(ctx, args, io);
      const targets = name === 'command' ? args.slice(1) : args;
      let code = 0;
      for (const t of targets) {
        if (ctx.funcs[t]) io.out(name === 'command' ? `${t}\n` : `${t} is a function\n`);
        else if (SHELL_BUILTINS.has(t)) io.out(name === 'command' ? `${t}\n` : `${t} is a shell builtin\n`);
        else if (COMMANDS[t] && commandAvailable(sys, t).ok) io.out(name === 'command' ? `/usr/bin/${t}\n` : `${t} is /usr/bin/${t}\n`);
        else {
          const p = findInPath(ctx, t);
          if (p) io.out(name === 'command' ? `${p}\n` : `${t} is ${p}\n`);
          else {
            if (name !== 'command') io.err(`bash: type: ${t}: not found\n`);
            code = 1;
          }
        }
      }
      return code;
    }
    case 'umask': {
      if (!args[0]) {
        io.out(sys.umask.toString(8).padStart(4, '0') + '\n');
        return 0;
      }
      if (!/^[0-7]{1,4}$/.test(args[0])) {
        io.err(`bash: umask: ${args[0]}: octal number out of range\n`);
        return 1;
      }
      sys.umask = parseInt(args[0], 8);
      return 0;
    }
    case 'history':
      sys.history.forEach((h, k) => io.out(`${String(k + 1).padStart(5)}  ${h}\n`));
      return 0;
    case 'help':
      io.out('This is a simulated bash. Type a command such as ls, cd, cat, grep, chmod or man <command>.\nShell keywords: if then elif else fi, for in do done, while until, case esac, function.\n');
      return 0;
    case 'pushd':
    case 'popd':
    case 'dirs':
      return builtin(ctx, 'cd', name === 'pushd' ? args : [], io);
  }
  return 1;
}

function runScriptWithOpts(ctx: Ctx, src: string, args: string[], name: string, io: IO, opts: string[]): number {
  const sub: Ctx = { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported), funcs: {}, params: args, scriptName: name, errexit: false, nounset: false, xtrace: opts.includes('-x'), condDepth: 0, loopDepth: 0, depth: ctx.depth + 1 };
  if (opts.includes('-n')) {
    try {
      parse(src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1) : src);
      return 0;
    } catch (e) {
      io.err(`${name}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const savedCwd = ctx.sys.cwd;
  let code: number;
  try {
    code = exec(sub, parse(src.startsWith('#!') ? src.slice(src.indexOf('\n') + 1) : src), io);
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else if (e instanceof ReturnSignal) code = e.code;
    else if (e instanceof ShellSyntaxError || e instanceof ShellError) {
      io.err(`${name}: ${e.message}\n`);
      code = e instanceof ShellError ? e.code : 2;
    } else throw e;
  }
  ctx.requests.push(...sub.requests);
  ctx.steps += sub.steps;
  ctx.sys.cwd = savedCwd;
  return code;
}

/* ------------------------------------------------------------------ top level */

export interface RunResult {
  output: string;
  status: number;
  requests: Request[];
}

export type Session = ReturnType<typeof newSession>;

/** Runs one interactive command line. Mutates sys and the session; output interleaves stdout and stderr. */
export function runLine(sys: ShellSystem, line: string, session: Session): RunResult {
  const ctx = makeCtx(sys, session);
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: (s) => buf.push(s), interactive: true };
  if (line.trim()) sys.history.push(line);
  let status = 0;
  try {
    const node = parse(line);
    status = exec(ctx, node, io);
  } catch (e) {
    if (e instanceof ExitSignal) status = e.code;
    else if (e instanceof ShellSyntaxError) {
      buf.push(`bash: ${e.message}\n`);
      status = 2;
    } else if (e instanceof ShellError) {
      buf.push(`bash: ${e.message}\n`);
      status = e.code;
    } else if (e instanceof FsError) {
      buf.push(`bash: ${e.message}\n`);
      status = 1;
    } else throw e;
  }
  session.status = status;
  sys.now += 1000 + Math.min(line.length * 150, 20000);
  return { output: buf.join(''), status, requests: ctx.requests };
}

/** Runs several lines (a transcript), returning the concatenated output. Used by tests and checks. */
export function runLines(sys: ShellSystem, lines: string[], session: Session = newSession(sys)): string {
  return lines.map((l) => runLine(sys, l, session).output).join('');
}

/** Captures the output of a command run as root without touching history (for checks). */
export function probe(sys: ShellSystem, line: string): { output: string; status: number } {
  const session = newSession(sys);
  const ctx = makeCtx(sys, session);
  ctx.euser = 'root';
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: (s) => buf.push(s) };
  const savedCwd = sys.cwd;
  let status = 0;
  try {
    status = exec(ctx, parse(line), io);
  } catch (e) {
    if (e instanceof ExitSignal) status = e.code;
    else status = 1;
  }
  sys.cwd = savedCwd;
  return { output: buf.join(''), status };
}
