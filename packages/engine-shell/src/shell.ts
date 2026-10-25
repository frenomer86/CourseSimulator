/**
 * A bash-subset interpreter over the simulated system: quoting, pipes, redirections,
 * here documents, variables and parameter expansion, command substitution, arithmetic,
 * globbing, if/for/while/until, functions, set -e, and scripts.
 */

import { runPowerShell } from './powershell.js';
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

const OPS3 = ['2>&1', '<<<', '<<-', '&>>'];
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
    // A carriage return is an ordinary character to bash: scripts saved with CRLF endings break, as on a real system.
    if (ch === ' ' || ch === '\t') {
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
      if (c === '\n' || c === ' ' || c === '\t') break;
      if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '<' || c === '>') break;
      // $'...': ANSI-C quoting with backslash escapes.
      if (c === '$' && src[i + 1] === "'") {
        flush();
        let j = i + 2;
        let s = '';
        const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?', '0': '\0' };
        while (j < src.length && src[j] !== "'") {
          if (src[j] === '\\' && j + 1 < src.length) {
            const n = src[j + 1];
            if (n === 'x' && /^[0-9a-fA-F]{1,2}/.test(src.slice(j + 2))) {
              const hx = /^[0-9a-fA-F]{1,2}/.exec(src.slice(j + 2))![0];
              s += String.fromCharCode(parseInt(hx, 16));
              j += 2 + hx.length;
              continue;
            }
            s += esc[n] ?? '\\' + n;
            j += 2;
            continue;
          }
          s += src[j++];
        }
        if (j >= src.length) throw new ShellSyntaxError("unexpected EOF while looking for matching `''");
        parts.push({ s, q: 's' });
        i = j + 1;
        continue;
      }
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
        const end = matchBrace(src, i + 1);
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

/** The index of the "}" closing the "${" whose "{" is at `open`, allowing nested ${...} and quotes. */
function matchBrace(src: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === '\\' && quote === '"') j++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '\\') j++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  throw new ShellSyntaxError('bad substitution: missing }');
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
  op: '>' | '>>' | '<' | '<<' | '<<<' | '>&';
  target?: Word;
  heredoc?: HereDoc;
  /** < <(commands): process substitution feeding stdin. */
  proc?: Node;
}
/** name=value, name[sub]=value or name=(a b c); a value starting with \u0002+= appends. */
export interface Assign {
  name: string;
  value: Word;
  index?: Word;
  array?: Word[];
}
export type Node =
  | { t: 'simple'; words: Word[]; redirs: Redir[]; assigns: Assign[]; line: number; arrays?: Array<{ at: number; words: Word[] }> }
  | { t: 'cond'; items: Array<{ w: Word } | { op: string }>; line: number }
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
    if (w === '[[') return this.withRedirs(this.parseCond());
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

  /** [[ expression ]]: words are not split or globbed, and && || ( ) < > ! are operators of the test. */
  parseCond(): Node {
    const line = this.next().line;
    const items: Array<{ w: Word } | { op: string }> = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof' || t.t === 'nl') throw new ShellSyntaxError(`syntax error: unexpected end of [[ ... ]] (line ${line})`);
      if (t.t === 'word' && this.wordText(t) === ']]') {
        this.next();
        break;
      }
      this.next();
      if (t.t === 'op') items.push({ op: t.v });
      else items.push({ w: t.w });
    }
    return { t: 'cond', items, line };
  }

  /** The words of an array literal after "(": up to the closing ")", across newlines. */
  parseArrayWords(): Word[] {
    this.next();
    const words: Word[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'nl') {
        this.next();
        continue;
      }
      if (this.isOp(')')) {
        this.next();
        return words;
      }
      if (t.t !== 'word') throw new ShellSyntaxError(`syntax error in array: unexpected token '${describe(t)}'`);
      words.push(t.w);
      this.next();
    }
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
      '<<<': { fd: 0, op: '<<<' },
    };
    const base = map[t.v];
    if (!base) return null;
    this.next();
    const r: Redir = { ...base };
    if (t.v === '2>&1') return r;
    // < <(commands)
    if (t.v === '<' && this.isOp('<') && this.isOp('(', this.toks[this.i + 1])) {
      this.i += 2;
      r.proc = this.parseList(new Set());
      if (!this.isOp(')')) throw new ShellSyntaxError("syntax error: expected ')' after process substitution");
      this.next();
      return r;
    }
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
    const assigns: Assign[] = [];
    const arrays: Array<{ at: number; words: Word[] }> = [];
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
        const a = words.length === 0 ? splitAssignment(t.w) : null;
        if (a) {
          this.next();
          const marker: Part = { s: '\u0002+=', q: 's' };
          if (!a.value.length && this.isOp('(') && a.index === undefined) {
            assigns.push({ name: a.name, value: a.append ? [marker] : [], array: this.parseArrayWords() });
            continue;
          }
          assigns.push({ name: a.name, value: a.append ? [marker, ...a.value] : a.value, ...(a.index ? { index: a.index } : {}) });
          continue;
        }
        // declare -a list=(a b), local -A map=([k]=v)
        if (words.length && txt !== null && /^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(txt) && this.isOp('(', this.toks[this.i + 1]) && /^(declare|local|readonly|typeset|export)$/.test(this.wordText({ t: 'word', w: words[0], line }) ?? '')) {
          this.next();
          words.push(t.w);
          arrays.push({ at: words.length - 1, words: this.parseArrayWords() });
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
    return { t: 'simple', words, redirs, assigns, line, ...(arrays.length ? { arrays } : {}) };
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
    return this.withRedirs({ t: 'if', branches, else: elseBody });
  }

  /** Compound commands may be followed by redirections: while ...; done < file. */
  withRedirs(node: Node): Node {
    const redirs = this.parseRedirs();
    return redirs.length ? { t: 'group', body: node, sub: false, redirs } : node;
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
      return this.withRedirs({ t: 'cfor', init, cond, step, body });
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
    return this.withRedirs({ t: 'for', name, words, body });
  }

  parseWhile(until: boolean): Node {
    this.next();
    const cond = this.parseList(new Set(['do']));
    this.expectWord('do');
    const body = this.parseList(new Set(['done']));
    this.expectWord('done');
    return this.withRedirs({ t: 'while', cond, body, until });
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
    return this.withRedirs({ t: 'case', word: w.w, items });
  }
}

/**
 * Recognises an assignment word: name=value, name+=value, name[sub]=value (the subscript may be
 * quoted: map["a b"]=1). Returns the pieces, or null for an ordinary word.
 */
function splitAssignment(w: Word): { name: string; index?: Word; value: Word; append: boolean } | null {
  const first = w[0];
  if (!first || first.q !== 'n') return null;
  const simple = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/.exec(first.s);
  if (simple) {
    const head: Part = { s: first.s.slice(simple[0].length), q: 'n' };
    return { name: simple[1], value: [head, ...w.slice(1)].filter((p) => p.s !== '' || p.q !== 'n'), append: simple[2] === '+=' };
  }
  const open = /^([A-Za-z_][A-Za-z0-9_]*)\[/.exec(first.s);
  if (!open) return null;
  // Collect the subscript up to "]=" or "]+=" in an unquoted part.
  const index: Word = [];
  let rest = first.s.slice(open[0].length);
  for (let k = 0; k < w.length; k++) {
    const p = k === 0 ? { s: rest, q: 'n' as const } : w[k];
    const m = p.q === 'n' ? /\](\+?=)/.exec(p.s) : null;
    if (!m) {
      if (p.s) index.push(p);
      continue;
    }
    if (m.index) index.push({ s: p.s.slice(0, m.index), q: 'n' });
    rest = p.s.slice(m.index + m[0].length);
    const value: Word = [{ s: rest, q: 'n' as const }, ...w.slice(k + 1)].filter((x) => x.s !== '' || x.q !== 'n');
    return { name: open[1], index, value, append: m[1] === '+=' };
  }
  return null;
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
  /** A command line to run after the editor saves (git continues a commit or rebase). */
  then?: string;
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
  /** set -a: assignments are exported. */
  allexport?: boolean;
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
  /** One frame per running function: the values that `local` hid, restored on return. */
  locals?: Array<Record<string, string | undefined>>;
  /** trap handlers of this shell (EXIT, ERR, INT, TERM, HUP). */
  traps?: Record<string, string>;
  pipefail?: boolean;
  /** Status of the last command substitution: the status of a pure assignment such as x=$(cmd). */
  substStatus?: number;
  inTrap?: boolean;
}

