/** Unit 9: building and testing a secure application — SDLC and ASVS, testing with ZAP/Burp,
 * triaging a backlog, and a capstone that remediates a vulnerable app and proves the fixes hold. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U9: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 9.1 secure SDLC and ASVS */
  tmpl(9, 1, 'beginner', 'secure-sdlc', 'Build security into the lifecycle', 'E10', 15, 'Place security activities at each stage of the development lifecycle, not just at the end.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Security at every stage\n\n**${a.org}** wants security built into how it builds **${a.host}**, not bolted on at the end. Place the right activity at each stage.`,
      steps: [
        { title: 'Requirements', text: 'What security work belongs at requirements?', choices: [
          { text: 'Define security requirements (e.g. against the ASVS) and abuse cases alongside features', right: true, feedback: 'Correct. Security requirements and abuse cases shape the design.' },
          { text: 'Nothing; security comes later', feedback: 'Leaving it to the end is the costly mistake this avoids.' },
          { text: 'Buy a scanner', feedback: 'Tools come later; requirements come first.' },
        ] },
        { title: 'Design', text: 'What belongs at design?', choices: [
          { text: 'Threat modelling and a design review of trust boundaries and controls', right: true, feedback: 'Correct. Model threats while the design is cheap to change.' },
          { text: 'Penetration testing', feedback: 'Pen testing needs a running system; design review comes first.' },
          { text: 'Writing the user manual', feedback: 'Not a security design activity.' },
        ] },
        { title: 'Implementation and testing', text: 'What security activities run as code is written and tested?', choices: [
          { text: 'Secure coding, code review, SAST/dependency scanning in CI, and security test cases', right: true, feedback: 'Correct. Shift-left testing catches issues early and continuously.' },
          { text: 'Only a final manual pen test', feedback: 'A single late test misses much that CI scanning catches early.' },
          { text: 'Nothing until release', feedback: 'Testing throughout is the point of a secure SDLC.' },
        ] },
        { title: 'Release and operate', text: 'What continues after release?', choices: [
          { text: 'Verification against the ASVS, monitoring, patching and a plan to handle reported vulnerabilities', right: true, feedback: 'Correct. Security is continuous through operations.' },
          { text: 'Security work is finished at release', feedback: 'Operations, patching and response continue for the life of the app.' },
          { text: 'Delete the logs to save space', feedback: 'Logs are needed for detection and response.' },
        ] },
      ],
      ending: { title: 'Shift left, verify continuously', text: 'Security requirements and abuse cases at requirements, threat modelling at design, secure coding and CI scanning during build, and ASVS verification, monitoring and patching in operation.' },
      hints: ['Each stage has its own security activity; do not leave it all to the end.', 'The ASVS gives verifiable requirements to design and test against.'],
      realityNote: 'A secure development lifecycle (Microsoft SDL, OWASP SAMM) spreads security across every stage; the ASVS provides the testable requirements to verify against.',
    });
  }),
  tmpl(9, 1, 'intermediate', 'asvs-level', 'Choose the right ASVS level', 'E1', 20, 'Pick a verification level from the application\'s risk and map requirements to it.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Match rigour to risk\n\nThe ASVS defines verification levels 1 (basic), 2 (standard, for apps handling sensitive data) and 3 (highest, for critical apps). For **${a.host}**, write:\n\n1. \`asvsLevel(app)\`: \`app = { handlesMoney, handlesPersonalData }\`. Return \`3\` if \`handlesMoney\`; else \`2\` if \`handlesPersonalData\`; else \`1\`.\n2. \`requirementApplies(reqLevel, targetLevel)\`: a requirement tagged with \`reqLevel\` applies when \`reqLevel <= targetLevel\`. Return \`true\`/\`false\`.`,
      hints: ['Money → level 3; personal data → level 2; otherwise level 1.', 'Lower-numbered requirements also apply at higher levels.'],
      starter: `// ${a.app}: ASVS level\nfunction asvsLevel(app) {\n}\n\nfunction requirementApplies(reqLevel, targetLevel) {\n}\n`,
      checks: [
        fn('asvsLevel reflects the risk', 'asvsLevel', [
          { args: [{ handlesMoney: true, handlesPersonalData: true }], expected: 3 },
          { args: [{ handlesMoney: false, handlesPersonalData: true }], expected: 2 },
          { args: [{ handlesMoney: false, handlesPersonalData: false }], expected: 1 },
        ]),
        fn('requirementApplies includes lower levels', 'requirementApplies', [
          { args: [1, 2], expected: true }, { args: [2, 2], expected: true }, { args: [3, 2], expected: false },
        ]),
      ],
      solution: `function asvsLevel(app) {\n  if (app.handlesMoney) return 3;\n  if (app.handlesPersonalData) return 2;\n  return 1;\n}\nfunction requirementApplies(reqLevel, targetLevel) {\n  return reqLevel <= targetLevel;\n}`,
      realityNote: 'The OWASP ASVS has three levels; teams choose one from the data and criticality of the app, then verify against the requirements at that level and below.',
    });
  }),
  tmpl(9, 1, 'advanced', 'asvs-coverage', 'Report ASVS verification coverage', 'E1', 25, 'Compute how much of the required ASVS controls a project has verified.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## How far along is verification?\n\nFor **${a.host}** at a target ASVS level, report coverage. Write \`coverage(controls, targetLevel)\` where \`controls\` is an array of \`{ id, level, status }\` (\`status\` is \`"verified"\`, \`"failed"\` or \`"pending"\`):\n\n- consider only controls with \`level <= targetLevel\` (in-scope);\n- return \`{ inScope, verified, failed, pending, percentVerified }\` where \`percentVerified\` is \`verified / inScope\` as a whole-number percentage (0 when \`inScope\` is 0).`,
      hints: ['Filter to in-scope controls first.', 'Count by status, then compute the percentage with Math.round.'],
      starter: `// ${a.app}: ASVS coverage\nfunction coverage(controls, targetLevel) {\n}\n`,
      checks: [
        fn('coverage summarises verification', 'coverage', [
          { args: [[{ id: 'v1', level: 1, status: 'verified' }, { id: 'v2', level: 1, status: 'failed' }, { id: 'v3', level: 2, status: 'pending' }, { id: 'v4', level: 3, status: 'pending' }], 2], expected: { inScope: 3, verified: 1, failed: 1, pending: 1, percentVerified: 33 } },
          { args: [[{ id: 'a', level: 1, status: 'verified' }, { id: 'b', level: 1, status: 'verified' }], 1], expected: { inScope: 2, verified: 2, failed: 0, pending: 0, percentVerified: 100 } },
          { args: [[{ id: 'a', level: 3, status: 'verified' }], 1], expected: { inScope: 0, verified: 0, failed: 0, pending: 0, percentVerified: 0 } },
        ]),
      ],
      solution: `function coverage(controls, targetLevel) {\n  const inScopeControls = controls.filter((c) => c.level <= targetLevel);\n  const inScope = inScopeControls.length;\n  const verified = inScopeControls.filter((c) => c.status === "verified").length;\n  const failed = inScopeControls.filter((c) => c.status === "failed").length;\n  const pending = inScopeControls.filter((c) => c.status === "pending").length;\n  const percentVerified = inScope ? Math.round((verified / inScope) * 100) : 0;\n  return { inScope, verified, failed, pending, percentVerified };\n}`,
      realityNote: 'Tracking ASVS controls as verified/failed/pending gives a concrete, auditable measure of how secure a release is against a recognised standard.',
    });
  }),

  /* ------------------------------------------------------------------ 9.2 testing with ZAP and Burp */
  tmpl(9, 2, 'beginner', 'automated-vs-manual', 'Combine automated and manual testing', 'E10', 15, 'Decide what automated scanning catches and what needs a human tester.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Scanners and humans\n\n**${a.org}** tests **${a.host}** with OWASP ZAP and some manual testing. Decide which finds what.`,
      steps: [
        { title: 'Automated scanning', text: 'What are automated scanners (ZAP, Burp) best at?', choices: [
          { text: 'Breadth: crawling, and finding well-known patterns like reflected XSS, missing headers and known-vulnerable components', right: true, feedback: 'Correct. Scanners cover breadth and known patterns quickly.' },
          { text: 'Understanding business logic flaws', feedback: 'Logic flaws need a human who understands the app.' },
          { text: 'Nothing useful', feedback: 'Scanners are valuable for breadth and regression.' },
        ] },
        { title: 'Manual testing', text: 'What needs a human tester?', choices: [
          { text: 'Business-logic and access-control flaws — e.g. buying at a negative price, or reading another user\'s order', right: true, feedback: 'Correct. Logic and authorisation flaws need human understanding.' },
          { text: 'Counting missing security headers', feedback: 'That is exactly what a scanner automates.' },
          { text: 'Nothing; scanners find everything', feedback: 'Scanners miss logic and context-specific flaws.' },
        ] },
        { title: 'Passive vs active', text: 'Early in testing an in-scope app, which scan mode first?', choices: [
          { text: 'Passive first (observe traffic), then active scanning within scope once the app is understood', right: true, feedback: 'Correct. Passive first; active once scoped and understood.' },
          { text: 'Full active scan on everything immediately', feedback: 'Blind active scanning risks damage and out-of-scope hosts.' },
          { text: 'Never scan', feedback: 'Scanning in scope is a normal, useful activity.' },
        ] },
        { title: 'Triage', text: 'A scan reports 300 alerts. What next?', choices: [
          { text: 'Triage: remove false positives, confirm real issues, and prioritise by risk', right: true, feedback: 'Correct. Raw scanner output must be triaged, not shipped as-is.' },
          { text: 'File all 300 as bugs immediately', feedback: 'Many are false positives or duplicates; triage first.' },
          { text: 'Ignore the report', feedback: 'Triage and act on the real findings.' },
        ] },
      ],
      ending: { title: 'Breadth from tools, depth from people', text: 'Automated scanners give breadth and catch known patterns; humans find logic and access-control flaws; run passive before active, and triage scanner output before acting.' },
      hints: ['Scanners find known patterns and breadth; humans find logic and authorisation flaws.', 'Passive before active, and always triage raw alerts.'],
      realityNote: 'Professional testing combines automated tools (ZAP, Burp) for coverage with manual testing for the logic and access-control flaws scanners cannot understand.',
    });
  }),
  tmpl(9, 2, 'intermediate', 'triage-scanner-alerts', 'Triage raw scanner alerts', 'E1', 25, 'Deduplicate and filter scanner alerts down to real, actionable findings.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## From 300 alerts to a real list\n\nFor **${a.host}**, triage ZAP output. Alerts are \`{ rule, url, confidence, falsePositive }\`. Write:\n\n1. \`keep(alert)\`: return \`true\` only when \`alert.falsePositive !== true\` and \`alert.confidence\` is \`"medium"\` or \`"high"\` (drop \`"low"\`/\`"informational"\`).\n2. \`dedupeKey(alert)\`: return \`alert.rule + "|" + alert.url\`.\n3. \`triage(alerts)\`: keep the ones \`keep\` accepts, deduplicate by \`dedupeKey\` (first occurrence wins), and return the kept alerts in original order.`,
      hints: ['Filter first, then dedupe with a seen-set of keys.', 'Keep the first occurrence of each rule+url.'],
      starter: `// ${a.app}: triage scanner alerts\nfunction keep(alert) {\n}\n\nfunction dedupeKey(alert) {\n}\n\nfunction triage(alerts) {\n}\n`,
      checks: [
        fn('keep filters low-value alerts', 'keep', [
          { args: [{ rule: 'xss', url: '/a', confidence: 'high', falsePositive: false }], expected: true },
          { args: [{ rule: 'xss', url: '/a', confidence: 'low', falsePositive: false }], expected: false },
          { args: [{ rule: 'xss', url: '/a', confidence: 'high', falsePositive: true }], expected: false },
        ]),
        fn('dedupeKey combines rule and url', 'dedupeKey', [
          { args: [{ rule: 'xss', url: '/a' }], expected: 'xss|/a' },
        ]),
        fn('triage filters and deduplicates', 'triage', [
          { args: [[{ rule: 'xss', url: '/a', confidence: 'high', falsePositive: false }, { rule: 'xss', url: '/a', confidence: 'medium', falsePositive: false }, { rule: 'hdr', url: '/a', confidence: 'low', falsePositive: false }]], expected: [{ rule: 'xss', url: '/a', confidence: 'high', falsePositive: false }] },
        ]),
      ],
      solution: `function keep(alert) {\n  return alert.falsePositive !== true && (alert.confidence === "medium" || alert.confidence === "high");\n}\nfunction dedupeKey(alert) {\n  return alert.rule + "|" + alert.url;\n}\nfunction triage(alerts) {\n  const seen = new Set();\n  const out = [];\n  for (const alert of alerts) {\n    if (!keep(alert)) continue;\n    const key = dedupeKey(alert);\n    if (seen.has(key)) continue;\n    seen.add(key);\n    out.push(alert);\n  }\n  return out;\n}`,
      realityNote: 'Turning raw scanner output into a short list of confirmed, deduplicated findings is most of the work in using tools like ZAP and Burp effectively.',
    });
  }),
  tmpl(9, 2, 'advanced', 'regression-suite', 'Keep fixed bugs fixed with security tests', 'E1', 25, 'Build a regression check that fails if a previously-fixed vulnerability reappears.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Never regress a security fix\n\nFor **${a.host}**, each fixed vulnerability gets a test that must keep passing. Write \`runSecurityTests(tests, app)\` where each test is \`{ id, probe, expected }\` and \`app\` maps a \`probe\` string to the app\'s current response. A test **passes** when \`app[test.probe] === test.expected\`. Return \`{ passed, failed }\` where \`failed\` is a sorted array of the ids of tests that did not pass (including probes missing from \`app\`, which count as failures).\n\nAlso \`allGreen(result)\`: return \`true\` when \`result.failed.length === 0\`.`,
      hints: ['A probe missing from app is a failure (undefined !== expected).', 'Collect failing ids, sort them, count the rest as passed.'],
      starter: `// ${a.app}: security regression suite\nfunction runSecurityTests(tests, app) {\n}\n\nfunction allGreen(result) {\n}\n`,
      checks: [
        fn('runSecurityTests reports pass/fail', 'runSecurityTests', [
          { args: [[{ id: 't1', probe: 'xss', expected: 'encoded' }, { id: 't2', probe: 'idor', expected: '403' }], { xss: 'encoded', idor: '403' }], expected: { passed: 2, failed: [] } },
          { args: [[{ id: 't1', probe: 'xss', expected: 'encoded' }, { id: 't2', probe: 'idor', expected: '403' }], { xss: 'raw', idor: '403' }], expected: { passed: 1, failed: ['t1'] } },
          { args: [[{ id: 't1', probe: 'missing', expected: 'x' }], {}], expected: { passed: 0, failed: ['t1'] } },
        ]),
        fn('allGreen checks nothing failed', 'allGreen', [
          { args: [{ passed: 2, failed: [] }], expected: true },
          { args: [{ passed: 1, failed: ['t1'] }], expected: false },
        ]),
      ],
      solution: `function runSecurityTests(tests, app) {\n  const failed = [];\n  let passed = 0;\n  for (const test of tests) {\n    if (app[test.probe] === test.expected) passed++;\n    else failed.push(test.id);\n  }\n  return { passed, failed: failed.sort() };\n}\nfunction allGreen(result) {\n  return result.failed.length === 0;\n}`,
      realityNote: 'Turning each fixed vulnerability into an automated regression test (in CI) is how teams make sure a security fix is never silently undone by a later change.',
    });
  }),

  /* ------------------------------------------------------------------ 9.3 triaging a backlog */
  tmpl(9, 3, 'beginner', 'triage-backlog', 'Triage a findings backlog for a small team', 'E10', 20, 'Order a backlog of findings by risk and effort for a team with limited time.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Limited hands, many findings\n\n**${a.org}** has a backlog of security findings for **${a.host}** and a small team. Decide how to work through it.`,
      steps: [
        { title: 'First priority', text: 'What do you fix first?', choices: [
          { text: 'High-impact, actively exploitable issues (e.g. a live SQL injection or auth bypass), regardless of effort', right: true, feedback: 'Correct. Critical, exploitable issues come first.' },
          { text: 'The easiest cosmetic issues, to clear the count', feedback: 'Clearing easy low-risk items first leaves critical risk live.' },
          { text: 'Whatever was reported most recently', feedback: 'Recency is not risk.' },
        ] },
        { title: 'Quick wins', text: 'After the criticals, how do effort and impact combine?', choices: [
          { text: 'Prefer high-impact, low-effort fixes next (best risk reduced per hour)', right: true, feedback: 'Correct. Maximise risk reduced per unit of effort.' },
          { text: 'Always do the highest-effort items next', feedback: 'That spends the team on few fixes; favour quick high-impact wins.' },
          { text: 'Ignore effort entirely', feedback: 'With a small team, effort matters for throughput.' },
        ] },
        { title: 'Systemic issues', text: 'Several findings share one root cause (missing output encoding). What do you do?', choices: [
          { text: 'Fix the root cause once (central encoding) to close the whole class', right: true, feedback: 'Correct. A systemic fix closes many findings at once.' },
          { text: 'Patch each instance separately forever', feedback: 'A central fix is cheaper and more durable.' },
          { text: 'Close them as duplicates without fixing', feedback: 'They are real; fix the shared cause.' },
        ] },
        { title: 'Accepting risk', text: 'A low-risk finding would take weeks to fix. What is reasonable?', choices: [
          { text: 'Document a risk acceptance with a rationale and a revisit date, and move on', right: true, feedback: 'Correct. Low risk can be accepted explicitly and revisited.' },
          { text: 'Block all other work until it is fixed', feedback: 'Disproportionate for a low-risk item.' },
          { text: 'Delete the finding so it is not tracked', feedback: 'Accept it explicitly; do not hide it.' },
        ] },
      ],
      ending: { title: 'Risk first, then value per hour', text: 'Fix critical exploitable issues first, then high-impact low-effort wins, fix systemic root causes once, and explicitly accept and revisit genuinely low risk.' },
      hints: ['Criticals first; then maximise risk reduced per hour.', 'Fix shared root causes once; accept low risk explicitly.'],
      realityNote: 'Resource-constrained teams succeed by triaging on risk and effort and fixing systemic causes once, rather than treating every finding as equal.',
    });
  }),
  tmpl(9, 3, 'intermediate', 'backlog-order', 'Order the backlog by risk per effort', 'E1', 25, 'Sort findings so the most risk reduced per hour comes first, criticals always on top.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Best value first\n\nFor **${a.host}**, order the backlog. Each finding is \`{ id, severity, effortHours, exploited }\`. Write:\n\n1. \`weight(severity)\`: low 1, medium 3, high 7, critical 15; unknown 0.\n2. \`valuePerHour(finding)\`: \`weight(severity) / effortHours\` (effortHours >= 1), rounded to 2 decimals.\n3. \`order(findings)\`: return the \`id\`s sorted so that **actively exploited** findings come first (any \`exploited === true\` before the rest), then by \`valuePerHour\` descending, ties by \`id\` ascending.`,
      hints: ['Exploited findings sort ahead of all others.', 'Within each group, higher value-per-hour first, then id.'],
      starter: `// ${a.app}: order the backlog\nfunction weight(severity) {\n}\n\nfunction valuePerHour(finding) {\n}\n\nfunction order(findings) {\n}\n`,
      checks: [
        fn('weight maps severity', 'weight', [
          { args: ['critical'], expected: 15 }, { args: ['low'], expected: 1 }, { args: ['none'], expected: 0 },
        ]),
        fn('valuePerHour divides weight by effort', 'valuePerHour', [
          { args: [{ severity: 'high', effortHours: 2 }], expected: 3.5 },
          { args: [{ severity: 'critical', effortHours: 15 }], expected: 1 },
        ]),
        fn('order puts exploited first then value', 'order', [
          { args: [[{ id: 'a', severity: 'low', effortHours: 1, exploited: false }, { id: 'b', severity: 'critical', effortHours: 10, exploited: true }, { id: 'c', severity: 'high', effortHours: 1, exploited: false }]], expected: ['b', 'c', 'a'] },
          { args: [[{ id: 'x', severity: 'high', effortHours: 7, exploited: false }, { id: 'y', severity: 'high', effortHours: 7, exploited: false }]], expected: ['x', 'y'] },
        ]),
      ],
      solution: `function weight(severity) {\n  return { low: 1, medium: 3, high: 7, critical: 15 }[severity] || 0;\n}\nfunction valuePerHour(finding) {\n  const hours = Math.max(1, finding.effortHours);\n  return Math.round((weight(finding.severity) / hours) * 100) / 100;\n}\nfunction order(findings) {\n  return [...findings]\n    .sort((a, b) =>\n      (b.exploited === true) - (a.exploited === true) ||\n      valuePerHour(b) - valuePerHour(a) ||\n      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),\n    )\n    .map((f) => f.id);\n}`,
      realityNote: 'Backlog ordering in practice is risk-weighted value per effort, with anything under active exploitation jumping the queue.',
    });
  }),
  tmpl(9, 3, 'advanced', 'root-cause-cluster', 'Cluster findings by root cause', 'E1', 25, 'Group findings so a single systemic fix can close many at once.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Fix the cause, not each symptom\n\nFor **${a.host}**, group findings by root cause so one fix closes a whole cluster. Write:\n\n1. \`clusterByCause(findings)\`: \`findings\` is an array of \`{ id, cause }\`. Return an object mapping each \`cause\` to a **sorted array** of the \`id\`s with that cause.\n2. \`biggestCluster(findings)\`: return the cause with the most findings (ties broken by cause name ascending), or \`null\` for an empty array.`,
      hints: ['Build the groups, then sort ids within each.', 'For the biggest, compare counts, then cause name.'],
      starter: `// ${a.app}: cluster by root cause\nfunction clusterByCause(findings) {\n}\n\nfunction biggestCluster(findings) {\n}\n`,
      checks: [
        fn('clusterByCause groups ids', 'clusterByCause', [
          { args: [[{ id: 'a', cause: 'no-encoding' }, { id: 'c', cause: 'no-encoding' }, { id: 'b', cause: 'no-authz' }]], expected: { 'no-encoding': ['a', 'c'], 'no-authz': ['b'] } },
          { args: [[]], expected: {} },
        ]),
        fn('biggestCluster finds the top cause', 'biggestCluster', [
          { args: [[{ id: 'a', cause: 'no-encoding' }, { id: 'c', cause: 'no-encoding' }, { id: 'b', cause: 'no-authz' }]], expected: 'no-encoding' },
          { args: [[{ id: 'a', cause: 'x' }, { id: 'b', cause: 'y' }]], expected: 'x' },
          { args: [[]], expected: null },
        ]),
      ],
      solution: `function clusterByCause(findings) {\n  const out = {};\n  for (const f of findings) (out[f.cause] = out[f.cause] || []).push(f.id);\n  for (const cause of Object.keys(out)) out[cause].sort();\n  return out;\n}\nfunction biggestCluster(findings) {\n  const groups = clusterByCause(findings);\n  const causes = Object.keys(groups);\n  if (!causes.length) return null;\n  return causes.sort((a, b) => groups[b].length - groups[a].length || (a < b ? -1 : 1))[0];\n}`,
      realityNote: 'Grouping findings by root cause turns a long list into a few systemic fixes — central output encoding, one authorisation layer — that each close many findings.',
    });
  }),

  /* ------------------------------------------------------------------ 9.4 capstone: remediate and prove */
  tmpl(9, 4, 'beginner', 'capstone-remediate', 'Capstone: remediate a vulnerable application', 'E1', 30, 'Apply the right fix to each vulnerability class and confirm the control is in place.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Map each flaw to its fix\n\nThe capstone for **${a.host}** is to remediate a vulnerable app. Write \`remediation(finding)\` mapping a vulnerability class to its primary fix:\n\n- \`"sql-injection"\` → \`"parameterised-queries"\`;\n- \`"xss"\` → \`"output-encoding"\`;\n- \`"idor"\` → \`"server-side-authorisation"\`;\n- \`"ssrf"\` → \`"egress-allow-list"\`;\n- \`"weak-session"\` → \`"secure-cookies-and-rotation"\`;\n- anything else → \`"manual-review"\`.\n\nAlso \`remediationPlan(findings)\`: return an array of \`{ id, fix }\` applying \`remediation\` to each finding\'s \`class\`.`,
      hints: ['A simple mapping with a default of manual-review.', 'remediationPlan maps each finding to its fix.'],
      starter: `// ${a.app}: remediation mapping\nfunction remediation(finding) {\n}\n\nfunction remediationPlan(findings) {\n}\n`,
      checks: [
        fn('remediation maps class to fix', 'remediation', [
          { args: ['sql-injection'], expected: 'parameterised-queries' },
          { args: ['xss'], expected: 'output-encoding' },
          { args: ['idor'], expected: 'server-side-authorisation' },
          { args: ['ssrf'], expected: 'egress-allow-list' },
          { args: ['weak-session'], expected: 'secure-cookies-and-rotation' },
          { args: ['mystery'], expected: 'manual-review' },
        ]),
        fn('remediationPlan plans every finding', 'remediationPlan', [
          { args: [[{ id: 'f1', class: 'xss' }, { id: 'f2', class: 'idor' }]], expected: [{ id: 'f1', fix: 'output-encoding' }, { id: 'f2', fix: 'server-side-authorisation' }] },
        ]),
      ],
      solution: `function remediation(finding) {\n  const map = {\n    "sql-injection": "parameterised-queries",\n    "xss": "output-encoding",\n    "idor": "server-side-authorisation",\n    "ssrf": "egress-allow-list",\n    "weak-session": "secure-cookies-and-rotation",\n  };\n  return map[finding] || "manual-review";\n}\nfunction remediationPlan(findings) {\n  return findings.map((f) => ({ id: f.id, fix: remediation(f.class) }));\n}`,
      realityNote: 'Each vulnerability class has a primary, well-known fix; a remediation plan maps findings to those fixes so nothing is addressed with the wrong control.',
    });
  }),
  tmpl(9, 4, 'intermediate', 'capstone-prove-fixes', 'Capstone: prove the fixes hold', 'E1', 30, 'Re-test each remediated finding and only close it when the control is verified.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A fix is not done until it is proven\n\nFor the **${a.host}** capstone, verify each remediation. A finding is \`{ id, retest }\` where \`retest\` is \`"blocked"\` (the attack now fails — good), \`"succeeded"\` (still works — not fixed), or \`"not-tested"\`. Write:\n\n1. \`status(finding)\`: \`"blocked"\` → \`"closed"\`; \`"succeeded"\` → \`"reopen"\`; \`"not-tested"\` → \`"pending-verification"\`.\n2. \`report(findings)\`: return \`{ closed, reopen, pending }\` counts, and \`done\` = \`true\` only when every finding is \`"closed"\`.`,
      hints: ['Map the retest result to a status.', 'done is true only when all are closed.'],
      starter: `// ${a.app}: prove the fixes\nfunction status(finding) {\n}\n\nfunction report(findings) {\n}\n`,
      checks: [
        fn('status reflects the retest', 'status', [
          { args: [{ id: 'f1', retest: 'blocked' }], expected: 'closed' },
          { args: [{ id: 'f2', retest: 'succeeded' }], expected: 'reopen' },
          { args: [{ id: 'f3', retest: 'not-tested' }], expected: 'pending-verification' },
        ]),
        fn('report summarises and decides done', 'report', [
          { args: [[{ id: 'f1', retest: 'blocked' }, { id: 'f2', retest: 'blocked' }]], expected: { closed: 2, reopen: 0, pending: 0, done: true } },
          { args: [[{ id: 'f1', retest: 'blocked' }, { id: 'f2', retest: 'succeeded' }, { id: 'f3', retest: 'not-tested' }]], expected: { closed: 1, reopen: 1, pending: 1, done: false } },
        ]),
      ],
      solution: `function status(finding) {\n  if (finding.retest === "blocked") return "closed";\n  if (finding.retest === "succeeded") return "reopen";\n  return "pending-verification";\n}\nfunction report(findings) {\n  let closed = 0, reopen = 0, pending = 0;\n  for (const f of findings) {\n    const s = status(f);\n    if (s === "closed") closed++;\n    else if (s === "reopen") reopen++;\n    else pending++;\n  }\n  return { closed, reopen, pending, done: reopen === 0 && pending === 0 };\n}`,
      realityNote: 'Remediation is only complete when a retest confirms the attack now fails; "we fixed it" without a passing retest is how reopened findings happen.',
    });
  }),
  tmpl(9, 4, 'advanced', 'capstone-release-gate', 'Capstone: gate the release on security', 'E1', 30, 'Decide whether a release may ship from its open findings, ASVS coverage and regression results.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The security release gate\n\nFor the **${a.host}** capstone, decide if the release ships. Write \`releaseGate(state)\` where \`state = { openCritical, openHigh, asvsPercent, regressionsPassing, totalRegressions }\`:\n\n- block with reason \`"critical-open"\` if \`openCritical > 0\`;\n- block with \`"high-open"\` if \`openHigh > 2\` (a few lows/mediums may be accepted, but not many highs);\n- block with \`"asvs-coverage"\` if \`asvsPercent < 80\`;\n- block with \`"regressions-failing"\` if \`regressionsPassing < totalRegressions\`;\n- otherwise \`{ ship: true }\`. Blocks return \`{ ship: false, reason }\`. Check in that order.`,
      hints: ['Evaluate the four gates in order and return the first block.', 'All regression tests must pass to ship.'],
      starter: `// ${a.app}: release gate\nfunction releaseGate(state) {\n}\n`,
      checks: [
        fn('releaseGate decides shipping', 'releaseGate', [
          { args: [{ openCritical: 0, openHigh: 1, asvsPercent: 90, regressionsPassing: 10, totalRegressions: 10 }], expected: { ship: true } },
          { args: [{ openCritical: 1, openHigh: 0, asvsPercent: 100, regressionsPassing: 10, totalRegressions: 10 }], expected: { ship: false, reason: 'critical-open' } },
          { args: [{ openCritical: 0, openHigh: 5, asvsPercent: 100, regressionsPassing: 10, totalRegressions: 10 }], expected: { ship: false, reason: 'high-open' } },
          { args: [{ openCritical: 0, openHigh: 0, asvsPercent: 70, regressionsPassing: 10, totalRegressions: 10 }], expected: { ship: false, reason: 'asvs-coverage' } },
          { args: [{ openCritical: 0, openHigh: 0, asvsPercent: 90, regressionsPassing: 9, totalRegressions: 10 }], expected: { ship: false, reason: 'regressions-failing' } },
        ]),
      ],
      solution: `function releaseGate(state) {\n  if (state.openCritical > 0) return { ship: false, reason: "critical-open" };\n  if (state.openHigh > 2) return { ship: false, reason: "high-open" };\n  if (state.asvsPercent < 80) return { ship: false, reason: "asvs-coverage" };\n  if (state.regressionsPassing < state.totalRegressions) return { ship: false, reason: "regressions-failing" };\n  return { ship: true };\n}`,
      realityNote: 'A security release gate turns "is it secure enough to ship?" into explicit, automatable criteria: no open criticals, limited highs, ASVS coverage met, and all security regressions passing.',
    });
  }),
];
