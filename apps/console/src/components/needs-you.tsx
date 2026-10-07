'use client';

import Link from 'next/link';
import { type ReactNode, useRef, useState, useTransition } from 'react';
import { useRole } from '@/components/app-header';
import {
  abandonRequest,
  acknowledgeNotice,
  answerGate,
  decideUnowned,
  dismissNotice,
  dismissTasks,
  recheckHealth,
  releasePromote,
  retryTask,
  retryTriage,
  stopTask,
  stopTasks,
  switchToAutomatic,
} from '@/app/actions';
import { Copyable } from '@/components/copyable';
import { CheckIcon, ExternalIcon, QuestionIcon, ShipIcon, WarningIcon } from '@/components/icons';
import type { AttentionAction, AttentionItem, AttentionMember } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Markdown } from '@/components/markdown';
import { RepoBadge } from '@/components/repo-badge';
import { Dialog, DialogClose, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { CHOICES_ON_CARD, alarming, faceActions, groupCounts, groupOf, hasMore, plainDetail, stripItems, waiting as waitingOf } from '@/lib/attention-card';
import { IncidentSteps } from '@/components/incident-steps';
import { standsOut } from '@/lib/thread';
import { ago } from '@/lib/when';

/** Where every item is, in two lists: the board shows only the few most pressing. */
export const NEEDS_YOU_PAGE = '/needs-you';

/** How a bot's thread is opened from here: to read it, or to answer in the person's own words. */
export type OpenBot = (bot: string, how?: { compose?: boolean }) => void;

/** How a work item is opened from here, on the tab of the role that asked. */
export type OpenItem = (item: string, role: string | null, how?: { compose?: boolean }) => void;

/** A work item's address on the board, on a role's tab: what a card links to where no sheet is at hand. */
export function itemOnBoard(item: string, role: string | null): string {
  const query = new URLSearchParams({ item });
  if (role) query.set('role', role);
  return `/?${query.toString()}`;
}

/**
 * What "Answer" and "Open thread" open for one item: its work item, on the
 * tab of the role that asked, when it is about a piece of work — the bot's
 * panel held every other subject that bot had worked on, so a question about
 * one request was answered beside three others, and each request is its own
 * conversation. What is the
 * install's (a check, a sign-in) is still the bot's own panel.
 */
function openerFor(
  subject: Pick<AttentionItem['subject'], 'item'>,
  bot: { role: string } | null,
  group: 'work' | 'system',
  onOpenBot: OpenBot,
  onOpenItem?: OpenItem,
): OpenBot {
  const item = group === 'work' ? (subject.item ?? null) : null;
  if (!item) return onOpenBot;
  const role = bot?.role ?? null;
  return (_bot, how) =>
    onOpenItem ? onOpenItem(item, role, how) : window.location.assign(itemOnBoard(item, role));
}

/**
 * What waits on the person, at the top of the board: at most three, the most
 * pressing first, and a link to all of them on `/needs-you`. Absent when
 * nothing is waiting: an empty "needs you" is a heading that says nothing.
 *
 * It used to list everything here — the crew's questions beside every health
 * check, permission and sign-in — and a board with a dozen system cards had
 * its columns pushed out of sight. The whole lists, work and system apart,
 * are on their own page.
 *
 * What is answered here reaches GitHub the way a gate answer always has — once
 * there is an issue, the bot that asked posts the answer on it, naming the
 * person — and approving and trying
 * again go through the same routes the rest of the console uses. A question's
 * choices answer it from its card; anything else is said in the bot's thread.
 */
export function NeedsYou({
  items,
  now,
  onOpenBot,
  onOpenItem,
  showRepo = false,
  repo,
}: {
  items: readonly AttentionItem[];
  now: string;
  /** Opens a bot's thread; to answer a question in the person's own words, with its box ready to type in. */
  onOpenBot: OpenBot;
  /** Opens a work item; without it, a work card goes to the item's address on the board. */
  onOpenItem?: OpenItem;
  /** Whether a subject says its repository, when the board shows more than one. */
  showRepo?: boolean;
  /**
   * The one repository the board shows, if it shows one. What needs you is
   * everything, so an item from any other says which it is from.
   */
  repo?: string;
}) {
  // Something fixed waits on nobody: it is not counted, and the board does not
  // list it. With nothing else waiting, the heading still shows with 0 and
  // leads to the Needs you page, where the recoveries are.
  const waiting = waitingOf(items);
  const notices = items.filter((item) => item.kind === 'check_fixed');
  if (waiting.length === 0 && notices.length === 0) return null;
  const shown = stripItems(items);
  const counts = groupCounts(items);

  return (
    <section id="needs" aria-labelledby="needs-title" className="flex shrink-0 flex-col gap-2 pt-3.5 md:gap-2.5 md:px-6 md:pb-1 md:pt-[18px]">
      <div className="flex flex-wrap items-center gap-2 px-4 md:px-0">
        <h2 id="needs-title" className="text-sm font-semibold text-body">
          <Link href={NEEDS_YOU_PAGE} className="hover:underline">
            Needs you
          </Link>
        </h2>
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-attention/12 px-1.5 text-[11.5px] font-semibold text-attention">
          {waiting.length}
        </span>
        {waiting.length > 0 && (
          <span className="text-[12px] text-dim">
            {counts.work} work · {counts.system} system
          </span>
        )}
        {waiting.length > 0 && (
          <Link href={NEEDS_YOU_PAGE} className="ml-auto text-[12.5px] text-link hover:underline">
            See all {waiting.length} →
          </Link>
        )}
      </div>

      {shown.length > 0 && (
        // One under another on a phone: a row scrolled sideways hid all but
        // the first, and there are only three.
        <div className="grid gap-2.5 px-4 md:grid-cols-2 md:gap-3 md:px-0 xl:grid-cols-3">
          {shown.map((item) => (
            <NeedsCard
              key={item.id}
              item={item}
              now={now}
              onOpenBot={onOpenBot}
              onOpenItem={onOpenItem}
              showRepo={showRepo}
              repo={repo}
              elsewhere={Boolean(repo && repo !== 'all' && item.subject.repo && item.subject.repo !== repo)}
            />
          ))}
        </div>
      )}

      {/* What recovered is on the Needs you page, behind the header's chip and this
          heading: a line of it here, under nothing to do, read as one more thing. */}
    </section>
  );
}

/**
 * Every item of one list, as the compact cards, for `/needs-you`: nothing is
 * left out here, and a phone reads them one under another.
 */
export function NeedsList({
  items,
  now,
  onOpenBot,
  onOpenItem,
  showRepo = true,
  empty,
}: {
  items: readonly AttentionItem[];
  now: string;
  onOpenBot: OpenBot;
  onOpenItem?: OpenItem;
  showRepo?: boolean;
  /** What the list says when nothing in it waits. */
  empty: string;
}) {
  const waiting = waitingOf(items);
  const notices = items.filter((item) => item.kind === 'check_fixed');
  return (
    <div className="flex flex-col gap-3">
      {waiting.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-edge-strong px-3 py-5 text-center text-[12.5px] text-dim">{empty}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {waiting.map((item) => (
            <NeedsCard key={item.id} item={item} now={now} onOpenBot={onOpenBot} onOpenItem={onOpenItem} showRepo={showRepo} elsewhere={false} />
          ))}
        </div>
      )}
      {notices.length > 0 && <Recoveries items={notices} now={now} open />}
    </div>
  );
}

