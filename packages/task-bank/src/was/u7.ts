/** Unit 7: SSRF and file attacks — prevented. Learners build URL allow-lists that block internal
 * ranges, safe upload validation and storage, path-traversal-safe joins, and XXE-safe parsing. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U7: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 7.1 SSRF defences */
  tmpl(7, 1, 'beginner', 'block-private-ranges', 'Block requests to internal addresses', 'E1', 25, 'Reject URLs that resolve to loopback, private or link-local ranges to stop SSRF.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Do not let the server fetch itself\n\nA feature on **${a.host}** fetches a user-supplied URL (an avatar, say). An attacker points it at internal services or cloud metadata. Block private destinations.\n\n1. \`isPrivateIp(ip)\`: return \`true\` for IPv4 in \`127.0.0.0/8\` (\`127.\`), \`10.0.0.0/8\` (\`10.\`), \`192.168.0.0/16\` (\`192.168.\`), \`172.16.0.0/12\` (\`172.16.\`–\`172.31.\`), \`169.254.0.0/16\` (link-local, includes cloud metadata \`169.254.169.254\`), and \`0.0.0.0\`. Else \`false\`.\n2. \`allowedTarget(ip)\`: return \`true\` only when \`isPrivateIp(ip)\` is \`false\`.`,
      hints: ['For 172.16/12, the second octet is 16–31.', 'Split the IP on "." to test octets.'],
      starter: `// ${a.app}: block internal addresses\nfunction isPrivateIp(ip) {\n}\n\nfunction allowedTarget(ip) {\n}\n`,
      checks: [
        fn('isPrivateIp spots internal ranges', 'isPrivateIp', [
          { args: ['127.0.0.1'], expected: true }, { args: ['10.1.2.3'], expected: true }, { args: ['192.168.1.1'], expected: true },
          { args: ['172.16.0.1'], expected: true }, { args: ['172.31.255.1'], expected: true }, { args: ['172.32.0.1'], expected: false },
          { args: ['169.254.169.254'], expected: true }, { args: ['8.8.8.8'], expected: false },
        ]),
        fn('allowedTarget permits only public ips', 'allowedTarget', [
          { args: ['8.8.8.8'], expected: true }, { args: ['169.254.169.254'], expected: false },
        ]),
      ],
      solution: `function isPrivateIp(ip) {\n  const o = ip.split(".").map(Number);\n  if (o.length !== 4 || o.some((n) => Number.isNaN(n))) return false;\n  if (o[0] === 127) return true;\n  if (o[0] === 10) return true;\n  if (o[0] === 192 && o[1] === 168) return true;\n  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;\n  if (o[0] === 169 && o[1] === 254) return true;\n  if (ip === "0.0.0.0") return true;\n  return false;\n}\nfunction allowedTarget(ip) {\n  return !isPrivateIp(ip);\n}`,
      realityNote: 'SSRF commonly targets 169.254.169.254 (cloud metadata) and internal services; blocking private, loopback and link-local ranges after DNS resolution is a core defence.',
    });
  }),
  tmpl(7, 1, 'intermediate', 'ssrf-url-allowlist', 'Fetch only from an allow-list of hosts', 'E1', 25, 'Restrict outbound fetches to an explicit list of hosts and schemes.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Allow-list the destinations\n\nThe safest SSRF defence on **${a.host}** is to fetch only from known hosts. Write \`fetchAllowed(url, allowedHosts)\`:\n\n- parse with \`new URL(url)\`; if it throws, return \`false\`;\n- the scheme must be \`https:\` (reject \`http:\`, \`file:\`, \`gopher:\`, etc.);\n- the host must be in \`allowedHosts\` (exact match);\n- otherwise \`false\`.\n\nAlso \`schemeOf(url)\`: return the protocol without the colon (e.g. \`"https"\`), or \`null\` if the URL is invalid.`,
      hints: ['Wrap new URL in try/catch.', 'url.protocol includes the trailing colon; strip it for schemeOf.'],
      starter: `// ${a.app}: outbound allow-list\nfunction fetchAllowed(url, allowedHosts) {\n}\n\nfunction schemeOf(url) {\n}\n`,
      checks: [
        fn('fetchAllowed restricts host and scheme', 'fetchAllowed', [
          { args: ['https://cdn.partner.test/a.png', ['cdn.partner.test']], expected: true },
          { args: ['http://cdn.partner.test/a.png', ['cdn.partner.test']], expected: false },
          { args: ['https://evil.test/a.png', ['cdn.partner.test']], expected: false },
          { args: ['file:///etc/passwd', ['cdn.partner.test']], expected: false },
          { args: ['not a url', ['cdn.partner.test']], expected: false },
        ]),
        fn('schemeOf returns the scheme', 'schemeOf', [
          { args: ['https://x.test'], expected: 'https' }, { args: ['ftp://x.test'], expected: 'ftp' }, { args: ['bad'], expected: null },
        ]),
      ],
      solution: `function fetchAllowed(url, allowedHosts) {\n  let u;\n  try { u = new URL(url); } catch (e) { return false; }\n  if (u.protocol !== "https:") return false;\n  return allowedHosts.includes(u.host);\n}\nfunction schemeOf(url) {\n  try { return new URL(url).protocol.replace(/:$/, ""); } catch (e) { return null; }\n}`,
      realityNote: 'An explicit allow-list of outbound hosts and schemes is the strongest SSRF defence; combine it with blocking private ranges after DNS resolution to cover rebinding.',
    });
  }),
  tmpl(7, 1, 'advanced', 'ssrf-egress-decision', 'Combine allow-list, scheme and range checks', 'E1', 25, 'Make the full egress decision, including a redirect target, before fetching.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The whole egress decision\n\nFor **${a.host}**, combine the checks. You are given \`isPrivateIp(ip)\` (implement the loopback/private/link-local check). Write \`egressDecision(req)\` where \`req = { scheme, host, resolvedIp, allowedHosts }\`:\n\n- deny with \`"bad-scheme"\` if \`scheme !== "https"\`;\n- deny with \`"host-not-allowed"\` if \`host\` is not in \`allowedHosts\`;\n- deny with \`"private-ip"\` if \`isPrivateIp(resolvedIp)\` (covers DNS pointing an allowed host at an internal address);\n- otherwise \`{ allow: true }\`. Denials return \`{ allow: false, reason }\`.`,
      hints: ['Check scheme, then host allow-list, then the resolved IP.', 'The resolved-IP check defeats DNS rebinding to an internal address.'],
      starter: `// ${a.app}: full egress decision\nfunction isPrivateIp(ip) {\n  const o = ip.split(".").map(Number);\n  if (o[0] === 127 || o[0] === 10) return true;\n  if (o[0] === 192 && o[1] === 168) return true;\n  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;\n  if (o[0] === 169 && o[1] === 254) return true;\n  return false;\n}\n\nfunction egressDecision(req) {\n}\n`,
      checks: [
        fn('egressDecision applies all checks in order', 'egressDecision', [
          { args: [{ scheme: 'https', host: 'cdn.test', resolvedIp: '8.8.8.8', allowedHosts: ['cdn.test'] }], expected: { allow: true } },
          { args: [{ scheme: 'http', host: 'cdn.test', resolvedIp: '8.8.8.8', allowedHosts: ['cdn.test'] }], expected: { allow: false, reason: 'bad-scheme' } },
          { args: [{ scheme: 'https', host: 'evil.test', resolvedIp: '8.8.8.8', allowedHosts: ['cdn.test'] }], expected: { allow: false, reason: 'host-not-allowed' } },
          { args: [{ scheme: 'https', host: 'cdn.test', resolvedIp: '169.254.169.254', allowedHosts: ['cdn.test'] }], expected: { allow: false, reason: 'private-ip' } },
        ]),
      ],
      solution: `function isPrivateIp(ip) {\n  const o = ip.split(".").map(Number);\n  if (o[0] === 127 || o[0] === 10) return true;\n  if (o[0] === 192 && o[1] === 168) return true;\n  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;\n  if (o[0] === 169 && o[1] === 254) return true;\n  return false;\n}\nfunction egressDecision(req) {\n  if (req.scheme !== "https") return { allow: false, reason: "bad-scheme" };\n  if (!req.allowedHosts.includes(req.host)) return { allow: false, reason: "host-not-allowed" };\n  if (isPrivateIp(req.resolvedIp)) return { allow: false, reason: "private-ip" };\n  return { allow: true };\n}`,
      realityNote: 'Checking the resolved IP (not just the hostname) defeats DNS rebinding, where an allowed host resolves to an internal address after the allow-list check.',
    });
  }),

  /* ------------------------------------------------------------------ 7.2 safe file upload */
  tmpl(7, 2, 'beginner', 'upload-extension-allowlist', 'Allow only safe upload types', 'E1', 20, 'Validate an upload by an allow-list of extensions and a size cap.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Allow-list the upload types\n\nOn **${a.host}**, users upload profile images. Allow only safe types by extension and cap the size. Write \`uploadOk(filename, sizeBytes, allowedExts, maxBytes)\`:\n\n- extract the extension as the lower-cased text after the **last** \`.\`; if there is no \`.\`, reject;\n- the extension must be in \`allowedExts\` (lower-case);\n- \`sizeBytes\` must be \`> 0\` and \`<= maxBytes\`;\n- return \`true\` only when all hold.\n\nAlso \`extensionOf(filename)\`: return the lower-cased extension, or \`""\` if none.`,
      hints: ['lastIndexOf(".") finds the real extension; beware names with no dot.', 'Reject double extensions by only trusting the final one and the allow-list.'],
      starter: `// ${a.app}: upload validation\nfunction extensionOf(filename) {\n}\n\nfunction uploadOk(filename, sizeBytes, allowedExts, maxBytes) {\n}\n`,
      checks: [
        fn('extensionOf reads the final extension', 'extensionOf', [
          { args: ['photo.PNG'], expected: 'png' }, { args: ['archive.tar.gz'], expected: 'gz' }, { args: ['noext'], expected: '' },
        ]),
        fn('uploadOk validates type and size', 'uploadOk', [
          { args: ['a.png', 1000, ['png', 'jpg'], 5000], expected: true },
          { args: ['a.php', 1000, ['png', 'jpg'], 5000], expected: false },
          { args: ['shell.php.png', 1000, ['png'], 5000], expected: true },
          { args: ['a.png', 9000, ['png'], 5000], expected: false },
          { args: ['a.png', 0, ['png'], 5000], expected: false },
        ]),
      ],
      solution: `function extensionOf(filename) {\n  const i = filename.lastIndexOf(".");\n  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();\n}\nfunction uploadOk(filename, sizeBytes, allowedExts, maxBytes) {\n  const ext = extensionOf(filename);\n  if (!ext || !allowedExts.includes(ext)) return false;\n  return sizeBytes > 0 && sizeBytes <= maxBytes;\n}`,
      realityNote: 'Upload validation by an allow-list of final extensions and a size cap is the first gate; note that validating the final extension plus how the file is stored and served is what actually prevents code execution.',
    });
  }),
  tmpl(7, 2, 'intermediate', 'verify-content-type', 'Match declared type to real content', 'E1', 25, 'Compare the claimed MIME type with the file\'s magic bytes to reject disguised uploads.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Trust the bytes, not the label\n\nOn **${a.host}**, an attacker labels a script as \`image/png\`. Check the magic bytes. Write:\n\n1. \`sniffType(bytes)\`: \`bytes\` is an array of numbers (the first bytes). Return \`"png"\` for \`[137,80,78,71]\`, \`"jpg"\` for \`[255,216,255]\` (first three), \`"gif"\` for \`[71,73,70]\` (\`GIF\`), else \`"unknown"\`.\n2. \`contentMatches(declaredMime, bytes)\`: map \`"image/png"\`→\`"png"\`, \`"image/jpeg"\`→\`"jpg"\`, \`"image/gif"\`→\`"gif"\`; return \`true\` only when \`sniffType(bytes)\` equals the mapped type. Any other declared MIME → \`false\`.`,
      hints: ['Compare the leading bytes for each signature.', 'Reject when the sniffed type does not match the declared one.'],
      starter: `// ${a.app}: content-type verification\nfunction sniffType(bytes) {\n}\n\nfunction contentMatches(declaredMime, bytes) {\n}\n`,
      checks: [
        fn('sniffType reads magic bytes', 'sniffType', [
          { args: [[137, 80, 78, 71, 13]], expected: 'png' },
          { args: [[255, 216, 255, 224]], expected: 'jpg' },
          { args: [[71, 73, 70, 56]], expected: 'gif' },
          { args: [[60, 63, 112, 104, 112]], expected: 'unknown' },
        ]),
        fn('contentMatches compares declared to real', 'contentMatches', [
          { args: ['image/png', [137, 80, 78, 71]], expected: true },
          { args: ['image/png', [255, 216, 255]], expected: false },
          { args: ['text/php', [60, 63]], expected: false },
        ]),
      ],
      solution: `function sniffType(bytes) {\n  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "png";\n  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";\n  if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) return "gif";\n  return "unknown";\n}\nfunction contentMatches(declaredMime, bytes) {\n  const map = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" };\n  const want = map[declaredMime];\n  if (!want) return false;\n  return sniffType(bytes) === want;\n}`,
      realityNote: 'The client-supplied Content-Type is attacker-controlled; verifying the file\'s actual signature stops a script or HTML file masquerading as an image.',
    });
  }),
  tmpl(7, 2, 'advanced', 'safe-stored-name', 'Store uploads under safe, generated names', 'E1', 25, 'Generate a storage name that cannot be executed or traverse directories.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Never store under the user\'s name\n\nOn **${a.host}**, store an upload under a generated name with a safe extension, outside any executable path. Write:\n\n1. \`safeStoredName(id, ext, allowedExts)\`: if \`ext\` (lower-cased) is in \`allowedExts\`, return \`id + "." + ext.toLowerCase()\`; otherwise return \`id + ".bin"\` (store unknown types inertly).\n2. \`isExecutablePath(path)\`: return \`true\` if \`path\` contains a segment ending in a dangerous extension \`.php\`, \`.jsp\`, \`.asp\`, \`.cgi\`, \`.sh\` or \`.exe\` (case-insensitive) — a check that storage never lands somewhere executable.`,
      hints: ['Force the stored extension from the allow-list, defaulting to .bin.', 'isExecutablePath: test the path against a dangerous-extension regex.'],
      starter: `// ${a.app}: safe stored names\nfunction safeStoredName(id, ext, allowedExts) {\n}\n\nfunction isExecutablePath(path) {\n}\n`,
      checks: [
        fn('safeStoredName uses a generated name', 'safeStoredName', [
          { args: ['abc123', 'PNG', ['png', 'jpg']], expected: 'abc123.png' },
          { args: ['abc123', 'php', ['png', 'jpg']], expected: 'abc123.bin' },
        ]),
        fn('isExecutablePath flags dangerous paths', 'isExecutablePath', [
          { args: ['/var/www/uploads/x.png'], expected: false },
          { args: ['/var/www/uploads/shell.php'], expected: true },
          { args: ['/srv/app/run.SH'], expected: true },
        ]),
      ],
      solution: `function safeStoredName(id, ext, allowedExts) {\n  const e = String(ext).toLowerCase();\n  return allowedExts.includes(e) ? id + "." + e : id + ".bin";\n}\nfunction isExecutablePath(path) {\n  return /\\.(php|jsp|asp|cgi|sh|exe)(\\/|$)/i.test(path);\n}`,
      realityNote: 'Storing uploads under generated names with a forced-safe extension, outside any path the web server will execute, prevents the upload-to-code-execution chain.',
    });
  }),

  /* ------------------------------------------------------------------ 7.3 path traversal and inclusion */
  tmpl(7, 3, 'beginner', 'safe-join', 'Join a path without escaping the root', 'E1', 25, 'Resolve a requested file within a root directory, rejecting traversal.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Stay inside the root\n\nOn **${a.host}**, a download endpoint serves files from a root directory. Write:\n\n1. \`normalise(path)\`: resolve \`.\` and \`..\` of a \`/\`-separated path (\`..\` cannot go above the top), returning a path with a leading \`/\`.\n2. \`safeResolve(root, requested)\`: compute \`normalise(root + "/" + requested)\`; return it only if it equals \`root\` or starts with \`root + "/"\`; otherwise return \`null\` (reject traversal).`,
      hints: ['Reuse the segment-stack normaliser from unit 1.', 'After joining and normalising, confirm the result is still under root.'],
      starter: `// ${a.app}: safe path join\nfunction normalise(path) {\n}\n\nfunction safeResolve(root, requested) {\n}\n`,
      checks: [
        fn('normalise resolves dot segments', 'normalise', [
          { args: ['/srv/files/./a.txt'], expected: '/srv/files/a.txt' },
          { args: ['/srv/files/../../etc/passwd'], expected: '/etc/passwd' },
        ]),
        fn('safeResolve rejects traversal', 'safeResolve', [
          { args: ['/srv/files', 'a.txt'], expected: '/srv/files/a.txt' },
          { args: ['/srv/files', '../../etc/passwd'], expected: null },
          { args: ['/srv/files', 'sub/b.txt'], expected: '/srv/files/sub/b.txt' },
        ]),
      ],
      solution: `function normalise(path) {\n  const out = [];\n  for (const seg of path.split("/")) {\n    if (seg === "" || seg === ".") continue;\n    if (seg === "..") out.pop();\n    else out.push(seg);\n  }\n  return "/" + out.join("/");\n}\nfunction safeResolve(root, requested) {\n  const full = normalise(root + "/" + requested);\n  return full === root || full.startsWith(root + "/") ? full : null;\n}`,
      realityNote: 'Path traversal (../../) is defeated by resolving the path and confirming it is still within the intended root — never by string-stripping "..", which is bypassable.',
    });
  }),
  tmpl(7, 3, 'intermediate', 'template-allowlist', 'Include only known templates', 'E1', 20, 'Map a template name to a fixed set instead of building a path from input.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Map names to a known set\n\nFile-inclusion bugs come from building a path from user input. On **${a.host}**, map the requested view to a fixed registry instead. Write:\n\n1. \`resolveTemplate(name, registry)\`: \`registry\` maps a name to a real template path. Return \`registry[name]\` if the name is an **own property**, else \`null\`.\n2. \`isSafeName(name)\`: return \`true\` only for \`/^[a-z][a-z0-9_-]*$/\` (no slashes, dots or traversal).`,
      hints: ['Use hasOwnProperty so prototype keys cannot be reached.', 'The name check forbids slashes and dots entirely.'],
      starter: `// ${a.app}: template allow-list\nfunction resolveTemplate(name, registry) {\n}\n\nfunction isSafeName(name) {\n}\n`,
      checks: [
        fn('resolveTemplate maps to known templates', 'resolveTemplate', [
          { args: ['home', { home: '/views/home.html', about: '/views/about.html' }], expected: '/views/home.html' },
          { args: ['../../etc/passwd', { home: '/views/home.html' }], expected: null },
          { args: ['toString', { home: '/views/home.html' }], expected: null },
        ]),
        fn('isSafeName forbids traversal characters', 'isSafeName', [
          { args: ['home'], expected: true }, { args: ['a_b-1'], expected: true }, { args: ['../x'], expected: false }, { args: ['a.b'], expected: false },
        ]),
      ],
      solution: `function resolveTemplate(name, registry) {\n  return Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : null;\n}\nfunction isSafeName(name) {\n  return /^[a-z][a-z0-9_-]*$/.test(name);\n}`,
      realityNote: 'Local/remote file inclusion is avoided by mapping a request to a fixed registry of allowed views rather than constructing a file path from user input.',
    });
  }),
  tmpl(7, 3, 'advanced', 'reject-null-and-encoding', 'Reject null bytes and encoded traversal', 'E1', 25, 'Decode once and reject null bytes and encoded traversal before resolving a path.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Decode, then check\n\nAttackers hide traversal with URL-encoding (\`%2e%2e%2f\`) and null bytes (\`%00\`). On **${a.host}**, clean the input first. Write \`decodeOnce(s)\` returning \`decodeURIComponent(s)\` (or \`null\` if it throws), and \`rejectIfDangerous(decoded)\`:\n\n- return \`"null-byte"\` if \`decoded\` contains a \`\\u0000\`;\n- return \`"traversal"\` if it contains \`".."\` or a backslash \`\\\\\`;\n- return \`"absolute"\` if it starts with \`/\`;\n- otherwise \`"ok"\`.\n\nThen \`cleanSegment(raw)\`: decode once; if decode failed return \`null\`; if \`rejectIfDangerous\` is not \`"ok"\`, return \`null\`; else return the decoded value.`,
      hints: ['Decode a single time, then inspect; do not loop-decode.', 'Any of null byte, "..", backslash or leading "/" means reject.'],
      starter: `// ${a.app}: reject encoded traversal\nfunction decodeOnce(s) {\n}\n\nfunction rejectIfDangerous(decoded) {\n}\n\nfunction cleanSegment(raw) {\n}\n`,
      checks: [
        fn('decodeOnce decodes safely', 'decodeOnce', [
          { args: ['%2e%2e%2f'], expected: '../' }, { args: ['file.txt'], expected: 'file.txt' }, { args: ['%'], expected: null },
        ]),
        fn('rejectIfDangerous classifies the input', 'rejectIfDangerous', [
          { args: ['file.txt'], expected: 'ok' }, { args: ['a\u0000b'], expected: 'null-byte' }, { args: ['../x'], expected: 'traversal' }, { args: ['/etc'], expected: 'absolute' },
        ]),
        fn('cleanSegment rejects dangerous input', 'cleanSegment', [
          { args: ['report.pdf'], expected: 'report.pdf' }, { args: ['%2e%2e%2fetc'], expected: null }, { args: ['%'], expected: null },
        ]),
      ],
      solution: `function decodeOnce(s) {\n  try { return decodeURIComponent(s); } catch (e) { return null; }\n}\nfunction rejectIfDangerous(decoded) {\n  if (decoded.includes("\\u0000")) return "null-byte";\n  if (decoded.includes("..") || decoded.includes("\\\\")) return "traversal";\n  if (decoded.startsWith("/")) return "absolute";\n  return "ok";\n}\nfunction cleanSegment(raw) {\n  const decoded = decodeOnce(raw);\n  if (decoded === null) return null;\n  return rejectIfDangerous(decoded) === "ok" ? decoded : null;\n}`,
      realityNote: 'Decoding once and then rejecting null bytes, "..", backslashes and absolute paths stops the encoded-traversal tricks that bypass naive filters.',
    });
  }),

  /* ------------------------------------------------------------------ 7.4 deserialisation and XXE, defensively */
  tmpl(7, 4, 'beginner', 'xxe-safe-parsing', 'Parse XML without external entities', 'E10', 15, 'Choose parser settings that disable the features behind XXE.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Turn off the dangerous features\n\n**${a.org}** parses uploaded XML on **${a.host}**. XML external entities (XXE) can read local files or reach internal services. Configure the parser safely.`,
      steps: [
        { title: 'The root cause', text: 'What makes XXE possible?', choices: [
          { text: 'The parser resolves external entities and DTDs referenced in the document', right: true, feedback: 'Correct. External entity/DTD processing is the dangerous feature.' },
          { text: 'XML is always unsafe and cannot be used', feedback: 'XML is fine once the dangerous features are disabled.' },
          { text: 'The file is too large', feedback: 'Size is a separate concern (billion laughs); XXE is about external entities.' },
        ] },
        { title: 'The fix', text: 'How do you configure the parser?', choices: [
          { text: 'Disable DTDs and external entity resolution entirely (or use a parser that does so by default)', right: true, feedback: 'Correct. No DTDs, no external entities.' },
          { text: 'Allow entities but scan for "file://"', feedback: 'Block-listing schemes is bypassable; disable the feature.' },
          { text: 'Trust XML from logged-in users', feedback: 'Authenticated users can still send malicious XML.' },
        ] },
        { title: 'A simpler option', text: 'The data is simple key/values. Is there a lower-risk format?', choices: [
          { text: 'Prefer JSON (with a size limit and schema) when you do not need XML\'s features', right: true, feedback: 'Correct. JSON has no entity/DTD machinery to abuse.' },
          { text: 'Use XML because it is more powerful', feedback: 'More power here means more attack surface; prefer the simpler format.' },
          { text: 'Accept any format the client sends', feedback: 'Pin the expected format and validate it.' },
        ] },
        { title: 'Denial of service', text: 'Besides XXE, what else must the parser guard against?', choices: [
          { text: 'Entity-expansion bombs (billion laughs) and oversized input — cap size and expansion', right: true, feedback: 'Correct. Limit size and entity expansion to prevent resource exhaustion.' },
          { text: 'Nothing else', feedback: 'Entity-expansion DoS is a real risk even with external entities off.' },
          { text: 'Only network attacks', feedback: 'Local resource exhaustion is the concern here.' },
        ] },
      ],
      ending: { title: 'Disable the dangerous features', text: 'XXE is prevented by disabling DTDs and external entity resolution; prefer JSON when XML features are not needed, and cap size and entity expansion against DoS.' },
      hints: ['The fix for XXE is to disable DTD and external-entity processing.', 'Prefer a simpler format (JSON) when you do not need XML.'],
      realityNote: 'Most modern XML libraries can disable external entities and DTDs; doing so (or choosing JSON) removes XXE, a once-common and high-impact flaw.',
    });
  }),
  tmpl(7, 4, 'intermediate', 'safe-deserialise', 'Deserialise data without executing it', 'E1', 25, 'Parse JSON safely and validate its shape rather than reconstructing arbitrary objects.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Data in, not code\n\nOn **${a.host}**, deserialise untrusted input as plain data and validate it — never into live objects that can run code. Write:\n\n1. \`parseJsonSafe(text)\`: return the parsed value, or \`null\` if \`JSON.parse\` throws.\n2. \`hasDangerousKeys(obj)\`: return \`true\` if \`obj\` is a non-null object with an own key of \`"__proto__"\`, \`"constructor"\` or \`"prototype"\` (prototype-pollution vectors), else \`false\`.\n3. \`acceptPayload(text, requiredKeys)\`: parse safely; if \`null\` or not a plain object or \`hasDangerousKeys\`, return \`null\`; if every name in \`requiredKeys\` is an own key, return the object, else \`null\`.`,
      hints: ['Wrap JSON.parse in try/catch.', 'Reject __proto__/constructor/prototype keys before using the object.'],
      starter: `// ${a.app}: safe deserialisation\nfunction parseJsonSafe(text) {\n}\n\nfunction hasDangerousKeys(obj) {\n}\n\nfunction acceptPayload(text, requiredKeys) {\n}\n`,
      checks: [
        fn('parseJsonSafe never throws', 'parseJsonSafe', [
          { args: ['{"a":1}'], expected: { a: 1 } }, { args: ['not json'], expected: null },
        ]),
        fn('hasDangerousKeys spots pollution vectors', 'hasDangerousKeys', [
          { args: [{ a: 1 }], expected: false }, { args: [{ constructor: 1 }], expected: true }, { args: [{ prototype: 2 }], expected: true },
        ]),
        fn('acceptPayload validates shape safely', 'acceptPayload', [
          { args: ['{"name":"Ama","age":5}', ['name', 'age']], expected: { name: 'Ama', age: 5 } },
          { args: ['{"name":"Ama"}', ['name', 'age']], expected: null },
          { args: ['{"__proto__":{"x":1},"name":"a","age":1}', ['name', 'age']], expected: null },
          { args: ['oops', ['name']], expected: null },
        ]),
      ],
      solution: `function parseJsonSafe(text) {\n  try { return JSON.parse(text); } catch (e) { return null; }\n}\nfunction hasDangerousKeys(obj) {\n  if (!obj || typeof obj !== "object") return false;\n  return ["__proto__", "constructor", "prototype"].some((k) => Object.prototype.hasOwnProperty.call(obj, k));\n}\nfunction acceptPayload(text, requiredKeys) {\n  const obj = parseJsonSafe(text);\n  if (!obj || typeof obj !== "object" || Array.isArray(obj) || hasDangerousKeys(obj)) return null;\n  return requiredKeys.every((k) => Object.prototype.hasOwnProperty.call(obj, k)) ? obj : null;\n}`,
      realityNote: 'Insecure deserialisation is avoided by parsing to plain data and validating it, never deserialising into types that can execute code; rejecting __proto__ keys also blocks prototype pollution.',
    });
  }),
  tmpl(7, 4, 'advanced', 'size-and-depth-limits', 'Bound the size and depth of parsed input', 'E1', 25, 'Reject oversized or deeply nested payloads to prevent resource-exhaustion attacks.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Limit what you will parse\n\nOn **${a.host}**, cap the size and nesting of accepted data to stop expansion and depth attacks. Write:\n\n1. \`withinSize(text, maxBytes)\`: return \`true\` if \`text.length <= maxBytes\`.\n2. \`depth(value)\`: return the maximum nesting depth of a parsed JSON value — a scalar is depth 0; an array or object is 1 + the max depth of its elements/values (empty array/object is depth 1).\n3. \`acceptBounded(value, maxDepth)\`: return \`true\` only when \`depth(value) <= maxDepth\`.`,
      hints: ['Recurse over arrays and object values; scalars are depth 0.', 'An empty array or object still counts as depth 1.'],
      starter: `// ${a.app}: size and depth limits\nfunction withinSize(text, maxBytes) {\n}\n\nfunction depth(value) {\n}\n\nfunction acceptBounded(value, maxDepth) {\n}\n`,
      checks: [
        fn('withinSize caps the length', 'withinSize', [
          { args: ['abc', 5], expected: true }, { args: ['abcdef', 5], expected: false },
        ]),
        fn('depth measures nesting', 'depth', [
          { args: [5], expected: 0 }, { args: [[1, 2]], expected: 1 }, { args: [{ a: { b: 1 } }], expected: 2 }, { args: [[[[]]]], expected: 3 }, { args: [{}], expected: 1 },
        ]),
        fn('acceptBounded enforces the depth', 'acceptBounded', [
          { args: [{ a: { b: 1 } }, 2], expected: true }, { args: [{ a: { b: { c: 1 } } }, 2], expected: false },
        ]),
      ],
      solution: `function withinSize(text, maxBytes) {\n  return text.length <= maxBytes;\n}\nfunction depth(value) {\n  if (Array.isArray(value)) return 1 + (value.length ? Math.max(...value.map(depth)) : 0);\n  if (value && typeof value === "object") {\n    const vals = Object.values(value);\n    return 1 + (vals.length ? Math.max(...vals.map(depth)) : 0);\n  }\n  return 0;\n}\nfunction acceptBounded(value, maxDepth) {\n  return depth(value) <= maxDepth;\n}`,
      realityNote: 'Caps on payload size and nesting depth prevent decompression bombs, deeply nested JSON and entity expansion from exhausting memory or CPU.',
    });
  }),

  /* ------------------------------------------------------------------ 7.5 defences: safe storage and rendering */
  tmpl(7, 5, 'beginner', 'serve-uploads-safely', 'Serve user files without letting them run or script', 'E10', 20, 'Choose how to store and serve user uploads so they cannot execute or run script.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Where and how uploads are served\n\n**${a.org}** lets users upload documents and images on **${a.host}**. Decide how to store and serve them safely.`,
      steps: [
        { title: 'Where to store', text: 'Where should uploaded files live?', choices: [
          { text: 'Outside the web root (or in object storage), served through a handler — never in an executable directory', right: true, feedback: 'Correct. Files the server will not execute, served deliberately.' },
          { text: 'In the application\'s script directory for convenience', feedback: 'That risks the server executing an uploaded script.' },
          { text: 'Anywhere; storage location does not matter', feedback: 'Location decides whether an upload can be executed or browsed.' },
        ] },
        { title: 'Serving type', text: 'What Content-Type and headers do you send?', choices: [
          { text: 'The correct type with X-Content-Type-Options: nosniff, and Content-Disposition: attachment for risky types', right: true, feedback: 'Correct. nosniff stops MIME guessing; attachment forces download.' },
          { text: 'Let the browser sniff the type', feedback: 'Sniffing can turn a text file into executable HTML.' },
          { text: 'Always text/html', feedback: 'That would render uploaded markup as a page — stored XSS.' },
        ] },
        { title: 'A different domain', text: 'Why serve user content from a separate domain or sandbox?', choices: [
          { text: 'So any script in a file runs in a different origin and cannot touch the main app\'s cookies or DOM', right: true, feedback: 'Correct. A separate origin contains the damage.' },
          { text: 'To save bandwidth', feedback: 'The reason is origin isolation, not bandwidth.' },
          { text: 'There is no benefit', feedback: 'Origin isolation is a real, common defence for user content.' },
        ] },
        { title: 'Images', text: 'How do you reduce risk from image uploads specifically?', choices: [
          { text: 'Re-encode them server-side to a known-good format, stripping metadata and any embedded payload', right: true, feedback: 'Correct. Re-encoding removes hidden scripts and polyglots.' },
          { text: 'Trust the image because browsers render images', feedback: 'Polyglot files can be both a valid image and a script.' },
          { text: 'Only check the extension', feedback: 'Extension checks miss embedded or polyglot content.' },
        ] },
      ],
      ending: { title: 'Store inert, serve deliberately, isolate', text: 'Keep uploads out of executable paths, serve them with the right type plus nosniff and attachment, isolate user content on a separate origin, and re-encode images to strip hidden payloads.' },
      hints: ['The three levers: where it is stored, how it is served, and which origin serves it.', 'Re-encoding images removes embedded scripts and metadata.'],
      realityNote: 'Serving user content from a separate origin with nosniff and forced download, and re-encoding images, are standard defences used by large platforms against upload-based XSS and code execution.',
    });
  }),
  tmpl(7, 5, 'intermediate', 'disposition-header', 'Decide download vs inline safely', 'E1', 20, 'Force risky content types to download rather than render inline.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Inline only what is safe\n\nOn **${a.host}**, decide the \`Content-Disposition\` for a served file. Write \`disposition(mime, inlineSafe)\` where \`inlineSafe\` is an array of MIME types safe to render inline (e.g. images):\n\n- if \`mime\` is in \`inlineSafe\` → \`"inline"\`;\n- otherwise → \`"attachment"\` (force download).\n\nAlso \`responseHeaders(mime, inlineSafe)\`: return \`{ "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Disposition": disposition(mime, inlineSafe) }\`.`,
      hints: ['Default to attachment for anything not explicitly inline-safe.', 'Always include nosniff.'],
      starter: `// ${a.app}: content disposition\nfunction disposition(mime, inlineSafe) {\n}\n\nfunction responseHeaders(mime, inlineSafe) {\n}\n`,
      checks: [
        fn('disposition forces download for risky types', 'disposition', [
          { args: ['image/png', ['image/png', 'image/jpeg']], expected: 'inline' },
          { args: ['text/html', ['image/png']], expected: 'attachment' },
          { args: ['application/pdf', ['image/png']], expected: 'attachment' },
        ]),
        fn('responseHeaders include nosniff and disposition', 'responseHeaders', [
          { args: ['image/png', ['image/png']], expected: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } },
          { args: ['text/html', ['image/png']], expected: { 'Content-Type': 'text/html', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment' } },
        ]),
      ],
      solution: `function disposition(mime, inlineSafe) {\n  return inlineSafe.includes(mime) ? "inline" : "attachment";\n}\nfunction responseHeaders(mime, inlineSafe) {\n  return { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Content-Disposition": disposition(mime, inlineSafe) };\n}`,
      realityNote: 'Forcing non-image types to download (attachment) with nosniff prevents a served file from being rendered as HTML and running script in your origin.',
    });
  }),
  tmpl(7, 5, 'advanced', 'egress-and-upload-policy', 'Combine upload and egress controls', 'E1', 25, 'Evaluate a file operation against both content and destination policy.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## One policy for the whole operation\n\nOn **${a.host}**, a feature downloads a remote file and stores it. Both the source and the content must be allowed. Write \`operationAllowed(op, policy)\` where \`op = { host, scheme, ext, sizeBytes }\` and \`policy = { allowedHosts, allowedExts, maxBytes }\`:\n\n- deny \`"bad-scheme"\` if \`op.scheme !== "https"\`;\n- deny \`"host"\` if \`op.host\` is not in \`policy.allowedHosts\`;\n- deny \`"type"\` if \`op.ext\` (lower-cased) is not in \`policy.allowedExts\`;\n- deny \`"size"\` if \`op.sizeBytes > policy.maxBytes\` or \`<= 0\`;\n- otherwise \`{ allow: true }\`. Denials: \`{ allow: false, reason }\`. Check in that order.`,
      hints: ['Evaluate scheme, host, type, size in order.', 'Lower-case the extension before the allow-list check.'],
      starter: `// ${a.app}: combined file policy\nfunction operationAllowed(op, policy) {\n}\n`,
      checks: [
        fn('operationAllowed applies both controls', 'operationAllowed', [
          { args: [{ host: 'cdn.test', scheme: 'https', ext: 'PNG', sizeBytes: 1000 }, { allowedHosts: ['cdn.test'], allowedExts: ['png'], maxBytes: 5000 }], expected: { allow: true } },
          { args: [{ host: 'cdn.test', scheme: 'http', ext: 'png', sizeBytes: 1000 }, { allowedHosts: ['cdn.test'], allowedExts: ['png'], maxBytes: 5000 }], expected: { allow: false, reason: 'bad-scheme' } },
          { args: [{ host: 'evil.test', scheme: 'https', ext: 'png', sizeBytes: 1000 }, { allowedHosts: ['cdn.test'], allowedExts: ['png'], maxBytes: 5000 }], expected: { allow: false, reason: 'host' } },
          { args: [{ host: 'cdn.test', scheme: 'https', ext: 'php', sizeBytes: 1000 }, { allowedHosts: ['cdn.test'], allowedExts: ['png'], maxBytes: 5000 }], expected: { allow: false, reason: 'type' } },
          { args: [{ host: 'cdn.test', scheme: 'https', ext: 'png', sizeBytes: 99999 }, { allowedHosts: ['cdn.test'], allowedExts: ['png'], maxBytes: 5000 }], expected: { allow: false, reason: 'size' } },
        ]),
      ],
      solution: `function operationAllowed(op, policy) {\n  if (op.scheme !== "https") return { allow: false, reason: "bad-scheme" };\n  if (!policy.allowedHosts.includes(op.host)) return { allow: false, reason: "host" };\n  if (!policy.allowedExts.includes(String(op.ext).toLowerCase())) return { allow: false, reason: "type" };\n  if (op.sizeBytes <= 0 || op.sizeBytes > policy.maxBytes) return { allow: false, reason: "size" };\n  return { allow: true };\n}`,
      realityNote: 'Real systems evaluate a file operation against a single policy covering source (egress allow-list, scheme) and content (type, size), so no single missed check exposes the system.',
    });
  }),
];
