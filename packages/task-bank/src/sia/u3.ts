/** Unit 3: scheduling and task automation. */

import { makeCert } from '@cslab/engine-shell/src/cert';
import type { TaskTemplate } from '../types';
import { DEPTS, cron, csv, dc01, file, lab, linux, out, ps, psWrite, ran, script, svc, tmpl, windows, write, writeScript } from './kit';

const HOUR = (h: number) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);

export const U3: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 3.1 cron and systemd timers */
  tmpl(3, 1, 'beginner', 'cron-d-job', 'Schedule a job in /etc/cron.d', 'E4', 15, 'Write a system crontab file with the right five time fields, user and logging.', (v) => {
    const net = v.net();
    const job = v.pick(['purge-tmp', 'rotate-uploads', 'sync-timetable', 'export-attendance']);
    const sched = v.pick([
      { text: 'at 01:30 every night', expr: '30 1 * * *', re: '30\\s+0?1\\s+\\*\\s+\\*\\s+\\*' },
      { text: 'every 15 minutes', expr: '*/15 * * * *', re: '(\\*/15|0,15,30,45)\\s+\\*\\s+\\*\\s+\\*\\s+\\*' },
      { text: 'at 06:00 on weekdays (Monday to Friday)', expr: '0 6 * * 1-5', re: '0\\s+0?6\\s+\\*\\s+\\*\\s+(1-5|mon-fri)' },
      { text: 'at 23:45 on the first day of every month', expr: '45 23 1 * *', re: '45\\s+23\\s+1\\s+\\*\\s+\\*' },
    ]);
    const runAs = v.pick(['root', 'svc-jobs']);
    return {
      instructions: lab({
        situation: `Schedule **/usr/local/bin/${job}** to run **${sched.text}** as **${runAs}**, using a system cron file **/etc/cron.d/${job}** (not a personal crontab). Its output and errors must be appended to **/var/log/${job}.log**. Put \`SHELL=/bin/bash\` and a \`PATH=\` line at the top of the file, as cron gives jobs almost no environment.`,
        steps: ['A line in /etc/cron.d has six parts before the command: minute, hour, day of month, month, day of week, and the user.', 'Write the file with a here-document or an editor.', 'Redirect with >> FILE 2>&1 at the end of the line.', 'Files in /etc/cron.d should be owned by root and not writable by others (644).'],
        tips: [`cat > /etc/cron.d/${job} <<'EOF'\nSHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n# m h dom mon dow user command\n...\nEOF`, 'man 5 crontab'],
      }),
      hints: ['* means "every"; */15 means "every 15th".', 'Without 2>&1, error messages are mailed to the user instead of logged.'],
      initialState: linux(net, { users: runAs === 'root' ? {} : { [runAs]: { shell: '/usr/sbin/nologin', system: true } as never }, files: { [`/usr/local/bin/${job}`]: { content: '#!/bin/bash\necho "$(date) done"\n', mode: '755' } } }),
      checks: [
        file('The schedule, user and command are right', `/etc/cron.d/${job}`, { pattern: `^\\s*${sched.re}\\s+${runAs}\\s+/usr/local/bin/${job}\\b`, message: `Expected a line like: ${sched.expr} ${runAs} /usr/local/bin/${job} >> /var/log/${job}.log 2>&1` }),
        file('Output and errors are appended to the log', `/etc/cron.d/${job}`, { pattern: `>>\\s*/var/log/${job}\\.log\\s+2>&1` }),
        file('The environment is set', `/etc/cron.d/${job}`, { pattern: '^PATH=', contains: 'SHELL=/bin/bash' }),
        file('The file is root-owned and not writable by others', `/etc/cron.d/${job}`, { owner: 'root', mode: '644' }),
      ],
      solution: [write(`/etc/cron.d/${job}`, `SHELL=/bin/bash\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n# m h dom mon dow user command\n${sched.expr} ${runAs} /usr/local/bin/${job} >> /var/log/${job}.log 2>&1\n`), `chmod 644 /etc/cron.d/${job}`, `cat /etc/cron.d/${job}`],
      realityNote: 'Packages drop their jobs into /etc/cron.d for the same reason you should: one file per job, owned by root, easy to deploy and to remove with configuration management.',
    };
  }),
  tmpl(3, 1, 'intermediate', 'systemd-timer', 'Replace a cron job with a systemd timer', 'E4', 25, 'Write a oneshot service that runs as a service account and a timer that triggers it.', (v) => {
    const net = v.net();
    const name = v.pick(['report-export', 'db-dump', 'attendance-sync']);
    const acct = v.pick(['svc-report', 'svc-backup', 'svc-sync']);
    const when = v.pick([{ cal: '*-*-* 02:30:00', text: 'every day at 02:30' }, { cal: 'Mon..Fri *-*-* 18:00:00', text: 'on weekdays at 18:00' }, { cal: 'hourly', text: 'every hour' }]);
    const outDir = `/var/lib/${name}`;
    return {
      instructions: lab({
        situation: `Run **/usr/local/bin/${name}** ${when.text} with systemd instead of cron, so runs are logged in the journal and missed runs catch up after downtime.\n\n- **/etc/systemd/system/${name}.service**: \`Type=oneshot\`, runs as the user **${acct}**, \`ExecStart=/usr/local/bin/${name}\`.\n- **/etc/systemd/system/${name}.timer**: \`OnCalendar=${when.cal}\`, \`Persistent=true\`, installed into timers.target.\n\nEnable and start the **timer** (not the service), then test the service once by hand. It writes into ${outDir}, which ${acct} owns.`,
        steps: ['Write both unit files.', 'systemctl daemon-reload', `systemctl enable --now ${name}.timer`, `systemctl start ${name}.service, then journalctl -u ${name} and ls -l ${outDir}.`],
        tips: [`[Service]\nType=oneshot\nUser=${acct}\nExecStart=/usr/local/bin/${name}`, `[Timer]\nOnCalendar=${when.cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target`, 'systemctl list-timers'],
      }),
      hints: ['A oneshot service is "inactive" after it finishes; that is normal.', 'Enable the timer; the service has no [Install] section because the timer starts it.'],
      initialState: linux(net, { users: { [acct]: { shell: '/usr/sbin/nologin' } }, files: { [`${outDir}/`]: { owner: acct, group: acct, mode: '755' } as never, [`/usr/local/bin/${name}`]: { content: `#!/bin/bash\necho "export by $(whoami) at $(date +%F)" > ${outDir}/last-run.txt\n`, mode: '755' } } }),
      checks: [
        svc('The timer is enabled and active', `${name}.timer`, { active: true, enabled: true }),
        out('The timer has the schedule', `systemctl cat ${name}.timer 2>/dev/null || cat /etc/systemd/system/${name}.timer`, { contains: [`OnCalendar=${when.cal}`, 'Persistent=true', 'WantedBy=timers.target'] }),
        out(`The service runs as ${acct}`, `systemctl start ${name}.service; cat ${outDir}/last-run.txt`, { contains: `export by ${acct}` }),
        file('The service is a oneshot', `/etc/systemd/system/${name}.service`, { pattern: '^Type=oneshot', contains: `User=${acct}` }),
      ],
      solution: [write(`/etc/systemd/system/${name}.service`, `[Unit]\nDescription=${name} export\n\n[Service]\nType=oneshot\nUser=${acct}\nExecStart=/usr/local/bin/${name}\n`), write(`/etc/systemd/system/${name}.timer`, `[Unit]\nDescription=Run ${name} ${when.text}\n\n[Timer]\nOnCalendar=${when.cal}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`), 'systemctl daemon-reload', `systemctl enable --now ${name}.timer`, `systemctl start ${name}.service`, `journalctl -u ${name}`, 'systemctl list-timers'],
      realityNote: 'Timers give each job its own logs, resource limits and dependency handling, and Persistent=true runs a job that was missed while the server was off.',
    };
  }),
  tmpl(3, 1, 'advanced', 'cron-environment', 'Fix a job that works by hand but not from cron', 'E4', 30, 'Reproduce cron\'s minimal environment with env -i and fix PATH, % and relative-path problems.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const name = `${dept}-report`;
    const helper = v.pick(['csv2summary', 'mkreport', 'tally']);
    return {
      instructions: lab({
        situation: `Root's crontab runs the **${name}** job every night, but its report never appears, although \`/usr/local/sbin/${name}\` works perfectly when you run it yourself. Cron starts jobs with almost no environment (PATH=/usr/bin:/bin, no login files) in the home directory, and in a crontab a bare % means "new line".\n\nReproduce the cron environment with:\n\n\`env -i PATH=/usr/bin:/bin HOME=/root SHELL=/bin/sh /bin/sh -c '<the crontab command>'\`\n\nThen fix the script and the crontab line so that this produces **/srv/reports/${dept}-YYYY-MM-DD.txt** (today's date) without depending on your login shell.`,
        steps: ['crontab -l: copy the command part of the line.', 'Run it under env -i as above and read the errors.', 'In the script: call helpers by full path (or set PATH at the top) and use absolute paths for files.', 'In the crontab: escape % as \\%.'],
        tips: ['crontab -l', "env -i PATH=/usr/bin:/bin HOME=/root SHELL=/bin/sh /bin/sh -c '/usr/local/sbin/...'", 'crontab -e   (or: crontab -l > /tmp/c; edit; crontab /tmp/c)'],
      }),
      hints: [`${helper} lives in /usr/local/sbin, which is not in cron's PATH.`, 'Relative paths are relative to the current directory, which under cron is the home directory, not the script\'s folder.'],
      initialState: linux(net, {
        files: {
          [`/usr/local/sbin/${helper}`]: { content: `#!/bin/bash\nawk -F, 'NR > 1 {n++; s += $2} END {printf "entries=%d total=%d\\n", n, s}' "$1"\n`, mode: '755' },
          [`/usr/local/sbin/${name}`]: { content: `#!/bin/bash\ncd /srv/${dept}\nout=/srv/reports/${dept}-$1.txt\n${helper} data/today.csv > "$out"\n`, mode: '755' },
          [`/srv/${dept}/data/today.csv`]: 'item,amount\na,10\nb,32\n',
          '/srv/reports/': null,
        },
        crontabs: { root: `# m h dom mon dow command\n15 2 * * * /usr/local/sbin/${name} $(date +%F) >> /var/log/${name}.log 2>&1\n` },
      }),
      checks: [
        out('The job works in cron\'s environment', `cmd=$(crontab -l | grep '${name}' | awk '{for (i = 6; i <= NF; i++) printf "%s ", $i}' | sed 's/\\\\%/%/g'); rm -f /srv/reports/${dept}-*; env -i PATH=/usr/bin:/bin HOME=/root SHELL=/bin/sh /bin/sh -c "cd /root; $cmd"; cat /srv/reports/${dept}-2026-10-22.txt`, { equals: 'entries=2 total=42' }),
        cron('The % signs are escaped in the crontab', 'root', `${name}.*\\\\%F`, 'Escape % as \\% in the crontab line, or cron cuts the command at the first %.'),
        cron('It still runs nightly at 02:15', 'root', `^15\\s+0?2\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/sbin/${name}`),
      ],
      solution: ['crontab -l', `env -i PATH=/usr/bin:/bin HOME=/root SHELL=/bin/sh /bin/sh -c '/usr/local/sbin/${name} $(date +%F)'`, writeScript(`/usr/local/sbin/${name}`, `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nout=/srv/reports/${dept}-$1.txt\n${helper} /srv/${dept}/data/today.csv > "$out"\n`), write('/tmp/root.cron', `# m h dom mon dow command\n15 2 * * * /usr/local/sbin/${name} $(date +\\%F) >> /var/log/${name}.log 2>&1\n`), 'crontab /tmp/root.cron', 'crontab -l'],
      realityNote: '"It works when I run it" is the most common cron complaint; env -i reproduces the job\'s real environment in seconds.',
    };
  }),

  /* ---------------------------------------------------------------- 3.2 Windows Task Scheduler */
  tmpl(3, 2, 'beginner', 'register-task', 'Register a scheduled task with PowerShell', 'E4', 20, 'Create a daily task in its own folder that runs a script as SYSTEM, and test it.', (v) => {
    const net = v.net();
    const task = v.pick(['Clear Temp Files', 'Export Print Log', 'Archive Old Logs']);
    const script = `C:\\Scripts\\${task.replace(/\s+/g, '-')}.ps1`;
    const hour = v.int(1, 5);
    const folder = v.pick(['ICT', 'Maintenance', 'LabOps']);
    return {
      instructions: lab({
        situation: `Schedule **${script}** (already written) to run **daily at ${HOUR(hour)}** as **SYSTEM**, in the Task Scheduler folder **\\${folder}\\**, with the name **${task}**. The action must run \`powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${script}\`. Then start it once by hand and confirm the last result is 0.`,
        steps: ['Build the parts: New-ScheduledTaskAction, New-ScheduledTaskTrigger -Daily -At, New-ScheduledTaskPrincipal -UserId SYSTEM.', `Register-ScheduledTask -TaskName '${task}' -TaskPath '\\${folder}\\' ...`, 'Start-ScheduledTask, then Get-ScheduledTaskInfo.'],
        tips: [`$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File ${script}'`, `$trigger = New-ScheduledTaskTrigger -Daily -At ${HOUR(hour)}`, "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest", `Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\${folder}\\'`],
      }),
      hints: ['SYSTEM needs no password and has full rights on the local computer, but no network credentials.', 'LastTaskResult 0 means success; 267011 means the task has not run yet.'],
      initialState: windows({ machines: [dc01(net)], files: { [script]: "New-Item -ItemType Directory C:\\Logs -Force | Out-Null\nAdd-Content -Path C:\\Logs\\tasks.log -Value \"$(Get-Date -Format s) ran as $env:USERNAME\"\n" } }),
      checks: [
        ps('The task is in the right folder', `(Get-ScheduledTask -TaskName '${task}').TaskPath`, { equals: `\\${folder}\\` }),
        ps('It runs daily at the right time', `$t = (Get-ScheduledTask -TaskName '${task}').Triggers[0]; "$($t.Kind) $(([datetime]$t.StartBoundary).ToString('HH:mm'))"`, { equals: `Daily ${String(hour).padStart(2, '0')}:00` }),
        ps('It runs as SYSTEM', `(Get-ScheduledTask -TaskName '${task}').Principal.UserId`, { pattern: '^(NT AUTHORITY\\\\)?SYSTEM$' }),
        ps('The action runs the script with -File', `(Get-ScheduledTask -TaskName '${task}').Actions[0].Arguments`, { contains: `-File ${script}` }),
        ps('It has run successfully', `(Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\${folder}\\').LastTaskResult`, { equals: '0' }),
        ps('It ran as SYSTEM (the computer account)', 'Get-Content C:\\Logs\\tasks.log', { contains: 'ran as DC01$' }),
      ],
      solution: [`$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File ${script}'`, `$trigger = New-ScheduledTaskTrigger -Daily -At ${HOUR(hour)}`, "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest", `Register-ScheduledTask -TaskName '${task}' -TaskPath '\\${folder}\\' -Action $action -Trigger $trigger -Principal $principal`, `Start-ScheduledTask -TaskName '${task}' -TaskPath '\\${folder}\\'`, `Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\${folder}\\'`],
      realityNote: 'Registering tasks from a script (rather than clicking through taskschd.msc) means every server gets the same task, and the script is the documentation.',
    };
  }),
  tmpl(3, 2, 'intermediate', 'task-settings', 'Set limits and retries on a scheduled task', 'E4', 25, 'Register a weekly task with a time limit, restart-on-failure, no overlapping runs and catch-up.', (v) => {
    const net = v.net();
    const task = v.pick(['Weekly Patch Report', 'Weekly Disk Audit', 'Weekly Licence Count']);
    const days = v.pick([['Monday'], ['Monday', 'Thursday'], ['Friday']]);
    const limit = v.pick([{ ts: '(New-TimeSpan -Minutes 30)', iso: 'PT30M', text: '30 minutes' }, { ts: '(New-TimeSpan -Hours 2)', iso: 'PT2H', text: '2 hours' }]);
    const retries = v.int(2, 4);
    const script = `C:\\Scripts\\${task.replace(/\s+/g, '-')}.ps1`;
    return {
      instructions: lab({
        situation: `Register **${task}** (folder \\ICT\\) to run **${script}** every **${days.join(' and ')}** at 7pm as SYSTEM, with these settings:\n\n- stop the task if it runs longer than **${limit.text}**;\n- if it fails, restart it up to **${retries}** times, **every 10 minutes**;\n- if a run is still going when the next one is due, **do not start another** (IgnoreNew);\n- if the server was off at the scheduled time, **run as soon as possible** afterwards.`,
        steps: ['New-ScheduledTaskTrigger -Weekly -DaysOfWeek ... -At 7pm', 'New-ScheduledTaskSettingsSet with -ExecutionTimeLimit, -RestartCount, -RestartInterval, -MultipleInstances and -StartWhenAvailable.', 'Register it and read the settings back with (Get-ScheduledTask ...).Settings.'],
        tips: [`New-ScheduledTaskSettingsSet -ExecutionTimeLimit ${limit.ts} -RestartCount ${retries} -RestartInterval (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable`, `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${days.join(',')} -At 7pm`],
      }),
      hints: ['Task Scheduler stores durations as ISO 8601 text: PT30M is 30 minutes, PT2H is 2 hours.', 'Without an execution time limit a hung script blocks every later run (the default is 72 hours).'],
      initialState: windows({ machines: [dc01(net)], files: { [script]: "'report'\n" } }),
      checks: [
        ps('The time limit is set', `(Get-ScheduledTask -TaskName '${task}').Settings.ExecutionTimeLimit`, { equals: limit.iso }),
        ps('It restarts after failures', `$s = (Get-ScheduledTask -TaskName '${task}').Settings; "$($s.RestartCount) $($s.RestartInterval)"`, { equals: `${retries} PT10M` }),
        ps('Runs never overlap', `(Get-ScheduledTask -TaskName '${task}').Settings.MultipleInstances`, { equals: 'IgnoreNew' }),
        ps('Missed runs catch up', `(Get-ScheduledTask -TaskName '${task}').Settings.StartWhenAvailable`, { equals: 'True' }),
        ps('It runs weekly on the right days at 19:00', `$t = (Get-ScheduledTask -TaskName '${task}').Triggers[0]; "$($t.Kind) $($t.DaysOfWeek) $(([datetime]$t.StartBoundary).ToString('HH:mm'))"`, { equals: `Weekly ${days.join(', ')} 19:00` }),
        ps('It is in \\ICT\\', `(Get-ScheduledTask -TaskName '${task}').TaskPath`, { equals: '\\ICT\\' }),
      ],
      solution: [`$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -File ${script}'`, `$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${days.join(',')} -At 7pm`, `$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ${limit.ts} -RestartCount ${retries} -RestartInterval (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable`, `Register-ScheduledTask -TaskName '${task}' -TaskPath '\\ICT\\' -Action $a -Trigger $t -Settings $s -User 'SYSTEM'`, `(Get-ScheduledTask -TaskName '${task}').Settings`],
      realityNote: 'The defaults (72-hour limit, no retries) suit desktops, not servers; limits and retries are what turn a scheduled script into a dependable job.',
    };
  }),
  tmpl(3, 2, 'advanced', 'failing-task', 'Diagnose a task that fails when scheduled', 'E4', 30, 'Find why a task returns 1 under SYSTEM in System32, fix the script and prove it with Last Result 0.', (v) => {
    const net = v.net();
    const task = v.pick(['Nightly Fees Export', 'Nightly Register Export']);
    const dir = v.pick(['C:\\Jobs\\Fees', 'C:\\Jobs\\Register']);
    const script = `${dir}\\export.ps1`;
    const n = v.int(3, 6);
    return {
      instructions: lab({
        situation: `The task **${task}** (folder \\ICT\\) always shows Last Result **1**, but when you run **${script}** from its own folder it works. It reads **data.csv** next to the script and writes **out\\export.csv** there.\n\nScheduled tasks run as their principal (here SYSTEM) and start in **C:\\Windows\\System32** unless told otherwise. Fix the **script** so it works from any current directory, re-run the task, and make sure Last Result is 0 and ${dir}\\out\\export.csv has the ${n} data rows.`,
        steps: ['Get-ScheduledTaskInfo and read the Last Result.', 'Read the script: which paths are relative?', 'Use $PSScriptRoot (the folder of the running script) to build the paths with Join-Path.', 'Start-ScheduledTask again and check.'],
        tips: [`Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\ICT\\'`, `Get-Content ${script}`, "$data = Join-Path $PSScriptRoot 'data.csv'"],
      }),
      hints: ['Set-Location to the script folder also works, but $PSScriptRoot keeps the script independent of where it starts.', 'A setting on the task (the action\'s working directory) would hide the bug instead of fixing the script.'],
      initialState: windows({ machines: [{ ...dc01(net), tasks: [{ name: task, path: '\\ICT\\', action: `powershell.exe -NoProfile -File ${script}`, execute: 'powershell.exe', argument: `-NoProfile -File ${script}`, trigger: 'Daily at 1am', user: 'SYSTEM', enabled: true, lastRun: Date.UTC(2026, 9, 22, 1, 0), lastResult: 1, triggers: [{ __type: 'psobject', Kind: 'Daily', StartBoundary: '2026-10-22T01:00:00', DaysInterval: 1, Text: 'Daily at 1am' }] }] } as never], files: { [`${dir}\\data.csv`]: csv('Id,Amount', Array.from({ length: n }, (_, i) => [1000 + i, v.int(20, 900)])), [script]: "$ErrorActionPreference = 'Stop'\n$rows = Import-Csv .\\data.csv\nNew-Item -ItemType Directory .\\out -Force | Out-Null\n$rows | Export-Csv .\\out\\export.csv -NoTypeInformation\n" } }),
      checks: [
        ps('The task now succeeds', `(Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\ICT\\').LastTaskResult`, { equals: '0', message: 'Run the task again with Start-ScheduledTask after fixing the script.' }),
        ps('The export has the data rows', `@(Import-Csv ${dir}\\out\\export.csv).Count`, { equals: String(n) }),
        ps('The script uses its own folder', `Get-Content ${script} -Raw`, { contains: '$PSScriptRoot' }),
        ps('The script works from any folder', `Remove-Item ${dir}\\out -Recurse -Force -ErrorAction SilentlyContinue; Set-Location C:\\; & ${script}; Test-Path ${dir}\\out\\export.csv`, { equals: 'True' }),
      ],
      solution: [`Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\ICT\\'`, `Get-Content ${script}`, psWrite(script, "$ErrorActionPreference = 'Stop'\n$rows = Import-Csv (Join-Path $PSScriptRoot 'data.csv')\n$out = Join-Path $PSScriptRoot 'out'\nNew-Item -ItemType Directory $out -Force | Out-Null\n$rows | Export-Csv (Join-Path $out 'export.csv') -NoTypeInformation"), `Start-ScheduledTask -TaskName '${task}' -TaskPath '\\ICT\\'`, `Get-ScheduledTaskInfo -TaskName '${task}' -TaskPath '\\ICT\\'`],
      realityNote: 'Different user, different current directory, no mapped drives: almost every "works by hand, fails as a task" problem is one of these three.',
    };
  }),

  /* ---------------------------------------------------------------- 3.3 lock files, overlapping runs, exit codes, alerting */
  tmpl(3, 3, 'beginner', 'flock-wrapper', 'Stop overlapping runs with flock', 'E4', 15, 'Wrap a slow job in flock -n so a second run exits instead of piling up.', (v) => {
    const net = v.net();
    const job = v.pick(['sync-mirror', 'index-library', 'pull-results']);
    const lock = `/run/lock/${job}.lock`;
    return {
      instructions: lab({
        situation: `**/usr/local/bin/${job}** runs every 5 minutes from cron, but sometimes takes 20 minutes, so copies pile up. Write **/usr/local/bin/${job}-safe** that runs the job under \`flock -n ${lock}\`: if another run holds the lock, print \`${job}: previous run still active\` and exit **0** (a skipped run is not an error). Then point root's crontab at the safe wrapper (every 5 minutes).\n\nA run is in progress right now, so you can test the locked case.`,
        steps: ['ps aux | grep flock shows the run in progress.', 'In the wrapper: flock -n LOCK COMMAND runs COMMAND only if it gets the lock, otherwise it fails at once.', 'Use || to print the message when flock fails.', 'Update the crontab.'],
        tips: [`flock -n ${lock} /usr/local/bin/${job} || { echo "${job}: previous run still active"; exit 0; }`, 'crontab -l', 'crontab -e'],
      }),
      hints: ['-n means "do not wait": without it the second copy queues behind the first.', 'flock releases the lock automatically when the job ends, even if it crashes.'],
      initialState: linux(net, { files: { [`/usr/local/bin/${job}`]: { content: '#!/bin/bash\necho synced\n', mode: '755' }, '/run/lock/': null }, processes: [{ cmd: `flock ${lock} /usr/local/bin/${job}`, user: 'root' }], crontabs: { root: `*/5 * * * * /usr/local/bin/${job}\n` } }),
      checks: [
        script('While locked it skips cleanly', `/usr/local/bin/${job}-safe`, { status: 0, contains: `${job}: previous run still active` }),
        file('It uses flock -n on the lock file', `/usr/local/bin/${job}-safe`, { pattern: `flock\\s+(-n|--nonblock)\\s+${lock.replace(/[.]/g, '\\.')}` }),
        out('Without the other run it does the work', `pkill -f 'flock ${lock}'; /usr/local/bin/${job}-safe`, { equals: 'synced' }),
        cron('Cron runs the safe wrapper', 'root', `^\\*/5\\s+\\*\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/bin/${job}-safe`),
      ],
      solution: [`ps aux | grep flock`, writeScript(`/usr/local/bin/${job}-safe`, `flock -n ${lock} /usr/local/bin/${job} || { echo "${job}: previous run still active"; exit 0; }\n`), `${job}-safe`, `echo '*/5 * * * * /usr/local/bin/${job}-safe' | crontab -`, 'crontab -l'],
      realityNote: 'flock(1) is the simplest reliable lock on Linux; the kernel releases it when the process dies, so there are no stale lock files to clean up.',
    };
  }),
  tmpl(3, 3, 'intermediate', 'exit-codes-alert', 'Alert by mail when a job fails', 'E4', 25, 'Wrap a job so every run is logged with its exit code and failures send a mail.', (v) => {
    const net = v.net();
    const job = v.pick(['fees-import', 'results-sync', 'payroll-export']);
    const admin = v.pick(['root', 'ictadmin']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/bin/runjob NAME COMMAND [ARGS...]** that runs COMMAND and then:\n\n- appends \`<date +%F_%T> NAME exit=<code>\` to **/var/log/jobs.log**;\n- if the exit code is not 0, mails **${admin}** with the subject \`FAILED: NAME (exit <code>)\` and the command's output as the body;\n- exits with the command's own exit code.\n\nTest it with \`runjob ${job} /usr/local/bin/${job}\`, which fails today.`,
        steps: ['Save the name, shift, then run "$@" capturing output: out=$("$@" 2>&1); rc=$?', 'Log with echo ... >> /var/log/jobs.log.', 'Mail with: echo "$out" | mail -s "FAILED: ..." ' + admin, 'exit "$rc" at the end.'],
        tips: ['name=$1; shift', 'out=$("$@" 2>&1); rc=$?', `printf '%s\\n' "$out" | mail -s "FAILED: $name (exit $rc)" ${admin}`, `mail -H   (as ${admin}: list the messages)`],
      }),
      hints: ['$? must be read straight after the command, before anything else changes it.', 'A wrapper that hides the exit code breaks every tool that relies on it.'],
      initialState: linux(net, { packages: { mailx: { installed: true } }, users: admin === 'root' ? {} : { [admin]: {} }, files: { [`/usr/local/bin/${job}`]: { content: `#!/bin/bash\necho "connecting to db01"\necho "error: database db01 refused the connection" >&2\nexit 3\n`, mode: '755' } } }),
      checks: [
        script('A failing job keeps its exit code', '/usr/local/bin/runjob', { args: [job, `/usr/local/bin/${job}`], status: 3 }),
        out('Each run is logged with its code', `/usr/local/bin/runjob ok-test /bin/true; /usr/local/bin/runjob ${job} /usr/local/bin/${job}; tail -2 /var/log/jobs.log`, { pattern: `^\\d{4}-\\d{2}-\\d{2}_\\d{2}:\\d{2}:\\d{2} ok-test exit=0\\n\\d{4}-\\d{2}-\\d{2}_\\d{2}:\\d{2}:\\d{2} ${job} exit=3$` }),
        out('A failure is mailed with the output', `rm -f /var/spool/mail/${admin}; /usr/local/bin/runjob ${job} /usr/local/bin/${job}; cat /var/spool/mail/${admin}`, { contains: [`Subject: FAILED: ${job} (exit 3)`, 'database db01 refused the connection'] }),
        out('A success sends no mail', `rm -f /var/spool/mail/${admin}; /usr/local/bin/runjob ok-test /bin/true; ls /var/spool/mail/${admin} 2>/dev/null | wc -l`, { equals: '0' }),
      ],
      solution: [writeScript('/usr/local/bin/runjob', `name=$1\nshift\nout=$("$@" 2>&1)\nrc=$?\necho "$(date +%F_%T) $name exit=$rc" >> /var/log/jobs.log\nif [ "$rc" -ne 0 ]; then\n  printf '%s\\n' "$out" | mail -s "FAILED: $name (exit $rc)" ${admin}\nfi\nexit "$rc"\n`), `runjob ${job} /usr/local/bin/${job}; echo $?`, 'tail /var/log/jobs.log'],
      realityNote: 'Cron mails output by default, which floods inboxes; a wrapper that logs every run and alerts only on failure is the usual fix (healthchecks.io and cronitor do the same as services).',
    };
  }),
  tmpl(3, 3, 'advanced', 'robust-job-wrapper', 'Build a robust job wrapper', 'E4', 35, 'Combine a per-job lock, a time limit, syslog logging and distinct exit codes in one wrapper.', (v) => {
    const net = v.net();
    const limit = v.pick([60, 120, 300]);
    const tag = v.pick(['jobrun', 'cronjob', 'labjob']);
    return {
      instructions: lab({
        situation: `Write **/usr/local/bin/${tag} NAME COMMAND [ARGS...]** for all scheduled jobs:\n\n1. Hold a per-job lock **/run/lock/${tag}-NAME.lock** with \`flock -n -E 75\`, so a second copy of the same job exits at once with code **75**; log \`NAME skipped: already running\`.\n2. Inside the lock, run the command under \`timeout ${limit}\`; if it times out (timeout exits **124**), log \`NAME timed out after ${limit}s\`.\n3. Otherwise log \`NAME finished exit=<code>\`.\n4. Log with **logger -t ${tag}** (it ends up in /var/log/messages) and exit with the command's code (124 for a time-out, 75 when skipped).\n\nA job called **nightly-sync** is running right now and holds its lock.`,
        steps: [`flock -n -E 75 LOCKFILE timeout ${limit} "$@"; rc=$?`, 'Choose the message from rc with a case statement and log it with logger -t.', 'Test: a normal job, a failing one, a slow one (sleep longer than the limit) and nightly-sync.'],
        tips: [`flock -n -E 75 "/run/lock/${tag}-$name.lock" timeout ${limit} "$@"`, 'case $rc in\n  75) ... ;;\n  124) ... ;;\n  *) ... ;;\nesac', `logger -t ${tag} "..."`, `grep ${tag} /var/log/messages`],
      }),
      hints: ['75 is EX_TEMPFAIL in sysexits.h: "try again later"; -E makes flock use it when the lock is taken.', 'The kernel releases the lock when the job ends, even if it crashes, so there are no stale locks.'],
      initialState: linux(net, { files: { '/run/lock/': null }, processes: [{ cmd: `flock /run/lock/${tag}-nightly-sync.lock /usr/local/bin/nightly-sync`, user: 'root' }] }),
      checks: [
        script('A normal job runs and logs', `/usr/local/bin/${tag}`, { args: ['hello', 'echo', 'hi'], status: 0, contains: 'hi' }),
        out('Its result is in syslog', `/usr/local/bin/${tag} hello echo hi >/dev/null; grep '${tag}' /var/log/messages | tail -1`, { pattern: `${tag}(\\[\\d+\\])?: hello finished exit=0$` }),
        script('A failing job keeps its code', `/usr/local/bin/${tag}`, { args: ['broken', 'false'], status: 1 }),
        out('A slow job is stopped and logged', `/usr/local/bin/${tag} slow sleep ${limit + 30}; echo "rc=$?"; grep '${tag}' /var/log/messages | tail -1`, { pattern: `rc=124\\n.*slow timed out after ${limit}s$` }),
        out('A running job is not started twice', `/usr/local/bin/${tag} nightly-sync echo again; echo "rc=$?"; grep '${tag}' /var/log/messages | tail -1`, { pattern: 'rc=75\\n.*nightly-sync skipped: already running$' }),
      ],
      solution: [writeScript(`/usr/local/bin/${tag}`, `name=$1\nshift\nflock -n -E 75 "/run/lock/${tag}-$name.lock" timeout ${limit} "$@"\nrc=$?\ncase $rc in\n  75) logger -t ${tag} "$name skipped: already running" ;;\n  124) logger -t ${tag} "$name timed out after ${limit}s" ;;\n  *) logger -t ${tag} "$name finished exit=$rc" ;;\nesac\nexit "$rc"\n`), `${tag} hello echo hi`, `grep ${tag} /var/log/messages`],
      realityNote: 'Every mature operations team ends up with a wrapper like this; tools such as systemd (TimeoutStartSec, journald) or Rundeck give the same guarantees built in.',
    };
  }),

  /* ---------------------------------------------------------------- 3.4 backups: rsync, tar, Robocopy, rotation, restore verification */
  tmpl(3, 4, 'beginner', 'robocopy-mirror', 'Mirror a share with Robocopy', 'E4', 20, 'Mirror a folder to a backup drive with /MIR, retries and a log, and read the exit code.', (v) => {
    const net = v.net();
    const dept = v.pick(['Finance', 'Registry', 'Library', 'Estates']);
    const files = v.some(['budget.xlsx', 'minutes.docx', 'register.csv', 'plan.pdf', 'contacts.csv', 'notes.txt'], 4);
    const stale = v.pick(['old-draft.docx', 'tmp-copy.xlsx']);
    const src = `C:\\Shares\\${dept}`;
    const dst = `C:\\Backup\\${dept}`;
    return {
      instructions: lab({
        situation: `Back up **${src}** to **${dst}** with Robocopy so that the backup is an exact mirror: new and changed files copied, and files deleted from the share removed from the backup (there is an old **${stale}** in the backup that no longer exists on the share). Use **2 retries** with **5 seconds** wait, and write the log to **C:\\Logs\\robocopy-${dept}.log**. Robocopy's exit codes below 8 mean success; record the code you get in **C:\\Logs\\robocopy-${dept}.code**.`,
        steps: ['robocopy SOURCE DEST /MIR /R:2 /W:5 /LOG:FILE', 'Straight after it, save $LASTEXITCODE to the .code file.', 'Compare the two folders.'],
        tips: [`robocopy ${src} ${dst} /MIR /R:2 /W:5 /LOG:C:\\Logs\\robocopy-${dept}.log`, `Set-Content C:\\Logs\\robocopy-${dept}.code $LASTEXITCODE`, `Compare-Object (Get-ChildItem ${src}).Name (Get-ChildItem ${dst}).Name`],
      }),
      hints: ['/MIR deletes from the destination anything not in the source: point it at the right folder!', 'The default retry count is a million with 30-second waits, which can hang a job for days.'],
      initialState: windows({ machines: [dc01(net)], files: { ...Object.fromEntries(files.map((f) => [`${src}\\${f}`, `${f} contents\n`])), [`${dst}\\${files[0]}`]: `${files[0]} contents\n`, [`${dst}\\${stale}`]: 'stale\n', 'C:\\Logs\\README.txt': 'Logs.\n' } }),
      checks: [
        ps('The backup has every file from the share', `(Compare-Object (Get-ChildItem ${src}).Name (Get-ChildItem ${dst}).Name | Measure-Object).Count`, { equals: '0', message: `The two folders differ. /MIR should copy the missing files and remove ${stale}.` }),
        ps(`${stale} was removed from the backup`, `Test-Path ${dst}\\${stale}`, { equals: 'False' }),
        ps('The log was written', `Test-Path C:\\Logs\\robocopy-${dept}.log`, { equals: 'True' }),
        ps('A success code (below 8) was recorded', `[int](Get-Content C:\\Logs\\robocopy-${dept}.code) -lt 8 -and [int](Get-Content C:\\Logs\\robocopy-${dept}.code) -gt 0`, { equals: 'True' }),
        ran('Retries and waits were limited', 'robocopy.*\\/R:2.*\\/W:5|robocopy.*\\/W:5.*\\/R:2'),
      ],
      solution: [`robocopy ${src} ${dst} /MIR /R:2 /W:5 /LOG:C:\\Logs\\robocopy-${dept}.log`, `Set-Content C:\\Logs\\robocopy-${dept}.code $LASTEXITCODE`, `Get-ChildItem ${dst}`],
      realityNote: 'Robocopy exit codes are a bit mask: 1 files copied, 2 extra files, 4 mismatches, 8 and above failures; scripts that treat anything non-zero as failure raise false alarms every night.',
    };
  }),
  tmpl(3, 4, 'intermediate', 'tar-rotate-verify', 'Back up with tar, checksums and rotation', 'E4', 25, 'Write a backup script that creates a dated archive, a SHA-256 file and keeps only recent archives.', (v) => {
    const net = v.net();
    const dept = v.pick(DEPTS);
    const keep = v.pick([7, 14]);
    const old = [keep + 3, keep + 10, keep + 20].map((d) => ({ d, f: `/backup/${dept}-2026-${String(9 - Math.floor(d / 30)).padStart(2, '0')}-${String(28 - (d % 27)).padStart(2, '0')}.tar.gz` }));
    const recent = { d: 2, f: `/backup/${dept}-2026-10-20.tar.gz` };
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/backup-${dept}** that:\n\n1. archives **/srv/${dept}** to **/backup/${dept}-YYYY-MM-DD.tar.gz** (today's date) with tar;\n2. writes the archive's SHA-256 to **/backup/${dept}-YYYY-MM-DD.tar.gz.sha256** in the format sha256sum uses, so \`sha256sum -c\` can verify it;\n3. deletes **${dept}-*.tar.gz** archives (and their .sha256 files) older than **${keep} days**;\n4. exits non-zero if any step fails (use set -euo pipefail).\n\nRun it once.`,
        steps: ['tar -czf ARCHIVE -C /srv DIR', 'cd /backup && sha256sum NAME > NAME.sha256 (so the file holds a relative name).', `find /backup -name '${dept}-*.tar.gz*' -mtime +${keep} -delete`, 'Verify with: cd /backup && sha256sum -c NAME.sha256'],
        tips: ['set -euo pipefail', 'today=$(date +%F)', `find /backup -name '${dept}-*.tar.gz*' -mtime +${keep} -delete`, 'sha256sum -c FILE.sha256'],
      }),
      hints: ['Storing the checksum with a relative file name lets you verify the backup after copying it elsewhere.', 'Test the find command without -delete first.'],
      initialState: linux(net, { files: { [`/srv/${dept}/register.csv`]: 'id,name\n1,Ama\n', [`/srv/${dept}/minutes.txt`]: 'Minutes\n', ...Object.fromEntries(old.flatMap((o) => [[o.f, { content: 'old\n', ageDays: o.d }], [`${o.f}.sha256`, { content: 'x\n', ageDays: o.d }]])), [recent.f]: { content: 'recent\n', ageDays: recent.d } } as never }),
      checks: [
        file("Today's archive exists", `/backup/${dept}-2026-10-22.tar.gz`, { exists: true }),
        out('The checksum verifies', `cd /backup && sha256sum -c ${dept}-2026-10-22.tar.gz.sha256`, { contains: `${dept}-2026-10-22.tar.gz: OK` }),
        out('The archive holds the data', `tar -tzf /backup/${dept}-2026-10-22.tar.gz`, { contains: ['register.csv', 'minutes.txt'] }),
        out(`Archives older than ${keep} days are gone`, `ls /backup`, { notContains: old.map((o) => o.f.split('/').pop()!) }),
        out('Recent archives are kept', 'ls /backup', { contains: recent.f.split('/').pop()! }),
        file('Strict mode is on', `/usr/local/sbin/backup-${dept}`, { pattern: 'set -euo pipefail' }),
      ],
      solution: [writeScript(`/usr/local/sbin/backup-${dept}`, `set -euo pipefail\ntoday=$(date +%F)\nname=${dept}-$today.tar.gz\nmkdir -p /backup\ntar -czf "/backup/$name" -C /srv ${dept}\ncd /backup\nsha256sum "$name" > "$name.sha256"\nfind /backup -name '${dept}-*.tar.gz*' -mtime +${keep} -delete\n`), `backup-${dept}`, `cd /backup && sha256sum -c ${dept}-2026-10-22.tar.gz.sha256`, 'ls /backup'],
      realityNote: 'A checksum written at backup time is how you later tell a good archive from a silently corrupted one; rotation keeps the disk from filling and the backup from failing.',
    };
  }),
  tmpl(3, 4, 'advanced', 'restore-test', 'Verify a backup by comparing hashes', 'E4', 30, 'Compare every file of a backup with the source using Get-FileHash and report what differs.', (v) => {
    const net = v.net();
    const dept = v.pick(['Finance', 'Registry', 'Exams']);
    const names = v.some(['budget.csv', 'staff.csv', 'minutes.txt', 'plan.txt', 'claims.csv', 'policy.txt', 'rooms.csv'], 5);
    const changed = names[1];
    const missing = names[3];
    const src = `C:\\Shares\\${dept}`;
    const bak = `C:\\Backup\\${dept}`;
    const files: Record<string, string> = {};
    for (const n of names) {
      files[`${src}\\${n}`] = `${n} v2\n`;
      if (n !== missing) files[`${bak}\\${n}`] = n === changed ? `${n} v1\n` : `${n} v2\n`;
    }
    const expected = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).map((n) => `${n},${n === changed ? 'Changed' : n === missing ? 'Missing' : 'OK'}`);
    return {
      instructions: lab({
        situation: `A backup you never test is a hope, not a backup. Write **C:\\Scripts\\Test-Backup.ps1 -Source DIR -Backup DIR** that compares every file in Source with the same name in Backup using **Get-FileHash** (SHA256), and writes **C:\\Reports\\backup-test.csv** with the columns **Name, Status** (Status is OK, Changed or Missing), sorted by name, without the #TYPE line. It should also exit with code **1** if anything is not OK.\n\nRun it for ${src} and ${bak}.`,
        steps: ['Loop over Get-ChildItem -File in Source.', 'Join-Path the same name in Backup; Test-Path for Missing.', 'Compare (Get-FileHash a).Hash with (Get-FileHash b).Hash.', 'Collect [pscustomobject] rows, sort, Export-Csv; exit 1 if any row is not OK.'],
        tips: ['param([string]$Source, [string]$Backup)', '(Get-FileHash $a -Algorithm SHA256).Hash', "[pscustomobject]@{ Name = $f.Name; Status = 'OK' }"],
      }),
      hints: ['Comparing sizes or dates misses files with the same size but different content; hashes do not.', 'A real restore test restores to a scratch location first, then compares like this.'],
      initialState: windows({ machines: [dc01(net)], files }),
      checks: [
        ps('Every file is classified correctly', '(Import-Csv C:\\Reports\\backup-test.csv | ForEach-Object { "$($_.Name),$($_.Status)" }) -join \';\'', { equals: expected.join(';') }),
        ps('Problems give exit code 1', `& C:\\Scripts\\Test-Backup.ps1 -Source ${src} -Backup ${bak} | Out-Null; $LASTEXITCODE`, { equals: '1' }),
        ps('A clean backup gives exit code 0', `Copy-Item ${src}\\* ${bak} -Force; & C:\\Scripts\\Test-Backup.ps1 -Source ${src} -Backup ${bak} | Out-Null; $LASTEXITCODE`, { equals: '0' }),
        ps('It compares hashes', 'Get-Content C:\\Scripts\\Test-Backup.ps1 -Raw', { contains: 'Get-FileHash' }),
      ],
      solution: [psWrite('C:\\Scripts\\Test-Backup.ps1', "param([string]$Source, [string]$Backup)\n$rows = foreach ($f in Get-ChildItem $Source -File) {\n    $copy = Join-Path $Backup $f.Name\n    if (-not (Test-Path $copy)) { $status = 'Missing' }\n    elseif ((Get-FileHash $f.FullName -Algorithm SHA256).Hash -eq (Get-FileHash $copy -Algorithm SHA256).Hash) { $status = 'OK' }\n    else { $status = 'Changed' }\n    [pscustomobject]@{ Name = $f.Name; Status = $status }\n}\nNew-Item -ItemType Directory C:\\Reports -Force | Out-Null\n$rows | Sort-Object Name | Export-Csv C:\\Reports\\backup-test.csv -NoTypeInformation\nif ($rows | Where-Object Status -ne 'OK') { exit 1 }\nexit 0"), `& C:\\Scripts\\Test-Backup.ps1 -Source ${src} -Backup ${bak}`, '$LASTEXITCODE'],
      realityNote: 'Scheduled restore tests catch the backups that "succeeded" for months while writing nothing useful; auditors increasingly ask for proof of them.',
    };
  }),

  /* ---------------------------------------------------------------- 3.5 health checks and watchdogs */
  tmpl(3, 5, 'beginner', 'disk-check-eventlog', 'Write disk warnings to the Event Log', 'E4', 20, 'Check free space with CIM and record a warning or information event that monitoring can pick up.', (v) => {
    const net = v.net();
    const source = v.pick(['LabHealth', 'ICTMonitor', 'CampusCheck']);
    const warnAt = v.pick([60, 70, 80]);
    return {
      instructions: lab({
        situation: `Monitoring reads the Application log. Write **C:\\Scripts\\Test-DiskSpace.ps1 [-ThresholdPercent N]** (default ${warnAt}) that works out the percentage of free space on C: and:\n\n- if free space is **below** the threshold, writes event **3001**, type **Warning**, message \`C: has <p>% free\` (p rounded to a whole number);\n- otherwise writes event **1000**, type **Information**, same message.\n\nUse the event source **${source}** (register it once with New-EventLog). Run the script once with the default threshold.`,
        steps: ["Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\" gives FreeSpace and Size.", 'p = [math]::Round(100 * FreeSpace / Size).', 'New-EventLog -LogName Application -Source ' + source + ' (only once).', 'Write-EventLog -LogName Application -Source ' + source + ' -EventId ... -EntryType ... -Message ...'],
        tips: ["$d = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"", `New-EventLog -LogName Application -Source ${source}`, `Get-EventLog -LogName Application -Source ${source} -Newest 1`],
      }),
      hints: ['Writing to a source that is not registered fails; registering needs administrator rights, so do it once at install time.', 'Event IDs let monitoring rules match without parsing the message.'],
      initialState: windows({ machines: [dc01(net)] }),
      checks: [
        ps('The default run wrote a warning', `$e = Get-EventLog -LogName Application -Source ${source} -Newest 1; "$($e.EventID) $($e.EntryType)"`, { equals: '3001 Warning' }),
        ps('The message gives the free percentage', `(Get-EventLog -LogName Application -Source ${source} -Newest 1).Message -eq ('C: has {0}% free' -f [math]::Round(100 * (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").Size))`, { equals: 'True' }),
        ps('A low threshold writes information', `& C:\\Scripts\\Test-DiskSpace.ps1 -ThresholdPercent 10; $e = Get-EventLog -LogName Application -Source ${source} -Newest 1; "$($e.EventID) $($e.EntryType)"`, { equals: '1000 Information' }),
      ],
      solution: [`New-EventLog -LogName Application -Source ${source}`, psWrite('C:\\Scripts\\Test-DiskSpace.ps1', `param([int]$ThresholdPercent = ${warnAt})\n$d = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"\n$p = [math]::Round(100 * $d.FreeSpace / $d.Size)\nif ($p -lt $ThresholdPercent) {\n    Write-EventLog -LogName Application -Source ${source} -EventId 3001 -EntryType Warning -Message "C: has $p% free"\n} else {\n    Write-EventLog -LogName Application -Source ${source} -EventId 1000 -EntryType Information -Message "C: has $p% free"\n}`), '& C:\\Scripts\\Test-DiskSpace.ps1', `Get-EventLog -LogName Application -Source ${source} -Newest 2`],
      realityNote: 'Writing to the Event Log lets existing tools (SCOM, Zabbix, Wazuh, event forwarding) pick up your checks without new agents or parsers.',
    };
  }),
  tmpl(3, 5, 'intermediate', 'service-watchdog', 'Write a service watchdog', 'E4', 25, 'Restart services that have stopped, log each restart to syslog and schedule the check.', (v) => {
    const net = v.net();
    const all = v.some(['apache2', 'named', 'mariadb', 'cron'], 3);
    const pkgs: Record<string, string> = { apache2: 'apache2', named: 'bind', mariadb: 'mariadb', cron: 'cronie' };
    const down = all[1];
    return {
      instructions: lab({
        situation: `Write **/usr/local/sbin/watchdog** that checks the services listed one per line in **/etc/watchdog.services**. For each one that is not active, it restarts it and logs \`restarted <name>\` with **logger -t watchdog**; if the restart fails, it logs \`FAILED to restart <name>\` and the script exits 1 at the end. Then run it every **5 minutes** from root's crontab.\n\n${down} has stopped on this server.`,
        steps: ['while read -r s; do ... done < /etc/watchdog.services', 'systemctl is-active --quiet "$s" || ...', 'systemctl restart "$s" && logger -t watchdog "restarted $s" || ...', 'Add the crontab line.'],
        tips: ['while read -r s; do\n  [ -n "$s" ] || continue\n  ...\ndone < /etc/watchdog.services', 'logger -t watchdog "restarted $s"', 'grep watchdog /var/log/messages'],
      }),
      hints: ['Skip blank lines and lines starting with # in the list.', 'A watchdog hides problems if nobody reads its log; the log line is the alert.'],
      initialState: linux(net, { packages: Object.fromEntries(all.map((s) => [pkgs[s], { installed: true }])), services: Object.fromEntries(all.map((s) => [s, { active: s !== down, enabled: true, package: pkgs[s] }])), files: { '/etc/watchdog.services': `# services the watchdog keeps running\n${all.join('\n')}\n` } }),
      checks: [
        svc(`${down} is running again`, down, { active: true }),
        out('The restart was logged', 'grep watchdog /var/log/messages', { contains: `restarted ${down}` }),
        out('Healthy services are not restarted', `systemctl stop ${all[2]}; /usr/local/sbin/watchdog; grep -c 'restarted ${all[0]}' /var/log/messages`, { equals: '0' }),
        cron('It runs every 5 minutes', 'root', '^\\*/5\\s+\\*\\s+\\*\\s+\\*\\s+\\*\\s+/usr/local/sbin/watchdog'),
        out('A service that cannot start is reported and the exit code is 1', `echo ghost >> /etc/watchdog.services; /usr/local/sbin/watchdog; echo "rc=$?"; grep watchdog /var/log/messages | tail -1`, { pattern: 'rc=1\\n.*FAILED to restart ghost' }),
      ],
      solution: [writeScript('/usr/local/sbin/watchdog', 'rc=0\nwhile read -r s; do\n  case "$s" in ""|\\#*) continue ;; esac\n  if ! systemctl is-active --quiet "$s"; then\n    if systemctl restart "$s"; then\n      logger -t watchdog "restarted $s"\n    else\n      logger -t watchdog "FAILED to restart $s"\n      rc=1\n    fi\n  fi\ndone < /etc/watchdog.services\nexit $rc\n'), 'watchdog', `echo '*/5 * * * * /usr/local/sbin/watchdog' | crontab -`, 'grep watchdog /var/log/messages'],
      realityNote: 'systemd can restart services itself (Restart=on-failure); an external watchdog is still useful for things systemd cannot see, like a service that runs but no longer answers.',
    };
  }),
  tmpl(3, 5, 'advanced', 'cert-expiry', 'Warn before certificates expire', 'E4', 30, 'Check every certificate with openssl x509 -checkend and report the ones expiring soon.', (v) => {
    const net = v.net();
    const days = v.pick([14, 30, 45]);
    const sites = v.some(['portal', 'library', 'mail', 'vpn', 'moodle', 'results'], 5);
    const iso = (d: number) => new Date(Date.UTC(2026, 9, 22, 9, 30) + d * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
    const ages = [days - 5, days + 40, 3, -2, days + 200];
    const certs = sites.map((s, i) => ({ s, notAfter: iso(ages[i]) }));
    const soon = certs.filter((_, i) => ages[i] <= days).map((c) => c.s).sort();
    return {
      instructions: lab({
        situation: `Certificates for the campus sites are in **/etc/ssl/lab/*.crt**. Write **/usr/local/sbin/check-certs** that, for each one, uses \`openssl x509 -checkend\` to see whether it expires within **${days} days**, and for each that does prints:\n\n\`EXPIRING <file name without .crt> <notAfter date as openssl prints it>\`\n\nIt exits **1** if any certificate is expiring (or already expired), **0** otherwise. Certificates that are fine print nothing.`,
        steps: [`-checkend takes seconds: ${days} days is $((${days} * 86400)).`, 'openssl x509 -noout -checkend N -in FILE exits 1 if the certificate will have expired by then.', 'openssl x509 -noout -enddate -in FILE prints notAfter=...', 'Loop with for f in /etc/ssl/lab/*.crt.'],
        tips: [`openssl x509 -noout -checkend $((${days} * 86400)) -in FILE`, 'openssl x509 -noout -enddate -in FILE | cut -d= -f2', 'basename "$f" .crt'],
      }),
      hints: ['An already-expired certificate also fails -checkend.', 'Run it from cron and mail the output: the cheapest outage prevention there is.'],
      initialState: linux(net, { packages: { openssl: { installed: true } }, files: Object.fromEntries(certs.map((c) => [`/etc/ssl/lab/${c.s}.crt`, makeCert({ subject: `CN=${c.s}.campus.lan`, notBefore: '2025-10-01T00:00:00Z', notAfter: c.notAfter, san: [`${c.s}.campus.lan`] })])) }),
      checks: [
        script('It reports exactly the expiring certificates', '/usr/local/sbin/check-certs', { status: 1, pattern: soon.map((s) => `EXPIRING ${s} \\w{3}\\s+\\d+ \\d\\d:\\d\\d:\\d\\d \\d{4} GMT`).join('\\n') }),
        script('Fine certificates are not listed', '/usr/local/sbin/check-certs', { notContains: sites.filter((s) => !soon.includes(s)).map((s) => `EXPIRING ${s} `) }),
        out('With no expiring certificates it exits 0', `rm ${soon.map((s) => `/etc/ssl/lab/${s}.crt`).join(' ')}; /usr/local/sbin/check-certs; echo "rc=$?"`, { equals: 'rc=0' }),
        file('It uses -checkend', '/usr/local/sbin/check-certs', { contains: '-checkend' }),
      ],
      solution: [writeScript('/usr/local/sbin/check-certs', `rc=0\nfor f in /etc/ssl/lab/*.crt; do\n  if ! openssl x509 -noout -checkend $((${days} * 86400)) -in "$f" >/dev/null; then\n    echo "EXPIRING $(basename "$f" .crt) $(openssl x509 -noout -enddate -in "$f" | cut -d= -f2)"\n    rc=1\n  fi\ndone\nexit $rc\n`), 'check-certs; echo $?'],
      realityNote: 'Expired certificates still cause major outages at large companies; Let\'s Encrypt\'s 90-day lifetimes make automated renewal and checks like this a necessity.',
    };
  }),
];
