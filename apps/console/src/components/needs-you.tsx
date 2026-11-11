'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react';
import { useRole } from '@/components/app-header';
import {
  abandonRequest,
  acknowledgeNotice,
  answerGate,
  approveAll,
  approveHumanReview,
  askDesigner,
  turnOffApproveAll,
  decideUnowned,
  dismissNotice,
  dismissSigningKey,
  dismissDesignMemoryNotice,
  dismissTasks,
  leaveAttention,
  mergeHeld,
  recheckHealth,
  rejectHumanReview,
  releasePromote,
  resumeItem,
  retryTask,
  retryTriage,
  revokeSigningKey,
  sendItemMessage,
  startItem,
  stopTask,
  stopTasks,
  switchToAutomatic,
  undismissSigningKey,
} from '@/app/actions';
import { Copyable } from '@/components/copyable';
import { DeviceCode } from '@/components/device-code';
import { CheckIcon, ExternalIcon, QuestionIcon, ShipIcon, WarningIcon } from '@/components/icons';
import type { AttentionAction, AttentionItem, AttentionMember } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Markdown, MarkdownInline } from '@/components/markdown';
import { RepoBadge } from '@/components/repo-badge';
import { Dialog, DialogClose, DialogTitle, SheetContent } from '@/components/ui/dialog';
import { safeAction } from '@/lib/safe-action';
import {
  CHOICES_ON_CARD,
  alarming,
  audienceLine,
  decisionButtons,
  faceActions,
  groupCounts,
  groupOf,
  hasMore,
  heldMergeButtons,
  noMergeReason,
  plainDetail,
  rejectReady,
  reviewVerdict,
  reviewerName,
  stripItems,
  unblockedOf,
  waiting as waitingOf,
  type DecisionButton,
  type HeldMergeButton,
} from '@/lib/attention-card';
import { IncidentSteps } from '@/components/incident-steps';
import { PullActions, pullPath } from '@/components/pull-panel';
import { standsOut } from '@/lib/thread';
import { ago } from '@/lib/when';

/** Where every item is, in two lists: the board shows only the few most pressing. */
export const NEEDS_YOU_PAGE = '/needs-you';

/** How a bot's thread is opened from here: to read it, or to answer in the person's own words. */
export type OpenBot = (bot: string, how?: { compose?: boolean }) => void;

/** How a work item is opened from here, on the tab of the role that asked. */
export type OpenItem = (item: string, role: string | null, how?: { compose?: boolean }) => void;

/**
 * What a card does from the keyboard on the Needs you page: answer its
 * question with its nth choice, or open it, each exactly as a click would.
 */
export interface CardKeys {
  choose(n: number): void;
  open(): void;
}

