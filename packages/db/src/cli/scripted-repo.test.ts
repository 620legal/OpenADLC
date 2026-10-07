import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scriptedStandIn } from './scripted-repo.js';

const CREW = [
  { name: 'intake', role: 'intake' },
  { name: 'fleetadlc-atlas-janedoe', role: 'implement' },
];

describe('a scripted install with no repository configured', () => {
  it('inserts one, owned by the builder', () => {
    // config/repos.yaml ships empty. The integration seed used to stop there,
    // and the pipeline then failed with "no repository is configured".
    const repo = scriptedStandIn(0, CREW);

    expect(repo).toMatchObject({
      name: 'scripted',
      fullName: 'local/scripted',
      owner: 'fleetadlc-atlas-janedoe',
      defaultBranch: 'main',
    });
    expect(repo?.stageModes?.build).toBe('autonomous');
  });

  it('does not add a second repository when one is already configured', () => {
    expect(scriptedStandIn(1, CREW)).toBeNull();
  });

  it('does nothing when there is no bot to own it', () => {
    expect(scriptedStandIn(0, [])).toBeNull();
  });

  it('is what the scripted seed runs before it fills the board', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed.ts'), 'utf8');
    // The calls, not the definitions: both functions are declared above main().
    const scripted = source.indexOf('await ensureScriptedRepository();');
    const board = source.indexOf('await seedScriptedBoard();');
    expect(scripted).toBeGreaterThan(-1);
    expect(board).toBeGreaterThan(scripted);
  });
});
