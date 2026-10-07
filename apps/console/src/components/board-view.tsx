'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { moveCard } from '@/app/actions';
import { AppShell, useRole } from '@/components/app-header';
import { BotAvatar, type AvatarStatus } from '@/components/avatar';
import { FirstRun } from '@/components/first-run';
import { NextIcon, CheckIcon, ChevronDownIcon } from '@/components/icons';
import { NeedsYou, type OpenBot } from '@/components/needs-you';
import { namesLine, PAUSE_WORK, pauseLine } from '@/components/pause-work';
import { PausedMark, PausedReposProvider, RepoBadge, RepoDot, useRepoColors, usePausedRepos } from '@/components/repo-badge';
import { ItemView } from '@/components/item-view';
import { ThreadPanel } from '@/components/thread-panel';
import type { AttentionItem, Board, BoardCard, BoardColumn, CrewMember, WorkPause } from '@/lib/api';
import { findBot, labelIn } from '@/lib/bot-label';
import { attemptMove, columnsWithMoves, movesBack, NO_MOVES, reconcile, type MoveState } from '@/lib/board-move';
import { cardBot, cardCost, cardStatus, nextUp, type CardContext, type CardStatus } from '@/lib/card-status';
import { cn } from '@/lib/cn';
import { heldLine, IssueControls } from '@/components/issue-controls';
import { boardHref, type HeaderData } from '@/lib/header';
import { repoEdge, type RepoLook } from '@/lib/repo-colors';
import { stageOf } from '@/lib/stages';
import { money, within } from '@/lib/when';

/** What an empty column says, in its own words. */
const EMPTY: Record<string, string> = {
  intake: 'Nothing waiting for intake',
  spec: 'Nothing needs a design pass',
  build: 'Nothing to build',
  review: 'Nothing in review',
  merged: 'Nothing waiting to ship',
  done: 'Nothing shipped this week',
};

/** Done keeps a week on the board; what shipped before that is on GitHub. */
const DONE_DAYS = 7;

const TONE: Record<CardStatus['tone'], string> = {
  signal: 'text-signal',
  attention: 'text-attention',
  alarm: 'text-alarm',
  muted: 'text-muted',
};

const DOT: Record<CardStatus['tone'], string> = {
  signal: 'bg-signal',
  attention: 'bg-attention',
  alarm: 'bg-alarm',
  muted: 'bg-dim',
};

/**
 * What a column says it does. Ship, in a repository with nothing to deploy,
 * says so: its own words, "Deploys by the repository’s own rules", sit over a
 * stage that never happens there.
 */
function subtitleOf(column: Pick<BoardColumn, 'stage' | 'shipsByMerging'>, subtitle: string): string {
  return column.stage === 'merged' && column.shipsByMerging ? 'No testing deploy: merging ships it' : subtitle;
}

