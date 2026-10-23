/** Unit 1: system administration concepts. */

import type { TaskTemplate } from '../types';
import { HOSTS, caseStudy, file, lab, linux, out, pkg, ran, tmpl } from './kit';

const DISTROS = [
  { id: 'opensuse-leap', pretty: 'openSUSE Leap 15.6', family: 'SUSE', tool: 'zypper', name: 'openSUSE Leap', version: '15.6' },
  { id: 'ubuntu', pretty: 'Ubuntu 24.04.1 LTS', family: 'Debian', tool: 'apt', name: 'Ubuntu', version: '24.04' },
  { id: 'debian', pretty: 'Debian GNU/Linux 12 (bookworm)', family: 'Debian', tool: 'apt', name: 'Debian GNU/Linux', version: '12' },
  { id: 'rocky', pretty: 'Rocky Linux 9.4 (Blue Onyx)', family: 'Red Hat', tool: 'dnf', name: 'Rocky Linux', version: '9.4' },
];
const osRelease = (d: (typeof DISTROS)[number]) => `NAME="${d.name}"\nVERSION="${d.version}"\nID=${d.id}\nPRETTY_NAME="${d.pretty}"\nVERSION_ID="${d.version}"\n`;

export const U1: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 1.1 the role of the administrator */
  tmpl(1, 1, 'beginner', 'triage-requests', 'Triage a sysadmin\'s morning', 'E10', 15, 'Decide what to do first among outages, routine requests, changes and odd asks.', (v) => {
    const host = v.pick(HOSTS);
    return caseStudy(v, {
      intro: `## Monday, 8:00\n\nYou are the only Linux administrator for a college faculty. Five things are waiting. Decide how to handle each one.`,
      steps: [
        { title: 'The web server is down', text: `${host} (the faculty website) stopped answering at 7:40. Registration opens at 9:00.`, choices: [{ text: 'Handle it first: restore service, tell the service desk, then find the cause', right: true, feedback: 'Correct. An outage affecting many users comes first; communication is part of the fix.' }, { text: 'Finish the backup report first, it was due Friday', feedback: 'Reports can wait an hour; the outage cannot.' }, { text: 'Reboot every server to be safe', feedback: 'Rebooting blindly destroys evidence and can make things worse.' }] },
        { title: 'A password reset', text: 'A lecturer is locked out of the shared lab server.', choices: [{ text: 'Verify who they are, then reset it, and record the ticket', right: true, feedback: 'Correct. Identity verification first: social engineering often starts with a "locked out" call.' }, { text: 'Reset it on the phone straight away', feedback: 'Without checking identity you might hand an account to an attacker.' }, { text: 'Tell them to use a colleague\'s account', feedback: 'Shared accounts destroy accountability.' }] },
        { title: 'A risky change', text: 'The head of department wants PHP upgraded on the live server "today, it is only a small change".', choices: [{ text: 'Plan it through change control: test first, schedule a window, have a rollback', right: true, feedback: 'Correct. A PHP upgrade can break every application on the server.' }, { text: 'Do it now because the head of department asked', feedback: 'Seniority does not reduce risk.' }, { text: 'Refuse to ever upgrade', feedback: 'Unpatched software is its own risk.' }] },
        { title: 'Documentation', text: 'Nobody wrote down how the faculty file server was set up.', choices: [{ text: 'Write it up while you remember: purpose, configuration, dependencies, recovery steps', right: true, feedback: 'Correct. Undocumented systems become emergencies when you are on leave.' }, { text: 'It is in your head; that is enough', feedback: 'Then the server has a single point of failure: you.' }, { text: 'Document it only after it breaks', feedback: 'That is the worst time to discover what nobody knows.' }] },
        { title: 'An odd request', text: 'A manager asks you to copy a staff member\'s home directory to them "quietly".', choices: [{ text: 'Decline unless it comes through the formal HR or legal process, and record the request', right: true, feedback: 'Correct. Access to someone\'s data needs authority and a record; Data Protection Act 843 applies.' }, { text: 'Do it: managers can see their staff\'s files', feedback: 'Being a manager does not grant access to personal data.' }, { text: 'Do it but delete the logs', feedback: 'That would be misconduct.' }] },
      ],
      ending: { title: 'Morning handled', text: 'Outage first, verified resets, changes through change control, documentation as you go, and access only with proper authority.' },
      hints: ['Impact on many users comes before convenience for one.', 'Every change needs a test and a way back.'],
      realityNote: 'The Practice of System and Network Administration describes this triage in detail: interruptions, priorities, change management and ethics are the everyday job.',
    });
  }),
  tmpl(1, 1, 'intermediate', 'document-a-server', 'Document a server you inherited', 'E4', 20, 'Collect the facts about an undocumented server into a notes file.', (v) => {
    const net = v.net();
    const host = v.pick(HOSTS);
    const services = v.some(['apache2', 'named', 'mariadb', 'cron'], 2);
    const pkgs: Record<string, string> = { apache2: 'apache2', named: 'bind', mariadb: 'mariadb', cron: 'cronie' };
    return {
      instructions: lab({
        situation: `You have taken over **${host}** from a colleague who left. There is no documentation. Before you change anything, write **/root/server-notes.txt** with these lines:\n\n- \`Hostname: <name>\`\n- \`OS: <PRETTY_NAME from /etc/os-release>\`\n- \`Kernel: <kernel release>\`\n- \`Address: <IPv4 address/prefix>\`\n- \`Services: <the running services, separated by spaces>\` (just the names, such as sshd)`,
        steps: ['Find each fact with hostname, cat /etc/os-release, uname -r, ip addr and systemctl list-units.', 'Write the file with echo or a text editor.'],
        tips: ['uname -r', 'ip addr', 'systemctl list-units', "echo 'Hostname: x' > /root/server-notes.txt"],
      }),
      hints: ['ip addr shows the address on the eth0 line that starts with inet.', 'Running services show "active running" in systemctl list-units.'],
      initialState: linux(net, { hostname: host, packages: Object.fromEntries(services.map((s) => [pkgs[s], { installed: true }])), services: Object.fromEntries(services.map((s) => [s, { active: true, enabled: true, package: pkgs[s] }])) }),
      checks: [file('Hostname recorded', '/root/server-notes.txt', { contains: `Hostname: ${host}` }), file('OS recorded', '/root/server-notes.txt', { contains: 'OS: openSUSE Leap 15.6' }), file('Kernel recorded', '/root/server-notes.txt', { contains: 'Kernel: 6.4.0-150600.23-default' }), file('Address recorded', '/root/server-notes.txt', { contains: `Address: ${net}.5/24` }), file('Running services recorded', '/root/server-notes.txt', { contains: ['sshd', ...services] })],
      solution: ['hostname', 'cat /etc/os-release', 'uname -r', 'ip addr', 'systemctl list-units', `printf 'Hostname: %s\\nOS: %s\\nKernel: %s\\nAddress: %s\\nServices: %s\\n' ${host} 'openSUSE Leap 15.6' 6.4.0-150600.23-default ${net}.5/24 'sshd cron firewalld ${services.join(' ')}' > /root/server-notes.txt`],
      realityNote: 'Writing down what a system is before touching it is the first habit of good administrators; tools like Ansible facts or osquery automate the same inventory.',
    };
  }),
  tmpl(1, 1, 'advanced', 'ethics-and-privilege', 'Handle requests that test your ethics', 'E10', 20, 'Respond to pressure to misuse administrator access, hide incidents or skip process.', (v) => {
    const role = v.pick(['the Dean', 'the Registrar', 'a Head of Department']);
    return caseStudy(v, {
      intro: `## Root is a responsibility\n\nAs the administrator you can read every file and every log. This week tests what you do with that power.`,
      steps: [
        { title: 'Reading email', text: `${role} asks you to read a lecturer's mailbox because "they might be leaking exam questions".`, choices: [{ text: 'Refer it to the formal investigation process; act only on written authorisation and log what you access', right: true, feedback: 'Correct. Investigations need authority, scope and an audit trail.' }, { text: 'Read it quietly and report what you find', feedback: 'Unauthorised access to personal communications breaks policy and data protection law.' }, { text: 'Delete the lecturer\'s mail so nothing leaks', feedback: 'Destroying data is worse still.' }] },
        { title: 'Your mistake', text: 'You ran a cleanup script that deleted a week of student uploads. Nobody has noticed yet.', choices: [{ text: 'Report it now, restore from backup, and explain what will prevent a repeat', right: true, feedback: 'Correct. Honest incident reports build trust and get the data back fastest.' }, { text: 'Restore what you can and say nothing', feedback: 'Students may lose work you could not restore, and the cause stays.' }, { text: 'Blame a disk failure', feedback: 'Lying about incidents is a firing matter and hides the real fix.' }] },
        { title: 'Skipping the queue', text: 'A friend in another department asks for sudo on a shared server "to save time".', choices: [{ text: 'Decline; grant only what their role needs, through a request their manager approves', right: true, feedback: 'Correct. Least privilege and approval apply to friends too.' }, { text: 'Give it; you trust them', feedback: 'Trust is not access control, and you would be accountable.' }, { text: 'Share your own sudo password', feedback: 'Never share credentials.' }] },
        { title: 'Logs and privacy', text: 'Web logs show which students visit which pages. Marketing wants them to profile students.', choices: [{ text: 'Only aggregate, anonymised data, if there is a lawful basis and the privacy notice covers it', right: true, feedback: 'Correct. Logs are personal data under the Data Protection Act.' }, { text: 'Hand over the raw logs; they are the college\'s data', feedback: 'Being the college\'s data does not remove students\' rights.' }, { text: 'Delete the logs so nobody can use them', feedback: 'Logs are needed for security; keep them for their purpose and retention period.' }] },
        { title: 'Pressure to switch off security', text: 'An important vendor says their software only works with the firewall and SELinux/AppArmor disabled.', choices: [{ text: 'Find the specific ports and profile changes it needs, and document any exception with sign-off', right: true, feedback: 'Correct. Narrow exceptions, documented and approved.' }, { text: 'Disable both; the vendor knows best', feedback: 'That exposes everything on the server for one application.' }, { text: 'Refuse the software outright', feedback: 'Often a narrow, approved exception is possible.' }] },
      ],
      ending: { title: 'Integrity intact', text: 'Authority and logging for access, honest incident reports, least privilege for everyone, privacy for logs and documented exceptions.' },
      hints: ['Ask: who authorised this, and is it recorded?', 'Least privilege applies to friends and bosses.'],
      realityNote: 'Professional codes such as the SAGE/LOPSA System Administrators\' Code of Ethics and the ACM Code of Ethics put privacy, honesty and responsibility at the centre of the job.',
    });
  }),

  /* ---------------------------------------------------------------- 1.2 distributions, kernel, init */
  tmpl(1, 2, 'beginner', 'identify-the-system', 'Identify a Linux system', 'E4', 10, 'Find the distribution, version, kernel and init system of a machine.', (v) => {
    const d = v.pick(DISTROS);
    const net = v.net();
    return {
      instructions: lab({
        situation: 'You have been given SSH access to an unfamiliar server. Before you install anything you need to know what it is. Record the facts in **/root/system.txt**: `Distribution: <NAME>`, `Version: <VERSION_ID>`, `Family: <SUSE, Debian or Red Hat>`, `Kernel: <release>` and `Init: <the program running as PID 1>`.',
        steps: ['Read /etc/os-release.', 'Run uname -r for the kernel release.', 'Look at PID 1 with ps -ef.', 'Write the five lines.'],
        tips: ['cat /etc/os-release', 'uname -r', 'ps -ef | head -3'],
      }),
      hints: ['Ubuntu derives from Debian; Rocky Linux rebuilds Red Hat Enterprise Linux.', 'PID 1 on modern distributions is systemd.'],
      initialState: linux(net, { files: { '/etc/os-release': osRelease(d) } }),
      checks: [file('Distribution recorded', '/root/system.txt', { contains: `Distribution: ${d.name}` }), file('Version recorded', '/root/system.txt', { contains: `Version: ${d.version}` }), file('Family recorded', '/root/system.txt', { contains: `Family: ${d.family}` }), file('Kernel recorded', '/root/system.txt', { contains: 'Kernel: 6.4.0-150600.23-default' }), file('Init recorded', '/root/system.txt', { pattern: 'Init: .*systemd' })],
      solution: ['cat /etc/os-release', 'uname -r', 'ps -ef | head -3', `printf 'Distribution: %s\\nVersion: %s\\nFamily: %s\\nKernel: %s\\nInit: %s\\n' '${d.name}' ${d.version} '${d.family}' 6.4.0-150600.23-default systemd > /root/system.txt`],
      realityNote: '/etc/os-release is the standard place every systemd-era distribution describes itself; scripts read it to decide between zypper, apt and dnf.',
    };
  }),
  tmpl(1, 2, 'intermediate', 'right-package-tool', 'Install software with the right tool for the distribution', 'E4', 15, 'Work out the distribution family and install packages with its package manager.', (v) => {
    const d = v.pick(DISTROS);
    const net = v.net();
    const wanted = v.some(['tree', 'htop', 'rsync', 'zip'], 2);
    return {
      instructions: lab({
        situation: `The lab team needs **${wanted.join('** and **')}** on this server. Different distributions use different package managers: zypper (SUSE), apt (Debian and Ubuntu), dnf (Red Hat family). Find out what this machine is and install them with the right tool.`,
        steps: ['Check /etc/os-release.', 'Install both packages with the distribution\'s package manager.', 'Confirm they are installed.'],
        tips: ['zypper install PKG', 'apt install PKG', 'dnf install PKG'],
      }),
      hints: [`ID=${d.id} tells you the family.`],
      initialState: linux(net, { files: { '/etc/os-release': osRelease(d) } }),
      checks: [...wanted.map((w) => pkg(`${w} is installed`, w)), ran(`You used ${d.tool}`, `^(sudo )?${d.tool} (-y )?(install|in)\\b`, `This is a ${d.family}-family system: use ${d.tool}.`)],
      solution: ['cat /etc/os-release', `${d.tool} install ${wanted.join(' ')}`],
      realityNote: 'Mixed estates are normal in universities; configuration tools such as Ansible pick the package module from the same os-release facts.',
    };
  }),
  tmpl(1, 2, 'advanced', 'choose-a-distribution', 'Choose distributions for campus servers', 'E10', 20, 'Match distributions, support lifecycles and init systems to server roles.', (v) => {
    const years = v.pick([5, 7]);
    return caseStudy(v, {
      intro: `## Picking the platform\n\nThe faculty is standardising its Linux servers for the next ${years} years. Decide what runs where.`,
      steps: [
        { title: 'Production web server', text: `It must run ${years} years with security updates and minimal change.`, choices: [{ text: 'A long-term-support enterprise or LTS release (openSUSE Leap/SLES, Ubuntu LTS, Rocky/RHEL)', right: true, feedback: 'Correct. Long support windows and stable package versions.' }, { text: 'A rolling release such as openSUSE Tumbleweed or Arch', feedback: 'Constant upgrades suit desktops and developers, not stable servers.' }, { text: 'Whatever the newest release is on install day', feedback: 'Support length matters more than novelty for servers.' }] },
        { title: 'Student programming lab', text: 'Students need the newest compilers and tools every semester.', choices: [{ text: 'A faster-moving release, or containers on a stable host', right: true, feedback: 'Correct. Keep the host stable and ship fresh tools in containers or a newer release.' }, { text: 'The oldest enterprise release for stability', feedback: 'Students would get compilers years behind the course.' }, { text: 'Let each student install their own distribution', feedback: 'Unsupportable for a shared lab.' }] },
        { title: 'Kernel and userland', text: 'A colleague says "Linux" is the whole operating system. What is the kernel?', choices: [{ text: 'The core that manages hardware, memory and processes; GNU and other userland tools run on top', right: true, feedback: 'Correct. Distributions combine the kernel, userland, a package manager and defaults.' }, { text: 'The desktop environment', feedback: 'Desktops are optional userland packages.' }, { text: 'The package manager', feedback: 'Package managers are userland tools.' }] },
        { title: 'Init system', text: 'Why do all these distributions use systemd as PID 1?', choices: [{ text: 'It starts services in parallel, tracks them, restarts them, and provides journald and timers', right: true, feedback: 'Correct. It replaced SysV init scripts on all major distributions.' }, { text: 'It is required by the Linux kernel', feedback: 'The kernel runs whatever init it is given.' }, { text: 'It is only used on desktops', feedback: 'Servers rely on it most of all.' }] },
        { title: 'Skills', text: 'The team knows openSUSE well. A new research group insists on Ubuntu.', choices: [{ text: 'Allow it with a support agreement, and use family-neutral tools (systemd, Ansible) so skills transfer', right: true, feedback: 'Correct. Most administration skills carry across distributions.' }, { text: 'Refuse: only one distribution is allowed', feedback: 'Rigid rules push researchers to unmanaged machines.' }, { text: 'Let them run it unmanaged', feedback: 'Unmanaged servers become unpatched servers.' }] },
      ],
      ending: { title: 'Platform chosen', text: 'Long-term releases for production, faster tools via containers for teaching, systemd everywhere and portable automation.' },
      hints: ['Count support years against the server\'s life.', 'Containers decouple fast-moving tools from a stable host.'],
      realityNote: 'Release lifecycles differ widely: Ubuntu LTS has 5 years of standard support, RHEL and its rebuilds about 10, openSUSE Leap follows SUSE Linux Enterprise.',
    });
  }),

  /* ---------------------------------------------------------------- 1.3 virtual lab and snapshots */
  tmpl(1, 3, 'beginner', 'snapshot-basics', 'Use snapshots wisely in a virtual lab', 'E10', 15, 'Know when a VM snapshot helps, and why it is not a backup.', (v) => {
    const hv = v.pick(['VirtualBox', 'KVM with virt-manager', 'VMware Workstation']);
    return caseStudy(v, {
      intro: `## Your practice lab\n\nYou run your practice servers in ${hv} on a laptop. Decide how to use snapshots.`,
      steps: [
        { title: 'Before a risky exercise', text: 'You are about to practise repartitioning a VM.', choices: [{ text: 'Take a snapshot first so you can roll back in seconds', right: true, feedback: 'Correct. This is exactly what snapshots are for.' }, { text: 'Reinstall the VM if it breaks', feedback: 'That wastes an hour you did not need to spend.' }, { text: 'Practise on the host instead', feedback: 'Never experiment on the machine running your lab.' }] },
        { title: 'Is it a backup?', text: 'Your laptop disk fails. Are your VM snapshots safe?', choices: [{ text: 'No: snapshots live on the same disk as the VM; backups must be elsewhere', right: true, feedback: 'Correct.' }, { text: 'Yes, snapshots are backups', feedback: 'They die with the disk they are on.' }, { text: 'Yes, if you took more than one', feedback: 'All of them are on the same disk.' }] },
        { title: 'Long chains', text: 'You have 40 snapshots of one VM over a month.', choices: [{ text: 'Delete old ones: long chains slow the VM and use a lot of space', right: true, feedback: 'Correct. Keep a few meaningful snapshots.' }, { text: 'Keep them all forever', feedback: 'Performance and disk space suffer.' }, { text: 'Snapshots never use space', feedback: 'They grow with every change.' }] },
        { title: 'Network mode', text: 'Your VMs must reach each other and the internet, but not be reachable from the campus network.', choices: [{ text: 'NAT network (or NAT plus a host-only network between VMs)', right: true, feedback: 'Correct.' }, { text: 'Bridged networking', feedback: 'Bridged VMs sit on the campus network like real machines.' }, { text: 'No network', feedback: 'Then the VMs cannot update or talk to each other.' }] },
      ],
      ending: { title: 'Lab ready', text: 'Snapshots before risky steps, real backups elsewhere, short chains and a NAT network.' },
      hints: ['Where are the snapshot files stored?'],
      realityNote: 'Production hypervisors give the same advice: snapshots are for short-term rollback around changes, not for data protection.',
    });
  }),
  tmpl(1, 3, 'intermediate', 'safety-net', 'Keep a safety net around configuration changes', 'E4', 20, 'Restore a damaged file from a pre-change archive and take a new archive before your own change.', (v) => {
    const net = v.net();
    const port = v.pick([22, 2222]);
    const date = `2026-10-${String(v.int(10, 21)).padStart(2, '0')}`;
    const original = `# sshd configuration\nPort ${port}\nPermitRootLogin no\nPasswordAuthentication no\n`;
    return {
      instructions: lab({
        situation: `A colleague edited **/etc/ssh/sshd_config** this morning and broke it. Luckily the change procedure made them archive /etc/ssh first: **/root/pre-change-${date}.tar.gz**. Restore **only** sshd_config from that archive (the host keys in the directory are newer and must not be overwritten). Then, before you start your own work, archive the whole of /etc as **/root/etc-before-mychange.tar.gz**.`,
        steps: [`List the archive with tar tzf.`, 'Extract just etc/ssh/sshd_config into / with -C /.', 'Check the file and test it with sshd -t.', 'Create the new archive of /etc.'],
        tips: [`tar tzf /root/pre-change-${date}.tar.gz`, `tar xzf /root/pre-change-${date}.tar.gz -C / etc/ssh/sshd_config`, 'tar czf /root/etc-before-mychange.tar.gz /etc'],
      }),
      hints: ['Archives store paths without the leading /.', 'Naming a member after the archive extracts only that file.'],
      initialState: linux(net, { files: { '/etc/ssh/sshd_config': `# sshd configuration\nPrt ${port}\nPermitRootLogin no\nPasswordAuthentication no\n`, '/etc/ssh/ssh_host_ed25519_key.pub': 'ssh-ed25519 NEWKEY root@srv1\n', [`/root/pre-change-${date}.tar.gz`]: tarOf({ 'etc/ssh/sshd_config': original, 'etc/ssh/ssh_host_ed25519_key.pub': 'ssh-ed25519 OLDKEY root@srv1\n' }) } }),
      checks: [file('sshd_config is restored', '/etc/ssh/sshd_config', { contains: `Port ${port}`, notContains: 'Prt ' }), out('sshd accepts the configuration', 'sshd -t', { status: 0 }), file('The newer host key was not overwritten', '/etc/ssh/ssh_host_ed25519_key.pub', { contains: 'NEWKEY' }), out('The new archive holds /etc', 'tar tzf /root/etc-before-mychange.tar.gz', { contains: 'etc/ssh/sshd_config' })],
      solution: [`tar tzf /root/pre-change-${date}.tar.gz`, `tar xzf /root/pre-change-${date}.tar.gz -C / etc/ssh/sshd_config`, 'sshd -t', 'tar czf /root/etc-before-mychange.tar.gz /etc'],
      realityNote: 'Archiving /etc before changes (or keeping it in git with etckeeper) gives the same safety net as a VM snapshot, on physical servers too.',
    };
  }),
  tmpl(1, 3, 'advanced', 'design-a-lab', 'Design a virtual lab for a networking course', 'E10', 20, 'Size hosts, choose network modes and plan snapshots for a class lab.', (v) => {
    const students = v.int(20, 40);
    const ram = v.pick([16, 32]);
    return caseStudy(v, {
      intro: `## A lab for ${students} students\n\nEach student needs a router VM, a server VM and a client VM. Lab PCs have ${ram} GB of RAM. Plan the lab.`,
      steps: [
        { title: 'Memory', text: `Router 1 GB, server 2 GB, client 2 GB, and the host OS needs 4 GB. Does it fit in ${ram} GB?`, choices: [{ text: `Yes: 5 GB of VMs plus 4 GB for the host is 9 GB, within ${ram} GB`, right: true, feedback: 'Correct, with room to spare.' }, { text: 'No: VMs need double their RAM', feedback: 'They need what you give them, plus a little overhead.' }, { text: 'It does not matter; VMs share memory freely', feedback: 'Overcommitting memory makes everything swap.' }] },
        { title: 'Isolation', text: 'Students will run DHCP servers. How do you stop them breaking the campus network?', choices: [{ text: 'Put lab VMs on an internal or host-only network with no bridge to campus', right: true, feedback: 'Correct. A rogue DHCP server on the campus LAN would hand out wrong addresses.' }, { text: 'Bridge them and ask students to be careful', feedback: 'One mistake takes down campus networking.' }, { text: 'Turn off DHCP in the exercise', feedback: 'Then they cannot learn DHCP.' }] },
        { title: 'Starting point', text: 'How do all students start from the same state each week?', choices: [{ text: 'Distribute a template image with a "clean" snapshot students revert to', right: true, feedback: 'Correct. Reproducible starting points save hours.' }, { text: 'Let each student build from scratch every week', feedback: 'Most of the lab goes on reinstalling.' }, { text: 'Copy one student\'s VMs to everyone', feedback: 'You copy their mistakes too.' }] },
        { title: 'Storage', text: 'Each VM template is 15 GB. Full copies or linked clones?', choices: [{ text: 'Linked clones from a read-only base: much less disk and faster to create', right: true, feedback: 'Correct.' }, { text: 'Full copies for everyone', feedback: `${students * 45} GB of identical data.` }, { text: 'One VM shared by the class', feedback: 'They would overwrite each other.' }] },
      ],
      ending: { title: 'Lab planned', text: 'Memory fits, the network is isolated, everyone starts from a clean snapshot and linked clones save disk.' },
      hints: ['Add the VM memory to the host\'s needs.', 'Isolation protects the campus network.'],
      realityNote: 'Teaching labs from Cisco Networking Academy to university courses use templates, linked clones and isolated networks for exactly these reasons.',
    });
  }),

  /* ---------------------------------------------------------------- 1.4 getting help */
  tmpl(1, 4, 'beginner', 'find-the-command', 'Find the right command from the manual', 'E4', 15, 'Use man -k and apropos to find commands for tasks you do not know yet.', (v) => {
    const net = v.net();
    const tasks = v.some([['report disk space usage of file systems', 'df'], ['estimate the space a directory uses', 'du'], ['change the owner of a file', 'chown'], ['change the group of a file', 'chgrp'], ['remove an empty directory', 'rmdir'], ['set the default permission mask', 'umask']] as Array<[string, string]>, 3);
    return {
      instructions: lab({
        situation: `New starters always ask "what is the command for...". Show them how to find out. Use **man -k** (or **apropos**) to find the command for each task, then write them, one per line, into **/root/commands.txt** in the order given:\n\n${tasks.map(([t], i) => `${i + 1}. ${t}`).join('\n')}`,
        steps: ['Search the manual descriptions with man -k WORD.', 'Check the right one with man COMMAND.', 'Write the three command names.'],
        tips: ['man -k disk', 'apropos owner', 'man chown'],
      }),
      hints: ['Search for a key word from the task, such as "owner" or "space".'],
      initialState: linux(net),
      checks: [file('The commands are right and in order', '/root/commands.txt', { pattern: `^${tasks.map(([, c]) => c).join('\\n')}\\s*$` }), ran('You searched the manual', '^(man -k|apropos) ')],
      solution: tasks.map(([t]) => `apropos ${t.split(' ').find((w) => w.length > 4)}`).concat([`printf '${tasks.map(([, c]) => c).join('\\n')}\\n' > /root/commands.txt`]),
      realityNote: 'man -k searches the one-line descriptions of every installed manual page; it works offline, on every Unix system.',
    };
  }),
  tmpl(1, 4, 'intermediate', 'read-the-options', 'Use the manual to answer a real question', 'E4', 20, 'Discover the options of du and sort to find the largest files in a directory.', (v) => {
    const net = v.net();
    const names = v.some(['exam-scans.tar', 'lectures.mp4', 'old-backup.img', 'thesis-data.csv', 'photos.zip', 'logs-2025.gz', 'notes.txt', 'drivers.iso'], 6);
    const sizes = names.map((_, i) => 400 + i * 700 + v.int(0, 300));
    const top = names.map((n, i) => ({ n, s: sizes[i] })).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.n);
    return {
      instructions: lab({
        situation: '**/srv/share** is filling up and you must tell the owners which three files are biggest. You have never used du for this. Read **man du** and **man sort** to find the options that show sizes of all files in bytes and sort them numerically, biggest first, then write the three biggest file names (just the names) into **/root/biggest.txt**, biggest first.',
        steps: ['Read man du: which option includes files, and which shows bytes?', 'Read man sort: numeric and reverse.', 'Run the pipeline, then write the names.'],
        tips: ['man du', 'man sort', 'du -ab /srv/share | sort -n -r | head -4'],
      }),
      hints: ['The directory itself is the biggest line; skip it.', 'du -a lists files as well as directories; -b shows bytes.'],
      initialState: linux(net, { files: Object.fromEntries(names.map((n, i) => [`/srv/share/${n}`, 'x'.repeat(sizes[i])])) }),
      checks: [file('The three biggest files, biggest first', '/root/biggest.txt', { pattern: `^${top.map((t) => t.replace(/\./g, '\\.')).join('\\n')}\\s*$` }), ran('You sorted numerically', 'sort .*-[a-z]*n')],
      solution: ['man du', 'du -ab /srv/share | sort -n -r | head -4', `printf '${top.join('\\n')}\\n' > /root/biggest.txt`],
      realityNote: 'du | sort -n is the classic first move on any full disk; ncdu gives the same view interactively.',
    };
  }),
  tmpl(1, 4, 'advanced', 'judge-the-advice', 'Judge advice found online', 'E10', 15, 'Recognise dangerous answers on forums and ask a good question.', (v) => {
    const err = v.pick(['Permission denied writing /var/www/uploads', 'apache2 fails to start after an edit', 'SSH login takes 30 seconds']);
    return caseStudy(v, {
      intro: `## Searching for "${err}"\n\nYou find several answers online. Decide which to trust.`,
      steps: [
        { title: 'chmod 777', text: 'Top answer: "just run chmod -R 777 /var/www".', choices: [{ text: 'Reject it: it lets every user and process write everywhere; fix ownership or a group instead', right: true, feedback: 'Correct. 777 turns a permission problem into a security problem.' }, { text: 'Use it, it has 500 upvotes', feedback: 'Popularity is not correctness.' }, { text: 'Use it but only on the web root', feedback: 'That is exactly where attackers upload web shells.' }] },
        { title: 'curl | sudo bash', text: 'Another answer: "curl https://fixit.example/install.sh | sudo bash".', choices: [{ text: 'Never pipe unknown scripts into root; download, read, verify, then decide', right: true, feedback: 'Correct.' }, { text: 'Fine if the site uses HTTPS', feedback: 'HTTPS proves where it came from, not that it is safe.' }, { text: 'Fine on a test VM, then on production', feedback: 'Still unknown code running as root.' }] },
        { title: 'Turning security off', text: 'A third answer: "disable SELinux/AppArmor, it always causes problems".', choices: [{ text: 'Read the denial in the logs and allow the specific access instead', right: true, feedback: 'Correct. The log names exactly what was blocked.' }, { text: 'Disable it permanently', feedback: 'You lose a whole layer of protection.' }, { text: 'Reinstall without it', feedback: 'Same loss, more work.' }] },
        { title: 'Where to look first', text: 'What should you check before searching at all?', choices: [{ text: 'The exact error, journalctl -u SERVICE, the man page and the distribution\'s documentation', right: true, feedback: 'Correct. Primary sources first.' }, { text: 'Video tutorials', feedback: 'Often outdated and for other distributions.' }, { text: 'Ask a colleague to fix it', feedback: 'Fine eventually, but you learn more by checking first.' }] },
        { title: 'Asking a good question', text: 'You decide to post on the distribution forum. What goes in the question?', choices: [{ text: 'Distribution and version, exact error text, what you tried, relevant config with secrets removed', right: true, feedback: 'Correct. Good questions get good answers.' }, { text: '"It does not work, please help urgently"', feedback: 'Nobody can help with that.' }, { text: 'Your full config including passwords so they can test', feedback: 'Never post secrets.' }] },
      ],
      ending: { title: 'Fixed safely', text: 'Primary sources first, no 777, no unknown scripts as root, narrow security exceptions and well-formed questions.' },
      hints: ['Would this answer make the system less secure?'],
      realityNote: 'Distribution wikis (openSUSE, Arch, Debian) and man pages are curated; anonymous answers are not. Read before you run.',
    });
  }),
];

/** An archive in the simulator's tar format (see tar in engine-shell commands-files). */
export function tarOf(files: Record<string, string>): string {
  const dirs = [...new Set(Object.keys(files).flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/') + '/')))];
  const entries = [...dirs.map((path) => ({ path, type: 'dir', mode: 0o755, owner: 'root', group: 'root', mtime: 0 })), ...Object.entries(files).map(([path, content]) => ({ path, type: 'file', content, mode: 0o644, owner: 'root', group: 'root', mtime: 0 }))];
  return '#CSLAB-TAR\n' + JSON.stringify(entries);
}
