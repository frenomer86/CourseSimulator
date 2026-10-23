# Cloud Computing: curriculum research

Accessed 2026-10. Research for the CS Virtual Lab programme `cloud-computing`. University names appear only in this document.

## Summary

- Bachelor level: stand-alone cloud degrees are three-year UK awards (Coventry, Staffordshire) that run a fixed list of 12 modules of 30 credits (360 credits in all), with no electives. They put networking, systems and a cloud thread in years 1 and 2 and an applied project or a 60-credit final-year project in year 3. US and South African practice puts cloud as an upper-level course or a track on top of a general CS degree (operating systems, networks, databases, distributed systems first). Both routes share the same spine: programming, systems and networking, infrastructure and virtualisation, then cloud architecture, security and operations, then a capstone.
- Master's level: one year full time and 180 UK credits (Newcastle: nine taught modules, 10 credits each except one of 20, plus an 80-credit dissertation), or 30 US credit hours (Georgia Tech: about 10 courses, with an 18-hour specialisation, and optional project of 9 hours or thesis of 12 hours), or 90 credits of coursework plus a minor dissertation (Cape Town). The compulsory core is small: a cloud course, a distributed-systems or algorithms course, an operating-systems or networks course, and a research-methods or group-project module. The rest is an elective pool taken from systems, data, security and machine-learning courses.
- PhD level: US programmes use a systems/networking qualifying exam (Illinois: written statement, two assigned papers presented, reading list over six subareas), coursework (Illinois: 96 hours from a bachelor's, 72 or 64 with a master's), a preliminary exam, a teaching requirement and a thesis defence. Georgia Tech requires one intro course, four breadth courses from different areas, a 6-hour minor, a qualifier, a written and oral proposal, and a defence. Cape Town examines by thesis alone after a compulsory research-methods course and a first-year proposal.
- The current platform list (16 courses) covers the applied cloud spine well (cloud computing, containers, infrastructure as code, serverless, cloud security, SRE, systems administration) but has none of the general foundations that every reference programme demands (programming fundamentals, discrete maths, probability, data structures and algorithms, computer architecture, software engineering) and has no graduate-level cloud, distributed-systems or operating-systems course, no research methods, no datacentre networking, no performance modelling and no doctoral seminar.

Limits of this research. The search tool budget ran out part-way through, so some pages could not be searched for; many fetched pages returned binary PDFs or were blocked. Specific limits: Carnegie Mellon course 15-619 gives a topic list but its week-by-week schedule is only an image on the course page; the CMU PhD handbook and Stanford pages were unreachable (certificate or connection errors); the Georgia Tech and CityU PDFs were read by text extraction, and the CityU syllabus gives a keyword list with no weekly plan; no Makerere, Nairobi or Wits cloud syllabus was found (the University of Johannesburg only has short non-degree learning programmes). Where only a search summary was read, this is stated. "Not stated" means the page did not say.

## Bachelor level

