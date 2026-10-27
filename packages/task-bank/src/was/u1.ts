/** Unit 1: the web platform and its attack surface — reading HTTP, the browser security model,
 * trust boundaries, mapping your own attack surface, and a safe practice lab. Defensive throughout. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U1: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 1.1 HTTP as a defender reads it */
  tmpl(1, 1, 'beginner', 'parse-request-line', 'Read an HTTP request line', 'E1', 15, 'Parse the first line of an HTTP request into method, path and version, and flag unsafe methods.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## What the server receives\n\nEvery request to **${a.host}** (${a.org}) begins with a request line like \`GET /fees?id=7 HTTP/1.1\`. A defender reads it before trusting anything in it.\n\nWrite two functions:\n\n1. \`parseRequestLine(line)\` returns \`{ method, path, version }\` by splitting on single spaces. For a line that does not have exactly three parts, return \`null\`.\n2. \`isSafeMethod(method)\` returns \`true\` only for the read-only methods \`GET\`, \`HEAD\` and \`OPTIONS\` (methods that must not change server state).`,
      hints: ['line.split(" ") gives the three parts; check there are exactly three.', 'Safe (read-only) methods are GET, HEAD and OPTIONS; POST, PUT, PATCH and DELETE change state.'],
      starter: `// ${a.app}: read the request line\nfunction parseRequestLine(line) {\n}\n\nfunction isSafeMethod(method) {\n}\n\nconsole.log(parseRequestLine("GET /home HTTP/1.1"));\n`,
      checks: [
        fn('parseRequestLine splits the line', 'parseRequestLine', [
          { args: ['GET /fees?id=7 HTTP/1.1'], expected: { method: 'GET', path: '/fees?id=7', version: 'HTTP/1.1' } },
          { args: ['POST /login HTTP/2'], expected: { method: 'POST', path: '/login', version: 'HTTP/2' } },
          { args: ['garbage'], expected: null },
          { args: ['GET /a b HTTP/1.1'], expected: null },
        ]),
        fn('isSafeMethod flags only read-only methods', 'isSafeMethod', [
          { args: ['GET'], expected: true }, { args: ['HEAD'], expected: true }, { args: ['OPTIONS'], expected: true },
          { args: ['POST'], expected: false }, { args: ['DELETE'], expected: false }, { args: ['PUT'], expected: false },
        ]),
      ],
      solution: `function parseRequestLine(line) {\n  const parts = line.split(" ");\n  if (parts.length !== 3) return null;\n  return { method: parts[0], path: parts[1], version: parts[2] };\n}\nfunction isSafeMethod(method) {\n  return method === "GET" || method === "HEAD" || method === "OPTIONS";\n}`,
      realityNote: 'Safe methods (GET, HEAD, OPTIONS) are expected to have no side effects; a GET that changes data is a classic design flaw that CSRF and pre-fetching abuse.',
    });
  }),
  tmpl(1, 1, 'intermediate', 'parse-headers', 'Parse and normalise request headers', 'E1', 20, 'Turn raw header lines into a lookup with lower-cased names, and read a bearer token safely.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Headers are case-insensitive\n\nAn attacker may send \`Content-Type\`, \`content-type\` or \`CONTENT-TYPE\`; your code must treat them the same. For **${a.host}**:\n\n1. \`parseHeaders(lines)\` takes an array of raw header lines (\`"Name: value"\`) and returns an object keyed by the **lower-cased** name with the value trimmed. Ignore any line without a colon.\n2. \`bearerToken(headers)\` takes the object from \`parseHeaders\` and returns the token from an \`Authorization: Bearer <token>\` header, or \`null\` if there is no bearer token.`,
      hints: ['Split each line at the first ":" only — values can contain colons.', 'Look up headers["authorization"] and check it starts with "Bearer ".'],
      starter: `// ${a.app}: normalise headers\nfunction parseHeaders(lines) {\n}\n\nfunction bearerToken(headers) {\n}\n`,
      checks: [
        fn('parseHeaders lower-cases names and trims values', 'parseHeaders', [
          { args: [['Content-Type: text/html', 'HOST:  example.test ']], expected: { 'content-type': 'text/html', host: 'example.test' } },
          { args: [['Authorization: Bearer abc.def', 'bad line', 'X-Trace: 12:34:56']], expected: { authorization: 'Bearer abc.def', 'x-trace': '12:34:56' } },
          { args: [[]], expected: {} },
        ]),
        fn('bearerToken reads the token', 'bearerToken', [
          { args: [{ authorization: 'Bearer abc.def' }], expected: 'abc.def' },
          { args: [{ authorization: 'Basic xyz' }], expected: null },
          { args: [{}], expected: null },
        ]),
      ],
      solution: `function parseHeaders(lines) {\n  const out = {};\n  for (const line of lines) {\n    const i = line.indexOf(":");\n    if (i < 0) continue;\n    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();\n  }\n  return out;\n}\nfunction bearerToken(headers) {\n  const h = headers["authorization"];\n  if (typeof h === "string" && h.startsWith("Bearer ")) return h.slice(7);\n  return null;\n}`,
      realityNote: 'HTTP header names are case-insensitive by specification. Code that compares them case-sensitively has been the root of real authentication bypasses.',
    });
  }),
  tmpl(1, 1, 'advanced', 'classify-status', 'Classify responses an attacker learns from', 'E1', 20, 'Group status codes into classes and decide which responses leak useful information.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## What the response reveals\n\nResponses tell an attacker as much as requests. For **${a.host}**:\n\n1. \`statusClass(code)\` returns \`"informational"\`, \`"success"\`, \`"redirect"\`, \`"client-error"\` or \`"server-error"\` for the 1xx–5xx ranges, and \`"unknown"\` for anything outside 100–599.\n2. \`leaksExistence(onMissing, onWrongPassword)\` returns \`true\` when a login tells an attacker that an account exists — i.e. the two cases return **different** status codes. Returning the same code (e.g. 401 for both) does not leak, so return \`false\` then.`,
      hints: ['Math.floor(code / 100) gives 1..5; guard the 100..599 range first.', 'Existence leaks when onMissing !== onWrongPassword.'],
      starter: `// ${a.app}: classify responses\nfunction statusClass(code) {\n}\n\nfunction leaksExistence(onMissing, onWrongPassword) {\n}\n`,
      checks: [
        fn('statusClass groups the ranges', 'statusClass', [
          { args: [100], expected: 'informational' }, { args: [200], expected: 'success' }, { args: [302], expected: 'redirect' },
          { args: [404], expected: 'client-error' }, { args: [500], expected: 'server-error' }, { args: [700], expected: 'unknown' }, { args: [99], expected: 'unknown' },
        ]),
        fn('leaksExistence spots the difference', 'leaksExistence', [
          { args: [404, 401], expected: true }, { args: [401, 401], expected: false }, { args: [200, 403], expected: true },
        ]),
      ],
      solution: `function statusClass(code) {\n  if (code < 100 || code > 599) return "unknown";\n  return { 1: "informational", 2: "success", 3: "redirect", 4: "client-error", 5: "server-error" }[Math.floor(code / 100)];\n}\nfunction leaksExistence(onMissing, onWrongPassword) {\n  return onMissing !== onWrongPassword;\n}`,
      realityNote: 'User enumeration through different responses for "no such account" and "wrong password" is a real and common finding; good logins answer identically either way.',
    });
  }),

  /* ------------------------------------------------------------------ 1.2 the browser security model */
  tmpl(1, 2, 'beginner', 'same-origin', 'Decide when two URLs share an origin', 'E1', 20, 'Implement the same-origin check: scheme, host and port must all match.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The same-origin policy\n\nThe browser isolates pages by **origin** = scheme + host + port. Two URLs share an origin only when all three match (a missing port means the default for the scheme: 80 for http, 443 for https).\n\nWrite \`sameOrigin(a, b)\` returning \`true\` when the two URL strings have the same origin. Use \`new URL(...)\`. Ports differ: \`https://${a.host}\` and \`https://${a.host}:8443\` are **different** origins.`,
      hints: ['new URL(u) gives .protocol, .hostname and .port (empty for the default).', 'Compute an effective port: url.port || (url.protocol === "https:" ? "443" : "80").'],
      starter: `// ${a.app}: same-origin check\nfunction sameOrigin(a, b) {\n}\n\nconsole.log(sameOrigin("https://${a.host}/a", "https://${a.host}/b"));\n`,
      checks: [
        fn('sameOrigin compares scheme, host and port', 'sameOrigin', [
          { args: [`https://${a.host}/a`, `https://${a.host}/b?x=1`], expected: true },
          { args: [`https://${a.host}`, `http://${a.host}`], expected: false },
          { args: [`https://${a.host}`, `https://${a.host}:8443`], expected: false },
          { args: [`https://${a.host}`, `https://evil.test`], expected: false },
          { args: [`https://${a.host}:443/x`, `https://${a.host}/y`], expected: true },
        ]),
      ],
      solution: `function sameOrigin(a, b) {\n  const port = (u) => u.port || (u.protocol === "https:" ? "443" : "80");\n  const x = new URL(a), y = new URL(b);\n  return x.protocol === y.protocol && x.hostname === y.hostname && port(x) === port(y);\n}`,
      realityNote: 'The same-origin policy is the backbone of browser security. Many cross-origin features (CORS, postMessage, cookies) are exceptions carved out of it, each with its own pitfalls.',
    });
  }),
  tmpl(1, 2, 'intermediate', 'cookie-scope', 'Decide whether a cookie is sent', 'E1', 25, 'Implement the host and path rules that decide when the browser attaches a cookie.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## When does the browser send a cookie?\n\nA cookie set for **${a.host}** should only go to the right requests. Write \`cookieSent(cookie, request)\` where \`cookie = { domain, path, secure }\` and \`request = { host, path, scheme }\`. Return \`true\` only when **all** hold:\n\n- host matches: \`request.host === cookie.domain\` (exact host; this lab does not do domain sub-matching);\n- path matches: \`request.path === cookie.path\` or starts with \`cookie.path\` followed by \`/\`;\n- if \`cookie.secure\` is true, \`request.scheme\` must be \`"https"\`.`,
      hints: ['Path match: request.path === cookie.path || request.path.startsWith(cookie.path.replace(/\\/$/, "") + "/").', 'A Secure cookie must never ride an http request.'],
      starter: `// ${a.app}: cookie scope\nfunction cookieSent(cookie, request) {\n}\n`,
      checks: [
        fn('cookieSent applies host, path and Secure', 'cookieSent', [
          { args: [{ domain: a.host, path: '/', secure: true }, { host: a.host, path: '/account', scheme: 'https' }], expected: true },
          { args: [{ domain: a.host, path: '/', secure: true }, { host: a.host, path: '/account', scheme: 'http' }], expected: false },
          { args: [{ domain: a.host, path: '/admin', secure: false }, { host: a.host, path: '/admin/users', scheme: 'http' }], expected: true },
          { args: [{ domain: a.host, path: '/admin', secure: false }, { host: a.host, path: '/administration', scheme: 'http' }], expected: false },
          { args: [{ domain: a.host, path: '/', secure: false }, { host: 'evil.test', path: '/', scheme: 'http' }], expected: false },
        ]),
      ],
      solution: `function cookieSent(cookie, request) {\n  if (request.host !== cookie.domain) return false;\n  const base = cookie.path.replace(/\\/$/, "");\n  const pathOk = request.path === cookie.path || request.path.startsWith(base + "/");\n  if (!pathOk) return false;\n  if (cookie.secure && request.scheme !== "https") return false;\n  return true;\n}`,
      realityNote: 'Cookie scoping rules are subtle, and getting them wrong (too broad a domain or path) leaks session cookies to parts of a site that should not see them.',
    });
  }),
  tmpl(1, 2, 'advanced', 'trust-boundary-map', 'Map where data crosses a trust boundary', 'E10', 20, 'Decide, for each hop in a request, whether data crosses from less-trusted to more-trusted.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Where is the data no longer trusted?\n\nYou are reviewing **${a.org}** (${a.host}). A trust boundary is where data moves from somewhere you do not control to somewhere you do. Classify each point.`,
      steps: [
        { title: 'The browser', text: 'Can you trust validation done only in the browser (JavaScript, HTML `required`, `maxlength`)?', choices: [
          { text: 'No — the client is fully attacker-controlled, so every value must be re-checked on the server', right: true, feedback: 'Correct. Client-side checks help users; they stop no attacker.' },
          { text: 'Yes — if the form enforces it, the server receives only valid data', feedback: 'An attacker bypasses the form and sends anything they like.' },
          { text: 'Only for numbers, not text', feedback: 'All client input is untrusted regardless of type.' },
        ] },
        { title: 'The network', text: 'The request crosses a cafe Wi-Fi and the public internet to reach the server. What protects it in transit?', choices: [
          { text: 'HTTPS (TLS) — without it, anyone on the path can read and change the request', right: true, feedback: 'Correct. TLS gives confidentiality and integrity in transit.' },
          { text: 'Nothing is needed; the data is already validated', feedback: 'Validation does not stop interception or tampering on the wire.' },
          { text: 'A strong password is enough', feedback: 'A password does not encrypt the connection.' },
        ] },
        { title: 'The application to the database', text: 'The app builds a query from user input. Where is the boundary?', choices: [
          { text: 'Between the application and the database — input must be parameterised, never concatenated into SQL', right: true, feedback: 'Correct. Mixing untrusted data into query text is the root of injection.' },
          { text: 'There is no boundary; both are the server', feedback: 'The query interpreter is a separate trust domain; data must stay data.' },
          { text: 'Only if the database is on another machine', feedback: 'The boundary exists even on the same host.' },
        ] },
        { title: 'A third-party API', text: 'The app calls a payments provider and trusts its response. What is the risk?', choices: [
          { text: 'The response is still external input — validate it and fail safe if it is malformed or unexpected', right: true, feedback: 'Correct. A dependency is outside your trust boundary too.' },
          { text: 'Third parties are trusted partners, so their data is safe', feedback: 'A compromised or misbehaving dependency can feed you bad data.' },
          { text: 'Only inbound requests matter, not responses', feedback: 'Responses you act on are input as well.' },
        ] },
      ],
      ending: { title: 'Trust nothing you did not produce', text: 'The client, the network, the query interpreter and third parties are all boundaries. Validate on the server, encrypt in transit, parameterise queries and check what dependencies return.' },
      hints: ['Ask for each hop: who controls this data, and where does it become "ours"?', 'Client-side checks are for usability; server-side checks are for security.'],
      realityNote: 'Threat modelling methods such as STRIDE start by drawing these boundaries on a data-flow diagram; most web risks live exactly where data crosses one.',
    });
  }),

  /* ------------------------------------------------------------------ 1.3 trust boundaries */
  tmpl(1, 3, 'beginner', 'never-trust-client', 'Re-check a client value on the server', 'E1', 20, 'Recompute a price on the server instead of trusting the amount the browser submitted.', (v) => {
    const a = appOf(v);
    const unit = v.int(5, 20);
    return js({
      instructions: `## Never trust a submitted total\n\nA checkout on **${a.host}** sends the cart and, foolishly, the total. An attacker edits the total to 1. Recompute it server-side instead.\n\n1. \`serverTotal(cart, catalogue)\`: \`cart\` is an array of \`{ sku, qty }\`; \`catalogue\` maps \`sku\` to a unit price. Return the sum of \`price * qty\`. If any sku is not in the catalogue, return \`null\` (reject the order).\n2. \`acceptable(serverValue, clientClaim)\`: return \`true\` only when \`serverValue\` is not null and equals \`clientClaim\`. The server value is the source of truth.`,
      hints: ['Loop the cart; if catalogue[item.sku] is undefined, return null.', 'acceptable is just serverValue !== null && serverValue === clientClaim.'],
      starter: `// ${a.app}: recompute the total\nfunction serverTotal(cart, catalogue) {\n}\n\nfunction acceptable(serverValue, clientClaim) {\n}\n`,
      checks: [
        fn('serverTotal recomputes from the catalogue', 'serverTotal', [
          { args: [[{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }], { A: unit, B: 3 }], expected: unit * 2 + 3 },
          { args: [[{ sku: 'A', qty: 1 }], { A: unit }], expected: unit },
          { args: [[{ sku: 'X', qty: 1 }], { A: unit }], expected: null },
          { args: [[], { A: unit }], expected: 0 },
        ]),
        fn('acceptable trusts only the server value', 'acceptable', [
          { args: [unit * 2 + 3, unit * 2 + 3], expected: true },
          { args: [unit * 2 + 3, 1], expected: false },
          { args: [null, 1], expected: false },
        ]),
      ],
      solution: `function serverTotal(cart, catalogue) {\n  let total = 0;\n  for (const item of cart) {\n    const price = catalogue[item.sku];\n    if (price === undefined) return null;\n    total += price * item.qty;\n  }\n  return total;\n}\nfunction acceptable(serverValue, clientClaim) {\n  return serverValue !== null && serverValue === clientClaim;\n}`,
      realityNote: 'Trusting a client-submitted price or total is a textbook business-logic flaw; the server must recompute anything that matters from data it controls.',
    });
  }),
  tmpl(1, 3, 'intermediate', 'enforce-server-limit', 'Enforce a limit the client cannot raise', 'E1', 20, 'Clamp a withdrawal to the server-side balance and daily limit, ignoring any client hint.', (v) => {
    const a = appOf(v);
    const limit = v.pick([500, 1000, 2000]);
    return js({
      instructions: `## The limit lives on the server\n\nOn **${a.host}**, a withdrawal request carries an amount. The browser also "helpfully" sends \`maxAllowed\`, but you must ignore it. Write \`withdraw(amount, account)\` where \`account = { balance, withdrawnToday, dailyLimit }\`. Return an object:\n\n- if \`amount <= 0\`: \`{ ok: false, reason: "invalid" }\`;\n- if \`amount > account.balance\`: \`{ ok: false, reason: "insufficient" }\`;\n- if \`account.withdrawnToday + amount > account.dailyLimit\`: \`{ ok: false, reason: "limit" }\`;\n- otherwise \`{ ok: true, newBalance: account.balance - amount }\`.`,
      hints: ['Check the three failure reasons in order, then succeed.', 'Never read a limit from the request; only from the account.'],
      starter: `// ${a.app}: enforce the server-side limit\nfunction withdraw(amount, account) {\n}\n`,
      checks: [
        fn('withdraw enforces balance and daily limit', 'withdraw', [
          { args: [100, { balance: 300, withdrawnToday: 0, dailyLimit: limit }], expected: { ok: true, newBalance: 200 } },
          { args: [0, { balance: 300, withdrawnToday: 0, dailyLimit: limit }], expected: { ok: false, reason: 'invalid' } },
          { args: [400, { balance: 300, withdrawnToday: 0, dailyLimit: limit }], expected: { ok: false, reason: 'insufficient' } },
          { args: [limit, { balance: limit + 100, withdrawnToday: 50, dailyLimit: limit }], expected: { ok: false, reason: 'limit' } },
        ]),
      ],
      solution: `function withdraw(amount, account) {\n  if (amount <= 0) return { ok: false, reason: "invalid" };\n  if (amount > account.balance) return { ok: false, reason: "insufficient" };\n  if (account.withdrawnToday + amount > account.dailyLimit) return { ok: false, reason: "limit" };\n  return { ok: true, newBalance: account.balance - amount };\n}`,
      realityNote: 'Any limit, price or role the client can see, it can change. Security decisions must use server-held state only.',
    });
  }),
  tmpl(1, 3, 'advanced', 'canonical-before-check', 'Canonicalise input before you trust a check', 'E1', 25, 'Normalise a path before deciding it is inside an allowed directory, to defeat traversal tricks.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Check the real value, not the raw one\n\nA download endpoint on **${a.host}** serves files from \`/var/data\`. An attacker sends \`../../etc/passwd\`. Decide safety on the **canonical** path.\n\n1. \`canonical(path)\`: resolve \`.\` and \`..\` segments of a \`/\`-separated absolute path and return the cleaned path (no trailing slash except root). \`..\` at the root stays at the root.\n2. \`insideRoot(root, requested)\`: return \`true\` only when \`canonical(requested)\` equals \`root\` or starts with \`root + "/"\`.`,
      hints: ['Split on "/", drop "" and ".", pop on ".." (but not above root), then rejoin with a leading "/".', 'Compare canonical forms, never the raw strings.'],
      starter: `// ${a.app}: canonicalise before the check\nfunction canonical(path) {\n}\n\nfunction insideRoot(root, requested) {\n}\n`,
      checks: [
        fn('canonical resolves . and ..', 'canonical', [
          { args: ['/var/data/./report.pdf'], expected: '/var/data/report.pdf' },
          { args: ['/var/data/../../etc/passwd'], expected: '/etc/passwd' },
          { args: ['/a/b/../c'], expected: '/a/c' },
          { args: ['/../..'], expected: '/' },
        ]),
        fn('insideRoot uses the canonical path', 'insideRoot', [
          { args: ['/var/data', '/var/data/report.pdf'], expected: true },
          { args: ['/var/data', '/var/data/../../etc/passwd'], expected: false },
          { args: ['/var/data', '/var/database/secret'], expected: false },
          { args: ['/var/data', '/var/data'], expected: true },
        ]),
      ],
      solution: `function canonical(path) {\n  const out = [];\n  for (const seg of path.split("/")) {\n    if (seg === "" || seg === ".") continue;\n    if (seg === "..") out.pop();\n    else out.push(seg);\n  }\n  return "/" + out.join("/");\n}\nfunction insideRoot(root, requested) {\n  const c = canonical(requested);\n  return c === root || c.startsWith(root + "/");\n}`,
      realityNote: 'Validating the raw path and then using a different (resolved) one is a real pattern behind path-traversal bugs; always canonicalise first, then check.',
    });
  }),

  /* ------------------------------------------------------------------ 1.4 mapping your own attack surface */
  tmpl(1, 4, 'beginner', 'endpoint-inventory', 'Inventory the endpoints from an access log', 'E1', 20, 'Build a list of distinct method+path endpoints from access-log lines — your own attack surface.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Know your own surface\n\nBefore you can defend **${a.host}**, you need an inventory of what it exposes. From your access log, list the distinct endpoints.\n\n\`endpoints(logLines)\`: each line looks like \`"GET /fees?id=7 200"\`. Return a **sorted array** of distinct \`"METHOD path"\` strings, where *path* has any \`?query\` removed. Ignore malformed lines (not three space-separated fields).`,
      hints: ['Split each line; take method and the path before "?".', 'Collect into a Set, then [...set].sort().'],
      starter: `// ${a.app}: list the endpoints\nfunction endpoints(logLines) {\n}\n`,
      checks: [
        fn('endpoints lists distinct method+path', 'endpoints', [
          { args: [['GET /fees?id=7 200', 'GET /fees?id=9 200', 'POST /login 302', 'bad']], expected: ['GET /fees', 'POST /login'] },
          { args: [['GET / 200', 'GET /about 200', 'GET / 200']], expected: ['GET /', 'GET /about'] },
          { args: [[]], expected: [] },
        ]),
      ],
      solution: `function endpoints(logLines) {\n  const set = new Set();\n  for (const line of logLines) {\n    const parts = line.split(" ");\n    if (parts.length !== 3) continue;\n    set.add(parts[0] + " " + parts[1].split("?")[0]);\n  }\n  return [...set].sort();\n}`,
      realityNote: 'Attack-surface mapping is the first phase of any assessment; defenders do the same from logs and route tables to find forgotten or undocumented endpoints.',
    });
  }),
  tmpl(1, 4, 'intermediate', 'find-parameters', 'Collect the parameters each endpoint accepts', 'E1', 25, 'Group the query parameters seen per endpoint, so every input gets reviewed.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Every parameter is an input to review\n\nFor **${a.host}**, build a map from each path to the **set of parameter names** seen on it.\n\n\`parametersByPath(urls)\`: each entry is a path with an optional query, e.g. \`"/search?q=shoes&page=2"\`. Return an object mapping the path (without query) to a **sorted array of distinct parameter names**. A path with no query maps to \`[]\`.`,
      hints: ['Split on "?"; the query is "a=1&b=2" — split on "&", take the part before "=".', 'Use a Set per path, then sort the names.'],
      starter: `// ${a.app}: parameters per endpoint\nfunction parametersByPath(urls) {\n}\n`,
      checks: [
        fn('parametersByPath groups parameter names', 'parametersByPath', [
          { args: [['/search?q=shoes&page=2', '/search?q=hats&sort=asc', '/home']], expected: { '/search': ['page', 'q', 'sort'], '/home': [] } },
          { args: [['/fees?id=7', '/fees?id=9&format=pdf']], expected: { '/fees': ['format', 'id'] } },
          { args: [[]], expected: {} },
        ]),
      ],
      solution: `function parametersByPath(urls) {\n  const map = {};\n  for (const url of urls) {\n    const [path, query] = url.split("?");\n    const set = map[path] instanceof Set ? map[path] : (map[path] = new Set());\n    if (query) for (const pair of query.split("&")) set.add(pair.split("=")[0]);\n  }\n  const out = {};\n  for (const path of Object.keys(map)) out[path] = [...map[path]].sort();\n  return out;\n}`,
      realityNote: 'Each parameter is a place where tainted data enters; listing them per endpoint is how both attackers and reviewers make sure none is missed.',
    });
  }),
  tmpl(1, 4, 'advanced', 'flag-hidden-admin', 'Flag sensitive endpoints reachable without auth', 'E1', 25, 'Cross-reference routes and auth rules to find sensitive paths missing a guard.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Find the gaps before an attacker does\n\nFor **${a.host}**, you have the route list and the set of paths that require authentication. Any **sensitive** route (path containing \`/admin\` or \`/internal\`) that is **not** in the protected set is a finding.\n\n\`unprotectedSensitive(routes, protectedPaths)\`: \`routes\` is an array of \`{ method, path }\`; \`protectedPaths\` is an array of path strings. Return a **sorted array** of the \`"METHOD path"\` of every sensitive route whose path is not in \`protectedPaths\`.`,
      hints: ['Sensitive = path.includes("/admin") || path.includes("/internal").', 'Put protectedPaths in a Set for lookup; keep routes not in it.'],
      starter: `// ${a.app}: sensitive routes missing a guard\nfunction unprotectedSensitive(routes, protectedPaths) {\n}\n`,
      checks: [
        fn('unprotectedSensitive finds the gaps', 'unprotectedSensitive', [
          { args: [[{ method: 'GET', path: '/admin/users' }, { method: 'GET', path: '/home' }, { method: 'POST', path: '/internal/jobs' }], ['/admin/users']], expected: ['POST /internal/jobs'] },
          { args: [[{ method: 'GET', path: '/admin' }], ['/admin']], expected: [] },
          { args: [[{ method: 'GET', path: '/public' }], []], expected: [] },
        ]),
      ],
      solution: `function unprotectedSensitive(routes, protectedPaths) {\n  const guarded = new Set(protectedPaths);\n  const out = [];\n  for (const r of routes) {\n    const sensitive = r.path.includes("/admin") || r.path.includes("/internal");\n    if (sensitive && !guarded.has(r.path)) out.push(r.method + " " + r.path);\n  }\n  return out.sort();\n}`,
      realityNote: 'Broken function-level authorisation — an admin route that simply is not checked — is one of the most common and highest-impact web findings.',
    });
  }),

  /* ------------------------------------------------------------------ 1.5 a safe practice lab */
  tmpl(1, 5, 'beginner', 'safe-lab-setup', 'Set up a safe place to practise', 'E10', 15, 'Choose an isolated, legal environment for testing a deliberately vulnerable application.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Practise without causing harm\n\nYou want to learn web security hands-on using a deliberately vulnerable practice app (like OWASP Juice Shop) modelled on **${a.org}**. Set up a safe, legal environment.`,
      steps: [
        { title: 'Where to run it', text: 'Where should the vulnerable app and your tools run?', choices: [
          { text: 'On an isolated local virtual machine or container with no access to other systems', right: true, feedback: 'Correct. Isolation keeps your practice from touching anything real.' },
          { text: 'On the college\'s shared production server, to be realistic', feedback: 'Never run intentionally vulnerable software on shared or production systems.' },
          { text: 'On a public cloud host open to the internet', feedback: 'A vulnerable app exposed to the internet will be compromised and may harm others.' },
        ] },
        { title: 'What may you test', text: 'Which targets are you allowed to attack while learning?', choices: [
          { text: 'Only systems you own or have explicit written permission to test, plus apps built for practice', right: true, feedback: 'Correct. Authorisation is what separates testing from a crime.' },
          { text: 'Any site, as long as you do not cause damage', feedback: 'Unauthorised testing is illegal regardless of intent or damage.' },
          { text: 'Any site, if you report what you find afterwards', feedback: 'Permission must come first; reporting later does not make it lawful.' },
        ] },
        { title: 'Network exposure', text: 'How should the practice VM reach the network?', choices: [
          { text: 'Host-only or NAT networking, so the tools and target can talk but nothing external is exposed', right: true, feedback: 'Correct. Keep the blast radius to the VM.' },
          { text: 'Bridged to the campus LAN so classmates can join in', feedback: 'That exposes a vulnerable app to the whole network.' },
          { text: 'Full internet access with port forwarding', feedback: 'That invites real attackers to your vulnerable host.' },
        ] },
        { title: 'Resetting', text: 'How do you recover after breaking the app during practice?', choices: [
          { text: 'Take a snapshot first and restore it, or rebuild the container from its image', right: true, feedback: 'Correct. Snapshots and immutable images make practice repeatable.' },
          { text: 'Reinstall the whole machine each time', feedback: 'Wasteful; a snapshot or container rebuild is the normal way.' },
          { text: 'Keep using the broken state', feedback: 'You want a known-clean baseline for each exercise.' },
        ] },
      ],
      ending: { title: 'Isolated, authorised, repeatable', text: 'Run practice apps on an isolated VM or container, test only what you are permitted to, keep it off public and shared networks, and use snapshots or images to reset.' },
      hints: ['The rule that makes testing legal is authorisation, in writing, before you start.', 'Isolation plus snapshots gives you a safe, repeatable lab.'],
      realityNote: 'Professionals run practice targets such as OWASP Juice Shop, DVWA and WebGoat in isolated VMs or containers; the law turns on authorisation, which is why engagements begin with a signed scope.',
    });
  }),
  tmpl(1, 5, 'intermediate', 'intercepting-proxy', 'Use an intercepting proxy responsibly', 'E10', 20, 'Configure and scope an intercepting proxy so it only touches the target you are allowed to test.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Seeing the real traffic\n\nAn intercepting proxy (such as OWASP ZAP or Burp) sits between your browser and **${a.host}** so you can read and replay the actual requests. Configure it safely for an authorised test.`,
      steps: [
        { title: 'Scope', text: 'How do you keep the proxy from touching out-of-scope systems?', choices: [
          { text: 'Set an explicit target scope and limit active scanning to it; leave everything else out', right: true, feedback: 'Correct. Scoping keeps you inside your authorisation.' },
          { text: 'Scan everything the browser visits', feedback: 'That risks hitting third-party and out-of-scope hosts you are not permitted to test.' },
          { text: 'Turn scope off for convenience', feedback: 'Scope is what keeps an active scan lawful and safe.' },
        ] },
        { title: 'The proxy certificate', text: 'To read HTTPS the proxy asks you to trust its CA certificate. What is the safe practice?', choices: [
          { text: 'Install it only in the testing browser or VM, and remove it when done', right: true, feedback: 'Correct. Limit the trust to the practice environment.' },
          { text: 'Install it system-wide on your main laptop permanently', feedback: 'That lets the proxy intercept all your own TLS traffic indefinitely.' },
          { text: 'Share the certificate and its key with classmates', feedback: 'A shared interception CA is a serious risk; keep it to your VM.' },
        ] },
        { title: 'Active vs passive', text: 'You are early in the test and still mapping the app. Which mode first?', choices: [
          { text: 'Passive (observe traffic) first; run active scans only within scope once you understand the app', right: true, feedback: 'Correct. Passive first avoids sending untested payloads blindly.' },
          { text: 'Full active scan immediately on everything', feedback: 'Blind active scanning can break data or hit out-of-scope hosts.' },
          { text: 'Never use passive mode', feedback: 'Passive observation is low-risk and informative; use it.' },
        ] },
        { title: 'Handling captured data', text: 'The proxy log now contains a test user\'s session token and personal data. What do you do with it?', choices: [
          { text: 'Store it securely, use it only for the test, and delete it afterwards per the engagement rules', right: true, feedback: 'Correct. Captured data is sensitive and handled under the rules of engagement.' },
          { text: 'Keep the full logs indefinitely on your laptop', feedback: 'Captured secrets and personal data should not linger.' },
          { text: 'Post interesting requests publicly to ask for help', feedback: 'That leaks secrets and possibly personal data.' },
        ] },
      ],
      ending: { title: 'Scoped, contained, cleaned up', text: 'Scope the proxy to your target, trust its CA only in the test environment, observe before you actively scan, and handle and delete captured data under the engagement rules.' },
      hints: ['Scope and passive-first keep an intercepting proxy inside its authorisation.', 'The interception CA and the captured traffic are both sensitive; contain them.'],
      realityNote: 'ZAP and Burp are the standard intercepting proxies; misusing their CA certificate or running an unscoped active scan are common, avoidable mistakes.',
    });
  }),
  tmpl(1, 5, 'advanced', 'rules-of-engagement', 'Agree the rules before testing', 'E10', 20, 'Decide what a rules-of-engagement document must settle before any authorised test begins.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Nothing starts without the rules\n\n**${a.org}** has asked you to assess **${a.host}**. Before touching it, you agree the rules of engagement in writing.`,
      steps: [
        { title: 'Authorisation', text: 'What makes the test lawful?', choices: [
          { text: 'Written authorisation from someone with authority over the system, naming the targets and dates', right: true, feedback: 'Correct. Signed, specific authorisation is non-negotiable.' },
          { text: 'A verbal "go ahead" from a developer', feedback: 'It must be in writing from someone authorised to give it.' },
          { text: 'The fact that the site is reachable from the internet', feedback: 'Reachability is not permission.' },
        ] },
        { title: 'Scope', text: 'How is scope defined?', choices: [
          { text: 'Exactly which hosts, apps and accounts are in scope, and what is explicitly out', right: true, feedback: 'Correct. Clear in- and out-of-scope lists prevent overreach.' },
          { text: '"Everything the company owns"', feedback: 'Vague scope leads to touching systems you should not.' },
          { text: 'Left open so you can follow leads anywhere', feedback: 'Following leads out of scope is how authorised tests become incidents.' },
        ] },
        { title: 'Dangerous actions', text: 'May you run tests that could disrupt service or modify data?', choices: [
          { text: 'Only what the rules permit; destructive or denial-of-service tests need explicit sign-off and a safe window', right: true, feedback: 'Correct. High-impact actions are agreed in advance, if at all.' },
          { text: 'Yes, anything goes once you are authorised', feedback: 'Authorisation is bounded; it rarely includes outages or data loss.' },
          { text: 'No test can ever change anything', feedback: 'Some tests may, but only with explicit permission and care.' },
        ] },
        { title: 'If you find real user data', text: 'During the test you can reach real customers\' records. What do you do?', choices: [
          { text: 'Access the minimum needed to prove the issue, do not exfiltrate it, and report it promptly', right: true, feedback: 'Correct. Prove the risk without harming the people in the data.' },
          { text: 'Download it all as evidence', feedback: 'Exfiltrating real personal data causes the harm you are meant to prevent.' },
          { text: 'Keep testing and mention it at the end', feedback: 'Serious exposure of real data is reported promptly, not saved for later.' },
        ] },
        { title: 'Handling findings', text: 'How are findings communicated?', choices: [
          { text: 'Through the agreed secure channel to the client, with enough detail to fix and no public disclosure outside the terms', right: true, feedback: 'Correct. Report securely and follow the disclosure terms.' },
          { text: 'Posted publicly to build your reputation', feedback: 'That breaks confidentiality and can endanger users.' },
          { text: 'Sold to the highest bidder', feedback: 'That is extortion, not security work.' },
        ] },
      ],
      ending: { title: 'Authorised, scoped, careful, confidential', text: 'A test runs only on written, specific authorisation, within an agreed scope, with high-impact actions pre-approved, real data protected, and findings reported securely under the disclosure terms.' },
      hints: ['Everything turns on written, specific authorisation and a clear scope.', 'Real user data is protected even while proving a flaw.'],
      realityNote: 'Rules-of-engagement and scoping documents are standard in professional testing; they protect the client, the users and the tester alike.',
    });
  }),
];
