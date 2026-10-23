/** Unit 7: Windows networking and DNS for Active Directory. */

import { srvRecords, type Machine } from '@cslab/engine-shell/src/win/model';
import type { TaskTemplate } from '../types';
import { caseStudy } from './case';
import { dc01, dcN, fs01, lab, nic, pc, ps, svc, system, tmpl } from './kit';

const dhcpClient = (name: string, mac: string): Partial<Machine> & { name: string } => ({ name, os: 'Windows 11 Pro', installType: 'Client', nics: [{ alias: 'Ethernet', mac, dhcp: true, dns: [], profile: 'Private', up: true }] });
const baseServices = () => ({ Spooler: svc.running, W32Time: svc.running, WinRM: svc.running, LanmanServer: svc.running, Dnscache: svc.running, EventLog: svc.running });
const hex = (v: { int: (a: number, b: number) => number }, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[v.int(0, 15)]).join('');

export const U7: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 7.1 TCP/IP, profiles, firewall */
  tmpl(7, 1, 'beginner', 'allow-ping', 'Allow ping through Windows Firewall', 'E4', 10, 'Enable the built-in ICMP echo rule on a server and test it.', (v) => {
    const net = v.net();
    const srv = v.pick(['FS01', 'APP01', 'PRINT01']);
    return {
      instructions: lab({
        situation: `The monitoring system marks **${srv}** as "down" because it does not answer ping, although file sharing works. Windows Firewall blocks ICMP echo by default. Enable the built-in rule **File and Printer Sharing (Echo Request - ICMPv4-In)** on ${srv}, and nothing else.`,
        steps: [`Test from DC01: \`Test-NetConnection ${srv}\`. Read the warning.`, `On ${srv}, list the rule with Get-NetFirewallRule and enable it.`, 'Test again.'],
        tips: ['Get-NetFirewallRule -DisplayName "*Echo Request*"', 'Enable-NetFirewallRule -DisplayName "File and Printer Sharing (Echo Request - ICMPv4-In)"'],
      }),
      hints: ['Turning the firewall off would also "fix" ping, and open everything else.', 'The rule exists already; it is just disabled.'],
      initialState: system({ machines: [dc01(net), { name: srv, nics: [nic(`${net}.20`, net)] }] }),
      checks: [ps(`DC01 can ping ${srv}`, `(Test-NetConnection ${srv}).PingSucceeded`, { equals: 'True' }), ps(`${srv}'s firewall is still on`, '(Get-NetFirewallProfile -Name Domain).Enabled', { machine: srv, equals: 'True' })],
      solution: [`Test-NetConnection ${srv}`, `Invoke-Command -ComputerName ${srv} -ScriptBlock { Enable-NetFirewallRule -DisplayName "File and Printer Sharing (Echo Request - ICMPv4-In)" }`],
      realityNote: 'Enabling the specific built-in rule instead of disabling the firewall is the habit that keeps servers hardened.',
    };
  }),
  tmpl(7, 1, 'intermediate', 'app-port-rule', 'Open an application port to one subnet only', 'E4', 20, 'Create an inbound rule scoped by port, profile and remote address, and test from inside and outside.', (v) => {
    const net = v.net();
    const other = v.net();
    const port = v.pick([8443, 8080, 9000, 5000]);
    const app = v.pick(['staff portal', 'payroll API', 'library catalogue', 'exam results service']);
    const pcName = `STU-PC${v.int(10, 90)}`;
    return {
      instructions: lab({
        situation: `The **${app}** on APP01 listens on **TCP ${port}**. Only the staff network **${net}.0/24** may reach it, and only on the **Domain** profile. Students are on ${other}.0/24 (for example ${pcName}).`,
        steps: ['On APP01, create an inbound Allow rule called **' + app + '** for TCP ' + port + ', Domain profile, remote address ' + net + '.0/24.', `Test from DC01 (staff network): Test-NetConnection APP01 -Port ${port}.`, `Test from ${pcName}: it must fail.`],
        tips: [`New-NetFirewallRule -DisplayName "${app}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Domain -RemoteAddress ${net}.0/24 -Action Allow`],
      }),
      hints: ['Without -RemoteAddress the rule allows every network.', 'A rule with -LocalPort needs -Protocol TCP or UDP.'],
      initialState: system({ machines: [dc01(net), { name: 'APP01', nics: [nic(`${net}.30`, net)], listen: [port] } as never, pc(pcName, other, 50)] }),
      checks: [ps('The staff network gets through', `(Test-NetConnection APP01 -Port ${port}).TcpTestSucceeded`, { equals: 'True' }), ps('The student network does not', `(Test-NetConnection APP01 -Port ${port}).TcpTestSucceeded`, { machine: pcName, equals: 'False', message: 'Students can reach the application: scope the rule with -RemoteAddress.' }), ps('The rule is limited to the Domain profile', `(Get-NetFirewallRule -DisplayName "${app}").Profile`, { machine: 'APP01', equals: 'Domain' })],
      solution: [`Invoke-Command -ComputerName APP01 -ScriptBlock { New-NetFirewallRule -DisplayName "${app}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Profile Domain -RemoteAddress ${net}.0/24 -Action Allow }`, `Test-NetConnection APP01 -Port ${port}`],
      realityNote: 'Scoping host firewall rules by remote address is cheap micro-segmentation: even if the network lets traffic through, the server only answers who it should.',
    };
  }),
  tmpl(7, 1, 'advanced', 'firewall-audit', 'Harden a server\'s firewall after an audit', 'E4', 30, 'Turn profiles back on, delete an allow-all rule and limit RDP to the admin network, keeping file sharing.', (v) => {
    const net = v.net();
    const adminNet = v.net();
    const stuNet = v.net();
    const srv = v.pick(['FS02', 'APP02', 'RES-SRV01']);
    const adminPc = `ADM-PC${v.int(1, 9)}`;
    const stuPc = `STU-PC${v.int(10, 90)}`;
    return {
      instructions: lab({
        situation: `An audit of **${srv}** found:\n\n1. The **Public** firewall profile is turned off.\n2. A rule called **Allow All** allows every inbound connection on every profile.\n3. **Remote Desktop** is open to any address.\n\nFix it so that: all profiles are on, Allow All is gone, RDP (3389) is accepted only from the admin network **${adminNet}.0/24**, and file sharing (SMB 445) still works for everyone, students included.`,
        steps: ['List the profiles and enabled rules on the server.', 'Turn the Public profile on and remove Allow All.', 'Limit the RDP rule with -RemoteAddress, and make sure the SMB rule is enabled.', `Test from ${adminPc} and ${stuPc}.`],
        tips: ['Get-NetFirewallRule -Enabled $true', 'Set-NetFirewallProfile -Profile Public -Enabled $true', 'Remove-NetFirewallRule -DisplayName "Allow All"', `Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -RemoteAddress ${adminNet}.0/24`],
      }),
      hints: ['Once Allow All is gone, only the specific rules decide.', 'Test-NetConnection -Port 3389 and -Port 445 from each PC.'],
      initialState: system({ machines: [dc01(net), { name: srv, nics: [nic(`${net}.40`, net)], services: { ...baseServices(), TermService: svc.running }, firewall: { enabled: { Domain: true, Private: true, Public: false }, rules: [{ name: 'Remote Desktop - User Mode (TCP-In)', direction: 'Inbound', action: 'Allow', protocol: 'TCP', ports: '3389', profiles: ['Domain', 'Private'], remote: 'Any', enabled: true }, { name: 'Windows Remote Management (HTTP-In)', direction: 'Inbound', action: 'Allow', protocol: 'TCP', ports: '5985', profiles: ['Domain', 'Private'], remote: 'Any', enabled: true }, { name: 'File and Printer Sharing (SMB-In)', direction: 'Inbound', action: 'Allow', protocol: 'TCP', ports: '445', profiles: ['Domain', 'Private'], remote: 'Any', enabled: false }, { name: 'Allow All', direction: 'Inbound', action: 'Allow', protocol: 'Any', ports: 'Any', profiles: ['Any'], remote: 'Any', enabled: true }] } }, pc(adminPc, adminNet, 20), pc(stuPc, stuNet, 50)] }),
      checks: [ps('Every profile is on', 'Get-NetFirewallProfile | ForEach-Object { $_.Enabled }', { machine: srv, notContains: 'False' }), ps('Allow All is gone', 'Get-NetFirewallRule | ForEach-Object { $_.DisplayName }', { machine: srv, notContains: 'Allow All' }), ps(`${adminPc} can RDP`, `(Test-NetConnection ${srv} -Port 3389).TcpTestSucceeded`, { machine: adminPc, equals: 'True' }), ps(`${stuPc} cannot RDP`, `(Test-NetConnection ${srv} -Port 3389).TcpTestSucceeded`, { machine: stuPc, equals: 'False' }), ps(`${stuPc} can still use file shares`, `(Test-NetConnection ${srv} -Port 445).TcpTestSucceeded`, { machine: stuPc, equals: 'True', message: 'File sharing broke: enable the File and Printer Sharing (SMB-In) rule.' })],
      solution: [`Invoke-Command -ComputerName ${srv} -ScriptBlock { Get-NetFirewallRule -Enabled $true; Set-NetFirewallProfile -Profile Public -Enabled $true; Remove-NetFirewallRule -DisplayName "Allow All"; Set-NetFirewallRule -DisplayName "Remote Desktop - User Mode (TCP-In)" -RemoteAddress ${adminNet}.0/24; Enable-NetFirewallRule -DisplayName "File and Printer Sharing (SMB-In)" }`],
      realityNote: 'Exposed RDP is one of the most common ransomware entry points; restricting it to an admin network or a jump host is a basic control.',
    };
  }),

  /* ---------------------------------------------------------------- 7.2 DHCP */
  tmpl(7, 2, 'beginner', 'first-scope', 'Install DHCP and create a scope', 'E4', 20, 'Install and authorise DHCP, create a scope with router and DNS options, and lease an address.', (v) => {
    const net = v.net();
    const [a, b] = [v.int(100, 120), v.int(180, 220)];
    const pcName = `NEW-PC${v.int(10, 99)}`;
    const mac = `00-15-5D-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}`;
    const scope = v.pick(['Staff', 'Admin-Block', 'Library']);
    return {
      instructions: lab({
        situation: `**DHCP01** will hand out addresses on **${net}.0/24**. Install the DHCP role, **authorise** it in Active Directory, and create a scope **${scope}** from **${net}.${a}** to **${net}.${b}** with router **${net}.1**, DNS server **${net}.10** and DNS domain **campus.local**. Then have **${pcName}** renew its lease.`,
        steps: ['Install DHCP on DHCP01 with its tools.', 'Authorise the server (Add-DhcpServerInDC).', 'Create the scope and set its options.', `On ${pcName}, run ipconfig /renew.`],
        tips: [`Add-DhcpServerv4Scope -Name ${scope} -StartRange ${net}.${a} -EndRange ${net}.${b} -SubnetMask 255.255.255.0`, `Set-DhcpServerv4OptionValue -ScopeId ${net}.0 -Router ${net}.1 -DnsServer ${net}.10 -DnsDomain campus.local`],
      }),
      hints: ['An unauthorised DHCP server in a domain does not hand out leases.', 'The scope ID is the network address.'],
      initialState: system({ machines: [dc01(net), { name: 'DHCP01', nics: [nic(`${net}.12`, net)] }, dhcpClient(pcName, mac)] }),
      checks: [ps(`${pcName} has an address from the scope`, '(Get-NetIPConfiguration).IPv4Address', { machine: pcName, pattern: `^${net.replace(/\./g, '\\.')}\\.(\\d+)$` }), ps(`${pcName} got the router`, '(Get-NetIPConfiguration).IPv4DefaultGateway', { machine: pcName, equals: `${net}.1` }), ps(`${pcName} got the DNS server`, '(Get-NetIPConfiguration).DNSServer', { machine: pcName, equals: `${net}.10` }), ps('DHCP01 is authorised', 'Get-DhcpServerInDC | ForEach-Object { $_.DnsName }', { contains: 'dhcp01.campus.local' })],
      solution: ['Invoke-Command -ComputerName DHCP01 -ScriptBlock { Install-WindowsFeature DHCP -IncludeManagementTools; Add-DhcpServerInDC }', `Invoke-Command -ComputerName DHCP01 -ScriptBlock { Add-DhcpServerv4Scope -Name ${scope} -StartRange ${net}.${a} -EndRange ${net}.${b} -SubnetMask 255.255.255.0; Set-DhcpServerv4OptionValue -ScopeId ${net}.0 -Router ${net}.1 -DnsServer ${net}.10 -DnsDomain campus.local }`, `Invoke-Command -ComputerName ${pcName} -ScriptBlock { ipconfig /renew }`],
      realityNote: 'DHCP authorisation in AD exists to stop rogue Windows DHCP servers; the options (router, DNS, domain) matter as much as the addresses.',
    };
  }),
  tmpl(7, 2, 'intermediate', 'reservations-exclusions', 'Reserve an address and exclude a printer range', 'E4', 20, 'Add an exclusion range, a MAC-based reservation and a shorter lease for a lab scope.', (v) => {
    const net = v.net();
    const res = v.int(130, 160);
    const [ex1, ex2] = [v.int(185, 190), v.int(195, 199)];
    const pcName = `LAB-INSTR-${v.int(1, 9)}`;
    const mac = `00-15-5D-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}`;
    return {
      instructions: lab({
        situation: `The lab scope **${net}.0** on DHCP01 hands out ${net}.100 to ${net}.199. Three changes:\n\n1. Printers are statically addressed at **${net}.${ex1}-${net}.${ex2}**: exclude that range.\n2. The instructor PC **${pcName}** (MAC **${mac}**) must always get **${net}.${res}**, because the classroom software points at it.\n3. Students come and go every two hours: cut the lease to **1 day**.\n\nThen renew ${pcName}'s lease.`,
        steps: ['Add the exclusion range.', 'Add the reservation with the MAC as -ClientId.', 'Set the lease duration.', `Run ipconfig /renew on ${pcName}.`],
        tips: [`Add-DhcpServerv4ExclusionRange -ScopeId ${net}.0 -StartRange ${net}.${ex1} -EndRange ${net}.${ex2}`, `Add-DhcpServerv4Reservation -ScopeId ${net}.0 -IPAddress ${net}.${res} -ClientId ${mac} -Name ${pcName}`, `Set-DhcpServerv4Scope -ScopeId ${net}.0 -LeaseDuration 1.00:00:00`],
      }),
      hints: ['Reservations key on the MAC address.', 'Get-NetAdapter on the PC shows its MAC.'],
      initialState: system({ machines: [dc01(net), { name: 'DHCP01', features: ['DHCP'], services: { ...baseServices(), DHCPServer: svc.running }, dhcp: { authorized: true, scopes: [{ id: `${net}.0`, name: 'Lab', start: `${net}.100`, end: `${net}.199`, mask: '255.255.255.0', active: true, exclusions: [], reservations: [], options: { router: `${net}.1`, dns: [`${net}.10`], domain: 'campus.local' }, leaseDays: 8, leases: [] }] }, nics: [nic(`${net}.12`, net)] }, dhcpClient(pcName, mac)] }),
      checks: [ps(`${pcName} got ${net}.${res}`, '(Get-NetIPConfiguration).IPv4Address', { machine: pcName, equals: `${net}.${res}` }), ps('The printer range is excluded', `Get-DhcpServerv4ExclusionRange -ScopeId ${net}.0 | ForEach-Object { $_.StartRange }`, { machine: 'DHCP01', equals: `${net}.${ex1}` }), ps('Leases last 1 day', `(Get-DhcpServerv4Scope | Where-Object { $_.ScopeId -eq '${net}.0' }).LeaseDuration`, { machine: 'DHCP01', equals: '1.00:00:00' })],
      solution: [`Invoke-Command -ComputerName DHCP01 -ScriptBlock { Add-DhcpServerv4ExclusionRange -ScopeId ${net}.0 -StartRange ${net}.${ex1} -EndRange ${net}.${ex2}; Add-DhcpServerv4Reservation -ScopeId ${net}.0 -IPAddress ${net}.${res} -ClientId ${mac} -Name ${pcName}; Set-DhcpServerv4Scope -ScopeId ${net}.0 -LeaseDuration 1.00:00:00 }`, `Invoke-Command -ComputerName ${pcName} -ScriptBlock { ipconfig /renew }`],
      realityNote: 'Short leases suit labs and Wi-Fi with high turnover; reservations give fixed addresses while keeping configuration central.',
    };
  }),
  tmpl(7, 2, 'advanced', 'dhcp-outage', 'Fix a DHCP outage: clients get 169.254 addresses', 'E4', 30, 'Find why no leases are given out, fix every cause and get a client back on the network.', (v) => {
    const net = v.net();
    const pcName = `OFF-PC${v.int(10, 90)}`;
    const mac = `00-15-5D-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}-${hex(v, 2).toUpperCase()}`;
    return {
      instructions: lab({
        situation: `After DHCP01 was rebuilt over the weekend, every PC on **${net}.0/24** that restarts gets a **169.254.x.x** address. The scope was restored from documentation. There are several faults on DHCP01. Get **${pcName}** a proper lease.`,
        steps: [`Reproduce: ipconfig /renew on ${pcName}.`, 'On DHCP01 check: is the DHCP Server service running, is the server authorised, is the scope active?', 'Fix each fault, then renew again.'],
        tips: ['Get-Service DHCPServer', 'Get-DhcpServerInDC', 'Get-DhcpServerv4Scope', `Set-DhcpServerv4Scope -ScopeId ${net}.0 -State Active`],
      }),
      hints: ['169.254 is APIPA: Windows gave up waiting for a DHCP answer.', 'Three different things must all be right before a lease is handed out.'],
      initialState: system({ machines: [dc01(net), { name: 'DHCP01', features: ['DHCP'], services: { ...baseServices(), DHCPServer: { status: 'Stopped', start: 'Manual' } }, dhcp: { authorized: false, scopes: [{ id: `${net}.0`, name: 'Office', start: `${net}.100`, end: `${net}.199`, mask: '255.255.255.0', active: false, exclusions: [], reservations: [], options: { router: `${net}.1`, dns: [`${net}.10`], domain: 'campus.local' }, leaseDays: 8, leases: [] }] }, nics: [nic(`${net}.12`, net)] }, dhcpClient(pcName, mac)] }),
      checks: [ps(`${pcName} has a lease from ${net}.0/24`, '(Get-NetIPConfiguration).IPv4Address', { machine: pcName, pattern: `^${net.replace(/\./g, '\\.')}\\.1\\d\\d$` }), ps(`${pcName} has the router`, '(Get-NetIPConfiguration).IPv4DefaultGateway', { machine: pcName, equals: `${net}.1` }), ps('The DHCP service starts automatically', '(Get-Service DHCPServer).StartType', { machine: 'DHCP01', equals: 'Automatic' })],
      solution: [`Invoke-Command -ComputerName ${pcName} -ScriptBlock { ipconfig /renew }`, `Invoke-Command -ComputerName DHCP01 -ScriptBlock { Set-Service DHCPServer -StartupType Automatic; Start-Service DHCPServer; Add-DhcpServerInDC; Set-DhcpServerv4Scope -ScopeId ${net}.0 -State Active }`, `Invoke-Command -ComputerName ${pcName} -ScriptBlock { ipconfig /renew }`],
      realityNote: 'Unauthorised servers, inactive scopes and stopped services are the three classic Windows DHCP outages; a checklist finds them in minutes.',
    };
  }),

  /* ---------------------------------------------------------------- 7.3 DNS server */
  tmpl(7, 3, 'beginner', 'dns-records', 'Publish a web server in DNS', 'E4', 15, 'Add an A record and a CNAME alias and resolve them from a client.', (v) => {
    const net = v.net();
    const host = v.pick(['intranet', 'moodle', 'portal', 'helpdesk']);
    const alias = v.pick(['www', 'learn', 'support', 'home']);
    const last = v.int(40, 80);
    const pcName = `OFF-PC${v.int(10, 90)}`;
    return {
      instructions: lab({
        situation: `The new web server **${host}** is at **${net}.${last}**. Users should reach it as **${host}.campus.local** and also as **${alias}.campus.local**. Add the records in the AD-integrated zone campus.local on DC01.`,
        steps: [`Add an A record ${host} → ${net}.${last}.`, `Add a CNAME ${alias} → ${host}.campus.local.`, `Resolve both from ${pcName}.`],
        tips: [`Add-DnsServerResourceRecordA -ZoneName campus.local -Name ${host} -IPv4Address ${net}.${last}`, `Add-DnsServerResourceRecordCName -ZoneName campus.local -Name ${alias} -HostNameAlias ${host}.campus.local`],
      }),
      hints: ['A CNAME points at a name, not at an address.', 'Resolve-DnsName shows the CNAME and the address it leads to.'],
      initialState: system({ machines: [dc01(net), { name: 'WEB01', nics: [nic(`${net}.${last}`, net)] }, pc(pcName, net, 60)] }),
      checks: [ps(`${host}.campus.local resolves`, `(Resolve-DnsName ${host}.campus.local).IPAddress`, { machine: pcName, equals: `${net}.${last}` }), ps(`${alias}.campus.local resolves through the alias`, `Resolve-DnsName ${alias}.campus.local`, { machine: pcName, contains: [`${net}.${last}`, 'CNAME'] })],
      solution: [`Add-DnsServerResourceRecordA -ZoneName campus.local -Name ${host} -IPv4Address ${net}.${last}`, `Add-DnsServerResourceRecordCName -ZoneName campus.local -Name ${alias} -HostNameAlias ${host}.campus.local`],
      realityNote: 'CNAMEs let a service name outlive the server behind it: move the service, change one record.',
    };
  }),
  tmpl(7, 3, 'intermediate', 'reverse-and-forwarders', 'Add a reverse zone and forwarders', 'E4', 20, 'Create an AD-integrated reverse zone with PTR records and forward internet names to the ISP.', (v) => {
    const net = v.net();
    const [, b, c] = net.split('.');
    const rev = `${c}.${b}.10.in-addr.arpa`;
    const isp = v.pick([['41.66.199.10', '41.66.199.11'], ['197.251.243.5', '197.251.243.6'], ['154.160.0.20', '154.160.0.21']]);
    return {
      instructions: lab({
        situation: `Two DNS gaps on DC01:\n\n1. There is no **reverse lookup zone** for ${net}.0/24, so logs show only addresses. Create it (AD-integrated) and add PTR records for **DC01 (.10)** and **FS01 (.20)**.\n2. Internet names do not resolve: root hints are off by policy. Forward external queries to the ISP's resolvers **${isp.join(' and ')}**.`,
        steps: [`Create the zone with -NetworkId "${net}.0/24".`, 'Add the two PTR records.', 'Add the forwarders.', 'Test: Resolve-DnsName www.google.com, and a PTR lookup for FS01.'],
        tips: [`Add-DnsServerPrimaryZone -NetworkId "${net}.0/24" -ReplicationScope Domain`, `Add-DnsServerResourceRecordPtr -ZoneName ${rev} -Name 20 -PtrDomainName fs01.campus.local`, `Add-DnsServerForwarder -IPAddress ${isp.join(',')}`, `Resolve-DnsName 20.${rev} -Type PTR`],
      }),
      hints: [`The reverse zone for ${net}.0/24 is ${rev}.`, 'PTR records are named by the last octet.'],
      initialState: system({ machines: [dc01(net, { dns: { forwarders: [], rootHints: false } }), fs01(net)] }),
      checks: [ps('FS01 resolves backwards', `Resolve-DnsName 20.${rev} -Type PTR`, { contains: 'fs01.campus.local' }), ps('DC01 resolves backwards', `Resolve-DnsName 10.${rev} -Type PTR`, { contains: 'dc01.campus.local' }), ps('The reverse zone is AD-integrated', `(Get-DnsServerZone -Name ${rev}).IsDsIntegrated`, { equals: 'True' }), ps('Internet names resolve', '(Resolve-DnsName www.google.com).IPAddress', { equals: '142.250.184.4' }), ps('The ISP resolvers are the forwarders', '(Get-DnsServerForwarder).IPAddress', { contains: isp })],
      solution: [`Add-DnsServerPrimaryZone -NetworkId "${net}.0/24" -ReplicationScope Domain`, `Add-DnsServerResourceRecordPtr -ZoneName ${rev} -Name 10 -PtrDomainName dc01.campus.local`, `Add-DnsServerResourceRecordPtr -ZoneName ${rev} -Name 20 -PtrDomainName fs01.campus.local`, `Add-DnsServerForwarder -IPAddress ${isp.join(',')}`],
      realityNote: 'Reverse zones make logs and traceroutes readable; forwarders to a known resolver are the usual way internal DNS reaches the internet.',
    };
  }),
  tmpl(7, 3, 'advanced', 'dns-cleanup', 'Clean up stale DNS records and lock down updates', 'E4', 25, 'Remove stale records, require secure dynamic updates and turn on aging and scavenging.', (v) => {
    const net = v.net();
    const host = v.pick(['intranet', 'sis', 'library', 'erp']);
    const [oldIp, newIp] = [`${net}.${v.int(40, 60)}`, `${net}.${v.int(61, 90)}`];
    const gone = v.pick(['oldfs01', 'web2016', 'testsql']);
    const pcName = `OFF-PC${v.int(10, 90)}`;
    return {
      instructions: lab({
        situation: `Users sometimes reach the **old** ${host} server: **${host}.campus.local** has two A records, the stale **${oldIp}** and the current **${newIp}**. **${gone}** was decommissioned last year but still resolves. The zone also accepts **non-secure** dynamic updates, so any device can overwrite records. Fix all three, and turn on **aging and scavenging** so stale records clean themselves up in future.`,
        steps: ['List the records with Get-DnsServerResourceRecord.', `Remove the stale ${host} record (only the one with ${oldIp}) and ${gone}.`, 'Set the zone to Secure dynamic updates.', 'Turn on aging on the zone and scavenging on the server.'],
        tips: [`Remove-DnsServerResourceRecord -ZoneName campus.local -Name ${host} -RRType A -RecordData ${oldIp} -Force`, 'Set-DnsServerPrimaryZone -Name campus.local -DynamicUpdate Secure', 'Set-DnsServerZoneAging -Name campus.local -Aging $true', 'Set-DnsServerScavenging -ScavengingState $true -ApplyOnAllZones'],
      }),
      hints: ['Without -RecordData you would delete both A records.', 'Secure updates need an AD-integrated zone, which campus.local is.'],
      initialState: system({ machines: [dc01(net), pc(pcName, net, 61)], ad: (st) => { st.zones.push({ name: 'campus.local', kind: 'Primary', adIntegrated: true, reverse: false, dynamicUpdate: 'NonsecureAndSecure', records: [...srvRecords('campus.local', [{ name: 'DC01', ip: `${net}.10` }]), { name: host, type: 'A', data: oldIp }, { name: host, type: 'A', data: newIp }, { name: gone, type: 'A', data: `${net}.${v.int(91, 99)}` }, { name: pcName.toLowerCase(), type: 'A', data: `${net}.61` }] }); } }),
      checks: [ps(`${host} resolves only to ${newIp}`, `(Resolve-DnsName ${host}.campus.local).IPAddress`, { machine: pcName, equals: newIp }), ps(`${gone} no longer resolves`, `Resolve-DnsName ${gone}.campus.local`, { allowError: true, contains: 'does not exist' }), ps('Only secure updates are accepted', '(Get-DnsServerZone -Name campus.local).DynamicUpdate', { equals: 'Secure' }), ps('Aging is on', '(Get-DnsServerZone -Name campus.local).Aging', { equals: 'True' })],
      solution: ['Get-DnsServerResourceRecord -ZoneName campus.local -RRType A', `Remove-DnsServerResourceRecord -ZoneName campus.local -Name ${host} -RRType A -RecordData ${oldIp} -Force`, `Remove-DnsServerResourceRecord -ZoneName campus.local -Name ${gone} -RRType A -Force`, 'Set-DnsServerPrimaryZone -Name campus.local -DynamicUpdate Secure', 'Set-DnsServerZoneAging -Name campus.local -Aging $true', 'Set-DnsServerScavenging -ScavengingState $true -ApplyOnAllZones'],
      realityNote: 'Stale records cause "sometimes it goes to the old server" tickets; scavenging needs both zone aging and server scavenging switched on, which is why it is so often half-configured.',
    };
  }),

  /* ---------------------------------------------------------------- 7.4 SRV records and troubleshooting */
  tmpl(7, 4, 'beginner', 'find-the-dcs', 'Find the domain controllers through DNS', 'E4', 15, 'Query the _ldap SRV records and use nltest to see how clients locate DCs.', (v) => {
    const net = v.net();
    const n = v.int(2, 3);
    const names = ['DC01', ...v.some(['DC02', 'ADDC-KSI', 'DC-TML', 'DC03'], n - 1)];
    const file = 'C:\\Answers\\dcs.txt';
    return {
      instructions: lab({
        situation: 'Clients find domain controllers by asking DNS for the **_ldap._tcp.dc._msdcs.campus.local** SRV records. List what DNS advertises, then see which DC a client actually picks.',
        steps: ['Query the SRV records with nslookup -type=SRV (or Resolve-DnsName -Type SRV).', 'Run nltest /dsgetdc:campus.local.', `Write **${file}** with one DC host name (FQDN) per line, then a line \`Port: <the LDAP port>\`.`],
        tips: ['nslookup -type=SRV _ldap._tcp.dc._msdcs.campus.local', 'nltest /dsgetdc:campus.local'],
      }),
      hints: ['Each SRV record gives priority, weight, port and target host.', 'LDAP is TCP 389.'],
      initialState: system({ machines: [dc01(net), ...names.slice(1).map((d, i) => dcN(net, d, 11 + i))], files: { 'C:\\Answers\\README.txt': 'Answer files go here.\n' }, ad: (st) => { st.sites[0].dcs.push(...names.slice(1)); } }),
      checks: [ps('Every DC is listed', `Get-Content ${file}`, { contains: names.map((d) => `${d.toLowerCase()}.campus.local`) }), ps('The LDAP port is recorded', `Get-Content ${file}`, { contains: 'Port: 389' })],
      solution: ['nslookup -type=SRV _ldap._tcp.dc._msdcs.campus.local', 'nltest /dsgetdc:campus.local', `Set-Content ${file} ${names.map((d) => `"${d.toLowerCase()}.campus.local"`).join(',')},"Port: 389"`],
      realityNote: 'The DC locator process (DNS SRV lookup, then an LDAP ping) is why AD breaks the moment clients use the wrong DNS server.',
    };
  }),
  tmpl(7, 4, 'intermediate', 'missing-srv', 'Bring back a DC\'s missing SRV records', 'E4', 20, 'Fix a DC\'s DNS client settings and re-register its locator records.', (v) => {
    const net = v.net();
    const dc2 = v.pick(['DC02', 'ADDC-KSI', 'DC-TML']);
    const bad = v.pick(['8.8.8.8', '1.1.1.1', '127.0.0.1']);
    return {
      instructions: lab({
        situation: `**${dc2}** works, but no client ever uses it: DNS has no SRV records for it. Its own DNS client points at **${bad}**, so Netlogon could not register them. Point ${dc2}'s DNS at **DC01 (${net}.10)** first and itself second, then re-register its records.`,
        steps: [`Check the SRV records: are any for ${dc2.toLowerCase()}.campus.local?`, `On ${dc2}, set the DNS servers.`, `Re-register with nltest /dsregdns on ${dc2}.`, 'Query the SRV records again.'],
        tips: [`Invoke-Command -ComputerName ${dc2} -ScriptBlock { Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.10,${net}.11; nltest /dsregdns }`],
      }),
      hints: ['A DC registers its SRV records through its own DNS client settings.', 'Restarting Netlogon does the same as nltest /dsregdns.'],
      initialState: system({ machines: [dc01(net), dcN(net, dc2, 11, 'Default-First-Site-Name', { nics: [nic(`${net}.11`, net, { dns: [bad] })] })], ad: (st) => { st.sites[0].dcs.push(dc2); st.zones.push({ name: 'campus.local', kind: 'Primary', adIntegrated: true, reverse: false, dynamicUpdate: 'Secure', records: [...srvRecords('campus.local', [{ name: 'DC01', ip: `${net}.10` }]), { name: dc2.toLowerCase(), type: 'A', data: `${net}.11` }] }); } }),
      checks: [ps(`${dc2} is advertised`, 'Resolve-DnsName _ldap._tcp.dc._msdcs.campus.local -Type SRV | ForEach-Object { $_.NameTarget }', { contains: `${dc2.toLowerCase()}.campus.local` }), ps(`${dc2} uses DC01 for DNS`, '(Get-NetIPConfiguration).DNSServer', { machine: dc2, contains: `${net}.10`, notContains: bad })],
      solution: [`Invoke-Command -ComputerName ${dc2} -ScriptBlock { Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.10,${net}.11; nltest /dsregdns }`],
      realityNote: 'A DC pointing at a public resolver is a classic mistake: it works until the day its records need registering.',
    };
  }),
  tmpl(7, 4, 'advanced', 'dcdiag-repadmin', 'Get dcdiag and repadmin clean again', 'E4', 30, 'Use dcdiag and repadmin to find DNS, service and time faults across three DCs and fix them.', (v) => {
    const net = v.net();
    const skew = v.pick([7, 11, 16, -9]);
    return {
      instructions: lab({
        situation: 'Replication has been failing for days. The DCs are **DC01** (you are on it), **DC02** and **DC03**. Run the health tools, find every fault, and fix them until `dcdiag /q` reports nothing and `repadmin /replsummary` shows no failures.',
        steps: ['Run dcdiag on DC01 and read the failed tests.', 'Run repadmin /replsummary and read the error for each DC.', 'Fix each cause: DNS client settings, a stopped service, a clock.', 'Run repadmin /syncall /AdeP and the checks again.'],
        tips: ['dcdiag /q', 'repadmin /replsummary', 'repadmin /syncall /AdeP'],
      }),
      hints: ['Error 8524 is a DNS lookup failure; 1398 is a time difference.', 'A DC should use another DC (or itself) for DNS, never a public resolver.'],
      initialState: system({ machines: [dc01(net, { nics: [nic(`${net}.10`, net, { dns: ['8.8.8.8'] })] }), dcN(net, 'DC02', 11, 'Default-First-Site-Name', { services: { ...baseServices(), DNS: svc.running, NTDS: { status: 'Stopped', start: 'Automatic' }, Netlogon: svc.running, Kdc: svc.running } }), dcN(net, 'DC03', 12, 'Default-First-Site-Name', { timeOffsetMin: skew })], ad: (st) => { st.sites[0].dcs.push('DC02', 'DC03'); } }),
      checks: [ps('dcdiag passes on DC01', 'dcdiag /q', { notContains: 'failed' }), ps('Replication has no failures', 'repadmin /replsummary', { notContains: '100' }), ps('repadmin /syncall succeeds', 'repadmin /syncall /AdeP', { contains: 'no errors' })],
      solution: ['dcdiag /q', 'repadmin /replsummary', `Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses ${net}.11,${net}.10`, 'Invoke-Command -ComputerName DC02 -ScriptBlock { Start-Service NTDS }', 'Invoke-Command -ComputerName DC03 -ScriptBlock { w32tm /resync }', 'repadmin /syncall /AdeP'],
      realityNote: 'dcdiag and repadmin /replsummary are the first two commands of every AD health check; DNS and time cause most of what they find.',
    };
  }),

  /* ---------------------------------------------------------------- 7.5 IPv6 */
  tmpl(7, 5, 'beginner', 'ipv6-address', 'Give a server a static IPv6 address and an AAAA record', 'E4', 15, 'Assign a unique local IPv6 address and publish it in DNS.', (v) => {
    const net = v.net();
    const prefix = `fd${hex(v, 2)}:${hex(v, 4)}:${hex(v, 4)}:${v.int(1, 9)}`;
    const addr = `${prefix}::20`;
    return {
      instructions: lab({
        situation: `The campus is piloting IPv6 with the unique local prefix **${prefix}::/64**. Give **FS01** the address **${addr}/64** and publish it in DNS as an **AAAA** record for fs01.campus.local.`,
        steps: ['On FS01, add the address with New-NetIPAddress.', 'On DC01, add the AAAA record.', 'Check Get-NetIPAddress -AddressFamily IPv6 on FS01 and Resolve-DnsName -Type AAAA.'],
        tips: [`New-NetIPAddress -InterfaceAlias Ethernet -IPAddress ${addr} -PrefixLength 64`, `Add-DnsServerResourceRecordAAAA -ZoneName campus.local -Name fs01 -IPv6Address ${addr}`],
      }),
      hints: ['fd00::/8 addresses are unique local addresses, the IPv6 equivalent of private ranges.', 'Every Windows interface also has an fe80:: link-local address already.'],
      initialState: system({ machines: [dc01(net), fs01(net)] }),
      checks: [ps('FS01 has the address', 'Get-NetIPAddress -AddressFamily IPv6 | ForEach-Object { $_.IPAddress }', { machine: 'FS01', contains: addr }), ps('fs01.campus.local has an AAAA record', 'Resolve-DnsName fs01.campus.local -Type AAAA', { contains: addr })],
      solution: [`Invoke-Command -ComputerName FS01 -ScriptBlock { New-NetIPAddress -InterfaceAlias Ethernet -IPAddress ${addr} -PrefixLength 64 }`, `Add-DnsServerResourceRecordAAAA -ZoneName campus.local -Name fs01 -IPv6Address ${addr}`],
      realityNote: 'Windows prefers IPv6 when both are available, so AAAA records change real traffic: publish them only for addresses that work.',
    };
  }),
  tmpl(7, 5, 'intermediate', 'ipv6-concepts', 'Read IPv6 on a Windows network', 'E10', 15, 'Interpret link-local, unique local and global addresses, SLAAC and DHCPv6, and the IPv6 advice for Windows.', (v) => {
    const g = `2001:db8:${hex(v, 4)}:${v.int(10, 99)}`;
    return caseStudy(v, {
      intro: '## What ipconfig is telling you\n\nA lecturer pastes `ipconfig /all` output from a lab PC into the helpdesk chat and asks what all the IPv6 addresses mean.',
      steps: [
        { title: 'fe80 addresses', text: 'Every adapter shows an address starting fe80::. What is it?', evidence: [{ title: 'ipconfig /all (extract)', kind: 'log', text: `Link-local IPv6 Address . . . . . : fe80::7c2a:91ff:fe00:1%12\nIPv6 Address. . . . . . . . . . . : ${g}::4a1:9c3e:12:7\nTemporary IPv6 Address. . . . . . : ${g}::d11:5b2:8e0:44\nDefault Gateway . . . . . . . . . : fe80::1%12\n                                    10.20.30.1` }], choices: [{ text: 'A link-local address, created automatically, valid only on that network segment', right: true, feedback: 'Correct. Every IPv6 interface has one; routers never forward it.' }, { text: 'An address from the DHCP server', feedback: 'fe80::/10 is generated by the host itself.' }, { text: 'A sign that IPv6 is misconfigured', feedback: 'It is normal and required for neighbour discovery.' }] },
        { title: 'Gateway', text: 'Why is the IPv6 default gateway fe80::1 rather than a global address?', choices: [{ text: 'Routers advertise themselves with their link-local address in router advertisements', right: true, feedback: 'Correct. Next hops on the local link are link-local.' }, { text: 'The router has no global address', feedback: 'It may well have one; next-hop addresses are link-local by design.' }, { text: 'It is a placeholder until DHCPv6 answers', feedback: 'No placeholder: it is the real next hop.' }] },
        { title: 'Where the global address came from', text: `The PC got ${g}::/64 addresses without any DHCPv6 server. How?`, choices: [{ text: 'SLAAC: the router advertised the /64 prefix and the PC built its own address', right: true, feedback: 'Correct. Stateless address autoconfiguration.' }, { text: 'APIPA', feedback: 'APIPA is the IPv4 fallback (169.254).' }, { text: 'The DNS server assigned it', feedback: 'DNS resolves names; it does not hand out addresses.' }] },
        { title: 'Temporary address', text: 'Why does Windows also have a "temporary" IPv6 address?', choices: [{ text: 'Privacy extensions: outbound connections use a changing address so the device is harder to track', right: true, feedback: 'Correct. RFC 8981 privacy addresses.' }, { text: 'It is waiting for a permanent lease', feedback: 'Both addresses are valid; one is for privacy.' }, { text: 'It is a duplicate address error', feedback: 'Duplicates are flagged as such, not as temporary.' }] },
        { title: 'Should IPv6 be disabled?', text: 'A technician wants to untick IPv6 on all servers "to be safe". Advice?', choices: [{ text: 'No: Microsoft tests Windows with IPv6 on; prefer IPv4 by policy if needed rather than disabling it', right: true, feedback: 'Correct. Disabling IPv6 is unsupported for many roles and breaks some components.' }, { text: 'Yes, IPv6 is only needed on the internet', feedback: 'Windows components use IPv6 internally, including on loopback.' }, { text: 'Yes, but only on domain controllers', feedback: 'DCs are the last place to run an untested configuration.' }] },
      ],
      ending: { title: 'Lecturer answered', text: 'Link-local for the segment, SLAAC for the global prefix, privacy addresses for outbound traffic, and IPv6 left on.' },
      hints: ['fe80::/10 link-local, fc00::/7 unique local, 2000::/3 global unicast.', 'Router advertisements carry the prefix.'],
      realityNote: 'Microsoft\'s guidance is to prefer IPv4 over IPv6 through the prefix policy table if necessary, not to disable IPv6.',
    });
  }),
  tmpl(7, 5, 'advanced', 'ipv6-plan', 'Plan IPv6 subnets for a campus', 'E10', 20, 'Divide a /48 into faculty and LAN prefixes and decide DNS and firewall settings.', (v) => {
    const site = `2001:db8:${hex(v, 4)}`;
    const fac = v.int(2, 9);
    const lan = v.int(1, 15);
    const lanHex = lan.toString(16);
    return caseStudy(v, {
      intro: `## Addressing plan\n\nThe university's ISP assigned **${site}::/48**. Every LAN must be a /64. The plan gives each faculty a /56 (faculty number in the third group's first two hex digits).`,
      steps: [
        { title: 'How many LANs', text: 'How many /64 LANs fit in the /48?', choices: [{ text: '65,536 (2^16)', right: true, feedback: 'Correct. 64 - 48 = 16 bits for subnets.' }, { text: '256', feedback: 'That is how many /56s fit in a /48.' }, { text: '4,096', feedback: '2^12 would be /60s in a /48.' }] },
        { title: 'Faculty block', text: `Which prefix is faculty ${fac}'s /56?`, choices: [{ text: `${site}:0${fac}00::/56`, right: true, feedback: 'Correct. The faculty number sits in the first two hex digits of the subnet group.' }, { text: `${site}:${fac}::/56`, feedback: `That is ${site}:000${fac}::, which is inside faculty 0's /56.` }, { text: `${site}::${fac}/56`, feedback: 'The host part is not where subnets go.' }] },
        { title: 'A LAN', text: `Which is LAN ${lan} of faculty ${fac}?`, choices: [{ text: `${site}:0${fac}${lanHex.padStart(2, '0')}::/64`, right: true, feedback: 'Correct. The last two hex digits of the group number the LANs inside the /56.' }, { text: `${site}:0${fac}00:${lanHex}::/64`, feedback: 'That puts the LAN number in the interface identifier part.' }, { text: `${site}:${lanHex}${fac}::/64`, feedback: 'Faculty and LAN are swapped and the faculty digit is in the wrong place.' }] },
        { title: 'Why not /80 or /120?', text: 'A network engineer suggests /120 LANs "to save addresses".', choices: [{ text: 'Keep /64: SLAAC and many features assume a 64-bit interface identifier, and the /48 has plenty', right: true, feedback: 'Correct. RFC 7421 explains why /64 is the norm.' }, { text: 'Use /120 like IPv4 /24s', feedback: 'SLAAC would stop working and nothing is saved that matters.' }, { text: 'Use /127 everywhere', feedback: '/127 is for point-to-point router links only.' }] },
        { title: 'Firewall', text: 'The server team blocks all ICMPv6 inbound "like we block ping". Consequence?', choices: [{ text: 'IPv6 breaks: neighbour discovery and Packet Too Big messages are ICMPv6, so allow the required types', right: true, feedback: 'Correct. RFC 4890 lists the ICMPv6 types not to filter.' }, { text: 'Nothing, ICMPv6 is only ping', feedback: 'ICMPv6 also carries neighbour discovery and path MTU discovery.' }, { text: 'Only traceroute stops working', feedback: 'Address resolution itself stops.' }] },
      ],
      ending: { title: 'Plan approved', text: 'A /56 per faculty, /64 per LAN, AAAA records for servers and the necessary ICMPv6 allowed.' },
      hints: ['Each hex digit is 4 bits.', '/48 to /64 is 16 bits of subnet.'],
      realityNote: 'Nibble-aligned plans (/48, /52, /56, /60, /64) keep IPv6 prefixes readable; RIPE-690 and ARIN guidance recommend them.',
    });
  }),
];
