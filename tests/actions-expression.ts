/**
 * GitHub Actions' expression language, as much of it as the CI workflows use,
 * so a test can ask what a job's `if` or `name` comes to for an event rather
 * than matching its text: `&&`, `||` and `!` returning operands as GitHub's
 * do, `==` and `!=` comparing strings without case and anything else as a
 * number, property paths with `.*.` filters, and `startsWith`, `contains`,
 * `cancelled` and `always`. A missing property is null, as it is there.
 */
export type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

export interface ExpressionContext {
  [name: string]: unknown;
}

type Token = { kind: 'string'; value: string } | { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const char = source[at]!;
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (char === "'") {
      let value = '';
      at += 1;
      for (;;) {
        if (at >= source.length) throw new Error(`unterminated string in ${source}`);
        if (source[at] === "'") {
          if (source[at + 1] === "'") {
            value += "'";
            at += 2;
            continue;
          }
          at += 1;
          break;
        }
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    const op = ['&&', '||', '==', '!=', '<=', '>=', '!', '(', ')', ',', '.', '<', '>'].find((candidate) => source.startsWith(candidate, at));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      at += op.length;
      continue;
    }
    if (char === '*') {
      tokens.push({ kind: 'name', value: '*' });
      at += 1;
      continue;
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(at));
    if (number) {
      tokens.push({ kind: 'number', value: Number(number[0]) });
      at += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(at));
    if (!name) throw new Error(`cannot read ${source.slice(at)} in ${source}`);
    tokens.push({ kind: 'name', value: name[0] });
    at += name[0].length;
  }
  return tokens;
}

function truthy(value: Value | undefined): boolean {
  return !(value === false || value === 0 || value === '' || value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value)));
}

function asNumber(value: Value | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return Number.NaN;
}

function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'object' && a !== null) return a === b;
  if (typeof b === 'object' && b !== null) return false;
  return asNumber(a) === asNumber(b);
}

function property(value: Value | undefined, key: string): Value {
  if (key === '*') return Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
  if (Array.isArray(value)) return value.map((item) => property(item, key));
  if (value && typeof value === 'object') return (value as Record<string, Value>)[key] ?? null;
  return null;
}

/** What `expression` (with or without its `${{ }}`) comes to in `context`. */
export function evaluate(expression: string, context: ExpressionContext, status: { cancelled?: boolean } = {}): Value {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const isOp = (value: string) => peek()?.kind === 'op' && peek()!.value === value;
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`expected ${value} in ${source}`);
    at += 1;
  };

  function or(): Value {
    let left = and();
    while (isOp('||')) {
      at += 1;
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }
  function and(): Value {
    let left = comparison();
    while (isOp('&&')) {
      at += 1;
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  }
  function comparison(): Value {
    let left = unary();
    while (isOp('==') || isOp('!=')) {
      const op = peek()!.value;
      at += 1;
      const right = unary();
      left = op === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  }
  function unary(): Value {
    if (isOp('!')) {
      at += 1;
      return !truthy(unary());
    }
    return postfix();
  }
  function postfix(): Value {
    let value = primary();
    while (isOp('.')) {
      at += 1;
      const key = peek();
      if (key?.kind !== 'name') throw new Error(`expected a property in ${source}`);
      at += 1;
      value = property(value, key.value);
    }
    return value;
  }
  function call(name: string, args: Value[]): Value {
    const text = (value: Value) => (value === null ? '' : String(value)).toLowerCase();
    switch (name) {
      case 'startsWith':
        return text(args[0]!).startsWith(text(args[1]!));
      case 'endsWith':
        return text(args[0]!).endsWith(text(args[1]!));
      case 'contains':
        return Array.isArray(args[0]) ? args[0].some((item) => equal(item, args[1])) : text(args[0]!).includes(text(args[1]!));
      case 'cancelled':
        return status.cancelled === true;
      case 'always':
        return true;
      default:
        throw new Error(`${name}() is not a function this evaluator knows`);
    }
  }
  function primary(): Value {
    const token = peek();
    if (!token) throw new Error(`unexpected end of ${source}`);
    at += 1;
    if (token.kind === 'string' || token.kind === 'number') return token.value;
    if (token.kind === 'op' && token.value === '(') {
      const value = or();
      expect(')');
      return value;
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      if (isOp('(')) {
        at += 1;
        const args: Value[] = [];
        while (!isOp(')')) {
          args.push(or());
          if (isOp(',')) at += 1;
        }
        expect(')');
        return call(token.value, args);
      }
      return (context[token.value] ?? null) as Value;
    }
    throw new Error(`unexpected ${token.value} in ${source}`);
  }

  const value = or();
  if (at !== tokens.length) throw new Error(`unread ${tokens.slice(at).map((token) => token.value).join(' ')} in ${source}`);
  return value;
}

/** An `if:` as GitHub reads it: a bare expression is wrapped, and the result is truthy or not. */
export function holds(condition: string | undefined, context: ExpressionContext, status: { cancelled?: boolean } = {}): boolean {
  if (condition === undefined) return true;
  return truthy(evaluate(condition, context, status));
}
