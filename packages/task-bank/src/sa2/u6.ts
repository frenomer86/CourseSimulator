/** Unit 6: backup and recovery. */

import type { TaskTemplate } from '../types';
import { DEPTS, caseStudy, file, lab, linux, out, ran, tmpl, user } from './kit';
import { tarOf } from './u1';

const RSYNC = { rsync: { installed: true } };

export const U6: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 6.1 strategy, 3-2-1, retention, restore tests */
  tmpl(6, 1, 'beginner', 'backup-strategy', 'Choose full, incremental and differential backups', 'E10', 15, 'Compare backup types and apply the 3-2-1 rule to a Linux file server.', (v) => {
    const gb = v.pick([200, 500, 1000]);
    const change = v.pick([2, 5, 10]);
    return caseStudy(v, {
      intro: `## Backing up the faculty file server\n\nThe server holds **${gb} GB**, of which about **${change}%** changes each day. Design the backups.`,
      steps: [
        { title: 'Full every night?', text: `Should you take a full ${gb} GB backup every night?`, choices: [{ text: 'No: a weekly full plus daily incrementals or differentials uses far less time and space', right: true, feedback: `Correct. Daily changes are about ${Math.round((gb * change) / 100)} GB.` }, { text: 'Yes: fulls are always simplest', feedback: 'Simple to restore, but the backup window and storage grow quickly.' }, { text: 'No backups are needed for a RAID array', feedback: 'RAID protects against a disk failure, not deletion, ransomware or fire.' }] },
        { title: 'Incremental or differential', text: 'A file is lost on Friday. The full ran on Sunday. Which restore needs fewer backup sets?', choices: [{ text: 'Differential: Sunday\'s full plus Thursday night\'s differential', right: true, feedback: 'Correct. Incrementals would need the full plus every night since.' }, { text: 'Incremental: only the last one', feedback: 'Each incremental holds only one day\'s changes.' }, { text: 'They are the same', feedback: 'They trade backup size against restore steps.' }] },
        { title: '3-2-1', text: 'Which setup follows the 3-2-1 rule?', choices: [{ text: 'The data plus two backups, on two kinds of media, one of them off-site', right: true, feedback: 'Correct.' }, { text: 'Three backups on a USB disk on top of the server', feedback: 'One theft or fire takes everything.' }, { text: 'One cloud backup', feedback: 'One copy, one failure away from nothing.' }] },
        { title: 'Proof', text: 'How do you know the backups work?', choices: [{ text: 'Restore files to a test location on a schedule and compare them', right: true, feedback: 'Correct. Untested backups are a hope.' }, { text: 'The backup job reports success', feedback: 'Jobs can succeed and still write unusable archives.' }, { text: 'Check the archive file size', feedback: 'Size says nothing about whether you can restore.' }] },
      ],
      ending: { title: 'Strategy agreed', text: 'Weekly fulls with daily differentials or incrementals, 3-2-1 copies and scheduled restore tests.' },
      hints: ['Count the backup sets needed for a Friday restore.'],
      realityNote: 'Tools like restic, borg and Bacula all build on these same ideas: periodic fulls (or forever-incremental with deduplication), retention and verification.',
    });
  }),
  tmpl(6, 1, 'intermediate', 'test-a-restore', 'Take a backup and prove you can restore it', 'E4', 20, 'Make a dated archive, restore it to a staging directory and compare it with the original.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const files = v.some(['budget.ods', 'minutes.odt', 'staff.csv', 'policy.pdf', 'plan.md'], 4);
    return {
      instructions: lab({ situation: `Back up **/srv/${dept}** as **/backup/${dept}-2026-10-22.tar.gz**, then prove the backup works: restore it into **/tmp/restore-test** (never on top of live data) and compare the restored tree with the original using **diff -r**. Write the comparison result to **/root/restore-test.txt**: \`PASS\` if diff found no differences, \`FAIL\` otherwise.`, steps: ['tar czf the directory.', 'mkdir /tmp/restore-test and extract there with -C.', 'diff -r original restored; $? is 0 when identical.', 'Write PASS or FAIL.'], tips: [`tar czf /backup/${dept}-2026-10-22.tar.gz /srv/${dept}`, `tar xzf /backup/${dept}-2026-10-22.tar.gz -C /tmp/restore-test`, `diff -r /srv/${dept} /tmp/restore-test/srv/${dept} && echo PASS > /root/restore-test.txt || echo FAIL > /root/restore-test.txt`] }),
      hints: ['Archives store paths without the leading /, so the restore lands in /tmp/restore-test/srv/....'],
      initialState: linux(net, { files: { ...Object.fromEntries(files.map((f) => [`/srv/${dept}/${f}`, `${f} content\n`])), [`/srv/${dept}/archive/2025.zip`]: 'zip\n', '/backup/': null } }),
      checks: [out('The archive holds every file', `tar tzf /backup/${dept}-2026-10-22.tar.gz`, { contains: [...files.map((f) => `srv/${dept}/${f}`), `srv/${dept}/archive/2025.zip`] }), out('The restore is identical', `diff -r /srv/${dept} /tmp/restore-test/srv/${dept}`, { status: 0 }), file('The test result is recorded', '/root/restore-test.txt', { equals: 'PASS' })],
      solution: [`tar czf /backup/${dept}-2026-10-22.tar.gz /srv/${dept}`, 'mkdir -p /tmp/restore-test', `tar xzf /backup/${dept}-2026-10-22.tar.gz -C /tmp/restore-test`, `diff -r /srv/${dept} /tmp/restore-test/srv/${dept} && echo PASS > /root/restore-test.txt || echo FAIL > /root/restore-test.txt`],
      realityNote: 'A restore test to a scratch location is the only real proof a backup works; many institutions schedule one per month and record the result.',
    };
  }),
  tmpl(6, 1, 'advanced', 'retention-maths', 'Work out retention and storage for backups', 'E10', 20, 'Compute storage for a grandfather-father-son retention scheme and choose where copies live.', (v) => {
    const full = v.pick([100, 250, 400]);
    const daily = v.pick([5, 10, 20]);
    const d = 7;
    const w = 4;
    const m = 12;
    const total = full * (w + m) + daily * d;
    return caseStudy(v, {
      intro: `## Retention for the student records server\n\nA full backup is **${full} GB**; each daily incremental is about **${daily} GB**. The policy: keep ${d} daily, ${w} weekly and ${m} monthly backups (grandfather-father-son), with weeklies and monthlies as fulls.`,
      steps: [
        { title: 'Storage', text: 'Roughly how much storage does the retention need?', evidence: [{ title: 'Working', text: `Weekly fulls: ${w} × ${full} GB\nMonthly fulls: ${m} × ${full} GB\nDaily incrementals: ${d} × ${daily} GB` }], choices: [{ text: `About ${total} GB`, right: true, feedback: `Correct: ${full * (w + m)} GB of fulls plus ${daily * d} GB of incrementals.` }, { text: `About ${full + daily * d} GB`, feedback: 'That keeps only one full.' }, { text: `About ${full * 23} GB`, feedback: 'That would make every daily a full.' }] },
        { title: 'Deduplication', text: 'A deduplicating tool (restic or borg) is proposed. Why does it shrink this a lot?', choices: [{ text: 'Unchanged data is stored once across all backups, so each "full" adds only new chunks', right: true, feedback: 'Correct.' }, { text: 'It compresses better than gzip', feedback: 'Compression helps, but deduplication is the big saving here.' }, { text: 'It skips system files', feedback: 'It backs up what you tell it to.' }] },
        { title: 'Ransomware', text: 'The backup server is mounted read-write on the records server over NFS. Risk?', choices: [{ text: 'Ransomware on the records server can encrypt the backups too; use pull backups or immutable/offline copies', right: true, feedback: 'Correct.' }, { text: 'None: backups are on another machine', feedback: 'Reachable and writable means destroyable.' }, { text: 'Only if the backups are compressed', feedback: 'Compression is irrelevant.' }] },
        { title: 'Off-site', text: 'Which off-site copy fits a campus with a slow internet link?', choices: [{ text: 'Seed the off-site repository once by carrying a disk, then send only incremental changes', right: true, feedback: 'Correct. The first full is the big transfer.' }, { text: 'Upload a full every night', feedback: 'The link would never finish.' }, { text: 'Skip off-site copies', feedback: 'A fire or theft then loses everything.' }] },
        { title: 'Retention law', text: 'Records must be kept for 7 years, but backups only 1 year. Conflict?', choices: [{ text: 'No: long-term retention is an archive, managed separately from operational backups', right: true, feedback: 'Correct. Backups are for recovery; archives are for retention.' }, { text: 'Keep all backups for 7 years', feedback: 'Expensive, and old backups are hard to restore from.' }, { text: 'Delete records after a year', feedback: 'That would break the retention requirement.' }] },
      ],
      ending: { title: 'Policy costed', text: 'GFS retention sized, deduplication, immutable or pulled backups, a seeded off-site copy and a separate archive.' },
      hints: ['Count fulls and incrementals separately.'],
      realityNote: 'Grandfather-father-son rotation dates from tape days; with deduplicating tools the same policy costs a fraction of the storage.',
    });
  }),

  /* ---------------------------------------------------------------- 6.2 tools: tar, rsync, dd, snapshots */
  tmpl(6, 2, 'beginner', 'tar-backup', 'Back up configuration and home directories with tar', 'E4', 15, 'Create compressed, dated archives and list their contents.', (v) => {
    const net = v.net();
    const p = v.person();
    const date = `2026-10-${String(v.int(10, 28)).padStart(2, '0')}`;
    return {
      instructions: lab({ situation: `Before upgrading the server, make two compressed archives in **/backup**: **etc-${date}.tar.gz** with all of **/etc**, and **home-${date}.tar.gz** with all of **/home**. Then list each archive to check it.`, steps: ['tar czf ARCHIVE DIRECTORY.', 'tar tzf ARCHIVE | head to check.'], tips: [`tar czf /backup/etc-${date}.tar.gz /etc`, `tar tzf /backup/home-${date}.tar.gz | head`] }),
      hints: ['c create, z gzip, f file, t list, x extract.'],
      initialState: linux(net, { users: { [p.sam]: {} }, files: { [`/home/${p.sam}/notes.txt`]: 'notes\n', '/backup/': null } }),
      checks: [out('/etc is archived', `tar tzf /backup/etc-${date}.tar.gz`, { contains: ['etc/passwd', 'etc/hostname'] }), out('/home is archived', `tar tzf /backup/home-${date}.tar.gz`, { contains: `home/${p.sam}/notes.txt` }), ran('You listed an archive', 'tar (-)?t')],
      solution: [`tar czf /backup/etc-${date}.tar.gz /etc`, `tar czf /backup/home-${date}.tar.gz /home`, `tar tzf /backup/etc-${date}.tar.gz`],
      realityNote: 'A tar of /etc before every upgrade is a cheap, effective safety net; etckeeper keeps /etc in git for the same reason.',
    };
  }),
  tmpl(6, 2, 'intermediate', 'rsync-mirror', 'Mirror data with rsync, excluding caches', 'E4', 20, 'Dry-run, then run an rsync mirror that deletes removed files and skips caches and temp files.', (v) => {
    const net = v.net();
    const site = v.pick(['moodle', 'portal', 'library']);
    return {
      instructions: lab({ situation: `Mirror **/srv/${site}** to **/backup/${site}** every night. The mirror must match the source exactly (files deleted from the source disappear from the mirror) but must not copy **cache/** directories or **\\*.tmp** files. Install rsync if needed, do a **dry run first** (-n), then the real run.`, steps: ['Look at what is already in /backup/' + site + '.', 'rsync -av --delete --exclude ... -n to preview.', 'Run it for real.', 'Compare with diff -r (caches and tmp files will differ, which is expected).'], tips: [`rsync -av --delete --exclude 'cache/' --exclude '*.tmp' -n /srv/${site}/ /backup/${site}/`, 'The trailing / on the source means "the contents of".'] }),
      hints: ['Without the trailing slash, rsync creates /backup/' + site + '/' + site + '.', '--delete only removes files from the destination.'],
      initialState: linux(net, { files: { [`/srv/${site}/index.php`]: 'index\n', [`/srv/${site}/config.php`]: 'config v2\n', [`/srv/${site}/uploads/a.pdf`]: 'pdf\n', [`/srv/${site}/cache/page1.html`]: 'cached\n', [`/srv/${site}/session.tmp`]: 'tmp\n', [`/backup/${site}/config.php`]: 'config v1\n', [`/backup/${site}/removed-last-week.php`]: 'old\n' } }),
      checks: [file('Files are copied', `/backup/${site}/uploads/a.pdf`), file('Changed files are updated', `/backup/${site}/config.php`, { equals: 'config v2' }), file('Deleted files are removed from the mirror', `/backup/${site}/removed-last-week.php`, { exists: false }), file('Caches are not copied', `/backup/${site}/cache`, { exists: false }), file('Temporary files are not copied', `/backup/${site}/session.tmp`, { exists: false }), ran('You did a dry run first', '^rsync .*(-[a-zA-Z]*n|--dry-run)')],
      solution: ['zypper install rsync', `rsync -av --delete --exclude 'cache/' --exclude '*.tmp' -n /srv/${site}/ /backup/${site}/`, `rsync -av --delete --exclude 'cache/' --exclude '*.tmp' /srv/${site}/ /backup/${site}/`],
      realityNote: 'rsync --delete is a mirror, not a backup: a file deleted by mistake vanishes from the mirror on the next run. Keep versioned backups as well.',
    };
  }),
  tmpl(6, 2, 'advanced', 'snapshot-backup', 'Take a consistent backup from an LVM snapshot', 'E4', 30, 'Snapshot a busy volume, back up the frozen copy, then remove the snapshot.', (v) => {
    const net = v.net();
    const vg = v.pick(['vgdata', 'vgsrv']);
    const lv = v.pick(['records', 'mail', 'repo']);
    const files = v.some(['jan.db', 'feb.db', 'mar.db', 'index.idx', 'journal.log'], 3);
    const state = { disks: [{ name: 'sdb', sizeGb: 100 }], pvs: [{ dev: '/dev/sdb', vg }], vgs: [{ name: vg, pvs: ['/dev/sdb'] }], lvs: [{ vg, name: lv, sizeGb: 60, fs: 'xfs', files: {} }], mounts: [{ dev: `/dev/${vg}/${lv}`, dir: `/srv/${lv}`, fs: 'xfs', opts: 'rw,relatime' }] };
    return {
      instructions: lab({ situation: `**/srv/${lv}** (logical volume ${vg}/${lv}) changes constantly, so a tar of the live directory can capture half-written files. Take a consistent backup:\n\n1. Create a **5 GB** snapshot **${lv}-snap** of /dev/${vg}/${lv}.\n2. Mount it read-only on **/mnt/${lv}-snap**.\n3. Archive the snapshot's contents as **/backup/${lv}.tar.gz** (paths starting with the file names, so use -C).\n4. Unmount and remove the snapshot (snapshots slow writes and fill up).`, steps: ['lvcreate -s -L 5G -n NAME /dev/VG/LV.', 'mkdir and mount -o ro.', 'tar czf ... -C /mnt/... .', 'umount, lvremove.'], tips: [`lvcreate -s -L 5G -n ${lv}-snap /dev/${vg}/${lv}`, `mount -o ro /dev/${vg}/${lv}-snap /mnt/${lv}-snap`, `tar czf /backup/${lv}.tar.gz -C /mnt/${lv}-snap .`, `lvremove -y /dev/${vg}/${lv}-snap`] }),
      hints: ['A snapshot freezes the volume at one moment; writes after that go to the snapshot space.'],
      initialState: linux(net, { files: { '/etc/lvm/lab-state.json': JSON.stringify(state), ...Object.fromEntries(files.map((f) => [`/srv/${lv}/${f}`, `${f} data\n`])), '/backup/': null, [`/mnt/${lv}-snap/`]: null } }),
      checks: [out('The archive holds the volume\'s files', `tar tzf /backup/${lv}.tar.gz`, { contains: files }), out('The snapshot is removed', 'lvs', { notContains: `${lv}-snap` }), out('Nothing is left mounted on the snapshot directory', `findmnt /mnt/${lv}-snap`, { equals: '' }), ran('You mounted it read-only', '^mount .*-o\\s*ro')],
      solution: [`lvcreate -s -L 5G -n ${lv}-snap /dev/${vg}/${lv}`, `mount -o ro /dev/${vg}/${lv}-snap /mnt/${lv}-snap`, `tar czf /backup/${lv}.tar.gz -C /mnt/${lv}-snap .`, `umount /mnt/${lv}-snap`, `lvremove -y /dev/${vg}/${lv}-snap`],
      realityNote: 'Snapshot-then-backup is how backup tools get crash-consistent copies of busy file systems; databases should still be flushed or dumped first.',
    };
  }),

  /* ---------------------------------------------------------------- 6.3 recovering files, boot loaders, passwords */
  tmpl(6, 3, 'beginner', 'restore-a-file', 'Restore a deleted file from last night\'s archive', 'E4', 15, 'Find a file in an archive and extract only that file back to its place.', (v) => {
    const net = v.net();
    const p = v.person();
    const f = v.pick(['thesis-draft.docx', 'marks-2026.xlsx', 'grant-proposal.odt']);
    const content = `${f} as of last night\n`;
    return {
      instructions: lab({ situation: `${p.given} deleted **/home/${p.sam}/Documents/${f}** this morning. Last night's backup is **/backup/home-nightly.tar.gz**. Restore just that file to where it was, owned by ${p.sam}, without touching anything else in their home directory.`, steps: ['Find the file in the archive with tar tzf | grep.', 'Extract only that member with -C /.', 'Check ownership with ls -l.'], tips: ['tar tzf /backup/home-nightly.tar.gz | grep ' + f, `tar xzf /backup/home-nightly.tar.gz -C / home/${p.sam}/Documents/${f}`, `chown ${p.sam}: /home/${p.sam}/Documents/${f}`] }),
      hints: ['Name the member exactly as tar tzf prints it.'],
      initialState: linux(net, { users: { [p.sam]: {} }, files: { [`/home/${p.sam}/Documents/today.txt`]: 'written today\n', '/backup/home-nightly.tar.gz': tarOf({ [`home/${p.sam}/Documents/${f}`]: content, [`home/${p.sam}/Documents/today.txt`]: 'old version\n' }) } }),
      checks: [file(`${f} is back with last night's content`, `/home/${p.sam}/Documents/${f}`, { equals: content.trim(), owner: p.sam }), file('Today\'s work was not overwritten', `/home/${p.sam}/Documents/today.txt`, { equals: 'written today' })],
      solution: [`tar tzf /backup/home-nightly.tar.gz | grep ${f}`, `tar xzf /backup/home-nightly.tar.gz -C / home/${p.sam}/Documents/${f}`, `chown ${p.sam}:${p.sam} /home/${p.sam}/Documents/${f}`],
      realityNote: 'Restoring a single file without overwriting newer work is the most common restore request any administrator handles.',
    };
  }),
  tmpl(6, 3, 'intermediate', 'locked-out-user', 'Recover a locked-out account safely', 'E4', 15, 'Unlock an account, set a temporary password and force a change at next login.', (v) => {
    const net = v.net();
    const p = v.person();
    return {
      instructions: lab({ situation: `${p.name} (**${p.sam}**) forgot their password, tried too many times and the account is now locked. You have verified their identity at the help desk. Unlock the account, give it a temporary password, and force ${p.given} to choose a new one at the next login. Record the action in **/var/log/helpdesk.log** as \`<date> reset ${p.sam}\`.`, steps: ['passwd -S to see the state.', 'usermod -U (or passwd -u) to unlock.', 'Set a temporary password, then chage -d 0.', 'Append to the help-desk log.'], tips: [`passwd -S ${p.sam}`, `usermod -U ${p.sam}`, `chage -d 0 ${p.sam}`, `echo "$(date +%F) reset ${p.sam}" >> /var/log/helpdesk.log`] }),
      hints: ['chage -d 0 sets the last change date to the epoch, so the password counts as expired.'],
      initialState: linux(net, { users: { [p.sam]: { password: 'locked' } } }),
      checks: [user(`${p.sam} is unlocked and has a password`, p.sam, { locked: false, hasPassword: true }), out('A new password is forced at next login', `chage -l ${p.sam}`, { contains: 'password must be changed' }), file('The reset is logged', '/var/log/helpdesk.log', { pattern: `\\d{4}-\\d{2}-\\d{2} reset ${p.sam}` })],
      solution: [`passwd -S ${p.sam}`, `usermod -U ${p.sam}`, `echo 'Temp@4821' | passwd ${p.sam}`, `chage -d 0 ${p.sam}`, `echo "$(date +%F) reset ${p.sam}" >> /var/log/helpdesk.log`],
      realityNote: 'Verifying identity before a reset matters more than the reset itself: help desks are a favourite target for social engineering.',
    };
  }),
  tmpl(6, 3, 'advanced', 'careful-directory-restore', 'Restore a damaged directory without losing newer work', 'E4', 25, 'Restore to staging, compare, and copy back only missing files.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const lost = v.some(['report-q1.pdf', 'report-q2.pdf', 'contacts.csv', 'templates.zip', 'logo.svg'], 3);
    const edited = v.pick(['plan.md', 'budget.ods']);
    return {
      instructions: lab({ situation: `A faulty sync deleted several files from **/srv/${dept}**, but staff have kept working: **${edited}** was edited today and is newer than the backup. Restore last night's archive (**/backup/${dept}-nightly.tar.gz**) to a staging directory, compare it with the live directory, and copy back **only the missing files**, never overwriting anything that still exists.`, steps: ['Extract into /tmp/stage with -C.', 'diff -r -q to see what is missing and what changed.', 'Copy back missing files only: rsync -a --ignore-existing (or cp -n).', 'Check that ' + edited + ' kept today\'s version.'], tips: [`mkdir -p /tmp/stage && tar xzf /backup/${dept}-nightly.tar.gz -C /tmp/stage`, `diff -r -q /tmp/stage/srv/${dept} /srv/${dept}`, `rsync -av --ignore-existing /tmp/stage/srv/${dept}/ /srv/${dept}/`] }),
      hints: ['"Only in /tmp/stage/..." lines are the lost files.', 'Restoring straight onto live data would undo today\'s edit.'],
      initialState: linux(net, { packages: RSYNC, files: { [`/srv/${dept}/${edited}`]: 'edited today\n', [`/srv/${dept}/keep.txt`]: 'keep\n', [`/backup/${dept}-nightly.tar.gz`]: tarOf({ [`srv/${dept}/${edited}`]: 'yesterday\n', [`srv/${dept}/keep.txt`]: 'keep\n', ...Object.fromEntries(lost.map((f) => [`srv/${dept}/${f}`, `${f}\n`])) }) } }),
      checks: [...lost.map((f) => file(`${f} is restored`, `/srv/${dept}/${f}`, { equals: f })), file(`${edited} keeps today's edit`, `/srv/${dept}/${edited}`, { equals: 'edited today' }), ran('You compared before copying', 'diff -[a-z]*r')],
      solution: [`mkdir -p /tmp/stage && tar xzf /backup/${dept}-nightly.tar.gz -C /tmp/stage`, `diff -r -q /tmp/stage/srv/${dept} /srv/${dept}`, `rsync -av --ignore-existing /tmp/stage/srv/${dept}/ /srv/${dept}/`],
      realityNote: 'Restore to a staging area first is a rule in every serious restore runbook: it turns a risky overwrite into a controlled merge.',
    };
  }),

  /* ---------------------------------------------------------------- 6.4 disaster recovery with unreliable power */
  tmpl(6, 4, 'beginner', 'power-protection', 'Protect servers from power cuts', 'E10', 15, 'Choose UPS sizing, automatic shutdown and restart behaviour for frequent outages.', (v) => {
    const load = v.pick([400, 800, 1200]);
    const mins = v.pick([10, 15, 20]);
    return caseStudy(v, {
      intro: `## Load-shedding again\n\nThe server room loses mains power several times a week. The servers draw about **${load} W** together. The generator takes up to **${mins} minutes** to start, and sometimes does not.`,
      steps: [
        { title: 'UPS size', text: `What should the UPS cover?`, choices: [{ text: `At least ${load} W with enough battery to bridge the generator start and still allow a clean shutdown`, right: true, feedback: 'Correct. Size for the load and the worst-case time to shut down safely.' }, { text: 'The cheapest UPS: any battery helps', feedback: 'If it runs out before shutdown completes, you still get a hard power-off.' }, { text: 'No UPS: the generator covers it', feedback: 'The gap before it starts is a hard power cut.' }] },
        { title: 'Automatic shutdown', text: 'Nobody is in the server room at 2 am.', choices: [{ text: 'Run NUT (or apcupsd) so servers shut down cleanly when the battery drops to a threshold', right: true, feedback: 'Correct.' }, { text: 'Leave them until the battery dies', feedback: 'That is the hard power-off the UPS was bought to prevent.' }, { text: 'Call the administrator to shut down by hand', feedback: 'At 2 am, nobody answers in time.' }] },
        { title: 'Order', text: 'In what order should servers shut down?', choices: [{ text: 'Applications first, then file and database servers, then the infrastructure (DNS, directory) last', right: true, feedback: 'Correct. Dependents go down before what they depend on.' }, { text: 'All at once', feedback: 'Applications may fail writes when the database disappears first.' }, { text: 'The UPS host first', feedback: 'It must stay up to tell the others to shut down.' }] },
        { title: 'Power returns', text: 'What should happen when power comes back?', choices: [{ text: 'Firmware set to restore power on, and services start in dependency order', right: true, feedback: 'Correct.' }, { text: 'Leave servers off until someone checks', feedback: 'Fine for a lab, slow for services people need.' }, { text: 'Start everything immediately, while the batteries recharge', feedback: 'A second cut during recharge can drain them: wait for a minimum charge.' }] },
      ],
      ending: { title: 'Power plan agreed', text: 'Sized UPS, NUT-driven clean shutdowns in dependency order and a controlled restart.' },
      hints: ['What draws power while the generator starts?'],
      realityNote: 'In Ghana and much of Africa, unclean shutdowns from power cuts are among the biggest causes of file system damage; UPS plus NUT is standard practice.',
    });
  }),
  tmpl(6, 4, 'intermediate', 'restore-order', 'Plan the order of a Linux server rebuild', 'E10', 20, 'Set RPO and RTO and order the steps of a bare-metal recovery.', (v) => {
    const host = v.pick(['the department web server', 'the e-learning server', 'the file server']);
    return caseStudy(v, {
      intro: `## Rebuilding ${host}\n\nThe disk controller of ${host} died. A replacement server arrives today. Plan the recovery.`,
      steps: [
        { title: 'RPO', text: 'Backups run nightly at 01:00; the failure happened at 15:00. What is the data loss?', choices: [{ text: 'Up to 14 hours of changes: the recovery point is 01:00', right: true, feedback: 'Correct. If that is too much, back up more often.' }, { text: 'None: RAID protected it', feedback: 'The controller failure took the RAID with it.' }, { text: '24 hours', feedback: 'The last backup was 14 hours earlier.' }] },
        { title: 'First step', text: 'What comes first on the new hardware?', choices: [{ text: 'Install the same distribution and version, or restore a bare-metal image (for example with ReaR)', right: true, feedback: 'Correct. A matching base avoids library and configuration mismatches.' }, { text: 'Restore /var/www onto any OS', feedback: 'The applications need the right packages and configuration.' }, { text: 'Upgrade to the newest distribution while you are at it', feedback: 'Do one thing at a time during a recovery.' }] },
        { title: 'Configuration', text: 'How do you get the configuration back?', choices: [{ text: 'From the /etc backup, an etckeeper repository or the Ansible playbooks that built it', right: true, feedback: 'Correct. Configuration as code makes this the fastest part.' }, { text: 'From memory', feedback: 'You will miss something.' }, { text: 'Copy the whole old root file system over the new install', feedback: 'That overwrites hardware-specific settings and can break boot.' }] },
        { title: 'Order of data', text: 'Which order?', choices: [{ text: 'Packages and configuration, then databases, then application files, then tests, then DNS cut-over', right: true, feedback: 'Correct.' }, { text: 'DNS first so users see something', feedback: 'They would see errors.' }, { text: 'Application files before databases', feedback: 'Applications need the database to start.' }] },
        { title: 'Done means', text: 'When is the recovery finished?', choices: [{ text: 'When users have checked their key functions, backups run on the new server and the incident is documented', right: true, feedback: 'Correct.' }, { text: 'When the server boots', feedback: 'Booting is far from working.' }, { text: 'When the old server is thrown away', feedback: 'Keep it until the post-incident review.' }] },
      ],
      ending: { title: 'Server recovered', text: 'Known RPO, matching base system, configuration from code, data in dependency order, tested and documented.' },
      hints: ['RPO is measured back to the last good backup.'],
      realityNote: 'Relax-and-Recover (ReaR) is the common open-source bare-metal recovery tool on Linux; configuration management makes rebuilds repeatable.',
    });
  }),
  tmpl(6, 4, 'advanced', 'dr-plan-linux', 'Write the disaster recovery plan for a small institution\'s Linux servers', 'E10', 25, 'Decide offline copies, ransomware response, priorities and testing for a whole server room.', (v) => {
    const servers = v.int(4, 9);
    return caseStudy(v, {
      intro: `## The whole room\n\nA college runs **${servers} Linux servers** in one room: directory/DNS, file, web, e-learning, database and monitoring. Write the DR plan with the IT committee.`,
      steps: [
        { title: 'Ransomware', text: 'Ransomware encrypts every server and every backup reachable from them. What protects you?', choices: [{ text: 'At least one backup copy that is offline or immutable (append-only repository, object lock, rotated disks)', right: true, feedback: 'Correct.' }, { text: 'More frequent backups to the same NAS', feedback: 'They would all be encrypted too.' }, { text: 'Antivirus on the servers', feedback: 'Useful, but not a recovery plan.' }] },
        { title: 'Priorities', text: 'Which services come back first?', choices: [{ text: 'Directory and DNS, then the database and file servers, then web and e-learning, then monitoring', right: true, feedback: 'Correct. Follow the dependencies.' }, { text: 'The website first, it is public', feedback: 'It depends on the database and directory.' }, { text: 'Monitoring first', feedback: 'Nice to have, nothing depends on it.' }] },
        { title: 'Where to recover', text: 'The server room itself is destroyed in a fire.', choices: [{ text: 'Pre-agreed alternative: a partner institution\'s rack or cloud VMs, with off-site backups and documented build steps', right: true, feedback: 'Correct. Decide this before the fire.' }, { text: 'Wait for new hardware and a new room', feedback: 'Weeks without services.' }, { text: 'Rebuild on staff laptops', feedback: 'Neither secure nor sustainable.' }] },
        { title: 'Documentation', text: 'Where does the DR plan live?', choices: [{ text: 'Printed and off-site as well as online, with contacts, passwords in a sealed or escrowed store, and build steps', right: true, feedback: 'Correct. A plan stored only on the failed servers is useless.' }, { text: 'On the file server', feedback: 'Which is down.' }, { text: 'In the administrator\'s head', feedback: 'A single point of failure.' }] },
        { title: 'Testing', text: 'How often should the plan be tested?', choices: [{ text: 'At least yearly as a full exercise, with restore tests every month', right: true, feedback: 'Correct.' }, { text: 'Never: tests cause downtime', feedback: 'Test on spare hardware or VMs.' }, { text: 'Only after a disaster', feedback: 'Then it is not a test.' }] },
      ],
      ending: { title: 'Plan approved', text: 'Offline or immutable backups, dependency-ordered recovery, an agreed alternative site, off-site documentation and regular tests.' },
      hints: ['What can ransomware not reach?'],
      realityNote: 'Guidance from national CERTs (including CSA Ghana) and NIST SP 800-34 stresses the same elements: offline copies, priorities, alternative sites and exercises.',
    });
  }),
];
