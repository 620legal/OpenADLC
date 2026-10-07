import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The live pull request suite put the bot's token in the clone URL. A failed
 * clone or push printed the whole command line, token and all, and all.mjs
 * repeated it; the clone wrote it into the mirror's config. The suite runs
 * main() on import, so this reads its source.
 */
const suite = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'github-live-pr.mjs'), 'utf8');

describe('the live pull request suite', () => {
  it('puts no credential in a git URL', () => {
    expect(suite).not.toContain('x-access-token:${token}@');
    expect(suite).toContain('`https://github.com/${repo.fullName}.git`');
  });

  it('hands git the token as a header, from the environment, sent only to GitHub', () => {
    expect(suite).toContain("GIT_CONFIG_COUNT: '5'");
    expect(suite).toContain("GIT_CONFIG_KEY_4: 'http.https://github.com/.extraheader'");
    expect(suite).toContain("GIT_CONFIG_VALUE_4: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`");
  });

  it('prints a failure through redactSecrets', () => {
    const handler = suite.slice(suite.lastIndexOf('main().catch('));
    expect(handler).toContain('redactSecrets(String(error instanceof Error ? error.message : error))');
    expect(handler).not.toMatch(/\$\{error instanceof Error \? error\.message : error\}/);
  });
});
