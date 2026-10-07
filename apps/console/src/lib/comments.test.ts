import { describe, expect, it } from 'vitest';
import { withoutComments } from './comments';

describe('withoutComments', () => {
  it('takes out every comment, as the pattern it replaces did', () => {
    const text = 'one <!-- fleetadlc:{"event":"question"} --> two <!----> three <!-- a\nb --> four';
    expect(withoutComments(text)).toBe(text.replace(/<!--[\s\S]*?-->/g, ''));
    expect(withoutComments(text)).toBe('one  two  three  four');
  });

  it('keeps the rest of the text after a comment that is never closed', () => {
    expect(withoutComments('kept <!-- x --> and <!-- never closed')).toBe('kept  and <!-- never closed');
    expect(withoutComments('<!-->')).toBe('<!-->');
  });

  it('reads forty thousand unclosed comments at once, not in seconds', () => {
    const text = '<!--'.repeat(40_000);
    const started = performance.now();
    expect(withoutComments(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
