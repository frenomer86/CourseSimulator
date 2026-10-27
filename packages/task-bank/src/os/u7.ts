/** Unit 7: protection, security and virtual machines — protection domains and access control,
 * the OS defences that contain untrusted code, hypervisors and virtualisation, and containers. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U7: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 7.1 protection and access control */
  tmpl(7, 1, 'beginner', 'access-matrix', 'Check rights in an access matrix', 'E1', 25, 'Look up a subject\'s rights to an object and enforce them.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The access matrix\n\nOn **${m.host}**, protection is a matrix of \`subject × object → rights\`. Write:\n\n1. \`rights(matrix, subject, object)\`: \`matrix\` maps \`subject\` to an object→rights-array map. Return the rights array, or \`[]\` if none.\n2. \`allowed(matrix, subject, object, right)\`: return \`true\` if \`right\` is in that subject\'s rights for the object.\n3. \`objectsAccessibleBy(matrix, subject, right)\`: return the sorted array of objects for which \`subject\` has \`right\`.`,
      hints: ['Default to no rights when the cell is empty.', 'Deny by default: absence means no access.'],
      starter: `// ${m.host}: access matrix\nfunction rights(matrix, subject, object) {\n}\n\nfunction allowed(matrix, subject, object, right) {\n}\n\nfunction objectsAccessibleBy(matrix, subject, right) {\n}\n`,
      checks: [
        fn('rights returns the cell', 'rights', [
          { args: [{ alice: { file1: ['read', 'write'] } }, 'alice', 'file1'], expected: ['read', 'write'] },
          { args: [{ alice: {} }, 'alice', 'file2'], expected: [] },
          { args: [{}, 'bob', 'file1'], expected: [] },
        ]),
        fn('allowed checks a right', 'allowed', [
          { args: [{ alice: { file1: ['read'] } }, 'alice', 'file1', 'read'], expected: true },
          { args: [{ alice: { file1: ['read'] } }, 'alice', 'file1', 'write'], expected: false },
        ]),
        fn('objectsAccessibleBy lists objects', 'objectsAccessibleBy', [
          { args: [{ alice: { f1: ['read'], f2: ['write'], f3: ['read'] } }, 'alice', 'read'], expected: ['f1', 'f3'] },
        ]),
      ],
      solution: `function rights(matrix, subject, object) {\n  return (matrix[subject] && matrix[subject][object]) || [];\n}\nfunction allowed(matrix, subject, object, right) {\n  return rights(matrix, subject, object).includes(right);\n}\nfunction objectsAccessibleBy(matrix, subject, right) {\n  const row = matrix[subject] || {};\n  return Object.keys(row).filter((obj) => row[obj].includes(right)).sort();\n}`,
      realityNote: 'The access matrix is the abstract model of protection; real systems store it by column (access control lists on each object) or by row (capabilities each subject holds).',
    });
  }),
  tmpl(7, 1, 'intermediate', 'acl-vs-capability', 'Store rights as ACLs or capabilities', 'E1', 25, 'Convert between the two ways of representing the access matrix.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Two views of the same matrix\n\nOn **${m.host}**, the access matrix can be stored by object (ACLs) or by subject (capabilities). Write:\n\n1. \`aclFor(matrix, object)\`: return a map of \`subject → rights\` for one \`object\` (the object\'s access control list), including only subjects that have some right on it.\n2. \`capabilitiesFor(matrix, subject)\`: return the subject\'s row \`object → rights\` (its capability list).\n\n(\`matrix\` maps subject → { object → rights[] }.)`,
      hints: ['An ACL is a column of the matrix; capabilities are a row.', 'For the ACL, scan every subject for rights on that object.'],
      starter: `// ${m.host}: ACLs and capabilities\nfunction aclFor(matrix, object) {\n}\n\nfunction capabilitiesFor(matrix, subject) {\n}\n`,
      checks: [
        fn('aclFor builds the object column', 'aclFor', [
          { args: [{ alice: { f1: ['read'] }, bob: { f1: ['write'], f2: ['read'] } }, 'f1'], expected: { alice: ['read'], bob: ['write'] } },
          { args: [{ alice: { f1: ['read'] } }, 'f2'], expected: {} },
        ]),
        fn('capabilitiesFor returns the subject row', 'capabilitiesFor', [
          { args: [{ alice: { f1: ['read'], f2: ['write'] } }, 'alice'], expected: { f1: ['read'], f2: ['write'] } },
          { args: [{ alice: {} }, 'bob'], expected: {} },
        ]),
      ],
      solution: `function aclFor(matrix, object) {\n  const out = {};\n  for (const subject of Object.keys(matrix)) {\n    if (matrix[subject][object]) out[subject] = matrix[subject][object];\n  }\n  return out;\n}\nfunction capabilitiesFor(matrix, subject) {\n  return matrix[subject] || {};\n}`,
      realityNote: 'ACLs (per-object lists) make it easy to see who can access a file; capabilities (per-subject tokens) make it easy to pass and delegate rights — two storage choices for the same matrix.',
    });
  }),
  tmpl(7, 1, 'advanced', 'least-privilege-domains', 'Switch protection domains at least privilege', 'E1', 25, 'Grant a process only the rights its current task needs and drop the rest.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Least privilege and domain switching\n\nOn **${m.host}**, a process should hold only the rights its current task needs. Write:\n\n1. \`dropPrivileges(current, keep)\`: return the intersection of \`current\` rights (array) and \`keep\` (array) — drop everything not explicitly kept, order preserved from \`current\`.\n2. \`needsPrivilege(task, held)\`: \`task\` requires a \`requires\` array (passed as \`task.requires\`); return the sorted array of required rights **not** in \`held\`.\n3. \`overPrivileged(held, required)\`: return \`true\` if \`held\` contains any right not in \`required\` (more than the task needs).`,
      hints: ['Keep only rights that are in both lists.', 'A process is over-privileged if it holds rights the task does not require.'],
      starter: `// ${m.host}: least privilege\nfunction dropPrivileges(current, keep) {\n}\n\nfunction needsPrivilege(task, held) {\n}\n\nfunction overPrivileged(held, required) {\n}\n`,
      checks: [
        fn('dropPrivileges keeps the intersection', 'dropPrivileges', [
          { args: [['read', 'write', 'exec'], ['read']], expected: ['read'] },
          { args: [['read', 'write'], ['admin']], expected: [] },
        ]),
        fn('needsPrivilege finds what is missing', 'needsPrivilege', [
          { args: [{ requires: ['read', 'write'] }, ['read']], expected: ['write'] },
          { args: [{ requires: ['read'] }, ['read', 'write']], expected: [] },
        ]),
        fn('overPrivileged flags excess rights', 'overPrivileged', [
          { args: [['read', 'write'], ['read']], expected: true },
          { args: [['read'], ['read', 'write']], expected: false },
        ]),
      ],
      solution: `function dropPrivileges(current, keep) {\n  return current.filter((r) => keep.includes(r));\n}\nfunction needsPrivilege(task, held) {\n  return task.requires.filter((r) => !held.includes(r)).sort();\n}\nfunction overPrivileged(held, required) {\n  return held.some((r) => !required.includes(r));\n}`,
      realityNote: 'The principle of least privilege — a process holds only the rights its current task needs — limits the damage a compromised or buggy process can do; dropping privileges after startup is a common pattern.',
    });
  }),

  /* ------------------------------------------------------------------ 7.2 OS security defences */
  tmpl(7, 2, 'beginner', 'os-defences', 'Reason about OS security defences', 'E10', 15, 'Match OS-level defences to the attacks they make harder.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## How the OS defends untrusted code\n\n**${m.host}** runs code that might be buggy or malicious. Reason about the OS defences that contain it (all defensive — the goal is to make exploitation harder).`,
      steps: [
        { title: 'Non-executable memory', text: 'Why mark the stack and heap non-executable (DEP/NX)?', choices: [
          { text: 'So data a bug lets an attacker control cannot be run as code', right: true, feedback: 'Correct. Data pages marked non-executable cannot be run as instructions.' },
          { text: 'To make memory faster', feedback: 'It is a protection, not a speed feature.' },
          { text: 'To save memory', feedback: 'It is about preventing code execution in data regions.' },
        ] },
        { title: 'Address-space layout randomisation', text: 'What does ASLR achieve?', choices: [
          { text: 'Randomising where code and data load makes it hard to predict addresses an exploit needs', right: true, feedback: 'Correct. Unpredictable addresses frustrate many exploits.' },
          { text: 'It encrypts memory', feedback: 'ASLR randomises layout; it does not encrypt.' },
          { text: 'It removes all bugs', feedback: 'It makes exploiting bugs harder, not the bugs gone.' },
        ] },
        { title: 'Sandboxing', text: 'What does sandboxing a process do?', choices: [
          { text: 'Restricts what it can access (files, syscalls, network) so a compromise is contained', right: true, feedback: 'Correct. A tight sandbox limits the blast radius.' },
          { text: 'Gives it full system access', feedback: 'The opposite: it confines the process.' },
          { text: 'Speeds the process up', feedback: 'It confines, not accelerates.' },
        ] },
        { title: 'Privilege separation', text: 'Why run components with the least privilege and separate them?', choices: [
          { text: 'So a flaw in one low-privilege component cannot reach the whole system', right: true, feedback: 'Correct. Separation plus least privilege contains damage.' },
          { text: 'Because more privilege is always safer', feedback: 'Less privilege is safer; it limits damage.' },
          { text: 'To avoid writing drivers', feedback: 'It is about containment, not avoiding code.' },
        ] },
      ],
      ending: { title: 'Contain, randomise, separate', text: 'Non-executable memory stops data running as code, ASLR hides the addresses exploits need, sandboxing confines what a process can touch, and privilege separation keeps a single flaw from reaching everything — layered OS defences that make exploitation harder.' },
      hints: ['These are defences: DEP/NX, ASLR, sandboxing, privilege separation.', 'Each one raises the cost of turning a bug into a compromise.'],
      realityNote: 'DEP/NX, ASLR, stack canaries, sandboxing and privilege separation are standard OS mitigations; none fixes the underlying bug, but together they make reliable exploitation much harder.',
    });
  }),
  tmpl(7, 2, 'intermediate', 'bounds-checking', 'Prevent an out-of-bounds write', 'E1', 20, 'Validate an index and length before a memory write to stop overflow.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Check the bounds, always\n\nMany memory-safety bugs come from writing past a buffer on **${m.host}**. Model the defensive check. Write:\n\n1. \`inBounds(index, length)\`: return \`true\` when \`0 <= index < length\`.\n2. \`safeWrite(buffer, index, value)\`: if \`inBounds(index, buffer.length)\`, return \`{ ok: true, buffer: <copy with buffer[index] = value> }\`; else \`{ ok: false, error: "out-of-bounds" }\` (reject, do not write).\n3. \`rangeOk(start, count, length)\`: return \`true\` when a write of \`count\` elements from \`start\` stays within \`length\` (\`start >= 0 && start + count <= length\`).`,
      hints: ['Validate before writing, never after.', 'A range write must fit entirely inside the buffer.'],
      starter: `// ${m.host}: bounds checking\nfunction inBounds(index, length) {\n}\n\nfunction safeWrite(buffer, index, value) {\n}\n\nfunction rangeOk(start, count, length) {\n}\n`,
      checks: [
        fn('inBounds checks the index', 'inBounds', [
          { args: [0, 4], expected: true }, { args: [3, 4], expected: true }, { args: [4, 4], expected: false }, { args: [-1, 4], expected: false },
        ]),
        fn('safeWrite rejects out-of-bounds', 'safeWrite', [
          { args: [[1, 2, 3], 1, 9], expected: { ok: true, buffer: [1, 9, 3] } },
          { args: [[1, 2, 3], 5, 9], expected: { ok: false, error: 'out-of-bounds' } },
        ]),
        fn('rangeOk checks a span', 'rangeOk', [
          { args: [0, 4, 4], expected: true }, { args: [2, 3, 4], expected: false }, { args: [-1, 1, 4], expected: false },
        ]),
      ],
      solution: `function inBounds(index, length) {\n  return index >= 0 && index < length;\n}\nfunction safeWrite(buffer, index, value) {\n  if (!inBounds(index, buffer.length)) return { ok: false, error: "out-of-bounds" };\n  const copy = [...buffer];\n  copy[index] = value;\n  return { ok: true, buffer: copy };\n}\nfunction rangeOk(start, count, length) {\n  return start >= 0 && start + count <= length;\n}`,
      realityNote: 'Checking an index against the buffer length before every write is the core of memory safety; languages and OSes that enforce it (or hardware bounds checks) eliminate a whole class of overflow bugs.',
    });
  }),
  tmpl(7, 2, 'advanced', 'aslr-entropy', 'Quantify ASLR entropy', 'E1', 25, 'Compute how many random bits a layout gives and how that resists guessing.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## How much does randomisation help?\n\nOn **${m.host}**, ASLR places a region at one of many aligned slots. Write:\n\n1. \`slots(rangeBytes, alignment)\`: number of aligned positions = \`Math.floor(rangeBytes / alignment)\`.\n2. \`entropyBits(slotCount)\`: \`Math.floor(Math.log2(slotCount))\` for \`slotCount >= 1\`, else 0 — the random bits of placement.\n3. \`expectedGuesses(slotCount)\`: on average an attacker guessing blindly needs \`(slotCount + 1) / 2\` tries; return it rounded to 1 decimal.`,
      hints: ['More aligned slots means more entropy bits.', 'Average blind guesses to hit one of N is (N+1)/2.'],
      starter: `// ${m.host}: ASLR entropy\nfunction slots(rangeBytes, alignment) {\n}\n\nfunction entropyBits(slotCount) {\n}\n\nfunction expectedGuesses(slotCount) {\n}\n`,
      checks: [
        fn('slots counts aligned positions', 'slots', [
          { args: [65536, 4096], expected: 16 }, { args: [1048576, 4096], expected: 256 },
        ]),
        fn('entropyBits is log2 of slots', 'entropyBits', [
          { args: [256], expected: 8 }, { args: [16], expected: 4 }, { args: [1], expected: 0 },
        ]),
        fn('expectedGuesses averages the search', 'expectedGuesses', [
          { args: [256], expected: 128.5 }, { args: [1], expected: 1 },
        ]),
      ],
      solution: `function slots(rangeBytes, alignment) {\n  return Math.floor(rangeBytes / alignment);\n}\nfunction entropyBits(slotCount) {\n  return slotCount >= 1 ? Math.floor(Math.log2(slotCount)) : 0;\n}\nfunction expectedGuesses(slotCount) {\n  return Math.round(((slotCount + 1) / 2) * 10) / 10;\n}`,
      realityNote: 'ASLR\'s strength is its entropy: more random bits mean more guesses to find a target address; 64-bit systems allow far more entropy than 32-bit ones, which is why 32-bit ASLR was weaker.',
    });
  }),

  /* ------------------------------------------------------------------ 7.3 virtual machines */
  tmpl(7, 3, 'beginner', 'hypervisor-types', 'Compare type 1 and type 2 hypervisors', 'E10', 15, 'Reason about where a hypervisor sits and how it virtualises the CPU.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Running machines inside a machine\n\n**${m.host}** runs virtual machines. Reason about how a hypervisor virtualises the hardware.`,
      steps: [
        { title: 'Type 1 vs type 2', text: 'What is a type 1 (bare-metal) hypervisor?', choices: [
          { text: 'It runs directly on the hardware, with guest OSes on top — used in servers and clouds', right: true, feedback: 'Correct. Type 1 runs on bare metal for efficiency.' },
          { text: 'It runs as an app inside a host OS', feedback: 'That is a type 2 hypervisor.' },
          { text: 'It needs no hardware', feedback: 'It runs on the hardware directly.' },
        ] },
        { title: 'Type 2', text: 'What is a type 2 (hosted) hypervisor?', choices: [
          { text: 'It runs as an application on a normal host OS — convenient on desktops (e.g. for testing)', right: true, feedback: 'Correct. Type 2 is hosted inside an ordinary OS.' },
          { text: 'It replaces the host OS entirely', feedback: 'That is type 1; type 2 runs on top of a host OS.' },
          { text: 'It cannot run guest OSes', feedback: 'It runs guest OSes, just via the host.' },
        ] },
        { title: 'Trap-and-emulate', text: 'How does a hypervisor safely run a guest\'s privileged instructions?', choices: [
          { text: 'The guest runs unprivileged; its privileged instructions trap to the hypervisor, which emulates them', right: true, feedback: 'Correct. Trap-and-emulate keeps the guest contained.' },
          { text: 'The guest runs with full hardware privilege', feedback: 'That would break isolation; the guest is deprivileged.' },
          { text: 'Privileged instructions are ignored', feedback: 'They are trapped and emulated, not ignored.' },
        ] },
        { title: 'Hardware support', text: 'What do hardware virtualisation features (VT-x/AMD-V, nested page tables) add?', choices: [
          { text: 'A hardware guest mode and two-level address translation that make virtualisation faster and simpler', right: true, feedback: 'Correct. Hardware support reduces the cost of trapping and memory translation.' },
          { text: 'They remove the need for a hypervisor', feedback: 'A hypervisor still coordinates; hardware just helps it.' },
          { text: 'They slow virtualisation down', feedback: 'They speed it up substantially.' },
        ] },
      ],
      ending: { title: 'Deprivilege the guest, help it in hardware', text: 'Type 1 hypervisors run on bare metal and type 2 inside a host OS; both deprivilege the guest and trap-and-emulate its privileged instructions, with hardware features (guest mode, nested page tables) making it fast.' },
      hints: ['Type 1 = bare metal; type 2 = hosted app.', 'Trap-and-emulate plus hardware support is how guests run safely and fast.'],
      realityNote: 'VMware ESXi and Xen are type 1; VirtualBox and VMware Workstation are type 2. Hardware virtualisation (VT-x, nested page tables) is what made full virtualisation efficient.',
    });
  }),
  tmpl(7, 3, 'intermediate', 'nested-page-tables', 'Translate a guest address through two levels', 'E1', 25, 'Map a guest-virtual address to guest-physical, then to host-physical.', (v) => {
    const m = machineOf(v);
    const ps = v.pick([256, 512, 1024]);
    return js({
      instructions: `## Two-level translation for VMs (page ${ps})\n\nOn **${m.host}**, a guest address is translated twice: guest-virtual → guest-physical (by the guest\'s page table) → host-physical (by the hypervisor\'s). Page size is **${ps}**. Write:\n\n1. \`gvaToGpa(gva, guestTable, pageSize)\`: split \`gva\` into page+offset; \`guestTable\` maps guest page → guest frame; return the guest-physical address, or \`null\` if unmapped.\n2. \`gpaToHpa(gpa, hostTable, pageSize)\`: same, using \`hostTable\` (guest frame → host frame).\n3. \`translate(gva, guestTable, hostTable, pageSize)\`: chain the two; \`null\` if either step faults.`,
      hints: ['Each level is an ordinary page translation.', 'Chain the output of the first as the input page of the second.'],
      starter: `// ${m.host}: nested page tables\nfunction gvaToGpa(gva, guestTable, pageSize) {\n}\n\nfunction gpaToHpa(gpa, hostTable, pageSize) {\n}\n\nfunction translate(gva, guestTable, hostTable, pageSize) {\n}\n`,
      checks: [
        fn('gvaToGpa uses the guest table', 'gvaToGpa', [
          { args: [ps + 5, { 1: 7 }, ps], expected: 7 * ps + 5 },
          { args: [ps * 2, { 1: 7 }, ps], expected: null },
        ]),
        fn('gpaToHpa uses the host table', 'gpaToHpa', [
          { args: [7 * ps + 5, { 7: 3 }, ps], expected: 3 * ps + 5 },
        ]),
        fn('translate chains both levels', 'translate', [
          { args: [ps + 5, { 1: 7 }, { 7: 3 }, ps], expected: 3 * ps + 5 },
          { args: [ps + 5, { 1: 7 }, {}, ps], expected: null },
          { args: [ps + 5, {}, { 7: 3 }, ps], expected: null },
        ]),
      ],
      solution: `function gvaToGpa(gva, guestTable, pageSize) {\n  const page = Math.floor(gva / pageSize), offset = gva % pageSize;\n  const frame = guestTable[page];\n  return frame === undefined ? null : frame * pageSize + offset;\n}\nfunction gpaToHpa(gpa, hostTable, pageSize) {\n  const page = Math.floor(gpa / pageSize), offset = gpa % pageSize;\n  const frame = hostTable[page];\n  return frame === undefined ? null : frame * pageSize + offset;\n}\nfunction translate(gva, guestTable, hostTable, pageSize) {\n  const gpa = gvaToGpa(gva, guestTable, pageSize);\n  if (gpa === null) return null;\n  return gpaToHpa(gpa, hostTable, pageSize);\n}`,
      realityNote: 'Nested (extended) page tables let the hardware walk both the guest and host translations, avoiding the costly shadow-page-table tricks early hypervisors needed.',
    });
  }),
  tmpl(7, 3, 'advanced', 'vm-overcommit', 'Decide memory overcommit for VMs', 'E1', 25, 'Weigh assigning more virtual memory than physically present against the risk.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Memory overcommit\n\nOn **${m.host}**, a hypervisor can assign guests more memory than physically exists, relying on them not all using it at once. Write:\n\n1. \`committed(guests)\`: sum of each guest\'s assigned memory (\`guests\` is an array of \`{ assigned, used }\`).\n2. \`overcommitRatio(guests, physical)\`: \`committed / physical\`, rounded to 2 decimals.\n3. \`atRisk(guests, physical)\`: return \`true\` if the **actual used** total (\`sum of used\`) exceeds \`physical\` — the point where the host must swap or balloon, hurting performance.`,
      hints: ['Overcommit is fine until actual usage exceeds physical memory.', 'Sum assigned for the ratio; sum used for the risk.'],
      starter: `// ${m.host}: VM memory overcommit\nfunction committed(guests) {\n}\n\nfunction overcommitRatio(guests, physical) {\n}\n\nfunction atRisk(guests, physical) {\n}\n`,
      checks: [
        fn('committed sums assigned memory', 'committed', [
          { args: [[{ assigned: 4, used: 2 }, { assigned: 4, used: 1 }]], expected: 8 },
        ]),
        fn('overcommitRatio divides by physical', 'overcommitRatio', [
          { args: [[{ assigned: 4, used: 2 }, { assigned: 4, used: 1 }], 6], expected: 1.33 },
        ]),
        fn('atRisk checks actual usage', 'atRisk', [
          { args: [[{ assigned: 4, used: 4 }, { assigned: 4, used: 4 }], 6], expected: true },
          { args: [[{ assigned: 4, used: 2 }, { assigned: 4, used: 1 }], 6], expected: false },
        ]),
      ],
      solution: `function committed(guests) {\n  return guests.reduce((s, g) => s + g.assigned, 0);\n}\nfunction overcommitRatio(guests, physical) {\n  return Math.round((committed(guests) / physical) * 100) / 100;\n}\nfunction atRisk(guests, physical) {\n  return guests.reduce((s, g) => s + g.used, 0) > physical;\n}`,
      realityNote: 'Hypervisors overcommit memory because guests rarely use all they are assigned; ballooning and swapping recover memory when they do, but heavy actual usage above physical RAM degrades every guest.',
    });
  }),

  /* ------------------------------------------------------------------ 7.4 containers */
  tmpl(7, 4, 'beginner', 'vm-vs-container', 'Compare VMs and containers', 'E10', 15, 'Reason about what containers share with the host and when to prefer each.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## Containers next to VMs\n\n**${m.host}** can isolate workloads with VMs or containers. Reason about the difference.`,
      steps: [
        { title: 'The kernel', text: 'What is the key structural difference?', choices: [
          { text: 'Containers share the host kernel and isolate with namespaces/cgroups; VMs run a full guest OS on virtual hardware', right: true, feedback: 'Correct. Containers share the kernel; VMs virtualise hardware.' },
          { text: 'Containers each run their own kernel', feedback: 'They share the host kernel; that is the point.' },
          { text: 'There is no difference', feedback: 'The shared-kernel vs full-OS split is fundamental.' },
        ] },
        { title: 'Weight', text: 'Why do containers start faster and pack denser?', choices: [
          { text: 'No guest OS to boot and no hardware to virtualise — just isolated processes on the host kernel', right: true, feedback: 'Correct. Less to start means faster, denser deployment.' },
          { text: 'They use more memory each', feedback: 'They use less, by sharing the kernel.' },
          { text: 'They boot a full OS faster', feedback: 'They skip booting a full OS entirely.' },
        ] },
        { title: 'Isolation strength', text: 'When is a VM\'s stronger isolation preferred?', choices: [
          { text: 'For untrusted or multi-tenant workloads needing a hard boundary, since a shared kernel is a larger attack surface', right: true, feedback: 'Correct. A full VM boundary is stronger than shared-kernel isolation.' },
          { text: 'Never; containers are always safer', feedback: 'A shared kernel is a bigger attack surface than a VM boundary.' },
          { text: 'Only for graphics', feedback: 'The reason is isolation strength, not graphics.' },
        ] },
        { title: 'Using both', text: 'How do real platforms combine them?', choices: [
          { text: 'Run containers inside lightweight VMs to get container convenience with VM-grade isolation', right: true, feedback: 'Correct. The combination (e.g. Kata, Firecracker) is common in multi-tenant clouds.' },
          { text: 'They never combine', feedback: 'Containers-in-VMs is a common cloud pattern.' },
          { text: 'They always pick one forever', feedback: 'Hybrid approaches are standard.' },
        ] },
      ],
      ending: { title: 'Shared kernel vs full guest', text: 'Containers share the host kernel and isolate with namespaces and cgroups — light and fast; VMs run a full guest OS for stronger isolation. Untrusted multi-tenant workloads often run containers inside lightweight VMs to get both.' },
      hints: ['Containers share the kernel; VMs virtualise hardware.', 'Stronger isolation (VM) for untrusted tenants; containers for density and speed.'],
      realityNote: 'Containers (Docker, containerd) share the host kernel via namespaces and cgroups; clouds running untrusted tenants wrap them in micro-VMs (Firecracker, Kata) for a harder boundary.',
    });
  }),
  tmpl(7, 4, 'intermediate', 'cgroup-limits', 'Enforce a cgroup resource limit', 'E1', 25, 'Cap a container\'s CPU and memory and decide when a limit is exceeded.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Limiting a container\n\nOn **${m.host}**, cgroups cap a container\'s resources. Write:\n\n1. \`withinMemory(usedBytes, limitBytes)\`: return \`true\` when \`usedBytes <= limitBytes\`.\n2. \`cpuAllowed(usageMicros, quotaMicros)\`: in a period a container may use up to \`quotaMicros\` of CPU time; return \`true\` when \`usageMicros <= quotaMicros\`.\n3. \`action(usedBytes, limitBytes)\`: return \`"oom-kill"\` when memory is exceeded (over the hard limit), else \`"ok"\` — the kernel kills a container that exceeds its memory limit.`,
      hints: ['Memory and CPU limits are simple threshold checks.', 'Exceeding the memory hard limit triggers an OOM kill.'],
      starter: `// ${m.host}: cgroup limits\nfunction withinMemory(usedBytes, limitBytes) {\n}\n\nfunction cpuAllowed(usageMicros, quotaMicros) {\n}\n\nfunction action(usedBytes, limitBytes) {\n}\n`,
      checks: [
        fn('withinMemory checks the cap', 'withinMemory', [
          { args: [100, 200], expected: true }, { args: [300, 200], expected: false },
        ]),
        fn('cpuAllowed checks the quota', 'cpuAllowed', [
          { args: [50000, 100000], expected: true }, { args: [120000, 100000], expected: false },
        ]),
        fn('action kills on memory overrun', 'action', [
          { args: [300, 200], expected: 'oom-kill' }, { args: [100, 200], expected: 'ok' },
        ]),
      ],
      solution: `function withinMemory(usedBytes, limitBytes) {\n  return usedBytes <= limitBytes;\n}\nfunction cpuAllowed(usageMicros, quotaMicros) {\n  return usageMicros <= quotaMicros;\n}\nfunction action(usedBytes, limitBytes) {\n  return withinMemory(usedBytes, limitBytes) ? "ok" : "oom-kill";\n}`,
      realityNote: 'cgroups enforce per-container CPU quotas and memory limits; a container that exceeds its memory limit is killed by the kernel OOM killer — the mechanism behind container resource isolation.',
    });
  }),
  tmpl(7, 4, 'advanced', 'namespace-isolation', 'Resolve a resource through a namespace', 'E1', 25, 'Map a container\'s view of PIDs or mounts to the host through its namespace.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Namespaces: a private view\n\nOn **${m.host}**, a namespace gives a container its own numbering of a resource. Model a PID namespace. Write:\n\n1. \`toHostPid(nsPid, map)\`: \`map\` maps a container-local PID to a host PID. Return the host PID, or \`null\` if the local PID is not in the namespace.\n2. \`visibleIn(nsPid, map)\`: return \`true\` if \`nsPid\` exists in this namespace (a process in another namespace is invisible).\n3. \`hostPidsOf(map)\`: return the sorted array of host PIDs the namespace contains.`,
      hints: ['A namespace only sees its own entries.', 'A PID outside the namespace resolves to null and is invisible.'],
      starter: `// ${m.host}: PID namespace\nfunction toHostPid(nsPid, map) {\n}\n\nfunction visibleIn(nsPid, map) {\n}\n\nfunction hostPidsOf(map) {\n}\n`,
      checks: [
        fn('toHostPid maps local to host', 'toHostPid', [
          { args: [1, { 1: 4021, 2: 4055 }], expected: 4021 },
          { args: [9, { 1: 4021 }], expected: null },
        ]),
        fn('visibleIn checks membership', 'visibleIn', [
          { args: [2, { 1: 4021, 2: 4055 }], expected: true },
          { args: [3, { 1: 4021 }], expected: false },
        ]),
        fn('hostPidsOf lists the host PIDs', 'hostPidsOf', [
          { args: [{ 2: 4055, 1: 4021 }], expected: [4021, 4055] },
        ]),
      ],
      solution: `function toHostPid(nsPid, map) {\n  return Object.prototype.hasOwnProperty.call(map, nsPid) ? map[nsPid] : null;\n}\nfunction visibleIn(nsPid, map) {\n  return Object.prototype.hasOwnProperty.call(map, nsPid);\n}\nfunction hostPidsOf(map) {\n  return Object.values(map).sort((a, b) => a - b);\n}`,
      realityNote: 'A PID namespace gives a container its own PID 1 and numbering; the kernel maps those to host PIDs, and processes outside the namespace are simply invisible — the basis of container isolation.',
    });
  }),
];
