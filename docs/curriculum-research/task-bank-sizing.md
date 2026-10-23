# Task bank sizing

How many simulation task templates the platform needs so that a lecturer can assign a task on any topic of any
course at any of the three levels, and which simulation engine has to carry each one. Generated from
`data/courses.json` (230 courses, 17 programmes) on 2026-10-23.

## How the numbers are worked out

- **Topics** are the syllabus topics of a course (units x topics in `data/syllabi/<slug>.json`). Task templates
  attach to a topic by its 1-based unit and topicIndex, so the topic is the unit of sizing.
- **Levels**: every topic needs tasks at beginner, intermediate and advanced level.
- **Templates per topic and level**: beginner 2, intermediate 2, advanced 1
  (5 per topic). Two beginner and two intermediate templates let a lecturer set a practice task and a graded
  task that differ; one advanced template per topic is enough because advanced tasks are open and longer.
  So **templates needed = topics x (2 + 2 + 1) = 5 x topics**.
- **Variants**: each template generates at least 20 variants from seeded parameters, so a class of
  20 or more gets distinct instances and a resubmission gets a fresh one.
- **Seeds** are the task ideas already written into each course's weekly schedule (at least one per level per
  week). They are the first templates to build; the gap to the target is what remains.
- **Engine** for a topic is the engine named most often by the schedule tasks on that topic (or, if no task names
  the topic, by the tasks of the week that teaches it).

## Totals

| Tier | Courses | Topics | Beginner | Intermediate | Advanced | Templates needed | Seeds written | Variants at 20 each |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Bachelor's | 155 | 6605 | 13210 | 13210 | 6605 | 33025 | 6056 | 660500 |
| Master's | 67 | 2927 | 5854 | 5854 | 2927 | 14635 | 2627 | 292700 |
| Doctoral | 8 | 351 | 702 | 702 | 351 | 1755 | 312 | 35100 |
| **All** | **230** | **9883** | **19766** | **19766** | **9883** | **49415** | **8995** | **988300** |

## By engine

Each topic is counted once, under the engine that carries most of its tasks. Templates = 5 x topics.

| Engine | Courses using it | Topics (bachelor / master / doctoral) | Templates needed |
| --- | ---: | --- | ---: |
| E1 Code runner | 178 | 3718 (2202 / 1366 / 150) | 18590 |
| E7 Maths lab | 153 | 1625 (1099 / 445 / 81) | 8125 |
| E10 Case scenarios | 134 | 1443 (956 / 399 / 88) | 7215 |
| E6 Step visualiser | 88 | 682 (474 / 195 / 13) | 3410 |
| E9 Diagram studio | 72 | 461 (308 / 135 / 18) | 2305 |
| E4 Virtual machine | 43 | 427 (331 / 96 / 0) | 2135 |
| E5 Database engine | 43 | 386 (291 / 95 / 0) | 1930 |
| E3 Network simulator | 31 | 348 (254 / 93 / 1) | 1740 |
| E12 Cloud console | 32 | 291 (222 / 69 / 0) | 1455 |
| E2 Circuit bench | 14 | 236 (230 / 6 / 0) | 1180 |
| E8 Hardware bench | 24 | 210 (185 / 25 / 0) | 1050 |
| E11 Phone emulator | 7 | 56 (53 / 3 / 0) | 280 |

## Engine capabilities the task ideas assume

The schedule writers named the best-fit engine for every task. Some ideas lean on features an engine does not have
yet. Build or confirm these before writing templates for the affected weeks; until then a task can fall back to
E1 notebooks with a simplified model, or to an E10 scenario.

