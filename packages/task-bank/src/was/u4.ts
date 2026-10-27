/** Unit 4: cross-site scripting — prevented by output encoding, cookie hardening, CSP and CSRF
 * defences. Learners write the encoders and checks that stop script from running. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U4: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 4.1 the three kinds, defensively */
  tmpl(4, 1, 'beginner', 'kinds-of-xss', 'Tell the kinds of XSS apart to fix them', 'E10', 15, 'Classify reflected, stored and DOM-based XSS by where the untrusted data flows, and the fix for each.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Where does the untrusted data flow?\n\n**${a.org}** has three cross-site scripting findings on **${a.host}**. Classify each so you fix it in the right place.`,
      steps: [
        { title: 'Reflected', text: 'A search page echoes the query straight back into the HTML. Which kind, and where is the fix?', choices: [
          { text: 'Reflected XSS — encode the value for the HTML context on the server when rendering', right: true, feedback: 'Correct. Input reflected into the response; fix with output encoding.' },
          { text: 'Stored XSS — fix the database', feedback: 'Nothing is stored; the value comes straight from the request.' },
          { text: 'It is not XSS', feedback: 'Un-encoded user input in HTML is XSS.' },
        ] },
        { title: 'Stored', text: 'A comment is saved and later shown to every visitor un-encoded. Which kind?', choices: [
          { text: 'Stored XSS — encode on output everywhere the comment is rendered (and sanitise rich input)', right: true, feedback: 'Correct. Persisted then rendered; impact is high because it hits every viewer.' },
          { text: 'Reflected XSS', feedback: 'It persists and affects later visitors, so it is stored.' },
          { text: 'DOM XSS', feedback: 'The sink is server-rendered HTML, not client-side DOM.' },
        ] },
        { title: 'DOM-based', text: 'Client JavaScript reads `location.hash` and writes it into `innerHTML`. Which kind?', choices: [
          { text: 'DOM-based XSS — fix in the client code: use textContent or a safe sink, never innerHTML with untrusted data', right: true, feedback: 'Correct. The flaw is entirely client-side; the server may never see the payload.' },
          { text: 'Reflected XSS — fix on the server', feedback: 'The server is not involved; the sink is in the browser.' },
          { text: 'Not exploitable because it is client-side', feedback: 'DOM XSS runs in the victim\'s browser just the same.' },
        ] },
        { title: 'Common thread', text: 'What do all three share?', choices: [
          { text: 'Untrusted data reaches a rendering context without being encoded or sanitised for it', right: true, feedback: 'Correct. Encode/sanitise for the exact output context and they all close.' },
          { text: 'They only affect old browsers', feedback: 'All modern browsers run injected script.' },
          { text: 'They need the attacker to log in', feedback: 'No login is required to deliver these.' },
        ] },
      ],
      ending: { title: 'Encode for the context that renders the data', text: 'Reflected and stored XSS are fixed by server-side output encoding (and sanitising rich input); DOM XSS is fixed in client code by using safe sinks. All three come from untrusted data reaching a context un-encoded.' },
      hints: ['Classify by where the data flows: reflected (request), stored (database), DOM (client sink).', 'The universal fix is encoding or sanitising for the exact rendering context.'],
      realityNote: 'Reflected, stored and DOM-based are the three XSS families; naming the sink correctly tells you whether the fix belongs on the server or in the browser.',
    });
  }),
  tmpl(4, 1, 'intermediate', 'encode-html', 'Encode text for an HTML body', 'E1', 20, 'Write the HTML-entity encoder that neutralises script in a page body.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The core defence: HTML encoding\n\nOn **${a.host}**, user text shown in a page body must be HTML-encoded so it renders as text, not markup. Write \`encodeHtml(text)\` replacing, in this order: \`&\`→\`&amp;\`, \`<\`→\`&lt;\`, \`>\`→\`&gt;\`, \`"\`→\`&quot;\`, \`'\`→\`&#39;\`.\n\nEncode \`&\` **first** so you do not double-encode the entities you create. Non-string input is coerced with \`String(text)\`.`,
      hints: ['Chain .replace calls with & first.', 'String(text) handles numbers and the like safely.'],
      starter: `// ${a.app}: HTML encoding\nfunction encodeHtml(text) {\n}\n\nconsole.log(encodeHtml("<script>alert(1)</script>"));\n`,
      checks: [
        fn('encodeHtml neutralises markup', 'encodeHtml', [
          { args: ['<script>alert(1)</script>'], expected: '&lt;script&gt;alert(1)&lt;/script&gt;' },
          { args: ['Tom & "Jerry"'], expected: 'Tom &amp; &quot;Jerry&quot;' },
          { args: ["it's"], expected: 'it&#39;s' },
          { args: ['plain'], expected: 'plain' },
        ]),
      ],
      solution: `function encodeHtml(text) {\n  return String(text)\n    .replace(/&/g, "&amp;")\n    .replace(/</g, "&lt;")\n    .replace(/>/g, "&gt;")\n    .replace(/"/g, "&quot;")\n    .replace(/'/g, "&#39;");\n}`,
      realityNote: 'HTML-entity encoding on output is the single most important XSS defence; frameworks do it by default, which is why auto-escaping templates stop most XSS.',
    });
  }),
  tmpl(4, 1, 'advanced', 'safe-dom-sink', 'Choose a safe DOM sink', 'E1', 25, 'Decide which DOM operations are safe for untrusted data and build a safe text node.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Safe sinks in the browser\n\nTo stop DOM-based XSS on **${a.host}**, model which client-side sinks are safe for untrusted data.\n\n1. \`isSafeSink(sink)\`: return \`true\` for \`"textContent"\`, \`"setAttribute"\` and \`"innerText"\`; return \`false\` for \`"innerHTML"\`, \`"outerHTML"\`, \`"document.write"\` and \`"insertAdjacentHTML"\`.\n2. \`renderInstruction(sink, value)\`: if \`isSafeSink(sink)\`, return \`{ sink, value }\` (use it as-is); otherwise return \`{ sink: "textContent", value }\` — downgrade to a safe sink rather than inject HTML.`,
      hints: ['Keep a small set of safe sinks and test membership.', 'When the requested sink is unsafe, replace it with textContent.'],
      starter: `// ${a.app}: safe DOM sinks\nfunction isSafeSink(sink) {\n}\n\nfunction renderInstruction(sink, value) {\n}\n`,
      checks: [
        fn('isSafeSink knows the safe set', 'isSafeSink', [
          { args: ['textContent'], expected: true }, { args: ['setAttribute'], expected: true },
          { args: ['innerHTML'], expected: false }, { args: ['document.write'], expected: false }, { args: ['insertAdjacentHTML'], expected: false },
        ]),
        fn('renderInstruction downgrades unsafe sinks', 'renderInstruction', [
          { args: ['textContent', 'hi'], expected: { sink: 'textContent', value: 'hi' } },
          { args: ['innerHTML', '<img onerror=x>'], expected: { sink: 'textContent', value: '<img onerror=x>' } },
        ]),
      ],
      solution: `function isSafeSink(sink) {\n  return ["textContent", "setAttribute", "innerText"].includes(sink);\n}\nfunction renderInstruction(sink, value) {\n  if (isSafeSink(sink)) return { sink, value };\n  return { sink: "textContent", value };\n}`,
      realityNote: 'DOM XSS comes from dangerous sinks (innerHTML, document.write); using textContent and other safe sinks, or Trusted Types, removes the class of bug.',
    });
  }),

  /* ------------------------------------------------------------------ 4.2 make sessions un-stealable */
  tmpl(4, 2, 'beginner', 'httponly-cookie', 'Keep script away from the session cookie', 'E1', 20, 'Build a session cookie that JavaScript cannot read, so XSS cannot steal it.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A cookie script cannot read\n\nEven if XSS runs on **${a.host}**, it must not be able to read the session cookie. Build the cookie with the right attributes.\n\n\`sessionCookie(name, value)\`: return the \`Set-Cookie\` string \`"<name>=<value>; HttpOnly; Secure; SameSite=Strict; Path=/"\`. \`HttpOnly\` hides it from \`document.cookie\`; \`Secure\` keeps it to HTTPS; \`SameSite=Strict\` stops cross-site sending.\n\nAlso write \`readableByScript(setCookie)\` returning \`true\` if the \`Set-Cookie\` string does **not** contain \`"HttpOnly"\` (i.e. script could read it) — a check for unsafe cookies.`,
      hints: ['Assemble the attributes in the given order.', 'readableByScript: !/HttpOnly/i.test(setCookie).'],
      starter: `// ${a.app}: hardened session cookie\nfunction sessionCookie(name, value) {\n}\n\nfunction readableByScript(setCookie) {\n}\n`,
      checks: [
        fn('sessionCookie sets the protective attributes', 'sessionCookie', [
          { args: ['sid', 'abc123'], expected: 'sid=abc123; HttpOnly; Secure; SameSite=Strict; Path=/' },
        ]),
        fn('readableByScript flags missing HttpOnly', 'readableByScript', [
          { args: ['sid=abc; Secure; Path=/'], expected: true },
          { args: ['sid=abc; HttpOnly; Secure'], expected: false },
        ]),
      ],
      solution: `function sessionCookie(name, value) {\n  return name + "=" + value + "; HttpOnly; Secure; SameSite=Strict; Path=/";\n}\nfunction readableByScript(setCookie) {\n  return !/HttpOnly/i.test(setCookie);\n}`,
      realityNote: 'HttpOnly keeps the session cookie out of document.cookie, so even a successful XSS cannot read it; Secure and SameSite close the other theft and forgery paths.',
    });
  }),
  tmpl(4, 2, 'intermediate', 'no-secrets-in-dom', 'Keep secrets out of the page', 'E1', 20, 'Strip sensitive fields before sending data to the browser, so a script on the page cannot read them.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Do not ship secrets to the client\n\nIf the page on **${a.host}** embeds secrets, any script (including injected script) can read them. Send only what the UI needs.\n\n1. \`publicView(user)\`: given \`{ id, name, email, pwHash, sessionToken, role }\`, return \`{ id, name, role }\` only — never the hash, token or email.\n2. \`stripSecrets(obj, secretKeys)\`: return a copy of \`obj\` with every key in \`secretKeys\` removed.`,
      hints: ['Build publicView explicitly from the three safe fields.', 'For stripSecrets, copy then delete the secret keys.'],
      starter: `// ${a.app}: keep secrets off the page\nfunction publicView(user) {\n}\n\nfunction stripSecrets(obj, secretKeys) {\n}\n`,
      checks: [
        fn('publicView exposes only safe fields', 'publicView', [
          { args: [{ id: 1, name: 'Ama', email: 'a@t.test', pwHash: 'H', sessionToken: 'T', role: 'user' }], expected: { id: 1, name: 'Ama', role: 'user' } },
        ]),
        fn('stripSecrets removes the listed keys', 'stripSecrets', [
          { args: [{ a: 1, token: 'x', b: 2 }, ['token']], expected: { a: 1, b: 2 } },
          { args: [{ a: 1 }, ['token']], expected: { a: 1 } },
        ]),
      ],
      solution: `function publicView(user) {\n  return { id: user.id, name: user.name, role: user.role };\n}\nfunction stripSecrets(obj, secretKeys) {\n  const out = { ...obj };\n  for (const key of secretKeys) delete out[key];\n  return out;\n}`,
      realityNote: 'Embedding tokens or hashes in the page (or a JSON blob the page reads) hands them to any script that runs there; send the minimum the UI needs.',
    });
  }),
  tmpl(4, 2, 'advanced', 'rotate-on-privilege', 'Rotate the session at privilege changes', 'E1', 25, 'Issue a fresh session id on login and privilege change to defeat fixation and limit theft.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## A new session when trust changes\n\nOn **${a.host}**, the session id must change whenever the trust level changes, so a fixed or stolen id does not carry privileges.\n\n1. \`shouldRotate(event)\`: return \`true\` for events \`"login"\`, \`"privilege-change"\` and \`"password-change"\`; \`false\` for \`"page-view"\` and \`"logout"\` (logout destroys the session instead).\n2. \`nextSession(event, currentId, newId)\`: if \`shouldRotate(event)\`, return \`newId\`; otherwise return \`currentId\`. (A real app generates \`newId\` from a secure random source; here it is supplied.)`,
      hints: ['Keep the rotate-events in a set.', 'Return the new id only when rotating.'],
      starter: `// ${a.app}: session rotation\nfunction shouldRotate(event) {\n}\n\nfunction nextSession(event, currentId, newId) {\n}\n`,
      checks: [
        fn('shouldRotate triggers on trust changes', 'shouldRotate', [
          { args: ['login'], expected: true }, { args: ['privilege-change'], expected: true }, { args: ['password-change'], expected: true },
          { args: ['page-view'], expected: false }, { args: ['logout'], expected: false },
        ]),
        fn('nextSession rotates only when needed', 'nextSession', [
          { args: ['login', 'old', 'new'], expected: 'new' },
          { args: ['page-view', 'old', 'new'], expected: 'old' },
        ]),
      ],
      solution: `function shouldRotate(event) {\n  return ["login", "privilege-change", "password-change"].includes(event);\n}\nfunction nextSession(event, currentId, newId) {\n  return shouldRotate(event) ? newId : currentId;\n}`,
      realityNote: 'Rotating the session identifier on login and privilege change defeats session fixation and limits how long a stolen id is useful.',
    });
  }),

  /* ------------------------------------------------------------------ 4.3 context-aware output encoding */
  tmpl(4, 3, 'beginner', 'encode-attribute', 'Encode for an HTML attribute', 'E1', 20, 'Encode a value safely for an HTML attribute, where the rules differ from a body.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Attributes need their own encoding\n\nA value placed in an attribute on **${a.host}** must not be able to close the attribute or add new ones. Write \`encodeAttribute(text)\`: for each character, letters, digits, space and \`-\`, \`_\`, \`.\` pass through unchanged; every other character becomes \`&#NN;\` with its **decimal** code (e.g. \`"\` → \`&#34;\`, \`=\` → \`&#61;\`, \`<\` → \`&#60;\`).`,
      hints: ['Loop over characters; test /[A-Za-z0-9 _.\\-]/ to pass through.', 'Otherwise "&#" + char.charCodeAt(0) + ";".'],
      starter: `// ${a.app}: attribute encoding\nfunction encodeAttribute(text) {\n}\n`,
      checks: [
        fn('encodeAttribute encodes non-safe characters', 'encodeAttribute', [
          { args: ['abc-1.2_3 x'], expected: 'abc-1.2_3 x' },
          { args: ['a"b'], expected: 'a&#34;b' },
          { args: ['x=1'], expected: 'x&#61;1' },
          { args: ['<img>'], expected: '&#60;img&#62;' },
        ]),
      ],
      solution: `function encodeAttribute(text) {\n  let out = "";\n  for (const ch of String(text)) {\n    if (/[A-Za-z0-9 _.\\-]/.test(ch)) out += ch;\n    else out += "&#" + ch.charCodeAt(0) + ";";\n  }\n  return out;\n}`,
      realityNote: 'Attribute context is more permissive than a body (unquoted attributes, event handlers), so defensive encoders aggressively entity-encode everything that is not plainly safe.',
    });
  }),
  tmpl(4, 3, 'intermediate', 'encode-js-string', 'Encode a value into a JavaScript string', 'E1', 25, 'Escape a value for embedding inside a JavaScript string literal.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Inside a script, encode for JavaScript\n\nWhen **${a.host}** must place a value inside a \`<script>\` string literal, HTML encoding is wrong; escape for JavaScript. Write \`encodeJsString(text)\` that escapes: backslash \`\\\\\`→\`\\\\\\\\\`, single quote → \`\\\\'\`, double quote → \`\\\\"\`, newline → \`\\\\n\`, carriage return → \`\\\\r\`, and \`<\` → \`\\\\x3C\` and \`>\` → \`\\\\x3E\` (so \`</script>\` cannot break out). Escape the backslash first.`,
      hints: ['Order matters: replace backslash before the others.', 'Escaping < and > as \\x3C/\\x3E prevents a </script> break-out.'],
      starter: `// ${a.app}: JavaScript string encoding\nfunction encodeJsString(text) {\n}\n`,
      checks: [
        fn('encodeJsString escapes dangerous characters', 'encodeJsString', [
          { args: ["it's"], expected: "it\\'s" },
          { args: ['a\\b'], expected: 'a\\\\b' },
          { args: ['</script>'], expected: '\\x3C/script\\x3E' },
          { args: ['line1\nline2'], expected: 'line1\\nline2' },
        ]),
      ],
      solution: `function encodeJsString(text) {\n  return String(text)\n    .replace(/\\\\/g, "\\\\\\\\")\n    .replace(/'/g, "\\\\'")\n    .replace(/"/g, '\\\\"')\n    .replace(/\\n/g, "\\\\n")\n    .replace(/\\r/g, "\\\\r")\n    .replace(/</g, "\\\\x3C")\n    .replace(/>/g, "\\\\x3E");\n}`,
      realityNote: 'Each output context (HTML, attribute, JavaScript, URL) needs its own encoding; using HTML encoding inside a script string is a classic mistake that still allows XSS.',
    });
  }),
  tmpl(4, 3, 'advanced', 'encode-by-context', 'Pick the right encoder for the context', 'E1', 25, 'Route a value to the correct encoder based on where it will be placed.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## One value, the right encoder\n\nOn **${a.host}**, the same value may go into different contexts. Route it correctly. You are given the three encoders (implement them), and write \`encodeFor(context, text)\`:\n\n- \`"html"\` → \`encodeHtml\`; \`"attribute"\` → \`encodeAttribute\`; \`"url"\` → \`encodeUrl\` (use \`encodeURIComponent\`); anything else → throw an \`Error("unknown context")\`.\n\n\`encodeHtml\`: the five-entity encoder. \`encodeAttribute\`: \`&#NN;\` for non-\`[A-Za-z0-9 _.-]\`. \`encodeUrl(text)\`: \`encodeURIComponent(String(text))\`.`,
      hints: ['Reuse your earlier encoders.', 'For an unknown context, throw new Error("unknown context").'],
      starter: `// ${a.app}: encode for the context\nfunction encodeHtml(text) {\n}\nfunction encodeAttribute(text) {\n}\nfunction encodeUrl(text) {\n}\nfunction encodeFor(context, text) {\n}\n`,
      checks: [
        fn('encodeFor routes to the right encoder', 'encodeFor', [
          { args: ['html', '<b>'], expected: '&lt;b&gt;' },
          { args: ['attribute', 'x"y'], expected: 'x&#34;y' },
          { args: ['url', 'a b&c'], expected: 'a%20b%26c' },
          { args: ['unknown', 'x'], expected: { $error: 'Error' } },
        ]),
      ],
      solution: `function encodeHtml(text) {\n  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");\n}\nfunction encodeAttribute(text) {\n  let out = "";\n  for (const ch of String(text)) out += /[A-Za-z0-9 _.\\-]/.test(ch) ? ch : "&#" + ch.charCodeAt(0) + ";";\n  return out;\n}\nfunction encodeUrl(text) {\n  return encodeURIComponent(String(text));\n}\nfunction encodeFor(context, text) {\n  if (context === "html") return encodeHtml(text);\n  if (context === "attribute") return encodeAttribute(text);\n  if (context === "url") return encodeUrl(text);\n  throw new Error("unknown context");\n}`,
      realityNote: 'Context-aware auto-escaping (as in modern template engines) picks the encoder from where a value lands; getting the context wrong is how XSS survives "encoded" output.',
    });
  }),

  /* ------------------------------------------------------------------ 4.4 CSP and sanitising rich input */
  tmpl(4, 4, 'beginner', 'build-csp', 'Build a restrictive Content-Security-Policy', 'E1', 20, 'Assemble a CSP header that blocks inline script, a strong second layer against XSS.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Defence in depth: a CSP\n\nFor **${a.host}**, build a Content-Security-Policy that stops inline and cross-origin script even if encoding is missed somewhere.\n\n\`cspHeader()\`: return exactly \`"default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"\`.\n\nAlso write \`allowsInlineScript(csp)\` returning \`true\` if the \`script-src\` directive contains \`"'unsafe-inline'"\` (a weak policy) — else \`false\`.`,
      hints: ['Return the fixed policy string.', "allowsInlineScript: /script-src[^;]*'unsafe-inline'/.test(csp)."],
      starter: `// ${a.app}: Content-Security-Policy\nfunction cspHeader() {\n}\n\nfunction allowsInlineScript(csp) {\n}\n`,
      checks: [
        fn('cspHeader is restrictive', 'cspHeader', [
          { args: [], expected: "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" },
        ]),
        fn('allowsInlineScript flags a weak policy', 'allowsInlineScript', [
          { args: ["script-src 'self' 'unsafe-inline'"], expected: true },
          { args: ["script-src 'self'"], expected: false },
        ]),
      ],
      solution: `function cspHeader() {\n  return "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";\n}\nfunction allowsInlineScript(csp) {\n  return /script-src[^;]*'unsafe-inline'/.test(csp);\n}`,
      realityNote: 'A strict CSP (no unsafe-inline, object-src none) is a strong second layer: if an encoding is missed, the browser still refuses to run the injected script.',
    });
  }),
  tmpl(4, 4, 'intermediate', 'sanitise-rich-text', 'Sanitise rich text to an allow-list of tags', 'E1', 25, 'Keep only a safe set of tags and drop everything else from user HTML.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Allow-list tags, drop the rest\n\n**${a.host}** lets users post formatted comments. Rather than block "bad" tags, allow only a safe set. Model sanitisation on a token list.\n\n\`sanitiseTokens(tokens, allowedTags)\`: \`tokens\` is an array of either \`{ type: "text", value }\` or \`{ type: "tag", name }\`. Return a new array keeping all text tokens, and keeping tag tokens only when \`name\` (lower-cased) is in \`allowedTags\`. Drop (omit) disallowed tags entirely.`,
      hints: ['Filter: keep text always; keep tags only if allowed.', 'Lower-case the tag name before the allow-list check.'],
      starter: `// ${a.app}: sanitise to an allow-list\nfunction sanitiseTokens(tokens, allowedTags) {\n}\n`,
      checks: [
        fn('sanitiseTokens keeps only safe tags', 'sanitiseTokens', [
          { args: [[{ type: 'text', value: 'hi ' }, { type: 'tag', name: 'b' }, { type: 'tag', name: 'script' }, { type: 'text', value: 'there' }], ['b', 'i', 'em']], expected: [{ type: 'text', value: 'hi ' }, { type: 'tag', name: 'b' }, { type: 'text', value: 'there' }] },
          { args: [[{ type: 'tag', name: 'IMG' }], ['b']], expected: [] },
          { args: [[{ type: 'text', value: 'only text' }], ['b']], expected: [{ type: 'text', value: 'only text' }] },
        ]),
      ],
      solution: `function sanitiseTokens(tokens, allowedTags) {\n  return tokens.filter((t) => t.type === "text" || (t.type === "tag" && allowedTags.includes(t.name.toLowerCase())));\n}`,
      realityNote: 'Real sanitisers (DOMPurify and the like) parse HTML and keep only an allow-list of tags and attributes; allow-listing is what makes them safe where block-listing fails.',
    });
  }),
  tmpl(4, 4, 'advanced', 'csp-nonce', 'Allow one trusted inline script with a nonce', 'E1', 25, 'Use a per-response nonce so only your own inline script runs under a strict CSP.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Nonce the scripts you trust\n\nWhen **${a.host}** truly needs an inline script, a per-response **nonce** lets only that script run under a strict CSP.\n\n1. \`cspWithNonce(nonce)\`: return \`"script-src 'self' 'nonce-" + nonce + "'; object-src 'none'"\`.\n2. \`scriptTag(nonce, code)\`: return \`'<script nonce="' + nonce + '">' + code + '</script>'\`.\n3. \`scriptAllowed(tagNonce, cspNonce)\`: return \`true\` only when both are non-empty strings and equal — the browser runs an inline script only if its nonce matches the policy.`,
      hints: ['Build the two strings exactly as specified.', 'scriptAllowed is a non-empty equality check.'],
      starter: `// ${a.app}: CSP nonce\nfunction cspWithNonce(nonce) {\n}\n\nfunction scriptTag(nonce, code) {\n}\n\nfunction scriptAllowed(tagNonce, cspNonce) {\n}\n`,
      checks: [
        fn('cspWithNonce embeds the nonce', 'cspWithNonce', [
          { args: ['r4nd0m'], expected: "script-src 'self' 'nonce-r4nd0m'; object-src 'none'" },
        ]),
        fn('scriptTag carries the nonce', 'scriptTag', [
          { args: ['r4nd0m', 'doThing()'], expected: '<script nonce="r4nd0m">doThing()</script>' },
        ]),
        fn('scriptAllowed matches nonces', 'scriptAllowed', [
          { args: ['r4nd0m', 'r4nd0m'], expected: true },
          { args: ['r4nd0m', 'other'], expected: false },
          { args: ['', ''], expected: false },
        ]),
      ],
      solution: `function cspWithNonce(nonce) {\n  return "script-src 'self' 'nonce-" + nonce + "'; object-src 'none'";\n}\nfunction scriptTag(nonce, code) {\n  return '<script nonce="' + nonce + '">' + code + '</script>';\n}\nfunction scriptAllowed(tagNonce, cspNonce) {\n  return typeof tagNonce === "string" && tagNonce !== "" && tagNonce === cspNonce;\n}`,
      realityNote: 'A fresh random nonce per response lets a strict CSP permit exactly your inline scripts while still blocking injected ones, since the attacker cannot guess the nonce.',
    });
  }),

  /* ------------------------------------------------------------------ 4.5 CSRF defences */
  tmpl(4, 5, 'beginner', 'csrf-token', 'Protect a state-changing request with a token', 'E1', 20, 'Require a secret token on POST requests so another site cannot forge them.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Prove the request came from your page\n\nOn **${a.host}**, a cross-site page can make a victim\'s browser send a POST. A secret per-session token the attacker cannot read defeats it.\n\n1. \`constantTimeEqual(a, b)\`: XOR compare, no early return, false if lengths differ.\n2. \`csrfOk(method, sentToken, sessionToken)\`: safe methods (\`GET\`, \`HEAD\`, \`OPTIONS\`) need no token → return \`true\`. For any other method, return \`true\` only when \`sentToken\` and \`sessionToken\` are non-empty and \`constantTimeEqual\` says they match.`,
      hints: ['Read-only methods are exempt; state-changing ones need the token.', 'Compare the tokens in constant time.'],
      starter: `// ${a.app}: CSRF token check\nfunction constantTimeEqual(a, b) {\n}\n\nfunction csrfOk(method, sentToken, sessionToken) {\n}\n`,
      checks: [
        fn('csrfOk enforces the token on writes', 'csrfOk', [
          { args: ['GET', '', 'SESS'], expected: true },
          { args: ['POST', 'SESS', 'SESS'], expected: true },
          { args: ['POST', 'WRONG', 'SESS'], expected: false },
          { args: ['POST', '', 'SESS'], expected: false },
          { args: ['DELETE', 'SESS', 'SESS'], expected: true },
        ]),
      ],
      solution: `function constantTimeEqual(a, b) {\n  if (a.length !== b.length) return false;\n  let diff = 0;\n  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);\n  return diff === 0;\n}\nfunction csrfOk(method, sentToken, sessionToken) {\n  if (["GET", "HEAD", "OPTIONS"].includes(method)) return true;\n  if (!sentToken || !sessionToken) return false;\n  return constantTimeEqual(sentToken, sessionToken);\n}`,
      realityNote: 'The synchroniser-token pattern — a secret token tied to the session and required on state-changing requests — is the classic CSRF defence.',
    });
  }),
  tmpl(4, 5, 'intermediate', 'samesite-cookie', 'Use SameSite cookies against CSRF', 'E1', 20, 'Decide whether a cookie rides a cross-site request under each SameSite setting.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## SameSite: do not send cookies cross-site\n\nFor **${a.host}**, model when a cookie is attached. \`cookieSentCrossSite(sameSite, method, crossSite)\` where \`sameSite\` is \`"Strict"\`, \`"Lax"\` or \`"None"\`, \`method\` is the HTTP method, and \`crossSite\` is a boolean (the request originates from another site):\n\n- same-site request (\`crossSite === false\`): always \`true\`;\n- \`"Strict"\`: cross-site → \`false\`;\n- \`"Lax"\`: cross-site → \`true\` only for top-level safe navigations, modelled as \`method === "GET"\`; otherwise \`false\`;\n- \`"None"\`: cross-site → \`true\` (so such cookies must also be \`Secure\` and need other CSRF defences).`,
      hints: ['Handle the same-site case first (always sent).', 'Lax sends cross-site only on GET; Strict never does; None always does.'],
      starter: `// ${a.app}: SameSite behaviour\nfunction cookieSentCrossSite(sameSite, method, crossSite) {\n}\n`,
      checks: [
        fn('cookieSentCrossSite models SameSite', 'cookieSentCrossSite', [
          { args: ['Strict', 'GET', false], expected: true },
          { args: ['Strict', 'GET', true], expected: false },
          { args: ['Lax', 'GET', true], expected: true },
          { args: ['Lax', 'POST', true], expected: false },
          { args: ['None', 'POST', true], expected: true },
        ]),
      ],
      solution: `function cookieSentCrossSite(sameSite, method, crossSite) {\n  if (!crossSite) return true;\n  if (sameSite === "Strict") return false;\n  if (sameSite === "Lax") return method === "GET";\n  return true;\n}`,
      realityNote: 'SameSite=Lax (the modern default) stops cookies riding cross-site POSTs, which blocks most CSRF; SameSite=None needs Secure and additional token defences.',
    });
  }),
  tmpl(4, 5, 'advanced', 'reauth-sensitive', 'Require re-authentication for sensitive actions', 'E1', 25, 'Demand a fresh authentication for high-risk actions even within a valid session.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Step-up for the risky actions\n\nOn **${a.host}**, a valid session is not enough to change a password or move money; those need a recent re-authentication. Write \`needsReauth(action, lastAuthSecondsAgo, windowSeconds)\`:\n\n- sensitive actions are \`"change-password"\`, \`"transfer-funds"\`, \`"change-email"\`, \`"delete-account"\`;\n- for a sensitive action, return \`true\` when \`lastAuthSecondsAgo > windowSeconds\` (the fresh auth has expired), else \`false\`;\n- for any non-sensitive action, return \`false\`.\n\nAlso \`allowAction(action, lastAuthSecondsAgo, windowSeconds)\`: return \`true\` when the action does **not** need re-auth (i.e. \`!needsReauth(...)\`).`,
      hints: ['Keep the sensitive-action set; compare the age to the window.', 'allowAction is simply the negation of needsReauth.'],
      starter: `// ${a.app}: step-up re-authentication\nfunction needsReauth(action, lastAuthSecondsAgo, windowSeconds) {\n}\n\nfunction allowAction(action, lastAuthSecondsAgo, windowSeconds) {\n}\n`,
      checks: [
        fn('needsReauth triggers on stale sensitive actions', 'needsReauth', [
          { args: ['transfer-funds', 1000, 300], expected: true },
          { args: ['transfer-funds', 100, 300], expected: false },
          { args: ['view-balance', 1000, 300], expected: false },
          { args: ['change-password', 301, 300], expected: true },
        ]),
        fn('allowAction permits when fresh enough', 'allowAction', [
          { args: ['transfer-funds', 100, 300], expected: true },
          { args: ['transfer-funds', 1000, 300], expected: false },
          { args: ['view-balance', 9999, 300], expected: true },
        ]),
      ],
      solution: `function needsReauth(action, lastAuthSecondsAgo, windowSeconds) {\n  const sensitive = ["change-password", "transfer-funds", "change-email", "delete-account"];\n  if (!sensitive.includes(action)) return false;\n  return lastAuthSecondsAgo > windowSeconds;\n}\nfunction allowAction(action, lastAuthSecondsAgo, windowSeconds) {\n  return !needsReauth(action, lastAuthSecondsAgo, windowSeconds);\n}`,
      realityNote: 'Step-up or re-authentication for sensitive actions (as banks do before a transfer) limits the damage a hijacked or walked-up-to session can do.',
    });
  }),
];
