/**
 * Monitoring tools: promtool (check metrics for the text exposition format, check rules with a
 * PromQL parser and type checker) and amtool (check-config
 * and config routes test for Alertmanager's routing tree).
 */

import { readFile } from './fs.js';
import { actor, type Ctx } from './shell.js';
import { abs, type IO } from './util.js';
import { parseYaml, type Yaml } from './yaml.js';

type Cmd = (args: string[], io: IO, ctx: Ctx) => number;

/* ----------------------------------------------------------------------------- exposition format */

const METRIC = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Problems promtool check metrics reports (lint and parse errors), empty when the text is fine. */
export function lintMetrics(text: string): { errors: string[]; lint: string[] } {
  const errors: string[] = [];
  const lint: string[] = [];
  const types: Record<string, string> = {};
  const helps = new Set<string>();
  const seen = new Set<string>();
  const families = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const at = `text format parsing error in line ${i + 1}`;
    if (!line) return;
    if (line.startsWith('#')) {
      const m = /^#\s+(HELP|TYPE)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!m) return;
      if (!METRIC.test(m[2])) errors.push(`${at}: invalid metric name in comment`);
      if (m[1] === 'TYPE') {
        if (!['counter', 'gauge', 'histogram', 'summary', 'untyped'].includes(m[3] ?? '')) errors.push(`${at}: unknown metric type "${m[3] ?? ''}"`);
        if (types[m[2]]) errors.push(`${at}: second TYPE line for metric name "${m[2]}", or TYPE reported after samples`);
        types[m[2]] = m[3] ?? '';
      } else helps.add(m[2]);
      return;
    }
    const sm = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(\S+)(?:\s+(-?\d+))?$/.exec(line);
    if (!sm) {
      errors.push(`${at}: ${/^\S+\{/.test(line) && !line.includes('}') ? 'unexpected end of label value' : /^[^a-zA-Z_:]/.test(line) ? 'invalid metric name' : 'expected float as value'}`);
      return;
    }
    const [, name, , labelText, value] = sm;
    if (!/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$|^[-+]?Inf$|^NaN$/.test(value)) errors.push(`${at}: expected float as value, got "${value}"`);
    const labels: Record<string, string> = {};
    if (labelText !== undefined && labelText.trim()) {
      const re = /\s*([^=\s,]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(,|$)/y;
      let pos = 0;
      while (pos < labelText.length) {
        re.lastIndex = pos;
        const lm = re.exec(labelText);
        if (!lm) {
          errors.push(`${at}: expected label value, got "${labelText.slice(pos).trim()}"`);
          break;
        }
        if (!LABEL.test(lm[1])) errors.push(`${at}: invalid label name "${lm[1]}"`);
        if (labels[lm[1]] !== undefined) errors.push(`${at}: duplicate label names for metric "${name}"`);
        labels[lm[1]] = lm[2];
        pos = re.lastIndex;
      }
    }
    const base = name.replace(/_(bucket|sum|count|total|created)$/, '');
    const fam = types[name] ? name : types[base] ? base : name;
    families.add(fam);
    const key = name + JSON.stringify(Object.entries(labels).sort());
    if (seen.has(key)) errors.push(`${at}: duplicate metric ${name}${labelText ? `{${labelText}}` : ''}`);
    seen.add(key);
    if (types[fam] === 'counter' && !name.endsWith('_total')) lint.push(`${name} counter metrics should have "_total" suffix`);
    if (/[A-Z]/.test(name)) lint.push(`${name} metric names should be written in 'snake_case' not 'camelCase'`);
    if (/_(milliseconds|millis|ms)(_|$)/.test(name)) lint.push(`${name} use base unit "seconds" instead of "milliseconds"`);
    if (types[fam] === 'histogram' && name.endsWith('_bucket') && labels.le === undefined) errors.push(`${at}: histogram bucket without "le" label`);
  });
  for (const f of families) if (!helps.has(f)) lint.push(`${f} no help text`);
  return { errors, lint: [...new Set(lint)] };
}

/* ----------------------------------------------------------------------------- PromQL */

type PType = 'scalar' | 'vector' | 'matrix' | 'string';

