# Project Blueprint — CS Virtual Lab

*Working title. Alternatives to decide later: "SimuLab Africa", "OpenCS Lab", "PractiCS".*

---

## 1. Vision

> Every Computer Science student in Africa should be able to complete every practical in
> their degree using only a browser, even on a cheap phone and a 2G/3G connection.

The web app simulates the **practical component of all 38 Computer Science courses**
in the BTech Computer Science curriculum (Ho Technical University, GTEC 2022). Each
course becomes a set of interactive simulators and graded labs at three levels:

| Level | Who | How the lab behaves |
| --- | --- | --- |
| **Beginner** | First contact with the topic | Guided walkthrough. The simulator shows what to do, explains every state change, cannot be "broken". |
| **Intermediate** | Has done the lecture | Task-based. A goal is given, hints are available, the auto-grader checks the result. |
| **Advanced** | Preparing for exams, projects, industry | Open-ended challenge or scenario. Fewer constraints, realistic failure modes, performance or correctness scoring. |

The programme's own stated outcome (graduates should "build and validate simulation
models") makes the simulator a natural teaching tool, not a replacement for the lecturer.

## 2. Target users

1. **Students** of BTech Computer Science, HND Computer Science, ICT and Computer
   Engineering programmes in Ghana and the wider continent. Primary device: Android phone
   or a shared low-spec laptop. Internet: metered mobile data, often intermittent.
2. **Lecturers and lab technicians** who want to assign labs, see progress and reuse
   simulators in class on a projector.
3. **Self-learners** following the public syllabus without enrolment.

## 3. Design principles (non-negotiable)

1. **Everything is online, nothing is installed.** The whole platform, simulators
   included, is a hosted website. A student opens the address in any browser and the
   simulation runs inside that page. Python, JavaScript, SQL, PHP, R, circuits, networks
   and OS models execute in the browser (WebAssembly / JS) delivered from our servers;
   heavier runtimes such as C++ and Java compilation fall back to an online code-runner
   service we host. The backend stores accounts, progress, community and competition data.
   This keeps hosting cost low and lets a page keep working during a dropped connection.
2. **Mobile first, low data.** Every simulator must be usable on a 360px-wide screen.
   Heavy runtimes (Pyodide, webR) are downloaded once, cached by a service worker,
   and the UI warns before any download above 5 MB. A "Lite mode" hides animations.
3. **Resilient to dropped connections.** The site is a Progressive Web App: once a page
   has loaded, a lab keeps working if the connection drops, and results sync when it
   returns. This is a convenience for unreliable networks, not a separate offline
   product; the platform lives at one online address.
4. **Content-driven, engine-shared.** A small number of simulation *engines* power
   many *labs*. Labs are data (JSON + Markdown), not code, so lecturers can add labs.
5. **Honest simulation.** Where the real tool is a CLI (Linux, Cisco IOS, SQL, git),
   the simulator accepts the real syntax so skills transfer to real equipment.
6. **Auto-graded, always repeatable.** Every lab has a machine-checkable goal and
   unlimited attempts. Feedback is immediate and specific.
7. **Open source friendly.** Prefer MIT/Apache/BSD libraries. GPL components
   (e.g. Falstad CircuitJS) are embedded in an iframe boundary, never linked.
8. **Local context.** Examples use Ghanaian and African data, names, currencies,
   businesses and laws (e.g. Data Protection Act 843) wherever a scenario is needed.

## 4. Platform features

### 4.1 Learner experience
- Course catalogue organised exactly as the curriculum: Level 100–400, Semester 1–2.
- Each course page: outline topics → simulators → labs (B / I / A) → self-check quiz.
- Progress tracking, streaks, badges per course, printable completion certificate.
- Lab workspace layout: instructions panel, simulator canvas, console/output, hints.
- Saved workspaces (code, circuits, network diagrams) in the browser and synced to the
  account when online.
- Keyboard-only and screen-reader paths for all non-visual labs.

### 4.2 Instructor experience (Phase 4)
- Create a class, invite students by code, assign labs with deadlines.
- Live class view: who is stuck on which step.
- Lab editor: author a new lab from an existing simulator by filling a form.
- Export grades as CSV.

