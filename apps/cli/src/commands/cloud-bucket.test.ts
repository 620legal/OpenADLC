import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkBucket, pullSettings } from './cloud-bucket.js';
import type { Gcloud, GcloudResult } from './cloud-leftovers.js';

/**
 * The default state bucket's name can be guessed from the project id, and
 * `configure` used any bucket by that name it found: whoever made it first
 * and opened it was sent the webhook secret and the Terraform state.
 */

const ok = (stdout = ''): GcloudResult => ({ code: 0, stdout, stderr: '' });
const PRIVATE = { name: 'acme-fleetadlc-tfstate', public_access_prevention: 'enforced', uniform_bucket_level_access: true, versioning_enabled: true };

/** gcloud as a bucket and a project answer about it; `cp` writes `settings` where it is told. */
function gcloudFor(answers: { describe?: GcloudResult; list?: GcloudResult; settings?: string }): { gcloud: Gcloud; asked: string[][] } {
  const asked: string[][] = [];
  const gcloud: Gcloud = async (args) => {
    asked.push(args);
    if (args[2] === 'describe') return answers.describe ?? ok(JSON.stringify(PRIVATE));
    if (args[2] === 'list') return answers.list ?? ok('acme-fleetadlc-tfstate\n');
    if (args[1] === 'cp') {
      if (answers.settings === undefined) return { code: 1, stdout: '', stderr: 'ERROR: not found' };
      writeFileSync(args[3] as string, answers.settings);
      return ok();
    }
    throw new Error(`unexpected gcloud ${args.join(' ')}`);
  };
  return { gcloud, asked };
}

describe('a state bucket that already exists', () => {
  it('is used when it is in the project, private and versioned', async () => {
    const { gcloud, asked } = gcloudFor({});
    expect(await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud)).toEqual({ state: 'usable', versioned: true });
    expect(asked[1]).toEqual(['storage', 'buckets', 'list', '--project=acme', '--filter=name:acme-fleetadlc-tfstate', '--format=value(name)']);
  });

  it('is refused when it belongs to another project', async () => {
    // A name that only contains this one is not it.
    const { gcloud } = gcloudFor({ list: ok('acme-fleetadlc-tfstate-old\n') });
    const check = await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud);
    expect(check).toMatchObject({ state: 'refused' });
    expect(check.state === 'refused' && check.lines[0]).toBe('gs://acme-fleetadlc-tfstate belongs to another project, not acme');
    expect(check.state === 'refused' && check.lines[1]).toContain('name a different bucket');
  });

  it('is refused when the project’s buckets cannot be listed, rather than taken on trust', async () => {
    const { gcloud } = gcloudFor({ list: { code: 1, stdout: '', stderr: 'ERROR: permission denied' } });
    expect(await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud)).toMatchObject({ state: 'refused' });
  });

  it('is refused with the command that fixes it when public access prevention is not enforced', async () => {
    const { gcloud } = gcloudFor({ describe: ok(JSON.stringify({ ...PRIVATE, public_access_prevention: 'inherited' })) });
    const check = await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud);
    expect(check).toMatchObject({ state: 'refused' });
    expect(check.state === 'refused' && check.lines.join('\n')).toContain(
      'gcloud storage buckets update gs://acme-fleetadlc-tfstate --public-access-prevention',
    );
  });

  it('is refused with the command that fixes it when uniform bucket-level access is off', async () => {
    const { uniform_bucket_level_access: _, ...withoutUniform } = PRIVATE;
    const { gcloud } = gcloudFor({ describe: ok(JSON.stringify(withoutUniform)) });
    const check = await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud);
    expect(check.state === 'refused' && check.lines.join('\n')).toContain(
      'gcloud storage buckets update gs://acme-fleetadlc-tfstate --uniform-bucket-level-access',
    );
  });

  it('is usable but said to be unversioned when versioning is off, for the caller to turn on', async () => {
    const { gcloud } = gcloudFor({ describe: ok(JSON.stringify({ ...PRIVATE, versioning_enabled: false })) });
    expect(await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud)).toEqual({ state: 'usable', versioned: false });
  });

  it('is missing when describe finds nothing, and the project is not asked', async () => {
    const { gcloud, asked } = gcloudFor({ describe: { code: 1, stdout: '', stderr: 'ERROR: 404' } });
    expect(await checkBucket('acme-fleetadlc-tfstate', 'acme', gcloud)).toEqual({ state: 'missing' });
    expect(asked).toHaveLength(1);
  });
});

describe('cloud pull', () => {
  const remote = 'gs://acme-fleetadlc-tfstate/fleetadlc/cloud.tfvars.json';
  const settings = JSON.stringify({ project_id: 'acme', webhook_secret: 'x' });

  it('hands back the settings once the bucket is checked against the project they name', async () => {
    const { gcloud, asked } = gcloudFor({ settings });
    expect(await pullSettings({ bucket: 'acme-fleetadlc-tfstate', remote }, gcloud)).toEqual({ ok: true, text: settings, versioned: true });
    expect(asked.find((args) => args[2] === 'list')).toContain('--project=acme');
  });

  it('refuses a bucket outside the project the settings name', async () => {
    const { gcloud } = gcloudFor({ settings, list: ok('') });
    const pulled = await pullSettings({ bucket: 'acme-fleetadlc-tfstate', remote }, gcloud);
    expect(pulled).toMatchObject({ ok: false });
    expect(!pulled.ok && pulled.lines[0]).toContain('belongs to another project');
  });

  it('refuses settings that name no project', async () => {
    const { gcloud } = gcloudFor({ settings: '{}' });
    expect(await pullSettings({ bucket: 'acme-fleetadlc-tfstate', remote }, gcloud)).toMatchObject({ ok: false });
  });

  it('says what went wrong when the download fails', async () => {
    const { gcloud } = gcloudFor({});
    expect(await pullSettings({ bucket: 'acme-fleetadlc-tfstate', remote }, gcloud)).toMatchObject({ ok: false });
  });
});
