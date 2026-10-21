/**
 * Scenario engine: a case study is a graph of nodes. Each node shows a situation (Markdown),
 * optional evidence items to examine, optional written-answer prompts, and choices. A choice
 * leads to another node and may change the score and set flags. The learner's state is the
 * path taken, the flags collected, the score, what they examined and what they wrote.
 */

export interface Evidence {
  id: string;
  title: string;
  /** Markdown. */
  text: string;
  /** Optional kind shown as a small label: email, log, policy, interview, document, photo. */
  kind?: string;
}

export interface Prompt {
  id: string;
  label: string;
  /** Hint shown under the box. */
  hint?: string;
  minWords?: number;
}

export interface Choice {
  id: string;
  text: string;
  next: string;
  /** Added to the score when chosen (may be negative). */
  score?: number;
  /** Flags set when chosen. */
  flags?: string[];
  /** Shown after choosing, before moving on. Markdown. */
  feedback?: string;
  /** Evidence that must have been examined before this choice is available. */
  requires?: string[];
}

export interface ScenarioNode {
  id: string;
  title: string;
  /** Markdown. */
  text: string;
  evidence?: Evidence[];
  prompts?: Prompt[];
  choices?: Choice[];
  /** An ending. The outcome text is shown and no choices are offered. */
  end?: boolean;
  /** Optional label for the ending shown as a badge: good, mixed, bad. */
  outcome?: 'good' | 'mixed' | 'bad';
}

export interface ScenarioSpec {
  start: string;
  nodes: ScenarioNode[];
}

export interface Step {
  node: string;
  choice: string;
}

export interface ScenarioState {
  current: string;
  path: Step[];
  flags: string[];
  score: number;
  viewed: string[];
  answers: Record<string, string>;
  /** Feedback from the last choice, cleared on the next move. */
  lastFeedback?: string;
}

export function validateScenario(raw: unknown): raw is ScenarioSpec {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Record<string, unknown>;
  if (typeof s.start !== 'string' || !Array.isArray(s.nodes) || s.nodes.length === 0) return false;
  const ids = new Set<string>();
  for (const n of s.nodes as Array<Record<string, unknown>>) {
    if (!n || typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.text !== 'string') return false;
    if (ids.has(n.id)) return false;
    ids.add(n.id);
    if (n.choices !== undefined && !Array.isArray(n.choices)) return false;
    if (n.evidence !== undefined && !Array.isArray(n.evidence)) return false;
    if (n.prompts !== undefined && !Array.isArray(n.prompts)) return false;
  }
  if (!ids.has(s.start)) return false;
  for (const n of s.nodes as ScenarioNode[]) {
    for (const c of n.choices ?? []) {
      if (typeof c.id !== 'string' || typeof c.text !== 'string' || !ids.has(c.next)) return false;
    }
    if (!n.end && (n.choices ?? []).length === 0) return false;
  }
  return true;
}

export function nodeById(spec: ScenarioSpec, id: string): ScenarioNode | undefined {
  return spec.nodes.find((n) => n.id === id);
}

export function startScenario(spec: ScenarioSpec): ScenarioState {
  return { current: spec.start, path: [], flags: [], score: 0, viewed: [], answers: {} };
}

export function currentNode(spec: ScenarioSpec, state: ScenarioState): ScenarioNode {
  return nodeById(spec, state.current) ?? nodeById(spec, spec.start)!;
}

/** Whether a choice can be taken now (its required evidence has been examined). */
export function choiceAvailable(choice: Choice, state: ScenarioState): boolean {
  return (choice.requires ?? []).every((e) => state.viewed.includes(e));
}

export function viewEvidence(state: ScenarioState, evidenceId: string): ScenarioState {
  return state.viewed.includes(evidenceId) ? state : { ...state, viewed: [...state.viewed, evidenceId] };
}

export function setAnswer(state: ScenarioState, promptId: string, text: string): ScenarioState {
  return { ...state, answers: { ...state.answers, [promptId]: text } };
}

/** Takes a choice from the current node. Unknown or unavailable choices leave the state unchanged. */
export function choose(spec: ScenarioSpec, state: ScenarioState, choiceId: string): ScenarioState {
  const node = currentNode(spec, state);
  const choice = (node.choices ?? []).find((c) => c.id === choiceId);
  if (!choice || !choiceAvailable(choice, state) || !nodeById(spec, choice.next)) return state;
  return {
    ...state,
    current: choice.next,
    path: [...state.path, { node: node.id, choice: choice.id }],
    flags: [...new Set([...state.flags, ...(choice.flags ?? [])])],
    score: state.score + (choice.score ?? 0),
    lastFeedback: choice.feedback,
  };
}

export function isFinished(spec: ScenarioSpec, state: ScenarioState): boolean {
  return currentNode(spec, state).end === true;
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Every node reachable from the start, for authoring checks. */
export function reachableNodes(spec: ScenarioSpec): Set<string> {
  const seen = new Set<string>();
  const stack = [spec.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const c of nodeById(spec, id)?.choices ?? []) stack.push(c.next);
  }
  return seen;
}
