'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { readBridgeError } from '@/lib/model-onboarding';
import { BRIDGE_NOT_ANSWERING, reach } from '@/lib/reach';

/**
 * One install setting, asked for where it is needed.
 *
 * These were briefly a single five-field form, which is how a setup page becomes
 * a wall: everything visible at once, nothing obviously next. A setting belongs
 * in the step it is part of — the organization where you say where things live,
 * the client id beside the app you just made, the secret beside the webhook — so
 * each screen asks one thing and explains that one thing.
 *
 * A value saved here takes effect on the next request: the bridge prefers a
 * stored setting over its start-up environment.
 */
export type SettingKey =
  | 'organization'
  | 'githubClientId'
  | 'appPrivateKey'
  | 'appClientSecret'
  | 'operatorEmail'
  | 'installName'
  | 'attributionMode';

export interface InstallSettings {
  organization: string;
  /** What the header on every post OpenADLC writes calls this install. */
  installName?: string;
  /** Whether a crew post whose signature does not check still counts. Absent from an older bridge. */
  attributionMode?: 'audit' | 'enforce';
  githubClientId: string;
  automationBot: string;
  humans: string;
  publicUrl: string;
  operatorEmail: string;
  webhookSecretConfigured: boolean;
  /** Whether the app's private key is stored, so OpenADLC can invite the crew. */
  appPrivateKeyConfigured: boolean;
  /**
   * Whether the app's client secret is stored, so each task's token is narrowed
   * to its repository. Absent from an older bridge.
   */
  appClientSecretConfigured?: boolean;
  /** Which are stored here rather than inherited from the environment. */
  storedKeys: string[];
  webhookUrl: string;
}

/** `initial`, when the page read the settings on the server, is shown at once and not asked for again. */
export function useInstallSettings(initial: InstallSettings | null = null) {
  const [settings, setSettings] = useState<InstallSettings | null>(initial);
  const readAlready = useRef(initial !== null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // No answer at all is said as the house says it, not as the browser's "Failed to fetch".
      const response = await reach('/api/install', { cache: 'no-store' }, BRIDGE_NOT_ANSWERING);
      if (!response.ok) throw new Error(`the bridge answered ${response.status}. Try again in a moment; if it keeps failing, run fleetadlc doctor.`);
      setSettings((await response.json()) as InstallSettings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not read the settings');
    }
  }, []);

  useEffect(() => {
    if (readAlready.current) return;
    void reload();
  }, [reload]);

  const save = useCallback(
    async (key: SettingKey, value: string) => {
      const response = await fetch('/api/install', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      // The bridge's sentence, not the JSON it came in.
      if (!response.ok) throw new Error(await readBridgeError(response));
      await reload();
    },
    [reload],
  );

  return { settings, error, save, reload };
}

/** Why the install's settings could not be read, and a way to ask again. */
export function SettingsUnread({ error, reload }: { error: string; reload: () => Promise<void> }) {
  return (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-alarm">
      Could not read the install’s settings: {error}
      <Button size="sm" onClick={() => void reload()}>
        try again
      </Button>
    </p>
  );
}

