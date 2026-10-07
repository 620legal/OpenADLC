import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BOT_ROLES, ENGINES, STAGE_MODES, type StageMode } from './types.js';
import { STAGE_KEYS, mayBeUntouched, normaliseStageMode, stageOffersMode, untouchedRefusal, type StageKey } from './stages.js';
import { BOT_NAME_PATTERN, seatForPersona } from './seats.js';

// An older file's `assist` is read as `autonomous` rather than failing `fleetadlc up`.
const stageModeSchema = z.preprocess((mode) => (typeof mode === 'string' ? normaliseStageMode(mode) : mode), z.enum(STAGE_MODES));

/**
 * A file written before seats named each bot by a persona under `name:`.
 * Read as the seat that persona was — `atlas` is `builder`, `atlas-2` is
 * `builder-2` — so a copy somebody edited keeps seeding the same rows rather
 * than failing `fleetadlc up` on a key it no longer has. Anything else under
 * `name:` is taken as the seat itself.
 *
 * The keys a bot entry no longer has are taken off here, before the schema
 * refuses what it does not read: `name` once it is the seat, and `teams` and
 * `githubLogin`, which every older bots.yaml has and nothing reads.
 */
function seatFromName(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { name, teams: _teams, githubLogin: _login, ...entry } = raw as Record<string, unknown>;
  if (typeof name !== 'string') return name === undefined ? entry : { ...entry, name };
  return entry.slot !== undefined ? entry : { ...entry, slot: seatForPersona(name) ?? name };
}

export const botConfigSchema = z.preprocess(
  seatFromName,
  z.object({
    /**
     * The seat: what this bot is for, as a stable key (`builder`,
     * `lead-reviewer`). The row seeded from this entry is found by it on
     * every `fleetadlc up`, and it is the bot's name until an account connects —
     * after that the name is the account's handle and the seat stays.
     *
     * There is no `githubLogin` any more. Which account a bot is, is decided
     * by the account that connects, and a fresh install reserves none.
     */
    slot: z
      .string()
      .regex(BOT_NAME_PATTERN, 'a seat is lowercase letters, digits and single hyphens, like a GitHub login'),
    displayName: z.string().min(1),
    role: z.enum(BOT_ROLES),
    engine: z.enum(ENGINES),
    model: z.string().min(1),
    skills: z.array(z.string()).default([]),
    // `teams:` was here: the org teams meant to grant a seat its repository
    // role. Nothing read it — OpenADLC invites each bot as a collaborator with
    // the role its seat needs — and a file that still has it parses, since
    // `seatFromName` takes it off before this refuses an unknown key.
    // What each of this seat's task computers is given. Stored on the row and
    // applied to the container; they were parsed and dropped, so every
    // container ran on the driver's own two CPUs and 4 GB.
    cpus: z.number().positive().default(1),
    memoryGb: z.number().positive().default(2),
    /**
     * How many tasks the seat runs at once. Left out, the row keeps what it
     * has — 1 for a new seat, or what a person set in Crew → "tasks at once" —
     * so a console change survives `fleetadlc up`; written here, the file
     * wins at every start, as it does for `cpus`.
     */
    maxTasks: z.number().int().min(1).max(16).optional(),
    sidecarDb: z.boolean().default(false),
  }).strict(),
);
export type BotConfig = z.infer<typeof botConfigSchema>;

export const botsFileSchema = z
  .object({
    bots: z
      .array(botConfigSchema)
      .min(1)
      .refine((bots) => new Set(bots.map((bot) => bot.slot)).size === bots.length, {
        message: 'each bot needs a seat of its own; two entries share one',
      }),
  })
  .strict();

/**
 * What a new repository starts with, whether it was added in the console or
 * seeded from `config/repos.yaml`. Given only when the row is made: a field
 * the file leaves out keeps what the row has.
 */
export const REPO_DEFAULTS: {
  readonly concurrency: number;
  readonly defaultBranch: string;
  readonly stageModes: Readonly<Record<StageKey, StageMode>>;
  readonly specRequiredLabels: readonly string[];
  readonly humanReviewPaths: readonly string[];
} = {
  concurrency: 1,
  defaultBranch: 'main',
  stageModes: {
    intake: 'autonomous',
    spec: 'conditional',
    build: 'autonomous',
    review: 'autonomous',
    merged: 'autonomous',
    done: 'autonomous',
  },
  specRequiredLabels: ['touches:schema', 'touches:contract', 'touches:migration', 'size:large', 'safety'],
  humanReviewPaths: [],
};

/**
 * A repository in `config/repos.yaml`. Its settings have no defaults here: a
 * default filled in by the schema was written over the row at every
 * `fleetadlc up`, so a stage a person set to `untouched` in the console went
 * back to `autonomous`. A field written in the file wins; one left out keeps
 * the row's value, as `maxTasks` does in bots.yaml.
 */