const FUNCTIONS: Record<string, { args: PType[]; ret: PType; variadic?: boolean; optional?: number }> = {
  rate: { args: ['matrix'], ret: 'vector' },
  irate: { args: ['matrix'], ret: 'vector' },
  increase: { args: ['matrix'], ret: 'vector' },
  delta: { args: ['matrix'], ret: 'vector' },
  idelta: { args: ['matrix'], ret: 'vector' },
  deriv: { args: ['matrix'], ret: 'vector' },
  changes: { args: ['matrix'], ret: 'vector' },
  resets: { args: ['matrix'], ret: 'vector' },
  avg_over_time: { args: ['matrix'], ret: 'vector' },
  min_over_time: { args: ['matrix'], ret: 'vector' },
  max_over_time: { args: ['matrix'], ret: 'vector' },
  sum_over_time: { args: ['matrix'], ret: 'vector' },
  count_over_time: { args: ['matrix'], ret: 'vector' },
  last_over_time: { args: ['matrix'], ret: 'vector' },
  quantile_over_time: { args: ['scalar', 'matrix'], ret: 'vector' },
  absent_over_time: { args: ['matrix'], ret: 'vector' },
  predict_linear: { args: ['matrix', 'scalar'], ret: 'vector' },
  histogram_quantile: { args: ['scalar', 'vector'], ret: 'vector' },
  absent: { args: ['vector'], ret: 'vector' },
  abs: { args: ['vector'], ret: 'vector' },
  ceil: { args: ['vector'], ret: 'vector' },
  floor: { args: ['vector'], ret: 'vector' },
  round: { args: ['vector', 'scalar'], ret: 'vector', optional: 1 },
  clamp_min: { args: ['vector', 'scalar'], ret: 'vector' },
  clamp_max: { args: ['vector', 'scalar'], ret: 'vector' },
  scalar: { args: ['vector'], ret: 'scalar' },
  vector: { args: ['scalar'], ret: 'vector' },
  time: { args: [], ret: 'scalar' },
  sort: { args: ['vector'], ret: 'vector' },
  sort_desc: { args: ['vector'], ret: 'vector' },
  label_replace: { args: ['vector', 'string', 'string', 'string', 'string'], ret: 'vector' },
  timestamp: { args: ['vector'], ret: 'vector' },
};
const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count', 'stddev', 'stdvar', 'topk', 'bottomk', 'quantile', 'count_values', 'group']);
const KEYWORDS = new Set(['by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'bool', 'offset', 'and', 'or', 'unless']);

interface PNode {
  kind: 'num' | 'str' | 'sel' | 'fn' | 'agg' | 'bin' | 'neg' | 'paren';
  type: PType;
  name?: string;
  value?: number;
  matchers?: Array<{ name: string; op: string; value: string }>;
  range?: number;
  args?: PNode[];
  op?: string;
  lhs?: PNode;
  rhs?: PNode;
  grouping?: { without: boolean; labels: string[] };
  boolMod?: boolean;
}

class PromError extends Error {}

export function durationMs(s: string): number | null {
  let total = 0;
  const re = /(\d+)(ms|y|w|d|h|m|s)/y;
  let pos = 0;
  if (!s) return null;
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    total += Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31536000000 }[m[2] as 's'];
    pos = re.lastIndex;
  }
  return total;
}

