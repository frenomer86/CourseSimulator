import { describe, expect, it } from 'vitest';
import { buildSystem, type SystemSpec } from './system.js';
import { runLines } from './shell.js';

const sys = (extra: Partial<SystemSpec> = {}) => buildSystem({ user: 'root', hostname: 'srv1', network: { address: '10.20.30.5/24', gateway: '10.20.30.1' }, ...extra });

describe('name resolution', () => {
  it('answers from a local BIND zone and follows /etc/hosts and resolv.conf', () => {
    const s = sys({
      packages: { bind: { installed: true } },
      services: { named: { active: true, enabled: true, package: 'bind' } },
      files: {
        '/etc/named.conf': 'options {\n    directory "/var/lib/named";\n    recursion yes;\n};\n\nzone "campus.lan" in {\n    type master;\n    file "campus.lan.zone";\n};\n',
        '/var/lib/named/campus.lan.zone': '$TTL 3600\n@ IN SOA ns1.campus.lan. admin.campus.lan. ( 2026102201 3600 900 604800 300 )\n  IN NS ns1\nns1 IN A 10.20.30.5\nwww IN A 10.20.30.80\nportal IN CNAME www\nbad IN CNAME www.campus.lan\n',
        '/etc/resolv.conf': 'search campus.lan\nnameserver 127.0.0.1\n',
        '/etc/hosts': '127.0.0.1 localhost\n10.20.30.99 printer.campus.lan printer\n',
      },
    });
    const out = runLines(s, ['dig @127.0.0.1 www.campus.lan +short', 'dig portal.campus.lan', 'dig bad.campus.lan +short', 'getent hosts printer', 'host www', 'named-checkzone campus.lan /var/lib/named/campus.lan.zone']);
    expect(out).toContain('10.20.30.80');
    expect(out).toContain('portal.campus.lan.\t3600\tIN\tCNAME\twww.campus.lan.');
    expect(out).toContain('www.campus.lan.campus.lan.');
    expect(out).toContain('10.20.30.99');
    expect(out).toContain('www.campus.lan has address 10.20.30.80');
    expect(out).toContain('loaded serial 2026102201');
  });

  it('refuses to start named with a broken zone', () => {
    const s = sys({ packages: { bind: { installed: true } }, services: { named: { active: false, package: 'bind' } }, files: { '/etc/named.conf': 'options { directory "/var/lib/named"; };\nzone "x.lan" { type master; file "x.lan.zone"; };\n', '/var/lib/named/x.lan.zone': '@ IN NS ns1\nns1 IN A 10.0.0.1\n' } });
    const out = runLines(s, ['systemctl start named', 'systemctl is-active named']);
    expect(out).toContain('failed');
    expect(out).toContain('inactive');
  });
});

describe('network and firewall', () => {
  it('applies a static configuration with nmcli', () => {
    const s = sys();
    runLines(s, ['nmcli con mod eth0 ipv4.method manual ipv4.addresses 10.20.30.50/24 ipv4.gateway 10.20.30.1 ipv4.dns 10.20.30.5', 'nmcli con up eth0']);
    expect(s.network?.address).toBe('10.20.30.50/24');
    expect(runLines(s, ['cat /etc/resolv.conf', 'ip addr'])).toContain('nameserver 10.20.30.5');
  });

  it('keeps firewall services, masquerade and forwards, and nmap sees the result', () => {
    const s = sys({ packages: { apache2: { installed: true } }, services: { apache2: { active: true, package: 'apache2', port: 80 } } });
    runLines(s, ['firewall-cmd --permanent --add-service=http', 'firewall-cmd --add-masquerade', 'firewall-cmd --add-forward-port=port=8080:proto=tcp:toport=80', 'firewall-cmd --remove-service=dhcpv6-client']);
    const out = runLines(s, ['firewall-cmd --list-all', 'nmap 10.20.30.5']);
    expect(out).toContain('services: ssh http');
    expect(out).toContain('masquerade: yes');
    expect(out).toContain('port=8080:proto=tcp:toport=80');
    expect(out).toMatch(/80\/tcp\s+open\s+http/);
  });
});

