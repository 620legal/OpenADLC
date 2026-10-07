'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Onboarding is mostly transcription: a login here, an email there, a code from
 * one window into another. Every value OpenADLC asks someone to type is a value it
 * can hand over instead.
 */
export function Copyable({
  value,
  label,
  className,
  mono = true,
}: {
  value: string;
  label?: string;
  className?: string;
  mono?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copied = state === 'copied';

  // "copied" only after a write that worked. It was said whatever happened:
  // over plain HTTP on a LAN address there is no `navigator.clipboard`, a
  // permission can be refused, and the person pasted what was there before —
  // a stale password into GitHub's sign-up form.
  const copy = async (): Promise<void> => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = copyByHand(value);
    }
    setState(ok ? 'copied' : 'failed');
    if (ok) setTimeout(() => setState('idle'), 1400);
  };

  return (
    <div className={cn('min-w-0', className)}>
      {label && <p className="mb-1 text-[10.5px] uppercase tracking-wider text-dim">{label}</p>}
      {/* A button's default type is submit: inside a form — the accounts step
          copies its command from one — copying would send the form. */}
      <button
        type="button"
        onClick={() => void copy()}
        title="click to copy"
        className={cn(
          'group flex w-full items-center gap-2 rounded-md border border-edge-strong bg-surface px-2 py-1.5 text-left transition-colors hover:border-edge-strong',
          copied && 'border-signal/50',
        )}
      >
        <span className={cn('min-w-0 flex-1 truncate text-[12px] text-body', mono && 'font-mono text-[11.5px]')}>
          {value}
        </span>
        <span
          className={cn(
            'shrink-0 text-[10px] uppercase tracking-wider',
            copied ? 'text-signal' : 'text-dim group-hover:text-muted',
          )}
        >
          {copied ? 'copied' : state === 'failed' ? 'not copied' : 'copy'}
        </span>
      </button>
      {state === 'failed' && (
        // The button cuts a long value short, and text in a button is not
        // practically selectable: the whole of it, to select and copy.
        <p role="status" className="mt-1 text-[11px] text-attention">
          Could not copy it: select it and copy.{' '}
          <code className="select-all break-all font-mono text-[11.5px] text-body">{value}</code>
        </p>
      )}
    </div>
  );
}

/** The older way, for a page that is not a secure context: a selected textarea and the copy command. */
function copyByHand(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
