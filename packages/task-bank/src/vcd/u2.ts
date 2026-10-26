/** Unit 2: Git basics: commit, history, branches and merges, undoing, rebase and the reflog. */

import type { TaskTemplate } from '../types';
import { C, ORGS, bare, dev, email, file, lab, mutate, out, owned, repo, tmpl } from './kit';

export const U2: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 2.1 init, status, add, commit; messages; .gitignore */
  tmpl(2, 1, 'beginner', 'first-commit', 'Start a repository and ignore what does not belong', 'E4', 15, 'git init a project, ignore logs, build output and secrets, and make the first commit.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const build = v.pick(['build', 'dist', 'out']);
    const log = v.pick(['app.log', 'debug.log', 'server.log']);
    const code = { 'README.md': `# ${o.what}\n`, 'src/main.sh': `#!/bin/bash\necho "${proj}"\n`, 'src/util.sh': 'say() { echo "$@"; }\n' };
    const junk = { [log]: 'started\n', '.env': `DB_PASSWORD=${v.password()}\n`, [`${build}/bundle.txt`]: 'built\n' };
    const files = owned(Object.fromEntries(Object.entries({ ...code, ...junk }).map(([p, c]) => [`${home}/${proj}/${p}`, c])), me.sam);
    return {
      instructions: lab({
        situation: `**~/${proj}** is not under version control yet. Make it a repository and make the first commit, but keep out what does not belong in Git:\n\n- the log file **${log}** (and any other *.log file);\n- the build output folder **${build}/**;\n- **.env**, which holds a password.\n\nWrite those rules in a **.gitignore**, commit it together with the code, with the message \`Initial commit\`. Afterwards \`git status\` must show a clean tree.`,
        steps: [`cd ~/${proj} && git init`, 'git status (see what Git would pick up)', `printf '*.log\\n${build}/\\n.env\\n' > .gitignore`, 'git add . && git status', 'git commit -m "Initial commit"'],
        tips: ['git status', 'git check-ignore -v FILE', 'git ls-files'],
      }),
      hints: ['Write .gitignore before the first git add: once a file is tracked, ignoring it no longer applies.', 'A trailing slash means "this directory".'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('Only the code and .gitignore are tracked', `cd ${home}/${proj} && git ls-files`, { equals: ['.gitignore', 'README.md', 'src/main.sh', 'src/util.sh'].join('\n') }),
        out('The commit message', `cd ${home}/${proj} && git log --format=%s`, { equals: 'Initial commit' }),
        out('Nothing is left over', `cd ${home}/${proj} && git status --porcelain`, { equals: '' }),
        file('The ignored files are still on disk', `${home}/${proj}/.env`, { contains: 'DB_PASSWORD' }),
      ],
      solution: [`cd ~/${proj} && git init -q`, `printf '*.log\\n${build}/\\n.env\\n' > .gitignore`, 'git add .', 'git commit -q -m "Initial commit"', 'git status'],
      realityNote: 'github/gitignore publishes templates for every language; secrets committed even once must be treated as leaked and rotated.',
    };
  }),
  tmpl(2, 1, 'intermediate', 'commit-message', 'Rewrite a poor commit message', 'E4', 15, 'Amend the last (unpushed) commit to a clear subject and an explanatory body.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const fix = v.pick([
      { file: 'fees.sh', before: 'round_down', after: 'round_half_up', subject: 'Round transfer fees half up', body: 'Fees were rounded down, which undercharged by up to one pesewa. Finance asked for half-up rounding.' },
      { file: 'sms.sh', before: 'retries=1', after: 'retries=3', subject: 'Retry failed SMS three times', body: 'One attempt lost messages when the gateway was busy. Three retries cover the usual short outages.' },
      { file: 'backup.sh', before: 'keep=3', after: 'keep=14', subject: 'Keep two weeks of backups', body: 'Three days was not enough to restore after a problem noticed a week later.' },
    ]);
    const bad = v.pick(['fixed stuff', 'asdf', 'changes', 'update']);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add scripts', me, o, { [fix.file]: `#!/bin/bash\nmode=${fix.before}\n` }), C(bad, me, o, { [fix.file]: `#!/bin/bash\nmode=${fix.after}\n` })]);
    return {
      instructions: lab({
        situation: `Your last commit in **~/${o.project}** (not pushed yet) has the message "${bad}". Replace it with a proper message:\n\n- subject: \`${fix.subject}\` (imperative mood, under 50 characters, no full stop);\n- a blank line;\n- body: \`${fix.body}\`\n\nDo not change the commit's content.`,
        steps: [`cd ~/${o.project}; git show --stat HEAD`, `git commit --amend -m "${fix.subject}" -m "${fix.body}"`, 'git log -1'],
        tips: ['git commit --amend', 'git commit --amend -m "subject" -m "body"', 'git log -1 --format=%B'],
      }),
      hints: ['Two -m options make two paragraphs: the subject and the body.', 'Amend only commits nobody else has: amending rewrites the commit id.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The new message', `cd ${home}/${o.project} && git log -1 --format=%B`, { equals: `${fix.subject}\n\n${fix.body}` }),
        out('The content is the same', `cd ${home}/${o.project} && git show HEAD:${fix.file}`, { contains: fix.after }),
        out('History still has two commits', `cd ${home}/${o.project} && git rev-list --count HEAD`, { equals: '2' }),
      ],
      solution: [`cd ~/${o.project} && git commit -q --amend -m "${fix.subject}" -m "${fix.body}"`, 'git log -1'],
      realityNote: 'A subject line under 50 characters in the imperative ("Fix", "Add") reads well in git log --oneline and in forge interfaces; the body says why.',
    };
  }),
  tmpl(2, 1, 'advanced', 'untrack-a-secret', 'Stop tracking a committed secret and fix .gitignore', 'E4', 25, 'Untrack .env without deleting it, ignore logs but keep a placeholder, and commit.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const pw = v.password();
    const files = repo(me.sam, `${home}/${proj}`, [C('Initial import', me, o, { 'app.sh': '#!/bin/bash\n. ./.env\n', '.env': `DB_PASSWORD=${pw}\n`, 'logs/.gitkeep': '' })]);
    files[`${home}/${proj}/logs/app.log`] = { content: 'started\n', owner: me.sam, group: me.sam };
    files[`${home}/${proj}/logs/errors.log`] = { content: 'none\n', owner: me.sam, group: me.sam };
    return {
      instructions: lab({
        situation: `In **~/${proj}** someone committed **.env**, which holds the database password. Fix the repository going forward:\n\n1. stop tracking **.env** but **keep the file** on disk (the app needs it);\n2. in **.gitignore**: ignore .env, ignore every **.log** file under **logs/**, but keep tracking **logs/.gitkeep** (the folder must exist in fresh clones);\n3. commit with the message \`Stop tracking .env\`.\n\nThe password is still in the old commit: note that it must be changed (rotated) by the database administrator.`,
        steps: [`cd ~/${proj}; git rm --cached .env`, "printf '.env\\nlogs/*\\n!logs/.gitkeep\\n' > .gitignore", 'git add .gitignore && git status', 'git commit -m "Stop tracking .env"', 'git check-ignore -v logs/app.log .env'],
        tips: ['git rm --cached FILE', 'git check-ignore -v PATH', '!pattern re-includes a file'],
      }),
      hints: ['git rm --cached removes a file from the index only; the working copy stays.', 'Ignoring logs/* (the contents) instead of logs/ (the folder) lets !logs/.gitkeep take effect.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('.env is no longer in the latest commit', `cd ${home}/${proj} && git ls-tree --name-only -r HEAD`, { notContains: '.env', contains: ['app.sh', '.gitignore', 'logs/.gitkeep'] }),
        file('.env is still on disk', `${home}/${proj}/.env`, { contains: pw }),
        out('Logs and .env are ignored', `cd ${home}/${proj} && git check-ignore logs/app.log logs/errors.log .env`, { equals: 'logs/app.log\nlogs/errors.log\n.env' }),
        out('Nothing left to commit', `cd ${home}/${proj} && git status --porcelain && git log -1 --format=%s`, { equals: 'Stop tracking .env' }),
      ],
      solution: [`cd ~/${proj} && git rm -q --cached .env`, "printf '.env\\nlogs/*\\n!logs/.gitkeep\\n' > .gitignore", 'git add .gitignore', 'git commit -q -m "Stop tracking .env"', 'git check-ignore -v logs/app.log .env'],
      realityNote: 'Removing a secret from the latest commit does not remove it from history: rotate it, and use git filter-repo plus a forced push only when the history must be rewritten.',
    };
  }),

  /* ---------------------------------------------------------------- 2.2 log, diff, show; inspecting history; blame */
  tmpl(2, 2, 'beginner', 'history-questions', 'Answer questions from the history', 'E4', 20, 'Use log, show and grep to find who changed a value, when, and in which commit.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const team = v.people(3);
    const home = `/home/${me.sam}`;
    const item = v.pick(['hostel', 'tuition', 'library', 'exam']);
    const vals = [v.int(4, 9) * 100, v.int(10, 15) * 100, v.int(16, 20) * 100];
    const fees = (x: number, extra = '') => `tuition=2500\n${item}=${x}\n${extra}`;
    const commits = [C('Add fee list', team[0], o, { 'fees.conf': fees(vals[0]) }, 0), C('Add sports fee', team[1], o, { 'fees.conf': fees(vals[0], 'sports=50\n') }, 1), C(`Raise ${item} fee`, team[2], o, { 'fees.conf': fees(vals[1], 'sports=50\n') }, 3), C('Add README', team[0], o, { 'README.md': '# Fees\n' }, 4), C(`Adjust ${item} fee`, team[1], o, { 'fees.conf': fees(vals[2], 'sports=50\n') }, 6)];
    const files = repo(me.sam, `${home}/fees`, commits);
    return {
      instructions: lab({
        situation: `Finance asks about the **${item}** fee in **~/fees/fees.conf**. Find out and write the answers to **~/answers.txt** as four lines:\n\n\`\`\`\nchanged_to_${vals[1]}_by=<full name>\nchanged_to_${vals[1]}_on=<YYYY-MM-DD>\ncurrent_set_by=<full name>\ncommits_touching_fees=<number>\n\`\`\`\n\n(\`current_set_by\` is who last changed the ${item} fee; the last line counts the commits that changed fees.conf.)`,
        steps: ['git log --oneline', 'git log -p -- fees.conf (each change with its diff)', 'git log --format="%an %ad %s" --date=short -- fees.conf', 'git log --oneline -- fees.conf | wc -l'],
        tips: ['git log -p -- FILE', 'git show COMMIT', 'git log --date=short --format="%h %an %ad %s"'],
      }),
      hints: ['git log -- FILE limits history to commits that touched that file.', 'git log -S"' + `${item}=${vals[1]}` + '" finds the commit that added or removed that text.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        file('Who set the fee to ' + vals[1], `${home}/answers.txt`, { pattern: `^changed_to_${vals[1]}_by=${team[2].name}$` }),
        file('When', `${home}/answers.txt`, { pattern: `^changed_to_${vals[1]}_on=2026-10-13$` }),
        file('Who set the current value', `${home}/answers.txt`, { pattern: `^current_set_by=${team[1].name}$` }),
        file('How many commits changed fees.conf', `${home}/answers.txt`, { pattern: '^commits_touching_fees=4$' }),
      ],
      solution: ['cd ~/fees && git log --date=short --format="%h %an %ad %s" -- fees.conf', `printf 'changed_to_${vals[1]}_by=${team[2].name}\\nchanged_to_${vals[1]}_on=2026-10-13\\ncurrent_set_by=${team[1].name}\\ncommits_touching_fees=4\\n' > ~/answers.txt`, 'cat ~/answers.txt'],
      realityNote: 'Auditors ask exactly these questions; a history with clear messages and per-person commits answers them in seconds.',
    };
  }),
  tmpl(2, 2, 'intermediate', 'release-diff', 'Produce a patch and a summary between releases', 'E4', 20, 'Use git diff between tags, limited to a folder, and save a patch and a stat summary.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const port = v.int(80, 90) * 100;
    const t = v.int(20, 60);
    const commits = [
      C('Initial release', me, o, { 'config/app.conf': `port=${port}\ntimeout=${t}\n`, 'config/db.conf': 'pool=5\n', 'src/app.sh': '#!/bin/bash\necho v1\n' }),
      C('Longer timeout', me, o, { 'config/app.conf': `port=${port}\ntimeout=${t + 30}\n` }),
      C('Bigger pool', me, o, { 'config/db.conf': 'pool=10\n' }),
      C('Version 2 banner', me, o, { 'src/app.sh': '#!/bin/bash\necho v2\n' }),
    ];
    const files = repo(me.sam, `${home}/${o.project}`, commits, { 'v1.0': 0, 'v1.1': 3 });
    return {
      instructions: lab({
        situation: `The operations team only cares about configuration. In **~/${o.project}**, between the tags **v1.0** and **v1.1**:\n\n1. save the diff of the **config/** folder only to **~/config.patch**;\n2. save the \`--stat\` summary of **all** changes to **~/release.stat**.`,
        steps: [`cd ~/${o.project}; git tag`, 'git diff v1.0 v1.1 -- config/ > ~/config.patch', 'git diff --stat v1.0 v1.1 > ~/release.stat', 'cat ~/config.patch'],
        tips: ['git diff A B -- PATH', 'git diff --stat A B', 'git log --oneline v1.0..v1.1'],
      }),
      hints: ['-- separates revisions from paths.', 'A patch made by git diff can be applied elsewhere with git apply.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        file('The patch has the config changes', `${home}/config.patch`, { contains: [`-timeout=${t}`, `+timeout=${t + 30}`, '-pool=5', '+pool=10'] }),
        file('The patch has nothing outside config/', `${home}/config.patch`, { notContains: 'src/app.sh' }),
        file('The summary covers all three files', `${home}/release.stat`, { contains: ['config/app.conf', 'config/db.conf', 'src/app.sh', '3 files changed'] }),
      ],
      solution: [`cd ~/${o.project} && git diff v1.0 v1.1 -- config/ > ~/config.patch`, 'git diff --stat v1.0 v1.1 > ~/release.stat', 'cat ~/release.stat'],
      realityNote: 'Release notes and change-approval boards often start from exactly this diff; git format-patch and git apply move such changes between repositories by e-mail.',
    };
  }),
  tmpl(2, 2, 'advanced', 'who-introduced-it', 'Find the commit that introduced a bad value', 'E4', 25, 'Use log -S and blame to find when, by whom and in which commit a line appeared.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const team = v.people(3);
    const home = `/home/${me.sam}`;
    const bad = v.pick(['rate=0.15', 'limit=1', 'retries=0', 'timeout=1']);
    const key = bad.split('=')[0];
    const good = { rate: 'rate=0.015', limit: 'limit=50', retries: 'retries=3', timeout: 'timeout=30' }[key as 'rate'];
    const culprit = team[v.int(0, 2)];
    const commits = [
      C('Add settings', team[0], o, { 'settings.conf': `${good}\nlog=info\n` }),
      C('Add currency', team[1], o, { 'settings.conf': `${good}\nlog=info\ncurrency=GHS\n` }),
      C('Tune settings', culprit, o, { 'settings.conf': `${bad}\nlog=info\ncurrency=GHS\n` }),
      C('Debug logging', team[2], o, { 'settings.conf': `${bad}\nlog=debug\ncurrency=GHS\n` }),
      C('Back to info logging', team[0], o, { 'settings.conf': `${bad}\nlog=info\ncurrency=GHS\n`, 'README.md': '# Settings\n' }),
    ];
    const files = repo(me.sam, `${home}/${o.project}`, commits);
    const st = mutate(files, `${home}/${o.project}`, () => {});
    const order = Object.values(st.commits).sort((a, b) => a.seq - b.seq);
    const id = order[2].id;
    return {
      instructions: lab({
        situation: `Production misbehaves because **settings.conf** in **~/${o.project}** says \`${bad}\`. Find the commit that **introduced** that line (not just the last one to touch the file) and write **~/culprit.txt** with two lines:\n\n\`\`\`\ncommit <full 40-character id>\nauthor <full name>\n\`\`\``,
        steps: [`cd ~/${o.project}; git blame settings.conf`, `git log -S'${bad}' --oneline (commits that added or removed the text)`, 'git show ID to confirm', 'git rev-parse ID gives the full id'],
        tips: [`git log -S'${bad}' --format="%H %an"`, 'git blame -L 1,1 settings.conf', 'git show --stat ID'],
      }),
      hints: ['blame shows the last commit that changed each line; later commits that left the line alone do not count.', '-S (the "pickaxe") finds commits where the number of occurrences of a string changed.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        file('The commit', `${home}/culprit.txt`, { pattern: `^commit ${id}$` }),
        file('The author', `${home}/culprit.txt`, { pattern: `^author ${culprit.name}$` }),
      ],
      solution: [`cd ~/${o.project} && git log -S'${bad}' --format="%H %an"`, `git log -S'${bad}' --format="commit %H%nauthor %an" > ~/culprit.txt`, 'cat ~/culprit.txt'],
      realityNote: 'blame and the pickaxe are how incident reviews find the change behind a regression; forges show the same in their blame view.',
    };
  }),

  /* ---------------------------------------------------------------- 2.3 branches; switch; fast-forward and three-way merges */
  tmpl(2, 3, 'beginner', 'fast-forward', 'Work on a branch and fast-forward main', 'E4', 15, 'Create a branch, commit, merge it into main as a fast-forward, and delete it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const feat = v.pick(['add-contact-page', 'add-faq', 'add-opening-hours']);
    const page = feat.replace('add-', '') + '.html';
    const files = repo(me.sam, `${home}/site`, [C('Add home page', me, o, { 'index.html': `<h1>${o.what}</h1>\n` })]);
    return {
      instructions: lab({
        situation: `In **~/site**, add the page **${page}** on a branch:\n\n1. create and switch to branch **${feat}**;\n2. add **${page}** containing \`<h1>${feat.replace('add-', '').replace('-', ' ')}</h1>\` and commit it with the message \`Add ${page.replace('.html', '')} page\`;\n3. switch back to **main** and merge **${feat}** (it will be a fast-forward: no merge commit);\n4. delete the branch.`,
        steps: [`git switch -c ${feat}`, `echo '<h1>...</h1>' > ${page}; git add ${page}; git commit -m "..."`, 'git switch main', `git merge ${feat} (look for "Fast-forward")`, `git branch -d ${feat}`],
        tips: ['git branch', 'git log --oneline --graph --all', 'git branch -d NAME'],
      }),
      hints: ['A branch is a movable pointer; a fast-forward just moves main forward to the branch tip.', 'git branch -d refuses to delete unmerged work; -D forces it.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('main has the page commit and no merge commit', `cd ${home}/site && git log --format='%s|%p' main | head -1`, { pattern: `^Add ${page.replace('.html', '')} page\\|[0-9a-f]{7}$` }),
        out('The page is on main', `cd ${home}/site && git show main:${page}`, { contains: '<h1>' }),
        out('The branch is gone and main is checked out', `cd ${home}/site && git branch`, { equals: '* main' }),
      ],
      solution: [`cd ~/site && git switch -c ${feat}`, `echo '<h1>${feat.replace('add-', '').replace('-', ' ')}</h1>' > ${page}`, `git add ${page} && git commit -q -m "Add ${page.replace('.html', '')} page"`, 'git switch main', `git merge ${feat}`, `git branch -d ${feat}`],
      realityNote: 'Short-lived branches merged quickly keep history simple; forges call the same thing a fast-forward or "rebase and merge".',
    };
  }),
  tmpl(2, 3, 'intermediate', 'three-way-merge', 'Merge two branches with merge commits', 'E4', 20, 'Merge two finished branches into main with --no-ff so each feature stays visible.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const team = v.people(2);
    const home = `/home/${me.sam}`;
    const [f1, f2] = v.some(['sms-receipts', 'csv-export', 'dark-theme', 'audit-log'], 2);
    const base = [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\necho app\n' })];
    const files = repo(me.sam, `${home}/${o.project}`, [...base, C('Add help text', me, o, { 'HELP.md': '# Help\n' })], {}, { branches: { [f1]: { from: 0, commits: [C(`Add ${f1}`, team[0], o, { [`${f1}.sh`]: `#!/bin/bash\necho ${f1}\n` })] }, [f2]: { from: 0, commits: [C(`Add ${f2}`, team[1], o, { [`${f2}.sh`]: `#!/bin/bash\necho ${f2}\n` })] } } });
    return {
      instructions: lab({
        situation: `Branches **${f1}** and **${f2}** in **~/${o.project}** are finished and reviewed. Merge both into **main**, ${f1} first, each with \`--no-ff\` so that each feature shows as its own merge commit with git's default message (\`Merge branch '<name>'\`). Then delete both branches.`,
        steps: ['git switch main', `git merge --no-ff ${f1} (accept the default message)`, `git merge --no-ff ${f2}`, 'git log --oneline --graph', `git branch -d ${f1} ${f2}`],
        tips: ['git merge --no-ff --no-edit BRANCH', 'git log --oneline --graph --all'],
      }),
      hints: ['--no-ff makes a merge commit even when a fast-forward is possible; here main has moved on, so a merge commit is needed anyway.', 'A merge commit has two parents.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('Two merge commits, in order', `cd ${home}/${o.project} && git log --merges --format=%s main`, { equals: `Merge branch '${f2}'\nMerge branch '${f1}'` }),
        out('Both features are on main', `cd ${home}/${o.project} && git ls-tree --name-only main`, { contains: [`${f1}.sh`, `${f2}.sh`, 'HELP.md'] }),
        out('The branches are deleted', `cd ${home}/${o.project} && git branch`, { equals: '* main' }),
      ],
      solution: [`cd ~/${o.project} && git switch main`, `git merge --no-ff --no-edit ${f1}`, `git merge --no-ff --no-edit ${f2}`, `git branch -d ${f1} ${f2}`, 'git log --oneline --graph'],
      realityNote: 'Many forges use --no-ff merges for pull requests so that each one stays a visible, revertible unit.',
    };
  }),
  tmpl(2, 3, 'advanced', 'resolve-merge', 'Resolve a merge conflict following a policy', 'E4', 25, 'Merge a branch that conflicts on one setting, apply the agreed value, and keep the other changes.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const key = v.pick(['max_upload_mb', 'session_minutes', 'page_size']);
    const [base, ours, theirs] = [v.int(5, 9), v.int(10, 19), v.int(20, 29)];
    const agreed = v.pick([ours, theirs]);
    const conf = (x: number, extra = '') => `name=${o.project}\n${key}=${x}\n${extra}`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add config', me, o, { 'app.conf': conf(base) }), C(`Set ${key} to ${ours}`, me, o, { 'app.conf': conf(ours) })], {}, { branches: { tuning: { from: 0, commits: [C(`Set ${key} to ${theirs} and add cache`, mate, o, { 'app.conf': conf(theirs, 'cache=on\n'), 'NOTES.md': 'Cache on since load tests.\n' })] } } });
    return {
      instructions: lab({
        situation: `${mate.given}'s branch **tuning** and your **main** both changed **${key}** in **~/${o.project}/app.conf** (main: ${ours}, tuning: ${theirs}). The team agreed on **${agreed}**. Merge tuning into main, resolve the conflict with ${key}=${agreed}, keep tuning's other changes (cache=on, NOTES.md), and finish the merge with git's default message.`,
        steps: ['git merge tuning (it stops with a conflict)', 'git status; cat app.conf', `Edit app.conf: keep ${key}=${agreed}, keep cache=on, delete the <<<<<<< ======= >>>>>>> lines`, 'git add app.conf && git commit --no-edit'],
        tips: ['git diff (shows the conflict)', 'git merge --abort (start over)', 'git log --oneline --graph'],
      }),
      hints: ['A conflict is Git asking a person to decide; the markers show both sides.', 'git add marks the file resolved; the commit completes the merge.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The merge is complete with two parents', `cd ${home}/${o.project} && git log -1 --format='%s|%P' | sed 's/ [0-9a-f]*$/ X/'`, { pattern: "^Merge branch 'tuning'\\|[0-9a-f]{40} X$" }),
        out('The agreed value and the other change', `cd ${home}/${o.project} && git show HEAD:app.conf`, { equals: conf(agreed, 'cache=on\n').trim() }),
        out('No conflict markers anywhere', `cd ${home}/${o.project} && git grep -c '<<<<<<<\\|>>>>>>>' HEAD; echo "rc=$?"`, { contains: 'rc=1' }),
        out("tuning's new file came along", `cd ${home}/${o.project} && git ls-tree --name-only HEAD`, { contains: 'NOTES.md' }),
      ],
      solution: [`cd ~/${o.project} && git merge tuning`, `printf 'name=${o.project}\\n${key}=${agreed}\\ncache=on\\n' > app.conf`, 'git add app.conf', 'git commit -q --no-edit', 'git log --oneline --graph'],
      realityNote: 'Most conflicts are settled by a quick conversation, not by Git: agree the intended result, then edit the file to match.',
    };
  }),

  /* ---------------------------------------------------------------- 2.4 tags, stash, amend; restore, revert, reset */
  tmpl(2, 4, 'beginner', 'stash-for-a-hotfix', 'Stash unfinished work to make an urgent fix', 'E4', 20, 'Stash work in progress, fix main, and bring the work back.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const wrong = v.pick(['Tel: 030 000 0000', 'Open: 9am-5pm Sundays', 'Email: info@exmaple.org']);
    const right = { 'Tel: 030 000 0000': 'Tel: 030 222 4545', 'Open: 9am-5pm Sundays': 'Open: 9am-5pm weekdays', 'Email: info@exmaple.org': 'Email: info@example.org' }[wrong as 'Tel: 030 000 0000'];
    const files = repo(me.sam, `${home}/site`, [C('Add contact page', me, o, { 'contact.html': `<p>${wrong}</p>\n`, 'news.html': '<h1>News</h1>\n' })], {}, { branches: { 'news-page': { from: 0, commits: [] } }, checkout: 'news-page' });
    files[`${home}/site/news.html`] = { content: '<h1>News</h1>\n<p>Draft: new term dates...</p>\n', owner: me.sam, group: me.sam };
    return {
      instructions: lab({
        situation: `You are halfway through editing **news.html** on branch **news-page** in **~/site** (not committed). The live contact page shows the wrong line \`${wrong}\`, and it must be fixed on **main** now.\n\n1. put your unfinished work aside with **git stash**;\n2. on main, change the line to \`${right}\` and commit it (\`Fix contact details\`);\n3. go back to news-page and **restore** your unfinished work (still uncommitted).`,
        steps: ['git stash', 'git switch main', `edit contact.html, then git commit -am "Fix contact details"`, 'git switch news-page', 'git stash pop', 'git status (news.html modified again)'],
        tips: ['git stash list', 'git stash show -p', 'git stash pop'],
      }),
      hints: ['git switch refuses to leave if your changes would be overwritten; stashing clears the working tree safely.', 'pop applies the newest stash and removes it from the list.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The fix is on main', `cd ${home}/site && git show main:contact.html`, { contains: right }),
        out('You are back on news-page with the draft uncommitted', `cd ${home}/site && git status --porcelain && git rev-parse --abbrev-ref HEAD`, { equals: ' M news.html\nnews-page' }),
        file('The draft is restored', `${home}/site/news.html`, { contains: 'Draft: new term dates' }),
        out('The stash is empty', `cd ${home}/site && git stash list | wc -l`, { equals: '0' }),
      ],
      solution: ['cd ~/site && git stash', 'git switch main', `sed -i 's/${wrong.replace(/[/.]/g, '\\$&')}/${right}/' contact.html`, 'git commit -q -am "Fix contact details"', 'git switch news-page', 'git stash pop'],
      realityNote: 'Stash is a short-term shelf; for anything longer, a work-in-progress commit on its own branch is safer and visible to others.',
    };
  }),
  tmpl(2, 4, 'intermediate', 'tags-and-amend', 'Tag a release and amend a forgotten file', 'E4', 20, 'Amend the last commit with a missing file, then add an annotated release tag and a build tag.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const ver = `v${v.int(1, 3)}.${v.int(0, 9)}.0`;
    const build = `build-${v.int(100, 999)}`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\necho 1\n' }), C('Fix login', me, o, { 'app.sh': '#!/bin/bash\necho 2\n' }), C(`Prepare ${ver}`, me, o, { 'VERSION': ver.slice(1) + '\n' })]);
    files[`${home}/${o.project}/CHANGELOG.md`] = { content: `## ${ver}\n- Fix login\n`, owner: me.sam, group: me.sam };
    return {
      instructions: lab({
        situation: `In **~/${o.project}** the last commit, "Prepare ${ver}" (not pushed), should also have contained **CHANGELOG.md**, which is lying untracked in the folder. Then the release must be tagged:\n\n1. add CHANGELOG.md **to the last commit** (same message, no new commit);\n2. tag that commit **${ver}** as an **annotated** tag with the message \`Release ${ver}\`;\n3. add a lightweight tag **${build}** on the same commit.`,
        steps: ['git add CHANGELOG.md && git commit --amend --no-edit', `git tag -a ${ver} -m "Release ${ver}"`, `git tag ${build}`, `git show ${ver} (shows the tag message, then the commit)`],
        tips: ['git commit --amend --no-edit', 'git tag -a NAME -m "message"', 'git tag -n', 'git cat-file -t NAME'],
      }),
      hints: ['Amend before tagging: amending creates a new commit, and a tag made earlier would point at the old one.', 'Annotated tags store who tagged, when and why; lightweight tags are just names.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The last commit contains CHANGELOG.md', `cd ${home}/${o.project} && git log -1 --format=%s && git ls-tree --name-only HEAD`, { contains: [`Prepare ${ver}`, 'CHANGELOG.md', 'VERSION'] }),
        out('Still three commits', `cd ${home}/${o.project} && git rev-list --count HEAD`, { equals: '3' }),
        out(`${ver} is annotated and on HEAD`, `cd ${home}/${o.project} && git cat-file -t ${ver} && git rev-parse ${ver}^{} && git rev-parse HEAD`, { pattern: '^tag\\n([0-9a-f]{40})\\n\\1$' }),
        out(`${build} is lightweight and on HEAD`, `cd ${home}/${o.project} && git cat-file -t ${build} && [ "$(git rev-parse ${build})" = "$(git rev-parse HEAD)" ] && echo same`, { equals: 'commit\nsame' }),
        out('The tag message', `cd ${home}/${o.project} && git tag -n ${ver}`, { pattern: `Release ${ver.replace(/\./g, '\\.')}` }),
      ],
      solution: [`cd ~/${o.project} && git add CHANGELOG.md && git commit -q --amend --no-edit`, `git tag -a ${ver} -m "Release ${ver}"`, `git tag ${build}`, 'git tag -n'],
      realityNote: 'Release tooling and forges build release pages from annotated tags; teams often forbid moving a published tag.',
    };
  }),
  tmpl(2, 4, 'advanced', 'undo-three-mistakes', 'Undo three mistakes the right way', 'E4', 30, 'Unstage a file, drop an unpushed commit, and revert a pushed one, then push.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const good = v.int(20, 60);
    const commits = [C('Initial app', me, o, { 'app.conf': `timeout=${good}\n`, 'app.sh': '#!/bin/bash\necho ok\n' }), C('Set timeout to 1', me, o, { 'app.conf': 'timeout=1\n' })];
    const local = repo(me.sam, `${home}/${proj}`, [...commits, C('WIP debug prints', me, o, { 'app.sh': '#!/bin/bash\nset -x\necho ok\n' })], {}, { origin: `/srv/git/${proj}.git` });
    // The remote has only the first two commits; the third was never pushed.
    const remoteFiles = bare(me.sam, `/srv/git/${proj}.git`, commits);
    mutate(local, `${home}/${proj}`, (st) => {
      const order = Object.values(st.commits).sort((a, b) => a.seq - b.seq);
      st.remoteRefs = { 'origin/main': order[1].id, 'origin/HEAD': order[1].id };
      st.index['debug.log'] = 'x=1\n';
    });
    local[`${home}/${proj}/debug.log`] = { content: 'x=1\n', owner: me.sam, group: me.sam };
    return {
      instructions: lab({
        situation: `Three mistakes in **~/${proj}**:\n\n1. **debug.log** is staged by accident: unstage it (keep the file);\n2. the last commit, "WIP debug prints", was **never pushed**: remove it completely, changes and all;\n3. "Set timeout to 1" **was pushed** and broke production: undo it **without rewriting** pushed history.\n\nThen push main.`,
        steps: ['git status; git log --oneline --decorate', 'git restore --staged debug.log', 'git reset --hard HEAD~1 (only for the unpushed commit)', 'git revert --no-edit HEAD (the pushed one)', 'git push'],
        tips: ['git restore --staged FILE', 'git reset --hard COMMIT', 'git revert COMMIT', 'git log --oneline origin/main..main'],
      }),
      hints: ['reset moves a branch backwards and discards commits: fine for your own unpushed work.', 'revert adds a new commit that undoes an old one, so people who already have the history are not affected.'],
      initialState: dev({ me, org: o, files: { ...local, ...remoteFiles, '/srv/git/': { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('The remote has the revert on top', `git -C /srv/git/${proj}.git log --format=%s main`, { equals: `Revert "Set timeout to 1"\nSet timeout to 1\nInitial app` }),
        out('The timeout is back', `git -C /srv/git/${proj}.git show main:app.conf`, { equals: `timeout=${good}` }),
        out('The debug commit is gone', `cd ${home}/${proj} && git log --all --format=%s | grep -c WIP; git show HEAD:app.sh | grep -c 'set -x'`, { equals: '0\n0' }),
        out('debug.log is untracked but still there', `cd ${home}/${proj} && git status --porcelain`, { equals: '?? debug.log' }),
      ],
      solution: [`cd ~/${proj} && git restore --staged debug.log`, 'git reset --hard HEAD~1', 'git revert --no-edit HEAD', 'git push', 'git log --oneline'],
      realityNote: 'The rule of thumb: reset (rewrite) only what is still private; revert what others may have pulled.',
    };
  }),

  /* ---------------------------------------------------------------- 2.5 rebase versus merge; interactive rebase; reflog */
  tmpl(2, 5, 'beginner', 'rebase-feature', 'Rebase a feature branch onto main', 'E4', 20, 'Replay a feature branch on top of an updated main for a linear history.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const feat = v.pick(['add-receipts', 'add-search', 'add-reminders']);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', mate, o, { 'app.sh': '#!/bin/bash\necho app\n' }), C('Add README', mate, o, { 'README.md': '# App\n' }), C('Add licence', mate, o, { 'LICENSE': 'MIT\n' })], {}, { branches: { [feat]: { from: 0, commits: [C(`Start ${feat}`, me, o, { [`${feat}.sh`]: '#!/bin/bash\n' }), C(`Finish ${feat}`, me, o, { [`${feat}.sh`]: '#!/bin/bash\necho done\n' })] } }, checkout: feat });
    return {
      instructions: lab({
        situation: `Your branch **${feat}** in **~/${o.project}** started from an old main; main has gained two commits since. Rebase your branch onto main so its two commits sit on top of main's latest commit (a straight line, no merge commit). Main itself must not change.`,
        steps: ['git log --oneline --graph --all', `git switch ${feat}`, 'git rebase main', 'git log --oneline --graph --all'],
        tips: ['git rebase main', 'git rebase --abort (if anything looks wrong)', 'git merge-base --is-ancestor main HEAD && echo based-on-main'],
      }),
      hints: ['Rebase replays your commits as new commits on the new base: their ids change.', 'Only rebase branches others have not built on.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The branch now starts from main', `cd ${home}/${o.project} && git merge-base --is-ancestor main ${feat} && echo yes`, { equals: 'yes' }),
        out('Linear, with your two commits on top', `cd ${home}/${o.project} && git log --format=%s main..${feat} && git rev-list --merges --count ${feat}`, { equals: `Finish ${feat}\nStart ${feat}\n0` }),
        out('main is unchanged', `cd ${home}/${o.project} && git log -1 --format=%s main`, { equals: 'Add licence' }),
      ],
      solution: [`cd ~/${o.project} && git switch ${feat}`, 'git rebase main', 'git log --oneline --graph --all'],
      realityNote: 'Teams that want a linear main ask contributors to rebase before merging; others prefer merge commits that record when work came together.',
    };
  }),
  tmpl(2, 5, 'intermediate', 'tidy-with-rebase-i', 'Clean up a branch with interactive rebase', 'E4', 30, 'Squash work-in-progress commits and reword a message before review.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const thing = v.pick(['report', 'export', 'reminder']);
    const final = { report: 'Add weekly report', export: 'Add CSV export', reminder: 'Add payment reminders' }[thing as 'report'];
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })], {}, {
      branches: {
        [thing]: {
          from: 0,
          commits: [
            C(`start ${thing}`, me, o, { [`${thing}.sh`]: '#!/bin/bash\necho start\n' }),
            C('wip', me, o, { [`${thing}.sh`]: '#!/bin/bash\necho start\necho more\n' }),
            C('fix typo', me, o, { [`${thing}.sh`]: '#!/bin/bash\necho start\necho more\necho done\n' }),
            C(`Add tests for ${thing}`, me, o, { [`test_${thing}.sh`]: '#!/bin/bash\necho ok\n' }),
          ],
        },
      },
      checkout: thing,
    });
    return {
      instructions: lab({
        situation: `Before review, tidy branch **${thing}** in **~/${o.project}**. It has four commits: "start ${thing}", "wip", "fix typo" and "Add tests for ${thing}". Make it **two** commits on top of main:\n\n1. \`${final}\` (the first three squashed together, with this new message);\n2. \`Add tests for ${thing}\` (unchanged).\n\nThe files at the end must be exactly as they are now.`,
        steps: ['git rebase -i main', 'In the editor: change "pick" to "reword" on the first line and "fixup" on wip and fix typo', 'Save; in the next editor, write the new message', 'git log --oneline main..'],
        tips: ['git rebase -i main', 'pick / reword / squash / fixup / drop', 'GIT_SEQUENCE_EDITOR="sed -i ..." git rebase -i main (a script instead of an editor)', 'git diff ORIG_HEAD (should be empty afterwards)'],
      }),
      hints: ['fixup melds a commit into the one above it and throws its message away; reword keeps a commit but lets you change its message.', 'ORIG_HEAD points at the branch tip before the rebase, so you can compare or go back.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('Two commits with the right messages', `cd ${home}/${o.project} && git log --format=%s main..${thing}`, { equals: `Add tests for ${thing}\n${final}` }),
        out('The files are unchanged', `cd ${home}/${o.project} && git show ${thing}:${thing}.sh`, { equals: '#!/bin/bash\necho start\necho more\necho done' }),
        out('The first commit holds all of the feature', `cd ${home}/${o.project} && git show ${thing}~1:${thing}.sh | wc -l`, { equals: '4' }),
      ],
      solution: [`cd ~/${o.project}`, `GIT_SEQUENCE_EDITOR="sed -i -e '1s/^pick/reword/' -e '2s/^pick/fixup/' -e '3s/^pick/fixup/'" GIT_EDITOR="sed -i '1s/.*/${final}/'" git rebase -i main`, 'git log --oneline main..'],
      realityNote: 'Reviewers read history commit by commit; interactive rebase is how professionals turn a messy branch into a story worth reading.',
    };
  }),
  tmpl(2, 5, 'advanced', 'reflog-rescue', 'Recover from a bad reset with the reflog', 'E4', 25, 'Use the reflog to restore main after reset --hard and to bring back a deleted branch.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const exp = v.pick(['experiment', 'try-new-layout', 'spike-cache']);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' }), C('Add login', me, o, { 'login.sh': '#!/bin/bash\n' }), C('Add payments', me, o, { 'pay.sh': '#!/bin/bash\n' }), C('Add receipts', me, o, { 'receipts.sh': '#!/bin/bash\n' })], {}, { branches: { [exp]: { from: 3, commits: [C(`Try ${exp}`, me, o, { 'exp.sh': '#!/bin/bash\n' })] } } });
    let mainTip = '';
    let expTip = '';
    mutate(files, `${home}/${o.project}`, (st) => {
      const order = Object.values(st.commits).sort((a, b) => a.seq - b.seq);
      mainTip = order[3].id;
      expTip = st.branches[exp]!;
      const t0 = order[0].time;
      const e = (from: string | null, to: string, msg: string, k: number) => ({ from, to, msg, time: t0 + k * 3600000, who: `${me.name} <${email(me, o)}>` });
      st.reflogs = {
        HEAD: [e(null, order[0].id, 'commit (initial): Initial app', 0), e(order[0].id, order[1].id, 'commit: Add login', 1), e(order[1].id, order[2].id, 'commit: Add payments', 2), e(order[2].id, order[3].id, 'commit: Add receipts', 3), e(order[3].id, order[3].id, `checkout: moving from main to ${exp}`, 4), e(order[3].id, expTip, `commit: Try ${exp}`, 5), e(expTip, order[3].id, `checkout: moving from ${exp} to main`, 6), e(order[3].id, order[0].id, 'reset: moving to HEAD~3', 7)],
      };
      delete st.branches[exp];
      st.branches.main = order[0].id;
      st.index = { ...order[0].tree };
    });
    for (const f of ['login.sh', 'pay.sh', 'receipts.sh']) delete files[`${home}/${o.project}/${f}`];
    return {
      instructions: lab({
        situation: `In **~/${o.project}** someone ran \`git reset --hard HEAD~3\` on main and then \`git branch -D ${exp}\`. Main lost three commits ("Add login", "Add payments", "Add receipts") and the unmerged branch **${exp}** is gone. Nothing was pushed.\n\nUsing the **reflog**, put **main** back where it was before the reset, and recreate **${exp}** at its last commit.`,
        steps: ['git reflog', 'git reset --hard HEAD@{1} (the entry before the reset), or use the commit id', `git branch ${exp} ID (the "commit: Try ${exp}" entry)`, 'git log --oneline --graph --all'],
        tips: ['git reflog', 'git reset --hard HEAD@{N}', 'git branch NAME ID', 'git log -g --oneline'],
      }),
      hints: ['The reflog records every move of HEAD on this machine, for about 90 days.', 'Commits are not deleted by reset or branch -D; they only lose their name.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('main is back', `cd ${home}/${o.project} && git rev-parse main`, { equals: mainTip }),
        out(`${exp} is back`, `cd ${home}/${o.project} && git rev-parse ${exp}`, { equals: expTip }),
        out('The working tree matches main', `cd ${home}/${o.project} && git status --porcelain && ls`, { contains: ['receipts.sh', 'pay.sh', 'login.sh'] }),
      ],
      solution: [`cd ~/${o.project} && git reflog`, `git reset --hard ${mainTip}`, `git branch ${exp} ${expTip}`, 'git log --oneline --graph --all'],
      realityNote: 'The reflog is local: it saves you from your own mistakes on your machine. A forced push that destroyed others\' work needs their clones (or the forge\'s logs) instead.',
    };
  }),
];

