// Transforms data/htu-curriculum-2022.json (code-based) into data/courses.json (name-based, extensible),
// adds the courses and programmes defined in data/programmes.json, and attaches data/syllabi/<slug>.json.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const src = JSON.parse(fs.readFileSync(path.join(root, 'data/htu-curriculum-2022.json'), 'utf8'));

const slugify = (s) =>
  s.toLowerCase().replace(/c\+\+/g, 'cpp').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const LEVELS = ['beginner', 'intermediate', 'advanced'];
const ENGINES = new Set(Array.from({ length: 12 }, (_, i) => `E${i + 1}`));
const TIERS = ['bachelor', 'master', 'phd'];

const programmeFile = JSON.parse(fs.readFileSync(path.join(root, 'data/programmes.json'), 'utf8'));

const AREAS = {
  programming: 'Programming and Software Development',
  'maths-theory': 'Mathematics and Theory',
  hardware: 'Hardware, Electronics and Architecture',
  'networks-systems': 'Networks, Systems and Cloud',
  data: 'Databases and Data Science',
  'software-practice': 'Software Engineering and Practice',
  'security-ethics': 'Security, Forensics and Ethics',
  ai: 'Artificial Intelligence and Machine Learning',
  ...programmeFile.areas,
};

const areaByCode = {
  'BCSC 101': 'programming', 'BCSC 102': 'programming', 'BCSC 207': 'programming', 'BCSC 212': 'programming',
  'BCSC 209': 'programming', 'BCSC 208': 'programming', 'BCSC 413': 'programming', 'BCSC 410': 'programming',
  'BCSC 202': 'programming',
  'BCSC 103': 'maths-theory', 'BCSC 104': 'maths-theory', 'BCSC 108': 'maths-theory', 'BCSC 211': 'maths-theory', 'BCSC 204': 'maths-theory',
  'BCSC 105': 'hardware', 'BCSC 106': 'hardware', 'BCSC 205': 'hardware', 'BCSC 311': 'hardware', 'BCSC 408': 'hardware',
  'BCSC 201': 'networks-systems', 'BCSC 206': 'networks-systems', 'BCSC 210': 'networks-systems', 'BCSC 305': 'networks-systems',
  'BCSC 405': 'networks-systems', 'BCSC 404': 'networks-systems', 'BCSC 411': 'networks-systems',
  'BCSC 203': 'data', 'BCSC 409': 'data', 'BCSC 406': 'data',
  'BCSC 301': 'software-practice', 'BCSC 303': 'software-practice', 'BCSC 307': 'software-practice', 'BCSC 309': 'software-practice', 'BCSC 107': 'software-practice',
  'BCSC 401': 'security-ethics', 'BCSC 403': 'security-ethics', 'BCSC 402': 'security-ethics',
  'BCSC 407': 'ai',
};

const htu = src.courses
  .filter((c) => c.inScope)
  .map((c) => ({
    slug: slugify(c.title),
    title: c.title,
    area: areaByCode[c.code],
    year: c.level / 100,
    semester: c.semester,
    engines: c.engines,
    topics: c.topics,
    phase: c.phase,
    source: 'htu-btech-cs-2022',
    reference: { code: c.code, theory: c.theory, practical: c.practical, credits: c.credits, type: c.type },
  }));

