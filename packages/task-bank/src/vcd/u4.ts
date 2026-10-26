/** Unit 4: resolving conflicts and recovering from collaboration failures. */

import type { TaskTemplate } from '../types';
import type { Person } from '../types';
import { C, ORGS, bare, caseStudy, dev, email, file, gitconfig, lab, mutate, out, owned, repo, sharedBare, tmpl } from './kit';

export const U4: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 4.1 how conflicts arise; markers; resolving */
  tmpl(4, 1, 'beginner', 'keep-both-sides', 'Resolve a conflict by keeping both changes', 'E4', 20, 'Merge two branches that both added a line at the same place, keeping both lines.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const [d1, d2] = v.some(['2026-12-25 Christmas Day', '2026-12-26 Boxing Day', '2026-07-01 Republic Day', '2026-09-21 Founders Day', '2026-03-06 Independence Day'], 2);
    const base = 'date name\n2026-01-01 New Year\n';
    const files = repo(me.sam, `${home}/calendar`, [C('Start holiday list', me, o, { 'holidays.txt': base }), C(`Add ${d1.slice(11)}`, me, o, { 'holidays.txt': base + d1 + '\n' })], {}, { branches: { [`add-${d2.slice(11).split(' ')[0].toLowerCase()}`]: { from: 0, commits: [C(`Add ${d2.slice(11)}`, mate, o, { 'holidays.txt': base + d2 + '\n' })] } } });
    const br = `add-${d2.slice(11).split(' ')[0].toLowerCase()}`;
    const [first, second] = [d1, d2].sort();
    return {
      instructions: lab({
        situation: `In **~/calendar**, you added "${d1}" to **holidays.txt** on main while ${mate.given} added "${d2}" on branch **${br}**: both at the end of the file. Merge ${br} into main. Both holidays belong in the file: keep **both** lines, in **date order**, then finish the merge.`,
        steps: [`git merge ${br}`, 'cat holidays.txt (see both sides between the markers)', 'Edit: keep both date lines in order, remove the <<<<<<<, ======= and >>>>>>> lines', 'git add holidays.txt && git commit --no-edit'],
        tips: ['git status', 'git diff', 'git merge --abort (to start again)'],
      }),
      hints: ['Two additions at the same spot conflict even though neither deletes anything: Git cannot know the order you want.', 'The resolution can be neither side alone: here it is both.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('Both holidays, in date order, no markers', `cd ${home}/calendar && git show HEAD:holidays.txt`, { equals: `${base}${first}\n${second}`.trim() }),
        out('The merge is committed', `cd ${home}/calendar && git log -1 --format=%s && git status --porcelain`, { equals: `Merge branch '${br}'` }),
      ],
      solution: [`cd ~/calendar && git merge ${br}`, `printf '${base.replace(/\n/g, '\\n')}${first}\\n${second}\\n' > holidays.txt`, 'git add holidays.txt', 'git commit -q --no-edit'],
      realityNote: 'Append-at-the-end conflicts are the most common kind in shared lists (changelogs, rosters); some teams use one file per entry to avoid them.',
    };
  }),
  tmpl(4, 1, 'intermediate', 'modify-delete', 'Resolve modify/delete and add/add conflicts', 'E4', 25, 'Finish a merge where one side deleted a file the other changed, and both added the same new file.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const old = v.pick(['legacy.conf', 'old-settings.ini', 'v1.conf']);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial config', me, o, { [old]: 'mode=classic\n', 'app.sh': '#!/bin/bash\n' }), C(`Tune ${old}`, me, o, { [old]: 'mode=classic\nthreads=4\n', 'CONTRIBUTING.md': 'Use pull requests.\n' })], {}, { branches: { cleanup: { from: 0, commits: [C(`Remove ${old}`, mate, o, { [old]: null, 'CONTRIBUTING.md': 'Run the tests first.\n' })] } } });
    return {
      instructions: lab({
        situation: `Merging ${mate.given}'s branch **cleanup** into main in **~/${o.project}** gives two conflicts:\n\n- **${old}**: cleanup deleted it, main changed it. The team decided the file is obsolete: **delete it**.\n- **CONTRIBUTING.md**: both sides created it with different text. Keep **both** lines: \`Use pull requests.\` then \`Run the tests first.\`\n\nFinish the merge.`,
        steps: ['git merge cleanup', 'git status (deleted by them / both added)', `git rm ${old}`, "printf 'Use pull requests.\\nRun the tests first.\\n' > CONTRIBUTING.md; git add CONTRIBUTING.md", 'git commit --no-edit'],
        tips: ['git status', 'git rm FILE (resolve by deleting)', 'git add FILE (resolve by keeping)'],
      }),
      hints: ['For a modify/delete conflict, git rm records "deleted" and git add records "kept".', 'git status lists every unmerged path and the kind of conflict.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out(`${old} is gone from main`, `cd ${home}/${o.project} && git ls-tree --name-only HEAD`, { notContains: old, contains: ['CONTRIBUTING.md', 'app.sh'] }),
        out('CONTRIBUTING.md has both lines', `cd ${home}/${o.project} && git show HEAD:CONTRIBUTING.md`, { equals: 'Use pull requests.\nRun the tests first.' }),
        out('The merge is finished', `cd ${home}/${o.project} && git log -1 --format=%s && git status --porcelain`, { equals: "Merge branch 'cleanup'" }),
      ],
      solution: [`cd ~/${o.project} && git merge cleanup`, `git rm -q ${old}`, "printf 'Use pull requests.\\nRun the tests first.\\n' > CONTRIBUTING.md", 'git add CONTRIBUTING.md', 'git commit -q --no-edit'],
      realityNote: 'Rename and delete conflicts are where merge tools help least; reading git status carefully is the skill.',
    };
  }),
  tmpl(4, 1, 'advanced', 'diff3-conflict', 'Use the base version to resolve a tricky conflict', 'E4', 25, 'Switch to diff3 conflict style and combine a rename on one side with a value change on the other.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const [oldKey, newKey] = v.pick([['discount', 'promo_discount'], ['limit', 'daily_limit'], ['fee', 'transfer_fee']]);
    const [b, ours] = [v.int(1, 5), v.int(6, 15)];
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add pricing', me, o, { 'pricing.conf': `currency=GHS\n${oldKey}=${b}\n` }), C(`Raise ${oldKey} to ${ours}`, me, o, { 'pricing.conf': `currency=GHS\n${oldKey}=${ours}\n` })], {}, { branches: { rename: { from: 0, commits: [C(`Rename ${oldKey} to ${newKey}`, mate, o, { 'pricing.conf': `currency=GHS\n${newKey}=${b}\n` })] } } });
    return {
      instructions: lab({
        situation: `Merging **rename** into main in **~/${o.project}** conflicts on one line of pricing.conf. With the default markers you only see \`${oldKey}=${ours}\` against \`${newKey}=${b}\`, which looks like a choice. It is not: one side renamed the key, the other changed the value.\n\n1. set **merge.conflictStyle** to **diff3** globally, so markers also show the **base** (the common ancestor);\n2. merge, and resolve to **both** intentions: \`${newKey}=${ours}\`;\n3. finish the merge.`,
        steps: ['git config --global merge.conflictStyle diff3', 'git merge rename', 'cat pricing.conf (the ||||||| section is the base)', `Edit to ${newKey}=${ours}; git add; git commit --no-edit`],
        tips: ['git config --global merge.conflictStyle diff3', 'git merge --abort', 'git checkout --conflict=diff3 FILE (redo the markers)'],
      }),
      hints: ['Compare each side with the base: what did each side change, rather than which side is right?', 'diff3 (or zdiff3) style is a popular default among experienced developers.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('diff3 conflict style is on', `su - ${me.sam} -c 'git config --global merge.conflictStyle'`, { equals: 'diff3' }),
        out('Both intentions are kept', `cd ${home}/${o.project} && git show HEAD:pricing.conf`, { equals: `currency=GHS\n${newKey}=${ours}` }),
        out('The merge is finished', `cd ${home}/${o.project} && git log -1 --format=%s && git status --porcelain`, { equals: "Merge branch 'rename'" }),
      ],
      solution: ['git config --global merge.conflictStyle diff3', `cd ~/${o.project} && git merge rename`, 'cat pricing.conf', `printf 'currency=GHS\\n${newKey}=${ours}\\n' > pricing.conf`, 'git add pricing.conf', 'git commit -q --no-edit'],
      realityNote: 'Seeing the base turns "pick a side" into "apply both changes"; git 2.35 added zdiff3, a tidier version of the same idea.',
    };
  }),

  /* ---------------------------------------------------------------- 4.2 conflicts during rebase and cherry-pick; rerere */
  tmpl(4, 2, 'beginner', 'rebase-conflict', 'Resolve a conflict in the middle of a rebase', 'E4', 25, 'Rebase a branch, resolve the stop, and continue to a linear history.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const [p1, p2, p3] = [v.int(10, 20), v.int(21, 30), v.int(31, 40)];
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add pages', mate, o, { 'site.conf': `title=${o.what}\npage_size=${p1}\n` }), C(`Page size ${p2}`, mate, o, { 'site.conf': `title=${o.what}\npage_size=${p2}\n` })], {}, { branches: { tuning: { from: 0, commits: [C(`Page size ${p3}`, me, o, { 'site.conf': `title=${o.what}\npage_size=${p3}\n` }), C('Add theme', me, o, { 'theme.css': 'body { font-family: sans-serif; }\n' })] } }, checkout: 'tuning' });
    return {
      instructions: lab({
        situation: `Rebase your branch **tuning** in **~/${o.project}** onto main. Its first commit conflicts with main's change to page_size. Keep **your** value, **${p3}**, then let the rebase carry on. At the end tuning must be a straight line on top of main with both your commits.`,
        steps: ['git rebase main (stops at "Page size ' + p3 + '")', 'git status; cat site.conf', `Edit site.conf to page_size=${p3}; git add site.conf`, 'git rebase --continue', 'git log --oneline --graph'],
        tips: ['git rebase --continue', 'git rebase --skip', 'git rebase --abort'],
      }),
      hints: ['During a rebase, "HEAD" in the markers is the branch you are rebasing onto (main), and the other side is your commit being replayed.', 'Continue, do not commit: the rebase makes the commit for you.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('tuning is on top of main', `cd ${home}/${o.project} && git log --format=%s main..tuning && git merge-base --is-ancestor main tuning && echo on-main`, { equals: `Add theme\nPage size ${p3}\non-main` }),
        out('Your value is kept', `cd ${home}/${o.project} && git show tuning:site.conf`, { equals: `title=${o.what}\npage_size=${p3}` }),
        out('No rebase in progress', `cd ${home}/${o.project} && git status | head -1`, { equals: 'On branch tuning' }),
      ],
      solution: [`cd ~/${o.project} && git rebase main`, `printf 'title=${o.what}\\npage_size=${p3}\\n' > site.conf`, 'git add site.conf', 'GIT_EDITOR=true git rebase --continue', 'git log --oneline --graph'],
      realityNote: 'Rebasing replays commits one by one, so a long branch can stop several times; that is a good reason to keep branches short.',
    };
  }),
  tmpl(4, 2, 'intermediate', 'cherry-pick-hotfix', 'Back-port a fix with cherry-pick', 'E4', 25, 'Cherry-pick a fix from main onto a release branch, resolving the conflict and recording where it came from.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const rel = `release/1.${v.int(2, 6)}`;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'login.sh': '#!/bin/bash\nmax_attempts=5\nlock_minutes=0\n' }), C('Add audit log', me, o, { 'audit.sh': '#!/bin/bash\n' }), C('Lock accounts after failed logins', me, o, { 'login.sh': '#!/bin/bash\nmax_attempts=5\nlock_minutes=15\n' })], {}, { branches: { [rel]: { from: 0, commits: [C('Release tweaks', me, o, { 'login.sh': '#!/bin/bash\nmax_attempts=3\nlock_minutes=0\n' })] } } });
    const fix = mutate(files, `${home}/${o.project}`, () => {});
    const fixId = Object.values(fix.commits).find((c) => c.message === 'Lock accounts after failed logins')!.id;
    return {
      instructions: lab({
        situation: `The security fix "Lock accounts after failed logins" (on main in **~/${o.project}**) must also go out in **${rel}**, which is maintained separately. Cherry-pick it onto ${rel} with **-x** (so the message records where it came from). It conflicts: the release branch keeps **its own** \`max_attempts=3\` but must get the fix's \`lock_minutes=15\`.`,
        steps: [`git switch ${rel}`, 'git log --oneline main (find the fix)', 'git cherry-pick -x ID', 'Resolve: max_attempts=3 and lock_minutes=15; git add login.sh', 'git cherry-pick --continue'],
        tips: ['git cherry-pick -x COMMIT', 'git cherry-pick --continue', 'git cherry-pick --abort'],
      }),
      hints: ['-x appends "(cherry picked from commit ...)" so anyone can trace the back-port.', 'Only the fix travels: the release branch keeps its own settings.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('The release has the fix and keeps its own limit', `cd ${home}/${o.project} && git show ${rel}:login.sh`, { equals: '#!/bin/bash\nmax_attempts=3\nlock_minutes=15' }),
        out('The message records the source commit', `cd ${home}/${o.project} && git log -1 --format=%B ${rel}`, { contains: ['Lock accounts after failed logins', `(cherry picked from commit ${fixId})`] }),
        out('No cherry-pick in progress and main untouched', `cd ${home}/${o.project} && git status --porcelain && git log -1 --format=%s main`, { equals: 'Lock accounts after failed logins' }),
      ],
      solution: [`cd ~/${o.project} && git switch ${rel}`, `git cherry-pick -x ${fixId}`, "printf '#!/bin/bash\\nmax_attempts=3\\nlock_minutes=15\\n' > login.sh", 'git add login.sh', 'GIT_EDITOR=true git cherry-pick --continue'],
      realityNote: 'Long-term-support branches (Linux stable, Ubuntu updates) are fed by cherry-picks with -x exactly like this.',
    };
  }),
  tmpl(4, 2, 'advanced', 'rerere-replay', 'Teach Git to reuse a conflict resolution', 'E4', 30, 'Enable rerere, resolve a conflict once, undo the merge, and let rerere resolve it the second time.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const [a, b] = [v.int(100, 400), v.int(401, 800)];
    const agreed = v.int(801, 999);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Add limits', me, o, { 'limits.conf': 'max_users=50\n' }), C(`max_users ${a}`, me, o, { 'limits.conf': `max_users=${a}\n` })], {}, { branches: { capacity: { from: 0, commits: [C(`max_users ${b}`, mate, o, { 'limits.conf': `max_users=${b}\n` })] } } });
    return {
      instructions: lab({
        situation: `Branch **capacity** in **~/${o.project}** keeps being test-merged into main, and conflicts on max_users every time. Teach Git the answer once:\n\n1. enable **rerere** ("reuse recorded resolution") for this repository;\n2. merge capacity, resolve to \`max_users=${agreed}\`, and commit;\n3. undo that merge (\`git reset --hard HEAD~1\`), then merge capacity **again**: rerere should resolve the file for you; just add it and commit.\n\nAt the end main has one merge of capacity with max_users=${agreed}.`,
        steps: ['git config rerere.enabled true', 'git merge capacity ("Recorded preimage")', `echo max_users=${agreed} > limits.conf; git add limits.conf; git commit --no-edit ("Recorded resolution")`, 'git reset --hard HEAD~1', 'git merge capacity ("Resolved ... using previous resolution")', 'git add limits.conf; git commit --no-edit'],
        tips: ['git config rerere.enabled true', 'git rerere status', 'ls .git/rr-cache'],
      }),
      hints: ['rerere records the conflict (preimage) and your fix (postimage); the same conflict later gets the same fix.', 'It is useful for long-running branches that are rebased or test-merged repeatedly.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('rerere is enabled', `cd ${home}/${o.project} && git config rerere.enabled`, { equals: 'true' }),
        out('A resolution is recorded', `cd ${home}/${o.project} && ls .git/rr-cache/*/postimage | wc -l`, { pattern: '^[1-9]' }),
        out('main has one merge with the agreed value', `cd ${home}/${o.project} && git log --merges --format=%s | wc -l && git show HEAD:limits.conf`, { equals: `1\nmax_users=${agreed}` }),
        out('The merge was done twice', `cd ${home}/${o.project} && git reflog | grep -c 'commit (merge)'`, { equals: '2' }),
      ],
      solution: [`cd ~/${o.project} && git config rerere.enabled true`, 'git merge capacity', `echo max_users=${agreed} > limits.conf`, 'git add limits.conf && git commit -q --no-edit', 'git reset -q --hard HEAD~1', 'git merge capacity', 'cat limits.conf', 'git add limits.conf && git commit -q --no-edit'],
      realityNote: 'Maintainers of large projects (the Linux kernel among them) rely on rerere when they rebuild integration branches every day.',
    };
  }),

  /* ---------------------------------------------------------------- 4.3 recovering lost commits, fixing a bad merge, splitting and squashing */
  tmpl(4, 3, 'beginner', 'revert-a-merge', 'Undo a pushed merge with revert -m', 'E4', 25, 'Revert a bad merge commit on a shared branch and push the fix.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const feat = v.pick(['new-checkout', 'fast-search', 'bulk-import']);
    const commits = [C('Initial app', me, o, { 'app.conf': 'workers=4\n', 'app.sh': '#!/bin/bash\n' }), C('Add docs', me, o, { 'README.md': '# App\n' })];
    const brs = { [feat]: { from: 0, commits: [C(`Add ${feat}`, mate, o, { [`${feat}.sh`]: '#!/bin/bash\n', 'app.conf': 'workers=64\n' })] } };
    const local = repo(me.sam, `${home}/${proj}`, commits, {}, { origin: `/srv/git/${proj}.git`, branches: brs });
    const remote = bare(me.sam, `/srv/git/${proj}.git`, commits, {}, { branches: brs });
    return {
      instructions: lab({
        situation: `In **~/${proj}**, merge ${mate.given}'s branch **${feat}** into main (a merge commit), and push. Then imagine production falls over: ${feat} set workers=64. The merge is already pushed, so **revert the merge** (do not rewrite history), keeping main's side, and push again.\n\nAt the end main must have: the merge, then a commit reverting it; app.conf back to workers=4 and ${feat}.sh gone.`,
        steps: [`git merge --no-ff --no-edit ${feat}; git push`, 'git log --oneline --graph', 'git revert -m 1 --no-edit HEAD (parent 1 is main\'s side)', 'git push'],
        tips: ['git revert -m 1 MERGE', 'git show --stat HEAD', 'git log --oneline --graph'],
      }),
      hints: ['A merge has two parents; -m 1 says "undo relative to the first parent", the branch you merged into.', 'To bring the feature back later, revert the revert.'],
      initialState: dev({ me, org: o, files: { ...local, ...remote, '/srv/git/': { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('The remote has the merge and its revert', `git -C /srv/git/${proj}.git log -2 --format=%s main`, { equals: `Revert "Merge branch '${feat}'"\nMerge branch '${feat}'` }),
        out("main's settings are back", `git -C /srv/git/${proj}.git show main:app.conf; git -C /srv/git/${proj}.git ls-tree --name-only main | grep -c ${feat}`, { equals: 'workers=4\n0' }),
      ],
      solution: [`cd ~/${proj} && git merge --no-ff --no-edit ${feat}`, 'git push', 'git revert -m 1 --no-edit HEAD', 'git push', 'git log --oneline --graph'],
      realityNote: 'Forges offer a "Revert" button on merged pull requests that does exactly this.',
    };
  }),
  tmpl(4, 3, 'intermediate', 'split-a-commit', 'Split a commit that mixes two changes', 'E4', 25, 'Undo the last commit but keep its changes, then commit them as two focused commits.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const port = v.int(80, 89) * 100;
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.conf': 'port=8080\n', 'README.md': '# App\n' }), C('Changes', me, o, { 'app.conf': `port=${port}\n`, 'README.md': `# App\n\nListens on port ${port}.\n` })]);
    return {
      instructions: lab({
        situation: `The last commit in **~/${o.project}**, "Changes" (not pushed), mixes a configuration change and a documentation change. Replace it with **two** commits:\n\n1. \`Move to port ${port}\` with only **app.conf**;\n2. \`Document the port\` with only **README.md**.`,
        steps: ['git reset HEAD~1 (undo the commit, keep the changes in the working tree)', 'git add app.conf && git commit -m "Move to port ' + port + '"', 'git add README.md && git commit -m "Document the port"', 'git log --stat -2'],
        tips: ['git reset HEAD~1', 'git log --stat', 'git show --name-only HEAD'],
      }),
      hints: ['A mixed reset moves the branch back and unstages, but leaves your files alone.', 'Then stage and commit one file at a time.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('Two focused commits replace "Changes"', `cd ${home}/${o.project} && git log --format=%s`, { equals: `Document the port\nMove to port ${port}\nInitial app` }),
        out('Each commit touches one file', `cd ${home}/${o.project} && git show --name-only --format= HEAD; git show --name-only --format= HEAD~1`, { equals: 'README.md\napp.conf' }),
        out('Nothing is left over', `cd ${home}/${o.project} && git status --porcelain`, { equals: '' }),
      ],
      solution: [`cd ~/${o.project} && git reset -q HEAD~1`, `git add app.conf && git commit -q -m "Move to port ${port}"`, 'git add README.md && git commit -q -m "Document the port"', 'git log --stat -2'],
      realityNote: 'Focused commits make revert, cherry-pick and bisect useful; with git add -p you can even split changes inside one file.',
    };
  }),
  tmpl(4, 3, 'advanced', 'rescue-and-squash', 'Rescue a deleted branch and squash it before merging', 'E4', 30, 'Find a deleted branch in the reflog, restore it, squash its commits into one, and fast-forward main.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const feat = v.pick(['receipts', 'reminders', 'invoices']);
    const files = repo(me.sam, `${home}/${o.project}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })], {}, { branches: { [feat]: { from: 0, commits: [C('wip', me, o, { [`${feat}.sh`]: '#!/bin/bash\n' }), C('more wip', me, o, { [`${feat}.sh`]: '#!/bin/bash\necho one\n' }), C('done?', me, o, { [`${feat}.sh`]: '#!/bin/bash\necho one\necho two\n' })] } } });
    mutate(files, `${home}/${o.project}`, (st) => {
      const order = Object.values(st.commits).sort((x, y) => x.seq - y.seq);
      const t0 = order[0].time;
      const who = `${me.name} <${email(me, o)}>`;
      const e = (from: string | null, to: string, msg: string, k: number) => ({ from, to, msg, time: t0 + k * 3600000, who });
      st.reflogs = { HEAD: [e(null, order[0].id, 'commit (initial): Initial app', 0), e(order[0].id, order[0].id, `checkout: moving from main to ${feat}`, 1), e(order[0].id, order[1].id, 'commit: wip', 2), e(order[1].id, order[2].id, 'commit: more wip', 3), e(order[2].id, order[3].id, 'commit: done?', 4), e(order[3].id, order[0].id, `checkout: moving from ${feat} to main`, 5)] };
      delete st.branches[feat];
    });
    const msg = `Add ${feat}`;
    return {
      instructions: lab({
        situation: `Your branch **${feat}** in **~/${o.project}** was deleted by mistake before it was merged. Its last commit was "done?". Recover it and land it properly:\n\n1. recreate **${feat}** from the reflog;\n2. turn its three commits into **one** commit with the message \`${msg}\`;\n3. fast-forward **main** to it.`,
        steps: ['git reflog (find "commit: done?")', `git branch ${feat} ID`, `git switch ${feat}; git reset --soft main; git commit -m "${msg}"`, `git switch main; git merge --ff-only ${feat}`],
        tips: ['git reflog', 'git reset --soft COMMIT (keep all changes staged)', 'git merge --ff-only BRANCH'],
      }),
      hints: ['reset --soft main moves the branch back to main but keeps every change staged: one commit then holds them all.', '--ff-only refuses to make a merge commit.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        out('main has one commit for the feature', `cd ${home}/${o.project} && git log --format=%s main`, { equals: `${msg}\nInitial app` }),
        out('It has the final version of the file', `cd ${home}/${o.project} && git show main:${feat}.sh`, { equals: '#!/bin/bash\necho one\necho two' }),
        out(`${feat} and main are the same`, `cd ${home}/${o.project} && [ "$(git rev-parse ${feat})" = "$(git rev-parse main)" ] && echo same`, { equals: 'same' }),
      ],
      solution: [`cd ~/${o.project} && git reflog`, `git branch ${feat} HEAD@{1}`, `git switch ${feat}`, 'git reset --soft main', `git commit -q -m "${msg}"`, 'git switch main', `git merge --ff-only ${feat}`],
      realityNote: 'Squashing before merging is what the "Squash and merge" button does; the reflog is what saves you when a branch disappears.',
    };
  }),

  /* ---------------------------------------------------------------- 4.4 team exercise: four people, one repository */
  tmpl(4, 4, 'beginner', 'four-people-one-repo', 'Integrate four people\'s work in one repository', 'E4', 40, 'Act as each of four teammates in turn, pushing, pulling with rebase and resolving conflicts until everyone\'s work is in.', (v) => {
    const o = v.pick(ORGS);
    const team = v.people(4);
    const [me, ...mates] = team;
    const proj = 'roster';
    const roles = ['backend', 'frontend', 'testing', 'deployment'];
    const base = `# ${o.org} sprint roster\n`;
    const commits = [C('Start roster', me, o, { 'roster.md': base })];
    const files: Record<string, unknown> = { ...sharedBare('root', 'devs', `/srv/git/${proj}.git`, commits) };
    team.forEach((p, i) => {
      const home = `/home/${p.sam}`;
      const clone = repo(p.sam, `${home}/${proj}`, [...commits, C(`Add ${p.given}`, p, o, { 'roster.md': `${base}- ${p.name}: ${roles[i]}\n` })], {}, { origin: `/srv/git/${proj}.git` });
      mutate(clone, `${home}/${proj}`, (st) => {
        const first = Object.values(st.commits).find((c) => !c.parents.length)!.id;
        st.remoteRefs = { 'origin/main': first, 'origin/HEAD': first };
      });
      Object.assign(files, clone, owned({ [`${home}/.gitconfig`]: gitconfig(p, o) }, p.sam));
    });
    const lines = team.map((p, i) => `- ${p.name}: ${roles[i]}`);
    return {
      instructions: lab({
        situation: `Four teammates share **/srv/git/${proj}.git**. Each has a clone **~/${proj}** with one unpushed commit adding their own line to **roster.md**: ${team.map((p) => p.given).join(', ')}. You can act as each of them with \`su - <user>\` (users: ${team.map((p) => p.sam).join(', ')}).\n\nGet all four commits onto main, **in that order**, with a **linear** history (pull with rebase, no merge commits). Each conflict is "both added a line at the end": keep every line, in the same order as the people above.`,
        steps: ['As yourself: cd ~/roster; git push', `su - ${mates[0].sam}; cd roster; git push (rejected); git pull --rebase (conflict)`, 'Edit roster.md to keep both lines; git add roster.md; git rebase --continue; git push; exit', 'Repeat for the other two teammates'],
        tips: ['git pull --rebase', 'git rebase --continue', 'git log --oneline --graph', 'su - USER / exit'],
      }),
      hints: ['The first push wins; everyone after it must integrate before pushing.', 'Keep the earlier people\'s lines first: the roster lists people in the order they joined main.'],
      initialState: { system: { hostname: 'devbox', user: me.sam, cwd: `/home/${me.sam}`, users: Object.fromEntries(team.map((p) => [p.sam, { comment: p.name, groups: ['devs'] }])), groups: { devs: team.map((p) => p.sam) }, packages: { git: { installed: true } }, files } },
      checks: [
        out('All four commits, in order, by four people', `git -C /srv/git/${proj}.git log --reverse --format='%an|%s' main`, { equals: ['Start roster', ...team.map((p) => `Add ${p.given}`)].map((s, i) => `${i === 0 ? me.name : team[i - 1].name}|${s}`).join('\n') }),
        out('Every line is in the roster, in order', `git -C /srv/git/${proj}.git show main:roster.md`, { equals: `${base}${lines.join('\n')}`.trim() }),
        out('The history is linear', `git -C /srv/git/${proj}.git rev-list --merges --count main`, { equals: '0' }),
      ],
      solution: [
        `cd ~/${proj} && git push`,
        ...mates.flatMap((m, k) => [`su - ${m.sam}`, `cd ${proj} && git pull --rebase`, `printf '${base.replace(/\n/g, '\\n')}${lines.slice(0, k + 2).join('\\n')}\\n' > roster.md`, 'git add roster.md && GIT_EDITOR=true git rebase --continue', 'git push', 'exit']),
        `cd ~/${proj} && git pull --rebase && git log --oneline`,
      ],
      realityNote: 'Real teams hit exactly this rhythm on busy branches; trunk-based teams keep it painless with small, frequent pushes.',
    };
  }),
  tmpl(4, 4, 'intermediate', 'shared-repo', 'Set up a repository the whole team can push to', 'E4', 30, 'Create a group-shared bare repository with the right group and permissions, and prove two users can push.', (v) => {
    const o = v.pick(ORGS);
    const team = v.people(3);
    const [me, a, b] = team;
    const proj = o.project;
    const grp = v.pick(['devs', 'webteam', 'builders']);
    const home = `/home/${me.sam}`;
    const files = { ...repo(me.sam, `${home}/${proj}`, [C('Initial app', me, o, { 'app.sh': '#!/bin/bash\n' })]), ...Object.fromEntries(team.map((p) => [`/home/${p.sam}/.gitconfig`, { content: gitconfig(p, o), owner: p.sam, group: p.sam }])) };
    return {
      instructions: lab({
        situation: `You are the admin (sudo) on **devbox**. ${a.given} (${a.sam}) and ${b.given} (${b.sam}) must be able to push to a new shared repository **/srv/git/${proj}.git**:\n\n1. create group **${grp}** with you, ${a.sam} and ${b.sam};\n2. create the **bare**, **group-shared** repository owned by group ${grp};\n3. push your ~/${proj} main to it.\n\n${a.given} must be able to clone it and push a commit.`,
        steps: [`sudo groupadd ${grp}; sudo usermod -aG ${grp} ${me.sam} (and the other two)`, `sudo mkdir -p /srv/git; sudo git init --bare --shared=group /srv/git/${proj}.git`, `sudo chgrp -R ${grp} /srv/git/${proj}.git`, `cd ~/${proj}; git remote add origin /srv/git/${proj}.git; git push -u origin main`],
        tips: ['git init --bare --shared=group DIR', 'sudo chgrp -R GROUP DIR', 'ls -ld DIR (look for the s in rws)', 'id USER'],
      }),
      hints: ['--shared=group makes the repository group-writable and sets the set-group-ID bit, so new files inherit the group.', 'The group must own the files: chgrp -R after creating them as root.'],
      initialState: { system: { hostname: 'devbox', user: me.sam, cwd: home, users: { [me.sam]: { comment: me.name, groups: ['wheel'] }, [a.sam]: { comment: a.name }, [b.sam]: { comment: b.name } }, packages: { git: { installed: true } }, files } },
      checks: [
        out(`${grp} has all three`, `getent group ${grp}`, { pattern: `^${grp}:x:\\d+:(?=.*\\b${me.sam}\\b)(?=.*\\b${a.sam}\\b)(?=.*\\b${b.sam}\\b)` }),
        out('The repository is bare and shared', `git -C /srv/git/${proj}.git config core.sharedRepository; stat -c '%G %A' /srv/git/${proj}.git`, { pattern: `^(group|true|1)\\n${grp} drwxrws` }),
        out('Your main is there', `git -C /srv/git/${proj}.git log --format=%s main`, { equals: 'Initial app' }),
        out(`${a.given} can clone and push`, `su - ${a.sam} -c 'git clone -q /srv/git/${proj}.git t && cd t && echo x > a.txt && git add a.txt && git commit -qm test && git push -q && echo pushed'`, { contains: 'pushed' }),
      ],
      solution: [`sudo groupadd ${grp}`, ...team.map((p) => `sudo usermod -aG ${grp} ${p.sam}`), 'sudo mkdir -p /srv/git', `sudo git init -q --bare --shared=group /srv/git/${proj}.git`, `sudo chgrp -R ${grp} /srv/git/${proj}.git`, `cd ~/${proj} && git remote add origin /srv/git/${proj}.git && git push -u origin main`],
      realityNote: 'Before forges, teams shared repositories exactly like this over SSH; it is still how small offices without internet host Git on a local server.',
    };
  }),
  tmpl(4, 4, 'advanced', 'force-push-postmortem', 'Learn from a force push that wiped a teammate\'s work', 'E10', 20, 'Reconstruct what happened when a force push erased commits, recover them, and set rules so it cannot recur.', (v) => {
    const o = v.pick(ORGS);
    const [a, b] = v.people(2);
    return caseStudy(v, {
      intro: `## Friday afternoon\n\nAt ${o.org}, ${a.name} rebased their local main and ran \`git push --force\`. An hour later ${b.name} noticed that three of their commits, pushed that morning, had vanished from main on the forge.`,
      steps: [
        { title: 'What happened', text: `${a.given}'s local main did not have ${b.given}'s three commits.`, choices: [{ text: "--force replaced the remote main with a history that did not contain them: the forge's main simply stopped pointing at them", right: true, feedback: 'Correct. A force push moves the remote branch to whatever you push, whatever it held before.' }, { text: 'Git deleted the commits from every clone', feedback: 'Other clones still have them; only the remote branch moved.' }, { text: 'The forge lost data', feedback: 'The forge did what it was told.' }] },
        { title: 'Getting the work back', text: 'Nobody has run garbage collection.', choices: [{ text: `${b.given} still has the commits in their clone: fetch, rebase them onto the new main and push normally (or use the forge's activity log to restore the old ref)`, right: true, feedback: 'Correct. Distributed history means the work survives in the clone that made it.' }, { text: 'Rewrite the three commits from memory', feedback: 'Unnecessary: they still exist.' }, { text: 'Force-push again from an old backup', feedback: 'Another force push risks wiping what others pushed in the meantime.' }] },
        { title: 'The safer command', text: `${a.given} did need to replace a rebased branch.`, choices: [{ text: 'git push --force-with-lease, which refuses if the remote moved since you last fetched', right: true, feedback: 'Correct. The lease protects work you have not seen.' }, { text: 'git push --force, but more carefully', feedback: 'Care does not see commits you never fetched.' }, { text: 'Never rebase', feedback: 'Rebasing private branches is fine; force-pushing shared ones is the problem.' }] },
        { title: 'Stopping it for good', text: 'The team wants this to be impossible on main.', choices: [{ text: 'Protect main: no force pushes, changes through pull requests, and keep rebasing to personal branches', right: true, feedback: 'Correct. Branch protection makes the forge refuse the dangerous push.' }, { text: 'Remove everyone\'s write access', feedback: 'Stops the work along with the risk.' }, { text: 'Ask people to be careful in the chat', feedback: 'Rules that rely on memory fail on Friday afternoons.' }] },
        { title: 'The post-mortem', text: 'You write it up.', choices: [{ text: 'Blameless: timeline, why the system allowed it, what changed (protection, --force-with-lease alias), no naming and shaming', right: true, feedback: 'Correct. Blameless reviews fix the system and keep people reporting mistakes.' }, { text: `Make ${a.given} apologise to the team`, feedback: 'Blame teaches people to hide mistakes.' }, { text: 'Skip it; the work is back', feedback: 'Then it will happen again.' }] },
      ],
      ending: { title: 'Make the dangerous thing impossible', text: 'Force-push only private branches, use --force-with-lease, protect shared branches, and write blameless post-mortems.' },
      hints: ['Ask where the "lost" commits still exist.', 'Prefer controls that make mistakes impossible over reminders to be careful.'],
      realityNote: 'Forges keep a push log (GitHub\'s activity view, GitLab\'s audit events) that shows the old tip of a force-pushed branch, so it can be restored.',
    });
  }),
];

void file;
void (null as unknown as Person);
