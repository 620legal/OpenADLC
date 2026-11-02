import { PROJECT_URL } from '@openadlc/shared';
import type { InFlight } from '@openadlc/db';
import type { Slept } from '../../keep-awake.js';
import type { HealthCheck } from '../types.js';

export interface SleptReader {
  /** The `bridge.slept` events since a moment, newest first. */
  events(since: Date): Promise<{ at: string; payload: unknown }[]>;
  /** Whether this host can be held awake, so the card can offer the switch. */
  available(): boolean;
}

/** How long a sleep stays on the board. */
export const SLEPT_SHOWN_MS = 60 * 60_000;

export const SLEPT_DOC_URL = `${PROJECT_URL}/blob/main/docs/troubleshooting.md#the-machine-slept-while-the-crew-worked`;

/** "47 min", "2 h 5 min", "90 s". */
export function sleptFor(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "2 tasks, 1 merge waiting on CI", from the tick before the sleep. */
export function inFlightWords(counts: InFlight): string {
  const parts: string[] = [];
  if (counts.tasks > 0) parts.push(`${counts.tasks} ${counts.tasks === 1 ? 'task' : 'tasks'}`);
  if (counts.merges > 0) parts.push(`${counts.merges} ${counts.merges === 1 ? 'merge' : 'merges'} waiting on CI`);
  if (counts.deploys > 0) parts.push(`${counts.deploys} ${counts.deploys === 1 ? 'deploy' : 'deploys'} waiting or running`);
  return parts.join(', ') || 'work';
}

/** A moment as ISO and as this host's local time. */
function moment(iso: string): string {
  return `${iso} (${new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} local)`;
}

const KEEP_AWAKE_WORDS: Record<Slept['keepAwake'], string> = {
  off: 'keep-awake is off',
  holding: 'keep-awake was holding; a closed lid or Sleep from the Apple menu still sleeps a Mac',
  unavailable: 'this host cannot be kept awake by OpenADLC',
};

function isSlept(payload: unknown): payload is Slept {
  const value = payload as Partial<Slept> | null;
  return Boolean(value && typeof value.wokeAt === 'string' && typeof value.sleptAt === 'string' && typeof value.seconds === 'number' && value.inFlight);
}

/**
 * The bridge's host slept in the last hour while work was in flight.
 *
 * `KeepAwake` notices a sleep when its timer fires far late while the
 * monotonic clock stood still, and records it as a `bridge.slept` event,
 * which this reads: kept in memory, a restart inside the hour lost the card.
 * It is about something that happened, so it offers Dismiss (`history`) for
 * that sleep, and a later one is a new occurrence. It clears itself an hour
 * after the last sleep. Not the bridge's gap report (ADR 0022), which is the
 * bridge itself down between two starts: a sleep suspends a running bridge,
 * which never restarts.
 */
export function sleptCheck(reader: SleptReader): HealthCheck {
  return {
    id: 'slept',
    proves: 'The bridge’s host did not sleep in the last hour while work was in flight',
    how: 'reads the sleeps the bridge recorded when its timer fired far late while its monotonic clock stood still',
    everyMinutes: 5,
    steps: [],
    history: true,
    async run(now) {
      const events = await reader.events(new Date(now.getTime() - SLEPT_SHOWN_MS));
      const newest = events.map((event) => event.payload).find(isSlept);
      if (!newest) return [{ ok: true }];
      const keepAwake = newest.keepAwake in KEEP_AWAKE_WORDS ? newest.keepAwake : 'unavailable';
      return [
        {
          ok: false,
          severity: 'warning',
          title: `This machine slept for ${sleptFor(newest.seconds)} with work in flight`,
          detail:
            `It slept at ${moment(newest.sleptAt)} and woke at ${moment(newest.wokeAt)}, with ${inFlightWords(newest.inFlight)} in flight, ` +
            `which stopped where they were until it woke: ${KEEP_AWAKE_WORDS[keepAwake]}.`,
          action: reader.available() ? { label: 'Open Settings', href: '/settings#keep-awake' } : { label: 'Read why', url: SLEPT_DOC_URL },
          facts: { occurrence: newest.wokeAt, ...newest },
        },
      ];
    },
  };
}