| Engine | Assumed capability | Courses that lean on it |
| --- | --- | --- |
| E1 Code runner | Dataframe and Spark-style or Dask-style lazy frames; deep learning libraries and small pretrained models in notebooks; Kotlin-style Android snippets; Java servlet/JSP container and JavaFX scene graph mocks; a ROS-like node, topic and transform API; Solidity-style contracts; a test FHIR server; deliberately vulnerable web apps with an intercepting proxy | Big data, computer vision, NLP, deep learning, mobile development, advanced Java, ROS, blockchain, health standards, web security |
| E2 Circuit bench | Verilog/HDL simulation with testbenches; transistor-level layout, LVS and process corners | VLSI design, HDL and FPGA design, advanced computer architecture |
| E3 Network simulator | OpenFlow switches and a controller, LLDP, VXLAN, P4 and service chaining; GSM/UMTS/LTE/5G core signalling; Mininet-style topologies | Software-defined networking, mobile and cellular networks, datacentre networks, IoT |
| E4 Virtual machine | Windows Server roles beyond the current subset (Group Policy, DFS, AD CS, WSUS, AD backup and restore); Ansible and container scanning | Systems administration I, infrastructure as code, cloud security |
| E5 Database engine | Loaded ICD-10, SNOMED CT and LOINC tables | Health data standards, electronic health records |
| E6 Step visualiser | Priority-inversion and RTOS kernel views; Raft, Paxos, CRDT and gossip protocol views; bandit, MDP and TD-learning views; GPU kernel and Kafka partition views; x86-style disassembly stepping | Real-time systems, distributed systems, reinforcement learning, big data, malware analysis |
| E8 Hardware bench | CAN bus, watchdog timer and logic analyser | Real-time systems, embedded systems |
| E12 Cloud console | Kubernetes objects and failure injection; Terraform-style plans and policy-as-code | Containers and Kubernetes, infrastructure as code, cloud security |

## Bachelor's courses

Topics x 3 levels; B, I and A are templates needed at beginner (x2), intermediate (x2) and advanced (x1).

