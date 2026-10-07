import { join } from 'node:path';
import { DEFAULT_PORTS, envBool, envInt, envOr, loadYamlFile, costsFileSchema, reviewRulesSchema, type CostsConfig, type ReviewRules } from '@fleetadlc/shared';
import { existsSync } from 'node:fs';
import { readModelPrices } from '@fleetadlc/engines';
import type { IdentityMode } from './identity.js';

export interface BridgeConfig {
  port: number;
  hostdUrl: string;
  organization: string;
  webhookSecret: string;
  gitHubClientId: string;
  /**
   * Which bot's account performs labels, stage moves, reviewer requests and
   * statuses, when an install says so: a seat or a name, from
   * `FLEETADLC_AUTOMATION_BOT`. Null means the bot whose role is `automation`,
   * which is what nearly every install wants. Resolved per call by
   * `automation-bot.ts`, never used as a name directly: the name moves when
   * an account connects.
   */
  automationBot: string | null;
  configRoot: string;
  /**
   * OpenADLC's own checkout, which is where `config/labels.json` and the repository
   * templates are read from. The CLI has had this all along; the bridge needs it
   * now that the last setup step is done from the console instead of a shell.
   */
  repoRoot: string;
  costs: CostsConfig;
  review: ReviewRules;
  /** The install's people, by GitHub login. Members of this list may answer gates. */
  humans: string[];
  /** Where GitHub can reach this bridge, for the webhook the install needs. */
  publicUrl: string;
  /**
   * How the bridge decides who a request is. `iap` verifies the signed
   * assertion; `local` trusts a header, which is only honest for an install
   * reachable from the machine it runs on.
   */
  identityMode: IdentityMode;
  /** The backend service an IAP assertion must be issued for. */
  iapAudience: string;
  /**
   * Deprecated: the testing URL for a repository whose `.github/fleetadlc.yml`
   * and settings name none. Empty means such a repository has no testing
   * environment, and the QA job says so rather than opening a task with
   * nowhere to look.
   */
  testingUrl: string;
  /** Where a notification is posted. Empty means the intent is logged instead. */
  notifyWebhook: string;
  /** Where a notification's link points, so it opens the thread rather than the board. */
  consoleUrl: string;
  /**
   * How many days a processed GitHub delivery is kept in `events`, from
   * `FLEETADLC_EVENT_RETENTION_DAYS`; 0 keeps them for good. The `events` job
   * removes older ones.
   */
  eventRetentionDays: number;
}

/**
 * What a missing config/review.yaml means: the rules the shipped file holds, so
 * an install without the file reviews as one with it does. It must match that
 * file; this copy drifted once and left infra/ without a workflows review and
 * packages/github/ without the security seat, and `config.test.ts` ('the review
 * rules with no config/review.yaml') now fails when either side changes alone.
 * A malformed file is not missing: it stops the bridge at start.
 *
 * By seat, as config/review.yaml names them: a seat stays put when its account
 * connects. One seat is the lead (`lead: true`). Only a revert is reviewed by
 * the lead alone, and not one that touches the security seat's paths or CI; a
 * dependency change (`deps`) gets the security seat.
 */
export const DEFAULT_REVIEW: ReviewRules = reviewRulesSchema.parse({
  reviewers: [
    { seat: 'lead-reviewer', lens: 'lead', lead: true },
    { seat: 'second-reviewer', lens: 'second' },
    {
      seat: 'security-reviewer',
      lens: 'security',
      trigger: { labels: ['touches:security', 'touches:gate', 'safety', 'deps'], paths: ['.github/workflows/', 'packages/github/'], samplePercent: 10 },
    },
    { seat: 'sre', lens: 'workflows', trigger: { paths: ['.github/workflows/', 'docs/runbooks/', 'infra/'] } },
  ],
  maxRounds: 3,
});