/** Parses and type-checks a PromQL expression; throws PromError with Prometheus's wording. */
export function parsePromQL(src: string): PNode {
  let i = 0;
  const err = (msg: string): never => {
    throw new PromError(`1:${i + 1}: parse error: ${msg}`);
  };
  const ws = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  const peek = (re: RegExp) => {
    ws();
    re.lastIndex = i;
    const m = re.exec(src);
    return m && m.index === i ? m[0] : null;
  };
  const eat = (s: string) => {
    ws();
    if (src.startsWith(s, i)) {
      i += s.length;
      return true;
    }
    return false;
  };
  const ident = () => peek(/[a-zA-Z_:][a-zA-Z0-9_:]*/y);
  const labelList = (): string[] => {
    if (!eat('(')) err('unexpected token, expected "("');
    const out: string[] = [];
    while (!eat(')')) {
      const id = ident();
      if (!id) err(`unexpected character inside braces: '${src[i] ?? ''}'`);
      i += id!.length;
      out.push(id!);
      if (!eat(',') && peek(/\)/y) === null) err('unexpected character in grouping opts, expected "," or ")"');
    }
    return out;
  };
  const selector = (name: string | null): PNode => {
    const matchers: NonNullable<PNode['matchers']> = [];
    if (eat('{')) {
      while (!eat('}')) {
        const id = ident();
        if (!id) err(`unexpected character inside braces: '${src[i] ?? 'EOF'}'`);
        i += id!.length;
        const op = peek(/=~|!~|!=|=/y);
        if (!op) err(`unexpected identifier "${id}" in label matching, expected label matching operator`);
        i += op!.length;
        ws();
        const q = src[i];
        if (q !== '"' && q !== "'") err(`unexpected character after label matching operator, expected string`);
        const end = src.indexOf(q, i + 1);
        if (end < 0) err('unterminated quoted string');
        const value = src.slice(i + 1, end);
        i = end + 1;
        if (op === '=~' || op === '!~') {
          try {
            new RegExp(`^(?:${value})$`);
          } catch {
            err(`error parsing regexp: invalid regular expression "${value}"`);
          }
        }
        matchers.push({ name: id!, op: op!, value });
        if (!eat(',') && peek(/\}/y) === null) err('unexpected character inside braces, expected "," or "}"');
      }
    }
    if (!name && !matchers.some((m) => m.value !== '' && (m.op === '=' || m.op === '=~'))) err('vector selector must contain at least one non-empty matcher');
    const node: PNode = { kind: 'sel', type: 'vector', name: name ?? undefined, matchers };
    if (peek(/\[/y)) {
      eat('[');
      const d = peek(/[0-9a-z]+/y);
      if (!d || durationMs(d) === null) err(`bad duration syntax: "${d ?? ''}"`);
      i += d!.length;
      if (!eat(']')) err('unexpected character in range, expected "]"');
      node.type = 'matrix';
      node.range = durationMs(d!)!;
    }
    if (peek(/offset\b/y)) {
      eat('offset');
      const d = peek(/-?[0-9a-z]+/y);
      if (!d || durationMs(d.replace(/^-/, '')) === null) err(`bad duration syntax: "${d ?? ''}"`);
      i += d!.length;
    }
    return node;
  };
  const primary = (): PNode => {
    ws();
    if (i >= src.length) err('unexpected end of input');
    if (eat('(')) {
      const e = expr(0);
      if (!eat(')')) err(`unclosed left parenthesis`);
      const node: PNode = { kind: 'paren', type: e.type, args: [e] };
      if (peek(/\[/y)) {
        // A subquery: (expr)[5m:1m].
        eat('[');
        const d = peek(/[0-9a-z:]+/y);
        i += d?.length ?? 0;
        if (!eat(']')) err('unexpected character in subquery, expected "]"');
        node.type = 'matrix';
      }
      return node;
    }
    if (eat('-')) {
      const e = primary();
      return { kind: 'neg', type: e.type, args: [e] };
    }
    const num = peek(/(\d+(\.\d+)?([eE][-+]?\d+)?|\.\d+|Inf|NaN)\b/y);
    if (num) {
      i += num.length;
      return { kind: 'num', type: 'scalar', value: Number(num) };
    }
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      if (end < 0) err('unterminated quoted string');
      const value = src.slice(i + 1, end);
      i = end + 1;
      return { kind: 'str', type: 'string', name: value };
    }
    if (src[i] === '{') return selector(null);
    const id = ident();
    if (!id) err(`unexpected character: '${src[i]}'`);
    if (KEYWORDS.has(id!) && id !== 'bool') err(`unexpected <${id}>`);
    i += id!.length;
    if (AGGREGATIONS.has(id!)) {
      let grouping: PNode['grouping'];
      if (peek(/(by|without)\b/y)) {
        const w = peek(/(by|without)\b/y)!;
        i += w.length;
        grouping = { without: w === 'without', labels: labelList() };
      }
      if (!eat('(')) err(`unexpected identifier "${id}"`);
      const args: PNode[] = [];
      if (!eat(')')) {
        do args.push(expr(0));
        while (eat(','));
        if (!eat(')')) err('unexpected token, expected ")" in aggregation');
      }
      if (peek(/(by|without)\b/y)) {
        const w = peek(/(by|without)\b/y)!;
        i += w.length;
        grouping = { without: w === 'without', labels: labelList() };
      }
      const param = ['topk', 'bottomk', 'quantile', 'count_values'].includes(id!);
      if (args.length !== (param ? 2 : 1)) err(`wrong number of arguments for aggregate expression provided, expected ${param ? 2 : 1}, got ${args.length}`);
      const v = args[args.length - 1];
      if (v.type !== 'vector') throw new PromError(`expected type instant vector in aggregation expression, got ${v.type === 'matrix' ? 'range vector' : v.type}`);
      return { kind: 'agg', type: 'vector', name: id!, args, grouping };
    }
    if (peek(/\(/y) && (FUNCTIONS[id!] || /^[a-z_]+$/.test(id!))) {
      const f = FUNCTIONS[id!];
      if (!f) err(`unknown function with name "${id}"`);
      eat('(');
      const args: PNode[] = [];
      if (!eat(')')) {
        do args.push(expr(0));
        while (eat(','));
        if (!eat(')')) err(`unclosed left parenthesis`);
      }
      const min = f!.args.length - (f!.optional ?? 0);
      if (args.length < min || args.length > f!.args.length) throw new PromError(`expected ${f!.args.length} argument(s) in call to "${id}", got ${args.length}`);
      args.forEach((a, k) => {
        const want = f!.args[k];
        if (a.type !== want && !(want === 'scalar' && a.type === 'scalar')) throw new PromError(`expected type ${want === 'matrix' ? 'range vector' : want === 'vector' ? 'instant vector' : want} in call to function "${id}", got ${a.type === 'matrix' ? 'range vector' : a.type === 'vector' ? 'instant vector' : a.type}`);
      });
      return { kind: 'fn', type: f!.ret, name: id!, args };
    }
    return selector(id!);
  };
  const PREC: Record<string, number> = { or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '<=': 3, '>=': 3, '<': 3, '>': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, atan2: 5, '^': 6 };
  const expr = (minPrec: number): PNode => {
    let lhs = primary();
    for (;;) {
      const op = peek(/(==|!=|<=|>=|<|>|\+|-|\*|\/|%|\^|and\b|or\b|unless\b)/y);
      if (!op || PREC[op] < minPrec || PREC[op] === undefined) break;
      i += op.length;
      let boolMod = false;
      if (peek(/bool\b/y)) {
        i += 4;
        boolMod = true;
      }
      if (peek(/(on|ignoring)\b/y)) {
        i += peek(/(on|ignoring)\b/y)!.length;
        labelList();
        if (peek(/(group_left|group_right)\b/y)) {
          i += peek(/(group_left|group_right)\b/y)!.length;
          if (peek(/\(/y)) labelList();
        }
      }
      const rhs = expr(op === '^' ? PREC[op] : PREC[op] + 1);
      for (const side of [lhs, rhs]) if (side.type === 'matrix' || side.type === 'string') throw new PromError(`binary expression must contain only scalar and instant vector types`);
      if (['and', 'or', 'unless'].includes(op) && (lhs.type !== 'vector' || rhs.type !== 'vector')) throw new PromError(`set operator "${op}" not allowed in binary scalar expression`);
      lhs = { kind: 'bin', type: lhs.type === 'scalar' && rhs.type === 'scalar' ? 'scalar' : 'vector', op, lhs, rhs, boolMod };
    }
    return lhs;
  };
  try {
    const e = expr(0);
    ws();
    if (i < src.length) err(src[i] === ')' ? "unexpected right parenthesis ')'" : `unexpected character: '${src[i]}'`);
    return e;
  } catch (e) {
    if (e instanceof PromError) throw e;
    throw new PromError((e as Error).message);
  }
}

/* ----------------------------------------------------------------------------- rule files */

const y = (v: Yaml | undefined): Record<string, Yaml> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function checkRules(text: string): { rules: number; errors: string[] } {
  let doc: Yaml;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { rules: 0, errors: [`yaml: ${(e as Error).message}`] };
  }
  const errors: string[] = [];
  const top = y(doc);
  for (const k of Object.keys(top)) if (k !== 'groups') errors.push(`yaml: unmarshal errors:\n  field ${k} not found in type rulefmt.RuleGroups`);
  const groups = Array.isArray(top.groups) ? top.groups : [];
  if (!groups.length && !errors.length) errors.push('no rule groups found');
  let rules = 0;
  const names = new Set<string>();
  groups.forEach((gRaw) => {
    const g = y(gRaw);
    const gname = typeof g.name === 'string' ? g.name : '';
    if (!gname) errors.push('Groupname must not be empty');
    if (names.has(gname)) errors.push(`groupname: "${gname}" is repeated in the same file`);
    names.add(gname);
    for (const k of Object.keys(g)) if (!['name', 'interval', 'rules', 'limit', 'query_offset', 'labels'].includes(k)) errors.push(`yaml: unmarshal errors:\n  field ${k} not found in type rulefmt.RuleGroup`);
    if (g.interval !== undefined && durationMs(String(g.interval)) === null) errors.push(`group "${gname}": not a valid duration string: "${String(g.interval)}"`);
    (Array.isArray(g.rules) ? g.rules : []).forEach((rRaw, idx) => {
      const r = y(rRaw);
      rules++;
      const label = `group "${gname}", rule ${idx + 1}, ${r.alert !== undefined ? `"${String(r.alert)}"` : r.record !== undefined ? `"${String(r.record)}"` : '""'}`;
      for (const k of Object.keys(r)) if (!['alert', 'record', 'expr', 'for', 'keep_firing_for', 'labels', 'annotations'].includes(k)) errors.push(`${label}: field ${k} not found in type rulefmt.Rule`);
      if (r.alert !== undefined && r.record !== undefined) errors.push(`${label}: only one of 'record' and 'alert' must be set`);
      if (r.alert === undefined && r.record === undefined) errors.push(`${label}: one of 'record' or 'alert' must be set`);
      if (r.record !== undefined && !METRIC.test(String(r.record))) errors.push(`${label}: invalid recording rule name: ${String(r.record)}`);
      if (r.record !== undefined && (r.for !== undefined || r.annotations !== undefined)) errors.push(`${label}: invalid field 'for' in recording rule`);
      if (r.for !== undefined && durationMs(String(r.for)) === null) errors.push(`${label}: not a valid duration string: "${String(r.for)}"`);
      if (typeof r.expr !== 'string' || !r.expr.trim()) errors.push(`${label}: field 'expr' must be set in rule`);
      else {
        try {
          const n = parsePromQL(r.expr);
          if (n.type !== 'vector' && n.type !== 'scalar') errors.push(`${label}: could not parse expression: invalid expression type "${n.type === 'matrix' ? 'range vector' : n.type}" for range query, must be Scalar or instant Vector`);
        } catch (e) {
          errors.push(`${label}: could not parse expression: ${(e as Error).message}`);
        }
      }
      for (const [k] of Object.entries(y(r.labels))) if (!LABEL.test(k)) errors.push(`${label}: invalid label name: ${k}`);
      for (const [k, v] of Object.entries(y(r.annotations))) {
        if (!LABEL.test(k)) errors.push(`${label}: invalid annotation name: ${k}`);
        const s = String(v);
        if ((s.match(/\{\{/g) ?? []).length !== (s.match(/\}\}/g) ?? []).length) errors.push(`${label}: annotation "${k}": template: __alert_${String(r.alert)}:1: unexpected "}" in operand`);
      }
    });
  });
  return { rules, errors };
}

