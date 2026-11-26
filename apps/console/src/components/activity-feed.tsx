'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RepoDot, useRepoColors } from '@/components/repo-badge';
import { eventHref, historyQuery, mergeEvents, readActivity, repoName, type BoardEvent } from '@/lib/activity';
import { labelIn, type BotFacts } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/when';

/**
 * One event as the activity button's panel and the Activity page list it:
 * who did it, where, what, and when, the whole row a link to its item.
 */
export function ActivityRow({ event, crew, now, compact = false }: { event: BoardEvent; crew: readonly BotFacts[]; now: number; compact?: boolean }) {
  const colors = useRepoColors();
  const repo = repoName(event.item.repo);
  return (
    <li data-activity-event={event.id}>
      <Link
        href={eventHref(event)}
        className={cn(
          'flex flex-col gap-0.5 rounded-md px-2.5 py-2 hover:bg-well focus-visible:outline-2 focus-visible:outline-link',
          compact ? 'text-[12.5px]' : 'text-[13px]',
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted">
          <span data-activity-bot className="truncate font-medium text-soft">
            {event.bot ? labelIn(crew, event.bot).name : 'OpenADLC'}
          </span>
          <span aria-hidden>·</span>
          <span data-activity-repo className="flex min-w-0 items-center gap-1">
            {repo ? <RepoDot color={colors[repo]} /> : null}
            <span className="truncate">{repo ?? 'request'}</span>
          </span>
          <time dateTime={event.at} title={event.at} className="ml-auto shrink-0">
            {ago(event.at, now)}
          </time>
        </span>
        <span data-activity-text className="text-body [overflow-wrap:anywhere]">
          {event.text}
        </span>
      </Link>
    </li>
  );
}

/** The repository and seat to narrow a list to; empty is every one. */
export function ActivityFilters({
  repos,
  crew,
  repo,
  bot,
  onRepo,
  onBot,
}: {
  repos: readonly string[];
  crew: readonly BotFacts[];
  repo: string;
  bot: string;
  onRepo: (repo: string) => void;
  onBot: (bot: string) => void;
}) {
  const seats = crew.map((member) => member.name ?? member.bot ?? '').filter(Boolean);
  const select =
    'h-11 min-w-0 flex-1 rounded-md border border-edge bg-surface px-2 text-[13px] text-body focus-visible:outline-2 focus-visible:outline-link md:h-8 md:text-[12.5px]';
  return (
    <div className="flex gap-2">
      <select aria-label="Repository" data-activity-filter="repo" value={repo} onChange={(change) => onRepo(change.target.value)} className={select}>
        <option value="">All repositories</option>
        {repos.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select aria-label="Bot" data-activity-filter="bot" value={bot} onChange={(change) => onBot(change.target.value)} className={select}>
        <option value="">Every bot</option>
        {seats.map((name) => (
          <option key={name} value={name}>
            {labelIn(crew, name).name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The filters in the address, so a narrowed view can be shared; nothing that is not set. */
function showFilters(repo: string, bot: string): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${historyQuery({ repo, bot })}`);
}

/**
 * The Activity page's list: the last thirty days of the crew's events, across
 * repositories, newest first, a page at a time. "Load more" reads the page
 * after the last one shown until the history says it reached its floor.
 *
 * A read for filters since changed is let go: a slow answer for the old ones
 * would otherwise land over the new.
 */
export function ActivityFeed({
  repos,
  crew,
  initialRepo = '',
  initialBot = '',
  fetcher,
}: {
  repos: readonly string[];
  crew: readonly BotFacts[];
  initialRepo?: string;
  initialBot?: string;
  /** For tests. */
  fetcher?: typeof fetch;
}) {
  const [repo, setRepo] = useState(initialRepo);
  const [bot, setBot] = useState(initialBot);
  const [events, setEvents] = useState<BoardEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  const read = useCallback(
    async (before: string | null) => {
      const ask = ++asked.current;
      setLoading(true);
      try {
        const page = await readActivity({ repo, bot, before }, fetcher ?? fetch);
        if (ask !== asked.current) return;
        setEvents((shown) => (before ? mergeEvents(shown, page.events) : page.events));
        setNext(page.next);
        setError(null);
      } catch (failure) {
        if (ask !== asked.current) return;
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (ask === asked.current) setLoading(false);
      }
    },
    [repo, bot, fetcher],
  );

  useEffect(() => {
    void read(null);
  }, [read]);

  const now = Date.now();
  const filtered = Boolean(repo || bot);

  return (
    <section data-activity-feed className="flex flex-col gap-3">
      <ActivityFilters
        repos={repos}
        crew={crew}
        repo={repo}
        bot={bot}
        onRepo={(value) => {
          setRepo(value);
          setEvents([]);
          showFilters(value, bot);
        }}
        onBot={(value) => {
          setBot(value);
          setEvents([]);
          showFilters(repo, value);
        }}
      />
      {error && (
        <p data-activity-error role="alert" className="text-[12.5px] text-alarm">
          Activity can’t be read: {error}
        </p>
      )}
      {events.length > 0 && (
        <ul data-activity-list aria-label="Activity" className="flex flex-col divide-y divide-edge rounded-lg border border-edge">
          {events.map((event) => (
            <ActivityRow key={event.id} event={event} crew={crew} now={now} />
          ))}
        </ul>
      )}
      {!loading && !error && events.length === 0 && (
        <p data-activity-empty className="text-[12.5px] text-muted">
          {filtered ? 'Nothing matches these filters in the last 30 days.' : 'Nothing has happened in the last 30 days.'}
        </p>
      )}
      {loading && events.length === 0 && !error && <p className="text-[12.5px] text-muted">Reading activity…</p>}
      {next && !error ? (
        <button
          type="button"
          data-activity-more
          disabled={loading}
          onClick={() => void read(next)}
          className="self-start rounded-md border border-edge px-3 py-1.5 text-[12.5px] text-soft hover:border-edge-strong hover:text-body focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
      {!next && !loading && !error && events.length > 0 && (
        <p data-activity-end className="text-[12.5px] text-muted">
          That’s everything from the last 30 days.
        </p>
      )}
    </section>
  );
}
