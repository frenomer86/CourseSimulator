# Robotics: curriculum research

Accessed 2026-10. Evidence levels: **[page]** = read from the official page or PDF in this session; **[snippet]** = search-result summary only (page not opened, or it failed to load); **[3rd]** = third-party guide; **[general]** = widely published practice, not re-checked. Carnegie Mellon pages (`ri.cmu.edu`, `mrsd.ri.cmu.edu`) failed with certificate errors, so CMU facts are snippet-level only.

## 1. Summary

Robotics degrees are interdisciplinary: mechanics and dynamics, electronics and embedded computing, control, perception and AI, all tied together by team-based design. Five structural features recur:

1. A first-year "Introduction to Robotics" or robot-building design course (WPI RBE 1001, Michigan ROB 101/102/203/204, Glasgow robotics projects, Heriot-Watt Year 1 robotics group project).
2. A mechanics/dynamics strand (Michigan dynamics requirement, UCT Engineering Dynamics and Applied Mechanics, Glasgow Dynamics 1 to 3).
3. An electronics, embedded and real-time strand, then control (UCT, Glasgow, Michigan).
4. A robotics core (Michigan chooses 3 of sensors and signals; build and move; controls; robot operating systems; localisation, mapping and navigation; human evaluation) and an AI/ML strand in the final years (Glasgow Introduction to AI and ML then Advanced AI and ML; Michigan ROB 430 deep learning).
5. A capstone (Michigan ROB 450, WPI Major Qualifying Project, Glasgow individual or team project, UCT 40-credit research project).

Master's programmes are 1.5 to 2 years (ETH 90 ECTS, Michigan 30 credits, CMU MRSD 183 units) with a mathematics/foundations core, a systems lab, breadth across sensing, reasoning and acting, and a project or thesis. PhDs are research degrees with a qualifier, thesis proposal and defence; Michigan requires only 26 to 36 credits of coursework.

The current platform list for Robotics has 17 courses and covers kinematics/dynamics, control, ROS, mobile robotics and vision, but has no introductory robotics course, no mechanics/dynamics, no capstone, no actuators/power course, no data structures, probability, ML or software engineering, and no graduate layer.

## 2. Bachelor's level

| University | Award | Duration | Courses or credits | Core | Electives | Project / exam |
|---|---|---|---|---|---|---|
| University of Michigan [page] | BSE Robotics | 4 y | 128 credits | CoE common: ENGR 100, computational thinking, linear algebra (ROB 101), calculus I and II, intermediate calculus, chemistry 5, physics I and II 5 each; major: ROB 204 Teamwork in Robotics 4, robotics core 3 of 6 (12 cr), data structures and programming 4, probability/statistics 3-4, electronics and circuits 4, dynamics and mechanics 4, discipline depth 3-4, technical communications 3 | 2 upper-level ROB electives (6 cr), flexible technical electives 10-12, total technical electives at least 18 cr; 16 cr liberal arts; 9-12 general electives | ROB 450 Robotics Capstone (4 cr); at least 30 technical credits at 300 level or above |
| Worcester Polytechnic Institute [snippet] | BS Robotics Engineering | 4 y | 15 units minimum (WPI unit system); robotics at least 5/3 units | RBE 1001 Introduction to Robotics, Unified Robotics I to IV (RBE 2001, 2002, 3001, 3002), computer science at least 1 unit incl. OOP and software engineering, physics, other science | Free electives; humanities, entrepreneurship, social implications | Major Qualifying Project (robotics capstone, team of 2 to 4) |
| University of Glasgow [page] | BEng/MEng Robotics and Artificial Intelligence | BEng 4 y, MEng 5 y | Credits not stated; year 1: 8 core courses, year 2: 11, year 3: 12 | Year 1 Analogue Electronics, Design and Manufacture, Dynamics, Engineering Maths, Statics, Materials; Year 2 Digital Electronics, Embedded Processors, Introductory Programming, Dynamics 2, Maths 2, Power Electronics; Year 3 Control 3, Simulation of Engineering Systems, Real Time Computer Systems, Advanced Programming and Software Engineering, Power Engineering, Team Design Project; Year 4 Control 4, Robotics 4, Introduction to AI and ML 4 | Year 4 options | BEng individual project (year 4); MEng robotics team design project (year 4) plus year 5 individual project placement, Advanced Control 5, Advanced AI and ML 5 |
| Heriot-Watt University [page, partial] | BEng/MEng Robotics, Autonomous and Interactive Systems | BEng 4 y, MEng 5 y | Only year 1 listed | Year 1: Introduction to Electrical and Electronic Engineering, Praxis Electronic Design, Maths for Engineers and Scientists 1 and 2, Software Development 1 and 2, Praxis Programming, Robotics group project | Year 4/5 options: biologically inspired computation, data mining and ML, intelligent robotics, games programming | Six-month industry placement (MEng) |
| University of Cape Town (closest African analogue) [page] | BSc(Eng) Mechatronics | 4 y (5 y extended) | 560 credits (576 before 2025) | Year 1 132 cr (CS 1015/1016, intro EE A and B, maths, physics); Year 2 136 cr (Analogue Electronics, Embedded Systems I, Mechanics, Power Engineering, Signals and Systems I, Linear Algebra, Electromagnetism); Year 3 146 cr (Devices and Circuits, Energy Conversion I, Signals and Systems II, Engineering Dynamics, Applied Engineering Mechanics, Control Systems, Embedded Systems II, Design: Mechatronics); Year 4 90 cr core | Year 4: at least 2 of Energy Conversion II, Process Control and Instrumentation, Mechatronics; further DSP, High Performance Embedded Systems, Medical Imaging; at least 48 cr | 40-credit Research Project; Engineering System Design; vacation work each year |

