import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROJECT_URL } from './project.js';

describe('where OpenADLC lives', () => {
  it('is the same in the code and in package.json', () => {
    const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
    };
    expect(root.repository.url).toBe(`${PROJECT_URL}.git`);
    expect(root.homepage).toBe(`${PROJECT_URL}#readme`);
    expect(root.bugs.url).toBe(`${PROJECT_URL}/issues`);
  });
});
