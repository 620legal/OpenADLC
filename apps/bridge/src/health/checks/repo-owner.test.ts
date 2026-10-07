import { describe, expect, it } from 'vitest';
import { repoOwnerCheck } from './repo-owner.js';

/**
 * A repos.yaml owner that names no seat was stored as no owner, and the
 * dispatcher skips such a repository without a word: nothing built there and
 * nothing on the board said why.
 */

const NOW = new Date('2026-10-04T12:00:00.000Z');

describe('the repository owner check', () => {
  it('fails, blocking, for a repository no bot owns, and says how to give it one', async () => {
    const results = await repoOwnerCheck({
      repos: async () => [
        { fullName: 'exampleco/app', ownerBotId: 'b1' },
        { fullName: 'exampleco/other', ownerBotId: null },
      ],
    }).run(NOW);

    expect(results[0]).toMatchObject({ subject: 'exampleco/app', ok: true });
    expect(results[1]).toMatchObject({ subject: 'exampleco/other', ok: false, severity: 'blocking', action: { command: 'fleetadlc seed' } });
    const detail = results[1]!.ok === false ? results[1]!.detail : '';
    expect(detail).toContain('config/repos.yaml');
    expect(detail).toContain('at every `fleetadlc up`');
  });
});