Asia: no retrievable page was found for a bachelor's robotics programme in Asia in this session (NUS and SUTD pages did not list one); the gap is acknowledged. NUS CEG (see computer-engineering note) is the closest verified Asian structure.

UCT EEE4119F Mechatronics outline [page]: multibody kinematics (2D and 3D), inverse kinematics, Euler-Lagrange mechanics, numerical simulation, friction modelling, nonlinear control (feedback linearisation, Lyapunov stability, sliding control, gain scheduling, manipulator control, trajectory optimisation), applied to terrestrial, sea, air and industrial robots.

## 3. Master's level

| University | Award | Duration | Courses or credits | Core | Electives | Thesis / exam |
|---|---|---|---|---|---|---|
| ETH Zurich [page + 3rd] | MSc Robotics, Systems and Control | 1.5 y (3 semesters) | 90 ECTS (official). Breakdown from a third-party guide: core 36, multidisciplinary electives 6, Science in Perspective 2, semester project 8, industrial internship 8 (12 weeks, mandatory), thesis 30 | Chosen with a tutor from the mechanical, electrical and computer science departments; at least 28 core ECTS before the thesis; typical topics: robot dynamics and kinematics, model predictive control, machine perception, reinforcement learning for robotics, embedded systems, sensor fusion, multi-agent systems | 6 ECTS from the same three departments, plus 2 humanities | 6-month thesis (binding deadline 28 weeks); semester project of about 240 h is a prerequisite |
| University of Michigan [page] | MS Robotics | about 1.5 y | 30 graduate credits, B- or better, GPA 3.0 | ROB 501 Math for Robotics (4), ROB 550 Robotic Systems Laboratory (4); breadth 9 cr with one course each in sensing, reasoning, acting; depth at least 3 cr in one core area | Remaining credits from the course listing (400-level approved, 500+ engineering) | Directed study ROB 590 (3 to 6 cr); thesis not required (ROB 690 optional) |
| Carnegie Mellon, MRSD [snippet] | MS Robotic Systems Development | 21 months | 183 units; first semester courses at 12 units each (Manipulation, Estimation and Control; Systems Engineering and Management for Robotics; Robot Mobility on Air, Land and Sea) | Core as above plus capstone | | Four semesters of coursework plus a summer internship |
| Carnegie Mellon, MSR [snippet] | MS Robotics (research) | about 2 y | core courses, electives, supervised research | | | Master's thesis and public thesis talk |
| University of Edinburgh / Heriot-Watt CDT [page, 2016/17] | MSc by Research Robotics and Autonomous Systems | 1 y research | 180 credits | Robotics: Science and Systems (20), Autonomous Systems Research seminar (30), research thesis (100) | 30 credits taught options | Dissertation (conference paper, industrial report or patent) |
| EPFL [snippet] | Master in Robotics | 1.5 to 2 y | launched 2018 | not retrieved | | |