/** Every recovery under the bot it is about; a fixed check with none is OpenADLC's own. */
export function groupRecoveries(items: readonly AttentionItem[]): { name: string; items: AttentionItem[] }[] {
  const byName = new Map<string, AttentionItem[]>();
  for (const item of items) {
    const name = item.bot?.name ?? 'OpenADLC';
    byName.set(name, [...(byName.get(name) ?? []), item]);
  }
  return [...byName.entries()].map(([name, list]) => ({ name, items: list }));
}

/** The checks "Clear all" dismisses: every recovery on the board at once, not one at a time. */
export function recoveryCheckIds(items: readonly AttentionItem[]): string[] {
  return items
    .map((item) => item.actions.find((action) => action.kind === 'dismiss'))
    .filter((action): action is Extract<AttentionAction, { kind: 'dismiss' }> => Boolean(action))
    .map((action) => action.checkId);
}

/** The tasks "Clear all" dismisses: a failed task's line whose work landed, which is kept by task, not by check. */
export function recoveryTasks(items: readonly AttentionItem[]): { taskId: string; occurrence: string }[] {
  return items.flatMap((item) => item.actions.flatMap((action) => (action.kind === 'dismiss_task' ? action.tasks : [])));
}

/**
 * Everything that was wrong and is not any more — a sign-in that works again,
 * an invitation accepted, a key GitHub learned — folded behind one line: read
 * one at a time, each competed for the same attention as what still needs it.
 * Expanding lists every one, grouped by the bot it is about, with one "Clear
 * all" for the lot instead of a dismiss to press per line. Said only for a
 * day; what nobody reads by then goes on its own.
 */
