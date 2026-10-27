/** Unit 5: authentication and session flaws — fixed. Learners build password policy and hashing
 * discipline, account lockout, session validity and timeout, secure cookies, and recovery safety. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U5: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 5.1 credential handling */
  tmpl(5, 1, 'beginner', 'password-policy', 'Check a password against a sensible policy', 'E1', 20, 'Enforce length and variety without the counter-productive rules, and reject common passwords.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A modern password policy\n\nFor **${a.host}**, follow current guidance: favour length, block known-bad passwords, and do not impose silly composition rules. Write \`passwordProblems(pw, blocklist)\` returning an array of reasons (empty = acceptable):\n\n- push \`"too-short"\` if fewer than 12 characters;\n- push \`"too-long"\` if more than 64 characters;\n- push \`"blocked"\` if the lower-cased password is in \`blocklist\` (an array of known-bad passwords, already lower-case);\n- push \`"whitespace-only"\` if the password trimmed is empty.\n\nReturn the reasons in that order.`,
      hints: ['Length first, then blocklist, then whitespace.', 'Compare pw.toLowerCase() against the blocklist.'],
      starter: `// ${a.app}: password policy\nfunction passwordProblems(pw, blocklist) {\n}\n`,
      checks: [
        fn('passwordProblems applies the policy', 'passwordProblems', [
          { args: ['correct horse battery staple', []], expected: [] },
          { args: ['short', []], expected: ['too-short'] },
          { args: ['x'.repeat(65), []], expected: ['too-long'] },
          { args: ['Password1234', ['password1234']], expected: ['blocked'] },
          { args: ['            ', []], expected: ['whitespace-only'] },
        ]),
      ],
      solution: `function passwordProblems(pw, blocklist) {\n  const problems = [];\n  if (pw.length < 12) problems.push("too-short");\n  if (pw.length > 64) problems.push("too-long");\n  if (blocklist.includes(pw.toLowerCase())) problems.push("blocked");\n  if (pw.trim() === "") problems.push("whitespace-only");\n  return problems;\n}`,
      realityNote: 'Modern guidance (NIST 800-63) favours length and block known-breached passwords over forced symbols and frequent expiry, which push users to weaker, predictable choices.',
    });
  }),
  tmpl(5, 1, 'intermediate', 'salted-hash-record', 'Store a password as a salted hash record', 'E1', 25, 'Model a password record that keeps a per-user salt and algorithm, never the plaintext.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Never store the password\n\nOn **${a.host}**, store only what you need to verify a password later. You are given a stand-in hash function \`slowHash(password, salt)\` (pretend it is a slow algorithm like bcrypt/argon2).\n\n1. \`makeRecord(password, salt)\`: return \`{ algo: "argon2id", salt, hash: slowHash(password, salt) }\` — no plaintext.\n2. \`verify(password, record)\`: recompute \`slowHash(password, record.salt)\` and compare to \`record.hash\`; return \`true\`/\`false\`.\n3. \`storesPlaintext(record)\`: return \`true\` if the record has any property whose value equals a field named \`password\` or \`plaintext\` (i.e. keys \`"password"\` or \`"plaintext"\` exist) — a check for a bad record.`,
      hints: ['makeRecord must not keep the password itself.', 'verify recomputes the hash with the stored salt.'],
      starter: `// ${a.app}: salted hash record\nfunction slowHash(password, salt) { return "H(" + password + "|" + salt + ")"; }\n\nfunction makeRecord(password, salt) {\n}\n\nfunction verify(password, record) {\n}\n\nfunction storesPlaintext(record) {\n}\n`,
      checks: [
        fn('makeRecord stores a salted hash, no plaintext', 'makeRecord', [
          { args: ['hunter2longenough', 's1'], expected: { algo: 'argon2id', salt: 's1', hash: 'H(hunter2longenough|s1)' } },
        ]),
        fn('verify checks the password', 'verify', [
          { args: ['hunter2longenough', { algo: 'argon2id', salt: 's1', hash: 'H(hunter2longenough|s1)' }], expected: true },
          { args: ['wrong', { algo: 'argon2id', salt: 's1', hash: 'H(hunter2longenough|s1)' }], expected: false },
        ]),
        fn('storesPlaintext flags a bad record', 'storesPlaintext', [
          { args: [{ algo: 'argon2id', salt: 's', hash: 'H' }], expected: false },
          { args: [{ password: 'oops', hash: 'H' }], expected: true },
        ]),
      ],
      solution: `function slowHash(password, salt) { return "H(" + password + "|" + salt + ")"; }\nfunction makeRecord(password, salt) {\n  return { algo: "argon2id", salt, hash: slowHash(password, salt) };\n}\nfunction verify(password, record) {\n  return slowHash(password, record.salt) === record.hash;\n}\nfunction storesPlaintext(record) {\n  return Object.prototype.hasOwnProperty.call(record, "password") || Object.prototype.hasOwnProperty.call(record, "plaintext");\n}`,
      realityNote: 'Passwords are stored as a slow, salted hash (argon2id or bcrypt) with a per-user salt; the plaintext is never kept, so a database leak does not immediately reveal passwords.',
    });
  }),
  tmpl(5, 1, 'advanced', 'choose-second-factor', 'Choose a resilient second factor', 'E10', 20, 'Weigh second-factor options against SIM-swap and phishing for a money app.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Not all second factors are equal\n\n**${a.org}** is adding multi-factor authentication to **${a.host}**. Choose factors that resist the real threats.`,
      steps: [
        { title: 'SMS codes', text: 'The team proposes SMS one-time codes. What is the weakness?', choices: [
          { text: 'SIM-swap and SS7 interception can redirect the SMS; it is better than nothing but the weakest common factor', right: true, feedback: 'Correct. SMS is phishable and SIM-swappable; prefer stronger factors.' },
          { text: 'SMS is unbreakable', feedback: 'SIM-swap fraud defeats SMS codes regularly.' },
          { text: 'SMS cannot be used as a factor at all', feedback: 'It can, but it is the weakest option.' },
        ] },
        { title: 'Authenticator apps', text: 'How do time-based app codes (TOTP) compare?', choices: [
          { text: 'Stronger than SMS — not tied to the phone number — but still phishable if the user is tricked into entering the code', right: true, feedback: 'Correct. TOTP removes SIM-swap but can still be relayed by phishing.' },
          { text: 'Identical to SMS', feedback: 'TOTP is not tied to the SIM, so it resists SIM-swap.' },
          { text: 'Immune to all attacks', feedback: 'TOTP codes can still be phished in real time.' },
        ] },
        { title: 'Security keys', text: 'For the strongest option, what do you recommend?', choices: [
          { text: 'FIDO2/WebAuthn security keys or passkeys — phishing-resistant because they are bound to the origin', right: true, feedback: 'Correct. Origin-bound credentials cannot be relayed to a fake site.' },
          { text: 'Emailing a code', feedback: 'Email codes are phishable and only as strong as the mailbox.' },
          { text: 'A longer password instead of a second factor', feedback: 'A second factor is the point; a longer password is not one.' },
        ] },
        { title: 'Account recovery', text: 'You add strong MFA. What must you not forget?', choices: [
          { text: 'A recovery path that is at least as strong, or attackers bypass MFA through it', right: true, feedback: 'Correct. Weak recovery undoes strong MFA.' },
          { text: 'Let users disable MFA by email link with no checks', feedback: 'That is the bypass attackers will use.' },
          { text: 'Nothing; MFA covers everything', feedback: 'Recovery is the common MFA bypass and must be hardened too.' },
        ] },
      ],
      ending: { title: 'Prefer phishing-resistant factors', text: 'SMS resists little; authenticator apps remove SIM-swap; FIDO2/passkeys resist phishing by binding to the origin. And recovery must be as strong as the factor, or it becomes the bypass.' },
      hints: ['Rank factors by what they resist: SIM-swap, then phishing.', 'A weak recovery path undoes strong MFA.'],
      realityNote: 'SIM-swap fraud has drained real accounts protected only by SMS; FIDO2/WebAuthn passkeys are the current gold standard because they cannot be phished.',
    });
  }),

  /* ------------------------------------------------------------------ 5.2 login flaws */
  tmpl(5, 2, 'beginner', 'account-lockout', 'Lock out after repeated failures', 'E1', 20, 'Count failed attempts and lock an account temporarily to resist guessing.', (v) => {
    const a = appOf(v);
    const max = v.pick([5, 6, 10]);
    return js({
      instructions: `## Slow down guessing\n\nOn **${a.host}**, lock an account for a while after too many failed logins. Write \`loginState(fails, lockedUntil, now)\`:\n\n- if \`lockedUntil\` is a number greater than \`now\`, return \`{ allowed: false, reason: "locked" }\`;\n- otherwise if \`fails >= ${max}\`, return \`{ allowed: false, reason: "too-many" }\` (the caller will set a lock);\n- otherwise \`{ allowed: true }\`.\n\nAlso \`nextFails(fails, success)\`: return 0 on \`success === true\`, else \`fails + 1\`.`,
      hints: ['Check the active lock window first.', 'A successful login resets the counter to 0.'],
      starter: `// ${a.app}: account lockout\nfunction loginState(fails, lockedUntil, now) {\n}\n\nfunction nextFails(fails, success) {\n}\n`,
      checks: [
        fn('loginState enforces lockout', 'loginState', [
          { args: [0, 0, 100], expected: { allowed: true } },
          { args: [2, 500, 100], expected: { allowed: false, reason: 'locked' } },
          { args: [max, 0, 100], expected: { allowed: false, reason: 'too-many' } },
          { args: [max - 1, 0, 100], expected: { allowed: true } },
        ]),
        fn('nextFails counts and resets', 'nextFails', [
          { args: [3, false], expected: 4 }, { args: [3, true], expected: 0 }, { args: [0, false], expected: 1 },
        ]),
      ],
      solution: `function loginState(fails, lockedUntil, now) {\n  if (typeof lockedUntil === "number" && lockedUntil > now) return { allowed: false, reason: "locked" };\n  if (fails >= ${max}) return { allowed: false, reason: "too-many" };\n  return { allowed: true };\n}\nfunction nextFails(fails, success) {\n  return success ? 0 : fails + 1;\n}`,
      realityNote: 'Rate limiting and temporary lockout (with care not to enable denial of service by locking out victims) blunt online password guessing and credential stuffing.',
    });
  }),
  tmpl(5, 2, 'intermediate', 'generic-reset-response', 'Make the reset flow leak nothing', 'E1', 20, 'Return a uniform response and only act when the account exists, without revealing which.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Help the user, tell the attacker nothing\n\nOn **${a.host}**, a password-reset request must look the same whether or not the email is registered. Write \`handleReset(email, accounts)\` where \`accounts\` maps email→user:\n\n- always return \`{ status: 200, message: "If that account exists, we have sent a reset link." }\`;\n- but only *send* a link when the account exists — model the side effect by also returning a second value through \`resetActionFor(email, accounts)\`: return \`{ send: true, to: email }\` if the account exists, else \`{ send: false }\`.\n\nThe user-visible message never changes.`,
      hints: ['The response message is identical in both cases.', 'Decide the hidden action separately from the visible response.'],
      starter: `// ${a.app}: uniform reset flow\nfunction handleReset(email, accounts) {\n}\n\nfunction resetActionFor(email, accounts) {\n}\n`,
      checks: [
        fn('handleReset is uniform', 'handleReset', [
          { args: ['ama@t.test', { 'ama@t.test': {} }], expected: { status: 200, message: 'If that account exists, we have sent a reset link.' } },
          { args: ['none@t.test', { 'ama@t.test': {} }], expected: { status: 200, message: 'If that account exists, we have sent a reset link.' } },
        ]),
        fn('resetActionFor acts only for real accounts', 'resetActionFor', [
          { args: ['ama@t.test', { 'ama@t.test': {} }], expected: { send: true, to: 'ama@t.test' } },
          { args: ['none@t.test', { 'ama@t.test': {} }], expected: { send: false } },
        ]),
      ],
      solution: `function handleReset(email, accounts) {\n  return { status: 200, message: "If that account exists, we have sent a reset link." };\n}\nfunction resetActionFor(email, accounts) {\n  return Object.prototype.hasOwnProperty.call(accounts, email) ? { send: true, to: email } : { send: false };\n}`,
      realityNote: 'A reset flow that says "no such email" enumerates accounts; the uniform "if that account exists" response, with the email sent only when it does, is the standard safe pattern.',
    });
  }),
  tmpl(5, 2, 'advanced', 'detect-credential-stuffing', 'Throttle distributed guessing', 'E1', 25, 'Decide when login patterns look like credential stuffing and should be slowed.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Patterns of abuse\n\nOn **${a.host}**, credential-stuffing uses many accounts from few sources. Write \`stuffingScore(window)\` where \`window = { distinctAccounts, distinctIps, failures, total }\` over a short period, returning a number:\n\n- start at 0;\n- add 2 if \`failures / total > 0.8\` (mostly failures; \`total > 0\`);\n- add 2 if \`distinctAccounts >= 20\` and \`distinctIps <= 3\` (many accounts, few sources);\n- add 1 if \`total >= 100\`.\n\nThen \`shouldChallenge(window)\`: return \`true\` when \`stuffingScore(window) >= 3\` (apply a CAPTCHA or extra verification).`,
      hints: ['Guard total > 0 before dividing.', 'Sum the three signals, then threshold at 3.'],
      starter: `// ${a.app}: detect credential stuffing\nfunction stuffingScore(window) {\n}\n\nfunction shouldChallenge(window) {\n}\n`,
      checks: [
        fn('stuffingScore sums the signals', 'stuffingScore', [
          { args: [{ distinctAccounts: 50, distinctIps: 2, failures: 95, total: 100 }], expected: 5 },
          { args: [{ distinctAccounts: 2, distinctIps: 2, failures: 1, total: 10 }], expected: 0 },
          { args: [{ distinctAccounts: 30, distinctIps: 1, failures: 10, total: 50 }], expected: 2 },
        ]),
        fn('shouldChallenge thresholds the score', 'shouldChallenge', [
          { args: [{ distinctAccounts: 50, distinctIps: 2, failures: 95, total: 100 }], expected: true },
          { args: [{ distinctAccounts: 2, distinctIps: 2, failures: 1, total: 10 }], expected: false },
        ]),
      ],
      solution: `function stuffingScore(window) {\n  let s = 0;\n  if (window.total > 0 && window.failures / window.total > 0.8) s += 2;\n  if (window.distinctAccounts >= 20 && window.distinctIps <= 3) s += 2;\n  if (window.total >= 100) s += 1;\n  return s;\n}\nfunction shouldChallenge(window) {\n  return stuffingScore(window) >= 3;\n}`,
      realityNote: 'Credential-stuffing defences combine signals like failure ratio and account/IP spread to decide when to add friction (CAPTCHA, step-up) without blocking legitimate users.',
    });
  }),

  /* ------------------------------------------------------------------ 5.3 session management */
  tmpl(5, 3, 'beginner', 'session-validity', 'Decide whether a session is still valid', 'E1', 20, 'Expire sessions by absolute lifetime and idle timeout.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Sessions must expire\n\nOn **${a.host}**, a session has a creation time and a last-activity time. Write \`sessionValid(session, now, maxLifetime, idleTimeout)\` where \`session = { createdAt, lastSeen }\` (seconds):\n\n- invalid if \`now - session.createdAt > maxLifetime\` (absolute lifetime exceeded);\n- invalid if \`now - session.lastSeen > idleTimeout\` (idle too long);\n- otherwise valid. Return \`true\`/\`false\`.\n\nAlso \`touch(session, now)\`: return a copy with \`lastSeen\` set to \`now\`.`,
      hints: ['Two independent expiry checks: absolute and idle.', 'touch only updates lastSeen.'],
      starter: `// ${a.app}: session validity\nfunction sessionValid(session, now, maxLifetime, idleTimeout) {\n}\n\nfunction touch(session, now) {\n}\n`,
      checks: [
        fn('sessionValid applies both expiries', 'sessionValid', [
          { args: [{ createdAt: 0, lastSeen: 60 }, 100, 1000, 30], expected: false },
          { args: [{ createdAt: 0, lastSeen: 95 }, 100, 1000, 30], expected: true },
          { args: [{ createdAt: 0, lastSeen: 2000 }, 2001, 1000, 30], expected: false },
        ]),
        fn('touch updates last activity', 'touch', [
          { args: [{ createdAt: 0, lastSeen: 10 }, 50], expected: { createdAt: 0, lastSeen: 50 } },
        ]),
      ],
      solution: `function sessionValid(session, now, maxLifetime, idleTimeout) {\n  if (now - session.createdAt > maxLifetime) return false;\n  if (now - session.lastSeen > idleTimeout) return false;\n  return true;\n}\nfunction touch(session, now) {\n  return { ...session, lastSeen: now };\n}`,
      realityNote: 'Both an absolute lifetime and an idle timeout limit how long a stolen or forgotten session stays useful; banking apps use short idle timeouts for exactly this reason.',
    });
  }),
  tmpl(5, 3, 'intermediate', 'bind-session', 'Detect a session used from a new context', 'E1', 25, 'Flag a session whose client fingerprint changes mid-session as possibly hijacked.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A session that suddenly moves\n\nOn **${a.host}**, a session records the user-agent and a coarse network marker it began with. A sudden change can mean theft. Write \`anomalyScore(session, request)\` where both have \`{ userAgent, network }\`:\n\n- add 1 if \`request.userAgent !== session.userAgent\`;\n- add 2 if \`request.network !== session.network\`;\n- return the total.\n\nThen \`reactionFor(score)\`: \`0\` → \`"allow"\`; \`1\` or \`2\` → \`"step-up"\` (ask for re-auth); \`3\` or more → \`"revoke"\`.`,
      hints: ['Network change weighs more than user-agent change.', 'Map the score bands to the three reactions.'],
      starter: `// ${a.app}: session binding\nfunction anomalyScore(session, request) {\n}\n\nfunction reactionFor(score) {\n}\n`,
      checks: [
        fn('anomalyScore weighs the changes', 'anomalyScore', [
          { args: [{ userAgent: 'A', network: 'N1' }, { userAgent: 'A', network: 'N1' }], expected: 0 },
          { args: [{ userAgent: 'A', network: 'N1' }, { userAgent: 'B', network: 'N1' }], expected: 1 },
          { args: [{ userAgent: 'A', network: 'N1' }, { userAgent: 'B', network: 'N2' }], expected: 3 },
        ]),
        fn('reactionFor maps the bands', 'reactionFor', [
          { args: [0], expected: 'allow' }, { args: [2], expected: 'step-up' }, { args: [3], expected: 'revoke' },
        ]),
      ],
      solution: `function anomalyScore(session, request) {\n  let s = 0;\n  if (request.userAgent !== session.userAgent) s += 1;\n  if (request.network !== session.network) s += 2;\n  return s;\n}\nfunction reactionFor(score) {\n  if (score === 0) return "allow";\n  if (score < 3) return "step-up";\n  return "revoke";\n}`,
      realityNote: 'Binding a session loosely to client attributes and reacting to sudden changes helps catch hijacked session tokens without annoying users who merely switch networks.',
    });
  }),
  tmpl(5, 3, 'advanced', 'invalidate-on-logout', 'Invalidate sessions server-side', 'E1', 25, 'Maintain a server-side revocation set so logout and password change really end sessions.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Logout must end the session on the server\n\nOn **${a.host}**, a session id is only valid if the server still accepts it. A client-side "logout" that just drops the cookie is not enough. Model a revocation set.\n\n1. \`isActive(sessionId, revoked)\`: return \`true\` only when \`sessionId\` is a non-empty string and **not** in the \`revoked\` array.\n2. \`revokeAll(sessionIds, revoked)\`: return a new array = \`revoked\` plus every id in \`sessionIds\` not already present (used on password change to end every session).\n3. \`acceptRequest(sessionId, revoked)\`: return \`{ ok: true }\` if active, else \`{ ok: false, reason: "session-ended" }\`.`,
      hints: ['Active = non-empty and not revoked.', 'revokeAll unions without duplicates.'],
      starter: `// ${a.app}: server-side session invalidation\nfunction isActive(sessionId, revoked) {\n}\n\nfunction revokeAll(sessionIds, revoked) {\n}\n\nfunction acceptRequest(sessionId, revoked) {\n}\n`,
      checks: [
        fn('isActive respects the revocation set', 'isActive', [
          { args: ['s1', []], expected: true }, { args: ['s1', ['s1']], expected: false }, { args: ['', []], expected: false },
        ]),
        fn('revokeAll unions the ids', 'revokeAll', [
          { args: [['s2', 's3'], ['s1']], expected: ['s1', 's2', 's3'] },
          { args: [['s1'], ['s1']], expected: ['s1'] },
        ]),
        fn('acceptRequest rejects ended sessions', 'acceptRequest', [
          { args: ['s1', []], expected: { ok: true } },
          { args: ['s1', ['s1']], expected: { ok: false, reason: 'session-ended' } },
        ]),
      ],
      solution: `function isActive(sessionId, revoked) {\n  return typeof sessionId === "string" && sessionId !== "" && !revoked.includes(sessionId);\n}\nfunction revokeAll(sessionIds, revoked) {\n  const out = [...revoked];\n  for (const id of sessionIds) if (!out.includes(id)) out.push(id);\n  return out;\n}\nfunction acceptRequest(sessionId, revoked) {\n  return isActive(sessionId, revoked) ? { ok: true } : { ok: false, reason: "session-ended" };\n}`,
      realityNote: 'Stateless tokens that cannot be revoked are a real problem; a server-side session store or a revocation list makes logout and "log out everywhere" actually work.',
    });
  }),

  /* ------------------------------------------------------------------ 5.4 secure cookies and tokens */
  tmpl(5, 4, 'beginner', 'cookie-flags', 'Set the right cookie flags for the job', 'E1', 20, 'Choose cookie attributes appropriate to a session cookie versus a non-sensitive preference.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The right flags for each cookie\n\nOn **${a.host}**, write \`cookieFlags(kind)\` returning the flag object for a cookie:\n\n- \`"session"\`: \`{ httpOnly: true, secure: true, sameSite: "Strict", path: "/" }\`;\n- \`"csrf"\`: \`{ httpOnly: false, secure: true, sameSite: "Strict", path: "/" }\` (the page must read it, so not HttpOnly);\n- \`"theme"\`: \`{ httpOnly: false, secure: true, sameSite: "Lax", path: "/" }\` (non-sensitive preference);\n- anything else: throw \`Error("unknown cookie")\`.`,
      hints: ['Session cookies are HttpOnly; a CSRF cookie the page reads is not.', 'All are Secure; sensitive ones are SameSite=Strict.'],
      starter: `// ${a.app}: cookie flags by kind\nfunction cookieFlags(kind) {\n}\n`,
      checks: [
        fn('cookieFlags chooses correct attributes', 'cookieFlags', [
          { args: ['session'], expected: { httpOnly: true, secure: true, sameSite: 'Strict', path: '/' } },
          { args: ['csrf'], expected: { httpOnly: false, secure: true, sameSite: 'Strict', path: '/' } },
          { args: ['theme'], expected: { httpOnly: false, secure: true, sameSite: 'Lax', path: '/' } },
          { args: ['mystery'], expected: { $error: 'Error' } },
        ]),
      ],
      solution: `function cookieFlags(kind) {\n  if (kind === "session") return { httpOnly: true, secure: true, sameSite: "Strict", path: "/" };\n  if (kind === "csrf") return { httpOnly: false, secure: true, sameSite: "Strict", path: "/" };\n  if (kind === "theme") return { httpOnly: false, secure: true, sameSite: "Lax", path: "/" };\n  throw new Error("unknown cookie");\n}`,
      realityNote: 'Session cookies should be HttpOnly, Secure and SameSite; a double-submit CSRF cookie is deliberately readable; getting these per-cookie choices right matters.',
    });
  }),
  tmpl(5, 4, 'intermediate', 'validate-token-claims', 'Validate a token\'s claims before trusting it', 'E1', 25, 'Check expiry, audience and issuer on a decoded token (signature assumed already verified).', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A valid signature is not enough\n\nOn **${a.host}**, after the signature is verified you must still validate the claims. Write \`claimsValid(claims, now, expected)\` where \`claims = { iss, aud, exp, nbf }\` (seconds) and \`expected = { iss, aud }\`:\n\n- invalid if \`claims.iss !== expected.iss\`;\n- invalid if \`claims.aud !== expected.aud\`;\n- invalid if \`claims.exp <= now\` (expired);\n- invalid if \`claims.nbf\` is a number and \`claims.nbf > now\` (not yet valid);\n- otherwise valid. Return \`true\`/\`false\`.`,
      hints: ['Check issuer and audience match what you expect.', 'exp must be in the future; nbf (if present) must be in the past.'],
      starter: `// ${a.app}: validate token claims\nfunction claimsValid(claims, now, expected) {\n}\n`,
      checks: [
        fn('claimsValid checks all the claims', 'claimsValid', [
          { args: [{ iss: 'auth', aud: 'app', exp: 200, nbf: 0 }, 100, { iss: 'auth', aud: 'app' }], expected: true },
          { args: [{ iss: 'evil', aud: 'app', exp: 200 }, 100, { iss: 'auth', aud: 'app' }], expected: false },
          { args: [{ iss: 'auth', aud: 'other', exp: 200 }, 100, { iss: 'auth', aud: 'app' }], expected: false },
          { args: [{ iss: 'auth', aud: 'app', exp: 50 }, 100, { iss: 'auth', aud: 'app' }], expected: false },
          { args: [{ iss: 'auth', aud: 'app', exp: 200, nbf: 150 }, 100, { iss: 'auth', aud: 'app' }], expected: false },
        ]),
      ],
      solution: `function claimsValid(claims, now, expected) {\n  if (claims.iss !== expected.iss) return false;\n  if (claims.aud !== expected.aud) return false;\n  if (claims.exp <= now) return false;\n  if (typeof claims.nbf === "number" && claims.nbf > now) return false;\n  return true;\n}`,
      realityNote: 'Many JWT bugs come from verifying the signature but not the claims; issuer, audience and expiry must all be checked, or a valid-but-wrong token is accepted.',
    });
  }),
  tmpl(5, 4, 'advanced', 'reject-alg-none', 'Refuse unsafe token algorithms', 'E1', 20, 'Reject "alg: none" and algorithm confusion before a token is trusted.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Pin the algorithm\n\nA classic JWT attack sets the header algorithm to \`none\` or swaps it to confuse verification. On **${a.host}**, pin the allowed algorithm. Write \`headerAcceptable(header, allowedAlgs)\` where \`header = { alg, typ }\`:\n\n- return \`false\` if \`header.alg\` is missing, \`"none"\` (any case), or not in \`allowedAlgs\`;\n- return \`false\` if \`header.typ\` is present and not \`"JWT"\`;\n- otherwise \`true\`.\n\nAlso \`safeAlgs()\`: return \`["HS256", "RS256", "ES256"]\`.`,
      hints: ['Lower-case and reject "none" explicitly.', 'Only accept algorithms in the allow-list.'],
      starter: `// ${a.app}: reject unsafe token algorithms\nfunction headerAcceptable(header, allowedAlgs) {\n}\n\nfunction safeAlgs() {\n}\n`,
      checks: [
        fn('headerAcceptable pins the algorithm', 'headerAcceptable', [
          { args: [{ alg: 'HS256', typ: 'JWT' }, ['HS256']], expected: true },
          { args: [{ alg: 'none', typ: 'JWT' }, ['HS256']], expected: false },
          { args: [{ alg: 'NONE' }, ['HS256']], expected: false },
          { args: [{ alg: 'RS256' }, ['HS256']], expected: false },
          { args: [{ alg: 'HS256', typ: 'notjwt' }, ['HS256']], expected: false },
        ]),
        fn('safeAlgs lists real algorithms', 'safeAlgs', [{ args: [], expected: ['HS256', 'RS256', 'ES256'] }]),
      ],
      solution: `function headerAcceptable(header, allowedAlgs) {\n  if (!header.alg || String(header.alg).toLowerCase() === "none") return false;\n  if (!allowedAlgs.includes(header.alg)) return false;\n  if (header.typ !== undefined && header.typ !== "JWT") return false;\n  return true;\n}\nfunction safeAlgs() {\n  return ["HS256", "RS256", "ES256"];\n}`,
      realityNote: 'The "alg: none" and RS/HS confusion attacks defeated many early JWT libraries; always pin the expected algorithm rather than trusting the token header.',
    });
  }),

  /* ------------------------------------------------------------------ 5.5 recovery and re-authentication */
  tmpl(5, 5, 'beginner', 'recovery-safety', 'Design a safe account-recovery flow', 'E10', 20, 'Choose controls so account recovery cannot be abused to take over accounts.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Recovery is the attacker\'s favourite door\n\n**${a.org}** is designing account recovery for **${a.host}**. Make it safe, because attackers target recovery to bypass everything else.`,
      steps: [
        { title: 'Security questions', text: 'The team suggests "mother\'s maiden name" questions. Good idea?', choices: [
          { text: 'No — answers are often public or guessable; prefer a link to a verified email or a registered second factor', right: true, feedback: 'Correct. Knowledge questions are weak and should be avoided.' },
          { text: 'Yes, they are a strong second factor', feedback: 'Their answers are frequently discoverable.' },
          { text: 'Yes, if you ask three of them', feedback: 'Three weak checks are still weak.' },
        ] },
        { title: 'Recovery token', text: 'How is the recovery link built?', choices: [
          { text: 'A long random single-use token with a short expiry, sent to the verified address', right: true, feedback: 'Correct. Unguessable, single-use, short-lived.' },
          { text: 'A six-digit code valid for a week', feedback: 'Too short-lived? No — too long-lived and too short to resist guessing.' },
          { text: 'The user id encoded in the URL', feedback: 'Predictable tokens can be forged.' },
        ] },
        { title: 'After recovery', text: 'The user resets their password via recovery. What else happens?', choices: [
          { text: 'All existing sessions are invalidated and the user is notified of the change', right: true, feedback: 'Correct. End old sessions and tell the user, in case it was not them.' },
          { text: 'Nothing; the old sessions continue', feedback: 'An attacker\'s existing session would survive.' },
          { text: 'Disable MFA to make it easier', feedback: 'That is exactly the bypass to avoid.' },
        ] },
        { title: 'Changing the recovery address', text: 'An attacker tries to change the recovery email. What protects the account?', choices: [
          { text: 'Require re-authentication and notify the old address, with a delay or confirmation before it takes effect', right: true, feedback: 'Correct. Re-auth and out-of-band notice catch takeover attempts.' },
          { text: 'Allow the change instantly from any logged-in session', feedback: 'That lets a hijacked session lock out the owner.' },
          { text: 'Only log the change', feedback: 'Logging alone does not prevent the takeover.' },
        ] },
      ],
      ending: { title: 'Recovery as strong as the front door', text: 'Avoid weak knowledge questions, use single-use short-lived tokens to a verified channel, invalidate sessions and notify on reset, and protect changes to recovery details with re-auth and notice.' },
      hints: ['Attackers target recovery to bypass passwords and MFA; make it as strong.', 'Notify the user out-of-band when recovery details or passwords change.'],
      realityNote: 'Most high-profile account takeovers go through recovery flows, not the login form; hardening recovery is as important as hardening login.',
    });
  }),
  tmpl(5, 5, 'intermediate', 'recovery-token-lifecycle', 'Manage a recovery token\'s lifecycle', 'E1', 25, 'Enforce single-use and expiry on a recovery token.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## One use, short life\n\nOn **${a.host}**, a recovery token must be usable once, before it expires. Write \`tokenState(token, now)\` where \`token = { expiresAt, usedAt }\` (seconds; \`usedAt\` is \`null\` if unused):\n\n- if \`token.usedAt\` is not null → \`"used"\`;\n- else if \`now >= token.expiresAt\` → \`"expired"\`;\n- else → \`"valid"\`.\n\nAlso \`consume(token, now)\`: if \`tokenState(token, now) === "valid"\`, return \`{ ok: true, token: { ...token, usedAt: now } }\`; otherwise \`{ ok: false, reason: tokenState(token, now) }\`.`,
      hints: ['Check used before expired.', 'consume marks usedAt only on a valid token.'],
      starter: `// ${a.app}: recovery token lifecycle\nfunction tokenState(token, now) {\n}\n\nfunction consume(token, now) {\n}\n`,
      checks: [
        fn('tokenState classifies the token', 'tokenState', [
          { args: [{ expiresAt: 100, usedAt: null }, 50], expected: 'valid' },
          { args: [{ expiresAt: 100, usedAt: 60 }, 50], expected: 'used' },
          { args: [{ expiresAt: 100, usedAt: null }, 150], expected: 'expired' },
        ]),
        fn('consume enforces single use', 'consume', [
          { args: [{ expiresAt: 100, usedAt: null }, 50], expected: { ok: true, token: { expiresAt: 100, usedAt: 50 } } },
          { args: [{ expiresAt: 100, usedAt: 20 }, 50], expected: { ok: false, reason: 'used' } },
          { args: [{ expiresAt: 100, usedAt: null }, 150], expected: { ok: false, reason: 'expired' } },
        ]),
      ],
      solution: `function tokenState(token, now) {\n  if (token.usedAt !== null) return "used";\n  if (now >= token.expiresAt) return "expired";\n  return "valid";\n}\nfunction consume(token, now) {\n  const state = tokenState(token, now);\n  if (state === "valid") return { ok: true, token: { ...token, usedAt: now } };\n  return { ok: false, reason: state };\n}`,
      realityNote: 'Recovery and reset tokens must be single-use and short-lived; a token that can be replayed or never expires is a standing account-takeover risk.',
    });
  }),
  tmpl(5, 5, 'advanced', 'stepup-policy', 'Decide when to force step-up authentication', 'E1', 25, 'Combine action sensitivity, auth age and risk signals into a step-up decision.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Risk-based step-up\n\nOn **${a.host}**, decide when to demand a fresh authentication. Write \`stepUpDecision(ctx)\` where \`ctx = { sensitive, authAgeSeconds, freshWindow, riskSignals }\` (\`riskSignals\` is an array of strings like \`"new-device"\`, \`"new-country"\`):\n\n- if not \`sensitive\` and \`riskSignals.length === 0\` → \`"allow"\`;\n- compute \`stale = authAgeSeconds > freshWindow\`;\n- if \`sensitive\` and (\`stale\` or \`riskSignals.length > 0\`) → \`"step-up"\`;\n- if not \`sensitive\` but \`riskSignals.length >= 2\` → \`"step-up"\`;\n- otherwise → \`"allow"\`.`,
      hints: ['Sensitive actions step up when stale or any risk signal is present.', 'Non-sensitive actions step up only on multiple risk signals.'],
      starter: `// ${a.app}: step-up decision\nfunction stepUpDecision(ctx) {\n}\n`,
      checks: [
        fn('stepUpDecision weighs sensitivity and risk', 'stepUpDecision', [
          { args: [{ sensitive: false, authAgeSeconds: 10, freshWindow: 300, riskSignals: [] }], expected: 'allow' },
          { args: [{ sensitive: true, authAgeSeconds: 10, freshWindow: 300, riskSignals: [] }], expected: 'allow' },
          { args: [{ sensitive: true, authAgeSeconds: 400, freshWindow: 300, riskSignals: [] }], expected: 'step-up' },
          { args: [{ sensitive: true, authAgeSeconds: 10, freshWindow: 300, riskSignals: ['new-device'] }], expected: 'step-up' },
          { args: [{ sensitive: false, authAgeSeconds: 10, freshWindow: 300, riskSignals: ['new-device', 'new-country'] }], expected: 'step-up' },
        ]),
      ],
      solution: `function stepUpDecision(ctx) {\n  if (!ctx.sensitive && ctx.riskSignals.length === 0) return "allow";\n  const stale = ctx.authAgeSeconds > ctx.freshWindow;\n  if (ctx.sensitive && (stale || ctx.riskSignals.length > 0)) return "step-up";\n  if (!ctx.sensitive && ctx.riskSignals.length >= 2) return "step-up";\n  return "allow";\n}`,
      realityNote: 'Risk-based (adaptive) authentication steps up only when sensitivity or risk signals warrant it, balancing security against friction for ordinary actions.',
    });
  }),
];
