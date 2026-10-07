import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Gcloud } from './cloud-leftovers.js';

/**
 * Whether a bucket that already exists may hold an install's Terraform state
 * and settings.
 *
 * Bucket names are global and the default one, `<project>-fleetadlc-tfstate`,
 * can be guessed from the project id. `configure` used a bucket as soon as
 * `gcloud storage buckets describe` found it, so whoever made that name first,
 * and opened it to everyone, was sent the webhook secret, and at every apply
 * the state with the database password; with write access they could edit
 * the settings a later `pull` or `apply` reads. A bucket is used only when it
 * is in the install's own project, has public access prevention enforced and
 * uniform bucket-level access on. Those two are refused rather than changed: a
 * bucket the install may not own is not this command's to alter. Versioning
 * is turned on by the caller, once the bucket is known to be the project's.
 */

export type BucketCheck =
  /** `describe` found nothing, or nothing this account may see: the caller creates it. */
  | { state: 'missing' }
  /** Not to be used: the first line is the failure, the rest what to do. */
  | { state: 'refused'; lines: string[] }
  | { state: 'usable'; versioned: boolean };

/** What `gcloud storage buckets describe --format=json` says, in the fields read here. */
interface Described {
  public_access_prevention?: string;
  uniform_bucket_level_access?: boolean;
  versioning_enabled?: boolean;
}

export async function checkBucket(bucket: string, projectId: string, gcloud: Gcloud): Promise<BucketCheck> {
  const url = `gs://${bucket}`;
  const described = await gcloud(['storage', 'buckets', 'describe', url, '--format=json']);
  if (described.code !== 0) return { state: 'missing' };

  // A project number is not among what `describe` prints, so ask the project
  // for its own buckets: a bucket in another project is not in the list.
  const listed = await gcloud(['storage', 'buckets', 'list', `--project=${projectId}`, `--filter=name:${bucket}`, '--format=value(name)']);
  if (listed.code !== 0) {
    return {
      state: 'refused',
      lines: [
        `could not confirm that ${url} is in ${projectId}: ${listed.stderr.trim() || 'gcloud storage buckets list failed'}`,
        `sign in with an account that may list ${projectId}'s buckets, and run the command again`,
      ],
    };
  }
  const names = listed.stdout.split('\n').map((line) => line.trim().replace(/^gs:\/\//, '').replace(/\/$/, ''));
  if (!names.includes(bucket)) {
    return {
      state: 'refused',
      lines: [
        `${url} belongs to another project, not ${projectId}`,
        'Its owner could read the webhook secret and the Terraform state. Run fleetadlc cloud configure again and name a different bucket.',
      ],
    };
  }

  let found: Described;
  try {
    found = JSON.parse(described.stdout) as Described;
  } catch {
    return { state: 'refused', lines: [`could not read what gcloud says about ${url}`, 'run the command again; if it repeats, update the gcloud CLI'] };
  }
  const fixes: string[] = [];
  if (String(found.public_access_prevention ?? '').toLowerCase() !== 'enforced') fixes.push('--public-access-prevention');
  if (found.uniform_bucket_level_access !== true) fixes.push('--uniform-bucket-level-access');
  if (fixes.length > 0) {
    const missing = [
      ...(fixes.includes('--public-access-prevention') ? ['public access prevention is not enforced'] : []),
      ...(fixes.includes('--uniform-bucket-level-access') ? ['uniform bucket-level access is off'] : []),
    ];
    return {
      state: 'refused',
      lines: [
        `${url} is not private: ${missing.join(', and ')}`,
        `It would hold the webhook secret and the Terraform state. Make it private, then run the command again: gcloud storage buckets update ${url} ${fixes.join(' ')}`,
      ],
    };
  }
  return { state: 'usable', versioned: found.versioning_enabled === true };
}

/**
 * An install's settings from its bucket, read only once the bucket passes
 * `checkBucket` against the project the settings name. `pull` used to copy
 * them straight over this machine's own, from whatever bucket it was given.
 * The download goes to a directory of its own, removed afterwards whatever
 * happens: the file holds the webhook secret.
 */
export async function pullSettings(
  input: { bucket: string; remote: string },
  gcloud: Gcloud,
): Promise<{ ok: true; text: string; versioned: boolean } | { ok: false; lines: string[] }> {
  const scratch = mkdtempSync(join(tmpdir(), 'fleetadlc-pull-'));
  try {
    const local = join(scratch, 'cloud.tfvars.json');
    const copied = await gcloud(['storage', 'cp', input.remote, local]);
    if (copied.code !== 0) {
      return { ok: false, lines: [`could not download ${input.remote}: ${copied.stderr.trim() || `gcloud exited ${copied.code}`}`] };
    }
    const text = readFileSync(local, 'utf8');
    let projectId = '';
    try {
      const vars = JSON.parse(text) as { project_id?: unknown };
      projectId = typeof vars.project_id === 'string' ? vars.project_id : '';
    } catch {
      // Said below, as a file without a project.
    }
    if (!projectId) return { ok: false, lines: [`${input.remote} names no project_id, so it is not an install's settings`] };

    const check = await checkBucket(input.bucket, projectId, gcloud);
    if (check.state === 'refused') return { ok: false, lines: check.lines };
    if (check.state === 'missing') return { ok: false, lines: [`could not describe gs://${input.bucket}, so it was not checked; nothing was written`] };
    return { ok: true, text, versioned: check.versioned };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
