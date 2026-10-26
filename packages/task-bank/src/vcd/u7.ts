/** Unit 7: containers — images and containers, Dockerfiles, registries, Compose and a first look at Kubernetes. */

import type { TaskTemplate } from '../types';
import type { Org, Person, Variant } from './kit';
import { seedRepo, type SeedCommit } from '@cslab/engine-shell/src/git-state';
import { C, HOST, ORGS, caseStudy, clusterFiles, container, dimg, dock, dockerBits, dockerDev, dockerStateFile, file, fuser, image, kc, lab, out, owned, pkgCheck, registryPackage, simToken, tmpl, withForge, write } from './kit';

/* ----------------------------------------------------------------------------- shared pieces */

const GOODS = [
  ['rice (5 kg)', 95],
  ['cooking oil (1 L)', 42],
  ['tomato paste (tin)', 9],
  ['sugar (1 kg)', 18],
  ['gari (2 kg)', 30],
  ['maize (bag)', 410],
  ['yam (tuber)', 25],
  ['onions (basket)', 160],
] as const;

/** The status page script used by the web app images: waits for its dependencies, then serves. */
function appScript(o: { name: string; waits?: Array<[string, number]>; retries?: number; extra?: string; requireEnv?: string[] }): string {
  const lines = ['#!/bin/sh'];
  for (const e of o.requireEnv ?? []) lines.push(`: "\${${e}:?${e} is not set}"`);
  if (o.waits?.length) {
    lines.push(`wait_for() {\n  for i in ${Array.from({ length: o.retries ?? 10 }, (_, i) => i + 1).join(' ')}; do\n    nc -z "$1" "$2" && return 0\n    echo "waiting for $1:$2"\n    sleep 1\n  done\n  return 1\n}`);
    for (const [envVar, port] of o.waits) lines.push(`wait_for "$${envVar}" ${port} || { echo "cannot reach $${envVar}:${port}"; exit 1; }`);
  }
  if (o.extra) lines.push(o.extra);
  lines.push('mkdir -p /srv/www', `printf '<h1>%s</h1>\\n' "${o.name}" > /srv/www/index.html`);
  for (const [envVar] of o.waits ?? []) lines.push(`echo "<p>$${envVar}: ok</p>" >> /srv/www/index.html`);
  lines.push('echo ok > /srv/www/healthz', 'echo "${APP_VERSION:-dev}" > /srv/www/version', 'echo "ready on 8080"', 'exec httpd -f -p 8080 -h /srv/www');
  return lines.join('\n') + '\n';
}

const home = (me: Person) => `/home/${me.sam}`;

