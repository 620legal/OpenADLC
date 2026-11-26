'use client';

import Link from 'next/link';
import type { CrewMember } from '@/lib/api';
import { cn } from '@/lib/cn';
import { crewState, inPipelineOrder, RECONNECT_GITHUB, roleTitle } from '@/lib/crew';
import { bubbleText, deskLabel, deskName, deskOpens, deskTask, officePose, type OfficePose } from '@/lib/crew-office';
import type { SeatOpener } from '@/components/seat-controls';

/**
 * The crew as an office: one desk per bot, in pipeline order, each character
 * posed by its state. It is for delight, and for the crew's state at a glance;
 * the cards and the table say the same and more.
 *
 * The art is drawn here, in plain SVG shapes coloured only by theme tokens, so
 * it follows light and dark with the rest of the console. Each pose differs by
 * shape, not by colour or motion alone: with reduced motion set the
 * animations stop (`globals.css`) and the poses still tell the states apart.
 * The drawing is hidden from screen readers; each desk's group carries the
 * same information as its name.
 */
export function CrewOffice({
  crew,
  now,
  admin,
  onOpenItem,
  onOpenSeat,
}: {
  crew: readonly CrewMember[];
  now: string;
  admin: boolean;
  /** Opens a work item on the board, on the seat's role. */
  onOpenItem: (item: string, role: string) => void;
  onOpenSeat: SeatOpener;
}) {
  return (
    <ul data-crew-office className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {inPipelineOrder(crew).map((bot) => (
        <Desk key={bot.name} bot={bot} now={now} admin={admin} onOpenItem={onOpenItem} onOpenSeat={onOpenSeat} />
      ))}
    </ul>
  );
}

function Desk({
  bot,
  now,
  admin,
  onOpenItem,
  onOpenSeat,
}: {
  bot: CrewMember;
  now: string;
  admin: boolean;
  onOpenItem: (item: string, role: string) => void;
  onOpenSeat: SeatOpener;
}) {
  const state = crewState(bot);
  const pose = officePose(state);
  const name = deskLabel(bot);
  const task = deskTask(bot, now);
  const open = (): void => {
    const target = deskOpens(bot);
    if ('item' in target) onOpenItem(target.item, target.role);
    else onOpenSeat(target.seat, 'chat');
  };

  return (
    <li data-desk={bot.name} data-pose={pose} className={cn('rounded-lg border border-edge bg-panel px-4 py-3', pose === 'empty' && 'opacity-60')}>
      <div role="group" aria-label={deskName(bot, now)} className="flex flex-col items-center gap-2">
        <div className="relative w-full">
          {pose === 'busy' && task && (
            <p data-bubble title={task} className="absolute left-1/2 top-0 z-10 max-w-[90%] -translate-x-1/2 truncate rounded-md border border-edge-strong bg-surface px-2 py-0.5 text-[11.5px] text-soft">
              {bubbleText(task)}
            </p>
          )}
          {pose === 'hand-up' || pose === 'stopped' ? (
            <button
              type="button"
              onClick={open}
              aria-label={pose === 'hand-up' ? `Answer ${name}'s question` : `Open what ${name} needs attention for`}
              className="block w-full rounded-md focus-visible:outline-2 focus-visible:outline-link hover:bg-well"
            >
              <DeskArt pose={pose} />
            </button>
          ) : (
            <DeskArt pose={pose} />
          )}
        </div>
        <button type="button" onClick={() => onOpenSeat(bot.name)} className="max-w-full truncate text-sm font-semibold text-body hover:underline">
          {name}
        </button>
        <span className="text-[12px] text-muted">
          {roleTitle(bot) || 'Bot'}
          {pose === 'stopped' && <span className="text-attention"> · needs attention</span>}
          {pose === 'hand-up' && <span className="text-attention"> · waiting for your answer</span>}
        </span>
        {pose === 'empty' && admin && (
          <Link href={RECONNECT_GITHUB} className="text-[12.5px] text-link hover:underline">
            Connect its account
          </Link>
        )}
      </div>
    </li>
  );
}

/**
 * One drawing per pose, on a 120 by 90 view box: a desk across the bottom, a
 * screen on it, a chair, and the figure behind the desk.
 *
 * - rest: upright, hands on the desk, the screen dark.
 * - busy: leaning in to a lit screen, hands on the keys.
 * - hand-up: one arm raised high.
 * - stopped: head down on the desk, an octagon beside it.
 * - empty: no figure, the chair pushed out.
 */
