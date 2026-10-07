// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentState, Uploaded } from './attachment-drop';

/**
 * The box files are given in, in a DOM: a file picked, dropped or pasted is
 * uploaded at once with its own progress, one that cannot go is refused
 * naming it before anything is sent, and the form learns the ids to send and
 * whether anything is still on its way.
 */

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('form');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function file(name: string, size: number, type: string): File {
  return new File([new Uint8Array(size)], name, { type });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function mount(upload: (file: File, onProgress: (fraction: number) => void) => Promise<Uploaded>): Promise<AttachmentState[]> {
  const states: AttachmentState[] = [];
  const { AttachmentDrop } = await import('./attachment-drop');
  await act(async () => root.render(<AttachmentDrop onChange={(state) => states.push(state)} upload={upload} />));
  return states;
}

async function pick(files: File[]): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

describe('giving files', () => {
  it('uploads a picked file and hands the form its id once it is in, busy until then', async () => {
    let finish: (value: Uploaded) => void = () => undefined;
    const upload = vi.fn((_file: File, onProgress: (fraction: number) => void) => {
      onProgress(0.5);
      return new Promise<Uploaded>((resolve) => (finish = resolve));
    });
    const states = await mount(upload);
    await pick([file('mockup.png', 2048, 'image/png')]);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ ids: [], busy: true });
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');

    await act(async () => finish({ id: 'f-1', name: 'mockup.png', mediaType: 'image/png', sizeBytes: 2048 }));
    await settle();
    expect(states.at(-1)).toEqual({ ids: ['f-1'], busy: false });
  });

  it('refuses a file that cannot go, naming it, without uploading it', async () => {
    const upload = vi.fn(async () => ({ id: 'x', name: 'x', mediaType: 'x', sizeBytes: 1 }));
    await mount(upload);
    await pick([file('demo.mov', 100, 'video/quicktime'), file('huge.png', 10 * 1024 * 1024 + 1, 'image/png')]);
    const errors = [...container.querySelectorAll('[role="alert"]')].map((one) => one.textContent);
    expect(errors).toEqual([expect.stringMatching(/^demo\.mov is not a type/), expect.stringMatching(/^huge\.png is 10\.1 MB; a file can be 10 MB at most/)]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('says the bridge’s reason when it refuses one, naming the file', async () => {
    await mount(async () => {
      throw new Error('notes.txt contains what looks like a credential');
    });
    await pick([file('notes.txt', 10, 'text/plain')]);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('notes.txt contains what looks like a credential');
  });

  it('takes a screenshot pasted anywhere in the form', async () => {
    const upload = vi.fn(async (picked: File) => ({ id: 'f-2', name: picked.name, mediaType: 'image/png', sizeBytes: picked.size }));
    const states = await mount(upload);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [file('image.png', 512, 'image/png')] } });
    await act(async () => container.dispatchEvent(paste));
    await settle();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({ ids: ['f-2'], busy: false });
  });
});
