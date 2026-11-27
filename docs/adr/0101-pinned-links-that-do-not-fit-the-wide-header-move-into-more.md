# 0101. Pinned links that do not fit the wide header move into More

- **Status:** accepted
- **Date:** 2026-11-27

## Context

ADR 0080 put each browser's pinned pages in the header's row and the rest
under More. It ruled out pages moving between the bar and More as the window
resizes, because a person could not learn where a page is, so the pinned row
scrolled rather than overflowed. #388 made that row `overflow-x-auto` so it
would give way at 768px.

Since then #398, #403, #408 and #409 have each taken width for the header's
right side (the activity bell, spend, the Hands-off badge). At 1488px with the
crew panel open, the row needed 288px and got 152px. Releases was out of
view, and the row grew from 32px to 42px because macOS drew its scrollbar
into the header (#418). Asked whether to keep 0080's rule and only hide the
scrollbar, or to replace it, a person chose to replace it.

## Decision

In the wide header (768px and up), the pinned links that do not fit beside
the right side move to the top of More, in pinned order, still pinned, marked
`data-moved`. They come back into the row as the room returns. The row never
scrolls and never cuts a link in half.

- The nav takes what the brand and the right side leave over (`flex-1
  min-w-0`), so its width never depends on which links it draws. Each link's
  width is read from an `aria-hidden` copy of the row made of spans
  (`[data-pinned-measure]`). `fitPinned` (`apps/console/src/lib/header.ts`)
  picks the longest run from the first pin that fits beside More.
- The current page's link stays in the row whenever it fits on its own,
  beside as many links from the first as still fit. When it does not fit,
  More is marked as where the person is.
- The fit is measured in the browser, again on a `ResizeObserver` on the nav
  (which sees the crew panel and the right side change) and on `resize`, and
  is never stored. The server, and a browser before it measures, draws every
  pin.
- The phone's bar (`BottomNav`) still scrolls its cells, and nothing moves
  into its More.

This amends ADR 0080's "the pinned row scrolls rather than overflow" for the
wide header. The rest of 0080 stands: `PAGES`, `navFor`, pins per browser,
the phone's bar and the palette.

## What this rules out

- **Hiding only the scrollbar** (`scroll-row`) and keeping 0080's scrolling
  row. The scrollbar would go, but Releases would still be out of view until
  the person scrolled, with nothing to say it was there.
- **A fixed cut of the first N pins.** The room depends on the crew panel, the
  spend, the Hands-off badge and the console's name, not on a count.
- **Drawing every link and hiding the ones that do not fit.** A `hidden` link
  has no width to measure again, and an `invisible` one still takes its width,
  so the row would still overflow.
- **Measuring the row itself.** Its width would depend on the links it draws,
  a loop that can flicker at the edge.
- **Moving or hiding parts of the right side** to make room. The issue keeps
  them where they are. Shortening them is a separate change.

## What would make this worth revisiting

If people lose track of pages that move in and out of the row, which was
0080's concern. The answer then is to make the right side shorter, not to
make the row scroll again.
