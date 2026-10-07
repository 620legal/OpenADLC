import { REPO_DEFAULTS, nextRepoColor, normaliseStageModes, type Repo, type RepoColor, type StageKey, type StageMode } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';
import { audit } from './audit.js';

interface RepoRow {
  id: string;
  name: string;
  full_name: string;
  owner_bot_id: string | null;
  concurrency: number;
  stage_modes: Record<StageKey, StageMode>;
  spec_required_labels: string[];
  human_review_paths: string[];
  default_branch: string;
  color: string;
  removed_at: Date | null;
}

const COLUMNS = `id, name, full_name, owner_bot_id, concurrency, stage_modes,
         spec_required_labels, human_review_paths, default_branch, color, removed_at`;

const SELECT = `
  select ${COLUMNS}
  from repos
`;

export interface RepoRecord extends Repo {
  humanReviewPaths: string[];
  /** A name from `REPO_COLORS`; the console decides what it looks like. */
  color: string;
  /** When it was removed from OpenADLC. Null for a repository OpenADLC works in. */
  removedAt: string | null;
}

function toRepo(row: RepoRow): RepoRecord {
  return {
    id: row.id,
    name: row.name,
    fullName: row.full_name,
    ownerBotId: row.owner_bot_id,
    concurrency: row.concurrency,
    // `assist` reads as `autonomous`; see `normaliseStageMode`.
    stageModes: normaliseStageModes(row.stage_modes),
    specRequiredLabels: row.spec_required_labels,
    humanReviewPaths: row.human_review_paths,
    defaultBranch: row.default_branch,
    color: row.color,
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
  };
}

/**
 * Whether a read sees repositories removed from OpenADLC.
 *
 * It does not unless it asks. A removed repository is one OpenADLC no longer
 * works in, so everything that looks for work — the dispatcher, the sweeps,
 * the merge line, a webhook — finds it no more, exactly as it would find a
 * repository nobody ever added. What reads history asks for it: a thread
 * about one of its issues, or a paused task in it being answered.
 */
export interface RepoReadOptions {
  includeRemoved?: boolean;
}

const ACTIVE = 'removed_at is null';

export async function listRepos(options: RepoReadOptions = {}): Promise<RepoRecord[]> {
  const rows = await query<RepoRow>(`${SELECT} ${options.includeRemoved ? '' : `where ${ACTIVE}`} order by name`);
  return rows.map(toRepo);
}

/**
 * A repository by its name, or by `owner/name`. GitHub's names ignore case, so
 * `owner/name` does too: a delivery names the repository as GitHub spells it,
 * which need not be how it was typed into OpenADLC.
 */
export async function getRepoByName(name: string, options: RepoReadOptions = {}): Promise<RepoRecord | null> {
  const row = await queryOne<RepoRow>(
    `${SELECT} where (name = $1 or lower(full_name) = lower($1)) ${options.includeRemoved ? '' : `and ${ACTIVE}`}`,
    [name],
  );
  return row ? toRepo(row) : null;
}

/** The colours of the repositories OpenADLC works in, for the next one to be given its own. */
async function colorsInUse(): Promise<string[]> {
  const rows = await query<{ color: string }>(`select color from repos where ${ACTIVE}`);
  return rows.map((row) => row.color);
}

interface RepoInput {
  name: string;
  fullName: string;
  ownerBotId: string | null;
  concurrency: number;
  stageModes: Record<string, StageMode>;
  specRequiredLabels: string[];
  humanReviewPaths: string[];
  defaultBranch: string;
}

/** Who the audit log says changed a repository from `config/repos.yaml`. */
export const SEED_ACTOR = 'fleetadlc seed';

/**
 * A repository as `config/repos.yaml` lists it. `name`, `fullName` and the
 * owner are always written; a setting left out of the file is undefined here.
 */
export interface SeedRepoInput {
  name: string;
  fullName: string;
  ownerBotId: string | null;
  concurrency?: number;
  stageModes?: Partial<Record<string, StageMode>>;
  specRequiredLabels?: readonly string[];
  humanReviewPaths?: readonly string[];
  defaultBranch?: string;
}

/** A value as JSON with its keys in order, so two stage maps written in different orders compare equal. */
function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * A repository as `config/repos.yaml` describes it, at every `fleetadlc up`.
 *
 * A setting the file writes wins; one it leaves out keeps the row's value — a
 * person's choice on the console's repository page, or the default the row
 * was made with — as `maxTasks` does in bots.yaml. Every setting used to be
 * written each time, with the schema's defaults for those left out, so a
 * stage set to `untouched` in the console went back to `autonomous` at the
 * next start, and nothing said so. A stage map in the file is merged into the
 * row's, one stage at a time. Each change to a row already here is audited,
 * with the seed as actor.
 *
 * A row found by name whose full name is another's is refused with
 * `RepoNameTaken`: the upsert by name alone rewrote `janedoe/api`, with its
 * issues and tasks, into `acme/api`.
 *
 * Its colour is given once, when the row is new, and a removal made in the
 * console stands: seeding again is not somebody asking to work there again.
 */