| University | Award | Duration | Courses / credits | Core | Electives | Thesis / project |
|---|---|---|---|---|---|---|
| Coventry University (UK, London campus) | BSc (Hons) Cloud Computing | 3 years, or 4 with an optional placement year | 12 modules of 30 credits (360 credits) | All 12 compulsory. Year 1: Principles of Computer Systems; Serverless Web Applications; Networking Architecture and Design Concepts; Infrastructure Architecture and Design Concepts. Year 2: Software Defined Networks and Edge Services; Machine Learning and Artificial Intelligence; Securing Cloud Systems; Managing Virtualised Servers and Infrastructure. Year 3: Proposing Cloud Solutions; Applied Cloud Architecture Project; Applied Cloud Software Project; Managing Cloud Solutions | None listed | Final year is project based across all four modules. Exit awards: HNC after year 1, HND after year 2 (search summary) |
| Staffordshire University London (UK) | BSc (Hons) Cloud and Network Computing | 3 years, or 4 with a placement year | 11 modules: ten of 30 credits and a 60-credit final project (360 credits) | All compulsory. Year 1: Cloud and Network Technologies; Computing Project; Cyber Security and Artificial Intelligence; Programming Concepts. Year 2: Cloud Infrastructure Security; Computing Teamwork, Professional Practice and Business Analysis; Data Structures and Algorithms; Networking Architecture. Year 3: Advanced Network Technologies and Troubleshooting; Cloud Development and Operations; Final Year Project | None listed | 60-credit Final Year Project |
| University of East London (UK) | BSc (Hons) Cloud Computing | 3 years, optional placement | Not stated in the page read (search summary only) | Year 1: Information Systems Modelling and Design; Software Development; Web Technologies; Maths for Computing; Computer Systems and Networks. Year 2: databases, systems administration, web and mobile development, enterprise architecture with cloud computing. Year 3: strategy and management, project management, network security, advanced cloud topics | Not stated | Final project (search summary only; module list not read from the university page) |
| University of Washington, Tacoma (US) | Upper-level elective inside a CS/IT degree: TCSS 462 Cloud Computing | One quarter (10 weeks) | One course. Prerequisite: TCSS 360 with grade 2.0 | Course topics: cloud basics, delivery models, virtualisation, storage, containers and orchestration, monitoring, benchmarking, security, scalability | Optional: cloud networking, deployment models, SLA metrics, infrastructure as code | Term project |
| University of Illinois Urbana-Champaign (US) | Upper-level elective: CS 425 / ECE 428 Distributed Systems (opens with cloud computing) | One semester (16 weeks) | One course; prerequisite operating-systems and networking fundamentals | Cloud basics, MapReduce, gossip, failure detectors, P2P, key-value stores, time, snapshots, consensus | n/a | Midterm and final exam, programming projects |
| University of Cape Town (South Africa) | BSc (Hons) Computer Science, fourth year, 160 credits: compulsory Research and Innovation, Functional Programming, Compilers 1 and 2; electives of 48 to 68 credits; 60-credit project | 1 year after a three-year BSc | 160 credits | Four compulsory modules (about 16, 12, 12, 12 credits) | Includes High Performance Computing, Network and Internetwork Security (which covers cloud security), Big Data Management | 60-credit major project |

Observations. (a) The three UK degrees keep all modules compulsory and are narrow and applied. (b) The British Computer Society and US degrees assume general CS first; the platform has no such CS foundation in the cloud programme today. (c) Placement years are common in the UK; the platform equivalent is the capstone scenario.

## Master's level

