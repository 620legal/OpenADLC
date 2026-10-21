import type { HealthAction } from '@openadlc/shared';
import type { Unheard } from '../../unheard.js';
import type { WebhookStatus } from '../../webhook-setup.js';
import { parseRef } from '../../work.js';
import type { CheckResult, HealthCheck } from '../types.js';
import { stepHref } from '../words.js';

export interface WebhookReader {
  /** What GitHub's hook is set to and what it has delivered; see `WebhookSetup.status`. */
  status(): Promise<WebhookStatus>;
  /** When the bridge last took a delivery from GitHub, or null for never. */
  lastHeard(): Promise<string | null>;
}

const STEP: HealthAction = { label: 'Open the webhook step', href: stepHref('webhook') };

/** How far this machine's clock may be from GitHub's before a delivery and what it was for are misread. */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/** A delivery the bridge took this recently proves GitHub reaches it, whatever the app's own hook says. */
const HEARD_RECENTLY_MS = 48 * 60 * 60 * 1000;

function sentence(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, '');
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** A moment as a card says it: `2026-10-20 09:41 UTC`. */
function utc(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** An error as a card quotes it, mid-sentence. */
function quoted(error: string | null): string {
  return (error ?? '').trim().replace(/[.\s]+$/, '');
}

/** How soon the watch acts, as a card says it. */
function when(status: WebhookStatus): string {
  return status.watch.notBefore ? `at ${utc(status.watch.notBefore)}` : 'within a minute or two';
}

/** How long the watch can take to notice an address that stopped, said wherever a card leans on it. */
const NOTICES = 'It tries the address every five minutes, so it notices one that stopped within about six, and at once when the machine wakes.';

/**
 * What the watch will do about a tunnel whose address GitHub cannot reach, as
 * it knows it (`WebhookStatus.watch`). It said "OpenADLC raises a new tunnel"
 * where it would not: for an address that never answered from here, one that
 * answers from here while GitHub gets 502s, and after a repoint that failed.
 */
function tunnelNext(status: WebhookStatus): string {
  const { watch, revived } = status;
  if (!watch.keeps) return 'OpenADLC did not raise this tunnel, so it does not replace it. Raise a new one on the webhook step.';
  if (revived?.from === status.publicUrl && revived.error) {
    return `OpenADLC raised a new tunnel at ${utc(revived.at)} but could not point the app at it: ${quoted(revived.error)}. It tries again ${when(status)}, waiting longer each time; or raise one now on the webhook step.`;
  }
  if (!watch.answered) {
    return 'That address has never answered from this machine, so OpenADLC cannot tell whether it works and does not replace it on its own. Raise a new one on the webhook step.';
  }
  if (!watch.failingSince) {
    return `It answers from this machine now, so OpenADLC leaves it: it may have come back since, and the next reconcile has GitHub send again what failed. ${NOTICES} If this stays, raise a new one on the webhook step.`;
  }
  const since = `It has not answered from here since ${utc(watch.failingSince)}`;
  if (watch.held === 'github-unreachable') {
    return `${since}, and OpenADLC could not ask GitHub to point the app at a new one. It tries again ${when(status)}; or raise one now on the webhook step.`;
  }
  if (watch.held === 'not-possible') {
    return `${since}, and OpenADLC cannot raise another itself: it needs cloudflared, the app’s private key and the webhook secret. Raise a new one on the webhook step.`;
  }
  if (watch.notBefore) {
    const raisedThis = revived?.to === status.publicUrl ? `OpenADLC raised this tunnel at ${utc(revived.at)} to replace one that had stopped, and waits longer each time before raising another. ` : '';
    return `${since}. ${raisedThis}It raises the next ${when(status)}; or raise one now on the webhook step.`;
  }
  return `${since}; OpenADLC raises a new tunnel ${when(status)}, points the app at it, and has GitHub send again what failed.`;
}

function failing(title: string, detail: string, action: HealthAction = STEP, facts: Record<string, unknown> = {}): CheckResult {
  return { ok: false, severity: 'blocking', title, detail, action, facts };
}

/**
 * What happened on GitHub that the bridge has not heard about since: reconcile
 * found it by reading the repository, and no delivery has arrived after the
 * finding. See `unheard.ts`.
 */
export function stillUnheard(unheard: readonly Unheard[], lastHeard: string | null): Unheard[] {
  const heard = lastHeard ? Date.parse(lastHeard) : Number.NEGATIVE_INFINITY;
  return unheard.filter((entry) => Date.parse(entry.foundAt) > heard);
}

/**
 * GitHub delivers the repository's events here — proven by GitHub's own record
 * of what it delivered, never by the address and the secret being set: both
 * were right on an install GitHub had never sent a thing to, because the app
 * was made with its webhook switched off and no API can switch it on. This is
 * the "hearing" the webhook step asks (`WebhookSetup.status`), kept asking.
 */
export function webhookCheck(reader: WebhookReader): HealthCheck {
  return {
    id: 'webhook',
    proves: 'GitHub delivers the repository’s events to this bridge',
    how: 'reads GitHub’s own list of what it delivered to the app’s webhook and whether the newest reached this bridge, beside what happened on GitHub that nothing was delivered for',
    everyMinutes: 5,
    steps: ['webhook'],
    async run(now) {
      const status = await reader.status();

      // No app key to ask with and no address: the webhook has not been set up,
      // and the walkthrough's step is where that is said.
      if (!status.canAutomate && !status.publicUrl) return [];

      // At start, before the tunnel is back, everything read describes the one
      // that ended with the last bridge. The bridge asks again once it is back.
      if (status.resuming) return [{ ok: null, reason: 'the bridge is bringing its tunnel back' }];

      if (status.stale) {
        // What the watch tried, or will, says more than "it ended with the
        // bridge", which a tunnel whose cloudflared stopped mid-run did not.
        const tried = status.revived?.from === status.publicUrl && status.revived.error ? status.revived : null;
        const willRaise = status.watch.keeps && status.watch.held !== 'not-possible';
        return [
          failing(
            'GitHub is delivering to a tunnel that has stopped',
            tried
              ? `The tunnel at ${status.publicUrl} stopped reaching OpenADLC, and raising a new one at ${utc(tried.at)} failed: ${quoted(tried.error)}. ` +
                  `OpenADLC tries again ${when(status)}, waiting longer each time; or raise one now on the webhook step, and OpenADLC points the app at it.`
              : willRaise
                ? `cloudflared, which served ${status.publicUrl}, has stopped, so nothing reaches OpenADLC. OpenADLC raises a new tunnel ${when(status)} and points the app at it; or raise one now on the webhook step.`
                : 'The address GitHub has was a tunnel that ended with the bridge that raised it, so nothing reaches OpenADLC. ' +
                  'Raise a new one on the webhook step, and OpenADLC points the app at it.',
          ),
        ];
      }

      const lastHeard = await reader.lastHeard().catch(() => null);
      const pending = stillUnheard(status.unheard, lastHeard);
      // What the bridge took itself is the plainest proof there is. An install
      // GitHub reaches through an organization's webhook has nothing on the
      // app's own list and hears everything.
      const hears = Boolean(lastHeard) && now.getTime() - Date.parse(lastHeard ?? '') < HEARD_RECENTLY_MS && pending.length === 0;

      if (!status.publicUrl && !hears) {
        return [
          failing(
            'GitHub has nowhere to deliver to',
            'This bridge has no address GitHub can reach, so the board learns only what OpenADLC reads from GitHub every quarter hour. ' +
              'Give it one on the webhook step.',
          ),
        ];
      }
      if (!status.canAutomate) {
        return hears
          ? [{ ok: true, fixed: 'GitHub is delivering again' }]
          : [{ ok: null, reason: 'OpenADLC does not hold the app’s private key, so it cannot ask GitHub what it delivers' }];
      }
      if (!status.github) return [{ ok: null, reason: 'GitHub could not be asked what the app’s webhook is pointed at' }];

      if (!status.configured && !hears) {
        const elsewhere = Boolean(status.github.url) && status.github.url !== status.webhookUrl;
        return [
          failing(
            elsewhere ? 'GitHub delivers somewhere other than this bridge' : 'The app’s webhook is not set up for this bridge',
            `${sentence(status.detail)}. Point it here from the webhook step, which writes the address and the secret to both sides.`,
          ),
        ];
      }

      if (status.lastDelivery?.statusCode === 401) {
        return [
          failing(
            'OpenADLC refuses what GitHub delivers',
            'GitHub’s last delivery was refused (401): it signs with a secret OpenADLC does not hold. ' +
              'Set the webhook up again from its step, which writes one secret to both sides.',
          ),
        ];
      }

      // GitHub delivers, and its newest delivery to this address never
      // arrived: the address is dead. A Mac woke from sleep with cloudflared
      // still running and its quick tunnel's address gone; every delivery got
      // a 502, and this said ✓ because GitHub listed them. One the bridge took
      // since came another way, an organization's webhook, and says it hears.
      const failed = status.unreached;
      if (failed && !(lastHeard && Date.parse(lastHeard) > Date.parse(failed.deliveredAt))) {
        const answer = `GitHub’s last delivery, at ${utc(failed.deliveredAt)}, ${failed.statusCode === 0 ? 'got no answer' : `got ${failed.statusCode}`}`;
        if (!status.tunnel.running) {
          return [
            failing(
              'GitHub cannot reach this bridge',
              `${answer}: ${status.webhookUrl} does not reach OpenADLC. Whatever serves that address — a proxy, a load balancer, a tunnel of your own — is not passing deliveries to the bridge. ` +
                'Put it right, or give the bridge another address on the webhook step.',
            ),
          ];
        }
        return [
          failing(
            'GitHub cannot reach this bridge through its tunnel',
            `${answer}: ${status.publicUrl} no longer reaches OpenADLC, though cloudflared is still running — as after the machine slept. ${tunnelNext(status)}`,
          ),
        ];
      }

      // GitHub listing a delivery is not the end of it: a switch turned off
      // after it delivered leaves the old deliveries listed for days. What
      // happened after the last delivery, and never arrived, says it stopped.
      const lastDelivered = Math.max(
        status.lastDelivery ? Date.parse(status.lastDelivery.deliveredAt) : Number.NEGATIVE_INFINITY,
        lastHeard ? Date.parse(lastHeard) : Number.NEGATIVE_INFINITY,
      );
      const missed = pending.filter((entry) => Date.parse(entry.happenedAt) > lastDelivered + CLOCK_SLACK_MS);

      if (missed.length > 0 || (status.hearing === 'silent' && pending.length > 0)) {
        const newest = (missed.length > 0 ? missed : pending)[0];
        const ref = newest ? parseRef(newest.subject) : null;
        return [
          failing(
            'GitHub is not sending events to OpenADLC',
            `Open the app’s settings and turn on **Active** under Webhook. ${
              newest?.what === 'opened'
                ? 'GitHub delivered nothing when this was opened; OpenADLC saw it only by reading the repository.'
                : 'OpenADLC found this by reading the repository; GitHub never delivered it.'
            }`,
            status.settingsUrl ? { label: 'Open the app’s settings', url: status.settingsUrl } : STEP,
            newest
              ? { subject: { repo: ref?.repo ?? null, number: ref?.number ?? null, title: newest.title || null, ref: newest.subject, url: newest.url } }
              : {},
          ),
        ];
      }

      if (status.hearing === 'heard' || hears) return [{ ok: true, fixed: 'GitHub is delivering again' }];
      if (status.hearing === 'never') {
        return [{ ok: null, reason: 'nothing has happened on GitHub yet that it would have delivered' }];
      }
      return [{ ok: null, reason: 'GitHub could not be asked what it has delivered' }];
    },
  };
}
