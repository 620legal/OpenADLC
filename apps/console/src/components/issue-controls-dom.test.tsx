// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleProvider } from './app-header';

const calls: { action: string; args: unknown[] }[] = [];
vi.mock('@/app/actions', () => ({
  pauseItem: vi.fn(async (...args: unknown[]) => {
    calls.push({ action: 'pause', args });
    return { ok: true };
  }),
  resumeItem: vi.fn(async () => ({ ok: true })),
  playItemNext: vi.fn(async (...args: unknown[]) => {
    calls.push({ action: 'next', args });
    return { ok: true };
  }),
  previewCancelItem: vi.fn(async () => ({
    ok: true,
    preview: {
      issue: { number: 7, title: 'Add rub.html', url: 'https://github.com/acme/web/issues/7' },
      pr: { number: 9, url: 'https://github.com/acme/web/pull/9', branch: 'agent/builder/7-issue-7' },
      tasks: [{ id: 'task-1', bot: 'builder', kind: 'implement', state: 'running' }],
      questions: 1,
    },
  })),
  cancelItem: vi.fn(async (...args: unknown[]) => {
    calls.push({ action: 'cancel', args });
    return { ok: true, outcome: { done: ['stopped builder’s implement', 'closed #9 and deleted its branch'], notDone: [{ step: 'issue', what: 'close #7', why: 'GitHub refused' }] } };
  }),
}));

const { IssueControls } = await import('./issue-controls');

afterEach(() => {
  calls.length = 0;
  document.body.innerHTML = '';
});

async function mount() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const opened: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    createRoot(host).render(
      <RoleProvider role="admin">
        {/* The card opens on a click anywhere on it, as the board's does. */}
        <article onClick={() => opened.push('card')}>
          <IssueControls compact issue={{ subject: 'web#7', number: 7, held: null, next: false }} />
        </article>
      </RoleProvider>,
    );
  });
  const press = async (label: string) =>
    act(async () => {
      document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
    });
  return { opened, press };
}

describe('an issue’s controls on its card', () => {
  it('pause and play next do their own thing, and do not open the card', async () => {
    const { opened, press } = await mount();
    await press('Pause #7');
    await press('Do #7 next');
    expect(calls).toEqual([
      { action: 'pause', args: ['web#7'] },
      { action: 'next', args: ['web#7', true] },
    ]);
    expect(opened).toEqual([]);
  });

  it('a refusal is the bridge’s sentence on a line of its own, below the buttons, not beside them', async () => {
    const { pauseItem } = await import('@/app/actions');
    vi.mocked(pauseItem).mockResolvedValueOnce({ ok: false, error: 'GitHub would not put fleetadlc:paused on acme/web#7.' } as never);
    const { press } = await mount();
    await press('Pause #7');

    const said = document.querySelector('[data-control-error]')!;
    expect(said.textContent).toBe('GitHub would not put fleetadlc:paused on acme/web#7.');
    expect(said.closest('[data-issue-controls]')).toBeNull();
    expect(said.className).toContain('basis-full');
  });

  it('cancel shows what it will do first, wants a reason, then says what was done and what was not', async () => {
    const { opened, press } = await mount();
    await press('Cancel #7');
    expect(opened).toEqual([]);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain('builder’s implement (running)');
    expect(dialog).toContain('Close its open question');
    expect(dialog).toContain('Close pull request #9 unmerged');
    expect(dialog).toContain('agent/builder/7-issue-7');
    expect(dialog).toContain('Close issue #7 as not planned');

    const confirm = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Cancel #7')!;
    expect(confirm.disabled).toBe(true);

    const reason = document.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(reason, 'superseded by #12');
      reason.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);
    await act(async () => confirm.click());

    expect(calls).toEqual([{ action: 'cancel', args: ['web#7', 'superseded by #12'] }]);
    const after = document.body.textContent ?? '';
    expect(after).toContain('✓ closed #9 and deleted its branch');
    expect(after).toContain('✕ close #7 — GitHub refused');
  });

  it('cancel warns of no branch the bridge will not delete', async () => {
    // The bridge leaves out a branch that is not the crew's own for the
    // issue: a fork's, or the repository's `develop`.
    const { previewCancelItem } = await import('@/app/actions');
    vi.mocked(previewCancelItem).mockResolvedValueOnce({
      ok: true,
      preview: {
        issue: { number: 7, title: 'Add rub.html', url: 'https://github.com/acme/web/issues/7' },
        pr: { number: 9, url: 'https://github.com/acme/web/pull/9', branch: null },
        tasks: [],
        questions: 0,
      },
    } as never);
    const { press } = await mount();
    await press('Cancel #7');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    const dialog = document.body.textContent ?? '';
    expect(dialog).toContain('Close pull request #9 unmerged');
    expect(dialog).not.toContain('delete its branch');
  });
});