/** How a card hands the page its keys, by item id, and takes them back (null) when it goes. */
export type OnCards = (id: string, keys: CardKeys | null) => void;

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
  selected = null,
  onCards,
}: {
  items: readonly AttentionItem[];
  now: string;
  onOpenBot: OpenBot;
  onOpenItem?: OpenItem;
  showRepo?: boolean;
  /** What the list says when nothing in it waits. */
  empty: string;
  /** The card the keyboard has selected, by item id. */
  selected?: string | null;
  /** Each card's keys, for the page that reads them (`NeedsYouPage`). */
  onCards?: OnCards;
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
            <NeedsCard
              key={item.id}
              item={item}
              now={now}
              onOpenBot={onOpenBot}
              onOpenItem={onOpenItem}
              showRepo={showRepo}
              elsewhere={false}
              selected={selected === item.id}
              onCards={onCards}
            />
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
  selected = false,
  onCards,
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
  /** Selected from the keyboard: ringed, scrolled to, and its choices numbered. */
  selected?: boolean;
  onCards?: OnCards;
}) {
  const [error, setError] = useState<string | null>(null);
  /** The choice being sent, while it is. */
  const [chosen, setChosen] = useState<string | null>(null);
  // Set at once, and cleared by the action's answer. A transition's pending
  // was set only by the next render, so a quick second press went through,
  // and it stayed set until the whole board had been read again: a press
  // waited for every GitHub call behind it and then for the page, and the
  // person pressed again (#76).
  const [busy, setBusy] = useState(false);
  const pressing = useRef(false);
  /** What the press did, from its answer, said on the card until the board is read again without it. */
  const [done, setDone] = useState<Done | null>(null);
  const pending = busy || done?.final === true;
  const group = groupOf(item);
  const onOpenBot = openerFor(item.subject, item.bot, group, openBotPanel, onOpenItem);
  const alarm = alarming(item);
  const unblocked = unblockedOf(item);
  const { subject } = item;
  const gateId = item.kind === 'question' ? (item.question?.gateId ?? null) : null;
  const choices = gateId ? (item.question?.options ?? []) : [];
  // What is being decided, above the question, and what each choice leads
  // to, under it: only when there is one for every choice, so none reads
  // with another's.
  const decision = gateId ? (item.question?.decision?.trim() ?? '') : '';
  const consequences = gateId && item.question?.consequences?.length === choices.length ? item.question.consequences : [];
  // Beside a question's choices, the way to say something else goes with them,
  // set apart, rather than below them where it read as one more choice.
  const somethingElse = choices.length > 0 ? item.actions.find((action) => action.kind === 'answer') : undefined;
  const actions = item.actions.filter((action) => action !== somethingElse);
  const number = subject.number !== null ? `${showRepo && subject.repo ? subject.repo : ''}#${subject.number}` : null;

  // Which of the card's buttons is running, so only that one says so: the card
  // has one pending state for all of them.
  const [active, setActive] = useState<string | null>(null);
  const run: Run = (work, key, said) => {
    if (pressing.current) return;
    pressing.current = true;
    setError(null);
    setActive(key ?? null);
    setBusy(true);
    void safeAction(work).then((result) => {
      pressing.current = false;
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'that did not go through');
      // Done means the item goes: the action revalidates the board, which
      // reads "needs you" again without it. Until then the card says so.
      setActive(null);
      const outcome = said?.(result) ?? null;
      if (outcome) setDone(outcome);
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
    // Both of the button's guards: a press still going, and a final answer
    // the card holds until it leaves. A number key never meets the button's
    // \`disabled\`, so without \`pending\` a second 1 answered again (#241).
    if (pressing.current || pending) return;
    setChosen(option);
    run(
      async () => {
        const result = await answerGate(gateId!, option);
        if (!result.ok) setChosen(null);
        return result;
      },
      undefined,
      answered(option),
    );
  };
  // The keys act through the card's own handlers, so a key press is exactly a
  // click: the same guard against a second press, and the same line after.
  // Every choice counts, not only those drawn on the face.
  const keys = useRef<CardKeys>({ choose: () => undefined, open: () => undefined });
  keys.current = {
    choose: (n) => {
      const option = gateId ? choices[n - 1] : undefined;
      if (option !== undefined) answer(option);
    },
    open: () => {
      if (group === 'work' && subject.item && onOpenItem) onOpenItem(subject.item, item.bot?.role ?? null);
      else if (more) setOpen(true);
    },
  };
  // Handed over, and scrolled to once selected, as the card is attached: a
  // ref with a cleanup rather than an effect, which the card had none of.
  const scrolled = useRef(false);
  const attach = (node: HTMLElement | null) => {
    if (!node) return;
    if (selected && !scrolled.current) node.scrollIntoView?.({ block: 'nearest' });
    scrolled.current = selected;
    if (!onCards) return;
    onCards(item.id, { choose: (n) => keys.current.choose(n), open: () => keys.current.open() });
    return () => onCards(item.id, null);
  };
  const somethingElseButton = (openBot: OpenBot) =>
    somethingElse?.kind === 'answer' ? (
      <button type="button" className={SOMETHING_ELSE} onClick={() => openBot(somethingElse.bot, { compose: true })}>
        {somethingElse.label}
      </button>
    ) : null;
  // Whom it is for, on a cloud install: "For Legal", or "For everyone: no one holds Legal yet".
  const audience = audienceLine(item);
  const audienceNote = audience && (
    <p data-audience className="text-[11.5px] text-dim">
      {audience}
    </p>
  );
  // Cut to a line on the card; whole in the sheet, which has the room.
  const subjectLine = (wrap: boolean) =>
    (number || subject.title) && (
      <p data-subject className={cn('text-[12.5px] text-soft', wrap ? 'break-words' : 'truncate')}>
        {number && <span className="text-dim">{number} </span>}
        {subject.title}
      </p>
    );
  // One decision, drawn on the card and again, whole, in its sheet: see `PanelState`.
  const panel = usePanelState();
  const decisionPanel = (full: boolean) => (
    <>
      {item.decision && <HumanReviewDecisionPanel item={item} state={panel} full={full} />}
      {item.heldMerge && <HeldMergePanel item={item} state={panel} full={full} />}
      {item.heldPromote && <HeldPromotePanel item={item} state={panel} full={full} />}
    </>
  );
  // The panel says the why the detail would, so neither the card nor its sheet says it twice.
  const showDetail = Boolean(item.detail) && !item.decision && !item.heldMerge && !item.heldPromote;

  // The card's face: its headline, two lines of what happened and the things
  // to press. Everything else is in its sheet. What is cut short is
  // text alone, headline and detail at two lines each; the buttons and an
  // error are never clipped, and wrap where the card is narrow.
  return (
    <article
      ref={attach}
      data-card={item.id}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex min-w-0 gap-3 rounded-[10px] border bg-panel px-3.5 py-3 md:rounded-lg md:px-4 md:py-3.5',
        alarm ? 'border-alarm/35' : 'border-attention/35',
        selected && 'outline outline-2 outline-link',
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
        {audienceNote}
        {subjectLine(false)}
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
        {decision && (
          <p data-decision className="line-clamp-3 text-[12px] leading-normal text-soft">
            {decision}
          </p>
        )}
        {showDetail && (
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
        {decisionPanel(false)}
        {unblocked && (
          // What doing this lets go on: each card behind it opens.
          <p data-unblocks className="text-[12px] leading-normal text-soft">
            {unblocked.lead}:{' '}
            {unblocked.items.map((one, index) => (
              <span key={one.ref}>
                {index > 0 && ', '}
                {onOpenItem ? (
                  <button type="button" title={one.title} onClick={() => onOpenItem(one.ref, null)} className="text-link hover:underline">
                    {one.label}
                  </button>
                ) : (
                  <a href={itemOnBoard(one.ref, null)} title={one.title} className="text-link hover:underline">
                    {one.label}
                  </a>
                )}
              </span>
            ))}
            .
          </p>
        )}
        {gateId && choices.length > 0 && (
          <QuestionChoices
            options={choices.slice(0, CHOICES_ON_CARD)}
            consequences={consequences.slice(0, CHOICES_ON_CARD)}
            pending={pending}
            chosen={chosen}
            onChoose={answer}
            numbered={selected}
          >
            {somethingElseButton(onOpenBot)}
          </QuestionChoices>
        )}
        {(face.length > 0 || more || item.pull) && (
          <div data-face="actions" className="mt-0.5 flex flex-wrap items-center gap-2">
            {/* The pull request's own commands come first, so "Merge it on
                GitHub", which skips a sign-off a red check waits for, is last (#207). */}
            {item.pull && <PullActions subject={`${item.pull.repo}#${item.pull.number}`} />}
            {face.map((action, index) => (
              <ActionButton
                key={`${action.kind}-${index}`}
                action={action}
                // Beside a question's choices nothing is the one to press:
                // approving the rest of the work is not made the easy click.
                // Nor beside a pull request's commands, which come first.
                primary={index === 0 && choices.length === 0 && !item.pull}
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
        {done && <DoneLine done={done} />}
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
            {audienceNote}
            {subjectLine(true)}
            {item.context && (
              <div className="max-h-[50vh] overflow-auto rounded-md border border-edge px-3 py-2.5 text-[12.5px] leading-normal text-body">
                <Markdown text={item.context} />
              </div>
            )}
            {decision && (
              <p data-decision className="text-[12.5px] leading-normal text-soft">
                {decision}
              </p>
            )}
            {showDetail && (
              <div className={cn('text-[12.5px] leading-normal', item.kind === 'question' ? 'rounded-md bg-surface px-2.5 py-2 text-body' : 'text-muted')}>
                <Markdown text={item.detail} className={cn(item.kind === 'question' && standsOut(item.detail) && 'font-semibold')} />
              </div>
            )}
            {/* The card's decision, whole: a sheet never shows less than its card (ADR 0056). */}
            {decisionPanel(true)}
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
              <QuestionChoices options={choices} consequences={consequences} pending={pending} chosen={chosen} onChoose={answer}>
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
                // None on a card no dismissal puts right: a post OpenADLC
                // refused to sign has no acknowledge, and nobody to say it was them.
                thisWasMe={(() => {
                  const dismiss = item.actions.find((action) => action.kind === 'acknowledge');
                  return dismiss ? (
                    <ActionButton action={dismiss} primary={false} pending={pending} active={active} onOpenBot={openFromSheet} run={run} />
                  ) : undefined;
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
            {done && <DoneLine done={done} />}
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
  run: Run;
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
 * What a choice leads to is said under it, and answers nothing: the button
 * still answers with the choice's own words.
 */
function QuestionChoices({
  options,
  consequences = [],
  pending,
  chosen,
  onChoose,
  numbered = false,
  children,
}: {
  options: readonly string[];
  /** What each choice leads to, in the same order; none, or one per choice. */
  consequences?: readonly string[];
  pending: boolean;
  /** The choice being sent, while it is. */
  chosen: string | null;
  onChoose: (option: string) => void;
  /** Each of the first nine says its key, on the card the keyboard has selected. */
  numbered?: boolean;
  /** What follows the choices in their row: the way to say something else. */
  children?: ReactNode;
}) {
  return (
    <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
      {options.map((option, index) => {
        const sending = pending && chosen === option;
        const consequence = consequences.length === options.length ? consequences[index]?.trim() : '';
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
            {numbered && index < 9 && (
              <kbd aria-hidden className="mr-1.5 font-mono text-[11px] text-dim">
                {index + 1}
              </kbd>
            )}
            {consequence ? (
              <span className="flex flex-col gap-0.5">
                <span>{option}</span>
                <span data-consequence className="text-[11.5px] leading-snug text-muted">
                  {consequence}
                </span>
              </span>
            ) : (
              option
            )}
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

/** An action's answer, as the card reads it. */
type Answered = { ok: boolean; error?: string; held?: boolean; ended?: boolean };
/**
 * What the card says a press did. `final` is a question answered: its choices
 * stay off until the card goes. Anything else leaves the card's other buttons
 * as they were, since a folded card's other members may still want them.
 */
type Done = { text: string; final: boolean };
type Said = (result: Answered) => Done | null;
/** Runs a press once at a time, and says what it did from its answer. */
type Run = (work: () => Promise<Answered>, key?: string, said?: Said) => void;

const said =
  (text: string): Said =>
  () => ({ text, final: false });

/**
 * An answer, said by what the bridge answered: one that stopped the task (a
 * refusal, a hand-off or an abandon at the cost cap, work that had landed),
 * one taken that waits, which the card keeps — a plan change approved while
 * another lease holds its paths, a continue a spent monthly cap holds — or one
 * the task goes on with.
 */
const answered =
  (option: string): Said =>
  (result) =>
    result.ended
      ? { text: `Answered: ${option}. The task is stopped; its thread says why.`, final: true }
      : result.held
        ? { text: 'Taken. It waits on other work before it goes on; its thread says what.', final: false }
        : { text: `Answered: ${option}. It goes on from here.`, final: true };

/**
 * What Start it now did, in the bridge's own first line: "Started patch round
 * 3 on #281", or that the round waits for its builder. A bare "Started." read
 * as started for a round that only waited (ADR 0046). Nothing said: asked,
 * and nothing could start it yet.
 */
const startSaid: Said = (result) => {
  const first = ((result as { started?: string[] }).started ?? []).find((line) => line.trim().length > 0)?.trim();
  if (!first) return { text: 'Asked, and it did not start yet; the bridge’s log says why.', final: false };
  const said = `${first[0]!.toUpperCase()}${first.slice(1)}`;
  return { text: /[.!?]$/.test(said) ? said : `${said}.`, final: false };
};

function DoneLine({ done }: { done: Done }) {
  return (
    <p role="status" data-done className="flex items-center gap-1.5 text-[12px] text-signal">
      <CheckIcon size={12} />
      {done.text}
    </p>
  );
}

const BUTTON = 'inline-flex h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[12.5px] md:h-7 md:px-2.5';
const PRIMARY = `${BUTTON} flex-1 bg-body font-medium text-surface transition-colors hover:bg-soft disabled:opacity-60 md:flex-none`;
const SECONDARY = `${BUTTON} border border-edge-strong text-soft transition-colors hover:border-dim hover:text-body disabled:opacity-60`;

/** What only an admin may press on a card: a health check's actions, and a link into Settings or the walkthrough. */
export function adminOnly(action: AttentionAction): boolean {
  if (action.kind === 'recheck' || action.kind === 'acknowledge' || action.kind === 'dismiss') return true;
  // A bot account's keys decide who can sign as the crew: an admin's, as the bridge enforces.
  if (action.kind === 'signing_key_revoke' || action.kind === 'signing_key_dismiss' || action.kind === 'signing_key_undo') return true;
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
  if ('keyId' in action) return `${action.kind}:${action.login}:${action.keyId}`;
  if (action.kind === 'abandon_request') return `${action.kind}:${action.requestId}`;
  if (action.kind === 'dismiss_notice') return `${action.kind}:${action.notice}@${action.occurrence}`;
  if (action.kind === 'start_work' || action.kind === 'resume_item') return `${action.kind}:${action.subject}`;
  if ('gateId' in action) return `${action.kind}:${action.gateId}`;
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
  run: Run;
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
  const press = (work: () => Promise<Answered>, said?: Said) => run(work, key, said);
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
    case 'answer_gate':
    case 'approve':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => answerGate(action.gateId, action.answer), answered(action.answer))}>
          {busy ? 'Sending…' : action.label}
        </button>
      );
    case 'approve_all':
      // Approving one request leaves approve all on for the rest of the work.
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          title="Approves this request, and the builder's later requests on this issue as it asks them, except paths under Human review, until its pull request merges or closes"
          onClick={() => press(() => approveAll(action.gateId))}
        >
          {busy ? 'Approving…' : action.label}
        </button>
      );
    case 'ask_designer':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => askDesigner(action.gateId))}>
          {busy ? 'Asking…' : action.label}
        </button>
      );
    case 'approve_all_off':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => turnOffApproveAll(action.subject))}>
          {busy ? 'Turning off…' : action.label}
        </button>
      );
    case 'retry_triage':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => retryTriage(action.requestId), said('Starting its triage again.'))}>
          {busy ? 'Starting…' : action.label}
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
            press(() => abandonRequest(action.requestId), said('Abandoned.'));
          }}
        >
          {busy ? 'Abandoning…' : action.label}
        </button>
      );
    case 'start_work':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => startItem(action.subject), startSaid)}>
          {busy ? 'Starting…' : action.label}
        </button>
      );
    case 'resume_item':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          // Its answer's `held` is the hold left, null once it goes: not the card's "taken, it waits".
          onClick={() =>
            press(async () => {
              const result = await resumeItem(action.subject);
              return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'could not resume it' };
            }, said('Resumed.'))
          }
        >
          {busy ? 'Resuming…' : action.label}
        </button>
      );
    case 'retry_task':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => retryTask(action.taskId), said('Starting it again.'))}>
          {busy ? 'Starting…' : action.label}
        </button>
      );
    case 'stop_task':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => press(() => (action.taskIds && action.taskIds.length > 1 ? stopTasks(action.taskIds) : stopTask(action.taskId)), said('Stopped.'))}
        >
          {busy ? 'Stopping…' : action.label}
        </button>
      );
    case 'dismiss_task':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => dismissTasks(action.tasks), said('Dismissed.'))}>
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
    case 'dismiss_notice':
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => press(() => dismissDesignMemoryNotice(action.repo, action.issue, action.occurrence), said('Dismissed.'))}
        >
          {busy ? 'Dismissing…' : action.label}
        </button>
      );
    case 'signing_key_revoke':
      // Deleting a key is for keeps, and commits it signed go back to Unverified.
      return (
        <button
          type="button"
          className={style}
          disabled={pending}
          onClick={() => {
            const named = action.title ? `“${action.title}” (id ${action.keyId})` : `key ${action.keyId}`;
            if (!window.confirm(`Revoke ${named} from ${action.login} on GitHub? Commits signed with it read Unverified from then on.`)) return;
            press(() => revokeSigningKey(action.login, action.keyId));
          }}
        >
          {busy ? 'Revoking…' : action.label}
        </button>
      );
    case 'signing_key_dismiss':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => dismissSigningKey(action.login, action.keyId, action.title))}>
          {busy ? 'Dismissing…' : action.label}
        </button>
      );
    case 'signing_key_undo':
      return (
        <button type="button" className={style} disabled={pending} onClick={() => press(() => undismissSigningKey(action.login, action.keyId))}>
          {busy ? 'Undoing…' : action.label}
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
    case 'human_review_approve':
    case 'human_review_reject':
    case 'human_review_discuss':
      // Drawn by the card's decision, each with what it does next (`HumanReviewDecisionPanel`).
      return null;
    case 'held_merge_merge':
    case 'held_merge_leave':
    case 'held_merge_discuss':
    case 'promote_keep_holding':
    case 'promote_discuss':
      // Drawn by the card's decision, each with what it does next (`HeldMergePanel`, `HeldPromotePanel`).
      return null;
  }
}