export function InstallField({
  settingKey,
  label,
  placeholder,
  hint,
  secret,
  fileAccept,
  multiline,
  settings,
  save,
  onSaved,
}: {
  settingKey: SettingKey;
  label: string;
  placeholder: string;
  hint?: string;
  secret?: boolean;
  /**
   * File extensions to offer a picker for, when the value arrives as a file.
   *
   * GitHub hands you an app's private key as a `.pem` download and never shows
   * it again — so "paste it here" means find the file, open it in something,
   * select all, copy. The value it wants is the file's contents; this reads
   * them directly.
   */
  fileAccept?: string;
  /** A PEM is many lines and will not go into a single-line input. */
  multiline?: boolean;
  settings: InstallSettings;
  save: (key: SettingKey, value: string) => Promise<void>;
  onSaved?: () => void;
}) {
  const stored =
    settingKey === 'appPrivateKey'
      ? settings.appPrivateKeyConfigured
      : settingKey === 'appClientSecret'
        ? settings.appClientSecretConfigured === true
        : settings.storedKeys.includes(settingKey);
  const current = secret ? '' : ((settings[settingKey as keyof InstallSettings] as string) ?? '');

  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The file a value was read from, so the page can say which one. */
  const [fromFile, setFromFile] = useState<string | null>(null);
  /** A secret saved from this field, whose value has been cleared from it. */
  const [saved, setSaved] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);

  // When a step is revisited after saving, show what is actually stored.
  useEffect(() => {
    if (!secret) setValue(current);
  }, [current, secret]);

  // A secret is saved trimmed, and the bridge took an empty one as "delete
  // it": a space or Enter typed into the private key field, then save, removed
  // the app's key from a working install. Whitespace is not a change.
  const dirty = secret ? value.trim().length > 0 : value !== current;

  async function commit(override?: string) {
    const next = (override ?? value).trim();
    if (secret && next === '') {
      setError('Nothing to save: paste the key or choose the .pem file.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await save(settingKey, next);
      // The bridge never sends a secret back, so the reset above skips them,
      // and a saved private key stayed in the field, readable on any shared
      // screen, until the page was left.
      if (secret) {
        setValue('');
        setSaved(true);
      }
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'could not save');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Reads a chosen file and saves its contents.
   *
   * Saved on choosing rather than waiting for a second click: picking the file
   * is the deliberate act, and a "save" that appears afterwards next to a field
   * still showing `already set` is a step whose purpose is unclear.
   *
   * The file is read in the browser and its contents go the same way a pasted
   * value would. Checked here as well as on the bridge, so choosing the wrong
   * file says which file was wrong instead of returning a refusal about a PEM.
   */
  async function readFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);

    const text = await file.text().catch(() => null);
    if (text === null) {
      setError(`could not read ${file.name}`);
      return;
    }
    if (!text.includes('PRIVATE KEY')) {
      setError(`${file.name} does not contain a private key. Choose the .pem file GitHub downloaded when you generated the app’s private key.`);
      return;
    }

    // Saved straight from the file, never put in the field to be drawn.
    setFromFile(file.name);
    await commit(text);
  }

  return (
    <div className="max-w-md">
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-dim">{label}</span>
        {multiline ? (
          <textarea
            value={value}
            rows={4}
            onChange={(event) => setValue(event.target.value)}
            placeholder={stored || saved ? 'already set' : placeholder}
            // A secret is masked as the single-line field's password input is,
            // and kept from the browser's spellcheck, which may send it away.
            spellCheck={false}
            autoComplete="off"
            style={secret ? ({ WebkitTextSecurity: 'disc' } as CSSProperties) : undefined}
            className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 font-mono text-[11px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
        ) : (
          <input
            type={secret ? 'password' : 'text'}
            value={value}
            autoComplete={secret ? 'new-password' : 'off'}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dirty) void commit();
            }}
            placeholder={secret && (stored || saved) ? 'already set' : placeholder}
            className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
          />
        )}
      </label>

      {hint && <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{hint}</p>}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {fileAccept && (
          <>
            <input
              ref={filePicker}
              type="file"
              accept={fileAccept}
              className="hidden"
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                // Cleared so choosing the same file twice fires again.
                event.target.value = '';
              }}
            />
            <Button size="sm" onClick={() => filePicker.current?.click()} disabled={busy}>
              {busy ? 'reading…' : `choose the ${fileAccept} file`}
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" onClick={() => void commit()} disabled={!dirty || busy}>
          {busy ? 'saving…' : (stored || saved) && !dirty ? 'saved' : 'save'}
        </Button>
        {fromFile && <span className="text-[11px] text-signal">read from {fromFile}</span>}
        {error && <span className="text-[11px] text-attention">{error}</span>}
      </div>
    </div>
  );
}

/**
 * The GitHub App's client secret, for an app made by hand or before the
 * manifest flow kept it. With it each task's GitHub token reaches only the
 * task's repository; without it a task's token reaches every repository its
 * bot account can, which is every one OpenADLC manages.
 */
export function AppClientSecretField({
  settings,
  save,
}: {
  settings: InstallSettings;
  save: (key: SettingKey, value: string) => Promise<void>;
}) {
  // An older bridge does not say, and would refuse the field.
  if (settings.appClientSecretConfigured === undefined) return null;
  return (
    <div className="mt-4 border-t border-well pt-3">
      <InstallField
        settingKey="appClientSecret"
        label="App client secret"
        placeholder="generate one on the app’s settings page and paste it here"
        hint="Narrows each task’s GitHub token to the task’s repository. Without it a task’s token reaches every repository its bot can. Made by GitHub under Client secrets on the app’s settings page; it is shown there once."
        secret
        settings={settings}
        save={save}
      />
    </div>
  );
}

