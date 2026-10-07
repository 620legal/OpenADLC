'use client';

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { answerGate, retryTask, sendMessage, stopTask } from '@/app/actions';
import { useRole } from '@/components/app-header';
import { BotAvatar, type AvatarStatus } from '@/components/avatar';
import { CheckIcon, ChevronDownIcon, CloseIcon, ComputerIcon, ExternalIcon, TerminalIcon, WarningIcon } from '@/components/icons';
import type { BotSession, CrewMember, Gate, ModelAccountRef, ThreadView } from '@/lib/api';
import { atStart, botLabel, type BotFacts } from '@/lib/bot-label';
import { cn } from '@/lib/cn';
import { Markdown } from '@/components/markdown';
import { RepoBadge, useRepoColors } from '@/components/repo-badge';
import { roleTitle } from '@/lib/crew';
import { poll, reach } from '@/lib/reach';
import { useDraft } from '@/lib/draft';
import { safeAction } from '@/lib/safe-action';
import { useEventStream } from '@/lib/use-event-stream';
import {
  composerPlaceholder,
  composerTarget,
  groupByItem,
  NO_ITEM,
  modelInWords,
  pinnedTask,
  roundOf,
  standsOut,
  statusOf,
  timeline,
  topicFor,
  topicGroups,
  topicInSentence,
  topicLabel,
  topicsOf,
  type PinnedTask,
  type StatusLine,
  type TimelineEntry,
} from '@/lib/thread';
import type { ThreadTopic } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ComputerTab, TerminalTab, readSessions as sessionsOf } from '@/components/task-computer';
import { itemOnBoard } from '@/components/needs-you';

/**
 * The panel reads through the console's own server, so a request with no answer
 * at all means that server is down or restarting. The stream reconnects on its
 * own and re-reads when it does, so this clears without anyone doing anything.
 */
const CONSOLE_NOT_ANSWERING = 'The console is not answering, so this may be out of date. It catches up when it answers.';

/** The Show list's value for every subject at once. A subject's own ref is never this. */
const EVERYTHING = '*';