## 4. PhD level

| University | Award | Duration | Courses or credits | Core | Electives | Exams / milestones |
|---|---|---|---|---|---|---|
| University of Michigan [page] | PhD Robotics | about 4 to 5 y [general] | 36 graduate credits without a master's, 26 with a relevant master's; at least 18 of 36 at Michigan if entering with an outside master's | ROB 501, ROB 550, directed study, breadth (sensing, reasoning, acting), depth, cognate 3 cr outside depth area | per depth/cognate | GPA 3.5 and B+ in all counted courses; proposal defended at least one year before the final defence; original dissertation (qualifying exam details not on the page) |
| Carnegie Mellon Robotics Institute [snippet] | PhD Robotics | 5 to 6 y | coursework in first two years split with research | Course qualifiers (core and specialised), research qualifier, speaking and writing skills, TA experience | | Research qualifier, thesis proposal, thesis defence |
| EPFL EDRS [snippet] | Doctoral School in Robotics, Control and Intelligent Systems | 4 y [general] | set classes plus own projects | | | |
| ETH and partner universities [snippet] | PhD | per professor | | | | PhD positions are individual and professor-driven |

Pattern: 26 to 36 coursework credits, a breadth rule across sensing, reasoning and acting, a research qualifier, a proposal defended a year or more before the final defence, teaching experience, and writing/speaking milestones.

## 5. Common core across universities

- Calculus and linear algebra (Michigan ROB 101, UCT, Glasgow Engineering Maths).
- Programming plus data structures (Michigan EECS 280, WPI computer science unit, Glasgow Introductory Programming and Advanced Programming).
- Circuits and electronics (Michigan EECS 215/270, UCT Analogue Electronics, Glasgow Electronics 1 and 2).
- Dynamics/mechanics (all of Michigan, UCT, Glasgow).
- Embedded systems and real-time computing (UCT, Glasgow Embedded Processors and Real Time Systems, WPI Unified Robotics).
- Control systems (Michigan ROB 314, UCT Control Systems Engineering, Glasgow Control 3 and 4, ETH model predictive control).
- Robot kinematics, planning and manipulation (UCT EEE4119F, Michigan ROB 510, ETH, MIT).
- Perception, vision, and sensor fusion/localisation (Michigan ROB 310/330, ETH machine perception).
- AI and machine learning (Glasgow, Michigan ROB 430, ETH reinforcement learning).
- Robot software: ROS (Michigan ROB 320), Python/C++.
- Team design project and capstone (all).

## 6. Prerequisite chains

Verified: Michigan ROB 204 needs ROB 102 (or ENGR 101/EECS 183/ENGR 151), ENGR 100, and ROB 101 or MATH 214 at the same time or before; ROB 450 needs the robotics core (ROB 310/311/320/330/340), technical communication and junior standing; ROB 510/530 need ROB 501; ROB 516 needs ROB 415 or equivalent or graduate standing. UCT EEE4119F needs MEC2047F (Engineering Dynamics), MEC2045S (Applied Engineering Mechanics) and EEE3094S (Control Systems); EEE3099S needs EEE3088F. Berkeley CS287 recommends probability, linear algebra and an AI course, with PhD students prioritised. MIT 2.12 needs Modeling, Dynamics and Control I and II.

Typical chain [general]: Calculus and Linear Algebra to Dynamics and Signals and Systems to Control Systems to Robot Kinematics and Dynamics to Mobile Robotics and Navigation or Manipulation; Python/C to Data Structures to Embedded Systems to Real-Time Systems to ROS; Probability to State Estimation to Mobile Robotics; Machine Learning to Computer Vision to Robot Learning.

