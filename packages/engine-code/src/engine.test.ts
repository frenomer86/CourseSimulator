import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { compareOutput, createCodeChecks, deepEqual, executeJavaScript, functionHarness, scriptHarness, splitHarnessOutput, type CodeRunner, type CodeState } from './index.js';

const jsRunner: CodeRunner = { language: 'javascript', run: async (source, stdin) => executeJavaScript(source, stdin) };
const checks = createCodeChecks({ get: (l) => (l === 'javascript' ? jsRunner : undefined) });
const js = (source: string): CodeState => ({ language: 'javascript', source });
const lab = (specs: LabSpec['checks']): LabSpec<CodeState> => ({
  id: 'x',
  course: 'c',
  topic: 't',
  level: 'beginner',
  engine: 'E1',
  title: 'x',
  instructions: '',
  hints: [],
  checks: specs,
  estimatedMinutes: 1,
});

describe('executeJavaScript', () => {
  it('captures console output and reads stdin line by line', () => {
    const r = executeJavaScript('const name = input(); const n = Number(input()); console.log("Hi " + name, n * 2); console.log(input());', 'Ama\n21\n');
    expect(r.stdout).toBe('Hi Ama 42\nnull');
    expect(r.error).toBeNull();
  });
  it('reports uncaught errors without losing earlier output', () => {
    const r = executeJavaScript('console.log(1); undefinedFn();');
    expect(r.stdout).toBe('1');
    expect(r.error).toMatch(/ReferenceError/);
  });
  it('prints objects readably', () => {
    expect(executeJavaScript('console.log({a:1}, [1,2], null, undefined, true)').stdout).toBe('{"a":1} [1,2] null undefined true');
  });
});

describe('compareOutput', () => {
  it('ignores blank lines and trailing spaces in lines mode', () => {
    expect(compareOutput('Hello  \n\nWorld\n', 'Hello\nWorld')).toBeNull();
    expect(compareOutput('Hello\nWorld', ['Hello', 'World'])).toBeNull();
    expect(compareOutput('Hello', 'Hello\nWorld')).toMatch(/stopped early/);
    expect(compareOutput('Hello\nWorld\nExtra', 'Hello\nWorld')).toMatch(/extra output/);
    expect(compareOutput('Hello\nWorlds', 'Hello\nWorld')).toMatch(/line 2 should be/);
  });
  it('compares numbers with a tolerance', () => {
    expect(compareOutput('Average: 3.333', [3.33], 'numbers', 0.01)).toBeNull();
    expect(compareOutput('Average: 3.4', [3.33], 'numbers', 0.01)).toMatch(/first number/);
    expect(compareOutput('none', [1], 'numbers')).toMatch(/found 0/);
  });
  it('supports exact and contains', () => {
    expect(compareOutput('a\nb', 'a\nb', 'exact')).toBeNull();
    expect(compareOutput('a \nb', 'a\nb', 'exact')).not.toBeNull();
    expect(compareOutput('Total: GHS 12.50', 'GHS 12.50', 'contains')).toBeNull();
  });
});

