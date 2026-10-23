/** Unit 5: file and print services. */

import type { CheckSpec } from '@cslab/lab-runtime';
import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { HK, addGroup, addOu, addUser, dc01, extra, fs01, gpSet, lab, ouDn, pc, placeComputer, policy, print01, ps, ran, system, tmpl } from './kit';

const acc = (label: string, path: string, user: string, equals: string, message?: string): CheckSpec => ({ type: 'win.access', label, path, user, equals, ...(message ? { message } : {}) });
const DEPTS = ['Finance', 'Registry', 'Library', 'Procurement', 'Estates', 'Admissions', 'Examinations', 'Research'];

export const U5: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 5.1 shares, SMB, share + NTFS, ABE */
  tmpl(5, 1, 'beginner', 'share-a-folder', 'Share a department folder', 'E4', 15, 'Create a folder on the file server and share it with the right share permissions.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [m1] = v.people(1);
    return {
      instructions: lab({
        situation: `${dept} needs a shared folder on **FS01**. Create **D:\\Shares\\${dept}** and share it as **${dept}**: **DL_${dept}_Modify** gets **Change**, **Administrators** get **Full**, and Everyone gets nothing (do not leave the default Everyone Read).`,
        steps: ['On FS01, create the folder with New-Item.', 'Share it with New-SmbShare and the -ChangeAccess and -FullAccess lists.', 'Check with Get-SmbShareAccess.'],
        tips: [`Invoke-Command -ComputerName FS01 -ScriptBlock { New-Item -Path D:\\Shares\\${dept} -ItemType Directory }`, `New-SmbShare -Name ${dept} -Path D:\\Shares\\${dept} -ChangeAccess "CAMPUS\\DL_${dept}_Modify" -FullAccess Administrators`],
      }),
      hints: ['If you give no access lists at all, New-SmbShare grants Everyone Read.', 'Share permissions only apply over the network; NTFS permissions apply everywhere.'],
      initialState: system({ machines: [dc01(net), fs01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const u = addUser(st, m1, ou, { department: dept }); const g = addGroup(st, `GG_${dept}_Staff`, 'Global', ou, [u]); addGroup(st, `DL_${dept}_Modify`, 'DomainLocal', ou, [g]); } }),
      checks: [ps(`FS01 shares D:\\Shares\\${dept} as ${dept}`, `(Get-SmbShare -Name ${dept}).Path`, { machine: 'FS01', equals: `D:\\Shares\\${dept}` }), ps(`DL_${dept}_Modify has Change`, `Get-SmbShareAccess -Name ${dept} | Where-Object { $_.AccountName -like '*DL_${dept}_Modify' } | ForEach-Object { $_.AccessRight }`, { machine: 'FS01', equals: 'Change' }), ps('Administrators have Full', `Get-SmbShareAccess -Name ${dept} | Where-Object { $_.AccountName -like '*Administrators' } | ForEach-Object { $_.AccessRight }`, { machine: 'FS01', equals: 'Full' }), ps('Everyone has no share access', `Get-SmbShareAccess -Name ${dept} | ForEach-Object { $_.AccountName }`, { machine: 'FS01', notContains: 'Everyone' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { New-Item -Path D:\\Shares\\${dept} -ItemType Directory; New-SmbShare -Name ${dept} -Path D:\\Shares\\${dept} -ChangeAccess "CAMPUS\\DL_${dept}_Modify" -FullAccess Administrators }`],
      realityNote: 'Department shares granted to domain local groups are the backbone of most Windows file services; the share is the network door, NTFS the lock on each folder.',
    };
  }),
  tmpl(5, 1, 'intermediate', 'share-and-ntfs', 'Combine share and NTFS permissions, with access-based enumeration', 'E4', 25, 'Use the common "share wide, NTFS narrow" pattern and hide folders people cannot open.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [member, reader, outsider] = v.people(3);
    const folder = `D:\\Data\\${dept}`;
    return {
      instructions: lab({
        situation: `FS01 should share **${folder}** as **${dept}$** (hidden). The team uses the common pattern: the share gives **Authenticated Users Change**, and **NTFS** does the real work: **DL_${dept}_Modify** Modify, **DL_${dept}_Read** Read & Execute, nobody else. Turn on **access-based enumeration** so people do not even see folders they cannot open.`,
        steps: ['Set the NTFS permissions with icacls: copy inheritance, remove Users, grant the two DL groups.', 'Share the folder with -ChangeAccess "Authenticated Users" and -FolderEnumerationMode AccessBased.', `Check what ${member.given}, ${reader.given} and ${outsider.given} get through \\\\FS01\\${dept}$.`],
        tips: [`icacls ${folder} /inheritance:d`, `icacls ${folder} /remove Users`, `icacls ${folder} /grant "CAMPUS\\DL_${dept}_Read:(OI)(CI)RX"`, `New-SmbShare -Name ${dept}$ -Path ${folder} -ChangeAccess "Authenticated Users" -FullAccess Administrators -FolderEnumerationMode AccessBased`],
      }),
      hints: ['Effective access over the network is the more restrictive of share and NTFS.', 'A $ at the end of a share name hides it from browsing.'],
      initialState: system({ machines: [dc01(net), fs01(net)], ad: (st) => { const ou = addOu(st, 'Staff'); const a = addUser(st, member, ou, { department: dept }); const b = addUser(st, reader, ou); addUser(st, outsider, ou); addGroup(st, `DL_${dept}_Modify`, 'DomainLocal', ou, [a]); addGroup(st, `DL_${dept}_Read`, 'DomainLocal', ou, [b]); }, machineFiles: { FS01: { [`${folder}\\Plan.docx`]: 'plan\n' } } }),
      checks: [acc(`${member.name} can change files over the network`, `\\\\FS01\\${dept}$`, member.sam, 'Modify'), acc(`${reader.name} can only read`, `\\\\FS01\\${dept}$`, reader.sam, 'ReadAndExecute'), acc(`${outsider.name} cannot get in`, `\\\\FS01\\${dept}$`, outsider.sam, 'None', 'Someone outside both groups can still open the share: remove the inherited Users entry from NTFS.'), ps('Access-based enumeration is on', `(Get-SmbShare -Name ${dept}$).FolderEnumerationMode`, { machine: 'FS01', equals: 'AccessBased' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { icacls ${folder} /inheritance:d; icacls ${folder} /remove Users; icacls ${folder} /grant "CAMPUS\\DL_${dept}_Modify:(OI)(CI)M"; icacls ${folder} /grant "CAMPUS\\DL_${dept}_Read:(OI)(CI)RX"; New-SmbShare -Name ${dept}$ -Path ${folder} -ChangeAccess "Authenticated Users" -FullAccess Administrators -FolderEnumerationMode AccessBased }`],
      realityNote: 'Keeping share permissions broad and NTFS precise is Microsoft\'s usual advice: one place to manage access, and ABE stops users browsing folder names they should not see.',
    };
  }),
  tmpl(5, 1, 'advanced', 'access-puzzle', 'Explain and fix "read-only over the network"', 'E4', 25, 'Diagnose a restrictive share permission and an inherited NTFS entry, then fix both.', (v) => {
    const net = v.net();
    const proj = v.pick(['Projects', 'Theses', 'Grants', 'Curriculum']);
    const [member, other, outsider] = v.people(3);
    const folder = `D:\\${proj}`;
    return {
      instructions: lab({
        situation: `Two complaints about **\\\\FS01\\${proj}**:\n\n1. ${member.name} (in **GG_${proj}**, which has **Modify** in NTFS) can open files but not save them.\n2. ${outsider.name}, who has nothing to do with ${proj}, can read everything.\n\nWork out why from the share and NTFS permissions, then fix it so GG_${proj} members can change files and nobody else can get in.`,
        steps: ['Read the share permissions (Get-SmbShareAccess) and the NTFS ACL (icacls) on FS01.', 'Write down the effective access for each user: the more restrictive of share and NTFS.', 'Fix the share permission and the NTFS entry that lets everyone read.'],
        tips: [`Grant-SmbShareAccess -Name ${proj} -AccountName "Authenticated Users" -AccessRight Change -Force`, `Revoke-SmbShareAccess -Name ${proj} -AccountName Everyone -Force`],
      }),
      hints: ['Everyone: Read on the share caps everybody at Read, whatever NTFS says.', 'The outsider gets in through the Users entry inherited from D:.'],
      initialState: system({ machines: [dc01(net), fs01(net, { shares: [{ name: proj, path: folder, server: 'FS01', access: [{ account: 'Everyone', right: 'Read' }] }], ntfs: { [folder]: { inherit: true, aces: [{ account: `CAMPUS\\GG_${proj}`, rights: 'Modify', type: 'Allow' }] } } })], ad: (st) => { const ou = addOu(st, 'Staff'); const a = addUser(st, member, ou); const b = addUser(st, other, ou); addUser(st, outsider, ou); addGroup(st, `GG_${proj}`, 'Global', ou, [a, b]); }, machineFiles: { FS01: { [`${folder}\\index.docx`]: 'index\n' } } }),
      checks: [acc(`${member.name} can now save`, `\\\\FS01\\${proj}`, member.sam, 'Modify', 'Still read-only over the network: the share permission caps access.'), acc(`${other.name} can save too`, `\\\\FS01\\${proj}`, other.sam, 'Modify'), acc(`${outsider.name} is shut out`, `\\\\FS01\\${proj}`, outsider.sam, 'None', 'The outsider can still get in: remove the inherited Users entry on the folder.')],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Get-SmbShareAccess -Name ${proj}; icacls ${folder}; Grant-SmbShareAccess -Name ${proj} -AccountName "Authenticated Users" -AccessRight Change -Force; Revoke-SmbShareAccess -Name ${proj} -AccountName Everyone -Force; icacls ${folder} /inheritance:d; icacls ${folder} /remove Users }`],
      realityNote: 'The "works locally, read-only over the network" puzzle is almost always the share permission; "everyone can read" is almost always inheritance.',
    };
  }),

  /* ---------------------------------------------------------------- 5.2 FSRM */
  tmpl(5, 2, 'beginner', 'fsrm-quota', 'Put a quota on a shared folder', 'E4', 15, 'Install File Server Resource Manager and set a hard quota on a folder.', (v) => {
    const net = v.net();
    const [folder, size] = v.pick([['Students', '2GB'], ['Scratch', '5GB'], ['Uploads', '500MB'], ['Projects', '10GB']]);
    const mb = size.endsWith('GB') ? Number(size.slice(0, -2)) * 1024 : Number(size.slice(0, -2));
    return {
      instructions: lab({
        situation: `**D:\\Shares\\${folder}** on FS01 keeps filling the data volume. Limit it to **${size}** with a **hard** quota (writes beyond the limit fail). File Server Resource Manager is not installed yet.`,
        steps: ['Install the FS-Resource-Manager role service on FS01 with its tools.', `Create the quota on D:\\Shares\\${folder}.`, 'Check it with Get-FsrmQuota.'],
        tips: ['Install-WindowsFeature FS-Resource-Manager -IncludeManagementTools', `New-FsrmQuota -Path D:\\Shares\\${folder} -Size ${size}`],
      }),
      hints: ['Without -SoftLimit a quota is hard.', 'Quota templates (Get-FsrmQuotaTemplate) save typing for common sizes.'],
      initialState: system({ machines: [dc01(net), fs01(net)], machineFiles: { FS01: { [`D:\\Shares\\${folder}\\readme.txt`]: 'shared\n' } } }),
      checks: [ps('FSRM is installed', '(Get-WindowsFeature -Name FS-Resource-Manager).InstallState', { machine: 'FS01', equals: 'Installed' }), ps(`The quota is ${mb} MB`, `(Get-FsrmQuota | Where-Object { $_.Path -eq 'D:\\Shares\\${folder}' }).Size`, { machine: 'FS01', equals: `${mb} MB` }), ps('It is a hard quota', `(Get-FsrmQuota | Where-Object { $_.Path -eq 'D:\\Shares\\${folder}' }).SoftLimit`, { machine: 'FS01', equals: 'False' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Install-WindowsFeature FS-Resource-Manager -IncludeManagementTools; New-FsrmQuota -Path D:\\Shares\\${folder} -Size ${size} }`],
      realityNote: 'Folder quotas from FSRM are how universities keep student and scratch shares from eating whole volumes.',
    };
  }),
  tmpl(5, 2, 'intermediate', 'file-screen', 'Block media and programs on a student share', 'E4', 20, 'Create a file screen for audio, video and executables and prove it works.', (v) => {
    const net = v.net();
    const share = v.pick(['Students', 'Coursework', 'Labs']);
    const [song, prog] = [v.pick(['mix.mp3', 'movie.mp4', 'lecture-rip.avi']), v.pick(['game.exe', 'setup.msi', 'crack.bat'])];
    return {
      instructions: lab({
        situation: `The **D:\\Shares\\${share}** share is full of music, films and downloaded programs. Block **Audio and Video Files** and **Executable Files** there with an active FSRM file screen, while documents keep working. Test files are in C:\\Temp on FS01.`,
        steps: ['List the built-in file groups with Get-FsrmFileGroup.', 'Create an active file screen for both groups.', `Prove it: copying C:\\Temp\\${song} into the share must fail, and C:\\Temp\\notes.docx must succeed.`],
        tips: [`New-FsrmFileScreen -Path D:\\Shares\\${share} -IncludeGroup "Audio and Video Files","Executable Files" -Active`, `Copy-Item C:\\Temp\\notes.docx D:\\Shares\\${share}\\`],
      }),
      hints: ['FSRM is already installed here.', 'A passive (not active) screen only reports; an active one blocks.'],
      initialState: system({ machines: [dc01(net), fs01(net, { features: ['FS-FileServer', 'FS-Resource-Manager'] })], machineFiles: { FS01: { [`D:\\Shares\\${share}\\readme.txt`]: 'shared\n', [`C:\\Temp\\${song}`]: 'audio\n', [`C:\\Temp\\${prog}`]: 'binary\n', 'C:\\Temp\\notes.docx': 'notes\n' } } }),
      checks: [ps('Audio and video are screened', `(Get-FsrmFileScreen | Where-Object { $_.Path -eq 'D:\\Shares\\${share}' }).IncludeGroup`, { machine: 'FS01', contains: ['Audio and Video Files', 'Executable Files'] }), ps('The screen is active', `(Get-FsrmFileScreen | Where-Object { $_.Path -eq 'D:\\Shares\\${share}' }).Active`, { machine: 'FS01', equals: 'True' }), ps('Documents still go in', `Test-Path D:\\Shares\\${share}\\notes.docx`, { machine: 'FS01', equals: 'True' }), ps(`${song} did not get in`, `Test-Path D:\\Shares\\${share}\\${song}`, { machine: 'FS01', equals: 'False' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Get-FsrmFileGroup; New-FsrmFileScreen -Path D:\\Shares\\${share} -IncludeGroup "Audio and Video Files","Executable Files" -Active $true; Copy-Item C:\\Temp\\notes.docx D:\\Shares\\${share}\\ }`],
      realityNote: 'File screens are a cheap control against storage abuse and against executables being shared around a campus.',
    };
  }),
  tmpl(5, 2, 'advanced', 'quota-full', 'Fix "not enough space" for a research group', 'E4', 25, 'Raise an outgrown hard quota, add a soft monitoring quota and keep programs out.', (v) => {
    const net = v.net();
    const grp = v.pick(['Genomics', 'ClimateLab', 'AI-Group', 'Hydrology']);
    const dataMb = v.pick([300, 450, 800]);
    return {
      instructions: lab({
        situation: `The ${grp} researchers cannot copy their **${dataMb} MB** dataset (C:\\Temp\\dataset.csv on FS01) into **D:\\Research\\${grp}**: "There is not enough space on the disk", yet the volume is nearly empty. The research office approved:\n\n- **${grp}**: the **5 GB Limit** quota template.\n- **D:\\Research\\Archive**: no hard limit, but **monitor** usage with the "Monitor 200 GB Volume Usage" template.\n- Executables must never be stored under D:\\Research\\${grp}.`,
        steps: ['Find the existing quota with Get-FsrmQuota and read the error carefully.', `Apply the 5 GB Limit template to D:\\Research\\${grp} (it replaces the old quota).`, 'Add the monitoring quota on the archive and the executable file screen.', 'Copy the dataset in.'],
        tips: ['Get-FsrmQuotaTemplate', `New-FsrmQuota -Path D:\\Research\\${grp} -Template "5 GB Limit"`, `Copy-Item C:\\Temp\\dataset.csv D:\\Research\\${grp}\\`],
      }),
      hints: ['The error comes from the folder quota, not the disk.', 'A monitoring template is a soft quota: it reports but never blocks.'],
      initialState: system({ machines: [dc01(net), fs01(net, { features: ['FS-FileServer', 'FS-Resource-Manager'], fsrm: { quotas: [{ path: `D:\\Research\\${grp}`, sizeMb: 100, soft: false, template: '100 MB Limit' }], screens: [] }, sizes: { 'C:\\Temp\\dataset.csv': dataMb } } as never)], machineFiles: { FS01: { [`D:\\Research\\${grp}\\notes.txt`]: 'notes\n', 'D:\\Research\\Archive\\2019.zip': 'zip\n', 'C:\\Temp\\dataset.csv': 'id,value\n1,2\n' } } }),
      checks: [ps(`${grp} has the 5 GB quota`, `(Get-FsrmQuota | Where-Object { $_.Path -eq 'D:\\Research\\${grp}' }).Size`, { machine: 'FS01', equals: '5120 MB' }), ps('The archive is monitored, not limited', `(Get-FsrmQuota | Where-Object { $_.Path -eq 'D:\\Research\\Archive' }).SoftLimit`, { machine: 'FS01', equals: 'True' }), ps('Executables are screened', `(Get-FsrmFileScreen | Where-Object { $_.Path -eq 'D:\\Research\\${grp}' }).IncludeGroup`, { machine: 'FS01', contains: 'Executable Files' }), ps('The dataset is in place', `Test-Path D:\\Research\\${grp}\\dataset.csv`, { machine: 'FS01', equals: 'True' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Get-FsrmQuota; New-FsrmQuota -Path D:\\Research\\${grp} -Template "5 GB Limit"; New-FsrmQuota -Path D:\\Research\\Archive -Template "Monitor 200 GB Volume Usage"; New-FsrmFileScreen -Path D:\\Research\\${grp} -IncludeGroup "Executable Files" -Active $true; Copy-Item C:\\Temp\\dataset.csv D:\\Research\\${grp}\\ }`],
      realityNote: '"Disk full" on an empty volume is the classic sign of a folder quota; soft quotas with reports let you watch growth without breaking anyone\'s work.',
    };
  }),

  /* ---------------------------------------------------------------- 5.3 DFS and shadow copies */
  tmpl(5, 3, 'beginner', 'previous-versions', 'Restore a deleted file from a shadow copy', 'E4', 15, 'Find the morning shadow copy, restore a file from it and take a fresh snapshot.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const file = v.pick(['budget-2026.xlsx', 'minutes-oct.docx', 'timetable.xlsx', 'contracts.docx']);
    const content = `${dept} ${file} v${v.int(3, 9)}\n`;
    const time = `2026.10.22-0${v.int(6, 8)}.00.00`;
    return {
      instructions: lab({
        situation: `Someone in ${dept} deleted **D:\\Shares\\${dept}\\${file}** on FS01 this morning. Shadow copies of D: are taken every day at dawn. Restore the file from the shadow copy (the "Previous Versions" tab does the same thing), then take a new shadow copy now.`,
        steps: ['List the shadow copies with `vssadmin list shadows` on FS01 and note the @GMT time.', `Copy the file back from \\\\FS01\\D$\\@GMT-<time>\\Shares\\${dept}\\${file}.`, 'Create a new shadow copy of D:.'],
        tips: ['vssadmin list shadows', `Copy-Item "\\\\FS01\\D$\\@GMT-${'<time>'}\\Shares\\${dept}\\${file}" D:\\Shares\\${dept}\\`, 'vssadmin create shadow /for=D:'],
      }),
      hints: ['The @GMT path is how Windows exposes a snapshot of a share or volume.', 'Shadow copies are not backups: they live on the same volume.'],
      initialState: system({ machines: [dc01(net), fs01(net, { shadows: [{ id: '{b5946137-7b9f-4925-af80-51abd60b20d0}', volume: 'D:', time, files: { [`D:\\Shares\\${dept}\\${file}`]: content, [`D:\\Shares\\${dept}\\old.txt`]: 'old\n' } }] })], machineFiles: { FS01: { [`D:\\Shares\\${dept}\\old.txt`]: 'old\n' } } }),
      checks: [ps(`${file} is back`, `Get-Content D:\\Shares\\${dept}\\${file}`, { machine: 'FS01', equals: content.trim() }), ps('A new shadow copy exists', 'vssadmin list shadows', { machine: 'FS01', pattern: '(Contents of shadow copy set[\\s\\S]*){2}' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { vssadmin list shadows; Copy-Item "\\\\FS01\\D$\\@GMT-${time}\\Shares\\${dept}\\${file}" D:\\Shares\\${dept}\\; vssadmin create shadow /for=D: }`],
      realityNote: 'Self-service restores from shadow copies save helpdesks hundreds of tickets a year; they are not a backup because they die with the volume.',
    };
  }),
  tmpl(5, 3, 'intermediate', 'dfs-namespace', 'Publish shares through a DFS namespace', 'E4', 25, 'Create a domain-based namespace so users use one path whatever server holds the data.', (v) => {
    const net = v.net();
    const ns = v.pick(['Shares', 'Data', 'Campus']);
    const [d1, d2] = v.some(DEPTS, 2);
    return {
      instructions: lab({
        situation: `Users map drives to \\\\FS01\\${d1} and \\\\FS02\\${d2}, and every server move breaks their shortcuts. Publish both under one domain-based **DFS namespace**: **\\\\campus.local\\${ns}\\${d1}** and **\\\\campus.local\\${ns}\\${d2}**, with the namespace root hosted on FS01.`,
        steps: ['Install the DFS Namespaces role service on FS01.', `On FS01 create D:\\DFSRoots\\${ns} and share it as ${ns}.`, `Create the root \\\\campus.local\\${ns} with target \\\\FS01\\${ns}.`, 'Add one folder per share.', `Test: Get-Content \\\\campus.local\\${ns}\\${d2}\\welcome.txt.`],
        tips: ['Install-WindowsFeature FS-DFS-Namespace -IncludeManagementTools', `New-DfsnRoot -Path \\\\campus.local\\${ns} -TargetPath \\\\FS01\\${ns} -Type DomainV2`, `New-DfsnFolder -Path \\\\campus.local\\${ns}\\${d1} -TargetPath \\\\FS01\\${d1}`],
      }),
      hints: ['A domain-based namespace path starts with the domain name.', 'The folder targets must already be shares.'],
      initialState: system({ machines: [dc01(net), fs01(net, { shares: [{ name: d1, path: `D:\\Shares\\${d1}`, server: 'FS01', access: [{ account: 'Authenticated Users', right: 'Change' }] }] }), fs01(net, { shares: [{ name: d2, path: `D:\\Shares\\${d2}`, server: 'FS02', access: [{ account: 'Authenticated Users', right: 'Change' }] }] }, 'FS02', 21)], machineFiles: { FS01: { [`D:\\Shares\\${d1}\\welcome.txt`]: `${d1} share\n` }, FS02: { [`D:\\Shares\\${d2}\\welcome.txt`]: `${d2} share\n` } } }),
      checks: [ps('The namespace root exists', 'Get-DfsnRoot | ForEach-Object { $_.Path }', { contains: `\\\\campus.local\\${ns}` }), ps(`${d1} opens through the namespace`, `Get-Content \\\\campus.local\\${ns}\\${d1}\\welcome.txt`, { equals: `${d1} share` }), ps(`${d2} opens through the namespace`, `Get-Content \\\\campus.local\\${ns}\\${d2}\\welcome.txt`, { equals: `${d2} share` })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Install-WindowsFeature FS-DFS-Namespace -IncludeManagementTools; New-Item -Path D:\\DFSRoots\\${ns} -ItemType Directory; New-SmbShare -Name ${ns} -Path D:\\DFSRoots\\${ns} -ReadAccess "Authenticated Users" }`, `New-DfsnRoot -Path \\\\campus.local\\${ns} -TargetPath \\\\FS01\\${ns} -Type DomainV2`, `New-DfsnFolder -Path \\\\campus.local\\${ns}\\${d1} -TargetPath \\\\FS01\\${d1}`, `New-DfsnFolder -Path \\\\campus.local\\${ns}\\${d2} -TargetPath \\\\FS02\\${d2}`],
      realityNote: 'DFS namespaces decouple paths from servers, so storage can move without remapping every PC; most campuses publish all shares this way.',
    };
  }),
  tmpl(5, 3, 'advanced', 'dfs-replication', 'Replicate a share to a branch and add it to the namespace', 'E4', 30, 'Set up DFS Replication between two servers and give the namespace folder a second target.', (v) => {
    const net = v.net();
    const city = v.city();
    const br = `${city.slice(0, 3).toUpperCase()}-FS01`;
    const share = v.pick(['Library', 'Forms', 'Policies', 'Templates']);
    const doc = v.pick(['handbook.pdf', 'forms-2026.docx', 'catalogue.xlsx']);
    return {
      instructions: lab({
        situation: `The ${city} campus reaches **\\\\campus.local\\Shares\\${share}** over a slow WAN link. Its server **${br}** already shares an empty **D:\\Shares\\${share}** as ${share}. Replicate FS01's ${share} folder to ${br} with **DFS Replication**, FS01 as the primary member, and add ${br} as a second folder target so ${city} users are referred to their local copy.`,
        steps: ['Install DFS Replication on both servers.', `Create a replication group **RG-${share}** with a replicated folder ${share}, both members and a connection.`, `Set each member's content path (FS01 is primary: its content wins on the first sync).`, `Add \\\\${br}\\${share} as a folder target of \\\\campus.local\\Shares\\${share}.`],
        tips: ['Install-WindowsFeature FS-DFS-Replication -IncludeManagementTools -ComputerName X', `New-DfsReplicationGroup -GroupName RG-${share}`, `New-DfsReplicatedFolder -GroupName RG-${share} -FolderName ${share}`, `Add-DfsrMember -GroupName RG-${share} -ComputerName FS01,${br}`, `Add-DfsrConnection -GroupName RG-${share} -SourceComputerName FS01 -DestinationComputerName ${br}`, `Set-DfsrMembership -GroupName RG-${share} -FolderName ${share} -ComputerName FS01 -ContentPath D:\\Shares\\${share} -PrimaryMember $true`, `New-DfsnFolderTarget -Path \\\\campus.local\\Shares\\${share} -TargetPath \\\\${br}\\${share}`],
      }),
      hints: ['Only one member is primary, and only for the first replication.', 'Set the primary member first, then the branch.'],
      initialState: system({ machines: [dc01(net), fs01(net, { features: ['FS-FileServer', 'FS-DFS-Namespace'], shares: [{ name: share, path: `D:\\Shares\\${share}`, server: 'FS01', access: [{ account: 'Authenticated Users', right: 'Change' }] }, { name: 'Shares', path: 'D:\\DFSRoots\\Shares', server: 'FS01', access: [{ account: 'Authenticated Users', right: 'Read' }] }], dfs: { roots: [{ path: '\\\\campus.local\\Shares', type: 'DomainV2', folders: [{ path: `\\\\campus.local\\Shares\\${share}`, targets: [`\\\\FS01\\${share}`] }] }], replication: [] } }), fs01(net, { shares: [{ name: share, path: `D:\\Shares\\${share}`, server: br, access: [{ account: 'Authenticated Users', right: 'Change' }] }] }, br, 40)], machineFiles: { FS01: { [`D:\\Shares\\${share}\\${doc}`]: `${share} master copy\n`, 'D:\\DFSRoots\\Shares\\readme.txt': 'root\n' }, [br]: { [`D:\\Shares\\${share}\\.keep`]: '' } } }),
      checks: [ps(`${doc} has replicated to ${br}`, `Get-Content D:\\Shares\\${share}\\${doc}`, { machine: br, equals: `${share} master copy` }), ps('Both servers are replication members', 'Get-DfsReplicationGroup | ForEach-Object { $_.Members }', { contains: ['FS01', br] }), ps(`The namespace folder has both targets`, `Get-DfsnFolderTarget -Path \\\\campus.local\\Shares\\${share} | ForEach-Object { $_.TargetPath }`, { contains: [`\\\\FS01\\${share}`, `\\\\${br}\\${share}`] })],
      solution: [`Install-WindowsFeature FS-DFS-Replication -IncludeManagementTools -ComputerName FS01`, `Install-WindowsFeature FS-DFS-Replication -IncludeManagementTools -ComputerName ${br}`, `New-DfsReplicationGroup -GroupName RG-${share}`, `New-DfsReplicatedFolder -GroupName RG-${share} -FolderName ${share}`, `Add-DfsrMember -GroupName RG-${share} -ComputerName FS01,${br}`, `Add-DfsrConnection -GroupName RG-${share} -SourceComputerName FS01 -DestinationComputerName ${br}`, `Set-DfsrMembership -GroupName RG-${share} -FolderName ${share} -ComputerName FS01 -ContentPath D:\\Shares\\${share} -PrimaryMember $true`, `Set-DfsrMembership -GroupName RG-${share} -FolderName ${share} -ComputerName ${br} -ContentPath D:\\Shares\\${share}`, `New-DfsnFolderTarget -Path \\\\campus.local\\Shares\\${share} -TargetPath \\\\${br}\\${share}`],
      realityNote: 'DFS-R plus namespace targets give branch campuses local copies of shared content; site-aware referrals send each user to the nearest target.',
    };
  }),

  /* ---------------------------------------------------------------- 5.4 print services */
  tmpl(5, 4, 'beginner', 'shared-printer', 'Install and share a network printer', 'E4', 20, 'Add a driver, a TCP/IP port and a shared, published printer on the print server.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const name = `${dept}-MFP${v.int(1, 3)}`;
    const ip = `${net}.${v.int(200, 240)}`;
    const driver = v.driver();
    return {
      instructions: lab({
        situation: `${dept} has a new multifunction printer at **${ip}**. Install it on **PRINT01** as **${name}**, using the **${driver}** driver, shared as **${name}** and **published** in Active Directory so people can find it, with location "${dept} office".`,
        steps: ['Add the driver to PRINT01.', `Add a Standard TCP/IP port called IP_${ip}.`, 'Add the printer: driver, port, shared, published, location.', 'Check with Get-Printer.'],
        tips: [`Add-PrinterDriver -Name "${driver}"`, `Add-PrinterPort -Name IP_${ip} -PrinterHostAddress ${ip}`, `Add-Printer -Name ${name} -DriverName "${driver}" -PortName IP_${ip} -Shared -ShareName ${name} -Published -Location "${dept} office"`],
      }),
      hints: ['The driver has to be on the server before the printer can use it.', 'Clients download the driver from the print server when they connect.'],
      initialState: system({ machines: [dc01(net), print01(net)] }),
      checks: [ps(`${name} uses the ${driver} driver`, `(Get-Printer -Name ${name}).DriverName`, { machine: 'PRINT01', equals: driver }), ps(`${name} prints to ${ip}`, `Get-PrinterPort | Where-Object { $_.Name -eq (Get-Printer -Name ${name}).PortName } | ForEach-Object { $_.PrinterHostAddress }`, { machine: 'PRINT01', equals: ip }), ps(`${name} is shared as ${name}`, `(Get-Printer -Name ${name}).ShareName`, { machine: 'PRINT01', equals: name }), ps(`${name} is published in AD`, `(Get-Printer -Name ${name}).Published`, { machine: 'PRINT01', equals: 'True' })],
      solution: [`Invoke-Command -ComputerName PRINT01 -ScriptBlock { Add-PrinterDriver -Name "${driver}"; Add-PrinterPort -Name IP_${ip} -PrinterHostAddress ${ip}; Add-Printer -Name ${name} -DriverName "${driver}" -PortName IP_${ip} -Shared -ShareName ${name} -Published -Location "${dept} office" }`],
      realityNote: 'Central print servers give one place for drivers, queues and permissions; universal drivers from HP, Canon, Kyocera and Xerox cut the driver count dramatically.',
    };
  }),
  tmpl(5, 4, 'intermediate', 'deploy-printer-gpo', 'Deploy a printer to a department with Group Policy', 'E4', 20, 'Link a GPO that connects a department\'s users to their shared printer.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [u, other] = v.people(2);
    const share = `${dept}-MFP1`;
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const gpo = `Printers - ${dept}`;
    return {
      instructions: lab({
        situation: `${dept} staff keep asking the helpdesk to add their printer. **\\\\PRINT01\\${share}** is already shared. Deploy it to every user in **OU=${dept},OU=Staff** with a GPO called **${gpo}**, and make sure staff in other departments do not get it.`,
        steps: [`Create the GPO **${gpo}**.`, 'Add the deployed printer to its user settings.', `Link it to OU=${dept},OU=Staff.`, `Check the result for ${u.sam} on ${pcName} with gpresult or Get-GPResultantSetOfPolicy.`],
        tips: [`New-GPO -Name "${gpo}"`, `Set-GPSetting -Name "${gpo}" -Setting "Deployed printer" -Value \\\\PRINT01\\${share}`, `New-GPLink -Name "${gpo}" -Target "${ouDn(dept, 'Staff')}"`],
      }),
      hints: ['Printer deployment to users is a user setting, so link the GPO where the user accounts are.', 'Set-GPSetting is this lab\'s stand-in for the Group Policy Management Editor.'],
      initialState: system({ machines: [dc01(net), print01(net, { drivers: ['Microsoft Print To PDF', 'HP Universal Printing PCL 6'], ports: [{ name: `IP_${net}.210`, host: `${net}.210` }], printers: [{ name: share, driver: 'HP Universal Printing PCL 6', port: `IP_${net}.210`, shared: true, shareName: share, published: true, jobs: [] }] }), pc(pcName, net, 50)], ad: (st) => { addOu(st, 'Staff'); const ou = addOu(st, dept, ouDn('Staff')); const ou2 = addOu(st, 'Other', ouDn('Staff')); addUser(st, u, ou, { department: dept }); addUser(st, other, ou2); placeComputer(st, pcName, addOu(st, 'Computers')); } }),
      checks: [extra(`${u.sam} gets \\\\PRINT01\\${share} on ${pcName}`, 'User:Deployed printer', pcName, `\\\\PRINT01\\${share}`, u.sam), extra(`${other.sam} (another department) does not`, 'User:Deployed printer', pcName, null, other.sam), ps(`${gpo} is linked to ${dept}`, `Get-GPInheritance -Target "${ouDn(dept, 'Staff')}" | ForEach-Object { $_.GpoLinks }`, { contains: gpo })],
      solution: [`New-GPO -Name "${gpo}"`, `Set-GPSetting -Name "${gpo}" -Setting "Deployed printer" -Value \\\\PRINT01\\${share}`, `New-GPLink -Name "${gpo}" -Target "${ouDn(dept, 'Staff')}"`, `Get-GPResultantSetOfPolicy -User ${u.sam} -Computer ${pcName}`],
      realityNote: 'Deploying printers by GPO (or Group Policy Preferences with item-level targeting) is how institutions avoid per-desk printer setup.',
    };
  }),
  tmpl(5, 4, 'advanced', 'print-queue-down', 'Bring a stuck print service back', 'E4', 30, 'Clear a job stuck in the spooler, open the firewall for clients and reconnect a PC.', (v) => {
    const net = v.net();
    const share = `${v.pick(DEPTS)}-MFP${v.int(1, 3)}`;
    const [u1, u2] = v.people(2);
    const stuck = v.int(10, 40);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const doc = v.pick(['Exam timetable.pdf', 'Payroll summary.xlsx', 'Senate minutes.docx']);
    return {
      instructions: lab({
        situation: `Nothing prints on **${share}** at PRINT01. Job **${stuck}** (${doc}, from ${u1.sam}) is stuck in **Error** and blocks the queue; Remove-PrintJob will not delete it. Also, after a firewall hardening, **${pcName}** cannot even connect to the printer. Fix the queue without losing ${u2.sam}'s waiting job, then connect ${pcName} to \\\\PRINT01\\${share}.`,
        steps: ['Look at the queue with Get-PrintJob on PRINT01.', `Clear the stuck job: stop the Spooler, delete its spool file (C:\\Windows\\System32\\spool\\PRINTERS\\000${stuck}.SPL), start the Spooler.`, "Enable PRINT01's File and Printer Sharing (SMB-In) firewall rule.", `On ${pcName}, connect with Add-Printer -ConnectionName.`],
        tips: [`Get-PrintJob -PrinterName ${share}`, 'Stop-Service Spooler', 'Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\FILE.SPL', 'Enable-NetFirewallRule -DisplayName "File and Printer Sharing (SMB-In)"', `Add-Printer -ConnectionName \\\\PRINT01\\${share}`],
      }),
      hints: ['Deleting every file in the spool folder also loses the jobs that were fine.', 'Clients reach shared printers over SMB (445).'],
      initialState: system({ machines: [dc01(net), print01(net, { drivers: ['Microsoft Print To PDF', 'HP Universal Printing PCL 6'], ports: [{ name: `IP_${net}.211`, host: `${net}.211` }], printers: [{ name: share, driver: 'HP Universal Printing PCL 6', port: `IP_${net}.211`, shared: true, shareName: share, published: true, jobs: [{ id: stuck, document: doc, owner: u1.sam, status: 'Error' }, { id: stuck + 1, document: 'Letter.docx', owner: u2.sam, status: 'Spooling' }] }] }), pc(pcName, net, 51)], ad: (st) => { const ou = addOu(st, 'Staff'); addUser(st, u1, ou); addUser(st, u2, ou); }, machineFiles: { PRINT01: { [`C:\\Windows\\System32\\spool\\PRINTERS\\000${stuck}.SPL`]: 'stuck\n', [`C:\\Windows\\System32\\spool\\PRINTERS\\000${stuck + 1}.SPL`]: 'ok\n' } } }),
      checks: [ps('No job is stuck in Error', `Get-PrintJob -PrinterName ${share} | ForEach-Object { $_.JobStatus }`, { machine: 'PRINT01', notContains: 'Error' }), ps(`${u2.sam}'s job is still queued`, `Get-PrintJob -PrinterName ${share} | ForEach-Object { $_.SubmittedBy }`, { machine: 'PRINT01', contains: u2.sam, message: 'The waiting job was lost: delete only the stuck job\'s spool file.' }), ps('The Spooler is running', '(Get-Service Spooler).Status', { machine: 'PRINT01', equals: 'Running' }), ps(`${pcName} is connected to the printer`, 'Get-Printer | ForEach-Object { $_.Name }', { machine: pcName, contains: `\\\\PRINT01\\${share}` })],
      solution: [`Invoke-Command -ComputerName PRINT01 -ScriptBlock { Get-PrintJob -PrinterName ${share}; Stop-Service Spooler; Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\000${stuck}.SPL; Start-Service Spooler; Enable-NetFirewallRule -DisplayName "File and Printer Sharing (SMB-In)" }`, `Invoke-Command -ComputerName ${pcName} -ScriptBlock { Add-Printer -ConnectionName \\\\PRINT01\\${share} }`],
      realityNote: 'Corrupt spool files are the most common print server fault; the stop, delete, start routine is in every helpdesk runbook.',
    };
  }),

  /* ---------------------------------------------------------------- 5.5 offline files, folder redirection */
  tmpl(5, 5, 'beginner', 'redirect-documents', 'Redirect staff Documents to the file server', 'E4', 15, 'Create and link a GPO that redirects Documents for one OU.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const [u, other] = v.people(2);
    const pcName = `OFF-PC${v.int(10, 60)}`;
    const target = '\\\\FS01\\Redirected$\\%USERNAME%\\Documents';
    return {
      instructions: lab({
        situation: `${dept} staff lose their work when PCs are reimaged, because Documents is on the local disk. Redirect **Documents** for users in **OU=${dept},OU=Staff** to **${target}** with a GPO called **Redirect - ${dept}**.`,
        steps: ['Create the GPO.', 'Set folder redirection for Documents.', 'Link it to the department OU.', `Check what ${u.sam} gets on ${pcName}.`],
        tips: [`Set-GPSetting -Name "Redirect - ${dept}" -Setting "Folder redirection: Documents" -Value '${target}'`],
      }),
      hints: ['Folder redirection is a user setting.', '%USERNAME% gives each user their own folder.'],
      initialState: system({ machines: [dc01(net), fs01(net), pc(pcName, net, 52)], ad: (st) => { addOu(st, 'Staff'); const ou = addOu(st, dept, ouDn('Staff')); addUser(st, u, ou); addUser(st, other, addOu(st, 'Other', ouDn('Staff'))); } }),
      checks: [extra(`${u.sam}'s Documents are redirected`, 'User:Folder redirection: Documents', pcName, target, u.sam), extra(`${other.sam} (another department) is not redirected`, 'User:Folder redirection: Documents', pcName, null, other.sam)],
      solution: [`New-GPO -Name "Redirect - ${dept}"`, `Set-GPSetting -Name "Redirect - ${dept}" -Setting "Folder redirection: Documents" -Value '${target}'`, `New-GPLink -Name "Redirect - ${dept}" -Target "${ouDn(dept, 'Staff')}"`],
      realityNote: 'Folder redirection keeps user data on servers that are backed up, and makes any PC feel like your own.',
    };
  }),
  tmpl(5, 5, 'intermediate', 'offline-files', 'Turn on offline files for laptops only', 'E4', 20, 'Set share caching and an Offline Files policy that targets laptops and not lab PCs.', (v) => {
    const net = v.net();
    const share = v.pick(['Redirected$', 'Staff', 'Lecturers']);
    const laptop = `LT-${v.int(100, 400)}`;
    const labPc = `LAB-${v.int(1, 4)}-0${v.int(1, 9)}`;
    return {
      instructions: lab({
        situation: `Lecturers take laptops to other campuses and lose access to **\\\\FS01\\${share}** when the link drops. Make the share's files available offline automatically (**caching mode Documents**), and switch on **Offline Files** with a GPO **Offline Files - Laptops** linked to **OU=Laptops**. Lab PCs (OU=Labs) are shared by many people and must not cache anything.`,
        steps: [`Set the share's caching mode on FS01.`, 'Create the GPO and set the Offline Files policy (HKLM\\Software\\Policies\\Microsoft\\Windows\\NetCache, Enabled = 1).', 'Link it to OU=Laptops only.'],
        tips: [`Set-SmbShare -Name ${share} -CachingMode Documents -Force`, gpSet('Offline Files - Laptops', HK.netcache, 'DWord', 1)],
      }),
      hints: ['Manual caching makes users pin files; Documents caches what they open.', 'Offline Files is a computer setting, so link it where the computer accounts are.'],
      initialState: system({ machines: [dc01(net), fs01(net, { shares: [{ name: share, path: 'D:\\Redirected', server: 'FS01', access: [{ account: 'Authenticated Users', right: 'Change' }], caching: 'Manual' }] }), pc(laptop, net, 60), pc(labPc, net, 61)], ad: (st) => { placeComputer(st, laptop, addOu(st, 'Laptops')); placeComputer(st, labPc, addOu(st, 'Labs')); }, machineFiles: { FS01: { 'D:\\Redirected\\readme.txt': 'x\n' } } }),
      checks: [ps('The share caches documents', `(Get-SmbShare -Name ${share}).CachingMode`, { machine: 'FS01', equals: 'Documents' }), policy(`Offline Files is on for ${laptop}`, HK.netcache, laptop, 1), policy(`Offline Files is not set on ${labPc}`, HK.netcache, labPc, null)],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Set-SmbShare -Name ${share} -CachingMode Documents -Force }`, 'New-GPO -Name "Offline Files - Laptops"', gpSet('Offline Files - Laptops', HK.netcache, 'DWord', 1), `New-GPLink -Name "Offline Files - Laptops" -Target "${ouDn('Laptops')}"`],
      realityNote: 'Offline Files suits laptops on unreliable links; on shared lab machines it only fills disks with other people\'s cached files.',
    };
  }),
  tmpl(5, 5, 'advanced', 'redirection-design', 'Design user data storage for staff and labs', 'E10', 20, 'Choose between folder redirection, roaming profiles and cloud sync, and set safe permissions.', (v) => {
    const staff = v.int(300, 900);
    return caseStudy(v, {
      intro: `## Where should user data live?\n\nThe university has ${staff} staff on desktops and laptops, and teaching labs where any student can sit at any PC. Decide how user data and settings are stored.`,
      steps: [
        { title: 'Staff documents', text: 'Staff want their Documents on any PC, and ICT wants them backed up.', choices: [{ text: 'Folder redirection of Documents (and Desktop) to a file server share', right: true, feedback: 'Correct. Data lives on the server from the start and is backed up there.' }, { text: 'Roaming profiles holding everything', feedback: 'Roaming profiles copy everything at every logon and logoff; large Documents make logons crawl.' }, { text: 'Leave Documents local and ask staff to copy files to a share', feedback: 'They will not, until the disk dies.' }] },
        { title: 'Root folder permissions', text: 'The redirection root \\\\FS01\\Redirected$ is created by ICT. What NTFS permissions on the root?', choices: [{ text: 'Staff: create folder (this folder only); CREATOR OWNER: Full Control (subfolders); Administrators and SYSTEM Full', right: true, feedback: 'Correct. Each user can create their own folder and nobody else\'s.' }, { text: 'Everyone: Full Control', feedback: 'Then everyone can read everyone\'s documents.' }, { text: 'Domain Users: Modify on the whole tree', feedback: 'Every user could open every other user\'s folder.' }] },
        { title: 'Labs', text: 'Students in the labs need their files but any PC may be reimaged nightly.', choices: [{ text: 'Redirect to a student share, no offline caching, delete cached profiles at logoff', right: true, feedback: 'Correct. Nothing personal is left on shared PCs.' }, { text: 'Offline Files on every lab PC', feedback: 'Caches pile up other students\' files on shared machines.' }, { text: 'Roaming profiles for all students', feedback: 'Thousands of profiles copying at the start of every class would choke the network.' }] },
        { title: 'Laptops', text: 'Lecturers\' laptops leave campus.', choices: [{ text: 'Redirection plus Offline Files for the laptops OU', right: true, feedback: 'Correct. They keep working offline and sync on return.' }, { text: 'No redirection for laptops', feedback: 'Then laptop data is never backed up.' }, { text: 'VPN always on, no caching', feedback: 'Works only where there is a connection.' }] },
        { title: 'Cloud', text: 'The university also has OneDrive licences. A sensible long-term direction?', choices: [{ text: 'Known Folder Move to OneDrive for staff, keeping file servers for shared departmental data', right: true, feedback: 'Correct. Many institutions now move personal folders to cloud sync and keep shares for team data.' }, { text: 'Use both redirection and Known Folder Move on the same folders', feedback: 'Two mechanisms fighting over one folder causes conflicts; choose one per folder.' }, { text: 'Cloud is never acceptable for staff data', feedback: 'It depends on data protection rules, not a blanket ban; Act 843 and contracts set the conditions.' }] },
      ],
      ending: { title: 'Storage design agreed', text: 'Redirection with safe root permissions, Offline Files only for laptops, nothing cached in labs, and a plan for cloud sync.' },
      hints: ['CREATOR OWNER gives each user rights to the folder they create.', 'Offline Files belongs on machines that leave the network.'],
      realityNote: 'Microsoft documents exactly these root-folder permissions for folder redirection; the choice between redirection and cloud known-folder sync is a live one at most universities.',
    });
  }),
];

export { ran };