## 7. Representative weekly schedules

### 7.1 Bachelor core: MIT 2.12 Introduction to Robotics (OCW, Fall 2005) [page]
27 lectures; prerequisites 2.003 and 2.004 (Modeling, Dynamics and Control I and II). Assessment: mid-term 30%, end-of-term 30%, homework 20%, lab and design project 20%. Lectures grouped into weeks:

| Week | Topics |
|---|---|
| 1 | Introduction; actuators and drives; control components |
| 2 | Control software; sensors |
| 3 | Kinematics |
| 4 | Differential motion |
| 5 | Statics, energy method |
| 6 | Hybrid position-force control; compliance, end-effector design |
| 7 | Non-holonomic systems; mid-term exam |
| 8 | Legged robots, multi-fingered hands |
| 9 | Dynamics; computed torque control |
| 10 | Sensors (2); computer vision |
| 11 | Navigation |
| 12 | Tele-robotics and virtual reality; end-of-term exam |
| 13 | Final project check-out and demonstration |

A textbook-based alternative (Modern Robotics, Lynch and Park) uses 13 chapters: configuration space, rigid-body motions, forward kinematics, velocity kinematics and statics, inverse kinematics, closed chains, dynamics of open chains, trajectory generation, motion planning, robot control, grasping and manipulation, wheeled mobile robots, plus a mobile-manipulation capstone [page].

### 7.2 Master's core: Berkeley CS287 Advanced Robotics, Fall 2019 [page]
Priority to PhD students; prerequisite: proofs, probability, algorithms, linear algebra, ability to implement algorithms; recommended CS188, EE126, EE127. Assessment: 5 problem sets 60%, final project 30%, midterm 10%. Lectures grouped:

| Week | Topics |
|---|---|
| 1 | Introduction; MDPs: exact methods |
| 2 | Discretisation of continuous MDPs; function approximation |
| 3 | LQR, iterative LQR, differential dynamic programming; unconstrained optimisation |
| 4 | Constrained optimisation; collocation, shooting and MPC |
| 5 | Advanced optimisation-based control; motion planning (RRT, PRM, trajectory optimisation, 3D poses) |
| 6 | Probability review, Bayes filters; Kalman filtering, EKF, UKF |
| 7 | Smoothing, MAP/ML, EM; particle filters |
| 8 | POMDPs; midterm |
| 9 | Imitation learning |
| 10 | RL I: policy gradients; RL II: off-policy |
| 11 | RL III: model-based; how simulators work |
| 12 | Sim-to-real transfer |
| 13 | Paper backstories; autonomous helicopters and wrap-up |
| 14 | Final project presentations |

Companion graduate material (chapter lists only, no week mapping): MIT Robotic Manipulation (12 chapters: pick and place, pose estimation, bin picking, motion planning, mobile manipulation, manipulator control, deep perception, RL, tactile) [page]; MIT Underactuated Robotics (21 chapters in model systems, nonlinear planning and control, estimation and learning) [page].

### 7.3 Doctoral seminar
No public week-by-week doctoral robotics seminar could be retrieved in this session (search budget ran out). The schedule below is **proposed, not sourced**; the format follows the Cambridge reading-seminar pattern (weekly student-led paper presentation plus written critique, see computer-engineering note) and the milestone structure of the Michigan and CMU PhDs.

| Week | Topic |
|---|---|
| 1 | What counts as a robotics research question; reading a paper critically |
| 2 | Survey: state estimation and SLAM |
| 3 | Survey: motion planning and trajectory optimisation |
| 4 | Survey: learning-based control and imitation |
| 5 | Survey: perception for manipulation |
| 6 | Student paper presentations I (3 per session) |
| 7 | Writing a related-work section and a research statement |
| 8 | Student paper presentations II |
| 9 | Benchmarks, simulation and reproducibility |
| 10 | Student paper presentations III |
| 11 | Proposal workshop I (aims, risks, evaluation) |
| 12 | Proposal workshop II (peer review) |
| 13 | Talks: 15-minute research proposal presentations |
| 14 | Teaching statement, ethics and safety; qualifier preparation |

