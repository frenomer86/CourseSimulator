/** Unit 6: access control — the highest-impact class, enforced server-side. Learners build
 * ownership checks, role/function-level authorisation, deny-by-default, and tenant isolation. */

import type { TaskTemplate } from '../types.js';
import { appOf, caseStudy, fn, js, tmpl } from './kit.js';

export const U6: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 6.1 vertical and horizontal escalation */
  tmpl(6, 1, 'beginner', 'escalation-kinds', 'Tell vertical from horizontal escalation', 'E10', 15, 'Classify privilege-escalation findings and choose where authorisation must be enforced.', (v) => {
    const a = appOf(v);
    return caseStudy(v, {
      intro: `## Two ways to reach what you should not\n\n**${a.org}** has two access-control findings on **${a.host}**. Classify each and decide the fix.`,
      steps: [
        { title: 'Reading a peer\'s record', text: 'A user changes an id and reads another user\'s record at the same privilege level. Which kind?', choices: [
          { text: 'Horizontal escalation — enforce that the record belongs to the current user on the server', right: true, feedback: 'Correct. Same level, another user\'s data: an ownership check fixes it.' },
          { text: 'Vertical escalation', feedback: 'No higher privilege is gained; it is a peer\'s data.' },
          { text: 'Not an access-control issue', feedback: 'Reading another user\'s data is broken access control.' },
        ] },
        { title: 'Reaching an admin action', text: 'A normal user calls an admin-only endpoint and it works. Which kind?', choices: [
          { text: 'Vertical escalation — enforce the required role on the server for that endpoint', right: true, feedback: 'Correct. Gaining higher privilege; the endpoint must check the role.' },
          { text: 'Horizontal escalation', feedback: 'It gains higher privilege, so it is vertical.' },
          { text: 'A UI bug only', feedback: 'Hiding the button is not a control; the server must enforce the role.' },
        ] },
        { title: 'Where to enforce', text: 'Where must both checks live?', choices: [
          { text: 'On the server, on every request, from the authenticated identity — never from client-supplied role or id', right: true, feedback: 'Correct. Server-side enforcement from the session is the only reliable place.' },
          { text: 'In the front-end, by hiding controls', feedback: 'Hidden controls are still reachable by crafting the request.' },
          { text: 'In a code comment reminding developers', feedback: 'Enforcement must be code that runs, not a reminder.' },
        ] },
        { title: 'Default stance', text: 'For a new endpoint, what is the safe default?', choices: [
          { text: 'Deny by default; grant access only when an explicit rule allows it', right: true, feedback: 'Correct. Deny-by-default means a forgotten check fails safe.' },
          { text: 'Allow by default; add restrictions later', feedback: 'Allow-by-default means a forgotten check exposes data.' },
          { text: 'Depends on the developer\'s preference', feedback: 'The policy should be deny-by-default everywhere.' },
        ] },
      ],
      ending: { title: 'Enforce on the server, deny by default', text: 'Horizontal escalation needs an ownership check; vertical escalation needs a role check; both are enforced server-side on every request from the authenticated identity, with deny-by-default.' },
      hints: ['Horizontal = another user\'s data; vertical = higher privilege.', 'All authorisation is server-side and deny-by-default.'],
      realityNote: 'Broken access control is the top category in the OWASP Top Ten; most cases are a missing server-side ownership or role check.',
    });
  }),
  tmpl(6, 1, 'intermediate', 'role-permission', 'Enforce a role-to-permission mapping', 'E1', 20, 'Grant an action only when the user\'s role includes the required permission.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Roles map to permissions\n\nOn **${a.host}**, each role has a set of permissions. Write:\n\n1. \`can(role, permission, rolePerms)\`: \`rolePerms\` maps role→array of permissions. Return \`true\` only when \`rolePerms[role]\` exists and includes \`permission\`. An unknown role has no permissions.\n2. \`authorize(user, permission, rolePerms)\`: \`user = { role }\`. Return \`{ ok: true }\` if \`can(...)\`, else \`{ ok: false, status: 403 }\`.`,
      hints: ['Guard that rolePerms[role] exists before calling includes.', 'Deny maps to 403 Forbidden.'],
      starter: `// ${a.app}: role-based permission\nfunction can(role, permission, rolePerms) {\n}\n\nfunction authorize(user, permission, rolePerms) {\n}\n`,
      checks: [
        fn('can checks the mapping', 'can', [
          { args: ['editor', 'post.edit', { editor: ['post.edit', 'post.read'], viewer: ['post.read'] }], expected: true },
          { args: ['viewer', 'post.edit', { editor: ['post.edit'], viewer: ['post.read'] }], expected: false },
          { args: ['ghost', 'post.read', { viewer: ['post.read'] }], expected: false },
        ]),
        fn('authorize returns 403 on denial', 'authorize', [
          { args: [{ role: 'editor' }, 'post.edit', { editor: ['post.edit'] }], expected: { ok: true } },
          { args: [{ role: 'viewer' }, 'post.edit', { editor: ['post.edit'], viewer: [] }], expected: { ok: false, status: 403 } },
        ]),
      ],
      solution: `function can(role, permission, rolePerms) {\n  const perms = rolePerms[role];\n  return Array.isArray(perms) && perms.includes(permission);\n}\nfunction authorize(user, permission, rolePerms) {\n  return can(user.role, permission, rolePerms) ? { ok: true } : { ok: false, status: 403 };\n}`,
      realityNote: 'Role-based access control maps roles to permissions and checks the permission the action needs; the check must run on the server for every request.',
    });
  }),
  tmpl(6, 1, 'advanced', 'prevent-privilege-grant', 'Stop users granting themselves privileges', 'E1', 25, 'Validate a role change so a user cannot escalate beyond what an admin may assign.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## No self-escalation\n\nOn **${a.host}**, only an admin may change roles, and no one may grant a role above their own. Roles rank \`viewer < editor < manager < admin\`. Write \`roleRank(role)\` returning the rank (0–3) or \`-1\` for unknown, and \`canAssign(actor, targetUser, newRole)\`:\n\n- the actor must be an \`admin\` (\`actor.role === "admin"\`), else return \`false\`;\n- \`newRole\` must be a known role no higher than the actor\'s own rank, else \`false\`;\n- an actor may not change **their own** role (\`actor.id === targetUser.id\` → \`false\`);\n- otherwise \`true\`.`,
      hints: ['Rank the roles and compare.', 'Block self-role-change and any role above the actor.'],
      starter: `// ${a.app}: prevent self-escalation\nfunction roleRank(role) {\n}\n\nfunction canAssign(actor, targetUser, newRole) {\n}\n`,
      checks: [
        fn('roleRank ranks roles', 'roleRank', [
          { args: ['viewer'], expected: 0 }, { args: ['admin'], expected: 3 }, { args: ['ghost'], expected: -1 },
        ]),
        fn('canAssign blocks escalation and self-change', 'canAssign', [
          { args: [{ id: 1, role: 'admin' }, { id: 2, role: 'viewer' }, 'manager'], expected: true },
          { args: [{ id: 1, role: 'manager' }, { id: 2, role: 'viewer' }, 'editor'], expected: false },
          { args: [{ id: 1, role: 'admin' }, { id: 1, role: 'admin' }, 'admin'], expected: false },
          { args: [{ id: 1, role: 'admin' }, { id: 2, role: 'viewer' }, 'overlord'], expected: false },
        ]),
      ],
      solution: `function roleRank(role) {\n  return ["viewer", "editor", "manager", "admin"].indexOf(role);\n}\nfunction canAssign(actor, targetUser, newRole) {\n  if (actor.role !== "admin") return false;\n  const r = roleRank(newRole);\n  if (r < 0 || r > roleRank(actor.role)) return false;\n  if (actor.id === targetUser.id) return false;\n  return true;\n}`,
      realityNote: 'Role-assignment endpoints are a common escalation path; validating that no one grants a role above their own, and cannot change their own role, closes it.',
    });
  }),

  /* ------------------------------------------------------------------ 6.2 IDOR and function-level authz */
  tmpl(6, 2, 'beginner', 'ownership-check', 'Check ownership before returning a record', 'E1', 20, 'Return a record only when it belongs to the requesting user.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The record must be yours\n\nOn **${a.host}**, changing an id in the URL must not reveal another user\'s record. Write \`getOwnRecord(userId, recordId, records)\` where \`records\` maps recordId→\`{ ownerId, data }\`:\n\n- if the record does not exist → \`{ status: 404 }\`;\n- if it exists but \`ownerId !== userId\` → \`{ status: 403 }\` (do not reveal the data, and use 403/404 consistently so existence does not leak);\n- if it exists and is owned → \`{ status: 200, data }\`.`,
      hints: ['Look up the record, then compare ownerId to userId.', 'Never return data for a record the user does not own.'],
      starter: `// ${a.app}: ownership check\nfunction getOwnRecord(userId, recordId, records) {\n}\n`,
      checks: [
        fn('getOwnRecord enforces ownership', 'getOwnRecord', [
          { args: [1, 'r1', { r1: { ownerId: 1, data: 'mine' } }], expected: { status: 200, data: 'mine' } },
          { args: [2, 'r1', { r1: { ownerId: 1, data: 'mine' } }], expected: { status: 403 } },
          { args: [1, 'r9', { r1: { ownerId: 1, data: 'mine' } }], expected: { status: 404 } },
        ]),
      ],
      solution: `function getOwnRecord(userId, recordId, records) {\n  const rec = records[recordId];\n  if (!rec) return { status: 404 };\n  if (rec.ownerId !== userId) return { status: 403 };\n  return { status: 200, data: rec.data };\n}`,
      realityNote: 'Insecure direct object references (IDOR) are fixed by checking, server-side, that the authenticated user owns or may access the referenced object — never by hiding the id.',
    });
  }),
  tmpl(6, 2, 'intermediate', 'function-level-guard', 'Guard every function, not just the UI', 'E1', 20, 'Require the right permission on the endpoint even when the UI already hides the button.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## The server guards the function\n\nOn **${a.host}**, hiding an admin button in the UI does not stop a crafted request. Each endpoint declares the permission it needs; enforce it. Write \`dispatch(request, routePerms, userPerms)\`:\n\n- \`request = { route }\`; \`routePerms\` maps route→required permission (or \`undefined\` for public routes); \`userPerms\` is the user\'s array of permissions;\n- if the route is unknown → \`{ status: 404 }\`;\n- if the route is public (required permission \`undefined\`/not set but the route key exists with value \`null\`) → \`{ status: 200 }\`;\n- if a permission is required and \`userPerms\` includes it → \`{ status: 200 }\`; otherwise → \`{ status: 403 }\`.\n\n(Model routes: a key present with \`null\` is public; present with a string needs that permission; absent is unknown.)`,
      hints: ['Use Object.prototype.hasOwnProperty to tell unknown from public.', 'Public = key present with null; required = string permission.'],
      starter: `// ${a.app}: function-level authorisation\nfunction dispatch(request, routePerms, userPerms) {\n}\n`,
      checks: [
        fn('dispatch enforces per-route permissions', 'dispatch', [
          { args: [{ route: '/admin/users' }, { '/admin/users': 'users.manage', '/home': null }, ['users.manage']], expected: { status: 200 } },
          { args: [{ route: '/admin/users' }, { '/admin/users': 'users.manage', '/home': null }, ['post.read']], expected: { status: 403 } },
          { args: [{ route: '/home' }, { '/admin/users': 'users.manage', '/home': null }, []], expected: { status: 200 } },
          { args: [{ route: '/nope' }, { '/home': null }, []], expected: { status: 404 } },
        ]),
      ],
      solution: `function dispatch(request, routePerms, userPerms) {\n  if (!Object.prototype.hasOwnProperty.call(routePerms, request.route)) return { status: 404 };\n  const required = routePerms[request.route];\n  if (required === null || required === undefined) return { status: 200 };\n  return userPerms.includes(required) ? { status: 200 } : { status: 403 };\n}`,
      realityNote: 'Broken function-level authorisation happens when an endpoint relies on the UI hiding it; every endpoint must check the permission itself.',
    });
  }),
  tmpl(6, 2, 'advanced', 'unpredictable-and-checked', 'Combine unpredictable ids with ownership checks', 'E1', 25, 'Use opaque references and still verify ownership — neither alone is enough.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Opaque is not the same as authorised\n\nOn **${a.host}**, some argue that a random id is enough to protect a record. It is not: the control is the ownership check; the opaque id only reduces guessing. Model both.\n\n1. \`looksEnumerable(id)\`: return \`true\` if \`id\` is a short all-digit string (\`/^[0-9]{1,6}$/\`) — a sequential-looking id that is easy to guess.\n2. \`accessDecision(userId, ref, store)\`: \`store\` maps ref→\`{ ownerId }\`. Return \`"not-found"\` if missing, \`"forbidden"\` if \`ownerId !== userId\`, else \`"allow"\`. The decision never depends on whether the id looks enumerable — ownership is what matters.`,
      hints: ['looksEnumerable is a format check only.', 'accessDecision depends solely on existence and ownership.'],
      starter: `// ${a.app}: opaque ids plus ownership\nfunction looksEnumerable(id) {\n}\n\nfunction accessDecision(userId, ref, store) {\n}\n`,
      checks: [
        fn('looksEnumerable spots guessable ids', 'looksEnumerable', [
          { args: ['42'], expected: true }, { args: ['a1b2c3d4e5'], expected: false }, { args: ['1234567'], expected: false },
        ]),
        fn('accessDecision relies on ownership', 'accessDecision', [
          { args: [1, 'x', { x: { ownerId: 1 } }], expected: 'allow' },
          { args: [2, 'x', { x: { ownerId: 1 } }], expected: 'forbidden' },
          { args: [1, 'y', { x: { ownerId: 1 } }], expected: 'not-found' },
        ]),
      ],
      solution: `function looksEnumerable(id) {\n  return /^[0-9]{1,6}$/.test(id);\n}\nfunction accessDecision(userId, ref, store) {\n  const rec = store[ref];\n  if (!rec) return "not-found";\n  if (rec.ownerId !== userId) return "forbidden";\n  return "allow";\n}`,
      realityNote: 'Unguessable identifiers (UUIDs) reduce enumeration but are not access control; the ownership check is the control, and it must run regardless of how the id looks.',
    });
  }),

  /* ------------------------------------------------------------------ 6.3 enforce ownership (IDOR fixed) */
  tmpl(6, 3, 'beginner', 'wallet-ownership', 'Return a wallet only to its owner', 'E1', 20, 'Harden a wallet endpoint so changing the id cannot read another user\'s balance.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Your wallet, not anyone\'s\n\nOn **${a.host}**, a wallet endpoint took the wallet id straight from the URL — an IDOR. Fix it so only the owner can read a wallet. Write \`readWallet(session, walletId, wallets)\` where \`session = { userId }\` and \`wallets\` maps walletId→\`{ ownerId, balance }\`:\n\n- missing wallet → \`{ status: 404 }\`;\n- wallet not owned by \`session.userId\` → \`{ status: 403 }\`;\n- owned → \`{ status: 200, balance }\`.`,
      hints: ['Take the identity from the session, not the request body.', 'Compare ownerId to session.userId before returning the balance.'],
      starter: `// ${a.app}: wallet ownership\nfunction readWallet(session, walletId, wallets) {\n}\n`,
      checks: [
        fn('readWallet enforces ownership', 'readWallet', [
          { args: [{ userId: 7 }, 'w1', { w1: { ownerId: 7, balance: 500 } }], expected: { status: 200, balance: 500 } },
          { args: [{ userId: 8 }, 'w1', { w1: { ownerId: 7, balance: 500 } }], expected: { status: 403 } },
          { args: [{ userId: 7 }, 'w9', { w1: { ownerId: 7, balance: 500 } }], expected: { status: 404 } },
        ]),
      ],
      solution: `function readWallet(session, walletId, wallets) {\n  const w = wallets[walletId];\n  if (!w) return { status: 404 };\n  if (w.ownerId !== session.userId) return { status: 403 };\n  return { status: 200, balance: w.balance };\n}`,
      realityNote: 'Reading another user\'s wallet or records by changing an id is a textbook IDOR; the fix is an ownership check against the session identity, done server-side.',
    });
  }),
  tmpl(6, 3, 'intermediate', 'scope-list-to-user', 'List only the current user\'s items', 'E1', 20, 'Filter a collection to the owner server-side instead of trusting a client filter.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Filter on the server, by identity\n\nOn **${a.host}**, a list endpoint must return only the caller\'s items — never rely on the client to filter. Write \`listOwn(session, items)\` where \`session = { userId }\` and \`items\` is an array of \`{ id, ownerId }\`. Return the array of \`id\`s owned by \`session.userId\`, in their original order.\n\nAlso \`countOwn(session, items)\`: return how many items the user owns.`,
      hints: ['Filter by ownerId === session.userId, then map to id.', 'countOwn is the length of the filtered list.'],
      starter: `// ${a.app}: scope list to the user\nfunction listOwn(session, items) {\n}\n\nfunction countOwn(session, items) {\n}\n`,
      checks: [
        fn('listOwn returns only owned ids', 'listOwn', [
          { args: [{ userId: 1 }, [{ id: 'a', ownerId: 1 }, { id: 'b', ownerId: 2 }, { id: 'c', ownerId: 1 }]], expected: ['a', 'c'] },
          { args: [{ userId: 9 }, [{ id: 'a', ownerId: 1 }]], expected: [] },
        ]),
        fn('countOwn counts owned items', 'countOwn', [
          { args: [{ userId: 1 }, [{ id: 'a', ownerId: 1 }, { id: 'b', ownerId: 1 }]], expected: 2 },
        ]),
      ],
      solution: `function listOwn(session, items) {\n  return items.filter((i) => i.ownerId === session.userId).map((i) => i.id);\n}\nfunction countOwn(session, items) {\n  return items.filter((i) => i.ownerId === session.userId).length;\n}`,
      realityNote: 'A list endpoint that returns everything and expects the client to filter leaks every record; the server must scope the query to the authenticated user.',
    });
  }),
  tmpl(6, 3, 'advanced', 'object-action-matrix', 'Check both the object and the action', 'E1', 25, 'Authorise by the relationship to the object and the specific action requested.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Who, on what, may do which\n\nOn **${a.host}**, authorisation depends on the user\'s relationship to the object and the action. Write \`mayAct(session, object, action)\` where \`session = { userId, role }\`, \`object = { ownerId }\`:\n\n- an \`admin\` may do any action → \`true\`;\n- the owner (\`object.ownerId === session.userId\`) may \`"read"\`, \`"update"\` or \`"delete"\` → \`true\`;\n- a non-owner may only \`"read"\` **and only if** the object is \`shared\` (\`object.shared === true\`) → \`true\` for \`"read"\`;\n- otherwise \`false\`.`,
      hints: ['Admin short-circuits to true.', 'Owner gets read/update/delete; others get read only when shared.'],
      starter: `// ${a.app}: object + action authorisation\nfunction mayAct(session, object, action) {\n}\n`,
      checks: [
        fn('mayAct checks relationship and action', 'mayAct', [
          { args: [{ userId: 1, role: 'admin' }, { ownerId: 2 }, 'delete'], expected: true },
          { args: [{ userId: 2, role: 'user' }, { ownerId: 2 }, 'update'], expected: true },
          { args: [{ userId: 3, role: 'user' }, { ownerId: 2, shared: true }, 'read'], expected: true },
          { args: [{ userId: 3, role: 'user' }, { ownerId: 2, shared: true }, 'update'], expected: false },
          { args: [{ userId: 3, role: 'user' }, { ownerId: 2, shared: false }, 'read'], expected: false },
        ]),
      ],
      solution: `function mayAct(session, object, action) {\n  if (session.role === "admin") return true;\n  if (object.ownerId === session.userId) return ["read", "update", "delete"].includes(action);\n  if (action === "read" && object.shared === true) return true;\n  return false;\n}`,
      realityNote: 'Real authorisation checks the triple (subject, object, action); relationship-based access control (ownership, sharing) plus roles covers most application needs.',
    });
  }),

  /* ------------------------------------------------------------------ 6.4 deny-by-default */
  tmpl(6, 4, 'beginner', 'deny-by-default', 'Default to deny on an unknown route', 'E1', 20, 'Make the authorisation decision deny unless a rule explicitly allows.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Fail closed\n\nOn **${a.host}**, a forgotten rule must mean "no access", not "open". Write \`decide(route, rules, userRoles)\` where \`rules\` is an array of \`{ route, allow }\` (\`allow\` is an array of roles) and \`userRoles\` is the user\'s roles:\n\n- find the rule whose \`route\` matches exactly;\n- if there is no rule → \`"deny"\` (deny by default);\n- if a rule exists and any of \`userRoles\` is in its \`allow\` → \`"allow"\`; otherwise \`"deny"\`.`,
      hints: ['No matching rule means deny.', 'Allow only when a role intersects the rule\'s allow list.'],
      starter: `// ${a.app}: deny by default\nfunction decide(route, rules, userRoles) {\n}\n`,
      checks: [
        fn('decide denies unless allowed', 'decide', [
          { args: ['/admin', [{ route: '/admin', allow: ['admin'] }], ['admin']], expected: 'allow' },
          { args: ['/admin', [{ route: '/admin', allow: ['admin'] }], ['user']], expected: 'deny' },
          { args: ['/secret', [{ route: '/admin', allow: ['admin'] }], ['admin']], expected: 'deny' },
        ]),
      ],
      solution: `function decide(route, rules, userRoles) {\n  const rule = rules.find((r) => r.route === route);\n  if (!rule) return "deny";\n  return userRoles.some((role) => rule.allow.includes(role)) ? "allow" : "deny";\n}`,
      realityNote: 'Deny-by-default (fail closed) means a route someone forgot to configure is inaccessible rather than wide open — the safe direction to fail.',
    });
  }),
  tmpl(6, 4, 'intermediate', 'central-authz', 'Authorise in one central place', 'E1', 25, 'Route every request through one policy function so no endpoint can forget the check.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## One gate for everything\n\nScattered checks get forgotten. On **${a.host}**, route every request through one policy. Write \`enforce(request, policy)\` where \`request = { subject, resource, action }\` and \`policy\` is an array of rules \`{ resource, action, roles }\`:\n\n- a rule matches when \`resource\` equals (or is \`"*"\`) and \`action\` equals (or is \`"*"\`);\n- the request is allowed if **any** matching rule has a role in \`request.subject.roles\`;\n- return \`{ allow: true }\` or \`{ allow: false, status: 403 }\`. With no matching rule, deny.`,
      hints: ['Support "*" wildcards for resource and action.', 'Allow if any matching rule grants a role the subject has.'],
      starter: `// ${a.app}: central authorisation\nfunction enforce(request, policy) {\n}\n`,
      checks: [
        fn('enforce applies the central policy', 'enforce', [
          { args: [{ subject: { roles: ['editor'] }, resource: 'post', action: 'edit' }, [{ resource: 'post', action: 'edit', roles: ['editor'] }]], expected: { allow: true } },
          { args: [{ subject: { roles: ['viewer'] }, resource: 'post', action: 'edit' }, [{ resource: 'post', action: 'edit', roles: ['editor'] }]], expected: { allow: false, status: 403 } },
          { args: [{ subject: { roles: ['admin'] }, resource: 'anything', action: 'delete' }, [{ resource: '*', action: '*', roles: ['admin'] }]], expected: { allow: true } },
          { args: [{ subject: { roles: ['user'] }, resource: 'x', action: 'y' }, []], expected: { allow: false, status: 403 } },
        ]),
      ],
      solution: `function enforce(request, policy) {\n  const allowed = policy.some((rule) =>\n    (rule.resource === request.resource || rule.resource === "*") &&\n    (rule.action === request.action || rule.action === "*") &&\n    rule.roles.some((role) => request.subject.roles.includes(role)),\n  );\n  return allowed ? { allow: true } : { allow: false, status: 403 };\n}`,
      realityNote: 'Centralised authorisation (a policy engine or middleware every request passes through) prevents the "one endpoint forgot the check" bug that scatters access-control holes.',
    });
  }),
  tmpl(6, 4, 'advanced', 'fail-closed-on-error', 'Fail closed when the check itself errors', 'E1', 25, 'Treat an error or missing result in the authorisation path as a denial, not an allow.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## An error means deny\n\nOn **${a.host}**, if the authorisation lookup fails or returns nothing, the request must be denied — never allowed by accident. The lookup\'s outcome is given to you as \`lookupOutcome\`, which is either \`true\`, \`false\`, the string \`"error"\` (the lookup threw or the service was down), or \`undefined\` (no answer). Write \`safeAuthorize(lookupOutcome)\`:\n\n- \`"error"\` → \`{ allow: false, status: 403, reason: "error" }\`;\n- a non-boolean (e.g. \`undefined\`) → \`{ allow: false, status: 403, reason: "indeterminate" }\`;\n- \`true\` → \`{ allow: true }\`; \`false\` → \`{ allow: false, status: 403, reason: "denied" }\`.\n\nOnly an explicit \`true\` allows; everything else denies.`,
      hints: ['Check for the "error" sentinel first, then non-boolean, then the boolean.', 'Default to deny for anything that is not exactly true.'],
      starter: `// ${a.app}: fail closed on error\nfunction safeAuthorize(lookupOutcome) {\n}\n`,
      checks: [
        fn('safeAuthorize fails closed', 'safeAuthorize', [
          { args: [true], expected: { allow: true } },
          { args: [false], expected: { allow: false, status: 403, reason: 'denied' } },
          { args: ['error'], expected: { allow: false, status: 403, reason: 'error' } },
          { args: [undefined], expected: { allow: false, status: 403, reason: 'indeterminate' } },
        ]),
      ],
      solution: `function safeAuthorize(lookupOutcome) {\n  if (lookupOutcome === "error") return { allow: false, status: 403, reason: "error" };\n  if (typeof lookupOutcome !== "boolean") return { allow: false, status: 403, reason: "indeterminate" };\n  return lookupOutcome ? { allow: true } : { allow: false, status: 403, reason: "denied" };\n}`,
      realityNote: 'If an authorisation service is down, failing open grants everyone access; security-critical checks must fail closed so an error denies rather than allows.',
    });
  }),

  /* ------------------------------------------------------------------ 6.5 multi-tenant isolation and testing */
  tmpl(6, 5, 'beginner', 'tenant-isolation', 'Keep tenants from seeing each other', 'E1', 20, 'Check that a resource belongs to the caller\'s tenant before returning it.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## One tenant cannot see another\n\n**${a.host}** serves many organisations. A request carries the caller\'s tenant from the session; every resource has a tenant. Write \`fetchForTenant(session, resource)\` where \`session = { tenantId }\` and \`resource = { tenantId, data }\` (or \`null\` if not found):\n\n- \`null\` resource → \`{ status: 404 }\`;\n- resource tenant \`!==\` session tenant → \`{ status: 404 }\` (hide existence across tenants);\n- same tenant → \`{ status: 200, data }\`.`,
      hints: ['Take the tenant from the session, never the request body.', 'Use 404 across tenants so existence does not leak.'],
      starter: `// ${a.app}: tenant isolation\nfunction fetchForTenant(session, resource) {\n}\n`,
      checks: [
        fn('fetchForTenant isolates tenants', 'fetchForTenant', [
          { args: [{ tenantId: 'A' }, { tenantId: 'A', data: 'x' }], expected: { status: 200, data: 'x' } },
          { args: [{ tenantId: 'B' }, { tenantId: 'A', data: 'x' }], expected: { status: 404 } },
          { args: [{ tenantId: 'A' }, null], expected: { status: 404 } },
        ]),
      ],
      solution: `function fetchForTenant(session, resource) {\n  if (!resource) return { status: 404 };\n  if (resource.tenantId !== session.tenantId) return { status: 404 };\n  return { status: 200, data: resource.data };\n}`,
      realityNote: 'Cross-tenant data leaks are among the most serious SaaS bugs; every query and object access must be scoped to the caller\'s tenant from the session.',
    });
  }),
  tmpl(6, 5, 'intermediate', 'test-access-matrix', 'Test access systematically with a matrix', 'E1', 25, 'Generate the expected allow/deny matrix so access control can be tested exhaustively.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Test every role against every action\n\nTo test **${a.host}** systematically, build the full expectation matrix. Write \`expectationMatrix(roles, actions, policy)\` where \`policy(role, action)\` returns a boolean. Return an array of \`{ role, action, allowed }\` for **every** role×action pair, roles outer and actions inner (stable order).\n\nAlso \`findViolations(matrix, observed)\`: \`observed\` is an array of \`{ role, action, allowed }\`. Return the entries from \`observed\` whose \`allowed\` differs from the matching entry in \`matrix\` (match by role+action).`,
      hints: ['Nested loop: roles outer, actions inner.', 'For violations, index the expected matrix by role+"|"+action.'],
      starter: `// ${a.app}: access-control test matrix\nfunction expectationMatrix(roles, actions, policy) {\n}\n\nfunction findViolations(matrix, observed) {\n}\n`,
      checks: [
        fn('expectationMatrix covers every pair', 'expectationMatrix', [
          { args: [['admin', 'user'], ['read', 'delete'], true], expected: [{ role: 'admin', action: 'read', allowed: true }, { role: 'admin', action: 'delete', allowed: true }, { role: 'user', action: 'read', allowed: true }, { role: 'user', action: 'delete', allowed: true }] },
        ]),
        fn('findViolations finds mismatches', 'findViolations', [
          { args: [[{ role: 'user', action: 'delete', allowed: false }], [{ role: 'user', action: 'delete', allowed: true }]], expected: [{ role: 'user', action: 'delete', allowed: true }] },
          { args: [[{ role: 'user', action: 'read', allowed: true }], [{ role: 'user', action: 'read', allowed: true }]], expected: [] },
        ]),
      ],
      solution: `function expectationMatrix(roles, actions, policy) {\n  const out = [];\n  for (const role of roles) for (const action of actions) out.push({ role, action, allowed: typeof policy === "function" ? policy(role, action) : policy });\n  return out;\n}\nfunction findViolations(matrix, observed) {\n  const expected = {};\n  for (const m of matrix) expected[m.role + "|" + m.action] = m.allowed;\n  return observed.filter((o) => expected[o.role + "|" + o.action] !== o.allowed);\n}`,
      realityNote: 'Access control is best tested with a full role×action matrix so every combination is checked; ad-hoc testing misses exactly the cell that is broken.',
    });
  }),
  tmpl(6, 5, 'advanced', 'horizontal-scope-check', 'Verify scoping across a whole request path', 'E1', 25, 'Ensure every object touched in a request belongs to the caller, not just the first.', (v) => {
    const a = appOf(v);
    return js({
      instructions: `## Every object in the request\n\nA request on **${a.host}** may touch several objects (an order and its line items). All must belong to the caller — checking only the first is a common bug. Write \`allOwned(session, objects)\` where \`session = { userId }\` and \`objects\` is an array of \`{ id, ownerId }\`:\n\n- return \`{ ok: true }\` only when **every** object\'s \`ownerId === session.userId\`;\n- otherwise return \`{ ok: false, status: 403, offending }\` where \`offending\` is the array of \`id\`s not owned by the caller (in order).`,
      hints: ['Collect every non-owned id, not just the first.', 'ok is true exactly when offending is empty.'],
      starter: `// ${a.app}: scope the whole request\nfunction allOwned(session, objects) {\n}\n`,
      checks: [
        fn('allOwned checks every object', 'allOwned', [
          { args: [{ userId: 1 }, [{ id: 'a', ownerId: 1 }, { id: 'b', ownerId: 1 }]], expected: { ok: true } },
          { args: [{ userId: 1 }, [{ id: 'a', ownerId: 1 }, { id: 'b', ownerId: 2 }, { id: 'c', ownerId: 3 }]], expected: { ok: false, status: 403, offending: ['b', 'c'] } },
        ]),
      ],
      solution: `function allOwned(session, objects) {\n  const offending = objects.filter((o) => o.ownerId !== session.userId).map((o) => o.id);\n  return offending.length === 0 ? { ok: true } : { ok: false, status: 403, offending };\n}`,
      realityNote: 'Batch and nested operations often check ownership of the top object but not the children; every referenced object must be authorised, or one slips through.',
    });
  }),
];
