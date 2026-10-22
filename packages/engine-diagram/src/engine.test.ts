import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { bpmnProblems, classProblems, computeCpm, createDiagramChecks, dfdProblems, layoutDiagram, parseDiagram, stateProblems, usecaseProblems, type DiagramState } from './index.js';

describe('notation', () => {
  it('parses a use case diagram with include and extend', () => {
    const d = parseDiagram('actor Student\nactor Bursar\nusecase UC1 "Register for course"\nUC2(Pay fees)\nUC3(Verify payment)\nStudent -> UC1\nStudent -> UC2\nBursar -> UC3\nUC2 ..> UC3 : <<include>>\nUC4(Apply for waiver)\nUC4 ..> UC2 : extend', 'usecase');
    expect(d.errors).toEqual([]);
    expect(d.nodes.map((n) => `${n.kind}:${n.id}`)).toEqual(['actor:Student', 'actor:Bursar', 'usecase:UC1', 'usecase:UC2', 'usecase:UC3', 'usecase:UC4']);
    expect(d.edges.find((e) => e.from === 'UC2' && e.to === 'UC3')?.kind).toBe('include');
    expect(d.edges.find((e) => e.from === 'UC4')?.kind).toBe('extend');
    expect(usecaseProblems(d)).toEqual([]);
  });
  it('parses classes with members, multiplicities and inheritance', () => {
    const d = parseDiagram('class Student {\n  +id: int\n  +name: string\n  +register(course: Course)\n}\nclass Course {\n  +code: string\n}\nclass Enrolment {\n  +grade: string\n}\nStudent "1" -- "*" Enrolment : has\nCourse "1" -- "*" Enrolment\nPerson <|-- Student\nclass Person {\n  +name: string\n}', 'class');
    expect(d.errors).toEqual([]);
    expect(d.nodes.find((n) => n.id === 'Student')?.members).toEqual(['+id: int', '+name: string', '+register(course: Course)']);
    const has = d.edges.find((e) => e.label === 'has')!;
    expect([has.from, has.fromCard, has.to, has.toCard]).toEqual(['Student', '1', 'Enrolment', '*']);
    const gen = d.edges.find((e) => e.kind === 'generalisation')!;
    expect([gen.from, gen.to]).toEqual(['Student', 'Person']);
    expect(classProblems(d)).toEqual([]);
  });
  it('parses sequence messages in order with fragments', () => {
    const d = parseDiagram('participant Student\nparticipant Portal\nparticipant Bank\nStudent ->> Portal : pay(fees)\nPortal ->> Bank : charge(amount)\nalt success\nBank -->> Portal : ok\nPortal -->> Student : receipt\nelse declined\nBank -->> Portal : declined\nend', 'sequence');
    expect(d.errors).toEqual([]);
    expect(d.edges.map((e) => `${e.seq}:${e.kind}:${e.label}`)).toEqual(['1:message:pay(fees)', '2:message:charge(amount)', '3:return:ok', '4:return:receipt', '5:return:declined']);
    expect(d.fragments.map((f) => `${f.kind}:${f.from}-${f.to}`)).toEqual(['alt:3-4', 'else:5-5']);
  });
  it('parses state machines and ER crow\'s feet', () => {
    const s = parseDiagram('[*] --> Pending\nPending --> Paid : payment received\nPending --> Cancelled : timeout\nPaid --> Shipped : dispatch\nShipped --> [*]', 'state');
    expect(s.errors).toEqual([]);
    expect(stateProblems(s)).toEqual([]);
    expect(s.edges.find((e) => e.to === 'Paid')?.label).toBe('payment received');
    const e = parseDiagram('STUDENT {\n  int id PK\n  string name\n}\nENROLMENT {\n  int id PK\n  string grade\n}\nCOURSE {\n  string code PK\n}\nSTUDENT ||--o{ ENROLMENT : enrols\nCOURSE ||--|{ ENROLMENT : has', 'er');
    expect(e.errors).toEqual([]);
    const rel = e.edges[0];
    expect([rel.from, rel.fromCard, rel.to, rel.toCard, rel.label]).toEqual(['STUDENT', '1', 'ENROLMENT', '0..*', 'enrols']);
    expect(e.edges[1].toCard).toBe('1..*');
  });
  it('parses flows and data flow diagrams and applies their rules', () => {
    const b = parseDiagram('S((Start))\nA[Receive order]\nG{X Paid?}\nB[Issue receipt]\nC[Send reminder]\nJ{X}\nE((End))\nS --> A\nA --> G\nG -->|yes| B\nG -->|no| C\nB --> J\nC --> J\nJ --> E', 'bpmn');
    expect(b.errors).toEqual([]);
    expect(b.nodes.find((n) => n.id === 'G')?.kind).toBe('gateway-exclusive');
    expect(bpmnProblems(b)).toEqual([]);
    const bad = parseDiagram('S((Start))\nA[Receive order]\nA --> B[Issue receipt]\nA --> C[Send reminder]', 'bpmn');
    expect(bpmnProblems(bad).map((p) => p.message)).toContain('Task Receive order has 2 outgoing flows; use a gateway to split the flow.');
    const dfd = parseDiagram('entity Customer\nprocess P1 "Validate order"\nstore D1 "Orders"\nCustomer -> P1 : order details\nP1 -> D1 : valid order\nP1 -> Customer : confirmation', 'dfd');
    expect(dfd.errors).toEqual([]);
    expect(dfdProblems(dfd)).toEqual([]);
    const miracle = parseDiagram('entity Customer\nprocess P1 "Report"\nstore D1 "Orders"\nP1 -> Customer : report\nCustomer -> D1 : stuff', 'dfd');
    expect(dfdProblems(miracle).map((p) => p.message)).toEqual([
      'Process Report has no input: a process cannot produce data from nothing (a "miracle").',
      'Data cannot flow directly from Customer to Orders: every flow must pass through a process.',
    ]);
  });
  it('reports lines it cannot read and lays diagrams out', () => {
    const d = parseDiagram('actor A\nthis is not valid ???', 'usecase');
    expect(d.errors).toEqual([{ line: 2, message: 'cannot read this line: this is not valid ???' }]);
    const l = layoutDiagram(parseDiagram('A --> B\nB --> C\nA --> C', 'flow'));
    expect(l.nodes.map((n) => n.id)).toEqual(['A', 'B', 'C']);
    expect(l.nodes[2].x).toBeGreaterThan(l.nodes[1].x);
  });
});

