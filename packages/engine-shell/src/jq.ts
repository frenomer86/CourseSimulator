/**
 * A jq interpreter for the terminal: filters are generators (each returns a list of outputs).
 * Covers paths and iteration, pipes and commas, object and array construction, string
 * interpolation, comparisons and arithmetic, if/then/else, reduce, `as $x`, the common
 * built-ins (select, map, keys, length, sort_by, group_by, test, split, join, to_entries ...),
 * update assignment (=, |=, +=) and the @csv @tsv @json @base64 @sh formats. No imports.
 */

type J = null | boolean | number | string | J[] | { [k: string]: J };

export class JqError extends Error {}

type Node =
  | { k: 'identity' }
  | { k: 'recurse' }
  | { k: 'field'; of: Node; name: string; opt?: boolean }
  | { k: 'index'; of: Node; index: Node; opt?: boolean }
  | { k: 'slice'; of: Node; from?: Node; to?: Node }
  | { k: 'iterate'; of: Node; opt?: boolean }
  | { k: 'literal'; v: J }
  | { k: 'str'; parts: Array<string | Node>; format?: string }
  | { k: 'array'; body?: Node }
  | { k: 'object'; entries: Array<{ key: Node | string; value?: Node }> }
  | { k: 'pipe'; left: Node; right: Node }
  | { k: 'comma'; left: Node; right: Node }
  | { k: 'binop'; op: string; left: Node; right: Node }
  | { k: 'and' | 'or' | 'alt'; left: Node; right: Node }
  | { k: 'neg'; of: Node }
  | { k: 'var'; name: string }
  | { k: 'as'; source: Node; name: string; body: Node }
  | { k: 'if'; branches: Array<{ cond: Node; then: Node }>; else?: Node }
  | { k: 'reduce'; source: Node; name: string; init: Node; update: Node }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'format'; name: string }
  | { k: 'try'; body: Node; catch?: Node }
  | { k: 'assign'; op: string; path: Node; value: Node };

/* ----------------------------------------------------------------------------- lexer */

type Tok = { t: 'num'; v: number } | { t: 'str'; parts: Array<string | string[]> } | { t: 'id'; v: string } | { t: 'var'; v: string } | { t: 'field'; v: string } | { t: 'fmt'; v: string } | { t: 'op'; v: string };

