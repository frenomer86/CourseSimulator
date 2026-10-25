/** Unit 5: log parsing and reporting. */

import type { Check, Variant } from '../types';
import type { TaskTemplate } from '../types';
import { addOu, addUser, csv, dc01, file, lab, linux, out, ps, psWrite, ran, script, secEvent, tmpl, windows, write, writeScript } from './kit';

const MKDIR = (...dirs: string[]) => `New-Item -ItemType Directory ${dirs.join(', ')} -Force | Out-Null`;
const two = (n: number) => String(n).padStart(2, '0');
/** Syslog time stamp: "Oct 22 08:05:09". */
const sysTime = (min: number, sec = 0) => `Oct 22 ${two(8 + Math.floor(min / 60))}:${two(min % 60)}:${two(sec)}`;
/** Documentation address ranges (RFC 5737) stand in for attackers. */
const outsider = (v: Variant) => `${v.pick(['203.0.113', '198.51.100', '192.0.2'])}.${v.int(2, 250)}`;

interface AuthEvent { min: number; sec: number; ok: boolean; user: string; ip: string; invalid?: boolean }
function authLines(events: AuthEvent[], host = 'srv1'): string {
  return [...events]
    .sort((a, b) => a.min * 60 + a.sec - (b.min * 60 + b.sec))
    .map((e, i) => `${sysTime(e.min, e.sec)} ${host} sshd[${2200 + i * 7}]: ${e.ok ? `Accepted password for ${e.user}` : `Failed password for ${e.invalid ? 'invalid user ' : ''}${e.user}`} from ${e.ip} port ${40000 + i * 13} ssh2`)
    .join('\n') + '\n';
}

/** A Python code lab (E1): starter code, checks and the reference solution. */
function py(o: { instructions: string; hints: string[]; starter: string; checks: Check[]; solution: string; realityNote: string }) {
  return { instructions: o.instructions, hints: o.hints, config: { language: 'python' }, initialState: { language: 'python', source: o.starter }, checks: [{ type: 'code.runs', label: 'The program runs' }, ...o.checks], solution: [o.solution], realityNote: o.realityNote };
}