/** A subject's name, short enough for the Show list and cut between words; the full one is its title. */
function short(text: string, length = 34): string {
  if (text.length <= length) return text;
  const cut = text.slice(0, length - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > length / 2 ? cut.slice(0, space) : cut).replace(/[\s·]+$/, '')}…`;
}

/**
 * A bot's thread, sliding over the page: who the bot is and what it thinks
 * with, what it is doing now and on what, and the conversation — in sentences,
 * with a question it is waiting on standing out and answerable in one press.
 * Its computer and its terminal are the tabs beside the conversation.
 */
export function ThreadPanel({
  bot,
  member,
  onClose,
  now,
  focusComposer = false,
  initialTab = 'chat',
  extraTabs = [],
}: {
  /** The bot's name, which every address here is made from. */
  bot: string;
  /**
   * What the crew knows about it: whether its account is connected, what it
   * thinks with, and its task now and last. The page reads the crew again
   * while it is open, so this is live.
   */
  member?: CrewMember;
  onClose: () => void;
  /** When the page was read, so a first drawing on the server and in the browser agree. */
  now?: string;
  /** Opened to answer in the person's own words — "Something else…" on a question — so the box takes the cursor. */
  focusComposer?: boolean;
  /**
   * The tab it opens on: `chat`, or `computer` for a seat that is working,
   * where what it is doing is. A tab this person is not offered opens the conversation.
   */
  initialTab?: string;
  /** Tabs of the page that opened it, after its own: the crew page's History and Settings. */
  extraTabs?: readonly { value: string; label: string; content: ReactNode }[];
}) {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ModelAccountRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Kept across a reload, per bot, as the item's box is.
  const [draft, setDraft] = useDraft(`thread:${bot}`);
  /** The subject the person chose; undefined until they choose, which follows the bot's task. */
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const [streamDown, setStreamDown] = useState(false);
  const [clock, setClock] = useState<string | null>(now ?? null);
  const [pending, startTransition] = useTransition();
  // Set at once, where `pending` is set only by the next render: a second
  // Cmd+Enter before then sent the same message twice.
  const sending = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerId = useId();

  // A bot's computer and its terminal are an admin's: the bridge refuses a
  // user its sessions, its screen and a take-over token, so they are not offered.
  const admin = useRole() === 'admin';
  const offered = (value: string): boolean =>
    value === 'chat' || ((value === 'computer' || value === 'terminal') && admin) || extraTabs.some((one) => one.value === value);
  const [tab, setTab] = useState(() => (offered(initialTab) ? initialTab : 'chat'));
  // The session the terminal attaches to, when one was chosen on the computer tab.
  const [attachTo, setAttachTo] = useState<string | null>(null);
  // With one repository every task is in it; with more, "#12" needs saying where.
  const manyRepos = Object.keys(useRepoColors()).length > 1;

  const facts: BotFacts = member ?? thread?.bot ?? { name: bot };
  // The handle, or the role before an account is connected — never the name
  // the bridge addresses it by, which until then is its seat.
  const label = botLabel(facts);
  const task = member?.task ?? null;
  // What is on screen: what the person picked, else the subject of the task
  // the bot is on now, else everything.
  const selected = chosen !== undefined ? chosen : (task?.subjectRef ?? null);

  // The loader reads whatever the filter and the tab currently say, and the
  // stream only ever nudges it, so a subject change and a new message go down
  // one path.
  const subjectRef = useRef<string | null>(null);
  subjectRef.current = selected;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // Only the latest read is drawn. Reads overlap — a new subject, a tab, each
  // stream event — and one for #1 that answered after one for #2 drew #1's
  // conversation under web#2: a reply typed there went to #2, or answered
  // #1's open question.
  const readSeq = useRef(0);
  const reading = useRef<AbortController | null>(null);
  useEffect(() => () => reading.current?.abort(), []);

  const readThread = async (): Promise<void> => {
    const seq = ++readSeq.current;
    const narrowed = subjectRef.current;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    const latest = () => seq === readSeq.current && narrowed === subjectRef.current && !controller.signal.aborted;
    const query = narrowed !== null ? `?subject=${encodeURIComponent(narrowed)}` : '';
    let read: ThreadView;
    try {
      const response = await reach(
        `/api/thread/${encodeURIComponent(bot)}${query}`,
        { cache: 'no-store', signal: controller.signal },
        CONSOLE_NOT_ANSWERING,
      );
      if (!latest()) return;
      if (!response.ok) throw new Error(`Could not load ${label.said}’s thread.`);
      read = (await response.json()) as ThreadView;
    } catch (cause) {
      // Overtaken: the abort is not a failure to show.
      if (!latest()) return;
      throw cause;
    }
    if (latest()) setThread(read);
  };

  const readSessions = async (): Promise<void> => {
    // Refused to a user, and only the admin's tabs show them.
    if (!admin) return;
    // Said on the computer and terminal tabs in place of their empty state,
    // which looked the same as an idle bot.
    try {
      setSessions(await sessionsOf(bot));
      setSessionsError(null);
    } catch (cause) {
      setSessionsError(cause instanceof Error ? cause.message : 'could not read its sessions');
    }
  };

  const load = async (): Promise<void> => {
    try {
      // The thread is read only while the conversation is on screen. The
      // computer and terminal tabs need the sessions and nothing else from
      // here, and going back to the conversation reads it again, so nothing
      // said meanwhile is missed.
      await Promise.all(tabRef.current === 'chat' ? [readThread(), readSessions()] : [readSessions()]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load the thread.');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, selected, tab]);

  /**
   * Subscribes instead of polling.
   *
   * This used to be `setInterval(load, 5000)`: a request every five seconds per
   * open panel whether or not anything had changed, and up to a five second
   * wait to see an answer. The stream sends an event saying *that* something
   * changed and this re-reads. A stream that ends is opened again
   * (`useEventStream`), and its `open` reads whatever arrived while it was down.
   *
   * A stream that has quietly died looks exactly like a bot with nothing to
   * say, so the panel says when it is not connected.
   */
  useEventStream(`/api/thread/${encodeURIComponent(bot)}/stream`, {
    onOpen: () => {
      setStreamDown(false);
      void load();
    },
    onChanged: () => void load(),
    onDown: () => setStreamDown(true),
  });

  // What each model account is called, for "on your xAI subscription".
  useEffect(() => {
    void poll<{ accounts: ModelAccountRef[] }>('/api/model-accounts').then((body) => {
      if (body) setAccounts(body.accounts);
    });
  }, []);

  // "6 min" keeps counting while the panel is open.
  useEffect(() => {
    const tick = () => setClock(new Date().toISOString());
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Escape closes it, unless it is being typed into: a draft, or the terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('textarea, input, select, [contenteditable="true"], .xterm')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread?.messages.length, thread?.openGate?.id]);

  const topics = topicsOf(thread);
  const openGate = thread?.openGate ?? null;
  const status = statusOf({ ...facts, task, engine: member?.engine ?? thread?.bot.engine }, openGate, clock);
  const pinned = pinnedTask(member ?? {}, topics, clock);
  const target = composerTarget({
    openGate,
    selected,
    task,
    lastTask: member?.lastTask ?? null,
    topics,
    said: label.said,
    connected: Boolean(label.handle),
  });
  // Once, as soon as the box can be typed in: before the thread is read it
  // may be about nothing yet, and then it cannot.
  const composed = useRef(false);
  useEffect(() => {
    if (!focusComposer || composed.current || tab !== 'chat' || target.mode === 'none') return;
    composer.current?.focus();
    composed.current = true;
  }, [focusComposer, tab, target.mode]);

  const thinks = member ? modelInWords(member, accounts) : null;
  const heading = label.handle ?? (roleTitle(facts) || label.name);
  const subline = [label.handle ? roleTitle(facts) : 'Not connected yet', thinks].filter(Boolean).join(' · ');

  // The Show list: every subject the thread has, and the one on screen even
  // before the thread has been read.
  const shown =
    selected !== null && !topics.some((topic) => topic.ref === selected) ? [...topics, topicFor(topics, selected, task)!] : topics;
  // A question about another subject than the one on screen is still the one
  // thing to answer, so the panel says where it is.
  const waitingElsewhere =
    task?.waitingOnYou && selected !== null && selected !== task.subjectRef ? topicFor(topics, task.subjectRef, task) : null;

  const entries =
    thread && clock
      ? timeline(thread.messages, {
          now: clock,
          openGate,
          topics,
          botName: label.name,
          showSubjects: selected === null && topics.length > 1,
        })
      : [];

  // Every question the bot has open, on anything, not only the one this view
  // shows: a second request's question was reachable only from the Show list.
  const questions = thread?.openGates ?? (openGate ? [{ ...openGate, subjectRef: selected }] : []);
  // The one this view shows is its card in the conversation below, so the
  // list leaves it out rather than offer it twice.
  const elsewhere = questions.filter((question) => question.id !== openGate?.id);
  const listQuestions = elsewhere.length > 0;

  const sendOnce = (work: () => Promise<{ ok: boolean; error?: string }>): void => {
    if (sending.current) return;
    sending.current = true;
    startTransition(async () => {
      try {
        const result = await safeAction(work);
        if (!result.ok) setError(result.error ?? 'That did not go through.');
        else {
          setDraft('');
          await load();
        }
      } finally {
        sending.current = false;
      }
    });
  };

  const answer = (text: string, gateId = openGate?.id): void => {
    if (!text.trim() || !gateId) return;
    sendOnce(() => answerGate(gateId, text));
  };

  const submit = (text: string): void => {
    if (!text.trim() || target.mode === 'none') return;
    if (target.mode === 'answer') return answer(text);
    sendOnce(() => sendMessage(bot, text, target.subject));
  };

  const avatarStatus: AvatarStatus = status.working ? 'working' : status.tone === 'attention' ? 'waiting' : 'idle';

  return (
    <>
      {/* The page behind, dimmed; pressing it closes the thread, as Escape does. */}
      <div aria-hidden onClick={onClose} className="fixed inset-0 z-30 bg-scrim" />

      <aside
        aria-label={`${label.name}’s thread`}
        className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[540px] flex-col border-l border-edge bg-panel shadow-2xl"
      >
        <div className="flex flex-col gap-3 border-b border-edge px-5 pb-3.5 pt-[18px]">
          <div className="flex items-center gap-3">
            <BotAvatar bot={facts} size="xl" status={avatarStatus} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="truncate text-[15px] font-semibold text-body">{heading}</h2>
              <span className="text-[12px] text-muted">{subline}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-auto inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-well hover:text-body focus-visible:outline-2 focus-visible:outline-link md:size-8"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          <NowCard
            status={status}
            round={roundOf(task)}
            pinned={pinned}
            showRepo={manyRepos}
            failedTaskId={!task && member?.lastTask && (couldNotFinish(member.lastTask) || member.lastTask.endedWithoutPullRequest) ? (member.lastTask.id ?? null) : null}
            // A finished task has nothing left to stop: its Try again goes on from its branch.
            canStop={!member?.lastTask?.endedWithoutPullRequest}
          />
        </div>

        <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-x-3 border-b border-edge px-5">
            <TabsList aria-label="What to see">
              <TabsTrigger value="chat">Conversation</TabsTrigger>
              {admin && (
                <TabsTrigger value="computer">
                  <ComputerIcon />
                  Its computer
                </TabsTrigger>
              )}
              {admin && (
                <TabsTrigger value="terminal">
                  <TerminalIcon />
                  Terminal
                </TabsTrigger>
              )}
              {extraTabs.map((extra) => (
                <TabsTrigger key={extra.value} value={extra.value}>
                  {extra.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tab === 'chat' && (
              <ShowList
                shown={shown}
                selected={selected}
                title={selected !== null ? topicLabel(topicFor(topics, selected, task)!, topics) : 'Everything'}
                onChoose={setChosen}
              />
            )}
          </div>

          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            {/* `*:shrink-0`: a line that clips its overflow would otherwise be squeezed to nothing once the thread is long. */}
            <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 py-4 *:shrink-0">
              {streamDown && (
                <p role="status" className="rounded-md border border-attention/35 bg-attention/10 px-2.5 py-1.5 text-[12px] text-attention">
                  Not updating on its own right now. It reconnects by itself and catches up once the connection is back.
                </p>
              )}
              {error && (
                <p role="alert" className="rounded-md border border-alarm/40 bg-alarm/10 px-2.5 py-1.5 text-[12px] text-alarm">
                  {error}
                </p>
              )}
              {listQuestions && (
                <OpenQuestions
                  questions={elsewhere}
                  total={questions.length}
                  onScreen={Boolean(openGate)}
                  label={(ref) => (ref ? topicLabel(topicFor(topics, ref, task)!, topics) : 'Everything')}
                  selected={selected}
                  pending={pending}
                  onAnswer={(gateId, text) => answer(text, gateId)}
                  onShow={(ref) => setChosen(ref)}
                />
              )}
              {!listQuestions && waitingElsewhere && (
                <button
                  type="button"
                  onClick={() => setChosen(waitingElsewhere.ref)}
                  className="self-start rounded-md border border-attention/40 bg-attention/10 px-2.5 py-1.5 text-left text-[12.5px] text-attention hover:bg-attention/15"
                >
                  {label.name} is waiting for your answer about {topicInSentence(waitingElsewhere)}. Show it
                </button>
              )}
              {!thread && !error && <p className="text-[12.5px] text-dim">Loading…</p>}
              {thread && entries.length === 0 && (
                <p className="text-[12.5px] leading-normal text-dim">
                  {selected !== null
                    ? `Nothing here about ${topicInSentence(topicFor(topics, selected, task)!)} yet.`
                    : `Nothing said yet. ${atStart(label.said)} writes here when it starts work, and asks here when it needs you.`}
                </p>
              )}
              {entries.map((entry) => (
                <Entry
                  key={entry.key}
                  entry={entry}
                  bot={facts}
                  pending={pending}
                  onAnswer={answer}
                  onOwnWords={() => composer.current?.focus()}
                />
              ))}
            </div>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                submit(draft);
              }}
              className="flex flex-col gap-2 border-t border-edge px-5 pb-4 pt-3"
            >
              <label htmlFor={composerId} className="text-[12px] font-medium text-soft">
                Message {label.said}
              </label>
              <textarea
                ref={composer}
                id={composerId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !pending) {
                    event.preventDefault();
                    submit(draft);
                  }
                }}
                rows={2}
                disabled={target.mode === 'none'}
                placeholder={composerPlaceholder(target.mode)}
                className="w-full resize-none rounded-md border border-edge-strong bg-panel px-2.5 py-2 text-[13px] leading-normal text-body placeholder:text-dim focus-visible:outline-2 focus-visible:outline-link disabled:opacity-60"
              />
              <div className="flex items-center gap-2.5">
                <span className="text-[11.5px] leading-snug text-dim">{target.helper}</span>
                <button
                  type="submit"
                  disabled={pending || !draft.trim() || target.mode === 'none'}
                  className="ml-auto inline-flex h-11 shrink-0 items-center rounded-md bg-body px-4 text-[12.5px] font-medium text-surface transition-colors hover:bg-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link disabled:opacity-50 md:h-[30px] md:px-3"
                >
                  {pending ? 'Sending…' : target.mode === 'answer' ? 'Answer' : 'Send'}
                </button>
              </div>
            </form>
          </TabsContent>

          {admin && (
            <TabsContent value="computer" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <ComputerTab
                bot={bot}
                label={label}
                sessions={sessions}
                error={sessionsError}
                onChanged={load}
                onAttach={(name) => {
                  setAttachTo(name);
                  setTab('terminal');
                }}
              />
            </TabsContent>
          )}

          {admin && (
            <TabsContent value="terminal" className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <TerminalTab bot={bot} label={label} sessions={sessions} session={attachTo} error={sessionsError} />
            </TabsContent>
          )}

          {extraTabs.map((extra) => (
            <TabsContent key={extra.value} value={extra.value} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {extra.content}
            </TabsContent>
          ))}
        </Tabs>
      </aside>
    </>
  );
}

const STATUS_TONE: Record<StatusLine['tone'], { text: string; dot: string }> = {
  signal: { text: 'text-signal', dot: 'bg-signal' },
  attention: { text: 'text-attention', dot: 'bg-attention' },
  muted: { text: 'text-soft', dot: 'bg-dim' },
};

/**
 * The subject the conversation shows, or everything. Grouped by repository
 * when the subjects are in more than one: a bot works in any of them, and
 * "#12" twice in one list is two different issues.
 */
export function ShowList({
  shown,
  selected,
  title,
  onChoose,
}: {
  shown: readonly ThreadTopic[];
  selected: string | null;
  title: string;
  onChoose: (subject: string | null) => void;
}) {
  // By work item when the bridge names them: the builder's issue and its pull
  // request are one piece of work. By repository otherwise, as before.
  const byItem = shown.some((topic) => topic.item) ? groupByItem(shown) : null;
  const itemGroups =
    byItem && byItem.some((group) => group.topics.length > 1 || group.item === null)
      ? byItem.map((group) => ({ repo: group.item === null ? NO_ITEM : topicLabel(group.topics.find((one) => one.ref === group.item) ?? group.topics[0]!, shown), topics: group.topics }))
      : null;
  const groups = itemGroups ?? topicGroups(shown);
  const option = (topic: ThreadTopic) => (
    <option key={topic.ref} value={topic.ref}>
      {short(topicLabel(topic, shown))}
    </option>
  );
  return (
    <label className="mb-2 ml-auto flex min-w-0 items-center gap-1.5 text-[12px] text-dim sm:mb-0">
      Show
      <select
        value={selected ?? EVERYTHING}
        onChange={(event) => onChoose(event.target.value === EVERYTHING ? null : event.target.value)}
        title={title}
        className="h-9 min-w-0 max-w-[14rem] rounded-md border border-edge bg-panel px-1.5 text-[12px] text-soft focus-visible:outline-2 focus-visible:outline-link md:h-[26px] md:max-w-[9.5rem]"
      >
        {groups
          ? groups.map((group) => (
              <optgroup key={group.repo ?? ''} label={group.repo ?? 'No repository'}>
                {group.topics.map(option)}
              </optgroup>
            ))
          : shown.map(option)}
        <option value={EVERYTHING}>Everything</option>
      </select>
    </label>
  );
}

/**
 * What the bot is doing now, and on what: "Reviewing · 6 min, round 2 of 3",
 * the issue it is about with its links, and what that task has cost. With no
 * task going, what it did last — and, when OpenADLC works in more than one
 * repository, which one.
 */
function NowCard({
  status,
  round,
  pinned,
  showRepo,
  failedTaskId = null,
  canStop = true,
}: {
  status: StatusLine;
  round: string | null;
  pinned: PinnedTask | null;
  showRepo: boolean;
  /** The last task, when it failed or was stopped under the bot and nothing is going now: what "Try again" and "Stop" act on. */
  failedTaskId?: string | null;
  /** Whether "Stop" is offered beside "Try again": not for a build that finished without its pull request. */
  canStop?: boolean;
}) {
  const tone = STATUS_TONE[status.tone];
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-edge bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1.5 text-[12px] font-medium', tone.text)}>
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', tone.dot, status.working && 'working-dot')} />
          {status.text}
        </span>
        {pinned?.current && round && <span className="text-[12px] text-dim">{round}</span>}
        {showRepo && pinned?.repo && <RepoBadge name={pinned.repo} className="ml-auto" />}
      </div>
      {pinned && (
        <>
          <p className="text-[13.5px] font-medium leading-[1.35] text-body">
            {pinned.did && (
              <span className={cn('font-normal', pinned.did === 'Could not finish' || pinned.did === 'No pull request for' ? 'text-alarm' : 'text-dim')}>{pinned.did} </span>
            )}
            {pinned.number && <span className="font-normal text-dim">{pinned.number} </span>}
            {pinned.title}
            {pinned.when && <span className="font-normal text-dim"> · {pinned.when}</span>}
          </p>
          {(pinned.links.length > 0 || pinned.cost) && (
            <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12px]">
              {pinned.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-link hover:underline"
                >
                  {link.label}
                  <ExternalIcon size={11} />
                </a>
              ))}
              {pinned.cost && (
                <span className="ml-auto text-dim">{pinned.current ? pinned.cost : pinned.cost.replace('this task', 'that task')}</span>
              )}
            </div>
          )}
          {failedTaskId && <FailedTaskControls taskId={failedTaskId} canStop={canStop} />}
        </>
      )}
    </div>
  );
}

/** What its card on the board offers "Try again" and "Stop" for: failed, or stopped by anything but a person. */
function couldNotFinish(task: { state: string; stoppedByAPerson?: boolean }): boolean {
  return task.state === 'failed' || (task.state === 'stopped' && !task.stoppedByAPerson);
}

/**
 * What its card on the board offers for a task that could not finish, here
 * too: run it again, or stop it for good, which lets its lease go and takes
 * the card away. The crew list is read again on the page's next refresh.
 */
function FailedTaskControls({ taskId, canStop = true }: { taskId: string; canStop?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [doing, setDoing] = useState<'retry' | 'stop' | null>(null);
  const [said, setSaid] = useState<{ tone: 'error' | 'done'; text: string } | null>(null);
  const act = (which: 'retry' | 'stop') => {
    setDoing(which);
    setSaid(null);
    startTransition(async () => {
      if (which === 'retry') {
        const result = await safeAction(() => retryTask(taskId));
        setSaid(result.ok ? { tone: 'done', text: 'Started again.' } : { tone: 'error', text: result.error ?? 'that did not go through' });
        return;
      }
      const result = await safeAction(() => stopTask(taskId));
      setSaid(
        result.ok
          ? { tone: 'done', text: result.releasedLease ? 'Stopped, and its lease let go.' : 'Stopped.' }
          : { tone: 'error', text: result.error ?? 'that did not go through' },
      );
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 pt-0.5">
      <Button size="sm" variant="primary" disabled={pending} onClick={() => act('retry')}>
        {pending && doing === 'retry' ? 'Starting…' : 'Try again'}
      </Button>
      {canStop && (
        <Button size="sm" disabled={pending} onClick={() => act('stop')}>
          {pending && doing === 'stop' ? 'Stopping…' : 'Stop'}
        </Button>
      )}
      {said && (
        <span role="status" className={cn('text-[12px]', said.tone === 'error' ? 'text-alarm' : 'text-muted')}>
          {said.text}
        </span>
      )}
    </div>
  );
}

/** A person, as the thread draws them: their initials on the page's ink. */
function PersonAvatar({ name }: { name: string }) {
  const letters = name === 'You' ? 'Y' : name.replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || '?';
  return (
    <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-body text-[10px] font-semibold text-surface">
      {letters}
    </span>
  );
}

const LINE_TONE = { plain: 'text-soft', fail: 'text-alarm', done: 'text-signal' } as const;

function Entry({
  entry,
  bot,
  pending,
  onAnswer,
  onOwnWords,
}: {
  entry: TimelineEntry;
  bot: BotFacts;
  pending: boolean;
  onAnswer: (answer: string) => void;
  /** Takes the person to the box below, where their own words answer the question. */
  onOwnWords: () => void;
}) {
  if (entry.kind === 'day') {
    return (
      <div className="flex items-center gap-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-dim">
        <span aria-hidden className="h-px flex-1 bg-edge" />
        {entry.label}
        <span aria-hidden className="h-px flex-1 bg-edge" />
      </div>
    );
  }

  if (entry.kind === 'subject') {
    // The bot's own view lists what it said about each piece of work; the
    // whole conversation about that work, every role's, is the item's.
    return entry.item ? (
      <a href={itemOnBoard(entry.item, null)} data-item-link={entry.item} className="-mb-1 truncate text-[11.5px] font-medium text-muted hover:text-link hover:underline">
        {entry.label} · open the whole item
      </a>
    ) : (
      <p className="-mb-1 truncate text-[11.5px] font-medium text-muted">{entry.label}</p>
    );
  }

  if (entry.kind === 'line') {
    return (
      <div className={cn('flex gap-2.5 text-[12.5px] leading-normal', LINE_TONE[entry.tone])}>
        <span className="w-9 shrink-0 text-dim">{entry.time}</span>
        <div className="min-w-0">
          <p className="flex items-start gap-1.5">
            {entry.tone === 'fail' && <WarningIcon size={13} className="mt-[3px] shrink-0" />}
            {entry.tone === 'done' && <CheckIcon size={13} className="mt-[3px] shrink-0" />}
            <span>
              {entry.text}
              {entry.url && (
                <>
                  {' '}
                  <a href={entry.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-link hover:underline">
                    on GitHub
                    <ExternalIcon size={10} />
                  </a>
                </>
              )}
            </span>
          </p>
          {entry.note && <Markdown text={entry.note} className="mt-0.5 text-[12px] text-muted" />}
        </div>
      </div>
    );
  }

  const question = entry.question;
  const open = Boolean(question?.open);
  return (
    <div className="flex gap-2.5">
      {entry.who === 'bot' ? <BotAvatar bot={bot} size="chat" status={open ? 'waiting' : 'idle'} /> : <PersonAvatar name={entry.author} />}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[12px] text-dim">
          <span className="font-semibold text-body">{entry.author}</span>
          {entry.time && <> · {entry.time}</>}
          {entry.note && (
            <>
              {' '}
              · <span className={cn(open && 'font-medium text-attention')}>{entry.note}</span>
            </>
          )}
          {entry.url && !open && (
            <>
              {' '}
              ·{' '}
              <a href={entry.url} target="_blank" rel="noreferrer" className="hover:text-link">
                on GitHub
              </a>
            </>
          )}
        </span>
        {open && question ? (
          <QuestionCard
            question={entry.text}
            options={question.options}
            githubUrl={question.githubUrl}
            pending={pending}
            onAnswer={onAnswer}
            onOwnWords={onOwnWords}
          />
        ) : (
          <div
            className={cn(
              'rounded-lg px-3 py-2.5 text-[13px] leading-[1.55] text-body',
              entry.who === 'person' ? 'bg-well' : 'border border-edge bg-surface',
            )}
          >
            <Markdown text={entry.text} className={cn(question && standsOut(entry.text) && 'font-semibold')} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Every question the bot has open, at the top of its thread, each answerable
 * where it is or one click from the subject it is about: "2 waiting for your
 * answer". The thread showed one, the newest, and another request's question
 * could be found only by picking that request from the Show list.
 */
export function OpenQuestions({
  questions,
  total = questions.length,
  onScreen = false,
  label,
  selected,
  pending,
  onAnswer,
  onShow,
  pick,
}: {
  /** The questions to list: every open one but the one on screen. */
  questions: readonly (Gate & { subjectRef: string | null })[];
  /** How many are open in all, the one on screen too. */
  total?: number;
  /** Whether one of them is the question card in the conversation below. */
  onScreen?: boolean;
  label: (ref: string | null) => string;
  selected: string | null;
  pending: boolean;
  onAnswer: (gateId: string, text: string) => void;
  onShow: (ref: string) => void;
  /**
   * In a work item every question is already on screen, so the button picks
   * the question the box below answers instead of showing its subject. The
   * label says which question each is, by the role that asked it.
   */
  pick?: { picked: string | null; onPick: (gateId: string) => void; label: (question: Gate & { subjectRef: string | null }) => string };
}) {
  return (
    <section aria-label="Open questions" className="flex flex-col gap-2 rounded-lg border border-attention/50 bg-attention/5 px-3 py-2.5">
      <p className="text-[12.5px] font-semibold text-attention">
        {total} waiting for your answer
        {onScreen && <span className="font-normal text-muted"> · one is below, in this conversation</span>}
      </p>
      <ul className="flex flex-col gap-2.5">
        {questions.map((question) => (
          <li key={question.id} data-question={question.id} className="flex flex-col gap-1.5 border-t border-attention/20 pt-2 first:border-t-0 first:pt-0">
            <div className="flex items-center gap-2 text-[11.5px] text-dim">
              <span className="truncate">{pick ? pick.label(question) : label(question.subjectRef)}</span>
              {pick && (
                <button
                  type="button"
                  aria-pressed={pick.picked === question.id}
                  onClick={() => pick.onPick(question.id)}
                  className={cn(
                    'ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md border px-3 text-[12.5px] transition-colors focus-visible:outline-2 focus-visible:outline-link md:min-h-8 md:px-2.5',
                    pick.picked === question.id ? 'border-attention/60 bg-attention/15 text-attention' : 'border-edge-strong bg-panel text-link hover:border-link/60',
                  )}
                >
                  {pick.picked === question.id ? 'Answering this' : 'Answer in my own words'}
                </button>
              )}
              {!pick && question.subjectRef && question.subjectRef !== selected && (
                <button
                  type="button"
                  onClick={() => onShow(question.subjectRef!)}
                  className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md border border-edge-strong bg-panel px-3 text-[12.5px] text-link transition-colors hover:border-link/60 focus-visible:outline-2 focus-visible:outline-link md:min-h-8 md:px-2.5"
                >
                  Show it
                </button>
              )}
            </div>
            {/* As the bot wrote it: `snake_case` and code stay what they are. */}
            <div data-question-text className="line-clamp-3 text-[12.5px] leading-snug text-body">
              <Markdown text={question.question} className={cn(standsOut(question.question) && 'font-semibold')} />
            </div>
            {question.options.length > 0 && (
              <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
                {question.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={pending}
                    onClick={() => onAnswer(question.id, option)}
                    className="inline-flex min-h-11 items-center rounded-md border border-edge-strong bg-panel px-3 py-2 text-left text-[12.5px] leading-snug text-body transition-colors hover:border-attention/60 hover:bg-attention/10 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-50 md:min-h-8 md:px-2.5 md:py-1.5"
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The question a bot is waiting on, as a card: the question itself, and its
 * choices as buttons in the order the bot gave them — the likely answer first —
 * each answering it in one press. What the bot found, and why it asks, is its
 * message above.
 *
 * Every question takes the person's own words as well, in the box under the
 * conversation, and a question with choices says so. A free-form question has
 * no choices, so it is the question and that box, nothing else.
 */
export function QuestionCard({
  question,
  options,
  githubUrl,
  pending,
  onAnswer,
  onOwnWords,
}: {
  question: string;
  options: readonly string[];
  githubUrl: string | null;
  pending: boolean;
  onAnswer: (answer: string) => void;
  onOwnWords: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-attention/50 bg-attention/5 px-3 py-2.5 text-[13px] leading-[1.55] text-body">
      <Markdown text={question} className={cn(standsOut(question) && 'font-semibold')} />
      {options.length > 0 && (
        <>
          <div role="group" aria-label="Choices" className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                disabled={pending}
                onClick={() => onAnswer(option)}
                className="inline-flex min-h-11 items-center rounded-md border border-edge-strong bg-panel px-3 py-2 text-left text-[12.5px] leading-snug text-body transition-colors hover:border-attention/60 hover:bg-attention/10 focus-visible:outline-2 focus-visible:outline-link disabled:opacity-50 md:min-h-8 md:px-2.5 md:py-1.5"
              >
                {option}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onOwnWords}
            className="inline-flex min-h-11 items-center gap-1 self-start text-[12px] text-muted transition-colors hover:text-link focus-visible:outline-2 focus-visible:outline-link md:min-h-0"
          >
            Or answer in your own words
            <ChevronDownIcon size={12} />
          </button>
        </>
      )}
      {githubUrl && (
        <a
          href={githubUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 self-start text-[11.5px] text-muted hover:text-link"
        >
          Also asked on GitHub
          <ExternalIcon size={10} />
        </a>
      )}
    </div>
  );
}