| Course | Weeks | Topics | B | I | A | Templates | Seeds | Engines (topics carried) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Accounting and Finance for Information Systems | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E5 28, E10 12, E7 4, E9 3 |
| Advanced Software Development with Java | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 32, E5 4, E9 3, E12 1 |
| Analogue Electronics and Devices | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E2 37, E7 4, E8 2 |
| Artificial Intelligence | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 27, E6 14, E7 2 |
| Assembly Language and Microprocessors | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E6 37, E2 1, E8 1 |
| Basic Electronics | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E2 31, E7 10, E8 1 |
| Big Data and Parallel Computing | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 30, E6 6, E12 3, E7 1 |
| Biochemistry and Cell Biology for Computing | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E7 26, E6 9, E1 7, E10 4 |
| Biostatistics | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 30, E7 10 |
| Blockchain and Distributed Ledgers | 13 | 32 | 64 | 64 | 32 | 160 | 39 | E1 14, E6 11, E10 7 |
| Business Intelligence and Dashboards | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E5 25, E10 15, E9 6 |
| Business Process Modelling | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E9 28, E10 9, E7 8 |
| Calculus | 13 | 35 | 70 | 70 | 35 | 175 | 39 | E7 26, E1 9 |
| Causal Inference and Experimental Design | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 30, E7 11, E9 1 |
| Circuit Analysis | 13 | 54 | 108 | 108 | 54 | 270 | 39 | E2 42, E7 10, E8 2 |
| Clinical Decision Support and Evidence-Based Practice | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E10 13, E5 10, E1 9, E7 6, E9 3, E6 1 |
| Cloud Architecture and Solution Design | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E12 19, E10 10, E9 9, E7 7, E1 1, E5 1 |
| Cloud Computing | 13 | 36 | 72 | 72 | 36 | 180 | 39 | E12 25, E7 4, E3 3, E10 3, E4 1 |
| Cloud Data Platforms and Storage | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E12 19, E1 14, E5 5, E6 1, E10 1 |
| Cloud Security | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E12 27, E10 3, E9 2, E3 2, E1 2, E4 2 |
| Cognitive Science for Artificial Intelligence | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 19, E7 9, E10 7, E6 7 |
| Compiler Construction | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E1 26, E6 11 |
| Computer Forensics | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E4 21, E10 20 |
| Computer Graphics | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E1 28, E7 9 |
| Computer Hardware | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E8 35, E4 6, E3 3, E10 2, E6 1 |
| Computer Networking I | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E3 39, E1 4, E7 1, E9 1 |
| Computer Networking II | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E3 45 |
| Computer Organization and Architecture | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E6 35, E7 7, E1 1 |
| Computer Vision | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E1 33, E7 4, E6 1 |
| Computing Capstone Project | 13 | 47 | 94 | 94 | 47 | 235 | 40 | E10 22, E7 7, E4 6, E9 4, E1 4, E12 4 |
| Concurrent and Parallel Programming | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 31, E6 8 |
| Containers and Kubernetes | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E12 26, E4 14 |
| Control Systems | 13 | 47 | 94 | 94 | 47 | 235 | 40 | E7 46, E1 1 |
| Cryptography and Network Security | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E7 37, E3 7 |
| Data Communications | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E7 30, E3 11, E10 1 |
| Data Mining and Warehousing | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E1 23, E5 10, E10 2, E9 1, E6 1 |
| Data Privacy and Protection | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E10 23, E1 7, E5 6, E9 3, E4 1 |
| Data Science | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 34, E5 5 |
| Data Structures and Algorithms | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 21, E6 20, E7 1 |
| Data Visualisation | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 43, E5 2 |
| Data Wrangling and Preparation | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 39, E5 4 |
| Database Systems and Design | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E5 38, E9 5, E1 1 |
| Deep Learning | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 36, E6 5 |
| Design and Analysis of Algorithms | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 21, E6 17, E7 4 |
| Digital Banking, Lending and Insurance Technology | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 15, E5 10, E7 6, E1 6, E9 5, E12 1 |
| Digital Health and Telemedicine | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 32, E11 12 |
| Digital Logic Design | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E2 35, E7 3, E1 2, E6 1 |
| Digital Payments and Mobile Money | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E10 29, E5 19, E1 1 |
| Digital Signal Processing | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E1 32, E7 15 |
| Digital Transformation and Innovation Management | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 20, E9 15, E7 8 |
| Discrete Mathematics | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E7 39, E6 3, E1 1, E2 1 |
| Distributed Systems | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E6 32, E3 9 |
| Economics for Technology and Business | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E7 20, E1 17, E10 6 |
| Electric Machines and Drives | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E7 18, E2 10, E1 9, E8 6, E10 1 |
| Electromagnetics, Antennas and RF Engineering | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E7 30, E2 9, E1 8, E10 2 |
| Electronic Health Records | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 26, E5 14, E9 3 |
| Embedded Systems | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E8 28, E1 6, E10 2, E6 2 |
| Engineering Capstone Project | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E10 14, E8 14, E9 12, E4 2 |
| Engineering Mechanics and Dynamics | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E7 24, E1 24, E2 1 |
| Enterprise Architecture and Integration | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E9 17, E1 10, E10 6, E5 6, E6 4, E7 1 |
| Enterprise Resource Planning | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E5 23, E10 20 |
| Epidemiology and Public Health Data | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E7 20, E1 15, E10 7, E5 1 |
| Ethical Hacking and Penetration Testing | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 22, E4 18, E3 4 |
| Financial Mathematics | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E7 30, E1 14, E10 2 |
| Functional Programming | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 35, E6 4 |
| Fundamentals of Computer Science | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 13, E10 7, E6 5, E7 4, E3 4, E8 3, E5 3, E4 2, E2 1 |
| Game AI | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 26, E6 13, E10 3 |
| Game Design Principles | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E9 24, E10 19, E5 1 |
| Game Engine Programming | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 44, E7 1 |
| Game Physics and Simulation | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E1 37, E7 9 |
| Genetics and Population Genomics | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E7 24, E1 19, E10 3 |
| Genomics and Next-Generation Sequencing | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 38, E10 3, E5 2 |
| Hardware and Embedded Security | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E8 25, E6 6, E1 5, E7 2, E4 1, E10 1 |
| Hardware Description Languages and FPGA Design | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E2 24, E6 6, E1 5, E7 3, E9 1, E8 1 |
| Health Data Standards and Interoperability | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 24, E9 6, E5 6, E10 3, E12 1 |
| Health Information Systems | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E10 40, E9 6, E11 1 |
| Healthcare Delivery, Quality and Patient Safety | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 19, E7 19, E9 6 |
| Human Anatomy, Physiology and Clinical Terminology | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E10 13, E5 9, E6 8, E1 6, E7 6 |
| Human-Computer Interaction | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E10 19, E9 15, E7 2, E1 1 |
| Information Security | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E3 13, E10 11, E4 10, E1 6, E7 3, E9 1 |
| Information Systems and E-Commerce | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E10 18, E5 12, E9 11 |
| Information Theory and Coding | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E1 19, E7 13, E6 5 |
| Infrastructure as Code | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E12 25, E4 6, E1 5, E10 1 |
| Internet of Things | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E8 16, E3 15, E12 7, E1 3, E9 1, E10 1 |
| Introduction to Python | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 39, E6 2 |
| Introduction to Robotics | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E8 19, E1 9, E7 7, E9 3, E6 2, E4 2 |
| Investments and Portfolio Management | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 19, E7 18, E10 6 |
| IT Project Management | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 17, E9 14, E7 13 |
| IT Service Management and Governance | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E10 47, E9 2 |
| IT Support and Troubleshooting | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 21, E4 11, E8 5, E3 5, E7 1 |
| Knowledge Representation and Reasoning | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E1 36, E6 10 |
| Legal and Ethical Issues in Computing | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E10 40 |
| Linear Algebra for Data Science | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E7 26, E1 16 |
| Logic and Formal Methods | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E7 19, E1 14, E6 11, E10 2 |
| Machine Learning | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 41, E6 2, E7 2 |
| Malware Analysis and Reverse Engineering | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E4 14, E6 14, E10 10, E11 4, E3 2 |
| Mathematics for Computer Science | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E7 29, E1 9 |
| MLOps and Model Deployment | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E1 32, E12 4, E4 1 |
| Mobile and Cellular Networks | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E3 31, E7 14, E10 1 |
| Mobile Application Development | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E11 35, E1 5, E9 2, E5 1 |
| Mobile Robotics and Navigation | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E6 23, E1 21 |
| Molecular Biology for Computing | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 18, E10 15, E6 6 |
| Multiplayer and Network Game Programming | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 29, E3 7, E12 2, E5 1 |
| Multivariable Calculus | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E7 28, E1 18 |
| Natural Language Processing | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 44 |
| Numerical Methods and Computation | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 23, E7 16 |
| Object-Oriented System Analysis and Design | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E10 19, E9 17, E7 4, E5 1 |
| Operating Systems | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E6 18, E4 18, E11 1 |
| Operations Research and Decision Modelling | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 20, E7 16, E6 3, E10 2, E9 2 |
| Optical Communications and Fibre Networks | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E7 27, E3 7, E10 3 |
| Optimisation for Machine Learning | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 29, E7 14 |
| Phylogenetics and Molecular Evolution | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 35, E6 7, E7 2, E10 1 |
| Principles of Programming | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 43, E6 2 |
| Probability and Statistics | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E7 29, E1 9 |
| Programming with C | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 33, E4 4, E6 2 |
| Programming with C++ | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 37, E6 4 |
| Real-Time Systems | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E6 29, E8 6, E1 4, E7 4, E10 2 |
| Regression and Generalised Linear Models | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 33, E7 9 |
| Regulatory Technology and Compliance | 13 | 49 | 98 | 98 | 49 | 245 | 40 | E10 40, E5 9 |
| Reinforcement Learning | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 26, E6 8, E7 3, E10 3 |
| Requirements Engineering | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E10 28, E9 19, E1 1, E7 1 |
| Research Methods in Computer Science | 13 | 44 | 88 | 88 | 44 | 220 | 40 | E10 31, E1 13 |
| Responsible AI | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E10 26, E1 15 |
| Robot Kinematics and Dynamics | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E7 22, E1 17 |
| Robot Programming with ROS | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E1 34, E6 13 |
| Scripting and IT Automation | 13 | 44 | 88 | 88 | 44 | 220 | 42 | E4 38, E1 4, E7 1, E10 1 |
| Secure Software Development | 13 | 48 | 96 | 96 | 48 | 240 | 40 | E1 35, E10 8, E9 3, E4 2 |
| Security Operations and Incident Response | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 25, E4 19 |
| Security Risk Management and Governance | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E10 36, E7 4, E9 2 |
| Sensors and Actuators | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E8 21, E7 15, E2 3, E10 2 |
| Sequence Analysis and Alignment | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 32, E6 7, E7 6 |
| Serverless and Cloud-Native Applications | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E12 31, E1 6 |
| Signals and Systems | 13 | 50 | 100 | 100 | 50 | 250 | 40 | E7 47, E1 3 |
| Site Reliability Engineering | 13 | 37 | 74 | 74 | 37 | 185 | 39 | E12 23, E10 11, E4 3 |
| Software Architecture and Design Patterns | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 25, E9 16, E10 3 |
| Software Development with Java | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 40, E6 1 |
| Software Engineering | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 16, E9 14, E1 11, E4 2 |
| Software Maintenance and Evolution | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 19, E10 8, E9 4, E7 3, E4 3, E5 3 |
| Software Testing and Quality Assurance | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 33, E10 5, E4 4, E7 4, E6 2 |
| Software-Defined Networking | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E3 30, E1 13, E12 2 |
| Spreadsheet Analytics | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E5 25, E7 18 |
| Statistical Inference | 13 | 50 | 100 | 100 | 50 | 250 | 39 | E7 29, E1 19, E10 2 |
| Structural Bioinformatics | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 41, E7 3, E10 1 |
| Systems Administration I | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E4 36, E3 5, E10 1 |
| Systems Administration II | 13 | 45 | 90 | 90 | 45 | 225 | 40 | E4 42, E3 2, E1 1 |
| Systems Biology and Biological Networks | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 31, E7 10, E6 1 |
| Telecommunication Systems | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E7 20, E9 15, E3 8 |
| Theory of Computation | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E6 25, E7 11, E1 4 |
| Time Series Analysis and Forecasting | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 42, E7 3 |
| Version Control and DevOps | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E4 35, E1 7, E12 2 |
| VLSI Design | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E2 35, E6 8, E1 2, E10 1 |
| Web Application Programming I | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 39 |
| Web Application Programming II | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E1 27, E5 7, E4 4, E10 1 |
| Web Application Security | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 38, E4 3, E10 2, E9 1 |
| Wireless Communication | 13 | 41 | 82 | 82 | 41 | 205 | 40 | E7 37, E9 2, E3 2 |

