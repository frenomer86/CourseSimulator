/**
 * Every E1 lab must be solvable: a reference program per lab id passes every check and the
 * starter does not. JavaScript runs in-process; Python runs through a local interpreter
 * (`py`, `python3` or `python`) and is skipped when none is installed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createCodeChecks, executeJavaScript, type CodeLanguage, type CodeRunner, type CodeState, type RunResult, type Runners } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

/** Labs written before this test existed; verified in the browser, not here. */
const LEGACY = new Set(['principles-of-programming', 'introduction-to-python']);

function findPython(): string | null {
  for (const cmd of ['py', 'python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'print(1)'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout.trim() === '1') return cmd;
  }
  return null;
}
const PY = findPython();

class PythonProcess implements CodeRunner {
  readonly language: CodeLanguage = 'python';
  run(source: string, stdin = '', timeoutMs = 15000): Promise<RunResult> {
    const start = Date.now();
    const r = spawnSync(PY!, ['-I', '-c', source], { input: stdin, encoding: 'utf8', timeout: timeoutMs });
    const timedOut = r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const errLine = (r.stderr ?? '').trim().split('\n').pop() ?? '';
    return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.status === 0 ? null : timedOut ? 'timed out' : errLine || 'exited with an error', timeMs: Date.now() - start, timedOut: !!timedOut });
  }
}
class JsInProcess implements CodeRunner {
  readonly language: CodeLanguage = 'javascript';
  run(source: string, stdin = ''): Promise<RunResult> {
    return Promise.resolve(executeJavaScript(source, stdin));
  }
}
const runners: Runners = { get: (language) => (language === 'python' ? (PY ? new PythonProcess() : undefined) : new JsInProcess()) };

