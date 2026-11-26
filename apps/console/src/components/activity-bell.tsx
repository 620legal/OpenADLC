'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ActivityFilters, ActivityRow } from '@/components/activity-feed';
import { ActivityIcon } from '@/components/icons';
import {
  badgeText,
  historyQuery,
  matchesFilters,
  mergeEvents,
  newestAt,
  onSeenChange,
  readActivity,
  readSeen,
  unreadCount,
  writeSeen,
  type BoardEvent,
} from '@/lib/activity';
import type { BotFacts } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { useEventStream } from '@/lib/use-event-stream';

/** The newest page the button reads: what it counts and what its panel lists. */
export const BELL_PAGE = 100;
/** How many its panel shows; the Activity page has the rest. */
const PANEL_ROWS = 30;

/**
 * The crew's recent events and how many this browser has not seen. They are
 * listed from the history; the live stream only says that something happened,
 * and the event it carries is merged in by id. The history is read when the
 * stream opens (the first time, and on a reconnect, which is how it catches
 * up), when the stream cannot open, and on the hook's five-second timer where
 * there is no EventSource — never on a timer per tab otherwise
 * (docs/adr/0081).
 *
 * The time seen is read after mounting, as every per-browser choice is: the
 * server has no storage. A browser with none stores the newest event's time
 * on its first read, or now, so it starts at zero and not at the backlog.
 */
export function useActivity(fetcher?: typeof fetch) {
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [seen, setSeen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<string | null>(null);
  const mounted = useRef(true);

  const keepSeen = useCallback((at: string) => {
    seenRef.current = at;
    setSeen(at);
  }, []);

  const load = useCallback(async () => {
    try {
      const page = await readActivity({ limit: BELL_PAGE }, fetcher ?? fetch);
      if (!mounted.current) return;
      setEvents((shown) => mergeEvents(page.events, shown));
      setError(null);
      if (!seenRef.current) {
        const start = newestAt(page.events) ?? new Date().toISOString();
        writeSeen(start);
        keepSeen(start);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [fetcher, keepSeen]);

  // The page's own stream and reads go first: the header is on every page,
  // and a browser holds six connections to a host over HTTP/1.1, each
  // EventSource one of them for as long as it is open.
  const [streaming, setStreaming] = useState(false);
  const loaded = useRef(false);
  const loadOnce = useCallback(async () => {
    loaded.current = true;
    await load();
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    const stored = readSeen();
    if (stored) keepSeen(stored);
    const turn = setTimeout(() => setStreaming(true), 0);
    const off = onSeenChange(() => {
      const now = readSeen();
      if (now) keepSeen(now);
    });
    return () => {
      mounted.current = false;
      clearTimeout(turn);
      off();
    };
  }, [loadOnce, keepSeen]);

  useEventStream(
    streaming ? '/api/board/events/stream' : null,
    {
      // The newest page on every open: the first, and each reconnect, which catches up on what the stream missed.
      onOpen: () => void loadOnce(),
      onChanged: (data) => {
        const pushed = parseEvent(data);
        if (pushed) setEvents((shown) => mergeEvents(shown, [pushed]));
        else void loadOnce();
      },
      // A stream that never opens still says why in the panel: the history's read says what the bridge says.
      onDown: () => {
        if (!loaded.current) void loadOnce();
      },
    },
    'board',
  );

  /** Everything listed is seen: the newest time shown is stored, and the count goes to zero. */
  const markSeen = useCallback(
    (shown: readonly BoardEvent[]) => {
      const newest = newestAt(shown);
      if (!newest || (seenRef.current && Date.parse(newest) <= Date.parse(seenRef.current))) return;
      writeSeen(newest);
      keepSeen(newest);
    },
    [keepSeen],
  );

  return { events, seen, error, unread: unreadCount(events, seen), markSeen };
}

/** A pushed event, or null for a message that is not one. */
export function parseEvent(data: string | undefined): BoardEvent | null {
  if (!data) return null;
  try {
    const event = JSON.parse(data) as Partial<BoardEvent>;
    return typeof event.id === 'string' && typeof event.at === 'string' && typeof event.text === 'string' && event.item && typeof event.item.ref === 'string'
      ? (event as BoardEvent)
      : null;
  } catch {
    return null;
  }
}

/**
 * The header's activity button, beside the alerts menu: a count of the
 * events this browser has not seen, and a panel of the newest, which opening
 * marks seen. Its filters are the panel's alone and reset with the page; the
 * count is always of everything. A history that cannot be read is said inside
 * the panel, and the button stays, without a count.
 */
export function ActivityBell({
  repos,
  crew,
  compact = false,
  fetcher,
}: {
  repos: readonly string[];
  crew: readonly BotFacts[];
  compact?: boolean;
  /** For tests. */
  fetcher?: typeof fetch;
}) {
  const { events, error, unread, markSeen } = useActivity(fetcher);
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState('');
  const [bot, setBot] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();

  // While the panel is open, what arrives is seen as it is listed.
  useEffect(() => {
    if (open) markSeen(events);
  }, [open, events, markSeen]);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const badge = error ? '' : badgeText(unread);
  const shown = events.filter((event) => matchesFilters(event, { repo, bot })).slice(0, PANEL_ROWS);
  const now = Date.now();

  return (
    <div ref={root} className="relative" data-activity-bell>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        aria-label={badge ? `Activity, ${badge} new` : 'Activity'}
        onClick={() => setOpen((was) => !was)}
        className={cn(
          'relative flex items-center justify-center rounded-md text-muted hover:text-body focus-visible:outline-2 focus-visible:outline-link',
          compact ? 'size-11' : 'size-8',
        )}
      >
        <ActivityIcon size={16} />
        {badge && (
          <span
            data-activity-badge
            aria-hidden
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-attention px-1 text-center text-[10px] font-semibold leading-4 text-surface"
          >
            {badge}
          </span>
        )}
      </button>
      <div
        id={panel}
        hidden={!open}
        data-activity-panel
        className="absolute right-0 top-full z-40 mt-1 flex w-[24rem] max-w-[calc(100vw-1rem)] flex-col gap-1 whitespace-normal rounded-lg border border-edge-strong bg-panel p-1 shadow-xl"
      >
        <div className="px-1.5 pb-1 pt-1.5">
          <ActivityFilters repos={repos} crew={crew} repo={repo} bot={bot} onRepo={setRepo} onBot={setBot} />
        </div>
        {error ? (
          <p data-activity-error role="alert" className="px-2.5 py-2 text-[12.5px] text-alarm">
            Activity can’t be read: {error}
          </p>
        ) : shown.length === 0 ? (
          <p data-activity-empty className="px-2.5 py-2 text-[12.5px] text-muted">
            {repo || bot ? 'Nothing recent matches these filters.' : 'Nothing has happened recently.'}
          </p>
        ) : (
          <ul aria-label="Recent activity" className="max-h-[60vh] overflow-y-auto">
            {shown.map((event) => (
              <ActivityRow key={event.id} event={event} crew={crew} now={now} compact />
            ))}
          </ul>
        )}
        <Link
          href={`/activity${historyQuery({ repo, bot })}`}
          onClick={() => setOpen(false)}
          className="rounded-md px-2.5 py-2 text-[12.5px] font-medium text-link hover:bg-well focus-visible:outline-2 focus-visible:outline-link"
        >
          All activity
        </Link>
      </div>
    </div>
  );
}
