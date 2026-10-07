import { query, queryOne } from '../client.js';

/**
 * A repository's design memory: the curated summary of its decisions,
 * constraints, conventions and words that the design stage is given on every
 * task (migration 0030). The ADRs in the repository are the record; this is
 * what a person can read in Settings and correct.
 */

export const DESIGN_MEMORY_KINDS = ['decision', 'constraint', 'convention', 'glossary'] as const;
export type DesignMemoryKind = (typeof DESIGN_MEMORY_KINDS)[number];
export const DESIGN_MEMORY_STATES = ['proposed', 'accepted', 'superseded', 'retired'] as const;
export type DesignMemoryState = (typeof DESIGN_MEMORY_STATES)[number];

export interface DesignMemoryEntry {
  id: string;
  repoId: string;
  kind: DesignMemoryKind;
  title: string;
  body: string;
  state: DesignMemoryState;
  supersedes: string | null;
  sourceSubject: string | null;
  sourceUrl: string | null;
  /** The design task whose signed comment proposed it (migration 0090); null for one proposed before. */
  sourceTask: string | null;
  adrPath: string | null;
  proposedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  kind: DesignMemoryKind;
  title: string;
  body: string;
  state: DesignMemoryState;
  supersedes: string | null;
  source_subject: string | null;
  source_url: string | null;
  source_task: string | null;
  adr_path: string | null;
  proposed_by: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, repo_id, kind, title, body, state, supersedes, source_subject, source_url, source_task, adr_path,
         proposed_by, decided_by, decided_at, created_at, updated_at`;

function toEntry(row: Row): DesignMemoryEntry {
  return {
    id: row.id,
    repoId: row.repo_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    state: row.state,
    supersedes: row.supersedes,
    sourceSubject: row.source_subject,
    sourceUrl: row.source_url,
    sourceTask: row.source_task ?? null,
    adrPath: row.adr_path,
    proposedBy: row.proposed_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * Proposes what a design comment names. The same title from the same issue
 * is one entry: a design posted again (a second round, a webhook delivered
 * twice) updates its proposal rather than adding a second, and one already
 * decided is left as it was decided. `task` is the design task whose signed
 * comment it is, and `by` its seat.
 */
export async function propose(
  repoId: string,
  entries: readonly { kind: DesignMemoryKind; title: string; body: string; supersedes?: string | null }[],
  source: { subject: string; url: string | null; by: string | null; task: string },
): Promise<DesignMemoryEntry[]> {
  const saved: DesignMemoryEntry[] = [];
  for (const entry of entries) {
    const supersedes = entry.supersedes ? await resolveSupersedes(repoId, entry.supersedes) : null;
    const updated = await queryOne<Row>(
      `update design_memory set kind = $4, body = $5, supersedes = $6, source_url = coalesce($7, source_url),
              source_task = $8, proposed_by = coalesce($9, proposed_by), updated_at = now()
        where repo_id = $1 and source_subject = $2 and lower(title) = lower($3) and state = 'proposed'
        returning ${COLUMNS}`,
      [repoId, source.subject, entry.title, entry.kind, entry.body, supersedes, source.url, source.task, source.by],
    );
    if (updated) {
      saved.push(toEntry(updated));
      continue;
    }
    const inserted = await queryOne<Row>(
      `insert into design_memory (repo_id, kind, title, body, supersedes, source_subject, source_url, proposed_by, source_task)
       select $1, $2, $3, $4, $5, $6, $7, $8, $9
        where not exists (
          select 1 from design_memory where repo_id = $1 and source_subject = $6 and lower(title) = lower($3))
       returning ${COLUMNS}`,
      [repoId, entry.kind, entry.title, entry.body, supersedes, source.subject, source.url, source.by, source.task],
    );
    if (inserted) saved.push(toEntry(inserted));
  }
  return saved;
}

/** What an entry supersedes, named by its id or by the title of an entry in effect. */
async function resolveSupersedes(repoId: string, named: string): Promise<string | null> {
  const row = isUuid(named)
    ? await queryOne<{ id: string }>('select id from design_memory where repo_id = $1 and id = $2', [repoId, named])
    : await queryOne<{ id: string }>(
        `select id from design_memory where repo_id = $1 and lower(title) = lower($2) and state = 'accepted'
          order by created_at desc limit 1`,
        [repoId, named],
      );
  return row?.id ?? null;
}

/**
 * Accepts what a design task proposed on an issue, as `decidedBy` decided
 * it, and marks superseded what each accepted entry supersedes. Only entries
 * a design task proposed (`source_task`): one from before that was recorded
 * waits for a person in Settings. `only` narrows it to one task's entries, or
 * to the ids one comment proposed. Returns what was accepted and what it
 * superseded, which the bridge says out loud.
 */
export async function acceptFor(
  repoId: string,
  sourceSubjects: readonly string[],
  decidedBy: string,
  only: { sourceTask?: string; ids?: readonly string[] } = {},
): Promise<{ accepted: DesignMemoryEntry[]; superseded: DesignMemoryEntry[] }> {
  if (sourceSubjects.length === 0) return { accepted: [], superseded: [] };
  const rows = await query<Row>(
    `update design_memory set state = 'accepted', decided_by = $3, decided_at = now(), updated_at = now()
      where repo_id = $1 and source_subject = any($2::text[]) and state = 'proposed' and source_task is not null
        and ($4::uuid is null or source_task = $4::uuid)
        and ($5::uuid[] is null or id = any($5::uuid[]))
      returning ${COLUMNS}`,
    [repoId, [...sourceSubjects], decidedBy, only.sourceTask ?? null, only.ids ? [...only.ids] : null],
  );
  const accepted = rows.map(toEntry);
  const replaced = accepted.map((entry) => entry.supersedes).filter((id): id is string => Boolean(id));
  const superseded =
    replaced.length > 0
      ? (
          await query<Row>(
            `update design_memory set state = 'superseded', updated_at = now()
              where repo_id = $1 and id = any($2::uuid[]) and state = 'accepted'
              returning ${COLUMNS}`,
            [repoId, replaced],
          )
        ).map(toEntry)
      : [];
  return { accepted, superseded };
}

/**
 * Undoes a supersede: the entry `id` replaced is in effect again, and `id`
 * is retired. Null when `id` supersedes nothing that is superseded now.
 */
export async function revertSupersede(
  id: string,
  by: string,
): Promise<{ restored: DesignMemoryEntry; retired: DesignMemoryEntry } | null> {
  if (!isUuid(id)) return null;
  const replacer = await queryOne<Row>(`select ${COLUMNS} from design_memory where id = $1`, [id]);
  if (!replacer?.supersedes) return null;
  const restored = await queryOne<Row>(
    `update design_memory set state = 'accepted', decided_by = $2, decided_at = now(), updated_at = now()
      where id = $1 and repo_id = $3 and state = 'superseded'
      returning ${COLUMNS}`,
    [replacer.supersedes, by, replacer.repo_id],
  );
  if (!restored) return null;
  const retired = await queryOne<Row>(
    `update design_memory set state = 'retired', updated_at = now() where id = $1 returning ${COLUMNS}`,
    [id],
  );
  return retired ? { restored: toEntry(restored), retired: toEntry(retired) } : null;
}

/** A repository's entries, newest first, in the given states (all of them when none are given). */
export async function listForRepo(repoId: string, states?: readonly DesignMemoryState[]): Promise<DesignMemoryEntry[]> {
  const rows = states
    ? await query<Row>(`select ${COLUMNS} from design_memory where repo_id = $1 and state = any($2::text[]) order by created_at desc`, [repoId, [...states]])
    : await query<Row>(`select ${COLUMNS} from design_memory where repo_id = $1 order by created_at desc`, [repoId]);
  return rows.map(toEntry);
}

/** What was proposed or decided on any of a work item's subjects. */
export async function listForSubjects(subjects: readonly string[]): Promise<DesignMemoryEntry[]> {
  if (subjects.length === 0) return [];
  const rows = await query<Row>(`select ${COLUMNS} from design_memory where source_subject = any($1::text[]) order by created_at`, [[...subjects]]);
  return rows.map(toEntry);
}

export async function getEntry(id: string): Promise<DesignMemoryEntry | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<Row>(`select ${COLUMNS} from design_memory where id = $1`, [id]);
  return row ? toEntry(row) : null;
}

/**
 * A person's correction from Settings: the words, the kind, or the state —
 * retired, or superseded (by another entry, or by nothing in particular).
 * Accepting one by hand records who did.
 */
export async function updateEntry(
  id: string,
  patch: { title?: string; body?: string; kind?: DesignMemoryKind; state?: DesignMemoryState; supersedes?: string | null },
  by: string,
): Promise<DesignMemoryEntry | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<Row>(
    `update design_memory set
       title = coalesce($2, title),
       body = coalesce($3, body),
       kind = coalesce($4, kind),
       state = coalesce($5, state),
       supersedes = case when $6::boolean then $7::uuid else supersedes end,
       decided_by = case when $5 = 'accepted' and state <> 'accepted' then $8 else decided_by end,
       decided_at = case when $5 = 'accepted' and state <> 'accepted' then now() else decided_at end,
       updated_at = now()
     where id = $1
     returning ${COLUMNS}`,
    [
      id,
      patch.title ?? null,
      patch.body ?? null,
      patch.kind ?? null,
      patch.state ?? null,
      patch.supersedes !== undefined,
      patch.supersedes ?? null,
      by,
    ],
  );
  return row ? toEntry(row) : null;
}

/** Accepted decisions with no ADR found for them yet. */
export async function decisionsWithoutAdr(): Promise<DesignMemoryEntry[]> {
  const rows = await query<Row>(
    `select ${COLUMNS} from design_memory where kind = 'decision' and state = 'accepted' and adr_path is null order by created_at`,
  );
  return rows.map(toEntry);
}

export async function setAdrPath(id: string, path: string): Promise<void> {
  await query('update design_memory set adr_path = $2, updated_at = now() where id = $1 and adr_path is null', [id, path]);
}