describe('harnesses', () => {
  it('splits harness output from the program output', () => {
    const r = executeJavaScript('function sq(x) { return x * x }\nconsole.log("hi")' + functionHarness('javascript', 'sq', [{ args: [3], expected: 9 }]));
    const { userOutput, payload } = splitHarnessOutput(r.stdout);
    expect(userOutput).toBe('hi');
    expect(JSON.parse(payload!)).toEqual([{ value: 9 }]);
  });
  it('builds a python harness with the cases embedded', () => {
    const h = functionHarness('python', 'area', [{ args: [2, 3], expected: 6 }]);
    expect(h).toContain('area(*__c)');
    expect(h).toContain('[[2,3]]');
    expect(scriptHarness('python', 'assert 1 == 1')).toContain('assert 1 == 1');
  });
  it('deepEqual tolerates floating point', () => {
    expect(deepEqual([1, 2.0001], [1, 2], 0.001)).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('code.* checks with the JavaScript runner', () => {
  it('code.stdout and code.runs', async () => {
    const r = await checks.run(lab([{ type: 'code.stdout', label: 'greets', stdin: 'Kofi', expected: 'Hello, Kofi!' }, { type: 'code.runs', label: 'runs' }]), js('console.log("Hello, " + input() + "!")'));
    expect(r.passed).toBe(true);
    const bad = await checks.run(lab([{ type: 'code.stdout', label: 'greets', stdin: 'Kofi', expected: 'Hello, Kofi!' }]), js('console.log("Hello " + input())'));
    expect(bad.passed).toBe(false);
    expect(bad.checks[0].message).toMatch(/line 1 should be "Hello, Kofi!"/);
  });

  it('code.cases runs several inputs and names the failing one', async () => {
    const spec = lab([{ type: 'code.cases', label: 'doubles', cases: [{ stdin: '2', expected: '4' }, { stdin: '5', expected: '10', name: 'five' }] }]);
    expect((await checks.run(spec, js('console.log(Number(input()) * 2)'))).passed).toBe(true);
    const bad = await checks.run(spec, js('console.log(Number(input()) + 2)'));
    expect(bad.checks[0].message).toMatch(/For five: line 1 should be "10" but was "7"/);
  });

  it('code.function calls the learner function and reports a wrong case', async () => {
    const spec = lab([{ type: 'code.function', label: 'grade', name: 'grade', cases: [{ args: [85], expected: 'A' }, { args: [50], expected: 'D' }] }]);
    expect((await checks.run(spec, js('function grade(s) { return s >= 80 ? "A" : s >= 60 ? "B" : "D" }'))).passed).toBe(true);
    const bad = await checks.run(spec, js('function grade(s) { return "A" }'));
    expect(bad.checks[0].message).toBe('grade(50) should return "D" but returned "A".');
    const missing = await checks.run(spec, js('const x = 1'));
    expect(missing.checks[0].message).toBe('Define a function called grade first.');
    const throws = await checks.run(spec, js('function grade(s) { throw new Error("boom") }'));
    expect(throws.checks[0].message).toMatch(/raised an error: Error: boom/);
  });

  it('code.function can expect an error', async () => {
    const spec = lab([{ type: 'code.function', label: 'parse', name: 'parseAge', cases: [{ args: ['19'], expected: 19 }, { args: ['abc'], expected: { $error: 'RangeError' } }] }]);
    expect((await checks.run(spec, js('function parseAge(t) { const n = Number(t); if (Number.isNaN(n)) throw new RangeError("not a number"); return n }'))).passed).toBe(true);
    const bad = await checks.run(spec, js('function parseAge(t) { return Number(t) }'));
    expect(bad.checks[0].message).toBe('parseAge("abc") should raise RangeError but returned null.');
  });

  it('code.script runs an assertion script', async () => {
    const spec = lab([{ type: 'code.script', label: 'account', script: 'const a = new Account(10); a.deposit(5); if (a.balance !== 15) throw new Error("AssertionError: balance should be 15 after depositing 5");' }]);
    expect((await checks.run(spec, js('class Account { constructor(b) { this.balance = b } deposit(x) { this.balance += x } }'))).passed).toBe(true);
    const bad = await checks.run(spec, js('class Account { constructor(b) { this.balance = b } deposit(x) { } }'));
    expect(bad.checks[0].message).toBe('Not yet: balance should be 15 after depositing 5');
  });

  it('code.source checks the text of the program', async () => {
    const must = lab([{ type: 'code.source', label: 'uses a loop', pattern: '\\b(for|while)\\b', message: 'Use a loop.' }]);
    expect((await checks.run(must, js('for (;;) break;'))).passed).toBe(true);
    expect((await checks.run(must, js('console.log(1)'))).checks[0].message).toBe('Use a loop.');
    const forbid = lab([{ type: 'code.source', label: 'no sort', pattern: '\\.sort\\(', mustMatch: false, message: 'Do not call sort.' }]);
    expect((await checks.run(forbid, js('[3,1].sort()'))).checks[0].message).toBe('Do not call sort.');
  });

  it('fails cleanly when no runner exists for the language', async () => {
    const r = await checks.run(lab([{ type: 'code.runs', label: 'runs' }]), { language: 'python', source: 'print(1)' });
    expect(r.checks[0].message).toMatch(/No runner is available for python/);
  });
});