describe('systemd, time and kernel settings', () => {
  it('registers a unit file and its timer', () => {
    const s = sys({ files: { '/usr/local/bin/backup.sh': { content: '#!/bin/bash\necho ok\n', mode: '755' }, '/etc/systemd/system/backup.service': '[Unit]\nDescription=Nightly backup\n[Service]\nType=oneshot\nExecStart=/usr/local/bin/backup.sh\n', '/etc/systemd/system/backup.timer': '[Unit]\nDescription=Run backup nightly\n[Timer]\nOnCalendar=*-*-* 02:00:00\nPersistent=true\n[Install]\nWantedBy=timers.target\n' } });
    const out = runLines(s, ['systemctl daemon-reload', 'systemctl enable --now backup.timer', 'systemctl list-timers', 'systemctl set-default multi-user.target', 'systemctl get-default']);
    expect(s.services['backup.timer'].active).toBe(true);
    expect(out).toContain('backup.timer');
    expect(out).toContain('multi-user.target');
  });

  it('sets time zone, locale and sysctl values', () => {
    const s = sys({ files: { '/etc/sysctl.d/90-hardening.conf': 'net.ipv4.conf.all.accept_redirects = 0\nnet.ipv4.ip_forward = 1\n' } });
    const out = runLines(s, ['timedatectl set-timezone Africa/Accra', 'timedatectl', 'localectl set-locale LANG=en_GB.UTF-8', 'sysctl --system', 'sysctl net.ipv4.ip_forward', 'sysctl -w vm.swappiness=10', 'sysctl vm.swappiness']);
    expect(out).toContain('Time zone: Africa/Accra');
    expect(out).toContain('net.ipv4.ip_forward = 1');
    expect(out).toContain('vm.swappiness = 10');
  });
});

describe('web, ssh and sudo', () => {
  it('serves virtual hosts and enforces basic authentication', () => {
    const s = sys({
      packages: { apache2: { installed: true } },
      services: { apache2: { active: true, package: 'apache2', port: 80 } },
      files: {
        '/etc/apache2/listen.conf': 'Listen 80\n',
        '/etc/apache2/vhosts.d/library.conf': '<VirtualHost *:80>\n    ServerName library.campus.lan\n    DocumentRoot /srv/www/library\n    <Directory "/srv/www/library/staff">\n        AuthType Basic\n        AuthName "Staff"\n        AuthUserFile /etc/apache2/htpasswd\n        Require valid-user\n    </Directory>\n</VirtualHost>\n',
        '/srv/www/library/index.html': 'Library home\n',
        '/srv/www/library/staff/index.html': 'Staff only\n',
        '/etc/hosts': '127.0.0.1 localhost library.campus.lan\n',
      },
    });
    const out = runLines(s, ['curl http://library.campus.lan/', 'curl -I http://library.campus.lan/staff/', 'htpasswd -c -b /etc/apache2/htpasswd ama Secret123', 'curl -u ama:Secret123 http://library.campus.lan/staff/', 'apachectl configtest']);
    expect(out).toContain('Library home');
    expect(out).toContain('401 Unauthorized');
    expect(out).toContain('Staff only');
    expect(out).toContain('Syntax OK');
  });

  it('validates sshd_config and refuses to restart sshd with errors', () => {
    const s = sys({ files: { '/etc/ssh/sshd_config': 'Port 22\nPermitRootLogin maybe\n' } });
    expect(runLines(s, ['sshd -t'])).toContain('unsupported option "maybe"');
    expect(runLines(s, ['systemctl restart sshd'])).toContain('failed');
  });

  it('lets a user run only the commands a sudoers.d rule names', () => {
    const s = buildSystem({ user: 'kofi', users: { kofi: {} }, files: { '/etc/sudoers.d/webadmins': 'kofi ALL=(root) /usr/bin/systemctl restart apache2\n' }, packages: { apache2: { installed: true } }, services: { apache2: { active: false, package: 'apache2' } } });
    const out = runLines(s, ['sudo systemctl restart apache2', 'sudo cat /etc/shadow', 'sudo -l']);
    expect(s.services.apache2.active).toBe(true);
    expect(out).toContain('not in the sudoers file');
    expect(out).toContain('/usr/bin/systemctl restart apache2');
  });
});

