/** Unit 10: DevOps culture and capstone — DORA metrics, DevSecOps scanning, the capstone, and working with low bandwidth. */

import type { TaskTemplate } from '../types';
import type { Org, Person, Variant } from './kit';
import { seedRepo, type GitState, type SeedCommit } from '@cslab/engine-shell/src/git-state';
import { sha256 } from '@cslab/engine-shell/src/hash';
import { C, HOST, ORGS, caseStudy, dimg, dockerBits, dockerDev, dockerStateFile, file, forge, fuser, image, lab, out, owned, mutate, registryPackage, repo, simToken, ssh, tmpl, withForge, write } from './kit';

const home = (me: Person) => `/home/${me.sam}`;

/** The commit ids and times a seeded history ends up with. */
function history(commits: SeedCommit[]): Array<{ id: string; time: number; message: string }> {
  const files = seedRepo('/tmp/h', commits);
  const f = files['/tmp/h/.git/state.json'];
  const st = JSON.parse(typeof f === 'string' ? f : (f as { content: string }).content) as GitState;
  return Object.values(st.commits).sort((a, b) => a.seq - b.seq).map((c) => ({ id: c.id, time: c.time, message: c.message }));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const auth = (me: Person) => btoa(`${me.sam}:${simToken(me.sam)}`);

export const U10: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 10.1 DORA metrics */
  tmpl(10, 1, 'beginner', 'dora-metrics', 'Use the four DORA metrics', 'E10', 15, 'Understand what deployment frequency, lead time, change failure rate and time to restore say about a team, and how to use them well.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## Measuring delivery\n\n${o.org}'s director wants to "measure DevOps". Someone proposes counting lines of code and commits per developer. You suggest the DORA metrics instead.`,
      steps: [
        { title: 'The four metrics', text: 'Which four does DORA use?', choices: [{ text: 'Deployment frequency, lead time for changes, change failure rate, and time to restore service', right: true, feedback: 'Correct. Two measure speed (throughput), two measure stability.' }, { text: 'Lines of code, commits, story points and bugs closed', feedback: 'These measure activity, not delivery performance, and are easy to game.' }, { text: 'CPU usage, memory, uptime and latency', feedback: 'These are service health metrics, not delivery metrics.' }] },
        { title: 'Lead time', text: 'What exactly is lead time for changes?', choices: [{ text: 'The time from a change being committed to it running in production', right: true, feedback: 'Correct. It shows how quickly a finished change reaches users.' }, { text: 'The time from a feature request to its first commit', feedback: 'That includes design and prioritisation, which DORA deliberately leaves out.' }, { text: 'How long the CI pipeline takes', feedback: 'The pipeline is only part of it; waiting for approvals and releases counts too.' }] },
        { title: 'Speed and stability', text: 'Will deploying more often make things less stable?', choices: [{ text: 'Not for high performers: frequent small deployments go with lower failure rates and faster recovery, because each change is small and easy to fix', right: true, feedback: 'Correct. DORA\'s research shows speed and stability improve together.' }, { text: 'Yes, always: speed costs stability', feedback: 'The data shows the opposite for teams with good automation.' }, { text: 'Stability does not matter if you are fast', feedback: 'Both pairs of metrics matter; that is why DORA has four.' }] },
        { title: 'Using the numbers', text: 'How should the metrics be used?', choices: [{ text: 'As a team\'s own trend over time, to find bottlenecks and check that improvements work', right: true, feedback: 'Correct. They guide improvement; they are not targets for individuals.' }, { text: 'To rank developers', feedback: 'Individual rankings get gamed and damage collaboration (Goodhart\'s law).' }, { text: 'As a fixed target every team must hit next quarter', feedback: 'Targets get gamed; trends inform.' }] },
        { title: 'Where the data comes from', text: 'How do you collect them?', choices: [{ text: 'Automatically from the systems: git history, CI/CD deployment records and incident records', right: true, feedback: 'Correct. Automated collection is cheap and honest.' }, { text: 'A monthly survey of how fast people feel', feedback: 'Surveys help with culture, but the four metrics come from system data.' }, { text: 'Manual spreadsheets updated by managers', feedback: 'Slow, error-prone and easy to bias.' }] },
      ],
      ending: { title: 'Measure delivery, not activity', text: 'Four metrics, two for speed and two for stability, collected automatically and used as a team\'s trend to find what to improve.' },
      hints: ['Two speed metrics, two stability metrics.', 'Metrics that become targets for individuals stop measuring anything.'],
      realityNote: 'The metrics come from the DORA research programme (Forsgren, Humble and Kim, "Accelerate") and the yearly State of DevOps reports; tools such as Four Keys compute them from git and CI data.',
    });
  }),
  tmpl(10, 1, 'intermediate', 'lead-time', 'Compute deployment frequency and lead time', 'E4', 35, 'Work out deployment frequency and the median lead time for changes from git history and a deployment log.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const devs = v.people(3);
    const n = v.int(14, 20);
    const commits: SeedCommit[] = Array.from({ length: n }, (_, i) => C(`Change ${i + 1}`, v.pick(devs), o, { [`src/part${i % 5}.sh`]: `echo ${i}\n`, VERSION: `1.${i}.0\n` }, Math.floor((i * 27) / n), v.int(8, 17)));
    const h = history(commits);
    const deploys = v.int(4, 6);
    // Deployment k ships everything up to commit idx[k], some hours after that commit.
    const idx = Array.from({ length: deploys }, (_, k) => Math.min(n - 2, Math.round(((k + 1) * (n - 2)) / deploys)));
    const log = idx.map((i, k) => ({ at: h[i].time + (2 + ((k * 7) % 20)) * 3600000, id: h[i].id }));
    const leads: number[] = [];
    let prev = -1;
    idx.forEach((i, k) => {
      for (let c = prev + 1; c <= i; c++) leads.push((log[k].at - h[c].time) / 3600000);
      prev = i;
    });
    const freq = (deploys / 4).toFixed(2);
    const med = median(leads).toFixed(1);
    const text = log.map((d) => `${Math.floor(d.at / 1000)} ${d.id.slice(0, 7)}`).join('\n') + '\n';
    return {
      instructions: lab({
        situation: `**~/${o.project}** is ${o.org}'s repository; **~/deploys.log** lists the last **4 weeks** of production deployments, one per line: the deployment time (Unix seconds) and the short id of the commit that was deployed (each deployment ships every commit up to that one). Write **~/dora.txt**:\n\n- \`deployment_frequency_per_week=\` deployments per week, 2 decimals;\n- \`median_lead_time_hours=\` the **median** over all deployed commits of (deployment time − commit time) in hours, 1 decimal. A commit's deployment is the **first** deployment that includes it; commits never deployed do not count.`,
        steps: ['cat ~/deploys.log', 'git -C ~/' + o.project + " log --reverse --format='%h %ct'", 'For each deployment, the new commits are PREV..THIS: git log --format=%ct PREV..THIS', 'Collect all lead times, sort, take the median'],
        tips: ['%ct is the committer time in Unix seconds.', "sort -n | awk '{a[NR]=$1} END {print (NR%2 ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2)}'", 'The first deployment covers every commit up to it (no PREV).'],
      }),
      hints: ['Lead time is per commit, measured to the deployment that first shipped it.', 'git log A..B lists commits reachable from B but not from A.'],
      initialState: dockerDev({ me, files: { ...repo(me.sam, `${home(me)}/${o.project}`, commits), ...owned({ [`${home(me)}/deploys.log`]: text }, me.sam) } }),
      checks: [file('The DORA figures are right', `${home(me)}/dora.txt`, { equals: `deployment_frequency_per_week=${freq}\nmedian_lead_time_hours=${med}` })],
      solution: [`cd ~/${o.project}`, `prev=''; : > /tmp/leads; while read at id; do if [ -z "$prev" ]; then r=$id; else r=$prev..$id; fi; for ct in $(git log --format=%ct $r); do echo "$(( at - ct ))" >> /tmp/leads; done; prev=$id; done < ~/deploys.log`, `med=$(sort -n /tmp/leads | awk '{a[NR]=$1} END {m = (NR % 2) ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2; printf "%.1f", m / 3600}')`, `n=$(wc -l < ~/deploys.log); printf 'deployment_frequency_per_week=%s\\nmedian_lead_time_hours=%s\\n' "$(awk -v n=$n 'BEGIN { printf "%.2f", n / 4 }')" "$(sort -n /tmp/leads | awk '{a[NR]=$1} END {m = (NR % 2) ? a[(NR+1)/2] : (a[NR/2] + a[NR/2+1]) / 2; printf "%.1f", m / 3600}')" > ~/dora.txt`, 'cat ~/dora.txt'],
      realityNote: 'Google\'s Four Keys project and commercial tools (LinearB, Sleuth, GitLab\'s value stream analytics) compute these from exactly this pairing of commit data and deployment events.',
    };
  }),
  tmpl(10, 1, 'advanced', 'failure-and-restore', 'Compute change failure rate and time to restore', 'E4', 30, 'Join deployment and incident records with jq to work out the change failure rate and the median time to restore.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const n = v.int(18, 30);
    const deploys = Array.from({ length: n }, (_, i) => ({ id: `d-${200 + i}`, version: `2.${Math.floor(i / 4)}.${i % 4}`, deployed_at: `2026-09-${String(1 + i).padStart(2, '0')}T${String(9 + (i % 8)).padStart(2, '0')}:00:00Z` }));
    const bad = v.some(deploys, v.int(3, 6));
    const incidents = bad.map((d, k) => {
      const start = Date.parse(d.deployed_at) + (10 + k * 7) * 60000;
      const mins = v.int(12, 240);
      return { id: `INC-${40 + k}`, caused_by: d.id, started_at: new Date(start).toISOString().replace(/\.\d+Z$/, 'Z'), resolved_at: new Date(start + mins * 60000).toISOString().replace(/\.\d+Z$/, 'Z'), minutes: mins };
    });
    // One incident with no deployment cause (a provider outage) must not count as a change failure.
    const outage = { id: `INC-${40 + bad.length}`, caused_by: null, started_at: '2026-09-15T03:00:00Z', resolved_at: '2026-09-15T04:30:00Z', minutes: 90 };
    const cfr = ((bad.length / n) * 100).toFixed(1);
    const mttr = median([...incidents.map((i) => i.minutes), outage.minutes]);
    const dir = `${home(me)}/dora`;
    const incJson = JSON.stringify([...incidents, outage].map(({ minutes: _m, ...i }) => i), null, 2) + '\n';
    return {
      instructions: lab({
        situation: `~/dora/**deploys.json** lists ${o.org}'s production deployments for September and ~/dora/**incidents.json** the incidents, each with \`caused_by\` (the deployment id that caused it, or null) and its start and resolution times. Write **~/dora/stability.txt**:\n\n- \`change_failure_rate=\` the percentage of deployments that caused an incident, 1 decimal;\n- \`median_time_to_restore_minutes=\` the median of (resolved_at − started_at) in minutes over **all** incidents, whole number.`,
        steps: ["jq 'length' deploys.json", "jq '[.[] | select(.caused_by != null) | .caused_by] | unique | length' incidents.json", "jq '[.[] | ((.resolved_at | fromdate) - (.started_at | fromdate)) / 60]' incidents.json", 'Sort the minutes and take the median'],
        tips: ['fromdate turns an ISO time into Unix seconds in jq.', 'Change failure rate counts deployments, so a deployment that caused two incidents counts once.'],
      }),
      hints: ['An incident not caused by a change still counts for time to restore, but not for change failure rate.', 'jq sort and length give you the middle element(s).'],
      initialState: dockerDev({ me, packages: ['jq'], files: owned({ [`${dir}/deploys.json`]: JSON.stringify(deploys, null, 2) + '\n', [`${dir}/incidents.json`]: incJson }, me.sam) }),
      checks: [file('The stability figures are right', `${dir}/stability.txt`, { equals: `change_failure_rate=${cfr}\nmedian_time_to_restore_minutes=${Math.round(mttr)}` })],
      solution: ['cd ~/dora', `cfr=$(jq -n --slurpfile d deploys.json --slurpfile i incidents.json '([$i[0][] | select(.caused_by != null) | .caused_by] | unique | length) / ($d[0] | length) * 100'); m=$(jq '[.[] | ((.resolved_at | fromdate) - (.started_at | fromdate)) / 60] | sort | if length % 2 == 1 then .[(length - 1) / 2] else (.[length / 2 - 1] + .[length / 2]) / 2 end' incidents.json); printf 'change_failure_rate=%s\\nmedian_time_to_restore_minutes=%s\\n' "$(awk -v x=$cfr 'BEGIN { printf "%.1f", x }')" "$(awk -v x=$m 'BEGIN { printf "%.0f", x }')" > stability.txt`, 'cat stability.txt'],
      realityNote: 'Incident tools (PagerDuty, Opsgenie, incident.io) export exactly these records; linking each incident to the deployment that caused it is what makes change failure rate measurable.',
    };
  }),

  /* ---------------------------------------------------------------- 10.2 DevSecOps: secret, dependency and container scanning */
  tmpl(10, 2, 'beginner', 'secret-scanning', 'Catch a leaked secret before it is pushed', 'E4', 30, 'Find a secret in unpushed commits with gitleaks, rewrite those commits without it, and add a pre-commit hook so it cannot happen again.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const key = `AKIA${Array.from({ length: 16 }, (_, i) => 'ABCDEFGHJKLMNPQRSTUVWXYZ234567'[(i * 7 + v.int(0, 29)) % 30]).join('')}`;
    const dir = `${home(me)}/${o.project}`;
    const pc = 'repos:\n  - repo: https://github.com/gitleaks/gitleaks\n    rev: v8.21.2\n    hooks:\n      - id: gitleaks\n';
    const base = [C('Initial project', me, o, { 'app.sh': '#!/bin/bash\necho "upload receipts"\n', 'README.md': `# ${o.project}\n` })];
    return {
      instructions: lab({
        situation: `In ~/${o.project} you have **two local commits not yet pushed** to ${full}: the first added **config/settings.env**, which contains a real cloud access key; the second adds the upload feature you need to ship.\n\n1. Confirm the leak with \`gitleaks git -v\` (or \`gitleaks detect -v\`).\n2. Rewrite the unpushed commits so **no commit contains the key**, keeping the upload feature. Keep settings.env only as a local, git-ignored file, and commit a **config/settings.env.example** with \`AWS_ACCESS_KEY_ID=changeme\`.\n3. Add a **.pre-commit-config.yaml** with the **gitleaks** hook and install it.\n4. Push. (The key never reached the forge, so it does not need rotating — but report it if it had.)`,
        steps: ['git log --oneline origin/main..', 'gitleaks git -v', 'git reset --soft origin/main   (keeps the changes staged)', 'git rm --cached config/settings.env; echo config/settings.env >> .gitignore', 'Create config/settings.env.example; git add …; git commit', 'Write .pre-commit-config.yaml; pre-commit install', 'gitleaks git; git push'],
        tips: ['Rewriting commits is fine while they exist only on your machine; once pushed, assume the secret is leaked and rotate it.', 'gitleaks exits 1 when it finds leaks, so it can gate commits and CI.'],
      }),
      hints: ['git reset --soft moves the branch back but keeps all your changes staged.', 'A secret removed in a later commit is still in the earlier one: the history must not contain it.'],
      initialState: (() => {
        const leak = C('Add settings', me, o, { 'config/settings.env': `AWS_ACCESS_KEY_ID=${key}\nREGION=eu-west-1\n` });
        const feature = C('Add receipt upload', me, o, { 'upload.sh': '#!/bin/bash\ncurl -s -T "$1" "https://storage.example/receipts/"\n' });
        const local = repo(me.sam, dir, [...base, leak, feature], {}, { origin: ssh(full) });
        mutate(local, dir, (st) => {
          const first = Object.values(st.commits).find((c) => !c.parents.length)!.id;
          st.remoteRefs = { 'origin/main': first, 'origin/HEAD': first };
        });
        return withForge({ me, org: o, packages: ['gitleaks', 'pre-commit'], seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: base } } }, files: local });
      })(),
      checks: [
        out('No commit on the forge contains the key', `rm -rf /tmp/scan && git clone -q /srv/forge/repos/${full}.git /tmp/scan 2>/dev/null && gitleaks git /tmp/scan >/dev/null 2>&1; echo "rc=$?"`, { equals: 'rc=0', message: 'gitleaks still finds a secret in the pushed history.' }),
        forge('The upload feature was pushed with the example config', full, { branch: { name: 'main', file: { path: 'upload.sh', contains: 'curl' }, minCommits: 2 } }),
        forge('The example settings file is committed', full, { branch: { name: 'main', file: { path: 'config/settings.env.example', contains: 'changeme' } } }),
        file('The real settings file is ignored', `${dir}/.gitignore`, { contains: 'settings.env' }),
        file('gitleaks runs before every commit', `${dir}/.pre-commit-config.yaml`, { contains: ['gitleaks', 'id: gitleaks'] }),
        file('The pre-commit hook is installed', `${dir}/.git/hooks/pre-commit`, { contains: 'pre-commit' }),
      ],
      solution: [`cd ~/${o.project}`, 'git log --oneline origin/main..', 'gitleaks git -v', 'git reset -q --soft origin/main', 'git rm -q --cached config/settings.env', 'echo config/settings.env >> .gitignore', "printf 'AWS_ACCESS_KEY_ID=changeme\\nREGION=eu-west-1\\n' > config/settings.env.example", 'git add .gitignore config/settings.env.example upload.sh', 'git commit -qm "Add receipt upload"', write('.pre-commit-config.yaml', pc), 'pre-commit install', 'git add .pre-commit-config.yaml && git commit -qm "Scan commits for secrets"', 'gitleaks git', 'git push -q'],
      realityNote: 'gitleaks (and GitHub\'s secret scanning and push protection) catch thousands of leaked keys a day; the pre-commit hook stops them on the developer\'s machine, which is the cheapest place.',
    };
  }),
  tmpl(10, 2, 'intermediate', 'dependency-scanning', 'Fix vulnerable dependencies and gate them in CI', 'E4', 30, 'Find vulnerable pinned dependencies with pip-audit, upgrade them to fixed versions, and add an audit job to CI.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const vuln = v.some([['flask', '2.2.2', '2.2.5'], ['requests', '2.31.0', '2.32.0'], ['jinja2', '3.1.2', '3.1.4'], ['werkzeug', '2.3.7', '3.0.3'], ['pyyaml', '5.3.1', '5.4']] as const, 3);
    const safe = [['gunicorn', '22.0.0']];
    const req = [...vuln.map(([n, ver]) => `${n}==${ver}`), ...safe.map(([n, ver]) => `${n}==${ver}`)].join('\n') + '\n';
    const fixed = [...vuln.map(([n, , f]) => `${n}==${f}`), ...safe.map(([n, ver]) => `${n}==${ver}`)].join('\n') + '\n';
    const ci = 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./test.sh\n';
    const ciAfter = ci + '  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: pip-audit -r requirements.txt\n';
    const dir = `${home(me)}/${o.project}`;
    return {
      instructions: lab({
        situation: `**${full}** (clone: ~/${o.project}) pins its Python dependencies in **requirements.txt**. Some pins have published vulnerabilities.\n\n1. Run \`pip-audit -r requirements.txt\` and upgrade each vulnerable package to the **lowest fixed version** pip-audit lists for its release line (keep every package pinned with ==).\n2. Add a job **audit** to .github/workflows/ci.yml that runs \`pip-audit -r requirements.txt\`, so a vulnerable pin fails CI.\n3. Push; CI on main must pass, including audit.`,
        steps: ['pip-audit -r requirements.txt', 'Edit requirements.txt', 'pip-audit -r requirements.txt   (No known vulnerabilities found)', 'Add the audit job; commit; push', 'gh run view'],
        tips: ['osv-scanner -L requirements.txt is a second opinion from the OSV database.', 'pip-audit exits 1 when it finds vulnerabilities, which fails the CI step.'],
      }),
      hints: ['The Fix Versions column lists the first safe version in each release line.', 'Pinning exact versions keeps builds reproducible; scanning keeps the pins safe.'],
      initialState: withForge({ me, org: o, packages: ['pip-audit', 'osv-scanner'], seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: [C('Service and CI', me, o, { 'requirements.txt': req, 'test.sh': '#!/bin/bash\necho "tests passed"\n', 'app.py': 'print("hello")\n', '.github/workflows/ci.yml': ci })], seed: { executable: ['test.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        out('pip-audit finds nothing', `pip-audit -r ${dir}/requirements.txt 2>&1; echo "rc=$?"`, { equals: 'No known vulnerabilities found\nrc=0' }),
        file('Every dependency is still pinned', `${dir}/requirements.txt`, { pattern: '^(?:[A-Za-z0-9_.-]+==[\\w.]+\\n?)+$' }),
        forge('CI on main ran the audit and passed', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success', jobStatus: { audit: 'success', test: 'success' } } }),
      ],
      solution: [`cd ~/${o.project}`, 'pip-audit -r requirements.txt', write('requirements.txt', fixed), 'pip-audit -r requirements.txt', write('.github/workflows/ci.yml', ciAfter), 'git commit -qam "Fix vulnerable dependencies and audit them in CI" && git push -q', 'gh run list'],
      realityNote: 'Dependabot and Renovate open these upgrade pull requests automatically; pip-audit, osv-scanner, npm audit and Snyk are the gates that keep a vulnerable dependency from being merged.',
    };
  }),
  tmpl(10, 2, 'advanced', 'container-scanning', 'Make an image pass a container scan', 'E4', 35, 'Use trivy to find vulnerable OS packages, leaked secrets and misconfigurations in an image, fix the Dockerfile, and pass the scan gate.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const tag = `${o.org}/api:dev`;
    const dir = `${home(me)}/${o.project}`;
    const key = `AKIA${'Q4J5WXYZ7ABCD'}${v.int(100, 999)}`;
    const files = owned({ [`${dir}/app.py`]: 'print("api")\n', [`${dir}/requirements.txt`]: 'flask==3.0.3\ngunicorn==22.0.0\n', [`${dir}/.env`]: `AWS_ACCESS_KEY_ID=${key}\nDEBUG=1\n`, [`${dir}/.gitignore`]: '.env\n', [`${dir}/Dockerfile`]: 'FROM python:3.9\nWORKDIR /app\nCOPY . .\nRUN pip install --no-cache-dir -r requirements.txt\nCMD ["python3", "app.py"]\n' }, me.sam);
    const df = 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nRUN adduser --disabled-password --gecos "" app\nUSER app\nHEALTHCHECK CMD python3 --version || exit 1\nCMD ["python3", "app.py"]\n';
    const gate = `trivy image --quiet --severity HIGH,CRITICAL --exit-code 1 ${tag}`;
    return {
      instructions: lab({
        situation: `The release gate for ${o.org}'s API is \`${gate}\`: the image may have **no HIGH or CRITICAL findings** (vulnerable packages or secrets). Today's build of **${tag}** (from ~/${o.project}) fails it.\n\n1. Build it and run the gate to see why; also run \`trivy config ~/${o.project}\` for Dockerfile problems.\n2. Fix the Dockerfile: a **current, slim base image** (python:3.12-slim), keep **.env** (and .git) out of the image with a **.dockerignore**, and run as a **non-root user**.\n3. Rebuild ${tag} and pass the gate.`,
        steps: [`docker build -t ${tag} ~/${o.project}`, gate, `trivy config ~/${o.project}`, 'Edit the Dockerfile; write .dockerignore', `docker build -t ${tag} ~/${o.project}`, `${gate}; echo $?`],
        tips: ['Old base images carry old OS packages: python:3.9 is built on Debian 11.', 'COPY . . copies everything not in .dockerignore — including .env.', 'USER app (after creating the user) makes the container run without root.'],
      }),
      hints: ['trivy groups findings by target: the OS packages, the Python packages, and secrets.', 'A secret baked into an image is readable by anyone who can pull it.'],
      initialState: dockerDev({ me, packages: ['trivy'], docker: { pulled: ['python:3.9', 'python:3.12-slim'] }, files }),
      checks: [
        out('The image passes the release gate', `${gate} >/dev/null 2>&1; echo "rc=$?"`, { equals: 'rc=0', message: 'trivy still finds HIGH or CRITICAL problems in the image.' }),
        dimg(`${tag} runs as a non-root user on a current base`, tag, { notRoot: true, base: '^python:3\\.12' }),
        out('.env is not in the image', `docker run --rm ${tag} ls -a /app | grep -cx -e .env -e .git`, { equals: '0' }),
        out('trivy config finds no HIGH problems in the Dockerfile', `trivy config --quiet --severity HIGH,CRITICAL --exit-code 1 ${dir} >/dev/null 2>&1; echo "rc=$?"`, { equals: 'rc=0' }),
      ],
      solution: [`docker build -q -t ${tag} ~/${o.project}`, `${gate}; echo $?`, `trivy config ~/${o.project}`, write(`~/${o.project}/Dockerfile`, df), write(`~/${o.project}/.dockerignore`, '.env\n.git\n__pycache__\n'), `docker build -q -t ${tag} ~/${o.project}`, `${gate}; echo $?`],
      realityNote: 'Trivy, Grype and Docker Scout run as exactly this kind of gate in CI and registries; most HIGH and CRITICAL findings disappear just by moving to a current, slim base image.',
    };
  }),

  /* ---------------------------------------------------------------- 10.3 capstone */
  tmpl(10, 3, 'beginner', 'capstone-containerise', 'Capstone: containerise and run an application', 'E4', 40, 'Package a small application as a non-root image with a health check, and run it with Compose and persistent data.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8085, 9090]);
    const dir = `${home(me)}/${o.project}`;
    const proj = o.project;
    const start = `#!/bin/sh\n# Serves the site and keeps a visit counter in $DATA_DIR.\n: "\${DATA_DIR:?DATA_DIR is not set}"\nmkdir -p /tmp/www\ncount=$(cat "$DATA_DIR/starts" 2>/dev/null || echo 0)\necho $((count + 1)) > "$DATA_DIR/starts"\necho "<h1>${o.what}</h1><p>started $((count + 1)) times</p>" > /tmp/www/index.html\necho ok > /tmp/www/healthz\nexec httpd -f -p 8080 -h /tmp/www\n`;
    const df = 'FROM alpine:3.20\nRUN adduser -D -u 10001 app && mkdir /data && chown app /data\nCOPY --chmod=755 start.sh /usr/local/bin/start.sh\nENV DATA_DIR=/data\nUSER app\nEXPOSE 8080\nHEALTHCHECK --interval=10s --retries=3 CMD wget -qO- http://localhost:8080/healthz || exit 1\nCMD ["start.sh"]\n';
    const compose = `services:\n  app:\n    build: .\n    image: ${o.org}/${proj}:1.0\n    ports:\n      - "${port}:8080"\n    volumes:\n      - appdata:/data\n    restart: unless-stopped\nvolumes:\n  appdata:\n`;
    return {
      instructions: lab({
        situation: `~/${proj} has **start.sh**, ${o.org}'s small web application: it serves on port 8080, answers **/healthz**, and needs **DATA_DIR** for a counter that must survive restarts. Containerise and run it:\n\n- **Dockerfile** on alpine:3.20: an unprivileged user, /data owned by that user, DATA_DIR=/data, port 8080 exposed, a **HEALTHCHECK** on /healthz, start.sh as the command, running as the unprivileged user;\n- **compose.yaml**: service **app** built from the folder as image **${o.org}/${proj}:1.0**, port **${port}**→8080, a **named volume** at /data, restart unless-stopped.\n\nStart it, check it is healthy, then restart it and see the counter keep counting.`,
        steps: ['Write the Dockerfile', 'Write compose.yaml', 'docker compose up -d --build', 'docker compose ps   (healthy)', `curl -s localhost:${port}`, 'docker compose restart app; curl again'],
        tips: ['HEALTHCHECK CMD wget -qO- http://localhost:8080/healthz || exit 1', 'COPY --chmod=755 sets the file mode while copying.', 'Named volumes outlive containers; the container user must be able to write to them.'],
      }),
      hints: ['If the app exits with "DATA_DIR is not set", set ENV DATA_DIR in the Dockerfile.', 'Permission denied on /data means the directory belongs to root; chown it to the app user in the Dockerfile.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20'] }, files: owned({ [`${dir}/start.sh`]: { content: start, mode: '755' } }, me.sam) }),
      checks: [
        dimg('The image runs as an unprivileged user with a health check', `${o.org}/${proj}:1.0`, { notRoot: true, expose: [8080] }),
        out('The app is healthy', `docker inspect -f '{{.State.Health.Status}}' ${proj}-app-1`, { equals: 'healthy' }),
        out('Its data lives in a named volume at /data', `docker inspect -f '{{range .Mounts}}{{.Type}} {{.Destination}}{{end}}' ${proj}-app-1`, { equals: 'volume /data' }),
        out('The counter survives restarts', `cd ${dir} && docker compose restart app >/dev/null 2>&1; curl -s localhost:${port}`, { pattern: 'started ([2-9]|\\d\\d+) times' }),
      ],
      solution: [`cd ~/${proj}`, write('Dockerfile', df), write('compose.yaml', compose), 'docker compose up -d --build', 'sleep 12', 'docker compose ps', `curl -s localhost:${port}`, 'docker compose restart app', `curl -s localhost:${port}`, 'sleep 12', 'docker compose ps'],
      realityNote: 'A non-root image with a health check, run by Compose with a named volume and a restart policy, is a complete small production deployment — and the same image moves unchanged to Kubernetes later.',
    };
  }),
  tmpl(10, 3, 'intermediate', 'capstone-pipeline', 'Capstone: build and publish images from CI', 'E4', 40, 'Write a pipeline that tests every push and, on main, builds the image and pushes it to the registry tagged with the commit and main.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const remote = `${HOST}/${full}`;
    const wf = `name: Pipeline\non:\n  push:\n    branches: [main]\n  pull_request:\npermissions:\n  contents: read\n  packages: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./test.sh\n  image:\n    needs: test\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "\${{ secrets.GITHUB_TOKEN }}" | docker login ${HOST} -u \${{ github.actor }} --password-stdin\n      - run: docker build -t ${remote}:\${{ github.sha }} -t ${remote}:main .\n      - run: docker push ${remote}:\${{ github.sha }}\n      - run: docker push ${remote}:main\n`;
    return {
      instructions: lab({
        situation: `**${full}** (clone: ~/${o.project}) has a Dockerfile and **test.sh**. Add **.github/workflows/pipeline.yml**, workflow **Pipeline**, for pushes to main and pull requests:\n\n- job **test** runs ./test.sh;\n- job **image** (after test, **only on main**) logs in to **${HOST}** with the job's **GITHUB_TOKEN** (the workflow must grant \`packages: write\`), builds the image and pushes it as **${remote}:<commit sha>** and **${remote}:main**.\n\nPush to main; both jobs must pass and the registry must have both tags for the same image.`,
        steps: ['Write the workflow (permissions, two jobs, needs, if)', 'git add, commit, push', 'gh run view', `git rev-parse HEAD`],
        tips: ['echo "${{ secrets.GITHUB_TOKEN }}" | docker login git.lab -u ${{ github.actor }} --password-stdin', 'permissions:\n  packages: write', 'One docker build with two -t options gives one image two names.'],
      }),
      hints: ['Without packages: write the push is denied: the job token is read-only by default.', 'Tagging with the commit sha lets anyone trace a running image back to its source.'],
      initialState: withForge({ me, org: o, packages: ['jq'], seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: [C('App, Dockerfile and tests', me, o, { 'start.sh': '#!/bin/sh\nmkdir -p /tmp/www && echo ok > /tmp/www/healthz && exec httpd -f -p 8080 -h /tmp/www\n', Dockerfile: 'FROM alpine:3.20\nCOPY --chmod=755 start.sh /usr/local/bin/start.sh\nUSER nobody\nEXPOSE 8080\nCMD ["start.sh"]\n', 'test.sh': '#!/bin/bash\nsh -n start.sh && echo "tests passed"\n' })], seed: { executable: ['test.sh', 'start.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        forge('The pipeline passed on main', full, { run: { workflow: 'Pipeline', headOfBranch: 'main', conclusion: 'success', jobStatus: { test: 'success', image: 'success' } } }),
        out('The registry has the commit tag and main for the same image', `sha=$(git --git-dir=/srv/forge/repos/${full}.git rev-parse main); KEY="${full}"; jq -r --arg k "$KEY" --arg s "$sha" '.packages[$k].tags | if .[$s] != null and .[$s] == .main then "same" else "different" end' /srv/forge/forge.json`, { equals: 'same' }),
      ],
      solution: [`cd ~/${o.project}`, 'mkdir -p .github/workflows', write('.github/workflows/pipeline.yml', wf), 'git add .github && git commit -qm "Build and publish images" && git push -q', 'gh run list'],
      realityNote: 'This is the standard GitHub Actions publish job (docker login with GITHUB_TOKEN, build, push); docker/build-push-action wraps the same steps.',
    };
  }),
  tmpl(10, 3, 'advanced', 'capstone-release', 'Capstone: release with a health gate and roll back', 'E4', 45, 'Deploy a new image by digest with Compose, let the health check reject it, roll back to the previous digest, and record the release.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8090]);
    const good = `3.${v.int(0, 4)}.${v.int(0, 9)}`;
    const next = `3.${v.int(5, 9)}.0`;
    const mk = (ver: string, ok: boolean) => image(`${o.org}/${o.project}:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: `#!/bin/sh\nmkdir -p /tmp/www\necho "${ver}" > /tmp/www/version\n${ok ? 'echo ok > /tmp/www/healthz\n' : 'echo "warning: payments client misconfigured"\n'}exec httpd -f -p 8080 -h /tmp/www\n`, mode: '755' } }, cmd: 'start.sh', expose: [8080], health: { test: ['CMD-SHELL', 'wget -qO- http://localhost:8080/healthz || exit 1'], interval: 3000, retries: 2, startPeriod: 0 } });
    const full = `${o.org}/${o.project}`;
    const pkg = registryPackage(o.org, o.project, { [good]: mk(good, true), [next]: mk(next, false) }, 'private', full);
    const dg = pkg.tags[good];
    const dn = pkg.tags[next];
    const remote = `${HOST}/${full}`;
    const dir = `${home(me)}/release`;
    const compose = `services:\n  app:\n    image: ${remote}@${dg}\n    ports:\n      - "${port}:8080"\n    restart: unless-stopped\n`;
    const files = owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/DEPLOYLOG.md`]: `# Deployments\n\n- ${good} ${dg} live\n`, [`${home(me)}/.docker/config.json`]: JSON.stringify({ auths: { [HOST]: { auth: auth(me) } } }, null, '\t') + '\n' }, me.sam);
    return {
      instructions: lab({
        situation: `~/release/compose.yaml runs ${o.org}'s app from **${remote}@${dg.slice(0, 19)}…** (version ${good}). Release **${next}**:\n\n1. Find ${next}'s digest (\`docker pull ${remote}:${next}\`), put it in compose.yaml, and deploy with \`docker compose up -d --wait\` (which fails if the new container does not become healthy).\n2. ${next} will fail its health check. **Roll back**: put ${good}'s digest back and deploy again with --wait.\n3. Append two lines to **~/release/DEPLOYLOG.md**: \`- ${next} DIGEST failed health check\` and \`- ${good} DIGEST rolled back\` (with the full digests).`,
        steps: [`docker pull ${remote}:${next}`, `docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${next}`, 'Edit compose.yaml; docker compose up -d --wait', 'docker compose ps; docker compose logs', `Put ${good}'s digest back; docker compose up -d --wait`, 'Update DEPLOYLOG.md'],
        tips: ['--wait makes docker compose up wait for health checks and exit non-zero if a service is unhealthy.', 'Deploying by digest makes "the previous version" an exact, recorded thing to return to.'],
      }),
      hints: [`The current digest is in compose.yaml and in DEPLOYLOG.md: that is your rollback target.`, 'docker inspect -f \'{{.State.Health.Status}}\' shows why --wait failed.'],
      initialState: withForge({ me, org: o, ...dockerBits(me, { pulled: ['alpine:3.20'] }), files: { ...dockerStateFile({ pulled: ['alpine:3.20'] }), ...files }, seed: { users: { [me.sam]: fuser(me, o, { scopes: ['repo', 'read:org', 'read:packages'] }) }, repos: { [full]: { commits: [C('Initial', me, o, { 'README.md': `# ${o.project}\n` })] } }, packages: { [full]: pkg } } }),
      checks: [
        out(`Production runs ${good} again, by digest`, "docker inspect -f '{{.Config.Image}}' release-app-1", { equals: `${remote}@${dg}` }),
        out('It is healthy', "docker inspect -f '{{.State.Health.Status}}' release-app-1", { equals: 'healthy' }),
        out(`It answers as ${good}`, `curl -s localhost:${port}/version`, { equals: good }),
        file('The deployment log records the failed release and the rollback', `${dir}/DEPLOYLOG.md`, { contains: [`- ${next} ${dn} failed health check`, `- ${good} ${dg} rolled back`] }),
      ],
      solution: [`docker pull ${remote}:${next}`, `cd ~/release && cp compose.yaml compose.good && sed -i "s|image: .*|image: $(docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${next})|" compose.yaml`, 'cd ~/release && docker compose up -d --wait; echo "exit $?"', 'cd ~/release && docker compose ps -a', 'cd ~/release && cp compose.good compose.yaml && docker compose up -d --wait', `printf -- '- ${next} %s failed health check\\n- ${good} %s rolled back\\n' "$(docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${next} | cut -d@ -f2)" "${dg}" >> ~/release/DEPLOYLOG.md`, 'cat ~/release/DEPLOYLOG.md', `curl -s localhost:${port}/version`],
      realityNote: 'Health-gated deploys with an exact rollback target are the core of every safe release process, from Compose --wait to Kubernetes readiness probes and progressive delivery tools.',
    };
  }),

  /* ---------------------------------------------------------------- 10.4 working with low bandwidth */
  tmpl(10, 4, 'beginner', 'shallow-clone', 'Clone only the history you need', 'E4', 25, 'Clone a long-lived repository shallowly over a slow link, then deepen just enough history to investigate a change.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const n = v.int(30, 45);
    const depth = v.int(6, 12);
    const commits = Array.from({ length: n }, (_, i) => C(`Release notes ${i + 1}`, me, o, { [`notes/r${i + 1}.md`]: `# Release ${i + 1}\n`, 'assets/logo.svg': `<svg><!-- ${'x'.repeat(200 + i)} --></svg>\n`, VERSION: `1.${i}.0\n` }, Math.floor(i / 2)));
    return {
      instructions: lab({
        situation: `The office link is slow and **${full}** has years of history. You need the current code now, and later the last **${depth}** commits to find when VERSION changed.\n\n1. Clone it into **~/${o.project}** with **only the latest commit** (depth 1, a single branch).\n2. Then deepen the clone so it has exactly the last **${depth} commits** of main (fetch only what is missing).`,
        steps: [`git clone --depth 1 --single-branch git@${HOST}:${full}.git ~/${o.project}`, 'git rev-list --count HEAD', `git fetch --deepen=${depth - 1}`, 'git rev-list --count HEAD; git log --oneline'],
        tips: ['--depth N keeps only the newest N commits; --deepen N adds N more.', 'git rev-parse --is-shallow-repository says true for a shallow clone.'],
      }),
      hints: ['A depth-1 clone has 1 commit; deepening by k gives 1 + k.', 'git fetch --unshallow would fetch everything, which is what you are avoiding.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits } } } }),
      checks: [
        out(`~/${o.project} has exactly ${depth} commits`, `git -C ${home(me)}/${o.project} rev-list --count HEAD`, { equals: String(depth) }),
        out('It is still a shallow clone', `git -C ${home(me)}/${o.project} rev-parse --is-shallow-repository`, { equals: 'true' }),
        out('It has the latest code', `cat ${home(me)}/${o.project}/VERSION`, { equals: `1.${n - 1}.0` }),
      ],
      solution: [`git clone -q --depth 1 --single-branch git@${HOST}:${full}.git ~/${o.project}`, `cd ~/${o.project} && git rev-list --count HEAD`, `cd ~/${o.project} && git fetch -q --deepen=${depth - 1}`, `cd ~/${o.project} && git rev-list --count HEAD`],
      realityNote: 'CI systems clone with depth 1 by default (actions/checkout does), and shallow or partial (--filter=blob:none) clones are how large repositories are used over slow or metered connections.',
    };
  }),
  tmpl(10, 4, 'intermediate', 'bundle-sync', 'Sync a repository offline with git bundles', 'E4', 30, 'Carry a repository to a site with no network on a USB drive as a git bundle, then send only the new commits with an incremental bundle.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const n = v.int(5, 9);
    const office = `${home(me)}/office/${o.project}`;
    const commits = Array.from({ length: n }, (_, i) => C(`Ledger update ${i + 1}`, me, o, { 'ledger.csv': Array.from({ length: i + 2 }, (_, k) => `${k + 1},${(k + 1) * 50}`).join('\n') + '\n' }, i));
    const note = v.pick(['Add Kintampo branch prices', 'Correct June fuel costs', 'Add new suppliers']);
    return {
      instructions: lab({
        situation: `The ${o.what} team works at a site with **no network**. The office repository is **~/office/${o.project}**; the field laptop's copy will be **~/field/${o.project}**; the USB drive is mounted at **/media/usb**.\n\n1. Make a bundle of the whole repository at **/media/usb/${o.project}.bundle**, verify it, and clone the field copy **from the bundle**. Tag the office's main as **field-sync** to remember what the field has.\n2. Later, in the office, commit "${note}" (append a line to ledger.csv).\n3. Make an **incremental** bundle **/media/usb/${o.project}-update.bundle** with only the commits since field-sync, verify it, and bring the field copy up to date from it. Move the field-sync tag to the new main.`,
        steps: [`cd ~/office/${o.project}; git bundle create /media/usb/${o.project}.bundle --all`, `git bundle verify /media/usb/${o.project}.bundle`, `git clone /media/usb/${o.project}.bundle ~/field/${o.project}`, 'git tag field-sync main', '…commit…', `git bundle create /media/usb/${o.project}-update.bundle field-sync..main`, `cd ~/field/${o.project}; git pull /media/usb/${o.project}-update.bundle main`, 'git tag -f field-sync main (in the office)'],
        tips: ['A bundle is a file that git can clone, fetch and pull from like a remote.', 'field-sync..main means "commits on main that field-sync does not have".'],
      }),
      hints: ['An incremental bundle needs the receiver to already have its prerequisite commits; git bundle verify checks that.', 'Keep the tag in the office repository: it marks the last synchronised commit.'],
      initialState: dockerDev({ me, files: { ...repo(me.sam, office, commits), '/media/usb/': { content: '', owner: me.sam, group: me.sam }, [`${home(me)}/field/`]: { content: '', owner: me.sam, group: me.sam }, [`${home(me)}/.gitconfig`]: { content: `[user]\n\tname = ${me.name}\n\temail = ${me.sam}@${o.org}.org\n[init]\n\tdefaultBranch = main\n`, owner: me.sam, group: me.sam } } }),
      checks: [
        out('The field copy matches the office', `[ "$(git -C ${home(me)}/field/${o.project} rev-parse HEAD)" = "$(git -C ${office} rev-parse main)" ] && echo same`, { equals: 'same' }),
        out('The office has the new commit', `git -C ${office} log -1 --format=%s main`, { equals: note }),
        out('field-sync marks what the field has', `[ "$(git -C ${office} rev-parse field-sync)" = "$(git -C ${office} rev-parse main)" ] && echo same`, { equals: 'same' }),
        out('The update bundle holds only the new commit', `git -C ${office} bundle list-heads /media/usb/${o.project}-update.bundle >/dev/null && git -C ${home(me)}/field/${o.project} bundle verify /media/usb/${o.project}-update.bundle 2>&1 | grep -c 'requires'`, { pattern: '^[1-9]' }),
      ],
      solution: [`cd ~/office/${o.project} && git bundle create /media/usb/${o.project}.bundle --all`, `git bundle verify /media/usb/${o.project}.bundle`, `git clone -q /media/usb/${o.project}.bundle ~/field/${o.project}`, `cd ~/office/${o.project} && git tag field-sync main`, `cd ~/office/${o.project} && echo "${n + 2},999" >> ledger.csv && git commit -qam "${note}"`, `cd ~/office/${o.project} && git bundle create /media/usb/${o.project}-update.bundle field-sync..main`, `cd ~/field/${o.project} && git bundle verify /media/usb/${o.project}-update.bundle`, `cd ~/field/${o.project} && git pull -q /media/usb/${o.project}-update.bundle main`, `cd ~/office/${o.project} && git tag -f field-sync main`],
      realityNote: 'git bundle is how repositories travel over sneakernet and air-gapped networks; the same idea (send only what the other side lacks) is behind every git fetch.',
    };
  }),
  tmpl(10, 4, 'advanced', 'offline-images', 'Deploy on a server with no internet', 'E4', 30, 'Verify and load container images carried on a USB drive, and start a Compose stack that never tries to pull.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8000]);
    const ver = `1.${v.int(0, 9)}`;
    const appImg = image(`${o.org}/clinic:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: `#!/bin/sh\nfor i in 1 2 3 4 5 6 7 8; do nc -z db 5432 && break; sleep 1; done\nmkdir -p /tmp/www && echo "<h1>${o.what} ${ver}</h1>" > /tmp/www/index.html && echo ok > /tmp/www/healthz\nexec httpd -f -p 8080 -h /tmp/www\n`, mode: '755' } }, cmd: 'start.sh', expose: [8080] });
    const archive = `#CSLAB-GZ mtime=0\n#CSLAB-IMAGE-ARCHIVE\n${JSON.stringify([appImg, { ...image('postgres:16', 'postgres:16'), base: 'postgres:16' }])}\n`;
    const sum = sha256(archive);
    const dir = `${home(me)}/clinic`;
    const compose = `services:\n  app:\n    image: ${o.org}/clinic:${ver}\n    ports:\n      - "${port}:8080"\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    volumes:\n      - dbdata:/var/lib/postgresql/data\nvolumes:\n  dbdata:\n`;
    return {
      instructions: lab({
        situation: `This server at a rural clinic has **no internet access** (try \`docker pull alpine:3.20\`). The images were saved at the office onto the USB drive: **/media/usb/clinic-images.tar.gz** with **/media/usb/SHA256SUMS**. ~/clinic/compose.yaml describes the stack.\n\n1. **Verify** the archive against SHA256SUMS before trusting it.\n2. **Load** the images.\n3. Add \`pull_policy: never\` to **both services**, so Compose never waits on a network that is not there, and start the stack.`,
        steps: ['cd /media/usb && sha256sum -c SHA256SUMS', 'docker load -i /media/usb/clinic-images.tar.gz', 'docker images', 'Edit compose.yaml: pull_policy: never under app and db', 'cd ~/clinic; docker compose up -d', `curl -s localhost:${port}`],
        tips: ['docker save and docker load move images as files; gzip makes them smaller for the trip.', 'sha256sum -c reads the expected hashes from the file and reports OK or FAILED for each file.'],
      }),
      hints: ['A corrupted copy fails sha256sum -c: copy it again before loading.', 'pull_policy: never makes a missing image an immediate error instead of a network timeout.'],
      initialState: dockerDev({ me, files: { '/etc/cslab/offline': { content: 'no internet access\n', owner: 'root', group: 'root' }, '/media/usb/clinic-images.tar.gz': { content: archive, owner: me.sam, group: me.sam }, '/media/usb/SHA256SUMS': { content: `${sum}  clinic-images.tar.gz\n`, owner: me.sam, group: me.sam }, ...owned({ [`${dir}/compose.yaml`]: compose, [`${dir}/.env`]: `DB_PASSWORD=${v.password()}\n` }, me.sam) } }),
      checks: [
        out('The stack is running', `cd ${dir} && docker compose ps`, { contains: ['clinic-app-1', 'clinic-db-1'] }),
        out('The clinic app answers', `curl -s localhost:${port}`, { contains: `${o.what} ${ver}` }),
        file('Compose never pulls', `${dir}/compose.yaml`, { pattern: '(pull_policy: never[\\s\\S]*){2}' }),
        out('The archive was verified', `cd /media/usb && sha256sum -c SHA256SUMS`, { equals: 'clinic-images.tar.gz: OK' }),
      ],
      solution: ['cd /media/usb && sha256sum -c SHA256SUMS', 'docker load -i /media/usb/clinic-images.tar.gz', 'docker images', `sed -i 's|^    image: \\(.*\\)$|    image: \\1\\n    pull_policy: never|' ~/clinic/compose.yaml`, 'cat ~/clinic/compose.yaml', 'cd ~/clinic && docker compose up -d', `curl -s localhost:${port}`],
      realityNote: 'Air-gapped and low-bandwidth sites receive software exactly like this: docker save archives (or a local registry mirror) plus checksums, so nothing depends on a connection during deployment.',
    };
  }),
];

export type { Org, Variant };
