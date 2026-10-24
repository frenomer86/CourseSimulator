/**
 * PowerShell parser: source text to an AST, with PowerShell's two parsing modes. At the start of
 * a pipeline element a bare word begins a command (argument mode: barewords are strings, -Name is
 * a parameter); anything else is an expression (expression mode: operators, method calls, casts).
 * Operator precedence follows about_Operator_Precedence. No imports.
 */

export class ParseError extends Error {
  constructor(
    message: string,
    public line = 1,
  ) {
    super(message);
  }
}

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'xstr'; parts: Array<string | Expr> }
  | { t: 'var'; name: string; scope?: string }
  | { t: 'member'; obj: Expr; name: string | Expr; static?: boolean }
  | { t: 'invoke'; obj: Expr; name: string; args: Expr[]; static?: boolean }
  | { t: 'index'; obj: Expr; index: Expr }
  | { t: 'array'; items: Expr[] }
  | { t: 'sub'; body: Stmt[]; array?: boolean }
  | { t: 'paren'; body: Stmt }
  | { t: 'hash'; entries: Array<{ key: Expr; value: Stmt }> }
  | { t: 'block'; src: string; line: number }
  | { t: 'unary'; op: string; e: Expr }
  | { t: 'incdec'; op: '++' | '--'; prefix: boolean; e: Expr }
  | { t: 'bin'; op: string; l: Expr; r: Expr }
  | { t: 'cast'; type: string; e: Expr }
  | { t: 'type'; name: string }
  | { t: 'bare'; name: string };

export type Arg = { t: 'param'; name: string; value?: Expr; text: string } | { t: 'arg'; e: Expr; text: string } | { t: 'splat'; name: string };

export interface Redir {
  stream: string;
  op: '>' | '>>' | 'merge';
  target?: Expr;
}

export type Elem = { t: 'cmd'; name: Expr; args: Arg[]; call?: '&' | '.'; redirs: Redir[]; text: string } | { t: 'expr'; e: Expr; redirs: Redir[] };

export interface ParamDef {
  name: string;
  type?: string;
  attrs: Array<{ name: string; args: Expr[]; named: Record<string, Expr | true> }>;
  dflt?: Expr;
}

export interface Block {
  params?: ParamDef[];
  binding?: { args: Expr[]; named: Record<string, Expr | true> };
  begin?: Stmt[];
  process?: Stmt[];
  end?: Stmt[];
  /** True when the body used begin/process/end blocks. */
  named: boolean;
}

export type Stmt =
  | { t: 'pipe'; elems: Elem[]; line: number }
  | { t: 'assign'; target: Expr; op: string; value: Stmt; line: number }
  | { t: 'if'; clauses: Array<{ cond: Stmt; body: Stmt[] }>; else?: Stmt[]; line: number }
  | { t: 'foreach'; v: string; src: Stmt; body: Stmt[]; label?: string; line: number }
  | { t: 'for'; init?: Stmt; cond?: Stmt; step?: Stmt; body: Stmt[]; label?: string; line: number }
  | { t: 'while'; cond: Stmt; body: Stmt[]; label?: string; line: number }
  | { t: 'do'; body: Stmt[]; cond: Stmt; until: boolean; label?: string; line: number }
  | { t: 'switch'; flags: string[]; subject?: Stmt; file?: Expr; clauses: Array<{ pat: Expr | null; body: Stmt[] }>; label?: string; line: number }
  | { t: 'try'; body: Stmt[]; catches: Array<{ types: string[]; body: Stmt[] }>; fin?: Stmt[]; line: number }
  | { t: 'throw'; value?: Stmt; line: number }
  | { t: 'return'; value?: Stmt; line: number }
  | { t: 'break'; label?: string; line: number }
  | { t: 'continue'; label?: string; line: number }
  | { t: 'exit'; value?: Stmt; line: number }
  | { t: 'func'; name: string; block: Block; filter: boolean; src: string; line: number }
  | { t: 'trap'; body: Stmt[]; line: number };

/** Comparison, logical, bitwise, format and string operators written as -name (lower case, no dash). */
const COMPARISON = ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin', 'replace', 'split', 'join', 'is', 'isnot', 'as'];
const CASE_OPS = new Set(COMPARISON.filter((o) => !['is', 'isnot', 'as', 'join'].includes(o)).flatMap((o) => ['c' + o, 'i' + o]));
const ALL_COMPARISON = new Set([...COMPARISON, ...CASE_OPS]);
const LOGICAL = new Set(['and', 'or', 'xor']);
const BITWISE = new Set(['band', 'bor', 'bxor', 'shl', 'shr']);
export const OPERATOR_NAMES = new Set([...ALL_COMPARISON, ...LOGICAL, ...BITWISE, 'f', 'not', 'bnot']);

const KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue', 'exit', 'function', 'filter', 'param', 'begin', 'process', 'end', 'trap', 'in', 'class', 'enum', 'data', 'dynamicparam', 'workflow']);

const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

export class Parser {
  i = 0;
  constructor(
    public src: string,
    public lineBase = 1,
  ) {}

  line(at = this.i): number {
    let n = this.lineBase;
    for (let k = 0; k < at && k < this.src.length; k++) if (this.src[k] === '\n') n++;
    return n;
  }
  fail(msg: string): never {
    throw new ParseError(msg, this.line());
  }
  peek(n = 0): string {
    return this.src[this.i + n] ?? '';
  }
  at(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }
  atWord(w: string): boolean {
    return this.src.slice(this.i, this.i + w.length).toLowerCase() === w && !isWord(this.src[this.i + w.length]) && this.src[this.i + w.length] !== '-';
  }