| University | Award | Duration | Courses / credits | Core | Electives | Thesis / exam |
|---|---|---|---|---|---|---|
| Newcastle University (UK) | MSc Cloud Computing | 1 year full time (taught in three blocks) | 180 credits: nine taught modules totalling 100 credits plus an 80-credit project | All compulsory: Engineering for AI; Distributed Algorithms; Enterprise Software and Services; Cloud Computing; Machine Learning with Project; Internet of Things; Research Methods and Group Project in Cloud Computing (20 credits); Advanced Programming in Java; Safe and Trustworthy AI | None | 80-credit individual project and dissertation (five months). Weighted average of at least 50 in the taught part needed to start the dissertation |
| Georgia Tech (US) | MS Computer Science, Computing Systems specialisation | Not fixed (OMSCS is part time; degree within six years) | 30 credit hours, about 10 courses. Specialisation 15 to 18 hours (core 9 plus electives 9), 12 to 15 hours free electives, at least 24 hours at 6000+ level CS/CSE | Specialisation core: one algorithms course (CS 6505 or CS 6515) plus two of Advanced Operating Systems, Compiler Design, Computer Networks, High-Performance Computer Architecture, Software Engineering, Programming Languages, Database Systems Concepts and Design | Three from a long list including System Design for Cloud Computing, Graduate Intro to Operating Systems, Distributed Computing, Big Data Systems and Analytics, Machine Learning Systems, Network Security, Applied Cryptography, Advanced Internet Computing | Course option (30 hours of courses), project option (21 + 9 hours of project) or thesis option (18 + 12 hours). GPA 3.0; specialisation courses B or better |
| University of Cape Town (South Africa) | MSc Computer Science by coursework and dissertation | 2 years (coursework in year 1; dissertation can finish by end of year 2) | 90 credits of coursework: Research Methods (18 credits) plus six electives (12 credits each), then a minor dissertation | Research Methods (CSC5020Z) compulsory | Distributed Scientific Computing (grid and cloud, IaaS/PaaS/SaaS), Networks and Internet Systems, Information Retrieval, Intelligent Systems, Image Processing and Computer Vision, HCI, Data Visualization and others | Research proposal and presentation in first year; minor dissertation |
| City University of Hong Kong | MSc programmes; course CS5296 Cloud Computing: Theory and Practice | One semester | 3 credit units; precursor Computer Networks and Internets | Single course: service models, virtualisation, cluster and job scheduling, distributed storage, datacentre networks, Hadoop, resource management tools, ML parallelism, cloud security | n/a | 60 percent coursework (programming assignment 20, paper review 15, group project 25), 40 percent exam |
| Carnegie Mellon University (US) | Courses 15-319 (undergraduate) and 15-619 (graduate) Cloud Computing, a combined online project course | One semester, 15 units (12 in earlier years) | 12 quizzes (20 percent), 10 individual projects (60 percent), team project (20 percent) for 15-619 | Prerequisite: grade C in a systems course for undergraduates; system and programming competency for graduates | n/a | 15-619 students add a team project: a cost and performance sensitive web service over big data |

Master's observations. Cloud degrees put one named cloud course at the centre and surround it with distributed algorithms, enterprise software or operating systems, plus a research-methods module and a dissertation. The common electives are machine learning systems, big data, security and IoT.

## PhD level

| University | Award | Duration | Courses / credits | Core | Electives | Thesis / exam |
|---|---|---|---|---|---|---|
| University of Illinois Urbana-Champaign (US) | PhD Computer Science (Systems and Networking area) | Qualifying exam by the 4th PhD term (3rd with a CS master's), completed within 3 years (2.5 with a master's); total length not stated | 96 hours from a bachelor's (72 with another approved graduate degree, 64 with a CS MS): at least 48 hours coursework including 20 hours CS, at least 16 hours at 500 level, and at least 32 hours CS 599 thesis | Program of Study set with three committee members; first-semester seminar CS 591 | Strongly encouraged: two 500-level courses from different professors before the exam, e.g. Advanced Operating Systems, Advanced Distributed Systems, Advanced Computer Networking, Computer Systems Analysis, Storage Systems, ML plus Data Systems | Qualifying exam: 200-word qual statement, two assigned papers presented (about 20 minutes each), reading list in six subareas (cyber-physical systems, distributed systems, ML systems, networking, operating systems, wireless and mobile); preliminary exam; final thesis defence; one full-term TA appointment by end of year five; minimum GPA 3.0 |
| Georgia Tech (US) | PhD Computer Science | Not stated | Intro graduate course CS 7001; breadth of four courses from different research areas including a theory course; 6-hour minor outside the College | Breadth plus program of study | Minor | Qualifier in a primary area; written and oral dissertation proposal (admits to candidacy); defence |
| University of Cape Town (South Africa) | PhD Computer Science | Individual, supervisor must accept the student | Compulsory Research Methods course in the first year; coursework optional by supervisor | Research Methods (CSC5020Z) | Masters modules by agreement | Research proposal and presentation in the first year; examined on the thesis alone |
| Virginia Tech (US) | PhD Systems, Networking and Cybersecurity qualifier | Not stated | Not stated | Annual reading list of 10 to 15 papers | n/a | Written then oral exam; scored 0 to 3 per part, 6 points needed in total (search summary only) |

