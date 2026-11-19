// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleasePrepareOffer } from '@/lib/api';

/**
 * Prepare next version in a DOM (#363): the suggestion in an editable field,
 * the edited version sent with the view's id and nothing else, a refusal said
 * beside the field with nothing changed, and the request shown once filed.
 */

const { PrepareVersion } = await import('./prepare-version');

const OFFER: ReleasePrepareOffer = { suggested: '156.0.8078.79-abc.30', last: { version: '156.0.8078.79-abc.29', tag: 'v156.0.8078.79-abc.29' }, versionFile: 'VERSION', versionKey: null };

let root: Root;
let container: HTMLElement;
let posted: { url: string; body: unknown }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posted = [];
  answer = {
    status: 200,
    body: {
      request: { id: 'abcdef12-0000-4000-8000-000000000001', state: 'queued' },
      subject: 'request:abcdef12',
      preparing: { requestId: 'abcdef12-0000-4000-8000-000000000001', subject: 'request:abcdef12', state: 'queued', version: '156.0.8078.80-abc.1', issue: null, pullRequest: null, unknown: false },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init?.body)) });
      return Response.json(answer.body, { status: answer.status });
    }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';
const field = () => container.querySelector<HTMLInputElement>('input[data-prepare-version]')!;

async function draw(): Promise<void> {
  await act(async () => root.render(<PrepareVersion repo="mac-app" viewId="view-1" prepare={OFFER} />));
}

/** Types into the field as React hears it. */
async function type(value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(field(), value);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function send(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-prepare-send]')!.click());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Prepare next version', () => {
  it('suggests the next version, sends the edited one with the view, and shows the request it filed', async () => {
    await draw();
    expect(field().value).toBe('156.0.8078.79-abc.30');
    expect(text()).toContain('Once it merges, Cut release offers 156.0.8078.79-abc.30 after 156.0.8078.79-abc.29.');

    await type('156.0.8078.80-abc.1');
    expect(text()).toContain('Cut release offers 156.0.8078.80-abc.1 after');
    await send();

    expect(posted).toEqual([{ url: '/api/releases/mac-app/prepare', body: { viewId: 'view-1', version: '156.0.8078.80-abc.1' } }]);
    expect(container.querySelector('[data-prepare-send]')).toBeNull();
    expect(text()).toContain('Preparing 156.0.8078.80-abc.1');
    expect(container.querySelector<HTMLAnchorElement>('a[data-preparing-request]')?.getAttribute('href')).toBe('/?item=request%3Aabcdef12');
  });

  it('says a refusal beside the field, and keeps the field to try again', async () => {
    answer = { status: 422, body: { error: '156.0.8078.79-abc.28 is not above the last release, 156.0.8078.79-abc.29: raise it in VERSION' } };
    await draw();
    await type('156.0.8078.79-abc.28');
    await send();
    expect(container.querySelector('[data-prepare-error]')?.textContent).toBe('156.0.8078.79-abc.28 is not above the last release, 156.0.8078.79-abc.29: raise it in VERSION');
    expect(field().value).toBe('156.0.8078.79-abc.28');
    expect(container.querySelector('[data-preparing]')).toBeNull();
  });

  it('sends nothing for an empty version', async () => {
    await draw();
    await type('  ');
    expect(container.querySelector<HTMLButtonElement>('button[data-prepare-send]')!.disabled).toBe(true);
    expect(posted).toEqual([]);
  });
});
