import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  // `hover:bg-white` was here, which is the page background in light mode: the
  // button vanished and took its label with it. `soft` moves away from `body` in
  // both directions — darker on a dark page, lighter on a light one — and
  // `text-surface` stays at the far end of the ramp either way.
  primary: 'bg-body text-surface hover:bg-soft',
  secondary: 'bg-edge-strong text-body hover:bg-dim border border-edge-strong',
  ghost: 'text-soft hover:text-body hover:bg-well',
  danger: 'bg-alarm/15 text-alarm border border-alarm/40 hover:bg-alarm/25',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
});
