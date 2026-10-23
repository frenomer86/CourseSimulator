/** Unit 6: Group Policy. */

import { newGpo, type AdState, type Gpo } from '@cslab/engine-shell/src/win/model';
import type { TaskTemplate } from '../types';
import { DC, HK, addGroup, addOu, addUser, dc01, extra, fs01, gpSet, lab, ouDn, pc, placeComputer, policy, ps, system, tmpl } from './kit';

const DEPTS = ['Finance', 'Registry', 'Library', 'Procurement', 'Estates', 'Admissions', 'Examinations', 'Research'];

/** Adds a GPO with settings and links to the directory. */
function addGpo(st: AdState, name: string, o: { user?: Record<string, string | number>; computer?: Record<string, string | number>; extras?: Record<string, string>; links?: Array<{ target: string; order?: number; enforced?: boolean; enabled?: boolean }>; apply?: string[]; userEnabled?: boolean; computerEnabled?: boolean }): Gpo {
  const g = newGpo(name);
  g.user = { ...(o.user ?? {}) };
  g.computer = { ...(o.computer ?? {}) };
  g.extras = { ...(o.extras ?? {}) };
  for (const l of o.links ?? []) {
    const order = l.order ?? st.gpos.flatMap((x) => x.links).filter((x) => x.target.toLowerCase() === l.target.toLowerCase()).length + 1;
    g.links.push({ target: l.target, order, enforced: !!l.enforced, enabled: l.enabled ?? true });
  }
  if (o.apply) g.apply = o.apply;
  if (o.userEnabled === false) g.userEnabled = false;
  if (o.computerEnabled === false) g.computerEnabled = false;
  g.version = 3;
  st.gpos.push(g);
  return g;
}