## Master's courses

Topics x 3 levels; B, I and A are templates needed at beginner (x2), intermediate (x2) and advanced (x1).

| Course | Weeks | Topics | B | I | A | Templates | Seeds | Engines (topics carried) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Advanced Algorithms | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 25, E6 10, E7 4, E10 1 |
| Advanced Artificial Intelligence | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 33, E6 7, E7 2 |
| Advanced Business Analytics | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 22, E7 9, E5 7, E10 3, E9 1 |
| Advanced Cloud Architecture and Virtualisation | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E12 21, E1 7, E4 5, E7 4, E3 2, E10 2, E9 2, E6 1 |
| Advanced Computational Genomics | 13 | 50 | 100 | 100 | 50 | 250 | 39 | E1 34, E7 9, E5 4, E10 3 |
| Advanced Computer Architecture | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E6 24, E1 16, E7 4, E10 3, E8 1 |
| Advanced Computer Graphics | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 39, E7 9 |
| Advanced Computer Networks | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E3 24, E1 10, E7 5, E12 2, E10 2 |
| Advanced Database Systems | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 22, E5 12, E6 6, E7 2, E10 2 |
| Advanced Deep Learning | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 37, E6 5 |
| Advanced Digital Communications | 13 | 46 | 92 | 92 | 46 | 230 | 43 | E1 26, E7 20 |
| Advanced Distributed Systems | 13 | 39 | 78 | 78 | 39 | 195 | 39 | E6 19, E12 8, E3 7, E1 4, E7 1 |
| Advanced Game Engine Architecture | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 35, E6 2, E4 1, E7 1, E9 1 |
| Advanced Machine Learning | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 33, E7 8, E6 1 |
| Advanced Network Security | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E3 28, E1 6, E4 5, E10 4, E7 1, E12 1 |
| Advanced Operating Systems | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E4 23, E6 16, E7 2, E10 1 |
| Advanced Optimisation | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 35, E7 9 |
| Advanced Software Architecture | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 20, E9 12, E10 6, E12 5, E7 2 |
| Advanced Software Process and Project Management | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E10 17, E9 14, E7 13, E12 1, E4 1 |
| Advanced Statistical Modelling | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 31, E7 11 |
| Advanced Systems Analysis and Modelling | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 19, E9 18, E5 4, E7 3 |
| Advanced Wireless and Mobile Systems | 13 | 49 | 98 | 98 | 49 | 245 | 39 | E1 19, E7 15, E3 12, E10 3 |
| Algorithmic and Systematic Trading | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 29, E7 7, E10 3, E6 2, E9 1 |
| Applied Analytics Practicum | 13 | 36 | 72 | 72 | 36 | 180 | 39 | E1 16, E10 12, E5 3, E4 3, E9 1, E7 1 |
| Applied Cryptography | 13 | 47 | 94 | 94 | 47 | 235 | 43 | E1 39, E7 4, E10 4 |
| Asset Pricing and Derivatives | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 26, E7 13, E10 1 |
| Character Animation and Crowd Simulation | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 29, E7 9, E6 2 |
| Clinical Research Informatics and Real-World Data | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 23, E5 15, E10 7 |
| Computational Intelligence | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 30, E6 8, E7 4 |
| Cyber Risk Modelling and Security Economics | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E7 32, E10 9, E9 1 |
| Cyber-Physical Systems | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 14, E6 8, E8 6, E7 6, E12 4, E9 2, E3 1 |
| Data Governance and Information Management | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E5 24, E10 17, E9 2, E7 1 |
| Datacentre Networks and Network Virtualisation | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E1 16, E3 12, E7 6, E12 6, E10 3, E6 3 |
| Decentralised Finance and Digital Assets | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 27, E7 9, E10 4, E6 1, E9 1 |
| Empirical Software Engineering | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 20, E10 11, E7 7, E5 3, E4 2 |
| Evaluation and Implementation of Health Information Systems | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E10 23, E7 9, E9 6, E5 5, E1 3, E11 2 |
| Financial Econometrics and Quantitative Methods | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 30, E7 9, E10 1 |
| Financial Risk Management | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 27, E7 9, E10 7 |
| Foundations of Biomedical and Health Informatics | 13 | 49 | 98 | 98 | 49 | 245 | 41 | E10 21, E5 14, E1 8, E7 4, E9 2 |
| Generative AI and Large Language Models | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 30, E7 3, E10 3, E6 2, E12 2 |
| Graduate Game Project | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E10 22, E9 7, E7 4, E4 4, E1 2, E5 1 |
| Graduate Research Methods | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E10 26, E1 13, E7 6, E9 1 |
| Hardware Accelerators and Custom Computing | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 19, E6 9, E2 6, E7 5, E8 2, E10 1 |
| Human-Robot Interaction | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 17, E7 15, E9 10, E1 1 |
| Information Systems Theory and Digital Innovation | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E10 21, E9 15, E7 4, E1 3 |
| Large-Scale Data Systems | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 28, E12 9, E5 3, E6 2, E7 2, E9 1 |
| Machine Learning for Healthcare | 13 | 50 | 100 | 100 | 50 | 250 | 39 | E1 37, E10 6, E7 5, E6 2 |
| Mathematical Statistics | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 27, E7 14 |
| Motion Planning and Manipulation | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 31, E7 10, E6 6, E10 1 |
| Multi-Agent Systems and Game Theory | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 26, E6 12, E7 9, E10 1 |
| Nonlinear and Optimal Control | 13 | 46 | 92 | 92 | 46 | 230 | 39 | E1 31, E7 14, E6 1 |
| Performance Modelling and Queueing Systems | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E7 22, E1 16, E6 3, E12 1 |
| Privacy Engineering and Privacy-Enhancing Technologies | 13 | 49 | 98 | 98 | 49 | 245 | 42 | E1 23, E10 17, E7 8, E9 1 |
| Probabilistic Graphical Models | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 32, E7 4, E6 4 |
| Procedural Content Generation and Player Modelling | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 33, E7 5, E6 3 |
| Programming Language Theory and Verification | 13 | 47 | 94 | 94 | 47 | 235 | 39 | E1 38, E6 9 |
| Robot Learning | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E1 32, E7 5, E6 5, E8 1 |
| Robotic Systems Laboratory | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E1 13, E8 12, E10 9, E9 7, E4 1 |
| Scientific Workflows and Reproducible Data Pipelines | 13 | 42 | 84 | 84 | 42 | 210 | 39 | E4 20, E1 16, E12 2, E9 1, E6 1, E7 1, E10 1 |
| Security Analytics and Adversarial Machine Learning | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E1 38, E10 5, E7 1 |
| Software Analysis and Verification | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 31, E6 9, E10 5, E7 3 |
| Software Engineering Studio | 13 | 38 | 76 | 76 | 38 | 190 | 39 | E10 15, E9 8, E1 5, E4 5, E12 4, E11 1 |
| Software Safety and Dependability | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E10 17, E9 9, E1 9, E7 6, E6 3, E8 1 |
| State Estimation and Sensor Fusion | 13 | 48 | 96 | 96 | 48 | 240 | 39 | E1 41, E7 5, E8 1, E9 1 |
| Strategic Management of Information Technology | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E10 21, E9 10, E7 7, E12 3 |
| Systems and Software Security | 13 | 43 | 86 | 86 | 43 | 215 | 39 | E4 26, E6 9, E10 7, E8 1 |
| Telecommunications Network Planning and Regulation | 13 | 45 | 90 | 90 | 45 | 225 | 40 | E7 23, E10 15, E3 7 |

