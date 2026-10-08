import { describe, expect, it } from 'vitest';
import { explainTerraformFailure, findLeftovers, leftoversMessage, ownedAddresses, type Gcloud, type GcloudResult } from './cloud-leftovers.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ok = (stdout = ''): GcloudResult => ({ code: 0, stdout, stderr: '' });
const missing = (what: string): GcloudResult => ({ code: 1, stdout: '', stderr: `ERROR: (gcloud) NOT_FOUND: ${what} was not found.` });

/**
 * A project as `gcloud` answers about it. Each key is the start of the command
 * (`iam`, `sql`, `logging`, `compute`, `secrets`); anything not given is not there.
 */
function project(answers: Partial<Record<'pool' | 'sql' | 'log' | 'network' | 'secrets', GcloudResult>>): { gcloud: Gcloud; asked: string[] } {
  const asked: string[] = [];
  const gcloud: Gcloud = async (args) => {
    asked.push(args.slice(0, 2).join(' '));
    if (args[0] === 'iam') return answers.pool ?? missing('pool');
    if (args[0] === 'sql') return answers.sql ?? missing('instance');
    if (args[0] === 'logging') return answers.log ?? ok('[]');
    if (args[0] === 'compute') return answers.network ?? missing('network');
    if (args[0] === 'secrets') return answers.secrets ?? ok('');
    throw new Error(`unexpected gcloud ${args.join(' ')}`);
  };
  return { gcloud, asked };
}

const fresh = { projectId: 'acme-fleetadlc', prefix: 'fleetadlc', owned: new Set<string>(), now: NOW };

describe('a project an earlier install was torn down from', () => {
  it('finds the soft-deleted workload identity pool, with how long Google keeps it', async () => {
    const { gcloud } = project({ pool: ok(JSON.stringify({ state: 'DELETED', expireTime: '2026-10-31T09:00:00Z' })) });
    const report = await findLeftovers(fresh, gcloud);
    expect(report.found).toEqual([{ what: 'workload identity pool fleetadlc-github', detail: 'deleted; Google keeps it until 2026-10-31' }]);
  });

  it('finds a database name Google still holds, from the deletion in the admin activity log', async () => {
    const deletion = [{ timestamp: '2026-10-01T08:00:00Z', protoPayload: { resourceName: 'projects/acme-fleetadlc/instances/fleetadlc-db' } }];
    const { gcloud } = project({ log: ok(JSON.stringify(deletion)) });
    const report = await findLeftovers(fresh, gcloud);
    expect(report.found).toEqual([
      { what: 'Cloud SQL instance fleetadlc-db', detail: 'deleted 2026-10-01; Google keeps the name reserved until about 2026-10-08' },
    ]);
  });

  it('does not count a database deleted long enough ago that its name is free, or another instance', async () => {
    const deletions = [
      { timestamp: '2026-09-20T08:00:00Z', protoPayload: { resourceName: 'projects/acme-fleetadlc/instances/fleetadlc-db' } },
      { timestamp: '2026-10-02T08:00:00Z', protoPayload: { resourceName: 'projects/acme-fleetadlc/instances/someone-elses-db' } },
    ];
    const { gcloud } = project({ log: ok(JSON.stringify(deletions)) });
    expect((await findLeftovers(fresh, gcloud)).found).toEqual([]);
  });

  it('finds the network and the secrets an install kept, the bridge’s fleet- ones included', async () => {
    const { gcloud } = project({
      network: ok('{}'),
      secrets: ok('projects/1/secrets/fleet-github-app-private-key\nfleet-bot-builder\nfleetadlc-webhook-secret\nunrelated-secret\n'),
    });
    const report = await findLeftovers(fresh, gcloud);
    expect(report.found).toEqual([
      { what: 'network fleetadlc-network', detail: 'still there' },
      {
        what: '3 secrets (fleet-github-app-private-key, fleet-bot-builder, fleetadlc-webhook-secret)',
        detail: 'kept from the earlier install, with its GitHub credentials',
      },
    ]);
  });

  it('says what to do: a new project', () => {
    expect(leftoversMessage('acme-fleetadlc', [{ what: 'network fleetadlc-network', detail: 'still there' }])).toEqual([
      'Project acme-fleetadlc still holds an earlier OpenADLC install:',
      '  - network fleetadlc-network: still there',
      'Setting up again in the same project is not supported.',
      'Create a new Google Cloud project and run `fleetadlc cloud configure` with it.',
    ]);
  });
});

