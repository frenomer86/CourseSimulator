/** Unit 3: remote repositories, pull requests, workflows, code review and releases. */

import type { TaskTemplate } from '../types';
import { C, ORGS, bare, caseStudy, dev, email, file, forge, fuser, lab, mutate, out, owned, repo, simToken, ssh, https, tmpl, withForge } from './kit';

const CHECK_WF = (cmd: string) => `name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - name: Test\n        run: ${cmd}\n`;

export const U3: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 3.1 clone, fetch, pull, push; tracking branches; SSH keys and tokens */
  tmpl(3, 1, 'beginner', 'ssh-key-and-push', 'Set up an SSH key, clone and push', 'E4', 25, 'Generate a key, register it on the forge, clone over SSH and push a commit.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const lead = v.person();
    const home = `/home/${me.sam}`;
    const full = `${o.org}/${o.project}`;
    const line = `${me.given} ${me.surname} - ${v.pick(['developer', 'support', 'operations'])}`;
    return {
      instructions: lab({
        situation: `You have just joined ${o.org}. Your forge account **${me.sam}** on **git.lab** has no SSH key yet (gh is logged in with a token). ${lead.given} has given you write access to **${full}**.\n\n1. generate an **ed25519** key pair with your e-mail ${email(me, o)} as the comment;\n2. add the **public** key to your forge account;\n3. clone **${ssh(full)}** into ~/${o.project};\n4. add the line \`${line}\` to **TEAM.md**, commit it (\`Add ${me.given} to the team\`) and push.`,
        steps: [`ssh-keygen -t ed25519 -C ${email(me, o)} -f ~/.ssh/id_ed25519 -N ""`, 'gh ssh-key add ~/.ssh/id_ed25519.pub --title laptop', 'ssh -T git@git.lab (should greet you by name)', `git clone ${ssh(full)}`, `cd ${o.project}; echo "${line}" >> TEAM.md; git commit -am "..."; git push`],
        tips: ['ssh-keygen -t ed25519 -C EMAIL', 'gh ssh-key add FILE.pub', 'ssh -T git@git.lab', 'git remote -v'],
      }),
      hints: ['Only the .pub file leaves your machine; the private key stays in ~/.ssh with mode 600.', '"Permission denied (publickey)" means the forge does not know the key you offered.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o, { sshKey: false, protocol: 'https', scopes: ['repo', 'workflow', 'read:org', 'admin:public_key'] }), [lead.sam]: fuser(lead, o) }, repos: { [full]: { members: { [me.sam]: 'write' }, commits: [C('Start team page', lead, o, { 'TEAM.md': `# ${o.org} team\n${lead.name} - lead\n` })] } } } }),
      checks: [
        file('You have a key pair', `${home}/.ssh/id_ed25519.pub`, { pattern: `^ssh-ed25519 \\S+ ${email(me, o).replace(/\./g, '\\.')}` }),
        forge('The forge knows your public key', full, { sshKeys: { user: me.sam } }),
        out('Your clone uses SSH', `cd ${home}/${o.project} && git remote get-url origin`, { equals: ssh(full) }),
        forge('Your commit reached the forge', full, { branch: { name: 'main', message: `^Add ${me.given} to the team$`, file: { path: 'TEAM.md', contains: line } } }),
      ],
      solution: [`ssh-keygen -t ed25519 -C ${email(me, o)} -f ~/.ssh/id_ed25519 -N ""`, 'gh ssh-key add ~/.ssh/id_ed25519.pub --title laptop', 'ssh -T git@git.lab', `git clone -q ${ssh(full)}`, `cd ${o.project} && echo "${line}" >> TEAM.md && git commit -qam "Add ${me.given} to the team" && git push`],
      realityNote: 'GitHub, GitLab and Bitbucket all work this way; ssh -T git@github.com is the standard first test of a new key.',
    };
  }),
  tmpl(3, 1, 'intermediate', 'tracking-branches', 'Integrate a teammate\'s push and track a remote branch', 'E4', 25, 'Fetch, read ahead/behind, rebase your local commit, push, and set up a tracking branch.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const full = `${o.org}/${o.project}`;
    const feat = v.pick(['reports', 'mobile-layout', 'bulk-sms']);
    const base = C('Initial app', mate, o, { 'app.sh': '#!/bin/bash\necho app\n', 'NOTES.md': '# Notes\n' });
    const theirs = C('Add health check', mate, o, { 'health.sh': '#!/bin/bash\necho ok\n' });
    const mine = C('Document deployment', me, o, { 'NOTES.md': '# Notes\nDeploy with ./deploy.sh\n' });
    const seed = { users: { [me.sam]: fuser(me, o), [mate.sam]: fuser(mate, o) }, repos: { [full]: { members: { [me.sam]: 'write' as const, [mate.sam]: 'write' as const }, commits: [base, theirs], seed: { branches: { [feat]: { from: 1, commits: [C(`Start ${feat}`, mate, o, { [`${feat}.md`]: `# ${feat}\n` })] } } } } } };
    const local = repo(me.sam, `${home}/${o.project}`, [base, mine], {}, { origin: ssh(full) });
    mutate(local, `${home}/${o.project}`, (st) => {
      const first = Object.values(st.commits).find((c) => !c.parents.length)!.id;
      st.remoteRefs = { 'origin/main': first, 'origin/HEAD': first };
    });
    return {
      instructions: lab({
        situation: `Your clone **~/${o.project}** has one local commit ("Document deployment") that is not pushed. Meanwhile ${mate.given} pushed "Add health check" to main and a new branch **${feat}**.\n\n1. find out how far you are ahead/behind (fetch first);\n2. bring in ${mate.given}'s work by **rebasing** your commit on top of it (no merge commit), and push;\n3. create a local branch **${feat}** that **tracks** origin/${feat}.`,
        steps: ['git fetch', 'git status -sb (ahead 1, behind 1)', 'git pull --rebase', 'git push', `git switch ${feat} (creates it from origin/${feat} and sets the upstream)`, 'git branch -vv'],
        tips: ['git fetch', 'git status -sb', 'git log --oneline --graph --all', 'git branch -vv'],
      }),
      hints: ['fetch only downloads; pull = fetch + merge (or rebase).', 'git switch NAME creates a tracking branch when origin/NAME exists and no local NAME does.'],
      initialState: withForge({ me, org: o, seed, files: local }),
      checks: [
        forge('main on the forge has both commits in a line', full, { branch: { name: 'main', message: '^Document deployment$', linear: true, authors: [me.name, mate.name], file: { path: 'NOTES.md', contains: 'deploy.sh' } } }),
        out(`${feat} tracks origin/${feat}`, `cd ${home}/${o.project} && git rev-parse --abbrev-ref ${feat}@{upstream}`, { equals: `origin/${feat}` }),
        out('Your main is level with origin/main', `cd ${home}/${o.project} && git rev-list --left-right --count main...origin/main`, { equals: '0\t0' }),
      ],
      solution: [`cd ~/${o.project} && git fetch`, 'git status -sb', 'git pull --rebase', 'git push', `git switch ${feat}`, 'git branch -vv'],
      realityNote: 'pull --rebase keeps shared branches linear; many teams set pull.rebase=true so it is the default.',
    };
  }),
  tmpl(3, 1, 'advanced', 'token-not-in-url', 'Take a token out of a remote URL', 'E4', 25, 'Remove an embedded token, store credentials properly, and push over HTTPS.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const full = `${o.org}/${o.project}`;
    const token = simToken(me.sam);
    const bad = `https://${me.sam}:${token}@git.lab/${full}.git`;
    const local = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })], {}, { origin: bad });
    return {
      instructions: lab({
        situation: `**~/${o.project}** was cloned with your personal access token **inside the URL**. The token now shows in \`git remote -v\`, in .git/config and in your shell history.\n\n1. set the origin URL to the plain **${https(full)}**;\n2. let Git get the token from gh instead (gh is already logged in);\n3. commit a new file **SECURITY.md** (any content, message \`Add security notes\`) and push over HTTPS.\n\nThe token must not appear anywhere in **~/${o.project}/.git/config**.`,
        steps: ['git remote -v', `git remote set-url origin ${https(full)}`, 'gh auth setup-git (configures the credential helper)', 'echo "Report issues to ..." > SECURITY.md; git add SECURITY.md; git commit -m "Add security notes"; git push'],
        tips: ['git remote set-url origin URL', 'gh auth setup-git', 'git config --global --list | grep credential'],
      }),
      hints: ['A token is a password: anything that prints your config or history leaks it.', 'A credential helper hands Git the token when the server asks, without storing it in the URL.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o, { sshKey: false, protocol: 'https' }) }, repos: { [full]: { commits: [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })] } } }, files: local }),
      checks: [
        out('The URL has no token', `cd ${home}/${o.project} && git remote get-url origin`, { equals: https(full) }),
        file('.git/config has no token', `${home}/${o.project}/.git/config`, { notContains: token }),
        forge('The push over HTTPS worked', full, { branch: { name: 'main', message: '^Add security notes$', file: { path: 'SECURITY.md', pattern: '\\S' } } }),
      ],
      solution: [`cd ~/${o.project} && git remote set-url origin ${https(full)}`, 'gh auth setup-git', 'echo "Report security issues privately." > SECURITY.md', 'git add SECURITY.md && git commit -q -m "Add security notes"', 'git push'],
      realityNote: 'Leaked tokens in URLs and CI logs are a common breach path; forges scan for them and revoke on sight, which is why credential helpers exist.',
    };
  }),

  /* ---------------------------------------------------------------- 3.2 forges: issues, pull requests, reviews, protected branches */
  tmpl(3, 2, 'beginner', 'issue-and-pr', 'Open an issue and a pull request that closes it', 'E4', 25, 'File an issue, fix it on a branch, and open a pull request linked to the issue.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const lead = v.person();
    const full = `${o.org}/${o.project}`;
    const bug = v.pick([
      { title: 'Prices shown in USD instead of GHS', file: 'config.ini', from: 'currency=USD', to: 'currency=GHS' },
      { title: 'Footer shows last year', file: 'footer.html', from: '2025', to: '2026' },
      { title: 'Support e-mail address is wrong', file: 'contact.txt', from: 'help@exmaple.org', to: 'help@example.org' },
    ]);
    const branch = `fix-${bug.file.split('.')[0]}`;
    return {
      instructions: lab({
        situation: `In **${full}** (cloned at ~/${o.project}):\n\n1. open an issue titled \`${bug.title}\`;\n2. on a branch **${branch}**, change \`${bug.from}\` to \`${bug.to}\` in **${bug.file}** and push it;\n3. open a pull request into main whose description says \`Closes #N\` (N = the issue number), so that merging it will close the issue.`,
        steps: [`gh issue create -t "${bug.title}" -b "..."`, `git switch -c ${branch}; edit ${bug.file}; git commit -am "..."`, `git push -u origin ${branch}`, 'gh pr create -t "..." -b "Closes #1"', 'gh pr view'],
        tips: ['gh issue create', 'gh issue list', 'gh pr create -t TITLE -b BODY', 'gh pr view'],
      }),
      hints: ['"Closes #N", "Fixes #N" or "Resolves #N" in a pull request links the issue and closes it on merge.', 'Push the branch before creating the pull request.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [lead.sam]: fuser(lead, o) }, repos: { [full]: { members: { [me.sam]: 'write' }, commits: [C('Initial site', lead, o, { [bug.file]: `${bug.from}\n` })], clones: { [me.sam]: '' } } } } }),
      checks: [
        forge('The issue exists', full, { issue: { title: `^${bug.title}$`, state: 'OPEN' } }),
        forge('The fix is pushed', full, { branch: { name: branch, file: { path: bug.file, contains: bug.to } } }),
        forge('The pull request closes the issue', full, { pr: { head: branch, base: 'main', state: 'OPEN', body: '(close[sd]?|fix(e[sd])?|resolve[sd]?) #1\\b' } }),
      ],
      solution: [`cd ~/${o.project} && gh issue create -t "${bug.title}" -b "Reported by finance."`, `git switch -c ${branch}`, `sed -i 's/${bug.from.replace(/[.@]/g, '\\$&')}/${bug.to}/' ${bug.file}`, `git commit -qam "${bug.title.replace(/ .*/, '')} fix" && git push -u origin ${branch}`, `gh pr create -t "Fix: ${bug.title}" -b "Closes #1"`],
      realityNote: 'Linking issues and pull requests gives the audit trail from a reported problem to the code that fixed it.',
    };
  }),
  tmpl(3, 2, 'intermediate', 'protect-main', 'Protect the main branch through the API', 'E4', 25, 'Require reviews and a passing check on main, block force pushes and deletions, and apply it to admins.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const full = `${o.org}/${o.project}`;
    const n = v.int(1, 2);
    const check = v.pick(['test', 'build', 'lint']);
    return {
      instructions: lab({
        situation: `You administer **${full}**. Protect **main**:\n\n- pull requests need **${n}** approving review${n > 1 ? 's' : ''};\n- the status check **${check}** must pass;\n- no force pushes, no deleting the branch;\n- the rules apply to administrators too.\n\nUse the REST API through \`gh api\`: write the settings as JSON in **~/protection.json** and PUT them to \`repos/${full}/branches/main/protection\`.`,
        steps: ['Write ~/protection.json with required_status_checks, enforce_admins, required_pull_request_reviews, restrictions (null), allow_force_pushes and allow_deletions', `gh api -X PUT repos/${full}/branches/main/protection --input ~/protection.json`, `gh api repos/${full}/branches/main/protection`],
        tips: [`{\n  "required_status_checks": { "strict": true, "contexts": ["${check}"] },\n  "enforce_admins": true,\n  "required_pull_request_reviews": { "required_approving_review_count": ${n} },\n  "restrictions": null,\n  "allow_force_pushes": false,\n  "allow_deletions": false\n}`, 'gh api -X PUT ... --input FILE'],
      }),
      hints: ['The API refuses the PUT unless all four required fields are present (restrictions may be null).', 'Without enforce_admins, administrators can still push straight to main.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })] } } } }),
      checks: [forge('main is protected as asked', full, { protection: { branch: 'main', reviews: n, checks: [check], forcePush: false, deletions: false, enforceAdmins: true } }), file('The settings file', `${home}/protection.json`, { contains: 'required_pull_request_reviews' })],
      solution: [`printf '{"required_status_checks":{"strict":true,"contexts":["${check}"]},"enforce_admins":true,"required_pull_request_reviews":{"required_approving_review_count":${n}},"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}\\n' > ~/protection.json`, `gh api -X PUT repos/${full}/branches/main/protection --input ~/protection.json`, `gh api repos/${full}/branches/main/protection --jq .required_pull_request_reviews`],
      realityNote: 'Keeping protection as JSON (or Terraform) in a repository lets teams review and reapply it, instead of clicking settings by hand.',
    };
  }),
  tmpl(3, 2, 'advanced', 'review-and-merge', 'Take a pull request from failing to merged', 'E4', 35, 'Review a teammate\'s failing pull request, get the fix pushed, approve and squash-merge it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const full = `${o.org}/${o.project}`;
    const file2 = v.pick(['rates.conf', 'limits.conf', 'fees.conf']);
    const key = file2.split('.')[0].replace(/s$/, '');
    const val = v.int(10, 90);
    const checker = `#!/bin/bash\n# Every line must look like name=number.\nwhile IFS= read -r line; do\n  [[ "$line" =~ ^[a-z_]+=[0-9]+$ ]] || { echo "bad line: $line"; exit 1; }\ndone < ${file2}\necho "${file2} OK"\n`;
    const seed = {
      users: { [me.sam]: fuser(me, o), [mate.sam]: fuser(mate, o) },
      repos: {
        [full]: {
          members: { [mate.sam]: 'write' as const },
          commits: [C('Add settings and CI', me, o, { [file2]: `${key}_min=1\n`, 'check.sh': checker, '.github/workflows/ci.yml': CHECK_WF('./check.sh') })],
          seed: { executable: ['check.sh'], branches: { [`add-${key}-max`]: { from: 0, commits: [C(`Add ${key} maximum`, mate, o, { [file2]: `${key}_min=1\n${key}_max = ${val}\n` })] } } },
          protection: { main: { required_pull_request_reviews: { required_approving_review_count: 1 }, required_status_checks: { contexts: ['test'] } } },
          clones: { [me.sam]: '', [mate.sam]: '' },
        },
      },
      prs: [{ repo: full, title: `Add ${key} maximum`, author: mate.sam, head: `add-${key}-max`, body: `Adds the ${key} maximum.` }],
    };
    return {
      instructions: lab({
        situation: `${mate.given} opened pull request **#1** on **${full}**, but its CI check fails. main is protected (1 approval + the **test** check).\n\n1. as yourself, look at the failing check and **request changes**, saying what is wrong;\n2. as ${mate.given} (\`su - ${mate.sam}\`; their clone is ~/${o.project}), fix **${file2}** on the branch and push;\n3. back as yourself, **approve** and **squash-merge** #1, deleting the branch.`,
        steps: ['gh pr checks 1; gh run view --log-failed', 'gh pr review 1 --request-changes -b "..."', `su - ${mate.sam}; cd ${o.project}; git switch add-${key}-max; fix; git commit -am ...; git push; exit`, 'gh pr checks 1', 'gh pr review 1 --approve', 'gh pr merge 1 --squash --delete-branch'],
        tips: ['gh pr checks 1', 'gh run view --log-failed', 'gh pr review N --request-changes -b TEXT', 'gh pr merge N --squash --delete-branch'],
      }),
      hints: [`The check only accepts lines like name=number, with no spaces around =.`, 'A new push to the branch reruns CI on the pull request.'],
      initialState: withForge({ me, org: o, seed }),
      checks: [
        forge('You requested changes first', full, { pr: { head: `add-${key}-max`, reviewState: 'CHANGES_REQUESTED', reviewer: me.sam } }),
        forge('You approved, and #1 was squash-merged', full, { pr: { head: `add-${key}-max`, state: 'MERGED', approvedBy: me.sam, merged: 'squash' } }),
        forge('main has the fixed line', full, { branch: { name: 'main', file: { path: file2, contains: `${key}_max=${val}` }, message: `\\(#1\\)` } }),
        forge('CI passed on main after the merge', full, { run: { branch: 'main', event: 'push', conclusion: 'success' } }),
      ],
      solution: [
        `cd ~/${o.project} && gh pr checks 1`,
        'gh run view --log-failed',
        `gh pr review 1 --request-changes -b "check.sh fails: ${file2} needs ${key}_max=${val} with no spaces"`,
        `su - ${mate.sam}`,
        `cd ${o.project} && git switch add-${key}-max && sed -i 's/ = /=/' ${file2} && git commit -qam "Fix ${key} maximum format" && git push`,
        'exit',
        `cd ~/${o.project} && gh pr checks 1`,
        'gh pr review 1 --approve',
        'gh pr merge 1 --squash --delete-branch',
      ],
      realityNote: 'Required reviews plus required checks are the standard guard for shared branches on every forge.',
    };
  }),

  /* ---------------------------------------------------------------- 3.3 forking, feature-branch and trunk-based development; GitFlow */
  tmpl(3, 3, 'beginner', 'choose-a-workflow', 'Choose a branching workflow', 'E10', 15, 'Match forking, feature branches, trunk-based development and GitFlow to three teams.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## Three teams, three needs\n\nYou advise three teams on how to branch: ${o.org}'s small product team, a public open-source library, and a team that ships a mobile app through app-store releases.`,
      steps: [
        { title: `${o.org}: five developers, deploying daily`, text: 'They want fast feedback and few merge headaches.', choices: [{ text: 'Trunk-based: short-lived branches (hours to a day) merged to main behind CI, with feature flags for unfinished work', right: true, feedback: 'Correct. Small, frequent merges keep conflicts small and main always deployable.' }, { text: 'GitFlow with develop, release and hotfix branches', feedback: 'Heavy ceremony for a team that deploys every day.' }, { text: 'Everyone pushes to main without review', feedback: 'Fast, but no review and no CI gate.' }] },
        { title: 'Open-source library', text: 'Anyone may contribute; only maintainers can write to the repository.', choices: [{ text: 'Forking: contributors push to their own fork and open pull requests to the upstream repository', right: true, feedback: 'Correct. Forks let strangers propose changes without write access.' }, { text: 'Give every contributor write access', feedback: 'Unsafe: anyone could push anything.' }, { text: 'Accept patches only by e-mail', feedback: 'Possible (the Linux kernel does), but pull requests give review and CI.' }] },
        { title: 'App-store releases', text: 'Releases are reviewed by the store for days; old versions need hotfixes.', choices: [{ text: 'Release branches (GitFlow or similar) so a release can be stabilised and hot-fixed while main moves on', right: true, feedback: 'Correct. Long release cycles are what release branches are for.' }, { text: 'Trunk-based with no release branches', feedback: 'Then a hotfix for the shipped version also ships everything merged since.' }, { text: 'One branch per developer forever', feedback: 'Long-lived personal branches drift and conflict.' }] },
        { title: 'Feature branches everywhere', text: 'All three use feature branches and pull requests.', choices: [{ text: 'Keep them short-lived and small: the longer a branch lives, the harder it is to merge', right: true, feedback: 'Correct. Branch lifetime is the main cause of painful merges.' }, { text: 'Let each feature branch live until the feature is perfect', feedback: 'Weeks-old branches collide with everything.' }, { text: 'Merge feature branches into each other to share work', feedback: 'That creates tangled dependencies; share through main.' }] },
      ],
      ending: { title: 'Workflow follows release cadence', text: 'Trunk-based for continuous deployment, forks for open contribution, release branches for slow, versioned releases; and keep every branch short-lived.' },
      hints: ['Ask how often each team releases and who may write to the repository.', 'Long-lived branches are the enemy of easy merges.'],
      realityNote: 'Google and Meta work trunk-based at huge scale; GitFlow\'s author now recommends simpler flows for web apps that deploy continuously.',
    });
  }),
  tmpl(3, 3, 'intermediate', 'fork-and-contribute', 'Sync a fork and contribute through a pull request', 'E4', 30, 'Clone your fork, bring it level with upstream, and open a pull request from a branch on the fork.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const maint = v.person();
    const up = `${o.org}/${o.project}`;
    const fork = `${me.sam}/${o.project}`;
    const word = v.pick(['Twi', 'Ewe', 'Hausa', 'Ga']);
    const base = [C('Initial library', maint, o, { 'README.md': `# ${o.project}\n`, 'lang/en.txt': 'hello=Hello\n' })];
    const newer = [...base, C('Add French', maint, o, { 'lang/fr.txt': 'hello=Bonjour\n' })];
    const branch = `add-${word.toLowerCase()}`;
    return {
      instructions: lab({
        situation: `**${up}** is an open-source project you cannot write to. You forked it earlier to **${fork}**, but upstream has moved on ("Add French"). Contribute a ${word} translation:\n\n1. clone your fork (with gh, so **upstream** is set up as a second remote);\n2. bring your fork's **main** level with upstream's main and push it to your fork;\n3. on a branch **${branch}**, add **lang/${word.toLowerCase()}.txt** with a line \`hello=...\`, push the branch to your fork;\n4. open a pull request **into ${up}**.`,
        steps: [`gh repo clone ${fork}`, 'cd ' + o.project + '; git remote -v (origin = your fork, upstream = the project)', 'git fetch upstream; git merge --ff-only upstream/main; git push origin main', `git switch -c ${branch}; ...; git push -u origin ${branch}`, 'gh pr create --fill (targets upstream)'],
        tips: ['gh repo clone OWNER/REPO', 'git fetch upstream', 'git merge --ff-only upstream/main', 'gh pr create -t ... -b ...'],
      }),
      hints: ['Your fork does not update itself: sync it from upstream before starting work.', 'The pull request goes from your-fork:branch to upstream:main.'],
      initialState: withForge({ me, org: o, access: { [up]: 'none' }, seed: { users: { [me.sam]: fuser(me, o), [maint.sam]: fuser(maint, o) }, repos: { [up]: { visibility: 'public', commits: newer }, [fork]: { visibility: 'public', commits: base, forkOf: up } } } }),
      checks: [
        forge('Your fork\'s main is level with upstream', fork, { branch: { name: 'main', message: '^Add French$' } }),
        forge('Your branch is on the fork', fork, { branch: { name: branch, file: { path: `lang/${word.toLowerCase()}.txt`, pattern: '^hello=\\S' } } }),
        forge('The pull request goes from your fork to upstream', up, { pr: { head: branch, base: 'main', fromFork: true, state: 'OPEN' } }),
      ],
      solution: [`gh repo clone ${fork}`, `cd ${o.project} && git fetch -q upstream`, 'git merge --ff-only upstream/main', 'git push origin main', `git switch -c ${branch}`, `echo "hello=Akwaaba" > lang/${word.toLowerCase()}.txt`, `git add lang && git commit -qm "Add ${word} translation" && git push -u origin ${branch}`, `gh pr create -t "Add ${word} translation" -b "Adds a ${word} greeting."`],
      realityNote: 'This is the everyday open-source flow on GitHub and GitLab; maintainers often ask contributors to rebase on upstream before review.',
    };
  }),
  tmpl(3, 3, 'advanced', 'gitflow-release', 'Cut a GitFlow release', 'E4', 30, 'Create a release branch from develop, finish it into main with a tag, and merge it back.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const minor = v.int(2, 8);
    const ver = `1.${minor}.0`;
    const commits = [C('Initial release', mate, o, { 'VERSION': `1.${minor - 1}.0\n`, 'app.sh': '#!/bin/bash\n' })];
    const dev2 = [C('Add search', mate, o, { 'search.sh': '#!/bin/bash\n' }), C('Add export', me, o, { 'export.sh': '#!/bin/bash\n' })];
    const local = repo(me.sam, `${home}/${proj}`, commits, { [`v1.${minor - 1}.0`]: 0 }, { origin: `/srv/git/${proj}.git`, branches: { develop: { from: 0, commits: dev2 } } });
    const remote = bare(me.sam, `/srv/git/${proj}.git`, commits, { [`v1.${minor - 1}.0`]: 0 }, { branches: { develop: { from: 0, commits: dev2 } } });
    return {
      instructions: lab({
        situation: `**~/${proj}** uses GitFlow: **develop** collects finished features, **main** only holds releases. Release **${ver}**:\n\n1. create **release/${ver}** from develop and set **VERSION** to \`${ver}\` there (commit: \`Bump version to ${ver}\`);\n2. merge the release branch into **main** with \`--no-ff\` and tag that merge **v${ver}** (annotated, message \`Release ${ver}\`);\n3. merge the release branch back into **develop** (\`--no-ff\`) and delete it;\n4. push main, develop and the tag.`,
        steps: [`git switch -c release/${ver} develop`, `echo ${ver} > VERSION; git commit -am "Bump version to ${ver}"`, `git switch main; git merge --no-ff --no-edit release/${ver}; git tag -a v${ver} -m "Release ${ver}"`, `git switch develop; git merge --no-ff --no-edit release/${ver}; git branch -d release/${ver}`, `git push origin main develop; git push origin v${ver}`],
        tips: ['git switch -c NEW START', 'git merge --no-ff --no-edit BRANCH', 'git tag -a NAME -m MSG', 'git log --oneline --graph --all'],
      }),
      hints: ['The tag goes on main\'s merge commit: that is the code that ships.', 'Merging back keeps the version bump (and any release fixes) on develop.'],
      initialState: dev({ me, org: o, files: { ...local, ...remote, '/srv/git/': { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('main has the release as a merge commit, tagged', `git -C /srv/git/${proj}.git log -1 --format=%s main; git -C /srv/git/${proj}.git log -1 --format=%p main | wc -w; git -C /srv/git/${proj}.git describe --exact-match main`, { equals: `Merge branch 'release/${ver}'
2
v${ver}` }),
        out('VERSION on main and develop', `git -C /srv/git/${proj}.git show main:VERSION; git -C /srv/git/${proj}.git show develop:VERSION`, { equals: `${ver}\n${ver}` }),
        out('develop has the release merged back', `git -C /srv/git/${proj}.git log -1 --format=%s develop`, { pattern: `^Merge branch 'release/${ver.replace(/\./g, '\\.')}' into develop$` }),
        out('The tag is annotated', `git -C /srv/git/${proj}.git cat-file -t v${ver}`, { equals: 'tag' }),
        out('The release branch is gone', `cd ${home}/${proj} && git branch --list 'release/*' | wc -l`, { equals: '0' }),
      ],
      solution: [`cd ~/${proj} && git switch -c release/${ver} develop`, `echo ${ver} > VERSION && git commit -qam "Bump version to ${ver}"`, 'git switch main', `git merge --no-ff --no-edit release/${ver}`, `git tag -a v${ver} -m "Release ${ver}"`, 'git switch develop', `git merge --no-ff --no-edit release/${ver}`, `git branch -d release/${ver}`, 'git push origin main develop', `git push origin v${ver}`],
      realityNote: 'GitFlow suits products with versioned releases (mobile apps, installed software); the git-flow extension automates exactly these steps.',
    };
  }),

  /* ---------------------------------------------------------------- 3.4 code review practice */
  tmpl(3, 4, 'beginner', 'review-comments', 'Write constructive review comments', 'E10', 15, 'Choose review comments that are specific, kind and actionable.', (v) => {
    const o = v.pick(ORGS);
    const a = v.person();
    return caseStudy(v, {
      intro: `## Reviewing ${a.given}'s first pull request\n\n${a.name} joined ${o.org} last week and opened a pull request adding SMS receipts to the ${o.what}. It works, but you notice a hard-coded phone number, no tests, and a 400-line function.`,
      steps: [
        { title: 'The hard-coded number', text: 'sms.sh contains `SENDER=0244000000`.', choices: [{ text: '"sms.sh line 3: could the sender number come from config, so ops can change it without a release? See config.ini for how we do the gateway URL."', right: true, feedback: 'Correct. Specific (file, line), explains why, points to an example.' }, { text: '"Never hard-code things."', feedback: 'True but vague and curt: what should change, and where?' }, { text: 'Say nothing; it works', feedback: 'Then every number change needs a code release.' }] },
        { title: 'No tests', text: 'There are no tests for the new code.', choices: [{ text: '"Could you add a test for the receipt text? tests/test_sms.bats has a pattern you can copy. Happy to pair on it."', right: true, feedback: 'Correct. Asks for the change, gives a starting point, offers help.' }, { text: '"Where are the tests???"', feedback: 'Reads as an accusation, especially to a newcomer.' }, { text: 'Write the tests yourself silently after merging', feedback: 'They miss the chance to learn the team\'s practice.' }] },
        { title: 'The long function', text: 'send_receipt() is 400 lines.', choices: [{ text: 'Mark it as a suggestion ("nit"/"optional") and propose splitting it in a follow-up, so this pull request can merge', right: true, feedback: 'Correct. Separate blocking problems from preferences; keep pull requests moving.' }, { text: 'Block the pull request until it is rewritten', feedback: 'Style preferences should rarely block a working change.' }, { text: 'Rewrite it in your own branch and push over theirs', feedback: 'Takes ownership away and surprises the author.' }] },
        { title: 'Tone', text: 'Your overall comment.', choices: [{ text: 'Start with what is good, list the two requested changes clearly, and mark which are blocking', right: true, feedback: 'Correct. Clear expectations and a respectful tone make reviews fast.' }, { text: '"LGTM" and approve to be nice', feedback: 'Approving known problems is not kindness.' }, { text: 'A long essay on coding standards', feedback: 'Link to the standards instead.' }] },
      ],
      ending: { title: 'Reviews that help', text: 'Point to the exact line, explain why, suggest how, and separate blocking issues from nits, kindly.' },
      hints: ['Good comments are specific, explain the reason and suggest a way forward.', 'Distinguish "must change" from "nice to have".'],
      realityNote: "Google's public code review guide makes the same points: the reviewer's job is to improve code health without blocking progress.",
    });
  }),
  tmpl(3, 4, 'intermediate', 'split-the-change', 'Split mixed work into two small pull requests', 'E4', 30, 'Turn two unrelated uncommitted changes into two branches and two focused pull requests.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const lead = v.person();
    const home = `/home/${me.sam}`;
    const full = `${o.org}/${o.project}`;
    const t = v.int(20, 60);
    return {
      instructions: lab({
        situation: `In **~/${o.project}** you have two **unrelated** uncommitted changes on main: a bug fix in **app.conf** (timeout raised to ${t}) and a documentation update in **README.md**. Reviewers want one concern per pull request.\n\n1. put the app.conf change alone on branch **fix-timeout** and open a pull request;\n2. put the README.md change alone on branch **docs-readme** and open a second pull request.\n\nEach branch must contain only its own change.`,
        steps: ['git status; git diff', 'git switch -c fix-timeout; git add app.conf; git commit -m "..."; git push -u origin fix-timeout; gh pr create --fill', 'git switch main (README change comes along, uncommitted)', 'git switch -c docs-readme; git commit -am "..."; git push -u origin docs-readme; gh pr create --fill'],
        tips: ['git add FILE (stage only one file)', 'git switch -c NAME (uncommitted changes come with you)', 'gh pr create --fill'],
      }),
      hints: ['Uncommitted changes travel with you when you switch branches, as long as they do not clash.', 'Small pull requests get reviewed faster and are easier to revert.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [lead.sam]: fuser(lead, o) }, repos: { [full]: { members: { [me.sam]: 'write' }, commits: [C('Initial app', lead, o, { 'app.conf': 'timeout=10\n', 'README.md': '# App\n' })], clones: { [me.sam]: '' } } } }, files: owned({ [`${home}/${o.project}/app.conf`]: `timeout=${t}\n`, [`${home}/${o.project}/README.md`]: '# App\n\nRun ./app.sh to start.\n' }, me.sam) }),
      checks: [
        forge('fix-timeout has only the config change', full, { branch: { name: 'fix-timeout', file: { path: 'app.conf', equals: `timeout=${t}` } } }),
        forge('fix-timeout does not touch README.md', full, { branch: { name: 'fix-timeout', file: { path: 'README.md', equals: '# App' } } }),
        forge('docs-readme has only the README change', full, { branch: { name: 'docs-readme', file: { path: 'README.md', contains: 'Run ./app.sh' } } }),
        forge('docs-readme does not touch app.conf', full, { branch: { name: 'docs-readme', file: { path: 'app.conf', equals: 'timeout=10' } } }),
        forge('A pull request for the fix', full, { pr: { head: 'fix-timeout', state: 'OPEN' } }),
        forge('A pull request for the docs', full, { pr: { head: 'docs-readme', state: 'OPEN' } }),
      ],
      solution: [`cd ~/${o.project} && git switch -c fix-timeout`, 'git add app.conf && git commit -qm "Raise timeout" && git push -u origin fix-timeout', 'gh pr create --fill', 'git switch main', 'git switch -c docs-readme', 'git commit -qam "Document how to start the app" && git push -u origin docs-readme', 'gh pr create --fill'],
      realityNote: 'Studies of code review find that defect detection drops sharply beyond a few hundred changed lines; splitting work is a core reviewing courtesy.',
    };
  }),
  tmpl(3, 4, 'advanced', 'review-with-evidence', 'Find the bug in a pull request and request changes', 'E4', 30, 'Read a diff, run the code, and write a precise review that requests changes.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const full = `${o.org}/${o.project}`;
    const limit = v.int(3, 9);
    const script = `#!/bin/bash\n# Allow at most ${limit} login attempts.\nattempts=$1\nif [ "$attempts" -lt ${limit} ]; then\n  echo allow\nelse\n  echo block\nfi\n`;
    return {
      instructions: lab({
        situation: `${mate.given} opened pull request **#1** on **${full}** ("Limit login attempts"). The rule is: at most **${limit}** attempts are **allowed**. Review it:\n\n1. read the diff and try the script (in your clone, \`gh pr checkout 1\`);\n2. request changes with a comment that names the problem precisely as \`login-guard.sh:4\` (file:line) and says what should change.`,
        steps: ['gh pr diff 1', 'gh pr checkout 1', `bash login-guard.sh ${limit} (should print allow)`, 'gh pr review 1 --request-changes -b "login-guard.sh:4 ..."'],
        tips: ['gh pr diff N', 'gh pr checkout N', 'gh pr review N --request-changes -b TEXT'],
      }),
      hints: [`Try the edge: exactly ${limit} attempts.`, '-lt is "less than", -le is "less than or equal".'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [mate.sam]: fuser(mate, o) }, repos: { [full]: { members: { [mate.sam]: 'write' }, commits: [C('Initial app', me, o, { 'README.md': '# App\n' })], seed: { branches: { 'login-limit': { from: 0, commits: [C('Limit login attempts', mate, o, { 'login-guard.sh': script })] } } }, clones: { [me.sam]: '' } } }, prs: [{ repo: full, title: 'Limit login attempts', author: mate.sam, head: 'login-limit', body: `Blocks after ${limit} attempts.` }] } }),
      checks: [forge('Your review requests changes and points at the line', full, { pr: { head: 'login-limit', reviewState: 'CHANGES_REQUESTED', reviewer: me.sam, reviewBody: 'login-guard\\.sh:4[\\s\\S]*(-le|<=|less than or equal|off.by.one|equal)' } })],
      solution: [`cd ~/${o.project} && gh pr diff 1`, 'gh pr checkout 1', `bash login-guard.sh ${limit}`, `gh pr review 1 --request-changes -b "login-guard.sh:4 blocks at exactly ${limit} attempts; use -le ${limit} so ${limit} attempts are still allowed (off by one)."`],
      realityNote: 'Off-by-one errors at boundaries are among the most common bugs reviewers catch; running the edge case beats reading alone.',
    };
  }),

  /* ---------------------------------------------------------------- 3.5 semantic versioning and releases */
  tmpl(3, 5, 'beginner', 'next-version', 'Choose the next semantic version', 'E4', 20, 'Read the commits since the last release and tag the right major, minor or patch version.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const [ma, mi, pa] = [v.int(1, 3), v.int(0, 9), v.int(0, 9)];
    const kind = v.pick(['patch', 'minor', 'major']);
    const msgs = kind === 'patch' ? ['fix: round fees half up', 'docs: explain refunds'] : kind === 'minor' ? ['fix: trim phone numbers', 'feat: export receipts as CSV'] : ['feat: add bulk payments', 'feat!: rename the /pay endpoint to /payments'];
    const next = kind === 'major' ? `${ma + 1}.0.0` : kind === 'minor' ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
    const cur = `v${ma}.${mi}.${pa}`;
    return {
      instructions: lab({
        situation: `**${full}** follows Semantic Versioning (MAJOR.MINOR.PATCH) and Conventional Commits. The last release is **${cur}**. Look at the commits since then, decide the next version, and create an **annotated** tag \`v<version>\` (message \`Release <version>\`) on main in your clone **~/${o.project}**, then push the tag.\n\nRules: \`fix:\` → patch; \`feat:\` → minor; \`!\` after the type or "BREAKING CHANGE" → major.`,
        steps: [`git log --oneline ${cur}..main`, 'Decide: the biggest change wins.', 'git tag -a vX.Y.Z -m "Release X.Y.Z"', 'git push origin vX.Y.Z'],
        tips: ['git log --oneline TAG..main', 'git describe --tags', 'git push origin TAG'],
      }),
      hints: ['A breaking change resets minor and patch to 0; a feature resets patch to 0.', 'Docs and fixes never bump the minor version.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: [C('feat: first release', me, o, { 'app.sh': '#!/bin/bash\n' }), C(msgs[0], me, o, { 'a.txt': '1\n' }), C(msgs[1], me, o, { 'b.txt': '2\n' })], tags: { [cur]: 0 }, clones: { [me.sam]: '' } } } } }),
      checks: [forge(`The forge has tag v${next}`, full, { tag: { name: `v${next}`, target: 'main', annotated: true } })],
      solution: [`cd ~/${o.project} && git log --oneline ${cur}..main`, `git tag -a v${next} -m "Release ${next}"`, `git push origin v${next}`],
      realityNote: 'Tools such as semantic-release and release-please compute the version from Conventional Commits automatically, exactly by these rules.',
    };
  }),
  tmpl(3, 5, 'intermediate', 'publish-a-release', 'Build and publish a release with an asset', 'E4', 25, 'Build a tarball with make, then create a forge release with notes and the tarball attached.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const full = `${o.org}/${o.project}`;
    const ver = `${v.int(1, 2)}.${v.int(0, 9)}.${v.int(0, 9)}`;
    const mk = `VERSION := $(shell cat VERSION)\nNAME := ${o.project}-$(VERSION)\n\n.PHONY: dist clean\n\ndist:\n\tmkdir -p dist\n\ttar -czf dist/$(NAME).tar.gz src\n\t@echo built dist/$(NAME).tar.gz\n\nclean:\n\trm -rf dist\n`;
    const notes = `## ${ver}\n- ${v.pick(['Faster start-up', 'Retry failed SMS', 'Clearer error messages'])}\n`;
    return {
      instructions: lab({
        situation: `Publish release **v${ver}** of **${full}** from your clone **~/${o.project}** (VERSION already says ${ver}):\n\n1. build the tarball with \`make dist\`;\n2. create the forge release **v${ver}** titled \`${o.project} ${ver}\`, with the notes from **NOTES.md**, and attach **dist/${o.project}-${ver}.tar.gz**.`,
        steps: ['make dist', `gh release create v${ver} dist/${o.project}-${ver}.tar.gz -t "${o.project} ${ver}" -F NOTES.md`, `gh release view v${ver}`],
        tips: ['make dist', 'gh release create TAG FILES... -t TITLE -F NOTES', 'gh release view TAG'],
      }),
      hints: ['gh release create also creates the tag on the forge when it does not exist yet.', 'Attaching built files lets servers download a release without building it.'],
      initialState: withForge({ me, org: o, packages: ['make'], seed: { users: { [me.sam]: fuser(me, o) }, repos: { [full]: { commits: [C('Prepare release', me, o, { 'VERSION': `${ver}\n`, 'Makefile': mk, 'NOTES.md': notes, 'src/app.sh': '#!/bin/bash\necho app\n' })], clones: { [me.sam]: '' } } } } }),
      checks: [forge('The release exists with notes and the tarball', full, { release: { tag: `v${ver}`, asset: `${o.project}-${ver}.tar.gz`, notes: notes.split('\n')[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } }), forge('The tag is on the forge', full, { tag: { name: `v${ver}` } })],
      solution: [`cd ~/${o.project} && make dist`, `gh release create v${ver} dist/${o.project}-${ver}.tar.gz -t "${o.project} ${ver}" -F NOTES.md`, `gh release view v${ver}`],
      realityNote: 'Release pages with checksummed assets are how most open-source tools are distributed; deployment scripts download from them.',
    };
  }),
  tmpl(3, 5, 'advanced', 'version-script', 'Script the next version from history', 'E4', 35, 'Write a script that reads the latest tag and the commits since, and prints the next semantic version.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const repos = [
      { name: 'alpha', tag: `v1.${v.int(0, 5)}.${v.int(0, 9)}`, msgs: ['fix: handle empty input', 'docs: usage'] },
      { name: 'beta', tag: `v2.${v.int(0, 5)}.${v.int(0, 9)}`, msgs: ['fix: typo', 'feat: add --json flag'] },
      { name: 'gamma', tag: `v0.${v.int(1, 9)}.${v.int(0, 9)}`, msgs: ['feat: new API', 'refactor!: drop the old config format'] },
      { name: 'delta', tag: `v3.${v.int(0, 5)}.${v.int(0, 9)}`, msgs: ['chore: update CI', 'feat: report\n\nBREAKING CHANGE: report.csv columns reordered'] },
    ];
    const next = (tag: string, msgs: string[]) => {
      const [M, m, p] = tag.slice(1).split('.').map(Number);
      if (msgs.some((x) => /^\w+(\(.+\))?!:/.test(x) || /BREAKING CHANGE/.test(x))) return `${M + 1}.0.0`;
      if (msgs.some((x) => /^feat(\(.+\))?:/.test(x))) return `${M}.${m + 1}.0`;
      return `${M}.${m}.${p + 1}`;
    };
    const files: Record<string, ReturnType<typeof repo>[string]> = {};
    for (const r of repos) Object.assign(files, repo(me.sam, `${home}/${r.name}`, [C('initial', me, o, { 'x.txt': '0\n' }), ...r.msgs.map((m, i) => C(m, me, o, { 'x.txt': `${i + 1}\n` }))], { [r.tag]: 0 }));
    return {
      instructions: lab({
        situation: `Write **~/bin/next-version**: run inside a repository, it prints the next version (without the v), based on the **latest tag** (vX.Y.Z) and the commit messages since it, using Conventional Commits:\n\n- any \`type!:\` subject or a \`BREAKING CHANGE\` line in a body → MAJOR+1, minor and patch 0;\n- else any \`feat:\` (or \`feat(scope):\`) → MINOR+1, patch 0;\n- else → PATCH+1.\n\nTest it in ~/alpha, ~/beta, ~/gamma and ~/delta.`,
        steps: ['tag=$(git describe --tags --abbrev=0)', 'log=$(git log --format=%B "$tag"..HEAD)', 'IFS=. read -r M m p <<< "${tag#v}"', 'grep -qE \'^[a-z]+(\\(.+\\))?!:|BREAKING CHANGE\' <<< "$log" → major; grep -qE \'^feat(\\(.+\\))?:\' → minor; else patch'],
        tips: ['git describe --tags --abbrev=0', 'git log --format=%B TAG..HEAD', 'IFS=. read -r a b c <<< "1.2.3"'],
      }),
      hints: ['%B prints the whole message, so BREAKING CHANGE in a body is seen.', 'Test the order: a breaking change wins over a feature.'],
      initialState: dev({ me, org: o, files }),
      checks: repos.map((r) => out(`${r.name}: ${r.tag} → ${next(r.tag, r.msgs)}`, `cd ${home}/${r.name} && ${home}/bin/next-version`, { equals: next(r.tag, r.msgs) })),
      solution: [
        'mkdir -p ~/bin',
        `cat > ~/bin/next-version <<'EOF'\n#!/bin/bash\nset -euo pipefail\ntag=$(git describe --tags --abbrev=0)\nlog=$(git log --format=%B "$tag"..HEAD)\nIFS=. read -r M m p <<< "\${tag#v}"\nif grep -qE '^[a-z]+(\\(.+\\))?!:|BREAKING CHANGE' <<< "$log"; then\n  echo "$((M + 1)).0.0"\nelif grep -qE '^feat(\\(.+\\))?:' <<< "$log"; then\n  echo "$M.$((m + 1)).0"\nelse\n  echo "$M.$m.$((p + 1))"\nfi\nEOF`,
        'chmod +x ~/bin/next-version',
        'cd ~/beta && ~/bin/next-version',
      ],
      realityNote: 'This is the core of release automation tools; writing it once shows why consistent commit messages pay off.',
    };
  }),
];

void https;
