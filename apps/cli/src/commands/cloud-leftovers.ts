/**
 * What an earlier install left in a Google Cloud project, found before
 * Terraform changes anything.
 *
 * One install has one project. Setting up again in a project an install was
 * torn down from is not supported: Google keeps some names after deletion — a
 * workload identity pool is soft-deleted for 30 days and keeps its ID, a
 * deleted Cloud SQL instance's name stays reserved for up to a week — and the
 * module always uses the same names. Terraform found out halfway through an
 * apply, with part of the install made and Google's "already exists" as the
 * only explanation (seen 2026-10-01, after `terraform destroy`). So `plan` and
 * `apply` look first, and stop with what to do: use a new project.
 *
 * A resource in this install's own Terraform state is its own, so re-running
 * on a live install is never refused. Whatever `gcloud` cannot answer — not
 * signed in, an API not enabled yet — is said as not checked, never as found.
 */

export interface GcloudResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Gcloud = (args: string[]) => Promise<GcloudResult>;

export interface Leftover {
  /** What it is, as a person names it: "workload identity pool fleetadlc-github". */
  what: string;
  /** Its state, and how long Google keeps it, when that is known. */
  detail: string;
}

export interface LeftoverReport {
  found: Leftover[];
  /** What could not be checked, and why. */
  unchecked: string[];
}

/** The Terraform addresses that make each resource this install's own. */
const OWNED_BY = {
  pool: 'google_iam_workload_identity_pool.github',
  database: 'google_sql_database_instance.fleet',
  network: 'google_compute_network.fleet',
} as const;

/**
 * The resources `terraform state list` says this install holds, by address
 * without a count index: the pool is `google_iam_workload_identity_pool.github[0]`
 * in the state, made only when a deploying repository is named.
 */
export function ownedAddresses(stateList: string): Set<string> {
  return new Set(
    stateList
      .split('\n')
      .map((line) => line.trim().replace(/\[[^\]]*\]$/, ''))
      .filter(Boolean),
  );
}

/** How long Google reserves a deleted Cloud SQL instance's name. */
const SQL_NAME_RESERVED_DAYS = 7;

/**
 * Secrets a running install writes. The bridge names every one `fleet-<ref>`
 * whatever the prefix (`GcpSecretStore`), and the module writes two under the
 * prefix; a new install finding an old one would read the old install's
 * GitHub tokens as its own.
 */
function installSecret(name: string, prefix: string): boolean {
  return name.startsWith('fleet-') || name.startsWith(`${prefix}-`);
}

function notFound(result: GcloudResult): boolean {
  return /NOT_FOUND|not found|does not exist|was not found/i.test(result.stderr);
}

