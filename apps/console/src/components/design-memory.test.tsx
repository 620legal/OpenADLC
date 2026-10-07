import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DesignMemoryEntry } from '@/lib/api';
import { DesignMemorySection, memorySections } from './design-memory';

vi.mock('@/app/actions', () => ({ updateDesignMemory: vi.fn(), revertDesignMemory: vi.fn() }));

/**
 * A repository's design memory in Settings: what waits to be accepted and what
 * is in effect first, each entry with where it came from and the ADR it was
 * written in, and the controls a person corrects it with.
 */

function entry(id: string, state: DesignMemoryEntry['state'], extra: Partial<DesignMemoryEntry> = {}): DesignMemoryEntry {
  return {
    id,
    repoId: 'repo-1',
    kind: 'decision',
    title: `Entry ${id}`,
    body: 'What it says.',
    state,
    supersedes: null,
    sourceSubject: 'api#12',
    sourceUrl: null,
    adrPath: null,
    proposedBy: 'acme-crew',
    decidedBy: null,
    decidedAt: null,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...extra,
  };
}

describe('design memory in Settings', () => {
  it('puts what waits and what is in effect before what is not', () => {
    const sections = memorySections([entry('a', 'retired'), entry('b', 'accepted'), entry('c', 'proposed'), entry('d', 'superseded')]);
    expect(sections.map((section) => [section.title, section.entries.map((one) => one.id)])).toEqual([
      ['Waiting to be accepted', ['c']],
      ['In effect', ['b']],
      ['No longer in effect', ['a', 'd']],
    ]);
  });

  it('shows where each came from, the ADR it is written in, and what can be done to it', () => {
    const html = renderToStaticMarkup(
      <DesignMemorySection repo="api" entries={[entry('p', 'proposed'), entry('x', 'accepted', { adrPath: 'docs/adr/0004-costs-per-round.md', decidedBy: 'jane' })]} />,
    );
    expect(html).toContain('href="/?item=api%2312"');
    expect(html).toContain('docs/adr/0004-costs-per-round.md');
    const proposed = html.slice(html.indexOf('data-memory="p"'), html.indexOf('data-memory="x"'));
    expect(proposed).toContain('>Accept<');
    const accepted = html.slice(html.indexOf('data-memory="x"'));
    expect(accepted).toContain('>Retire<');
    expect(accepted).toContain('Superseded by');
    expect(accepted).not.toContain('>Accept<');
  });

  it('says which design seat proposed each, linking the comment it came from', () => {
    const html = renderToStaticMarkup(
      <DesignMemorySection
        repo="api"
        entries={[entry('p', 'proposed', { proposedBy: 'system-engineer', sourceUrl: 'https://github.com/acme/api/issues/12#issuecomment-4' })]}
      />,
    );
    expect(html).toContain('proposed by system-engineer');
    expect(html).toContain('href="https://github.com/acme/api/issues/12#issuecomment-4"');
  });

  it('offers Revert on an entry that superseded another, and only while that one is out of effect', () => {
    const html = renderToStaticMarkup(
      <DesignMemorySection
        repo="api"
        entries={[entry('new', 'accepted', { supersedes: 'old' }), entry('old', 'superseded'), entry('plain', 'accepted')]}
      />,
    );
    const replacer = html.slice(html.indexOf('data-memory="new"'), html.indexOf('data-memory="plain"'));
    expect(replacer).toContain('>Revert<');
    expect(html.slice(html.indexOf('data-memory="plain"'), html.indexOf('data-memory="old"'))).not.toContain('>Revert<');

    const restored = renderToStaticMarkup(<DesignMemorySection repo="api" entries={[entry('new', 'accepted', { supersedes: 'old' }), entry('old', 'accepted')]} />);
    expect(restored).not.toContain('>Revert<');
  });

  it('says it is empty until the first design', () => {
    expect(renderToStaticMarkup(<DesignMemorySection repo="api" entries={[]} />)).toContain('The first design on this repository starts it.');
  });
});
