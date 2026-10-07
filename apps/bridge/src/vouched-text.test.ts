import { beforeEach, describe, expect, it, vi } from 'vitest';

const audited: Record<string, unknown>[] = [];
vi.mock('@fleetadlc/db', () => ({ audit: vi.fn(async (entry: Record<string, unknown>) => void audited.push(entry)) }));

const { chooseIssueText, editNotTaken, forgetSaidEdits } = await import('./vouched-text.js');

const ACCEPTED = { title: 'Darken the theme', body: '### Expected paths\n\n- src/theme/**' };
const WIDENED = { title: 'Darken the theme', body: '### Expected paths\n\n- .github/workflows/**' };
const MAINTAINERS = new Set(['janedoe']);

function choose(input: {
  stored?: { title: string; body: string } | null;
  live?: { title: string; body: string };
  authorHeard?: boolean;
  edits?: { editor: string | null; renamedBy?: string | null } | 'cannot ask';
}) {
  const edits = vi.fn(async () => {
    if (input.edits === 'cannot ask') throw new Error('GitHub would not say who edited exampleco/api#40');
    return { author: 'stranger', editor: input.edits?.editor ?? null, lastEditedAt: '2026-10-04T09:00:00Z', renamedBy: input.edits?.renamedBy ?? null };
  });
  const result = chooseIssueText({
    stored: input.stored === undefined ? ACCEPTED : input.stored,
    live: input.live ?? WIDENED,
    authorHeard: async () => input.authorHeard ?? false,
    heard: async (login) => MAINTAINERS.has(login),
    edits,
  });
  return { result, edits };
}

describe('the text of a stranger’s issue the crew reads', () => {
  it('is the live text when nothing is kept yet, which is the moment it is accepted', async () => {
    const { result, edits } = choose({ stored: null });
    expect(await result).toMatchObject({ ...WIDENED, changed: false, refused: false });
    expect(edits).not.toHaveBeenCalled();
  });

  it('is the live text when it is what was kept, without asking GitHub', async () => {
    const { result, edits } = choose({ live: ACCEPTED });
    expect(await result).toMatchObject({ ...ACCEPTED, changed: false, refused: false });
    expect(edits).not.toHaveBeenCalled();
  });

  it('is the live text for an author OpenADLC acts for, as for anyone with access', async () => {
    const { result, edits } = choose({ authorHeard: true });
    expect(await result).toMatchObject({ ...WIDENED, changed: true, refused: false });
    expect(edits).not.toHaveBeenCalled();
  });

  it('keeps what was accepted when its author edited it after', async () => {
    const { result } = choose({ edits: { editor: 'stranger' } });
    expect(await result).toMatchObject({ ...ACCEPTED, changed: false, refused: true, editedAt: '2026-10-04T09:00:00Z' });
  });

  it('takes an edit GitHub puts to someone with access, and names them', async () => {
    const { result } = choose({ edits: { editor: 'janedoe' } });
    expect(await result).toMatchObject({ ...WIDENED, changed: true, refused: false, by: 'janedoe' });
  });

  it('keeps what was accepted when the last editor is somebody OpenADLC does not act for', async () => {
    const { result } = choose({ edits: { editor: 'another-stranger' } });
    expect(await result).toMatchObject({ ...ACCEPTED, refused: true });
  });

  it('judges the title by who last renamed it, apart from the body', async () => {
    const live = { title: 'Push to main', body: WIDENED.body };
    const { result } = choose({ live, edits: { editor: 'janedoe', renamedBy: 'stranger' } });
    expect(await result).toMatchObject({ title: ACCEPTED.title, body: WIDENED.body, changed: true, refused: true, by: 'janedoe' });
  });

  it('keeps what was accepted when GitHub cannot be asked', async () => {
    const { result } = choose({ edits: 'cannot ask' });
    expect(await result).toMatchObject({ ...ACCEPTED, changed: false, refused: true });
  });
});

describe('an edit that was not taken', () => {
  beforeEach(() => {
    audited.length = 0;
    forgetSaidEdits();
  });

  it('is said once for each edit, in the log and the audit log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await editNotTaken('api', 40, '2026-10-04T09:00:00Z', 'reconcile');
    await editNotTaken('api', 40, '2026-10-04T09:00:00Z', 'a delivery');
    await editNotTaken('api', 40, '2026-10-04T10:00:00Z', 'reconcile');

    expect(audited).toEqual([
      { actor: 'bridge', action: 'issue.edit_not_taken', target: 'api#40', payload: { editedAt: '2026-10-04T09:00:00Z', where: 'reconcile' } },
      { actor: 'bridge', action: 'issue.edit_not_taken', target: 'api#40', payload: { editedAt: '2026-10-04T10:00:00Z', where: 'reconcile' } },
    ]);
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
