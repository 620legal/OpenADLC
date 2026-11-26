// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntakeDialog, prefillAction, sentTo, whatNext, type RequestPrefill } from './intake-dialog';

vi.mock('@/app/actions', () => ({ fileRequest: vi.fn(async () => ({ ok: true, bot: 'intake', queued: false, position: null })) }));

describe('where the New request dialog says a request went', () => {
  it('names the repository a person chose', () => {
    expect(sentTo('api')).toBe('api');
  });

  it('says intake decides when none was chosen, not "no repository"', () => {
    expect(sentTo('')).toBe('intake decides the repository');
  });
});

describe('what the New request dialog says comes next', () => {
  it('says intake is starting when the bridge answered before its task existed', () => {
    // The bridge answers once the request is saved; "on it" claimed a task
    // that might not exist yet.
    expect(whatNext({ queued: false, position: null, starting: true })).toBe('Intake is starting on it');
  });

  it('says intake is on it when an older bridge answered with the task', () => {
    expect(whatNext({ queued: false, position: null })).toBe('Intake is on it');
  });

  it('gives its place in line, and why it waits while work is paused', () => {
    expect(whatNext({ queued: true, position: 2 })).toBe('Queued (#2)');
    expect(whatNext({ queued: true, position: 2, paused: 'work is paused' })).toBe('Queued (#2): work is paused, so it starts when work resumes');
  });
});

const ALERT: RequestPrefill = {
  repo: 'web',
  kind: 'defect',
  text: 'Fix the Dependabot alert “Prototype pollution in lodash” in web',
  details: 'Type: Dependabot alert #3\nSeverity: High\nOn GitHub: https://github.com/acme/web/security/dependabot/3',
};

describe('a request another page starts', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;
  const areas = () => [...dialog().querySelectorAll('textarea')] as HTMLTextAreaElement[];
  const selects = () => [...dialog().querySelectorAll('select')] as HTMLSelectElement[];
  const button = (label: string) => [...dialog().querySelectorAll('button')].find((one) => one.textContent?.trim() === label);

  async function render(open: boolean): Promise<void> {
    await act(async () => root.render(<IntakeDialog repos={['api', 'web']} open={open} onOpenChange={() => undefined} prefill={ALERT} />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  it('fills an empty form, and always chooses the repository', async () => {
    expect(prefillAction('', '  ')).toBe('fill');
    await render(true);
    expect(areas()[0]!.value).toBe(ALERT.text);
    expect(areas()[1]!.value).toBe(ALERT.details);
    expect(selects()[0]!.value).toBe('web');
    expect(selects()[1]!.value).toBe('defect');
    expect(button('Replace your draft with this alert')).toBeUndefined();
  });

  it('keeps a draft until the person chooses to replace it', async () => {
    expect(prefillAction('half a thought', '')).toBe('offer');
    window.sessionStorage.setItem('openadlc:draft:intake:text', 'half a thought');
    await render(false);
    await render(true);
    expect(areas()[0]!.value).toBe('half a thought');
    expect(selects()[0]!.value).toBe('web');

    const replace = button('Replace your draft with this alert');
    expect(replace).toBeDefined();
    await act(async () => replace!.click());
    expect(areas()[0]!.value).toBe(ALERT.text);
    expect(areas()[1]!.value).toBe(ALERT.details);
    expect(button('Replace your draft with this alert')).toBeUndefined();
  });
});