export function BoardView({
  board,
  crew,
  repo,
  header,
  attention = [],
  now,
  repoFullName = null,
  openBotOnLoad = null,
  openItemOnLoad = null,
  openRoleOnLoad = null,
  paused = null,
  pausedRepos = {},
  dispatching = true,
}: {
  board: Board;
  crew: CrewMember[];
  repo: string;
  header: HeaderData;
  /** Everything waiting on the person, newest first. */
  attention?: readonly AttentionItem[];
  /** When the page was read, which every "12 min" and "2 hours ago" is counted from. */
  now: string;
  /** The repository the first-run page files into, as `owner/name`. */
  repoFullName?: string | null;
  /** From `?bot=`, so a notification's link opens the thread it names. */
  openBotOnLoad?: string | null;
  /** From `?item=`: a notification about a piece of work opens that work's own conversation. */
  openItemOnLoad?: string | null;
  /** From `?role=`, with `?item=`: the role's tab to open on. */
  openRoleOnLoad?: string | null;
  /** A person's pause of new work, said above everything while it lasts. */
  paused?: WorkPause | null;
  /** Each repository a person paused on its own, by name. */
  pausedRepos?: Record<string, WorkPause>;
  /** False when the bridge runs no dispatcher, so a ready Build card says nothing will lease it. */
  dispatching?: boolean;
}) {
  const admin = useRole() === 'admin';
  // Seeded from `?bot=` so a notification's link opens the thread it names —
  // under the name the bot has now. A link written before it connected carries
  // the seat it has since left for its account's handle. A name that is no
  // bot opens nothing: it was once used as it stood, and a crafted one turned
  // the panel's "stop all its work" into a call to another bridge route.
  const [openBot, setOpenBot] = useState<string | null>(() =>
    openBotOnLoad ? (findBot(crew, openBotOnLoad)?.name ?? null) : null,
  );
  // A card opens its work item — the request, its issue and its pull request
  // as one conversation — not the panel of the bot that last touched it, which
  // held every other subject that bot had worked on. Seeded from `?item=`.
  const [openItem, setOpenItem] = useState<{ subject: string; role: string | null } | null>(() =>
    openItemOnLoad ? { subject: openItemOnLoad, role: openRoleOnLoad } : null,
  );
  /** Whether the thread was opened to answer in the person's own words, so its box takes the cursor. */
  const [compose, setCompose] = useState(false);
  const openThread: OpenBot = (bot, how) => {
    setOpenBot(bot);
    setCompose(Boolean(how?.compose));
  };
  /** A bot the board only has the name of, as a person reads it. */
  const labelOf = (name: string) => labelIn(crew, name);
  const unconnected = crew.filter((bot) => bot.authorization !== 'active');

  const [moves, setMoves] = useState<MoveState>(NO_MOVES);
  const [dragging, setDragging] = useState<{ ref: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Every re-read of the board is the bridge's answer about the cards a move is
  // still being shown for, so it is what retires them.
  useEffect(() => {
    setMoves((state) => reconcile(state, board.columns));
  }, [board]);

  const columns = columnsWithMoves(board.columns, moves);
  const empty = board.columns.every((column) => column.cards.length === 0);
  // Every repository at once is the one view where a card has to say which it
  // is in. Showing one, it would say the same thing on every card.
  const showRepo = repo === 'all' && board.repos.length > 1;
  const repositories: RepoLook[] =
    board.repositories ?? board.repos.map((name) => ({ name, color: header.repoColors[name] ?? null }));

  function move(card: { ref: string; from: string }, to: string): void {
    const [repoName, number] = card.ref.split('#');
    if (!repoName || !number) return;
    // Back takes a reason: the stage the card goes to starts again from it,
    // and the bridge refuses a move back without one. Cancelled, nothing moves.
    let reason: string | undefined;
    if (movesBack(card.from, to, board.columns)) {
      const asked = window.prompt(
        `Why does ${card.ref} go back to ${stageOf(to)?.title ?? to}? The stage it goes to starts again from what you write.`,
      );
      if (!asked?.trim()) return;
      reason = asked.trim();
    }
    void attemptMove(
      { ...card, to },
      (target) => moveCard(repoName, Number(number), target, reason),
      setMoves,
    );
  }

  // The builder a Build card waits for, and whether it is busy, for "Next up,
  // when … is free".
  const build = columns.find((column) => column.stage === 'build');
  const builder = build?.bots[0] ?? null;
  const next = build ? nextUp(build) : null;
  const context = (card: BoardCard): CardContext => ({
    now,
    said: (name) => labelOf(name).said,
    mergeLine: board.mergeLine,
    pausedRepos: pausedNames,
    dispatching,
    queue:
      card.stage === 'build'
        ? { next: card.ref === next?.get(card.repo), builder: builder?.name ?? null, builderBusy: Boolean(builder?.working) }
        : undefined,
  });

  // The repositories paused on their own that this board shows: all of them
  // on the board of every repository, and the one it is filtered to otherwise.
  const pausedNames = Object.keys(pausedRepos).sort();
  const pausedHere = repo === 'all' ? pausedNames : pausedNames.filter((name) => name === repo);

  const cards: CardHandlers = {
    crew,
    moves,
    dragging,
    showRepo,
    labelOf,
    columns: board.columns,
    context,
    onOpen: (card: BoardCard) => setOpenItem({ subject: card.ref, role: null }),
    onMove: move,
    onDragStart: (ref: string, from: string) => setDragging({ ref, from }),
    onDragEnd: () => {
      setDragging(null);
      setOver(null);
    },
  };

  const shell = (
    <AppShell page="board" repo={repo} data={header} fill>
      <h1 className="sr-only">Board</h1>

      {paused && (
        <div role="status" className="shrink-0 border-b border-alarm/30 bg-alarm/5 px-4 py-2 md:px-6">
          <p className="text-[12.5px] text-soft">
            <span className="font-medium text-alarm">Work is paused.</span> {pauseLine(paused)} Nothing new starts until it is resumed.{' '}
            {admin ? (
              <Link href={PAUSE_WORK} className="text-link underline decoration-link/40 underline-offset-2">
                Resume in Settings
              </Link>
            ) : (
              // Settings is an admin's: a user is told who resumes it, not sent to a page that refuses them.
              'An admin resumes it in Settings.'
            )}
          </p>
        </div>
      )}

      {!paused && pausedHere.length > 0 && (
        <div role="status" className="shrink-0 border-b border-attention/30 bg-attention/5 px-4 py-2 md:px-6">
          <p className="text-[12.5px] text-soft">
            <span className="font-medium text-attention">Work is paused in {namesLine(pausedHere)}.</span>{' '}
            {pausedHere.length === 1 ? `${pauseLine(pausedRepos[pausedHere[0]!]!)} ` : ''}
            Nothing new starts there until it is resumed; the rest of the work goes on.{' '}
            {admin ? (
              <Link href={PAUSE_WORK} className="text-link underline decoration-link/40 underline-offset-2">
                Resume in Settings
              </Link>
            ) : (
              // Settings is an admin's: a user is told who resumes it, not sent to a page that refuses them.
              'An admin resumes it in Settings.'
            )}
          </p>
        </div>
      )}

      {unconnected.length > 0 && (
        <div className="shrink-0 border-b border-attention/25 bg-attention/5 px-4 py-2 md:px-6">
          <p className="text-[12.5px] text-soft">
            <span className="text-attention">
              {unconnected.length} of {crew.length} bots {unconnected.length === 1 ? 'has' : 'have'} no GitHub account connected
            </span>{' '}
            — they can run, but nothing they do will reach GitHub.{' '}
            {admin ? (
              <Link href="/onboarding" className="text-link underline decoration-link/40 underline-offset-2">
                Set up the crew
              </Link>
            ) : (
              'An admin sets up the crew.'
            )}
          </p>
        </div>
      )}

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <NeedsYou
          items={attention}
          now={now}
          onOpenBot={openThread}
          onOpenItem={(item, role) => setOpenItem({ subject: item, role })}
          showRepo={showRepo}
          repo={repo}
        />

        {empty ? (
          <FirstRun
            columns={board.columns}
            crew={crew}
            counts={header.counts}
            repos={board.repos}
            repo={repo}
            repoFullName={repoFullName}
            repositories={showRepo ? repositories : []}
            labelOf={labelOf}
          />
        ) : (
          <>
            {showRepo && <Legend repositories={repositories} />}
            <section
              aria-label="Board"
              className={cn(
                'hidden min-h-[22rem] flex-1 gap-3 overflow-x-auto px-6 pb-6 md:grid md:grid-cols-[repeat(6,minmax(12.5rem,1fr))]',
                showRepo ? 'pt-3' : 'pt-4',
              )}
            >
              {columns.map((column) => (
                <Column
                  key={column.stage}
                  column={column}
                  crew={crew}
                  now={now}
                  over={over === column.stage}
                  onOpenBot={openThread}
                  // A column is a drop target for a card dragged out of another
                  // one. `preventDefault` on drag-over is what makes it one at all.
                  onDragOver={(event) => {
                    if (!dragging || dragging.from === column.stage) return;
                    event.preventDefault();
                    setOver(column.stage);
                  }}
                  onDragLeave={() => setOver((current) => (current === column.stage ? null : current))}
                  onDrop={(event) => {
                    event.preventDefault();
                    setOver(null);
                    if (dragging) move(dragging, column.stage);
                    setDragging(null);
                  }}
                  cards={cards}
                />
              ))}
            </section>

            <PhoneStages columns={columns} now={now} cards={cards} />
          </>
        )}
      </main>

      {openItem && (
        <ItemView
          key={openItem.subject}
          subject={openItem.subject}
          initialRole={openItem.role}
          variant="sheet"
          onClose={() => setOpenItem(null)}
          now={now}
        />
      )}

      {openBot && (
        <ThreadPanel
          bot={openBot}
          member={findBot(crew, openBot)}
          onClose={() => setOpenBot(null)}
          now={now}
          focusComposer={compose}
        />
      )}
    </AppShell>
  );
  // Every badge and the legend under it say which repositories are paused.
  return <PausedReposProvider names={pausedNames}>{shell}</PausedReposProvider>;
}

/**
 * Which colour is which repository, above a board that shows them all, each
 * a link to the board with only that one. A phone has no room for it and does
 * not need it: every card there carries its repository's name.
 */
function Legend({ repositories }: { repositories: readonly RepoLook[] }) {
  const paused = usePausedRepos();
  return (
    <div className="hidden shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-6 pt-4 md:flex">
      <span className="text-[12px] text-dim">Every repository:</span>
      <ul aria-label="Repositories on the board" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {repositories.map((repository) => (
          <li key={repository.name}>
            <Link
              href={boardHref(repository.name)}
              title={`Show only ${repository.fullName ?? repository.name}`}
              className="inline-flex items-center gap-1.5 rounded text-[12.5px] text-soft transition-colors hover:text-body focus-visible:outline-2 focus-visible:outline-link"
            >
              <RepoDot color={repository.color} />
              {repository.name}
              {paused.has(repository.name) && <PausedMark />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Who is on a card, in words. Seats that share one GitHub account are one
 * handle: "fleet-cipher-janedoe, fleet-cipher-janedoe" said neither who was
 * working nor that there were two. So where handles repeat, the roles are
 * named, then each handle once — as the item view heads its entries by role.
 */
export function peopleLine(labels: readonly { name: string; role?: string | null }[]): string {
  const handles = [...new Set(labels.map((label) => label.name))];
  if (handles.length === labels.length) return handles.join(', ');
  return `${labels.map((label) => label.role || label.name).join(', ')} · ${handles.join(', ')}`;
}

interface CardHandlers {
  crew: CrewMember[];
  moves: MoveState;
  dragging: { ref: string; from: string } | null;
  showRepo: boolean;
  labelOf: (name: string) => { name: string; text: string; role?: string | null };
  columns: BoardColumn[];
  context: (card: BoardCard) => CardContext;
  onOpen: (card: BoardCard) => void;
  onMove: (card: { ref: string; from: string }, to: string) => void;
  onDragStart: (ref: string, from: string) => void;
  onDragEnd: () => void;
}

/**
 * What a column shows: every card, but only the last week of Done, newest
 * first. The bridge lists every column in the order the dispatcher takes work
 * in, which is what Build is read by and says nothing about what shipped when:
 * Done showed something shipped just now between two that shipped hours before.
 */
function visibleCards(column: BoardColumn, now: string): { cards: BoardCard[]; older: number } {
  if (column.stage !== 'done') return { cards: column.cards, older: 0 };
  const shipped = (card: BoardCard) => card.shippedAt ?? card.updatedAt;
  const recent = column.cards
    .filter((card) => within(shipped(card), DONE_DAYS, now))
    .sort((a, b) => Date.parse(shipped(b)) - Date.parse(shipped(a)));
  return { cards: recent, older: column.cards.length - recent.length };
}

function Column({
  column,
  crew,
  now,
  over,
  onOpenBot,
  onDragOver,
  onDragLeave,
  onDrop,
  cards,
}: {
  column: BoardColumn;
  crew: CrewMember[];
  now: string;
  over: boolean;
  onOpenBot: (bot: string) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent) => void;
  cards: CardHandlers;
}) {
  const stage = stageOf(column.stage);
  const { cards: shown, older } = visibleCards(column, now);

  return (
    <section
      aria-labelledby={`column-${column.stage}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="flex min-h-0 min-w-0 flex-col gap-2"
    >
      <div className="flex flex-col gap-1 px-0.5 pb-1.5 pt-0.5">
        <div className="flex items-center gap-2">
          <h2 id={`column-${column.stage}`} className="text-[13px] font-semibold text-body">
            {stage?.title ?? column.title}
          </h2>
          <span className="text-[12px] text-dim">
            {column.stage === 'done' ? `${shown.length} this week` : column.cards.length}
          </span>
          <Staff bots={column.bots} crew={crew} onOpenBot={onOpenBot} />
        </div>
        {stage && <p className="text-[11.5px] leading-snug text-muted">{subtitleOf(column, stage.subtitle)}</p>}
      </div>

      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-lg pb-2 transition-colors',
          over && 'outline-2 outline-dashed outline-link/60',
        )}
      >
        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-edge-strong px-3 py-[18px] text-center text-[12px] leading-normal text-dim">
            {EMPTY[column.stage] ?? 'Nothing here'}
          </p>
        ) : (
          shown.map((card) => <Card key={card.ref} card={card} stage={column.stage} handlers={cards} />)
        )}
        {older > 0 && <p className="px-1 text-[11.5px] text-dim">and {older} shipped before this week</p>}
      </div>
    </section>
  );
}

/** Who staffs a column, as faces with a dot for working or waiting on you. */
function Staff({
  bots,
  crew,
  onOpenBot,
}: {
  bots: BoardColumn['bots'];
  crew: CrewMember[];
  onOpenBot: (bot: string) => void;
}) {
  if (bots.length === 0) return null;
  return (
    <span className="ml-auto flex">
      {bots.map((bot, index) => {
        const member = findBot(crew, bot.name) ?? { name: bot.name };
        const label = labelIn(crew, bot.name);
        const status: AvatarStatus = bot.waiting ? 'waiting' : bot.working ? 'working' : 'idle';
        const said = status === 'waiting' ? 'waiting for you' : status;
        return (
          <button
            key={bot.name}
            type="button"
            onClick={() => onOpenBot(bot.name)}
            title={`${label.text} · ${said}`}
            aria-label={`${label.name}, ${said}. Open its thread`}
            className={cn('rounded-full focus-visible:outline-2 focus-visible:outline-link', index > 0 && '-ml-1.5')}
          >
            <BotAvatar bot={member} status={status} ring />
          </button>
        );
      })}
    </span>
  );
}

function StatusLine({ status }: { status: CardStatus }) {
  return (
    <span
      data-status
      className={cn('flex items-center gap-1.5 text-[11.5px] leading-snug', status.mark === 'check' ? 'text-muted' : TONE[status.tone])}
    >
      {status.mark === 'dot' && <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', DOT[status.tone])} />}
      {status.mark === 'check' && <CheckIcon size={12} className="shrink-0 text-signal" />}
      {status.href ? (
        <a href={status.href} target="_blank" rel="noreferrer" className="relative z-10 hover:text-link hover:underline">
          {status.text}
        </a>
      ) : (
        status.text
      )}
    </span>
  );
}

function Card({ card, stage, handlers }: { card: BoardCard; stage: string; handlers: CardHandlers }) {
  const colors = useRepoColors();
  const status = cardStatus(card, handlers.context(card));
  const cost = cardCost(card, money);
  const pending = Boolean(handlers.moves.pending[card.ref]);
  const refused = handlers.moves.refused[card.ref];
  const number = card.number ?? Number(card.ref.split('#')[1]);
  // Its repository is the badge beside it, when the board shows more than one.
  // A request has no number until intake files it.
  const ref = card.request ? 'Request' : `#${number}`;
  // Only an issue has a stage to move out of, and only an admin moves one:
  // it changes what the crew builds next. The bridge refuses a user anyway.
  const admin = useRole() === 'admin';
  const movable = !card.request && admin;
  const people = [...new Set((card.active ?? []).map((task) => task.bot))];
  const title = stageOf(stage)?.title ?? stage;

  return (
    <article
      draggable={movable && !pending}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.ref);
        handlers.onDragStart(card.ref, stage);
      }}
      onDragEnd={handlers.onDragEnd}
      className={cn(
        'group relative flex flex-col gap-2 rounded-[10px] border bg-panel px-3.5 py-3 transition-colors hover:border-edge-strong md:rounded-lg md:px-3 md:py-2.5',
        status.tone === 'alarm' ? 'border-alarm/40' : status.tone === 'attention' ? 'border-attention/40' : 'border-edge',
        // The repository's colour down its edge; its status keeps the rest of the border.
        handlers.showRepo && ['border-l-[3px]', repoEdge(colors[card.repo])],
        pending && 'opacity-60',
        card.held && 'opacity-70',
        handlers.dragging?.ref === card.ref && 'opacity-40',
      )}
    >
      <span className={cn('flex min-w-0 items-center gap-2 text-[12px] text-dim md:text-[11.5px]', handlers.showRepo && 'relative')}>
        {handlers.showRepo && card.repo && <RepoBadge name={card.repo} className="shrink" />}
        {card.url ? (
          <a
            href={card.url}
            target="_blank"
            rel="noreferrer"
            title="Open the issue on GitHub"
            className="relative z-10 shrink-0 hover:text-link"
          >
            {ref}
          </a>
        ) : (
          <span className="shrink-0">{ref}</span>
        )}
        {card.sentBack ? (
          <span
            title={`Its work was sent back to an earlier stage ${card.sentBack === 1 ? 'once' : `${card.sentBack} times`}`}
            className="shrink-0 whitespace-nowrap text-attention"
          >
            sent back ×{card.sentBack}
          </span>
        ) : null}
        {/* The keyboard half of the move, and a trackpad's and a screen
            reader's: a drag is the one gesture they cannot make. It shows on
            hover and focus, in a row that has room for it, so the card is no
            taller for having it — or, showing every repository, where the
            repository's name needs that room, over the end of the row while it
            shows. Every other column is offered — the bridge decides what is
            legal, and says why when it is not. */}
        {movable && (
          <label
            draggable={false}
            className={cn('reveal relative z-10 flex items-center', handlers.showRepo ? 'reveal-over' : 'ml-auto')}
          >
            <span className="sr-only">
              Move {card.ref} out of {title}
            </span>
            <select
              value=""
              disabled={pending}
              onChange={(event) => {
                if (event.target.value) handlers.onMove({ ref: card.ref, from: stage }, event.target.value);
              }}
              className="h-[18px] appearance-none rounded bg-transparent py-0 pl-1 pr-4 text-[11px] leading-[18px] text-dim hover:text-soft focus-visible:outline-2 focus-visible:outline-link disabled:text-dim"
            >
              <option value="">{pending ? 'Moving…' : 'Move to…'}</option>
              {handlers.columns
                .filter((target) => target.stage !== stage)
                .map((target) => (
                  <option key={target.stage} value={target.stage}>
                    {stageOf(target.stage)?.title ?? target.title}
                  </option>
                ))}
            </select>
            <ChevronDownIcon size={10} className="pointer-events-none absolute right-0.5 text-dim" />
          </label>
        )}
        {cost && <span className={cn((handlers.showRepo || !movable) && 'ml-auto shrink-0 whitespace-nowrap')}>{cost}</span>}
      </span>

      <h3 className={cn('text-[14px] font-medium leading-[1.35] md:text-[13px]', stage === 'done' ? 'text-soft' : 'text-body')}>
        {/* The whole card opens its work item, through this
            button's box stretched over it; the links and the move list sit
            above that box. */}
        <button
          type="button"
          onClick={() => handlers.onOpen(card)}
          className="text-left after:absolute after:inset-0 after:rounded-[inherit] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-link"
        >
          {card.title}
        </button>
      </h3>

      {people.length > 0 && stage !== 'done' && (
        <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-soft md:text-[11.5px]">
          <span className="flex">
            {people.map((name, index) => (
              <BotAvatar
                key={name}
                bot={findBot(handlers.crew, name) ?? { name }}
                size="sm"
                ring
                className={cn(index > 0 && '-ml-[5px]', 'border-panel')}
              />
            ))}
          </span>
          <span className="truncate">{peopleLine(people.map((name) => handlers.labelOf(name)))}</span>
        </span>
      )}

      {/* Held by a person, or put first: said before what the card is doing,
          which is what it finishes before the hold, or does next. */}
      {card.held ? (
        <span data-held title={heldLine(card.held).title} className="text-[11.5px] font-medium text-attention">
          {heldLine(card.held).text}
        </span>
      ) : card.next ? (
        <span data-next className="flex items-center gap-1 text-[11.5px] font-medium text-link">
          <NextIcon size={11} />
          Next up
        </span>
      ) : null}

      {/* What the card is doing, and beside it pause, do next and cancel: an
          issue's, never a request's, an admin's (they say nothing to anyone
          else), and not on finished work. Always there, on a row of their own:
          shown on hover in the top row they crowded the repository, the number,
          the cost and the move list, and could not be found until hovered. */}
      {!card.request && !['merged', 'done'].includes(card.stage) ? (
        // Wraps so a refusal from the controls takes a line of its own below
        // the row, the card's width, rather than squeezing in beside them.
        <span className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
          <span className="min-w-0 flex-1">
            <StatusLine status={status} />
          </span>
          <IssueControls compact issue={{ subject: card.ref, number, held: card.held ?? null, next: card.next ?? false }} />
        </span>
      ) : (
        <StatusLine status={status} />
      )}

      {/* The bridge's own sentence, because "that was refused" without the
          reason is the same as the card quietly sliding back. */}
      {refused && (
        <p role="status" className="relative z-10 text-[11.5px] text-alarm">
          {refused}
        </p>
      )}
    </article>
  );
}

/**
 * The board on a phone: one stage at a time, chosen from a row of pills with
 * their counts, instead of six columns scrolled sideways.
 */
function PhoneStages({ columns, now, cards }: { columns: BoardColumn[]; now: string; cards: CardHandlers }) {
  const firstBusy = columns.find((column) => column.stage !== 'done' && column.cards.length > 0)?.stage;
  const [chosen, setChosen] = useState<string>(firstBusy ?? columns[0]?.stage ?? 'intake');
  const column = columns.find((one) => one.stage === chosen) ?? columns[0];
  if (!column) return null;
  const stage = stageOf(column.stage);
  const { cards: shown, older } = visibleCards(column, now);

  return (
    <div className="flex flex-col gap-3.5 pb-4 pt-3.5 md:hidden">
      <nav aria-label="Stage" className="scroll-row flex gap-1.5 overflow-x-auto px-4">
        {columns.map((one) => {
          const current = one.stage === column.stage;
          const count = one.stage === 'done' ? visibleCards(one, now).cards.length : one.cards.length;
          return (
            <button
              key={one.stage}
              type="button"
              aria-pressed={current}
              onClick={() => setChosen(one.stage)}
              className={cn(
                'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px]',
                current ? 'border-body bg-body font-medium text-surface' : 'border-edge bg-panel text-soft',
              )}
            >
              {stageOf(one.stage)?.title ?? one.title}
              <span className={current ? 'text-edge-strong' : 'text-dim'}>{count}</span>
            </button>
          );
        })}
      </nav>

      <section aria-label={stage?.title ?? column.title} className="flex flex-col gap-2.5 px-4">
        <p className="flex items-center gap-2 text-[12.5px] text-muted">
          {stage ? subtitleOf(column, stage.subtitle) : null}
        </p>
        {shown.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-edge-strong px-3 py-5 text-center text-[12.5px] text-dim">
            {EMPTY[column.stage] ?? 'Nothing here'}
          </p>
        ) : (
          shown.map((card) => <Card key={card.ref} card={card} stage={column.stage} handlers={cards} />)
        )}
        {older > 0 && <p className="text-[12px] text-dim">and {older} shipped before this week</p>}
      </section>
    </div>
  );
}