PhD observations. Coursework is thin (a research methods or intro seminar plus two to four advanced systems courses). The hard gates are a qualifying exam in the first two years, a proposal or preliminary exam, a teaching term and a defence.

## Common core across universities

| Topic | Appears in |
|---|---|
| Cloud computing concepts, service and deployment models, virtualisation | Coventry, Staffordshire, UEL, UW Tacoma, CityU, CMU, Newcastle, Cape Town, Georgia Tech |
| Networking architecture and software-defined networking | Coventry (two modules), Staffordshire (three), Georgia Tech System Design for Cloud (SDN and network function virtualisation), UW Tacoma |
| Cloud security | Coventry, Staffordshire, CityU, Cape Town security course, Georgia Tech |
| Operating systems and virtual machines, containers and orchestration | Coventry, Georgia Tech, UW Tacoma, CMU (Docker and Kubernetes projects) |
| Distributed algorithms, consensus, key-value stores | Illinois, Newcastle, Georgia Tech Distributed Computing, Cape Town |
| Big data and ML platforms | Newcastle (ML with project, Engineering for AI), Georgia Tech, CMU (MapReduce, Spark), CityU (Hadoop, ML parallelism), Coventry |
| Programming and algorithms foundations | Staffordshire (Programming Concepts, Data Structures and Algorithms), Georgia Tech algorithms core, Newcastle Advanced Programming |
| Final project or dissertation | Every programme |
| Research methods and group project | Newcastle, Cape Town, Georgia Tech (project option) |

## Prerequisite chains

Bachelor chains, as implied by the sources and current platform design:

- Programming fundamentals (principles-of-programming, introduction-to-python) then data-structures-and-algorithms then operating-systems then distributed-systems.
- computer-networking-i then computer-networking-ii then software-defined-networking then cloud networking.
- systems-administration-i then systems-administration-ii then version-control-and-devops then infrastructure-as-code.
- operating-systems and computer-networking-i then cloud-computing then containers-and-kubernetes then serverless-and-cloud-native-applications.
- information-security then cloud-security; cloud-computing then site-reliability-engineering.
- Master's chain (Georgia Tech, Newcastle): an operating-systems or distributed-systems course is a prerequisite for system design for cloud (the Georgia Tech course page names Advanced Operating Systems with grade A or high B). Carnegie Mellon needs a systems course with grade C.
- Doctoral: research methods or intro seminar first, two advanced systems courses, then qualifier, then proposal.

## Representative weekly schedules

### Bachelor core: Cloud Computing (UW Tacoma TCSS 462 model syllabus, 10 weeks)

| Week | Topics |
|---|---|
| 1 | Cloud concepts and terminology; goals, benefits, risks and challenges |
| 2 | Cloud characteristics; service delivery models (part A) |
| 3 | Service delivery models (part B); cloud-enabling technologies |
| 4 | Fundamental cloud architectures; virtualisation and virtual machines |
| 5 | Cloud storage abstractions; cloud networking |
| 6 | Containerisation |
| 7 | Infrastructure management and scalability; multi-tenancy and resource contention |
| 8 | Fundamental cloud security |
| 9 | Service quality metrics and SLAs |
| 10 | Benchmarking and performance evaluation |

### Bachelor/master's dual-level: Distributed Systems with a cloud opening (Illinois CS 425, Fall 2025, 16 weeks)