// Common Computer Science courses that the HTU curriculum does not list.
const extended = [
  { title: 'Programming with C', area: 'programming', year: 1, semester: 2, engines: ['E1', 'E6'], phase: 2,
    topics: ['C syntax, types and operators', 'Control flow and functions', 'Arrays and strings', 'Pointers and memory', 'Structures and unions', 'File handling', 'The preprocessor and compilation'] },
  { title: 'Data Communications', area: 'networks-systems', year: 2, semester: 1, engines: ['E7', 'E3'], phase: 3,
    topics: ['Signals, bandwidth and noise', 'Analog and digital transmission', 'Line coding and modulation', 'Multiplexing', 'Error detection and correction', 'Flow control and switching', 'Transmission media'] },
  { title: 'Version Control and DevOps', area: 'networks-systems', year: 2, semester: 2, engines: ['E4', 'E1'], phase: 2,
    topics: ['Git basics: commit, branch, merge', 'Remote repositories and pull requests', 'Resolving conflicts', 'Continuous integration pipelines', 'Containers', 'Automated testing and deployment', 'Monitoring and rollback'] },
  { title: 'Information Systems and E-Commerce', area: 'software-practice', year: 2, semester: 2, engines: ['E10', 'E5'], phase: 3,
    topics: ['Types of information systems', 'Business processes and ERP', 'E-commerce models and payments', 'Mobile money and fintech', 'Customer data and CRM', 'Information systems strategy', 'Evaluation and ROI'] },
  { title: 'Assembly Language and Microprocessors', area: 'hardware', year: 2, semester: 2, engines: ['E6'], phase: 3,
    topics: ['Microprocessor architecture and registers', 'Instruction formats and addressing modes', 'Arithmetic and logic instructions', 'Branching, loops and subroutines', 'Stack and interrupts', 'Memory and I/O interfacing', 'Assembling, linking and debugging'] },
  { title: 'Theory of Computation', area: 'maths-theory', year: 3, semester: 1, engines: ['E6'], phase: 3,
    topics: ['Alphabets, strings and languages', 'Finite automata (DFA, NFA)', 'Regular expressions', 'Context-free grammars and pushdown automata', 'Turing machines', 'Decidability and the halting problem', 'Complexity classes P and NP'] },
  { title: 'Embedded Systems', area: 'hardware', year: 3, semester: 1, engines: ['E8', 'E1'], phase: 3,
    topics: ['Microcontroller architecture', 'GPIO, timers and PWM', 'Interrupts', 'ADC and sensors', 'Serial communication: UART, I2C, SPI', 'Real-time scheduling basics', 'Low-power design'] },
  { title: 'Computer Graphics', area: 'programming', year: 3, semester: 1, engines: ['E1', 'E7'], phase: 3,
    topics: ['Raster and vector graphics', 'Line and circle drawing algorithms', '2D and 3D transformations', 'Viewing and projection', 'Clipping and hidden surfaces', 'Shading and lighting', 'Introduction to WebGL'] },
  { title: 'Human-Computer Interaction', area: 'software-practice', year: 3, semester: 1, engines: ['E9', 'E10'], phase: 3,
    topics: ['Usability principles and heuristics', 'User research and personas', 'Prototyping and wireframes', 'Interaction design patterns', 'Accessibility', 'Usability evaluation', 'Designing for low-bandwidth and mobile users'] },
  { title: 'Machine Learning', area: 'ai', year: 4, semester: 1, engines: ['E1', 'E6'], phase: 3,
    topics: ['Supervised and unsupervised learning', 'Linear and logistic regression', 'Decision trees and ensembles', 'Neural networks and backpropagation', 'Model evaluation and overfitting', 'Feature engineering', 'Ethics and bias in ML'] },
  { title: 'Cryptography and Network Security', area: 'security-ethics', year: 4, semester: 1, engines: ['E7', 'E3'], phase: 3,
    topics: ['Classical ciphers', 'Symmetric encryption: AES and modes', 'Public-key cryptography: RSA, Diffie-Hellman, elliptic curves', 'Hash functions and MACs', 'Digital signatures and PKI', 'TLS and secure protocols', 'Key management'] },
  { title: 'Distributed Systems', area: 'networks-systems', year: 4, semester: 1, engines: ['E3', 'E6'], phase: 3,
    topics: ['Client-server and peer-to-peer models', 'Remote procedure calls and messaging', 'Time, clocks and ordering', 'Replication and consistency', 'Consensus: Paxos and Raft', 'Fault tolerance', 'Distributed storage'] },
  { title: 'Compiler Construction', area: 'programming', year: 4, semester: 2, engines: ['E1', 'E6'], phase: 3,
    topics: ['Lexical analysis', 'Parsing: top-down and bottom-up', 'Abstract syntax trees', 'Semantic analysis and symbol tables', 'Intermediate code', 'Optimisation', 'Code generation'] },
  { title: 'Big Data and Parallel Computing', area: 'data', year: 4, semester: 2, engines: ['E1', 'E6'], phase: 3,
    topics: ['Characteristics of big data', 'MapReduce and distributed file systems', 'Spark-style dataflow', 'Threads, locks and parallel speed-up', 'GPU and SIMD concepts', 'Stream processing', 'Scaling and cost'] },
  { title: 'Blockchain and Distributed Ledgers', area: 'security-ethics', year: 4, semester: 2, engines: ['E6', 'E1'], phase: 3,
    topics: ['Hashing and Merkle trees', 'Blocks, chains and immutability', 'Proof of work and proof of stake', 'Wallets, keys and transactions', 'Smart contracts', 'Use cases: land registry, supply chain, payments', 'Limitations and regulation'] },
].map((c) => ({ slug: slugify(c.title), ...c, source: 'extended' }));