export const U7: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 7.1 why containers; images vs containers; namespaces and cgroups */
  tmpl(7, 1, 'beginner', 'why-containers', 'Decide where containers help', 'E10', 15, 'Reason about images, containers, virtual machines, namespaces and cgroups for a small team\'s servers.', (v) => {
    const o = v.pick(ORGS);
    const services = v.int(3, 5);
    const ram = v.pick([2, 4]);
    return caseStudy(v, {
      intro: `## One small server, ${services} services\n\n${o.org} runs its ${o.what} and ${services - 1} other small services on a single ${ram} GB VPS. Each service was installed by hand; the last upgrade of one service's language runtime broke another. A developer says "it works on my laptop" about every bug. You are asked whether containers would help.`,
      steps: [
        { title: 'Works on my machine', text: 'The laptop runs one runtime version, the server another, with different libraries.', choices: [{ text: 'Package each service with its runtime and libraries as an image, so the same image runs on the laptop, in CI and on the server', right: true, feedback: 'Correct. An image carries the application and everything it needs, so every environment runs the same bits.' }, { text: 'Write a longer README of installation steps', feedback: 'Manual steps drift; that is how the two machines diverged.' }, { text: 'Give every developer SSH access to the server to test there', feedback: 'That makes the server the only reliable environment and invites accidents.' }] },
        { title: 'Virtual machines or containers', text: `Five services on a ${ram} GB VPS.`, choices: [{ text: 'Containers: they share the host\'s kernel, so each one costs only its own processes, not a whole operating system', right: true, feedback: 'Correct. A VM boots a full guest OS with its own kernel and memory; a container is isolated processes on the host kernel.' }, { text: `Five VMs, one per service, on the ${ram} GB VPS`, feedback: `Each VM needs its own OS and memory; ${ram} GB will not stretch that far.` }, { text: 'Neither; isolation is not worth anything on one server', feedback: 'The broken upgrade shows that isolation between services is exactly what was missing.' }] },
        { title: 'Image or container', text: 'Someone fixed a config file inside a running container with docker exec. Next week the container was recreated and the fix vanished.', choices: [{ text: 'The image is the read-only template; a container is one running instance with its own thin writable layer, thrown away when the container is removed. Fix the Dockerfile and rebuild', right: true, feedback: 'Correct. Changes belong in the image definition (or in a volume for data), never only in a running container.' }, { text: 'Containers lose files at random; back them up hourly', feedback: 'Nothing random happened: a new container starts from the image again.' }, { text: 'Never recreate containers', feedback: 'Recreating from the image is how you upgrade and recover; it must be safe.' }] },
        { title: 'What keeps them apart', text: 'How can two containers on one kernel not see each other\'s processes or use each other\'s ports?', choices: [{ text: 'Linux namespaces give each container its own view of processes (PID), network, mounts and host name; cgroups limit how much CPU and memory each may use', right: true, feedback: 'Correct. Namespaces control what a process can see; cgroups control how much it can use.' }, { text: 'Each container runs its own Linux kernel', feedback: 'That is a virtual machine. Containers share the host\'s kernel.' }, { text: 'Docker encrypts each container\'s memory', feedback: 'Isolation comes from kernel namespaces and cgroups, not encryption.' }] },
        { title: 'One service leaks memory', text: 'One service slowly uses all the memory and the others start failing.', choices: [{ text: 'Give each container a memory limit (a cgroup): the leaking one is OOM-killed and restarted alone, and the others keep their memory', right: true, feedback: 'Correct. Limits contain the damage to the faulty container.' }, { text: 'Add swap and hope', feedback: 'Swap delays the failure and slows every service.' }, { text: 'Restart the whole server nightly', feedback: 'All services suffer for one service\'s bug.' }] },
        { title: 'Is a container a security boundary?', text: 'A teammate wants to run an untrusted plugin with --privileged "since it is in a container anyway".', choices: [{ text: 'No: containers share the kernel, so isolation is weaker than a VM\'s. Run as a non-root user, never --privileged for untrusted code, and keep the host patched', right: true, feedback: 'Correct. Containers reduce what a process can reach, but a privileged container is close to root on the host.' }, { text: 'Yes, nothing can escape a container', feedback: 'Container escapes exist, and --privileged removes most protections.' }, { text: 'It is fine if the container has no network', feedback: 'A privileged container can reach host devices without any network.' }] },
      ],
      ending: { title: 'Containers, used well', text: 'Images make every environment identical; containers isolate services cheaply on one kernel through namespaces and cgroups; fixes go into the image, data into volumes; and a container is not a full security boundary.' },
      hints: ['An image is a template; a container is a running instance of it.', 'Namespaces: what a process can see. Cgroups: how much it can use.'],
      realityNote: 'Docker, Podman and containerd all build on the same kernel features (namespaces, cgroups, overlay file systems) and the same OCI image format.',
    });
  }),
  tmpl(7, 1, 'intermediate', 'image-vs-container', 'See the difference between an image and its containers', 'E4', 20, 'Run two containers from one image, change one of them, and show that the image and the other container are unchanged.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const p1 = v.pick([8081, 8082, 8083]);
    const p2 = p1 + v.pick([10, 20]);
    const msg = `${o.what} maintenance at ${v.int(18, 22)}:00`;
    const blue = `${o.org}-blue`;
    const green = `${o.org}-green`;
    return {
      instructions: lab({
        situation: `Run two containers from the image **nginx:1.27-alpine**: **${blue}** publishing host port **${p1}**, and **${green}** publishing host port **${p2}** (nginx listens on 80 inside). Then, in **${green} only**, replace the home page /usr/share/nginx/html/index.html with \`<h1>${msg}</h1>\`.\n\nShow that:\n\n- ${blue} still serves the default page and ${green} serves yours;\n- a brand-new container from the image still has the default page (the image did not change);\n- \`docker diff ${green}\` lists the changed file; save its output to **~/green-diff.txt**.`,
        steps: [`docker run -d --name ${blue} -p ${p1}:80 nginx:1.27-alpine`, `docker run -d --name ${green} -p ${p2}:80 nginx:1.27-alpine`, `docker exec ${green} sh -c 'echo "<h1>…</h1>" > /usr/share/nginx/html/index.html'`, `curl -s localhost:${p1}; curl -s localhost:${p2}`, 'docker run --rm nginx:1.27-alpine cat /usr/share/nginx/html/index.html', `docker diff ${green} > ~/green-diff.txt`],
        tips: ['docker ps', `docker exec ${green} cat /usr/share/nginx/html/index.html`, 'docker diff shows A (added), C (changed) and D (deleted) paths in the container\'s writable layer.'],
      }),
      hints: ['docker exec runs a command inside a running container; quote the whole shell command for sh -c.', 'Each container gets its own thin writable layer on top of the shared, read-only image.'],
      initialState: dockerDev({ me, docker: { pulled: ['nginx:1.27-alpine'] } }),
      checks: [
        dock(`${blue} runs on ${p1}`, blue, { running: true, ports: [`${p1}:80`], image: 'nginx:1.27-alpine' }),
        dock(`${green} runs on ${p2}`, green, { running: true, ports: [`${p2}:80`], image: 'nginx:1.27-alpine' }),
        out(`${blue} serves the default page`, `curl -s localhost:${p1}`, { contains: 'Welcome to nginx' }),
        out(`${green} serves the new page`, `curl -s localhost:${p2}`, { contains: msg }),
        out('A new container from the image has the default page', 'docker run --rm nginx:1.27-alpine cat /usr/share/nginx/html/index.html', { contains: 'Welcome to nginx' }),
        file('The diff of the green container is saved', `${home(me)}/green-diff.txt`, { contains: 'C /usr/share/nginx/html/index.html' }),
      ],
      solution: [`docker run -d --name ${blue} -p ${p1}:80 nginx:1.27-alpine`, `docker run -d --name ${green} -p ${p2}:80 nginx:1.27-alpine`, `docker exec ${green} sh -c 'echo "<h1>${msg}</h1>" > /usr/share/nginx/html/index.html'`, `curl -s localhost:${p1} | head -4`, `curl -s localhost:${p2}`, 'docker run --rm nginx:1.27-alpine cat /usr/share/nginx/html/index.html | head -4', `docker diff ${green} > ~/green-diff.txt`, 'cat ~/green-diff.txt'],
      realityNote: 'This is the copy-on-write model of every OCI runtime: image layers are shared and read-only, and each container writes to its own layer, which disappears with the container.',
    };
  }),
  tmpl(7, 1, 'advanced', 'limits-and-isolation', 'Diagnose an OOM kill and set resource limits', 'E4', 30, 'Find out why a container died, run its replacement with memory, CPU and restart limits, and record what its namespaces and cgroup look like.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const need = v.pick([150, 180, 220]);
    const limit = v.pick([256, 320, 384]);
    const cpus = v.pick(['0.5', '0.75', '1.5']);
    const retries = v.int(2, 5);
    const img = image(`${o.org}/report:1.${v.int(2, 9)}`, 'alpine:3.20', { files: { '/usr/local/bin/worker.sh': { content: `#!/bin/sh\necho "report worker ready (${o.what})"\nwhile true; do\n  sleep 3600\ndone\n`, mode: '755' } }, cmd: 'worker.sh', memMb: need });
    const ref = `${img.repo}:${img.tag}`;
    const old = `${o.org}-report-old`;
    const nu = `${o.org}-report`;
    const dead = container(old, img, { status: 'exited', exitCode: 137, oomKilled: true, memory: 64 * 1024 * 1024, logs: [`report worker ready (${o.what})`, 'Killed'], finished: Date.UTC(2026, 9, 20, 9, 12) });
    const iso = `${home(me)}/isolation.txt`;
    const field = (k: string) => `$(sed -n 's/^${k.replace('.', '\\.')}=//p' ${iso})`;
    return {
      instructions: lab({
        situation: `The nightly report container **${old}** (image **${ref}**) stopped last night. Investigate and replace it:\n\n1. Find out **why it stopped**. Record it in **~/incident.txt** as two lines: \`oomkilled=…\` and \`exitcode=…\` (the values Docker reports).\n2. Run the replacement **${nu}** from the same image, detached, with a **memory limit of ${limit} MB**, **${cpus} CPUs**, and restart policy **on-failure, at most ${retries} retries**. Leave the old container for the post-mortem.\n3. Record how the new container is isolated, in **~/isolation.txt**:\n   - \`pid1=\` the command name of PID 1 **inside** the container (\`docker exec ${nu} ps\`),\n   - \`hostpid=\` the same process's PID **on the host** (\`docker inspect\`),\n   - \`memory.max=\` the memory limit its cgroup reports (/sys/fs/cgroup/memory.max inside it).`,
        steps: ['docker ps -a; docker logs ' + old, `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}}' ${old}`, `docker run -d --name ${nu} --memory ${limit}m --cpus ${cpus} --restart on-failure:${retries} ${ref}`, `docker exec ${nu} ps; docker inspect -f '{{.State.Pid}}' ${nu}`, `docker exec ${nu} cat /sys/fs/cgroup/memory.max`],
        tips: ["docker inspect -f '{{.State.OOMKilled}}' NAME", 'Exit code 137 = 128 + 9: the process was killed with SIGKILL.', "docker exec NAME ps -o pid,comm | awk '$1==1'", 'docker stats --no-stream'],
      }),
      hints: ['The old container\'s limit was too small for what the job needs; docker stats shows the new one\'s usage against its limit.', 'Inside the container the job is PID 1; on the host it is an ordinary process with a different PID: the PID namespace.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20'], images: [img], containers: [dead] } }),
      checks: [
        file('The incident notes say it was OOM-killed', `${home(me)}/incident.txt`, { contains: ['oomkilled=true', 'exitcode=137'] }),
        dock(`${nu} is running from ${ref}`, nu, { running: true, image: ref, restart: `on-failure:${retries}` }),
        out(`${nu} has a ${limit} MB memory limit`, `docker inspect -f '{{.HostConfig.Memory}}' ${nu}`, { equals: String(limit * 1024 * 1024) }),
        out(`${nu} may use ${cpus} CPUs`, `docker inspect -f '{{.HostConfig.NanoCpus}}' ${nu}`, { equals: String(Math.round(Number(cpus) * 1e9)) }),
        out('pid1 is what PID 1 runs inside the container', `test -n "${field('pid1')}" && test "${field('pid1')}" = "$(docker exec ${nu} ps -o pid,comm | awk '$1==1{print $2}')" && echo match`, { equals: 'match', message: 'pid1= should be the command name of PID 1 inside the container.' }),
        out('hostpid is its PID on the host', `test -n "${field('hostpid')}" && test "${field('hostpid')}" = "$(docker inspect -f '{{.State.Pid}}' ${nu})" && echo match`, { equals: 'match', message: 'hostpid= should be the PID docker inspect reports (.State.Pid).' }),
        out('memory.max is what the cgroup reports', `test "${field('memory.max')}" = "$(docker exec ${nu} cat /sys/fs/cgroup/memory.max)" && echo match`, { equals: 'match', message: 'memory.max= should be the value of /sys/fs/cgroup/memory.max inside the container.' }),
      ],
      solution: ['docker ps -a', `docker logs ${old}`, `docker inspect -f 'oomkilled={{.State.OOMKilled}}' ${old} > ~/incident.txt`, `docker inspect -f 'exitcode={{.State.ExitCode}}' ${old} >> ~/incident.txt`, `docker run -d --name ${nu} --memory ${limit}m --cpus ${cpus} --restart on-failure:${retries} ${ref}`, 'docker stats --no-stream', `echo "pid1=$(docker exec ${nu} ps -o pid,comm | awk '$1==1{print $2}')" > ~/isolation.txt`, `echo "hostpid=$(docker inspect -f '{{.State.Pid}}' ${nu})" >> ~/isolation.txt`, `echo "memory.max=$(docker exec ${nu} cat /sys/fs/cgroup/memory.max)" >> ~/isolation.txt`, 'cat ~/isolation.txt'],
      realityNote: 'A memory limit is a cgroup setting (memory.max in cgroup v2); when a container exceeds it the kernel OOM killer ends it with SIGKILL, which Docker reports as OOMKilled and exit code 137.',
    };
  }),

  /* ---------------------------------------------------------------- 7.2 Dockerfile, layers, volumes, networks, environment */
  tmpl(7, 2, 'beginner', 'first-dockerfile', 'Write a Dockerfile for a small tool', 'E4', 25, 'Package a shell tool that needs jq into an image that installs its dependency, runs as a non-root user and takes its settings from the environment.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const site = v.city();
    const items = v.some([...GOODS], v.int(3, 5));
    const cheapest = [...items].sort((a, b) => a[1] - b[1])[0][0];
    const tag = `${o.org}/pricecheck:1.${v.int(0, 9)}`;
    const dir = `${home(me)}/pricecheck`;
    const tool = '#!/bin/sh\n# Prints how many items the price list has and which is cheapest.\nset -e\ncount=$(jq length prices.json)\ncheapest=$(jq -r \'min_by(.price) | .name\' prices.json)\necho "${SITE:-unknown}: $count items, cheapest $cheapest"\n';
    const prices = JSON.stringify(items.map(([name, price]) => ({ name, price })), null, 2) + '\n';
    const df = `FROM alpine:3.20\nRUN apk add --no-cache jq\nRUN adduser -D app\nWORKDIR /app\nCOPY pricecheck.sh prices.json ./\nENV SITE="${site}"\nUSER app\nCMD ["./pricecheck.sh"]\n`;
    return {
      instructions: lab({
        situation: `**~/pricecheck** holds **pricecheck.sh**, which reads **prices.json** with **jq**. Package it as the image **${tag}**:\n\n- base image **alpine:3.20**; alpine does not include jq, so install it in the image (with apk, without keeping the package cache);\n- create an unprivileged user **app** and run the tool as that user;\n- put the files in **/app** and make that the working directory;\n- set **SITE** to \`${site}\` by default;\n- make the tool the image's command (exec form), so \`docker run --rm ${tag}\` runs it.\n\nBuild it and run it, then run it again with \`-e SITE=Remote\`.`,
        steps: ['Write ~/pricecheck/Dockerfile: FROM, RUN apk add, RUN adduser, WORKDIR, COPY, ENV, USER, CMD', `docker build -t ${tag} ~/pricecheck`, `docker run --rm ${tag}`, `docker run --rm -e SITE=Remote ${tag}`],
        tips: ['RUN apk add --no-cache jq', 'RUN adduser -D app', 'COPY pricecheck.sh prices.json ./', 'CMD ["./pricecheck.sh"]', 'docker history ' + tag],
      }),
      hints: ['Without jq in the image the tool fails with "jq: not found" even though it works on your machine: the image only has what the Dockerfile puts in it.', 'USER switches the user for the following RUN steps and for the running container; create the user before you switch to it.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20'] }, files: owned({ [`${dir}/pricecheck.sh`]: { content: tool, mode: '755' }, [`${dir}/prices.json`]: prices }, me.sam) }),
      checks: [
        dimg(`${tag} is built on alpine:3.20 and runs as a non-root user`, tag, { base: '^alpine:3\\.20$', notRoot: true, hasFile: '/app/prices.json' }),
        out('It prints the report with the default site', `docker run --rm ${tag}`, { equals: `${site}: ${items.length} items, cheapest ${cheapest}` }),
        out('The site can be changed at run time', `docker run --rm -e SITE=Remote ${tag}`, { equals: `Remote: ${items.length} items, cheapest ${cheapest}` }),
        out('It runs as app', `docker run --rm ${tag} whoami`, { equals: 'app' }),
        file('The Dockerfile installs jq without a cache', `${dir}/Dockerfile`, { contains: ['apk add --no-cache', 'jq', 'USER app'] }),
      ],
      solution: [write('~/pricecheck/Dockerfile', df), `docker build -t ${tag} ~/pricecheck`, `docker run --rm ${tag}`, `docker run --rm -e SITE=Remote ${tag}`],
      realityNote: 'Official images are deliberately minimal; installing exactly what the program needs, in the Dockerfile, is what makes the image reproducible. Running as a non-root user limits the damage if the program is compromised.',
    };
  }),
  tmpl(7, 2, 'intermediate', 'layer-cache', 'Order a Dockerfile for the layer cache', 'E4', 25, 'Restructure a Python service\'s Dockerfile so code changes reuse the dependency layer, and keep secrets and history out of the image.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const extra = v.pick(['requests==2.32.3', 'psycopg2-binary==2.9.9', 'redis==5.0.8']);
    const tag = `${o.org}/api:dev`;
    const dir = `${home(me)}/${o.project}`;
    const secret = `SECRET_KEY=${v.password()}`;
    const files = {
      [`${dir}/app.py`]: `from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef index():\n    return "${o.what}"\n`,
      [`${dir}/requirements.txt`]: `flask==3.0.3\ngunicorn==22.0.0\n${extra}\n`,
      [`${dir}/.env`]: `${secret}\nDEBUG=1\n`,
      [`${dir}/__pycache__/app.cpython-312.pyc`]: '(compiled bytecode)\n',
      [`${dir}/.git/HEAD`]: 'ref: refs/heads/main\n',
      [`${dir}/.git/config`]: '[core]\n\trepositoryformatversion = 0\n',
      [`${dir}/Dockerfile`]: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install -r requirements.txt\nCMD ["python3", "app.py"]\n',
    };
    const df = 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nCMD ["python3", "app.py"]\n';
    const probe = `rm -rf /tmp/cache-probe && cp -r ${dir} /tmp/cache-probe && cd /tmp/cache-probe && docker build -q -t cache-probe . >/dev/null 2>&1 && echo '# touched' >> app.py && docker build -t cache-probe . 2>&1 | grep -A1 'RUN pip' | grep -c CACHED`;
    return {
      instructions: lab({
        situation: `Every small change to **${o.project}** (in ~/${o.project}) makes \`docker build\` reinstall all the Python packages, and the image is bigger than it should be. Fix the build:\n\n- order the Dockerfile so that changing the code **reuses the cached pip install layer** (copy requirements.txt and install first, then copy the code);\n- install with **--no-cache-dir** so pip's download cache does not end up in the image;\n- add a **.dockerignore** so **.git**, **.env**, **__pycache__** and ***.pyc** are not sent to the build (and so never copied into the image).\n\nBuild it as **${tag}**, change app.py, build again and look for CACHED on the pip step.`,
        steps: ['cat Dockerfile', 'Reorder: COPY requirements.txt . / RUN pip install --no-cache-dir -r requirements.txt / COPY . .', 'Write .dockerignore', `docker build -t ${tag} .`, `echo '# change' >> app.py; docker build -t ${tag} .`, `docker run --rm ${tag} ls -a /app`, `docker images ${o.org}/api`],
        tips: ['A step is reused from the cache only if it and every step before it are unchanged; COPY . . changes whenever any file does.', '.dockerignore lines: .git  .env  __pycache__  *.pyc', 'docker history ' + tag],
      }),
      hints: ['Look at the build output: steps marked CACHED were reused.', 'Without .dockerignore, COPY . . copies your .env file (with its secret) into the image for anyone who pulls it.'],
      initialState: dockerDev({ me, docker: { pulled: ['python:3.12-slim'] }, files: owned(files, me.sam) }),
      checks: [
        out('Changing the code reuses the pip layer', probe, { equals: '1', message: 'After changing app.py, the RUN pip install step should be CACHED. Copy requirements.txt and install before COPY . .' }),
        out('Secrets and git history stay out of the image', `docker run --rm ${tag} ls -a /app | grep -cx -e .env -e .git -e __pycache__`, { equals: '0', message: `${tag} still contains .env, .git or __pycache__: add them to .dockerignore and rebuild.` }),
        dimg(`${tag} carries no pip download cache`, tag, { maxSizeMb: 150, hasFile: '/app/app.py' }),
        file('The Dockerfile installs without a cache', `${dir}/Dockerfile`, { contains: '--no-cache-dir' }),
      ],
      solution: [`cd ~/${o.project}`, write('Dockerfile', df), write('.dockerignore', '.git\n.env\n__pycache__\n*.pyc\n'), `docker build -t ${tag} .`, "echo '# change' >> app.py", `docker build -t ${tag} . 2>&1 | grep -A1 'RUN pip'`, `docker run --rm ${tag} ls -a /app`, `docker images ${o.org}/api`],
      realityNote: 'BuildKit caches each step by its instruction and inputs, so dependency manifests (requirements.txt, package-lock.json, go.sum) are copied and installed before the rest of the code in almost every production Dockerfile.',
    };
  }),
  tmpl(7, 2, 'advanced', 'volumes-and-networks', 'Connect containers on a network and keep data in a volume', 'E4', 35, 'Run a database and an API on a user-defined network, pass secrets with env files, and prove the data survives replacing the database container.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const pw = v.password();
    const port = v.pick([8080, 8090, 9000]);
    const note = v.pick(['First note', 'Hello from the field', 'Stock check done', 'Rain expected']);
    const net = `${o.org}-net`;
    const vol = `${o.org}-pgdata`;
    const db = `${o.org}-db`;
    const api = `${o.org}-api`;
    const apiImg = image(`${o.org}/notes-api:2.1`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: appScript({ name: `${o.org} notes`, waits: [['DB_HOST', 5432]], extra: 'PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U postgres -c "CREATE TABLE IF NOT EXISTS notes (id int, body text)" >/dev/null || { echo "cannot log in to the database"; exit 1; }\necho "connected to $DB_HOST"' }), mode: '755' } }, cmd: 'start.sh', expose: [8080], pkgs: ['psql'], env: { APP_VERSION: '2.1' } });
    const ref = `${apiImg.repo}:${apiImg.tag}`;
    const run = `docker run -d --name ${db} --network ${net} --network-alias db --env-file ~/${o.org}/db.env -v ${vol}:/var/lib/postgresql/data postgres:16`;
    return {
      instructions: lab({
        situation: `Set up **${o.org}**'s notes service on this machine:\n\n- a user-defined network **${net}**;\n- PostgreSQL (**postgres:16**) as container **${db}** on that network, reachable by the name **db**, with its data in the named volume **${vol}** (at /var/lib/postgresql/data). Its password is \`${pw}\`: put \`POSTGRES_PASSWORD=…\` in **~/${o.org}/db.env** (mode 600) and use **--env-file**, so the password is not on the command line;\n- the API (**${ref}**) as container **${api}** on the same network, publishing host port **${port}** to 8080. It reads **DB_HOST** and **DB_PASSWORD**: give them in **~/${o.org}/api.env** (mode 600);\n- add the note \`${note}\` (id 1) to the notes table the API creates;\n- then prove the data is safe: **remove ${db}** and start it again exactly as before. The note must still be there.`,
        steps: [`docker network create ${net}`, 'Write the two env files and chmod 600 them', run.replace('~', '$HOME'), `docker run -d --name ${api} --network ${net} --env-file ~/${o.org}/api.env -p ${port}:8080 ${ref}`, `docker logs ${api}`, `docker exec ${db} psql -U postgres -c "INSERT INTO notes VALUES (1, '…')"`, `docker rm -f ${db}; ${run}`, `docker exec ${db} psql -U postgres -c "SELECT * FROM notes"`],
        tips: ['On the default bridge network containers cannot find each other by name; on a user-defined network Docker\'s DNS answers for container names and --network-alias names.', 'docker volume ls; docker volume inspect ' + vol, `docker network inspect ${net}`],
      }),
      hints: ['If the API logs "waiting for db:5432", check that both containers are on the same network and that the database has the alias db.', 'A named volume lives outside the container, so docker rm removes the container but keeps the data.'],
      initialState: dockerDev({ me, docker: { pulled: ['postgres:16', 'alpine:3.20'], images: [apiImg] } }),
      checks: [
        out(`Both containers are on ${net}`, `docker network inspect ${net} -f '{{range .Containers}}{{.Name}} {{end}}'`, { contains: [db, api] }),
        out(`${db} keeps its data in the volume ${vol}`, `docker inspect ${db} -f '{{range .Mounts}}{{.Name}}:{{.Destination}}{{end}}'`, { equals: `${vol}:/var/lib/postgresql/data` }),
        file('The database env file is private', `${home(me)}/${o.org}/db.env`, { mode: '600', contains: `POSTGRES_PASSWORD=${pw}` }),
        file('The API env file is private', `${home(me)}/${o.org}/api.env`, { mode: '600', contains: ['DB_HOST=db', `DB_PASSWORD=${pw}`] }),
        out('The API connected to the database', `docker logs ${api}`, { contains: 'connected to db' }),
        out('The API answers on its port', `curl -s localhost:${port}/healthz`, { equals: 'ok' }),
        out('The note survived the database container being replaced', `docker exec ${db} psql -U postgres -tc "SELECT body FROM notes WHERE id = 1"`, { contains: note }),
      ],
      solution: [`docker network create ${net}`, `mkdir -p ~/${o.org}`, `printf 'POSTGRES_PASSWORD=%s\\n' '${pw}' > ~/${o.org}/db.env`, `printf 'DB_HOST=db\\nDB_PASSWORD=%s\\n' '${pw}' > ~/${o.org}/api.env`, `chmod 600 ~/${o.org}/db.env ~/${o.org}/api.env`, run, 'sleep 4', `docker run -d --name ${api} --network ${net} --env-file ~/${o.org}/api.env -p ${port}:8080 ${ref}`, `docker logs ${api}`, `docker exec ${db} psql -U postgres -c "INSERT INTO notes VALUES (1, '${note}')"`, `docker rm -f ${db}`, run, 'sleep 2', `docker exec ${db} psql -U postgres -c "SELECT * FROM notes"`],
      realityNote: 'This is how single-host deployments are wired: a user-defined bridge network for name resolution, named volumes for state, and env files (or Docker secrets) for credentials.',
    };
  }),

  /* ---------------------------------------------------------------- 7.3 multi-stage builds; registries and tagging */
  tmpl(7, 3, 'beginner', 'push-image', 'Tag and push an image to the team registry', 'E4', 25, 'Log in to the forge\'s container registry with a token, tag an image with its version and commit, and push it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const ver = `${v.int(1, 3)}.${v.int(0, 9)}.${v.int(0, 9)}`;
    const commits = [C('Initial site', me, o, { 'index.html': `<h1>${o.what}</h1>\n`, 'Dockerfile': 'FROM nginx:1.27-alpine\nCOPY index.html /usr/share/nginx/html/\n' }), C(`Release ${ver}`, me, o, { VERSION: `${ver}\n` }, 1)];
    const short = headOf(commits).slice(0, 7);
    const local = `${o.org}/${o.project}:${ver}`;
    const img = image(local, 'nginx:1.27-alpine', { files: { '/usr/share/nginx/html/index.html': `<h1>${o.what}</h1>\n` } });
    const remote = `${HOST}/${o.org}/${o.project}`;
    const full = `${o.org}/${o.project}`;
    return {
      instructions: lab({
        situation: `The image **${local}** is built on this machine from ~/${o.project} (cloned from **${full}** on ${HOST}). Publish it to the forge's container registry:\n\n- log in to **${HOST}** as **${me.sam}** with the personal access token in **~/registry-token** (it has the write:packages scope). Pass the token on **standard input**, not on the command line;\n- tag the image as **${remote}:${ver}** and also as **${remote}:sha-SHORT**, where SHORT is the short commit hash of HEAD in ~/${o.project} (\`git rev-parse --short HEAD\`);\n- push both tags.`,
        steps: [`docker login ${HOST} -u ${me.sam} --password-stdin < ~/registry-token`, `docker tag ${local} ${remote}:${ver}`, `docker tag ${local} ${remote}:sha-$(git -C ~/${o.project} rev-parse --short HEAD)`, `docker push ${remote}:${ver}`, `docker push ${remote}:sha-…`],
        tips: [`docker images ${remote}`, `docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${ver}`, 'A tag is just a name for an image ID; both tags point at the same digest.'],
      }),
      hints: ['A registry image name starts with the registry host: git.lab/OWNER/NAME:TAG.', 'docker login -p TOKEN leaves the token in your shell history; --password-stdin does not.'],
      initialState: withForge({ me, org: o, ...dockerBits(me, { pulled: ['nginx:1.27-alpine'], images: [img] }), files: { ...dockerStateFile({ pulled: ['nginx:1.27-alpine'], images: [img] }), [`${home(me)}/registry-token`]: { content: simToken(me.sam) + '\n', mode: '600', owner: me.sam, group: me.sam } }, seed: { users: { [me.sam]: fuser(me, o, { scopes: ['repo', 'workflow', 'read:org', 'write:packages'] }) }, repos: { [full]: { commits, clones: { [me.sam]: '' } } } } }),
      checks: [
        pkgCheck(`${remote} has the version and commit tags, for the same image`, full, { tags: [ver, `sha-${short}`], sameDigest: [ver, `sha-${short}`] }),
        file('Docker stored the registry login', `${home(me)}/.docker/config.json`, { contains: `"${HOST}"` }),
      ],
      solution: [`docker login ${HOST} -u ${me.sam} --password-stdin < ~/registry-token`, `docker tag ${local} ${remote}:${ver}`, `docker tag ${local} ${remote}:sha-$(git -C ~/${o.project} rev-parse --short HEAD)`, `docker push ${remote}:${ver}`, `docker push ${remote}:sha-$(git -C ~/${o.project} rev-parse --short HEAD)`, `docker images ${remote}`],
      realityNote: 'GitHub (ghcr.io), GitLab, Gitea and Forgejo all run registries like this; tagging with both a version and the commit lets anyone trace a running image back to its source.',
    };
  }),
  tmpl(7, 3, 'intermediate', 'multi-stage', 'Shrink an image with a multi-stage build', 'E4', 30, 'Build a static site with Node.js in a build stage and serve only the result from a small nginx image.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const ver = `1.${v.int(0, 9)}`;
    const tag = `${o.org}/site:${ver}`;
    const port = v.pick([8080, 8088, 8800]);
    const dir = `${home(me)}/site`;
    const items = v.some([...GOODS], 3);
    const towns = v.cities(3);
    const files = {
      [`${dir}/package.json`]: JSON.stringify({ name: `${o.org}-site`, version: `${ver}.0`, private: true, scripts: { build: 'sh build.sh' }, devDependencies: { 'html-minifier-terser': '^7.2.0' } }, null, 2) + '\n',
      [`${dir}/package-lock.json`]: JSON.stringify({ name: `${o.org}-site`, version: `${ver}.0`, lockfileVersion: 3, requires: true }, null, 2) + '\n',
      [`${dir}/build.sh`]: '#!/bin/sh\n# Turns each content/*.txt into dist/NAME.html.\nset -e\nrm -rf dist\nmkdir -p dist\nfor f in content/*.txt; do\n  name=$(basename "$f" .txt)\n  {\n    echo "<html><body><h1>$name</h1><ul>"\n    sed \'s|^\\(.*\\)$|<li>\\1</li>|\' "$f"\n    echo "</ul></body></html>"\n  } > "dist/$name.html"\ndone\necho "built $(ls dist | wc -l) pages"\n',
      [`${dir}/content/prices.txt`]: items.map(([n, p]) => `${n}: GHS ${p}`).join('\n') + '\n',
      [`${dir}/content/markets.txt`]: towns.join('\n') + '\n',
      [`${dir}/Dockerfile`]: 'FROM node:20\nWORKDIR /site\nCOPY . .\nRUN npm ci && npm run build\nEXPOSE 8080\nCMD ["python3", "-m", "http.server", "8080", "--directory", "dist"]\n',
    };
    const df = 'FROM node:20 AS build\nWORKDIR /site\nCOPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .\nRUN npm run build\n\nFROM nginx:1.27-alpine\nCOPY --from=build /site/dist/ /usr/share/nginx/html/\n';
    return {
      instructions: lab({
        situation: `**~/site** is ${o.org}'s price site: \`npm run build\` turns content/*.txt into HTML in dist/. Its Dockerfile builds and serves everything from **node:20**, so the image is over a gigabyte although it only serves a few HTML files.\n\nRewrite it as a **multi-stage build**: a **build** stage on node:20 that runs \`npm ci\` and \`npm run build\`, and a final stage on **nginx:1.27-alpine** that copies only **dist/** into /usr/share/nginx/html. Build it as **${tag}** (it must be **under 60 MB**) and run it as container **${o.org}-site** on host port **${port}**.`,
        steps: ['FROM node:20 AS build … RUN npm run build', 'FROM nginx:1.27-alpine', 'COPY --from=build /site/dist/ /usr/share/nginx/html/', `docker build -t ${tag} ~/site`, `docker images ${o.org}/site`, `docker run -d --name ${o.org}-site -p ${port}:80 ${tag}`, `curl -s localhost:${port}/prices.html`],
        tips: ['Only the last stage becomes the image; earlier stages are thrown away after the build.', 'docker history shows which layers made an image big.'],
      }),
      hints: ['The final image does not need Node.js, npm or node_modules: only the built files.', 'COPY --from=STAGE copies files out of an earlier stage.'],
      initialState: dockerDev({ me, docker: { pulled: ['node:20', 'nginx:1.27-alpine'] }, files: owned(files, me.sam) }),
      checks: [
        dimg(`${tag} is small and served by nginx`, tag, { maxSizeMb: 60, base: '^nginx:1\\.27-alpine$', hasFile: '/usr/share/nginx/html/prices.html' }),
        dock(`${o.org}-site serves it on ${port}`, `${o.org}-site`, { running: true, ports: [`${port}:80`], image: tag }),
        out('The built prices page is served', `curl -s localhost:${port}/prices.html`, { contains: [`<li>${items[0][0]}: GHS ${items[0][1]}</li>`] }),
        out('The markets page is served', `curl -s localhost:${port}/markets.html`, { contains: towns[0] }),
        file('The Dockerfile has a build stage', `${dir}/Dockerfile`, { contains: [' AS ', '--from='] }),
      ],
      solution: [write('~/site/Dockerfile', df), `docker build -t ${tag} ~/site`, `docker images ${o.org}/site`, `docker run -d --name ${o.org}-site -p ${port}:80 ${tag}`, `curl -s localhost:${port}/prices.html`],
      realityNote: 'Multi-stage builds are the standard way to keep compilers, package managers and source out of production images: smaller downloads, faster deploys and less for an attacker to use.',
    };
  }),
  tmpl(7, 3, 'advanced', 'pin-by-digest', 'Pin a deployment to an image digest', 'E4', 30, 'After a moving "latest" tag broke a deployment, find the digest of the known-good release and pin the Compose file to it.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8081, 8090]);
    const good = '1.4.2';
    const mk = (ver: string, ok: boolean) => image(`${o.org}/api:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: ok ? appScript({ name: `${o.org} api` }) : '#!/bin/sh\necho "api 1.5.0-rc1 starting"\necho "fatal: /etc/api/config.yaml not found"\nexit 1\n', mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, expose: [8080] });
    const pkg = registryPackage(o.org, 'api', { '1.4.1': mk('1.4.1', true), [good]: mk(good, true), latest: mk('1.5.0-rc1', false) }, 'private', `${o.org}/${o.project}`);
    const digest = pkg.tags[good];
    const remote = `${HOST}/${o.org}/api`;
    const compose = `services:\n  api:\n    image: ${remote}:latest\n    ports:\n      - "${port}:8080"\n    restart: unless-stopped\n`;
    const full = `${o.org}/${o.project}`;
    const auth = btoa(`${me.sam}:${simToken(me.sam)}`);
    return {
      instructions: lab({
        situation: `~/deploy/compose.yaml runs **${o.org}**'s API from **${remote}:latest**. Someone pushed a release candidate as \`latest\`, and every server that pulled since then is broken. **${good}** is the release that is known to work.\n\nPin the deployment so this cannot happen again: change the image to **${remote}@sha256:…**, the **digest** of ${good} (not the tag, which could be moved too), and redeploy with \`docker compose up -d\`. The API must report version ${good} at http://localhost:${port}/version. You are already logged in to ${HOST}.`,
        steps: [`cd ~/deploy; docker compose up -d; docker compose ps -a; docker compose logs`, `docker pull ${remote}:${good}`, `docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${good}`, 'Edit compose.yaml: image: ' + remote + '@sha256:…', 'docker compose up -d', `curl -s localhost:${port}/version`],
        tips: ['docker pull prints the digest ("Digest: sha256:…") of what it pulled.', 'A digest names the exact image content: it cannot be moved to other content the way a tag can.'],
      }),
      hints: ['First see the failure: docker compose up -d, then docker compose logs api.', 'In compose.yaml the image line becomes NAME@sha256:DIGEST (no tag).'],
      initialState: withForge({ me, org: o, ...dockerBits(me, { pulled: ['alpine:3.20'] }), files: { ...dockerStateFile({ pulled: ['alpine:3.20'] }), ...owned({ [`${home(me)}/deploy/compose.yaml`]: compose, [`${home(me)}/.docker/config.json`]: JSON.stringify({ auths: { [HOST]: { auth } } }, null, '\t') + '\n' }, me.sam) }, seed: { users: { [me.sam]: fuser(me, o, { scopes: ['repo', 'read:org', 'read:packages'] }) }, repos: { [full]: { commits: [C('Initial', me, o, { 'README.md': `# ${o.project}\n` })] } }, packages: { [`${o.org}/api`]: pkg } } }),
      checks: [
        file('compose.yaml pins the digest of ' + good, `${home(me)}/deploy/compose.yaml`, { contains: `${remote}@${digest}`, notContains: ':latest' }),
        out(`The API reports ${good}`, `curl -s localhost:${port}/version`, { equals: good }),
        out('The running container uses the pinned digest', "docker inspect -f '{{.Config.Image}}' deploy-api-1", { contains: digest }),
      ],
      solution: ['cd ~/deploy && docker compose up -d', 'cd ~/deploy && docker compose logs api', `docker pull ${remote}:${good}`, `d=$(docker image inspect -f '{{index .RepoDigests 0}}' ${remote}:${good}); sed -i "s|image: .*|image: $d|" ~/deploy/compose.yaml`, 'cat ~/deploy/compose.yaml', 'cd ~/deploy && docker compose up -d', `curl -s localhost:${port}/version`],
      realityNote: 'Pinning by digest is standard for production deployments (Kubernetes manifests and Compose files alike); tools such as Renovate update the pinned digests through reviewed pull requests.',
    };
  }),

  /* ---------------------------------------------------------------- 7.4 Compose: app, database, cache */
  tmpl(7, 4, 'beginner', 'compose-stack', 'Describe an app, database and cache in Compose', 'E4', 30, 'Write a compose file with a built web app, PostgreSQL and Redis, using a .env file for the password.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8000, 8888]);
    const pw = v.password();
    const proj = o.project;
    const dir = `${home(me)}/${proj}`;
    const files = {
      [`${dir}/app/Dockerfile`]: 'FROM alpine:3.20\nCOPY start.sh /usr/local/bin/start.sh\nEXPOSE 8080\nCMD ["start.sh"]\n',
      [`${dir}/app/start.sh`]: { content: appScript({ name: o.what, waits: [['DB_HOST', 5432], ['CACHE_HOST', 6379]] }), mode: '755' },
      [`${dir}/.env`]: `DB_PASSWORD=${pw}\n`,
      [`${dir}/.gitignore`]: '.env\n',
    };
    const compose = `services:\n  app:\n    build: ./app\n    ports:\n      - "${port}:8080"\n    environment:\n      DB_HOST: db\n      CACHE_HOST: cache\n    depends_on:\n      - db\n      - cache\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n  cache:\n    image: redis:7-alpine\nvolumes:\n  dbdata:\n`;
    return {
      instructions: lab({
        situation: `Describe **${proj}** (in ~/${proj}) as a Compose project in **compose.yaml**:\n\n- **app**: built from **./app**, publishing host port **${port}** to 8080, with **DB_HOST=db** and **CACHE_HOST=cache**, starting after db and cache;\n- **db**: **postgres:16** with its data in a named volume **dbdata** (at /var/lib/postgresql/data). Its password comes from **.env**: write \`POSTGRES_PASSWORD: \${DB_PASSWORD}\`, never the password itself;\n- **cache**: **redis:7-alpine**.\n\nStart it with \`docker compose up -d\` and open the app's page: it shows whether it reached the database and the cache.`,
        steps: ['Write compose.yaml with services app, db, cache and a top-level volumes: section', `cd ~/${proj}; docker compose config`, 'docker compose up -d', 'docker compose ps', `curl -s localhost:${port}`],
        tips: ['docker compose config shows the file with ${DB_PASSWORD} filled in from .env: a quick way to check it.', 'Services reach each other by service name: db, cache.'],
      }),
      hints: ['Indentation matters in YAML: two spaces per level, no tabs.', '.env is listed in .gitignore, so the password is never committed; compose.yaml can be.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20', 'postgres:16', 'redis:7-alpine'] }, files: owned(files, me.sam) }),
      checks: [
        out('All three services run', `cd ${dir} && docker compose ps`, { contains: [`${proj}-app-1`, `${proj}-db-1`, `${proj}-cache-1`, `0.0.0.0:${port}->8080/tcp`] }),
        out('The app reached the database and the cache', `curl -s localhost:${port}`, { contains: ['<p>db: ok</p>', '<p>cache: ok</p>'] }),
        dock('The database keeps its data in the volume', `${proj}-db-1`, { mountTarget: '/var/lib/postgresql/data', env: [`POSTGRES_PASSWORD=${pw}`] }),
        file('compose.yaml takes the password from .env', `${dir}/compose.yaml`, { contains: ['${DB_PASSWORD}', 'dbdata'], notContains: pw }),
      ],
      solution: [`cd ~/${proj}`, write('compose.yaml', compose), 'docker compose config', 'docker compose up -d', 'sleep 5', 'docker compose ps', `curl -s localhost:${port}`],
      realityNote: 'A compose file is the usual way to run a multi-container application on one machine, in development and on small servers alike; it lives in version control next to the code, while .env stays out of it.',
    };
  }),
  tmpl(7, 4, 'intermediate', 'compose-health', 'Start services in the right order with health checks', 'E4', 30, 'Fix a stack whose app starts before its database is ready, using health checks and depends_on conditions.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const port = v.pick([8080, 8000, 8888]);
    const pw = v.password();
    const proj = o.project;
    const dir = `${home(me)}/${proj}`;
    const start = `#!/bin/sh\n# Connects once at start; if the database is not ready, it gives up.\nnc -z "$DB_HOST" 5432 || { echo "database $DB_HOST:5432 refused the connection"; exit 1; }\necho "connected to $DB_HOST"\nmkdir -p /srv/www\necho "<h1>${o.what}</h1>" > /srv/www/index.html\necho ok > /srv/www/healthz\nexec httpd -f -p 8080 -h /srv/www\n`;
    const before = `services:\n  app:\n    build: ./app\n    ports:\n      - "${port}:8080"\n    environment:\n      DB_HOST: db\n    depends_on:\n      - db\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n`;
    const after = `services:\n  app:\n    build: ./app\n    ports:\n      - "${port}:8080"\n    environment:\n      DB_HOST: db\n    depends_on:\n      db:\n        condition: service_healthy\n    restart: unless-stopped\n    healthcheck:\n      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]\n      interval: 5s\n      retries: 3\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      retries: 10\n`;
    const files = {
      [`${dir}/app/Dockerfile`]: 'FROM alpine:3.20\nCOPY start.sh /usr/local/bin/start.sh\nCMD ["start.sh"]\n',
      [`${dir}/app/start.sh`]: { content: start, mode: '755' },
      [`${dir}/.env`]: `DB_PASSWORD=${pw}\n`,
      [`${dir}/compose.yaml`]: before,
    };
    return {
      instructions: lab({
        situation: `In ~/${proj}, \`docker compose up -d\` starts the database and the app together, but the app usually exits straight away: PostgreSQL needs a few seconds before it accepts connections, and \`depends_on\` only waits for the container to **start**, not to be **ready**.\n\nFix compose.yaml:\n\n- give **db** a health check that runs \`pg_isready -U postgres\` every 2 seconds;\n- make **app** wait until db is **healthy** (\`condition: service_healthy\`);\n- give **app** its own health check that fetches http://localhost:8080/healthz (busybox \`wget -qO-\` is in the image), and restart policy **unless-stopped**.\n\nThen \`docker compose up -d\` must bring the stack up reliably, every time.`,
        steps: [`cd ~/${proj}; docker compose up -d; docker compose ps -a; docker compose logs app`, 'Add healthcheck: to db and app; change depends_on to the long form with condition', 'docker compose down; docker compose up -d', 'docker compose ps'],
        tips: ['healthcheck:\n  test: ["CMD-SHELL", "pg_isready -U postgres"]\n  interval: 2s\n  retries: 10', 'depends_on:\n  db:\n    condition: service_healthy', "docker inspect -f '{{.State.Health.Status}}' " + `${proj}-db-1`],
      }),
      hints: ['Look at the app logs first: the error says what it could not reach.', 'docker compose ps shows (healthy) next to services whose health check passes.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20', 'postgres:16'] }, files: owned(files, me.sam) }),
      checks: [
        out('A fresh docker compose up brings the app up', `cd ${dir} && docker compose down >/dev/null 2>&1; docker compose up -d >/dev/null 2>&1; docker inspect -f '{{.State.Status}}' ${proj}-app-1`, { equals: 'running', message: 'After docker compose down and up -d the app is not running: it still starts before the database is ready.' }),
        out('The database reports healthy', `docker inspect -f '{{.State.Health.Status}}' ${proj}-db-1`, { equals: 'healthy' }),
        out('The app has a health check on /healthz', `docker inspect -f '{{json .Config.Healthcheck.Test}}' ${proj}-app-1`, { contains: 'healthz' }),
        out('The app restarts unless stopped', `docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${proj}-app-1`, { equals: 'unless-stopped' }),
        file('compose.yaml waits for a healthy database', `${dir}/compose.yaml`, { contains: ['service_healthy', 'pg_isready'] }),
      ],
      solution: [`cd ~/${proj} && docker compose up -d`, 'docker compose logs app', write('compose.yaml', after), 'docker compose down', 'docker compose up -d', 'docker compose ps'],
      realityNote: 'Health checks with depends_on conditions are how Compose expresses "ready, not just started"; in Kubernetes the same job is done by readiness probes and by applications that retry their connections.',
    };
  }),
  tmpl(7, 4, 'advanced', 'compose-production', 'Write a production override with secrets and limits', 'E4', 35, 'Keep one base compose file, and add a production file that pins the image, adds restart and memory limits, and passes the database password as a secret file.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const ver = `2.${v.int(0, 9)}.${v.int(0, 9)}`;
    const pw = v.password();
    const mem = v.pick([256, 384, 512]);
    const proj = o.project;
    const dir = `${home(me)}/${proj}`;
    const remote = `${HOST}/${o.org}/${proj}`;
    const start = `#!/bin/sh\nif [ -n "$DB_PASSWORD_FILE" ]; then DB_PASSWORD=$(cat "$DB_PASSWORD_FILE"); fi\n: "\${DB_PASSWORD:?no database password: set DB_PASSWORD or DB_PASSWORD_FILE}"\nfor i in 1 2 3 4 5 6 7 8 9 10; do nc -z "$DB_HOST" 5432 && break; sleep 1; done\nPGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U postgres -c "SELECT 1" >/dev/null || { echo "cannot log in to $DB_HOST"; exit 1; }\necho "connected to $DB_HOST"\nmkdir -p /srv/www\necho "<h1>${o.what} \${APP_VERSION}</h1>" > /srv/www/index.html\necho ok > /srv/www/healthz\nexec httpd -f -p 8080 -h /srv/www\n`;
    const appImg = image(`${o.org}/${proj}:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: start, mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, pkgs: ['psql'], expose: [8080] });
    const pkg = registryPackage(o.org, proj, { [ver]: appImg }, 'private', `${o.org}/${proj}`);
    const base = `services:\n  app:\n    image: ${remote}:\${TAG:-dev}\n    environment:\n      DB_HOST: db\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:16\n    volumes:\n      - dbdata:/var/lib/postgresql/data\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      retries: 10\nvolumes:\n  dbdata:\n`;
    const override = `# Development: build locally, mount the source, debug on, a throwaway password.\nservices:\n  app:\n    build: ./app\n    ports:\n      - "8080:8080"\n    environment:\n      DEBUG: "1"\n      DB_PASSWORD: devpassword\n    volumes:\n      - ./app/src:/srv/src\n  db:\n    environment:\n      POSTGRES_PASSWORD: devpassword\n`;
    const prod = `services:\n  app:\n    image: ${remote}:${ver}\n    restart: always\n    ports:\n      - "80:8080"\n    environment:\n      DB_PASSWORD_FILE: /run/secrets/db_password\n    secrets:\n      - db_password\n    deploy:\n      resources:\n        limits:\n          memory: ${mem}M\n  db:\n    restart: always\n    environment:\n      POSTGRES_PASSWORD_FILE: /run/secrets/db_password\n    secrets:\n      - db_password\nsecrets:\n  db_password:\n    file: ./secrets/db_password.txt\n`;
    const full = `${o.org}/${proj}`;
    const auth = btoa(`${me.sam}:${simToken(me.sam)}`);
    const files = owned({ [`${dir}/compose.yaml`]: base, [`${dir}/compose.override.yaml`]: override, [`${dir}/app/Dockerfile`]: 'FROM alpine:3.20\nCOPY start.sh /usr/local/bin/\nCMD ["start.sh"]\n', [`${dir}/app/start.sh`]: { content: start, mode: '755' }, [`${dir}/app/src/README`]: 'source\n', [`${dir}/.gitignore`]: 'secrets/\n', [`${home(me)}/.docker/config.json`]: JSON.stringify({ auths: { [HOST]: { auth } } }, null, '\t') + '\n' }, me.sam);
    const cfg = `cd ${dir} && docker compose -f compose.yaml -f compose.prod.yaml config`;
    return {
      instructions: lab({
        situation: `~/${proj} has **compose.yaml** (shared) and **compose.override.yaml** (development: local build, mounted source, DEBUG, a throwaway password). \`docker compose up\` reads both automatically. Write **compose.prod.yaml** for the production server, used as \`docker compose -f compose.yaml -f compose.prod.yaml …\` (which does **not** read the override):\n\n- app: the released image **${remote}:${ver}**, restart **always**, host port **80** to 8080, a memory limit of **${mem} MB** (deploy.resources.limits.memory);\n- db: restart **always**;\n- the database password \`${pw}\` must not appear in any compose file or environment variable: put it in **secrets/db_password.txt** (mode 600, git-ignored) and give it to both services as a Compose **secret** \`db_password\`. postgres reads **POSTGRES_PASSWORD_FILE**; the app reads **DB_PASSWORD_FILE**; secrets appear under /run/secrets/.\n\nCheck the merged result with \`config\`, then start production. You are logged in to ${HOST}.`,
        steps: ['mkdir -p secrets; printf %s PASSWORD > secrets/db_password.txt; chmod 600 secrets/db_password.txt', 'Write compose.prod.yaml', 'docker compose -f compose.yaml -f compose.prod.yaml config', 'docker compose -f compose.yaml -f compose.prod.yaml up -d', 'docker compose -f compose.yaml -f compose.prod.yaml ps', 'curl -s localhost/healthz'],
        tips: ['secrets:\n  db_password:\n    file: ./secrets/db_password.txt', 'Each service lists the secrets it may read: secrets: [db_password]', `docker inspect -f '{{.HostConfig.Memory}}' ${proj}-app-1`],
      }),
      hints: ['Files given with -f are merged in order: later files add to or override earlier ones.', 'If config still shows DEBUG or devpassword, the override file is being read: name the files explicitly with -f.'],
      initialState: withForge({ me, org: o, ...dockerBits(me, { pulled: ['alpine:3.20', 'postgres:16'] }), files: { ...dockerStateFile({ pulled: ['alpine:3.20', 'postgres:16'] }), ...files }, seed: { users: { [me.sam]: fuser(me, o, { scopes: ['repo', 'read:org', 'read:packages'] }) }, repos: { [full]: { commits: [C('Initial', me, o, { 'README.md': `# ${proj}\n` })] } }, packages: { [full]: pkg } } }),
      checks: [
        out('The production configuration is pinned and restarts', cfg, { contains: [`${remote}:${ver}`, 'restart: always', 'POSTGRES_PASSWORD_FILE', 'db_password'], notContains: ['DEBUG', 'devpassword', pw] }),
        out(`The app has a ${mem} MB memory limit`, `docker inspect -f '{{.HostConfig.Memory}}' ${proj}-app-1`, { equals: String(mem * 1024 * 1024) }),
        out('The app logged in to the database with the secret', `docker logs ${proj}-app-1`, { contains: 'connected to db' }),
        out('Production answers on port 80', 'curl -s localhost/healthz', { equals: 'ok' }),
        file('The secret file is private', `${dir}/secrets/db_password.txt`, { mode: '600', contains: pw }),
        file('compose.prod.yaml holds no password', `${dir}/compose.prod.yaml`, { notContains: pw, contains: 'secrets:' }),
      ],
      solution: [`cd ~/${proj}`, 'mkdir -p secrets', `printf '%s' '${pw}' > secrets/db_password.txt`, 'chmod 600 secrets/db_password.txt', write('compose.prod.yaml', prod), 'docker compose -f compose.yaml -f compose.prod.yaml config', 'docker compose -f compose.yaml -f compose.prod.yaml up -d', 'docker compose -f compose.yaml -f compose.prod.yaml ps', 'curl -s localhost/healthz'],
      realityNote: 'Base, development and production files are the layout Docker\'s own documentation recommends; secret files mounted under /run/secrets keep credentials out of docker inspect and process listings, which environment variables do not.',
    };
  }),

  /* ---------------------------------------------------------------- 7.5 Kubernetes: a first look */
  tmpl(7, 5, 'beginner', 'k8s-first-deploy', 'Deploy an app to Kubernetes', 'E4', 30, 'Write a Deployment and a Service, apply them, check that the pods are ready and reach the app through the Service.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const ver = `1.${v.int(0, 9)}.${v.int(0, 9)}`;
    const n = v.int(2, 4);
    const name = o.project;
    const remote = `${HOST}/${o.org}/web`;
    const webImg = image(`${o.org}/web:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: appScript({ name: `${o.what} ${ver}` }), mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, expose: [8080] });
    const pkg = registryPackage(o.org, 'web', { [ver]: webImg }, 'public');
    const yaml = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  labels:\n    app: ${name}\nspec:\n  replicas: ${n}\n  selector:\n    matchLabels:\n      app: ${name}\n  template:\n    metadata:\n      labels:\n        app: ${name}\n    spec:\n      containers:\n      - name: web\n        image: ${remote}:${ver}\n        ports:\n        - containerPort: 8080\n        readinessProbe:\n          httpGet:\n            path: /healthz\n            port: 8080\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector:\n    app: ${name}\n  ports:\n  - port: 80\n    targetPort: 8080\n`;
    const kube = (c: string) => kc(me, c);
    return {
      instructions: lab({
        situation: `kubectl on this machine talks to a small cluster. Deploy **${remote}:${ver}** (a public image; the app listens on **8080** and answers **/healthz** when ready):\n\n- write **~/k8s/${name}.yaml** with a **Deployment** \`${name}\` running **${n} replicas** (label app=${name}), a container named **web** with containerPort 8080 and a **readiness probe** on /healthz;\n- in the same file (after \`---\`), a **Service** \`${name}\` that selects those pods and maps **port 80 to 8080**;\n- apply it, wait for the rollout, check the Service's endpoints, and reach the app with \`kubectl port-forward svc/${name} 8080:80\` and curl.`,
        steps: [`mkdir -p ~/k8s; write ~/k8s/${name}.yaml`, `kubectl apply -f ~/k8s/${name}.yaml`, `kubectl rollout status deployment/${name}`, 'kubectl get pods -o wide', `kubectl get endpoints ${name}`, `kubectl port-forward svc/${name} 8080:80`, 'curl -s localhost:8080'],
        tips: ['kubectl explain is not needed: start from kubectl create deployment NAME --image=IMAGE --dry-run=client -o yaml', 'The Deployment\'s selector.matchLabels must match the pod template\'s labels.', `kubectl describe svc ${name}`],
      }),
      hints: ['A Service finds pods by labels, and only sends traffic to pods whose readiness probe passes.', 'If a pod is not READY, kubectl describe pod NAME shows the probe failures at the bottom.'],
      initialState: withForge({ me, org: o, packages: ['kubectl'], files: clusterFiles(me.sam), seed: { users: { [me.sam]: fuser(me, o) }, repos: { [`${o.org}/web`]: { commits: [C('Initial', me, o, { 'README.md': '# web\n' })] } }, packages: { [`${o.org}/web`]: pkg } } }),
      checks: [
        out(`${n} replicas are ready`, kube(`get deployment ${name} -o jsonpath='{.status.readyReplicas}'`), { equals: String(n) }),
        out('The pods have a readiness probe on /healthz', kube(`get deployment ${name} -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}'`), { equals: '/healthz' }),
        out('The Service maps port 80 to 8080', kube(`get service ${name} -o jsonpath='{.spec.ports[0].port} {.spec.ports[0].targetPort}'`), { equals: '80 8080' }),
        out('The Service has the pods as endpoints', kube(`get endpoints ${name}`), { contains: ':8080' }),
        out('The app answers through the Service', `export KUBECONFIG=/home/${me.sam}/.kube/config; kubectl port-forward svc/${name} 18080:80 >/dev/null; curl -s localhost:18080/`, { contains: `${o.what} ${ver}` }),
      ],
      solution: ['mkdir -p ~/k8s', write(`~/k8s/${name}.yaml`, yaml), `kubectl apply -f ~/k8s/${name}.yaml`, `kubectl rollout status deployment/${name}`, 'kubectl get pods -o wide', `kubectl get endpoints ${name}`, `kubectl port-forward svc/${name} 8080:80`, 'curl -s localhost:8080'],
      realityNote: 'These are standard apps/v1 Deployment and v1 Service manifests: they apply unchanged to kind, k3s, minikube or a managed cluster.',
    };
  }),
  tmpl(7, 5, 'intermediate', 'k8s-rollout', 'Roll out a new version and roll back a bad one', 'E4', 30, 'Update a Deployment\'s image, notice a stalled rollout, diagnose it, roll back, and deploy the right version with a recorded change cause.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const name = o.project;
    const remote = `${HOST}/${o.org}/web`;
    const mk = (ver: string) => image(`${o.org}/web:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: appScript({ name: `${o.what} ${ver}` }), mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: ver }, expose: [8080] });
    const minor = v.int(1, 4);
    const pkg = registryPackage(o.org, 'web', { '1.0.0': mk('1.0.0'), [`1.${minor}.0`]: mk(`1.${minor}.0`) }, 'public');
    const manifests = `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\n  annotations:\n    kubernetes.io/change-cause: initial release 1.0.0\nspec:\n  replicas: 3\n  selector:\n    matchLabels:\n      app: ${name}\n  template:\n    metadata:\n      labels:\n        app: ${name}\n    spec:\n      containers:\n      - name: web\n        image: ${remote}:1.0.0\n        ports:\n        - containerPort: 8080\n        readinessProbe:\n          httpGet:\n            path: /healthz\n            port: 8080\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector:\n    app: ${name}\n  ports:\n  - port: 80\n    targetPort: 8080\n`;
    const kube = (c: string) => kc(me, c);
    return {
      instructions: lab({
        situation: `**${name}** runs ${remote}:1.0.0 with 3 replicas. The release ticket says: *"deploy version 1.${minor}"*.\n\n1. Update the Deployment's **web** container to **${remote}:1.${minor}** (as the ticket says) and record the change cause \`update to 1.${minor}\`.\n2. Watch the rollout. It will not finish: find out **why** from the cluster (pods, describe, events), and notice that the old pods keep serving meanwhile.\n3. **Roll back** to the previous revision.\n4. Deploy the version that really exists in the registry, **1.${minor}.0**, with the change cause \`update to 1.${minor}.0\`, and make sure the rollout completes.`,
        steps: [`kubectl set image deployment/${name} web=${remote}:1.${minor}`, `kubectl annotate deployment/${name} kubernetes.io/change-cause="update to 1.${minor}" --overwrite`, `kubectl rollout status deployment/${name} --timeout=60s`, 'kubectl get pods; kubectl describe pod …', `kubectl rollout undo deployment/${name}`, `kubectl set image … 1.${minor}.0; kubectl annotate …`, `kubectl rollout history deployment/${name}`],
        tips: ['ImagePullBackOff means the node could not pull the image: often a wrong tag or missing credentials.', 'With the default rolling update, new pods must become ready before old ones are removed.', `kubectl rollout history deployment/${name}`],
      }),
      hints: ['kubectl describe pod shows the exact pull error in its Events.', 'kubectl rollout undo returns to the previous revision\'s pod template.'],
      initialState: withForge({ me, org: o, packages: ['kubectl'], files: clusterFiles(me.sam, { manifests }), seed: { users: { [me.sam]: fuser(me, o) }, repos: { [`${o.org}/web`]: { commits: [C('Initial', me, o, { 'README.md': '# web\n' })] } }, packages: { [`${o.org}/web`]: pkg } } }),
      checks: [
        out(`The Deployment runs 1.${minor}.0`, kube(`get deployment ${name} -o jsonpath='{.spec.template.spec.containers[0].image}'`), { equals: `${remote}:1.${minor}.0` }),
        out('All 3 replicas are ready and up to date', kube(`get deployment ${name} -o jsonpath='{.status.readyReplicas} {.status.updatedReplicas} {.status.replicas}'`), { equals: '3 3 3' }),
        out('No pod is stuck pulling an image', kube('get pods'), { notContains: ['ImagePullBackOff', 'ErrImagePull'] }),
        out('The history records the failed attempt, the rollback and the fix', kube(`rollout history deployment/${name}`), { contains: [`update to 1.${minor}.0`], pattern: '\\n[3-9] ' }),
      ],
      solution: [`kubectl set image deployment/${name} web=${remote}:1.${minor}`, `kubectl annotate deployment/${name} kubernetes.io/change-cause="update to 1.${minor}" --overwrite`, `kubectl rollout status deployment/${name} --timeout=60s`, 'kubectl get pods', `kubectl describe pod $(kubectl get pods -o name | tail -1 | cut -d/ -f2) | tail -6`, `kubectl rollout undo deployment/${name}`, `kubectl rollout status deployment/${name}`, `kubectl set image deployment/${name} web=${remote}:1.${minor}.0`, `kubectl annotate deployment/${name} kubernetes.io/change-cause="update to 1.${minor}.0" --overwrite`, `kubectl rollout status deployment/${name}`, `kubectl rollout history deployment/${name}`],
      realityNote: 'Rolling updates with readiness probes are why a bad image tag in Kubernetes usually causes a stalled rollout rather than an outage; kubectl rollout undo is the first move when a release misbehaves.',
    };
  }),
  tmpl(7, 5, 'advanced', 'k8s-crashloop', 'Fix pods that will not start', 'E4', 40, 'Diagnose a Deployment with a missing ConfigMap, a password in plain text, a wrong probe port and a memory limit that is too small, and fix them properly.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const region = v.city();
    const pw = v.password();
    const need = v.pick([48, 64, 80]);
    const remote = `${HOST}/${o.org}/api`;
    const start = '#!/bin/sh\n: "${DB_PASSWORD:?DB_PASSWORD is not set}"\necho "api ${APP_VERSION} starting in ${REGION:-unknown}"\nmkdir -p /srv/www\necho "<h1>api ${APP_VERSION} (${REGION})</h1>" > /srv/www/index.html\necho ok > /srv/www/healthz\nexec httpd -f -p 8080 -h /srv/www\n';
    const apiImg = image(`${o.org}/api:2.0.0`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: start, mode: '755' } }, cmd: 'start.sh', env: { APP_VERSION: '2.0.0' }, expose: [8080], memMb: need });
    const pkg = registryPackage(o.org, 'api', { '2.0.0': apiImg }, 'public');
    const deploy = (fixed: boolean) => `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: api\n  template:\n    metadata:\n      labels:\n        app: api\n    spec:\n      containers:\n      - name: api\n        image: ${remote}:2.0.0\n        ports:\n        - containerPort: 8080\n        env:\n        - name: REGION\n          valueFrom:\n            configMapKeyRef:\n              name: api-config\n              key: region\n        - name: DB_PASSWORD\n${fixed ? '          valueFrom:\n            secretKeyRef:\n              name: api-db\n              key: password\n' : `          value: "${pw}"\n`}        readinessProbe:\n          httpGet:\n            path: /healthz\n            port: ${fixed ? 8080 : 8000}\n        resources:\n          limits:\n            memory: ${fixed ? '128Mi' : '16Mi'}\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: api\nspec:\n  selector:\n    app: api\n  ports:\n  - port: 80\n    targetPort: 8080\n`;
    const kube = (c: string) => kc(me, c);
    const ticket = `# api 2.0.0 will not start\n\nSettings it needs:\n\n- REGION: ${region} (keep it in the ConfigMap **api-config**, key **region**)\n- DB_PASSWORD: ${pw} (keep it in the Secret **api-db**, key **password**; it must not stay in the manifest)\n\nIt needs about ${need} MiB of memory.\n`;
    return {
      instructions: lab({
        situation: `The **api** Deployment (manifest: **~/k8s/api.yaml**) was applied but its pods never become ready. ~/k8s/TICKET.md lists the settings it needs. Find every problem from the cluster itself (\`get\`, \`describe\`, \`logs\`, events) and fix them properly:\n\n- create the missing ConfigMap and Secret the ticket describes;\n- change the manifest so DB_PASSWORD comes from the **Secret** (secretKeyRef), not a plain value;\n- fix whatever else stops the pods from running and becoming ready (look at restarts, last state and probe events);\n- apply the manifest; both replicas must be ready behind the **api** Service.`,
        steps: ['kubectl get pods; kubectl describe pod …; kubectl get events', `kubectl create configmap api-config --from-literal=region=${region}`, 'kubectl create secret generic api-db --from-literal=password=…', 'Edit ~/k8s/api.yaml; kubectl apply -f ~/k8s/api.yaml', 'kubectl rollout status deployment/api', 'kubectl get endpoints api'],
        tips: ['CreateContainerConfigError: a ConfigMap or Secret the pod refers to is missing.', 'OOMKilled in "Last State": the container went over its memory limit.', 'Readiness probe failures show up as Unhealthy events.'],
      }),
      hints: ['Fix one error at a time: each fix lets the pod get further and show the next problem.', 'The probe must check the port the app listens on (the containerPort).'],
      initialState: withForge({ me, org: o, packages: ['kubectl'], files: { ...clusterFiles(me.sam, { manifests: deploy(false) }), ...owned({ [`${home(me)}/k8s/api.yaml`]: deploy(false), [`${home(me)}/k8s/TICKET.md`]: ticket }, me.sam) }, seed: { users: { [me.sam]: fuser(me, o) }, repos: { [`${o.org}/api`]: { commits: [C('Initial', me, o, { 'README.md': '# api\n' })] } }, packages: { [`${o.org}/api`]: pkg } } }),
      checks: [
        out('Both replicas are ready', kube("get deployment api -o jsonpath='{.status.readyReplicas}'"), { equals: '2' }),
        out('The api Service has both pods as endpoints', kube("get endpoints api -o jsonpath='{range .subsets[*].addresses[*]}{.ip}{\"\\n\"}{end}'") + ' | wc -l', { equals: '2' }),
        out('The pods run in the right region', kube('logs deployment/api'), { contains: `starting in ${region}` }),
        out('The password is in the api-db Secret', kube("get secret api-db -o jsonpath='{.data.password}'") + ' | base64 -d', { equals: pw }),
        file('The manifest takes the password from the Secret', `${home(me)}/k8s/api.yaml`, { contains: 'secretKeyRef', notContains: pw }),
      ],
      solution: ['kubectl get pods', 'kubectl describe pod $(kubectl get pods -o name | head -1 | cut -d/ -f2) | tail -5', `kubectl create configmap api-config --from-literal=region='${region}'`, `kubectl create secret generic api-db --from-literal=password='${pw}'`, write('~/k8s/api.yaml', deploy(true)), 'kubectl apply -f ~/k8s/api.yaml', 'kubectl rollout status deployment/api', 'kubectl get pods', 'kubectl get endpoints api', 'kubectl logs deployment/api'],
      realityNote: 'CreateContainerConfigError, OOMKilled, CrashLoopBackOff and failing readiness probes are the everyday failures of Kubernetes workloads; describe, logs and events are how they are diagnosed on every cluster.',
    };
  }),
];

/** The commit id a seeded history ends at (for tags that name a commit). */
function headOf(commits: SeedCommit[]): string {
  const files = seedRepo('/tmp/h', commits);
  const f = files['/tmp/h/.git/state.json'];
  const st = JSON.parse(typeof f === 'string' ? f : (f as { content: string }).content) as { branches: Record<string, string> };
  return st.branches.main;
}

export type { Org, Variant };