/* ----------------------------------------------------------------------------- Alertmanager */

interface Route {
  receiver?: string;
  matchers: Array<{ name: string; op: string; value: string }>;
  continue: boolean;
  routes: Route[];
  groupBy?: string[];
}

function parseMatcher(s: string): { name: string; op: string; value: string } | null {
  const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"?([^"]*)"?\s*$/.exec(s);
  return m ? { name: m[1], op: m[2], value: m[3] } : null;
}

function toRoute(r: Record<string, Yaml>, errors: string[], path: string): Route {
  const matchers: Route['matchers'] = [];
  for (const [k, v] of Object.entries(y(r.match))) matchers.push({ name: k, op: '=', value: String(v) });
  for (const [k, v] of Object.entries(y(r.match_re))) matchers.push({ name: k, op: '=~', value: String(v) });
  for (const m of Array.isArray(r.matchers) ? r.matchers : []) {
    const p = parseMatcher(String(m));
    if (!p) errors.push(`bad matcher format: ${String(m)}`);
    else matchers.push(p);
  }
  for (const k of Object.keys(r)) if (!['receiver', 'match', 'match_re', 'matchers', 'continue', 'routes', 'group_by', 'group_wait', 'group_interval', 'repeat_interval', 'mute_time_intervals', 'active_time_intervals'].includes(k)) errors.push(`yaml: unmarshal errors:\n  line ?: field ${k} not found in type config.plain (${path})`);
  return { receiver: typeof r.receiver === 'string' ? r.receiver : undefined, matchers, continue: String(r.continue) === 'true', routes: (Array.isArray(r.routes) ? r.routes : []).map((c, k) => toRoute(y(c), errors, `${path}.routes[${k}]`)), groupBy: Array.isArray(r.group_by) ? r.group_by.map(String) : undefined };
}

