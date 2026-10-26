/** Unit 6: continuous integration pipelines. */

import type { TaskTemplate } from '../types';
import type { Org, Person, Variant } from './kit';
import type { Protection } from '@cslab/engine-shell/src/forge-seed';
import { C, ORGS, caseStudy, file, forge, fuser, lab, out, owned, tmpl, withForge, write } from './kit';

/** A small shell project with lint, test, build and deps targets, used by the CI labs. */
function project(v: Variant, o: Org, opts: { bug?: boolean } = {}) {
  const rate = v.pick([1, 2, 3]);
  const free = v.pick([50, 100]);
  const ver = `1.${v.int(0, 9)}.${v.int(0, 9)}`;
  const amount = free + v.pick([100, 200, 400]);
  const fee = (amount * rate) / 100;
  const app = `#!/bin/bash\n# Prints the transfer fee (GHS) for an amount.\nset -euo pipefail\namount="\${1:?usage: app.sh AMOUNT}"\nif [ "$amount" -le ${free} ]; then\n  echo 0\nelse\n  echo "$(( amount * ${opts.bug ? rate + 1 : rate} / 100 ))"\nfi\n`;
  const test = `#!/bin/bash\n# Runs the app on known amounts and compares the answers.\nset -euo pipefail\nprofile="\${1:-dev}"\nfail=0\ncheck() {\n  got="$(./app.sh "$1")"\n  if [ "$got" = "$2" ]; then echo "ok   $1 -> $2 ($profile)"; else echo "FAIL $1: expected $2, got $got"; fail=1; fi\n}\ncheck 10 0\ncheck ${free} 0\ncheck ${amount} ${Math.floor(fee)}\nexit "$fail"\n`;
  const mk = `VERSION := $(shell cat VERSION)\n\n.PHONY: lint test build deps clean\n\nlint:\n\tshellcheck app.sh tests/run.sh\n\ntest:\n\t./tests/run.sh $(PROFILE)\n\nbuild:\n\tmkdir -p dist\n\ttar -czf dist/app-$(VERSION).tar.gz app.sh VERSION\n\t@echo "built dist/app-$(VERSION).tar.gz"\n\ndeps:\n\t@if [ -d "$$HOME/.cache/deps" ]; then echo "deps already cached"; else mkdir -p "$$HOME/.cache/deps" && cp deps.lock "$$HOME/.cache/deps/" && echo "downloaded deps"; fi\n\nclean:\n\trm -rf dist\n`;
  return {
    ver,
    rate,
    free,
    amount,
    files: { 'app.sh': app, 'tests/run.sh': test, Makefile: mk, VERSION: `${ver}\n`, 'deps.lock': 'shellcheck==0.10.0\nbats==1.11.0\n', 'README.md': `# ${o.project}\n\nRun \`make test\`.\n` },
    exec: ['app.sh', 'tests/run.sh'],
  };
}

const WF = (body: string) => `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n${body}`;
const CHECKOUT = '      - uses: actions/checkout@v4\n';

/** A forge with the learner's team repository holding the CI project, cloned in ~/<project>. */
function ciLab(v: Variant, o: Org, me: Person, extra: Record<string, string>, opts: { bug?: boolean; protection?: Record<string, Protection>; allowAutoMerge?: boolean; members?: Record<string, 'write'>; mates?: Person[] } = {}) {
  const p = project(v, o, { bug: opts.bug });
  const full = `${o.org}/${o.project}`;
  const users: Record<string, ReturnType<typeof fuser>> = { [me.sam]: fuser(me, o) };
  for (const m of opts.mates ?? []) users[m.sam] = fuser(m, o);
  return {
    p,
    full,
    state: withForge({ me, org: o, packages: ['make', 'shellcheck'], seed: { users, repos: { [full]: { commits: [C('Initial project', me, o, { ...p.files, ...extra })], seed: { executable: p.exec }, clones: { [me.sam]: '' }, protection: opts.protection, allowAutoMerge: opts.allowAutoMerge, members: opts.members } } } }),
  };
}

