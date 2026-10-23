/** Unit 2: Active Directory introduction and design. */

import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { DC, addGroup, addOu, addUser, bare, dc01, dcN, lab, nic, ouCheck, ouDn, ps, ran, system, tmpl, userCheck } from './kit';

export const U2: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 2.1 directory services and LDAP */
  tmpl(2, 1, 'beginner', 'ldap-query', 'Answer a question with an LDAP filter', 'E4', 15, 'Write an LDAP filter that finds the users of one department and save the result.', (v) => {
    const net = v.net();
    const [want, ...others] = v.depts(3);
    const staff = v.people(8).map((p, i) => ({ p, dept: i < 3 ? want : others[i % 2] }));
    const file = `C:\\Answers\\${want.replace(/ /g, '')}.txt`;
    return {
      instructions: lab({
        situation: `The ${want} office wants a list of its staff accounts for an access review. Directory queries speak **LDAP**, and the AD cmdlets accept LDAP filters directly. Find every user whose **department** is **${want}** and save their logon names (SamAccountName).`,
        steps: [`Write the filter: \`(department=${want})\`. An LDAP filter is always in parentheses: (attribute=value).`, `Run it: \`Get-ADUser -LDAPFilter "(department=${want})"\`.`, `Save just the logon names to **${file}**, one per line.`],
        tips: ['Get-ADUser -LDAPFilter "(attribute=value)" | ForEach-Object { $_.SamAccountName }', '... | Set-Content C:\\Answers\\file.txt'],
      }),
      hints: ['(department=Finance) matches the department attribute exactly; * works as a wildcard.', 'Pipe the users to ForEach-Object { $_.SamAccountName } and then to Set-Content.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); for (const s of staff) addUser(st, s.p, ou, { department: s.dept }); }, files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' } }),
      checks: [
        ps(`Every ${want} account is listed`, `Get-Content ${file}`, { contains: staff.filter((s) => s.dept === want).map((s) => s.p.sam), message: `${file} is missing some ${want} accounts.` }),
        ps('No one from other departments is listed', `Get-Content ${file}`, { notContains: staff.filter((s) => s.dept !== want).map((s) => s.p.sam), message: 'The file lists people from other departments: check the filter.' }),
        ran('You used an LDAP filter', 'LDAPFilter'),
      ],
      solution: [`Get-ADUser -LDAPFilter "(department=${want})" | ForEach-Object { $_.SamAccountName } | Set-Content ${file}`],
      realityNote: 'LDAP filters are the common language of directory tools: AD cmdlets, ldapsearch, application login settings and identity sync tools all use the same syntax.',
    };
  }),
  tmpl(2, 1, 'intermediate', 'ldap-bitwise', 'Find disabled accounts with a bitwise LDAP filter', 'E4', 20, 'Combine a bitwise userAccountControl filter with a search base to report disabled students.', (v) => {
    const net = v.net();
    const students = v.people(7);
    const staff = v.people(4);
    const off = new Set(v.some(students.map((s) => s.sam), 3));
    const staffOff = v.pick(staff).sam;
    const file = 'C:\\Answers\\disabled-students.txt';
    return {
      instructions: lab({
        situation: `Registry asks how many **student** accounts are disabled. Disabled is not a simple attribute: it is bit 2 of **userAccountControl**. The LDAP matching rule **1.2.840.113556.1.4.803** tests a bit ("bitwise AND"). Students live in **OU=Students**; staff accounts (some also disabled) must not be counted.`,
        steps: ['Build the filter: `(userAccountControl:1.2.840.113556.1.4.803:=2)`.', `Limit the search to students with \`-SearchBase "OU=Students,${DC}"\`.`, `Save the logon names to **${file}**.`],
        tips: ['Get-ADUser -LDAPFilter "..." -SearchBase "OU=...,DC=campus,DC=local"', 'Combine filters: (&(objectCategory=person)(...))'],
      }),
      hints: ['userAccountControl 514 = 512 (normal account) + 2 (disabled).', 'Without -SearchBase the staff account is counted too.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const so = addOu(st, 'Students'); const to = addOu(st, 'Staff'); for (const s of students) addUser(st, s, so, { enabled: !off.has(s.sam) }); for (const s of staff) addUser(st, s, to, { enabled: s.sam !== staffOff }); }, files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' } }),
      checks: [
        ps('Every disabled student is listed', `Get-Content ${file}`, { contains: [...off] }),
        ps('Enabled students are not listed', `Get-Content ${file}`, { notContains: students.filter((s) => !off.has(s.sam)).map((s) => s.sam), message: 'Some listed students are enabled: test the disabled bit, not just objectClass.' }),
        ps('Staff are not listed', `Get-Content ${file}`, { notContains: [staffOff], message: `${staffOff} is a disabled staff account: limit the search base to the Students OU.` }),
        ran('You used the bitwise matching rule', '1\\.2\\.840\\.113556\\.1\\.4\\.803'),
      ],
      solution: [`Get-ADUser -LDAPFilter "(userAccountControl:1.2.840.113556.1.4.803:=2)" -SearchBase "OU=Students,${DC}" | ForEach-Object { $_.SamAccountName } | Set-Content ${file}`],
      realityNote: 'Bitwise filters on userAccountControl are how audit scripts find disabled, password-not-required or never-expiring accounts in one query.',
    };
  }),
  tmpl(2, 1, 'advanced', 'forest-design', 'Design forests, domains, trusts and catalogue placement', 'E10', 20, 'Decide forest and domain boundaries, trusts and global catalogue placement for merging institutions.', (v) => {
    const city = v.city();
    const partner = v.pick(['a teaching hospital', 'a nursing college', 'a research institute']);
    const app = v.pick(['the student portal', 'the library system', 'the HR system']);
    return caseStudy(v, {
      intro: `## Two directories, one campus\n\nThe university is taking over ${partner} in ${city}. The hospital-side IT team runs its own Active Directory forest (**health.local**) and must keep separate control of it for regulatory reasons. Users on both sides need some shared resources.`,
      steps: [
        { title: 'Security boundary', text: 'The partner insists that no university administrator can ever gain control of its directory. What gives that guarantee?', choices: [
          { text: 'Keep a separate forest: the forest is the security boundary', right: true, feedback: 'Correct. Enterprise Admins of one forest have no rights in another.' },
          { text: 'Make it a child domain in the university forest', feedback: 'Domains in one forest trust each other and share Enterprise Admins: a domain is not a security boundary.' },
          { text: 'Put the partner in its own OU', feedback: 'OUs are for delegation and Group Policy; Domain Admins still control them.' },
        ] },
        { title: 'Sharing resources', text: `University staff need to open files on a health.local server, and hospital staff need ${app}. Which trust?`, choices: [
          { text: 'A two-way forest trust with selective authentication', right: true, feedback: 'Correct. Both sides can grant access, and selective authentication limits who can authenticate to which servers.' },
          { text: 'An external trust in one direction only', feedback: 'One direction serves only one of the two needs.' },
          { text: 'Copy every user account into both forests', feedback: 'Duplicate accounts drift apart and double the passwords to manage.' },
        ] },
        { title: 'Trust direction', text: 'For university users to reach health.local servers, which way must trust flow?', choices: [
          { text: 'health.local (resources) trusts campus.local (accounts)', right: true, feedback: 'Correct. The resource side trusts the account side; access goes the opposite way to trust.' },
          { text: 'campus.local trusts health.local', feedback: 'That lets health.local users reach campus resources: the opposite of what is needed here.' },
          { text: 'Direction does not matter for a forest trust', feedback: 'Every trust has a trusting (resource) side and a trusted (account) side.' },
        ] },
        { title: 'Global catalogue', text: `The ${city} site has 300 users and one domain controller, over a slow link to the main campus. Should it be a global catalogue?`, choices: [
          { text: 'Yes: logons need a GC for universal group membership, so make the site DC a GC', right: true, feedback: 'Correct. With only one domain, making every DC a GC has almost no cost and keeps logons local.' },
          { text: 'No: one GC per forest is enough', feedback: 'Then every logon at the site would cross the slow link to find a GC.' },
          { text: 'No: GCs only matter for Exchange', feedback: 'Logons, UPN logons and universal group lookups all use the GC.' },
        ] },
        { title: 'Directory traffic', text: 'A third-party application will query the directory. Which ports should the firewall allow to the DC?', choices: [
          { text: 'LDAPS on 636 (or 3269 for the GC), and not plain LDAP on 389 from outside', right: true, feedback: 'Correct. LDAPS encrypts the bind credentials.' },
          { text: 'LDAP on 389 is fine because it is internal', feedback: 'Plain LDAP simple binds send passwords in clear text.' },
          { text: 'Open all ports to the DC from that server', feedback: 'Domain controllers deserve the tightest filtering on the network.' },
        ] },
      ],
      ending: { title: 'Design approved', text: 'Separate forests, a two-way forest trust with selective authentication, a GC at every site and LDAPS for applications.' },
      hints: ['The forest, not the domain, is the security boundary.', 'Trust points from the resource side to the account side.', 'In a single-domain forest, make every DC a global catalogue.'],
      realityNote: 'Mergers and partnerships are the most common reason for forest trusts; Microsoft\'s AD design guidance treats the forest as the only true security boundary.',
    });
  }),

  /* ---------------------------------------------------------------- 2.2 DCs, FSMO, replication, sites */
  tmpl(2, 2, 'beginner', 'who-holds-fsmo', 'Find out which DC holds each FSMO role', 'E4', 10, 'Use netdom and the AD cmdlets to record the five operations master role holders.', (v) => {
    const net = v.net();
    const roles = ['SchemaMaster', 'DomainNamingMaster', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster'] as const;
    const holder = Object.fromEntries(roles.map((r) => [r, v.pick(['DC01', 'DC02'])])) as Record<(typeof roles)[number], string>;
    if (Object.values(holder).every((h) => h === 'DC01')) holder.PDCEmulator = 'DC02';
    const file = 'C:\\Answers\\fsmo.txt';
    return {
      instructions: lab({
        situation: 'Before DC maintenance this weekend you must know which domain controller holds each of the five **FSMO** (operations master) roles. Record them so the change plan can say which DC must not be down for long.',
        steps: ['Run `netdom query fsmo`, or read `Get-ADDomain` (PDC, RID, Infrastructure) and `Get-ADForest` (Schema, Domain naming).', `Write **${file}** with one line per role, exactly in the form \`PDCEmulator: DC02\`, using the names SchemaMaster, DomainNamingMaster, PDCEmulator, RIDMaster and InfrastructureMaster.`],
        tips: ['netdom query fsmo', 'Set-Content C:\\Answers\\fsmo.txt "SchemaMaster: DC01","..."'],
      }),
      hints: ['Two roles are forest-wide (Schema, Domain naming); three are per domain.', 'The PDC emulator is also the time source for the domain.'],
      initialState: system({ machines: [dc01(net), dcN(net)], ad: (st) => { st.fsmo = { ...holder }; st.sites[0].dcs.push('DC02'); }, files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' } }),
      checks: roles.map((r) => ps(`${r} is recorded`, `Get-Content ${file}`, { contains: `${r}: ${holder[r]}`, message: `Record the ${r} holder as "${r}: DCxx".` })),
      solution: ['netdom query fsmo', `Set-Content ${file} ${roles.map((r) => `"${r}: ${holder[r]}"`).join(',')}`],
      realityNote: 'Knowing the FSMO holders matters before patching: losing the PDC emulator for long breaks password changes and time sync, and the RID master hands out the pools that new accounts need.',
    };
  }),
  tmpl(2, 2, 'intermediate', 'branch-site', 'Create a site so a branch uses its own DC', 'E4', 20, 'Create a site and subnets and move a DC so branch logons stay local.', (v) => {
    const net = v.net();
    const branch = v.net();
    const city = v.city().replace(/ /g, '');
    const dc = `${city.slice(0, 3).toUpperCase()}-DC01`;
    return {
      instructions: lab({
        situation: `The ${city} branch (network **${branch}.0/24**) has its own domain controller, **${dc}**, but every logon there still goes over the WAN to the main campus. Active Directory only knows a branch exists if there is a **site** with the branch's **subnet**. The main campus is **${net}.0/24**.`,
        steps: [`Create the site **${city}**.`, `Create the subnet ${branch}.0/24 in site ${city}, and ${net}.0/24 in Default-First-Site-Name.`, `Move ${dc} into the ${city} site.`, 'Check with Get-ADReplicationSite and Get-ADDomainController.'],
        tips: ['New-ADReplicationSite -Name NAME', 'New-ADReplicationSubnet -Name "10.1.2.0/24" -Site NAME', 'Move-ADDirectoryServer -Identity DC -Site NAME'],
      }),
      hints: ['Clients pick a DC in the site that matches their subnet.', 'Subnet names are network/prefix, for example 10.20.30.0/24.'],
      initialState: system({ machines: [dc01(net), dcN(branch, dc, 10, 'Default-First-Site-Name', { nics: [nic(`${branch}.10`, branch, { dns: [`${net}.10`] })] })], ad: (st) => { st.sites[0].dcs.push(dc); } }),
      checks: [
        ps(`The ${city} site holds ${branch}.0/24`, `(Get-ADReplicationSubnet | Where-Object { $_.Name -eq '${branch}.0/24' }).Site`, { equals: city }),
        ps(`The main campus subnet is in Default-First-Site-Name`, `(Get-ADReplicationSubnet | Where-Object { $_.Name -eq '${net}.0/24' }).Site`, { equals: 'Default-First-Site-Name' }),
        ps(`${dc} is in the ${city} site`, `(Get-ADDomainController -Identity ${dc}).Site`, { equals: city }),
        ps('DC01 stays in the main site', '(Get-ADDomainController -Identity DC01).Site', { equals: 'Default-First-Site-Name' }),
      ],
      solution: [`New-ADReplicationSite -Name ${city}`, `New-ADReplicationSubnet -Name "${branch}.0/24" -Site ${city}`, `New-ADReplicationSubnet -Name "${net}.0/24" -Site Default-First-Site-Name`, `Move-ADDirectoryServer -Identity ${dc} -Site ${city}`],
      realityNote: 'Sites and subnets drive DC location, replication schedules and DFS referrals; missing subnets are a classic cause of slow branch logons.',
    };
  }),
  tmpl(2, 2, 'advanced', 'retire-a-dc', 'Move the FSMO roles off a DC that is being retired', 'E4', 25, 'Plan and transfer forest-wide and domain-wide roles to the right DCs before decommissioning.', (v) => {
    const net = v.net();
    const [domainDc, forestDc] = v.pick([['DC02', 'DC03'], ['DC03', 'DC02']]);
    return {
      instructions: lab({
        situation: `**DC01** is old hardware and will be demoted next week. It holds every FSMO role. The design says: the three **domain-wide** roles (PDCEmulator, RIDMaster, InfrastructureMaster) go to **${domainDc}**, which is in the server room with the best uptime; the two **forest-wide** roles (SchemaMaster, DomainNamingMaster) go to **${forestDc}**.`,
        steps: ['Confirm the current holders with netdom query fsmo.', 'Transfer the roles with Move-ADDirectoryServerOperationMasterRole (a graceful transfer, not a seizure: DC01 is still online).', 'Confirm that DC01 holds nothing.'],
        tips: ['Move-ADDirectoryServerOperationMasterRole -Identity DC -OperationMasterRole Role1,Role2', 'Get-ADDomain | Format-List PDCEmulator,RIDMaster,InfrastructureMaster', 'Get-ADForest | Format-List SchemaMaster,DomainNamingMaster'],
      }),
      hints: ['Seizing (-Force) is only for a DC that will never come back.', 'Several roles can be moved in one command, separated by commas.'],
      initialState: system({ machines: [dc01(net), dcN(net, 'DC02', 11), dcN(net, 'DC03', 12)], ad: (st) => { st.sites[0].dcs.push('DC02', 'DC03'); } }),
      checks: [
        ps(`PDCEmulator is on ${domainDc}`, '(Get-ADDomain).PDCEmulator', { equals: `${domainDc}.campus.local` }),
        ps(`RIDMaster is on ${domainDc}`, '(Get-ADDomain).RIDMaster', { equals: `${domainDc}.campus.local` }),
        ps(`InfrastructureMaster is on ${domainDc}`, '(Get-ADDomain).InfrastructureMaster', { equals: `${domainDc}.campus.local` }),
        ps(`SchemaMaster is on ${forestDc}`, '(Get-ADForest).SchemaMaster', { equals: `${forestDc}.campus.local` }),
        ps(`DomainNamingMaster is on ${forestDc}`, '(Get-ADForest).DomainNamingMaster', { equals: `${forestDc}.campus.local` }),
        ps('DC01 holds no role', 'netdom query fsmo', { notContains: 'DC01.campus.local' }),
      ],
      solution: ['netdom query fsmo', `Move-ADDirectoryServerOperationMasterRole -Identity ${domainDc} -OperationMasterRole PDCEmulator,RIDMaster,InfrastructureMaster`, `Move-ADDirectoryServerOperationMasterRole -Identity ${forestDc} -OperationMasterRole SchemaMaster,DomainNamingMaster`],
      realityNote: 'Transferring roles before demotion is part of every DC decommissioning runbook; seizing is the emergency path when the old holder has died.',
    };
  }),

  /* ---------------------------------------------------------------- 2.3 OUs, delegation, naming */
  tmpl(2, 3, 'beginner', 'faculty-ous', 'Create the OUs for a faculty', 'E4', 15, 'Create a faculty OU with child OUs for staff, students and computers.', (v) => {
    const net = v.net();
    const fac = v.faculties(1)[0];
    const kids = ['Staff', 'Students', 'Computers'];
    return {
      instructions: lab({
        situation: `The Faculty of **${fac}** is moving onto the domain. The naming standard says each faculty gets a top-level OU named after it, with three child OUs: **Staff**, **Students** and **Computers**, so Group Policy and delegation can target each kind of object.`,
        steps: [`Create **OU=${fac}** at the top of the domain.`, 'Create the three child OUs inside it.', 'Keep "protect from accidental deletion" on (the default).', `Check with \`Get-ADOrganizationalUnit -Filter * -SearchBase "OU=${fac},${DC}"\`.`],
        tips: [`New-ADOrganizationalUnit -Name "${fac}" -Path "${DC}"`, `New-ADOrganizationalUnit -Name Staff -Path "OU=${fac},${DC}"`],
      }),
      hints: ['-Path is the DN of the parent container.', 'Names with spaces need quotes.'],
      initialState: system({ machines: [dc01(net)] }),
      checks: [ouCheck(`OU=${fac} exists`, ouDn(fac)), ...kids.map((k) => ouCheck(`${k} is inside ${fac}`, ouDn(k, fac))), ps('The OUs are protected from accidental deletion', `(Get-ADOrganizationalUnit -Identity "${ouDn(fac)}").ProtectedFromAccidentalDeletion`, { equals: 'True' })],
      solution: [`New-ADOrganizationalUnit -Name "${fac}" -Path "${DC}"`, ...kids.map((k) => `New-ADOrganizationalUnit -Name ${k} -Path "${ouDn(fac)}"`)],
      realityNote: 'OUs exist to apply Group Policy and delegate administration; designing them around object types and who manages them keeps both simple.',
    };
  }),
  tmpl(2, 3, 'intermediate', 'delegate-helpdesk', 'Delegate password resets to the helpdesk', 'E4', 20, 'Grant a helpdesk group reset-password and unlock rights on one OU only.', (v) => {
    const net = v.net();
    const hd = v.pick(['GG_Helpdesk', 'GG_ServiceDesk', 'GG_IT_Support']);
    const target = v.pick(['Students', 'Staff']);
    const other = target === 'Students' ? 'Staff' : 'Students';
    const ou = ouDn(target);
    return {
      instructions: lab({
        situation: `Helpdesk staff in **${hd}** spend all day asking a domain admin to reset passwords. Delegate exactly two rights on **OU=${target}**: **reset password** and **unlock account** for user objects. They must get nothing on OU=${other}, and must not be made Domain Admins.`,
        steps: ['Grant Reset Password on user objects in the OU with dsacls.', 'Grant read/write of the lockoutTime property (unlock) on user objects.', `Check with \`dsacls "${ou}"\`.`],
        tips: [`dsacls "${ou}" /G "CAMPUS\\${hd}:CA;Reset Password;user"`, `dsacls "${ou}" /G "CAMPUS\\${hd}:RPWP;lockoutTime;user"`],
      }),
      hints: ['CA = control access (an extended right such as Reset Password).', 'RPWP = read property, write property; lockoutTime is the property that unlocking clears.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Students'); addOu(st, 'Staff'); addGroup(st, hd, 'Global', `CN=Users,${DC}`); } }),
      checks: [
        ps(`${hd} can reset passwords in ${target}`, `dsacls "${ou}"`, { pattern: `${hd}.*Reset Password` }),
        ps(`${hd} can unlock accounts in ${target}`, `dsacls "${ou}"`, { pattern: `${hd}.*Unlock accounts` }),
        ps(`Nothing was delegated on ${other}`, `dsacls "${ouDn(other)}"`, { notContains: hd }),
        ps(`${hd} is not a Domain Admin`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: hd }),
      ],
      solution: [`dsacls "${ou}" /G "CAMPUS\\${hd}:CA;Reset Password;user"`, `dsacls "${ou}" /G "CAMPUS\\${hd}:RPWP;lockoutTime;user"`],
      realityNote: 'Delegating narrow rights on OUs is the least-privilege alternative to adding helpdesk staff to Domain Admins; the Delegation of Control wizard writes the same ACEs.',
    };
  }),
  tmpl(2, 3, 'advanced', 'restructure-ous', 'Restructure accounts into the OU standard', 'E4', 25, 'Move users from the default container into department OUs and clean up a protected stray OU.', (v) => {
    const net = v.net();
    const depts = v.depts(3);
    const people = v.people(7).map((p, i) => ({ p, dept: depts[i % 3] }));
    const stray = v.pick(['Temp-Old', 'Test2019', 'New OU']);
    return {
      instructions: lab({
        situation: `Staff accounts have piled up in the default **CN=Users** container, where no Group Policy can be linked. The standard puts each one in **OU=<department>,OU=Staff**. Those OUs exist for ${depts.join(', ')}. Someone also left an empty OU **${stray}** at the top of the domain; it is protected from accidental deletion.`,
        steps: ['Find the staff in CN=Users and read their Department attribute.', 'Move each one to the OU for their department (a filter by department makes this one command per department).', `Remove the stray OU ${stray}: turn off its protection first.`, 'Leave Administrator and Guest where they are.'],
        tips: ['Get-ADUser -Filter "Department -eq \'Finance\'" | ForEach-Object { Move-ADObject -Identity $_.DistinguishedName -TargetPath "OU=..." }', 'Set-ADOrganizationalUnit -Identity "OU=..." -ProtectedFromAccidentalDeletion $false', 'Remove-ADOrganizationalUnit -Identity "OU=..."'],
      }),
      hints: ['-Filter takes PowerShell-style conditions: "Department -eq \'Finance\'".', 'Protection blocks both deleting and moving an OU.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); for (const d of depts) addOu(st, d, ouDn('Staff')); addOu(st, stray); for (const x of people) addUser(st, x.p, `CN=Users,${DC}`, { department: x.dept }); } }),
      checks: [
        ...depts.map((d) => userCheck(`${d} staff are in OU=${d},OU=Staff`, { sams: people.filter((x) => x.dept === d).map((x) => x.p.sam), ou: ouDn(d, 'Staff') })),
        ouCheck(`The stray OU ${stray} is gone`, ouDn(stray), false),
        userCheck('Administrator is still in CN=Users', { sam: 'Administrator', ou: `CN=Users,${DC}` }),
      ],
      solution: [...depts.map((d) => `Get-ADUser -Filter "Department -eq '${d}'" | ForEach-Object { Move-ADObject -Identity $_.DistinguishedName -TargetPath "${ouDn(d, 'Staff')}" }`), `Set-ADOrganizationalUnit -Identity "${ouDn(stray)}" -ProtectedFromAccidentalDeletion $false`, `Remove-ADOrganizationalUnit -Identity "${ouDn(stray)}"`],
      realityNote: 'Accounts left in CN=Users only get domain-level policy; redirusr and redircmp can change the default containers so new objects land in managed OUs.',
    };
  }),

  /* ---------------------------------------------------------------- 2.4 designing AD for a university */
  tmpl(2, 4, 'beginner', 'where-objects-go', 'Decide where each object belongs', 'E10', 15, 'Place lab PCs, staff, students, servers and service accounts in a university OU design.', (v) => {
    const fac = v.faculties(1)[0];
    const lab = `${fac.split(' ')[0].toUpperCase().slice(0, 4)}-LAB${v.int(1, 4)}`;
    return caseStudy(v, {
      intro: `## Sorting the directory\n\nThe OU design has a top-level OU per faculty, each with Staff, Students and Computers (split into Labs and Offices), plus a central **Servers** OU and an **Admin** OU for privileged and service accounts. Decide where these objects go.`,
      steps: [
        { title: 'Lab PCs', text: `Thirty PCs in the ${lab} teaching lab in ${fac} need a locked-down desktop that resets every night.`, choices: [{ text: `OU=Labs,OU=Computers,OU=${fac}`, right: true, feedback: 'Correct. A Labs OU lets the lab lockdown GPO target only these machines.' }, { text: `OU=Students,OU=${fac}`, feedback: 'GPOs for computers apply to computer objects; mixing them with student accounts makes targeting messy.' }, { text: 'Leave them in CN=Computers', feedback: 'You cannot link a GPO to CN=Computers.' }] },
        { title: 'A lecturer', text: `A new lecturer in ${fac}.`, choices: [{ text: `OU=Staff,OU=${fac}`, right: true, feedback: 'Correct.' }, { text: 'OU=Admin', feedback: 'Admin holds privileged accounts only.' }, { text: `OU=Offices,OU=Computers,OU=${fac}`, feedback: 'That OU is for computer objects.' }] },
        { title: 'File server', text: 'FS02, the faculty file server, run by central ICT.', choices: [{ text: 'OU=Servers (central)', right: true, feedback: 'Correct. Servers are managed centrally with server baselines, not by faculty IT.' }, { text: `OU=Computers,OU=${fac}`, feedback: 'Faculty IT would then control server policy, which central ICT does not want.' }, { text: 'OU=Domain Controllers', feedback: 'Only domain controllers belong there.' }] },
        { title: 'Service account', text: 'The account the library system uses to read the directory.', choices: [{ text: 'OU=Admin (service accounts), with a policy that denies interactive logon', right: true, feedback: 'Correct. Service accounts are kept apart and locked down.' }, { text: 'OU=Staff in the library department', feedback: 'It would get staff policies and be easy to misuse.' }, { text: 'CN=Users', feedback: 'Unmanaged; no policy can target it.' }] },
        { title: 'Students', text: `First-year ${fac} students.`, choices: [{ text: `OU=Students,OU=${fac}`, right: true, feedback: 'Correct. Year groups are better as groups than as more OUs.' }, { text: 'A separate students.campus.local domain', feedback: 'A domain is not a security boundary and doubles the infrastructure; OUs and groups are enough.' }, { text: 'One OU per student year, per programme, per faculty', feedback: 'Deep OU trees are hard to manage; use groups for year and programme.' }] },
      ],
      ending: { title: 'Directory sorted', text: 'Objects sit where policy and delegation can find them: by faculty, then by object type.' },
      hints: ['OUs are for Group Policy and delegation; groups are for permissions.', 'Computer and user objects get different policies.'],
      realityNote: 'Most universities organise AD by faculty or campus first and object type second, keeping the tree shallow and using groups for everything else.',
    });
  }),
  tmpl(2, 4, 'intermediate', 'build-design-from-csv', 'Build an OU design from a CSV plan', 'E4', 20, 'Create a whole OU tree from a design spreadsheet with Import-Csv.', (v) => {
    const net = v.net();
    const facs = v.faculties(2);
    const rows: Array<[string, string]> = [];
    for (const f of facs) {
      rows.push([f, DC]);
      for (const k of ['Staff', 'Students', 'Computers']) rows.push([k, ouDn(f)]);
      rows.push(['Labs', ouDn('Computers', f)]);
    }
    rows.push(['Servers', DC]);
    const csv = ['Name,Parent', ...rows.map(([n, p]) => `${n},"${p}"`)].join('\n') + '\n';
    return {
      instructions: lab({
        situation: `The design team finished the OU plan for ${facs.join(' and ')} and saved it as **C:\\Design\\ous.csv** (columns Name and Parent, parents listed before children). Build the whole tree from the file instead of typing ${rows.length} commands.`,
        steps: ['Read the file with Import-Csv and look at the rows.', 'Create every OU with one pipeline: Import-Csv ... | ForEach-Object { New-ADOrganizationalUnit ... }.', 'Check the result with Get-ADOrganizationalUnit -Filter *.'],
        tips: ['Import-Csv C:\\Design\\ous.csv | Format-Table', 'ForEach-Object { New-ADOrganizationalUnit -Name $_.Name -Path $_.Parent }'],
      }),
      hints: ['Because parents come first in the file, each OU\'s parent already exists when it is created.', 'Parent values are DNs with commas, so the CSV quotes them.'],
      initialState: system({ machines: [dc01(net)], files: { 'C:\\Design\\ous.csv': csv } }),
      checks: [...facs.flatMap((f) => [ouCheck(`OU=${f} exists`, ouDn(f)), ouCheck(`${f} has Labs under Computers`, ouDn('Labs', 'Computers', f)), ouCheck(`${f} has Students`, ouDn('Students', f))]), ouCheck('OU=Servers exists', ouDn('Servers')), ran('You built it from the CSV', 'Import-Csv')],
      solution: ['Import-Csv C:\\Design\\ous.csv | ForEach-Object { New-ADOrganizationalUnit -Name $_.Name -Path $_.Parent }'],
      realityNote: 'Driving directory builds from a reviewed design file makes them repeatable for test labs, disaster recovery and the next faculty.',
    };
  }),
  tmpl(2, 4, 'advanced', 'design-review', 'Review a proposed AD design for a university', 'E10', 25, 'Critique domain, OU, group and naming choices in a design proposal.', (v) => {
    const campuses = v.int(2, 4);
    const users = v.pick([6000, 9000, 14000, 20000]);
    return caseStudy(v, {
      intro: `## Design review\n\nA consultant proposes an AD design for the university: ${users.toLocaleString('en-US')} users on ${campuses} campuses. Review each proposal in the evidence pack.`,
      steps: [
        { title: 'Domains', text: 'Proposal 1: one domain per campus, for security.', evidence: [{ title: 'Proposal 1', text: `Create ${campuses} child domains (one per campus) under campus.local so that campus IT teams are isolated from each other.` }], choices: [{ text: 'Reject: domains do not isolate admins; use one domain and delegate by OU', right: true, feedback: 'Correct. Extra domains add DCs, trusts and cost without a security boundary.' }, { text: 'Accept: child domains are separate security boundaries', feedback: 'The forest is the boundary. Enterprise Admins control every domain.' }, { text: 'Accept, but use separate forests', feedback: 'Separate forests isolate, but nobody needs that here and it breaks shared services.' }] },
        { title: 'OU depth', text: 'Proposal 2: OUs by campus > faculty > department > programme > year.', evidence: [{ title: 'Proposal 2', text: 'Example path: OU=2026,OU=BSc-CS,OU=Computer Science,OU=Applied Sciences,OU=Main Campus,DC=campus,DC=local' }], choices: [{ text: 'Simplify: keep OUs for policy and delegation, use groups for programme and year', right: true, feedback: 'Correct. Every year would need a new OU, and accounts would move every September.' }, { text: 'Accept: deeper is more organised', feedback: 'Depth makes GPO inheritance and moves painful, with no gain.' }, { text: 'Flatten everything into one OU', feedback: 'Then you cannot target policy or delegate to faculties.' }] },
        { title: 'Permissions', text: 'Proposal 3: grant folder permissions directly to user accounts.', choices: [{ text: 'Reject: use AGDLP, accounts into Global role groups, into Domain Local resource groups', right: true, feedback: 'Correct. Permissions on groups survive staff changes.' }, { text: 'Accept for small folders', feedback: 'Every leaver then leaves orphaned entries in ACLs.' }, { text: 'Use Everyone and rely on share names being secret', feedback: 'Obscurity is not access control.' }] },
        { title: 'Naming', text: 'Proposal 4: user logon names as firstname.lastname, up to 30 characters.', choices: [{ text: 'Adjust: SamAccountName is limited to 20 characters; keep UPN as firstname.lastname@ and a shorter SAM', right: true, feedback: 'Correct. The 20-character limit is real; UPNs can be longer.' }, { text: 'Accept as is', feedback: 'Names over 20 characters fail for SamAccountName.' }, { text: 'Use student numbers only, for everyone', feedback: 'Fine for students, but staff need recognisable names for email and support.' }] },
        { title: 'Admin accounts', text: 'Proposal 5: IT staff use one account for email and domain administration.', choices: [{ text: 'Reject: separate daily and admin accounts, admins in Protected Users', right: true, feedback: 'Correct. Phishing a daily account must not give domain admin.' }, { text: 'Accept with a long password', feedback: 'Email and web browsing with a Domain Admin account is how domains are lost.' }, { text: 'Accept, but enable MFA on email', feedback: 'Helps, but administration still runs as the daily identity.' }] },
      ],
      ending: { title: 'Review returned', text: 'One domain, a shallow OU tree, AGDLP groups, naming within limits and separate admin accounts.' },
      hints: ['Count what each extra domain or OU level costs.', 'SamAccountName: 20 characters.', 'Separate admin identities.'],
      realityNote: 'Microsoft recommends a single-domain forest unless there is a strong reason otherwise; most universities follow that.',
    });
  }),

  /* ---------------------------------------------------------------- 2.5 promotion and domain join */
  tmpl(2, 5, 'beginner', 'join-a-pc', 'Join a new PC to the domain', 'E4', 15, 'Join a workgroup PC to the domain into the right OU.', (v) => {
    const net = v.net();
    const fac = v.faculties(1)[0];
    const name = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    return {
      instructions: lab({
        situation: `**${name}** is a new teaching-lab PC in ${fac}. It is in a workgroup, gets its address from DHCP (DNS already points at DC01), and must join **campus.local** straight into **OU=Labs,OU=Computers,OU=${fac}** so the lab policy applies from the first boot.`,
        steps: [`Run Add-Computer on ${name} (Invoke-Command or Enter-PSSession), with a domain credential and -OUPath.`, 'Restart it.', `Check with \`Get-ADComputer ${name}\` on DC01.`],
        tips: ['Add-Computer -DomainName campus.local -Credential (Get-Credential CAMPUS\\Administrator) -OUPath "OU=..." -Restart'],
      }),
      hints: ['Without -OUPath the computer lands in CN=Computers, where no GPO can be linked.', 'Joining needs a domain account allowed to add computers.'],
      initialState: system({ machines: [dc01(net), { ...bare(name), os: 'Windows 11 Pro', installType: 'Client', nics: [{ ...nic(undefined, net), dhcp: true, ip: `${net}.${v.int(120, 200)}`, prefix: 24, gateway: `${net}.1`, dns: [`${net}.10`], profile: 'Private' }] }], ad: (st) => { addOu(st, fac); addOu(st, 'Computers', ouDn(fac)); addOu(st, 'Labs', ouDn('Computers', fac)); } }),
      checks: [ps(`${name} is in the Labs OU`, `(Get-ADComputer -Identity ${name}).DistinguishedName`, { equals: `CN=${name},${ouDn('Labs', 'Computers', fac)}` })],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Add-Computer -DomainName campus.local -Credential (Get-Credential CAMPUS\\Administrator) -OUPath "${ouDn('Labs', 'Computers', fac)}" -Restart }`],
      realityNote: 'Joining straight into the right OU, or pre-staging the computer account, means the machine never runs a day without its policies.',
    };
  }),
  tmpl(2, 5, 'intermediate', 'promote-second-dc', 'Promote a second domain controller', 'E4', 20, 'Install AD DS on a member server and promote it as an additional DC with DNS and GC.', (v) => {
    const net = v.net();
    const name = v.pick(['DC02', 'DC-B', 'ADDC02']);
    const last = v.int(11, 19);
    const dsrm = v.password();
    return {
      instructions: lab({
        situation: `campus.local has only one domain controller, DC01. If it fails, nobody can log on. **${name}** (${net}.${last}, DNS pointing at DC01) is ready. Make it an additional domain controller with **DNS** and the **global catalogue**, in the default site.`,
        steps: [`Install the AD DS role on ${name} with its management tools.`, `Promote it with Install-ADDSDomainController (domain campus.local, -InstallDns, a domain admin credential, and a DSRM password such as ${dsrm}).`, 'Check with Get-ADDomainController -Filter *.'],
        tips: ['Install-WindowsFeature AD-Domain-Services -IncludeManagementTools', 'Install-ADDSDomainController -DomainName campus.local -InstallDns -Credential (Get-Credential CAMPUS\\Administrator) -SafeModeAdministratorPassword (ConvertTo-SecureString "..." -AsPlainText -Force)'],
      }),
      hints: ['The DSRM password is for Directory Services Restore Mode, used in recovery.', 'A new DC must find the domain through DNS, so its DNS must point at an existing DC.'],
      initialState: system({ machines: [dc01(net), { name, nics: [nic(`${net}.${last}`, net)] }] }),
      checks: [ps(`${name} is a domain controller`, `(Get-ADDomainController -Identity ${name}).HostName`, { equalsIgnoreCase: `${name}.campus.local` }), ps(`${name} is a global catalogue`, `(Get-ADDomainController -Identity ${name}).IsGlobalCatalog`, { equals: 'True' }), ps(`${name} runs DNS`, `(Get-WindowsFeature -Name DNS).InstallState`, { machine: name, equals: 'Installed' })],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Install-WindowsFeature AD-Domain-Services -IncludeManagementTools; Install-ADDSDomainController -DomainName campus.local -InstallDns -Credential (Get-Credential CAMPUS\\Administrator) -SafeModeAdministratorPassword (ConvertTo-SecureString "${dsrm}" -AsPlainText -Force) }`],
      realityNote: 'Two DCs per domain is the minimum for any production directory; with AD-integrated DNS, the second DC is also a second DNS server.',
    };
  }),
  tmpl(2, 5, 'advanced', 'join-fails', 'Fix a domain join that keeps failing', 'E4', 25, 'Rename a PC to the standard, fix its DNS and the missing target OU, then join it.', (v) => {
    const net = v.net();
    const fac = v.faculties(1)[0];
    const tmp = `DESKTOP-${v.pick(['8K2QF1L', 'Q7TR0PM', 'A1B2C3D', 'MN4K7Z2'])}`;
    const name = `${fac.split(' ')[0].toUpperCase().slice(0, 3)}-OFF-${String(v.int(1, 40)).padStart(2, '0')}`;
    const bad = v.pick(['8.8.8.8', '1.1.1.1', `${net}.1`]);
    return {
      instructions: lab({
        situation: `A technician says ${tmp} "won't join the domain". It must end up as **${name}** in **OU=Offices,OU=Computers,OU=${fac}**. Three things are wrong: its name is not the standard, its DNS server is **${bad}**, and nobody created the Offices OU yet (OU=Computers,OU=${fac} exists).`,
        steps: [`Try the join first and read the error.`, `Point ${tmp}'s DNS at DC01 (${net}.10).`, 'Create the Offices OU.', `Rename the PC to ${name}, restart, then join it into the Offices OU.`],
        tips: ['Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses IP', 'Rename-Computer -NewName NAME -Restart'],
      }),
      hints: ['The join error mentions DNS: a public resolver cannot find _ldap._tcp.dc._msdcs.campus.local.', 'After the rename, use the new name for Invoke-Command.'],
      initialState: system({ machines: [dc01(net), { ...bare(tmp), os: 'Windows 11 Pro', installType: 'Client', nics: [{ ...nic(undefined, net), dhcp: true, ip: `${net}.${v.int(120, 200)}`, prefix: 24, gateway: `${net}.1`, dns: [bad], profile: 'Private' }] }], ad: (st) => { addOu(st, fac); addOu(st, 'Computers', ouDn(fac)); } }),
      checks: [ouCheck('The Offices OU exists', ouDn('Offices', 'Computers', fac)), ps(`${name} is in the Offices OU`, `(Get-ADComputer -Identity ${name}).DistinguishedName`, { equals: `CN=${name},${ouDn('Offices', 'Computers', fac)}` }), ps(`There is no computer account called ${tmp}`, 'Get-ADComputer -Filter * | ForEach-Object { $_.Name }', { notContains: tmp, message: `Rename the PC before joining, so the domain never has a ${tmp} account.` })],
      solution: [`Invoke-Command -ComputerName ${tmp} -ScriptBlock { Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.10; Rename-Computer -NewName ${name} }`, `New-ADOrganizationalUnit -Name Offices -Path "${ouDn('Computers', fac)}"`, `Invoke-Command -ComputerName ${name} -ScriptBlock { Add-Computer -DomainName campus.local -Credential (Get-Credential CAMPUS\\Administrator) -OUPath "${ouDn('Offices', 'Computers', fac)}" -Restart }`],
      realityNote: 'DNS is behind most failed domain joins. Renaming before joining avoids stale computer accounts with random names.',
    };
  }),
];
