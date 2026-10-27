/** Unit 8: defences and secure headers. Learners assemble a layered defence, build security
 * headers, make safe CORS and config decisions, and reason about dependencies and a WAF. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U8: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 8.1 layered defence */
  tmpl(8, 1, 'beginner', 'layered-defence', 'Design a layered defence for a feature', 'E10', 15, 'Place validation, encoding, parameterisation, authorisation and logging as independent layers.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## No single wall\n\n**${a.org}** is hardening a comment feature on **${a.host}**. Place each defence in the right layer so one miss is not fatal.`,
      steps: [
        { title: 'At input', text: 'What belongs at the input boundary?', choices: [
          { text: 'Validation/allow-listing of structure and length, rejecting malformed input early', right: true, feedback: 'Correct. Validate shape and size at the edge.' },
          { text: 'HTML encoding', feedback: 'Encoding belongs at output, in the right context.' },
          { text: 'Nothing; validate later', feedback: 'Validate early to reject obviously bad input.' },
        ] },
        { title: 'At the database', text: 'What protects the query?', choices: [
          { text: 'Parameterised queries and a least-privilege account', right: true, feedback: 'Correct. Data stays data; the account is limited.' },
          { text: 'Escaping the HTML before the query', feedback: 'HTML encoding is for output, not SQL.' },
          { text: 'Trusting validation to have cleaned it', feedback: 'Always parameterise regardless of validation.' },
        ] },
        { title: 'At output', text: 'What stops the stored comment running as script?', choices: [
          { text: 'Context-aware output encoding (and a CSP as a second layer)', right: true, feedback: 'Correct. Encode for the rendering context; CSP backs it up.' },
          { text: 'Validation at input only', feedback: 'Input validation alone is not enough for output safety.' },
          { text: 'A longer password policy', feedback: 'Unrelated to output encoding.' },
        ] },
        { title: 'Around it all', text: 'What two cross-cutting layers remain?', choices: [
          { text: 'Authorisation (who may post/read) and logging/monitoring of security events', right: true, feedback: 'Correct. Authorise every action and record security-relevant events.' },
          { text: 'Only caching', feedback: 'Caching is not a security layer here.' },
          { text: 'Nothing else is needed', feedback: 'Authorisation and logging are essential layers.' },
        ] },
      ],
      ending: { title: 'Independent layers', text: 'Validate at input, parameterise at the database with least privilege, encode at output with a CSP, and wrap it all in authorisation and logging — so a single gap is contained by the others.' },
      hints: ['Each layer addresses a different stage: input, storage, output, and cross-cutting.', 'Defence in depth means no one control is load-bearing.'],
      realityNote: 'Layered defence is the organising idea of application security: validation, parameterisation, encoding, authorisation and logging each catch what the others miss.',
    });
  }),
  tmpl(8, 1, 'intermediate', 'layer-coverage', 'Check a feature has every layer', 'E1', 20, 'Report which defensive layers a feature is missing from its control list.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## What is missing?\n\nFor **${a.host}**, check a feature against the required layers. Write \`missingLayers(controls)\` where \`controls\` is an array of control names present. The required layers are \`"validation"\`, \`"parameterisation"\`, \`"encoding"\`, \`"authorisation"\`, \`"logging"\`. Return the required layers **not** present, in the required order.\n\nAlso \`isComplete(controls)\`: return \`true\` when nothing is missing.`,
      hints: ['Keep the required list in order and filter out those present.', 'isComplete is missingLayers(controls).length === 0.'],
      starter: `// ${a.app}: layer coverage\nfunction missingLayers(controls) {\n}\n\nfunction isComplete(controls) {\n}\n`,
      checks: [
        fn('missingLayers reports gaps in order', 'missingLayers', [
          { args: [['validation', 'parameterisation', 'encoding', 'authorisation', 'logging']], expected: [] },
          { args: [['validation', 'encoding']], expected: ['parameterisation', 'authorisation', 'logging'] },
          { args: [[]], expected: ['validation', 'parameterisation', 'encoding', 'authorisation', 'logging'] },
        ]),
        fn('isComplete confirms full coverage', 'isComplete', [
          { args: [['validation', 'parameterisation', 'encoding', 'authorisation', 'logging']], expected: true },
          { args: [['validation']], expected: false },
        ]),
      ],
      solution: `function missingLayers(controls) {\n  const required = ["validation", "parameterisation", "encoding", "authorisation", "logging"];\n  return required.filter((layer) => !controls.includes(layer));\n}\nfunction isComplete(controls) {\n  return missingLayers(controls).length === 0;\n}`,
      realityNote: 'A control checklist per feature makes gaps visible; security reviews often come down to "which layer did this feature forget?".',
    });
  }),
  tmpl(8, 1, 'advanced', 'residual-risk', 'Reason about residual risk across layers', 'E1', 25, 'Estimate how much risk remains when independent layers each catch a fraction of attacks.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Layers multiply\n\nFor **${a.host}**, model residual risk. Each layer independently stops a fraction of attacks; the chance an attack gets through all of them is the product of what each lets through. Write:\n\n1. \`residual(catchRates)\`: \`catchRates\` is an array of numbers in \`[0,1]\` (fraction each layer catches). Return the product of \`(1 - rate)\`, rounded to 4 decimals. An empty array returns \`1\`.\n2. \`meetsTarget(catchRates, maxResidual)\`: return \`true\` when \`residual(catchRates) <= maxResidual\`.`,
      hints: ['Multiply (1 - rate) across the layers.', 'Round with Math.round(x * 10000) / 10000.'],
      starter: `// ${a.app}: residual risk\nfunction residual(catchRates) {\n}\n\nfunction meetsTarget(catchRates, maxResidual) {\n}\n`,
      checks: [
        fn('residual multiplies the gaps', 'residual', [
          { args: [[0.9, 0.9]], expected: 0.01 },
          { args: [[0.5, 0.5, 0.5]], expected: 0.125 },
          { args: [[]], expected: 1 },
          { args: [[1]], expected: 0 },
        ]),
        fn('meetsTarget compares to the target', 'meetsTarget', [
          { args: [[0.9, 0.9], 0.02], expected: true },
          { args: [[0.5], 0.02], expected: false },
        ]),
      ],
      solution: `function residual(catchRates) {\n  let p = 1;\n  for (const r of catchRates) p *= 1 - r;\n  return Math.round(p * 10000) / 10000;\n}\nfunction meetsTarget(catchRates, maxResidual) {\n  return residual(catchRates) <= maxResidual;\n}`,
      realityNote: 'Independent layers multiply: two controls that each catch 90% leave 1% residual together, which is why depth beats any single strong control.',
    });
  }),

  /* ------------------------------------------------------------------ 8.2 security headers */
  tmpl(8, 2, 'beginner', 'security-headers', 'Set the core security headers', 'E1', 20, 'Assemble the standard security headers for an HTTPS application.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The headers every app should send\n\nFor **${a.host}**, build the core security headers. Write \`securityHeaders()\` returning exactly:\n\n\`\`\`\n{\n  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",\n  "X-Content-Type-Options": "nosniff",\n  "X-Frame-Options": "DENY",\n  "Referrer-Policy": "no-referrer",\n  "Content-Security-Policy": "default-src 'self'"\n}\n\`\`\`\n\nAlso \`hasHsts(headers)\`: return \`true\` if the headers object has a \`"Strict-Transport-Security"\` whose value includes \`"max-age="\`.`,
      hints: ['Return the fixed object exactly as shown.', 'hasHsts checks the header exists and includes max-age=.'],
      starter: `// ${a.app}: security headers\nfunction securityHeaders() {\n}\n\nfunction hasHsts(headers) {\n}\n`,
      checks: [
        fn('securityHeaders returns the core set', 'securityHeaders', [
          { args: [], expected: { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'" } },
        ]),
        fn('hasHsts detects HSTS', 'hasHsts', [
          { args: [{ 'Strict-Transport-Security': 'max-age=31536000' }], expected: true },
          { args: [{ 'X-Frame-Options': 'DENY' }], expected: false },
        ]),
      ],
      solution: `function securityHeaders() {\n  return {\n    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",\n    "X-Content-Type-Options": "nosniff",\n    "X-Frame-Options": "DENY",\n    "Referrer-Policy": "no-referrer",\n    "Content-Security-Policy": "default-src 'self'",\n  };\n}\nfunction hasHsts(headers) {\n  const h = headers["Strict-Transport-Security"];\n  return typeof h === "string" && h.includes("max-age=");\n}`,
      realityNote: 'HSTS, nosniff, frame controls, a referrer policy and a CSP are the baseline security headers; tools like securityheaders.com grade a site on exactly these.',
    });
  }),
  tmpl(8, 2, 'intermediate', 'frame-controls', 'Stop clickjacking with frame controls', 'E1', 20, 'Decide whether a page may be framed, via frame-ancestors and X-Frame-Options.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Who may frame your page\n\nTo stop clickjacking on **${a.host}**, decide framing. Write \`frameAllowed(frameAncestors, framingOrigin)\` where \`frameAncestors\` is the CSP directive value — one of \`"'none'"\`, \`"'self'"\`, or a space-separated list of allowed origins — and \`framingOrigin\` is the origin trying to frame the page (or \`null\` for top-level, not framed):\n\n- if \`framingOrigin\` is \`null\` → \`true\` (top-level load);\n- if \`frameAncestors\` is \`"'none'"\` → \`false\`;\n- if \`frameAncestors\` is \`"'self'"\` → \`true\` only when \`framingOrigin === selfOrigin\`... but we have no self here, so treat \`"'self'"\` as allowing only the literal origin \`"self"\`;\n- otherwise split the list and allow if \`framingOrigin\` is in it.`,
      hints: ['Top-level (null) is always allowed.', "'none' blocks all framing; a list allows matching origins."],
      starter: `// ${a.app}: frame controls\nfunction frameAllowed(frameAncestors, framingOrigin) {\n}\n`,
      checks: [
        fn('frameAllowed enforces frame-ancestors', 'frameAllowed', [
          { args: ["'none'", null], expected: true },
          { args: ["'none'", 'https://evil.test'], expected: false },
          { args: ["'self'", 'self'], expected: true },
          { args: ["'self'", 'https://evil.test'], expected: false },
          { args: ['https://partner.test https://ok.test', 'https://ok.test'], expected: true },
          { args: ['https://partner.test', 'https://evil.test'], expected: false },
        ]),
      ],
      solution: `function frameAllowed(frameAncestors, framingOrigin) {\n  if (framingOrigin === null) return true;\n  if (frameAncestors === "'none'") return false;\n  if (frameAncestors === "'self'") return framingOrigin === "self";\n  return frameAncestors.split(" ").includes(framingOrigin);\n}`,
      realityNote: 'CSP frame-ancestors (superseding X-Frame-Options) controls which origins may embed your page, defeating clickjacking overlays.',
    });
  }),
  tmpl(8, 2, 'advanced', 'grade-headers', 'Grade a response\'s security headers', 'E1', 25, 'Score a set of response headers against the baseline and report what to add.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Score the headers\n\nFor **${a.host}**, grade a response. Write \`gradeHeaders(headers)\` returning \`{ score, missing }\`:\n\n- one point each for the presence of \`"Strict-Transport-Security"\`, \`"X-Content-Type-Options"\`, \`"Content-Security-Policy"\`, \`"X-Frame-Options"\` (or a CSP containing \`"frame-ancestors"\`), and \`"Referrer-Policy"\` — 5 max;\n- \`missing\` lists the baseline header names absent (use \`"X-Frame-Options"\` if neither it nor frame-ancestors is present), in the order above.\n\nTreat the X-Frame-Options point as earned if either \`X-Frame-Options\` is set **or** the CSP value includes \`"frame-ancestors"\`.`,
      hints: ['Count presence of each baseline header.', 'The frame point can come from X-Frame-Options or a frame-ancestors CSP.'],
      starter: `// ${a.app}: grade headers\nfunction gradeHeaders(headers) {\n}\n`,
      checks: [
        fn('gradeHeaders scores and lists gaps', 'gradeHeaders', [
          { args: [{ 'Strict-Transport-Security': 'max-age=1', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'", 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }], expected: { score: 5, missing: [] } },
          { args: [{ 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'" }], expected: { score: 2, missing: ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy'] } },
          { args: [{}], expected: { score: 0, missing: ['Strict-Transport-Security', 'X-Content-Type-Options', 'Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy'] } },
        ]),
      ],
      solution: `function gradeHeaders(headers) {\n  const csp = headers["Content-Security-Policy"] || "";\n  const frameOk = !!headers["X-Frame-Options"] || csp.includes("frame-ancestors");\n  const checks = [\n    ["Strict-Transport-Security", !!headers["Strict-Transport-Security"]],\n    ["X-Content-Type-Options", !!headers["X-Content-Type-Options"]],\n    ["Content-Security-Policy", !!headers["Content-Security-Policy"]],\n    ["X-Frame-Options", frameOk],\n    ["Referrer-Policy", !!headers["Referrer-Policy"]],\n  ];\n  let score = 0;\n  const missing = [];\n  for (const [name, present] of checks) {\n    if (present) score++;\n    else missing.push(name);\n  }\n  return { score, missing };\n}`,
      realityNote: 'Header-grading tools work just like this: present/absent checks against a baseline, with actionable "add these" output.',
    });
  }),

  /* ------------------------------------------------------------------ 8.3 secure configuration and CORS */
  tmpl(8, 3, 'beginner', 'cors-origin', 'Reflect only allowed CORS origins', 'E1', 20, 'Decide the Access-Control-Allow-Origin value from an allow-list, never a wildcard with credentials.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## CORS, done safely\n\nOn **${a.host}**, a misconfigured CORS policy can expose data to any site. Write \`corsOrigin(requestOrigin, allowedOrigins)\`:\n\n- if \`requestOrigin\` is in \`allowedOrigins\`, return \`requestOrigin\` (reflect only allowed origins);\n- otherwise return \`null\` (send no Access-Control-Allow-Origin).\n\nAlso \`credentialsAllowed(origin, allowCredentials)\`: return \`false\` if \`origin\` is \`"*"\` and \`allowCredentials\` is true (that combination is invalid and unsafe); otherwise return \`allowCredentials === true\`.`,
      hints: ['Never reflect an origin that is not allow-listed.', 'A wildcard origin with credentials is forbidden; return false there.'],
      starter: `// ${a.app}: safe CORS\nfunction corsOrigin(requestOrigin, allowedOrigins) {\n}\n\nfunction credentialsAllowed(origin, allowCredentials) {\n}\n`,
      checks: [
        fn('corsOrigin reflects only allowed origins', 'corsOrigin', [
          { args: ['https://app.test', ['https://app.test']], expected: 'https://app.test' },
          { args: ['https://evil.test', ['https://app.test']], expected: null },
        ]),
        fn('credentialsAllowed forbids wildcard+credentials', 'credentialsAllowed', [
          { args: ['https://app.test', true], expected: true },
          { args: ['*', true], expected: false },
          { args: ['https://app.test', false], expected: false },
        ]),
      ],
      solution: `function corsOrigin(requestOrigin, allowedOrigins) {\n  return allowedOrigins.includes(requestOrigin) ? requestOrigin : null;\n}\nfunction credentialsAllowed(origin, allowCredentials) {\n  if (origin === "*" && allowCredentials) return false;\n  return allowCredentials === true;\n}`,
      realityNote: 'Reflecting arbitrary origins, or combining a wildcard origin with credentials, are common CORS misconfigurations that leak authenticated data to attacker sites.',
    });
  }),
  tmpl(8, 3, 'intermediate', 'tls-and-cookie-config', 'Check transport and cookie configuration', 'E1', 20, 'Validate that the deployment enforces HTTPS and sets cookie flags correctly.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Configuration that does not leak\n\nFor **${a.host}**, check the deployment config. Write \`configProblems(cfg)\` where \`cfg = { httpsOnly, hsts, cookieSecure, cookieHttpOnly, verboseErrors }\`, returning problems in this order:\n\n- \`"no-https"\` if \`httpsOnly\` is not \`true\`;\n- \`"no-hsts"\` if \`hsts\` is not \`true\`;\n- \`"insecure-cookie"\` if \`cookieSecure\` is not \`true\`;\n- \`"cookie-script-readable"\` if \`cookieHttpOnly\` is not \`true\`;\n- \`"verbose-errors"\` if \`verboseErrors\` is \`true\` (production must not leak stack traces).\n\nReturn \`[]\` when the config is safe.`,
      hints: ['Push each problem in the given order.', 'verboseErrors is a problem when true; the others when not true.'],
      starter: `// ${a.app}: config validation\nfunction configProblems(cfg) {\n}\n`,
      checks: [
        fn('configProblems finds misconfiguration', 'configProblems', [
          { args: [{ httpsOnly: true, hsts: true, cookieSecure: true, cookieHttpOnly: true, verboseErrors: false }], expected: [] },
          { args: [{ httpsOnly: false, hsts: false, cookieSecure: false, cookieHttpOnly: false, verboseErrors: true }], expected: ['no-https', 'no-hsts', 'insecure-cookie', 'cookie-script-readable', 'verbose-errors'] },
          { args: [{ httpsOnly: true, hsts: true, cookieSecure: true, cookieHttpOnly: true, verboseErrors: true }], expected: ['verbose-errors'] },
        ]),
      ],
      solution: `function configProblems(cfg) {\n  const problems = [];\n  if (cfg.httpsOnly !== true) problems.push("no-https");\n  if (cfg.hsts !== true) problems.push("no-hsts");\n  if (cfg.cookieSecure !== true) problems.push("insecure-cookie");\n  if (cfg.cookieHttpOnly !== true) problems.push("cookie-script-readable");\n  if (cfg.verboseErrors === true) problems.push("verbose-errors");\n  return problems;\n}`,
      realityNote: 'Security misconfiguration — missing HTTPS/HSTS, insecure cookies, verbose errors — is a whole OWASP category; a config check like this catches the common cases.',
    });
  }),
  tmpl(8, 3, 'advanced', 'preflight-decision', 'Answer a CORS preflight correctly', 'E1', 25, 'Decide the preflight response: allowed origin, methods and headers, with credentials handled safely.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The preflight response\n\nOn **${a.host}**, answer a CORS preflight. Write \`preflight(req, policy)\` where \`req = { origin, method, headers }\` (\`method\` is the requested method, \`headers\` the requested header names) and \`policy = { allowedOrigins, allowedMethods, allowedHeaders, allowCredentials }\`:\n\n- if \`req.origin\` not in \`policy.allowedOrigins\` → \`{ allow: false }\`;\n- if \`req.method\` not in \`policy.allowedMethods\` → \`{ allow: false }\`;\n- if any requested header is not in \`policy.allowedHeaders\` → \`{ allow: false }\`;\n- otherwise \`{ allow: true, headers: { "Access-Control-Allow-Origin": req.origin, "Access-Control-Allow-Methods": policy.allowedMethods.join(", "), "Access-Control-Allow-Credentials": policy.allowCredentials ? "true" : "false" } }\`.`,
      hints: ['Validate origin, then method, then every requested header.', 'Only reflect the specific origin, never "*", when credentials are allowed.'],
      starter: `// ${a.app}: CORS preflight\nfunction preflight(req, policy) {\n}\n`,
      checks: [
        fn('preflight validates and responds', 'preflight', [
          { args: [{ origin: 'https://app.test', method: 'POST', headers: ['content-type'] }, { allowedOrigins: ['https://app.test'], allowedMethods: ['GET', 'POST'], allowedHeaders: ['content-type'], allowCredentials: true }], expected: { allow: true, headers: { 'Access-Control-Allow-Origin': 'https://app.test', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Credentials': 'true' } } },
          { args: [{ origin: 'https://evil.test', method: 'POST', headers: [] }, { allowedOrigins: ['https://app.test'], allowedMethods: ['POST'], allowedHeaders: [], allowCredentials: false }], expected: { allow: false } },
          { args: [{ origin: 'https://app.test', method: 'DELETE', headers: [] }, { allowedOrigins: ['https://app.test'], allowedMethods: ['GET'], allowedHeaders: [], allowCredentials: false }], expected: { allow: false } },
          { args: [{ origin: 'https://app.test', method: 'GET', headers: ['x-evil'] }, { allowedOrigins: ['https://app.test'], allowedMethods: ['GET'], allowedHeaders: ['content-type'], allowCredentials: false }], expected: { allow: false } },
        ]),
      ],
      solution: `function preflight(req, policy) {\n  if (!policy.allowedOrigins.includes(req.origin)) return { allow: false };\n  if (!policy.allowedMethods.includes(req.method)) return { allow: false };\n  if (!req.headers.every((h) => policy.allowedHeaders.includes(h))) return { allow: false };\n  return {\n    allow: true,\n    headers: {\n      "Access-Control-Allow-Origin": req.origin,\n      "Access-Control-Allow-Methods": policy.allowedMethods.join(", "),\n      "Access-Control-Allow-Credentials": policy.allowCredentials ? "true" : "false",\n    },\n  };\n}`,
      realityNote: 'A correct preflight validates origin, method and requested headers against an allow-list and reflects only the specific origin — never a wildcard when credentials are in play.',
    });
  }),

  /* ------------------------------------------------------------------ 8.4 dependency and supply-chain risk */
  tmpl(8, 4, 'beginner', 'dependency-risk', 'Manage dependency and supply-chain risk', 'E10', 15, 'Choose practices that keep third-party components from becoming your vulnerability.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Your dependencies are your code\n\n**${a.org}** builds **${a.host}** on many open-source libraries. Decide how to manage the risk they bring.`,
      steps: [
        { title: 'Knowing what you use', text: 'What is the first step to managing dependency risk?', choices: [
          { text: 'Maintain an inventory (a software bill of materials) of every component and version', right: true, feedback: 'Correct. You cannot patch what you do not know you run.' },
          { text: 'Assume the framework handles it', feedback: 'You own the risk of what you ship, dependencies included.' },
          { text: 'Only track your own code', feedback: 'Most code in a modern app is dependencies.' },
        ] },
        { title: 'Finding vulnerabilities', text: 'How do you learn a dependency is vulnerable?', choices: [
          { text: 'Automated scanning (e.g. dependency audit tools) against vulnerability databases, in CI', right: true, feedback: 'Correct. Continuous scanning flags known-vulnerable versions.' },
          { text: 'Wait for a news headline', feedback: 'Too slow and unreliable.' },
          { text: 'Never update, to stay stable', feedback: 'Unpatched known vulnerabilities are a major risk.' },
        ] },
        { title: 'Pinning and integrity', text: 'How do you stop a tampered or unexpected version slipping in?', choices: [
          { text: 'Pin exact versions and verify integrity hashes (lockfiles)', right: true, feedback: 'Correct. Pinned, hash-verified dependencies are reproducible and tamper-evident.' },
          { text: 'Always install the latest at build time', feedback: 'Floating versions let a compromised release in automatically.' },
          { text: 'Trust the registry completely', feedback: 'Integrity hashes protect against a compromised registry or package.' },
        ] },
        { title: 'Updating', text: 'A dependency has a critical fix. What is the practice?', choices: [
          { text: 'Update promptly, test, and ship — keeping components patched is the point', right: true, feedback: 'Correct. Timely patching closes known holes.' },
          { text: 'Ignore it if the app seems to work', feedback: 'Known-vulnerable components are exploited at scale.' },
          { text: 'Fork and patch secretly forever', feedback: 'That creates an unmaintained private fork; prefer upstream fixes.' },
        ] },
      ],
      ending: { title: 'Know, scan, pin, patch', text: 'Keep an inventory, scan dependencies continuously, pin and integrity-check versions, and patch promptly — dependencies are part of your attack surface.' },
      hints: ['You own the risk of everything you ship, dependencies included.', 'Inventory, scanning, pinning and timely patching are the core practices.'],
      realityNote: 'Vulnerable and outdated components are a standing OWASP category; SBOMs, dependency scanning and lockfiles are how teams keep the supply chain in check.',
    });
  }),
  tmpl(8, 4, 'intermediate', 'flag-vulnerable-deps', 'Flag dependencies that need updating', 'E1', 25, 'Compare installed versions to known-vulnerable ranges and report what to upgrade.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Which dependencies are vulnerable?\n\nFor **${a.host}**, compare installed versions against advisories. Versions are \`"major.minor.patch"\`. Write:\n\n1. \`cmpVersion(x, y)\`: return \`-1\`, \`0\` or \`1\` comparing two version strings numerically by component.\n2. \`isVulnerable(installed, fixedIn)\`: return \`true\` when \`cmpVersion(installed, fixedIn) < 0\` (installed is older than the fixed version).\n3. \`toUpgrade(deps, advisories)\`: \`deps\` maps name→installed version; \`advisories\` maps name→fixed version. Return a **sorted array** of names that are vulnerable.`,
      hints: ['Compare version components as numbers, left to right.', 'A name is vulnerable if its installed version is below the advisory\'s fixed version.'],
      starter: `// ${a.app}: flag vulnerable dependencies\nfunction cmpVersion(x, y) {\n}\n\nfunction isVulnerable(installed, fixedIn) {\n}\n\nfunction toUpgrade(deps, advisories) {\n}\n`,
      checks: [
        fn('cmpVersion compares numerically', 'cmpVersion', [
          { args: ['1.2.3', '1.2.3'], expected: 0 }, { args: ['1.2.3', '1.10.0'], expected: -1 }, { args: ['2.0.0', '1.9.9'], expected: 1 },
        ]),
        fn('isVulnerable checks the fix version', 'isVulnerable', [
          { args: ['1.2.3', '1.2.5'], expected: true }, { args: ['1.2.5', '1.2.5'], expected: false }, { args: ['2.0.0', '1.9.0'], expected: false },
        ]),
        fn('toUpgrade lists vulnerable names', 'toUpgrade', [
          { args: [{ flask: '2.2.2', requests: '2.32.0' }, { flask: '2.2.5', requests: '2.32.0' }], expected: ['flask'] },
          { args: [{ a: '1.0.0', b: '1.0.0' }, { a: '2.0.0', b: '0.9.0' }], expected: ['a'] },
        ]),
      ],
      solution: `function cmpVersion(x, y) {\n  const xs = x.split(".").map(Number), ys = y.split(".").map(Number);\n  for (let i = 0; i < 3; i++) {\n    if ((xs[i] || 0) < (ys[i] || 0)) return -1;\n    if ((xs[i] || 0) > (ys[i] || 0)) return 1;\n  }\n  return 0;\n}\nfunction isVulnerable(installed, fixedIn) {\n  return cmpVersion(installed, fixedIn) < 0;\n}\nfunction toUpgrade(deps, advisories) {\n  const out = [];\n  for (const name of Object.keys(deps)) {\n    if (advisories[name] && isVulnerable(deps[name], advisories[name])) out.push(name);\n  }\n  return out.sort();\n}`,
      realityNote: 'Dependency scanners (npm audit, pip-audit, Dependabot) do exactly this: compare your lockfile versions to advisory fixed-versions and tell you what to upgrade.',
    });
  }),
  tmpl(8, 4, 'advanced', 'risk-prioritise-deps', 'Prioritise dependency fixes by exposure', 'E1', 25, 'Rank vulnerable dependencies by severity and whether the vulnerable code is reachable.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Not every CVE is urgent\n\nFor **${a.host}**, prioritise dependency fixes. Write \`fixPriority(finding)\` where \`finding = { severity, reachable, hasFix }\` (\`severity\` is \`"low"|"medium"|"high"|"critical"\`):\n\n- base score: low 1, medium 2, high 4, critical 8;\n- if \`reachable\` is true, **double** the base;\n- if \`hasFix\` is false, subtract 1 (harder to act, so slightly deprioritised but not zero);\n- return the final number (minimum 0).\n\nThen \`order(findings)\`: return the array of \`finding.id\` sorted by priority descending, ties by \`id\` ascending.`,
      hints: ['Map severity to a base, double when reachable, then adjust for a fix.', 'Clamp the score at 0 minimum.'],
      starter: `// ${a.app}: prioritise dependency fixes\nfunction fixPriority(finding) {\n}\n\nfunction order(findings) {\n}\n`,
      checks: [
        fn('fixPriority scores by severity and reachability', 'fixPriority', [
          { args: [{ severity: 'critical', reachable: true, hasFix: true }], expected: 16 },
          { args: [{ severity: 'high', reachable: false, hasFix: true }], expected: 4 },
          { args: [{ severity: 'low', reachable: false, hasFix: false }], expected: 0 },
          { args: [{ severity: 'medium', reachable: true, hasFix: false }], expected: 3 },
        ]),
        fn('order ranks the findings', 'order', [
          { args: [[{ id: 'b', severity: 'high', reachable: true, hasFix: true }, { id: 'a', severity: 'medium', reachable: false, hasFix: true }]], expected: ['b', 'a'] },
        ]),
      ],
      solution: `function fixPriority(finding) {\n  const base = { low: 1, medium: 2, high: 4, critical: 8 }[finding.severity] || 0;\n  let score = finding.reachable ? base * 2 : base;\n  if (!finding.hasFix) score -= 1;\n  return Math.max(0, score);\n}\nfunction order(findings) {\n  return findings\n    .map((f) => ({ id: f.id, p: fixPriority(f) }))\n    .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))\n    .map((f) => f.id);\n}`,
      realityNote: 'Reachability analysis (is the vulnerable function actually called?) lets teams prioritise the dependency fixes that matter instead of chasing every advisory equally.',
    });
  }),

  /* ------------------------------------------------------------------ 8.5 WAF as a stopgap */
  tmpl(8, 5, 'beginner', 'waf-stopgap', 'Use a WAF as a stopgap, not a cure', 'E10', 15, 'Decide the proper role of a web application firewall relative to fixing the code.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## A shield, not a repair\n\n**${a.org}** is considering a web application firewall (WAF) for **${a.host}**. Decide its proper role.`,
      steps: [
        { title: 'What a WAF does', text: 'What is a WAF good for?', choices: [
          { text: 'Filtering common attack patterns and buying time to fix the real flaw (virtual patching)', right: true, feedback: 'Correct. A WAF reduces exposure while you fix the root cause.' },
          { text: 'Permanently fixing vulnerabilities in the code', feedback: 'A WAF filters traffic; it does not fix the code.' },
          { text: 'Replacing secure coding entirely', feedback: 'It is a layer, not a substitute for secure code.' },
        ] },
        { title: 'Its limits', text: 'Why is a WAF not a cure?', choices: [
          { text: 'Rules can be bypassed with novel encodings, and it cannot understand app-specific logic flaws', right: true, feedback: 'Correct. WAFs are bypassable and blind to business-logic bugs.' },
          { text: 'It is too expensive to run', feedback: 'Cost aside, the point is that it does not fix the flaw.' },
          { text: 'It blocks all legitimate traffic', feedback: 'A tuned WAF allows legitimate traffic; the issue is it is not a fix.' },
        ] },
        { title: 'Proper use', text: 'A serious SQL injection is found in production. What do you do?', choices: [
          { text: 'Deploy a WAF rule to blunt it immediately, then fix the code with parameterisation and remove the rule after', right: true, feedback: 'Correct. Virtual patch now, real fix soon.' },
          { text: 'Rely on the WAF rule indefinitely and never touch the code', feedback: 'The flaw remains and the rule will eventually be bypassed.' },
          { text: 'Do nothing until the next release', feedback: 'Leaving a known injection live is unacceptable.' },
        ] },
        { title: 'Monitoring value', text: 'What other benefit does a WAF give?', choices: [
          { text: 'Visibility: logging and alerting on attack attempts feeds your monitoring', right: true, feedback: 'Correct. WAF logs are useful detection signal.' },
          { text: 'It makes code reviews unnecessary', feedback: 'Reviews and secure coding remain essential.' },
          { text: 'None at all', feedback: 'The logging and alerting are genuinely useful.' },
        ] },
      ],
      ending: { title: 'Stopgap and sensor, not a fix', text: 'A WAF filters common attacks and gives a virtual patch and useful logs, but it is bypassable and blind to logic flaws — use it to buy time while you fix the code.' },
      hints: ['A WAF buys time (virtual patching) and adds visibility; it does not fix flaws.', 'Always follow a WAF rule with a real code fix.'],
      realityNote: 'WAFs (ModSecurity, cloud WAFs) are valuable for virtual patching and detection, but every WAF ruleset has bypasses; the durable fix is always in the application.',
    });
  }),
  tmpl(8, 5, 'intermediate', 'waf-rule-tradeoff', 'Tune a WAF rule for false positives', 'E1', 20, 'Weigh a rule\'s blocked attacks against the legitimate traffic it breaks.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Blocking attacks without breaking users\n\nFor **${a.host}**, judge a candidate WAF rule from its test results. Write \`ruleStats(result)\` where \`result = { attacksBlocked, attacksTotal, legitBlocked, legitTotal }\`, returning \`{ detection, falsePositiveRate }\` each rounded to 2 decimals (0 when the denominator is 0):\n\n- \`detection\` = \`attacksBlocked / attacksTotal\`;\n- \`falsePositiveRate\` = \`legitBlocked / legitTotal\`.\n\nThen \`deployable(result)\`: return \`true\` only when \`detection >= 0.9\` **and** \`falsePositiveRate <= 0.01\`.`,
      hints: ['Guard divide-by-zero, returning 0.', 'A deployable rule catches most attacks and breaks almost no legitimate traffic.'],
      starter: `// ${a.app}: WAF rule tuning\nfunction ruleStats(result) {\n}\n\nfunction deployable(result) {\n}\n`,
      checks: [
        fn('ruleStats computes the rates', 'ruleStats', [
          { args: [{ attacksBlocked: 95, attacksTotal: 100, legitBlocked: 1, legitTotal: 1000 }], expected: { detection: 0.95, falsePositiveRate: 0 } },
          { args: [{ attacksBlocked: 50, attacksTotal: 100, legitBlocked: 50, legitTotal: 1000 }], expected: { detection: 0.5, falsePositiveRate: 0.05 } },
          { args: [{ attacksBlocked: 0, attacksTotal: 0, legitBlocked: 0, legitTotal: 0 }], expected: { detection: 0, falsePositiveRate: 0 } },
        ]),
        fn('deployable applies both thresholds', 'deployable', [
          { args: [{ attacksBlocked: 95, attacksTotal: 100, legitBlocked: 1, legitTotal: 1000 }], expected: true },
          { args: [{ attacksBlocked: 95, attacksTotal: 100, legitBlocked: 50, legitTotal: 1000 }], expected: false },
          { args: [{ attacksBlocked: 50, attacksTotal: 100, legitBlocked: 0, legitTotal: 1000 }], expected: false },
        ]),
      ],
      solution: `function ruleStats(result) {\n  const r2 = (x) => Math.round(x * 100) / 100;\n  const detection = result.attacksTotal ? r2(result.attacksBlocked / result.attacksTotal) : 0;\n  const falsePositiveRate = result.legitTotal ? r2(result.legitBlocked / result.legitTotal) : 0;\n  return { detection, falsePositiveRate };\n}\nfunction deployable(result) {\n  const s = ruleStats(result);\n  return s.detection >= 0.9 && s.falsePositiveRate <= 0.01;\n}`,
      realityNote: 'WAF rules are tuned exactly on this trade-off: a rule that blocks legitimate traffic gets disabled, so detection must come without a meaningful false-positive rate.',
    });
  }),
  tmpl(8, 5, 'advanced', 'virtual-patch-lifecycle', 'Track a virtual patch to its real fix', 'E1', 25, 'Manage the lifecycle so a WAF rule is retired once the code is fixed and verified.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Close the loop\n\nOn **${a.host}**, every WAF virtual patch must end in a code fix. Write \`patchState(patch, now)\` where \`patch = { deployedAt, codeFixedAt, verifiedAt, slaSeconds }\` (timestamps are seconds or \`null\`):\n\n- if \`verifiedAt\` is a number → \`"resolved"\` (safe to retire the rule);\n- else if \`codeFixedAt\` is a number → \`"fix-pending-verify"\`;\n- else if \`now - deployedAt > slaSeconds\` → \`"overdue"\`;\n- else → \`"mitigated"\`.\n\nThen \`canRetireRule(patch, now)\`: return \`true\` only when \`patchState\` is \`"resolved"\`.`,
      hints: ['Check verified, then fixed, then the SLA window.', 'Retire the WAF rule only once the fix is verified.'],
      starter: `// ${a.app}: virtual patch lifecycle\nfunction patchState(patch, now) {\n}\n\nfunction canRetireRule(patch, now) {\n}\n`,
      checks: [
        fn('patchState tracks the lifecycle', 'patchState', [
          { args: [{ deployedAt: 0, codeFixedAt: 10, verifiedAt: 20, slaSeconds: 100 }, 30], expected: 'resolved' },
          { args: [{ deployedAt: 0, codeFixedAt: 10, verifiedAt: null, slaSeconds: 100 }, 30], expected: 'fix-pending-verify' },
          { args: [{ deployedAt: 0, codeFixedAt: null, verifiedAt: null, slaSeconds: 100 }, 200], expected: 'overdue' },
          { args: [{ deployedAt: 0, codeFixedAt: null, verifiedAt: null, slaSeconds: 100 }, 50], expected: 'mitigated' },
        ]),
        fn('canRetireRule only when resolved', 'canRetireRule', [
          { args: [{ deployedAt: 0, codeFixedAt: 10, verifiedAt: 20, slaSeconds: 100 }, 30], expected: true },
          { args: [{ deployedAt: 0, codeFixedAt: 10, verifiedAt: null, slaSeconds: 100 }, 30], expected: false },
        ]),
      ],
      solution: `function patchState(patch, now) {\n  if (typeof patch.verifiedAt === "number") return "resolved";\n  if (typeof patch.codeFixedAt === "number") return "fix-pending-verify";\n  if (now - patch.deployedAt > patch.slaSeconds) return "overdue";\n  return "mitigated";\n}\nfunction canRetireRule(patch, now) {\n  return patchState(patch, now) === "resolved";\n}`,
      realityNote: 'Mature teams track virtual patches so a WAF rule is never the permanent answer: the rule is retired only once the code fix is shipped and verified.',
    });
  }),
];
