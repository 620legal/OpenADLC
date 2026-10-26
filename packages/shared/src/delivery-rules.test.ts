import { describe, expect, it } from 'vitest';
import { DELIVERY_RULES_PATH, readDeliveryRulesFile } from './delivery-rules.js';

describe('a repository’s rules file', () => {
  const repo = (files: Record<string, string>) => {
    const asked: string[] = [];
    const read = async (path: string): Promise<string | null> => {
      asked.push(path);
      return files[path] ?? null;
    };
    return { asked, read };
  };

  it('is read from its one path, and is null where the repository has none', async () => {
    const present = repo({ [DELIVERY_RULES_PATH]: 'testing:\n  url: https://t.example\n' });
    expect(await readDeliveryRulesFile(present.read)).toContain('t.example');
    expect(present.asked).toEqual([DELIVERY_RULES_PATH]);

    expect(await readDeliveryRulesFile(repo({}).read)).toBeNull();
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