function DeskArt({ pose }: { pose: OfficePose }) {
  return (
    <svg data-desk-art viewBox="0 0 120 90" aria-hidden="true" focusable="false" className="mx-auto mt-5 block h-auto w-full max-w-[220px]">
      {/* The chair: behind the figure, pushed out to the left when nobody sits in it. */}
      <g className="fill-well stroke-edge-strong" strokeWidth={1.5}>
        {pose === 'empty' ? (
          <>
            <rect x={14} y={30} width={22} height={30} rx={4} />
            <line x1={25} y1={60} x2={25} y2={78} />
            <line x1={16} y1={80} x2={34} y2={80} />
          </>
        ) : (
          <rect x={34} y={26} width={30} height={34} rx={5} />
        )}
      </g>

      {pose !== 'empty' && <Figure pose={pose} />}

      {/* The screen, lit while the bot works. */}
      <g strokeWidth={1.5} className="stroke-edge-strong">
        <rect x={68} y={32} width={34} height={24} rx={2} className={cn(pose === 'busy' ? 'fill-signal office-busy' : 'fill-well')} />
        <line x1={85} y1={56} x2={85} y2={62} />
      </g>

      {/* The desk. */}
      <rect x={6} y={62} width={108} height={6} rx={1.5} className="fill-panel stroke-edge-strong" strokeWidth={1.5} />
      <line x1={14} y1={68} x2={14} y2={88} className="stroke-edge-strong" strokeWidth={1.5} />
      <line x1={106} y1={68} x2={106} y2={88} className="stroke-edge-strong" strokeWidth={1.5} />

      {pose === 'stopped' && (
        <g data-mark="stop">
          <polygon points="18,40 24,40 28,44 28,50 24,54 18,54 14,50 14,44" className="fill-alarm" />
          <rect x={17} y={46} width={8} height={2} className="fill-panel" />
        </g>
      )}
    </svg>
  );
}

function Figure({ pose }: { pose: Exclude<OfficePose, 'empty'> }) {
  const line = 'stroke-soft';
  if (pose === 'stopped') {
    // Slumped: the head down on the desk, the arms folded under it.
    return (
      <g data-figure>
        <path d="M38 62 Q40 46 50 44 Q60 46 62 62 Z" className="fill-muted" />
        <circle cx={54} cy={55} r={8} className="fill-soft" />
        <line x1={40} y1={60} x2={64} y2={60} className={line} strokeWidth={3} strokeLinecap="round" />
      </g>
    );
  }
  if (pose === 'busy') {
    // Leaning in to the screen, the hands forward on the keys.
    return (
      <g data-figure>
        <path d="M40 62 Q42 38 54 36 Q62 38 62 62 Z" className="fill-muted" />
        <circle cx={60} cy={28} r={8} className="fill-soft" />
        <g className="office-busy">
          <line x1={56} y1={44} x2={74} y2={60} className={line} strokeWidth={3} strokeLinecap="round" />
          <line x1={50} y1={46} x2={68} y2={60} className={line} strokeWidth={3} strokeLinecap="round" />
        </g>
      </g>
    );
  }
  if (pose === 'hand-up') {
    // Upright, one arm straight up with the hand open.
    return (
      <g data-figure>
        <path d="M38 62 Q38 38 49 36 Q60 38 60 62 Z" className="fill-muted" />
        <circle cx={49} cy={26} r={8} className="fill-soft" />
        <line x1={58} y1={44} x2={62} y2={60} className={line} strokeWidth={3} strokeLinecap="round" />
        <g className="office-wave">
          <line x1={40} y1={42} x2={34} y2={12} className={line} strokeWidth={3} strokeLinecap="round" />
          <circle cx={33} cy={9} r={4} className="fill-attention" />
        </g>
      </g>
    );
  }
  // At rest: upright, both hands resting flat on the desk.
  return (
    <g data-figure>
      <path d="M38 62 Q38 38 49 36 Q60 38 60 62 Z" className="fill-muted" />
      <circle cx={49} cy={26} r={8} className="fill-soft" />
      <line x1={40} y1={44} x2={38} y2={61} className={line} strokeWidth={3} strokeLinecap="round" />
      <line x1={58} y1={44} x2={60} y2={61} className={line} strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}
