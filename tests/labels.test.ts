import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Label sync gives a label its colour and description only when
 * config/labels.json lists it. The alerts route filed its issues with `alert`,
 * which was not listed, so it was whatever GitHub made of it on the fly.
 */
describe('the labels the bridge files issues with', () => {
  it('are each in config/labels.json', () => {
    const labels = (JSON.parse(readFileSync(join(ROOT, 'config', 'labels.json'), 'utf8')) as { name: string }[]).map(
      (label) => label.name,
    );
    const source = readFileSync(join(ROOT, 'apps', 'bridge', 'src', 'internal-api.ts'), 'utf8');
    const filed = [...source.matchAll(/labels: \[([^\]]*)\]/g)].flatMap((match) =>
      [...match[1]!.matchAll(/'([^']+)'/g)].map((name) => name[1]!),
    );

    expect(filed).toContain('alert');
    for (const name of filed) expect(labels).toContain(name);
  });
});

/**
 * Nothing reads a bare `review:human`: only `needs-human` holds a pull request,
 * and the bridge strips the bare label on the next push. Its description said
 * it held review-gate, so a person who added it to stop a pull request got no
 * hold at all.
 */
describe('review:human', () => {
  it('is described as retired, not as a hold', () => {
    const labels = JSON.parse(readFileSync(join(ROOT, 'config', 'labels.json'), 'utf8')) as { name: string; description: string }[];
    const entry = labels.find((label) => label.name === 'review:human');

    expect(entry?.description).toMatch(/retired/i);
    expect(entry?.description).toContain('needs-human');
    for (const label of labels) expect(label.description, label.name).not.toMatch(/holds review-gate/i);
  });

  it('is not what the platform plan says the review gate waits on', () => {
    const plan = readFileSync(join(ROOT, 'docs', 'platform-plan.md'), 'utf8').replace(/\s+/g, ' ');

    expect(plan).not.toMatch(/while `review:human` is present/);
    expect(plan).toMatch(/while `needs-human` is on/);
  });
});