## Doctoral courses

Topics x 3 levels; B, I and A are templates needed at beginner (x2), intermediate (x2) and advanced (x1).

| Course | Weeks | Topics | B | I | A | Templates | Seeds | Engines (topics carried) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Advanced Research Design and Empirical Methods | 13 | 40 | 80 | 80 | 40 | 200 | 39 | E1 21, E10 18, E7 1 |
| Advanced Topics in Theoretical Computer Science | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E1 27, E7 16, E9 2 |
| Doctoral Research Seminar | 13 | 45 | 90 | 90 | 45 | 225 | 39 | E10 30, E1 13, E7 1, E9 1 |
| Mechanism Design and Market Microstructure | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 27, E7 11, E6 1, E3 1, E10 1 |
| Planning and Decision Making Under Uncertainty | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E1 30, E6 6, E7 5 |
| Provable Security and Cryptographic Protocols | 13 | 41 | 82 | 82 | 41 | 205 | 39 | E7 27, E1 5, E6 4, E10 3, E9 2 |
| Research Proposal and Grant Writing | 13 | 44 | 88 | 88 | 44 | 220 | 39 | E10 31, E9 13 |
| Statistical Learning Theory | 13 | 54 | 108 | 108 | 54 | 270 | 39 | E1 27, E7 20, E10 5, E6 2 |
