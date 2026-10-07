import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain script with no types; it is run directly as well.
import { anchorOf, brokenLinks } from './check-links.mjs';

describe('the links in the repository’s Markdown', () => {
  it('all resolve, anchors included', () => {
    expect(brokenLinks()).toEqual([]);
  });

  it('turns a heading into the anchor GitHub gives it', () => {
    expect(anchorOf('One request, start to finish')).toBe('one-request-start-to-finish');
    expect(anchorOf('`fleetadlc up` and the `--driver` flag')).toBe('fleetadlc-up-and-the---driver-flag');
    expect(anchorOf('Who OpenADLC acts for')).toBe('who-openadlc-acts-for');
    // GitHub keeps an underscore inside a word, and drops emphasis markers.
    expect(anchorOf('$FLEETADLC_HOME')).toBe('fleetadlc_home');
    expect(anchorOf('`MANUAL_STEPS` and more')).toBe('manual_steps-and-more');
    expect(anchorOf('An _emphasised_ word')).toBe('an-emphasised-word');
  });
});
