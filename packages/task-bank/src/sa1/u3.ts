/** Unit 3: Active Directory security. */

import type { CheckSpec } from '@cslab/lab-runtime';
import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { DC, PW, SECURE, addGroup, addOu, addUser, dc01, fs01, lab, nic, ouDn, ps, ran, secEvent, svc, system, tmpl, userCheck } from './kit';

const acc = (label: string, machine: string, path: string, user: string, equals: string, message?: string): CheckSpec => ({ type: 'win.access', label, machine, path, user, equals, ...(message ? { message } : {}) });

export const U3: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 3.1 Kerberos and NTLM */
  tmpl(3, 1, 'beginner', 'clock-skew', 'Fix Kerberos on a server with a wrong clock', 'E4', 15, 'See that Kerberos tickets fail with clock skew and resynchronise the time.', (v) => {
    const net = v.net();
    const name = v.pick(['APP01', 'WEB02', 'LIB-SRV01', 'HR-APP01']);
    const skew = v.pick([7, 9, 12, 18, 25, -8, -15]);
    return {
      instructions: lab({
        situation: `Users get "access denied" from **${name}**, yet their passwords work everywhere else. Kerberos tickets carry timestamps, and a domain member whose clock is more than **5 minutes** from the domain controller cannot get or accept tickets.`,
        steps: [`Look at ${name}'s tickets: \`Invoke-Command -ComputerName ${name} -ScriptBlock { klist }\`.`, `Check its time offset with \`w32tm /query /status\`.`, 'Resynchronise it with `w32tm /resync` and check klist again.'],
        tips: ['w32tm /query /status', 'w32tm /resync', 'klist purge'],
      }),
      hints: ['Domain members take their time from a DC; the PDC emulator is the top of the chain.', 'Phase Offset is the difference in seconds.'],
      initialState: system({ machines: [dc01(net), { name, timeOffsetMin: skew, nics: [nic(`${net}.30`, net)] }] }),
      checks: [ps(`${name}'s clock is in step`, 'w32tm /query /status', { machine: name, contains: 'Phase Offset: 0.0000000s' }), ps(`${name} gets Kerberos tickets again`, 'klist', { machine: name, contains: 'krbtgt' })],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { klist }`, `Invoke-Command -ComputerName ${name} -ScriptBlock { w32tm /query /status; w32tm /resync; klist }`],
      realityNote: 'The 5-minute tolerance is the Kerberos default in AD (Maximum tolerance for computer clock synchronization). Time problems are a classic cause of sudden authentication failures.',
    };
  }),
  tmpl(3, 1, 'intermediate', 'time-service', 'Find and fix every server that breaks Kerberos time', 'E4', 20, 'Check several servers, restart a stopped time service and resync the skewed clocks.', (v) => {
    const net = v.net();
    const names = v.some(['FS01', 'APP01', 'PRINT01', 'WEB01', 'WSUS01'], 4);
    const [stopped, skewed, ...ok] = names;
    const skew = v.pick([9, 14, 22, -11]);
    return {
      instructions: lab({
        situation: `The service desk has a run of "trust relationship" and Kerberos complaints. Check the time on **${names.join(', ')}**. Every one of them must be within a few seconds of the DC, and the **Windows Time** service (W32Time) must run and start automatically.`,
        steps: ['Query the time status on all four in one Invoke-Command.', 'Check the W32Time service on each.', 'Fix the service where it is stopped or disabled, then resync the clocks that are off.'],
        tips: [`Invoke-Command -ComputerName ${names.join(',')} -ScriptBlock { w32tm /query /status }`, 'Get-Service W32Time', 'Set-Service W32Time -StartupType Automatic', 'Start-Service W32Time'],
      }),
      hints: ['w32tm /resync fails while the service is stopped.', `${ok.join(' and ')} may already be fine; check before changing anything.`],
      initialState: system({ machines: [dc01(net), { name: stopped, timeOffsetMin: v.pick([6, 8, 31]), services: { Spooler: svc.running, W32Time: { status: 'Stopped', start: 'Disabled' }, WinRM: svc.running, LanmanServer: svc.running, Dnscache: svc.running, EventLog: svc.running }, nics: [nic(`${net}.21`, net)] }, { name: skewed, timeOffsetMin: skew, nics: [nic(`${net}.22`, net)] }, ...ok.map((n, i) => ({ name: n, nics: [nic(`${net}.${23 + i}`, net)] }))] }),
      checks: [
        ...names.map((n) => ps(`${n} is in step`, 'w32tm /query /status', { machine: n, contains: 'Phase Offset: 0.0000000s' })),
        ps(`W32Time runs on ${stopped}`, '(Get-Service W32Time).Status', { machine: stopped, equals: 'Running' }),
        ps(`W32Time starts automatically on ${stopped}`, '(Get-Service W32Time).StartType', { machine: stopped, equals: 'Automatic' }),
      ],
      solution: [`Invoke-Command -ComputerName ${names.join(',')} -ScriptBlock { w32tm /query /status }`, `Invoke-Command -ComputerName ${stopped} -ScriptBlock { Set-Service W32Time -StartupType Automatic; Start-Service W32Time; w32tm /resync }`, `Invoke-Command -ComputerName ${skewed} -ScriptBlock { w32tm /resync }`],
      realityNote: 'Disabled time services usually come from a hardening script or a VM template; monitoring the time offset on every server catches it before Kerberos does.',
    };
  }),
  tmpl(3, 1, 'advanced', 'kerberos-failures', 'Diagnose failed authentications from the security log', 'E10', 20, 'Read Kerberos and NTLM events and tell bad passwords, clock skew, unknown accounts and NTLM fallback apart.', (v) => {
    const [a, b, c] = v.people(3);
    const server = v.pick(['FS01', 'APP01', 'WEB01']);
    return caseStudy(v, {
      intro: `## Four complaints, one log\n\nFour support tickets arrived this morning. The domain controller's Security log has the matching events. Read each event and decide the cause.`,
      steps: [
        { title: `${a.name}`, text: `${a.given} says their password "stopped working".`, evidence: [{ title: 'Event 4771', kind: 'log', text: `Kerberos pre-authentication failed.\nAccount Name: ${a.sam}\nClient Address: ::ffff:10.0.5.44\nFailure Code: 0x18\nPre-Authentication Type: 2` }], choices: [
          { text: 'Wrong password (0x18): the user is typing an old or wrong password', right: true, feedback: 'Correct. 0x18 is KDC_ERR_PREAUTH_FAILED, a bad password.' },
          { text: 'Clock skew', feedback: 'Clock skew is failure code 0x25.' },
          { text: 'The account does not exist', feedback: 'That is 0x6.' },
        ] },
        { title: `${b.name}`, text: `${b.given} cannot log on from one particular lab PC; other PCs work.`, evidence: [{ title: 'Event 4771', kind: 'log', text: `Kerberos pre-authentication failed.\nAccount Name: ${b.sam}\nClient Address: ::ffff:10.0.7.31\nFailure Code: 0x25` }], choices: [
          { text: 'Clock skew (0x25): fix the time on that PC', right: true, feedback: 'Correct. KRB_AP_ERR_SKEW: the PC is more than 5 minutes out.' },
          { text: 'Wrong password', feedback: 'The same password works on other PCs.' },
          { text: 'The account is locked out', feedback: 'Lockout is 0x12 (KDC_ERR_CLIENT_REVOKED).' },
        ] },
        { title: 'An unknown name', text: 'A burst of failures for an account nobody recognises.', evidence: [{ title: 'Event 4771 (×40 in 2 minutes)', kind: 'log', text: `Account Name: admin\nClient Address: ::ffff:10.0.9.200\nFailure Code: 0x6` }], choices: [
          { text: 'Someone is guessing account names (0x6, unknown principal): investigate the source PC', right: true, feedback: 'Correct. Many 0x6 failures for generic names from one host is account enumeration. Find and isolate 10.0.9.200.' },
          { text: 'A user forgot their password', feedback: 'No user is called "admin", and forty attempts in two minutes is not a person.' },
          { text: 'Nothing to do: unknown accounts cannot log on anyway', feedback: 'True, but the pattern is a warning that something on the network is probing.' },
        ] },
        { title: `${c.name}`, text: `${c.given}'s team opens files on ${server} by IP address, and security asks why NTLM is still in use.`, evidence: [{ title: 'Event 4776', kind: 'log', text: `The computer attempted to validate the credentials for an account.\nAuthentication Package: MICROSOFT_AUTHENTICATION_PACKAGE_V1_0\nLogon Account: ${c.sam}\nSource Workstation: OFF-PC12\nError Code: 0x0` }, { title: 'The shortcut they use', text: `\\\\10.0.2.20\\Projects` }], choices: [
          { text: `Kerberos needs a name with an SPN; by IP it falls back to NTLM. Use \\\\${server}\\Projects`, right: true, feedback: 'Correct. Kerberos tickets are issued for service names, not addresses.' },
          { text: 'NTLM is used because the password is weak', feedback: 'Password strength does not choose the protocol.' },
          { text: `${server} does not support Kerberos`, feedback: 'Every domain member supports Kerberos; the name used to reach it decides.' },
        ] },
      ],
      ending: { title: 'Tickets answered', text: 'A bad password, a skewed clock, an enumeration attempt to investigate, and an NTLM fallback fixed by using names.' },
      hints: ['0x18 bad password, 0x25 clock skew, 0x6 unknown account, 0x12 revoked (disabled or locked).', 'Kerberos needs a service name; IP addresses fall back to NTLM.'],
      realityNote: 'Events 4771 (Kerberos pre-auth failure) and 4776 (NTLM validation) are the bread and butter of AD authentication troubleshooting and of SOC detection rules.',
    });
  }),

  /* ---------------------------------------------------------------- 3.2 principals, SIDs, tokens, ACLs */
  tmpl(3, 2, 'beginner', 'read-sids', 'Read security identifiers', 'E4', 10, 'Find a user\'s SID, the domain SID and the well-known RID of Domain Admins.', (v) => {
    const net = v.net();
    const p = v.person();
    let sid = '';
    const initialState = system({ machines: [dc01(net)], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' }, ad: (st) => { st.nextRid += v.int(0, 400); addUser(st, p, `CN=Users,${DC}`); sid = st.users[st.users.length - 1].sid!; } });
    const domainSid = sid.slice(0, sid.lastIndexOf('-'));
    const file = 'C:\\Answers\\sids.txt';
    return {
      instructions: lab({
        situation: `Permissions are stored against **SIDs**, not names. A file server log shows only SIDs, and you need to recognise them. A SID is the **domain SID** plus a **relative ID** (RID) at the end.`,
        steps: [`Find ${p.name}'s SID: \`(Get-ADUser ${p.sam}).SID\`.`, 'Find the SID of Domain Admins.', `Write **${file}** with three lines: \`User: <SID of ${p.sam}>\`, \`Domain: <the domain SID>\` and \`DomainAdmins: <SID of Domain Admins>\`.`],
        tips: ['Get-ADUser NAME | Format-List SID', 'Get-ADGroup "Domain Admins" | Format-List SID'],
      }),
      hints: ['The domain SID is the user SID without its last number.', 'Built-in RIDs: 500 Administrator, 512 Domain Admins, 513 Domain Users.'],
      initialState,
      checks: [ps(`${p.sam}'s SID is recorded`, `Get-Content ${file}`, { contains: `User: ${sid}` }), ps('The domain SID is recorded', `Get-Content ${file}`, { contains: `Domain: ${domainSid}`, pattern: `Domain: ${domainSid.replace(/-/g, '\\-')}\\s*$|Domain: ${domainSid.replace(/-/g, '\\-')}\\r?\\n` }), ps('The Domain Admins SID is recorded', `Get-Content ${file}`, { contains: `DomainAdmins: ${domainSid}-512` })],
      solution: [`Get-ADUser ${p.sam} | Format-List SID`, 'Get-ADGroup "Domain Admins" | Format-List SID', `Set-Content ${file} "User: ${sid}","Domain: ${domainSid}","DomainAdmins: ${domainSid}-512"`],
      realityNote: 'Orphaned SIDs in ACLs are what is left when an account is deleted; recognising well-known RIDs such as 500 and 512 is basic incident-response literacy.',
    };
  }),
  tmpl(3, 2, 'intermediate', 'ntfs-permissions', 'Set NTFS permissions on a department folder', 'E4', 20, 'Remove inherited access and grant a Domain Local group Modify with icacls.', (v) => {
    const net = v.net();
    const dept = v.dept();
    const key = dept.replace(/ /g, '');
    const folder = `D:\\Shares\\${key}`;
    const dl = `DL_${key}_Modify`;
    const [member, outsider] = v.people(2);
    return {
      instructions: lab({
        situation: `**${folder}** on FS01 holds ${dept} files, but it inherits **Users: Read & Execute** from the drive, so anyone in the domain can read it. Only ${dept} staff, through **${dl}**, may use it, with **Modify**. Administrators and SYSTEM keep Full Control.`,
        steps: ['Look at the current ACL with icacls.', 'Stop inheritance but keep a copy of the inherited entries (/inheritance:d), then remove Users.', `Grant ${dl} Modify on the folder and everything below it: (OI)(CI)M.`],
        tips: [`icacls ${folder}`, `icacls ${folder} /inheritance:d`, `icacls ${folder} /remove Users`, `icacls ${folder} /grant "CAMPUS\\${dl}:(OI)(CI)M"`],
      }),
      hints: ['(OI) object inherit and (CI) container inherit make the entry apply to files and subfolders.', '/inheritance:r would also drop Administrators and SYSTEM.'],
      initialState: system({ machines: [dc01(net), fs01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const m = addUser(st, member, ou, { department: dept }); addUser(st, outsider, ou); const g = addGroup(st, `GG_${key}_Staff`, 'Global', ou, [m]); addGroup(st, dl, 'DomainLocal', ou, [g]); }, machineFiles: { FS01: { [`${folder}\\Budget.xlsx`]: 'budget\n' } } }),
      checks: [acc(`${member.name} (${dept}) has Modify`, 'FS01', folder, member.sam, 'Modify'), acc(`${outsider.name} has no access`, 'FS01', folder, outsider.sam, 'None', 'Someone outside the department can still open the folder: remove the inherited Users entry.'), acc('Administrator keeps Full Control', 'FS01', folder, 'Administrator', 'FullControl', 'Administrators lost Full Control: use /inheritance:d, not :r.')],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { icacls ${folder}; icacls ${folder} /inheritance:d; icacls ${folder} /remove Users; icacls ${folder} /grant "CAMPUS\\${dl}:(OI)(CI)M" }`],
      realityNote: 'Breaking inheritance at the department folder and granting groups, never individuals, keeps file server ACLs readable for years.',
    };
  }),
  tmpl(3, 2, 'advanced', 'deny-puzzle', 'Untangle an Allow and a Deny', 'E4', 25, 'Work out effective access from group memberships and fix it without weakening a Deny.', (v) => {
    const net = v.net();
    const proj = v.pick(['Solar-Grid', 'Campus-App', 'Library-RFID', 'Water-Sensors']);
    const folder = `D:\\Projects\\${proj}`;
    const [moved, c1, c2, s1] = v.people(4);
    return {
      instructions: lab({
        situation: `**${moved.name}** was a contractor on ${proj} and was hired as staff last month, but still cannot save files in **${folder}** on FS01. The folder gives **GG_Projects** Modify, and has a **Deny Write** for **GG_Contractors** that security insists stays: contractors must never write project files. Other contractors (${c1.given}, ${c2.given}) must keep read-only access.`,
        steps: [`Check ${moved.given}'s groups with Get-ADPrincipalGroupMembership.`, 'Read the folder ACL with icacls.', `Explain to yourself why ${moved.given} cannot write: Deny beats Allow.`, `Fix it the right way so ${moved.given} gets Modify and the contractors still cannot write.`],
        tips: ['Get-ADPrincipalGroupMembership SAM | Format-Table Name', `Invoke-Command -ComputerName FS01 -ScriptBlock { icacls ${folder} }`],
      }),
      hints: [`Removing the Deny would let every contractor write.`, `${moved.given} is no longer a contractor.`],
      initialState: system({ machines: [dc01(net), fs01(net, { ntfs: { [folder]: { inherit: true, aces: [{ account: 'CAMPUS\\GG_Projects', rights: 'Modify', type: 'Allow' }, { account: 'CAMPUS\\GG_Contractors', rights: 'Write', type: 'Deny' }] } } })], ad: (st) => { const ou = addOu(st, 'Staff'); const dns = [moved, c1, c2, s1].map((p) => addUser(st, p, ou)); addGroup(st, 'GG_Projects', 'Global', ou, dns); addGroup(st, 'GG_Contractors', 'Global', ou, dns.slice(0, 3)); }, machineFiles: { FS01: { [`${folder}\\plan.docx`]: 'plan\n' } } }),
      checks: [acc(`${moved.name} can now save (Modify)`, 'FS01', folder, moved.sam, 'Modify'), acc(`${c1.name} (contractor) still cannot write`, 'FS01', folder, c1.sam, 'ReadAndExecute', 'A contractor can now write: keep the Deny Write for GG_Contractors.'), acc(`${c2.name} (contractor) still cannot write`, 'FS01', folder, c2.sam, 'ReadAndExecute', 'A contractor can now write: keep the Deny Write for GG_Contractors.'), acc(`${s1.name} (staff) keeps Modify`, 'FS01', folder, s1.sam, 'Modify')],
      solution: [`Get-ADPrincipalGroupMembership ${moved.sam} | Format-Table Name`, `Invoke-Command -ComputerName FS01 -ScriptBlock { icacls ${folder} }`, `Remove-ADGroupMember -Identity GG_Contractors -Members ${moved.sam}`],
      realityNote: 'Explicit Deny entries win over Allow, which is why they cause so many puzzles; the clean fix is usually group membership, not editing the ACL.',
    };
  }),

  /* ---------------------------------------------------------------- 3.3 privileged accounts */
  tmpl(3, 3, 'beginner', 'audit-domain-admins', 'Audit who is a Domain Admin', 'E4', 15, 'Compare Domain Admins (with nesting) to the approved list and remove the rest.', (v) => {
    const net = v.net();
    const [admin, lecturer, intern] = v.people(3);
    const allowed = `adm-${admin.sam}`.slice(0, 20);
    const nested = v.pick(['GG_IT_Interns', 'GG_Temp_Support', 'GG_Project_Team']);
    return {
      instructions: lab({
        situation: `The security policy says Domain Admins may contain only **Administrator** and **${allowed}**. An auditor suspects more people have the rights. Membership can be direct or through a nested group.`,
        steps: ['List the members with and without -Recursive.', 'Remove every member that is not on the approved list, including nested groups.', 'Check again with -Recursive.'],
        tips: ['Get-ADGroupMember "Domain Admins"', 'Get-ADGroupMember "Domain Admins" -Recursive', 'Remove-ADGroupMember -Identity "Domain Admins" -Members NAME'],
      }),
      hints: [`${nested} is a group: everyone in it is effectively a Domain Admin.`, 'Remove the nested group from Domain Admins rather than its members from the group.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const adm = addOu(st, 'Admin'); const a = addUser(st, { ...admin, sam: allowed, name: `Admin ${admin.name}` }, adm); const l = addUser(st, lecturer, ou); const i = addUser(st, intern, ou); const g = addGroup(st, nested, 'Global', ou, [i]); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(a, l, g); } }),
      checks: [ps(`${lecturer.name} is no longer a Domain Admin`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: lecturer.sam }), ps(`${intern.name} is no longer a Domain Admin through ${nested}`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: intern.sam }), ps('The approved admins remain', 'Get-ADGroupMember "Domain Admins"', { contains: ['Administrator', allowed] })],
      solution: ['Get-ADGroupMember "Domain Admins" -Recursive', `Remove-ADGroupMember -Identity "Domain Admins" -Members ${lecturer.sam},${nested}`],
      realityNote: 'Privileged group membership reviews are a standard audit control; nested groups are where unexpected admins hide.',
    };
  }),
  tmpl(3, 3, 'intermediate', 'separate-admin-accounts', 'Give IT staff separate admin accounts', 'E4', 20, 'Create adm- accounts, protect them, and take admin rights off daily accounts.', (v) => {
    const net = v.net();
    const staff = v.people(2);
    const adm = staff.map((p) => `adm-${p.sam}`.slice(0, 20));
    return {
      instructions: lab({
        situation: `${staff.map((p) => p.name).join(' and ')} read email and browse the web with accounts that are **Domain Admins**. One phishing link would give an attacker the whole domain. Tiered administration says: a daily account with no admin rights, and a separate admin account used only for administration.`,
        steps: [`Create ${adm.join(' and ')} in **OU=Admin**, enabled, with a password (${PW} for the lab).`, 'Add the new accounts to Domain Admins and to **Protected Users** (no NTLM, no cached credentials, no delegation).', `Remove ${staff.map((p) => p.sam).join(' and ')} from Domain Admins.`],
        tips: [SECURE, 'New-ADUser -Name "Admin Name" -SamAccountName adm-x -Path "OU=Admin,DC=campus,DC=local" -AccountPassword $pw -Enabled $true', 'Add-ADGroupMember -Identity "Protected Users" -Members a,b'],
      }),
      hints: ['Members of Protected Users cannot use NTLM and their credentials are not cached on the PCs they use.', 'Keep the daily accounts enabled; only their admin rights go.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); addOu(st, 'Admin'); const dns = staff.map((p) => addUser(st, p, ou, { department: 'ICT' })); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(...dns); } }),
      checks: [userCheck('The admin accounts exist in OU=Admin, enabled, in Domain Admins and Protected Users', { sams: adm, enabled: true, hasPassword: true, ou: ouDn('Admin'), groups: ['Domain Admins', 'Protected Users'] }), ...staff.map((p) => ps(`${p.sam} is not a Domain Admin`, `(Get-ADPrincipalGroupMembership ${p.sam}).Name`, { notContains: 'Domain Admins', message: `${p.sam} is still in Domain Admins.` })), userCheck('The daily accounts still work', { sams: staff.map((p) => p.sam), enabled: true })],
      solution: [SECURE, ...staff.map((p, i) => `New-ADUser -Name "Admin ${p.name}" -SamAccountName ${adm[i]} -Path "${ouDn('Admin')}" -AccountPassword $pw -Enabled $true`), `Add-ADGroupMember -Identity "Domain Admins" -Members ${adm.join(',')}`, `Add-ADGroupMember -Identity "Protected Users" -Members ${adm.join(',')}`, `Remove-ADGroupMember -Identity "Domain Admins" -Members ${staff.map((p) => p.sam).join(',')}`],
      realityNote: 'Separate admin accounts and the Protected Users group are part of Microsoft\'s privileged access guidance and appear in every AD security assessment.',
    };
  }),
  tmpl(3, 3, 'advanced', 'privilege-cleanup', 'Clean up excessive privilege', 'E4', 30, 'Remove a helpdesk path to Domain Admins, delegate only what it needs, and move a service account to a narrow group.', (v) => {
    const net = v.net();
    const hd = v.people(2);
    const svcName = v.pick(['svc_backup', 'svc_veeam', 'svc_bkp01']);
    const mid = v.pick(['GG_IT_Staff', 'GG_ICT_All', 'GG_Systems']);
    return {
      instructions: lab({
        situation: `A security review found three problems:\n\n1. **GG_Helpdesk** is nested in **${mid}**, which is nested in **Domain Admins**, so every helpdesk member is a domain admin. The helpdesk only needs to **reset passwords** in **OU=Students**.\n2. The backup service account **${svcName}** is a Domain Admin, but it only needs to back up files: that is what **Backup Operators** is for.\n3. **${mid}** itself must stay in Domain Admins for now (it holds the server team).`,
        steps: ['Map the nesting with Get-ADGroupMember -Recursive and Get-ADPrincipalGroupMembership.', `Take GG_Helpdesk out of ${mid}, and delegate Reset Password on OU=Students to it.`, `Move ${svcName} from Domain Admins to Backup Operators.`],
        tips: ['Get-ADPrincipalGroupMembership GG_Helpdesk', `dsacls "${ouDn('Students')}" /G "CAMPUS\\GG_Helpdesk:CA;Reset Password;user"`],
      }),
      hints: ['Remove the nesting, not the individual helpdesk users.', 'Backup Operators can back up and restore files on DCs without being administrators of the domain.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); addOu(st, 'Students'); const adm = addOu(st, 'Admin'); const dns = hd.map((p) => addUser(st, p, ou)); const s = addUser(st, { given: 'Backup', surname: 'Service', name: svcName, sam: svcName }, adm, { passwordNeverExpires: true }); const h = addGroup(st, 'GG_Helpdesk', 'Global', ou, dns); const m = addGroup(st, mid, 'Global', ou, [h]); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(m, s); } }),
      checks: [...hd.map((p) => ps(`${p.name} (helpdesk) is not a Domain Admin`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: p.sam })), ps('The helpdesk can reset student passwords', `dsacls "${ouDn('Students')}"`, { pattern: 'GG_Helpdesk.*Reset Password' }), ps(`${svcName} is not a Domain Admin`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: svcName }), userCheck(`${svcName} is in Backup Operators`, { sam: svcName, groups: ['Backup Operators'] }), ps(`${mid} is still in Domain Admins`, 'Get-ADGroupMember "Domain Admins"', { contains: mid })],
      solution: ['Get-ADGroupMember "Domain Admins" -Recursive', `Remove-ADGroupMember -Identity ${mid} -Members GG_Helpdesk`, `dsacls "${ouDn('Students')}" /G "CAMPUS\\GG_Helpdesk:CA;Reset Password;user"`, `Remove-ADGroupMember -Identity "Domain Admins" -Members ${svcName}`, `Add-ADGroupMember -Identity "Backup Operators" -Members ${svcName}`],
      realityNote: 'Attack-path tools such as BloodHound find exactly these nested routes to Domain Admins; defenders use the same mapping to remove them.',
    };
  }),

  /* ---------------------------------------------------------------- 3.4 password and lockout policies */
  tmpl(3, 4, 'beginner', 'domain-password-policy', 'Set the domain password and lockout policy', 'E4', 15, 'Apply the institution\'s password length, history and lockout rules to the domain.', (v) => {
    const net = v.net();
    const len = v.int(10, 14);
    const threshold = v.pick([5, 6, 8, 10]);
    const mins = v.pick([15, 20, 30]);
    return {
      instructions: lab({
        situation: `The new ICT policy says: passwords at least **${len}** characters with complexity, remember the last **24**, and lock an account for **${mins} minutes** after **${threshold}** bad attempts within ${mins} minutes. The domain still has the defaults (7 characters, no lockout).`,
        steps: ['Read the current policy with Get-ADDefaultDomainPasswordPolicy.', 'Set the new values with Set-ADDefaultDomainPasswordPolicy.', 'Read it back.'],
        tips: [`Set-ADDefaultDomainPasswordPolicy -Identity campus.local -MinPasswordLength ${len} -ComplexityEnabled $true -PasswordHistoryCount 24 -LockoutThreshold ${threshold} -LockoutDuration 00:${mins}:00 -LockoutObservationWindow 00:${mins}:00`],
      }),
      hints: ['Durations are written hh:mm:ss.', 'The observation window may not be longer than the lockout duration.'],
      initialState: system({ machines: [dc01(net)] }),
      checks: [ps(`Minimum length ${len}`, '(Get-ADDefaultDomainPasswordPolicy).MinPasswordLength', { equals: String(len) }), ps('Complexity on', '(Get-ADDefaultDomainPasswordPolicy).ComplexityEnabled', { equals: 'True' }), ps('History 24', '(Get-ADDefaultDomainPasswordPolicy).PasswordHistoryCount', { equals: '24' }), ps(`Lockout after ${threshold}`, '(Get-ADDefaultDomainPasswordPolicy).LockoutThreshold', { equals: String(threshold) }), ps(`Locked for ${mins} minutes`, '(Get-ADDefaultDomainPasswordPolicy).LockoutDuration', { equals: `00:${mins}:00` })],
      solution: ['Get-ADDefaultDomainPasswordPolicy', `Set-ADDefaultDomainPasswordPolicy -Identity campus.local -MinPasswordLength ${len} -ComplexityEnabled $true -PasswordHistoryCount 24 -LockoutThreshold ${threshold} -LockoutDuration 00:${mins}:00 -LockoutObservationWindow 00:${mins}:00`],
      realityNote: 'Current NIST SP 800-63B guidance favours length over forced complexity and rotation, and lockout thresholds of around 10 limit online guessing without locking real users out constantly.',
    };
  }),
  tmpl(3, 4, 'intermediate', 'fgpp-admins', 'Give administrators a stricter password policy', 'E4', 20, 'Create a fine-grained password policy for Domain Admins and confirm who it applies to.', (v) => {
    const net = v.net();
    const [admin, user] = v.people(2);
    const name = v.pick(['PSO-Admins', 'Admins-Strict', 'FGPP-Privileged']);
    const len = v.int(15, 20);
    const prec = v.pick([1, 5, 10]);
    return {
      instructions: lab({
        situation: `The domain policy (12 characters) is fine for staff, but administrators need more: **${len}** characters minimum and lockout after **3** attempts. A **fine-grained password policy** (password settings object) can apply to a Global group without changing the domain policy.`,
        steps: [`Create the policy **${name}** with precedence ${prec}, MinPasswordLength ${len}, LockoutThreshold 3, complexity on.`, 'Apply it to Domain Admins.', `Check which policy applies to ${admin.sam} (an admin) and to ${user.sam} (not an admin).`],
        tips: [`New-ADFineGrainedPasswordPolicy -Name ${name} -Precedence ${prec} -MinPasswordLength ${len} -LockoutThreshold 3 -ComplexityEnabled $true`, `Add-ADFineGrainedPasswordPolicySubject -Identity ${name} -Subjects "Domain Admins"`, 'Get-ADUserResultantPasswordPolicy SAM'],
      }),
      hints: ['Fine-grained policies apply to users and Global groups only.', 'Get-ADUserResultantPasswordPolicy returns nothing when the domain policy applies.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { st.passwordPolicy.minLength = 12; const ou = addOu(st, 'Staff'); const a = addUser(st, admin, addOu(st, 'Admin')); addUser(st, user, ou); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(a); } }),
      checks: [ps(`${name} applies to ${admin.sam}`, `(Get-ADUserResultantPasswordPolicy ${admin.sam}).Name`, { equals: name }), ps(`${name} requires ${len} characters`, `(Get-ADUserResultantPasswordPolicy ${admin.sam}).MinPasswordLength`, { equals: String(len) }), ps(`${name} locks after 3 attempts`, `(Get-ADUserResultantPasswordPolicy ${admin.sam}).LockoutThreshold`, { equals: '3' }), ps(`${user.sam} still gets the domain policy`, `Get-ADUserResultantPasswordPolicy ${user.sam}`, { equals: '' })],
      solution: [`New-ADFineGrainedPasswordPolicy -Name ${name} -Precedence ${prec} -MinPasswordLength ${len} -LockoutThreshold 3 -ComplexityEnabled $true`, `Add-ADFineGrainedPasswordPolicySubject -Identity ${name} -Subjects "Domain Admins"`, `Get-ADUserResultantPasswordPolicy ${admin.sam}`],
      realityNote: 'Fine-grained password policies (since Windows Server 2008) are how organisations give privileged and service accounts stronger rules than everyone else.',
    };
  }),
  tmpl(3, 4, 'advanced', 'fgpp-conflict', 'Resolve conflicting password policies', 'E4', 25, 'Fix FGPP precedence, add a student policy and unlock a locked-out administrator.', (v) => {
    const net = v.net();
    const [admin, staffer, student] = v.people(3);
    const sLen = v.int(10, 12);
    return {
      instructions: lab({
        situation: `Two fine-grained policies exist. **PSO-Staff** (precedence 5, 8 characters) applies to **GG_All_Staff**. **PSO-Admins** (precedence 20, 16 characters) applies to **Domain Admins**. ${admin.name} is in both groups, and the auditors found that admins get the *weaker* policy. Also:\n\n- Students (**GG_Students**) need their own policy **PSO-Students**: ${sLen} characters, lockout after 10.\n- ${admin.name} locked themself out testing passwords and needs unlocking.`,
        steps: [`Check which policy ${admin.sam} gets now, and why (the lowest precedence number wins).`, 'Fix the precedence so administrators always get PSO-Admins.', 'Create PSO-Students and apply it to GG_Students.', `Unlock ${admin.sam}.`],
        tips: ['Get-ADFineGrainedPasswordPolicy -Filter * | Format-Table Name,Precedence,AppliesTo', 'Set-ADFineGrainedPasswordPolicy -Identity NAME -Precedence N', 'Unlock-ADAccount -Identity SAM'],
      }),
      hints: ['Precedence 1 beats precedence 5.', 'A policy linked directly to a user beats any group policy, but linking users one by one does not scale.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const so = addOu(st, 'Students'); const a = addUser(st, admin, addOu(st, 'Admin'), { lockedOut: true }); const s = addUser(st, staffer, ou); const stu = addUser(st, student, so); addGroup(st, 'GG_All_Staff', 'Global', ou, [a, s]); addGroup(st, 'GG_Students', 'Global', so, [stu]); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(a); const base = { ...st.passwordPolicy }; st.fgpps.push({ ...base, name: 'PSO-Staff', precedence: 5, minLength: 8, subjects: [`CN=GG_All_Staff,${ou}`] }, { ...base, name: 'PSO-Admins', precedence: 20, minLength: 16, lockoutThreshold: 3, subjects: [`CN=Domain Admins,CN=Users,${DC}`] }); } }),
      checks: [ps(`${admin.sam} gets PSO-Admins`, `(Get-ADUserResultantPasswordPolicy ${admin.sam}).Name`, { equals: 'PSO-Admins' }), ps(`${staffer.sam} still gets PSO-Staff`, `(Get-ADUserResultantPasswordPolicy ${staffer.sam}).Name`, { equals: 'PSO-Staff' }), ps(`${student.sam} gets PSO-Students`, `(Get-ADUserResultantPasswordPolicy ${student.sam}).Name`, { equals: 'PSO-Students' }), ps(`PSO-Students requires ${sLen} characters`, `(Get-ADUserResultantPasswordPolicy ${student.sam}).MinPasswordLength`, { equals: String(sLen) }), ps(`${admin.sam} is unlocked`, `(Get-ADUser ${admin.sam} -Properties LockedOut).LockedOut`, { equals: 'False' })],
      solution: [`Get-ADUserResultantPasswordPolicy ${admin.sam}`, 'Set-ADFineGrainedPasswordPolicy -Identity PSO-Admins -Precedence 1', `New-ADFineGrainedPasswordPolicy -Name PSO-Students -Precedence 30 -MinPasswordLength ${sLen} -LockoutThreshold 10 -ComplexityEnabled $true`, 'Add-ADFineGrainedPasswordPolicySubject -Identity PSO-Students -Subjects GG_Students', `Unlock-ADAccount -Identity ${admin.sam}`],
      realityNote: 'Precedence mistakes are common when several teams add password policies; giving privileged policies the lowest numbers is the usual convention.',
    };
  }),

  /* ---------------------------------------------------------------- 3.5 auditing */
  tmpl(3, 5, 'beginner', 'enable-auditing', 'Turn on logon and account auditing', 'E4', 15, 'Enable the advanced audit subcategories that record logons, lockouts and account changes.', (v) => {
    const net = v.net();
    const extra = v.pick(['Security Group Management', 'Directory Service Changes', 'Credential Validation']);
    const subs: Array<[string, string]> = [['Logon', 'Success and Failure'], ['Account Lockout', 'Success and Failure'], ['User Account Management', 'Success'], [extra, 'Success']];
    return {
      instructions: lab({
        situation: 'After an incident nobody could say who logged on or who changed accounts, because auditing was off on the DC. Turn on the advanced audit subcategories the incident team asked for.',
        steps: [...subs.map(([s, how]) => `Audit **${s}**: ${how.toLowerCase()}.`), 'Check with `auditpol /get /category:*`.'],
        tips: ['auditpol /set /subcategory:"Logon" /success:enable /failure:enable', 'auditpol /get /category:*'],
      }),
      hints: ['Quote subcategory names that contain spaces.', 'In a domain you would normally set these in a GPO linked to the Domain Controllers OU.'],
      initialState: system({ machines: [dc01(net)] }),
      checks: subs.map(([s, how]) => ps(`${s}: ${how}`, 'auditpol /get /category:*', { pattern: `${s}\\s+${how}\\b` })),
      solution: subs.map(([s, how]) => `auditpol /set /subcategory:"${s}" /success:enable${how.includes('Failure') ? ' /failure:enable' : ''}`),
      realityNote: 'Microsoft\'s audit policy recommendations and most SOC onboarding guides start with exactly these subcategories on domain controllers.',
    };
  }),
  tmpl(3, 5, 'intermediate', 'failed-logons', 'Find the source of repeated failed logons', 'E4', 20, 'Group 4625 events by account and workstation to find what is generating failures.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const target = people[0];
    const ws = v.pick(['LAB-2-14', 'OFF-PC07', 'LIB-KIOSK3', 'REG-PC22']);
    const n = v.int(12, 25);
    const events = [
      ...Array.from({ length: n }, (_, i) => secEvent(4625, `An account failed to log on. Account Name: ${target.sam} Workstation Name: ${ws}`, { TargetUserName: target.sam, WorkstationName: ws, IpAddress: `${net}.${v.int(100, 200)}`, FailureReason: 'Unknown user name or bad password.' }, `10/22/2026 07:${String(10 + (i % 50)).padStart(2, '0')}:00`)),
      ...people.slice(1).flatMap((p) => Array.from({ length: v.int(1, 3) }, () => secEvent(4625, `An account failed to log on. Account Name: ${p.sam}`, { TargetUserName: p.sam, WorkstationName: v.pick(['OFF-PC01', 'OFF-PC02', 'LAB-1-03']), IpAddress: `${net}.${v.int(100, 200)}` }))),
    ];
    const file = 'C:\\Answers\\failures.txt';
    return {
      instructions: lab({
        situation: `The service desk says one account keeps getting locked out every morning. The DC's Security log has the failed logons (**event 4625**). Find which account has the most failures and which workstation they come from: usually an old saved password on a PC or a mapped drive.`,
        steps: ['Read the 4625 events with Get-WinEvent -FilterHashtable.', 'Group them by TargetUserName, then look at WorkstationName for the top account.', `Write **${file}** with \`Account: <sam>\` and \`Workstation: <name>\`.`],
        tips: ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } | Group-Object TargetUserName | Sort-Object Count -Descending", "... | Where-Object { $_.TargetUserName -eq 'sam' } | Group-Object WorkstationName"],
      }),
      hints: ['Group-Object counts the events for each value.', 'A steady stream from one PC is usually a stored credential, not an attacker.'],
      initialState: system({ machines: [dc01(net, { audit: { Logon: { success: true, failure: true } }, events })], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' }, ad: (st) => { const ou = addOu(st, 'Staff'); for (const p of people) addUser(st, p, ou); } }),
      checks: [ps('The account is identified', `Get-Content ${file}`, { contains: `Account: ${target.sam}` }), ps('The workstation is identified', `Get-Content ${file}`, { contains: `Workstation: ${ws}` }), ran('You queried event 4625', '4625')],
      solution: ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } | Group-Object TargetUserName | Sort-Object Count -Descending", `Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } | Where-Object { $_.TargetUserName -eq '${target.sam}' } | Group-Object WorkstationName`, `Set-Content ${file} "Account: ${target.sam}","Workstation: ${ws}"`],
      realityNote: 'Repeated lockouts are usually a phone, mapped drive or scheduled task with an old password; the 4625 and 4740 events name the source.',
    };
  }),
  tmpl(3, 5, 'advanced', 'who-added-an-admin', 'Investigate an unexpected Domain Admin', 'E4', 30, 'Trace a 4728 event to the account that granted admin rights, contain both accounts and record the findings.', (v) => {
    const net = v.net();
    const [actor, other, legit] = v.people(3);
    const added = v.pick(['svc_print2', 'helpdesk-tmp', 'scanner01', 'it-support2']);
    const at = `10/2${v.int(0, 1)}/2026 0${v.int(1, 4)}:${String(v.int(10, 59)).padStart(2, '0')}:00`;
    const decoyGroup = v.pick(['GG_Library_Staff', 'GG_Finance_Staff']);
    const file = 'C:\\Incident\\findings.txt';
    return {
      instructions: lab({
        situation: `The weekly privileged-group report shows a new Domain Admin, **${added}**, that nobody requested. Group membership auditing is on. Investigate from the Security log, contain it, and write up what you found. Do not delete anything: the accounts are evidence.`,
        steps: ['Find the 4728 events (member added to a security-enabled global group) and pick the one for Domain Admins.', 'Read who made the change (SubjectUserName) and when.', `Remove ${added} from Domain Admins and disable both ${added} and the account that added it.`, `Write **${file}** with \`Added: <account>\`, \`By: <account>\` and \`Time: <time>\`.`],
        tips: ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4728 } | Format-List TimeCreated,TargetUserName,MemberName,SubjectUserName", 'Disable-ADAccount -Identity SAM'],
      }),
      hints: ['TargetUserName in a 4728 event is the group; MemberName is who was added.', 'Disabling keeps the accounts for the investigation; deleting destroys evidence.'],
      initialState: system({ machines: [dc01(net, { audit: { 'Security Group Management': { success: true, failure: false } }, events: [secEvent(4728, `A member was added to a security-enabled global group. Group: ${decoyGroup}`, { TargetUserName: decoyGroup, MemberName: `CN=${other.name},OU=Staff,${DC}`, SubjectUserName: 'Administrator' }, '10/19/2026 10:05:00'), secEvent(4728, 'A member was added to a security-enabled global group. Group: Domain Admins', { TargetUserName: 'Domain Admins', MemberName: `CN=${added},OU=Staff,${DC}`, SubjectUserName: actor.sam }, at), secEvent(4728, `A member was added to a security-enabled global group. Group: ${decoyGroup}`, { TargetUserName: decoyGroup, MemberName: `CN=${legit.name},OU=Staff,${DC}`, SubjectUserName: 'Administrator' }, '10/21/2026 11:40:00')] })], ad: (st) => { const ou = addOu(st, 'Staff'); addUser(st, actor, ou, { department: 'ICT' }); addUser(st, other, ou); addUser(st, legit, ou); const a = addUser(st, { given: added, surname: '', name: added, sam: added }, ou); st.groups.find((x) => x.name === 'Domain Admins')!.members.push(a); } }),
      checks: [ps(`${added} is no longer a Domain Admin`, 'Get-ADGroupMember "Domain Admins" -Recursive', { notContains: added }), userCheck(`${added} is disabled, not deleted`, { sam: added, enabled: false }), userCheck(`${actor.sam}, who added it, is disabled pending investigation`, { sam: actor.sam, enabled: false }), userCheck(`${other.sam} and ${legit.sam} are untouched`, { sams: [other.sam, legit.sam], enabled: true }), ps('The findings are recorded', `Get-Content ${file}`, { contains: [`Added: ${added}`, `By: ${actor.sam}`, `Time: ${at}`] })],
      solution: ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4728 } | Format-List TimeCreated,TargetUserName,MemberName,SubjectUserName", `Remove-ADGroupMember -Identity "Domain Admins" -Members ${added}`, `Disable-ADAccount -Identity ${added}`, `Disable-ADAccount -Identity ${actor.sam}`, `New-Item C:\\Incident -ItemType Directory`, `Set-Content ${file} "Added: ${added}","By: ${actor.sam}","Time: ${at}"`],
      realityNote: 'Event 4728 on Domain Admins is one of the highest-priority alerts in any SOC; containment by disabling preserves the accounts and their history for forensics.',
    };
  }),
];