describe('critical path', () => {
  const net = 'diagram: cpm\nA "Survey site" 3\nB "Order equipment" 10 after A\nC "Hire staff" 4 after A\nD "Install cabling" 6 after B\nE "Train staff" 2 after C\nF "Go live" 1 after D, E';
  it('computes ES, LS, slack and the critical path', () => {
    const r = computeCpm(parseDiagram(net, 'cpm'));
    expect(r.ok).toBe(true);
    expect(r.duration).toBe(20);
    expect(r.criticalPath).toEqual(['A', 'B', 'D', 'F']);
    const c = r.activities.find((a) => a.id === 'C')!;
    expect([c.es, c.ef, c.ls, c.lf, c.slack]).toEqual([3, 7, 13, 17, 10]);
  });
  it('handles PERT estimates and cycles', () => {
    const r = computeCpm(parseDiagram('A "x" 2,4,12\nB "y" 1,2,3 after A', 'cpm'));
    expect(r.activities[0].duration).toBeCloseTo(5, 2);
    expect(r.duration).toBeCloseTo(7, 2);
    expect(r.sigma).toBeCloseTo(Math.sqrt(Math.pow(10 / 6, 2) + Math.pow(2 / 6, 2)), 4);
    expect(computeCpm(parseDiagram('A "x" 2 after B\nB "y" 1 after A', 'cpm')).error).toMatch(/cycle/);
  });
});

describe('diagram.* checks', () => {
  const checks = createDiagramChecks();
  const lab = (kind: string, specs: LabSpec['checks']): LabSpec<DiagramState> => ({ id: 'x', course: 'c', topic: 't', level: 'beginner', engine: 'E9', title: 'x', instructions: '', hints: [], checks: specs, estimatedMinutes: 1, config: { kind } });
  it('judges nodes, edges, rules, members, order and cpm', async () => {
    const spec = lab('class', [
      { type: 'diagram.parses', label: 'parses' },
      { type: 'diagram.node', label: 'student class', kind: 'class', pattern: 'Student' },
      { type: 'diagram.edge', label: 'student has enrolments', from: 'Student', to: 'Enrolment', kind: 'association', fromCard: '1', toCard: '*' },
      { type: 'diagram.member', label: 'name attribute', class: 'Student', member: 'name' },
      { type: 'diagram.rules', label: 'rules' },
      { type: 'diagram.edge', label: 'inherits', from: 'Student', to: 'Person', kind: 'generalisation' },
    ]);
    const good: DiagramState = { source: 'class Person {\n +name: string\n}\nclass Student {\n +name: string\n}\nclass Enrolment {\n +grade: string\n}\nStudent "1" -- "*" Enrolment : has\nPerson <|-- Student' };
    const r = await checks.run(spec, good);
    expect(r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`)).toEqual([]);
    const bad = await checks.run(spec, { source: 'class Student {\n +name: string\n}\nclass Enrolment {\n +grade: string\n}\nStudent --> Enrolment' });
    expect(bad.checks[2].message).toMatch(/multiplicities/);
    expect(bad.checks[5].passed).toBe(false);
    const cpmSpec = lab('cpm', [{ type: 'diagram.cpm', label: 'cp', duration: 20, critical: ['A', 'B', 'D', 'F'], slack: { C: 10 } }, { type: 'diagram.answer', label: 'q', id: 'q', expected: ['A,B,D,F'] }]);
    const r2 = await checks.run(cpmSpec, { source: 'A "s" 3\nB "o" 10 after A\nC "h" 4 after A\nD "i" 6 after B\nE "t" 2 after C\nF "g" 1 after D, E', answers: { q: 'A -> B -> D -> F' } });
    expect(r2.checks.map((c) => c.passed)).toEqual([true, true]);
    const seqSpec = lab('sequence', [{ type: 'diagram.order', label: 'order', messages: ['login', 'validate', 'token'] }]);
    const r3 = await checks.run(seqSpec, { source: 'A ->> B : login(user)\nB ->> C : validate(user)\nC -->> B : ok\nB -->> A : token' });
    expect(r3.passed).toBe(true);
  });
});
