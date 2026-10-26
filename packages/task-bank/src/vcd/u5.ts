/** Unit 5: automated testing: test levels, linting and hooks, coverage and flaky tests, test-driven development. */

import type { Check, TaskTemplate } from '../types';
import { C, ORGS, SH, caseStudy, dev, file, lab, out, repo, tmpl, write } from './kit';

/** A code lab (E1) in Python or JavaScript. */
function code(language: 'python' | 'javascript', o: { instructions: string; hints: string[]; starter: string; checks: Check[]; solution: string; realityNote: string }) {
  return { instructions: o.instructions, hints: o.hints, config: { language }, initialState: { language, source: o.starter }, checks: [{ type: 'code.runs', label: 'The program runs' }, ...o.checks], solution: [o.solution], realityNote: o.realityNote };
}

/** Python check script: the learner's TestCase must pass on the real function and fail on each buggy version. */
function pyMutationCheck(fn: string, testClass: string, minTests: number, correct: string, mutants: Array<[string, string]>): string {
  return [
    'import unittest as _ut, io as _io',
    `_correct = ${fn}`,
    correct,
    ...mutants.map(([, src], k) => src.replace(new RegExp(`def ${fn}\\(`), `def _m${k}(`)),
    'def _run(impl):',
    `    globals()['${fn}'] = impl`,
    `    _s = _ut.defaultTestLoader.loadTestsFromTestCase(${testClass})`,
    '    _r = _ut.TextTestRunner(stream=_io.StringIO(), verbosity=0).run(_s)',
    `    globals()['${fn}'] = _correct`,
    '    return _r.wasSuccessful(), _r.testsRun',
    '_ok, _n = _run(_reference)',
    `assert _n >= ${minTests}, f"write at least ${minTests} tests (found {_n})"`,
    `assert _ok, "your tests fail on a correct ${fn}: a test expects the wrong value"`,
    ...mutants.map(([name], k) => `assert not _run(_m${k})[0], ${JSON.stringify(`your tests do not catch this bug: ${name}`)}`),
  ].join('\n');
}

/** JavaScript check script: the learner's tests (in the tests array) must pass on the real function and fail on each buggy version. */
function jsMutationCheck(fn: string, minTests: number, correct: string, mutants: Array<[string, string]>): string {
  return [
    `const _correct = ${fn};`,
    correct.replace(new RegExp(`function ${fn}\\(`), 'function _reference('),
    ...mutants.map(([, src], k) => src.replace(new RegExp(`function ${fn}\\(`), `function _m${k}(`)),
    'function _run(impl) {',
    `  ${fn} = impl;`,
    '  let ok = true;',
    '  for (const t of tests) { try { t.fn(); } catch (e) { ok = false; } }',
    `  ${fn} = _correct;`,
    '  return ok;',
    '}',
    `if (tests.length < ${minTests}) throw new Error('AssertionError: write at least ${minTests} tests (found ' + tests.length + ')');`,
    `if (!_run(_reference)) throw new Error('AssertionError: your tests fail on a correct ${fn}: a test expects the wrong value');`,
    ...mutants.map(([name], k) => `if (_run(_m${k})) throw new Error(${JSON.stringify(`AssertionError: your tests do not catch this bug: ${name}`)});`),
  ].join('\n');
}

const JS_HARNESS = `// A tiny test runner: test(name, fn) registers a test; assertEqual throws when values differ.
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error((message || 'assertEqual') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function assertThrows(fn, message) {
  try { fn(); } catch (e) { return; }
  throw new Error((message || 'assertThrows') + ': expected an error');
}
`;
const JS_RUN = `
// Run every test and print a summary.
let failed = 0;
for (const t of tests) { try { t.fn(); console.log('ok   ' + t.name); } catch (e) { failed++; console.log('FAIL ' + t.name + ': ' + e.message); } }
console.log(tests.length + ' tests, ' + failed + ' failed');
`;