| Week | Topics |
|---|---|
| 1 | Introduction; introduction to cloud computing |
| 2 | Cloud computing (continued); MapReduce and Hadoop |
| 3 | Gossip; failure detectors and membership, grids |
| 4 | Peer-to-peer systems (two lectures) |
| 5 | Key-value stores and NoSQL |
| 6 | Key-value stores (continued); time and ordering |
| 7 | Snapshots; midterm exam |
| 8 | Paxos and consensus; multicast communication |
| 9 | Leader election; mutual exclusion |
| 10 | RPC and marshalling; concurrency control |
| 11 | Replication control; structure of networks, stream processing |
| 12 | Scheduling; distributed file systems and consistency models |
| 13 | Distributed shared memory, sensor networks; graph processing and machine learning |
| 14 | Thanksgiving break |
| 15 | Security; real behaviours and datacentre disasters (case studies) |
| 16 | Wrap-up |

### Master's core: Software Engineering for Cloud Computing (UW Tacoma TCSS 562, Fall 2020, 11 weeks; a 500-level graduate course)

| Weeks | Topics |
|---|---|
| 1 to 3 | Cloud history and enabling technologies; Linux introduction; Bash scripting lab; EC2 and VM storage performance lab |
| 4 to 6 | Cloud roles, characteristics, delivery and deployment models; AWS demos and labs: function-as-a-service, object storage, monitoring, serverless databases |
| 7 to 9 | Containerisation with Docker; orchestration with Kubernetes |
| 10 to 11 | Student team presentations on technologies and research papers (serverless and function fusion); term project II |

Assignments run weekly (T1 to T6). The CMU graduate course adds ten individual projects and a team project: MapReduce and notebooks; auto-scaled, load-balanced, fault-tolerant deployments with VMs, Docker and Kubernetes; batch, iterative and stream analytics; a cost and performance sensitive big-data web service.

### Doctoral seminar: Hardware-Software Co-design for Cloud and Datacentres (UT Austin CS 395T, Fall 2026, about 15 weeks)

| Week | Topic |
|---|---|
| 1 | Course introduction |
| 2 | Datacentre workloads |
| 3 | Microservices: software |
| 4 | Microservices: hardware |
| 5 | Serverless: characterisation and virtualisation |
| 6 | Serverless: software optimisations |
| 7 | Serverless and hardware |
| 8 | Datacentre tax accelerators |
| 9 | Midterm project presentations |
| 10 | Large code footprints of datacentre workloads |
| 11 | AI workloads in datacentres |
| 12 | Machine learning for cloud and datacentre systems |
| 13 | Datacentre architecture with power management (part 1) |
| 14 | Buffer week |
| 15 | Fall break |
| 16 | Power management (part 2); final project presentations |

Milestones: proposal in week 4, midterm report in week 9, final report after week 16. Other doctoral reading seminars surfaced in search (MIT, Purdue, Brown, Wisconsin, HKUST) follow the same pattern of one paper or topic per week plus a research project.

## Gap analysis against the current platform list

Current list (16): introduction-to-python, computer-networking-i, operating-systems, systems-administration-i, computer-networking-ii, systems-administration-ii, database-systems-and-design, version-control-and-devops, cloud-computing, containers-and-kubernetes, infrastructure-as-code, distributed-systems, serverless-and-cloud-native-applications, information-security, cloud-security, site-reliability-engineering.

