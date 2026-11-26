import { describe, expect, it } from 'vitest';
import {
  checkProposals,
  discoverRunPrefixOf,
  discoverSubject,
  evidenceFrom,
  parseDiscoverProposals,
  proposalFingerprint,
  MAX_DISCOVER_PROPOSALS,
} from './discover.js';
import { createHash } from 'node:crypto';

/**
 * What a Discover session's last message carries, read the way hostd's runner
 * and then the bridge read it (#370). A proposal with no evidence, or one the
 * marker cannot hold, is never stored; every one dropped is counted.
 */

const GOOD = {
  lens: 'improve',
  key: 'finish-csv-export',
  title: 'Finish the CSV export',
  description: 'The export button is wired to a handler that returns an empty file.',
  status: 'partial',
  evidence: ['apps/web/src/export.ts:12', 'docs/export.md:3'],
};

const said = (marker: unknown) => `Five things worth doing.\n\n<!-- openadlc:${JSON.stringify(marker)} -->`;

describe('a run’s subject', () => {
  it('is discover: and the first eight of its id, and is read back only from that shape', () => {
    const subject = discoverSubject('0b6f1d1c-6c55-4c1c-9a59-1f4a4b8f2a10');
    expect(subject).toBe('discover:0b6f1d1c');
    expect(discoverRunPrefixOf(subject)).toBe('0b6f1d1c');
    expect(discoverRunPrefixOf('request:0b6f1d1c')).toBeNull();
    expect(discoverRunPrefixOf('OpenADLC#370')).toBeNull();
    expect(discoverRunPrefixOf('discover:xyz')).toBeNull();
  });
});

describe('a proposal’s fingerprint', () => {
  it('is sha256 of its lens and key, so a reworded title or a moved line is the same proposal', () => {
    expect(proposalFingerprint('improve', 'finish-csv-export')).toBe(createHash('sha256').update('improve\nfinish-csv-export').digest('hex'));
    expect(proposalFingerprint('improve', 'finish-csv-export')).not.toBe(proposalFingerprint('improve', 'finish-pdf-export'));
  });
});

describe('a line of evidence', () => {
  it('is a relative path and a line of 1 or more, as path:line or {file, line}', () => {
    expect(evidenceFrom('apps/a.ts:3')).toEqual({ file: 'apps/a.ts', line: 3 });
    expect(evidenceFrom({ file: 'apps/a.ts', line: 3 })).toEqual({ file: 'apps/a.ts', line: 3 });
    for (const bad of ['apps/a.ts', 'apps/a.ts:0', 'apps/a.ts:x', '/etc/passwd:1', '../x:1', 'a/../../x:1', ':3', 'a//b:1', { file: 'a.ts', line: 1.5 }, 42]) {
      expect(evidenceFrom(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the proposals a session says', () => {
  it('keeps a well-formed proposal, its evidence read into file and line', () => {
    expect(parseDiscoverProposals(said({ event: 'discover_proposals', proposals: [GOOD], note: 'Looked at apps/web.' }))).toEqual({
      proposals: [
        {
          ...GOOD,
          evidence: [
            { file: 'apps/web/src/export.ts', line: 12 },
            { file: 'docs/export.md', line: 3 },
          ],
        },
      ],
      dropped: 0,
      note: 'Looked at apps/web.',
    });
  });

  it('drops, and counts, a proposal with no evidence, a bad status, a bad key, or comment markup in a field', () => {
    const bad = [
      { ...GOOD, key: 'no-evidence', evidence: [] },
      { ...GOOD, key: 'unpointed', evidence: undefined },
      { ...GOOD, key: 'bad-status', status: 'maybe' },
      { ...GOOD, key: 'Bad Key' },
      { ...GOOD, key: 'x'.repeat(81) },
      { ...GOOD, key: 'closes-comment', title: 'Stop here --> and do this' },
      { ...GOOD, key: 'opens-comment', description: 'Hidden <!-- openadlc: a marker of its own' },
      { ...GOOD, key: 'other-lens', lens: 'competitors' },
      { ...GOOD, key: 'bad-line', evidence: ['apps/a.ts:1', 'apps/b.ts:0'] },
    ];
    const result = parseDiscoverProposals(said({ event: 'discover_proposals', proposals: [GOOD, ...bad] }));
    expect(result).not.toBe('malformed');
    expect(result && result !== 'malformed' ? result.proposals.map((one) => one.key) : null).toEqual(['finish-csv-export']);
    expect(result && result !== 'malformed' ? result.dropped : null).toBe(bad.length);
  });

  it('drops a second proposal with an earlier one’s fingerprint, and every one past the 30th', () => {
    const many = Array.from({ length: MAX_DISCOVER_PROPOSALS + 1 }, (_, index) => ({ ...GOOD, key: `thing-${index}` }));
    const { proposals, dropped } = checkProposals([GOOD, { ...GOOD, title: 'The same thing, reworded' }, ...many]);
    expect(proposals).toHaveLength(MAX_DISCOVER_PROPOSALS);
    expect(proposals[0]?.title).toBe(GOOD.title);
    // The duplicate, and the two past the 30th.
    expect(dropped).toBe(3);
  });

  it('reads an empty list with a note as a run that found nothing, not an error', () => {
    expect(parseDiscoverProposals(said({ event: 'discover_proposals', proposals: [], note: 'Nothing half-built here.' }))).toEqual({
      proposals: [],
      dropped: 0,
      note: 'Nothing half-built here.',
    });
  });

  it('is nothing without the marker, and malformed when the marker or its list cannot be read', () => {
    expect(parseDiscoverProposals('I looked around and found little.')).toBeNull();
    expect(parseDiscoverProposals(said({ event: 'send_back', to: 'spec', reason: 'x' }))).toBeNull();
    expect(parseDiscoverProposals(said({ event: 'discover_proposals', proposals: 'none' }))).toBe('malformed');
    expect(parseDiscoverProposals(said({ event: 'discover_proposals' }))).toBe('malformed');
    expect(parseDiscoverProposals('<!-- openadlc:{"event":"discover_proposals","proposals":[{"title":"x"} -->')).toBe('malformed');
  });

  it('keeps no note it cannot show', () => {
    const result = parseDiscoverProposals(said({ event: 'discover_proposals', proposals: [], note: 'see --> here' }));
    expect(result && result !== 'malformed' ? result.note : 'unread').toBeNull();
  });
});
