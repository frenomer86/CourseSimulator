/**
 * A YAML subset for compose files, CI workflows, Kubernetes manifests and Ansible playbooks:
 * block maps and sequences, "- key: value" items, block scalars (| and >, with - and + chomping),
 * flow sequences and maps ([a, b], {a: 1}), quoted scalars, comments, anchors and aliases (&a, *a,
 * <<: *a) and several documents separated by ---. Scalars stay strings; callers convert. No imports.
 */

export type Yaml = string | Yaml[] | { [key: string]: Yaml };

interface Line {
  n: number;
  indent: number;
  text: string;
  raw: string;
}

/** Removes a trailing comment that is not inside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

function unquote(t: string): string {
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
    return t.slice(1, -1).replace(/\\(["\\/nrt0]|u[0-9a-fA-F]{4})/g, (_, e: string) => (e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '0' ? '\0' : e.startsWith('u') ? String.fromCharCode(parseInt(e.slice(1), 16)) : e));
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Splits a flow collection's inside on commas at depth 0, outside quotes. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: string | null = null;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') cur += s[++i] ?? '';
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The index of the ": " (or final ":") that separates a key from its value, outside quotes and brackets. */
function keyColon(t: string): number {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i === t.length - 1 || t[i + 1] === ' ' || t[i + 1] === '\t')) return i;
  }
  return -1;
}

export class YamlError extends Error {}

/** Parses every document in the text. */
export function parseYamlAll(text: string): Yaml[] {
  const docs: string[][] = [[]];
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n')) {
    if (/^---(\s|$)/.test(raw)) {
      docs.push([]);
      const rest = raw.slice(3).trim();
      if (rest && !rest.startsWith('#')) docs[docs.length - 1].push(rest);
      continue;
    }
    if (/^\.\.\.\s*$/.test(raw)) continue;
    docs[docs.length - 1].push(raw);
  }
  const out: Yaml[] = [];
  let lineBase = 0;
  for (const d of docs) {
    if (d.some((l) => stripComment(l).trim())) out.push(parseDoc(d, lineBase));
    lineBase += d.length + 1;
  }
  return out;
}

/** Parses one document (the first, if there are several). */
export function parseYaml(text: string): Yaml {
  return parseYamlAll(text)[0] ?? '';
}

