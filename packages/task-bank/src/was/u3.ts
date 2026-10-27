/** Unit 3: injection — understood so it can be prevented. Learners build parameterised queries,
 * validate identifiers, pass commands as argument lists, and reason about least privilege. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U3: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 3.1 how injection happens, defensively */
  tmpl(3, 1, 'beginner', 'why-injection', 'Understand the root cause of injection', 'E10', 15, 'Reason about why mixing code and data causes injection, and what actually prevents it.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Code and data must stay separate\n\n**${a.org}** builds a database query by joining strings with user input. Understand why that is dangerous and what fixes it.`,
      steps: [
        { title: 'The root cause', text: 'Why can a user\'s input change the meaning of a query?', choices: [
          { text: 'Because the input is concatenated into the query text, so the interpreter can read parts of it as code', right: true, feedback: 'Correct. Mixing untrusted data into code is the root cause of all injection.' },
          { text: 'Because the database is too old', feedback: 'It is a coding pattern, not a database version, that causes it.' },
          { text: 'Because the password is weak', feedback: 'Injection is about data crossing into code, not credentials.' },
        ] },
        { title: 'The real fix', text: 'What actually prevents SQL injection?', choices: [
          { text: 'Parameterised queries (prepared statements): the query structure is fixed and the data is sent separately', right: true, feedback: 'Correct. Parameters keep data as data, never code.' },
          { text: 'Removing the word SELECT from inputs', feedback: 'Blocklists are easily bypassed and miss cases; parameterisation is the fix.' },
          { text: 'Escaping quotes by hand everywhere', feedback: 'Manual escaping is error-prone; parameters are reliable.' },
        ] },
        { title: 'Beyond SQL', text: 'The same root cause appears elsewhere. Where?', choices: [
          { text: 'OS commands, LDAP queries, NoSQL filters, and any interpreter fed concatenated input', right: true, feedback: 'Correct. The pattern repeats wherever data is mixed into a command language.' },
          { text: 'Only in SQL databases', feedback: 'Command, LDAP, NoSQL and template injection share the same cause.' },
          { text: 'Only in old CGI scripts', feedback: 'It is a general pattern, modern frameworks included.' },
        ] },
        { title: 'Defence in depth', text: 'Besides parameterisation, what adds resilience?', choices: [
          { text: 'Input validation/allow-listing and a least-privilege database account, as extra layers', right: true, feedback: 'Correct. Validation and least privilege limit damage if something slips through.' },
          { text: 'Nothing else is worth doing', feedback: 'Layered defences limit the blast radius.' },
          { text: 'Hiding error messages alone', feedback: 'Helpful but not a substitute for parameterisation and least privilege.' },
        ] },
      ],
      ending: { title: 'Keep data as data', text: 'Injection comes from mixing untrusted data into a command language; parameterised queries fix it, with input validation and least privilege as further layers.' },
      hints: ['The one-line cause of injection: untrusted data interpreted as code.', 'Parameterised queries are the fix; validation and least privilege are depth.'],
      realityNote: 'Injection has been near the top of the OWASP list for two decades; prepared statements remain the single most effective fix.',
    });
  }),
  tmpl(3, 1, 'intermediate', 'spot-unsafe-query', 'Tell a safe query from an unsafe one', 'E1', 20, 'Flag query-building code that concatenates input versus code that uses placeholders.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Concatenation is the smell\n\nFor **${a.host}**, flag unsafe query construction. Write \`isParameterised(call)\` where \`call = { text, params }\`:\n\n- Return \`true\` only when \`text\` contains **no** string concatenation of data — model this as: \`text\` must contain at least one \`?\` placeholder and must **not** contain a single quote \`'\` (which would indicate an inlined literal), and \`params\` is an array.\n- Otherwise return \`false\`.\n\nAlso write \`placeholderCount(text)\` returning how many \`?\` placeholders are in \`text\`.`,
      hints: ['Safe: has "?" and no "\'" and Array.isArray(params).', 'Count "?" by splitting: text.split("?").length - 1.'],
      starter: `// ${a.app}: detect unsafe queries\nfunction isParameterised(call) {\n}\n\nfunction placeholderCount(text) {\n}\n`,
      checks: [
        fn('isParameterised accepts only placeholder queries', 'isParameterised', [
          { args: [{ text: 'SELECT * FROM users WHERE id = ?', params: [7] }], expected: true },
          { args: [{ text: "SELECT * FROM users WHERE id = '7'", params: [] }], expected: false },
          { args: [{ text: "SELECT * FROM users WHERE name = '" , params: [] }], expected: false },
          { args: [{ text: 'SELECT 1', params: [] }], expected: false },
          { args: [{ text: 'SELECT * FROM t WHERE a = ? AND b = ?', params: 'x' }], expected: false },
        ]),
        fn('placeholderCount counts placeholders', 'placeholderCount', [
          { args: ['a = ? AND b = ?'], expected: 2 }, { args: ['no params'], expected: 0 }, { args: ['?'], expected: 1 },
        ]),
      ],
      solution: `function isParameterised(call) {\n  return typeof call.text === "string" && call.text.includes("?") && !call.text.includes("'") && Array.isArray(call.params);\n}\nfunction placeholderCount(text) {\n  return text.split("?").length - 1;\n}`,
      realityNote: 'Static analysers and code review flag string-built queries exactly this way; a query that inlines a literal where a placeholder belongs is the classic injection sink.',
    });
  }),
  tmpl(3, 1, 'advanced', 'blind-vs-error', 'Reason about what responses reveal', 'E10', 20, 'Decide how error-based and blind information leaks occur and the defences that remove them.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Removing the oracle\n\nAn injection flaw lets an attacker learn data from how **${a.host}** responds. Reason about the channels and how to close them — the point is to design responses that reveal nothing.`,
      steps: [
        { title: 'Error-based leakage', text: 'The app shows raw database errors. Why does that help an attacker?', choices: [
          { text: 'Errors echo query fragments and data, turning the app into an information oracle', right: true, feedback: 'Correct. Verbose errors leak structure and values.' },
          { text: 'Errors slow the attacker down', feedback: 'They speed the attacker up by revealing internals.' },
          { text: 'Errors are harmless text', feedback: 'They can reveal schema, data and injection success.' },
        ] },
        { title: 'Closing it', text: 'What removes the error oracle?', choices: [
          { text: 'Generic error responses to users, with full detail only in server-side logs', right: true, feedback: 'Correct. Users see generic messages; detail stays internal.' },
          { text: 'Shorter error messages that still include the SQL', feedback: 'Any SQL in the response still leaks.' },
          { text: 'Nothing; errors must be shown', feedback: 'Production errors should be generic.' },
        ] },
        { title: 'Blind leakage', text: 'Even with generic errors, differences in true/false responses or timing can leak data. What is the underlying cause?', choices: [
          { text: 'The injection flaw itself still exists; the response difference is just the channel', right: true, feedback: 'Correct. Fix the injection; the channel disappears with it.' },
          { text: 'The server is too fast', feedback: 'Timing is a symptom; the flaw is the injection.' },
          { text: 'The user guessed well', feedback: 'The flaw is what lets any guessing work.' },
        ] },
        { title: 'The durable fix', text: 'What removes both error-based and blind leakage for good?', choices: [
          { text: 'Parameterised queries so input can never alter the query, plus least privilege to limit reach', right: true, feedback: 'Correct. No injection means no oracle of any kind.' },
          { text: 'Hiding errors and adding random delays', feedback: 'That masks symptoms; the flaw remains exploitable.' },
          { text: 'Blocking the word UNION', feedback: 'Blocklists are bypassable; parameterisation is the fix.' },
        ] },
      ],
      ending: { title: 'Fix the flaw, not the symptom', text: 'Error-based and blind leakage are channels on top of an injection flaw; generic errors help, but parameterised queries and least privilege remove the flaw itself.' },
      hints: ['Verbose errors are an oracle; generic responses remove it.', 'Blind and error-based leaks both vanish once the injection is fixed.'],
      realityNote: 'Whether a leak is error-based or blind, the remediation is identical: remove the injection with parameterisation; response-hardening alone is not enough.',
    });
  }),

  /* ------------------------------------------------------------------ 3.2 harden a login query */
  tmpl(3, 2, 'beginner', 'parameterise-login', 'Build a parameterised login query', 'E1', 20, 'Return the fixed query text and a separate params array instead of concatenating input.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Never build a login query from strings\n\nOn **${a.host}**, replace string-built SQL with a parameterised query. Write \`loginQuery(email)\` returning \`{ text, params }\`:\n\n- \`text\` is exactly \`"SELECT id, pw_hash FROM users WHERE email = ? LIMIT 1"\`;\n- \`params\` is \`[email]\`.\n\nThe email is **never** placed into \`text\`. Also write \`usesPlaceholder(query)\` returning \`true\` only when \`query.text\` includes \`"?"\` and \`query.params.length === 1\`.`,
      hints: ['Return a fixed text string and params: [email].', 'The email only ever appears in params, never in text.'],
      starter: `// ${a.app}: parameterised login\nfunction loginQuery(email) {\n}\n\nfunction usesPlaceholder(query) {\n}\n`,
      checks: [
        fn('loginQuery parameterises the email', 'loginQuery', [
          { args: ['ama@school.test'], expected: { text: 'SELECT id, pw_hash FROM users WHERE email = ? LIMIT 1', params: ['ama@school.test'] } },
          { args: ["x' OR '1'='1"], expected: { text: 'SELECT id, pw_hash FROM users WHERE email = ? LIMIT 1', params: ["x' OR '1'='1"] } },
        ]),
        fn('usesPlaceholder confirms the shape', 'usesPlaceholder', [
          { args: [{ text: 'SELECT id FROM users WHERE email = ?', params: ['a'] }], expected: true },
          { args: [{ text: "SELECT id FROM users WHERE email = 'a'", params: [] }], expected: false },
        ]),
      ],
      solution: `function loginQuery(email) {\n  return { text: "SELECT id, pw_hash FROM users WHERE email = ? LIMIT 1", params: [email] };\n}\nfunction usesPlaceholder(query) {\n  return query.text.includes("?") && query.params.length === 1;\n}`,
      realityNote: 'Notice the injection payload ends up safely inside params: the query structure cannot change, so the classic login bypass simply fails.',
    });
  }),
  tmpl(3, 2, 'intermediate', 'verify-password-safely', 'Verify a password without an injectable query', 'E1', 25, 'Separate the parameterised lookup from a constant-time hash comparison.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Lookup, then compare — both done safely\n\nOn **${a.host}**, a safe login does two separate things. You are given \`findUser(email, db)\` (already parameterised: it returns \`db[email]\` or \`null\`) via the \`db\` map. Write:\n\n1. \`constantTimeEqual(a, b)\`: XOR-based compare with no early return (false if lengths differ).\n2. \`login(email, hash, db)\`: look up the user; if none, return \`{ ok: false }\`. If found, return \`{ ok: true, id: user.id }\` only when \`constantTimeEqual(hash, user.pwHash)\`, else \`{ ok: false }\`. The same \`{ ok: false }\` is returned whether the user is missing or the hash is wrong.`,
      hints: ['Reuse constantTimeEqual for the hash comparison.', 'Both failure paths return the identical { ok: false }.'],
      starter: `// ${a.app}: safe password verification\nfunction findUser(email, db) { return db[email] || null; }\n\nfunction constantTimeEqual(a, b) {\n}\n\nfunction login(email, hash, db) {\n}\n`,
      checks: [
        fn('constantTimeEqual compares safely', 'constantTimeEqual', [
          { args: ['h1', 'h1'], expected: true }, { args: ['h1', 'h2'], expected: false }, { args: ['h', 'hh'], expected: false },
        ]),
        fn('login verifies without leaking existence', 'login', [
          { args: ['ama@t.test', 'HASH', { 'ama@t.test': { id: 5, pwHash: 'HASH' } }], expected: { ok: true, id: 5 } },
          { args: ['ama@t.test', 'WRONG', { 'ama@t.test': { id: 5, pwHash: 'HASH' } }], expected: { ok: false } },
          { args: ['none@t.test', 'HASH', { 'ama@t.test': { id: 5, pwHash: 'HASH' } }], expected: { ok: false } },
        ]),
      ],
      solution: `function findUser(email, db) { return db[email] || null; }\nfunction constantTimeEqual(a, b) {\n  if (a.length !== b.length) return false;\n  let diff = 0;\n  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);\n  return diff === 0;\n}\nfunction login(email, hash, db) {\n  const user = findUser(email, db);\n  if (!user) return { ok: false };\n  return constantTimeEqual(hash, user.pwHash) ? { ok: true, id: user.id } : { ok: false };\n}`,
      realityNote: 'Real logins parameterise the lookup and compare password hashes in constant time; the two steps together resist both injection and enumeration.',
    });
  }),
  tmpl(3, 2, 'advanced', 'safe-dynamic-sort', 'Allow-list a dynamic ORDER BY', 'E1', 25, 'Let users sort by a column without ever concatenating their input into SQL.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Identifiers cannot be parameters\n\nColumn and table names cannot be bound as placeholders, so **${a.host}** must allow-list them. A listing can be sorted by a user-chosen column and direction.\n\n1. \`safeColumn(requested, allowed)\`: return \`requested\` only if it is in the \`allowed\` array; otherwise return \`allowed[0]\` (a safe default).\n2. \`safeDirection(dir)\`: return \`"ASC"\` or \`"DESC"\` — map \`"asc"/"ASC"\` to \`"ASC"\`, \`"desc"/"DESC"\` to \`"DESC"\`, anything else to \`"ASC"\`.\n3. \`orderByClause(requested, dir, allowed)\`: return \`"ORDER BY " + safeColumn(...) + " " + safeDirection(dir)\`, built only from allow-listed pieces.`,
      hints: ['Never place requested into SQL unless it is in the allow-list.', 'Normalise direction to exactly ASC or DESC.'],
      starter: `// ${a.app}: safe dynamic ordering\nfunction safeColumn(requested, allowed) {\n}\n\nfunction safeDirection(dir) {\n}\n\nfunction orderByClause(requested, dir, allowed) {\n}\n`,
      checks: [
        fn('safeColumn allow-lists the column', 'safeColumn', [
          { args: ['price', ['name', 'price', 'date']], expected: 'price' },
          { args: ['pw_hash', ['name', 'price', 'date']], expected: 'name' },
          { args: ['name; DROP TABLE t', ['name', 'price']], expected: 'name' },
        ]),
        fn('safeDirection normalises direction', 'safeDirection', [
          { args: ['asc'], expected: 'ASC' }, { args: ['DESC'], expected: 'DESC' }, { args: ['; DROP'], expected: 'ASC' },
        ]),
        fn('orderByClause builds from safe pieces', 'orderByClause', [
          { args: ['price', 'desc', ['name', 'price']], expected: 'ORDER BY price DESC' },
          { args: ['evil', 'asc', ['name', 'price']], expected: 'ORDER BY name ASC' },
        ]),
      ],
      solution: `function safeColumn(requested, allowed) {\n  return allowed.includes(requested) ? requested : allowed[0];\n}\nfunction safeDirection(dir) {\n  const d = String(dir).toUpperCase();\n  return d === "DESC" ? "DESC" : "ASC";\n}\nfunction orderByClause(requested, dir, allowed) {\n  return "ORDER BY " + safeColumn(requested, allowed) + " " + safeDirection(dir);\n}`,
      realityNote: 'Because identifiers cannot be bound as parameters, dynamic ORDER BY and table names must be chosen from a fixed allow-list — a very common real-world injection sink when they are not.',
    });
  }),

  /* ------------------------------------------------------------------ 3.3 command/LDAP/NoSQL: data as data */
  tmpl(3, 3, 'beginner', 'command-as-args', 'Run a command without a shell', 'E1', 20, 'Build an argument array instead of a shell string so input can never be interpreted as a command.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Pass arguments, not a shell string\n\nOn **${a.host}**, a feature runs an image tool on an uploaded file. Building a shell string lets input inject commands. Instead, build an **argument array** (as you would pass to \`execFile\`, not \`exec\`).\n\n\`convertArgs(input, output)\`: return the array \`["convert", input, "-resize", "800x600", output]\`. The filenames are just array elements — never concatenated into a string — so characters like \`;\` or \`|\` in a filename have no special meaning.\n\nAlso write \`usesShell(command)\` returning \`true\` if the string \`command\` contains any of \`; | & $ \\\`\` (shell metacharacters), else \`false\` — a quick check for code that would be unsafe.`,
      hints: ['Just return the fixed array with input and output in place.', 'usesShell: /[;|&$`]/.test(command).'],
      starter: `// ${a.app}: command as argument array\nfunction convertArgs(input, output) {\n}\n\nfunction usesShell(command) {\n}\n`,
      checks: [
        fn('convertArgs builds an argument array', 'convertArgs', [
          { args: ['in.png', 'out.png'], expected: ['convert', 'in.png', '-resize', '800x600', 'out.png'] },
          { args: ['a; rm -rf /.png', 'out.png'], expected: ['convert', 'a; rm -rf /.png', '-resize', '800x600', 'out.png'] },
        ]),
        fn('usesShell spots metacharacters', 'usesShell', [
          { args: ['convert in.png out.png'], expected: false },
          { args: ['convert in.png; rm -rf /'], expected: true },
          { args: ['echo $(whoami)'], expected: true },
        ]),
      ],
      solution: `function convertArgs(input, output) {\n  return ["convert", input, "-resize", "800x600", output];\n}\nfunction usesShell(command) {\n  return /[;|&$\`]/.test(command);\n}`,
      realityNote: 'Passing an argument array to execFile/spawn (never a string to a shell) is the command-injection equivalent of parameterised queries: data stays data.',
    });
  }),
  tmpl(3, 3, 'intermediate', 'nosql-operator-guard', 'Reject query-operator objects in input', 'E1', 25, 'Stop NoSQL operator injection by rejecting object-valued fields where a scalar is expected.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A string field must be a string\n\nOn **${a.host}**, a NoSQL login matches \`{ email, password }\`. If an attacker sends \`password: { "$ne": null }\`, the filter matches any user. Defend by rejecting non-scalar values and operator keys.\n\n1. \`isScalar(value)\`: return \`true\` only for a string, number or boolean (not objects, arrays, null or undefined).\n2. \`safeEquals(field, value)\`: if \`isScalar(value)\`, return the filter \`{ [field]: value }\`; otherwise return \`null\` (reject the input).\n3. \`hasOperator(obj)\`: return \`true\` if any **own key** of \`obj\` starts with \`"$"\` (a query operator), else \`false\`.`,
      hints: ['isScalar: typeof is "string", "number" or "boolean".', 'Use computed keys { [field]: value } to build the filter.'],
      starter: `// ${a.app}: block operator injection\nfunction isScalar(value) {\n}\n\nfunction safeEquals(field, value) {\n}\n\nfunction hasOperator(obj) {\n}\n`,
      checks: [
        fn('isScalar accepts only scalars', 'isScalar', [
          { args: ['a'], expected: true }, { args: [5], expected: true }, { args: [true], expected: true },
          { args: [{ $ne: null }], expected: false }, { args: [[1]], expected: false }, { args: [null], expected: false },
        ]),
        fn('safeEquals rejects non-scalars', 'safeEquals', [
          { args: ['email', 'ama@t.test'], expected: { email: 'ama@t.test' } },
          { args: ['password', { $ne: null }], expected: null },
        ]),
        fn('hasOperator spots operator keys', 'hasOperator', [
          { args: [{ $gt: 1 }], expected: true }, { args: [{ name: 'a' }], expected: false }, { args: [{ a: 1, $or: [] }], expected: true },
        ]),
      ],
      solution: `function isScalar(value) {\n  const t = typeof value;\n  return t === "string" || t === "number" || t === "boolean";\n}\nfunction safeEquals(field, value) {\n  return isScalar(value) ? { [field]: value } : null;\n}\nfunction hasOperator(obj) {\n  return Object.keys(obj).some((k) => k.startsWith("$"));\n}`,
      realityNote: 'NoSQL operator injection ($ne, $gt, $where) abuses fields that should hold a scalar; rejecting object values and operator keys is the standard defence.',
    });
  }),
  tmpl(3, 3, 'advanced', 'escape-ldap-filter', 'Escape a value for an LDAP filter', 'E1', 25, 'Escape the special characters of an LDAP filter so a username cannot alter it.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Escape where you cannot parameterise\n\nAn LDAP lookup on **${a.host}** matches \`(uid=VALUE)\`. LDAP has no placeholders, so the value must be escaped per RFC 4515.\n\n1. \`escapeLdap(value)\`: replace each special character with a backslash + two-hex-digit code: \`\\\\\` → \`\\\\5c\`, \`*\` → \`\\\\2a\`, \`(\` → \`\\\\28\`, \`)\` → \`\\\\29\`, and NUL → \`\\\\00\`. Escape the backslash **first**.\n2. \`uidFilter(value)\`: return \`"(uid=" + escapeLdap(value) + ")"\`.`,
      hints: ['Do the backslash replacement before the others, or you double-escape.', 'A chained .replace in the right order is simplest.'],
      starter: `// ${a.app}: LDAP filter escaping\nfunction escapeLdap(value) {\n}\n\nfunction uidFilter(value) {\n}\n`,
      checks: [
        fn('escapeLdap escapes specials', 'escapeLdap', [
          { args: ['ama'], expected: 'ama' },
          { args: ['a*b'], expected: 'a\\2ab' },
          { args: ['x)(uid=*'], expected: 'x\\29\\28uid=\\2a' },
          { args: ['a\\b'], expected: 'a\\5cb' },
        ]),
        fn('uidFilter wraps the escaped value', 'uidFilter', [
          { args: ['ama'], expected: '(uid=ama)' },
          { args: ['*'], expected: '(uid=\\2a)' },
        ]),
      ],
      solution: `function escapeLdap(value) {\n  return String(value)\n    .replace(/\\\\/g, "\\\\5c")\n    .replace(/\\*/g, "\\\\2a")\n    .replace(/\\(/g, "\\\\28")\n    .replace(/\\)/g, "\\\\29")\n    .replace(/\\x00/g, "\\\\00");\n}\nfunction uidFilter(value) {\n  return "(uid=" + escapeLdap(value) + ")";\n}`,
      realityNote: 'LDAP filters have no bind parameters, so RFC 4515 escaping of (, ), *, \\\\ and NUL is the required defence against LDAP injection.',
    });
  }),

  /* ------------------------------------------------------------------ 3.4 parameterisation and least privilege */
  tmpl(3, 4, 'beginner', 'build-prepared', 'Build a prepared statement with many params', 'E1', 20, 'Construct a multi-parameter insert with placeholders and a matching params array.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Placeholders for every value\n\nOn **${a.host}**, build a safe insert. Write \`insertUser(name, email, role)\` returning \`{ text, params }\`:\n\n- \`text\` is \`"INSERT INTO users (name, email, role) VALUES (?, ?, ?)"\`;\n- \`params\` is \`[name, email, role]\`.\n\nAlso write \`paramsMatchPlaceholders(query)\` returning \`true\` only when the number of \`?\` in \`query.text\` equals \`query.params.length\`.`,
      hints: ['One "?" per value, in the same order as params.', 'Count "?" and compare to params.length.'],
      starter: `// ${a.app}: prepared insert\nfunction insertUser(name, email, role) {\n}\n\nfunction paramsMatchPlaceholders(query) {\n}\n`,
      checks: [
        fn('insertUser parameterises every value', 'insertUser', [
          { args: ['Ama', 'ama@t.test', 'user'], expected: { text: 'INSERT INTO users (name, email, role) VALUES (?, ?, ?)', params: ['Ama', 'ama@t.test', 'user'] } },
        ]),
        fn('paramsMatchPlaceholders checks the count', 'paramsMatchPlaceholders', [
          { args: [{ text: 'VALUES (?, ?, ?)', params: ['a', 'b', 'c'] }], expected: true },
          { args: [{ text: 'VALUES (?, ?)', params: ['a', 'b', 'c'] }], expected: false },
        ]),
      ],
      solution: `function insertUser(name, email, role) {\n  return { text: "INSERT INTO users (name, email, role) VALUES (?, ?, ?)", params: [name, email, role] };\n}\nfunction paramsMatchPlaceholders(query) {\n  return (query.text.split("?").length - 1) === query.params.length;\n}`,
      realityNote: 'Every value in a prepared statement gets its own placeholder; a mismatch between placeholders and parameters is a bug worth catching in review.',
    });
  }),
  tmpl(3, 4, 'intermediate', 'least-privilege-grants', 'Grant only the privileges the app needs', 'E1', 25, 'Decide the minimal set of SQL privileges for an application account.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The app account is not an admin\n\nThe application for **${a.host}** only reads and writes rows in two tables. Decide its privileges so a flaw cannot drop tables or read others.\n\n1. \`neededPrivileges(operations)\`: \`operations\` is an array drawn from \`"read"\`, \`"insert"\`, \`"update"\`, \`"delete"\`. Map them to SQL privileges \`SELECT, INSERT, UPDATE, DELETE\` respectively and return the **sorted, distinct** list. Ignore unknown operations.\n2. \`isOverPrivileged(granted)\`: return \`true\` if \`granted\` (an array) contains any of \`"DROP"\`, \`"ALTER"\`, \`"GRANT"\`, \`"ALL"\` or \`"SUPER"\` — privileges an app account must not hold.`,
      hints: ['Map operations to privilege names, dedupe with a Set, sort.', 'isOverPrivileged: granted.some(p => dangerous.includes(p)).'],
      starter: `// ${a.app}: least privilege\nfunction neededPrivileges(operations) {\n}\n\nfunction isOverPrivileged(granted) {\n}\n`,
      checks: [
        fn('neededPrivileges maps to the minimum', 'neededPrivileges', [
          { args: [['read', 'insert', 'read']], expected: ['INSERT', 'SELECT'] },
          { args: [['read', 'update', 'delete', 'insert']], expected: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] },
          { args: [['read', 'drop']], expected: ['SELECT'] },
        ]),
        fn('isOverPrivileged flags dangerous grants', 'isOverPrivileged', [
          { args: [['SELECT', 'INSERT']], expected: false },
          { args: [['SELECT', 'DROP']], expected: true },
          { args: [['ALL']], expected: true },
        ]),
      ],
      solution: `function neededPrivileges(operations) {\n  const map = { read: "SELECT", insert: "INSERT", update: "UPDATE", delete: "DELETE" };\n  const set = new Set();\n  for (const op of operations) if (map[op]) set.add(map[op]);\n  return [...set].sort();\n}\nfunction isOverPrivileged(granted) {\n  const dangerous = ["DROP", "ALTER", "GRANT", "ALL", "SUPER"];\n  return granted.some((p) => dangerous.includes(p));\n}`,
      realityNote: 'A least-privilege database account means that even a successful injection can only do what the app can — not drop tables or read the whole database.',
    });
  }),
  tmpl(3, 4, 'advanced', 'tenant-scoped-query', 'Scope every query to the tenant', 'E1', 25, 'Force a tenant filter into every query so one customer cannot read another\'s rows.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Every query carries the tenant\n\n**${a.host}** is multi-tenant. Even with parameterised queries, a missing tenant filter leaks data across customers. Enforce it centrally.\n\n1. \`scopedSelect(table, tenantId, extraWhere)\`: return \`{ text, params }\` where \`text\` is \`"SELECT * FROM " + table + " WHERE tenant_id = ?"\` plus, if \`extraWhere\` is a non-empty string, \`" AND " + extraWhere\`. \`params\` starts with \`[tenantId]\`. (\`table\` is trusted/allow-listed by the caller; \`tenantId\` is always a parameter.)\n2. \`isTenantScoped(query)\`: return \`true\` only when \`query.text\` includes \`"tenant_id = ?"\` and \`query.params.length >= 1\`.`,
      hints: ['Always start the WHERE with tenant_id = ? and tenantId as the first param.', 'Append AND extraWhere only when extraWhere is truthy.'],
      starter: `// ${a.app}: tenant scoping\nfunction scopedSelect(table, tenantId, extraWhere) {\n}\n\nfunction isTenantScoped(query) {\n}\n`,
      checks: [
        fn('scopedSelect always filters by tenant', 'scopedSelect', [
          { args: ['invoices', 7, ''], expected: { text: 'SELECT * FROM invoices WHERE tenant_id = ?', params: [7] } },
          { args: ['invoices', 7, 'status = ?'], expected: { text: 'SELECT * FROM invoices WHERE tenant_id = ? AND status = ?', params: [7] } },
        ]),
        fn('isTenantScoped verifies the filter', 'isTenantScoped', [
          { args: [{ text: 'SELECT * FROM t WHERE tenant_id = ?', params: [1] }], expected: true },
          { args: [{ text: 'SELECT * FROM t WHERE id = ?', params: [1] }], expected: false },
        ]),
      ],
      solution: `function scopedSelect(table, tenantId, extraWhere) {\n  let text = "SELECT * FROM " + table + " WHERE tenant_id = ?";\n  if (extraWhere) text += " AND " + extraWhere;\n  return { text, params: [tenantId] };\n}\nfunction isTenantScoped(query) {\n  return query.text.includes("tenant_id = ?") && query.params.length >= 1;\n}`,
      realityNote: 'Multi-tenant data leaks often come from a single query that forgot the tenant filter; centralising it so every query is scoped is the durable fix.',
    });
  }),

  /* ------------------------------------------------------------------ 3.5 input validation and allow-listing */
  tmpl(3, 5, 'beginner', 'allow-list-input', 'Allow-list instead of block-list', 'E1', 20, 'Accept only values that match an expected pattern rather than trying to strip bad ones.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Define good, not bad\n\nBlock-lists (strip "bad" words) are always incomplete. On **${a.host}**, allow-list instead.\n\n1. \`isUsername(s)\`: return \`true\` only for 3–16 characters of lower-case letters, digits and underscore (\`^[a-z0-9_]{3,16}$\`).\n2. \`isSlug(s)\`: return \`true\` for lower-case letters, digits and single hyphens, not starting or ending with a hyphen (e.g. \`"market-list"\`).\n3. \`sanitiseOrReject(s, kind)\`: for kind \`"username"\` return \`s\` if \`isUsername(s)\` else \`null\`; for \`"slug"\` return \`s\` if \`isSlug(s)\` else \`null\`; for any other kind return \`null\`.`,
      hints: ['Slug pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/.', 'Reject by returning null; never try to "clean" an invalid value.'],
      starter: `// ${a.app}: allow-list validation\nfunction isUsername(s) {\n}\n\nfunction isSlug(s) {\n}\n\nfunction sanitiseOrReject(s, kind) {\n}\n`,
      checks: [
        fn('isUsername allows only the pattern', 'isUsername', [
          { args: ['ama_123'], expected: true }, { args: ['ab'], expected: false }, { args: ['Ama'], expected: false }, { args: ['a'.repeat(17)], expected: false },
        ]),
        fn('isSlug allows clean slugs', 'isSlug', [
          { args: ['market-list'], expected: true }, { args: ['-bad'], expected: false }, { args: ['a--b'], expected: false }, { args: ['ok1'], expected: true },
        ]),
        fn('sanitiseOrReject accepts or rejects', 'sanitiseOrReject', [
          { args: ['ama_1', 'username'], expected: 'ama_1' }, { args: ['Bad!', 'username'], expected: null }, { args: ['a-b', 'slug'], expected: 'a-b' }, { args: ['x', 'other'], expected: null },
        ]),
      ],
      solution: `function isUsername(s) {\n  return /^[a-z0-9_]{3,16}$/.test(s);\n}\nfunction isSlug(s) {\n  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);\n}\nfunction sanitiseOrReject(s, kind) {\n  if (kind === "username") return isUsername(s) ? s : null;\n  if (kind === "slug") return isSlug(s) ? s : null;\n  return null;\n}`,
      realityNote: 'Allow-listing (describe exactly what is valid) beats block-listing (guess every bad input) because the set of valid values is small and knowable.',
    });
  }),
  tmpl(3, 5, 'intermediate', 'normalise-then-validate', 'Normalise before validating', 'E1', 25, 'Normalise case and whitespace before the allow-list check, so equivalent inputs are treated alike.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Normalise, then decide\n\nOn **${a.host}**, validate an email-like identifier consistently.\n\n1. \`normaliseEmail(raw)\`: trim surrounding whitespace and lower-case the whole string. If it is not a string, return \`null\`.\n2. \`isEmail(s)\`: return \`true\` for a simple \`local@domain.tld\` with no spaces (use \`/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/\`).\n3. \`acceptEmail(raw)\`: normalise, then return the normalised value if \`isEmail\` passes, else \`null\`. So \`" Ama@School.TEST "\` becomes \`"ama@school.test"\`.`,
      hints: ['Normalise first so " Ama@X " and "ama@x" are treated the same.', 'Return the normalised form, not the raw input.'],
      starter: `// ${a.app}: normalise then validate\nfunction normaliseEmail(raw) {\n}\n\nfunction isEmail(s) {\n}\n\nfunction acceptEmail(raw) {\n}\n`,
      checks: [
        fn('normaliseEmail trims and lower-cases', 'normaliseEmail', [
          { args: [' Ama@School.TEST '], expected: 'ama@school.test' }, { args: ['x@y.z'], expected: 'x@y.z' }, { args: [5], expected: null },
        ]),
        fn('isEmail checks the shape', 'isEmail', [
          { args: ['ama@school.test'], expected: true }, { args: ['bad'], expected: false }, { args: ['a @b.c'], expected: false },
        ]),
        fn('acceptEmail returns the clean value', 'acceptEmail', [
          { args: [' Ama@School.TEST '], expected: 'ama@school.test' }, { args: ['nope'], expected: null },
        ]),
      ],
      solution: `function normaliseEmail(raw) {\n  if (typeof raw !== "string") return null;\n  return raw.trim().toLowerCase();\n}\nfunction isEmail(s) {\n  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s);\n}\nfunction acceptEmail(raw) {\n  const n = normaliseEmail(raw);\n  if (n === null) return null;\n  return isEmail(n) ? n : null;\n}`,
      realityNote: 'Normalising (case, whitespace, Unicode form) before validating prevents equivalent-but-different inputs from slipping past a check or creating duplicate accounts.',
    });
  }),
  tmpl(3, 5, 'advanced', 'defence-in-depth-layers', 'Combine layers so one failure is not fatal', 'E1', 25, 'Apply validation, parameterisation and output limits together and report which layers would catch an attack.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Layers, not a single wall\n\nFor **${a.host}**, model defence in depth as independent checks on a search term. Write \`layersPassed(term)\` returning an object of booleans:\n\n- \`validated\`: \`true\` if \`term\` is a string of 1–40 characters of letters, digits, spaces, hyphen or apostrophe (\`/^[A-Za-z0-9 '\\-]{1,40}$/\`);\n- \`parameterised\`: always \`true\` (the query uses placeholders, so this layer never depends on the term) — model it as \`typeof term === "string"\`;\n- \`lengthBounded\`: \`true\` if \`term.length <= 40\`.\n\nThen \`defended(term)\`: return \`true\` if **at least two** of the three layers pass — one failing layer must not break the defence.`,
      hints: ['Build the three booleans, then count how many are true.', 'defended is (count of true layers) >= 2.'],
      starter: `// ${a.app}: defence in depth\nfunction layersPassed(term) {\n}\n\nfunction defended(term) {\n}\n`,
      checks: [
        fn('layersPassed reports each layer', 'layersPassed', [
          { args: ["Ama's shoes"], expected: { validated: true, parameterised: true, lengthBounded: true } },
          { args: ['x'.repeat(50)], expected: { validated: false, parameterised: true, lengthBounded: false } },
          { args: ["<script>"], expected: { validated: false, parameterised: true, lengthBounded: true } },
        ]),
        fn('defended needs two layers', 'defended', [
          { args: ['books'], expected: true }, { args: ['<script>'], expected: true }, { args: ['x'.repeat(50)], expected: false },
        ]),
      ],
      solution: `function layersPassed(term) {\n  return {\n    validated: typeof term === "string" && /^[A-Za-z0-9 '\\-]{1,40}$/.test(term),\n    parameterised: typeof term === "string",\n    lengthBounded: typeof term === "string" && term.length <= 40,\n  };\n}\nfunction defended(term) {\n  const l = layersPassed(term);\n  return [l.validated, l.parameterised, l.lengthBounded].filter(Boolean).length >= 2;\n}`,
      realityNote: 'Defence in depth means no single control is load-bearing: if validation misses something, parameterisation and output limits still contain it.',
    });
  }),
];
