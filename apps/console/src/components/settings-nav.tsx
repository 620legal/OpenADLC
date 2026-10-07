'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { hashSection, sectionBeingRead, SETTINGS_SECTIONS } from '@/lib/settings';

/** How far below the top of the window a section counts as the one being read. */
const READING_LINE = 120;

/**
 * Settings' own navigation: a link to each section, marking the one being
 * read. Each section has an id, so `/settings#system` lands on it and marks
 * it. `/settings#engine-updates` is the same section: a failed update's card
 * still links there. On a phone it is a row of pills above the sections.
 */
export function SettingsNav() {
  const [current, setCurrent] = useState<string>(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    const ids: string[] = SETTINGS_SECTIONS.map((section) => section.id);
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
  }, []);

  return (
    <nav
      aria-label="Settings"
      className="scroll-row -mx-4 flex shrink-0 gap-1.5 overflow-x-auto px-4 md:sticky md:top-7 md:mx-0 md:w-[200px] md:flex-col md:gap-0.5 md:self-start md:overflow-visible md:px-0"
    >
      {SETTINGS_SECTIONS.map((section) => {
        const active = section.id === current;
        return (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={active ? 'location' : undefined}
            onClick={() => setCurrent(section.id)}
            className={cn(
              'flex h-9 shrink-0 items-center rounded-full border px-3 text-[13px] transition-colors md:h-[34px] md:rounded-md md:border-0 md:px-2.5',
              active ? 'border-body bg-body font-medium text-surface md:bg-well md:text-body' : 'border-edge bg-panel text-muted hover:text-body md:bg-transparent',
            )}
          >
            {section.label}
          </a>
        );
      })}
      <Link
        href="/onboarding"
        className="flex h-9 shrink-0 items-center rounded-full border border-edge bg-panel px-3 text-[13px] text-muted transition-colors hover:text-body md:mt-3.5 md:h-[34px] md:rounded-md md:border-0 md:bg-transparent md:px-2.5"
      >
        Run the setup again
      </Link>
    </nav>
  );
}
