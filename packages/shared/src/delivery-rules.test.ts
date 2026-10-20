import { describe, expect, it } from 'vitest';
import { DELIVERY_RULES_PATH, LEGACY_DELIVERY_RULES_PATH, readDeliveryRulesFile } from './delivery-rules.js';

describe('the rules file of a repository set up before the rename', () => {
  const repo = (files: Record<string, string>) => {
    const asked: string[] = [];
    const read = async (path: string): Promise<string | null> => {
      asked.push(path);
      return files[path] ?? null;
    };
    return { asked, read };
  };

  it('is read from its old path only where the new one has no file', async () => {
    const renamed = repo({ [DELIVERY_RULES_PATH]: 'testing:\n  url: https://t.example\n' });
    expect(await readDeliveryRulesFile(renamed.read)).toContain('t.example');
    expect(renamed.asked).toEqual([DELIVERY_RULES_PATH]);

    const old = repo({ [LEGACY_DELIVERY_RULES_PATH]: 'stacking: false\n' });
    expect(await readDeliveryRulesFile(old.read)).toBe('stacking: false\n');
    expect(old.asked).toEqual([DELIVERY_RULES_PATH, LEGACY_DELIVERY_RULES_PATH]);

    expect(await readDeliveryRulesFile(repo({}).read)).toBeNull();
  });

  it('prefers the new path when a repository has both, so renaming the file wins', async () => {
    const both = repo({ [DELIVERY_RULES_PATH]: 'new', [LEGACY_DELIVERY_RULES_PATH]: 'old' });
    expect(await readDeliveryRulesFile(both.read)).toBe('new');
  });

  it('does not take a read failure for a missing file: anything but null still throws', async () => {
    // A 502 read as "no file" turned a repository's own rules off for that pass.
    await expect(
      readDeliveryRulesFile(async () => {
        throw new Error('bad gateway');
      }),
    ).rejects.toThrow('bad gateway');
  });
});
