/**
 * Debug helper: run shell commands (one per line in a file; a line may contain \n for heredocs)
 * on a fresh simulated machine, in one session so $? and variables carry over.
 *   npx vite-node packages/task-bank/scripts/sh.ts commands.txt [spec.json | windows]
 * "windows" starts a default Windows Server estate and runs the lines as PowerShell.
 */
import { readFileSync } from 'node:fs';
import { buildSystem, newSession, runLine, winSystemSpec, type SystemSpec } from '@cslab/engine-shell';

const [cmdFile, specFile] = process.argv.slice(2).filter((a) => a !== '--');
const spec: SystemSpec = specFile === 'windows' ? (winSystemSpec({}) as unknown as SystemSpec) : specFile ? JSON.parse(readFileSync(specFile, 'utf8')) : { user: 'root', hostname: 'srv1' };
const sys = buildSystem(spec);
const session = newSession(sys);
const cmds = readFileSync(cmdFile, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => l.replace(/\\n/g, '\n'));
for (const c of cmds) console.log(`$ ${c.split('\n')[0]}\n${runLine(sys, c, session).output}`);
