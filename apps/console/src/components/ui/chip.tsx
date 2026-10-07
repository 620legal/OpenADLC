import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Chip({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'signal' | 'attention' | 'alarm' | 'link';
  className?: string;
  /** What the chip stands for, when it is a count or a shorthand. */
  title?: string;
}) {
  const tones = {
    neutral: 'bg-well text-soft border-edge-strong',
    signal: 'bg-signal/12 text-signal border-signal/30',
    attention: 'bg-attention/12 text-attention border-attention/30',
    alarm: 'bg-alarm/12 text-alarm border-alarm/30',
    link: 'bg-link/12 text-link border-link/30',
  } as const;

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function WorkingDot({ working, className }: { working: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-1.5 rounded-full',
        working ? 'bg-signal working-dot' : 'bg-dim',
        className,
      )}
    />
  );
}
