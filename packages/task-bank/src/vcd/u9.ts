/** Unit 9: monitoring and rollback — logs, metrics and traces; health checks and alerting; SLOs; rolling back. */

import type { TaskTemplate } from '../types';
import type { Org, Person, Variant } from './kit';
import { C, HOST, ORGS, caseStudy, clusterFiles, dockerDev, file, forge, fuser, image, kc, lab, out, owned, registryPackage, tmpl, withForge, write } from './kit';

const home = (me: Person) => `/home/${me.sam}`;
const ROUTES = ['/pay', '/balance', '/receipts', '/login', '/transfer'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (min: number, sec: number) => `2026-10-20T${pad(9 + Math.floor(min / 60))}:${pad(min % 60)}:${pad(sec)}Z`;

interface Req {
  ts: string;
  route: string;
  status: number;
  ms: number;
  id: string;
}

/** A morning of API requests: mostly fine, with 5xx errors concentrated on one route. */
function requests(v: Variant, n: number, worst: string): Req[] {
  const out: Req[] = [];
  for (let i = 0; i < n; i++) {
    const route = v.pick(ROUTES);
    const bad = route === worst ? v.int(1, 4) === 1 : v.int(1, 25) === 1;
    const status = bad ? v.pick([500, 502, 503]) : v.int(1, 12) === 1 ? 404 : 200;
    out.push({ ts: iso(Math.floor((i * 90) / 60), (i * 90) % 60), route, status, ms: bad ? v.int(900, 3000) : v.int(20, 450), id: `r-${1000 + i}` });
  }
  // The worst route must clearly be the worst.
  const count = (r: string) => out.filter((x) => x.route === r && x.status >= 500).length;
  const others = Math.max(...ROUTES.filter((r) => r !== worst).map(count));
  for (const x of out) if (count(worst) <= others + 1 && x.route === worst && x.status === 200) Object.assign(x, { status: 503, ms: 1500 });
  return out;
}

const jsonLine = (r: Req) => JSON.stringify({ ts: r.ts, level: r.status >= 500 ? 'error' : r.status >= 400 ? 'warn' : 'info', route: r.route, status: r.status, duration_ms: r.ms, request_id: r.id });

export const U9: TaskTemplate[] = [
  /* ---------------------------------------------------------------- 9.1 logs, metrics and traces */
  tmpl(9, 1, 'beginner', 'structured-logs', 'Answer questions from structured logs', 'E4', 25, 'Query JSON log lines with jq to count errors, find the worst route and the slowest request.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const worst = v.pick(ROUTES);
    const rs = requests(v, v.int(50, 70), worst);
    const errors = rs.filter((r) => r.status >= 500);
    const slowest = [...rs].sort((a, b) => b.ms - a.ms || a.id.localeCompare(b.id))[0];
    const pay = rs.filter((r) => r.route === '/pay');
    const avg = pay.length ? Math.round(pay.reduce((s, r) => s + r.ms, 0) / pay.length) : 0;
    const expect = `errors=${errors.length}\nworst_route=${worst}\nslowest=${slowest.id}\npay_avg_ms=${avg}`;
    return {
      instructions: lab({
        situation: `${o.org}'s API writes one JSON object per line to **~/logs/api.jsonl** (fields ts, level, route, status, duration_ms, request_id). Answer these with **jq** and write them to **~/report.txt**, one \`key=value\` per line, in this order:\n\n1. \`errors=\` how many requests got a 5xx status;\n2. \`worst_route=\` the route with the most 5xx responses;\n3. \`slowest=\` the request_id of the slowest request;\n4. \`pay_avg_ms=\` the average duration_ms of **/pay** requests, rounded to a whole number.`,
        steps: ['head -3 ~/logs/api.jsonl', "jq -s 'map(select(.status >= 500)) | length' ~/logs/api.jsonl", "jq -s 'map(select(.status >= 500)) | group_by(.route) | map({route: .[0].route, n: length}) | max_by(.n) | .route' ~/logs/api.jsonl", "jq -s 'max_by(.duration_ms) | .request_id' ~/logs/api.jsonl", "jq -s 'map(select(.route == \"/pay\") | .duration_ms) | add / length | round' ~/logs/api.jsonl"],
        tips: ['jq -s (slurp) reads all lines into one array.', 'jq -r prints strings without quotes.', 'Structured logs are queried like data: no fragile grep patterns.'],
      }),
      hints: ['5xx means status >= 500.', 'group_by(.route) makes one array per route; length counts each.'],
      initialState: dockerDev({ me, packages: ['jq'], files: owned({ [`${home(me)}/logs/api.jsonl`]: rs.map(jsonLine).join('\n') + '\n' }, me.sam) }),
      checks: [file('The report has the right answers', `${home(me)}/report.txt`, { equals: expect })],
      solution: ['cd ~/logs', `echo "errors=$(jq -s 'map(select(.status >= 500)) | length' api.jsonl)" > ~/report.txt`, `echo "worst_route=$(jq -rs 'map(select(.status >= 500)) | group_by(.route) | map({route: .[0].route, n: length}) | max_by(.n) | .route' api.jsonl)" >> ~/report.txt`, `echo "slowest=$(jq -rs 'max_by(.duration_ms) | .request_id' api.jsonl)" >> ~/report.txt`, `echo "pay_avg_ms=$(jq -s 'map(select(.route == "/pay") | .duration_ms) | add / length | round' api.jsonl)" >> ~/report.txt`, 'cat ~/report.txt'],
      realityNote: 'Logging JSON instead of free text is what lets Loki, Elasticsearch and cloud log services filter and aggregate by field; jq is the same idea on one machine.',
    };
  }),
  tmpl(9, 1, 'intermediate', 'metrics-exposition', 'Expose metrics in Prometheus format', 'E4', 30, 'Turn an access log into Prometheus counters for the textfile collector and make promtool accept them without warnings.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const worst = v.pick(ROUTES);
    const rs = requests(v, v.int(40, 60), worst);
    const months = 'Oct';
    const log = rs.map((r, i) => `10.0.${v.int(0, 9)}.${10 + (i % 40)} - - [20/${months}/2026:${r.ts.slice(11, 19)} +0000] "${r.route === '/login' || r.route === '/pay' || r.route === '/transfer' ? 'POST' : 'GET'} ${r.route} HTTP/1.1" ${r.status} ${v.int(200, 4000)} ${(r.ms / 1000).toFixed(3)}`).join('\n') + '\n';
    const counts = new Map<string, number>();
    for (const r of rs) counts.set(`${r.route} ${r.status}`, (counts.get(`${r.route} ${r.status}`) ?? 0) + 1);
    const sample = [...counts].sort((a, b) => b[1] - a[1])[0];
    const err = rs.filter((r) => r.route === worst && r.status >= 500)[0];
    const prom = '/var/lib/node_exporter/textfile/app.prom';
    const script = `#!/bin/bash\n# Prints request counters for the textfile collector.\nset -euo pipefail\nlog="\${1:-/var/log/app/access.log}"\necho '# HELP http_requests_total HTTP requests by path and status code.'\necho '# TYPE http_requests_total counter'\nawk '{ split($7, p, "?"); n[p[1] " " $9]++ } END { for (k in n) { split(k, a, " "); printf "http_requests_total{path=\\"%s\\",code=\\"%s\\"} %d\\n", a[1], a[2], n[k] } }' "$log" | sort\n`;
    return {
      instructions: lab({
        situation: `${o.org}'s API logs requests to **/var/log/app/access.log** (combined log format with the duration at the end). node_exporter's textfile collector publishes any **.prom** file in /var/lib/node_exporter/textfile. Write **~/bin/export-metrics.sh** that prints, in the Prometheus text format:\n\n- \`# HELP\` and \`# TYPE ... counter\` lines for **http_requests_total**;\n- one sample per path and status code: \`http_requests_total{path="/pay",code="200"} N\`.\n\nRun it into **${prom}**, and check it with \`promtool check metrics < ${prom}\`: no errors and no lint warnings.`,
        steps: ['head -3 /var/log/app/access.log', 'Write ~/bin/export-metrics.sh (awk counts per path and code)', `~/bin/export-metrics.sh > ${prom}`, `promtool check metrics < ${prom}; echo $?`],
        tips: ['In the combined format, awk\'s $7 is the path and $9 the status code.', 'A counter\'s name should end in _total, and every metric needs # HELP.', 'Label values are quoted: {path="/pay",code="500"}'],
      }),
      hints: ['promtool check metrics prints nothing and exits 0 when the text is clean.', 'Each label set must appear only once.'],
      initialState: dockerDev({ me, packages: ['prometheus'], files: { '/var/log/app/access.log': { content: log, mode: '644', owner: 'root', group: 'root' }, '/var/lib/node_exporter/textfile/': { content: '', owner: me.sam, group: me.sam }, [`${home(me)}/bin/`]: { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('promtool accepts the file without warnings', `promtool check metrics < ${prom}; echo "rc=$?"`, { equals: 'rc=0', message: 'promtool reports problems: check HELP/TYPE lines, the _total suffix and the label syntax.' }),
        file('The counts are right', prom, { contains: [`http_requests_total{path="${sample[0].split(' ')[0]}",code="${sample[0].split(' ')[1]}"} ${sample[1]}`, `http_requests_total{path="${err.route}",code="${err.status}"} ${counts.get(`${err.route} ${err.status}`)}`, '# TYPE http_requests_total counter'] }),
        out('The script works on any log given to it', `printf '1.2.3.4 - - [20/Oct/2026:10:00:00 +0000] "GET /x HTTP/1.1" 418 1 0.001\\n' > /tmp/one.log && ${home(me)}/bin/export-metrics.sh /tmp/one.log | grep '^http_requests_total'`, { equals: 'http_requests_total{path="/x",code="418"} 1' }),
      ],
      solution: [write('~/bin/export-metrics.sh', script), 'chmod +x ~/bin/export-metrics.sh', `~/bin/export-metrics.sh > ${prom}`, `cat ${prom}`, `promtool check metrics < ${prom}; echo $?`],
      realityNote: 'The textfile collector is the standard way to publish metrics from batch jobs and scripts; applications normally expose the same text format on a /metrics endpoint through a Prometheus client library.',
    };
  }),
  tmpl(9, 1, 'advanced', 'trace-a-request', 'Follow a failed request across services', 'E4', 30, 'Use trace ids in three services\' logs to find which service caused a failure and where the time went.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const services = ['gateway', 'orders', 'payments'] as const;
    const culprit = v.pick(['orders', 'payments'] as const);
    const msg = culprit === 'payments' ? v.pick(['card processor timeout', 'mobile money API returned 503']) : v.pick(['database connection pool exhausted', 'stock reservation deadlock']);
    const traces = Array.from({ length: 8 }, (_, i) => `${(0xa1b2c3 + i * 7919).toString(16)}${v.int(1000, 9999)}`);
    const bad = v.pick(traces);
    const lines: Record<string, string[]> = { gateway: [], orders: [], payments: [] };
    const ms: Record<string, number> = {};
    traces.forEach((t, i) => {
      const failing = t === bad;
      const p = failing && culprit === 'payments' ? v.int(2900, 3100) : v.int(40, 300);
      const ord = failing && culprit === 'orders' ? v.int(1500, 2500) : v.int(20, 120);
      const ts = (s: number) => `2026-10-20T11:${pad(10 + i)}:${pad(s)}Z`;
      lines.payments.push(JSON.stringify({ ts: ts(2), service: 'payments', trace_id: t, span: 'charge', duration_ms: p, status: failing && culprit === 'payments' ? 'error' : 'ok', ...(failing && culprit === 'payments' ? { error: msg } : {}) }));
      lines.orders.push(JSON.stringify({ ts: ts(1), service: 'orders', trace_id: t, span: 'create_order', duration_ms: ord + p + 15, status: failing ? 'error' : 'ok', ...(failing ? { error: culprit === 'orders' ? msg : 'payment failed' } : {}) }));
      lines.gateway.push(JSON.stringify({ ts: ts(0), service: 'gateway', trace_id: t, span: 'POST /checkout', duration_ms: ord + p + 40, status: failing ? 502 : 200 }));
      if (t === bad) Object.assign(ms, { gateway: 25, orders: ord + 15, payments: p });
    });
    const slow = Object.entries(ms).sort((a, b) => b[1] - a[1])[0][0];
    const expect = `trace=${bad}\nroot_cause=${culprit}\nerror=${msg}\nslowest=${slow}`;
    return {
      instructions: lab({
        situation: `A customer of ${o.org} got **502 Bad Gateway** on checkout at 11:${pad(10 + traces.indexOf(bad))}. Each service logs JSON to ~/logs/**gateway.jsonl**, **orders.jsonl** and **payments.jsonl**, and every line carries the request's **trace_id**. Write **~/incident.txt** with:\n\n- \`trace=\` the trace id of the request that got the 502;\n- \`root_cause=\` the service where the failure **started** (the deepest service that reports an error of its own, not "payment failed" passed up from below);\n- \`error=\` that service's error message;\n- \`slowest=\` the service that spent the most time of its own on the request (a parent's duration includes its children's).`,
        steps: ["jq -c 'select(.status == 502)' ~/logs/gateway.jsonl", "jq -c --arg t TRACE 'select(.trace_id == $t)' ~/logs/*.jsonl", 'Subtract each child\'s duration from its parent\'s to get the time spent in the service itself'],
        tips: ['A trace id ties together every log line one request produced, across services.', 'gateway → orders → payments: orders\' duration includes the payment call.'],
      }),
      hints: ['Start from the gateway line with status 502, take its trace_id, then search the other logs.', 'Own time of orders = orders duration - payments duration (minus nothing else here).'],
      initialState: dockerDev({ me, packages: ['jq'], files: owned(Object.fromEntries(services.map((s) => [`${home(me)}/logs/${s}.jsonl`, lines[s].join('\n') + '\n'])), me.sam) }),
      checks: [file('The incident notes name the trace, cause, error and slowest service', `${home(me)}/incident.txt`, { equals: expect })],
      solution: [`t=$(jq -r 'select(.status == 502) | .trace_id' ~/logs/gateway.jsonl)`, `t=$(jq -r 'select(.status == 502) | .trace_id' ~/logs/gateway.jsonl); jq -c --arg t "$t" 'select(.trace_id == $t)' ~/logs/*.jsonl`, `printf 'trace=%s\\nroot_cause=${culprit}\\nerror=${msg}\\nslowest=${slow}\\n' "$(jq -r 'select(.status == 502) | .trace_id' ~/logs/gateway.jsonl)" > ~/incident.txt`, 'cat ~/incident.txt'],
      realityNote: 'Distributed tracing (OpenTelemetry, Jaeger, Grafana Tempo) automates exactly this: propagate one trace id through every call and show each service\'s own time as a span.',
    };
  }),

  /* ---------------------------------------------------------------- 9.2 health checks, uptime, alerting, on-call */
  tmpl(9, 2, 'beginner', 'uptime-check', 'Write an uptime check and schedule it', 'E4', 25, 'Check health endpoints with curl, report UP or DOWN with the right exit status, log outages, and run it from cron.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const [pa, pb] = v.pick([[8080, 8081], [8090, 8091], [9000, 9001]]);
    const mins = v.pick([2, 5, 10]);
    const app = (name: string, healthy: boolean) => image(`${o.org}/${name}:1.0`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: `#!/bin/sh\nmkdir -p /srv/www && echo "${name}" > /srv/www/index.html\n${healthy ? 'echo ok > /srv/www/healthz\n' : ''}exec httpd -f -p 8080 -h /srv/www\n`, mode: '755' } }, cmd: 'start.sh', expose: [8080] });
    const script = `#!/bin/bash\n# Usage: check-site.sh URL  - prints UP or DOWN and logs outages.\nurl="\${1:?usage: check-site.sh URL}"\nif curl -fsS --max-time 5 -o /dev/null "$url"; then\n  echo "UP $url"\nelse\n  echo "DOWN $url"\n  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) DOWN $url" >> "$HOME/uptime.log"\n  exit 1\nfi\n`;
    const appA = app('shop', true);
    const appB = app('reports', false);
    return {
      instructions: lab({
        situation: `Two of ${o.org}'s services run here: **shop** on port ${pa} and **reports** on port ${pb}; each should answer **/healthz** with 200. Write **~/bin/check-site.sh URL** that:\n\n- fetches the URL with curl, failing on HTTP errors and giving up after 5 seconds;\n- prints \`UP URL\` and exits **0** when it works;\n- prints \`DOWN URL\`, appends \`TIMESTAMP DOWN URL\` to **~/uptime.log**, and exits **1** when it does not.\n\nStart both containers (\`docker start shop reports\`), run your check on both /healthz URLs, and add a **crontab** entry that checks http://localhost:${pa}/healthz every **${mins} minutes**.`,
        steps: ['docker start shop reports', 'Write ~/bin/check-site.sh; chmod +x', `~/bin/check-site.sh http://localhost:${pa}/healthz; echo $?`, `~/bin/check-site.sh http://localhost:${pb}/healthz; echo $?`, 'crontab -e (or crontab -l | … | crontab -)', 'cat ~/uptime.log'],
        tips: ['curl -f turns HTTP errors (404, 500) into a failing exit status; -sS hides progress but shows errors; --max-time 5 caps the wait.', `*/${mins} * * * * $HOME/bin/check-site.sh http://localhost:${pa}/healthz`],
      }),
      hints: ['Exit codes are what monitoring tools and cron wrappers act on: 0 means healthy.', 'Without -f, curl exits 0 even when the server answers 404 or 500.'],
      initialState: dockerDev({ me, docker: { pulled: ['alpine:3.20'], images: [appA, appB], containers: [{ ...containerOf('shop', appA, pa) }, { ...containerOf('reports', appB, pb) }] }, files: { [`${home(me)}/bin/`]: { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('A healthy service is UP with exit status 0', `su - ${me.sam} -c '~/bin/check-site.sh http://localhost:${pa}/healthz' 2>/dev/null; echo "rc=$?"`, { equals: `UP http://localhost:${pa}/healthz\nrc=0` }),
        out('A failing service is DOWN with exit status 1', `su - ${me.sam} -c '~/bin/check-site.sh http://localhost:${pb}/healthz' 2>/dev/null; echo "rc=$?"`, { equals: `DOWN http://localhost:${pb}/healthz\nrc=1` }),
        file('Outages are logged with a time stamp', `${home(me)}/uptime.log`, { pattern: `^20\\d\\d-\\d\\d-\\d\\dT[\\d:]+Z DOWN http://localhost:${pb}/healthz$` }),
        out(`cron checks the shop every ${mins} minutes`, `crontab -l -u ${me.sam}`, { pattern: `^\\*/${mins} \\* \\* \\* \\* .*check-site\\.sh http://localhost:${pa}/healthz` }),
      ],
      solution: ['docker start shop reports', write('~/bin/check-site.sh', script), 'chmod +x ~/bin/check-site.sh', `~/bin/check-site.sh http://localhost:${pa}/healthz; echo $?`, `~/bin/check-site.sh http://localhost:${pb}/healthz; echo $?`, `(crontab -l 2>/dev/null; echo '*/${mins} * * * * $HOME/bin/check-site.sh http://localhost:${pa}/healthz') | crontab -`, 'crontab -l', 'cat ~/uptime.log'],
      realityNote: 'Uptime monitors (Uptime Kuma, Prometheus blackbox_exporter, hosted checkers) do exactly this from outside the server; the exit-status convention is the same one Nagios-style checks use.',
    };
  }),
  tmpl(9, 2, 'intermediate', 'alert-rules', 'Write Prometheus alerting rules', 'E4', 30, 'Write alerting and recording rules with sensible thresholds and durations, and validate them with promtool.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const pct = v.pick([2, 5, 10]);
    const forM = v.pick([5, 10, 15]);
    const dir = `${home(me)}/monitoring`;
    const rules = `groups:\n  - name: ${o.project}\n    rules:\n      - record: job:http_errors:ratio5m\n        expr: sum by (job) (rate(http_requests_total{code=~"5.."}[5m])) / sum by (job) (rate(http_requests_total[5m]))\n      - alert: HighErrorRate\n        expr: job:http_errors:ratio5m > ${pct / 100}\n        for: ${forM}m\n        labels:\n          severity: page\n        annotations:\n          summary: "{{ $labels.job }} error rate above ${pct}%"\n          description: "{{ $value }} of requests failed over the last 5 minutes."\n      - alert: InstanceDown\n        expr: up == 0\n        for: 2m\n        labels:\n          severity: page\n        annotations:\n          summary: "{{ $labels.instance }} is down"\n`;
    return {
      instructions: lab({
        situation: `Write **~/monitoring/rules.yml** for ${o.org}'s Prometheus, one group named **${o.project}**, with:\n\n- a **recording rule** \`job:http_errors:ratio5m\`: per job, the rate of 5xx requests (code matching \`5..\`) over 5 minutes divided by the rate of all requests;\n- an alert **HighErrorRate**: that ratio above **${pct}%** (${pct / 100}) for **${forM} minutes**, label \`severity: page\`, and a \`summary\` annotation that names the job (\`{{ $labels.job }}\`);\n- an alert **InstanceDown**: \`up == 0\` for **2 minutes**, \`severity: page\`, with a summary naming the instance.\n\nValidate it with \`promtool check rules\`.`,
        steps: ['Write rules.yml: groups → name, rules', 'promtool check rules ~/monitoring/rules.yml'],
        tips: ['rate() needs a range: rate(http_requests_total[5m]).', 'for: makes an alert wait before firing, so a single bad scrape does not page anyone.', 'A recording rule name has the form level:metric:operations.'],
      }),
      hints: ['If promtool says "expected type range vector", a [5m] is missing.', 'Thresholds are ratios: 5% is 0.05.'],
      initialState: dockerDev({ me, packages: ['prometheus'], files: { [`${dir}/`]: { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('promtool accepts the rules', `promtool check rules ${dir}/rules.yml`, { contains: 'SUCCESS: 3 rules found' }),
        file('HighErrorRate pages after the agreed time and threshold', `${dir}/rules.yml`, { pattern: `alert: HighErrorRate[\\s\\S]*?> ?0?\\.${String(pct / 100).split('.')[1]}\\b[\\s\\S]*?for: ${forM}m[\\s\\S]*?severity: page` }),
        file('InstanceDown waits 2 minutes', `${dir}/rules.yml`, { pattern: 'alert: InstanceDown[\\s\\S]*?up ?== ?0[\\s\\S]*?for: 2m' }),
        file('The recording rule computes the 5xx ratio', `${dir}/rules.yml`, { contains: ['record: job:http_errors:ratio5m', 'code=~"5.."', '[5m]', '$labels.job'] }),
      ],
      solution: [write('~/monitoring/rules.yml', rules), 'promtool check rules ~/monitoring/rules.yml'],
      realityNote: 'These rule files are loaded unchanged by Prometheus (and by Thanos, Mimir or Grafana\'s alerting); promtool check rules is what CI runs on them before they are deployed.',
    };
  }),
  tmpl(9, 2, 'advanced', 'alert-routing', 'Route alerts to the right people', 'E4', 30, 'Write an Alertmanager configuration whose routing tree pages on-call only for urgent alerts, sends team alerts to their channel, and suppresses duplicate noise.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const team = v.pick(['payments', 'mobile', 'reports']);
    const dir = `${home(me)}/monitoring`;
    const cfg = `route:\n  receiver: team-chat\n  group_by: [alertname, job]\n  routes:\n    - matchers: [severity="page"]\n      receiver: oncall-pager\n      continue: true\n    - matchers: [team="${team}"]\n      receiver: ${team}-team\nreceivers:\n  - name: team-chat\n    webhook_configs:\n      - url: http://chat.${o.org}.lab/hooks/ops\n  - name: oncall-pager\n    webhook_configs:\n      - url: http://pager.${o.org}.lab/alert\n  - name: ${team}-team\n    webhook_configs:\n      - url: http://chat.${o.org}.lab/hooks/${team}\ninhibit_rules:\n  - source_matchers: [alertname="InstanceDown"]\n    target_matchers: [severity="warning"]\n    equal: [instance]\n`;
    const am = `${dir}/alertmanager.yml`;
    const test = (labels: string) => `amtool config routes test --config.file=${am} ${labels}`;
    return {
      instructions: lab({
        situation: `Write **~/monitoring/alertmanager.yml** so that alerts reach the right people:\n\n- by default alerts go to **team-chat** (webhook http://chat.${o.org}.lab/hooks/ops), grouped by alertname and job;\n- alerts with **severity="page"** go to **oncall-pager** (webhook http://pager.${o.org}.lab/alert) **and** continue down the tree;\n- alerts with **team="${team}"** go to **${team}-team** (webhook http://chat.${o.org}.lab/hooks/${team});\n- an **inhibit rule**: while **InstanceDown** fires for an instance, its **severity="warning"** alerts are suppressed.\n\nCheck it with \`amtool check-config\` and test the routes with \`amtool config routes test\`: a paging ${team} alert must reach **oncall-pager,${team}-team**; a warning for another team must reach **team-chat**.`,
        steps: ['Write alertmanager.yml: route (receiver, group_by, routes), receivers, inhibit_rules', 'amtool check-config ~/monitoring/alertmanager.yml', `amtool config routes test --config.file=~/monitoring/alertmanager.yml severity=page team=${team}`, 'amtool config routes --config.file=~/monitoring/alertmanager.yml'],
        tips: ['A route stops at the first child that matches unless that child has continue: true.', 'matchers: [severity="page"] is the current syntax; match: {severity: page} is the older one.'],
      }),
      hints: ['Every receiver a route names must be defined under receivers.', 'Paging should be rare: only severity=page alerts wake someone up.'],
      initialState: dockerDev({ me, packages: ['alertmanager'], files: { [`${dir}/`]: { content: '', owner: me.sam, group: me.sam } } }),
      checks: [
        out('amtool accepts the configuration', `amtool check-config ${am}`, { contains: 'SUCCESS' }),
        out(`A paging ${team} alert reaches on-call and the team`, test(`severity=page team=${team} alertname=HighErrorRate`), { equals: `oncall-pager,${team}-team` }),
        out('A paging alert for another team reaches on-call only', test('severity=page team=other alertname=InstanceDown'), { equals: 'oncall-pager' }),
        out('A warning for another team reaches chat only', test('severity=warning team=other alertname=DiskFilling'), { equals: 'team-chat' }),
        file('InstanceDown inhibits warnings on the same instance', am, { contains: ['inhibit_rules', 'InstanceDown', 'warning', 'instance'] }),
      ],
      solution: [write('~/monitoring/alertmanager.yml', cfg), 'amtool check-config ~/monitoring/alertmanager.yml', `amtool config routes test --config.file=~/monitoring/alertmanager.yml severity=page team=${team}`, 'amtool config routes --config.file=~/monitoring/alertmanager.yml'],
      realityNote: 'Alertmanager\'s routing tree, grouping and inhibition are what keep on-call rotations humane: urgent things page, everything else goes to a channel, and one outage does not send fifty notifications.',
    };
  }),

  /* ---------------------------------------------------------------- 9.3 SLIs, SLOs and error budgets */
  tmpl(9, 3, 'beginner', 'choose-slos', 'Choose service level indicators and objectives', 'E10', 15, 'Pick SLIs that reflect what users feel, set realistic SLOs and use the error budget to balance speed and reliability.', (v) => {
    const o = v.pick(ORGS);
    return caseStudy(v, {
      intro: `## "It should never go down"\n\n${o.org}'s managers ask for 100% uptime of the ${o.what}. The dashboard shows CPU usage and the number of pods. Users complain about slow payments in the evening even though "the servers are fine".`,
      steps: [
        { title: 'What to measure', text: 'Which indicator best reflects what users feel?', choices: [{ text: 'The share of valid requests that succeed, and the share served faster than a threshold (for example 300 ms), measured at the load balancer', right: true, feedback: 'Correct. Availability and latency SLIs measured close to the user capture the slow evenings.' }, { text: 'CPU usage of the servers', feedback: 'CPU can be fine while users wait on a slow database.' }, { text: 'Number of running pods', feedback: 'Pods can be running and still failing requests.' }] },
        { title: 'The target', text: 'Managers want 100%.', choices: [{ text: 'Agree a realistic SLO such as 99.5% of requests succeeding over 30 days, below what users would notice, and leave the rest as an error budget', right: true, feedback: 'Correct. 100% is impossible and would forbid every change; a deliberate target makes reliability a decision.' }, { text: 'Promise 100% and work harder', feedback: 'No system reaches 100%; promising it guarantees broken promises.' }, { text: 'No target: just do our best', feedback: 'Without a target there is no way to decide whether to ship or to stabilise.' }] },
        { title: 'Which requests count', text: 'Health checks from the load balancer are 40% of all requests.', choices: [{ text: 'Exclude health checks and bot traffic from the SLI: count valid user requests only', right: true, feedback: 'Correct. Including easy health checks would hide real user failures.' }, { text: 'Count them; more requests make the number look better', feedback: 'That is exactly the problem: it hides failures.' }, { text: 'Count only failed requests', feedback: 'An SLI is a ratio of good to valid events.' }] },
        { title: 'Spending the budget', text: 'Half the month\'s error budget is gone after a bad release in week one.', choices: [{ text: 'Slow down risky releases and spend effort on reliability until the budget recovers, as agreed in the error budget policy', right: true, feedback: 'Correct. The budget turns "move fast" versus "be stable" into an agreed rule.' }, { text: 'Ignore it; budgets are just numbers', feedback: 'Then the SLO has no effect on decisions.' }, { text: 'Lower the SLO to 95% so the budget looks fine', feedback: 'Moving the target to fit the outage defeats the purpose.' }] },
        { title: 'Alerting', text: 'When should someone be paged?', choices: [{ text: 'When the error budget is burning fast enough to be used up soon (burn-rate alerts), not on every brief spike', right: true, feedback: 'Correct. Burn-rate alerts page on what threatens the SLO and ignore noise.' }, { text: 'Whenever any single request fails', feedback: 'That pages constantly for things within budget.' }, { text: 'Only when the budget is already gone', feedback: 'Then there is nothing left to save.' }] },
      ],
      ending: { title: 'Reliability as a decision', text: 'User-centred SLIs, a realistic SLO with an error budget, valid events only, an agreed policy for spending it, and alerts on burn rate.' },
      hints: ['SLI = good events / valid events.', 'The error budget is 100% minus the SLO.'],
      realityNote: 'Google\'s "Site Reliability Engineering" and "The Site Reliability Workbook" define these practices; tools such as Sloth, Pyrra and OpenSLO turn SLO definitions into Prometheus rules.',
    });
  }),
  tmpl(9, 3, 'intermediate', 'availability-sli', 'Measure availability and latency against an SLO', 'E4', 30, 'Compute availability and latency SLIs from an access log, compare them with the SLO and work out the remaining error budget.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const worst = v.pick(ROUTES);
    const rs = requests(v, v.int(150, 220), worst);
    const health = Array.from({ length: v.int(30, 60) }, (_, i) => ({ ts: iso(i, 30), route: '/healthz', status: 200, ms: v.int(1, 5), id: `h-${i}` }));
    const all = [...rs, ...health].sort((a, b) => a.ts.localeCompare(b.ts));
    const valid = rs.filter((r) => r.status !== 404);
    const good = valid.filter((r) => r.status < 500);
    const fast = valid.filter((r) => r.ms < 300);
    const slo = v.pick([99, 98, 95]);
    const avail = (good.length / valid.length) * 100;
    const lat = (fast.length / valid.length) * 100;
    const allowed = Math.floor((valid.length * (100 - slo)) / 100);
    const bad = valid.length - good.length;
    const expect = `valid=${valid.length}\ngood=${good.length}\navailability=${avail.toFixed(2)}\nlatency_under_300ms=${lat.toFixed(2)}\nslo_met=${avail >= slo ? 'yes' : 'no'}\nbudget_remaining=${allowed - bad}`;
    return {
      instructions: lab({
        situation: `~/logs/api.jsonl holds this morning's requests to ${o.org}'s API, including the load balancer's **/healthz** checks. The availability SLO is **${slo}%**. Using **valid requests only** — not /healthz, and not 404s (client errors) — work out and write to **~/sli.txt**, one \`key=value\` per line in this order:\n\n- \`valid=\` number of valid requests;\n- \`good=\` valid requests that did **not** get a 5xx;\n- \`availability=\` good / valid as a percentage with **2 decimals**;\n- \`latency_under_300ms=\` the percentage of valid requests faster than **300 ms**, 2 decimals;\n- \`slo_met=\` yes or no;\n- \`budget_remaining=\` how many more bad requests the SLO would allow for this traffic: floor(valid × (100 − ${slo}) / 100) minus the bad requests (negative if overspent).`,
        steps: ["jq -s 'map(select(.route != \"/healthz\" and .status != 404))' ~/logs/api.jsonl", 'Count valid, good (status < 500), fast (duration_ms < 300)', "awk/printf '%.2f' for the percentages"],
        tips: ['SLI = good events / valid events × 100.', 'Error budget = (100 − SLO)% of valid events.', "jq -s '… | length'"],
      }),
      hints: ['Health checks always succeed quickly: counting them would flatter the SLI.', 'printf "%.2f" rounds to 2 decimals.'],
      initialState: dockerDev({ me, packages: ['jq'], files: owned({ [`${home(me)}/logs/api.jsonl`]: all.map(jsonLine).join('\n') + '\n' }, me.sam) }),
      checks: [file('The SLI report is right', `${home(me)}/sli.txt`, { equals: expect })],
      solution: ['cd ~/logs', `v=$(jq -s 'map(select(.route != "/healthz" and .status != 404)) | length' api.jsonl); g=$(jq -s 'map(select(.route != "/healthz" and .status != 404 and .status < 500)) | length' api.jsonl); f=$(jq -s 'map(select(.route != "/healthz" and .status != 404 and .duration_ms < 300)) | length' api.jsonl); a=$(awk -v g=$g -v v=$v 'BEGIN { printf "%.2f", g / v * 100 }'); l=$(awk -v f=$f -v v=$v 'BEGIN { printf "%.2f", f / v * 100 }'); met=$(awk -v a=$a 'BEGIN { print (a >= ${slo}) ? "yes" : "no" }'); b=$(awk -v v=$v -v g=$g 'BEGIN { printf "%d", int(v * ${100 - slo} / 100) - (v - g) }'); printf 'valid=%s\\ngood=%s\\navailability=%s\\nlatency_under_300ms=%s\\nslo_met=%s\\nbudget_remaining=%s\\n' $v $g $a $l $met $b > ~/sli.txt`, 'cat ~/sli.txt'],
      realityNote: 'This is the calculation an SLO dashboard runs continuously, usually as Prometheus recording rules over request counters rather than over raw logs.',
    };
  }),
  tmpl(9, 3, 'advanced', 'burn-rate', 'Decide on an alert from error-budget burn rates', 'E4', 35, 'Compute multi-window burn rates from hourly request counts and decide whether to page, open a ticket or do nothing.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const slo = 99.9;
    const scenario = v.pick(['page', 'ticket', 'none'] as const);
    const hours = 30 * 24;
    const rows: Array<[number, number, number]> = [];
    for (let h = 0; h < hours; h++) {
      const total = 2000 + ((h * 37) % 900);
      let errors = Math.floor(total * 0.0004);
      const fromEnd = hours - 1 - h;
      if (scenario === 'page' && fromEnd < 1) errors = Math.ceil(total * 0.02);
      if (scenario === 'ticket' && fromEnd < 72) errors = Math.ceil(total * 0.0016);
      rows.push([h, total, errors]);
    }
    const burn = (n: number) => {
      const w = rows.slice(-n);
      const t = w.reduce((s, r) => s + r[1], 0);
      const e = w.reduce((s, r) => s + r[2], 0);
      return e / t / (1 - slo / 100);
    };
    const b1 = burn(1);
    const b6 = burn(6);
    const b72 = burn(72);
    const action = b1 >= 14.4 || b6 >= 6 ? 'page' : b72 >= 1 ? 'ticket' : 'none';
    const tot = rows.reduce((s, r) => s + r[1], 0);
    const errs = rows.reduce((s, r) => s + r[2], 0);
    const used = (errs / (tot * (1 - slo / 100))) * 100;
    const expect = `burn_1h=${b1.toFixed(1)}\nburn_6h=${b6.toFixed(1)}\nburn_72h=${b72.toFixed(1)}\naction=${action}\nbudget_used_pct=${used.toFixed(1)}`;
    const csv = 'hour,total,errors\n' + rows.map((r) => r.join(',')).join('\n') + '\n';
    return {
      instructions: lab({
        situation: `~/slo/hourly.csv has ${o.org}'s request and error counts for every hour of the last 30 days (the last line is the most recent hour). The SLO is **${slo}%** availability over 30 days, so the error budget is 0.1% of requests.\n\nThe **burn rate** over a window is (errors / requests in that window) / 0.001: 1 means the budget would last exactly 30 days. Write **~/burn.txt** with, rounded to **1 decimal**:\n\n- \`burn_1h=\`, \`burn_6h=\`, \`burn_72h=\` (the last 1, 6 and 72 hours);\n- \`action=\` **page** if burn_1h ≥ 14.4 or burn_6h ≥ 6; else **ticket** if burn_72h ≥ 1; else **none**;\n- \`budget_used_pct=\` errors over the whole 30 days as a percentage of the 30-day budget.`,
        steps: ['tail -6 ~/slo/hourly.csv', "tail -n 6 ~/slo/hourly.csv | awk -F, '{t+=$2; e+=$3} END {printf \"%.1f\\n\", e/t/0.001}'", 'Same for 1 and 72 hours, and for all rows (skip the header)', 'Apply the decision rule'],
        tips: ['A 1-hour burn of 14.4 spends 2% of a 30-day budget in that hour.', 'tail -n +2 skips the CSV header.'],
      }),
      hints: ['Burn rate is a ratio of ratios: observed error rate divided by the allowed error rate (0.001).', 'Long windows catch slow leaks; short windows catch sudden outages.'],
      initialState: dockerDev({ me, files: owned({ [`${home(me)}/slo/hourly.csv`]: csv }, me.sam) }),
      checks: [file('The burn rates and decision are right', `${home(me)}/burn.txt`, { equals: expect })],
      solution: ['cd ~/slo', `br() { tail -n "$1" hourly.csv | awk -F, '{t+=$2; e+=$3} END {printf "%.1f", e/t/0.001}'; }; b1=$(br 1); b6=$(br 6); b72=$(br 72); act=$(awk -v a=$b1 -v b=$b6 -v c=$b72 'BEGIN { if (a >= 14.4 || b >= 6) print "page"; else if (c >= 1) print "ticket"; else print "none" }'); used=$(tail -n +2 hourly.csv | awk -F, '{t+=$2; e+=$3} END {printf "%.1f", e/(t*0.001)*100}'); printf 'burn_1h=%s\\nburn_6h=%s\\nburn_72h=%s\\naction=%s\\nbudget_used_pct=%s\\n' $b1 $b6 $b72 $act $used > ~/burn.txt`, 'cat ~/burn.txt'],
      realityNote: 'Multi-window, multi-burn-rate alerting is the approach in Google\'s Site Reliability Workbook (chapter "Alerting on SLOs"); the 14.4 and 6 thresholds come from spending 2% and 5% of a 30-day budget.',
    };
  }),

  /* ---------------------------------------------------------------- 9.4 rolling back; feature flags; post-mortems */
  tmpl(9, 4, 'beginner', 'revert-release', 'Roll back a bad change with git revert', 'E4', 25, 'Undo a commit that broke main by adding a revert commit, without rewriting shared history, and get CI green.', (v) => {
    const o = v.pick(ORGS);
    const [me, dev] = v.people(2);
    const full = `${o.org}/${o.project}`;
    const pct = v.pick([10, 15, 20]);
    const test = `#!/bin/bash\nset -euo pipefail\n[ "$(./price.sh 100)" = "100" ] || { echo "FAIL: 100 should stay 100, got $(./price.sh 100)"; exit 1; }\necho "tests passed"\n`;
    const good = '#!/bin/bash\necho "$1"\n';
    const bad = `#!/bin/bash\n# Discount codes (#${v.int(20, 60)})\necho $(( $1 * ${100 - pct} / 100 ))\n`;
    const wf = 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: ./test.sh\n';
    const subject = `Apply ${pct}% discount to every price`;
    return {
      instructions: lab({
        situation: `${dev.name}'s commit "${subject}" landed on main of **${full}** and CI is now red: prices are discounted for everyone. Roll it back **without rewriting history** (others have already pulled main): in your clone ~/${o.project}, revert that commit, push, and make sure CI on main is green again. Do not force-push.`,
        steps: ['git pull; git log --oneline', 'git revert COMMIT', 'git push', 'gh run list'],
        tips: ['git revert makes a new commit that undoes an earlier one; the history stays intact.', 'git reset --hard + push --force would rewrite main under everyone\'s feet.'],
      }),
      hints: ['Find the commit by its message in git log.', 'Keep the default revert message: it records which commit was undone.'],
      initialState: withForge({ me, org: o, seed: { users: { [me.sam]: fuser(me, o), [dev.sam]: fuser(dev, o, { local: false }) }, repos: { [full]: { members: { [dev.sam]: 'write' }, commits: [C('Prices and tests', me, o, { 'price.sh': good, 'test.sh': test, '.github/workflows/ci.yml': wf }), C(subject, dev, o, { 'price.sh': bad }, 1)], seed: { executable: ['price.sh', 'test.sh'] }, clones: { [me.sam]: '' } } } } }),
      checks: [
        forge('The latest commit on main reverts the bad one', full, { branch: { name: 'main', message: `^Revert "${subject}"`, minCommits: 3 } }),
        forge('CI on main is green again', full, { run: { workflow: 'CI', headOfBranch: 'main', conclusion: 'success' } }),
      ],
      solution: [`cd ~/${o.project} && git pull -q`, 'git log --oneline', `git revert --no-edit $(git log --format=%H --grep='${subject}' -1)`, 'git push -q', 'gh run list'],
      realityNote: 'Reverting is the safe rollback on shared branches; most teams also keep the previous image tag deployable so production can roll back while the revert goes through CI.',
    };
  }),
  tmpl(9, 4, 'intermediate', 'feature-flag', 'Turn off a broken feature with a flag', 'E4', 30, 'Disable a misbehaving feature through configuration without building or deploying a new image.', (v) => {
    const o = v.pick(ORGS);
    const me = v.person();
    const flag = v.pick(['NEW_CHECKOUT', 'INSTANT_REFUNDS', 'MOMO_V2']);
    const ver = `4.${v.int(0, 9)}.0`;
    const remote = `${HOST}/${o.org}/shop`;
    const start = `#!/bin/sh\nmkdir -p /srv/www\nif [ "$${flag}" = "on" ]; then\n  echo "<h1>Checkout</h1><p>new flow</p>" > /srv/www/index.html\n  echo "feature ${flag} on"\nelse\n  echo "<h1>Checkout</h1><p>classic flow</p>" > /srv/www/index.html\n  echo "feature ${flag} off"\nfi\necho ok > /srv/www/healthz\nexec httpd -f -p 8080 -h /srv/www\n`;
    const img = image(`${o.org}/shop:${ver}`, 'alpine:3.20', { files: { '/usr/local/bin/start.sh': { content: start, mode: '755' } }, cmd: 'start.sh', expose: [8080] });
    const pkg = registryPackage(o.org, 'shop', { [ver]: img }, 'public');
    const manifests = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shop-flags\ndata:\n  ${flag}: "on"\n---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\nspec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app: shop\n  template:\n    metadata:\n      labels:\n        app: shop\n    spec:\n      containers:\n      - name: shop\n        image: ${remote}:${ver}\n        envFrom:\n        - configMapRef:\n            name: shop-flags\n        ports:\n        - containerPort: 8080\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: shop\nspec:\n  selector:\n    app: shop\n  ports:\n  - port: 80\n    targetPort: 8080\n`;
    const kube = (c: string) => kc(me, c);
    return {
      instructions: lab({
        situation: `Release ${ver} of ${o.org}'s shop added a new checkout behind the feature flag **${flag}**, which is \`on\` in the ConfigMap **shop-flags**. The new flow is losing orders. **Turn it off without a new image or a code change**:\n\n1. Set ${flag} to \`off\` in the shop-flags ConfigMap.\n2. The pods read their environment when they start, so **restart the Deployment** (a rollout of the same image).\n3. Check that the shop now serves the **classic flow**, and that the image is still ${ver}.`,
        steps: ['kubectl get configmap shop-flags -o yaml', `kubectl patch configmap shop-flags -p '{"data":{"${flag}":"off"}}'`, 'kubectl rollout restart deployment/shop', 'kubectl rollout status deployment/shop', 'kubectl logs deployment/shop', 'kubectl port-forward svc/shop 8080:80; curl -s localhost:8080'],
        tips: ['Feature flags separate deploying code from releasing a feature: switching one is a configuration change.', 'kubectl rollout restart replaces the pods with the same image and the new configuration.'],
      }),
      hints: ['Changing the ConfigMap alone does not change environment variables of running pods.', 'kubectl get deployment shop -o jsonpath=\'{.spec.template.spec.containers[0].image}\''],
      initialState: withForge({ me, org: o, packages: ['kubectl'], files: clusterFiles(me.sam, { manifests }), seed: { users: { [me.sam]: fuser(me, o) }, repos: { [`${o.org}/shop`]: { commits: [C('Initial', me, o, { 'README.md': '# shop\n' })] } }, packages: { [`${o.org}/shop`]: pkg } } }),
      checks: [
        out(`${flag} is off`, kube(`get configmap shop-flags -o jsonpath='{.data.${flag}}'`), { equals: 'off' }),
        out('The pods were restarted with the flag off', kube('logs deployment/shop'), { contains: `feature ${flag} off` }),
        out('The shop serves the classic flow', `export KUBECONFIG=/home/${me.sam}/.kube/config; kubectl port-forward svc/shop 18081:80 >/dev/null; curl -s localhost:18081/`, { contains: 'classic flow' }),
        out(`Still the same image (${ver})`, kube("get deployment shop -o jsonpath='{.spec.template.spec.containers[0].image}'"), { equals: `${remote}:${ver}` }),
        out('All replicas are ready', kube("get deployment shop -o jsonpath='{.status.readyReplicas}'"), { equals: '2' }),
      ],
      solution: [`kubectl patch configmap shop-flags -p '{"data":{"${flag}":"off"}}'`, 'kubectl rollout restart deployment/shop', 'kubectl rollout status deployment/shop', 'kubectl logs deployment/shop', 'kubectl port-forward svc/shop 8080:80', 'curl -s localhost:8080'],
      realityNote: 'Flag services (LaunchDarkly, Unleash, Flagsmith, OpenFeature) let applications re-read flags without even a restart; a ConfigMap plus a rollout restart is the simplest version of the same idea.',
    };
  }),
  tmpl(9, 4, 'advanced', 'blameless-postmortem', 'Run a blameless post-mortem', 'E10', 20, 'Turn an outage into a blameless review: timeline, impact, contributing factors and action items that fix the system.', (v) => {
    const o = v.pick(ORGS);
    const eng = v.person();
    const mins = v.int(35, 90);
    return caseStudy(v, {
      intro: `## The Friday outage\n\n${o.org}'s ${o.what} was down for **${mins} minutes** on Friday evening. ${eng.given}, on call, deployed a configuration change that pointed the app at the wrong database. Monitoring paged ${eng.given} 12 minutes after users started complaining on social media. The rollback took long because nobody remembered the previous version's tag. You lead the post-mortem.`,
      steps: [
        { title: 'The tone', text: 'How do you open the meeting?', choices: [{ text: 'State that the review is blameless: we look for how the system allowed the mistake, assuming everyone acted reasonably with what they knew', right: true, feedback: 'Correct. People only share what really happened when they are not afraid of blame; that is how systems get fixed.' }, { text: `Ask ${eng.given} to explain why they made the mistake`, feedback: 'Focusing on the person makes everyone defensive and hides the system\'s weaknesses.' }, { text: 'Skip the meeting; it was one person\'s error', feedback: 'The same gap will trip the next person.' }] },
        { title: 'The timeline', text: 'What goes into the timeline?', choices: [{ text: 'Timestamped facts from logs, alerts and chat: change deployed, first errors, first user reports, page, diagnosis, rollback, recovery', right: true, feedback: 'Correct. A factual timeline shows where minutes were lost, such as the 12-minute detection gap.' }, { text: 'Each person\'s opinion of what went wrong', feedback: 'Opinions belong in the discussion, built on the factual timeline.' }, { text: 'Only the moment of the fix', feedback: 'Detection and diagnosis time matter as much as the fix.' }] },
        { title: 'Contributing factors', text: 'What were the causes?', choices: [{ text: 'The configuration change had no review or automated check, monitoring detected late, and the previous version was hard to find for rollback', right: true, feedback: 'Correct. Several system gaps lined up; "human error" is where the investigation starts, not where it ends.' }, { text: `${eng.given} was careless`, feedback: 'Blame explains nothing about why the system let a bad change through.' }, { text: 'Bad luck on a Friday', feedback: 'Luck is not actionable; the gaps are.' }] },
        { title: 'Action items', text: 'Which action items will you record?', choices: [{ text: 'Validate configuration in CI and require review; alert on error rate (SLO burn) not just uptime; record each release\'s image tag and practise rollback — each with an owner and a due date', right: true, feedback: 'Correct. Specific, owned, dated items that change the system.' }, { text: '"Be more careful"', feedback: 'Not specific, not measurable, and it changes nothing.' }, { text: 'Ban Friday deployments forever', feedback: 'It hides the gaps instead of fixing them; the next outage happens on a Tuesday.' }] },
        { title: 'Sharing', text: 'Who sees the write-up?', choices: [{ text: 'The whole engineering team (and a summary for stakeholders), and the action items are tracked to completion', right: true, feedback: 'Correct. Shared post-mortems spread the lessons; tracked items make sure they stick.' }, { text: 'Nobody; it is embarrassing', feedback: 'Hidden post-mortems teach nothing.' }, { text: `Only ${eng.given}'s manager`, feedback: 'That turns a learning document into a disciplinary one.' }] },
      ],
      ending: { title: 'Fix the system, not the person', text: 'A blameless tone, a factual timeline, contributing factors in the system, owned and dated action items, and a write-up the whole team learns from.' },
      hints: ['Ask "how did the system let this happen?", not "who did this?".', 'Good action items have an owner and a date.'],
      realityNote: 'Blameless post-mortems are standard at Google, Etsy and most SRE teams; the PagerDuty and Atlassian incident handbooks publish templates for them.',
    });
  }),
];

/** A container record that runs an image's start script on a published port. */
function containerOf(name: string, img: ReturnType<typeof image>, port: number) {
  return { id: (name + 'c0ffee'.repeat(12)).replace(/[^0-9a-f]/g, 'a').slice(0, 64), name, image: `${img.repo}:${img.tag}`, status: 'exited' as const, exitCode: 0, ports: [{ host: port, container: 8080 }], env: {}, mounts: [], restart: 'no', network: 'bridge', logs: [], created: Date.UTC(2026, 9, 20, 7, 0) };
}

export type { Org, Variant };
