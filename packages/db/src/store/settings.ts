import { query } from '../client.js';

/**
 * The install settings the console can write.
 *
 * Deliberately a short, closed list rather than arbitrary keys. These are the
 * things a person needs to set to get from a running stack to a working install
 * — everything else is either derived, or belongs in `config/` where it is
 * reviewable.
 *
 * Engine updates used to keep one schedule here — on or off, the day, the
 * time — and, beside it, the week a run was started for, its last result, and
 * a version a rollback undid. Those three schedule keys are what an install
 * from before per-tool schedules still has; the bridge reads them once and
 * writes `systemToolSchedules` instead. `systemTimeZone` is the clock every
 * schedule uses. The routes validate them; nothing else writes them.
 */
export const SETTING_KEYS = [
  'organization',
  'githubClientId',
  'automationBot',
  'humans',
  // Each of `humans` pinned to its GitHub account id, as JSON keyed by
  // lower-cased login. The bridge writes it when `humans` is saved or a login
  // is first used; a delivery counts as one of them only from that account.
  // See the bridge's `human-ids.ts`.
  'humanIds',
  'operatorEmail',
  'publicUrl',
  // A field of PATCH /v1/install, which sends it to the secret store. An older
  // install kept it in this table; the bridge moves that row into the store
  // when it starts, and a restore of an older backup writes it there too.
  'webhookSecret',
  // Settings only as fields of PATCH /v1/install, which sends them to the
  // secret store; they are never written to this table.
  'appPrivateKey',
  'appClientSecret',
  'engineUpdates',
  'engineUpdateDay',
  'engineUpdateTime',
  'engineUpdateSlot',
  'engineUpdateLast',
  'engineUpdateHold',
  // IANA zone every schedule reads. Empty means the bridge process's TZ.
  'systemTimeZone',
  // Per-tool update choice, day, time, slot and pin. Replaces the three engine schedule keys.
  'systemToolSchedules',
  // Whole days an engine CLI release must have been on npm before the engine
  // update takes it, 0 to 90. Absent is the default (3). Install-wide, so not
  // in `systemToolSchedules`, which is per tool.
  'engineUpdateMinReleaseAgeDays',
  // The last check of each tool, so a pin can show a newer version it did not take.
  'systemToolLast',
  // The run the bridge started and is following, as JSON: when it started and
  // which tools it was for, so a bridge that restarts mid-run records the
  // result against those tools and no others.
  'systemToolRun',
  // What the header on every post OpenADLC writes calls this install (`OpenADLC_<org>` when unset).
  'installName',
  // `audit` (the default) or `enforce`: whether a crew post whose signature does not check still counts.
  'attributionMode',
  // Repositories, by name and comma-separated, whose approved pull requests the
  // bridge leaves for a person or auto-merge to land. Every other one it merges.
  'bridgeMergeOff',
  // Repositories, by name and comma-separated, where a person merges a change
  // to how CI runs. Every other one, OpenADLC merges once the security
  // reviewer has approved it as well.
  'ciMergeByPerson',
  // GitHub accounts, by login and comma-separated, an admin allowed beyond the
  // ones the install works in already (the app's owner, the organization and
  // the owners of its repositories). A public app can be installed by anyone,
  // and an installation on any other account is ignored. See the bridge's `app-reach.ts`.
  'allowedAccounts',
  // A person's pause of new work across the install, as JSON: who, when, why. See the bridge's `pause-work.ts`.
  'workPaused',
  // Each repository a person paused on its own, as JSON keyed by name: who, when, why.
  'workPausedRepos',
  // Each seat a person paused, as JSON keyed by bot name: who, when, why. A paused
  // seat finishes what it is doing and takes no new work. See the bridge's `seat-pause.ts`.
  'workPausedSeats',
  // Open unlabeled issues the intake sweep will not take on its own, because
  // OpenADLC does not act for their author, as JSON keyed by repository name:
  // [{number, title, url, author}]. Needs you asks a person what to do. See the
  // bridge's `unowned-issues.ts`.
  'unownedIssues',
  // Each work item a person held, as JSON keyed by its subject (`repo#n`): who,
  // when, why. The `fleetadlc:paused` label is what holds it; this says who did.
  // See the bridge's `item-hold.ts`.
  'heldItems',
  // Whether each repository has a testing deploy, as JSON keyed by name: `has` or `none`.
  // Absent, or `automatic`, means look for a `deploy-testing` workflow. See `deploys.ts`.
  'testingDeploy',
  // The most GitHub Actions minutes the install lets its repositories bill in a
  // month, as a whole number; absent, no cap. At it, the merge line asks for no
  // more CI runs until it is raised or the month turns. See the bridge's `ci-usage.ts`.
  'ciMinutesCap',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

export async function allSettings(): Promise<Partial<Record<SettingKey, string>>> {
  const rows = await query<{ key: string; value: string }>('select key, value from settings');
  const out: Partial<Record<SettingKey, string>> = {};
  for (const row of rows) if (isSettingKey(row.key)) out[row.key] = row.value;
  return out;
}

export async function getSetting(key: SettingKey): Promise<string | null> {
  const rows = await query<{ value: string }>('select value from settings where key = $1', [key]);
  return rows[0]?.value ?? null;
}

/**
 * Writes one setting, or clears it when the value is empty.
 *
 * Clearing rather than storing `''` matters: an empty row would override the
 * environment with nothing, which is how an operator who cleared a field in the
 * browser would silently turn off webhook verification that their deployment's
 * environment had set.
 */
export async function setSetting(key: SettingKey, value: string, updatedBy: string): Promise<void> {
  if (value.length === 0) {
    await query('delete from settings where key = $1', [key]);
    return;
  }
  await query(
    `insert into settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, value, updatedBy],
  );
}

/**
 * Sets fields of a setting that holds a JSON object, in one statement. Read,
 * changed and written back whole, two writers at once each wrote the object
 * they had read, and the second lost the first one's field.
 */
export async function mergeSettingJson(key: SettingKey, fields: Record<string, unknown>, updatedBy: string): Promise<void> {
  await query(
    `insert into settings (key, value, updated_by) values ($1, $2, $3)
     on conflict (key) do update
       set value = (coalesce(nullif(settings.value, ''), '{}')::jsonb || excluded.value::jsonb)::text,
           updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(fields), updatedBy],
  );
}

/** Takes one field out of a setting that holds a JSON object, in one statement. */
export async function removeSettingJsonKey(key: SettingKey, field: string, updatedBy: string): Promise<void> {
  await query(
    `update settings set value = (value::jsonb - $2)::text, updated_by = $3, updated_at = now()
     where key = $1 and value::jsonb ? $2`,
    [key, field, updatedBy],
  );
}
