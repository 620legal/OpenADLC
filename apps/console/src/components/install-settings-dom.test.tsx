// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstallField, useInstallSettings, type InstallSettings, type SettingKey } from './install-settings';

/**
 * The app private key is the install's widest credential. Its field showed the
 * PEM in plain text when pasted or read from a file, and kept it there after
 * saving.
 */

const SETTINGS: InstallSettings = {
  organization: 'exampleco',
  githubClientId: 'Iv1.zzz',
  automationBot: '',
  humans: 'janedoe',
  publicUrl: '',
  operatorEmail: '',
  webhookSecretConfigured: false,
  appPrivateKeyConfigured: false,
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

function draw(save: (key: SettingKey, value: string) => Promise<void>, options: { secret?: boolean; settingKey?: SettingKey } = {}): void {
  const secret = options.secret ?? true;
  act(() =>
    root.render(
      <InstallField
        settingKey={options.settingKey ?? 'appPrivateKey'}
        label="app private key (PEM)"
        placeholder="-----BEGIN RSA PRIVATE KEY-----"
        secret={secret}
        multiline
        fileAccept={secret ? '.pem' : undefined}
        settings={SETTINGS}
        save={save}
      />,
    ),
  );
}

function area(): HTMLTextAreaElement {
  const found = container.querySelector('textarea');
  if (!found) throw new Error('no textarea');
  return found;
}

function saveButton(): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((one) => ['save', 'saved', 'saving…'].includes(one.textContent ?? ''));
  if (!found) throw new Error('no save button');
  return found;
}

/** Types into the textarea the way React hears it. */
function type(text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(area(), text);
    area().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the app private key field', () => {
  it('masks the key while it is typed, and keeps it from spellcheck and autocomplete', () => {
    // happy-dom drops a style it does not know, so the mask is read from the markup.
    const markup = (secret: boolean) =>
      renderToStaticMarkup(
        <InstallField settingKey="appPrivateKey" label="key" placeholder="" secret={secret} multiline settings={SETTINGS} save={async () => undefined} />,
      );
    expect(markup(true)).toContain('-webkit-text-security:disc');
    expect(markup(false)).not.toContain('text-security');

    draw(vi.fn(async () => undefined));
    type(PEM);
    expect(area().getAttribute('spellcheck')).toBe('false');
    expect(area().getAttribute('autocomplete')).toBe('off');
  });

  it('clears a pasted key once it is saved, and says it was saved', async () => {
    const save = vi.fn(async () => undefined);
    draw(save);
    type(PEM);
    await act(async () => saveButton().click());

    expect(save).toHaveBeenCalledWith('appPrivateKey', PEM);
    expect(area().value).toBe('');
    expect(area().placeholder).toBe('already set');
    expect(saveButton().textContent).toBe('saved');
    expect(saveButton().disabled).toBe(true);
    expect(container.innerHTML).not.toContain('zzz-test-zzz');
  });

  it('saves a chosen .pem file without ever putting the key in the field', async () => {
    const seen: string[] = [];
    const save = vi.fn(async () => {
      seen.push(area().value);
    });
    draw(save);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!picker) throw new Error('no file picker');
    Object.defineProperty(picker, 'files', { value: [new File([PEM], 'exampleco.private-key.pem')] });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(save).toHaveBeenCalledWith('appPrivateKey', PEM);
    expect(seen).toEqual(['']);
    expect(area().value).toBe('');
    expect(container.innerHTML).not.toContain('zzz-test-zzz');
    expect(container.textContent).toContain('read from exampleco.private-key.pem');
    expect(saveButton().textContent).toBe('saved');
  });

  it('keeps what was typed when the save fails, and shows why', async () => {
    draw(vi.fn(async () => Promise.reject(new Error('that does not look like a PEM private key'))));
    type(PEM);
    await act(async () => saveButton().click());

    expect(area().value).toBe(PEM);
    expect(container.textContent).toContain('that does not look like a PEM private key');
    expect(saveButton().textContent).toBe('save');
  });
});

describe('a multiline field that is not a secret', () => {
  it('shows and keeps its value after saving, unmasked', async () => {
    const save = vi.fn(async () => undefined);
    draw(save, { secret: false, settingKey: 'installName' });
    type('exampleco crew');
    await act(async () => saveButton().click());

    expect(save).toHaveBeenCalledWith('installName', 'exampleco crew');
    expect(area().value).toBe('exampleco crew');
  });
});

describe('a save the bridge refuses', () => {
  it('throws the bridge’s sentence, not the JSON it came in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'attributionMode is audit or enforce' }, null, 2), { status: 400 })));
    let save: ((key: SettingKey, value: string) => Promise<void>) | null = null;
    function Harness() {
      save = useInstallSettings(SETTINGS).save;
      return null;
    }
    act(() => root.render(<Harness />));
    try {
      await expect(save!('attributionMode', 'sometimes')).rejects.toThrow(/^attributionMode is audit or enforce$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