function loadAlertmanager(text: string): { route?: Route; receivers: string[]; errors: string[]; inhibit: number } {
  const errors: string[] = [];
  let doc: Yaml;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { receivers: [], errors: [`yaml: ${(e as Error).message}`], inhibit: 0 };
  }
  const top = y(doc);
  for (const k of Object.keys(top)) if (!['global', 'route', 'receivers', 'inhibit_rules', 'templates', 'time_intervals', 'mute_time_intervals'].includes(k)) errors.push(`yaml: unmarshal errors:\n  field ${k} not found in type config.plain`);
  const receivers = (Array.isArray(top.receivers) ? top.receivers : []).map((r) => String(y(r).name ?? ''));
  for (const r of Array.isArray(top.receivers) ? top.receivers : []) {
    const rr = y(r);
    for (const k of ['webhook_configs', 'email_configs', 'slack_configs']) for (const c of Array.isArray(rr[k]) ? rr[k] : []) if (k === 'webhook_configs' && !/^https?:\/\//.test(String(y(c).url ?? ''))) errors.push(`unsupported scheme "" for URL`);
  }
  if (top.route === undefined) errors.push('no routes provided');
  const route = top.route !== undefined ? toRoute(y(top.route), errors, 'route') : undefined;
  if (route && !route.receiver) errors.push('root route must specify a default receiver');
  if (route && route.matchers.length) errors.push('root route must not have any matchers');
  const used = (r: Route): string[] => [...(r.receiver ? [r.receiver] : []), ...r.routes.flatMap(used)];
  for (const n of route ? used(route) : []) if (!receivers.includes(n)) errors.push(`undefined receiver "${n}" used in route`);
  const dup = receivers.find((n, k) => receivers.indexOf(n) !== k);
  if (dup) errors.push(`notification config name "${dup}" is not unique`);
  return { route, receivers, errors, inhibit: Array.isArray(top.inhibit_rules) ? top.inhibit_rules.length : 0 };
}

