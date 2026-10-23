/**
 * Every E4 lab must be solvable: a reference transcript per lab id passes every check,
 * and the starting machine does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createShellChecks, runLines, systemFromInitial, type ShellState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

const SOLUTIONS: Record<string, string[]> = {
  "version-control-and-devops-i1-branch-merge-and-conflict": ["git config --global user.name \"Ama Mensah\"","git config --global user.email ama@example.com","cd portal","git init","git add .","git commit -m \"Initial fees page\"","git switch -c update-fees","sed -i 's/Tuition: GHS 2500/Tuition: GHS 2600/' fees.txt","git commit -am \"Board-approved tuition of 2600\"","git switch main","sed -i 's/Tuition: GHS 2500/Tuition: GHS 2550/' fees.txt","git commit -am \"Bursar correction to 2550\"","git merge update-fees","git status","printf 'Department of Computer Science: fees per year\\nTuition: GHS 2600\\nHostel: GHS 900\\nLibrary: GHS 50\\n' > fees.txt","git add fees.txt","git commit -m \"Merge update-fees: keep the board-approved fee\"","git branch -d update-fees","git log --oneline --all"],
  "containers-and-kubernetes-i1-containerise-a-static-site": ["cd market-site","ls","cat > Dockerfile <<'EOF'\nFROM nginx:1.27-alpine\nCOPY . /usr/share/nginx/html/\nEXPOSE 80\nEOF","docker build -t market:1.0 .","docker images","docker run -d --name market -p 8080:80 --restart unless-stopped market:1.0","docker ps","curl -s http://localhost:8080/prices.html"],
  "security-operations-and-incident-response-b1-triage-the-auth-log": ["mkdir report","grep -c 'Failed password' /var/log/auth.log > report/failed-count.txt","grep 'Failed password' /var/log/auth.log | awk '{print $(NF-3)}' | sort | uniq -c | sort -rn > report/failed-by-ip.txt","grep 'Accepted' /var/log/auth.log | grep 41.66.12.7 > report/suspicious.txt","sudo usermod -L kwame"],
  "information-security-i1-harden-the-web-root": ["mkdir audit","find /srv/portal -type f -perm -002 > audit/world-writable.txt","cat audit/world-writable.txt","sudo chown root:www-data /srv/portal/config.php","sudo chmod 640 /srv/portal/config.php","sudo chmod 700 /srv/portal/tools/debug.sh","sudo chown www-data:www-data /srv/portal/status.json","sudo chmod 644 /srv/portal/status.json","sudo mkdir -p /var/backups","sudo mv /srv/portal/backup.sql /var/backups/portal-backup.sql","sudo chmod 600 /var/backups/portal-backup.sql","find /srv/portal -perm -002"],
  'systems-administration-ii-b1-find-your-way-around': ['ls -la', 'mkdir -p projects/thesis', 'mv *.md projects/thesis', 'cp /etc/hostname notes/hostname.txt', 'rm -r old', 'find /var/log -name "*.log"'],
  'systems-administration-ii-b2-pipes-and-text': [
    'wc -l /var/log/portal/access.log',
    'mkdir report',
    "cut -d' ' -f1 /var/log/portal/access.log | sort | uniq -c | sort -rn > report/top-ips.txt",
    "grep ' 500 ' /var/log/portal/access.log > report/errors.txt",
    "grep -c ' 500 ' /var/log/portal/access.log > report/error-count.txt",
    "awk '{print $7}' /var/log/portal/access.log | sort | uniq -c | sort -rn | head -n 1 | awk '{print $2}' > report/top-page.txt",
  ],
  'systems-administration-ii-i1-users-groups-permissions': [
    'sudo groupadd finance',
    'sudo groupadd auditors',
    'sudo useradd -m -G finance kofi',
    'sudo useradd -m -G finance esi',
    'sudo passwd kofi',
    'sudo passwd esi',
    'sudo mkdir /srv/finance',
    'sudo chown root:finance /srv/finance',
    'sudo chmod 2770 /srv/finance',
    'sudo setfacl -m g:auditors:r-x /srv/finance',
    'su - kofi',
    'echo "Q4 budget" > /srv/finance/budget.txt',
    'ls -l /srv/finance',
    'exit',
  ],
  'systems-administration-ii-i2-backup-script-and-cron': [
    "cat > /usr/local/bin/backup.sh <<'EOF'\n#!/bin/bash\nset -euo pipefail\nmkdir -p /var/backups\nfile=\"/var/backups/www-$(date +%F).tar.gz\"\ntar -czf \"$file\" /srv/www\nfind /var/backups -name \"www-*.tar.gz\" -mtime +14 -delete\necho \"Backup written to $file\"\nEOF",
    'chmod +x /usr/local/bin/backup.sh',
    'backup.sh',
    'ls -l /var/backups',
    'echo "0 2 * * * /usr/local/bin/backup.sh" | crontab -',
    'crontab -l',
  ],
  'systems-administration-ii-a1-broken-web-server': [
    'systemctl status apache2',
    'journalctl -u apache2 -n 20',
    "sed -i 's/Listen 8o/Listen 80/' /etc/apache2/listen.conf",
    'apachectl configtest',
    'tar -xzf /var/backups/htdocs-2026-10-20.tar.gz -C /',
    'systemctl enable --now apache2',
    'curl http://localhost/',
    'firewall-cmd --permanent --add-service=http',
    'firewall-cmd --reload',
  ],
  'systems-administration-ii-a2-ssh-hardening': [
    'sudo grep "Failed password" /var/log/auth.log | wc -l',
    'ssh-keygen -t ed25519',
    'cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys',
    'chmod 700 ~/.ssh',
    'chmod 600 ~/.ssh/authorized_keys',
    'sudo sed -i "s/^PasswordAuthentication yes/PasswordAuthentication no/; s/^PermitRootLogin yes/PermitRootLogin no/" /etc/ssh/sshd_config',
    'sudo systemctl restart sshd',
    'systemctl is-active sshd',
  ],
  'operating-systems-b1-processes-and-signals': ['ps aux', 'kill 2457', 'sudo kill 2457', 'pgrep -f mine.py', 'echo "2457 kwame /usr/bin/python3 /home/kwame/mine.py" > ~/incident.txt'],
};

function allLabs(): LabSpec<ShellState>[] {
  const out: LabSpec<ShellState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<ShellState>;
      if (raw.engine === 'E4') out.push(raw);
    }
  }
  return out;
}

describe('E4 lab content', () => {
  const checks = createShellChecks();
  const labs = allLabs();
  it('finds the terminal labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(7);
  });
  for (const lab of labs) {
    describe(lab.id, () => {
      it('builds its machine, has a solution, and uses only sh.* checks', () => {
        expect(() => systemFromInitial(lab.initialState)).not.toThrow();
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('sh.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const sys = systemFromInitial(lab.initialState);
        const r = await checks.run(lab, { system: sys, history: [] });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference transcript', async () => {
        const sys = systemFromInitial(lab.initialState);
        const output = runLines(sys, SOLUTIONS[lab.id]);
        const r = await checks.run(lab, { system: sys, history: sys.history });
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}\n--- transcript ---\n${output}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
