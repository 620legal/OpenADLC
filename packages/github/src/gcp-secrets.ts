import type { SecretStore } from './secrets.js';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1';
const API = 'https://secretmanager.googleapis.com/v1';

/**
 * Every secret's id starts with this, and carries the label `openadlc: secret`,
 * which `list` finds them by. The deployer's access is granted to
 * `openadlc-github-app-private-key` by name (`infra/gcp/deployer.tf`).
 */
const SECRET_ID_PREFIX = 'openadlc-';
const SECRET_LABEL = 'openadlc';

/**
 * What an install made before the rename to OpenADLC named them, `fleet-<ref>`
 * labelled `fleet: secret`, which they stay until a person renames them
 * (docs/runbooks/rename-gcp-host.md). Read under the new names alone, such an
 * install would have found none of them on its first start on this release:
 * every bot signed out, no app key, and a new internal secret that hostd, on
 * the release before, does not hold. So a ref is read under its new name and
 * then its old one, written where it already is, and made only under the new.
 * Remove once every install has been renamed.
 */
const OLD_ID_PREFIX = 'fleet-';
const OLD_LABEL = 'fleet';

/**
 * Secret Manager allows `[A-Za-z0-9_-]` in a secret id, and a ref may carry `:`.
 * `__` stands for `:` the same way `FileSecretStore` writes it to a file name,
 * so a ref reads the same in both stores. A `.` has no spare encoding that
 * `list` could reverse, so it is refused rather than quietly written under a
 * name that comes back as a different ref.
 */
function secretId(ref: string, prefix = SECRET_ID_PREFIX): string {
  if (!/^[a-zA-Z0-9_:-]+$/.test(ref)) throw new Error(`invalid secret ref for Secret Manager: ${ref}`);
  return `${prefix}${ref.replace(/:/g, '__')}`;
}

/** The number at the end of a version's name (`…/versions/7`), or null when it has none. */
function versionNumber(name: string): number | null {
  const match = /\/versions\/(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

function refOf(id: string, prefix: string): string | null {
  if (!id.startsWith(prefix)) return null;
  return id.slice(prefix.length).replace(/__/g, ':');
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
 * `openadlc-` prefix, authenticated as whatever service account the metadata server
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
    // The new name first: once a ref is there, it is the one written to.
    for (const id of [secretId(ref), secretId(ref, OLD_ID_PREFIX)]) {
      const response = await this.call('GET', `projects/${project}/secrets/${id}/versions/latest:access`);
      if (response.status === 404) continue;
      // A secret whose versions were all destroyed has no latest to read, which is
      // what a deleted credential looks like from here.
      if (response.status === 400 || response.status === 412) return null;
      if (!response.ok) return this.fail(response, `read ${ref}`);
      const { payload } = (await response.json()) as { payload: { data: string } };
      return Buffer.from(payload.data, 'base64').toString('utf8').trim();
    }
    return null;
  }

  async set(ref: string, value: string): Promise<void> {
    const project = await this.projectId();
    let id = secretId(ref);
    const data = { payload: { data: Buffer.from(value, 'utf8').toString('base64') } };

    let added = await this.call('POST', `projects/${project}/secrets/${id}:addVersion`, data);
    if (added.status === 404) {
      // Under its old name while it has one, so each secret is in one place.
      // Made again under the new, the old would keep a refresh token GitHub
      // has since rotated, which is what the release before reads (its bridge
      // serves until this one's is ready, and going back runs it), and what
      // the rename's copy would take for the value.
      const old = secretId(ref, OLD_ID_PREFIX);
      const kept = await this.call('POST', `projects/${project}/secrets/${old}:addVersion`, data);
      if (kept.status !== 404) {
        id = old;
        added = kept;
      } else {
        const created = await this.call('POST', `projects/${project}/secrets?secretId=${id}`, {
          replication: { automatic: {} },
          labels: { [SECRET_LABEL]: 'secret' },
        });
        if (!created.ok && created.status !== 409) return this.fail(created, `create ${ref}`);
        added = await this.call('POST', `projects/${project}/secrets/${id}:addVersion`, data);
      }
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
    // Both, the old name first: left behind, it would be read in its place.
    for (const id of [secretId(ref, OLD_ID_PREFIX), secretId(ref)]) {
      const response = await this.call('DELETE', `projects/${project}/secrets/${id}`);
      if (!response.ok && response.status !== 404) return this.fail(response, `delete ${ref}`);
    }
  }

  async list(prefix = ''): Promise<string[]> {
    const refs = new Set<string>();
    for (const [label, idPrefix] of [
      [SECRET_LABEL, SECRET_ID_PREFIX],
      [OLD_LABEL, OLD_ID_PREFIX],
    ] as const) {
      for (const id of await this.ids(label)) {
        const ref = refOf(id, idPrefix);
        if (ref !== null && ref.startsWith(prefix)) refs.add(ref);
      }
    }
    return [...refs].sort();
  }

  /**
   * The secrets still under the names from before the rename, by id: what
   * docs/runbooks/rename-gcp-host.md has left to copy, or to delete once the
   * install runs on the new ones. Empty on an install made since.
   */
  async beforeRename(): Promise<string[]> {
    return (await this.ids(OLD_LABEL)).filter((id) => id.startsWith(OLD_ID_PREFIX)).sort();
  }

  /** The ids of the secrets that carry `label: secret`. */
  private async ids(label: string): Promise<string[]> {
    const project = await this.projectId();
    const ids: string[] = [];
    let pageToken = '';
    do {
      const query = new URLSearchParams({ filter: `labels.${label}=secret`, pageSize: '250' });
      if (pageToken) query.set('pageToken', pageToken);
      const response = await this.call('GET', `projects/${project}/secrets?${query}`);
      if (!response.ok) return this.fail(response, 'list secrets');
      const body = (await response.json()) as { secrets?: { name: string }[]; nextPageToken?: string };
      for (const secret of body.secrets ?? []) ids.push(secret.name.split('/').pop() ?? '');
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
    return ids;
  }
}