export function newSession(sys: ShellSystem): Pick<Ctx, 'vars' | 'exported' | 'funcs' | 'status'> {
  return { vars: { ...sys.env }, exported: new Set(Object.keys(sys.env)), funcs: {}, status: 0 };
}

export function makeCtx(sys: ShellSystem, session?: Pick<Ctx, 'vars' | 'exported' | 'funcs' | 'status'>): Ctx {
  const s = session ?? newSession(sys);
  return { sys, vars: s.vars, exported: s.exported, funcs: s.funcs, params: [], scriptName: 'bash', status: s.status, errexit: false, nounset: false, xtrace: false, condDepth: 0, loopDepth: 0, depth: 0, requests: [], steps: 0, locals: [], traps: {} };
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
  if (name === 'LINENO') return ctx.vars.LINENO ?? '1';
  const v = ctx.vars[name];
  if (v === undefined && ctx.vars[ARR + name] !== undefined) return getArr(ctx, name)!.v['0'];
  return v;
}

function setVar(ctx: Ctx, name: string, value: string): void {
  if (ctx.vars[RO + name] !== undefined) throw new ShellError(`${name}: readonly variable`, 1);
  if (ctx.vars[ARR + name] !== undefined) {
    const a = getArr(ctx, name)!;
    a.v['0'] = value;
    putArr(ctx, name, a);
    return;
  }
  ctx.vars[name] = value;
  // set -a (allexport) exports every variable that is assigned.
  if (ctx.allexport) ctx.exported.add(name);
  if (name === 'PATH' || ctx.exported.has(name)) ctx.sys.env[name] = value;
}

/* Arrays live in the variables under a private prefix as JSON, so subshells copy them like any variable. */
const ARR = '__arr_';
const RO = '__ro_';
/** Prefixes of internal variables that `set` and `declare -p` do not list. */
const HIDDEN = /^__(alias|arr|ro|getopts)_/;

export interface ShArray {
  assoc: boolean;
  v: Record<string, string>;
}

export function getArr(ctx: Ctx, name: string): ShArray | undefined {
  const raw = ctx.vars[ARR + name];
  return raw === undefined ? undefined : (JSON.parse(raw) as ShArray);
}

function putArr(ctx: Ctx, name: string, a: ShArray): void {
  if (ctx.vars[RO + name] !== undefined) throw new ShellError(`${name}: readonly variable`, 1);
  ctx.vars[ARR + name] = JSON.stringify(a);
  delete ctx.vars[name];
}

/** Sets an indexed array from a list (BASH_REMATCH, read -a, mapfile). */
export function setArr(ctx: Ctx, name: string, values: string[]): void {
  putArr(ctx, name, { assoc: false, v: Object.fromEntries(values.map((x, i) => [String(i), x])) });
}

function arrKeys(a: ShArray): string[] {
  return a.assoc ? Object.keys(a.v) : Object.keys(a.v).map(Number).sort((x, y) => x - y).map(String);
}

export function arrValues(a: ShArray): string[] {
  return arrKeys(a).map((k) => a.v[k]);
}

/** The key a subscript names: arithmetic for indexed arrays (negative counts from the end), text for associative ones. */
function subscriptKey(ctx: Ctx, a: ShArray | undefined, raw: string, expanded = false): string {
  if (a?.assoc) return expanded ? raw : expandText(ctx, raw, true);
  let n = evalArith(ctx, raw);
  if (n < 0 && a) {
    const keys = arrKeys(a).map(Number);
    n = (keys.length ? keys[keys.length - 1] + 1 : 0) + n;
  }
  return String(n);
}

/** Records the current value of a variable in the innermost function frame, so `local` can restore it. */
function declareLocal(ctx: Ctx, name: string): void {
  const frame = ctx.locals?.[ctx.locals.length - 1];
  if (!frame) return;
  for (const k of [name, ARR + name, RO + name]) if (!Object.prototype.hasOwnProperty.call(frame, k)) frame[k] = ctx.vars[k];
}

/** Builds an array from the words of a literal: plain values, or [key]=value pairs. */
function arrayFromWords(ctx: Ctx, words: Word[]): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = [];
  for (const w of words) {
    const keyed = w[0]?.q === 'n' ? /^\[([^\]]*)\]=/.exec(w[0].s) : null;
    if (keyed) {
      const rest: Word = [{ s: w[0].s.slice(keyed[0].length), q: 'n' }, ...w.slice(1)];
      out.push([keyed[1], expandSingle(ctx, rest)]);
    } else for (const f of expandWord(ctx, w)) out.push([null, f]);
  }
  return out;
}

function assignArray(ctx: Ctx, name: string, pairs: Array<[string | null, string]>, append: boolean, assoc?: boolean): void {
  const prev = getArr(ctx, name);
  const isAssoc = assoc ?? prev?.assoc ?? false;
  const a: ShArray = append && prev ? prev : { assoc: isAssoc, v: {} };
  if (append && !prev && ctx.vars[name] !== undefined) a.v['0'] = ctx.vars[name];
  let next = isAssoc ? 0 : arrKeys(a).length ? Number(arrKeys(a)[arrKeys(a).length - 1]) + 1 : 0;
  for (const [k, v] of pairs) {
    if (k !== null) {
      const key = isAssoc ? expandText(ctx, k, true) : String(evalArith(ctx, k));
      a.v[key] = v;
      if (!isAssoc) next = Number(key) + 1;
    } else if (isAssoc) throw new ShellError(`${name}: ${v}: must use subscript when assigning associative array`, 1);
    else a.v[String(next++)] = v;
  }
  putArr(ctx, name, a);
}

function assignElement(ctx: Ctx, name: string, sub: string, value: string, append: boolean): void {
  const a = getArr(ctx, name) ?? { assoc: false, v: ctx.vars[name] !== undefined ? { '0': ctx.vars[name] } : {} };
  const key = subscriptKey(ctx, a, sub, true);
  a.v[key] = append ? (a.v[key] ?? '') + value : value;
  putArr(ctx, name, a);
}

/** Performs one assignment from a command line. */
function doAssign(ctx: Ctx, a: Assign): void {
  const append = a.value[0]?.s === '\u0002+=' && a.value[0].q === 's';
  if (a.array) {
    assignArray(ctx, a.name, arrayFromWords(ctx, a.array), append);
    return;
  }
  const value = expandSingle(ctx, append ? a.value.slice(1) : a.value);
  if (a.index) {
    assignElement(ctx, a.name, expandSingle(ctx, a.index), value, append);
    return;
  }
  setVar(ctx, a.name, append ? (getVar(ctx, a.name) ?? '') + value : value);
}

