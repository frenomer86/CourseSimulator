import { describe, expect, it } from 'vitest';
import { buildSystem, findRepo, headCommit, loadGit, makeCtx, runLines } from './index.js';
import { forgeFiles } from './forge-seed.js';
import { blobId } from './git-state.js';

const IDENTITY = ['git config --global user.name "Ama Mensah"', 'git config --global user.email ama@example.com'];
const box = () =>
  buildSystem({
    hostname: 'dev',
    user: 'ama',
    packages: { git: { installed: true }, make: { installed: true }, act: { installed: true }, docker: { installed: true } },
    services: { docker: { active: true, enabled: true } },
    files: { '/home/ama/shop/fees.txt': 'Tuition: 2500\nHostel: 900\nLibrary: 50\n' },
  });
const state = (sys: ReturnType<typeof box>, dir = '/home/ama/shop') => loadGit(makeCtx(sys), findRepo(makeCtx(sys), dir)!);

describe('git object model', () => {
  it('uses real object ids', () => {
    expect(blobId('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const sys = box();
    const out = runLines(sys, [...IDENTITY, 'cd shop', 'echo hello > hi.txt', 'git hash-object hi.txt', 'git init -q', 'git add .', 'git commit -qm "Add fees"', 'git cat-file -t HEAD', 'git ls-tree HEAD']);
    expect(out).toMatch(/ce013625030ba8dba906f756967f9e9ca394464a\n/);
    expect(out).toMatch(/\ncommit\n/);
    expect(out).toMatch(/100644 blob ce013625030ba8dba906f756967f9e9ca394464a\thi.txt/);
  });
});

describe('git history tools', () => {
  it('stashes, resets and recovers a commit from the reflog', () => {
    const sys = box();
    const out = runLines(sys, [...IDENTITY, 'cd shop', 'git init -q', 'git add .', 'git commit -qm "Add fees"', 'echo "Exam: 100" >> fees.txt', 'echo x > new.txt', 'git stash -u', 'git status --short', 'git stash pop', 'git add . && git commit -qm "Exam fee"', 'git reset --hard HEAD~1', 'git reflog', 'git reset --hard HEAD@{1}', 'git log --oneline']);
    expect(out).toMatch(/Saved working directory and index state WIP on main/);
    expect(out).toMatch(/Dropped refs\/stash@\{0\}/);
    expect(out).toMatch(/HEAD@\{1\}: commit: Exam fee/);
    expect(out).toMatch(/\(HEAD -> main\) Exam fee\n[0-9a-f]{7} Add fees/);
  });

  it('squashes a fixup with an interactive rebase and keeps untouched commits', () => {
    const sys = box();
    runLines(sys, [...IDENTITY, 'cd shop', 'git init -q', 'git add .', 'git commit -qm "Add fees"', 'echo 1 >> fees.txt', 'git commit -qam "Add line"', 'echo 2 >> fees.txt', 'git commit -qam "fixup! Add line"']);
    const before = state(sys);
    const root = Object.values(before.commits).find((c) => !c.parents.length)!.id;
    const out = runLines(sys, ['cd shop', 'GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash HEAD~2', 'git log --oneline']);
    expect(out).toMatch(/Successfully rebased and updated refs\/heads\/main/);
    const st = state(sys);
    const head = st.commits[headCommit(st)!];
    expect(head.message).toBe('Add line');
    expect(head.parents[0]).toBe(root);
    expect(head.tree['fees.txt']).toMatch(/1\n2\n$/);
  });

  it('marks a conflict with diff3 regions and finds the first bad commit with bisect run', () => {
    const sys = box();
    const out = runLines(sys, [
      ...IDENTITY,
      'cd shop',
      'git init -q',
      'git add . && git commit -qm "Add fees"',
      'git tag -a v1.0.0 -m "First release"',
      'git switch -c board',
      "sed -i 's/Tuition: 2500/Tuition: 2600/' fees.txt",
      'git commit -qam "Board rate"',
      'git switch main',
      "sed -i 's/Tuition: 2500/Tuition: 2550/' fees.txt",
      'git commit -qam "Bursar rate"',
      'git merge board',
      'git status --short',
      "printf 'Tuition: 2600\\nHostel: 900\\nLibrary: 50\\n' > fees.txt",
      'git add fees.txt',
      'git commit --no-edit',
      'git log --oneline --graph',
      'for i in 1 2 3 4 5; do echo "Line $i" >> log.txt; git add log.txt; git commit -qm "Log $i"; done',
      "sed -i 's/Line 2/BROKEN/' log.txt; git commit -qam \"Tidy log\"",
      'echo "Line 6" >> log.txt; git commit -qam "Log 6"',
      'git bisect start HEAD v1.0.0',
      "git bisect run sh -c '! grep -q BROKEN log.txt'",
      'git bisect reset',
      'git describe',
    ]);
    expect(out).toMatch(/CONFLICT \(content\): Merge conflict in fees.txt/);
    expect(out).toMatch(/\nUU fees.txt\n/);
    expect(out).toMatch(/\*   [0-9a-f]{7} \(HEAD -> main\) Merge branch 'board'\n\|\\\n\* \| [0-9a-f]{7} Bursar rate\n\| \* [0-9a-f]{7} \(board\) Board rate\n\|\/\n/);
    expect(out).toMatch(/[0-9a-f]{40} is the first bad commit[\s\S]*Tidy log/);
    expect(out).toMatch(/v1\.0\.0-10-g[0-9a-f]{7}/);
  });
});

describe('git remotes and hooks', () => {
  it('rejects a push that is behind, refuses to guess on a divergent pull, and runs server hooks', () => {
    const sys = box();
    const out = runLines(sys, [
      ...IDENTITY,
      'git init -q --bare /home/ama/srv/shop.git',
      'cd shop',
      'git init -q',
      'git add . && git commit -qm "Add fees"',
      'git remote add origin /home/ama/srv/shop.git',
      'git push -u origin main',
      'cd ~',
      'git clone -q srv/shop.git copy',
      'cd copy',
      'echo "Exam: 100" >> fees.txt; git commit -qam "Exam fee"',
      'git push',
      'cd ~/shop',
      "sed -i 's/Tuition: 2500/Tuition: 2600/' fees.txt; git commit -qam \"Tuition\"",
      'git push',
      'git pull',
      'git pull --rebase',
      'git push',
      'git log --oneline',
    ]);
    expect(out).toMatch(/! \[rejected\]\s+main -> main \(fetch first\)/);
    expect(out).toMatch(/fatal: Need to specify how to reconcile divergent branches/);
    expect(out).toMatch(/Successfully rebased and updated refs\/heads\/main/);
    expect(out).toMatch(/[0-9a-f]{7} \(HEAD -> main, origin\/main\) Tuition\n[0-9a-f]{7} Exam fee\n[0-9a-f]{7} Add fees/);
    const hooks = runLines(sys, [
      'cd ~',
      "printf '#!/bin/sh\\nwhile read old new ref; do git merge-base --is-ancestor \"$old\" \"$new\" || { echo \"no rewriting $ref\"; exit 1; }; done\\n' > srv/shop.git/hooks/pre-receive",
      'chmod +x srv/shop.git/hooks/pre-receive',
      'cd shop',
      'git commit -q --amend -m "Tuition 2600"',
      'git push --force',
    ]);
    expect(hooks).toMatch(/remote: no rewriting refs\/heads\/main/);
    expect(hooks).toMatch(/! \[remote rejected\] main -> main \(pre-receive hook declined\)/);
  });

  it('makes a shallow clone over file:// and deepens it', () => {
    const sys = box();
    const out = runLines(sys, [...IDENTITY, 'cd shop', 'git init -q', 'git add . && git commit -qm "One"', 'echo a >> fees.txt; git commit -qam "Two"', 'cd ~', 'git clone -q --depth 1 file:///home/ama/shop thin', 'cd thin', 'git log --oneline | wc -l', 'git rev-parse --is-shallow-repository', 'git fetch -q --unshallow', 'git log --oneline | wc -l']);
    expect(out).toContain('1\ntrue\n2\n');
  });
});

const CI = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check fees
        run: grep -qv '^Bad' fees.txt && ! grep -q '^Bad' fees.txt
`;

function forgeBox() {
  const files = forgeFiles({
    users: { ama: { name: 'Ama Mensah', email: 'ama@example.com' }, kofi: { name: 'Kofi Boateng', email: 'kofi@example.com' } },
    repos: {
      'team/fees': {
        members: { ama: 'write', kofi: 'write' },
        commits: [{ message: 'Add fees and CI', author: 'Kofi Boateng', email: 'kofi@example.com', files: { 'fees.txt': 'Tuition: 2500\n', '.github/workflows/ci.yml': CI } }],
        protection: { main: { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['test'] } } },
        clones: { ama: '' },
      },
    },
  });
  return buildSystem({ hostname: 'pc', user: 'ama', users: { ama: {}, kofi: {} }, packages: { git: { installed: true }, gh: { installed: true } }, files: files as never });
}

describe('lab forge', () => {
  it('protects main, runs CI on a pull request and merges after review', () => {
    const sys = forgeBox();
    const out = runLines(sys, [
      'cd ~/fees',
      'echo "Exam: 100" >> fees.txt; git commit -qam "Add exam fee"',
      'git push',
      'git switch -c exam-fee',
      'git branch -f main origin/main',
      'git push -u origin exam-fee',
      'gh pr create --fill',
      'gh pr checks',
      'gh pr merge --squash',
    ]);
    expect(out).toMatch(/GH006: Protected branch update failed for refs\/heads\/main/);
    expect(out).toMatch(/https:\/\/git\.lab\/team\/fees\/pull\/1/);
    expect(out).toMatch(/✓  CI\/test/);
    expect(out).toMatch(/1 approving review is required/);
    const review = runLines(sys, ['su - kofi', 'cd /tmp && git clone -q git@git.lab:team/fees.git && cd fees', 'gh pr review 1 --approve', 'exit']);
    expect(review).toMatch(/✓ Approved pull request team\/fees#1/);
    const merged = runLines(sys, ['cd ~/fees', 'gh pr merge 1 --squash --delete-branch', 'git log --oneline -1', 'gh run list']);
    expect(merged).toMatch(/✓ Squashed and merged pull request team\/fees#1 \(Add exam fee\)/);
    expect(merged).toMatch(/\(HEAD -> main, origin\/main, origin\/HEAD\) Add exam fee \(#1\)/);
    expect(merged).toMatch(/✓\s+Add exam fee \(#1\)\s+CI\s+main\s+push/);
  });

  it('refuses an SSH key it does not know', () => {
    const sys = forgeBox();
    expect(runLines(sys, ['rm ~/.ssh/id_ed25519*', 'git clone git@git.lab:team/fees.git x'])).toMatch(/git@git\.lab: Permission denied \(publickey\)/);
  });
});

describe('make and act', () => {
  it('rebuilds only what changed and reports a recipe indented with spaces', () => {
    const sys = box();
    const out = runLines(sys, [
      'mkdir -p ~/site/src && cd ~/site',
      "printf '<h1>Fees</h1>\\n' > src/index.html",
      "printf 'all: dist/index.html\\n\\ndist/%%: src/%%\\n\\t@mkdir -p dist\\n\\tcp $< $@\\n' > Makefile",
      'make',
      'make',
      'touch src/index.html',
      'make',
      "printf 'all:\\n        echo hi\\n' > Bad.mk",
      'make -f Bad.mk',
    ]);
    expect(out).toMatch(/cp src\/index.html dist\/index.html\n[\s\S]*Nothing to be done for 'all'[\s\S]*cp src\/index.html dist\/index.html/);
    expect(out).toMatch(/Bad\.mk:2: \*\*\* missing separator \(did you mean TAB instead of 8 spaces\?\)\.  Stop\./);
  });

  it('runs a workflow matrix locally with masked secrets', () => {
    const sys = box();
    const out = runLines(sys, [
      'mkdir -p ~/w/.github/workflows && cd ~/w',
      "printf 'on: [push]\\njobs:\\n  build:\\n    runs-on: ubuntu-latest\\n    strategy:\\n      matrix:\\n        n: [1, 2]\\n    steps:\\n      - run: echo \"n=${{ matrix.n }} token=${{ secrets.TOKEN }}\"\\n' > .github/workflows/b.yml",
      'act --secret TOKEN=abc123',
    ]);
    expect(out).toMatch(/\[b\.yml\/build \(1\)\]\s+\| n=1 token=\*\*\*/);
    expect(out).toMatch(/\[b\.yml\/build \(2\)\] 🏁  Job succeeded/);
  });
});
