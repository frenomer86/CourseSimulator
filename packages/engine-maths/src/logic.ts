/**
 * Propositional logic: parse a formula over variables (p, q, r, ...), build its truth table,
 * and decide equivalence by comparing tables.
 *
 * Operators (several spellings): not ¬ ~ !   and ∧ & ·   or ∨ |   xor ⊕   implies → ->   iff ↔ <->
 * Precedence: not, and, or/xor, implies (right-associative), iff.
 */

export type Formula =
  | { kind: 'var'; name: string }
  | { kind: 'const'; value: boolean }
  | { kind: 'not'; arg: Formula }
  | { kind: 'and' | 'or' | 'xor' | 'implies' | 'iff'; left: Formula; right: Formula };

type Tok = { t: 'var'; v: string } | { t: 'const'; v: boolean } | { t: 'op'; v: string };

const WORDS: Record<string, string> = {
  not: '~',
  and: '&',
  or: '|',
  xor: '^',
  implies: '->',
  iff: '<->',
  true: 'T',
  false: 'F',
};

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const s = src
    .replace(/¬/g, '~')
    .replace(/!/g, '~')
    .replace(/∧/g, '&')
    .replace(/·/g, '&')
    .replace(/\^\^|⊕/g, '^')
    .replace(/∨/g, '|')
    .replace(/↔|<=>|≡/g, '<->')
    .replace(/→|=>|⊃/g, '->');
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (s.startsWith('<->', i)) {
      out.push({ t: 'op', v: '<->' });
      i += 3;
      continue;
    }
    if (s.startsWith('->', i)) {
      out.push({ t: 'op', v: '->' });
      i += 2;
      continue;
    }
    if ('~&|^()'.includes(c)) {
      out.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const m = /^[a-zA-Z][a-zA-Z0-9_]*/.exec(s.slice(i))!;
      const word = m[0];
      const lower = word.toLowerCase();
      if (lower in WORDS) {
        const v = WORDS[lower];
        if (v === 'T' || v === 'F') out.push({ t: 'const', v: v === 'T' });
        else out.push({ t: 'op', v });
      } else if (word === 'T' || word === 'F') out.push({ t: 'const', v: word === 'T' });
      else if (word === 'v' || word === 'V') out.push({ t: 'op', v: '|' });
      else out.push({ t: 'var', v: word });
      i += word.length;
      continue;
    }
    if (c === '1' || c === '0') {
      out.push({ t: 'const', v: c === '1' });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${c}" in the formula.`);
  }
  return out;
}

export function parseFormula(src: string): Formula {
  const tokens = tokenize(src);
  if (!tokens.length) throw new Error('Enter a formula.');
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isOp = (v: string) => {
    const t = peek();
    return t && t.t === 'op' && t.v === v;
  };

  function parseIff(): Formula {
    let left = parseImplies();
    while (isOp('<->')) {
      take();
      left = { kind: 'iff', left, right: parseImplies() };
    }
    return left;
  }
  function parseImplies(): Formula {
    const left = parseOr();
    if (isOp('->')) {
      take();
      return { kind: 'implies', left, right: parseImplies() };
    }
    return left;
  }
  function parseOr(): Formula {
    let left = parseAnd();
    for (;;) {
      if (isOp('|')) {
        take();
        left = { kind: 'or', left, right: parseAnd() };
      } else if (isOp('^')) {
        take();
        left = { kind: 'xor', left, right: parseAnd() };
      } else return left;
    }
  }
  function parseAnd(): Formula {
    let left = parseNot();
    while (isOp('&')) {
      take();
      left = { kind: 'and', left, right: parseNot() };
    }
    return left;
  }
  function parseNot(): Formula {
    if (isOp('~')) {
      take();
      return { kind: 'not', arg: parseNot() };
    }
    return parseAtom();
  }
  function parseAtom(): Formula {
    const t = take();
    if (!t) throw new Error('The formula ends too early.');
    if (t.t === 'var') return { kind: 'var', name: t.v };
    if (t.t === 'const') return { kind: 'const', value: t.v };
    if (t.t === 'op' && t.v === '(') {
      const inner = parseIff();
      if (!isOp(')')) throw new Error('Missing a closing parenthesis.');
      take();
      return inner;
    }
    throw new Error(`Unexpected "${t.v}" in the formula.`);
  }

  const f = parseIff();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].v}" near the end of the formula.`);
  return f;
}

