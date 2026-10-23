// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Brand, Role } from '@/lib/api';

/** Settings → Appearance → Console name and logo: saved through PATCH /api/install, checked here before anything is sent. */

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
import { RoleProvider } from './app-header';
import { ConsoleBrandPart, logoFileProblem } from './console-brand';

let root: Root;
let container: HTMLElement;
let sent: Record<string, unknown>[];
let answer: () => Response;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  answer = () => new Response(JSON.stringify({ written: [] }), { status: 200 });
  router.refresh.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return answer();
    }),
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

async function mount(brand: Brand, role: Role = 'admin'): Promise<void> {
  await act(async () =>
    root.render(
      <RoleProvider role={role}>
        <ConsoleBrandPart brand={brand} />
      </RoleProvider>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent === text);
  if (!found) throw new Error(`no button ${text}: ${[...container.querySelectorAll('button')].map((one) => one.textContent).join(', ')}`);
  return found;
}

async function type(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(file: File): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

describe('the console name', () => {
  it('saves the name trimmed, and has the page read the header again', async () => {
    await mount({ name: null, logoUrl: null });
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    expect(input.maxLength).toBe(40);
    expect(input.placeholder).toBe('OpenADLC');
    expect(button('Save').disabled).toBe(true);
    await type('  Acme Legal  ');
    await act(async () => button('Save').click());
    await settle();
    expect(sent).toEqual([{ consoleName: 'Acme Legal' }]);
    expect(router.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain('Saved');
  });

  it('removes it with an empty value, which goes back to OpenADLC', async () => {
    await mount({ name: 'Acme Legal', logoUrl: null });
    await act(async () => button('Remove').click());
    await settle();
    expect(sent).toEqual([{ consoleName: '' }]);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('');
  });

  it('shows the bridge’s own words when it refuses', async () => {
    answer = () => new Response(JSON.stringify({ error: 'a console name is at most 40 characters; this one is 41' }), { status: 400 });
    await mount({ name: null, logoUrl: null });
    await type('Acme');
    await act(async () => button('Save').click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Not saved: a console name is at most 40 characters; this one is 41');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('the console logo', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('sends a chosen image as a data URL', async () => {
    await mount({ name: null, logoUrl: null });
    expect(container.querySelector('input[type="file"]')?.getAttribute('accept')).toBe('image/png,image/jpeg,image/svg+xml,image/webp');
    await choose(new File([PNG], 'acme.png', { type: 'image/png' }));
    expect(sent).toHaveLength(1);
    expect(String(sent[0]?.consoleLogo)).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(router.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain('Saved acme.png');
  });

  it('refuses a file too large, of another type or empty, before sending anything, in the bridge’s words', async () => {
    await mount({ name: null, logoUrl: null });
    await choose(new File([new Uint8Array(300 * 1024)], 'big.png', { type: 'image/png' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Not saved: the logo must be a PNG, JPG, SVG or WebP image of at most 256 KB; this one is 300 KB');
    await choose(new File([new Uint8Array([0x47, 0x49, 0x46])], 'moving.gif', { type: 'image/gif' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('this one is image/gif');
    expect(sent).toEqual([]);

    expect(logoFileProblem({ type: 'image/png', size: 0 })).toContain('this one is empty');
    expect(logoFileProblem({ type: '', size: 10 })).toContain('PNG, JPG, SVG or WebP');
    expect(logoFileProblem({ type: 'image/webp', size: 256 * 1024 })).toBeNull();
  });

  it('shows the bridge’s refusal of a file whose content is not the type it claims', async () => {
    answer = () => new Response(JSON.stringify({ error: 'the logo must be a PNG, JPG, SVG or WebP image of at most 256 KB; this one says PNG but is not an image' }), { status: 400 });
    await mount({ name: null, logoUrl: null });
    await choose(new File(['just some text'], 'notes.png', { type: 'image/png' }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('this one says PNG but is not an image');
  });

  it('previews the logo set through an <img>, and removes it with an empty value', async () => {
    await mount({ name: null, logoUrl: '/api/brand/logo?v=0123456789ab' });
    expect(container.querySelector('img[data-logo-preview]')?.getAttribute('src')).toBe('/api/brand/logo?v=0123456789ab');
    await act(async () => button('Remove').click());
    await settle();
    expect(sent).toEqual([{ consoleLogo: '' }]);
  });
});

describe('for someone who is not an admin', () => {
  it('draws nothing', async () => {
    await mount({ name: 'Acme Legal', logoUrl: '/api/brand/logo?v=1' }, 'user');
    expect(container.innerHTML).toBe('');
  });
});
