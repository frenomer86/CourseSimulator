/** Unit 2: how web applications are attacked, read defensively — the OWASP Top Ten as a map,
 * tainted data, threat modelling, the economics of attacks, and safe error and timing behaviour. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U2: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 2.1 OWASP Top Ten as a map */
  tmpl(2, 1, 'beginner', 'owasp-map', 'Use the OWASP Top Ten as a map', 'E10', 15, 'Place findings against the OWASP Top Ten categories and use them to prioritise, not as a checklist.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## A shared map of risk\n\nYour team reviews **${a.org}** (${a.host}). You use the OWASP Top Ten as a shared map of common web risks. Decide how to use it well.`,
      steps: [
        { title: 'What it is', text: 'What does the OWASP Top Ten represent?', choices: [
          { text: 'A broad awareness list of the most common and impactful web risk categories', right: true, feedback: 'Correct. It is a prioritised map, not an exhaustive standard.' },
          { text: 'A complete checklist that guarantees security if ticked off', feedback: 'Passing the Top Ten does not mean an app is secure; it is awareness, not assurance.' },
          { text: 'A list of specific products to buy', feedback: 'It is vendor-neutral risk categories, not products.' },
        ] },
        { title: 'Categorising a finding', text: 'You find an endpoint that returns another user\'s record by changing an id. Which category?', choices: [
          { text: 'Broken Access Control', right: true, feedback: 'Correct. Reading another user\'s data by changing an identifier is broken access control.' },
          { text: 'Cryptographic Failures', feedback: 'No cryptography is involved; it is an authorisation gap.' },
          { text: 'Security Logging Failures', feedback: 'Logging is separate; the core issue is missing authorisation.' },
        ] },
        { title: 'Using it to prioritise', text: 'You have twenty findings and little time. How does the map help?', choices: [
          { text: 'Group findings by category and impact to fix the highest-risk classes first', right: true, feedback: 'Correct. Categories plus impact drive triage.' },
          { text: 'Fix them in the order they were found', feedback: 'Order of discovery is not order of risk.' },
          { text: 'Only fix items that appear in the Top Ten and ignore the rest', feedback: 'The list is not exhaustive; real risks outside it still matter.' },
        ] },
        { title: 'For assurance', text: 'Management asks for deeper assurance than an awareness list. What do you point to?', choices: [
          { text: 'A verification standard such as the OWASP ASVS, used as testable requirements', right: true, feedback: 'Correct. ASVS gives detailed, testable security requirements.' },
          { text: 'The Top Ten again, in more detail', feedback: 'The Top Ten is awareness; ASVS is the verification standard.' },
          { text: 'A longer penetration-test report with no standard behind it', feedback: 'A standard like ASVS gives repeatable, comparable coverage.' },
        ] },
      ],
      ending: { title: 'A map for triage, not a guarantee', text: 'The Top Ten is a shared awareness map that helps categorise and prioritise risk; for testable assurance you move to a standard such as the ASVS.' },
      hints: ['The Top Ten raises awareness and helps triage; it does not certify security.', 'For detailed, testable requirements, reach for the ASVS.'],
      realityNote: 'The OWASP Top Ten (latest 2021, with 2025 in progress) is the best-known web risk list; the ASVS is its testable counterpart used for verification.',
    });
  }),
  tmpl(2, 1, 'intermediate', 'risk-rank', 'Rank findings by likelihood and impact', 'E1', 20, 'Compute a simple risk score from likelihood and impact to order a remediation backlog.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Order the work by risk\n\nFor **${a.host}**, score each finding so the team fixes the riskiest first.\n\n1. \`riskScore(likelihood, impact)\`: both are integers 1–5. Return \`likelihood * impact\`. If either is outside 1–5, return \`null\`.\n2. \`rank(findings)\`: \`findings\` is an array of \`{ id, likelihood, impact }\`. Return an array of their \`id\`s sorted by risk score **descending**; break ties by \`id\` ascending (string compare). Skip findings whose score is null.`,
      hints: ['Validate the 1..5 range before multiplying.', 'Sort by score desc, then id asc: b.score - a.score || (a.id < b.id ? -1 : 1).'],
      starter: `// ${a.app}: risk ordering\nfunction riskScore(likelihood, impact) {\n}\n\nfunction rank(findings) {\n}\n`,
      checks: [
        fn('riskScore multiplies within range', 'riskScore', [
          { args: [5, 4], expected: 20 }, { args: [1, 1], expected: 1 }, { args: [0, 3], expected: null }, { args: [3, 6], expected: null },
        ]),
        fn('rank orders by risk then id', 'rank', [
          { args: [[{ id: 'B', likelihood: 2, impact: 3 }, { id: 'A', likelihood: 5, impact: 5 }, { id: 'C', likelihood: 4, impact: 1 }]], expected: ['A', 'B', 'C'] },
          { args: [[{ id: 'Y', likelihood: 3, impact: 3 }, { id: 'X', likelihood: 3, impact: 3 }]], expected: ['X', 'Y'] },
          { args: [[{ id: 'Z', likelihood: 9, impact: 1 }, { id: 'A', likelihood: 1, impact: 1 }]], expected: ['A'] },
        ]),
      ],
      solution: `function riskScore(likelihood, impact) {\n  if (likelihood < 1 || likelihood > 5 || impact < 1 || impact > 5) return null;\n  return likelihood * impact;\n}\nfunction rank(findings) {\n  return findings\n    .map((f) => ({ id: f.id, score: riskScore(f.likelihood, f.impact) }))\n    .filter((f) => f.score !== null)\n    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))\n    .map((f) => f.id);\n}`,
      realityNote: 'Likelihood × impact is the simplest risk matrix; richer schemes such as CVSS and OWASP Risk Rating refine it, but the triage idea is the same.',
    });
  }),
  tmpl(2, 1, 'advanced', 'map-finding-to-category', 'Route each finding to its category and owner', 'E1', 25, 'Classify findings by signature into OWASP categories so they reach the right fix.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## From symptom to category\n\nFor **${a.host}**, route each finding to an OWASP-style category by its signature. Write \`categorise(finding)\` where \`finding = { evidence }\` (a short string). Return the category:\n\n- contains \`"id="\` or \`"IDOR"\` or \`"other user"\` → \`"access-control"\`;\n- contains \`"<script"\` or \`"onerror"\` → \`"xss"\`;\n- contains \`"' OR"\` or \`"UNION SELECT"\` or \`"sqlstate"\` (case-insensitive) → \`"injection"\`;\n- contains \`"http://"\` where the app should use TLS, i.e. the evidence contains \`"no tls"\` or \`"plaintext"\` → \`"crypto-failure"\`;\n- otherwise \`"needs-review"\`. Check in the order listed.`,
      hints: ['Lower-case the evidence once, then test substrings in order.', 'Return on the first matching rule so order matters.'],
      starter: `// ${a.app}: categorise findings\nfunction categorise(finding) {\n}\n`,
      checks: [
        fn('categorise routes by signature', 'categorise', [
          { args: [{ evidence: 'changed id=42 to read other user record' }], expected: 'access-control' },
          { args: [{ evidence: 'reflected <script>alert(1)</script>' }], expected: 'xss' },
          { args: [{ evidence: "payload ' OR '1'='1 bypassed login" }], expected: 'injection' },
          { args: [{ evidence: 'UNION SELECT from users' }], expected: 'injection' },
          { args: [{ evidence: 'login form posts over plaintext, no TLS' }], expected: 'crypto-failure' },
          { args: [{ evidence: 'slow page under load' }], expected: 'needs-review' },
        ]),
      ],
      solution: `function categorise(finding) {\n  const e = finding.evidence.toLowerCase();\n  if (e.includes("id=") || e.includes("idor") || e.includes("other user")) return "access-control";\n  if (e.includes("<script") || e.includes("onerror")) return "xss";\n  if (e.includes("' or") || e.includes("union select") || e.includes("sqlstate")) return "injection";\n  if (e.includes("no tls") || e.includes("plaintext")) return "crypto-failure";\n  return "needs-review";\n}`,
      realityNote: 'Triage tooling classifies findings by signatures like these so each reaches the team and fix pattern that owns it.',
    });
  }),

  /* ------------------------------------------------------------------ 2.2 trust and tainted data */
  tmpl(2, 2, 'beginner', 'taint-check', 'Treat all client input as tainted', 'E1', 20, 'Validate a numeric id from the client before using it, rejecting anything non-numeric.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Tainted until proven clean\n\nOn **${a.host}**, a record id arrives as a string from the client. Never use it until it is validated.\n\n1. \`cleanId(raw)\`: return the number only if \`raw\` is a string of **digits** representing an integer from 1 to 1,000,000. Otherwise return \`null\` (reject). Reject \`"07"\`-style leading zeros, empty strings, signs and decimals.\n2. \`safeLookup(raw, records)\`: use \`cleanId\`; if null, return \`{ error: "bad id" }\`; otherwise return \`records[id] ?? { error: "not found" }\`.`,
      hints: ['Validate with /^[1-9][0-9]*$/ then range-check the Number.', 'Only touch the records object after the id is clean.'],
      starter: `// ${a.app}: validate before use\nfunction cleanId(raw) {\n}\n\nfunction safeLookup(raw, records) {\n}\n`,
      checks: [
        fn('cleanId accepts only valid ids', 'cleanId', [
          { args: ['42'], expected: 42 }, { args: ['1'], expected: 1 }, { args: ['07'], expected: null },
          { args: ['-5'], expected: null }, { args: ['3.5'], expected: null }, { args: [''], expected: null }, { args: ['2000000'], expected: null },
        ]),
        fn('safeLookup guards the lookup', 'safeLookup', [
          { args: ['2', { 2: { name: 'Ama' } }], expected: { name: 'Ama' } },
          { args: ['bad', { 2: { name: 'Ama' } }], expected: { error: 'bad id' } },
          { args: ['9', { 2: { name: 'Ama' } }], expected: { error: 'not found' } },
        ]),
      ],
      solution: `function cleanId(raw) {\n  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;\n  const n = Number(raw);\n  return n >= 1 && n <= 1000000 ? n : null;\n}\nfunction safeLookup(raw, records) {\n  const id = cleanId(raw);\n  if (id === null) return { error: "bad id" };\n  return records[id] ?? { error: "not found" };\n}`,
      realityNote: 'Taint tracking — treating every input as dangerous until validated — is the mental model behind most injection and access-control defences.',
    });
  }),
  tmpl(2, 2, 'intermediate', 'allow-list-fields', 'Accept only the fields you expect', 'E1', 20, 'Build an update object from only the allowed fields, dropping anything extra the client sent.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Mass assignment: take only what you allow\n\nOn **${a.host}**, a profile update accepts \`name\` and \`phone\` only. An attacker also sends \`role: "admin"\` and \`balance: 9999\`. Build the update from an allow-list.\n\n\`pickAllowed(input, allowed)\`: return a new object containing only the keys in the \`allowed\` array that are present in \`input\`, with their values. Never copy keys that are not allowed.`,
      hints: ['Iterate the allowed array, not the input keys.', 'Use Object.prototype.hasOwnProperty.call(input, key) to test presence.'],
      starter: `// ${a.app}: allow-list fields\nfunction pickAllowed(input, allowed) {\n}\n`,
      checks: [
        fn('pickAllowed copies only allowed keys', 'pickAllowed', [
          { args: [{ name: 'Ama', phone: '024', role: 'admin', balance: 9999 }, ['name', 'phone']], expected: { name: 'Ama', phone: '024' } },
          { args: [{ name: 'Kofi' }, ['name', 'phone']], expected: { name: 'Kofi' } },
          { args: [{ role: 'admin' }, ['name', 'phone']], expected: {} },
        ]),
      ],
      solution: `function pickAllowed(input, allowed) {\n  const out = {};\n  for (const key of allowed) {\n    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];\n  }\n  return out;\n}`,
      realityNote: 'Mass-assignment (or "autobinding") bugs let users set fields like role or balance by adding them to a request; an explicit allow-list is the fix.',
    });
  }),
  tmpl(2, 2, 'advanced', 'validate-schema', 'Validate a request against a schema', 'E1', 30, 'Check required types and ranges, returning all the reasons a request is rejected.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Validate the whole shape\n\nFor a top-up request on **${a.host}**, validate every field and return **all** problems.\n\n\`validate(req)\` where a valid \`req\` is \`{ msisdn, amount, note }\`:\n\n- \`msisdn\`: a string of exactly 10 digits — else push \`"msisdn"\`;\n- \`amount\`: a number (not a string) that is an integer from 1 to 5000 — else push \`"amount"\`;\n- \`note\`: optional; if present it must be a string of at most 50 characters — else push \`"note"\`.\n\nReturn \`{ ok: true }\` if there are no problems, otherwise \`{ ok: false, problems }\` with the problems in the order listed above.`,
      hints: ['Build a problems array in field order; ok is problems.length === 0.', 'Treat note as valid when it is undefined; only validate it when present.'],
      starter: `// ${a.app}: schema validation\nfunction validate(req) {\n}\n`,
      checks: [
        fn('validate accepts a good request', 'validate', [
          { args: [{ msisdn: '0241234567', amount: 100, note: 'rent' }], expected: { ok: true } },
          { args: [{ msisdn: '0241234567', amount: 100 }], expected: { ok: true } },
        ]),
        fn('validate reports every problem', 'validate', [
          { args: [{ msisdn: '12', amount: '100', note: 5 }], expected: { ok: false, problems: ['msisdn', 'amount', 'note'] } },
          { args: [{ msisdn: '0241234567', amount: 99999 }], expected: { ok: false, problems: ['amount'] } },
          { args: [{ msisdn: '0241234567', amount: 10, note: 'x'.repeat(51) }], expected: { ok: false, problems: ['note'] } },
        ]),
      ],
      solution: `function validate(req) {\n  const problems = [];\n  if (typeof req.msisdn !== "string" || !/^[0-9]{10}$/.test(req.msisdn)) problems.push("msisdn");\n  if (typeof req.amount !== "number" || !Number.isInteger(req.amount) || req.amount < 1 || req.amount > 5000) problems.push("amount");\n  if (req.note !== undefined && (typeof req.note !== "string" || req.note.length > 50)) problems.push("note");\n  return problems.length ? { ok: false, problems } : { ok: true };\n}`,
      realityNote: 'Server-side schema validation (with libraries such as Zod, Joi or JSON Schema) is the first gate every request should pass; it rejects malformed input before any logic runs.',
    });
  }),

  /* ------------------------------------------------------------------ 2.3 threat modelling a feature */
  tmpl(2, 3, 'beginner', 'threat-model-topup', 'Threat model a top-up form', 'E10', 20, 'Walk a mobile-money top-up feature through STRIDE-style questions and pick the right control.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Think like an attacker, build like a defender\n\n**${a.org}** is adding a top-up form where a user adds money to a wallet. Threat model it before building.`,
      steps: [
        { title: 'Spoofing', text: 'How do you know the request is really from the account owner?', choices: [
          { text: 'Require an authenticated session and re-check the user server-side; never trust a user id in the request body', right: true, feedback: 'Correct. Identity comes from the session, verified on the server.' },
          { text: 'Trust the userId field the form submits', feedback: 'An attacker sets that field to anyone.' },
          { text: 'Check the browser\'s User-Agent', feedback: 'User-Agent is attacker-controlled and proves nothing.' },
        ] },
        { title: 'Tampering', text: 'The form submits the amount and a computed fee. What must the server do?', choices: [
          { text: 'Recompute the fee server-side and validate the amount; ignore any client-sent fee or total', right: true, feedback: 'Correct. The server owns all money calculations.' },
          { text: 'Trust the fee the client computed to save work', feedback: 'The client can set the fee to zero.' },
          { text: 'Validate the amount but trust the fee', feedback: 'Any money value from the client must be recomputed.' },
        ] },
        { title: 'Repudiation', text: 'A user later denies making a top-up. What protects both sides?', choices: [
          { text: 'An append-only audit log of who did what, when, with a server-generated transaction id', right: true, feedback: 'Correct. Tamper-evident logs give accountability.' },
          { text: 'Nothing; trust the user', feedback: 'Without logs you cannot resolve disputes.' },
          { text: 'A client-side log in the browser', feedback: 'Client logs are not trustworthy evidence.' },
        ] },
        { title: 'Denial of service', text: 'An attacker scripts thousands of tiny top-up attempts. What limits the damage?', choices: [
          { text: 'Rate limiting per account and per IP, plus input bounds on the amount', right: true, feedback: 'Correct. Rate limits and bounds blunt abuse and automation.' },
          { text: 'Bigger servers', feedback: 'Scaling up does not stop abuse; it pays for it.' },
          { text: 'Nothing; payment flows cannot be rate limited', feedback: 'They can and should be.' },
        ] },
      ],
      ending: { title: 'Model threats, then choose controls', text: 'Authenticate from the session, recompute money server-side, log actions for accountability, and rate-limit to resist abuse — controls chosen by walking the feature through threat categories.' },
      hints: ['STRIDE: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege.', 'Every money value and identity decision belongs on the server.'],
      realityNote: 'STRIDE and similar methods turn a feature sketch into a list of concrete threats and the controls that answer each.',
    });
  }),
  tmpl(2, 3, 'intermediate', 'abuse-cases', 'Turn a feature into abuse cases', 'E10', 20, 'For a password-reset feature, decide the abuse cases and the control that closes each.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Design against misuse\n\n**${a.org}** is building a password-reset flow for **${a.host}**. For each way it could be abused, pick the control.`,
      steps: [
        { title: 'Enumeration', text: 'The reset form says "no account with that email". What is the abuse, and the fix?', choices: [
          { text: 'It reveals which emails are registered; show the same "if the account exists, we sent a link" message either way', right: true, feedback: 'Correct. A uniform response stops enumeration.' },
          { text: 'No abuse; being helpful is good', feedback: 'It leaks which accounts exist, aiding targeted attacks.' },
          { text: 'Fix by adding a CAPTCHA only', feedback: 'A CAPTCHA slows automation but the message still leaks existence.' },
        ] },
        { title: 'Token strength', text: 'How should the reset link token be generated?', choices: [
          { text: 'A long, random, single-use token from a cryptographically secure generator, with a short expiry', right: true, feedback: 'Correct. Unguessable, single-use and short-lived.' },
          { text: 'The user id plus the date', feedback: 'Predictable tokens can be forged.' },
          { text: 'A sequential counter', feedback: 'Sequential tokens are trivially guessable.' },
        ] },
        { title: 'Flooding', text: 'An attacker requests thousands of resets for a victim\'s address. What limits harm?', choices: [
          { text: 'Rate-limit reset requests per account and address, and invalidate older tokens when a new one is issued', right: true, feedback: 'Correct. Throttle and keep only the latest token valid.' },
          { text: 'Email the victim every attempt with no limit', feedback: 'That is mailbox flooding, part of the abuse.' },
          { text: 'Nothing; resets cannot be limited', feedback: 'They can and should be rate limited.' },
        ] },
        { title: 'Token reuse', text: 'After a successful reset, what happens to the token?', choices: [
          { text: 'It is consumed and cannot be used again; existing sessions are invalidated', right: true, feedback: 'Correct. Single-use, and log the user out everywhere.' },
          { text: 'It stays valid until expiry for convenience', feedback: 'A reusable reset token is a standing risk.' },
          { text: 'It is emailed again as a receipt', feedback: 'Never resend a valid secret.' },
        ] },
      ],
      ending: { title: 'Abuse cases drive the controls', text: 'Uniform responses stop enumeration, strong single-use short-lived tokens resist forgery, rate limits stop flooding, and consuming the token plus invalidating sessions closes reuse.' },
      hints: ['For each feature, ask "how would someone misuse this?" and design the control first.', 'Reset tokens must be unguessable, single-use and short-lived.'],
      realityNote: 'Abuse-case thinking — the mirror of use cases — is how secure designs anticipate misuse before code is written.',
    });
  }),
  tmpl(2, 3, 'advanced', 'data-flow-review', 'Review a data-flow for exposure', 'E10', 25, 'Trace sensitive data through a feature and decide where it must be protected.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Follow the sensitive data\n\nOn **${a.host}**, a feature handles a national ID and a one-time PIN. Trace the data and protect it at each step.`,
      steps: [
        { title: 'In transit', text: 'How is the data protected as it travels from the browser?', choices: [
          { text: 'Over HTTPS only, with HSTS so the browser refuses plaintext', right: true, feedback: 'Correct. TLS plus HSTS keeps it encrypted end to end.' },
          { text: 'Base64-encoded in the URL', feedback: 'Encoding is not encryption, and URLs get logged.' },
          { text: 'Plain HTTP on the local network only', feedback: 'Cafe and campus networks are hostile; always use TLS.' },
        ] },
        { title: 'In logs', text: 'The server logs each request for debugging. What about the PIN and ID?', choices: [
          { text: 'Redact or omit them; never write secrets or full identifiers to logs', right: true, feedback: 'Correct. Logs are widely readable and long-lived.' },
          { text: 'Log everything to help debugging', feedback: 'Secrets in logs are a common, serious leak.' },
          { text: 'Log them but delete the file weekly', feedback: 'They are exposed in the meantime and in backups.' },
        ] },
        { title: 'At rest', text: 'The one-time PIN must be checked. How is it stored while valid?', choices: [
          { text: 'As a salted hash with a short expiry, compared in constant time, then deleted', right: true, feedback: 'Correct. Hash, expire, constant-time compare, delete.' },
          { text: 'In plaintext so it can be re-read', feedback: 'A stored plaintext secret is a breach waiting to happen.' },
          { text: 'Encrypted with a key kept next to it in the same table', feedback: 'A key stored beside the data it protects adds little.' },
        ] },
        { title: 'In error messages', text: 'The check fails. What does the user see?', choices: [
          { text: 'A generic failure; no echo of the ID, PIN or internal detail', right: true, feedback: 'Correct. Errors must not leak the sensitive values or internals.' },
          { text: 'The submitted ID and PIN, to help them retry', feedback: 'Echoing secrets leaks them, including into screenshots and logs.' },
          { text: 'A stack trace', feedback: 'Stack traces leak internals to attackers.' },
        ] },
        { title: 'In third-party calls', text: 'Verification uses an external provider. What do you send?', choices: [
          { text: 'Only the minimum the provider needs, over TLS, under a data-processing agreement', right: true, feedback: 'Correct. Data minimisation and a clear agreement.' },
          { text: 'The full user profile, to be safe', feedback: 'Send the minimum; extra data widens exposure.' },
          { text: 'The data plus your database credentials', feedback: 'Never share credentials with a third party.' },
        ] },
      ],
      ending: { title: 'Protect the data at every hop', text: 'Sensitive data stays encrypted in transit, out of logs, hashed and short-lived at rest, absent from error messages, and minimised when shared with third parties.' },
      hints: ['Follow one sensitive value through the whole feature and ask where it is exposed.', 'Logs, error messages and third-party calls are the leaks people forget.'],
      realityNote: 'Data-flow review is how privacy and security assessments find where regulated or secret data is exposed in transit, at rest, in logs and to dependencies.',
    });
  }),

  /* ------------------------------------------------------------------ 2.4 economics of attacks */
  tmpl(2, 4, 'beginner', 'why-small-sites', 'Understand why small sites get attacked', 'E10', 15, 'Reason about automated, opportunistic attacks on small and cafe-hosted sites, and cheap defences.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## "We are too small to be a target"\n\n**${a.org}** runs a modest site and assumes no one would bother attacking it. Reason through the economics.`,
      steps: [
        { title: 'Who attacks small sites', text: 'Why would a small site be attacked at all?', choices: [
          { text: 'Most attacks are automated and opportunistic — bots scan the whole internet for known weaknesses regardless of size', right: true, feedback: 'Correct. Automation makes every reachable site a target.' },
          { text: 'Only large banks are targeted', feedback: 'Automated scanning does not care about your size.' },
          { text: 'Attackers only act on personal grudges', feedback: 'Most web attacks are indiscriminate automation.' },
        ] },
        { title: 'What they want', text: 'What value is there in a small site?', choices: [
          { text: 'Hosting for phishing or malware, a spam relay, stored user data, or a foothold — all have resale value', right: true, feedback: 'Correct. Even a small site is a useful resource to abuse.' },
          { text: 'Nothing; small sites have no value', feedback: 'Compromised hosting and user data are valuable regardless of brand.' },
          { text: 'Only credit-card data matters', feedback: 'Hosting, credentials and reach are all monetised.' },
        ] },
        { title: 'Cheap defences', text: 'With a tiny budget, what gives the most protection per cedi?', choices: [
          { text: 'Keep software patched, use strong unique admin passwords with MFA, and enable HTTPS', right: true, feedback: 'Correct. Patching, good admin auth and TLS stop most automated attacks.' },
          { text: 'An expensive appliance and nothing else', feedback: 'Basics like patching and MFA matter more than a costly box.' },
          { text: 'Hope the site stays unnoticed', feedback: 'Obscurity is not a defence against internet-wide scanning.' },
        ] },
        { title: 'The cafe-hosted case', text: 'The site is administered over shared cafe Wi-Fi. What is the added risk, and fix?', choices: [
          { text: 'Credentials can be intercepted on an untrusted network; always use HTTPS and avoid admin over untrusted Wi-Fi, or use a VPN', right: true, feedback: 'Correct. Untrusted networks threaten admin sessions; TLS and a VPN help.' },
          { text: 'No added risk; Wi-Fi is Wi-Fi', feedback: 'Shared networks are a classic place to capture credentials.' },
          { text: 'Fix by changing the password weekly only', feedback: 'The issue is interception in transit, not password age.' },
        ] },
      ],
      ending: { title: 'Everyone is a target, so cover the basics', text: 'Automated attacks hit every reachable site; the cheapest strong defences are patching, MFA on admin accounts, and HTTPS, plus care on untrusted networks.' },
      hints: ['Most attacks are automated and indiscriminate; size is no shield.', 'Patching, MFA and HTTPS are the highest-value, lowest-cost defences.'],
      realityNote: 'Internet-wide scanning means new or small sites are probed within minutes of going live; the basics stop the bulk of automated attacks.',
    });
  }),
  tmpl(2, 4, 'intermediate', 'defence-roi', 'Prioritise defences by cost and benefit', 'E1', 20, 'Rank cheap, high-impact defences ahead of costly, narrow ones for a small team.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Most protection per cedi\n\n**${a.org}** has a small budget. Rank defences so the best value comes first.\n\n1. \`valueRatio(benefit, cost)\`: \`benefit\` and \`cost\` are positive numbers. Return \`benefit / cost\` rounded to 2 decimals (a Number). If \`cost <= 0\`, return \`null\`.\n2. \`order(defences)\`: \`defences\` is an array of \`{ name, benefit, cost }\`. Return the \`name\`s sorted by value ratio **descending**, ties broken by \`name\` ascending. Skip any with cost <= 0.`,
      hints: ['Round with Math.round(x * 100) / 100.', 'Sort by ratio desc then name asc.'],
      starter: `// ${a.app}: defence prioritisation\nfunction valueRatio(benefit, cost) {\n}\n\nfunction order(defences) {\n}\n`,
      checks: [
        fn('valueRatio divides and rounds', 'valueRatio', [
          { args: [10, 4], expected: 2.5 }, { args: [1, 3], expected: 0.33 }, { args: [5, 0], expected: null },
        ]),
        fn('order ranks by value', 'order', [
          { args: [[{ name: 'waf', benefit: 6, cost: 10 }, { name: 'mfa', benefit: 9, cost: 1 }, { name: 'patch', benefit: 8, cost: 2 }]], expected: ['mfa', 'patch', 'waf'] },
          { args: [[{ name: 'b', benefit: 4, cost: 2 }, { name: 'a', benefit: 4, cost: 2 }]], expected: ['a', 'b'] },
        ]),
      ],
      solution: `function valueRatio(benefit, cost) {\n  if (cost <= 0) return null;\n  return Math.round((benefit / cost) * 100) / 100;\n}\nfunction order(defences) {\n  return defences\n    .map((d) => ({ name: d.name, r: valueRatio(d.benefit, d.cost) }))\n    .filter((d) => d.r !== null)\n    .sort((a, b) => b.r - a.r || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))\n    .map((d) => d.name);\n}`,
      realityNote: 'For resource-constrained teams, ordering controls by benefit-to-cost puts patching and MFA ahead of expensive, narrow tools.',
    });
  }),
  tmpl(2, 4, 'advanced', 'incident-cost', 'Estimate the cost of a breach', 'E1', 25, 'Model the expected annual loss of a risk to justify spending on a defence.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Expected loss justifies the spend\n\nHelp **${a.org}** reason about a risk in money terms.\n\n1. \`annualLoss(perIncident, incidentsPerYear)\`: return \`perIncident * incidentsPerYear\` (expected annual loss). Both are non-negative numbers; if either is negative, return \`null\`.\n2. \`worthIt(annualLossBefore, annualLossAfter, annualCost)\`: a control reduces expected loss from *before* to *after* and costs *annualCost* per year. Return \`true\` only when the reduction (\`before - after\`) is strictly greater than \`annualCost\`.`,
      hints: ['annualLoss is a simple product with a non-negative guard.', 'worthIt: (before - after) > annualCost.'],
      starter: `// ${a.app}: breach cost model\nfunction annualLoss(perIncident, incidentsPerYear) {\n}\n\nfunction worthIt(annualLossBefore, annualLossAfter, annualCost) {\n}\n`,
      checks: [
        fn('annualLoss multiplies', 'annualLoss', [
          { args: [2000, 3], expected: 6000 }, { args: [0, 5], expected: 0 }, { args: [-1, 5], expected: null },
        ]),
        fn('worthIt compares reduction to cost', 'worthIt', [
          { args: [6000, 1000, 2000], expected: true }, { args: [6000, 5000, 2000], expected: false }, { args: [6000, 4000, 2000], expected: false },
        ]),
      ],
      solution: `function annualLoss(perIncident, incidentsPerYear) {\n  if (perIncident < 0 || incidentsPerYear < 0) return null;\n  return perIncident * incidentsPerYear;\n}\nfunction worthIt(annualLossBefore, annualLossAfter, annualCost) {\n  return (annualLossBefore - annualLossAfter) > annualCost;\n}`,
      realityNote: 'Annualised loss expectancy (incident cost × frequency) is the classic way to justify a security control against its running cost.',
    });
  }),

  /* ------------------------------------------------------------------ 2.5 safe error and timing behaviour */
  tmpl(2, 5, 'beginner', 'safe-error-message', 'Return a safe error message', 'E1', 20, 'Map internal errors to generic messages so responses never leak internals.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Say little in errors\n\nOn **${a.host}**, errors must not reveal internals (stack traces, SQL, file paths). Write \`safeError(internal)\` where \`internal = { code, detail }\`:\n\n- for \`code\` \`"db"\`, \`"io"\` or \`"timeout"\`: return \`{ status: 500, message: "Something went wrong. Please try again." }\`;\n- for \`code\` \`"auth"\`: return \`{ status: 401, message: "Invalid credentials." }\`;\n- for \`code\` \`"notfound"\`: return \`{ status: 404, message: "Not found." }\`;\n- anything else: return \`{ status: 500, message: "Something went wrong. Please try again." }\`.\n\nNever include \`detail\` in the output.`,
      hints: ['Map the known codes; default to the generic 500 message.', 'Do not copy internal.detail anywhere into the result.'],
      starter: `// ${a.app}: safe errors\nfunction safeError(internal) {\n}\n`,
      checks: [
        fn('safeError hides internals', 'safeError', [
          { args: [{ code: 'db', detail: 'SQLSTATE 42000 near SELECT' }], expected: { status: 500, message: 'Something went wrong. Please try again.' } },
          { args: [{ code: 'auth', detail: 'user ama not found' }], expected: { status: 401, message: 'Invalid credentials.' } },
          { args: [{ code: 'notfound', detail: '/var/data/x' }], expected: { status: 404, message: 'Not found.' } },
          { args: [{ code: 'weird', detail: 'trace...' }], expected: { status: 500, message: 'Something went wrong. Please try again.' } },
        ]),
      ],
      solution: `function safeError(internal) {\n  const generic = { status: 500, message: "Something went wrong. Please try again." };\n  if (internal.code === "db" || internal.code === "io" || internal.code === "timeout") return generic;\n  if (internal.code === "auth") return { status: 401, message: "Invalid credentials." };\n  if (internal.code === "notfound") return { status: 404, message: "Not found." };\n  return generic;\n}`,
      realityNote: 'Verbose errors — stack traces, SQL fragments, file paths — hand attackers a map of your internals; production responses should be generic while full detail goes only to server logs.',
    });
  }),
  tmpl(2, 5, 'intermediate', 'uniform-login-response', 'Answer login identically either way', 'E1', 20, 'Return the same response whether the user is unknown or the password is wrong.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Do not leak which accounts exist\n\nOn **${a.host}**, the login must not reveal whether an email is registered. Write \`loginResult(found, passwordOk)\`:\n\n- if \`found\` is true and \`passwordOk\` is true: \`{ status: 200, message: "Welcome back." }\`;\n- in **every** other case (no such user, or wrong password): \`{ status: 401, message: "Invalid email or password." }\`.\n\nThe failure response must be identical in both failing cases.`,
      hints: ['Only the both-true case succeeds; everything else is the same 401.', 'Do not branch the failure message on whether the user was found.'],
      starter: `// ${a.app}: uniform login response\nfunction loginResult(found, passwordOk) {\n}\n`,
      checks: [
        fn('loginResult is uniform on failure', 'loginResult', [
          { args: [true, true], expected: { status: 200, message: 'Welcome back.' } },
          { args: [true, false], expected: { status: 401, message: 'Invalid email or password.' } },
          { args: [false, false], expected: { status: 401, message: 'Invalid email or password.' } },
          { args: [false, true], expected: { status: 401, message: 'Invalid email or password.' } },
        ]),
      ],
      solution: `function loginResult(found, passwordOk) {\n  if (found && passwordOk) return { status: 200, message: "Welcome back." };\n  return { status: 401, message: "Invalid email or password." };\n}`,
      realityNote: 'Distinct messages for "no such user" versus "wrong password" let attackers enumerate accounts; a single response for all failures closes that leak.',
    });
  }),
  tmpl(2, 5, 'advanced', 'constant-time-equal', 'Compare secrets in constant time', 'E1', 25, 'Compare tokens without an early return, so timing does not reveal how much matched.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Do not leak through timing\n\nComparing secrets with \`===\` or a loop that returns on the first difference lets an attacker measure how many characters matched. On **${a.host}**, write \`constantTimeEqual(a, b)\`:\n\n- if the lengths differ, return \`false\` (length is not usually secret);\n- otherwise XOR every pair of character codes into an accumulator and return whether the accumulator is 0 — **never return early inside the loop**.\n\nAlso write \`checkToken(provided, expected)\` that returns \`constantTimeEqual(provided, expected)\` only when both are non-empty strings, else \`false\`.`,
      hints: ['let diff = 0; for i: diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0.', 'Guard the length difference first; it is acceptable to reveal.'],
      starter: `// ${a.app}: constant-time compare\nfunction constantTimeEqual(a, b) {\n}\n\nfunction checkToken(provided, expected) {\n}\n`,
      checks: [
        fn('constantTimeEqual matches correctly', 'constantTimeEqual', [
          { args: ['abc123', 'abc123'], expected: true },
          { args: ['abc123', 'abc124'], expected: false },
          { args: ['abc', 'abcd'], expected: false },
          { args: ['', ''], expected: true },
        ]),
        fn('checkToken rejects empty input', 'checkToken', [
          { args: ['tok', 'tok'], expected: true }, { args: ['', ''], expected: false }, { args: ['tok', 'tok2'], expected: false },
        ]),
      ],
      solution: `function constantTimeEqual(a, b) {\n  if (a.length !== b.length) return false;\n  let diff = 0;\n  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);\n  return diff === 0;\n}\nfunction checkToken(provided, expected) {\n  if (typeof provided !== "string" || typeof expected !== "string" || !provided || !expected) return false;\n  return constantTimeEqual(provided, expected);\n}`,
      realityNote: 'Timing-safe comparison (as in Node\'s crypto.timingSafeEqual) is used for tokens, HMACs and password hashes so response time does not reveal how much of a secret matched.',
    });
  }),
];
