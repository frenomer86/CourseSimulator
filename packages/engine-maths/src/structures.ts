/** Sets, matrices and number-theory helpers used by the maths lab tools and checks. */

/** "{1, 2, 3}", "1 2 3", "{a, b}" → normalised members (numbers canonicalised). */
export function parseSet(text: string): string[] {
  const inner = text.trim().replace(/^\{|\}$/g, '').replace(/^\[|\]$/g, '');
  if (inner.trim() === '' || /^(∅|empty|\{\s*\})$/i.test(text.trim())) return [];
  const members = inner
    .split(/[,;\s]+/)
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => (Number.isNaN(Number(m)) ? m : String(Number(m))));
  return [...new Set(members)];
}

export function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set(a.map((x) => x.toLowerCase()));
  const sb = new Set(b.map((x) => x.toLowerCase()));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

export const setOps = {
  union: (a: string[], b: string[]) => [...new Set([...a, ...b])],
  intersection: (a: string[], b: string[]) => a.filter((x) => b.includes(x)),
  difference: (a: string[], b: string[]) => a.filter((x) => !b.includes(x)),
  symmetricDifference: (a: string[], b: string[]) => [...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x))],
  complement: (a: string[], universe: string[]) => universe.filter((x) => !a.includes(x)),
  powerSetSize: (a: string[]) => Math.pow(2, a.length),
  cartesianSize: (a: string[], b: string[]) => a.length * b.length,
};

export type Matrix = number[][];

/** "[[1,2],[3,4]]", "1 2; 3 4" or "1,2;3,4" → rows. */
export function parseMatrix(text: string): Matrix {
  const s = text.trim();
  if (!s) throw new Error('Enter a matrix.');
  let rows: string[];
  if (s.startsWith('[[')) {
    rows = s
      .replace(/^\[\[|\]\]$/g, '')
      .split(/\]\s*,\s*\[/)
      .map((r) => r.trim());
  } else {
    rows = s
      .replace(/^\[|\]$/g, '')
      .split(/;|\n/)
      .map((r) => r.trim())
      .filter(Boolean);
  }
  const m = rows.map((r) =>
    r
      .split(/[,\s]+/)
      .filter(Boolean)
      .map((x) => {
        const parts = x.split('/');
        const v = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : Number(x);
        if (Number.isNaN(v)) throw new Error(`"${x}" is not a number.`);
        return v;
      }),
  );
  if (m.some((r) => r.length !== m[0].length)) throw new Error('Every row needs the same number of entries.');
  return m;
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  if (a[0].length !== b.length) throw new Error(`Cannot multiply a ${a.length}×${a[0].length} matrix by a ${b.length}×${b[0].length} matrix.`);
  return a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
}

export function transpose(a: Matrix): Matrix {
  return a[0].map((_, j) => a.map((row) => row[j]));
}

export function determinant(a: Matrix): number {
  const n = a.length;
  if (n !== a[0].length) throw new Error('Only square matrices have a determinant.');
  if (n === 1) return a[0][0];
  if (n === 2) return a[0][0] * a[1][1] - a[0][1] * a[1][0];
  let det = 0;
  for (let j = 0; j < n; j++) {
    const minor = a.slice(1).map((row) => row.filter((_, k) => k !== j));
    det += (j % 2 === 0 ? 1 : -1) * a[0][j] * determinant(minor);
  }
  return det;
}

export function inverse(a: Matrix): Matrix {
  const n = a.length;
  if (n !== a[0].length) throw new Error('Only square matrices can be inverted.');
  const m = a.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) throw new Error('The matrix is singular: its determinant is 0, so it has no inverse.');
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const p = m[col][col];
    for (let j = 0; j < 2 * n; j++) m[col][j] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let j = 0; j < 2 * n; j++) m[r][j] -= f * m[col][j];
    }
  }
  return m.map((row) => row.slice(n));
}

export function sameMatrix(a: Matrix, b: Matrix, tolerance = 1e-6): boolean {
  return a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((v, j) => Math.abs(v - b[i][j]) <= tolerance));
}

export function showMatrix(m: Matrix): string {
  return `[${m.map((r) => `[${r.map((v) => (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000)).join(', ')}]`).join(', ')}]`;
}

/* ----------------------------------------------------------------------------- number theory */

export interface EuclidStep {
  a: number;
  b: number;
  q: number;
  r: number;
}

export function euclid(a: number, b: number): { gcd: number; steps: EuclidStep[]; x: number; y: number } {
  const steps: EuclidStep[] = [];
  let [x0, x1, y0, y1] = [1, 0, 0, 1];
  let [p, q] = [Math.abs(a), Math.abs(b)];
  while (q !== 0) {
    const quot = Math.floor(p / q);
    const rem = p % q;
    steps.push({ a: p, b: q, q: quot, r: rem });
    [p, q] = [q, rem];
    [x0, x1] = [x1, x0 - quot * x1];
    [y0, y1] = [y1, y0 - quot * y1];
  }
  return { gcd: p, steps, x: x0 * Math.sign(a || 1), y: y0 * Math.sign(b || 1) };
}

export function modInverse(a: number, n: number): number | null {
  const { gcd, x } = euclid(((a % n) + n) % n, n);
  return gcd === 1 ? ((x % n) + n) % n : null;
}

export function modPow(base: number, exp: number, mod: number): number {
  let result = 1;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1;
  }
  return result;
}

/** Bisection on f over [lo, hi] until the interval is narrower than width; returns the midpoint and the steps taken. */
export function bisection(f: (x: number) => number, lo: number, hi: number, width = 1e-3, maxSteps = 200): { root: number; steps: Array<{ lo: number; hi: number; mid: number; fmid: number }> } {
  const steps: Array<{ lo: number; hi: number; mid: number; fmid: number }> = [];
  let a = lo;
  let b = hi;
  if (f(a) * f(b) > 0) throw new Error('f(lo) and f(hi) must have opposite signs.');
  while (b - a > width && steps.length < maxSteps) {
    const mid = (a + b) / 2;
    const fm = f(mid);
    steps.push({ lo: a, hi: b, mid, fmid: fm });
    if (fm === 0) return { root: mid, steps };
    if (f(a) * fm < 0) b = mid;
    else a = mid;
  }
  return { root: (a + b) / 2, steps };
}

export function toBase(n: number, base: number): string {
  return n.toString(base).toUpperCase();
}

/* ----------------------------------------------------------------------------- statistics */

export function describeData(values: number[]): { n: number; mean: number; median: number; variance: number; sd: number; min: number; max: number } {
  const n = values.length;
  if (!n) return { n: 0, mean: NaN, median: NaN, variance: NaN, sd: NaN, min: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { n, mean, median, variance, sd: Math.sqrt(variance), min: sorted[0], max: sorted[n - 1] };
}

export function binomial(n: number, k: number, p: number): number {
  if (k < 0 || k > n) return 0;
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c * Math.pow(p, k) * Math.pow(1 - p, n - k);
}