const OPS = ['|=', '+=', '-=', '*=', '/=', '//=', '==', '!=', '<=', '>=', '//', '..', '?//', '|', ',', '(', ')', '[', ']', '{', '}', ':', ';', '.', '+', '-', '*', '/', '%', '<', '>', '=', '?'];

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      // A string; \( ... ) interpolations are kept as raw source to parse later.
      const parts: Array<string | string[]> = [];
      let cur = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new JqError('syntax error: unterminated string');
        const ch = src[i];
        if (ch === '"') {
          i++;
          break;
        }
        if (ch === '\\') {
          const n = src[i + 1];
          if (n === '(') {
            let depth = 0;
            let j = i + 1;
            for (; j < src.length; j++) {
              if (src[j] === '(') depth++;
              else if (src[j] === ')' && --depth === 0) break;
            }
            if (cur) parts.push(cur);
            cur = '';
            parts.push([src.slice(i + 2, j)]);
            i = j + 1;
            continue;
          }
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (n === 'u') {
            cur += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
            continue;
          }
          cur += map[n] ?? n;
          i += 2;
          continue;
        }
        cur += ch;
        i++;
      }
      if (cur || !parts.length) parts.push(cur);
      toks.push({ t: 'str', parts });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(src.slice(i))!;
      toks.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
      if (!m) throw new JqError(`syntax error: unexpected $ at ${i}`);
      toks.push({ t: 'var', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '@') {
      const m = /^@([A-Za-z0-9_]+)/.exec(src.slice(i));
      if (!m) throw new JqError('syntax error: bad format');
      toks.push({ t: 'fmt', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (c === '.' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      const m = /^\.([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i))!;
      toks.push({ t: 'field', v: m[1] });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!;
      toks.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new JqError(`syntax error: unexpected '${c}'`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  return toks;
}

/* ----------------------------------------------------------------------------- parser */

class Parser {
  i = 0;
  constructor(private toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isOp(v: string, t = this.peek()): boolean {
    return !!t && t.t === 'op' && t.v === v;
  }
  isId(v: string, t = this.peek()): boolean {
    return !!t && t.t === 'id' && t.v === v;
  }
  expectOp(v: string): void {
    if (!this.isOp(v)) throw new JqError(`syntax error: expected '${v}'`);
    this.i++;
  }
  expectId(v: string): void {
    if (!this.isId(v)) throw new JqError(`syntax error: expected '${v}'`);
    this.i++;
  }

  parse(): Node {
    const n = this.pipe();
    if (this.i < this.toks.length) throw new JqError(`syntax error: unexpected token ${JSON.stringify(this.describe(this.peek()!))}`);
    return n;
  }
  describe(t: Tok): string {
    return t.t === 'op' || t.t === 'id' ? t.v : t.t === 'num' ? String(t.v) : t.t;
  }

  pipe(): Node {
    // def name: body; is not supported; `expr as $x | body` is.
    let left = this.comma();
    if (this.isId('as')) {
      this.i++;
      const v = this.peek();
      if (!v || v.t !== 'var') throw new JqError('syntax error: expected $name after as');
      this.i++;
      this.expectOp('|');
      return { k: 'as', source: left, name: v.v, body: this.pipe() };
    }
    while (this.isOp('|')) {
      this.i++;
      const right = this.comma();
      if (this.isId('as')) {
        this.i++;
        const v = this.peek();
        if (!v || v.t !== 'var') throw new JqError('syntax error: expected $name after as');
        this.i++;
        this.expectOp('|');
        return { k: 'pipe', left, right: { k: 'as', source: right, name: v.v, body: this.pipe() } };
      }
      left = { k: 'pipe', left, right };
    }
    return left;
  }
  comma(): Node {
    let left = this.assign();
    while (this.isOp(',')) {
      this.i++;
      left = { k: 'comma', left, right: this.assign() };
    }
    return left;
  }
  assign(): Node {
    const left = this.alt();
    const t = this.peek();
    if (t && t.t === 'op' && ['=', '|=', '+=', '-=', '*=', '/=', '//='].includes(t.v)) {
      this.i++;
      return { k: 'assign', op: t.v, path: left, value: this.alt() };
    }
    return left;
  }
  alt(): Node {
    let left = this.or();
    while (this.isOp('//')) {
      this.i++;
      left = { k: 'alt', left, right: this.or() };
    }
    return left;
  }
  or(): Node {
    let left = this.and();
    while (this.isId('or')) {
      this.i++;
      left = { k: 'or', left, right: this.and() };
    }
    return left;
  }
  and(): Node {
    let left = this.cmp();
    while (this.isId('and')) {
      this.i++;
      left = { k: 'and', left, right: this.cmp() };
    }
    return left;
  }
  cmp(): Node {
    const left = this.add();
    const t = this.peek();
    if (t && t.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(t.v)) {
      this.i++;
      return { k: 'binop', op: t.v, left, right: this.add() };
    }
    return left;
  }
  add(): Node {
    let left = this.mul();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.i++;
        left = { k: 'binop', op: t.v, left, right: this.mul() };
      } else return left;
    }
  }
  mul(): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        this.i++;
        left = { k: 'binop', op: t.v, left, right: this.unary() };
      } else return left;
    }
  }
  unary(): Node {
    if (this.isOp('-')) {
      this.i++;
      return { k: 'neg', of: this.postfix() };
    }
    return this.postfix();
  }
  postfix(): Node {
    let n = this.primary();
    for (;;) {
      const t = this.peek();
      if (!t) return n;
      if (t.t === 'field') {
        this.i++;
        n = { k: 'field', of: n, name: t.v };
        continue;
      }
      if (this.isOp('.') && this.toks[this.i + 1]?.t === 'str') {
        this.i++;
        const s = this.toks[this.i++] as Extract<Tok, { t: 'str' }>;
        n = { k: 'field', of: n, name: s.parts.map((p) => (typeof p === 'string' ? p : '')).join('') };
        continue;
      }
      if (this.isOp('[') || (this.isOp('.') && this.isOp('[', this.toks[this.i + 1]))) {
        if (this.isOp('.')) this.i++;
        n = this.bracket(n);
        continue;
      }
      if (this.isOp('?')) {
        this.i++;
        n = { k: 'try', body: n };
        continue;
      }
      return n;
    }
  }
  bracket(of: Node): Node {
    this.expectOp('[');
    if (this.isOp(']')) {
      this.i++;
      return { k: 'iterate', of };
    }
    if (this.isOp(':')) {
      this.i++;
      const to = this.pipe();
      this.expectOp(']');
      return { k: 'slice', of, to };
    }
    const index = this.pipe();
    if (this.isOp(':')) {
      this.i++;
      const to = this.isOp(']') ? undefined : this.pipe();
      this.expectOp(']');
      return { k: 'slice', of, from: index, to };
    }
    this.expectOp(']');
    return { k: 'index', of, index };
  }
  primary(): Node {
    const t = this.peek();
    if (!t) throw new JqError('syntax error: unexpected end of filter');
    if (t.t === 'num') {
      this.i++;
      return { k: 'literal', v: t.v };
    }
    if (t.t === 'str') {
      this.i++;
      return this.strNode(t);
    }
    if (t.t === 'fmt') {
      this.i++;
      const next = this.peek();
      if (next && next.t === 'str') {
        this.i++;
        return { ...this.strNode(next), format: t.v } as Node;
      }
      return { k: 'format', name: t.v };
    }
    if (t.t === 'var') {
      this.i++;
      return { k: 'var', name: t.v };
    }
    if (t.t === 'field') {
      this.i++;
      return { k: 'field', of: { k: 'identity' }, name: t.v };
    }
    if (this.isOp('..')) {
      this.i++;
      return { k: 'recurse' };
    }
    if (this.isOp('.')) {
      this.i++;
      const n = this.peek();
      if (n && n.t === 'str') {
        this.i++;
        return { k: 'field', of: { k: 'identity' }, name: n.parts.map((p) => (typeof p === 'string' ? p : '')).join('') };
      }
      if (this.isOp('[')) return this.bracket({ k: 'identity' });
      return { k: 'identity' };
    }
    if (this.isOp('(')) {
      this.i++;
      const n = this.pipe();
      this.expectOp(')');
      return n;
    }
    if (this.isOp('[')) {
      this.i++;
      if (this.isOp(']')) {
        this.i++;
        return { k: 'array' };
      }
      const body = this.pipe();
      this.expectOp(']');
      return { k: 'array', body };
    }
    if (this.isOp('{')) return this.object();
    if (t.t === 'id') {
      if (t.v === 'if') return this.ifNode();
      if (t.v === 'try') {
        this.i++;
        const body = this.postfix();
        if (this.isId('catch')) {
          this.i++;
          return { k: 'try', body, catch: this.postfix() };
        }
        return { k: 'try', body };
      }
      if (t.v === 'reduce') {
        this.i++;
        const source = this.postfix();
        this.expectId('as');
        const v = this.peek();
        if (!v || v.t !== 'var') throw new JqError('syntax error: expected $name in reduce');
        this.i++;
        this.expectOp('(');
        const init = this.pipe();
        this.expectOp(';');
        const update = this.pipe();
        this.expectOp(')');
        return { k: 'reduce', source, name: v.v, init, update };
      }
      if (t.v === 'true' || t.v === 'false' || t.v === 'null') {
        this.i++;
        return { k: 'literal', v: t.v === 'null' ? null : t.v === 'true' };
      }
      if (t.v === 'not') {
        this.i++;
        return { k: 'call', name: 'not', args: [] };
      }
      this.i++;
      const args: Node[] = [];
      if (this.isOp('(')) {
        this.i++;
        args.push(this.pipe());
        while (this.isOp(';')) {
          this.i++;
          args.push(this.pipe());
        }
        this.expectOp(')');
      }
      return { k: 'call', name: t.v, args };
    }
    throw new JqError(`syntax error: unexpected '${this.describe(t)}'`);
  }
  strNode(t: Extract<Tok, { t: 'str' }>): Node {
    return { k: 'str', parts: t.parts.map((p) => (typeof p === 'string' ? p : new Parser(lex(p[0])).parse())) };
  }
  ifNode(): Node {
    this.expectId('if');
    const branches = [{ cond: this.pipe(), then: (this.expectId('then'), this.pipe()) }];
    let elseNode: Node | undefined;
    for (;;) {
      if (this.isId('elif')) {
        this.i++;
        const cond = this.pipe();
        this.expectId('then');
        branches.push({ cond, then: this.pipe() });
        continue;
      }
      if (this.isId('else')) {
        this.i++;
        elseNode = this.pipe();
      }
      this.expectId('end');
      return { k: 'if', branches, else: elseNode };
    }
  }
  object(): Node {
    this.expectOp('{');
    const entries: Array<{ key: Node | string; value?: Node }> = [];
    while (!this.isOp('}')) {
      const t = this.peek();
      if (!t) throw new JqError('syntax error: unterminated object');
      let key: Node | string;
      if (t.t === 'id') {
        this.i++;
        key = t.v;
      } else if (t.t === 'str') {
        this.i++;
        key = this.strNode(t);
      } else if (t.t === 'var') {
        this.i++;
        key = t.v;
        entries.push({ key, value: { k: 'var', name: t.v } });
        if (this.isOp(',')) this.i++;
        continue;
      } else if (this.isOp('(')) {
        this.i++;
        key = this.pipe();
        this.expectOp(')');
      } else throw new JqError('syntax error: bad object key');
      if (this.isOp(':')) {
        this.i++;
        entries.push({ key, value: this.alt() });
      } else entries.push({ key });
      if (this.isOp(',')) this.i++;
      else if (!this.isOp('}')) throw new JqError("syntax error: expected ',' or '}' in object");
    }
    this.i++;
    return { k: 'object', entries };
  }
}

/* ----------------------------------------------------------------------------- evaluation */

type Env = Record<string, J>;

const typeOf = (v: J): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v);
const isObj = (v: J): v is { [k: string]: J } => !!v && typeof v === 'object' && !Array.isArray(v);
const truthy = (v: J) => v !== null && v !== false;
const show = (v: J) => JSON.stringify(v);

