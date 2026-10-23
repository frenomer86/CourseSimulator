/**
 * Every E6 lab written after this test must be solvable: hand-worked answers (and, for input tasks,
 * a learner input) pass every check, and the untouched starter does not. The answers are typed
 * here, not computed from the trace, so a wrong trace fails the test.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LabSpec } from '@cslab/lab-runtime';
import { createVisualiserChecks, type AlgorithmInput, type VizState } from './index.js';

const ROOT = join(__dirname, '..', '..', '..', 'content', 'courses');
const LEGACY = new Set(['data-structures-and-algorithms', 'fundamentals-of-computer-science']);

const SOLUTIONS: Record<string, { input?: AlgorithmInput; answers: Record<string, string> }> = {
  "theory-of-computation-i1-a-dfa-for-multiples-of-three": {
    "input": {
      "automaton": {
        "states": [
          "r0",
          "r1",
          "r2"
        ],
        "alphabet": [
          "0",
          "1"
        ],
        "start": "r0",
        "accept": [
          "r0"
        ],
        "transitions": [
          [
            "r0",
            "0",
            "r0"
          ],
          [
            "r0",
            "1",
            "r1"
          ],
          [
            "r1",
            "0",
            "r2"
          ],
          [
            "r1",
            "1",
            "r0"
          ],
          [
            "r2",
            "0",
            "r1"
          ],
          [
            "r2",
            "1",
            "r2"
          ]
        ]
      },
      "word": "10010"
    },
    "answers": {
      "q1": "r1",
      "q2": "no",
      "q3": "r0, r1, r0, r0",
      "q4": "yes"
    }
  },
  "artificial-intelligence-i1-a-star-from-accra-to-tamale": {
    "answers": {
      "q1": "Accra, Koforidua, Yeji, Tamale",
      "q2": "595",
      "q3": "630",
      "q4": "6",
      "q5": "370"
    }
  },
  "artificial-intelligence-i2-minimax-and-alpha-beta": {
    "answers": {
      "q1": "4",
      "q2": "B",
      "q3": "3",
      "q4": "6",
      "q5": "C2, C3, D3"
    }
  },
  "knowledge-representation-and-reasoning-i1-forward-and-backward-chaining": {
    "answers": {
      "q1": "R1, R2, R3, R4, R5",
      "q2": "5",
      "q3": "R1, R3, R4, R5",
      "q4": "8",
      "q5": "4"
    }
  },
  "mobile-robotics-and-navigation-i1-plan-a-path-across-the-warehouse": {
    "answers": {
      "q1": "12",
      "q2": "42",
      "q3": "13",
      "q4": "12"
    }
  },
  "sequence-analysis-and-alignment-i1-needleman-wunsch-step-by-step": {
    "answers": {
      "q1": "1",
      "q2": "0",
      "q3": "2",
      "q4": "G-ATTACA",
      "q5": "GCA-TGCA",
      "q6": "5"
    }
  }
};

function allLabs(): LabSpec<VizState>[] {
  const out: LabSpec<VizState>[] = [];
  for (const course of readdirSync(ROOT)) {
    const dir = join(ROOT, course);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as LabSpec<VizState>;
      if (raw.engine === 'E6') out.push(raw);
    }
  }
  return out;
}

describe('E6 lab content', () => {
  const checks = createVisualiserChecks();
  for (const lab of allLabs()) {
    if (LEGACY.has(lab.course)) continue;
    describe(lab.id, () => {
      const starter = lab.initialState as VizState;
      it('has hand-worked answers', () => {
        expect(SOLUTIONS[lab.id], `no answers for ${lab.id}`).toBeDefined();
      });
      it('does not pass untouched', async () => {
        const r = await checks.run(lab, { input: starter.input, answers: {} });
        expect(r.passed).toBe(false);
      });
      it('passes with the hand-worked answers', async () => {
        const sol = SOLUTIONS[lab.id];
        const r = await checks.run(lab, { input: sol.input ?? starter.input, answers: sol.answers });
        const failing = r.checks.filter((c) => !c.passed).map((c) => `${c.label}: ${c.message}`);
        if (failing.length) throw new Error(`Failing checks:\n${failing.join('\n')}`);
        expect(r.passed).toBe(true);
      });
    });
  }
});
