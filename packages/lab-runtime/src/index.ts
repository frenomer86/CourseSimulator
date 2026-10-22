/**
 * Lab runtime: the contract between lab content (JSON) and simulation engines.
 * Labs are data. Engines register check handlers. The runtime runs the checks.
 */

export type LabLevel = 'beginner' | 'intermediate' | 'advanced';

export type EngineId =
  | 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6'
  | 'E7' | 'E8' | 'E9' | 'E10' | 'E11' | 'E12';

/** A single machine-checkable assertion against simulator state. */
export interface CheckSpec {
  /** Handler name, e.g. "logic.truthTable". Namespaced by engine. */
  type: string;
  /** Short sentence shown to the learner, e.g. "Y equals A AND B for every input". */
  label: string;
  /** Handler-specific parameters. */
  [key: string]: unknown;
}

export interface LabSpec<TState = unknown> {
  id: string;
  course: string;
  /** Human topic name shown under the lab title. */
  topic: string;
  /** Optional position in the course syllabus: 1-based unit and topic numbers (data/courses.json). */
  unit?: number;
  topicIndex?: number;
  level: LabLevel;
  engine: EngineId;
  title: string;
  /** Markdown instructions. */
  instructions: string;
  /** Engine-specific starting state (for example a pre-built circuit). */
  initialState?: TState;
  /** Engine-specific configuration (for example which gates the palette offers). */
  config?: Record<string, unknown>;
  hints: string[];
  checks: CheckSpec[];
  estimatedMinutes: number;
  /** Shown after completion: where the simulation differs from real equipment. */
  realityNote?: string;
}

export interface CheckResult {
  type: string;
  label: string;
  passed: boolean;
  /** Specific feedback: what was wrong, or confirmation. */
  message: string;
  /** Optional structured detail for the UI (for example failing truth-table rows). */
  detail?: unknown;
}

export interface LabResult {
  labId: string;
  passed: boolean;
  score: number; // 0..1
  checks: CheckResult[];
  completedAt: string; // ISO date
}

export type CheckHandler<TState = unknown> = (
  state: TState,
  spec: CheckSpec,
  /** The whole lab, for checks that need its config (for example a circuit or a parts list). */
  lab: LabSpec<TState>,
) => CheckResult | Promise<CheckResult>;

export class CheckRegistry<TState = unknown> {
  private handlers = new Map<string, CheckHandler<TState>>();

  register(type: string, handler: CheckHandler<TState>): this {
    this.handlers.set(type, handler);
    return this;
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  async run(spec: LabSpec<TState>, state: TState): Promise<LabResult> {
    const checks: CheckResult[] = [];
    for (const check of spec.checks) {
      const handler = this.handlers.get(check.type);
      if (!handler) {
        checks.push({
          type: check.type,
          label: check.label,
          passed: false,
          message: `No checker is installed for "${check.type}". This is a content error, not yours.`,
        });
        continue;
      }
      try {
        checks.push(await handler(state, check, spec));
      } catch (err) {
        checks.push({
          type: check.type,
          label: check.label,
          passed: false,
          message: `The checker failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    const passedCount = checks.filter((c) => c.passed).length;
    return {
      labId: spec.id,
      passed: checks.length > 0 && passedCount === checks.length,
      score: checks.length === 0 ? 0 : passedCount / checks.length,
      checks,
      completedAt: new Date().toISOString(),
    };
  }
}

export const LEVEL_ORDER: LabLevel[] = ['beginner', 'intermediate', 'advanced'];

export const LEVEL_LABEL: Record<LabLevel, string> = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
};

export function validateLabSpec(raw: unknown): raw is LabSpec {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  if (s.unit !== undefined && !(Number.isInteger(s.unit) && (s.unit as number) >= 1)) return false;
  if (s.topicIndex !== undefined && !(Number.isInteger(s.topicIndex) && (s.topicIndex as number) >= 1)) return false;
  return (
    typeof s.id === 'string' &&
    typeof s.course === 'string' &&
    typeof s.title === 'string' &&
    typeof s.instructions === 'string' &&
    LEVEL_ORDER.includes(s.level as LabLevel) &&
    Array.isArray(s.checks) &&
    Array.isArray(s.hints)
  );
}

export * from './progress';
export * from './topicCheck';
export * from './xapiProfile';
export * from './analytics';
