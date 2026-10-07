import type { HealthAction } from '@fleetadlc/shared';
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
    how: 'reads GitHub’s own list of what it delivered to the app’s webhook, beside what happened on GitHub that nothing was delivered for',
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
        return [
          failing(
            'GitHub is delivering to a tunnel that has stopped',
            'The address GitHub has was a tunnel that ended with the bridge that raised it, so nothing reaches OpenADLC. ' +
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
