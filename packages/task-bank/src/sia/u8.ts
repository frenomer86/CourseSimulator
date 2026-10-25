/** Unit 8: the automation project and its value. */

import type { Check } from '../types';
import type { TaskTemplate } from '../types';
import { PW, addOu, caseStudy, csv, dc01, file, lab, linux, out, ps, psWrite, script, tmpl, userCheck, windows, DC, write, writeScript } from './kit';

/** A Python code lab (E1). */
function py(o: { instructions: string; hints: string[]; starter: string; checks: Check[]; solution: string; realityNote: string }) {
  return { instructions: o.instructions, hints: o.hints, config: { language: 'python' }, initialState: { language: 'python', source: o.starter }, checks: [{ type: 'code.runs', label: 'The program runs' }, ...o.checks], solution: [o.solution], realityNote: o.realityNote };
}

export const U8: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 8.1 designing an end-to-end workflow */
  tmpl(8, 1, 'beginner', 'design-the-workflow', 'Design an end-to-end automation', 'E10', 20, 'Decide the order, data flow, failure handling and ownership of an onboarding-to-reporting workflow.', (v) => {
    const n = v.int(80, 400);
    return caseStudy(v, {
      intro: `## From a spreadsheet to a working account\n\nEvery term about ${n} new students and staff need accounts, home folders, backups and a report for management. Today it is done by hand from an HR spreadsheet. You are designing the automated workflow.`,
      steps: [
        { title: 'The source of truth', text: 'Names arrive in an HR spreadsheet that people edit by hand, with typos and duplicates.', choices: [{ text: 'Define one input format (CSV with fixed columns), validate every row first, and send rejects back to HR', right: true, feedback: 'Correct. Garbage in, garbage out: validation at the entrance protects every later step.' }, { text: 'Let the script guess what malformed rows meant', feedback: 'Guessing creates wrong accounts silently.' }, { text: 'Fix the spreadsheet by hand every time', feedback: 'That is the manual work you are removing.' }] },
        { title: 'Order of steps', text: 'Steps: create account, create home folder, set quota, add to groups, send welcome letter, report.', choices: [{ text: 'Account, then groups, home folder and quota, then the letter, and the report last from what actually happened', right: true, feedback: 'Correct. Each step depends on the one before; the report reads results, not intentions.' }, { text: 'Send the welcome letter first so people are informed early', feedback: 'They would be told about an account that may not exist yet.' }, { text: 'Order does not matter in automation', feedback: 'Dependencies are exactly what a workflow must respect.' }] },
        { title: 'A step fails halfway', text: 'The home-folder step fails for 3 people because the file server is full.', choices: [{ text: 'Stop those 3, record why, carry on with the rest, and make re-running safe so the 3 complete later', right: true, feedback: 'Correct. Idempotent steps plus a clear record turn failures into a re-run.' }, { text: 'Delete everything created in this run and start again tomorrow', feedback: 'Rolling back 300 good accounts for 3 failures wastes the run.' }, { text: 'Ignore the failure; the report will show it', feedback: 'Only if the report reads real state; failures need explicit handling.' }] },
        { title: 'Secrets', text: 'The workflow needs a service account to create users.', choices: [{ text: 'A dedicated least-privilege account whose credential lives in a vault, not in the script', right: true, feedback: 'Correct. Rotate it without changing code, and audit what it does.' }, { text: 'The administrator\'s own account, typed into the script', feedback: 'Everyone who reads the script gets your rights.' }, { text: 'Domain Admin, to avoid permission errors', feedback: 'Permission errors are information; Domain Admin removes the safety net.' }] },
        { title: 'Ownership', text: 'The workflow will run every term for years.', choices: [{ text: 'Keep it in version control with a runbook, a named owner and tests, and review changes', right: true, feedback: 'Correct. Automation is software and needs the same care.' }, { text: 'Leave it on your laptop where it works', feedback: 'It stops working when you leave.' }, { text: 'Write it once and never touch it again', feedback: 'Systems around it change every year.' }] },
      ],
      ending: { title: 'A workflow that lasts', text: 'Validated input, dependency order, idempotent steps with recorded failures, least-privilege secrets, and an owner with version control and a runbook.' },
      hints: ['Ask: what happens on the second run, and what happens when one step fails?', 'The report should read what the system now looks like.'],
      realityNote: 'Identity-management products (Microsoft Entra provisioning, midPoint) encode exactly this pipeline; a scripted version teaches the moving parts.',
    });
  }),
  tmpl(8, 1, 'intermediate', 'resumable-pipeline', 'Run steps in order and resume after a failure', 'E4', 30, 'Write a pipeline runner that records completed steps and resumes from the first failed one.', (v) => {
    const net = v.net();
    const steps = ['10-validate', '20-accounts', '30-homes', '40-report'];
    const failing = v.pick(['30-homes', '20-accounts']);
    return {
      instructions: lab({
        situation: `**/opt/onboard/steps/** holds executable step scripts named \`10-validate\`, \`20-accounts\`, \`30-homes\`, \`40-report\`. Write **/usr/local/sbin/onboard-run** that:\n\n1. runs the steps in **name order**;\n2. after each **successful** step, appends its name to **/var/lib/onboard/done**;\n3. **skips** steps already listed in that file (so a re-run resumes);\n4. stops at the first failing step, prints \`failed at <step>\` and exits **1**;\n5. when everything has run, prints \`all steps done\` and exits 0.\n\nToday **${failing}** fails until /opt/onboard/fixed exists. Run the pipeline, fix the problem (\`touch /opt/onboard/fixed\`), and run it again.`,
        steps: ['for s in /opt/onboard/steps/*; do name=$(basename "$s"); ... done (globs sort by name)', 'grep -qxF "$name" /var/lib/onboard/done && continue', 'if "$s"; then echo "$name" >> done; else echo "failed at $name"; exit 1; fi'],
        tips: ['mkdir -p /var/lib/onboard; touch /var/lib/onboard/done', 'grep -qxF "$name" /var/lib/onboard/done && continue'],
      }),
      hints: ['Recording progress outside the script turns a crash into a resume, not a restart.', 'Each step should itself be idempotent, in case it ran halfway.'],
      initialState: linux(net, { files: Object.fromEntries(steps.map((s) => [`/opt/onboard/steps/${s}`, { content: s === failing ? `#!/bin/bash\n[ -e /opt/onboard/fixed ] || { echo "${s}: file server full" >&2; exit 1; }\necho "${s} ok" >> /var/log/onboard.log\n` : `#!/bin/bash\necho "${s} ok" >> /var/log/onboard.log\n`, mode: '755' }])) as never }),
      checks: [
        file('Every step ran exactly once, in order', '/var/log/onboard.log', { equals: steps.map((s) => `${s} ok`).join('\n') }),
        file('Progress is recorded', '/var/lib/onboard/done', { equals: steps.join('\n') }),
        script('A run with nothing left to do succeeds', '/usr/local/sbin/onboard-run', { status: 0, contains: 'all steps done' }),
        out('A failure stops the run with exit 1', `rm /var/lib/onboard/done /opt/onboard/fixed; /usr/local/sbin/onboard-run; echo "rc=$?"`, { contains: [`failed at ${failing}`, 'rc=1'] }),
      ],
      solution: [writeScript('/usr/local/sbin/onboard-run', 'mkdir -p /var/lib/onboard\ndone_file=/var/lib/onboard/done\ntouch "$done_file"\nfor s in /opt/onboard/steps/*; do\n  name=$(basename "$s")\n  grep -qxF "$name" "$done_file" && continue\n  if "$s"; then\n    echo "$name" >> "$done_file"\n  else\n    echo "failed at $name"\n    exit 1\n  fi\ndone\necho "all steps done"\n'), 'onboard-run', 'touch /opt/onboard/fixed', 'onboard-run'],
      realityNote: 'Checkpointed pipelines are how CI systems, Ansible (--start-at-task) and data pipelines avoid re-doing finished work after a failure.',
    };
  }),
  tmpl(8, 1, 'advanced', 'onboarding-pipeline', 'Build an onboarding pipeline end to end', 'E4', 40, 'Validate a CSV, create AD users and home folders, and write a run report, with -WhatIf and a re-runnable design.', (v) => {
    const net = v.net();
    const dept = v.pick(['Finance', 'Registry', 'Library']);
    const people = v.people(4);
    const bad = v.person();
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\Invoke-Onboarding.ps1 -Path CSV [-WhatIf]** (SupportsShouldProcess) that takes the HR file (GivenName, Surname, SamAccountName, Department) and, for each row:\n\n1. **validates** it: SamAccountName of 3-20 lowercase letters/digits and a Department that exists as an OU under **OU=Staff,${DC}**; invalid rows get status \`Rejected\`;\n2. skips users that already exist (status \`Exists\`);\n3. otherwise creates the user in **OU=<Department>,OU=Staff** (enabled, password ${PW}, change at logon) and the folder **C:\\Home\\<sam>** (status \`Created\`).\n\nIt writes **C:\\Reports\\onboarding.csv** (SamAccountName, Status) and with -WhatIf changes nothing. Run it on **C:\\HR\\term-intake.csv**.`,
        steps: ['Get-ADOrganizationalUnit -Filter * -SearchBase "OU=Staff,..." tells you which departments exist.', 'Validate with -cmatch \'^[a-z0-9]{3,20}$\'.', 'ShouldProcess around New-ADUser and New-Item.', 'Collect a [pscustomobject] per row, then Export-Csv.'],
        tips: ["$depts = (Get-ADOrganizationalUnit -Filter * -SearchBase 'OU=Staff," + DC + "' -SearchScope OneLevel).Name", "if ($PSCmdlet.ShouldProcess($sam, 'Create user and home folder')) { ... }"],
      }),
      hints: ['Report what happened to every row, including rejects; HR needs the list back.', 'With SupportsShouldProcess, -WhatIf also applies to New-ADUser and New-Item inside.'],
      initialState: windows({ machines: [dc01(net)], ad: (st) => { const staff = addOu(st, 'Staff'); addOu(st, dept, staff); addOu(st, 'Estates', staff); }, files: { 'C:\\HR\\term-intake.csv': csv('GivenName,Surname,SamAccountName,Department', [...people.map((p) => [p.given, p.surname, p.sam, dept]), [bad.given, bad.surname, `${bad.sam.toUpperCase()}!`, dept], ['Esi', 'Mensah', 'emensah2', 'Astrology']]) } }),
      checks: [
        userCheck('The valid users were created in the department OU', { sams: people.map((p) => p.sam), enabled: true, ou: `OU=${dept},OU=Staff,${DC}` }),
        ps('Home folders exist', people.map((p) => `(Test-Path C:\\Home\\${p.sam})`).join(' -and '), { equals: 'True' }),
        ps('The report has a status for every row', "(Import-Csv C:\\Reports\\onboarding.csv | ForEach-Object { \"$($_.SamAccountName)=$($_.Status)\" }) -join ';'", { equals: [...people.map((p) => `${p.sam}=Created`), `${bad.sam.toUpperCase()}!=Rejected`, 'emensah2=Rejected'].join(';') }),
        ps('A re-run reports Exists and creates nothing new', "& C:\\Scripts\\Invoke-Onboarding.ps1 -Path C:\\HR\\term-intake.csv | Out-Null; @(Import-Csv C:\\Reports\\onboarding.csv | Where-Object Status -eq 'Exists').Count", { equals: String(people.length) }),
        ps('-WhatIf changes nothing', `Remove-ADUser ${people[0].sam} -Confirm:$false; Remove-Item C:\\Home\\${people[0].sam} -Recurse -Force; & C:\\Scripts\\Invoke-Onboarding.ps1 -Path C:\\HR\\term-intake.csv -WhatIf | Out-Null; $n = @(Get-ADUser -Filter "SamAccountName -eq '${people[0].sam}'").Count; "$n $(Test-Path C:\\Home\\${people[0].sam})"`, { equals: '0 False' }),
      ],
      solution: [psWrite('C:\\Scripts\\Invoke-Onboarding.ps1', `[CmdletBinding(SupportsShouldProcess)]\nparam([Parameter(Mandatory)][string]$Path)\n$pw = ConvertTo-SecureString '${PW}' -AsPlainText -Force\n$depts = (Get-ADOrganizationalUnit -Filter * -SearchBase 'OU=Staff,${DC}' -SearchScope OneLevel).Name\n$report = foreach ($r in Import-Csv $Path) {\n    $sam = $r.SamAccountName\n    if ($sam -cnotmatch '^[a-z0-9]{3,20}$' -or $depts -notcontains $r.Department) { $status = 'Rejected' }\n    elseif (Get-ADUser -Filter "SamAccountName -eq '$sam'") { $status = 'Exists' }\n    elseif ($PSCmdlet.ShouldProcess($sam, 'Create user and home folder')) {\n        New-ADUser -Name "$($r.GivenName) $($r.Surname)" -GivenName $r.GivenName -Surname $r.Surname -SamAccountName $sam -Department $r.Department -Path "OU=$($r.Department),OU=Staff,${DC}" -AccountPassword $pw -Enabled $true -ChangePasswordAtLogon $true\n        New-Item -ItemType Directory -Path "C:\\Home\\$sam" -Force | Out-Null\n        $status = 'Created'\n    } else { $status = 'WhatIf' }\n    [pscustomobject]@{ SamAccountName = $sam; Status = $status }\n}\nif (-not $WhatIfPreference) {\n    New-Item -ItemType Directory C:\\Reports -Force | Out-Null\n    $report | Export-Csv C:\\Reports\\onboarding.csv -NoTypeInformation\n}\n$report`), '& C:\\Scripts\\Invoke-Onboarding.ps1 -Path C:\\HR\\term-intake.csv -WhatIf', '& C:\\Scripts\\Invoke-Onboarding.ps1 -Path C:\\HR\\term-intake.csv'],
      realityNote: 'Validate, act idempotently, preview with -WhatIf and report every row: these four habits are what make a bulk script trustworthy enough to hand over.',
    };
  }),

  /* ---------------------------------------------------------------- 8.2 documentation */
  tmpl(8, 2, 'beginner', 'usage-text', 'Give a script proper usage text', 'E4', 15, 'Add -h/--help usage text to stdout, usage errors to stderr with exit code 2, and a header comment.', (v) => {
    const net = v.net();
    const name = v.pick(['mkshare', 'archive-dept', 'reset-lab']);
    const usage = `usage: ${name} [-n] DEPARTMENT`;
    return {
      instructions: lab({
        situation: `**/usr/local/sbin/${name}** works but nobody knows how to call it. Add:\n\n- a **header comment** after the shebang: one line saying what it does, then lines starting \`# Usage:\` and \`# Example:\`;\n- \`-h\` or \`--help\` prints the usage text **to standard output** and exits **0**; its first line is exactly \`${usage}\`;\n- calling it with no department prints the same usage line **to standard error** and exits **2**.\n\nThe existing behaviour (\`${name} DEPARTMENT\` prints \`done DEPARTMENT\`, \`-n\` prints \`would do DEPARTMENT\`) must not change.`,
        steps: ['usage() { echo "...";  echo "  -n  dry run"; }', 'case "${1:-}" in -h|--help) usage; exit 0 ;; esac', '[ $# -ge 1 ] || { usage >&2; exit 2; }'],
        tips: ['usage() {\n  cat <<EOF\n' + usage + '\n  -n          show what would happen\n  -h, --help  show this help\nEOF\n}'],
      }),
      hints: ['Help that was asked for goes to stdout (so it can be paged); usage after a mistake goes to stderr.', 'Exit code 2 is the convention for "wrong usage".'],
      initialState: linux(net, { files: { [`/usr/local/sbin/${name}`]: { content: '#!/bin/bash\nif [ "$1" = -n ]; then\n  echo "would do $2"\nelse\n  echo "done $1"\nfi\n', mode: '755' } } }),
      checks: [
        script('--help prints usage and exits 0', `/usr/local/sbin/${name}`, { args: ['--help'], status: 0, pattern: `^${usage.replace(/[[\]]/g, '\\$&')}` }),
        script('-h works too', `/usr/local/sbin/${name}`, { args: ['-h'], status: 0, contains: usage }),
        out('No argument: usage on stderr, exit 2', `/usr/local/sbin/${name} 2>/dev/null; echo "rc=$?"; /usr/local/sbin/${name} 2>&1 >/dev/null | head -1`, { equals: `rc=2\n${usage}` }),
        script('The normal behaviour is unchanged', `/usr/local/sbin/${name}`, { args: ['-n', 'library'], equals: 'would do library' }),
        file('There is a header comment with usage and example', `/usr/local/sbin/${name}`, { pattern: '^#!/bin/bash\\n# .+\\n(#.*\\n)*# Usage:[\\s\\S]*# Example:' }),
      ],
      solution: [writeScript(`/usr/local/sbin/${name}`, `# ${name}: prepare a department's area (or show what would be done with -n).\n# Usage: ${name} [-n] DEPARTMENT\n# Example: ${name} -n finance\nusage() {\n  cat <<USAGE\n${usage}\n  -n          show what would happen\n  -h, --help  show this help\nUSAGE\n}\ncase "\${1:-}" in -h|--help) usage; exit 0 ;; esac\n[ $# -ge 1 ] || { usage >&2; exit 2; }\nif [ "$1" = -n ]; then\n  echo "would do $2"\nelse\n  echo "done $1"\nfi\n`), `${name} --help`],
      realityNote: 'Usage text is the documentation people actually read; it costs minutes to write and saves every future user from reading the code.',
    };
  }),
  tmpl(8, 2, 'intermediate', 'comment-based-help', 'Write comment-based help for a PowerShell function', 'E4', 20, 'Add .SYNOPSIS, .DESCRIPTION, .PARAMETER and .EXAMPLE help that Get-Help displays.', (v) => {
    const net = v.net();
    const fn = v.pick(['Get-StaleAccount', 'Get-QuotaUsage', 'Get-LabPrinterStatus']);
    const param = v.pick(['Days', 'Threshold', 'Site']);
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Tools.ps1** defines **${fn}** with a parameter **-${param}**, but Get-Help ${fn} shows nothing useful. Add **comment-based help** inside the function with:\n\n- \`.SYNOPSIS\` (one line);\n- \`.DESCRIPTION\`;\n- \`.PARAMETER ${param}\`;\n- at least one \`.EXAMPLE\` showing a real call.\n\nDot-source the file and check with \`Get-Help ${fn} -Full\` and \`Get-Help ${fn} -Examples\`.`,
        steps: ['Put a <# ... #> block as the first thing inside the function body.', 'Each keyword starts a line with a dot: .SYNOPSIS, then the text on the following lines.', `Get-Help ${fn} -Examples`],
        tips: [`<#\n.SYNOPSIS\nOne line.\n.DESCRIPTION\nWhat it does and why.\n.PARAMETER ${param}\nWhat the parameter means.\n.EXAMPLE\n${fn} -${param} 90\n#>`],
      }),
      hints: ['Get-Help reads these blocks; no separate documentation file is needed.', 'Examples are the most read part of any help.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\Tools.ps1': `function ${fn} {\n    [CmdletBinding()]\n    param([string]$${param} = '90')\n    "checking with ${param} = $${param}"\n}\n` } }),
      checks: [
        ps('The synopsis shows', `. C:\\Scripts\\Tools.ps1; (Get-Help ${fn}).Synopsis`, { pattern: '\\w+\\s+\\w+' }),
        ps('The parameter is described', `. C:\\Scripts\\Tools.ps1; Get-Help ${fn} -Full | Out-String`, { contains: [`-${param}`, 'DESCRIPTION'] }),
        ps('There is an example with a real call', `. C:\\Scripts\\Tools.ps1; Get-Help ${fn} -Examples | Out-String`, { contains: `${fn} -${param}` }),
        ps('The function still works', `. C:\\Scripts\\Tools.ps1; ${fn} -${param} 30`, { equals: `checking with ${param} = 30` }),
      ],
      solution: [psWrite('C:\\Scripts\\Tools.ps1', `function ${fn} {\n    <#\n    .SYNOPSIS\n    Reports items that need attention.\n    .DESCRIPTION\n    Checks the lab estate and lists what needs attention, using ${param} as the limit.\n    .PARAMETER ${param}\n    The limit to check against.\n    .EXAMPLE\n    ${fn} -${param} 30\n    #>\n    [CmdletBinding()]\n    param([string]$${param} = '90')\n    "checking with ${param} = $${param}"\n}`), `. C:\\Scripts\\Tools.ps1; Get-Help ${fn} -Full`],
      realityNote: 'Comment-based help travels with the code and appears in Get-Help, editors and generated documentation sites (platyPS).',
    };
  }),
  tmpl(8, 2, 'advanced', 'write-a-runbook', 'Write a runbook for an automated job', 'E4', 25, 'Document a backup job so someone else can run, verify and recover it at 2 a.m.', (v) => {
    const net = v.net();
    const job = v.pick(['backup-finance', 'backup-registry', 'backup-library']);
    const dept = job.split('-')[1];
    const owner = v.person();
    return {
      instructions: lab({
        situation: `The job **/usr/local/sbin/${job}** runs nightly from **${job}.timer** and writes archives to /backup. You are going on leave. Write **/srv/runbooks/${job}.md** (Markdown) so a colleague can handle it, with these headings, in this order:\n\n- \`# ${job}\`\n- \`## Purpose\`\n- \`## Schedule\` (name the timer and the time from its OnCalendar)\n- \`## Run it by hand\` (the exact command)\n- \`## Check it worked\` (commands that show the last run and verify the archive checksum)\n- \`## When it fails\` (where the log is, and what to try)\n- \`## Restore\` (the tar command to restore a file to /tmp/restore)\n- \`## Owner\` (${owner.name}, ${owner.sam}@campus.lan)\n\nUse real commands from this server, in code blocks.`,
        steps: [`systemctl cat ${job}.timer shows the schedule.`, `Read /usr/local/sbin/${job} to see where it logs and what it writes.`, 'Write the file with an editor or a here-document.'],
        tips: [`systemctl cat ${job}.timer`, `journalctl -u ${job}`, `sha256sum -c /backup/${dept}-YYYY-MM-DD.tar.gz.sha256`, `tar -xzf /backup/${dept}-YYYY-MM-DD.tar.gz -C /tmp/restore`],
      }),
      hints: ['Write for a tired colleague at 2 a.m.: commands they can copy, in the order they need them.', 'A runbook is tested by having someone else follow it.'],
      initialState: linux(net, { files: { [`/usr/local/sbin/${job}`]: { content: `#!/bin/bash\nset -euo pipefail\nname=${dept}-$(date +%F).tar.gz\ntar -czf /backup/$name -C /srv ${dept}\ncd /backup && sha256sum $name > $name.sha256\nlogger -t ${job} "wrote $name"\n`, mode: '755' }, [`/etc/systemd/system/${job}.service`]: `[Unit]\nDescription=Nightly ${dept} backup\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/${job}\n`, [`/etc/systemd/system/${job}.timer`]: `[Unit]\nDescription=Run ${job} nightly\n\n[Timer]\nOnCalendar=*-*-* 01:30:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n` } }),
      checks: [
        file('The headings are there, in order', `/srv/runbooks/${job}.md`, { pattern: `^# ${job}\\n[\\s\\S]*^## Purpose[\\s\\S]*^## Schedule[\\s\\S]*^## Run it by hand[\\s\\S]*^## Check it worked[\\s\\S]*^## When it fails[\\s\\S]*^## Restore[\\s\\S]*^## Owner` }),
        file('The schedule names the timer and time', `/srv/runbooks/${job}.md`, { contains: [`${job}.timer`, '01:30'] }),
        file('It has the commands to run, verify and restore', `/srv/runbooks/${job}.md`, { contains: [`/usr/local/sbin/${job}`, 'sha256sum -c', 'tar -xzf', '/tmp/restore', '```'] }),
        file('It says where to look when it fails', `/srv/runbooks/${job}.md`, { pattern: `journalctl[^\\n]*${job}|grep[^\\n]*${job}[^\\n]*/var/log/messages` }),
        file('The owner is named', `/srv/runbooks/${job}.md`, { contains: [owner.name, `${owner.sam}@campus.lan`] }),
      ],
      solution: ['mkdir -p /srv/runbooks', write(`/srv/runbooks/${job}.md`, `# ${job}\n\n## Purpose\n\nNightly archive of /srv/${dept} to /backup, with a SHA-256 checksum next to each archive.\n\n## Schedule\n\n${job}.timer runs ${job}.service every night at 01:30 (OnCalendar=*-*-* 01:30:00, Persistent=true).\n\n## Run it by hand\n\n\`\`\`\nsudo systemctl start ${job}.service\n\`\`\`\n\nor run the script directly: \`sudo /usr/local/sbin/${job}\`.\n\n## Check it worked\n\n\`\`\`\nsystemctl list-timers ${job}.timer\njournalctl -u ${job}\ncd /backup && sha256sum -c ${dept}-$(date +%F).tar.gz.sha256\n\`\`\`\n\n## When it fails\n\nRead \`journalctl -u ${job}\` and \`grep ${job} /var/log/messages\`. Usual causes: /backup full (\`df -h /backup\`), /srv/${dept} missing. Fix, then run it by hand.\n\n## Restore\n\n\`\`\`\nmkdir -p /tmp/restore\ntar -xzf /backup/${dept}-YYYY-MM-DD.tar.gz -C /tmp/restore\n\`\`\`\n\nCopy the needed file back from /tmp/restore and check its owner and mode.\n\n## Owner\n\n${owner.name}, ${owner.sam}@campus.lan\n`), `cat /srv/runbooks/${job}.md`],
      realityNote: 'Runbooks turn one person\'s knowledge into a team procedure; incident reviews often find the missing runbook, not the bug, was the real problem.',
    };
  }),

  /* ---------------------------------------------------------------- 8.3 measuring value */
  tmpl(8, 3, 'beginner', 'is-it-worth-it', 'Estimate the value of an automation', 'E10', 15, 'Work through time saved, error reduction and payback for a school lab and a small ISP.', (v) => {
    const mins = v.pick([10, 15, 20]);
    const runs = v.pick([40, 60, 120]);
    const build = v.pick([16, 24, 40]);
    const saved = (mins * runs) / 60;
    const payback = Math.ceil(build / saved);
    return caseStudy(v, {
      intro: `## Is it worth automating?\n\nReimaging a lab PC by hand takes **${mins} minutes**; the lab reimages about **${runs} PCs a month**. Writing and testing the automation would take about **${build} hours**.`,
      steps: [
        { title: 'Time saved', text: 'How much technician time does automation save per month, if the automated run needs no attention?', choices: [{ text: `About ${saved % 1 ? saved.toFixed(1) : saved} hours (${mins} minutes × ${runs} PCs ÷ 60)`, right: true, feedback: 'Correct. Count the hands-on time removed, not the machine time.' }, { text: `${mins * runs} hours`, feedback: 'That is minutes, not hours.' }, { text: `${build} hours`, feedback: 'That is the cost of building it.' }] },
        { title: 'Payback', text: 'Ignoring maintenance, when does the build time pay for itself?', choices: [{ text: `After about ${payback} month${payback > 1 ? 's' : ''} (${build} hours ÷ ${saved % 1 ? saved.toFixed(1) : saved} hours a month)`, right: true, feedback: 'Correct. After that every month is profit, as long as maintenance stays small.' }, { text: 'Never: automation always costs more', feedback: 'Not for a repetitive task this frequent.' }, { text: 'Immediately', feedback: 'The build hours come first.' }] },
        { title: 'Hidden value', text: 'By hand, about 1 PC in 20 is set up slightly wrong and causes a helpdesk call later.', choices: [{ text: 'Count the avoided errors too: fewer calls and consistent machines are value, not just speed', right: true, feedback: 'Correct. Consistency often matters more than speed.' }, { text: 'Errors are not part of the calculation', feedback: 'They cost time and goodwill; include them.' }, { text: 'Automation makes the same errors faster', feedback: 'Only if it is untested; tested automation makes the same correct result.' }] },
        { title: 'Maintenance', text: 'Each Windows feature update needs about 3 hours of changes to the automation.', choices: [{ text: 'Subtract that from the savings: payback moves later, but the case still holds if savings stay larger', right: true, feedback: 'Correct. Honest estimates include upkeep.' }, { text: 'Ignore it, it is small', feedback: 'Small recurring costs add up over years.' }, { text: 'Stop automating because it needs maintenance', feedback: 'Everything needs maintenance; compare it with the savings.' }] },
        { title: 'A small ISP', text: 'A small ISP adds about 3 new customer routers a year, each taking 2 hours by hand. A provisioning system would take 60 hours to build.', choices: [{ text: 'Probably not worth fully automating yet: write a checklist or template, and revisit when volume grows', right: true, feedback: 'Correct. 6 hours a year will not repay 60 hours for a decade.' }, { text: 'Automate everything: automation is always better', feedback: 'Value depends on frequency and cost.' }, { text: 'Hire someone to do it by hand', feedback: 'A checklist is cheaper and reduces errors now.' }] },
      ],
      ending: { title: 'Value, measured', text: 'Hours saved per month, payback time including maintenance, and errors avoided, compared honestly with how often the task really happens.' },
      hints: ['Value = (time saved + errors avoided) − (build + maintenance).', 'Frequency is the biggest factor.'],
      realityNote: 'The well-known "Is it worth the time?" chart (xkcd 1205) makes the same point: how often and how much time you save decide what is worth automating.',
    });
  }),
  tmpl(8, 3, 'intermediate', 'time-saved-from-logs', 'Measure time saved from job logs', 'E4', 25, 'Count successful automated runs per job from logs and turn them into hours saved.', (v) => {
    const net = v.net();
    const jobs = v.some([{ j: 'reset-password', m: 6 }, { j: 'new-account', m: 20 }, { j: 'printer-fix', m: 12 }, { j: 'share-access', m: 15 }], 3);
    const lines: string[] = [];
    const ok: Record<string, number> = {};
    for (let i = 0; i < 30; i++) {
      const job = jobs[i % 3].j;
      const fine = v.random() > 0.15;
      if (fine) ok[job] = (ok[job] ?? 0) + 1;
      lines.push(`2026-10-${String(1 + (i % 21)).padStart(2, '0')}T0${8 + (i % 2)}:${String(10 + i).padStart(2, '0')}:00 ${job} ${fine ? 'exit=0' : 'exit=1'}`);
    }
    const rows = jobs.map((x) => ({ ...x, runs: ok[x.j] ?? 0 })).map((x) => ({ ...x, minutes: x.runs * x.m })).sort((a, b) => b.minutes - a.minutes || a.j.localeCompare(b.j));
    const total = rows.reduce((s, r) => s + r.minutes, 0);
    return {
      instructions: lab({
        situation: `**/var/log/jobs.log** records every run of the helpdesk automations as \`TIME JOB exit=CODE\`. **/etc/automation/minutes.csv** says how many minutes each job saves compared with doing it by hand. Write **/root/value-report.txt** for this month (October 2026) with one line per job, \`JOB RUNS MINUTES\` (only **successful** runs count; minutes = runs × minutes saved), largest MINUTES first, then a last line \`total_hours H\` with the total in hours, rounded to one decimal.`,
        steps: ['Count exit=0 lines per job: grep exit=0 | awk \'{print $2}\' | sort | uniq -c', 'Join with the minutes file (awk with two inputs, or a loop).', 'Sort by the third column numerically, descending.', 'Add the total line with awk printf "%.1f".'],
        tips: ["awk -F, 'NR == FNR { m[$1] = $2; next } $3 == \"exit=0\" { c[$2]++ } END { for (j in c) print j, c[j], c[j] * m[j] }' /etc/automation/minutes.csv FS=' ' /var/log/jobs.log", 'sort -k3,3nr -k1,1'],
      }),
      hints: ['Failed runs saved no time; some cost time.', 'awk "NR == FNR" is true only while reading the first file.'],
      initialState: linux(net, { files: { '/var/log/jobs.log': lines.join('\n') + '\n', '/etc/automation/minutes.csv': jobs.map((x) => `${x.j},${x.m}`).join('\n') + '\n' } }),
      checks: [file('The report is right', '/root/value-report.txt', { equals: [...rows.map((r) => `${r.j} ${r.runs} ${r.minutes}`), `total_hours ${(Math.round((total / 60) * 10) / 10).toFixed(1)}`].join('\n') })],
      solution: ["awk -F, 'NR == FNR { m[$1] = $2; next } { split($0, f, \" \") } f[3] == \"exit=0\" { c[f[2]]++ } END { for (j in m) print j, c[j] + 0, (c[j] + 0) * m[j] }' /etc/automation/minutes.csv /var/log/jobs.log | sort -k3,3nr -k1,1 > /root/value-report.txt", "awk '{ t += $3 } END { printf \"total_hours %.1f\\n\", t / 60 }' /root/value-report.txt >> /root/value-report.txt", 'cat /root/value-report.txt'],
      realityNote: 'Numbers from real logs beat estimates in any budget meeting; a monthly value report keeps automation work funded.',
    };
  }),
  tmpl(8, 3, 'advanced', 'python-payback', 'Model the payback of an automation in Python', 'E1', 25, 'Write functions for monthly savings and payback month, including maintenance and avoided errors.', (v) => {
    const cost = v.pick([10, 12, 15]);
    return py({
      instructions: `## When does it pay back?\n\nWrite two functions (all times in hours unless named otherwise):\n\n1. **monthly_saving(minutes_per_run, runs_per_month, error_rate_before, hours_per_error, maintenance_hours_per_month)** returns the hours saved each month: the hands-on time removed (minutes × runs ÷ 60) **plus** the errors avoided (runs × error rate × hours per error, assuming automation removes those errors) **minus** maintenance. Round to 2 decimals.\n2. **payback_month(build_hours, saving_per_month)** returns the first whole month in which the total saving reaches the build cost (1 for the first month), or **None** if the saving is zero or negative.\n\nFor example, 15 minutes × 60 runs is 15 hours a month; with a 5% error rate costing 1 hour each that is 3 more; minus 2 hours of maintenance gives **16.0**. A ${cost * 4}-hour build then pays back in month ${Math.ceil((cost * 4) / 16)}.`,
      hints: ['math.ceil(build / saving) gives the month directly.', 'Test the edge cases: no saving, and a build that pays back exactly at the end of a month.'],
      starter: 'import math\n\ndef monthly_saving(minutes_per_run, runs_per_month, error_rate_before, hours_per_error, maintenance_hours_per_month):\n    return 0\n\ndef payback_month(build_hours, saving_per_month):\n    return None\n\nprint(monthly_saving(15, 60, 0.05, 1, 2))\n',
      checks: [
        { type: 'code.function', label: 'monthly_saving is right', name: 'monthly_saving', tolerance: 0.001, cases: [{ args: [15, 60, 0.05, 1, 2], expected: 16 }, { args: [6, 120, 0.02, 0.5, 3], expected: 10.2 }, { args: [10, 4, 0, 0, 1], expected: -0.33 }, { args: [20, 30, 0.1, 2, 0], expected: 16 }] },
        { type: 'code.function', label: 'payback_month is right', name: 'payback_month', cases: [{ args: [cost * 4, 16], expected: Math.ceil((cost * 4) / 16) }, { args: [32, 16], expected: 2 }, { args: [33, 16], expected: 3 }, { args: [10, 0], expected: null }, { args: [10, -0.33], expected: null }] },
      ],
      solution: 'import math\n\ndef monthly_saving(minutes_per_run, runs_per_month, error_rate_before, hours_per_error, maintenance_hours_per_month):\n    hands_on = minutes_per_run * runs_per_month / 60\n    errors = runs_per_month * error_rate_before * hours_per_error\n    return round(hands_on + errors - maintenance_hours_per_month, 2)\n\ndef payback_month(build_hours, saving_per_month):\n    if saving_per_month <= 0:\n        return None\n    return math.ceil(build_hours / saving_per_month)\n',
      realityNote: 'A tiny model like this, filled in with measured numbers, is usually enough to justify (or kill) an automation project.',
    });
  }),

  /* ---------------------------------------------------------------- 8.4 when not to automate */
  tmpl(8, 4, 'beginner', 'rare-tasks', 'Decide what not to automate', 'E10', 15, 'Judge rare, risky and changing tasks where automation costs more than it saves.', (v) => {
    const rare = v.pick(['renewing the domain controller\'s certificate authority (every 5 years)', 'migrating the student records database to a new server (once)', 'rebuilding the core switch configuration after a hardware swap (once in a decade)']);
    return caseStudy(v, {
      intro: '## Not everything should be a script\n\nYour manager wants "everything automated". Decide for each task.',
      steps: [
        { title: 'A very rare task', text: `The task is ${rare}.`, choices: [{ text: 'Write a careful, tested checklist (runbook) and practise it; full automation would be stale by the next time', right: true, feedback: 'Correct. Rare tasks rarely repay automation, and the environment will have changed.' }, { text: 'Automate it fully so nobody has to remember', feedback: 'The script would break silently on the changed environment it never ran against.' }, { text: 'Do it from memory', feedback: 'Memory fades in five years; write it down.' }] },
        { title: 'A task that keeps changing', text: 'A department changes its report layout every few weeks.', choices: [{ text: 'Automate the stable part (collecting data), keep the layout simple to change, or agree a stable format first', right: true, feedback: 'Correct. Automate what is stable; churn makes scripts expensive.' }, { text: 'Rewrite the script every few weeks', feedback: 'The maintenance eats the savings.' }, { text: 'Refuse to produce the report', feedback: 'Find the stable part instead.' }] },
        { title: 'A judgement call', text: 'Deciding whether a suspicious login is an attack needs context: travel, new devices, the user\'s role.', choices: [{ text: 'Automate gathering the evidence and alerting; keep the decision with a person', right: true, feedback: 'Correct. Automation prepares; people judge the ambiguous cases.' }, { text: 'Automatically lock every account with an unusual login', feedback: 'False positives would lock out travelling staff during exams.' }, { text: 'Ignore it unless users complain', feedback: 'Then you only hear about successful attacks.' }] },
        { title: 'One-time data clean-up', text: 'Once, you need to fix 40 wrongly named shares.', choices: [{ text: 'A quick, reviewed one-off script with a dry run is fine; do not build a reusable tool', right: true, feedback: 'Correct. 40 by hand risks typos; a throw-away script with a dry run is the sweet spot.' }, { text: 'Build a general share-management product', feedback: 'Far more work than the problem.' }, { text: 'Fix them by hand without checking', feedback: '40 manual edits invite mistakes.' }] },
      ],
      ending: { title: 'Automate where it pays', text: 'Runbooks for rare tasks, automation of stable parts, people for judgement, and throw-away scripts for one-off fixes.' },
      hints: ['Frequency, stability and the cost of a wrong decision decide.', 'A checklist is automation for humans.'],
      realityNote: 'Google\'s SRE book calls repetitive manual work "toil" and targets it; it also warns that automating rare, changing tasks creates more work than it removes.',
    });
  }),
  tmpl(8, 4, 'intermediate', 'maintainability-review', 'Review a script for handover', 'E10', 20, 'Judge whether an inherited script is maintainable, and what must change before handover.', (v) => {
    const lines = v.int(400, 900);
    return caseStudy(v, {
      intro: `## The script only one person understands\n\nA colleague is leaving. Their ${lines}-line script runs the whole term start-up. You are reviewing it before handover.`,
      steps: [
        { title: 'Hard-coded values', text: 'Server names, paths and a password are written all through the code.', choices: [{ text: 'Move them into a configuration file and a secret store, read at the top', right: true, feedback: 'Correct. Then changing a server is a data change, and the password is not in the code.' }, { text: 'Leave them; they work today', feedback: 'They will not work after the next server change.' }, { text: 'Add comments next to each one', feedback: 'Comments do not remove the password from the file.' }] },
        { title: 'No tests', text: 'Nobody can change the script without fear because there are no tests.', choices: [{ text: 'Add tests for the riskiest parts first (naming, validation, deletion), then refactor', right: true, feedback: 'Correct. Tests make change safe; start where bugs would hurt most.' }, { text: 'Rewrite it from scratch now', feedback: 'A rewrite without tests repeats old bugs and adds new ones.' }, { text: 'Freeze it forever', feedback: 'The environment around it keeps changing.' }] },
        { title: 'One giant function', text: 'Everything is in one block with no functions.', choices: [{ text: 'Split it into named functions for each step, so each can be tested and reused', right: true, feedback: 'Correct. Small functions are easier to read, test and change.' }, { text: 'It runs, so structure does not matter', feedback: 'It matters to the next person reading it.' }, { text: 'Convert it to another language', feedback: 'That is a project, not a handover fix.' }] },
        { title: 'Who owns it now', text: 'After handover, problems go "to whoever is around".', choices: [{ text: 'Name an owner and a backup, put it in version control, and link the runbook from the job', right: true, feedback: 'Correct. Unowned automation decays quietly.' }, { text: 'The original author can be phoned', feedback: 'They have left.' }, { text: 'Whoever notices a failure fixes it', feedback: 'That means nobody does until it is urgent.' }] },
      ],
      ending: { title: 'Ready to hand over', text: 'Configuration and secrets out of the code, tests on the risky parts, readable functions, version control, a runbook and a named owner.' },
      hints: ['Ask: could a competent stranger change this safely next year?', 'Maintainability is a property of the code and of the people around it.'],
      realityNote: 'The "bus factor" (how many people can leave before nobody understands a system) is a standard risk in IT teams; documentation and shared ownership raise it.',
    });
  }),
  tmpl(8, 4, 'advanced', 'automation-risk', 'Weigh automation risk against benefit', 'E10', 25, 'Decide safeguards for automations that can do damage at scale.', (v) => {
    const n = v.int(800, 3000);
    return caseStudy(v, {
      intro: `## Automation multiplies mistakes too\n\nA script that disables leavers runs nightly against ${n} accounts. One wrong line could disable everyone before breakfast.`,
      steps: [
        { title: 'Blast radius', text: 'HR\'s export arrives empty one night because of a system error.', choices: [{ text: 'Add a sanity limit: if the change would affect more than a small percentage, stop and alert a person', right: true, feedback: 'Correct. A circuit breaker turns a catastrophe into an email.' }, { text: 'Trust the input; HR owns it', feedback: 'An empty file would mean "everyone left".' }, { text: 'Run it weekly instead of nightly', feedback: 'That delays the damage, it does not prevent it.' }] },
        { title: 'Reversibility', text: 'Should the script delete accounts of leavers?', choices: [{ text: 'Disable and move them first; delete only after a retention period, in a separate reviewed step', right: true, feedback: 'Correct. Prefer reversible actions in automation.' }, { text: 'Delete at once to keep the directory clean', feedback: 'A mistake would be unrecoverable without a full restore.' }, { text: 'Never remove leavers', feedback: 'Dormant accounts are a security risk.' }] },
        { title: 'Visibility', text: 'How will anyone know what the script did last night?', choices: [{ text: 'An append-only audit log with the reason for each change, and a daily summary to the team', right: true, feedback: 'Correct. Transparency builds trust in automation.' }, { text: 'Check the directory if someone complains', feedback: 'Then mistakes are discovered by victims.' }, { text: 'Print to the console', feedback: 'Nobody watches the console at 2 a.m.' }] },
        { title: 'Change control', text: 'A colleague wants to "quickly fix" the script on the server.', choices: [{ text: 'Changes go through version control, review and a test run with -WhatIf before deployment', right: true, feedback: 'Correct. The bigger the blast radius, the more process the change deserves.' }, { text: 'Let them; it is a small fix', feedback: 'Small fixes to high-impact automation are how outages start.' }, { text: 'Lock the script so nobody can ever change it', feedback: 'Then it cannot be fixed when it must be.' }] },
      ],
      ending: { title: 'Safe at scale', text: 'Sanity limits, reversible actions, audit logs with summaries, and reviewed, tested changes for anything that acts on many accounts.' },
      hints: ['Ask: what is the worst this can do in one run, and how would we find out?', 'Reversible beats fast.'],
      realityNote: 'Large outages at major cloud providers have been caused by automation acting on bad input at scale; rate limits and circuit breakers are now standard practice.',
    });
  }),
];

