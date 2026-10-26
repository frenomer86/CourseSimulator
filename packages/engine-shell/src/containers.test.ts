import { describe, expect, it } from 'vitest';
import { buildSystem, clusterFiles, runLines } from './index.js';

const box = (files: Record<string, string> = {}, k8s = false) =>
  buildSystem({
    hostname: 'node1',
    user: 'kofi',
    users: { kofi: {} },
    groups: { docker: ['kofi'] },
    packages: { docker: { installed: true }, kubectl: { installed: true }, git: { installed: true } },
    services: { docker: { active: true, enabled: true } },
    files: { ...files, ...(k8s ? clusterFiles('kofi') : {}) },
  } as never);

describe('container runtime', () => {
  it('runs commands inside the image, with only the tools it has', () => {
    const out = runLines(box(), ["docker run --rm alpine:3.20 sh -c 'head -1 /etc/os-release; whoami'", "docker run --rm alpine:3.20 bash -c 'echo hi'", 'docker run --rm debian:12-slim apt-get install -y curl']);
    expect(out).toMatch(/NAME="Alpine Linux"\nroot/);
    expect(out).toMatch(/\/bin\/sh: bash: not found/);
    expect(out).toMatch(/E: Unable to locate package curl/);
  });

  it('reuses cached layers when only the code changes', () => {
    const sys = box({ '/home/kofi/app/requirements.txt': 'flask==3.0.3\n', '/home/kofi/app/app.py': 'print(1)\n', '/home/kofi/app/Dockerfile': 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\n' });
    runLines(sys, ['cd app', 'docker build -t a:1 .']);
    const out = runLines(sys, ['cd app', "echo '# x' >> app.py", 'docker build -t a:2 .']);
    expect(out).toMatch(/RUN pip install[^\n]*\n#\d+ CACHED/);
    expect(out).not.toMatch(/COPY \. \.\n#\d+ CACHED/);
  });

  it('resolves container names only on user-defined networks', () => {
    const out = runLines(box(), ['docker network create net', 'docker run -d --name web --network net nginx:1.27-alpine', 'docker run --rm --network net alpine:3.20 wget -qO- http://web/', 'docker run --rm alpine:3.20 wget -qO- http://web/']);
    expect(out).toMatch(/Welcome to nginx/);
    expect(out).toMatch(/wget: bad address 'web'/);
  });

  it('keeps data in a named volume across containers', () => {
    const out = runLines(box(), ['docker run -d --name db -e POSTGRES_PASSWORD=pw -v pgdata:/var/lib/postgresql/data postgres:16', 'sleep 4', 'docker exec db psql -U postgres -c "CREATE TABLE t (a text)"', "docker exec db psql -U postgres -c \"INSERT INTO t VALUES ('kept')\"", 'docker rm -f db', 'docker run -d --name db2 -e POSTGRES_PASSWORD=pw -v pgdata:/var/lib/postgresql/data postgres:16', 'sleep 2', 'docker exec db2 psql -U postgres -tc "SELECT a FROM t"']);
    expect(out).toMatch(/ kept\n/);
  });

  it('balances an nginx upstream by weight after a reload', () => {
    const sys = box({ '/home/kofi/proxy.conf': 'upstream app {\n  server blue:8080 weight=3;\n  server green:8080 weight=1;\n}\nserver {\n  listen 80;\n  location / { proxy_pass http://app; }\n}\n' });
    runLines(sys, ['docker network create n', "docker run -d --name blue --network n alpine:3.20 sh -c 'mkdir /w; echo blue > /w/v; exec httpd -f -p 8080 -h /w'", "docker run -d --name green --network n alpine:3.20 sh -c 'mkdir /w; echo green > /w/v; exec httpd -f -p 8080 -h /w'", 'docker run -d --name proxy --network n -p 8080:80 -v /home/kofi/proxy.conf:/etc/nginx/conf.d/default.conf:ro nginx:1.27-alpine']);
    const out = runLines(sys, ['for i in 1 2 3 4 5 6 7 8; do curl -s localhost:8080/v; done | sort | uniq -c']);
    expect(out).toMatch(/6 blue\n\s+2 green/);
  });
});

describe('compose', () => {
  it('waits for a healthy database before starting the app', () => {
    const files = {
      '/home/kofi/s/app/Dockerfile': 'FROM alpine:3.20\nCOPY start.sh /usr/local/bin/start.sh\nCMD ["start.sh"]\n',
      '/home/kofi/s/app/start.sh': '#!/bin/sh\nnc -z db 5432 || { echo refused; exit 1; }\necho connected\nexec sleep infinity\n',
      '/home/kofi/s/compose.yaml': 'services:\n  app:\n    build: ./app\n    depends_on:\n      db:\n        condition: service_healthy\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: pw\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres"]\n      interval: 2s\n      retries: 10\n',
    };
    const sys = box(files);
    runLines(sys, ['chmod +x s/app/start.sh']);
    const out = runLines(sys, ['cd s', 'docker compose up -d', 'docker compose ps', 'docker compose logs app']);
    expect(out).toMatch(/Container s-db-1 {2}Healthy/);
    expect(out).toMatch(/app-1 {2}\| connected/);
  });
});

describe('kubectl', () => {
  it('stalls a rollout on a bad image and rolls back', () => {
    const sys = box({}, true);
    const deploy = 'kubectl create deployment web --image=nginx:1.27 --replicas=3';
    const out = runLines(sys, [deploy, 'kubectl rollout status deployment/web', 'kubectl set image deployment/web nginx=nginx:9.9', 'kubectl rollout status deployment/web --timeout=30s', 'kubectl get pods', 'kubectl rollout undo deployment/web', 'kubectl rollout status deployment/web']);
    expect(out).toMatch(/error: timed out waiting for the condition/);
    expect(out).toMatch(/ImagePullBackOff/);
    expect(out.match(/1\/1 {5}Running/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).toMatch(/deployment "web" successfully rolled out\n$/);
  });
});

describe('git deploy hook', () => {
  it('checks out into a separate work tree on push', () => {
    const hook = '#!/bin/sh\ngit --work-tree=/home/kofi/www --git-dir=/home/kofi/site.git checkout -f main\n';
    const out = runLines(box(), ['git config --global user.name K', 'git config --global user.email k@x.org', 'git config --global init.defaultBranch main', 'git init -q --bare site.git', 'mkdir www', `printf '${hook.replace(/\n/g, '\\n')}' > site.git/hooks/post-receive`, 'chmod +x site.git/hooks/post-receive', 'git clone -q site.git work 2>/dev/null', 'cd work && echo v1 > index.html && git add . && git commit -qm v1 && git push -q origin main', 'cat /home/kofi/www/index.html']);
    expect(out).toMatch(/v1\n$/);
  });
});