function order(v: J): number {
  return ['null', 'boolean', 'number', 'string', 'array', 'object'].indexOf(typeOf(v)) + (v === true ? 0.5 : 0);
}

export function compareJ(a: J, b: J): number {
  const oa = order(a);
  const ob = order(b);
  if (oa !== ob) return oa - ob;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareJ(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    const c = compareJ(ka, kb);
    if (c) return c;
    for (const k of ka) {
      const d = compareJ(a[k], b[k]);
      if (d) return d;
    }
  }
  return 0;
}

const equal = (a: J, b: J) => compareJ(a, b) === 0;

function index(v: J, key: J, opt: boolean): J {
  if (v === null) return null;
  if (typeof key === 'string') {
    if (isObj(v)) return v[key] ?? null;
    if (opt) throw new SkipError();
    throw new JqError(`Cannot index ${typeOf(v)} with "${key}"`);
  }
  if (typeof key === 'number') {
    if (Array.isArray(v)) {
      const i = Math.floor(key) < 0 ? v.length + Math.floor(key) : Math.floor(key);
      return v[i] ?? null;
    }
    if (opt) throw new SkipError();
    throw new JqError(`Cannot index ${typeOf(v)} with number`);
  }
  if (opt) throw new SkipError();
  throw new JqError(`Cannot index ${typeOf(v)} with ${typeOf(key)}`);
}

class SkipError extends Error {}

function iterate(v: J, opt: boolean): J[] {
  if (Array.isArray(v)) return v;
  if (isObj(v)) return Object.values(v);
  if (opt) return [];
  throw new JqError(`Cannot iterate over ${typeOf(v)}${v === null ? '' : ` (${show(v)})`}`);
}

function arith(op: string, a: J, b: J): J {
  switch (op) {
    case '+':
      if (a === null) return b;
      if (b === null) return a;
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
      if (isObj(a) && isObj(b)) return { ...a, ...b };
      break;
    case '-':
      if (typeof a === 'number' && typeof b === 'number') return a - b;
      if (Array.isArray(a) && Array.isArray(b)) return a.filter((x) => !b.some((y) => equal(x, y)));
      break;
    case '*':
      if (typeof a === 'number' && typeof b === 'number') return a * b;
      if (typeof a === 'string' && typeof b === 'number') return b > 0 ? a.repeat(Math.floor(b)) : null;
      if (isObj(a) && isObj(b)) return deepMerge(a, b);
      break;
    case '/':
      if (typeof a === 'number' && typeof b === 'number') {
        if (b === 0) throw new JqError(`${a} and ${b} cannot be divided because the divisor is zero`);
        return a / b;
      }
      if (typeof a === 'string' && typeof b === 'string') return a.split(b);
      break;
    case '%':
      if (typeof a === 'number' && typeof b === 'number') {
        if (Math.trunc(b) === 0) throw new JqError(`${a} and ${b} cannot be divided because the divisor is zero`);
        return Math.trunc(a) % Math.trunc(b);
      }
      break;
    case '==':
      return equal(a, b);
    case '!=':
      return !equal(a, b);
    case '<':
      return compareJ(a, b) < 0;
    case '<=':
      return compareJ(a, b) <= 0;
    case '>':
      return compareJ(a, b) > 0;
    case '>=':
      return compareJ(a, b) >= 0;
  }
  throw new JqError(`${typeOf(a)} (${show(a)}) and ${typeOf(b)} (${show(b)}) cannot be ${{ '+': 'added', '-': 'subtracted', '*': 'multiplied', '/': 'divided', '%': 'divided' }[op] ?? 'compared'}`);
}

