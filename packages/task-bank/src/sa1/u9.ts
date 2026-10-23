/** Unit 9: server management and monitoring. */

import type { AdOu, AdUser } from '@cslab/engine-shell/src/win/model';
import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { DC, addOu, dataDisk, dc01, lab, nic, ouDn, pc, placeComputer, ps, svc, systemDisk, system, tmpl, userCheck, ouCheck } from './kit';

const baseServices = () => ({ Spooler: svc.running, W32Time: svc.running, WinRM: svc.running, LanmanServer: svc.running, Dnscache: svc.running, EventLog: svc.running });
const sysEvent = (id: number, level: 'Information' | 'Warning' | 'Error', source: string, message: string, time: string) => ({ log: 'System' as const, id, level, source, time, message });

export const U9: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 9.1 events, performance, tasks */
  tmpl(9, 1, 'beginner', 'read-events', 'Find a crashed service in the event log', 'E4', 15, 'Filter the System log for errors, identify the failed service and restart it.', (v) => {
    const net = v.net();
    const [name, display] = v.pick([['W3SVC', 'World Wide Web Publishing Service'], ['Spooler', 'Print Spooler'], ['DHCPServer', 'DHCP Server'], ['WsusService', 'WSUS Service']]);
    const time = `10/22/2026 0${v.int(1, 6)}:${String(v.int(10, 59)).padStart(2, '0')}:00`;
    const file = 'C:\\Answers\\incident.txt';
    return {
      instructions: lab({
        situation: `Users say an application on **APP01** stopped working overnight. The **System** log on APP01 records service crashes as **event 7034** (error). Find which service crashed and when, record it, and start the service again.`,
        steps: ['Read the System log errors on APP01 with Get-WinEvent -FilterHashtable (Level 2 = Error).', `Write **${file}** with \`Service: <service display name>\` and \`Time: <time of the event>\`.`, 'Start the service and check it is running.'],
        tips: ["Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 2 }", "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7034 } | Format-List TimeCreated,Message", 'Get-Service | Where-Object { $_.Status -eq "Stopped" }'],
      }),
      hints: ['Event 7034: "The ... service terminated unexpectedly".', 'The event names the display name; Get-Service shows the short name too.'],
      initialState: system({ machines: [dc01(net), { name: 'APP01', features: ['Web-Server', 'Print-Server', 'DHCP', 'UpdateServices'], nics: [nic(`${net}.30`, net)], services: { ...baseServices(), W3SVC: svc.running, DHCPServer: svc.running, WsusService: svc.running, [name]: { status: 'Stopped', start: 'Automatic' } }, events: [sysEvent(7036, 'Information', 'Service Control Manager', 'The Windows Update service entered the running state.', '10/22/2026 00:10:00'), sysEvent(7034, 'Error', 'Service Control Manager', `The ${display} service terminated unexpectedly. It has done this 1 time(s).`, time), sysEvent(1014, 'Warning', 'DNS Client Events', 'Name resolution for the name wpad timed out.', '10/22/2026 06:40:00')] }], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' } }),
      checks: [ps('The service is recorded', `Get-Content ${file}`, { contains: `Service: ${display}` }), ps('The time is recorded', `Get-Content ${file}`, { contains: `Time: ${time}` }), ps(`${name} is running again`, `(Get-Service ${name}).Status`, { machine: 'APP01', equals: 'Running' })],
      solution: ["Invoke-Command -ComputerName APP01 -ScriptBlock { Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 2 } }", `Set-Content ${file} "Service: ${display}","Time: ${time}"`, `Invoke-Command -ComputerName APP01 -ScriptBlock { Start-Service ${name} }`],
      realityNote: 'Event 7034 and 7031 are the classic service-crash events; recovery options in the service settings can restart a service automatically, but someone still has to find out why.',
    };
  }),
  tmpl(9, 1, 'intermediate', 'slow-server', 'Find what is slowing a server down', 'E4', 20, 'Use performance counters and the process list to find and stop a runaway process.', (v) => {
    const net = v.net();
    const hog = v.pick(['reportgen', 'backupagent', 'indexer', 'pdfconvert']);
    const cpu = v.int(91, 99);
    const mem = v.int(120, 400);
    const file = 'C:\\Answers\\slow.txt';
    return {
      instructions: lab({
        situation: `**APP02** has been slow all morning. Measure before you guess: read **% Processor Time** and **Available MBytes**, find the process responsible, and stop it (it is a reporting job that can be rerun tonight). Record what you found.`,
        steps: ['Read the counters with Get-Counter on APP02.', 'List processes and find the one using the most CPU and memory.', 'Stop it.', `Write **${file}** with \`CPU: <percent, whole number>\` and \`Process: <name>\`.`],
        tips: ["Get-Counter '\\Processor(_Total)\\% Processor Time','\\Memory\\Available MBytes'", 'Get-Process', 'Stop-Process -Name NAME'],
      }),
      hints: ['Resource Monitor and Task Manager show the same data on a desktop server.', 'Do not stop system processes such as lsass or svchost.'],
      initialState: system({ machines: [dc01(net), { name: 'APP02', nics: [nic(`${net}.32`, net)], counters: { cpu, mem }, hogs: [{ Name: hog, CPU: 5400, WS: 3600 }] } as never], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' } }),
      checks: [ps(`${hog} is no longer running`, 'Get-Process | ForEach-Object { $_.ProcessName }', { machine: 'APP02', notContains: hog }), ps('The CPU reading is recorded', `Get-Content ${file}`, { contains: `CPU: ${cpu}` }), ps('The process is recorded', `Get-Content ${file}`, { contains: `Process: ${hog}` })],
      solution: ["Invoke-Command -ComputerName APP02 -ScriptBlock { Get-Counter '\\Processor(_Total)\\% Processor Time','\\Memory\\Available MBytes'; Get-Process }", `Invoke-Command -ComputerName APP02 -ScriptBlock { Stop-Process -Name ${hog} }`, `Set-Content ${file} "CPU: ${cpu}","Process: ${hog}"`],
      realityNote: 'Counters first, then processes: Performance Monitor baselines turn "it feels slow" into numbers you can compare.',
    };
  }),
  tmpl(9, 1, 'advanced', 'scheduled-tasks', 'Audit and set up scheduled maintenance', 'E4', 25, 'Remove a suspicious scheduled task and register nightly and weekly maintenance tasks.', (v) => {
    const net = v.net();
    const bad = v.pick(['GoogleUpdateTaskMachineCore2', 'MicrosoftEdgeUpdateTaskUA', 'OneDrive Standalone Update']);
    const exe = v.pick(['C:\\Users\\Public\\svchost.exe', 'C:\\ProgramData\\updater\\update.exe', 'C:\\Users\\Public\\Libraries\\msupd.exe']);
    const hour = v.pick(['01:00', '02:00', '03:00']);
    const day = v.pick(['Monday', 'Friday', 'Sunday']);
    return {
      instructions: lab({
        situation: `While reviewing **FS01**'s scheduled tasks you see one called **${bad}** that runs **${exe}** at every logon as SYSTEM. No product installs there; it looks like persistence left by malware. Also, the maintenance plan needs two tasks:\n\n- **Nightly Cleanup**: \`powershell.exe -File C:\\Scripts\\cleanup.ps1\`, daily at **${hour}**, as SYSTEM.\n- **Weekly Disk Report**: \`powershell.exe -File C:\\Scripts\\disk-report.ps1\`, every **${day}** at 06:00, as SYSTEM.\n\nRemove the suspicious task but **do not delete the file**: the incident team wants it.`,
        steps: ['List the tasks on FS01 with Get-ScheduledTask and read their actions.', `Unregister ${bad}.`, 'Register the two maintenance tasks.'],
        tips: [`Unregister-ScheduledTask -TaskName "${bad}" -Confirm:$false`, `Register-ScheduledTask -TaskName "Nightly Cleanup" -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-File C:\\Scripts\\cleanup.ps1") -Trigger (New-ScheduledTaskTrigger -Daily -At ${hour}) -User SYSTEM`, `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${day} -At 06:00`],
      }),
      hints: ['Tasks that run executables from Public or ProgramData folders at logon are a common persistence trick.', 'Keeping the file lets the incident team analyse it.'],
      initialState: system({ machines: [dc01(net), { name: 'FS01', features: ['FS-FileServer'], nics: [nic(`${net}.20`, net)], tasks: [{ name: 'ShadowCopyVolumeD', action: 'vssadmin create shadow /for=D:', trigger: 'Daily at 07:00', user: 'SYSTEM', enabled: true }, { name: bad, action: exe, trigger: 'At log on', user: 'SYSTEM', enabled: true }] }], machineFiles: { FS01: { [exe]: 'MZ...\n', 'C:\\Scripts\\cleanup.ps1': 'Remove-Item D:\\Temp\\* -Recurse\n', 'C:\\Scripts\\disk-report.ps1': 'Get-Volume\n' } } }),
      checks: [ps(`${bad} is gone`, 'Get-ScheduledTask | ForEach-Object { $_.TaskName }', { machine: 'FS01', notContains: bad }), ps('The suspicious file is kept for the incident team', `Test-Path ${exe}`, { machine: 'FS01', equals: 'True' }), ps(`Nightly Cleanup runs daily at ${hour}`, '(Get-ScheduledTask -TaskName "Nightly Cleanup").Trigger', { machine: 'FS01', equals: `Daily at ${hour}` }), ps('Nightly Cleanup runs the cleanup script', '(Get-ScheduledTask -TaskName "Nightly Cleanup").Action', { machine: 'FS01', contains: 'C:\\Scripts\\cleanup.ps1' }), ps(`Weekly Disk Report runs on ${day}`, '(Get-ScheduledTask -TaskName "Weekly Disk Report").Trigger', { machine: 'FS01', equals: `Weekly on ${day} at 06:00` }), ps('The shadow copy task is untouched', 'Get-ScheduledTask | ForEach-Object { $_.TaskName }', { machine: 'FS01', contains: 'ShadowCopyVolumeD' })],
      solution: ['Invoke-Command -ComputerName FS01 -ScriptBlock { Get-ScheduledTask }', `Invoke-Command -ComputerName FS01 -ScriptBlock { Unregister-ScheduledTask -TaskName "${bad}" -Confirm:$false; Register-ScheduledTask -TaskName "Nightly Cleanup" -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-File C:\\Scripts\\cleanup.ps1") -Trigger (New-ScheduledTaskTrigger -Daily -At ${hour}) -User SYSTEM; Register-ScheduledTask -TaskName "Weekly Disk Report" -Action (New-ScheduledTaskAction -Execute powershell.exe -Argument "-File C:\\Scripts\\disk-report.ps1") -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${day} -At 06:00) -User SYSTEM }`],
      realityNote: 'Scheduled tasks are one of the most common persistence techniques (MITRE ATT&CK T1053.005); routine reviews of them are part of server hygiene.',
    };
  }),

  /* ---------------------------------------------------------------- 9.2 backup and AD recovery */
  tmpl(9, 2, 'beginner', 'system-state-backup', 'Back up a domain controller\'s system state', 'E4', 15, 'Install Windows Server Backup and take a system state backup to a dedicated volume.', (v) => {
    const net = v.net();
    const vol = v.pick(['E', 'F', 'G']);
    return {
      instructions: lab({
        situation: `DC01 has never been backed up. If the directory were corrupted, there would be nothing to restore from. Install **Windows Server Backup** and take a **system state** backup (it contains the AD database, SYSVOL and the registry) to the dedicated backup volume **${vol}:**.`,
        steps: ['Install the Windows-Server-Backup feature.', `Run wbadmin start systemstatebackup -backupTarget:${vol}: -quiet.`, 'List the backups with wbadmin get versions.'],
        tips: ['Install-WindowsFeature Windows-Server-Backup', `wbadmin start systemstatebackup -backupTarget:${vol}: -quiet`, 'wbadmin get versions'],
      }),
      hints: ['A DC backup older than the tombstone lifetime (180 days) cannot be restored.', 'Backups on the same disk die with the disk: copy them off the server too.'],
      initialState: system({ machines: [dc01(net, { disks: [systemDisk(), dataDisk(1, vol, 500, 'Backup')] })] }),
      checks: [ps('A system state backup exists', 'wbadmin get versions', { contains: 'System State' }), ps(`It is on ${vol}:`, 'wbadmin get versions', { contains: `Fixed Disk labeled ${vol}:` })],
      solution: ['Install-WindowsFeature Windows-Server-Backup', `wbadmin start systemstatebackup -backupTarget:${vol}: -quiet`, 'wbadmin get versions'],
      realityNote: 'At least one DC per domain should have a recent system state backup; with no backup, a corrupted forest means rebuilding every account.',
    };
  }),
  tmpl(9, 2, 'intermediate', 'recycle-bin-restore', 'Restore a deleted OU and its users from the Recycle Bin', 'E4', 25, 'Restore deleted objects in the right order and leave intentional deletions alone.', (v) => {
    const net = v.net();
    const ouName = v.pick(['Examinations', 'Admissions', 'Research Office', 'Quality Assurance']);
    const people = v.people(3);
    const leaver = v.person();
    const ou: AdOu = { name: ouName, dn: `OU=${ouName},${DC}`, protected: false };
    const users: AdUser[] = people.map((p, i) => ({ sam: p.sam, name: p.name, given: p.given, surname: p.surname, upn: `${p.sam}@campus.local`, dn: `CN=${p.name},${ou.dn}`, sid: `S-1-5-21-3623811015-3361044348-30300820-${1400 + i}`, enabled: true, hasPassword: true }));
    const gone: AdUser = { sam: leaver.sam, name: leaver.name, given: leaver.given, surname: leaver.surname, dn: `CN=${leaver.name},OU=Staff,${DC}`, sid: 'S-1-5-21-3623811015-3361044348-30300820-1399', enabled: false, hasPassword: true };
    return {
      instructions: lab({
        situation: `A script deleted the whole **OU=${ouName}** with its ${people.length} user accounts an hour ago. The **AD Recycle Bin** is on. Restore the OU and its users. **${leaver.name}** was deleted on purpose last month when they left: leave that account deleted.`,
        steps: ['List deleted objects with Get-ADObject -IncludeDeletedObjects.', 'Restore the OU first: its users need their parent to exist.', 'Then restore the users that belonged to it.', 'Check the OU and its users.'],
        tips: ["Get-ADObject -Filter 'isDeleted -eq $true' -IncludeDeletedObjects | Format-Table Name,ObjectClass,LastKnownParent", "Get-ADObject -Filter 'ObjectClass -eq \"ou\"' -IncludeDeletedObjects | Restore-ADObject", "Get-ADObject -Filter 'LastKnownParent -eq \"OU=...\"' -IncludeDeletedObjects | Restore-ADObject"],
      }),
      hints: ['Restoring a user whose OU is still deleted fails.', 'LastKnownParent tells you where each object lived.'],
      initialState: system({ machines: [dc01(net)], ad: (st) => { addOu(st, 'Staff'); st.recycleBin = true; st.deleted.push(...users.map((u) => ({ kind: 'user' as const, obj: u })), { kind: 'ou', obj: ou }, { kind: 'user', obj: gone }); } }),
      checks: [ouCheck(`OU=${ouName} is back`, ou.dn), userCheck(`The ${ouName} users are back in their OU`, { sams: people.map((p) => p.sam), ou: ou.dn }), userCheck(`${leaver.sam} stays deleted`, { sam: leaver.sam, exists: false })],
      solution: ["Get-ADObject -Filter 'isDeleted -eq $true' -IncludeDeletedObjects", "Get-ADObject -Filter 'ObjectClass -eq \"ou\"' -IncludeDeletedObjects | Restore-ADObject", ...people.map((p) => `Restore-ADObject -Identity ${p.sam}`)],
      realityNote: 'The AD Recycle Bin (since Windows Server 2008 R2) restores objects with all their attributes and group memberships, without a backup, as long as it was enabled before the deletion.',
    };
  }),
  tmpl(9, 2, 'advanced', 'ad-recovery-choices', 'Choose the right Active Directory recovery', 'E10', 20, 'Decide between Recycle Bin, non-authoritative and authoritative restore, and avoid USN rollback.', (v) => {
    const days = v.pick([20, 45, 90]);
    return caseStudy(v, {
      intro: '## Four bad days\n\nThe campus has two DCs, nightly system state backups and, since last year, the AD Recycle Bin. Choose the recovery for each incident.',
      steps: [
        { title: 'Deleted OU', text: 'An OU with 200 accounts was deleted this morning.', choices: [{ text: 'Restore from the Recycle Bin: OU first, then its contents', right: true, feedback: 'Correct. No DC goes offline and attributes and memberships come back.' }, { text: 'Authoritative restore from last night\'s backup', feedback: 'It works, but needs DSRM downtime and loses today\'s changes in that subtree; the Recycle Bin is simpler.' }, { text: 'Recreate the accounts from the HR list', feedback: 'New accounts have new SIDs, so every permission and group membership is lost.' }] },
        { title: 'Dead DC', text: 'DC02\'s disks failed. DC01 is healthy.', choices: [{ text: 'Rebuild DC02 and let it replicate from DC01 (or non-authoritative restore)', right: true, feedback: 'Correct. A non-authoritative restore or fresh promotion takes everything newer from DC01.' }, { text: 'Authoritative restore of the whole directory on DC02', feedback: 'That would roll back changes made on DC01 since the backup.' }, { text: 'Restore a VM snapshot of DC02 from last month', feedback: 'Reverting a DC snapshot without VM-GenerationID support causes USN rollback.' }] },
        { title: 'Before the Recycle Bin', text: `A group deleted ${days} days ago, before the Recycle Bin was enabled, is needed back.`, choices: [{ text: 'Authoritative restore of that object: boot a DC into DSRM, restore system state, mark it authoritative with ntdsutil', right: true, feedback: 'Correct. The Recycle Bin cannot restore what was deleted before it was enabled.' }, { text: 'Restore-ADObject', feedback: 'Only works for objects deleted after the Recycle Bin was enabled.' }, { text: 'Wait for replication to bring it back', feedback: 'Replication spreads the deletion, not the object.' }] },
        { title: 'Tombstone lifetime', text: 'The only backup is 200 days old. Can it restore a DC?', choices: [{ text: 'No: older than the 180-day tombstone lifetime, it could reintroduce deleted objects', right: true, feedback: 'Correct. Backups older than the tombstone lifetime are not usable for AD.' }, { text: 'Yes, any backup can be restored', feedback: 'Lingering objects would appear.' }, { text: 'Yes, if it is marked authoritative', feedback: 'Authoritative makes the problem worse.' }] },
        { title: 'What you need first', text: 'Before any DC restore, what must you know?', choices: [{ text: 'The DSRM password of that DC', right: true, feedback: 'Correct. Without it you cannot log on to Directory Services Restore Mode.' }, { text: 'The Domain Admin password only', feedback: 'DSRM uses the local DSRM administrator, not a domain account.' }, { text: 'Nothing: wbadmin handles it', feedback: 'wbadmin restores from DSRM, which needs the DSRM password.' }] },
      ],
      ending: { title: 'Runbook written', text: 'Recycle Bin for recent deletions, rebuild or non-authoritative restore for dead DCs, authoritative restore only for objects deleted before the Recycle Bin, and DSRM passwords kept safe.' },
      hints: ['Authoritative means "this copy wins over replication".', 'Snapshots of DCs are dangerous without VM-GenerationID.'],
      realityNote: 'Microsoft\'s AD Forest Recovery Guide is built on exactly these choices; practising them before an incident is part of any DR plan.',
    });
  }),

  /* ---------------------------------------------------------------- 9.3 remoting, scripting, DSC */
  tmpl(9, 3, 'beginner', 'script-a-report', 'Write and run a report script', 'E4', 20, 'Save a one-line script that finds stopped automatic services on servers and run it.', (v) => {
    const net = v.net();
    const [s1, s2] = v.some(['FS01', 'PRINT01', 'APP01', 'WEB01'], 2);
    const [svc1, svc2] = v.some(['BackupAgent', 'Spooler', 'W3SVC', 'SNMP'], 2);
    const script = 'C:\\Scripts\\stopped-services.ps1';
    return {
      instructions: lab({
        situation: `Every morning someone checks whether any service set to start **automatically** is **stopped** on ${s1} and ${s2}. Turn it into a script: **${script}** that queries both servers and saves the stopped automatic services to **C:\\Reports\\stopped.csv**. Then run it.`,
        steps: [`Write the script with Set-Content (one line is enough).`, `Run it: & ${script}`, 'Check the CSV.'],
        tips: [`Set-Content ${script} 'Invoke-Command -ComputerName ${s1},${s2} -ScriptBlock { Get-Service | Where-Object { $_.StartType -eq "Automatic" -and $_.Status -eq "Stopped" } } | Export-Csv C:\\Reports\\stopped.csv -NoTypeInformation'`],
      }),
      hints: ['Single quotes keep $_ from being expanded when you write the file.', 'Combine conditions with -and.'],
      initialState: system({ machines: [dc01(net), { name: s1, nics: [nic(`${net}.21`, net)], services: { ...baseServices(), [svc1]: { status: 'Stopped', start: 'Automatic' } } }, { name: s2, nics: [nic(`${net}.22`, net)], services: { ...baseServices(), [svc2]: { status: 'Stopped', start: 'Automatic' }, BITS: { status: 'Stopped', start: 'Manual' } } }], files: { 'C:\\Scripts\\README.txt': 'Scripts live here.\n', 'C:\\Reports\\README.txt': 'Reports go here.\n' } }),
      checks: [ps('The script exists', `Test-Path ${script}`, { equals: 'True' }), ps(`The report lists ${svc1} and ${svc2}`, 'Get-Content C:\\Reports\\stopped.csv', { contains: [svc1, svc2] }), ps('Manual services are not reported', 'Get-Content C:\\Reports\\stopped.csv', { notContains: 'BITS' })],
      solution: [`Set-Content ${script} 'Invoke-Command -ComputerName ${s1},${s2} -ScriptBlock { Get-Service | Where-Object { $_.StartType -eq "Automatic" -and $_.Status -eq "Stopped" } } | Export-Csv C:\\Reports\\stopped.csv -NoTypeInformation'`, `& ${script}`],
      realityNote: 'Anything you do every morning should be a script; the next step is a scheduled task and an email or dashboard instead of a person.',
    };
  }),
  tmpl(9, 3, 'intermediate', 'loop-over-servers', 'Loop over a server list in a script', 'E4', 25, 'Read a list of servers from a file and write one volume report per server.', (v) => {
    const net = v.net();
    const servers = v.some(['FS01', 'FS02', 'APP01', 'PRINT01', 'WEB01'], 3);
    const script = 'C:\\Scripts\\volume-report.ps1';
    return {
      instructions: lab({
        situation: `The storage team wants a separate volume report for each server listed in **C:\\Scripts\\servers.txt** (${servers.length} servers today, more next month). Write **${script}** with a **foreach** loop that writes **C:\\Reports\\<server>-volumes.csv** for each one, then run it.`,
        steps: ['Look at servers.txt.', 'Write the script: foreach ($s in Get-Content C:\\Scripts\\servers.txt) { ... }.', 'Run it and check the reports.'],
        tips: [`Set-Content ${script} 'foreach ($s in Get-Content C:\\Scripts\\servers.txt) { Invoke-Command -ComputerName $s -ScriptBlock { Get-Volume } | Export-Csv "C:\\Reports\\$s-volumes.csv" -NoTypeInformation }'`],
      }),
      hints: ['Inside double quotes, $s expands to the server name.', 'Adding a server to servers.txt then needs no script change.'],
      initialState: system({ machines: [dc01(net), ...servers.map((n, i) => ({ name: n, nics: [nic(`${net}.${21 + i}`, net)], disks: [systemDisk(), dataDisk(1, 'D', 200 + 100 * i)] }))], files: { 'C:\\Scripts\\servers.txt': servers.join('\n') + '\n', 'C:\\Reports\\README.txt': 'Reports go here.\n' } }),
      checks: [...servers.map((n) => ps(`${n} has a report`, `Test-Path C:\\Reports\\${n}-volumes.csv`, { equals: 'True' })), ps('The script uses a loop', `Get-Content ${script}`, { contains: 'foreach' })],
      solution: [`Set-Content ${script} 'foreach ($s in Get-Content C:\\Scripts\\servers.txt) { Invoke-Command -ComputerName $s -ScriptBlock { Get-Volume } | Export-Csv "C:\\Reports\\$s-volumes.csv" -NoTypeInformation }'`, `& ${script}`],
      realityNote: 'Driving scripts from a list (a text file, a CSV or an AD query) is what lets one script scale from three servers to three hundred.',
    };
  }),
  tmpl(9, 3, 'advanced', 'dsc-and-automation', 'Choose between scripts, Group Policy and DSC', 'E10', 20, 'Understand declarative configuration, idempotence, drift and when Desired State Configuration fits.', (v) => {
    const n = v.int(20, 60);
    return caseStudy(v, {
      intro: `## Keeping ${n} servers the same\n\nThe server team keeps finding servers that differ: a missing role here, a changed service there. Someone proposes PowerShell **Desired State Configuration** (DSC).`,
      steps: [
        { title: 'Declarative', text: 'What makes DSC different from an ordinary script?', choices: [{ text: 'It declares the end state ("Web-Server installed, W3SVC running"); the engine works out what to change', right: true, feedback: 'Correct. You describe what, not how.' }, { text: 'It runs faster', feedback: 'Speed is not the point.' }, { text: 'It can only install roles', feedback: 'Resources cover files, registry, services, users and much more.' }] },
        { title: 'Idempotent', text: 'A DSC configuration is applied twice. What happens the second time?', choices: [{ text: 'Nothing changes: everything already matches, so the run reports "in desired state"', right: true, feedback: 'Correct. Idempotence: applying it again is safe.' }, { text: 'It reinstalls everything', feedback: 'Resources test before they set.' }, { text: 'It fails because things exist', feedback: 'Existing correct state is the goal, not an error.' }] },
        { title: 'Drift', text: 'An admin stops a required service by hand. What can DSC do?', choices: [{ text: 'Detect the drift and, in ApplyAndAutoCorrect mode, put it back', right: true, feedback: 'Correct. The Local Configuration Manager checks on a schedule.' }, { text: 'Nothing until the next reboot', feedback: 'The LCM checks periodically.' }, { text: 'Delete the admin\'s account', feedback: 'DSC manages configuration, not discipline.' }] },
        { title: 'GPO or DSC', text: 'Which job is better done with Group Policy than DSC?', choices: [{ text: 'Screen lock and Control Panel restrictions for thousands of domain workstations', right: true, feedback: 'Correct. GPO is built for user and workstation policy at scale.' }, { text: 'Making sure every web server has the same IIS roles and site folders', feedback: 'That server build is a classic DSC job.' }, { text: 'Configuring a non-domain server in the DMZ', feedback: 'GPO cannot reach non-domain machines; DSC can.' }] },
        { title: 'Where it stands today', text: 'For new work, what is the current direction for DSC?', choices: [{ text: 'DSC v3 is cross-platform; in Azure, Machine Configuration builds on it', right: true, feedback: 'Correct. The declarative idea continues, also in tools like Ansible.' }, { text: 'It was removed from Windows', feedback: 'Windows PowerShell DSC still ships; newer versions build on it.' }, { text: 'Only Linux supports it', feedback: 'It started on Windows.' }] },
      ],
      ending: { title: 'Approach agreed', text: 'GPO for workstation and user policy, DSC (or a similar declarative tool) for server builds and drift, scripts for one-off and reporting jobs.' },
      hints: ['Declarative: describe the result.', 'Idempotent: safe to run again.'],
      realityNote: 'Configuration-as-code (DSC, Ansible, Puppet) is how teams stop configuration drift; the same ideas run through cloud machine configuration services.',
    });
  }),

  /* ---------------------------------------------------------------- 9.4 documentation, change control, DR */
  tmpl(9, 4, 'beginner', 'change-request', 'Write a sound change request', 'E10', 15, 'Judge the parts of a change request: risk, test, rollback, approval and timing.', (v) => {
    const change = v.pick(['raise the domain functional level', 'apply the October cumulative update to both DCs', 'replace the file server\'s data disk', 'change the DHCP scope options for all staff networks']);
    return caseStudy(v, {
      intro: `## Change request\n\nYou want to **${change}**. The change advisory board asks you to fill in the request properly.`,
      steps: [
        { title: 'Timing', text: 'When should it happen?', choices: [{ text: 'In the agreed maintenance window, outside registration and exam periods', right: true, feedback: 'Correct. Timing is part of risk.' }, { text: 'Now, while you remember', feedback: 'Unplanned changes during teaching hours are how outages start.' }, { text: 'Friday at 5 pm', feedback: 'Nobody will be around if it goes wrong.' }] },
        { title: 'Rollback', text: 'What must the rollback plan say?', choices: [{ text: 'Exactly how to undo it, how long that takes, and the point at which you decide to roll back', right: true, feedback: 'Correct. A decision point stops "just one more try" at 3 am.' }, { text: '"Restore from backup if needed"', feedback: 'Which backup, how long, who decides?' }, { text: 'Nothing: the change is low risk', feedback: 'Every change needs a way back.' }] },
        { title: 'Testing', text: 'What testing should come first?', choices: [{ text: 'Try it in the lab or on a pilot system, and record the result', right: true, feedback: 'Correct.' }, { text: 'None for a vendor update', feedback: 'Vendor updates break things often enough.' }, { text: 'Ask a colleague if it sounds fine', feedback: 'An opinion is not a test.' }] },
        { title: 'Communication', text: 'Who needs to know?', choices: [{ text: 'The affected users and the service desk, before and after, with expected impact', right: true, feedback: 'Correct.' }, { text: 'Only the CAB', feedback: 'The service desk will get the calls.' }, { text: 'Nobody, if it works', feedback: 'People need to know when to report problems.' }] },
        { title: 'Afterwards', text: 'What closes the change?', choices: [{ text: 'Verification that it worked, updated documentation, and the result recorded on the request', right: true, feedback: 'Correct.' }, { text: 'Logging off', feedback: 'Undocumented changes are the next admin\'s mystery.' }, { text: 'Deleting the request', feedback: 'The record is the audit trail.' }] },
      ],
      ending: { title: 'Change approved', text: 'Scheduled in the window, tested, with a rollback decision point, communication and documentation.' },
      hints: ['Think about the academic calendar.', 'A rollback plan needs a decision point.'],
      realityNote: 'ITIL change enablement and ISO 20000 describe the same essentials; small teams can keep them lightweight but not skip them.',
    });
  }),
  tmpl(9, 4, 'intermediate', 'document-the-estate', 'Document the server estate from Active Directory', 'E4', 20, 'Export a server inventory and the FSMO holders into the documentation folder.', (v) => {
    const net = v.net();
    const servers = v.some(['FS01', 'PRINT01', 'APP01', 'WEB01', 'WSUS01', 'DHCP01'], 4);
    const pcs = [`OFF-PC${v.int(10, 40)}`, `LAB-${v.int(1, 4)}-0${v.int(1, 9)}`];
    return {
      instructions: lab({
        situation: `The auditors want current documentation. From Active Directory, export every computer in **OU=Servers** (not the PCs) with Name, DNSHostName and OperatingSystem to **C:\\Docs\\servers.csv**, and save the FSMO role holders to **C:\\Docs\\fsmo.txt**.`,
        steps: ['Query OU=Servers with Get-ADComputer -SearchBase.', 'Select the three properties and export to CSV.', 'Save netdom query fsmo to a file with Out-File.'],
        tips: [`Get-ADComputer -Filter * -SearchBase "${ouDn('Servers')}" | Select-Object Name,DNSHostName,OperatingSystem | Export-Csv C:\\Docs\\servers.csv -NoTypeInformation`, 'netdom query fsmo | Out-File C:\\Docs\\fsmo.txt'],
      }),
      hints: ['-SearchBase keeps the PCs out.', 'Generated documentation is only current if you regenerate it: schedule it.'],
      initialState: system({ machines: [dc01(net), ...servers.map((n, i) => ({ name: n, nics: [nic(`${net}.${21 + i}`, net)] })), ...pcs.map((n, i) => pc(n, net, 60 + i))], files: { 'C:\\Docs\\README.txt': 'Documentation lives here.\n' }, ad: (st) => { const so = addOu(st, 'Servers'); for (const n of servers) placeComputer(st, n, so); const wo = addOu(st, 'Workstations'); for (const n of pcs) placeComputer(st, n, wo); } }),
      checks: [ps('Every server is in the inventory', 'Get-Content C:\\Docs\\servers.csv', { contains: servers.map((s) => `${s.toLowerCase()}.campus.local`) }), ps('No PCs are in it', 'Get-Content C:\\Docs\\servers.csv', { notContains: pcs }), ps('The FSMO holders are documented', 'Get-Content C:\\Docs\\fsmo.txt', { contains: ['PDC', 'RID pool manager', 'Schema master'] })],
      solution: [`Get-ADComputer -Filter * -SearchBase "${ouDn('Servers')}" | Select-Object Name,DNSHostName,OperatingSystem | Export-Csv C:\\Docs\\servers.csv -NoTypeInformation`, 'netdom query fsmo | Out-File C:\\Docs\\fsmo.txt'],
      realityNote: 'Documentation generated from the systems themselves stays truthful; hand-written spreadsheets drift within weeks.',
    };
  }),
  tmpl(9, 4, 'advanced', 'dr-plan', 'Plan disaster recovery for a small institution', 'E10', 25, 'Set RPO and RTO, design 3-2-1 backups, order the restores and plan for power and ransomware.', (v) => {
    const gb = v.pick([800, 1500, 3000]);
    const mbps = v.pick([20, 50, 100]);
    const hours = Math.round((gb * 8 * 1024) / (mbps * 3600));
    return caseStudy(v, {
      intro: `## When everything is gone\n\nA college with one server room, ${gb} GB of data, a ${mbps} Mbps internet link and unreliable mains power asks for a disaster recovery plan.`,
      steps: [
        { title: 'RPO', text: 'The registrar says: "We can re-enter at most one day of student records." What is that?', choices: [{ text: 'A recovery point objective of 24 hours: backups at least daily', right: true, feedback: 'Correct. RPO is how much data you can afford to lose.' }, { text: 'A recovery time objective of 24 hours', feedback: 'RTO is how long you can be down.' }, { text: 'The backup retention period', feedback: 'Retention is how long backups are kept.' }] },
        { title: '3-2-1', text: 'Which backup design follows 3-2-1?', choices: [{ text: 'Production data plus two backup copies, on two different media, one offsite (and ideally one offline or immutable)', right: true, feedback: 'Correct. The offline copy is what survives ransomware.' }, { text: 'Three backups on the same NAS', feedback: 'One NAS failure or ransomware hit loses all three.' }, { text: 'One cloud copy is enough', feedback: 'One copy is a single point of failure.' }] },
        { title: 'Cloud restore time', text: `Restoring ${gb} GB from the cloud over ${mbps} Mbps takes about how long?`, evidence: [{ title: 'Arithmetic', text: `${gb} GB × 8 × 1024 = ${gb * 8 * 1024} megabits; at ${mbps} Mbps that is ${gb * 8 * 1024} / ${mbps} seconds.` }], choices: [{ text: `About ${hours} hours, so keep a local copy for fast restores`, right: true, feedback: `Correct. Roughly ${hours} hours at full speed, more in practice.` }, { text: 'About 10 minutes', feedback: 'Check the units: megabits per second, not megabytes.' }, { text: 'Speed does not matter for DR', feedback: 'It decides whether you meet the RTO.' }] },
        { title: 'Restore order', text: 'After a total loss, what comes back first?', choices: [{ text: 'A domain controller with DNS, then file and application servers', right: true, feedback: 'Correct. Almost everything depends on AD and DNS.' }, { text: 'The file server, because users want their files', feedback: 'Without AD and DNS, users cannot log on to reach them.' }, { text: 'Whatever restores fastest', feedback: 'Dependencies decide the order.' }] },
        { title: 'Power', text: 'Power cuts are frequent. What belongs in the plan?', choices: [{ text: 'UPS sized for a clean shutdown, automatic shutdown software, and a tested generator changeover', right: true, feedback: 'Correct. Unclean shutdowns corrupt databases and disks.' }, { text: 'Nothing: servers survive power cuts', feedback: 'Repeated hard power-offs corrupt data.' }, { text: 'Turn servers off every evening', feedback: 'That breaks backups and overnight jobs.' }] },
        { title: 'Proving it', text: 'How do you know the plan works?', choices: [{ text: 'Test restores on a schedule (including a DC into an isolated lab) and record the time taken', right: true, feedback: 'Correct. An untested backup is a hope.' }, { text: 'The backup software says "successful"', feedback: 'Successful jobs can still produce unrestorable backups.' }, { text: 'Wait for a real disaster', feedback: 'That is the worst time to find out.' }] },
      ],
      ending: { title: 'Plan signed off', text: 'Daily backups for a 24-hour RPO, 3-2-1 with an offline copy, local copies for fast restores, AD and DNS first, power protection and scheduled test restores.' },
      hints: ['RPO = data loss, RTO = downtime.', '8 bits in a byte.'],
      realityNote: 'Ransomware has made the offline or immutable copy the most important part of 3-2-1; national guidance from CSA Ghana and others stresses tested, offline backups.',
    });
  }),
];