  /** Skips spaces, tabs, comments and line continuations, but not newlines. */
  ws(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f') this.i++;
      else if (c === '`' && (this.peek(1) === '\n' || (this.peek(1) === '\r' && this.peek(2) === '\n'))) this.i += this.peek(1) === '\r' ? 3 : 2;
      else if (c === '<' && this.peek(1) === '#') {
        const end = this.src.indexOf('#>', this.i + 2);
        this.i = end === -1 ? this.src.length : end + 2;
      } else if (c === '#') {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
      } else return;
    }
  }
  /** Skips whitespace including newlines. */
  wsnl(): void {
    for (;;) {
      this.ws();
      if (this.peek() === '\n') this.i++;
      else return;
    }
  }
  expect(s: string): void {
    this.ws();
    if (!this.at(s)) this.fail(`Missing '${s}'${this.i < this.src.length ? ` near '${this.src.slice(this.i, this.i + 15).split('\n')[0]}'` : ''}.`);
    this.i += s.length;
  }

  /* ------------------------------------------------------------------ statements */

  parseScript(): Block {
    const b = this.parseBlockBody(null);
    this.wsnl();
    if (this.i < this.src.length) this.fail(`Unexpected token '${this.src.slice(this.i, this.i + 10).split('\n')[0]}' in expression or statement.`);
    return b;
  }

  /** The body of a script, function or script block: [attributes] param(...), then statements or begin/process/end blocks. */
  parseBlockBody(close: string | null): Block {
    const block: Block = { named: false };
    this.wsnl();
    // [CmdletBinding(...)] and other attributes before param(
    for (;;) {
      this.wsnl();
      if (this.peek() !== '[') break;
      const save = this.i;
      const attr = this.tryAttribute();
      if (!attr) {
        this.i = save;
        break;
      }
      if (attr.name.toLowerCase() === 'cmdletbinding') block.binding = { args: attr.args, named: attr.named };
      this.wsnl();
      if (!this.atWord('param') && this.peek() !== '[') {
        this.i = save;
        break;
      }
    }
    this.wsnl();
    if (this.atWord('param')) {
      const save = this.i;
      this.i += 5;
      this.ws();
      if (this.peek() === '(') block.params = this.parseParamList();
      else this.i = save;
    }
    this.wsnl();
    // begin / process / end blocks?
    const named = (w: string) => {
      if (!this.atWord(w)) return false;
      const save = this.i;
      this.i += w.length;
      this.wsnl();
      if (this.peek() === '{') return true;
      this.i = save;
      return false;
    };
    if (named('begin') || named('process') || named('end') || named('dynamicparam')) {
      // Re-read: the first matched keyword left us at "{".
      let kw = this.src.slice(0, this.i).replace(/\s+$/, '').match(/(begin|process|end|dynamicparam)$/i)![1].toLowerCase();
      block.named = true;
      for (;;) {
        this.i++;
        const body = this.parseStatements('}');
        this.expect('}');
        if (kw === 'begin') block.begin = body;
        else if (kw === 'process') block.process = body;
        else if (kw === 'end') block.end = body;
        this.wsnl();
        const next = ['begin', 'process', 'end', 'dynamicparam'].find((w) => named(w));
        if (!next) break;
        kw = next;
      }
      return block;
    }
    block.end = this.parseStatements(close);
    return block;
  }

  parseStatements(close: string | null): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === '\n' || c === ';') {
        this.i++;
        continue;
      }
      if (this.i >= this.src.length) break;
      if (close && this.at(close)) break;
      if (c === '}' || c === ')') {
        if (close) break;
        this.fail(`Unexpected token '${c}' in expression or statement.`);
      }
      out.push(this.parseStatement());
      this.ws();
      const e = this.peek();
      if (e && e !== '\n' && e !== ';' && e !== '}' && e !== ')' && !(close && this.at(close))) this.fail(`Unexpected token '${this.src.slice(this.i, this.i + 12).split('\n')[0]}' in expression or statement.`);
    }
    return out;
  }

  parseBlock(): Stmt[] {
    this.wsnl();
    this.expect('{');
    const body = this.parseStatements('}');
    this.expect('}');
    return body;
  }

  parseStatement(): Stmt {
    this.ws();
    const line = this.line();
    let label: string | undefined;
    if (this.peek() === ':' && isWord(this.peek(1))) {
      const m = /^:(\w+)/.exec(this.src.slice(this.i))!;
      label = m[1];
      this.i += m[0].length;
      this.ws();
    }
    const kw = (w: string, next?: RegExp) => {
      if (!this.atWord(w)) return false;
      if (!next) return true;
      const save = this.i;
      this.i += w.length;
      this.ws();
      const ok = next.test(this.peek());
      this.i = save;
      return ok;
    };
    if (kw('if', /[(]/)) return this.parseIf(line);
    if (kw('foreach', /[(]/)) {
      this.i += 7;
      this.expect('(');
      this.wsnl();
      if (this.peek() !== '$') this.fail("Missing variable name after foreach.");
      const v = this.parseVariableName();
      this.wsnl();
      if (!this.atWord('in')) this.fail("Missing 'in' after variable in foreach loop.");
      this.i += 2;
      this.wsnl();
      const src = this.parsePipelineOrAssign();
      this.wsnl();
      this.expect(')');
      return { t: 'foreach', v: v.name, src, body: this.parseBlock(), label, line };
    }
    if (kw('for', /[(]/)) {
      this.i += 3;
      this.expect('(');
      const part = (end: string) => {
        this.wsnl();
        if (this.at(end)) return undefined;
        const s = this.parsePipelineOrAssign();
        this.wsnl();
        return s;
      };
      const init = part(';');
      this.expect(';');
      const cond = part(';');
      this.expect(';');
      const step = part(')');
      this.expect(')');
      return { t: 'for', init, cond, step, body: this.parseBlock(), label, line };
    }
    if (kw('while', /[(]/)) {
      this.i += 5;
      this.expect('(');
      this.wsnl();
      const cond = this.parsePipelineOrAssign();
      this.wsnl();
      this.expect(')');
      return { t: 'while', cond, body: this.parseBlock(), label, line };
    }
    if (kw('do', /[{]/)) {
      this.i += 2;
      const body = this.parseBlock();
      this.wsnl();
      const until = this.atWord('until');
      if (!until && !this.atWord('while')) this.fail("Missing 'while' or 'until' in do loop.");
      this.i += until ? 5 : 5;
      this.expect('(');
      this.wsnl();
      const cond = this.parsePipelineOrAssign();
      this.wsnl();
      this.expect(')');
      return { t: 'do', body, cond, until, label, line };
    }
    if (kw('switch', /[-( $]/)) return this.parseSwitch(line, label);
    if (kw('try', /[{]/)) {
      this.i += 3;
      const body = this.parseBlock();
      const catches: Array<{ types: string[]; body: Stmt[] }> = [];
      let fin: Stmt[] | undefined;
      for (;;) {
        const save = this.i;
        this.wsnl();
        if (this.atWord('catch')) {
          this.i += 5;
          const types: string[] = [];
          for (;;) {
            this.ws();
            if (this.peek() !== '[') break;
            types.push(this.parseTypeName());
            this.ws();
            if (this.peek() === ',') {
              this.i++;
              this.wsnl();
            }
          }
          catches.push({ types, body: this.parseBlock() });
          continue;
        }
        if (this.atWord('finally')) {
          this.i += 7;
          fin = this.parseBlock();
          continue;
        }
        this.i = save;
        break;
      }
      if (!catches.length && !fin) this.fail('The Try statement is missing its Catch or Finally block.');
      return { t: 'try', body, catches, fin, line };
    }
    if (kw('trap', /[{[]/)) {
      this.i += 4;
      this.ws();
      if (this.peek() === '[') this.parseTypeName();
      return { t: 'trap', body: this.parseBlock(), line };
    }
    if (kw('function') || kw('filter')) {
      const filter = this.atWord('filter');
      const start = this.i;
      this.i += filter ? 6 : 8;
      this.ws();
      const m = /^[\w\-.:]+/.exec(this.src.slice(this.i));
      if (!m) this.fail('Missing function name.');
      const name = m[0].replace(/^(global|script|local):/i, '');
      this.i += m[0].length;
      this.wsnl();
      let params: ParamDef[] | undefined;
      if (this.peek() === '(') params = this.parseParamList();
      this.wsnl();
      this.expect('{');
      const block = this.parseBlockBody('}');
      this.expect('}');
      if (params) block.params = [...params, ...(block.params ?? [])];
      return { t: 'func', name, block, filter, src: this.src.slice(start, this.i), line };
    }
    for (const w of ['throw', 'return', 'exit'] as const) {
      if (kw(w)) {
        this.i += w.length;
        this.ws();
        const c = this.peek();
        const value = c && c !== '\n' && c !== ';' && c !== '}' && c !== ')' ? this.parsePipelineOrAssign() : undefined;
        return { t: w, value, line } as Stmt;
      }
    }
    for (const w of ['break', 'continue'] as const) {
      if (kw(w)) {
        this.i += w.length;
        this.ws();
        const m = /^:?(\w+)/.exec(this.src.slice(this.i));
        let lbl: string | undefined;
        if (m && !KEYWORDS.has(m[1].toLowerCase())) {
          lbl = m[1];
          this.i += m[0].length;
        }
        return { t: w, label: lbl, line };
      }
    }
    if (this.atWord('class') || this.atWord('enum')) this.fail('Classes and enums are not available in this simulator: use functions and hashtables.');
    const s = this.parsePipelineOrAssign();
    if (label && (s.t === 'foreach' || s.t === 'for' || s.t === 'while' || s.t === 'do' || s.t === 'switch')) s.label = label;
    return s;
  }

  parseIf(line: number): Stmt {
    const clauses: Array<{ cond: Stmt; body: Stmt[] }> = [];
    let elseBody: Stmt[] | undefined;
    this.i += 2;
    for (;;) {
      this.expect('(');
      this.wsnl();
      const cond = this.parsePipelineOrAssign();
      this.wsnl();
      this.expect(')');
      clauses.push({ cond, body: this.parseBlock() });
      const save = this.i;
      this.wsnl();
      if (this.atWord('elseif')) {
        this.i += 6;
        continue;
      }
      if (this.atWord('else')) {
        this.i += 4;
        this.wsnl();
        if (this.atWord('if')) {
          // "else if" is not PowerShell, but be helpful.
          this.fail("Use 'elseif' (one word) in PowerShell, not 'else if'.");
        }
        elseBody = this.parseBlock();
        break;
      }
      this.i = save;
      break;
    }
    return { t: 'if', clauses, else: elseBody, line };
  }

  parseSwitch(line: number, label?: string): Stmt {
    this.i += 6;
    const flags: string[] = [];
    let file: Expr | undefined;
    for (;;) {
      this.ws();
      const m = /^-(regex|wildcard|exact|casesensitive|file|parallel)\b/i.exec(this.src.slice(this.i));
      if (!m) break;
      this.i += m[0].length;
      const f = m[1].toLowerCase();
      flags.push(f);
      if (f === 'file') {
        this.ws();
        file = this.parseCommandArgValue();
      }
    }
    this.ws();
    let subject: Stmt | undefined;
    if (!file) {
      this.expect('(');
      this.wsnl();
      subject = this.parsePipelineOrAssign();
      this.wsnl();
      this.expect(')');
    }
    this.wsnl();
    this.expect('{');
    const clauses: Array<{ pat: Expr | null; body: Stmt[] }> = [];
    for (;;) {
      this.wsnl();
      while (this.peek() === ';') {
        this.i++;
        this.wsnl();
      }
      if (this.peek() === '}') {
        this.i++;
        break;
      }
      if (this.i >= this.src.length) this.fail("Missing closing '}' in switch statement.");
      let pat: Expr | null;
      if (this.atWord('default')) {
        this.i += 7;
        pat = null;
      } else if (this.peek() === '{' || this.peek() === '(' || this.peek() === '$' || this.peek() === '"' || this.peek() === "'" || /[0-9-]/.test(this.peek())) {
        pat = this.peek() === '{' ? this.parseScriptBlockLiteral() : this.parseUnaryHigh();
      } else {
        const m = /^[^\s{]+/.exec(this.src.slice(this.i))!;
        this.i += m[0].length;
        pat = { t: 'str', v: m[0] };
      }
      clauses.push({ pat, body: this.parseBlock() });
    }
    return { t: 'switch', flags, subject, file, clauses, label, line };
  }

  /** param( [attr()] [type] $name = default, ... ) */
  parseParamList(): ParamDef[] {
    this.expect('(');
    const params: ParamDef[] = [];
    for (;;) {
      this.wsnl();
      if (this.peek() === ')') {
        this.i++;
        break;
      }
      const p: ParamDef = { name: '', attrs: [] };
      for (;;) {
        this.wsnl();
        if (this.peek() !== '[') break;
        const save = this.i;
        const attr = this.tryAttribute();
        if (attr) {
          p.attrs.push(attr);
          continue;
        }
        this.i = save;
        p.type = this.parseTypeName();
      }
      this.wsnl();
      if (this.peek() !== '$') this.fail('Missing parameter variable name ($name) in param block.');
      p.name = this.parseVariableName().name;
      this.wsnl();
      if (this.peek() === '=') {
        this.i++;
        this.wsnl();
        p.dflt = this.parseExpression();
      }
      params.push(p);
      this.wsnl();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      this.wsnl();
      if (this.peek() === ')') {
        this.i++;
        break;
      }
      this.fail("Missing ')' in function parameter list.");
    }
    return params;
  }

  /** [Name(args)] attribute, or null when the brackets hold a type. */
  tryAttribute(): { name: string; args: Expr[]; named: Record<string, Expr | true> } | null {
    const m = /^\[\s*([\w.]+)\s*\(/.exec(this.src.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    const args: Expr[] = [];
    const named: Record<string, Expr | true> = {};
    for (;;) {
      this.wsnl();
      if (this.peek() === ')') {
        this.i++;
        break;
      }
      const nm = /^(\w+)\s*(=)?/.exec(this.src.slice(this.i));
      if (nm && (nm[2] || /^\w+\s*[,)]/.test(this.src.slice(this.i))) && !/^\d/.test(nm[1]) && !/^\$/.test(nm[1])) {
        this.i += nm[0].length;
        this.wsnl();
        named[nm[1].toLowerCase()] = nm[2] ? this.parseExpressionNoComma() : true;
      } else args.push(this.parseExpressionNoComma());
      this.wsnl();
      if (this.peek() === ',') this.i++;
    }
    this.ws();
    if (this.peek() !== ']') this.fail("Missing ']' after attribute.");
    this.i++;
    return { name: m[1], args, named };
  }

  /** [Type.Name], [string[]], [System.Collections.Generic.List[string]] */
  parseTypeName(): string {
    if (this.peek() !== '[') this.fail("Missing '['.");
    let depth = 0;
    const start = this.i;
    for (; this.i < this.src.length; this.i++) {
      if (this.src[this.i] === '[') depth++;
      else if (this.src[this.i] === ']' && --depth === 0) {
        this.i++;
        return this.src.slice(start + 1, this.i - 1).trim();
      }
    }
    this.fail("Missing ']' after type name.");
  }

  parseVariableName(): { name: string; scope?: string } {
    if (this.peek() !== '$') this.fail('Missing variable.');
    this.i++;
    if (this.peek() === '{') {
      const end = this.src.indexOf('}', this.i);
      const raw = this.src.slice(this.i + 1, end);
      this.i = end + 1;
      return splitScope(raw);
    }
    const m = /^(?:(global|script|local|private|using|env|variable|function):)?([A-Za-z_][\w]*|\?|\$|\^|_)/i.exec(this.src.slice(this.i));
    if (!m) this.fail("Variable reference is not valid. '$' was not followed by a valid variable name character.");
    this.i += m[0].length;
    return m[1] ? { name: m[2], scope: m[1].toLowerCase() } : { name: m[2] };
  }

  /* ------------------------------------------------------------------ pipelines and assignment */

  parsePipelineOrAssign(): Stmt {
    this.ws();
    const line = this.line();
    const start = this.i;
    // Statements usable as values: $x = if (...) {...}, $x = foreach (...) {...}
    if (this.peek() === '$' || this.peek() === '[') {
      try {
        const target = this.parseUnaryHigh();
        this.ws();
        const m = /^(=(?!=)|\+=|-=|\*=|\/=|%=|\?\?=)/.exec(this.src.slice(this.i));
        if (m && isAssignable(target)) {
          this.i += m[0].length;
          this.wsnl();
          let value: Stmt;
          if (/^(if|switch|foreach|for|while|do|try)\b/i.test(this.src.slice(this.i)) && /^(if|switch|foreach|for|while)\s*[(-]|^(do|try)\s*\{|^switch\s/i.test(this.src.slice(this.i))) value = this.parseStatement();
          else value = this.parsePipelineOrAssign();
          return { t: 'assign', target, op: m[0], value, line };
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
      }
      this.i = start;
    }
    return this.parsePipeline();
  }

  parsePipeline(): Stmt {
    const line = this.line();
    const elems: Elem[] = [this.parseElement(true)];
    for (;;) {
      this.ws();
      if (this.peek() === '|' && this.peek(1) !== '|') {
        this.i++;
        this.wsnl();
        elems.push(this.parseElement(false));
        continue;
      }
      break;
    }
    return { t: 'pipe', elems, line };
  }

  parseElement(first: boolean): Elem {
    this.ws();
    const start = this.i;
    const c = this.peek();
    let call: '&' | '.' | undefined;
    if ((c === '&' && this.peek(1) !== '&') || (c === '.' && /[\s]/.test(this.peek(1)))) {
      call = c as '&' | '.';
      this.i++;
      this.ws();
      const name = this.peek() === '{' ? this.parseScriptBlockLiteral() : this.parseCommandArgValue();
      const args = this.parseCommandArgs();
      return { t: 'cmd', name, args: args.args, call, redirs: args.redirs, text: this.src.slice(start, this.i).trim() };
    }
    const isCommandStart = /[A-Za-z_\\]/.test(c) || (c === '.' && /[\\/.]/.test(this.peek(1))) || (/[A-Za-z]/.test(c) && this.peek(1) === ':') || ((c === '%' || c === '?') && /[\s{]/.test(this.peek(1) || ' '));
    if (isCommandStart && !/^\d/.test(c)) {
      const m = /^[^\s;|(){}&,<>]+/.exec(this.src.slice(this.i))!;
      const word = m[0];
      this.i += word.length;
      const name: Expr = /\$/.test(word) ? this.expandBareword(word) : { t: 'str', v: word.replace(/`(.)/g, '$1') };
      const args = this.parseCommandArgs();
      return { t: 'cmd', name, args: args.args, redirs: args.redirs, text: this.src.slice(start, this.i).trim() };
    }
    if (!first) this.fail('Expressions are only allowed as the first element of a pipeline.');
    const e = this.parseExpression();
    return { t: 'expr', e, redirs: this.parseRedirs() };
  }

  parseRedirs(): Redir[] {
    const out: Redir[] = [];
    for (;;) {
      this.ws();
      const m = /^([1-6*]?)(>>|>&1|>)/.exec(this.src.slice(this.i));
      if (!m) return out;
      this.i += m[0].length;
      const stream = m[1] || '1';
      if (m[2] === '>&1') {
        out.push({ stream, op: 'merge' });
        continue;
      }
      this.ws();
      out.push({ stream, op: m[2] as '>' | '>>', target: this.parseCommandArgValue() });
    }
  }

  parseCommandArgs(): { args: Arg[]; redirs: Redir[] } {
    const args: Arg[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      this.ws();
      const c = this.peek();
      if (!c || c === '\n' || c === ';' || c === ')' || c === '}' || (c === '|' && this.peek(1) !== '|') || this.at('&&') || this.at('||')) break;
      if (/^[1-6*]?>/.test(this.src.slice(this.i))) {
        redirs.push(...this.parseRedirs());
        continue;
      }
      if (c === '<') this.fail("The '<' operator is reserved for future use.");
      const start = this.i;
      // -Name or -Name:value; a dash word that runs on (-type=SRV) is passed whole, as to native tools.
      const pm = c === '-' && /[A-Za-z_?]/.test(this.peek(1)) ? /^-([A-Za-z_?][\w-]*)(:)?/.exec(this.src.slice(this.i)) : null;
      if (pm && !pm[2] && this.src[this.i + pm[0].length] && !/[\s;|(){},]/.test(this.src[this.i + pm[0].length])) {
        const word = /^[^\s;|(){},]+/.exec(this.src.slice(this.i))![0];
        this.i += word.length;
        args.push({ t: 'arg', e: { t: 'str', v: word }, text: word });
        continue;
      }
      if (pm) {
        const m = pm;
        this.i += m[0].length;
        if (m[2]) {
          this.ws();
          const value = this.parseCommandArg();
          args.push({ t: 'param', name: m[1], value, text: this.src.slice(start, this.i) });
        } else args.push({ t: 'param', name: m[1], text: m[0] });
        continue;
      }
      if (c === '@' && /[A-Za-z_]/.test(this.peek(1))) {
        const m = /^@(\w+)/.exec(this.src.slice(this.i))!;
        this.i += m[0].length;
        args.push({ t: 'splat', name: m[1] });
        continue;
      }
      if (c === '-' && this.peek(1) === '-' && /[\s]/.test(this.peek(2) || ' ')) {
        this.i += 2;
        continue;
      }
      const e = this.parseCommandArg();
      args.push({ t: 'arg', e, text: this.src.slice(start, this.i) });
    }
    return { args, redirs };
  }

  /** One argument, which may be a comma-separated list. */
  parseCommandArg(): Expr {
    const items = [this.parseCommandArgValue()];
    for (;;) {
      this.ws();
      if (this.peek() !== ',') break;
      this.i++;
      this.wsnl();
      items.push(this.parseCommandArgValue());
    }
    return items.length > 1 ? { t: 'array', items } : items[0];
  }

  parseCommandArgValue(): Expr {
    this.ws();
    const c = this.peek();
    // $PSScriptRoot\file.ps1 and C:\Users\$name: a variable joined to more text is one expandable word.
    if (c === '$' && this.peek(1) !== '(') {
      const word = /^[^\s;|(){},]+/.exec(this.src.slice(this.i))?.[0] ?? '';
      if (/^\$\{?[\w:]+\}?[\\/]/.test(word)) {
        this.i += word.length;
        return this.expandBareword(word);
      }
    }
    if (c === '$' || c === '(' || (c === '@' && /[({'"]/.test(this.peek(1))) || c === '{' || c === '"' || c === "'") return this.parsePostfix(this.parsePrimary());
    // A number, unless the word continues (2am, 1.2.3, 10GB stays text for cmdlets that parse sizes).
    const word = /^[^\s;|(){},]+/.exec(this.src.slice(this.i))?.[0] ?? '';
    if (/^-?(0x[0-9a-f]+|\d+(\.\d+)?([eE][-+]?\d+)?)$/i.test(word)) {
      this.i += word.length;
      return { t: 'num', v: Number(word) };
    }
    if (!word) this.fail(`Missing argument near '${this.src.slice(this.i, this.i + 10)}'.`);
    this.i += word.length;
    return /\$/.test(word) ? this.expandBareword(word) : { t: 'str', v: word.replace(/`(.)/g, '$1') };
  }

  /** A bareword with $variables inside (C:\Users\$name) expands like a double-quoted string. */
  expandBareword(word: string): Expr {
    return { t: 'xstr', parts: new Parser(word, this.line()).parseExpandable(word) };
  }

  /* ------------------------------------------------------------------ expressions */

  parseExpression(): Expr {
    return this.parseLogical(false);
  }
  parseExpressionNoComma(): Expr {
    return this.parseLogical(true);
  }

  /** -word operator at the current position (after whitespace), or null. */
  peekOp(): string | null {
    this.ws();
    if (this.peek() !== '-') return null;
    const m = /^-([A-Za-z]+)/.exec(this.src.slice(this.i));
    if (!m) return null;
    const op = m[1].toLowerCase();
    return OPERATOR_NAMES.has(op) ? op : null;
  }
  takeOp(op: string): void {
    this.i += op.length + 1;
    this.wsnl();
  }

  parseLogical(noComma: boolean): Expr {
    let l = this.parseBitwise(noComma);
    for (let op = this.peekOp(); op && LOGICAL.has(op); op = this.peekOp()) {
      this.takeOp(op);
      l = { t: 'bin', op, l, r: this.parseBitwise(noComma) };
    }
    return l;
  }
  parseBitwise(noComma: boolean): Expr {
    let l = this.parseComparison(noComma);
    for (let op = this.peekOp(); op && BITWISE.has(op); op = this.peekOp()) {
      this.takeOp(op);
      l = { t: 'bin', op, l, r: this.parseComparison(noComma) };
    }
    return l;
  }
  parseComparison(noComma: boolean): Expr {
    let l = this.parseAdditive(noComma);
    for (let op = this.peekOp(); op && ALL_COMPARISON.has(op); op = this.peekOp()) {
      this.takeOp(op);
      l = { t: 'bin', op, l, r: this.parseAdditive(noComma) };
    }
    return l;
  }
  parseAdditive(noComma: boolean): Expr {
    let l = this.parseMultiplicative(noComma);
    for (;;) {
      this.ws();
      const c = this.peek();
      if ((c === '+' || c === '-') && this.peek(1) !== '=' && this.peek(1) !== c && !(c === '-' && /[A-Za-z]/.test(this.peek(1)))) {
        this.i++;
        this.wsnl();
        l = { t: 'bin', op: c, l, r: this.parseMultiplicative(noComma) };
      } else return l;
    }
  }
  parseMultiplicative(noComma: boolean): Expr {
    let l = this.parseNegation(noComma);
    for (;;) {
      this.ws();
      const c = this.peek();
      if ((c === '*' || c === '/' || c === '%') && this.peek(1) !== '=' && !(c === '*' && this.peek(1) === '>')) {
        this.i++;
        this.wsnl();
        l = { t: 'bin', op: c, l, r: this.parseNegation(noComma) };
      } else return l;
    }
  }
  parseNegation(noComma: boolean): Expr {
    this.ws();
    const c = this.peek();
    if ((c === '-' || c === '+') && !/[A-Za-z0-9.$(]/.test(this.peek(1)) && this.peek(1) !== c) {
      this.i++;
      return { t: 'unary', op: c, e: this.parseNegation(noComma) };
    }
    if (c === '-' && /[$(]/.test(this.peek(1))) {
      this.i++;
      return { t: 'unary', op: '-', e: this.parseNegation(noComma) };
    }
    return this.parseFormat(noComma);
  }
  parseFormat(noComma: boolean): Expr {
    let l = this.parseRange(noComma);
    for (let op = this.peekOp(); op === 'f'; op = this.peekOp()) {
      this.takeOp(op);
      l = { t: 'bin', op: 'f', l, r: this.parseRange(noComma) };
    }
    return l;
  }
  parseRange(noComma: boolean): Expr {
    const l = this.parseNot(noComma);
    this.ws();
    if (this.at('..')) {
      this.i += 2;
      this.wsnl();
      return { t: 'bin', op: '..', l, r: this.parseNot(noComma) };
    }
    return l;
  }
  parseNot(noComma: boolean): Expr {
    this.ws();
    if (this.peek() === '!' && this.peek(1) !== '=') {
      this.i++;
      this.wsnl();
      return { t: 'unary', op: 'not', e: this.parseNot(noComma) };
    }
    const op = this.peekOp();
    if (op === 'not' || op === 'bnot') {
      this.takeOp(op);
      return { t: 'unary', op, e: this.parseNot(noComma) };
    }
    return this.parseComma(noComma);
  }
  parseComma(noComma: boolean): Expr {
    this.ws();
    if (!noComma && this.peek() === ',') {
      this.i++;
      this.wsnl();
      return { t: 'array', items: [this.parseUnaryHigh()] };
    }
    const first = this.parseUnaryHigh();
    if (noComma) return first;
    const items = [first];
    for (;;) {
      this.ws();
      if (this.peek() !== ',') break;
      this.i++;
      this.wsnl();
      items.push(this.parseUnaryHigh());
    }
    return items.length > 1 ? { t: 'array', items } : first;
  }
  /** Casts, unary -split/-join, prefix ++/--, then postfix expressions. */
  parseUnaryHigh(): Expr {
    this.ws();
    const c = this.peek();
    if (c === '[') {
      const save = this.i;
      const type = this.parseTypeName();
      this.ws();
      if (this.at('::')) {
        this.i = save;
        return this.parsePostfix(this.parsePrimary());
      }
      const n = this.peek();
      if (n && !/[\s,;)}\]|=]/.test(n) && !(n === '-' && /[A-Za-z]/.test(this.peek(1)) && this.peekOp() !== null && !['split', 'join', 'not'].includes(this.peekOp()!))) {
        return { t: 'cast', type, e: this.parseUnaryHigh() };
      }
      return this.parsePostfix({ t: 'type', name: type });
    }
    if ((c === '+' || c === '-') && this.peek(1) === c) {
      this.i += 2;
      return { t: 'incdec', op: (c + c) as '++' | '--', prefix: true, e: this.parseUnaryHigh() };
    }
    const op = this.peekOp();
    if (op === 'split' || op === 'join') {
      this.takeOp(op);
      return { t: 'unary', op, e: this.parseUnaryHigh() };
    }
    if (c === '-' && /[0-9.]/.test(this.peek(1))) {
      this.i++;
      const e = this.parsePostfix(this.parsePrimary());
      return e.t === 'num' ? { t: 'num', v: -e.v } : { t: 'unary', op: '-', e };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(e: Expr): Expr {
    for (;;) {
      const c = this.peek();
      if ((c === '.' && this.peek(1) !== '.') || this.at('::')) {
        const isStatic = this.at('::');
        const save = this.i;
        this.i += isStatic ? 2 : 1;
        let name: string | Expr;
        if (this.peek() === '$') name = { t: 'var', ...this.parseVariableName() };
        else if (this.peek() === "'" || this.peek() === '"') name = this.parsePrimary();
        else {
          const m = /^[A-Za-z_][\w]*/.exec(this.src.slice(this.i));
          if (!m) {
            this.i = save;
            return e;
          }
          name = m[0];
          this.i += m[0].length;
        }
        if (this.peek() === '(' && typeof name === 'string') {
          this.i++;
          const args: Expr[] = [];
          for (;;) {
            this.wsnl();
            if (this.peek() === ')') {
              this.i++;
              break;
            }
            args.push(this.parseExpressionNoComma());
            this.wsnl();
            if (this.peek() === ',') this.i++;
            else if (this.peek() !== ')') this.fail("Missing ')' in method call.");
          }
          e = { t: 'invoke', obj: e, name, args, static: isStatic };
        } else e = { t: 'member', obj: e, name, static: isStatic };
        continue;
      }
      if (c === '[' && e.t !== 'num') {
        this.i++;
        this.wsnl();
        const index = this.parseExpression();
        this.wsnl();
        this.expect(']');
        e = { t: 'index', obj: e, index };
        continue;
      }
      if ((c === '+' || c === '-') && this.peek(1) === c && (e.t === 'var' || e.t === 'member' || e.t === 'index')) {
        this.i += 2;
        e = { t: 'incdec', op: (c + c) as '++' | '--', prefix: false, e };
        continue;
      }
      return e;
    }
  }

  parsePrimary(): Expr {
    this.ws();
    const c = this.peek();
    const start = this.i;
    if (c === '$') {
      if (this.peek(1) === '(') {
        this.i += 2;
        const body = this.parseStatements(')');
        this.wsnl();
        this.expect(')');
        return { t: 'sub', body };
      }
      return { t: 'var', ...this.parseVariableName() };
    }
    if (c === '@') {
      const n = this.peek(1);
      if (n === '(') {
        this.i += 2;
        const body = this.parseStatements(')');
        this.wsnl();
        this.expect(')');
        return { t: 'sub', body, array: true };
      }
      if (n === '{') return this.parseHash();
      if (n === '"' || n === "'") return this.parseHereString();
      this.fail("Unrecognized token '@' in expression.");
    }
    if (c === '(') {
      this.i++;
      this.wsnl();
      const body = this.peek() === ')' ? ({ t: 'pipe', elems: [{ t: 'expr', e: { t: 'var', name: 'null' }, redirs: [] }], line: this.line() } as Stmt) : this.parseStatement();
      this.wsnl();
      this.expect(')');
      return { t: 'paren', body };
    }
    if (c === '{') return this.parseScriptBlockLiteral();
    if (c === "'") {
      let s = '';
      let j = this.i + 1;
      for (; j < this.src.length; j++) {
        if ((this.src[j] === "'" || this.src[j] === '\u2019') && this.src[j + 1] === "'") {
          s += "'";
          j++;
        } else if (this.src[j] === "'") break;
        else s += this.src[j];
      }
      if (j >= this.src.length) this.fail("The string is missing the terminator: '.");
      this.i = j + 1;
      return { t: 'str', v: s };
    }
    if (c === '"') {
      let j = this.i + 1;
      for (; j < this.src.length; j++) {
        const ch = this.src[j];
        if (ch === '`') j++;
        else if (ch === '$' && this.src[j + 1] === '(') j = findClose(this.src, j + 1) ;
        else if (ch === '"' && this.src[j + 1] === '"') j++;
        else if (ch === '"') break;
      }
      if (j >= this.src.length) this.fail('The string is missing the terminator: ".');
      const body = this.src.slice(this.i + 1, j);
      this.i = j + 1;
      return { t: 'xstr', parts: new Parser(body, this.line(start)).parseExpandable(body) };
    }
    const num = /^(0x[0-9a-f]+|(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?)(kb|mb|gb|tb|pb)?(d|l)?(?![\w])/i.exec(this.src.slice(this.i));
    if (num) {
      this.i += num[0].length;
      let v = Number(num[1]);
      const mult = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 }[(num[2] ?? '').toLowerCase()];
      if (mult) v *= mult;
      return { t: 'num', v };
    }
    if (c === '[') return { t: 'type', name: this.parseTypeName() };
    const word = /^[A-Za-z_][\w-]*/.exec(this.src.slice(this.i));
    if (word) {
      this.i += word[0].length;
      return { t: 'bare', name: word[0] };
    }
    this.fail(`Unexpected token '${c || 'end of input'}' in expression or statement.`);
  }

  parseScriptBlockLiteral(): Expr {
    const line = this.line();
    const end = findClose(this.src, this.i, '{', '}');
    const src = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    return { t: 'block', src, line };
  }

  parseHash(): Expr {
    this.i += 2;
    const entries: Array<{ key: Expr; value: Stmt }> = [];
    for (;;) {
      this.wsnl();
      while (this.peek() === ';') {
        this.i++;
        this.wsnl();
      }
      if (this.peek() === '}') {
        this.i++;
        return { t: 'hash', entries };
      }
      let key: Expr;
      const c = this.peek();
      if (c === "'" || c === '"' || c === '$' || c === '(') key = this.parsePostfix(this.parsePrimary());
      else {
        const m = /^[^\s=;}]+/.exec(this.src.slice(this.i));
        if (!m) this.fail('Missing key before \'=\' in hash literal.');
        this.i += m[0].length;
        key = /^\d+$/.test(m[0]) ? { t: 'num', v: Number(m[0]) } : { t: 'str', v: m[0] };
      }
      this.ws();
      if (this.peek() !== '=') this.fail("Missing '=' operator after key in hash literal.");
      this.i++;
      this.wsnl();
      const value = this.parseStatement();
      entries.push({ key, value });
      this.ws();
      const n = this.peek();
      if (n !== ';' && n !== '\n' && n !== '}') this.fail(`Missing statement after '=' in hash literal, or a ';' or newline between entries.`);
    }
  }

  parseHereString(): Expr {
    const q = this.peek(1);
    const nl = this.src.indexOf('\n', this.i);
    if (nl === -1 || this.src.slice(this.i + 2, nl).trim()) this.fail('No characters are allowed after a here-string header but before the end of the line.');
    const close = new RegExp(`\\n${q}@`, 'g');
    close.lastIndex = nl;
    const m = close.exec(this.src);
    if (!m) this.fail(`The string is missing the terminator: ${q}@.`);
    const body = this.src.slice(nl + 1, m.index);
    const line = this.line();
    this.i = m.index + 3;
    if (q === "'") return { t: 'str', v: body };
    return { t: 'xstr', parts: new Parser(body, line + 1).parseExpandable(body, true) };
  }

  /** The parts of an expandable string: text, $variables and $(subexpressions). Backticks escape. */
  parseExpandable(body: string, here = false): Array<string | Expr> {
    const parts: Array<string | Expr> = [];
    let text = '';
    const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b' };
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (ch === '`' && j + 1 < body.length) {
        const n = body[++j];
        text += ESC[n] ?? n;
        continue;
      }
      if (!here && ch === '"' && body[j + 1] === '"') {
        text += '"';
        j++;
        continue;
      }
      if (ch === '$' && body[j + 1] === '(') {
        const end = findClose(body, j + 1);
        const p = new Parser(body.slice(j + 2, end), this.lineBase);
        const stmts = p.parseStatements(null);
        if (text) parts.push(text);
        text = '';
        parts.push({ t: 'sub', body: stmts });
        j = end;
        continue;
      }
      if (ch === '$') {
        const rest = body.slice(j + 1);
        const braced = /^\{([^}]+)\}/.exec(rest);
        const m = braced ?? /^(?:(global|script|local|env|using):)?([A-Za-z_]\w*|_|\?|\$)/i.exec(rest);
        if (m) {
          if (text) parts.push(text);
          text = '';
          parts.push(braced ? { t: 'var', ...splitScope(braced[1]) } : m[1] ? { t: 'var', name: m[2], scope: m[1].toLowerCase() } : { t: 'var', name: m[2] });
          j += m[0].length;
          continue;
        }
      }
      text += ch;
    }
    if (text) parts.push(text);
    return parts;
  }
}

function splitScope(raw: string): { name: string; scope?: string } {
  const m = /^(global|script|local|private|using|env|variable|function):(.+)$/i.exec(raw);
  return m ? { name: m[2], scope: m[1].toLowerCase() } : { name: raw };
}

function isAssignable(e: Expr): boolean {
  return e.t === 'var' || e.t === 'member' || e.t === 'index' || (e.t === 'cast' && e.e.t === 'var');
}

/** Index of the bracket closing the one at `open`, skipping strings, comments and nested brackets. */
export function findClose(src: string, open: number, o = '(', c = ')'): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === '`') {
      j++;
      continue;
    }
    if (ch === "'") {
      j++;
      while (j < src.length && !(src[j] === "'" && src[j + 1] !== "'")) j += src[j] === "'" ? 2 : 1;
      continue;
    }
    if (ch === '"') {
      j++;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '`') j++;
        else if (src[j] === '$' && src[j + 1] === '(') j = findClose(src, j + 1);
        j++;
      }
      continue;
    }
    if (ch === '@' && (src[j + 1] === '"' || src[j + 1] === "'") && src[j + 2] === '\n') {
      const end = src.indexOf(`\n${src[j + 1]}@`, j + 2);
      j = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === '#' && (j === 0 || /\s/.test(src[j - 1]))) {
      while (j < src.length && src[j] !== '\n') j++;
      continue;
    }
    if (ch === '<' && src[j + 1] === '#') {
      const end = src.indexOf('#>', j);
      j = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === o) depth++;
    else if (ch === c && --depth === 0) return j;
  }
  throw new ParseError(`Missing closing '${c}' in statement block or type definition.`);
}

const CACHE = new Map<string, Block>();

/** Parses a script (cached by source text, since script blocks run many times). */
export function parseScript(src: string, lineBase = 1): Block {
  const key = `${lineBase}\u0000${src}`;
  const hit = CACHE.get(key);
  if (hit) return hit;
  const b = new Parser(src, lineBase).parseScript();
  if (CACHE.size > 2000) CACHE.clear();
  CACHE.set(key, b);
  return b;
}

/** True while brackets or quotes are still open, so a terminal keeps reading lines. */
export function needsMore(src: string): boolean {
  try {
    new Parser(src).parseScript();
    return false;
  } catch (e) {
    if (!(e instanceof ParseError)) return false;
    return /missing (closing|the terminator|statement block|'\}'|'\)'|'\]')|Missing statement body|Missing '\{'|terminator|missing its Catch/i.test(e.message) || /`\s*$/.test(src);
  }
}