describe('a project that is fine to set up in', () => {
  it('finds nothing in a new one', async () => {
    const report = await findLeftovers(fresh, project({}).gcloud);
    expect(report).toEqual({ found: [], unchecked: [] });
  });

  it('refuses nothing on a live install: what is in its own state is its own, and its runtime secrets too', async () => {
    const owned = new Set([
      'google_iam_workload_identity_pool.github',
      'google_sql_database_instance.fleet',
      'google_compute_network.fleet',
      'google_compute_instance.host',
    ]);
    const { gcloud, asked } = project({ pool: ok('{"state":"ACTIVE"}'), sql: ok('{}'), network: ok('{}'), secrets: ok('fleet-github-app-private-key') });
    const report = await findLeftovers({ ...fresh, owned }, gcloud);
    expect(report.found).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('reads the state’s addresses without their count index, so a pool made with count is its own', () => {
    const owned = ownedAddresses('google_iam_workload_identity_pool.github[0]\ngoogle_compute_network.fleet\n\n');
    expect([...owned]).toEqual(['google_iam_workload_identity_pool.github', 'google_compute_network.fleet']);
  });

  it('checks under the prefix the install has, an install from before the rename included', async () => {
    const { gcloud } = project({ pool: ok('{"state":"DELETED"}') });
    const report = await findLeftovers({ ...fresh, prefix: 'fleet' }, gcloud);
    expect(report.found[0]?.what).toBe('workload identity pool fleet-github');
    expect(report.found[0]?.detail).toBe('deleted; Google keeps it for 30 days');
  });
});

describe('when gcloud cannot answer', () => {
  it('says what was not checked, and finds nothing on a guess', async () => {
    const disabled: GcloudResult = { code: 1, stdout: '', stderr: 'ERROR: (gcloud) PERMISSION_DENIED: Identity and Access Management (IAM) API has not been used in project 1 before or it is disabled. SERVICE_DISABLED' };
    const signedOut: GcloudResult = { code: 1, stdout: '', stderr: 'ERROR: (gcloud) You do not currently have an active account selected. Please run: gcloud auth login' };
    const { gcloud } = project({ pool: disabled, sql: signedOut, network: { code: 127, stdout: '', stderr: '' }, secrets: disabled });
    const report = await findLeftovers(fresh, gcloud);
    expect(report.found).toEqual([]);
    expect(report.unchecked).toEqual([
      'workload identity pool fleetadlc-github: its API is not enabled in the project yet',
      'Cloud SQL instance fleetadlc-db: gcloud is not signed in',
      'network fleetadlc-network: gcloud is not installed',
      'secrets: its API is not enabled in the project yet',
    ]);
  });

  it('says it could not read the log rather than calling the database name free', async () => {
    const { gcloud } = project({ log: { code: 1, stdout: '', stderr: 'ERROR: (gcloud.logging.read) PERMISSION_DENIED: Permission denied' } });
    const report = await findLeftovers(fresh, gcloud);
    expect(report.found).toEqual([]);
    expect(report.unchecked).toEqual(['whether fleetadlc-db was deleted this week: (gcloud.logging.read) PERMISSION_DENIED: Permission denied']);
  });
});

describe('a Terraform failure on a name that is taken', () => {
  it('is said in words, with what to do', () => {
    const output = 'Error: Error creating WorkloadIdentityPool: googleapi: Error 409: Requested entity already exists';
    expect(explainTerraformFailure(output)).toMatch(/create a new Google Cloud project/);
    expect(explainTerraformFailure('Error: Error, failed to create instance fleetadlc-db: googleapi: Error 409: The Cloud SQL instance already exists. When you delete an instance, you can\'t reuse the name of the deleted instance until one week from the deletion date., instanceAlreadyExists')).not.toBeNull();
  });

  it('says an API that was still being turned on is a reason to apply again, not a reason to start over', () => {
    const output =
      'Error: Error creating Secret: googleapi: Error 403: Secret Manager API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/secretmanager.googleapis.com/overview?project=123456 then retry.\nDetails: [{"reason": "SERVICE_DISABLED"}]';
    expect(explainTerraformFailure(output)).toMatch(/fleetadlc cloud apply` again/);
    expect(explainTerraformFailure(output)).not.toMatch(/new Google Cloud project/);
  });

  it('says how to turn on an API the module cannot turn on for itself, rather than to apply again', () => {
    // What a plan on a new project printed, from data "google_project" "this".
    const output =
      'Error: Error when reading or editing Project "openadlc": googleapi: Error 403: Cloud Resource Manager API has not been used in project openadlc before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/cloudresourcemanager.googleapis.com/overview?project=openadlc then retry.\n"reason": "SERVICE_DISABLED"\n, accessNotConfigured';
    const explained = explainTerraformFailure(output);
    expect(explained).toContain('gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com --project openadlc');
    expect(explained).not.toMatch(/apply` again/);
  });

  it('leaves any other failure to Terraform’s own words', () => {
    expect(explainTerraformFailure('Error: Invalid value for variable "region"')).toBeNull();
  });
});