### 4.3 Assessment engine
- Each lab declares `checks`: assertions against simulator state (for example "host A can
  ping host B", "query returns these rows", "truth table matches", "average waiting
  time is at most 4.2").
- Code labs use unit tests run in the browser sandbox.
- Scenario labs use decision-tree scoring with explanations.

## 5. Simulation engines (the reusable core)

| ID | Engine | Powers | Implementation notes |
| --- | --- | --- | --- |
| **E1** | Code Runner | Principles of Programming, Python, C++, Java, Web I/II, DSA, Numerical Methods, Data Science, Adv. Java | Python: Pyodide (WASM). JS: sandboxed Web Worker. R: webR (WASM, stands in for "R and/or MATLAB"). PHP: php-wasm. C++: Emscripten-built clang in WASM for small programs, interpreter (JSCPP) for the beginner tier, optional server runner (Piston) as fallback. Java: CheerpJ or server runner. Editor: CodeMirror 6 (default, light), Monaco (desktop opt-in). |
| **E2** | Circuit Engine | Basic Electronics, Digital Logic Design, Computer Hardware (partly), IoT | Analog: nodal-analysis engine (own, MIT) or embedded Falstad CircuitJS1 (GPL, iframe). Digital: own canvas gate-level simulator with truth table, K-map, timing diagram and FSM views. |
| **E3** | Network Engine | Networking I & II, Systems Admin, Information Security, Cloud, IoT, Wireless | Discrete-event packet simulator in TypeScript: devices, links, ARP, IPv4, ICMP, TCP/UDP, DHCP, DNS, NAT, static/RIP/OSPF-lite routing, VLANs, ACLs, PPP, Frame Relay. Cisco-IOS-like CLI, packet inspector, topology canvas. |
| **E4** | Virtual Machine / Terminal | Systems Admin I & II, Operating Systems, Forensics, Cloud | xterm.js + simulated POSIX shell with in-memory filesystem, users/groups, permissions, processes, cron, packages, Apache, DNS (fast, fits on phones). Advanced tier optionally boots a real tiny Linux via v86. Windows Server / Active Directory: simulated Server Manager, Users and Computers, Group Policy UI. |
| **E5** | Database Engine | Database Systems, Web II, Data Mining & Warehousing, Data Science | SQLite WASM (sql.js) with a MySQL/Oracle compatibility layer for the syntax taught; ER diagram editor; normalisation checker; star-schema builder; query plan viewer. |
| **E6** | State Visualiser | DSA, Operating Systems, Computer Organisation & Architecture, AI, Discrete Maths | Generic "step through algorithm state" framework (play/pause/step/speed, variable watch, pseudo-code highlight). Specialisations: data structures, CPU/pipeline/cache, scheduling, paging, search trees, neural networks. |
| **E7** | Math Lab | Discrete Maths, Maths for CS, Calculus, Probability & Statistics, Numerical Methods, Wireless | Function plotter, matrix/vector tool, truth tables and logic proofs, set operations, graph theory canvas, Monte-Carlo sampler, SymPy via Pyodide for symbolic steps. |
| **E8** | Hardware Bench | Computer Hardware, Basic Electronics, IoT | 2D drag-and-drop PC assembly, BIOS/UEFI mock, fault diagnosis scenarios, cable/connector matching, multimeter tool. Arduino: avr8js (real AVR emulation) + Wokwi web components (MIT); Raspberry Pi: Python GPIO mock with virtual sensors/LEDs; MQTT broker simulation. |
| **E9** | Diagram Studio | Software Engineering, OOSAD, Database, IT Project Management, Networking | UML (use case, class, sequence, activity, state), DFD, ER, Gantt, CPM/PERT network. Built on React Flow (MIT); Mermaid text import/export. |
| **E10** | Scenario Engine | Legal & Ethical Issues, Forensics, Information Security, IT Project Management, Research Methods, Fundamentals of CS | Branching case studies with evidence items, decisions, consequences and rubric-based scoring. Authored in Markdown + YAML. |
| **E11** | Mobile Device Emulator | Mobile Application Development | Phone frame with a declarative screen builder (layouts, widgets, intents, lifecycle events), data storage mock, network/offline toggle, permission prompts. Not a full Android runtime. |
| **E12** | Cloud Console | Cloud Computing, IoT, Data Science | Simulated IaaS/PaaS console: regions, VMs, storage buckets, load balancer, autoscaling, pricing meter, failure injection, multitenancy demo. |

## 6. Architecture

```
┌──────────────────────────────── Browser (PWA) ────────────────────────────────┐
│  UI shell (course catalogue, lab workspace, progress)                         │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐  │
│  │ E1 Code  │ │ E2 Circ. │ │ E3 Netwk  │ │ E4 VM    │ │ E5 DB  │ │ E6..E12 │  │
│  └──────────┘ └──────────┘ └───────────┘ └──────────┘ └────────┘ └─────────┘  │
│  Lab runtime: loads lab spec → mounts engine → runs checks → reports result   │
│  Local store (IndexedDB): workspaces, progress queue, cached labs & runtimes  │
│  Service worker: offline packs, runtime cache (Pyodide, webR, sql.js, v86)    │
└───────────────────────────────────────┬───────────────────────────────────────┘
                                        │ HTTPS / JSON (only when online)
┌───────────────────────────────────────▼───────────────────────────────────────┐
│  API (small): auth, profiles, progress sync, classes, assignments, grades      │
│  Postgres                                                                     │
│  Static CDN: app bundle, lab content, WASM runtimes                            │
│  Optional: code-runner service (Docker, Piston) for C++/Java when WASM fails  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 6.1 Repository layout (monorepo)

```
apps/web                 React + TypeScript PWA (Vite), Tailwind, shadcn/ui
packages/engines/*       One package per engine (pure TS, no UI, unit-tested)
packages/lab-runtime     Lab spec loader, check runner, progress events
packages/ui              Shared components (workspace layout, console, hint panel)
content/courses/<code>/  Lab specs (JSON) + instructions (Markdown) per course
content/curriculum.json  Generated from data/curriculum.json
apps/api                 Node (Fastify) + Postgres; PGlite in development and tests
services/runner          Optional Piston deployment for server-side C++/Java (later)
```

### 6.2 Lab specification (data, not code)

```json
{
  "id": "bcsc201-subnetting-02",
  "course": "BCSC 201",
  "topic": "IPv4 Addressing and Subnetting",
  "level": "intermediate",
  "engine": "E3",
  "title": "Split 192.168.10.0/24 for four departments",
  "instructions": "lab.md",
  "initialState": "topology.json",
  "hints": ["Count hosts per department first", "Borrow 2 bits"],
  "checks": [
    { "type": "network.ping", "from": "HR-PC1", "to": "Finance-PC1", "expect": true },
    { "type": "network.subnetCount", "expect": 4 }
  ],
  "estimatedMinutes": 20
}
```

### 6.3 Technology stack (recommended)

| Layer | Choice | Reason |
| --- | --- | --- |
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, shadcn/ui | Fast, huge ecosystem, easy PWA, good mobile performance |
| State | Zustand + IndexedDB (Dexie) | Simple, offline-friendly |
| Canvas | Konva / plain Canvas 2D for engines; React Flow for diagrams; D3 for charts | Performance on low-end devices |
| Code editor | CodeMirror 6 (default), Monaco (desktop opt-in) | CodeMirror is far lighter and works on phones |
| Runtimes | Pyodide, webR, sql.js, php-wasm, avr8js, v86 (advanced only), xterm.js | All run in the browser |
| Backend | Node + Fastify API with Postgres 16 (apps/api); PGlite in development and tests | We own the data; standard tools; one process serves API and web |
| Hosting | One VPS (Hostinger) with docker compose: Postgres, app, Caddy for HTTPS | No third-party platform; predictable cost; simple backups |
| Testing | Vitest (engines), Playwright (labs end to end) | Engines must be provably correct |
| CI | GitHub Actions | Free for open source |

## 7. Roadmap

### Phase 0 — Foundations (weeks 1–3)
- Monorepo, design system, PWA shell, course catalogue from `curriculum.json`.
- Lab runtime + lab spec + check runner. One toy engine to prove the loop.
- Auth and progress sync through our own API.

### Phase 1 — Flagship MVP: Level 100 and early 200 (months 1–4)
Deliver the engines with the widest reach first, each with at least 6 labs (2 per level):
1. **E1 Code Runner (Python + JS)** → BCSC 101, 102, 209.
2. **E2 Digital Logic** → BCSC 105 (digital part), 205.
3. **E3 Network Engine (addressing, OSI, switching, basic routing)** → BCSC 201.
4. **E5 Database Engine (SQL + ER)** → BCSC 203.
5. **E6 Visualiser (lists, stacks, queues, sorting, searching)** → BCSC 202.
6. **E7 Math Lab (truth tables, sets, graphs, plots, Monte Carlo)** → BCSC 103, 104, 108.
Pilot with Level 100/200 students; collect usability and learning data.

### Phase 2 — Level 200 and 300 depth (months 5–8)
- E1: C++ and Java tiers; PHP + MySQL (BCSC 207, 212, 208).
- E3: VLANs, ACLs, DHCP/DNS, NAT, WAN/PPP/Frame Relay (BCSC 206).
- E4: Linux terminal and Windows Server/AD simulation (BCSC 210, 305).
- E6: CPU, pipeline, cache, microprogramming (BCSC 311).
- E9 + E10: UML/DFD/Gantt/CPM, requirements and PM scenarios (BCSC 301, 303, 307, 309).
- E7: numerical methods, calculus (BCSC 204, 211). E8: PC assembly (BCSC 106).

### Phase 3 — Level 400 and electives (months 9–12)
- E6: OS scheduling, paging, file systems, deadlock (BCSC 405).
- E3 + E4 + E10: security labs (crypto, firewalls, IDS, password policy, ethical-hacking range) (BCSC 401); forensic workbench (BCSC 403).
- E6 + E1: AI search, CSP, minimax, MDP, neural-net playground (BCSC 407); data science notebooks (BCSC 409, 406).
- E12 Cloud Console (BCSC 404). E8 Arduino/RPi + MQTT (BCSC 408). E11 Mobile emulator (BCSC 410). E7 wireless channel lab (BCSC 411). E1 Java GUI/servlets (BCSC 413). E10 law and ethics cases (BCSC 402).

### Phase 4 — Scale (months 12+)
- Instructor dashboard, lab authoring, class management.
- Offline course packs, low-data mode audit, localisation (French for francophone Africa).
- Open the lab format so other universities map their own curricula.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Scope is enormous (38 courses) | Engines are shared; labs are data. Ship by phase, never all at once. Count progress in labs, not courses. |
| WASM runtimes are large (Pyodide is 10 MB or more) | Lazy load, cache once, show download size, provide campus offline packs, offer a server runner fallback for very low-end devices. |
| C++/Java in browser is immature | Beginner tier uses interpreters; advanced tier uses an optional server runner; document the limitation. |
| Low-end Android performance | Canvas over DOM for simulators, Lite mode, performance budget: first lab interactive in under 5 s on a 2019 mid-range phone over 3G. |
| Licence conflicts (GPL simulators) | Embed via iframe or rebuild; keep an SPDX licence inventory. |
| Students treat simulation as the whole truth | Each lab ends with a "Where this differs from real equipment" note. |
| Sustainability after the thesis | Open-source the code, document the lab format, recruit departmental maintainers. |

## 9. Thesis evaluation plan

This folder lives under *THESIS*, so the platform doubles as a research instrument.

- **Research questions.** Does the simulator improve practical competence and confidence for students with limited hardware? Which engine types produce the largest gains? Is it usable on low-end devices and networks?
- **Design.** Quasi-experimental: pre-test / post-test with a control group using
  traditional labs for one or two Level 100/200 courses (for example BCSC 201 Networking I and
  BCSC 205 Digital Logic). Mixed methods: System Usability Scale, Technology
  Acceptance Model questionnaire, interviews, in-app analytics (time on task,
  attempts, hint usage).
- **Technical evaluation.** Load time and memory on three device classes; offline
  reliability; grader accuracy against lecturer marking.
- **Ethics.** Institutional approval, informed consent, anonymised analytics,
  compliance with Ghana's Data Protection Act 843.

## 10. Decisions made on 18 October 2026

1. **Course names, not codes.** The app identifies courses by name (URL slug). Institutional
   codes such as BCSC 205 live only in the source data as reference metadata.
2. **The catalogue is extensible.** It starts from the 38 HTU Computer Science courses and
   adds 15 common courses the HTU list lacks (Programming with C, Data Communications,
   Version Control and DevOps, Information Systems and E-Commerce, Assembly Language and
   Microprocessors, Theory of Computation, Embedded Systems, Computer Graphics,
   Human-Computer Interaction, Machine Learning, Cryptography and Network Security,
   Distributed Systems, Compiler Construction, Big Data and Parallel Computing, Blockchain
   and Distributed Ledgers). Courses are grouped by area with a suggested year.
3. **Top-university depth.** Each course gets a detailed syllabus (units, weeks, topics,
   outcomes) modelled on the corresponding courses at leading universities (MIT, Stanford,
   Berkeley, CMU and similar), stored in `data/syllabi/<slug>.json`. Digital Logic Design
   is the first; the rest follow.
4. **Hosted web application with our own backend.** The web app, a Node API and a
   Postgres database run together on a VPS (Hostinger) under docker compose, with no
   third-party platform service. Users are learners, institution students, lecturers and
   admins. The platform adds topic checks after every topic,
   tutorials, progress tracking, groups with chat, presence and resource sharing, a
   forum, direct messages, and general and group competitions with scores, contribution
   breakdowns and awards. Full detail in [03-PRODUCT-SPEC.md](03-PRODUCT-SPEC.md); design
   borrowed from leading platforms is analysed in [04-DESIGN-RESEARCH.md](04-DESIGN-RESEARCH.md).

## 11. Decisions still open

1. Product name and domain.
2. Whether to embed Falstad CircuitJS (GPL, mature) or build the analog engine.
3. Server-side code runner from day one, or browser-only until Phase 2.
4. Pilot course(s) for the thesis study.
