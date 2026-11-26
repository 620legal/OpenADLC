import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CostUsageView } from '@/lib/api';
import { bucketLabel, LABELLED_BUCKETS, tokenCount, UsageChart } from './usage-chart';

type Point = CostUsageView['series'][number];

function point(at: string, partial: Partial<Point> = {}): Point {
  return { at, billedUsd: 0, estimateUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...partial };
}

function draw(series: Point[], bucket: 'hour' | 'day', mode: 'cost' | 'tokens'): string {
  return renderToStaticMarkup(<UsageChart usage={{ series, bucket }} mode={mode} />).replace(/<!-- -->/g, '');
}

const DAYS = [
  point('2026-11-23T00:00:00Z', { billedUsd: 2, estimateUsd: 4, tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 50 } }),
  point('2026-11-24T00:00:00Z'),
  point('2026-11-25T00:00:00Z', { billedUsd: 1 }),
];

describe('the usage chart', () => {
  it('draws billed and estimated beside each other in cost mode, with a legend that says the estimate is not billed', () => {
    const html = draw(DAYS, 'day', 'cost');
    expect(html).toContain('data-usage-chart="cost"');
    expect(html).toContain('estimated, not billed');
    const first = /<div data-bucket="2026-11-23T00:00:00Z"[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? '';
    expect(first).toContain('title="11-23: $2.00 billed · $4.00 est."');
    expect(first).toContain('data-kind="billed"');
    expect(first).toContain('data-kind="estimate"');
    // The estimate is the taller, as it is the more: one scale, never stacked into a sum.
    expect(first).toMatch(/data-kind="billed"[^>]*height:44px/);
    expect(first).toMatch(/data-kind="estimate"[^>]*height:88px/);
  });

  it('stacks the four token types in tokens mode, each named in the legend and on hover', () => {
    const html = draw(DAYS, 'day', 'tokens');
    expect(html).toContain('data-usage-chart="tokens"');
    const legend = /<ul aria-label="Legend"[\s\S]*?<\/ul>/.exec(html)?.[0] ?? '';
    for (const label of ['input', 'output', 'cache read', 'cache write']) expect(legend).toContain(label);
    expect(html).toContain('title="11-23: 100 input · 10 output · 900 cache read · 50 cache write"');
    for (const kind of ['input', 'output', 'cacheRead', 'cacheWrite']) expect(html).toContain(`data-kind="${kind}"`);
    // A bucket with only billed cost has no tokens, and draws as quiet in tokens mode.
    expect(/<div data-bucket="2026-11-25T00:00:00Z"[\s\S]*?<\/div>/.exec(html)?.[0]).toContain('data-quiet');
  });

  it('draws a quiet bucket as a hairline', () => {
    expect(/<div data-bucket="2026-11-24T00:00:00Z"[\s\S]*?<\/div>/.exec(draw(DAYS, 'day', 'cost'))?.[0]).toContain('data-quiet');
  });

  it('labels hours for a day’s range and days otherwise', () => {
    expect(bucketLabel('2026-11-25T14:00:00Z', 'hour')).toBe('14:00');
    expect(bucketLabel('2026-11-25T00:00:00Z', 'day')).toBe('11-25');
    const hours = draw([point('2026-11-25T13:00:00Z', { billedUsd: 1 }), point('2026-11-25T14:00:00Z')], 'hour', 'cost');
    expect(hours).toContain('>13:00</span>');
    expect(hours).toContain('>14:00</span>');
  });

  it('names only the ends and the busiest bucket when there are too many to label', () => {
    const many = Array.from({ length: 24 }, (_, hour) =>
      point(`2026-11-25T${String(hour).padStart(2, '0')}:00:00Z`, { billedUsd: hour === 9 ? 5 : 0.5 }),
    );
    expect(many.length).toBeGreaterThan(LABELLED_BUCKETS);
    const html = draw(many, 'hour', 'cost');
    expect(html).toContain('most at 09:00: <span class="tabular-nums">$5.00</span>');
    expect(html).not.toContain('>05:00</span>');
  });

  it('says so, rather than drawing an empty frame, when nothing happened in the range', () => {
    expect(draw([point('2026-11-24T00:00:00Z'), point('2026-11-25T00:00:00Z')], 'day', 'cost')).toContain('nothing spent in this range');
    expect(draw([], 'day', 'tokens')).toContain('no tokens in this range');
  });

  it('shortens token counts', () => {
    expect(tokenCount(950)).toBe('950');
    expect(tokenCount(1_500)).toBe('1.5k');
    expect(tokenCount(300_000)).toBe('300k');
    expect(tokenCount(1_600_000)).toBe('1.6M');
    expect(tokenCount(25_000_000)).toBe('25M');
  });
});
