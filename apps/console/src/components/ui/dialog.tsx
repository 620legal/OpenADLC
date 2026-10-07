'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  children,
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-surface/70 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[min(37rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2',
          'rounded-xl border border-edge-strong bg-panel p-5 shadow-2xl',
          'max-h-[calc(100vh-3rem)] overflow-y-auto',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * A panel from the right edge, the height of the window: what a card's Show
 * more opens beside the board. Full-screen on a phone, where a side panel
 * would be a strip too narrow to read.
 */
export function SheetContent({
  children,
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { children: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-surface/70 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-0 z-50 flex flex-col gap-3 overflow-y-auto bg-panel p-5 shadow-2xl',
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[min(30rem,100vw)] sm:border-l sm:border-edge-strong',
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Title className={cn('text-[15px] font-semibold text-body', className)}>
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Description className={cn('mt-1 text-[13px] leading-relaxed text-muted', className)}>
      {children}
    </DialogPrimitive.Description>
  );
}
