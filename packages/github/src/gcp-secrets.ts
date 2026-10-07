import type { SecretStore } from './secrets.js';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const API = 'https://secretmanager.googleapis.com/v1';

/**
 * Every secret's id starts with this, and carries the label `fleet: secret`.
 * Both predate the rename to FleetADLC and stay as they are: an install's
 * refresh tokens and keys already live under them, and the deployer's access
 * is granted to `fleet-github-app-private-key` by name (`infra/gcp/deployer.tf`).
 */
const SECRET_ID_PREFIX = 'fleet-';
const SECRET_LABEL = 'fleet';

/**
 * Secret Manager allows `[A-Za-z0-9_-]` in a secret id, and a ref may carry `:`.
 * `__` stands for `:` the same way `FileSecretStore` writes it to a file name,
 * so a ref reads the same in both stores. A `.` has no spare encoding that
 * `list` could reverse, so it is refused rather than quietly written under a
 * name that comes back as a different ref.
 */
function secretId(ref: string): string {
  if (!/^[a-zA-Z0-9_:-]+$/.test(ref)) throw new Error(`invalid secret ref for Secret Manager: ${ref}`);
  return `${SECRET_ID_PREFIX}${ref.replace(/:/g, '__')}`;
}

/** The number at the end of a version's name (`…/versions/7`), or null when it has none. */
function versionNumber(name: string): number | null {
  const match = /\/versions\/(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function refOf(id: string): string | null {
  if (!id.startsWith(SECRET_ID_PREFIX)) return null;
  return id.slice(SECRET_ID_PREFIX.length).replace(/__/g, ':');
}

interface Token {
  value: string;
  expiresAt: number;
}

export interface GcpSecretStoreOptions {
  project?: string;
  fetch?: typeof fetch;
}

/**
 * The cloud install's secret store: one Secret Manager secret per ref, under the
 * `fleet-` prefix, authenticated as whatever service account the metadata server
 * speaks for (the host VM's, or the bridge's on Cloud Run).
 *
 * The file store was the only implementation, and on Cloud Run its directory is
 * empty and gone at the next revision — so the bridge could mint no GitHub token
 * and would have regenerated the internal secret hostd holds on every restart.
 *
 * A write adds a version and destroys the ones before it. GitHub rotates a
 * refresh token on every use and the old one stops working, so a kept version is
 * a dead credential at best and a live one at worst.
 *
 * Only the ones before it, by number: each write used to destroy every version
 * but its own, so two writes to one ref that overlapped destroyed each other's
 * and left nothing enabled — a credential gone, with `get` answering null.
 */
export class GcpSecretStore implements SecretStore {
  private token: Token | undefined;
  private project: string | undefined;
  private readonly fetch: typeof fetch;

  constructor(options: GcpSecretStoreOptions = {}) {
    this.project = options.project;
    this.fetch = options.fetch ?? fetch;
  }

  private async metadata(path: string): Promise<Response> {
    const response = await this.fetch(`${METADATA}/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`the metadata server answered ${response.status} for ${path}; is this running on Google Cloud?`);
    return response;
  }

  private async projectId(): Promise<string> {
    if (!this.project) this.project = (await (await this.metadata('project/project-id')).text()).trim();
    return this.project;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const body = (await (await this.metadata('instance/service-accounts/default/token')).json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await this.fetch(`${API}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  }

  private async fail(response: Response, what: string): Promise<never> {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`Secret Manager refused to ${what} (${response.status}): ${detail}`);
  }

  async get(ref: string): Promise<string | null> {
    const project = await this.projectId();
    const response = await this.call('GET', `projects/${project}/secrets/${secretId(ref)}/versions/latest:access`);
    if (response.status === 404) return null;
    // A secret whose versions were all destroyed has no latest to read, which is
    // what a deleted credential looks like from here.
    if (response.status === 400 || response.status === 412) return null;
    if (!response.ok) return this.fail(response, `read ${ref}`);
    const { payload } = (await response.json()) as { payload: { data: string } };
    return Buffer.from(payload.data, 'base64').toString('utf8').trim();
  }

  async set(ref: string, value: string): Promise<void> {
    const project = await this.projectId();
    const id = secretId(ref);
    const data = { payload: { data: Buffer.from(value, 'utf8').toString('base64') } };

    let added = await this.call('POST', `projects/${project}/secrets/${id}:addVersion`, data);
    if (added.status === 404) {
      const created = await this.call('POST', `projects/${project}/secrets?secretId=${id}`, {
        replication: { automatic: {} },
        labels: { [SECRET_LABEL]: 'secret' },
      });
      if (!created.ok && created.status !== 409) return this.fail(created, `create ${ref}`);
      added = await this.call('POST', `projects/${project}/secrets/${id}:addVersion`, data);
    }
    if (!added.ok) return this.fail(added, `write ${ref}`);
    const { name: current } = (await added.json()) as { name: string };
    const ours = versionNumber(current);
    if (ours === null) return;

    const listed = await this.call('GET', `projects/${project}/secrets/${id}/versions?filter=state:ENABLED`);
    if (!listed.ok) return;
    const { versions = [] } = (await listed.json()) as { versions?: { name: string }[] };
    for (const version of versions) {
      const number = versionNumber(version.name);
      if (number === null || number >= ours) continue;
      const destroyed = await this.call('POST', `${version.name}:destroy`, {});
      // The new value is written, so the write is not failed for this; but an
      // earlier credential left enabled is worth saying.
      if (!destroyed.ok && destroyed.status !== 404) {
        console.warn(`[secrets] wrote ${ref}, but Secret Manager would not destroy ${version.name} (${destroyed.status}); it is still enabled`);
      }
    }
  }

  async delete(ref: string): Promise<void> {
    const project = await this.projectId();
    const response = await this.call('DELETE', `projects/${project}/secrets/${secretId(ref)}`);
    if (!response.ok && response.status !== 404) return this.fail(response, `delete ${ref}`);
  }

  async list(prefix = ''): Promise<string[]> {
    const project = await this.projectId();
    const refs: string[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ filter: `labels.${SECRET_LABEL}=secret`, pageSize: '250' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await this.call('GET', `projects/${project}/secrets?${query}`);
      if (!response.ok) return this.fail(response, 'list secrets');
      const body = (await response.json()) as { secrets?: { name: string }[]; nextPageToken?: string };
      for (const secret of body.secrets ?? []) {
        const ref = refOf(secret.name.split('/').pop() ?? '');
        if (ref !== null && ref.startsWith(prefix)) refs.push(ref);
      }
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return refs.sort();
  }
}