| Gap | Evidence | Resolution |
|---|---|---|
| Programming, discrete maths, probability, algorithms, architecture, software engineering | Staffordshire (Programming Concepts, Data Structures and Algorithms), Georgia Tech algorithms core, UEL Maths for Computing, Coventry Principles of Computer Systems | Reuse existing: fundamentals-of-computer-science, principles-of-programming, discrete-mathematics, mathematics-for-computer-science, probability-and-statistics, data-structures-and-algorithms, computer-organization-and-architecture, software-engineering |
| Cloud solution design and cost, SLAs | Coventry Proposing Cloud Solutions, Applied Cloud Architecture; Newcastle; UW Tacoma service quality and SLAs | New bachelor course: Cloud Architecture and Solution Design |
| Cloud storage and data platforms | Coventry, CMU cloud storage and NoSQL, CityU distributed storage, UW Tacoma storage abstractions | New bachelor course: Cloud Data Platforms and Storage |
| Final-year capstone | Coventry applied projects, Staffordshire 60-credit project, UEL | New bachelor course: Cloud Engineering Capstone Project |
| Datacentre networking and virtual networks | Georgia Tech System Design for Cloud (SDN and NFV), CityU datacentre networks, Coventry SDN, UT Austin and MIT networking seminars | Existing software-defined-networking for bachelors; new master's course: Datacentre Networks and Network Virtualisation |
| Graduate operating systems | Georgia Tech (Advanced OS in core pool), Illinois PhD qualifier reading list | New master's course: Advanced Operating Systems |
| Graduate cloud and virtualisation | Newcastle Cloud Computing, CMU 15-619, CityU CS5296, UW Tacoma TCSS 562 | New master's course: Advanced Cloud Architecture and Virtualisation |
| Graduate distributed systems | Newcastle Distributed Algorithms, Georgia Tech Distributed Computing, Illinois Advanced Distributed Systems | New master's course: Advanced Distributed Systems |
| Large-scale data and ML platforms | Georgia Tech Big Data Systems and Analytics, ML Systems, CityU Hadoop and ML parallelism, CMU MapReduce, Spark, Kafka | New master's course: Large-Scale Data Systems (ML platform topics cover the ML-systems theme) |
| Performance evaluation and queueing | Illinois Computer Systems Analysis, CMU cost and performance project, UW Tacoma benchmarking | New master's course: Performance Modelling and Queueing Systems |
| Research methods | Cape Town compulsory, Newcastle compulsory | New master's course: Graduate Research Methods |
| Doctoral seminar | UT Austin, MIT, Purdue, Brown seminars; Illinois qualifier | New PhD course: Doctoral Research Seminar in Cloud and Distributed Systems |

## Proposed structure

### Bachelor (4 years)

Core, in suggested study order (27): fundamentals-of-computer-science, principles-of-programming, introduction-to-python, discrete-mathematics, mathematics-for-computer-science, probability-and-statistics, data-structures-and-algorithms, computer-organization-and-architecture, computer-networking-i, operating-systems, database-systems-and-design, systems-administration-i, version-control-and-devops, software-engineering, computer-networking-ii, systems-administration-ii, information-security, cloud-computing, distributed-systems, containers-and-kubernetes, infrastructure-as-code, serverless-and-cloud-native-applications, cloud-security, site-reliability-engineering, new Cloud Architecture and Solution Design, new Cloud Data Platforms and Storage, new Cloud Engineering Capstone Project.

Electives (pool of 12, choose 5): web-application-programming-i, software-development-with-java, software-defined-networking, big-data-and-parallel-computing, machine-learning, mlops-and-model-deployment, internet-of-things, software-architecture-and-design-patterns, it-service-management-and-governance, it-project-management, ethical-hacking-and-penetration-testing, security-operations-and-incident-response.

Total pool 39 courses, 32 taken. The proposal adds 3 new bachelor courses.

### Master's (1 to 2 years)

Core (5): new Graduate Research Methods, new Advanced Operating Systems, new Advanced Cloud Architecture and Virtualisation, new Advanced Distributed Systems, new Large-Scale Data Systems.

Electives (pool of 10, choose 4): new Datacentre Networks and Network Virtualisation, new Performance Modelling and Queueing Systems, software-defined-networking, big-data-and-parallel-computing, machine-learning, mlops-and-model-deployment, cryptography-and-network-security, internet-of-things, blockchain-and-distributed-ledgers, regulatory-technology-and-compliance.

Milestones: research proposal in the first year; project or dissertation (an individual cloud systems project of about 60 to 80 credits or 9 to 12 US hours); oral defence. New master's courses: 7.

### PhD (4 to 5 years)

Core (3): new Doctoral Research Seminar in Cloud and Distributed Systems, new Advanced Distributed Systems, new Advanced Cloud Architecture and Virtualisation.

