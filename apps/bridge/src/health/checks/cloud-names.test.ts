import { describe, expect, it } from 'vitest';
import { cloudNamesCheck, OLD_NAMES_TITLE, RENAME_RUNBOOK } from './cloud-names.js';

/**
 * A cloud install made before the rename runs on its old names until a person
 * renames it, and nothing said so: the readers of the old names would have
 * gone with that install still on them.
 */

const NOW = new Date('2026-10-25T12:00:00.000Z');

describe('the cloud names check', () => {
  it('warns while Secret Manager holds a secret under the old names, and opens the steps', async () => {
    const [result] = await cloudNamesCheck({ beforeRename: async () => ['fleet-github-app-private-key', 'fleet-github-refresh-atlas'] }).run(NOW);
    expect(result).toMatchObject({ ok: false, severity: 'warning', title: OLD_NAMES_TITLE, action: { url: RENAME_RUNBOOK } });
    const detail = result!.ok === false ? result!.detail : '';
    expect(detail).toContain('2 secrets under the old names (fleet-github-app-private-key, fleet-github-refresh-atlas)');
    expect(detail).toContain('with no task running');
    expect(RENAME_RUNBOOK).toMatch(/\/blob\/main\/docs\/runbooks\/rename-gcp-host\.md$/);
  });

  it('passes once the old secrets are gone, which the rename does last', async () => {
    expect(await cloudNamesCheck({ beforeRename: async () => [] }).run(NOW)).toEqual([{ ok: true, fixed: 'The cloud install has OpenADLC’s names now' }]);
  });

  it('says nothing on an install whose secrets are files, and does not guess when Secret Manager cannot be listed', async () => {
    expect(await cloudNamesCheck(null).run(NOW)).toEqual([]);
    const [unread] = await cloudNamesCheck({
      beforeRename: async () => {
        throw new Error('Secret Manager refused to list secrets (403)');
      },
    }).run(NOW);
    expect(unread).toMatchObject({ ok: null, reason: expect.stringContaining('(403)') });
  });
});