export const repoConfigSchema = z.object({
  name: z.string().min(1),
  fullName: z.string().min(1),
  owner: z.string().min(1),
  concurrency: z.number().int().positive().optional(),
  defaultBranch: z.string().optional(),
  stageModes: z
    .record(z.enum(STAGE_KEYS), stageModeSchema)
    // `untouched` is for intake and spec alone (`UNTOUCHABLE_STAGES`). And
    // `conditional` on a stage every change passes through was taken and
    // decided nothing; the console offers it for Design alone.
    .superRefine((modes, context) => {
      for (const [stage, mode] of Object.entries(modes)) {
        if (mode === 'untouched' && !mayBeUntouched(stage)) context.addIssue({ code: 'custom', path: [stage], message: untouchedRefusal(stage) });
        if (mode && !stageOffersMode(stage as StageKey, mode)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [stage], message: `${mode} is for the spec stage alone` });
        }
      }
    })
    .optional(),
  specRequiredLabels: z.array(z.string()).optional(),
  humanReviewPaths: z.array(z.string()).optional(),
}).strict();
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const reposFileSchema = z
  .object({
    /** Read and not used: nothing is seeded from it, so a file without it loads. */
    organization: z.string().min(1).optional(),
    repos: z.array(repoConfigSchema),
  })
  .strict();

export const costsFileSchema = z.object({
  perTaskCapUsd: z.number().positive().default(15),
  monthlyCapUsd: z.number().positive().default(1500),
  warningAt: z.number().min(0).max(1).default(0.9),
  onCap: z
    .object({
      stopLeasing: z.boolean().default(true),
      pauseReviewsAt: z.number().min(0).max(2).default(1),
      notify: z.array(z.string()).default([]),
    })
    .strict()
    .default({ stopLeasing: true, pauseReviewsAt: 1, notify: [] }),
}).strict();
export type CostsConfig = z.infer<typeof costsFileSchema>;

/**
 * When a reviewer seat is asked: on every pull request, or when a label, a
 * path or a sample puts the pull request in its lens. A pull request's sample
 * is `reviewSample` in the bridge: the same answer every time it is asked.
 */
export const reviewerTriggerSchema = z.union([
  z.literal('always'),
  z.object({
    labels: z.array(z.string()).default([]),
    /** Prefixes: `packages/github/` takes every file under it. */
    paths: z.array(z.string()).default([]),
    samplePercent: z.number().min(0).max(100).default(0),
  }).strict(),
]);
export type ReviewerTrigger = z.infer<typeof reviewerTriggerSchema>;

export const reviewerSeatSchema = z.object({
  /**
   * The seat, as config/bots.yaml names it (`lead-reviewer`), which does not
   * change when an account connects; a name works too.
   */
  seat: z.string().min(1),
  /**
   * What the seat looks at, in a word: `lead`, `second`, `security`, `workflows`. Its review says it.
   * `security` also decides merges: the first seat with it is asked on every change to how CI runs,
   * and its approval is what lets OpenADLC merge one (`mergeDecision`); with no such seat a person
   * merges those changes.
   */
  lens: z.string().min(1),
  /**
   * The one seat that reviews last: once every other seat asked has posted on
   * this diff, it reads them all and the diff, and either sends the work back
   * to build with the findings in one review or approves it.
   */
  lead: z.boolean().default(false),
  /**
   * A seat whose approval a merge needs besides the lead's. Every other seat is
   * advisory: it posts a comment review with its verdict in the marker, and
   * the lead decides. Without this, a non-lead's request for changes would
   * hold GitHub's merge rules against the lead's decision.
   */
  blocking: z.boolean().default(false),
  trigger: reviewerTriggerSchema.default('always'),
}).strict();
export type ReviewerSeat = z.infer<typeof reviewerSeatSchema>;

type LegacyTrigger = 'always' | { labels?: unknown[]; paths?: unknown[]; samplePercent?: number };
type LegacySeat = { seat: string; lens: string; lead?: boolean; trigger: LegacyTrigger };

/**
 * A review.yaml written before reviewers were a list — `lead`, `second`,
 * `security: {bot, labels, paths, samplePercent}`, `workflows: {bot, paths}` —
 * read as the list it means, so an install's edited copy keeps working after
 * an upgrade rather than failing `fleetadlc up`. The lead is the lead; the rest
 * are advisory, which is what every seat but the lead is now. A seat named
 * twice keeps one entry, asked whenever either would have asked it.
 */