export function Recoveries({ items, now, open: openByDefault = false }: { items: readonly AttentionItem[]; now: string; open?: boolean }) {
  const [open, setOpen] = useState(openByDefault);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const groups = groupRecoveries(items);
  // Clearing a recovered check is an admin's, as its card's buttons are.
  const admin = useRole() === 'admin';

  const clearAll = (): void => {
    setError(null);
    startTransition(async () => {
      const tasks = recoveryTasks(items);
      const results = await Promise.all([
        ...recoveryCheckIds(items).map((checkId) => dismissNotice(checkId)),
        ...(tasks.length > 0 ? [dismissTasks(tasks)] : []),
      ]);
      const failed = results.find((result) => !result.ok);
      if (failed) setError(failed.error ?? 'that did not go through');
    });
  };

  return (
    <div className="flex flex-col gap-1.5 px-4 md:px-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="inline-flex items-center gap-1.5 text-soft hover:text-body"
        >
          <span aria-hidden className="text-signal">
            <CheckIcon size={13} />
          </span>
          {items.length} {items.length === 1 ? 'thing' : 'things'} recovered in the last day
          <span className="text-link">{open ? 'Hide' : 'Show'}</span>
        </button>
        {open && admin && (
          <button type="button" disabled={pending} onClick={clearAll} className="text-link hover:underline disabled:opacity-60">
            {pending ? 'Clearing…' : 'Clear all'}
          </button>
        )}
        {error && <span className="text-alarm">{error}</span>}
      </div>
      {open && (
        <ul aria-label="Recovered" className="flex flex-col gap-2 rounded-md bg-surface px-3 py-2.5">
          {groups.map((group) => (
            <li key={group.name} className="flex flex-col gap-0.5">
              <p className="text-[11.5px] font-medium text-soft">{group.name}</p>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.id} className="flex items-baseline gap-1.5 text-[12px] leading-relaxed text-muted">
                    <span className="min-w-0 flex-1">{item.headline}</span>
                    <span className="shrink-0 whitespace-nowrap text-dim">{ago(item.since, now)}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function kindIcon(kind: AttentionItem['kind']): ReactNode {
  if (kind === 'question') return <QuestionIcon size={15} />;
  if (kind === 'approval' || kind === 'merge_waiting') return <ShipIcon size={15} />;
  return <WarningIcon size={15} />;
}

function NeedsCard({
  item,
  now,
  onOpenBot: openBotPanel,
  onOpenItem,
  showRepo,
  repo,
  elsewhere,
}: {
  item: AttentionItem;
  now: string;
  onOpenBot: OpenBot;
  onOpenItem?: OpenItem;
  showRepo: boolean;
  /** The one repository the board shows, if it shows one; see `NeedsYou`. */
  repo?: string;
  /** From another repository than the one the board shows. */
  elsewhere: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** The choice being sent, while it is. */
  const [chosen, setChosen] = useState<string | null>(null);
  const group = groupOf(item);
  const onOpenBot = openerFor(item.subject, item.bot, group, openBotPanel, onOpenItem);
  const alarm = alarming(item);
  const { subject } = item;
  const gateId = item.kind === 'question' ? (item.question?.gateId ?? null) : null;
  const choices = gateId ? (item.question?.options ?? []) : [];
  // Beside a question's choices, the way to say something else goes with them,
  // set apart, rather than below them where it read as one more choice.
  const somethingElse = choices.length > 0 ? item.actions.find((action) => action.kind === 'answer') : undefined;
  const actions = item.actions.filter((action) => action !== somethingElse);
  const number = subject.number !== null ? `${showRepo && subject.repo ? subject.repo : ''}#${subject.number}` : null;

  // Which of the card's buttons is running, so only that one says so: the card
  // has one pending state for all of them.
  const [active, setActive] = useState<string | null>(null);
  const run = (work: () => Promise<{ ok: boolean; error?: string }>, key?: string): void => {
    setError(null);
    setActive(key ?? null);
    startTransition(async () => {
      const result = await work();
      // Done means the item goes: the action revalidates the board, which reads
      // "needs you" again without it.
      if (!result.ok) setError(result.error ?? 'that did not go through');
    });
  };

  const more = hasMore(item);
  const face = faceActions(item);
  // Where the sheet opens: at the top from Show more, at the steps from What to do.
  const [open, setOpenAt] = useState<false | 'top' | 'steps'>(false);
  const setOpen = (next: boolean) => setOpenAt(next ? 'top' : false);
  const steps = useRef<HTMLElement | null>(null);
  // The thread panel sits under a modal sheet, so the sheet closes first and
  // does not take focus back from the thread's composer as it goes.
  const handingOff = useRef(false);
  const openFromSheet: OpenBot = (bot, how) => {
    handingOff.current = true;
    setOpenAt(false);
    onOpenBot(bot, how);
  };
  const answer = (option: string) => {
    setChosen(option);
    run(async () => {
      const result = await answerGate(gateId!, option);
      if (!result.ok) setChosen(null);
      return result;
    });
  };
  const somethingElseButton = (openBot: OpenBot) =>
    somethingElse?.kind === 'answer' ? (
      <button type="button" className={SOMETHING_ELSE} onClick={() => openBot(somethingElse.bot, { compose: true })}>
        {somethingElse.label}
      </button>
    ) : null;
  const subjectLine = (number || subject.title) && (
    <p className="truncate text-[12.5px] text-soft">
      {number && <span className="text-dim">{number} </span>}
      {subject.title}
    </p>
  );

  // The card's face: its headline, two lines of what happened and the things
  // to press. Everything else is in its sheet. What is cut short is
  // text alone, headline and detail at two lines each; the buttons and an
  // error are never clipped, and wrap where the card is narrow.
  return (
    <article
      data-card={item.id}
      className={cn(
        'flex min-w-0 gap-3 rounded-[10px] border bg-panel px-3.5 py-3 md:rounded-lg md:px-4 md:py-3.5',
        alarm ? 'border-alarm/35' : 'border-attention/35',
      )}
    >
      <span
        className={cn(
          'hidden size-7 shrink-0 items-center justify-center rounded-full md:flex',
          alarm ? 'bg-alarm/10 text-alarm' : 'bg-attention/12 text-attention',
        )}
      >
        {kindIcon(item.kind)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline gap-2">
          <h3 className="line-clamp-2 text-[13px] font-semibold text-body">{item.headline}</h3>
          {(showRepo || elsewhere) && subject.repo && <RepoBadge name={subject.repo} className="self-center" />}
          <span className="ml-auto shrink-0 text-[11.5px] text-dim">{ago(item.since, now)}</span>
        </div>
        {subjectLine}
        {item.context && (
          // What the question is about — intake's draft, before "Here's what I'll
          // file. OK?" — cut short here and whole behind Show more.
          <button
            type="button"
            data-clamp="context"
            onClick={() => setOpen(true)}
            className="relative max-h-36 overflow-hidden rounded-md border border-edge bg-surface px-2.5 py-2 text-left text-[12px] leading-snug text-body hover:border-edge-strong"
          >
            <Markdown text={item.context} />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-surface to-transparent" />
          </button>
        )}
        {item.detail && (
          <p
            data-clamp="detail"
            className={cn(
              'line-clamp-2 text-[12.5px] leading-normal',
              item.kind === 'question' ? 'text-body' : 'text-muted',
              item.kind === 'question' && standsOut(item.detail) && 'font-semibold',
            )}
          >
            {plainDetail(item.detail)}
          </p>
        )}
        {gateId && choices.length > 0 && (
          <QuestionChoices options={choices.slice(0, CHOICES_ON_CARD)} pending={pending} chosen={chosen} onChoose={answer}>
            {somethingElseButton(onOpenBot)}
          </QuestionChoices>
        )}
        {(face.length > 0 || more) && (
          <div data-face="actions" className="mt-0.5 flex flex-wrap items-center gap-2">
            {face.map((action, index) => (
              <ActionButton
                key={`${action.kind}-${index}`}
                action={action}
                primary={index === 0}
                pending={pending}
                active={active}
                onOpenBot={onOpenBot}
                run={run}
                onShowMore={() => setOpenAt('steps')}
              />
            ))}
            {more && (
              <button type="button" onClick={() => setOpen(true)} className="text-[12.5px] text-link hover:underline">
                Show more
              </button>
            )}
          </div>
        )}
        {error && (
          <p role="status" className="text-[12px] text-alarm">
            {error}
          </p>
        )}
      </div>

      {more && (
        <Dialog open={open !== false} onOpenChange={setOpen}>
          <SheetContent
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              if (open !== 'steps' || !steps.current) return;
              event.preventDefault();
              steps.current.focus();
              steps.current.scrollIntoView?.({ block: 'start' });
            }}
            onCloseAutoFocus={(event) => {
              if (!handingOff.current) return;
              handingOff.current = false;
              event.preventDefault();
            }}
          >
            <div className="flex items-start gap-2">
              <DialogTitle className="text-[14px]">{item.headline}</DialogTitle>
              <DialogClose className="ml-auto shrink-0 text-[12.5px] text-muted hover:text-body">Close</DialogClose>
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-dim">
              {subject.repo && <RepoBadge name={subject.repo} />}
              <span>{ago(item.since, now)}</span>
            </div>
            {subjectLine}
            {item.context && (
              <div className="max-h-[50vh] overflow-auto rounded-md border border-edge px-3 py-2.5 text-[12.5px] leading-normal text-body">
                <Markdown text={item.context} />
              </div>
            )}
            {item.detail && (
              <div className={cn('text-[12.5px] leading-normal', item.kind === 'question' ? 'rounded-md bg-surface px-2.5 py-2 text-body' : 'text-muted')}>
                <Markdown text={item.detail} className={cn(item.kind === 'question' && standsOut(item.detail) && 'font-semibold')} />
              </div>
            )}
            {item.raw && (
              // What arrived, word for word, for whoever wants it; the sentence
              // above is what to do about it.
              <details className="text-[12px] text-dim">
                <summary className="w-fit cursor-pointer select-none hover:text-muted">Details</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface px-2.5 py-2 font-mono text-[11px] leading-snug text-muted">
                  {item.raw}
                </pre>
              </details>
            )}
            {gateId && choices.length > 0 && (
              <QuestionChoices options={choices} pending={pending} chosen={chosen} onChoose={answer}>
                {somethingElseButton(openFromSheet)}
              </QuestionChoices>
            )}
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {actions
                  // An incident's steps are what follows, and its This was me is step one.
                  .filter((action) => action.kind !== 'incident' && !(item.incident && action.kind === 'acknowledge'))
                  .map((action, index) => (
                    <ActionButton
                      key={`${action.kind}-${index}`}
                      action={action}
                      primary={index === 0 && choices.length === 0}
                      pending={pending}
                      active={active}
                      onOpenBot={openFromSheet}
                      run={run}
                    />
                  ))}
              </div>
            )}
            {item.incident && (
              <IncidentSteps
                ref={steps}
                incident={item.incident}
                thisWasMe={(() => {
                  const dismiss = item.actions.find((action) => action.kind === 'acknowledge');
                  return dismiss ? (
                    <ActionButton action={dismiss} primary={false} pending={pending} active={active} onOpenBot={openFromSheet} run={run} />
                  ) : null;
                })()}
              />
            )}
            {item.members && item.members.length > 1 && (
              <MemberList
                members={item.members}
                now={now}
                showRepo={showRepo}
                repo={repo}
                pending={pending}
                active={active}
                onOpenBot={(member) => {
                  const open = openerFor(member.subject, member.bot, group, openBotPanel, onOpenItem);
                  return (bot, how) => {
                    handingOff.current = true;
                    setOpenAt(false);
                    open(bot, how);
                  };
                }}
                run={run}
              />
            )}
            {error && (
              <p role="status" className="text-[12px] text-alarm">
                {error}
              </p>
            )}
          </SheetContent>
        </Dialog>
      )}
    </article>
  );
}

/**
 * Every item a card's cause stands for, newest first: what happened to each,
 * in its own words, and everything that can be pressed about it — a fix that
 * names that bot, trying its work again, its own thread — since the card's
 * own button, above, speaks for the cause and not for any one of them.
 */
function MemberList({
  members,
  now,
  showRepo,
  repo,
  pending,
  active,
  onOpenBot,
  run,
}: {
  members: readonly AttentionMember[];
  now: string;
  showRepo: boolean;
  /** The one repository the board shows, if it shows one; see `NeedsYou`. */
  repo?: string;
  pending: boolean;
  active: string | null;
  /** Each member opens its own work item, or its bot's panel. */
  onOpenBot: (member: AttentionMember) => OpenBot;
  run: (work: () => Promise<{ ok: boolean; error?: string }>, key?: string) => void;
}) {
  return (
    <ul aria-label="Affected" className="flex flex-col gap-2 rounded-md bg-surface px-2.5 py-2">
      {members.map((member) => {
        const number = member.subject.number !== null ? `${showRepo && member.subject.repo ? member.subject.repo : ''}#${member.subject.number}` : null;
        const elsewhere = Boolean(repo && repo !== 'all' && member.subject.repo && member.subject.repo !== repo);
        return (
          <li key={member.id} className="flex flex-col gap-1 text-[12px] text-soft">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <p className="truncate">{member.headline}</p>
                  {(showRepo || elsewhere) && member.subject.repo && <RepoBadge name={member.subject.repo} className="self-center" />}
                </div>
                {(number || member.subject.title) && (
                  <p className="truncate text-dim">
                    {number && <span>{number} </span>}
                    {member.subject.title}
                  </p>
                )}
              </div>
              <span className="shrink-0 whitespace-nowrap text-dim">{ago(member.since, now)}</span>
            </div>
            {member.detail && <Markdown text={member.detail} className="leading-snug text-muted" />}
            {member.raw && (
              <details className="text-[11px] text-dim">
                <summary className="w-fit cursor-pointer select-none hover:text-muted">Details</summary>
                <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-panel px-2 py-1.5 font-mono text-[10.5px] leading-snug text-muted">
                  {member.raw}
                </pre>
              </details>
            )}
            {member.actions.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {member.actions.map((action, index) => (
                  <ActionButton
                    key={`${action.kind}-${index}`}
                    action={action}
                    primary={false}
                    pending={pending}
                    active={active}
                    onOpenBot={onOpenBot(member)}
                    run={run}
                  />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A question's choices on its card, in the order the bot gave them, the likely
 * answer first. Pressing one answers the question from here, through the
 * gate-answer route everything else uses, and the card goes once it has.
 */
function QuestionChoices({
  options,
  pending,
  chosen,
  onChoose,
  children,
}: {
  options: readonly string[];
  pending: boolean;
  /** The choice being sent, while it is. */
  chosen: string | null;
  onChoose: (option: string) => void;
  /** What follows the choices in their row: the way to say something else. */
  children?: ReactNode;
}) {
  return (
    <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const sending = pending && chosen === option;
        return (
          <button
            key={option}
            type="button"
            disabled={pending}
            aria-busy={sending || undefined}
            onClick={() => onChoose(option)}
            className={cn(
              'inline-flex min-h-11 items-center rounded-md border border-edge-strong bg-panel px-3 py-2 text-left text-[12.5px] leading-snug text-body transition-colors hover:border-attention/60 hover:bg-attention/10 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60 md:min-h-7 md:px-2.5 md:py-1',
              sending && 'border-attention/60 bg-attention/10',
            )}
          >
            {option}
          </button>
        );
      })}
      {children}
    </div>
  );
}

/** Set apart from the choices beside it: it answers nothing here, and opens the thread to say something else. */
const SOMETHING_ELSE =
  'inline-flex min-h-11 items-center rounded-md border border-dashed border-edge-strong px-3 py-2 text-left text-[12.5px] leading-snug text-muted transition-colors hover:border-dim hover:text-body focus-visible:outline-2 focus-visible:outline-link md:min-h-7 md:px-2.5 md:py-1';

const BUTTON = 'inline-flex h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[12.5px] md:h-7 md:px-2.5';
const PRIMARY = `${BUTTON} flex-1 bg-body font-medium text-surface transition-colors hover:bg-soft disabled:opacity-60 md:flex-none`;
const SECONDARY = `${BUTTON} border border-edge-strong text-soft transition-colors hover:border-dim hover:text-body disabled:opacity-60`;

/** What only an admin may press on a card: a health check's actions, and a link into Settings or the walkthrough. */
export function adminOnly(action: AttentionAction): boolean {
  if (action.kind === 'recheck' || action.kind === 'acknowledge' || action.kind === 'dismiss') return true;
  // What happens to issues OpenADLC will not take on its own: an admin's, as the bridge enforces.
  if (action.kind === 'unowned_intake' || action.kind === 'unowned_ignore' || action.kind === 'unowned_close') return true;
  // Releasing a held promote to production, or switching how a repository ships: an admin's, as the bridge enforces.
  if (action.kind === 'promote_release' || action.kind === 'promote_automatic') return true;
  return action.kind === 'open_page' && (action.href.startsWith('/onboarding') || action.href.startsWith('/settings'));
}

/**
 * Which of a card's buttons is running, so only it says what it is doing: a
 * task's by the tasks it acts on. By kind alone, every Dismiss on the page
 * said "Dismissing…" while one was pressed, and a Stop all shared its key
 * with the Stop of its newest task.
 */
export function keyOf(action: AttentionAction): string {
  if (action.kind === 'dismiss_task') return `${action.kind}:${action.tasks.map((task) => task.taskId).join(',')}`;
  if (action.kind === 'stop_task' && action.taskIds && action.taskIds.length > 1) return `${action.kind}:${action.taskIds.join(',')}`;
  if ('numbers' in action) return `${action.kind}:${action.repo}`;
  if ('sha' in action) return `${action.kind}:${action.repo}@${action.sha}`;
  if (action.kind === 'abandon_request') return `${action.kind}:${action.requestId}`;
  return 'taskId' in action ? `${action.kind}:${action.taskId}` : action.kind;
}

function ActionButton({
  action,
  primary,
  pending,
  active = null,
  onOpenBot,
  run,
  onShowMore,
}: {
  action: AttentionAction;
  primary: boolean;
  pending: boolean;
  /** The card's button that is running, by `keyOf`: only it says what it is doing. */
  active?: string | null;
  onOpenBot: OpenBot;
  run: (work: () => Promise<{ ok: boolean; error?: string }>, key?: string) => void;
  /** Opens the card's sheet, which What to do does. */
  onShowMore?: () => void;
}) {
  const style = primary ? PRIMARY : SECONDARY;
  const key = keyOf(action);
  // A health check is the install's setup: running it again, dismissing its
  // card and the pages that fix it are an admin's, and the bridge refuses a
  // user them. A user still sees what is wrong, and whom it waits on.
  const admin = useRole() === 'admin';
  if (!admin && adminOnly(action)) return null;
  const press = (work: () => Promise<{ ok: boolean; error?: string }>) => run(work, key);
  const busy = pending && active === key;

  switch (action.kind) {
    case 'answer':
      // "Something else…", or "Answer" for a free-form question: the thread, ready to type in.
      return (
        <button type="button" className={style} onClick={() => onOpenBot(action.bot, { compose: true })}>
          {action.label}
        </button>
      );
    case 'open_thread':
      return (
        <button type="button" className={style} onClick={() => onOpenBot(action.bot)}>
          {action.label}
        </button>
      );
    case 'approve':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => run(() => answerGate(action.gateId, action.answer))}>
          {pending ? 'Sending…' : action.label}
        </button>
      );
    case 'retry_triage':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => run(() => retryTriage(action.requestId))}>
          {pending ? 'Starting…' : action.label}
        </button>
      );
    case 'abandon_request':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => {
            if (!window.confirm('Abandon this request? Its triage stops, and nothing starts it again.')) return;
            press(() => abandonRequest(action.requestId));
          }}
        >
          {busy ? 'Abandoning…' : action.label}
        </button>
      );
    case 'retry_task':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => retryTask(action.taskId))}>
          {busy ? 'Starting…' : action.label}
        </button>
      );
    case 'stop_task':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => press(() => (action.taskIds && action.taskIds.length > 1 ? stopTasks(action.taskIds) : stopTask(action.taskId)))}
        >
          {busy ? 'Stopping…' : action.label}
        </button>
      );
    case 'dismiss_task':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => dismissTasks(action.tasks))}>
          {busy ? 'Dismissing…' : action.label}
        </button>
      );
    case 'recheck':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => recheckHealth(action.checkId))}>
          {busy ? 'Checking…' : action.label}
        </button>
      );
    case 'acknowledge':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => acknowledgeNotice(action.checkId, action.occurrence))}>
          {busy ? 'Dismissing…' : action.label}
        </button>
      );
    case 'unowned_intake':
    case 'unowned_ignore':
    case 'unowned_close': {
      // Issues OpenADLC will not take on its own: what happens to them is a person's to say.
      const decision = action.kind === 'unowned_intake' ? 'intake' : action.kind === 'unowned_ignore' ? 'ignore' : 'close';
      const doing = decision === 'intake' ? 'Sending…' : decision === 'ignore' ? 'Ignoring…' : 'Closing…';
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => {
            const which = action.numbers.map((number) => `#${number}`).join(', ');
            if (decision === 'close' && !window.confirm(`Close ${which} in ${action.repo} as not planned? A comment says why on each.`)) return;
            press(() => decideUnowned(action.repo, decision, action.numbers));
          }}
        >
          {busy ? doing : action.label}
        </button>
      );
    }
    case 'promote_release':
      // OpenADLC dispatches the promote as the app; nothing is approved in GitHub.
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => {
            if (!window.confirm(`Release ${action.repo}@${action.sha.slice(0, 7)} to production now?`)) return;
            press(() => releasePromote(action.repo, action.sha));
          }}
        >
          {busy ? 'Releasing…' : action.label}
        </button>
      );
    case 'promote_automatic':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => {
            const asked =
              `Switch ${action.repo} to automatic delivery? No person approves production any more: each promote soaks on testing ` +
              'for at least 30 minutes, then the smoke runs, and a failed production deploy is rolled back.';
            if (!window.confirm(asked)) return;
            press(() => switchToAutomatic(action.repo));
          }}
        >
          {busy ? 'Switching…' : action.label}
        </button>
      );
    case 'incident':
      // Its steps are in the card's sheet; in the sheet itself, they are what follows.
      return onShowMore ? (
        <button type="button" className={style} onClick={onShowMore}>
          {action.label}
        </button>
      ) : null;
    case 'dismiss':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => run(() => dismissNotice(action.checkId))}>
          {action.label}
        </button>
      );
    case 'run_command':
      // Only a shell on OpenADLC's machine can do this one, so the card hands over
      // the command rather than a button that cannot press it.
      return <Copyable value={action.command} className="min-w-[150px] flex-1 md:flex-none" />;
    case 'open_url':
      return (
        <a href={action.url} target="_blank" rel="noreferrer" className={style}>
          {action.label}
          <ExternalIcon size={12} />
        </a>
      );
    case 'open_page':
      return (
        <Link href={action.href} className={style}>
          {action.label}
        </Link>
      );
  }
}
