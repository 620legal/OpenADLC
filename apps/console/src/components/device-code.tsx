'use client';

import { useState } from 'react';
import { ExternalIcon } from '@/components/icons';
import { cn } from '@/lib/cn';

/** Where GitHub's device flow is approved, when GitHub's answer names nowhere else. */
export const DEVICE_URL = 'https://github.com/login/device';

/**
 * The device code, shown once and copyable, with the page it is entered on.
 *
 * Large because it is read off a screen and typed into a phone or another
 * window, and a button because the other way to get it out is to select eight
 * characters of letter-spaced monospace with a mouse.
 *
 * The page is a link beside it, and opening it copies the code too, so the
 * code is on the clipboard by the time GitHub asks for it. The walkthrough
 * used to name the page in a sentence, as text: the one thing on the screen a
 * person had to go to was the one thing they could not click.
 */
export function DeviceCode({ code, url }: { code: string; url?: string | null }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard permission can be refused; the text is selectable regardless.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void copy()}
        title="click to copy"
        className={cn(
          'rounded-md border px-3 py-1.5 font-mono text-2xl tracking-[0.25em] text-attention transition-colors',
          copied ? 'border-signal/60 bg-signal/10' : 'border-attention/40 bg-attention/5 hover:border-attention/70',
        )}
      >
        <span className="select-all">{code}</span>
        <span className="ml-3 align-middle font-sans text-[10.5px] tracking-normal text-dim">
          {copied ? 'copied' : 'copy'}
        </span>
      </button>
      <a
        href={url || DEVICE_URL}
        target="_blank"
        rel="noreferrer"
        onClick={() => void copy()}
        className="inline-flex h-11 items-center gap-1.5 rounded-md border border-edge-strong bg-panel px-2.5 text-[12.5px] text-body hover:border-dim md:h-8"
      >
        Copy and open {(url || DEVICE_URL).replace(/^https?:\/\//, '')}
        <ExternalIcon size={11} />
      </a>
    </div>
  );
}