function deepMerge(a: { [k: string]: J }, b: { [k: string]: J }): J {
  const out: { [k: string]: J } = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k] as { [k: string]: J }, v) : v;
  return out;
}

function format(name: string, v: J): string {
  const str = (x: J) => (typeof x === 'string' ? x : show(x));
  switch (name) {
    case 'text':
      return str(v);
    case 'json':
      return show(v);
    case 'csv':
      if (!Array.isArray(v)) throw new JqError(`${typeOf(v)} (${show(v)}) cannot be csv-formatted, only an array can be`);
      return v.map((x) => (typeof x === 'string' ? `"${x.replace(/"/g, '""')}"` : x === null ? '' : show(x))).join(',');
    case 'tsv':
      if (!Array.isArray(v)) throw new JqError(`${typeOf(v)} (${show(v)}) cannot be tsv-formatted, only an array can be`);
      return v.map((x) => (typeof x === 'string' ? x.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n') : x === null ? '' : show(x))).join('\t');
    case 'html':
      return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    case 'uri':
      return encodeURIComponent(str(v));
    case 'sh':
      return (Array.isArray(v) ? v : [v]).map((x) => `'${str(x).replace(/'/g, "'\\''")}'`).join(' ');
    case 'base64': {
      const bytes = new TextEncoder().encode(str(v));
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    }
    case 'base64d': {
      const bin = atob(str(v));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
  }
  throw new JqError(`${name} is not a valid format`);
}

/** Path expressions (for assignment and del): the list of paths a filter selects in the input. */
function paths(n: Node, input: J, env: Env): Array<Array<string | number>> {
  switch (n.k) {
    case 'identity':
      return [[]];
    case 'field':
      return paths(n.of, input, env).map((p) => [...p, n.name]);
    case 'index':
      return paths(n.of, input, env).flatMap((p) => evaluate(n.index, input, env).map((k) => [...p, k as string | number]));
    case 'iterate':
      return paths(n.of, input, env).flatMap((p) => {
        const v = getPath(input, p);
        if (Array.isArray(v)) return v.map((_, i) => [...p, i]);
        if (isObj(v)) return Object.keys(v).map((k) => [...p, k]);
        if (v === null) return [];
        throw new JqError(`Cannot iterate over ${typeOf(v)}`);
      });
    case 'pipe':
      return paths(n.left, input, env).flatMap((p) => paths(n.right, getPath(input, p), env).map((q) => [...p, ...q]));
    case 'comma':
      return [...paths(n.left, input, env), ...paths(n.right, input, env)];
    case 'call':
      if (n.name === 'select') return truthyAny(evaluate(n.args[0], input, env)) ? [[]] : [];
      if (n.name === 'empty') return [];
      if (n.name === 'recurse' || n.name === 'recurse_down') return allPaths(input);
      if (n.name === 'first' && !n.args.length) return [[0]];
      if (n.name === 'last' && !n.args.length) return [[-1]];
      break;
    case 'recurse':
      return allPaths(input);
    case 'try':
      try {
        return paths(n.body, input, env);
      } catch {
        return [];
      }
  }
  throw new JqError('Invalid path expression');
}

const truthyAny = (vs: J[]) => vs.some(truthy);

function allPaths(v: J, prefix: Array<string | number> = []): Array<Array<string | number>> {
  const out = [prefix];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...allPaths(x, [...prefix, i])));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) out.push(...allPaths(x, [...prefix, k]));
  return out;
}

function getPath(v: J, p: Array<string | number>): J {
  let cur = v;
  for (const k of p) cur = cur === null ? null : index(cur, k, false);
  return cur;
}

function setPath(v: J, p: Array<string | number>, value: J): J {
  if (!p.length) return value;
  const [k, ...rest] = p;
  if (typeof k === 'number') {
    const arr = Array.isArray(v) ? [...v] : v === null ? [] : null;
    if (!arr) throw new JqError(`Cannot index ${typeOf(v)} with number`);
    const i = k < 0 ? arr.length + k : k;
    while (arr.length < i) arr.push(null);
    arr[i] = setPath(arr[i] ?? null, rest, value);
    return arr;
  }
  const obj = isObj(v) ? { ...v } : v === null ? {} : null;
  if (!obj) throw new JqError(`Cannot index ${typeOf(v)} with "${k}"`);
  obj[k] = setPath(obj[k] ?? null, rest, value);
  return obj;
}

function delPaths(v: J, ps: Array<Array<string | number>>): J {
  // Delete deepest and highest indices first so earlier deletions do not shift later ones.
  const sorted = [...ps].sort((a, b) => compareJ(b as J, a as J));
  let out = v;
  for (const p of sorted) {
    if (!p.length) return null;
    const parent = getPath(out, p.slice(0, -1));
    const k = p[p.length - 1];
    let next: J;
    if (Array.isArray(parent) && typeof k === 'number') next = parent.filter((_, i) => i !== (k < 0 ? parent.length + k : k));
    else if (isObj(parent) && typeof k === 'string') {
      next = { ...parent };
      delete (next as Record<string, J>)[k];
    } else continue;
    out = setPath(out, p.slice(0, -1), next);
  }
  return out;
}

function str(v: J): string {
  return typeof v === 'string' ? v : show(v);
}