function matches(r: Route, labels: Record<string, string>): boolean {
  return r.matchers.every((m) => {
    const v = labels[m.name] ?? '';
    if (m.op === '=') return v === m.value;
    if (m.op === '!=') return v !== m.value;
    const re = new RegExp(`^(?:${m.value})$`);
    return m.op === '=~' ? re.test(v) : !re.test(v);
  });
}

/** The receivers an alert with these labels reaches, as Alertmanager's routing tree decides. */
export function routeAlert(root: Route, labels: Record<string, string>): string[] {
  const walk = (r: Route, inherited: string): string[] => {
    const recv = r.receiver ?? inherited;
    const out: string[] = [];
    for (const c of r.routes) {
      if (!matches(c, labels)) continue;
      out.push(...walk(c, recv));
      if (!c.continue) return out;
    }
    return out.length ? out : [recv];
  };
  return walk(root, root.receiver ?? '');
}

/* ----------------------------------------------------------------------------- the commands */

function readArg(ctx: Ctx, io: IO, p: string): string | null {
  try {
    return readFile(ctx.sys.fs, abs(ctx, p), actor(ctx));
  } catch {
    io.err(`  FAILED: open ${p}: no such file or directory\n`);
    return null;
  }
}

const promtool: Cmd = (args, io, ctx) => {
  const [group, verb, ...rest] = args;
  if (group === '--version') {
    io.out('promtool, version 2.54.1 (branch: HEAD, revision: e6cfa720fbe6280153fab13090a483dbd40bece3)\n');
    return 0;
  }
  if (group === 'check' && verb === 'metrics') {
    const { errors, lint } = lintMetrics(io.stdin);
    for (const e of errors) io.err(`error while linting: ${e}\n`);
    for (const l of lint) io.err(`${l}\n`);
    return errors.length ? 1 : lint.length ? 3 : 0;
  }
  if (group === 'check' && (verb === 'rules' || verb === 'config')) {
    const files = rest.filter((a) => !a.startsWith('-'));
    if (!files.length) {
      io.err(`error: required argument 'rule-files' not provided\n`);
      return 1;
    }
    let failed = false;
    for (const f of files) {
      io.out(`Checking ${f}\n`);
      const text = readArg(ctx, io, f);
      if (text === null) {
        failed = true;
        continue;
      }
      if (verb === 'config') {
        const doc = y(parseYaml(text));
        const rf = Array.isArray(doc.rule_files) ? doc.rule_files.map(String) : [];
        io.out(` SUCCESS: ${f} is valid prometheus config file syntax\n`);
        for (const r of rf) {
          const t = readArg(ctx, io, r.startsWith('/') ? r : `${abs(ctx, f).slice(0, abs(ctx, f).lastIndexOf('/'))}/${r}`);
          if (t === null) failed = true;
        }
        continue;
      }
      const r = checkRules(text);
      if (r.errors.length) {
        failed = true;
        io.err(`  FAILED:\n${r.errors.map((e) => `${f}: ${e}\n`).join('')}`);
      } else io.out(`  SUCCESS: ${r.rules} rules found\n`);
      io.out('\n');
    }
    return failed ? 1 : 0;
  }
  if (group === 'query' && verb === 'instant') {
    io.err('Error querying: Post "http://localhost:9090/api/v1/query": dial tcp [::1]:9090: connect: connection refused\n(No Prometheus server runs in this lab; check rule files with promtool check rules.)\n');
    return 1;
  }
  io.err('usage: promtool [<flags>] <command> [<args> ...]\n\nCommands: check config, check rules, check metrics\n');
  return 1;
};

