# Curriculum → Simulation Map

Source: BTech Computer Science curriculum, Ho Technical University (GTEC, March 2022).
Scope: the 38 **BCSC** courses (all Computer Science). The 10 **HOTU** institutional
courses (African Studies, Communication Skills, French, Entrepreneurship, Business
Development, Industrial Attachment, Project Work) are out of scope, except that
HOTU 104 Computer Applications could reuse the Fundamentals labs later.

Engine IDs (E1–E12) are defined in [01-BLUEPRINT.md](01-BLUEPRINT.md#5-simulation-engines-the-reusable-core).
T/P/C = Theory hours / Practical hours / Credits per week.

Legend for lab levels: **B** Beginner (guided), **I** Intermediate (task + hints), **A** Advanced (challenge / scenario).

---

## Level 100 — Semester 1

### BCSC 101 Principles of Programming (2/2/3) — Engines E1, E6
Simulators: Flowchart builder that executes; pseudo-code interpreter; block-to-text code bridge; debugger with variable watch.
- **B** Build a flowchart for "find the largest of three numbers" and run it step by step.
- **B** Trace variables through if/else, while, for loops with the visual debugger.
- **I** Convert a given flowchart to pseudo-code then to Python; tests must pass.
- **I** Fix five deliberately broken programs (syntax, logic, runtime errors).
- **A** Design an algorithm for a mobile-money fee calculator with nested conditions and loops; graded by hidden tests.
- **A** Low-level vs high-level: watch the same program as pseudo-assembly in the CPU visualiser (bridge to BCSC 311).

### BCSC 103 Discrete Mathematics (3/0/3) — Engine E7
Simulators: Set-operation Venn tool; number-base converter with carry animation; truth-table and logic-equivalence checker; relation/function property tester; induction proof scaffold; graph theory canvas; Boolean algebra simplifier.
- **B** Build sets, see union/intersection/complement update live; convert between binary, octal, decimal, hex.
- **B** Fill a truth table for a compound proposition; the tool marks each row.
- **I** Decide whether a relation is reflexive/symmetric/transitive by drawing its digraph.
- **I** Find an Euler path, shortest path and minimum spanning tree on a map of Volta Region towns.
- **A** Prove a summation formula by induction with the guided proof checker.
- **A** Minimise a Boolean expression with laws, then verify it against the K-map engine (bridge to BCSC 205).

### BCSC 105 Basic Electronics (2/2/3) — Engines E2, E8, E7
Simulators: Analog circuit bench (resistors, capacitors, inductors, diodes, Zener, BJT, sources, oscilloscope, multimeter); diode and transistor curve tracer; rectifier and filter designer; logic-gate bench with diodes; signal viewer (time and frequency domain).
- **B** Measure voltage and current in series and parallel RLC circuits with the virtual multimeter.
- **B** Forward- and reverse-bias a diode and read its V-I curve; test a diode "with the multimeter".
- **I** Build half-wave, full-wave and bridge rectifiers; add RC/LC filters and read ripple on the oscilloscope.
- **I** Bias a BJT (base, emitter-feedback, voltage-divider) and locate the Q point on the load line.
- **A** Design a regulated 5 V supply from a 12 V AC source meeting a ripple spec; read a virtual datasheet.
- **A** Build AND/OR gates from diodes, then compare RTL/DTL/TTL/CMOS switching behaviour; classify signals (even/odd/periodic/energy/power).

### BCSC 107 Fundamentals of Computer Science (2/0/2) — Engines E8, E10, E3
Simulators: Explorable computer (click components to see role); file-system explorer; mini network/internet explainer; safety and ethics scenarios.
- **B** Tour a PC: identify CPU, RAM, storage, I/O; follow an instruction from keyboard to screen.
- **B** Organise files and folders, see file types, sizes, extensions and paths.
- **I** Trace a web request from a phone in Ho to a server abroad (DNS, IP, routers).
- **I** Build a tiny database of students and query it (bridge to BCSC 203).
- **A** Respond to a phishing/malware scenario and a data-loss scenario; decide backup and safety actions.
- **A** Technology-and-society case: analyse the impact of mobile money on a market community.

## Level 100 — Semester 2

### BCSC 102 Introduction to Python (1/4/3) — Engine E1 (Pyodide), E6
Simulators: In-browser Python IDE with REPL, file I/O sandbox, turtle/canvas graphics, image processing on sample images, simulated client/server sockets, GUI builder (Tkinter-like widgets rendered in HTML), event visualiser.
- **B** Variables, types and string methods in the REPL with instant feedback.
- **B** Lists and dictionaries: build a class register and print statistics.
- **I** Read a CSV of WAEC-style results from the sandbox file system and compute grades.
- **I** Write a class hierarchy (Account → SavingsAccount) with tests.
- **A** Image processing: grayscale, threshold and edge-detect a photo pixel by pixel.
- **A** Build an event-driven GUI calculator and a simulated chat client/server pair.

### BCSC 104 Mathematics for Computer Science (3/0/3) — Engine E7, E1 (webR / Pyodide)
Simulators: Partial-fraction decomposer with steps; limit explorer; exponential and log plotter; 2D/3D vector and matrix transformer; R/Python notebook.
- **B** Plot functions, zoom toward a limit, see continuity breaks.
- **B** Add, scale and dot vectors on a canvas.
- **I** Apply matrices as linear transformations to shapes; find inverses and determinants.
- **I** Decompose rational functions into partial fractions, checked symbolically.
- **A** Solve a system of equations in R and Python and compare with the manual method.
- **A** Model exponential growth of mobile subscribers in Ghana with log-scale fitting.

### BCSC 106 Computer Hardware (1/4/3) — Engine E8
Simulators: Drag-and-drop PC assembly; BIOS/UEFI mock; cable and connector matcher; power-supply calculator; laptop teardown; printer setup wizard; OS installation simulator; fault-diagnosis scenarios.
- **B** Assemble a desktop: CPU, cooler, RAM, storage, PSU, GPU, cables; the bench rejects wrong slots.
- **B** Identify connectors (SATA, USB-C, HDMI, RJ-45, M.2) by picture and purpose.
- **I** Configure BIOS: boot order, SATA mode, virtualisation, secure boot, then install an OS.
- **I** Size a power supply for a given build; choose compatible RAM and storage.
- **A** Diagnose "no POST", "random reboots", "no display" and "printer offline" cases from symptoms and tools.
- **A** Upgrade a laptop (RAM, SSD, battery) following a service manual with ESD precautions.

### BCSC 108 Probability and Statistics (3/0/3) — Engine E7, E1 (webR)
Simulators: Dice/coin/card samplers; distribution explorer (binomial, Poisson, normal, exponential, uniform); moment and MGF viewer; joint distribution heat map; R notebook with simulation templates.
- **B** Roll dice thousands of times and watch the empirical distribution approach theory.
- **B** Describe a data set: mean, median, variance, histograms, box plots.
- **I** Fit a Poisson model to daily tro-tro arrivals; compare with simulation in R.
- **I** Explore the Central Limit Theorem by sampling means.
- **A** Monte-Carlo estimate of a probability with confidence intervals; justify sample size.
- **A** Joint distributions: compute marginals, conditionals and covariance from a simulated data set.

## Level 200 — Semester 1

### BCSC 201 Computer Networking I (1/4/3) — Engine E3, E8
Simulators: Topology builder (PCs, switches, routers, APs, cables); OSI/TCP-IP layer inspector that shows a packet being encapsulated; IPv4 and subnet calculator with binary view; cabling bench (straight-through vs crossover, wiring standards); wireless planner; device CLI; simple firewall.
- **B** Connect two PCs through a switch, assign IPs, ping, and watch frames hop by hop.
- **B** Walk a packet through the 7 OSI layers and the 4 TCP/IP layers.
- **I** Subnet a /24 for four departments and verify connectivity.
- **I** Wire a small office: choose cable types, crimp order (T568A/B), place an access point.
- **A** Design a campus LAN for 300 users with VLSM, redundant switches and management addressing.
- **A** Troubleshoot a broken network (wrong mask, duplicate IP, bad cable, DNS down) with ping, traceroute, ipconfig and the packet inspector.

### BCSC 203 Database Systems and Design (2/2/3) — Engine E5, E9
Simulators: ER diagram editor that generates DDL; normalisation workbench (functional dependencies → 1NF/2NF/3NF/BCNF); SQL console on sql.js with MySQL/Oracle-style syntax; result-set diff grader; "install and configure DBMS" wizard mock.
- **B** SELECT, WHERE, ORDER BY on a students table; the grader diffs your rows.
- **B** Draw an ER model for a clinic; see the tables appear.
- **I** Joins and subqueries across students, courses, lecturers and results.
- **I** Normalise an un-normalised sales sheet to 3NF, checked by the FD engine.
- **A** Design, create and populate a full schema for a market-trader credit union; write reports with GROUP BY, HAVING and set operators.
- **A** Install/configure wizard: users, privileges, backups, then audit who can read salaries.

### BCSC 205 Digital Logic Design (2/2/3) — Engine E2 (digital), E6
Simulators: Gate-level canvas with live truth table; K-map and Quine-McCluskey solver with step-by-step; combinational blocks (adders, multiplexers, decoders, comparators); flip-flop and latch timing simulator; counter and shift-register designer; FSM designer; ROM/RAM/PLA/PAL programmer.
- **B** Build AND/OR/NOT/NAND/NOR/XOR circuits and read truth tables; convert numbers and codes (BCD, Gray).
- **B** Toggle inputs on an SR, D, JK and T flip-flop and watch outputs on the timing diagram.
- **I** Minimise a 4-variable function with the K-map and implement it with NAND only.
- **I** Build a 4-bit ripple-carry adder and a 4-to-1 multiplexer from gates; verify all inputs.
- **A** Design a synchronous mod-6 counter and a traffic-light FSM; the grader runs the clock.
- **A** Implement a 2-bit multiplier using a ROM, then a PLA; compare cost.

### BCSC 207 Programming with C++ (1/4/3) — Engine E1 (C++ WASM/interpreter), E6
Simulators: C++ IDE with compiler diagnostics explained in plain English; memory and pointer visualiser (stack, heap, addresses); array bounds watcher; class diagram from code.
- **B** Compile and run "hello", variables, expressions, I/O; fix the error messages the compiler prints.
- **B** Functions and pass-by-value vs pass-by-reference shown in the memory view.
- **I** Arrays and strings: implement search, reverse and frequency count with tests.
- **I** Pointers: watch addresses as you dereference; find the dangling pointer.
- **A** Classes with constructors, destructors and dynamic memory for a stock-inventory system.
- **A** Debug a crashing program using the simulated debugger (breakpoints, watch, step).

### BCSC 209 Web Application Programming I (1/4/3) — Engine E1 (HTML/CSS/JS live editor)
Simulators: Three-pane live editor with device-size preview; DOM tree inspector; CSS box-model visualiser; form validator; responsive breakpoints tester; media embed sandbox.
- **B** Structure a page with headings, lists, tables, links and images; see the DOM tree.
- **B** Style with CSS: colours, fonts, box model, flexbox playground.
- **I** Build a registration form with validation and accessible labels.
- **I** Make a page responsive across phone/tablet/desktop breakpoints.
- **A** Build a complete small-business website (home, products, contact) with JavaScript interactivity.
- **A** Add audio/video media and a dynamic image gallery; pass a Lighthouse-style audit.

### BCSC 211 Calculus (2/2/3) — Engine E7, E1 (webR / Pyodide)
Simulators: Derivative and tangent explorer; Riemann sum and numerical integration visualiser; solids-of-revolution 3D viewer; partial-derivative surface plot; first-order ODE slope field and solver.
- **B** Drag a point along a curve and watch slope, tangent and derivative plot.
- **B** Approximate area with rectangles, trapezia and Simpson; compare to exact.
- **I** Find maxima/minima and centre of curvature for a given function with step checks.
- **I** Revolve a curve and compute volume and centre of gravity.
- **A** Solve a cooling / radioactive decay ODE numerically and analytically in R; compare.
- **A** Partial differentiation and double integrals on a 3D surface for a volume problem.

## Level 200 — Semester 2

### BCSC 202 Data Structures and Algorithms (2/2/3) — Engines E6, E1 (C++)
Simulators: Data-structure visualiser (array, linked list, stack, queue, hash table, BST, AVL, heap, graph); algorithm animator (sorting, searching, traversal, Dijkstra, BFS/DFS); recursion tree viewer; complexity plotter comparing measured operations vs n.
- **B** Push/pop/enqueue/dequeue and watch pointers move; insert into a linked list.
- **B** Animate bubble, selection and insertion sort; count comparisons.
- **I** Implement a stack and queue in C++ against the provided tests.
- **I** Build a BST, then watch rotations in an AVL; hash with collisions resolved by chaining and probing.
- **A** Implement Dijkstra over a map of Ghana's regional capitals; compare with BFS.
- **A** Solve one problem with greedy, divide-and-conquer, dynamic programming and backtracking; the plotter shows measured growth.

### BCSC 204 Numerical Methods and Computation (3/0/3) — Engines E7, E1
Simulators: Root finders (bisection, Newton, secant) with iteration table; linear systems (Gaussian elimination, LU, Jacobi, Gauss-Seidel) with step view; interpolation and curve fitting; numerical integration/differentiation; ODE solvers (Euler, RK4) with error plot; floating-point error demo.
- **B** Watch bisection shrink an interval; see round-off error accumulate.
- **B** Fit a line to data points and read the residuals.
- **I** Solve a 4×4 system by Gaussian elimination step by step; compare with Jacobi iterations.
- **I** Interpolate rainfall data with Lagrange and Newton polynomials.
- **A** Implement RK4 in Python for a population model and compare with Euler at several step sizes.
- **A** Estimate eigenvalues by the power method; present an independent mini-project notebook.

### BCSC 206 Computer Networking II (2/2/3) — Engine E3
Simulators: Router/switch CLI (IOS-like); routing-table viewer; VLAN and trunk designer; ACL tester; DHCP and DNS servers; WAN links (PPP, Frame Relay); NAT translator with table view; QoS and bandwidth meter.
- **B** Configure a router interface and a static route; ping across two LANs.
- **B** Create two VLANs on a switch and see broadcast isolation.
- **I** Configure inter-VLAN routing with a trunk; add a DHCP server and DNS.
- **I** Write standard and extended ACLs to block Telnet but allow HTTP; test with the packet inspector.
- **A** Connect two branch offices over PPP and Frame Relay; configure NAT overload for internet access.
- **A** Optimise a WAN: measure bandwidth, prioritise VoIP, and prove improved response time.

### BCSC 208 Web Application Programming II (2/2/3) — Engines E1 (php-wasm), E5
Simulators: PHP + MySQL (sql.js) sandbox with simulated web server, request/response inspector, sessions and cookies viewer, SQL-injection demonstrator (safe), hosting/deployment wizard mock.
- **B** Echo, variables, arrays and includes; see the HTTP response headers.
- **B** Handle a form with GET and POST; redirect with headers.
- **I** Connect to MySQL and implement CRUD for a products table with prepared statements.
- **I** Validate and sanitise input; break an insecure form with injection, then fix it.
- **A** Build a user registration and login system with hashed passwords and sessions.
- **A** Develop a small content management system end to end; deploy through the hosting wizard.

### BCSC 210 Systems Administration I (2/2/3) — Engine E4 (Windows Server simulation), E3
Simulators: Windows Server installer mock; Server Manager, Active Directory Users and Computers, Group Policy Editor, DNS Manager, File and Print sharing dialogs; PowerShell console with a supported command subset; performance monitor.
- **B** Install Windows Server, name it, set a static IP, join to a domain.
- **B** Create users, groups and organisational units.
- **I** Design an AD structure for a university (OUs by faculty), delegate control, set password policy via GPO.
- **I** Share folders and printers with NTFS and share permissions; test as different users.
- **A** Configure DNS zones for AD, add a second domain controller, and recover from a failed DC.
- **A** Diagnose slow logons with Performance Monitor and event logs; apply a fix.

### BCSC 212 Software Development with Java (1/4/3) — Engine E1 (Java), E6
Simulators: Java IDE with compile errors explained; object and reference visualiser; exception flow viewer; file I/O sandbox; class diagram sync.
- **B** Compile and run; variables, methods, conditionals, loops with tests.
- **B** Create objects, watch references and the heap.
- **I** Encapsulation, inheritance and polymorphism for a Shape hierarchy and a Payroll system.
- **I** Exceptions: handle, propagate and define custom exceptions; see the stack unwind.
- **A** Read and write files to build a simple grade-book with collections.
- **A** Multithreaded producer/consumer demo and a mini socket client/server (bridge to BCSC 413).

## Level 300 — Semester 1

### BCSC 301 Software Engineering (2/2/3) — Engines E9, E10, E1
Simulators: Process-model simulator (waterfall, incremental, spiral, agile sprints with simulated change requests); requirements workbench (elicit → classify → SRS); UML studio; test-case designer and coverage visualiser; maintenance scenario.
- **B** Run a small project through waterfall and agile; compare delivery under changing requirements.
- **B** Classify requirements as functional/non-functional; spot ambiguities.
- **I** Write an SRS for a hostel-booking system; the rubric checks completeness and testability.
- **I** Model it with use-case, class and sequence diagrams; the studio flags inconsistencies.
- **A** Design black-box and white-box tests for provided code; reach a coverage target.
- **A** Maintain a legacy module: triage bugs, estimate, refactor, regression-test.

### BCSC 303 IT Project Management (2/2/3) — Engines E9, E10
Simulators: Project charter and scope builder; WBS tree; Gantt with dependencies; CPM/PERT network with critical path and slack; cost estimation and earned-value calculator; risk register with probability-impact matrix; stakeholder map; simulated project run with random events.
- **B** Build a WBS and Gantt for a campus Wi-Fi rollout.
- **B** Identify stakeholders and plan communications.
- **I** Compute critical path, slack and PERT expected durations; crash the schedule.
- **I** Track earned value (PV, EV, AC, CPI, SPI) across simulated weeks.
- **A** Run a full project simulation: respond to scope creep, resource loss and vendor delays; score by time, cost, quality.
- **A** Build a risk register and quality plan for a national e-health deployment.

### BCSC 305 Systems Administration II (1/4/3) — Engine E4 (Linux terminal), E3
Simulators: Linux installer with partitioning and dual-boot; simulated shell (bash subset with real syntax); editors (nano, vi basics); users/groups/permissions/ACLs; package manager (zypper/apt mock); cron; backup and restore; Apache and BIND configuration; SSH between simulated hosts. Advanced tier may boot a real tiny Linux via v86.
- **B** Navigate and manage files and directories; read man pages; use pipes and redirection.
- **B** Create and edit files in nano and vi; view with cat, less, head, tail, grep.
- **I** Install Linux with a custom partition scheme; manage users, groups and permissions including ACLs.
- **I** Write shell scripts to automate backups with tar and cron; restore a deleted directory.
- **A** Install and configure Apache with virtual hosts and a DNS zone; troubleshoot a broken service from logs.
- **A** Harden a server: SSH keys, firewall rules, package updates, and performance tuning under simulated load.

### BCSC 307 Object-Oriented System Analysis and Design (1/4/3) — Engines E9, E10
Simulators: Fact-finding simulator (interview virtual stakeholders, read documents, observe process); DFD editor with balancing checks; data dictionary; decision tables and trees; feasibility calculator (technical, economic, operational, schedule); CASE-style design from analysis models; input/output screen designer.
- **B** Interview three virtual staff at a pharmacy and record requirements.
- **B** Draw a context diagram and level-0 DFD; the editor checks balance.
- **I** Build a data dictionary and decision table for a loan-approval process.
- **I** Perform a feasibility study and compare build vs buy alternatives with NPV and payback.
- **A** Produce logical and physical designs (database, inputs, outputs, architecture) for a hospital records system.
- **A** Plan implementation: conversion strategy, training, quality assurance, documentation, post-implementation review.

### BCSC 309 Research Methods in Computer Science (2/2/3) — Engines E10, E1
Simulators: Literature search and critique trainer (abstract reading, bias spotting, citation builder); research-design chooser; proposal structure scaffold; ethics review scenarios; data-analysis notebook.
- **B** Classify research types and identify variables in sample CS papers.
- **B** Formulate a research question and hypotheses from a problem statement.
- **I** Critique a flawed study (sampling, validity, reproducibility).
- **I** Build a proposal outline with aims, objectives, methodology and timeline.
- **A** Design an experiment to evaluate a software tool, including instruments and analysis plan.
- **A** Analyse a provided survey data set and write a results section with correct statistics.

### BCSC 311 Computer Organization and Architecture (3/0/3) — Engine E6
Simulators: Simple CPU (RISC-style ISA) with registers, ALU, memory, fetch-decode-execute animation; instruction-set workbench (assemble and run); pipeline visualiser with hazards and forwarding; cache simulator (direct, associative, replacement policies, hit/miss trace); microprogrammed control unit viewer; performance calculator (CPI, MIPS, Amdahl); multicore and parallel execution demo.
- **B** Step one instruction through fetch, decode, execute; watch registers and bus.
- **B** Write a short assembly program (add, load, store, branch) and run it.
- **I** Run a loop on a 5-stage pipeline; identify data and control hazards, enable forwarding and branch prediction.
- **I** Compare direct-mapped vs 4-way set-associative caches on a memory trace.
- **A** Design the micro-operations for a new instruction in the microprogrammed control unit.
- **A** Evaluate performance trade-offs of CISC vs RISC programs and multicore speed-up with Amdahl's law.

## Level 300 — Semester 2

### HOTU 396 Industrial Attachment — out of scope (16 credits, workplace).
Optional later: a "virtual internship" collection of realistic workplace scenarios drawn from the other engines.

## Level 400 — Semester 1

### BCSC 401 Information Security (2/2/3) — Engines E3, E4, E10, E7
Simulators: Threat-modelling board (CIA triad, assets, threats, controls); malware behaviour sandbox (simulated virus, worm, backdoor propagation across a network); password-strength and cracking demo (dictionary vs brute force vs salting); cryptography lab (Caesar, Vigenère, AES/RSA key exchange, hashing, digital signatures); authentication lab (MFA, Kerberos-style tickets); firewall and IDS rule builder; honeypot log analyser; ethical-hacking range (reconnaissance, scanning, exploitation of deliberately vulnerable simulated hosts); security policy and audit scenarios.
- **B** Encrypt and decrypt with classical ciphers; hash a file and detect tampering.
- **B** Test passwords against the cracker; see how salting and length change time-to-crack.
- **I** Configure a firewall to allow web and mail but block everything else; verify with the packet inspector.
- **I** Watch a worm spread; place IDS sensors and write signatures to detect it.
- **A** Run a scoped penetration test on the simulated company network and write a findings report.
- **A** Perform a security audit against a control catalogue (ISO 27001-style) and plan disaster recovery.

### BCSC 403 Computer Forensics (3/0/3) — Engines E4, E10
Simulators: Evidence intake with chain-of-custody forms; disk-image workbench (hex viewer, partition table, file carving, deleted-file recovery, hashing, timeline); metadata and EXIF viewer; browser/email artefact parser; registry and log explorer; report builder for court.
- **B** Image a drive, verify hashes, and document chain of custody.
- **B** Recover deleted files from a simulated FAT/NTFS image.
- **I** Build a timeline of user activity from logs, browser history and file timestamps.
- **I** Identify anti-forensic techniques (wiping, timestamp tampering, steganography) in a case image.
- **A** Investigate a mobile-money fraud case end to end and produce an admissible report.
- **A** Testify: defend your findings against a simulated cross-examination (scenario engine).

### BCSC 405 Operating Systems (3/0/3) — Engines E6, E4
Simulators: Process lifecycle and scheduler (FCFS, SJF, RR, priority, MLFQ) with Gantt and metrics; threads and synchronisation (race conditions, mutex, semaphores, dining philosophers); deadlock detection and Banker's algorithm; memory management (paging, segmentation, page replacement FIFO/LRU/Optimal, TLB); file systems (inodes, allocation, directory structure); disk scheduling; I/O and interrupts; virtual machine and hypervisor demo; mobile OS architecture explorer.
- **B** Watch processes move between ready, running and waiting; read the PCB.
- **B** Run FCFS and Round Robin on the same jobs; compare waiting time.
- **I** Fix a race condition with a semaphore; detect and avoid a deadlock with Banker's algorithm.
- **I** Compare page-replacement algorithms on a reference string; tune frame count.
- **A** Design a scheduler that meets response-time and throughput targets on a mixed workload.
- **A** Implement a simple file system allocation strategy and measure fragmentation; explore an Android-style OS stack.

### BCSC 407 Artificial Intelligence (1/4/3) — Engines E6, E1
Simulators: State-space search visualiser (BFS, DFS, UCS, greedy, A*) on grids, maps and puzzles; constraint-satisfaction solver (map colouring, Sudoku, timetabling) with backtracking and propagation; game-tree viewer (minimax, alpha-beta); decision-theory and utility calculator; grid-world MDP with value and policy iteration; logic workbench (propositional and first-order inference, resolution); neural-network playground; genetic algorithm and swarm visualiser.
- **B** Run BFS and DFS on a maze; count nodes expanded.
- **B** Train a perceptron on linearly separable points.
- **I** Design an admissible heuristic for A* on the 8-puzzle; prove it beats UCS.
- **I** Solve a lecture timetabling CSP; play Tic-Tac-Toe against minimax.
- **A** Build an expert system in first-order logic for crop-disease diagnosis and run inference.
- **A** Solve a grid-world MDP, then a concept-learning task with an ANN and a genetic algorithm; compare.

### BCSC 409 Data Science (elective, 2/2/3) — Engines E1 (Pyodide/webR), E5, E12
Simulators: Notebook with pandas/numpy/matplotlib (Pyodide) and R (webR); data blending workbench (join, clean, reshape CSV/JSON/API-like sources); warehouse/BI dashboard builder; machine-learning explorers (k-means, PCA, association rules, regression, classification) with live plots; big-data concepts simulator (map-reduce over partitioned data).
- **B** Load, inspect, clean and plot a data set on Ghanaian census-style data.
- **B** Follow the data science life cycle on a guided case.
- **I** Blend sales and weather data; build a BI dashboard with KPIs.
- **I** Cluster customers with k-means and reduce dimensions with PCA.
- **A** Build and evaluate regression and classification models; explain results to a non-technical audience.
- **A** Run a map-reduce word count over partitions and reason about scaling and privacy.

### BCSC 411 Wireless Communication (elective, 2/2/3) — Engines E7, E3, E1 (webR / Pyodide for MATLAB-style work)
Simulators: Modulation constellation and waveform viewer (ASK, FSK, PSK, QAM); path-loss and shadowing calculator with coverage map; fading simulator (Doppler, delay spread, coherence); cellular planner (frequency reuse, SIR, capacity); multiple-access demo (TDMA/FDMA/CDMA); BER vs SNR in AWGN; channel coding demo; MIMO and diversity visualiser; OFDM subcarrier view.
- **B** Modulate a bit stream and see the constellation; add noise and watch errors.
- **B** Plot received power vs distance for free-space and log-distance models.
- **I** Plan a cellular layout for a town with a reuse factor and compute SIR and capacity.
- **I** Simulate Rayleigh fading and compute coherence time and bandwidth.
- **A** Compare BER of BPSK, QPSK and 16-QAM in AWGN analytically and by simulation.
- **A** Show how receive diversity and 2×2 MIMO improve a fading link; analyse a trunked system with Erlang B.

### BCSC 413 Advanced Software Development with Java (elective, 2/2/3) — Engines E1 (Java), E5
Simulators: Java IDE with GUI designer (JavaFX-like scene graph rendered in HTML), event-dispatch visualiser, simulated servlet container with request/session/application scopes, JDBC to sql.js, MVC flow tracer, JSP renderer.
- **B** Abstract classes and interfaces with tests; build a first window with buttons and events.
- **B** Lay out a form in the GUI designer and bind events.
- **I** Build a desktop inventory app with JDBC CRUD.
- **I** Write a servlet that processes a form and stores data; inspect request and session scopes.
- **A** Build an MVC web app with servlets, JavaBeans and JSP pages.
- **A** Add authentication, validation and pagination; trace a request end to end.

## Level 400 — Semester 2

### BCSC 402 Legal and Ethical Issues in Computing (3/0/3) — Engine E10
Simulators: Case-law and statute explorer (Ghana Data Protection Act 843, Electronic Transactions Act, Cybersecurity Act, GDPR, CCPA, PIPEDA, POPIA); ethical-dilemma scenarios with multiple frameworks; contract clause builder; intellectual-property classifier; privacy impact assessment tool.
- **B** Classify incidents as cybercrime categories under Ghanaian law.
- **B** Identify copyright, patent, trademark and trade-secret issues in software cases.
- **I** Draft an IT services contract from clauses and spot missing protections.
- **I** Perform a privacy impact assessment for a school management app under Act 843 and GDPR.
- **A** Resolve an ethical dilemma (whistle-blowing on insecure e-voting software) using utilitarian, deontological and professional-code analysis.
- **A** Compare five data-protection regimes for a fintech expanding across Africa.

### BCSC 404 Cloud Computing (2/2/3) — Engines E12, E3, E4
Simulators: Cloud console (regions, VMs, storage, databases, load balancer, autoscaling, IAM); IaaS/PaaS/SaaS comparison lab; deployment-model picker (public, private, hybrid, community); cost and multitenancy simulator; monitoring dashboard with failure injection; service-selection scorer (SMI attributes); provider mapping to AWS, Azure and Google services.
- **B** Launch a VM, attach storage, open a port and host a page.
- **B** Classify services as IaaS, PaaS or SaaS; pick a deployment model for given scenarios.
- **I** Deploy a two-tier app behind a load balancer with autoscaling; watch it scale under load.
- **I** Secure the deployment with IAM roles, encryption and network rules.
- **A** Optimise monthly cost for a given workload across providers; justify with SMI attributes.
- **A** Survive injected failures (zone outage, DDoS, misconfiguration) while meeting an SLA.

### BCSC 406 Data Mining and Warehousing (elective, 2/2/3) — Engines E5, E1, E6
Simulators: Star/snowflake schema designer with ETL pipeline; OLAP cube with roll-up, drill-down, slice, dice; preprocessing workbench (cleaning, discretisation, normalisation); Apriori/FP-growth visualiser; classification (decision tree, naive Bayes, k-NN) with confusion matrices and bias-variance plots; clustering (k-means, hierarchical, DBSCAN).
- **B** Load a transactional data set and clean it.
- **B** Build a star schema for retail sales and run an OLAP roll-up.
- **I** Mine association rules from market-basket data; interpret support, confidence and lift.
- **I** Train and evaluate a decision tree; tune to reduce overfitting.
- **A** Design and implement a departmental data warehouse with ETL from three sources.
- **A** Compare clustering algorithms on customer data and present a business recommendation.

### BCSC 408 Internet of Things (elective, 2/2/3) — Engines E8 (avr8js Arduino, Raspberry Pi mock), E3, E12
Simulators: Arduino bench (real AVR emulation, virtual LEDs, sensors, motors, serial monitor); Raspberry Pi GPIO with Python; sensor-network and M2M simulator; protocol lab (MQTT, CoAP, HTTP, Zigbee/BLE abstractions); SDN controller demo; sensor-to-cloud pipeline; fog node simulator; smart-home/smart-farm/health case scenes.
- **B** Blink an LED and read a temperature sensor on the virtual Arduino.
- **B** Read a button and drive a buzzer on the Raspberry Pi with Python.
- **I** Publish sensor readings over MQTT to a broker and subscribe from a dashboard.
- **I** Build a wireless sensor network and observe routing and energy use.
- **A** Build a smart-irrigation system: soil sensors → fog node → cloud analytics → actuator, with security (TLS, device identity).
- **A** Program an SDN controller to prioritise health-monitor traffic in a smart-city scene.

### BCSC 410 Mobile Application Development (elective, 2/2/3) — Engine E11, E1
Simulators: Phone emulator frame with Android-style screen builder (layouts, views, navigation, intents, activity lifecycle visualiser); local storage and preferences mock; REST/cloud integration with simulated endpoints; sensor and permission mocks (GPS, camera, offline); testing checklist and store-publishing wizard.
- **B** Build a two-screen app with navigation and watch lifecycle callbacks fire.
- **B** Design a responsive UI for small and large phones.
- **I** Store notes locally and sync to a simulated cloud API; handle offline mode.
- **I** Use location and camera permissions correctly; handle denial.
- **A** Build a mobile-money style app with authentication, security and performance constraints.
- **A** Write test cases, measure performance, and walk through publishing and maintenance.

---

## Coverage summary

| Engine | Courses served |
| --- | --- |
| E1 Code Runner | 101, 102, 104, 108, 202, 204, 207, 208, 209, 211, 212, 301, 309, 407, 409, 410, 411, 413 |
| E2 Circuit Engine | 105, 205 |
| E3 Network Engine | 107, 201, 206, 210, 305, 401, 404, 408, 411 |
| E4 Virtual Machine / Terminal | 210, 305, 401, 403, 404, 405 |
| E5 Database Engine | 107, 203, 208, 406, 409, 413 |
| E6 State Visualiser | 101, 103, 202, 205, 207, 212, 311, 405, 406, 407 |
| E7 Math Lab | 103, 104, 105, 108, 204, 211, 401, 411 |
| E8 Hardware Bench | 105, 106, 107, 201, 408 |
| E9 Diagram Studio | 203, 301, 303, 307 |
| E10 Scenario Engine | 107, 301, 303, 307, 309, 401, 402, 403 |
| E11 Mobile Emulator | 410 |
| E12 Cloud Console | 404, 408, 409 |

Total: 38 BCSC courses, 228 labs sketched (6 per course), 12 shared engines.
