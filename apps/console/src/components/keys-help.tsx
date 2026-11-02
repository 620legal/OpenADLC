'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { isHelpKey, isMac } from '@/lib/keys';

/**
 * `?` on any page with the header: the console's keys, in a list. Not while
 * typing in a field, where `?` is a question mark; so not in the command
 * palette either, whose search box has the focus.
 */
export function KeysHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isHelpKey(event)) return;
      event.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!open) return null;
  const palette = isMac(navigator as Navigator & { userAgentData?: { platform?: string } }) ? ['⌘', 'K'] : ['Ctrl', 'K'];
  return (
    <Dialog open onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="w-[min(26rem,calc(100vw-2rem))]">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[12.5px]">
          <Keys keys={palette} what="Open or close the command palette, from any page" />
          <Keys keys={['?']} what="This list" />
          <Keys keys={['Esc']} what="Close the palette or a dialog" />
        </dl>
        <p className="mt-4 text-[12px] font-medium text-soft">Needs you</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-[12.5px]">
          <Keys keys={['j']} what="Select the next item" />
          <Keys keys={['k']} what="Select the previous item" />
          <Keys keys={['1–9']} what="Answer the selected question with that choice" />
          <Keys keys={['Enter']} what="Open the selected item" />
        </dl>
      </DialogContent>
    </Dialog>
  );
}

function Keys({ keys, what }: { keys: string[]; what: string }) {
  return (
    <>
      <dt className="flex gap-1">
        {keys.map((key) => (
          <kbd key={key} className="rounded border border-edge-strong bg-surface px-1.5 py-0.5 font-mono text-[11.5px] text-body">
            {key}
          </kbd>
        ))}
      </dt>
      <dd className="text-muted">{what}</dd>
    </>
  );
}
