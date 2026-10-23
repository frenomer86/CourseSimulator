/** Unit 5: users and groups, permissions and ACLs. */

import type { TaskTemplate } from '../types';
import { DEPTS, file, group, lab, linux, out, tmpl, user } from './kit';

export const U5: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 5.1 accounts and password policy */
  tmpl(5, 1, 'beginner', 'create-accounts', 'Create user accounts with groups', 'E4', 15, 'Create a group and accounts with home directories, full names and passwords.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const people = v.people(3);
    return {
      instructions: lab({ situation: `Three new ${dept} staff need accounts on this server: ${people.map((p) => `**${p.sam}** (${p.name})`).join(', ')}. Create a group **${dept}**, then each account with a home directory, their full name as the comment, **${dept}** as a supplementary group, and an initial password.`, steps: [`groupadd ${dept}.`, 'useradd -m -c "Full Name" -G GROUP USER for each.', 'Set each password with passwd.', 'Check with id and getent passwd.'], tips: [`groupadd ${dept}`, `useradd -m -c "${people[0].name}" -G ${dept} ${people[0].sam}`, `passwd ${people[0].sam}`, `id ${people[0].sam}`] }),
      hints: ['-m creates the home directory from /etc/skel.', 'Without a password the account cannot log in with one.'],
      initialState: linux(net),
      checks: [group(`Group ${dept} has all three`, dept, { members: people.map((p) => p.sam) }), ...people.map((p) => user(`${p.sam} is set up`, p.sam, { homeExists: true, hasPassword: true, groups: [dept] })), out('Full names are recorded', 'getent passwd', { contains: people.map((p) => p.name) })],
      solution: [`groupadd ${dept}`, ...people.flatMap((p) => [`useradd -m -c "${p.name}" -G ${dept} ${p.sam}`, `echo 'Welcome@2026' | passwd ${p.sam}`])],
      realityNote: 'On larger estates accounts come from a directory (LDAP, FreeIPA or AD through SSSD), but local accounts are still used for servers and break-glass access.',
    };
  }),
  tmpl(5, 1, 'intermediate', 'password-aging', 'Apply password ageing and lock a leaver', 'E4', 20, 'Use chage to set maximum ages and force a change, and lock an account without deleting it.', (v) => {
    const net = v.net();
    const staff = v.people(3);
    const fresh = v.person();
    const leaver = v.person();
    const max = v.pick([60, 90, 180]);
    return {
      instructions: lab({ situation: `Apply the institution's password policy on this server:\n\n- Existing staff (${staff.map((p) => p.sam).join(', ')}) must change their password at least every **${max} days**.\n- New account **${fresh.sam}** must choose a new password at first login.\n- **${leaver.sam}** left yesterday: lock the account (do not delete it: files and mail are being handed over).`, steps: ['chage -M for the maximum age.', 'chage -d 0 forces a change at next login.', 'usermod -L (or passwd -l) locks the password.', 'Check with chage -l and passwd -S.'], tips: [`chage -M ${max} USER`, `chage -d 0 ${fresh.sam}`, `usermod -L ${leaver.sam}`, 'chage -l USER'] }),
      hints: ['The default maximum, 99999 days, means never.', 'Locking puts a ! in front of the hash in /etc/shadow.'],
      initialState: linux(net, { users: { ...Object.fromEntries([...staff, fresh, leaver].map((p) => [p.sam, {}])) } }),
      checks: [...staff.map((p) => out(`${p.sam} must change every ${max} days`, `chage -l ${p.sam}`, { contains: `Maximum number of days between password change\t\t: ${max}` })), out(`${fresh.sam} must change at first login`, `chage -l ${fresh.sam}`, { contains: 'password must be changed' }), user(`${leaver.sam} is locked, not deleted`, leaver.sam, { locked: true, homeExists: true })],
      solution: [...staff.map((p) => `chage -M ${max} ${p.sam}`), `chage -d 0 ${fresh.sam}`, `usermod -L ${leaver.sam}`, `chage -l ${staff[0].sam}`],
      realityNote: 'NIST now advises against forced periodic changes for users with strong passwords; many institutions still require them, which is why chage exists. Defaults for new accounts live in /etc/login.defs.',
    };
  }),
  tmpl(5, 1, 'advanced', 'account-audit', 'Audit local accounts for backdoors', 'E4', 25, 'Find extra UID 0 accounts, accounts without passwords and service accounts with shells, and fix them.', (v) => {
    const net = v.net();
    const backdoor = v.pick(['sysbackup', 'toor', 'support2']);
    const nopw = v.person();
    const svcAcct = v.pick(['jenkins', 'appsvc', 'reportsvc']);
    const ok = v.people(2);
    return {
      instructions: lab({ situation: `An intrusion alert fired on this server. Audit /etc/passwd and /etc/shadow and contain what you find, without deleting anything (the incident team needs the evidence):\n\n- Any account other than root with **UID 0** must be **locked** and given the shell **/sbin/nologin**.\n- Any account with **no password** must be locked.\n- Service accounts must not have a login shell: **${svcAcct}** gets /sbin/nologin.\n\nList the accounts you changed in **/root/audit-findings.txt**, one per line.`, steps: ["Find UID 0 accounts: awk -F: '$3 == 0' /etc/passwd.", "Find empty passwords: awk -F: '$2 == \"\"' /etc/shadow.", 'Lock with usermod -L, change shells with usermod -s.', 'Write the findings file.'], tips: ["awk -F: '$3 == 0 {print $1}' /etc/passwd", "awk -F: '$2 == \"\" {print $1}' /etc/shadow", 'usermod -L -s /sbin/nologin NAME'] }),
      hints: ['UID 0 means full root rights, whatever the name.', 'Locking and removing the shell contains the account but keeps it for investigation.'],
      initialState: linux(net, { users: { [backdoor]: { uid: 0, comment: 'backup' }, [nopw.sam]: { password: 'none' }, [svcAcct]: { shell: '/bin/bash' }, ...Object.fromEntries(ok.map((p) => [p.sam, {}])) } }),
      checks: [user(`${backdoor} (UID 0) is locked`, backdoor, { locked: true, shell: '/sbin/nologin' }), user(`${nopw.sam} (no password) is locked`, nopw.sam, { locked: true }), user(`${svcAcct} cannot log in interactively`, svcAcct, { shell: '/sbin/nologin' }), ...ok.map((p) => user(`${p.sam} is untouched`, p.sam, { locked: false, shell: '/bin/bash' })), out('root still works', 'getent passwd root', { contains: '/bin/bash' }), file('The findings are recorded', '/root/audit-findings.txt', { contains: [backdoor, nopw.sam, svcAcct] })],
      solution: ["awk -F: '$3 == 0 {print $1}' /etc/passwd", "awk -F: '$2 == \"\" {print $1}' /etc/shadow", `usermod -L -s /sbin/nologin ${backdoor}`, `usermod -L ${nopw.sam}`, `usermod -s /sbin/nologin ${svcAcct}`, `printf '${backdoor}\\n${nopw.sam}\\n${svcAcct}\\n' > /root/audit-findings.txt`],
      realityNote: 'A second UID 0 account is a classic persistence trick; CIS benchmarks check for it, for empty passwords and for system accounts with login shells.',
    };
  }),

  /* ---------------------------------------------------------------- 5.2 ownership, mode bits, setuid, setgid, sticky */
  tmpl(5, 2, 'beginner', 'chmod-chown', 'Set ownership and permissions on an application', 'E4', 15, 'Use chown and chmod so an application can read its config but other users cannot.', (v) => {
    const net = v.net();
    const app = v.pick(['payroll', 'timetable', 'library']);
    return {
      instructions: lab({ situation: `The **${app}** application runs as user **${app}**. Fix its files in **/opt/${app}**:\n\n- everything owned by **${app}:${app}**,\n- **config.ini** (it holds a database password) readable and writable by the owner only: **600**,\n- **run.sh** executable by the owner and group, readable by them, nothing for others: **750**,\n- the **/opt/${app}** directory itself **750**.`, steps: ['chown -R to change owner and group.', 'chmod with octal modes.', 'Check with ls -l.'], tips: [`chown -R ${app}:${app} /opt/${app}`, `chmod 600 /opt/${app}/config.ini`, `chmod 750 /opt/${app}/run.sh /opt/${app}`] }),
      hints: ['r=4, w=2, x=1; the three digits are owner, group, others.'],
      initialState: linux(net, { users: { [app]: { shell: '/sbin/nologin' } }, files: { [`/opt/${app}/config.ini`]: { content: 'db_password=S3cret\n', mode: '644' }, [`/opt/${app}/run.sh`]: { content: '#!/bin/bash\necho run\n', mode: '777' } } }),
      checks: [file('config.ini is 600 and owned by the app', `/opt/${app}/config.ini`, { mode: '600', owner: app, group: app }), file('run.sh is 750', `/opt/${app}/run.sh`, { mode: '750', owner: app }), file(`/opt/${app} is 750`, `/opt/${app}`, { mode: '750', owner: app })],
      solution: [`chown -R ${app}:${app} /opt/${app}`, `chmod 600 /opt/${app}/config.ini`, `chmod 750 /opt/${app}/run.sh /opt/${app}`, `ls -l /opt/${app}`],
      realityNote: 'World-readable configuration files with passwords are among the most common findings in Linux security reviews.',
    };
  }),
  tmpl(5, 2, 'intermediate', 'shared-directories', 'Build a shared group directory and a drop box', 'E4', 20, 'Use setgid so files inherit a group, and the sticky bit so users cannot delete each other\'s files.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [a, b] = v.people(2);
    return {
      instructions: lab({ situation: `Two shared directories are needed:\n\n1. **/srv/${dept}**: the ${dept} team (${a.sam} and ${b.sam}, group **${dept}**) can create and edit files there; nobody else can enter. Files created there must belong to the **${dept}** group automatically (setgid): mode **2770**, group ${dept}.\n2. **/srv/dropbox**: every user can create files, but nobody can delete or rename someone else's file (sticky bit): mode **1777**.\n\nThen test: as ${a.sam}, create /srv/${dept}/plan.txt and check its group.`, steps: ['mkdir both directories.', 'chgrp and chmod 2770 for the team directory.', 'chmod 1777 for the drop box.', `su ${a.sam} -c 'touch /srv/${dept}/plan.txt' and ls -l.`], tips: [`chgrp ${dept} /srv/${dept}`, `chmod 2770 /srv/${dept}`, 'chmod 1777 /srv/dropbox', 'ls -ld /srv/*'] }),
      hints: ['The s in drwxrws--- is setgid on the group; the t in drwxrwxrwt is the sticky bit.'],
      initialState: linux(net, { users: { [a.sam]: { groups: [dept] }, [b.sam]: { groups: [dept] } } }),
      checks: [file(`/srv/${dept} is 2770 with group ${dept}`, `/srv/${dept}`, { kind: 'dir', mode: '2770', group: dept }), file('/srv/dropbox is 1777', '/srv/dropbox', { kind: 'dir', mode: '1777' }), file(`plan.txt inherited group ${dept}`, `/srv/${dept}/plan.txt`, { owner: a.sam, group: dept })],
      solution: [`mkdir /srv/${dept} /srv/dropbox`, `chgrp ${dept} /srv/${dept}`, `chmod 2770 /srv/${dept}`, 'chmod 1777 /srv/dropbox', `su ${a.sam} -c 'touch /srv/${dept}/plan.txt'`, `ls -l /srv/${dept}`],
      realityNote: '/tmp is the most famous sticky directory; setgid project directories are the standard way to share files on Linux without ACLs.',
    };
  }),
  tmpl(5, 2, 'advanced', 'setuid-audit', 'Audit setuid programs and fix the default umask', 'E4', 25, 'Find unexpected setuid binaries, remove the setuid bit and tighten the default umask.', (v) => {
    const net = v.net();
    const rogue = v.pick(['/usr/local/bin/.syshelper', '/var/tmp/.cache/bash', '/home/shared/tools/update']);
    const umask = v.pick(['027', '077']);
    return {
      instructions: lab({ situation: `A security scan flagged this server. The approved setuid-root programs are **/usr/bin/passwd**, **/usr/bin/sudo** and **/usr/bin/su**. Find every setuid file, remove the setuid bit from anything not on the list (do not delete it: it is evidence), and record each one you changed in **/root/suid-findings.txt**. Also, new files are world-readable by default: set the default umask for login shells to **${umask}** in **/etc/profile.d/umask.sh**.`, steps: ['find / -perm -4000 -type f.', 'chmod u-s on the unexpected ones.', 'Write the findings.', `echo 'umask ${umask}' > /etc/profile.d/umask.sh`], tips: ['find / -perm -4000 -type f 2>/dev/null', 'chmod u-s FILE', 'stat -c %a FILE'] }),
      hints: ['A setuid-root copy of a shell gives anyone a root shell.', 'umask 027 removes write for group and everything for others from new files.'],
      initialState: linux(net, { files: { '/usr/bin/passwd': { content: 'ELF', mode: '4755' }, '/usr/bin/sudo': { content: 'ELF', mode: '4755' }, '/usr/bin/su': { content: 'ELF', mode: '4755' }, [rogue]: { content: 'ELF bash copy', mode: '4755' }, '/usr/local/bin/backup': { content: '#!/bin/bash\n', mode: '755' } } }),
      checks: [file('The rogue file is no longer setuid', rogue, { mode: '755' }), file('passwd stays setuid', '/usr/bin/passwd', { mode: '4755' }), file('sudo stays setuid', '/usr/bin/sudo', { mode: '4755' }), file('The finding is recorded', '/root/suid-findings.txt', { contains: rogue }), file('The default umask is set', '/etc/profile.d/umask.sh', { pattern: `^umask 0?${umask.replace(/^0/, '')}\\b` })],
      solution: ['find / -perm -4000 -type f', `chmod u-s ${rogue}`, `echo '${rogue}' > /root/suid-findings.txt`, `echo 'umask ${umask}' > /etc/profile.d/umask.sh`],
      realityNote: 'Unexpected setuid files are a standard post-compromise check (MITRE ATT&CK T1548.001); a baseline list makes them easy to spot.',
    };
  }),

  /* ---------------------------------------------------------------- 5.3 sudo */
  tmpl(5, 3, 'beginner', 'grant-sudo', 'Give an administrator sudo rights', 'E4', 10, 'Add a user to the wheel group so they can use sudo, and check it.', (v) => {
    const net = v.net();
    const p = v.person();
    const other = v.person();
    return {
      instructions: lab({ situation: `**${p.sam}** joined the infrastructure team and needs full administrative rights through **sudo** (members of **wheel** have them here). **${other.sam}** (a lecturer) must not.`, steps: [`Add ${p.sam} to wheel without removing their other groups (usermod -aG).`, `Check with groups ${p.sam} and sudo -l as that user.`], tips: [`usermod -aG wheel ${p.sam}`, `su - ${p.sam} -c 'sudo -l'`] }),
      hints: ['Without -a, usermod -G replaces all supplementary groups.'],
      initialState: linux(net, { groups: { lecturers: [] }, users: { [p.sam]: { groups: ['lecturers'] }, [other.sam]: { groups: ['lecturers'] } } }),
      checks: [user(`${p.sam} can use sudo`, p.sam, { sudo: true, groups: ['wheel', 'lecturers'] }), user(`${other.sam} cannot`, other.sam, { sudo: false })],
      solution: [`usermod -aG wheel ${p.sam}`, `groups ${p.sam}`],
      realityNote: 'Granting sudo through a group (wheel or sudo) instead of naming users in sudoers keeps access reviews simple.',
    };
  }),
  tmpl(5, 3, 'intermediate', 'limited-sudo', 'Write a least-privilege sudoers rule', 'E4', 20, 'Let web admins restart and reload Apache only, with a validated sudoers.d file.', (v) => {
    const net = v.net();
    const p = v.person();
    const grp = v.pick(['webadmins', 'webteam']);
    return {
      instructions: lab({ situation: `Members of **${grp}** (such as ${p.sam}) must be able to run exactly **systemctl restart apache2** and **systemctl reload apache2** as root, without a password, and nothing else. Write the rule in **/etc/sudoers.d/${grp}** (mode 0440), check it with **visudo -c**, and test it as ${p.sam}.`, steps: ['Write the file.', 'chmod 0440.', 'visudo -c to validate.', `su - ${p.sam} -c 'sudo -l' and try the restart.`], tips: [`echo '%${grp} ALL=(root) NOPASSWD: /usr/bin/systemctl restart apache2, /usr/bin/systemctl reload apache2' > /etc/sudoers.d/${grp}`, `chmod 0440 /etc/sudoers.d/${grp}`, 'visudo -c'] }),
      hints: ['%name means a group in sudoers.', 'A syntax error in any sudoers file can break sudo for everyone: always run visudo -c.'],
      initialState: linux(net, { groups: { [grp]: [p.sam] }, users: { [p.sam]: { groups: [grp] } }, packages: { apache2: { installed: true } }, services: { apache2: { active: false, package: 'apache2', port: 80 } } }),
      checks: [file('The rule file is 0440', `/etc/sudoers.d/${grp}`, { mode: '440', contains: `%${grp}` }), out('visudo -c is happy', 'visudo -c', { status: 0 }), out(`${p.sam} may restart apache2`, `su - ${p.sam} -c 'sudo -l'`, { contains: '/usr/bin/systemctl restart apache2' }), out(`${p.sam} may not read /etc/shadow`, `su - ${p.sam} -c 'sudo cat /etc/shadow'`, { notContains: 'root:' }), user(`${p.sam} is not a full sudoer`, p.sam, { sudo: false })],
      solution: [`echo '%${grp} ALL=(root) NOPASSWD: /usr/bin/systemctl restart apache2, /usr/bin/systemctl reload apache2' > /etc/sudoers.d/${grp}`, `chmod 0440 /etc/sudoers.d/${grp}`, 'visudo -c', `su - ${p.sam} -c 'sudo systemctl restart apache2'`],
      realityNote: 'Narrow sudo rules are least privilege in practice; beware rules for editors or shells, which let users escape to a root shell.',
    };
  }),
  tmpl(5, 3, 'advanced', 'sudo-audit', 'Repair and tighten a broken sudo configuration', 'E4', 25, 'Fix a sudoers syntax error that broke sudo and remove an over-broad rule.', (v) => {
    const net = v.net();
    const intern = v.person();
    const admin = v.person();
    return {
      instructions: lab({ situation: `sudo is broken for everyone: someone saved a file in /etc/sudoers.d with a typo. While fixing it, the review also found that intern **${intern.sam}** was given **ALL=(ALL) NOPASSWD: ALL** "temporarily" last year. Fix the syntax error so sudo works again, remove the intern's rule (they keep their account), and confirm admin **${admin.sam}** (in wheel) still has sudo.`, steps: ['Run visudo -c to find the bad file and line.', 'Fix or remove the broken line.', `Remove the ${intern.sam} rule.`, 'Run visudo -c again and test as both users.'], tips: ['visudo -c', 'cat /etc/sudoers.d/*', `su - ${intern.sam} -c 'sudo -l'`] }),
      hints: ['A sudoers rule is: who where=(as_whom) commands.', 'You are root on the console, so you can fix files even while sudo is broken.'],
      initialState: linux(net, { users: { [intern.sam]: {}, [admin.sam]: { sudo: true } }, files: { '/etc/sudoers.d/backup': { content: 'backupsvc ALL=(root) NOPASSWD /usr/bin/rsync\n', mode: '440' }, '/etc/sudoers.d/temp-access': { content: `${intern.sam} ALL=(ALL) NOPASSWD: ALL\n`, mode: '440' } } }),
      checks: [out('visudo -c succeeds', 'visudo -c', { status: 0 }), out(`${intern.sam} has no sudo rights`, `su - ${intern.sam} -c 'sudo -l'`, { notContains: 'ALL' }), user(`${intern.sam} keeps the account`, intern.sam, { homeExists: true }), user(`${admin.sam} still has sudo`, admin.sam, { sudo: true }), file('The backup rule still exists, fixed', '/etc/sudoers.d/backup', { contains: 'NOPASSWD: /usr/bin/rsync' })],
      solution: ['visudo -c', "sed -i 's/NOPASSWD \\/usr/NOPASSWD: \\/usr/' /etc/sudoers.d/backup", 'rm /etc/sudoers.d/temp-access', 'visudo -c'],
      realityNote: 'Always edit sudoers with visudo (or check with visudo -c): one typo can leave a server with no working sudo.',
    };
  }),

  /* ---------------------------------------------------------------- 5.4 ACLs, attributes, quotas */
  tmpl(5, 4, 'beginner', 'acl-for-auditor', 'Give one extra user read access with an ACL', 'E4', 15, 'Grant an auditor read access to a group directory without changing its group.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const aud = v.person();
    return {
      instructions: lab({ situation: `External auditor **${aud.sam}** needs to read the ${dept} reports in **/srv/${dept}/reports** (mode 770, group ${dept}) for two weeks. Adding them to the ${dept} group would also let them write. Give **only ${aud.sam}** read access (r-x on the directory, r-- on the existing file) with ACLs.`, steps: ['Look at the current permissions with ls -l and getfacl.', 'setfacl -m u:NAME:r-x on the directory.', 'setfacl -m u:NAME:r-- on the file.', 'Check with getfacl.'], tips: [`setfacl -m u:${aud.sam}:r-x /srv/${dept}/reports`, `getfacl /srv/${dept}/reports`] }),
      hints: ['The x on a directory lets you enter it; r lets you list it.'],
      initialState: linux(net, { users: { [aud.sam]: {} }, groups: { [dept]: [] }, files: { [`/srv/${dept}/reports/`]: { mode: '770', group: dept }, [`/srv/${dept}/reports/q3.csv`]: { content: 'q3\n', mode: '660', group: dept } } }),
      checks: [file('The directory has the ACL', `/srv/${dept}/reports`, { acl: `u:${aud.sam}:r-x` }), file('The report has the ACL', `/srv/${dept}/reports/q3.csv`, { acl: `u:${aud.sam}:r--` }), out(`${aud.sam} can read the report`, `su ${aud.sam} -c 'cat /srv/${dept}/reports/q3.csv'`, { contains: 'q3' }), user(`${aud.sam} is not in ${dept}`, aud.sam, { groups: [aud.sam] })],
      solution: [`setfacl -m u:${aud.sam}:r-x /srv/${dept}/reports`, `setfacl -m u:${aud.sam}:r-- /srv/${dept}/reports/q3.csv`, `getfacl /srv/${dept}/reports`],
      realityNote: 'ACLs solve "one extra person needs access" without inventing a new group; remove them when the need ends (setfacl -x).',
    };
  }),
  tmpl(5, 4, 'intermediate', 'default-acls', 'Make new files inherit access with default ACLs', 'E4', 20, 'Set default ACLs on a project directory so files created later get the right access.', (v) => {
    const net = v.net();
    const proj = v.pick(['curriculum-review', 'accreditation', 'research-grants']);
    const [w, r] = v.some(DEPTS, 2);
    const p = v.person();
    return {
      instructions: lab({ situation: `**/srv/${proj}** is shared by two departments: **${w}** writes (rwx) and **${r}** only reads (r-x). Existing files are fine, but files created later keep getting the wrong permissions. Set ACLs on the directory **and default ACLs** so that every new file and subdirectory automatically gives ${w} rwx and ${r} r-x. Test by creating a file as ${p.sam} (a ${w} member).`, steps: ['setfacl -m for the directory itself.', 'setfacl -d -m (default entries) for future files.', `As ${p.sam}, create a file and check getfacl on it.`], tips: [`setfacl -m g:${w}:rwx,g:${r}:r-x /srv/${proj}`, `setfacl -d -m g:${w}:rwx,g:${r}:r-x /srv/${proj}`, `su ${p.sam} -c 'touch /srv/${proj}/new.txt'`] }),
      hints: ['Default ACLs exist only on directories and are copied to things created inside them.'],
      initialState: linux(net, { groups: { [w]: [p.sam], [r]: [] }, users: { [p.sam]: { groups: [w] } }, files: { [`/srv/${proj}/`]: { mode: '770' } } }),
      checks: [file(`${w} can write in the directory`, `/srv/${proj}`, { acl: `g:${w}:rwx` }), file(`New files will give ${w} rwx`, `/srv/${proj}`, { acl: `d:g:${w}:rwx` }), file(`New files will give ${r} r-x`, `/srv/${proj}`, { acl: `d:g:${r}:r-x` }), file('A file created later has inherited the ACL', `/srv/${proj}/new.txt`, { acl: `g:${r}:r-x` })],
      solution: [`setfacl -m g:${w}:rwx,g:${r}:r-x /srv/${proj}`, `setfacl -d -m g:${w}:rwx,g:${r}:r-x /srv/${proj}`, `su ${p.sam} -c 'touch /srv/${proj}/new.txt'`, `getfacl /srv/${proj}/new.txt`],
      realityNote: 'Default ACLs are the Linux equivalent of inherited NTFS permissions; Samba file servers rely on them heavily.',
    };
  }),
  tmpl(5, 4, 'advanced', 'acl-cleanup', 'Clean up ACLs after a project ends', 'E4', 25, 'Find leftover ACL entries for leavers and contractors, remove them and keep the intended ones.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [keep, contractor] = v.people(2);
    const files = v.some(['budget.xlsx', 'plan.docx', 'contracts.pdf', 'minutes.docx'], 3);
    return {
      instructions: lab({ situation: `The contract of **${contractor.sam}** ended. They had ACL access across **/srv/${dept}** (the directory, its files and its default ACL). Remove **every** ACL entry for ${contractor.sam}, including the default entry, so new files no longer grant them anything. **${keep.sam}** (internal reviewer) keeps their read access.`, steps: ['getfacl -R /srv/' + dept + ' to see every entry.', 'setfacl -R -x u:NAME removes an access entry recursively.', 'setfacl -x d:u:NAME (or -k) removes a default entry.', 'Check again.'], tips: [`getfacl -R /srv/${dept}`, `setfacl -R -x u:${contractor.sam} /srv/${dept}`, `setfacl -x d:u:${contractor.sam} /srv/${dept}`] }),
      hints: ['-R applies to everything below the directory.', 'Default entries are listed as default:user:NAME.'],
      initialState: linux(net, { users: { [keep.sam]: {}, [contractor.sam]: {} }, files: { [`/srv/${dept}/`]: { mode: '770', acl: [`u:${keep.sam}:r-x`, `u:${contractor.sam}:rwx`, `d:u:${keep.sam}:r--`, `d:u:${contractor.sam}:rw-`] }, ...Object.fromEntries(files.map((f) => [`/srv/${dept}/${f}`, { content: `${f}\n`, mode: '660', acl: [`u:${keep.sam}:r--`, `u:${contractor.sam}:rw-`] }])) } }),
      checks: [...files.map((f) => out(`${f} no longer mentions ${contractor.sam}`, `getfacl /srv/${dept}/${f}`, { notContains: contractor.sam, contains: `user:${keep.sam}:r--` })), out(`The directory no longer grants ${contractor.sam}`, `getfacl /srv/${dept}`, { notContains: contractor.sam, contains: `user:${keep.sam}:r-x` })],
      solution: [`getfacl /srv/${dept}`, `setfacl -R -x u:${contractor.sam} /srv/${dept}`, `setfacl -x d:u:${contractor.sam} /srv/${dept}`, `getfacl /srv/${dept}`],
      realityNote: 'Leftover ACL entries for leavers are a common audit finding because they do not show in ls -l; getfacl -R or regular reports catch them.',
    };
  }),
];
