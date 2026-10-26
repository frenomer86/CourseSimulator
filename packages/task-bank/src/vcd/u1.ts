/** Unit 1: why version control, and the Git model. */

import type { TaskTemplate } from '../types';
import { seedRepo } from '@cslab/engine-shell/src/git-state';
import { C, ORGS, blobId, caseStudy, dev, email, file, gitconfig, lab, out, owned, pkg, repo, tmpl, treeId } from './kit';
import type { GitState } from '@cslab/engine-shell/src/git-state';

/** The saved state of a seeded repository (to compute the ids a lab expects). */
function stateOf(files: Record<string, unknown>, path: string): GitState {
  const f = files[`${path}/.git/state.json`] as string | { content: string };
  return JSON.parse(typeof f === 'string' ? f : f.content) as GitState;
}

export const U1: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 1.1 the problem; centralised versus distributed */
  tmpl(1, 1, 'beginner', 'copies-of-copies', 'Why copies of copies fail', 'E10', 15, 'Trace what goes wrong when a team shares files by e-mail and USB stick, and what version control changes.', (v) => {
    const o = v.pick(ORGS);
    const [a, b] = v.people(2);
    const n = v.int(4, 9);
    return caseStudy(v, {
      intro: `## Which file is the real one?\n\nThe ${o.what} at ${o.org} is maintained by ${a.name} and ${b.name}. They share the code by e-mail and a USB stick. The shared folder now holds ${n} copies such as \`config_final.txt\`, \`config_final2_${b.given.toLowerCase()}.txt\` and \`config_FINAL_use_this.txt\`. Yesterday a fix that ${a.given} made last month disappeared from the live system.`,
      steps: [
        { title: 'What went wrong', text: `${b.given} edited an older copy and sent it on; nobody can tell which copy had ${a.given}'s fix.`, choices: [{ text: 'There is no single history: no record of who changed what, when, and from which version', right: true, feedback: 'Correct. Copies carry content but not lineage, so a later copy can silently drop earlier work.' }, { text: `${b.given} was careless`, feedback: 'Anyone working this way loses work eventually; the process is the problem.' }, { text: 'The USB stick was faulty', feedback: 'The files are intact; what is missing is the record of how they relate.' }] },
        { title: 'What version control records', text: 'They are considering Git.', choices: [{ text: 'Every change as a commit with author, date, message and parent, so history, blame and recovery are possible', right: true, feedback: 'Correct. A commit is a snapshot plus who, when, why and what came before.' }, { text: 'Only the latest version, stored more safely', feedback: 'That is a backup, not version control.' }, { text: 'A copy of every file each time anyone saves', feedback: 'Saves are not commits: a commit is a deliberate, described snapshot.' }] },
        { title: 'Centralised or distributed', text: 'An older tool keeps history only on one server (centralised, like Subversion). Git gives every clone the full history (distributed).', choices: [{ text: 'With Git, work and history continue offline and any clone can rebuild a lost server', right: true, feedback: 'Correct. Distributed version control suits unreliable connections: commit locally, sync when online.' }, { text: 'Centralised is safer because there is only one copy', feedback: 'One copy is a single point of failure.' }, { text: 'There is no practical difference', feedback: 'There is: where history lives decides what still works when the server or network is down.' }] },
        { title: 'Conflicts', text: `${a.given} and ${b.given} will sometimes edit the same line.`, choices: [{ text: 'Git merges changes to different lines automatically and stops on the same line, asking a person to decide', right: true, feedback: 'Correct. A conflict is Git refusing to guess, which is exactly what you want.' }, { text: 'The last person to save wins', feedback: 'That is how work was lost here.' }, { text: 'They must never work at the same time', feedback: 'Parallel work is the point; merging handles it.' }] },
        { title: 'Getting started', text: 'They have one afternoon.', choices: [{ text: 'Put the current code in a Git repository, agree a main branch, and push to a shared remote', right: true, feedback: 'Correct. Start the history now; the old copies can be imported or archived.' }, { text: 'First tidy every old copy into a perfect history', feedback: 'Useful later, but it delays the benefit.' }, { text: 'Wait until the project is finished', feedback: 'History is most valuable while the work is changing.' }] },
      ],
      ending: { title: 'One history instead of many copies', text: 'Version control replaces copies with commits that record who, what, when and why; distributed Git keeps the full history on every clone.' },
      hints: ['Ask what information the copies lack, not who made them.', 'Think about what happens when the server or the internet is unavailable.'],
      realityNote: 'Subversion and Perforce are centralised; Git and Mercurial are distributed. Git dominates because every clone is a complete, offline-capable backup.',
    });
  }),
  tmpl(1, 1, 'intermediate', 'copies-into-history', 'Turn a folder of copies into a history', 'E4', 25, 'Import three versions of a file, oldest first, as commits with the original authors and dates.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const people = v.people(3);
    const days = ['2026-09-01', '2026-09-08', '2026-09-15'];
    const names = ['config_v1.txt', `config_v2_${people[1].given.toLowerCase()}.txt`, 'config_FINAL.txt'];
    const base = v.int(2, 5) * 500;
    const versions = [`price=${base}\ncurrency=GHS\n`, `price=${base + 100}\ncurrency=GHS\n`, `price=${base + 100}\ncurrency=GHS\ntimeout=${v.int(20, 60)}\n`];
    const home = `/home/${me.sam}`;
    const manifest = names.map((n, i) => `${n.padEnd(24)} ${days[i]}  ${people[i].name} <${email(people[i], o)}>`).join('\n') + '\n';
    return {
      instructions: lab({
        situation: `**~/config-archive** holds the copies of the ${o.what}'s config that have been mailed around, and **versions.txt** says who made each one and when:\n\n\`\`\`\n${manifest}\`\`\`\n\nCreate a repository **~/config** with one file, **config.txt**, whose history is those three versions as three commits, **oldest first**, each with the original **author** and **date**, and the message \`Config as of <date>\` (for example \`Config as of ${days[0]}\`).`,
        steps: ['mkdir ~/config && cd ~/config && git init', 'cp ~/config-archive/config_v1.txt config.txt', `git add config.txt && git commit --author="NAME <EMAIL>" --date=${days[0]} -m "Config as of ${days[0]}"`, 'Repeat for the next two versions, then check git log.'],
        tips: ['git log --format="%an %ad %s" --date=short', 'git commit --author="Name <email>" --date=YYYY-MM-DD -m "..."'],
      }),
      hints: ['--author and --date set the author fields; Git still records you as the committer.', 'Import oldest first so the history reads forwards.'],
      initialState: dev({ me, org: o, files: owned({ ...Object.fromEntries(names.map((n, i) => [`${home}/config-archive/${n}`, versions[i]])), [`${home}/config-archive/versions.txt`]: manifest }, me.sam) }),
      checks: [
        out('Three commits, oldest first, with the original authors and dates', `cd ${home}/config && git log --reverse --format='%an|%ad|%s' --date=short`, { equals: days.map((d, i) => `${people[i].name}|${d}|Config as of ${d}`).join('\n') }),
        out('Each commit holds that version of the file', `cd ${home}/config && for c in $(git rev-list --reverse HEAD); do git show $c:config.txt | head -1; done`, { equals: versions.map((x) => x.split('\n')[0]).join('\n') }),
        out('The working tree is clean', `cd ${home}/config && git status --porcelain`, { equals: '' }),
      ],
      solution: [
        'mkdir ~/config && cd ~/config && git init -q',
        ...names.map((n, i) => `cp ~/config-archive/${n} config.txt && git add config.txt && git commit -q --author="${people[i].name} <${email(people[i], o)}>" --date=${days[i]} -m "Config as of ${days[i]}"`),
        'git log --format="%an %ad %s" --date=short',
      ],
      realityNote: 'Teams moving to Git often import old releases this way so that blame and log reach back before the move; git fast-import does it at scale.',
    };
  }),
  tmpl(1, 1, 'advanced', 'rebuild-the-server', 'Rebuild a lost central repository from a clone', 'E4', 25, 'Recreate the shared bare repository with every branch and tag from a developer clone.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const mate = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const tags = [`v1.${v.int(0, 3)}.0`, `v1.${v.int(4, 6)}.0`];
    const commits = [C('Initial import', mate, o, { 'README.md': `# ${o.what}\n`, 'app.conf': 'port=8080\n' }), C('Add logging', me, o, { 'app.conf': 'port=8080\nlog=info\n' }), C('Raise timeout', mate, o, { 'app.conf': 'port=8080\nlog=info\ntimeout=30\n' })];
    const files = {
      ...repo(me.sam, `${home}/${proj}`, commits, { [tags[0]]: 1, [tags[1]]: 2 }, { origin: `/srv/git/${proj}.git`, branches: { develop: { from: 2, commits: [C('Start reports page', me, o, { 'reports.md': '# Reports\n' })] } } }),
    };
    return {
      instructions: lab({
        situation: `The server disk failed and **/srv/git/${proj}.git**, the team's shared repository, is gone. Your clone **~/${proj}** has the full history, with branches **main** and **develop** and tags **${tags.join('** and **')}**.\n\nRecreate **/srv/git/${proj}.git** as a **bare** repository holding **both branches and both tags**, exactly as in your clone, so ${mate.given} can keep pushing to the same address.`,
        steps: [`git init --bare /srv/git/${proj}.git`, `cd ~/${proj}; git push --all origin`, 'git push --tags origin', `git ls-remote origin`],
        tips: [`git clone --bare ~/${proj} /srv/git/${proj}.git (also works)`, 'git push --all origin', 'git push --tags origin', 'git ls-remote origin'],
      }),
      hints: ['Every clone of a distributed repository is a complete copy: the server is just one more clone.', 'A bare repository has no working tree: it only stores history, which is what a shared remote needs.'],
      initialState: dev({ me, org: o, files: { ...files, '/srv/git/': { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('The shared repository is bare', `git -C /srv/git/${proj}.git rev-parse --is-bare-repository`, { equals: 'true' }),
        out('Both branches match your clone', `cd ${home}/${proj}; for b in main develop; do [ "$(git rev-parse $b)" = "$(git -C /srv/git/${proj}.git rev-parse $b)" ] && echo "$b same"; done`, { equals: 'main same\ndevelop same' }),
        out('Both tags are there', `git -C /srv/git/${proj}.git tag`, { contains: tags }),
        out('Your clone can fetch from it again', `cd ${home}/${proj} && git fetch origin && git status -sb | head -1`, { pattern: `## main\\.\\.\\.origin/main$` }),
      ],
      solution: [`git init -q --bare /srv/git/${proj}.git`, `cd ~/${proj} && git push --all origin && git push --tags origin`, 'git ls-remote origin'],
      realityNote: 'After a forge outage, teams restore repositories from developer clones in exactly this way; it is why Git is called distributed.',
    };
  }),

  /* ---------------------------------------------------------------- 1.2 the object model */
  tmpl(1, 2, 'beginner', 'read-the-objects', 'Read the objects behind a commit', 'E4', 20, 'Use hash-object, cat-file and rev-parse to find blob, tree and parent ids.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const readme = `# ${o.what}\n\nRun ./start.sh to begin.\n`;
    const files = repo(me.sam, `${home}/${proj}`, [C('Add README', me, o, { 'README.md': readme }), C(`Add start script`, me, o, { 'start.sh': `#!/bin/bash\necho "starting ${proj}"\n` })]);
    const st = stateOf(files as Record<string, unknown>, `${home}/${proj}`);
    const head = st.branches.main!;
    const parent = st.commits[head].parents[0];
    const tree = treeId(st.commits[head].tree, st.commits[head].x);
    return {
      instructions: lab({
        situation: `Git stores **blobs** (file contents), **trees** (directories) and **commits** (a tree, parents, author and message), each named by its SHA-1. In **~/${proj}**, find:\n\n1. the blob id of **README.md**;\n2. the id of the **tree** that HEAD points to;\n3. the id of HEAD's **parent** commit.\n\nWrite them to **~/objects.txt**, one per line, as \`blob <id>\`, \`tree <id>\` and \`parent <id>\` (full 40-character ids).`,
        steps: ['git hash-object README.md', 'git cat-file -p HEAD (shows the tree and parent lines)', 'git rev-parse HEAD^{tree} and git rev-parse HEAD~1', 'Write the three lines to ~/objects.txt.'],
        tips: ['git cat-file -t HEAD', 'git cat-file -p HEAD', 'git ls-tree HEAD', 'git rev-parse HEAD~1'],
      }),
      hints: ['The same content always gives the same blob id, on any machine.', 'cat-file -p HEAD prints the commit object itself.'],
      initialState: dev({ me, org: o, files }),
      checks: [
        file('The blob id of README.md', `${home}/objects.txt`, { pattern: `^blob ${blobId(readme)}$` }),
        file('The tree of HEAD', `${home}/objects.txt`, { pattern: `^tree ${tree}$` }),
        file("HEAD's parent", `${home}/objects.txt`, { pattern: `^parent ${parent}$` }),
      ],
      solution: [`cd ~/${proj}`, 'git cat-file -p HEAD', 'echo "blob $(git hash-object README.md)" > ~/objects.txt', 'echo "tree $(git rev-parse HEAD^{tree})" >> ~/objects.txt', 'echo "parent $(git rev-parse HEAD~1)" >> ~/objects.txt', 'cat ~/objects.txt'],
      realityNote: 'These ids are the same in real Git: content addressing is why a single changed byte changes every id above it, and why history cannot be altered unnoticed.',
    };
  }),
  tmpl(1, 2, 'intermediate', 'three-areas', 'Commit from the index, not the working tree', 'E4', 20, 'Stage one change, keep a second change unstaged, and commit only the staged one.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const items = v.some(['bread', 'rice', 'maize', 'beans', 'yam', 'garri', 'sugar'], 3);
    const prices = items.map(() => v.int(10, 90));
    const csv = `item,price\n${items.map((it, i) => `${it},${prices[i]}`).join('\n')}\n`;
    const [a, b] = [items[0], items[2]];
    const na = prices[0] + v.int(2, 9);
    const nb = prices[2] + v.int(2, 9);
    const staged = csv.replace(`${a},${prices[0]}`, `${a},${na}`);
    const both = staged.replace(`${b},${prices[2]}`, `${b},${nb}`);
    return {
      instructions: lab({
        situation: `In **~/prices** the file **prices.csv** is committed. Git has three areas: the **working tree** (your files), the **index** (what the next commit will contain) and the **repository** (commits). Make one commit that changes only **${a}** to **${na}**, while your working tree also has **${b}** changed to **${nb}**, not committed yet:\n\n1. change ${a} and **stage** it;\n2. change ${b} but **do not stage** it;\n3. commit with the message \`Raise ${a} price\`.\n\nAfterwards \`git diff\` should show only the ${b} change.`,
        steps: [`sed -i 's/^${a},.*/${a},${na}/' prices.csv && git add prices.csv`, `sed -i 's/^${b},.*/${b},${nb}/' prices.csv`, 'git status (one file, staged and modified)', `git commit -m "Raise ${a} price" (no -a!)`],
        tips: ['git diff (working tree vs index)', 'git diff --staged (index vs last commit)', 'git status'],
      }),
      hints: ['git commit takes the index, not the working tree; -a would stage everything first.', 'A file can be both staged and modified: the index holds one version, the working tree another.'],
      initialState: dev({ me, org: o, files: repo(me.sam, `${home}/prices`, [C('Add price list', me, o, { 'prices.csv': csv })]) }),
      checks: [
        out('The commit changes only the first price', `cd ${home}/prices && git show HEAD:prices.csv`, { equals: staged.trim() }),
        out('The commit message', `cd ${home}/prices && git log -1 --format=%s`, { equals: `Raise ${a} price` }),
        file('The second change is still in the working tree', `${home}/prices/prices.csv`, { equals: both.trim() }),
        out('git diff shows only the uncommitted change', `cd ${home}/prices && git diff | grep '^[-+][a-z]'`, { equals: `-${b},${prices[2]}\n+${b},${nb}` }),
      ],
      solution: [`cd ~/prices && sed -i 's/^${a},.*/${a},${na}/' prices.csv && git add prices.csv`, `sed -i 's/^${b},.*/${b},${nb}/' prices.csv`, 'git status', `git commit -q -m "Raise ${a} price"`, 'git diff'],
      realityNote: 'Staging lets you shape commits: real work often mixes changes that belong in different commits (git add -p does this hunk by hunk).',
    };
  }),
  tmpl(1, 2, 'advanced', 'dangling-commit', 'Recover a commit that no branch points to', 'E4', 25, 'Find an unreachable commit with fsck and give it a branch again.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const feat = v.pick(['monthly-report', 'sms-alerts', 'export-csv']);
    const msg = ({ 'monthly-report': 'Add monthly report', 'sms-alerts': 'Add SMS alerts', 'export-csv': 'Add CSV export' } as Record<string, string>)[feat];
    const featFile = ({ 'monthly-report': 'report.sh', 'sms-alerts': 'alerts.sh', 'export-csv': 'export.sh' } as Record<string, string>)[feat];
    const files = seedRepo(`${home}/${proj}`, [C('Initial import', me, o, { 'README.md': `# ${o.what}\n` }), C('Add config', me, o, { 'app.conf': 'port=8080\n' })], {}, { branches: { [feat]: { from: 1, commits: [C(msg, me, o, { [featFile]: `#!/bin/bash\necho "${feat}"\n` })] } } });
    // The branch was deleted with "git branch -D": the commit is still stored, but nothing points to it.
    const sp = `${home}/${proj}/.git/state.json`;
    const st = JSON.parse(files[sp] as string) as GitState;
    const lost = st.branches[feat]!;
    delete st.branches[feat];
    files[sp] = JSON.stringify(st);
    return {
      instructions: lab({
        situation: `Yesterday someone ran \`git branch -D ${feat}\` in **~/${proj}** by mistake, and the reflog of this clone was cleared. The commit "${msg}" was never merged. A branch is only a name pointing at a commit, and Git keeps unreferenced commits until garbage collection.\n\nFind the lost commit and recreate the branch **${feat}** pointing at it.`,
        steps: ['git fsck --lost-found (lists dangling commits)', 'git show ID to confirm it is the right one', `git branch ${feat} ID`, `git log --oneline ${feat}`],
        tips: ['git fsck --unreachable', 'git show --stat ID', 'git branch NAME ID'],
      }),
      hints: ['Deleting a branch deletes the name, not the commits.', 'git gc --prune would remove them for good: recover before it runs.'],
      initialState: dev({ me, org: o, files: owned(files, me.sam) }),
      checks: [
        out('The branch exists again', `cd ${home}/${proj} && git rev-parse ${feat}`, { equals: lost }),
        out('It holds the lost work', `cd ${home}/${proj} && git show ${feat}:${featFile}`, { contains: feat }),
      ],
      solution: [`cd ~/${proj} && git fsck --lost-found`, `git branch ${feat} ${lost}`, `git log --oneline ${feat}`],
      realityNote: 'git fsck and the reflog are the standard rescue tools; hosting services also keep unreachable objects for a while, which is why "deleted" commits can often be recovered.',
    };
  }),

  /* ---------------------------------------------------------------- 1.3 installing, identity, CLI and GUI */
  tmpl(1, 3, 'beginner', 'install-and-identity', 'Install Git and set your identity', 'E4', 15, 'Install git, then set your name, e-mail, default branch and editor globally.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const editor = v.pick(['nano', 'vim']);
    return {
      instructions: lab({
        situation: `This new laptop (openSUSE) has no Git yet. Set it up for ${me.name} at ${o.org}:\n\n1. install **git**;\n2. set your global **user.name** to \`${me.name}\` and **user.email** to \`${email(me, o)}\`;\n3. make new repositories start on a branch called **main**;\n4. use **${editor}** as Git's editor.`,
        steps: ['sudo zypper install -y git', `git config --global user.name "${me.name}"`, `git config --global user.email ${email(me, o)}`, 'git config --global init.defaultBranch main', `git config --global core.editor ${editor}`, 'git config --global --list'],
        tips: ['git --version', 'git config --global --list', 'cat ~/.gitconfig'],
      }),
      hints: ['Every commit records the name and e-mail; set them before the first commit.', '--global writes ~/.gitconfig, which applies to all your repositories.'],
      initialState: dev({ me, org: o, identity: false, noGit: true }),
      checks: [
        pkg('git is installed', 'git'),
        out('Your name and e-mail', `su - ${me.sam} -c 'git config --global user.name; git config --global user.email'`, { equals: `${me.name}\n${email(me, o)}` }),
        out('New repositories start on main', `su - ${me.sam} -c 'git config --global init.defaultBranch'`, { equals: 'main' }),
        out(`The editor is ${editor}`, `su - ${me.sam} -c 'git config --global core.editor'`, { equals: editor }),
      ],
      solution: ['sudo zypper install -y git', `git config --global user.name "${me.name}"`, `git config --global user.email ${email(me, o)}`, 'git config --global init.defaultBranch main', `git config --global core.editor ${editor}`, 'git config --global --list'],
      realityNote: 'Graphical clients (GitHub Desktop, Sourcetree, the Git panels in VS Code) read the same ~/.gitconfig; learning the command line makes every client make sense.',
    };
  }),
  tmpl(1, 3, 'intermediate', 'work-identity', 'Use a different identity in one repository', 'E4', 15, 'Keep a personal global identity but commit with the work e-mail in the work repository.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const personal = `${me.given.toLowerCase()}.${me.surname.toLowerCase()}@mail.lab`;
    const work = email(me, o);
    const proj = o.project;
    const line = `owner=${me.sam}`;
    return {
      instructions: lab({
        situation: `Your global Git e-mail is your personal address, ${personal}. ${o.org}'s rules say commits to **~/${proj}** must use your work address **${work}**.\n\n1. set the work e-mail **only for ~/${proj}** (your global e-mail must stay ${personal});\n2. add the line \`${line}\` to **${proj}.conf** and commit it with the message \`Add owner\`.`,
        steps: [`cd ~/${proj}`, `git config user.email ${work} (no --global)`, `echo "${line}" >> ${proj}.conf && git commit -am "Add owner"`, 'git log -1 --format="%an <%ae>"'],
        tips: ['git config user.email', 'git config --global user.email', 'git config --list --show-origin'],
      }),
      hints: ['Without --global, git config writes .git/config, which overrides ~/.gitconfig for that repository only.', 'Check with git config --show-origin to see which file a value comes from.'],
      initialState: dev({ me, org: o, files: { ...owned({ [`${home}/.gitconfig`]: `[user]\n\tname = ${me.name}\n\temail = ${personal}\n` }, me.sam), ...repo(me.sam, `${home}/${proj}`, [C('Initial config', me, o, { [`${proj}.conf`]: 'port=8080\n' })]) } }),
      checks: [
        out('The commit uses the work e-mail', `cd ${home}/${proj} && git log -1 --format='%s|%ae'`, { equals: `Add owner|${work}` }),
        out('The repository has its own e-mail', `cd ${home}/${proj} && git config --local user.email`, { equals: work }),
        file('The global e-mail is unchanged', `${home}/.gitconfig`, { contains: personal, notContains: work }),
      ],
      solution: [`cd ~/${proj} && git config user.email ${work}`, `echo "${line}" >> ${proj}.conf && git commit -qam "Add owner"`, 'git log -1 --format="%an <%ae>"'],
      realityNote: 'Many developers use includeIf in ~/.gitconfig to switch identity by folder; forges match commits to accounts by e-mail.',
    };
  }),
  tmpl(1, 3, 'advanced', 'aliases-and-defaults', 'Set aliases, a global ignore file and safer defaults', 'E4', 20, 'Configure aliases, a global excludes file and pull/push defaults, and prove they work.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const junk = v.pick(['*.swp', '*~', '.DS_Store']);
    const proj = o.project;
    return {
      instructions: lab({
        situation: `Set up Git the way ${o.org}'s team works:\n\n1. alias **lg** for \`log --oneline --graph --all\` and **st** for \`status -sb\`;\n2. a global ignore file **~/.gitignore_global** (set as **core.excludesFile**) that ignores **${junk}** and **.env** files in every repository;\n3. \`git pull\` should **rebase** by default, and \`git push\` should set the upstream of a new branch automatically.\n\nThen in **~/${proj}**, create a file matching ${junk === '*~' ? '`notes.txt~`' : junk === '*.swp' ? '`.app.conf.swp`' : '`.DS_Store`'} and a **.env** file and check that \`git st\` does not list them.`,
        steps: ['git config --global alias.lg "log --oneline --graph --all"', 'git config --global alias.st "status -sb"', `printf '${junk}\\n.env\\n' > ~/.gitignore_global && git config --global core.excludesFile ~/.gitignore_global`, 'git config --global pull.rebase true', 'git config --global push.autoSetupRemote true'],
        tips: ['git config --global --list', 'git check-ignore -v FILE', 'git st'],
      }),
      hints: ['A global excludes file is for files your tools create; project rules belong in the project .gitignore.', 'Aliases are shortcuts: git lg runs git log --oneline --graph --all.'],
      initialState: dev({ me, org: o, files: repo(me.sam, `${home}/${proj}`, [C('Initial import', me, o, { 'app.conf': 'port=8080\n' })]) }),
      checks: [
        out('The aliases work', `su - ${me.sam} -c 'cd ${proj} && git lg | head -1 && git st | head -1'`, { pattern: '^\\* [0-9a-f]{7} .*Initial import\\n## main$' }),
        out('The global ignore file is set and used', `su - ${me.sam} -c 'cd ${proj} && touch ${junk === '.DS_Store' ? '.DS_Store' : 'probe' + junk.replace('*', '')} .env && git status --porcelain'`, { equals: '' }),
        out('pull rebases and push sets the upstream', `su - ${me.sam} -c 'git config --global pull.rebase; git config --global push.autoSetupRemote'`, { equals: 'true\ntrue' }),
      ],
      solution: ['git config --global alias.lg "log --oneline --graph --all"', 'git config --global alias.st "status -sb"', `printf '${junk}\\n.env\\n' > ~/.gitignore_global`, 'git config --global core.excludesFile ~/.gitignore_global', 'git config --global pull.rebase true', 'git config --global push.autoSetupRemote true', `cd ~/${proj} && touch .env && git st`],
      realityNote: 'pull.rebase and push.autoSetupRemote are popular modern defaults; a global excludes file keeps editor junk out of every project without cluttering their .gitignore.',
    };
  }),

  /* ---------------------------------------------------------------- 1.4 shell basics for the course */
  tmpl(1, 4, 'beginner', 'paths-and-pipes', 'Find work left to do with paths and pipes', 'E4', 15, 'Search a project for TODO notes, sort them and save the list.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const notes = v.some(['check the PIN length', 'handle network errors', 'log failed payments', 'add Twi translation', 'retry SMS sending', 'validate dates', 'remove debug output'], 4);
    const files: Record<string, string> = {
      [`${home}/${proj}/bin/start.sh`]: `#!/bin/bash\n# TODO: ${notes[0]}\necho start\n`,
      [`${home}/${proj}/lib/pay.sh`]: `#!/bin/bash\npay() {\n  # TODO: ${notes[1]}\n  echo paid\n}\n# TODO: ${notes[2]}\n`,
      [`${home}/${proj}/docs/notes.md`]: `# Notes\nTODO: ${notes[3]}\n`,
      [`${home}/${proj}/README.md`]: `# ${o.what}\nNo TODO items here.\n`,
    };
    const expected = ['bin/start.sh:2', 'lib/pay.sh:3', 'lib/pay.sh:6'].map((k, i) => `${k}:${[`# TODO: ${notes[0]}`, `  # TODO: ${notes[1]}`, `# TODO: ${notes[2]}`][i]}`);
    return {
      instructions: lab({
        situation: `Before the release, list the TODO notes left in the **shell scripts** (*.sh files) of **~/${proj}**. Save them to **~/todo.txt** as \`path:line:text\`, with paths relative to the project (for example \`bin/start.sh:2:...\`), sorted by path. Only lines that contain \`TODO:\` in .sh files count.`,
        steps: [`cd ~/${proj}`, "grep -rn --include='*.sh' 'TODO:' . (try it first)", "grep -rn --include='*.sh' 'TODO:' bin lib | sort > ~/todo.txt", 'cat ~/todo.txt'],
        tips: ['pwd; ls -R', 'grep -rn PATTERN DIR', 'sort', 'command > file'],
      }),
      hints: ['Relative paths come from where you run grep: run it inside the project.', 'A pipe | sends one command\'s output into the next; > saves it to a file.'],
      initialState: dev({ me, org: o, files: owned(files, me.sam) }),
      checks: [file('The TODO list', `${home}/todo.txt`, { equals: expected.join('\n') })],
      solution: [`cd ~/${proj} && grep -rn --include='*.sh' 'TODO:' bin lib | sort > ~/todo.txt`, 'cat ~/todo.txt'],
      realityNote: 'Shell pipelines like this are the glue of DevOps work: CI steps, hooks and release scripts are mostly small commands joined by pipes.',
    };
  }),
  tmpl(1, 4, 'intermediate', 'environment-and-path', 'Put your own tools on the PATH', 'E4', 20, 'Write a small script in ~/bin, put ~/bin on PATH and set EDITOR in ~/.bashrc.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const home = `/home/${me.sam}`;
    const tool = v.pick(['gst', 'repo-status', 'whatchanged']);
    const editor = v.pick(['nano', 'vim']);
    return {
      instructions: lab({
        situation: `Create a command **${tool}** that prints \`branch: <current branch>\` for the Git repository you are in (use \`git rev-parse --abbrev-ref HEAD\`). Put it in **~/bin/${tool}** (executable).\n\nThen make it and your editor available in every new shell, by adding to **~/.bashrc**:\n\n- **~/bin** at the front of **PATH**;\n- **EDITOR** set to **${editor}**, exported.`,
        steps: ['mkdir -p ~/bin', `printf '#!/bin/bash\\necho "branch: $(git rev-parse --abbrev-ref HEAD)"\\n' > ~/bin/${tool}`, `chmod +x ~/bin/${tool}`, `echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc`, `echo 'export EDITOR=${editor}' >> ~/.bashrc`, `source ~/.bashrc; cd ~/notes; ${tool}`],
        tips: ['echo $PATH', 'export NAME=value', 'which COMMAND', 'source ~/.bashrc'],
      }),
      hints: ['PATH is a list of directories searched in order; putting ~/bin first lets your tools win.', 'Variables are only passed to programs you start if they are exported.'],
      initialState: dev({ me, org: o, files: repo(me.sam, `${home}/notes`, [C('Start notes', me, o, { 'notes.md': '# Notes\n' })], {}, { checkout: 'main' }) }),
      checks: [
        file('The tool is executable', `${home}/bin/${tool}`, { mode: '755' }),
        out('The tool prints the branch', `cd ${home}/notes && ${home}/bin/${tool}`, { equals: 'branch: main' }),
        file('~/.bashrc puts ~/bin first on PATH', `${home}/.bashrc`, { pattern: 'export PATH="?(\\$HOME|~|/home/\\w+)/bin:\\$PATH"?' }),
        file('~/.bashrc exports EDITOR', `${home}/.bashrc`, { pattern: `export EDITOR=${editor}` }),
      ],
      solution: ['mkdir -p ~/bin', `printf '#!/bin/bash\\necho "branch: $(git rev-parse --abbrev-ref HEAD)"\\n' > ~/bin/${tool}`, `chmod 755 ~/bin/${tool}`, `echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc`, `echo 'export EDITOR=${editor}' >> ~/.bashrc`, `source ~/.bashrc && cd ~/notes && ${tool}`],
      realityNote: 'Git reads EDITOR (and GIT_EDITOR) to choose the editor for commit messages, and finds git-<name> programs on PATH as extra subcommands.',
    };
  }),
  tmpl(1, 4, 'advanced', 'history-report', 'Count commits per day and author with a pipeline', 'E4', 25, 'Turn git log output into a CSV report with sort, uniq and awk.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const team = v.people(3);
    const home = `/home/${me.sam}`;
    const proj = o.project;
    const plan: Array<[number, number]> = [];
    for (let d = 0; d < 4; d++) for (let k = 0; k < v.int(1, 3); k++) plan.push([d, v.int(0, 2)]);
    const commits = plan.map(([d, who], i) => C(`Change ${i + 1}`, team[who], o, { 'log.txt': `change ${i + 1}\n` }, d, 9 + i));
    const counts = new Map<string, number>();
    for (const [d, who] of plan) {
      const k = `2026-10-${String(10 + d).padStart(2, '0')},${team[who].name}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const expected = ['date,author,commits', ...[...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k},${n}`)];
    return {
      instructions: lab({
        situation: `Your manager wants to see activity on **~/${proj}**. Write **~/activity.csv** with a header line \`date,author,commits\` and then one line per **day and author** with the number of commits, sorted by date then author, for example:\n\n\`\`\`\ndate,author,commits\n2026-10-10,${team[0].name},2\n\`\`\`\n\nBuild it from \`git log\` with a pipeline; dates are the author dates (YYYY-MM-DD).`,
        steps: ['git log --date=short --format="%ad,%an"', '... | sort | uniq -c (counts identical lines)', "awk to move the count to the end: awk '{c=$1; $1=\"\"; sub(/^ /,\"\"); print $0\",\"c}'", 'Add the header with echo, then append.'],
        tips: ['git log --date=short --format="%ad,%an"', 'sort | uniq -c', "awk '{print ...}'"],
      }),
      hints: ['uniq -c needs sorted input: equal lines must be next to each other.', 'Names contain spaces: count first, then rebuild the line.'],
      initialState: dev({ me, org: o, files: repo(me.sam, `${home}/${proj}`, commits) }),
      checks: [file('The activity report', `${home}/activity.csv`, { equals: expected.join('\n') })],
      solution: [`cd ~/${proj}`, 'echo "date,author,commits" > ~/activity.csv', `git log --date=short --format="%ad,%an" | sort | uniq -c | awk '{c=$1; $1=""; sub(/^ /,""); print $0","c}' >> ~/activity.csv`, 'cat ~/activity.csv'],
      realityNote: 'Engineering dashboards compute the same counts (and DORA metrics) from git log; knowing the pipeline lets you check what a dashboard claims.',
    };
  }),
];

void gitconfig;