const SOLUTIONS: Record<string, string> = {
  "distributed-systems-i1-vector-clocks": "function tick(v, me) { const r = v.slice(); r[me] += 1; return r; }\nfunction merge(a, b) { return a.map((x, i) => Math.max(x, b[i])); }\nfunction receive(local, msg, me) { return tick(merge(local, msg), me); }\nfunction compare(a, b) {\n  let le = true, ge = true;\n  for (let i = 0; i < a.length; i++) { if (a[i] > b[i]) le = false; if (a[i] < b[i]) ge = false; }\n  if (le && ge) return 'equal';\n  if (le) return 'before';\n  if (ge) return 'after';\n  return 'concurrent';\n}",
  "software-defined-networking-i1-a-flow-table": "function ipToInt(ip) { return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0); }\nfunction ipInPrefix(ip, prefix) {\n  const [net, len] = prefix.split('/');\n  const bits = Number(len);\n  if (bits === 0) return true;\n  const size = 2 ** (32 - bits);\n  return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(net) / size);\n}\nfunction matches(m, p) {\n  for (const k of Object.keys(m)) {\n    if (k === 'ipv4_dst') { if (!p.ipv4_dst || !ipInPrefix(p.ipv4_dst, m.ipv4_dst)) return false; }\n    else if (p[k] !== m[k]) return false;\n  }\n  return true;\n}\nfunction matchFlow(table, pkt) {\n  let best = null;\n  for (const e of table) if (matches(e.match, pkt) && (!best || e.priority > best.priority)) best = e;\n  return best ? best.actions : ['CONTROLLER'];\n}",
  "blockchain-and-distributed-ledgers-i1-merkle-root-and-proof-of-work": "import hashlib\n\ndef sha256_hex(text):\n    return hashlib.sha256(text.encode()).hexdigest()\n\ndef merkle_root(txs):\n    if not txs:\n        return sha256_hex(\"\")\n    level = [sha256_hex(t) for t in txs]\n    while len(level) > 1:\n        if len(level) % 2 == 1:\n            level.append(level[-1])\n        level = [sha256_hex(level[i] + level[i + 1]) for i in range(0, len(level), 2)]\n    return level[0]\n\ndef mine(data, difficulty):\n    nonce = 0\n    while not sha256_hex(f\"{data}{nonce}\").startswith(\"0\" * difficulty):\n        nonce += 1\n    return nonce",
  'programming-with-c-i1-caesar-and-word-count': `function caesar(text, shift) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 97 && c <= 122) out += String.fromCharCode(((c - 97 + shift) % 26 + 26) % 26 + 97);
    else if (c >= 65 && c <= 90) out += String.fromCharCode(((c - 65 + shift) % 26 + 26) % 26 + 65);
    else out += text[i];
  }
  return out;
}
function wordCount(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ' ') inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}`,
  'data-wrangling-and-preparation-b1-clean-the-market-prices': `import sys
lines = sys.stdin.read().splitlines()
valid = []
missing = 0
for line in lines[1:]:
    market, item, price = [part.strip() for part in line.split(",")]
    market = market.title()
    item = item.lower()
    try:
        value = float(price)
        valid.append(value)
        print(f"{market},{item},{value:.2f}")
    except ValueError:
        missing += 1
        print(f"{market},{item},missing")
avg = sum(valid) / len(valid) if valid else 0
print(f"valid: {len(valid)}, missing: {missing}, average: {avg:.2f}")`,
  'programming-with-cpp-b1-array-functions': `function mean(values) { if (values.length === 0) return 0; let s = 0; for (let i = 0; i < values.length; i++) s += values[i]; return s / values.length; }
function maxIndex(values) { if (values.length === 0) return -1; let best = 0; for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i; return best; }
function reverseInPlace(values) { const n = values.length; for (let i = 0; i < Math.floor(n / 2); i++) { const t = values[i]; values[i] = values[n - 1 - i]; values[n - 1 - i] = t; } return values; }`,
  'web-application-programming-i-b1-validate-a-form': `function isValidEmail(text) {
  const at = text.indexOf('@');
  if (at <= 0 || at !== text.lastIndexOf('@')) return false;
  const dot = text.indexOf('.', at + 2);
  return dot > at + 1 && dot < text.length - 1;
}
function passwordStrength(pw) {
  if (pw.length < 8) return 'weak';
  const letters = /[a-zA-Z]/.test(pw), digits = /[0-9]/.test(pw);
  return letters && digits ? 'strong' : 'medium';
}
function formatPhone(text) {
  let s = text.replace(/\\s+/g, '');
  if (/^0\\d{9}$/.test(s)) s = '+233' + s.slice(1);
  if (!/^\\+233\\d{9}$/.test(s)) return null;
  const d = s.slice(4);
  return '+233 ' + d.slice(0, 2) + ' ' + d.slice(2, 5) + ' ' + d.slice(5);
}`,
  'data-visualisation-b1-chart-in-text': `import sys
rows = []
for line in sys.stdin.read().splitlines():
    name, value = line.split(",")
    rows.append((name, float(value)))
largest = max(v for _, v in rows)
for name, value in rows:
    n = round(value / largest * 40)
    print(f"{name:<10} {'#' * n} {value:g}")
top = max(rows, key=lambda r: r[1])
print(f"max: {top[0]} {top[1]:g}")`,
  'software-development-with-java-b1-bank-account-class': `class BankAccount {
  #balance;
  #owner;
  constructor(owner, opening) {
    if (opening < 0) throw new Error('Opening balance cannot be negative');
    this.#owner = owner;
    this.#balance = opening;
  }
  deposit(amount) { if (amount <= 0) throw new Error('Deposit must be positive'); this.#balance += amount; }
  withdraw(amount) { if (amount <= 0) throw new Error('Withdrawal must be positive'); if (amount > this.#balance) throw new Error('Insufficient funds'); this.#balance -= amount; }
  getBalance() { return this.#balance; }
  getOwner() { return this.#owner; }
}`,
  'web-application-programming-ii-i1-registration-validation-and-escaping': `function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function validateRegistration(form) {
  const errors = [];
  if (!/^[A-Za-z0-9_]{3,20}$/.test(form.username || '')) errors.push('username must be 3-20 letters, digits or underscores');
  const e = form.email || '';
  const at = e.indexOf('@');
  if (at <= 0 || e.indexOf('.', at + 2) === -1) errors.push('email is invalid');
  if ((form.password || '').length < 8) errors.push('password must be at least 8 characters');
  if (form.password !== form.confirm) errors.push('passwords do not match');
  return errors;
}
function safeSql(username) { return { sql: 'SELECT * FROM users WHERE username = ?', params: [username] }; }`,
  'computer-graphics-i1-bresenham-line': `function bresenham(x0, y0, x1, y1) {
  const points = [];
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    points.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return points;
}
function rasterise(points, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(new Array(width).fill('.'));
  for (const [x, y] of points) if (y >= 0 && y < height && x >= 0 && x < width) rows[y][x] = '#';
  return rows.map((r) => r.join(''));
}`,
  'game-engine-programming-i1-collision-detection': `function aabbOverlap(a, b) { return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y); }
function circleOverlap(c1, c2) { const dx = c1.x - c2.x, dy = c1.y - c2.y, r = c1.r + c2.r; return dx * dx + dy * dy < r * r; }
function circleInBox(c, b) { const cx = Math.max(b.x, Math.min(c.x, b.x + b.w)); const cy = Math.max(b.y, Math.min(c.y, b.y + b.h)); const dx = c.x - cx, dy = c.y - cy; return dx * dx + dy * dy < c.r * c.r; }`,
  'genomics-and-next-generation-sequencing-b1-fastq-quality-control': `import sys
lines = sys.stdin.read().splitlines()
reads = []
for i in range(0, len(lines), 4):
    reads.append((lines[i][1:], lines[i + 1], lines[i + 3]))
kept = []
for name, bases, quals in reads:
    mean = sum(ord(c) - 33 for c in quals) / len(quals)
    keep = mean >= 20
    print(f"{name} {mean:.1f} {'keep' if keep else 'drop'}")
    if keep:
        kept.append(bases)
print(f"kept {len(kept)} of {len(reads)}")
total = sum(len(b) for b in kept)
gc = sum(b.count("G") + b.count("C") for b in kept)
print(f"GC {100 * gc / total:.1f}%")`,
  'web-application-security-i1-stop-the-xss': `function encodeHtml(text) { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function encodeAttribute(text) {
  let out = '';
  for (const ch of text) {
    if (/[A-Za-z0-9 \\-_.]/.test(ch)) out += ch;
    else if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else out += '&#' + ch.charCodeAt(0) + ';';
  }
  return out;
}
function isSafeRedirect(url, allowedHosts) {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  try { const u = new URL(url); return u.protocol === 'https:' && allowedHosts.includes(u.host); } catch { return false; }
}
function constantTimeEqual(a, b) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }`,
  'robot-programming-with-ros-b1-topics-and-messages': `class Bus:
    def __init__(self):
        self._subs = {}
    def subscribe(self, topic, callback):
        self._subs.setdefault(topic, []).append(callback)
    def publish(self, topic, message):
        subs = self._subs.get(topic, [])
        for cb in subs:
            cb(message)
        return len(subs)
    def topics(self):
        return sorted(t for t, s in self._subs.items() if s)

def odometry_to_speed(bus):
    prev = {}
    def on_odom(m):
        if prev:
            dt = m["t"] - prev["t"]
            bus.publish("/speed", round((m["x"] - prev["x"]) / dt, 3))
        prev.clear()
        prev.update(m)
    bus.subscribe("/odom", on_odom)`,
  'software-testing-and-quality-assurance-b1-boundary-tests-first': `def boundary_cases():
    return [-1, 0, 1, 49, 50, 51, 59, 60, 61, 69, 70, 71, 79, 80, 81, 99, 100, 101]

def grade(score):
    if isinstance(score, bool) or not isinstance(score, int) or score < 0 or score > 100:
        raise ValueError("score must be a whole number from 0 to 100")
    if score >= 80:
        return "A"
    if score >= 70:
        return "B"
    if score >= 60:
        return "C"
    if score >= 50:
        return "D"
    return "F"`,
  'advanced-software-development-with-java-b1-shapes-abstract-and-interface': `class Shape {
  constructor() { if (new.target === Shape) throw new Error('Shape is abstract'); }
  area() { throw new Error('area() not implemented'); }
  name() { throw new Error('name() not implemented'); }
  describe() { return this.name() + ': ' + this.area().toFixed(2); }
  compareTo(other) { return this.area() - other.area(); }
}
class Circle extends Shape { constructor(r) { super(); this.r = r; } area() { return Math.PI * this.r * this.r; } name() { return 'circle'; } }
class Rectangle extends Shape { constructor(w, h) { super(); this.w = w; this.h = h; } area() { return this.w * this.h; } name() { return 'rectangle'; } }
function largest(shapes) { let best = shapes[0]; for (const s of shapes) if (s.compareTo(best) > 0) best = s; return best; }
function totalArea(shapes) { let t = 0; for (const s of shapes) t += s.area(); return t; }`,
  'computer-vision-i1-blur-and-edges': `def box_blur(img):
    h, w = len(img), len(img[0])
    out = [row[:] for row in img]
    for r in range(1, h - 1):
        for c in range(1, w - 1):
            s = sum(img[r + dr][c + dc] for dr in (-1, 0, 1) for dc in (-1, 0, 1))
            out[r][c] = round(s / 9)
    return out

def sobel(img):
    h, w = len(img), len(img[0])
    out = [[0] * w for _ in range(h)]
    for r in range(1, h - 1):
        for c in range(1, w - 1):
            gx = (img[r-1][c+1] + 2*img[r][c+1] + img[r+1][c+1]) - (img[r-1][c-1] + 2*img[r][c-1] + img[r+1][c-1])
            gy = (img[r+1][c-1] + 2*img[r+1][c] + img[r+1][c+1]) - (img[r-1][c-1] + 2*img[r-1][c] + img[r-1][c+1])
            out[r][c] = abs(gx) + abs(gy)
    return out`,
  'data-science-i1-least-squares-by-hand': `def fit_line(xs, ys):
    n = len(xs)
    xb = sum(xs) / n
    yb = sum(ys) / n
    num = sum((x - xb) * (y - yb) for x, y in zip(xs, ys))
    den = sum((x - xb) ** 2 for x in xs)
    slope = num / den
    return (slope, yb - slope * xb)

def predict(model, x):
    return model[0] * x + model[1]

def r_squared(xs, ys):
    m = fit_line(xs, ys)
    yb = sum(ys) / len(ys)
    ss_res = sum((y - predict(m, x)) ** 2 for x, y in zip(xs, ys))
    ss_tot = sum((y - yb) ** 2 for y in ys)
    return 1 - ss_res / ss_tot`,
  'deep-learning-b1-neuron-and-layer': `import math
def relu(x):
    return max(0, x)
def sigmoid(x):
    return 1 / (1 + math.exp(-x))
def dense(x, W, b):
    return [sum(w * xi for w, xi in zip(row, x)) + bi for row, bi in zip(W, b)]
def softmax(z):
    m = max(z)
    e = [math.exp(v - m) for v in z]
    s = sum(e)
    return [v / s for v in e]
def forward(x, W1, b1, W2, b2):
    h = [relu(v) for v in dense(x, W1, b1)]
    return softmax(dense(h, W2, b2))`,
  'machine-learning-b1-confusion-matrix-and-metrics': `def confusion(y_true, y_pred):
    c = {"tp": 0, "fp": 0, "fn": 0, "tn": 0}
    for t, p in zip(y_true, y_pred):
        if t == 1 and p == 1: c["tp"] += 1
        elif t == 0 and p == 1: c["fp"] += 1
        elif t == 1 and p == 0: c["fn"] += 1
        else: c["tn"] += 1
    return c
def precision(c):
    d = c["tp"] + c["fp"]
    return c["tp"] / d if d else 0.0
def recall(c):
    d = c["tp"] + c["fn"]
    return c["tp"] / d if d else 0.0
def f1(c):
    p, r = precision(c), recall(c)
    return 2 * p * r / (p + r) if p + r else 0.0
def accuracy(c):
    total = sum(c.values())
    return (c["tp"] + c["tn"]) / total if total else 0.0`,
  'natural-language-processing-b1-tokens-and-ngrams': `import re
from collections import Counter
def tokenize(text):
    return re.findall(r"[a-z0-9']+", text.lower())
def bigrams(tokens):
    return list(zip(tokens, tokens[1:]))
def top_words(text, n):
    counts = Counter(tokenize(text))
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]`,
  'secure-software-development-i1-validate-and-sanitise-input': `import re
def parse_amount(text):
    if not re.fullmatch(r"\\d{1,5}(\\.\\d{1,2})?", text):
        raise ValueError("invalid amount")
    whole, _, frac = text.partition(".")
    pesewas = int(whole) * 100 + int((frac + "00")[:2])
    if pesewas > 1000000:
        raise ValueError("amount too large")
    return pesewas
def safe_filename(name):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name)
    if not cleaned or cleaned.startswith(".") or ".." in cleaned:
        raise ValueError("unsafe file name")
    return cleaned
def mask_phone(phone):
    if not re.fullmatch(r"0\\d{9}", phone):
        raise ValueError("invalid phone")
    return phone[:3] + "****" + phone[-3:]`,
  'structural-bioinformatics-i1-rmsd-and-radius-of-gyration': `import math
def centroid(coords):
    n = len(coords)
    return [sum(c[i] for c in coords) / n for i in range(3)]
def radius_of_gyration(coords):
    c = centroid(coords)
    return math.sqrt(sum((a[0]-c[0])**2 + (a[1]-c[1])**2 + (a[2]-c[2])**2 for a in coords) / len(coords))
def rmsd(a, b):
    return math.sqrt(sum((p[0]-q[0])**2 + (p[1]-q[1])**2 + (p[2]-q[2])**2 for p, q in zip(a, b)) / len(a))
def centre(coords):
    c = centroid(coords)
    return [[a[0]-c[0], a[1]-c[1], a[2]-c[2]] for a in coords]`,
  'big-data-and-parallel-computing-b1-map-and-reduce': `def map_line(line):
    return [(w.strip(".,!?;:").lower(), 1) for w in line.split() if w.strip(".,!?;:")]
def shuffle(pairs):
    groups = {}
    for k, v in pairs:
        groups.setdefault(k, []).append(v)
    return groups
def reduce_counts(word, counts):
    return (word, sum(counts))
def word_count(lines):
    pairs = [p for line in lines for p in map_line(line)]
    return {w: reduce_counts(w, c)[1] for w, c in shuffle(pairs).items()}`,
  'compiler-construction-b1-a-tokenizer': `def tokenize(src):
    tokens = []
    i = 0
    while i < len(src):
        c = src[i]
        if c in " \\t":
            i += 1
            continue
        if c.isdigit():
            j = i
            while j < len(src) and (src[j].isdigit() or src[j] == "."):
                j += 1
            tokens.append(("NUMBER", src[i:j]))
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < len(src) and (src[j].isalnum() or src[j] == "_"):
                j += 1
            tokens.append(("IDENT", src[i:j]))
            i = j
            continue
        if c in "+-*/=()":
            tokens.append(("OP", c))
            i += 1
            continue
        raise SyntaxError(f"unexpected character {c!r} at {i}")
    return tokens`,
  'mlops-and-model-deployment-i1-detect-drift': `import math
def psi(expected, actual):
    te, ta = sum(expected), sum(actual)
    e = [max(c / te, 0.0001) for c in expected]
    a = [max(c / ta, 0.0001) for c in actual]
    return sum((ai - ei) * math.log(ai / ei) for ei, ai in zip(e, a))
def drift_level(value):
    if value < 0.1:
        return "stable"
    if value < 0.2:
        return "moderate"
    return "significant"
def rolling_accuracy(y_true, y_pred, window):
    out = []
    for start in range(0, len(y_true) - window + 1, window):
        t = y_true[start:start + window]
        p = y_pred[start:start + window]
        out.append(sum(1 for a, b in zip(t, p) if a == b) / window)
    return out`,
};

function allLabs(): LabSpec<CodeState>[] {
  const out: LabSpec<CodeState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<CodeState>;
      if (raw.engine === 'E1') out.push(raw);
    }
  }
  return out;
}

describe('E1 lab content', () => {
  const checks = createCodeChecks(runners);
  const labs = allLabs();
  it('finds the code labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(30);
  });
  for (const lab of labs) {
    if (LEGACY.has(lab.course)) continue;
    const language = (lab.config?.language as CodeLanguage) ?? 'python';
    const canRun = language === 'javascript' || PY !== null;
    describe(lab.id, () => {
      it('has a reference solution', () => {
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
      });
      it.skipIf(!canRun)('does not pass as given', async () => {
        const r = await checks.run(lab, { language, source: lab.initialState?.source ?? '' });
        expect(r.passed).toBe(false);
      });
      it.skipIf(!canRun)('passes with the reference solution', async () => {
        const r = await checks.run(lab, { language, source: SOLUTIONS[lab.id] });
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      }, 60000);
    });
  }
});
