// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallField, type InstallSettings } from './install-settings';

/**
 * The app private key's field, where a blank save used to reach the bridge as
 * an empty value, and an empty value deleted the stored key.
 */

const SETTINGS: InstallSettings = {
  organization: 'exampleco',
  githubClientId: 'Iv1.zzz',
  automationBot: '',
  humans: 'janedoe',
  publicUrl: '',
  operatorEmail: '',
  webhookSecretConfigured: true,
  appPrivateKeyConfigured: true,
  storedKeys: [],
  webhookUrl: '',
};

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nzzz-test-zzz\n-----END RSA PRIVATE KEY-----';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(save: (key: string, value: string) => Promise<void>): void {
  act(() =>
    root.render(
      <InstallField
        settingKey="appPrivateKey"
        label="app private key (PEM)"
        placeholder="-----BEGIN RSA PRIVATE KEY-----"
        secret
        multiline
        settings={SETTINGS}
        save={save}
      />,
    ),
  );
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => ['save', 'saved', 'saving…'].includes(one.textContent ?? ''));
  if (!found) throw new Error('no save button');
  return found;
}

/** Types into the textarea the way React hears it. */
function type(text: string): void {
  const area = container.querySelector('textarea');
  if (!area) throw new Error('no textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the app private key field', () => {
  it('does not count whitespace as a change, so save stays off', () => {
    const save = vi.fn(async () => undefined);
    draw(save);
    type(' \n');
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toBe('saved');
  });

  it('does not send a blank value when save is pressed', async () => {
    const save = vi.fn(async () => undefined);
    draw(save);
    type(' \n');
    await act(async () => saveButton().click());
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a blank value that reaches save anyway, and says what to do', async () => {
    const save = vi.fn(async () => undefined);
    draw(save);
    type(' \n');
    // React drops a click on a disabled button, so the save handler is called
    // as a click that got past the button would call it.
    const button = saveButton();
    const propsKey = Object.keys(button).find((key) => key.startsWith('__reactProps'));
    const props = (button as unknown as Record<string, { onClick: () => void }>)[propsKey ?? ''];
    await act(async () => props?.onClick());
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Nothing to save: paste the key or choose the .pem file.');
  });

  it('still saves a pasted PEM, trimmed', async () => {
    const save = vi.fn(async () => undefined);
    draw(save);
    type(`${PEM}\n`);
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(save).toHaveBeenCalledWith('appPrivateKey', PEM);
  });
});
