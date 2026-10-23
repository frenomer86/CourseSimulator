/** Unit 2: Linux installation, partitioning and dual boot. */

import type { TaskTemplate } from '../types';
import { HOSTS, caseStudy, disks, file, lab, linux, out, ran, script, tmpl, user } from './kit';
import { uuidOf } from '@cslab/engine-shell/src/uuid';

export const U2: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 2.1 planning partitions, file systems, LVM */
  tmpl(2, 1, 'beginner', 'partition-plan', 'Plan partitions for a new server', 'E10', 15, 'Choose separate file systems, sizes, swap and file system types for a server.', (v) => {
    const disk = v.pick([240, 480, 960]);
    const ram = v.pick([8, 16, 32]);
    return caseStudy(v, {
      intro: `## A new file and web server\n\nThe server has a **${disk} GB** SSD and **${ram} GB** of RAM. It will host department websites and user uploads, and keep logs for a year. Plan its storage.`,
      steps: [
        { title: 'One big partition?', text: 'The installer suggests one / partition for everything.', choices: [{ text: 'Separate /var (logs, web data) and /home from /, so a full disk in one does not stop the system', right: true, feedback: 'Correct. Runaway logs or uploads then cannot fill the root file system.' }, { text: 'Accept one partition: simpler is better', feedback: 'Simple until a log fills / and services start failing.' }, { text: 'One partition per directory in /', feedback: 'Far too many; each one strands free space.' }] },
        { title: 'LVM', text: 'Should the data partitions be on LVM?', choices: [{ text: 'Yes: logical volumes can be grown later, moved to new disks and snapshotted', right: true, feedback: 'Correct.' }, { text: 'No: LVM is only for large clusters', feedback: 'It is the default on many server installs for good reason.' }, { text: 'Only if the disk is over 2 TB', feedback: 'Size has nothing to do with it.' }] },
        { title: 'Swap', text: `How much swap for ${ram} GB of RAM on a server that will not hibernate?`, choices: [{ text: 'A modest amount, such as 2 to 4 GB, as a safety margin', right: true, feedback: 'Correct. Servers do not need RAM-sized swap unless they hibernate.' }, { text: `${ram * 2} GB: always twice the RAM`, feedback: 'An old rule for small-memory machines.' }, { text: 'None at all, ever', feedback: 'A little swap lets the kernel move idle pages out instead of killing processes.' }] },
        { title: 'File system for web data', text: '/var/www will hold many files and grow over time.', choices: [{ text: 'XFS or ext4 on LVM; XFS grows online and handles large files well', right: true, feedback: 'Correct. Both are solid; remember XFS cannot shrink.' }, { text: 'FAT32 so Windows can read it', feedback: 'No permissions and a 4 GB file limit.' }, { text: 'Btrfs with no snapshots or checks planned', feedback: 'Btrfs is fine, but choose it for its features, with a maintenance plan.' }] },
        { title: 'Leave space', text: `Do you allocate all ${disk} GB now?`, choices: [{ text: 'No: leave free space in the volume group and grow volumes when needed', right: true, feedback: 'Correct. Growing is easy; shrinking is hard or impossible.' }, { text: 'Yes: unused space is wasted', feedback: 'Unallocated space in a volume group is flexibility, not waste.' }, { text: 'Give it all to /home', feedback: 'Then /var cannot grow.' }] },
      ],
      ending: { title: 'Plan agreed', text: 'Separate /, /var and /home on LVM, modest swap, XFS or ext4, and free space kept for growth.' },
      hints: ['What happens when a log fills the only partition?', 'Which file systems can grow online?'],
      realityNote: 'SUSE, Red Hat and Ubuntu server installers all default to LVM layouts for the same reasons.',
    });
  }),
  tmpl(2, 1, 'intermediate', 'lvm-for-data', 'Build LVM volumes for data and mount them at boot', 'E4', 25, 'Turn a new disk into a volume group with two logical volumes, file systems and fstab entries.', (v) => {
    const net = v.net();
    const size = v.pick([50, 100, 200]);
    const [a, b] = [Math.round(size * 0.4), Math.round(size * 0.3)];
    const fs = v.pick(['xfs', 'ext4'] as const);
    const vg = v.pick(['vgdata', 'vgsrv', 'datavg']);
    return {
      instructions: lab({
        situation: `A new **${size} GB** disk **/dev/sdb** was added for web content and backups. Build it with LVM, leaving free space for growth:\n\n- volume group **${vg}** on /dev/sdb\n- logical volume **www** of **${a} GB**, ${fs}, mounted on **/srv/www**\n- logical volume **backup** of **${b} GB**, ${fs}, mounted on **/srv/backup**\n- both mounted automatically at boot through **/etc/fstab** (use UUIDs)`,
        steps: ['Look at the disks with lsblk.', 'pvcreate, vgcreate, lvcreate twice.', `mkfs.${fs} on both volumes.`, 'Create the mount points, add the fstab lines (blkid gives the UUIDs) and run mount -a.', 'Check with findmnt and df -h.'],
        tips: ['pvcreate /dev/sdb', `vgcreate ${vg} /dev/sdb`, `lvcreate -L ${a}G -n www ${vg}`, `mkfs.${fs} /dev/${vg}/www`, `blkid /dev/${vg}/www`, `echo "UUID=... /srv/www ${fs} defaults 0 0" >> /etc/fstab`, 'mount -a'],
      }),
      hints: ['mount -a mounts everything in fstab that is not yet mounted, which proves the lines are right.', 'UUIDs survive disks being renamed; /dev/sdX names do not.'],
      initialState: linux(net, { files: { ...disks(size), '/etc/fstab': '/dev/sda2  /          ext4  defaults  0 1\n/dev/sda1  /boot/efi  vfat  defaults  0 2\n' } }),
      checks: [out('/srv/www is mounted from the www volume', 'findmnt /srv/www', { contains: `/dev/${vg}/www` }), out('/srv/backup is mounted from the backup volume', 'findmnt /srv/backup', { contains: `/dev/${vg}/backup` }), file('fstab mounts them by UUID', '/etc/fstab', { contains: [`UUID=${uuidOf(`/dev/${vg}/www`)}`, `UUID=${uuidOf(`/dev/${vg}/backup`)}`] }), out('The sizes are right', 'lvs', { contains: [`${a}.00g`, `${b}.00g`] }), out('Free space is left in the volume group', 'vgs', { pattern: `${vg}\\s+1\\s+2\\s+0\\s+wz--n-\\s+${size}\\.00g\\s+${size - a - b}\\.00g` })],
      solution: ['lsblk', 'pvcreate /dev/sdb', `vgcreate ${vg} /dev/sdb`, `lvcreate -L ${a}G -n www ${vg}`, `lvcreate -L ${b}G -n backup ${vg}`, `mkfs.${fs} /dev/${vg}/www`, `mkfs.${fs} /dev/${vg}/backup`, 'mkdir -p /srv/www /srv/backup', `blkid /dev/${vg}/www`, `echo "UUID=${uuidOf(`/dev/${vg}/www`)} /srv/www ${fs} defaults 0 0" >> /etc/fstab`, `echo "UUID=${uuidOf(`/dev/${vg}/backup`)} /srv/backup ${fs} defaults 0 0" >> /etc/fstab`, 'mount -a', 'findmnt /srv/www'],
      realityNote: 'pvcreate, vgcreate, lvcreate, mkfs and an fstab line is the everyday recipe for adding storage to a Linux server.',
    };
  }),
  tmpl(2, 1, 'advanced', 'grow-a-full-volume', 'Grow a full volume onto a new disk without downtime', 'E4', 25, 'Add a disk to a volume group and extend a mounted volume and its file system online.', (v) => {
    const net = v.net();
    const fs = v.pick(['xfs', 'ext4'] as const);
    const cur = v.pick([40, 60, 80]);
    const add = v.pick([30, 50]);
    const vg = v.pick(['vgdata', 'vgweb']);
    const state = { disks: [{ name: 'sdb', sizeGb: cur }, { name: 'sdc', sizeGb: 100 }], pvs: [{ dev: '/dev/sdb', vg }], vgs: [{ name: vg, pvs: ['/dev/sdb'] }], lvs: [{ vg, name: 'uploads', sizeGb: cur, fs, files: {} }], mounts: [{ dev: `/dev/${vg}/uploads`, dir: '/srv/uploads', fs, opts: 'rw,relatime' }] };
    return {
      instructions: lab({
        situation: `**/srv/uploads** (${fs}, logical volume **${vg}/uploads**, ${cur} GB) is full and students cannot submit coursework. The volume group has no free space. A new disk **/dev/sdc** has been attached. Grow the volume by **${add} GB** while it stays mounted, and make sure the **file system** grows too, not just the volume.`,
        steps: ['Confirm with df -h, vgs and lsblk.', 'Make /dev/sdc a physical volume and add it to the volume group.', `Extend the volume by ${add} GB and resize the file system (lvextend -r, or ${fs === 'xfs' ? 'xfs_growfs' : 'resize2fs'} afterwards).`, 'Check df -h.'],
        tips: [`vgextend ${vg} /dev/sdc`, `lvextend -r -L +${add}G /dev/${vg}/uploads`, fs === 'xfs' ? 'xfs_growfs /srv/uploads' : `resize2fs /dev/${vg}/uploads`],
      }),
      hints: ['lvextend alone grows the block device; the file system still thinks it is the old size.', fs === 'xfs' ? 'XFS grows online but can never shrink.' : 'ext4 grows online; shrinking needs it unmounted.'],
      initialState: linux(net, { files: { '/etc/lvm/lab-state.json': JSON.stringify(state), '/srv/uploads/': null, '/etc/fstab': `/dev/sda2  /  ext4  defaults  0 1\n/dev/${vg}/uploads  /srv/uploads  ${fs}  defaults  0 0\n` } }),
      checks: [out(`The volume is ${cur + add} GB`, 'lvs', { contains: `${cur + add}.00g` }), out(`The mounted file system is ${cur + add} GB`, 'df -h', { pattern: `${vg}-uploads\\s+${cur + add}G` , message: 'The volume grew but the file system did not: resize it.' }), out('/srv/uploads is still mounted', 'findmnt /srv/uploads', { contains: 'uploads' })],
      solution: ['df -h', 'vgs', 'pvcreate /dev/sdc', `vgextend ${vg} /dev/sdc`, `lvextend -r -L +${add}G /dev/${vg}/uploads`, 'df -h'],
      realityNote: 'Growing a mounted volume onto a new disk is the reason to use LVM in the first place; forgetting the file system resize is the classic mistake.',
    };
  }),

  /* ---------------------------------------------------------------- 2.2 installation, YaST, dual boot, GRUB */
  tmpl(2, 2, 'beginner', 'install-choices', 'Make the right choices during installation', 'E10', 15, 'Choose installer options for a server and a dual-boot lab PC.', (v) => {
    const role = v.pick(['a print server', 'a small web server', 'a monitoring server']);
    return caseStudy(v, {
      intro: `## Installing openSUSE Leap\n\nYou are installing ${role}, and later a dual-boot lab PC. Decide at each installer screen.`,
      steps: [
        { title: 'System role', text: 'The installer offers Desktop with KDE, Server, or Transactional Server.', choices: [{ text: 'Server (text mode): no desktop on a server', right: true, feedback: 'Correct. Less software, less to patch, less to attack.' }, { text: 'Desktop with KDE, for convenience', feedback: 'A desktop on a server is extra attack surface and memory use.' }, { text: 'Whatever is preselected', feedback: 'Defaults are for desktops.' }] },
        { title: 'Network', text: 'The server needs a fixed address.', choices: [{ text: 'Set a static address (or a DHCP reservation) and the right DNS during install', right: true, feedback: 'Correct. Servers need predictable addresses.' }, { text: 'Leave DHCP and remember to change it later', feedback: 'Later often becomes never.' }, { text: 'Use the address of the old server while it is still running', feedback: 'An address conflict on day one.' }] },
        { title: 'Users', text: 'The installer asks whether to use the same password for root as for the first user.', choices: [{ text: 'No: give the admin user sudo, and a separate strong root password (or disable root login)', right: true, feedback: 'Correct.' }, { text: 'Yes, to remember only one password', feedback: 'One leaked password gives both identities.' }, { text: 'Leave the root password empty', feedback: 'Never.' }] },
        { title: 'Dual boot order', text: 'A lab PC needs Windows and Linux.', choices: [{ text: 'Install Windows first, then Linux, so GRUB can add Windows to its menu', right: true, feedback: 'Correct. Windows setup overwrites boot loaders and ignores Linux.' }, { text: 'Linux first, then Windows', feedback: 'Windows setup will replace the boot entry and Linux disappears from the menu.' }, { text: 'The order does not matter', feedback: 'It does for the boot loader.' }] },
        { title: 'Firmware mode', text: 'Windows was installed in UEFI mode.', choices: [{ text: 'Boot the Linux installer in UEFI mode too and reuse the EFI system partition', right: true, feedback: 'Correct. Mixing legacy BIOS and UEFI installs breaks dual boot.' }, { text: 'Use legacy BIOS mode for Linux', feedback: 'The two systems then cannot share a boot menu.' }, { text: 'Create a second EFI partition', feedback: 'Unneeded; one EFI system partition serves both.' }] },
      ],
      ending: { title: 'Installed', text: 'Text-mode server role, static networking, separate admin identities, Windows first and UEFI throughout.' },
      hints: ['Every package you do not install is one you never patch.'],
      realityNote: 'YaST, Anaconda and Subiquity all ask these same questions; the answers carry across distributions.',
    });
  }),
  tmpl(2, 2, 'intermediate', 'grub-menu', 'Make GRUB show Windows and wait for a choice', 'E4', 20, 'Edit /etc/default/grub and regenerate the GRUB configuration.', (v) => {
    const net = v.net();
    const t = v.pick([5, 10, 15]);
    const other = v.pick(['Windows Boot Manager', 'Windows 11 (on /dev/sda1)']);
    return {
      instructions: lab({
        situation: `Lab PCs dual-boot ${other.split(' ')[0]} and openSUSE, but after a GRUB update the menu flashes past in 0 seconds and Windows is missing. Edit **/etc/default/grub** so that the menu waits **${t} seconds**, Windows is detected (the OS prober must not be disabled), and the kernel boots without "quiet" so students see messages. Then regenerate **/boot/grub2/grub.cfg**.`,
        steps: ['Read /etc/default/grub.', 'Change GRUB_TIMEOUT, GRUB_DISABLE_OS_PROBER and GRUB_CMDLINE_LINUX_DEFAULT (sed -i or an editor).', 'Run grub2-mkconfig -o /boot/grub2/grub.cfg and read its output.'],
        tips: [`sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=${t}/' /etc/default/grub`, 'grub2-mkconfig -o /boot/grub2/grub.cfg'],
      }),
      hints: ['grub.cfg is generated: never edit it by hand, your changes would be overwritten.', 'grub2-mkconfig prints "Found Windows..." when the OS prober runs.'],
      initialState: linux(net, { files: { '/etc/default/grub': 'GRUB_DISTRIBUTOR="openSUSE Leap"\nGRUB_DEFAULT=saved\nGRUB_TIMEOUT=0\nGRUB_CMDLINE_LINUX_DEFAULT="splash=silent quiet"\nGRUB_DISABLE_OS_PROBER=true\n', '/etc/lab/other-os': other + '\n', '/boot/grub2/grub.cfg': '# old\nset timeout=0\n' } }),
      checks: [file(`The menu waits ${t} seconds`, '/boot/grub2/grub.cfg', { contains: `set timeout=${t}` }), file(`${other} is in the menu`, '/boot/grub2/grub.cfg', { contains: `menuentry '${other}'` }), file('Kernel messages are shown', '/boot/grub2/grub.cfg', { notContains: 'quiet' }), file('The settings live in /etc/default/grub', '/etc/default/grub', { contains: [`GRUB_TIMEOUT=${t}`, 'GRUB_DISABLE_OS_PROBER=false'] })],
      solution: ['cat /etc/default/grub', `sed -i 's/^GRUB_TIMEOUT=.*/GRUB_TIMEOUT=${t}/' /etc/default/grub`, "sed -i 's/^GRUB_DISABLE_OS_PROBER=.*/GRUB_DISABLE_OS_PROBER=false/' /etc/default/grub", 'sed -i \'s/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="splash=verbose"/\' /etc/default/grub', 'grub2-mkconfig -o /boot/grub2/grub.cfg'],
      realityNote: 'Since GRUB 2.06 the OS prober is disabled by default for security; dual-boot machines must turn it back on explicitly.',
    };
  }),
  tmpl(2, 2, 'advanced', 'dual-boot-trouble', 'Fix dual-boot problems', 'E10', 20, 'Diagnose missing boot entries, Fast Startup and Secure Boot issues on dual-boot PCs.', (v) => {
    const lab2 = v.pick(['Lab 2', 'the Library PCs', 'the Engineering lab']);
    return caseStudy(v, {
      intro: `## Help desk: ${lab2}\n\nThe dual-boot PCs in ${lab2} have problems after the holidays. Diagnose each report.`,
      steps: [
        { title: 'Linux disappeared', text: 'After a big Windows update the PCs boot straight into Windows; there is no GRUB menu.', choices: [{ text: 'Windows reset the UEFI boot order; put openSUSE (shim/GRUB) first again with efibootmgr or the firmware menu', right: true, feedback: 'Correct. The Linux install is still there; only the boot order changed.' }, { text: 'Reinstall Linux', feedback: 'Unnecessary: nothing was deleted.' }, { text: 'Disable UEFI and switch to legacy mode', feedback: 'That breaks both systems.' }] },
        { title: 'Shared data partition read-only', text: 'Linux mounts the shared NTFS data partition read-only and refuses to write.', choices: [{ text: 'Windows Fast Startup hibernated the volume: turn Fast Startup off in Windows', right: true, feedback: 'Correct. A hibernated NTFS volume is unsafe to write from Linux.' }, { text: 'Force mount it read-write', feedback: 'Writing to a hibernated volume can corrupt it.' }, { text: 'Format the partition as ext4', feedback: 'Windows would lose access.' }] },
        { title: 'Secure Boot', text: 'A student\'s own Linux USB stick will not boot: "Verification failed".', choices: [{ text: 'Secure Boot rejects unsigned loaders; use a distribution with a signed shim, rather than turning Secure Boot off', right: true, feedback: 'Correct. Major distributions ship signed shims.' }, { text: 'Disable Secure Boot on all lab PCs', feedback: 'That weakens protection against boot-level malware.' }, { text: 'The USB stick is broken', feedback: 'The message is from signature verification.' }] },
        { title: 'Clock is wrong', text: 'After using Linux, the Windows clock is off by the time-zone offset (or the other way round).', choices: [{ text: 'Windows keeps the hardware clock in local time, Linux in UTC; make them agree', right: true, feedback: 'Correct. In Ghana (UTC+0) it may not show, but labs abroad see it.' }, { text: 'Replace the CMOS battery', feedback: 'The clock is consistent, just interpreted differently.' }, { text: 'Turn off NTP', feedback: 'That makes clocks drift.' }] },
      ],
      ending: { title: 'Lab fixed', text: 'Boot order restored, Fast Startup off, signed boot loaders and agreed clock settings.' },
      hints: ['Ask what changed: a Windows update often changes the UEFI boot order.'],
      realityNote: 'Fast Startup and UEFI boot-order resets are the two most common dual-boot support calls.',
    });
  }),

  /* ---------------------------------------------------------------- 2.3 the boot process */
  tmpl(2, 3, 'beginner', 'default-target', 'Make a server boot to text mode', 'E4', 10, 'Change the systemd default target from graphical to multi-user.', (v) => {
    const net = v.net();
    const host = v.pick(HOSTS);
    return {
      instructions: lab({ situation: `**${host}** was installed with a desktop by mistake and boots into the graphical login, wasting memory. Make it boot to **multi-user.target** (text mode) from now on.`, steps: ['Check the current default with systemctl get-default.', 'Set the new default.', 'Check again.'], tips: ['systemctl get-default', 'systemctl set-default multi-user.target'] }),
      hints: ['Targets group units: graphical.target is multi-user.target plus a display manager.'],
      initialState: linux(net, { hostname: host, files: { '/etc/systemd/system/default.target': 'graphical.target\n' } }),
      checks: [out('The default target is multi-user', 'systemctl get-default', { equals: 'multi-user.target' })],
      solution: ['systemctl get-default', 'systemctl set-default multi-user.target'],
      realityNote: 'systemd targets replaced SysV runlevels: multi-user.target is the old runlevel 3, graphical.target runlevel 5.',
    };
  }),
  tmpl(2, 3, 'intermediate', 'fstab-emergency', 'Recover a server that drops to emergency mode', 'E4', 20, 'Fix a wrong fstab entry so the server boots and mounts its data volume.', (v) => {
    const net = v.net();
    const fs = v.pick(['xfs', 'ext4'] as const);
    const dir = v.pick(['/srv/backup', '/srv/data', '/var/archive']);
    const wrong = v.pick(['bad-uuid', 'typo']);
    const real = uuidOf('/dev/sdb');
    const badLine = wrong === 'bad-uuid' ? `UUID=${uuidOf('/dev/sdz')} ${dir} ${fs} defaults 0 2` : `UUID=${real} ${dir.replace('srv', 'svr')} ${fs} defaults 0 2`;
    return {
      instructions: lab({
        situation: `After a disk swap, the server stopped in **emergency mode** on boot: systemd could not mount an fstab entry. You have a root shell. Find the bad line in **/etc/fstab**, fix it so the data disk **/dev/sdb** (${fs}) mounts on **${dir}**, and make sure the system would boot even if that disk were missing (the \`nofail\` option).`,
        steps: ['Read /etc/fstab and run mount -a to see the error.', 'Find the disk\'s real UUID with blkid.', 'Correct the line and add nofail.', 'Run mount -a again: it must succeed.'],
        tips: ['blkid /dev/sdb', 'mount -a', 'findmnt ' + dir],
      }),
      hints: ['mount -a reads fstab exactly as boot does.', 'Check both the UUID and the mount point spelling.'],
      initialState: linux(net, { files: { '/etc/lvm/lab-state.json': JSON.stringify({ disks: [{ name: 'sdb', sizeGb: 200, fs }] }), [dir + '/']: null, '/etc/fstab': `/dev/sda2  /          ext4  defaults  0 1\n/dev/sda1  /boot/efi  vfat  defaults  0 2\n${badLine}\n` } }),
      checks: [out('mount -a succeeds', 'mount -a', { status: 0 }), out(`${dir} is mounted from /dev/sdb`, 'findmnt ' + dir, { contains: '/dev/sdb' }), file('The entry uses the right UUID and nofail', '/etc/fstab', { pattern: `UUID=${real}\\s+${dir.replace(/\//g, '\\/')}\\s+${fs}\\s+\\S*nofail` })],
      solution: ['cat /etc/fstab', 'mount -a', 'blkid /dev/sdb', 'sed -i \'$d\' /etc/fstab', `echo "UUID=${real} ${dir} ${fs} defaults,nofail 0 2" >> /etc/fstab`, 'mount -a', `findmnt ${dir}`],
      realityNote: 'A wrong fstab line is the most common reason a Linux server stops in emergency mode; nofail keeps non-essential disks from blocking boot.',
    };
  }),
  tmpl(2, 3, 'advanced', 'where-boot-stops', 'Find where the boot process stops', 'E10', 20, 'Use boot messages to place a failure in firmware, GRUB, kernel, initrd or systemd.', (v) => {
    const host = v.pick(HOSTS);
    return caseStudy(v, {
      intro: `## ${host} will not boot\n\nFour different boot failures were reported this term. Read each screen and decide which stage failed and what to do.`,
      steps: [
        { title: 'Screen 1', text: 'The screen shows "grub rescue>".', evidence: [{ title: 'Console', kind: 'log', text: 'error: unknown filesystem.\nEntering rescue mode...\ngrub rescue>' }], choices: [{ text: 'GRUB cannot find its files (partition moved or deleted): boot rescue media and reinstall GRUB', right: true, feedback: 'Correct. The firmware ran GRUB, but GRUB lost its modules and config.' }, { text: 'The kernel panicked', feedback: 'The kernel has not been loaded yet.' }, { text: 'A systemd service failed', feedback: 'systemd has not started.' }] },
        { title: 'Screen 2', text: 'Kernel messages, then a panic.', evidence: [{ title: 'Console', kind: 'log', text: 'VFS: Cannot open root device "UUID=..." or unknown-block(0,0): error -6\nKernel panic - not syncing: VFS: Unable to mount root fs on unknown-block(0,0)' }], choices: [{ text: 'The kernel cannot find the root file system: wrong root= or a missing driver in the initrd; check the kernel line and rebuild the initrd', right: true, feedback: 'Correct.' }, { text: 'Bad RAM', feedback: 'The message names the root device.' }, { text: 'GRUB is missing', feedback: 'GRUB worked: it loaded the kernel.' }] },
        { title: 'Screen 3', text: 'Boot reaches "You are in emergency mode".', evidence: [{ title: 'Console', kind: 'log', text: '[ TIME ] Timed out waiting for device /dev/disk/by-uuid/9f3c...\n[DEPEND] Dependency failed for /srv/data.\nYou are in emergency mode. After logging in, type "journalctl -xb"...' }], choices: [{ text: 'systemd could not mount an fstab entry: fix /etc/fstab or add nofail', right: true, feedback: 'Correct. The kernel and systemd are fine; one mount is not.' }, { text: 'Reinstall the system', feedback: 'One line in fstab is the problem.' }, { text: 'The firmware cannot find the disk', feedback: 'The system booted that far from disk.' }] },
        { title: 'Screen 4', text: 'Nothing at all after the firmware logo, and the firmware shows "No bootable device".', choices: [{ text: 'Firmware stage: the boot entry or EFI system partition is missing or the disk is not detected; check the firmware boot order and disk', right: true, feedback: 'Correct.' }, { text: 'A systemd target is wrong', feedback: 'Nothing from Linux has run yet.' }, { text: 'The root password expired', feedback: 'Passwords do not stop booting.' }] },
        { title: 'Forgotten root password', text: 'You must get into a server whose root password nobody knows.', choices: [{ text: 'At the GRUB menu, edit the kernel line to boot into a rescue shell (rd.break or init=/bin/bash), remount / read-write and set a new password', right: true, feedback: 'Correct. Physical or console access lets you do this, which is why consoles need protecting.' }, { text: 'It cannot be done: reinstall', feedback: 'It can, with console access.' }, { text: 'Guess passwords over SSH', feedback: 'That is an attack, and would lock accounts.' }] },
      ],
      ending: { title: 'Every stage covered', text: 'Firmware, GRUB, kernel and initrd, systemd mounts: each stage has its own signs and its own fix.' },
      hints: ['Ask which program printed the message.'],
      realityNote: 'Recognising the boot stage from the last message on screen is the key skill in rescuing Linux machines.',
    });
  }),

  /* ---------------------------------------------------------------- 2.4 post-install */
  tmpl(2, 4, 'beginner', 'post-install-basics', 'Set the host name, time zone and locale', 'E4', 10, 'Finish a fresh install with the right identity, clock and language settings.', (v) => {
    const net = v.net();
    const host = v.pick(HOSTS);
    const tz = v.pick(['Africa/Accra', 'Africa/Lagos', 'Africa/Nairobi']);
    const loc = v.pick(['en_GB.UTF-8', 'en_US.UTF-8']);
    return {
      instructions: lab({ situation: `A server was just installed with the default name **localhost** and time zone **UTC**. The build sheet says: host name **${host}**, time zone **${tz}**, system locale **${loc}**.`, steps: ['Set the host name with hostnamectl.', 'Set the time zone with timedatectl.', 'Set the locale with localectl.', 'Check each one.'], tips: [`hostnamectl set-hostname ${host}`, 'timedatectl list-timezones', `timedatectl set-timezone ${tz}`, `localectl set-locale LANG=${loc}`] }),
      hints: ['Logs and certificates use the host name, so set it before anything else.'],
      initialState: linux(net, { hostname: 'localhost' }),
      checks: [out('The host name is set', 'hostname', { equals: host }), out('The time zone is set', 'timedatectl', { contains: `Time zone: ${tz}` }), out('The locale is set', 'localectl', { contains: `LANG=${loc}` })],
      solution: [`hostnamectl set-hostname ${host}`, `timedatectl set-timezone ${tz}`, `localectl set-locale LANG=${loc}`],
      realityNote: 'Correct time zones matter for log correlation and scheduled jobs; most teams keep servers on UTC or their local zone consistently.',
    };
  }),
  tmpl(2, 4, 'intermediate', 'secure-baseline', 'Apply a secure post-install baseline', 'E4', 20, 'Create an admin account with sudo, block root SSH logins, patch and confirm the firewall.', (v) => {
    const net = v.net();
    const p = v.person();
    return {
      instructions: lab({ situation: `Before this new server goes on the network, apply the baseline: an administrator account **${p.sam}** (home directory created) in the **wheel** group with a password, **no root login over SSH**, all updates applied, and the firewall running and enabled.`, steps: ['Create the user and set a password.', 'Set PermitRootLogin no in /etc/ssh/sshd_config, test it and restart sshd.', 'Apply updates (zypper patch or zypper update).', 'Make sure firewalld is enabled and running.'], tips: [`useradd -m -G wheel ${p.sam}`, `passwd ${p.sam}`, "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config", 'sshd -t && systemctl restart sshd', 'systemctl enable --now firewalld'] }),
      hints: ['Create and test the admin account before you lock root out of SSH.', 'sshd -t catches mistakes before a restart locks everybody out.'],
      initialState: linux(net, { services: { firewalld: { active: false, enabled: false } }, files: { '/etc/ssh/sshd_config': '# sshd_config\n#PermitRootLogin prohibit-password\nPasswordAuthentication yes\n' } }),
      checks: [user(`${p.sam} is an administrator`, p.sam, { groups: ['wheel'], homeExists: true, hasPassword: true, sudo: true }), out('Root cannot log in over SSH', 'sshd -T', { contains: 'permitrootlogin no' }), { type: 'sh.service', label: 'sshd is running with the new configuration', name: 'sshd', active: true }, { type: 'sh.service', label: 'The firewall is running and enabled', name: 'firewalld', active: true, enabled: true }, ran('You applied updates', '^(zypper (patch|up|update|dup)|zypper -n (patch|up))')],
      solution: [`useradd -m -G wheel ${p.sam}`, `echo 'Welcome@2026' | passwd --stdin ${p.sam} || passwd ${p.sam}`, "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config", 'sshd -t', 'systemctl restart sshd', 'zypper patch', 'systemctl enable --now firewalld'],
      realityNote: 'CIS benchmarks start with exactly these items: named admin accounts, no root SSH, current patches and a host firewall.',
    };
  }),
  tmpl(2, 4, 'advanced', 'post-install-script', 'Automate the post-install steps with a script', 'E4', 30, 'Write an idempotent script that sets host name and time zone and creates an admin user, then run it.', (v) => {
    const net = v.net();
    const host = v.pick(HOSTS);
    const p = v.person();
    const tz = v.pick(['Africa/Accra', 'Africa/Lagos']);
    return {
      instructions: lab({
        situation: `Ten more servers are coming. Write **/root/postinstall.sh** that takes two arguments, a **host name** and an **admin user name**, and:\n\n1. sets the host name,\n2. sets the time zone to **${tz}**,\n3. creates the admin user with a home directory in the wheel group **only if they do not exist yet** (so the script can run twice safely),\n4. prints \`done\` at the end and exits 0; with fewer than two arguments it prints a usage message and exits 1.\n\nThen run it on this server for **${host}** and **${p.sam}**.`,
        steps: ['Write the script (a heredoc with <<\'EOF\' keeps $1 and $2 literal).', 'Make it executable.', `Run it: /root/postinstall.sh ${host} ${p.sam}`, 'Run it a second time: it must not fail.'],
        tips: ["cat > /root/postinstall.sh <<'EOF'", 'if [ $# -lt 2 ]; then echo "usage: $0 HOST USER"; exit 1; fi', 'id "$2" >/dev/null 2>&1 || useradd -m -G wheel "$2"', 'chmod +x /root/postinstall.sh'],
      }),
      hints: ['id USER exits non-zero when the user does not exist.', 'Quote "$1" and "$2".'],
      initialState: linux(net, { hostname: 'localhost' }),
      checks: [script('Without arguments it prints usage and exits 1', '/root/postinstall.sh', { status: 1, contains: 'usage' }), script('With arguments it succeeds', '/root/postinstall.sh', { args: ['test-host', 'testadmin'], status: 0, contains: 'done' }), out('This server has its host name', 'hostname', { equals: host }), out('The time zone is set', 'timedatectl', { contains: `Time zone: ${tz}` }), user(`${p.sam} exists in wheel`, p.sam, { groups: ['wheel'], homeExists: true }), out('Running it again still succeeds', `/root/postinstall.sh ${host} ${p.sam}`, { status: 0, contains: 'done' })],
      solution: [`cat > /root/postinstall.sh <<'EOF'\n#!/bin/bash\nif [ $# -lt 2 ]; then\n  echo "usage: $0 HOSTNAME ADMINUSER"\n  exit 1\nfi\nhostnamectl set-hostname "$1"\ntimedatectl set-timezone ${tz}\nid "$2" >/dev/null 2>&1 || useradd -m -G wheel "$2"\necho done\nEOF`, 'chmod +x /root/postinstall.sh', `/root/postinstall.sh ${host} ${p.sam}`, `/root/postinstall.sh ${host} ${p.sam}`],
      realityNote: 'Idempotent scripts (safe to rerun) are the stepping stone to configuration management tools such as Ansible and Salt, which make idempotence the rule.',
    };
  }),
];

export { ran };