/** What a held merge's or a held promote's panel is doing: nothing, a message being written, or a Merge's sign-in waiting. */
export type HeldStep = { kind: 'idle' } | { kind: 'discuss'; text: string; role: 'review_lead' | 'implement' } | { kind: 'signing'; flowId: string; userCode: string; verificationUri: string };

/**
 * A decision panel's state, held by its card so the card's copy and its
 * sheet's copy are one decision. Each copy once kept its own: the sheet
 * unmounts when it closes, so a sign-in started there lost its code and its
 * polling, and the card underneath still offered Approve for the same head.
 */
export type PanelState = {
  step: DecisionStep;
  setStep: (step: DecisionStep) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
  done: string | null;
  setDone: (done: string | null) => void;
};

export function usePanelState(initialStep: DecisionStep = { kind: 'idle' }): PanelState {
  const [step, setStep] = useState<DecisionStep>(initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return { step, setStep, busy, setBusy, error, setError, done, setDone };
}

/** What a panel is given: its card's state, or none to keep its own; and whether it is the sheet's whole copy. */
type PanelProps<Step> = {
  item: AttentionItem;
  /** Where it starts when it keeps its own state: idle, or, in a test, a step under way. */
  initialStep?: Step;
  state?: PanelState;
  /** The sheet's copy: reviews whole, and no polling, which the card's copy, still mounted, does. */
  full?: boolean;
};

/** The card's state when it gives one, else the panel's own. Hooks run either way, so their order never changes. */
function usePanel(state: PanelState | undefined, initialStep: DecisionStep | undefined): PanelState {
  const own = usePanelState(initialStep);
  return state ?? own;
}

/** The message box a held decision's Discuss opens: to the lead reviewer or the builder, on the pull request. */
function HeldDiscuss({
  step,
  busy,
  onChange,
  onSend,
  onCancel,
}: {
  step: Extract<HeldStep, { kind: 'discuss' }>;
  busy: boolean;
  onChange: (step: Extract<HeldStep, { kind: 'discuss' }>) => void;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      data-discuss
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <label className="flex items-center gap-1.5 text-soft">
        To
        <select
          value={step.role}
          onChange={(event) => onChange({ ...step, role: event.target.value === 'implement' ? 'implement' : 'review_lead' })}
          className="rounded-md border border-edge-strong bg-panel px-1.5 py-1 text-[12px] text-body"
        >
          <option value="review_lead">the lead reviewer</option>
          <option value="implement">the builder</option>
        </select>
      </label>
      <textarea
        aria-label="Your message"
        value={step.text}
        onChange={(event) => onChange({ ...step, text: event.target.value })}
        className="min-h-16 rounded-md border border-edge-strong bg-panel px-2 py-1.5 text-[12.5px] text-body"
      />
      <div className="flex gap-1.5">
        <button type="submit" disabled={busy || !step.text.trim()} className={PRIMARY}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** One of a held decision's buttons, with what it does next under its label. */
function NextButton({ id, label, next, busy, onPress }: { id: string; label: string; next: string; busy: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      data-decide={id}
      disabled={busy}
      onClick={onPress}
      className="inline-flex min-h-11 items-center rounded-md border border-edge-strong bg-panel px-3 py-2 text-left text-[12.5px] leading-snug text-body transition-colors hover:border-attention/60 hover:bg-attention/10 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60 md:min-h-7 md:px-2.5 md:py-1"
    >
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span data-next className="text-[11.5px] leading-snug text-muted">
          {next}
        </span>
      </span>
    </button>
  );
}

/**
 * A pull request the merge line holds for a person, decided from its card:
 * why it is held, and Merge, Leave it and Discuss, each with what it does
 * next (`heldMerge.next`). Merge is drawn only where the bridge offers it and
 * says the viewer may press it, and the card says why when it is not; the
 * bridge refuses a Merge it would not offer, from anyone. See
 * docs/adr/0037-a-person-merges-a-held-pull-request-from-the-console.md.
 */
export function HeldMergePanel({ item, initialStep, state, full = false }: PanelProps<HeldStep>) {
  const held = item.heldMerge!;
  const buttons = heldMergeButtons(item);
  const noMerge = noMergeReason(held);
  const subject = `${held.repo}#${held.pr}`;
  const { step: anyStep, setStep, busy, setBusy, error, setError, done, setDone } = usePanel(state, initialStep);
  // A held merge never writes a reason; only the approval's panel does.
  const step: HeldStep = anyStep.kind === 'reject' ? { kind: 'idle' } : anyStep;
  const short = held.head?.slice(0, 7) ?? '';

  // A Merge's sign-in, read until the person approves its code or it ends.
  useEffect(() => {
    if (full || step.kind !== 'signing') return;
    const timer = setInterval(() => {
      void fetch(pullPath(subject, `/flows/${encodeURIComponent(step.flowId)}`), { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; error?: string; mergedSha?: string }) => {
          if (said.state === 'waiting') return;
          setStep({ kind: 'idle' });
          if (said.state === 'sent') setDone(`Merged ${short} on GitHub as you${said.mergedSha ? `, as ${said.mergedSha.slice(0, 7)}` : ''}. The card goes once GitHub says so.`);
          // GitHub's refusal, in its words, comes back as the flow's error.
          else if (said.state === 'failed') setError(said.error ?? 'The sign-in ended before anything was merged. Press Merge again.');
          else setError('OpenADLC no longer knows how this sign-in went. Look at the pull request before you press Merge again.');
        })
        .catch(() => undefined);
    }, DECISION_FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [full, step, subject, short, setStep, setDone, setError]);

  const press = (button: HeldMergeButton) => {
    if (busy || done) return;
    setError(null);
    if (button === 'discuss') return setStep({ kind: 'discuss', text: '', role: 'review_lead' });
    setBusy(true);
    if (button === 'leave') {
      void safeAction(() => leaveAttention(item.id)).then((result) => {
        setBusy(false);
        if (!result.ok) return setError(result.error ?? 'It was not taken off Needs you.');
        setDone('Left. It comes back when the pull request changes.');
      });
      return;
    }
    void safeAction(() => mergeHeld(subject, { head: held.head ?? '' })).then((result) => {
      setBusy(false);
      if (!result.ok || !result.flow) return setError(result.error ?? 'The sign-in could not start.');
      setStep({ kind: 'signing', flowId: result.flow.flowId, userCode: result.flow.userCode, verificationUri: result.flow.verificationUri });
    });
  };

  const sendDiscuss = (text: string, role: 'review_lead' | 'implement') => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    const about = held.head ? { kind: 'held_merge' as const, pr: held.pr, head: held.head } : null;
    void safeAction(() => sendItemMessage(subject, { text, role, about })).then((result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'Your message was not sent.');
      setStep({ kind: 'idle' });
      setDone(`Sent to the ${role === 'implement' ? 'builder' : 'lead reviewer'}. It stays held.`);
    });
  };

  const LABEL: Record<HeldMergeButton, string> = { merge: 'Merge', leave: 'Leave it', discuss: 'Discuss' };

  return (
    <div data-held-merge className="flex flex-col gap-2 rounded-md border border-edge bg-surface px-2.5 py-2 text-[12px] leading-snug">
      <p data-why className="text-soft">
        <span className="font-medium text-body">Why it waits for a person: </span>
        {held.why}
      </p>
      {noMerge && (
        <p data-no-merge className="text-muted">
          {noMerge}{' '}
          {held.merge.merge && held.settingsUrl && (
            <Link href={held.settingsUrl} className="text-link hover:underline">
              Link your GitHub account
            </Link>
          )}
        </p>
      )}
      {step.kind === 'idle' && !done && buttons.length > 0 && (
        <div role="group" aria-label="Decision" className="flex flex-wrap gap-1.5">
          {buttons.map((button) => (
            <NextButton key={button} id={button} label={busy && button === 'merge' ? 'Starting…' : LABEL[button]} next={held.next[button]} busy={busy} onPress={() => press(button)} />
          ))}
        </div>
      )}
      {step.kind === 'signing' && (
        <div data-signing className="flex flex-col gap-1.5">
          <p className="text-soft">Approve this code on GitHub as yourself; {short} is merged once you do.</p>
          <DeviceCode code={step.userCode} url={step.verificationUri} />
        </div>
      )}
      {step.kind === 'discuss' && (
        <HeldDiscuss step={step} busy={busy} onChange={setStep} onSend={() => sendDiscuss(step.text, step.role)} onCancel={() => setStep({ kind: 'idle' })} />
      )}
      {done && <DoneLine done={{ text: done, final: true }} />}
      {error && (
        <p role="status" data-error className="text-[12px] text-alarm">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A promote held for a person, decided from its card: what is being
 * released, why it waits for a person, and what Release, Keep holding,
 * Discuss and the switch to automatic each do next. Release and the switch
 * are the card's own buttons, as they were; Keep holding and Discuss are drawn here.
 */
export function HeldPromotePanel({ item, initialStep, state }: PanelProps<HeldStep>) {
  const held = item.heldPromote!;
  const discuss = item.actions.find((action): action is Extract<AttentionAction, { kind: 'promote_discuss' }> => action.kind === 'promote_discuss');
  const keep = item.actions.some((action) => action.kind === 'promote_keep_holding');
  const automatic = item.actions.some((action) => action.kind === 'promote_automatic');
  // A promote's panel has no sign-in to poll: Release is the card's own button.
  const { step, setStep, busy, setBusy, error, setError, done, setDone } = usePanel(state, initialStep);

  const keepHolding = () => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    void safeAction(() => leaveAttention(item.id)).then((result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'It was not taken off Needs you.');
      setDone('Kept held. It comes back when another commit waits for production.');
    });
  };

  const sendDiscuss = (text: string, role: 'review_lead' | 'implement') => {
    if (busy || !text.trim() || !discuss || held.pr === null) return;
    setBusy(true);
    setError(null);
    void safeAction(() => sendItemMessage(discuss.subject, { text, role, about: { kind: 'held_promote', sha: held.sha, pr: held.pr! } })).then((result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'Your message was not sent.');
      setStep({ kind: 'idle' });
      setDone(`Sent to the ${role === 'implement' ? 'builder' : 'lead reviewer'}. The promote stays held.`);
    });
  };

  return (
    <div data-held-promote className="flex flex-col gap-2 rounded-md border border-edge bg-surface px-2.5 py-2 text-[12px] leading-snug">
      <p data-what className="text-body">
        <span className="font-medium">What it releases: </span>
        {held.what}
      </p>
      <p data-why className="text-soft">
        <span className="font-medium text-body">Why it waits for a person: </span>
        {held.why}
      </p>
      <ul data-consequences className="flex flex-col gap-0.5 text-muted">
        <li>
          <span className="font-medium text-body">Release: </span>
          {held.next.release}
        </li>
        {automatic && (
          <li>
            <span className="font-medium text-body">Switch to automatic delivery: </span>
            {held.next.automatic}
          </li>
        )}
      </ul>
      {step.kind === 'idle' && !done && (keep || discuss) && (
        <div role="group" aria-label="Decision" className="flex flex-wrap gap-1.5">
          {keep && <NextButton id="keep" label="Keep holding" next={held.next.keepHolding} busy={busy} onPress={keepHolding} />}
          {discuss && held.next.discuss && <NextButton id="discuss" label="Discuss" next={held.next.discuss} busy={busy} onPress={() => setStep({ kind: 'discuss', text: '', role: 'review_lead' })} />}
        </div>
      )}
      {step.kind === 'discuss' && (
        <HeldDiscuss step={step} busy={busy} onChange={setStep} onSend={() => sendDiscuss(step.text, step.role)} onCancel={() => setStep({ kind: 'idle' })} />
      )}
      {done && <DoneLine done={{ text: done, final: true }} />}
      {error && (
        <p role="status" className="text-[12px] text-alarm">
          {error}
        </p>
      )}
    </div>
  );
}

/** How often an Approve's sign-in is read while it waits for the person to approve its code. */
const DECISION_FLOW_READ_MS = 3_000;

/** What a held Human-review approval's panel is doing: nothing, a reason or message being written, or a sign-in waiting. */
export type DecisionStep =
  | { kind: 'idle' }
  | { kind: 'reject'; reason: string }
  | { kind: 'discuss'; text: string; role: 'review_lead' | 'implement' }
  | { kind: 'signing'; flowId: string; userCode: string; verificationUri: string };

/**
 * A held Human-review approval, decided from its card: what the change does,
 * why this person is asked, what the reviewers found, and Approve, Reject and
 * Discuss, each with what it does next (`decision.next`). Approve and Reject
 * are drawn only for the person it waits on, as the bridge says from their
 * linked account; the bridge refuses them from anyone else, so this only
 * keeps off a button it would refuse. See
 * docs/adr/0036-a-person-decides-a-held-human-review-approval-from-the-console.md.
 */
export function HumanReviewDecisionPanel({ item, initialStep, state, full = false }: PanelProps<DecisionStep>) {
  const decision = item.decision!;
  const buttons = decisionButtons(item);
  const subject = `${decision.repo}#${decision.pr}`;
  const { step, setStep, busy, setBusy, error, setError, done, setDone } = usePanel(state, initialStep);
  const short = decision.head.slice(0, 7);

  // An Approve's sign-in, read until the person approves its code or it ends.
  useEffect(() => {
    if (full || step.kind !== 'signing') return;
    const timer = setInterval(() => {
      void fetch(pullPath(subject, `/flows/${encodeURIComponent(step.flowId)}`), { cache: 'no-store' })
        .then((response) => response.json())
        .then((said: { state: string; error?: string }) => {
          if (said.state === 'waiting') return;
          setStep({ kind: 'idle' });
          if (said.state === 'sent') setDone(`Approved ${short} on GitHub as @${decision.login}. The card goes once GitHub says so.`);
          else if (said.state === 'failed') setError(said.error ?? 'The sign-in ended before anything was posted. Press Approve again.');
          else setError('OpenADLC no longer knows how this sign-in went. Look at the pull request before you press Approve again.');
        })
        .catch(() => undefined);
    }, DECISION_FLOW_READ_MS);
    return () => clearInterval(timer);
  }, [full, step, subject, short, decision.login, setStep, setDone, setError]);

  const press = (button: DecisionButton) => {
    if (busy || done) return;
    setError(null);
    if (button === 'reject') return setStep({ kind: 'reject', reason: '' });
    if (button === 'discuss') return setStep({ kind: 'discuss', text: '', role: 'review_lead' });
    setBusy(true);
    void safeAction(() => approveHumanReview(subject, { head: decision.head, login: decision.login })).then((result) => {
      setBusy(false);
      if (!result.ok || !result.flow) return setError(result.error ?? 'The sign-in could not start.');
      setStep({ kind: 'signing', flowId: result.flow.flowId, userCode: result.flow.userCode, verificationUri: result.flow.verificationUri });
    });
  };

  const sendReject = (reason: string) => {
    if (busy || !rejectReady(reason)) return;
    setBusy(true);
    setError(null);
    void safeAction(() => rejectHumanReview(subject, { head: decision.head, login: decision.login, reason })).then((result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'It was not sent back.');
      setStep({ kind: 'idle' });
      setDone(result.sentBack ? 'Sent back to the builder with your reason.' : `Your reason is on the pull request, but it was not sent back: ${result.why ?? 'the bridge did not say why'}.`);
    });
  };

  const sendDiscuss = (text: string, role: 'review_lead' | 'implement') => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    const about = { kind: 'human_review' as const, repo: decision.repo, pr: decision.pr, login: decision.login, head: decision.head };
    void safeAction(() => sendItemMessage(subject, { text, role, about })).then((result) => {
      setBusy(false);
      if (!result.ok) return setError(result.error ?? 'Your message was not sent.');
      setStep({ kind: 'idle' });
      setDone(`Sent to the ${role === 'implement' ? 'builder' : 'lead reviewer'}. The decision stays open.`);
    });
  };

  const LABEL: Record<DecisionButton, string> = { approve: 'Approve', reject: 'Reject', discuss: 'Discuss' };

  return (
    <div data-decision-panel className="flex flex-col gap-2 rounded-md border border-edge bg-surface px-2.5 py-2 text-[12px] leading-snug">
      {decision.change && (
        <p data-change className="text-body">
          <span className="font-medium">What it does: </span>
          {decision.change}
        </p>
      )}
      <p data-why className="text-soft">
        <span className="font-medium text-body">Why you are asked: </span>
        <MarkdownInline text={decision.why} />
      </p>
      <div data-reviews className="flex flex-col gap-1 text-soft">
        <span className="font-medium text-body">What the reviewers found:</span>
        {decision.reviews && decision.reviews.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {decision.reviews.map((review) => (
              <li key={review.url} data-review>
                <a href={review.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  {reviewerName(review)} {reviewVerdict(review.state)}
                </a>
                {/* Three lines of flowing text on the card; whole, as blocks, in its sheet, which has the room.
                    The summary is the review's markdown, so drawn as text it showed its `**` and `##`. */}
                {review.summary &&
                  (full ? (
                    <div data-summary className="text-muted">
                      <Markdown text={review.summary} />
                    </div>
                  ) : (
                    <span data-summary className="line-clamp-3 text-muted">
                      <MarkdownInline text={review.summary} />
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        ) : (
          <a href={decision.prUrl} target="_blank" rel="noreferrer" className="w-fit text-link hover:underline">
            Read the reviews on GitHub
          </a>
        )}
        <a data-diff href={decision.diffUrl} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1 text-link hover:underline">
          See the diff <ExternalIcon size={11} />
        </a>
      </div>
      {decision.yours !== true && decision.notYours && (
        <p data-not-yours className="text-muted">
          {decision.notYours}{' '}
          {decision.settingsUrl && (
            <Link href={decision.settingsUrl} className="text-link hover:underline">
              Link your GitHub account
            </Link>
          )}
        </p>
      )}
      {step.kind === 'idle' && !done && buttons.length > 0 && (
        <div role="group" aria-label="Decision" className="flex flex-wrap gap-1.5">
          {buttons.map((button) => (
            <button
              key={button}
              type="button"
              data-decide={button}
              disabled={busy}
              onClick={() => press(button)}
              className="inline-flex min-h-11 items-center rounded-md border border-edge-strong bg-panel px-3 py-2 text-left text-[12.5px] leading-snug text-body transition-colors hover:border-attention/60 hover:bg-attention/10 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60 md:min-h-7 md:px-2.5 md:py-1"
            >
              <span className="flex flex-col gap-0.5">
                <span>{busy && button === 'approve' ? 'Starting…' : LABEL[button]}</span>
                <span data-next className="text-[11.5px] leading-snug text-muted">
                  {decision.next[button]}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {step.kind === 'signing' && (
        <div data-signing className="flex flex-col gap-1.5">
          <p className="text-soft">Approve this code as @{decision.login} on GitHub; your approval of {short} is posted once you do.</p>
          <DeviceCode code={step.userCode} url={step.verificationUri} />
        </div>
      )}
      {step.kind === 'reject' && (
        <form
          data-reject
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            sendReject(step.reason);
          }}
        >
          <label className="flex flex-col gap-1 text-soft">
            Why? The builder fixes what you say here.
            <textarea
              required
              maxLength={2000}
              value={step.reason}
              onChange={(event) => setStep({ kind: 'reject', reason: event.target.value })}
              className="min-h-16 rounded-md border border-edge-strong bg-panel px-2 py-1.5 text-[12.5px] text-body"
            />
          </label>
          <div className="flex gap-1.5">
            <button type="submit" disabled={busy || !rejectReady(step.reason)} className={PRIMARY}>
              {busy ? 'Sending back…' : 'Send it back'}
            </button>
            <button type="button" className={SECONDARY} onClick={() => setStep({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {step.kind === 'discuss' && (
        <form
          data-discuss
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            sendDiscuss(step.text, step.role);
          }}
        >
          <label className="flex items-center gap-1.5 text-soft">
            To
            <select
              value={step.role}
              onChange={(event) => setStep({ ...step, role: event.target.value === 'implement' ? 'implement' : 'review_lead' })}
              className="rounded-md border border-edge-strong bg-panel px-1.5 py-1 text-[12px] text-body"
            >
              <option value="review_lead">the lead reviewer</option>
              <option value="implement">the builder</option>
            </select>
          </label>
          <textarea
            aria-label="Your message"
            value={step.text}
            onChange={(event) => setStep({ ...step, text: event.target.value })}
            className="min-h-16 rounded-md border border-edge-strong bg-panel px-2 py-1.5 text-[12.5px] text-body"
          />
          <div className="flex gap-1.5">
            <button type="submit" disabled={busy || !step.text.trim()} className={PRIMARY}>
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button type="button" className={SECONDARY} onClick={() => setStep({ kind: 'idle' })}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {done && <DoneLine done={{ text: done, final: true }} />}
      {error && (
        <p role="status" className="text-[12px] text-alarm">
          {error}
        </p>
      )}
    </div>
  );
}