// Courses that the programmes beyond Computer Science need (data/programmes.json).
const programmeCourses = programmeFile.newCourses.map((c) => ({ slug: slugify(c.title), ...c, source: 'programmes' }));

// Optional detailed syllabi (data/syllabi/<slug>.json) modelled on top-university courses.
const syllabusDir = path.join(root, 'data/syllabi');
const syllabi = fs.existsSync(syllabusDir)
  ? Object.fromEntries(
      fs.readdirSync(syllabusDir).filter((f) => f.endsWith('.json')).map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(syllabusDir, f), 'utf8'));
        return [s.slug, s];
      }),
    )
  : {};
for (const c of [...htu, ...extended, ...programmeCourses]) {
  c.level = c.level ?? 'bachelor';
  const s = syllabi[c.slug];
  if (s) {
    c.description = s.description;
    c.modelledOn = s.modelledOn;
    c.outcomes = s.outcomes;
    c.syllabus = s.units;
    // The weekly schedule stays in the syllabus file (the web app loads it per course); the catalogue only
    // records how many weeks there are, which keeps data/courses.json small.
    if (s.schedule) {
      checkSchedule(c.slug, s.units, s.schedule);
      c.weeks = s.schedule.length;
    }
  }
}

// A schedule lays the course out as 12 or 13 weeks. Topics are "unit.topic" refs (1-based), so labs and task
// templates that attach by unit and topicIndex keep working; every topic must be taught in some week.
function checkSchedule(slug, units, schedule) {
  const fail = (msg) => { throw new Error(`${slug} schedule: ${msg}`); };
  if (schedule.length < 12 || schedule.length > 13) fail(`${schedule.length} weeks`);
  const refs = new Set(units.flatMap((u, i) => u.topics.map((_, t) => `${i + 1}.${t + 1}`)));
  const taught = new Set();
  schedule.forEach((w, i) => {
    if (w.week !== i + 1) fail(`week ${i + 1} is numbered ${w.week}`);
    if (!w.title || !w.exercise) fail(`week ${w.week} needs a title and an exercise`);
    if (!w.topics?.length) fail(`week ${w.week} has no topics`);
    for (const r of w.topics) {
      if (!refs.has(r)) fail(`week ${w.week} names unknown topic ${r}`);
      taught.add(r);
    }
    for (const level of LEVELS) if (!w.tasks?.some((t) => t.level === level)) fail(`week ${w.week} has no ${level} task`);
    for (const t of w.tasks) {
      if (!LEVELS.includes(t.level) || !ENGINES.has(t.engine) || !t.title) fail(`week ${w.week} has a bad task ${JSON.stringify(t)}`);
      if (!w.topics.includes(t.topic)) fail(`week ${w.week} task names topic ${t.topic} outside the week`);
    }
  });
  const missed = [...refs].filter((r) => !taught.has(r));
  if (missed.length) fail(`topics never scheduled: ${missed.join(', ')}`);
}