function evaluate(n: Node, input: J, env: Env): J[] {
  switch (n.k) {
    case 'identity':
      return [input];
    case 'recurse':
      return allPaths(input).map((p) => getPath(input, p));
    case 'literal':
      return [n.v];
    case 'var':
      if (n.name === 'ENV' || n.name === '__loc__') return [env[n.name] ?? {}];
      if (!(n.name in env)) throw new JqError(`$${n.name} is not defined`);
      return [env[n.name]];
    case 'field':
      return evaluate(n.of, input, env).flatMap((v) => {
        try {
          return [index(v, n.name, !!n.opt)];
        } catch (e) {
          if (e instanceof SkipError) return [];
          throw e;
        }
      });
    case 'index':
      return evaluate(n.of, input, env).flatMap((v) => evaluate(n.index, input, env).map((k) => index(v, k, !!n.opt)));
    case 'slice':
      return evaluate(n.of, input, env).map((v) => {
        if (v === null) return null;
        if (typeof v !== 'string' && !Array.isArray(v)) throw new JqError(`Cannot index ${typeOf(v)} with object`);
        const from = n.from ? Number(evaluate(n.from, input, env)[0] ?? 0) : 0;
        const to = n.to ? Number(evaluate(n.to, input, env)[0] ?? v.length) : v.length;
        return v.slice(from, to) as J;
      });
    case 'iterate':
      return evaluate(n.of, input, env).flatMap((v) => iterate(v, !!n.opt));
    case 'str': {
      // Each interpolation multiplies the outputs (like jq's cartesian product).
      let outs = [''];
      for (const p of n.parts) {
        if (typeof p === 'string') outs = outs.map((o) => o + p);
        else {
          const vals = evaluate(p, input, env).map((v) => (n.format ? format(n.format, v) : str(v)));
          outs = outs.flatMap((o) => vals.map((v) => o + v));
        }
      }
      return outs;
    }
    case 'format':
      return [format(n.name, input)];
    case 'array':
      return [n.body ? evaluate(n.body, input, env) : []];
    case 'object': {
      let objs: Array<{ [k: string]: J }> = [{}];
      for (const e of n.entries) {
        const keys = typeof e.key === 'string' ? [e.key] : evaluate(e.key, input, env).map((k) => {
          if (typeof k !== 'string') throw new JqError(`Object keys must be strings`);
          return k;
        });
        const vals = (k: string) => (e.value ? evaluate(e.value, input, env) : [index(input, k, false)]);
        objs = objs.flatMap((o) => keys.flatMap((k) => vals(k).map((v) => ({ ...o, [k]: v }))));
      }
      return objs;
    }
    case 'pipe':
      return evaluate(n.left, input, env).flatMap((v) => evaluate(n.right, v, env));
    case 'comma':
      return [...evaluate(n.left, input, env), ...evaluate(n.right, input, env)];
    case 'neg':
      return evaluate(n.of, input, env).map((v) => {
        if (typeof v !== 'number') throw new JqError(`${typeOf(v)} (${show(v)}) cannot be negated`);
        return -v;
      });
    case 'binop': {
      const rights = evaluate(n.right, input, env);
      return evaluate(n.left, input, env).flatMap((l) => rights.map((r) => arith(n.op, l, r)));
    }
    case 'and':
      return evaluate(n.left, input, env).flatMap((l) => (truthy(l) ? evaluate(n.right, input, env).map(truthy) : [false]));
    case 'or':
      return evaluate(n.left, input, env).flatMap((l) => (truthy(l) ? [true] : evaluate(n.right, input, env).map(truthy)));
    case 'alt': {
      let left: J[] = [];
      try {
        left = evaluate(n.left, input, env).filter(truthy);
      } catch (e) {
        if (!(e instanceof JqError)) throw e;
      }
      return left.length ? left : evaluate(n.right, input, env);
    }
    case 'as':
      return evaluate(n.source, input, env).flatMap((v) => evaluate(n.body, input, { ...env, [n.name]: v }));
    case 'if': {
      const run = (k: number): J[] => {
        if (k >= n.branches.length) return n.else ? evaluate(n.else, input, env) : [input];
        return evaluate(n.branches[k].cond, input, env).flatMap((c) => (truthy(c) ? evaluate(n.branches[k].then, input, env) : run(k + 1)));
      };
      return run(0);
    }
    case 'reduce': {
      let acc = evaluate(n.init, input, env);
      for (const item of evaluate(n.source, input, env)) acc = acc.flatMap((a) => evaluate(n.update, a, { ...env, [n.name]: item })).slice(-1);
      return acc;
    }
    case 'try':
      try {
        return evaluate(n.body, input, env);
      } catch (e) {
        if (e instanceof JqError || e instanceof SkipError) return n.catch ? evaluate(n.catch, e instanceof JqError ? e.message : null, env) : [];
        throw e;
      }
    case 'assign': {
      const ps = paths(n.path, input, env);
      if (n.op === '|=') {
        let out = input;
        for (const p of ps) {
          const nv = evaluate(n.value, getPath(out, p), env);
          out = nv.length ? setPath(out, p, nv[0]) : delPaths(out, [p]);
        }
        return [out];
      }
      return evaluate(n.value, input, env).map((rhs) => {
        let out = input;
        for (const p of ps) {
          const old = getPath(out, p);
          const nv = n.op === '=' ? rhs : n.op === '//=' ? (truthy(old) ? old : rhs) : arith(n.op[0], old, rhs);
          out = setPath(out, p, nv);
        }
        return out;
      });
    }
    case 'call':
      return call(n, input, env);
  }
}

function one(n: Node, input: J, env: Env): J {
  const v = evaluate(n, input, env);
  return v[0] ?? null;
}