function patternToRegex(pat: string, anchor: 'start' | 'end' | 'full', greedy: boolean): RegExp {
  let re = '';
  for (const c of pat) {
    if (c === '*') re += greedy ? '[\\s\\S]*' : '[\\s\\S]*?';
    else if (c === '?') re += '[\\s\\S]';
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
    if (c === '\\' && i + 1 < pat.length) re += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (c === '*') re += '.*';
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

/** The values an array expansion such as ${name[@]}, ${!name[@]} or ${name[@]:1:2} produces. */
function arrayList(ctx: Ctx, inner: string): string[] | null {
  // ${@:2} and ${*:1:3}: a slice of the positional parameters, where offset 0 is $0.
  const p = /^[@*]:\s*(-?\d+|[^:]+)(?::(.+))?$/.exec(inner);
  if (p) {
    const all = [ctx.scriptName, ...ctx.params];
    let off = evalArith(ctx, p[1]);
    if (off < 0) off = Math.max(1, all.length + off);
    return p[2] !== undefined ? all.slice(off, off + evalArith(ctx, p[2])) : all.slice(off);
  }
  const m = /^(!?)([A-Za-z_][A-Za-z0-9_]*)\[[@*]\](?::\s*(-?\d+|[^:]+)(?::(.+))?)?$/.exec(inner);
  if (!m) return null;
  const a = getArr(ctx, m[2]);
  let list = a ? (m[1] ? arrKeys(a) : arrValues(a)) : ctx.vars[m[2]] !== undefined ? (m[1] ? ['0'] : [ctx.vars[m[2]]]) : [];
  if (m[3] !== undefined) {
    let off = evalArith(ctx, m[3]);
    if (off < 0) off = Math.max(0, list.length + off);
    list = m[4] !== undefined ? list.slice(off, off + evalArith(ctx, m[4])) : list.slice(off);
  }
  return list;
}

function expandParam(ctx: Ctx, inner: string): string {
  // ${name[@]} and friends, unquoted or quoted as one word: joined with spaces.
  const list = arrayList(ctx, inner);
  if (list) return list.join(' ');
  // ${#name}, ${#name[@]}, ${#name[i]}
  let m = /^#([A-Za-z_][A-Za-z0-9_]*|[@*#?])$/.exec(inner);
  if (m) return m[1] === '@' || m[1] === '*' ? String(ctx.params.length) : String((getVar(ctx, m[1]) ?? '').length);
  m = /^#([A-Za-z_][A-Za-z0-9_]*)\[([^\]]*)\]$/.exec(inner);
  if (m) {
    const a = getArr(ctx, m[1]);
    if (m[2] === '@' || m[2] === '*') return String(a ? Object.keys(a.v).length : ctx.vars[m[1]] !== undefined ? 1 : 0);
    return String((a?.v[subscriptKey(ctx, a, m[2])] ?? '').length);
  }
  // ${!name}: indirect expansion.
  m = /^!([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner);
  if (m) return getVar(ctx, getVar(ctx, m[1]) ?? '') ?? '';
  m = /^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$])(\[[^\]]*\])?(.*)$/s.exec(inner);
  if (!m) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  const name = m[1];
  const rest = m[3];
  let val: string | undefined;
  let set = (v: string) => setVar(ctx, name, v);
  if (m[2]) {
    const a = getArr(ctx, name);
    const key = subscriptKey(ctx, a, m[2].slice(1, -1));
    val = a ? a.v[key] : key === '0' ? ctx.vars[name] : undefined;
    set = (v: string) => assignElement(ctx, name, key, v, false);
  } else val = getVar(ctx, name);
  if (rest === '') {
    if (val === undefined && ctx.nounset) throw new ShellError(`${name}: unbound variable`, 1);
    return val ?? '';
  }
  let op = /^(:-|:=|:\+|:\?|-|=|\+|\?|##|#|%%|%|\/\/|\/|\^\^|\^|,,|,|:)/.exec(rest)?.[1];
  if (!op) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  // $'\n' in the word of ${resp##*$'\n'} is ANSI-C quoted text; \u0001 marks each character literal.
  const esc: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?', '0': '\0' };
  const arg = rest.slice(op.length).replace(/\$'((?:\\.|[^'\\])*)'/g, (_m, body: string) => body.replace(/\\(.)/g, (_e, ch: string) => esc[ch] ?? '\\' + ch).replace(/[\s\S]/g, (ch) => '\u0001' + ch));
  const unsetOrNull = val === undefined || (op.startsWith(':') && val === '');
  switch (op) {
    case ':-':
    case '-':
      return unsetOrNull ? expandText(ctx, arg, true) : val!;
    case ':=':
    case '=':
      if (unsetOrNull) {
        const v = expandText(ctx, arg, true);
        set(v);
        return v;
      }
      return val!;
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
      const repText = expandText(ctx, rep, true).replace(/\\\\/g, '\\');
      return v.replace(new RegExp(src, op === '//' ? 'g' : ''), () => repText);
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
      const end = matchBrace(text, i + 1);
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
  // $(< file) reads the file without running a command.
  const redirOnly = /^\s*<\s*(\S+)\s*$/.exec(src);
  if (redirOnly) {
    const path = resolvePath(ctx.sys.cwd, expandText(ctx, redirOnly[1], true), homeOf(ctx.sys, currentUser(ctx)));
    try {
      ctx.substStatus = 0;
      return readFile(ctx.sys.fs, path, actor(ctx)).replace(/\n+$/, '');
    } catch (e) {
      ctxErr(ctx, `bash: ${redirOnly[1]}: ${(e as Error).message.replace(/^.*?: /, '')}\n`);
      ctx.substStatus = 1;
      return '';
    }
  }
  const sub: Ctx = { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported), depth: ctx.depth + 1, condDepth: 0, loopDepth: 0, traps: {} };
  if (sub.depth > 40) throw new ShellError('command substitution nested too deeply', 1);
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: (s) => ctxErr(ctx, s) };
  try {
    const node = parse(src);
    const code = exec(sub, node, io);
    ctx.substStatus = code;
  } catch (e) {
    if (e instanceof ExitSignal) ctx.substStatus = e.code;
    else throw e;
  }
  ctx.requests.push(...sub.requests);
  return buf.join('').replace(/\n+$/, '');
}

const errSink = new WeakMap<Ctx, (s: string) => void>();
function ctxErr(ctx: Ctx, s: string): void {
  errSink.get(ctx)?.(s);
}

/**
 * Splits double-quoted text holding "$@" or "${name[@]}" into fields: text before the first
 * element joins it, text after the last element joins that. Null when there is no such expansion;
 * an empty list when the elements are empty and nothing else is in the quotes.
 */
function quotedFields(ctx: Ctx, s: string): string[] | null {
  const segs: Array<{ text: string } | { list: string[] }> = [];
  let text = '';
  let found = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\u0001') {
      text += c + (s[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const end = matchParen(s, i + 1);
      text += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      text += s.slice(i, end === -1 ? s.length : end + 1);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === '$' && s[i + 1] === '@') {
      segs.push({ text }, { list: [...ctx.params] });
      text = '';
      found = true;
      i++;
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = matchBrace(s, i + 1);
      const inner = s.slice(i + 2, end);
      const list = inner === '@' ? [...ctx.params] : /\[@\]|^@:/.test(inner) ? arrayList(ctx, inner) : null;
      if (list) {
        segs.push({ text }, { list });
        text = '';
        found = true;
      } else text += s.slice(i, end + 1);
      i = end;
      continue;
    }
    text += c;
  }
  if (!found) return null;
  segs.push({ text });
  const fields: string[] = [''];
  let any = false;
  for (const seg of segs) {
    if ('text' in seg) {
      const t = expandText(ctx, seg.text, true);
      if (t) any = true;
      fields[fields.length - 1] += t;
    } else if (seg.list.length) {
      any = true;
      fields[fields.length - 1] += seg.list[0];
      fields.push(...seg.list.slice(1));
    }
  }
  return any ? fields : [];
}