const courses = [...htu, ...extended, ...programmeCourses].sort((a, b) => a.year - b.year || a.semester - b.semester || a.title.localeCompare(b.title));
const slugs = new Set();
for (const c of courses) {
  if (slugs.has(c.slug)) throw new Error('duplicate slug ' + c.slug);
  slugs.add(c.slug);
  if (!AREAS[c.area]) throw new Error('bad area ' + c.area + ' for ' + c.title);
  if (!TIERS.includes(c.level)) throw new Error('bad level ' + c.level + ' for ' + c.title);
}
const missingSchedule = courses.filter((c) => c.syllabus && !c.weeks).map((c) => c.slug);
if (missingSchedule.length) console.warn('courses without a weekly schedule yet:', missingSchedule.join(', '));
const missingSyllabus = courses.filter((c) => !c.syllabus).map((c) => c.slug);
if (missingSyllabus.length) console.warn('courses without a syllabus yet:', missingSyllabus.join(', '));

// Programmes: ordered course lists. "__ALL_ORIGINAL__" is the Computer Science programme's 53 courses.
const original = courses.filter((c) => c.source !== 'programmes').map((c) => c.slug);
// A programme may define levels (bachelor, master, phd), each with core and elective courses; its `courses` list is
// then the bachelor's core followed by its electives.
const checkList = (where, list) => {
  for (const slug of list) if (!slugs.has(slug)) throw new Error(`${where} lists unknown course ${slug}`);
  if (new Set(list).size !== list.length) throw new Error(`${where} lists a course twice`);
};
const programmes = programmeFile.programmes.map((p) => {
  let levels;
  if (p.levels) {
    levels = {};
    for (const tier of TIERS) {
      const l = p.levels[tier];
      if (!l) throw new Error(`programme ${p.slug} has no ${tier} level`);
      checkList(`programme ${p.slug} ${tier}`, [...l.core, ...l.electives]);
      levels[tier] = { award: l.award, years: l.years, core: l.core, electives: l.electives, electivesRequired: l.electivesRequired, milestones: l.milestones ?? [] };
    }
  }
  const list = levels ? [...levels.bachelor.core, ...levels.bachelor.electives] : p.courses === '__ALL_ORIGINAL__' ? original : p.courses;
  checkList(`programme ${p.slug}`, list);
  return { slug: p.slug, title: p.title, description: p.description, outcomes: p.outcomes, recommended: !!p.recommended, courses: list, ...(levels && { levels }) };
});
const inProgramme = (p, slug) => p.courses.includes(slug) || TIERS.some((t) => p.levels?.[t].core.includes(slug) || p.levels?.[t].electives.includes(slug));
const unused = courses.filter((c) => !programmes.some((p) => inProgramme(p, c.slug))).map((c) => c.slug);
if (unused.length) throw new Error('courses in no programme: ' + unused.join(', '));

const out = {
  $comment: 'Course catalogue for the CS Virtual Lab. Courses are identified by slug and shown by name; institutional codes are kept only as reference metadata. Generated by build-courses.mjs from htu-curriculum-2022.json, the extended list and programmes.json. Do not edit by hand.',
  areas: AREAS,
  years: { 1: 'Year 1', 2: 'Year 2', 3: 'Year 3', 4: 'Year 4', 5: "Master's", 6: 'Doctoral' },
  levels: { bachelor: "Bachelor's", master: "Master's", phd: 'Doctoral' },
  programmes,
  courses,
};
fs.writeFileSync(path.join(root, 'data/courses.json'), JSON.stringify(out, null, 2) + '\n');
console.log('courses:', courses.length, 'htu:', htu.length, 'extended:', extended.length, 'programme courses:', programmeCourses.length, 'programmes:', programmes.length);