export const U5: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 5.1 log formats */
  tmpl(5, 1, 'beginner', 'read-sshd-log', 'Read SSH entries in the system log', 'E4', 15, 'Find failed and successful SSH logins in /var/log/messages and answer questions from them.', (v) => {
    const net = v.net();
    const staff = v.people(3);
    const attacker = outsider(v);
    const targets = v.some(['admin', 'root', 'test', 'oracle', 'ubuntu', 'guest'], 3);
    const events: AuthEvent[] = [];
    staff.forEach((p, i) => events.push({ min: 5 + i * 11, sec: v.int(0, 59), ok: true, user: p.sam, ip: `${net}.${30 + i}` }));
    const fails = v.int(6, 12);
    for (let i = 0; i < fails; i++) events.push({ min: 20 + i, sec: v.int(0, 59), ok: false, user: targets[i % 3], ip: attacker, invalid: targets[i % 3] !== 'root' });
    events.push({ min: 50, sec: 3, ok: false, user: staff[1].sam, ip: `${net}.31` });
    const failed = fails + 1;
    return {
      instructions: lab({
        situation: `Someone reported that the server is under attack. On openSUSE, sshd writes to **/var/log/messages** (through the journal and rsyslog). Answer in **/root/ssh-answers.txt**, one per line:\n\n- \`Failed: <number of failed password attempts>\`\n- \`Accepted: <number of successful logins>\`\n- \`Attacker: <the outside address with the most failures>\`\n- \`Targeted: <the account names it tried, sorted, separated by commas>\``,
        steps: ['Look at the sshd lines: grep sshd /var/log/messages | less', 'Count with grep -c "Failed password" and grep -c "Accepted password".', 'Pull out the address after "from" with awk or grep -o.', 'The user name comes after "for", or after "invalid user".'],
        tips: ['grep -c "Failed password" /var/log/messages', "grep 'Failed password' /var/log/messages | grep -o 'from [0-9.]*' | sort | uniq -c", "grep 'Failed password' /var/log/messages | sed -E 's/.*for (invalid user )?([^ ]+) from.*/\\2/' | sort -u"],
      }),
      hints: ['"invalid user" means the account does not exist on this server: a sign of guessing.', 'The facility and severity are not in this file\'s lines; journalctl -o verbose shows them.'],
      initialState: linux(net, { files: { '/var/log/messages': `${sysTime(1)} srv1 systemd[1]: Started Daily Cleanup of Temporary Directories.\n` + authLines(events) + `${sysTime(59)} srv1 CRON[3301]: (root) CMD (/usr/local/bin/backup)\n` } }),
      checks: [
        file('The failure count is right', '/root/ssh-answers.txt', { contains: `Failed: ${failed}` }),
        file('The success count is right', '/root/ssh-answers.txt', { contains: `Accepted: ${staff.length}` }),
        file('The attacker is identified', '/root/ssh-answers.txt', { contains: `Attacker: ${attacker}` }),
        file('The targeted accounts are listed', '/root/ssh-answers.txt', { contains: `Targeted: ${[...targets].sort().join(',')}` }),
      ],
      solution: ['grep sshd /var/log/messages', `printf 'Failed: %s\\nAccepted: %s\\nAttacker: %s\\nTargeted: %s\\n' "$(grep -c 'Failed password' /var/log/messages)" "$(grep -c 'Accepted password' /var/log/messages)" "$(grep 'Failed password' /var/log/messages | grep -o 'from [0-9.]*' | sort | uniq -c | sort -rn | head -1 | awk '{print $3}')" "$(grep 'Failed password' /var/log/messages | grep -v '${net}\\.' | sed -E 's/.*for (invalid user )?([^ ]+) from.*/\\2/' | sort -u | paste -sd,)" > /root/ssh-answers.txt`, 'cat /root/ssh-answers.txt'],
      realityNote: 'Every Internet-facing SSH server sees this background noise within minutes; keys only, fail2ban and not exposing SSH at all are the usual answers.',
    };
  }),
  tmpl(5, 1, 'intermediate', 'access-log-status', 'Break down a web access log by status code', 'E4', 20, 'Use the combined log format\'s fields to count status classes and find the most-requested missing pages.', (v) => {
    const net = v.net();
    const pages = ['/', '/timetable', '/results', '/library/search', '/login', '/apply'];
    const missing = v.some(['/wp-login.php', '/old/fees.html', '/favicon.ico', '/admin/', '/results/2024.pdf'], 3);
    const lines: string[] = [];
    let n2 = 0, n3 = 0, n4 = 0, n5 = 0;
    const counts404: Record<string, number> = {};
    for (let i = 0; i < 40; i++) {
      const r = v.random();
      let page = v.pick(pages);
      let status = 200;
      if (r < 0.25) { page = missing[i % 3]; status = 404; }
      else if (r < 0.32) status = 302;
      else if (r < 0.38) status = 500;
      if (status === 404) counts404[page] = (counts404[page] ?? 0) + 1;
      if (status === 200) n2++; else if (status === 302) n3++; else if (status === 404) n4++; else n5++;
      lines.push(`${net}.${v.int(20, 99)} - - [22/Oct/2026:08:${two(10 + Math.floor(i / 2))}:${two(v.int(0, 59))} +0000] "GET ${page} HTTP/1.1" ${status} ${status === 302 ? 0 : v.int(300, 9000)} "-" "Mozilla/5.0"`);
    }
    const top404 = Object.entries(counts404).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      instructions: lab({
        situation: `In the combined log format, each line of **/var/log/apache2/access_log** is: client, ident, user, [time], "request", **status**, size, "referer", "user agent". Write **/root/status-report.txt** with these lines:\n\n- \`2xx <count>\`\n- \`3xx <count>\`\n- \`4xx <count>\`\n- \`5xx <count>\`\n- \`top404 <path> <count>\` (the most-requested missing page)`,
        steps: ['With the default field splitting, the status is $9 and the path is $7.', 'Group by the first digit of the status: substr($9, 1, 1) "xx".', 'Count 404 paths with an awk array or sort | uniq -c.'],
        tips: ["awk '{c[substr($9, 1, 1) \"xx\"]++} END {for (k in c) print k, c[k]}' /var/log/apache2/access_log | sort", "awk '$9 == 404 {print $7}' /var/log/apache2/access_log | sort | uniq -c | sort -rn | head -1"],
      }),
      hints: ['A class with no lines still needs a line with 0; print all four explicitly in END.', 'Field numbers count the quoted request as three fields: "GET, path and HTTP/1.1".'],
      initialState: linux(net, { packages: { apache2: { installed: true } }, files: { '/var/log/apache2/access_log': lines.join('\n') + '\n' } }),
      checks: [file('The counts per class and the top missing page are right', '/root/status-report.txt', { equals: [`2xx ${n2}`, `3xx ${n3}`, `4xx ${n4}`, `5xx ${n5}`, `top404 ${top404[0]} ${top404[1]}`].join('\n') })],
      solution: [`awk '{c[substr($9, 1, 1)]++} END {printf "2xx %d\\n3xx %d\\n4xx %d\\n5xx %d\\n", c[2], c[3], c[4], c[5]}' /var/log/apache2/access_log > /root/status-report.txt`, "awk '$9 == 404 {print $7}' /var/log/apache2/access_log | sort | uniq -c | sort -k1,1nr -k2,2 | head -1 | awk '{print \"top404\", $2, $1}' >> /root/status-report.txt", 'cat /root/status-report.txt'],
      realityNote: 'A rise in 5xx means the application is failing; a rise in 404s on odd paths (wp-login.php on a site without WordPress) usually means a scanner.',
    };
  }),
  tmpl(5, 1, 'advanced', 'security-log-events', 'Query the Windows Security log', 'E4', 25, 'Filter failed-logon events with Get-WinEvent and read their fields from the event XML.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const target = people[0];
    const ip = `${net}.${v.int(100, 200)}`;
    const n = v.int(5, 9);
    const others = people.slice(1).map((p) => ({ p, k: v.int(1, 2), ip: `${net}.${v.int(100, 200)}` }));
    return {
      instructions: lab({
        situation: `The service desk says **${target.sam}** keeps getting locked out. Event **4625** in the **Security** log records each failed logon; its details (TargetUserName, IpAddress, WorkstationName…) are in the event's XML, not in properties of the object.\n\nWrite **C:\\Scripts\\Get-FailedLogons.ps1** that outputs one object per 4625 event with **Time**, **Account** (TargetUserName) and **Address** (IpAddress), read from \`([xml]$event.ToXml()).Event.EventData.Data\`. Then export the result for **${target.sam}** only to **C:\\Reports\\failed-${target.sam}.csv** (Time, Account, Address; no #TYPE line).`,
        steps: ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 }", 'For each event: $x = [xml]$e.ToXml(); $d = $x.Event.EventData.Data', "Pick a field: ($d | Where-Object Name -eq 'TargetUserName').'#text'", 'Build [pscustomobject]@{ Time = $e.TimeCreated; Account = ...; Address = ... }'],
        tips: ["$events = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 }", "$d = ([xml]$e.ToXml()).Event.EventData.Data", "($d | Where-Object Name -eq 'IpAddress').'#text'"],
      }),
      hints: ['Message text is translated and formatted; the XML fields are stable, which is why scripts use them.', 'FilterHashtable filters on the server side and is far faster than Where-Object on all events.'],
      initialState: windows({ machines: [{ ...dc01(net), events: [...Array.from({ length: n }, (_, i) => secEvent(4625, `An account failed to log on.\n\nAccount Name: ${target.sam}`, { SubjectUserSid: 'S-1-0-0', TargetUserName: target.sam, TargetDomainName: 'CAMPUS', Status: '0xc000006d', WorkstationName: 'LAB-2-14', IpAddress: ip }, `10/22/2026 08:${two(5 + i * 3)}:00`)), ...others.flatMap((o, j) => Array.from({ length: o.k }, (_, i) => secEvent(4625, `An account failed to log on.\n\nAccount Name: ${o.p.sam}`, { SubjectUserSid: 'S-1-0-0', TargetUserName: o.p.sam, TargetDomainName: 'CAMPUS', Status: '0xc000006a', WorkstationName: 'OFF-PC0' + j, IpAddress: o.ip }, `10/22/2026 07:${two(10 + j * 10 + i)}:00`))), secEvent(4624, 'An account was successfully logged on.', { TargetUserName: target.sam, IpAddress: ip }, '10/22/2026 09:00:00')] } as never], ad: (st) => { const ou = addOu(st, 'Staff'); for (const p of people) addUser(st, p, ou); } }),
      checks: [
        ps('The script returns every failed logon with fields', '@(& C:\\Scripts\\Get-FailedLogons.ps1).Count', { equals: String(n + others.reduce((s, o) => s + o.k, 0)) }),
        ps('Account and Address come from the event data', `$r = & C:\\Scripts\\Get-FailedLogons.ps1 | Where-Object Account -eq '${others[0].p.sam}' | Select-Object -First 1; "$($r.Account) $($r.Address)"`, { equals: `${others[0].p.sam} ${others[0].ip}` }),
        ps(`The report has ${target.sam}'s failures only`, `$rows = Import-Csv C:\\Reports\\failed-${target.sam}.csv; "$(@($rows).Count) $(@($rows | Where-Object Account -ne '${target.sam}').Count) $(($rows | Select-Object -First 1).Address)"`, { equals: `${n} 0 ${ip}` }),
        ps('It reads the event XML', 'Get-Content C:\\Scripts\\Get-FailedLogons.ps1 -Raw', { contains: 'ToXml()' }),
      ],
      solution: [psWrite('C:\\Scripts\\Get-FailedLogons.ps1', "foreach ($e in Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 }) {\n    $d = ([xml]$e.ToXml()).Event.EventData.Data\n    [pscustomobject]@{\n        Time    = $e.TimeCreated\n        Account = ($d | Where-Object Name -eq 'TargetUserName').'#text'\n        Address = ($d | Where-Object Name -eq 'IpAddress').'#text'\n    }\n}"), MKDIR('C:\\Reports'), `& C:\\Scripts\\Get-FailedLogons.ps1 | Where-Object Account -eq '${target.sam}' | Export-Csv C:\\Reports\\failed-${target.sam}.csv -NoTypeInformation`],
      realityNote: 'The 4625 Status and SubStatus codes tell a bad password (0xc000006a) from an unknown user (0xc0000064); lockout investigations follow the IpAddress to the device holding old credentials.',
    };
  }),

  /* ---------------------------------------------------------------- 5.2 extracting fields */
  tmpl(5, 2, 'beginner', 'cron-runs-csv', 'Turn syslog lines into CSV with awk', 'E4', 15, 'Extract the time, user and command of every cron run into a CSV file.', (v) => {
    const net = v.net();
    const jobs = v.some(['/usr/local/bin/backup', '/usr/local/sbin/watchdog', '/usr/bin/updatedb', '/usr/local/bin/sync-results', '/usr/local/bin/report'], 3);
    const users = ['root', 'svc-jobs', 'root'];
    const runs: Array<{ t: string; u: string; c: string }> = [];
    for (let i = 0; i < 6; i++) runs.push({ t: sysTime(i * 9 + 2, 1).slice(7), u: users[i % 3], c: jobs[i % 3] });
    const noise = ['systemd[1]: Started Session 12 of User root.', 'kernel: [ 1201.441] e1000: eth0 NIC Link is Up', 'sshd[812]: Server listening on 0.0.0.0 port 22.'];
    const lines = runs.map((r, i) => `Oct 22 ${r.t} srv1 CRON[${3100 + i}]: (${r.u}) CMD (${r.c})`);
    const all = [...lines.slice(0, 2), `${sysTime(15)} srv1 ${noise[0]}`, ...lines.slice(2, 4), `${sysTime(33)} srv1 ${noise[1]}`, ...lines.slice(4), `${sysTime(58)} srv1 ${noise[2]}`];
    return {
      instructions: lab({
        situation: `Write every cron run found in **/var/log/messages** to **/root/cron-runs.csv** with the header \`time,user,command\` and one line per run, e.g. \`08:02:01,root,/usr/local/bin/backup\`. Cron lines look like:\n\n\`Oct 22 08:02:01 srv1 CRON[3100]: (root) CMD (/usr/local/bin/backup)\``,
        steps: ['Keep only cron lines: awk \'/CRON\\[/ {...}\' or grep first.', 'The time is field $3; the user is in $6 with brackets; the command follows "CMD (".', 'Strip the brackets with gsub or sub.'],
        tips: ["awk '/CRON\\[/ { u = $6; gsub(/[()]/, \"\", u); c = $0; sub(/.*CMD \\(/, \"\", c); sub(/\\)$/, \"\", c); print $3 \",\" u \",\" c }' /var/log/messages"],
      }),
      hints: ['sub replaces the first match, gsub every match.', 'Print the header with a BEGIN block.'],
      initialState: linux(net, { files: { '/var/log/messages': all.join('\n') + '\n' } }),
      checks: [file('Every cron run is in the CSV', '/root/cron-runs.csv', { equals: ['time,user,command', ...runs.map((r) => `${r.t},${r.u},${r.c}`)].join('\n') })],
      solution: ["awk 'BEGIN {print \"time,user,command\"} /CRON\\[/ { u = $6; gsub(/[()]/, \"\", u); c = $0; sub(/.*CMD \\(/, \"\", c); sub(/\\)$/, \"\", c); print $3 \",\" u \",\" c }' /var/log/messages > /root/cron-runs.csv", 'cat /root/cron-runs.csv'],
      realityNote: 'Turning free-text logs into CSV is the first step of any analysis; log shippers such as Fluent Bit and Logstash do the same with grok patterns.',
    };
  }),
  tmpl(5, 2, 'intermediate', 'iis-404-select-string', 'Extract fields with Select-String capture groups', 'E4', 25, 'Parse an IIS W3C log with a regular expression and named groups into objects.', (v) => {
    const net = v.net();
    const paths = ['/default.aspx', '/portal/login', '/results/view', '/library/catalogue'];
    const bad = v.some(['/wp-admin/', '/.env', '/backup.zip', '/old/index.php'], 2);
    const lines: string[] = [];
    const want: string[] = [];
    for (let i = 0; i < 18; i++) {
      const ip = i % 4 === 0 ? outsider(v) : `${net}.${v.int(20, 90)}`;
      const nf = i % 3 === 1;
      const p = nf ? bad[i % 2] : v.pick(paths);
      const t = `08:${two(10 + i)}:${two(v.int(0, 59))}`;
      lines.push(`2026-10-22 ${t} ${net}.15 GET ${p} - 443 - ${ip} Mozilla/5.0 - ${nf ? 404 : 200} 0 0 ${v.int(12, 900)}`);
      if (nf) want.push(`${t},${ip},${p}`);
    }
    const log = `#Software: Microsoft Internet Information Services 10.0\n#Version: 1.0\n#Date: 2026-10-22 08:00:00\n#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status sc-substatus sc-win32-status time-taken\n${lines.join('\n')}\n`;
    return {
      instructions: lab({
        situation: `**C:\\inetpub\\logs\\LogFiles\\W3SVC1\\u_ex261022.log** is an IIS log in W3C format (the #Fields line names the columns). Use **Select-String** with a regular expression with **named groups** to pick out every request that got a **404**, and export **C:\\Reports\\404s.csv** with the columns **Time, Client, Path** (no #TYPE line), in log order.`,
        steps: ['Write a pattern for a log line: date, time, server IP, method, path, ..., client IP, ..., status.', 'Name the parts you need: (?<time>\\S+), (?<path>\\S+) ...', '$_.Matches[0].Groups[\'path\'].Value gives a named group.', 'Keep only the 404s, build objects and export.'],
        tips: ["$re = '^\\S+ (?<time>\\S+) \\S+ \\S+ (?<path>\\S+) \\S+ \\S+ \\S+ (?<client>\\S+) \\S+ \\S+ (?<status>\\d{3}) '", 'Select-String -Path LOG -Pattern $re', "$_.Matches[0].Groups['status'].Value"],
      }),
      hints: ['Lines starting with # do not match the pattern, so they drop out by themselves.', 'Import-Csv -Delimiter " " also works for W3C logs once you supply the header; the regex way works for any log.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\inetpub\\logs\\LogFiles\\W3SVC1\\u_ex261022.log': log } }),
      checks: [
        ps('Every 404 is in the report, in order', "(Import-Csv C:\\Reports\\404s.csv | ForEach-Object { \"$($_.Time),$($_.Client),$($_.Path)\" }) -join ';'", { equals: want.join(';') }),
        ran('It uses Select-String', 'Select-String'),
      ],
      solution: [MKDIR('C:\\Reports'), "$re = '^\\S+ (?<time>\\S+) \\S+ \\S+ (?<path>\\S+) \\S+ \\S+ \\S+ (?<client>\\S+) \\S+ \\S+ (?<status>\\d{3}) '", "Select-String -Path C:\\inetpub\\logs\\LogFiles\\W3SVC1\\u_ex261022.log -Pattern $re | Where-Object { $_.Matches[0].Groups['status'].Value -eq '404' } | ForEach-Object { $g = $_.Matches[0].Groups; [pscustomobject]@{ Time = $g['time'].Value; Client = $g['client'].Value; Path = $g['path'].Value } } | Export-Csv C:\\Reports\\404s.csv -NoTypeInformation"],
      realityNote: 'Named groups make a regular expression readable months later; Log Parser and the IIS module of most SIEMs use the same field names as the #Fields line.',
    };
  }),
  tmpl(5, 2, 'advanced', 'winevent-time-window', 'Filter events by time and data on the server side', 'E4', 25, 'Use FilterHashtable with StartTime, EndTime and Data, and compare with filtering after the fact.', (v) => {
    const net = v.net();
    const people = v.people(3);
    const target = people[0];
    const inWindow = v.int(3, 6);
    const shift = v.pick([{ s: '13:00', e: '14:00', h: 13 }, { s: '10:00', e: '11:00', h: 10 }]);
    const evs = [
      ...Array.from({ length: inWindow }, (_, i) => secEvent(4740, `A user account was locked out.\n\nAccount Name: ${target.sam}`, { TargetUserName: target.sam, TargetDomainName: 'CAMPUS', SubjectUserName: 'DC01$' }, `10/22/2026 ${two(shift.h)}:${two(5 + i * 9)}:00`)),
      ...Array.from({ length: 3 }, (_, i) => secEvent(4740, `A user account was locked out.\n\nAccount Name: ${target.sam}`, { TargetUserName: target.sam, TargetDomainName: 'CAMPUS', SubjectUserName: 'DC01$' }, `10/22/2026 0${7 + i}:30:00`)),
      ...people.slice(1).map((p, i) => secEvent(4740, `A user account was locked out.\n\nAccount Name: ${p.sam}`, { TargetUserName: p.sam, TargetDomainName: 'CAMPUS', SubjectUserName: 'DC01$' }, `10/22/2026 ${two(shift.h)}:${two(20 + i)}:00`)),
    ];
    return {
      instructions: lab({
        situation: `How many times was **${target.sam}** locked out (event **4740**) between **${shift.s} and ${shift.e}** today? Get the answer with **one Get-WinEvent call** whose FilterHashtable has **LogName, Id, StartTime, EndTime and Data** (Data matches any field of the event data, here the account name), and write the number to **C:\\Reports\\lockouts.txt**.`,
        steps: ["$start = Get-Date '2026-10-22 " + shift.s + "'", 'Add EndTime the same way.', `Data = '${target.sam}' matches the TargetUserName field.`, 'Count with @(...).Count and Set-Content.'],
        tips: [`Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4740; StartTime = $start; EndTime = $end; Data = '${target.sam}' }`],
      }),
      hints: ['A FilterHashtable is turned into a query the event log service runs; Where-Object would first fetch every event.', 'When nothing matches, Get-WinEvent throws "No events were found"; @() and -ErrorAction SilentlyContinue make that 0.'],
      initialState: windows({ machines: [{ ...dc01(net), events: evs } as never] }),
      checks: [
        ps('The count is right', 'Get-Content C:\\Reports\\lockouts.txt', { equals: String(inWindow) }),
        ran('One filtered Get-WinEvent call was used', 'Get-WinEvent[^\\n]*StartTime[^\\n]*EndTime|Get-WinEvent[^\\n]*EndTime[^\\n]*StartTime', 'Put StartTime and EndTime in the FilterHashtable itself.'),
      ],
      solution: [MKDIR('C:\\Reports'), `$start = Get-Date '2026-10-22 ${shift.s}'`, `$end = Get-Date '2026-10-22 ${shift.e}'`, `@(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4740; StartTime = $start; EndTime = $end; Data = '${target.sam}' }).Count | Set-Content C:\\Reports\\lockouts.txt`, 'Get-Content C:\\Reports\\lockouts.txt'],
      realityNote: 'On a busy domain controller the Security log holds millions of events; server-side filters are the difference between seconds and minutes.',
    };
  }),

  /* ---------------------------------------------------------------- 5.3 aggregation */
  tmpl(5, 3, 'beginner', 'errors-per-hour', 'Count errors per hour', 'E4', 15, 'Aggregate application log errors by hour with cut, sort and uniq.', (v) => {
    const net = v.net();
    const app = v.pick(['payroll', 'portal', 'moodle-sync']);
    const lines: string[] = [];
    const per: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const h = 8 + Math.floor(i / 6) + (v.random() < 0.2 ? 1 : 0);
      const lvl = v.random() < 0.4 ? 'ERROR' : v.pick(['INFO', 'INFO', 'WARN']);
      const t = `2026-10-22T${two(h)}:${two(v.int(0, 59))}:${two(v.int(0, 59))}`;
      if (lvl === 'ERROR') per[two(h)] = (per[two(h)] ?? 0) + 1;
      lines.push(`${t} ${lvl} ${app}: ${lvl === 'ERROR' ? v.pick(['database timeout', 'upstream returned 502', 'file not found: /srv/in/today.csv']) : 'request handled'}`);
    }
    lines.sort();
    return {
      instructions: lab({
        situation: `**/var/log/${app}.log** has lines like \`2026-10-22T08:14:02 ERROR ${app}: database timeout\`. Write **/root/errors-by-hour.txt** with one line per hour that had errors, as \`HH COUNT\` (for example \`09 4\`), in hour order.`,
        steps: ['Keep the ERROR lines.', 'Cut out the hour: characters 12-13 of each line.', 'sort | uniq -c, then swap the columns with awk.'],
        tips: [`grep ' ERROR ' /var/log/${app}.log | cut -c12-13 | sort | uniq -c`, "awk '{print $2, $1}'"],
      }),
      hints: ['ISO time stamps sort correctly as text, which is one reason to prefer them.', 'uniq -c puts the count first.'],
      initialState: linux(net, { files: { [`/var/log/${app}.log`]: lines.join('\n') + '\n' } }),
      checks: [file('The counts per hour are right', '/root/errors-by-hour.txt', { equals: Object.keys(per).sort().map((h) => `${h} ${per[h]}`).join('\n') })],
      solution: [`grep ' ERROR ' /var/log/${app}.log | cut -c12-13 | sort | uniq -c | awk '{print $2, $1}' > /root/errors-by-hour.txt`, 'cat /root/errors-by-hour.txt'],
      realityNote: 'Errors per time bucket is the shape of every monitoring graph; a step change at one hour points at a deployment, a cron job or an outage upstream.',
    };
  }),
  tmpl(5, 3, 'intermediate', 'failures-per-user-and-ip', 'Count failed logins per account and address', 'E4', 20, 'Aggregate SSH failures by the pair (user, address) and sort by count.', (v) => {
    const net = v.net();
    const staff = v.people(3);
    const pairs: Array<{ user: string; ip: string; k: number }> = [
      { user: 'root', ip: outsider(v), k: v.int(7, 12) },
      { user: 'admin', ip: outsider(v), k: v.int(3, 6) },
      { user: staff[0].sam, ip: `${net}.${v.int(30, 60)}`, k: 2 },
      { user: staff[1].sam, ip: `${net}.${v.int(61, 90)}`, k: 1 },
    ];
    pairs[1].k = Math.min(pairs[1].k, pairs[0].k - 1);
    const events: AuthEvent[] = [];
    let m = 0;
    for (const p of pairs) for (let i = 0; i < p.k; i++) events.push({ min: (m += v.int(0, 2)), sec: v.int(0, 59), ok: false, user: p.user, ip: p.ip, invalid: p.user === 'admin' });
    staff.forEach((s, i) => events.push({ min: 40 + i, sec: 1, ok: true, user: s.sam, ip: `${net}.${30 + i}` }));
    const sorted = [...pairs].sort((a, b) => b.k - a.k || a.user.localeCompare(b.user));
    return {
      instructions: lab({
        situation: `From the sshd lines in **/var/log/messages**, write **/root/failures.csv** with the header \`count,user,address\` and one line per (user, address) pair that had failed passwords, **most failures first** (ties by user name). "invalid user X" counts as user X.`,
        steps: ['Keep "Failed password" lines.', 'Normalise "for invalid user X" to "for X" with sed.', 'Print "user address", then sort | uniq -c | sort -k1,1nr -k2,2.', 'Turn the spaces into commas.'],
        tips: ["grep 'Failed password' /var/log/messages | sed -E 's/.*for (invalid user )?([^ ]+) from ([^ ]+).*/\\2 \\3/'", "sort | uniq -c | sort -k1,1nr -k2,2 | awk '{print $1 \",\" $2 \",\" $3}'"],
      }),
      hints: ['The (invalid user )? group is optional, so one expression handles both line shapes.', 'Sort numerically on the count first, then by name: two -k options.'],
      initialState: linux(net, { files: { '/var/log/messages': authLines(events) } }),
      checks: [file('The pairs and counts are right and sorted', '/root/failures.csv', { equals: ['count,user,address', ...sorted.map((p) => `${p.k},${p.user},${p.ip}`)].join('\n') })],
      solution: ["{ echo count,user,address; grep 'Failed password' /var/log/messages | sed -E 's/.*for (invalid user )?([^ ]+) from ([^ ]+).*/\\2 \\3/' | sort | uniq -c | sort -k1,1nr -k2,2 | awk '{print $1 \",\" $2 \",\" $3}'; } > /root/failures.csv", 'cat /root/failures.csv'],
      realityNote: 'Many failures for one account from many addresses is password spraying; many accounts from one address is brute forcing; the pair view shows which.',
    };
  }),
  tmpl(5, 3, 'advanced', 'bytes-per-client', 'Summarise traffic per client with PowerShell', 'E4', 25, 'Group web log objects by client and compute requests, total and average bytes, with calculated properties.', (v) => {
    const net = v.net();
    const clients = Array.from({ length: 4 }, (_, i) => `${net}.${20 + i * 15}`);
    const rows: Array<[string, string, number, number]> = [];
    for (let i = 0; i < 20; i++) {
      const c = clients[v.int(0, 3)];
      rows.push([`2026-10-22T08:${two(i * 2)}:00`, c, v.pick([200, 200, 200, 404]), v.int(1, 400) * 1024]);
    }
    const g = clients.map((c) => ({ c, r: rows.filter((x) => x[1] === c) })).filter((x) => x.r.length).map((x) => ({ c: x.c, n: x.r.length, mb: Math.round((x.r.reduce((s, r) => s + r[3], 0) / 1048576) * 100) / 100 })).sort((a, b) => b.mb - a.mb);
    return {
      instructions: lab({
        situation: `**C:\\Logs\\proxy.csv** has Time, Client, Status and Bytes for each request through the campus proxy. Write **C:\\Reports\\traffic.csv** with one row per client: **Client, Requests, MB** where MB is the total bytes divided by 1MB, rounded to 2 decimals, **largest MB first**, no #TYPE line.`,
        steps: ['Import-Csv and Group-Object Client.', 'Requests is $_.Count; total bytes with ($_.Group | Measure-Object Bytes -Sum).Sum.', 'Divide by 1MB (PowerShell knows the unit) and [math]::Round(..., 2).', 'Sort-Object MB -Descending, export.'],
        tips: ["Import-Csv C:\\Logs\\proxy.csv | Group-Object Client | Select-Object @{n='Client';e={$_.Name}}, @{n='Requests';e={$_.Count}}, @{n='MB';e={ [math]::Round(($_.Group | Measure-Object Bytes -Sum).Sum / 1MB, 2) }}"],
      }),
      hints: ['1MB in PowerShell is 1048576 (binary megabyte).', 'Sort before Export-Csv: the CSV keeps whatever order it receives.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Logs\\proxy.csv': csv('Time,Client,Status,Bytes', rows) } }),
      checks: [ps('One row per client, largest first, with the right totals', "(Import-Csv C:\\Reports\\traffic.csv | ForEach-Object { \"$($_.Client)=$($_.Requests)/$($_.MB)\" }) -join ';'", { equals: g.map((x) => `${x.c}=${x.n}/${x.mb}`).join(';') })],
      solution: [MKDIR('C:\\Reports'), "Import-Csv C:\\Logs\\proxy.csv | Group-Object Client | Select-Object @{n='Client';e={$_.Name}}, @{n='Requests';e={$_.Count}}, @{n='MB';e={ [math]::Round(($_.Group | Measure-Object Bytes -Sum).Sum / 1MB, 2) }} | Sort-Object MB -Descending | Export-Csv C:\\Reports\\traffic.csv -NoTypeInformation", 'Import-Csv C:\\Reports\\traffic.csv'],
      realityNote: 'Per-client totals find the one machine saturating a school\'s Internet link, often an update storm or a misconfigured backup.',
    };
  }),

  /* ---------------------------------------------------------------- 5.4 brute-force thresholds and time windows (detection) */
  tmpl(5, 4, 'beginner', 'threshold-suspects', 'Flag addresses over a failure threshold', 'E4', 15, 'List the addresses whose failed SSH logins reach a threshold, excluding the trusted network.', (v) => {
    const net = v.net();
    const th = v.pick([5, 8, 10]);
    const bad = [outsider(v), outsider(v)];
    const near = outsider(v);
    const events: AuthEvent[] = [];
    let m = 0;
    bad.forEach((ip, j) => { for (let i = 0; i < th + j * 3; i++) events.push({ min: (m += 1), sec: i, ok: false, user: v.pick(['root', 'admin', 'test']), ip, invalid: true }); });
    for (let i = 0; i < th - 1; i++) events.push({ min: (m += 1), sec: 5, ok: false, user: 'oracle', ip: near, invalid: true });
    for (let i = 0; i < th + 2; i++) events.push({ min: (m += 1) % 59, sec: 9, ok: false, user: 'kofi', ip: `${net}.44` });
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/ssh-suspects [THRESHOLD]** (default **${th}**) that prints, one per line and sorted, every address with **at least THRESHOLD** failed SSH passwords in /var/log/messages. Addresses in the campus network **${net}.0/24** are never listed (they are users mistyping, handled by the helpdesk). Save today's list to **/root/suspects.txt**.`,
        steps: ["Extract the addresses of failures: grep 'Failed password' ... | grep -o 'from [0-9.]*' | awk '{print $2}'", 'sort | uniq -c, then awk -v t="$th" \'$1 >= t {print $2}\'', `Drop the campus network with grep -v '^${net.replace(/\./g, '\\.')}\\.'`],
        tips: ['th=${1:-' + th + '}', "awk -v t=\"$th\" '$1 >= t {print $2}'", 'ssh-suspects > /root/suspects.txt'],
      }),
      hints: ['Escape the dots in the network prefix, or "10.1.2" also matches "10.112".', 'A threshold alone misses slow attacks; the next lab adds a time window.'],
      initialState: linux(net, { files: { '/var/log/messages': authLines(events) } }),
      checks: [
        file('Today\'s suspects are listed', '/root/suspects.txt', { equals: [...bad].sort().join('\n') }),
        script('The threshold is a parameter', '/usr/local/sbin/ssh-suspects', { args: [String(th - 1)], equals: [...bad, near].sort().join('\n') }),
        script('The campus network is never listed', '/usr/local/sbin/ssh-suspects', { args: ['1'], notContains: `${net}.44` }),
      ],
      solution: [writeScript('/usr/local/sbin/ssh-suspects', `th=\${1:-${th}}\ngrep 'Failed password' /var/log/messages | grep -o 'from [0-9.]*' | awk '{print $2}' | grep -v '^${net.replace(/\./g, '\\.')}\\.' | sort | uniq -c | awk -v t="$th" '$1 >= t {print $2}' | sort\n`), 'ssh-suspects > /root/suspects.txt', 'cat /root/suspects.txt'],
      realityNote: 'fail2ban and sshguard implement exactly this rule; tune the threshold so a person mistyping is never blocked but a script is.',
    };
  }),
  tmpl(5, 4, 'intermediate', 'sliding-window', 'Detect bursts in a time window', 'E4', 30, 'Flag accounts with N failed logons inside any 10-minute window using sorted times in PowerShell.', (v) => {
    const net = v.net();
    const n = v.pick([4, 5]);
    const people = v.people(4);
    const burst = people[0];
    const slow = people[1];
    const evs = [
      ...Array.from({ length: n }, (_, i) => secEvent(4625, 'An account failed to log on.', { TargetUserName: burst.sam, IpAddress: outsider(v) }, `10/22/2026 08:${two(20 + i * 2)}:00`)),
      ...Array.from({ length: n + 2 }, (_, i) => secEvent(4625, 'An account failed to log on.', { TargetUserName: slow.sam, IpAddress: `${net}.40` }, `10/22/2026 ${two(8 + i)}:05:00`)),
      ...Array.from({ length: n - 1 }, (_, i) => secEvent(4625, 'An account failed to log on.', { TargetUserName: people[2].sam, IpAddress: `${net}.41` }, `10/22/2026 09:${two(30 + i)}:00`)),
    ];
    return {
      instructions: lab({
        situation: `A plain count flags **${slow.sam}**, who mistypes a password every hour or so, but misses the real pattern: many failures **close together**. Write **C:\\Scripts\\Find-Bursts.ps1 [-Count ${n}] [-Minutes 10]** that, for each account in the 4625 events, sorts its failure times and reports the account if **any ${n} consecutive failures fall within 10 minutes**. Output the account names, sorted, one per line.`,
        steps: ['Collect (Account, Time) pairs from the events (the event XML, or the TargetUserName property).', 'Group-Object Account; sort each group\'s times.', 'For i from 0 to Count-N: if times[i+N-1] - times[i] <= window, it is a burst.', 'Output the account once and stop checking it.'],
        tips: ["$fails = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } | ForEach-Object { $d = ([xml]$_.ToXml()).Event.EventData.Data; [pscustomobject]@{ Account = ($d | Where-Object Name -eq 'TargetUserName').'#text'; Time = $_.TimeCreated } }", '$t = @($g.Group | Sort-Object Time).Time', 'if (($t[$i + $Count - 1] - $t[$i]).TotalMinutes -le $Minutes) { ... }'],
      }),
      hints: ['Subtracting two dates gives a TimeSpan; .TotalMinutes is a number.', 'A window check on sorted times is O(n) per account: no need to compare every pair.'],
      initialState: windows({ machines: [{ ...dc01(net), events: evs } as never] }),
      checks: [
        ps('Only the burst is reported', '& C:\\Scripts\\Find-Bursts.ps1', { equals: burst.sam }),
        ps('A larger window also catches the slow pattern', '(& C:\\Scripts\\Find-Bursts.ps1 -Minutes 600) -join \',\'', { equals: [burst.sam, slow.sam].sort().join(',') }),
        ps('A lower count catches near-bursts', '(& C:\\Scripts\\Find-Bursts.ps1 -Count ' + (n - 1) + ') -join \',\'', { equals: [burst.sam, people[2].sam].sort().join(',') }),
      ],
      solution: [psWrite('C:\\Scripts\\Find-Bursts.ps1', `param([int]$Count = ${n}, [int]$Minutes = 10)\n$fails = Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4625 } | ForEach-Object {\n    $d = ([xml]$_.ToXml()).Event.EventData.Data\n    [pscustomobject]@{ Account = ($d | Where-Object Name -eq 'TargetUserName').'#text'; Time = $_.TimeCreated }\n}\n$hits = foreach ($g in $fails | Group-Object Account) {\n    $t = @($g.Group | Sort-Object Time | ForEach-Object Time)\n    for ($i = 0; $i -le $t.Count - $Count; $i++) {\n        if (($t[$i + $Count - 1] - $t[$i]).TotalMinutes -le $Minutes) { $g.Name; break }\n    }\n}\n$hits | Sort-Object`), '& C:\\Scripts\\Find-Bursts.ps1'],
      realityNote: 'SIEM correlation rules ("5 failures in 10 minutes") and the Windows account lockout policy (threshold within an observation window) both use this sliding-window idea.',
    };
  }),
  tmpl(5, 4, 'advanced', 'block-offenders', 'Block brute-force sources with the firewall', 'E4', 30, 'Detect offending addresses and add firewalld rich rules to drop them, never blocking the admin network.', (v) => {
    const net = v.net();
    const admin = v.net();
    const th = v.pick([6, 8]);
    const bad = [outsider(v), outsider(v)];
    const events: AuthEvent[] = [];
    let m = 0;
    bad.forEach((ip) => { for (let i = 0; i < th + 2; i++) events.push({ min: (m += 1), sec: i, ok: false, user: 'root', ip }); });
    for (let i = 0; i < th + 5; i++) events.push({ min: (m += 1) % 59, sec: 7, ok: false, user: 'root', ip: `${admin}.10` });
    for (let i = 0; i < 2; i++) events.push({ min: 55 + i, sec: 1, ok: false, user: 'admin', ip: outsider(v), invalid: true });
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/block-bruteforce** that finds addresses with at least **${th}** failed SSH passwords in /var/log/messages and, for each one not already blocked, adds a **permanent** firewalld rich rule that **drops** all traffic from it, then reloads firewalld. Addresses in the admin network **${admin}.0/24** must **never** be blocked, even with many failures (a locked-out administrator is a worse outage). Each block is logged with \`logger -t block-bruteforce "blocked <ip>"\`. Run it.`,
        steps: ['Reuse the counting pipeline from the previous lab.', `Skip the admin network: [[ $ip == ${admin}.* ]] && continue`, "firewall-cmd --permanent --add-rich-rule=\"rule family='ipv4' source address='$ip' drop\"", 'firewall-cmd --reload once at the end; check with --list-rich-rules.'],
        tips: ["firewall-cmd --permanent --add-rich-rule=\"rule family='ipv4' source address='IP' drop\"", 'firewall-cmd --list-rich-rules', 'firewall-cmd --reload'],
      }),
      hints: ['Check firewall-cmd --list-rich-rules before adding, so re-runs do not add duplicates.', 'A permanent rule survives reboots; without --reload it is not active yet.'],
      initialState: linux(net, { files: { '/var/log/messages': authLines(events) } }),
      checks: [
        out('Both offenders are blocked', 'firewall-cmd --list-rich-rules', { contains: bad.map((ip) => `source address="${ip}" drop`) }),
        out('The admin network is never blocked', 'firewall-cmd --list-rich-rules', { notContains: admin }),
        out('Low-count addresses are not blocked', 'firewall-cmd --list-rich-rules | wc -l', { equals: '2' }),
        out('A second run adds no duplicates', '/usr/local/sbin/block-bruteforce >/dev/null; firewall-cmd --list-rich-rules | wc -l', { equals: '2' }),
        out('Each block is logged', 'grep block-bruteforce /var/log/messages', { contains: bad.map((ip) => `blocked ${ip}`) }),
      ],
      solution: [writeScript('/usr/local/sbin/block-bruteforce', `for ip in $(grep 'Failed password' /var/log/messages | grep -o 'from [0-9.]*' | awk '{print $2}' | sort | uniq -c | awk '$1 >= ${th} {print $2}'); do\n  [[ $ip == ${admin}.* ]] && continue\n  firewall-cmd --list-rich-rules | grep -q "address=\\"$ip\\"" && continue\n  firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='$ip' drop" >/dev/null\n  logger -t block-bruteforce "blocked $ip"\ndone\nfirewall-cmd --reload >/dev/null\n`), 'block-bruteforce', 'firewall-cmd --list-rich-rules'],
      realityNote: 'This is what fail2ban automates, with ban times and unbanning; an allow-list for management networks is part of every sensible deployment.',
    };
  }),

  /* ---------------------------------------------------------------- 5.5 reports and log rotation */
  tmpl(5, 5, 'beginner', 'json-health-report', 'Write a health report as JSON', 'E4', 15, 'Collect a few facts into an ordered object and save it with ConvertTo-Json for another tool to read.', (v) => {
    const net = v.net();
    const svcs = v.some(['Spooler', 'W32Time', 'WinRM', 'LanmanServer', 'DNS'], 3).sort();
    return {
      instructions: lab({
        situation: `A dashboard reads **C:\\Reports\\health.json**. Write it with one object containing:\n\n- \`Computer\`: the computer name\n- \`FreeGB\`: free space on C: in GB, rounded to 1 decimal\n- \`Services\`: an array of objects with \`Name\` and \`Status\` for ${svcs.join(', ')}\n- \`Generated\`: the date and time as yyyy-MM-ddTHH:mm:ss\n\nUse an **[ordered]** hashtable so the keys keep this order, and **-Depth 3** so the services are not flattened.`,
        steps: ['Build the service list with Get-Service -Name ... | Select-Object Name, @{n=\'Status\';e={"$($_.Status)"}}', '[ordered]@{ Computer = $env:COMPUTERNAME; ... }', 'ConvertTo-Json -Depth 3 | Set-Content C:\\Reports\\health.json', 'Read it back with Get-Content -Raw | ConvertFrom-Json.'],
        tips: ["[math]::Round((Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").FreeSpace / 1GB, 1)", 'Get-Date -Format s'],
      }),
      hints: ['ConvertTo-Json stops at depth 2 by default and turns deeper objects into strings.', 'Status as a string ("Running") is easier for other tools than the enum number.'],
      initialState: windows({ machines: [dc01(net, { services: { Spooler: { status: 'Running', start: 'Automatic' }, W32Time: { status: 'Running', start: 'Automatic' }, WinRM: { status: 'Running', start: 'Automatic' }, LanmanServer: { status: 'Running', start: 'Automatic' }, DNS: { status: 'Stopped', start: 'Automatic' }, Netlogon: { status: 'Running', start: 'Automatic' }, NTDS: { status: 'Running', start: 'Automatic' }, Kdc: { status: 'Running', start: 'Automatic' } } } as never)] }),
      checks: [
        ps('The JSON has the right fields in order', "((Get-Content C:\\Reports\\health.json -Raw | ConvertFrom-Json).PSObject.Properties.Name) -join ','", { equals: 'Computer,FreeGB,Services,Generated' }),
        ps('The services are objects with their status', "$j = Get-Content C:\\Reports\\health.json -Raw | ConvertFrom-Json; ($j.Services | ForEach-Object { \"$($_.Name)=$($_.Status)\" }) -join ','", { equals: svcs.map((s) => `${s}=${s === 'DNS' ? 'Stopped' : 'Running'}`).join(',') }),
        ps('The free space is right', "(Get-Content C:\\Reports\\health.json -Raw | ConvertFrom-Json).FreeGB -eq [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").FreeSpace / 1GB, 1)", { equals: 'True' }),
        ps('The time stamp is ISO formatted', '(Get-Content C:\\Reports\\health.json -Raw | ConvertFrom-Json).Generated', { pattern: '^2026-10-22T\\d{2}:\\d{2}:\\d{2}$' }),
      ],
      solution: [MKDIR('C:\\Reports'), `$svc = Get-Service -Name ${svcs.join(', ')} | Select-Object Name, @{n='Status';e={"$($_.Status)"}}`, "[ordered]@{ Computer = $env:COMPUTERNAME; FreeGB = [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\").FreeSpace / 1GB, 1); Services = @($svc); Generated = Get-Date -Format s } | ConvertTo-Json -Depth 3 | Set-Content C:\\Reports\\health.json", 'Get-Content C:\\Reports\\health.json'],
      realityNote: 'JSON is the lingua franca between scripts, dashboards and APIs; agreeing on field names and ISO dates is most of the work.',
    };
  }),
  tmpl(5, 5, 'intermediate', 'html-report', 'Publish an HTML report', 'E4', 20, 'Build an HTML page from objects with ConvertTo-Html, a title, a heading and a styled table.', (v) => {
    const net = v.net();
    const people = v.people(5);
    const counts = v.some([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 17], people.length);
    const rows = people.map((p, i) => ({ sam: p.sam, fails: counts[i] })).sort((a, b) => b.fails - a.fails);
    const site = v.pick(['Main Campus', 'City Campus', 'Annex']);
    return {
      instructions: lab({
        situation: `Managers do not read CSV. Turn **C:\\Reports\\failures.csv** (Account, Failures) into **C:\\inetpub\\wwwroot\\reports\\failures.html** with:\n\n- the page title \`Failed logons - ${site}\`;\n- a heading \`<h1>Failed logons - ${site}</h1>\` above the table;\n- a table of Account and Failures, most failures first;\n- a small style sheet in the head (\`-Head\`) so the table has borders.`,
        steps: ['Import-Csv, convert Failures to a number for sorting: Sort-Object { [int]$_.Failures } -Descending', 'ConvertTo-Html -Title ... -PreContent ... -Head ...', 'Out-File the result; open the page in a browser to check.'],
        tips: ["$css = '<style>table { border-collapse: collapse } td, th { border: 1px solid #999; padding: 4px }</style>'", `ConvertTo-Html -Property Account, Failures -Title 'Failed logons - ${site}' -PreContent '<h1>Failed logons - ${site}</h1>' -Head $css`],
      }),
      hints: ['CSV values are text: "9" sorts after "12" unless you convert.', '-Head replaces the default head, so put the <title> in it yourself when you use both.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Reports\\failures.csv': csv('Account,Failures', v.some(rows, rows.length).map((r) => [r.sam, r.fails])), 'C:\\inetpub\\wwwroot\\iisstart.htm': '<html></html>\n' } }),
      checks: [
        ps('The page has the title and heading', 'Get-Content C:\\inetpub\\wwwroot\\reports\\failures.html -Raw', { contains: [`<title>Failed logons - ${site}</title>`, `<h1>Failed logons - ${site}</h1>`] }),
        ps('The rows are sorted by failures', "(Select-String -Path C:\\inetpub\\wwwroot\\reports\\failures.html -Pattern '<tr><td>([^<]+)</td>' -AllMatches | ForEach-Object { $_.Matches[0].Groups[1].Value }) -join ','", { equals: [...rows].sort((a, b) => b.fails - a.fails || 0).map((r) => r.sam).join(',') }),
        ps('There is a style sheet', 'Get-Content C:\\inetpub\\wwwroot\\reports\\failures.html -Raw', { contains: '<style>' }),
      ],
      solution: [MKDIR('C:\\inetpub\\wwwroot\\reports'), `$css = "<title>Failed logons - ${site}</title><style>table { border-collapse: collapse } td, th { border: 1px solid #999; padding: 4px }</style>"`, `Import-Csv C:\\Reports\\failures.csv | Sort-Object { [int]$_.Failures } -Descending | ConvertTo-Html -Property Account, Failures -Head $css -PreContent '<h1>Failed logons - ${site}</h1>' | Out-File C:\\inetpub\\wwwroot\\reports\\failures.html`, 'Get-Content C:\\inetpub\\wwwroot\\reports\\failures.html'],
      realityNote: 'A scheduled script that publishes an HTML page is the simplest dashboard there is, and still common for daily operations reports.',
    };
  }),
  tmpl(5, 5, 'advanced', 'logrotate-app', 'Rotate an application log with logrotate', 'E4', 25, 'Write a logrotate rule with compression, retention, permissions and a post-rotate reload, and force a test rotation.', (v) => {
    const net = v.net();
    const app = v.pick(['fees-api', 'portal', 'results-sync']);
    const keep = v.pick([7, 14, 30]);
    const owner = `svc-${app.split('-')[0]}`;
    return {
      instructions: lab({
        situation: `**/var/log/${app}/${app}.log** grows forever. Create **/etc/logrotate.d/${app}** so that it is rotated **daily**, **${keep}** old copies are kept, old copies are **compressed** (but the newest rotated copy only on the next run: delaycompress), a missing or empty log is not an error / not rotated, the new log is created as mode **0640** owned by **${owner}:${owner}**, and after rotating, the command \`systemctl reload ${app}\` runs **once** (sharedscripts). Then test with \`logrotate -d\` and force one rotation with \`logrotate -f\`.`,
        steps: ['Write the block: path { options ... postrotate ... endscript }', 'logrotate -d /etc/logrotate.d/' + app + ' (dry run, prints what it would do)', 'logrotate -f /etc/logrotate.d/' + app, `ls -l /var/log/${app}/`],
        tips: [`/var/log/${app}/*.log {\n    daily\n    rotate ${keep}\n    compress\n    delaycompress\n    missingok\n    notifempty\n    create 0640 ${owner} ${owner}\n    sharedscripts\n    postrotate\n        systemctl reload ${app} >/dev/null 2>&1 || true\n    endscript\n}`],
      }),
      hints: ['delaycompress leaves app.log.1 uncompressed, because the program may still be writing to it until the reload.', 'The default configuration in /etc/logrotate.conf includes /etc/logrotate.d.'],
      initialState: linux(net, { users: { [owner]: { shell: '/usr/sbin/nologin' } }, files: { [`/var/log/${app}/${app}.log`]: { content: Array.from({ length: 40 }, (_, i) => `2026-10-22T08:${two(i)}:00 INFO request ${i}`).join('\n') + '\n', owner, group: owner, mode: '640' } as never } }),
      checks: [
        file('The rule has the rotation options', `/etc/logrotate.d/${app}`, { contains: ['daily', `rotate ${keep}`, 'compress', 'delaycompress', 'missingok', 'notifempty', `create 0640 ${owner} ${owner}`, 'sharedscripts', 'postrotate', 'endscript'] }),
        file('The reload runs after rotation', `/etc/logrotate.d/${app}`, { pattern: `postrotate[\\s\\S]*systemctl reload ${app}[\\s\\S]*endscript` }),
        out('A forced rotation produced app.log.1 and a fresh log', `ls /var/log/${app}`, { contains: [`${app}.log.1`, `${app}.log`] }),
        file('The new log has the right owner and mode', `/var/log/${app}/${app}.log`, { owner, group: owner, mode: '640' }),
        out('The rotated copy holds the old lines', `wc -l < /var/log/${app}/${app}.log.1`, { equals: '40' }),
      ],
      solution: [write(`/etc/logrotate.d/${app}`, `/var/log/${app}/*.log {\n    daily\n    rotate ${keep}\n    compress\n    delaycompress\n    missingok\n    notifempty\n    create 0640 ${owner} ${owner}\n    sharedscripts\n    postrotate\n        systemctl reload ${app} >/dev/null 2>&1 || true\n    endscript\n}\n`), `logrotate -d /etc/logrotate.d/${app}`, `logrotate -f /etc/logrotate.d/${app}`, `ls -l /var/log/${app}`],
      realityNote: 'Full disks from unrotated logs are one of the most common outages; every package that logs to files should ship a logrotate rule like this.',
    };
  }),

  /* ---------------------------------------------------------------- 5.6 Python for administration */
  tmpl(5, 6, 'beginner', 'python-failed-logins', 'Parse log lines with Python regular expressions', 'E1', 20, 'Write a Python function that counts failed SSH logins per account with re.', (v) => {
    const net = v.net();
    const users = v.some(['root', 'admin', 'ama', 'kofi', 'test', 'esi'], 4);
    const lines: string[] = [];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 12; i++) {
      const u = users[i % 4];
      const fail = i % 5 !== 4;
      if (fail) counts[u] = (counts[u] ?? 0) + 1;
      lines.push(`${sysTime(i)} srv1 sshd[${2000 + i}]: ${fail ? `Failed password for ${u === 'admin' || u === 'test' ? 'invalid user ' : ''}${u}` : `Accepted password for ${u}`} from ${net}.${v.int(2, 200)} port ${41000 + i} ssh2`);
    }
    const sample = lines.slice(0, 5);
    const sampleCounts: Record<string, number> = {};
    for (const l of sample) { const m = /Failed password for (?:invalid user )?(\S+)/.exec(l); if (m) sampleCounts[m[1]] = (sampleCounts[m[1]] ?? 0) + 1; }
    return py({
      instructions: `## Count failed logins per account\n\nWrite **failed_logins(lines)** that takes a list of syslog lines and returns a **dict** mapping each account name to its number of \`Failed password\` lines. "Failed password for invalid user X" counts as account X. Other lines are ignored.\n\nUse the **re** module: one pattern with an optional \`(?:invalid user )?\` group and a capture group for the name.\n\nExample line:\n\n\`\`\`\n${lines[0]}\n\`\`\``,
      hints: ['re.search(r"Failed password for (?:invalid user )?(\\S+)", line) returns a match or None.', 'dict.get(name, 0) + 1 counts without a KeyError; collections.Counter also works.'],
      starter: `import re\n\nPATTERN = re.compile(r"")  # write the pattern\n\ndef failed_logins(lines):\n    counts = {}\n    # for each line: search, and count the captured name\n    return counts\n\nprint(failed_logins([\n${sample.map((l) => `    ${JSON.stringify(l)},`).join('\n')}\n]))\n`,
      checks: [
        { type: 'code.function', label: 'Counts per account are right', name: 'failed_logins', cases: [{ args: [lines], expected: counts }, { args: [sample], expected: sampleCounts }, { args: [[]], expected: {} }] },
        { type: 'code.source', label: 'It uses the re module', pattern: 're\\.(search|match|findall|compile|finditer)' },
      ],
      solution: `import re\n\nPATTERN = re.compile(r"Failed password for (?:invalid user )?(\\S+)")\n\ndef failed_logins(lines):\n    counts = {}\n    for line in lines:\n        m = PATTERN.search(line)\n        if m:\n            counts[m.group(1)] = counts.get(m.group(1), 0) + 1\n    return counts\n`,
      realityNote: 'Python is the usual step up from shell pipelines once parsing needs state, several patterns or tests; the re syntax is the same family as grep -E.',
    });
  }),
  tmpl(5, 6, 'intermediate', 'python-csv-json', 'Turn CSV into a JSON report with Python', 'E1', 25, 'Use csv, json and pathlib to total disk use per department from several export files.', (v) => {
    const depts = v.some(['finance', 'registry', 'library', 'estates', 'research'], 3);
    const files: Record<string, string> = {};
    const totals: Record<string, number> = {};
    for (let f = 0; f < 3; f++) {
      const rows: Array<[string, string, number]> = [];
      for (let i = 0; i < 4; i++) {
        const d = depts[(f + i) % 3];
        const gb = v.int(1, 90);
        rows.push([`share${f}${i}`, d, gb]);
        totals[d] = (totals[d] ?? 0) + gb;
      }
      files[`/srv/exports/usage-${f + 1}.csv`] = ['share,department,gb', ...rows.map((r) => r.join(','))].join('\n') + '\n';
    }
    files['/srv/exports/README.txt'] = 'not data\n';
    files['/srv/exports/old/usage-0.csv.bak'] = 'share,department,gb\nx,finance,999\n';
    const expected = Object.fromEntries(Object.entries(totals).sort((a, b) => a[0].localeCompare(b[0])));
    return py({
      instructions: `## Total storage per department\n\nThe file server exports CSV files with the header \`share,department,gb\`. Write **report(files)** where *files* is a dict mapping file paths to their text (the way the files would be read from disk). For example, **/srv/exports/usage-1.csv** starts:\n\n\`\`\`\n${files['/srv/exports/usage-1.csv'].split('\n').slice(0, 3).join('\n')}\n\`\`\`\n\nIt must:\n\n1. use **pathlib.PurePosixPath** to keep only files whose **suffix is .csv** (ignore README.txt and .bak files);\n2. read each with **csv.DictReader** (wrap the text in io.StringIO);\n3. add up **gb** per **department**;\n4. return a **JSON string** made with \`json.dumps(totals, sort_keys=True)\`.`,
      hints: ['PurePosixPath("/srv/exports/old/usage-0.csv.bak").suffix is ".bak".', 'DictReader gives each row as a dict keyed by the header; convert gb with int().'],
      starter: 'import csv\nimport io\nimport json\nfrom pathlib import PurePosixPath\n\ndef report(files):\n    totals = {}\n    for path, text in files.items():\n        pass  # keep .csv files, read rows, add up gb per department\n    return json.dumps(totals, sort_keys=True)\n\nprint(report({"/srv/exports/a.csv": "share,department,gb\\ns1,finance,10\\n"}))\n',
      checks: [
        { type: 'code.script', label: 'The totals are right and only .csv files count', script: `import json\nresult = report(${JSON.stringify(files)})\nassert isinstance(result, str), "report must return a JSON string"\nassert json.loads(result) == ${JSON.stringify(expected)}, "the totals per department are not right: " + result\nassert result == json.dumps(${JSON.stringify(expected)}, sort_keys=True), "use json.dumps(totals, sort_keys=True)"` },
        { type: 'code.script', label: 'No files gives an empty report', script: 'assert report({}) == "{}", "an empty input should give {}"' },
        { type: 'code.source', label: 'It uses csv and pathlib', pattern: 'DictReader[\\s\\S]*|PurePosixPath', success: 'Your code uses csv and pathlib.' },
      ],
      solution: 'import csv\nimport io\nimport json\nfrom pathlib import PurePosixPath\n\ndef report(files):\n    totals = {}\n    for path, text in files.items():\n        if PurePosixPath(path).suffix != ".csv":\n            continue\n        for row in csv.DictReader(io.StringIO(text)):\n            totals[row["department"]] = totals.get(row["department"], 0) + int(row["gb"])\n    return json.dumps(totals, sort_keys=True)\n',
      realityNote: 'csv and json in the standard library cover most administrative data plumbing; pathlib replaces fragile string slicing of file names.',
    });
  }),
  tmpl(5, 6, 'advanced', 'python-argparse-cli', 'Build a command-line tool with argparse', 'E1', 30, 'Write a Python CLI with options, choices and validation, and build subprocess commands safely as lists.', (v) => {
    const units = v.some(['sshd', 'apache2', 'named', 'cron'], 2);
    const th = v.pick([3, 5]);
    return py({
      instructions: `## A small admin tool\n\nWrite **main(argv)** using **argparse** (call \`parser.parse_args(argv)\`) for a tool \`logcheck\` with:\n\n- a positional **unit** (the systemd unit to check);\n- **--since** (text, default \`"1 hour ago"\`);\n- **--threshold** (int, default **${th}**);\n- **--format** with choices **text** or **json** (default text).\n\n\`main\` must not run anything: it returns the command to run as a **list** (never a shell string), \`["journalctl", "-u", UNIT, "--since", SINCE, "-o", OUTPUT]\` where OUTPUT is \`"json"\` for --format json and \`"short-iso"\` otherwise. A list passed to subprocess.run cannot be tricked by spaces or ; in the arguments, which a shell string can.\n\nBad input (an unknown --format, a non-number threshold) must make argparse exit with code **2**.\n\nFor example, \`main(["${units[1]}", "--since", "today", "--format", "json"])\` returns \`["journalctl", "-u", "${units[1]}", "--since", "today", "-o", "json"]\`.`,
      hints: ['parser.add_argument("--format", choices=["text", "json"], default="text")', 'argparse raises SystemExit(2) by itself on bad input; you do not need to catch it.', 'Return the list; a real tool would then call subprocess.run(cmd, check=True, capture_output=True, text=True).'],
      starter: 'import argparse\n\ndef main(argv):\n    parser = argparse.ArgumentParser(prog="logcheck")\n    # add the arguments here\n    args = parser.parse_args(argv)\n    return []\n\nprint(main(["sshd"]))\n',
      checks: [
        { type: 'code.function', label: 'It builds the right command', name: 'main', cases: [{ args: [[units[0]]], expected: ['journalctl', '-u', units[0], '--since', '1 hour ago', '-o', 'short-iso'] }, { args: [[units[1], '--since', 'today', '--format', 'json']], expected: ['journalctl', '-u', units[1], '--since', 'today', '-o', 'json'] }, { args: [['x; rm -rf /', '--since', '2 days ago']], expected: ['journalctl', '-u', 'x; rm -rf /', '--since', '2 days ago', '-o', 'short-iso'] }] },
        { type: 'code.script', label: 'Bad input exits with code 2', script: 'for bad in (["sshd", "--format", "xml"], ["sshd", "--threshold", "lots"], []):\n    try:\n        main(bad)\n    except SystemExit as e:\n        assert e.code == 2, f"{bad} should exit with code 2, not {e.code}"\n    else:\n        raise AssertionError(f"{bad} should be rejected")' },
        { type: 'code.script', label: 'The threshold is an int with the right default', script: `import argparse\nimport inspect\nsrc = inspect.getsource(main)\nassert "threshold" in src and "type=int" in src.replace(" ", ""), "add --threshold with type=int"\nassert "default=${th}" in src.replace(" ", ""), "the threshold default should be ${th}"` },
        { type: 'code.source', label: 'It never uses a shell', pattern: 'shell\\s*=\\s*True|os\\.system', mustMatch: false, message: 'Do not use shell=True or os.system: build the command as a list.' },
      ],
      solution: `import argparse\n\ndef main(argv):\n    parser = argparse.ArgumentParser(prog="logcheck")\n    parser.add_argument("unit")\n    parser.add_argument("--since", default="1 hour ago")\n    parser.add_argument("--threshold", type=int, default=${th})\n    parser.add_argument("--format", choices=["text", "json"], default="text")\n    args = parser.parse_args(argv)\n    output = "json" if args.format == "json" else "short-iso"\n    return ["journalctl", "-u", args.unit, "--since", args.since, "-o", output]\n`,
      realityNote: 'Building argument lists instead of shell strings is the single most effective defence against command injection in admin tools.',
    });
  }),
];