const amtool: Cmd = (args, io, ctx) => {
  const cfgArg = args.find((a) => a.startsWith('--config.file='))?.slice(14) ?? (args.includes('--config.file') ? args[args.indexOf('--config.file') + 1] : undefined);
  const pos = args.filter((a, k) => !a.startsWith('--') && args[k - 1] !== '--config.file');
  if (pos[0] === 'check-config') {
    let failed = false;
    for (const f of pos.slice(1)) {
      io.out(`Checking '${f}'`);
      const text = readArg(ctx, io, f);
      if (text === null) {
        failed = true;
        continue;
      }
      const c = loadAlertmanager(text);
      if (c.errors.length) {
        failed = true;
        io.out(`  FAILED: ${c.errors.join('; ')}\n\n`);
        continue;
      }
      io.out(`  SUCCESS\nFound:\n - global config\n - route\n - ${c.inhibit} inhibit rules\n - ${c.receivers.length} receivers\n - 0 templates\n\n`);
    }
    return failed ? 1 : 0;
  }
  if (pos[0] === 'config' && pos[1] === 'routes') {
    const text = readArg(ctx, io, cfgArg ?? '/etc/alertmanager/alertmanager.yml');
    if (text === null) return 1;
    const c = loadAlertmanager(text);
    if (c.errors.length || !c.route) {
      io.err(`error: ${c.errors.join('; ')}\n`);
      return 1;
    }
    if (pos[2] === 'test') {
      const labels: Record<string, string> = {};
      for (const kv of pos.slice(3)) {
        const p = parseMatcher(kv);
        if (p) labels[p.name] = p.value;
      }
      const recv = routeAlert(c.route, labels);
      io.out(recv.join(',') + '\n');
      const expect = args.find((a) => a.startsWith('--verify.receivers='))?.slice(19);
      if (expect && expect !== recv.join(',')) {
        io.err(`WARNING: Expected receivers did not match resolved receivers.\n`);
        return 1;
      }
      return 0;
    }
    const show = (r: Route, depth: number): string => `${'  '.repeat(depth)}└── ${depth ? `{${r.matchers.map((m) => `${m.name}${m.op}"${m.value}"`).join(',')}}` : 'default-route'}  receiver: ${r.receiver ?? '(inherited)'}${r.continue ? '  continue: true' : ''}\n${r.routes.map((x) => show(x, depth + 1)).join('')}`;
    io.out(`Routing tree:\n${show(c.route, 0)}`);
    return 0;
  }
  io.err('usage: amtool [<flags>] <command> [<args> ...]\n\nCommands: check-config, config routes [show|test]\n');
  return 1;
};

export const MONITORING_COMMANDS: Record<string, Cmd> = { promtool, amtool };
