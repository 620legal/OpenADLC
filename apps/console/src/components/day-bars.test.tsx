import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DayBars, LABELLED_DAYS } from './day-bars';

function render(days: { day: string; costUsd: number }[]): { html: string; visible: string } {
  const html = renderToStaticMarkup(<DayBars days={days} />).replace(/<!-- -->/g, '');
  // What is on the page without hovering: text between tags, not attributes.
  const visible = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return { html, visible };
}

function month(count: number): { day: string; costUsd: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    day: `2026-09-${String(index + 1).padStart(2, '0')}`,
    costUsd: index === 11 ? 9.5 : 1 + index / 10,
  }));
}

describe('spend by day', () => {
  it('writes a single day’s date and amount on the page, not only in a tooltip', () => {
    const { visible } = render([{ day: '2026-09-18', costUsd: 4.2 }]);
    expect(visible).toContain('09-18');
    expect(visible).toContain('$4.20');
  });

  it('caps a bar’s width, so one day is one bar rather than the whole panel', () => {
    const { html } = render([{ day: '2026-09-18', costUsd: 4.2 }]);
    const bars = html.match(/class="[^"]*\bflex-1\b[^"]*"/g) ?? [];
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar).toMatch(/\bmax-w-\d+\b/);
  });

  it('labels every bar up to a week', () => {
    const { visible } = render(month(LABELLED_DAYS));
    for (const day of month(LABELLED_DAYS)) {
      expect(visible).toContain(day.day.slice(5));
      expect(visible).toContain(`$${day.costUsd.toFixed(2)}`);
    }
  });

  it('names the ends of the period and its busiest day when there are too many bars to label', () => {
    const { visible } = render(month(20));
    expect(visible).toContain('09-01');
    expect(visible).toContain('09-20');
    expect(visible).toContain('most on 09-12: $9.50');
    // Not a label per bar: there is no room for twenty on a phone.
    expect(visible).not.toContain('09-05');
  });
});

describe('a month with quiet days', () => {
  it('draws a quiet day as a hairline, not as a bar of a few cents', () => {
    const { html } = render([
      { day: '2026-09-01', costUsd: 2 },
      { day: '2026-09-02', costUsd: 0 },
      { day: '2026-09-03', costUsd: 0.01 },
    ]);
    expect(html.match(/data-quiet/g)).toHaveLength(1);
    expect(html.match(/bg-signal\/70/g)).toHaveLength(2);
  });
});
