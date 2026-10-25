/** Unit 4: bulk user and account management. */

import type { TaskTemplate } from '../types';
import { DC, DEPTS, PW, addOu, addUser, csv, dc01, file, fs01, groupCheck, lab, linux, out, ouCheck, ps, psWrite, script, tmpl, user, userCheck, windows, write, writeScript } from './kit';

const MKDIR = (...dirs: string[]) => `New-Item -ItemType Directory ${dirs.join(', ')} -Force | Out-Null`;

export const U4: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 4.1 Linux accounts in scripts */
  tmpl(4, 1, 'beginner', 'new-staff-account', 'Create an account with password ageing', 'E4', 15, 'Create a user with a home, comment, group and shell, and set password ageing with chage.', (v) => {
    const net = v.net();
    const p = v.person();
    const grp = v.pick(DEPTS);
    const max = v.pick([60, 90, 120]);
    const warn = v.pick([7, 14]);
    return {
      instructions: lab({
        situation: `${p.name} joins the **${grp}** office. Create the account **${p.sam}** with:\n\n- a home directory, the comment \`${p.name}\` and the login shell /bin/bash;\n- supplementary group **${grp}** (create the group if needed);\n- password ageing: must change the password every **${max} days**, may not change it more than once a day (minimum 1), warned **${warn} days** before it expires;\n- an initial password, which must be changed at first login.`,
        steps: ['groupadd, then useradd -m -c ... -s ... -G ...', 'Set the password with chpasswd (echo "user:password" | chpasswd).', `chage -M ${max} -m 1 -W ${warn}, then chage -d 0 to force a change at first login.`, 'Check with chage -l and id.'],
        tips: [`useradd -m -c "${p.name}" -s /bin/bash -G ${grp} ${p.sam}`, `echo '${p.sam}:Welcome@2026' | chpasswd`, `chage -M ${max} -m 1 -W ${warn} ${p.sam}`, `chage -d 0 ${p.sam}`, `chage -l ${p.sam}`],
      }),
      hints: ['chage -d 0 sets the last change to 1 January 1970, so the password counts as expired.', 'Put the password change before chage -d 0: setting a password records today as the last change.'],
      initialState: linux(net),
      checks: [
        user('The account exists with home, shell and group', p.sam, { homeExists: true, shell: '/bin/bash', groups: [grp], hasPassword: true }),
        out('The comment is the full name', `getent passwd ${p.sam} | cut -d: -f5`, { equals: p.name }),
        out('Password ageing is set', `chage -l ${p.sam}`, { contains: [`Maximum number of days between password change\t\t: ${max}`, 'Minimum number of days between password change\t\t: 1', `Number of days of warning before password expires\t: ${warn}`] }),
        out('The password must be changed at first login', `chage -l ${p.sam} | head -1`, { contains: 'password must be changed' }),
      ],
      solution: [`groupadd ${grp}`, `useradd -m -c "${p.name}" -s /bin/bash -G ${grp} ${p.sam}`, `echo '${p.sam}:${PW}' | chpasswd`, `chage -M ${max} -m 1 -W ${warn} ${p.sam}`, `chage -d 0 ${p.sam}`, `chage -l ${p.sam}`],
      realityNote: 'Ageing settings live in /etc/shadow per account; /etc/login.defs sets the defaults for new accounts, which is where most organisations put their policy.',
    };
  }),
  tmpl(4, 1, 'intermediate', 'contractor-expiry', 'Expire contractor accounts on their end date', 'E4', 20, 'Read a list of contractors and set each account\'s expiry date and inactivity period in a loop.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const dates = people.map(() => `2027-0${v.int(1, 6)}-${String(v.int(1, 28)).padStart(2, '0')}`);
    const fmt = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')}, ${d.getUTCFullYear()}`; };
    const inactive = v.pick([7, 14, 30]);
    return {
      instructions: lab({
        situation: `Contractors' accounts must stop working on the day their contract ends. **/root/contractors.txt** lists \`username end-date\` (YYYY-MM-DD), one per line. Write **/usr/local/sbin/set-expiry** that reads the file given as $1 and, for each line, sets the account's **expiry date** and an **inactivity period of ${inactive} days** after password expiry. Lines starting with # are comments. Print \`<user> expires <date>\` for each. Run it on /root/contractors.txt.`,
        steps: ['while read -r name end; do ... done < "$1"', 'Skip comments and blank lines with a case or [[ ]].', `chage -E "$end" -I ${inactive} "$name"`, 'Check one with chage -l.'],
        tips: ['while read -r name end; do\n  [[ -z $name || $name == \\#* ]] && continue\n  ...\ndone < "$1"', `chage -E 2027-03-31 -I ${inactive} USER`],
      }),
      hints: ['read -r splits the line on spaces into the variables you list.', 'An expired account cannot log in even with the right password.'],
      initialState: linux(net, { users: Object.fromEntries(people.map((p) => [p.sam, { comment: `${p.name} (contractor)` }])), files: { '/root/contractors.txt': `# username end-date\n${people.map((p, i) => `${p.sam} ${dates[i]}`).join('\n')}\n` } }),
      checks: [
        ...people.slice(0, 3).map((p, i) => out(`${p.sam} expires on ${dates[i]}`, `chage -l ${p.sam} | grep 'Account expires'`, { contains: fmt(dates[i]) })),
        out('The inactivity period is set', `getent shadow ${people[3].sam} | cut -d: -f7`, { equals: String(inactive) }),
        script('It reports each account', '/usr/local/sbin/set-expiry', { args: ['/root/contractors.txt'], contains: people.map((p, i) => `${p.sam} expires ${dates[i]}`) }),
      ],
      solution: [writeScript('/usr/local/sbin/set-expiry', `while read -r name end; do\n  [[ -z $name || $name == \\#* ]] && continue\n  chage -E "$end" -I ${inactive} "$name"\n  echo "$name expires $end"\ndone < "$1"\n`), 'set-expiry /root/contractors.txt', `chage -l ${people[0].sam}`],
      realityNote: 'Setting the end date when the account is created is far more reliable than remembering to disable it later; HR systems feed these dates to identity tools for the same reason.',
    };
  }),
  tmpl(4, 1, 'advanced', 'sudoers-dropin', 'Grant least privilege with a sudoers drop-in', 'E4', 25, 'Let a helpdesk group run exactly two commands as root, validated with visudo.', (v) => {
    const net = v.net();
    const grp = v.pick(['helpdesk', 'lab-techs', 'printdesk']);
    const svc = v.pick(['cups', 'apache2', 'named']);
    const pkgs: Record<string, string> = { cups: 'cups', apache2: 'apache2', named: 'bind' };
    const tech = v.person();
    const other = v.person();
    return {
      instructions: lab({
        situation: `Members of **${grp}** (such as ${tech.sam}) need to restart **${svc}** and reset other users' passwords, nothing more. Create **/etc/sudoers.d/${grp}** that lets the group run, as root:\n\n- \`/usr/bin/systemctl restart ${svc}\`\n- \`/usr/bin/passwd\` with a user name argument (but not \`passwd root\`)\n\nThe file must be mode **0440**, owned by root, and pass \`visudo -cf\`. ${other.sam} is not in the group and must get nothing.`,
        steps: ['Write the rule: %GROUP ALL=(root) CMD1, CMD2, !CMD3', 'Use a pattern for passwd: /usr/bin/passwd [a-zA-Z0-9]* and exclude /usr/bin/passwd root.', 'chmod 440 and check with visudo -cf FILE.', `Check with sudo -l -U ${tech.sam} and sudo -l -U ${other.sam}.`],
        tips: [`%${grp} ALL=(root) /usr/bin/systemctl restart ${svc}, /usr/bin/passwd [a-zA-Z0-9]*, !/usr/bin/passwd root`, `visudo -cf /etc/sudoers.d/${grp}`, `sudo -l -U ${tech.sam}`],
      }),
      hints: ['Never edit sudoers files without visudo -c: one syntax error can lock everyone out of sudo.', 'File names in /etc/sudoers.d containing a dot are ignored.'],
      initialState: linux(net, { groups: { [grp]: [tech.sam] }, users: { [tech.sam]: { groups: [grp] }, [other.sam]: {} }, packages: { [pkgs[svc]]: { installed: true } }, services: { [svc]: { active: true, enabled: true, package: pkgs[svc] } } }),
      checks: [
        file('The drop-in is 0440 and owned by root', `/etc/sudoers.d/${grp}`, { mode: '440', owner: 'root' }),
        out('It passes visudo', `visudo -cf /etc/sudoers.d/${grp}`, { contains: 'parsed OK' }),
        out(`${tech.sam} may run exactly the two commands`, `sudo -l -U ${tech.sam}`, { contains: [`/usr/bin/systemctl restart ${svc}`, '/usr/bin/passwd'], notContains: 'ALL) ALL' }),
        out(`${other.sam} gets nothing`, `sudo -l -U ${other.sam}`, { contains: 'not allowed' }),
        file('passwd root is excluded', `/etc/sudoers.d/${grp}`, { contains: '!/usr/bin/passwd root' }),
      ],
      solution: [write(`/etc/sudoers.d/${grp}`, `# ${grp}: restart ${svc} and reset user passwords\n%${grp} ALL=(root) /usr/bin/systemctl restart ${svc}, /usr/bin/passwd [a-zA-Z0-9]*, !/usr/bin/passwd root\n`), `chmod 440 /etc/sudoers.d/${grp}`, `visudo -cf /etc/sudoers.d/${grp}`, `sudo -l -U ${tech.sam}`],
      realityNote: 'One drop-in file per team, deployed by configuration management and checked with visudo -c, is the standard way to keep sudo rules reviewable.',
    };
  }),

  /* ---------------------------------------------------------------- 4.2 bulk accounts from CSV with validation */
  tmpl(4, 2, 'beginner', 'accounts-from-csv', 'Create accounts from a CSV file', 'E4', 20, 'Loop over a CSV with IFS=, read and create each account with its group.', (v) => {
    const net = v.net();
    const depts = v.some(DEPTS, 2);
    const people = v.people(5).map((p, i) => ({ ...p, dept: depts[i % 2] }));
    return {
      instructions: lab({
        situation: `New staff are listed in **/root/new-staff.csv** with the header \`username,fullname,department\`. Write **/usr/local/sbin/import-staff FILE** that creates each account with a home directory, the full name as the comment, and the department as a supplementary group (create missing groups). Print \`created <username>\` for each. Run it.`,
        steps: ['Skip the header: tail -n +2 "$1" | while IFS=, read -r user name dept; do ... done', 'getent group "$dept" >/dev/null || groupadd "$dept"', 'useradd -m -c "$name" -G "$dept" "$user"'],
        tips: ['tail -n +2 "$1" | while IFS=, read -r user name dept; do\n  ...\ndone', 'getent group "$dept" >/dev/null || groupadd "$dept"'],
      }),
      hints: ['IFS=, makes read split on commas; -r keeps backslashes.', 'Quote "$name": full names contain spaces.'],
      initialState: linux(net, { files: { '/root/new-staff.csv': csv('username,fullname,department', people.map((p) => [p.sam, p.name, p.dept])) } }),
      checks: [
        ...people.map((p) => user(`${p.sam} exists in ${p.dept}`, p.sam, { homeExists: true, groups: [p.dept] })),
        out('Full names are the comments', `getent passwd ${people[2].sam} | cut -d: -f5`, { equals: people[2].name }),
      ],
      solution: [writeScript('/usr/local/sbin/import-staff', 'tail -n +2 "$1" | while IFS=, read -r user name dept; do\n  getent group "$dept" >/dev/null || groupadd "$dept"\n  useradd -m -c "$name" -G "$dept" "$user"\n  echo "created $user"\ndone\n'), 'import-staff /root/new-staff.csv'],
      realityNote: 'CSV exports from HR or student records systems are the usual input for bulk accounts; the import script is often the first automation a new administrator writes.',
    };
  }),
  tmpl(4, 2, 'intermediate', 'validate-before-create', 'Validate every row before creating accounts', 'E4', 25, 'Reject rows with bad IDs, unknown departments or duplicates, write the reasons, and create only valid accounts.', (v) => {
    const net = v.net();
    const depts = v.some(DEPTS, 3);
    const good = v.people(3).map((p, i) => ({ id: String(v.int(20260001, 20269999)), name: p.name, dept: depts[i] }));
    const badId = { id: `2026${v.int(10, 99)}`, name: v.person().name, dept: depts[0] };
    const badDept = { id: String(v.int(20260001, 20269999)), name: v.person().name, dept: 'astrology' };
    const dup = { ...good[1], name: v.person().name };
    const rows = v.some([good[0], badId, good[1], badDept, good[2], dup], 6);
    const existing = v.person();
    const exist = { id: String(v.int(20260001, 20269999)), name: existing.name, dept: depts[2] };
    rows.push(exist);
    const rejects = [`${badId.id},bad id`, `${badDept.id},unknown department`, `${dup.id},duplicate id`, `${exist.id},account exists`];
    return {
      instructions: lab({
        situation: `**/root/intake.csv** (\`id,fullname,department\`) creates student accounts named **s<id>**. Write **/usr/local/sbin/intake FILE** that checks every row and:\n\n- **rejects** a row whose id is not exactly 8 digits (\`bad id\`), whose department is not one of ${depts.map((d) => `**${d}**`).join(', ')} (\`unknown department\`), whose id already appeared earlier in the file (\`duplicate id\`), or whose account already exists (\`account exists\`);\n- writes rejects to **/root/rejects.csv** as \`id,reason\` (one line each, no header, in file order);\n- creates the valid accounts with a home and the department as a group.\n\nGroups for the three departments exist; s${exist.id} exists already.`,
        steps: ['Read with IFS=, and keep seen ids in an associative array: declare -A seen.', 'Test the id with [[ $id =~ ^[0-9]{8}$ ]].', 'Test the department with a case statement.', 'Check existence with id "s$id".'],
        tips: ['declare -A seen', '[[ -n ${seen[$id]} ]] && { echo "$id,duplicate id" >> /root/rejects.csv; continue; }', 'seen[$id]=1', ': > /root/rejects.csv   (start empty)'],
      }),
      hints: ['Check in a fixed order so each row gets one reason.', 'Record an id as seen even if the row is rejected for another reason? Here: only valid rows count as seen.'],
      initialState: linux(net, { groups: Object.fromEntries(depts.map((d) => [d, []])), users: { [`s${exist.id}`]: {} }, files: { '/root/intake.csv': csv('id,fullname,department', rows.map((r) => [r.id, r.name, r.dept])) } }),
      checks: [
        ...good.map((g) => user(`s${g.id} was created in ${g.dept}`, `s${g.id}`, { homeExists: true, groups: [g.dept] })),
        user('The bad-id row created nothing', `s${badId.id}`, { exists: false }),
        user('The unknown department row created nothing', `s${badDept.id}`, { exists: false }),
        file('Every reject is recorded with its reason', '/root/rejects.csv', { equals: rows.map((r) => (r === badId ? rejects[0] : r === badDept ? rejects[1] : r === dup ? rejects[2] : r === exist ? rejects[3] : '')).filter(Boolean).join('\n') }),
      ],
      solution: [writeScript('/usr/local/sbin/intake', `declare -A seen\n: > /root/rejects.csv\nwhile IFS=, read -r id name dept; do\n  if ! [[ $id =~ ^[0-9]{8}$ ]]; then echo "$id,bad id" >> /root/rejects.csv; continue; fi\n  case $dept in\n    ${depts.join('|')}) ;;\n    *) echo "$id,unknown department" >> /root/rejects.csv; continue ;;\n  esac\n  if [[ -n \${seen[$id]} ]]; then echo "$id,duplicate id" >> /root/rejects.csv; continue; fi\n  if id "s$id" >/dev/null 2>&1; then echo "$id,account exists" >> /root/rejects.csv; continue; fi\n  seen[$id]=1\n  useradd -m -c "$name" -G "$dept" "s$id"\ndone < <(tail -n +2 "$1")\n`), 'intake /root/intake.csv', 'cat /root/rejects.csv'],
      realityNote: 'Validating everything before changing anything, and returning the rejects to whoever sent the file, keeps bad data out of the directory and the conversation short.',
    };
  }),
  tmpl(4, 2, 'advanced', 'dry-run-summary', 'Add a dry run and a summary to a bulk import', 'E4', 30, 'Support -n to preview, skip existing accounts, and finish with counts and a matching exit code.', (v) => {
    const net = v.net();
    const people = v.people(5);
    const exists = people.slice(0, 2);
    const fresh = people.slice(2);
    const grp = v.pick(['students', 'staff', 'interns']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/bulk-add [-n] FILE** where FILE has one \`username,full name\` per line (no header):\n\n- with **-n** (dry run) it prints \`would create <user>\` or \`exists <user>\` and changes nothing;\n- without -n it creates missing accounts (home, comment, group **${grp}**) printing \`created <user>\`, and \`exists <user>\` for the others;\n- it always ends with \`summary: created=N exists=M\` (in a dry run, N counts the ones it would create);\n- it exits **0**, or **2** if the file is missing.\n\nPreview **/root/batch.csv** first, then run it for real.`,
        steps: ['Parse -n with getopts.', 'Count with two variables and print the summary at the end.', 'Test the dry run, check nothing changed, then run it.'],
        tips: ['while getopts n opt; do case $opt in n) dry=1 ;; esac; done; shift $((OPTIND - 1))', '[ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }', 'echo "summary: created=$created exists=$exists"'],
      }),
      hints: ['Keep the dry-run and real paths in one loop with if [ "$dry" ]; that way they cannot drift apart.', 'Pipes run while loops in a subshell, so counters set inside are lost; read with < "$1" instead.'],
      initialState: linux(net, { groups: { [grp]: [] }, users: Object.fromEntries(exists.map((p) => [p.sam, { groups: [grp] }])), files: { '/root/batch.csv': people.map((p) => `${p.sam},${p.name}`).join('\n') + '\n' } }),
      checks: [
        out('The dry run previews and changes nothing', `printf '%s\\n' 'trial1,Trial One' '${exists[0].sam},${exists[0].name}' > /tmp/trial.csv; /usr/local/sbin/bulk-add -n /tmp/trial.csv; getent passwd trial1 || echo none`, { contains: ['would create trial1', `exists ${exists[0].sam}`, 'summary: created=1 exists=1', 'none'] }),
        ...fresh.map((p) => user(`${p.sam} was created`, p.sam, { homeExists: true, groups: [grp] })),
        script('A second run creates nothing', '/usr/local/sbin/bulk-add', { args: ['/root/batch.csv'], status: 0, contains: `summary: created=0 exists=${people.length}` }),
        script('A missing file exits 2', '/usr/local/sbin/bulk-add', { args: ['/root/none.csv'], status: 2 }),
      ],
      solution: [writeScript('/usr/local/sbin/bulk-add', `dry=\nwhile getopts n opt; do\n  case $opt in n) dry=1 ;; esac\ndone\nshift $((OPTIND - 1))\n[ -f "$1" ] || { echo "no such file: $1" >&2; exit 2; }\ncreated=0 exists=0\nwhile IFS=, read -r user name; do\n  [ -n "$user" ] || continue\n  if id "$user" >/dev/null 2>&1; then\n    echo "exists $user"; exists=$((exists + 1)); continue\n  fi\n  if [ -n "$dry" ]; then\n    echo "would create $user"\n  else\n    useradd -m -c "$name" -G ${grp} "$user"\n    echo "created $user"\n  fi\n  created=$((created + 1))\ndone < "$1"\necho "summary: created=$created exists=$exists"\n`), 'bulk-add -n /root/batch.csv', 'bulk-add /root/batch.csv'],
      realityNote: 'A dry run that walks the same code path as the real run is the cheapest safety net a bulk script can have.',
    };
  }),

  /* ---------------------------------------------------------------- 4.3 Active Directory with PowerShell */
  tmpl(4, 3, 'beginner', 'ad-users-from-csv', 'Create AD users from a CSV', 'E4', 20, 'Import a CSV and create enabled users in an OU with an initial password that must be changed.', (v) => {
    const net = v.net();
    const dept = v.pick(['Finance', 'Registry', 'Library', 'Estates']);
    const people = v.people(4);
    return {
      instructions: lab({
        situation: `Create the users in **C:\\HR\\new-${dept.toLowerCase()}.csv** (GivenName, Surname, SamAccountName, Title) in the OU **OU=${dept},OU=Staff,${DC}**. Each must be **enabled**, have Department **${dept}**, a UPN of \`sam@campus.local\`, the initial password \`${PW}\`, and be forced to change it at first logon. The OU already exists.`,
        steps: ['$pw = ConvertTo-SecureString ... -AsPlainText -Force', 'Import-Csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" ... }', 'Check with Get-ADUser -Filter * -SearchBase "OU=..."'],
        tips: [`$pw = ConvertTo-SecureString '${PW}' -AsPlainText -Force`, `New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -UserPrincipalName "$($_.SamAccountName)@campus.local" -Title $_.Title -Department ${dept} -Path 'OU=${dept},OU=Staff,${DC}' -AccountPassword $pw -Enabled $true -ChangePasswordAtLogon $true`],
      }),
      hints: ['Without -AccountPassword the account cannot be enabled.', 'Typing the password into the script is only acceptable for an initial password that must be changed.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { addOu(st, dept, addOu(st, 'Staff')); }, files: { [`C:\\HR\\new-${dept.toLowerCase()}.csv`]: csv('GivenName,Surname,SamAccountName,Title', people.map((p) => [p.given, p.surname, p.sam, v.pick(['Officer', 'Assistant', 'Clerk'])])) } }),
      checks: [
        userCheck('Every user exists, enabled, in the OU', { sams: people.map((p) => p.sam), enabled: true, hasPassword: true, ou: `OU=${dept},OU=Staff,${DC}`, department: dept }),
        ps('They must change the password at first logon', `(Get-ADUser ${people[1].sam} -Properties pwdLastSet).pwdLastSet`, { equals: '0' }),
        ps('The UPN is set', `(Get-ADUser ${people[2].sam}).UserPrincipalName`, { equals: `${people[2].sam}@campus.local` }),
      ],
      solution: [`$pw = ConvertTo-SecureString '${PW}' -AsPlainText -Force`, `Import-Csv C:\\HR\\new-${dept.toLowerCase()}.csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -UserPrincipalName "$($_.SamAccountName)@campus.local" -Title $_.Title -Department ${dept} -Path 'OU=${dept},OU=Staff,${DC}' -AccountPassword $pw -Enabled $true -ChangePasswordAtLogon $true }`, `Get-ADUser -Filter * -SearchBase 'OU=${dept},OU=Staff,${DC}'`],
      realityNote: 'The same loop drives most school and office onboarding; bigger organisations move it into an identity system, but the attributes are the same.',
    };
  }),
  tmpl(4, 3, 'intermediate', 'sync-group-from-list', 'Synchronise a group with a list', 'E4', 25, 'Make an AD group\'s membership match a CSV exactly with Compare-Object, adding and removing.', (v) => {
    const net = v.net();
    const people = v.people(7);
    const grp = v.pick(['Exam Board', 'Lab Admins', 'Library Committee']);
    const current = people.slice(0, 4);
    const wanted = [people[1], people[2], people[4], people[5]];
    return {
      instructions: lab({
        situation: `The group **${grp}** must contain exactly the people in **C:\\Lists\\members.txt** (one SamAccountName per line), no more and no less. Write **C:\\Scripts\\Sync-Group.ps1 -Group NAME -ListPath FILE** that compares the group with the list using **Compare-Object**, adds the missing members, removes the extra ones, and prints \`added <sam>\` / \`removed <sam>\` lines. Run it for ${grp}.`,
        steps: ['$want = Get-Content $ListPath; $have = (Get-ADGroupMember $Group).SamAccountName', 'Compare-Object -ReferenceObject $have -DifferenceObject $want', '"=>" means only in the list (add); "<=" means only in the group (remove).', 'Add-ADGroupMember / Remove-ADGroupMember -Confirm:$false'],
        tips: ['$diff = Compare-Object -ReferenceObject @($have) -DifferenceObject @($want)', "foreach ($d in $diff) { if ($d.SideIndicator -eq '=>') { ... } else { ... } }"],
      }),
      hints: ['@(...) keeps an empty group from becoming $null, which Compare-Object refuses.', 'Running a sync twice must change nothing the second time.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const dns = people.map((p) => addUser(st, p, ou)); st.groups.push({ name: grp, dn: `CN=${grp},${ou}`, sid: `S-1-5-21-3623811015-3361044348-30300820-${st.nextRid++}`, scope: 'Global', category: 'Security', members: current.map((p) => dns[people.indexOf(p)]) }); }, files: { 'C:\\Lists\\members.txt': wanted.map((p) => p.sam).join('\n') + '\n' } }),
      checks: [
        groupCheck('The group matches the list exactly', grp, { members: wanted.map((p) => p.sam) }),
        ps('A second run changes nothing', `@(& C:\\Scripts\\Sync-Group.ps1 -Group '${grp}' -ListPath C:\\Lists\\members.txt).Count`, { equals: '0' }),
        ps('It reports changes', `Add-ADGroupMember '${grp}' -Members ${people[6].sam}; & C:\\Scripts\\Sync-Group.ps1 -Group '${grp}' -ListPath C:\\Lists\\members.txt`, { equals: `removed ${people[6].sam}` }),
        ps('It uses Compare-Object', 'Get-Content C:\\Scripts\\Sync-Group.ps1 -Raw', { contains: 'Compare-Object' }),
      ],
      solution: [psWrite('C:\\Scripts\\Sync-Group.ps1', "param([string]$Group, [string]$ListPath)\n$want = @(Get-Content $ListPath | Where-Object { $_ })\n$have = @((Get-ADGroupMember $Group).SamAccountName)\nforeach ($d in Compare-Object -ReferenceObject $have -DifferenceObject $want) {\n    if ($d.SideIndicator -eq '=>') {\n        Add-ADGroupMember -Identity $Group -Members $d.InputObject\n        \"added $($d.InputObject)\"\n    } else {\n        Remove-ADGroupMember -Identity $Group -Members $d.InputObject -Confirm:$false\n        \"removed $($d.InputObject)\"\n    }\n}"), `& C:\\Scripts\\Sync-Group.ps1 -Group '${grp}' -ListPath C:\\Lists\\members.txt`],
      realityNote: 'Making the system match a source of truth (rather than applying a list of changes) is the idea behind desired-state tools; it also removes access nobody remembered to take away.',
    };
  }),
  tmpl(4, 3, 'advanced', 'stale-accounts', 'Disable and quarantine inactive accounts', 'E4', 30, 'Find accounts inactive for N days, skip service accounts, disable, describe and move them to a quarantine OU.', (v) => {
    const net = v.net();
    const days = v.pick([60, 90, 120]);
    const people = v.people(7);
    const stale = people.slice(0, 3);
    const svcAcct = people[3];
    const active = people.slice(4);
    const ago = (d: number) => new Date(Date.UTC(2026, 9, 22) - d * 86400000).toISOString();
    return {
      instructions: lab({
        situation: `Audit found user accounts nobody has used in months. Write **C:\\Scripts\\Disable-Stale.ps1 [-Days N] [-WhatIf]** (default ${days}) that finds **enabled user accounts in OU=Staff** that have not logged on for **N days**, then for each: disables it, sets the description to \`Disabled 2026-10-22: inactive N days\` (today's date with Get-Date -Format yyyy-MM-dd), and moves it to **OU=Quarantine,${DC}**. Accounts in **OU=Service,OU=Staff** must never be touched. Run it.`,
        steps: [`Search-ADAccount -AccountInactive -TimeSpan (New-TimeSpan -Days $Days) -UsersOnly -SearchBase 'OU=Staff,${DC}'`, 'Filter out Enabled -eq $false and anything whose DistinguishedName contains OU=Service.', 'Disable-ADAccount, Set-ADUser -Description, Move-ADObject -TargetPath.', 'Add [CmdletBinding(SupportsShouldProcess)] so -WhatIf previews.'],
        tips: [`Search-ADAccount -AccountInactive -TimeSpan (New-TimeSpan -Days ${days}) -UsersOnly -SearchBase 'OU=Staff,${DC}'`, "Where-Object { $_.Enabled -and $_.DistinguishedName -notlike '*OU=Service,*' }", `Move-ADObject -Identity $u.DistinguishedName -TargetPath 'OU=Quarantine,${DC}'`],
      }),
      hints: ['Move the account last: its distinguished name changes when it moves.', 'Disabling and quarantining (instead of deleting) leaves a way back if the audit was wrong.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { const staff = addOu(st, 'Staff'); const service = addOu(st, 'Service', staff); addOu(st, 'Quarantine'); for (const p of stale) addUser(st, p, staff, { lastLogon: ago(days + v.int(5, 200)) }); addUser(st, svcAcct, service, { lastLogon: ago(days + 300) }); for (const p of active) addUser(st, p, staff, { lastLogon: ago(v.int(1, days - 5)) }); } }),
      checks: [
        userCheck('The stale accounts are disabled', { sams: stale.map((p) => p.sam), enabled: false, ou: `OU=Quarantine,${DC}` }),
        ps('Each has the description', `(Get-ADUser ${stale[0].sam} -Properties Description).Description`, { equals: `Disabled 2026-10-22: inactive ${days} days` }),
        userCheck('The service account was not touched', { sam: svcAcct.sam, enabled: true, ou: `OU=Service,OU=Staff,${DC}` }),
        userCheck('Active accounts were not touched', { sams: active.map((p) => p.sam), enabled: true, ou: `OU=Staff,${DC}` }),
        ouCheck('The quarantine OU is there', `OU=Quarantine,${DC}`),
      ],
      solution: [psWrite('C:\\Scripts\\Disable-Stale.ps1', `[CmdletBinding(SupportsShouldProcess)]\nparam([int]$Days = ${days})\n$today = Get-Date -Format yyyy-MM-dd\n$stale = Search-ADAccount -AccountInactive -TimeSpan (New-TimeSpan -Days $Days) -UsersOnly -SearchBase 'OU=Staff,${DC}' | Where-Object { $_.Enabled -and $_.DistinguishedName -notlike '*OU=Service,*' }\nforeach ($u in $stale) {\n    if ($PSCmdlet.ShouldProcess($u.SamAccountName, 'Disable and quarantine')) {\n        Disable-ADAccount -Identity $u.SamAccountName\n        Set-ADUser -Identity $u.SamAccountName -Description "Disabled $($today): inactive $Days days"\n        Move-ADObject -Identity $u.DistinguishedName -TargetPath 'OU=Quarantine,${DC}'\n        \"quarantined $($u.SamAccountName)\"\n    }\n}`), '& C:\\Scripts\\Disable-Stale.ps1 -WhatIf', '& C:\\Scripts\\Disable-Stale.ps1'],
      realityNote: 'Dormant accounts are a favourite foothold for attackers; most security baselines require a regular inactive-account review exactly like this.',
    };
  }),

  /* ---------------------------------------------------------------- 4.4 onboarding and offboarding */
  tmpl(4, 4, 'beginner', 'home-with-quota', 'Give a new user a home directory with a quota', 'E4', 15, 'Create the account, check its home permissions and set disk quota limits.', (v) => {
    const net = v.net();
    const p = v.person();
    const soft = v.pick([500, 1000, 2000]);
    return {
      instructions: lab({
        situation: `Onboard **${p.sam}** (${p.name}) on the shared lab server: create the account with a home directory, make sure the home is private (mode **700**), and give them a disk quota on **/home** of **${soft}M soft** and **${soft + soft / 5}M hard** (blocks only, no inode limits). The quota tools are in the **quota** package.`,
        steps: ['useradd -m and chmod 700 the home.', 'Install the quota package if setquota is missing.', `setquota -u ${p.sam} ${soft}M ${soft + soft / 5}M 0 0 /home`, `quota -u ${p.sam} to check.`],
        tips: [`useradd -m -c "${p.name}" ${p.sam}`, `chmod 700 /home/${p.sam}`, 'zypper install -y quota', `setquota -u ${p.sam} ${soft}M ${soft + soft / 5}M 0 0 /home`],
      }),
      hints: ['The soft limit can be exceeded for a grace period; the hard limit never.', 'Home directories readable by everyone leak coursework and keys.'],
      initialState: linux(net),
      checks: [
        user('The account and home exist', p.sam, { homeExists: true }),
        file('The home is private', `/home/${p.sam}`, { kind: 'dir', mode: '700', owner: p.sam }),
        out('The quota is set', `quota -u ${p.sam}`, { contains: [String(soft * 1024), String((soft + soft / 5) * 1024)] }),
      ],
      solution: [`useradd -m -c "${p.name}" ${p.sam}`, `chmod 700 /home/${p.sam}`, 'zypper install -y quota', `setquota -u ${p.sam} ${soft}M ${soft + soft / 5}M 0 0 /home`, `quota -u ${p.sam}`],
      realityNote: 'Quotas keep one user from filling a shared disk and stopping everyone else\'s work; universities usually set them per role (student, staff, researcher).',
    };
  }),
  tmpl(4, 4, 'intermediate', 'windows-home-folder', 'Provision a Windows home folder', 'E4', 25, 'Create a user\'s home folder on the file server, grant Modify, and set the AD home drive.', (v) => {
    const net = v.net();
    const people = v.people(3);
    const drive = v.pick(['H:', 'U:']);
    return {
      instructions: lab({
        situation: `New staff need home folders on **FS01**. Write **C:\\Scripts\\New-HomeFolder.ps1 -SamAccountName X** that:\n\n1. creates **D:\\Home\\X** on FS01 (reach it as \`\\\\FS01\\D$\\Home\\X\`);\n2. grants the user **Modify** on it, inherited by everything inside (icacls with (OI)(CI)M);\n3. sets the user's AD **HomeDirectory** to \`\\\\FS01\\Home$\\X\` and **HomeDrive** to **${drive}**.\n\nRun it for ${people.map((p) => p.sam).join(', ')}. The share Home$ already points at D:\\Home.`,
        steps: ['New-Item -ItemType Directory "\\\\FS01\\D$\\Home\\$SamAccountName" -Force', 'icacls PATH /grant "CAMPUS\\${SamAccountName}:(OI)(CI)M"', `Set-ADUser $SamAccountName -HomeDirectory ... -HomeDrive ${drive}`],
        tips: ['icacls "\\\\FS01\\D$\\Home\\$SamAccountName" /grant "CAMPUS\\$($SamAccountName):(OI)(CI)M"', `Set-ADUser -Identity $SamAccountName -HomeDirectory "\\\\FS01\\Home$\\$SamAccountName" -HomeDrive ${drive}`],
      }),
      hints: ['Modify lets users create and delete their own files without changing permissions.', '"$SamAccountName:" would be read as a drive-qualified variable; write $($SamAccountName): inside strings.'],
      initialState: windows({ machines: [dc01(net), fs01(net, { shares: [{ name: 'Home$', path: 'D:\\Home', description: 'Home folders', access: [{ account: 'Everyone', right: 'Full' }] }] } as never)], ad: (st) => { const ou = addOu(st, 'Staff'); for (const p of people) addUser(st, p, ou); }, machineFiles: { FS01: { 'D:\\Home\\README.txt': 'Home folders\n' } } }),
      checks: [
        ...people.map((p) => ps(`${p.sam} has Modify on the home folder`, `(Get-Acl \\\\FS01\\D$\\Home\\${p.sam}).Access | Where-Object { $_.IdentityReference -eq 'CAMPUS\\${p.sam}' } | ForEach-Object FileSystemRights`, { equals: 'Modify' })),
        ps('The AD home folder is set', `$u = Get-ADUser ${people[1].sam} -Properties HomeDirectory, HomeDrive; "$($u.HomeDirectory) $($u.HomeDrive)"`, { equals: `\\\\FS01\\Home$\\${people[1].sam} ${drive}` }),
      ],
      solution: [psWrite('C:\\Scripts\\New-HomeFolder.ps1', `param([Parameter(Mandatory)][string]$SamAccountName)\n$path = "\\\\FS01\\D$\\Home\\$SamAccountName"\nNew-Item -ItemType Directory -Path $path -Force | Out-Null\nicacls $path /grant "CAMPUS\\$($SamAccountName):(OI)(CI)M" | Out-Null\nSet-ADUser -Identity $SamAccountName -HomeDirectory "\\\\FS01\\Home$\\$SamAccountName" -HomeDrive ${drive}`), ...people.map((p) => `& C:\\Scripts\\New-HomeFolder.ps1 -SamAccountName ${p.sam}`)],
      realityNote: 'Folder, permission and AD attribute are three steps people forget one of when done by hand; scripting them together is the classic first onboarding automation on Windows.',
    };
  }),
  tmpl(4, 4, 'advanced', 'offboard-linux-user', 'Offboard a departing user safely', 'E4', 30, 'Lock the account, stop its processes and jobs, archive and remove the home, and keep an audit line.', (v) => {
    const net = v.net();
    const p = v.person();
    const grp = v.pick(DEPTS);
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/offboard USER** for staff who leave. For the given user it must:\n\n1. lock the password and expire the account (\`usermod -L\`, \`chage -E 0\`);\n2. kill their running processes and remove their crontab;\n3. archive the home directory to **/archive/USER-<date +%F>.tar.gz**, then remove the home;\n4. remove them from all supplementary groups but **keep the account** (files on shared disks still belong to its UID);\n5. append \`<date +%F> offboarded USER\` to **/var/log/offboard.log**.\n\nIt exits 1 with a message if the user does not exist, or is root. Offboard **${p.sam}**.`,
        steps: ['id "$1" >/dev/null 2>&1 || { echo ...; exit 1; }', 'usermod -L, chage -E 0, pkill -u, crontab -r -u', 'tar -czf /archive/... -C /home USER, then rm -rf the home.', 'usermod -G "" USER removes supplementary groups.'],
        tips: ['set -euo pipefail', 'pkill -u "$u" || true', 'crontab -r -u "$u" 2>/dev/null || true', 'tar -czf "/archive/$u-$(date +%F).tar.gz" -C /home "$u"', 'usermod -G "" "$u"'],
      }),
      hints: ['|| true keeps strict mode from stopping when there is nothing to kill.', 'Archive before you delete, and check the archive exists before rm.'],
      initialState: linux(net, { groups: { [grp]: [p.sam], projects: [p.sam] }, users: { [p.sam]: { groups: [grp, 'projects'], comment: p.name } }, files: { [`/home/${p.sam}/notes.txt`]: 'handover notes\n', [`/home/${p.sam}/work/report.odt`]: 'report\n', '/archive/': null }, processes: [{ cmd: '/usr/bin/python3 long_job.py', user: p.sam }], crontabs: { [p.sam]: '0 * * * * /home/' + p.sam + '/sync.sh\n' } }),
      checks: [
        out('The account is locked and expired', `passwd -S ${p.sam} | cut -d' ' -f2; chage -l ${p.sam} | grep 'Account expires'`, { contains: ['L', 'Jan 01, 1970'] }),
        out('Their processes and crontab are gone', `ps -u ${p.sam} -o pid= | wc -l; crontab -l -u ${p.sam} 2>&1`, { contains: ['0', `no crontab for ${p.sam}`] }),
        out('The home is archived and removed', `tar -tzf /archive/${p.sam}-2026-10-22.tar.gz; ls /home`, { contains: ['notes.txt', 'report.odt'], notContains: `${p.sam}\n` }),
        user('The account is kept but out of its groups', p.sam, { exists: true, groups: [] }),
        out('The groups no longer list them', `getent group ${grp} projects`, { notContains: p.sam }),
        file('It is logged', '/var/log/offboard.log', { contains: `2026-10-22 offboarded ${p.sam}` }),
        script('root is refused', '/usr/local/sbin/offboard', { args: ['root'], status: 1 }),
      ],
      solution: [writeScript('/usr/local/sbin/offboard', `set -euo pipefail\nu=\${1:-}\nif [ -z "$u" ] || [ "$u" = root ] || ! id "$u" >/dev/null 2>&1; then\n  echo "offboard: refusing '$u'" >&2\n  exit 1\nfi\nusermod -L "$u"\nchage -E 0 "$u"\npkill -u "$u" || true\ncrontab -r -u "$u" 2>/dev/null || true\nhome=$(getent passwd "$u" | cut -d: -f6)\nmkdir -p /archive\ntar -czf "/archive/$u-$(date +%F).tar.gz" -C "$(dirname "$home")" "$(basename "$home")"\n[ -s "/archive/$u-$(date +%F).tar.gz" ] && rm -rf "$home"\nusermod -G "" "$u"\necho "$(date +%F) offboarded $u" >> /var/log/offboard.log\n`), `offboard ${p.sam}`],
      realityNote: 'Offboarding failures (accounts left active, jobs still running as a former employee) are a classic audit finding; a single scripted procedure makes it consistent.',
    };
  }),

  /* ---------------------------------------------------------------- 4.5 secrets: initial passwords, SecureString, no plaintext */
  tmpl(4, 5, 'beginner', 'random-initial-passwords', 'Give each new account a random initial password', 'E4', 20, 'Generate random passwords, set them with chpasswd, force a change, and keep the list root-only.', (v) => {
    const net = v.net();
    const people = v.people(4);
    return {
      instructions: lab({
        situation: `The accounts ${people.map((p) => p.sam).join(', ')} were created without passwords. Give each a **different random** password of at least 12 characters (use \`openssl rand -base64 12\`), set them all with **chpasswd**, force a change at first login, and record \`user:password\` lines in **/root/initial-passwords.txt** so the helpdesk can hand them out. That file must be readable by **root only** (600), and created that way from the start (use umask 077).`,
        steps: ['umask 077 before creating the file.', 'Loop over the names: pw=$(openssl rand -base64 12); echo "$u:$pw" >> FILE', 'chpasswd < FILE sets them all at once.', 'chage -d 0 for each user.'],
        tips: ['umask 077', 'for u in a b c; do echo "$u:$(openssl rand -base64 12)"; done > /root/initial-passwords.txt', 'chpasswd < /root/initial-passwords.txt', 'chage -d 0 USER'],
      }),
      hints: ['chmod after creating a file leaves a moment when others could read it; umask avoids that.', 'Never reuse one "Welcome1" password for a whole intake.'],
      initialState: linux(net, { users: Object.fromEntries(people.map((p) => [p.sam, { comment: p.name, password: 'none' }])) }),
      checks: [
        file('The list is root-only', '/root/initial-passwords.txt', { mode: '600', owner: 'root' }),
        out('Each user has a different password of 12+ characters', "cut -d: -f2 /root/initial-passwords.txt | awk 'length >= 12' | sort -u | wc -l", { equals: String(people.length) }),
        ...people.map((p) => user(`${p.sam} has a password`, p.sam, { hasPassword: true })),
        out('Each must change it at first login', people.map((p) => `chage -l ${p.sam} | head -1`).join('; '), { pattern: '^(Last password change\\s+: password must be changed\\n?){4}$' }),
      ],
      solution: ['umask 077', `for u in ${people.map((p) => p.sam).join(' ')}; do echo "$u:$(openssl rand -base64 12)"; done > /root/initial-passwords.txt`, 'chpasswd < /root/initial-passwords.txt', `for u in ${people.map((p) => p.sam).join(' ')}; do chage -d 0 "$u"; done`, 'ls -l /root/initial-passwords.txt'],
      realityNote: 'Random first passwords plus a forced change, delivered out of band, is the minimum; many organisations now use one-time links or passwordless enrolment instead.',
    };
  }),
  tmpl(4, 5, 'intermediate', 'clixml-credential', 'Remove a plaintext password from a script', 'E4', 25, 'Store a service credential with Export-Clixml (DPAPI) and load it with Import-Clixml.', (v) => {
    const net = v.net();
    const acct = v.pick(['svc-backup', 'svc-report', 'svc-sync']);
    const secret = `${v.pick(['Kente', 'Volta', 'Sankofa'])}#${v.int(1000, 9999)}x`;
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Copy-Reports.ps1** contains the password of **CAMPUS\\${acct}** in plain text, and anyone who can read the script can read the password. Change it so that:\n\n1. the credential is saved once with **Export-Clixml** to **C:\\Secure\\${acct}.xml** (encrypted with DPAPI, so only this user on this computer can read it);\n2. the script loads it with **Import-Clixml** and no longer contains the password.\n\nThe script must still print \`connected as CAMPUS\\${acct}\`.`,
        steps: ['Build the credential once: New-Object System.Management.Automation.PSCredential(user, (ConvertTo-SecureString ... -AsPlainText -Force)).', 'Save it: $cred | Export-Clixml C:\\Secure\\' + acct + '.xml', 'In the script: $cred = Import-Clixml C:\\Secure\\' + acct + '.xml', 'Remove the password line and check with Select-String.'],
        tips: [`$cred = New-Object System.Management.Automation.PSCredential('CAMPUS\\${acct}', (ConvertTo-SecureString 'the-password' -AsPlainText -Force))`, `$cred | Export-Clixml C:\\Secure\\${acct}.xml`, `Select-String -Path C:\\Scripts\\Copy-Reports.ps1 -Pattern '${secret}'`],
      }),
      hints: ['DPAPI ties the file to the user and computer that wrote it: a scheduled task must save it while running as its own account.', 'Get-Credential prompts interactively; Export-Clixml is how you keep the result.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\Copy-Reports.ps1': `$user = 'CAMPUS\\${acct}'\n$password = ConvertTo-SecureString '${secret}' -AsPlainText -Force\n$cred = New-Object System.Management.Automation.PSCredential($user, $password)\n"connected as $($cred.UserName)"\n` } }),
      checks: [
        ps('The password is gone from the script', `@(Select-String -Path C:\\Scripts\\Copy-Reports.ps1 -Pattern '${secret.replace(/[#]/g, '\\$&')}' -SimpleMatch).Count`, { equals: '0' }),
        ps('The credential file holds the account', `(Import-Clixml C:\\Secure\\${acct}.xml).UserName`, { equals: `CAMPUS\\${acct}` }),
        ps('The stored password is right', `(Import-Clixml C:\\Secure\\${acct}.xml).GetNetworkCredential().Password`, { equals: secret }),
        ps('The script loads it and still works', '& C:\\Scripts\\Copy-Reports.ps1', { equals: `connected as CAMPUS\\${acct}` }),
        ps('The script uses Import-Clixml', 'Get-Content C:\\Scripts\\Copy-Reports.ps1 -Raw', { contains: 'Import-Clixml' }),
      ],
      solution: [MKDIR('C:\\Secure'), `$cred = New-Object System.Management.Automation.PSCredential('CAMPUS\\${acct}', (ConvertTo-SecureString '${secret}' -AsPlainText -Force))`, `$cred | Export-Clixml C:\\Secure\\${acct}.xml`, psWrite('C:\\Scripts\\Copy-Reports.ps1', `$cred = Import-Clixml C:\\Secure\\${acct}.xml\n"connected as $($cred.UserName)"`), '& C:\\Scripts\\Copy-Reports.ps1'],
      realityNote: 'Export-Clixml is the built-in answer on a single machine; for anything shared, a vault (SecretManagement, Azure Key Vault, HashiCorp Vault) or a gMSA removes the password entirely.',
    };
  }),
  tmpl(4, 5, 'advanced', 'secret-vault-and-scan', 'Move secrets into a vault and scan for leftovers', 'E4', 30, 'Store a secret with SecretManagement, use it from a script, and scan every script for plaintext passwords.', (v) => {
    const net = v.net();
    const secretName = v.pick(['DbPassword', 'SmtpPassword', 'ApiToken']);
    const value = `${v.pick(['Adinkra', 'Akwaaba', 'Gye'])}!${v.int(10000, 99999)}`;
    const leaky = v.some(['Sync-Grades.ps1', 'Send-Report.ps1', 'Backup-Db.ps1', 'Import-Fees.ps1'], 2);
    const clean = v.pick(['Get-DiskReport.ps1', 'Clear-Temp.ps1']);
    return {
      instructions: lab({
        situation: `Two jobs: move a secret into a vault, and find scripts that still hold passwords.\n\n1. Install **Microsoft.PowerShell.SecretManagement** and **Microsoft.PowerShell.SecretStore**, register a vault **LabVault** (the default), configure it for unattended use (\`Set-SecretStoreConfiguration -Authentication None -Interaction None\`), and store the secret **${secretName}** = \`${value}\`.\n2. Change **C:\\Scripts\\${leaky[0]}** to read the secret with **Get-Secret** instead of the literal value.\n3. Scan every .ps1 in C:\\Scripts with **Select-String** for lines assigning a password or token in quotes (pattern \`(password|token)\\s*=\\s*['"]\`, any case), and write **C:\\Reports\\secrets-scan.csv** with the columns **File, Line** (file name and line number) for what is left, without the #TYPE line.`,
        steps: ['Install-Module ... -Force; Register-SecretVault -Name LabVault -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault', 'Set-Secret -Name ' + secretName + ' -Secret ...', 'In the script: $secret = Get-Secret ' + secretName + ' -AsPlainText', "Select-String -Path C:\\Scripts\\*.ps1 -Pattern ... | Select-Object @{n='File';e={$_.Filename}}, @{n='Line';e={$_.LineNumber}}"],
        tips: ['Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Force', 'Set-SecretStoreConfiguration -Authentication None -Interaction None -Confirm:$false', `Get-Secret ${secretName} -AsPlainText`, "Select-String -Path C:\\Scripts\\*.ps1 -Pattern \"(password|token)\\s*=\\s*['\\\"]\""],
      }),
      hints: ['Authentication None is for unattended jobs on a protected server; interactive vaults should keep a password.', 'Select-String ignores case unless you add -CaseSensitive.'],
      initialState: windows({ machines: [dc01(net)], files: { [`C:\\Scripts\\${leaky[0]}`]: `$token = '${value}'\n"using secret of length $($token.Length)"\n`, [`C:\\Scripts\\${leaky[1]}`]: `$server = 'db01'\n$Password = "Old-${v.int(100, 999)}"\n"connecting to $server"\n`, [`C:\\Scripts\\${clean}`]: "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, FreeSpace\n" } }),
      checks: [
        ps('The secret is in the vault', `Get-Secret ${secretName} -AsPlainText`, { equals: value }),
        ps('LabVault is the default vault', '(Get-SecretVault | Where-Object IsDefaultVault).Name', { equals: 'LabVault' }),
        ps(`${leaky[0]} reads the vault and no longer holds the value`, `$t = Get-Content C:\\Scripts\\${leaky[0]} -Raw; ($t -match 'Get-Secret') -and -not $t.Contains('${value}')`, { equals: 'True' }),
        ps(`${leaky[0]} still works`, `& C:\\Scripts\\${leaky[0]}`, { equals: `using secret of length ${value.length}` }),
        ps('The scan lists what is left', '(Import-Csv C:\\Reports\\secrets-scan.csv | ForEach-Object { "$($_.File):$($_.Line)" }) -join \';\'', { equals: `${leaky[1]}:2` }),
      ],
      solution: ['Install-Module Microsoft.PowerShell.SecretManagement, Microsoft.PowerShell.SecretStore -Force', 'Register-SecretVault -Name LabVault -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault', 'Set-SecretStoreConfiguration -Authentication None -Interaction None -Confirm:$false', `Set-Secret -Name ${secretName} -Secret '${value}'`, psWrite(`C:\\Scripts\\${leaky[0]}`, `$token = Get-Secret ${secretName} -AsPlainText\n"using secret of length $($token.Length)"`), MKDIR('C:\\Reports'), "Select-String -Path C:\\Scripts\\*.ps1 -Pattern \"(password|token)\\s*=\\s*['`\"]\" | Select-Object @{n='File';e={$_.Filename}}, @{n='Line';e={$_.LineNumber}} | Export-Csv C:\\Reports\\secrets-scan.csv -NoTypeInformation", 'Import-Csv C:\\Reports\\secrets-scan.csv'],
      realityNote: 'Secret scanning (git-secrets, gitleaks, GitHub push protection) catches leaked credentials before they ship; a vault means there is nothing to leak in the first place.',
    };
  }),

  /* ---------------------------------------------------------------- 4.6 idempotent re-runs, dry runs, audit trails */
  tmpl(4, 6, 'beginner', 'idempotent-ensure-user', 'Make an account script safe to run twice', 'E4', 20, 'Rewrite a script so it checks state first and reports created or unchanged, never failing on a re-run.', (v) => {
    const net = v.net();
    const p = v.person();
    const grp = v.pick(DEPTS);
    return {
      instructions: lab({
        situation: `**/usr/local/sbin/ensure-${p.sam}** creates ${p.sam}, adds them to **${grp}** and makes **/srv/${grp}/${p.sam}**. The first run works; the second run fails with "user already exists" and "group already exists", so it cannot run from configuration management. Make it **idempotent**: each step checks first and only acts when needed, printing \`created …\` or \`ok …\`. Running it twice must succeed both times, and the second run must print only \`ok\` lines.`,
        steps: ['getent group NAME >/dev/null || groupadd NAME', 'id USER >/dev/null 2>&1 || useradd ...', 'id -nG USER | grep -qw GROUP || usermod -aG ...', 'mkdir -p is idempotent already.'],
        tips: ['if getent group G >/dev/null; then echo "ok group G"; else groupadd G && echo "created group G"; fi', `id -nG ${p.sam} | grep -qw ${grp}`],
      }),
      hints: ['Idempotent means: running it again does not change anything that is already right.', 'usermod -aG appends; without -a it replaces all supplementary groups.'],
      initialState: linux(net, { files: { [`/usr/local/sbin/ensure-${p.sam}`]: { content: `#!/bin/bash\nset -e\ngroupadd ${grp}\nuseradd -m -c "${p.name}" ${p.sam}\nusermod -aG ${grp} ${p.sam}\nmkdir /srv/${grp}/${p.sam}\nchown ${p.sam}:${grp} /srv/${grp}/${p.sam}\necho done\n`, mode: '755' }, [`/srv/${grp}/`]: null } }),
      checks: [
        user(`${p.sam} exists in ${grp}`, p.sam, { groups: [grp], homeExists: true }),
        file('The folder exists and belongs to them', `/srv/${grp}/${p.sam}`, { kind: 'dir', owner: p.sam, group: grp }),
        script('A re-run succeeds and changes nothing', `/usr/local/sbin/ensure-${p.sam}`, { status: 0, contains: 'ok', notContains: 'created' }),
        out('A run on a fresh system creates everything', `userdel -r ${p.sam}; groupdel ${grp}; rm -rf /srv/${grp}/${p.sam}; /usr/local/sbin/ensure-${p.sam}; echo "rc=$?"`, { contains: ['created', 'rc=0'] }),
      ],
      solution: [writeScript(`/usr/local/sbin/ensure-${p.sam}`, `set -e\nif getent group ${grp} >/dev/null; then echo "ok group ${grp}"; else groupadd ${grp}; echo "created group ${grp}"; fi\nif id ${p.sam} >/dev/null 2>&1; then echo "ok user ${p.sam}"; else useradd -m -c "${p.name}" ${p.sam}; echo "created user ${p.sam}"; fi\nif id -nG ${p.sam} | grep -qw ${grp}; then echo "ok membership"; else usermod -aG ${grp} ${p.sam}; echo "created membership"; fi\nif [ -d /srv/${grp}/${p.sam} ]; then echo "ok folder"; else mkdir -p /srv/${grp}/${p.sam}; echo "created folder"; fi\nchown ${p.sam}:${grp} /srv/${grp}/${p.sam}\n`), `ensure-${p.sam}`, `ensure-${p.sam}`],
      realityNote: 'Ansible, Puppet and DSC are built on this pattern: describe the end state, check, and act only on the difference; well-written shell scripts can do the same.',
    };
  }),
  tmpl(4, 6, 'intermediate', 'whatif-bulk-ad', 'Preview a bulk AD change with -WhatIf', 'E4', 25, 'Write an advanced function that creates users from a CSV, skips existing ones, and supports -WhatIf.', (v) => {
    const net = v.net();
    const people = v.people(5);
    const existing = people.slice(0, 2);
    const fresh = people.slice(2);
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\Import-Staff.ps1** with \`[CmdletBinding(SupportsShouldProcess)]\` and a **-Path** parameter. For each row of the CSV (GivenName, Surname, SamAccountName) it:\n\n- prints \`exists <sam>\` and skips accounts that already exist (find them with Get-ADUser -Filter, which returns nothing instead of an error);\n- otherwise creates the user in **OU=Staff,${DC}** (enabled, password \`${PW}\`, change at logon) **only if ShouldProcess agrees**, and prints \`created <sam>\`.\n\nRun it with **-WhatIf** first, then for real on **C:\\HR\\intake.csv**.`,
        steps: ['$exists = Get-ADUser -Filter "SamAccountName -eq \'$($row.SamAccountName)\'"', "if ($PSCmdlet.ShouldProcess($row.SamAccountName, 'Create AD user')) { New-ADUser ... }", 'Run with -WhatIf and check nothing was created.'],
        tips: ['[CmdletBinding(SupportsShouldProcess)]\nparam([Parameter(Mandatory)][string]$Path)', "Get-ADUser -Filter \"SamAccountName -eq '$sam'\""],
      }),
      hints: ['Get-ADUser -Identity throws for a missing user; -Filter just returns nothing, which is easier to test.', 'With SupportsShouldProcess, -WhatIf flows into New-ADUser too.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); for (const p of existing) addUser(st, p, ou); }, files: { 'C:\\HR\\intake.csv': csv('GivenName,Surname,SamAccountName', people.map((p) => [p.given, p.surname, p.sam])) } }),
      checks: [
        ps('-WhatIf creates nothing', `Remove-ADUser ${fresh[0].sam} -Confirm:$false -ErrorAction SilentlyContinue; & C:\\Scripts\\Import-Staff.ps1 -Path C:\\HR\\intake.csv -WhatIf | Out-Null; @(Get-ADUser -Filter "SamAccountName -eq '${fresh[0].sam}'").Count`, { equals: '0' }),
        userCheck('The new users were created', { sams: fresh.map((p) => p.sam), enabled: true, ou: `OU=Staff,${DC}` }),
        ps('Existing users are reported and skipped', '& C:\\Scripts\\Import-Staff.ps1 -Path C:\\HR\\intake.csv', { contains: existing.map((p) => `exists ${p.sam}`), notContains: 'created' }),
        ps('It supports ShouldProcess', 'Get-Content C:\\Scripts\\Import-Staff.ps1 -Raw', { contains: ['SupportsShouldProcess', 'ShouldProcess('] }),
      ],
      solution: [psWrite('C:\\Scripts\\Import-Staff.ps1', `[CmdletBinding(SupportsShouldProcess)]\nparam([Parameter(Mandatory)][string]$Path)\n$pw = ConvertTo-SecureString '${PW}' -AsPlainText -Force\nforeach ($row in Import-Csv $Path) {\n    $sam = $row.SamAccountName\n    if (Get-ADUser -Filter "SamAccountName -eq '$sam'") { "exists $sam"; continue }\n    if ($PSCmdlet.ShouldProcess($sam, 'Create AD user')) {\n        New-ADUser -Name "$($row.GivenName) $($row.Surname)" -GivenName $row.GivenName -Surname $row.Surname -SamAccountName $sam -Path 'OU=Staff,${DC}' -AccountPassword $pw -Enabled $true -ChangePasswordAtLogon $true\n        "created $sam"\n    }\n}`), '& C:\\Scripts\\Import-Staff.ps1 -Path C:\\HR\\intake.csv -WhatIf', '& C:\\Scripts\\Import-Staff.ps1 -Path C:\\HR\\intake.csv'],
      realityNote: '-WhatIf output pasted into a change request is a precise description of what will happen, which reviewers can actually check.',
    };
  }),
  tmpl(4, 6, 'advanced', 'audit-trail', 'Keep an audit trail of every decision', 'E4', 30, 'Record each decision of a bulk disable job in a CSV audit log and a transcript, appending across runs.', (v) => {
    const net = v.net();
    const people = v.people(6);
    const leavers = people.slice(0, 3);
    const notFound = v.person();
    const already = leavers[2];
    const ticket = `CHG-${v.int(1000, 9999)}`;
    return {
      instructions: lab({
        situation: `HR sends **C:\\HR\\leavers.txt** (one SamAccountName per line). Write **C:\\Scripts\\Disable-Leavers.ps1 -Ticket ID** that, for each name:\n\n- disables the account if it is enabled → action **Disabled**;\n- does nothing if it is already disabled → action **AlreadyDisabled**;\n- does nothing if it does not exist → action **NotFound**.\n\nEvery decision is **appended** to **C:\\Logs\\leavers-audit.csv** with the columns **Time, Ticket, Account, Action** (Time as yyyy-MM-ddTHH:mm:ss). The whole run is also recorded with **Start-Transcript -Append** to **C:\\Logs\\transcripts\\leavers.txt**. Run it with ticket **${ticket}**.`,
        steps: ['Start-Transcript -Path ... -Append at the top, Stop-Transcript at the end (use try/finally).', 'Get-ADUser -Filter to find each account; check .Enabled.', '[pscustomobject]@{ Time = ...; Ticket = $Ticket; Account = $n; Action = ... } | Export-Csv -Append -NoTypeInformation', 'Run it, then run it again: the second run should log AlreadyDisabled.'],
        tips: ['Export-Csv -Path C:\\Logs\\leavers-audit.csv -Append -NoTypeInformation', "Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'", 'try { ... } finally { Stop-Transcript }'],
      }),
      hints: ['-Append on Export-Csv writes the header only when the file is new.', 'An audit log that a re-run overwrites is not an audit log.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); for (const p of people) addUser(st, p, ou, p === already ? { enabled: false } : {}); }, files: { 'C:\\HR\\leavers.txt': [...leavers.map((p) => p.sam), notFound.sam].join('\n') + '\n' } }),
      checks: [
        userCheck('The leavers are disabled', { sams: leavers.map((p) => p.sam), enabled: false }),
        userCheck('Other staff are untouched', { sams: people.slice(3).map((p) => p.sam), enabled: true }),
        ps('Each decision is in the audit log', "(Import-Csv C:\\Logs\\leavers-audit.csv | Select-Object -First 4 | ForEach-Object { \"$($_.Ticket),$($_.Account),$($_.Action)\" }) -join ';'", { equals: [...leavers.map((p) => `${ticket},${p.sam},${p === already ? 'AlreadyDisabled' : 'Disabled'}`), `${ticket},${notFound.sam},NotFound`].join(';') }),
        ps('Times are recorded', '(Import-Csv C:\\Logs\\leavers-audit.csv)[0].Time', { pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}$' }),
        ps('A second run appends, never overwrites', `$n = @(Import-Csv C:\\Logs\\leavers-audit.csv).Count; & C:\\Scripts\\Disable-Leavers.ps1 -Ticket TEST-1 | Out-Null; $all = @(Import-Csv C:\\Logs\\leavers-audit.csv); "$($all.Count - $n) $($all[-1].Action)"`, { equals: `4 NotFound` }),
        ps('The run is in the transcript', 'Get-Content C:\\Logs\\transcripts\\leavers.txt -Raw', { contains: ['transcript start', 'transcript end'] }),
      ],
      solution: [psWrite('C:\\Scripts\\Disable-Leavers.ps1', "param([Parameter(Mandatory)][string]$Ticket)\nStart-Transcript -Path C:\\Logs\\transcripts\\leavers.txt -Append | Out-Null\ntry {\n    foreach ($n in Get-Content C:\\HR\\leavers.txt | Where-Object { $_ }) {\n        $u = Get-ADUser -Filter \"SamAccountName -eq '$n'\"\n        if (-not $u) { $action = 'NotFound' }\n        elseif (-not $u.Enabled) { $action = 'AlreadyDisabled' }\n        else { Disable-ADAccount -Identity $n; $action = 'Disabled' }\n        [pscustomobject]@{ Time = Get-Date -Format 'yyyy-MM-ddTHH:mm:ss'; Ticket = $Ticket; Account = $n; Action = $action } | Export-Csv -Path C:\\Logs\\leavers-audit.csv -Append -NoTypeInformation\n        \"$n $action\"\n    }\n} finally {\n    Stop-Transcript | Out-Null\n}"), `& C:\\Scripts\\Disable-Leavers.ps1 -Ticket ${ticket}`, 'Import-Csv C:\\Logs\\leavers-audit.csv'],
      realityNote: 'Auditors ask "who disabled this account, when, and on whose request?"; a ticket number in an append-only log answers all three.',
    };
  }),
];