export function legacyReviewRules(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const old = raw as Record<string, unknown>;
  if (old.reviewers !== undefined) return raw;
  if (old.lead === undefined && old.second === undefined && old.security === undefined && old.workflows === undefined) return raw;

  const seats: LegacySeat[] = [];
  const add = (entry: LegacySeat) => {
    const same = seats.find((one) => one.seat === entry.seat);
    if (!same) {
      seats.push(entry);
      return;
    }
    if (same.trigger === 'always' || entry.trigger === 'always') {
      same.trigger = 'always';
      return;
    }
    same.trigger = {
      labels: [...new Set([...(same.trigger.labels ?? []), ...(entry.trigger.labels ?? [])])],
      paths: [...new Set([...(same.trigger.paths ?? []), ...(entry.trigger.paths ?? [])])],
      samplePercent: Math.max(same.trigger.samplePercent ?? 0, entry.trigger.samplePercent ?? 0),
    };
  };
  if (typeof old.lead === 'string') add({ seat: old.lead, lens: 'lead', lead: true, trigger: 'always' });
  if (typeof old.second === 'string') add({ seat: old.second, lens: 'second', trigger: 'always' });
  const security = old.security as { bot?: unknown; labels?: unknown; paths?: unknown; samplePercent?: unknown } | undefined;
  if (security && typeof security.bot === 'string') {
    add({
      seat: security.bot,
      lens: 'security',
      trigger: {
        labels: Array.isArray(security.labels) ? security.labels : [],
        paths: Array.isArray(security.paths) ? security.paths : [],
        samplePercent: typeof security.samplePercent === 'number' ? security.samplePercent : 10,
      },
    });
  }
  const workflows = old.workflows as { bot?: unknown; paths?: unknown } | undefined;
  if (workflows && typeof workflows.bot === 'string') {
    add({ seat: workflows.bot, lens: 'workflows', trigger: { paths: Array.isArray(workflows.paths) ? workflows.paths : [] } });
  }
  const { lead: _lead, second: _second, security: _security, workflows: _workflows, ...rest } = old;
  return { ...rest, reviewers: seats };
}

export const reviewRulesSchema = z.preprocess(
  legacyReviewRules,
  z.object({
    reviewers: z
      .array(reviewerSeatSchema)
      .min(1, 'name at least one reviewer, the lead')
      .refine((seats) => seats.filter((seat) => seat.lead).length === 1, {
        message: 'exactly one reviewer is the lead (lead: true): it reviews last and decides',
      })
      .refine((seats) => new Set(seats.map((seat) => seat.seat)).size === seats.length, {
        message: 'each reviewer seat is listed once; give a seat with two lenses one entry',
      }),
    /** Review rounds a pull request may go back to build for before a person is asked. */
    maxRounds: z.number().int().positive().default(3),
    /**
     * Send-backs on the other edges — design to intake, build to design or
     * intake, ship to build. Past either limit the work stays where it is and
     * a person is asked, as a review loop that does not converge is.
     */
    sendBack: z
      .object({
        maxPerEdge: z.number().int().positive().default(2),
        maxPerIssue: z.number().int().positive().default(6),
      })
      .strict()
      .default({ maxPerEdge: 2, maxPerIssue: 6 }),
  }).strict(),
);
export type ReviewRules = z.output<typeof reviewRulesSchema>;

/** The lead reviewer's entry. The schema holds that there is exactly one. */
export function leadReviewer(rules: Pick<ReviewRules, 'reviewers'>): ReviewerSeat {
  const lead = rules.reviewers.find((seat) => seat.lead);
  if (!lead) throw new Error('the review rules name no lead reviewer; set lead: true on one seat in config/review.yaml');
  return lead;
}

/**
 * YAML with no schema, for a caller that checks the shape itself. The skill
 * dry-run harness reads its scenarios this way rather than taking a `zod`
 * dependency it has no other use for.
 */
export function parseYamlFile(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'));
}

/**
 * A config file, read through its schema. A key the schema does not read is
 * refused, and the error names the file and the key: dropped quietly, a
 * misspelt `monthlyCapUSD` seeded the default cap, and a reviewer's
 * `blocked: true` left it advisory with nothing said.
 */
export function loadYamlFile<S extends z.ZodTypeAny>(path: string, schema: S): z.output<S> {
  const raw = readFileSync(path, 'utf8');
  const parsed = schema.safeParse(parseYaml(raw));
  if (!parsed.success) throw new Error(configProblems(path, parsed.error), { cause: parsed.error });
  return parsed.data as z.output<S>;
}

/** Each thing wrong with a config file, one to a line, by the file and the key's path in it. */
function configProblems(path: string, error: z.ZodError): string {
  return error.issues
    .flatMap((issue) =>
      issue.code === z.ZodIssueCode.unrecognized_keys
        ? issue.keys.map((key) => `${path}: ${[...issue.path, key].join('.')} is not a setting OpenADLC reads`)
        : [`${path}: ${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`],
    )
    .join('\n');
}
