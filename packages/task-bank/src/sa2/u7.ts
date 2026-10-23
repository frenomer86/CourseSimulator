/** Unit 7: network communications and remote administration. */

import type { TaskTemplate } from '../types';
import { bindZone, caseStudy, file, group, lab, linux, out, ran, svc, tmpl, user } from './kit';

export const U7: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 7.1 network configuration */
  tmpl(7, 1, 'beginner', 'read-network-config', 'Read a server\'s network configuration', 'E4', 10, 'Find the address, gateway and DNS servers from ip and resolv.conf.', (v) => {
    const net = v.net();
    const last = v.int(10, 90);
    const dns2 = `${net}.${v.int(2, 9)}`;
    return {
      instructions: lab({ situation: 'Fill in the network section of the server\'s documentation. Write **/root/network.txt** with `Address: <ip/prefix>`, `Gateway: <ip>` and `DNS: <first nameserver>`.', steps: ['ip addr: the inet line of eth0.', 'ip route: the default route.', 'cat /etc/resolv.conf.'], tips: ['ip addr', 'ip route', 'cat /etc/resolv.conf'] }),
      hints: ['The default route line starts with "default via".'],
      initialState: linux(net, { last, files: { '/etc/resolv.conf': `search campus.lan\nnameserver ${net}.1\nnameserver ${dns2}\n` } }),
      checks: [file('Address recorded', '/root/network.txt', { contains: `Address: ${net}.${last}/24` }), file('Gateway recorded', '/root/network.txt', { contains: `Gateway: ${net}.1` }), file('DNS recorded', '/root/network.txt', { contains: `DNS: ${net}.1` })],
      solution: ['ip addr', 'ip route', 'cat /etc/resolv.conf', `printf 'Address: ${net}.${last}/24\\nGateway: ${net}.1\\nDNS: ${net}.1\\n' > /root/network.txt`],
      realityNote: 'ip replaced ifconfig and route on modern Linux; NetworkManager or systemd-networkd usually writes resolv.conf.',
    };
  }),
  tmpl(7, 1, 'intermediate', 'static-with-nmcli', 'Give a server a static address with nmcli', 'E4', 20, 'Configure a persistent static IPv4 address, gateway, DNS and search domain with NetworkManager.', (v) => {
    const net = v.net();
    const last = v.int(20, 60);
    const dns = [`${net}.2`, `${net}.3`];
    return {
      instructions: lab({ situation: `This server got its address from DHCP. The address plan gives it **${net}.${last}/24**, gateway **${net}.1**, DNS servers **${dns.join(' and ')}**, and search domain **campus.lan**. Configure the **eth0** connection with nmcli so it survives reboots, then activate it.`, steps: ['nmcli con show eth0 to see the current settings.', 'nmcli con mod eth0 with ipv4.method manual and the address, gateway, dns and dns-search.', 'nmcli con up eth0.', 'Check ip addr and /etc/resolv.conf.'], tips: [`nmcli con mod eth0 ipv4.method manual ipv4.addresses ${net}.${last}/24 ipv4.gateway ${net}.1 ipv4.dns "${dns.join(',')}" ipv4.dns-search campus.lan`, 'nmcli con up eth0'] }),
      hints: ['ip addr add would only last until the next reboot.', 'method manual needs an address, or nmcli refuses.'],
      initialState: linux(net, { last: v.int(150, 200) }),
      checks: [out('The new address is active', 'ip addr', { contains: `inet ${net}.${last}/24` }), out('The default route is right', 'ip route', { contains: `default via ${net}.1` }), file('Both DNS servers are used', '/etc/resolv.conf', { contains: [`nameserver ${dns[0]}`, `nameserver ${dns[1]}`] }), file('The search domain is set', '/etc/resolv.conf', { pattern: '^search .*campus\\.lan' }), file('It is saved for reboots', '/etc/NetworkManager/system-connections/eth0.nmconnection', { contains: ['method=manual', `${net}.${last}/24`] })],
      solution: ['nmcli con show eth0', `nmcli con mod eth0 ipv4.method manual ipv4.addresses ${net}.${last}/24 ipv4.gateway ${net}.1 ipv4.dns "${dns.join(',')}" ipv4.dns-search campus.lan`, 'nmcli con up eth0', 'ip addr'],
      realityNote: 'NetworkManager is the default on openSUSE, Fedora/RHEL and Ubuntu desktops; nmcli scripts the same settings the GUI and YaST change.',
    };
  }),
  tmpl(7, 1, 'advanced', 'fix-name-resolution', 'Fix a server that cannot resolve names', 'E4', 25, 'Repair a wrong nameserver, a missing search domain and a stale hosts entry.', (v) => {
    const net = v.net();
    const intranet = `${net}.${v.int(30, 40)}`;
    const printerOld = `${net}.${v.int(200, 210)}`;
    const printerNew = `${net}.${v.int(211, 220)}`;
    const wrong = `10.${v.int(200, 250)}.0.53`;
    return {
      instructions: lab({ situation: `Since a contractor "tidied up" this server, \`ping intranet\` fails and print jobs go to the old printer address. Campus DNS is the gateway, **${net}.1**, and short names should resolve in **campus.lan**. Find and fix all three problems: the nameserver, the search domain, and a stale entry in /etc/hosts that overrides DNS for **printer**.`, steps: ['getent hosts intranet and printer: what do you get?', 'Read /etc/resolv.conf and /etc/hosts.', 'Fix resolv.conf through nmcli (ipv4.dns, ipv4.dns-search) so it stays fixed, and remove the stale hosts line.', 'Test again.'], tips: ['getent hosts printer', 'dig intranet.campus.lan', `nmcli con mod eth0 ipv4.dns ${net}.1 ipv4.dns-search campus.lan && nmcli con up eth0`, "sed -i '/printer/d' /etc/hosts"] }),
      hints: ['/etc/hosts is checked before DNS (see /etc/nsswitch.conf).', 'Editing resolv.conf by hand is undone the next time NetworkManager writes it.'],
      initialState: linux(net, { network: { address: `${net}.5/24`, gateway: `${net}.1`, hosts: { 'intranet.campus.lan': intranet, 'printer.campus.lan': printerNew } }, files: { '/etc/resolv.conf': `nameserver ${wrong}\n`, '/etc/hosts': `127.0.0.1\tlocalhost\n${net}.5\tsrv1\n${printerOld}\tprinter.campus.lan printer\n` } }),
      checks: [out('intranet resolves', 'getent hosts intranet', { contains: intranet }), out('printer resolves to its new address', 'getent hosts printer', { contains: printerNew, notContains: printerOld }), file('The fix is persistent', '/etc/NetworkManager/system-connections/eth0.nmconnection', { contains: [`dns=${net}.1`, 'campus.lan'] })],
      solution: ['getent hosts intranet', 'cat /etc/resolv.conf', `nmcli con mod eth0 ipv4.dns ${net}.1 ipv4.dns-search campus.lan`, 'nmcli con up eth0', "sed -i '/printer/d' /etc/hosts", 'getent hosts printer'],
      realityNote: '"It is always DNS" is a sysadmin joke because it is so often true; stale /etc/hosts entries are the second most common cause.',
    };
  }),

  /* ---------------------------------------------------------------- 7.2 diagnostics */
  tmpl(7, 2, 'beginner', 'what-is-listening', 'Find which program listens on a port', 'E4', 10, 'Use ss to map open ports to services.', (v) => {
    const net = v.net();
    const [svcName, port, pk] = v.pick([['mariadb', 3306, 'mariadb'], ['apache2', 80, 'apache2'], ['named', 53, 'bind']] as Array<[string, number, string]>);
    return {
      instructions: lab({ situation: `A scan says port **${port}** is open on this server. Find out which service is listening there and write its name (as shown by ss -p) to **/root/port-${port}.txt**.`, steps: ['ss -tlnp lists listening TCP sockets with their process.', 'Find the line for the port.'], tips: ['ss -tlnp', 'ss -tlnp | grep :' + port] }),
      hints: ['-t TCP, -l listening, -n numeric ports, -p process.'],
      initialState: linux(net, { packages: { [pk]: { installed: true } }, services: { [svcName]: { active: true, enabled: true, package: pk, port } } }),
      checks: [file('The service is identified', `/root/port-${port}.txt`, { contains: svcName })],
      solution: ['ss -tlnp', `echo ${svcName} > /root/port-${port}.txt`],
      realityNote: 'ss (from iproute2) replaced netstat; ss -tlnp is the first command when a port scan finds something unexpected.',
    };
  }),
  tmpl(7, 2, 'intermediate', 'dig-records', 'Query DNS records with dig', 'E4', 20, 'Use dig against the local DNS server to answer questions about A, MX, CNAME and NS records.', (v) => {
    const net = v.net();
    const zone = v.pick(['campus.lan', 'college.lan', 'faculty.lan']);
    const web = `${net}.${v.int(20, 40)}`;
    const mail = `mail${v.int(1, 3)}`;
    const alias = v.pick(['portal', 'elearn', 'library']);
    return {
      instructions: lab({ situation: `This server runs BIND for **${zone}**. Using **dig @127.0.0.1**, find:\n\n1. the address of **www.${zone}**,\n2. the mail server named in the **MX** record of ${zone},\n3. the name that **${alias}.${zone}** is an alias for,\n4. the name server in the **NS** record.\n\nWrite them as \`www=...\`, \`mx=...\`, \`alias=...\`, \`ns=...\` lines (host names without the trailing dot) in **/root/dns-answers.txt**.`, steps: ['dig @127.0.0.1 www.' + zone + ' A +short', 'dig ... MX, CNAME and NS.'], tips: [`dig @127.0.0.1 ${zone} MX +short`, `dig @127.0.0.1 ${alias}.${zone} CNAME +short`] }),
      hints: ['+short prints only the answer.', 'An MX answer is "preference host".'],
      initialState: linux(net, { packages: { bind: { installed: true } }, services: { named: { active: true, enabled: true, package: 'bind', port: 53 } }, files: bindZone(zone, net, `@\tIN\tMX\t10 ${mail}\nwww\tIN\tA\t${web}\n${mail}\tIN\tA\t${net}.25\n${alias}\tIN\tCNAME\twww\n`) }),
      checks: [file('www is right', '/root/dns-answers.txt', { contains: `www=${web}` }), file('mx is right', '/root/dns-answers.txt', { contains: `mx=${mail}.${zone}` }), file('alias is right', '/root/dns-answers.txt', { contains: `alias=www.${zone}` }), file('ns is right', '/root/dns-answers.txt', { contains: `ns=ns1.${zone}` }), ran('You used dig', '^dig ')],
      solution: [`dig @127.0.0.1 www.${zone} +short`, `dig @127.0.0.1 ${zone} MX +short`, `dig @127.0.0.1 ${alias}.${zone} CNAME +short`, `dig @127.0.0.1 ${zone} NS +short`, `printf 'www=${web}\\nmx=${mail}.${zone}\\nalias=www.${zone}\\nns=ns1.${zone}\\n' > /root/dns-answers.txt`],
      realityNote: 'dig shows exactly what a DNS server answers, which is why it is preferred over nslookup for troubleshooting.',
    };
  }),
  tmpl(7, 2, 'advanced', 'port-audit', 'Audit and close exposed ports', 'E4', 25, 'Use nmap to see what other hosts can reach and close what should not be exposed.', (v) => {
    const net = v.net();
    return {
      instructions: lab({ situation: `This web server should expose only **SSH** and **HTTP** to the network. A colleague opened extra firewall ports "for testing". Scan the server's own address (**${net}.5**) with nmap to see what other hosts can reach, close everything except ssh and http in the firewall (permanently), and record the ports you closed in **/root/closed-ports.txt**. The database must keep running for the local web application.`, steps: [`nmap ${net}.5 shows what is reachable from outside.`, 'nmap localhost shows everything listening.', 'firewall-cmd --list-all shows why.', 'Remove the extra ports and services, then scan again.'], tips: [`nmap ${net}.5`, 'firewall-cmd --list-all', 'firewall-cmd --permanent --remove-port=3306/tcp', 'firewall-cmd --permanent --remove-service=cockpit'] }),
      hints: ['A service can listen and still be unreachable if the firewall blocks it: that is what you want for the database.'],
      initialState: linux(net, { packages: { apache2: { installed: true }, mariadb: { installed: true } }, services: { apache2: { active: true, enabled: true, package: 'apache2', port: 80 }, mariadb: { active: true, enabled: true, package: 'mariadb', port: 3306 }, cockpit: { active: true, enabled: true, port: 9090, description: 'Cockpit web console' } }, files: { '/etc/firewalld/zones/public.xml': 'service:ssh\nservice:http\nservice:cockpit\nport:3306/tcp\nport:8080/tcp\n' } }),
      checks: [out('Only SSH and HTTP are reachable from the network', `nmap ${net}.5`, { contains: ['22/tcp', '80/tcp'], notContains: ['3306/tcp   open', '9090/tcp   open', '3306/tcp open', '9090/tcp open'] }), out('The firewall allows only ssh and http', 'firewall-cmd --list-all', { contains: 'services: ssh http', notContains: ['3306', '8080', 'cockpit'] }), svc('The database still runs locally', 'mariadb', { active: true }), file('The closed ports are recorded', '/root/closed-ports.txt', { contains: ['3306', '9090'] })],
      solution: [`nmap ${net}.5`, 'firewall-cmd --list-all', 'firewall-cmd --permanent --remove-port=3306/tcp', 'firewall-cmd --permanent --remove-port=8080/tcp', 'firewall-cmd --permanent --remove-service=cockpit', 'firewall-cmd --reload', "printf '3306\\n8080\\n9090\\n' > /root/closed-ports.txt", `nmap ${net}.5`],
      realityNote: 'Scanning yourself from the outside view is the quickest way to find accidental exposure; databases should listen locally or be firewalled.',
    };
  }),

  /* ---------------------------------------------------------------- 7.3 SSH */
  tmpl(7, 3, 'beginner', 'ssh-keys', 'Set up key-based SSH login for an account', 'E4', 20, 'Generate a key pair and install the public key with the right permissions.', (v) => {
    const net = v.net();
    const p = v.person();
    const target = v.pick(['deploy', 'backup', 'webadmin']);
    return {
      instructions: lab({ situation: `${p.given} (**${p.sam}**) needs to log in as **${target}** with an SSH key instead of a password. Generate an **ed25519** key pair for ${p.sam}, then install the public key in **/home/${target}/.ssh/authorized_keys** with the permissions sshd insists on: .ssh **700**, authorized_keys **600**, both owned by ${target}.`, steps: [`As ${p.sam}: ssh-keygen -t ed25519 (no passphrase for the lab: -N "").`, `As root: create /home/${target}/.ssh, append the .pub file to authorized_keys.`, 'Fix ownership and modes.'], tips: [`su - ${p.sam} -c 'ssh-keygen -t ed25519 -N ""'`, `cat /home/${p.sam}/.ssh/id_ed25519.pub >> /home/${target}/.ssh/authorized_keys`, `chown -R ${target}: /home/${target}/.ssh`, `chmod 700 /home/${target}/.ssh`] }),
      hints: ['sshd ignores authorized_keys files that others can write to.'],
      initialState: linux(net, { users: { [p.sam]: {}, [target]: {} } }),
      checks: [file(`${p.sam} has a private key`, `/home/${p.sam}/.ssh/id_ed25519`, { mode: '600' }), file(`${target}/.ssh is 700`, `/home/${target}/.ssh`, { kind: 'dir', mode: '700', owner: target }), file('authorized_keys holds the key with mode 600', `/home/${target}/.ssh/authorized_keys`, { mode: '600', owner: target, contains: 'ssh-ed25519 ' })],
      solution: [`su - ${p.sam} -c 'ssh-keygen -t ed25519 -N ""'`, `mkdir -p /home/${target}/.ssh`, `cat /home/${p.sam}/.ssh/id_ed25519.pub >> /home/${target}/.ssh/authorized_keys`, `chown -R ${target}:${target} /home/${target}/.ssh`, `chmod 700 /home/${target}/.ssh`, `chmod 600 /home/${target}/.ssh/authorized_keys`],
      realityNote: 'ssh-copy-id automates the same steps across the network; the permission rules are why manual copies so often fail.',
    };
  }),
  tmpl(7, 3, 'intermediate', 'harden-sshd', 'Harden the SSH server without locking yourself out', 'E4', 25, 'Restrict root and password logins and limit SSH to a group, safely.', (v) => {
    const net = v.net();
    const admin = v.person();
    const tries = v.pick([3, 4]);
    return {
      instructions: lab({ situation: `Apply the SSH policy: **no root login**, **no password authentication** (keys only), at most **${tries}** authentication tries, and only members of group **sshusers** may log in. **${admin.sam}** is the administrator: make sure they are in sshusers and have an authorized key **before** the restart, so nobody is locked out. Test the configuration with sshd -t before restarting.`, steps: ['Create the group and add the admin.', `Install ${admin.sam}'s key (it is in /root/${admin.sam}.pub).`, 'Edit sshd_config.', 'sshd -t, then systemctl restart sshd.'], tips: ['groupadd sshusers; usermod -aG sshusers ' + admin.sam, "printf 'PermitRootLogin no\\nPasswordAuthentication no\\nMaxAuthTries 3\\nAllowGroups sshusers\\n' >> /etc/ssh/sshd_config", 'sshd -T | grep -i -e permitroot -e password'] }),
      hints: ['sshd uses the first value it reads for most options, so check with sshd -T.', 'Keep your current session open while testing a new one.'],
      initialState: linux(net, { users: { [admin.sam]: { groups: ['wheel'] } }, files: { [`/root/${admin.sam}.pub`]: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAdmin ${admin.sam}@laptop\n` } }),
      checks: [out('Root login is off', 'sshd -T', { contains: 'permitrootlogin no' }), out('Password authentication is off', 'sshd -T', { contains: 'passwordauthentication no' }), out(`At most ${tries} tries`, 'sshd -T', { contains: `maxauthtries ${tries}` }), out('Only sshusers may log in', 'sshd -T', { contains: 'allowgroups sshusers' }), group(`${admin.sam} is in sshusers`, 'sshusers', { members: [admin.sam] }), file(`${admin.sam} has an authorized key`, `/home/${admin.sam}/.ssh/authorized_keys`, { contains: 'ssh-ed25519', mode: '600', owner: admin.sam }), svc('sshd is running with the new configuration', 'sshd', { active: true })],
      solution: ['groupadd sshusers', `usermod -aG sshusers ${admin.sam}`, `mkdir -p /home/${admin.sam}/.ssh`, `cp /root/${admin.sam}.pub /home/${admin.sam}/.ssh/authorized_keys`, `chown -R ${admin.sam}:${admin.sam} /home/${admin.sam}/.ssh`, `chmod 700 /home/${admin.sam}/.ssh`, `chmod 600 /home/${admin.sam}/.ssh/authorized_keys`, `printf 'PermitRootLogin no\\nPasswordAuthentication no\\nMaxAuthTries ${tries}\\nAllowGroups sshusers\\n' >> /etc/ssh/sshd_config`, 'sshd -t', 'systemctl restart sshd', 'sshd -T'],
      realityNote: 'Key-only SSH with no root login removes the target of the endless password-guessing traffic every internet-facing server receives.',
    };
  }),
  tmpl(7, 3, 'advanced', 'move-ssh-port', 'Move SSH to another port and keep access', 'E4', 25, 'Change the SSH port in sshd and the firewall together, in a safe order.', (v) => {
    const net = v.net();
    const port = v.pick([2222, 2200, 22022]);
    return {
      instructions: lab({ situation: `To cut log noise from scanners, move SSH from 22 to **${port}**. Do it in the order that never locks you out: open **${port}/tcp** in the firewall first, change **Port** in sshd_config, test, restart sshd, confirm it listens on ${port}, and only then remove the **ssh** service (port 22) from the firewall. All firewall changes must be permanent.`, steps: [`firewall-cmd --permanent --add-port=${port}/tcp && firewall-cmd --reload.`, 'Set Port in sshd_config; sshd -t; restart.', `ss -tln shows :${port}.`, 'Remove the ssh service from the firewall.'], tips: [`sed -i 's/^#\\?Port .*/Port ${port}/' /etc/ssh/sshd_config`, 'ss -tln', 'firewall-cmd --permanent --remove-service=ssh'] }),
      hints: ['If you remove port 22 first and the new port fails, you are locked out of a remote server.', 'Changing the port reduces noise; it is not a security control by itself.'],
      initialState: linux(net),
      checks: [out(`sshd listens on ${port}`, 'ss -tln', { contains: `:${port} ` }), out(`sshd is configured for ${port}`, 'sshd -T', { contains: `port ${port}` }), out(`The firewall allows ${port}/tcp and no longer ssh`, 'firewall-cmd --list-all', { contains: `${port}/tcp`, notContains: 'services: ssh' }), ran('You opened the new port before closing the old one', `--add-port=${port}/tcp`)],
      solution: [`firewall-cmd --permanent --add-port=${port}/tcp`, 'firewall-cmd --reload', `sed -i 's/^#\\?Port .*/Port ${port}/' /etc/ssh/sshd_config`, 'sshd -t', 'systemctl restart sshd', 'ss -tln', 'firewall-cmd --permanent --remove-service=ssh', 'firewall-cmd --reload'],
      realityNote: 'On SELinux systems the new port also needs a semanage port label; on every system the order of operations is what keeps you connected.',
    };
  }),

  /* ---------------------------------------------------------------- 7.4 remote management at scale */
  tmpl(7, 4, 'beginner', 'scale-up-management', 'Choose tools for managing many servers', 'E10', 15, 'Compare looping over SSH, parallel SSH and Ansible for routine work.', (v) => {
    const n = v.int(15, 60);
    return caseStudy(v, {
      intro: `## ${n} servers, one administrator\n\nThe faculty now has ${n} Linux servers. Decide how to manage them.`,
      steps: [
        { title: 'One-off command', text: 'Check the uptime of every server right now.', choices: [{ text: 'Parallel SSH (pssh / pdsh) over an inventory list', right: true, feedback: 'Correct. Quick one-off commands across many hosts.' }, { text: 'Log in to each server by hand', feedback: `${n} logins for one number each.` }, { text: 'Write an Ansible role', feedback: 'Overkill for a single read-only command (though ansible -m command works).' }] },
        { title: 'Keeping config consistent', text: 'sshd_config must be identical everywhere, and stay so.', choices: [{ text: 'Ansible playbook run regularly: it describes the desired state and changes only what differs', right: true, feedback: 'Correct. Idempotent and repeatable.' }, { text: 'A for loop with scp', feedback: 'Copies, but does not restart services safely or report drift.' }, { text: 'Edit each file by hand when needed', feedback: 'Drift is guaranteed.' }] },
        { title: 'What Ansible needs', text: 'What must be on the managed servers for Ansible to work?', choices: [{ text: 'SSH access and Python; no agent', right: true, feedback: 'Correct. Ansible pushes over SSH.' }, { text: 'An Ansible agent service', feedback: 'That is Puppet\'s or Salt\'s model; Ansible is agentless.' }, { text: 'A graphical desktop', feedback: 'Not at all.' }] },
        { title: 'Keys for automation', text: 'How should automation authenticate?', choices: [{ text: 'A dedicated automation account with an SSH key and narrow sudo rights', right: true, feedback: 'Correct.' }, { text: 'Root password in the playbook', feedback: 'Secrets in plain text and root everywhere.' }, { text: 'Your personal key', feedback: 'Automation then breaks when you leave, and mixes identities.' }] },
      ],
      ending: { title: 'Tools chosen', text: 'Parallel SSH for one-off checks, Ansible for desired state, a dedicated automation identity.' },
      hints: ['One-off read versus lasting state.'],
      realityNote: 'Ansible became the most common configuration tool in universities largely because it needs nothing but SSH on the servers.',
    });
  }),
  tmpl(7, 4, 'intermediate', 'ansible-files', 'Write an Ansible inventory and playbook', 'E4', 25, 'Describe hosts in groups and write an idempotent playbook for the web group.', (v) => {
    const net = v.net();
    const webs = [`web01`, `web02`];
    const db = 'db01';
    const pkg = v.pick(['apache2', 'nginx']);
    return {
      instructions: lab({ situation: `Prepare Ansible for the web servers. Write **/etc/ansible/hosts** (INI format) with group **[web]** containing ${webs.join(' and ')} and group **[db]** containing ${db}. Then write **/etc/ansible/site.yml**, a playbook for **hosts: web** with **become: true** that installs **${pkg}** with the package module, and starts and enables it with the service module.`, steps: ['Write the inventory.', 'Write the playbook in YAML (spaces, not tabs).', 'Read it back carefully: indentation is syntax in YAML.'], tips: ['[web]\\nweb01\\nweb02', `- hosts: web\\n  become: true\\n  tasks:\\n    - name: Install ${pkg}\\n      ansible.builtin.package:\\n        name: ${pkg}\\n        state: present`] }),
      hints: ['state: present (package) and state: started plus enabled: true (service) describe the end state, which is what makes playbooks idempotent.'],
      initialState: linux(net, { files: { '/etc/ansible/': null } }),
      checks: [file('The inventory has the web group', '/etc/ansible/hosts', { pattern: '^\\[web\\]\\s*\\nweb01\\s*\\nweb02' }), file('The inventory has the db group', '/etc/ansible/hosts', { pattern: '^\\[db\\]\\s*\\ndb01' }), file('The playbook targets web with privilege', '/etc/ansible/site.yml', { pattern: '^- hosts: web', contains: 'become: true' }), file(`It installs ${pkg}`, '/etc/ansible/site.yml', { pattern: `package:\\s*\\n\\s+name: ${pkg}\\s*\\n\\s+state: present` }), file(`It starts and enables ${pkg}`, '/etc/ansible/site.yml', { pattern: `service:\\s*\\n\\s+name: ${pkg}`, contains: ['state: started', 'enabled: true'] }), file('No tabs in the YAML', '/etc/ansible/site.yml', { notContains: '\t' })],
      solution: [`printf '[web]\\nweb01\\nweb02\\n\\n[db]\\ndb01\\n' > /etc/ansible/hosts`, `printf -- '- hosts: web\\n  become: true\\n  tasks:\\n    - name: Install ${pkg}\\n      ansible.builtin.package:\\n        name: ${pkg}\\n        state: present\\n    - name: Start and enable ${pkg}\\n      ansible.builtin.service:\\n        name: ${pkg}\\n        state: started\\n        enabled: true\\n' > /etc/ansible/site.yml`],
      realityNote: 'ansible-playbook -i hosts site.yml --check shows what would change; on real systems that dry run comes before every change.',
    };
  }),
  tmpl(7, 4, 'advanced', 'idempotence', 'Make automation safe to run twice', 'E10', 20, 'Spot non-idempotent steps and choose declarative replacements.', (v) => {
    const line = v.pick(['PermitRootLogin no', 'net.ipv4.ip_forward = 0']);
    return caseStudy(v, {
      intro: '## The second run broke it\n\nA script ran fine the first time and caused problems the second time. Review its steps.',
      steps: [
        { title: 'Appending a line', text: `The script runs: echo '${line}' >> CONFIG`, choices: [{ text: 'Not idempotent: every run adds another copy; use lineinfile (Ansible) or grep -q before appending', right: true, feedback: 'Correct.' }, { text: 'Fine: duplicates do no harm', feedback: 'Duplicates confuse readers and, for some options, change behaviour.' }, { text: 'Use > instead of >>', feedback: 'That would wipe the rest of the file.' }] },
        { title: 'Creating a user', text: 'useradd deploy', choices: [{ text: 'Fails on the second run; check first (id deploy) or use the user module with state: present', right: true, feedback: 'Correct.' }, { text: 'Fine: useradd ignores existing users', feedback: 'It exits with an error.' }, { text: 'Delete the user first, then add it', feedback: 'That destroys the account\'s files and identity each time.' }] },
        { title: 'Restarting', text: 'The script always restarts the web server at the end.', choices: [{ text: 'Restart only when configuration changed (Ansible handlers do this)', right: true, feedback: 'Correct. Needless restarts drop connections.' }, { text: 'Always restart, to be safe', feedback: 'Unnecessary downtime on every run.' }, { text: 'Never restart', feedback: 'Then configuration changes do not take effect.' }] },
        { title: 'Testing', text: 'How do you prove a playbook is idempotent?', choices: [{ text: 'Run it twice: the second run should report no changes', right: true, feedback: 'Correct. Tools like Molecule automate this test.' }, { text: 'Run it once and check it worked', feedback: 'Idempotence is about the second run.' }, { text: 'Read it carefully', feedback: 'Helpful, but run it.' }] },
      ],
      ending: { title: 'Automation fixed', text: 'Check-before-change, declarative modules, handlers for restarts and a second-run test.' },
      hints: ['Imagine running it a third time.'],
      realityNote: 'Idempotence is the property that lets configuration management run every 30 minutes on thousands of hosts without causing churn.',
    });
  }),

  /* ---------------------------------------------------------------- 7.5 firewall, NAT, forwarding */
  tmpl(7, 5, 'beginner', 'open-web-ports', 'Open the web ports in firewalld', 'E4', 10, 'Allow HTTP and HTTPS permanently and reload the firewall.', (v) => {
    const net = v.net();
    return {
      instructions: lab({ situation: 'This new web server answers locally but not from other machines: the firewall only allows SSH. Allow **http** and **https** permanently and reload.', steps: ['firewall-cmd --list-all.', 'Add both services with --permanent.', 'Reload and list again.'], tips: ['firewall-cmd --permanent --add-service=http', 'firewall-cmd --reload'] }),
      hints: ['Without --permanent, rules are lost at reboot; without a reload, permanent rules are not active yet.'],
      initialState: linux(net, { packages: { apache2: { installed: true } }, services: { apache2: { active: true, enabled: true, package: 'apache2', port: 80 } } }),
      checks: [out('http and https are allowed', 'firewall-cmd --list-services', { contains: ['http', 'https'] }), out('SSH is still allowed', 'firewall-cmd --list-services', { contains: 'ssh' }), out('Port 80 is reachable from the network', `nmap ${net}.5`, { pattern: '80/tcp\\s+open' })],
      solution: ['firewall-cmd --list-all', 'firewall-cmd --permanent --add-service=http', 'firewall-cmd --permanent --add-service=https', 'firewall-cmd --reload'],
      realityNote: 'firewalld services bundle the right ports and protocols under one name, which keeps rules readable.',
    };
  }),
  tmpl(7, 5, 'intermediate', 'nat-gateway', 'Turn a server into a NAT gateway with port forwarding', 'E4', 25, 'Enable IP forwarding persistently, masquerade outgoing traffic and forward a port to an internal host.', (v) => {
    const net = v.net();
    const inner = `192.168.${v.int(10, 90)}.${v.int(10, 50)}`;
    const ext = v.pick([8080, 8443]);
    return {
      instructions: lab({ situation: `This server connects a lab network to the campus network. Make it a gateway:\n\n1. Enable **IPv4 forwarding**, persistently, in **/etc/sysctl.d/90-router.conf**, and apply it.\n2. Turn on **masquerading** (NAT) in firewalld, permanently.\n3. Forward TCP port **${ext}** on this server to port **80** of the lab web server **${inner}**, permanently.`, steps: ['Write net.ipv4.ip_forward = 1 to the sysctl file and run sysctl --system.', 'firewall-cmd --permanent --add-masquerade.', `firewall-cmd --permanent --add-forward-port=port=${ext}:proto=tcp:toport=80:toaddr=${inner}.`, 'Reload and check.'], tips: ["echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-router.conf", 'sysctl --system', 'firewall-cmd --list-all'] }),
      hints: ['sysctl -w changes the running kernel only; the file makes it permanent.'],
      initialState: linux(net),
      checks: [out('Forwarding is on now', 'sysctl net.ipv4.ip_forward', { equals: 'net.ipv4.ip_forward = 1' }), file('Forwarding is persistent', '/etc/sysctl.d/90-router.conf', { pattern: '^net\\.ipv4\\.ip_forward\\s*=\\s*1' }), out('Masquerading is on', 'firewall-cmd --list-all', { contains: 'masquerade: yes' }), out('The port is forwarded', 'firewall-cmd --list-all', { contains: `port=${ext}:proto=tcp:toport=80:toaddr=${inner}` })],
      solution: ["echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/90-router.conf", 'sysctl --system', 'firewall-cmd --permanent --add-masquerade', `firewall-cmd --permanent --add-forward-port=port=${ext}:proto=tcp:toport=80:toaddr=${inner}`, 'firewall-cmd --reload', 'firewall-cmd --list-all'],
      realityNote: 'The same three pieces (forwarding, NAT, port forwarding) are what every home router does; on Linux they are explicit and auditable.',
    };
  }),
  tmpl(7, 5, 'advanced', 'ssh-from-admins-only', 'Allow SSH only from the admin network', 'E4', 25, 'Replace an open SSH rule with a rich rule limited to one subnet, without losing access.', (v) => {
    const net = v.net();
    const admin = `10.${v.int(100, 199)}.${v.int(0, 250)}.0/24`;
    return {
      instructions: lab({ situation: `SSH on this server is open to every network. Policy: SSH only from the admin network **${admin}**. Add a **rich rule** that accepts the ssh service from that source, permanently, **then** remove the general ssh service. HTTP stays open to everyone.`, steps: ['Add the rich rule first.', 'Then remove the ssh service.', 'Reload and check firewall-cmd --list-all.'], tips: [`firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${admin}" service name="ssh" accept'`, 'firewall-cmd --permanent --remove-service=ssh', 'firewall-cmd --reload'] }),
      hints: ['A rich rule can match a source address; a plain service rule matches everyone.', 'Order matters when you are connected over SSH.'],
      initialState: linux(net, { files: { '/etc/firewalld/zones/public.xml': 'service:ssh\nservice:http\n' } }),
      checks: [out('A rich rule allows SSH from the admin network', 'firewall-cmd --list-rich-rules', { contains: [`source address="${admin}"`, 'service name="ssh"', 'accept'] }), out('SSH is no longer open to everyone', 'firewall-cmd --list-services', { notContains: 'ssh' }), out('HTTP is still open', 'firewall-cmd --list-services', { contains: 'http' }), ran('You added the rich rule before removing ssh', 'add-rich-rule')],
      solution: [`firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${admin}" service name="ssh" accept'`, 'firewall-cmd --permanent --remove-service=ssh', 'firewall-cmd --reload', 'firewall-cmd --list-all'],
      realityNote: 'Source-restricted management access is one of the most effective controls against brute-force attacks; a VPN or bastion host is the next step.',
    };
  }),
];

export { user };
