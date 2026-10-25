/** Unit 2: PowerShell for administration. */

import type { TaskTemplate } from '../types';
import { APP_SERVICES, RUNNING, STOPPED_AUTO, STOPPED_MANUAL, answer, csv, dc01, dcServices, lab, nic, ps, psWrite, ran, tmpl, windows } from './kit';

const DEPT_CODES: Record<string, string> = { Finance: 'FIN', Registry: 'REG', Library: 'LIB', Estates: 'EST', Research: 'RES', Examinations: 'EXM', Admissions: 'ADM', Procurement: 'PRC', 'Human Resources': 'HRM', 'Health Services': 'HSV' };
const NOW = Date.UTC(2026, 9, 22, 9, 30);
const day = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoDaysAgo = (n: number) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
/** .NET Math.Round(x, 1): midpoints go to the even digit. */
const round1 = (x: number) => {
  const t = x * 10;
  const f = Math.floor(t);
  const r = Math.abs(t - f - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(t);
  return r / 10;
};
const MKDIR = (...dirs: string[]) => `New-Item -ItemType Directory ${dirs.join(', ')} -Force | Out-Null`;

export const U2: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 2.1 cmdlets, Get-Help, Get-Member, the object pipeline */
  tmpl(2, 1, 'beginner', 'discover-cmdlets', 'Discover cmdlets and properties', 'E4', 15, 'Use Get-Command, Get-Member and the pipeline to answer questions about the services on a server.', (v) => {
    const net = v.net();
    const verb = v.pick([{ verb: 'Stop', does: 'stops' }, { verb: 'Restart', does: 'restarts' }, { verb: 'Start', does: 'starts' }]);
    const extra = v.some(Object.keys(APP_SERVICES), 4);
    const stopped = extra.slice(0, v.int(1, 3));
    const services = dcServices(Object.fromEntries(extra.map((s) => [s, stopped.includes(s) ? STOPPED_MANUAL : RUNNING])));
    const nStopped = Object.values(services).filter((s) => s.status === 'Stopped').length;
    return {
      instructions: lab({
        situation: `You are new to PowerShell and want to learn by asking it questions. Write **C:\\Answers\\services.txt** with exactly three lines:\n\n- \`Cmdlet: <the cmdlet that ${verb.does} a service>\`\n- \`Property: <the service property that says whether it starts at boot>\`\n- \`Stopped: <how many services on this server are stopped>\`\n\nFind every answer with PowerShell itself: Get-Command, Get-Member and a pipeline.`,
        steps: ['List the cmdlets whose noun is Service.', 'Pipe Get-Service to Get-Member and read the property names.', 'Count the stopped services with Where-Object and .Count (or Measure-Object).', 'Create C:\\Answers and write the three lines with Set-Content.'],
        tips: ['Get-Command -Noun Service', 'Get-Service | Get-Member -MemberType Property', "(Get-Service | Where-Object Status -eq 'Stopped').Count", 'Set-Content C:\\Answers\\services.txt -Value "Cmdlet: ...","Property: ...","Stopped: ..."'],
      }),
      hints: ['Cmdlet names are Verb-Noun; the verb tells you what it does.', 'Get-Member lists what an object has; the boot setting is not called Status.'],
      initialState: windows({ machines: [dc01(net, { services })] }),
      checks: [answer('The cmdlet is right', 'C:\\Answers\\services.txt', `Cmdlet: ${verb.verb}-Service`), answer('The property is right', 'C:\\Answers\\services.txt', 'Property: StartType'), answer('The count of stopped services is right', 'C:\\Answers\\services.txt', `Stopped: ${nStopped}`)],
      solution: ['Get-Command -Noun Service', 'Get-Service | Get-Member -MemberType Property', "$n = (Get-Service | Where-Object Status -eq 'Stopped').Count", MKDIR('C:\\Answers'), `Set-Content C:\\Answers\\services.txt -Value "Cmdlet: ${verb.verb}-Service","Property: StartType","Stopped: $n"`],
      realityNote: 'Get-Command, Get-Help and Get-Member are how experienced administrators learn unfamiliar modules too: PowerShell describes itself.',
    };
  }),
  tmpl(2, 1, 'intermediate', 'objects-not-text', 'Report broken services as objects', 'E4', 20, 'Filter service objects by two properties and export a CSV report, without parsing text.', (v) => {
    const net = v.net();
    const broken = v.some(Object.keys(APP_SERVICES), v.int(2, 3));
    const fine = v.some(Object.keys(APP_SERVICES).filter((s) => !broken.includes(s)), 2);
    const manual = fine[1];
    const services = dcServices({ ...Object.fromEntries(broken.map((s) => [s, STOPPED_AUTO])), [fine[0]]: RUNNING, [manual]: STOPPED_MANUAL });
    const report = v.pick(['C:\\Reports\\stopped-auto.csv', 'C:\\Reports\\services-down.csv', 'C:\\Ops\\autostart-problems.csv']);
    return {
      instructions: lab({
        situation: `After a power cut some services did not come back. Services set to start **Automatic**ally that are **not Running** are a problem; Manual services that are stopped are normal. Export the problem services to **${report}** with the columns **Name, Status, StartType** (in that order), without the #TYPE line.`,
        steps: ['Get-Service gives objects with Status and StartType properties.', 'Filter on both properties with Where-Object.', 'Choose the columns with Select-Object and write the file with Export-Csv -NoTypeInformation.', 'Check the file with Import-Csv.'],
        tips: ["Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' }", 'Select-Object Name, Status, StartType', `Export-Csv ${report} -NoTypeInformation`],
      }),
      hints: ['No string parsing is needed: compare properties.', `${manual} is stopped but Manual, so it is not a problem.`],
      initialState: windows({ machines: [dc01(net, { services })] }),
      checks: [
        ps('The report lists exactly the problem services', `(Import-Csv ${report} | ForEach-Object Name | Sort-Object) -join ','`, { equals: [...broken].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())).join(',') }),
        ps('The columns are Name, Status, StartType', `(Get-Content ${report})[0]`, { equals: '"Name","Status","StartType"', message: 'The first line should be the header "Name","Status","StartType". Use Select-Object in that order and -NoTypeInformation.' }),
      ],
      solution: [MKDIR(report.slice(0, report.lastIndexOf('\\'))), `Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' } | Select-Object Name, Status, StartType | Export-Csv ${report} -NoTypeInformation`, `Import-Csv ${report}`],
      realityNote: 'Because PowerShell passes objects, the filter keeps working when column widths, languages or output formats change, which breaks text-scraping scripts.',
    };
  }),
  tmpl(2, 1, 'advanced', 'pipeline-by-property-name', 'Bind CSV columns to parameters by name', 'E4', 25, 'Start services listed in a CSV in one pipeline, renaming a column so it binds to -Name.', (v) => {
    const net = v.net();
    const list = v.some(Object.keys(APP_SERVICES), 3);
    const other = Object.keys(APP_SERVICES).find((s) => !list.includes(s))!;
    const col = v.pick(['ServiceName', 'Service', 'Svc']);
    const services = dcServices({ ...Object.fromEntries(list.map((s) => [s, STOPPED_MANUAL])), [other]: STOPPED_MANUAL });
    const file = v.pick(['C:\\Ops\\start-list.csv', 'C:\\Ops\\after-patching.csv']);
    return {
      instructions: lab({
        situation: `After patching, the services in **${file}** must be started. The file's column is called **${col}**, but Start-Service binds pipeline objects to **-Name** by a property called *Name*. Start them all in **one pipeline without ForEach-Object**: import the CSV, rename the column with a calculated property, and pipe straight into Start-Service with -PassThru so you can see the result. Leave ${other} stopped.`,
        steps: ['Look at the file with Import-Csv.', 'Read Get-Help Start-Service -Parameter Name: it accepts pipeline input ByPropertyName.', `Rename with Select-Object @{Name='Name'; Expression={$_.${col}}}.`, 'Pipe into Start-Service -PassThru.'],
        tips: [`Import-Csv ${file}`, `Import-Csv ${file} | Select-Object @{Name='Name'; Expression={$_.${col}}} | Start-Service -PassThru`],
      }),
      hints: ['Binding by property name means: a property with the same name as the parameter fills that parameter.', 'Without renaming, Start-Service does not know which property holds the service name.'],
      initialState: windows({ machines: [dc01(net, { services })], files: { [file]: csv(`${col},Reason`, list.map((s) => [s, 'patched'])) } }),
      checks: [
        ...list.map((s) => ps(`${s} is running`, `(Get-Service ${s}).Status`, { equals: 'Running' })),
        ps(`${other} was left alone`, `(Get-Service ${other}).Status`, { equals: 'Stopped' }),
        ran('One pipeline from Import-Csv into Start-Service', 'Import-Csv[^\\n]*\\|[^\\n]*Select-Object[^\\n]*\\|\\s*Start-Service', 'Use one pipeline: Import-Csv | Select-Object @{...} | Start-Service.'),
      ],
      solution: [`Import-Csv ${file}`, `Import-Csv ${file} | Select-Object @{Name='Name'; Expression={$_.${col}}} | Start-Service -PassThru`],
      realityNote: 'Pipeline binding by property name is why CSV-driven administration is so short in PowerShell: match the column names to the parameter names and the loop disappears.',
    };
  }),

  /* ---------------------------------------------------------------- 2.2 Where-Object, Select-Object, Sort-Object, Group-Object, calculated properties */
  tmpl(2, 2, 'beginner', 'filter-staff-list', 'Filter, choose columns and sort', 'E4', 15, 'Produce a department contact list from a staff CSV with Where-Object, Select-Object and Sort-Object.', (v) => {
    const net = v.net();
    const depts = v.depts(3);
    const people = v.people(10).map((p, i) => ({ ...p, dept: depts[i % 3], phone: `030 2${v.int(10, 99)} ${v.int(1000, 9999)}` }));
    const dept = depts[0];
    const out = `C:\\Reports\\${dept.replace(/\s+/g, '')}-contacts.csv`;
    const mine = people.filter((p) => p.dept === dept).sort((a, b) => a.surname.localeCompare(b.surname) || a.given.localeCompare(b.given));
    return {
      instructions: lab({
        situation: `**C:\\Data\\staff.csv** lists every member of staff. The head of **${dept}** wants a contact list: only their staff, with the columns **Surname, GivenName, Phone**, sorted by surname. Save it as **${out}** without the #TYPE line.`,
        steps: ['Import the CSV and look at its columns.', `Keep the ${dept} rows with Where-Object.`, 'Pick the three columns with Select-Object.', 'Sort by Surname, then GivenName, and export.'],
        tips: ['Import-Csv C:\\Data\\staff.csv | Select-Object -First 3', `Where-Object Department -eq '${dept}'`, 'Sort-Object Surname, GivenName', `Export-Csv ${out} -NoTypeInformation`],
      }),
      hints: ['Select-Object before Export-Csv decides the columns and their order.', 'Sort-Object takes several properties: the second breaks ties in the first.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Data\\staff.csv': csv('GivenName,Surname,Department,Phone,Email', people.map((p) => [p.given, p.surname, p.dept, p.phone, `${p.sam}@campus.local`])) } }),
      checks: [
        ps('Only the department, sorted by surname', `(Import-Csv ${out} | ForEach-Object { "$($_.Surname) $($_.GivenName)" }) -join ';'`, { equals: mine.map((p) => `${p.surname} ${p.given}`).join(';') }),
        ps('The columns are Surname, GivenName, Phone', `(Get-Content ${out})[0]`, { equals: '"Surname","GivenName","Phone"' }),
      ],
      solution: [MKDIR('C:\\Reports'), `Import-Csv C:\\Data\\staff.csv | Where-Object Department -eq '${dept}' | Sort-Object Surname, GivenName | Select-Object Surname, GivenName, Phone | Export-Csv ${out} -NoTypeInformation`],
      realityNote: 'Filter early, select late: removing rows first and choosing columns last is both faster and easier to read.',
    };
  }),
  tmpl(2, 2, 'intermediate', 'laptop-age', 'Add calculated properties', 'E4', 20, 'Compute each laptop\'s age from its purchase date and list those due for replacement.', (v) => {
    const net = v.net();
    const years = v.pick([3, 4, 5]);
    const people = v.people(9);
    const rows = people.map((p, i) => ({ tag: `LT-${v.int(1000, 9999)}-${i}`, user: p.sam, bought: isoDaysAgo(v.int(200, 2700)) }));
    const age = (iso: string) => Math.floor(Math.floor((NOW - day(iso)) / 86400000) / 365);
    const due = rows.filter((r) => age(r.bought) >= years).sort((a, b) => age(b.bought) - age(a.bought) || a.tag.localeCompare(b.tag));
    if (!due.length) rows[0].bought = isoDaysAgo(years * 365 + 40);
    const due2 = rows.filter((r) => age(r.bought) >= years).sort((a, b) => age(b.bought) - age(a.bought) || a.tag.localeCompare(b.tag));
    return {
      instructions: lab({
        situation: `**C:\\Data\\laptops.csv** has Tag, User and PurchaseDate (yyyy-MM-dd). Laptops **${years} or more whole years old** are due for replacement. Write **C:\\Reports\\replace.csv** with the columns **Tag, User, AgeYears**, oldest first (ties by Tag), without the #TYPE line. AgeYears is the number of whole years: the days since purchase divided by 365, rounded down.`,
        steps: ['Work out the age of one laptop: ((Get-Date) - [datetime]$row.PurchaseDate).Days.', 'Add AgeYears with a calculated property and [math]::Floor.', `Keep laptops with AgeYears -ge ${years}, sort and export.`],
        tips: ["Select-Object Tag, User, @{Name='AgeYears'; Expression={ [math]::Floor(((Get-Date) - [datetime]$_.PurchaseDate).Days / 365) }}", 'Sort-Object @{Expression="AgeYears"; Descending=$true}, Tag'],
      }),
      hints: ['CSV values are text: [datetime] turns "2021-03-05" into a date you can subtract.', 'Subtracting two dates gives a TimeSpan; .Days is whole days.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Data\\laptops.csv': csv('Tag,User,PurchaseDate', rows.map((r) => [r.tag, r.user, r.bought])) } }),
      checks: [ps('The laptops due, oldest first, with their age', `(Import-Csv C:\\Reports\\replace.csv | ForEach-Object { "$($_.Tag)=$($_.AgeYears)" }) -join ';'`, { equals: due2.map((r) => `${r.tag}=${age(r.bought)}`).join(';') })],
      solution: [MKDIR('C:\\Reports'), `Import-Csv C:\\Data\\laptops.csv | Select-Object Tag, User, @{Name='AgeYears'; Expression={ [math]::Floor(((Get-Date) - [datetime]$_.PurchaseDate).Days / 365) }} | Where-Object AgeYears -ge ${years} | Sort-Object @{Expression='AgeYears'; Descending=$true}, Tag | Export-Csv C:\\Reports\\replace.csv -NoTypeInformation`],
      realityNote: 'Calculated properties turn raw inventory into decisions; asset tools such as Snipe-IT and Intune reports compute the same kind of age and warranty columns.',
    };
  }),
  tmpl(2, 2, 'advanced', 'tickets-by-category', 'Group and measure helpdesk tickets', 'E4', 25, 'Summarise tickets per category with Group-Object, Measure-Object and calculated properties.', (v) => {
    const net = v.net();
    const cats = v.some(['Password', 'Printer', 'Network', 'Email', 'Projector', 'Software', 'Hardware'], 4);
    const techs = v.people(3).map((p) => p.sam);
    let rows: Array<{ id: number; cat: string; min: number; tech: string }> = [];
    let ok = false;
    while (!ok) {
      rows = Array.from({ length: 16 }, (_, i) => ({ id: 4100 + i, cat: cats[i % cats.length], min: v.int(5, 90), tech: v.pick(techs) }));
      const totals = cats.map((c) => rows.filter((r) => r.cat === c).reduce((s, r) => s + r.min, 0));
      ok = new Set(totals).size === totals.length && cats.every((c) => { const n = rows.filter((r) => r.cat === c).length; const t = rows.filter((r) => r.cat === c).reduce((s, r) => s + r.min, 0); return Math.abs(((t * 10) / n) % 1 - 0.5) > 1e-9; });
    }
    const summary = cats.map((c) => { const g = rows.filter((r) => r.cat === c); const t = g.reduce((s, r) => s + r.min, 0); return { c, n: g.length, t, avg: round1(t / g.length) }; }).sort((a, b) => b.t - a.t);
    return {
      instructions: lab({
        situation: `**C:\\Helpdesk\\tickets.csv** has Id, Category, Minutes and Technician for last month's tickets. Management wants **C:\\Reports\\by-category.csv** with one row per category and the columns **Category, Tickets, TotalMinutes, AverageMinutes** (average rounded to 1 decimal place), the category with the most total minutes first, without the #TYPE line.`,
        steps: ['Group the tickets with Group-Object Category.', 'For each group, $_.Count is the number of tickets and $_.Group holds the rows.', '($_.Group | Measure-Object Minutes -Sum -Average) gives Sum and Average.', 'Build the columns with Select-Object and calculated properties, sort, export.'],
        tips: ['Import-Csv C:\\Helpdesk\\tickets.csv | Group-Object Category', "Select-Object @{n='Category';e={$_.Name}}, @{n='Tickets';e={$_.Count}}, @{n='TotalMinutes';e={($_.Group | Measure-Object Minutes -Sum).Sum}}", '[math]::Round($x, 1)'],
      }),
      hints: ['Group-Object puts the shared value in .Name.', 'Measure-Object converts the text in the Minutes column to numbers for you.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Helpdesk\\tickets.csv': csv('Id,Category,Minutes,Technician', rows.map((r) => [r.id, r.cat, r.min, r.tech])) } }),
      checks: [ps('One row per category with the right figures, busiest first', `(Import-Csv C:\\Reports\\by-category.csv | ForEach-Object { "$($_.Category),$($_.Tickets),$($_.TotalMinutes),$($_.AverageMinutes)" }) -join ';'`, { equals: summary.map((s) => `${s.c},${s.n},${s.t},${s.avg}`).join(';') })],
      solution: [MKDIR('C:\\Reports'), "Import-Csv C:\\Helpdesk\\tickets.csv | Group-Object Category | Select-Object @{n='Category';e={$_.Name}}, @{n='Tickets';e={$_.Count}}, @{n='TotalMinutes';e={($_.Group | Measure-Object Minutes -Sum).Sum}}, @{n='AverageMinutes';e={[math]::Round(($_.Group | Measure-Object Minutes -Average).Average, 1)}} | Sort-Object TotalMinutes -Descending | Export-Csv C:\\Reports\\by-category.csv -NoTypeInformation"],
      realityNote: 'Group, measure, sort is the shape of most operational reports; the same pipeline answers "which category costs us most time?" for any CSV export.',
    };
  }),

  /* ---------------------------------------------------------------- 2.3 variables, arrays, hashtables, strings, here-strings */
  tmpl(2, 3, 'beginner', 'department-codes', 'Look values up in a hashtable', 'E4', 15, 'Write a script that maps department names to codes with a hashtable and handles unknown names.', (v) => {
    const net = v.net();
    const depts = v.some(Object.keys(DEPT_CODES), 5);
    const unknown = v.pick(['Catering', 'Transport', 'Security', 'Sports']);
    return {
      instructions: lab({
        situation: `Account names and file shares use short department codes. Write **C:\\Scripts\\Get-DeptCode.ps1** with a parameter **-Department** that prints the code from this table, and \`UNKNOWN\` for a department not in it:\n\n${depts.map((d) => `- ${d} = ${DEPT_CODES[d]}`).join('\n')}\n\nThe lookup must not care about upper or lower case.`,
        steps: ['Start the script with param([string]$Department).', 'Store the table in a hashtable: $codes = @{ Finance = \'FIN\'; ... } (quote names that contain spaces).', 'Use $codes.ContainsKey($Department) to choose between the code and UNKNOWN.', 'Test it with several names.'],
        tips: ["$codes = @{ 'Finance' = 'FIN'; 'Human Resources' = 'HRM' }", 'if ($codes.ContainsKey($Department)) { $codes[$Department] } else { \'UNKNOWN\' }', "C:\\Scripts\\Get-DeptCode.ps1 -Department 'finance'"],
      }),
      hints: ['PowerShell hashtables ignore case in their keys by default.', 'A missing key gives $null, which prints nothing; test for it.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\README.txt': 'Scripts for the ICT office.\n' } }),
      checks: [
        ps(`${depts[0]} gives ${DEPT_CODES[depts[0]]}`, `C:\\Scripts\\Get-DeptCode.ps1 -Department '${depts[0]}'`, { equals: DEPT_CODES[depts[0]] }),
        ps('Case does not matter', `C:\\Scripts\\Get-DeptCode.ps1 -Department '${depts[1].toUpperCase()}'`, { equals: DEPT_CODES[depts[1]] }),
        ps(`${depts[4]} gives ${DEPT_CODES[depts[4]]}`, `C:\\Scripts\\Get-DeptCode.ps1 -Department '${depts[4]}'`, { equals: DEPT_CODES[depts[4]] }),
        ps('An unknown department gives UNKNOWN', `C:\\Scripts\\Get-DeptCode.ps1 -Department '${unknown}'`, { equals: 'UNKNOWN' }),
      ],
      solution: [psWrite('C:\\Scripts\\Get-DeptCode.ps1', `param([string]$Department)\n$codes = @{\n${depts.map((d) => `    '${d}' = '${DEPT_CODES[d]}'`).join('\n')}\n}\nif ($codes.ContainsKey($Department)) { $codes[$Department] } else { 'UNKNOWN' }`), `C:\\Scripts\\Get-DeptCode.ps1 -Department '${depts[0]}'`],
      realityNote: 'Lookup tables in hashtables (or loaded from a CSV with a loop) keep naming rules in one place instead of in a chain of if statements.',
    };
  }),
  tmpl(2, 3, 'intermediate', 'generate-usernames', 'Generate usernames with string methods', 'E4', 20, 'Build clean, unique usernames from names with -replace, ToLower, Substring and a loop.', (v) => {
    const net = v.net();
    const rule = v.pick([{ text: 'the first letter of the given name followed by the surname', ex: (g: string, s: string) => g[0] + s }, { text: 'the given name, a dot, then the surname', ex: (g: string, s: string) => `${g}.${s}` }]);
    const max = v.pick([12, 15, 20]);
    const clean = (x: string) => x.replace(/[^a-zA-Z.]/g, '').toLowerCase();
    const make = (g: string, s: string) => clean(rule.ex(g.replace(/[^a-zA-Z]/g, ''), s.replace(/[^a-zA-Z]/g, ''))).slice(0, max);
    const p = v.people(3);
    const tricky = { g: v.pick(['Mary-Jane', 'Abena', 'Kwame']), s: v.pick(["O'Neil", 'Asante-Darko', 'Van der Puije']) };
    const taken = [make(p[0].given, p[0].surname), `${make(p[0].given, p[0].surname)}2`, make(p[1].given, p[1].surname)];
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\New-Username.ps1 -GivenName X -Surname Y** that prints a username built as **${rule.text}**:\n\n- lower case, with spaces, hyphens and apostrophes removed;\n- at most **${max}** characters (cut longer ones);\n- unique: if the name is already in **C:\\Data\\taken.txt** (one per line), add 2, then 3, and so on, until it is free.\n\nFor example, ${p[0].given} ${p[0].surname} is taken twice already, so it must get \`${taken[0]}3\`.`,
        steps: ['Remove unwanted characters with -replace \'[^a-zA-Z]\', \'\'.', 'Join the parts, then .ToLower().', 'Cut with .Substring(0, [math]::Min($max, $name.Length)).', 'Load the taken names with Get-Content and loop with while until the name is free.'],
        tips: ["$g = $GivenName -replace '[^a-zA-Z]', ''", '$taken = Get-Content C:\\Data\\taken.txt', '$n = 2; while ($taken -contains $candidate) { $candidate = "$base$n"; $n++ }'],
      }),
      hints: ['-contains checks whether an array holds a value (ignoring case).', 'Cut the base name before adding the number.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Data\\taken.txt': taken.join('\n') + '\n', 'C:\\Scripts\\README.txt': 'Scripts for the ICT office.\n' } }),
      checks: [
        ps('A free name is used as it is', `C:\\Scripts\\New-Username.ps1 -GivenName '${p[2].given}' -Surname '${p[2].surname}'`, { equals: make(p[2].given, p[2].surname) }),
        ps('Hyphens, apostrophes and spaces are removed', `C:\\Scripts\\New-Username.ps1 -GivenName '${tricky.g}' -Surname "${tricky.s}"`, { equals: make(tricky.g, tricky.s) }),
        ps('A taken name gets a number', `C:\\Scripts\\New-Username.ps1 -GivenName '${p[1].given}' -Surname '${p[1].surname}'`, { equals: `${make(p[1].given, p[1].surname)}2` }),
        ps('Numbers count up until the name is free', `C:\\Scripts\\New-Username.ps1 -GivenName '${p[0].given}' -Surname '${p[0].surname}'`, { equals: `${taken[0]}3` }),
        ps(`Long names are cut to ${max} characters`, "C:\\Scripts\\New-Username.ps1 -GivenName 'Oluwaseyifunmi' -Surname 'Adebayo-Ogunleye'", { equals: make('Oluwaseyifunmi', 'Adebayo-Ogunleye') }),
      ],
      solution: [psWrite('C:\\Scripts\\New-Username.ps1', `param([string]$GivenName, [string]$Surname)\n$g = $GivenName -replace '[^a-zA-Z]', ''\n$s = $Surname -replace '[^a-zA-Z]', ''\n$base = ${rule.text.startsWith('the first') ? '($g.Substring(0, 1) + $s)' : '"$g.$s"'}.ToLower()\n$base = $base.Substring(0, [math]::Min(${max}, $base.Length))\n$taken = Get-Content C:\\Data\\taken.txt\n$candidate = $base\n$n = 2\nwhile ($taken -contains $candidate) {\n    $candidate = "$base$n"\n    $n++\n}\n$candidate`), `C:\\Scripts\\New-Username.ps1 -GivenName '${p[0].given}' -Surname '${p[0].surname}'`],
      realityNote: 'Naming rules are where bulk account scripts usually go wrong: apostrophes, double-barrelled surnames and collisions all appear in real class lists.',
    };
  }),
  tmpl(2, 3, 'advanced', 'welcome-letters', 'Fill a template with an expandable here-string', 'E4', 25, 'Generate one welcome letter per new member of staff from a CSV with a here-string and date formatting.', (v) => {
    const net = v.net();
    const people = v.people(4).map((p) => ({ ...p, dept: v.dept(), start: `2026-11-${String(v.int(2, 27)).padStart(2, '0')}`, manager: v.person().name }));
    const org = v.pick(['the ICT Directorate', 'Campus Services', 'the Registry Office']);
    const fmt = (iso: string) => { const d = new Date(day(iso)); return `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]} ${d.getUTCDate()} ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
    const letter = (p: (typeof people)[number]) => [`Dear ${p.given},`, '', `Welcome to ${p.dept}. Your first day is ${fmt(p.start)}.`, `Your manager is ${p.manager}.`, '', `${org}`];
    const target = people[2];
    return {
      instructions: lab({
        situation: `For each row of **C:\\HR\\new-staff.csv** (GivenName, Surname, Department, StartDate, Manager), write **C:\\Letters\\<givenname>.<surname>.txt** (lower case) containing exactly:\n\n\`\`\`\nDear <GivenName>,\n\nWelcome to <Department>. Your first day is <StartDate as "Monday 2 November 2026">.\nYour manager is <Manager>.\n\n${org}\n\`\`\`\n\nUse one expandable here-string (@" ... "@) as the template.`,
        steps: ['Loop over the rows with foreach.', 'Format the date with ([datetime]$row.StartDate).ToString(\'dddd d MMMM yyyy\').', 'Build the text with @" ... "@; $($row.GivenName) puts a property inside it.', 'Write each letter with Set-Content.'],
        tips: ['foreach ($row in Import-Csv C:\\HR\\new-staff.csv) { ... }', "$when = ([datetime]$row.StartDate).ToString('dddd d MMMM yyyy')", '$text = @"\nDear $($row.GivenName),\n"@'],
      }),
      hints: ['In a here-string, "@ must be at the very start of its own line.', 'Inside double quotes, $row.GivenName prints the whole row followed by .GivenName; use $($row.GivenName).'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\HR\\new-staff.csv': csv('GivenName,Surname,Department,StartDate,Manager', people.map((p) => [p.given, p.surname, p.dept, p.start, p.manager])) } }),
      checks: [
        ps('One letter per new member of staff', '(Get-ChildItem C:\\Letters -Filter *.txt).Count', { equals: String(people.length) }),
        ps(`${target.given}'s letter is filled in correctly`, `(Get-Content C:\\Letters\\${target.given.toLowerCase()}.${target.surname.toLowerCase()}.txt) -join '|'`, { equals: letter(target).join('|') }),
      ],
      solution: [MKDIR('C:\\Letters'), `foreach ($row in Import-Csv C:\\HR\\new-staff.csv) {\n    $when = ([datetime]$row.StartDate).ToString('dddd d MMMM yyyy')\n    $text = @"\nDear $($row.GivenName),\n\nWelcome to $($row.Department). Your first day is $when.\nYour manager is $($row.Manager).\n\n${org}\n"@\n    Set-Content -Path "C:\\Letters\\$($row.GivenName.ToLower()).$($row.Surname.ToLower()).txt" -Value $text\n}`],
      realityNote: 'Here-string templates generate letters, e-mails, configuration files and HTML reports; for bigger documents the same idea scales to templating engines.',
    };
  }),

  /* ---------------------------------------------------------------- 2.4 functions and advanced functions */
  tmpl(2, 4, 'beginner', 'first-function', 'Write a function with a default parameter', 'E4', 15, 'Put a disk-space calculation in a function in a script file and dot-source it.', (v) => {
    const net = v.net();
    const unit = v.pick([{ u: 'GB', div: '1GB' }, { u: 'MB', div: '1MB' }]);
    const name = `Get-FreeSpace${unit.u}`;
    const file = v.pick(['C:\\Scripts\\DiskTools.ps1', 'C:\\Scripts\\StorageTools.ps1']);
    return {
      instructions: lab({
        situation: `Write **${file}** containing a function **${name}** with one parameter, **-Drive**, defaulting to \`C\`. It returns the free space of that drive in **${unit.u}**, rounded to 1 decimal place, as a number. Load it into your session with dot-sourcing and try it.`,
        steps: [`Find the value: Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'" has a FreeSpace property in bytes.`, `Divide by ${unit.div} and round with [math]::Round(x, 1).`, `Wrap it in function ${name} { param([string]$Drive = 'C') ... }.`, `Dot-source with . ${file} and run ${name}.`],
        tips: [`Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"`, `function ${name} {\n    param([string]$Drive = 'C')\n    ...\n}`, `. ${file}`],
      }),
      hints: ['Without the dot, running the file defines the function in the script\'s own scope, which disappears when it ends.', 'Inside the filter string, use "DeviceID=\'$($Drive):\'".'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\README.txt': 'Scripts for the ICT office.\n' } }),
      checks: [
        ps(`${name} returns the free space in ${unit.u}`, `. ${file}; (${name}) -eq [math]::Round((Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / ${unit.div}, 1)`, { equals: 'True' }),
        ps('-Drive works', `. ${file}; (${name} -Drive C) -eq (${name})`, { equals: 'True' }),
        ps('It returns a number, not text', `. ${file}; (${name}) -is [double]`, { equals: 'True' }),
      ],
      solution: [psWrite(file, `function ${name} {\n    param([string]$Drive = 'C')\n    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($Drive):'"\n    [math]::Round($disk.FreeSpace / ${unit.div}, 1)\n}`), `. ${file}`, name],
      realityNote: 'Returning numbers rather than formatted text lets other code compare, sort and alert on the result; formatting is the last step, done by whoever displays it.',
    };
  }),
  tmpl(2, 4, 'intermediate', 'validated-parameters', 'Validate parameters with attributes', 'E4', 20, 'Write an advanced function with mandatory, pattern, set and range validation.', (v) => {
    const net = v.net();
    const progs = v.some(['BSc-CS', 'BSc-IT', 'HND-CS', 'BTech-IT', 'Diploma-ICT'], 3);
    const digits = v.pick([8, 10]);
    const id = String(v.int(10 ** (digits - 1), 10 ** digits - 1));
    const year = v.int(1, 4);
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\StudentTools.ps1** with an advanced function **New-StudentFolder** that creates **C:\\Students\\<Programme>\\Year<Year>\\<StudentId>** and outputs the folder path. Let PowerShell reject bad input before your code runs:\n\n- **-StudentId**: mandatory, exactly ${digits} digits (ValidatePattern)\n- **-Programme**: mandatory, one of ${progs.map((p) => `\`${p}\``).join(', ')} (ValidateSet)\n- **-Year**: an integer from 1 to 4 (ValidateRange), default 1`,
        steps: ['Start with [CmdletBinding()] and a param() block.', `Put [ValidatePattern('^\\d{${digits}}$')] above $StudentId, and so on.`, 'Create the folder with New-Item -ItemType Directory -Force and output its FullName.', 'Dot-source the file and test good and bad values.'],
        tips: [`[Parameter(Mandatory)][ValidatePattern('^\\d{${digits}}$')][string]$StudentId`, "[ValidateSet('A','B')][string]$Programme", '[ValidateRange(1, 4)][int]$Year = 1'],
      }),
      hints: ['Validation attributes produce clear errors for free, before the function body runs.', 'Anchor the pattern with ^ and $ or "x12345678x" would pass.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Scripts\\README.txt': 'Scripts for the ICT office.\n' } }),
      checks: [
        ps('A valid call creates the folder', `. C:\\Scripts\\StudentTools.ps1; $null = New-StudentFolder -StudentId ${id} -Programme ${progs[1]} -Year ${year}; Test-Path C:\\Students\\${progs[1]}\\Year${year}\\${id}`, { equals: 'True' }),
        ps('It outputs the path', `. C:\\Scripts\\StudentTools.ps1; "$(New-StudentFolder -StudentId ${id} -Programme ${progs[0]})"`, { contains: `C:\\Students\\${progs[0]}\\Year1\\${id}` }),
        ps('A short ID is rejected by validation', `. C:\\Scripts\\StudentTools.ps1; try { New-StudentFolder -StudentId 123 -Programme ${progs[0]} -ErrorAction Stop; 'accepted' } catch { $_.FullyQualifiedErrorId }`, { contains: 'ParameterArgumentValidationError' }),
        ps('An unknown programme is rejected', `. C:\\Scripts\\StudentTools.ps1; try { New-StudentFolder -StudentId ${id} -Programme Medicine -ErrorAction Stop; 'accepted' } catch { 'rejected' }`, { equals: 'rejected' }),
        ps('Year 5 is rejected', `. C:\\Scripts\\StudentTools.ps1; try { New-StudentFolder -StudentId ${id} -Programme ${progs[0]} -Year 5 -ErrorAction Stop; 'accepted' } catch { 'rejected' }`, { equals: 'rejected' }),
      ],
      solution: [psWrite('C:\\Scripts\\StudentTools.ps1', `function New-StudentFolder {\n    [CmdletBinding()]\n    param(\n        [Parameter(Mandatory)][ValidatePattern('^\\d{${digits}}$')][string]$StudentId,\n        [Parameter(Mandatory)][ValidateSet(${progs.map((p) => `'${p}'`).join(', ')})][string]$Programme,\n        [ValidateRange(1, 4)][int]$Year = 1\n    )\n    $path = "C:\\Students\\$Programme\\Year$Year\\$StudentId"\n    (New-Item -ItemType Directory -Path $path -Force).FullName\n}`), '. C:\\Scripts\\StudentTools.ps1', `New-StudentFolder -StudentId ${id} -Programme ${progs[1]} -Year ${year}`],
      realityNote: 'Validation attributes are the cheapest input checking there is, and tab completion offers the ValidateSet values to whoever uses the function.',
    };
  }),
  tmpl(2, 4, 'advanced', 'pipeline-function', 'Write a pipeline function with begin, process and end', 'E4', 30, 'Accept CSV rows by property name, emit objects per row and summarise in the end block.', (v) => {
    const net = v.net();
    const max = v.pick([60, 90, 120]);
    const people = v.people(8);
    const rows = people.map((p) => ({ sam: p.sam, set: isoDaysAgo(v.int(5, 300)) }));
    const days = (iso: string) => Math.floor((NOW - day(iso)) / 86400000);
    const over = rows.filter((r) => days(r.set) > max);
    if (!over.length) rows[0].set = isoDaysAgo(max + 30);
    const over2 = rows.filter((r) => days(r.set) > max);
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\AccountTools.ps1** with an advanced function **Test-PasswordAge** that works in a pipeline:\n\n- **-SamAccountName** (string) and **-PasswordLastSet** (datetime), both mandatory and accepted **from the pipeline by property name**;\n- **-MaxAgeDays**, default ${max};\n- for each account whose password is older than MaxAgeDays it outputs an object with **SamAccountName** and **DaysOverdue** (age in whole days minus MaxAgeDays);\n- at the end it writes \`<n> accounts overdue\` with **Write-Verbose**.\n\n**C:\\Data\\passwords.csv** has the columns SamAccountName and PasswordLastSet for testing.`,
        steps: ['Use begin { $count = 0 }, process { ... } and end { Write-Verbose ... }.', 'Mark both parameters [Parameter(Mandatory, ValueFromPipelineByPropertyName)].', 'In process, compute ((Get-Date) - $PasswordLastSet).Days.', `Test: Import-Csv C:\\Data\\passwords.csv | Test-PasswordAge -Verbose`],
        tips: ['[Parameter(Mandatory, ValueFromPipelineByPropertyName)][datetime]$PasswordLastSet', '[pscustomobject]@{ SamAccountName = $SamAccountName; DaysOverdue = $age - $MaxAgeDays }', 'end { Write-Verbose "$count accounts overdue" }'],
      }),
      hints: ['process runs once per pipeline object; begin and end run once.', 'Typing the parameter as [datetime] converts the CSV text for you.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Data\\passwords.csv': csv('SamAccountName,PasswordLastSet', rows.map((r) => [r.sam, r.set])) } }),
      checks: [
        ps('It outputs the overdue accounts with the days overdue', `. C:\\Scripts\\AccountTools.ps1; (Import-Csv C:\\Data\\passwords.csv | Test-PasswordAge | ForEach-Object { "$($_.SamAccountName)=$($_.DaysOverdue)" }) -join ';'`, { equals: over2.map((r) => `${r.sam}=${days(r.set) - max}`).join(';') }),
        ps('-MaxAgeDays changes the limit', `. C:\\Scripts\\AccountTools.ps1; @(Import-Csv C:\\Data\\passwords.csv | Test-PasswordAge -MaxAgeDays 1000).Count`, { equals: '0' }),
        ps('The end block reports the count with -Verbose', `. C:\\Scripts\\AccountTools.ps1; Import-Csv C:\\Data\\passwords.csv | Test-PasswordAge -Verbose 4>&1 | Where-Object { $_ -is [System.Management.Automation.VerboseRecord] } | ForEach-Object Message`, { equals: `${over2.length} accounts overdue` }),
      ],
      solution: [psWrite('C:\\Scripts\\AccountTools.ps1', `function Test-PasswordAge {\n    [CmdletBinding()]\n    param(\n        [Parameter(Mandatory, ValueFromPipelineByPropertyName)][string]$SamAccountName,\n        [Parameter(Mandatory, ValueFromPipelineByPropertyName)][datetime]$PasswordLastSet,\n        [int]$MaxAgeDays = ${max}\n    )\n    begin { $count = 0 }\n    process {\n        $age = ((Get-Date) - $PasswordLastSet).Days\n        if ($age -gt $MaxAgeDays) {\n            $count++\n            [pscustomobject]@{ SamAccountName = $SamAccountName; DaysOverdue = $age - $MaxAgeDays }\n        }\n    }\n    end { Write-Verbose "$count accounts overdue" }\n}`), '. C:\\Scripts\\AccountTools.ps1', 'Import-Csv C:\\Data\\passwords.csv | Test-PasswordAge -Verbose'],
      realityNote: 'Functions that take pipeline input by property name plug straight into Import-Csv, Get-ADUser and each other; that composability is the point of advanced functions.',
    };
  }),

  /* ---------------------------------------------------------------- 2.5 try, catch, finally, ErrorAction, Write-Verbose */
  tmpl(2, 5, 'beginner', 'catch-missing-file', 'Catch a missing file', 'E4', 15, 'Turn a non-terminating error into a catchable one with -ErrorAction Stop and report it cleanly.', (v) => {
    const net = v.net();
    const server = v.pick(['FS01', 'APP01', 'SQL01']);
    const share = v.pick(['Data', 'Projects', 'Records']);
    return {
      instructions: lab({
        situation: `**C:\\Scripts\\Show-Config.ps1 -Path FILE** reads a JSON configuration and prints \`Server: <server>\`. With a missing file it prints a red error **and then** "Server: " with nothing after it, and exits 0, so the scheduler thinks it worked. Change it so that a missing file prints exactly \`Config not found: <path>\` and exits with code **1**. The real configuration is C:\\Config\\app.json.`,
        steps: ['Read the script.', 'Wrap the reading in try { } catch { }.', 'Add -ErrorAction Stop to Get-Content: without it the error is non-terminating and catch never runs.', 'In catch, print the message with Write-Output and exit 1.'],
        tips: ['try {\n    $cfg = Get-Content $Path -Raw -ErrorAction Stop | ConvertFrom-Json\n} catch {\n    Write-Output "Config not found: $Path"\n    exit 1\n}', '& C:\\Scripts\\Show-Config.ps1 -Path C:\\nope.json; $LASTEXITCODE'],
      }),
      hints: ['Most cmdlet errors are non-terminating: they are reported and the script carries on.', 'exit sets $LASTEXITCODE for whoever ran the script.'],
      initialState: windows({ machines: [dc01(net)], files: { 'C:\\Config\\app.json': JSON.stringify({ server: server, share }, null, 2) + '\n', 'C:\\Scripts\\Show-Config.ps1': 'param([string]$Path)\n$cfg = Get-Content $Path -Raw | ConvertFrom-Json\n"Server: $($cfg.server)"\n' } }),
      checks: [
        ps('The real configuration still works', '& C:\\Scripts\\Show-Config.ps1 -Path C:\\Config\\app.json', { equals: `Server: ${server}` }),
        ps('A missing file gives the clean message', '& C:\\Scripts\\Show-Config.ps1 -Path C:\\Config\\none.json', { equals: 'Config not found: C:\\Config\\none.json' }),
        ps('A missing file exits with code 1', '& C:\\Scripts\\Show-Config.ps1 -Path C:\\Config\\none.json | Out-Null; $LASTEXITCODE', { equals: '1' }),
      ],
      solution: [psWrite('C:\\Scripts\\Show-Config.ps1', 'param([string]$Path)\ntry {\n    $cfg = Get-Content $Path -Raw -ErrorAction Stop | ConvertFrom-Json\n} catch {\n    Write-Output "Config not found: $Path"\n    exit 1\n}\n"Server: $($cfg.server)"'), '& C:\\Scripts\\Show-Config.ps1 -Path C:\\Config\\none.json; $LASTEXITCODE'],
      realityNote: 'A script that fails quietly is worse than one that fails loudly: schedulers, CI systems and monitoring all trust the exit code.',
    };
  }),
  tmpl(2, 5, 'intermediate', 'typed-catch-finally', 'Catch specific errors and always log', 'E4', 25, 'Handle a missing list file and missing services differently, and log every run in finally.', (v) => {
    const net = v.net();
    const good = v.some(Object.keys(APP_SERVICES), 2);
    const missing = v.pick(['OldBackupSvc', 'LegacyPrint', 'TempAgent']);
    const list = 'C:\\Ops\\restart.txt';
    const log = v.pick(['C:\\Logs\\restart.log', 'C:\\Logs\\maintenance.log']);
    return {
      instructions: lab({
        situation: `Write **C:\\Scripts\\Restart-FromList.ps1 [-ListPath FILE]** (default ${list}) that restarts each service named in the file, one per line:\n\n- for each service restarted, print \`restarted <name>\`;\n- if a service does not exist, catch **[Microsoft.PowerShell.Commands.ServiceCommandException]**, print \`missing <name>\` and carry on;\n- if the list file itself is missing, catch **[System.Management.Automation.ItemNotFoundException]**, print \`no list: <path>\` and stop;\n- whatever happens, a **finally** block appends \`run finished\` to **${log}**.\n\nThe current list contains ${good.join(', ')} and ${missing}, which was removed from this server.`,
        steps: ['Read the list inside try with Get-Content -ErrorAction Stop.', 'Loop over the names; inside the loop, a second try around Restart-Service -ErrorAction Stop.', 'Write the specific catch blocks with their types in square brackets.', 'Add finally { Add-Content ... } to the outer try.'],
        tips: ['try {\n    $names = Get-Content $ListPath -ErrorAction Stop\n    foreach ($n in $names) { try { ... } catch [Microsoft.PowerShell.Commands.ServiceCommandException] { ... } }\n} catch [System.Management.Automation.ItemNotFoundException] {\n    ...\n} finally {\n    Add-Content -Path LOG -Value \'run finished\'\n}'],
      }),
      hints: ['A typed catch only catches that type (and types derived from it).', 'finally runs after try or catch, even when catch writes an error or the script returns.'],
      initialState: windows({ machines: [dc01(net, { services: dcServices(Object.fromEntries(good.map((s) => [s, RUNNING]))) })], files: { [list]: [good[0], missing, good[1]].join('\n') + '\n', 'C:\\Logs\\README.txt': 'Logs.\n' } }),
      checks: [
        ps('Existing services are restarted and the missing one reported', '& C:\\Scripts\\Restart-FromList.ps1', { equals: [`restarted ${good[0]}`, `missing ${missing}`, `restarted ${good[1]}`].join('\n') }),
        ps('A missing list file is reported', '& C:\\Scripts\\Restart-FromList.ps1 -ListPath C:\\Ops\\none.txt', { equals: 'no list: C:\\Ops\\none.txt' }),
        ps('Every run is logged, even a failed one', `$before = @(Get-Content ${log} -ErrorAction SilentlyContinue).Count; & C:\\Scripts\\Restart-FromList.ps1 -ListPath C:\\Ops\\none.txt | Out-Null; @(Get-Content ${log}).Count - $before`, { equals: '1' }),
        ps('The specific exception types are caught', 'Get-Content C:\\Scripts\\Restart-FromList.ps1 -Raw', { contains: ['catch [Microsoft.PowerShell.Commands.ServiceCommandException]', 'catch [System.Management.Automation.ItemNotFoundException]', 'finally'] }),
      ],
      solution: [psWrite('C:\\Scripts\\Restart-FromList.ps1', `param([string]$ListPath = '${list}')\ntry {\n    $names = Get-Content $ListPath -ErrorAction Stop\n    foreach ($n in $names) {\n        try {\n            Restart-Service -Name $n -ErrorAction Stop\n            "restarted $n"\n        } catch [Microsoft.PowerShell.Commands.ServiceCommandException] {\n            "missing $n"\n        }\n    }\n} catch [System.Management.Automation.ItemNotFoundException] {\n    "no list: $ListPath"\n} finally {\n    Add-Content -Path ${log} -Value 'run finished'\n}`), '& C:\\Scripts\\Restart-FromList.ps1'],
      realityNote: 'Catching the specific exception you expect, and letting the unexpected ones surface, is what separates error handling from error hiding.',
    };
  }),
  tmpl(2, 5, 'advanced', 'whatif-and-write-error', 'Support -WhatIf and write non-terminating errors', 'E4', 30, 'Build a cleanup function with ShouldProcess and Write-Error that callers can preview and control.', (v) => {
    const net = v.net();
    const people = v.people(4);
    const gone = v.person();
    const root = v.pick(['C:\\Profiles', 'C:\\Users\\Old', 'D:\\Roaming']);
    const rootReal = root.startsWith('D:') ? 'C:\\Roaming' : root;
    return {
      instructions: lab({
        situation: `Old profile folders under **${rootReal}** must be removed for staff who left. Write **C:\\Scripts\\ProfileTools.ps1** with an advanced function **Remove-OldProfile** that:\n\n- takes **-Name** (one or more folder names, also from the pipeline);\n- supports **-WhatIf** and **-Confirm** (SupportsShouldProcess) and removes **${rootReal}\\<name>** only when ShouldProcess agrees, printing \`removed <name>\`;\n- for a name with no folder, uses **Write-Error** \`No profile folder for <name>\` and **continues** with the next name (so -ErrorAction Stop can make it stop).`,
        steps: ['[CmdletBinding(SupportsShouldProcess)] and a process block.', 'Test-Path first; Write-Error and return for a missing folder (return only ends this item).', 'if ($PSCmdlet.ShouldProcess($path, \'Remove profile folder\')) { Remove-Item ... -Recurse }', `Try it: '${people[0].sam}','${gone.sam}' | Remove-OldProfile -WhatIf`],
        tips: ['[CmdletBinding(SupportsShouldProcess)]\nparam([Parameter(Mandatory, ValueFromPipeline)][string[]]$Name)', 'Write-Error "No profile folder for $n"', '$PSCmdlet.ShouldProcess($path, \'Remove profile folder\')'],
      }),
      hints: ['Write-Error is non-terminating: the caller decides with -ErrorAction whether it stops.', 'Cmdlets you call inside inherit -WhatIf, so Remove-Item will not delete during a preview either.'],
      initialState: windows({ machines: [dc01(net)], files: Object.fromEntries(people.map((p) => [`${rootReal}\\${p.sam}\\NTUSER.DAT`, 'profile\n'])) }),
      checks: [
        ps('-WhatIf removes nothing', `. C:\\Scripts\\ProfileTools.ps1; Remove-OldProfile -Name ${people[0].sam} -WhatIf | Out-Null; Test-Path ${rootReal}\\${people[0].sam}`, { equals: 'True' }),
        ps('It removes folders and carries on past a missing one', `$ErrorActionPreference = 'Continue'; . C:\\Scripts\\ProfileTools.ps1; '${people[0].sam}','${gone.sam}','${people[1].sam}' | Remove-OldProfile 2>$null; (Test-Path ${rootReal}\\${people[0].sam}), (Test-Path ${rootReal}\\${people[1].sam}) -join ','`, { pattern: `removed ${people[0].sam}\\s+removed ${people[1].sam}\\s+False,False` }),
        ps('A missing folder is a non-terminating error with the message', `$ErrorActionPreference = 'Continue'; . C:\\Scripts\\ProfileTools.ps1; Remove-OldProfile -Name ${gone.sam} -ErrorVariable e 2>$null; $e[0].Exception.Message`, { equals: `No profile folder for ${gone.sam}` }),
        ps('-ErrorAction Stop stops at the missing folder', `. C:\\Scripts\\ProfileTools.ps1; try { '${gone.sam}','${people[2].sam}' | Remove-OldProfile -ErrorAction Stop } catch { 'stopped' }; Test-Path ${rootReal}\\${people[2].sam}`, { pattern: 'stopped\\s+True' }),
      ],
      solution: [psWrite('C:\\Scripts\\ProfileTools.ps1', `function Remove-OldProfile {\n    [CmdletBinding(SupportsShouldProcess)]\n    param([Parameter(Mandatory, ValueFromPipeline)][string[]]$Name)\n    process {\n        foreach ($n in $Name) {\n            $path = "${rootReal}\\$n"\n            if (-not (Test-Path $path)) {\n                Write-Error "No profile folder for $n"\n                continue\n            }\n            if ($PSCmdlet.ShouldProcess($path, 'Remove profile folder')) {\n                Remove-Item -Path $path -Recurse -Force\n                "removed $n"\n            }\n        }\n    }\n}`), '. C:\\Scripts\\ProfileTools.ps1', `'${people[3].sam}' | Remove-OldProfile -WhatIf`],
      realityNote: 'ShouldProcess gives every destructive function a free dry run, and Write-Error lets the caller choose between "report and continue" and "stop at the first problem".',
    };
  }),

  /* ---------------------------------------------------------------- 2.6 modules, execution policy, CSV/JSON, remoting */
  tmpl(2, 6, 'beginner', 'execution-policy', 'Allow local scripts with the right execution policy', 'E4', 15, 'Change the execution policy for the current user only, then run a local script.', (v) => {
    const net = v.net();
    const script = v.pick(['C:\\Scripts\\Get-Inventory.ps1', 'C:\\Scripts\\Get-DiskReport.ps1', 'C:\\Scripts\\Get-ServerInfo.ps1']);
    const report = `C:\\Reports\\${v.pick(['inventory', 'disks', 'server-info'])}.txt`;
    return {
      instructions: lab({
        situation: `On this server scripts are blocked: the execution policy is **Restricted**. You need to run **${script}**, which writes ${report}. Allow local scripts for **your account only** by setting the **CurrentUser** scope to **RemoteSigned** (local scripts run, downloaded ones must be signed). Do not change the LocalMachine policy, and do not use Unrestricted or Bypass. Then run the script.`,
        steps: ['Run the script and read the error.', 'Look at Get-ExecutionPolicy -List.', 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force.', 'Run the script again and check the report.'],
        tips: ['Get-ExecutionPolicy -List', 'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force', `& ${script}`],
      }),
      hints: ['The most specific scope that is set wins: Process, then CurrentUser, then LocalMachine.', 'Execution policy is a safety catch, not a security boundary; still, keep it as tight as you can.'],
      initialState: windows({ machines: [{ ...dc01(net), executionPolicy: 'Restricted' } as never], files: { [script]: `New-Item -ItemType Directory C:\\Reports -Force | Out-Null\nSet-Content -Path ${report} -Value "Computer: $env:COMPUTERNAME"\n'report written'\n` } }),
      checks: [
        ps('CurrentUser is RemoteSigned', 'Get-ExecutionPolicy -Scope CurrentUser', { equals: 'RemoteSigned' }),
        ps('LocalMachine is still Restricted', 'Get-ExecutionPolicy -Scope LocalMachine', { equals: 'Restricted' }),
        ps('The script ran', `Get-Content ${report}`, { equals: 'Computer: DC01' }),
      ],
      solution: [`& ${script}`, 'Get-ExecutionPolicy -List', 'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force', `& ${script}`],
      realityNote: 'Windows Server defaults to RemoteSigned and Windows clients to Restricted; organisations usually set the policy with Group Policy and sign their own scripts.',
    };
  }),
  tmpl(2, 6, 'intermediate', 'build-a-module', 'Package functions as a module with a manifest', 'E4', 25, 'Create a script module with public and private functions and a manifest, then import it by name.', (v) => {
    const net = v.net();
    const mod = v.pick(['CampusTools', 'LabOps', 'ICTHelpers']);
    const version = `${v.int(1, 2)}.${v.int(0, 9)}.${v.int(0, 9)}`;
    const prefix = v.pick(['Campus', 'Lab', 'Ict']);
    const dir = `C:\\Program Files\\WindowsPowerShell\\Modules\\${mod}`;
    return {
      instructions: lab({
        situation: `Package the team's helpers as a module **${mod}**, version **${version}**, in the all-users module folder **${dir}**:\n\n- **${mod}.psm1** defines three functions: **Get-${prefix}Greeting** (returns \`Hello from ${mod}\`), **Get-${prefix}Version** (returns the module version text \`${version}\`), and a private helper **Format-${prefix}Text** that the others may use.\n- **${mod}.psd1**, made with New-ModuleManifest, sets RootModule, ModuleVersion and exports only the two Get- functions.\n\nThen \`Import-Module ${mod}\` by name.`,
        steps: ['Create the folder: the folder, .psm1 and .psd1 must share the module name.', 'Write the .psm1 with Set-Content and a here-string.', `New-ModuleManifest -Path ${dir}\\${mod}.psd1 -RootModule ${mod}.psm1 -ModuleVersion ${version} -FunctionsToExport ...`, `Import-Module ${mod}; Get-Command -Module ${mod}`],
        tips: [`New-Item -ItemType Directory '${dir}' -Force`, `New-ModuleManifest -Path '${dir}\\${mod}.psd1' -RootModule ${mod}.psm1 -ModuleVersion ${version} -FunctionsToExport Get-${prefix}Greeting, Get-${prefix}Version`, `Get-Module -ListAvailable ${mod}`],
      }),
      hints: ['PowerShell finds modules by folder name in $env:PSModulePath.', 'Functions not exported stay private: the module can call them, you cannot.'],
      initialState: windows({ machines: [dc01(net)] }),
      checks: [
        ps('The module is found with its version', `(Get-Module -ListAvailable ${mod}).Version.ToString()`, { equals: version }),
        ps('Exactly the two public functions are exported', `Import-Module ${mod}; (Get-Command -Module ${mod} | ForEach-Object Name | Sort-Object) -join ','`, { equals: [`Get-${prefix}Greeting`, `Get-${prefix}Version`].sort().join(',') }),
        ps('The greeting works', `Import-Module ${mod}; Get-${prefix}Greeting`, { equals: `Hello from ${mod}` }),
        ps('The version function works', `Import-Module ${mod}; Get-${prefix}Version`, { equals: version }),
        ps('The helper is private', `Import-Module ${mod}; try { Format-${prefix}Text 'x' -ErrorAction Stop; 'visible' } catch { 'private' }`, { equals: 'private' }),
      ],
      solution: [`New-Item -ItemType Directory '${dir}' -Force | Out-Null`, psWrite(`'${dir}\\${mod}.psm1'`, `function Format-${prefix}Text { param([string]$Text) $Text.Trim() }\nfunction Get-${prefix}Greeting { Format-${prefix}Text ' Hello from ${mod} ' }\nfunction Get-${prefix}Version { '${version}' }`), `New-ModuleManifest -Path '${dir}\\${mod}.psd1' -RootModule ${mod}.psm1 -ModuleVersion ${version} -FunctionsToExport Get-${prefix}Greeting, Get-${prefix}Version`, `Import-Module ${mod}`, `Get-Command -Module ${mod}`],
      realityNote: 'Modules are how PowerShell code is shared and versioned: an internal repository (or a file share registered with Register-PSRepository) lets every server Install-Module the team\'s tools.',
    };
  }),
  tmpl(2, 6, 'advanced', 'json-remoting-report', 'Drive remoting from a JSON configuration', 'E4', 30, 'Read servers and services from JSON, query each server with Invoke-Command, handle unreachable ones and export CSV.', (v) => {
    const net = v.net();
    const servers = v.some(['FS01', 'APP01', 'PRINT01', 'WEB01'], 3);
    const down = servers[2];
    const svcFor: Record<string, string[]> = Object.fromEntries(servers.map((s) => [s, v.some(['Spooler', 'LanmanServer', 'W32Time', 'WinRM'], 2)]));
    const stoppedOn = { server: servers[1], svc: svcFor[servers[1]][0] };
    const machines = [dc01(net), ...servers.map((s, i) => ({ name: s, nics: [nic(`${net}.${20 + i}`, net)], ...(s === down ? { remoting: false } : {}), services: { Spooler: RUNNING, LanmanServer: RUNNING, W32Time: RUNNING, WinRM: s === down ? STOPPED_MANUAL : RUNNING, Dnscache: RUNNING, EventLog: RUNNING, ...(s === stoppedOn.server ? { [stoppedOn.svc]: STOPPED_AUTO } : {}) } }))];
    const expected = servers.flatMap((s) => (s === down ? [`${s},*,Unreachable`] : svcFor[s].map((n) => `${s},${n},${s === stoppedOn.server && n === stoppedOn.svc ? 'Stopped' : 'Running'}`)));
    return {
      instructions: lab({
        situation: `**C:\\Ops\\servers.json** lists servers and the services that matter on each. Write **C:\\Scripts\\Get-ServiceReport.ps1** that:\n\n1. reads the JSON with ConvertFrom-Json;\n2. for each server, runs **Invoke-Command** to get the status of its services (pass the names with -ArgumentList or $using:);\n3. if a server cannot be reached, records one row with Service \`*\` and Status \`Unreachable\` instead of failing;\n4. exports **C:\\Reports\\service-report.csv** with the columns **Server, Service, Status**, in the order of the JSON, without the #TYPE line.\n\nRun it.`,
        steps: ['$cfg = Get-Content C:\\Ops\\servers.json -Raw | ConvertFrom-Json', 'foreach ($s in $cfg.servers) { try { Invoke-Command -ComputerName $s.name -ScriptBlock { ... } -ErrorAction Stop } catch { ... } }', 'Build [pscustomobject] rows and collect them in an array.', 'Export the array with Export-Csv.'],
        tips: ['Invoke-Command -ComputerName $s.name -ScriptBlock { param($names) Get-Service -Name $names } -ArgumentList (,$s.services) -ErrorAction Stop', "[pscustomobject]@{ Server = $s.name; Service = '*'; Status = 'Unreachable' }"],
      }),
      hints: ['A remoting failure is a non-terminating error unless you add -ErrorAction Stop.', 'Variables from your session are not visible on the remote computer; use $using:name or -ArgumentList.'],
      initialState: windows({ machines: machines as never, files: { 'C:\\Ops\\servers.json': JSON.stringify({ servers: servers.map((s) => ({ name: s, services: svcFor[s] })) }, null, 2) + '\n' } }),
      checks: [
        ps('The report has one row per server and service, with statuses', '(Import-Csv C:\\Reports\\service-report.csv | ForEach-Object { "$($_.Server),$($_.Service),$($_.Status)" }) -join \';\'', { equals: expected.join(';') }),
        ps('The columns are Server, Service, Status', '(Get-Content C:\\Reports\\service-report.csv)[0]', { equals: '"Server","Service","Status"' }),
        ps('The script uses Invoke-Command', 'Get-Content C:\\Scripts\\Get-ServiceReport.ps1 -Raw', { contains: 'Invoke-Command' }),
      ],
      solution: [psWrite('C:\\Scripts\\Get-ServiceReport.ps1', `$cfg = Get-Content C:\\Ops\\servers.json -Raw | ConvertFrom-Json\n$rows = foreach ($s in $cfg.servers) {\n    try {\n        $names = $s.services\n        $result = Invoke-Command -ComputerName $s.name -ScriptBlock { Get-Service -Name $using:names } -ErrorAction Stop\n        foreach ($r in $result) { [pscustomobject]@{ Server = $s.name; Service = $r.Name; Status = $r.Status } }\n    } catch {\n        [pscustomobject]@{ Server = $s.name; Service = '*'; Status = 'Unreachable' }\n    }\n}\nNew-Item -ItemType Directory C:\\Reports -Force | Out-Null\n$rows | Export-Csv C:\\Reports\\service-report.csv -NoTypeInformation`), '& C:\\Scripts\\Get-ServiceReport.ps1', 'Import-Csv C:\\Reports\\service-report.csv'],
      realityNote: 'Keeping the list of servers in a data file and the logic in a script means adding a server is a one-line change that needs no code review of the logic.',
    };
  }),
];
