/** Unit 3: files, directories and the shell. */

import type { TaskTemplate } from '../types';
import { DEPTS, file, lab, linux, out, ran, re, tmpl } from './kit';

const FHS: Array<[string, string, string]> = [
  ['logs', 'Where do system log files live?', '/var/log'],
  ['config', 'Where do system-wide configuration files live?', '/etc'],
  ['homes', 'Where are ordinary users\' home directories?', '/home'],
  ['temp', 'Which directory is for temporary files that anyone may create?', '/tmp'],
  ['local', 'Where should software you compile yourself be installed?', '/usr/local'],
  ['services', 'Which directory holds data served by this system, such as websites (FHS)?', '/srv'],
  ['optional', 'Where do self-contained third-party application packages go?', '/opt'],
  ['rootHome', 'What is root\'s home directory?', '/root'],
];

export const U3: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 3.1 FHS, paths, hidden files, links */
  tmpl(3, 1, 'beginner', 'where-things-live', 'Know where things live in the file system', 'E4', 10, 'Answer questions about the Filesystem Hierarchy Standard and check them on the machine.', (v) => {
    const net = v.net();
    const qs = v.some(FHS, 4);
    return {
      instructions: lab({
        situation: `A new technician keeps asking where things are. Answer these in **/root/fhs.txt**, one line each in the form \`key=/path\`:\n\n${qs.map(([k, q]) => `- \`${k}\`: ${q}`).join('\n')}`,
        steps: ['Look around with ls / and ls -la in the likely places.', 'Write the four lines.'],
        tips: ['ls /', 'ls -la /var', "echo 'logs=/var/log' >> /root/fhs.txt"],
      }),
      hints: ['The Filesystem Hierarchy Standard (FHS) defines these locations for every distribution.'],
      initialState: linux(net),
      checks: qs.map(([k, , a]) => file(`${k} is right`, '/root/fhs.txt', { pattern: `^${k}=${re(a)}/?$` })),
      solution: ['ls /', `printf '${qs.map(([k, , a]) => `${k}=${a}`).join('\\n')}\\n' > /root/fhs.txt`],
      realityNote: 'Because every distribution follows the FHS, the same paths work on openSUSE, Ubuntu and Rocky Linux.',
    };
  }),
  tmpl(3, 1, 'intermediate', 'release-links', 'Switch a release with a symbolic link', 'E4', 15, 'Point a "current" symlink at a new release and make a hard link, then prove which is which.', (v) => {
    const net = v.net();
    const app = v.pick(['portal', 'library', 'timetable', 'results']);
    const [oldV, newV] = v.pick([['1.4', '1.5'], ['2.0', '2.1'], ['3.2', '3.3']]);
    return {
      instructions: lab({
        situation: `The ${app} web app is deployed as releases in **/srv/${app}/releases/<version>**, and the web server serves **/srv/${app}/current**, a symbolic link. Version **${newV}** has been unpacked. Switch **current** to it (atomically, with one ln command), and keep a **hard link** of the new release's config file at **/srv/${app}/config-${newV}.ini** for the auditors.`,
        steps: ['Look at the link with ls -l and readlink.', 'Replace it with ln -sfn.', 'Make the hard link with ln (no -s).', 'Compare inode numbers with ls -li or stat.'],
        tips: [`readlink /srv/${app}/current`, `ln -sfn /srv/${app}/releases/${newV} /srv/${app}/current`, `ln /srv/${app}/releases/${newV}/config.ini /srv/${app}/config-${newV}.ini`],
      }),
      hints: ['A symbolic link stores a path; a hard link is another name for the same inode.', '-n stops ln following an existing link to a directory.'],
      initialState: linux(net, { files: { [`/srv/${app}/releases/${oldV}/index.html`]: `${app} ${oldV}\n`, [`/srv/${app}/releases/${oldV}/config.ini`]: `version=${oldV}\n`, [`/srv/${app}/releases/${newV}/index.html`]: `${app} ${newV}\n`, [`/srv/${app}/releases/${newV}/config.ini`]: `version=${newV}\n`, [`/srv/${app}/current`]: { link: `/srv/${app}/releases/${oldV}` } } }),
      checks: [out('current points at the new release', `readlink /srv/${app}/current`, { equals: `/srv/${app}/releases/${newV}` }), out('The site now serves the new version', `cat /srv/${app}/current/index.html`, { contains: newV }), file('The hard link exists and is a regular file', `/srv/${app}/config-${newV}.ini`, { kind: 'file', contains: `version=${newV}` }), out('No release directory was nested inside the old one', `ls /srv/${app}/releases/${oldV}`, { notContains: newV })],
      solution: [`ls -l /srv/${app}`, `ln -sfn /srv/${app}/releases/${newV} /srv/${app}/current`, `ln /srv/${app}/releases/${newV}/config.ini /srv/${app}/config-${newV}.ini`, `ls -li /srv/${app}`],
      realityNote: 'Atomic symlink switches are how tools like Capistrano and many CI pipelines release web apps with instant rollback.',
    };
  }),
  tmpl(3, 1, 'advanced', 'broken-links', 'Find and repair broken symbolic links after a move', 'E4', 20, 'Locate dangling symlinks, repoint the ones that matter and remove the obsolete one.', (v) => {
    const net = v.net();
    const app = v.pick(['moodle-tools', 'sis-client', 'labkit']);
    const [oldV, newV] = v.pick([['2.0', '2.1'], ['4.1', '4.2']]);
    const bins = v.some(['run', 'backup', 'report', 'sync', 'admin'], 3);
    const obsolete = v.pick(['legacy-import', 'old-export']);
    return {
      instructions: lab({
        situation: `/opt/${app}-${oldV} was replaced by **/opt/${app}-${newV}** and the old directory deleted. The commands in **/usr/local/bin** that pointed into it are now broken. Repoint every broken link to the same program in the new version. **${obsolete}** no longer exists in ${newV}: delete that link instead. Do not touch links that still work.`,
        steps: ['List the links: find /usr/local/bin -type l, then readlink each.', 'Test which are broken (test -e follows the link).', 'Fix with ln -sf; remove the obsolete one.'],
        tips: ['find /usr/local/bin -type l', 'for l in /usr/local/bin/*; do [ -L "$l" ] && [ ! -e "$l" ] && echo "broken: $l"; done', `ln -sf /opt/${app}-${newV}/bin/run /usr/local/bin/run`],
      }),
      hints: ['[ -L x ] is true for any link; [ -e x ] is false when its target is missing.'],
      initialState: linux(net, { files: { ...Object.fromEntries(bins.map((b) => [`/opt/${app}-${newV}/bin/${b}`, { content: `#!/bin/bash\necho ${b} ${newV}\n`, mode: '755' }])), ...Object.fromEntries(bins.map((b) => [`/usr/local/bin/${b}`, { link: `/opt/${app}-${oldV}/bin/${b}` }])), [`/usr/local/bin/${obsolete}`]: { link: `/opt/${app}-${oldV}/bin/${obsolete}` }, '/usr/local/bin/backup-db': { link: '/usr/local/sbin/backup-db.sh' }, '/usr/local/sbin/backup-db.sh': { content: '#!/bin/bash\necho db\n', mode: '755' } } }),
      checks: [...bins.map((b) => out(`${b} works again`, `readlink /usr/local/bin/${b}`, { equals: `/opt/${app}-${newV}/bin/${b}` })), file(`${obsolete} is removed`, `/usr/local/bin/${obsolete}`, { exists: false }), out('The working backup-db link is untouched', 'readlink /usr/local/bin/backup-db', { equals: '/usr/local/sbin/backup-db.sh' })],
      solution: ['find /usr/local/bin -type l', 'for l in /usr/local/bin/*; do [ -L "$l" ] && [ ! -e "$l" ] && echo "broken: $l"; done', ...bins.map((b) => `ln -sf /opt/${app}-${newV}/bin/${b} /usr/local/bin/${b}`), `rm /usr/local/bin/${obsolete}`],
      realityNote: 'Dangling symlinks after upgrades are common; find -xtype l (GNU find) lists them directly on real systems.',
    };
  }),

  /* ---------------------------------------------------------------- 3.2 core commands */
  tmpl(3, 2, 'beginner', 'organise-files', 'Organise a messy directory', 'E4', 15, 'Create folders and move files into them by type with globs.', (v) => {
    const net = v.net();
    const p = v.person();
    const pdfs = v.some(['timetable', 'handbook', 'minutes', 'policy', 'invoice'], 3).map((x) => `${x}.pdf`);
    const imgs = v.some(['campus', 'graduation', 'lab', 'team'], 2).map((x) => `${x}.jpg`);
    const csvs = v.some(['marks', 'attendance', 'stock'], 2).map((x) => `${x}.csv`);
    const home = `/home/${p.sam}`;
    return {
      instructions: lab({ situation: `${p.given}'s home directory **${home}/Downloads** is a mess. Create **${home}/Documents**, **${home}/Pictures** and **${home}/Data** and move every .pdf, .jpg and .csv file from Downloads into the right one. Leave anything else where it is.`, steps: ['List what is there.', 'Make the three directories in one mkdir.', 'Move by pattern with mv and globs.'], tips: [`mkdir -p ${home}/{Documents,Pictures,Data}`, `mv ${home}/Downloads/*.pdf ${home}/Documents/`] }),
      hints: ['A glob like *.pdf matches every name ending in .pdf.'],
      initialState: linux(net, { users: { [p.sam]: {} }, files: { ...Object.fromEntries([...pdfs, ...imgs, ...csvs].map((f) => [`${home}/Downloads/${f}`, `${f}\n`])), [`${home}/Downloads/setup-notes.txt`]: 'keep\n' } }),
      checks: [...pdfs.map((f) => file(`${f} is in Documents`, `${home}/Documents/${f}`)), ...imgs.map((f) => file(`${f} is in Pictures`, `${home}/Pictures/${f}`)), ...csvs.map((f) => file(`${f} is in Data`, `${home}/Data/${f}`)), out('Downloads keeps only the other file', `ls ${home}/Downloads`, { equals: 'setup-notes.txt' })],
      solution: [`mkdir -p ${home}/Documents ${home}/Pictures ${home}/Data`, `mv ${home}/Downloads/*.pdf ${home}/Documents/`, `mv ${home}/Downloads/*.jpg ${home}/Pictures/`, `mv ${home}/Downloads/*.csv ${home}/Data/`],
      realityNote: 'Globs are expanded by the shell before mv even runs, which is why one command can move hundreds of files.',
    };
  }),
  tmpl(3, 2, 'intermediate', 'archive-and-clean', 'Archive old project files and clean up temporary ones', 'E4', 20, 'Use find, tar and rm to archive a finished project and delete temporary files.', (v) => {
    const net = v.net();
    const proj = v.pick(['ict-audit-2025', 'campus-wifi', 'library-migration', 'exam-portal']);
    const tmps = v.int(3, 6);
    return {
      instructions: lab({
        situation: `The **${proj}** project in /srv/projects is finished. Archive the whole project directory as **/srv/archive/${proj}.tar.gz**, check the archive lists its files, then delete the project directory. Separately, every **\\*.tmp** file anywhere under /srv/projects must be deleted (there are some in other projects too).`,
        steps: ['Create the archive with tar czf (use -C /srv/projects so paths start at the project name).', 'List it with tar tzf.', 'Remove the project directory.', 'Find and delete *.tmp files under /srv/projects.'],
        tips: [`tar czf /srv/archive/${proj}.tar.gz -C /srv/projects ${proj}`, `tar tzf /srv/archive/${proj}.tar.gz`, "find /srv/projects -name '*.tmp'", "find /srv/projects -name '*.tmp' -delete"],
      }),
      hints: ['Check the archive before deleting the original.', 'Quote the pattern so the shell does not expand it.'],
      initialState: linux(net, { files: { [`/srv/projects/${proj}/report.docx`]: 'report\n', [`/srv/projects/${proj}/data/results.csv`]: 'a,b\n', [`/srv/projects/${proj}/scratch.tmp`]: 'x\n', '/srv/archive/': null, ...Object.fromEntries(Array.from({ length: tmps }, (_, i) => [`/srv/projects/other-${i}/cache-${i}.tmp`, 'tmp\n'])), '/srv/projects/other-0/keep.txt': 'keep\n' } }),
      checks: [out('The archive holds the project', `tar tzf /srv/archive/${proj}.tar.gz`, { contains: [`${proj}/report.docx`, `${proj}/data/results.csv`] }), file('The project directory is gone', `/srv/projects/${proj}`, { exists: false }), out('No .tmp files remain', "find /srv/projects -name '*.tmp'", { equals: '' }), file('Other files are kept', '/srv/projects/other-0/keep.txt')],
      solution: [`tar czf /srv/archive/${proj}.tar.gz -C /srv/projects ${proj}`, `tar tzf /srv/archive/${proj}.tar.gz`, `rm -r /srv/projects/${proj}`, "find /srv/projects -name '*.tmp' -delete"],
      realityNote: 'tar with -C and a relative path makes archives that restore cleanly anywhere; always list before you delete.',
    };
  }),
  tmpl(3, 2, 'advanced', 'disk-full', 'Free space on a full /var safely', 'E4', 25, 'Find what fills /var/log, compress rotated logs and remove crash dumps without touching live logs.', (v) => {
    const net = v.net();
    const svc = v.pick(['apache2', 'mariadb', 'app']);
    const n = v.int(3, 5);
    const big = 'x'.repeat(6000);
    return {
      instructions: lab({
        situation: `/var is nearly full. Rules: **live** log files (ending in .log or with no number) stay as they are; **rotated** logs (\`*.log.1\`, \`*.log.2\` ...) must be **compressed** with gzip, not deleted; **core dumps** in /var/crash may be deleted. Find where the space goes first, then apply the rules under **/var/log/${svc}** and **/var/crash**.`,
        steps: ['du -sb /var/log/* /var/crash | sort -n to see the biggest.', 'gzip the rotated logs.', 'Delete the core files.', 'Check with ls and du.'],
        tips: ['du -sb /var/log/* /var/crash | sort -n', `gzip /var/log/${svc}/*.log.[0-9]*`, 'rm /var/crash/core.*'],
      }),
      hints: ['A glob such as *.log.[0-9]* matches rotated files only.', 'Compressed logs can still be read with zcat.'],
      initialState: linux(net, { files: { [`/var/log/${svc}/${svc}.log`]: 'live\n', ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`/var/log/${svc}/${svc}.log.${i + 1}`, big + i])), '/var/crash/core.1201': big, '/var/crash/core.3388': big, '/var/log/messages': 'system\n' } }),
      checks: [file('The live log is untouched', `/var/log/${svc}/${svc}.log`, { equals: 'live' }), ...Array.from({ length: n }, (_, i) => file(`${svc}.log.${i + 1} is compressed`, `/var/log/${svc}/${svc}.log.${i + 1}.gz`)), out('No uncompressed rotated logs remain', `ls /var/log/${svc}`, { notContains: [`${svc}.log.1 `, `${svc}.log.1\n`], pattern: `^(?![\\s\\S]*\\.log\\.\\d+(\\s|$))` }), out('The core dumps are gone', 'ls /var/crash', { equals: '' })],
      solution: ['du -sb /var/log/* /var/crash | sort -n', `gzip /var/log/${svc}/*.log.[0-9]*`, 'rm /var/crash/core.*', `ls /var/log/${svc}`],
      realityNote: 'logrotate does this automatically with compress and rotate N; by hand, the rule is the same: never delete a log a process still writes to.',
    };
  }),

  /* ---------------------------------------------------------------- 3.3 the shell */
  tmpl(3, 3, 'beginner', 'redirect-and-pipe', 'Save command results with redirection and pipes', 'E4', 15, 'Build pipelines that write results, counts and errors to separate files.', (v) => {
    const net = v.net();
    const people = v.people(v.int(3, 5));
    const nolog = v.people(2);
    return {
      instructions: lab({ situation: 'An auditor wants three files in /root/audit:\n\n1. **bash-users.txt**: the names of all accounts whose login shell is /bin/bash, one per line, sorted.\n2. **bash-count.txt**: how many there are (just the number).\n3. **errors.txt**: the error message from listing **/srv/missing** (which does not exist), so they can see it fails.', steps: ['Create /root/audit.', 'grep /bin/bash /etc/passwd | cut -d: -f1 | sort > ...', 'Count with wc -l.', 'Redirect standard error with 2>.'], tips: ["grep ':/bin/bash$' /etc/passwd | cut -d: -f1 | sort", 'wc -l < file', 'ls /srv/missing 2> /root/audit/errors.txt'] }),
      hints: ['> sends standard output; 2> sends standard error.', 'wc -l < file prints only the number.'],
      initialState: linux(net, { users: { ...Object.fromEntries(people.map((p) => [p.sam, {}])), ...Object.fromEntries(nolog.map((p) => [p.sam, { shell: '/sbin/nologin' }])) } }),
      checks: [file('bash-users.txt lists the bash accounts, sorted', '/root/audit/bash-users.txt', { equals: ['root', ...people.map((p) => p.sam)].sort().join('\n') }), file('bash-count.txt has the count', '/root/audit/bash-count.txt', { equals: String(people.length + 1) }), file('errors.txt holds the error', '/root/audit/errors.txt', { contains: 'No such file or directory' })],
      solution: ['mkdir /root/audit', "grep ':/bin/bash$' /etc/passwd | cut -d: -f1 | sort > /root/audit/bash-users.txt", 'wc -l < /root/audit/bash-users.txt > /root/audit/bash-count.txt', 'ls /srv/missing 2> /root/audit/errors.txt'],
      realityNote: 'Separating output from errors is what lets scripts and cron jobs log failures without mixing them into results.',
    };
  }),
  tmpl(3, 3, 'intermediate', 'shell-environment', 'Set up a shell environment that persists', 'E4', 15, 'Add aliases, variables and a PATH entry to .bashrc and load them.', (v) => {
    const net = v.net();
    const p = v.person();
    const bdir = v.pick(['/srv/backup', '/var/backups/daily', '/data/backup']);
    return {
      instructions: lab({ situation: `${p.given} (account **${p.sam}**) wants their shell set up permanently in **~/.bashrc**: an alias **ll** for \`ls -alF\`, an alias **ports** for \`ss -tulpn\`, a variable **BACKUP_DIR=${bdir}** exported to programs, and **~/bin** added to the end of PATH so their own scripts run by name. A script **~/bin/hello** is already there.`, steps: [`Switch to the user (su - ${p.sam}) or edit /home/${p.sam}/.bashrc as root.`, 'Append the four lines.', 'Load them with source ~/.bashrc and test.'], tips: ["echo \"alias ll='ls -alF'\" >> ~/.bashrc", `echo 'export BACKUP_DIR=${bdir}' >> ~/.bashrc`, 'echo \'export PATH="$PATH:$HOME/bin"\' >> ~/.bashrc', 'source ~/.bashrc'] }),
      hints: ['Single quotes keep $PATH and $HOME from being expanded when you write the line.', 'export makes a variable visible to programs you start.'],
      initialState: linux(net, { users: { [p.sam]: {} }, files: { [`/home/${p.sam}/.bashrc`]: '# .bashrc\n', [`/home/${p.sam}/bin/hello`]: { content: '#!/bin/bash\necho "hello from bin"\n', mode: '755', owner: p.sam } } }),
      checks: [out('ll is an alias', `bash -c 'source /home/${p.sam}/.bashrc; alias ll'`, { contains: 'ls -alF' }), out('ports is an alias', `bash -c 'source /home/${p.sam}/.bashrc; alias ports'`, { contains: 'ss -tulpn' }), out('BACKUP_DIR is exported', `bash -c 'source /home/${p.sam}/.bashrc; printenv BACKUP_DIR'`, { equals: bdir }), out('~/bin is on the PATH', `su - ${p.sam} -c 'source ~/.bashrc; hello'`, { contains: 'hello from bin' })],
      solution: [`echo "alias ll='ls -alF'" >> /home/${p.sam}/.bashrc`, `echo "alias ports='ss -tulpn'" >> /home/${p.sam}/.bashrc`, `echo 'export BACKUP_DIR=${bdir}' >> /home/${p.sam}/.bashrc`, `echo 'export PATH="$PATH:$HOME/bin"' >> /home/${p.sam}/.bashrc`, `su - ${p.sam} -c 'source ~/.bashrc; hello'`],
      realityNote: 'Everything in .bashrc runs for every interactive shell; keeping it small and readable avoids slow, surprising logins.',
    };
  }),
  tmpl(3, 3, 'advanced', 'quoting-and-loops', 'Rename files with spaces safely in a loop', 'E4', 20, 'Use a for loop, quoting and parameter expansion to rename files whose names contain spaces.', (v) => {
    const net = v.net();
    const names = v.some(['Graduation Day', 'Lab Session 3', 'Open Day Stand', 'Sports Fest', 'Prize Giving', 'New Library'], 4);
    const ext = v.pick(['JPG', 'JPEG']);
    return {
      instructions: lab({ situation: `The photos in **/srv/media/photos** have upper-case extensions (\`.${ext}\`) and spaces in their names, which breaks the website. Rename every \`*.${ext}\` file so the extension becomes lower-case \`.jpg\`, **keeping the rest of the name exactly as it is**, spaces included. A naive \`for f in $(ls)\` splits on spaces: use a glob and quotes.`, steps: ['Look at the names with ls -1.', `for f in *.${ext}; do mv -- "$f" "\${f%.${ext}}.jpg"; done`, 'Check that nothing was lost.'], tips: ['cd /srv/media/photos', `for f in *.${ext}; do echo "$f"; done`, '${f%.EXT} removes the suffix from $f'] }),
      hints: ['Without quotes, "Lab Session 3.JPG" becomes three separate words.', '-- tells mv that the next arguments are names, even if they start with -.'],
      initialState: linux(net, { files: Object.fromEntries(names.map((n) => [`/srv/media/photos/${n}.${ext}`, `${n}\n`])) }),
      checks: [...names.map((n) => file(`"${n}.jpg" exists with its content`, `/srv/media/photos/${n}.jpg`, { equals: n })), out(`No .${ext} files remain`, 'ls /srv/media/photos', { notContains: `.${ext}` }), ran('You used a loop', '\\bfor\\b')],
      solution: [`cd /srv/media/photos && for f in *.${ext}; do mv -- "$f" "\${f%.${ext}}.jpg"; done`, 'ls -1 /srv/media/photos'],
      realityNote: 'Unquoted variables and parsing ls output are the two most common shell bugs; ShellCheck flags both.',
    };
  }),

  /* ---------------------------------------------------------------- 3.4 text processing */
  tmpl(3, 4, 'beginner', 'failed-logins', 'Count failed SSH logins by address', 'E4', 15, 'Use grep, awk, sort and uniq to find which address fails to log in most.', (v) => {
    const net = v.net();
    const ips = Array.from({ length: 4 }, () => `${v.pick(['41.66', '154.160', '102.176', '197.255'])}.${v.int(1, 254)}.${v.int(1, 254)}`);
    const counts = [v.int(12, 20), v.int(4, 8), v.int(2, 3), 1];
    const lines = ips.flatMap((ip, i) => Array.from({ length: counts[i] }, (_, k) => `Oct 22 0${k % 9}:1${k % 6}:0${i} srv1 sshd[${2000 + k}]: Failed password for ${v.pick(['root', 'admin', 'test', 'oracle'])} from ${ip} port ${40000 + k} ssh2`));
    const ok = `Oct 22 07:00:00 srv1 sshd[1999]: Accepted publickey for admin from ${net}.20 port 51000 ssh2`;
    return {
      instructions: lab({ situation: 'The SSH log **/var/log/secure** shows many failed logins. Find the address with the most "Failed password" lines and how many it has, and write **/root/top-attacker.txt** as `<count> <address>` (for example `14 41.66.10.20`).', steps: ['grep "Failed password" /var/log/secure.', 'Extract the address field with awk.', 'Count with sort | uniq -c | sort -rn and take the top line.'], tips: ["grep 'Failed password' /var/log/secure | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn | head -1"] }),
      hints: ['$(NF-3) is the fourth field from the end of the line.', 'uniq -c only counts adjacent lines, so sort first.'],
      initialState: linux(net, { files: { '/var/log/secure': v.some([...lines, ok], lines.length + 1).join('\n') + '\n' } }),
      checks: [file('The top address and count are recorded', '/root/top-attacker.txt', { pattern: `^\\s*${counts[0]}\\s+${re(ips[0])}\\s*$` })],
      solution: [`grep 'Failed password' /var/log/secure | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn | head -1 | awk '{print $1, $2}' > /root/top-attacker.txt`],
      realityNote: 'This one-liner is the manual version of what fail2ban automates: count failures per address and act on the worst offenders.',
    };
  }),
  tmpl(3, 4, 'intermediate', 'csv-report', 'Summarise a CSV file with awk', 'E4', 20, 'Use awk with an associative array to count and average per group.', (v) => {
    const net = v.net();
    const progs = v.some(['BSc-CS', 'BTech-IT', 'HND-CS', 'BSc-IS', 'BSc-Maths'], 3);
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: 1000 + i, prog: progs[i % 3], score: v.int(30, 95) }));
    const stats = progs.map((p) => {
      const rs = rows.filter((r) => r.prog === p);
      return { p, n: rs.length, pass: rs.filter((r) => r.score >= 50).length };
    }).sort((a, b) => a.p.localeCompare(b.p));
    return {
      instructions: lab({ situation: '**/srv/data/results.csv** has columns `id,name,programme,score` with a header line. Registry wants **/root/pass-report.txt** with one line per programme, sorted by programme name: `<programme> <students> <passed>`, where passed means score of 50 or more.', steps: ['Look at the file with head.', "awk -F, 'NR>1 {...}' to count per programme in arrays.", 'Sort the output and save it.'], tips: ["awk -F, 'NR>1 {n[$3]++; if ($4 >= 50) p[$3]++} END {for (k in n) print k, n[k], p[k]+0}' FILE | sort"] }),
      hints: ['NR>1 skips the header.', 'p[k]+0 prints 0 for a programme where nobody passed.'],
      initialState: linux(net, { files: { '/srv/data/results.csv': ['id,name,programme,score', ...rows.map((r) => `${r.id},${v.person().name},${r.prog},${r.score}`)].join('\n') + '\n' } }),
      checks: [file('The report is right', '/root/pass-report.txt', { equals: stats.map((s) => `${s.p} ${s.n} ${s.pass}`).join('\n') })],
      solution: ["awk -F, 'NR>1 {n[$3]++; if ($4 >= 50) p[$3]++} END {for (k in n) print k, n[k], p[k]+0}' /srv/data/results.csv | sort > /root/pass-report.txt"],
      realityNote: 'awk is still the fastest way to answer a question about a CSV on a server where no spreadsheet or Python is available.',
    };
  }),
  tmpl(3, 4, 'advanced', 'anonymise-logs', 'Anonymise a log with sed regular expressions', 'E4', 25, 'Replace email addresses and phone numbers with placeholders before sharing a log.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const phones = people.map(() => `0${v.pick(['24', '20', '55', '27', '50'])}${v.int(1000000, 9999999)}`);
    const lines = people.map((p, i) => `2026-10-22 0${i}:1${i}:00 portal: password reset requested by ${p.sam}@campus.edu.gh, SMS sent to ${phones[i]} (ref ${7000 + i})`);
    return {
      instructions: lab({ situation: 'A vendor needs **/var/log/portal/reset.log** to debug a problem, but it contains personal data. Make **/root/reset-anon.log** where every email address is replaced by `<email>` and every Ghanaian mobile number (10 digits starting with 0) by `<phone>`. Everything else, including the reference numbers, must stay the same. Do not change the original.', steps: ['Look at the log.', 'Write a sed -E command with two s///g expressions.', 'Check the result with grep: no @ and no 0XXXXXXXXX left.'], tips: ["sed -E 's/[[:alnum:]._-]+@[[:alnum:].-]+/<email>/g; s/\\b0[0-9]{9}\\b/<phone>/g' IN > OUT", "grep -E '@|\\b0[0-9]{9}\\b' /root/reset-anon.log"] }),
      hints: ['\\b marks a word boundary so the 4-digit reference numbers are not touched.', '-E enables extended regular expressions, so + and {9} work without backslashes.'],
      initialState: linux(net, { files: { '/var/log/portal/reset.log': lines.join('\n') + '\n' } }),
      checks: [file('No email addresses remain', '/root/reset-anon.log', { notContains: '@' }), file('No phone numbers remain', '/root/reset-anon.log', { notContains: phones }), file('Placeholders are in place', '/root/reset-anon.log', { contains: ['<email>', '<phone>'] }), file('Reference numbers are kept', '/root/reset-anon.log', { contains: ['(ref 7000)', '(ref 7003)'] }), file('The original log is unchanged', '/var/log/portal/reset.log', { contains: people[0].sam + '@' })],
      solution: ["sed -E 's/[[:alnum:]._-]+@[[:alnum:].-]+/<email>/g; s/\\b0[0-9]{9}\\b/<phone>/g' /var/log/portal/reset.log > /root/reset-anon.log"],
      realityNote: 'Sharing logs with vendors is a common data leak; the Data Protection Act requires minimising personal data shared with processors.',
    };
  }),

  /* ---------------------------------------------------------------- 3.5 editors */
  tmpl(3, 5, 'beginner', 'edit-a-config', 'Edit a configuration file', 'E4', 10, 'Change settings in a configuration file with an editor or sed and verify the result.', (v) => {
    const net = v.net();
    const port = v.pick([8080, 8443, 9000]);
    const workers = v.int(4, 16);
    return {
      instructions: lab({ situation: `Edit **/etc/campus-app/app.conf** (with nano, vim or sed): set **port** to **${port}**, **workers** to **${workers}**, and turn **debug** off (debug = false). Do not change other lines or leave duplicates.`, steps: ['Open the file and read it.', 'Change the three values.', 'Check the file with cat.'], tips: ['nano /etc/campus-app/app.conf', `sed -i 's/^port = .*/port = ${port}/' /etc/campus-app/app.conf`] }),
      hints: ['In nano, Ctrl+O saves and Ctrl+X exits; in vim, i to insert, Esc then :wq to save and quit.'],
      initialState: linux(net, { files: { '/etc/campus-app/app.conf': '# Campus app\nport = 8000\nworkers = 2\ndebug = true\nlog_dir = /var/log/campus-app\n' } }),
      checks: [file('The new values are set', '/etc/campus-app/app.conf', { contains: [`port = ${port}`, `workers = ${workers}`, 'debug = false', 'log_dir = /var/log/campus-app'] }), file('The old values are gone', '/etc/campus-app/app.conf', { notContains: ['port = 8000', 'workers = 2\n', 'debug = true'] })],
      solution: [`sed -i 's/^port = .*/port = ${port}/' /etc/campus-app/app.conf`, `sed -i 's/^workers = .*/workers = ${workers}/' /etc/campus-app/app.conf`, "sed -i 's/^debug = .*/debug = false/' /etc/campus-app/app.conf", 'cat /etc/campus-app/app.conf'],
      realityNote: 'Every Linux administrator needs one terminal editor; vi is installed everywhere, even on minimal rescue systems.',
    };
  }),
  tmpl(3, 5, 'intermediate', 'configure-the-editor', 'Configure vim and the default editor', 'E4', 15, 'Write a .vimrc and make vim the editor that crontab, visudo and git use.', (v) => {
    const net = v.net();
    const p = v.person();
    const ts = v.pick([2, 4]);
    return {
      instructions: lab({ situation: `${p.given} (**${p.sam}**) edits YAML and shell scripts all day. Create **/home/${p.sam}/.vimrc** with: line numbers, syntax highlighting, tabs of **${ts}** spaces that are inserted as spaces, and auto-indent. Then make vim their default editor for tools like crontab -e and visudo by exporting **EDITOR** and **VISUAL** in ~/.bashrc.`, steps: ['Write the vimrc lines.', 'Add the two exports to .bashrc.', 'Make sure the files belong to the user.'], tips: [`printf 'set number\\nsyntax on\\nset tabstop=${ts}\\nset shiftwidth=${ts}\\nset expandtab\\nset autoindent\\n' > /home/${p.sam}/.vimrc`, `echo 'export EDITOR=vim VISUAL=vim' >> /home/${p.sam}/.bashrc`, `chown ${p.sam}: /home/${p.sam}/.vimrc`] }),
      hints: ['expandtab turns Tab presses into spaces; YAML forbids tab indentation.'],
      initialState: linux(net, { users: { [p.sam]: {} }, files: { [`/home/${p.sam}/.bashrc`]: '# .bashrc\n' } }),
      checks: [file('.vimrc has the settings', `/home/${p.sam}/.vimrc`, { contains: ['set number', 'syntax on', `tabstop=${ts}`, 'expandtab', 'autoindent'], owner: p.sam }), out('EDITOR is vim', `bash -c 'source /home/${p.sam}/.bashrc; printenv EDITOR'`, { equals: 'vim' }), out('VISUAL is vim', `bash -c 'source /home/${p.sam}/.bashrc; printenv VISUAL'`, { equals: 'vim' })],
      solution: [`printf 'set number\\nsyntax on\\nset tabstop=${ts}\\nset shiftwidth=${ts}\\nset expandtab\\nset autoindent\\n' > /home/${p.sam}/.vimrc`, `chown ${p.sam}:${p.sam} /home/${p.sam}/.vimrc`, `echo 'export EDITOR=vim VISUAL=vim' >> /home/${p.sam}/.bashrc`],
      realityNote: 'EDITOR and VISUAL are read by crontab, visudo, git, less and many more, so one setting gives a consistent editor everywhere.',
    };
  }),
  tmpl(3, 5, 'advanced', 'bulk-edit', 'Change a setting across many config files safely', 'E4', 20, 'Use sed -i with backups and a regex to change one setting in many files, then verify.', (v) => {
    const net = v.net();
    const sites = v.some(DEPTS, 5);
    const oldHost = v.pick(['db-old.campus.lan', 'mysql01.campus.lan']);
    const newHost = v.pick(['db01.campus.lan', 'mariadb.campus.lan']);
    const skip = sites[4];
    return {
      instructions: lab({ situation: `The database server moved from **${oldHost}** to **${newHost}**. Every site config in **/etc/campus-sites/*.conf** has a \`db_host = ...\` line to update, **except ${skip}.conf**, which deliberately still uses the old server until next week. Keep a **.bak** copy of each file you change, and change nothing but the db_host line.`, steps: ['grep db_host /etc/campus-sites/*.conf to see the current values.', 'Run sed -i.bak on every file except the excluded one (list them or use a loop with a test).', 'grep again to confirm.'], tips: [`sed -i.bak 's/^db_host = ${oldHost.replace(/\./g, '\\.')}$/db_host = ${newHost}/' FILE...`, `for f in /etc/campus-sites/*.conf; do [ "$f" = /etc/campus-sites/${skip}.conf ] && continue; sed -i.bak ... "$f"; done`] }),
      hints: ['Escape the dots in the old name: in a regex . matches any character.', 'Anchor with ^ and $ so only the exact line changes.'],
      initialState: linux(net, { files: Object.fromEntries(sites.map((s, i) => [`/etc/campus-sites/${s}.conf`, `site = ${s}\ndb_host = ${oldHost}\ndb_name = ${s}_db\ncache_host = ${i % 2 ? oldHost : 'cache01.campus.lan'}\n`])) }),
      checks: [...sites.slice(0, 4).map((s) => file(`${s}.conf points at ${newHost}`, `/etc/campus-sites/${s}.conf`, { contains: `db_host = ${newHost}`, notContains: `db_host = ${oldHost}` })), ...sites.slice(0, 4).map((s) => file(`${s}.conf.bak keeps the original`, `/etc/campus-sites/${s}.conf.bak`, { contains: `db_host = ${oldHost}` })), file(`${skip}.conf still uses the old server`, `/etc/campus-sites/${skip}.conf`, { contains: `db_host = ${oldHost}` }), file('Other lines mentioning the old server are untouched', `/etc/campus-sites/${sites[1]}.conf`, { contains: `cache_host = ${oldHost}` })],
      solution: [`grep db_host /etc/campus-sites/*.conf`, `for f in /etc/campus-sites/*.conf; do [ "$f" = /etc/campus-sites/${skip}.conf ] && continue; sed -i.bak 's/^db_host = ${oldHost.replace(/\./g, '\\.')}$/db_host = ${newHost}/' "$f"; done`, 'grep db_host /etc/campus-sites/*.conf'],
      realityNote: 'Bulk edits with sed -i are powerful and dangerous; backups, anchors and a grep before and after make them safe. Configuration management makes them unnecessary.',
    };
  }),
];
