/**
 * A small algebraic expression language: numbers, variables, + - * / ^, parentheses, implicit
 * multiplication (2x, 3(x+1)), functions (sin cos tan asin acos atan exp ln log log2 sqrt abs
 * floor ceil round) and the constants pi and e. Expressions are compared by evaluating both at
 * sample points, which decides equivalence without a symbolic algebra system.
 */

export type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: Node; right: Node }
  | { kind: 'call'; fn: string; arg: Node };

const FUNCTIONS: Record<string, (x: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  log2: Math.log2,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = src.replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/π/g, 'pi').replace(/\*\*/g, '^');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i))!;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(s.slice(i))!;
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/^()'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" in the expression.`);
  }
  // Implicit multiplication: 2x, 2(x+1), x(x+1), (x)(y), x y
  const withMul: Token[] = [];
  for (let k = 0; k < out.length; k++) {
    const cur = out[k];
    const prev = withMul[withMul.length - 1];
    const prevIsValue = prev && (prev.t === 'num' || (prev.t === 'id' && !(prev.v in FUNCTIONS)) || (prev.t === 'op' && prev.v === ')'));
    const curStartsValue = cur.t === 'num' || cur.t === 'id' || (cur.t === 'op' && cur.v === '(');
    if (prevIsValue && curStartsValue) withMul.push({ t: 'op', v: '*' });
    withMul.push(cur);
  }
  return withMul;
}

export function parseExpr(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expectOp = (v: string) => {
    const t = take();
    if (!t || t.t !== 'op' || t.v !== v) throw new Error(`Expected "${v}" in the expression.`);
  };

  function parseAdd(): Node {
    let left = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
        take();
        left = { kind: 'bin', op: t.v, left, right: parseMul() };
      } else return left;
    }
  }
  function parseMul(): Node {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '*' || t.v === '/')) {
        take();
        left = { kind: 'bin', op: t.v, left, right: parseUnary() };
      } else return left;
    }
  }
  function parseUnary(): Node {
    const t = peek();
    if (t && t.t === 'op' && t.v === '-') {
      take();
      return { kind: 'neg', arg: parseUnary() };
    }
    if (t && t.t === 'op' && t.v === '+') {
      take();
      return parseUnary();
    }
    return parsePow();
  }
  function parsePow(): Node {
    const base = parseAtom();
    const t = peek();
    if (t && t.t === 'op' && t.v === '^') {
      take();
      return { kind: 'bin', op: '^', left: base, right: parseUnary() }; // right-associative, allows x^-1
    }
    return base;
  }
  function parseAtom(): Node {
    const t = take();
    if (!t) throw new Error('The expression ends too early.');
    if (t.t === 'num') return { kind: 'num', value: t.v };
    if (t.t === 'id') {
      if (t.v in FUNCTIONS) {
        expectOp('(');
        const arg = parseAdd();
        expectOp(')');
        return { kind: 'call', fn: t.v, arg };
      }
      return { kind: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') {
      const inner = parseAdd();
      expectOp(')');
      return inner;
    }
    throw new Error(`Unexpected "${t.v}" in the expression.`);
  }

  if (tokens.length === 0) throw new Error('Enter an expression.');
  const node = parseAdd();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].v}" near the end of the expression.`);
  return node;
}

export function evaluate(node: Node, env: Record<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var':
      if (node.name in env) return env[node.name];
      if (node.name in CONSTANTS) return CONSTANTS[node.name];
      throw new Error(`Unknown variable "${node.name}".`);
    case 'neg':
      return -evaluate(node.arg, env);
    case 'call':
      return FUNCTIONS[node.fn](evaluate(node.arg, env));
    case 'bin': {
      const a = evaluate(node.left, env);
      const b = evaluate(node.right, env);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return Math.pow(a, b);
      }
    }
  }
}

export function variablesOf(node: Node, into: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'var':
      if (!(node.name in CONSTANTS)) into.add(node.name);
      break;
    case 'neg':
    case 'call':
      variablesOf(node.arg, into);
      break;
    case 'bin':
      variablesOf(node.left, into);
      variablesOf(node.right, into);
      break;
  }
  return into;
}

/** Deterministic sample points so a check gives the same verdict every time. */
function samples(count: number, lo: number, hi: number, seedOffset = 0): number[] {
  const out: number[] = [];
  let seed = 12345 + 7919 * seedOffset;
  for (let i = 0; i < count; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out.push(lo + ((seed / 2147483648) * (hi - lo)));
  }
  return out;
}

export interface EquivalenceOptions {
  variables?: string[];
  domain?: [number, number];
  tolerance?: number;
  points?: number;
}

/**
 * Compares two expressions at sample points. Returns null when they agree (relative
 * tolerance), otherwise a sentence with a counterexample.
 */
export function expressionsEquivalent(learner: string, expected: string, opts: EquivalenceOptions = {}): string | null {
  let a: Node;
  try {
    a = parseExpr(learner);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const b = parseExpr(expected);
  // The expected expression decides which variables are allowed; anything else in the learner's answer is an error.
  const vars = opts.variables ?? [...variablesOf(b)];
  const extra = [...variablesOf(a)].filter((v) => !vars.includes(v));
  if (extra.length) return `the expression uses ${extra.map((v) => `"${v}"`).join(', ')}, which ${extra.length === 1 ? 'is' : 'are'} not ${vars.length ? `among ${vars.join(', ')}` : 'allowed here'}`;
  const [lo, hi] = opts.domain ?? [-3, 3];
  const tol = opts.tolerance ?? 1e-6;
  const n = opts.points ?? 25;
  let compared = 0;
  const pts = vars.map((_, k) => samples(n, lo, hi, k));
  for (let i = 0; i < n; i++) {
    const env: Record<string, number> = {};
    vars.forEach((v, k) => (env[v] = pts[k][i]));
    let ya: number;
    let yb: number;
    try {
      yb = evaluate(b, env);
      ya = evaluate(a, env);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (!Number.isFinite(yb)) continue; // the expected expression is undefined here (a pole); skip
    compared++;
    if (!Number.isFinite(ya) || Math.abs(ya - yb) > tol * Math.max(1, Math.abs(yb))) {
      const where = vars.map((v) => `${v} = ${round(env[v])}`).join(', ');
      return `at ${where} your expression gives ${Number.isFinite(ya) ? round(ya) : 'no value'} but it should give ${round(yb)}`;
    }
  }
  return compared === 0 ? 'the expression could not be evaluated on the test range' : null;
}

export function round(x: number, dp = 4): number {
  const f = Math.pow(10, dp);
  return Math.round(x * f) / f;
}

/** Parses a plain number, allowing fractions like 3/4 and constants like pi/6. */
export function parseNumber(text: string): number | null {
  const s = text.trim().replace(/,/g, '');
  if (!s) return null;
  try {
    const v = evaluate(parseExpr(s), {});
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
