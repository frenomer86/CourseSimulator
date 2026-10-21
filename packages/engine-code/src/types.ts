/** Shared shapes for the code runner engine. */

export type CodeLanguage = 'python' | 'javascript';

export const LANGUAGE_LABEL: Record<CodeLanguage, string> = { python: 'Python', javascript: 'JavaScript' };

/** The simulator state of a code lab: what the learner has written. */
export interface CodeState {
  language: CodeLanguage;
  source: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** A short description of the uncaught error, or null when the program finished. */
  error: string | null;
  timeMs: number;
  timedOut?: boolean;
}

/** Something that can execute a program with a given standard input. */
export interface CodeRunner {
  readonly language: CodeLanguage;
  run(source: string, stdin?: string, timeoutMs?: number): Promise<RunResult>;
}

export const DEFAULT_TIMEOUT_MS = 8000;