export function loadBridgeConfig(): BridgeConfig {
  const configRoot = envOr('FLEETADLC_CONFIG_ROOT', join(process.cwd(), 'config'));
  const repoRoot = envOr('FLEETADLC_REPO_ROOT', process.cwd());
  const costsPath = join(configRoot, 'costs.yaml');
  const reviewPath = join(configRoot, 'review.yaml');
  const webhookSecret = envOr('FLEETADLC_WEBHOOK_SECRET', '');
  // Read for its refusal, not its prices: the sessions charge at them (hostd
  // hands them over), and a malformed file, or a price below 0, stops the
  // bridge here as config/models.example.yaml says, rather than at the first
  // task a session prices wrongly.
  readModelPrices(configRoot);
  const identityMode = identityModeFrom(process.env.FLEETADLC_IDENTITY_MODE);
  // Cloud Run sets K_SERVICE. Local mode there made every name it did not know
  // an admin, so whoever reached the bridge could download every credential
  // through /v1/backup. There is deliberately no way round this.
  if (process.env.K_SERVICE && identityMode === 'local') {
    throw new Error(
      'FLEETADLC_IDENTITY_MODE is local on Cloud Run (K_SERVICE is set): anyone who reaches the bridge would be an admin. Set FLEETADLC_IDENTITY_MODE=iap and FLEETADLC_IAP_AUDIENCE, as infra/gcp does.',
    );
  }

  return {
    publicUrl: envOr('FLEETADLC_PUBLIC_URL', ''),
    port: envInt('FLEETADLC_BRIDGE_PORT', DEFAULT_PORTS.bridge),
    hostdUrl: envOr('FLEETADLC_HOSTD_URL', `http://127.0.0.1:${DEFAULT_PORTS.hostd}`),
    organization: envOr('FLEETADLC_GITHUB_ORG', ''),
    // Empty when unset. That used to mean the signature check was skipped.
    // It does not: an empty value is not a configured secret, and the webhook
    // route refuses the delivery rather than verifying against nothing.
    webhookSecret,
    gitHubClientId: envOr('FLEETADLC_GITHUB_CLIENT_ID', ''),
    automationBot: envOr('FLEETADLC_AUTOMATION_BOT', '').trim() || null,
    configRoot,
    repoRoot,
    costs: existsSync(costsPath)
      ? loadYamlFile(costsPath, costsFileSchema)
      : costsFileSchema.parse({}),
    review: existsSync(reviewPath) ? loadYamlFile(reviewPath, reviewRulesSchema) : DEFAULT_REVIEW,
    humans: envOr('FLEETADLC_HUMANS', '').split(',').map((entry) => entry.trim()).filter(Boolean),
    // Defaults to `local`, because that is what a development install is. A
    // cloud install sets `iap` and is refused at start-up without an audience,
    // rather than verifying signatures and accepting anybody's, and refused
    // above when it would be local on Cloud Run.
    identityMode,
    iapAudience: envOr('FLEETADLC_IAP_AUDIENCE', ''),
    testingUrl: envOr('FLEETADLC_TESTING_URL', ''),
    notifyWebhook: envOr('FLEETADLC_NOTIFY_WEBHOOK', ''),
    // The port `fleetadlc up` gives the console, as the allowed origins read
    // it: a fixed 47300 sent every link of an install on another port to a
    // different install's console.
    consoleUrl: envOr('FLEETADLC_CONSOLE_URL', `http://127.0.0.1:${envInt('FLEETADLC_CONSOLE_PORT', DEFAULT_PORTS.console)}`),
    eventRetentionDays: eventRetentionDaysFrom(process.env.FLEETADLC_EVENT_RETENTION_DAYS),
  };
}

/**
 * `FLEETADLC_EVENT_RETENTION_DAYS` as a whole number of days, 30 when unset.
 * A value nobody meant stops the bridge at start: read as a number, `30d` or
 * `-1` would have pruned every delivery at the next run, or none for good.
 */
export function eventRetentionDaysFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 30;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`FLEETADLC_EVENT_RETENTION_DAYS is ${JSON.stringify(value)}; it must be a whole number of days (0 keeps GitHub deliveries for good), or unset for 30`);
  }
  return Number(value.trim());
}

/**
 * `FLEETADLC_IDENTITY_MODE` as a mode, refusing anything but `iap` and `local`.
 *
 * Anything else used to be read as `local`, so a cloud install set to `IAP`
 * or `iap ` trusted a header anyone who reached the bridge could set, and
 * roles with it, while every page looked as it should. A value nobody meant
 * stops the bridge at start instead. Unset keeps the development default.
 */
export function identityModeFrom(value: string | undefined): IdentityMode {
  if (value === undefined || value === '') return 'local';
  if (value === 'iap' || value === 'local') return value;
  throw new Error(`FLEETADLC_IDENTITY_MODE is ${JSON.stringify(value)}; it must be iap (a cloud install behind IAP) or local, or unset for local`);
}
