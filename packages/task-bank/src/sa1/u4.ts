/** Unit 4: account management. */

import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { DC, PW, SECURE, addGroup, addOu, addUser, dc01, groupCheck, lab, nic, ouCheck, ouDn, ps, ran, system, tmpl, userCheck } from './kit';

const NOSPACE_DEPTS = ['Finance', 'Registry', 'Library', 'Procurement', 'Estates', 'Admissions', 'Examinations', 'Research'];

export const U4: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 4.1 user accounts, templates, profiles, home folders */
  tmpl(4, 1, 'beginner', 'create-a-user', 'Create a complete user account', 'E4', 15, 'Create one staff account with names, logon names, department and title in the right OU.', (v) => {
    const net = v.net();
    const p = v.person();
    const dept = v.pick(NOSPACE_DEPTS);
    const title = v.pick(['Administrative Assistant', 'Senior Accountant', 'Librarian', 'Records Officer', 'Procurement Officer']);
    return {
      instructions: lab({
        situation: `**${p.name}** starts in ${dept} on Monday as **${title}**. HR has approved the account. Create it in **OU=${dept},OU=Staff** with given name, surname, logon name **${p.sam}**, UPN **${p.sam}@campus.local**, department and title, enabled, with a first password the user must change at first logon.`,
        steps: [`Make the password: \`${SECURE}\`.`, 'Create the account with New-ADUser and all the attributes.', `Check it with \`Get-ADUser ${p.sam} -Properties Department,Title\`.`],
        tips: [`New-ADUser -Name "${p.name}" -GivenName ${p.given} -Surname ${p.surname} -SamAccountName ${p.sam} -UserPrincipalName ${p.sam}@campus.local -Department ${dept} -Title "..." -Path "OU=...,OU=Staff,${DC}" -AccountPassword $pw -ChangePasswordAtLogon $true -Enabled $true`],
      }),
      hints: ['Without -Enabled $true the account is created disabled.', 'Without -Path it lands in CN=Users.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); addOu(st, dept, ouDn('Staff')); } }),
      checks: [userCheck(`${p.sam} exists, enabled, in ${dept}`, { sam: p.sam, enabled: true, hasPassword: true, ou: ouDn(dept, 'Staff'), department: dept }), ps('The title is set', `(Get-ADUser ${p.sam} -Properties Title).Title`, { equals: title }), ps('The given name is set', `(Get-ADUser ${p.sam}).GivenName`, { equals: p.given }), ps('The surname is set', `(Get-ADUser ${p.sam}).Surname`, { equals: p.surname }), ps('The UPN is set', `(Get-ADUser ${p.sam}).UserPrincipalName`, { equals: `${p.sam}@campus.local` })],
      solution: [SECURE, `New-ADUser -Name "${p.name}" -GivenName ${p.given} -Surname ${p.surname} -SamAccountName ${p.sam} -UserPrincipalName ${p.sam}@campus.local -Department ${dept} -Title "${title}" -Path "${ouDn(dept, 'Staff')}" -AccountPassword $pw -ChangePasswordAtLogon $true -Enabled $true`],
      realityNote: 'Complete attributes matter: department and title drive dynamic groups, address books, HR sync and the access reviews auditors ask for.',
    };
  }),
  tmpl(4, 1, 'intermediate', 'template-account', 'Create staff from a template account', 'E4', 20, 'Copy department, groups and home folder settings from a disabled template with -Instance.', (v) => {
    const net = v.net();
    const dept = v.pick(NOSPACE_DEPTS);
    const people = v.people(3);
    const t = `_Template_${dept}`.slice(0, 20);
    return {
      instructions: lab({
        situation: `New ${dept} staff always need the same things: department **${dept}**, membership of **GG_${dept}_Staff**, and a home folder at **\\\\FS01\\Home$\\<logon name>** on drive **H:**. A disabled template account **${t}** in OU=${dept},OU=Staff holds those settings. Create ${people.map((p) => p.name).join(', ')} from it.`,
        steps: [`Load the template with its properties: \`$t = Get-ADUser ${t} -Properties Department,HomeDirectory,HomeDrive\`.`, 'Create each user with New-ADUser -Instance $t, their own names and logon name, a password, enabled.', 'Check their groups and home folders.'],
        tips: [`$t = Get-ADUser ${t} -Properties Department,HomeDirectory,HomeDrive`, SECURE, 'New-ADUser -Name "Given Surname" -GivenName G -Surname S -SamAccountName gsurname -Instance $t -AccountPassword $pw -Enabled $true'],
      }),
      hints: ['%username% in the template\'s home folder becomes each new user\'s logon name.', 'With -Instance the new user goes in the template\'s OU unless -Path says otherwise.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); const ou = addOu(st, dept, ouDn('Staff')); const tdn = addUser(st, { given: 'Template', surname: dept, name: t, sam: t }, ou, { enabled: false, hasPassword: false, department: dept, homeDirectory: '\\\\FS01\\Home$\\%username%', homeDrive: 'H:' }); addGroup(st, `GG_${dept}_Staff`, 'Global', ou, [tdn]); } }),
      checks: [userCheck(`The three users exist in ${dept}, enabled, in GG_${dept}_Staff`, { sams: people.map((p) => p.sam), enabled: true, ou: ouDn(dept, 'Staff'), department: dept, groups: [`GG_${dept}_Staff`] }), ...people.map((p) => ps(`${p.sam}'s home folder is \\\\FS01\\Home$\\${p.sam}`, `(Get-ADUser ${p.sam} -Properties HomeDirectory).HomeDirectory`, { equals: `\\\\FS01\\Home$\\${p.sam}` })), userCheck('The template stays disabled', { sam: t, enabled: false })],
      solution: [`$t = Get-ADUser ${t} -Properties Department,HomeDirectory,HomeDrive`, SECURE, ...people.map((p) => `New-ADUser -Name "${p.name}" -GivenName ${p.given} -Surname ${p.surname} -SamAccountName ${p.sam} -Instance $t -AccountPassword $pw -Enabled $true`)],
      realityNote: 'Copying a template account ("Copy..." in ADUC) is the classic way to keep new accounts consistent; templates stay disabled so nobody can log on with them.',
    };
  }),
  tmpl(4, 1, 'advanced', 'home-and-profile', 'Fix home folders and roaming profiles for a whole OU', 'E4', 25, 'Set home folders for every user in an OU in one pipeline and move profiles off a retired server.', (v) => {
    const net = v.net();
    const dept = v.pick(NOSPACE_DEPTS);
    const people = v.people(5);
    const roamers = people.slice(0, 2);
    const old = v.pick(['OLDFS', 'FS-2016', 'NAS01']);
    return {
      instructions: lab({
        situation: `The ${dept} staff were created without home folders. Policy: **HomeDirectory \\\\FS01\\Home$\\<logon name>** on **H:**. Two of them, ${roamers.map((p) => p.sam).join(' and ')}, still have roaming profiles on **${old}**, which is being switched off; their profiles must move to **\\\\FS01\\Profiles$\\<logon name>**. Nobody else should get a roaming profile.`,
        steps: [`Set the home folder for everyone in OU=${dept},OU=Staff in one pipeline (Set-ADUser accepts %username%).`, `Find the users whose ProfilePath points at ${old}.`, 'Point those profile paths at FS01.'],
        tips: [`Get-ADUser -Filter * -SearchBase "${ouDn(dept, 'Staff')}" | Set-ADUser -HomeDirectory '\\\\FS01\\Home$\\%username%' -HomeDrive H:`, `Get-ADUser -Filter * -Properties ProfilePath | Where-Object { $_.ProfilePath -like '*${old}*' }`],
      }),
      hints: ['Use single quotes around paths with $ in them, or PowerShell will read $\\ as a variable.', 'Only change ProfilePath where one is already set.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); const ou = addOu(st, dept, ouDn('Staff')); for (const p of people) addUser(st, p, ou, roamers.includes(p) ? { profilePath: `\\\\${old}\\Profiles\\${p.sam}` } : {}); } }),
      checks: [...people.map((p) => ps(`${p.sam}'s home folder is \\\\FS01\\Home$\\${p.sam}`, `(Get-ADUser ${p.sam} -Properties HomeDirectory).HomeDirectory`, { equals: `\\\\FS01\\Home$\\${p.sam}` })), ...people.map((p) => ps(`${p.sam}'s home drive is H:`, `(Get-ADUser ${p.sam} -Properties HomeDrive).HomeDrive`, { equals: 'H:' })), ...roamers.map((p) => ps(`${p.sam}'s profile is on FS01`, `(Get-ADUser ${p.sam} -Properties ProfilePath).ProfilePath`, { equals: `\\\\FS01\\Profiles$\\${p.sam}` })), ps('Nobody else got a roaming profile', `Get-ADUser -Filter * -Properties ProfilePath | Where-Object { $_.ProfilePath -ne '' } | ForEach-Object { $_.SamAccountName }`, { notContains: people.slice(2).map((p) => p.sam) }), ps(`Nothing points at ${old}`, 'Get-ADUser -Filter * -Properties ProfilePath | ForEach-Object { $_.ProfilePath }', { notContains: old })],
      solution: [`Get-ADUser -Filter * -SearchBase "${ouDn(dept, 'Staff')}" | Set-ADUser -HomeDirectory '\\\\FS01\\Home$\\%username%' -HomeDrive H:`, `Get-ADUser -Filter * -Properties ProfilePath | Where-Object { $_.ProfilePath -like '*${old}*' } | Set-ADUser -ProfilePath '\\\\FS01\\Profiles$\\%username%'`],
      realityNote: 'Bulk attribute fixes through the pipeline are routine during server migrations; the hidden $ shares keep home and profile folders out of casual browsing.',
    };
  }),

  /* ---------------------------------------------------------------- 4.2 group types, scopes and AGDLP */
  tmpl(4, 2, 'beginner', 'role-group', 'Create a role group for a department', 'E4', 15, 'Create a Global security group and fill it with a department\'s staff.', (v) => {
    const net = v.net();
    const [dept, other] = v.some(NOSPACE_DEPTS, 2);
    const staff = v.people(5).map((p, i) => ({ p, d: i < 3 ? dept : other }));
    const g = `GG_${dept}_Staff`;
    return {
      instructions: lab({
        situation: `${dept} needs a group that holds all its staff, so permissions and email lists can be given to the group instead of to people. Role groups are **Global** security groups (the G in AGDLP).`,
        steps: [`Create **${g}** as a Global security group in OU=Staff.`, `Add every user whose department is ${dept}.`, `Check with Get-ADGroupMember ${g}.`],
        tips: [`New-ADGroup -Name ${g} -GroupScope Global -GroupCategory Security -Path "${ouDn('Staff')}"`, `Get-ADUser -Filter "Department -eq '${dept}'" | ForEach-Object { Add-ADGroupMember -Identity ${g} -Members $_.SamAccountName }`],
      }),
      hints: ['Global groups hold accounts from their own domain.', 'Distribution groups cannot be used for permissions.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); for (const s of staff) addUser(st, s.p, ou, { department: s.d }); } }),
      checks: [groupCheck(`${g} is Global and holds the ${dept} staff`, g, { scope: 'Global', members: staff.filter((s) => s.d === dept).map((s) => s.p.sam) }), ps('It is a security group', `(Get-ADGroup ${g}).GroupCategory`, { equals: 'Security' }), ps('Nobody from other departments', `Get-ADGroupMember ${g} | ForEach-Object { $_.SamAccountName }`, { notContains: staff.filter((s) => s.d !== dept).map((s) => s.p.sam) })],
      solution: [`New-ADGroup -Name ${g} -GroupScope Global -GroupCategory Security -Path "${ouDn('Staff')}"`, `Get-ADUser -Filter "Department -eq '${dept}'" | ForEach-Object { Add-ADGroupMember -Identity ${g} -Members $_.SamAccountName }`],
      realityNote: 'Role groups named by a convention (GG_ for global, DL_ for domain local) make permissions readable years later.',
    };
  }),
  tmpl(4, 2, 'intermediate', 'agdlp', 'Wire up AGDLP for a shared resource', 'E4', 20, 'Create resource groups for read and modify and nest the right role groups into them.', (v) => {
    const net = v.net();
    const dept = v.pick(NOSPACE_DEPTS);
    const res = v.pick(['Budgets', 'Archive', 'Contracts', 'Reports']);
    const readers = v.pick(['GG_Internal_Audit', 'GG_Management', 'GG_Quality_Assurance']);
    const [s1, s2, a1] = v.people(3);
    return {
      instructions: lab({
        situation: `The **${res}** folder of ${dept} needs two levels of access: ${dept} staff (**GG_${dept}_Staff**) can change files, and **${readers}** can only read them. AGDLP: **A**ccounts go in **G**lobal role groups, Global groups go in **D**omain **L**ocal resource groups, and **P**ermissions are given only to the Domain Local groups.`,
        steps: [`Create **DL_${res}_Modify** and **DL_${res}_Read** as Domain Local groups in OU=Resources.`, `Nest GG_${dept}_Staff into DL_${res}_Modify, and ${readers} into DL_${res}_Read.`, `Confirm that ${s1.sam} reaches DL_${res}_Modify through nesting.`],
        tips: ['New-ADGroup -Name DL_X -GroupScope DomainLocal -Path "OU=Resources,DC=campus,DC=local"', 'Add-ADGroupMember -Identity DL_X -Members GG_Y', 'Get-ADGroupMember DL_X -Recursive'],
      }),
      hints: ['Do not add users directly to the DL groups.', 'Domain Local groups can hold Global groups; not the other way round.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); addOu(st, 'Resources'); const d1 = addUser(st, s1, ou, { department: dept }); const d2 = addUser(st, s2, ou, { department: dept }); const d3 = addUser(st, a1, ou); addGroup(st, `GG_${dept}_Staff`, 'Global', ou, [d1, d2]); addGroup(st, readers, 'Global', ou, [d3]); } }),
      checks: [groupCheck(`DL_${res}_Modify is Domain Local and contains GG_${dept}_Staff`, `DL_${res}_Modify`, { scope: 'DomainLocal', members: [`GG_${dept}_Staff`] }), groupCheck(`DL_${res}_Read is Domain Local and contains ${readers}`, `DL_${res}_Read`, { scope: 'DomainLocal', members: [readers] }), ps(`${s1.sam} reaches DL_${res}_Modify through nesting`, `Get-ADGroupMember DL_${res}_Modify -Recursive`, { contains: s1.sam }), ps('No user is added directly to a DL group', `Get-ADGroupMember DL_${res}_Modify | ForEach-Object { $_.objectClass }`, { notContains: 'user', message: 'Put users in role groups, not straight into resource groups.' }), ps(`${a1.sam} only reads`, `Get-ADGroupMember DL_${res}_Modify -Recursive`, { notContains: a1.sam })],
      solution: [`New-ADGroup -Name DL_${res}_Modify -GroupScope DomainLocal -Path "${ouDn('Resources')}"`, `New-ADGroup -Name DL_${res}_Read -GroupScope DomainLocal -Path "${ouDn('Resources')}"`, `Add-ADGroupMember -Identity DL_${res}_Modify -Members GG_${dept}_Staff`, `Add-ADGroupMember -Identity DL_${res}_Read -Members ${readers}`, `Get-ADGroupMember DL_${res}_Modify -Recursive`],
      realityNote: 'AGDLP (and AGUDLP across domains) is Microsoft\'s long-standing recommendation; it keeps ACLs short and makes access reviews a matter of reading group memberships.',
    };
  }),
  tmpl(4, 2, 'advanced', 'fix-group-scopes', 'Repair groups created with the wrong scope', 'E4', 25, 'Convert group scopes through Universal and rebuild the AGDLP nesting.', (v) => {
    const net = v.net();
    const dept = v.pick(NOSPACE_DEPTS);
    const res = v.pick(['Exams', 'Payroll', 'Admissions-Files']);
    const [a, b] = v.people(2);
    return {
      instructions: lab({
        situation: `A junior admin built ${dept}'s groups the wrong way round: **GG_${dept}_Staff** was created as **Domain Local** and **DL_${res}_Modify** as **Global**. Now GG_${dept}_Staff cannot be added to **GG_All_Academic** (a Global group), and the nesting is upside down. Fix the scopes without deleting the groups (their SIDs are already on ACLs), then nest them correctly.`,
        steps: ['Read the scopes with Get-ADGroup.', 'Convert GG_' + dept + '_Staff to Global and DL_' + res + '_Modify to Domain Local. AD only allows Global ↔ Universal ↔ Domain Local, one step at a time.', `Nest GG_${dept}_Staff into DL_${res}_Modify and into GG_All_Academic.`],
        tips: ['Set-ADGroup -Identity NAME -GroupScope Universal', 'Set-ADGroup -Identity NAME -GroupScope Global'],
      }),
      hints: ['Deleting and recreating a group gives it a new SID, which breaks every ACL that names it.', 'Domain Local → Universal → Global.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const ua = addUser(st, a, ou, { department: dept }); const ub = addUser(st, b, ou, { department: dept }); addGroup(st, `GG_${dept}_Staff`, 'DomainLocal', ou, [ua, ub]); addGroup(st, `DL_${res}_Modify`, 'Global', ou); addGroup(st, 'GG_All_Academic', 'Global', ou); } }),
      checks: [groupCheck(`GG_${dept}_Staff is Global`, `GG_${dept}_Staff`, { scope: 'Global', memberOf: [`DL_${res}_Modify`, 'GG_All_Academic'] }), groupCheck(`DL_${res}_Modify is Domain Local`, `DL_${res}_Modify`, { scope: 'DomainLocal' }), ps('The group kept its members (it was not recreated)', `Get-ADGroupMember GG_${dept}_Staff`, { contains: [a.sam, b.sam] })],
      solution: [`Set-ADGroup -Identity GG_${dept}_Staff -GroupScope Universal`, `Set-ADGroup -Identity GG_${dept}_Staff -GroupScope Global`, `Set-ADGroup -Identity DL_${res}_Modify -GroupScope Universal`, `Set-ADGroup -Identity DL_${res}_Modify -GroupScope DomainLocal`, `Add-ADGroupMember -Identity DL_${res}_Modify -Members GG_${dept}_Staff`, `Add-ADGroupMember -Identity GG_All_Academic -Members GG_${dept}_Staff`],
      realityNote: 'Scope conversion through Universal is a real AD rule; knowing it saves recreating groups and breaking ACLs.',
    };
  }),

  /* ---------------------------------------------------------------- 4.3 computer and service accounts */
  tmpl(4, 3, 'beginner', 'prestage-computers', 'Pre-stage computer accounts for a new lab', 'E4', 15, 'Create computer accounts in the lab OU before the PCs are imaged.', (v) => {
    const net = v.net();
    const room = `LAB${v.int(1, 9)}`;
    const n = v.int(4, 7);
    const names = Array.from({ length: n }, (_, i) => `${room}-${String(i + 1).padStart(2, '0')}`);
    return {
      instructions: lab({
        situation: `${n} PCs for teaching lab **${room}** arrive tomorrow and will be imaged over the network. Pre-stage their computer accounts **${names[0]}** to **${names[n - 1]}** in **OU=${room},OU=Labs** so they pick up the lab policy as soon as they join.`,
        steps: [`Create the ${room} OU under OU=Labs.`, 'Create the computer accounts there, ideally from a list in one pipeline.', `Check with Get-ADComputer -Filter * -SearchBase "OU=${room},OU=Labs,${DC}".`],
        tips: [`'${names[0]}','${names[1]}' | ForEach-Object { New-ADComputer -Name $_ -Path "OU=${room},OU=Labs,${DC}" }`],
      }),
      hints: ['Computer names: up to 15 letters, digits and hyphens.', 'A pre-staged account is used by the PC with the same name when it joins.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Labs'); } }),
      checks: [ouCheck(`OU=${room} exists under Labs`, ouDn(room, 'Labs')), ps(`All ${n} accounts are in the ${room} OU`, `(Get-ADComputer -Filter * -SearchBase "${ouDn(room, 'Labs')}" | Measure-Object).Count`, { equals: String(n) }), ...[names[0], names[n - 1]].map((c) => ps(`${c} exists`, `(Get-ADComputer -Identity ${c}).DistinguishedName`, { equals: `CN=${c},${ouDn(room, 'Labs')}` }))],
      solution: [`New-ADOrganizationalUnit -Name ${room} -Path "${ouDn('Labs')}"`, `${names.map((c) => `'${c}'`).join(',')} | ForEach-Object { New-ADComputer -Name $_ -Path "${ouDn(room, 'Labs')}" }`],
      realityNote: 'Pre-staging lets deployment tools (WDS, MDT, Configuration Manager) join machines straight into the right OU without giving installers rights to create accounts anywhere.',
    };
  }),
  tmpl(4, 3, 'intermediate', 'gmsa', 'Run a service as a group managed service account', 'E4', 25, 'Create a KDS root key and a gMSA for a web farm and install it on a server.', (v) => {
    const net = v.net();
    const app = v.pick(['web', 'lms', 'portal', 'api']);
    const gmsa = `gmsa-${app}`;
    const [w1, w2] = [`${app.toUpperCase()}01`, `${app.toUpperCase()}02`];
    return {
      instructions: lab({
        situation: `The ${app} application pool on ${w1} and ${w2} runs as a normal user account whose password has not changed since 2019. A **group managed service account** (gMSA) has a 240-character password that the domain rotates automatically and that only the allowed servers can retrieve.`,
        steps: ['Create the KDS root key (in a lab, backdate it 10 hours so it works at once).', `Put ${w1} and ${w2} in a group **GG_${app.toUpperCase()}_Servers**.`, `Create **${gmsa}** allowed to that group, with DNS host name ${gmsa}.campus.local.`, `Install it on ${w1} and test it.`],
        tips: ['Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10))', `New-ADServiceAccount -Name ${gmsa} -DNSHostName ${gmsa}.campus.local -PrincipalsAllowedToRetrieveManagedPassword GG_${app.toUpperCase()}_Servers`, `Invoke-Command -ComputerName ${w1} -ScriptBlock { Install-ADServiceAccount ${gmsa}; Test-ADServiceAccount ${gmsa} }`],
      }),
      hints: ['Computer accounts are added to groups by name (with or without the $).', 'Test-ADServiceAccount returns True only on a server that can use the account.'],
      initialState: system({ machines: [dc01(net), { name: w1, features: ['Web-Server'], nics: [nic(`${net}.31`, net)] }, { name: w2, features: ['Web-Server'], nics: [nic(`${net}.32`, net)] }] }),
      checks: [ps(`${gmsa} exists`, `(Get-ADServiceAccount ${gmsa}).DNSHostName`, { equals: `${gmsa}.campus.local` }), groupCheck(`GG_${app.toUpperCase()}_Servers is a group`, `GG_${app.toUpperCase()}_Servers`), ps(`${w1} can use ${gmsa}`, `Test-ADServiceAccount ${gmsa}`, { machine: w1, equals: 'True' }), ps(`${w2} is in GG_${app.toUpperCase()}_Servers`, `Get-ADGroupMember GG_${app.toUpperCase()}_Servers`, { contains: w2 })],
      solution: ['Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10))', `New-ADGroup -Name GG_${app.toUpperCase()}_Servers -GroupScope Global`, `Add-ADGroupMember -Identity GG_${app.toUpperCase()}_Servers -Members ${w1}$,${w2}$`, `New-ADServiceAccount -Name ${gmsa} -DNSHostName ${gmsa}.campus.local -PrincipalsAllowedToRetrieveManagedPassword GG_${app.toUpperCase()}_Servers`, `Invoke-Command -ComputerName ${w1} -ScriptBlock { Install-ADServiceAccount ${gmsa}; Test-ADServiceAccount ${gmsa} }`],
      realityNote: 'gMSAs remove the "service account password never changes" finding from audits; IIS, SQL Server and scheduled tasks all support them.',
    };
  }),
  tmpl(4, 3, 'advanced', 'stale-computers', 'Retire and remove stale computer accounts', 'E4', 25, 'Process an asset register: disable and park retired machines, delete destroyed ones, leave the rest.', (v) => {
    const net = v.net();
    const all = Array.from({ length: 8 }, (_, i) => `OFF-PC${String(v.int(10, 99)).padStart(2, '0')}${i}`);
    const retired = all.slice(0, 3);
    const destroyed = all.slice(3, 5);
    const active = all.slice(5);
    const csv = ['Name,Status', ...retired.map((n) => `${n},Retired`), ...destroyed.map((n) => `${n},Destroyed`), ...active.map((n) => `${n},Active`)].join('\n') + '\n';
    return {
      instructions: lab({
        situation: 'The asset register in **C:\\Assets\\pcs.csv** lists office PCs by status. Process it:\n\n- **Retired** PCs may come back after repair: disable their accounts and move them to **OU=Disabled-Computers**.\n- **Destroyed** PCs are gone for good: delete their accounts.\n- **Active** PCs must not be touched.',
        steps: ['Read the CSV and look at the statuses.', 'Handle the Retired rows with one pipeline (Where-Object, then Disable-ADAccount and Move-ADObject).', 'Handle the Destroyed rows with Remove-ADComputer.'],
        tips: ["Import-Csv C:\\Assets\\pcs.csv | Where-Object { $_.Status -eq 'Retired' } | ForEach-Object { ... }", 'Disable-ADAccount -Identity NAME$', 'Move-ADObject -Identity NAME -TargetPath "OU=..."'],
      }),
      hints: ['Disable-ADAccount works for computer accounts too.', 'Deleting is permanent unless the Recycle Bin is on: be sure of the rows.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Offices'); addOu(st, 'Disabled-Computers'); for (const n of all) st.computers.push({ name: n, dn: `CN=${n},${ou}`, enabled: true, os: 'Windows 11 Pro', dnsHostName: `${n.toLowerCase()}.campus.local` }); }, files: { 'C:\\Assets\\pcs.csv': csv } }),
      checks: [...retired.flatMap((n) => [ps(`${n} is disabled`, `(Get-ADComputer ${n}).Enabled`, { equals: 'False' }), ps(`${n} is in OU=Disabled-Computers`, `(Get-ADComputer ${n}).DistinguishedName`, { equals: `CN=${n},${ouDn('Disabled-Computers')}` })]), ps('The destroyed PCs are deleted', 'Get-ADComputer -Filter * | ForEach-Object { $_.Name }', { notContains: destroyed }), ...active.map((n) => ps(`${n} is untouched`, `(Get-ADComputer ${n}).DistinguishedName`, { equals: `CN=${n},${ouDn('Offices')}` }))],
      solution: ["Import-Csv C:\\Assets\\pcs.csv | Where-Object { $_.Status -eq 'Retired' } | ForEach-Object { Disable-ADAccount -Identity $_.Name; Move-ADObject -Identity $_.Name -TargetPath \"" + ouDn('Disabled-Computers') + '" }', "Import-Csv C:\\Assets\\pcs.csv | Where-Object { $_.Status -eq 'Destroyed' } | ForEach-Object { Remove-ADComputer -Identity $_.Name }"],
      realityNote: 'Stale computer accounts are an audit finding and an attack surface; most organisations disable first, park in an OU for 30 to 90 days, then delete.',
    };
  }),

  /* ---------------------------------------------------------------- 4.4 bulk creation and offboarding */
  tmpl(4, 4, 'beginner', 'csv-bulk', 'Create a class of students from a CSV', 'E4', 15, 'Use Import-Csv and New-ADUser to create every student in a file.', (v) => {
    const net = v.net();
    const n = v.int(5, 8);
    const studs = v.people(n);
    const prog = v.pick(['BSc-CS', 'BTech-IT', 'HND-CS', 'BSc-IS']);
    const csv = ['GivenName,Surname,SamAccountName', ...studs.map((p) => `${p.given},${p.surname},${p.sam}`)].join('\n') + '\n';
    return {
      instructions: lab({
        situation: `Admissions sent **C:\\Intake\\${prog}.csv** with ${n} new ${prog} students. Create them all in **OU=${prog},OU=Students**, named "GivenName Surname", enabled, with the first password **${PW}**.`,
        steps: ['Look at the file with Import-Csv.', `Make the password once: \`${SECURE}\`.`, 'Create every row in one pipeline.'],
        tips: [`Import-Csv C:\\Intake\\${prog}.csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -Path "..." -AccountPassword $pw -Enabled $true }`],
      }),
      hints: ['Inside ForEach-Object, $_ is the current row.', 'Write "$($_.GivenName) $($_.Surname)" for the full name inside a string.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Students'); addOu(st, prog, ouDn('Students')); }, files: { [`C:\\Intake\\${prog}.csv`]: csv } }),
      checks: [userCheck(`All ${n} students exist, enabled, in ${prog}`, { sams: studs.map((p) => p.sam), enabled: true, hasPassword: true, ou: ouDn(prog, 'Students') }), ps('Names are "GivenName Surname"', `(Get-ADUser ${studs[0].sam}).Name`, { equals: studs[0].name }), ran('You used Import-Csv', 'Import-Csv')],
      solution: [SECURE, `Import-Csv C:\\Intake\\${prog}.csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -Path "${ouDn(prog, 'Students')}" -AccountPassword $pw -Enabled $true }`],
      realityNote: 'Every September universities create thousands of accounts this way, usually from an export of the student records system.',
    };
  }),
  tmpl(4, 4, 'intermediate', 'csv-departments', 'Onboard staff into their departments from HR\'s file', 'E4', 25, 'Place each CSV row in its department OU and group, with must-change passwords.', (v) => {
    const net = v.net();
    const depts = v.some(NOSPACE_DEPTS, 2);
    const people = v.people(6).map((p, i) => ({ p, d: depts[i % 2], t: v.pick(['Officer', 'Assistant', 'Clerk', 'Coordinator']) }));
    const csv = ['GivenName,Surname,SamAccountName,Department,Title', ...people.map((x) => `${x.p.given},${x.p.surname},${x.p.sam},${x.d},${x.t}`)].join('\n') + '\n';
    return {
      instructions: lab({
        situation: `HR's file **C:\\HR\\new-staff.csv** has new staff for ${depts.join(' and ')}. Each person must land in **OU=<Department>,OU=Staff**, with Department and Title set, in their role group **GG_<Department>_Staff**, enabled, and forced to change the first password at logon.`,
        steps: ['Read the file.', 'In one ForEach-Object: create the user in the OU built from the row\'s department, then add them to the group built from it.', 'Check a user from each department.'],
        tips: ['-Path "OU=$($_.Department),OU=Staff,DC=campus,DC=local"', 'Add-ADGroupMember -Identity "GG_$($_.Department)_Staff" -Members $_.SamAccountName', '-ChangePasswordAtLogon $true'],
      }),
      hints: ['Two commands inside one script block are separated by a semicolon.', 'Build OU and group names from the row with $( ) inside double quotes.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); for (const d of depts) { const ou = addOu(st, d, ouDn('Staff')); addGroup(st, `GG_${d}_Staff`, 'Global', ou); } }, files: { 'C:\\HR\\new-staff.csv': csv } }),
      checks: [...depts.map((d) => userCheck(`${d} staff are in their OU and group`, { sams: people.filter((x) => x.d === d).map((x) => x.p.sam), enabled: true, ou: ouDn(d, 'Staff'), department: d, groups: [`GG_${d}_Staff`] })), ps('Titles are set', `(Get-ADUser ${people[0].p.sam} -Properties Title).Title`, { equals: people[0].t })],
      solution: [SECURE, `Import-Csv C:\\HR\\new-staff.csv | ForEach-Object { New-ADUser -Name "$($_.GivenName) $($_.Surname)" -GivenName $_.GivenName -Surname $_.Surname -SamAccountName $_.SamAccountName -Department $_.Department -Title $_.Title -Path "OU=$($_.Department),${ouDn('Staff')}" -AccountPassword $pw -ChangePasswordAtLogon $true -Enabled $true; Add-ADGroupMember -Identity "GG_$($_.Department)_Staff" -Members $_.SamAccountName }`],
      realityNote: 'Joiner processes driven by an HR feed are the first step of identity lifecycle management; products like Microsoft Identity Manager automate the same logic.',
    };
  }),
  tmpl(4, 4, 'advanced', 'offboarding', 'Offboard leavers from HR\'s list', 'E4', 30, 'Disable, annotate, strip groups and park every leaver, without touching anyone else.', (v) => {
    const net = v.net();
    const dept = v.pick(NOSPACE_DEPTS);
    const people = v.people(6);
    const leavers = people.slice(0, 3);
    const days = leavers.map(() => `2026-10-${String(v.int(1, 21)).padStart(2, '0')}`);
    const csv = ['SamAccountName,LastDay', ...leavers.map((p, i) => `${p.sam},${days[i]}`)].join('\n') + '\n';
    return {
      instructions: lab({
        situation: `HR's leavers list is **C:\\HR\\leavers.csv**. For each leaver, the offboarding standard says:\n\n1. Disable the account (never delete: mail and files must be handed over).\n2. Set its Description to **Left <LastDay>**.\n3. Remove it from every group except Domain Users.\n4. Move it to **OU=Leavers**.\n\nThe other ${dept} staff must be untouched.`,
        steps: ['Read the file.', 'Loop over the rows with foreach ($l in Import-Csv ...) { ... } so $l stays the row while $_ is used inside pipelines.', 'Check each leaver\'s groups, description and location.'],
        tips: ['foreach ($l in Import-Csv C:\\HR\\leavers.csv) { Disable-ADAccount -Identity $l.SamAccountName; ... }', "Get-ADPrincipalGroupMembership SAM | Where-Object { $_.Name -ne 'Domain Users' } | ForEach-Object { Remove-ADGroupMember -Identity $_.Name -Members SAM }", 'Move-ADObject -Identity (Get-ADUser SAM).DistinguishedName -TargetPath "OU=Leavers,DC=campus,DC=local"'],
      }),
      hints: ['Inside a nested pipeline, $_ is the group, not the leaver: that is why the loop variable $l helps.', 'Domain Users is the primary group; it cannot be removed.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Leavers'); const ou = addOu(st, dept, addOu(st, 'Staff')); const dns = people.map((p) => addUser(st, p, ou, { department: dept })); addGroup(st, `GG_${dept}_Staff`, 'Global', ou, dns); addGroup(st, 'GG_VPN_Users', 'Global', ou, [dns[0], dns[2], dns[4]]); addGroup(st, `DL_${dept}_Share_Modify`, 'DomainLocal', ou, [dns[1]]); }, files: { 'C:\\HR\\leavers.csv': csv } }),
      checks: [userCheck('Every leaver is disabled and in OU=Leavers', { sams: leavers.map((p) => p.sam), enabled: false, ou: ouDn('Leavers') }), ...leavers.map((p, i) => ps(`${p.sam}'s description says Left ${days[i]}`, `(Get-ADUser ${p.sam} -Properties Description).Description`, { equals: `Left ${days[i]}` })), ...leavers.map((p) => ps(`${p.sam} is only in Domain Users`, `(Get-ADPrincipalGroupMembership ${p.sam}).Name`, { equals: 'Domain Users' })), userCheck('The remaining staff are untouched', { sams: people.slice(3).map((p) => p.sam), enabled: true, ou: ouDn(dept, 'Staff'), groups: [`GG_${dept}_Staff`] })],
      solution: [`foreach ($l in Import-Csv C:\\HR\\leavers.csv) { Disable-ADAccount -Identity $l.SamAccountName; Set-ADUser -Identity $l.SamAccountName -Description "Left $($l.LastDay)"; Get-ADPrincipalGroupMembership $l.SamAccountName | Where-Object { $_.Name -ne 'Domain Users' } | ForEach-Object { Remove-ADGroupMember -Identity $_.Name -Members $l.SamAccountName }; Move-ADObject -Identity (Get-ADUser $l.SamAccountName).DistinguishedName -TargetPath "${ouDn('Leavers')}" }`],
      realityNote: 'Leaver accounts that stay enabled, or keep VPN and share groups, are among the most common audit findings; a scripted offboarding closes them the day HR sends the list.',
    };
  }),
];

export { caseStudy };
