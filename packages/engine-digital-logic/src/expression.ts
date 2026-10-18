/**
 * Tiny Boolean expression evaluator used by lab checks.
 * Grammar (lowest to highest precedence):
 *   or   := xor ( ('|' | '+' | 'OR') xor )*
 *   xor  := and ( ('^' | 'XOR') and )*
 *   and  := not ( ('&' | '*' | '.' | 'AND') not )*
 *   not  := ('!' | '~' | 'NOT') not | atom
 *   atom := '(' or ')' | '0' | '1' | identifier [ "'" ]   (trailing apostrophe = NOT)
 * Identifiers are matched case-insensitively against input labels.
 */

import type { Bit } from './circuit';

type Token = { kind: 'op' | 'id' | 'const' | 'lparen' | 'rparen' | 'prime'; text: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') tokens.push({ kind: 'lparen', text: ch });
    else if (ch === ')') tokens.push({ kind: 'rparen', text: ch });
    else if (ch === "'") tokens.push({ kind: 'prime', text: ch });
    else if ('|+^&*.!~'.includes(ch)) tokens.push({ kind: 'op', text: ch });
    else if (ch === '0' || ch === '1') tokens.push({ kind: 'const', text: ch });
    else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === 'AND') tokens.push({ kind: 'op', text: '&' });
      else if (upper === 'OR') tokens.push({ kind: 'op', text: '|' });
      else if (upper === 'XOR') tokens.push({ kind: 'op', text: '^' });
      else if (upper === 'NOT') tokens.push({ kind: 'op', text: '!' });
      else tokens.push({ kind: 'id', text: word });
      i = j;
      continue;
    } else throw new Error(`Unexpected character "${ch}" in expression`);
    i += 1;
  }
  return tokens;
}

export function evaluateExpression(src: string, env: Record<string, Bit>): Bit {
  const tokens = tokenize(src);
  let pos = 0;
  const upperEnv: Record<string, Bit> = {};
  for (const [k, v] of Object.entries(env)) upperEnv[k.toUpperCase()] = v;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseOr = (): Bit => {
    let v = parseXor();
    while (peek() && peek().kind === 'op' && (peek().text === '|' || peek().text === '+')) {
      next();
      const r = parseXor();
      v = v === 1 || r === 1 ? 1 : 0;
    }
    return v;
  };
  const parseXor = (): Bit => {
    let v = parseAnd();
    while (peek() && peek().kind === 'op' && peek().text === '^') {
      next();
      const r = parseAnd();
      v = v !== r ? 1 : 0;
    }
    return v;
  };
  const parseAnd = (): Bit => {
    let v = parseNot();
    while (peek() && peek().kind === 'op' && '&*.'.includes(peek().text)) {
      next();
      const r = parseNot();
      v = v === 1 && r === 1 ? 1 : 0;
    }
    return v;
  };
  const parseNot = (): Bit => {
    if (peek() && peek().kind === 'op' && (peek().text === '!' || peek().text === '~')) {
      next();
      return parseNot() === 1 ? 0 : 1;
    }
    return parseAtom();
  };
  const parseAtom = (): Bit => {
    const t = next();
    if (!t) throw new Error('Expression ended unexpectedly');
    let v: Bit;
    if (t.kind === 'lparen') {
      v = parseOr();
      const close = next();
      if (!close || close.kind !== 'rparen') throw new Error('Missing closing parenthesis');
    } else if (t.kind === 'const') {
      v = t.text === '1' ? 1 : 0;
    } else if (t.kind === 'id') {
      const key = t.text.toUpperCase();
      if (!(key in upperEnv)) throw new Error(`Unknown signal "${t.text}"`);
      v = upperEnv[key];
    } else {
      throw new Error(`Unexpected token "${t.text}"`);
    }
    while (peek() && peek().kind === 'prime') {
      next();
      v = v === 1 ? 0 : 1;
    }
    return v;
  };

  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`Unexpected token "${tokens[pos].text}"`);
  return result;
}