describe('storage', () => {
  it('builds LVM volumes, mounts them from fstab and extends them', () => {
    const s = sys({ files: { '/etc/lvm/lab-state.json': JSON.stringify({ disks: [{ name: 'sdb', sizeGb: 20 }, { name: 'sdc', sizeGb: 20 }] }), '/srv/data/': null } });
    const uuid = (): string => /UUID="([^"]+)"/.exec(runLines(s, ['blkid /dev/vgdata/lvdata']))?.[1] ?? '';
    runLines(s, ['pvcreate /dev/sdb /dev/sdc', 'vgcreate vgdata /dev/sdb', 'lvcreate -L 15G -n lvdata vgdata', 'mkfs.xfs /dev/vgdata/lvdata']);
    runLines(s, [`echo "UUID=${uuid()} /srv/data xfs defaults 0 0" >> /etc/fstab`, 'mount -a']);
    let out = runLines(s, ['df -h', 'lsblk']);
    expect(out).toMatch(/\/srv\/data/);
    out = runLines(s, ['lvextend -L +10G -r /dev/vgdata/lvdata']);
    expect(out).toContain('insufficient free space'.replace('insufficient', 'Insufficient'));
    out = runLines(s, ['vgextend vgdata /dev/sdc', 'lvextend -L +10G -r /dev/vgdata/lvdata', 'lvs']);
    expect(out).toContain('25.00g');
  });
});

describe('security and tuning', () => {
  it('bans repeat SSH offenders with fail2ban but honours ignoreip', () => {
    const fail = (ip: string, n: number) => Array.from({ length: n }, () => `sshd[9]: Failed password for root from ${ip} port 4000 ssh2\n`).join('');
    const s = sys({
      packages: { fail2ban: { installed: true } },
      services: { fail2ban: { package: 'fail2ban' } },
      files: { '/etc/fail2ban/jail.local': '[DEFAULT]\nignoreip = 127.0.0.1/8 10.20.30.0/24\n\n[sshd]\nenabled = true\nmaxretry = 3\nbantime = 1h\n', '/var/log/secure': fail('185.220.101.7', 5) + fail('10.20.30.44', 4) + fail('45.155.205.33', 2) },
    });
    const out = runLines(s, ['systemctl start fail2ban', 'fail2ban-client status sshd', 'fail2ban-client get sshd bantime']);
    expect(out).toContain('Banned IP list:\t185.220.101.7\n');
    expect(out).toContain('3600');
    expect(runLines(s, ['fail2ban-client set sshd unbanip 185.220.101.7', 'fail2ban-client status sshd'])).toContain('Currently banned:\t0');
  });

  it('reads named.conf blocks with nested braces', () => {
    const s = sys({
      packages: { bind: { installed: true } },
      services: { named: { active: true, package: 'bind' } },
      files: { '/etc/named.conf': 'options {\n    directory "/var/lib/named";\n};\nzone "x.lan" in { type master; file "x.lan.zone"; allow-transfer { 10.20.30.6; }; };\n', '/var/lib/named/x.lan.zone': '$TTL 60\n@ IN SOA ns1.x.lan. h.x.lan. ( 1 60 60 60 60 )\n  IN NS ns1\nns1 IN A 10.20.30.5\n' },
    });
    expect(runLines(s, ['dig @127.0.0.1 x.lan AXFR'])).toContain('Transfer failed');
  });

  it('logs why Apache refused a request', () => {
    const s = sys({
      packages: { apache2: { installed: true } },
      services: { apache2: { active: true, package: 'apache2', port: 80 } },
      files: { '/var/log/apache2/error_log': '', '/etc/apache2/vhosts.d/a.conf': '<VirtualHost *:80>\n    ServerName a.lan\n    DocumentRoot /srv/www/a\n    <Directory "/srv/www/a">\n        Require all denied\n    </Directory>\n</VirtualHost>\n', '/srv/www/a/index.html': 'hi\n', '/etc/hosts': '127.0.0.1 localhost a.lan\n' },
    });
    expect(runLines(s, ['curl -I http://a.lan/'])).toContain('403 Forbidden');
    expect(runLines(s, ['cat /var/log/apache2/error_log'])).toContain('AH01630');
  });

  it('applies sysctl files in order, with sysctl.conf last, and prints bare values with -n', () => {
    const s = sys({ files: { '/etc/sysctl.d/50-a.conf': 'vm.swappiness = 30\n', '/etc/sysctl.d/90-b.conf': 'vm.swappiness = 10\n', '/etc/sysctl.conf': 'net.core.somaxconn = 8192\n' } });
    expect(runLines(s, ['sysctl --system > /dev/null', 'sysctl -n vm.swappiness', 'sysctl net.core.somaxconn'])).toBe('10\nnet.core.somaxconn = 8192\n');
  });

  it('expands \t and \n in sed replacements', () => {
    const s = sys({ files: { '/tmp/z': 'a b\n' } });
    expect(runLines(s, ["sed 's/ /\t/' /tmp/z"])).toBe('a\tb\n');
  });
});