## 8. Gap analysis against the current platform

Current Robotics list (17): calculus, linear-algebra-for-data-science, basic-electronics, programming-with-c, introduction-to-python, digital-logic-design, embedded-systems, sensors-and-actuators, signals-and-systems, control-systems, robot-kinematics-and-dynamics, real-time-systems, robot-programming-with-ros, computer-vision, artificial-intelligence, mobile-robotics-and-navigation, internet-of-things.

| Gap | Seen at | Resolution |
|---|---|---|
| Introductory robotics / robot-building | WPI, Michigan, Glasgow, Heriot-Watt, MIT | New: Introduction to Robotics |
| Statics and dynamics of rigid bodies | Michigan, UCT, Glasgow | New: Engineering Mechanics and Dynamics |
| Capstone / team design | all | New: Robotics Capstone Project |
| Motors, drives, power electronics | UCT (Energy Conversion), Glasgow (Power Electronics) | New: Electric Machines and Drives (elective) |
| Probability, data structures, C++, circuit analysis, numerical methods | Michigan, Glasgow, UCT | Existing: probability-and-statistics, data-structures-and-algorithms, programming-with-cpp, circuit-analysis, numerical-methods-and-computation |
| Machine learning, software engineering | Glasgow, Michigan | Existing: machine-learning, software-engineering |
| Optimal/nonlinear control | ETH, CMU, MIT, Berkeley | New (master's): Nonlinear and Optimal Control |
| State estimation and sensor fusion | ETH, Berkeley, Michigan ROB 530 | New (master's): State Estimation and Sensor Fusion |
| Motion planning and manipulation | MIT, Michigan ROB 510, UCT EEE4119F | New (master's): Motion Planning and Manipulation |
| Robot learning | ETH, Berkeley, Michigan | New (master's): Robot Learning |
| Systems lab | Michigan ROB 550, CMU MRSD, ETH semester project | New (master's): Robotic Systems Laboratory |
| Human-robot interaction | Michigan ROB 204/340, CMU | New (master's): Human-Robot Interaction |
| Research methods | all research degrees | New (master's): Graduate Research Methods (shared) |
| Doctoral seminar; probabilistic inference | CMU, Michigan, Cambridge | New (PhD): Doctoral Research Seminar in Robotics, Probabilistic Graphical Models |

## 9. Proposed structure

### Bachelor (4 years, 26 core plus 6 of 12 electives; pool 38)
Core (study order): *Introduction to Robotics* (new), calculus, linear-algebra-for-data-science, introduction-to-python, programming-with-c, programming-with-cpp, basic-electronics, circuit-analysis, digital-logic-design, probability-and-statistics, data-structures-and-algorithms, *Engineering Mechanics and Dynamics* (new), signals-and-systems, numerical-methods-and-computation, sensors-and-actuators, embedded-systems, control-systems, robot-kinematics-and-dynamics, real-time-systems, robot-programming-with-ros, artificial-intelligence, machine-learning, computer-vision, mobile-robotics-and-navigation, software-engineering, *Robotics Capstone Project* (new).
Electives (6 required): *Electric Machines and Drives* (new), internet-of-things, computer-organization-and-architecture, operating-systems, digital-signal-processing, game-physics-and-simulation, human-computer-interaction, discrete-mathematics, computer-graphics, computer-networking-i, version-control-and-devops, database-systems-and-design.

### Master's (1.5 to 2 years, 6 core plus 4 of 7 electives; pool 13)
Core: Graduate Research Methods (new), Nonlinear and Optimal Control (new), State Estimation and Sensor Fusion (new), Motion Planning and Manipulation (new), Robot Learning (new), Robotic Systems Laboratory (new).
Electives (4 required): deep-learning, reinforcement-learning, optimisation-for-machine-learning, Human-Robot Interaction (new), distributed-systems, responsible-ai, knowledge-representation-and-reasoning.
Milestones: breadth across sensing, reasoning and acting; systems-lab project; industry internship or research placement; thesis or capstone with oral defence.

### PhD (4 to 5 years, 4 core plus 3 of 5 electives; pool 9)
Core: Doctoral Research Seminar in Robotics (new), Graduate Research Methods, Nonlinear and Optimal Control, State Estimation and Sensor Fusion (courses waived when already completed in the master's).
Electives (3 required): Motion Planning and Manipulation, Robot Learning, Probabilistic Graphical Models (new), reinforcement-learning, deep-learning.
Milestones: course/breadth qualifier, research qualifier (by semester 3 or 4), thesis proposal at least one year before the defence, teaching assistantship, writing and speaking requirement, annual progress review, dissertation defence.

New courses: 4 bachelor, 7 master's, 2 PhD. Details are in `proposals/robotics.json` in the session notes folder.

## 10. Limits of this research
- Search budget ran out and CMU pages failed certificate checks, so CMU PhD/MSR/MRSD details are snippet-level; ETH's component breakdown comes from a third-party guide (total of 90 ECTS is official).
- Asia and sub-Saharan Africa: only UCT Mechatronics (a mechatronics, not robotics, degree) was verified; no Asian robotics programme page could be opened.
- The doctoral weekly schedule is proposed, not sourced.
- The Edinburgh MSc table is for 2016/17 and may be out of date.

## 11. Sources (accessed 2026-10)
- Michigan Robotics BSE requirements: https://robotics.umich.edu/academics/undergraduate/program-requirements/
- Michigan Robotics graduate degree requirements: https://robotics.umich.edu/academics/graduate/degree-requirements/
- Michigan Robotics course list (Winter 2026): https://robotics.umich.edu/course-offerings/Winter-2026-Course-List.pdf
- WPI Robotics Engineering sheets (snippet): https://www.wpi.edu/sites/default/files/2024-05/RBE-2025-New_fillable.pdf
- Glasgow Robotics and AI: https://www.gla.ac.uk/undergraduate/2026/robotics-artificial-intelligence/
- Heriot-Watt Robotics, Autonomous and Interactive Systems: https://www.hw.ac.uk/study/undergraduate/robotics-autonomous-and-interactive-systems-meng
- UCT FEBE Undergraduate Handbook 2026: https://onlinecourses.uct.ac.za/sites/default/files/media/documents/2026-ebe-handbook-7a-final-web.pdf
- ETH MSc Robotics, Systems and Control: https://ethz.ch/en/studies/master/degree-programmes/engineering-sciences/robotics-systems-and-control.html and https://inf.ethz.ch/studies/master/master-rsc.html
- ETH programme breakdown (third party): https://www.libertify.com/universities/eth-zurich-msc-robotics-systems-control/
- NCCR Robotics graduate programmes: https://nccr-robotics.ch/education/graduate-programs/
- CMU MRSD handbook and curriculum (snippet): https://mrsd.ri.cmu.edu/wp-content/uploads/2025/09/MRSD-Handbook_25-26.pdf and https://mrsd.ri.cmu.edu/curriculum/
- CMU MSR checklist (snippet): https://www.ri.cmu.edu/app/uploads/2025/11/MSR-Program-Checklist_AY26-1.pdf
- CMU Robotics doctoral program and handbook (snippet): https://www.ri.cmu.edu/education/academic-programs/phd/ and https://www.ri.cmu.edu/app/uploads/2022/08/THE-ROBOTICS-DOCTORAL-HANDBOOK-2022-23.pdf
- Edinburgh DRPS, MSc Robotics and Autonomous Systems 2016/17: https://www.drps.ed.ac.uk/16-17/dpt/prmscrobas1f.htm
- MIT OCW 2.12 Introduction to Robotics: https://ocw.mit.edu/courses/2-12-introduction-to-robotics-fall-2005/pages/syllabus/
- Berkeley CS287 Advanced Robotics (Fall 2019): https://people.eecs.berkeley.edu/~pabbeel/cs287-fa19/
- MIT Robotic Manipulation: https://manipulation.csail.mit.edu/
- MIT Underactuated Robotics: https://underactuated.csail.mit.edu/
- Modern Robotics (Northwestern): http://hades.mech.northwestern.edu/index.php/Modern_Robotics