function parseDoc(rawLines: string[], base: number): Yaml {
  const lines: Line[] = rawLines.map((raw, k) => ({ n: base + k + 1, indent: raw.length - raw.trimStart().length, text: raw.trimStart() === '' ? '' : stripComment(raw).trimStart(), raw }));
  const anchors: Record<string, Yaml> = {};
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && !lines[i].text) i++;
  };
  const err = (msg: string) => new YamlError(`line ${lines[Math.min(i, lines.length - 1)]?.n ?? 0}: ${msg}`);

  const flow = (t: string): Yaml => {
    t = t.trim();
    if (t.startsWith('[')) {
      if (!t.endsWith(']')) throw err(`unclosed flow sequence: ${t}`);
      return splitFlow(t.slice(1, -1)).map((x) => flow(x));
    }
    if (t.startsWith('{')) {
      if (!t.endsWith('}')) throw err(`unclosed flow mapping: ${t}`);
      const m: Record<string, Yaml> = {};
      for (const part of splitFlow(t.slice(1, -1))) {
        const c = keyColon(part);
        if (c === -1) m[unquote(part)] = '';
        else m[unquote(part.slice(0, c).trim())] = flow(part.slice(c + 1));
      }
      return m;
    }
    if (t.startsWith('*')) {
      const a = anchors[t.slice(1)];
      if (a === undefined) throw err(`unknown alias ${t}`);
      return a;
    }
    if (t === '~' || t === 'null') return '';
    return unquote(t);
  };

  /** A block scalar's lines, starting at line i (the header has been consumed). */
  const blockScalar = (header: string, parentIndent: number): string => {
    const style = header[0];
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const explicit = /\d/.exec(header);
    const body: string[] = [];
    let ind = explicit ? parentIndent + Number(explicit[0]) : -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.raw.trim() === '') {
        body.push('');
        i++;
        continue;
      }
      if (ind === -1) ind = l.indent;
      if (l.indent < ind || l.indent <= parentIndent) break;
      body.push(l.raw.slice(ind));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') {
      body.pop();
      trailing++;
    }
    let s: string;
    if (style === '>') {
      s = '';
      body.forEach((l, k) => {
        if (k === 0) s = l;
        else if (l === '' || /^\s/.test(l) || /^\s/.test(body[k - 1]) || body[k - 1] === '') s += '\n' + l;
        else s += ' ' + l;
      });
    } else s = body.join('\n');
    if (!body.length) return '';
    return chomp === 'strip' ? s : chomp === 'keep' ? s + '\n'.repeat(trailing + 1) : s + '\n';
  };

  /** A value that follows "key:" or "- " on the same line (possibly empty, so the block below is the value). */
  const inlineValue = (rest: string, ownIndent: number): Yaml => {
    let anchor: string | undefined;
    const am = /^&([\w-]+)\s*(.*)$/.exec(rest);
    if (am) {
      anchor = am[1];
      rest = am[2];
    }
    let v: Yaml;
    if (rest === '' || rest === undefined) {
      skipBlank();
      if (i < lines.length && (lines[i].indent > ownIndent || (lines[i].indent === ownIndent && /^-(\s|$)/.test(lines[i].text)))) v = block(lines[i].indent);
      else v = '';
    } else if (/^[|>][-+0-9]*$/.test(rest)) v = blockScalar(rest, ownIndent);
    else v = flow(rest);
    if (anchor) anchors[anchor] = v;
    return v;
  };

  const block = (indent: number): Yaml => {
    skipBlank();
    if (i >= lines.length) return '';
    if (/^-(\s|$)/.test(lines[i].text)) {
      const list: Yaml[] = [];
      while (true) {
        skipBlank();
        if (i >= lines.length || lines[i].indent !== indent || !/^-(\s|$)/.test(lines[i].text)) break;
        const l = lines[i];
        const rest = l.text.slice(1).trimStart();
        const itemIndent = l.indent + (l.text.length - rest.length);
        if (rest && (keyColon(rest) !== -1 || /^-(\s|$)/.test(rest)) && !/^["'[{]/.test(rest)) {
          // "- key: value" or "- - x": the rest of the line starts a nested block at the item's column.
          lines[i] = { ...l, indent: itemIndent, text: rest };
          list.push(block(itemIndent));
        } else {
          i++;
          list.push(inlineValue(rest, l.indent));
        }
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (true) {
      skipBlank();
      if (i >= lines.length || lines[i].indent !== indent) break;
      const l = lines[i];
      if (/^-(\s|$)/.test(l.text)) throw err('a list item cannot follow a key at the same level here');
      const c = keyColon(l.text);
      if (c === -1) throw err(`expected "key: value", got "${l.text}"`);
      const key = unquote(l.text.slice(0, c).trim());
      const rest = l.text.slice(c + 1).trim();
      i++;
      const v = inlineValue(rest, indent);
      if (key === '<<') {
        for (const src of Array.isArray(v) ? v : [v]) if (src && typeof src === 'object' && !Array.isArray(src)) for (const [k, x] of Object.entries(src)) if (!(k in map)) map[k] = x;
      } else map[key] = v;
    }
    skipBlank();
    if (i < lines.length && lines[i].indent > indent) throw err('unexpected indentation');
    return map;
  };

  skipBlank();
  if (i >= lines.length) return '';
  const first = lines[i];
  // A document that is a single scalar or flow collection.
  if (keyColon(first.text) === -1 && !/^-(\s|$)/.test(first.text)) {
    i++;
    return /^[|>]/.test(first.text) ? blockScalar(first.text, -1) : flow(first.text);
  }
  const doc = block(first.indent);
  skipBlank();
  if (i < lines.length) throw err('unexpected indentation');
  return doc;
}

const needsQuote = (s: string) => s === '' || /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: |\s#|^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s);

/** Writes a value as YAML (two-space indentation, block style). Numeric strings listed in `numeric` keys stay bare. */
export function dumpYaml(v: Yaml | number | boolean | null | undefined, indent = 0): string {
  const pad = ' '.repeat(indent);
  const scalar = (x: unknown): string => {
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    if (x === null || x === undefined) return 'null';
    const s = String(x);
    if (s.includes('\n')) return '|\n' + s.replace(/\n$/, '').split('\n').map((l) => pad + '  ' + l).join('\n');
    return needsQuote(s) ? JSON.stringify(s) : s;
  };
  if (Array.isArray(v)) {
    if (!v.length) return pad + '[]\n';
    return v
      .map((item) => {
        if (item && typeof item === 'object') {
          const inner = dumpYaml(item, indent + 2);
          return pad + '- ' + inner.slice(indent + 2);
        }
        return pad + '- ' + scalar(item) + '\n';
      })
      .join('');
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    if (!entries.length) return pad + '{}\n';
    return entries
      .map(([k, x]) => {
        const key = needsQuote(k) ? JSON.stringify(k) : k;
        if (x && typeof x === 'object') {
          if (Array.isArray(x) && !x.length) return `${pad}${key}: []\n`;
          if (!Array.isArray(x) && !Object.keys(x).length) return `${pad}${key}: {}\n`;
          return `${pad}${key}:\n${dumpYaml(x, Array.isArray(x) ? indent : indent + 2)}`;
        }
        return `${pad}${key}: ${scalar(x)}\n`;
      })
      .join('');
  }
  return pad + scalar(v) + '\n';
}

/** Helpers for reading parsed YAML. */
export const yMap = (v: Yaml | undefined): Record<string, Yaml> => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
export const yList = (v: Yaml | undefined): Yaml[] => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);
export const yStr = (v: Yaml | undefined): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