/** Expands a word into fields (after splitting and globbing). */
export function expandWord(ctx: Ctx, word: Word): string[] {
  const fields: Array<{ s: string; glob: boolean; quoted: boolean }> = [];
  let cur = '';
  let curGlob = false;
  let quoted = false;
  let any = false;
  let vanished = false;
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
      // "$@" and "${name[@]}" expand to one field per element.
      const multi = quotedFields(ctx, part.s);
      if (multi) {
        if (multi.length === 0) {
          vanished = true;
          return;
        }
        multi.forEach((p, k) => {
          if (k === 0) cur += protect(p);
          else {
            fields.push({ s: cur, glob: curGlob, quoted: true });
            cur = protect(p);
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
  if (cur !== '' || quoted || (!any && !vanished)) fields.push({ s: cur, glob: curGlob, quoted });
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

export function evalArith(ctx: Ctx, raw: string): number {
  // Parameter, command and nested arithmetic expansion happen before evaluation: $(( b + $(wc -c < f) )), $(( $2 + 1 )).
  let src = raw.includes('$') ? expandText(ctx, raw, true) : raw;
  // Array elements read in arithmetic: total + nums[i].
  src = src.replace(/([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\](?!\s*(?:=[^=]|[-+*/%]=|\+\+|--))/g, (_m, name: string, sub: string) => {
    const a = getArr(ctx, name);
    const v = a ? a.v[subscriptKey(ctx, a, sub)] : undefined;
    return String(Number(v ?? 0) || 0);
  });
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
  // Files created by > and >> get the shell's umask.
  setUmask(ctx.sys.umask);
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
    if (r.op === '<<<') {
      stdin = expandSingle(ctx, r.target!) + '\n';
      continue;
    }
    if (r.proc) {
      const buf: string[] = [];
      const sub: Ctx = { ...ctx, vars: { ...ctx.vars }, exported: new Set(ctx.exported), condDepth: 0, loopDepth: 0, traps: {} };
      try {
        exec(sub, r.proc, { stdin: '', out: (s) => buf.push(s), err: io.err });
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e;
      }
      stdin = buf.join('');
      continue;
    }
    if (r.op === '>&') {
      // 2>&1 copies wherever standard output points now: "2>&1 >/dev/null" keeps errors on the old stdout.
      if (r.fd === 2) {
        if (outTarget) errTarget = outTarget;
        else if (outToErr) errToOut = false;
        else errToOut = true;
      } else {
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
    // An unquoted expansion that splits into several words (or none) cannot name one file.
    if (r.target!.some((p) => p.q === 'n' && p.s.includes('$')) && expandWord(ctx, r.target!).length !== 1) throw new FsError('ENOENT', `${r.target!.map((p) => p.s).join('')}: ambiguous redirect`);
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
  const err = errTarget ? (errTarget === outTarget ? (s: string) => outBuf.push(s) : (s: string) => errBuf.push(s)) : errToOut ? io.out : io.err;
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
    tty: outTarget || outToErr ? false : io.tty,
  };
  const finish = () => {
    if (outTarget && outTarget.path !== '/dev/null') writeFile(ctx.sys.fs, outTarget.path, outBuf.join(''), actor(ctx), ctx.sys.now, true);
    if (errTarget && errTarget.path !== '/dev/null' && errTarget !== outTarget) writeFile(ctx.sys.fs, errTarget.path, errBuf.join(''), actor(ctx), ctx.sys.now, true);
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
      let failed = 0;
      for (let k = 0; k < node.cmds.length; k++) {
        const last = k === node.cmds.length - 1;
        const buf: string[] = [];
        const stageIo: IO = { stdin: input, out: last ? io.out : (s) => buf.push(s), err: io.err, tty: last ? io.tty : false };
        const saveStatus = ctx.status;
        if (!last || node.negate) ctx.condDepth++;
        try {
          code = exec(ctx, node.cmds[k], stageIo);
        } finally {
          if (!last || node.negate) ctx.condDepth--;
        }
        if (code !== 0) failed = code;
        if (!last) ctx.status = saveStatus;
        input = buf.join('');
      }
      // set -o pipefail: the pipeline fails if any stage failed (the last stage reported its own failure).
      const lastCode = code;
      if (ctx.pipefail && failed) code = failed;
      const final = node.negate ? (code === 0 ? 1 : 0) : code;
      ctx.status = final;
      if (final !== 0 && ctx.condDepth === 0 && !node.negate && final !== lastCode) failure(ctx, final, io);
      return final;
    }
    case 'cond': {
      if (ctx.xtrace) trace(ctx, io, ['[[', ...condWords(ctx, node.items), ']]']);
      const code = evalCond(ctx, node.items, io);
      ctx.status = code;
      if (code !== 0 && ctx.condDepth === 0) failure(ctx, code, io);
      return code;
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
        if (item.patterns.some((p) => globMatch(patternOf(ctx, p), w))) return exec(ctx, item.body, io);
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
      if (ctx.status !== 0 && ctx.condDepth === 0) failure(ctx, ctx.status, io);
      return ctx.status;
    }
    case 'simple':
      return execSimple(ctx, node, io);
  }
}

/** A command failed outside a condition: run the ERR trap, then stop the script under set -e. */
function failure(ctx: Ctx, code: number, io: IO): void {
  const handler = ctx.traps?.ERR;
  if (handler && !ctx.inTrap) runTrap(ctx, handler, io, code);
  if (ctx.errexit) throw new ExitSignal(code);
}

function runTrap(ctx: Ctx, handler: string, io: IO, status: number): void {
  ctx.inTrap = true;
  ctx.status = status;
  try {
    exec(ctx, parse(handler), io);
  } finally {
    ctx.inTrap = false;
    ctx.status = status;
  }
}

/** Runs the EXIT trap of a finishing script; an exit inside the trap changes the status. */
function runExitTrap(ctx: Ctx, io: IO, code: number): number {
  const handler = ctx.traps?.EXIT;
  if (!handler) return code;
  delete ctx.traps!.EXIT;
  try {
    runTrap(ctx, handler, io, code);
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    if (e instanceof ShellError) {
      io.err(`${ctx.scriptName}: ${e.message}\n`);
      return code;
    }
    throw e;
  }
  return code;
}

/** Glob pattern from a word for [[ == ]]: quoted parts match literally. */
function patternOf(ctx: Ctx, w: Word): string {
  return w.map((p) => (p.q === 'n' ? expandText(ctx, p.s, false) : (p.q === 'd' ? expandText(ctx, p.s, true) : p.s).replace(/[*?[\]\\]/g, '\\$&'))).join('');
}

/** Regular expression from a word for [[ =~ ]]: quoted parts match literally. */
function regexOf(ctx: Ctx, w: Word): string {
  return w.map((p) => (p.q === 'n' ? expandText(ctx, p.s, false) : (p.q === 'd' ? expandText(ctx, p.s, true) : p.s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('');
}

/** Evaluates [[ ... ]]: 0 true, 1 false, 2 a syntax error. */
/** The words of a [[ ]] test after expansion, for set -x. */
function condWords(ctx: Ctx, items: Array<{ w: Word } | { op: string }>): string[] {
  return items.map((it) => ('op' in it ? it.op : expandSingle(ctx, it.w)));
}

function evalCond(ctx: Ctx, items: Array<{ w: Word } | { op: string }>, io: IO): number {
  let i = 0;
  const isOp = (s: string) => {
    const it = items[i];
    return !!it && (('op' in it && it.op === s) || ('w' in it && it.w.length === 1 && it.w[0].q === 'n' && it.w[0].s === s));
  };
  const word = (): Word | null => {
    const it = items[i];
    return it && 'w' in it ? it.w : null;
  };
  const text = (w: Word) => expandSingle(ctx, w);
  const fileOf = (p: string) => {
    try {
      return lookup(ctx.sys.fs, resolvePath(ctx.sys.cwd, p, homeOf(ctx.sys, currentUser(ctx))), actor(ctx));
    } catch {
      return null;
    }
  };
  const UNARY = new Set(['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-L', '-h', '-O', '-G', '-u', '-g', '-k', '-v']);
  const num = (s: string) => {
    if (/^-?\d+$/.test(s.trim())) return Number(s);
    return evalArith(ctx, s);
  };
  function or(): boolean {
    let v = and();
    while (isOp('||')) {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  }
  function and(): boolean {
    let v = not();
    while (isOp('&&')) {
      i++;
      const r = not();
      v = v && r;
    }
    return v;
  }
  function not(): boolean {
    if (isOp('!')) {
      i++;
      return !not();
    }
    return primary();
  }
  function primary(): boolean {
    if (isOp('(')) {
      i++;
      const v = or();
      if (!isOp(')')) throw new ShellSyntaxError("syntax error in [[ ]]: expected ')'");
      i++;
      return v;
    }
    const w = word();
    if (!w) throw new ShellSyntaxError('syntax error in [[ ]]: expected an operand');
    const w0 = w.length === 1 && w[0].q === 'n' ? w[0].s : null;
    if (w0 && UNARY.has(w0) && items[i + 1] && 'w' in items[i + 1]) {
      const nextItem = items[i + 2];
      const binaryFollows = nextItem && (('op' in nextItem && (nextItem.op === '<' || nextItem.op === '>')) || ('w' in nextItem && nextItem.w.length === 1 && nextItem.w[0].q === 'n' && /^(==?|!=|=~|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot)$/.test(nextItem.w[0].s)));
      if (!binaryFollows) {
        i += 2;
        const a = text((items[i - 1] as { w: Word }).w);
        if (w0 === '-z') return a === '';
        if (w0 === '-n') return a !== '';
        if (w0 === '-v') return getVar(ctx, a) !== undefined || ctx.vars[ARR + a.replace(/\[.*$/, '')] !== undefined;
        const f = fileOf(a);
        if (!f) return false;
        const n = f.node;
        switch (w0) {
          case '-e': return true;
          case '-f': return n.type === 'file';
          case '-d': return n.type === 'dir';
          case '-L': case '-h': return n.type === 'link';
          case '-r': return can(n, actor(ctx), 'r');
          case '-w': return can(n, actor(ctx), 'w');
          case '-x': return can(n, actor(ctx), 'x');
          case '-s': return n.type === 'file' && n.content.length > 0;
          case '-O': return n.owner === actor(ctx).user;
          case '-G': return n.group === actor(ctx).groups[0];
          case '-u': return (n.mode & 0o4000) !== 0;
          case '-g': return (n.mode & 0o2000) !== 0;
          case '-k': return (n.mode & 0o1000) !== 0;
        }
        return false;
      }
    }
    i++;
    const left = text(w);
    const opItem = items[i];
    const op = !opItem ? null : 'op' in opItem ? (opItem.op === '<' || opItem.op === '>' ? opItem.op : null) : opItem.w.length === 1 && opItem.w[0].q === 'n' ? opItem.w[0].s : null;
    if (!op || !/^(==?|!=|=~|<|>|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot|-ef)$/.test(op)) return left !== '';
    i++;
    if (op === '=~') {
      // The regex runs to the next && or || (unquoted parentheses and | belong to it).
      let src = '';
      while (i < items.length && !isOp('&&') && !isOp('||')) {
        const it = items[i++];
        src += 'op' in it ? it.op : regexOf(ctx, it.w);
      }
      let re: RegExp;
      try {
        re = new RegExp(src);
      } catch {
        throw new ShellSyntaxError(`invalid regular expression: ${src}`);
      }
      const m = re.exec(left);
      setArr(ctx, 'BASH_REMATCH', m ? m.map((g) => g ?? '') : []);
      return !!m;
    }
    const rw = word();
    if (!rw) throw new ShellSyntaxError(`syntax error in [[ ]]: ${op} needs a right operand`);
    i++;
    switch (op) {
      case '=':
      case '==':
        return globMatch(patternOf(ctx, rw), left);
      case '!=':
        return !globMatch(patternOf(ctx, rw), left);
      case '<':
        return left < text(rw);
      case '>':
        return left > text(rw);
      case '-eq': return num(left) === num(text(rw));
      case '-ne': return num(left) !== num(text(rw));
      case '-lt': return num(left) < num(text(rw));
      case '-le': return num(left) <= num(text(rw));
      case '-gt': return num(left) > num(text(rw));
      case '-ge': return num(left) >= num(text(rw));
      case '-nt': { const a = fileOf(left); const b = fileOf(text(rw)); return !!a && (!b || a.node.mtime > b.node.mtime); }
      case '-ot': { const a = fileOf(left); const b = fileOf(text(rw)); return !!b && (!a || a.node.mtime < b.node.mtime); }
      case '-ef': { const a = fileOf(left); const b = fileOf(text(rw)); return !!a && !!b && a.node === b.node; }
    }
    return false;
  }
  try {
    const v = or();
    if (i < items.length) throw new ShellSyntaxError(`syntax error in conditional expression near '${'op' in items[i] ? (items[i] as { op: string }).op : text((items[i] as { w: Word }).w)}'`);
    return v ? 0 : 1;
  } catch (e) {
    if (e instanceof ShellSyntaxError || e instanceof ShellError) {
      io.err(`bash: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

const SHELL_BUILTINS = new Set([':', 'cd', 'export', 'unset', 'set', 'shift', 'exit', 'return', 'break', 'continue', 'source', '.', 'read', 'local', 'declare', 'let', 'eval', 'exec', 'alias', 'unalias', 'type', 'command', 'builtin', 'umask', 'history', 'help', 'pushd', 'popd', 'dirs', 'logout', 'bash', 'sh', 'hash', 'getopts', 'trap', 'wait', 'jobs', 'fg', 'bg', 'readonly', 'typeset', 'mapfile', 'readarray']);

/** set -x: one trace line, prefixed with the expanded PS4 ("+ " by default), on standard error. */
function trace(ctx: Ctx, io: IO, words: string[], assignment = false): void {
  const q = (w: string) => (w === '[[' || w === ']]' ? w : w === '' ? "''" : /[\s'"$`\\|&;<>()*?[\]{}!#~]/.test(w) ? `'${w.replace(/'/g, "'\\''")}'` : w);
  let ps4 = '+ ';
  try {
    ps4 = expandText(ctx, ctx.vars.PS4 ?? '+ ', true);
  } catch {
    /* keep the default */
  }
  // An assignment shows as name=value with only the value quoted.
  const shown = assignment ? words.map((w) => w.slice(0, w.indexOf('=') + 1) + (w.slice(w.indexOf('=') + 1) === '' ? '' : q(w.slice(w.indexOf('=') + 1)))) : words.map(q);
  io.err(ps4 + shown.join(' ') + '\n');
}

function execSimple(ctx: Ctx, node: Extract<Node, { t: 'simple' }>, io: IO): number {
  if (!ctx.inTrap) ctx.vars.LINENO = String(node.line);
  // declare/local name=(...) arrives as "name=" + \u0006 + JSON of [key, value] pairs.
  const words = node.arrays
    ? node.words.flatMap((w, k) => {
        const arr = node.arrays!.find((a) => a.at === k);
        return arr ? [expandSingle(ctx, w) + '\u0006' + JSON.stringify(arrayFromWords(ctx, arr.words))] : expandWord(ctx, w);
      })
    : expandWords(ctx, node.words);
  if (words.length === 0) {
    // Pure assignments: $? still refers to the previous command while they expand; a command
    // substitution in them then becomes their status (x=$(false) fails).
    ctx.substStatus = undefined;
    let assignStatus = 0;
    try {
      for (const a of node.assigns) {
        doAssign(ctx, a);
        if (ctx.xtrace) trace(ctx, io, [`${a.name}=${ctx.vars[a.name] ?? ''}`], true);
      }
      assignStatus = ctx.substStatus ?? 0;
    } catch (e) {
      if (!(e instanceof ShellError)) throw e;
      io.err(`bash: ${e.message}\n`);
      assignStatus = e.code;
    }
    ctx.status = assignStatus;
    if (node.redirs.length) {
      const r = applyRedirs(ctx, node.redirs, io);
      r.finish();
    }
    const code = ctx.status;
    if (code !== 0 && ctx.condDepth === 0) failure(ctx, code, io);
    return code;
  }
  // Temporary environment assignments (VAR=x cmd) just set the variables for us.
  const saved: Record<string, string | undefined> = {};
  const tempExports: string[] = [];
  for (const a of node.assigns) {
    saved[a.name] = ctx.vars[a.name];
    doAssign(ctx, a);
    if (!ctx.exported.has(a.name)) {
      ctx.exported.add(a.name);
      tempExports.push(a.name);
    }
  }
  if (!ctx.inTrap) ctx.vars.BASH_COMMAND = words.join(' ');
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
      if (ctx.condDepth === 0) failure(ctx, 1, io);
      return 1;
    }
    throw e;
  }
  let code: number;
  try {
    if (ctx.xtrace) trace(ctx, io, words);
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
    for (const k of tempExports) {
      ctx.exported.delete(k);
      if (ctx.sys.env[k] !== undefined && !(k in saved && saved[k] !== undefined)) delete ctx.sys.env[k];
    }
  }
  ctx.status = code;
  ctx.steps++;
  if (code !== 0 && ctx.condDepth === 0) failure(ctx, code, io);
  return code;
}

/** Runs one command (function, builtin, simulated program or script) with already-expanded words. */
const ALIAS_PREFIX = '__alias_';

export function runCommand(ctx: Ctx, words: string[], io: IO): number {
  const alias = ctx.vars[ALIAS_PREFIX + words[0]];
  if (alias !== undefined && !ctx.funcs[words[0]]) {
    const expanded = alias.split(/\s+/).filter(Boolean);
    if (expanded[0] !== words[0]) return runCommand(ctx, [...expanded, ...words.slice(1)], io);
    words = [...expanded, ...words.slice(1)];
  }
  const [name, ...args] = words;
  // /bin/sh, /usr/bin/find, /usr/sbin/useradd ...: the system's own programs are the built-in commands.
  const sysBin = /^\/(?:usr\/)?s?bin\/([^/]+)$/.exec(name ?? '');
  if (sysBin && !lookup(ctx.sys.fs, name, actor(ctx))) {
    const prog = sysBin[1] === 'sh' || sysBin[1] === 'dash' ? 'bash' : sysBin[1];
    if (COMMANDS[prog] || SHELL_BUILTINS.has(prog)) return runCommand(ctx, [prog, ...args], io);
  }
  if ((name === 'sh' || name === 'dash') && !COMMANDS[name]) return runCommand(ctx, ['bash', ...args], io);
  // printf -v VAR FORMAT ARGS stores the result instead of printing it.
  if (name === 'printf' && args[0] === '-v' && args[1] && !ctx.funcs.printf) {
    const buf: string[] = [];
    const code = runCommand(ctx, ['printf', ...args.slice(2)], { ...io, out: (s) => buf.push(s) });
    const el = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(args[1]);
    if (el) assignElement(ctx, el[1], el[2], buf.join(''), false);
    else setVar(ctx, args[1], buf.join(''));
    return code;
  }
  if (ctx.funcs[name]) {
    const savedParams = ctx.params;
    const savedFunc = ctx.vars.FUNCNAME;
    ctx.params = args;
    ctx.vars.FUNCNAME = name;
    const frame: Record<string, string | undefined> = {};
    (ctx.locals ??= []).push(frame);
    try {
      return exec(ctx, ctx.funcs[name], io);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.code;
      throw e;
    } finally {
      ctx.params = savedParams;
      ctx.locals.pop();
      for (const [k, v] of Object.entries(frame)) {
        if (v === undefined) delete ctx.vars[k];
        else ctx.vars[k] = v;
      }
      if (savedFunc === undefined) delete ctx.vars.FUNCNAME;
      else ctx.vars.FUNCNAME = savedFunc;
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
/** The shell a script runs in: a copy of the caller's exported state, with its own traps and options. */
function scriptCtx(ctx: Ctx, args: string[], name: string, xtrace: boolean): Ctx {
  // A child process sees the environment: exported variables only (no arrays, aliases or readonly marks).
  const vars: Record<string, string> = { ...ctx.sys.env };
  for (const k of ctx.exported) if (ctx.vars[k] !== undefined) vars[k] = ctx.vars[k];
  vars.OPTIND = '1';
  vars.BASH_SOURCE = name;
  return { ...ctx, vars, exported: new Set(ctx.exported), funcs: {}, params: args, scriptName: name, errexit: false, nounset: false, xtrace, pipefail: false, condDepth: 0, loopDepth: 0, depth: ctx.depth + 1, locals: [], traps: {}, inTrap: false };
}

/** Runs a parsed script in its shell, then its EXIT trap; returns the exit status. */
function runInScript(sub: Ctx, src: string, name: string, io: IO): number {
  let code: number;
  try {
    const node = parse(src.replace(/^#!.*/, ''));
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
    } else if (e instanceof BreakSignal || e instanceof ContinueSignal) code = 0;
    else throw e;
  }
  return runExitTrap(sub, io, code);
}

export function runScript(ctx: Ctx, src: string, args: string[], name: string, io: IO): number {
  const sub = scriptCtx(ctx, args, name, false);
  if (sub.depth > 20) {
    io.err(`bash: ${name}: scripts nested too deeply\n`);
    return 1;
  }
  const savedCwd = ctx.sys.cwd;
  const savedUser = ctx.sys.user;
  const code = runInScript(sub, src, name, io);
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
    case 'unset': {
      const onlyFunc = args.includes('-f');
      for (const a of args.filter((x) => !x.startsWith('-'))) {
        const el = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(a);
        if (el) {
          const arr = getArr(ctx, el[1]);
          if (arr) {
            delete arr.v[subscriptKey(ctx, arr, el[2], arr.assoc)];
            putArr(ctx, el[1], arr);
          }
          continue;
        }
        if (ctx.vars[RO + a] !== undefined) {
          io.err(`bash: unset: ${a}: cannot unset: readonly variable\n`);
          return 1;
        }
        if (!onlyFunc) {
          delete ctx.vars[a];
          delete ctx.vars[ARR + a];
          delete sys.env[a];
          ctx.exported.delete(a);
        }
        if (onlyFunc || !args.includes('-v')) delete ctx.funcs[a];
      }
      return 0;
    }
    case 'readonly':
    case 'declare':
    case 'typeset':
    case 'local': {
      if (name === 'local' && !ctx.locals?.length) {
        io.err('bash: local: can only be used in a function\n');
        return 1;
      }
      const flags = args.filter((a) => /^[-+][aAirxgpfF]+$/.test(a)).join('');
      const names = args.filter((a) => !/^[-+][aAirxgpfF]+$/.test(a));
      if (flags.includes('p') || (name !== 'local' && !names.length && name === 'readonly')) {
        const list = names.length ? names : Object.keys(ctx.vars).filter((k) => !HIDDEN.test(k) && (name !== 'readonly' || ctx.vars[RO + k] !== undefined));
        let code = 0;
        for (const n of list) {
          const arr = getArr(ctx, n);
          if (arr) io.out(`declare -${arr.assoc ? 'A' : 'a'} ${n}=(${arrKeys(arr).map((k) => `[${k}]="${arr.v[k]}"`).join(' ')})\n`);
          else if (ctx.vars[n] !== undefined) io.out(`declare -${ctx.vars[RO + n] !== undefined ? 'r' : ctx.exported.has(n) ? 'x' : '-'} ${n}="${ctx.vars[n]}"\n`);
          else {
            io.err(`bash: declare: ${n}: not found\n`);
            code = 1;
          }
        }
        return code;
      }
      if (flags.includes('f') || flags.includes('F')) {
        for (const f of Object.keys(ctx.funcs).sort()) io.out(flags.includes('F') ? `declare -f ${f}\n` : `${f} ()\n{ ... }\n`);
        return 0;
      }
      // Inside a function, local and declare (without -g) make the names local.
      const makeLocal = !!ctx.locals?.length && (name === 'local' || ((name === 'declare' || name === 'typeset') && !flags.includes('g')));
      for (const a of names) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?(\+?=)?([\s\S]*)$/.exec(a);
        if (!m) {
          io.err(`bash: ${name}: \`${a}': not a valid identifier\n`);
          return 1;
        }
        const [, n, sub, op, raw] = m;
        if (makeLocal) declareLocal(ctx, n);
        const lit = raw.indexOf('\u0006');
        if (op && lit !== -1) assignArray(ctx, n, JSON.parse(raw.slice(lit + 1)) as Array<[string | null, string]>, op === '+=', flags.includes('A') ? true : flags.includes('a') ? false : undefined);
        else if (op && sub !== undefined) assignElement(ctx, n, sub, raw, op === '+=');
        else if (op) {
          if (flags.includes('a') || flags.includes('A')) assignArray(ctx, n, [[flags.includes('A') ? '0' : null, raw]], op === '+=', flags.includes('A'));
          else setVar(ctx, n, op === '+=' ? (getVar(ctx, n) ?? '') + raw : flags.includes('i') ? String(evalArith(ctx, raw)) : raw);
        } else if (flags.includes('A') || flags.includes('a')) {
          if (!getArr(ctx, n)) putArr(ctx, n, { assoc: flags.includes('A'), v: {} });
        } else if (makeLocal && name === 'local') delete ctx.vars[n];
        if (flags.includes('x')) {
          ctx.exported.add(n);
          if (ctx.vars[n] !== undefined) sys.env[n] = ctx.vars[n];
        }
        if (flags.includes('r') || name === 'readonly') ctx.vars[RO + n] = '1';
      }
      return 0;
    }
    case 'mapfile':
    case 'readarray': {
      let strip = false;
      let count = Infinity;
      const rest: string[] = [];
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '-t') strip = true;
        else if (args[k] === '-n') count = Number(args[++k]) || Infinity;
        else rest.push(args[k]);
      }
      const target = rest[0] ?? 'MAPFILE';
      const text = io.stdin;
      io.stdin = '';
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n').slice(0, count);
      setArr(ctx, target, strip ? lines : lines.map((l) => l + '\n'));
      return 0;
    }
    case 'set': {
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^[-+][aeuxoETBCHPfhkmnpvt]+$/.test(a)) {
          const on = a[0] === '-';
          if (a.includes('a')) ctx.allexport = on;
          if (a.includes('e')) ctx.errexit = on;
          if (a.includes('u')) ctx.nounset = on;
          if (a.includes('x')) ctx.xtrace = on;
          if (a.includes('o')) {
            const name = args[++k];
            if (name === undefined) {
              for (const [n, v] of [['errexit', ctx.errexit], ['nounset', ctx.nounset], ['pipefail', !!ctx.pipefail], ['xtrace', ctx.xtrace]] as const) io.out(`${n.padEnd(15)}\t${v ? 'on' : 'off'}\n`);
              continue;
            }
            if (name === 'errexit') ctx.errexit = on;
            else if (name === 'nounset') ctx.nounset = on;
            else if (name === 'xtrace') ctx.xtrace = on;
            else if (name === 'pipefail') ctx.pipefail = on;
            else if (name === 'allexport') ctx.allexport = on;
            else if (!['noclobber', 'noglob', 'posix', 'vi', 'emacs', 'history', 'monitor'].includes(name)) {
              io.err(`bash: set: ${name}: invalid option name\n`);
              return 1;
            }
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
      if (!args.length) {
        for (const k of Object.keys(ctx.vars).filter((x) => !HIDDEN.test(x)).sort()) io.out(`${k}=${ctx.vars[k]}\n`);
        for (const k of Object.keys(ctx.vars).filter((x) => x.startsWith(ARR)).sort()) {
          const a = getArr(ctx, k.slice(ARR.length))!;
          io.out(`${k.slice(ARR.length)}=(${arrKeys(a).map((key) => `[${key}]="${a.v[key]}"`).join(' ')})\n`);
        }
      }
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
      // bash -c 'script' NAME ARG...: NAME becomes $0 and the rest $1, $2, ...
      if (opts.includes('-c')) return runScript(ctx, args[i] ?? '', args.slice(i + 2), args[i + 1] ?? name, io);
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
      let arrayName: string | undefined;
      let delim = '\n';
      let nchars: number | undefined;
      // Options may be clustered (-ra arr, -rp "Name: "); one that takes a value uses the rest or the next word.
      while (args[i]?.startsWith('-') && args[i] !== '-') {
        const o = args[i];
        for (let k = 1; k < o.length; k++) {
          const f = o[k];
          if ('padntu'.includes(f)) {
            const v = k + 1 < o.length ? o.slice(k + 1) : args[++i] ?? '';
            if (f === 'p') prompt = v;
            else if (f === 'a') arrayName = v;
            else if (f === 'd') delim = v[0] ?? '\0';
            else if (f === 'n') nchars = Number(v);
            break;
          }
          if (f === 'r') raw = true;
        }
        i++;
      }
      const names = args.slice(i);
      if (prompt) io.err(prompt);
      if (io.stdin === '') {
        // End of input, or an interactive read: the simulator cannot wait for keystrokes.
        for (const n of names) setVar(ctx, n, '');
        if (!names.length && !arrayName) setVar(ctx, 'REPLY', '');
        if (io.interactive) io.err('(read: this simulator cannot wait for typed input; give it with a pipe or a here document, e.g. echo value | ./script.sh)\n');
        return 1;
      }
      // Without a final delimiter read still sets the variables but reports failure (the last-line trap).
      let end = nchars !== undefined ? Math.min(nchars, io.stdin.length) : io.stdin.indexOf(delim);
      const complete = end !== -1 && (nchars !== undefined || io.stdin[end] === delim);
      if (end === -1) end = io.stdin.length;
      let line = io.stdin.slice(0, end);
      io.stdin = io.stdin.slice(nchars !== undefined ? end : end + 1);
      if (!raw) line = line.replace(/\\(.)/g, '$1');
      if (arrayName) {
        const ifs = ctx.vars.IFS ?? ' \t\n';
        const parts = /^[ \t\n]*$/.test(ifs) ? line.trim().split(/[ \t]+/).filter(Boolean) : line.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]`));
        setArr(ctx, arrayName, parts);
        return complete ? 0 : 1;
      }
      if (!names.length) setVar(ctx, 'REPLY', line);
      else {
        // Split on IFS (default: whitespace); the last name takes the rest of the line unsplit.
        const ifs = ctx.vars.IFS ?? ' \t\n';
        const isWs = /^[ \t\n]*$/.test(ifs);
        let rest = isWs ? line.trim() : line;
        const sep = new RegExp(isWs ? '[ \\t]+' : `[${ifs.replace(/[\]\\^-]/g, '\\$&')}]`);
        names.forEach((n, k) => {
          if (k === names.length - 1) {
            setVar(ctx, n, rest);
            return;
          }
          const m = sep.exec(rest);
          setVar(ctx, n, m ? rest.slice(0, m.index) : rest);
          rest = m ? rest.slice(m.index + m[0].length) : '';
        });
      }
      return complete ? 0 : 1;
    }
    case 'let': {
      let v = 0;
      for (const a of args) v = evalArith(ctx, a);
      return v === 0 ? 1 : 0;
    }
    case 'eval':
      return exec(ctx, parse(args.join(' ')), io);
    case ':':
      return 0;
    case 'exec':
      return args.length ? runCommand(ctx, args, io) : 0;
    case 'alias': {
      // Aliases live in the session's variables under a private prefix.
      const all = Object.keys(ctx.vars).filter((k) => k.startsWith(ALIAS_PREFIX)).sort();
      if (!args.length) {
        for (const k of all) io.out(`alias ${k.slice(ALIAS_PREFIX.length)}='${ctx.vars[k]}'\n`);
        return 0;
      }
      let code = 0;
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) ctx.vars[ALIAS_PREFIX + a.slice(0, eq)] = a.slice(eq + 1);
        else if (ctx.vars[ALIAS_PREFIX + a] !== undefined) io.out(`alias ${a}='${ctx.vars[ALIAS_PREFIX + a]}'\n`);
        else {
          io.err(`bash: alias: ${a}: not found\n`);
          code = 1;
        }
      }
      return code;
    }
    case 'unalias':
      for (const a of args) delete ctx.vars[ALIAS_PREFIX + a];
      return 0;
    case 'hash':
    case 'wait':
      return 0;
    case 'trap': {
      const traps = (ctx.traps ??= {});
      const sig = (s: string) => {
        const u = s.toUpperCase().replace(/^SIG/, '');
        return u === '0' ? 'EXIT' : u === '2' ? 'INT' : u === '15' ? 'TERM' : u === '1' ? 'HUP' : u;
      };
      if (!args.length || args[0] === '-p') {
        for (const [s, h] of Object.entries(traps)) if (args.length < 2 || args.slice(1).map(sig).includes(s)) io.out(`trap -- '${h.replace(/'/g, "'\\''")}' ${s}\n`);
        return 0;
      }
      if (args[0] === '-l') {
        io.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM\n');
        return 0;
      }
      const [handler, ...sigs] = args[0] === '--' ? args.slice(1) : args;
      if (!sigs.length) {
        io.err('trap: usage: trap [-lp] [[arg] signal_spec ...]\n');
        return 2;
      }
      for (const s of sigs.map(sig)) {
        if (!['EXIT', 'ERR', 'INT', 'TERM', 'HUP', 'QUIT', 'USR1', 'USR2', 'RETURN', 'DEBUG'].includes(s)) {
          io.err(`bash: trap: ${s}: invalid signal specification\n`);
          return 1;
        }
        if (handler === '-') delete traps[s];
        else traps[s] = handler;
      }
      return 0;
    }
    case 'getopts':
      return getopts(ctx, args, io);
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

/**
 * getopts OPTSTRING NAME [ARGS]: one option per call, tracking OPTIND (and the position inside
 * clustered options like -vn in a private variable). A leading ":" in OPTSTRING selects silent errors.
 */
function getopts(ctx: Ctx, args: string[], io: IO): number {
  const [optstring = '', name = 'OPTARG', ...given] = args;
  const argv = given.length ? given : ctx.params;
  const silent = optstring.startsWith(':');
  const spec = silent ? optstring.slice(1) : optstring;
  let ind = Number(ctx.vars.OPTIND ?? '1') || 1;
  let pos = Number(ctx.vars.__getopts_pos ?? '1') || 1;
  const done = () => {
    setVar(ctx, name, '?');
    ctx.vars.OPTIND = String(ind);
    delete ctx.vars.__getopts_pos;
    return 1;
  };
  const arg = argv[ind - 1];
  if (arg === undefined) return done();
  if (pos === 1) {
    if (arg === '--') {
      ind++;
      return done();
    }
    if (!arg.startsWith('-') || arg === '-') return done();
  }
  const at = pos;
  const ch = arg[pos];
  const k = spec.indexOf(ch);
  const takesArg = k !== -1 && spec[k + 1] === ':';
  if (pos + 1 < arg.length && !takesArg) pos++;
  else {
    pos = 1;
    ind++;
  }
  delete ctx.vars.OPTARG;
  if (k === -1 || ch === ':') {
    if (silent) ctx.vars.OPTARG = ch;
    else io.err(`${ctx.scriptName}: illegal option -- ${ch}\n`);
    setVar(ctx, name, '?');
  } else if (takesArg) {
    const inline = arg.slice(at + 1);
    if (inline) ctx.vars.OPTARG = inline;
    else if (argv[ind - 1] !== undefined) ctx.vars.OPTARG = argv[ind++ - 1];
    else {
      if (silent) {
        ctx.vars.OPTARG = ch;
        setVar(ctx, name, ':');
      } else {
        io.err(`${ctx.scriptName}: option requires an argument -- ${ch}\n`);
        setVar(ctx, name, '?');
      }
      ctx.vars.OPTIND = String(ind);
      delete ctx.vars.__getopts_pos;
      return 0;
    }
    setVar(ctx, name, ch);
  } else setVar(ctx, name, ch);
  ctx.vars.OPTIND = String(ind);
  if (pos > 1) ctx.vars.__getopts_pos = String(pos);
  else delete ctx.vars.__getopts_pos;
  return 0;
}

function runScriptWithOpts(ctx: Ctx, src: string, args: string[], name: string, io: IO, opts: string[]): number {
  const flags = opts.filter((o) => /^-[a-z]+$/.test(o)).join('');
  const sub = scriptCtx(ctx, args, name, flags.includes('x'));
  if (flags.includes('e')) sub.errexit = true;
  if (flags.includes('u')) sub.nounset = true;
  if (flags.includes('n')) {
    try {
      parse(src.replace(/^#!.*/, ''));
      return 0;
    } catch (e) {
      io.err(`${name}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const savedCwd = ctx.sys.cwd;
  const code = runInScript(sub, src, name, io);
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
  if (sys.os === 'windows') {
    const r = runPowerShell(sys, line, session);
    return { output: r.output, status: r.status, requests: r.clear ? [{ kind: 'clear' } as Request] : [] };
  }
  const ctx = makeCtx(sys, session);
  const buf: string[] = [];
  const io: IO = { stdin: '', out: (s) => buf.push(s), err: (s) => buf.push(s), interactive: true, tty: true };
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
  if (sys.os === 'windows') {
    const savedCwd = sys.cwd;
    const r = runPowerShell(sys, line, {}, false);
    sys.cwd = savedCwd;
    return { output: r.output, status: r.status };
  }
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
