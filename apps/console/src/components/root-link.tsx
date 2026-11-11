'use client';

import type { RootButton } from '@/lib/card-status';

/**
 * The button to the root of a wait (`rootButton`): to the Needs you card
 * above the board, which it scrolls to, or to the pull request or issue on
 * GitHub. A board card and an item's sheet draw the same one, so the two go
 * to the same place.
 *
 * `before` runs before it scrolls: a sheet open over the board closes first,
 * or the Needs you card is scrolled to under it, out of sight.
 */
export function RootLink({ button, before }: { button: RootButton; before?: () => void }) {
  const style = 'relative z-10 shrink-0 text-[11.5px] font-medium text-link hover:underline';
  if (button.scrollTo) {
    const id = button.scrollTo;
    return (
      <button
        type="button"
        data-root={id}
        onClick={() => {
          before?.();
          document.querySelector(`[data-card="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }}
        className={style}
      >
        {button.label}
      </button>
    );
  }
  return (
    <a data-root href={button.url} target="_blank" rel="noreferrer" className={style}>
      {button.label}
    </a>
  );
}