function call(n: Extract<Node, { k: 'call' }>, input: J, env: Env): J[] {
  const a = n.args;
  const arg = (i: number) => one(a[i], input, env);
  const needStr = (fn: string) => {
    if (typeof input !== 'string') throw new JqError(`${typeOf(input)} (${show(input)}) cannot be ${fn}`);
    return input;
  };
  switch (`${n.name}/${a.length}`) {
    case 'empty/0':
      return [];
    case 'not/0':
      return [!truthy(input)];
    case 'length/0':
      if (input === null) return [0];
      if (typeof input === 'string' || Array.isArray(input)) return [input.length];
      if (isObj(input)) return [Object.keys(input).length];
      if (typeof input === 'number') return [Math.abs(input)];
      throw new JqError(`boolean (${show(input)}) has no length`);
    case 'utf8bytelength/0':
      return [new TextEncoder().encode(needStr('measured')).length];
    case 'keys/0':
    case 'keys_unsorted/0':
      if (isObj(input)) return [n.name === 'keys' ? Object.keys(input).sort() : Object.keys(input)];
      if (Array.isArray(input)) return [input.map((_, i) => i)];
      throw new JqError(`${typeOf(input)} (${show(input)}) has no keys`);
    case 'values/0':
      return input === null ? [] : [input];
    case 'has/1': {
      const k = arg(0);
      if (isObj(input)) return [typeof k === 'string' && k in input];
      if (Array.isArray(input)) return [typeof k === 'number' && k >= 0 && k < input.length];
      throw new JqError(`Cannot check whether ${typeOf(input)} has a key`);
    }
    case 'in/1':
      return [evaluate({ k: 'call', name: 'has', args: [{ k: 'literal', v: input }] }, arg(0), env)[0]];
    case 'map/1':
      return [iterate(input, false).flatMap((x) => evaluate(a[0], x, env))];
    case 'map_values/1': {
      if (Array.isArray(input)) return [input.map((x) => one(a[0], x, env))];
      if (isObj(input)) return [Object.fromEntries(Object.entries(input).map(([k, x]) => [k, one(a[0], x, env)]))];
      throw new JqError(`Cannot iterate over ${typeOf(input)}`);
    }
    case 'select/1':
      return evaluate(a[0], input, env).some(truthy) ? [input] : [];
    case 'recurse/0':
      return allPaths(input).map((p) => getPath(input, p));
    case 'error/0':
      throw new JqError(str(input));
    case 'error/1':
      throw new JqError(str(arg(0)));
    case 'add/0': {
      const items = iterate(input, false);
      return [items.reduce<J>((acc, x) => arith('+', acc, x), null)];
    }
    case 'any/0':
      return [iterate(input, false).some(truthy)];
    case 'all/0':
      return [iterate(input, false).every(truthy)];
    case 'any/1':
      return [iterate(input, false).some((x) => evaluate(a[0], x, env).some(truthy))];
    case 'all/1':
      return [iterate(input, false).every((x) => evaluate(a[0], x, env).every(truthy))];
    case 'flatten/0':
    case 'flatten/1': {
      const depth = a.length ? Number(arg(0)) : 1e9;
      const flat = (v: J[], d: number): J[] => v.flatMap((x) => (Array.isArray(x) && d > 0 ? flat(x, d - 1) : [x]));
      if (!Array.isArray(input)) throw new JqError(`Cannot flatten ${typeOf(input)}`);
      return [flat(input, depth)];
    }
    case 'range/1':
      return Array.from({ length: Math.max(0, Math.ceil(Number(arg(0)))) }, (_, i) => i);
    case 'range/2': {
      const from = Number(arg(0));
      const to = Number(arg(1));
      return Array.from({ length: Math.max(0, Math.ceil(to - from)) }, (_, i) => from + i);
    }
    case 'floor/0':
      return [Math.floor(Number(input))];
    case 'ceil/0':
      return [Math.ceil(Number(input))];
    case 'round/0':
      return [Math.round(Number(input))];
    case 'sqrt/0':
      return [Math.sqrt(Number(input))];
    case 'fabs/0':
    case 'abs/0':
      return [Math.abs(Number(input))];
    case 'tostring/0':
      return [str(input)];
    case 'tonumber/0': {
      if (typeof input === 'number') return [input];
      const s = needStr('parsed as a number');
      const v = Number(s);
      if (s.trim() === '' || Number.isNaN(v)) throw new JqError(`Cannot parse '${s}' as JSON`);
      return [v];
    }
    case 'type/0':
      return [typeOf(input)];
    case 'sort/0':
      if (!Array.isArray(input)) throw new JqError(`${typeOf(input)} (${show(input)}) cannot be sorted, as it is not an array`);
      return [[...input].sort(compareJ)];
    case 'sort_by/1':
      if (!Array.isArray(input)) throw new JqError(`${typeOf(input)} cannot be sorted, as it is not an array`);
      return [[...input].sort((x, y) => compareJ(evaluate(a[0], x, env), evaluate(a[0], y, env)))];
    case 'group_by/1': {
      if (!Array.isArray(input)) throw new JqError(`Cannot index ${typeOf(input)}`);
      const sorted = [...input].sort((x, y) => compareJ(evaluate(a[0], x, env), evaluate(a[0], y, env)));
      const groups: J[][] = [];
      for (const x of sorted) {
        const last = groups[groups.length - 1];
        if (last && equal(evaluate(a[0], last[0], env), evaluate(a[0], x, env))) last.push(x);
        else groups.push([x]);
      }
      return [groups];
    }
    case 'unique/0':
      if (!Array.isArray(input)) throw new JqError(`Cannot index ${typeOf(input)}`);
      return [[...input].sort(compareJ).filter((x, i, arr) => i === 0 || !equal(arr[i - 1], x))];
    case 'unique_by/1': {
      if (!Array.isArray(input)) throw new JqError(`Cannot index ${typeOf(input)}`);
      const seen: J[] = [];
      const out: J[] = [];
      for (const x of [...input].sort((p, q) => compareJ(evaluate(a[0], p, env), evaluate(a[0], q, env)))) {
        const k = evaluate(a[0], x, env) as J;
        if (!seen.some((s) => equal(s, k))) {
          seen.push(k);
          out.push(x);
        }
      }
      return [out];
    }
    case 'min/0':
    case 'max/0': {
      const items = iterate(input, false);
      if (!items.length) return [null];
      return [[...items].sort(compareJ)[n.name === 'min' ? 0 : items.length - 1]];
    }
    case 'min_by/1':
    case 'max_by/1': {
      const items = iterate(input, false);
      if (!items.length) return [null];
      const sorted = [...items].sort((x, y) => compareJ(evaluate(a[0], x, env), evaluate(a[0], y, env)));
      return [sorted[n.name === 'min_by' ? 0 : sorted.length - 1]];
    }
    case 'reverse/0':
      if (typeof input === 'string') return [[...input].reverse().join('')];
      if (input === null) return [[]];
      return [[...iterate(input, false)].reverse()];
    case 'contains/1': {
      const b = arg(0);
      const contains = (x: J, y: J): boolean => {
        if (typeof x === 'string' && typeof y === 'string') return x.includes(y);
        if (Array.isArray(x) && Array.isArray(y)) return y.every((yy) => x.some((xx) => contains(xx, yy)));
        if (isObj(x) && isObj(y)) return Object.entries(y).every(([k, v]) => k in x && contains(x[k], v));
        return equal(x, y);
      };
      return [contains(input, b)];
    }
    case 'inside/1':
      return call({ k: 'call', name: 'contains', args: [{ k: 'literal', v: input }] }, arg(0), env);
    case 'startswith/1':
      return [needStr('checked with startswith').startsWith(str(arg(0)))];
    case 'endswith/1':
      return [needStr('checked with endswith').endsWith(str(arg(0)))];
    case 'ltrimstr/1': {
      const p = arg(0);
      return [typeof input === 'string' && typeof p === 'string' && input.startsWith(p) ? input.slice(p.length) : input];
    }
    case 'rtrimstr/1': {
      const p = arg(0);
      return [typeof input === 'string' && typeof p === 'string' && p && input.endsWith(p) ? input.slice(0, -p.length) : input];
    }
    case 'trim/0':
      return [needStr('trimmed').trim()];
    case 'ltrim/0':
      return [needStr('trimmed').trimStart()];
    case 'rtrim/0':
      return [needStr('trimmed').trimEnd()];
    case 'split/1':
      return [needStr('split').split(str(arg(0)))];
    case 'split/2':
      return [needStr('split').split(new RegExp(str(arg(0)), flags(arg(1))))];
    case 'join/1': {
      const sep = str(arg(0));
      return [iterate(input, false).map((x) => (x === null ? '' : typeof x === 'string' ? x : typeof x === 'object' ? (() => { throw new JqError(`Cannot join with ${typeOf(x)}`); })() : String(x))).join(sep)];
    }
    case 'ascii_downcase/0':
      return [needStr('lowercased').toLowerCase()];
    case 'ascii_upcase/0':
      return [needStr('uppercased').toUpperCase()];
    case 'test/1':
    case 'test/2':
      return [new RegExp(str(arg(0)), flags(a[1] ? arg(1) : null)).test(needStr('matched, as it is not a string'))];
    case 'match/1':
    case 'match/2': {
      const re = new RegExp(str(arg(0)), flags(a[1] ? arg(1) : null) + 'd');
      const m = re.exec(needStr('matched'));
      if (!m) return [];
      return [{ offset: m.index, length: m[0].length, string: m[0], captures: m.slice(1).map((c, i) => ({ offset: m.indices?.[i + 1]?.[0] ?? -1, length: c?.length ?? 0, string: c ?? null, name: null })) }];
    }
    case 'capture/1':
    case 'capture/2': {
      const m = new RegExp(str(arg(0)), flags(a[1] ? arg(1) : null)).exec(needStr('matched'));
      return m ? [{ ...(m.groups ?? {}) } as J] : [];
    }
    case 'sub/2':
    case 'gsub/2':
    case 'sub/3':
    case 'gsub/3': {
      const s = needStr('matched');
      const re = new RegExp(str(arg(0)), flags(a[2] ? arg(2) : null) + (n.name === 'gsub' ? 'g' : ''));
      return [s.replace(re, (...m) => {
        const groups = (typeof m[m.length - 1] === 'object' ? m[m.length - 1] : {}) as Record<string, string>;
        return str(one(a[1], groups as J, env));
      })];
    }
    case 'to_entries/0':
      if (!isObj(input)) throw new JqError(`${typeOf(input)} has no keys`);
      return [Object.entries(input).map(([key, value]) => ({ key, value }))];
    case 'from_entries/0':
      return [Object.fromEntries(iterate(input, false).map((e) => {
        const o = e as Record<string, J>;
        const k = o.key ?? o.k ?? o.name ?? o.Name ?? o.Key ?? o.K;
        return [typeof k === 'string' ? k : str(k), o.value ?? o.v ?? o.Value ?? o.V ?? null];
      }))];
    case 'with_entries/1': {
      if (!isObj(input)) throw new JqError(`${typeOf(input)} has no keys`);
      const entries = Object.entries(input).flatMap(([key, value]) => evaluate(a[0], { key, value }, env));
      return [Object.fromEntries(entries.map((e) => {
        const o = e as Record<string, J>;
        return [str(o.key ?? o.name), o.value ?? null];
      }))];
    }
    case 'first/0':
      return [index(input, 0, false)];
    case 'last/0':
      return [index(input, -1, false)];
    case 'first/1':
      return evaluate(a[0], input, env).slice(0, 1);
    case 'last/1':
      return evaluate(a[0], input, env).slice(-1);
    case 'limit/2':
      return evaluate(a[1], input, env).slice(0, Math.max(0, Number(arg(0))));
    case 'nth/1':
      return [index(input, Number(arg(0)), false)];
    case 'isempty/1':
      return [evaluate(a[0], input, env).length === 0];
    case 'index/1':
    case 'rindex/1': {
      const s = needStr('searched');
      const i = n.name === 'index' ? s.indexOf(str(arg(0))) : s.lastIndexOf(str(arg(0)));
      return [i === -1 ? null : i];
    }
    case 'indices/1': {
      const t = arg(0);
      if (typeof input === 'string' && typeof t === 'string') {
        const out: number[] = [];
        for (let i = input.indexOf(t); i !== -1 && t; i = input.indexOf(t, i + 1)) out.push(i);
        return [out];
      }
      if (Array.isArray(input)) return [input.map((x, i) => (equal(x, t) ? i : -1)).filter((i) => i >= 0)];
      return [null];
    }
    case 'tojson/0':
      return [show(input)];
    case 'fromjson/0':
      try {
        return [JSON.parse(needStr('parsed')) as J];
      } catch {
        throw new JqError(`${show(input)} cannot be parsed as JSON`);
      }
    case 'ascii/0':
      return [String.fromCharCode(Number(input))];
    case 'explode/0':
      return [[...needStr('exploded')].map((c) => c.codePointAt(0)!)];
    case 'implode/0':
      return [String.fromCodePoint(...iterate(input, false).map(Number))];
    case 'del/1':
      return [delPaths(input, paths(a[0], input, env))];
    case 'to_array/0':
    case 'arrays/0':
      return n.name === 'arrays' ? (Array.isArray(input) ? [input] : []) : [Array.isArray(input) ? input : [input]];
    case 'objects/0':
      return isObj(input) ? [input] : [];
    case 'strings/0':
      return typeof input === 'string' ? [input] : [];
    case 'numbers/0':
      return typeof input === 'number' ? [input] : [];
    case 'booleans/0':
      return typeof input === 'boolean' ? [input] : [];
    case 'nulls/0':
      return input === null ? [input] : [];
    case 'iterables/0':
      return Array.isArray(input) || isObj(input) ? [input] : [];
    case 'scalars/0':
      return !Array.isArray(input) && !isObj(input) ? [input] : [];
    case 'getpath/1':
      return [getPath(input, arg(0) as Array<string | number>)];
    case 'setpath/2':
      return [setPath(input, arg(0) as Array<string | number>, arg(1))];
    case 'paths/0':
      return allPaths(input).slice(1) as J[];
    case 'leaf_paths/0':
      return allPaths(input).slice(1).filter((p) => { const v = getPath(input, p); return !Array.isArray(v) && !isObj(v); }) as J[];
    case 'env/0':
      return [env.ENV ?? {}];
    case 'now/0':
      return [Number(env.__now ?? 0) / 1000];
    case 'todate/0':
    case 'todateiso8601/0':
      return [new Date(Number(input) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')];
    case 'fromdate/0':
    case 'fromdateiso8601/0':
      return [Math.floor(Date.parse(needStr('parsed as a date')) / 1000)];
    case 'strftime/1': {
      const d = new Date(typeof input === 'number' ? input * 1000 : Date.parse(str(input)));
      const p2 = (x: number) => String(x).padStart(2, '0');
      return [str(arg(0)).replace(/%([YmdHMSFTjsZ%])/g, (_m, c: string) => ({ Y: String(d.getUTCFullYear()), m: p2(d.getUTCMonth() + 1), d: p2(d.getUTCDate()), H: p2(d.getUTCHours()), M: p2(d.getUTCMinutes()), S: p2(d.getUTCSeconds()), F: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, T: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`, j: String(Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1).padStart(3, '0'), s: String(Math.floor(d.getTime() / 1000)), Z: 'UTC', '%': '%' })[c] ?? c)];
    }
    case 'input/0':
    case 'inputs/0':
      return [];
    case 'debug/0':
      return [input];
    case 'halt/0':
      return [];
  }
  throw new JqError(`${n.name}/${a.length} is not defined`);
}

function flags(v: J): string {
  const f = typeof v === 'string' ? v : '';
  return (f.includes('i') ? 'i' : '') + (f.includes('x') ? '' : '') + (f.includes('s') ? 's' : '') + (f.includes('g') ? 'g' : '');
}

/* ----------------------------------------------------------------------------- entry points */

export function compile(filter: string): Node {
  return new Parser(lex(filter)).parse();
}

export function runJq(filter: string | Node, input: J, vars: Env = {}): J[] {
  const node = typeof filter === 'string' ? compile(filter) : filter;
  return evaluate(node, input, vars);
}

/** Formats a value the way jq prints it: pretty (2 spaces) or compact, with -r printing strings raw. */
export function formatJ(v: J, opts: { compact?: boolean; raw?: boolean; sortKeys?: boolean; tab?: boolean } = {}): string {
  if (opts.raw && typeof v === 'string') return v;
  const sorted = opts.sortKeys ? sortKeys(v) : v;
  return opts.compact ? JSON.stringify(sorted) : JSON.stringify(sorted, null, opts.tab ? '\t' : 2);
}

function sortKeys(v: J): J {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Parses a stream of JSON texts (jq accepts several values one after another). */
export function parseJsonStream(text: string): J[] {
  const whole = text.trim();
  if (!whole) return [];
  try {
    return [JSON.parse(whole) as J];
  } catch {
    /* several values, or invalid JSON: split it below */
  }
  const out: J[] = [];
  let i = 0;
  let line = 1;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) {
      if (text[i] === '\n') line++;
      i++;
    }
    if (i >= text.length) break;
    let j = i;
    const c = text[i];
    if (c === '{' || c === '[') {
      let depth = 0;
      let inStr = false;
      for (; j < text.length; j++) {
        const ch = text[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if ((ch === '}' || ch === ']') && --depth === 0) {
          j++;
          break;
        }
      }
    } else if (c === '"') {
      for (j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '"') {
          j++;
          break;
        }
      }
    } else while (j < text.length && !/[\s{["]/.test(text[j])) j++;
    const chunk = text.slice(i, j);
    try {
      out.push(JSON.parse(chunk) as J);
    } catch {
      throw new JqError(`parse error: Invalid JSON text at line ${line}, near '${chunk.slice(0, 40)}'`);
    }
    line += (chunk.match(/\n/g) ?? []).length;
    i = j;
  }
  return out;
}

export type { J as JqValue };
