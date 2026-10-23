/** Unit 1: Windows Server introduction and installation. */

import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { COURSE, bare, dc01, fs01, lab, nic, ps, ran, rawDisk, svc, system, systemDisk } from './kit';

const T = (unit: number, topicIndex: number, level: TaskTemplate['level'], slug: string, title: string, engine: string, minutes: number, summary: string, build: TaskTemplate['build']): TaskTemplate => ({ id: `sa1-u${unit}t${topicIndex}-${level[0]}-${slug}`, course: COURSE, unit, topicIndex, level, title, engine, estimatedMinutes: minutes, summary, build });

const ROLE_NEEDS: Array<[string, string]> = [
  ['DHCP', 'hand out IP addresses to the branch PCs'],
  ['DNS', 'resolve names for the branch without crossing the WAN'],
  ['FS-FileServer', 'hold and share the branch documents'],
  ['Web-Server', 'host the branch intranet site'],
  ['FS-Resource-Manager', 'enforce quotas on the staff folders'],
  ['WDS', 'deploy Windows images to new PCs over the network'],
];

export const U1: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 1.1 roles, editions, licensing */
  T(1, 1, 'beginner', 'audit-a-server', 'Audit a server: edition, installation type and roles', 'E4', 15, 'Read edition, installation type and installed roles from a remote server and record them.', (v) => {
    const net = v.net();
    const name = v.pick(['APP01', 'FIN-SRV01', 'HR-SRV02', 'LIB-SRV01', 'REG-SRV03']);
    const edition = v.pick(['Standard', 'Datacenter']);
    const core = v.random() < 0.5;
    const roles = v.some(['DHCP', 'DNS', 'FS-FileServer', 'Web-Server', 'FS-Resource-Manager', 'WDS'], 2);
    const typeWord = core ? 'Server Core' : 'Desktop Experience';
    return {
      instructions: lab({
        situation: `Nobody documented **${name}** when it was built. Before the audit visit you need three facts about it: its edition (Standard or Datacenter), its installation type (Server Core or Desktop Experience), and the roles and features installed on it. You are signed in to DC01.`,
        steps: [
          `Query ${name} remotely: \`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-ComputerInfo }\`. WindowsInstallationType reads **Server Core** for a core install and **Server** for Desktop Experience.`,
          `List what is installed on ${name}: \`Get-WindowsFeature\` marks installed items with [X]; \`Where-Object { $_.Installed -eq $true }\` keeps just those.`,
          `Write the findings to **C:\\Answers\\${name}.txt**, one per line: \`Edition: ...\`, \`Installation: Server Core\` or \`Installation: Desktop Experience\`, and \`Roles: ...\` with the feature names.`,
        ],
        tips: ['Set-Content C:\\Answers\\file.txt "line one","line two"'],
      }),
      hints: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-WindowsFeature | Where-Object { $_.Installed -eq $true } }`, 'A WindowsInstallationType of "Server" means Desktop Experience.', 'Set-Content accepts several lines separated by commas.'],
      initialState: system({ machines: [dc01(net), { name, os: `Windows Server 2022 ${edition}`, installType: core ? 'Server Core' : 'Desktop Experience', features: roles, nics: [nic(`${net}.30`, net)] }], files: { 'C:\\Answers\\README.txt': 'Put your answer files here.\n' } }),
      checks: [
        ps('The edition is recorded', `Get-Content C:\\Answers\\${name}.txt`, { contains: edition, message: `C:\\Answers\\${name}.txt should name the edition of ${name}.` }),
        ps('The installation type is recorded', `Get-Content C:\\Answers\\${name}.txt`, { contains: typeWord, message: `Record the installation type as "${core ? 'Server Core' : 'Desktop Experience'}"-style wording: Server Core or Desktop Experience.` }),
        ps('The installed roles are recorded', `Get-Content C:\\Answers\\${name}.txt`, { contains: roles, message: 'List every installed role or feature name.' }),
        ran('You read it with Get-ComputerInfo', 'Get-ComputerInfo'),
        ran('You listed features with Get-WindowsFeature', 'Get-WindowsFeature'),
      ],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-ComputerInfo }`, `Invoke-Command -ComputerName ${name} -ScriptBlock { Get-WindowsFeature | Where-Object { $_.Installed -eq $true } }`, `Set-Content C:\\Answers\\${name}.txt "Edition: Windows Server 2022 ${edition}","Installation: ${typeWord}","Roles: ${roles.join(', ')}"`],
      realityNote: 'Asset registers drift from reality quickly. Querying servers with Get-ComputerInfo and Get-WindowsFeature over remoting is how administrators keep documentation honest.',
    };
  }),
  T(1, 1, 'intermediate', 'install-branch-roles', 'Install the roles a branch server needs', 'E4', 20, 'Translate business needs into Windows Server roles and install exactly those, remotely.', (v) => {
    const net = v.net();
    const city = v.city();
    const name = `${city.slice(0, 3).toUpperCase()}-SRV01`;
    const chosen = v.some(ROLE_NEEDS, 3);
    const decoy = ROLE_NEEDS.find((r) => !chosen.includes(r))!;
    const core = v.random() < 0.6;
    return {
      instructions: lab({
        situation: `The new ${city} branch office has one server, **${name}** (${core ? 'Server Core' : 'Desktop Experience'}). The branch manager's list says the server must:\n\n${chosen.map(([, need]) => `- ${need}`).join('\n')}\n\nInstall the roles or features that do these things, with their management tools, and nothing else. Every extra role is more to patch and more to attack.`,
        steps: [`List the available roles: \`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-WindowsFeature }\`.`, `Install the right ones in one command with \`Install-WindowsFeature <name>,<name> -IncludeManagementTools\`.`, `Check the result with Get-WindowsFeature again.`],
        tips: ['Install-WindowsFeature -Name A,B -IncludeManagementTools -ComputerName SERVER'],
      }),
      hints: [`The feature names: ${ROLE_NEEDS.map(([n]) => n).join(', ')}.`, 'You can run Install-WindowsFeature with -ComputerName, or inside Invoke-Command.', `${decoy[0]} is not on the list: leave it out.`],
      initialState: system({ machines: [dc01(net), { name, installType: core ? 'Server Core' : 'Desktop Experience', features: [], nics: [nic(`${net}.40`, net)] }] }),
      checks: [
        ...chosen.map(([feature, need]) => ps(`${feature} is installed (to ${need})`, `(Get-WindowsFeature -Name ${feature}).InstallState`, { machine: name, equals: 'Installed', message: `${name} still needs the feature that will ${need}.` })),
        ps(`Nothing unnecessary: ${decoy[0]} is not installed`, `(Get-WindowsFeature -Name ${decoy[0]}).InstallState`, { machine: name, equals: 'Available', message: `${decoy[0]} is not on the branch list. Uninstall-WindowsFeature ${decoy[0]}.` }),
      ],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-WindowsFeature }`, `Install-WindowsFeature -Name ${chosen.map(([f]) => f).join(',')} -IncludeManagementTools -ComputerName ${name}`],
      realityNote: 'Installing only the roles a server needs is the first rule of hardening; CIS and Microsoft security baselines both start from a minimal role set.',
    };
  }),
  T(1, 1, 'advanced', 'licensing-decisions', 'Choose editions, installation types and client licences', 'E10', 20, 'Work out Standard against Datacenter costs and pick installation types and CAL models for a campus.', (v) => {
    const cores = v.pick([16, 24, 32]);
    const vms = v.pick([2, 4, 6, 10, 14, 20]);
    const packs = cores / 16;
    const std = Math.ceil(vms / 2) * Math.round(packs * 1069);
    const dc = Math.round(packs * 6155);
    const cheaper = std <= dc ? 'Standard' : 'Datacenter';
    const staff = v.int(80, 200);
    const lab = v.random() < 0.5;
    const pcs = v.int(25, 60);
    const students = v.int(300, 900);
    return caseStudy(v, {
      intro: `## Licensing a new virtualisation host\n\nThe ICT office is buying a Hyper-V host with **${cores} cores** that will run **${vms} Windows Server virtual machines**. Work through the decisions with the price list in the evidence. Prices are per 16-core licence, list price in US dollars.`,
      steps: [
        { title: 'Which edition?', text: `The host has ${cores} cores and will run ${vms} Windows Server VMs. Which edition costs less?`, evidence: [{ title: 'Price list and rules', text: `Standard, 16 cores: $1,069. Each fully licensed Standard host covers 2 Windows Server VMs; license all cores again for every further 2 VMs.\nDatacenter, 16 cores: $6,155. Unlimited Windows Server VMs on the licensed host.\nEvery physical core must be licensed, 16 cores minimum per server.\n\nThis host: ${cores} cores = ${packs} × 16-core licence${packs > 1 ? 's' : ''}.` }], choices: [
          { text: `Standard: ${Math.ceil(vms / 2)} × ${packs} × $1,069 = $${std.toLocaleString('en-US')}`, right: cheaper === 'Standard', feedback: `Standard costs $${std.toLocaleString('en-US')} and Datacenter $${dc.toLocaleString('en-US')}, so ${cheaper} is cheaper here.` },
          { text: `Datacenter: ${packs} × $6,155 = $${dc.toLocaleString('en-US')}`, right: cheaper === 'Datacenter', feedback: `Standard costs $${std.toLocaleString('en-US')} and Datacenter $${dc.toLocaleString('en-US')}, so ${cheaper} is cheaper here.` },
          { text: 'It makes no difference; the edition only changes the features', feedback: 'The editions are licensed very differently for virtual machines, which is the whole question here.' },
        ] },
        { title: 'Infrastructure server', text: 'One VM will run DHCP and DNS only, managed remotely from the ICT office. Which installation type?', choices: [
          { text: 'Server Core', right: true, feedback: 'Correct. Smaller attack surface, fewer updates and reboots, and both roles are fully managed remotely.' },
          { text: 'Desktop Experience', feedback: 'It works, but adds a desktop nobody uses, plus its updates and attack surface.' },
          { text: 'Windows 11 Pro', feedback: 'A client OS cannot host the DHCP and DNS server roles.' },
        ] },
        { title: 'Session host', text: 'Another VM will be a Remote Desktop Session Host where lecturers run Office. Which installation type?', choices: [
          { text: 'Desktop Experience', right: true, feedback: 'Correct. Session hosts give users a desktop, so they need the Desktop Experience.' },
          { text: 'Server Core', feedback: 'Users connecting to a session host need a desktop shell.' },
          { text: 'Either; it can be changed later', feedback: 'Since Windows Server 2016 the installation type cannot be changed after install, so choose correctly now.' },
        ] },
        { title: 'Changing your mind', text: 'If a Server Core install later turns out to need the desktop, what happens?', choices: [
          { text: 'Reinstall: the installation type cannot be switched after setup', right: true, feedback: 'Correct for Windows Server 2016 and later.' },
          { text: 'Install the Server-Gui-Shell feature', feedback: 'That worked on Windows Server 2012 R2 but was removed.' },
          { text: 'Run sconfig and choose option 8', feedback: 'sconfig configures the server; it does not add a desktop.' },
        ] },
        lab
          ? { title: 'Client access licences', text: `${pcs} shared lab PCs are used by about ${students} students in shifts. Which CAL model?`, choices: [
              { text: `Device CALs: ${pcs}`, right: true, feedback: `Correct. ${pcs} device CALs cover every student using those PCs, far fewer than ${students} user CALs.` },
              { text: `User CALs: ${students}`, feedback: 'User CALs suit people with several devices; here many people share few devices.' },
              { text: 'No CALs: the server licence covers clients', feedback: 'Every user or device accessing Windows Server needs a CAL.' },
            ] }
          : { title: 'Client access licences', text: `${staff} staff each use a laptop and a phone to reach the file server. Which CAL model?`, choices: [
              { text: `User CALs: ${staff}`, right: true, feedback: `Correct. ${staff} user CALs cover every device each person uses, half of the ${staff * 2} device CALs needed.` },
              { text: `Device CALs: ${staff * 2}`, feedback: 'Device CALs suit shared devices; here each person has several.' },
              { text: 'No CALs: the server licence covers clients', feedback: 'Every user or device accessing Windows Server needs a CAL.' },
            ] },
      ],
      ending: { title: 'Purchase order raised', text: `You order ${cheaper} for the ${cores}-core host, Server Core for infrastructure VMs, Desktop Experience for the session host, and ${lab ? 'device' : 'user'} CALs.` },
      hints: ['Count how many Standard licence sets the VMs need: one per 2 VMs.', 'Server Core cannot be turned into Desktop Experience after installation.', 'User CALs follow people; device CALs follow machines.'],
      realityNote: 'These are the real Windows Server 2022 licensing rules (core-based, 16-core minimum, 2 VMs per Standard licence). Universities usually buy through academic agreements, but the arithmetic is the same.',
    });
  }),

  /* ---------------------------------------------------------------- 1.2 virtual lab */
  T(1, 2, 'beginner', 'first-vm', 'Create a virtual switch and your first VM', 'E4', 15, 'Create an internal switch and a generation 2 VM on a Hyper-V host.', (v) => {
    const net = v.net();
    const sw = v.pick(['LabNet', 'TestNet', 'StudentNet', 'Sandbox']);
    const vm = v.pick(['SRV-TEST01', 'WIN-LAB01', 'DC-TEST', 'APP-TEST02']);
    const gb = v.pick([2, 4, 8]);
    return {
      instructions: lab({
        situation: `HV01 is the department's Hyper-V host. Build a practice VM for the networking class: an **Internal** virtual switch called **${sw}** and a **generation 2** VM called **${vm}** with **${gb} GB** of startup memory, connected to ${sw}.`,
        steps: [`Run the commands on HV01 with Invoke-Command (or Enter-PSSession HV01).`, `\`New-VMSwitch -Name ${sw} -SwitchType Internal\``, `\`New-VM -Name ${vm} -MemoryStartupBytes ${gb}GB -Generation 2 -SwitchName ${sw}\``, 'Check with Get-VM and Get-VMSwitch.'],
        tips: ['Enter-PSSession -ComputerName HV01', 'Get-VM | Format-List'],
      }),
      hints: ['An Internal switch connects VMs to each other and to the host, but not to the physical network.', 'Generation 2 VMs boot with UEFI and support Secure Boot.', `New-VM ... -MemoryStartupBytes ${gb}GB`],
      initialState: system({ machines: [dc01(net), { name: 'HV01', features: ['Hyper-V'], hyperv: { switches: [], vms: [] }, nics: [nic(`${net}.15`, net)] }] }),
      checks: [
        ps(`${sw} is an Internal switch`, `(Get-VMSwitch -Name ${sw}).SwitchType`, { machine: 'HV01', equals: 'Internal' }),
        ps(`${vm} is generation 2`, `(Get-VM -Name ${vm}).Generation`, { machine: 'HV01', equals: '2' }),
        ps(`${vm} starts with ${gb} GB`, `(Get-VM -Name ${vm}).MemoryStartup`, { machine: 'HV01', equals: String(gb * 1024 * 1024 * 1024) }),
        ps(`${vm} is connected to ${sw}`, `(Get-VM -Name ${vm}).SwitchName`, { machine: 'HV01', equals: sw }),
      ],
      solution: [`Invoke-Command -ComputerName HV01 -ScriptBlock { New-VMSwitch -Name ${sw} -SwitchType Internal }`, `Invoke-Command -ComputerName HV01 -ScriptBlock { New-VM -Name ${vm} -MemoryStartupBytes ${gb}GB -Generation 2 -SwitchName ${sw} }`],
      realityNote: 'Labs on Hyper-V or VirtualBox let you break things safely; the same New-VM command scripts whole classroom labs.',
    };
  }),
  T(1, 2, 'intermediate', 'isolated-lab', 'Build an isolated test lab with checkpoints', 'E4', 20, 'Private switch, two connected VMs and checkpoints before risky changes.', (v) => {
    const net = v.net();
    const sw = v.pick(['Isolated', 'PatchTest', 'Quarantine', 'PrivateLab']);
    const [a, b] = v.pick([['DC-TEST', 'CL-TEST'], ['SRV-UPD', 'PC-UPD'], ['APP-STAGE', 'WEB-STAGE']]);
    const cp = v.pick(['Before updates', 'Clean install', 'Baseline']);
    return {
      instructions: lab({
        situation: `Before patching production you test updates on copies. On HV01 build a lab that **cannot reach the campus network**: a **Private** switch **${sw}**, two generation 2 VMs **${a}** and **${b}** (2 GB each) on it, and a checkpoint called **"${cp}"** on each VM so you can roll back.`,
        steps: ['Create the Private switch.', 'Create both VMs on it.', `Checkpoint each VM with \`Checkpoint-VM -Name <vm> -SnapshotName "${cp}"\`.`, 'Confirm with Get-VMSnapshot.'],
        tips: ['New-VMSwitch -Name NAME -SwitchType Private', 'Get-VMSnapshot -VMName NAME'],
      }),
      hints: ['Private: VMs talk only to each other. Internal adds the host. External adds the physical network.', 'Checkpoint-VM takes a point-in-time copy you can return to with Restore-VMSnapshot.'],
      initialState: system({ machines: [dc01(net), { name: 'HV01', features: ['Hyper-V'], hyperv: { switches: [{ name: 'External', type: 'External' }], vms: [] }, nics: [nic(`${net}.15`, net)] }] }),
      checks: [
        ps(`${sw} is a Private switch`, `(Get-VMSwitch -Name ${sw}).SwitchType`, { machine: 'HV01', equals: 'Private' }),
        ps(`${a} is on ${sw}`, `(Get-VM -Name ${a}).SwitchName`, { machine: 'HV01', equals: sw }),
        ps(`${b} is on ${sw}`, `(Get-VM -Name ${b}).SwitchName`, { machine: 'HV01', equals: sw }),
        ps(`${a} has the "${cp}" checkpoint`, `(Get-VMSnapshot -VMName ${a}).Name`, { machine: 'HV01', contains: cp }),
        ps(`${b} has the "${cp}" checkpoint`, `(Get-VMSnapshot -VMName ${b}).Name`, { machine: 'HV01', contains: cp }),
      ],
      solution: [`Invoke-Command -ComputerName HV01 -ScriptBlock { New-VMSwitch -Name ${sw} -SwitchType Private; New-VM -Name ${a} -MemoryStartupBytes 2GB -Generation 2 -SwitchName ${sw}; New-VM -Name ${b} -MemoryStartupBytes 2GB -Generation 2 -SwitchName ${sw}; Checkpoint-VM -Name ${a} -SnapshotName "${cp}"; Checkpoint-VM -Name ${b} -SnapshotName "${cp}" }`],
      realityNote: 'Patch testing in an isolated ring before production is standard change practice; checkpoints make the test repeatable.',
    };
  }),
  T(1, 2, 'advanced', 'vm-will-not-start', 'Get a VM running with network access on a full host', 'E4', 25, 'Diagnose host memory pressure and the wrong switch type without disturbing a production VM.', (v) => {
    const net = v.net();
    const web = v.pick(['WEB01', 'PORTAL01', 'LMS01']);
    const old = v.pick(['OLD-TEST', 'TEMP-VM', 'DEMO-2024']);
    const app = v.pick(['APP02', 'HR-APP01', 'PAY-APP01']);
    const webMem = v.pick([8192, 9216]);
    const oldMem = 16384 - webMem - v.pick([1024, 2048]);
    return {
      instructions: lab({
        situation: `**${app}** on HV01 will not start, and when it did run last month it could not reach the campus network. **${web}** is production and must stay up. The change note says **${old}** was a short-term demo that finished last week. The host has 16 GB for VMs.`,
        steps: [`Find out why ${app} will not start (\`Start-VM ${app}\`, then \`Get-VM\` for memory).`, `Free memory without touching ${web}.`, `Give ${app} network access: it is on an Internal switch; it needs an **External** switch bound to the host's adapter "Ethernet".`, `Start ${app}.`],
        tips: ['Get-VM | Format-Table Name,State,MemoryStartup,SwitchName', 'New-VMSwitch -Name External -NetAdapterName Ethernet', 'Connect-VMNetworkAdapter -VMName NAME -SwitchName SWITCH'],
      }),
      hints: [`${web} and ${old} are running; add up their startup memory and ${app}'s.`, 'An Internal switch never reaches the physical network.', `Stop-VM ${old} frees its memory.`],
      initialState: system({ machines: [dc01(net), { name: 'HV01', features: ['Hyper-V'], hyperv: { switches: [{ name: 'Internal-Only', type: 'Internal' }], vms: [{ name: web, memoryMb: webMem, generation: 2, cpus: 4, switch: 'Internal-Only', state: 'Running', checkpoints: [] }, { name: old, memoryMb: oldMem, generation: 2, cpus: 2, switch: 'Internal-Only', state: 'Running', checkpoints: [] }, { name: app, memoryMb: 4096, generation: 2, cpus: 2, switch: 'Internal-Only', state: 'Off', checkpoints: [] }] }, nics: [nic(`${net}.15`, net)] }] }),
      checks: [
        ps(`${app} is running`, `(Get-VM -Name ${app}).State`, { machine: 'HV01', equals: 'Running' }),
        ps(`${app} is on an External switch`, `(Get-VMSwitch -Name (Get-VM -Name ${app}).SwitchName).SwitchType`, { machine: 'HV01', equals: 'External', message: `${app} must be connected to an External switch to reach the network.` }),
        ps(`${web} is still running`, `(Get-VM -Name ${web}).State`, { machine: 'HV01', equals: 'Running', message: `${web} is production: it should not have been stopped.` }),
      ],
      solution: [`Invoke-Command -ComputerName HV01 -ScriptBlock { Get-VM }`, `Invoke-Command -ComputerName HV01 -ScriptBlock { Stop-VM ${old}; New-VMSwitch -Name External -NetAdapterName Ethernet; Connect-VMNetworkAdapter -VMName ${app} -SwitchName External; Start-VM ${app} }`],
      realityNote: 'Memory is usually the first limit on a Hyper-V host. Dynamic Memory and capacity planning help, but the first fix is retiring VMs nobody needs.',
    };
  }),

  /* ---------------------------------------------------------------- 1.3 initial configuration */
  T(1, 3, 'beginner', 'name-and-time', 'Name a new server and set its time zone', 'E4', 10, 'Rename a freshly installed server to the naming standard and set the time zone.', (v) => {
    const net = v.net();
    const tmp = `WIN-${v.pick(['K7Q2M', 'A91XZ', 'P3LD8', 'R0T5C'])}`;
    const city = v.city();
    const role = v.pick(['FS', 'APP', 'PRN', 'WEB']);
    const target = `${city.slice(0, 3).toUpperCase()}-${role}0${v.int(1, 4)}`;
    return {
      instructions: lab({ situation: `A new server came up with the random name **${tmp}** and the wrong time zone. The campus standard says it must be called **${target}** (city, role, number) and use **Greenwich Standard Time**, Ghana's zone.`, steps: [`Set the time zone on ${tmp} with \`Set-TimeZone -Id "Greenwich Standard Time"\`.`, `Rename it with \`Rename-Computer -NewName ${target}\`, then restart it.`, `Confirm with \`hostname\` on ${target}.`], tips: [`Invoke-Command -ComputerName ${tmp} -ScriptBlock { ... }`, 'Get-TimeZone'] }),
      hints: ['Set the time zone first: after the rename the old name stops working.', `Restart-Computer -ComputerName ${target}`],
      initialState: system({ machines: [dc01(net), { name: tmp, timeZone: v.pick(['UTC', 'W. Central Africa Standard Time']), nics: [nic(`${net}.33`, net)] }] }),
      checks: [ps(`The server is now called ${target}`, 'hostname', { machine: target, equals: target, message: `There is no server called ${target} yet.` }), ps('Its time zone is Greenwich Standard Time', '(Get-TimeZone).Id', { machine: target, equals: 'Greenwich Standard Time' })],
      solution: [`Invoke-Command -ComputerName ${tmp} -ScriptBlock { Set-TimeZone -Id "Greenwich Standard Time"; Rename-Computer -NewName ${target} }`, `Restart-Computer -ComputerName ${target}`],
      realityNote: 'Naming standards (site-role-number) make logs, monitoring and inventories readable at a glance; random WIN- names are the first thing to fix after setup.',
    };
  }),
  T(1, 3, 'intermediate', 'static-address', 'Give a server a static address and the right DNS', 'E4', 15, 'Replace a DHCP address with the planned static IPv4 address, gateway and DNS server.', (v) => {
    const net = v.net();
    const name = v.pick(['APP03', 'FS02', 'PRINT02', 'WSUS01']);
    const last = v.int(30, 60);
    return {
      instructions: lab({ situation: `**${name}** is a new server that still has a DHCP address. Servers keep static addresses on this campus. The address plan gives it **${net}.${last}/24**, gateway **${net}.1**, and DNS server **${net}.10** (DC01).`, steps: ['Set the static address and gateway with New-NetIPAddress.', 'Point DNS at DC01 with Set-DnsClientServerAddress.', 'Check with Get-NetIPConfiguration.'], tips: ['New-NetIPAddress -InterfaceAlias Ethernet -IPAddress A -PrefixLength 24 -DefaultGateway G', 'Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses D'] }),
      hints: ['/24 is -PrefixLength 24.', `A domain member must use a domain controller for DNS, not a public resolver.`],
      initialState: system({ machines: [dc01(net), { name, nics: [nic(undefined, net, { dhcp: true, ip: `${net}.${v.int(150, 200)}`, prefix: 24, gateway: `${net}.1`, dns: [`${net}.1`] })] }] }),
      checks: [
        ps(`${name} has ${net}.${last}`, '(Get-NetIPConfiguration).IPv4Address', { machine: name, equals: `${net}.${last}` }),
        ps('The address is static', '(Get-NetIPAddress -AddressFamily IPv4).PrefixOrigin', { machine: name, equals: 'Manual' }),
        ps(`The gateway is ${net}.1`, '(Get-NetIPConfiguration).IPv4DefaultGateway', { machine: name, equals: `${net}.1` }),
        ps(`DNS points at DC01 (${net}.10)`, '(Get-NetIPConfiguration).DNSServer', { machine: name, equals: `${net}.10` }),
      ],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { New-NetIPAddress -InterfaceAlias Ethernet -IPAddress ${net}.${last} -PrefixLength 24 -DefaultGateway ${net}.1; Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.10 }`],
      realityNote: 'Static addressing for servers, with DHCP reservations as the alternative, keeps DNS records and firewall rules stable.',
    };
  }),
  T(1, 3, 'advanced', 'fix-initial-config', 'Repair a badly configured new server', 'E4', 25, 'Find and fix a wrong gateway, a public DNS server and missing activation.', (v) => {
    const net = v.net();
    const name = v.pick(['APP04', 'HR-SRV03', 'LAB-SRV05']);
    const parts = net.split('.');
    const wrongGw = `${parts[0]}.${parts[1]}.${(Number(parts[2]) + 1) % 250}.1`;
    const last = v.int(30, 60);
    return {
      instructions: lab({ situation: `A contractor built **${name}** and left. Users say it "can't see the domain", and Windows nags about activation. Its address **${net}.${last}/24** is correct, but something else in its network setup is wrong, and it is not activated.`, steps: [`Inspect it: \`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-NetIPConfiguration }\`.`, `Make its gateway the one on its own subnet (${net}.1) and its DNS server DC01 (${net}.10). Remove the old address first with Remove-NetIPAddress, then add it back with the right gateway.`, 'Activate Windows with slmgr /ato.', `Prove it can resolve the domain: \`Resolve-DnsName dc01.campus.local\` from ${name}.`], tips: ['Remove-NetIPAddress -InterfaceAlias Ethernet', 'slmgr /dli'] }),
      hints: [`${wrongGw} is not on ${net}.0/24, so it can never be the gateway.`, '8.8.8.8 knows nothing about campus.local.', 'slmgr /ato activates; slmgr /dli shows the status.'],
      initialState: system({ machines: [dc01(net), { name, activated: false, nics: [nic(`${net}.${last}`, net, { gateway: wrongGw, dns: ['8.8.8.8'] })] }] }),
      checks: [
        ps(`The gateway is ${net}.1`, '(Get-NetIPConfiguration).IPv4DefaultGateway', { machine: name, equals: `${net}.1` }),
        ps('DNS points at DC01', '(Get-NetIPConfiguration).DNSServer', { machine: name, equals: `${net}.10` }),
        ps(`${name} still has its planned address`, '(Get-NetIPConfiguration).IPv4Address', { machine: name, equals: `${net}.${last}` }),
        ps('Windows is activated', 'slmgr /dli', { machine: name, contains: 'License Status: Licensed' }),
        ps('It resolves the domain controller', 'Resolve-DnsName dc01.campus.local', { machine: name, contains: `${net}.10` }),
      ],
      solution: [`Invoke-Command -ComputerName ${name} -ScriptBlock { Get-NetIPConfiguration }`, `Invoke-Command -ComputerName ${name} -ScriptBlock { Remove-NetIPAddress -InterfaceAlias Ethernet; New-NetIPAddress -InterfaceAlias Ethernet -IPAddress ${net}.${last} -PrefixLength 24 -DefaultGateway ${net}.1; Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.10; slmgr /ato }`, `Invoke-Command -ComputerName ${name} -ScriptBlock { Resolve-DnsName dc01.campus.local }`],
      realityNote: 'Wrong DNS on domain members is behind a large share of AD support calls: logons, Group Policy and joins all depend on finding the DCs through DNS.',
    };
  }),

  /* ---------------------------------------------------------------- 1.4 management surfaces */
  T(1, 4, 'beginner', 'find-the-cmdlet', 'Find the right cmdlet and query a server', 'E4', 15, 'Use Get-Command and Get-Help to discover a cmdlet, then use it to answer a question.', (v) => {
    const net = v.net();
    const [active, inactive] = v.some(['Staff', 'Students', 'Labs', 'Guests', 'Printers', 'Admin'], 2);
    return {
      instructions: lab({ situation: `DC01 runs DHCP with two IPv4 scopes. You have never managed DHCP from PowerShell. Find the cmdlet that lists scopes, use it, and record which scope is **active**.`, steps: ['Search for it: `Get-Command *DhcpServerv4Scope*`.', 'Read its usage with Get-Help.', 'List the scopes and note which one is Active.', 'Write the active scope\'s name to **C:\\Answers\\scope.txt**.'], tips: ['Get-Command *Dhcp*', 'Get-Help Get-DhcpServerv4Scope'] }),
      hints: ['Cmdlet names are Verb-Noun: listing is Get-, so look for Get-DhcpServerv4Scope.', 'The State column shows Active or Inactive.'],
      initialState: system({ machines: [dc01(net, { features: ['AD-Domain-Services', 'DNS', 'DHCP', 'GPMC', 'RSAT-AD-PowerShell'], dhcp: { authorized: true, scopes: [{ id: `${net}.0`, name: active, start: `${net}.100`, end: `${net}.199`, mask: '255.255.255.0', active: true, exclusions: [], reservations: [], options: {}, leaseDays: 8, leases: [] }, { id: '10.250.0.0', name: inactive, start: '10.250.0.100', end: '10.250.0.199', mask: '255.255.255.0', active: false, exclusions: [], reservations: [], options: {}, leaseDays: 8, leases: [] }] } })], files: { 'C:\\Answers\\README.txt': 'Put your answer files here.\n' } }),
      checks: [ps('The active scope is recorded', 'Get-Content C:\\Answers\\scope.txt', { contains: active, notContains: inactive, message: `scope.txt should name the active scope only.` }), ran('You searched with Get-Command', 'Get-Command')],
      solution: ['Get-Command *DhcpServerv4Scope*', 'Get-Help Get-DhcpServerv4Scope', 'Get-DhcpServerv4Scope', `Set-Content C:\\Answers\\scope.txt "${active}"`],
      realityNote: 'Nobody memorises thousands of cmdlets; Get-Command and Get-Help are how administrators find their way, on Server Core most of all.',
    };
  }),
  T(1, 4, 'intermediate', 'remote-inventory', 'Inventory several servers in one command', 'E4', 20, 'Use Invoke-Command against several servers and export a CSV inventory.', (v) => {
    const net = v.net();
    const names = v.some(['FS01', 'PRINT01', 'APP01', 'WEB01', 'WSUS01'], 3);
    const core = v.pick(names);
    return {
      instructions: lab({ situation: `The ICT manager wants a spreadsheet of the servers ${names.join(', ')}: their names, product names and installation types. Collect it in one remoting command instead of signing in to each.`, steps: [`Run Get-ComputerInfo on all three with one Invoke-Command.`, 'Keep CsName, WindowsProductName and WindowsInstallationType with Select-Object.', 'Save it as **C:\\Reports\\inventory.csv** with Export-Csv.'], tips: [`Invoke-Command -ComputerName ${names.join(',')} -ScriptBlock { Get-ComputerInfo }`, 'Export-Csv -Path FILE -NoTypeInformation'] }),
      hints: ['-ComputerName accepts a comma-separated list.', 'Pipe: Invoke-Command ... | Select-Object A,B,C | Export-Csv ...'],
      initialState: system({ machines: [dc01(net), ...names.map((n, i) => ({ name: n, installType: n === core ? ('Server Core' as const) : ('Desktop Experience' as const), nics: [nic(`${net}.${21 + i}`, net)] }))], files: { 'C:\\Reports\\README.txt': 'Reports go here.\n' } }),
      checks: [...names.map((n) => ps(`${n} is in the inventory`, 'Get-Content C:\\Reports\\inventory.csv', { contains: n })), ps('Installation types are included', 'Get-Content C:\\Reports\\inventory.csv', { contains: 'Server Core', message: `Include WindowsInstallationType: ${core} is Server Core.` }), ran('You used Invoke-Command', 'Invoke-Command')],
      solution: [`Invoke-Command -ComputerName ${names.join(',')} -ScriptBlock { Get-ComputerInfo } | Select-Object CsName,WindowsProductName,WindowsInstallationType | Export-Csv C:\\Reports\\inventory.csv -NoTypeInformation`],
      realityNote: 'Remoting fans out to many servers at once; Windows Admin Center and Server Manager use the same WinRM channel under the hood.',
    };
  }),
  T(1, 4, 'advanced', 'management-surfaces', 'Choose the right management surface', 'E10', 15, 'Decide between Server Manager, Windows Admin Center and PowerShell for real admin jobs.', (v) => {
    const servers = v.int(20, 60);
    const users = v.int(150, 500);
    return caseStudy(v, {
      intro: `## Three tools, one team\n\nThe ICT team manages ${servers} servers, most of them Server Core. Choose the right tool for each job, and know what they all need from the network.`,
      steps: [
        { title: 'Bulk accounts', text: `${users} new students must be created from the admissions CSV before Monday.`, choices: [{ text: 'A PowerShell script with Import-Csv and New-ADUser', right: true, feedback: 'Correct. Repeatable, fast and auditable.' }, { text: 'Active Directory Users and Computers, one at a time', feedback: `${users} accounts by hand is days of error-prone clicking.` }, { text: 'Server Manager', feedback: 'Server Manager manages servers and roles, not user accounts in bulk.' }] },
        { title: 'Remote site, no PowerShell skills', text: 'A technician at a branch needs to check disks and restart a service on a Server Core box, from a browser.', choices: [{ text: 'Windows Admin Center', right: true, feedback: 'Correct. A browser-based console for servers, including Server Core.' }, { text: 'Remote Desktop to the Server Core box', feedback: 'Server Core has no desktop to manage from.' }, { text: 'Install the Desktop Experience', feedback: 'Not possible after installation, and unnecessary.' }] },
        { title: 'What they all need', text: 'Server Manager, Windows Admin Center and PowerShell remoting all fail against one server. What do they share?', choices: [{ text: 'WinRM on TCP 5985 allowed through the server\'s firewall (Domain profile)', right: true, feedback: 'Correct. All three use WS-Management to reach the server.' }, { text: 'Remote Desktop on 3389', feedback: 'RDP is a separate protocol; none of these tools need it.' }, { text: 'SMB on 445', feedback: 'File sharing is not the management channel.' }] },
        { title: 'Patch status', text: `The manager wants the last update date of all ${servers} servers every Monday.`, choices: [{ text: 'A scheduled script: Invoke-Command to all servers with Get-HotFix, exported to CSV', right: true, feedback: 'Correct. Runs unattended and keeps a history.' }, { text: 'Open each server in Server Manager', feedback: 'It works, weekly, by hand, for ever.' }, { text: 'Ask each server owner by email', feedback: 'Asking people is not measuring.' }] },
        { title: 'Server Core in Server Manager', text: 'Can Server Manager on DC01 manage the Server Core file servers?', choices: [{ text: 'Yes: add them to Server Manager and manage roles remotely', right: true, feedback: 'Correct. Server Manager is designed for remote management.' }, { text: 'No: Server Core needs Windows Admin Center', feedback: 'Server Manager manages Server Core remotely too.' }, { text: 'Only after installing Server Manager on each core server', feedback: 'Server Core cannot run the Server Manager GUI; it is managed from elsewhere.' }] },
      ],
      ending: { title: 'Tooling agreed', text: 'Scripts for bulk work, Windows Admin Center for browser access, Server Manager for role management, and WinRM open on the Domain profile everywhere.' },
      hints: ['Repeat it more than twice: script it.', 'Server Core is managed remotely.', 'All three tools use WinRM.'],
      realityNote: 'Microsoft positions PowerShell for automation, Windows Admin Center for browser-based management and Server Manager for role management; teams use all three.',
    });
  }),

  /* ---------------------------------------------------------------- 1.5 storage */
  T(1, 5, 'beginner', 'bring-a-disk-online', 'Bring a new data disk into service', 'E4', 15, 'Online, initialise, partition and format a new disk with the planned letter and label.', (v) => {
    const net = v.net();
    const size = v.pick([200, 500, 1000]);
    const letter = v.pick(['E', 'F', 'G']);
    const label = v.pick(['Data', 'Archive', 'Projects', 'Media']);
    return {
      instructions: lab({ situation: `A new **${size} GB** disk was added to FS01 as **disk 1**. It is offline and blank. Make it drive **${letter}:** formatted **NTFS** with the label **${label}**, using the whole disk and a GPT partition table.`, steps: ['Look at it: `Get-Disk` on FS01.', 'Bring it online, initialise it as GPT, create a partition using the whole disk with the right letter, and format it.', 'Check with Get-Volume.'], tips: ['Set-Disk -Number 1 -IsOffline $false', 'Initialize-Disk -Number 1 -PartitionStyle GPT', `New-Partition -DiskNumber 1 -UseMaximumSize -DriveLetter ${letter}`, `Format-Volume -DriveLetter ${letter} -FileSystem NTFS -NewFileSystemLabel ${label}`] }),
      hints: ['An offline disk cannot be initialised.', 'GPT is the modern partition style; MBR cannot exceed 2 TB.'],
      initialState: system({ machines: [dc01(net), fs01(net, { disks: [systemDisk(), rawDisk(1, size, false)] })] }),
      checks: [ps(`${letter}: is NTFS`, `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).FileSystem`, { machine: 'FS01', equals: 'NTFS' }), ps(`${letter}: is labelled ${label}`, `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).FileSystemLabel`, { machine: 'FS01', equals: label }), ps('It uses the whole disk', `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).Size`, { machine: 'FS01', equals: `${size} GB` })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { Get-Disk; Set-Disk -Number 1 -IsOffline $false; Initialize-Disk -Number 1 -PartitionStyle GPT; New-Partition -DiskNumber 1 -UseMaximumSize -DriveLetter ${letter}; Format-Volume -DriveLetter ${letter} -FileSystem NTFS -NewFileSystemLabel ${label} }`],
      realityNote: 'The same four cmdlets prepare disks on physical servers, VMs and SANs; Disk Management does the same steps with clicks.',
    };
  }),
  T(1, 5, 'intermediate', 'mirrored-pool', 'Build a mirrored Storage Spaces volume', 'E4', 20, 'Pool three disks, create a mirrored virtual disk and format it ReFS.', (v) => {
    const net = v.net();
    const size = v.pick([100, 200, 400]);
    const pool = v.pick(['Pool1', 'DataPool', 'VMPool']);
    const vd = v.pick(['Mirror1', 'VMStore', 'Shares']);
    const letter = v.pick(['M', 'V', 'S']);
    return {
      instructions: lab({ situation: `FS01 has three blank **${size} GB** disks (1, 2, 3). Build resilient storage: a storage pool **${pool}** from all three, a **Mirror** virtual disk **${vd}** using all the space, then drive **${letter}:** formatted **ReFS** with label **${vd}**.`, steps: ['List poolable disks: `Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true }`.', 'Create the pool, then the virtual disk.', 'The virtual disk appears as a new blank disk: initialise, partition and format it.'], tips: ['New-StoragePool -FriendlyName P -PhysicalDisks (Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true })', 'New-VirtualDisk -StoragePoolFriendlyName P -FriendlyName V -ResiliencySettingName Mirror -UseMaximumSize', 'Get-Disk'] }),
      hints: ['A two-way mirror keeps two copies, so usable space is half of the pool.', 'The new virtual disk is disk 4.', 'ReFS suits large volumes and VM storage.'],
      initialState: system({ machines: [dc01(net), fs01(net, { disks: [systemDisk(), rawDisk(1, size), rawDisk(2, size), rawDisk(3, size)] })] }),
      checks: [ps(`${vd} is a Mirror`, `(Get-VirtualDisk).ResiliencySettingName`, { machine: 'FS01', equals: 'Mirror' }), ps(`${letter}: is ReFS`, `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).FileSystem`, { machine: 'FS01', equals: 'ReFS' }), ps(`${letter}: is labelled ${vd}`, `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).FileSystemLabel`, { machine: 'FS01', equals: vd })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { New-StoragePool -FriendlyName ${pool} -PhysicalDisks (Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true }); New-VirtualDisk -StoragePoolFriendlyName ${pool} -FriendlyName ${vd} -ResiliencySettingName Mirror -UseMaximumSize; Initialize-Disk -Number 4 -PartitionStyle GPT; New-Partition -DiskNumber 4 -UseMaximumSize -DriveLetter ${letter}; Format-Volume -DriveLetter ${letter} -FileSystem ReFS -NewFileSystemLabel ${vd} }`],
      realityNote: 'Storage Spaces turns plain disks into resilient storage without a RAID card; Storage Spaces Direct extends it across servers.',
    };
  }),
  T(1, 5, 'advanced', 'size-the-storage', 'Meet a capacity and resilience requirement', 'E4', 25, 'Choose mirror or parity from a requirement and build a volume that meets it.', (v) => {
    const net = v.net();
    const disk = v.pick([200, 300, 400]);
    const parity = v.random() < 0.5;
    const need = parity ? v.int(2 * disk + 20, 3 * disk - 20) : v.int(Math.round(disk * 1.2), 2 * disk - 20);
    const work = parity ? 'the exam-scripts archive (written once, read rarely)' : 'the student records database (many small random writes)';
    const letter = v.pick(['R', 'T', 'U']);
    return {
      instructions: lab({ situation: `FS01 has four blank **${disk} GB** disks (1 to 4). You need a volume for **${work}** with at least **${need} GB** usable that survives the loss of any one disk.\n\nMirror keeps two copies (half the space, fast writes). Parity stores data plus parity (more space, slow writes). Choose the layout that meets the size, and for a write-heavy database prefer mirror whenever it is big enough.`, steps: ['Pool the four disks as **Pool1**.', 'Create a virtual disk **Store** with the right resiliency using all the space.', `Initialise, partition and format it as **${letter}:**.`, `Check its size against ${need} GB.`], tips: ['Get-VirtualDisk', 'Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true }'] }),
      hints: [`Four disks of ${disk} GB: mirror gives ${2 * disk} GB, parity gives ${3 * disk} GB.`, 'The new virtual disk is disk 5.'],
      initialState: system({ machines: [dc01(net), fs01(net, { disks: [systemDisk(), rawDisk(1, disk), rawDisk(2, disk), rawDisk(3, disk), rawDisk(4, disk)] })] }),
      checks: [ps(`The layout is ${parity ? 'Parity' : 'Mirror'}`, '(Get-VirtualDisk).ResiliencySettingName', { machine: 'FS01', equals: parity ? 'Parity' : 'Mirror', message: parity ? `Mirror gives only ${2 * disk} GB: the requirement needs parity.` : `Mirror is big enough here (${2 * disk} GB), and the database needs its write speed.` }), ps(`At least ${need} GB usable`, `(Get-VirtualDisk).SizeGB -ge ${need}`, { machine: 'FS01', equals: 'True' }), ps(`${letter}: is formatted`, `(Get-Volume | Where-Object { $_.DriveLetter -eq '${letter}' }).HealthStatus`, { machine: 'FS01', equals: 'Healthy' })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { New-StoragePool -FriendlyName Pool1 -PhysicalDisks (Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true }); New-VirtualDisk -StoragePoolFriendlyName Pool1 -FriendlyName Store -ResiliencySettingName ${parity ? 'Parity' : 'Mirror'} -UseMaximumSize; Initialize-Disk -Number 5 -PartitionStyle GPT; New-Partition -DiskNumber 5 -UseMaximumSize -DriveLetter ${letter}; Format-Volume -DriveLetter ${letter} -FileSystem ReFS -NewFileSystemLabel Store }`],
      realityNote: 'Choosing resiliency is a trade between capacity, write performance and cost; parity is common for archives and backups, mirroring for databases and VMs.',
    };
  }),
];

export { svc, bare };