export const U6: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 6.1 CI principles */
  tmpl(6, 1, 'beginner', 'ci-principles', 'Apply the principles of continuous integration', 'E10', 15, 'Decide how a team should integrate, build and react to a red build.', (v) => {
    const o = v.pick(ORGS);
    const n = v.int(4, 9);
    return caseStudy(v, {
      intro: `## Integration day\n\n${o.org}'s ${n} developers each work on a branch for two or three weeks, then spend a painful "integration day" merging everything. Tests are run by hand before releases. You are introducing continuous integration (CI).`,
      steps: [
        { title: 'How often to integrate', text: 'How long should work stay on a branch?', choices: [{ text: 'Integrate to main at least daily, in small changes', right: true, feedback: 'Correct. CI means integrating continuously: small, frequent merges keep conflicts small.' }, { text: 'Keep three-week branches but run CI on them', feedback: 'CI on long branches still defers integration pain.' }, { text: 'Merge only at release time', feedback: 'That is the integration day you are replacing.' }] },
        { title: 'What runs on every push', text: 'A push arrives.', choices: [{ text: 'An automated build and the test suite, with the result reported back to the commit or pull request', right: true, feedback: 'Correct. Every change is verified automatically, every time.' }, { text: 'Nothing; a nightly build is enough', feedback: 'A nightly build finds problems up to a day late, mixed with everyone else\'s changes.' }, { text: 'Only the tests the author thinks are relevant', feedback: 'Then breakages elsewhere slip through.' }] },
        { title: 'Speed', text: 'The full suite takes 50 minutes.', choices: [{ text: 'Make the main pipeline fast (aim for about 10 minutes): fast tests first, slow suites in parallel or later stages', right: true, feedback: 'Correct. Slow feedback leads people to batch changes and ignore results.' }, { text: 'Run it only once a week', feedback: 'Defeats the point of continuous feedback.' }, { text: 'Accept 50 minutes; correctness matters more', feedback: 'Both matter: restructure the suite instead.' }] },
        { title: 'Main goes red', text: 'A merged change broke the build on main.', choices: [{ text: 'Fixing main is the top priority: fix forward quickly or revert the change; nobody piles more changes on a red build', right: true, feedback: 'Correct. A broken main blocks everyone and hides further breakage.' }, { text: 'Keep merging; it will be fixed eventually', feedback: 'Every merge on red makes the cause harder to find.' }, { text: 'Disable the failing test', feedback: 'That hides the problem instead of fixing it.' }] },
        { title: 'Where the pipeline lives', text: 'Who defines the build steps?', choices: [{ text: 'A workflow file in the repository, reviewed and versioned like code', right: true, feedback: 'Correct. Pipeline as code changes together with the code it builds.' }, { text: 'Settings clicked into a web console by one admin', feedback: 'Unreviewed, unversioned, and lost when that admin leaves.' }, { text: 'Each developer\'s own script', feedback: 'Then "works on my machine" returns.' }] },
      ],
      ending: { title: 'Integrate continuously', text: 'Small changes merged daily, every push built and tested quickly, a red main fixed first, and the pipeline kept as code.' },
      hints: ['Continuous integration is a practice before it is a tool.', 'Think about what happens to the team when main is broken.'],
      realityNote: 'Martin Fowler\'s article "Continuous Integration" sets out these practices; GitHub Actions, GitLab CI and Jenkins are tools that support them.',
    });
  }),
  tmpl(6, 1, 'intermediate', 'first-workflow', 'Write a first CI workflow', 'E4', 25, 'Add a workflow that lints and tests on every push and pull request, and see it pass on the forge.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { full, state } = ciLab(v, o, me, {});
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - name: Lint\n        run: make lint\n      - name: Test\n        run: make test\n`);
    return {
      instructions: lab({
        situation: `**${full}** (cloned at ~/${o.project}) has \`make lint\` and \`make test\` but no CI. Add **.github/workflows/ci.yml**, a workflow named **CI** that runs on **pushes to main** and on **pull requests**, with one job **test** on ubuntu-latest that checks out the code, runs \`make lint\`, then \`make test\`. Commit and push to main, then check the run on the forge.`,
        steps: ['mkdir -p .github/workflows', 'Write ci.yml (name, on: push/pull_request, jobs: test: runs-on, steps)', 'git add .github && git commit -m "Add CI" && git push', 'gh run list; gh run view'],
        tips: [WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: make lint\n`), 'gh run list', 'gh run view --log'],
      }),
      hints: ['YAML is indentation-sensitive: steps is a list (lines start with "- ").', 'actions/checkout puts the repository in the runner first; without it, make finds no Makefile.'],
      initialState: state,
      checks: [
        file('The workflow file exists', `${home}/${o.project}/.github/workflows/ci.yml`, { contains: ['pull_request', 'make lint', 'make test', 'actions/checkout'] }),
        forge('CI ran on the latest commit of main and passed', full, { run: { workflow: 'CI', event: 'push', headOfBranch: 'main', conclusion: 'success', jobs: ['test'] } }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/ci.yml', wf), 'git add .github && git commit -q -m "Add CI" && git push', 'gh run list', 'gh run view'],
      realityNote: 'This is a complete GitHub Actions workflow; GitLab CI, Gitea Actions and Forgejo use the same ideas (and Gitea and Forgejo accept this exact file).',
    };
  }),
  tmpl(6, 1, 'advanced', 'fix-the-build', 'Fix a red build on main', 'E4', 25, 'Read a failing run\'s log, find the bug it reveals, fix it and get main green again.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make lint\n      - run: make test\n`);
    const { p, full, state } = ciLab(v, o, me, { '.github/workflows/ci.yml': wf }, { bug: true });
    return {
      instructions: lab({
        situation: `CI on main of **${full}** is red. Find out why from the forge (not by guessing), fix the cause in your clone ~/${o.project}, push, and confirm the next run on main passes. The business rule: no fee up to GHS ${p.free}, then **${p.rate}%** of the amount.`,
        steps: ['gh run list', 'gh run view --log-failed', 'Compare the failing check with the rule; fix app.sh', 'make test (locally first)', 'git commit -am "..." && git push', 'gh run list'],
        tips: ['gh run list', 'gh run view RUN_ID --log-failed', 'make test'],
      }),
      hints: ['The log shows which amount failed and what the test expected.', 'Run the same command locally before pushing: make test.'],
      initialState: state,
      checks: [
        forge('The latest commit on main passes CI', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success' } }),
        out('The fee rule is right', `cd ${home}/${o.project} && ./app.sh ${p.amount}`, { equals: String(Math.floor((p.amount * p.rate) / 100)) }),
      ],
      solution: [`cd ~/${o.project} && gh run list`, 'gh run view --log-failed', `sed -i 's/\\* ${p.rate + 1} \\/ 100/* ${p.rate} \\/ 100/' app.sh`, 'make test', 'git commit -qam "Fix fee rate" && git push', 'gh run list'],
      realityNote: 'The first job of anyone on call for CI is exactly this: read the failing step\'s log, reproduce locally, fix forward or revert.',
    };
  }),

  /* ---------------------------------------------------------------- 6.2 workflows, jobs, steps, matrices, caching, secrets; GitLab CI compared */
  tmpl(6, 2, 'beginner', 'jobs-and-needs', 'Split a pipeline into dependent jobs', 'E4', 25, 'Write a workflow with a lint job and a test job that only runs after lint passes.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { full, state } = ciLab(v, o, me, {});
    const wf = WF(`  lint:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make lint\n  test:\n    needs: lint\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n`);
    return {
      instructions: lab({
        situation: `Add **.github/workflows/ci.yml** to **${full}** (clone: ~/${o.project}) with **two jobs**:\n\n- **lint** runs \`make lint\`;\n- **test** runs \`make test\` and must **wait for lint** (and not run if lint fails).\n\nEach job is a fresh machine, so each checks out the code. Push to main and check that both jobs passed.`,
        steps: ['jobs: lint: ... test: needs: lint ...', 'Both jobs: runs-on: ubuntu-latest and a checkout step', 'git push; gh run view'],
        tips: ['needs: lint', 'gh run view (shows each job)', 'gh run view --log'],
      }),
      hints: ['Jobs run in parallel unless needs says otherwise.', 'Files from one job are not in the next: each job checks out again (or passes artifacts).'],
      initialState: state,
      checks: [
        file('test needs lint', `${home}/${o.project}/.github/workflows/ci.yml`, { pattern: '^\\s+needs:\\s*\\[?\\s*lint' }),
        forge('Both jobs ran and passed on main', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', jobs: ['lint', 'test'] } }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/ci.yml', wf), 'git add .github && git commit -q -m "Add lint and test jobs" && git push', 'gh run view'],
      realityNote: 'Jobs and needs form a directed graph; real pipelines fan out (parallel tests) and fan in (deploy after all pass).',
    };
  }),
  tmpl(6, 2, 'intermediate', 'matrix-and-cache', 'Test across a matrix and cache dependencies', 'E4', 30, 'Run tests for two profiles with a matrix, and cache downloaded dependencies between runs.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const profiles = v.pick([['dev', 'prod'], ['staging', 'prod'], ['dev', 'ci']]);
    const { full, state } = ciLab(v, o, me, {});
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        profile: [${profiles.join(', ')}]\n    steps:\n${CHECKOUT}      - uses: actions/cache@v4\n        with:\n          path: ~/.cache/deps\n          key: deps-\${{ hashFiles('deps.lock') }}\n      - run: make deps\n      - run: make test PROFILE=\${{ matrix.profile }}\n`);
    return {
      instructions: lab({
        situation: `In **${full}** (clone ~/${o.project}), write **.github/workflows/ci.yml** with a job **test** that:\n\n1. runs for each profile in a **matrix**: **${profiles.join('** and **')}** (\`make test PROFILE=<profile>\`);\n2. restores and saves **~/.cache/deps** with **actions/cache**, keyed on the **hash of deps.lock** (\`deps-\${{ hashFiles('deps.lock') }}\`), before \`make deps\`.\n\nPush, then push a **second** commit (any small change): the second run must **restore the cache** instead of downloading.`,
        steps: ['strategy: matrix: profile: [...]', "uses: actions/cache@v4 with path and key: deps-${{ hashFiles('deps.lock') }}", 'run: make deps, then make test PROFILE=${{ matrix.profile }}', 'Push twice; gh run view --log | grep -i cache'],
        tips: ['${{ matrix.profile }}', "hashFiles('deps.lock')", 'gh run view --log'],
      }),
      hints: ['A matrix copies the job once per value: two profiles, two jobs.', 'The key changes only when deps.lock changes, so later runs reuse the cache.'],
      initialState: state,
      checks: [
        forge('Both matrix jobs pass on main', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', jobs: profiles.map((x) => `test (${x})`) } }),
        forge('The latest run restored the cache', full, { run: { workflow: 'CI', headOfBranch: 'main', log: 'Cache restored from key: deps-' } }),
        file('The cache key uses the lock file', `${home}/${o.project}/.github/workflows/ci.yml`, { pattern: "hashFiles\\(\\s*'deps\\.lock'\\s*\\)" }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/ci.yml', wf), 'git add .github && git commit -q -m "Test a matrix with a dependency cache" && git push', 'echo "CI runs for every profile." >> README.md', 'git commit -qam "Document CI" && git push', 'gh run view --log | grep -i cache'],
      realityNote: 'Real workflows cache package-manager folders (~/.npm, ~/.cache/pip, ~/.m2) keyed on lock-file hashes, cutting minutes from every run.',
    };
  }),
  tmpl(6, 2, 'advanced', 'from-gitlab-ci', 'Translate a GitLab CI pipeline to GitHub Actions', 'E4', 35, 'Port stages, variables, artifacts and a masked secret from .gitlab-ci.yml to a workflow.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const env = v.pick(['ci', 'test', 'build']);
    const token = `rt_${v.password().replace(/[^A-Za-z0-9]/g, '')}${v.int(1000, 9999)}`;
    const gl = `stages: [lint, test, build]\n\nvariables:\n  APP_ENV: ${env}\n\nlint:\n  stage: lint\n  script:\n    - make lint\n\ntest:\n  stage: test\n  script:\n    - make test\n\nbuild:\n  stage: build\n  script:\n    - test -n "$REGISTRY_TOKEN"\n    - make build\n  artifacts:\n    paths:\n      - dist/\n`;
    const { full, state } = ciLab(v, o, me, { '.gitlab-ci.yml': gl });
    const wf = `name: CI\non:\n  push:\n    branches: [main]\nenv:\n  APP_ENV: ${env}\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make lint\n  test:\n    needs: lint\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n  build:\n    needs: test\n    runs-on: ubuntu-latest\n    env:\n      REGISTRY_TOKEN: \${{ secrets.REGISTRY_TOKEN }}\n    steps:\n${CHECKOUT}      - run: test -n "$REGISTRY_TOKEN"\n      - run: make build\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist/\n`;
    return {
      instructions: lab({
        situation: `**${full}** is moving from GitLab to this forge. Read **.gitlab-ci.yml** in ~/${o.project} and write the equivalent **.github/workflows/ci.yml** (name **CI**, on pushes to main):\n\n- the three **stages** become jobs **lint**, **test** and **build** that run in that order;\n- the **variable** APP_ENV=${env} applies to the whole workflow;\n- **build** gets the masked secret **REGISTRY_TOKEN** as an environment variable, and uploads **dist/** as an artifact named **dist**.\n\nStore the secret on the forge first (value: \`${token}\`), push, and check the run. Remove .gitlab-ci.yml in the same commit.`,
        steps: [`gh secret set REGISTRY_TOKEN --body "${token}"`, 'stages → jobs chained with needs; variables → env at the top', 'env: REGISTRY_TOKEN: ${{ secrets.REGISTRY_TOKEN }} in the build job', 'artifacts: paths → actions/upload-artifact@v4 with name and path', 'git rm .gitlab-ci.yml; git add .github; git commit; git push'],
        tips: ['gh secret set NAME --body VALUE', 'needs: test', 'uses: actions/upload-artifact@v4'],
      }),
      hints: ['GitLab runs stages in order; in Actions you express the order with needs.', 'Secrets are never printed: the log shows *** instead.'],
      initialState: state,
      checks: [
        forge('The secret is stored on the forge', full, { secret: { name: 'REGISTRY_TOKEN', value: token } }),
        forge('lint, test and build passed, and build uploaded dist', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', jobs: ['lint', 'test', 'build'], artifact: 'dist' } }),
        file('The order and the variable are carried over', `${home}/${o.project}/.github/workflows/ci.yml`, { pattern: `APP_ENV:\\s*${env}[\\s\\S]*needs:\\s*\\[?\\s*lint[\\s\\S]*needs:\\s*\\[?\\s*test` }),
        file('The GitLab file is gone', `${home}/${o.project}/.gitlab-ci.yml`, { exists: false }),
      ],
      solution: [`cd ~/${o.project} && gh secret set REGISTRY_TOKEN --body "${token}"`, 'mkdir -p .github/workflows', write('.github/workflows/ci.yml', wf), 'git rm -q .gitlab-ci.yml', 'git add .github && git commit -q -m "Move CI to the forge" && git push', 'gh run view'],
      realityNote: 'GitLab stages, needs, variables, artifacts and masked variables map almost one to one onto Actions jobs, needs, env, upload-artifact and secrets.',
    };
  }),

  /* ---------------------------------------------------------------- 6.3 pipeline stages: lint, test, build, package, publish */
  tmpl(6, 3, 'beginner', 'upload-artifact', 'Build in CI and keep the result as an artifact', 'E4', 25, 'Add a build step that uploads the tarball, then download it from the run.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { p, full, state } = ciLab(v, o, me, {});
    const wf = WF(`  build:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make lint\n      - run: make test\n      - run: make build\n      - uses: actions/upload-artifact@v4\n        with:\n          name: app-tarball\n          path: dist/\n`);
    return {
      instructions: lab({
        situation: `Make CI in **${full}** produce something you can deploy. Write **.github/workflows/ci.yml** with a job **build** that lints, tests, runs \`make build\` and **uploads dist/** as an artifact named **app-tarball**. Push, then download the artifact from the run into **~/artifacts** and check the tarball is there.`,
        steps: ['steps: checkout, make lint, make test, make build, upload-artifact', 'git push; gh run list', 'gh run download RUN_ID -n app-tarball -D ~/artifacts', 'ls ~/artifacts'],
        tips: ['uses: actions/upload-artifact@v4\n  with:\n    name: app-tarball\n    path: dist/', 'gh run download RUN_ID -n NAME -D DIR'],
      }),
      hints: ['Artifacts are files a run keeps after the runner machine is thrown away.', 'Build once in CI and deploy that exact file, rather than rebuilding on the server.'],
      initialState: state,
      checks: [
        forge('The run uploaded app-tarball', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', artifact: 'app-tarball' } }),
        file('You downloaded the tarball', `${home}/artifacts/app-${p.ver}.tar.gz`, { contains: 'CSLAB-TAR' }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/ci.yml', wf), 'git add .github && git commit -q -m "Build and keep the tarball" && git push', 'run=$(gh run list -L 1 --json databaseId -q ".[0].databaseId")', 'gh run download "$run" -n app-tarball -D ~/artifacts', 'ls ~/artifacts'],
      realityNote: 'Build once, deploy the same artifact everywhere: rebuilding per environment risks shipping something different from what was tested.',
    };
  }),
  tmpl(6, 3, 'intermediate', 'release-on-tag', 'Build a release when a version tag is pushed', 'E4', 30, 'Trigger a build on tags, download its artifact, and publish it as a release.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const { p, full, state } = ciLab(v, o, me, {});
    const tag = `v${p.ver}`;
    const wf = `name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  package:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n      - run: make build\n      - uses: actions/upload-artifact@v4\n        with:\n          name: release\n          path: dist/\n`;
    return {
      instructions: lab({
        situation: `Releases of **${full}** should be built by CI, not on laptops. In ~/${o.project}:\n\n1. add **.github/workflows/release.yml** (name **Release**) that runs only when a tag matching **v*** is pushed, tests, builds, and uploads **dist/** as artifact **release**;\n2. commit it, then tag **${tag}** (VERSION says ${p.ver}) and push the tag;\n3. download the artifact and publish release **${tag}** with **app-${p.ver}.tar.gz** attached.`,
        steps: ["on: push: tags: ['v*']", 'git push (the workflow file), then git tag ' + tag + ' && git push origin ' + tag, 'gh run list --workflow Release', `gh run download RUN_ID -n release -D /tmp/rel; gh release create ${tag} /tmp/rel/app-${p.ver}.tar.gz --notes "..."`],
        tips: ["on:\n  push:\n    tags: ['v*']", 'gh run list -w Release', 'gh release create TAG FILE --notes TEXT'],
      }),
      hints: ['A tag filter alone means pushes to branches do not trigger this workflow.', 'Downloading the CI artifact means the release contains exactly what CI built and tested.'],
      initialState: state,
      checks: [
        forge('The tag push ran the Release workflow', full, { run: { workflow: 'Release', event: 'push', branch: tag, conclusion: 'success', artifact: 'release' } }),
        forge('The release has the CI-built tarball', full, { release: { tag, asset: `app-${p.ver}.tar.gz`, assetContains: 'CSLAB-TAR' } }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/release.yml', wf), 'git add .github && git commit -q -m "Build releases from tags" && git push', `git tag ${tag} && git push origin ${tag}`, 'run=$(gh run list -w Release -L 1 --json databaseId -q ".[0].databaseId")', 'gh run download "$run" -n release -D /tmp/rel', `gh release create ${tag} /tmp/rel/app-${p.ver}.tar.gz --notes "Release ${p.ver}"`],
      realityNote: 'Tag-triggered release workflows are standard; many go further and create the release from inside the workflow with the built-in token.',
    };
  }),
  tmpl(6, 3, 'advanced', 'verify-checksums', 'Publish checksums with the build and verify a download', 'E4', 30, 'Make CI produce SHA256SUMS next to the tarball, then verify what you download.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { p, full, state } = ciLab(v, o, me, {});
    const wf = WF(`  build:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n      - run: make build\n      - run: cd dist && sha256sum ./*.tar.gz > SHA256SUMS\n      - uses: actions/upload-artifact@v4\n        with:\n          name: dist\n          path: dist/\n`);
    return {
      instructions: lab({
        situation: `People download builds of **${full}** to install on servers; they need a way to check the file is intact. Make CI write **dist/SHA256SUMS** (with \`sha256sum\`, run inside dist/ so it lists bare file names) and upload **dist/** as artifact **dist**. Then download it to **~/dl**, verify with \`sha256sum -c\`, and save the verification output to **~/verify.txt**.`,
        steps: ['run: cd dist && sha256sum ./*.tar.gz > SHA256SUMS', 'upload-artifact name: dist, path: dist/', 'gh run download RUN_ID -n dist -D ~/dl', 'cd ~/dl && sha256sum -c SHA256SUMS > ~/verify.txt'],
        tips: ['sha256sum FILE > SHA256SUMS', 'sha256sum -c SHA256SUMS', 'gh run download RUN_ID -n NAME -D DIR'],
      }),
      hints: ['sha256sum -c prints "FILE: OK" for each file that matches.', 'Run sha256sum inside dist so the list holds bare file names that work wherever the files land.'],
      initialState: state,
      checks: [
        forge('CI produced the artifact', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', artifact: 'dist' } }),
        file('The checksum list came with it', `${home}/dl/SHA256SUMS`, { pattern: `^[0-9a-f]{64}  \\./app-${p.ver.replace(/\./g, '\\.')}\\.tar\\.gz$` }),
        file('The download verified', `${home}/verify.txt`, { equals: `./app-${p.ver}.tar.gz: OK` }),
      ],
      solution: [`cd ~/${o.project} && mkdir -p .github/workflows`, write('.github/workflows/ci.yml', wf), 'git add .github && git commit -q -m "Publish checksums" && git push', 'run=$(gh run list -L 1 --json databaseId -q ".[0].databaseId")', 'gh run download "$run" -n dist -D ~/dl', 'cd ~/dl && sha256sum -c SHA256SUMS > ~/verify.txt', 'cat ~/verify.txt'],
      realityNote: 'Checksums catch corrupted downloads; signing them (GPG, Sigstore cosign) also proves who built them, which is the next step in supply-chain security.',
    };
  }),

  /* ---------------------------------------------------------------- 6.4 status checks on pull requests; badges; notifications */
  tmpl(6, 4, 'beginner', 'required-checks', 'Make a passing check a merge requirement', 'E4', 30, 'Require the test check on main, watch it block a failing pull request, fix and merge.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n`);
    const { p, full, state } = ciLab(v, o, me, { '.github/workflows/ci.yml': wf });
    const json = '{"required_status_checks":{"strict":false,"contexts":["test"]},"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null}';
    return {
      instructions: lab({
        situation: `In **${full}** (clone ~/${o.project}), protect **main** so that the **test** check must pass before merging (no reviews needed; include admins). Then prove it:\n\n1. on branch **raise-rate**, change the rate in app.sh from ${p.rate}% to ${p.rate + 1}% **without** updating the tests, push and open a pull request: CI fails and the merge is refused;\n2. the finance team then confirms the old rate was right after all: change it back, push, and merge with a merge commit once the check is green.`,
        steps: [`gh api -X PUT repos/${full}/branches/main/protection --input FILE.json`, 'git switch -c raise-rate; edit app.sh; commit; push -u; gh pr create --fill', 'gh pr checks; gh pr merge --merge (refused)', 'Change it back; commit; push; gh pr checks; gh pr merge --merge'],
        tips: [json, 'gh pr checks', 'gh pr merge --merge'],
      }),
      hints: ['A required check name is the job name (here: test).', 'New pushes to the branch rerun the checks on the pull request.'],
      initialState: state,
      checks: [
        forge('main requires the test check', full, { protection: { branch: 'main', checks: ['test'] } }),
        forge('A failing run was recorded on the pull request', full, { run: { event: 'pull_request', branch: 'raise-rate', anyLog: 'FAIL' } }),
        forge('The pull request was merged after the check passed', full, { pr: { head: 'raise-rate', state: 'MERGED', merged: 'merge' } }),
      ],
      solution: [`cd ~/${o.project} && echo '${json}' > /tmp/protect.json`, `gh api -X PUT repos/${full}/branches/main/protection --input /tmp/protect.json`, 'git switch -c raise-rate', `sed -i 's/\\* ${p.rate} \\/ 100/* ${p.rate + 1} \\/ 100/' app.sh`, 'git commit -qam "Raise the rate" && git push -u origin raise-rate', 'gh pr create --fill', 'gh pr checks', 'gh pr merge --merge', `sed -i 's/\\* ${p.rate + 1} \\/ 100/* ${p.rate} \\/ 100/' app.sh`, 'git commit -qam "Keep the agreed rate" && git push', 'gh pr checks', 'gh pr merge --merge'],
      realityNote: 'Required status checks are what turn CI from advice into a gate; most teams require them on every protected branch.',
    };
  }),
  tmpl(6, 4, 'intermediate', 'badge-and-alerts', 'Add a status badge and failure notices', 'E4', 25, 'Show CI status in the README and make failed runs leave a clear error annotation and summary.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { full, state } = ciLab(v, o, me, {});
    const badge = `![CI](https://git.lab/${full}/actions/workflows/ci.yml/badge.svg)`;
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n      - name: Summary\n        run: echo "### Tests passed on \${{ github.ref_name }}" >> "$GITHUB_STEP_SUMMARY"\n      - name: Report failure\n        if: failure()\n        run: echo "::error::Tests failed on \${{ github.ref_name }}"\n`);
    return {
      instructions: lab({
        situation: `Make CI status visible in **${full}** (clone ~/${o.project}):\n\n1. put the badge \`${badge}\` as the **second line** of README.md;\n2. write **.github/workflows/ci.yml** (job **test**, runs \`make test\`) with a step that adds a line to the **job summary** (\`$GITHUB_STEP_SUMMARY\`), and a step that runs **only when an earlier step failed** and prints an **error annotation** \`::error::Tests failed on <branch>\` using \`\${{ github.ref_name }}\`.\n\nPush to main.`,
        steps: ['sed -i "1a ' + badge + '" README.md (or edit it)', 'echo "### ..." >> "$GITHUB_STEP_SUMMARY"', 'if: failure()', 'echo "::error::Tests failed on ${{ github.ref_name }}"'],
        tips: ['if: failure()', '::error::message', '$GITHUB_STEP_SUMMARY'],
      }),
      hints: ['Steps normally stop at the first failure; if: failure() runs a step only in that case.', 'Workflow commands like ::error:: become annotations on the run.'],
      initialState: state,
      checks: [
        out('The badge is on the second line', `cd ${home}/${o.project} && git show main:README.md | sed -n 2p`, { equals: badge }),
        file('A failure-only error annotation step', `${home}/${o.project}/.github/workflows/ci.yml`, { pattern: 'if:\\s*\\$?\\{?\\{?\\s*failure\\(\\)[\\s\\S]*::error::' }),
        file('A job summary step', `${home}/${o.project}/.github/workflows/ci.yml`, { contains: 'GITHUB_STEP_SUMMARY' }),
        forge('CI passes on main', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success' } }),
      ],
      solution: [`cd ~/${o.project}`, write('README.md', `# ${o.project}\n${badge}\n\nRun \`make test\`.\n`), 'mkdir -p .github/workflows', write('.github/workflows/ci.yml', wf), 'git add -A && git commit -q -m "Add CI badge and failure notices" && git push', 'gh run view'],
      realityNote: 'Badges, annotations and job summaries are how GitHub-style forges surface CI results; chat and e-mail notifications hang off the same events.',
    };
  }),
  tmpl(6, 4, 'advanced', 'auto-merge', 'Let a pull request merge itself when checks pass', 'E4', 30, 'Enable auto-merge, queue a failing pull request, fix it, and let the forge merge it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const wf = WF(`  test:\n    runs-on: ubuntu-latest\n    steps:\n${CHECKOUT}      - run: make test\n`);
    const { p, full, state } = ciLab(v, o, me, { '.github/workflows/ci.yml': wf }, { protection: { main: { required_status_checks: { contexts: ['test'] } } } });
    return {
      instructions: lab({
        situation: `main of **${full}** requires the **test** check. Instead of waiting for CI before merging:\n\n1. enable **auto-merge** for the repository;\n2. on branch **docs-and-check**, add a fourth check to tests/run.sh, \`check ${p.free + 1} ${Math.floor(((p.free + 1) * p.rate) / 100) + 1}\`, which is **wrong** on purpose; push and open a pull request;\n3. queue it with \`gh pr merge --auto --squash\` (it waits because the check fails);\n4. correct the expected value to ${Math.floor(((p.free + 1) * p.rate) / 100)} and push: the forge merges it by itself.`,
        steps: ['gh repo edit --enable-auto-merge', 'git switch -c docs-and-check; edit tests/run.sh; commit; push -u; gh pr create --fill', 'gh pr merge --auto --squash', 'fix the expected value; commit; push', 'gh pr view (state: merged)'],
        tips: ['gh repo edit --enable-auto-merge', 'gh pr merge --auto --squash', 'gh pr view'],
      }),
      hints: ['Auto-merge waits for every requirement (checks, reviews) and then merges.', 'You do not need to watch CI; the next green run triggers the merge.'],
      initialState: state,
      checks: [
        forge('The pull request merged itself as a squash', full, { pr: { head: 'docs-and-check', state: 'MERGED', merged: 'squash' } }),
        forge('main has the corrected check', full, { branch: { name: 'main', file: { path: 'tests/run.sh', contains: `check ${p.free + 1} ${Math.floor(((p.free + 1) * p.rate) / 100)}\n` } } }),
      ],
      solution: [`cd ~/${o.project} && gh repo edit --enable-auto-merge`, 'git switch -c docs-and-check', `sed -i 's/^exit "\\$fail"/check ${p.free + 1} ${Math.floor(((p.free + 1) * p.rate) / 100) + 1}\\nexit "$fail"/' tests/run.sh`, 'git commit -qam "Check the first charged amount" && git push -u origin docs-and-check', 'gh pr create --fill', 'gh pr merge --auto --squash', `sed -i 's/^check ${p.free + 1} .*/check ${p.free + 1} ${Math.floor(((p.free + 1) * p.rate) / 100)}/' tests/run.sh`, 'git commit -qam "Correct the expected fee" && git push', 'gh pr view'],
      realityNote: 'Auto-merge and merge queues let busy repositories keep main green without people babysitting CI.',
    };
  }),

  /* ---------------------------------------------------------------- 6.5 reproducible builds, pinning, supply chain */
  tmpl(6, 5, 'beginner', 'supply-chain', 'Weigh supply-chain risks in a pipeline', 'E10', 15, 'Judge pinned and unpinned actions, lock files and third-party scripts in CI.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## What does our build trust?\n\n${o.org}'s pipeline uses third-party actions by tag (\`some-org/deploy@v2\`), installs packages without a lock file, and runs \`curl https://example.org/install.sh | bash\`. A well-known attack recently replaced a popular action's tag with malicious code.`,
      steps: [
        { title: 'Actions by tag', text: 'A tag like v2 can be moved to point at different code.', choices: [{ text: 'Pin third-party actions to a full commit SHA (with the version in a comment) and update them deliberately', right: true, feedback: 'Correct. A SHA cannot be moved; the comment keeps it readable.' }, { text: 'Use @main to always get fixes', feedback: 'You also always get whatever was pushed, malicious or broken.' }, { text: 'Tags are signed, so they are safe', feedback: 'Git tags can be re-pointed by whoever controls the repository.' }] },
        { title: 'Dependencies', text: 'Packages are installed at whatever version is newest.', choices: [{ text: 'Commit a lock file with exact versions and hashes, and update it through reviewed pull requests', right: true, feedback: 'Correct. Builds become repeatable and a surprise new version cannot slip in.' }, { text: 'Install the newest version for security fixes', feedback: 'Updates should arrive by review, not silently mid-build.' }, { text: 'Copy the packages into the repository by hand', feedback: 'Vendoring can work, but by hand nobody can audit or update it.' }] },
        { title: 'curl | bash', text: 'The install script is fetched live from another site.', choices: [{ text: 'Download a specific version, check its published checksum, then run it (or use a package)', right: true, feedback: 'Correct. You run code you have verified, not whatever the server sends today.' }, { text: 'Fine if the site uses HTTPS', feedback: 'HTTPS protects the transfer, not the content the server chooses to send.' }, { text: 'Run it as root to avoid permission errors', feedback: 'That gives an unverified script full control.' }] },
        { title: 'Secrets in CI', text: 'The deploy key is a repository secret.', choices: [{ text: 'Limit it to the job and branch that deploy, and do not expose secrets to pull requests from forks', right: true, feedback: 'Correct. Least privilege limits what a compromised step can reach.' }, { text: 'Print it in a debug step to check it works', feedback: 'Masking is best effort; never print secrets.' }, { text: 'Give every job every secret for simplicity', feedback: 'Every step then becomes a way to steal them.' }] },
      ],
      ending: { title: 'Trust deliberately', text: 'Pin actions to SHAs, lock dependencies, verify downloaded tools, and scope secrets to where they are needed.' },
      hints: ['Ask which parts of the build can change without anyone in your team reviewing them.', 'A name (tag, latest) can move; a hash cannot.'],
      realityNote: 'The 2025 tj-actions/changed-files compromise re-pointed version tags to code that dumped CI secrets; SHA-pinned workflows were not affected.',
    });
  }),
  tmpl(6, 5, 'intermediate', 'pin-actions', 'Pin every action to a commit SHA', 'E4', 25, 'Replace tag and branch references to actions with full commit SHAs and keep the workflow working.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const pins: Array<[string, string, string]> = [
      ['actions/checkout', 'v4.2.2', '11bd71901bbe5b1630ceea73d27597364c9af683'],
      ['actions/cache', 'v4.2.0', '1bd1e32a3bdc45362d1e726936510720a7c30a57'],
      ['actions/upload-artifact', 'v4.6.0', '65c4c4a1ddee5b72f698fdd19549f0f0fb45cf08'],
    ];
    const wf = WF(`  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/cache@v4\n        with:\n          path: ~/.cache/deps\n          key: deps-\${{ hashFiles('deps.lock') }}\n      - run: make deps\n      - run: make test\n      - run: make build\n      - uses: actions/upload-artifact@main\n        with:\n          name: dist\n          path: dist/\n`);
    const { full, state } = ciLab(v, o, me, { '.github/workflows/ci.yml': wf });
    const table = pins.map(([a, t, s]) => `${a.padEnd(24)} ${t.padEnd(7)} ${s}`).join('\n') + '\n';
    (state.system.files as Record<string, unknown>)[`${home}/action-pins.txt`] = owned({ x: table }, me.sam).x;
    const pinned = wf.replace('actions/checkout@v4', `actions/checkout@${pins[0][2]} # ${pins[0][1]}`).replace('actions/cache@v4', `actions/cache@${pins[1][2]} # ${pins[1][1]}`).replace('actions/upload-artifact@main', `actions/upload-artifact@${pins[2][2]} # ${pins[2][1]}`);
    return {
      instructions: lab({
        situation: `The workflow in **${full}** (clone ~/${o.project}) refers to actions by **tag** (\`@v4\`) and even by **branch** (\`@main\`). Your security team approved the exact commits listed in **~/action-pins.txt** (action, version, commit SHA). Change every \`uses:\` line to \`@<full SHA> # <version>\`, push, and make sure CI still passes.`,
        steps: ['cat ~/action-pins.txt', 'sed -i "s|actions/checkout@v4|actions/checkout@SHA # v4.2.2|" .github/workflows/ci.yml (and the others)', 'grep -n "uses:" .github/workflows/ci.yml', 'git commit -am "Pin actions to commit SHAs"; git push'],
        tips: ['grep -n "uses:" FILE', "sed -i 's|OLD|NEW|' FILE", 'gh run list'],
      }),
      hints: ['Only a 40-character commit SHA is immutable; tags and branches can be moved.', 'Keep the version in a comment so humans (and update bots) can read it.'],
      initialState: state,
      checks: [
        file('Every action is pinned to a full SHA', `${home}/${o.project}/.github/workflows/ci.yml`, { notContains: ['@v4\n', '@main'], pattern: pins.map(([a, , s]) => `uses: ${a}@${s}`).join('[\\s\\S]*') }),
        forge('CI still passes on main', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', artifact: 'dist' } }),
      ],
      solution: [`cd ~/${o.project}`, write('.github/workflows/ci.yml', pinned), 'grep -n "uses:" .github/workflows/ci.yml', 'git commit -qam "Pin actions to commit SHAs" && git push', 'gh run list'],
      realityNote: 'GitHub can enforce SHA pinning per organisation; Dependabot and Renovate update pinned SHAs and their version comments automatically.',
    };
  }),
  tmpl(6, 5, 'advanced', 'reproducible-tarball', 'Make the build reproducible', 'E4', 35, 'Change the build so the same source always gives a byte-identical tarball.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const { p, state } = ciLab(v, o, me, {});
    const mk = p.files.Makefile.replace('\ttar -czf dist/app-$(VERSION).tar.gz app.sh VERSION', '\ttar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - app.sh VERSION | gzip -n > dist/app-$(VERSION).tar.gz');
    return {
      instructions: lab({
        situation: `\`make build\` in **~/${o.project}** gives a **different** tarball every time, even from the same source, because tar records file times and owners, and gzip records the time it ran. That makes it impossible to check that a published build really came from this source.\n\nChange the **build** target so two builds of the same source produce a **byte-identical** dist/app-<version>.tar.gz:\n\n- sort the entries by name, set every file time to the epoch (\`--mtime=@0\`), owner and group 0 with numeric ids;\n- compress with \`gzip -n\` (no time stamp).\n\nProve it: build, note the sha256, touch a source file, build again, compare.`,
        steps: ['make build; sha256sum dist/*.tar.gz; touch app.sh; sleep 2; make build; sha256sum dist/*.tar.gz (different)', 'In the Makefile: tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - app.sh VERSION | gzip -n > dist/app-$(VERSION).tar.gz', 'Build twice again: the sums match', 'Commit and push'],
        tips: ['tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - FILES', 'gzip -n', 'sha256sum FILE'],
      }),
      hints: ['Anything that depends on when or by whom the build ran makes it unreproducible.', 'A recipe line can pipe: tar ... -cf - ... | gzip -n > OUT.'],
      initialState: state,
      checks: [
        out('Two builds from the same source are identical', `cd ${home}/${o.project} && make -s build >/dev/null && a=$(sha256sum dist/*.tar.gz | cut -d" " -f1) && touch app.sh && sleep 5 && rm -rf dist && make -s build >/dev/null && b=$(sha256sum dist/*.tar.gz | cut -d" " -f1) && [ "$a" = "$b" ] && echo identical`, { equals: 'identical' }),
        out('The tarball still holds the app', `cd ${home}/${o.project} && make -s build >/dev/null && tar -tzf dist/*.tar.gz`, { contains: ['app.sh', 'VERSION'] }),
        forge('The change is pushed', `${o.org}/${o.project}`, { branch: { name: 'main', file: { path: 'Makefile', contains: ['--mtime=@0', 'gzip -n', '--sort=name'] } } }),
      ],
      solution: [`cd ~/${o.project}`, write('Makefile', mk), 'make build && sha256sum dist/*.tar.gz', 'touch app.sh && sleep 2 && rm -rf dist && make build && sha256sum dist/*.tar.gz', 'git commit -qam "Make the build reproducible" && git push'],
      realityNote: 'Debian, Arch, NixOS and Guix rebuild packages independently and compare hashes (reproducible-builds.org); it is how you detect a compromised build machine.',
    };
  }),
];