export const U6: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 6.1 structure, linking, inheritance, filtering */
  tmpl(6, 1, 'beginner', 'link-a-gpo', 'Create and link your first GPO', 'E4', 15, 'Create a GPO with one user setting and link it to the OU it should affect.', (v) => {
    const net = v.net();
    const [stu, staff] = v.people(2);
    const labPc = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const gpo = v.pick(['Students - No Control Panel', 'Student Desktop', 'Students Restrictions']);
    return {
      instructions: lab({
        situation: `Students keep changing display and network settings on lab PCs through Control Panel. Create a GPO **${gpo}** that turns on **Prohibit access to Control Panel and PC settings** (HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer, NoControlPanel = 1) and link it to **OU=Students**. Staff must not be affected.`,
        steps: ['Create the GPO.', 'Set the registry-based policy with Set-GPRegistryValue (DWord 1).', 'Link it to OU=Students.', `Check the result for ${stu.sam} on ${labPc}.`],
        tips: [`New-GPO -Name "${gpo}"`, gpSet(gpo, HK.noControlPanel, 'DWord', 1), `New-GPLink -Name "${gpo}" -Target "${ouDn('Students')}"`],
      }),
      hints: ['A GPO does nothing until it is linked.', 'User settings follow the user account\'s OU.'],
      initialState: system({ machines: [dc01(net), pc(labPc, net, 70)], ad: (st) => { addUser(st, stu, addOu(st, 'Students')); addUser(st, staff, addOu(st, 'Staff')); placeComputer(st, labPc, addOu(st, 'Labs')); } }),
      checks: [policy(`${stu.sam} has no Control Panel on ${labPc}`, HK.noControlPanel, labPc, 1, stu.sam), policy(`${staff.sam} (staff) keeps Control Panel`, HK.noControlPanel, labPc, null, staff.sam)],
      solution: [`New-GPO -Name "${gpo}"`, gpSet(gpo, HK.noControlPanel, 'DWord', 1), `New-GPLink -Name "${gpo}" -Target "${ouDn('Students')}"`],
      realityNote: 'Group Policy is how a few administrators configure thousands of Windows machines; registry-based administrative templates are most of what it sets.',
    };
  }),
  tmpl(6, 1, 'intermediate', 'filter-and-block', 'Use security filtering, blocking and enforcement', 'E4', 25, 'Target a GPO at one group, block inheritance for an OU and keep a baseline enforced.', (v) => {
    const net = v.net();
    const [lect, admin, ict] = v.people(3);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const t = v.pick(['600', '900', '1200']);
    return {
      instructions: lab({
        situation: `Three requests from the Group Policy change board:\n\n1. **ICT** manages its own desktops: OU=ICT must **block inheritance** from the domain, so the domain-linked **Campus Screensaver** stops applying there.\n2. But the domain-linked **Security Baseline** (password-protected screen saver) must apply **everywhere**, ICT included.\n3. Lecturers need an **L:** drive to \\\\FS01\\Lecturers. Create a GPO **Lecturer Drive**, link it to OU=Staff, and use **security filtering** so only **GG_Lecturers** gets it (keep Authenticated Users able to read the GPO).`,
        steps: ['Block inheritance on OU=ICT.', 'Enforce the Security Baseline link at the domain.', 'Create Lecturer Drive with the drive map, link it, and change its security filtering.', `Check ${ict.sam}, ${lect.sam} and ${admin.sam} on ${pcName}.`],
        tips: [`Set-GPInheritance -Target "${ouDn('ICT')}" -IsBlocked Yes`, `Set-GPLink -Name "Security Baseline" -Target "${DC}" -Enforced Yes`, 'Set-GPSetting -Name "Lecturer Drive" -Setting "Drive map" -Value "L:=\\\\FS01\\Lecturers"', 'Set-GPPermission -Name "Lecturer Drive" -TargetName GG_Lecturers -TargetType Group -PermissionLevel GpoApply', 'Set-GPPermission -Name "Lecturer Drive" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel GpoRead -Replace'],
      }),
      hints: ['Enforced links ignore blocked inheritance below them.', 'Security filtering needs Apply for the group and Read (without Apply) for Authenticated Users.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(pcName, net, 55)], ad: (st) => { const so = addOu(st, 'Staff'); const io = addOu(st, 'ICT'); const l = addUser(st, lect, so); addUser(st, admin, so); addUser(st, ict, io); addGroup(st, 'GG_Lecturers', 'Global', so, [l]); placeComputer(st, pcName, addOu(st, 'Computers')); addGpo(st, 'Campus Screensaver', { user: { [HK.ssTimeout]: t }, links: [{ target: DC }] }); addGpo(st, 'Security Baseline', { user: { [HK.ssSecure]: '1' }, links: [{ target: DC }] }); } }),
      checks: [policy(`Campus Screensaver no longer reaches ${ict.sam} (ICT)`, HK.ssTimeout, pcName, null, ict.sam), policy(`Security Baseline still reaches ${ict.sam}`, HK.ssSecure, pcName, '1', ict.sam), extra(`${lect.sam} (lecturer) gets L:`, 'User:Drive map', pcName, 'L:=\\\\FS01\\Lecturers', lect.sam), extra(`${admin.sam} (not a lecturer) does not`, 'User:Drive map', pcName, null, admin.sam), policy(`Campus Screensaver still reaches ${admin.sam}`, HK.ssTimeout, pcName, t, admin.sam)],
      solution: [`Set-GPInheritance -Target "${ouDn('ICT')}" -IsBlocked Yes`, `Set-GPLink -Name "Security Baseline" -Target "${DC}" -Enforced Yes`, 'New-GPO -Name "Lecturer Drive"', 'Set-GPSetting -Name "Lecturer Drive" -Setting "Drive map" -Value "L:=\\\\FS01\\Lecturers"', `New-GPLink -Name "Lecturer Drive" -Target "${ouDn('Staff')}"`, 'Set-GPPermission -Name "Lecturer Drive" -TargetName GG_Lecturers -TargetType Group -PermissionLevel GpoApply', 'Set-GPPermission -Name "Lecturer Drive" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel GpoRead -Replace'],
      realityNote: 'Since the MS16-072 update, security-filtered GPOs must still be readable by Authenticated Users or Domain Computers, or they silently stop applying.',
    };
  }),
  tmpl(6, 1, 'advanced', 'why-not-applied', 'Find why a GPO does not apply', 'E4', 25, 'Diagnose a disabled link, disabled user settings and broken security filtering from gpresult.', (v) => {
    const net = v.net();
    const users = v.people(2);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const gpo = v.pick(['Staff Lockdown', 'Staff Desktop Policy', 'Office Standard']);
    return {
      instructions: lab({
        situation: `**${gpo}** should remove Control Panel and turn on the screen saver for every user in **OU=Staff**. It was created months ago, but nobody gets it. gpresult says it is "filtered out". There is more than one fault.`,
        steps: [`Run Get-GPResultantSetOfPolicy (or gpresult /r) for ${users[0].sam} on ${pcName} and read why ${gpo} is not applied.`, 'Check the link, the GPO status and the security filtering (Get-GPInheritance, Get-GPO, Get-GPPermission).', 'Fix each fault until it applies.'],
        tips: [`Get-GPResultantSetOfPolicy -User ${users[0].sam} -Computer ${pcName}`, `Get-GPPermission -Name "${gpo}"`, `Set-GPLink -Name "${gpo}" -Target "${ouDn('Staff')}" -LinkEnabled Yes`, `Set-GPOStatus -Name "${gpo}" -Status AllSettingsEnabled`],
      }),
      hints: ['"Disabled (Link)", "Disabled (GPO)" and "Denied (Security)" are three different faults.', 'The only group allowed to apply it no longer has members.'],
      initialState: system({ machines: [dc01(net), pc(pcName, net, 56)], ad: (st) => { const so = addOu(st, 'Staff'); for (const u of users) addUser(st, u, so); addGroup(st, 'GG_Pilot_2024', 'Global', so); placeComputer(st, pcName, addOu(st, 'Computers')); addGpo(st, gpo, { user: { [HK.noControlPanel]: 1, [HK.ssActive]: '1' }, links: [{ target: so, enabled: false }], apply: ['GG_Pilot_2024'], userEnabled: false }); } }),
      checks: users.flatMap((u) => [policy(`${u.sam} has no Control Panel`, HK.noControlPanel, pcName, 1, u.sam), policy(`${u.sam} gets the screen saver`, HK.ssActive, pcName, '1', u.sam)]),
      solution: [`Get-GPResultantSetOfPolicy -User ${users[0].sam} -Computer ${pcName}`, `Set-GPLink -Name "${gpo}" -Target "${ouDn('Staff')}" -LinkEnabled Yes`, `Set-GPOStatus -Name "${gpo}" -Status AllSettingsEnabled`, `Set-GPPermission -Name "${gpo}" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel GpoApply`],
      realityNote: 'gpresult and the Group Policy Results wizard name the reason a GPO was filtered out; reading those reasons is most of GPO troubleshooting.',
    };
  }),

  /* ---------------------------------------------------------------- 6.2 templates, security settings, preferences, software, scripts */
  tmpl(6, 2, 'beginner', 'screen-lock', 'Lock idle screens with an administrative template', 'E4', 15, 'Configure screen saver, timeout and password protection for staff.', (v) => {
    const net = v.net();
    const [u] = v.people(1);
    const mins = v.pick([5, 10, 15]);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    return {
      instructions: lab({
        situation: `Auditors found unattended unlocked PCs in offices that handle student records. Create **Staff Screen Lock** linked to **OU=Staff** that turns on the screen saver, sets the timeout to **${mins} minutes** and **password-protects** it. These are user settings under HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop, all of type String: ScreenSaveActive "1", ScreenSaveTimeOut (seconds) and ScreenSaverIsSecure "1".`,
        steps: ['Create the GPO and set the three values.', 'Link it.', `Check ${u.sam} on ${pcName}.`],
        tips: [gpSet('Staff Screen Lock', HK.ssTimeout, 'String', mins * 60)],
      }),
      hints: [`${mins} minutes = ${mins * 60} seconds.`, 'These screen saver values are strings, not DWords.'],
      initialState: system({ machines: [dc01(net), pc(pcName, net, 57)], ad: (st) => { addUser(st, u, addOu(st, 'Staff')); placeComputer(st, pcName, addOu(st, 'Computers')); } }),
      checks: [policy('The screen saver is on', HK.ssActive, pcName, '1', u.sam), policy(`It starts after ${mins} minutes`, HK.ssTimeout, pcName, String(mins * 60), u.sam), policy('It asks for the password', HK.ssSecure, pcName, '1', u.sam)],
      solution: ['New-GPO -Name "Staff Screen Lock"', gpSet('Staff Screen Lock', HK.ssActive, 'String', 1), gpSet('Staff Screen Lock', HK.ssTimeout, 'String', mins * 60), gpSet('Staff Screen Lock', HK.ssSecure, 'String', 1), `New-GPLink -Name "Staff Screen Lock" -Target "${ouDn('Staff')}"`],
      realityNote: 'Automatic screen locking is a control in ISO 27001 (A.8.1 user endpoint devices) and in the CIS benchmarks for Windows.',
    };
  }),
  tmpl(6, 2, 'intermediate', 'preferences-and-scripts', 'Map a drive, run a logon script and set a preference', 'E4', 25, 'Use a logon script in NETLOGON, a drive-map preference and a registry preference in one GPO.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [u] = v.people(1);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const script = `${dept.toLowerCase()}-logon.ps1`;
    const gpo = `${dept} User Settings`;
    return {
      instructions: lab({
        situation: `${dept} wants three things at logon, all in one GPO **${gpo}** linked to **OU=${dept},OU=Staff**:\n\n1. A logon script **${script}** stored in **\\\\campus.local\\NETLOGON** that writes a welcome message.\n2. Drive **H:** mapped to \\\\FS01\\Home$\\%USERNAME% (a drive-map preference).\n3. A registry preference HKCU\\Software\\Campus, value **Department** = "${dept}", so a departmental app knows who it is talking to.`,
        steps: [`Create the script in NETLOGON with Set-Content.`, 'Create and link the GPO.', 'Add the logon script, the drive map and the registry preference.', `Check what ${u.sam} gets on ${pcName}.`],
        tips: [`Set-Content \\\\campus.local\\NETLOGON\\${script} 'Write-Host "Welcome to ${dept}"'`, `Set-GPSetting -Name "${gpo}" -Setting "Logon script" -Value \\\\campus.local\\NETLOGON\\${script}`, `Set-GPPrefRegistryValue -Name "${gpo}" -Context User -Key "HKCU\\Software\\Campus" -ValueName Department -Type String -Value "${dept}" -Action Update`],
      }),
      hints: ['NETLOGON is replicated to every DC with SYSVOL, so scripts there are reachable from anywhere in the domain.', 'Preferences set a value once and let users change it; policies enforce it.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(pcName, net, 58)], ad: (st) => { addOu(st, 'Staff'); addUser(st, u, addOu(st, dept, ouDn('Staff'))); placeComputer(st, pcName, addOu(st, 'Computers')); }, files: { 'C:\\Windows\\SYSVOL\\sysvol\\campus.local\\scripts\\README.txt': 'Logon scripts live here.\n' } }),
      checks: [ps('The script is in NETLOGON', `Test-Path \\\\campus.local\\NETLOGON\\${script}`, { equals: 'True' }), extra(`${u.sam} runs the logon script`, 'User:Logon script', pcName, `\\\\campus.local\\NETLOGON\\${script}`, u.sam), extra(`${u.sam} gets H:`, 'User:Drive map', pcName, 'H:=\\\\FS01\\Home$\\%USERNAME%', u.sam), extra(`${u.sam} gets the Department preference`, 'User:Preference HKCU\\Software\\Campus|Department', pcName, dept, u.sam)],
      solution: [`Set-Content \\\\campus.local\\NETLOGON\\${script} 'Write-Host "Welcome to ${dept}"'`, `New-GPO -Name "${gpo}"`, `New-GPLink -Name "${gpo}" -Target "${ouDn(dept, 'Staff')}"`, `Set-GPSetting -Name "${gpo}" -Setting "Logon script" -Value \\\\campus.local\\NETLOGON\\${script}`, `Set-GPSetting -Name "${gpo}" -Setting "Drive map" -Value 'H:=\\\\FS01\\Home$\\%USERNAME%'`, `Set-GPPrefRegistryValue -Name "${gpo}" -Context User -Key "HKCU\\Software\\Campus" -ValueName Department -Type String -Value "${dept}" -Action Update`],
      realityNote: 'Group Policy Preferences replaced most logon-script drive mapping; scripts are still used for tasks preferences cannot do.',
    };
  }),
  tmpl(6, 2, 'advanced', 'software-deployment', 'Deploy software to lab computers', 'E4', 30, 'Publish an MSI on a share computers can read and assign it to lab machines only.', (v) => {
    const net = v.net();
    const msi = v.pick(['7zip-23.01-x64.msi', 'vlc-3.0.20-win64.msi', 'python-3.12.4-amd64.msi', 'gimp-2.10.msi']);
    const labPc = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const officePc = `OFF-PC${v.int(10, 60)}`;
    return {
      instructions: lab({
        situation: `Every lab PC needs **${msi}** (on FS01 at D:\\Software). Software assigned to **computers** installs at startup, before anyone logs on, and runs as the computer account, so the package must be on a share that **Domain Computers** can read and must be referenced by its **UNC path**, never a local path. Office PCs must not get it.`,
        steps: ['Share D:\\Software on FS01 as **Software$**, with Read for Domain Computers.', `Create **Lab Software**, assign \\\\FS01\\Software$\\${msi} as computer software installation, and link it to OU=Labs.`, `Check ${labPc} and ${officePc}.`],
        tips: ['New-SmbShare -Name Software$ -Path D:\\Software -ReadAccess "Domain Computers" -FullAccess Administrators', `Set-GPSetting -Name "Lab Software" -Setting "Software installation" -Value \\\\FS01\\Software$\\${msi}`],
      }),
      hints: ['A D:\\ path means nothing to a lab PC.', 'Computer settings follow the computer account\'s OU.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(labPc, net, 71), pc(officePc, net, 59)], ad: (st) => { placeComputer(st, labPc, addOu(st, 'Labs')); placeComputer(st, officePc, addOu(st, 'Offices')); }, machineFiles: { FS01: { [`D:\\Software\\${msi}`]: 'MSI package\n' } } }),
      checks: [ps('Software$ is readable by Domain Computers', 'Get-SmbShareAccess -Name Software$ | ForEach-Object { $_.AccountName }', { machine: 'FS01', contains: 'Domain Computers' }), extra(`${labPc} is assigned ${msi}`, 'Computer:Software installation', labPc, `\\\\FS01\\Software$\\${msi}`), extra(`${officePc} is not`, 'Computer:Software installation', officePc, null), ps('The package is reachable by UNC path', `Test-Path \\\\FS01\\Software$\\${msi}`, { equals: 'True' })],
      solution: ['Invoke-Command -ComputerName FS01 -ScriptBlock { New-SmbShare -Name Software$ -Path D:\\Software -ReadAccess "Domain Computers" -FullAccess Administrators }', 'New-GPO -Name "Lab Software"', `Set-GPSetting -Name "Lab Software" -Setting "Software installation" -Value \\\\FS01\\Software$\\${msi}`, `New-GPLink -Name "Lab Software" -Target "${ouDn('Labs')}"`],
      realityNote: 'GPO software installation still works for MSI packages; larger estates move to Intune or Configuration Manager, which use the same "assign to machines" idea.',
    };
  }),

  /* ---------------------------------------------------------------- 6.3 common policies */
  tmpl(6, 3, 'beginner', 'drive-mapping', 'Map a department drive with Group Policy', 'E4', 15, 'Give one department a mapped drive through a GPO linked to its OU.', (v) => {
    const net = v.net();
    const [d1, d2] = v.some(DEPTS, 2);
    const letter = v.pick(['S', 'T', 'P', 'G']);
    const [u1, u2] = v.people(2);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    return {
      instructions: lab({
        situation: `${d1} staff map **${letter}:** to **\\\\FS01\\${d1}** by hand, and get it wrong. Create **Drive ${letter} - ${d1}**, map the drive with a drive-map preference, and link it to **OU=${d1},OU=Staff**. ${d2} staff must not get it.`,
        steps: ['Create the GPO and the drive map.', 'Link it.', `Check ${u1.sam} and ${u2.sam} on ${pcName}.`],
        tips: [`Set-GPSetting -Name "Drive ${letter} - ${d1}" -Setting "Drive map" -Value "${letter}:=\\\\FS01\\${d1}"`],
      }),
      hints: ['Drive maps are user settings.', 'The value is LETTER:=\\\\server\\share.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(pcName, net, 53)], ad: (st) => { addOu(st, 'Staff'); addUser(st, u1, addOu(st, d1, ouDn('Staff'))); addUser(st, u2, addOu(st, d2, ouDn('Staff'))); placeComputer(st, pcName, addOu(st, 'Computers')); } }),
      checks: [extra(`${u1.sam} (${d1}) gets ${letter}:`, 'User:Drive map', pcName, `${letter}:=\\\\FS01\\${d1}`, u1.sam), extra(`${u2.sam} (${d2}) does not`, 'User:Drive map', pcName, null, u2.sam)],
      solution: [`New-GPO -Name "Drive ${letter} - ${d1}"`, `Set-GPSetting -Name "Drive ${letter} - ${d1}" -Setting "Drive map" -Value "${letter}:=\\\\FS01\\${d1}"`, `New-GPLink -Name "Drive ${letter} - ${d1}" -Target "${ouDn(d1, 'Staff')}"`],
      realityNote: 'Mapped drives through Group Policy Preferences are the most common GPO in most organisations.',
    };
  }),
  tmpl(6, 3, 'intermediate', 'lab-restrictions', 'Restrict student desktops and block USB storage in labs', 'E4', 25, 'Apply user restrictions to students and a computer USB block to lab PCs.', (v) => {
    const net = v.net();
    const [stu, staff] = v.people(2);
    const labPc = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const offPc = `OFF-PC${v.int(10, 60)}`;
    return {
      instructions: lab({
        situation: 'Exam season. The lab policy says:\n\n- **Students** (OU=Students): no Task Manager, no Run dialog, no Control Panel. GPO **Student Restrictions**.\n- **Lab PCs** (OU=Labs): USB storage disabled whoever logs on (HKLM\\System\\CurrentControlSet\\Services\\USBSTOR, Start = 4). GPO **Lab USB Block**.\n\nStaff and office PCs keep everything.',
        steps: ['Create Student Restrictions with the three user settings and link it to OU=Students.', 'Create Lab USB Block with the computer setting and link it to OU=Labs.', 'Check a student and a staff member on a lab PC, and the office PC.'],
        tips: [gpSet('Student Restrictions', HK.disableTaskMgr, 'DWord', 1), gpSet('Lab USB Block', HK.usbStor, 'DWord', 4)],
      }),
      hints: ['User settings follow the user, computer settings the computer.', 'Start = 4 means the USB storage driver is disabled.'],
      initialState: system({ machines: [dc01(net), pc(labPc, net, 72), pc(offPc, net, 54)], ad: (st) => { addUser(st, stu, addOu(st, 'Students')); addUser(st, staff, addOu(st, 'Staff')); placeComputer(st, labPc, addOu(st, 'Labs')); placeComputer(st, offPc, addOu(st, 'Offices')); } }),
      checks: [policy(`${stu.sam} has no Task Manager`, HK.disableTaskMgr, labPc, 1, stu.sam), policy(`${stu.sam} has no Run`, HK.noRun, labPc, 1, stu.sam), policy(`${stu.sam} has no Control Panel`, HK.noControlPanel, labPc, 1, stu.sam), policy(`${staff.sam} keeps Control Panel`, HK.noControlPanel, labPc, null, staff.sam), policy(`USB storage is off on ${labPc}`, HK.usbStor, labPc, 4), policy(`USB storage is untouched on ${offPc}`, HK.usbStor, offPc, null)],
      solution: ['New-GPO -Name "Student Restrictions"', gpSet('Student Restrictions', HK.disableTaskMgr, 'DWord', 1), gpSet('Student Restrictions', HK.noRun, 'DWord', 1), gpSet('Student Restrictions', HK.noControlPanel, 'DWord', 1), `New-GPLink -Name "Student Restrictions" -Target "${ouDn('Students')}"`, 'New-GPO -Name "Lab USB Block"', gpSet('Lab USB Block', HK.usbStor, 'DWord', 4), `New-GPLink -Name "Lab USB Block" -Target "${ouDn('Labs')}"`],
      realityNote: 'Blocking removable storage on shared machines is a common data-protection and malware control; exam halls often add it temporarily.',
    };
  }),
  tmpl(6, 3, 'advanced', 'windows-update-policy', 'Point workstations and servers at WSUS with different schedules', 'E4', 30, 'Configure intranet update server, client-side targeting and install behaviour per machine type.', (v) => {
    const net = v.net();
    const ws = `OFF-PC${v.int(10, 60)}`;
    const srv = v.pick(['APP01', 'FS02', 'WEB01']);
    const day = v.pick([[0, 'every day'], [3, 'Tuesdays'], [4, 'Wednesdays']] as const);
    const hour = v.pick([2, 3, 4]);
    const url = 'http://WSUS01:8530';
    const common = (g: string, target: string) => [`New-GPO -Name "${g}"`, gpSet(g, HK.wuServer, 'String', url), gpSet(g, HK.wuStatus, 'String', url), gpSet(g, HK.useWu, 'DWord', 1), gpSet(g, HK.targetGroupOn, 'DWord', 1), gpSet(g, HK.targetGroup, 'String', target)];
    return {
      instructions: lab({
        situation: `WSUS01 (${url}) is ready. Configure clients through two GPOs:\n\n- **WSUS - Workstations** on **OU=Workstations**: install automatically (**AUOptions 4**), scheduled ${day[1]} (**ScheduledInstallDay ${day[0]}**) at **${hour}:00** (**ScheduledInstallTime ${hour}**), WSUS target group **Workstations**.\n- **WSUS - Servers** on **OU=Servers**: download and notify only (**AUOptions 3**), so admins choose the reboot; target group **Servers**.\n\nBoth: WUServer and WUStatusServer = ${url}, UseWUServer = 1, TargetGroupEnabled = 1.`,
        steps: ['Create and link both GPOs.', 'Set the shared values in both, then the different ones.', `Check ${ws} and ${srv}.`],
        tips: [gpSet('WSUS - Workstations', HK.wuServer, 'String', url), gpSet('WSUS - Workstations', HK.auOptions, 'DWord', 4)],
      }),
      hints: ['The WindowsUpdate key holds WUServer, WUStatusServer and the target group; the AU subkey holds AUOptions, UseWUServer and the schedule.', 'Servers rarely auto-install: an unplanned reboot of a server is an outage.'],
      initialState: system({ machines: [dc01(net), pc(ws, net, 62), { name: srv, nics: [{ alias: 'Ethernet', mac: '00-15-5D-0C-0D-0E', dhcp: false, ip: `${net}.35`, prefix: 24, gateway: `${net}.1`, dns: [`${net}.10`], profile: 'DomainAuthenticated', up: true }] }], ad: (st) => { placeComputer(st, ws, addOu(st, 'Workstations')); placeComputer(st, srv, addOu(st, 'Servers')); } }),
      checks: [policy(`${ws} uses WSUS01`, HK.wuServer, ws, url), policy(`${ws} installs automatically`, HK.auOptions, ws, 4), policy(`${ws} installs ${day[1]}`, HK.installDay, ws, day[0]), policy(`${ws} installs at ${hour}:00`, HK.installTime, ws, hour), policy(`${ws} is in the Workstations target group`, HK.targetGroup, ws, 'Workstations'), policy(`${srv} uses WSUS01`, HK.useWu, srv, 1), policy(`${srv} only downloads and notifies`, HK.auOptions, srv, 3), policy(`${srv} is in the Servers target group`, HK.targetGroup, srv, 'Servers')],
      solution: [...common('WSUS - Workstations', 'Workstations'), gpSet('WSUS - Workstations', HK.auOptions, 'DWord', 4), gpSet('WSUS - Workstations', HK.installDay, 'DWord', day[0]), gpSet('WSUS - Workstations', HK.installTime, 'DWord', hour), `New-GPLink -Name "WSUS - Workstations" -Target "${ouDn('Workstations')}"`, ...common('WSUS - Servers', 'Servers'), gpSet('WSUS - Servers', HK.auOptions, 'DWord', 3), `New-GPLink -Name "WSUS - Servers" -Target "${ouDn('Servers')}"`],
      realityNote: 'Separate update rings for workstations and servers, with client-side targeting into WSUS groups, is the standard on-premises patching design.',
    };
  }),

  /* ---------------------------------------------------------------- 6.4 processing order, loopback, RSoP */
  tmpl(6, 4, 'beginner', 'read-rsop', 'Read the Resultant Set of Policy', 'E4', 15, 'Use gpresult data to find the winning value of a conflicting setting and the GPO it came from.', (v) => {
    const net = v.net();
    const [u] = v.people(1);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const domainT = v.pick(['900', '1200']);
    const ouT = v.pick(['300', '600']);
    const enforced = v.random() < 0.5;
    const win = enforced ? { t: domainT, g: 'Campus Screensaver' } : { t: ouT, g: 'Staff Screensaver' };
    const file = 'C:\\Answers\\rsop.txt';
    return {
      instructions: lab({
        situation: `Two GPOs set the screen saver timeout: **Campus Screensaver** (linked to the domain${enforced ? ', enforced' : ''}) and **Staff Screensaver** (linked to OU=Staff). ${u.name} asks why the screen locks when it does. Find the winning timeout for ${u.sam} on ${pcName}, and the GPO it comes from.`,
        steps: [`Run Get-GPResultantSetOfPolicy -User ${u.sam} -Computer ${pcName} (gpresult /r /user CAMPUS\\${u.sam} /s ${pcName} gives the same).`, 'Read "Winning settings".', `Write **${file}** with \`Timeout: <seconds>\` and \`From: <GPO name>\`.`],
        tips: [`Get-GPResultantSetOfPolicy -User ${u.sam} -Computer ${pcName}`],
      }),
      hints: ['Normally the GPO closest to the object (the OU) wins.', 'An enforced link wins over everything below it.'],
      initialState: system({ machines: [dc01(net), pc(pcName, net, 63)], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' }, ad: (st) => { const so = addOu(st, 'Staff'); addUser(st, u, so); placeComputer(st, pcName, addOu(st, 'Computers')); addGpo(st, 'Campus Screensaver', { user: { [HK.ssTimeout]: domainT }, links: [{ target: DC, enforced }] }); addGpo(st, 'Staff Screensaver', { user: { [HK.ssTimeout]: ouT }, links: [{ target: so }] }); } }),
      checks: [ps('The winning timeout is recorded', `Get-Content ${file}`, { contains: `Timeout: ${win.t}` }), ps('The winning GPO is recorded', `Get-Content ${file}`, { contains: `From: ${win.g}` })],
      solution: [`Get-GPResultantSetOfPolicy -User ${u.sam} -Computer ${pcName}`, `Set-Content ${file} "Timeout: ${win.t}","From: ${win.g}"`],
      realityNote: 'LSDOU order (local, site, domain, OU) with enforcement on top is the rule every Group Policy question comes back to.',
    };
  }),
  tmpl(6, 4, 'intermediate', 'link-order', 'Make the exam policy win with link order', 'E4', 20, 'Enable a link and change link order on an OU so one GPO beats another.', (v) => {
    const net = v.net();
    const [stu] = v.people(1);
    const pcName = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const normal = v.pick(['900', '1200']);
    const exam = v.pick(['120', '180', '300']);
    return {
      instructions: lab({
        situation: `OU=Students has two GPOs: **Student Standard** (screen saver after ${normal} seconds, link order 1) and **Exam Mode** (screen saver after ${exam} seconds and no Run dialog), whose link is currently **disabled**. For exam week, Exam Mode must be on and must **win** where the two conflict.`,
        steps: ['Look at the links with Get-GPInheritance on OU=Students.', 'Enable the Exam Mode link.', 'Move Exam Mode to link order 1 (order 1 has the highest precedence).', `Check ${stu.sam} on ${pcName}.`],
        tips: [`Get-GPInheritance -Target "${ouDn('Students')}"`, `Set-GPLink -Name "Exam Mode" -Target "${ouDn('Students')}" -LinkEnabled Yes -Order 1`],
      }),
      hints: ['On the same OU, the link with order 1 is applied last and wins.'],
      initialState: system({ machines: [dc01(net), pc(pcName, net, 73)], ad: (st) => { const so = addOu(st, 'Students'); addUser(st, stu, so); placeComputer(st, pcName, addOu(st, 'Labs')); addGpo(st, 'Student Standard', { user: { [HK.ssTimeout]: normal }, links: [{ target: so, order: 1 }] }); addGpo(st, 'Exam Mode', { user: { [HK.ssTimeout]: exam, [HK.noRun]: 1 }, links: [{ target: so, order: 2, enabled: false }] }); } }),
      checks: [policy('Exam Mode wins the timeout', HK.ssTimeout, pcName, exam, stu.sam), policy('Exam Mode removes Run', HK.noRun, pcName, 1, stu.sam), ps('Exam Mode is link order 1', `Get-GPInheritance -Target "${ouDn('Students')}" | ForEach-Object { $_.GpoLinks }`, { contains: '1: Exam Mode' })],
      solution: [`Get-GPInheritance -Target "${ouDn('Students')}"`, `Set-GPLink -Name "Exam Mode" -Target "${ouDn('Students')}" -LinkEnabled Yes -Order 1`],
      realityNote: 'Link order is the quiet tiebreaker in Group Policy; disabling a link (rather than deleting it) is a safe way to switch seasonal policies on and off.',
    };
  }),
  tmpl(6, 4, 'advanced', 'loopback', 'Apply lab user settings to everyone with loopback', 'E4', 30, 'Use loopback replace mode so lab PCs give every user the lab\'s user settings and nothing else.', (v) => {
    const net = v.net();
    const [staff, stu] = v.people(2);
    const labPc = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const offPc = `OFF-PC${v.int(10, 60)}`;
    return {
      instructions: lab({
        situation: `**Lab Lockdown** is linked to **OU=Labs** (where the lab PCs are) and has user settings: no Control Panel, no Task Manager. Nobody gets them, because user settings follow the user's OU, and staff who teach in labs still get their **Staff Drives** GPO (a mapped drive) on lab PCs. Someone also disabled Lab Lockdown's user settings "to speed up logons".\n\nRequirement: **anyone** signing in to a lab PC gets exactly the lab user settings and **nothing from their own OU** (loopback **replace** mode). Office PCs must behave normally.`,
        steps: ['Re-enable all settings in Lab Lockdown.', 'Turn on loopback in Lab Lockdown: HKLM\\Software\\Policies\\Microsoft\\Windows\\System, UserPolicyMode = 2 (replace; 1 is merge).', `Check ${staff.sam} and ${stu.sam} on ${labPc}, and ${staff.sam} on ${offPc}.`],
        tips: ['Set-GPOStatus -Name "Lab Lockdown" -Status AllSettingsEnabled', gpSet('Lab Lockdown', HK.loopback, 'DWord', 2)],
      }),
      hints: ['Loopback is a computer setting, so it lives in a GPO that applies to the lab computers.', 'Merge would add the lab settings but keep the staff drive map.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(labPc, net, 74), pc(offPc, net, 64)], ad: (st) => { const so = addOu(st, 'Staff'); addUser(st, staff, so); addUser(st, stu, addOu(st, 'Students')); const lo = addOu(st, 'Labs'); placeComputer(st, labPc, lo); placeComputer(st, offPc, addOu(st, 'Offices')); addGpo(st, 'Lab Lockdown', { user: { [HK.noControlPanel]: 1, [HK.disableTaskMgr]: 1 }, computer: { [HK.usbStor]: 4 }, links: [{ target: lo }], userEnabled: false }); addGpo(st, 'Staff Drives', { extras: { 'User:Drive map': 'S:=\\\\FS01\\Staff' }, links: [{ target: so }] }); } }),
      checks: [policy(`Loopback replace is on for ${labPc}`, HK.loopback, labPc, 2), policy(`${staff.sam} gets the lab lockdown on ${labPc}`, HK.noControlPanel, labPc, 1, staff.sam), policy(`${stu.sam} gets it too`, HK.disableTaskMgr, labPc, 1, stu.sam), extra(`${staff.sam}'s staff drive does not follow them into the lab (replace, not merge)`, 'User:Drive map', labPc, null, staff.sam), extra(`${staff.sam} keeps the staff drive on ${offPc}`, 'User:Drive map', offPc, 'S:=\\\\FS01\\Staff', staff.sam), policy(`${staff.sam} keeps Control Panel on ${offPc}`, HK.noControlPanel, offPc, null, staff.sam)],
      solution: ['Set-GPOStatus -Name "Lab Lockdown" -Status AllSettingsEnabled', gpSet('Lab Lockdown', HK.loopback, 'DWord', 2)],
      realityNote: 'Loopback processing is the standard answer for labs, kiosks and Remote Desktop session hosts, where the machine, not the person, decides the experience.',
    };
  }),

  /* ---------------------------------------------------------------- 6.5 central store and version control */
  tmpl(6, 5, 'beginner', 'central-store', 'Create the Group Policy central store', 'E4', 15, 'Copy the ADMX templates to SYSVOL and add a vendor template.', (v) => {
    const net = v.net();
    const vendor = v.pick(['msedge.admx', 'chrome.admx', 'office16.admx', 'zoom.admx']);
    const lang = vendor.replace('.admx', '.adml');
    const store = '\\\\campus.local\\SYSVOL\\campus.local\\Policies\\PolicyDefinitions';
    return {
      instructions: lab({
        situation: `Every admin edits GPOs with whatever templates are on their own PC, so settings appear and disappear between consoles. Create the **central store**: copy C:\\Windows\\PolicyDefinitions (with its en-US folder) to **${store}**, then add the vendor template **${vendor}** (and its en-US language file) from C:\\Downloads\\ADMX.`,
        steps: ['Copy the whole PolicyDefinitions folder into \\\\campus.local\\SYSVOL\\campus.local\\Policies.', `Copy ${vendor} into the store, and ${lang} into its en-US folder.`, 'Check with Test-Path.'],
        tips: ['Copy-Item C:\\Windows\\PolicyDefinitions \\\\campus.local\\SYSVOL\\campus.local\\Policies\\ -Recurse', `Copy-Item C:\\Downloads\\ADMX\\${vendor} ${store}\\`],
      }),
      hints: ['SYSVOL replicates to every DC, so every console sees the same templates.', 'ADMX files are language-neutral; ADML files hold the text for one language.'],
      initialState: system({ machines: [dc01(net)], files: { 'C:\\Windows\\PolicyDefinitions\\windows.admx': '<policyDefinitions/>\n', 'C:\\Windows\\PolicyDefinitions\\inetres.admx': '<policyDefinitions/>\n', 'C:\\Windows\\PolicyDefinitions\\en-US\\windows.adml': '<policyDefinitionResources/>\n', [`C:\\Downloads\\ADMX\\${vendor}`]: '<policyDefinitions vendor/>\n', [`C:\\Downloads\\ADMX\\en-US\\${lang}`]: '<policyDefinitionResources vendor/>\n', 'C:\\Windows\\SYSVOL\\sysvol\\campus.local\\Policies\\README.txt': 'GPO folders live here.\n' } }),
      checks: [ps('The Windows templates are in the store', `Test-Path ${store}\\windows.admx`, { equals: 'True' }), ps('The language files came too', `Test-Path ${store}\\en-US\\windows.adml`, { equals: 'True' }), ps(`${vendor} is in the store`, `Test-Path ${store}\\${vendor}`, { equals: 'True' }), ps(`${lang} is in en-US`, `Test-Path ${store}\\en-US\\${lang}`, { equals: 'True' })],
      solution: ['Copy-Item C:\\Windows\\PolicyDefinitions \\\\campus.local\\SYSVOL\\campus.local\\Policies\\ -Recurse', `Copy-Item C:\\Downloads\\ADMX\\${vendor} ${store}\\`, `Copy-Item C:\\Downloads\\ADMX\\en-US\\${lang} ${store}\\en-US\\`],
      realityNote: 'The central store is a Microsoft best practice since Windows Vista-era ADMX; browser and Office vendors ship ADMX files for exactly this folder.',
    };
  }),
  tmpl(6, 5, 'intermediate', 'backup-gpos', 'Back up every GPO and produce a report', 'E4', 20, 'Back up all GPOs to a dated folder and export an HTML report for change records.', (v) => {
    const net = v.net();
    const extraGpos = v.some(['Staff Screen Lock', 'Lab USB Block', 'Student Restrictions', 'Printers - Finance', 'WSUS - Workstations'], v.int(2, 4));
    const date = `2026-10-${String(v.int(10, 28))}`;
    const dir = `C:\\GPOBackups\\${date}`;
    const total = extraGpos.length + 2;
    return {
      instructions: lab({
        situation: `Before the Group Policy change window, the change procedure requires a backup of **every** GPO in **${dir}**, plus an HTML report of all GPOs saved as **${dir}\\report.html** for the change record.`,
        steps: ['Back up all GPOs with Backup-GPO -All.', 'Generate the report with Get-GPOReport -All -ReportType Html -Path.', `Check that there is one backup per GPO (${total}).`],
        tips: [`Backup-GPO -All -Path ${dir}`, `Get-GPOReport -All -ReportType Html -Path ${dir}\\report.html`],
      }),
      hints: ['Backups hold settings, not links: record links separately (the report has them).', 'Get-GPO -All counts the GPOs.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { for (const g of extraGpos) addGpo(st, g, { user: { [HK.noRun]: 1 } }); } }),
      checks: [ps(`${total} GPO backups exist`, `(Get-ChildItem ${dir} -Recurse | Where-Object { $_.Name -like '*gpo.json' } | Measure-Object).Count`, { equals: String(total) }), ps('The report exists', `Test-Path ${dir}\\report.html`, { equals: 'True' }), ps('The report names every GPO', `Get-Content ${dir}\\report.html`, { contains: extraGpos })],
      solution: [`Backup-GPO -All -Path ${dir}`, `Get-GPOReport -All -ReportType Html -Path ${dir}\\report.html`],
      realityNote: 'Scheduled GPO backups and reports are the simplest form of version control for Group Policy; tools such as AGPM add check-in and approval.',
    };
  }),
  tmpl(6, 5, 'advanced', 'restore-gpos', 'Recover from a bad GPO change and a deleted GPO', 'E4', 30, 'Restore a damaged GPO from backup, bring back a deleted one and relink it.', (v) => {
    const net = v.net();
    const [u] = v.people(1);
    const labPc = `LAB-${v.int(1, 4)}-${String(v.int(1, 30)).padStart(2, '0')}`;
    const offPc = `OFF-PC${v.int(10, 60)}`;
    const good = v.pick(['300', '600', '900']);
    const back = (g: Gpo) => JSON.stringify(g);
    const staffGood = newGpo('Staff Screen Lock');
    staffGood.user = { [HK.ssActive]: '1', [HK.ssTimeout]: good, [HK.ssSecure]: '1' };
    staffGood.version = 4;
    const labGood = newGpo('Lab USB Block');
    labGood.computer = { [HK.usbStor]: 4 };
    labGood.version = 2;
    return {
      instructions: lab({
        situation: `Last night's change went wrong. **Staff Screen Lock** was edited and now turns the screen saver **off**, and **Lab USB Block** was **deleted** outright. Last week's backups are in **C:\\GPOBackups**. Restore both. Remember that backups do not hold links: a deleted GPO comes back unlinked. Lab USB Block belonged on **OU=Labs**.`,
        steps: ['See what is in the backup folder.', 'Restore Staff Screen Lock from the backup (it keeps its existing links).', 'Restore Lab USB Block and link it again.', `Check ${u.sam} on ${offPc} and ${labPc}.`],
        tips: ['Restore-GPO -Name "Staff Screen Lock" -Path C:\\GPOBackups', `New-GPLink -Name "Lab USB Block" -Target "${ouDn('Labs')}"`],
      }),
      hints: ['Restore-GPO puts back the settings of the newest backup with that name.', 'Get-GPInheritance shows which GPOs are linked to an OU.'],
      initialState: system({ machines: [dc01(net), pc(labPc, net, 75), pc(offPc, net, 65)], files: { 'C:\\GPOBackups\\{3A1F0C22-BACK-UP00-0000-000000000001}\\gpo.json': back(staffGood), 'C:\\GPOBackups\\{3A1F0C22-BACK-UP00-0000-000000000002}\\gpo.json': back(labGood) }, ad: (st) => { const so = addOu(st, 'Staff'); addUser(st, u, so); placeComputer(st, labPc, addOu(st, 'Labs')); placeComputer(st, offPc, addOu(st, 'Offices')); addGpo(st, 'Staff Screen Lock', { user: { [HK.ssActive]: '0', [HK.ssTimeout]: '0', [HK.ssSecure]: '0' }, links: [{ target: so }] }); } }),
      checks: [policy('The screen saver is back on for staff', HK.ssActive, offPc, '1', u.sam), policy(`The timeout is back to ${good}`, HK.ssTimeout, offPc, good, u.sam), policy(`USB storage is blocked on ${labPc} again`, HK.usbStor, labPc, 4), policy(`and still not on ${offPc}`, HK.usbStor, offPc, null)],
      solution: ['Get-ChildItem C:\\GPOBackups -Recurse', 'Restore-GPO -Name "Staff Screen Lock" -Path C:\\GPOBackups', 'Restore-GPO -Name "Lab USB Block" -Path C:\\GPOBackups', `New-GPLink -Name "Lab USB Block" -Target "${ouDn('Labs')}"`],
      realityNote: 'Most Group Policy outages are self-inflicted; a backup from before the change and knowledge that links are not in it turns a crisis into a ten-minute fix.',
    };
  }),
];

export { addGroup };