export function evalFormula(f: Formula, env: Record<string, boolean>): boolean {
  switch (f.kind) {
    case 'var':
      if (!(f.name in env)) throw new Error(`Unknown variable "${f.name}".`);
      return env[f.name];
    case 'const':
      return f.value;
    case 'not':
      return !evalFormula(f.arg, env);
    case 'and':
      return evalFormula(f.left, env) && evalFormula(f.right, env);
    case 'or':
      return evalFormula(f.left, env) || evalFormula(f.right, env);
    case 'xor':
      return evalFormula(f.left, env) !== evalFormula(f.right, env);
    case 'implies':
      return !evalFormula(f.left, env) || evalFormula(f.right, env);
    case 'iff':
      return evalFormula(f.left, env) === evalFormula(f.right, env);
  }
}

export function formulaVariables(f: Formula, into: Set<string> = new Set()): Set<string> {
  if (f.kind === 'var') into.add(f.name);
  else if (f.kind === 'not') formulaVariables(f.arg, into);
  else if (f.kind !== 'const') {
    formulaVariables(f.left, into);
    formulaVariables(f.right, into);
  }
  return into;
}

export interface TruthTable {
  variables: string[];
  /** Each row: the variable values (true first, in the conventional T...F order) and the result. */
  rows: Array<{ inputs: boolean[]; output: boolean }>;
}

/** Rows run from all-true to all-false, the order used in textbooks. */
export function truthTable(f: Formula, variables?: string[]): TruthTable {
  const vars = variables ?? [...formulaVariables(f)].sort();
  const rows: TruthTable['rows'] = [];
  const n = vars.length;
  for (let r = 0; r < 1 << n; r++) {
    const inputs = vars.map((_, i) => ((r >> (n - 1 - i)) & 1) === 0);
    const env: Record<string, boolean> = {};
    vars.forEach((v, i) => (env[v] = inputs[i]));
    rows.push({ inputs, output: evalFormula(f, env) });
  }
  return { variables: vars, rows };
}

export function isTautology(f: Formula): boolean {
  return truthTable(f).rows.every((r) => r.output);
}

/** Null when equivalent, otherwise a sentence naming an assignment where they differ. */
export function formulasEquivalent(learner: string, expected: string): string | null {
  let a: Formula;
  try {
    a = parseFormula(learner);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const b = parseFormula(expected);
  const vars = [...new Set([...formulaVariables(a), ...formulaVariables(b)])].sort();
  const extra = [...formulaVariables(a)].filter((v) => !formulaVariables(b).has(v));
  if (extra.length) return `the formula uses ${extra.map((v) => `"${v}"`).join(', ')}, which the expected formula does not`;
  const ta = truthTable(a, vars);
  const tb = truthTable(b, vars);
  for (let i = 0; i < ta.rows.length; i++) {
    if (ta.rows[i].output !== tb.rows[i].output) {
      const assign = vars.map((v, k) => `${v} = ${ta.rows[i].inputs[k] ? 'T' : 'F'}`).join(', ');
      return `when ${assign}, your formula is ${ta.rows[i].output ? 'true' : 'false'} but it should be ${tb.rows[i].output ? 'true' : 'false'}`;
    }
  }
  return null;
}

export function showFormula(f: Formula): string {
  switch (f.kind) {
    case 'var':
      return f.name;
    case 'const':
      return f.value ? 'T' : 'F';
    case 'not':
      return `¬${f.arg.kind === 'var' || f.arg.kind === 'const' || f.arg.kind === 'not' ? showFormula(f.arg) : `(${showFormula(f.arg)})`}`;
    default: {
      const sym = { and: '∧', or: '∨', xor: '⊕', implies: '→', iff: '↔' }[f.kind];
      const wrap = (g: Formula) => (g.kind === 'var' || g.kind === 'const' || g.kind === 'not' ? showFormula(g) : `(${showFormula(g)})`);
      return `${wrap(f.left)} ${sym} ${wrap(f.right)}`;
    }
  }
}