export async function upsertRepo(input: SeedRepoInput): Promise<RepoRecord> {
  const found = await queryOne<RepoRow>(`${SELECT} where name = $1`, [input.name]);
  if (!found) {
    const color = nextRepoColor(await colorsInUse());
    const row = await queryOne<RepoRow>(
      `insert into repos (name, full_name, owner_bot_id, concurrency, stage_modes, spec_required_labels, human_review_paths, default_branch, color)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning ${COLUMNS}`,
      [
        input.name,
        input.fullName,
        input.ownerBotId,
        input.concurrency ?? REPO_DEFAULTS.concurrency,
        JSON.stringify({ ...REPO_DEFAULTS.stageModes, ...input.stageModes }),
        [...(input.specRequiredLabels ?? REPO_DEFAULTS.specRequiredLabels)],
        [...(input.humanReviewPaths ?? REPO_DEFAULTS.humanReviewPaths)],
        input.defaultBranch ?? REPO_DEFAULTS.defaultBranch,
        color,
      ],
    );
    if (!row) throw new Error(`failed to upsert repo ${input.name}`);
    return toRepo(row);
  }

  const existing = toRepo(found);
  if (existing.fullName.toLowerCase() !== input.fullName.toLowerCase()) throw new RepoNameTaken(input.fullName, existing);

  const stageModes = input.stageModes ? { ...found.stage_modes, ...input.stageModes } : found.stage_modes;
  const next = {
    fullName: input.fullName,
    ownerBotId: input.ownerBotId,
    concurrency: input.concurrency ?? existing.concurrency,
    stageModes: normaliseStageModes(stageModes),
    specRequiredLabels: input.specRequiredLabels ? [...input.specRequiredLabels] : existing.specRequiredLabels,
    humanReviewPaths: input.humanReviewPaths ? [...input.humanReviewPaths] : existing.humanReviewPaths,
    defaultBranch: input.defaultBranch ?? existing.defaultBranch,
  };
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const field of Object.keys(next) as (keyof typeof next)[]) {
    if (canonical(existing[field]) === canonical(next[field])) continue;
    from[field] = existing[field];
    to[field] = next[field];
  }
  if (Object.keys(to).length === 0) return existing;

  const row = await queryOne<RepoRow>(
    `update repos set
       full_name = $2,
       owner_bot_id = $3,
       concurrency = $4,
       stage_modes = $5,
       spec_required_labels = $6,
       human_review_paths = $7,
       default_branch = $8,
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [
      found.id,
      next.fullName,
      next.ownerBotId,
      next.concurrency,
      JSON.stringify(stageModes),
      next.specRequiredLabels,
      next.humanReviewPaths,
      next.defaultBranch,
    ],
  );
  if (!row) throw new Error(`failed to upsert repo ${input.name}`);
  await audit({
    actor: SEED_ACTOR,
    action: 'repo.seeded',
    target: next.fullName,
    payload: { fields: Object.keys(to), from, to, source: 'config/repos.yaml' },
  });
  return toRepo(row);
}

/**
 * Another repository already goes by this one's name.
 *
 * OpenADLC names a repository by its name alone — `api#12` on a card, in a
 * branch, in every thread — so `acme/api` cannot be added beside `janedoe/api`.
 * Adding it used to overwrite the first one's row, owner and all.
 */
export class RepoNameTaken extends Error {
  constructor(
    readonly wanted: string,
    readonly existing: RepoRecord,
  ) {
    super(
      `OpenADLC already has a repository called ${existing.name} (${existing.fullName}), and names each repository by its name alone, so ${wanted} cannot be added beside it`,
    );
    this.name = 'RepoNameTaken';
  }
}

export type AddOutcome = 'added' | 'restored' | 'already';

/**
 * Starts working in a repository: the walkthrough's step and settings' "Add a
 * repository" both come here.
 *
 * A new one gets the defaults in `input` and the next colour. One already here
 * keeps its settings and its colour — adding it twice is not a way to reset
 * them — and one that was removed comes back with its settings, and with its
 * colour unless another repository was given that colour meanwhile. Either way
 * it is owned by `input.ownerBotId` only when nothing owns it yet:
 * `config/repos.yaml` may have named another bot.
 */
export async function addRepo(
  input: Omit<RepoInput, 'defaultBranch'> & {
    /** GitHub's default branch, or null when GitHub could not be asked: a new row gets `main`, one already here keeps its own. */
    defaultBranch: string | null;
  },
): Promise<{ repo: RepoRecord; outcome: AddOutcome }> {
  const known = await queryOne<RepoRow>(`${SELECT} where lower(full_name) = lower($1)`, [input.fullName]);
  if (known) {
    // Told apart from the repositories it joins, rather than remembered: a
    // colour it gave back when it was removed may be somebody else's now.
    const inUse = known.removed_at ? await colorsInUse() : [];
    const color = inUse.includes(known.color) ? nextRepoColor(inUse) : known.color;
    // Its default branch is GitHub's, which may have been renamed since; the
    // rest of its settings are its own.
    const row = await queryOne<RepoRow>(
      `update repos set
         removed_at = null,
         owner_bot_id = coalesce(owner_bot_id, $2),
         color = $3,
         default_branch = coalesce($4, default_branch),
         updated_at = now()
       where id = $1
       returning ${COLUMNS}`,
      [known.id, input.ownerBotId, color, input.defaultBranch],
    );
    if (!row) throw new Error(`failed to add repo ${input.fullName}`);
    return { repo: toRepo(row), outcome: known.removed_at ? 'restored' : 'already' };
  }

  const namesake = await queryOne<RepoRow>(`${SELECT} where lower(name) = lower($1)`, [input.name]);
  if (namesake) throw new RepoNameTaken(input.fullName, toRepo(namesake));

  const color = nextRepoColor(await colorsInUse());
  const row = await queryOne<RepoRow>(
    `insert into repos (name, full_name, owner_bot_id, concurrency, stage_modes, spec_required_labels, human_review_paths, default_branch, color)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     returning ${COLUMNS}`,
    [
      input.name,
      input.fullName,
      input.ownerBotId,
      input.concurrency,
      JSON.stringify(input.stageModes),
      input.specRequiredLabels,
      input.humanReviewPaths,
      input.defaultBranch ?? 'main',
      color,
    ],
  );
  if (!row) throw new Error(`failed to add repo ${input.fullName}`);
  return { repo: toRepo(row), outcome: 'added' };
}

/**
 * Marks a repository as one OpenADLC no longer works in. Nothing is deleted: its
 * issues, tasks, threads and costs stay as history. Null when there is no such
 * repository; one already removed keeps when it was, so running a removal
 * again, to finish what it could not do the first time, finds it.
 *
 * This is only the mark. Ending the work still going there and taking the
 * crew's access away is the bridge's (`repo-removal.ts`).
 */
export async function removeRepo(name: string): Promise<RepoRecord | null> {
  const row = await queryOne<RepoRow>(
    `update repos set
       removed_at = coalesce(removed_at, now()),
       updated_at = now()
     where name = $1 or full_name = $1
     returning ${COLUMNS}`,
    [name],
  );
  return row ? toRepo(row) : null;
}

/**
 * Settings of a repository OpenADLC works in; null for one it does not,
 * removed or never added. The stages given are merged into the stored ones:
 * the console sends the one stage a person changed, and a map it sent whole
 * was built from what its tab last read, which put back a stage another tab
 * or another admin had changed since.
 */
export async function updateRepoSettings(
  name: string,
  patch: { concurrency?: number; stageModes?: Record<string, StageMode>; color?: RepoColor; defaultBranch?: string },
): Promise<RepoRecord | null> {
  const row = await queryOne<RepoRow>(
    `update repos set
       concurrency = coalesce($2, concurrency),
       stage_modes = coalesce(stage_modes, '{}'::jsonb) || coalesce($3::jsonb, '{}'::jsonb),
       color = coalesce($4, color),
       default_branch = coalesce($5, default_branch),
       updated_at = now()
     where name = $1 and ${ACTIVE}
     returning ${COLUMNS}`,
    [name, patch.concurrency ?? null, patch.stageModes ? JSON.stringify(patch.stageModes) : null, patch.color ?? null, patch.defaultBranch ?? null],
  );
  return row ? toRepo(row) : null;
}

/**
 * Stores the default branch GitHub reports for a repository OpenADLC works
 * in; the reconcile's correction. Null when there is no such repository.
 */
export async function setDefaultBranch(fullName: string, branch: string): Promise<RepoRecord | null> {
  const row = await queryOne<RepoRow>(
    `update repos set
       default_branch = $2,
       updated_at = now()
     where lower(full_name) = lower($1) and ${ACTIVE}
     returning ${COLUMNS}`,
    [fullName, branch],
  );
  return row ? toRepo(row) : null;
}

/** What GitHub's plan refused on a repository, and the state it refused it under. */
export interface PlanLimits {
  limits: { name: string; detail: string }[];
  private: boolean;
  rulesetsRefused: boolean;
  recordedAt: string;
}

export async function getPlanLimits(repoFullName: string): Promise<PlanLimits | null> {
  const row = await queryOne<{ limits: { name: string; detail: string }[]; private: boolean; rulesets_refused: boolean; recorded_at: Date }>(
    'select limits, private, rulesets_refused, recorded_at from repo_plan_limits where repo_full_name = $1',
    [repoFullName],
  );
  return row
    ? { limits: row.limits, private: row.private, rulesetsRefused: row.rulesets_refused, recordedAt: row.recorded_at.toISOString() }
    : null;
}

/** Records what the plan refused, replacing what was there; nothing refused clears it. */
export async function setPlanLimits(
  repoFullName: string,
  input: { limits: { name: string; detail: string }[]; private: boolean; rulesetsRefused: boolean },
): Promise<void> {
  if (input.limits.length === 0) {
    await clearPlanLimits(repoFullName);
    return;
  }
  await query(
    `insert into repo_plan_limits (repo_full_name, limits, private, rulesets_refused)
     values ($1, $2, $3, $4)
     on conflict (repo_full_name) do update set
       limits = excluded.limits, private = excluded.private,
       rulesets_refused = excluded.rulesets_refused, recorded_at = now()`,
    [repoFullName, JSON.stringify(input.limits), input.private, input.rulesetsRefused],
  );
}

/** Forgets what the plan refused, so the next apply asks GitHub again. True when there was something. */
export async function clearPlanLimits(repoFullName: string): Promise<boolean> {
  const rows = await query<{ repo_full_name: string }>(
    'delete from repo_plan_limits where repo_full_name = $1 returning repo_full_name',
    [repoFullName],
  );
  return rows.length > 0;
}

/**
 * How a repository ships when it says so here rather than in its own
 * `.github/fleetadlc.yml`, and where its testing environment is served; see
 * `migrations/0033_repo_delivery.sql`. Null is "not said here".
 */
export interface RepoDelivery {
  /** As stored; the bridge checks it against `deliveryRulesSchema` before it trusts it. */
  deliveryRules: unknown | null;
  testingUrl: string | null;
}

export async function getDelivery(repoId: string): Promise<RepoDelivery> {
  const row = await queryOne<{ delivery_rules: unknown | null; testing_url: string | null }>(
    'select delivery_rules, testing_url from repos where id = $1',
    [repoId],
  );
  return { deliveryRules: row?.delivery_rules ?? null, testingUrl: row?.testing_url ?? null };
}

/** Writes what is given; a field left out keeps what it had, and null clears it. */
export async function setDelivery(repoId: string, input: { deliveryRules?: unknown | null; testingUrl?: string | null }): Promise<void> {
  if (input.deliveryRules !== undefined) {
    await query('update repos set delivery_rules = $2, updated_at = now() where id = $1', [
      repoId,
      input.deliveryRules === null ? null : JSON.stringify(input.deliveryRules),
    ]);
  }
  if (input.testingUrl !== undefined) {
    await query('update repos set testing_url = $2, updated_at = now() where id = $1', [repoId, input.testingUrl]);
  }
}

/**
 * How a repository's production ships, as recorded when it was set up; see
 * `migrations/0047_repo_production_choice.sql`. `approval` is null while
 * nobody has been asked. It fills what the delivery rules leave out.
 */
export interface ProductionChoice {
  approval: 'reviewers' | 'auto' | null;
  soakMinutes: number | null;
  /** Who approves, by GitHub login, when `approval` is `reviewers`. */
  reviewers: string[];
}

export async function getProductionChoice(repoId: string): Promise<ProductionChoice> {
  const row = await queryOne<{ production_approval: string | null; production_soak_minutes: number | null; production_reviewers: string[] | null }>(
    'select production_approval, production_soak_minutes, production_reviewers from repos where id = $1',
    [repoId],
  );
  const approval = row?.production_approval === 'reviewers' || row?.production_approval === 'auto' ? row.production_approval : null;
  return { approval, soakMinutes: row?.production_soak_minutes ?? null, reviewers: row?.production_reviewers ?? [] };
}

/** Records the choice, all of it: what is not given is cleared, not kept. */
export async function setProductionChoice(
  repoId: string,
  choice: { approval: 'reviewers' | 'auto'; soakMinutes: number; reviewers: readonly string[] },
): Promise<void> {
  await query(
    `update repos set production_approval = $2, production_soak_minutes = $3, production_reviewers = $4, updated_at = now() where id = $1`,
    [repoId, choice.approval, choice.soakMinutes, [...choice.reviewers]],
  );
}
