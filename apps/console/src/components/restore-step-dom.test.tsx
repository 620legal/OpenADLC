// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestorePreview } from '@/lib/backup';
import { RestoreStep } from './restore-step';

/**
 * The walkthrough's restore in a DOM: what it reads and what it restores are
 * the same file, even when another file is chosen while one is being read.
 */

/** What the bridge says a backup holds, named after the archive it was sent so a test can tell whose it is. */
function previewOf(archive: string): RestorePreview {
  const from = atob(archive).replace(/\s+/g, '-');
  return {
    sealed: false,
    holds: {
      version: 2,
      createdAt: '2026-09-24T12:00:00.000Z',
      install: { settings: [], app: [], other: [] },
      repositories: [`exampleco/${from}`],
      bots: [],
      botSignIns: true,
      accounts: [],
      accountSignIns: true,
      history: null,
    },
    restores: { settings: [], app: [], repositories: [`exampleco/${from}`], accounts: [], bots: [], signIns: [], history: null, skipped: [], next: [] },
    signIns: [],
  } as unknown as RestorePreview;
}

/** A backup file whose bytes are read at once (happy-dom's own reader takes a timer or two). */
function backupFile(text: string, name: string): File {
  const file = new File([text], name);
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(text).buffer });
  return file;
}

let posts: { url: string; body: Record<string, unknown>; answer: (response: Response) => void }[];
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posts = [];
  // Each request is held until the test answers it.
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')), answer: resolve }))),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim() === label);
  if (!found) throw new Error(`no button says ${label}: ${[...container.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
  await settle();
}

async function pick(file: File): Promise<void> {
  const picker = container.querySelector<HTMLInputElement>('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

async function answer(index: number): Promise<void> {
  const post = posts[index]!;
  await act(async () => post.answer(Response.json(previewOf(post.body.archive as string))));
  await settle();
}

describe('the walkthrough’s restore', () => {
  it('drops a reading of the file before that answers after the next one was chosen, and restores the file it read', async () => {
    await act(async () => root.render(<RestoreStep restore={{ clean: true, setUp: [] }} onRestored={() => undefined} next={null} onContinue={() => undefined} />));
    await pick(backupFile('backup A', 'a.json'));
    await click(button('read the backup'));
    expect(posts.map((post) => post.url)).toEqual(['/api/restore/preview']);

    await pick(backupFile('backup B', 'b.json'));
    await answer(0);
    expect(container.textContent).toContain('b.json');
    expect(container.textContent).not.toContain('exampleco/backup-A');
    expect(() => button('Restore')).toThrow();

    await click(button('read the backup'));
    await answer(1);
    expect(container.textContent).toContain('exampleco/backup-B');
    await click(button('Restore'));
    expect(posts[2]!.url).toBe('/api/restore');
    expect(atob(posts[2]!.body.archive as string)).toBe('backup B');
  });

  it('shows no way to read the file before while the next one is still being read', async () => {
    await act(async () => root.render(<RestoreStep restore={{ clean: true, setUp: [] }} onRestored={() => undefined} next={null} onContinue={() => undefined} />));
    await pick(backupFile('backup A', 'a.json'));
    expect(button('read the backup').disabled).toBe(false);

    const slow = new File(['backup B'], 'b.json');
    Object.defineProperty(slow, 'arrayBuffer', { value: () => new Promise(() => undefined) });
    await pick(slow);
    expect(container.textContent).not.toContain('a.json');
    expect(() => button('read the backup')).toThrow();
  });
});
