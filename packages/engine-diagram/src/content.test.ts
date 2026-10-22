/**
 * Every E9 lab must be solvable: a reference diagram per lab id passes every check,
 * and the starter text does not.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createDiagramChecks, type DiagramState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');

const SOLUTIONS: Record<string, DiagramState> = {
  'software-engineering-b1-use-case-diagram': {
    source: `diagram: usecase
actor Student
actor Officer "Hostel officer"
usecase UC0 "Log in"
usecase UC1 "Search rooms"
usecase UC2 "Book room"
usecase UC3 "Pay hostel fee"
usecase UC4 "Verify payment"
usecase UC5 "Apply for fee waiver"
usecase UC6 "Allocate room"
usecase UC7 "Generate occupancy report"
Student -> UC1
Student -> UC2
Student -> UC3
Officer -> UC6
Officer -> UC7
UC3 ..> UC4 : include
UC5 ..> UC3 : extend
UC2 ..> UC0 : include
UC6 ..> UC0 : include`,
  },
  'software-engineering-b2-class-diagram': {
    source: `diagram: class
class Person {
  +name: string
  +email: string
}
class Student {
  +indexNumber: string
  +book(room: Room)
}
class Officer {
  +staffId: string
}
class Booking {
  +academicYear: string
  +status: string
}
class Room {
  +number: string
  +capacity: int
}
class Hostel {
  +name: string
}
Person <|-- Student
Person <|-- Officer
Student "1" -- "*" Booking : makes
Room "1" -- "*" Booking : for
Hostel "1" *-- "*" Room : contains`,
  },
  'software-engineering-i1-sequence-and-state': {
    source: `diagram: sequence
participant Student
participant Portal
participant MobileMoney
participant BookingService
Student ->> Portal : payFee(amount)
Portal ->> MobileMoney : charge(amount)
alt success
MobileMoney -->> Portal : ok
Portal ->> BookingService : confirmBooking()
Portal -->> Student : receipt
else declined
MobileMoney -->> Portal : declined
Portal -->> Student : error
end`,
  },
  'software-architecture-and-design-patterns-i1-transaction-state-machine': {
    source: `diagram: state
[*] --> Initiated
Initiated --> Pending : submit
Pending --> Completed : provider_ok
Pending --> Failed : provider_error
Pending --> Reversed : cancel
Failed --> Pending : retry [attempts < 1]
Completed --> [*]
Reversed --> [*]
Failed --> [*]`,
  },
  'object-oriented-system-analysis-and-design-b1-context-and-level-0-dfd': {
    source: `diagram: dfd
entity Applicant
entity Registry
process P1 "Receive application"
process P2 "Assess application"
process P3 "Issue decision"
store D1 "Applications"
store D2 "Programme requirements"
Applicant -> P1 : application form
P1 -> D1 : application record
D1 -> P2 : application
D2 -> P2 : programme requirements
P2 -> D1 : assessment result
D1 -> P3 : assessed application
P3 -> Applicant : admission decision
P3 -> Registry : admitted students list`,
  },
  'object-oriented-system-analysis-and-design-b2-er-diagram': {
    source: `diagram: er
PATIENT {
  int id PK
  string name
  date dob
}
DOCTOR {
  int id PK
  string name
  string specialty
}
APPOINTMENT {
  int id PK
  date date
  string notes
}
PRESCRIPTION {
  int id PK
  string drug
  string dosage
}
PATIENT ||--o{ APPOINTMENT : attends
DOCTOR ||--o{ APPOINTMENT : conducts
APPOINTMENT ||--o| PRESCRIPTION : produces`,
  },
  'business-process-modelling-b1-bpmn-gateways': {
    source: `diagram: bpmn
S((Start))
A[Receive beans]
P1{+}
W[Weigh beans]
G[Grade beans]
P2{+}
X1{X Accepted?}
R[Issue receipt]
Y[Pay farmer]
B[Return beans]
X2{X}
E((End))
S --> A
A --> P1
P1 --> W
P1 --> G
W --> P2
G --> P2
P2 --> X1
X1 -->|yes| R
X1 -->|no| B
R --> Y
Y --> X2
B --> X2
X2 --> E
lane Clerk: A, W, G
lane Cashier: R, Y`,
  },
  'it-project-management-i1-critical-path': {
    source: `diagram: cpm
A "Survey buildings" 4
B "Order access points" 15 after A
C "Run cabling" 10 after A
D "Install switches" 5 after C
E "Mount access points" 6 after B, D
F "Configure controller" 3 after B
G "Test and hand over" 4 after E, F`,
    answers: { duration: '29', slackF: '3', alt: 'A, C, D, E, G', altDuration: '29' },
  },
  'human-computer-interaction-b1-navigation-map': {
    source: `diagram: flow
Login[Login] -->|sign in| Home[Home]
Home -->|tap Results| Results[Results]
Home -->|tap Transcript| Transcript[Transcript request]
Home -->|tap Profile| Profile[Profile]
Home -->|tap Help| Help[Help]
Results -->|tap a result| Detail[Result detail]
Detail -->|back| Results
Results -->|help| Help
Profile -->|help| Help
Transcript -->|submit| Confirm{Confirm?}
Confirm -->|yes| Home
Confirm -->|no| Transcript
Profile -->|log out| Login`,
  },
  'requirements-engineering-i1-use-cases-with-include-extend': {
    source: `diagram: usecase
actor Agent
actor Customer
actor Supervisor
Agent <|-- Supervisor
usecase Reg "Register customer"
usecase CashIn "Cash-in"
usecase CashOut "Cash-out"
usecase Float "View float balance"
usecase Send "Send money"
usecase Airtime "Buy airtime"
usecase PIN "Verify PIN"
usecase OTP "Request OTP"
usecase Approve "Approve float top-up"
Agent -> Reg
Agent -> CashIn
Agent -> CashOut
Agent -> Float
Customer -> Send
Customer -> Airtime
Supervisor -> Approve
CashIn ..> PIN : include
CashOut ..> PIN : include
Send ..> PIN : include
Airtime ..> PIN : include
OTP ..> CashOut : extend`,
  },
};

function allLabs(): LabSpec<DiagramState>[] {
  const out: LabSpec<DiagramState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<DiagramState>;
      if (raw.engine === 'E9') out.push(raw);
    }
  }
  return out;
}

describe('E9 lab content', () => {
  const checks = createDiagramChecks();
  const labs = allLabs();
  it('finds the diagram labs', () => {
    expect(labs.length).toBeGreaterThanOrEqual(10);
  });
  for (const lab of labs) {
    describe(lab.id, () => {
      it('has a solution and only diagram.* checks', () => {
        expect(SOLUTIONS[lab.id], `no reference solution for ${lab.id}`).toBeDefined();
        for (const c of lab.checks) expect(c.type.startsWith('diagram.'), c.type).toBe(true);
      });
      it('does not pass as given', async () => {
        const r = await checks.run(lab, { source: lab.initialState?.source ?? '' });
        expect(r.passed).toBe(false);
      });
      it('passes with the reference diagram', async () => {
        const r = await checks.run(lab, SOLUTIONS[lab.id]);
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
