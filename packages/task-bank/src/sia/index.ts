/** Scripting and IT Automation: task templates for all eight units, three levels per topic. */
import type { TaskTemplate } from '../types';
import { U1 } from './u1';
import { U2 } from './u2';
import { U3 } from './u3';
import { U4 } from './u4';
import { U5 } from './u5';
import { U6 } from './u6';
import { U7 } from './u7';
import { U8 } from './u8';

export const TEMPLATES: TaskTemplate[] = [...U1, ...U2, ...U3, ...U4, ...U5, ...U6, ...U7, ...U8];