/** Why `gcloud` could not answer, in a few words, for the "not checked" line. */
function whyNot(result: GcloudResult): string {
  if (result.code === 127) return 'gcloud is not installed';
  if (/SERVICE_DISABLED|has not been used|is disabled|API .*not enabled/i.test(result.stderr)) return 'its API is not enabled in the project yet';
  if (/auth|credential|login/i.test(result.stderr)) return 'gcloud is not signed in';
  const line = result.stderr.trim().split('\n').find((one) => one.trim()) ?? `gcloud exited ${result.code}`;
  return line.replace(/^ERROR:\s*/, '').slice(0, 120);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function findLeftovers(
  input: { projectId: string; prefix: string; owned: ReadonlySet<string>; now?: Date },
  gcloud: Gcloud,
): Promise<LeftoverReport> {
  const { projectId, prefix, owned } = input;
  const now = input.now ?? new Date();
  const found: Leftover[] = [];
  const unchecked: string[] = [];
  const project = `--project=${projectId}`;

  // The workload identity pool: soft-deleted for 30 days, and its ID with it.
  if (!owned.has(OWNED_BY.pool)) {
    const pool = `${prefix}-github`;
    const result = await gcloud(['iam', 'workload-identity-pools', 'describe', pool, '--location=global', project, '--format=json']);
    if (result.code === 0) {
      const described = parse<{ state?: string; expireTime?: string }>(result.stdout);
      found.push({
        what: `workload identity pool ${pool}`,
        detail:
          described?.state === 'DELETED'
            ? `deleted; Google keeps it${described.expireTime ? ` until ${day(described.expireTime)}` : ' for 30 days'}`
            : 'still there',
      });
    } else if (!notFound(result)) {
      unchecked.push(`workload identity pool ${pool}: ${whyNot(result)}`);
    }
  }

  // The database: there, or deleted recently enough that Google still holds its name.
  if (!owned.has(OWNED_BY.database)) {
    const instance = `${prefix}-db`;
    const result = await gcloud(['sql', 'instances', 'describe', instance, project, '--format=json']);
    if (result.code === 0) {
      found.push({ what: `Cloud SQL instance ${instance}`, detail: 'still there' });
    } else if (!notFound(result)) {
      unchecked.push(`Cloud SQL instance ${instance}: ${whyNot(result)}`);
    } else {
      // A deleted instance is not listed anywhere; the deletion is in the
      // project's admin activity log, which is always on.
      const log = await gcloud([
        'logging',
        'read',
        'protoPayload.methodName="cloudsql.instances.delete"',
        project,
        `--freshness=${SQL_NAME_RESERVED_DAYS + 1}d`,
        '--limit=50',
        '--format=json',
      ]);
      if (log.code !== 0) {
        unchecked.push(`whether ${instance} was deleted this week: ${whyNot(log)}`);
      } else {
        const entries = parse<{ timestamp?: string; protoPayload?: { resourceName?: string }; resource?: { labels?: { database_id?: string } } }[]>(log.stdout) ?? [];
        const deleted = entries.find(
          (entry) =>
            entry.protoPayload?.resourceName?.endsWith(`instances/${instance}`) || entry.resource?.labels?.database_id === `${projectId}:${instance}`,
        );
        if (deleted?.timestamp) {
          const until = new Date(new Date(deleted.timestamp).getTime() + SQL_NAME_RESERVED_DAYS * 24 * 60 * 60 * 1000);
          if (until > now) {
            found.push({
              what: `Cloud SQL instance ${instance}`,
              detail: `deleted ${day(deleted.timestamp)}; Google keeps the name reserved until about ${day(until.toISOString())}`,
            });
          }
        }
      }
    }
  }

  // The network, which Terraform would otherwise fail to create.
  if (!owned.has(OWNED_BY.network)) {
    const network = `${prefix}-network`;
    const result = await gcloud(['compute', 'networks', 'describe', network, project, '--format=json']);
    if (result.code === 0) found.push({ what: `network ${network}`, detail: 'still there' });
    else if (!notFound(result)) unchecked.push(`network ${network}: ${whyNot(result)}`);
  }

  // The secrets an install keeps, read only for a new one: a live install's
  // runtime secrets are in no Terraform state and are its own.
  if (owned.size === 0) {
    const result = await gcloud(['secrets', 'list', project, '--format=value(name)']);
    if (result.code === 0) {
      const names = result.stdout
        .split('\n')
        .map((line) => line.trim().split('/').pop() ?? '')
        .filter((name) => name && installSecret(name, prefix));
      if (names.length > 0) {
        found.push({
          what: names.length === 1 ? `secret ${names[0]}` : `${names.length} secrets (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`,
          detail: 'kept from the earlier install, with its GitHub credentials',
        });
      }
    } else {
      unchecked.push(`secrets: ${whyNot(result)}`);
    }
  }

  return { found, unchecked };
}

/** What a person reads when the project is not a fresh one. */
export function leftoversMessage(projectId: string, found: readonly Leftover[]): string[] {
  return [
    `Project ${projectId} still holds an earlier OpenADLC install:`,
    ...found.map((one) => `  - ${one.what}: ${one.detail}`),
    'Setting up again in the same project is not supported.',
    'Create a new Google Cloud project and run `fleetadlc cloud configure` with it.',
  ];
}

/**
 * A Terraform failure that is the same thing, said in words: the check above
 * could not see it (an API it could not ask), or something else of the same
 * name was made in the meantime. Or a Google API the module turns on was not
 * on yet: Google can take minutes after it says it is enabled.
 */
export function explainTerraformFailure(output: string): string | null {
  // These two the module cannot turn on for itself: Terraform reads the project
  // through one and turns APIs on through the other, so a plan stops on them
  // before anything is applied, every time. Applying again does not help.
  const bootstrap = /(cloudresourcemanager|serviceusage)\.googleapis\.com/i.exec(output);
  if (bootstrap && /SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(output)) {
    const project = /in project ([a-z][a-z0-9-]{4,28}[a-z0-9])\b/i.exec(output)?.[1] ?? '<project>';
    return `Terraform stopped because ${bootstrap[0]} is off in the project, and Terraform needs it before it can turn on the module's APIs. Run: gcloud services enable cloudresourcemanager.googleapis.com serviceusage.googleapis.com --project ${project}, then run this again (infra/gcp/install.sh does both).`;
  }
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(output)) {
    return 'Terraform stopped because a Google API it needs was still being turned on: the module turns it on in the same apply, and Google can take a few minutes to finish. Run `fleetadlc cloud apply` again.';
  }
  if (/alreadyExists|already exists|Error 409|name is reserved|instance name .* (?:recently|reserved)|was recently used/i.test(output)) {
    return 'Terraform stopped because something with the name it needs is already in the project, or Google still holds that name after an earlier install was deleted. Setting up again in the same project is not supported: create a new Google Cloud project and run `fleetadlc cloud configure` with it.';
  }
  return null;
}
