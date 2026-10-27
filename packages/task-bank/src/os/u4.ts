/** Unit 4: memory management — address binding and base/bounds, allocation and fragmentation,
 * paging and address translation, and virtual memory with page-replacement algorithms. */

import type { TaskTemplate } from '../types.js';
import { caseStudy, fn, js, machineOf, tmpl } from './kit.js';

export const U4: TaskTemplate[] = [
  /* ------------------------------------------------------------------ 4.1 address binding and base/bounds */
  tmpl(4, 1, 'beginner', 'base-bounds', 'Translate addresses with base and bounds', 'E1', 20, 'Relocate a logical address and enforce the bounds limit.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Base-and-bounds relocation\n\nOn **${m.host}**, a process\'s logical address is relocated by adding a **base** and checked against a **limit**. Write:\n\n1. \`translate(logical, base, limit)\`: if \`logical < 0 || logical >= limit\`, return \`{ fault: true }\` (out of bounds); otherwise \`{ physical: base + logical }\`.\n2. \`inBounds(logical, limit)\`: return \`true\` when \`0 <= logical < limit\`.`,
      hints: ['Check the bounds first, then add the base.', 'A valid logical address is in [0, limit).'],
      starter: `// ${m.host}: base and bounds\nfunction translate(logical, base, limit) {\n}\n\nfunction inBounds(logical, limit) {\n}\n`,
      checks: [
        fn('translate relocates and checks bounds', 'translate', [
          { args: [100, 1000, 500], expected: { physical: 1100 } },
          { args: [500, 1000, 500], expected: { fault: true } },
          { args: [-1, 1000, 500], expected: { fault: true } },
          { args: [0, 2000, 500], expected: { physical: 2000 } },
        ]),
        fn('inBounds checks the range', 'inBounds', [
          { args: [0, 500], expected: true }, { args: [499, 500], expected: true }, { args: [500, 500], expected: false },
        ]),
      ],
      solution: `function translate(logical, base, limit) {\n  if (logical < 0 || logical >= limit) return { fault: true };\n  return { physical: base + logical };\n}\nfunction inBounds(logical, limit) {\n  return logical >= 0 && logical < limit;\n}`,
      realityNote: 'Base-and-bounds is the simplest hardware memory protection: add the base to relocate, compare with the limit to isolate — the seed of all address translation.',
    });
  }),
  tmpl(4, 1, 'intermediate', 'segmentation', 'Translate a segmented address', 'E1', 25, 'Resolve a (segment, offset) address through a segment table with per-segment limits.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Segmented addressing\n\nOn **${m.host}**, an address is \`(segment, offset)\`. A segment table maps a segment number to \`{ base, limit }\`. Write \`translate(seg, offset, table)\`:\n\n- if \`seg\` is not a valid index into \`table\` → \`{ fault: "bad-segment" }\`;\n- if \`offset < 0 || offset >= table[seg].limit\` → \`{ fault: "bounds" }\`;\n- otherwise \`{ physical: table[seg].base + offset }\`.\n\nAlso \`segmentCount(table)\`: return the number of segments.`,
      hints: ['Validate the segment index, then the offset against that segment\'s limit.', 'Each segment has its own base and limit.'],
      starter: `// ${m.host}: segmentation\nfunction translate(seg, offset, table) {\n}\n\nfunction segmentCount(table) {\n}\n`,
      checks: [
        fn('translate resolves segmented addresses', 'translate', [
          { args: [0, 50, [{ base: 1000, limit: 100 }, { base: 5000, limit: 200 }]], expected: { physical: 1050 } },
          { args: [1, 199, [{ base: 1000, limit: 100 }, { base: 5000, limit: 200 }]], expected: { physical: 5199 } },
          { args: [0, 100, [{ base: 1000, limit: 100 }]], expected: { fault: 'bounds' } },
          { args: [3, 0, [{ base: 1000, limit: 100 }]], expected: { fault: 'bad-segment' } },
        ]),
        fn('segmentCount counts segments', 'segmentCount', [
          { args: [[{ base: 0, limit: 1 }, { base: 2, limit: 3 }]], expected: 2 },
        ]),
      ],
      solution: `function translate(seg, offset, table) {\n  if (seg < 0 || seg >= table.length) return { fault: "bad-segment" };\n  if (offset < 0 || offset >= table[seg].limit) return { fault: "bounds" };\n  return { physical: table[seg].base + offset };\n}\nfunction segmentCount(table) {\n  return table.length;\n}`,
      realityNote: 'Segmentation gives each logical region (code, stack, heap) its own base and limit, matching the program\'s structure but leaving external fragmentation between segments.',
    });
  }),
  tmpl(4, 1, 'advanced', 'logical-vs-physical', 'Reason about address binding time', 'E10', 20, 'Decide when addresses are bound and why that affects relocation.', (v) => {
    const m = machineOf(v);
    return caseStudy(v, {
      intro: `## When is an address fixed?\n\nA program for **${m.host}** turns names into addresses at different times. Reason about binding time and its consequences.`,
      steps: [
        { title: 'Compile time', text: 'If addresses are bound at compile time, what is required?', choices: [
          { text: 'The program must load at a known fixed location every time (absolute code)', right: true, feedback: 'Correct. Compile-time binding fixes the load address.' },
          { text: 'The program can load anywhere freely', feedback: 'That needs later binding, not compile-time.' },
          { text: 'No memory is needed', feedback: 'It still needs memory; the address is just fixed early.' },
        ] },
        { title: 'Load time', text: 'What does binding at load time allow?', choices: [
          { text: 'Relocatable code that the loader fixes up to wherever it is placed, but it cannot move after loading', right: true, feedback: 'Correct. The loader relocates once; no movement afterward.' },
          { text: 'Moving the program freely while it runs', feedback: 'Run-time movement needs execution-time binding with hardware support.' },
          { text: 'Nothing changes from compile time', feedback: 'Load-time binding adds relocatability.' },
        ] },
        { title: 'Execution time', text: 'Why is execution-time binding the most flexible?', choices: [
          { text: 'The MMU translates logical to physical on every access, so the OS can move a process in memory', right: true, feedback: 'Correct. Hardware translation allows run-time relocation and swapping.' },
          { text: 'Because it needs no hardware', feedback: 'It needs an MMU for per-access translation.' },
          { text: 'Because addresses never change', feedback: 'They can change; the MMU hides that from the program.' },
        ] },
        { title: 'Logical vs physical', text: 'What is the key distinction the MMU maintains?', choices: [
          { text: 'The program sees logical addresses; the MMU maps them to physical addresses at run time', right: true, feedback: 'Correct. This indirection is what enables protection and relocation.' },
          { text: 'There is no difference', feedback: 'The logical/physical split is the whole point.' },
          { text: 'The program sees physical addresses directly', feedback: 'It sees logical addresses; the MMU translates.' },
        ] },
      ],
      ending: { title: 'Later binding, more flexibility', text: 'Compile-time binding fixes the location; load-time binding relocates once; execution-time binding uses the MMU to translate every access, letting the OS relocate and swap processes — the basis of modern virtual memory.' },
      hints: ['Binding can happen at compile, load or execution time.', 'Execution-time binding needs an MMU and gives the most flexibility.'],
      realityNote: 'Modern systems bind at execution time: programs use logical addresses and the MMU translates each access, which is what makes relocation, protection and virtual memory possible.',
    });
  }),

  /* ------------------------------------------------------------------ 4.2 allocation and fragmentation */
  tmpl(4, 2, 'beginner', 'first-fit', 'Allocate memory with first fit', 'E1', 25, 'Place a request in the first hole large enough and split the remainder.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## First-fit allocation\n\nOn **${m.host}**, free memory is a list of holes \`{ start, size }\` (sorted by start). Write \`firstFit(holes, request)\`:\n\n- scan for the **first** hole with \`size >= request\`;\n- if none, return \`{ allocatedAt: null, holes }\`;\n- otherwise allocate at that hole\'s \`start\`, and return \`{ allocatedAt: start, holes: <updated> }\` where the chosen hole shrinks by \`request\` (its \`start\` moves up and \`size\` down); a hole that becomes size 0 is removed.`,
      hints: ['Take the first hole that fits; shrink it from the front.', 'Drop a hole that is fully consumed.'],
      starter: `// ${m.host}: first-fit allocator\nfunction firstFit(holes, request) {\n}\n`,
      checks: [
        fn('firstFit uses the first large-enough hole', 'firstFit', [
          { args: [[{ start: 0, size: 10 }, { start: 20, size: 30 }], 5], expected: { allocatedAt: 0, holes: [{ start: 5, size: 5 }, { start: 20, size: 30 }] } },
          { args: [[{ start: 0, size: 4 }, { start: 20, size: 30 }], 5], expected: { allocatedAt: 20, holes: [{ start: 0, size: 4 }, { start: 25, size: 25 }] } },
          { args: [[{ start: 0, size: 5 }], 5], expected: { allocatedAt: 0, holes: [] } },
          { args: [[{ start: 0, size: 3 }], 5], expected: { allocatedAt: null, holes: [{ start: 0, size: 3 }] } },
        ]),
      ],
      solution: `function firstFit(holes, request) {\n  const out = holes.map((h) => ({ ...h }));\n  for (let i = 0; i < out.length; i++) {\n    if (out[i].size >= request) {\n      const start = out[i].start;\n      out[i] = { start: out[i].start + request, size: out[i].size - request };\n      if (out[i].size === 0) out.splice(i, 1);\n      return { allocatedAt: start, holes: out };\n    }\n  }\n  return { allocatedAt: null, holes: out };\n}`,
      realityNote: 'First fit is fast and works well in practice; it scans from the start and takes the first hole that fits, leaving external fragmentation that compaction or paging addresses.',
    });
  }),
  tmpl(4, 2, 'intermediate', 'best-fit', 'Compare best fit and fragmentation', 'E1', 25, 'Choose the smallest adequate hole and measure the external fragmentation left.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Best-fit and fragmentation\n\nOn **${m.host}**, write:\n\n1. \`bestFitIndex(holes, request)\`: return the index of the **smallest** hole with \`size >= request\` (ties by lowest index), or \`-1\` if none fits.\n2. \`externalFragmentation(holes, request)\`: the total free space is \`sum(sizes)\`; if \`totalFree >= request\` but **no single hole** fits the request, the request fails despite enough total space — return the \`totalFree\` in that case, else return \`0\` (either it fits somewhere, or there is not enough total).`,
      hints: ['Best fit minimises leftover by taking the tightest hole.', 'External fragmentation is enough total free space split so no hole fits.'],
      starter: `// ${m.host}: best-fit and fragmentation\nfunction bestFitIndex(holes, request) {\n}\n\nfunction externalFragmentation(holes, request) {\n}\n`,
      checks: [
        fn('bestFitIndex picks the tightest hole', 'bestFitIndex', [
          { args: [[{ start: 0, size: 10 }, { start: 20, size: 6 }, { start: 30, size: 8 }], 5], expected: 1 },
          { args: [[{ start: 0, size: 4 }], 5], expected: -1 },
        ]),
        fn('externalFragmentation detects the split', 'externalFragmentation', [
          { args: [[{ start: 0, size: 3 }, { start: 10, size: 3 }], 5], expected: 6 },
          { args: [[{ start: 0, size: 6 }], 5], expected: 0 },
          { args: [[{ start: 0, size: 2 }], 5], expected: 0 },
        ]),
      ],
      solution: `function bestFitIndex(holes, request) {\n  let best = -1;\n  for (let i = 0; i < holes.length; i++) {\n    if (holes[i].size >= request && (best === -1 || holes[i].size < holes[best].size)) best = i;\n  }\n  return best;\n}\nfunction externalFragmentation(holes, request) {\n  const totalFree = holes.reduce((s, h) => s + h.size, 0);\n  const fits = holes.some((h) => h.size >= request);\n  return totalFree >= request && !fits ? totalFree : 0;\n}`,
      realityNote: 'Best fit minimises wasted space per allocation but tends to leave many tiny holes; external fragmentation is when free memory is sufficient in total yet too scattered to satisfy a request.',
    });
  }),
  tmpl(4, 2, 'advanced', 'buddy-allocator', 'Allocate with the buddy system', 'E1', 25, 'Round a request up to a power-of-two block and find its buddy address.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The buddy system\n\nOn **${m.host}**, the buddy allocator rounds every request up to a power of two and splits/merges blocks. Write:\n\n1. \`blockSize(request)\`: return the smallest power of two \`>= request\` (minimum 1). For \`request <= 0\` return 1.\n2. \`buddyAddress(address, size)\`: the buddy of a block at \`address\` of \`size\` (a power of two) is \`address XOR size\`. Return it.\n3. \`internalFragmentation(request)\`: return \`blockSize(request) - request\` (space wasted inside the rounded-up block).`,
      hints: ['Round up to a power of two with a loop or Math.', 'The buddy is found by XOR-ing the address with the block size.'],
      starter: `// ${m.host}: buddy allocator\nfunction blockSize(request) {\n}\n\nfunction buddyAddress(address, size) {\n}\n\nfunction internalFragmentation(request) {\n}\n`,
      checks: [
        fn('blockSize rounds up to a power of two', 'blockSize', [
          { args: [1], expected: 1 }, { args: [5], expected: 8 }, { args: [8], expected: 8 }, { args: [100], expected: 128 }, { args: [0], expected: 1 },
        ]),
        fn('buddyAddress XORs address and size', 'buddyAddress', [
          { args: [0, 8], expected: 8 }, { args: [8, 8], expected: 0 }, { args: [16, 8], expected: 24 },
        ]),
        fn('internalFragmentation measures waste', 'internalFragmentation', [
          { args: [5], expected: 3 }, { args: [8], expected: 0 }, { args: [100], expected: 28 },
        ]),
      ],
      solution: `function blockSize(request) {\n  if (request <= 1) return 1;\n  let s = 1;\n  while (s < request) s *= 2;\n  return s;\n}\nfunction buddyAddress(address, size) {\n  return address ^ size;\n}\nfunction internalFragmentation(request) {\n  return blockSize(request) - request;\n}`,
      realityNote: 'The buddy system (used in the Linux page allocator) keeps blocks as powers of two so a freed block can merge with its buddy in O(1); the cost is internal fragmentation up to nearly half a block.',
    });
  }),

  /* ------------------------------------------------------------------ 4.3 paging and translation */
  tmpl(4, 3, 'beginner', 'paging-translate', 'Translate a paged address', 'E1', 25, 'Split a logical address into page and offset and map it through a page table.', (v) => {
    const m = machineOf(v);
    const bits = v.pick([8, 10, 12]);
    const pageSize = 2 ** bits;
    return js({
      instructions: `## Paging with ${pageSize}-byte pages\n\nOn **${m.host}**, pages are **${pageSize}** bytes (offset is the low **${bits}** bits). A page table maps a page number to a frame number. Write:\n\n1. \`pageNumber(logical, pageSize)\`: \`Math.floor(logical / pageSize)\`.\n2. \`offset(logical, pageSize)\`: \`logical % pageSize\`.\n3. \`translate(logical, pageSize, table)\`: \`table\` maps page→frame; if the page is not mapped (undefined), return \`{ fault: true }\`; else \`{ physical: frame * pageSize + offset }\`.`,
      hints: ['Page number is the high bits; offset is the low bits.', 'Physical = frame * pageSize + offset.'],
      starter: `// ${m.host}: paging translation\nfunction pageNumber(logical, pageSize) {\n}\n\nfunction offset(logical, pageSize) {\n}\n\nfunction translate(logical, pageSize, table) {\n}\n`,
      checks: [
        fn('pageNumber extracts the page', 'pageNumber', [
          { args: [pageSize + 5, pageSize], expected: 1 }, { args: [0, pageSize], expected: 0 }, { args: [pageSize * 3 + 7, pageSize], expected: 3 },
        ]),
        fn('offset extracts the offset', 'offset', [
          { args: [pageSize + 5, pageSize], expected: 5 }, { args: [pageSize * 3 + 7, pageSize], expected: 7 },
        ]),
        fn('translate maps through the table', 'translate', [
          { args: [pageSize + 5, pageSize, { 1: 4 }], expected: { physical: 4 * pageSize + 5 } },
          { args: [pageSize * 2, pageSize, { 1: 4 }], expected: { fault: true } },
        ]),
      ],
      solution: `function pageNumber(logical, pageSize) {\n  return Math.floor(logical / pageSize);\n}\nfunction offset(logical, pageSize) {\n  return logical % pageSize;\n}\nfunction translate(logical, pageSize, table) {\n  const frame = table[pageNumber(logical, pageSize)];\n  if (frame === undefined) return { fault: true };\n  return { physical: frame * pageSize + offset(logical, pageSize) };\n}`,
      realityNote: 'Paging splits an address into a page number (indexes the page table) and an offset (unchanged); fixed-size pages and frames eliminate external fragmentation.',
    });
  }),
  tmpl(4, 3, 'intermediate', 'tlb', 'Model a TLB and its hit rate', 'E1', 25, 'Look up translations in a TLB, fall back to the page table, and compute the hit rate.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The translation lookaside buffer\n\nOn **${m.host}**, a TLB caches page→frame translations. Write:\n\n1. \`lookup(tlb, page)\`: \`tlb\` is an object page→frame. Return \`{ hit: true, frame }\` if present, else \`{ hit: false }\`.\n2. \`effectiveAccessTime(hitRatio, tlbTime, memTime)\`: a hit costs \`tlbTime + memTime\`; a miss costs \`tlbTime + 2 * memTime\` (TLB, then page table in memory, then the data). Return \`hitRatio * (tlbTime + memTime) + (1 - hitRatio) * (tlbTime + 2 * memTime)\`, rounded to 2 decimals.`,
      hints: ['A TLB hit avoids the page-table memory access.', 'Weight hit and miss costs by the hit ratio.'],
      starter: `// ${m.host}: TLB\nfunction lookup(tlb, page) {\n}\n\nfunction effectiveAccessTime(hitRatio, tlbTime, memTime) {\n}\n`,
      checks: [
        fn('lookup hits and misses', 'lookup', [
          { args: [{ 2: 7 }, 2], expected: { hit: true, frame: 7 } },
          { args: [{ 2: 7 }, 3], expected: { hit: false } },
        ]),
        fn('effectiveAccessTime weights hit and miss', 'effectiveAccessTime', [
          { args: [1, 1, 100], expected: 101 },
          { args: [0, 1, 100], expected: 201 },
          { args: [0.8, 1, 100], expected: 121 },
        ]),
      ],
      solution: `function lookup(tlb, page) {\n  return Object.prototype.hasOwnProperty.call(tlb, page) ? { hit: true, frame: tlb[page] } : { hit: false };\n}\nfunction effectiveAccessTime(hitRatio, tlbTime, memTime) {\n  const hit = tlbTime + memTime;\n  const miss = tlbTime + 2 * memTime;\n  return Math.round((hitRatio * hit + (1 - hitRatio) * miss) * 100) / 100;\n}`,
      realityNote: 'The TLB caches recent translations so most accesses skip the page-table walk; a high hit ratio is what makes paged memory fast despite the extra indirection.',
    });
  }),
  tmpl(4, 3, 'advanced', 'multilevel-page-table', 'Walk a two-level page table', 'E1', 25, 'Split a page number into directory and table indices and walk two levels.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Two-level page tables\n\nOn **${m.host}**, a page number splits into an outer (directory) index and an inner (table) index of \`innerBits\` each. Write:\n\n1. \`split(pageNumber, innerBits)\`: return \`{ dir: pageNumber >> innerBits, idx: pageNumber & ((1 << innerBits) - 1) }\`.\n2. \`walk(pageNumber, innerBits, directory)\`: \`directory\` maps a \`dir\` index to an inner table (object idx→frame), or is missing. Return the frame, or \`null\` if the directory entry or the inner entry is absent (a page fault).`,
      hints: ['The outer index is the high bits, the inner index the low innerBits.', 'A missing directory or inner entry is a fault.'],
      starter: `// ${m.host}: two-level page table\nfunction split(pageNumber, innerBits) {\n}\n\nfunction walk(pageNumber, innerBits, directory) {\n}\n`,
      checks: [
        fn('split separates the indices', 'split', [
          { args: [5, 2], expected: { dir: 1, idx: 1 } },
          { args: [0, 2], expected: { dir: 0, idx: 0 } },
          { args: [11, 2], expected: { dir: 2, idx: 3 } },
        ]),
        fn('walk resolves or faults', 'walk', [
          { args: [5, 2, { 1: { 1: 9 } }], expected: 9 },
          { args: [5, 2, { 1: { 0: 9 } }], expected: null },
          { args: [5, 2, {}], expected: null },
        ]),
      ],
      solution: `function split(pageNumber, innerBits) {\n  return { dir: pageNumber >> innerBits, idx: pageNumber & ((1 << innerBits) - 1) };\n}\nfunction walk(pageNumber, innerBits, directory) {\n  const { dir, idx } = split(pageNumber, innerBits);\n  const inner = directory[dir];\n  if (!inner || !Object.prototype.hasOwnProperty.call(inner, idx)) return null;\n  return inner[idx];\n}`,
      realityNote: 'Multi-level page tables save space by not allocating inner tables for unused regions; the MMU walks each level, which is why the TLB matters so much for speed.',
    });
  }),

  /* ------------------------------------------------------------------ 4.4 virtual memory and replacement */
  tmpl(4, 4, 'beginner', 'fifo-replacement', 'Replace pages with FIFO', 'E1', 25, 'Simulate FIFO page replacement and count page faults.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## FIFO page replacement\n\nOn **${m.host}**, with a fixed number of frames, FIFO evicts the page that has been in memory longest. Write \`fifo(references, frames)\` returning \`{ faults, finalFrames }\`:\n\n- process each page in \`references\`; a page already resident is a hit;\n- a miss is a fault: if there is a free frame, load it; otherwise evict the oldest-loaded page and load the new one;\n- \`finalFrames\` is the set of resident pages in load order (oldest first) at the end.`,
      hints: ['Keep a queue of resident pages in load order.', 'On a miss when full, shift out the front and push the new page.'],
      starter: `// ${m.host}: FIFO replacement\nfunction fifo(references, frames) {\n}\n`,
      checks: [
        fn('fifo counts faults', 'fifo', [
          { args: [[1, 2, 3, 4, 1, 2, 5], 3], expected: { faults: 7, finalFrames: [1, 2, 5] } },
          { args: [[1, 1, 1], 2], expected: { faults: 1, finalFrames: [1] } },
          { args: [[1, 2, 3, 1, 2, 3], 3], expected: { faults: 3, finalFrames: [1, 2, 3] } },
        ]),
      ],
      solution: `function fifo(references, frames) {\n  const resident = [];\n  let faults = 0;\n  for (const page of references) {\n    if (resident.includes(page)) continue;\n    faults++;\n    if (resident.length >= frames) resident.shift();\n    resident.push(page);\n  }\n  return { faults, finalFrames: resident };\n}`,
      realityNote: 'FIFO is simple but can suffer Belady\'s anomaly — more frames occasionally causing more faults; it is the baseline that smarter policies improve on.',
    });
  }),
  tmpl(4, 4, 'intermediate', 'lru-replacement', 'Replace pages with LRU', 'E1', 30, 'Simulate least-recently-used replacement and count page faults.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## LRU page replacement\n\nOn **${m.host}**, LRU evicts the page that was used least recently. Write \`lru(references, frames)\` returning \`{ faults, finalFrames }\`:\n\n- a hit updates recency (that page becomes most-recently-used);\n- a miss is a fault; when full, evict the least-recently-used page;\n- \`finalFrames\` lists resident pages from **least** to **most** recently used.`,
      hints: ['Maintain a list ordered least→most recently used.', 'On any access (hit or load), move the page to the most-recent end.'],
      starter: `// ${m.host}: LRU replacement\nfunction lru(references, frames) {\n}\n`,
      checks: [
        fn('lru counts faults', 'lru', [
          { args: [[1, 2, 3, 4, 1, 2, 5], 3], expected: { faults: 7, finalFrames: [1, 2, 5] } },
          { args: [[1, 2, 1, 3, 2], 2], expected: { faults: 4, finalFrames: [3, 2] } },
          { args: [[1, 2, 3, 1, 2, 3], 3], expected: { faults: 3, finalFrames: [1, 2, 3] } },
        ]),
      ],
      solution: `function lru(references, frames) {\n  const order = [];\n  let faults = 0;\n  for (const page of references) {\n    const at = order.indexOf(page);\n    if (at !== -1) {\n      order.splice(at, 1);\n      order.push(page);\n      continue;\n    }\n    faults++;\n    if (order.length >= frames) order.shift();\n    order.push(page);\n  }\n  return { faults, finalFrames: order };\n}`,
      realityNote: 'LRU approximates the optimal policy well because recently-used pages tend to be used again (locality); real systems approximate it cheaply with reference bits (the clock algorithm).',
    });
  }),
  tmpl(4, 4, 'advanced', 'optimal-and-working-set', 'Compute optimal faults and the working set', 'E1', 30, 'Simulate Belady\'s optimal replacement and compute a working-set size.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Optimal replacement and the working set\n\nOn **${m.host}**, write:\n\n1. \`optimal(references, frames)\`: Belady\'s optimal — on a fault when full, evict the resident page whose **next use is farthest in the future** (a page never used again is evicted first). Return the fault count.\n2. \`workingSet(references, index, window)\`: the set of distinct pages referenced in the window of the \`window\` references ending at position \`index\` (inclusive). Return the count of distinct pages. Clamp the window start at 0.`,
      hints: ['For optimal, for each resident page find the distance to its next use; evict the farthest (or never-used).', 'The working set is the distinct pages in the recent window.'],
      starter: `// ${m.host}: optimal and working set\nfunction optimal(references, frames) {\n}\n\nfunction workingSet(references, index, window) {\n}\n`,
      checks: [
        fn('optimal counts faults', 'optimal', [
          { args: [[1, 2, 3, 4, 1, 2, 5], 3], expected: 5 },
          { args: [[1, 2, 3, 1, 2, 3], 3], expected: 3 },
          { args: [[7, 0, 1, 2, 0, 3, 0, 4], 3], expected: 6 },
        ]),
        fn('workingSet counts distinct pages in the window', 'workingSet', [
          { args: [[1, 2, 3, 2, 1], 4, 3], expected: 3 },
          { args: [[1, 2, 3, 4, 5], 4, 3], expected: 3 },
          { args: [[1, 1, 1], 2, 5], expected: 1 },
        ]),
      ],
      solution: `function optimal(references, frames) {\n  const resident = [];\n  let faults = 0;\n  for (let i = 0; i < references.length; i++) {\n    const page = references[i];\n    if (resident.includes(page)) continue;\n    faults++;\n    if (resident.length < frames) { resident.push(page); continue; }\n    let evict = 0, farthest = -1;\n    for (let r = 0; r < resident.length; r++) {\n      let next = references.indexOf(resident[r], i + 1);\n      if (next === -1) { evict = r; break; }\n      if (next > farthest) { farthest = next; evict = r; }\n    }\n    resident[evict] = page;\n  }\n  return faults;\n}\nfunction workingSet(references, index, window) {\n  const start = Math.max(0, index - window + 1);\n  return new Set(references.slice(start, index + 1)).size;\n}`,
      realityNote: 'Belady\'s optimal (evict the page used farthest in the future) is unbeatable but needs the future; the working-set model estimates how much memory a process needs from its recent references.',
    });
  }),

  /* ------------------------------------------------------------------ 4.5 demand paging mechanics */
  tmpl(4, 5, 'beginner', 'page-fault-cost', 'Compute effective access time with faults', 'E1', 20, 'Weigh memory access against the heavy cost of a page fault.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## The cost of a page fault\n\nOn **${m.host}**, a page fault is enormously slower than a memory access. Write \`effectiveAccessTime(faultRate, memTime, faultTime)\`: a hit costs \`memTime\`, a fault costs \`faultTime\`. Return \`(1 - faultRate) * memTime + faultRate * faultTime\`, rounded to 2 decimals.\n\nAlso \`maxFaultRate(memTime, faultTime, budget)\`: the largest fault rate that keeps the effective time \`<= budget\`, solved from the formula: \`(budget - memTime) / (faultTime - memTime)\`, rounded to 8 decimals (return 0 if that is negative).`,
      hints: ['Even a tiny fault rate dominates because faults are so slow.', 'Invert the EAT formula for the maximum tolerable fault rate.'],
      starter: `// ${m.host}: page-fault cost\nfunction effectiveAccessTime(faultRate, memTime, faultTime) {\n}\n\nfunction maxFaultRate(memTime, faultTime, budget) {\n}\n`,
      checks: [
        fn('effectiveAccessTime weights faults', 'effectiveAccessTime', [
          { args: [0, 100, 8000000], expected: 100 },
          { args: [0.001, 100, 8000000], expected: 8099.9 },
        ]),
        fn('maxFaultRate inverts the formula', 'maxFaultRate', [
          { args: [100, 8000000, 200], expected: 0.0000125 },
          { args: [100, 8000000, 50], expected: 0 },
        ]),
      ],
      solution: `function effectiveAccessTime(faultRate, memTime, faultTime) {\n  return Math.round(((1 - faultRate) * memTime + faultRate * faultTime) * 100) / 100;\n}\nfunction maxFaultRate(memTime, faultTime, budget) {\n  const r = (budget - memTime) / (faultTime - memTime);\n  return r < 0 ? 0 : Math.round(r * 100000000) / 100000000;\n}`,
      realityNote: 'A page fault (disk) is tens of thousands of times slower than RAM, so even a 0.1% fault rate can dominate access time — which is why keeping the working set in memory matters.',
    });
  }),
  tmpl(4, 5, 'intermediate', 'copy-on-write', 'Model copy-on-write after fork', 'E1', 20, 'Share pages read-only after fork and copy only on the first write.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Copy-on-write\n\nAfter \`fork\` on **${m.host}**, parent and child share pages read-only; a page is copied only when one writes. Model a page as \`{ id, shared, copies }\`. Write:\n\n1. \`onWrite(page)\`: if \`page.shared\`, return a **new, private** copy \`{ id: page.id, shared: false, copies: 1 }\` (the writer gets its own); if not shared, return the page unchanged.\n2. \`pagesCopied(writes)\`: \`writes\` is an array of booleans (\`shared\` at the moment of each write). Return how many writes actually triggered a copy (the shared ones).`,
      hints: ['A write to a shared page triggers a private copy.', 'Writes to already-private pages copy nothing.'],
      starter: `// ${m.host}: copy-on-write\nfunction onWrite(page) {\n}\n\nfunction pagesCopied(writes) {\n}\n`,
      checks: [
        fn('onWrite copies shared pages', 'onWrite', [
          { args: [{ id: 5, shared: true, copies: 2 }], expected: { id: 5, shared: false, copies: 1 } },
          { args: [{ id: 5, shared: false, copies: 1 }], expected: { id: 5, shared: false, copies: 1 } },
        ]),
        fn('pagesCopied counts the copies', 'pagesCopied', [
          { args: [[true, false, true]], expected: 2 },
          { args: [[false, false]], expected: 0 },
        ]),
      ],
      solution: `function onWrite(page) {\n  if (page.shared) return { id: page.id, shared: false, copies: 1 };\n  return page;\n}\nfunction pagesCopied(writes) {\n  return writes.filter(Boolean).length;\n}`,
      realityNote: 'Copy-on-write makes fork cheap: parent and child share pages until one writes, so a fork followed by exec copies almost nothing.',
    });
  }),
  tmpl(4, 5, 'advanced', 'thrashing', 'Detect thrashing from the fault rate', 'E1', 25, 'Decide when a system is thrashing and how many processes memory can support.', (v) => {
    const m = machineOf(v);
    return js({
      instructions: `## Thrashing\n\nOn **${m.host}**, thrashing is when processes spend more time paging than computing. Write:\n\n1. \`isThrashing(cpuUtil, pagingUtil)\`: return \`true\` when \`pagingUtil > cpuUtil\` **and** \`cpuUtil < 0.5\` (CPU low because everyone waits on paging).\n2. \`maxProcesses(totalFrames, workingSetPerProcess)\`: the most processes whose working sets fit without thrashing is \`Math.floor(totalFrames / workingSetPerProcess)\` (at least 0).\n3. \`admit(totalFrames, inUseFrames, workingSet)\`: return \`true\` only if a new process\'s \`workingSet\` fits in the free frames (\`totalFrames - inUseFrames >= workingSet\`).`,
      hints: ['Thrashing: low CPU use with high paging.', 'Admit a process only if its working set fits in free memory.'],
      starter: `// ${m.host}: thrashing\nfunction isThrashing(cpuUtil, pagingUtil) {\n}\n\nfunction maxProcesses(totalFrames, workingSetPerProcess) {\n}\n\nfunction admit(totalFrames, inUseFrames, workingSet) {\n}\n`,
      checks: [
        fn('isThrashing detects the condition', 'isThrashing', [
          { args: [0.2, 0.9], expected: true },
          { args: [0.8, 0.1], expected: false },
          { args: [0.6, 0.9], expected: false },
        ]),
        fn('maxProcesses fits working sets', 'maxProcesses', [
          { args: [100, 20], expected: 5 }, { args: [100, 30], expected: 3 }, { args: [10, 20], expected: 0 },
        ]),
        fn('admit checks free frames', 'admit', [
          { args: [100, 80, 15], expected: true }, { args: [100, 90, 15], expected: false },
        ]),
      ],
      solution: `function isThrashing(cpuUtil, pagingUtil) {\n  return pagingUtil > cpuUtil && cpuUtil < 0.5;\n}\nfunction maxProcesses(totalFrames, workingSetPerProcess) {\n  return Math.max(0, Math.floor(totalFrames / workingSetPerProcess));\n}\nfunction admit(totalFrames, inUseFrames, workingSet) {\n  return totalFrames - inUseFrames >= workingSet;\n}`,
      realityNote: 'Thrashing shows as plunging CPU use with soaring paging; the working-set model and admission control keep the sum of working sets under physical memory to avoid it.',
    });
  }),
];
