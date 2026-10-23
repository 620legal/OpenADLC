'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useBrand, useRole } from '@/components/app-header';
import { SettingsPart } from '@/components/settings-sections';
import { Button } from '@/components/ui/button';
import { readBridgeError } from '@/lib/model-onboarding';

export const CONSOLE_NAME_MAX = 40;
export const CONSOLE_LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'];

/**
 * Why a chosen file cannot be the logo, in the bridge's words (`brand.ts`), or
 * null. Said before anything is sent: a 5 MB photo was otherwise read into the
 * page and posted only to be refused. The bridge checks the bytes as well.
 */
export function logoFileProblem(file: { type: string; size: number }): string | null {
  const allowed = 'the logo must be a PNG, JPG, SVG or WebP image of at most 256 KB';
  if (!LOGO_TYPES.includes(file.type)) return `${allowed}; this one is ${file.type || 'of a type the browser does not know'}`;
  if (file.size === 0) return `${allowed}; this one is empty`;
  if (file.size > CONSOLE_LOGO_MAX_BYTES) return `${allowed}; this one is ${Math.ceil(file.size / 1024)} KB`;
  return null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

type Status = { busy: boolean; error: string | null; saved: string | null };
const IDLE: Status = { busy: false, error: null, saved: null };

/**
 * Settings → Appearance: what the top left of the console says, and the logo
 * beside it, for everyone using it. An admin's: nothing is drawn for anyone
 * else, and the bridge refuses their change whatever the page offered. Not the
 * install name, which heads OpenADLC's posts on GitHub. What is set now is
 * what the root layout read for the header, so the two never disagree.
 */
export function ConsoleBrandPart() {
  const brand = useBrand();
  const role = useRole();
  const router = useRouter();
  const [name, setName] = useState(brand.name ?? '');
  const [nameStatus, setNameStatus] = useState<Status>(IDLE);
  const [logoStatus, setLogoStatus] = useState<Status>(IDLE);
  const picker = useRef<HTMLInputElement>(null);

  if (role !== 'admin') return null;

  async function save(key: 'consoleName' | 'consoleLogo', value: string, set: (status: Status) => void, saved: string): Promise<boolean> {
    set({ busy: true, error: null, saved: null });
    try {
      const response = await fetch('/api/install', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      // The bridge's sentence, not the JSON it came in.
      if (!response.ok) throw new Error(await readBridgeError(response));
      set({ busy: false, error: null, saved });
      // The header on this page reads the brand again, as every next page does.
      router.refresh();
      return true;
    } catch (cause) {
      set({ busy: false, error: cause instanceof Error ? cause.message : 'could not save', saved: null });
      return false;
    }
  }

  async function chooseLogo(file: File | undefined): Promise<void> {
    if (!file) return;
    const problem = logoFileProblem(file);
    if (problem) {
      setLogoStatus({ busy: false, error: problem, saved: null });
      return;
    }
    let value: string;
    try {
      value = await readAsDataUrl(file);
    } catch (cause) {
      setLogoStatus({ busy: false, error: cause instanceof Error ? cause.message : `could not read ${file.name}`, saved: null });
      return;
    }
    await save('consoleLogo', value, setLogoStatus, `Saved ${file.name}`);
  }

  const trimmed = name.trim();
  const nameDirty = trimmed !== (brand.name ?? '');

  return (
    <SettingsPart
      id="console-brand"
      title="Console name and logo"
      line="Shown at the top left of every page, for everyone. Posts on GitHub keep the install name."
    >
      <div className="flex max-w-md flex-col gap-4 pt-1">
        <div>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-dim">Console name</span>
            <input
              type="text"
              value={name}
              maxLength={CONSOLE_NAME_MAX}
              autoComplete="off"
              placeholder="OpenADLC"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && nameDirty && trimmed) void save('consoleName', trimmed, setNameStatus, 'Saved');
              }}
              className="mt-1.5 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-[13px] text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link"
            />
          </label>
          <p className="mt-1.5 text-[11.5px] text-muted">At most {CONSOLE_NAME_MAX} characters. Without one, the console says OpenADLC.</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!nameDirty || !trimmed || nameStatus.busy}
              onClick={() => void save('consoleName', trimmed, setNameStatus, 'Saved')}
            >
              {nameStatus.busy ? 'Saving…' : 'Save'}
            </Button>
            {brand.name && (
              <Button
                size="sm"
                disabled={nameStatus.busy}
                onClick={() => void save('consoleName', '', setNameStatus, 'Removed: the console says OpenADLC').then((ok) => ok && setName(''))}
              >
                Remove
              </Button>
            )}
            <StatusLine status={nameStatus} />
          </div>
        </div>

        <div>
          <span className="text-[11px] uppercase tracking-wider text-dim">Logo</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {brand.logoUrl ? (
              <span className="flex h-10 items-center rounded-md border border-edge bg-surface px-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- an <img> is what keeps an SVG from running anything */}
                <img data-logo-preview src={brand.logoUrl} alt="The console’s logo" className="h-7 w-auto max-w-[7rem] object-contain" />
              </span>
            ) : (
              <span className="text-[12px] text-muted">No logo.</span>
            )}
            <input
              ref={picker}
              type="file"
              accept={LOGO_TYPES.join(',')}
              aria-label="Choose a logo"
              className="hidden"
              onChange={(event) => {
                void chooseLogo(event.target.files?.[0]);
                // Cleared so choosing the same file twice fires again.
                event.target.value = '';
              }}
            />
            <Button size="sm" disabled={logoStatus.busy} onClick={() => picker.current?.click()}>
              {logoStatus.busy ? 'Saving…' : brand.logoUrl ? 'Choose another' : 'Choose an image'}
            </Button>
            {brand.logoUrl && (
              <Button size="sm" disabled={logoStatus.busy} onClick={() => void save('consoleLogo', '', setLogoStatus, 'Removed')}>
                Remove
              </Button>
            )}
            <StatusLine status={logoStatus} />
          </div>
          <p className="mt-1.5 text-[11.5px] text-muted">PNG, JPG, SVG or WebP, at most 256 KB. Drawn at the header’s height, never stretched.</p>
        </div>
      </div>
    </SettingsPart>
  );
}

function StatusLine({ status }: { status: Status }) {
  if (status.error) {
    return (
      <span role="alert" className="text-[11px] text-attention">
        Not saved: {status.error}
      </span>
    );
  }
  return status.saved ? <span className="text-[11px] text-signal">{status.saved}</span> : null;
}