Electives (pool of 6, choose 3): new Advanced Operating Systems, new Large-Scale Data Systems, new Datacentre Networks and Network Virtualisation, new Performance Modelling and Queueing Systems, cloud-security, optimisation-for-machine-learning.

Milestones: qualifying examination in the first two years (reading-list and two assigned papers presented); research proposal and preliminary examination; one teaching term; at least one refereed publication; dissertation and public defence. New PhD courses: 1.

## Sources

- Coventry University BSc (Hons) Cloud Computing, course structure: https://www.coventry.ac.uk/cul/course-structure/undergraduate/cloud-computing-bsc-hons/
- Staffordshire University London BSc Cloud and Network Computing: https://staffs.ac.uk/london/course/cloud-and-network-computing-bsc
- UCAS listings for cloud degrees (summary read via search): https://www.ucas.com/explore/courses/40ebb233-955a-4374-9b82-a2f9838a7f44/cloud-computing and https://university.which.co.uk/coventry-university-c85/courses/cloud-computing-bsc-hons-2024-4806905efba7
- University of East London BSc Cloud Computing (search summary only): https://universitycompare.com/universities/university-of-east-london/undergraduate/cloud-computing-bachelor-of-science-with-honours-bsc-hons-d78ab63a-2027
- Newcastle University MSc Cloud Computing: http://www.ncl.ac.uk/postgraduate/degrees/5056f/ and regulations https://teaching.ncl.ac.uk/docs/regsdocs2026/documents/-R5056F_2627_vFinal.pdf
- Georgia Tech MS Computer Science handbook 2025: https://www.cc.gatech.edu/sites/default/files/documents/2025/MSCS%20Handbook%202025.pdf
- Georgia Tech MS specialisations: https://www.cc.gatech.edu/ms-computer-science-specializations
- Georgia Tech PhD Computer Science: https://www.cc.gatech.edu/degree-programs/phd-computer-science
- Georgia Tech OMSCS CS 6211 System Design for Cloud Computing: https://omscs.gatech.edu/cs-6211-system-design-cloud-computing
- University of Cape Town Computer Science graduate handbook 2019: https://sit.uct.ac.za/media/55707
- City University of Hong Kong CS5296 Cloud Computing: Theory and Practice: https://www.cityu.edu.hk/pg/202627/course/CS5296.pdf
- Carnegie Mellon 15-619 Cloud Computing course page: https://www.cs.cmu.edu/~msakr/15619-s24/index.html and course profile https://csd.cmu.edu/15319619-cloud-computing
- University of Washington Tacoma TCSS 462 model syllabus: https://depts.washington.edu/techdocs/programs/CSS/approved_courses/ElectiveSyllabi/TCSS462ModelSyllabus-May2022.docx
- University of Washington Tacoma TCSS 562 (Fall 2020) schedule: https://faculty.washington.edu/wlloyd/courses/tcss562_f2020/schedule.html
- University of Illinois CS 425 lectures, Fall 2025: https://courses.grainger.illinois.edu/cs425/fa2025/lectures.html
- University of Illinois PhD programme: https://siebelschool.illinois.edu/academics/graduate/phd-program
- University of Illinois qualifying exam, systems and networking: https://siebelschool.illinois.edu/academics/graduate/phd-program/qualifying-exam/systems-networking and general rules https://siebelschool.illinois.edu/academics/graduate/phd-program/qualifying-exam
- University of Texas at Austin CS 395T Fall 2026 schedule: https://cascade.cs.utexas.edu/teaching/f26-cs395t-schedule.html
- Virginia Tech systems, networking and cybersecurity qualifier (search summary only): https://cnsr.ictas.vt.edu/system-QE-2014.htm
- Other doctoral reading-seminar pages (listed in search, not fetched): https://people.csail.mit.edu/matei/courses/2015/6.S897 and https://engineering.purdue.edu/~vshriva/courses/ece69500sp23/schedule.html
