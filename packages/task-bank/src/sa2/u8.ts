/** Unit 8: installing software packages. */

import type { CheckSpec } from '@cslab/lab-runtime';
import type { TaskTemplate } from '../types';
import { caseStudy, file, lab, linux, out, pkg, ran, svc, tmpl } from './kit';

const docker = (label: string, container: string, o: { running?: boolean; ports?: string[]; restart?: string; mountTarget?: string; image?: string; exists?: boolean }): CheckSpec => ({ type: 'sh.docker', label, container, ...o });
const DEBIAN = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n';

export const U8: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 8.1 package managers, repositories, signing */
  tmpl(8, 1, 'beginner', 'install-a-service', 'Install a service and start it at boot', 'E4', 15, 'Install a package with zypper, then enable and start its service.', (v) => {
    const net = v.net();
    const [p, s, port] = v.pick([['apache2', 'apache2', 80], ['mariadb', 'mariadb', 3306], ['bind', 'named', 53]] as Array<[string, string, number]>);
    return {
      instructions: lab({ situation: `This server needs **${p}**. Install the package, then make its service **${s}** start now and at every boot. Check it with systemctl and ss.`, steps: [`zypper install ${p}.`, `systemctl enable --now ${s}.`, `systemctl status ${s}; ss -tln shows port ${port}.`], tips: [`zypper search ${p}`, `zypper install ${p}`, `systemctl enable --now ${s}`] }),
      hints: ['enable sets up start at boot; --now also starts it immediately.'],
      initialState: linux(net),
      checks: [pkg(`${p} is installed`, p), svc(`${s} is running and enabled`, s, { active: true, enabled: true }), out(`Something listens on ${port}`, 'ss -tln', { contains: `:${port} ` })],
      solution: [`zypper search ${p}`, `zypper install ${p}`, `systemctl enable --now ${s}`, 'ss -tln'],
      realityNote: 'Package managers resolve dependencies, verify signatures and record every file they install, which is why distribution packages beat downloaded tarballs.',
    };
  }),
  tmpl(8, 1, 'intermediate', 'tidy-packages', 'Find the package for a command and remove what is not needed', 'E4', 20, 'Use the package database to install missing tools and remove insecure ones.', (v) => {
    const net = v.net();
    const tools = v.some([['tree', 'tree'], ['htop', 'htop'], ['rsync', 'rsync'], ['zip', 'zip']] as Array<[string, string]>, 2);
    const bad = v.pick(['telnet', 'rsh-client', 'tftp']);
    return {
      instructions: lab({ situation: `The team needs the commands **${tools.map((t) => t[0]).join('** and **')}** on this server. Running a missing command prints which package provides it. Also, an audit found the insecure, unneeded package **${bad}** installed (it sends credentials in clear text): remove it.`, steps: ['Run each command to see the "found in package" message, or use zypper search.', 'Install the packages.', `Remove ${bad}.`, 'Check with rpm -q.'], tips: ['zypper search NAME', 'zypper install PKG', `zypper remove ${bad}`, 'rpm -q PKG'] }),
      hints: ['rpm -q prints "package X is not installed" for missing packages.'],
      initialState: linux(net, { packages: { [bad]: { installed: true, version: '0.17', description: `${bad} client (clear-text protocol)` } } }),
      checks: [...tools.map(([c, p]) => pkg(`${c} is available`, p)), pkg(`${bad} is removed`, bad, false), out('The package database agrees', `rpm -q ${tools.map((t) => t[1]).join(' ')}`, { notContains: 'not installed' })],
      solution: [tools[0][0], `zypper install ${tools.map((t) => t[1]).join(' ')}`, `zypper remove ${bad}`, `rpm -q ${tools.map((t) => t[1]).join(' ')}`],
      realityNote: 'Removing clear-text clients and servers (telnet, rsh, tftp) is a standard hardening step; fewer packages means fewer updates and fewer vulnerabilities.',
    };
  }),
  tmpl(8, 1, 'advanced', 'repositories-and-trust', 'Decide which repositories to trust', 'E10', 20, 'Judge repositories, GPG signatures and version pinning for production servers.', (v) => {
    const app = v.pick(['a monitoring agent', 'a newer PHP version', 'a database driver']);
    return caseStudy(v, {
      intro: `## Adding ${app}\n\nThe distribution's repositories do not have ${app}. Several options are on the table.`,
      steps: [
        { title: 'A third-party repository', text: 'The vendor offers an official repository with a signing key.', choices: [{ text: 'Add it with its GPG key verified out of band, and limit its priority so it cannot replace base packages', right: true, feedback: 'Correct. Signed, trusted, and contained.' }, { text: 'Add it with signature checking turned off to avoid errors', feedback: 'Then anyone who can tamper with downloads can install code as root.' }, { text: 'Never use anything outside the base repositories', feedback: 'Sometimes a vendor repository is the right answer; control it instead.' }] },
        { title: 'Unknown key', text: 'zypper warns: "Signature verification failed... unknown key". The forum says "just import it".', choices: [{ text: 'Check the key fingerprint against the vendor\'s published one before trusting it', right: true, feedback: 'Correct.' }, { text: 'Import whatever key is offered', feedback: 'That defeats the purpose of signing.' }, { text: 'Use --no-gpg-checks permanently', feedback: 'Same problem, worse.' }] },
        { title: 'A random .rpm from a blog', text: 'Someone found an .rpm on a personal website.', choices: [{ text: 'Do not install it on production: no signature, no updates, unknown origin', right: true, feedback: 'Correct.' }, { text: 'Install it with rpm -i --nodeps', feedback: 'Bypassing dependency checks as well makes it worse.' }, { text: 'Scan it with antivirus first, then install', feedback: 'Antivirus cannot tell you whether the software is trustworthy.' }] },
        { title: 'Updates breaking things', text: 'A minor update of the package broke the application last term.', choices: [{ text: 'Test updates on a staging server first, and lock (pin) the version on production until tested', right: true, feedback: 'Correct. zypper addlock / apt-mark hold.' }, { text: 'Never update it again', feedback: 'Then security fixes never arrive.' }, { text: 'Update production first because it matters most', feedback: 'Production should be the last to change.' }] },
      ],
      ending: { title: 'Policy written', text: 'Signed vendor repositories with verified keys and limited priority, no unsigned packages, staged updates with version locks.' },
      hints: ['Trust comes from verified signatures, not from popularity.'],
      realityNote: 'Supply-chain attacks through package repositories are real; signed repositories and verified keys are the defence every distribution builds on.',
    });
  }),

  /* ---------------------------------------------------------------- 8.2 building from source */
  tmpl(8, 2, 'beginner', 'source-build-steps', 'Understand building software from source', 'E10', 15, 'Put configure, make and make install in order and know where things go.', (v) => {
    const tool = v.pick(['a network monitoring tool', 'a research simulation program', 'a newer version of a compression tool']);
    return caseStudy(v, {
      intro: `## Building ${tool}\n\nIt is not packaged for your distribution, so a lecturer asks you to build it from the source tarball.`,
      steps: [
        { title: 'First step after unpacking', text: 'After tar xzf, what do you read first?', choices: [{ text: 'README and INSTALL, which list dependencies and options', right: true, feedback: 'Correct.' }, { text: 'Run make install straight away', feedback: 'Nothing has been configured or built yet.' }, { text: 'The licence only', feedback: 'Useful, but it will not tell you how to build.' }] },
        { title: 'configure', text: 'What does ./configure do?', choices: [{ text: 'Checks for compilers and libraries and writes Makefiles for this system', right: true, feedback: 'Correct.' }, { text: 'Installs the program', feedback: 'That is make install.' }, { text: 'Downloads the dependencies', feedback: 'It only checks; you install dependencies with the package manager.' }] },
        { title: 'Where to install', text: 'Where should a self-built program go?', choices: [{ text: '/usr/local (the default --prefix), never over files the package manager owns in /usr', right: true, feedback: 'Correct. The FHS reserves /usr/local for exactly this.' }, { text: '/usr/bin, so it is on the PATH', feedback: 'It could overwrite or be overwritten by packaged files.' }, { text: '/tmp', feedback: 'It would vanish.' }] },
        { title: 'Which steps need root?', text: 'Which step should run as root?', choices: [{ text: 'Only make install (into system directories); build as a normal user', right: true, feedback: 'Correct. Compiling as root runs arbitrary build scripts with full rights.' }, { text: 'All of them', feedback: 'Unnecessary risk.' }, { text: 'None, ever', feedback: 'Installing into /usr/local needs root (or a writable prefix).' }] },
      ],
      ending: { title: 'Built', text: 'Read the docs, ./configure, make as a user, make install as root into /usr/local.' },
      hints: ['configure → make → make install.'],
      realityNote: 'GNU autotools established this three-step build decades ago; CMake and Meson follow the same configure, build, install pattern.',
    });
  }),
  tmpl(8, 2, 'intermediate', 'configure-failed', 'Diagnose a failed source build', 'E10', 20, 'Read configure and make errors and fix them with the right development packages.', (v) => {
    const lib = v.pick([['openssl', 'libopenssl-devel', 'openssl/ssl.h'], ['zlib', 'zlib-devel', 'zlib.h'], ['ncurses', 'ncurses-devel', 'curses.h']] as Array<[string, string, string]>);
    return caseStudy(v, {
      intro: '## The build stopped\n\nA build of a lecturer\'s tool keeps failing. Read the errors.',
      steps: [
        { title: 'configure error', text: 'configure stopped with this message.', evidence: [{ title: 'configure output', kind: 'log', text: `checking for ${lib[0]}... no\nconfigure: error: ${lib[0]} development files not found. Install the -devel package or use --without-${lib[0]}.` }], choices: [{ text: `Install the development package (${lib[1]}) with zypper and run configure again`, right: true, feedback: 'Correct. Headers and link libraries live in -devel packages.' }, { text: `Install ${lib[0]} from source too`, feedback: 'The distribution already packages it; use that.' }, { text: 'Delete the check from the configure script', feedback: 'The build will just fail later.' }] },
        { title: 'Compiler error', text: 'make failed.', evidence: [{ title: 'make output', kind: 'log', text: `src/net.c:12:10: fatal error: ${lib[2]}: No such file or directory\n compilation terminated.\nmake: *** [Makefile:42: src/net.o] Error 1` }], choices: [{ text: `The header ${lib[2]} is missing: the -devel package is not installed (or configure was skipped)`, right: true, feedback: 'Correct.' }, { text: 'The compiler is broken', feedback: 'It is telling you exactly which file it cannot find.' }, { text: 'Run make with sudo', feedback: 'Privileges do not create missing headers.' }] },
        { title: 'No compiler', text: 'configure says "no acceptable C compiler found in $PATH".', choices: [{ text: 'Install the compiler toolchain (gcc, make), for example the devel_basis pattern on openSUSE', right: true, feedback: 'Correct.' }, { text: 'Add /usr/bin to PATH', feedback: 'The compiler is not installed at all.' }, { text: 'Use a compiler from a USB stick', feedback: 'Unmanaged and unpatched.' }] },
        { title: 'Keeping track', text: 'After make install, how will you remove or update it later?', choices: [{ text: 'Build an RPM, or use checkinstall/stow, so the package manager or a manifest tracks the files', right: true, feedback: 'Correct.' }, { text: 'Remember which files were copied', feedback: 'You will not.' }, { text: 'Reinstall the OS to remove it', feedback: 'Extreme.' }] },
      ],
      ending: { title: 'Build fixed', text: 'Development packages for headers, the toolchain from the distribution, and installs tracked by a package or manifest.' },
      hints: ['"-devel" packages provide headers.'],
      realityNote: 'Missing -devel (or -dev on Debian) packages cause most first-time build failures.',
    });
  }),
  tmpl(8, 2, 'advanced', 'package-or-build', 'Choose between packaging, building and containers', 'E10', 20, 'Decide how to deliver software that is not in the distribution for a production server.', (v) => {
    const sw = v.pick(['a research lab\'s analysis service', 'an open-source library system', 'a scheduling tool']);
    return caseStudy(v, {
      intro: `## Delivering ${sw}\n\nIt is not in the distribution repositories. It must run on a production server for three years.`,
      steps: [
        { title: 'Options', text: 'Which delivery is easiest to maintain for three years?', choices: [{ text: 'A vendor package or container image with an update channel, or your own RPM built in CI', right: true, feedback: 'Correct. Something with updates and a record of what is installed.' }, { text: 'make install by hand on the server', feedback: 'Every update is manual and untracked.' }, { text: 'Copy the binary from a colleague\'s machine', feedback: 'Unknown build, no updates.' }] },
        { title: 'Security updates', text: 'A vulnerability is found in a library the software bundles.', choices: [{ text: 'With containers or bundled libraries you must rebuild the image or package; with system libraries the distribution update fixes it', right: true, feedback: 'Correct. Bundling moves patching responsibility to you.' }, { text: 'zypper patch fixes everything everywhere', feedback: 'Not libraries inside containers or bundles.' }, { text: 'It does not matter for internal servers', feedback: 'Internal servers get attacked too.' }] },
        { title: 'Reproducibility', text: 'How do you make sure the same version runs in test and production?', choices: [{ text: 'Pin versions (image digests, package versions) and promote the same artefact from test to production', right: true, feedback: 'Correct.' }, { text: 'Build separately on each server', feedback: 'Each build may differ.' }, { text: 'Always pull "latest"', feedback: 'Latest changes under you.' }] },
        { title: 'Documentation', text: 'What must be written down?', choices: [{ text: 'Source, version, build or image reference, configuration and the update procedure', right: true, feedback: 'Correct.' }, { text: 'Nothing: it works', feedback: 'Until the person who installed it leaves.' }, { text: 'Only the admin password', feedback: 'Not enough to maintain it.' }] },
      ],
      ending: { title: 'Decision made', text: 'A packaged or containerised artefact with pinned versions, a patch plan and documentation.' },
      hints: ['Who applies the security fix in each option?'],
      realityNote: 'Open Build Service (openSUSE) and CI pipelines make building your own signed RPMs routine for software the distribution does not ship.',
    });
  }),

  /* ---------------------------------------------------------------- 8.3 containers, Flatpak/Snap, language package managers */
  tmpl(8, 3, 'beginner', 'run-a-container', 'Run a web server in a container', 'E4', 15, 'Install Docker, run an nginx container with a published port and test it.', (v) => {
    const net = v.net();
    const port = v.pick([8080, 8081, 8088]);
    const name = v.pick(['web', 'demo', 'site']);
    return {
      instructions: lab({ situation: `Try a containerised web server: install **docker**, start the Docker service, and run the **nginx** image in the background as container **${name}**, publishing container port 80 on host port **${port}**. Check it with curl.`, steps: ['zypper install docker; systemctl enable --now docker.', `docker run -d --name ${name} -p ${port}:80 nginx.`, `docker ps; curl http://localhost:${port}/.`], tips: [`docker run -d --name ${name} -p ${port}:80 nginx`, 'docker ps', `curl -s http://localhost:${port}/ | head`] }),
      hints: ['-d runs it in the background; -p HOST:CONTAINER publishes a port.'],
      initialState: linux(net),
      checks: [svc('Docker is running', 'docker', { active: true, enabled: true }), docker(`${name} runs nginx on ${port}`, name, { running: true, ports: [`${port}:80`], image: 'nginx:latest' }), out('It answers on the host port', `curl -s http://localhost:${port}/`, { contains: 'Welcome to nginx' })],
      solution: ['zypper install docker', 'systemctl enable --now docker', `docker run -d --name ${name} -p ${port}:80 nginx`, `curl -s http://localhost:${port}/`],
      realityNote: 'Containers ship an application with its userland; the host kernel is shared, which is why they start in a second and still need host patching.',
    };
  }),
  tmpl(8, 3, 'intermediate', 'delivery-formats', 'Choose between packages, Flatpak, Snap and containers', 'E10', 15, 'Match software delivery formats to desktops, servers and developer tools.', (v) => {
    const desk = v.pick(['the library\'s public PCs', 'the language lab PCs']);
    return caseStudy(v, {
      intro: `## How should we install it?\n\nThe ICT team supports servers, ${desk} and developers. Match each request to a delivery method.`,
      steps: [
        { title: 'Desktop application', text: `A graphics program is needed on ${desk}, newer than the distribution version.`, choices: [{ text: 'Flatpak (from Flathub): sandboxed desktop app with its own runtime', right: true, feedback: 'Correct. Flatpak targets desktop applications.' }, { text: 'A Docker container on each PC', feedback: 'Containers suit services, not desktop apps.' }, { text: 'Compile it on every PC', feedback: 'Slow and unmanaged.' }] },
        { title: 'Server service', text: 'A web service with many dependencies must run on a stable server.', choices: [{ text: 'A container image (or distribution package) managed by systemd or Podman', right: true, feedback: 'Correct.' }, { text: 'Flatpak', feedback: 'Flatpak is for desktop apps.' }, { text: 'pip install into the system Python as root', feedback: 'Breaks system tools and is untracked.' }] },
        { title: 'Python library for a developer', text: 'A student developer needs a specific version of a Python library.', choices: [{ text: 'A virtual environment in their home directory (python3 -m venv)', right: true, feedback: 'Correct. Isolated from the system and from other projects.' }, { text: 'sudo pip install', feedback: 'Changes the system Python for everyone.' }, { text: 'Ask root to install it system-wide', feedback: 'Version conflicts with other users follow.' }] },
        { title: 'Snap on openSUSE', text: 'A vendor ships only a Snap.', choices: [{ text: 'Possible with snapd, but weigh its auto-updates and confinement against your update policy', right: true, feedback: 'Correct. Snaps update themselves, which suits some cases and not others.' }, { text: 'Snaps only run on Ubuntu', feedback: 'snapd runs on other distributions too.' }, { text: 'Convert it to an RPM by renaming', feedback: 'It does not work like that.' }] },
      ],
      ending: { title: 'Formats matched', text: 'Flatpak for desktop apps, containers or packages for services, virtual environments for language libraries.' },
      hints: ['Desktop app, service or library?'],
      realityNote: 'Each format solves a different problem; mixing them deliberately is normal, mixing them by accident is how systems become unmaintainable.',
    });
  }),
  tmpl(8, 3, 'advanced', 'durable-container', 'Run a container that survives restarts and keeps its data', 'E4', 25, 'Run a service with a bind-mounted data directory and a restart policy, then replace it without data loss.', (v) => {
    const net = v.net();
    const name = v.pick(['wiki', 'notes', 'docs']);
    const port = v.pick([8090, 8091, 8092]);
    return {
      instructions: lab({ situation: `Run the **${name}** web container (image **nginx**) so that:\n\n- its content lives on the host in **/srv/${name}** (bind-mounted at **/usr/share/nginx/html**), so replacing the container never loses data,\n- it restarts automatically after crashes and reboots (**--restart unless-stopped**),\n- it publishes port **${port}**.\n\nAn old test container called **${name}** is already running without these settings: remove it first, then run the new one with the same name. The page /srv/${name}/index.html already exists.`, steps: ['docker ps -a.', `docker rm -f ${name}.`, 'docker run with -d, --name, --restart, -v and -p.', `curl localhost:${port}.`], tips: [`docker run -d --name ${name} --restart unless-stopped -v /srv/${name}:/usr/share/nginx/html -p ${port}:80 nginx`] }),
      hints: ['Data written inside a container disappears with the container; volumes and bind mounts keep it.'],
      initialState: linux(net, { packages: { docker: { installed: true } }, services: { docker: { active: true, enabled: true, package: 'docker' } }, files: { [`/srv/${name}/index.html`]: `<h1>${name} home</h1>\n`, '/var/lib/docker/state.json': JSON.stringify({ images: [{ repo: 'nginx', tag: 'latest', id: 'a1b2c3d4e5f6', sizeMb: 192, layers: 7, base: 'debian', user: 'root', expose: [80], cmd: 'nginx -g "daemon off;"', workdir: '/', env: {}, files: {}, webRoot: '/usr/share/nginx/html', created: 0 }], containers: [{ id: 'f00dfeed1234', name, image: 'nginx:latest', status: 'running', exitCode: 0, ports: [{ host: port + 100, container: 80 }], env: {}, mounts: [], restart: 'no', network: 'bridge', logs: [], created: 0 }], volumes: [], networks: ['bridge', 'host', 'none'] }) } }),
      checks: [docker(`${name} restarts unless stopped`, name, { running: true, restart: 'unless-stopped' }), docker('The content is bind-mounted', name, { mountTarget: '/usr/share/nginx/html' }), docker(`It publishes ${port}`, name, { ports: [`${port}:80`] }), out('It serves the page from the host directory', `curl -s http://localhost:${port}/`, { contains: `${name} home` })],
      solution: ['docker ps -a', `docker rm -f ${name}`, `docker run -d --name ${name} --restart unless-stopped -v /srv/${name}:/usr/share/nginx/html -p ${port}:80 nginx`, `curl -s http://localhost:${port}/`],
      realityNote: 'Treating containers as disposable and data as separate is the core habit of container operations; Podman with systemd units is the daemonless alternative.',
    };
  }),

  /* ---------------------------------------------------------------- 8.4 patching, unattended upgrades, vulnerabilities */
  tmpl(8, 4, 'beginner', 'apply-patches', 'Patch a server and record it', 'E4', 15, 'Refresh repositories, apply patches and log the change.', (v) => {
    const net = v.net();
    const ticket = `CHG-${v.int(1000, 9999)}`;
    return {
      instructions: lab({ situation: `Patch Tuesday. Under change **${ticket}**: refresh the repositories, apply all patches with zypper, check whether services need a restart, and append a line to **/var/log/patching.log** in the form \`<date> ${ticket} patched\`.`, steps: ['zypper refresh.', 'zypper patch (security fixes) or zypper update.', 'zypper ps lists processes using deleted (old) files.', 'Log the change.'], tips: ['zypper refresh', 'zypper patch', `echo "$(date +%F) ${ticket} patched" >> /var/log/patching.log`] }),
      hints: ['date +%F prints the date as YYYY-MM-DD.'],
      initialState: linux(net),
      checks: [ran('You refreshed the repositories', '^zypper (refresh|ref)\\b'), ran('You applied patches', '^zypper (patch|up|update)\\b'), file('The change is logged', '/var/log/patching.log', { pattern: `\\d{4}-\\d{2}-\\d{2} ${ticket} patched` })],
      solution: ['zypper refresh', 'zypper patch', `echo "$(date +%F) ${ticket} patched" >> /var/log/patching.log`],
      realityNote: 'Logging every patch run against a change number is what lets you answer "what changed?" when something breaks the next morning.',
    };
  }),
  tmpl(8, 4, 'intermediate', 'unattended-upgrades', 'Turn on automatic security updates on Debian', 'E4', 20, 'Install and configure unattended-upgrades with apt periodic settings.', (v) => {
    const net = v.net();
    return {
      instructions: lab({ situation: 'This Debian server in the student lab should install security updates automatically every day. Install **unattended-upgrades** and create **/etc/apt/apt.conf.d/20auto-upgrades** that enables the daily package list update and the daily unattended upgrade.', steps: ['apt install unattended-upgrades.', 'Write the two APT::Periodic lines.', 'Read the file back.'], tips: ['apt install unattended-upgrades', 'APT::Periodic::Update-Package-Lists "1";', 'APT::Periodic::Unattended-Upgrade "1";'] }),
      hints: ['The value "1" means every day.'],
      initialState: linux(net, { files: { '/etc/os-release': DEBIAN, '/etc/apt/apt.conf.d/': null }, packages: { 'unattended-upgrades': { installed: false, version: '2.9', description: 'Automatic installation of security upgrades' } } }),
      checks: [pkg('unattended-upgrades is installed', 'unattended-upgrades'), file('Package lists update daily', '/etc/apt/apt.conf.d/20auto-upgrades', { pattern: 'APT::Periodic::Update-Package-Lists\\s+"1";' }), file('Upgrades run daily', '/etc/apt/apt.conf.d/20auto-upgrades', { pattern: 'APT::Periodic::Unattended-Upgrade\\s+"1";' }), ran('You used apt', '^apt(-get)? install')],
      solution: ['apt install unattended-upgrades', `printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades`, 'cat /etc/apt/apt.conf.d/20auto-upgrades'],
      realityNote: 'Automatic security updates suit fleets of similar machines like labs; critical servers usually get staged, scheduled patching instead.',
    };
  }),
  tmpl(8, 4, 'advanced', 'cve-triage', 'Triage vulnerability reports', 'E10', 20, 'Prioritise CVEs by exposure and severity and decide how fast to patch.', (v) => {
    const svcName = v.pick(['the web server', 'the SSH server']);
    return caseStudy(v, {
      intro: '## Monday\'s vulnerability report\n\nThe scanner lists four findings across the faculty\'s servers. Decide what to do with each.',
      steps: [
        { title: 'Critical, internet-facing', text: `A critical remote-code-execution flaw (CVSS 9.8) in ${svcName}, which is reachable from the internet; a public exploit exists.`, choices: [{ text: 'Patch or mitigate within hours, as an emergency change', right: true, feedback: 'Correct. Exposure plus a public exploit make it urgent.' }, { text: 'Wait for the monthly patch window', feedback: 'Attackers will not wait a month.' }, { text: 'Ignore it: the firewall protects us', feedback: 'It is reachable by definition.' }] },
        { title: 'High, internal only', text: 'A high-severity local privilege escalation in the kernel on a server only staff can log in to.', choices: [{ text: 'Patch in the next scheduled window this week, with a reboot planned', right: true, feedback: 'Correct. Serious, but needs an account first.' }, { text: 'Emergency reboot of everything now', feedback: 'Proportion matters; schedule it soon.' }, { text: 'Never: only staff can log in', feedback: 'Stolen staff credentials are common.' }] },
        { title: 'Not installed', text: 'The scanner flags a vulnerable package version that is not actually installed (it matched a file name).', choices: [{ text: 'Confirm with rpm -q, then record it as a false positive', right: true, feedback: 'Correct. Verify before acting or dismissing.' }, { text: 'Install the package to then patch it', feedback: 'That adds the risk.' }, { text: 'Turn the scanner off', feedback: 'False positives are a reason to tune, not to stop scanning.' }] },
        { title: 'No fix yet', text: 'A medium flaw has no patch yet from the distribution.', choices: [{ text: 'Apply the published mitigation (configuration change or disable the feature) and watch for the fix', right: true, feedback: 'Correct.' }, { text: 'Build a patched version from upstream source on production', feedback: 'Risky and unmaintained; mitigate and wait.' }, { text: 'Do nothing until the patch exists', feedback: 'Mitigations exist for a reason.' }] },
      ],
      ending: { title: 'Report handled', text: 'Exposure and exploitability drive urgency; verify findings, mitigate when no fix exists.' },
      hints: ['Ask: can an attacker reach it, and is there an exploit?'],
      realityNote: 'CISA\'s Known Exploited Vulnerabilities list and the distributions\' security advisories (SUSE, Debian, Red Hat) are the usual inputs for this triage.',
    });
  }),
];
