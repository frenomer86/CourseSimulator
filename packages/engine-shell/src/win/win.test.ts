import { describe, expect, it } from 'vitest';
import { buildSystem, type SystemSpec } from '../system.js';
import { runLines } from '../shell.js';
import { effectiveAccess, effectivePolicy, findUser, loadAd, loadEstate, makeEnv, resultantPolicy, winSystemSpec, type WinLabSpec } from './index.js';

const box = (spec: WinLabSpec = {}) => buildSystem(winSystemSpec(spec) as unknown as SystemSpec);
const env = (sys: ReturnType<typeof box>) => makeEnv(sys, {});

const NET = (name: string, ip: string, extra: object = {}) => ({ name, nics: [{ alias: 'Ethernet', mac: `00-15-5D-00-00-${ip.split('.')[3].padStart(2, '0')}`, dhcp: false, ip, prefix: 24, gateway: '10.0.0.1', dns: ['10.0.0.10'], profile: 'DomainAuthenticated' as const, up: true }], ...extra });

describe('estate and remoting', () => {
  it('runs commands on another server and is stopped by its firewall', () => {
    const sys = box({ machines: [NET('DC01', '10.0.0.10'), NET('FS01', '10.0.0.20')] });
    expect(runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { hostname }'])).toMatch(/FS01/);
    runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { Disable-NetFirewallRule -DisplayName "Windows Remote Management (HTTP-In)" }']);
    expect(runLines(sys, ['Enter-PSSession FS01'])).toMatch(/WinRM cannot complete the operation/);
  });
  it('shows the remote prompt and comes back', () => {
    const sys = box({ machines: [NET('DC01', '10.0.0.10'), NET('FS01', '10.0.0.20')] });
    runLines(sys, ['Enter-PSSession -ComputerName FS01', 'New-Item -Path C:\\Data -ItemType Directory']);
    expect(loadEstate(sys).current).toBe('FS01');
    expect(runLines(sys, ['Test-Path C:\\Data'])).toMatch(/True/);
    runLines(sys, ['Exit-PSSession']);
    expect(runLines(sys, ['Test-Path C:\\Data'])).toMatch(/False/);
  });
});

describe('storage and features', () => {
  it('brings a new disk online, partitions and formats it', () => {
    const sys = box({ machines: [{ ...NET('FS01', '10.0.0.20'), disks: [{ number: 0, sizeGb: 127, style: 'GPT', online: true, partitions: [{ letter: 'C', sizeGb: 126, fs: 'NTFS' }] }, { number: 1, sizeGb: 200, style: 'RAW', online: false, partitions: [] }] }] });
    const out = runLines(sys, ['Initialize-Disk -Number 1 -PartitionStyle GPT', 'Set-Disk -Number 1 -IsOffline $false', 'Initialize-Disk -Number 1 -PartitionStyle GPT', 'New-Partition -DiskNumber 1 -UseMaximumSize -DriveLetter E', 'Format-Volume -DriveLetter E -FileSystem ReFS -NewFileSystemLabel Data', 'Get-Volume']);
    expect(out).toMatch(/Disk 1 is offline/);
    expect(out).toMatch(/E\s+Data\s+ReFS/);
  });
  it('needs enough disks for a resilient virtual disk', () => {
    const raw = (n: number) => ({ number: n, sizeGb: 100, style: 'RAW' as const, online: true, partitions: [] });
    const sys = box({ machines: [{ ...NET('FS01', '10.0.0.20'), disks: [{ number: 0, sizeGb: 127, style: 'GPT', online: true, partitions: [{ letter: 'C', sizeGb: 126, fs: 'NTFS' }] }, raw(1), raw(2)] }] });
    const out = runLines(sys, ['New-StoragePool -FriendlyName Pool1 -PhysicalDisks (Get-PhysicalDisk | Where-Object { $_.CanPool -eq $true })', 'New-VirtualDisk -StoragePoolFriendlyName Pool1 -FriendlyName P -ResiliencySettingName Parity -UseMaximumSize', 'New-VirtualDisk -StoragePoolFriendlyName Pool1 -FriendlyName M -ResiliencySettingName Mirror -UseMaximumSize']);
    expect(out).toMatch(/Parity virtual disk needs at least 3 physical disks/);
    expect(out).toMatch(/M\s+Mirror\s+100 GB/);
  });
  it('installs a role with its tools', () => {
    const sys = box();
    expect(runLines(sys, ['Install-WindowsFeature DHCP -IncludeManagementTools', 'Get-WindowsFeature DHCP'])).toMatch(/\[X\] DHCP Server/);
  });
});

describe('DHCP and DNS', () => {
  it('leases an address to a client once the server is authorised and the scope is active', () => {
    const client = { name: 'PC01', nics: [{ alias: 'Ethernet', mac: '00-15-5D-AA-BB-01', dhcp: true, dns: [], profile: 'Public' as const, up: true }] };
    const sys = box({ machines: [{ ...NET('DC01', '10.0.0.10'), features: ['AD-Domain-Services', 'DNS', 'DHCP'], services: { DHCPServer: { status: 'Running', start: 'Automatic' }, DNS: { status: 'Running', start: 'Automatic' }, Netlogon: { status: 'Running', start: 'Automatic' }, WinRM: { status: 'Running', start: 'Automatic' } } }, client] });
    runLines(sys, ['Add-DhcpServerv4Scope -Name Office -StartRange 10.0.0.100 -EndRange 10.0.0.150 -SubnetMask 255.255.255.0 -State Active', 'Set-DhcpServerv4OptionValue -ScopeId 10.0.0.0 -Router 10.0.0.1 -DnsServer 10.0.0.10 -DnsDomain campus.local']);
    expect(runLines(sys, ['Invoke-Command -ComputerName PC01 -ScriptBlock { ipconfig /renew }'])).toMatch(/unable to contact your DHCP server/);
    const out = runLines(sys, ['Add-DhcpServerInDC -DnsName DC01', 'Invoke-Command -ComputerName PC01 -ScriptBlock { ipconfig /renew }']);
    expect(out).toMatch(/IPv4 Address. . . . . . . . . . . : 10\.0\.0\.100/);
  });
  it('resolves SRV records and reports a missing one', () => {
    const sys = box({ machines: [{ ...NET('DC01', '10.0.0.10'), services: { DNS: { status: 'Running', start: 'Automatic' }, Netlogon: { status: 'Running', start: 'Automatic' }, NTDS: { status: 'Running', start: 'Automatic' }, WinRM: { status: 'Running', start: 'Automatic' } } }] });
    expect(runLines(sys, ['nslookup -type=srv _ldap._tcp.dc._msdcs.campus.local'])).toMatch(/svr hostname\s+= dc01\.campus\.local/);
    const broken = runLines(sys, ["Remove-DnsServerResourceRecord -ZoneName campus.local -Name _ldap._tcp.dc._msdcs -RRType SRV", 'dcdiag /test:dns']);
    expect(broken).toMatch(/failed test DNS/);
    expect(runLines(sys, ['nltest /dsregdns', 'dcdiag /test:dns'])).toMatch(/passed test DNS/);
  });
  it('adds records, a reverse zone and a forwarder', () => {
    const sys = box({ machines: [{ ...NET('DC01', '10.0.0.10'), services: { DNS: { status: 'Running', start: 'Automatic' }, WinRM: { status: 'Running', start: 'Automatic' } } }] });
    const out = runLines(sys, ['Add-DnsServerPrimaryZone -NetworkId 10.0.0.0/24 -ReplicationScope Domain', 'Add-DnsServerResourceRecordA -ZoneName campus.local -Name intranet -IPv4Address 10.0.0.30 -CreatePtr', 'Add-DnsServerResourceRecordCName -ZoneName campus.local -Name portal -HostNameAlias intranet.campus.local', 'Resolve-DnsName portal.campus.local', 'nslookup 30.0.0.10.in-addr.arpa', 'Add-DnsServerForwarder -IPAddress 8.8.8.8', 'Resolve-DnsName www.google.com']);
    expect(out).toMatch(/10\.0\.0\.30/);
    expect(out).toMatch(/142\.250\.184\.4/);
  });
});

describe('firewall', () => {
  it('needs an inbound rule for the right profile and port', () => {
    const sys = box({ machines: [NET('DC01', '10.0.0.10'), { ...NET('DB01', '10.0.0.40'), listen: [1433] } as never] });
    const blocked = runLines(sys, ['Test-NetConnection -ComputerName DB01 -Port 1433']);
    expect(blocked).toMatch(/TcpTestSucceeded\s*:\s*False/);
    expect(blocked).toMatch(/no enabled inbound rule/);
    runLines(sys, ['Invoke-Command -ComputerName DB01 -ScriptBlock { New-NetFirewallRule -DisplayName "SQL Server" -Direction Inbound -Protocol TCP -LocalPort 1433 -Action Allow -Profile Public }']);
    expect(runLines(sys, ['Test-NetConnection -ComputerName DB01 -Port 1433'])).toMatch(/TcpTestSucceeded\s*:\s*False/);
    runLines(sys, ['Invoke-Command -ComputerName DB01 -ScriptBlock { Set-NetFirewallRule -DisplayName "SQL Server" -Profile Domain -RemoteAddress 10.0.0.0/24 }']);
    expect(runLines(sys, ['Test-NetConnection -ComputerName DB01 -Port 1433'])).toMatch(/TcpTestSucceeded\s*:\s*True/);
  });
});

describe('Group Policy', () => {
  const gpBox = () =>
    box({
      machines: [NET('DC01', '10.0.0.10'), NET('LAB-PC01', '10.0.0.51')],
      ad: (st) => {
        const dc = 'DC=campus,DC=local';
        st.ous.push({ name: 'Campus', dn: `OU=Campus,${dc}`, protected: true }, { name: 'Labs', dn: `OU=Labs,OU=Campus,${dc}`, protected: true }, { name: 'Staff', dn: `OU=Staff,OU=Campus,${dc}`, protected: true });
        st.users.push({ sam: 'efua', name: 'Efua Asante', dn: `CN=Efua Asante,OU=Staff,OU=Campus,${dc}`, enabled: true, hasPassword: true });
        st.groups.push({ name: 'GG_Lecturers', dn: `CN=GG_Lecturers,OU=Staff,OU=Campus,${dc}`, scope: 'Global', category: 'Security', members: [`CN=Efua Asante,OU=Staff,OU=Campus,${dc}`] });
        st.computers = st.computers.map((c) => (c.name === 'LAB-PC01' ? { ...c, dn: `CN=LAB-PC01,OU=Labs,OU=Campus,${dc}` } : c));
      },
    });
  it('applies the closest link, unless a higher one is enforced', () => {
    const sys = gpBox();
    const key = 'HKCU\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop';
    runLines(sys, [
      'New-GPO -Name "Campus Screensaver"',
      `Set-GPRegistryValue -Name "Campus Screensaver" -Key "${key}" -ValueName ScreenSaveTimeOut -Type String -Value 900`,
      'New-GPLink -Name "Campus Screensaver" -Target "OU=Campus,DC=campus,DC=local"',
      'New-GPO -Name "Staff Screensaver"',
      `Set-GPRegistryValue -Name "Staff Screensaver" -Key "${key}" -ValueName ScreenSaveTimeOut -Type String -Value 300`,
      'New-GPLink -Name "Staff Screensaver" -Target "OU=Staff,OU=Campus,DC=campus,DC=local"',
    ]);
    const e = env(sys);
    expect(effectivePolicy(e, `${key}|ScreenSaveTimeOut`, 'efua', 'DC01')).toBe('300');
    runLines(sys, ['Set-GPLink -Name "Campus Screensaver" -Target "OU=Campus,DC=campus,DC=local" -Enforced Yes']);
    expect(effectivePolicy(env(sys), `${key}|ScreenSaveTimeOut`, 'efua', 'DC01')).toBe('900');
  });
  it('blocks inheritance, filters by group and honours loopback', () => {
    const sys = gpBox();
    const cp = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer';
    runLines(sys, [
      'New-GPO -Name "No Control Panel"',
      `Set-GPRegistryValue -Name "No Control Panel" -Key "${cp}" -ValueName NoControlPanel -Type DWord -Value 1`,
      'New-GPLink -Name "No Control Panel" -Target "DC=campus,DC=local"',
      'Set-GPInheritance -Target "OU=Staff,OU=Campus,DC=campus,DC=local" -IsBlocked Yes',
    ]);
    expect(effectivePolicy(env(sys), `${cp}|NoControlPanel`, 'efua', 'LAB-PC01')).toBeUndefined();
    runLines(sys, [
      'New-GPO -Name "Lab Lockdown"',
      `Set-GPRegistryValue -Name "Lab Lockdown" -Key "${cp}" -ValueName NoControlPanel -Type DWord -Value 1`,
      'Set-GPRegistryValue -Name "Lab Lockdown" -Key "HKLM\\Software\\Policies\\Microsoft\\Windows\\System" -ValueName UserPolicyMode -Type DWord -Value 1',
      'New-GPLink -Name "Lab Lockdown" -Target "OU=Labs,OU=Campus,DC=campus,DC=local"',
    ]);
    expect(effectivePolicy(env(sys), `${cp}|NoControlPanel`, 'efua', 'LAB-PC01')).toBe(1);
    expect(effectivePolicy(env(sys), `${cp}|NoControlPanel`, 'efua', 'DC01')).toBeUndefined();
    runLines(sys, ['Set-GPPermission -Name "Lab Lockdown" -TargetName "Authenticated Users" -TargetType Group -PermissionLevel GpoRead -Replace', 'Set-GPPermission -Name "Lab Lockdown" -TargetName "Domain Computers" -TargetType Group -PermissionLevel GpoApply']);
    const r = runLines(sys, ['gpresult /r /user CAMPUS\\efua /s LAB-PC01']);
    expect(r).toMatch(/Lab Lockdown/);
  });
});

describe('file services', () => {
  const fsBox = () =>
    box({
      machines: [NET('DC01', '10.0.0.10'), { ...NET('FS01', '10.0.0.20'), features: ['FS-FileServer', 'FS-Resource-Manager'], disks: [{ number: 0, sizeGb: 127, style: 'GPT', online: true, partitions: [{ letter: 'C', sizeGb: 126, fs: 'NTFS' }] }, { number: 1, sizeGb: 500, style: 'GPT', online: true, partitions: [{ letter: 'D', sizeGb: 500, fs: 'NTFS', label: 'Data' }] }] }],
      machineFiles: { FS01: { 'D:\\Shares\\Finance\\budget.xlsx': 'Budget 2026\n', 'D:\\Shares\\Finance\\song.mp3': 'ID3' } },
      files: { 'C:\\Users\\Administrator\\Downloads\\song.mp3': 'ID3' },
      ad: (st) => {
        const dc = 'DC=campus,DC=local';
        st.users.push({ sam: 'kofi', name: 'Kofi Boateng', dn: `CN=Kofi Boateng,CN=Users,${dc}`, enabled: true, hasPassword: true });
        st.groups.push({ name: 'GG_Finance', dn: `CN=GG_Finance,CN=Users,${dc}`, scope: 'Global', category: 'Security', members: [`CN=Kofi Boateng,CN=Users,${dc}`] }, { name: 'DL_Finance_Modify', dn: `CN=DL_Finance_Modify,CN=Users,${dc}`, scope: 'DomainLocal', category: 'Security', members: [`CN=GG_Finance,CN=Users,${dc}`] });
      },
    });
  it('combines share and NTFS permissions as the more restrictive', () => {
    const sys = fsBox();
    runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { New-SmbShare -Name Finance -Path D:\\Shares\\Finance -FullAccess "CAMPUS\\Domain Users"; icacls D:\\Shares\\Finance /inheritance:r; icacls D:\\Shares\\Finance /grant "CAMPUS\\DL_Finance_Modify:(OI)(CI)M" /grant "Administrators:(OI)(CI)F" }']);
    expect(effectiveAccess(env(sys), '\\\\FS01\\Finance', 'kofi')).toBe('Modify');
    runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { Revoke-SmbShareAccess -Name Finance -AccountName "CAMPUS\\Domain Users"; Grant-SmbShareAccess -Name Finance -AccountName "CAMPUS\\Domain Users" -AccessRight Read }']);
    expect(effectiveAccess(env(sys), '\\\\FS01\\Finance', 'kofi')).toBe('ReadAndExecute');
  });
  it('screens audio files and enforces a hard quota', () => {
    const sys = fsBox();
    runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { New-SmbShare -Name Finance -Path D:\\Shares\\Finance -ChangeAccess "CAMPUS\\Domain Users"; New-FsrmFileScreen -Path D:\\Shares\\Finance -IncludeGroup "Audio and Video Files" -Active }']);
    expect(runLines(sys, ['Copy-Item C:\\Users\\Administrator\\Downloads\\song.mp3 \\\\FS01\\Finance\\'])).toMatch(/File Server Resource Manager blocked song.mp3/);
  });
  it('restores a file from a shadow copy', () => {
    const sys = fsBox();
    runLines(sys, ['Invoke-Command -ComputerName FS01 -ScriptBlock { vssadmin create shadow /for=D:; Set-Content D:\\Shares\\Finance\\budget.xlsx "overwritten" }']);
    runLines(sys, ['Copy-Item "\\\\FS01\\D$\\@GMT-2026.10.22-09.30.00\\Shares\\Finance\\budget.xlsx" "\\\\FS01\\D$\\Shares\\Finance\\budget.xlsx"']);
    expect(runLines(sys, ['Get-Content \\\\FS01\\D$\\Shares\\Finance\\budget.xlsx'])).toMatch(/Budget 2026/);
  });
  it('shares a printer and clears a stuck queue', () => {
    const sys = box({ machines: [NET('DC01', '10.0.0.10'), { ...NET('PRINT01', '10.0.0.25'), features: ['Print-Services', 'Print-Server'], printers: [{ name: 'Finance-HP', driver: 'Microsoft PCL6 Class Driver', port: 'IP_10.0.0.50', shared: true, shareName: 'FinanceHP', published: false, jobs: [{ id: 7, document: 'payroll.pdf', owner: 'kofi', status: 'Error' }] }], ports: [{ name: 'IP_10.0.0.50', host: '10.0.0.50' }], drivers: ['Microsoft PCL6 Class Driver'] }], machineFiles: { PRINT01: { 'C:\\Windows\\System32\\spool\\PRINTERS\\00007.SPL': 'spool' } } });
    const p = (s: string) => `Invoke-Command -ComputerName PRINT01 -ScriptBlock { ${s} }`;
    expect(runLines(sys, [p('Remove-PrintJob -PrinterName Finance-HP -ID 7')])).toMatch(/stuck in the Error state/);
    runLines(sys, [p('Stop-Service Spooler'), p('Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\00007.SPL'), p('Start-Service Spooler')]);
    expect(runLines(sys, [p('Get-PrintJob -PrinterName Finance-HP')]).trim()).toBe('');
  });
});

describe('accounts and security', () => {
  it('applies the fine-grained policy with the lowest precedence', () => {
    const sys = box({ ad: (st) => {
      const dc = 'DC=campus,DC=local';
      st.users.push({ sam: 'adm-kofi', name: 'Kofi Admin', dn: `CN=Kofi Admin,CN=Users,${dc}`, enabled: true, hasPassword: true });
      st.groups.push({ name: 'GG_IT_Admins', dn: `CN=GG_IT_Admins,CN=Users,${dc}`, scope: 'Global', category: 'Security', members: [`CN=Kofi Admin,CN=Users,${dc}`] }, { name: 'GG_All_Staff', dn: `CN=GG_All_Staff,CN=Users,${dc}`, scope: 'Global', category: 'Security', members: [`CN=Kofi Admin,CN=Users,${dc}`] });
    } });
    runLines(sys, ['New-ADFineGrainedPasswordPolicy -Name Admins -Precedence 10 -MinPasswordLength 15 -LockoutThreshold 3', 'New-ADFineGrainedPasswordPolicy -Name Staff -Precedence 20 -MinPasswordLength 10', 'Add-ADFineGrainedPasswordPolicySubject -Identity Admins -Subjects GG_IT_Admins', 'Add-ADFineGrainedPasswordPolicySubject -Identity Staff -Subjects GG_All_Staff']);
    const e = env(sys);
    expect(resultantPolicy(e.st, findUser(e.st, 'adm-kofi')!).source).toBe('Admins');
    expect(runLines(sys, ['Set-ADAccountPassword adm-kofi -Reset -NewPassword (ConvertTo-SecureString "Short1!pass" -AsPlainText -Force)'])).toMatch(/at least 15 characters/);
  });
  it('finds disabled accounts with an LDAP bitwise filter', () => {
    const sys = box({ ad: (st) => {
      const dc = 'DC=campus,DC=local';
      st.users.push({ sam: 'old1', name: 'Old One', dn: `CN=Old One,CN=Users,${dc}`, enabled: false, hasPassword: true }, { sam: 'new1', name: 'New One', dn: `CN=New One,CN=Users,${dc}`, enabled: true, hasPassword: true, department: 'Finance' });
    } });
    const out = runLines(sys, ['Get-ADUser -LDAPFilter "(&(objectCategory=person)(userAccountControl:1.2.840.113556.1.4.803:=2))" | Select-Object SamAccountName', 'Get-ADUser -LDAPFilter "(department=Fin*)" | Select-Object SamAccountName']);
    expect(out).toMatch(/old1/);
    expect(out).toMatch(/Guest/);
    expect(out).toMatch(/new1/);
  });
  it('joins a computer only when it uses the DC for DNS', () => {
    const sys = box({ machines: [NET('DC01', '10.0.0.10'), { ...NET('PC02', '10.0.0.52'), domain: undefined, nics: [{ alias: 'Ethernet', mac: '00-15-5D-00-00-52', dhcp: false, ip: '10.0.0.52', prefix: 24, gateway: '10.0.0.1', dns: ['8.8.8.8'], profile: 'Public', up: true }] }] });
    const pc = (s: string) => `Invoke-Command -ComputerName PC02 -ScriptBlock { ${s} }`;
    expect(runLines(sys, [pc('Add-Computer -DomainName campus.local -Credential (Get-Credential CAMPUS\\Administrator)')])).toMatch(/must use a domain controller for DNS/);
    runLines(sys, [pc('Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses 10.0.0.10'), pc('Add-Computer -DomainName campus.local -Credential (Get-Credential CAMPUS\\Administrator)')]);
    expect(loadAd(sys).computers.some((c) => c.name === 'PC02')).toBe(true);
  });
  it('restores a deleted user once the recycle bin is on', () => {
    const sys = box({ ad: (st) => st.users.push({ sam: 'ama', name: 'Ama Mensah', dn: 'CN=Ama Mensah,CN=Users,DC=campus,DC=local', enabled: true, hasPassword: true }) });
    runLines(sys, ["Enable-ADOptionalFeature 'Recycle Bin Feature' -Scope ForestOrConfigurationSet -Target campus.local", 'Remove-ADUser ama']);
    runLines(sys, ["Get-ADObject -Filter 'samAccountName -eq \"ama\"' -IncludeDeletedObjects | Restore-ADObject"]);
    expect(loadAd(sys).users.some((u) => u.sam === 'ama')).toBe(true);
  });
  it('turns on auditing and logs a group change', () => {
    const sys = box({ ad: (st) => st.users.push({ sam: 'ama', name: 'Ama Mensah', dn: 'CN=Ama Mensah,CN=Users,DC=campus,DC=local', enabled: true, hasPassword: true }) });
    runLines(sys, ['auditpol /set /subcategory:"Security Group Management" /success:enable', 'Add-ADGroupMember -Identity "Domain Admins" -Members ama']);
    expect(runLines(sys, ["Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = 4728 } | Select-Object Id,Message"])).toMatch(/4728.*Domain Admins/);
  });
});

describe('scripting', () => {
  it('runs foreach, if and a script file', () => {
    const sys = box({ files: { 'C:\\Scripts\\count.ps1': '$n = 0\nforeach ($u in Get-ADUser -Filter *) { $n += 1 }\nif ($n -gt 1) { "users: $n" } else { "few" }\n' } });
    expect(runLines(sys, ['C:\\Scripts\\count.ps1'])).toMatch(/users: 2/);
    expect(runLines(sys, ['$x = 5', 'if ($x -ge 5) { "big" } else { "small" }'])).toMatch(/big/);
  });
});