export const U5: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 5.1 unit, integration and end-to-end tests; the pyramid; runners */
  tmpl(5, 1, 'beginner', 'test-pyramid', 'Place tests on the testing pyramid', 'E10', 15, 'Classify tests as unit, integration or end-to-end, and choose a healthy balance.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## Testing the ${o.what}\n\n${o.org} has no automated tests. The team lists what they could test and asks you where each belongs and how many of each they should write.`,
      steps: [
        { title: 'A pure function', text: '`fee(amount)` returns the transfer fee for an amount.', choices: [{ text: 'Unit test: call the function with chosen amounts and compare results; it runs in milliseconds', right: true, feedback: 'Correct. Unit tests check one piece in isolation, fast and precise.' }, { text: 'End-to-end test through the browser', feedback: 'Slow and indirect for a pure calculation.' }, { text: 'No test: it is too simple to break', feedback: 'Fee rules are exactly where boundary bugs cost money.' }] },
        { title: 'Code and database together', text: 'Saving a payment writes to the database and reads it back.', choices: [{ text: 'Integration test: run against a real (test) database to check the parts work together', right: true, feedback: 'Correct. Integration tests catch mismatches between components, such as a wrong column name.' }, { text: 'Unit test with every database call faked', feedback: 'Useful too, but it cannot catch a real schema mismatch.' }, { text: 'Manual test before each release', feedback: 'Slow, forgotten, and not repeatable.' }] },
        { title: 'A whole user journey', text: 'A customer logs in, pays a bill and receives an SMS receipt.', choices: [{ text: 'End-to-end test: drive the deployed system like a user; keep only a few for the critical journeys', right: true, feedback: 'Correct. They give the most confidence per test but are slow and brittle.' }, { text: 'Hundreds of end-to-end tests for every branch of the code', feedback: 'They would take hours and break whenever the page layout changes.' }, { text: 'Skip it: unit tests cover it', feedback: 'Unit tests cannot see that the pieces are wired up correctly.' }] },
        { title: 'The shape', text: 'How many of each?', choices: [{ text: 'A pyramid: many unit tests, fewer integration tests, a handful of end-to-end tests', right: true, feedback: 'Correct. Fast tests give quick feedback; slow ones confirm the whole.' }, { text: 'An ice-cream cone: mostly manual and end-to-end tests', feedback: 'The classic anti-pattern: slow and flaky.' }, { text: 'Equal numbers of each', feedback: 'End-to-end tests cost far more to run and maintain.' }] },
        { title: 'Runners', text: 'The code is in Python, JavaScript and a little Java.', choices: [{ text: 'Use each language\'s standard runner (pytest or unittest, Jest or node:test, JUnit) and run them all in CI', right: true, feedback: 'Correct. Standard runners integrate with editors, coverage tools and CI.' }, { text: 'Write one home-made runner for all three languages', feedback: 'You would maintain a test framework instead of the product.' }, { text: 'Only test the Python part', feedback: 'Bugs do not respect language boundaries.' }] },
      ],
      ending: { title: 'A testing pyramid', text: 'Many fast unit tests, some integration tests at the boundaries, a few end-to-end tests for critical journeys, all run by standard runners in CI.' },
      hints: ['Ask what each test needs to be running: one function, two components, or the whole deployed system?', 'Speed and stability fall as tests get bigger.'],
      realityNote: 'The pyramid was popularised by Mike Cohn; Google famously aims for roughly 70% unit, 20% integration and 10% end-to-end tests.',
    });
  }),
  tmpl(5, 1, 'intermediate', 'python-unit-tests', 'Write unit tests that catch real bugs', 'E1', 30, 'Write unittest tests for a fee function; they must pass on the real code and fail on buggy versions.', (v) => {
    const free = v.pick([50, 100, 200]);
    const rate = v.pick([1, 2]);
    const cap = v.pick([10, 15, 20]);
    const fn = `def transfer_fee(amount):\n    """Fee in GHS for a mobile money transfer."""\n    if amount <= ${free}:\n        return 0\n    fee = amount * ${rate} / 100\n    return min(fee, ${cap})\n`;
    const correct = fn.replace('def transfer_fee(', 'def _reference(');
    const mutants: Array<[string, string]> = [
      [`a transfer of exactly ${free} is charged`, fn.replace(`<= ${free}`, `< ${free}`)],
      [`the rate is ${rate + 1}% instead of ${rate}%`, fn.replace(`* ${rate} / 100`, `* ${rate + 1} / 100`)],
      ['the fee is no longer capped', fn.replace(`return min(fee, ${cap})`, 'return fee')],
      [`the cap is ${cap + 5} instead of ${cap}`, fn.replace(`min(fee, ${cap})`, `min(fee, ${cap + 5})`)],
    ];
    const starter = `import unittest\n\n# The function under test (do not change it).\n${fn}\n\nclass TestTransferFee(unittest.TestCase):\n    def test_small_transfers_are_free(self):\n        self.assertEqual(transfer_fee(10), 0)\n\n    # Add tests here: the boundary at ${free}, a normal fee, and the cap.\n\n\nif __name__ == "__main__":\n    unittest.main(argv=["tests"], exit=False)\n`;
    const solution = starter.replace('    # Add tests here: the boundary at ' + free + ', a normal fee, and the cap.\n', `    def test_boundary_is_free(self):\n        self.assertEqual(transfer_fee(${free}), 0)\n\n    def test_just_above_boundary_is_charged(self):\n        self.assertAlmostEqual(transfer_fee(${free + 100}), ${(free + 100) * rate / 100})\n\n    def test_fee_is_capped(self):\n        self.assertEqual(transfer_fee(100000), ${cap})\n\n    def test_fee_below_cap(self):\n        self.assertAlmostEqual(transfer_fee(${Math.floor((cap * 100) / rate) - 100}), ${((Math.floor((cap * 100) / rate) - 100) * rate) / 100})\n`);
    return code('python', {
      instructions: `## Tests that would catch a bug\n\n\`transfer_fee(amount)\` charges nothing up to and including **GHS ${free}**, then **${rate}%** of the amount, but never more than **GHS ${cap}**.\n\nIn the class **TestTransferFee**, write at least **4** tests (methods starting with \`test_\`). The check runs your tests twice: on the real function (they must all pass) and on four **buggy copies** (each must make at least one of your tests fail).\n\nThink about the **boundary** (exactly ${free}), a normal fee, the **cap**, and a fee just under the cap. Do not change the function.`,
      hints: [`Boundary bugs (< instead of <=) only show at exactly ${free}.`, 'assertAlmostEqual is safer than assertEqual for results computed with division.', 'A test that passes on every version of the function tests nothing.'],
      starter,
      checks: [{ type: 'code.script', label: 'Your tests pass on the real function and catch every buggy version', script: pyMutationCheck('transfer_fee', 'TestTransferFee', 4, correct, mutants) }],
      solution,
      realityNote: 'Checking tests against deliberately broken code is called mutation testing; tools such as mutmut (Python) and Stryker (JavaScript) do it automatically.',
    });
  }),
  tmpl(5, 1, 'advanced', 'javascript-unit-tests', 'Test a bill-splitting function in JavaScript', 'E1', 30, 'Write tests for splitBill that pass on the real code and catch rounding, remainder and validation bugs.', (v) => {
    const fnSrc = `function splitBill(totalPesewas, people) {\n  if (!Number.isInteger(people) || people < 1) throw new Error('people must be a positive whole number');\n  const share = Math.floor(totalPesewas / people);\n  const extra = totalPesewas % people;\n  // The first "extra" people pay one pesewa more, so the shares add up exactly.\n  return Array.from({ length: people }, (_, i) => share + (i < extra ? 1 : 0));\n}\n`;
    const mutants: Array<[string, string]> = [
      ['the extra pesewas go to the last people instead of the first', fnSrc.replace('(i < extra ? 1 : 0)', '(i >= people - extra ? 1 : 0)')],
      ['the remainder is dropped, so the shares do not add up', fnSrc.replace('share + (i < extra ? 1 : 0)', 'share')],
      ['shares are rounded instead of rounded down', fnSrc.replace('Math.floor(totalPesewas / people)', 'Math.round(totalPesewas / people)')],
      ['zero people is not rejected', fnSrc.replace("if (!Number.isInteger(people) || people < 1) throw new Error('people must be a positive whole number');\n", '')],
    ];
    const total = v.pick([1000, 1001, 2502, 7777]);
    const starter = `${JS_HARNESS}\n// The function under test (do not change it).\n${fnSrc}\n// Your tests:\ntest('an even split', () => {\n  assertEqual(splitBill(900, 3), [300, 300, 300]);\n});\n\n// Add tests for: an uneven split (who pays the extra pesewas?), shares adding up to the total,\n// rounding, and invalid numbers of people.\n${JS_RUN}`;
    const solution = starter.replace("// Add tests for: an uneven split (who pays the extra pesewas?), shares adding up to the total,\n// rounding, and invalid numbers of people.\n", `test('the first people pay the extra pesewas', () => {\n  assertEqual(splitBill(1001, 3), [334, 334, 333]);\n});\n\ntest('shares add up to the total', () => {\n  const shares = splitBill(${total}, 7);\n  assertEqual(shares.reduce((a, b) => a + b, 0), ${total});\n});\n\ntest('shares are rounded down before the remainder is shared', () => {\n  assertEqual(splitBill(1005, 10), [101, 101, 101, 101, 101, 100, 100, 100, 100, 100]);\n});\n\ntest('zero people is an error', () => {\n  assertThrows(() => splitBill(500, 0));\n});\n`);
    return code('javascript', {
      instructions: `## Splitting a bill fairly\n\n\`splitBill(totalPesewas, people)\` splits an amount in pesewas into whole-pesewa shares. When it does not divide evenly, the **first** people pay one pesewa more, so the shares always add up to the total. It throws an error unless \`people\` is a whole number of at least 1.\n\nUsing the \`test\` and \`assertEqual\` / \`assertThrows\` helpers, write at least **5** tests (one is given). The check runs them on the real function and on four **buggy copies**; each copy must fail at least one test. Try a total such as ${total}.`,
      hints: ['An uneven split shows who gets the extra pesewas.', 'Sum the shares: the total must come back exactly.', 'Rounding (Math.round) and rounding down (Math.floor) differ when the share ends in .5 or more.'],
      starter,
      checks: [{ type: 'code.script', label: 'Your tests pass on the real function and catch every buggy version', script: jsMutationCheck('splitBill', 5, fnSrc, mutants) }],
      solution,
      realityNote: 'Jest, Vitest and node:test all follow this shape: register named tests, assert inside them, and report failures by name.',
    });
  }),

  /* ---------------------------------------------------------------- 5.2 linting and formatting as checks; pre-commit hooks */
  tmpl(5, 2, 'beginner', 'lint-target', 'Add a lint step and make it pass', 'E4', 20, 'Add a make lint target that runs ShellCheck on every script, then fix the warnings.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const dir = v.pick(['/var/backups/app', '/srv/exports', '/opt/app/data']);
    const scripts = {
      'scripts/backup.sh': SH(`target=$1\ncd ${dir}\ncp $target ./latest\necho "copied $target"\n`),
      'scripts/greet.sh': SH('read -p "Name: " name\necho "Hello, $name"\n'),
    };
    const mk = 'test:\n\t@echo "no tests yet"\n';
    return {
      instructions: lab({
        situation: `**~/${o.project}** has shell scripts in **scripts/** and a Makefile. CI will run \`make lint\`. Add a **lint** target that runs \`shellcheck\` on every \`scripts/*.sh\` file, then fix the scripts until \`make lint\` passes. The scripts must still do the same job.`,
        steps: ['Add to the Makefile (recipe lines start with a TAB):\nlint:\n\tshellcheck scripts/*.sh', 'make lint (see the warnings)', 'Quote "$target"; add || exit after cd; use read -r', 'make lint until it passes'],
        tips: ['shellcheck FILE', 'cd DIR || exit 1', 'read -r -p "Name: " name', '.PHONY: lint test'],
      }),
      hints: ['Unquoted variables split on spaces and expand wildcards (SC2086).', 'If cd fails, the next command runs in the wrong folder (SC2164).', 'read without -r mangles backslashes (SC2162).'],
      initialState: dev({ me, org: o, packages: ['make', 'shellcheck'], files: repo(me.sam, `${home}/${o.project}`, [C('Add scripts', me, o, { ...scripts, Makefile: mk }, undefined)], {}, { executable: Object.keys(scripts) }) }),
      checks: [
        file('The Makefile has a lint target running shellcheck', `${home}/${o.project}/Makefile`, { pattern: '^lint:[^\\n]*\\n\\t[^\\n]*shellcheck[^\\n]*scripts/\\*\\.sh' }),
        out('make lint passes', `cd ${home}/${o.project} && make lint >/dev/null 2>&1; echo "rc=$?"`, { equals: 'rc=0' }),
        file('backup.sh quotes its argument and checks cd', `${home}/${o.project}/scripts/backup.sh`, { pattern: `cd ${dir.replace(/\//g, '\\/')} \\|\\| exit[\\s\\S]*cp "\\$target"` }),
      ],
      solution: [`cd ~/${o.project}`, "printf 'lint:\\n\\tshellcheck scripts/*.sh\\n\\ntest:\\n\\t@echo \"no tests yet\"\\n' > Makefile", write('scripts/backup.sh', SH(`target=$1\ncd ${dir} || exit 1\ncp "$target" ./latest\necho "copied $target"\n`)), write('scripts/greet.sh', SH('read -r -p "Name: " name\necho "Hello, $name"\n')), 'make lint'],
      realityNote: 'Linters in CI stop whole classes of bugs before review; ShellCheck, ESLint, Ruff and golangci-lint are the usual ones.',
    };
  }),
  tmpl(5, 2, 'intermediate', 'write-a-hook', 'Write a pre-commit hook that blocks bad scripts', 'E4', 25, 'Write .git/hooks/pre-commit to run ShellCheck on staged shell scripts and refuse the commit on problems.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'run.sh': SH('echo "running"\n') })], {}, { executable: ['run.sh'] });
    return {
      instructions: lab({
        situation: `Stop unlinted scripts entering **~/${o.project}**. Write the hook **.git/hooks/pre-commit** (executable) that:\n\n1. lists the **staged** files that are added or modified and end in \`.sh\`;\n2. runs \`shellcheck\` on them;\n3. exits **1** (refusing the commit) if ShellCheck finds problems, and 0 otherwise (also when no .sh files are staged).\n\nTry it: committing a script with \`echo $1\` must be refused; \`echo "$1"\` must commit.`,
        steps: ['files=$(git diff --cached --name-only --diff-filter=AM -- \'*.sh\')', '[ -z "$files" ] && exit 0', 'shellcheck $files || { echo "pre-commit: fix the ShellCheck warnings"; exit 1; }', 'chmod +x .git/hooks/pre-commit'],
        tips: ['git diff --cached --name-only --diff-filter=AM', 'chmod +x .git/hooks/pre-commit', 'git commit --no-verify (skips hooks: avoid)'],
      }),
      hints: ['Hooks are ordinary scripts; a non-zero exit from pre-commit aborts the commit.', 'Check the staged files, not the working tree: that is what will be committed.'],
      initialState: dev({ me, org: o, packages: ['shellcheck'], files }),
      checks: [
        file('The hook is executable', `${home}/${o.project}/.git/hooks/pre-commit`, { mode: '755' }),
        out('A script with a ShellCheck problem is refused', `su - ${me.sam} -c 'cd ${o.project} && printf "#!/bin/bash\\necho \\$1\\n" > bad.sh && git add bad.sh && git commit -qm bad; echo "rc=$?"; git log --oneline | wc -l'`, { pattern: 'rc=1\\n1$' }),
        out('A clean script commits', `su - ${me.sam} -c 'cd ${o.project} && printf "#!/bin/bash\\necho \\"\\$1\\"\\n" > good.sh && git add good.sh && git commit -qm good; echo "rc=$?"'`, { pattern: 'rc=0$' }),
        out('Commits without scripts are not blocked', `su - ${me.sam} -c 'cd ${o.project} && echo notes > NOTES.md && git add NOTES.md && git commit -qm notes; echo "rc=$?"'`, { pattern: 'rc=0$' }),
      ],
      solution: [`cd ~/${o.project}`, write('.git/hooks/pre-commit', `#!/bin/bash\nfiles=$(git diff --cached --name-only --diff-filter=AM -- '*.sh')\n[ -z "$files" ] && exit 0\n# shellcheck disable=SC2086\nshellcheck $files || { echo "pre-commit: fix the ShellCheck warnings above"; exit 1; }\n`), 'chmod +x .git/hooks/pre-commit'],
      realityNote: 'Hooks live in .git/hooks and are not committed; teams share them with core.hooksPath or the pre-commit framework.',
    };
  }),
  tmpl(5, 2, 'advanced', 'pre-commit-framework', 'Configure the pre-commit framework for a project', 'E4', 30, 'Write .pre-commit-config.yaml with fixers, a YAML check, ShellCheck and a main-branch guard, then fix the repository.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'deploy.sh': SH('echo "deploying"   \n'), 'config.yml': 'name: app\nport: 8080', 'README.md': '# App\n\n\n' })], {}, { executable: ['deploy.sh'] });
    const cfg = `repos:\n-   repo: https://github.com/pre-commit/pre-commit-hooks\n    rev: v4.6.0\n    hooks:\n    -   id: trailing-whitespace\n    -   id: end-of-file-fixer\n    -   id: check-yaml\n    -   id: no-commit-to-branch\n        args: [--branch, main]\n-   repo: https://github.com/shellcheck-py/shellcheck-py\n    rev: v0.10.0.1\n    hooks:\n    -   id: shellcheck\n`;
    return {
      instructions: lab({
        situation: `Adopt the **pre-commit** framework in **~/${o.project}** so every developer runs the same checks:\n\n1. write **.pre-commit-config.yaml** with, from \`https://github.com/pre-commit/pre-commit-hooks\` (rev v4.6.0): **trailing-whitespace**, **end-of-file-fixer**, **check-yaml**, and **no-commit-to-branch** for **main**; and **shellcheck** from \`https://github.com/shellcheck-py/shellcheck-py\` (rev v0.10.0.1);\n2. install the git hook;\n3. run all hooks on **all files** and let the fixers repair them until everything passes;\n4. commit the config and the fixes on a new branch **tooling** (main is now guarded).`,
        steps: ['pre-commit sample-config (a starting point)', 'Write .pre-commit-config.yaml', 'pre-commit install', 'pre-commit run --all-files (fixers change files; run again)', 'git switch -c tooling; git add -A; git commit -m "Add pre-commit checks"'],
        tips: ['pre-commit sample-config', 'pre-commit install', 'pre-commit run --all-files', 'pre-commit run HOOK_ID'],
      }),
      hints: ['A fixer "fails" the first time because it changed files; run again and it passes.', 'no-commit-to-branch makes the hook refuse commits made directly on main.'],
      initialState: dev({ me, org: o, packages: ['pre-commit', 'shellcheck'], files }),
      checks: [
        file('The config lists the hooks', `${home}/${o.project}/.pre-commit-config.yaml`, { contains: ['trailing-whitespace', 'end-of-file-fixer', 'check-yaml', 'no-commit-to-branch', 'shellcheck', 'pre-commit/pre-commit-hooks', 'shellcheck-py/shellcheck-py'] }),
        file('The hook is installed', `${home}/${o.project}/.git/hooks/pre-commit`, { contains: 'pre-commit' }),
        out('All hooks pass on every file', `cd ${home}/${o.project} && git switch -q tooling 2>/dev/null; pre-commit run --all-files >/dev/null; echo "rc=$?"`, { equals: 'rc=0' }),
        out('The fixes are committed on tooling, main untouched', `cd ${home}/${o.project} && git log -1 --format=%s tooling && git log --oneline main | wc -l && git status --porcelain`, { equals: `Add pre-commit checks\n1` }),
        out('Committing on main is refused', `su - ${me.sam} -c 'cd ${o.project} && git switch -q main && echo x >> README.md && git commit -qam x; echo "rc=$?"'`, { pattern: 'rc=1$' }),
      ],
      solution: [`cd ~/${o.project}`, write('.pre-commit-config.yaml', cfg), 'pre-commit install', 'pre-commit run --all-files', 'pre-commit run --all-files', 'git switch -c tooling', 'git add -A', 'git commit -q -m "Add pre-commit checks"'],
      realityNote: 'pre-commit is used by thousands of projects (CPython among them); the same config also runs in CI with pre-commit run --all-files.',
    };
  }),

  /* ---------------------------------------------------------------- 5.3 coverage and its limits; flaky tests */
  tmpl(5, 3, 'beginner', 'coverage-and-flakes', 'Read coverage numbers and flaky tests critically', 'E10', 15, 'Decide what coverage tells you and what to do about a test that fails one run in ten.', (v) => {
    const o = v.pick(ORGS);
    const pct = v.int(85, 98);
    return caseStudy(v, {
      intro: `## ${pct}% covered, still broken\n\n${o.org}'s CI reports ${pct}% line coverage, yet a fee calculation bug reached production. Also, one test fails about one run in ten, and people just press "re-run".`,
      steps: [
        { title: 'What coverage measures', text: `The buggy line was covered.`, choices: [{ text: 'Only that the line ran during some test, not that any test checked its result', right: true, feedback: 'Correct. A test with no assertion still "covers" every line it touches.' }, { text: 'That the line is correct', feedback: 'Coverage cannot see correctness.' }, { text: 'Nothing useful at all', feedback: 'Uncovered code is certainly untested: low coverage is a real warning.' }] },
        { title: 'Setting a target', text: 'A manager wants 100% coverage, enforced.', choices: [{ text: 'Use coverage to find untested risky code, with a sensible floor; judge tests by the bugs they catch', right: true, feedback: 'Correct. Chasing 100% invites tests that execute code without checking it.' }, { text: 'Enforce 100% on every file', feedback: 'Leads to tests of getters and generated code, not of logic.' }, { text: 'Remove the coverage report', feedback: 'You lose a useful signal about blind spots.' }] },
        { title: 'The flaky test', text: 'It uses today\'s date and a random account number.', choices: [{ text: 'Make the inputs deterministic (fixed date, fixed or seeded values), then fix or quarantine it', right: true, feedback: 'Correct. Time, randomness, ordering and network calls are the usual sources of flakiness.' }, { text: 'Keep pressing re-run', feedback: 'People stop trusting CI and real failures get re-run away.' }, { text: 'Delete the test', feedback: 'Only as a last resort, and with an issue to replace it.' }] },
        { title: 'Finding flakiness', text: 'Which tests are flaky?', choices: [{ text: 'Run the suite many times in a loop (or track pass/fail history in CI) and look for tests that change result without code changes', right: true, feedback: 'Correct. Flakiness shows statistically, not in a single run.' }, { text: 'Ask people which tests annoy them', feedback: 'Anecdote, not evidence.' }, { text: 'It is impossible to know', feedback: 'Repeated runs make it visible.' }] },
      ],
      ending: { title: 'Coverage is a map, not a grade', text: 'Coverage shows what never ran; assertions and mutation tests show what is actually checked. Flaky tests come from time, randomness and order: make them deterministic.' },
      hints: ['Ask what a coverage tool actually observes.', 'Re-running hides flaky tests; it does not fix them.'],
      realityNote: 'Google has reported that around 1.5% of test runs show flaky behaviour; most large CI systems quarantine flaky tests automatically.',
    });
  }),
  tmpl(5, 3, 'intermediate', 'full-coverage', 'Write tests that cover every line', 'E1', 30, 'Write tests that make every line of a grading function run, measured with sys.settrace.', (v) => {
    const cut = v.pick([[70, 60, 50, 40], [75, 65, 55, 45], [80, 70, 60, 50]]);
    const fn = `def grade(score):\n    """Letter grade for a mark out of 100."""\n    if not 0 <= score <= 100:\n        raise ValueError("score must be 0-100")\n    if score >= ${cut[0]}:\n        return "A"\n    if score >= ${cut[1]}:\n        return "B"\n    if score >= ${cut[2]}:\n        return "C"\n    if score >= ${cut[3]}:\n        return "D"\n    return "F"\n`;
    const starter = `import unittest\n\n# The function under test (do not change it).\n${fn}\n\nclass TestGrade(unittest.TestCase):\n    def test_top_mark(self):\n        self.assertEqual(grade(100), "A")\n\n    # Add tests until every line of grade() runs at least once.\n\n\nif __name__ == "__main__":\n    unittest.main(argv=["tests"], exit=False)\n`;
    const solution = starter.replace('    # Add tests until every line of grade() runs at least once.\n', `    def test_b(self):\n        self.assertEqual(grade(${cut[1]}), "B")\n\n    def test_c(self):\n        self.assertEqual(grade(${cut[2]}), "C")\n\n    def test_d(self):\n        self.assertEqual(grade(${cut[3]}), "D")\n\n    def test_f(self):\n        self.assertEqual(grade(${cut[3] - 1}), "F")\n\n    def test_out_of_range(self):\n        with self.assertRaises(ValueError):\n            grade(101)\n`);
    const script = [
      'import sys as _sys, unittest as _ut, io as _io',
      '_code = grade.__code__',
      '_hit = set()',
      'def _tracer(frame, event, arg):',
      '    if frame.f_code is _code and event == "line":',
      '        _hit.add(frame.f_lineno)',
      '    return _tracer',
      '_s = _ut.defaultTestLoader.loadTestsFromTestCase(TestGrade)',
      '_sys.settrace(_tracer)',
      '_r = _ut.TextTestRunner(stream=_io.StringIO(), verbosity=0).run(_s)',
      '_sys.settrace(None)',
      'assert _r.wasSuccessful(), "some of your tests fail"',
      'import dis as _dis',
      '_lines = sorted({l for _, l in _dis.findlinestarts(_code) if l is not None and l > _code.co_firstlineno + 1})',
      '_missed = [l - _code.co_firstlineno for l in _lines if l not in _hit]',
      'assert not _missed, f"lines of grade() never run by your tests (counting the def line as 0): {_missed}"',
    ].join('\n');
    return code('python', {
      instructions: `## 100% line coverage\n\n\`grade(score)\` turns a mark into a letter: A from ${cut[0]}, B from ${cut[1]}, C from ${cut[2]}, D from ${cut[3]}, otherwise F, and raises ValueError outside 0-100.\n\nAdd tests to **TestGrade** until **every line** of grade() runs during your tests, and all tests pass. The check measures this the way coverage tools do: it traces which lines execute.`,
      hints: ['Each return statement is a line: you need an input that reaches every one.', 'The raise line needs a test with assertRaises.'],
      starter,
      checks: [{ type: 'code.script', label: 'Every line of grade() runs and every test passes', script }],
      solution,
      realityNote: 'coverage.py works by installing a trace function exactly like this; branch coverage adds which way each if went.',
    });
  }),
  tmpl(5, 3, 'advanced', 'flaky-test', 'Find and fix a flaky test', 'E4', 30, 'Prove a bats test is flaky by running it in a loop, then make it deterministic.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const prefix = v.pick(['024', '054', '020', '026']);
    const validator = SH(`# A Ghana mobile number: 10 digits starting with 0.\n[[ "$1" =~ ^0[0-9]{9}$ ]] && echo valid || { echo invalid; exit 1; }\n`);
    const flaky = `#!/usr/bin/env bats\n\n@test "accepts a valid number" {\n  num="${prefix}$RANDOM$((RANDOM % 100))"\n  run ./validate-phone.sh "$num"\n  [ "$status" -eq 0 ]\n}\n\n@test "rejects letters" {\n  run ./validate-phone.sh 02441234ab\n  [ "$status" -eq 1 ]\n}\n`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add phone validation', me, o, { 'validate-phone.sh': validator, 'tests/phone.bats': flaky })], {}, { executable: ['validate-phone.sh'] });
    return {
      instructions: lab({
        situation: `CI for **~/${o.project}** fails now and then on "accepts a valid number" in **tests/phone.bats**, and passes when re-run.\n\n1. **prove** it is flaky: run the suite (from the project folder) **20 times** in a loop and count the failures; write the count to **~/flaky-count.txt**;\n2. make the test **deterministic**: test fixed valid numbers instead of random ones (no $RANDOM), for example \`${prefix}1234567\`;\n3. show the suite now passes 20 times out of 20.`,
        steps: [`cd ~/${o.project}`, 'fails=0; for i in $(seq 20); do bats tests >/dev/null || fails=$((fails+1)); done; echo $fails', 'echo $fails > ~/flaky-count.txt', 'Rewrite the test with fixed numbers', 'Run the loop again: 0 failures'],
        tips: ['for i in $(seq 20); do ...; done', 'bats tests', 'run COMMAND; [ "$status" -eq 0 ]'],
      }),
      hints: ['$RANDOM is 0 to 32767, so it has 1 to 5 digits: the number is sometimes too short.', 'A test should produce the same result every time it runs on the same code.'],
      initialState: dev({ me, org: o, packages: ['bats'], files }),
      checks: [
        file('You counted failures before fixing', `${home}/flaky-count.txt`, { pattern: '^[1-9]\\d*$' }),
        file('The test no longer uses $RANDOM', `${home}/${o.project}/tests/phone.bats`, { notContains: '$RANDOM', contains: ['accepts a valid number', 'rejects letters'] }),
        out('The suite passes 20 times out of 20', `cd ${home}/${o.project} && n=0; for i in $(seq 20); do bats tests >/dev/null && n=$((n+1)); done; echo $n`, { equals: '20' }),
      ],
      solution: [`cd ~/${o.project}`, 'fails=0; for i in $(seq 20); do bats tests >/dev/null || fails=$((fails+1)); done; echo "$fails" > ~/flaky-count.txt; cat ~/flaky-count.txt', write('tests/phone.bats', `#!/usr/bin/env bats\n\n@test "accepts a valid number" {\n  for num in ${prefix}1234567 ${prefix}0000000 ${prefix}9999999; do\n    run ./validate-phone.sh "$num"\n    [ "$status" -eq 0 ]\n  done\n}\n\n@test "rejects letters" {\n  run ./validate-phone.sh 02441234ab\n  [ "$status" -eq 1 ]\n}\n`), 'n=0; for i in $(seq 20); do bats tests >/dev/null && n=$((n+1)); done; echo "$n of 20 passed"'],
      realityNote: 'Randomised inputs are valuable when deliberate (property-based testing with a printed seed), but accidental randomness is a classic source of flaky CI.',
    };
  }),

  /* ---------------------------------------------------------------- 5.4 test-driven development in a small kata */
  tmpl(5, 4, 'beginner', 'tdd-make-it-green', 'Make the failing tests pass', 'E1', 25, 'Implement a function from its tests: red, then green, then tidy.', (v) => {
    const levy = v.pick([1, 1.5, 2]);
    const min = v.pick([0.5, 1]);
    const starter = `import unittest\n\n\ndef momo_charge(amount):\n    """Charge in GHS for sending amount GHS. Write this so the tests pass."""\n    return 0\n\n\nclass TestMomoCharge(unittest.TestCase):\n    def test_nothing_on_zero(self):\n        self.assertEqual(momo_charge(0), 0)\n\n    def test_percentage(self):\n        self.assertAlmostEqual(momo_charge(1000), ${(1000 * levy) / 100})\n\n    def test_minimum_charge(self):\n        self.assertAlmostEqual(momo_charge(10), ${min})\n\n    def test_rounded_to_pesewas(self):\n        self.assertAlmostEqual(momo_charge(334), ${Math.max(min, Math.round(334 * levy) / 100)})\n\n    def test_negative_amount_is_an_error(self):\n        with self.assertRaises(ValueError):\n            momo_charge(-5)\n\n\nif __name__ == "__main__":\n    unittest.main(argv=["tests"], exit=False)\n`;
    const impl = `def momo_charge(amount):\n    """Charge in GHS for sending amount GHS: ${levy}% with a minimum of ${min}, rounded to pesewas."""\n    if amount < 0:\n        raise ValueError("amount cannot be negative")\n    if amount == 0:\n        return 0\n    return max(${min}, round(amount * ${levy} / 100, 2))\n`;
    return code('python', {
      instructions: `## Red, green, refactor\n\nThe tests for \`momo_charge(amount)\` are written; the function is not. In test-driven development you write the **smallest** code that makes the tests pass, then tidy it.\n\nRun the program to see the tests fail (red), then implement momo_charge until they all pass (green). From the tests: **${levy}%** of the amount, at least **GHS ${min}** (but nothing on 0), rounded to **pesewas**, and a ValueError for negative amounts.`,
      hints: ['Make one failing test pass at a time.', 'round(x, 2) rounds to two decimal places.'],
      starter,
      checks: [
        { type: 'code.script', label: 'The given tests pass', script: 'import unittest as _ut, io as _io\n_r = _ut.TextTestRunner(stream=_io.StringIO(), verbosity=0).run(_ut.defaultTestLoader.loadTestsFromTestCase(TestMomoCharge))\nassert _r.wasSuccessful(), f"{len(_r.failures) + len(_r.errors)} of the tests still fail"' },
        { type: 'code.function', label: 'It also works on amounts the tests did not try', name: 'momo_charge', cases: [{ args: [1], expected: min }, { args: [5000], expected: (5000 * levy) / 100 }, { args: [58], expected: Math.max(min, Math.round(58 * levy) / 100) }], tolerance: 0.001 },
      ],
      solution: starter.replace(`def momo_charge(amount):\n    """Charge in GHS for sending amount GHS. Write this so the tests pass."""\n    return 0\n`, impl),
      realityNote: 'Kent Beck\'s Test-Driven Development by Example introduced the red-green-refactor loop; katas like this are how teams practise it.',
    });
  }),
  tmpl(5, 4, 'intermediate', 'tdd-test-first', 'Write the tests first, then the code', 'E1', 35, 'Write tests for a Ghana Card number check, then implement it to pass them.', (v) => {
    const fn = `def valid_ghana_card(card):\n    """True for numbers like GHA-123456789-0: GHA, a dash, 9 digits, a dash, 1 digit."""\n    import re\n    return bool(re.fullmatch(r"GHA-\\d{9}-\\d", card or ""))\n`;
    const mutants: Array<[string, string]> = [
      ['lower-case "gha" is accepted', fn.replace('r"GHA-\\d{9}-\\d", card or ""', 'r"(?i)GHA-\\d{9}-\\d", card or ""')],
      ['8 digits are accepted', fn.replace('\\d{9}', '\\d{8,9}')],
      ['the final check digit is optional', fn.replace('-\\d", card', '(-\\d)?", card')],
      ['extra characters after the number are accepted', fn.replace('re.fullmatch(', 're.match(')],
      ['the prefix is not checked', fn.replace('r"GHA-', 'r"[A-Z]{3}-')],
    ];
    const sample = `GHA-${v.int(100000000, 999999999)}-${v.int(0, 9)}`;
    const starter = `import unittest\n\n\ndef valid_ghana_card(card):\n    """True for numbers like GHA-123456789-0. Write the tests first, then this."""\n    return False\n\n\nclass TestGhanaCard(unittest.TestCase):\n    # Write at least 6 tests first: valid numbers and every way a number can be wrong.\n    pass\n\n\nif __name__ == "__main__":\n    unittest.main(argv=["tests"], exit=False)\n`;
    const solution = starter.replace(`def valid_ghana_card(card):\n    """True for numbers like GHA-123456789-0. Write the tests first, then this."""\n    return False\n`, fn).replace("    # Write at least 6 tests first: valid numbers and every way a number can be wrong.\n    pass\n", `    def test_valid(self):\n        self.assertTrue(valid_ghana_card("${sample}"))\n\n    def test_lower_case_prefix(self):\n        self.assertFalse(valid_ghana_card("${sample.toLowerCase()}"))\n\n    def test_too_few_digits(self):\n        self.assertFalse(valid_ghana_card("GHA-12345678-0"))\n\n    def test_missing_check_digit(self):\n        self.assertFalse(valid_ghana_card("GHA-123456789"))\n\n    def test_trailing_text(self):\n        self.assertFalse(valid_ghana_card("${sample}X"))\n\n    def test_other_prefix(self):\n        self.assertFalse(valid_ghana_card("NGA-123456789-0"))\n\n    def test_empty(self):\n        self.assertFalse(valid_ghana_card(""))\n`);
    return code('python', {
      instructions: `## Test first\n\nA Ghana Card number looks like **${sample}**: \`GHA\` in capitals, a dash, exactly **9** digits, a dash, and **1** check digit, with nothing before or after.\n\n1. In **TestGhanaCard**, write at least **6** tests: valid numbers and each way a number can be wrong;\n2. then implement \`valid_ghana_card(card)\` until they pass.\n\nThe check runs your tests on a correct version (they must pass) and on five buggy versions (each must fail a test), and checks your implementation.`,
      hints: ['re.fullmatch requires the whole string to match; re.match only checks the start.', 'Think of each rule and write a test that breaks only that rule.'],
      starter,
      checks: [
        { type: 'code.script', label: 'Your tests pass on a correct version and catch every buggy one', script: pyMutationCheck('valid_ghana_card', 'TestGhanaCard', 6, fn.replace('def valid_ghana_card(', 'def _reference('), mutants) },
        { type: 'code.function', label: 'Your implementation is correct', name: 'valid_ghana_card', cases: [{ args: [sample], expected: true }, { args: ['GHA-000000000-1'], expected: true }, { args: ['gha-123456789-0'], expected: false }, { args: ['GHA-1234567890-0'], expected: false }, { args: ['GHA-123456789-'], expected: false }, { args: [' GHA-123456789-0'], expected: false }] },
      ],
      solution,
      realityNote: 'Writing the tests first forces you to pin down the rules before the code exists; it is also how many teams reproduce a bug before fixing it.',
    });
  }),
  tmpl(5, 4, 'advanced', 'tdd-kata-change', 'Kata: make change with the fewest coins', 'E1', 40, 'Use TDD in JavaScript to build a change-making function, with tests that catch the classic mistakes.', (v) => {
    const coins = v.pick([[200, 100, 50, 20, 10, 5, 1], [100, 50, 25, 10, 5, 1], [200, 100, 50, 25, 10, 5, 1]]);
    const fn = `function makeChange(amount, coins) {\n  if (!Number.isInteger(amount) || amount < 0) throw new Error('amount must be a whole number of pesewas');\n  const result = [];\n  let left = amount;\n  for (const c of [...coins].sort((a, b) => b - a)) {\n    while (left >= c) {\n      result.push(c);\n      left -= c;\n    }\n  }\n  if (left !== 0) throw new Error('cannot make exact change');\n  return result;\n}\n`;
    const mutants: Array<[string, string]> = [
      ['coins are not sorted, so the result is not the fewest coins', fn.replace('[...coins].sort((a, b) => b - a)', 'coins')],
      ['each coin is used at most once', fn.replace('while (left >= c)', 'if (left >= c)')],
      ['an impossible amount returns partial change instead of an error', fn.replace("  if (left !== 0) throw new Error('cannot make exact change');\n", '')],
      ['negative amounts quietly return no coins instead of an error', fn.replace("if (!Number.isInteger(amount) || amount < 0) throw new Error('amount must be a whole number of pesewas');", 'if (amount <= 0) return [];')],
      ['zero gives an error instead of no coins', fn.replace('const result = [];', "if (amount === 0) throw new Error('nothing to change');\n  const result = [];")],
    ];
    const amount = v.int(120, 390);
    const expected = (() => {
      const r: number[] = [];
      let left = amount;
      for (const c of coins) while (left >= c) (r.push(c), (left -= c));
      return r;
    })();
    const shuffled = [...coins].reverse();
    const starter = `${JS_HARNESS}\n// Write tests first, then makeChange(amount, coins): the fewest coins (largest first) that add up to amount.\nfunction makeChange(amount, coins) {\n  return [];\n}\n\n// Your tests (at least 6):\n\n${JS_RUN}`;
    const solution = starter.replace('function makeChange(amount, coins) {\n  return [];\n}\n', fn).replace('// Your tests (at least 6):\n', `test('fewest coins, largest first', () => {\n  assertEqual(makeChange(${amount}, ${JSON.stringify(coins)}), ${JSON.stringify(expected)});\n});\n\ntest('coins given in any order', () => {\n  assertEqual(makeChange(${amount}, ${JSON.stringify(shuffled)}), ${JSON.stringify(expected)});\n});\n\ntest('a coin can be used many times', () => {\n  assertEqual(makeChange(3, [1]), [1, 1, 1]);\n});\n\ntest('zero needs no coins', () => {\n  assertEqual(makeChange(0, [1, 5]), []);\n});\n\ntest('impossible change is an error', () => {\n  assertThrows(() => makeChange(3, [2]));\n});\n\ntest('negative amounts are an error', () => {\n  assertThrows(() => makeChange(-1, [1]));\n});\n`);
    return code('javascript', {
      instructions: `## The change-making kata\n\nBuild \`makeChange(amount, coins)\` test-first. It returns the coins (largest first) that make **amount** pesewas with the **fewest** coins, for coin sets like **${coins.join(', ')}**, given in **any order**. Zero gives \`[]\`; a negative or non-whole amount, or an amount that cannot be made exactly, throws an error.\n\nWrite at least **6** tests with the helpers, then implement until they pass. The check also runs your tests on five buggy versions; each must fail at least one test.\n\nFor example, ${amount} with these coins is ${JSON.stringify(expected)}.`,
      hints: ['Sort a copy of the coins from largest to smallest; do not assume the caller did.', 'Greedy (always take the largest coin that fits) is fewest-coins for these coin sets.', 'Test the edges: 0, a repeated coin, an impossible amount, a negative amount.'],
      starter,
      checks: [
        { type: 'code.script', label: 'Your tests pass on a correct version and catch every buggy one', script: jsMutationCheck('makeChange', 6, fn, mutants) },
        { type: 'code.function', label: 'Your makeChange is correct', name: 'makeChange', cases: [{ args: [amount, coins], expected }, { args: [amount, shuffled], expected }, { args: [0, coins], expected: [] }] },
      ],
      solution,
      realityNote: 'Katas are short exercises repeated to practise a technique; the change-making kata is a favourite in coding dojos because greedy looks right until the edge cases.',
    });
  }),
];
