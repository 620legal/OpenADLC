'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { hashSection, sectionBeingRead, settingsNav, type SettingsOn } from '@/lib/settings';

/** How far below the top of the window a section counts as the one being read. */
const READING_LINE = 120;

const ITEM =
  'flex h-9 shrink-0 items-center rounded-full border px-3 text-[13px] transition-colors md:h-[34px] md:rounded-md md:border-0 md:px-2.5';
const ACTIVE = 'border-body bg-body font-medium text-surface md:bg-well md:text-body';
const IDLE = 'border-edge bg-panel text-muted hover:text-body md:bg-transparent';

/**
 * Settings' own navigation, the same on `/settings` and on Hosts' and
 * Notifications' own pages. On `/settings` a link goes to each section and
 * marks the one being read: each section has an id, so `/settings#system`
 * lands on it and marks it, and `/settings#engine-updates` is the same
 * section, where a failed update's card still links. On a page of its own
 * that page is marked, and nothing is tracked. A non-admin sees Notifications
 * alone (ADR 0053). On a phone it is a row of pills above the content.
 */
export function SettingsNav({ omit = [], admin = true, on = 'sections' }: { omit?: readonly string[]; admin?: boolean; on?: SettingsOn } = {}) {
  // A section this install does not have, such as Egress on a laptop.
  const entries = settingsNav({ admin, omit, on });
  const sections = on === 'sections' ? entries.filter((entry) => entry.section) : [];
  const shown = sections.map((section) => section.id).join(' ');
  const [current, setCurrent] = useState<string | null>(sections[0]?.id ?? null);

  useEffect(() => {
    if (!shown) return;
    const ids: string[] = shown.split(' ');
    const read = () => {
      const reading = sectionBeingRead({
        tops: ids.map((id) => ({ id, top: document.getElementById(id)?.getBoundingClientRect().top ?? Infinity })),
        atBottom: window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2,
        named: hashSection(window.location.hash.slice(1)),
        viewportHeight: window.innerHeight,
        line: READING_LINE,
      });
      if (reading) setCurrent(reading);
    };
    const fromHash = () => {
      const id = hashSection(window.location.hash.slice(1)) ?? '';
      if (ids.includes(id)) setCurrent(id);
      else read();
    };
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', fromHash);
      window.removeEventListener('scroll', onScroll);
    };
  }, [shown]);

  return (
    <nav
      aria-label="Settings"
      className="scroll-row -mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4 md:sticky md:top-7 md:mx-0 md:w-[200px] md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:px-0"
    >
      {entries.map((entry) => {
        if (entry.current) {
          return (
            <Link key={entry.id} href={entry.href} aria-current="page" className={cn(ITEM, ACTIVE)}>
              {entry.label}
            </Link>
          );
        }
        if (!entry.section || on !== 'sections') {
          return (
            <Link key={entry.id} href={entry.href} className={cn(ITEM, IDLE)}>
              {entry.label}
            </Link>
          );
        }
        const active = entry.id === current;
        return (
          <a
            key={entry.id}
            href={entry.href}
            aria-current={active ? 'location' : undefined}
            onClick={() => setCurrent(entry.id)}
            className={cn(ITEM, active ? ACTIVE : IDLE)}
          >
            {entry.label}
          </a>
        );
      })}
      {admin && (
        <Link
          href="/onboarding"
          className="flex h-9 shrink-0 items-center rounded-full border border-edge bg-panel px-3 text-[13px] text-muted transition-colors hover:text-body md:mt-3.5 md:h-[34px] md:rounded-md md:border-0 md:bg-transparent md:px-2.5"
        >
          Run the setup again
        </Link>
      )}
    </nav>
  );
}
